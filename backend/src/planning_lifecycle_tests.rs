use super::*;

fn service(root: &std::path::Path) -> Arc<Service> {
    Arc::new(Service {
        runtime: Mutex::new(Runtime::open_lazy(root).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: root.join("unused.ts"),
    })
}

fn config(repository: &std::path::Path) -> Config {
    serde_json::from_value(serde_json::json!({
        "repository": repository, "model": "mock/model", "maxParallel": 1
    })).unwrap()
}

fn attempt(root: &std::path::Path, run_id: &str, legacy: bool, revision: bool) -> (PathBuf, PlanningSummary) {
    let id = Uuid::new_v4().to_string();
    let directory = root.join("planning").join(&id);
    fs::create_dir_all(&directory).unwrap();
    let mut request = serde_json::json!({
        "goal": "Original goal", "config": config(root), "mode": "graph",
        "revisionRunId": if revision { Some(run_id) } else { None },
    });
    if !legacy { request["runId"] = serde_json::json!(run_id); }
    fs::write(directory.join("request.json"), request.to_string()).unwrap();
    fs::write(directory.join("planner-workspace"),
        root.join(".grapher-workspaces").join(run_id).join(&id).to_string_lossy().as_bytes()).unwrap();
    fs::write(directory.join("route.json"), r#"{"planType":"graph"}"#).unwrap();
    let summary = PlanningSummary {
        planning_id: id, status: Some("running".into()),
        created_at: Some(1000), repository: Some(root.to_string_lossy().into()),
        ..Default::default()
    };
    write_planning_summary(&directory, &summary).unwrap();
    fs::write(directory.join("planner.jsonl"), concat!(
        "{\"type\":\"grapher_process_started\",\"timestamp\":1000}\n",
        "{\"type\":\"tool_execution_start\",\"grapherReceivedAt\":2000}\n",
        "{\"type\":\"message_end\",\"grapherReceivedAt\":3000,\"message\":{\"role\":\"assistant\",\"usage\":{\"totalTokens\":100}}}\n",
        "{\"type\":\"message_update\",\"grapherReceivedAt\":6000}\n",
    )).unwrap();
    (directory, summary)
}

#[test]
fn restart_recovers_durable_and_legacy_planning_with_the_original_run_id() {
    for legacy in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let primary = service(temp.path());
        let id = Uuid::new_v4().to_string();
        let (_, running) = attempt(temp.path(), &id, legacy, false);
        if !legacy {
            let child = service_for_run(&primary, &id, true).unwrap();
            child.runtime.lock().unwrap().emit(EventKind::PlanningStarted {
                goal: "Original goal".into(), config: config(temp.path()),
                planning: running.clone(), plan_type: Some("graph".into()),
            }).unwrap();
            invalidate_service_cache(temp.path(), Some(&id));
        }
        recover_plannings(&primary).unwrap();
        let restored = service_for_run(&primary, &id, false).unwrap();
        let state = snapshot(&restored).unwrap();
        assert_eq!(state.run_id, id);
        assert_eq!(state.phase, "planning_failed");
        assert_eq!(state.plan_type.as_deref(), Some("graph"));
        assert_eq!(state.graph.original_goal, "Original goal");
        assert!(!state.approved);
        assert!(state.executions.is_empty());
        let summary = state.planning.as_ref().unwrap();
        assert_eq!(summary.roles["planner"].tools, 1);
        assert_eq!(summary.roles["planner"].usage.total_tokens, 100);
        assert_eq!(summary.roles["planner"].duration_seconds, 5.0);
        assert!(summary.error.as_ref().unwrap().contains("Backend stopped"));
        assert_eq!(get_planning(running.planning_id.clone(), &primary).unwrap(), *summary);
        let json = dispatch(&primary, "get_planning_snapshot", serde_json::json!({
            "planningId": running.planning_id, "repository": temp.path().to_string_lossy(),
        })).unwrap();
        assert_eq!(json["runId"], id);
        let events = state.events.len();
        recover_plannings(&primary).unwrap();
        assert_eq!(history(id.clone(), &primary).unwrap().events.len(), events);
        assert!(service_for_run(&primary, &Uuid::new_v4().to_string(), false).is_err());
        invalidate_service_cache(temp.path(), None);
    }
}

#[test]
fn failed_planning_survives_cache_eviction_and_keeps_a_stable_id_on_commit() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(temp.path());
    let id = Uuid::new_v4().to_string();
    let child = service_for_run(&primary, &id, true).unwrap();
    let running = PlanningSummary { planning_id: Uuid::new_v4().to_string(), status: Some("running".into()), ..Default::default() };
    {
        let mut runtime = child.runtime.lock().unwrap();
        runtime.emit(EventKind::PlanningStarted {
            goal: "Goal".into(), config: config(temp.path()), planning: running.clone(), plan_type: Some("graph".into()),
        }).unwrap();
        let mut success = running.clone();
        success.status = Some("success".into());
        runtime.create_with_planning(Graph {
            original_goal: "Goal".into(),
            nodes: vec![Node { name: "work".into(), task: "Do work".into() }], edges: vec![],
        }, config(temp.path()), Some(running.planning_id), Some(success)).unwrap();
        assert_eq!(runtime.state.run_id, id);
        assert!(matches!(runtime.state.events[0].kind, EventKind::PlanningStarted { .. }));
        assert_eq!(runtime.state.phase, "awaiting_approval");
    }
    invalidate_service_cache(temp.path(), Some(&id));
    drop(child);
    let reloaded = service_for_run(&primary, &id, false).unwrap();
    assert_eq!(snapshot(&reloaded).unwrap().graph.nodes.len(), 1);
    invalidate_service_cache(temp.path(), None);
}

