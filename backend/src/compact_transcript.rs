//! Transcript projections and on-demand card hydration.
//!
//! Supports two compact projections over append-only Pi JSONL logs:
//! - `Summary` (`summaryOnly=true`, collapsed cards): strips tool return payloads,
//!   thinking prose, large tool arguments, and streaming updates while retaining
//!   assistant text, user turns (with exact original byte offsets), error
//!   diagnostics, lifecycle markers, minimal tool metadata, and exact raw byte
//!   ranges (`grapherRawRange`) for targeted on-demand hydration.
//! - `CardShell` (`projection="cards"`, expanded settled cards): strips streaming
//!   noise (`tool_execution_update`, `thinking_delta`, `toolcall_delta`,
//!   `message_update.partial`, and streaming deltas subsumed by `message_end`),
//!   keeps small cards (`<= CARD_SHELL_INLINE_BYTES`) inline, and projects large
//!   tool/thinking bodies as lightweight shells with header flags and exact
//!   `grapherRawRange` spans for single-card hydration.
//! - `hydrate_raw_slice`: materializes selected raw byte ranges on demand with
//!   server-side 100 KiB display truncation matching the frontend preview cap.

use serde_json::{json, Map, Value};
use std::collections::HashSet;

const MAX_COMPACT_ARG_CHARS: usize = 200;
const FINAL_RESPONSE_MARKER: &str = "── Final response ──";
pub const MAX_COMPACT_RAW_SCAN_BYTES: usize = 64 * 1024 * 1024;
pub const COMPACT_RAW_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_SPLIT_LINE_CARRY_BYTES: usize = 4 * 1024 * 1024;
/// Matches `TOOL_OUTPUT_PREVIEW_BYTES` in `src/services/toolOutput.ts`.
pub const DISPLAY_TOOL_PREVIEW_BYTES: usize = 100 * 1024;
/// Small cards stay inline in `CardShell` mode so expanding them requires zero
/// round trips; larger payloads hydrate on demand via `grapherRawRange`.
pub const CARD_SHELL_INLINE_BYTES: usize = 1536;
const DISPLAY_ELLIPSIS: &str = "\n...";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TranscriptProjection {
    Summary,
    CardShell,
}

impl TranscriptProjection {
    pub fn as_str(self) -> &'static str {
        match self {
            TranscriptProjection::Summary => "summary",
            TranscriptProjection::CardShell => "cards",
        }
    }
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

pub fn truncate_display_utf8(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }
    let keep = max_bytes.saturating_sub(DISPLAY_ELLIPSIS.len());
    let cut = floor_char_boundary(text, keep);
    let mut out = String::with_capacity(cut + DISPLAY_ELLIPSIS.len());
    out.push_str(&text[..cut]);
    out.push_str(DISPLAY_ELLIPSIS);
    (out, true)
}

fn truncate_json_strings(value: &Value, max_bytes: usize) -> (Value, bool) {
    match value {
        Value::String(s) => {
            if s.len() <= max_bytes {
                (Value::String(s.clone()), false)
            } else {
                let (preview, truncated) = truncate_display_utf8(s, max_bytes);
                (Value::String(preview), truncated)
            }
        }
        Value::Array(items) => {
            let mut truncated = false;
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let (next, item_truncated) = truncate_json_strings(item, max_bytes);
                truncated |= item_truncated;
                out.push(next);
            }
            (Value::Array(out), truncated)
        }
        Value::Object(map) => {
            let mut truncated = false;
            let mut out = Map::with_capacity(map.len());
            for (k, v) in map {
                let (next, v_truncated) = truncate_json_strings(v, max_bytes);
                truncated |= v_truncated;
                out.insert(k.clone(), next);
            }
            (Value::Object(out), truncated)
        }
        other => (other.clone(), false),
    }
}

fn truncate_result_content(content: &Value, max_bytes: usize) -> Value {
    match content {
        Value::String(s) => {
            let (preview, _) = truncate_display_utf8(s, max_bytes);
            Value::String(preview)
        }
        Value::Array(parts) => {
            let mut remaining = max_bytes + 1;
            let mut out = Vec::new();
            for part in parts {
                let Some(obj) = part.as_object() else {
                    continue;
                };
                if obj.get("type").and_then(Value::as_str) != Some("text") {
                    continue;
                }
                let text = obj.get("text").and_then(Value::as_str).unwrap_or("");
                if !out.is_empty() {
                    remaining = remaining.saturating_sub(1);
                }
                if remaining == 0 {
                    break;
                }
                if text.len() <= remaining {
                    out.push(json!({ "type": "text", "text": text }));
                    remaining = remaining.saturating_sub(text.len());
                } else {
                    let (preview, _) = truncate_display_utf8(text, remaining.min(max_bytes));
                    out.push(json!({ "type": "text", "text": preview }));
                    break;
                }
            }
            Value::Array(out)
        }
        other => other.clone(),
    }
}

fn extract_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => {
            let mut out = String::new();
            for part in parts {
                let Some(obj) = part.as_object() else {
                    continue;
                };
                if obj.get("type").and_then(Value::as_str) != Some("text") {
                    continue;
                }
                if let Some(text) = obj.get("text").and_then(Value::as_str) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(text);
                }
            }
            out
        }
        _ => String::new(),
    }
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn contains_word_prefix(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(pos) = haystack[from..].find(needle) {
        let abs = from + pos;
        if abs == 0 || !is_word_byte(bytes[abs - 1]) {
            return true;
        }
        from = abs + 1;
    }
    false
}

/// Mirrors `ToolCallCard`'s warning heuristic so collapsed/shell headers match full cards.
fn detect_subcommand_warning(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    if text.contains("[grapher:step_error") || contains_word_prefix(text, "AssertionError:") {
        return true;
    }
    let bytes = text.as_bytes();
    let mut from = 0;
    while let Some(pos) = text[from..].find("not ok") {
        let abs = from + pos;
        if abs == 0 || !is_word_byte(bytes[abs - 1]) {
            let rest = &text[abs + "not ok".len()..];
            let trimmed = rest.trim_start_matches(|c: char| c == ' ' || c == '\t');
            if trimmed.len() < rest.len()
                && trimmed.as_bytes().first().is_some_and(u8::is_ascii_digit)
            {
                return true;
            }
        }
        from = abs + 1;
    }
    let mut cross_from = 0;
    while let Some(pos) = text[cross_from..].find('✖') {
        let abs = cross_from + pos + '✖'.len_utf8();
        let rest = &text[abs..];
        let trimmed = rest.trim_start_matches(|c: char| c == ' ' || c == '\t');
        if trimmed.len() < rest.len() && trimmed.chars().next().is_some_and(|c| c != '\n' && c != '\r') {
            return true;
        }
        cross_from = abs;
    }
    false
}

fn detect_interrupted_output(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    if text.contains("中断") || text.contains("终止") {
        return true;
    }
    let lower = text.to_ascii_lowercase();
    lower.contains("terminated") || lower.contains("interrupted")
}

