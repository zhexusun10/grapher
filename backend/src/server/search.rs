//! Read-only workspace conversation search across user-sent messages and
//! agent plain-text replies. Never acquires the Store write lock or holds a
//! Run's Runtime mutex while scanning SQLite or planner logs.
use super::*;
use crate::api_contract::{ConversationSearchMatch, ConversationSearchResponse};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicUsize, Arc, Mutex, OnceLock};
use std::time::SystemTime;

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 100;
const MAX_HITS_PER_CONVERSATION: usize = 1;
const MAX_QUERY_BYTES: usize = 4096;
const MAX_RETAINED_LINE_BUF_BYTES: usize = 256 * 1024;
const MAX_INDEX_CACHE_BYTES: usize = 64 * 1024 * 1024;
const SNIPPET_BEFORE_CHARS: usize = 48;
const SNIPPET_AFTER_CHARS: usize = 84;
const SNIPPET_MATCH_MAX_CHARS: usize = 160;
const MAX_LOG_FILE_BYTES: u64 = 64 * 1024 * 1024;

fn db_file_id(path: &Path) -> Option<u128> {
    let meta = fs::metadata(path).ok()?;
    crate::workspace_metadata::file_identity(path, &meta)
        .ok()
        .map(|(id, _)| id)
}

struct CachedRunEntry {
    max_sequence: i64,
    data: Option<Arc<RunSearchData>>,
    bytes: usize,
    last_used: u64,
}

struct CachedExecutionTexts {
    run_id: String,
    end_offset: Option<usize>,
    log_bytes: usize,
    data_version: Option<i64>,
    texts: Arc<[String]>,
    bytes: usize,
    last_used: u64,
}

struct CachedPlannerTexts {
    len: u64,
    modified: Option<SystemTime>,
    data_version: Option<i64>,
    texts: Arc<[String]>,
    bytes: usize,
    last_used: u64,
}

struct SearchIndex {
    connection: Connection,
    data_version: Option<i64>,
    max_seq_by_run: HashMap<String, i64>,
    runs: HashMap<String, CachedRunEntry>,
    executions: HashMap<String, CachedExecutionTexts>,
    planners: HashMap<String, CachedPlannerTexts>,
    cached_bytes: usize,
    cache_budget: usize,
    clock: u64,
}

impl SearchIndex {
    fn open(db_path: &Path) -> Result<Self, String> {
        let connection = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(2))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            connection,
            data_version: None,
            max_seq_by_run: HashMap::new(),
            runs: HashMap::new(),
            executions: HashMap::new(),
            planners: HashMap::new(),
            cached_bytes: 0,
            cache_budget: MAX_INDEX_CACHE_BYTES,
            clock: 0,
        })
    }

    fn next_tick(&mut self) -> u64 {
        self.clock = self.clock.wrapping_add(1);
        self.clock
    }

    /// Sync SQLite `PRAGMA data_version` once per search. When unchanged,
    /// settled runs and execution logs require zero SQL queries.
    fn sync_db_version(&mut self) -> Result<bool, String> {
        let version: i64 = self
            .connection
            .query_row("PRAGMA data_version", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if self.data_version == Some(version) {
            return Ok(false);
        }
        let mut max_seqs = HashMap::new();
        {
            let mut stmt = self
                .connection
                .prepare_cached(
                    "SELECT run_id, MAX(sequence) FROM events
                     WHERE run_id NOT IN (SELECT run_id FROM deleted_runs)
                     GROUP BY run_id",
                )
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let run_id: String = row.get(0).map_err(|e| e.to_string())?;
                let seq: i64 = row.get(1).map_err(|e| e.to_string())?;
                max_seqs.insert(run_id, seq);
            }
        }
        // Drop deleted/absent runs and their cached execution/planner entries.
        let stale_runs: Vec<String> = self
            .runs
            .keys()
            .filter(|id| !max_seqs.contains_key(*id))
            .cloned()
            .collect();
        for id in stale_runs {
            if let Some(removed) = self.runs.remove(&id) {
                self.cached_bytes = self.cached_bytes.saturating_sub(removed.bytes);
                if let Some(data) = removed.data.as_deref() {
                    for (planning_id, _) in &data.planning_ids {
                        if let Some(removed_planner) = self.planners.remove(planning_id) {
                            self.cached_bytes =
                                self.cached_bytes.saturating_sub(removed_planner.bytes);
                        }
                    }
                }
            }
        }
        let stale_execs: Vec<String> = self
            .executions
            .iter()
            .filter(|(_, entry)| !max_seqs.contains_key(&entry.run_id))
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale_execs {
            if let Some(removed) = self.executions.remove(&id) {
                self.cached_bytes = self.cached_bytes.saturating_sub(removed.bytes);
            }
        }
        self.max_seq_by_run = max_seqs;
        self.data_version = Some(version);
        Ok(true)
    }

    fn run_data(&mut self, run_id: &str) -> Result<Option<Arc<RunSearchData>>, String> {
        let Some(&max_seq) = self.max_seq_by_run.get(run_id) else {
            return Ok(None);
        };
        let tick = self.next_tick();
        if let Some(entry) = self.runs.get_mut(run_id) {
            if entry.max_sequence == max_seq {
                entry.last_used = tick;
                return Ok(entry.data.clone());
            }
        }
        let data = load_run_search_data(&self.connection, run_id)?.map(Arc::new);
        let bytes = data.as_ref().map_or(0, |data| data.approx_bytes())
            + run_id.len()
            + std::mem::size_of::<CachedRunEntry>();
        if bytes > self.cache_budget {
            if let Some(previous) = self.runs.remove(run_id) {
                self.cached_bytes = self.cached_bytes.saturating_sub(previous.bytes);
            }
            return Ok(data);
        }
        if let Some(prev) = self.runs.insert(
            run_id.to_string(),
            CachedRunEntry {
                max_sequence: max_seq,
                data: data.clone(),
                bytes,
                last_used: tick,
            },
        ) {
            self.cached_bytes = self.cached_bytes.saturating_sub(prev.bytes);
        }
        self.cached_bytes = self.cached_bytes.saturating_add(bytes);
        self.evict_if_needed();
        Ok(data)
    }

    fn execution_texts(
        &mut self,
        run_id: &str,
        execution_id: &str,
        end_offset: Option<usize>,
    ) -> Arc<[String]> {
        let tick = self.next_tick();
        // A different workspace, user-only query or interrupted warmup may
        // already have observed this DB version without checking this log.
        // Freshness belongs to each entry, not the most recent query.
        let fast_hit = self.executions.get(execution_id).is_some_and(|entry| {
            entry.run_id == run_id
                && entry.end_offset == end_offset
                && entry.data_version == self.data_version
        });
        if fast_hit {
            if let Some(entry) = self.executions.get_mut(execution_id) {
                entry.last_used = tick;
            }
            return self
                .executions
                .get(execution_id)
                .map(|entry| Arc::clone(&entry.texts))
                .unwrap_or_default();
        }

        let log_bytes = query_execution_log_bytes(&self.connection, run_id, execution_id);
        let cache_hit = self.executions.get(execution_id).is_some_and(|entry| {
            entry.run_id == run_id
                && entry.end_offset == end_offset
                && entry.log_bytes == log_bytes
        });
        if cache_hit {
            if let Some(entry) = self.executions.get_mut(execution_id) {
                entry.last_used = tick;
                entry.data_version = self.data_version;
            }
            return self
                .executions
                .get(execution_id)
                .map(|entry| Arc::clone(&entry.texts))
                .unwrap_or_default();
        }

        let texts: Vec<String> = if log_bytes == 0 {
            Vec::new()
        } else {
            extract_execution_assistant_texts(&self.connection, run_id, execution_id, end_offset)
                .into_iter()
                .map(|t| normalize_whitespace(&t))
                .filter(|t| !t.is_empty())
                .collect()
        };
        let bytes = texts.iter().map(String::capacity).sum::<usize>()
            + texts.len() * std::mem::size_of::<String>()
            + execution_id.len()
            + run_id.len()
            + std::mem::size_of::<CachedExecutionTexts>();
        let texts: Arc<[String]> = texts.into();
        let result = Arc::clone(&texts);
        if bytes > self.cache_budget {
            if let Some(previous) = self.executions.remove(execution_id) {
                self.cached_bytes = self.cached_bytes.saturating_sub(previous.bytes);
            }
            return result;
        }
        if let Some(prev) = self.executions.insert(
            execution_id.to_string(),
            CachedExecutionTexts {
                run_id: run_id.to_string(),
                end_offset,
                log_bytes,
                data_version: self.data_version,
                texts,
                bytes,
                last_used: tick,
            },
        ) {
            self.cached_bytes = self.cached_bytes.saturating_sub(prev.bytes);
        }
        self.cached_bytes = self.cached_bytes.saturating_add(bytes);
        self.evict_if_needed();
        result
    }

    fn planner_texts(
        &mut self,
        planning_root: &Path,
        planning_id: &str,
        check_disk: bool,
    ) -> Arc<[String]> {
        let tick = self.next_tick();
        if !check_disk
            && self.planners.get(planning_id).is_some_and(|entry| {
                entry.data_version == self.data_version
            })
        {
            if let Some(entry) = self.planners.get_mut(planning_id) {
                entry.last_used = tick;
            }
            return self
                .planners
                .get(planning_id)
                .map(|entry| Arc::clone(&entry.texts))
                .unwrap_or_default();
        }

        if !is_valid_planning_id(planning_id) {
            return Arc::default();
        }
        let candidate = planning_root.join(planning_id).join("planner.jsonl");
        let Ok(Some(path)) = crate::path_safety::real_child_path(planning_root, &candidate, true)
        else {
            return Arc::default();
        };
        let Ok(meta) = fs::metadata(&path) else {
            return Arc::default();
        };
        let len = meta.len();
        let modified = meta.modified().ok();
        let cache_hit = self
            .planners
            .get(planning_id)
            .is_some_and(|entry| entry.len == len && entry.modified == modified);
        if cache_hit {
            if let Some(entry) = self.planners.get_mut(planning_id) {
                entry.last_used = tick;
                entry.data_version = self.data_version;
            }
            return self
                .planners
                .get(planning_id)
                .map(|entry| Arc::clone(&entry.texts))
                .unwrap_or_default();
        }

        let texts: Vec<String> = if len == 0 || len > MAX_LOG_FILE_BYTES {
            Vec::new()
        } else {
            extract_planner_assistant_texts_from_path(&path)
                .into_iter()
                .map(|t| normalize_whitespace(&t))
                .filter(|t| !t.is_empty())
                .collect()
        };
        let bytes = texts.iter().map(String::capacity).sum::<usize>()
            + texts.len() * std::mem::size_of::<String>()
            + planning_id.len()
            + std::mem::size_of::<CachedPlannerTexts>();
        let texts: Arc<[String]> = texts.into();
        let result = Arc::clone(&texts);
        if bytes > self.cache_budget {
            if let Some(previous) = self.planners.remove(planning_id) {
                self.cached_bytes = self.cached_bytes.saturating_sub(previous.bytes);
            }
            return result;
        }
        if let Some(prev) = self.planners.insert(
            planning_id.to_string(),
            CachedPlannerTexts {
                len,
                modified,
                data_version: self.data_version,
                texts,
                bytes,
                last_used: tick,
            },
        ) {
            self.cached_bytes = self.cached_bytes.saturating_sub(prev.bytes);
        }
        self.cached_bytes = self.cached_bytes.saturating_add(bytes);
        self.evict_if_needed();
        result
    }

    fn evict_if_needed(&mut self) {
        if self.cached_bytes <= self.cache_budget {
            return;
        }
        let target = self.cache_budget / 2;
        enum Key {
            Run(String),
            Execution(String),
            Planner(String),
        }
        let mut entries: Vec<_> = self
            .runs
            .iter()
            .map(|(key, entry)| (entry.last_used, Key::Run(key.clone())))
            .chain(
                self.executions
                    .iter()
                    .map(|(key, entry)| (entry.last_used, Key::Execution(key.clone()))),
            )
            .chain(
                self.planners
                    .iter()
                    .map(|(key, entry)| (entry.last_used, Key::Planner(key.clone()))),
            )
            .collect();
        entries.sort_unstable_by_key(|(used, _)| *used);
        for (_, key) in entries {
            // Hysteresis must not discard the final hot entry when it still
            // fits the hard budget, even if it exceeds the half-budget target.
            if self.cached_bytes <= target || (self.cached_bytes <= self.cache_budget
                && self.runs.len() + self.executions.len() + self.planners.len() == 1) {
                break;
            }
            let bytes = match key {
                Key::Run(key) => self.runs.remove(&key).map(|entry| entry.bytes),
                Key::Execution(key) => self.executions.remove(&key).map(|entry| entry.bytes),
                Key::Planner(key) => self.planners.remove(&key).map(|entry| entry.bytes),
            };
            self.cached_bytes = self.cached_bytes.saturating_sub(bytes.unwrap_or(0));
        }
    }
}

