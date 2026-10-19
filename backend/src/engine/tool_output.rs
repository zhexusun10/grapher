//! Projection of Pi events into Grapher's display log, never back into Pi.
//! Cumulative progress snapshots are redundant with the start/end records and
//! can otherwise turn a single long-running tool into hundreds of MB of logs.
use serde_json::{json, Value};
use std::collections::HashSet;

const PREVIEW_BYTES: usize = 100 * 1024;
const ELLIPSIS: &str = "\n...";

#[derive(Default)]
pub(super) struct ToolOutputProjection {
    progress_seen: HashSet<String>,
}

impl ToolOutputProjection {
    /// False means a redundant progress event has no display-log payload.
    pub(super) fn project(&mut self, event: &mut Value) -> bool {
        match event["type"].as_str().unwrap_or_default() {
            "message_update" => {
                // Usage is authoritative on message_end, not on every token.
                // The UI uses complete tool args from toolcall_end/start, not
                // the partial JSON fragments emitted while generating them.
                if let Some(object) = event.as_object_mut() { object.remove("usage"); }
                let update = &mut event["assistantMessageEvent"];
                match update["type"].as_str() {
                    Some("toolcall_delta") => return false,
                    Some("text_delta" | "thinking_delta") => {
                        // Some Pi transports also repeat cumulative snapshots;
                        // these consumers only need the lossless delta itself.
                        if let Some(object) = update.as_object_mut() { object.remove("partial"); }
                        if let Some(object) = event.as_object_mut() { object.remove("message"); }
                    }
                    _ => {}
                }
            }
            "tool_execution_start" => {
                if let Some(id) = event["toolCallId"].as_str() { self.progress_seen.remove(id); }
            }
            "tool_execution_update" => {
                if let Some(id) = event["toolCallId"].as_str() {
                    if !self.progress_seen.insert(id.to_owned()) { return false; }
                }
                // Keep one identity/args record for a tail that starts mid-tool,
                // but never persist repeated, cumulative partial-result bodies.
                if let Some(object) = event.as_object_mut() { object.remove("partialResult"); }
            }
            "tool_execution_end" => {
                if let Some(id) = event["toolCallId"].as_str() { self.progress_seen.remove(id); }
                if let Some(result) = event.get_mut("result") { limit_result(result); }
            }
            _ => {}
        }
        // Pi repeats tool results in message and aggregate lifecycle records.
        // Limit every copy, not just tool_execution_end, while retaining errors,
        // assistant replies, exit status and timing for runtime consumers.
        if let Some(message) = event.get_mut("message") { limit_message(message); }
        for key in ["messages", "toolResults"] {
            if let Some(messages) = event.get_mut(key).and_then(Value::as_array_mut) {
                for message in messages { limit_message(message); }
            }
        }
        // `write`/`edit` arguments carry whole file bodies; the browser only
        // needs a preview and would otherwise hold megabytes per card.
        limit_arguments(event);
        true
    }
}

fn limit_message(message: &mut Value) {
    if message["role"] == "toolResult" { limit_result(message); }
}

fn limit_result(result: &mut Value) {
    let Some(content) = result.get_mut("content") else { return; };
    if !limit_content(content) { return; }
    let Some(object) = result.as_object_mut() else { return; };
    let details = object.entry("details").or_insert_with(|| json!({}));
    if !details.is_object() { *details = json!({}); }
    details["truncated"] = true.into();
}

/// Bound every `args`/`arguments` subtree in place and mark its owner so the UI
/// can report the preview. The JSON shape, keys and small values stay intact.
fn limit_arguments(value: &mut Value) {
    match value {
        Value::Object(object) => {
            let mut truncated = false;
            for key in ["args", "arguments"] {
                if let Some(arguments) = object.get_mut(key) {
                    truncated |= limit_strings(arguments);
                }
            }
            if truncated { object.insert("argsTruncated".into(), true.into()); }
            for child in object.values_mut() { limit_arguments(child); }
        }
        Value::Array(items) => {
            for item in items { limit_arguments(item); }
        }
        _ => {}
    }
}

fn limit_strings(value: &mut Value) -> bool {
    match value {
        Value::String(text) => {
            if text.len() <= PREVIEW_BYTES { return false; }
            let mut end = PREVIEW_BYTES - ELLIPSIS.len();
            while !text.is_char_boundary(end) { end -= 1; }
            text.truncate(end);
            text.push_str(ELLIPSIS);
            true
        }
        Value::Array(items) => {
            let mut changed = false;
            for item in items { changed |= limit_strings(item); }
            changed
        }
        Value::Object(map) => {
            let mut changed = false;
            for item in map.values_mut() { changed |= limit_strings(item); }
            changed
        }
        _ => false,
    }
}

