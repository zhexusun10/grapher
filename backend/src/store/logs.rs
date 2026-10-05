use super::{store_write_guard, Store};
use crate::model::{append_live_output, parse_execution_metrics, EventKind, Snapshot};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::collections::HashMap;

const CHUNK_BYTES: usize = 32 * 1024;

fn floor_boundary(text: &str, mut offset: usize) -> usize {
    offset = offset.min(text.len());
    while !text.is_char_boundary(offset) { offset -= 1; }
    offset
}

fn insert_chunks(db: &Connection, run: &str, id: &str, start: usize, text: &str, idempotent: bool) -> Result<(), String> {
    let sql = if idempotent {
        "INSERT OR IGNORE INTO execution_logs(run_id,execution_id,offset,bytes,text) VALUES(?1,?2,?3,?4,?5)"
    } else {
        "INSERT INTO execution_logs(run_id,execution_id,offset,bytes,text) VALUES(?1,?2,?3,?4,?5)"
    };
    let mut insert = db.prepare_cached(sql).map_err(|e| e.to_string())?;
    let mut pos = 0;
    while pos < text.len() {
        let end = floor_boundary(text, pos.saturating_add(CHUNK_BYTES));
        insert.execute(params![run, id, (start + pos) as i64, (end - pos) as i64, &text[pos..end]]).map_err(|e| e.to_string())?;
        pos = end;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub content: String,
    pub next_offset: usize,
    pub total_bytes: usize,
    pub complete: bool,
}

#[derive(Default, Debug)]
pub struct MigrationReport {
    pub backfilled_rows: usize,
    pub migrated_executions: usize,
    pub updated_rows: usize,
    pub deleted_chunks: usize,
}

impl Store {
    pub fn log_bytes(&self, run: &str, id: &str) -> Result<usize, String> {
        self.connection.query_row(
            "SELECT offset + bytes FROM execution_logs WHERE execution_id=?1 AND run_id=?2 ORDER BY offset DESC LIMIT 1",
            params![id, run], |r| r.get::<_, i64>(0),
        ).optional().map(|v| v.unwrap_or(0) as usize).map_err(|e| e.to_string())
    }

    pub(super) fn replace_logs(&self, run: &str, id: &str, text: &str) -> Result<(), String> {
        let tx = self.connection.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM execution_logs WHERE execution_id=?1 AND run_id=?2", params![id, run]).map_err(|e| e.to_string())?;
        insert_chunks(&tx, run, id, 0, text, false)?;
        tx.commit().map_err(|e| e.to_string())?;
        self.execution_offsets.borrow_mut().insert(id.to_owned(), text.len());
        Ok(())
    }

    pub(super) fn append_logs(&self, state: &mut Snapshot, kinds: Vec<EventKind>) -> Result<(), String> {
        let _write_guard = store_write_guard()?;
        if kinds.is_empty() { return Ok(()); }
        self.ensure_not_deleted(&state.run_id)?;
        let count = kinds.len();
        // Coalesce tiny stdout packets within the bounded writer batch; one
        // character per event must not become one database row per character.
        let mut texts: HashMap<String, String> = HashMap::new();
        for kind in kinds {
            let EventKind::Output { execution_id, text } = kind else { return Err("Expected output batch".into()); };
            texts.entry(execution_id).or_default().push_str(&text);
        }
        let tx = self.connection.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut offsets = HashMap::new();
        for (execution_id, text) in &texts {
            let cached = self.execution_offsets.borrow().get(execution_id).copied();
            let offset = match cached { Some(offset) => offset, None => self.log_bytes(&state.run_id, execution_id)? };
            insert_chunks(&tx, &state.run_id, execution_id, offset, text, false)?;
            offsets.insert(execution_id.clone(), offset + text.len());
        }
        tx.commit().map_err(|e| e.to_string())?;
        // Neither cursors nor the live projection advance before COMMIT.
        for (execution_id, text) in texts {
            if let Some(execution) = state.executions.iter_mut().chain(state.mergers.iter_mut()).find(|e| e.id == execution_id) {
                append_live_output(execution, &text);
                execution.output_bytes = offsets[&execution_id];
            }
        }
        self.execution_offsets.borrow_mut().extend(offsets);
        self.note_appended(state, count);
        Ok(())
    }

    pub fn forget_log_cursor(&self, id: &str) { self.execution_offsets.borrow_mut().remove(id); }

    pub fn execution_log_page(&self, run: &str, id: &str, offset: usize, limit: usize) -> Result<LogPage, String> {
        let total = self.log_bytes(run, id)?;
        if offset > total { return Err("Invalid output offset".into()); }
        if offset == total { return Ok(LogPage { content: String::new(), next_offset: offset, total_bytes: total, complete: true }); }
        let start: i64 = self.connection.query_row(
            "SELECT offset FROM execution_logs WHERE execution_id=?1 AND run_id=?2 AND offset<=?3 ORDER BY offset DESC LIMIT 1",
            params![id, run, offset as i64], |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        let end = offset.saturating_add(limit).min(total);
        let mut stmt = self.connection.prepare(
            "SELECT offset,bytes,text FROM execution_logs WHERE execution_id=?1 AND run_id=?2 AND offset>=?3 AND offset<?4 ORDER BY offset",
        ).map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![id, run, start, end as i64]).map_err(|e| e.to_string())?;
        let mut content = String::new();
        let mut next = offset;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let block_start = row.get::<_, i64>(0).map_err(|e| e.to_string())? as usize;
            let bytes = row.get::<_, i64>(1).map_err(|e| e.to_string())? as usize;
            let text: String = row.get(2).map_err(|e| e.to_string())?;
            if text.len() != bytes || block_start > next { return Err("Corrupt execution log".into()); }
            let from = next.saturating_sub(block_start);
            if from > text.len() || !text.is_char_boundary(from) { return Err("Invalid output offset".into()); }
            let to = floor_boundary(&text, end.saturating_sub(block_start));
            if to < from { return Err("Invalid output offset".into()); }
            content.push_str(&text[from..to]);
            next = block_start + to;
            if to < bytes { break; }
        }
        Ok(LogPage { content, next_offset: next, total_bytes: total, complete: next == total })
    }

    // Only this compatibility path materializes legacy log text. Normal load
    // reads metadata alone. Indexed and pre-index databases are both supported.
    fn legacy_transcript(&self, run: &str, id: &str) -> Result<(String, Vec<(i64, u64, EventKind)>), String> {
        let mut stmt = self.connection.prepare(
            "SELECT sequence,timestamp,payload FROM events
             WHERE run_id=?1 AND (
                execution_id = ?2
                OR (kind IS NULL AND (
                    (instr(substr(payload,1,512),'\"execution_id\":\"') > 0 AND
                     substr(payload, instr(substr(payload,1,512),'\"execution_id\":\"') + 16,
                        instr(substr(payload, instr(substr(payload,1,512),'\"execution_id\":\"') + 16, 64),'\"') - 1) = ?2)
                    OR
                    (instr(substr(payload,1,512),'\"execution\":{\"id\":\"') > 0 AND
                     substr(payload, instr(substr(payload,1,512),'\"execution\":{\"id\":\"') + 19,
                        instr(substr(payload, instr(substr(payload,1,512),'\"execution\":{\"id\":\"') + 19, 64),'\"') - 1) = ?2)
                ))
             )
             ORDER BY sequence",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![run, id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, u64>(1)?, r.get::<_, String>(2)?))).map_err(|e| e.to_string())?;
        let mut text = String::new();
        let mut terminal = Vec::new();
        let mut authoritative = false;
        for row in rows {
            let (sequence, timestamp, payload) = row.map_err(|e| e.to_string())?;
            let kind: EventKind = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
            match &kind {
                EventKind::Started { execution } | EventKind::MergerStarted { execution } => {
                    if !authoritative { text = execution.output.clone(); }
                }
                EventKind::Output { text: chunk, .. } if !authoritative => text.push_str(chunk),
                EventKind::Finished { output, .. } if !output.is_empty() => {
                    text = output.clone(); authoritative = true;
                }
                EventKind::MergerFailed { error, .. } if !authoritative => text.push_str(&format!("\nMerger failed: {error}\n")),
                _ => {}
            }
            if !matches!(kind, EventKind::Output { .. }) { terminal.push((sequence, timestamp, kind)); }
        }
        Ok((text, terminal))
    }

    /// JIT writes only the log table. The IMMEDIATE transaction serializes
    /// cross-Service readers and checks for an already committed migration.
    pub fn ensure_legacy_logs(&self, run: &str, id: &str) -> Result<usize, String> {
        let _write_guard = store_write_guard()?;
        let tx = rusqlite::Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        let existing = self.log_bytes(run, id)?;
        if existing > 0 { return Ok(existing); }
        let (text, _) = self.legacy_transcript(run, id)?;
        insert_chunks(&tx, run, id, 0, &text, true)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(text.len())
    }

    /// The caller must hold the data-directory maintenance lease. Each execution
    /// commits independently; a restart can safely resume after any commit.
    pub fn migrate_legacy_logs(&self) -> Result<MigrationReport, String> {
        let _write_guard = store_write_guard()?;
        let mut report = MigrationReport { backfilled_rows: self.backfill_event_index()?, ..Default::default() };
        let ids = {
            let mut stmt = self.connection.prepare(
                "SELECT DISTINCT run_id,execution_id FROM events WHERE execution_id IS NOT NULL AND
                    (kind='output' OR (kind='finished' AND (length(payload) > 4096 OR COALESCE(json_extract(payload,'$.output'),'')!=''))
                    OR (kind IN ('started','merger_started') AND COALESCE(json_extract(payload,'$.execution.output'),'')!='')
                    OR (kind='merger_failed' AND NOT EXISTS(SELECT 1 FROM execution_logs l WHERE l.execution_id=events.execution_id)))",
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        for (run, id) in ids {
            let tx = rusqlite::Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            let (text, events) = self.legacy_transcript(&run, &id)?;
            insert_chunks(&tx, &run, &id, 0, &text, true)?;
            // Never clean the source unless the committed/JIT chunks match it.
            let saved = self.execution_log_page(&run, &id, 0, usize::MAX)?;
            if saved.content != text { return Err(format!("Legacy log mismatch for {id}; source events preserved")); }
            let started = events.iter().find_map(|(_, _, kind)| match kind {
                EventKind::Started { execution } | EventKind::MergerStarted { execution } => Some(execution.started_at),
                _ => None,
            }).unwrap_or(0);
            for (sequence, timestamp, mut kind) in events {
                let rewrite = match &mut kind {
                    EventKind::Finished { output, output_bytes, metrics, .. } => {
                        *output_bytes = text.len();
                        *metrics = metrics.take().or_else(|| Some(parse_execution_metrics(&text, started, timestamp)));
                        output.clear(); true
                    }
                    EventKind::Failed { output_bytes, metrics, .. }
                    | EventKind::MergerFinished { output_bytes, metrics, .. }
                    | EventKind::MergerFailed { output_bytes, metrics, .. } => {
                        *output_bytes = text.len();
                        *metrics = metrics.take().or_else(|| Some(parse_execution_metrics(&text, started, timestamp))); true
                    }
                    EventKind::Started { execution } | EventKind::MergerStarted { execution } if !execution.output.is_empty() => {
                        execution.output.clear(); true
                    }
                    _ => false,
                };
                if rewrite {
                    report.updated_rows += tx.execute("UPDATE events SET payload=?1 WHERE sequence=?2", params![serde_json::to_string(&kind).map_err(|e| e.to_string())?, sequence]).map_err(|e| e.to_string())?;
                }
            }
            report.deleted_chunks += tx.execute("DELETE FROM events WHERE execution_id=?1 AND run_id=?2 AND kind='output'", params![id, run]).map_err(|e| e.to_string())?;
            // Old checkpoints can carry stale metrics/byte counts. Replay the
            // small business log once instead of rewriting huge old projections.
            tx.execute("DELETE FROM checkpoints WHERE run_id=?1", [&run]).map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            self.forget_log_cursor(&id);
            report.migrated_executions += 1;
        }
        Ok(report)
    }
}
