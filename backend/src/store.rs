use crate::model::{apply, now, Event, EventKind, Snapshot};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    path::Path,
    sync::{Mutex, MutexGuard, OnceLock},
};

mod append;
mod cleanup;
mod conversations;
mod logs;
#[cfg(test)]
pub(crate) use conversations::forget_catalog;
pub use conversations::{conversation_summaries, ConversationCatalog, ConversationSummary};
pub use logs::LogPage;
/// Breaking persisted-format boundary. Unversioned databases belong to older releases.
pub(crate) const FORMAT_VERSION: i64 = 1;
const CHECKPOINT_INTERVAL: usize = 128;

static STORE_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn store_write_guard() -> Result<MutexGuard<'static, ()>, String> {
    STORE_WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|error| error.to_string())
}

/// Serde tag of an event, stored as a column so maintenance and compaction can
/// filter without parsing the payload it is stored next to.
fn event_kind_name(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::PlanningStarted { .. } => "planning_started",
        EventKind::PlanningFailed { .. } => "planning_failed",
        EventKind::PlannerReviewStarted { .. } => "planner_review_started",
        EventKind::PlannerReviewProgress { .. } => "planner_review_progress",
        EventKind::PlannerPreviewProgress { .. } => "planner_preview_progress",
        EventKind::PlannerTurnProgress { .. } => "planner_turn_progress",
        EventKind::PlannerSteerSubmitted { .. } => "planner_steer_submitted",
        EventKind::PlannerSteerStatus { .. } => "planner_steer_status",
        EventKind::PlannerReviewFinished { .. } => "planner_review_finished",
        EventKind::PlannerTurnAborted { .. } => "planner_turn_aborted",
        EventKind::PlannerWorkspaceSelected { .. } => "planner_workspace_selected",
        EventKind::PlannerReworkNoteInjected => "planner_rework_note_injected",
        EventKind::PlannerWorkspaceRedirected { .. } => "planner_workspace_redirected",
        EventKind::PlannerWorkspaceSnapshotted { .. } => "planner_workspace_snapshotted",
        EventKind::Created { .. } => "created",
        EventKind::Routed { .. } => "routed",
        EventKind::Approved { .. } => "approved",
        EventKind::WorkspaceIsolationSelected { .. } => "workspace_isolation_selected",
        EventKind::WorkspaceIsolationRequested => "workspace_isolation_requested",
        EventKind::PrivateBatchSelected { .. } => "private_batch_selected",
        EventKind::ExecutionBatchStarted { .. } => "execution_batch_started",
        EventKind::BatchHandoffRequested { .. } => "batch_handoff_requested",
        EventKind::SharedWorkspaceReviewRequested { .. } => "shared_workspace_review_requested",
        EventKind::SourceSnapshotted { .. } => "source_snapshotted",
        EventKind::EnvironmentPolicyRequested => "environment_policy_requested",
        EventKind::EnvironmentPolicyResolved { .. } => "environment_policy_resolved",
        EventKind::EnvironmentInitialized { .. } => "environment_initialized",
        EventKind::ExecutionInputRecorded { .. } => "execution_input_recorded",
        EventKind::ExecutionResultRecorded { .. } => "execution_result_recorded",
        EventKind::ResultPublished { .. } => "result_published",
        EventKind::ResultExecutionStarted { .. } => "result_execution_started",
        EventKind::ResultExecutionPrepared { .. } => "result_execution_prepared",
        EventKind::ResultExecutionFinished { .. } => "result_execution_finished",
        EventKind::ResultExecutionFailed { .. } => "result_execution_failed",
        EventKind::GraphRevised { .. } => "graph_revised",
        EventKind::ManualGraphRevised { .. } => "manual_graph_revised",
        EventKind::NodeTaskUpdated { .. } => "node_task_updated",
        EventKind::DraftEdited { .. } => "draft_edited",
        EventKind::ConversationRenamed { .. } => "conversation_renamed",
        EventKind::Paused { .. } => "paused",
        EventKind::NodeModelOverrideUpdated { .. } => "node_model_override_updated",
        EventKind::ConversationModelsUpdated { .. } => "conversation_models_updated",
        EventKind::RecoveryQueued { .. } => "recovery_queued",
        EventKind::StopRequested => "stop_requested",
        EventKind::ExecutionStopRequested { .. } => "execution_stop_requested",
        EventKind::Rejected => "rejected",
        EventKind::Started { .. } => "started",
        EventKind::Prepared { .. } => "prepared",
        EventKind::NodeInputBound { .. } => "node_input_bound",
        EventKind::Steered { .. } => "steered",
        EventKind::SteersWithdrawn { .. } => "steers_withdrawn",
        EventKind::QueueWithdrawalRecorded { .. } => "queue_withdrawal_recorded",
        EventKind::NodeMessaged { .. } => "node_messaged",
        EventKind::Output { .. } => "output",
        EventKind::Finished { .. } => "finished",
        EventKind::Failed { .. } => "failed",
        EventKind::Blocked { .. } => "blocked",
        EventKind::WorkspaceResolved { .. } => "workspace_resolved",
        EventKind::Invalidated { .. } => "invalidated",
        EventKind::FeedbackContinuationQueued { .. } => "feedback_continuation_queued",
        EventKind::ConversationEdited { .. } => "conversation_edited",
        EventKind::PlannerConversationEdited { .. } => "planner_conversation_edited",
        EventKind::FeedbackQueued { .. } => "feedback_queued",
        EventKind::FeedbackResolved { .. } => "feedback_resolved",
        EventKind::Feedback { .. } => "feedback",
        EventKind::FeedbackExhausted { .. } => "feedback_exhausted",
        EventKind::PublicationStarted { .. } => "publication_started",
        EventKind::PublicationCompleted { .. } => "publication_completed",
        EventKind::PublicationFailed { .. } => "publication_failed",
        EventKind::MergerStarted { .. } => "merger_started",
        EventKind::MergerFinished { .. } => "merger_finished",
        EventKind::MergerFailed { .. } => "merger_failed",
        EventKind::Settled => "settled",
    }
}