type SearchIndexSlot = (Option<u128>, Arc<Mutex<SearchIndex>>, Arc<AtomicUsize>);
static SEARCH_INDEXES: OnceLock<Mutex<HashMap<PathBuf, SearchIndexSlot>>> = OnceLock::new();

fn search_index_entry_for(
    db_path: &Path,
) -> Result<(Arc<Mutex<SearchIndex>>, Arc<AtomicUsize>), String> {
    let current_id = db_file_id(db_path);
    {
        let mut map = SEARCH_INDEXES
            .get_or_init(Default::default)
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some((saved_id, existing, waiting)) = map.get(db_path) {
            if current_id.is_some() && *saved_id == current_id {
                return Ok((existing.clone(), waiting.clone()));
            }
            // Drop the stale connection before opening the replacement SQLite file
            // so old WAL/SHM locks are released first.
            drop(map.remove(db_path));
        }
    }
    let opened = Arc::new(Mutex::new(SearchIndex::open(db_path)?));
    let waiting = Arc::new(AtomicUsize::new(0));
    let mut map = SEARCH_INDEXES
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some((saved_id, existing, existing_waiting)) = map.get(db_path) {
        if current_id.is_some() && *saved_id == current_id {
            return Ok((existing.clone(), existing_waiting.clone()));
        }
    }
    map.insert(
        db_path.to_path_buf(),
        (current_id, opened.clone(), waiting.clone()),
    );
    Ok((opened, waiting))
}

#[cfg(test)]
fn search_index_for(db_path: &Path) -> Result<Arc<Mutex<SearchIndex>>, String> {
    search_index_entry_for(db_path).map(|(index, _)| index)
}

fn query_execution_log_bytes(connection: &Connection, run_id: &str, execution_id: &str) -> usize {
    let Ok(mut stmt) = connection.prepare_cached(
        "SELECT offset, bytes FROM execution_logs WHERE execution_id = ?1 AND run_id = ?2 ORDER BY offset DESC LIMIT 1",
    ) else {
        return 0;
    };
    stmt.query_row(params![execution_id, run_id], |row| {
        Ok((row.get::<_, usize>(0)?, row.get::<_, usize>(1)?))
    })
    .optional()
    .ok()
    .flatten()
    .and_then(|(offset, bytes)| offset.checked_add(bytes))
    .unwrap_or(0)
}

