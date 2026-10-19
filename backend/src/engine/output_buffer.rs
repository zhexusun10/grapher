//! Coalesce tiny display-log deltas without changing Pi's session or text.
//! Lifecycle records and non-JSON output are ordering barriers; idle streams
//! flush on a short deadline, so an interrupted message still has a live tail.
use serde_json::Value;
use std::time::{Duration, Instant};

const DELTA_BYTES: usize = 4 * 1024;
const DELTA_INTERVAL: Duration = Duration::from_millis(50);
const READ_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Default)]
pub(super) struct OutputBuffer {
    pending: Option<Value>,
    since: Option<Instant>,
}

fn delta(event: &Value) -> Option<&str> {
    if event["type"] != "message_update" { return None; }
    let update = &event["assistantMessageEvent"];
    if !matches!(update["type"].as_str(), Some("text_delta" | "thinking_delta")) { return None; }
    update["delta"].as_str()
}

fn same_fields(left: &Value, right: &Value, ignored: &[&str]) -> bool {
    match (left.as_object(), right.as_object()) {
        (Some(left), Some(right)) => left.iter().filter(|(key, _)| !ignored.contains(&key.as_str()))
            .eq(right.iter().filter(|(key, _)| !ignored.contains(&key.as_str()))),
        _ => false,
    }
}

fn compatible(left: &Value, right: &Value) -> bool {
    same_fields(left, right, &["assistantMessageEvent", "grapherReceivedAt"])
        && same_fields(&left["assistantMessageEvent"], &right["assistantMessageEvent"], &["delta"])
}

fn emit(event: Value, output: &mut impl FnMut(String)) -> Result<(), String> {
    let mut line = serde_json::to_string(&event).map_err(|error| error.to_string())?;
    line.push('\n');
    output(line);
    Ok(())
}

impl OutputBuffer {
    pub(super) fn push(&mut self, event: Value, output: &mut impl FnMut(String)) -> Result<(), String> {
        self.flush_due(output)?;
        let Some(text) = delta(&event) else {
            self.flush(output)?;
            return emit(event, output);
        };
        if let Some(pending) = self.pending.as_mut() {
            let bytes = delta(pending).map_or(0, str::len);
            if compatible(pending, &event) && bytes.saturating_add(text.len()) <= DELTA_BYTES {
                if let Value::String(combined) = &mut pending["assistantMessageEvent"]["delta"] {
                    combined.push_str(text);
                }
                if bytes + text.len() == DELTA_BYTES { self.flush(output)?; }
                return Ok(());
            }
        }
        self.flush(output)?;
        // Never split or truncate an individual provider frame.
        if text.len() >= DELTA_BYTES { return emit(event, output); }
        self.pending = Some(event);
        self.since = Some(Instant::now());
        Ok(())
    }

    pub(super) fn wait_timeout(&self) -> Duration {
        self.since.map_or(READ_TIMEOUT, |since| DELTA_INTERVAL.saturating_sub(since.elapsed()))
    }

    pub(super) fn flush_due(&mut self, output: &mut impl FnMut(String)) -> Result<(), String> {
        if self.since.is_some_and(|since| since.elapsed() >= DELTA_INTERVAL) { self.flush(output)?; }
        Ok(())
    }