fn event_execution_id(kind: &EventKind) -> Option<&str> {
    match kind {
        EventKind::Started { execution, .. } | EventKind::MergerStarted { execution } => {
            Some(&execution.id)
        }
        EventKind::Prepared { execution_id, .. }
        | EventKind::NodeInputBound { execution_id, .. }
        | EventKind::ExecutionInputRecorded { execution_id, .. }
        | EventKind::ExecutionResultRecorded { execution_id, .. }
        | EventKind::PlannerWorkspaceSnapshotted { execution_id, .. }
        | EventKind::Steered { execution_id, .. }
        | EventKind::SteersWithdrawn { execution_id, .. }
        | EventKind::Output { execution_id, .. }
        | EventKind::Finished { execution_id, .. }
        | EventKind::FeedbackExhausted { execution_id, .. }
        | EventKind::FeedbackResolved { execution_id, .. }
        | EventKind::WorkspaceResolved { execution_id, .. }
        | EventKind::MergerFinished { execution_id, .. }
        | EventKind::MergerFailed { execution_id, .. } => Some(execution_id),
        EventKind::Failed { execution_id, .. } => execution_id.as_deref(),
        EventKind::ResultExecutionStarted { input, .. } => Some(&input.generation),
        EventKind::ResultExecutionFinished { descriptor } => Some(&descriptor.result.generation),
        EventKind::ResultExecutionFailed { generation, .. } => Some(generation),
        _ => None,
    }
}

fn created_planning_ids(kind: &EventKind) -> (Option<&str>, Option<&str>) {
    match kind {
        EventKind::Created {
            planning_id,
            planning,
            ..
        } => (
            planning_id.as_deref(),
            planning.as_ref().map(|p| p.planning_id.as_str()),
        ),
        EventKind::PlanningStarted { planning, .. }
        | EventKind::PlanningFailed { planning }
        | EventKind::PlannerReviewStarted { planning }
        | EventKind::PlannerReviewFinished { planning, .. }
        | EventKind::PlannerTurnAborted { planning }
        | EventKind::GraphRevised { planning, .. } => (Some(&planning.planning_id), None),
        _ => (None, None),
    }
}

