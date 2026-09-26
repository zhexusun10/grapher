use crate::model::{apply, now, Event, EventKind, Snapshot};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

const CHECKPOINT_INTERVAL: usize = 128;

fn created_planning_ids(kind: &EventKind) -> (Option<&str>, Option<&str>) {
    if let EventKind::Created {
        planning_id,
        planning,
        ..
    } = kind
    {
        (
            planning_id.as_deref(),
            planning.as_ref().map(|p| p.planning_id.as_str()),
        )
    } else {
        (None, None)
    }
}

// Restore only transcripts in the checkpoint prefix, not scheduler state or metrics.
fn restore_output(state: &mut Snapshot, kind: &EventKind) {
    let (id, text, replace) = match kind {
        EventKind::Started { execution } | EventKind::MergerStarted { execution } =>
            (&execution.id, execution.output.clone(), true),
        EventKind::Output { execution_id, text } => (execution_id, text.clone(), false),
        EventKind::Finished { execution_id, output, .. } => (execution_id, output.clone(), true),
        EventKind::MergerFailed { execution_id, error } =>
            (execution_id, format!("\nMerger failed: {error}\n"), false),
        _ => return,
    };
    if let Some(execution) = state.executions.iter_mut().chain(state.mergers.iter_mut()).find(|e| &e.id == id) {
        if replace { execution.output = text; } else { execution.output.push_str(&text); }
    }
}

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(|error| error.to_string())?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL, planning_id TEXT, nested_planning_id TEXT);
            CREATE INDEX IF NOT EXISTS events_run ON events(run_id, sequence);
            CREATE TABLE IF NOT EXISTS checkpoints (run_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS workspace_selection (id INTEGER PRIMARY KEY CHECK(id=1), run_id TEXT);")
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
        if missing_planning_id || missing_nested_id {
            let mut stmt = connection
                .prepare("SELECT sequence, payload FROM events WHERE payload LIKE '%created%'")
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
            CREATE INDEX IF NOT EXISTS events_nested_planning_id ON events(nested_planning_id) WHERE nested_planning_id IS NOT NULL;")
            .map_err(|e| e.to_string())?;
        connection
            .execute_batch("COMMIT")
            .map_err(|e| e.to_string())?;
        Ok(Self { connection })
    }

    pub fn append(&self, state: &mut Snapshot, kind: EventKind) -> Result<(), String> {
        let timestamp = now();
        let payload = serde_json::to_string(&kind).map_err(|error| error.to_string())?;
        let (direct, nested) = created_planning_ids(&kind);
        self.connection
            .execute(
                "INSERT INTO events(run_id, timestamp, payload, planning_id, nested_planning_id) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![state.run_id, timestamp, payload, direct, nested],
            )
            .map_err(|error| error.to_string())?;
        apply(
            state,
            &Event {
                sequence: self.connection.last_insert_rowid(),
                timestamp,
                kind,
            },
        );
        if state.events.len() % CHECKPOINT_INTERVAL == 0 {
            self.save_checkpoint(state);
        }
        Ok(())
    }

    /// Persist a bounded batch atomically, then update the in-memory projection.
    /// Never expose output in memory if the transaction did not commit.
    pub fn append_batch(
        &mut self,
        state: &mut Snapshot,
        kinds: Vec<EventKind>,
    ) -> Result<(), String> {
        let previous_count = state.events.len();
        let transaction = self.connection.transaction().map_err(|e| e.to_string())?;
        let mut events = Vec::with_capacity(kinds.len());
        for kind in kinds {
            let timestamp = now();
            let payload = serde_json::to_string(&kind).map_err(|e| e.to_string())?;
            let (direct, nested) = created_planning_ids(&kind);
            transaction.execute(
                "INSERT INTO events(run_id, timestamp, payload, planning_id, nested_planning_id) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![state.run_id, timestamp, payload, direct, nested],
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
        if state.events.len() / CHECKPOINT_INTERVAL > previous_count / CHECKPOINT_INTERVAL {
            self.save_checkpoint(state);
        }
        Ok(())
    }

    // Checkpoints are optional accelerators. A failed write must not report a
    // committed event as failed; load can always replay the event log instead.
    fn save_checkpoint(&self, state: &Snapshot) {
        if let Some(last) = state.events.last() {
            // Borrow the projection so checkpoint creation never clones the log.
            // Execution transcripts are reconstructed from events on load.
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
        self.connection.execute(
            "INSERT INTO workspace_selection(id,run_id) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id",
            [run_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
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
            let event = Event { sequence: event_sequence, timestamp, kind };
            if event_sequence > sequence {
                apply(&mut state, &event);
            } else {
                restore_output(&mut state, &event.kind);
                state.events.push(event);
            }
        }
        Ok(state)
    }

    pub fn delete_run(&self, run_id: &str) -> Result<(), String> {
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        tx.execute("UPDATE workspace_selection SET run_id=NULL WHERE run_id=?1", [run_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM checkpoints WHERE run_id=?1", [run_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM events WHERE run_id=?1", [run_id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn clear(&self) -> Result<(), String> {
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO workspace_selection(id,run_id) VALUES(1,NULL) ON CONFLICT(id) DO UPDATE SET run_id=NULL", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM checkpoints", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM events", [])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
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