    pub(super) fn flush(&mut self, output: &mut impl FnMut(String)) -> Result<(), String> {
        self.since = None;
        if let Some(event) = self.pending.take() { emit(event, output)?; }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(kind: &str, index: usize, text: &str) -> Value {
        json!({ "type": "message_update", "grapherReceivedAt": 1,
            "assistantMessageEvent": { "type": kind, "contentIndex": index, "delta": text } })
    }

    #[test]
    fn output_buffer_coalesces_tiny_utf8_deltas_losslessly_and_bounds_size() {
        let mut buffer = OutputBuffer::default();
        let mut lines = Vec::new();
        let mut output = |line| lines.push(line);
        for index in 0..10_000 {
            let mut event = frame("thinking_delta", 0, "中文🚀");
            event["grapherReceivedAt"] = index.into();
            buffer.push(event, &mut output).unwrap();
        }
        buffer.flush(&mut output).unwrap();
        let events: Vec<Value> = lines.iter().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert!(events.len() < 100, "tiny deltas must not leave one record per token");
        let text: String = events.iter().map(|event| delta(event).unwrap()).collect();
        assert_eq!(text, "中文🚀".repeat(10_000));
        assert!(events.iter().all(|event| delta(event).unwrap().len() <= DELTA_BYTES));
        assert_eq!(events[0]["grapherReceivedAt"], 0);
        assert!(lines.iter().map(String::len).sum::<usize>() < text.len() * 2);
    }

    #[test]
    fn output_buffer_preserves_blocks_messages_and_unknown_metadata_boundaries() {
        let mut buffer = OutputBuffer::default();
        let input = vec![frame("thinking_delta", 0, "first"), frame("thinking_delta", 1, "second"),
            frame("text_delta", 1, "reply"),
            json!({ "type": "message_end", "message": { "role": "assistant", "usage": { "totalTokens": 42 } } }),
            frame("text_delta", 1, "next turn"),
            { let mut event = frame("text_delta", 1, "new identity"); event["messageId"] = "other".into(); event }];
        let mut lines = Vec::new();
        for event in &input { buffer.push(event.clone(), &mut |line| lines.push(line)).unwrap(); }
        buffer.flush(&mut |line| lines.push(line)).unwrap();
        let actual: Vec<Value> = lines.iter().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(actual, input);
    }

    #[test]
    fn output_buffer_flushes_idle_and_interrupted_tails_without_a_final_message() {
        let mut buffer = OutputBuffer::default();
        let mut lines = Vec::new();
        buffer.push(frame("text_delta", 0, "idle"), &mut |line| lines.push(line)).unwrap();
        assert!(lines.is_empty());
        assert!(buffer.wait_timeout() <= DELTA_INTERVAL);
        buffer.since = Some(Instant::now() - DELTA_INTERVAL);
        buffer.flush_due(&mut |line| lines.push(line)).unwrap();
        assert_eq!(lines.len(), 1);
        buffer.push(frame("text_delta", 0, "interrupted"), &mut |line| lines.push(line)).unwrap();
        buffer.flush(&mut |line| lines.push(line)).unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(delta(&serde_json::from_str::<Value>(&lines[1]).unwrap()), Some("interrupted"));
        assert_eq!(buffer.wait_timeout(), READ_TIMEOUT);
    }

    #[test]
    fn output_buffer_flushes_before_external_output_and_on_exact_byte_budget() {
        let mut buffer = OutputBuffer::default();
        let mut lines = Vec::new();
        buffer.push(frame("text_delta", 0, "before stderr"), &mut |line| lines.push(line)).unwrap();
        assert!(lines.is_empty());
        buffer.flush(&mut |line| lines.push(line)).unwrap();
        lines.push("[stderr] diagnostic\n".into());
        buffer.push(frame("text_delta", 0, &"x".repeat(DELTA_BYTES - 4)), &mut |line| lines.push(line)).unwrap();
        buffer.push(frame("text_delta", 0, "🚀"), &mut |line| lines.push(line)).unwrap();
        assert_eq!(lines.len(), 3, "an exactly full delta must flush immediately");
        assert_eq!(delta(&serde_json::from_str::<Value>(&lines[0]).unwrap()), Some("before stderr"));
        assert_eq!(lines[1], "[stderr] diagnostic\n");
        let full: Value = serde_json::from_str(&lines[2]).unwrap();
        assert_eq!(delta(&full).unwrap().len(), DELTA_BYTES);
        assert!(delta(&full).unwrap().ends_with("🚀"));
        buffer.flush(&mut |line| lines.push(line)).unwrap();
        assert_eq!(lines.len(), 3, "flushing an empty buffer must not duplicate a record");
    }

    #[test]
    fn output_buffer_never_truncates_large_provider_frames() {
        let mut buffer = OutputBuffer::default();
        let mut lines = Vec::new();
        let event = frame("text_delta", 0, &"x".repeat(DELTA_BYTES * 2));
        buffer.push(event.clone(), &mut |line| lines.push(line)).unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(serde_json::from_str::<Value>(&lines[0]).unwrap(), event);
    }
}
