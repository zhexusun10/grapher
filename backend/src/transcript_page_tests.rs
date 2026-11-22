use super::*;

fn record_test_planning(directory: &std::path::Path, id: &str, repository: &std::path::Path) {
    write_planning_summary(
        directory,
        &PlanningSummary {
            planning_id: id.into(),
            run_id: Some(Uuid::new_v4().to_string()),
            repository: Some(repository.to_string_lossy().into()),
            goal: Some("test".into()),
            status: Some("running".into()),
            ..Default::default()
        },
    )
    .unwrap();
}

#[test]
fn planner_tail_pages_preserve_long_jsonl_records_and_unicode_across_boundaries() {
    let temp = tempfile::TempDir::new().unwrap();
    let id = Uuid::new_v4().to_string();
    let directory = temp.path().join("planning").join(&id);
    fs::create_dir_all(&directory).unwrap();
    record_test_planning(&directory, &id, temp.path());
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
    record_test_planning(&directory, &id, temp.path());
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
fn execution_reads_finish_while_the_run_projection_is_locked() {
    for full in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let mut runtime = Runtime::open_lazy(temp.path()).unwrap();
        runtime.state.run_id = "isolated-log-read".into();
        runtime
            .state
            .nodes
            .insert("task".into(), NodeState::default());
        let execution: Execution = serde_json::from_value(serde_json::json!({
            "id":"log-exec","node":"task","revision":1,"attempt":1,"sessionId":"session",
            "worktree":"/unused","before":"","after":null,"status":"running","startedAt":1,
            "completedAt":null,"output":""
        }))
        .unwrap();
        runtime
            .emit(EventKind::Started {
                execution,
                message_sequences: Some(vec![]),
                fresh_restart: false,
            })
            .unwrap();
        let output = format!(
            "{}\n",
            serde_json::json!({"type":"message_end","message":{
            "role":"assistant","content":[{"type":"text","text":"中文🚀".repeat(100_000)}]}})
        );
        {
            runtime
                .emit(EventKind::Output {
                    execution_id: "log-exec".into(),
                    text: output.clone(),
                })
                .unwrap();
            runtime
                .emit(EventKind::Finished {
                    execution_id: "log-exec".into(),
                    head: "".into(),
                    output: "".into(),
                    output_bytes: output.len(),
                    metrics: None,
                })
                .unwrap();
        }
        runtime.state.executions[0].metrics = None;
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            drive_signal: (Mutex::new(0), Condvar::new()),
            planning: AtomicBool::new(false),
            extension: PathBuf::new(),
        });
        let body = serde_json::json!({"runId":"isolated-log-read","executionId":"log-exec","tail":true,"limit":65_536,"full":full});
        // Capture the small authorization/status projection, then make a long
        // Run operation own the mutex for the entire actual byte read.
        let read = capture_execution_output(&body, &service).unwrap();
        let held = service.runtime.lock().unwrap();
        let reader = service.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || {
            tx.send(read_execution_output(&body, &reader, read))
                .unwrap();
        });
        let result = rx.recv_timeout(std::time::Duration::from_secs(5));
        drop(held);
        worker.join().unwrap();
        let page = result
            .expect("log I/O must not reacquire the Run mutex")
            .unwrap();
        let start = page["startOffset"].as_u64().unwrap() as usize;
        assert_eq!(
            page["content"].as_str().unwrap().as_bytes(),
            &output.as_bytes()[start..]
        );
        assert_eq!(page["totalBytes"], output.len());
        assert_eq!(
            start == 0,
            full,
            "only an explicit full request reads the whole log"
        );
        assert_eq!(
            service
                .runtime
                .lock()
                .unwrap()
                .store
                .log_bytes("isolated-log-read", "log-exec")
                .unwrap(),
            output.len()
        );
        if full {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            loop {
                if service.runtime.lock().unwrap().state.executions[0]
                    .metrics
                    .is_some()
                {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "out-of-lock counters must still reach the projection"
                );
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
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: PathBuf::new(),
    });
    let body = serde_json::json!({"runId":"deleted-log","executionId":"exec","tail":true});
    let read = capture_execution_output(&body, &service).unwrap();
    service
        .runtime
        .lock()
        .unwrap()
        .store
        .delete_run("deleted-log")
        .unwrap();
    assert!(read_execution_output(&body, &service, read)
        .unwrap_err()
        .contains("deleted"));
    assert_eq!(
        service
            .runtime
            .lock()
            .unwrap()
            .store
            .log_bytes("deleted-log", "exec")
            .unwrap(),
        0
    );
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

