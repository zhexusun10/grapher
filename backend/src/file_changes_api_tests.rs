use super::*;

#[test]
fn file_changes_api_unions_scoped_paths_before_capping_and_preserves_empty_scope() {
    let temp = tempfile::TempDir::new().unwrap();
    let source = temp.path().join("source");
    fs::create_dir_all(&source).unwrap();
    let mut runtime = Runtime::open(temp.path()).unwrap();
    let run = Uuid::new_v4().to_string();
    runtime.state.run_id = run.clone();
    runtime.emit(EventKind::Created {
        graph: Graph {
            original_goal: "file change aggregation".into(),
            nodes: vec![Node { name: "task".into(), task: "test".into() }],
            edges: vec![],
        },
        config: serde_json::from_value(serde_json::json!({ "repository": source, "model": "test", "maxParallel": 1 })).unwrap(),
        planning_id: None, planning: None,
    }).unwrap();
    for (id, start, end, merger) in [("first", 0, 90, false), ("second", 30, 120, true), ("other", 1000, 1001, false)] {
        let execution = Execution {
            id: id.into(), node: if merger { "merger" } else { "task" }.into(),
            revision: 1, attempt: 1, session_id: id.into(), worktree: source.to_string_lossy().into(),
            before: String::new(), workspace_lineage: vec![], after: None, input: None, result: None,
            status: "running".into(), output: String::new(), output_bytes: 0, pid: None,
            started_at: now(), completed_at: None, metrics: None,
        };
        runtime.emit(if merger {
            EventKind::MergerStarted { execution }
        } else {
            EventKind::Started { execution, message_sequences: None, fresh_restart: false }
        }).unwrap();
        let mut text = String::new();
        for index in start..end {
            text.push_str(&serde_json::json!({
                "type":"tool_execution_start", "toolCallId":format!("{id}-{index}"), "toolName":"write",
                "args":{"path":format!("src/file-{index:04}.ts"),"content":"line\n"},
            }).to_string());
            text.push('\n');
            text.push_str(&serde_json::json!({
                "type":"tool_execution_end", "toolCallId":format!("{id}-{index}"), "toolName":"write", "isError":false,
            }).to_string());
            text.push('\n');
        }
        runtime.emit(EventKind::Output { execution_id: id.into(), text }).unwrap();
        runtime.emit(if merger {
            EventKind::MergerFinished { execution_id: id.into(), head: String::new(), output_bytes: 0, metrics: None }
        } else {
            EventKind::Finished { execution_id: id.into(), head: String::new(), output: String::new(), output_bytes: 0, metrics: None }
        }).unwrap();
    }
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime), driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()), planning: AtomicBool::new(false), extension: PathBuf::new(),
    });
    let query = |fields: serde_json::Value| {
        let mut body = fields;
        body["runId"] = serde_json::json!(run);
        get_file_changes(&body, &service).unwrap()
    };
    let scoped = query(serde_json::json!({ "executionIds": ["first", "second", "first"] }));
    assert_eq!(scoped["summary"]["totalFiles"], 120, "overlapping attempts count each path once");
    assert_eq!(scoped["summary"]["files"].as_array().unwrap().len(), crate::file_changes::MAX_DISPLAYED_FILE_CHANGES);
    assert!(scoped["summary"]["files"].as_array().unwrap().iter()
        .all(|file| file["path"] != "src/file-1000.ts"));
    assert_eq!(query(serde_json::json!({ "executionId": "first" }))["summary"]["totalFiles"], 90);
    assert_eq!(query(serde_json::json!({}))["summary"]["totalFiles"], 121);
    for ids in [serde_json::json!([]), serde_json::json!(["unknown"])] {
        let empty = query(serde_json::json!({ "executionIds": ids }));
        assert_eq!(empty["summary"]["totalFiles"], 0);
        assert!(empty["summary"]["files"].as_array().unwrap().is_empty());
    }
    assert!(get_file_changes(&serde_json::json!({ "executionIds": "invalid" }), &service).is_err());
    assert!(get_file_changes(&serde_json::json!({ "executionId": "first", "executionIds": [] }), &service).is_err());
}