fn database_version(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

fn incompatible_version(connection: &Connection) -> Result<Option<i64>, String> {
    let version = database_version(connection)?;
    if version == FORMAT_VERSION {
        return Ok(None);
    }
    let objects: i64 = connection
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok((version != 0 || objects != 0).then_some(version))
}

/// Startup may select a separate directory for a known incompatible format.
/// Permission/I/O/corruption errors stay errors; probing never initializes it.
pub(crate) fn incompatible_database_version(path: &Path) -> Result<Option<i64>, String> {
    if !path.try_exists().map_err(|error| error.to_string())? {
        return Ok(None);
    }
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    incompatible_version(&connection)
}

fn unsupported_database(version: i64) -> String {
    format!(
        "Unsupported Grapher database format {version}; use a new data directory for this release"
    )
}

pub(super) fn validate_database(connection: &Connection) -> Result<(), String> {
    let version = database_version(connection)?;
    if version != FORMAT_VERSION {
        return Err(unsupported_database(version));
    }
    connection.prepare("SELECT sequence,run_id,timestamp,payload,planning_id,nested_planning_id,kind,execution_id FROM events LIMIT 0")
        .map_err(|e| format!("Invalid current Grapher database schema: {e}"))?;
    let selected: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workspace_selection WHERE id=1)",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !selected {
        return Err("Missing explicit workspace selection state".into());
    }
    Ok(())
}