fn limit_content(content: &mut Value) -> bool {
    let texts: Vec<&str> = match content {
        Value::String(text) => vec![text.as_str()],
        Value::Array(parts) => parts.iter().filter(|part| part["type"] == "text")
            .map(|part| part["text"].as_str().unwrap_or_default()).collect(),
        _ => return false,
    };
    let total = texts.iter().fold(0usize, |sum, text| sum.saturating_add(text.len()))
        .saturating_add(texts.len().saturating_sub(1));
    if total <= PREVIEW_BYTES { return false; }
    let mut preview = String::with_capacity(PREVIEW_BYTES);
    let head_limit = PREVIEW_BYTES - ELLIPSIS.len();
    for (index, text) in texts.iter().enumerate() {
        if preview.len() == head_limit { break; }
        if index > 0 { preview.push('\n'); }
        let mut end = text.len().min(head_limit - preview.len());
        while !text.is_char_boundary(end) { end -= 1; }
        preview.push_str(&text[..end]);
        if end < text.len() { break; }
    }
    preview.push_str(ELLIPSIS);
    *content = if content.is_string() { preview.into() }
        else { json!([{ "type": "text", "text": preview }]) };
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_output_projection_removes_unused_stream_copies_but_keeps_final_usage_and_args() {
        let mut projection = ToolOutputProjection::default();
        for kind in ["text_delta", "thinking_delta"] {
            let mut event = json!({ "type": "message_update", "usage": { "totalTokens": 42 },
                "message": { "content": "repeated snapshot" },
                "assistantMessageEvent": { "type": kind, "contentIndex": 2, "delta": "完整🚀",
                    "partial": { "content": "another repeated snapshot" } } });
            assert!(projection.project(&mut event));
            assert!(event.get("usage").is_none());
            assert!(event.get("message").is_none());
            assert!(event["assistantMessageEvent"].get("partial").is_none());
            assert_eq!(event["assistantMessageEvent"]["delta"], "完整🚀");
            assert_eq!(event["assistantMessageEvent"]["contentIndex"], 2);
        }
        let mut fragment = json!({ "type": "message_update", "assistantMessageEvent": {
            "type": "toolcall_delta", "contentIndex": 0, "delta": "partial JSON" } });
        assert!(!projection.project(&mut fragment));
        let mut complete = json!({ "type": "message_update", "assistantMessageEvent": {
            "type": "toolcall_end", "contentIndex": 0,
            "toolCall": { "id": "tool", "name": "bash", "arguments": { "command": "echo kept" } } } });
        let original = complete.clone();
        assert!(projection.project(&mut complete));
        assert_eq!(complete, original);
        let mut final_event = json!({ "type": "message_end", "message": { "role": "assistant",
            "usage": { "input": 7, "output": 3, "totalTokens": 10 }, "stopReason": "error", "errorMessage": "kept" } });
        let original = final_event.clone();
        assert!(projection.project(&mut final_event));
        assert_eq!(final_event, original);
    }

    #[test]
    fn tool_output_projection_bounds_utf8_body_and_keeps_failure_and_timing() {
        let original = json!({ "type": "tool_execution_end", "toolCallId": "one", "toolName": "bash",
            "durationMs": 1234, "isError": true,
            "result": { "content": [{ "type": "text", "text": "中文🚀".repeat(PREVIEW_BYTES) }],
                "isError": true, "details": { "exitCode": 2, "other": "retained" } } });
        let mut event = original.clone();
        assert!(ToolOutputProjection::default().project(&mut event));
        let preview = event["result"]["content"][0]["text"].as_str().unwrap();
        assert!(preview.len() <= PREVIEW_BYTES);
        assert!(preview.ends_with("\n..."));
        assert_eq!(event["result"]["details"]["truncated"], true);
        assert_eq!(event["result"]["details"]["exitCode"], 2);
        assert_eq!(event["result"]["details"]["other"], "retained");
        assert_eq!(event["durationMs"], 1234);
        assert_eq!(event["isError"], true);
        assert!(original["result"]["content"][0]["text"].as_str().unwrap().len() > PREVIEW_BYTES);
    }

    #[test]
    fn tool_output_projection_bounds_arguments_and_keeps_small_values() {
        let mut event = json!({ "type": "tool_execution_start", "toolCallId": "write",
            "toolName": "write",
            "args": { "path": "src/big.ts", "content": "中🚀".repeat(PREVIEW_BYTES) } });
        assert!(ToolOutputProjection::default().project(&mut event));
        assert_eq!(event["args"]["path"], "src/big.ts");
        let content = event["args"]["content"].as_str().unwrap();
        assert!(content.len() <= PREVIEW_BYTES);
        assert!(content.ends_with("\n..."));
        assert_eq!(event["argsTruncated"], true);

        let mut message = json!({ "type": "message",
            "message": { "role": "assistant", "content": [
                { "type": "toolCall", "id": "t", "name": "write",
                    "arguments": { "path": "a", "content": "x".repeat(PREVIEW_BYTES + 1) } },
                { "type": "text", "text": "kept" }
            ] } });
        assert!(ToolOutputProjection::default().project(&mut message));
        let part = &message["message"]["content"][0];
        assert_eq!(part["argsTruncated"], true);
        assert_eq!(part["name"], "write");
        assert_eq!(part["arguments"]["path"], "a");
        assert!(part["arguments"]["content"].as_str().unwrap().len() <= PREVIEW_BYTES);
        assert_eq!(message["message"]["content"][1]["text"], "kept");

        // Small arguments stay byte-identical and unmarked.
        let mut small = json!({ "type": "tool_execution_start", "toolCallId": "bash",
            "args": { "command": "npm test" } });
        assert!(ToolOutputProjection::default().project(&mut small));
        assert_eq!(small["args"], json!({ "command": "npm test" }));
        assert!(small.get("argsTruncated").is_none());
    }

    #[test]
    fn tool_output_projection_drops_repeated_cumulative_progress() {
        let mut projection = ToolOutputProjection::default();
        for index in 0..1000 {
            let mut event = json!({ "type": "tool_execution_update", "toolCallId": "one", "toolName": "bash",
                "args": { "command": "long job" }, "partialResult": { "content": "x".repeat(PREVIEW_BYTES) } });
            assert_eq!(projection.project(&mut event), index == 0);
            if index == 0 {
                assert_eq!(event["toolName"], "bash");
                assert_eq!(event["args"]["command"], "long job");
                assert!(event.get("partialResult").is_none());
                assert!(event.to_string().len() < 1024);
            }
        }
        let mut another = json!({ "type": "tool_execution_update", "toolCallId": "two" });
        assert!(projection.project(&mut another));
        let mut start = json!({ "type": "tool_execution_start", "toolCallId": "one" });
        assert!(projection.project(&mut start));
        let mut reused = json!({ "type": "tool_execution_update", "toolCallId": "one" });
        assert!(projection.project(&mut reused));
    }

    #[test]
    fn tool_output_projection_limits_aggregate_copies_but_not_assistant_messages() {
        let tool = json!({ "role": "toolResult", "toolCallId": "one", "content": "x".repeat(PREVIEW_BYTES + 1), "isError": true });
        let assistant = json!({ "role": "assistant", "content": [{ "type": "text", "text": "a".repeat(PREVIEW_BYTES + 1) }] });
        let mut event = json!({ "type": "agent_end", "message": tool.clone(), "toolResults": [tool.clone()], "messages": [tool, assistant.clone()] });
        assert!(ToolOutputProjection::default().project(&mut event));
        for message in [&event["message"], &event["toolResults"][0], &event["messages"][0]] {
            let text = message["content"].as_str().unwrap();
            assert_eq!(text.len(), PREVIEW_BYTES);
            assert!(text.ends_with("\n..."));
            assert_eq!(message["details"]["truncated"], true);
            assert_eq!(message["isError"], true);
        }
        assert_eq!(event["messages"][1], assistant);
    }

    #[test]
    fn tool_output_projection_preserves_small_and_exact_limit_results() {
        for content in [json!("x".repeat(PREVIEW_BYTES)), json!([{ "type": "text", "text": "small" }]),
            json!([{ "type": "text", "text": "x".repeat(PREVIEW_BYTES / 2) }, { "type": "text", "text": "y".repeat(PREVIEW_BYTES / 2) }])] {
            let mut event = json!({ "type": "tool_execution_end", "result": { "content": content } });
            let original = event.clone();
            assert!(ToolOutputProjection::default().project(&mut event));
            if original["result"]["content"].is_array() && original["result"]["content"].as_array().unwrap().len() == 2 {
                assert!(event["result"]["content"][0]["text"].as_str().unwrap().len() <= PREVIEW_BYTES);
                assert_eq!(event["result"]["details"]["truncated"], true);
            } else { assert_eq!(event, original); }
        }
    }
}