#[cfg(test)]
fn forget_search_index(db_path: &Path) {
    if let Some(map) = SEARCH_INDEXES.get() {
        map.lock().unwrap().remove(db_path);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RoleFilter {
    All,
    User,
    Assistant,
}

impl RoleFilter {
    fn from_opt(value: Option<&str>) -> Result<Self, String> {
        match value.map(str::trim).filter(|s| !s.is_empty()) {
            None | Some("all") => Ok(Self::All),
            Some("user") => Ok(Self::User),
            Some("assistant") => Ok(Self::Assistant),
            Some(other) => Err(format!("Invalid search role filter: {other}")),
        }
    }

    fn includes_user(self) -> bool {
        matches!(self, Self::All | Self::User)
    }

    fn includes_assistant(self) -> bool {
        matches!(self, Self::All | Self::Assistant)
    }
}

pub(super) fn search_conversations(
    body: &serde_json::Value,
    service: &Arc<Service>,
) -> Result<ConversationSearchResponse, String> {
    let repository: String = argument(body, "repository")?;
    let raw_query: String = argument(body, "query")?;
    if raw_query.len() > MAX_QUERY_BYTES {
        return Err("Search query is too long".into());
    }
    let role_filter = RoleFilter::from_opt(body.get("role").and_then(serde_json::Value::as_str))?;
    let limit = body
        .get("limit")
        .and_then(serde_json::Value::as_u64)
        .map(|v| usize::try_from(v).unwrap_or(MAX_LIMIT).clamp(1, MAX_LIMIT))
        .unwrap_or(DEFAULT_LIMIT);

    let warm = body
        .get("warm")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let normalized_query = normalize_whitespace(&raw_query);
    if repository.trim().is_empty() || (!warm && normalized_query.is_empty()) {
        return Ok(ConversationSearchResponse {
            query: normalized_query,
            matches: Vec::new(),
            total_matches: 0,
            matched_conversations: 0,
            truncated: false,
        });
    }

    let root = match super::known_service_root(service) {
        Some(root) => root,
        None => service
            .runtime
            .lock()
            .map_err(|error| error.to_string())?
            .root
            .clone(),
    };
    if warm && normalized_query.is_empty() {
        warm_workspace_index(&root, &repository)?;
        return Ok(ConversationSearchResponse {
            query: String::new(),
            matches: Vec::new(),
            total_matches: 0,
            matched_conversations: 0,
            truncated: false,
        });
    }
    search_workspace_root(&root, &repository, &normalized_query, role_filter, limit)
}

struct ActiveQueryGuard(Arc<AtomicUsize>);

impl ActiveQueryGuard {
    fn acquire(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::AcqRel);
        Self(counter)
    }
}

impl Drop for ActiveQueryGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn warm_workspace_index(root: &Path, repository: &str) -> Result<(), String> {
    let db_path = root.join("events.sqlite");
    if !db_path.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    let catalog = crate::store::conversation_summaries(&db_path)?;
    let workspace_runs: Vec<_> = catalog
        .conversations
        .into_iter()
        .filter(|summary| {
            crate::path_identity::same_repository_binding(&summary.repository, repository)
        })
        .collect();
    if workspace_runs.is_empty() {
        return Ok(());
    }
    let (index_arc, waiting) = search_index_entry_for(&db_path)?;
    let db_changed = {
        if waiting.load(Ordering::Acquire) > 0 {
            return Ok(());
        }
        let mut index = index_arc.lock().map_err(|e| e.to_string())?;
        index.sync_db_version()?
    };
    let planning_root = root.join("planning").canonicalize().ok();
    for summary in &workspace_runs {
        // Yield immediately if an interactive search query is waiting on the index.
        if waiting.load(Ordering::Acquire) > 0 {
            break;
        }
        let mut index = index_arc.lock().map_err(|e| e.to_string())?;
        let Some(run_data) = index.run_data(&summary.run_id)? else {
            continue;
        };
        for exec in &run_data.executions {
            let _ = index.execution_texts(
                &summary.run_id,
                &exec.execution_id,
                exec.end_offset,
            );
        }
        if let Some(planning_root) = planning_root.as_deref() {
            let check_disk =
                db_changed || summary.phase == "planning" || summary.has_active_executions;
            for (planning_id, _) in &run_data.planning_ids {
                let _ = index.planner_texts(planning_root, planning_id, check_disk);
            }
        }
    }
    Ok(())
}

fn search_workspace_root(
    root: &Path,
    repository: &str,
    normalized_query: &str,
    role_filter: RoleFilter,
    limit: usize,
) -> Result<ConversationSearchResponse, String> {
    let db_path = root.join("events.sqlite");
    if !db_path.try_exists().map_err(|e| e.to_string())? {
        return Ok(ConversationSearchResponse {
            query: normalized_query.to_string(),
            matches: Vec::new(),
            total_matches: 0,
            matched_conversations: 0,
            truncated: false,
        });
    }

    let catalog = crate::store::conversation_summaries(&db_path)?;
    let workspace_runs: Vec<_> = catalog
        .conversations
        .into_iter()
        .filter(|summary| {
            crate::path_identity::same_repository_binding(&summary.repository, repository)
        })
        .collect();

    if workspace_runs.is_empty() {
        return Ok(ConversationSearchResponse {
            query: normalized_query.to_string(),
            matches: Vec::new(),
            total_matches: 0,
            matched_conversations: 0,
            truncated: false,
        });
    }

    let (index_arc, waiting) = search_index_entry_for(&db_path)?;
    let _active_query = ActiveQueryGuard::acquire(waiting);
    let mut index = index_arc.lock().map_err(|e| e.to_string())?;
    let db_changed = index.sync_db_version()?;

    let query_lower = normalized_query.to_lowercase();
    let query_is_caseless = is_caseless_query(&query_lower);
    let planning_root = root.join("planning").canonicalize().ok();

    let mut matches = Vec::new();
    let mut matched_conversations = 0usize;
    let mut truncated = false;

    for summary in &workspace_runs {
        let Some(run_data) = index.run_data(&summary.run_id)? else {
            continue;
        };

        let mut run_hits: Vec<ConversationSearchMatch> = Vec::new();
        let max_for_run = MAX_HITS_PER_CONVERSATION.min(limit.saturating_sub(matches.len()));
        let check_planner_disk =
            db_changed || summary.phase == "planning" || summary.has_active_executions;

        if max_for_run == 0 {
            // We already reached `limit`; probe for at least 1 more match so
            // `truncated` is truthful without scanning the rest of the DB.
            if run_has_any_match(
                &mut index,
                planning_root.as_deref(),
                summary,
                &run_data,
                &query_lower,
                query_is_caseless,
                role_filter,
                check_planner_disk,
            ) {
                truncated = true;
                break;
            }
            continue;
        }

        collect_run_matches(
            &mut index,
            planning_root.as_deref(),
            summary,
            &run_data,
            &query_lower,
            query_is_caseless,
            role_filter,
            check_planner_disk,
            max_for_run,
            &mut run_hits,
        );

        if !run_hits.is_empty() {
            matched_conversations += 1;
            matches.extend(run_hits);
        }
    }

    let total_matches = matches.len();
    Ok(ConversationSearchResponse {
        query: normalized_query.to_string(),
        matches,
        total_matches,
        matched_conversations,
        truncated,
    })
}

#[derive(Clone)]
struct UserMessageRecord {
    text: String,
    source_kind: &'static str,
    node: Option<String>,
    execution_id: Option<String>,
    timestamp: Option<u64>,
}

#[derive(Clone)]
struct ExecSearchTarget {
    execution_id: String,
    source_kind: &'static str,
    node: Option<String>,
    end_offset: Option<usize>,
    timestamp: Option<u64>,
}

#[derive(Clone)]
struct RunSearchData {
    user_messages: Vec<UserMessageRecord>,
    planning_ids: Vec<(String, Option<u64>)>,
    executions: Vec<ExecSearchTarget>,
}

impl RunSearchData {
    fn approx_bytes(&self) -> usize {
        self.user_messages
            .iter()
            .map(|m| {
                m.text.capacity()
                    + m.node.as_ref().map_or(0, String::capacity)
                    + m.execution_id.as_ref().map_or(0, String::capacity)
            })
            .sum::<usize>()
            + self.user_messages.capacity() * std::mem::size_of::<UserMessageRecord>()
            + self
                .planning_ids
                .iter()
                .map(|(id, _)| id.capacity())
                .sum::<usize>()
            + self.planning_ids.capacity() * std::mem::size_of::<(String, Option<u64>)>()
            + self
                .executions
                .iter()
                .map(|e| e.execution_id.capacity() + e.node.as_ref().map_or(0, String::capacity))
                .sum::<usize>()
            + self.executions.capacity() * std::mem::size_of::<ExecSearchTarget>()
    }
}

struct RawUserCandidate {
    sequence: i64,
    text: String,
    node: Option<String>,
    execution_id: Option<String>,
    request_id: Option<String>,
    timestamp: Option<u64>,
    is_planner: bool,
    is_edit: bool,
}

struct PlannerEditRecord {
    sequence: i64,
    old_instruction: String,
    first_turn: bool,
}

struct PlanningGoalRecord {
    sequence: i64,
    planning_id: String,
    goal: String,
    timestamp: u64,
}

struct PlanningOrderEntry {
    sequence: i64,
    planning_id: String,
    timestamp: Option<u64>,
}

struct EditRecord {
    sequence: i64,
    target: String,
    from_event_sequence: i64,
    from_execution_id: String,
    from_output_offset: Option<usize>,
}

fn load_run_search_data(
    connection: &Connection,
    run_id: &str,
) -> Result<Option<RunSearchData>, String> {
    let mut statement = connection
        .prepare_cached(
            "SELECT sequence, timestamp, planning_id, nested_planning_id,
                CASE WHEN json_valid(payload) THEN json_remove(payload,
                    '$.images','$.output','$.execution.output','$.execution.metrics','$.metrics')
                ELSE NULL END
             FROM events
             WHERE run_id = ?1
             ORDER BY sequence ASC",
        )
        .map_err(|e| e.to_string())?;

    let mut rows = statement.query(params![run_id]).map_err(|e| e.to_string())?;
    let mut state = Snapshot {
        run_id: run_id.to_string(),
        ..Default::default()
    };

    let mut first_prompt_ts: Option<u64> = None;
    let mut initial_planning_id: Option<String> = None;
    let mut planning_order: Vec<PlanningOrderEntry> = Vec::new();
    let mut seen_planning_ids: HashSet<String> = HashSet::new();
    let mut review_planning_ids: HashSet<String> = HashSet::new();
    let mut planning_goals: Vec<PlanningGoalRecord> = Vec::new();
    let mut seen_planning_goals: HashSet<String> = HashSet::new();
    let mut withdrawn_sequences: HashSet<i64> = HashSet::new();
    let mut inactive_planner_requests: HashSet<String> = HashSet::new();
    let mut planner_edits: Vec<PlannerEditRecord> = Vec::new();
    let mut edits: Vec<EditRecord> = Vec::new();
    let mut fresh_restarts: HashMap<String, i64> = HashMap::new();
    let mut candidates: Vec<RawUserCandidate> = Vec::new();

    let mut record_planning_id = |id: &str, seq: i64, ts: u64| {
        if !id.is_empty() && seen_planning_ids.insert(id.to_string()) {
            planning_order.push(PlanningOrderEntry {
                sequence: seq,
                planning_id: id.to_string(),
                timestamp: Some(ts),
            });
        }
    };

    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let sequence: i64 = row.get(0).map_err(|e| e.to_string())?;
        let timestamp: u64 = row.get(1).map_err(|e| e.to_string())?;
        let col_planning_id: Option<String> = row.get(2).map_err(|e| e.to_string())?;
        let col_nested_planning_id: Option<String> = row.get(3).map_err(|e| e.to_string())?;
        let payload: Option<String> = row.get(4).map_err(|e| e.to_string())?;

        if let Some(id) = col_planning_id.as_deref() {
            record_planning_id(id, sequence, timestamp);
        }
        if let Some(id) = col_nested_planning_id.as_deref() {
            record_planning_id(id, sequence, timestamp);
        }

        let Some(kind) = payload
            .as_deref()
            .and_then(|raw| serde_json::from_str::<EventKind>(raw).ok())
        else {
            return Ok(None);
        };

        match &kind {
            EventKind::PlanningStarted { goal, planning, .. } => {
                if first_prompt_ts.is_none() {
                    first_prompt_ts = Some(timestamp);
                }
                if initial_planning_id.is_none() {
                    initial_planning_id = Some(planning.planning_id.clone());
                }
                record_planning_id(&planning.planning_id, sequence, timestamp);
                if seen_planning_goals.insert(planning.planning_id.clone()) && !goal.trim().is_empty() {
                    planning_goals.push(PlanningGoalRecord {
                        sequence,
                        planning_id: planning.planning_id.clone(),
                        goal: goal.clone(),
                        timestamp,
                    });
                }
            }
            EventKind::Created {
                planning_id,
                planning,
                ..
            } => {
                if first_prompt_ts.is_none() {
                    first_prompt_ts = Some(timestamp);
                }
                if let Some(id) = planning_id.as_deref() {
                    if initial_planning_id.is_none() {
                        initial_planning_id = Some(id.to_string());
                    }
                    record_planning_id(id, sequence, timestamp);
                }
                if let Some(summary) = planning.as_ref() {
                    if initial_planning_id.is_none() {
                        initial_planning_id = Some(summary.planning_id.clone());
                    }
                    record_planning_id(&summary.planning_id, sequence, timestamp);
                }
            }
            EventKind::PlannerReviewStarted { planning }
            | EventKind::PlannerReviewFinished { planning, .. } => {
                review_planning_ids.insert(planning.planning_id.clone());
                record_planning_id(&planning.planning_id, sequence, timestamp);
            }
            EventKind::GraphRevised {
                planning_id,
                planning,
                ..
            } => {
                record_planning_id(planning_id, sequence, timestamp);
                record_planning_id(&planning.planning_id, sequence, timestamp);
                if let Some(goal) = planning.goal.as_deref() {
                    if seen_planning_goals.insert(planning.planning_id.clone()) && !goal.trim().is_empty() {
                        planning_goals.push(PlanningGoalRecord {
                            sequence,
                            planning_id: planning.planning_id.clone(),
                            goal: goal.to_string(),
                            timestamp,
                        });
                    }
                }
            }
            EventKind::PlannerTurnAborted { planning }
            | EventKind::PlanningFailed { planning }
            | EventKind::PlannerWorkspaceSelected { planning } => {
                record_planning_id(&planning.planning_id, sequence, timestamp);
                if let Some(goal) = planning.goal.as_deref() {
                    if seen_planning_goals.insert(planning.planning_id.clone()) && !goal.trim().is_empty() {
                        planning_goals.push(PlanningGoalRecord {
                            sequence,
                            planning_id: planning.planning_id.clone(),
                            goal: goal.to_string(),
                            timestamp,
                        });
                    }
                }
            }
            EventKind::PlannerSteerSubmitted {
                planning_id,
                request_id,
                instruction,
                ..
            } => {
                record_planning_id(planning_id, sequence, timestamp);
                candidates.push(RawUserCandidate {
                    sequence,
                    text: instruction.clone(),
                    node: None,
                    execution_id: None,
                    request_id: Some(request_id.clone()),
                    timestamp: Some(timestamp),
                    is_planner: true,
                    is_edit: false,
                });
            }
            EventKind::PlannerSteerStatus {
                request_id, status, ..
            } => {
                if matches!(status.as_str(), "withdrawn" | "failed") {
                    inactive_planner_requests.insert(request_id.clone());
                }
            }
            EventKind::PlannerConversationEdited {
                old_instruction,
                instruction,
                first_turn,
                ..
            } => {
                planner_edits.push(PlannerEditRecord {
                    sequence,
                    old_instruction: old_instruction.clone(),
                    first_turn: *first_turn,
                });
                if !first_turn {
                    candidates.push(RawUserCandidate {
                        sequence,
                        text: instruction.clone(),
                        node: None,
                        execution_id: None,
                        request_id: None,
                        timestamp: Some(timestamp),
                        is_planner: true,
                        is_edit: true,
                    });
                }
            }
            EventKind::Started {
                execution,
                fresh_restart,
                ..
            } => {
                if *fresh_restart {
                    fresh_restarts.insert(execution.node.clone(), sequence);
                }
            }
            EventKind::SteersWithdrawn {
                message_sequences, ..
            } => {
                withdrawn_sequences.extend(message_sequences.iter().copied());
            }
            EventKind::Steered {
                execution_id,
                node,
                instruction,
                ..
            } => {
                candidates.push(RawUserCandidate {
                    sequence,
                    text: instruction.clone(),
                    node: Some(node.clone()),
                    execution_id: Some(execution_id.clone()),
                    request_id: None,
                    timestamp: Some(timestamp),
                    is_planner: false,
                    is_edit: false,
                });
            }
            EventKind::NodeMessaged {
                node, instruction, ..
            } => {
                candidates.push(RawUserCandidate {
                    sequence,
                    text: instruction.clone(),
                    node: Some(node.clone()),
                    execution_id: None,
                    request_id: None,
                    timestamp: Some(timestamp),
                    is_planner: false,
                    is_edit: false,
                });
            }
            EventKind::Invalidated {
                target,
                instruction,
                human,
                ..
            } => {
                if *human {
                    candidates.push(RawUserCandidate {
                        sequence,
                        text: instruction.clone(),
                        node: Some(target.clone()),
                        execution_id: None,
                        request_id: None,
                        timestamp: Some(timestamp),
                        is_planner: false,
                        is_edit: false,
                    });
                }
            }
            EventKind::ConversationEdited {
                target,
                instruction,
                from_execution_id,
                from_event_sequence,
                from_output_offset,
                first_turn,
                ..
            } => {
                edits.push(EditRecord {
                    sequence,
                    target: target.clone(),
                    from_event_sequence: *from_event_sequence,
                    from_execution_id: from_execution_id.clone(),
                    from_output_offset: *from_output_offset,
                });
                if !first_turn || state.plan_type.as_deref() != Some("serial") {
                    candidates.push(RawUserCandidate {
                        sequence,
                        text: instruction.clone(),
                        node: Some(target.clone()),
                        execution_id: None,
                        request_id: None,
                        timestamp: Some(timestamp),
                        is_planner: false,
                        is_edit: true,
                    });
                }
            }
            _ => {}
        }

        let applied = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::model::apply(
                &mut state,
                &Event {
                    sequence,
                    timestamp,
                    kind,
                },
            );
        }))
        .is_ok();
        if !applied {
            return Ok(None);
        }
        state.events.clear();
        state.run_metrics = None;
    }

    let is_serial = state.plan_type.as_deref() == Some("serial");

    // Resolve abandoned Planner sequence ranges `[start, edit_seq)` caused by
    // `PlannerConversationEdited` so replaced Planner branches are excluded.
    let mut abandoned_planner_ranges: Vec<(i64, i64)> = Vec::new();
    for pedit in &planner_edits {
        if pedit.first_turn {
            abandoned_planner_ranges.push((i64::MIN, pedit.sequence));
            continue;
        }
        let target_clean = clean_user_message(&pedit.old_instruction);
        if target_clean.is_empty() {
            continue;
        }
        let goal_start = planning_goals
            .iter()
            .rev()
            .find(|g| g.sequence < pedit.sequence && clean_user_message(&g.goal) == target_clean)
            .map(|g| g.sequence);
        let steer_start = candidates
            .iter()
            .rev()
            .find(|c| {
                c.is_planner
                    && c.sequence < pedit.sequence
                    && clean_user_message(&c.text) == target_clean
            })
            .map(|c| c.sequence);
        let start = match (goal_start, steer_start) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };
        if let Some(start_seq) = start {
            abandoned_planner_ranges.push((start_seq, pedit.sequence));
        }
    }
    let is_abandoned_planner_seq = |seq: i64| -> bool {
        abandoned_planner_ranges
            .iter()
            .any(|&(start, end)| seq >= start && seq < end)
    };

    // Build user messages list (chronological; searched newest-first).
    let mut user_messages: Vec<UserMessageRecord> = Vec::new();
    let initial_goal = clean_user_message(&state.graph.original_goal);
    if !initial_goal.is_empty() {
        user_messages.push(UserMessageRecord {
            text: initial_goal,
            source_kind: if is_serial { "serial" } else { "planner" },
            node: None,
            execution_id: None,
            timestamp: first_prompt_ts,
        });
    }

    // Add follow-up planner goals (excluding the initial planning turn,
    // abandoned edited branches, and automated background reviews).
    for record in &planning_goals {
        if initial_planning_id.as_deref() == Some(record.planning_id.as_str())
            || review_planning_ids.contains(&record.planning_id)
            || is_abandoned_planner_seq(record.sequence)
        {
            continue;
        }
        let cleaned = clean_user_message(&record.goal);
        if !cleaned.is_empty() {
            user_messages.push(UserMessageRecord {
                text: cleaned,
                source_kind: "planner",
                node: None,
                execution_id: None,
                timestamp: Some(record.timestamp),
            });
        }
    }

    // Add non-withdrawn, active-branch user steers / follow-ups / edits.
    for cand in candidates {
        if withdrawn_sequences.contains(&cand.sequence) {
            continue;
        }
        if cand.is_planner {
            if cand
                .request_id
                .as_deref()
                .is_some_and(|id| inactive_planner_requests.contains(id))
            {
                continue;
            }
            if is_abandoned_planner_seq(cand.sequence) {
                continue;
            }
        }
        if let Some(node) = cand.node.as_deref() {
            // Drop turns superseded by a later fresh restart on the same node.
            if let Some(&restart_seq) = fresh_restarts.get(node) {
                if cand.sequence < restart_seq {
                    continue;
                }
            }
            // Drop turns replaced by a later ConversationEdited on the same node.
            let replaced = edits.iter().any(|edit| {
                edit.target == node
                    && cand.sequence < edit.sequence
                    && cand.sequence >= edit.from_event_sequence
            });
            if replaced {
                continue;
            }
            // For serial conversations, first_turn ConversationEdited updates
            // `state.graph.original_goal`, which we already included above.
            if is_serial && cand.is_edit && clean_user_message(&cand.text) == clean_user_message(&state.graph.original_goal) {
                continue;
            }
        }
        let cleaned = clean_user_message(&cand.text);
        if cleaned.is_empty() {
            continue;
        }
        let (source_kind, node_out) = if cand.is_planner {
            ("planner", None)
        } else if is_serial {
            ("serial", None)
        } else if cand
            .node
            .as_deref()
            .is_some_and(|n| n == "merger" || n.starts_with("merge:"))
        {
            ("merger", cand.node)
        } else {
            ("node", cand.node)
        };
        user_messages.push(UserMessageRecord {
            text: cleaned,
            source_kind,
            node: node_out,
            execution_id: cand.execution_id,
            timestamp: cand.timestamp,
        });
    }

    // Compute retained log prefixes for superseded executions referenced by
    // active ConversationEdited anchors.
    let mut retained_prefixes: HashMap<String, usize> = HashMap::new();
    for edit in &edits {
        if let Some(&restart_seq) = fresh_restarts.get(&edit.target) {
            if edit.sequence < restart_seq {
                continue;
            }
        }
        if let Some(offset) = edit.from_output_offset.filter(|&o| o > 0) {
            retained_prefixes
                .entry(edit.from_execution_id.clone())
                .and_modify(|existing| *existing = (*existing).min(offset))
                .or_insert(offset);
        }
    }

    let superseded: HashSet<&str> = state
        .superseded_execution_ids
        .iter()
        .map(String::as_str)
        .collect();

    let mut executions: Vec<ExecSearchTarget> = Vec::new();
    for exec in &state.executions {
        let end_offset = if superseded.contains(exec.id.as_str()) {
            match retained_prefixes.get(&exec.id).copied() {
                Some(offset) => Some(offset),
                None => continue,
            }
        } else {
            None
        };
        let (source_kind, node) = if is_serial {
            ("serial", None)
        } else {
            ("node", Some(exec.node.clone()))
        };
        executions.push(ExecSearchTarget {
            execution_id: exec.id.clone(),
            source_kind,
            node,
            end_offset,
            timestamp: exec.completed_at.or(Some(exec.started_at)),
        });
    }
    for merger in &state.mergers {
        executions.push(ExecSearchTarget {
            execution_id: merger.id.clone(),
            source_kind: "merger",
            node: Some(merger.node.clone()),
            end_offset: None,
            timestamp: merger.completed_at.or(Some(merger.started_at)),
        });
    }
    // Newest executions first.
    executions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    // Also include snapshot-level planning_id if not already seen.
    let mut active_planning_ids: Vec<(String, Option<u64>)> = planning_order
        .into_iter()
        .filter(|entry| !is_abandoned_planner_seq(entry.sequence))
        .map(|entry| (entry.planning_id, entry.timestamp))
        .collect();
    if let Some(id) = state.planning_id.as_deref() {
        if !id.is_empty() && !seen_planning_ids.contains(id) {
            active_planning_ids.push((id.to_string(), first_prompt_ts));
        }
    }

    // Pre-normalize user messages once when indexing so search keystrokes avoid
    // repeating whitespace normalization on every query.
    for msg in &mut user_messages {
        msg.text = normalize_whitespace(&msg.text);
    }
    user_messages.retain(|m| !m.text.is_empty());

    Ok(Some(RunSearchData {
        user_messages,
        planning_ids: active_planning_ids,
        executions,
    }))
}

