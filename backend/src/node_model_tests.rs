use super::*;

fn replacement(config: &Config) -> Config {
    let mut config = config.clone();
    config.model = "legacy/unused".into();
    config.thinking_level = "off".into();
    config.role_models.insert("nodeAgent".into(), crate::model::RoleModelConfig {
        model: "replacement/coder".into(), thinking_level: Some("high".into()),
    });
    config
}

#[test]
fn failed_node_model_change_is_durable_and_continue_keeps_the_session_and_workspace() {
    for route in ["graph", "serial"] {
        for paused in [false, true] {
            let (_temp, source, mut runtime) = setup(true, single());
            runtime.set_route(route).unwrap();
            runtime.approve().unwrap();
            let failed = runtime.jobs().unwrap().remove(0);
            if route == "graph" {
                workspace::prepare(&source, Path::new(&failed.execution.worktree),
                    &failed.execution.before, &[]).unwrap();
                runtime.emit(EventKind::Prepared {
                    execution_id: failed.execution.id.clone(), head: failed.execution.before.clone(),
                }).unwrap();
            }
            let partial = Path::new(&failed.execution.worktree).join("partial.txt");
            fs::write(&partial, "keep unfinished work").unwrap();
            runtime.finish(&failed.execution, Err("Provider quota exhausted".into())).unwrap();
            runtime.jobs().unwrap();
            assert!(!runtime.state.can_resume());
            if paused { runtime.pause(true).unwrap(); }
            let original = serde_json::to_value(&runtime.state.config).unwrap();
            let config = replacement(runtime.state.config.as_ref().unwrap());
            let error = runtime.state.nodes["task"].error.clone();
            runtime.update_node_models(&config).unwrap();
            assert_eq!(runtime.state.nodes["task"].status, "failed");
            assert_eq!(runtime.state.nodes["task"].error, error);
            assert_eq!(runtime.state.executions.len(), 1, "saving never dispatches a retry");
            assert!(runtime.state.can_resume());
            assert_eq!(crate::snapshot_view::snapshot_metadata(&runtime.state).unwrap()["canResume"], true);
            assert_eq!(serde_json::to_value(&runtime.state.config).unwrap(), original);
            let version = runtime.snapshot_version();
            runtime.update_node_models(&config).unwrap();
            assert_eq!(runtime.snapshot_version(), version, "identical saves are idempotent");

            let root = runtime.root.clone();
            drop(runtime);
            let mut runtime = Runtime::open(&root).unwrap();
            assert!(runtime.state.can_resume(), "the override survives a backend restart");
            assert_eq!(runtime.state.nodes["task"].model_config, Some(config.node_agent_settings()));
            runtime.pause(false).unwrap();
            let next = runtime.jobs().unwrap().remove(0);
            assert_eq!(next.config.node_agent_settings(), config.node_agent_settings());
            assert!(next.continuation);
            assert!(next.task.is_empty(), "do not add a synthetic user message");
            assert_eq!(next.execution.session_id, failed.execution.session_id);
            assert_eq!(next.execution.worktree, failed.execution.worktree);
            assert_eq!(next.resume_execution_id, Some(failed.execution.id.clone()));
            assert_ne!(next.execution.id, failed.execution.id);
            assert_eq!(next.execution.attempt, 2);
            if route == "graph" { assert!(next.preserved_workspace.is_some()); }
            assert_eq!(fs::read_to_string(partial).unwrap(), "keep unfinished work");
            assert_eq!(runtime.state.executions[0].status, "failed");
            assert!(!runtime.state.can_resume());
        }
    }
}

#[test]
fn newly_added_nodes_use_this_conversations_saved_settings() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let latest = replacement(runtime.state.config.as_ref().unwrap());
    runtime.update_node_models(&latest).unwrap();
    let mut graph = runtime.state.graph.clone();
    graph.nodes.push(Node { name: "added".into(), task: "added".into() });
    runtime.revise_graph(graph, PlanningSummary {
        planning_id: Uuid::new_v4().to_string(),
        status: Some("success".into()),
        ..Default::default()
    }).unwrap();
    let jobs = runtime.jobs().unwrap();
    for name in ["task", "added"] {
        let job = jobs.iter().find(|job| job.execution.node == name).unwrap();
        assert_eq!(job.config.node_agent_settings(), latest.node_agent_settings(),
            "a node added after the conversation changed models must use that selection");
        assert_eq!(job.execution.metrics.as_ref().and_then(|metrics| metrics.model.as_deref()),
            Some(latest.node_agent_settings().model.as_str()),
            "session details must see the selected model before launch");
    }
}

