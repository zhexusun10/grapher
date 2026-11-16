use super::*;

#[test]
fn planner_tail_pages_preserve_long_jsonl_records_and_unicode_across_boundaries() {
    let temp = tempfile::TempDir::new().unwrap();
    let id = Uuid::new_v4().to_string();
    let directory = temp.path().join("planning").join(&id);
    fs::create_dir_all(&directory).unwrap();
    let text = format!(
        "{}\n{}\n",
        serde_json::json!({
            "type": "tool_execution_end", "toolCallId": "large", "toolName": "read",
            "result": { "content": [{ "type": "text", "text": "中文🚀".repeat(140_000) }] }
        }),
        serde_json::json!({ "type": "message_end", "message": { "role": "assistant", "content": [{ "type": "text", "text": "完成" }] } })
    );
    fs::write(directory.join("planner.jsonl"), &text).unwrap();
    let service = Arc::new(Service {
        runtime: Mutex::new(Runtime::open(temp.path()).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), std::sync::Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    for limit in [None, Some(512 * 1024), Some(1024 * 1024), Some(u64::MAX)] {
        let mut before = text.len() as u64;
        let mut restored = String::new();
        let mut pages = 0;
        loop {
            let page = get_planning_output(
                id.clone(),
                "planner".into(),
                0,
                true,
                Some(before),
                limit,
                &service,
            )
            .unwrap();
            let start = page["startOffset"].as_u64().unwrap();
            assert!(
                start < before,
                "a long JSONL record must not produce a non-progressing tail"
            );
            assert_eq!(page["nextOffset"].as_u64().unwrap(), before);
            let content = page["content"].as_str().unwrap();
            assert_eq!(
                content.as_bytes(),
                &text.as_bytes()[start as usize..before as usize]
            );
            assert!(
                content.len() <= 1024 * 1024 + 256 * 1024,
                "tail limit includes bounded look-behind, not full history"
            );
            restored.insert_str(0, content);
            pages += 1;
            if start == 0 {
                break;
            }
            before = start;
        }
        assert!(pages > 1);
        assert_eq!(restored, text);
    }
    let forward = get_planning_output(
        id.clone(),
        "planner".into(),
        0,
        false,
        None,
        Some(u64::MAX),
        &service,
    )
    .unwrap();
    assert!(
        forward["content"].as_str().unwrap().len() <= 256 * 1024,
        "live forward reads remain capped"
    );
    let initial = get_planning_output(
        id.clone(),
        "planner".into(),
        0,
        true,
        None,
        Some(512 * 1024),
        &service,
    )
    .unwrap();
    assert!(initial["content"].as_str().unwrap().len() >= 512 * 1024 - 4);
    let larger = get_planning_output(
        id,
        "planner".into(),
        0,
        true,
        None,
        Some(1024 * 1024),
        &service,
    )
    .unwrap();
    assert!(larger["content"].as_str().unwrap().len() > initial["content"].as_str().unwrap().len());
}

#[test]
fn execution_prefix_pages_stop_at_the_durable_edit_cursor_without_changing_the_original_log() {
    let temp = tempfile::TempDir::new().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
    runtime.create(serde_json::from_value(serde_json::json!({"originalGoal":"test", "nodes":[{"id":"task","task":"test"}],"edges":[]})).unwrap(),
        serde_json::from_value(serde_json::json!({"repository":source,"model":"test","maxParallel":1})).unwrap()).unwrap();
    let execution: crate::model::Execution = serde_json::from_value(serde_json::json!({
        "id":"prefix-exec","node":"task","revision":1,"attempt":1,"sessionId":"prefix-session","worktree":source,
        "before":"","after":null,"status":"running","output":"","startedAt":1,"completedAt":null
    })).unwrap();
    runtime
        .emit(EventKind::Started {
            execution,
            message_sequences: Some(vec![]),
            fresh_restart: false,
        })
        .unwrap();
    let prefix = "retained 中文🚀 reply\n".repeat(40_000);
    let output = format!("{prefix}ABANDONED_USER_TURN\nABANDONED_RESPONSE\n");
    runtime
        .emit(EventKind::Output {
            execution_id: "prefix-exec".into(),
            text: output.clone(),
        })
        .unwrap();
    runtime
        .emit(EventKind::Finished {
            execution_id: "prefix-exec".into(),
            head: "".into(),
            output: "".into(),
            output_bytes: output.len(),
            metrics: None,
        })
        .unwrap();
    let run = runtime.state.run_id.clone();
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), std::sync::Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    let mut before = prefix.len();
    let mut restored = String::new();
    loop {
        let page = get_execution_output(
            &serde_json::json!({"runId":run,"executionId":"prefix-exec","tail":true,
            "before":before,"limit":65_536,"endOffset":prefix.len()}),
            &service,
        )
        .unwrap();
        let start = page["startOffset"].as_u64().unwrap() as usize;
        assert_eq!(page["nextOffset"], before);
        assert_eq!(page["totalBytes"], prefix.len());
        assert_eq!(page["complete"], before == prefix.len());
        assert_eq!(
            page["content"].as_str().unwrap().as_bytes(),
            &prefix.as_bytes()[start..before]
        );
        restored.insert_str(0, page["content"].as_str().unwrap());
        if start == 0 {
            break;
        }
        assert!(start < before);
        before = start;
    }
    assert_eq!(restored, prefix);
    let eof = get_execution_output(
        &serde_json::json!({"runId":run,"executionId":"prefix-exec",
        "offset":prefix.len(),"endOffset":prefix.len()}),
        &service,
    )
    .unwrap();
    assert_eq!(eof["content"], "");
    assert_eq!(eof["complete"], true);
    let runtime = service.runtime.lock().unwrap();
    assert_eq!(
        runtime.store.log_bytes(&run, "prefix-exec").unwrap(),
        output.len()
    );
    assert_eq!(
        runtime
            .store
            .execution_log_page(&run, "prefix-exec", 0, usize::MAX)
            .unwrap()
            .content,
        output
    );
}

/// The planner writer appends to planner.jsonl while live pages are read. A
/// size sampled before a forward read must never make the page report
/// nextOffset beyond totalBytes, which the frontend rejects as an invalid
/// transcript byte range.
#[test]
fn live_forward_pages_never_exceed_the_reported_total_while_the_writer_appends() {
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, Ordering};

    let temp = tempfile::TempDir::new().unwrap();
    let id = Uuid::new_v4().to_string();
    let directory = temp.path().join("planning").join(&id);
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("planner.jsonl");
    fs::write(&path, b"{}\n").unwrap();
    let service = Arc::new(Service {
        runtime: Mutex::new(Runtime::open(temp.path()).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), std::sync::Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    let stop = Arc::new(AtomicBool::new(false));
    let writer = {
        let stop = stop.clone();
        let path = path.clone();
        std::thread::spawn(move || {
            let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
            let mut index = 0u64;
            while !stop.load(Ordering::Relaxed) {
                file.write_all(format!("{{\"append\":{index}}}\n").as_bytes())
                    .unwrap();
                index += 1;
            }
        })
    };
    for _ in 0..2000 {
        // Read the last byte so the uncapped read reaches EOF as of the sampled
        // size, exactly like a live poll that caught up with the writer.
        let size = fs::metadata(&path).unwrap().len();
        let offset = size.saturating_sub(1);
        let page = get_planning_output(
            id.clone(),
            "planner".into(),
            offset,
            false,
            None,
            None,
            &service,
        )
        .unwrap();
        let start = page["startOffset"].as_u64().unwrap();
        let next = page["nextOffset"].as_u64().unwrap();
        let total = page["totalBytes"].as_u64().unwrap();
        let content = page["content"].as_str().unwrap();
        assert!(
            next <= total,
            "forward page reported nextOffset {next} beyond totalBytes {total}"
        );
        assert_eq!(
            content.len() as u64,
            next - start,
            "page content must span exactly [startOffset, nextOffset)"
        );
    }
    stop.store(true, Ordering::Relaxed);
    writer.join().unwrap();
}

#[test]
fn execution_reads_and_legacy_backfills_finish_while_the_run_projection_is_locked() {
    for (legacy, full) in [(false, false), (true, false), (false, true), (true, true)] {
        let temp = tempfile::tempdir().unwrap();
        let mut runtime = Runtime::open_lazy(temp.path()).unwrap();
        runtime.state.run_id = "isolated-log-read".into();
        runtime.state.nodes.insert("task".into(), NodeState::default());
        let execution: Execution = serde_json::from_value(serde_json::json!({
            "id":"log-exec","node":"task","revision":1,"attempt":1,"sessionId":"session",
            "worktree":"/unused","before":"","after":null,"status":"running","startedAt":1,
            "completedAt":null,"output":""
        })).unwrap();
        runtime.emit(EventKind::Started { execution, message_sequences: None, fresh_restart: false }).unwrap();
        let output = format!("{}\n", serde_json::json!({"type":"message_end","message":{
            "role":"assistant","content":[{"type":"text","text":"中文🚀".repeat(100_000)}]}}));
        if legacy {
            // Retain an old Finished payload without modern execution_logs.
            let db = rusqlite::Connection::open(temp.path().join("events.sqlite")).unwrap();
            db.execute("INSERT INTO events(run_id,timestamp,payload,kind,execution_id) VALUES(?1,2,?2,'finished','log-exec')",
                rusqlite::params![runtime.state.run_id, serde_json::to_string(&EventKind::Finished {
                    execution_id: "log-exec".into(), head: "".into(), output: output.clone(), output_bytes: 0, metrics: None,
                }).unwrap()]).unwrap();
            runtime.state.executions[0].status = "completed".into();
            runtime.state.executions[0].completed_at = Some(2);
        } else {
            runtime.emit(EventKind::Output { execution_id: "log-exec".into(), text: output.clone() }).unwrap();
            runtime.emit(EventKind::Finished { execution_id: "log-exec".into(), head: "".into(),
                output: "".into(), output_bytes: output.len(), metrics: None }).unwrap();
        }
        runtime.state.executions[0].metrics = None;
        let service = Arc::new(Service { runtime: Mutex::new(runtime), driving: AtomicBool::new(false),
            drive_signal: (Mutex::new(0), Condvar::new()), planning: AtomicBool::new(false), extension: PathBuf::new() });
        let body = serde_json::json!({"runId":"isolated-log-read","executionId":"log-exec","tail":true,"limit":65_536,"full":full});
        // Capture the small authorization/status projection, then make a long
        // Run operation own the mutex for the entire actual byte read.
        let read = capture_execution_output(&body, &service).unwrap();
        let held = service.runtime.lock().unwrap();
        let reader = service.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || { tx.send(read_execution_output(&body, &reader, read)).unwrap(); });
        let result = rx.recv_timeout(std::time::Duration::from_secs(5));
        drop(held);
        worker.join().unwrap();
        let page = result.expect("log I/O must not reacquire the Run mutex").unwrap();
        let start = page["startOffset"].as_u64().unwrap() as usize;
        assert_eq!(page["content"].as_str().unwrap().as_bytes(), &output.as_bytes()[start..]);
        assert_eq!(page["totalBytes"], output.len());
        assert_eq!(start == 0, full, "only an explicit full request reads the whole legacy log");
        assert_eq!(service.runtime.lock().unwrap().store.log_bytes("isolated-log-read", "log-exec").unwrap(), output.len());
        if full {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            loop {
                if service.runtime.lock().unwrap().state.executions[0].metrics.is_some() { break; }
                assert!(std::time::Instant::now() < deadline, "out-of-lock counters must still reach the projection");
                thread::sleep(std::time::Duration::from_millis(5));
            }
        }
    }
}

#[test]
fn a_captured_log_reader_cannot_migrate_or_recreate_a_deleted_run() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = Runtime::open_lazy(temp.path()).unwrap();
    runtime.state.run_id = "deleted-log".into();
    runtime.state.executions.push(serde_json::from_value(serde_json::json!({
        "id":"exec","node":"task","revision":1,"attempt":1,"sessionId":"session","worktree":"/unused",
        "before":"","after":null,"status":"completed","startedAt":1,"completedAt":2,"output":""
    })).unwrap());
    let service = Arc::new(Service { runtime: Mutex::new(runtime), driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()), planning: AtomicBool::new(false), extension: PathBuf::new() });
    let body = serde_json::json!({"runId":"deleted-log","executionId":"exec","tail":true});
    let read = capture_execution_output(&body, &service).unwrap();
    service.runtime.lock().unwrap().store.delete_run("deleted-log").unwrap();
    assert!(read_execution_output(&body, &service, read).unwrap_err().contains("deleted"));
    assert_eq!(service.runtime.lock().unwrap().store.log_bytes("deleted-log", "exec").unwrap(), 0);
}

#[test]
fn browser_metadata_is_reused_only_until_the_next_projection_version() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = Runtime::open_lazy(temp.path()).unwrap();
    runtime.state.run_id = "cached-metadata".into();
    let first = runtime.browser_metadata().unwrap();
    assert!(Arc::ptr_eq(&first, &runtime.browser_metadata().unwrap()));
    runtime.state.title = Some("Changed".into());
    runtime.touch();
    let changed = runtime.browser_metadata().unwrap();
    assert!(!Arc::ptr_eq(&first, &changed));
    assert_eq!(changed["title"], "Changed");
    runtime.state.run_id = "another-run".into();
    let other = runtime.browser_metadata().unwrap();
    assert!(!Arc::ptr_eq(&changed, &other));
    assert_eq!(other["runId"], "another-run");
}