/// An empty runId is the active Run's aggregate, not a Run lookup failure.
#[test]
fn empty_run_id_file_changes_reads_the_active_run() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir_all(&source).unwrap();
    let active = Uuid::new_v4().to_string();
    let mut runtime = Runtime::open(temp.path()).unwrap();
    runtime.state.run_id = active.clone();
    runtime.emit(EventKind::Created {
        graph: Graph {
            original_goal: "active".into(),
            nodes: vec![Node { name: "task".into(), task: "t".into() }],
            edges: vec![],
        },
        config: serde_json::from_value(serde_json::json!({
            "repository": source, "model": "test", "maxParallel": 1
        })).unwrap(),
        planning_id: None, planning: None,
    }).unwrap();
    runtime.emit(EventKind::Started {
        execution: Execution {
            id: "active-exec".into(), node: "task".into(), revision: 1, attempt: 1,
            session_id: "s".into(), worktree: source.to_string_lossy().into(),
            before: String::new(), workspace_lineage: vec![], after: None, input: None,
            result: None, status: "running".into(), output: String::new(), output_bytes: 0,
            pid: None, started_at: now(), completed_at: None, metrics: None,
        },
        message_sequences: None, fresh_restart: false,
    }).unwrap();
    let text = serde_json::json!({
        "type":"tool_execution_start", "toolCallId":"w", "toolName":"write",
        "args":{"path":"active.ts","content":"x"}
    }).to_string()
        + "\n"
        + &serde_json::json!({
            "type":"tool_execution_end", "toolCallId":"w", "toolName":"write", "isError":false
        }).to_string()
        + "\n";
    runtime.emit(EventKind::Output { execution_id: "active-exec".into(), text }).unwrap();
    let primary = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: PathBuf::new(),
    });
    let scoped = api_service(&primary, "get_file_changes", &serde_json::json!({ "runId": "" })).unwrap();
    let value = dispatch(&scoped, "get_file_changes", serde_json::json!({ "runId": "" })).unwrap();
    assert_eq!(value["runId"], active);
    assert_eq!(value["summary"]["totalFiles"], 1);
}

/// A viewed conversation may be a historical Run while another Run holds the
/// primary writer. Reading the historical summary must route to its own Run and
/// return that Run's projection rather than the active/empty one.
#[test]
fn historical_run_routes_to_its_own_projection_while_the_active_run_is_busy() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir_all(&source).unwrap();
    let primary = Arc::new(Service {
        runtime: Mutex::new(Runtime::open_lazy(temp.path()).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: PathBuf::new(),
    });
    // Build the historical Run before locking the active one: service lookup
    // serializes on the primary and must not wait for a busy Run.
    let historical_id = Uuid::new_v4().to_string();
    let historical = service_for_run(&primary, &historical_id, true).unwrap();
    {
        let mut runtime = historical.runtime.lock().unwrap();
        runtime.emit(EventKind::Created {
            graph: Graph {
                original_goal: "historical".into(),
                nodes: vec![Node { name: "task".into(), task: "t".into() }],
                edges: vec![],
            },
            config: serde_json::from_value(serde_json::json!({
                "repository": source, "model": "test", "maxParallel": 1
            }))
            .unwrap(),
            planning_id: None, planning: None,
        }).unwrap();
        runtime.emit(EventKind::Started {
            execution: Execution {
                id: "hist-exec".into(), node: "task".into(), revision: 1, attempt: 1,
                session_id: "s".into(), worktree: source.to_string_lossy().into(),
                before: String::new(), workspace_lineage: vec![], after: None, input: None,
                result: None, status: "running".into(), output: String::new(), output_bytes: 0,
                pid: None, started_at: now(), completed_at: None, metrics: None,
            },
            message_sequences: None, fresh_restart: false,
        }).unwrap();
        let text = serde_json::json!({
            "type":"tool_execution_start", "toolCallId":"w", "toolName":"write",
            "args":{"path":"hist.ts","content":"x"}
        }).to_string()
            + "\n"
            + &serde_json::json!({
                "type":"tool_execution_end", "toolCallId":"w", "toolName":"write", "isError":false
            }).to_string()
            + "\n";
        runtime.emit(EventKind::Output { execution_id: "hist-exec".into(), text }).unwrap();
        runtime.emit(EventKind::Finished {
            execution_id: "hist-exec".into(), head: String::new(),
            output: String::new(), output_bytes: 0, metrics: None,
        }).unwrap();
    }
    // An unrelated active Run holds its writer lock for the whole read.
    let active = service_for_run(&primary, &Uuid::new_v4().to_string(), true).unwrap();
    let active_guard = active.runtime.lock().unwrap();
    let scoped = api_service(&primary, "get_file_changes", &serde_json::json!({ "runId": historical_id })).unwrap();
    let value = dispatch(&scoped, "get_file_changes", serde_json::json!({ "runId": historical_id })).unwrap();
    drop(active_guard);
    invalidate_service_cache(temp.path(), None);
    assert_eq!(value["runId"], historical_id);
    assert_eq!(value["summary"]["totalFiles"], 1, "historical read returned the active or empty Run");
}
