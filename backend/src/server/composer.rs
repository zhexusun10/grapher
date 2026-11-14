use super::*;
use crate::engine::composer as rpc;
use crate::model::RecalledMessage;
use std::collections::BTreeMap;
use serde_json::{json, Value};

pub(super) fn models(body: &Value, service: &Arc<Service>) -> Result<Value, String> {
    let run: String = argument(body, "runId")?;
    let node: Option<String> = argument(body, "node")?;
    let role: String = argument(body, "role")?;
    if !matches!(role.as_str(), "planner" | "nodeAgent" | "partitioner") {
        return Err("Invalid model role".into());
    }
    let patch: RoleModelConfig = argument(body, "settings")?;
    let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
    if runtime.state.run_id != run {
        return Err("Run changed while selecting a model".into());
    }
    let mut config = runtime
        .state
        .effective_config()
        .ok_or("Conversation configuration is not ready")?;
    let mut settings = if let Some(node) = &node {
        if role != "nodeAgent" {
            return Err("Node model must use nodeAgent role".into());
        }
        let state = runtime.state.nodes.get(node).ok_or("Node not found")?;
        if state.model_override {
            state
                .model_config
                .clone()
                .unwrap_or_else(|| config.node_agent_settings())
        } else {
            config.node_agent_settings()
        }
    } else {
        let selection = PiModelConfig::resolve(
            match role.as_str() {
                "planner" => PiRole::Planner,
                "partitioner" => PiRole::Partitioner,
                _ => PiRole::NodeAgent,
            },
            &config,
        );
        RoleModelConfig {
            model: selection.model,
            thinking_level: selection.thinking,
        }
    };
    if !patch.model.trim().is_empty() {
        settings.model = patch.model.trim().into();
    }
    if patch.thinking_level.is_some() {
        settings.thinking_level = patch.thinking_level;
    }
    // Match Settings' default inheritance, but never promote a per-node
    // override into the conversation's fallback for Planner/Partitioner.
    if node.is_none() && role == "nodeAgent" {
        config.model = settings.model.clone();
        if let Some(level) = &settings.thinking_level {
            config.thinking_level = level.clone();
        }
    }
    config.role_models.insert(role, settings.clone());
    config.validate_model_settings()?;
    if let Some(node) = node {
        let current = &runtime.state.nodes[&node];
        if !current.model_override || current.model_config.as_ref() != Some(&settings) {
            runtime.emit(EventKind::NodeModelOverrideUpdated { node, settings })?;
        }
    } else {
        runtime.update_node_models(&config)?;
    }
    serde_json::to_value(runtime.state.clone()).map_err(|e| e.to_string())
}

pub(super) fn rename(body: &Value, service: &Arc<Service>) -> Result<Value, String> {
    let run: String = argument(body, "runId")?;
    if body
        .get("node")
        .and_then(Value::as_str)
        .is_some_and(|node| !node.trim().is_empty())
    {
        return Err("Node agent dialogs cannot rename the conversation".into());
    }
    let title: String = argument(body, "title")?;
    let title = title.trim();
    if title.is_empty() {
        return Err("Conversation name cannot be empty".into());
    }
    let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
    if runtime.state.run_id != run {
        return Err("Run changed while renaming conversation".into());
    }
    if runtime.state.title.as_deref() != Some(title) {
        runtime.emit(EventKind::ConversationRenamed {
            title: title.to_string(),
        })?;
    }
    if body.get("detail").and_then(Value::as_str) == Some("metadata") {
        crate::snapshot_view::snapshot_metadata(&runtime.state)
    } else {
        serde_json::to_value(runtime.state.clone()).map_err(|e| e.to_string())
    }
}

