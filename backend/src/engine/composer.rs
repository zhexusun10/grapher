//! Composer RPC access. Never expose arbitrary Pi session-management RPCs.
use super::*;

#[path = "composer_ui.rs"]
mod ui;
pub(crate) use ui::CommandUi;

fn lookup(id: &str, instance: Option<&str>) -> Result<NodeRpc, String> {
    let rpc = NODE_RPC
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
        .ok_or("Pi session is not active; start or continue this conversation first")?;
    if instance.is_some_and(|instance| instance != rpc.instance) {
        return Err("Pi session changed; reopen the command menu".into());
    }
    Ok(rpc)
}

pub fn planner_id(run: &str) -> Result<String, String> {
    planner_for_run(run)
}

pub fn session(id: &str) -> Result<String, String> {
    Ok(lookup(id, None)?.instance)
}

pub struct PendingRequest {
    rpc: NodeRpc,
    id: String,
    response: mpsc::Receiver<Result<Value, String>>,
    timeout: u64,
}

impl PendingRequest {
    pub fn wait(self) -> Result<Value, String> {
        self.response.recv_timeout(Duration::from_secs(self.timeout))
            .map_err(|_| "Pi command timed out; verify its result before retrying".to_string())?
    }
}

impl Drop for PendingRequest {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.rpc.pending.lock() { pending.remove(&self.id); }
    }
}

fn request_timeout(command: &Value) -> u64 {
    if matches!(command["type"].as_str(), Some("prompt" | "compact" | "abort" | "clear_queue")) { 300 } else { 10 }
}

// Register before writing so callers can serialize pipe order with durable
// acceptance, then release the Run mutex before waiting for the reader.
pub fn start_request(id: &str, instance: &str, mut command: Value) -> Result<PendingRequest, String> {
    let rpc = lookup(id, Some(instance))?;
    let request_id = uuid::Uuid::new_v4().to_string();
    command["id"] = Value::String(request_id.clone());
    let timeout = request_timeout(&command);
    let (tx, response) = mpsc::channel();
    rpc.pending.lock().map_err(|e| e.to_string())?.insert(request_id.clone(), tx);
    let pending = PendingRequest { rpc, id: request_id, response, timeout };
    pending.rpc.sender.send(command.to_string()).map_err(|_| "Pi RPC input closed".to_string())?;
    Ok(pending)
}

pub fn request(id: &str, instance: &str, command: Value) -> Result<Value, String> {
    start_request(id, instance, command)?.wait()
}

/// One UI-capable invocation owns a process until its real RPC acknowledgement.
/// Timeouts remove HTTP waiters, but cannot authorize a concurrent invocation.
/// The reader independently retires ownership when Pi eventually responds.
pub fn execute_owned(id: &str, instance: &str, command_id: &str, mut command: Value) -> Result<Value, String> {
    let rpc = lookup(id, Some(instance))?;
    let request_id = uuid::Uuid::new_v4().to_string();
    command["id"] = Value::String(request_id.clone());
    let mut ui = rpc.ui.lock().map_err(|error| error.to_string())?;
    ui.begin(command_id, &request_id, &rpc.sender)?;
    let result = (|| {
        let (tx, response) = mpsc::channel();
        rpc.pending.lock().map_err(|error| error.to_string())?.insert(request_id.clone(), tx);
        let pending = PendingRequest { rpc:rpc.clone(), id:request_id.clone(), response, timeout:request_timeout(&command) };
        rpc.sender.send(command.to_string()).map_err(|_| "Pi RPC input closed".to_string())?;
        Ok::<_, String>(pending)
    })();
    if result.is_err() { ui.completed(&request_id); }
    drop(ui);
    result?.wait()
}

// A synthetic waiter pins the same process across abort -> durable send. It
// never reaches Pi and is removed on every success/error path.
pub fn interrupt_then<T>(id: &str, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let rpc = lookup(id, None)?;
    let instance = rpc.instance.clone();
    let lease_id = uuid::Uuid::new_v4().to_string();
    let (tx, response) = mpsc::channel();
    rpc.pending.lock().map_err(|e| e.to_string())?.insert(lease_id.clone(), tx);
    let _lease = PendingRequest { rpc, id: lease_id, response, timeout: 300 };
    request(id, &instance, serde_json::json!({"type":"abort"}))?;
    work()
}

