use super::{store_write_guard, Store};
use crate::cleanup::{Manifest, Target, Task};
use rusqlite::{params, OptionalExtension};
use std::{collections::BTreeSet, path::Path};

impl Store {
    pub(crate) fn ensure_not_deleted(&self, run_id: &str) -> Result<(), String> {
        if self.run_was_deleted(run_id)? {
            return Err("Run was deleted; stale writers cannot recreate it".into());
        }
        Ok(())
    }

    pub fn remember_cleanup_targets(
        &self,
        run_id: &str,
        targets: &BTreeSet<Target>,
    ) -> Result<(), String> {
        let _guard = store_write_guard()?;
        self.ensure_not_deleted(run_id)?;
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        for target in targets {
            let payload = serde_json::to_string(target).map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT OR IGNORE INTO run_owned_directories(run_id,target) VALUES(?1,?2)",
                params![run_id, payload],
            )
            .map_err(|error| error.to_string())?;
        }
        tx.commit().map_err(|error| error.to_string())
    }

    /// Source folders remain user data even after their last conversation is
    /// deleted (including a former private checkout adopted as a project).
    pub(crate) fn remember_cleanup_source(&self, repository: &Path) -> Result<(), String> {
        if !repository.is_absolute() {
            return Ok(());
        }
        let Ok(source) = repository.canonicalize() else {
            return Ok(());
        };
        let _guard = store_write_guard()?;
        self.connection
            .execute(
                "INSERT OR IGNORE INTO cleanup_sources(path) VALUES(?1)",
                [source.to_string_lossy().as_ref()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) fn backfill_cleanup_sources(&self) -> Result<(), String> {
        let indexed: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM cleanup_state WHERE key='sources_indexed')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if indexed {
            return Ok(());
        }
        let mut statement = self.connection.prepare(r#"SELECT DISTINCT json_extract(payload,'$.config.repository') FROM events
            WHERE kind IN ('created','planning_started','draft_edited') OR
            (kind IS NULL AND (payload LIKE '{"type":"created"%' OR payload LIKE '{"type":"planning_started"%' OR payload LIKE '{"type":"draft_edited"%'))"#)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, Option<String>>(0))
            .map_err(|error| error.to_string())?;
        for row in rows {
            if let Some(source) = row.map_err(|error| error.to_string())? {
                self.remember_cleanup_source(Path::new(&source))?;
            }
        }
        let _guard = store_write_guard()?;
        self.connection
            .execute(
                "INSERT OR IGNORE INTO cleanup_state(key) VALUES('sources_indexed')",
                [],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) fn cleanup_sources(&self) -> Result<BTreeSet<std::path::PathBuf>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT path FROM cleanup_sources")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            row.map(std::path::PathBuf::from)
                .map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn owned_cleanup_targets(&self, run_id: &str) -> Result<BTreeSet<Target>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT target FROM run_owned_directories WHERE run_id=?1")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([run_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn enqueue_cleanup(&self, run_id: &str, manifest: &Manifest) -> Result<(), String> {
        let _guard = store_write_guard()?;
        self.insert_cleanup(&self.connection, run_id, manifest)
    }

    pub(super) fn insert_cleanup(
        &self,
        db: &rusqlite::Connection,
        run_id: &str,
        manifest: &Manifest,
    ) -> Result<(), String> {
        let payload = serde_json::to_string(manifest).map_err(|error| error.to_string())?;
        db.execute(
            "INSERT INTO cleanup_tasks(run_id,payload,attempts,last_error) VALUES(?1,?2,0,NULL)
            ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload",
            params![run_id, payload],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn pending_cleanups(&self) -> Result<Vec<Task>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT run_id,payload,attempts,last_error FROM cleanup_tasks ORDER BY run_id")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, usize>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            let (run_id, payload, attempts, last_error) = row.map_err(|error| error.to_string())?;
            let manifest = serde_json::from_str(&payload)
                .map_err(|error| format!("Invalid cleanup manifest for {run_id}: {error}"))?;
            Ok(Task {
                run_id,
                manifest,
                attempts,
                last_error,
            })
        })
        .collect()
    }

    pub fn cleanup_task(&self, run_id: &str) -> Result<Option<Task>, String> {
        let row = self
            .connection
            .query_row(
                "SELECT payload,attempts,last_error FROM cleanup_tasks WHERE run_id=?1",
                [run_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, usize>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        row.map(|(payload, attempts, last_error)| {
            Ok(Task {
                run_id: run_id.into(),
                manifest: serde_json::from_str(&payload).map_err(|error| error.to_string())?,
                attempts,
                last_error,
            })
        })
        .transpose()
    }

    pub fn fail_cleanup(&self, run_id: &str, error: &str) -> Result<(), String> {
        let _guard = store_write_guard()?;
        self.connection
            .execute(
                "UPDATE cleanup_tasks SET attempts=attempts+1,last_error=?2 WHERE run_id=?1",
                params![run_id, error],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn finish_cleanup(&self, run_id: &str) -> Result<(), String> {
        let _guard = store_write_guard()?;
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO workspace_cleanup_done(run_id,sequence)
            SELECT run_id,json_extract(payload,'$.sequence') FROM cleanup_tasks
            WHERE run_id=?1 AND json_extract(payload,'$.sequence') IS NOT NULL
            ON CONFLICT(run_id) DO UPDATE SET sequence=excluded.sequence",
            [run_id],
        )
        .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM workspace_cleanup_done WHERE run_id=?1 AND EXISTS(SELECT 1 FROM deleted_runs WHERE run_id=?1)", [run_id])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM cleanup_tasks WHERE run_id=?1", [run_id])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM run_owned_directories WHERE run_id=?1 AND EXISTS(SELECT 1 FROM deleted_runs WHERE run_id=?1)", [run_id])
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())
    }

    pub(crate) fn cleanup_target_is_shared(
        &self,
        excluded: &str,
        target: &Target,
    ) -> Result<bool, String> {
        let payload = serde_json::to_string(target).map_err(|error| error.to_string())?;
        let recorded: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM run_owned_directories o
            WHERE o.target=?1 AND o.run_id<>?2 AND EXISTS(SELECT 1 FROM events e WHERE e.run_id=o.run_id))",
            params![payload, excluded], |row| row.get(0)).map_err(|error| error.to_string())?;
        if recorded {
            return Ok(true);
        }
        let planning = match target {
            Target::Data { bucket, id } if bucket == "planning" => Some(id),
            Target::Workspace {
                checkout: Some(id), ..
            } => Some(id),
            _ => None,
        };
        if let Some(id) = planning {
            return self.connection.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE run_id<>?1 AND (planning_id=?2 OR nested_planning_id=?2))",
                params![excluded, id], |row| row.get(0)).map_err(|error| error.to_string());
        }
        if let Target::Data { bucket, id } = target {
            if matches!(bucket.as_str(), "sessions" | "mergers") {
                let kind = if bucket == "sessions" {
                    "started"
                } else {
                    "merger_started"
                };
                let prefix = format!("{{\"type\":\"{kind}\"%");
                return self.connection.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE run_id<>?1 AND
                    ((kind=?2 AND execution_id=?3) OR (kind IS NULL AND payload LIKE ?4 AND json_extract(payload,'$.execution.id')=?3)))",
                    params![excluded, kind, id, prefix], |row| row.get(0)).map_err(|error| error.to_string());
            }
        }
        if let Target::Shadow { root, name } = target {
            let expected = root.join("shadow_repos").join(name);
            for id in self.runs()?.into_iter().filter(|id| id != excluded) {
                let state = self.load(&id)?;
                let Some(config) = state.config else {
                    continue;
                };
                let source = Path::new(&config.repository);
                if !source.is_dir() {
                    return Ok(true);
                } // Cannot disprove a legacy shared binding.
                if crate::workspace::shadow_repo_dir(source)? == expected {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    pub(crate) fn has_cleanup_owner(&self, target: &Target) -> Result<bool, String> {
        let target = serde_json::to_string(target).map_err(|error| error.to_string())?;
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM run_owned_directories WHERE target=?1)",
                [target],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }

    pub fn completed_workspace_runs(&self) -> Result<Vec<String>, String> {
        let mut statement = self.connection.prepare("SELECT e.run_id FROM events e
            WHERE e.sequence IN (SELECT MAX(sequence) FROM events GROUP BY run_id)
              AND (e.kind='publication_completed' OR (e.kind IS NULL AND e.payload LIKE '{\"type\":\"publication_completed\"%'))
              AND NOT EXISTS(SELECT 1 FROM workspace_cleanup_done d WHERE d.run_id=e.run_id AND d.sequence=e.sequence)")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    /// Provisional planning directories whose Run never reached its first
    /// event are reclaimed only at startup, after planning recovery.
    pub fn orphaned_cleanup_owners(&self) -> Result<Vec<String>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT DISTINCT o.run_id FROM run_owned_directories o
            WHERE NOT EXISTS(SELECT 1 FROM events e WHERE e.run_id=o.run_id)
              AND NOT EXISTS(SELECT 1 FROM cleanup_tasks c WHERE c.run_id=o.run_id)",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }
}
