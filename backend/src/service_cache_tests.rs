use super::*;

#[test]
fn deleting_and_clearing_runs_invalidates_cached_services() {
    let temp = tempfile::TempDir::new().unwrap();
    let runtime = Runtime::open_lazy(temp.path()).unwrap();
    let root = runtime.root.clone();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": temp.path(), "model":"test", "maxParallel":1
    }))
    .unwrap();
    for id in ["first", "second", "third"] {
        let mut state = Snapshot {
            run_id: id.into(),
            ..Default::default()
        };
        runtime
            .store
            .append(
                &mut state,
                EventKind::Created {
                    graph: Graph::default(),
                    config: config.clone(),
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();
    }
    let primary = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    let first = service_for_run(&primary, "first", false).unwrap();
    let same = service_for_run(&primary, "first", false).unwrap();
    assert!(Arc::ptr_eq(&first, &same));
    service_for_run(&primary, "second", false).unwrap();
    service_for_run(&primary, "third", false).unwrap();
    assert!(HOT_SERVICES.get().unwrap().lock().unwrap().len() <= 2);
    delete_run("first".into(), &first).unwrap();
    // External references deliberately keep the stale service alive. Lookup
    // still must consult the DB instead of resurrecting the deleted Run.
    assert!(service_for_run(&primary, "first", false).is_err());
    clear_history(&primary).unwrap();
    assert!(service_for_run(&primary, "second", false).is_err());
    assert!(HOT_SERVICES
        .get()
        .unwrap()
        .lock()
        .unwrap()
        .iter()
        .all(|(path, _, _)| *path != root));
}

fn workspace_deletion_fixture() -> (tempfile::TempDir, PathBuf, Arc<Service>, Vec<String>) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("project unicode");
    let other = temp.path().join("project unicode-other");
    fs::create_dir_all(source.join("child")).unwrap();
    fs::create_dir(&other).unwrap();
    fs::write(source.join("user.txt"), "published source").unwrap();
    let runtime = Runtime::open_lazy(&temp.path().join("data")).unwrap();
    let mut ids = Vec::new();
    for repository in [&source, &source, &other] {
        let id = Uuid::new_v4().to_string();
        let mut state = Snapshot {
            run_id: id.clone(),
            ..Default::default()
        };
        let config = serde_json::from_value(serde_json::json!({
            "repository": repository, "model": "test", "maxParallel": 1
        }))
        .unwrap();
        runtime
            .store
            .append(
                &mut state,
                EventKind::Created {
                    graph: Graph::default(),
                    config,
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();
        runtime
            .store
            .append(
                &mut state,
                EventKind::Output {
                    execution_id: format!("{id}-output"),
                    text: "retained transcript".into(),
                },
            )
            .unwrap();
        let target = crate::cleanup::Target::data("sessions", &id);
        runtime
            .store
            .remember_cleanup_targets(&id, &BTreeSet::from([target]))
            .unwrap();
        let session = runtime.root.join("sessions").join(&id);
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("history.jsonl"), "owned conversation").unwrap();
        ids.push(id);
    }
    let primary = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    (temp, source, primary, ids)
}

#[test]
fn workspace_size_warning_waits_for_background_runs_without_stopping_them() {
    let (_temp, source, primary, ids) = workspace_deletion_fixture();
    let active = service_for_run(&primary, &ids[1], false).unwrap();
    let unrelated = service_for_run(&primary, &ids[2], false).unwrap();
    unrelated.driving.store(true, Ordering::SeqCst);
    let repository = source.join("child").join("..").to_string_lossy().into_owned();
    let oversized = |path: &std::path::Path| crate::workspace::check_workspace_size(path, 0);

    // Use a tiny limit rather than allocating a 15GB fixture. A matching
    // background Planner/driver must not scan, report an error or mutate it.
    for planning in [false, true] {
        active.planning.store(planning, Ordering::SeqCst);
        active.driving.store(!planning, Ordering::SeqCst);
        let before = serde_json::to_value(&active.runtime.lock().unwrap().state).unwrap();
        let status = repository_status(&primary, repository.clone(), |_| {
            panic!("size scanning must wait for the active Run");
        }).unwrap();
        assert_eq!(status["valid"], true);
        assert_eq!(status["sizeLimitExceeded"], false);
        assert!(status["error"].is_null());
        assert_eq!(active.planning.load(Ordering::SeqCst), planning);
        assert_eq!(active.driving.load(Ordering::SeqCst), !planning);
        assert_eq!(serde_json::to_value(&active.runtime.lock().unwrap().state).unwrap(), before);
    }
    active.planning.store(false, Ordering::SeqCst);
    active.driving.store(false, Ordering::SeqCst);
    let phase = {
        let mut runtime = active.runtime.lock().unwrap();
        std::mem::replace(&mut runtime.state.phase, "publishing".into())
    };
    assert_eq!(repository_status(&primary, repository.clone(), |_| {
        panic!("publication must finish before size validation");
    }).unwrap()["valid"], true);
    assert!(detect_repository(Some(repository.clone()), &primary).unwrap().is_some(),
        "switching to an active workspace still refreshes its metadata");
    active.runtime.lock().unwrap().state.phase = phase;
    // An unrelated busy workspace must not suppress this workspace's warning.
    // Size is admission policy, not a binding failure that disables Continue
    // or message controls for already-admitted paused/failed Runs.
    let status = repository_status(&primary, repository.clone(), oversized).unwrap();
    assert_eq!(status["valid"], true);
    assert_eq!(status["sizeLimitExceeded"], true);
    assert_eq!(status["missing"], false);
    assert!(status["error"].as_str().unwrap().contains("15GB"));
    assert!(crate::workspace::validate_binding(std::path::Path::new(&repository)).is_ok());
    assert!(crate::workspace::detect_with_size_check(Some(std::path::Path::new(&repository)), oversized).is_err(),
        "a new binding must still enforce the size limit");

    // A Run starting during an in-flight scan also defers the warning.
    let status = repository_status(&primary, repository.clone(), |path| {
        active.driving.store(true, Ordering::SeqCst);
        oversized(path)
    }).unwrap();
    assert_eq!(status["valid"], true);
    assert_eq!(status["sizeLimitExceeded"], false);

    // Only size is advisory: a missing binding still reports an explicit error.
    fs::remove_dir_all(&source).unwrap();
    let status = repository_status(&primary, repository, |_| panic!("missing binding")).unwrap();
    assert_eq!(status["valid"], false);
    assert_eq!(status["missing"], true);
    assert_eq!(status["sizeLimitExceeded"], false);
    active.driving.store(false, Ordering::SeqCst);
    unrelated.driving.store(false, Ordering::SeqCst);
    let root = primary.runtime.lock().unwrap().root.clone();
    invalidate_service_cache(&root, None);
}

#[test]
fn workspace_deletion_uses_backend_ownership_and_invalidates_every_affected_service() {
    let (_temp, source, primary, ids) = workspace_deletion_fixture();
    let first = service_for_run(&primary, &ids[0], false).unwrap();
    let second = service_for_run(&primary, &ids[1], false).unwrap();
    let unrelated = service_for_run(&primary, &ids[2], false).unwrap();
    unrelated.driving.store(true, Ordering::SeqCst);
    let result = dispatch(
        &primary,
        "delete_workspace",
        serde_json::json!({
            "repository": source.join("child").join(".."),
        }),
    )
    .unwrap();
    let mut expected = ids[..2].to_vec();
    expected.sort();
    assert_eq!(result, serde_json::json!(expected));
    for (id, stale) in ids[..2].iter().zip([first, second]) {
        assert!(service_for_run(&primary, id, false).is_err());
        assert!(stale.runtime.lock().unwrap().state.run_id.is_empty());
        assert!(!primary
            .runtime
            .lock()
            .unwrap()
            .root
            .join("sessions")
            .join(id)
            .exists());
        assert_eq!(
            primary
                .runtime
                .lock()
                .unwrap()
                .store
                .log_bytes(id, &format!("{id}-output"))
                .unwrap(),
            0
        );
    }
    let runtime = primary.runtime.lock().unwrap();
    assert_eq!(runtime.store.runs().unwrap(), vec![ids[2].clone()]);
    assert!(runtime.root.join("sessions").join(&ids[2]).exists());
    assert_eq!(
        runtime
            .store
            .log_bytes(&ids[2], &format!("{}-output", ids[2]))
            .unwrap(),
        "retained transcript".len()
    );
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
    let root = runtime.root.clone();
    drop(runtime);
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "published source"
    );
    assert_eq!(
        dispatch(
            &primary,
            "delete_workspace",
            serde_json::json!({"repository": source})
        )
        .unwrap(),
        serde_json::json!([])
    );
    unrelated.driving.store(false, Ordering::SeqCst);
    invalidate_service_cache(&root, None);
}