fn detect_tool_truncated(result_obj: Option<&Map<String, Value>>, text: &str) -> bool {
    let details_truncated = result_obj
        .and_then(|r| r.get("details"))
        .and_then(|d| d.get("truncation"))
        .and_then(|t| t.get("truncated"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    details_truncated || text.contains("[Showing lines") || text.contains("Full output:")
}

fn truncate_inline(value: &str, max_chars: usize) -> (String, bool) {
    let mut out = String::new();
    let mut prev_ws = false;
    let mut count = 0usize;
    for ch in value.trim().chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                if count >= max_chars {
                    out.push('…');
                    return (out, true);
                }
                out.push(' ');
                count += 1;
                prev_ws = true;
            }
            continue;
        }
        prev_ws = false;
        if count >= max_chars {
            out.push('…');
            return (out, true);
        }
        out.push(ch);
        count += 1;
    }
    (out, false)
}

fn json_fits_budget(value: &Value, budget: usize) -> bool {
    fn walk(value: &Value, remaining: &mut usize) -> bool {
        match value {
            Value::Null => {
                if *remaining < 4 {
                    return false;
                }
                *remaining -= 4;
                true
            }
            Value::Bool(_) => {
                if *remaining < 5 {
                    return false;
                }
                *remaining -= 5;
                true
            }
            Value::Number(_) => {
                if *remaining < 8 {
                    return false;
                }
                *remaining -= 8;
                true
            }
            Value::String(s) => {
                let cost = s.len().saturating_add(2);
                if *remaining < cost {
                    return false;
                }
                *remaining -= cost;
                true
            }
            Value::Array(items) => {
                if *remaining < 2 {
                    return false;
                }
                *remaining -= 2;
                for item in items {
                    if !walk(item, remaining) {
                        return false;
                    }
                }
                true
            }
            Value::Object(map) => {
                if *remaining < 2 {
                    return false;
                }
                *remaining -= 2;
                for (k, v) in map {
                    let key_cost = k.len().saturating_add(4);
                    if *remaining < key_cost {
                        return false;
                    }
                    *remaining -= key_cost;
                    if !walk(v, remaining) {
                        return false;
                    }
                }
                true
            }
        }
    }
    let mut remaining = budget;
    walk(value, &mut remaining)
}

fn compact_args_for(args: Option<&Value>, projection: TranscriptProjection) -> (Value, bool) {
    let Some(args_val) = args else {
        return (Value::Object(Map::new()), false);
    };
    let Some(map) = args_val.as_object() else {
        return (Value::Object(Map::new()), false);
    };
    if projection == TranscriptProjection::CardShell
        && json_fits_budget(args_val, CARD_SHELL_INLINE_BYTES)
    {
        return (args_val.clone(), false);
    }

    let mut out = Map::new();
    let mut omitted = false;
    let mut kept_keys = 0usize;

    if let Some(command) = map.get("command").and_then(Value::as_str) {
        kept_keys += 1;
        let (compact, cut) = truncate_inline(command, MAX_COMPACT_ARG_CHARS);
        omitted |= cut;
        if !compact.is_empty() {
            out.insert("command".into(), Value::String(compact));
        }
    }
    if let Some(path) = map.get("path").and_then(Value::as_str) {
        kept_keys += 1;
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            out.insert("path".into(), Value::String(trimmed.to_string()));
        }
    }
    if let Some(query) = map.get("query").and_then(Value::as_str) {
        kept_keys += 1;
        let (compact, cut) = truncate_inline(query, MAX_COMPACT_ARG_CHARS);
        omitted |= cut;
        if !compact.is_empty() {
            out.insert("query".into(), Value::String(compact));
        }
    }
    if let Some(url) = map.get("url").and_then(Value::as_str) {
        kept_keys += 1;
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            let (compact, cut) = truncate_inline(trimmed, MAX_COMPACT_ARG_CHARS);
            omitted |= cut;
            out.insert("url".into(), Value::String(compact));
        }
    }
    if let Some(urls) = map.get("urls").and_then(Value::as_array) {
        kept_keys += 1;
        if urls.len() > 2 {
            omitted = true;
        }
        let mut kept = Vec::new();
        for u in urls.iter().filter_map(Value::as_str).take(2) {
            let (compact, cut) = truncate_inline(u, MAX_COMPACT_ARG_CHARS);
            omitted |= cut;
            if !compact.is_empty() {
                kept.push(Value::String(compact));
            }
        }
        if !kept.is_empty() {
            out.insert("urls".into(), Value::Array(kept));
        }
    }
    if let Some(plan_type) = map.get("plan_type").and_then(Value::as_str) {
        kept_keys += 1;
        out.insert("plan_type".into(), Value::String(plan_type.to_string()));
    }
    if map.len() > kept_keys {
        omitted = true;
    }
    (Value::Object(out), omitted)
}

fn compact_tool_call_block(
    block: &Map<String, Value>,
    projection: TranscriptProjection,
) -> (Value, bool) {
    let mut out = Map::new();
    out.insert("type".into(), Value::String("toolCall".into()));
    if let Some(id) = block.get("id").and_then(Value::as_str) {
        out.insert("id".into(), Value::String(id.to_string()));
    }
    if let Some(name) = block.get("name").and_then(Value::as_str) {
        out.insert("name".into(), Value::String(name.to_string()));
    }
    let (args, omitted) = compact_args_for(
        block.get("arguments").or_else(|| block.get("args")),
        projection,
    );
    out.insert("arguments".into(), args);
    if omitted {
        out.insert("grapherBodyOmitted".into(), Value::Bool(true));
    }
    (Value::Object(out), omitted)
}

struct AssistantEndSummary {
    value: Value,
    has_raw_range: bool,
    text_len: usize,
    thinking_indices: HashSet<u64>,
    tool_call_ids: HashSet<String>,
    tool_call_indices: HashSet<u64>,
}

fn compact_assistant_message(
    msg: &Map<String, Value>,
    projection: TranscriptProjection,
) -> AssistantEndSummary {
    let mut out = Map::new();
    let mut has_raw_range = false;
    let mut text_len = 0usize;
    let mut thinking_indices = HashSet::new();
    let mut tool_call_ids = HashSet::new();
    let mut tool_call_indices = HashSet::new();

    out.insert("role".into(), Value::String("assistant".into()));
    for key in ["id", "errorMessage", "stopReason", "isError"] {
        if let Some(val) = msg.get(key) {
            out.insert(key.into(), val.clone());
        }
    }
    if let Some(content) = msg.get("content") {
        match content {
            Value::Array(parts) => {
                let mut compact_parts = Vec::with_capacity(parts.len());
                for (index, part) in parts.iter().enumerate() {
                    let Some(obj) = part.as_object() else {
                        continue;
                    };
                    match obj.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(text) = obj.get("text").and_then(Value::as_str) {
                                text_len += text.len();
                                compact_parts.push(json!({ "type": "text", "text": text }));
                            }
                        }
                        Some("thinking") => {
                            thinking_indices.insert(index as u64);
                            let thinking = obj
                                .get("thinking")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            let trimmed_chars = thinking.trim().chars().count();
                            let inline = projection == TranscriptProjection::CardShell
                                && thinking.len() <= CARD_SHELL_INLINE_BYTES;
                            if inline {
                                compact_parts.push(json!({
                                    "type": "thinking",
                                    "thinking": thinking,
                                }));
                            } else {
                                let omitted = !thinking.trim().is_empty();
                                has_raw_range |= omitted;
                                let mut part_out = Map::new();
                                part_out.insert("type".into(), Value::String("thinking".into()));
                                part_out.insert("thinking".into(), Value::String(String::new()));
                                if omitted {
                                    part_out.insert("grapherBodyOmitted".into(), Value::Bool(true));
                                    part_out.insert(
                                        "grapherThinkingChars".into(),
                                        Value::Number((trimmed_chars as u64).into()),
                                    );
                                }
                                compact_parts.push(Value::Object(part_out));
                            }
                        }
                        Some("toolCall") => {
                            tool_call_indices.insert(index as u64);
                            if let Some(id) = obj.get("id").and_then(Value::as_str) {
                                tool_call_ids.insert(id.to_string());
                            }
                            let (block, omitted) = compact_tool_call_block(obj, projection);
                            has_raw_range |= omitted;
                            compact_parts.push(block);
                        }
                        _ => {}
                    }
                }
                out.insert("content".into(), Value::Array(compact_parts));
            }
            Value::String(text) => {
                text_len += text.len();
                out.insert("content".into(), Value::String(text.clone()));
            }
            _ => {}
        }
    }
    AssistantEndSummary {
        value: Value::Object(out),
        has_raw_range,
        text_len,
        thinking_indices,
        tool_call_ids,
        tool_call_indices,
    }
}