#[test]
fn node_model_change_updates_waiting_and_blocked_nodes_but_not_active_or_completed_nodes() {
    let graph = Graph {
        nodes: ["failed", "completed", "running", "after", "pending"].into_iter()
            .map(|name| Node { name: name.into(), task: name.into() }).collect(),
        edges: vec![
            Edge { from: "failed".into(), to: "after".into(), feedback: false },
            Edge { from: "running".into(), to: "pending".into(), feedback: false },
        ],
        ..Graph::default()
    };
    let (_temp, _source, mut runtime) = setup(true, graph.clone());
    let mut config = runtime.state.config.clone().unwrap();
    config.max_parallel = 3;
    runtime.edit_draft_graph(graph, config.clone()).unwrap();
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    let failed = jobs.iter().find(|job| job.execution.node == "failed").unwrap();
    let completed = jobs.iter().find(|job| job.execution.node == "completed").unwrap();
    let running = jobs.iter().find(|job| job.execution.node == "running").unwrap();
    runtime.finish(&failed.execution, Err("Provider failed".into())).unwrap();
    runtime.finish(&completed.execution, Ok((runtime.state.base.clone(), "completed".into()))).unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.nodes["after"].status, "blocked");
    assert_eq!(runtime.state.nodes["pending"].status, "waiting");
    let before = serde_json::to_value(&runtime.state).unwrap();
    let mut settings = replacement(&config);
    settings.repository = "not-the-run-repository".into();
    settings.max_parallel = 1;
    settings.max_feedback = 0;
    runtime.update_node_models(&settings).unwrap();
    let after = serde_json::to_value(&runtime.state).unwrap();
    for name in ["completed", "running"] {
        assert_eq!(after["nodes"][name], before["nodes"][name]);
    }
    for name in ["after", "pending"] {
        let mut expected = before["nodes"][name].clone();
        expected["modelConfig"] = serde_json::to_value(settings.node_agent_settings()).unwrap();
        expected["modelRetry"] = serde_json::json!(false);
        assert_eq!(after["nodes"][name], expected, "only settings change for {name}");
    }
    assert_eq!(after["config"], before["config"]);
    assert_eq!(after["executions"], before["executions"]);
    assert_eq!(after["phase"], before["phase"]);
    assert_eq!(running.config.node_agent_settings(), config.node_agent_settings());
    assert!(!runtime.state.can_resume(), "an active writer still disables the recovery hint");

    runtime.finish(&running.execution, Err("Unrelated provider failure".into())).unwrap();
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.nodes["after"].status, "blocked");
    assert_eq!(runtime.state.nodes["pending"].status, "blocked");
    runtime.pause(false).unwrap();
    let retry = runtime.jobs().unwrap();
    assert_eq!(retry.len(), 1);
    assert_eq!(retry[0].execution.node, "failed");
    assert_eq!(retry[0].config.node_agent_settings(), settings.node_agent_settings());
    assert_eq!(runtime.state.nodes["after"].status, "waiting");
    assert_eq!(runtime.state.nodes["running"].status, "failed");
    assert_eq!(runtime.state.nodes["pending"].status, "blocked");
    assert_eq!(runtime.state.nodes["completed"].status, "completed");
}

#[test]
fn unstarted_node_models_follow_settings_in_drafts_and_before_dispatch() {
    for route in ["graph", "serial"] {
        for approved in [false, true] {
            let (_temp, _source, mut runtime) = setup(true, single());
            runtime.set_route(route).unwrap();
            if approved {
                runtime.approve().unwrap();
                runtime.pause(true).unwrap();
            }
            let original = runtime.state.config.clone().unwrap();
            let before = serde_json::to_value(&runtime.state).unwrap();
            let mut config = replacement(&original);
            runtime.update_node_models(&config).unwrap();
            assert_eq!(runtime.state.nodes["task"].model_config, Some(config.node_agent_settings()));
            assert_eq!(runtime.state.nodes["task"].status, "waiting");
            assert_eq!(runtime.state.nodes["task"].model_retry, Some(false));
            assert_eq!(runtime.state.phase, before["phase"].as_str().unwrap());
            assert_eq!(runtime.state.approved, approved);
            assert!(runtime.state.executions.is_empty(), "saving never dispatches work");
            assert!(!runtime.state.can_resume(), "unstarted overrides are not failure recovery");
            let version = runtime.snapshot_version();
            runtime.update_node_models(&config).unwrap();
            assert_eq!(runtime.snapshot_version(), version);

            // Reverting to the Run's original selection must replace the override too.
            runtime.update_node_models(&original).unwrap();
            assert_eq!(runtime.state.nodes["task"].model_config, Some(original.node_agent_settings()));
            config.role_models.get_mut("nodeAgent").unwrap().thinking_level = Some("low".into());
            runtime.update_node_models(&config).unwrap();
            assert_eq!(serde_json::to_value(&runtime.state.config).unwrap(), before["config"]);

            let root = runtime.root.clone();
            drop(runtime);
            let mut runtime = Runtime::open(&root).unwrap();
            assert_eq!(runtime.state.nodes["task"].model_config, Some(config.node_agent_settings()));
            if approved { runtime.pause(false).unwrap(); } else { runtime.approve().unwrap(); }
            let job = runtime.jobs().unwrap().remove(0);
            assert_eq!(job.config.node_agent_settings(), config.node_agent_settings());
            assert!(!job.continuation);
            assert_eq!(job.execution.attempt, 1);
        }
    }
}