#[allow(clippy::too_many_arguments)]
fn collect_run_matches(
    index: &mut SearchIndex,
    planning_root: Option<&Path>,
    summary: &crate::store::ConversationSummary,
    run_data: &RunSearchData,
    query_lower: &str,
    query_is_caseless: bool,
    role_filter: RoleFilter,
    check_planner_disk: bool,
    max_hits: usize,
    out: &mut Vec<ConversationSearchMatch>,
) {
    let mut push_match = |role: &'static str,
                          source_kind: &'static str,
                          node: Option<String>,
                          execution_id: Option<String>,
                          timestamp: Option<u64>,
                          normalized_text: &str|
     -> bool {
        let Some((snippet_before, snippet_match, snippet_after)) =
            find_match_snippet_normalized(normalized_text, query_lower, query_is_caseless)
        else {
            return false;
        };
        if out.len() >= max_hits {
            return true;
        }
        out.push(ConversationSearchMatch {
            run_id: summary.run_id.clone(),
            conversation_title: summary.title.clone(),
            plan_type: summary.plan_type.clone(),
            role: role.to_string(),
            source_kind: source_kind.to_string(),
            node,
            execution_id,
            snippet_before,
            snippet_match,
            snippet_after,
            timestamp,
        });
        out.len() >= max_hits
    };

    if role_filter.includes_user() {
        for msg in run_data.user_messages.iter().rev() {
            if push_match(
                "user",
                msg.source_kind,
                msg.node.clone(),
                msg.execution_id.clone(),
                msg.timestamp,
                &msg.text,
            ) {
                return;
            }
        }
    }

    if !role_filter.includes_assistant() {
        return;
    }

    // Search execution logs (newest first).
    for exec in &run_data.executions {
        let texts = index.execution_texts(
            &summary.run_id,
            &exec.execution_id,
            exec.end_offset,
        );
        for text in texts.iter().rev() {
            if push_match(
                "assistant",
                exec.source_kind,
                exec.node.clone(),
                Some(exec.execution_id.clone()),
                exec.timestamp,
                text,
            ) {
                return;
            }
        }
    }

    // Search Planner logs (`planner.jsonl` only; never `partition.jsonl`).
    if let Some(planning_root) = planning_root {
        for (planning_id, ts) in run_data.planning_ids.iter().rev() {
            let texts = index.planner_texts(planning_root, planning_id, check_planner_disk);
            for text in texts.iter().rev() {
                if push_match("assistant", "planner", None, None, *ts, text) {
                    return;
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_has_any_match(
    index: &mut SearchIndex,
    planning_root: Option<&Path>,
    summary: &crate::store::ConversationSummary,
    run_data: &RunSearchData,
    query_lower: &str,
    query_is_caseless: bool,
    role_filter: RoleFilter,
    check_planner_disk: bool,
) -> bool {
    let mut hits = Vec::new();
    collect_run_matches(
        index,
        planning_root,
        summary,
        run_data,
        query_lower,
        query_is_caseless,
        role_filter,
        check_planner_disk,
        1,
        &mut hits,
    );
    !hits.is_empty()
}

fn extract_planner_assistant_texts_from_path(path: &Path) -> Vec<String> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut extractor = AssistantTextExtractor::default();
    let mut reader = BufReader::new(file);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let Ok(read) = reader.read_until(b'\n', &mut buf) else {
            break;
        };
        if read == 0 {
            break;
        }
        while matches!(buf.last(), Some(b'\n' | b'\r')) {
            buf.pop();
        }
        let line = String::from_utf8_lossy(&buf);
        extractor.push_line(&line);
        if buf.capacity() > MAX_RETAINED_LINE_BUF_BYTES {
            buf = Vec::new();
        }
    }
    extractor.finish()
}

fn extract_execution_assistant_texts(
    connection: &Connection,
    run_id: &str,
    execution_id: &str,
    end_offset: Option<usize>,
) -> Vec<String> {
    let Ok(mut statement) = connection.prepare_cached(
        "SELECT offset, text FROM execution_logs WHERE execution_id = ?1 AND run_id = ?2 ORDER BY offset ASC",
    ) else {
        return Vec::new();
    };
    let Ok(mut rows) = statement.query(params![execution_id, run_id]) else {
        return Vec::new();
    };

    let mut extractor = AssistantTextExtractor::default();
    let mut pending_line = String::new();

    while let Ok(Some(row)) = rows.next() {
        let Ok(offset) = row.get::<_, usize>(0) else {
            break;
        };
        if let Some(limit) = end_offset {
            if offset >= limit {
                break;
            }
        }
        let Ok(chunk) = row.get::<_, String>(1) else {
            break;
        };
        let slice = match end_offset {
            Some(limit) if offset.saturating_add(chunk.len()) > limit => {
                let mut take = limit - offset;
                while take > 0 && !chunk.is_char_boundary(take) {
                    take -= 1;
                }
                &chunk[..take]
            }
            _ => chunk.as_str(),
        };

        let mut start = 0;
        for (idx, _) in slice.match_indices('\n') {
            if pending_line.is_empty() {
                extractor.push_line(&slice[start..idx]);
            } else {
                pending_line.push_str(&slice[start..idx]);
                extractor.push_line(&pending_line);
                if pending_line.capacity() > MAX_RETAINED_LINE_BUF_BYTES {
                    pending_line = String::new();
                } else {
                    pending_line.clear();
                }
            }
            start = idx + 1;
        }
        if start < slice.len() {
            pending_line.push_str(&slice[start..]);
        }
    }
    if !pending_line.is_empty() {
        extractor.push_line(&pending_line);
    }
    extractor.finish()
}

/// Stateful streaming extractor for agent plain-text replies from Pi JSONL
/// logs. Mirrors `src/services/transcriptParser.ts` while strictly discarding
/// thinking blocks, tool calls, tool results, stderr, system errors, and raw
/// process output.
#[derive(Default)]
struct AssistantTextExtractor {
    results: Vec<String>,
    streamed_text: String,
    in_tag_thinking: bool,
    in_final_response: bool,
    final_response_suppressed: bool,
    final_response_buf: String,
    turn_has_assistant_text: bool,
}

impl AssistantTextExtractor {
    fn push_line(&mut self, raw_line: &str) {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() && !self.in_final_response {
            return;
        }

        if self.in_final_response {
            if trimmed.starts_with('{') && trimmed.contains("\"grapher_planning_source\"") {
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    if event["type"].as_str() == Some("grapher_planning_source") {
                        self.flush_final_response();
                        self.flush_streamed();
                        self.in_final_response = false;
                        self.final_response_suppressed = false;
                        self.in_tag_thinking = false;
                        return;
                    }
                }
            }
            if !self.final_response_suppressed {
                if !self.final_response_buf.is_empty() {
                    self.final_response_buf.push('\n');
                }
                self.final_response_buf.push_str(raw_line);
            }
            return;
        }

        if !trimmed.starts_with('{') {
            if is_final_response_marker(trimmed) {
                self.flush_streamed();
                self.final_response_suppressed = self.turn_has_assistant_text;
                self.in_final_response = true;
            }
            return;
        }

        // Fast pre-filter: skip tool calls, tool results, thinking deltas,
        // compaction, and lifecycle frames without JSON parsing.
        let maybe_relevant = trimmed.contains("\"message_end\"")
            || trimmed.contains("\"message_start\"")
            || trimmed.contains("\"text_delta\"")
            || trimmed.contains("\"grapher_planning_source\"")
            || (trimmed.contains("\"message\"") && trimmed.contains("\"assistant\""));
        if !maybe_relevant {
            return;
        }

        let Ok(event) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            return;
        };
        let Some(event_type) = event.get("type").and_then(serde_json::Value::as_str) else {
            return;
        };

        match event_type {
            "grapher_planning_source" => {
                self.flush_streamed();
                self.in_tag_thinking = false;
                self.in_final_response = false;
                self.final_response_suppressed = false;
            }
            "message_start" => {
                let role = event["message"]["role"].as_str();
                if role == Some("user") {
                    self.flush_streamed();
                    self.turn_has_assistant_text = false;
                    self.in_tag_thinking = false;
                } else if role == Some("assistant") {
                    self.flush_streamed();
                    self.in_tag_thinking = false;
                }
            }
            "message_update" => {
                if event["assistantMessageEvent"]["type"].as_str() == Some("text_delta") {
                    if let Some(delta) = event["assistantMessageEvent"]["delta"].as_str() {
                        append_non_thinking_delta(
                            delta,
                            &mut self.in_tag_thinking,
                            &mut self.streamed_text,
                        );
                    }
                }
            }
            "message_end" => {
                self.in_tag_thinking = false;
                let message = &event["message"];
                if message["role"].as_str() == Some("assistant") {
                    let extracted = extract_assistant_message_text(message);
                    if !extracted.is_empty() {
                        self.streamed_text.clear();
                        self.turn_has_assistant_text = true;
                        self.results.push(extracted);
                    } else {
                        self.flush_streamed();
                    }
                } else if message["role"].as_str() == Some("user") {
                    self.turn_has_assistant_text = false;
                }
            }
            "message" => {
                let message = &event["message"];
                if message["role"].as_str() == Some("assistant") {
                    let extracted = extract_assistant_message_text(message);
                    if !extracted.is_empty() {
                        self.turn_has_assistant_text = true;
                        self.results.push(extracted);
                    }
                } else if message["role"].as_str() == Some("user") {
                    self.turn_has_assistant_text = false;
                }
            }
            _ => {}
        }
    }

    fn flush_streamed(&mut self) {
        if !self.streamed_text.trim().is_empty() {
            let text = std::mem::take(&mut self.streamed_text).trim().to_string();
            self.turn_has_assistant_text = true;
            self.results.push(text);
        } else {
            self.streamed_text.clear();
        }
    }

    fn flush_final_response(&mut self) {
        if !self.final_response_buf.trim().is_empty() {
            let raw = std::mem::take(&mut self.final_response_buf);
            let stripped = strip_inline_thinking_tags(&raw);
            if !stripped.trim().is_empty() {
                self.turn_has_assistant_text = true;
                self.results.push(stripped.trim().to_string());
            }
        } else {
            self.final_response_buf.clear();
        }
    }

    fn finish(mut self) -> Vec<String> {
        self.flush_streamed();
        self.flush_final_response();
        self.results
    }
}

fn is_final_response_marker(trimmed: &str) -> bool {
    if trimmed == "── Final response ──" {
        return true;
    }
    if !trimmed.contains('\u{001b}') {
        return false;
    }
    let cleaned = strip_ansi_sgr(trimmed);
    cleaned.trim() == "── Final response ──"
}

fn strip_ansi_sgr(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{001b}' && chars.peek() == Some(&'[') {
            chars.next();
            while let Some(&next) = chars.peek() {
                chars.next();
                if next == 'm' {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn extract_assistant_message_text(message: &serde_json::Value) -> String {
    let Some(parts) = message.get("content").and_then(serde_json::Value::as_array) else {
        return String::new();
    };
    let mut combined = String::new();
    for part in parts {
        if part.get("type").and_then(serde_json::Value::as_str) == Some("text") {
            if let Some(text) = part.get("text").and_then(serde_json::Value::as_str) {
                combined.push_str(text);
            }
        }
    }
    let stripped = strip_inline_thinking_tags(&combined);
    stripped.trim().to_string()
}

fn append_non_thinking_delta(delta: &str, in_thinking: &mut bool, out: &mut String) {
    let mut remaining = delta;
    while !remaining.is_empty() {
        if *in_thinking {
            if let Some((idx, tag_len)) = find_first_tag(remaining, &["</think>", "</thought>"]) {
                *in_thinking = false;
                remaining = &remaining[idx + tag_len..];
            } else {
                break;
            }
        } else if let Some((idx, tag_len)) = find_first_tag(remaining, &["<think>", "<thought>"]) {
            out.push_str(&remaining[..idx]);
            *in_thinking = true;
            remaining = &remaining[idx + tag_len..];
        } else {
            out.push_str(remaining);
            break;
        }
    }
}

fn strip_inline_thinking_tags(text: &str) -> String {
    if !text.contains("<think>") && !text.contains("<thought>") {
        return text.to_string();
    }
    let mut in_thinking = false;
    let mut out = String::with_capacity(text.len());
    append_non_thinking_delta(text, &mut in_thinking, &mut out);
    out
}

fn find_first_tag(text: &str, tags: &[&str]) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    for tag in tags {
        if let Some(idx) = text.find(tag) {
            if best.is_none_or(|(best_idx, _)| idx < best_idx) {
                best = Some((idx, tag.len()));
            }
        }
    }
    best
}

/// Remove attached file XML payloads, managed attachment path mentions, and
/// internal steer markers from stored user message text so only the user's own
/// message text is searched.
fn clean_user_message(raw: &str) -> String {
    let mut text = raw.trim();

    // Strip trailing `<grapher-steer-id>...</grapher-steer-id>` if present.
    if let Some(idx) = text.rfind("<grapher-steer-id>") {
        if text[idx..].ends_with("</grapher-steer-id>") {
            text = text[..idx].trim_end();
        }
    }

    // Strip leading `[@node]` prefix if present.
    if let Some(rest) = text.strip_prefix("[@") {
        if let Some(close) = rest.find(']') {
            text = rest[close + 1..].trim_start();
        }
    }

    // Strip `<file name="...">...</file>` blocks and managed attachment mentions.
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        if let Some(after_open) = rest.strip_prefix("<file name=\"") {
            if let Some(close_tag) = after_open.find("</file>") {
                rest = &after_open[close_tag + "</file>".len()..];
                rest = rest.trim_start_matches([' ', '\t', '\r', '\n']);
                continue;
            }
        }
        if rest.starts_with('@')
            && (out.is_empty() || out.chars().last().is_some_and(char::is_whitespace))
        {
            if let Some(consumed) = match_managed_attachment_mention(rest) {
                rest = &rest[consumed..];
                rest = rest.trim_start_matches([' ', '\t']);
                continue;
            }
        }
        let next_pos = next_special_offset(rest);
        if next_pos == 0 {
            let ch = rest.chars().next().unwrap();
            out.push(ch);
            rest = &rest[ch.len_utf8()..];
        } else {
            out.push_str(&rest[..next_pos]);
            rest = &rest[next_pos..];
        }
    }
    out.trim().to_string()
}

fn next_special_offset(text: &str) -> usize {
    let file_pos = text.find("<file name=\"");
    let at_pos = text.find('@');
    match (file_pos, at_pos) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => text.len(),
    }
}

fn match_managed_attachment_mention(text: &str) -> Option<usize> {
    let after_at = text.strip_prefix('@')?;
    let (path, consumed) = if let Some(quoted) = after_at.strip_prefix('"') {
        let mut escaped = false;
        let mut end = None;
        for (idx, ch) in quoted.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                end = Some(idx);
                break;
            } else if ch == '\n' || ch == '\r' {
                return None;
            }
        }
        let end = end?;
        (&quoted[..end], 1 + 1 + end + 1)
    } else {
        let end = after_at
            .find(char::is_whitespace)
            .unwrap_or(after_at.len());
        (&after_at[..end], 1 + end)
    };
    if is_managed_attachment_path(path) {
        Some(consumed)
    } else {
        None
    }
}

