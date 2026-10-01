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