pub fn poll(id: &str, instance: &str, command_id: &str) -> Result<Vec<Value>, String> {
    let rpc = lookup(id, Some(instance))?;
    let mut ui = rpc.ui.lock().map_err(|e| e.to_string())?;
    Ok(ui.poll(command_id))
}

pub fn respond(id: &str, instance: &str, command_id: &str, response: Value) -> Result<(), String> {
    let rpc = lookup(id, Some(instance))?;
    let mut ui = rpc.ui.lock().map_err(|error| error.to_string())?;
    ui.respond(command_id, response, &rpc.sender)
}

pub fn blocked(name: &str) -> bool {
    matches!(
        name.split('/')
            .next()
            .unwrap_or(name)
            .to_ascii_lowercase()
            .as_str(),
        "quit"
            | "exit"
            | "new"
            | "tree"
            | "fork"
            | "clone"
            | "resume"
            | "import"
            | "scoped-models"
            | "sessions"
            | "login"
            | "logout"
            | "settings"
            | "model"
            | "thinking"
            | "name"
    )
}

pub fn command_request(text: &str, commands: &Value) -> Result<Value, String> {
    let text = text.trim();
    let (name, args) = text
        .strip_prefix('/')
        .ok_or("Expected a slash command")?
        .split_once(char::is_whitespace)
        .unwrap_or((&text[1..], ""));
    if blocked(name) {
        return Err("This command is managed by Grapher and is not available here".into());
    }
    match name {
        // /compact is supplied by the trusted adapter extension. Its handler
        // waits for idle; the raw compact RPC would abort the running task.
        "stats" | "session" => Ok(serde_json::json!({"type":"get_session_stats"})),
        "copy" => Ok(serde_json::json!({"type":"get_last_assistant_text"})),
        _ if commands["commands"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["name"] == name)) =>
        {
            // Pi splits extension names on a literal space, not arbitrary
            // whitespace. Preserve multiline arguments after that separator.
            let message = if args.is_empty() { format!("/{name}") } else { format!("/{name} {args}") };
            Ok(serde_json::json!({"type":"prompt", "message":message, "streamingBehavior":"steer"}))
        }
        _ => Err(format!("Unknown or unavailable Pi command: /{name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn composer_waiters_fail_when_process_unregisters() {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, _receiver) = mpsc::channel();
        let (reply, response) = mpsc::channel();
        let pending = Arc::new(Mutex::new(HashMap::from([("request".into(), reply)])));
        NODE_RPC
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(
                id.clone(),
                NodeRpc {
                    sender,
                    pending,
                    instance: "instance".into(),
                    ui: Arc::new(Mutex::new(CommandUi::default())),
                    run_id: None,
                    revision_run_id: None,
                },
            );
        drop(NodeRpcGuard(id.clone()));
        assert!(response
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_err());
        assert!(session(&id).is_err());
    }

    #[test]
    fn interrupt_failure_never_sends_or_leaks_the_handoff_lease() {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel::<String>();
        let pending = Arc::new(Mutex::new(HashMap::new()));
        NODE_RPC.get_or_init(Default::default).lock().unwrap().insert(id.clone(), NodeRpc {
            sender, pending: pending.clone(), instance: "test".into(), ui: Arc::new(Mutex::new(CommandUi::default())),
            run_id: None, revision_run_id: None,
        });
        let reader = thread::spawn({
            let pending = pending.clone();
            move || {
                let command: Value = serde_json::from_str(&receiver.recv().unwrap()).unwrap();
                assert_eq!(command["type"], "abort");
                pending.lock().unwrap().remove(command["id"].as_str().unwrap()).unwrap()
                    .send(Err("abort rejected".into())).unwrap();
            }
        });
        let mut sent = false;
        assert!(interrupt_then(&id, || { sent = true; Ok(()) }).is_err());
        assert!(!sent);
        assert!(pending.lock().unwrap().is_empty());
        reader.join().unwrap();
        drop(NodeRpcGuard(id));
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn composer_rpc_roundtrips_extension_ui_without_logging_inputs() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("composer.py");
        fs::write(&script, r#"import json, sys
first = json.loads(sys.stdin.readline())
print(json.dumps({'type':'extension_error','extensionPath':'background-extension','event':'before_agent_start','error':'background hook failed'}), flush=True)
print(json.dumps({'type':'tool_execution_start'}), flush=True)
cmd = json.loads(sys.stdin.readline())
assert cmd['type'] == 'get_commands'
print(json.dumps({'type':'response','id':cmd['id'],'command':'get_commands','success':True,'data':{'commands':[{'name':'extension'}]}}), flush=True)
cmd = json.loads(sys.stdin.readline())
assert cmd['message'] == '/extension'
print(json.dumps({'type':'extension_ui_request','id':'dialog','method':'input','title':'Secret'}), flush=True)
reply = json.loads(sys.stdin.readline())
assert reply == {'type':'extension_ui_response','id':'dialog','value':'secret-value'}
print(json.dumps({'type':'extension_error','extensionPath':'command:extension','event':'command','error':'invalid secret-value'}), flush=True)
print(json.dumps({'type':'response','id':cmd['id'],'command':'prompt','success':True,'data':{'disposition':'handled'}}), flush=True)
cmd = json.loads(sys.stdin.readline())
assert cmd['type'] == 'prompt' and cmd['message'] == '/compact keep tests'
# The adapter waits for the original response instead of aborting it. Its
# acknowledgement must also hold the process through the async SDK callback.
print(json.dumps({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'original turn complete'}]}}), flush=True)
print(json.dumps({'type':'agent_settled'}), flush=True)
import time; time.sleep(0.7)
print(json.dumps({'type':'response','id':cmd['id'],'command':'prompt','success':True,'data':{'disposition':'handled'}}), flush=True)
cmd = json.loads(sys.stdin.readline())
assert cmd['message'] == '/mcp'
import time; time.sleep(0.7)
print(json.dumps({'type':'extension_ui_request','id':'mcp-status','method':'notify','message':'demo: connected'}), flush=True)
print(json.dumps({'type':'response','id':cmd['id'],'command':'prompt','success':True,'data':{'disposition':'handled'}}), flush=True)
cmd = json.loads(sys.stdin.readline())
assert cmd['type'] == 'abort'
print(json.dumps({'type':'tool_execution_end','toolCallId':'tool','isError':True,'result':{'content':[{'type':'text','text':'Aborted'}]}}), flush=True)
print(json.dumps({'type':'agent_settled'}), flush=True)
print(json.dumps({'type':'response','id':cmd['id'],'command':'abort','success':True}), flush=True)
cmd = json.loads(sys.stdin.readline())
assert cmd['type'] == 'prompt' and cmd['message'] == 'replacement'
# Both the abort/send lease and then the asynchronous prompt waiter must keep
# the settled process alive beyond its normal 500ms handoff window.
time.sleep(0.8)
print(json.dumps({'type':'response','id':cmd['id'],'command':'prompt','success':True,'data':{'disposition':'started'}}), flush=True)
print(json.dumps({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'replacement complete'}]}}), flush=True)
print(json.dumps({'type':'agent_settled'}), flush=True)
sys.stdin.read()
"#).unwrap();
        let config: Config = serde_json::from_value(serde_json::json!({
            "repository":temp.path(), "model":"mock/model", "piCommand":if cfg!(windows) { "python" } else { "python3" },
            "piArgs":["-u", script], "maxParallel":1, "maxFeedback":0
        })).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let session_dir = temp.path().join(&id);
        let root = temp.path().to_path_buf();
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let mut output = String::new();
            let result = run_pi(
                PiRequest {
                    role: PiRole::NodeAgent,
                    config: &config,
                    cwd: &root,
                    task: "original",
                    session_dir: &session_dir,
                    extension: None,
                    tools: None,
                    session_id: None,
                    extra_args: vec![],
                    environment: vec![("GRAPHER_TEST_NODE_RPC", "1".into())],
                    system_prompt: None,
                    images: None,
                },
                |line| {
                    if line.contains("tool_execution_start") {
                        let _ = ready_tx.send(());
                    }
                    output.push_str(&line);
                },
            );
            (result, output)
        });
        ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let instance = session(&id).unwrap();
        assert!(request(
            &id,
            "stale-instance",
            serde_json::json!({"type":"get_commands"})
        )
        .is_err());
        let commands = request(&id, &instance, serde_json::json!({"type":"get_commands"})).unwrap();
        assert_eq!(commands["commands"][0]["name"], "extension");
        let command_id = uuid::Uuid::new_v4().to_string();
        let command = thread::spawn({
            let id = id.clone();
            let instance = instance.clone();
            let command_id = command_id.clone();
            move || {
                execute_owned(
                    &id,
                    &instance,
                    &command_id,
                    serde_json::json!({"type":"prompt","message":"/extension"}),
                )
            }
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let events = poll(&id, &instance, &command_id).unwrap();
            if !events.is_empty() {
                assert_eq!(events[0]["id"], "dialog");
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        assert!(execute_owned(&id, &instance, &uuid::Uuid::new_v4().to_string(), serde_json::json!({"type":"prompt","message":"/extension"}))
            .unwrap_err().contains("still running"));
        respond(&id, &instance, &command_id, serde_json::json!({"type":"extension_ui_response","id":"dialog","value":"secret-value"})).unwrap();
        assert_eq!(command.join().unwrap().unwrap()["disposition"], "handled");
        let errors = poll(&id, &instance, &command_id).unwrap();
        assert_eq!(errors[0]["error"], "invalid secret-value", "command errors reach their UI owner, not the durable log");
        let compact = command_request("/compact keep tests", &serde_json::json!({"commands":[{"name":"compact"}]})).unwrap();
        assert_eq!(execute_owned(&id, &instance, &uuid::Uuid::new_v4().to_string(), compact).unwrap()["disposition"], "handled");
        let mcp_id = uuid::Uuid::new_v4().to_string();
        execute_owned(&id, &instance, &mcp_id, serde_json::json!({"type":"prompt", "message":"/mcp"})).unwrap();
        thread::sleep(Duration::from_millis(100));
        assert!(poll(&id, &instance, &command_id).unwrap().is_empty(), "the old poll cannot steal MCP notifications");
        let notifications = poll(&id, &instance, &mcp_id).unwrap();
        assert_eq!(notifications[0]["message"], "demo: connected", "a command-only reply remains readable after a settled turn");
        interrupt_then(&id, || {
            thread::sleep(Duration::from_millis(800));
            assert!(session(&id).is_ok(), "abort must not release the process before the replacement send");
            super::super::steer_nowait(&id, "replacement", None)
        }).unwrap();
        let (result, output) = worker.join().unwrap();
        assert_eq!(result.unwrap(), "replacement complete", "interruption must continue in the same process");
        assert!(output.contains("original turn complete"), "compaction preserves the original response");
        assert!(output.contains("Aborted"));
        assert!(output.contains("background hook failed"), "ordinary extension failures survive without a composer poll");
        assert!(output.contains("extension_error"));
        assert!(!output.contains("secret-value"));
        assert!(!output.contains("extension_ui_request"));
        assert!(session(&id).is_err());
    }

    #[test]
    fn composer_commands_are_allowlisted_and_preserve_arguments() {
        let commands = serde_json::json!({"commands":[{"name":"extension"},{"name":"mcp"},{"name":"tree"},{"name":"compact","source":"extension"}]});
        for name in [
            "quit", "new", "tree", "fork", "clone", "resume", "model", "thinking", "name", "help",
            "missing",
        ] {
            assert!(command_request(&format!("/{name}"), &commands).is_err());
        }
        assert!(command_request("/name custom", &commands).is_err());
        assert_eq!(
            command_request("/extension a b", &commands).unwrap()["message"],
            "/extension a b"
        );
        assert_eq!(command_request("/mcp reconnect demo", &commands).unwrap()["message"], "/mcp reconnect demo");
        let compact = command_request("/compact keep tests", &commands).unwrap();
        assert_eq!(compact["type"], "prompt");
        assert_eq!(compact["message"], "/compact keep tests");
        assert_eq!(request_timeout(&compact), 300);
        assert_eq!(request_timeout(&command_request("/stats", &commands).unwrap()), 10);
        assert_eq!(command_request("/compact\nkeep tests", &commands).unwrap()["message"], "/compact keep tests");
        assert!(command_request("/compact", &serde_json::json!({"commands":[]})).is_err(),
            "an older process must not fall back to the destructive raw RPC");
    }
}