fn is_managed_attachment_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let Some((_, after_marker)) = normalized.split_once("/attachment-inputs/") else {
        return false;
    };
    let mut segments = after_marker.split('/');
    let Some(first) = segments.next() else {
        return false;
    };
    let Some(second) = segments.next() else {
        return false;
    };
    if uuid::Uuid::parse_str(first).is_err() {
        return false;
    }
    match segments.next() {
        None => !second.is_empty() && second != "." && second != "..",
        Some(filename) => {
            segments.next().is_none()
                && uuid::Uuid::parse_str(second).is_ok()
                && !filename.is_empty()
                && filename != "."
                && filename != ".."
        }
    }
}

fn normalize_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len().min(4096));
    let mut prev_space = true;
    for ch in text.chars() {
        if ch.is_whitespace() || ch.is_control() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

fn is_caseless_query(query_lower: &str) -> bool {
    query_lower
        .chars()
        .all(|ch| !ch.is_alphabetic() || ch.to_lowercase().eq(ch.to_uppercase()))
}

fn find_case_insensitive_range(
    haystack: &str,
    needle_lower: &str,
    query_is_caseless: bool,
) -> Option<(usize, usize)> {
    if needle_lower.is_empty() || haystack.is_empty() {
        return None;
    }
    // Fast path 1: pure caseless queries (e.g. Chinese/CJK, digits, symbols)
    // match directly with SIMD str::find and zero allocations.
    if query_is_caseless {
        let start = haystack.find(needle_lower)?;
        return Some((start, start + needle_lower.len()));
    }
    // Fast path 2: pure ASCII queries scan UTF-8 bytes directly with zero allocations.
    if needle_lower.is_ascii() {
        // Keep the allocation-free path bounded. A long repeated prefix with
        // a mismatch at the end otherwise compares N * query_length bytes.
        if needle_lower.len() > 32 {
            return haystack
                .to_ascii_lowercase()
                .find(needle_lower)
                .map(|start| (start, start + needle_lower.len()));
        }
        let needle_bytes = needle_lower.as_bytes();
        let hay_bytes = haystack.as_bytes();
        if needle_bytes.len() > hay_bytes.len() {
            return None;
        }
        return hay_bytes
            .windows(needle_bytes.len())
            .position(|window| window.eq_ignore_ascii_case(needle_bytes))
            .map(|start| (start, start + needle_bytes.len()));
    }

    // Whole-string lowercasing handles contextual forms such as Greek final
    // sigma. Walk only to the hit to recover original UTF-8 boundaries; a map
    // for every byte used to consume up to 16 times the message's memory.
    let lower = haystack.to_lowercase();
    let pos = lower.find(needle_lower)?;
    let end = pos + needle_lower.len();
    let mut lowered_offset = 0;
    let mut start = None;
    for (orig_start, ch) in haystack.char_indices() {
        let next = lowered_offset + ch.to_lowercase().map(char::len_utf8).sum::<usize>();
        if lowered_offset <= pos && pos < next {
            start = Some(orig_start);
        }
        if next >= end {
            return Some((start?, orig_start + ch.len_utf8()));
        }
        lowered_offset = next;
    }
    None
}

#[cfg(test)]
fn find_match_snippet(text: &str, query_lower: &str) -> Option<(String, String, String)> {
    let normalized = normalize_whitespace(text);
    find_match_snippet_normalized(&normalized, query_lower, is_caseless_query(query_lower))
}

fn find_match_snippet_normalized(
    normalized: &str,
    query_lower: &str,
    query_is_caseless: bool,
) -> Option<(String, String, String)> {
    let (match_start, match_end) =
        find_case_insensitive_range(normalized, query_lower, query_is_caseless)?;

    // Build prefix snippet (~SNIPPET_BEFORE_CHARS chars before match_start) in O(SNIPPET_BEFORE_CHARS).
    let prefix_full = &normalized[..match_start];
    let snippet_before = match prefix_full.char_indices().rev().nth(SNIPPET_BEFORE_CHARS) {
        Some((prev_byte, prev_ch)) => {
            let start_byte = prev_byte + prev_ch.len_utf8();
            let slice = prefix_full[start_byte..].trim_start();
            format!("…{slice}")
        }
        None => prefix_full.to_string(),
    };

    // Keep matched text intact (cap only if extraordinarily long).
    let matched_slice = &normalized[match_start..match_end];
    let snippet_match = match matched_slice.char_indices().nth(SNIPPET_MATCH_MAX_CHARS) {
        Some((end_byte, _)) => format!("{}…", &matched_slice[..end_byte]),
        None => matched_slice.to_string(),
    };

    // Build suffix snippet (~SNIPPET_AFTER_CHARS chars after match_end) in O(SNIPPET_AFTER_CHARS).
    let suffix_full = &normalized[match_end..];
    let snippet_after = match suffix_full.char_indices().nth(SNIPPET_AFTER_CHARS) {
        Some((end_byte, _)) => {
            let slice = suffix_full[..end_byte].trim_end();
            format!("{slice}…")
        }
        None => suffix_full.to_string(),
    };

    Some((snippet_before, snippet_match, snippet_after))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Config, Execution, Graph, Node, PlanningSummary};
    use crate::store::Store;

    fn test_config(repo: &str) -> Config {
        serde_json::from_value(serde_json::json!({
            "repository": repo,
            "model": "test/model",
            "maxParallel": 1
        }))
        .unwrap()
    }

    fn test_execution(
        id: &str,
        node: &str,
        started_at: u64,
        completed_at: Option<u64>,
    ) -> Execution {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "node": node,
            "attempt": 1,
            "revision": 0,
            "sessionId": "",
            "before": "",
            "after": null,
            "worktree": "",
            "status": "completed",
            "startedAt": started_at,
            "completedAt": completed_at
        }))
        .unwrap()
    }

    #[test]
    fn search_cache_budget_includes_run_messages_and_keeps_oversized_results_searchable() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("events.sqlite");
        let store = Store::open(&db).unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        let repo = repo.to_string_lossy().to_string();
        let planning_id = "cache-budget-planner";
        let mut state = Snapshot {
            run_id: "cache-budget-run".into(),
            ..Default::default()
        };
        store
            .append(
                &mut state,
                EventKind::Created {
                    graph: Graph {
                        original_goal: format!("userneedle {}", "x".repeat(4096)),
                        nodes: vec![Node {
                            id: "task".into(),
                            task: "work".into(),
                        }],
                        edges: vec![],
                    },
                    config: test_config(&repo),
                    planning_id: Some(planning_id.into()),
                    planning: Some(PlanningSummary {
                        planning_id: planning_id.into(),
                        ..Default::default()
                    }),
                },
            )
            .unwrap();
        store
            .append(
                &mut state,
                EventKind::Started {
                    execution: test_execution("cache-budget-exec", "task", 1, Some(2)),
                    message_sequences: None,
                    fresh_restart: false,
                },
            )
            .unwrap();
        let log = |needle: &str| {
            format!(
                "{}\n",
                serde_json::json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":format!("{needle} {}", "x".repeat(4096))}]}})
            )
        };
        store
            .append(
                &mut state,
                EventKind::Output {
                    execution_id: "cache-budget-exec".into(),
                    text: log("executionneedle"),
                },
            )
            .unwrap();
        let planning = temp.path().join("planning").join(planning_id);
        fs::create_dir_all(&planning).unwrap();
        fs::write(planning.join("planner.jsonl"), log("plannerneedle")).unwrap();
        let index = search_index_for(&db).unwrap();
        index.lock().unwrap().cache_budget = 1024;
        for needle in ["userneedle", "executionneedle", "plannerneedle"] {
            let result =
                search_workspace_root(temp.path(), &repo, needle, RoleFilter::All, 50).unwrap();
            assert_eq!(
                result.matches.len(),
                1,
                "eviction must not hide the current {needle} result"
            );
            assert!(
                index.lock().unwrap().cached_bytes <= 1024,
                "every retained cache category must obey the shared budget"
            );
        }
        // Several individually cacheable Runs must participate in eviction too;
        // rejecting only a single oversized entry does not bound this case.
        index.lock().unwrap().cache_budget = 8192;
        for i in 0..32 {
            let mut small = Snapshot {
                run_id: format!("small-cache-{i}"),
                ..Default::default()
            };
            store.append(&mut small, EventKind::Created {
                graph: Graph {
                    original_goal: format!("smallneedle {}", "x".repeat(128)),
                    nodes: vec![], edges: vec![],
                },
                config: test_config(&repo), planning_id: None, planning: None,
            }).unwrap();
        }
        let small = search_workspace_root(temp.path(), &repo, "smallneedle", RoleFilter::User, 50).unwrap();
        assert_eq!(small.matches.len(), 32);
        let used = index.lock().unwrap().cached_bytes;
        assert!(used > 0 && used <= 8192, "small entries must remain cached within budget");
        forget_search_index(&db);
        crate::store::forget_catalog(&db);
    }

    #[test]
    fn extractor_keeps_only_assistant_plain_text_and_ignores_tools_and_thinking() {
        let log = [
            r#"{"type":"message_start","message":{"role":"user","content":"secret_user_prompt"}}"#,
            r#"{"type":"message_start","message":{"role":"assistant","content":[]}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"secret_thinking_token"}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"<think>inline_secret_thought</think>Hello "}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Grapher!"}}"#,
            r#"{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"echo secret_tool_arg"}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{"content":[{"type":"text","text":"secret_tool_output"}]}}"#,
            r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"secret_thinking_block"},{"type":"text","text":"<think>inline_secret_thought</think>Hello Grapher!"},{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"echo secret_tool_arg"}}]}}"#,
            r#"{"type":"message","message":{"role":"toolResult","toolCallId":"t1","toolName":"bash","content":[{"type":"text","text":"secret_tool_result"}]}}"#,
            r#"{"type":"extension_error","message":"secret_extension_error"}"#,
            r#"[stderr] secret_stderr_line"#,
            r#"raw_stdout_not_json"#,
            r#"── Final response ──"#,
            r#"Hello Grapher!"#,
        ]
        .join("\n");

        let mut extractor = AssistantTextExtractor::default();
        for line in log.lines() {
            extractor.push_line(line);
        }
        let texts = extractor.finish();
        assert_eq!(texts, vec!["Hello Grapher!"]);
    }

    #[test]
    fn extractor_keeps_partial_streamed_text_when_aborted_without_message_end() {
        let log = [
            r#"{"type":"message_start","message":{"role":"assistant","content":[]}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Partial answer "}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"before abort"}}"#,
            r#"{"type":"grapher_process_exited","code":1}"#,
        ]
        .join("\n");

        let mut extractor = AssistantTextExtractor::default();
        for line in log.lines() {
            extractor.push_line(line);
        }
        assert_eq!(extractor.finish(), vec!["Partial answer before abort"]);
    }

    #[test]
    fn clean_user_message_strips_attachments_and_steer_markers() {
        let raw = concat!(
            "<file name=\"big.txt\">secret_file_body</file>\n\n",
            "@/tmp/data/attachment-inputs/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/spec.pdf ",
            "帮我检查这个逻辑\n\n",
            "<grapher-steer-id>11111111-1111-1111-1111-111111111111</grapher-steer-id>"
        );
        assert_eq!(clean_user_message(raw), "帮我检查这个逻辑");
    }

    #[test]
    fn search_scopes_to_workspace_and_searches_user_and_assistant_plain_text_only() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let db = root.join("events.sqlite");
        let store = Store::open(&db).unwrap();

        let repo_a = temp.path().join("workspace-a");
        let repo_b = temp.path().join("workspace-b");
        fs::create_dir_all(&repo_a).unwrap();
        fs::create_dir_all(&repo_b).unwrap();
        let repo_a_str = repo_a.to_string_lossy().to_string();
        let repo_b_str = repo_b.to_string_lossy().to_string();

        // Run 1 in workspace A (graph with planner + node + execution log)
        let mut s1 = Snapshot {
            run_id: "run-a-1".into(),
            ..Default::default()
        };
        let planning_id = "11111111-1111-1111-1111-111111111111".to_string();
        store
            .append(
                &mut s1,
                EventKind::Created {
                    graph: Graph {
                        original_goal: "<file name=\"a.txt\">ignored_attachment_word</file>\n\n优化数据库查询性能".into(),
                        nodes: vec![Node {
                            id: "db-opt".into(),
                            task: "ignored_node_task_word".into(),
                        }],
                        edges: vec![],
                    },
                    config: test_config(&repo_a_str),
                    planning_id: Some(planning_id.clone()),
                    planning: Some(PlanningSummary {
                        planning_id: planning_id.clone(),
                        goal: Some("优化数据库查询性能".into()),
                        ..Default::default()
                    }),
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::Started {
                    execution: test_execution("exec-a-1", "db-opt", 1000, Some(2000)),
                    message_sequences: None,
                    fresh_restart: false,
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::Steered {
                    execution_id: "exec-a-1".into(),
                    node: "db-opt".into(),
                    instruction: "请顺便加上复合索引".into(),
                    request_id: Some("req-1".into()),
                    images: None,
                },
            )
            .unwrap();
        // Automated feedback (human: false) must NOT be indexed as user text.
        store
            .append(
                &mut s1,
                EventKind::Invalidated {
                    nodes: vec!["db-opt".into()],
                    target: "db-opt".into(),
                    instruction: "automated_feedback_only_word".into(),
                    human: false,
                    request_id: None,
                    images: None,
                    workspace: None,
                    shared_workspace: false,
                    source_direct: false,
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::Output {
                    execution_id: "exec-a-1".into(),
                    text: [
                        r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"secret_thinking_only"},{"type":"text","text":"已完成索引优化，查询耗时降低了 80%。"},{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"secret_tool_only"}}]}}"#,
                        r#"{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{"content":[{"type":"text","text":"secret_tool_result_only"}]}}"#,
                    ]
                    .join("\n")
                        + "\n",
                },
            )
            .unwrap();

        // Planner log for run-a-1
        let plan_dir = root.join("planning").join(&planning_id);
        fs::create_dir_all(&plan_dir).unwrap();
        fs::write(
            plan_dir.join("planner.jsonl"),
            r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"我已规划好数据库优化节点。"}]}}"#,
        )
        .unwrap();
        // Partition log must be ignored!
        fs::write(
            plan_dir.join("partition.jsonl"),
            r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partition_only_word"}]}}"#,
        )
        .unwrap();

        // Run 2 in workspace B (must NOT leak into workspace A search)
        let mut s2 = Snapshot {
            run_id: "run-b-1".into(),
            ..Default::default()
        };
        store
            .append(
                &mut s2,
                EventKind::Created {
                    graph: Graph {
                        original_goal: "优化数据库查询性能 workspace B".into(),
                        nodes: vec![],
                        edges: vec![],
                    },
                    config: test_config(&repo_b_str),
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();

        // Search in workspace A for "数据库" -> returns one conversation candidate for run-a-1, NOT workspace B
        let res = search_workspace_root(root, &repo_a_str, "数据库", RoleFilter::All, 50).unwrap();
        assert_eq!(res.matched_conversations, 1);
        assert_eq!(res.matches.len(), 1);
        assert_eq!(res.matches[0].run_id, "run-a-1");
        assert!(!res.truncated);

        // Search for user-only phrase (from steer) and assistant-only phrase (from node reply & planner reply)
        let user_hit = search_workspace_root(root, &repo_a_str, "复合索引", RoleFilter::All, 50).unwrap();
        assert_eq!(user_hit.matches.len(), 1);
        assert_eq!(user_hit.matches[0].run_id, "run-a-1");
        assert_eq!(user_hit.matches[0].role, "user");

        let node_reply_hit = search_workspace_root(root, &repo_a_str, "查询耗时降低了", RoleFilter::All, 50).unwrap();
        assert_eq!(node_reply_hit.matches.len(), 1);
        assert_eq!(node_reply_hit.matches[0].run_id, "run-a-1");
        assert_eq!(node_reply_hit.matches[0].role, "assistant");

        let planner_reply_hit = search_workspace_root(
            root,
            &repo_a_str,
            "规划好数据库优化节点",
            RoleFilter::All,
            50,
        )
        .unwrap();
        assert_eq!(planner_reply_hit.matches.len(), 1);
        assert_eq!(planner_reply_hit.matches[0].run_id, "run-a-1");
        assert_eq!(planner_reply_hit.matches[0].role, "assistant");

        // Verify ignored content NEVER matches
        for ignored in [
            "ignored_attachment_word",
            "ignored_node_task_word",
            "automated_feedback_only_word",
            "secret_thinking_only",
            "secret_tool_only",
            "secret_tool_result_only",
            "partition_only_word",
        ] {
            let empty = search_workspace_root(root, &repo_a_str, ignored, RoleFilter::All, 50).unwrap();
            assert!(
                empty.matches.is_empty(),
                "expected no matches for ignored content `{ignored}`, got {:?}",
                empty.matches
            );
        }

        // Role filter: user only vs assistant only
        let user_only = search_workspace_root(root, &repo_a_str, "索引", RoleFilter::User, 50).unwrap();
        assert_eq!(user_only.matches.len(), 1);
        assert_eq!(user_only.matches[0].role, "user");

        let assistant_only = search_workspace_root(root, &repo_a_str, "索引", RoleFilter::Assistant, 50).unwrap();
        assert_eq!(assistant_only.matches.len(), 1);
        assert_eq!(assistant_only.matches[0].role, "assistant");

        crate::store::forget_catalog(&db);
    }

    #[test]
    fn search_excludes_withdrawn_steers_and_deleted_runs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let db = root.join("events.sqlite");
        let store = Store::open(&db).unwrap();

        let repo = temp.path().join("workspace-c");
        fs::create_dir_all(&repo).unwrap();
        let repo_str = repo.to_string_lossy().to_string();

        let mut s1 = Snapshot {
            run_id: "run-c-1".into(),
            ..Default::default()
        };
        store
            .append(
                &mut s1,
                EventKind::Created {
                    graph: Graph {
                        original_goal: "修复登录按钮样式".into(),
                        nodes: vec![Node {
                            id: "task".into(),
                            task: "修复登录按钮样式".into(),
                        }],
                        edges: vec![],
                    },
                    config: test_config(&repo_str),
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::Routed {
                    plan_type: "serial".into(),
                    images: None,
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::Started {
                    execution: test_execution("exec-c-1", "task", 1000, None),
                    message_sequences: None,
                    fresh_restart: false,
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::Steered {
                    execution_id: "exec-c-1".into(),
                    node: "task".into(),
                    instruction: "withdrawn_secret_steer".into(),
                    request_id: Some("req-w".into()),
                    images: None,
                },
            )
            .unwrap();
        let steer_seq = s1.events.last().unwrap().sequence;
        store
            .append(
                &mut s1,
                EventKind::SteersWithdrawn {
                    execution_id: "exec-c-1".into(),
                    message_sequences: vec![steer_seq],
                },
            )
            .unwrap();

        let withdrawn = search_workspace_root(
            root,
            &repo_str,
            "withdrawn_secret_steer",
            RoleFilter::All,
            50,
        )
        .unwrap();
        assert!(withdrawn.matches.is_empty());

        let serial = search_workspace_root(root, &repo_str, "登录按钮", RoleFilter::All, 50).unwrap();
        assert_eq!(serial.matches.len(), 1);
        assert_eq!(serial.matches[0].source_kind, "serial");
        assert_eq!(serial.matches[0].node, None);

        store.delete_run("run-c-1").unwrap();
        let after_delete = search_workspace_root(root, &repo_str, "登录按钮", RoleFilter::All, 50).unwrap();
        assert!(after_delete.matches.is_empty());

        crate::store::forget_catalog(&db);
    }

    #[test]
    fn search_respects_conversation_edited_output_prefix_and_excludes_abandoned_suffix() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let db = root.join("events.sqlite");
        let store = Store::open(&db).unwrap();

        let repo = temp.path().join("workspace-d");
        fs::create_dir_all(&repo).unwrap();
        let repo_str = repo.to_string_lossy().to_string();

        let mut s1 = Snapshot {
            run_id: "run-d-1".into(),
            ..Default::default()
        };
        store
            .append(
                &mut s1,
                EventKind::Created {
                    graph: Graph {
                        original_goal: "第一轮提问".into(),
                        nodes: vec![Node {
                            id: "task".into(),
                            task: "第一轮提问".into(),
                        }],
                        edges: vec![],
                    },
                    config: test_config(&repo_str),
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::Routed {
                    plan_type: "serial".into(),
                    images: None,
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::Started {
                    execution: test_execution("exec-d-1", "task", 1000, Some(2000)),
                    message_sequences: None,
                    fresh_restart: false,
                },
            )
            .unwrap();
        let turn1 = "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"保留的第一轮回复\"}]}}\n";
        let turn2 = "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"被编辑替换掉的旧回复\"}]}}\n";
        let cutoff = turn1.len();
        store
            .append(
                &mut s1,
                EventKind::Output {
                    execution_id: "exec-d-1".into(),
                    text: format!("{turn1}{turn2}"),
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::Steered {
                    execution_id: "exec-d-1".into(),
                    node: "task".into(),
                    instruction: "被替换的旧追问".into(),
                    request_id: Some("req-old".into()),
                    images: None,
                },
            )
            .unwrap();
        let old_seq = s1.events.last().unwrap().sequence;
        store
            .append(
                &mut s1,
                EventKind::ConversationEdited {
                    nodes: vec!["task".into()],
                    target: "task".into(),
                    instruction: "编辑后的新追问".into(),
                    images: None,
                    from_execution_id: "exec-d-1".into(),
                    from_event_sequence: old_seq,
                    from_output_offset: Some(cutoff),
                    old_instruction: "被替换的旧追问".into(),
                    first_turn: false,
                    selected_version: None,
                },
            )
            .unwrap();

        // Retained prefix before edit IS searchable
        let kept = search_workspace_root(root, &repo_str, "保留的第一轮回复", RoleFilter::All, 50).unwrap();
        assert_eq!(kept.matches.len(), 1);
        assert_eq!(kept.matches[0].role, "assistant");

        // Edited replacement user message IS searchable
        let edited = search_workspace_root(root, &repo_str, "编辑后的新追问", RoleFilter::All, 50).unwrap();
        assert_eq!(edited.matches.len(), 1);
        assert_eq!(edited.matches[0].role, "user");

        // Abandoned suffix and old replaced steer are NOT searchable
        let abandoned_reply = search_workspace_root(root, &repo_str, "被编辑替换掉的旧回复", RoleFilter::All, 50).unwrap();
        assert!(abandoned_reply.matches.is_empty());
        let abandoned_user = search_workspace_root(root, &repo_str, "被替换的旧追问", RoleFilter::All, 50).unwrap();
        assert!(abandoned_user.matches.is_empty());

        crate::store::forget_catalog(&db);
    }

    #[test]
    fn search_excludes_withdrawn_planner_steers_abandoned_planner_edits_and_survives_invalid_utf8() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let db = root.join("events.sqlite");
        let store = Store::open(&db).unwrap();

        let repo = temp.path().join("workspace-e");
        fs::create_dir_all(&repo).unwrap();
        let repo_str = repo.to_string_lossy().to_string();

        let pid_old = "33333333-3333-3333-3333-333333333333".to_string();
        let pid_new = "44444444-4444-4444-4444-444444444444".to_string();

        let mut s1 = Snapshot {
            run_id: "run-e-1".into(),
            ..Default::default()
        };
        store
            .append(
                &mut s1,
                EventKind::Created {
                    graph: Graph {
                        original_goal: "初始规划目标".into(),
                        nodes: vec![],
                        edges: vec![],
                    },
                    config: test_config(&repo_str),
                    planning_id: Some(pid_old.clone()),
                    planning: Some(PlanningSummary {
                        planning_id: pid_old.clone(),
                        goal: Some("初始规划目标".into()),
                        ..Default::default()
                    }),
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::PlannerSteerSubmitted {
                    planning_id: pid_old.clone(),
                    request_id: "p-req-withdrawn".into(),
                    instruction: "撤回的规划插话".into(),
                    images: None,
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::PlannerSteerStatus {
                    planning_id: pid_old.clone(),
                    request_id: "p-req-withdrawn".into(),
                    status: "withdrawn".into(),
                    error: None,
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::PlannerConversationEdited {
                    old_instruction: "初始规划目标".into(),
                    instruction: "编辑后的规划目标".into(),
                    first_turn: true,
                    selected_version: None,
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::GraphRevised {
                    graph: Graph {
                        original_goal: "编辑后的规划目标".into(),
                        nodes: vec![],
                        edges: vec![],
                    },
                    planning_id: pid_new.clone(),
                    planning: PlanningSummary {
                        planning_id: pid_new.clone(),
                        goal: Some("编辑后的规划目标".into()),
                        ..Default::default()
                    },
                    invalidated: vec![],
                    source_head: None,
                },
            )
            .unwrap();

        let old_dir = root.join("planning").join(&pid_old);
        fs::create_dir_all(&old_dir).unwrap();
        fs::write(
            old_dir.join("planner.jsonl"),
            r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"被放弃的旧规划回复"}]}}"#,
        )
        .unwrap();

        // Include invalid UTF-8 bytes in an earlier tool output line before a valid assistant reply!
        let new_dir = root.join("planning").join(&pid_new);
        fs::create_dir_all(&new_dir).unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"{\"type\":\"tool_execution_end\",\"result\":\"");
        bytes.extend_from_slice(&[0xff, 0xfe]);
        bytes.extend_from_slice(b"\"}\n");
        bytes.extend_from_slice(
            r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"UTF8恢复后的新规划回复"}]}}"#.as_bytes(),
        );
        bytes.push(b'\n');
        fs::write(new_dir.join("planner.jsonl"), bytes).unwrap();

        // Withdrawn planner steer must NOT match
        assert!(search_workspace_root(root, &repo_str, "撤回的规划插话", RoleFilter::All, 50)
            .unwrap()
            .matches
            .is_empty());

        // Abandoned old planner goal & reply must NOT match
        assert!(search_workspace_root(root, &repo_str, "初始规划目标", RoleFilter::All, 50)
            .unwrap()
            .matches
            .is_empty());
        assert!(search_workspace_root(root, &repo_str, "被放弃的旧规划回复", RoleFilter::All, 50)
            .unwrap()
            .matches
            .is_empty());

        // New edited planner goal & reply after invalid UTF-8 line MUST match
        assert_eq!(
            search_workspace_root(root, &repo_str, "编辑后的规划目标", RoleFilter::All, 50)
                .unwrap()
                .matches
                .len(),
            1
        );
        assert_eq!(
            search_workspace_root(root, &repo_str, "UTF8恢复后的新规划回复", RoleFilter::All, 50)
                .unwrap()
                .matches
                .len(),
            1
        );

        // Ordinary path text mentioning attachment-inputs without UUID is preserved
        assert_eq!(
            clean_user_message("检查 @/foo/attachment-inputs/bar 路径"),
            "检查 @/foo/attachment-inputs/bar 路径"
        );

        crate::store::forget_catalog(&db);
    }

    #[test]
    fn search_refreshes_logs_after_an_unrelated_query_observes_the_database_change() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let db = root.join("events.sqlite");
        let store = Store::open(&db).unwrap();
        let repo = root.join("workspace").to_string_lossy().into_owned();
        let mut state = Snapshot {
            run_id: "cache-invalidation".into(),
            ..Default::default()
        };
        store
            .append(
                &mut state,
                EventKind::Created {
                    graph: Graph {
                        original_goal: "user goal".into(),
                        nodes: vec![Node {
                            id: "task".into(),
                            task: "work".into(),
                        }],
                        edges: vec![],
                    },
                    config: test_config(&repo),
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();
        let mut execution = test_execution("live", "task", 1, None);
        execution.status = "running".into();
        store
            .append(
                &mut state,
                EventKind::Started {
                    execution,
                    message_sequences: None,
                    fresh_restart: false,
                },
            )
            .unwrap();
        let output = |text: &str| EventKind::Output {
            execution_id: "live".into(),
            text: format!(
                "{}\n",
                serde_json::json!({
                    "type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}
                })
            ),
        };
        store.append(&mut state, output("initial reply")).unwrap();
        assert_eq!(
            search_workspace_root(root, &repo, "initial reply", RoleFilter::Assistant, 10)
                .unwrap()
                .matches
                .len(),
            1
        );
        store.append(&mut state, output("new reply")).unwrap();

        // A user-only query syncs the shared DB version without reading any
        // assistant logs. It must not validate their older cached contents.
        assert_eq!(
            search_workspace_root(root, &repo, "user goal", RoleFilter::User, 10)
                .unwrap()
                .matches
                .len(),
            1
        );
        assert_eq!(
            search_workspace_root(root, &repo, "new reply", RoleFilter::Assistant, 10)
                .unwrap()
                .matches
                .len(),
            1
        );
        forget_search_index(&db);
        crate::store::forget_catalog(&db);
    }

    #[test]
    fn search_refreshes_final_planner_output_after_a_user_only_query() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let db = root.join("events.sqlite");
        let store = Store::open(&db).unwrap();
        let repo = root.join("workspace").to_string_lossy().into_owned();
        let id = "11111111-1111-4111-8111-111111111111";
        let mut planning = PlanningSummary {
            planning_id: id.into(),
            goal: Some("user goal".into()),
            status: Some("running".into()),
            ..Default::default()
        };
        let mut state = Snapshot {
            run_id: "planner-cache-invalidation".into(),
            ..Default::default()
        };
        store
            .append(
                &mut state,
                EventKind::PlanningStarted {
                    goal: "user goal".into(),
                    config: test_config(&repo),
                    planning: planning.clone(),
                    plan_type: None,
                },
            )
            .unwrap();
        let log = root.join("planning").join(id).join("planner.jsonl");
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        fs::write(&log, "").unwrap();
        assert!(
            search_workspace_root(root, &repo, "final reply", RoleFilter::Assistant, 10)
                .unwrap()
                .matches
                .is_empty()
        );
        fs::write(&log, "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"final reply\"}]}}\n").unwrap();
        planning.status = Some("completed".into());
        store
            .append(
                &mut state,
                EventKind::Created {
                    graph: Graph {
                        original_goal: "user goal".into(),
                        ..Default::default()
                    },
                    config: test_config(&repo),
                    planning_id: Some(id.into()),
                    planning: Some(planning),
                },
            )
            .unwrap();
        assert_eq!(
            search_workspace_root(root, &repo, "user goal", RoleFilter::User, 10)
                .unwrap()
                .matches
                .len(),
            1
        );
        assert_eq!(
            search_workspace_root(root, &repo, "final reply", RoleFilter::Assistant, 10)
                .unwrap()
                .matches
                .len(),
            1
        );
        forget_search_index(&db);
        crate::store::forget_catalog(&db);
    }

    #[test]
    fn search_handles_followup_planner_edit_review_exclusion_and_pagination_order() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let db = root.join("events.sqlite");
        let store = Store::open(&db).unwrap();

        let repo = temp.path().join("workspace-f");
        fs::create_dir_all(&repo).unwrap();
        let repo_str = repo.to_string_lossy().to_string();

        let pid1 = "55555555-5555-5555-5555-555555555555".to_string();
        let pid2_old = "66666666-6666-6666-6666-666666666666".to_string();
        let pid2_new = "77777777-7777-7777-7777-777777777777".to_string();
        let pid_review = "88888888-8888-8888-8888-888888888888".to_string();

        let mut s1 = Snapshot {
            run_id: "run-f-older".into(),
            ..Default::default()
        };
        store
            .append(
                &mut s1,
                EventKind::Created {
                    graph: Graph {
                        original_goal: "共同关键词 第一轮目标".into(),
                        nodes: vec![],
                        edges: vec![],
                    },
                    config: test_config(&repo_str),
                    planning_id: Some(pid1.clone()),
                    planning: Some(PlanningSummary {
                        planning_id: pid1.clone(),
                        goal: Some("共同关键词 第一轮目标".into()),
                        ..Default::default()
                    }),
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::GraphRevised {
                    graph: Graph {
                        original_goal: "共同关键词 第一轮目标".into(),
                        nodes: vec![],
                        edges: vec![],
                    },
                    planning_id: pid2_old.clone(),
                    planning: PlanningSummary {
                        planning_id: pid2_old.clone(),
                        goal: Some("被替换的第二轮追问".into()),
                        ..Default::default()
                    },
                    invalidated: vec![],
                    source_head: None,
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::PlannerConversationEdited {
                    old_instruction: "被替换的第二轮追问".into(),
                    instruction: "新的第二轮追问".into(),
                    first_turn: false,
                    selected_version: None,
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::GraphRevised {
                    graph: Graph {
                        original_goal: "共同关键词 第一轮目标".into(),
                        nodes: vec![],
                        edges: vec![],
                    },
                    planning_id: pid2_new.clone(),
                    planning: PlanningSummary {
                        planning_id: pid2_new.clone(),
                        goal: Some("新的第二轮追问".into()),
                        ..Default::default()
                    },
                    invalidated: vec![],
                    source_head: None,
                },
            )
            .unwrap();
        store
            .append(
                &mut s1,
                EventKind::PlannerReviewStarted {
                    planning: PlanningSummary {
                        planning_id: pid_review.clone(),
                        goal: Some("automated_review_goal_ignored".into()),
                        ..Default::default()
                    },
                },
            )
            .unwrap();

        for (pid, reply) in [
            (&pid1, "保留的第一轮规划回复"),
            (&pid2_old, "被放弃的第二轮规划回复"),
            (&pid2_new, "生效的新第二轮规划回复"),
            (&pid_review, "复核阶段纯文字结论"),
        ] {
            let dir = root.join("planning").join(pid);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("planner.jsonl"),
                format!(
                    r#"{{"type":"message_end","message":{{"role":"assistant","content":[{{"type":"text","text":"{reply}"}}]}}}}"#
                ),
            )
            .unwrap();
        }

        // Second newer conversation in the same workspace
        let mut s2 = Snapshot {
            run_id: "run-f-newer".into(),
            ..Default::default()
        };
        store
            .append(
                &mut s2,
                EventKind::Created {
                    graph: Graph {
                        original_goal: "共同关键词 最新会话".into(),
                        nodes: vec![Node {
                            id: "task".into(),
                            task: "共同关键词 最新会话".into(),
                        }],
                        edges: vec![],
                    },
                    config: test_config(&repo_str),
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();

        // Turn 1 retained, old follow-up dropped, new follow-up retained
        assert_eq!(
            search_workspace_root(root, &repo_str, "保留的第一轮规划回复", RoleFilter::All, 50)
                .unwrap()
                .matches
                .len(),
            1
        );
        assert!(
            search_workspace_root(root, &repo_str, "被替换的第二轮追问", RoleFilter::All, 50)
                .unwrap()
                .matches
                .is_empty()
        );
        assert!(
            search_workspace_root(root, &repo_str, "被放弃的第二轮规划回复", RoleFilter::All, 50)
                .unwrap()
                .matches
                .is_empty()
        );
        assert_eq!(
            search_workspace_root(root, &repo_str, "新的第二轮追问", RoleFilter::All, 50)
                .unwrap()
                .matches
                .len(),
            1
        );
        assert_eq!(
            search_workspace_root(root, &repo_str, "生效的新第二轮规划回复", RoleFilter::All, 50)
                .unwrap()
                .matches
                .len(),
            1
        );

        // Automated review goal is ignored as user text, while its assistant reply is searchable
        assert!(
            search_workspace_root(root, &repo_str, "automated_review_goal_ignored", RoleFilter::All, 50)
                .unwrap()
                .matches
                .is_empty()
        );
        assert_eq!(
            search_workspace_root(root, &repo_str, "复核阶段纯文字结论", RoleFilter::Assistant, 50)
                .unwrap()
                .matches
                .len(),
            1
        );

        // Newest-first ordering & limit/truncated truthfulness
        let limited = search_workspace_root(root, &repo_str, "共同关键词", RoleFilter::All, 1).unwrap();
        assert_eq!(limited.matches.len(), 1);
        assert_eq!(limited.matches[0].run_id, "run-f-newer");
        assert!(limited.truncated);

        let all = search_workspace_root(root, &repo_str, "共同关键词", RoleFilter::All, 10).unwrap();
        assert_eq!(all.matches.len(), 2);
        assert_eq!(all.matches[0].run_id, "run-f-newer");
        assert_eq!(all.matches[1].run_id, "run-f-older");
        assert!(!all.truncated);

        // Verify incremental cache picks up newly appended execution logs and planner.jsonl writes
        let res_before = search_workspace_root(root, &repo_str, "增量追加新回复", RoleFilter::All, 10).unwrap();
        assert!(res_before.matches.is_empty());

        store
            .append(
                &mut s2,
                EventKind::Started {
                    execution: test_execution("exec-f-live", "task", 1000, None),
                    message_sequences: None,
                    fresh_restart: false,
                },
            )
            .unwrap();
        store
            .append(
                &mut s2,
                EventKind::Output {
                    execution_id: "exec-f-live".into(),
                    text: "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"这是增量追加新回复内容\"}]}}\n".into(),
                },
            )
            .unwrap();
        let res_after = search_workspace_root(root, &repo_str, "增量追加新回复", RoleFilter::All, 10).unwrap();
        assert_eq!(res_after.matches.len(), 1);
        assert_eq!(res_after.matches[0].run_id, "run-f-newer");
        assert_eq!(res_after.matches[0].snippet_match, "增量追加新回复");

        forget_search_index(&db);
        crate::store::forget_catalog(&db);
    }

    #[test]
    fn unicode_and_ascii_case_insensitive_snippets_preserve_original_case() {
        assert_eq!(
            find_match_snippet("前文 ΟΣ τέλος", "ος").unwrap(),
            ("前文 ".into(), "ΟΣ".into(), " τέλος".into())
        );
        assert_eq!(
            find_match_snippet("字İSTANBUL后", "字i\u{307}stanbul")
                .unwrap()
                .1,
            "字İSTANBUL"
        );
        let needle = format!("{}z", "a".repeat(4095));
        let text = format!("{}{}", "A".repeat(100_000), needle.to_uppercase());
        assert_eq!(
            find_case_insensitive_range(&text, &needle, false),
            Some((100_000, 104_096))
        );
        assert_eq!(
            find_case_insensitive_range(&"A".repeat(100_000), &needle, false),
            None
        );
        let (before, matched, after) =
            find_match_snippet("Hello   İstanbul   WORLD!", "world").unwrap();
        assert_eq!(before, "Hello İstanbul ");
        assert_eq!(matched, "WORLD");
        assert_eq!(after, "!");

        let (before, matched, after) = find_match_snippet("前文内容 测试Mixed关键词 后文内容", "测试mixed").unwrap();
        assert_eq!(before, "前文内容 ");
        assert_eq!(matched, "测试Mixed");
        assert_eq!(after, "关键词 后文内容");
    }
}