#[test]
fn prestart_model_settings_do_not_opt_later_failures_into_continue() {
    let (_temp, _source, mut runtime) = setup(true, single());
    let mut config = replacement(runtime.state.config.as_ref().unwrap());
    runtime.update_node_models(&config).unwrap();
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    runtime.finish(&job.execution, Err("Provider quota exhausted".into())).unwrap();
    runtime.jobs().unwrap();
    assert!(!runtime.state.can_resume());
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    assert!(!runtime.state.can_resume(), "a prestart save is not a post-failure recovery decision");
    runtime.update_node_models(&config).unwrap();
    assert!(!runtime.state.can_resume(), "an unchanged save cannot opt in to recovery");
    config.role_models.get_mut("nodeAgent").unwrap().thinking_level = Some("low".into());
    runtime.update_node_models(&config).unwrap();
    assert!(runtime.state.can_resume(), "changed settings while failed still enable Continue");
}

#[test]
fn previously_started_waiting_blocked_and_dirty_nodes_keep_their_models() {
    for status in ["waiting", "blocked", "dirty"] {
        let (_temp, _source, mut runtime) = setup(true, single());
        runtime.approve().unwrap();
        let job = runtime.jobs().unwrap().remove(0);
        runtime.finish(&job.execution, Ok((runtime.state.base.clone(), "completed".into()))).unwrap();
        // These states can also represent rescheduled work, not just a first attempt.
        runtime.state.nodes.get_mut("task").unwrap().status = status.into();
        runtime.state.superseded_execution_ids.push(job.execution.id.clone());
        runtime.update_node_models(&replacement(runtime.state.config.as_ref().unwrap())).unwrap();
        assert!(runtime.state.nodes["task"].model_config.is_none(),
            "an already-started node keeps its own model");
        assert_eq!(runtime.state.model_config.as_ref().unwrap().node_agent_settings().model,
            "replacement/coder", "the conversation still records the selection for future nodes");
    }
}

#[test]
fn legacy_failed_node_model_events_and_snapshots_keep_continue_recovery() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    runtime.finish(&job.execution, Err("Provider failed".into())).unwrap();
    runtime.jobs().unwrap();
    let settings = replacement(runtime.state.config.as_ref().unwrap()).node_agent_settings();
    runtime.emit(EventKind::FailedNodeModelsUpdated {
        nodes: vec!["task".into()], settings: settings.clone(),
    }).unwrap();
    assert!(runtime.state.can_resume());
    let root = runtime.root.clone();
    drop(runtime);
    let runtime = Runtime::open(&root).unwrap();
    assert_eq!(runtime.state.nodes["task"].model_config, Some(settings));
    assert!(runtime.state.can_resume());
    let mut legacy = serde_json::to_value(&runtime.state).unwrap();
    legacy["nodes"]["task"].as_object_mut().unwrap().remove("modelRetry");
    let legacy: Snapshot = serde_json::from_value(legacy).unwrap();
    assert!(legacy.can_resume(), "old checkpoints without a retry flag remain recoverable");
}

