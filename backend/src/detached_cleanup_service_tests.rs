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
    runtime.set_route("serial").unwrap();
    runtime
        .store
        .remember_cleanup_targets(
            &runtime.state.run_id,
            &std::collections::BTreeSet::from([crate::cleanup::Target::Workspace {
                parent: temp.path().canonicalize().unwrap(),
                bucket: ".grapher-worktrees".into(),
                owner: runtime.state.run_id.clone(),
                checkout: None,
            }]),
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

#[test]
fn automatic_lazy_unbound_run_retires_workspaces_on_completion() {
    let (_temp, source, workspace, service) = fixture(false);
    {
        let mut runtime = service.runtime.lock().unwrap();
        runtime.store.finish_cleanup(&runtime.state.run_id).unwrap();
        let environment: crate::environment::EnvironmentConfig = serde_json::from_value(serde_json::json!({
            "mode": "native-workspace",
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "scopes": [".venv", ".environments", ".agent-home"],
            "layout": "fixed",
            "launch": {
                "entry": source.join("fixture-program"),
                "path": [],
                "shell": source.join("fixture-shell")
            },
            "baseline": [],
            "discovery": true,
            "bestEffort": true
        }))
        .unwrap();
        runtime
            .emit(EventKind::EnvironmentPolicyResolved {
                environment: Some(environment),
                reason: "automatic-lazy unbound".into(),
            })
            .unwrap();
        runtime
            .emit(EventKind::PublicationCompleted {
                head: String::new(),
            })
            .unwrap();
        runtime.defer_cleanup_worktrees().unwrap();
        assert!(!workspace.exists(), "unbound automatic-lazy workspace should retire on completion");
        assert_eq!(runtime.store.detached_workspaces().unwrap().len(), 1);
    }
    service.driving.store(false, Ordering::SeqCst);
    retry_cleanup_tasks(&service).unwrap();
    let runtime = service.runtime.lock().unwrap();
    assert!(runtime.store.detached_workspaces().unwrap().is_empty());
    assert!(source.join("user.txt").is_file());
}

#[test]
fn automatic_lazy_bound_environment_retains_workspaces_until_deleted() {
    let (_temp, source, workspace, service) = fixture(false);
    {
        let mut runtime = service.runtime.lock().unwrap();
        runtime.store.finish_cleanup(&runtime.state.run_id).unwrap();
        let fixture_probe = source.join("fixture-shell");
        fs::write(&fixture_probe, "#!/bin/sh\n").unwrap();
        let mut environment: crate::environment::EnvironmentConfig = serde_json::from_value(serde_json::json!({
            "mode": "native-workspace",
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "scopes": [".venv", ".environments", ".agent-home"],
            "layout": "fixed",
            "launch": {
                "entry": &fixture_probe,
                "path": [source.to_string_lossy()],
                "shell": &fixture_probe
            },
            "baseline": [&fixture_probe],
            "discovery": true,
            "bestEffort": true
        }))
        .unwrap();
        let store = crate::environment::Environments::new(
            &runtime.root,
            &runtime.state.run_id,
            &environment,
        )
        .unwrap();
        let mut bound_launch = environment.launch.clone();
        let runtime_evidence = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "roots": { "workspace": workspace.to_string_lossy() },
            "files": [{
                "location": "root",
                "root": "workspace",
                "path": ".venv/pyvenv.cfg",
                "blob": "b".repeat(40)
            }]
        }))
        .unwrap();
        bound_launch.environment = Some(crate::environment_discovery::Binding {
            kind: "venv".into(),
            prefix: ".venv".into(),
            root: Some("workspace".into()),
            abi: "a".repeat(40),
            runtime_evidence: Some(runtime_evidence),
        });
        let launch_ref = store.launch(&bound_launch).unwrap();
        environment.launch.environment = None;
        let composite = crate::environment::CompositeResult {
            domain: crate::environment::Domain {
                platform: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
                baseline: "base".into(),
                policy: "policy".into(),
                contract: "native-workspace-v4".into(),
            },
            code_ref: "deadbeef".into(),
            environment_ref: "envref".into(),
            launch_ref,
            resource_refs: vec![],
            layout: Some(workspace.to_string_lossy().into_owned()),
            generation: Uuid::new_v4().to_string(),
            selected_from: vec![],
            inheritance: None,
        };
        let descriptor = crate::environment::ResultDescriptor {
            schema: 2,
            run_id: runtime.state.run_id.clone(),
            result: composite.clone(),
            config: environment.clone(),
            workspace: workspace.to_string_lossy().into_owned(),
            entries: vec![crate::environment::ResultEntry {
                name: "default".into(),
                result: composite,
                workspace: workspace.to_string_lossy().into_owned(),
            }],
            default_entry: Some("default".into()),
        };
        runtime
            .emit(EventKind::EnvironmentPolicyResolved {
                environment: Some(environment),
                reason: "automatic-lazy bound".into(),
            })
            .unwrap();
        runtime
            .emit(EventKind::ResultPublished { descriptor })
            .unwrap();
        runtime
            .emit(EventKind::PublicationCompleted {
                head: "deadbeef".into(),
            })
            .unwrap();
        runtime.defer_cleanup_worktrees().unwrap();
        assert!(
            workspace.join("old.txt").is_file(),
            "bound automatic-lazy workspace must be retained"
        );
        assert!(runtime.store.detached_workspaces().unwrap().is_empty());
        let run_id = runtime.state.run_id.clone();
        runtime.delete_run(&run_id).unwrap();
    }
    assert!(!workspace.exists());
    assert!(source.join("user.txt").is_file());
}
