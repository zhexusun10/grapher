use super::*;

#[test]
fn composer_node_override_survives_replay_profile_saves_and_dispatch() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: vec![
            Node {
                name: "a".into(),
                task: "a".into(),
            },
            Node {
                name: "b".into(),
                task: "b".into(),
            },
        ],
        edges: vec![],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    let original = runtime.state.config.clone().unwrap();
    let settings = crate::model::RoleModelConfig {
        model: "private/only-a".into(),
        thinking_level: Some("high".into()),
    };
    runtime
        .emit(EventKind::NodeModelOverrideUpdated {
            node: "a".into(),
            settings: settings.clone(),
        })
        .unwrap();
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    assert!(runtime.state.nodes["a"].model_override);
    assert!(!runtime.state.nodes["b"].model_override);
    assert_eq!(
        runtime
            .state
            .effective_config()
            .unwrap()
            .node_agent_settings(),
        original.node_agent_settings(),
        "legacy hydration must not promote an explicit node override to the conversation"
    );
    let mut changed = original.clone();
    changed.role_models.insert(
        "nodeAgent".into(),
        crate::model::RoleModelConfig {
            model: "conversation/new".into(),
            thinking_level: Some("low".into()),
        },
    );
    runtime.update_node_models(&changed).unwrap();
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    assert_eq!(jobs.len(), 2);
    let a = jobs.iter().find(|job| job.execution.node == "a").unwrap();
    let b = jobs.iter().find(|job| job.execution.node == "b").unwrap();
    assert_eq!(a.config.node_agent_settings(), settings);
    assert_eq!(
        b.config.node_agent_settings(),
        changed.node_agent_settings()
    );
    assert_eq!(runtime.state.config.as_ref().unwrap().model, original.model);
    runtime.finish(&a.execution, Err("quota".into())).unwrap();
    runtime.update_node_models(&changed).unwrap();
    assert_eq!(
        runtime.state.nodes["a"].model_config.as_ref(),
        Some(&settings),
        "failure reconciliation must not discard an explicit override"
    );
}

#[test]
fn composer_change_does_not_mutate_an_inflight_job() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    let before = job.config.node_agent_settings();
    runtime
        .emit(EventKind::NodeModelOverrideUpdated {
            node: "task".into(),
            settings: crate::model::RoleModelConfig {
                model: "next/model".into(),
                thinking_level: Some("off".into()),
            },
        })
        .unwrap();
    assert_eq!(job.config.node_agent_settings(), before);
    assert_eq!(
        runtime.state.executions[0]
            .metrics
            .as_ref()
            .unwrap()
            .model
            .as_deref(),
        Some(before.model.as_str())
    );
}
