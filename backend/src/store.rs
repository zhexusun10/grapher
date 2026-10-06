use crate::model::{apply, now, Event, EventKind, Snapshot};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    path::Path,
    sync::{Mutex, MutexGuard, OnceLock},
};

mod logs;
mod cleanup;
pub use logs::{LogPage, MigrationReport};
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
        EventKind::Created { .. } => "created",
        EventKind::Routed { .. } => "routed",
        EventKind::Approved { .. } => "approved",
        EventKind::SourceSnapshotted { .. } => "source_snapshotted",
        EventKind::GraphRevised { .. } => "graph_revised",
        EventKind::DraftEdited { .. } => "draft_edited",
        EventKind::Paused { .. } => "paused",
        EventKind::StopRequested => "stop_requested",
        EventKind::Rejected => "rejected",
        EventKind::Started { .. } => "started",
        EventKind::Prepared { .. } => "prepared",
        EventKind::Steered { .. } => "steered",
        EventKind::NodeMessaged { .. } => "node_messaged",
        EventKind::Output { .. } => "output",
        EventKind::Finished { .. } => "finished",
        EventKind::Failed { .. } => "failed",
        EventKind::Blocked { .. } => "blocked",
        EventKind::WorkspaceResolved { .. } => "workspace_resolved",
        EventKind::Invalidated { .. } => "invalidated",
        EventKind::ConversationEdited { .. } => "conversation_edited",
        EventKind::PlannerConversationEdited { .. } => "planner_conversation_edited",
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
        EventKind::Started { execution } | EventKind::MergerStarted { execution } => {
            Some(&execution.id)
        }
        EventKind::Prepared { execution_id, .. }
        | EventKind::Steered { execution_id, .. }
        | EventKind::Output { execution_id, .. }
        | EventKind::Finished { execution_id, .. }
        | EventKind::FeedbackExhausted { execution_id, .. }
        | EventKind::WorkspaceResolved { execution_id, .. }
        | EventKind::MergerFinished { execution_id, .. }
        | EventKind::MergerFailed { execution_id, .. } => Some(execution_id),
        EventKind::Failed { execution_id, .. } => execution_id.as_deref(),
        _ => None,
    }
}

