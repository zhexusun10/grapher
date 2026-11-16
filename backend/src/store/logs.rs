use super::{store_write_guard, Store};
use crate::model::{append_live_output, EventKind, Snapshot};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;

const CHUNK_BYTES: usize = 32 * 1024;

fn floor_boundary(text: &str, mut offset: usize) -> usize {
    offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

fn insert_chunks(
    db: &Connection,
    run: &str,
    id: &str,
    start: usize,
    text: &str,
) -> Result<(), String> {
    let mut insert = db.prepare_cached(
        "INSERT INTO execution_logs(run_id,execution_id,offset,bytes,text) VALUES(?1,?2,?3,?4,?5)"
    ).map_err(|e| e.to_string())?;
    let mut pos = 0;
    while pos < text.len() {
        let end = floor_boundary(text, pos.saturating_add(CHUNK_BYTES));
        insert
            .execute(params![
                run,
                id,
                (start + pos) as i64,
                (end - pos) as i64,
                &text[pos..end]
            ])
            .map_err(|e| e.to_string())?;
        pos = end;
    }
    Ok(())
}

/// Fill the last partial block across writer batches too. Flushing live output
/// must not turn every small stdout packet into a permanent row and index entry.
/// Only the suffix grows; all previously committed UTF-8 byte offsets stay valid.
pub(super) fn append_chunks(
    db: &Connection,
    run: &str,
    id: &str,
    mut start: usize,
    mut text: &str,
) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    let last = db.query_row(
        "SELECT offset,bytes FROM execution_logs WHERE execution_id=?1 AND run_id=?2 ORDER BY offset DESC LIMIT 1",
        params![id, run], |row| Ok((row.get::<_, usize>(0)?, row.get::<_, usize>(1)?)),
    ).optional().map_err(|e| e.to_string())?;
    if let Some((offset, bytes)) = last {
        if bytes < CHUNK_BYTES && offset.checked_add(bytes) == Some(start) {
            let end = floor_boundary(text, CHUNK_BYTES - bytes);
            if end > 0 {
                db.execute("UPDATE execution_logs SET bytes=bytes+?1,text=text||?2 WHERE execution_id=?3 AND run_id=?4 AND offset=?5",
                    params![end, &text[..end], id, run, offset]).map_err(|e| e.to_string())?;
                start += end;
                text = &text[end..];
            }
        }
    }
    insert_chunks(db, run, id, start, text)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub content: String,
    pub start_offset: usize,
    pub next_offset: usize,
    pub total_bytes: usize,
    pub complete: bool,
}

/// Update live output and derived changes only after its transaction commits.
pub(super) fn apply_output(state: &mut Snapshot, id: &str, text: &str, bytes: usize) {
    let repo = state
        .config
        .as_ref()
        .map(|c| c.repository.as_str())
        .unwrap_or_default();
    if let Some(execution) = state
        .executions
        .iter_mut()
        .chain(state.mergers.iter_mut())
        .find(|e| e.id == id)
    {
        append_live_output(execution, text);
        execution.output_bytes = bytes;
        if text.contains("\"tool") || text.contains("\"grapher_process") {
            crate::file_changes::update_from_log_chunk(
                &state.run_id,
                &execution.id,
                &execution.node,
                &execution.worktree,
                repo,
                text,
                execution.status == "running",
            );
        } else {
            crate::file_changes::note_read_only_log_append(
                &state.run_id,
                &execution.id,
                execution.output_bytes,
                execution.status == "running",
            );
        }
    }
}

impl Store {
    pub fn log_bytes(&self, run: &str, id: &str) -> Result<usize, String> {
        let last = self.connection.query_row(
            "SELECT offset,bytes FROM execution_logs WHERE execution_id=?1 AND run_id=?2 ORDER BY offset DESC LIMIT 1",
            params![id, run], |row| Ok((row.get::<_, usize>(0)?, row.get::<_, usize>(1)?)),
        ).optional().map_err(|error| error.to_string())?;
        let Some((offset, bytes)) = last else {
            return Ok(0);
        };
        offset
            .checked_add(bytes)
            .filter(|end| i64::try_from(*end).is_ok())
            .ok_or_else(|| "Corrupt execution log byte range".into())
    }

    pub(super) fn append_logs(
        &self,
        state: &mut Snapshot,
        kinds: Vec<EventKind>,
    ) -> Result<(), String> {
        let _write_guard = store_write_guard()?;
        if kinds.is_empty() {
            return Ok(());
        }
        self.ensure_not_deleted(&state.run_id)?;
        let count = kinds.len();
        // Coalesce tiny stdout packets within the bounded writer batch; one
        // character per event must not become one database row per character.
        let mut texts: HashMap<String, String> = HashMap::new();
        for kind in kinds {
            let EventKind::Output { execution_id, text } = kind else {
                return Err("Expected output batch".into());
            };
            texts.entry(execution_id).or_default().push_str(&text);
        }
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let mut offsets = HashMap::new();
        for (execution_id, text) in &texts {
            let cached = self.execution_offsets.borrow().get(execution_id).copied();
            let offset = match cached {
                Some(offset) => offset,
                None => self.log_bytes(&state.run_id, execution_id)?,
            };
            append_chunks(&tx, &state.run_id, execution_id, offset, text)?;
            offsets.insert(execution_id.clone(), offset + text.len());
        }
        tx.commit().map_err(|e| e.to_string())?;
        // Neither cursors nor the live projection advance before COMMIT.
        for (execution_id, text) in texts {
            apply_output(state, &execution_id, &text, offsets[&execution_id]);
        }
        // Live output folds usage into the running attempt's metrics, so the
        // session totals must reflect it before the terminal event arrives.
        state.run_metrics = Some(state.compute_run_metrics());
        self.execution_offsets.borrow_mut().extend(offsets);
        self.note_appended(state, count);
        Ok(())
    }

