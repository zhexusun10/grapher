use super::*;
use std::time::{Duration, Instant};

fn setup() -> (tempfile::TempDir, Arc<Service>, Config, String, String) {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    let root = temp.path().join("runtime");
    let mut runtime = Runtime::open_lazy(&root).unwrap();
    let run_id = Uuid::new_v4().to_string();
    let planning_id = Uuid::new_v4().to_string();
    runtime.state.run_id = run_id.clone();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repo, "model": "mock/model", "maxParallel": 1,
        "engine": "pi", "piCommand": "python3"
    }))
    .unwrap();
    let summary = PlanningSummary {
        planning_id: planning_id.clone(),
        status: Some("running".into()),
        worktree: Some(repo.to_string_lossy().into()),
        run_id: Some(run_id.clone()),
        ..Default::default()
    };
    runtime
        .emit(EventKind::PlanningStarted {
            goal: "goal".into(),
            config: config.clone(),
            planning: summary,
            plan_type: Some("graph".into()),
        })
        .unwrap();
    fs::create_dir_all(root.join("planning").join(&planning_id)).unwrap();
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(true),
        extension: temp.path().join("unused"),
    });
    (temp, service, config, run_id, planning_id)
}

fn wait_until(mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !check() {
        assert!(
            Instant::now() < deadline,
            "fixture did not reach the expected state"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn planner_steer_tracks_rpc_and_consumption_by_identity_across_replay() {
    let (_temp, service, _, run_id, planning_id) = setup();
    let first = Uuid::new_v4().to_string();
    let second = Uuid::new_v4().to_string();
    {
        let mut runtime = service.runtime.lock().unwrap();
        for id in [&first, &second] {
            runtime
                .emit(EventKind::PlannerSteerSubmitted {
                    planning_id: planning_id.clone(),
                    request_id: id.clone(),
                    instruction: "same instruction".into(),
                    images: None,
                })
                .unwrap();
        }
    }
    let response = |id: &str| {
        serde_json::json!({"type":"response", "command":"prompt", "id":id,
        "success":true, "data":{"disposition":"queued"}})
        .to_string()
    };
    observe_planner_steer_line(&service, &run_id, &planning_id, &response(&first));
    observe_planner_steer_line(&service, &run_id, &planning_id, &response(&second));
    let user = |text: String| {
        serde_json::json!({"type":"message_start", "message":{"role":"user",
        "content":[{"type":"text", "text":text}]}})
        .to_string()
    };
    observe_planner_steer_line(
        &service,
        &run_id,
        &planning_id,
        &user("same instruction".into()),
    );
    assert_eq!(
        planner_steer_status(&service.runtime.lock().unwrap().state, &planning_id, &first)
            .as_deref(),
        Some("queued"),
        "plain repeated text is not evidence of which request was consumed"
    );
    observe_planner_steer_line(
        &service,
        &run_id,
        &planning_id,
        &user(format!("same instruction{}", planner_steer_marker(&second))),
    );
    // A late RPC response must not regress a consumed turn back to queued.
    observe_planner_steer_line(&service, &run_id, &planning_id, &response(&second));
    let runtime = service.runtime.lock().unwrap();
    let replay = runtime.store.load(&run_id).unwrap();
    assert_eq!(
        planner_steer_status(&replay, &planning_id, &first).as_deref(),
        Some("queued")
    );
    assert_eq!(
        planner_steer_status(&replay, &planning_id, &second).as_deref(),
        Some("consumed")
    );
}

#[test]
fn planner_steer_submits_during_tool_and_duplicate_http_request_is_idempotent() {
    let (temp, service, mut config, run_id, planning_id) = setup();
    let script = temp.path().join("pi.py");
    let received = temp.path().join("received.json");
    let release = temp.path().join("release");
    fs::write(&script, format!(r#"import json, pathlib, sys, time
first = json.loads(sys.stdin.readline())
print(json.dumps({{'type':'tool_execution_start','toolCallId':'tool','toolName':'bash'}}), flush=True)
command = json.loads(sys.stdin.readline())
pathlib.Path({received:?}).write_text(json.dumps(command))
print(json.dumps({{'type':'response','command':'prompt','id':command['id'],'success':True,'data':{{'disposition':'queued'}}}}), flush=True)
while not pathlib.Path({release:?}).exists(): time.sleep(0.01)
print(json.dumps({{'type':'tool_execution_end','toolCallId':'tool','toolName':'bash'}}), flush=True)
message = {{'role':'user','content':[{{'type':'text','text':command['message']}}]}}
print(json.dumps({{'type':'message_start','message':message}}), flush=True)
print(json.dumps({{'type':'message_end','message':message}}), flush=True)
print(json.dumps({{'type':'message_end','message':{{'role':'assistant','content':[{{'type':'text','text':'done'}}]}}}}), flush=True)
print(json.dumps({{'type':'agent_settled'}}), flush=True)
sys.stdin.read()
"#, received=received.to_string_lossy(), release=release.to_string_lossy())).unwrap();
    config.pi_command = "python3".into();
    config.pi_args = vec!["-u".into(), script.to_string_lossy().into()];
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let worker = {
        let service = service.clone();
        let run = run_id.clone();
        let plan = planning_id.clone();
        let root = temp.path().join("repo");
        let session = temp.path().join("session");
        thread::spawn(move || {
            crate::engine::run_pi(
                crate::engine::PiRequest {
                    role: crate::engine::PiRole::Planner,
                    config: &config,
                    cwd: &root,
                    task: "goal",
                    session_dir: &session,
                    extension: None,
                    tools: None,
                    session_id: None,
                    extra_args: vec![],
                    environment: vec![
                        ("GRAPHER_TEST_NODE_RPC", "1".into()),
                        ("GRAPHER_ACTIVE_RUN_ID", run.clone()),
                    ],
                    system_prompt: None,
                    images: None,
                },
                |line| {
                    if line.contains("tool_execution_start") {
                        let _ = ready_tx.send(());
                    }
                    observe_planner_steer_line(&service, &run, &plan, &line);
                },
            )
        })
    };
    ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let id = Uuid::new_v4().to_string();
    let submit = || {
        control_with_request_id(
            "steer_planner".into(),
            None,
            Some("inspect".into()),
            Some(run_id.clone()),
            None,
            None,
            Some(id.clone()),
            &service,
        )
        .unwrap()
    };
    let start = Instant::now();
    thread::scope(|scope| {
        let first = scope.spawn(&submit);
        let second = scope.spawn(&submit);
        first.join().unwrap();
        second.join().unwrap();
    });
    let elapsed = start.elapsed();
    submit(); // The same request ID must not enqueue a second Pi command.
    wait_until(|| {
        received.exists()
            && planner_steer_status(&service.runtime.lock().unwrap().state, &planning_id, &id)
                .as_deref()
                == Some("queued")
    });
    let before_release =
        planner_steer_status(&service.runtime.lock().unwrap().state, &planning_id, &id);
    fs::write(&release, "go").unwrap();
    let result = worker.join().unwrap();
    assert!(
        elapsed < Duration::from_secs(3),
        "HTTP acceptance must not wait for the tool"
    );
    assert_eq!(before_release.as_deref(), Some("queued"));
    assert_eq!(result.unwrap(), "done");
    let command: serde_json::Value = serde_json::from_slice(&fs::read(received).unwrap()).unwrap();
    assert_eq!(command["id"], id);
    assert_eq!(
        command["message"],
        format!("inspect{}", planner_steer_marker(&id))
    );
    let runtime = service.runtime.lock().unwrap();
    assert_eq!(
        planner_steer_status(&runtime.state, &planning_id, &id).as_deref(),
        Some("consumed")
    );
    assert_eq!(
        runtime
            .state
            .events
            .iter()
            .filter(|event| matches!(&event.kind,
        EventKind::PlannerSteerSubmitted { request_id, .. } if request_id == &id))
            .count(),
        1
    );
    drop(runtime);
    // Retrying after settlement still returns the original acceptance, not a new prompt.
    service.planning.store(false, Ordering::SeqCst);
    submit();
}

#[test]
fn planner_ack_timeout_is_unknown_and_a_late_ack_can_still_resolve_it() {
    let (_temp, service, _, run_id, planning_id) = setup();
    let id = Uuid::new_v4().to_string();
    service
        .runtime
        .lock()
        .unwrap()
        .emit(EventKind::PlannerSteerSubmitted {
            planning_id: planning_id.clone(),
            request_id: id.clone(),
            instruction: "inspect".into(),
            images: None,
        })
        .unwrap();
    expire_planner_steer_confirmation(&service, &run_id, &planning_id, &id);
    assert_eq!(
        planner_steer_status(&service.runtime.lock().unwrap().state, &planning_id, &id).as_deref(),
        Some("unknown")
    );
    observe_planner_steer_line(
        &service,
        &run_id,
        &planning_id,
        &serde_json::json!({"type":"response", "command":"prompt", "id":id, "success":true,
            "data":{"disposition":"queued"}})
        .to_string(),
    );
    expire_planner_steer_confirmation(&service, &run_id, &planning_id, &id);
    assert_eq!(
        planner_steer_status(&service.runtime.lock().unwrap().state, &planning_id, &id).as_deref(),
        Some("queued")
    );
}

#[test]
fn retrying_without_images_is_idempotent_for_an_empty_image_list() {
    let (_temp, service, _, run_id, planning_id) = setup();
    let id = Uuid::new_v4().to_string();
    service
        .runtime
        .lock()
        .unwrap()
        .emit(EventKind::PlannerSteerSubmitted {
            planning_id: planning_id.clone(),
            request_id: id.clone(),
            instruction: "inspect".into(),
            images: None,
        })
        .unwrap();
    let retried = control_with_request_id(
        "steer_planner".into(),
        None,
        Some("inspect".into()),
        Some(run_id.clone()),
        None,
        Some(Vec::new()),
        Some(id.clone()),
        &service,
    )
    .unwrap();
    assert_eq!(
        retried
            .events
            .iter()
            .filter(|event| matches!(&event.kind,
                EventKind::PlannerSteerSubmitted { request_id, .. } if request_id == &id))
            .count(),
        1
    );
}

#[test]
fn planner_rejection_is_durable_and_is_not_mistaken_for_a_queued_message() {
    let (_temp, service, _, run_id, planning_id) = setup();
    let id = Uuid::new_v4().to_string();
    service
        .runtime
        .lock()
        .unwrap()
        .emit(EventKind::PlannerSteerSubmitted {
            planning_id: planning_id.clone(),
            request_id: id.clone(),
            instruction: "inspect".into(),
            images: None,
        })
        .unwrap();
    observe_planner_steer_line(
        &service,
        &run_id,
        &planning_id,
        &serde_json::json!({"type":"response", "command":"prompt", "id":id, "success":false,
            "error":"compaction in progress"})
        .to_string(),
    );
    let runtime = service.runtime.lock().unwrap();
    let replay = runtime.store.load(&run_id).unwrap();
    assert_eq!(
        planner_steer_status(&replay, &planning_id, &id).as_deref(),
        Some("failed")
    );
    assert!(replay.events.iter().any(|event| matches!(&event.kind, EventKind::PlannerSteerStatus {
        request_id, error: Some(error), .. } if request_id == &id && error == "compaction in progress")));
}

#[test]
fn planner_live_log_append_wakes_reconnected_views_before_tool_finishes() {
    let temp = tempfile::tempdir().unwrap();
    let repo = crate::fixture::repository(temp.path()).unwrap();
    let root = temp.path().join("runtime");
    let script = temp.path().join("planner.sh");
    let start = temp.path().join("start-tool");
    let finish = temp.path().join("finish-tool");
    fs::write(&script, format!(r#"cat >/dev/null
while [ ! -f '{}' ]; do sleep 0.02; done
printf '%s\n' '{{"type":"tool_execution_start","toolCallId":"live","toolName":"bash"}}'
while [ ! -f '{}' ]; do sleep 0.02; done
printf '%s' '{{"originalGoal":"goal","nodes":[{{"name":"worker","task":"work"}}],"edges":[]}}' > "$GRAPHER_GRAPH_PATH"
printf '%s\n' '{{"type":"message_end","message":{{"role":"assistant","content":[{{"type":"text","text":"done"}}]}}}}'
"#, start.display(), finish.display())).unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repo, "model": "mock/model", "maxParallel": 1,
        "engine": "pi", "piCommand": "/bin/sh", "piArgs": [script]
    }))
    .unwrap();
    let service = Arc::new(Service {
        runtime: Mutex::new(Runtime::open_lazy(&root).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    let stream = subscribe_runtime_events();
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = {
        let service = service.clone();
        thread::spawn(move || {
            plan_goal_internal(
                "goal".into(),
                config,
                Some("graph"),
                None,
                None,
                &service,
                |_| {},
                |_| {},
                |line| {
                    let _ = tx.send(line.to_string());
                },
            )
        })
    };
    loop {
        let line = rx.recv_timeout(Duration::from_secs(15)).unwrap();
        if line.contains("grapher_process_started") {
            break;
        }
    }
    // Drain startup notifications so the next signal must come from the tool
    // append, not an earlier process-start or the terminal turn notification.
    while stream.rx.recv_timeout(Duration::from_millis(150)).is_ok() {}
    let (run_id, planning_id) = {
        let runtime = service.runtime.lock().unwrap();
        (
            runtime.state.run_id.clone(),
            runtime.state.planning_id.clone().unwrap(),
        )
    };
    fs::write(&start, "start").unwrap();
    loop {
        let line = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if line.contains("tool_execution_start") {
            break;
        }
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut observed = false;
    while Instant::now() < deadline {
        if let Ok(frame) = stream.rx.recv_timeout(Duration::from_millis(300)) {
            let text = String::from_utf8_lossy(&frame);
            if text.contains("event: planning_output_available")
                && text.contains(&run_id)
                && text.contains(&planning_id)
            {
                observed = true;
                break;
            }
        }
    }
    let running_before_release = service.planning.load(Ordering::SeqCst);
    fs::write(&finish, "finish").unwrap();
    let result = worker.join().unwrap();
    assert!(
        observed,
        "an appended tool-start must notify while the tool is still running"
    );
    assert!(running_before_release);
    result.unwrap();
}
