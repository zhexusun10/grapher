use super::*;

#[test]
fn deleting_and_clearing_runs_invalidates_cached_services() {
    let temp = tempfile::TempDir::new().unwrap();
    let runtime = Runtime::open_lazy(temp.path()).unwrap();
    let root = runtime.root.clone();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": temp.path(), "model":"test", "maxParallel":1
    })).unwrap();
    for id in ["first", "second", "third"] {
        let mut state = Snapshot { run_id: id.into(), ..Default::default() };
        runtime.store.append(&mut state, EventKind::Created {
            graph: Graph::default(), config: config.clone(), planning_id: None, planning: None,
        }).unwrap();
    }
    let primary = Arc::new(Service {
        runtime: Mutex::new(runtime), driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()), planning: AtomicBool::new(false),
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
    assert!(HOT_SERVICES.get().unwrap().lock().unwrap().iter().all(|(path, _, _)| *path != root));
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
        let mut state = Snapshot { run_id: id.clone(), ..Default::default() };
        let config = serde_json::from_value(serde_json::json!({
            "repository": repository, "model": "test", "maxParallel": 1
        })).unwrap();
        runtime.store.append(&mut state, EventKind::Created {
            graph: Graph::default(), config, planning_id: None, planning: None,
        }).unwrap();
        runtime.store.append(&mut state, EventKind::Output {
            execution_id: format!("{id}-output"), text: "retained transcript".into(),
        }).unwrap();
        let target = crate::cleanup::Target::data("sessions", &id);
        runtime.store.remember_cleanup_targets(&id, &BTreeSet::from([target])).unwrap();
        let session = runtime.root.join("sessions").join(&id);
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("history.jsonl"), "owned conversation").unwrap();
        ids.push(id);
    }
    let primary = Arc::new(Service {
        runtime: Mutex::new(runtime), driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()), planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    (temp, source, primary, ids)
}

#[test]
fn workspace_deletion_uses_backend_ownership_and_invalidates_every_affected_service() {
    let (_temp, source, primary, ids) = workspace_deletion_fixture();
    let first = service_for_run(&primary, &ids[0], false).unwrap();
    let second = service_for_run(&primary, &ids[1], false).unwrap();
    let unrelated = service_for_run(&primary, &ids[2], false).unwrap();
    unrelated.driving.store(true, Ordering::SeqCst);
    let result = dispatch(&primary, "delete_workspace", serde_json::json!({
        "repository": source.join("child").join(".."),
    })).unwrap();
    let mut expected = ids[..2].to_vec(); expected.sort();
    assert_eq!(result, serde_json::json!(expected));
    for (id, stale) in ids[..2].iter().zip([first, second]) {
        assert!(service_for_run(&primary, id, false).is_err());
        assert!(stale.runtime.lock().unwrap().state.run_id.is_empty());
        assert!(!primary.runtime.lock().unwrap().root.join("sessions").join(id).exists());
        assert_eq!(primary.runtime.lock().unwrap().store.log_bytes(id, &format!("{id}-output")).unwrap(), 0);
    }
    let runtime = primary.runtime.lock().unwrap();
    assert_eq!(runtime.store.runs().unwrap(), vec![ids[2].clone()]);
    assert!(runtime.root.join("sessions").join(&ids[2]).exists());
    assert_eq!(runtime.store.log_bytes(&ids[2], &format!("{}-output", ids[2])).unwrap(), "retained transcript".len());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
    let root = runtime.root.clone(); drop(runtime);
    assert_eq!(fs::read_to_string(source.join("user.txt")).unwrap(), "published source");
    assert_eq!(dispatch(&primary, "delete_workspace", serde_json::json!({"repository": source})).unwrap(), serde_json::json!([]));
    unrelated.driving.store(false, Ordering::SeqCst);
    invalidate_service_cache(&root, None);
}

#[test]
fn workspace_deletion_rejects_active_runs_without_partially_removing_other_conversations() {
    let (_temp, source, primary, ids) = workspace_deletion_fixture();
    let active = service_for_run(&primary, &ids[1], false).unwrap();
    active.planning.store(true, Ordering::SeqCst);
    assert!(delete_workspace(source.to_string_lossy().into_owned(), &primary).unwrap_err().contains("active"));
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