// Resolve the target from the Run, never from a client-provided execution ID.
fn target(body: &Value, service: &Arc<Service>) -> Result<String, String> {
    let run: String = argument(body, "runId")?;
    let node: Option<String> = argument(body, "node")?;
    let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
    if runtime.state.run_id != run {
        return Err("Run changed while sending a Pi command".into());
    }
    if let Some(node) = node {
        runtime
            .state
            .executions
            .iter()
            .chain(&runtime.state.mergers)
            .rev()
            .find(|execution| execution.node == node && execution.status == "running")
            .map(|execution| execution.id.clone())
            .ok_or_else(|| "Pi session is not active; start or continue this node first".into())
    } else {
        rpc::planner_id(&run)
    }
}

pub(super) fn command(body: &Value, service: &Arc<Service>) -> Result<Value, String> {
    let operation: String = argument(body, "operation")?;
    if operation == "withdraw" { return withdraw(body, service); }
    let target = target(body, service)?;
    if operation == "catalog" {
        let instance = rpc::session(&target)?;
        let mut catalog = rpc::request(&target, &instance, json!({"type":"get_commands"}))?;
        if let Some(commands) = catalog["commands"].as_array_mut() {
            commands.retain(|command| {
                command["name"]
                    .as_str()
                    .is_some_and(|name| !rpc::blocked(name))
            });
        }
        return Ok(json!({"instance":instance, "commands":catalog["commands"]}));
    }
    let instance: String = argument(body, "instance")?;
    let command_id: String = argument(body, "commandId")?;
    match operation.as_str() {
        "poll" => Ok(json!(rpc::poll(&target, &instance, &command_id)?)),
        "respond" => {
            rpc::respond(&target, &instance, &command_id, argument(body, "response")?)?;
            Ok(Value::Null)
        }
        "execute" => {
            let text: String = argument(body, "text")?;
            let catalog = rpc::request(&target, &instance, json!({"type":"get_commands"}))?;
            let command = rpc::command_request(&text, &catalog)?;
            rpc::execute_owned(&target, &instance, &command_id, command)
        }
        _ => Err("Unknown composer operation".into()),
    }
}

fn withdrawal_reply(body: &Value, state: &Snapshot, messages: &[RecalledMessage]) -> Result<Value, String> {
    let snapshot = if body["detail"] == "metadata" {
        crate::snapshot_view::snapshot_metadata(state)?
    } else { serde_json::to_value(state).map_err(|e| e.to_string())? };
    Ok(json!({"messages":messages, "snapshot":snapshot}))
}

