use super::*;

fn setup(node: &str) -> (tempfile::TempDir, Arc<Service>, String, Execution, PathBuf) {
    setup_with_command(node, "/bin/sh")
}

fn setup_with_command(node: &str, command: &str) -> (tempfile::TempDir, Arc<Service>, String, Execution, PathBuf) {
    crate::ensure_test_data_root();
    let temp = tempfile::TempDir::new().unwrap();
    let source = temp.path().join("source");
    let data = temp.path().join("data");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&data).unwrap();
    let script = temp.path().join("merger.sh");
    fs::write(&script, "cat >/dev/null\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"resolved\"}]}}'\n").unwrap();
    let mut runtime = Runtime::open(&data).unwrap();
    let run = Uuid::new_v4().to_string();
    runtime.state.run_id = run.clone();
    runtime.emit(EventKind::Created {
        graph: Graph {
            original_goal: "merger continuation".into(),
            nodes: vec![Node { name: "task".into(), task: "test".into() }],
            edges: vec![],
        },
        config: serde_json::from_value(serde_json::json!({
            "repository": source, "model": "test", "maxParallel": 1,
            "piCommand": command, "piArgs": [script],
        })).unwrap(),
        planning_id: None,
        planning: None,
    }).unwrap();
    runtime.emit(EventKind::Approved { base: String::new() }).unwrap();
    let previous = Execution {
        id: Uuid::new_v4().to_string(), node: node.into(), revision: 0, attempt: 1,
        session_id: Uuid::new_v4().to_string(), worktree: source.to_string_lossy().into(),
        before: String::new(), workspace_lineage: vec![], after: None, input: None, result: None,
        status: "running".into(), output: String::new(), output_bytes: 0, pid: None,
        started_at: now(), completed_at: None, metrics: None,
    };
    runtime.emit(EventKind::MergerStarted { execution: previous.clone() }).unwrap();
    runtime.emit(EventKind::MergerFailed {
        execution_id: previous.id.clone(), error: "original conflict".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    // Keep the recovered node from dispatching before its durable state is checked.
    runtime.emit(EventKind::Paused { paused: true }).unwrap();
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime), driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()), planning: AtomicBool::new(false),
        extension: temp.path().join("unused.ts"),
    });
    (temp, service, run, previous, source)
}

fn continue_with(service: &Arc<Service>, run: &str, previous: &Execution, task: String) -> Result<Snapshot, String> {
    control("continue_merger".into(), Some(previous.node.clone()), Some(task),
        Some(run.into()), Some(previous.id.clone()), None, service)
}

fn wait_for_worker(service: &Arc<Service>) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let active = service.runtime.lock().unwrap().active();
        // The terminal event precedes the scheduler wake. Wait for both worker
        // and driver references to drain before dropping their test workspace.
        if !active && !service.driving.load(Ordering::SeqCst) && Arc::strong_count(service) == 1 { return; }
        assert!(std::time::Instant::now() < deadline, "merger worker did not settle");
        thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[test]
fn merger_continuation_delivery_failure_releases_reservation_and_survives_restart() {
    for node in ["merger", "merge:task"] {
        let (_temp, service, run, previous, source) = setup(node);
        let attachment = Uuid::new_v4().to_string();
        let root = service.runtime.lock().unwrap().root.clone();
        crate::attachment_inputs::stage(&root, &run, node, &attachment, "input.txt", b"content").unwrap();
        fs::write(source.join("grapher-attachments"), b"existing user file").unwrap();
        let error = continue_with(&service, &run, &previous,
            format!("Read grapher-attachments/{attachment}/input.txt")).unwrap_err();
        {
            let runtime = service.runtime.lock().unwrap();
            assert!(!runtime.active(), "delivery failure must not leave an active writer");
            assert!(!runtime.path_is_running(&source));
            let failed = runtime.state.mergers.last().unwrap();
            assert_eq!(failed.status, "failed");
            assert!(failed.pid.is_none());
            assert!(matches!(&runtime.state.events.last().unwrap().kind,
                EventKind::MergerFailed { error: recorded, .. } if recorded == &error));
        }
        assert_eq!(fs::read(source.join("grapher-attachments")).unwrap(), b"existing user file");
        drop(service);
        let primary = Runtime::open(&root).unwrap();
        let recovered = primary.open_run(&run).unwrap();
        assert!(!recovered.active());
        assert_eq!(recovered.state.mergers.last().unwrap().status, "failed");
    }
}