#[test]
fn unrelated_settings_do_not_opt_provider_failures_into_continue() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let failed = runtime.jobs().unwrap().remove(0);
    runtime.finish(&failed.execution, Err("Provider failed".into())).unwrap();
    runtime.jobs().unwrap();
    let version = runtime.snapshot_version();
    let mut config = runtime.state.config.clone().unwrap();
    config.role_models.insert("planner".into(), crate::model::RoleModelConfig {
        model: "replacement/planner".into(), thinking_level: Some("max".into()),
    });
    config.auto_approve = true;
    runtime.update_node_models(&config).unwrap();
    assert_ne!(runtime.snapshot_version(), version, "the conversation records its planner settings");
    assert!(!runtime.state.can_resume(), "a planner-only change does not opt a failed node into Continue");
    runtime.pause(false).unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.nodes["task"].status, "failed");

    // Legacy defaults and thinking-only changes are also effective node settings.
    config.thinking_level = "high".into();
    runtime.update_node_models(&config).unwrap();
    assert!(runtime.state.can_resume());
    assert_eq!(runtime.state.nodes["task"].model_config, Some(config.node_agent_settings()));
}

#[test]
fn conversation_settings_do_not_leak_into_another_run_or_global_defaults() {
    let (_temp, _source, mut runtime) = setup(true, single());
    let original = runtime.state.config.clone().unwrap();
    let run_a = runtime.state.run_id.clone();
    let mut changed = replacement(&original);
    changed.role_models.get_mut("nodeAgent").unwrap().model = "conversation/a".into();
    runtime.update_node_models(&changed).unwrap();

    // A different conversation created later uses its own settings, not A's save.
    runtime.create(single(), original.clone()).unwrap();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();
    let mut graph = runtime.state.graph.clone();
    graph.nodes.push(Node { name: "added".into(), task: "added".into() });
    runtime.revise_graph(graph, PlanningSummary {
        planning_id: Uuid::new_v4().to_string(),
        status: Some("success".into()),
        ..Default::default()
    }).unwrap();
    for job in runtime.jobs().unwrap() {
        assert_eq!(job.config.node_agent_settings(), original.node_agent_settings(),
            "another conversation keeps its creation settings");
    }

    // A global defaults save must not rewrite A either.
    let mut global = original.clone();
    global.model = "global/default".into();
    runtime.save_default_config(&global).unwrap();
    let saved_a = runtime.store.load(&run_a).unwrap();
    assert_eq!(saved_a.model_config.as_ref().unwrap().node_agent_settings().model, "conversation/a");
    assert_eq!(saved_a.config.as_ref().unwrap().model, original.model);
}

#[test]
fn a_finished_conversation_records_models_for_future_followups() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    runtime.finish(&job.execution, Ok((runtime.state.base.clone(), "completed".into()))).unwrap();
    runtime.jobs().unwrap();
    runtime.emit(EventKind::PublicationCompleted { head: runtime.state.base.clone() }).unwrap();
    assert_eq!(runtime.state.phase, "completed", "test setup reaches the settled phase");
    let node_before = serde_json::to_value(&runtime.state.nodes["task"]).unwrap();
    let config = replacement(runtime.state.config.as_ref().unwrap());
    runtime.update_node_models(&config).unwrap();
    assert_eq!(serde_json::to_value(&runtime.state.nodes["task"]).unwrap(), node_before,
        "an executed node keeps its recorded model");
    assert_eq!(runtime.state.model_config.as_ref().unwrap().node_agent_settings(),
        config.node_agent_settings(), "the conversation selects the model for future turns");
    let root = runtime.root.clone();
    drop(runtime);
    let restored = Runtime::open(&root).unwrap();
    assert_eq!(restored.state.model_config.as_ref().unwrap().node_agent_settings(),
        config.node_agent_settings(), "the settled conversation keeps the selection after restart");
    let metadata = crate::snapshot_view::snapshot_metadata(&restored.state).unwrap();
    assert_eq!(metadata["modelConfig"]["roleModels"]["nodeAgent"]["model"], "replacement/coder",
        "the Settings projection receives the restored conversation selection");
}

#[test]
fn legacy_checkpoints_hydrate_the_conversation_selection_from_node_overrides() {
    let (_temp, _source, mut runtime) = setup(true, single());
    let config = replacement(runtime.state.config.as_ref().unwrap());
    runtime.emit(EventKind::NodeModelsUpdated {
        nodes: vec!["task".into()],
        settings: config.node_agent_settings(),
    }).unwrap();
    // Simulate a checkpoint written before Run-level model selections existed.
    runtime.state.model_config = None;
    runtime.state.hydrate_legacy_model_config();
    let settings = runtime.state.model_config.as_ref().unwrap();
    assert_eq!(settings.node_agent_settings(), config.node_agent_settings());
    assert_eq!(settings.model, runtime.state.config.as_ref().unwrap().model,
        "legacy hydration keeps the Run's original non-node roles");
}