pub struct Store {
    connection: Connection,
    // Output batches count toward projection checkpoint cadence without ever
    // creating rows in the business event log.
    appended_since_checkpoint: Cell<usize>,
    execution_offsets: RefCell<HashMap<String, usize>>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        let _write_guard = store_write_guard()?;
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        if let Some(version) = incompatible_version(&connection)? {
            return Err(unsupported_database(version));
        }
        if database_version(&connection)? == FORMAT_VERSION {
            validate_database(&connection)?;
        }
        connection
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(|error| error.to_string())?;
        connection.execute_batch("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS execution_logs (
                run_id TEXT NOT NULL, execution_id TEXT NOT NULL, offset INTEGER NOT NULL,
                bytes INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(execution_id, offset)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS idx_exec_logs_run ON execution_logs(run_id);
            CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL, planning_id TEXT, nested_planning_id TEXT, kind TEXT NOT NULL, execution_id TEXT);
            CREATE INDEX IF NOT EXISTS events_run ON events(run_id, sequence);
            CREATE TABLE IF NOT EXISTS checkpoints (run_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS workspace_selection (id INTEGER PRIMARY KEY CHECK(id=1), run_id TEXT);
            CREATE TABLE IF NOT EXISTS deleted_runs (run_id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS run_owned_directories (run_id TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY(run_id,target));
            CREATE INDEX IF NOT EXISTS run_owned_target ON run_owned_directories(target,run_id);
            CREATE TABLE IF NOT EXISTS cleanup_tasks (run_id TEXT PRIMARY KEY, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
            CREATE TABLE IF NOT EXISTS workspace_cleanup_done (run_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS detached_workspaces (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cleanup_sources (path TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS cleanup_state (key TEXT PRIMARY KEY);
            INSERT OR IGNORE INTO workspace_selection(id,run_id) VALUES(1,NULL);
            CREATE INDEX IF NOT EXISTS events_planning_id ON events(planning_id) WHERE planning_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS events_nested_planning_id ON events(nested_planning_id) WHERE nested_planning_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS events_execution ON events(execution_id,kind);
            PRAGMA user_version=1;
            COMMIT;")
            .map_err(|error| error.to_string())?;
        Ok(Self {
            connection,
            appended_since_checkpoint: Cell::new(0),
            execution_offsets: RefCell::new(HashMap::new()),
        })
    }

    /// Independent read-only connection for cold log projection. No schema
    /// setup, write transaction, or Runtime mutex is needed for these reads.
    pub(crate) fn open_reader(path: &Path) -> Result<Self, String> {
        Self::open_existing(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    }

    fn open_existing(path: &Path, flags: rusqlite::OpenFlags) -> Result<Self, String> {
        let connection =
            Connection::open_with_flags(path, flags).map_err(|error| error.to_string())?;
        validate_database(&connection)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(|error| error.to_string())?;
        Ok(Self {
            connection,
            appended_since_checkpoint: Cell::new(0),
            execution_offsets: RefCell::new(HashMap::new()),
        })
    }

    pub fn append(&self, state: &mut Snapshot, kind: EventKind) -> Result<(), String> {
        self.append_events(state, vec![kind])
    }

    /// Logs, business events and their derived projections commit together.
    pub fn append_batch(
        &mut self,
        state: &mut Snapshot,
        kinds: Vec<EventKind>,
    ) -> Result<(), String> {
        self.append_events(state, kinds)
    }

    /// Output writes also trigger checkpoints, retaining live pid/byte metadata.
    fn note_appended(&self, state: &Snapshot, count: usize) {
        let pending = self.appended_since_checkpoint.get() + count;
        if pending >= CHECKPOINT_INTERVAL {
            self.appended_since_checkpoint.set(0);
            self.save_checkpoint(state);
        } else {
            self.appended_since_checkpoint.set(pending);
        }
    }

    /// Rewrite the database without the freed pages. Requires exclusive access.
    pub fn vacuum(&self) -> Result<(), String> {
        let _write_guard = store_write_guard()?;
        self.connection
            .execute_batch(
                "PRAGMA auto_vacuum=INCREMENTAL; VACUUM; PRAGMA wal_checkpoint(TRUNCATE);",
            )
            .map_err(|error| error.to_string())
    }

    // Checkpoints are optional accelerators. A failed write must not report a
    // committed event as failed; load can always replay the event log instead.
    fn save_checkpoint(&self, state: &Snapshot) {
        if let Some(last) = state.events.last() {
            // Borrow the projection so checkpoint creation never clones the log.
            // Transcripts remain in execution_logs and are never replayed.
            let mut projection = crate::snapshot_view::checkpoint_projection(state);
            let checksum = serde_json::to_vec(&projection)
                .ok()
                .and_then(|bytes| git2::Oid::hash_object(git2::ObjectType::Blob, &bytes).ok());
            let Some(checksum) = checksum else {
                return;
            };
            projection["checksum"] = serde_json::json!(checksum.to_string());
            if let Ok(payload) = serde_json::to_string(&projection) {
                let _ = self.connection.execute(
                    "INSERT INTO checkpoints(run_id, sequence, payload) VALUES (?1, ?2, ?3)
                     ON CONFLICT(run_id) DO UPDATE SET sequence=excluded.sequence, payload=excluded.payload",
                    params![state.run_id, last.sequence, payload],
                );
            }
        }
    }

    /// Selection is explicit, including an empty workspace.
    pub fn selected_run(&self) -> Result<Option<String>, String> {
        self.connection
            .query_row(
                "SELECT run_id FROM workspace_selection WHERE id=1",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }

    pub fn select_run(&self, run_id: Option<&str>) -> Result<(), String> {
        let _write_guard = store_write_guard()?;
        self.connection.execute(
            "INSERT INTO workspace_selection(id,run_id) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id",
            [run_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn run_was_deleted(&self, run_id: &str) -> Result<bool, String> {
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM deleted_runs WHERE run_id=?1)",
                [run_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    }

    pub fn deleted_runs(&self) -> Result<Vec<String>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT run_id FROM deleted_runs")
            .map_err(|error| error.to_string())?;
        let runs = statement
            .query_map([], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(runs)
    }

    pub(crate) fn run_for_execution(&self, execution_id: &str) -> Result<Option<String>, String> {
        self.connection.query_row(
            "SELECT run_id FROM events WHERE execution_id=?1 AND kind IN ('started','merger_started') ORDER BY sequence LIMIT 1",
            [execution_id], |row| row.get(0),
        ).optional().map_err(|e| e.to_string())
    }

    pub fn run_for_planning_id(&self, planning_id: &str) -> Result<Option<String>, String> {
        self.connection.query_row(
            "SELECT run_id FROM events WHERE planning_id=?1 OR nested_planning_id=?1 ORDER BY sequence DESC LIMIT 1",
            [planning_id], |row| row.get(0),
        ).optional().map_err(|e| e.to_string())
    }

    pub fn contains_run(&self, run_id: &str) -> Result<bool, String> {
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM events WHERE run_id=?1)",
                [run_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }

    pub fn runs(&self) -> Result<Vec<String>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT run_id FROM events GROUP BY run_id ORDER BY MAX(sequence) DESC")
            .map_err(|error| error.to_string())?;
        let runs = statement
            .query_map([], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|error| error.to_string());
        runs
    }

    pub fn has_other_run_for_repository(
        &self,
        excluded_run_id: &str,
        repository: &Path,
    ) -> Result<bool, String> {
        let run_ids = self
            .runs()?
            .into_iter()
            .filter(|run_id| run_id != excluded_run_id)
            .collect::<Vec<_>>();
        for run_id in run_ids {
            let state = self.load(&run_id)?;
            let Some(config) = state.config else {
                continue;
            };
            let candidate = Path::new(&config.repository);
            if candidate == repository
                || candidate
                    .canonicalize()
                    .is_ok_and(|canonical| canonical == repository)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn load(&self, run_id: &str) -> Result<Snapshot, String> {
        if !self.contains_run(run_id)? {
            return Err(format!("Run does not exist: {run_id}"));
        }
        let checkpoint = self
            .connection
            .query_row(
                "SELECT c.sequence, c.payload FROM checkpoints c
                 WHERE c.run_id=?1 AND EXISTS(
                     SELECT 1 FROM events e WHERE e.run_id=c.run_id AND e.sequence=c.sequence
                 )",
                [run_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .ok()
            .and_then(|(sequence, payload)| {
                let mut value: serde_json::Value = serde_json::from_str(&payload).ok()?;
                if value["formatVersion"] != 1 {
                    return None;
                }
                let checksum = value.as_object_mut()?.remove("checksum")?;
                let bytes = serde_json::to_vec(&value).ok()?;
                let expected = git2::Oid::hash_object(git2::ObjectType::Blob, &bytes).ok()?;
                if checksum.as_str() != Some(expected.to_string().as_str()) {
                    return None;
                }
                serde_json::from_str::<Snapshot>(&payload)
                    .ok()
                    .filter(|state| {
                        state.run_id == run_id
                            && (state.events.is_empty()
                                || state.events.last().map(|e| e.sequence) == Some(sequence))
                    })
                    .map(|state| (sequence, state))
            });
        let (sequence, mut state) = checkpoint.unwrap_or_else(|| {
            (
                0,
                Snapshot {
                    run_id: run_id.into(),
                    ..Snapshot::default()
                },
            )
        });
        state.events.clear();
        for execution in state.executions.iter_mut().chain(state.mergers.iter_mut()) {
            execution.output.clear();
        }
        let mut statement = self
            .connection
            .prepare(
                "SELECT sequence, timestamp, payload FROM events WHERE run_id=?1 ORDER BY sequence",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([run_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (event_sequence, timestamp, payload) = row.map_err(|error| error.to_string())?;
            let kind = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
            let event = Event {
                sequence: event_sequence,
                timestamp,
                kind,
            };
            if event_sequence > sequence {
                apply(&mut state, &event);
            } else {
                state.events.push(event);
            }
        }
        state.rebuild_planning_turns();
        state.backfill_consumed_tokens();
        for execution in state.executions.iter_mut().chain(state.mergers.iter_mut()) {
            execution.output_bytes = execution
                .output_bytes
                .max(self.log_bytes(run_id, &execution.id)?);
            execution.output = String::new();
        }
        state.run_metrics = Some(state.compute_run_metrics());
        Ok(state)
    }

    pub fn delete_run(&self, run_id: &str) -> Result<(), String> {
        self.delete_run_with_cleanup(run_id, None)
    }

    pub fn delete_run_with_cleanup(
        &self,
        run_id: &str,
        cleanup: Option<&crate::cleanup::Manifest>,
    ) -> Result<(), String> {
        self.delete_runs([(run_id, cleanup)])
    }

    /// A workspace removal deletes every conversation in one transaction, not
    /// a partially successful loop of independent conversation deletions.
    pub fn delete_runs_with_cleanup(
        &self,
        cleanups: &[(String, crate::cleanup::Manifest)],
    ) -> Result<(), String> {
        self.delete_runs(
            cleanups
                .iter()
                .map(|(id, manifest)| (id.as_str(), Some(manifest))),
        )
    }

    fn delete_runs<'a>(
        &self,
        runs: impl IntoIterator<Item = (&'a str, Option<&'a crate::cleanup::Manifest>)>,
    ) -> Result<(), String> {
        let _write_guard = store_write_guard()?;
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let mut deleted = Vec::new();
        for (run_id, cleanup) in runs {
            // Ownership and tombstones commit with ALL event/log deletions.
            // A crash or locked file after commit cannot orphan cleanup.
            if let Some(cleanup) = cleanup {
                self.insert_cleanup(&tx, run_id, cleanup)?;
            }
            tx.execute(
                "INSERT OR IGNORE INTO deleted_runs(run_id) VALUES(?1)",
                [run_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE workspace_selection SET run_id=NULL WHERE run_id=?1",
                [run_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM checkpoints WHERE run_id=?1", [run_id])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM events WHERE run_id=?1", [run_id])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM execution_logs WHERE run_id=?1", [run_id])
                .map_err(|e| e.to_string())?;
            deleted.push(run_id);
        }
        tx.commit().map_err(|e| e.to_string())?;
        for run_id in deleted {
            crate::file_changes::invalidate_run(run_id);
        }
        self.execution_offsets.borrow_mut().clear();
        self.reclaim_deleted_pages();
        Ok(())
    }

    pub fn clear(&self) -> Result<(), String> {
        self.clear_with_cleanup(&[])
    }

    pub fn clear_with_cleanup(
        &self,
        cleanups: &[(String, crate::cleanup::Manifest)],
    ) -> Result<(), String> {
        let _write_guard = store_write_guard()?;
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        for (run_id, cleanup) in cleanups {
            self.insert_cleanup(&tx, run_id, cleanup)?;
            tx.execute(
                "INSERT OR IGNORE INTO deleted_runs(run_id) VALUES(?1)",
                [run_id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT OR IGNORE INTO deleted_runs(run_id) SELECT DISTINCT run_id FROM events",
            [],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO workspace_selection(id,run_id) VALUES(1,NULL) ON CONFLICT(id) DO UPDATE SET run_id=NULL", [])
            .map_err(|e| e.to_string())?;
        // Include newly tombstoned Runs and provisional cleanup owners, but
        // never invalidate live accumulators belonging to another data store.
        let cleared = self.deleted_runs()?;
        tx.execute("DELETE FROM checkpoints", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM events", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM execution_logs", [])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        for run_id in cleared {
            crate::file_changes::invalidate_run(&run_id);
        }
        self.execution_offsets.borrow_mut().clear();
        self.reclaim_deleted_pages();
        Ok(())
    }

    fn reclaim_deleted_pages(&self) {
        // Best effort after the delete commits: errors must not leave callers
        // believing a committed deletion failed (or retaining stale Services).
        let _ = self
            .connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        // rusqlite::execute_batch steps a row-producing PRAGMA only once.
        // incremental_vacuum yields after EACH reclaimed page, so consume it
        // fully. Bound work to 4096 pages (~16 MiB at the default page size)
        // to avoid a full VACUUM-sized lock alongside active Workers.
        if let Ok(mut statement) = self.connection.prepare("PRAGMA incremental_vacuum(4096)") {
            if let Ok(mut rows) = statement.query([]) {
                while let Ok(Some(_)) = rows.next() {}
            }
        }
        // Promote the truncation from WAL to the physical database file.
        let _ = self
            .connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
}