#[test]
fn planner_missing_first_log_returns_a_complete_zero_byte_cursor_page() {
    let temp = tempfile::tempdir().unwrap();
    let id = Uuid::new_v4().to_string();
    let directory = temp.path().join("planning").join(&id);
    fs::create_dir_all(&directory).unwrap();
    record_test_planning(&directory, &id, temp.path());
    let service = Arc::new(Service {
        runtime: Mutex::new(Runtime::open_lazy(temp.path()).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    let page: crate::api_contract::PlanningOutputPage = serde_json::from_value(
        get_planning_output(id, "planner".into(), 0, false, None, None, &service).unwrap(),
    ).unwrap();
    assert_eq!((page.start_offset, page.next_offset, page.total_bytes), (0, 0, 0));
    assert!(page.content.is_empty() && page.complete && page.running);
}

#[test]
fn execution_steer_offsets_survive_chunk_boundaries_and_partial_tail_reads() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = Runtime::open_lazy(temp.path()).unwrap();
    runtime.state.run_id = "steer-offset-run".into();
    let execution = Execution {
        id: "exec-1".into(),
        node: "task".into(),
        revision: 1,
        attempt: 1,
        session_id: "session".into(),
        worktree: "/unused".into(),
        before: String::new(),
        workspace_lineage: Vec::new(),
        after: None,
        input: None,
        result: None,
        status: "running".into(),
        output: String::new(),
        output_bytes: 0,
        pid: None,
        started_at: 1,
        completed_at: None,
        metrics: None,
    };
    runtime
        .state
        .nodes
        .insert("task".into(), crate::model::NodeState::default());
    runtime
        .emit(EventKind::Started {
            execution,
            message_sequences: Some(vec![]),
            fresh_restart: true,
        })
        .unwrap();
    let req1 = "11111111-1111-4111-8111-111111111111";
    let req2 = "22222222-2222-4222-8222-222222222222";
    let req_unread = "33333333-3333-4333-8333-333333333333";
    for (req, text) in [(req1, "first"), (req2, "second"), (req_unread, "still queued")] {
        runtime
            .emit(EventKind::Steered {
                execution_id: "exec-1".into(),
                node: "task".into(),
                instruction: text.into(),
                request_id: Some(req.into()),
                images: None,
            })
            .unwrap();
    }

    // Pad past a 32KB chunk boundary so req1's JSONL line itself crosses the boundary.
    let prefix_pad = format!(
        "{{\"type\":\"message_end\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}}}\n",
        "a".repeat(32_768 - 95)
    );
    let steer1_offset = prefix_pad.len();
    let steer1_line = format!(
        "{{\"grapherRequestId\":\"{req1}\",\"type\":\"message_start\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"REWRITTEN_1\"}}]}}}}\n\
         {{\"grapherRequestId\":\"{req1}\",\"type\":\"message_end\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"REWRITTEN_1\"}}]}}}}\n"
    );
    let mid_pad = format!(
        "{{\"type\":\"message_end\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}}}\n",
        "b".repeat(120_000)
    );
    let steer2_offset = steer1_offset + steer1_line.len() + mid_pad.len();
    let steer2_line = format!(
        "{{\"grapherRequestId\":\"{req2}\",\"type\":\"message_start\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"REWRITTEN_2\"}}]}}}}\n"
    );
    let output = format!("{prefix_pad}{steer1_line}{mid_pad}{steer2_line}");
    runtime
        .emit(EventKind::Output {
            execution_id: "exec-1".into(),
            text: output.clone(),
        })
        .unwrap();

    let service = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: PathBuf::new(),
    });
    let body = serde_json::json!({
        "runId": "steer-offset-run",
        "executionId": "exec-1",
        "tail": true,
        "limit": 40_000
    });
    let page = get_execution_output(&body, &service).unwrap();
    let start = page["startOffset"].as_u64().unwrap() as usize;
    assert!(start > steer1_offset, "tail page must omit the earlier steer1");
    assert!(start <= steer2_offset, "tail page must include steer2");
    assert_eq!(page["steerOffsetsAuthoritative"], serde_json::json!(true));
    assert_eq!(page["steerOffsets"][req1], serde_json::json!(steer1_offset));
    assert_eq!(page["steerOffsets"][req2], serde_json::json!(steer2_offset));
    assert!(
        page["steerOffsets"].get(req_unread).is_none(),
        "unread steer must be absent from consumed offsets"
    );
}

