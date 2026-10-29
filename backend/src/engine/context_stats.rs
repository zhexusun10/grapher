//! Request Pi's projected context without making another model call. The RPC
//! response is reduced to counters before it enters the durable output log.
use serde_json::{json, Value};
use std::sync::mpsc;

pub(super) struct ContextStats {
    enabled: bool,
    pending: Option<String>,
    dirty: bool,
}

impl ContextStats {
    pub(super) fn new(enabled: bool) -> Self {
        Self { enabled, pending: None, dirty: false }
    }

    /// Coalesce bursts of message/tool boundaries into at most one outstanding
    /// request, followed by one fresh reading if the session changed meanwhile.
    pub(super) fn changed(&mut self, sender: Option<&mpsc::Sender<String>>) {
        if !self.enabled { return; }
        if self.pending.is_some() {
            self.dirty = true;
            return;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let request = json!({"id": id, "type": "get_session_stats"}).to_string();
        if sender.is_some_and(|sender| sender.send(request).is_ok()) {
            self.pending = Some(id);
        } else {
            self.enabled = false;
        }
    }

    pub(super) fn waiting(&self) -> bool { self.pending.is_some() }

    /// `Some` identifies our response; the nested option is absent on failure.
    pub(super) fn response(&mut self, event: &Value, sender: Option<&mpsc::Sender<String>>) -> Option<Option<Value>> {
        if event["type"] != "response" { return None; }
        if event["id"].as_str() != self.pending.as_deref() || self.pending.is_none() {
            // A late response from a previous parked Serial turn must not leak
            // its full statistics into the next attempt's output log.
            return (event["command"] == "get_session_stats").then_some(None);
        }
        self.pending = None;
        if event["success"] != true || event["command"] != "get_session_stats" {
            // An older/failed RPC implementation must not affect execution.
            self.enabled = false;
            self.dirty = false;
            return Some(None);
        }
        let usage = &event["data"]["contextUsage"];
        let result = json!({
            "type": "grapher_context_usage",
            "tokens": usage["tokens"],
            "window": usage["contextWindow"],
        });
        if std::mem::take(&mut self.dirty) { self.changed(sender); }
        Some(Some(result))
    }

    pub(super) fn advances(event: &Value) -> bool {
        match event["type"].as_str() {
            Some("message_end" | "turn_end" | "compaction_end" | "agent_settled" | "model_change") => true,
            Some("entry_appended") => matches!(event["entry"]["type"].as_str(), Some("context_edit" | "compaction")),
            _ => false,
        }
    }
}
