//! Disposable sidebar projection: no Store::load, transcript hydration, Git
//! inspection, schema changes or runtime lock. Only business metadata is reduced;
//! the canonical reducer remains the authority for phase and active work.
use crate::model::{apply, Event, Snapshot};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::{
    collections::HashMap,
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

struct Catalog {
    connection: Connection,
    version: Option<i64>,
    projection: ConversationCatalog,
}

static CATALOGS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<Catalog>>>>> = OnceLock::new();

pub fn conversation_summaries(path: &Path) -> Result<ConversationCatalog, String> {
    let catalog = {
        let mut catalogs = CATALOGS
            .get_or_init(Default::default)
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(catalog) = catalogs.get(path) {
            catalog.clone()
        } else {
            // Never call Store::open here: this worker must not initialize or
            // migrate a database, take the store write lock, or touch runtime state.
            let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e| e.to_string())?;
            connection
                .busy_timeout(std::time::Duration::from_secs(2))
                .map_err(|e| e.to_string())?;
            let catalog = Arc::new(Mutex::new(Catalog {
                connection,
                version: None,
                projection: ConversationCatalog::default(),
            }));
            catalogs.insert(path.to_owned(), catalog.clone());
            catalog
        }
    };
    let mut catalog = catalog.lock().map_err(|e| e.to_string())?;
    let version: i64 = catalog
        .connection
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if catalog.version == Some(version) {
        return Ok(catalog.projection.clone());
    }
    let projection = read_summaries(&mut catalog.connection)?;
    // Remember the version from BEFORE the read, so a concurrent commit cannot
    // label an older read as current. Errors never promote a stale cached read.
    catalog.projection = projection;
    catalog.version = Some(version);
    Ok(catalog.projection.clone())
}

fn read_summaries(connection: &mut Connection) -> Result<ConversationCatalog, String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let mut by_run = HashMap::new();
    let mut unavailable = std::collections::HashSet::new();
    {
        // Keep at most one Run's business projection, not its history. Legacy
        // Output rows and source-file payloads are filtered by their short tag
        // before JSON parsing. Large legacy Finished transcripts use the same
        // prefix-only projection as Store::load, never materializing log text.
        let mut statement = transaction.prepare(
            "SELECT run_id, sequence, timestamp,
                CASE
                    WHEN (kind='finished' OR (kind IS NULL AND substr(payload,1,18)='{\"type\":\"finished\"'))
                         AND length(payload)>4096
                         AND instr(substr(payload,1,512),'\"execution_id\":\"')>0
                         AND instr(substr(payload,1,512),'\"head\":\"')>0
                    THEN json_object('type','finished',
                        'execution_id',substr(payload,instr(substr(payload,1,512),'\"execution_id\":\"')+16,
                            instr(substr(payload,instr(substr(payload,1,512),'\"execution_id\":\"')+16,64),'\"')-1),
                        'head',substr(payload,instr(substr(payload,1,512),'\"head\":\"')+8,
                            instr(substr(payload,instr(substr(payload,1,512),'\"head\":\"')+8,64),'\"')-1),
                        'output','','output_bytes',0)
                    WHEN json_valid(payload) THEN json_remove(payload,
                        '$.images','$.output','$.execution.output','$.execution.metrics','$.metrics')
                    ELSE NULL
                END
             FROM events WHERE run_id NOT IN (SELECT run_id FROM deleted_runs)
                AND COALESCE(kind,'') NOT IN ('output','source_files_recorded')
                AND NOT (kind IS NULL AND (
                    substr(payload,1,16)='{\"type\":\"output\"'
                    OR substr(payload,1,64) LIKE '{\"type\":\"source_files_recorded\"%'))
             ORDER BY run_id,sequence"
        ).map_err(|e| e.to_string())?;
        let mut rows = statement.query([]).map_err(|e| e.to_string())?;
        let mut state = Snapshot::default();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let id: String = row.get(0).map_err(|e| e.to_string())?;
            if state.run_id != id {
                publish_summary(&state, &mut by_run);
                state = Snapshot {
                    run_id: id.clone(),
                    ..Default::default()
                };
            }
            if unavailable.contains(&id) {
                continue;
            }
            let sequence = row.get(1).map_err(|e| e.to_string())?;
            let timestamp = row.get(2).map_err(|e| e.to_string())?;
            let payload: Option<String> = row.get(3).map_err(|e| e.to_string())?;
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
                unavailable.insert(id);
            }
            state.events.clear();
            state.run_metrics = None;
        }
        publish_summary(&state, &mut by_run);
    }
    let mut projection = ConversationCatalog::default();
    {
        let mut statement = transaction
            .prepare(
                "SELECT run_id FROM events WHERE run_id NOT IN (SELECT run_id FROM deleted_runs)
             GROUP BY run_id ORDER BY MAX(sequence) DESC",
            )
            .map_err(|e| e.to_string())?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for id in ids {
            let id = id.map_err(|e| e.to_string())?;
            if unavailable.contains(&id) {
                projection.unavailable_run_ids.push(id);
            } else if let Some(summary) = by_run.remove(&id) {
                projection.conversations.push(summary);
            }
        }
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(projection)
}

fn publish_summary(state: &Snapshot, summaries: &mut HashMap<String, ConversationSummary>) {
    let Some(config) = &state.config else {
        return;
    };
    if state.run_id.is_empty() || config.repository.is_empty() {
        return;
    }
    let has_active_executions = state
        .executions
        .iter()
        .chain(&state.mergers)
        .any(|item| item.status == "running")
        || state
            .nodes
            .values()
            .any(|item| item.status == "running" || item.status == "dirty")
        || state
            .result_execution
            .as_ref()
            .is_some_and(|item| item.status == "running");
    summaries.insert(
        state.run_id.clone(),
        ConversationSummary {
            run_id: state.run_id.clone(),
            repository: config.repository.clone(),
            title: state.graph.original_goal.clone(),
            plan_type: state.plan_type.clone(),
            phase: state.phase.clone(),
            has_active_executions,
        },
    );
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
