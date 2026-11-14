use super::*;

#[test]
fn node_message_delivery_stale_intervene_and_consecutive_steers_use_one_live_writer() {
    let temp = tempfile::tempdir().unwrap();
    let repository = crate::fixture::repository(temp.path()).unwrap();
    let script = temp.path().join("rpc.py");
    fs::write(&script, r#"import json, sys, time
first = json.loads(sys.stdin.readline())
assert first['message'] == 'original'
print(json.dumps({'type':'response','command':'prompt','success':True}), flush=True)
print(json.dumps({'type':'tool_execution_start'}), flush=True)
for index, expected in enumerate(['stale browser message', 'same', 'same']):
    message = json.loads(sys.stdin.readline())
    assert message['streamingBehavior'] == 'steer'
    assert message['message'] == expected + '\n\n<grapher-node-steer-id>' + message['id'] + '</grapher-node-steer-id>'
    assert message['images'][0]['data'] == str(index)
    # A long tool turn may not acknowledge promptly. Control must return after
    # delivery instead of blocking the HTTP worker on this response.
    time.sleep(1.2)
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
    }))
    .unwrap();
    let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
    runtime.state.run_id = Uuid::new_v4().to_string();
    runtime
        .emit(EventKind::Created {
            graph: Graph {
                original_goal: "original".into(),
                nodes: vec![Node {
                    name: "task".into(),
                    task: "original".into(),
                }],
                edges: vec![],
            },
            config: config.clone(),
            planning_id: None,
            planning: None,
        })
        .unwrap();
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    let run_id = runtime.state.run_id.clone();
    let execution_id = job.execution.id.clone();
    let root = runtime.root.clone();
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), std::sync::Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused.ts"),
    });
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let worker = thread::spawn(move || {
        crate::engine::run_pi(
            crate::engine::PiRequest {
                role: crate::engine::PiRole::NodeAgent,
                config: &config,
                cwd: &repository,
                task: "original",
                session_dir: &root.join("sessions").join(&job.execution.id),
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
            },
        )
    });
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    for (index, text) in ["stale browser message", "same", "same"]
        .into_iter()
        .enumerate()
    {
        let started = std::time::Instant::now();
        let snapshot = control(
            if index == 0 { "intervene" } else { "steer" }.into(),
            Some("task".into()),
            Some(text.into()),
            Some(run_id.clone()),
            (index > 0).then(|| execution_id.clone()),
            Some(vec![crate::model::ImageAttachment {
                r#type: "image".into(),
                mime_type: "image/png".into(),
                data: index.to_string(),
                name: None,
            }]),
            &service,
        )
        .unwrap();
        assert!(
            started.elapsed() < std::time::Duration::from_millis(500),
            "control must not wait for Pi's steer acknowledgement"
        );
        assert_eq!(snapshot.executions.len(), 1);
        assert!(snapshot.nodes["task"].pending_messages.is_empty());
        let request_id = snapshot.events.iter().rev().find_map(|event| match &event.kind {
            EventKind::Steered { request_id, .. } => request_id.clone(), _ => None,
        }).unwrap();
        Uuid::parse_str(&request_id).unwrap();
        // An HTTP retry of Alt+S must neither abort again nor enqueue twice.
        let retried = control_with_request_id("interrupt_steer".into(), Some("task".into()), Some(text.into()),
            Some(run_id.clone()), Some(execution_id.clone()), Some(vec![crate::model::ImageAttachment {
                r#type: "image".into(), mime_type: "image/png".into(), data: index.to_string(), name: None,
            }]), Some(request_id), &service).unwrap();
        assert_eq!(retried.events.iter().filter(|event| matches!(event.kind, EventKind::Steered { .. })).count(), index + 1);
    }
    assert_eq!(worker.join().unwrap().unwrap(), "all received");
    let (first_request_id, event_count) = {
        let mut runtime = service.runtime.lock().unwrap();
        runtime.state.executions[0].status = "completed".into();
        runtime.state.nodes.get_mut("task").unwrap().status = "completed".into();
        runtime.state.paused = true;
        let id = runtime.state.events.iter().find_map(|event| match &event.kind {
            EventKind::Steered { request_id, .. } => request_id.clone(), _ => None,
        }).unwrap();
        (id, runtime.state.events.len())
    };
    // The original stale-browser action was intervene. Retrying it after the
    // writer settles must replay the receipt, not enqueue a new execution.
    let replay = control_with_request_id("intervene".into(), Some("task".into()), Some("stale browser message".into()),
        Some(run_id.clone()), None, Some(vec![crate::model::ImageAttachment {
            r#type: "image".into(), mime_type: "image/png".into(), data: "0".into(), name: None,
        }]), Some(first_request_id.clone()), &service).unwrap();
    assert_eq!(replay.events.len(), event_count, "the original action remains idempotent after settlement");
    assert!(replay.nodes["task"].pending_messages.is_empty());
    assert!(control_with_request_id("intervene".into(), Some("task".into()), Some("different instruction".into()),
        Some(run_id.clone()), None, None, Some(first_request_id), &service).is_err());
    let runtime = service.runtime.lock().unwrap();
    let replayed = runtime.store.load(&run_id).unwrap();
    let messages = replayed
        .events
        .iter()
        .filter_map(|event| match &event.kind {
            EventKind::Steered {
                execution_id: id,
                instruction,
                request_id,
                ..
            } => {
                assert_eq!(id, &execution_id);
                assert!(request_id.is_some());
                Some(instruction.as_str())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(messages, ["stale browser message", "same", "same"]);
}
