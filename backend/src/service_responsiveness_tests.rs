use super::*;
use std::time::Duration;

fn primary(root: &std::path::Path) -> Arc<Service> {
    Arc::new(Service {
        runtime: Mutex::new(Runtime::open_lazy(root).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: root.join("unused.ts"),
    })
}

#[test]
fn a_busy_run_does_not_hold_the_primary_runtime_during_unrelated_lookup() {
    let temp = tempfile::tempdir().unwrap();
    let primary = primary(temp.path());
    let busy = service_for_run(&primary, "busy", true).unwrap();
    let held = busy.runtime.lock().unwrap();
    let other_primary = primary.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let lookup = thread::spawn(move || {
        tx.send(service_for_run(&other_primary, "new-conversation", true))
            .unwrap();
    });
    let result = rx.recv_timeout(Duration::from_millis(3000));
    let primary_available = primary.runtime.try_lock().is_ok();
    // Always unblock the old implementation before asserting, so a failing
    // regression cannot leak a locked global registry into other tests.
    drop(held);
    lookup.join().unwrap();
    invalidate_service_cache(temp.path(), None);
    assert!(
        primary_available,
        "Run lookup must not hold the primary mutex while waiting on another Run"
    );
    assert!(
        result.is_ok(),
        "An unrelated busy Run must not stall a new conversation"
    );
    assert!(result.unwrap().is_ok());
}

#[test]
fn saving_model_defaults_does_not_rediscover_or_scan_the_repository() {
    let temp = tempfile::tempdir().unwrap();
    let primary = primary(temp.path());
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": temp.path(), "model": "mock/model", "maxParallel": 1
    }))
    .unwrap();
    let saved = save_config(config, &primary).unwrap();
    assert_eq!(saved.config.model, "mock/model");
    assert!(
        saved.repository_info.is_none(),
        "Saving model settings is not repository discovery"
    );
}

#[test]
fn concurrent_lookups_of_one_identity_share_one_writer() {
    let temp = tempfile::tempdir().unwrap();
    let primary = primary(temp.path());
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let lookups: Vec<_> = (0..8)
        .map(|_| {
            let primary = primary.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                service_for_run(&primary, "same-conversation", true).unwrap()
            })
        })
        .collect();
    let services: Vec<_> = lookups
        .into_iter()
        .map(|lookup| lookup.join().unwrap())
        .collect();
    assert!(services
        .iter()
        .all(|service| Arc::ptr_eq(service, &services[0])));
    invalidate_service_cache(temp.path(), None);
}

#[test]
fn a_busy_renamed_alias_fails_fast_instead_of_opening_a_second_writer() {
    let temp = tempfile::tempdir().unwrap();
    let primary = primary(temp.path());
    let busy = service_for_run(&primary, "original-alias", true).unwrap();
    let mut held = busy.runtime.lock().unwrap();
    // Older callers may change a service's durable identity. Its old registry
    // key is not proof that another writer can safely replay the new Run.
    held.state.run_id = "durable-identity".into();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": temp.path(), "model": "mock/model", "maxParallel": 1
    }))
    .unwrap();
    held.emit(EventKind::Created {
        graph: Graph::default(),
        config,
        planning_id: None,
        planning: None,
    })
    .unwrap();
    let other_primary = primary.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let lookup = thread::spawn(move || {
        tx.send(service_for_run(&other_primary, "durable-identity", false))
            .unwrap();
    });
    let result = rx.recv_timeout(Duration::from_secs(2));
    let primary_available = primary.runtime.try_lock().is_ok();
    drop(held);
    lookup.join().unwrap();
    assert!(primary_available);
    let result = result.expect("Busy alias lookup should return without waiting for its lock");
    assert!(
        result.is_err(),
        "Do not create another writer for an unverified busy alias"
    );
    let resolved = service_for_run(&primary, "durable-identity", false).unwrap();
    assert!(Arc::ptr_eq(&resolved, &busy));
    invalidate_service_cache(temp.path(), None);
}

