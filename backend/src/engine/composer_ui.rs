//! Pi emits UI on a process-wide stream, not a per-command channel. Serialize
//! composer commands and fence every UI read/response with its invocation ID.
use super::*;
use std::collections::HashSet;

const CLIENT_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_EVENTS: usize = 256;

struct Owner {
    command_id: String,
    rpc_id: String,
    running: bool,
    abandoned: bool,
    last_seen: Instant,
}

#[derive(Default)]
pub(crate) struct CommandUi {
    owner: Option<Owner>,
    events: Vec<Value>,
    dialogs: HashSet<String>,
}

fn is_dialog(event: &Value) -> bool {
    matches!(event["method"].as_str(), Some("select" | "confirm" | "input" | "editor"))
}

fn cancel(sender: &mpsc::Sender<String>, id: &str) {
    let _ = sender.send(serde_json::json!({
        "type":"extension_ui_response", "id":id, "cancelled":true,
    }).to_string());
}

impl CommandUi {
    pub(crate) fn begin(&mut self, command_id: &str, rpc_id: &str, sender: &mpsc::Sender<String>) -> Result<(), String> {
        uuid::Uuid::parse_str(command_id).map_err(|_| "Invalid composer command identity")?;
        self.expire(sender);
        if self.owner.as_ref().is_some_and(|owner| owner.running) {
            return Err("Another Pi command is still running; wait for it to finish before retrying".into());
        }
        if self.owner.as_ref().is_some_and(|owner| owner.command_id == command_id) {
            return Err("Pi command was already submitted; verify its result before retrying".into());
        }
        self.cancel_dialogs(sender);
        self.events.clear();
        self.owner = Some(Owner { command_id:command_id.into(), rpc_id:rpc_id.into(),
            running:true, abandoned:false, last_seen:Instant::now() });
        Ok(())
    }

    pub(crate) fn completed(&mut self, rpc_id: &str) {
        if let Some(owner) = self.owner.as_mut().filter(|owner| owner.rpc_id == rpc_id) {
            owner.running = false;
        }
    }

    pub(crate) fn poll(&mut self, command_id: &str) -> Vec<Value> {
        let Some(owner) = self.owner.as_mut().filter(|owner| owner.command_id == command_id && !owner.abandoned) else {
            // Includes polls racing initial registration or arriving after the
            // next command acquired the same still-live Pi process.
            return Vec::new();
        };
        owner.last_seen = Instant::now();
        self.events.drain(..).collect()
    }

    pub(crate) fn respond(&mut self, command_id: &str, response: Value, sender: &mpsc::Sender<String>) -> Result<(), String> {
        if !self.owner.as_ref().is_some_and(|owner| owner.command_id == command_id && !owner.abandoned) {
            return Err("Pi command changed; this dialog no longer belongs to the composer".into());
        }
        let id = response["id"].as_str().ok_or("Invalid extension UI response")?;
        if response["type"] != "extension_ui_response" || !self.dialogs.contains(id) {
            return Err("Extension dialog is no longer awaiting a response".into());
        }
        sender.send(response.to_string()).map_err(|_| "Pi RPC input closed".to_string())?;
        self.dialogs.remove(id);
        self.owner.as_mut().unwrap().last_seen = Instant::now();
        Ok(())
    }

    pub(crate) fn push(&mut self, event: Value, sender: &mpsc::Sender<String>) {
        self.expire(sender);
        if self.owner.as_ref().is_none_or(|owner| owner.abandoned) || self.events.len() >= MAX_EVENTS
            || (is_dialog(&event) && self.dialogs.len() >= MAX_EVENTS) {
            if is_dialog(&event) {
                if let Some(id) = event["id"].as_str() { cancel(sender, id); }
            }
            return;
        }
        if is_dialog(&event) {
            if let Some(id) = event["id"].as_str() { self.dialogs.insert(id.into()); }
        }
        self.events.push(event);
    }