fn compact_tool_result_message(
    msg: &Map<String, Value>,
    projection: TranscriptProjection,
    raw_range: [usize; 2],
) -> Value {
    let mut out = Map::new();
    out.insert("role".into(), Value::String("toolResult".into()));
    for key in ["toolCallId", "toolName", "isError", "durationMs"] {
        if let Some(val) = msg.get(key) {
            out.insert(key.into(), val.clone());
        }
    }
    let exit_code = msg
        .get("details")
        .and_then(|d| d.get("exitCode"))
        .and_then(Value::as_i64);
    let details_truncated = msg
        .get("details")
        .and_then(|d| d.get("truncation"))
        .and_then(|t| t.get("truncated"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let text = extract_result_text(msg.get("content"));
    let inline = projection == TranscriptProjection::CardShell && text.len() <= CARD_SHELL_INLINE_BYTES;

    let mut details = Map::new();
    if let Some(code) = exit_code {
        details.insert("exitCode".into(), Value::Number(code.into()));
    }
    if details_truncated {
        details.insert("truncation".into(), json!({ "truncated": true }));
    }
    if !details.is_empty() {
        out.insert("details".into(), Value::Object(details));
    }

    if inline {
        if let Some(content) = msg.get("content") {
            out.insert("content".into(), truncate_result_content(content, CARD_SHELL_INLINE_BYTES));
        }
    } else if !text.is_empty() {
        out.insert("grapherBodyOmitted".into(), Value::Bool(true));
        out.insert(
            "grapherRawRange".into(),
            json!([raw_range[0] as u64, raw_range[1] as u64]),
        );
        if detect_tool_truncated(Some(msg), &text) {
            out.insert("grapherTruncated".into(), Value::Bool(true));
        }
        if detect_subcommand_warning(&text) {
            out.insert("grapherSubcommandWarning".into(), Value::Bool(true));
        }
        if detect_interrupted_output(&text) {
            out.insert("grapherInterrupted".into(), Value::Bool(true));
        }
    }
    Value::Object(out)
}

enum UpdateKind {
    TextDelta { len: usize, has_think_tag: bool },
    Thinking { content_index: Option<u64> },
    ToolCall { content_index: Option<u64>, tool_call_id: Option<String> },
}

fn compact_message_update(
    event: &Map<String, Value>,
    projection: TranscriptProjection,
    raw_range: [usize; 2],
) -> Option<(Value, UpdateKind)> {
    let inner = event
        .get("assistantMessageEvent")
        .and_then(Value::as_object)?;
    let kind = inner.get("type").and_then(Value::as_str)?;
    match kind {
        "text_delta" => {
            let delta = inner.get("delta").and_then(Value::as_str)?;
            if delta.is_empty() {
                return None;
            }
            let has_think_tag = delta.contains("<think>")
                || delta.contains("</think>")
                || delta.contains("<thought>")
                || delta.contains("</thought>");
            Some((
                json!({
                    "type": "message_update",
                    "assistantMessageEvent": {
                        "type": "text_delta",
                        "delta": delta,
                    }
                }),
                UpdateKind::TextDelta {
                    len: delta.len(),
                    has_think_tag,
                },
            ))
        }
        "thinking_start" | "thinking_end" => {
            let mut inner_out = Map::new();
            inner_out.insert("type".into(), Value::String(kind.to_string()));
            let ci = inner.get("contentIndex").and_then(Value::as_u64);
            if let Some(ci) = ci {
                inner_out.insert("contentIndex".into(), Value::Number(ci.into()));
            }
            Some((
                json!({
                    "type": "message_update",
                    "assistantMessageEvent": Value::Object(inner_out),
                }),
                UpdateKind::Thinking { content_index: ci },
            ))
        }
        "toolcall_start" => {
            let content_index = inner.get("contentIndex").and_then(Value::as_u64)?;
            let part = inner
                .get("partial")
                .and_then(|p| p.get("content"))
                .and_then(Value::as_array)
                .and_then(|arr| arr.get(content_index as usize))
                .and_then(Value::as_object);
            let tool_call_id = part
                .and_then(|tool| tool.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let mut partial_content = vec![Value::Null; content_index as usize];
            if let Some(tool) = part {
                let mut stub = Map::new();
                stub.insert("type".into(), Value::String("toolCall".into()));
                if let Some(id) = tool.get("id").and_then(Value::as_str) {
                    stub.insert("id".into(), Value::String(id.to_string()));
                }
                if let Some(name) = tool.get("name").and_then(Value::as_str) {
                    stub.insert("name".into(), Value::String(name.to_string()));
                }
                partial_content.push(Value::Object(stub));
            }
            Some((
                json!({
                    "type": "message_update",
                    "assistantMessageEvent": {
                        "type": "toolcall_start",
                        "contentIndex": content_index,
                        "partial": { "content": partial_content },
                    }
                }),
                UpdateKind::ToolCall {
                    content_index: Some(content_index),
                    tool_call_id,
                },
            ))
        }
        "toolcall_end" => {
            let tool = inner.get("toolCall").and_then(Value::as_object)?;
            let ci = inner.get("contentIndex").and_then(Value::as_u64);
            let tool_call_id = tool.get("id").and_then(Value::as_str).map(str::to_owned);
            let mut inner_out = Map::new();
            inner_out.insert("type".into(), Value::String("toolcall_end".into()));
            if let Some(ci) = ci {
                inner_out.insert("contentIndex".into(), Value::Number(ci.into()));
            }
            let (block, omitted) = compact_tool_call_block(tool, projection);
            inner_out.insert("toolCall".into(), block);
            let mut out = Map::new();
            out.insert("type".into(), Value::String("message_update".into()));
            out.insert("assistantMessageEvent".into(), Value::Object(inner_out));
            if omitted {
                out.insert(
                    "grapherRawRange".into(),
                    json!([raw_range[0] as u64, raw_range[1] as u64]),
                );
            }
            Some((
                Value::Object(out),
                UpdateKind::ToolCall {
                    content_index: ci,
                    tool_call_id,
                },
            ))
        }
        // Drop thinking_delta, toolcall_delta, text_start, text_end, etc.
        _ => None,
    }
}

fn strip_ansi_csi(input: &str) -> String {
    if !input.contains('\u{1b}') {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

struct PendingUpdateLine {
    kind: UpdateKind,
    serialized: String,
}

#[derive(Default)]
struct PendingTurnBuffer {
    lines: Vec<PendingUpdateLine>,
    text_delta_len: usize,
    has_think_tag: bool,
}

impl PendingTurnBuffer {
    fn flush_all(&mut self, out: &mut String) {
        for item in self.lines.drain(..) {
            out.push_str(&item.serialized);
            out.push('\n');
        }
        self.text_delta_len = 0;
        self.has_think_tag = false;
    }

    fn flush_non_subsumed(&mut self, summary: &AssistantEndSummary, out: &mut String) {
        let drop_text_deltas = !self.has_think_tag && summary.text_len >= self.text_delta_len;
        for item in self.lines.drain(..) {
            let subsumed = match &item.kind {
                UpdateKind::TextDelta { .. } => drop_text_deltas,
                UpdateKind::Thinking { content_index } => match content_index {
                    Some(ci) => summary.thinking_indices.contains(ci),
                    None => !summary.thinking_indices.is_empty(),
                },
                UpdateKind::ToolCall {
                    content_index,
                    tool_call_id,
                } => {
                    tool_call_id
                        .as_deref()
                        .is_some_and(|id| summary.tool_call_ids.contains(id))
                        || content_index
                            .is_some_and(|ci| summary.tool_call_indices.contains(&ci))
                }
            };
            if !subsumed {
                out.push_str(&item.serialized);
                out.push('\n');
            }
        }
        self.text_delta_len = 0;
        self.has_think_tag = false;
    }
}

enum CompactLineResult {
    Drop,
    Emit(String),
    AssistantMessageStart(String),
    AssistantUpdate(PendingUpdateLine),
    AssistantMessageEnd(String, AssistantEndSummary),
}

fn compact_json_line(
    trimmed: &str,
    raw_line_start: usize,
    raw_line_end: usize,
    projection: TranscriptProjection,
) -> CompactLineResult {
    let raw_range = [raw_line_start, raw_line_end];
    // Fast pre-checks for the highest-volume droppable events to avoid parsing
    // megabytes of stdout progress or reasoning token deltas.
    if trimmed.starts_with(r#"{"type":"tool_execution_update""#)
        || trimmed.starts_with(r#"{"type": "tool_execution_update""#)
    {
        return CompactLineResult::Drop;
    }
    if (trimmed.starts_with(r#"{"type":"message_update""#)
        || trimmed.starts_with(r#"{"type": "message_update""#))
        && !trimmed.contains(r#""text_delta""#)
        && !trimmed.contains(r#""thinking_start""#)
        && !trimmed.contains(r#""thinking_end""#)
        && !trimmed.contains(r#""toolcall_start""#)
        && !trimmed.contains(r#""toolcall_end""#)
    {
        return CompactLineResult::Drop;
    }

    let Ok(mut parsed) = serde_json::from_str::<Value>(trimmed) else {
        // Never dump truncated multi-kilobyte JSONL event fragments into the
        // transcript as assistant plaintext.
        if (trimmed.starts_with(r#"{"type":"#) || trimmed.starts_with(r#"{"type": "#))
            && trimmed.len() > 2048
        {
            return CompactLineResult::Drop;
        }
        return CompactLineResult::Emit(trimmed.to_string());
    };
    let Some(obj) = parsed.as_object_mut() else {
        return CompactLineResult::Emit(trimmed.to_string());
    };
    let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "tool_execution_update" => CompactLineResult::Drop,
        "message_update" => {
            let Some((val, update_kind)) = compact_message_update(obj, projection, raw_range) else {
                return CompactLineResult::Drop;
            };
            match serde_json::to_string(&val) {
                Ok(serialized) => CompactLineResult::AssistantUpdate(PendingUpdateLine {
                    kind: update_kind,
                    serialized,
                }),
                Err(_) => CompactLineResult::Drop,
            }
        }
        "tool_execution_start" => {
            let mut out = Map::new();
            out.insert("type".into(), Value::String("tool_execution_start".into()));
            for key in ["toolCallId", "toolName"] {
                if let Some(val) = obj.get(key) {
                    out.insert(key.into(), val.clone());
                }
            }
            let (args, omitted) = compact_args_for(obj.get("args"), projection);
            out.insert("args".into(), args);
            if omitted {
                out.insert("grapherBodyOmitted".into(), Value::Bool(true));
                out.insert(
                    "grapherRawRange".into(),
                    json!([raw_line_start as u64, raw_line_end as u64]),
                );
            }
            serde_json::to_string(&Value::Object(out))
                .map(CompactLineResult::Emit)
                .unwrap_or(CompactLineResult::Drop)
        }
        "tool_execution_end" => {
            let mut out = Map::new();
            out.insert("type".into(), Value::String("tool_execution_end".into()));
            for key in ["toolCallId", "toolName", "isError", "durationMs"] {
                if let Some(val) = obj.get(key) {
                    out.insert(key.into(), val.clone());
                }
            }
            let result_obj = obj.get("result").and_then(Value::as_object);
            let exit_code = result_obj
                .and_then(|r| r.get("details"))
                .and_then(|d| d.get("exitCode"))
                .and_then(Value::as_i64);
            let details_truncated = result_obj
                .and_then(|r| r.get("details"))
                .and_then(|d| d.get("truncation"))
                .and_then(|t| t.get("truncated"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let text = extract_result_text(result_obj.and_then(|r| r.get("content")));
            let inline = projection == TranscriptProjection::CardShell
                && text.len() <= CARD_SHELL_INLINE_BYTES;

            let mut result_out = Map::new();
            let mut details = Map::new();
            if let Some(code) = exit_code {
                details.insert("exitCode".into(), Value::Number(code.into()));
            }
            if details_truncated {
                details.insert("truncation".into(), json!({ "truncated": true }));
            }
            if !details.is_empty() {
                result_out.insert("details".into(), Value::Object(details));
            }
            if let Some(result_err) = result_obj.and_then(|r| r.get("isError")) {
                result_out.insert("isError".into(), result_err.clone());
            }
            if inline {
                if let Some(content) = result_obj.and_then(|r| r.get("content")) {
                    result_out.insert(
                        "content".into(),
                        truncate_result_content(content, CARD_SHELL_INLINE_BYTES),
                    );
                }
            } else if !text.is_empty() {
                out.insert("grapherBodyOmitted".into(), Value::Bool(true));
                out.insert(
                    "grapherRawRange".into(),
                    json!([raw_line_start as u64, raw_line_end as u64]),
                );
                if detect_tool_truncated(result_obj, &text) {
                    out.insert("grapherTruncated".into(), Value::Bool(true));
                }
                if detect_subcommand_warning(&text) {
                    out.insert("grapherSubcommandWarning".into(), Value::Bool(true));
                }
                if detect_interrupted_output(&text) {
                    out.insert("grapherInterrupted".into(), Value::Bool(true));
                }
            }
            if !result_out.is_empty() {
                out.insert("result".into(), Value::Object(result_out));
            }
            serde_json::to_string(&Value::Object(out))
                .map(CompactLineResult::Emit)
                .unwrap_or(CompactLineResult::Drop)
        }
        "message_start" | "message_end" | "message" => {
            let role = obj
                .get("message")
                .and_then(|m| m.get("role"))
                .and_then(Value::as_str)
                .unwrap_or("");
            match role {
                "user" => {
                    // Preserve user messages verbatim with exact original byte offset
                    // so inline steer matching and message editing remain byte-accurate.
                    obj.insert(
                        "grapherByteOffset".into(),
                        Value::Number((raw_line_start as u64).into()),
                    );
                    serde_json::to_string(&parsed)
                        .map(CompactLineResult::Emit)
                        .unwrap_or(CompactLineResult::Drop)
                }
                "toolResult" => {
                    let Some(msg) = obj.get("message").and_then(Value::as_object) else {
                        return CompactLineResult::Drop;
                    };
                    let mut out = Map::new();
                    out.insert("type".into(), Value::String(kind.to_string()));
                    if let Some(id) = obj.get("id") {
                        out.insert("id".into(), id.clone());
                    }
                    out.insert(
                        "message".into(),
                        compact_tool_result_message(msg, projection, raw_range),
                    );
                    serde_json::to_string(&Value::Object(out))
                        .map(CompactLineResult::Emit)
                        .unwrap_or(CompactLineResult::Drop)
                }
                "assistant" => {
                    if kind == "message_start" {
                        return CompactLineResult::AssistantMessageStart(
                            r#"{"type":"message_start","message":{"role":"assistant"}}"#.to_string(),
                        );
                    }
                    let Some(msg) = obj.get("message").and_then(Value::as_object) else {
                        return CompactLineResult::Drop;
                    };
                    let summary = compact_assistant_message(msg, projection);
                    let mut out = Map::new();
                    out.insert("type".into(), Value::String(kind.to_string()));
                    if let Some(id) = obj.get("id") {
                        out.insert("id".into(), id.clone());
                    }
                    if summary.has_raw_range {
                        out.insert(
                            "grapherRawRange".into(),
                            json!([raw_line_start as u64, raw_line_end as u64]),
                        );
                    }
                    out.insert("message".into(), summary.value.clone());
                    match serde_json::to_string(&Value::Object(out)) {
                        Ok(serialized) if kind == "message_end" => {
                            CompactLineResult::AssistantMessageEnd(serialized, summary)
                        }
                        Ok(serialized) => CompactLineResult::Emit(serialized),
                        Err(_) => CompactLineResult::Drop,
                    }
                }
                _ => CompactLineResult::Emit(trimmed.to_string()),
            }
        }
        "extension_error"
        | "compaction"
        | "compaction_start"
        | "compaction_end"
        | "grapher_process_started"
        | "grapher_process_exited"
        | "grapher_planning_source"
        | "session" => CompactLineResult::Emit(trimmed.to_string()),
        _ => CompactLineResult::Drop,
    }
}

/// Compact a raw UTF-8 log slice starting at `base_offset` with an explicit projection
/// and settled-deduplication flag.
pub fn compact_transcript_chunk_with_options(
    raw: &str,
    base_offset: usize,
    leading_fragment: bool,
    projection: TranscriptProjection,
    settled: bool,
) -> String {
    let mut out = String::new();
    let mut in_final_response = false;
    let mut offset = base_offset;
    let mut first = true;
    let mut pending = PendingTurnBuffer::default();

    for segment in raw.split_inclusive('\n') {
        let line_offset = offset;
        offset += segment.len();
        let line_end = offset;
        let has_newline = segment.ends_with('\n');
        let line = segment.strip_suffix('\n').unwrap_or(segment);
        let clean = line.strip_suffix('\r').unwrap_or(line);

        if first && leading_fragment {
            first = false;
            continue;
        }
        first = false;

        let trimmed = clean.trim();
        if trimmed.is_empty() {
            if in_final_response {
                out.push('\n');
            }
            continue;
        }

        if in_final_response {
            if trimmed.starts_with('{')
                && trimmed.contains(r#""grapher_planning_source""#)
                && serde_json::from_str::<Value>(trimmed)
                    .ok()
                    .and_then(|v| {
                        v.get("type")
                            .and_then(Value::as_str)
                            .map(|t| t == "grapher_planning_source")
                    })
                    .unwrap_or(false)
            {
                in_final_response = false;
                out.push_str(trimmed);
                out.push('\n');
            } else {
                out.push_str(clean);
                if has_newline {
                    out.push('\n');
                }
            }
            continue;
        }

        if trimmed == FINAL_RESPONSE_MARKER
            || strip_ansi_csi(trimmed).trim() == FINAL_RESPONSE_MARKER
        {
            pending.flush_all(&mut out);
            in_final_response = true;
            out.push_str(clean);
            out.push('\n');
            continue;
        }

        if trimmed.starts_with('{') {
            match compact_json_line(trimmed, line_offset, line_end, projection) {
                CompactLineResult::Drop => {}
                CompactLineResult::Emit(compacted) => {
                    pending.flush_all(&mut out);
                    out.push_str(&compacted);
                    out.push('\n');
                }
                CompactLineResult::AssistantMessageStart(compacted) => {
                    pending.flush_all(&mut out);
                    out.push_str(&compacted);
                    out.push('\n');
                }
                CompactLineResult::AssistantUpdate(update) => {
                    if settled {
                        if let UpdateKind::TextDelta { len, has_think_tag } = update.kind {
                            pending.text_delta_len += len;
                            pending.has_think_tag |= has_think_tag;
                        }
                        pending.lines.push(update);
                    } else {
                        out.push_str(&update.serialized);
                        out.push('\n');
                    }
                }
                CompactLineResult::AssistantMessageEnd(compacted, summary) => {
                    if settled {
                        pending.flush_non_subsumed(&summary, &mut out);
                    } else {
                        pending.flush_all(&mut out);
                    }
                    out.push_str(&compacted);
                    out.push('\n');
                }
            }
        } else {
            pending.flush_all(&mut out);
            // Plain stdout / [stderr] lines stay intact.
            out.push_str(clean);
            if has_newline {
                out.push('\n');
            }
        }
    }

    pending.flush_all(&mut out);
    out
}

/// Backward-compatible wrapper for Summary projection without settled deduplication.
pub fn compact_transcript_chunk(raw: &str, base_offset: usize, leading_fragment: bool) -> String {
    compact_transcript_chunk_with_options(
        raw,
        base_offset,
        leading_fragment,
        TranscriptProjection::Summary,
        false,
    )
}

/// Compact a forward raw slice `[start_offset .. start_offset + raw.len()]`.
/// When `reached_eof` is false, stops at the last newline so a JSONL line split
/// by the forward read ceiling is resumed cleanly on the next poll.
pub fn compact_forward_chunk_with_options(
    raw: &str,
    start_offset: usize,
    reached_eof: bool,
    projection: TranscriptProjection,
    settled: bool,
) -> (String, usize) {
    if raw.is_empty() {
        return (String::new(), 0);
    }
    let slice = if reached_eof {
        raw
    } else if let Some(last_nl) = raw.rfind('\n') {
        &raw[..=last_nl]
    } else {
        // A single line exceeded the forward chunk ceiling without a newline.
        // Advance past it instead of stalling at `consumed == 0`, and drop
        // truncated JSONL event fragments rather than emitting raw JSON text.
        if raw.trim_start().starts_with('{') {
            return (String::new(), raw.len());
        }
        raw
    };
    (
        compact_transcript_chunk_with_options(slice, start_offset, false, projection, settled),
        slice.len(),
    )
}

pub fn compact_forward_chunk(raw: &str, start_offset: usize, reached_eof: bool) -> (String, usize) {
    compact_forward_chunk_with_options(
        raw,
        start_offset,
        reached_eof,
        TranscriptProjection::Summary,
        false,
    )
}

/// Scan backward from `end` in raw chunks, projecting until `compact_limit` bytes
/// of projected output have been produced, `0` is reached, or `MAX_COMPACT_RAW_SCAN_BYTES`
/// of raw bytes have been inspected. Returns `(projected_content, start_offset)` where
/// `start_offset` is aligned to an exact line boundary (or `0`).
pub fn compact_tail_pages_with_options<F>(
    end: usize,
    compact_limit: usize,
    projection: TranscriptProjection,
    settled: bool,
    mut read_raw_tail: F,
) -> Result<(String, usize), String>
where
    F: FnMut(usize, usize) -> Result<(usize, String), String>,
{
    if end == 0 {
        return Ok((String::new(), 0));
    }
    let mut cursor = end;
    let mut tail_carry = String::new();
    let mut tail_carry_bytes = 0usize;
    let mut chunks: Vec<String> = Vec::new();
    let mut compacted_bytes = 0usize;
    let mut raw_scanned = 0usize;

    while cursor > 0 && compacted_bytes < compact_limit && raw_scanned < MAX_COMPACT_RAW_SCAN_BYTES
    {
        let (chunk_start, raw) = read_raw_tail(cursor, COMPACT_RAW_CHUNK_BYTES)?;
        if chunk_start >= cursor || raw.is_empty() {
            break;
        }
        raw_scanned += cursor - chunk_start;
        let combined = if tail_carry.is_empty() {
            raw
        } else {
            let mut merged = String::with_capacity(raw.len() + tail_carry.len());
            merged.push_str(&raw);
            merged.push_str(&tail_carry);
            merged
        };
        tail_carry.clear();
        tail_carry_bytes = 0;

        if chunk_start == 0 {
            let compacted =
                compact_transcript_chunk_with_options(&combined, 0, false, projection, settled);
            if !compacted.is_empty() {
                chunks.push(compacted);
            }
            cursor = 0;
            break;
        }

        if let Some(first_nl) = combined.find('\n') {
            let prefix_len = first_nl + 1;
            let body = &combined[prefix_len..];
            if !body.is_empty() {
                let compacted = compact_transcript_chunk_with_options(
                    body,
                    chunk_start + prefix_len,
                    false,
                    projection,
                    settled,
                );
                compacted_bytes += compacted.len();
                if !compacted.is_empty() {
                    chunks.push(compacted);
                }
            }
            if prefix_len <= MAX_SPLIT_LINE_CARRY_BYTES {
                tail_carry = combined[..prefix_len].to_string();
                tail_carry_bytes = prefix_len;
            }
        } else if combined.len() <= MAX_SPLIT_LINE_CARRY_BYTES {
            tail_carry = combined;
            tail_carry_bytes = tail_carry.len();
        }
        cursor = chunk_start;
    }

    let start_offset = if cursor == 0 {
        0
    } else if cursor + tail_carry_bytes < end {
        cursor + tail_carry_bytes
    } else {
        cursor
    };
    let total_len: usize = chunks.iter().map(String::len).sum();
    let mut result = String::with_capacity(total_len);
    for chunk in chunks.into_iter().rev() {
        result.push_str(&chunk);
    }
    Ok((result, start_offset))
}

pub fn compact_tail_pages<F>(
    end: usize,
    compact_limit: usize,
    read_raw_tail: F,
) -> Result<(String, usize), String>
where
    F: FnMut(usize, usize) -> Result<(usize, String), String>,
{
    compact_tail_pages_with_options(
        end,
        compact_limit,
        TranscriptProjection::Summary,
        false,
        read_raw_tail,
    )
}

/// Hydrate selected raw JSONL line(s) for on-demand card expansion, applying
/// server-side 100 KiB display truncation so multi-MB outputs never cross the
/// HTTP/IPC boundary only to be truncated by the browser.
pub fn hydrate_raw_slice(raw: &str, base_offset: usize) -> String {
    let mut out = String::new();
    let mut offset = base_offset;
    for segment in raw.split_inclusive('\n') {
        let line_start = offset;
        offset += segment.len();
        let line_end = offset;
        let line = segment.strip_suffix('\n').unwrap_or(segment);
        let trimmed = line.strip_suffix('\r').unwrap_or(line).trim();
        if !trimmed.starts_with('{') {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(obj) = parsed.as_object() else {
            continue;
        };
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        let hydrated = match kind {
            "tool_execution_start" => {
                let mut next = Map::new();
                next.insert("type".into(), Value::String("tool_execution_start".into()));
                for key in ["toolCallId", "toolName"] {
                    if let Some(val) = obj.get(key) {
                        next.insert(key.into(), val.clone());
                    }
                }
                if let Some(args) = obj.get("args") {
                    let (bounded, truncated) = truncate_json_strings(args, DISPLAY_TOOL_PREVIEW_BYTES);
                    next.insert("args".into(), bounded);
                    if truncated || obj.get("argsTruncated").and_then(Value::as_bool) == Some(true) {
                        next.insert("argsTruncated".into(), Value::Bool(true));
                    }
                }
                next.insert(
                    "grapherRawRange".into(),
                    json!([line_start as u64, line_end as u64]),
                );
                Some(Value::Object(next))
            }
            "tool_execution_end" => {
                let mut next = Map::new();
                next.insert("type".into(), Value::String("tool_execution_end".into()));
                for key in ["toolCallId", "toolName", "isError", "durationMs"] {
                    if let Some(val) = obj.get(key) {
                        next.insert(key.into(), val.clone());
                    }
                }
                if let Some(result_obj) = obj.get("result").and_then(Value::as_object) {
                    let mut result_next = Map::new();
                    if let Some(content) = result_obj.get("content") {
                        result_next.insert(
                            "content".into(),
                            truncate_result_content(content, DISPLAY_TOOL_PREVIEW_BYTES),
                        );
                    }
                    if let Some(details) = result_obj.get("details") {
                        result_next.insert("details".into(), details.clone());
                    }
                    if let Some(is_error) = result_obj.get("isError") {
                        result_next.insert("isError".into(), is_error.clone());
                    }
                    next.insert("result".into(), Value::Object(result_next));
                }
                next.insert(
                    "grapherRawRange".into(),
                    json!([line_start as u64, line_end as u64]),
                );
                Some(Value::Object(next))
            }
            "message_update" => {
                let Some(inner) = obj.get("assistantMessageEvent").and_then(Value::as_object) else {
                    continue;
                };
                if inner.get("type").and_then(Value::as_str) != Some("toolcall_end") {
                    continue;
                }
                let Some(tool) = inner.get("toolCall").and_then(Value::as_object) else {
                    continue;
                };
                let mut tool_next = Map::new();
                tool_next.insert("type".into(), Value::String("toolCall".into()));
                for key in ["id", "name"] {
                    if let Some(val) = tool.get(key) {
                        tool_next.insert(key.into(), val.clone());
                    }
                }
                if let Some(args) = tool.get("arguments").or_else(|| tool.get("args")) {
                    let (bounded, truncated) = truncate_json_strings(args, DISPLAY_TOOL_PREVIEW_BYTES);
                    tool_next.insert("arguments".into(), bounded);
                    if truncated || tool.get("argsTruncated").and_then(Value::as_bool) == Some(true) {
                        tool_next.insert("argsTruncated".into(), Value::Bool(true));
                    }
                }
                let mut inner_next = Map::new();
                inner_next.insert("type".into(), Value::String("toolcall_end".into()));
                if let Some(ci) = inner.get("contentIndex") {
                    inner_next.insert("contentIndex".into(), ci.clone());
                }
                inner_next.insert("toolCall".into(), Value::Object(tool_next));
                Some(json!({
                    "type": "message_update",
                    "assistantMessageEvent": Value::Object(inner_next),
                    "grapherRawRange": [line_start as u64, line_end as u64],
                }))
            }
            "message_end" | "message" => {
                let Some(msg) = obj.get("message").and_then(Value::as_object) else {
                    continue;
                };
                let role = msg.get("role").and_then(Value::as_str).unwrap_or("");
                match role {
                    "assistant" => {
                        let mut msg_next = Map::new();
                        msg_next.insert("role".into(), Value::String("assistant".into()));
                        if let Some(Value::Array(parts)) = msg.get("content") {
                            let mut parts_next = Vec::with_capacity(parts.len());
                            for part in parts {
                                let Some(p) = part.as_object() else {
                                    continue;
                                };
                                match p.get("type").and_then(Value::as_str) {
                                    Some("thinking") => {
                                        let thinking = p
                                            .get("thinking")
                                            .and_then(Value::as_str)
                                            .unwrap_or("");
                                        parts_next.push(json!({
                                            "type": "thinking",
                                            "thinking": thinking,
                                        }));
                                    }
                                    Some("toolCall") => {
                                        let mut block = Map::new();
                                        block.insert("type".into(), Value::String("toolCall".into()));
                                        for key in ["id", "name"] {
                                            if let Some(val) = p.get(key) {
                                                block.insert(key.into(), val.clone());
                                            }
                                        }
                                        if let Some(args) = p.get("arguments").or_else(|| p.get("args")) {
                                            let (bounded, truncated) =
                                                truncate_json_strings(args, DISPLAY_TOOL_PREVIEW_BYTES);
                                            block.insert("arguments".into(), bounded);
                                            if truncated
                                                || p.get("argsTruncated").and_then(Value::as_bool)
                                                    == Some(true)
                                            {
                                                block.insert("argsTruncated".into(), Value::Bool(true));
                                            }
                                        }
                                        parts_next.push(Value::Object(block));
                                    }
                                    Some("text") => {
                                        // Preserve original array indices so contentIndex matches!
                                        parts_next.push(json!({ "type": "text", "text": "" }));
                                    }
                                    _ => {
                                        parts_next.push(json!({ "type": "other" }));
                                    }
                                }
                            }
                            msg_next.insert("content".into(), Value::Array(parts_next));
                        }
                        Some(json!({
                            "type": kind,
                            "message": Value::Object(msg_next),
                            "grapherRawRange": [line_start as u64, line_end as u64],
                        }))
                    }
                    "toolResult" => {
                        let mut msg_next = Map::new();
                        msg_next.insert("role".into(), Value::String("toolResult".into()));
                        for key in ["toolCallId", "toolName", "isError", "durationMs", "details"] {
                            if let Some(val) = msg.get(key) {
                                msg_next.insert(key.into(), val.clone());
                            }
                        }
                        if let Some(content) = msg.get("content") {
                            msg_next.insert(
                                "content".into(),
                                truncate_result_content(content, DISPLAY_TOOL_PREVIEW_BYTES),
                            );
                        }
                        Some(json!({
                            "type": kind,
                            "message": Value::Object(msg_next),
                            "grapherRawRange": [line_start as u64, line_end as u64],
                        }))
                    }
                    _ => None,
                }
            }
            _ => None,
        };
        if let Some(val) = hydrated {
            if let Ok(text) = serde_json::to_string(&val) {
                out.push_str(&text);
                out.push('\n');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_tool_results_thinking_and_updates_while_keeping_text_and_metadata() {
        let huge_output = "A".repeat(50_000);
        let huge_thinking = "T".repeat(20_000);
        let huge_write = "W".repeat(30_000);
        let raw = [
            serde_json::to_string(&json!({
                "type": "message_end",
                "message": { "role": "user", "content": [{ "type": "text", "text": "Fix bug" }] }
            }))
            .unwrap(),
            serde_json::to_string(&json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "thinking_delta", "delta": "step", "partial": { "content": [{ "type": "thinking", "thinking": huge_thinking }] } }
            }))
            .unwrap(),
            serde_json::to_string(&json!({
                "type": "tool_execution_start",
                "toolCallId": "call-1",
                "toolName": "write",
                "args": { "path": "src/app.ts", "content": huge_write }
            }))
            .unwrap(),
            serde_json::to_string(&json!({
                "type": "tool_execution_update",
                "toolCallId": "call-1",
                "toolName": "bash",
                "partialResult": { "content": [{ "type": "text", "text": huge_output }] }
            }))
            .unwrap(),
            serde_json::to_string(&json!({
                "type": "tool_execution_end",
                "toolCallId": "call-1",
                "toolName": "write",
                "isError": false,
                "result": { "content": [{ "type": "text", "text": huge_output }], "details": { "exitCode": 0 } }
            }))
            .unwrap(),
            serde_json::to_string(&json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": huge_thinking },
                        { "type": "toolCall", "id": "call-1", "name": "write", "arguments": { "path": "src/app.ts", "content": huge_write } },
                        { "type": "text", "text": "Updated src/app.ts cleanly." }
                    ]
                }
            }))
            .unwrap(),
        ]
        .join("\n")
            + "\n";

        let compacted = compact_transcript_chunk(&raw, 100, false);
        assert!(compacted.len() < 1600, "compacted len={}", compacted.len());
        assert!(!compacted.contains("AAAA"));
        assert!(!compacted.contains("TTTT"));
        assert!(!compacted.contains("WWWW"));
        assert!(compacted.contains("Updated src/app.ts cleanly."));
        assert!(compacted.contains(r#""path":"src/app.ts""#));
        assert!(compacted.contains(r#""grapherByteOffset":100"#));
        assert!(compacted.contains(r#""grapherRawRange":"#));
        assert!(compacted.contains(r#""grapherBodyOmitted":true"#));
    }

    #[test]
    fn settled_deduplicates_streaming_deltas_subsumed_by_message_end() {
        let raw = [
            serde_json::to_string(&json!({
                "type": "message_start",
                "message": { "role": "assistant" }
            }))
            .unwrap(),
            serde_json::to_string(&json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "thinking_start", "contentIndex": 0 }
            }))
            .unwrap(),
            serde_json::to_string(&json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "thinking_end", "contentIndex": 0 }
            }))
            .unwrap(),
            serde_json::to_string(&json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "text_delta", "delta": "Hello " }
            }))
            .unwrap(),
            serde_json::to_string(&json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "text_delta", "delta": "world!" }
            }))
            .unwrap(),
            serde_json::to_string(&json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": "Step by step" },
                        { "type": "text", "text": "Hello world!" }
                    ]
                }
            }))
            .unwrap(),
        ]
        .join("\n")
            + "\n";

        let settled_summary = compact_transcript_chunk_with_options(
            &raw,
            0,
            false,
            TranscriptProjection::Summary,
            true,
        );
        assert!(!settled_summary.contains("text_delta"));
        assert!(!settled_summary.contains("thinking_start"));
        assert!(!settled_summary.contains("thinking_end"));
        assert!(settled_summary.contains("Hello world!"));

        // Interrupted turn without message_end retains its streamed deltas.
        let interrupted = [
            serde_json::to_string(&json!({
                "type": "message_start",
                "message": { "role": "assistant" }
            }))
            .unwrap(),
            serde_json::to_string(&json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "text_delta", "delta": "Partial reply" }
            }))
            .unwrap(),
        ]
        .join("\n")
            + "\n";
        let settled_interrupted = compact_transcript_chunk_with_options(
            &interrupted,
            0,
            false,
            TranscriptProjection::Summary,
            true,
        );
        assert!(settled_interrupted.contains("Partial reply"));
    }

    #[test]
    fn card_shell_keeps_small_cards_inline_and_omits_large_bodies_with_flags() {
        let big_output = format!("{}\nnot ok 1 - failing check\n", "X".repeat(4000));
        let big_thinking = "R".repeat(4000);
        let raw = [
            serde_json::to_string(&json!({
                "type": "tool_execution_start",
                "toolCallId": "small-1",
                "toolName": "read",
                "args": { "path": "Cargo.toml", "offset": 1 }
            }))
            .unwrap(),
            serde_json::to_string(&json!({
                "type": "tool_execution_end",
                "toolCallId": "small-1",
                "toolName": "read",
                "isError": false,
                "result": { "content": [{ "type": "text", "text": "small file body" }] }
            }))
            .unwrap(),
            serde_json::to_string(&json!({
                "type": "tool_execution_end",
                "toolCallId": "big-1",
                "toolName": "bash",
                "isError": false,
                "result": { "content": [{ "type": "text", "text": big_output }], "details": { "exitCode": 0 } }
            }))
            .unwrap(),
            serde_json::to_string(&json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": "short thought" },
                        { "type": "thinking", "thinking": big_thinking },
                        { "type": "text", "text": "Done." }
                    ]
                }
            }))
            .unwrap(),
        ]
        .join("\n")
            + "\n";

        let projected = compact_transcript_chunk_with_options(
            &raw,
            0,
            false,
            TranscriptProjection::CardShell,
            true,
        );
        assert!(projected.contains("small file body"));
        assert!(projected.contains("short thought"));
        assert!(!projected.contains("XXXX"));
        assert!(!projected.contains("RRRR"));
        assert!(projected.contains(r#""grapherSubcommandWarning":true"#));
        assert!(projected.contains(r#""grapherThinkingChars":4000"#));

        // Hydrate the exact big tool_execution_end line and verify server-side truncation.
        let big_line: Value = projected
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .find(|v| v["toolCallId"] == "big-1")
            .unwrap();
        let range = big_line["grapherRawRange"].as_array().unwrap();
        let start = range[0].as_u64().unwrap() as usize;
        let end = range[1].as_u64().unwrap() as usize;
        let hydrated = hydrate_raw_slice(&raw[start..end], start);
        assert!(hydrated.contains("not ok 1 - failing check"));
        assert!(hydrated.contains(&"X".repeat(200)));
    }

    #[test]
    fn hydrate_raw_slice_caps_oversized_tool_output_at_100kb_utf8_safely() {
        let huge = "中".repeat(60_000); // ~180 KiB UTF-8
        let raw = format!(
            "{}\n",
            serde_json::to_string(&json!({
                "type": "tool_execution_end",
                "toolCallId": "huge-1",
                "toolName": "bash",
                "result": { "content": [{ "type": "text", "text": huge }] }
            }))
            .unwrap()
        );
        let hydrated = hydrate_raw_slice(&raw, 0);
        let parsed: Value = serde_json::from_str(hydrated.trim()).unwrap();
        let text = parsed["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.len() <= DISPLAY_TOOL_PREVIEW_BYTES);
        assert!(text.ends_with("\n..."));
    }

    #[test]
    fn compact_tail_pages_reassembles_lines_split_across_raw_chunks() {
        let mut raw = String::new();
        for idx in 0..30 {
            raw.push_str(
                &serde_json::to_string(&json!({
                    "type": "tool_execution_end",
                    "toolCallId": format!("call-{idx}"),
                    "toolName": "read",
                    "result": { "content": [{ "type": "text", "text": "R".repeat(400) }] }
                }))
                .unwrap(),
            );
            raw.push('\n');
            raw.push_str(
                &serde_json::to_string(&json!({
                    "type": "message_end",
                    "message": { "role": "assistant", "content": [{ "type": "text", "text": format!("Answer {idx}") }] }
                }))
                .unwrap(),
            );
            raw.push('\n');
        }
        // Force tiny 257-byte raw slices that split JSONL lines mid-record.
        let bytes = raw.as_bytes();
        let (compacted, start) = compact_tail_pages(bytes.len(), 64 * 1024, |before, _limit| {
            let mut s = before.saturating_sub(257);
            while s > 0 && !raw.is_char_boundary(s) {
                s -= 1;
            }
            Ok((s, raw[s..before].to_string()))
        })
        .unwrap();
        assert_eq!(start, 0);
        assert!(!compacted.contains("RRRR"));
        for idx in 0..30 {
            assert!(
                compacted.contains(&format!("Answer {idx}")),
                "missing Answer {idx}"
            );
        }
    }

    #[test]
    fn forward_and_tail_handle_ansi_final_response_and_oversized_incomplete_json() {
        let ansi_final = "\x1b[2m── Final response ──\x1b[0m\nVisible summary line\n";
        let compacted = compact_transcript_chunk(ansi_final, 0, false);
        assert!(compacted.contains("Visible summary line"));

        // Truncated giant JSONL line in a non-EOF forward chunk advances cursor without emitting raw JSON.
        let giant_fragment =
            format!(r#"{{"type":"tool_execution_end","result":"{}"#, "Z".repeat(5000));
        let (out, consumed) = compact_forward_chunk(&giant_fragment, 0, false);
        assert_eq!(consumed, giant_fragment.len());
        assert!(out.is_empty());

        // Tail scan stops at cap on a giant newline-free blob and still moves start_offset strictly backward.
        let blob = "B".repeat(2048);
        let (_text, start) = compact_tail_pages(blob.len(), 64, |before, _limit| {
            Ok((
                before.saturating_sub(1024),
                blob[before.saturating_sub(1024)..before].to_string(),
            ))
        })
        .unwrap();
        assert!(start < blob.len());
    }
}
