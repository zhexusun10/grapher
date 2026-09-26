use crate::model::{apply, now, Event, EventKind, Snapshot};
use rusqlite::{params, Connection};
use std::path::Path;

const CHECKPOINT_INTERVAL: usize = 128;

fn created_planning_ids(kind: &EventKind) -> (Option<&str>, Option<&str>) {
    if let EventKind::Created { planning_id, planning, .. } = kind {
        (planning_id.as_deref(), planning.as_ref().map(|p| p.planning_id.as_str()))
    } else {
        (None, None)
    }
}

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL, planning_id TEXT, nested_planning_id TEXT);
            CREATE INDEX IF NOT EXISTS events_run ON events(run_id, sequence);
            CREATE TABLE IF NOT EXISTS checkpoints (run_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, payload TEXT NOT NULL);")
            .map_err(|error| error.to_string())?;
        let columns = {
            let mut stmt = connection.prepare("PRAGMA table_info(events)").map_err(|e| e.to_string())?;
            let columns = stmt.query_map([], |row| row.get::<_, String>(1)).map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            columns
        };
        // Schema change and backfill must commit together: a crash may not
        // leave a new column with an incomplete (and never retried) index.
        connection.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
        let missing_planning_id = !columns.iter().any(|column| column == "planning_id");
        let missing_nested_id = !columns.iter().any(|column| column == "nested_planning_id");
        if missing_planning_id {
            connection.execute_batch("ALTER TABLE events ADD COLUMN planning_id TEXT;").map_err(|e| e.to_string())?;
        }
        if missing_nested_id {
            connection.execute_batch("ALTER TABLE events ADD COLUMN nested_planning_id TEXT;").map_err(|e| e.to_string())?;
        }
        if missing_planning_id || missing_nested_id {
            let mut stmt = connection.prepare("SELECT sequence, payload FROM events WHERE payload LIKE '%created%'")
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
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
        connection.execute_batch("COMMIT").map_err(|e| e.to_string())?;
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
    pub fn append_batch(&mut self, state: &mut Snapshot, kinds: Vec<EventKind>) -> Result<(), String> {
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
            events.push(Event { sequence: transaction.last_insert_rowid(), timestamp, kind });
        }
        transaction.commit().map_err(|e| e.to_string())?;
        for event in events { apply(state, &event); }
        if state.events.len() / CHECKPOINT_INTERVAL > previous_count / CHECKPOINT_INTERVAL {
            self.save_checkpoint(state);
        }
        Ok(())
    }

    // Checkpoints are optional accelerators. A failed write must not report a
    // committed event as failed; load can always replay the event log instead.
    fn save_checkpoint(&self, state: &Snapshot) {
        if let Some(last) = state.events.last() {
            if let Ok(payload) = serde_json::to_string(state) {
                let _ = self.connection.execute(
                    "INSERT INTO checkpoints(run_id, sequence, payload) VALUES (?1, ?2, ?3)
                     ON CONFLICT(run_id) DO UPDATE SET sequence=excluded.sequence, payload=excluded.payload",
                    params![state.run_id, last.sequence, payload],
                );
            }
        }
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
        let checkpoint = self.connection.query_row(
            "SELECT sequence, payload FROM checkpoints WHERE run_id=?1", [run_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        ).ok().and_then(|(sequence, payload)| {
            serde_json::from_str::<Snapshot>(&payload).ok()
                .filter(|state| state.run_id == run_id && state.events.last().map(|e| e.sequence) == Some(sequence))
                .map(|state| (sequence, state))
        });
        let (sequence, mut state) = checkpoint.unwrap_or_else(|| (0, Snapshot {
            run_id: run_id.into(),
            ..Snapshot::default()
        }));
        let mut statement = self
            .connection
            .prepare(
                "SELECT sequence, timestamp, payload FROM events WHERE run_id=?1 AND sequence>?2 ORDER BY sequence",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![run_id, sequence], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (sequence, timestamp, payload) = row.map_err(|error| error.to_string())?;
            let kind = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
            apply(
                &mut state,
                &Event {
                    sequence,
                    timestamp,
                    kind,
                },
            );
        }
        Ok(state)
    }

    pub fn delete_run(&self, run_id: &str) -> Result<(), String> {
        let tx = self.connection.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM checkpoints WHERE run_id=?1", [run_id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM events WHERE run_id=?1", [run_id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn clear(&self) -> Result<(), String> {
        let tx = self.connection.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM checkpoints", []).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM events", []).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn find_repository_by_planning_id(&self, target_planning_id: &str) -> Option<String> {
        let mut stmt = self.connection
            .prepare("SELECT payload FROM events WHERE planning_id=?1 UNION ALL SELECT payload FROM events WHERE nested_planning_id=?1")
            .ok()?;
        let mut rows = stmt.query([target_planning_id]).ok()?;
        while let Ok(Some(row)) = rows.next() {
            let payload: String = row.get(0).ok()?;
            if let Ok(EventKind::Created { config, planning_id, planning, .. }) =
                serde_json::from_str::<EventKind>(&payload)
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