#[test]
fn steer_offsets_handle_multibyte_utf8_split_oversized_images_and_quoted_tool_payloads() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = Runtime::open_lazy(temp.path()).unwrap();
    runtime.state.run_id = "steer-utf8-img-run".into();
    let execution = crate::model::Execution {
        id: "exec-1".into(),
        node: "task".into(),
        revision: 1,
        attempt: 1,
        session_id: "session-1".into(),
        worktree: "/unused".into(),
        before: String::new(),
        workspace_lineage: Vec::new(),
        after: None,
        input: None,
        result: None,
        status: "running".into(),
        output: String::new(),
        output_bytes: 0,
        pid: None,
        started_at: 1,
        completed_at: None,
        metrics: None,
    };
    runtime
        .state
        .nodes
        .insert("task".into(), crate::model::NodeState::default());
    runtime
        .emit(EventKind::Started {
            execution,
            message_sequences: Some(vec![]),
            fresh_restart: true,
        })
        .unwrap();
    let req_split = "aaaaaaaa-1111-4111-8111-111111111111";
    let req_image = "bbbbbbbb-2222-4222-8222-222222222222";
    let req_fake = "cccccccc-3333-4333-8333-333333333333";
    for (req, text) in [(req_split, "split"), (req_image, "image")] {
        runtime
            .emit(EventKind::Steered {
                execution_id: "exec-1".into(),
                node: "task".into(),
                instruction: text.into(),
                request_id: Some(req.into()),
                images: None,
            })
            .unwrap();
    }

    // Place multi-byte UTF-8 ("中文") within 16 bytes before a 32KB chunk boundary
    // that splits `"grapherRequestId"` right between `grapherRe` and `questId`.
    // `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"...中文"}]}}\n`
    // followed by `{"grapherRe` (11 bytes) ending right at byte 32_768.
    let suffix = "中文\"}]}}\n";
    let header = "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"";
    let target_before_split = 32_768 - "{\"grapherRe".len();
    let pad_len = target_before_split - header.len() - suffix.len();
    let prefix = format!("{header}{}{suffix}", "x".repeat(pad_len));
    let split_offset = prefix.len();
    assert_eq!(split_offset + "{\"grapherRe".len(), 32_768);
    // Verify `chunk.len() - 16` inside chunk 0 lands on a non-char-boundary of "中文".
    let split_line = format!(
        "{{\"grapherRequestId\":\"{req_split}\",\"type\":\"message_start\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"ok\"}}]}}}}\n"
    );
    // An oversized (> 128KB) base64 image steer line must still be indexed without parsing 128KB JSON.
    let image_offset = split_offset + split_line.len();
    let image_line = format!(
        "{{\"grapherRequestId\":\"{req_image}\",\"type\":\"message_start\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"see pic\"}},{{\"type\":\"image\",\"mimeType\":\"image/png\",\"data\":\"{}\"}}]}}}}\n",
        "A".repeat(140_000)
    );
    // A huge tool result quoting `"grapherRequestId"` deep inside its body must be ignored.
    let quoted_tool_line = format!(
        "{{\"type\":\"tool_execution_end\",\"toolCallId\":\"t1\",\"result\":\"{}{}\"}}\n",
        "z".repeat(20_000),
        format!("{{\\\"grapherRequestId\\\":\\\"{req_fake}\\\",\\\"type\\\":\\\"message_start\\\",\\\"message\\\":{{\\\"role\\\":\\\"user\\\"}}}}")
    );
    let output = format!("{prefix}{split_line}{image_line}{quoted_tool_line}");
    runtime
        .emit(EventKind::Output {
            execution_id: "exec-1".into(),
            text: output.clone(),
        })
        .unwrap();

    let service = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: PathBuf::new(),
    });
    let page = get_execution_output(
        &serde_json::json!({"runId":"steer-utf8-img-run","executionId":"exec-1","tail":true,"limit":16_384}),
        &service,
    )
    .unwrap();
    assert_eq!(page["steerOffsetsAuthoritative"], serde_json::json!(true));
    assert_eq!(page["steerOffsets"][req_split], serde_json::json!(split_offset));
    assert_eq!(page["steerOffsets"][req_image], serde_json::json!(image_offset));
    assert!(page["steerOffsets"].get(req_fake).is_none());

    // Repeated prefix and full reads reuse the incremental steer offset cache
    // accurately, and explicit invalidation clears it cleanly.
    let prefix_end = image_offset;
    let cached_prefix = get_execution_output(
        &serde_json::json!({"runId":"steer-utf8-img-run","executionId":"exec-1","tail":true,"endOffset":prefix_end,"limit":16_384}),
        &service,
    )
    .unwrap();
    assert_eq!(cached_prefix["steerOffsets"][req_split], serde_json::json!(split_offset));
    assert!(cached_prefix["steerOffsets"].get(req_image).is_none());
    transcript::invalidate_steer_offset_cache(Some("steer-utf8-img-run"));
    let rehydrated = get_execution_output(
        &serde_json::json!({"runId":"steer-utf8-img-run","executionId":"exec-1","tail":true,"limit":16_384}),
        &service,
    )
    .unwrap();
    assert_eq!(rehydrated["steerOffsets"][req_split], serde_json::json!(split_offset));
    assert_eq!(rehydrated["steerOffsets"][req_image], serde_json::json!(image_offset));
}