    pub fn forget_log_cursor(&self, id: &str) {
        self.execution_offsets.borrow_mut().remove(id);
    }

    pub fn execution_log_page(
        &self,
        run: &str,
        id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<LogPage, String> {
        let total = self.log_bytes(run, id)?;
        if offset > total {
            return Err("Invalid output offset".into());
        }
        if offset == total {
            return Ok(LogPage {
                content: String::new(),
                start_offset: offset,
                next_offset: offset,
                total_bytes: total,
                complete: true,
            });
        }
        let start: usize = self.connection.query_row(
            "SELECT offset FROM execution_logs WHERE execution_id=?1 AND run_id=?2 AND offset<=?3 ORDER BY offset DESC LIMIT 1",
            params![id, run, offset as i64], |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        let end = offset.saturating_add(limit).min(total);
        let mut stmt = self.connection.prepare(
            "SELECT offset,bytes,text FROM execution_logs WHERE execution_id=?1 AND run_id=?2 AND offset>=?3 AND offset<?4 ORDER BY offset",
        ).map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(params![id, run, start, end as i64])
            .map_err(|e| e.to_string())?;
        let mut content = String::new();
        let mut next = offset;
        let mut expected_start = start;
        let mut boundary_limited = false;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let block_start = row.get::<_, usize>(0).map_err(|e| e.to_string())?;
            let bytes = row.get::<_, usize>(1).map_err(|e| e.to_string())?;
            let text: String = row.get(2).map_err(|e| e.to_string())?;
            if text.len() != bytes || block_start != expected_start {
                return Err("Corrupt execution log".into());
            }
            expected_start = block_start
                .checked_add(bytes)
                .ok_or("Corrupt execution log byte range")?;
            let from = next.saturating_sub(block_start);
            if from > text.len() || !text.is_char_boundary(from) {
                return Err("Invalid output offset".into());
            }
            let to = floor_boundary(&text, end.saturating_sub(block_start));
            if to < from {
                return Err("Invalid output offset".into());
            }
            content.push_str(&text[from..to]);
            next = block_start + to;
            if to < bytes {
                boundary_limited = true;
                break;
            }
        }
        // A short page is legitimate only at a UTF-8 boundary within a stored
        // block, not when missing chunks leave the cursor unable to advance.
        if next < end && !boundary_limited {
            return Err("Corrupt execution log: missing byte range".into());
        }
        Ok(LogPage {
            content,
            start_offset: offset,
            next_offset: next,
            total_bytes: total,
            complete: next == total,
        })
    }

    /// Read a bounded tail of a log. The returned start offset is aligned to a
    /// stored chunk boundary (and includes one preceding chunk when possible),
    /// so callers can prepend older pages without losing a line split at the
    /// edge of the window.
    pub fn execution_log_tail_page(
        &self,
        run: &str,
        id: &str,
        before: usize,
        limit: usize,
    ) -> Result<LogPage, String> {
        let total = self.log_bytes(run, id)?;
        let end = before.min(total);
        if end == 0 {
            return Ok(LogPage {
                content: String::new(),
                start_offset: 0,
                next_offset: 0,
                total_bytes: total,
                complete: total == 0,
            });
        }
        let candidate = end.saturating_sub(limit);
        let chunk_start: usize = self.connection.query_row(
            "SELECT offset FROM execution_logs WHERE execution_id=?1 AND run_id=?2 AND offset<=?3 ORDER BY offset DESC LIMIT 1",
            params![id, run, candidate as i64], |r| r.get::<_, usize>(0),
        ).map_err(|e| e.to_string())?;
        let start: usize = self.connection.query_row(
            "SELECT offset FROM execution_logs WHERE execution_id=?1 AND run_id=?2 AND offset<?3 ORDER BY offset DESC LIMIT 1",
            params![id, run, chunk_start as i64], |r| r.get::<_, usize>(0),
        ).optional().map_err(|e| e.to_string())?.unwrap_or(chunk_start);
        let mut stmt = self.connection.prepare(
            "SELECT offset,bytes,text FROM execution_logs WHERE execution_id=?1 AND run_id=?2 AND offset>=?3 AND offset<?4 ORDER BY offset",
        ).map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(params![id, run, start as i64, end as i64])
            .map_err(|e| e.to_string())?;
        let mut content = String::new();
        let mut next = start;
        let mut expected_start = start;
        let mut boundary_limited = false;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let block_start = row.get::<_, usize>(0).map_err(|e| e.to_string())?;
            let bytes = row.get::<_, usize>(1).map_err(|e| e.to_string())?;
            let text: String = row.get(2).map_err(|e| e.to_string())?;
            if text.len() != bytes || block_start != expected_start {
                return Err("Corrupt execution log".into());
            }
            expected_start = block_start
                .checked_add(bytes)
                .ok_or("Corrupt execution log byte range")?;
            let from = next.saturating_sub(block_start);
            if from > text.len() || !text.is_char_boundary(from) {
                return Err("Invalid output offset".into());
            }
            let to = floor_boundary(&text, end.saturating_sub(block_start));
            if to < from {
                return Err("Invalid output offset".into());
            }
            content.push_str(&text[from..to]);
            next = block_start + to;
            if to < bytes {
                boundary_limited = true;
                break;
            }
        }
        if next < end && !boundary_limited {
            return Err("Corrupt execution log: missing byte range".into());
        }
        // Keep the complete byte range, including a possible leading JSONL
        // fragment. Dropping through its newline can drop an entire tool result
        // and can return a non-progressing empty page for a long record.
        Ok(LogPage {
            content,
            start_offset: start,
            next_offset: next,
            total_bytes: total,
            complete: next == total,
        })
    }
}