#[test]
fn merger_continuation_recovery_is_atomic_with_completion_and_replays() {
    let (_temp, service, run, previous, _source) = setup("merge:task");
    let revision = service.runtime.lock().unwrap().state.nodes["task"].revision;
    let accepted = continue_with(&service, &run, &previous, "repair".into()).unwrap();
    assert_eq!(accepted.mergers.last().unwrap().revision, revision);
    wait_for_worker(&service);
    let root;
    {
        let runtime = service.runtime.lock().unwrap();
        root = runtime.root.clone();
        assert_eq!(runtime.state.mergers.last().unwrap().status, "completed");
        assert_eq!(runtime.state.nodes["task"].status, "dirty");
        assert_eq!(runtime.state.nodes["task"].revision, revision + 1);
        assert!(runtime.state.nodes["task"].error.is_none());
        assert!(runtime.state.paused);
        let stored = runtime.store.load(&run).unwrap();
        let mut replay = Snapshot::default();
        for event in &runtime.state.events { crate::model::apply(&mut replay, event); }
        for state in [&stored, &replay] {
            assert_eq!(state.nodes["task"].status, "dirty");
            assert_eq!(state.nodes["task"].revision, revision + 1);
            assert!(state.nodes["task"].error.is_none());
        }
    }
    drop(service);
    let recovered = Runtime::open(&root).unwrap().open_run(&run).unwrap();
    assert_eq!(recovered.state.nodes["task"].status, "dirty");
    assert_eq!(recovered.state.nodes["task"].revision, revision + 1);
}

#[test]
fn merger_continuation_stale_or_duplicate_completion_does_not_revive_nodes() {
    let (_temp, service, _run, previous, _source) = setup("merge:task");
    let mut runtime = service.runtime.lock().unwrap();
    let mut merger = previous;
    merger.id = Uuid::new_v4().to_string();
    merger.revision = runtime.state.nodes["task"].revision;
    runtime.emit(EventKind::MergerStarted { execution: merger.clone() }).unwrap();
    let completed = EventKind::MergerFinished {
        execution_id: merger.id, head: String::new(), output_bytes: 0, metrics: None,
    };
    runtime.emit(EventKind::Invalidated {
        nodes: vec!["task".into()], target: "task".into(), instruction: "new turn".into(),
        human: true, images: None, workspace: None, shared_workspace: false, source_direct: true,
    }).unwrap();
    runtime.emit(EventKind::Blocked { node: "task".into(), error: "new failure".into() }).unwrap();
    let revision = runtime.state.nodes["task"].revision;
    runtime.emit(completed.clone()).unwrap();
    runtime.emit(completed).unwrap();
    assert_eq!(runtime.state.nodes["task"].status, "blocked");
    assert_eq!(runtime.state.nodes["task"].revision, revision);
    assert_eq!(runtime.state.nodes["task"].error.as_deref(), Some("new failure"));
}

#[test]
fn merger_continuation_worker_start_failure_is_terminal_after_restart() {
    let (_temp, service, run, previous, _source) = setup_with_command(
        "merge:task", "grapher-nonexistent-fixture-process",
    );
    let root = service.runtime.lock().unwrap().root.clone();
    continue_with(&service, &run, &previous, "repair".into()).unwrap();
    wait_for_worker(&service);
    assert_eq!(service.runtime.lock().unwrap().state.mergers.last().unwrap().status, "failed");
    drop(service);
    let recovered = Runtime::open(&root).unwrap().open_run(&run).unwrap();
    assert!(!recovered.active());
    assert_eq!(recovered.state.mergers.last().unwrap().status, "failed");
}