#[test]
fn card_shell_projection_and_range_hydration_serve_settled_execution_and_planning_outputs() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = Runtime::open_lazy(temp.path()).unwrap();
    runtime.state.run_id = "cards-hydrate-run".into();
    let execution = Execution {
        id: "exec-cards".into(),
        node: "worker".into(),
        revision: 1,
        attempt: 1,
        session_id: "session".into(),
        worktree: "/unused".into(),
        before: String::new(),
        workspace_lineage: Vec::new(),
        after: None,
        input: None,
        result: None,
        status: "running".into(),
        output: String::new(),
        output_bytes: 0,
        pid: None,
        started_at: 1,
        completed_at: None,
        metrics: None,
    };
    runtime
        .state
        .nodes
        .insert("worker".into(), crate::model::NodeState::default());
    runtime
        .emit(EventKind::Started {
            execution,
            message_sequences: Some(vec![]),
            fresh_restart: true,
        })
        .unwrap();

    let huge_write = "W".repeat(4000);
    let huge_output = format!("{}\nnot ok 1 - sample failure\n", "O".repeat(130_000));
    let huge_thinking = "T".repeat(4000);
    let log = [
        serde_json::json!({ "type": "message_start", "message": { "role": "assistant" } }).to_string(),
        serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": "thinking_delta", "contentIndex": 0, "delta": "delta" } }).to_string(),
        serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "Final answer." } }).to_string(),
        serde_json::json!({
            "type": "tool_execution_start",
            "toolCallId": "small-call",
            "toolName": "read",
            "args": { "path": "Cargo.toml" }
        }).to_string(),
        serde_json::json!({
            "type": "tool_execution_end",
            "toolCallId": "small-call",
            "toolName": "read",
            "isError": false,
            "result": { "content": [{ "type": "text", "text": "small inline body" }] }
        }).to_string(),
        serde_json::json!({
            "type": "tool_execution_start",
            "toolCallId": "big-call",
            "toolName": "write",
            "args": { "path": "src/big.ts", "content": huge_write }
        }).to_string(),
        serde_json::json!({
            "type": "tool_execution_update",
            "toolCallId": "big-call",
            "toolName": "write",
            "partialResult": { "content": [{ "type": "text", "text": "progress spam" }] }
        }).to_string(),
        serde_json::json!({
            "type": "tool_execution_end",
            "toolCallId": "big-call",
            "toolName": "write",
            "isError": false,
            "result": { "content": [{ "type": "text", "text": huge_output }], "details": { "exitCode": 0 } }
        }).to_string(),
        serde_json::json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "thinking", "thinking": huge_thinking },
                    { "type": "text", "text": "Final answer." }
                ]
            }
        }).to_string(),
    ]
    .join("\n")
        + "\n";

    runtime
        .emit(EventKind::Output {
            execution_id: "exec-cards".into(),
            text: log.clone(),
        })
        .unwrap();
    runtime
        .emit(EventKind::Finished {
            execution_id: "exec-cards".into(),
            head: "".into(),
            output: "".into(),
            output_bytes: log.len(),
            metrics: None,
        })
        .unwrap();

    // Also seed a settled planning log with the exact same JSONL payload.
    let planning_id = Uuid::new_v4().to_string();
    let planning_dir = temp.path().join("planning").join(&planning_id);
    std::fs::create_dir_all(&planning_dir).unwrap();
    write_planning_summary(
        &planning_dir,
        &PlanningSummary {
            planning_id: planning_id.clone(),
            run_id: Some(Uuid::new_v4().to_string()),
            repository: Some(temp.path().to_string_lossy().into()),
            goal: Some("test".into()),
            status: Some("completed".into()),
            ..Default::default()
        },
    )
    .unwrap();
    std::fs::write(planning_dir.join("planner.jsonl"), &log).unwrap();

    let service = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: PathBuf::new(),
    });

    // 1. Settled execution CardShell projection strips streaming noise, keeps
    // small cards inline, and omits large payloads with raw ranges + header flags.
    let cards_page = get_execution_output(
        &serde_json::json!({"runId":"cards-hydrate-run","executionId":"exec-cards","tail":true,"limit":512 * 1024,"projection":"cards"}),
        &service,
    )
    .unwrap();
    assert_eq!(cards_page["projection"], serde_json::json!("cards"));
    assert!(cards_page.get("summaryOnly").is_none());
    let cards_content = cards_page["content"].as_str().unwrap();
    assert!(cards_content.contains("small inline body"));
    assert!(!cards_content.contains("progress spam"));
    assert!(!cards_content.contains("WWWW"));
    assert!(!cards_content.contains("OOOO"));
    assert!(!cards_content.contains("TTTT"));
    assert!(cards_content.contains(r#""grapherSubcommandWarning":true"#));
    assert!(cards_content.contains(r#""grapherThinkingChars":4000"#));

    // Extract the omitted tool result range and thinking range, then hydrate ONLY those lines.
    let parsed_lines: Vec<serde_json::Value> = cards_content
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let big_end = parsed_lines
        .iter()
        .find(|v| v["type"] == "tool_execution_end" && v["toolCallId"] == "big-call")
        .unwrap();
    let big_end_range = big_end["grapherRawRange"].as_array().unwrap().clone();
    let msg_end = parsed_lines
        .iter()
        .find(|v| v["type"] == "message_end" && v["message"]["role"] == "assistant")
        .unwrap();
    let thinking_range = msg_end["grapherRawRange"].as_array().unwrap().clone();

    let hydrated = get_execution_output(
        &serde_json::json!({
            "runId": "cards-hydrate-run",
            "executionId": "exec-cards",
            "ranges": [big_end_range, thinking_range]
        }),
        &service,
    )
    .unwrap();
    assert_eq!(hydrated["projection"], serde_json::json!("hydrated"));
    let hydrated_content = hydrated["content"].as_str().unwrap();
    assert!(hydrated_content.contains(&"T".repeat(4000)));
    let hydrated_end: serde_json::Value = hydrated_content
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .find(|v| v["type"] == "tool_execution_end")
        .unwrap();
    let hydrated_text = hydrated_end["result"]["content"][0]["text"].as_str().unwrap();
    assert!(hydrated_text.len() <= crate::compact_transcript::DISPLAY_TOOL_PREVIEW_BYTES);
    assert!(hydrated_text.ends_with("\n..."));

    // 2. Planning output supports the exact same CardShell + range hydration flow.
    let plan_cards = get_planning_output_with_options(
        planning_id.clone(),
        "planner".into(),
        0,
        true,
        None,
        Some(512 * 1024),
        Some(crate::compact_transcript::TranscriptProjection::CardShell),
        None,
        &service,
    )
    .unwrap();
    assert_eq!(plan_cards["projection"], serde_json::json!("cards"));
    assert!(plan_cards["content"].as_str().unwrap().contains("small inline body"));
    assert!(!plan_cards["content"].as_str().unwrap().contains("TTTT"));

    let plan_hydrate_body = serde_json::json!({ "ranges": [thinking_range] });
    let plan_hydrated = get_planning_output_with_options(
        planning_id,
        "planner".into(),
        0,
        false,
        None,
        None,
        None,
        Some(&plan_hydrate_body),
        &service,
    )
    .unwrap();
    assert_eq!(plan_hydrated["projection"], serde_json::json!("hydrated"));
    assert!(plan_hydrated["content"].as_str().unwrap().contains(&"T".repeat(4000)));
}