#[test]
fn workspace_deletion_rejects_active_runs_without_partially_removing_other_conversations() {
    let (_temp, source, primary, ids) = workspace_deletion_fixture();
    let active = service_for_run(&primary, &ids[1], false).unwrap();
    active.planning.store(true, Ordering::SeqCst);
    assert!(
        delete_workspace(source.to_string_lossy().into_owned(), &primary)
            .unwrap_err()
            .contains("active")
    );
    {
        let runtime = primary.runtime.lock().unwrap();
        for id in &ids {
            assert!(runtime.store.contains_run(id).unwrap());
            assert!(!runtime.store.run_was_deleted(id).unwrap());
            assert!(runtime.root.join("sessions").join(id).is_dir());
        }
        assert!(runtime.store.pending_cleanups().unwrap().is_empty());
    }
    for repository in ["", "  ", "relative-project"] {
        assert!(delete_workspace(repository.into(), &primary).is_err());
    }
    active.planning.store(false, Ordering::SeqCst);
    let root = primary.runtime.lock().unwrap().root.clone();
    invalidate_service_cache(&root, None);
}

#[test]
fn startup_recovers_historical_deleted_owners_without_cleanup_tasks() {
    let (_temp, source, primary, ids) = workspace_deletion_fixture();
    let merger_id = Uuid::new_v4().to_string();
    let root = {
        let runtime = primary.runtime.lock().unwrap();
        let merger = runtime.root.join("mergers").join(&merger_id);
        fs::create_dir_all(&merger).unwrap();
        fs::write(merger.join("output.jsonl"), "orphaned merger history").unwrap();
        runtime
            .store
            .remember_cleanup_targets(
                &ids[0],
                &BTreeSet::from([crate::cleanup::Target::data("mergers", &merger_id)]),
            )
            .unwrap();
        // Reproduce an older deletion that removed SQL history, but left
        // physical ownership behind without a durable filesystem task.
        for id in &ids[..2] {
            runtime.store.delete_run(id).unwrap();
        }
        assert!(runtime.store.pending_cleanups().unwrap().is_empty());
        let owners = runtime.store.orphaned_cleanup_owners().unwrap();
        assert!(ids[..2].iter().all(|id| owners.contains(id)));
        assert!(merger.is_dir());
        runtime.root.clone()
    };
    recover_cleanup_tasks(&primary).unwrap();
    let runtime = primary.runtime.lock().unwrap();
    for id in &ids[..2] {
        assert!(runtime.store.run_was_deleted(id).unwrap());
        assert!(runtime.store.owned_cleanup_targets(id).unwrap().is_empty());
        assert!(!root.join("sessions").join(id).exists());
    }
    assert!(!root.join("mergers").join(merger_id).exists());
    assert!(runtime.store.orphaned_cleanup_owners().unwrap().is_empty());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
    assert!(runtime.store.contains_run(&ids[2]).unwrap());
    assert!(root.join("sessions").join(&ids[2]).exists());
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "published source"
    );
}
