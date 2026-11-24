//! Disposable sidebar projection: no Store::load, transcript hydration, Git
//! inspection, schema changes or runtime lock. Only business metadata is reduced;
//! the canonical reducer remains the authority for phase and active work.
use crate::model::{apply, Event, Snapshot};
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub run_id: String,
    pub repository: String,
    pub title: String,
    pub plan_type: Option<String>,
    pub phase: String,
    pub has_active_executions: bool,
}

#[derive(Clone, Default)]
pub struct ConversationCatalog {
    pub conversations: Vec<ConversationSummary>,
    /// Preserve browser hints for these IDs, but never invent their status.
    pub unavailable_run_ids: Vec<String>,
}

#[derive(Clone)]
enum CachedRunOutcome {
    Summary(Option<ConversationSummary>),
    Unavailable,
}

#[derive(Clone)]
struct CachedRunEntry {
    max_sequence: i64,
    event_count: i64,
    outcome: CachedRunOutcome,
}

struct Catalog {
    connection: Connection,
    version: Option<i64>,
    table_fingerprint: Option<(i64, i64, i64, i64)>,
    runs: HashMap<String, CachedRunEntry>,
    projection: ConversationCatalog,
}

type CatalogSlot = (Option<u128>, Arc<Mutex<Catalog>>);
static CATALOGS: OnceLock<Mutex<HashMap<PathBuf, CatalogSlot>>> = OnceLock::new();

fn db_file_id(path: &Path) -> Option<u128> {
    let meta = fs::metadata(path).ok()?;
    crate::workspace_metadata::file_identity(path, &meta)
        .ok()
        .map(|(id, _)| id)
}

pub fn conversation_summaries(path: &Path) -> Result<ConversationCatalog, String> {
    let current_id = db_file_id(path);
    let catalog = {
        let mut catalogs = CATALOGS
            .get_or_init(Default::default)
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some((saved_id, catalog)) = catalogs.get(path) {
            if *saved_id == current_id {
                catalog.clone()
            } else {
                // Drop the stale connection first so its WAL/SHM handles close
                // before opening the replacement database at the same path.
                drop(catalogs.remove(path));
                open_catalog_entry(path, current_id, &mut catalogs)?
            }
        } else {
            open_catalog_entry(path, current_id, &mut catalogs)?
        }
    };
    let mut catalog = catalog.lock().map_err(|e| e.to_string())?;
    super::validate_database(&catalog.connection)?;
    let version: i64 = catalog
        .connection
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if catalog.version == Some(version) {
        return Ok(catalog.projection.clone());
    }
    refresh_summaries(&mut catalog, version)?;
    Ok(catalog.projection.clone())
}

fn open_catalog_entry(
    path: &Path,
    file_id: Option<u128>,
    catalogs: &mut HashMap<PathBuf, CatalogSlot>,
) -> Result<Arc<Mutex<Catalog>>, String> {
    // Never call Store::open here: this worker must not initialize or
    // migrate a database, take the store write lock, or touch runtime state.
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    super::validate_database(&connection)?;
    let catalog = Arc::new(Mutex::new(Catalog {
        connection,
        version: None,
        table_fingerprint: None,
        runs: HashMap::new(),
        projection: ConversationCatalog::default(),
    }));
    catalogs.insert(path.to_owned(), (file_id, catalog.clone()));
    Ok(catalog)
}