    fn cancel_dialogs(&mut self, sender: &mpsc::Sender<String>) {
        for id in self.dialogs.drain() { cancel(sender, &id); }
    }

    pub(crate) fn expire(&mut self, sender: &mpsc::Sender<String>) {
        if self.owner.as_ref().is_some_and(|owner| !owner.abandoned && owner.last_seen.elapsed() > CLIENT_IDLE_TIMEOUT) {
            self.owner.as_mut().unwrap().abandoned = true;
            self.cancel_dialogs(sender);
            self.events.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn old_polls_responses_and_completions_cannot_touch_the_next_command() {
        let (sender, receiver) = mpsc::channel();
        let mut ui = CommandUi::default();
        let a = uuid::Uuid::new_v4().to_string();
        let b = uuid::Uuid::new_v4().to_string();
        ui.begin(&a, "rpc-a", &sender).unwrap();
        assert!(ui.begin(&b, "rpc-b", &sender).unwrap_err().contains("still running"));
        ui.completed("rpc-a");
        ui.begin(&b, "rpc-b", &sender).unwrap();
        ui.push(json!({"type":"extension_ui_request","id":"b-dialog","method":"input"}), &sender);
        assert!(ui.poll(&a).is_empty());
        assert!(ui.respond(&a, json!({"type":"extension_ui_response","id":"b-dialog","cancelled":true}), &sender).is_err());
        assert!(receiver.try_recv().is_err(), "no cancellation reached Pi");
        ui.completed("rpc-a");
        assert!(ui.begin(&a, "rpc-again", &sender).is_err(), "a late response cannot release b");
        assert_eq!(ui.poll(&b)[0]["id"], "b-dialog");
        ui.respond(&b, json!({"type":"extension_ui_response","id":"b-dialog","value":"answer"}), &sender).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&receiver.recv().unwrap()).unwrap()["value"], "answer");
    }

    #[test]
    fn outstanding_dialogs_stay_bounded_even_when_the_event_queue_is_polled() {
        let (sender, receiver) = mpsc::channel();
        let mut ui = CommandUi::default();
        let id = uuid::Uuid::new_v4().to_string();
        ui.begin(&id, "rpc", &sender).unwrap();
        for index in 0..MAX_EVENTS {
            ui.push(json!({"id":index.to_string(),"method":"input"}), &sender);
            assert_eq!(ui.poll(&id).len(), 1);
        }
        ui.push(json!({"id":"overflow","method":"input"}), &sender);
        assert!(ui.poll(&id).is_empty());
        assert_eq!(ui.dialogs.len(), MAX_EVENTS);
        assert_eq!(serde_json::from_str::<Value>(&receiver.recv().unwrap()).unwrap()["id"], "overflow");
    }

    #[test]
    fn abandoned_client_cancels_dialogs_but_keeps_exclusion_until_pi_acknowledges() {
        let (sender, receiver) = mpsc::channel();
        let mut ui = CommandUi::default();
        let id = uuid::Uuid::new_v4().to_string();
        let next = uuid::Uuid::new_v4().to_string();
        ui.begin(&id, "rpc", &sender).unwrap();
        ui.push(json!({"id":"shown","method":"input"}), &sender);
        ui.poll(&id); // Already delivered dialogs must also be cancelled.
        ui.owner.as_mut().unwrap().last_seen = Instant::now() - CLIENT_IDLE_TIMEOUT - Duration::from_secs(1);
        ui.expire(&sender);
        assert_eq!(serde_json::from_str::<Value>(&receiver.recv().unwrap()).unwrap()["id"], "shown");
        assert!(ui.begin(&next, "rpc-next", &sender).is_err());
        ui.push(json!({"id":"late","method":"confirm"}), &sender);
        assert_eq!(serde_json::from_str::<Value>(&receiver.recv().unwrap()).unwrap()["id"], "late");
        ui.completed("rpc");
        ui.begin(&next, "rpc-next", &sender).unwrap();
        assert!(ui.poll(&id).is_empty());
    }
}
