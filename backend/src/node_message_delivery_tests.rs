use super::*;

#[test]
fn node_message_delivery_stale_intervene_and_consecutive_steers_use_one_live_writer() {
    let temp = tempfile::tempdir().unwrap();
    let repository = crate::fixture::repository(temp.path()).unwrap();
    let script = temp.path().join("rpc.py");
    fs::write(&script, r#"import json, sys
first = json.loads(sys.stdin.readline())
assert first['message'] == 'original'
print(json.dumps({'type':'response','command':'prompt','success':True}), flush=True)
print(json.dumps({'type':'tool_execution_start'}), flush=True)
for index, expected in enumerate(['stale browser message', 'same', 'same']):
    message = json.loads(sys.stdin.readline())
    assert message['streamingBehavior'] == 'steer'
    assert message['message'] == expected
    assert message['images'][0]['data'] == str(index)
    print(json.dumps({'type':'response','id':message['id'],'command':'prompt','success':True}), flush=True)
print(json.dumps({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'all received'}]}}), flush=True)
print(json.dumps({'type':'agent_settled'}), flush=True)
sys.stdin.read()
"#).unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repository, "model": "mock/model", "engine": "pi",
        "piCommand": if cfg!(windows) { "python" } else { "python3" },
        "piArgs": ["-u", script.to_str().unwrap()], "maxParallel": 1, "maxFeedback": 0,
        "postTaskReview": false,
    })).unwrap();
    let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
    runtime.state.run_id = Uuid::new_v4().to_string();
    runtime.emit(EventKind::Created {
        graph: Graph { original_goal: "original".into(), nodes: vec![Node { name: "task".into(), task: "original".into() }], edges: vec![] },
        config: config.clone(), planning_id: None, planning: None,
    }).unwrap();
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    let run_id = runtime.state.run_id.clone();
    let execution_id = job.execution.id.clone();
    let root = runtime.root.clone();
    let service = Arc::new(Service { runtime: Mutex::new(runtime), driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), std::sync::Condvar::new()), planning: AtomicBool::new(false), extension: temp.path().join("unused.ts") });
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let worker = thread::spawn(move || {
        crate::engine::run_pi(crate::engine::PiRequest {
            role: crate::engine::PiRole::NodeAgent, config: &config, cwd: &repository, task: "original",
            session_dir: &root.join("sessions").join(&job.execution.id), extension: None, tools: None,
            session_id: None, extra_args: vec![], environment: vec![("GRAPHER_TEST_NODE_RPC", "1".into())],
            system_prompt: None, images: None,
        }, |line| { if line.contains("tool_execution_start") { let _ = ready_tx.send(()); } })
    });
    ready_rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
    for (index, text) in ["stale browser message", "same", "same"].into_iter().enumerate() {
        let snapshot = control(if index == 0 { "intervene" } else { "steer" }.into(), Some("task".into()),
            Some(text.into()), Some(run_id.clone()), (index > 0).then(|| execution_id.clone()),
            Some(vec![crate::model::ImageAttachment { r#type: "image".into(), mime_type: "image/png".into(), data: index.to_string(), name: None }]), &service).unwrap();
        assert_eq!(snapshot.executions.len(), 1);
        assert!(snapshot.nodes["task"].pending_messages.is_empty());
    }
    assert_eq!(worker.join().unwrap().unwrap(), "all received");
    let runtime = service.runtime.lock().unwrap();
    let replayed = runtime.store.load(&run_id).unwrap();
    let messages = replayed.events.iter().filter_map(|event| match &event.kind {
        EventKind::Steered { execution_id: id, instruction, .. } => { assert_eq!(id, &execution_id); Some(instruction.as_str()) },
        _ => None,
    }).collect::<Vec<_>>();
    assert_eq!(messages, ["stale browser message", "same", "same"]);
}