fn refresh_summaries(catalog: &mut Catalog, version: i64) -> Result<(), String> {
    let transaction = catalog.connection.transaction().map_err(|e| e.to_string())?;
    // `PRAGMA data_version` also advances on every `execution_logs` append while
    // agents stream stdout. Short-circuit when `events` and `deleted_runs` are unchanged.
    let fingerprint: (i64, i64, i64, i64) = transaction
        .query_row(
            "SELECT
                (SELECT COALESCE(MAX(sequence), 0) FROM events),
                (SELECT COUNT(*) FROM events),
                (SELECT COALESCE(MAX(rowid), 0) FROM deleted_runs),
                (SELECT COUNT(*) FROM deleted_runs)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| e.to_string())?;
    if catalog.table_fingerprint == Some(fingerprint) {
        transaction.commit().map_err(|e| e.to_string())?;
        catalog.version = Some(version);
        return Ok(());
    }

    let ordered_runs: Vec<(String, i64, i64)> = {
        let mut stmt = transaction
            .prepare_cached(
                "SELECT run_id, MAX(sequence), COUNT(*)
                 FROM events
                 WHERE run_id NOT IN (SELECT run_id FROM deleted_runs)
                 GROUP BY run_id
                 ORDER BY MAX(sequence) DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    let active_ids: HashSet<&str> = ordered_runs.iter().map(|(id, _, _)| id.as_str()).collect();
    let mut updated_entries: Vec<(String, CachedRunEntry)> = Vec::new();
    for (id, max_sequence, event_count) in &ordered_runs {
        let unchanged = catalog.runs.get(id).is_some_and(|cached| {
            cached.max_sequence == *max_sequence && cached.event_count == *event_count
        });
        if unchanged {
            continue;
        }
        let outcome = read_single_run_summary(&transaction, id)?;
        updated_entries.push((
            id.clone(),
            CachedRunEntry {
                max_sequence: *max_sequence,
                event_count: *event_count,
                outcome,
            },
        ));
    }

    transaction.commit().map_err(|e| e.to_string())?;

    // Commit cache mutations only after the read transaction succeeds so errors
    // never promote a partial or stale cached view.
    catalog.runs.retain(|id, _| active_ids.contains(id.as_str()));
    for (id, entry) in updated_entries {
        catalog.runs.insert(id, entry);
    }

    let mut projection = ConversationCatalog::default();
    for (id, _, _) in ordered_runs {
        if let Some(entry) = catalog.runs.get(&id) {
            match &entry.outcome {
                CachedRunOutcome::Unavailable => projection.unavailable_run_ids.push(id),
                CachedRunOutcome::Summary(Some(summary)) => {
                    projection.conversations.push(summary.clone())
                }
                CachedRunOutcome::Summary(None) => {}
            }
        }
    }
    catalog.projection = projection;
    catalog.table_fingerprint = Some(fingerprint);
    catalog.version = Some(version);
    Ok(())
}

fn read_single_run_summary(
    transaction: &rusqlite::Transaction<'_>,
    id: &str,
) -> Result<CachedRunOutcome, String> {
    // Keep at most one Run's business projection; omit heavy current fields.
    let mut statement = transaction
        .prepare_cached(
            "SELECT sequence, timestamp,
                CASE WHEN json_valid(payload) THEN json_remove(payload,
                    '$.images','$.output','$.execution.output','$.execution.metrics','$.metrics')
                    ELSE NULL END
             FROM events WHERE run_id = ?1
             ORDER BY sequence",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = statement.query(params![id]).map_err(|e| e.to_string())?;
    let mut state = Snapshot {
        run_id: id.to_owned(),
        ..Default::default()
    };
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let sequence = row.get(0).map_err(|e| e.to_string())?;
        let timestamp = row.get(1).map_err(|e| e.to_string())?;
        let payload: Option<String> = row.get(2).map_err(|e| e.to_string())?;
        let kind = payload
            .as_deref()
            .and_then(|payload| serde_json::from_str(payload).ok());
        let succeeded = kind.is_some_and(|kind| {
            // Invalid references in a damaged Run must not poison the cache
            // mutex or prevent unrelated Runs/settings from loading.
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                apply(
                    &mut state,
                    &Event {
                        sequence,
                        timestamp,
                        kind,
                    },
                );
            }))
            .is_ok()
        });
        if !succeeded {
            eprintln!("[Grapher] Sidebar metadata unavailable for Run {id}");
            return Ok(CachedRunOutcome::Unavailable);
        }
        state.events.clear();
        state.run_metrics = None;
    }
    Ok(CachedRunOutcome::Summary(build_summary(&state)))
}

/// Upper bound on sidebar fallback titles derived from `original_goal`.
/// Keeping sidebar titles bounded prevents multi-megabyte pasted prompts from
/// inflating `bootstrap` payloads, `localStorage`, or WebKit line-clamp layout.
const MAX_SUMMARY_TITLE_CHARS: usize = 512;

pub(crate) fn truncate_summary_title(raw: &str) -> String {
    if raw.len() <= MAX_SUMMARY_TITLE_CHARS {
        return raw.to_owned();
    }
    match raw.char_indices().nth(MAX_SUMMARY_TITLE_CHARS) {
        Some((byte_idx, _)) => format!("{}…", raw[..byte_idx].trim_end()),
        None => raw.to_owned(),
    }
}

fn build_summary(state: &Snapshot) -> Option<ConversationSummary> {
    let config = state.config.as_ref()?;
    if state.run_id.is_empty() || config.repository.is_empty() {
        return None;
    }
    let has_active_executions = state
        .executions
        .iter()
        .chain(&state.mergers)
        .any(|item| item.status == "running")
        || state
            .nodes
            .values()
            // Invalidated results wait for dispatch; they do not own a writer.
            .any(|item| item.status == "running")
        || state
            .result_execution
            .as_ref()
            .is_some_and(|item| item.status == "running");
    let raw_title = state
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or(&state.graph.original_goal);
    let title = truncate_summary_title(raw_title);
    Some(ConversationSummary {
        run_id: state.run_id.clone(),
        repository: config.repository.clone(),
        title,
        plan_type: state.plan_type.clone(),
        phase: state.phase.clone(),
        has_active_executions,
    })
}

#[cfg(test)]
pub(crate) fn forget_catalog(path: &Path) {
    if let Some(catalogs) = CATALOGS.get() {
        catalogs.lock().unwrap().remove(path);
    }
}

#[cfg(test)]
#[path = "conversations_tests.rs"]
mod tests;
