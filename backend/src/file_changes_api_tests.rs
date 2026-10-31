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

fn open_file_state(repository: &std::path::Path) -> Snapshot {
    let mut state = Snapshot::default();
    state.config = Some(
        serde_json::from_value(serde_json::json!({
            "repository": repository.to_string_lossy(), "model": "test", "maxParallel": 1
        }))
        .unwrap(),
    );
    state
}

fn open_file_execution(id: &str, worktree: &std::path::Path, started_at: u64) -> Execution {
    Execution {
        id: id.into(), node: "task".into(), revision: 1, attempt: 1,
        session_id: id.into(), worktree: worktree.to_string_lossy().into(),
        before: String::new(), workspace_lineage: vec![], after: None, input: None,
        result: None, status: "completed".into(), output: String::new(), output_bytes: 0,
        pid: None, started_at, completed_at: Some(started_at + 1), metrics: None,
    }
}

fn write_open_file(root: &std::path::Path, relative: &str, text: &str) -> PathBuf {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, text).unwrap();
    path
}

fn assert_open_target(state: &Snapshot, execution_ids: Option<&[String]>, nodes: &[String], expected: &std::path::Path) {
    let context = open_file_context(state);
    let roots = open_file_roots(&context, execution_ids, nodes).unwrap();
    assert_eq!(
        resolve_open_file_target(&roots, "src/lib.rs").unwrap(),
        expected.canonicalize().unwrap()
    );
}

#[test]
fn file_open_resolution_uses_newest_attempt_then_repository_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("repository");
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    let repo_file = write_open_file(&repository, "src/lib.rs", "repository");
    let first_file = write_open_file(&first, "src/lib.rs", "first");
    let second_file = write_open_file(&second, "src/lib.rs", "second");

    let mut state = open_file_state(&repository);
    state.executions = vec![
        open_file_execution("first", &first, 1),
        open_file_execution("second", &second, 2),
    ];
    assert_open_target(&state, Some(&["first".into(), "second".into()]), &[], &second_file);
    assert_open_target(&state, None, &[], &second_file);

    // A cleaned newest attempt falls through to the next retained workspace.
    fs::remove_dir_all(&second).unwrap();
    assert_open_target(&state, Some(&["first".into(), "second".into()]), &[], &first_file);
    // A node view whose workspaces no longer exist reads the published/source
    // file instead of failing.
    fs::remove_dir_all(&first).unwrap();
    assert_open_target(&state, Some(&["first".into(), "second".into()]), &[], &repo_file);

    let context = open_file_context(&state);
    assert!(open_file_roots(&context, Some(&["unknown".into()]), &[]).is_err());
    assert!(resolve_open_file_target(&[repository], "missing.rs").is_err());
}

#[test]
fn file_open_resolution_prefers_the_repository_after_publication() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("repository");
    let workspace = temp.path().join("workspace");
    let repo_file = write_open_file(&repository, "src/lib.rs", "published");
    write_open_file(&workspace, "src/lib.rs", "workspace");

    let mut state = open_file_state(&repository);
    state.executions = vec![open_file_execution("execution", &workspace, 1)];
    state.publication = Some(Publication {
        repository: repository.to_string_lossy().into(),
        heads: vec![], status: "completed".into(), head: None, error: None,
        started_at: 1, completed_at: Some(2),
    });
    assert_open_target(&state, None, &[], &repo_file);

    // An explicit node view still prefers its own execution while it exists.
    assert_open_target(&state, Some(&["execution".into()]), &[], &workspace.join("src/lib.rs"));
}

#[test]
fn file_open_resolution_prefers_a_planner_only_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("repository");
    let planning = temp.path().join("planning");
    let workspace = temp.path().join("workspace");
    write_open_file(&repository, "src/lib.rs", "base");
    let planning_file = write_open_file(&planning, "src/lib.rs", "planned");
    let workspace_file = write_open_file(&workspace, "src/lib.rs", "base copy");

    let mut state = open_file_state(&repository);
    state.executions = vec![open_file_execution("execution", &workspace, 1)];
    state.planning = Some(PlanningSummary {
        planning_id: "planning".into(),
        worktree: Some(planning.to_string_lossy().into()),
        ..Default::default()
    });
    assert_open_target(&state, None, &["planner".into()], &planning_file);
    assert_open_target(&state, None, &["worker".into()], &workspace_file);
    assert_open_target(&state, None, &["planner".into(), "worker".into()], &workspace_file);
}

#[test]
fn file_open_resolution_rejects_traversal_absolute_paths_and_missing_files() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("repository");
    write_open_file(&repository, "src/lib.rs", "content");
    let roots = vec![repository.clone()];

    for unsafe_path in ["../outside.rs", "/etc/passwd", "src/../lib.rs", ""] {
        assert!(
            resolve_open_file_target(&roots, unsafe_path).is_err(),
            "open target must reject {unsafe_path:?}"
        );
    }
    assert!(resolve_open_file_target(&roots, "src/missing.rs").is_err());
    assert_eq!(
        resolve_open_file_target(&roots, "src/lib.rs").unwrap(),
        repository.join("src/lib.rs").canonicalize().unwrap()
    );
}

#[test]
fn open_workspace_file_rejects_missing_files_and_unknown_executions_without_launching() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir_all(&source).unwrap();
    let mut runtime = Runtime::open(temp.path()).unwrap();
    let run = Uuid::new_v4().to_string();
    runtime.state.run_id = run.clone();
    runtime.emit(EventKind::Created {
        graph: Graph {
            original_goal: "open file".into(),
            nodes: vec![Node { name: "task".into(), task: "test".into() }],
            edges: vec![],
        },
        config: serde_json::from_value(serde_json::json!({
            "repository": source, "model": "test", "maxParallel": 1
        }))
        .unwrap(),
        planning_id: None, planning: None,
    }).unwrap();
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: PathBuf::new(),
    });

    let missing = open_workspace_file(
        &serde_json::json!({ "runId": run, "path": "missing.rs" }),
        &service,
    )
    .unwrap_err();
    assert!(missing.contains("文件已不在"));
    let unknown = open_workspace_file(
        &serde_json::json!({ "runId": run, "path": "missing.rs", "executionIds": ["unknown"] }),
        &service,
    )
    .unwrap_err();
    assert!(unknown.contains("找不到所选执行"));
    assert!(open_workspace_file(
        &serde_json::json!({ "runId": run, "path": "missing.rs", "executionId": "a", "executionIds": ["a"] }),
        &service,
    )
    .is_err());
}
