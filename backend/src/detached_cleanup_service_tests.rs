use super::*;

fn fixture(retire: bool) -> (tempfile::TempDir, PathBuf, PathBuf, Arc<Service>) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("user.txt"), "keep source").unwrap();
    let mut runtime = Runtime::open_lazy(&temp.path().join("data")).unwrap();
    let config = serde_json::from_value(serde_json::json!({
        "repository": source, "model":"test", "maxParallel":1,
    }))
    .unwrap();
    runtime
        .create(
            Graph {
                original_goal: "cleanup fixture".into(),
                nodes: vec![crate::model::Node {
                    id: "task".into(),
                    task: "task".into(),
                }],
                edges: vec![],
            },
            config,
        )
        .unwrap();
    let workspace = temp
        .path()
        .join(".grapher-worktrees")
        .join(&runtime.state.run_id);
    fs::create_dir_all(&workspace).unwrap();
    fs::write(workspace.join("old.txt"), "retired execution").unwrap();
    if retire {
        runtime.defer_cleanup_worktrees().unwrap();
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("new.txt"), "new execution").unwrap();
    } else {
        let manifest =
            crate::cleanup::manifest(&runtime.root, &runtime.store, &runtime.state, false).unwrap();
        runtime
            .store
            .enqueue_cleanup(&runtime.state.run_id, &manifest)
            .unwrap();
    }
    let root = runtime.root.clone();
    let run_id = runtime.state.run_id.clone();
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(true),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    remember_run_service(&root, &run_id, service.clone()).unwrap();
    (temp, source, workspace, service)
}

#[test]
fn maintenance_drains_detached_receipts_even_while_the_run_drives_new_work() {
    let (_temp, source, workspace, service) = fixture(true);
    assert_eq!(
        service
            .runtime
            .lock()
            .unwrap()
            .store
            .detached_workspaces()
            .unwrap()
            .len(),
        1
    );
    retry_cleanup_tasks(&service).unwrap();
    assert!(service
        .runtime
        .lock()
        .unwrap()
        .store
        .detached_workspaces()
        .unwrap()
        .is_empty());
    assert_eq!(
        fs::read_to_string(workspace.join("new.txt")).unwrap(),
        "new execution"
    );
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "keep source"
    );
}

#[test]
fn startup_cleanup_keeps_retained_managed_workspaces() {
    let (_temp, source, workspace, service) = fixture(false);
    {
        let mut runtime = service.runtime.lock().unwrap();
        runtime.store.finish_cleanup(&runtime.state.run_id).unwrap();
        let environment = serde_json::from_value(serde_json::json!({
            "mode": "native-workspace", "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH, "scopes": [".env"], "layout": "fixed",
            "launch": {"entry": source.join("fixture-program"), "path": [], "shell": source.join("fixture-shell")},
            "baseline": []
        })).unwrap();
        // Persist policy only: this fixture never launches a native environment.
        runtime
            .emit(EventKind::EnvironmentPolicyResolved {
                environment: Some(environment),
                reason: "retained fixture layout".into(),
            })
            .unwrap();
        runtime
            .emit(EventKind::PublicationCompleted {
                head: String::new(),
            })
            .unwrap();
        runtime.defer_cleanup_worktrees().unwrap();
        assert!(runtime
            .store
            .cleanup_task(&runtime.state.run_id)
            .unwrap()
            .is_none());
        assert!(workspace.join("old.txt").exists());
    }
    service.driving.store(false, Ordering::SeqCst);
    recover_cleanup_tasks(&service).unwrap();
    assert!(
        workspace.join("old.txt").exists(),
        "startup bypassed managed workspace retention"
    );
    {
        let mut runtime = service.runtime.lock().unwrap();
        assert!(runtime.store.detached_workspaces().unwrap().is_empty());
        assert!(runtime
            .store
            .cleanup_task(&runtime.state.run_id)
            .unwrap()
            .is_none());
        assert!(!runtime
            .store
            .owned_cleanup_targets(&runtime.state.run_id)
            .unwrap()
            .is_empty());
        // Retention cancels only opportunistic cleanup, not an explicit delete.
        let run_id = runtime.state.run_id.clone();
        runtime.delete_run(&run_id).unwrap();
    }
    assert!(!workspace.exists());
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "keep source"
    );
}

#[test]
fn maintenance_keeps_unretired_workspace_tasks_while_the_run_is_driving() {
    let (_temp, source, workspace, service) = fixture(false);
    retry_cleanup_tasks(&service).unwrap();
    let runtime = service.runtime.lock().unwrap();
    assert!(runtime
        .store
        .cleanup_task(&runtime.state.run_id)
        .unwrap()
        .is_some());
    assert!(runtime.store.detached_workspaces().unwrap().is_empty());
    assert!(workspace.join("old.txt").is_file());
    assert!(source.join("user.txt").is_file());
}
