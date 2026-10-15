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
            runtime.update_failed_node_models(&config).unwrap();
            assert_eq!(runtime.state.nodes["task"].status, "failed");
            assert_eq!(runtime.state.nodes["task"].error, error);
            assert_eq!(runtime.state.executions.len(), 1, "saving never dispatches a retry");
            assert!(runtime.state.can_resume());
            assert_eq!(crate::snapshot_view::snapshot_metadata(&runtime.state).unwrap()["canResume"], true);
            assert_eq!(serde_json::to_value(&runtime.state.config).unwrap(), original);
            let version = runtime.snapshot_version();
            runtime.update_failed_node_models(&config).unwrap();
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
fn failed_node_model_change_does_not_modify_other_nodes_or_run_settings() {
    let graph = Graph {
        nodes: ["failed", "done", "running", "after", "pending"].into_iter()
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
    let done = jobs.iter().find(|job| job.execution.node == "done").unwrap();
    let running = jobs.iter().find(|job| job.execution.node == "running").unwrap();
    runtime.finish(&failed.execution, Err("Provider failed".into())).unwrap();
    runtime.finish(&done.execution, Ok((runtime.state.base.clone(), "done".into()))).unwrap();
    let before = serde_json::to_value(&runtime.state).unwrap();
    let mut settings = replacement(&config);
    settings.repository = "not-the-run-repository".into();
    settings.max_parallel = 1;
    settings.max_feedback = 0;
    runtime.update_failed_node_models(&settings).unwrap();
    let after = serde_json::to_value(&runtime.state).unwrap();
    for name in ["done", "running", "after", "pending"] {
        assert_eq!(after["nodes"][name], before["nodes"][name]);
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
    assert_eq!(runtime.state.nodes["done"].status, "done");
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
    runtime.update_failed_node_models(&config).unwrap();
    assert_eq!(runtime.snapshot_version(), version);
    assert!(!runtime.state.can_resume());
    runtime.pause(false).unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.nodes["task"].status, "failed");

    // Legacy defaults and thinking-only changes are also effective node settings.
    config.thinking_level = "high".into();
    runtime.update_failed_node_models(&config).unwrap();
    assert!(runtime.state.can_resume());
    assert_eq!(runtime.state.nodes["task"].model_config, Some(config.node_agent_settings()));
}