fn withdraw(body: &Value, service: &Arc<Service>) -> Result<Value, String> {
    let run: String = argument(body, "runId")?;
    let node: Option<String> = argument(body, "node")?;
    let request_id: String = argument::<Option<String>>(body, "requestId")?
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    if Uuid::parse_str(&request_id).map(|id| id.to_string() != request_id).unwrap_or(true) {
        return Err("Invalid withdrawal request ID".into());
    }
    // A lost HTTP response must not make a retry clear newly queued messages.
    // Serialize only recalls, never hold the Run mutex while awaiting Pi. Weak
    // entries keep completed/deleted conversations out of a permanent registry.
    static LOCKS: std::sync::OnceLock<Mutex<BTreeMap<String, std::sync::Weak<Mutex<()>>>>> = std::sync::OnceLock::new();
    let lock = {
        let mut locks = LOCKS.get_or_init(Default::default).lock().map_err(|e| e.to_string())?;
        locks.retain(|_, lock| lock.strong_count() > 0);
        let lock = locks.get(&run).and_then(std::sync::Weak::upgrade).unwrap_or_else(|| Arc::new(Mutex::new(())));
        locks.insert(run.clone(), Arc::downgrade(&lock));
        lock
    };
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    {
        let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        if runtime.state.run_id != run { return Err("Run changed while withdrawing messages".into()); }
        for event in &runtime.state.events {
            if let EventKind::QueueWithdrawalRecorded { request_id: id, node: owner, messages } = &event.kind {
                if id == &request_id {
                    if owner != &node { return Err("Withdrawal request ID belongs to another conversation".into()); }
                    return withdrawal_reply(body, &runtime.state, messages);
                }
            }
        }
    }
    // Replay the receipt before resolving a process: the old attempt may have
    // settled or the backend restarted since it completed the original recall.
    let target = target(body, service)?;
    let instance = rpc::session(&target)?;
    let (events, pending) = {
        let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        if runtime.state.run_id != run { return Err("Run changed while withdrawing messages".into()); }
        let pending = rpc::start_request(&target, &instance, json!({"type":"clear_queue"}))?;
        (runtime.state.events.clone(), pending)
    };
    let cleared = pending.wait()?;
    let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
    if runtime.state.run_id != run { return Err("Run changed while withdrawing messages".into()); }
    let messages = record_withdrawal(&mut runtime, &target, &events, &cleared, Some((request_id, node)))?;
    withdrawal_reply(body, &runtime.state, &messages)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WithdrawnQueueEntry {
    #[serde(default)]
    request_id: Option<String>,
    text: String,
    #[serde(default)]
    images: Option<Vec<crate::model::ImageAttachment>>,
}

// The adapter reports only objects removed from the actual unread queues.
// Resolve their stable IDs against acceptance at pipe-write time, never text:
// extensions may rewrite different submissions to the same instruction.
fn record_withdrawal(runtime: &mut Runtime, target: &str, events: &[crate::model::Event], cleared: &Value,
    receipt: Option<(String, Option<String>)>) -> Result<Vec<RecalledMessage>, String> {
    let withdrawn: BTreeSet<i64> = events.iter().flat_map(|event| match &event.kind {
        EventKind::SteersWithdrawn { message_sequences, .. } => message_sequences.clone(),
        _ => vec![],
    }).collect();
    let mut sequences = BTreeSet::new();
    let mut kinds = Vec::new();
    let mut messages = Vec::new();
    let queued: Vec<WithdrawnQueueEntry> = if let Some(entries) = cleared.get("messages") {
        serde_json::from_value(entries.clone()).map_err(|e| format!("Invalid queue withdrawal receipt: {e}"))?
    } else {
        // Older adapters can only correlate Planner's existing UUID envelope.
        // Unmarked legacy Node input is returned without guessing a card ID.
        ["steering", "followUp"].iter().flat_map(|key| cleared[*key].as_array().into_iter().flatten()
            .filter_map(Value::as_str).map(|text| {
                let request_id = text.rsplit_once("\n\n<grapher-steer-id>")
                    .and_then(|(_, tail)| tail.strip_suffix("</grapher-steer-id>"))
                    .filter(|id| Uuid::parse_str(id).is_ok()).map(str::to_owned);
                WithdrawnQueueEntry { request_id, text: text.into(), images: None }
            })).collect()
    };
    let mut seen = BTreeSet::new();
    for entry in queued {
        if let Some(id) = entry.request_id.as_deref() {
            if !seen.insert(id.to_string()) { continue; }
            if let Some(event) = events.iter().find(|event| match &event.kind {
                EventKind::Steered { request_id: Some(request_id), execution_id, .. } =>
                    request_id == id && execution_id == target,
                EventKind::PlannerSteerSubmitted { request_id, .. } => target.starts_with("planner:") && request_id == id,
                _ => false,
            }) {
                match &event.kind {
                    EventKind::Steered { instruction, images, .. } => {
                        if withdrawn.contains(&event.sequence) { continue; }
                        sequences.insert(event.sequence);
                        messages.push(RecalledMessage { text: instruction.clone(), images: images.clone() });
                    }
                    EventKind::PlannerSteerSubmitted { planning_id, request_id, instruction, images } => {
                        if planner_steer_status(&runtime.state, planning_id, request_id).is_some_and(|status|
                            matches!(status.as_str(), "consumed" | "withdrawn" | "handled" | "failed")) { continue; }
                        kinds.push(EventKind::PlannerSteerStatus { planning_id: planning_id.clone(), request_id: request_id.clone(), status: "withdrawn".into(), error: None });
                        messages.push(RecalledMessage { text: instruction.clone(), images: images.clone() });
                    }
                    _ => unreachable!(),
                }
                continue;
            }
        }
        // Extension-owned or legacy input has no provable Grapher identity.
        // Return the removed content, but never suppress a same-text card.
        messages.push(RecalledMessage { text: entry.text, images: entry.images });
    }
    if !sequences.is_empty() {
        kinds.push(EventKind::SteersWithdrawn { execution_id: target.into(), message_sequences: sequences.into_iter().collect() });
    }
    if let Some((request_id, node)) = receipt {
        kinds.push(EventKind::QueueWithdrawalRecorded { request_id, node, messages: messages.clone() });
    }
    runtime.emit_outputs(kinds)?;
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn withdrawal_records_only_cleared_occurrences_and_survives_replay() {
        let temp = tempfile::tempdir().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        runtime.state.run_id = Uuid::new_v4().to_string();
        let ids: Vec<String> = (0..4).map(|_| Uuid::new_v4().to_string()).collect();
        for (index, execution) in ["worker", "worker", "other"].iter().enumerate() {
            runtime.emit(EventKind::Steered { execution_id: (*execution).into(), node: (*execution).into(),
                instruction: if index == 1 { "original draft" } else { "same" }.into(),
                request_id: Some(ids[index].clone()), images: None }).unwrap();
        }
        let events = runtime.state.events.clone();
        let latest = events[1].sequence;
        // A later identical send is outside the clear_queue pipe boundary.
        runtime.emit(EventKind::Steered { execution_id: "worker".into(), node: "worker".into(),
            instruction: "same".into(), request_id: Some(ids[3].clone()), images: None }).unwrap();
        // An extension rewrote the queued draft to the already-read text.
        let removed = record_withdrawal(&mut runtime, "worker", &events,
            &json!({"messages":[{"requestId":ids[1], "text":"same"}]}), None).unwrap();
        assert_eq!(removed[0].text, "original draft");
        assert!(matches!(&runtime.state.events.last().unwrap().kind,
            EventKind::SteersWithdrawn { execution_id, message_sequences } if execution_id == "worker" && message_sequences == &vec![latest]));
        let count = runtime.state.events.len();
        let events = runtime.state.events.clone();
        assert!(record_withdrawal(&mut runtime, "worker", &events,
            &json!({"steering":[], "followUp":[]}), None).unwrap().is_empty());
        assert_eq!(runtime.state.events.len(), count, "an empty queue never recalls a consumed turn");
        let replay = runtime.store.load(&runtime.state.run_id).unwrap();
        assert!(matches!(&replay.events.last().unwrap().kind,
            EventKind::SteersWithdrawn { message_sequences, .. } if message_sequences == &vec![latest]));
    }

    #[test]
    fn node_and_merger_batch_withdrawal_preserves_read_turns_and_never_guesses_unidentified_text() {
        for target in ["worker", "merge:join", "merger"] {
            let temp = tempfile::tempdir().unwrap();
            let mut runtime = Runtime::open(temp.path()).unwrap();
            runtime.state.run_id = Uuid::new_v4().to_string();
            let ids: Vec<String> = (0..4).map(|_| Uuid::new_v4().to_string()).collect();
            for (index, instruction) in ["same", "first original", "second original", "same"].iter().enumerate() {
                runtime.emit(EventKind::Steered { execution_id: if index == 3 { "unrelated" } else { target }.into(),
                    node: target.into(), instruction: (*instruction).into(), request_id: Some(ids[index].clone()),
                    images: Some(vec![crate::model::ImageAttachment { r#type: "image".into(), mime_type: "image/png".into(), data: index.to_string(), name: None }]),
                }).unwrap();
            }
            let events = runtime.state.events.clone();
            let removed = record_withdrawal(&mut runtime, target, &events, &json!({"messages":[
                {"requestId":ids[1],"text":"same"}, {"requestId":ids[2],"text":"same"},
                {"text":"same"}, {"requestId":ids[3],"text":"same"}
            ]}), None).unwrap();
            assert_eq!(removed.iter().map(|item| item.text.as_str()).collect::<Vec<_>>(),
                ["first original", "second original", "same", "same"]);
            assert_eq!(removed[0].images.as_ref().unwrap()[0].data, "1");
            assert_eq!(removed[1].images.as_ref().unwrap()[0].data, "2");
            assert_eq!(runtime.state.withdrawn_steer_sequences(), BTreeSet::from([events[1].sequence, events[2].sequence]));
            assert!(!runtime.state.withdrawn_steer_sequences().contains(&events[0].sequence), "already-read turn survives");
            assert_eq!(runtime.store.load(&runtime.state.run_id).unwrap().withdrawn_steer_sequences(), runtime.state.withdrawn_steer_sequences());
        }
    }

    #[test]
    fn planner_withdrawal_uses_identity_and_restores_original_text_and_images() {
        let temp = tempfile::tempdir().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        runtime.state.run_id = Uuid::new_v4().to_string();
        let ids = [Uuid::new_v4().to_string(), Uuid::new_v4().to_string()];
        for id in &ids {
            runtime.emit(EventKind::PlannerSteerSubmitted { planning_id: "plan".into(), request_id: id.clone(),
                instruction: "same".into(), images: Some(vec![crate::model::ImageAttachment {
                    r#type: "image".into(), mime_type: "image/png".into(), data: "image-data".into(), name: None,
                }]) }).unwrap();
        }
        let events = runtime.state.events.clone();
        let removed = record_withdrawal(&mut runtime, "planner:plan", &events,
            &json!({"messages":[{"requestId":ids[1], "text":"extension replaced the entire input"}]}), None).unwrap();
        assert_eq!(removed[0].text, "same");
        assert_eq!(removed[0].images.as_ref().unwrap()[0].data, "image-data");
        assert_eq!(planner_steer_status(&runtime.state, "plan", &ids[0]).as_deref(), Some("submitted"));
        assert_eq!(planner_steer_status(&runtime.state, "plan", &ids[1]).as_deref(), Some("withdrawn"));
        let replay = runtime.store.load(&runtime.state.run_id).unwrap();
        assert_eq!(planner_steer_status(&replay, "plan", &ids[1]).as_deref(), Some("withdrawn"));
    }

    #[test]
    fn lost_withdrawal_response_replays_without_clearing_a_new_queue_or_needing_a_live_process() {
        let temp = tempfile::tempdir().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        runtime.state.run_id = Uuid::new_v4().to_string();
        let run = runtime.state.run_id.clone();
        let id = Uuid::new_v4().to_string();
        let message_id = Uuid::new_v4().to_string();
        runtime.emit(EventKind::Steered { execution_id: "old-attempt".into(), node: "worker".into(),
            instruction: "recall this".into(), request_id: Some(message_id.clone()), images: None }).unwrap();
        let events = runtime.state.events.clone();
        record_withdrawal(&mut runtime, "old-attempt", &events,
            &json!({"messages":[{"requestId":message_id,"text":"rewritten"}]}), Some((id.clone(), Some("worker".into())))).unwrap();
        runtime.emit(EventKind::Steered { execution_id: "new-attempt".into(), node: "worker".into(),
            instruction: "keep this queued".into(), request_id: Some(Uuid::new_v4().to_string()), images: None }).unwrap();
        // Restart from durable evidence; no Pi process exists in this test.
        runtime.state = runtime.store.load(&run).unwrap();
        let count = runtime.state.events.len();
        let service = Arc::new(Service { runtime: Mutex::new(runtime), driving: AtomicBool::new(false),
            drive_signal: (Mutex::new(0), Condvar::new()), planning: AtomicBool::new(false), extension: temp.path().join("unused") });
        let body = json!({"runId":run,"node":"worker","requestId":id,"operation":"withdraw","detail":"metadata"});
        for _ in 0..2 {
            let reply = command(&body, &service).unwrap();
            assert_eq!(reply["messages"][0]["text"], "recall this");
            assert_eq!(service.runtime.lock().unwrap().state.events.len(), count);
        }
        let mut wrong_node = body.clone();
        wrong_node["node"] = json!("other");
        assert!(command(&wrong_node, &service).unwrap_err().contains("another conversation"));
        let mut wrong_run = body.clone();
        wrong_run["runId"] = json!("other-run");
        assert!(command(&wrong_run, &service).unwrap_err().contains("Run changed"));
        assert_eq!(service.runtime.lock().unwrap().state.withdrawn_steer_sequences().len(), 1);
    }

    #[test]
    fn composer_model_api_is_run_scoped_and_does_not_save_global_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        let config: Config =
            serde_json::from_value(json!({ "repository":temp.path(), "model":"original/model" }))
                .unwrap();
        runtime.save_default_config(&config).unwrap();
        let defaults = fs::read(temp.path().join("config.json")).unwrap();
        runtime.state.run_id = Uuid::new_v4().to_string();
        let run_id = runtime.state.run_id.clone();
        runtime
            .emit(EventKind::Created {
                graph: Graph {
                    original_goal: "test".into(),
                    nodes: vec![
                        Node {
                            name: "a".into(),
                            task: "test".into(),
                        },
                        Node {
                            name: "b".into(),
                            task: "test".into(),
                        },
                    ],
                    edges: vec![],
                },
                config,
                planning_id: None,
                planning: None,
            })
            .unwrap();
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            drive_signal: (Mutex::new(0), Condvar::new()),
            planning: AtomicBool::new(false),
            extension: temp.path().join("extension.ts"),
        });
        assert!(models(
            &json!({"runId":"wrong", "role":"planner", "settings":{"model":"new/model"}}),
            &service
        )
        .is_err());
        let changed = models(&json!({"runId":run_id, "role":"planner", "settings":{"model":"planner/new", "thinkingLevel":"high"}}), &service).unwrap();
        assert_eq!(
            changed["modelConfig"]["roleModels"]["planner"]["model"],
            "planner/new"
        );
        assert!(changed["nodes"]["a"]["modelConfig"].is_null());
        let node = json!({"runId":run_id, "node":"a", "role":"nodeAgent", "settings":{"model":"node/new", "thinkingLevel":"off"}});
        let changed = models(&node, &service).unwrap();
        assert_eq!(changed["nodes"]["a"]["modelConfig"]["model"], "node/new");
        assert!(changed["nodes"]["b"]["modelConfig"].is_null());
        let count = service.runtime.lock().unwrap().state.events.len();
        models(&node, &service).unwrap();
        assert_eq!(count, service.runtime.lock().unwrap().state.events.len());
        assert_eq!(fs::read(temp.path().join("config.json")).unwrap(), defaults);
    }

    #[test]
    fn conversation_node_model_updates_inherited_defaults_without_touching_explicit_roles() {
        let temp = tempfile::tempdir().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        let config: Config = serde_json::from_value(json!({
            "repository":temp.path(), "model":"old/model", "thinkingLevel":"low",
            "roleModels":{"partitioner":{"model":"explicit/partitioner","thinkingLevel":"minimal"}}
        })).unwrap();
        runtime.save_default_config(&config).unwrap();
        let defaults = fs::read(temp.path().join("config.json")).unwrap();
        runtime.state.run_id = Uuid::new_v4().to_string();
        let run = runtime.state.run_id.clone();
        runtime.emit(EventKind::Created {
            graph: Graph { original_goal:"test".into(), nodes:vec![Node{name:"a".into(),task:"test".into()}], edges:vec![] },
            config, planning_id:None, planning:None,
        }).unwrap();
        let service = Arc::new(Service { runtime:Mutex::new(runtime), driving:AtomicBool::new(false),
            drive_signal:(Mutex::new(0),Condvar::new()), planning:AtomicBool::new(false), extension:temp.path().join("extension.ts") });
        models(&json!({"runId":run,"role":"nodeAgent","settings":{"model":"new/model","thinkingLevel":"high"}}), &service).unwrap();
        {
            let runtime = service.runtime.lock().unwrap();
            for state in [&runtime.state, &runtime.store.load(&run).unwrap()] {
                let effective = state.effective_config().unwrap();
                assert_eq!(effective.model, "new/model", "unspecified roles inherit the new Node Agent model");
                assert_eq!(effective.thinking_level, "high");
                assert_eq!(effective.node_agent_settings().model, effective.model);
                assert!(!effective.role_models.contains_key("planner"));
                assert_eq!(effective.role_models["partitioner"].model, "explicit/partitioner");
                assert_eq!(effective.role_models["partitioner"].thinking_level.as_deref(), Some("minimal"));
                assert_eq!(state.config.as_ref().unwrap().model, "old/model", "creation config stays immutable");
            }
        }
        models(&json!({"runId":run,"node":"a","role":"nodeAgent","settings":{"model":"node/only","thinkingLevel":"off"}}), &service).unwrap();
        models(&json!({"runId":run,"role":"planner","settings":{"model":"explicit/planner","thinkingLevel":"off"}}), &service).unwrap();
        let runtime = service.runtime.lock().unwrap();
        let effective = runtime.state.effective_config().unwrap();
        assert_eq!(effective.model, "new/model");
        assert_eq!(effective.thinking_level, "high");
        assert_eq!(runtime.state.nodes["a"].model_config.as_ref().unwrap().model, "node/only");
        assert_eq!(fs::read(temp.path().join("config.json")).unwrap(), defaults);
    }

    #[test]
    fn composer_rename_updates_title_and_summary_without_mutating_goal() {
        let temp = tempfile::tempdir().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        let config: Config =
            serde_json::from_value(json!({ "repository":temp.path(), "model":"original/model" }))
                .unwrap();
        runtime.state.run_id = Uuid::new_v4().to_string();
        let run_id = runtime.state.run_id.clone();
        runtime
            .emit(EventKind::Created {
                graph: Graph {
                    original_goal: "Original user prompt".into(),
                    nodes: vec![Node {
                        name: "a".into(),
                        task: "test".into(),
                    }],
                    edges: vec![],
                },
                config,
                planning_id: None,
                planning: None,
            })
            .unwrap();
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            drive_signal: (Mutex::new(0), Condvar::new()),
            planning: AtomicBool::new(false),
            extension: temp.path().join("extension.ts"),
        });
        assert!(rename(&json!({"runId":"wrong", "title":"Renamed"}), &service).is_err());
        assert!(rename(&json!({"runId":run_id, "title":"   "}), &service).is_err());
        assert!(rename(&json!({"runId":run_id, "node":"a", "title":"Renamed"}), &service).is_err());
        let renamed = rename(&json!({"runId":run_id, "title":"  Renamed card  ", "detail":"metadata"}), &service).unwrap();
        assert_eq!(renamed["title"], "Renamed card");
        assert_eq!(renamed["graph"]["originalGoal"], "Original user prompt");
        let events_before = service.runtime.lock().unwrap().state.events.len();
        rename(&json!({"runId":run_id, "title":"Renamed card"}), &service).unwrap();
        assert_eq!(
            events_before,
            service.runtime.lock().unwrap().state.events.len()
        );
        let summaries = crate::store::conversation_summaries(&temp.path().join("events.sqlite"))
            .unwrap()
            .conversations;
        assert_eq!(summaries[0].title, "Renamed card");
        let loaded = service.runtime.lock().unwrap().store.load(&run_id).unwrap();
        assert_eq!(loaded.title.as_deref(), Some("Renamed card"));
        assert_eq!(loaded.graph.original_goal, "Original user prompt");
        crate::store::forget_catalog(&temp.path().join("events.sqlite"));
    }
}
