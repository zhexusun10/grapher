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