#[test]
fn sse_event_stream_coalesces_outputs_and_suppresses_mid_stream_snapshot_storms() {
    let temp = tempfile::tempdir().unwrap();
    let mut stream = subscribe_runtime_events();
    let mut connected_buf = [0u8; 64];
    let n = std::io::Read::read(&mut stream, &mut connected_buf).unwrap();
    assert_eq!(&connected_buf[..n], b": connected\n\n");

    let mut runtime = Runtime::open_lazy(temp.path()).unwrap();
    runtime.state.run_id = "sse-run".into();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": temp.path(), "model": "mock/model", "maxParallel": 1
    }))
    .unwrap();
    runtime
        .emit(EventKind::Created {
            graph: Graph {
                original_goal: "test sse".into(),
                nodes: vec![Node {
                    name: "node-1".into(),
                    task: "work".into(),
                }],
                edges: vec![],
            },
            config,
            planning_id: None,
            planning: None,
        })
        .unwrap();
    runtime
        .emit(EventKind::Started {
            execution: Execution {
                id: "exec-1".into(),
                node: "node-1".into(),
                revision: 0,
                attempt: 1,
                session_id: "sess-1".into(),
                worktree: temp.path().to_string_lossy().into_owned(),
                before: String::new(),
                workspace_lineage: vec![],
                after: None,
                input: None,
                result: None,
                status: "running".into(),
                output: String::new(),
                output_bytes: 0,
                pid: None,
                started_at: now(),
                completed_at: None,
                metrics: None,
            },
        })
        .unwrap();
    // First output chunk (0 -> 6 bytes) emits both snapshot_changed and output_available.
    runtime
        .emit_outputs(vec![EventKind::Output {
            execution_id: "exec-1".into(),
            text: "first\n".into(),
        }])
        .unwrap();

    let mut batch1 = vec![0u8; 1024];
    let n1 = std::io::Read::read(&mut stream, &mut batch1).unwrap();
    let frame1 = String::from_utf8_lossy(&batch1[..n1]);
    assert!(
        frame1.contains("event: snapshot_changed"),
        "Creation, start and first output byte must emit snapshot_changed: {frame1}"
    );
    assert!(
        frame1.contains("\"executionId\":\"exec-1\"") && frame1.contains("\"totalBytes\":6"),
        "First output chunk must emit output_available with totalBytes=6: {frame1}"
    );

    // Subsequent burst of output chunks (>0 -> >0 bytes) must coalesce into one
    // output_available with the final byte count and MUST NOT emit snapshot_changed.
    runtime
        .emit_outputs(vec![
            EventKind::Output {
                execution_id: "exec-1".into(),
                text: "second\n".into(),
            },
            EventKind::Output {
                execution_id: "exec-1".into(),
                text: "third\n".into(),
            },
        ])
        .unwrap();

    let mut batch2 = vec![0u8; 1024];
    let n2 = std::io::Read::read(&mut stream, &mut batch2).unwrap();
    let frame2 = String::from_utf8_lossy(&batch2[..n2]);
    assert!(
        !frame2.contains("event: snapshot_changed"),
        "Mid-stream output chunks must not trigger snapshot_changed storms: {frame2}"
    );
    assert!(
        frame2.contains("event: output_available")
            && frame2.contains("\"totalBytes\":19")
            && frame2.contains("\"settled\":false"),
        "Burst chunks must coalesce to totalBytes=19: {frame2}"
    );

    // Terminal event emits both snapshot_changed and output_available with settled=true.
    runtime
        .emit(EventKind::Finished {
            execution_id: "exec-1".into(),
            head: String::new(),
            output: String::new(),
            output_bytes: 19,
            metrics: None,
        })
        .unwrap();
    let mut batch3 = vec![0u8; 1024];
    let n3 = std::io::Read::read(&mut stream, &mut batch3).unwrap();
    let frame3 = String::from_utf8_lossy(&batch3[..n3]);
    assert!(frame3.contains("event: snapshot_changed"));
    assert!(frame3.contains("\"settled\":true"));

    drop(stream);
}