fn created_planning_ids(kind: &EventKind) -> (Option<&str>, Option<&str>) {
    match kind {
        EventKind::Created { planning_id, planning, .. } => (
            planning_id.as_deref(),
            planning.as_ref().map(|p| p.planning_id.as_str()),
        ),
        EventKind::PlanningStarted { planning, .. }
        | EventKind::PlanningFailed { planning }
        | EventKind::GraphRevised { planning, .. } => (Some(&planning.planning_id), None),
        _ => (None, None),
    }
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
        connection
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(|error| error.to_string())?;
        connection.execute_batch("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS execution_logs (
                run_id TEXT NOT NULL, execution_id TEXT NOT NULL, offset INTEGER NOT NULL,
                bytes INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(execution_id, offset)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS idx_exec_logs_run ON execution_logs(run_id);
            CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL, planning_id TEXT, nested_planning_id TEXT, kind TEXT, execution_id TEXT);
            CREATE INDEX IF NOT EXISTS events_run ON events(run_id, sequence);
            CREATE TABLE IF NOT EXISTS checkpoints (run_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS workspace_selection (id INTEGER PRIMARY KEY CHECK(id=1), run_id TEXT);
            CREATE TABLE IF NOT EXISTS deleted_runs (run_id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS run_owned_directories (run_id TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY(run_id,target));
            CREATE INDEX IF NOT EXISTS run_owned_target ON run_owned_directories(target,run_id);
            CREATE TABLE IF NOT EXISTS cleanup_tasks (run_id TEXT PRIMARY KEY, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
            CREATE TABLE IF NOT EXISTS workspace_cleanup_done (run_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS cleanup_sources (path TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS cleanup_state (key TEXT PRIMARY KEY);")
            .map_err(|error| error.to_string())?;
        let columns = {
            let mut stmt = connection
                .prepare("PRAGMA table_info(events)")
                .map_err(|e| e.to_string())?;
            let columns = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            columns
        };
        // Schema change and backfill must commit together: a crash may not
        // leave a new column with an incomplete (and never retried) index.
        connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let missing_planning_id = !columns.iter().any(|column| column == "planning_id");
        let missing_nested_id = !columns.iter().any(|column| column == "nested_planning_id");
        let missing_kind = !columns.iter().any(|column| column == "kind");
        let missing_execution_id = !columns.iter().any(|column| column == "execution_id");
        if missing_planning_id {
            connection
                .execute_batch("ALTER TABLE events ADD COLUMN planning_id TEXT;")
                .map_err(|e| e.to_string())?;
        }
        if missing_nested_id {
            connection
                .execute_batch("ALTER TABLE events ADD COLUMN nested_planning_id TEXT;")
                .map_err(|e| e.to_string())?;
        }
        // `kind`/`execution_id` index rows as they are written. Existing rows
        // stay NULL until `Store::backfill_event_index` runs during `--compact`;
        // that keeps startup an O(1) schema change instead of an 800 MB rewrite.
        if missing_kind {
            connection
                .execute_batch("ALTER TABLE events ADD COLUMN kind TEXT;")
                .map_err(|e| e.to_string())?;
        }
        if missing_execution_id {
            connection
                .execute_batch("ALTER TABLE events ADD COLUMN execution_id TEXT;")
                .map_err(|e| e.to_string())?;
        }
        if missing_planning_id || missing_nested_id {
            let mut stmt = connection
                .prepare("SELECT sequence, payload FROM events WHERE payload LIKE '{\"type\":\"created\"%' AND (planning_id IS NULL OR nested_planning_id IS NULL)")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (sequence, payload) = row.map_err(|e| e.to_string())?;
                if let Ok(kind) = serde_json::from_str::<EventKind>(&payload) {
                    let (direct, nested) = created_planning_ids(&kind);
                    if direct.is_some() || nested.is_some() {
                        connection.execute("UPDATE events SET planning_id=?1, nested_planning_id=?2 WHERE sequence=?3",
                            params![direct, nested, sequence]).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        connection.execute_batch("CREATE INDEX IF NOT EXISTS events_planning_id ON events(planning_id) WHERE planning_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS events_nested_planning_id ON events(nested_planning_id) WHERE nested_planning_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS events_execution ON events(execution_id, kind);
            CREATE INDEX IF NOT EXISTS events_unindexed ON events(run_id,sequence) WHERE kind IS NULL;")
            .map_err(|e| e.to_string())?;
        connection
            .execute_batch("COMMIT")
            .map_err(|e| e.to_string())?;
        Ok(Self { connection, appended_since_checkpoint: Cell::new(0), execution_offsets: RefCell::new(HashMap::new()) })
    }

    pub fn append(&self, state: &mut Snapshot, mut kind: EventKind) -> Result<(), String> {
        if matches!(kind, EventKind::Output { .. }) {
            return self.append_logs(state, vec![kind]);
        }
        let _write_guard = store_write_guard()?;
        self.ensure_not_deleted(&state.run_id)?;
        if let EventKind::Finished { execution_id, output, output_bytes, metrics, .. } = &mut kind {
            if !output.is_empty() {
                let started = state.executions.iter().chain(&state.mergers)
                    .find(|e| e.id == *execution_id).map(|e| e.started_at).unwrap_or(0);
                *metrics = metrics.take().or_else(|| Some(crate::model::parse_execution_metrics(output, started, now())));
                *output_bytes = output.len();
                self.replace_logs(&state.run_id, execution_id, output)?;
                *output = String::new();
            }
        }
        let initial = if let EventKind::Started { execution } | EventKind::MergerStarted { execution } = &mut kind {
            if execution.output.is_empty() { None } else {
                let text = std::mem::take(&mut execution.output);
                self.replace_logs(&state.run_id, &execution.id, &text)?;
                execution.output_bytes = text.len();
                Some((execution.id.clone(), text))
            }
        } else { None };
        let timestamp = now();
        let payload = serde_json::to_string(&kind).map_err(|error| error.to_string())?;
        let (direct, nested) = created_planning_ids(&kind);
        let kind_name = event_kind_name(&kind);
        let execution_id = event_execution_id(&kind);
        self.connection
            .execute(
                "INSERT INTO events(run_id, timestamp, payload, planning_id, nested_planning_id, kind, execution_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![state.run_id, timestamp, payload, direct, nested, kind_name, execution_id],
            )
            .map_err(|error| error.to_string())?;
        let event = Event {
            sequence: self.connection.last_insert_rowid(),
            timestamp,
            kind,
        };
        apply(state, &event);
        if let Some((id, text)) = initial {
            if let Some(execution) = state.executions.iter_mut().chain(state.mergers.iter_mut()).find(|e| e.id == id) {
                crate::model::append_live_output(execution, &text);
            }
        }
        if matches!(event.kind, EventKind::Finished { .. } | EventKind::Failed { .. } | EventKind::MergerFinished { .. } | EventKind::MergerFailed { .. }) {
            if let Some(id) = event_execution_id(&event.kind) { self.forget_log_cursor(id); }
            self.save_checkpoint(state);
        }
        self.note_appended(state, 1);
        Ok(())
    }

    /// Persist a bounded batch atomically, then update the in-memory projection.
    /// Never expose output in memory if the transaction did not commit.
    pub fn append_batch(
        &mut self,
        state: &mut Snapshot,
        kinds: Vec<EventKind>,
    ) -> Result<(), String> {
        if kinds.iter().all(|kind| matches!(kind, EventKind::Output { .. })) {
            return self.append_logs(state, kinds);
        }
        if kinds.iter().any(|kind| matches!(kind, EventKind::Output { .. } | EventKind::Finished { .. } | EventKind::Started { .. } | EventKind::MergerStarted { .. })) {
            for kind in kinds { self.append(state, kind)?; }
            return Ok(());
        }
        let count = kinds.len();
        let _write_guard = store_write_guard()?;
        self.ensure_not_deleted(&state.run_id)?;
        let transaction = self.connection.transaction().map_err(|e| e.to_string())?;
        let mut events = Vec::with_capacity(count);
        for kind in kinds {
            let timestamp = now();
            let payload = serde_json::to_string(&kind).map_err(|e| e.to_string())?;
            let (direct, nested) = created_planning_ids(&kind);
            let kind_name = event_kind_name(&kind);
            let execution_id = event_execution_id(&kind);
            transaction.execute(
                "INSERT INTO events(run_id, timestamp, payload, planning_id, nested_planning_id, kind, execution_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![state.run_id, timestamp, payload, direct, nested, kind_name, execution_id],
            ).map_err(|e| e.to_string())?;
            events.push(Event {
                sequence: transaction.last_insert_rowid(),
                timestamp,
                kind,
            });
        }
        transaction.commit().map_err(|e| e.to_string())?;
        for event in events {
            apply(state, &event);
        }
        self.note_appended(state, count);
        Ok(())
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

    /// Backfill `kind`/`execution_id` for rows written before the columns
    /// existed. Only the explicit `--compact` command pays this full scan.
    pub fn backfill_event_index(&self) -> Result<usize, String> {
        let missing: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM events WHERE kind IS NULL)",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !missing {
            return Ok(0);
        }
        self.connection
            .execute(
                "UPDATE events SET
                    kind = CASE WHEN json_valid(payload)
                        THEN COALESCE(json_extract(payload,'$.type'), 'unknown') ELSE 'unknown' END,
                    execution_id = CASE WHEN json_valid(payload)
                        THEN COALESCE(json_extract(payload,'$.execution_id'), json_extract(payload,'$.execution.id'))
                        ELSE NULL END
                 WHERE kind IS NULL",
                [],
            )
            .map_err(|error| error.to_string())
    }

    /// Rewrite the database without the freed pages. Requires exclusive access.
    pub fn vacuum(&self) -> Result<(), String> {
        let _write_guard = store_write_guard()?;
        self.connection
            .execute_batch("PRAGMA auto_vacuum=INCREMENTAL; VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|error| error.to_string())
    }

    // Checkpoints are optional accelerators. A failed write must not report a
    // committed event as failed; load can always replay the event log instead.
    fn save_checkpoint(&self, state: &Snapshot) {
        if let Some(last) = state.events.last() {
            // Borrow the projection so checkpoint creation never clones the log.
            // Transcripts remain in execution_logs and are never replayed.
            let projection = crate::snapshot_view::checkpoint_projection(state);
            if let Ok(payload) = serde_json::to_string(&projection) {
                let _ = self.connection.execute(
                    "INSERT INTO checkpoints(run_id, sequence, payload) VALUES (?1, ?2, ?3)
                     ON CONFLICT(run_id) DO UPDATE SET sequence=excluded.sequence, payload=excluded.payload",
                    params![state.run_id, last.sequence, payload],
                );
            }
        }
    }

    /// Missing row: legacy database (select latest). NULL: explicitly empty workspace.
    pub fn selected_run(&self) -> Result<Option<String>, String> {
        let selection: Option<Option<String>> = self.connection.query_row(
            "SELECT run_id FROM workspace_selection WHERE id=1", [], |row| row.get(0),
        ).optional().map_err(|e| e.to_string())?;
        match selection {
            Some(run) => Ok(run),
            None => Ok(self.runs()?.into_iter().next()),
        }
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
        self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM deleted_runs WHERE run_id=?1)",
            [run_id], |row| row.get(0),
        ).map_err(|e| e.to_string())
    }

    pub fn deleted_runs(&self) -> Result<Vec<String>, String> {
        let mut statement = self.connection.prepare("SELECT run_id FROM deleted_runs")
            .map_err(|error| error.to_string())?;
        let runs = statement.query_map([], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        Ok(runs)
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
                // Never materialize a legacy transcript. Large `Finished`
                // payloads are replaced in SQL with a metadata-only object
                // built from the first 512 bytes; migrated rows are already
                // small and keep their structured metrics. `Output` chunks are
                // filtered by tag prefix, so an unmigrated database is opened
                // without parsing a single log payload.
                "SELECT sequence, timestamp,
                    CASE
                        WHEN (kind = 'finished'
                              OR (kind IS NULL AND substr(payload,1,18) = '{\"type\":\"finished\"'))
                             AND length(payload) > 4096
                             AND instr(substr(payload,1,512), '\"execution_id\":\"') > 0
                             AND instr(substr(payload,1,512), '\"head\":\"') > 0
                        THEN json_object('type','finished',
                            'execution_id', substr(payload,
                                instr(substr(payload,1,512), '\"execution_id\":\"') + 16,
                                instr(substr(payload, instr(substr(payload,1,512), '\"execution_id\":\"') + 16, 64), '\"') - 1),
                            'head', substr(payload,
                                instr(substr(payload,1,512), '\"head\":\"') + 8,
                                instr(substr(payload, instr(substr(payload,1,512), '\"head\":\"') + 8, 64), '\"') - 1),
                            'output', '', 'output_bytes', 0)
                        ELSE payload
                    END
                 FROM events WHERE run_id=?1
                    AND NOT (COALESCE(kind, '') = 'output'
                             OR (kind IS NULL AND substr(payload,1,16) = '{\"type\":\"output\"'))
                 ORDER BY sequence",
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
            let event = Event { sequence: event_sequence, timestamp, kind };
            if event_sequence > sequence {
                apply(&mut state, &event);
            } else {
                state.events.push(event);
            }
        }
        for execution in state.executions.iter_mut().chain(state.mergers.iter_mut()) {
            execution.output_bytes = execution.output_bytes.max(self.log_bytes(run_id, &execution.id)?);
            execution.output = String::new();
        }
        state.run_metrics = Some(state.compute_run_metrics());
        Ok(state)
    }

    pub fn delete_run(&self, run_id: &str) -> Result<(), String> {
        self.delete_run_with_cleanup(run_id, None)
    }

    pub fn delete_run_with_cleanup(&self, run_id: &str, cleanup: Option<&crate::cleanup::Manifest>) -> Result<(), String> {
        let _write_guard = store_write_guard()?;
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        // The cleanup manifest commits with the tombstone and event deletion.
        // A crash or locked file after commit cannot erase cleanup ownership.
        if let Some(cleanup) = cleanup { self.insert_cleanup(&tx, run_id, cleanup)?; }
        tx.execute("INSERT OR IGNORE INTO deleted_runs(run_id) VALUES(?1)", [run_id])
            .map_err(|e| e.to_string())?;
        tx.execute("UPDATE workspace_selection SET run_id=NULL WHERE run_id=?1", [run_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM checkpoints WHERE run_id=?1", [run_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM events WHERE run_id=?1", [run_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM execution_logs WHERE run_id=?1", [run_id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        self.execution_offsets.borrow_mut().clear();
        self.reclaim_deleted_pages();
        Ok(())
    }

    pub fn clear(&self) -> Result<(), String> {
        self.clear_with_cleanup(&[])
    }

    pub fn clear_with_cleanup(&self, cleanups: &[(String, crate::cleanup::Manifest)]) -> Result<(), String> {
        let _write_guard = store_write_guard()?;
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        for (run_id, cleanup) in cleanups {
            self.insert_cleanup(&tx, run_id, cleanup)?;
            tx.execute("INSERT OR IGNORE INTO deleted_runs(run_id) VALUES(?1)", [run_id]).map_err(|e| e.to_string())?;
        }
        tx.execute("INSERT OR IGNORE INTO deleted_runs(run_id) SELECT DISTINCT run_id FROM events", [])
            .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO workspace_selection(id,run_id) VALUES(1,NULL) ON CONFLICT(id) DO UPDATE SET run_id=NULL", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM checkpoints", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM events", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM execution_logs", []).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        self.execution_offsets.borrow_mut().clear();
        self.reclaim_deleted_pages();
        Ok(())
    }

    fn reclaim_deleted_pages(&self) {
        // Best effort after the delete commits: errors must not leave callers
        // believing a committed deletion failed (or retaining stale Services).
        let _ = self.connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
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
        let _ = self.connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }

    pub fn find_repository_by_planning_id(&self, target_planning_id: &str) -> Option<String> {
        let mut stmt = self.connection
            .prepare("SELECT payload FROM events WHERE planning_id=?1 UNION ALL SELECT payload FROM events WHERE nested_planning_id=?1")
            .ok()?;
        let mut rows = stmt.query([target_planning_id]).ok()?;
        while let Ok(Some(row)) = rows.next() {
            let payload: String = row.get(0).ok()?;
            if let Ok(EventKind::Created {
                config,
                planning_id,
                planning,
                ..
            }) = serde_json::from_str::<EventKind>(&payload)
            {
                if planning_id.as_deref() == Some(target_planning_id)
                    || planning.as_ref().map(|p| p.planning_id.as_str()) == Some(target_planning_id)
                {
                    return Some(config.repository);
                }
            }
        }
        None
    }
}