#[test]
fn committed_graph_wins_over_an_interrupted_summary_write() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(temp.path());
    let id = Uuid::new_v4().to_string();
    let (_, mut summary) = attempt(temp.path(), &id, false, false);
    summary.status = Some("success".into());
    let child = service_for_run(&primary, &id, true).unwrap();
    child.runtime.lock().unwrap().create_with_planning(Graph {
        original_goal: "Goal".into(),
        nodes: vec![Node { name: "work".into(), task: "Do work".into() }], edges: vec![],
    }, config(temp.path()), Some(summary.planning_id.clone()), Some(summary.clone())).unwrap();
    recover_plannings(&primary).unwrap();
    assert_eq!(get_planning(summary.planning_id, &primary).unwrap().status.as_deref(), Some("success"));
    assert_eq!(snapshot(&child).unwrap().phase, "awaiting_approval");
    invalidate_service_cache(temp.path(), None);
}

#[test]
fn deleted_and_cleared_planning_runs_are_not_reimported() {
    for clear in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let primary = service(temp.path());
        let id = Uuid::new_v4().to_string();
        attempt(temp.path(), &id, true, false);
        recover_plannings(&primary).unwrap();
        assert!(primary.runtime.lock().unwrap().store.contains_run(&id).unwrap());
        {
            let runtime = primary.runtime.lock().unwrap();
            if clear { runtime.store.clear().unwrap(); }
            else { runtime.store.delete_run(&id).unwrap(); }
        }
        recover_plannings(&primary).unwrap();
        assert!(!primary.runtime.lock().unwrap().store.contains_run(&id).unwrap());
        assert!(service_for_run(&primary, &id, false).is_err());
        invalidate_service_cache(temp.path(), None);
    }
}

#[test]
fn interrupted_revision_does_not_replace_a_compiled_graph() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(temp.path());
    let id = Uuid::new_v4().to_string();
    let child = service_for_run(&primary, &id, true).unwrap();
    child.runtime.lock().unwrap().create(Graph {
        original_goal: "Existing graph".into(),
        nodes: vec![Node { name: "work".into(), task: "Do work".into() }], edges: vec![],
    }, config(temp.path())).unwrap();
    let (_, running) = attempt(temp.path(), &id, false, true);
    recover_plannings(&primary).unwrap();
    let state = snapshot(&child).unwrap();
    assert_eq!(state.phase, "awaiting_approval");
    assert_eq!(state.graph.original_goal, "Existing graph");
    assert_eq!(get_planning(running.planning_id, &primary).unwrap().status.as_deref(), Some("failed"));
    invalidate_service_cache(temp.path(), None);
}

#[cfg(feature = "fixture")]
#[test]
fn run_started_is_published_after_persistence_and_commit_reuses_its_id() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("repository");
    fs::create_dir_all(&repository).unwrap();
    let root = temp.path().join("runtime");
    let primary = service(&root);
    let id = Uuid::new_v4().to_string();
    let child = service_for_run(&primary, &id, true).unwrap();
    let script = temp.path().join("planner.sh");
    fs::write(&script, concat!(
        "printf '%s' '{\"originalGoal\":\"Goal\",\"nodes\":[{\"name\":\"work\",\"task\":\"Do work\"}],\"edges\":[]}' > \"$GRAPHER_GRAPH_PATH\"\n",
        "echo '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"stopReason\":\"stop\"}}'\n",
    )).unwrap();
    let mut cfg = config(&repository);
    cfg.pi_command = "/bin/sh".into();
    cfg.pi_args = vec![script.to_string_lossy().into()];
    let mut published = None;
    let result = plan_goal_internal_with_started("Goal".into(), cfg, Some("graph"), None, None, &child,
        |run_id| {
            published = Some(run_id.to_owned());
            let saved = history(run_id.to_owned(), &primary).unwrap();
            assert_eq!(saved.phase, "planning");
            assert_eq!(saved.graph.original_goal, "Goal");
            assert!(saved.config.is_some());
        }, |_| {}, |_| {}, |_| {}).unwrap();
    assert_eq!(published.as_deref(), Some(id.as_str()));
    assert_eq!(result.run_id, id);
    assert_eq!(result.phase, "awaiting_approval");
    invalidate_service_cache(&root, Some(&id));
    assert_eq!(snapshot(&service_for_run(&primary, &id, false).unwrap()).unwrap().phase, "awaiting_approval");
    invalidate_service_cache(&root, None);
}
