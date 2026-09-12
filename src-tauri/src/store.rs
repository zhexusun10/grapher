use crate::model::{apply, now, Event, EventKind, Snapshot};
use rusqlite::{params, Connection};
use std::path::Path;

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_run ON events(run_id, sequence);").map_err(|error| error.to_string())?;
        Ok(Self { connection })
    }

    pub fn append(&self, state: &mut Snapshot, kind: EventKind) -> Result<(), String> {
        let timestamp = now();
        let payload = serde_json::to_string(&kind).map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT INTO events(run_id, timestamp, payload) VALUES (?1, ?2, ?3)",
                params![state.run_id, timestamp, payload],
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
        Ok(())
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
        let mut state = Snapshot {
            run_id: run_id.into(),
            ..Snapshot::default()
        };
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

    pub fn clear(&self) -> Result<(), String> {
        self.connection
            .execute("DELETE FROM events", [])
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}
