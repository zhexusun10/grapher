use super::{store_write_guard, Store};
use crate::model::{append_live_output, EventKind, Snapshot};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

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

    /// Return the exact UTF-8 byte offset of each `grapherRequestId`-tagged
    /// user turn in `0..end_offset`. Only chunks mentioning the marker (or a
    /// possible split boundary) are inspected, so multi-megabyte logs stay fast.
    pub fn execution_steer_offsets(
        &self,
        run: &str,
        id: &str,
        end_offset: usize,
    ) -> Result<BTreeMap<String, usize>, String> {
        self.execution_steer_offsets_from(run, id, 0, end_offset)
    }

    /// Incremental variant that only scans chunks overlapping `from_offset..end_offset`
    /// (plus the single boundary chunk preceding `from_offset` to stay split-proof).
    pub fn execution_steer_offsets_from(
        &self,
        run: &str,
        id: &str,
        from_offset: usize,
        end_offset: usize,
    ) -> Result<BTreeMap<String, usize>, String> {
        let mut offsets = BTreeMap::new();
        if end_offset == 0 || from_offset >= end_offset {
            return Ok(offsets);
        }
        let scan_start: usize = if from_offset == 0 {
            0
        } else {
            self.connection
                .query_row(
                    "SELECT offset FROM execution_logs WHERE execution_id=?1 AND run_id=?2 AND offset<=?3 ORDER BY offset DESC LIMIT 1",
                    params![id, run, from_offset.saturating_sub(1) as i64],
                    |row| row.get::<_, usize>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .unwrap_or(0)
        };
        // Split-proof half-token filter: `"grapherRequestId"` is `"grapher"` (0..7)
        // + `"RequestId"` (7..16), so ANY 32KB chunk boundary leaves either `"RequestId"`
        // intact in the right chunk or `"grapher"` intact near the left chunk's tail.
        let mut stmt = self.connection.prepare(
            "SELECT offset, text FROM execution_logs WHERE execution_id=?1 AND run_id=?2 AND offset>=?3 AND offset<?4 \
             AND (instr(text, 'RequestId')>0 OR instr(substr(text, -16), 'grapher')>0) \
             ORDER BY offset",
        ).map_err(|e| e.to_string())?;
        let candidates: Vec<(usize, String)> = stmt
            .query_map(params![id, run, scan_start as i64, end_offset as i64], |row| {
                Ok((row.get::<_, usize>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        if candidates.is_empty() {
            return Ok(offsets);
        }
        let mut seen_line_starts = std::collections::HashSet::new();
        for (chunk_offset, chunk_text) in candidates {
            let valid_len = floor_boundary(&chunk_text, end_offset.saturating_sub(chunk_offset));
            let slice = &chunk_text[..valid_len];
            let mut search_from = 0;
            let mut match_positions = Vec::new();
            while let Some(pos) = slice[search_from..].find("RequestId") {
                match_positions.push(search_from + pos);
                search_from += pos + "RequestId".len();
            }
            let tail_start = floor_boundary(slice, slice.len().saturating_sub(16));
            if slice.len() == chunk_text.len()
                && chunk_offset + chunk_text.len() < end_offset
                && slice[tail_start..].contains("grapher")
            {
                match_positions.push(slice.len());
            }
            for rel_pos in match_positions {
                let Some((line_start, line_text, truncated)) = self.extract_steer_line(
                    run,
                    id,
                    chunk_offset,
                    &chunk_text,
                    rel_pos,
                    end_offset,
                )?
                else {
                    continue;
                };
                if !seen_line_starts.insert(line_start) {
                    continue;
                }
                let trimmed = line_text.trim();
                if !trimmed.contains("\"grapherRequestId\"") {
                    continue;
                }
                if let Some(request_id) = parse_steer_event_request_id(trimmed, truncated) {
                    offsets.entry(request_id).or_insert(line_start);
                }
            }
        }
        Ok(offsets)
    }

    fn extract_steer_line(
        &self,
        run: &str,
        id: &str,
        chunk_offset: usize,
        chunk_text: &str,
        rel_pos: usize,
        end_offset: usize,
    ) -> Result<Option<(usize, String, bool)>, String> {
        // Tagged user turns emitted by pi-compat place `"grapherRequestId"` at
        // the start of the JSON line. Reject matches deep inside multi-KB tool
        // outputs or assistant bodies without scanning megabytes of log chunks.
        const MAX_LOOKBACK: usize = 4 * 1024;
        const MAX_LINE_BYTES: usize = 64 * 1024;

        let mut line_start = chunk_offset;
        let mut prefix_parts: Vec<String> = Vec::new();
        let before = &chunk_text[..rel_pos.min(chunk_text.len())];
        if let Some(nl) = before.rfind('\n') {
            let tail = &before[nl + 1..];
            if tail.len() > MAX_LOOKBACK {
                return Ok(None);
            }
            line_start = chunk_offset + nl + 1;
            prefix_parts.push(tail.to_string());
        } else {
            let mut lookback = before.len();
            if lookback > MAX_LOOKBACK {
                return Ok(None);
            }
            prefix_parts.push(before.to_string());
            let mut cursor = chunk_offset;
            while cursor > 0 {
                let prev: Option<(usize, String)> = self
                    .connection
                    .query_row(
                        "SELECT offset, text FROM execution_logs WHERE execution_id=?1 AND run_id=?2 AND offset<?3 ORDER BY offset DESC LIMIT 1",
                        params![id, run, cursor as i64],
                        |row| Ok((row.get::<_, usize>(0)?, row.get::<_, String>(1)?)),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                let Some((prev_offset, prev_text)) = prev else {
                    break;
                };
                if prev_offset >= cursor {
                    break;
                }
                if let Some(nl) = prev_text.rfind('\n') {
                    let tail = &prev_text[nl + 1..];
                    if lookback.saturating_add(tail.len()) > MAX_LOOKBACK {
                        return Ok(None);
                    }
                    line_start = prev_offset + nl + 1;
                    prefix_parts.push(tail.to_string());
                    break;
                }
                lookback = lookback.saturating_add(prev_text.len());
                if lookback > MAX_LOOKBACK {
                    return Ok(None);
                }
                line_start = prev_offset;
                prefix_parts.push(prev_text);
                cursor = prev_offset;
            }
        }
        prefix_parts.reverse();
        let mut line = prefix_parts.concat();

        let mut truncated = false;
        let valid_len = floor_boundary(chunk_text, end_offset.saturating_sub(chunk_offset));
        let after_start = rel_pos.min(valid_len);
        let after = &chunk_text[after_start..valid_len];
        if let Some(nl) = after.find('\n') {
            line.push_str(&after[..nl]);
        } else {
            let remaining = MAX_LINE_BYTES.saturating_sub(line.len());
            if after.len() > remaining {
                let take = floor_boundary(after, remaining);
                line.push_str(&after[..take]);
                truncated = true;
            } else {
                line.push_str(after);
                let mut next_cursor = chunk_offset + chunk_text.len();
                while next_cursor < end_offset {
                    let next_chunk: Option<(usize, String)> = self
                        .connection
                        .query_row(
                            "SELECT offset, text FROM execution_logs WHERE execution_id=?1 AND run_id=?2 AND offset>=?3 ORDER BY offset ASC LIMIT 1",
                            params![id, run, next_cursor as i64],
                            |row| Ok((row.get::<_, usize>(0)?, row.get::<_, String>(1)?)),
                        )
                        .optional()
                        .map_err(|e| e.to_string())?;
                    let Some((next_offset, next_text)) = next_chunk else {
                        break;
                    };
                    if next_text.is_empty() {
                        break;
                    }
                    let next_valid =
                        floor_boundary(&next_text, end_offset.saturating_sub(next_offset));
                    let next_slice = &next_text[..next_valid];
                    if let Some(nl) = next_slice.find('\n') {
                        line.push_str(&next_slice[..nl]);
                        break;
                    }
                    let remaining = MAX_LINE_BYTES.saturating_sub(line.len());
                    if next_slice.len() > remaining {
                        let take = floor_boundary(next_slice, remaining);
                        line.push_str(&next_slice[..take]);
                        truncated = true;
                        break;
                    }
                    line.push_str(next_slice);
                    next_cursor = next_offset + next_text.len();
                }
            }
        }
        Ok(Some((line_start, line, truncated)))
    }
}

fn parse_steer_event_request_id(trimmed: &str, truncated: bool) -> Option<String> {
    if !truncated {
        let event = serde_json::from_str::<serde_json::Value>(trimmed).ok()?;
        if !matches!(
            event["type"].as_str(),
            Some("message_start" | "message_end")
        ) || event["message"]["role"].as_str() != Some("user")
        {
            return None;
        }
        return event["grapherRequestId"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
    }
    // Oversized line (e.g. a multi-MB base64 image steer): parse only the
    // leading envelope emitted by pi-compat (`{"grapherRequestId":"...",
    // "type":"message_start"|"message_end","message":{"role":"user",...`).
    let rest = trimmed.strip_prefix("{\"grapherRequestId\":")?;
    let mut stream = serde_json::Deserializer::from_str(rest).into_iter::<String>();
    let request_id = stream.next()?.ok()?;
    if request_id.is_empty() {
        return None;
    }
    let after_id = &rest[stream.byte_offset()..];
    let after_type = after_id
        .strip_prefix(",\"type\":\"message_start\"")
        .or_else(|| after_id.strip_prefix(",\"type\":\"message_end\""))?;
    let after_msg = after_type.strip_prefix(",\"message\":{")?;
    let header_end = after_msg.find("\"content\":").unwrap_or(after_msg.len());
    if !after_msg[..header_end].contains("\"role\":\"user\"") {
        return None;
    }
    Some(request_id)
}
