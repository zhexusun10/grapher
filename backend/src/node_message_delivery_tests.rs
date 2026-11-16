use super::*;

#[test]
fn node_message_delivery_waiting_input_only_queues_even_during_planning() {
    let temp = tempfile::tempdir().unwrap();
    let repository = crate::fixture::repository(temp.path()).unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repository, "model": "mock/model", "engine": "pi", "postTaskReview": false,
    })).unwrap();
    let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
    runtime.state.run_id = Uuid::new_v4().to_string();
    runtime.emit(EventKind::Created {
        graph: Graph { original_goal: "original".into(), nodes: vec![Node { id: "task".into(), task: "original".into() }], edges: vec![] },
        config, planning_id: None, planning: None,
    }).unwrap();
    runtime.approve().unwrap();
    runtime.pause(true).unwrap();
    let run_id = runtime.state.run_id.clone();
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime), driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), std::sync::Condvar::new()),
        planning: AtomicBool::new(true), extension: temp.path().join("unused.ts"),
    });
    assert!(control("intervene".into(), Some("task".into()), Some("wrong Run".into()),
        Some("stale".into()), None, None, &service).is_err());
    for planning in [true, false] {
        service.planning.store(planning, Ordering::SeqCst);
        let snapshot = control("intervene".into(), Some("task".into()), Some("extra input".into()),
            Some(run_id.clone()), None, None, &service).unwrap();
        assert!(snapshot.paused && snapshot.executions.is_empty());
        assert_eq!(snapshot.nodes["task"].status, "waiting");
        assert_eq!(snapshot.nodes["task"].instruction, "");
        assert!(matches!(snapshot.events.last().unwrap().kind, EventKind::NodeMessaged { queued: true, .. }));
        assert!(!service.driving.load(Ordering::SeqCst));
        assert_eq!(*service.drive_signal.0.lock().unwrap(), 0);
    }
    assert_eq!(service.runtime.lock().unwrap().state.nodes["task"].pending_messages.len(), 2);

    // A lost HTTP response may be retried before or after dispatch/restart.
    // Request identity, not equal text, distinguishes a retry from a new turn.
    let id = Uuid::new_v4().to_string();
    let send = |id: &str, text: &str, images| control_with_request_id(
        "intervene".into(), Some("task".into()), Some(text.into()),
        Some(run_id.clone()), None, images, Some(id.into()), &service,
    );
    assert!(send("invalid-id", "extra input", None).is_err());
    let accepted = send(&id, "extra input", Some(vec![])).unwrap();
    let replay = send(&id, "extra input", None).unwrap();
    assert_eq!(replay.events.len(), accepted.events.len());
    assert_eq!(replay.nodes["task"].pending_messages.len(), 3);
    assert!(send(&id, "changed payload", None).is_err());
    let distinct = send(&Uuid::new_v4().to_string(), "extra input", None).unwrap();
    assert_eq!(distinct.nodes["task"].pending_messages.len(), 4);
    let dispatched_count = {
        let mut runtime = service.runtime.lock().unwrap();
        runtime.pause(false).unwrap();
        let job = runtime.jobs().unwrap().remove(0);
        assert_eq!(job.task.matches("extra input").count(), 4);
        runtime.pause(true).unwrap();
        runtime.state = runtime.store.load(&run_id).unwrap();
        runtime.state.events.len()
    };
    // No live Pi is registered: a duplicate must return the durable receipt,
    // not attempt an RPC or wake this paused Run after another event was added.
    let replay = send(&id, "extra input", None).unwrap();
    assert_eq!(replay.events.len(), dispatched_count);
    assert!(replay.paused);
    assert!(replay.nodes["task"].pending_messages.is_empty());
    assert!(!service.driving.load(Ordering::SeqCst));
    assert_eq!(*service.drive_signal.0.lock().unwrap(), 0);
}

#[test]
fn node_message_delivery_followup_retries_keep_identity_before_and_after_dispatch() {
    for outcome in ["completed", "failed", "published"] {
        let temp = tempfile::tempdir().unwrap();
        let repository = crate::fixture::repository(temp.path()).unwrap();
        let config = serde_json::from_value(serde_json::json!({
            "repository": repository, "model": "mock/model", "postTaskReview": false,
        })).unwrap();
        let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
        runtime.state.run_id = Uuid::new_v4().to_string();
        runtime.emit(EventKind::Created {
            graph: Graph { original_goal: "original".into(), nodes: vec![Node {
                id: "task".into(), task: "original".into(),
            }], edges: vec![] },
            config, planning_id: None, planning: None,
        }).unwrap();
        runtime.approve().unwrap();
        let first = runtime.jobs().unwrap().remove(0).execution;
        runtime.pause(true).unwrap();
        if outcome == "failed" {
            runtime.finish(&first, Err("provider failed".into())).unwrap();
        } else {
            runtime.emit(EventKind::Finished {
                execution_id: first.id, head: runtime.state.base.clone(), output: String::new(),
                output_bytes: 0, metrics: None,
            }).unwrap();
            if outcome == "published" {
                runtime.emit(EventKind::PublicationCompleted { head: runtime.state.base.clone() }).unwrap();
            }
        }
        let run = runtime.state.run_id.clone();
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime), driving: AtomicBool::new(true),
            drive_signal: (Mutex::new(0), Condvar::new()),
            planning: AtomicBool::new(false), extension: temp.path().join("unused"),
        });
        let request = Uuid::new_v4().to_string();
        let send = |id: &str, text: &str, data: &str| control_with_request_id(
            "intervene".into(), Some("task".into()), Some(text.into()), Some(run.clone()),
            None, Some(vec![ImageAttachment {
                r#type: "image".into(), mime_type: "image/png".into(), data: data.into(), name: None,
            }]), Some(id.into()), &service,
        );
        let accepted = send(&request, "follow-up", "first").unwrap();
        let retried = send(&request, "follow-up", "first").unwrap();
        assert_eq!(retried.events.len(), accepted.events.len(), "{outcome}: retry is not another turn");
        assert_eq!(retried.nodes["task"].pending_messages.len(), 1);
        assert!(send(&request, "different payload", "first").is_err());
        assert!(send(&request, "follow-up", "different image").is_err());
        // A genuinely new submission with identical content remains distinct.
        send(&Uuid::new_v4().to_string(), "follow-up", "first").unwrap();
        let event_count = {
            let mut runtime = service.runtime.lock().unwrap();
            runtime.resume_scheduling().unwrap();
            let job = runtime.jobs().unwrap().remove(0);
            assert_eq!(job.task.matches("follow-up").count(), 2);
            assert_eq!(job.images.unwrap().len(), 2);
            runtime.state = runtime.store.load(&run).unwrap();
            runtime.state.events.len()
        };
        // A durable receipt must work without a live Pi process, even after
        // the accepted input was claimed and the Snapshot was reloaded.
        let replay = send(&request, "follow-up", "first").unwrap();
        assert_eq!(replay.events.len(), event_count, "{outcome}");
        assert!(replay.nodes["task"].pending_messages.is_empty());
    }
}

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
                    id: "task".into(),
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
