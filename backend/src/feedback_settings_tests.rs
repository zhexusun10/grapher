use super::*;
use std::sync::{Arc, Barrier};

fn candidate(feedback: bool) -> Graph {
    let mut graph = Graph {
        original_goal: "Feedback settings".into(),
        nodes: ["a", "b", "c"].into_iter().map(|name| Node { name: name.into(), task: format!("Work on {name}") }).collect(),
        edges: [("a", "b"), ("b", "c")].into_iter().map(|(from, to)| Edge { from: from.into(), to: to.into(), feedback: false }).collect(),
    };
    if feedback { graph.edges.push(Edge { from: "c".into(), to: "a".into(), feedback: true }); }
    graph
}

fn setup(enabled: bool) -> (tempfile::TempDir, Runtime, Config) {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::open(temp.path()).unwrap();
    let config = serde_json::from_value(serde_json::json!({
        "repository": "", "model": "", "engine": "fixture", "feedbackEnabled": enabled,
        "postTaskReview": false, "autoApprove": false
    })).unwrap();
    (temp, runtime, config)
}

#[test]
fn feedback_settings_gate_new_graphs_and_every_revision_entrypoint() {
    let (_temp, mut runtime, config) = setup(false);
    let rejected = |result: Result<(), String>| assert!(result.unwrap_err().contains("Enable Feedback in Settings"));
    rejected(runtime.create(candidate(true), config.clone()));
    assert!(runtime.state.events.is_empty());
    runtime.create(candidate(false), config.clone()).unwrap();
    runtime.set_route("graph").unwrap();
    let count = runtime.state.events.len();
    rejected(runtime.edit_draft_graph(candidate(true), config.clone()));
    rejected(runtime.update_draft_graph(candidate(true), "probe".into(), PlanningSummary::default()));
    assert_eq!(runtime.state.events.len(), count);
    assert_eq!(runtime.state.graph, candidate(false));
    runtime.approve().unwrap();
    let count = runtime.state.events.len();
    rejected(runtime.revise_graph(candidate(true), PlanningSummary::default()));
    rejected(runtime.update_draft_graph(candidate(true), "probe".into(), PlanningSummary::default()));
    assert_eq!(runtime.state.events.len(), count);
    // Ordinary edits still work; the capability is not a blanket edit lock.
    let mut ordinary = candidate(false);
    ordinary.nodes[0].task = "Updated task".into();
    runtime.revise_graph(ordinary.clone(), PlanningSummary::default()).unwrap();
    assert_eq!(runtime.state.graph, ordinary);
}

#[test]
fn feedback_settings_saved_opt_out_beats_stale_clients_without_rewriting_old_runs() {
    let (_temp, mut runtime, config) = setup(true);
    runtime.create(candidate(true), config.clone()).unwrap();
    let run_id = runtime.state.run_id.clone();
    let mut disabled = config.clone();
    disabled.feedback_enabled = false;
    runtime.save_default_config(&disabled).unwrap();
    // A new Run cannot inherit routes merely because another Run used them.
    assert!(runtime.create(candidate(true), config.clone()).unwrap_err().contains("Enable Feedback"));
    assert_eq!(runtime.state.run_id, run_id);
    assert_eq!(runtime.state.graph, candidate(true));
    // Editing the existing draft may retain its routes, but cannot retarget/add.
    runtime.edit_draft_graph(candidate(true), config.clone()).unwrap();
    assert!(!runtime.state.config.as_ref().unwrap().feedback_enabled);
    let mut retargeted = candidate(true);
    retargeted.edges.last_mut().unwrap().to = "b".into();
    assert!(runtime.edit_draft_graph(retargeted, config).unwrap_err().contains("Enable Feedback"));
    assert_eq!(runtime.store.load(&run_id).unwrap().graph, candidate(true));
    runtime.approve().unwrap();
    for expected in ["a", "b"] {
        let job = runtime.jobs().unwrap().remove(0);
        assert_eq!(job.execution.node, expected);
        runtime.finish(&job.execution, Ok((String::new(), "done".into()))).unwrap();
    }
    let reviewer = runtime.jobs().unwrap().remove(0);
    assert_eq!(reviewer.execution.node, "c");
    assert!(reviewer.feedback_source, "committed routes still execute after opt-out");
}

#[test]
fn feedback_settings_allow_retaining_and_removing_old_routes_but_not_readding_them() {
    let (_temp, mut runtime, mut config) = setup(true);
    runtime.create(candidate(true), config.clone()).unwrap();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();
    config.feedback_enabled = false;
    runtime.save_default_config(&config).unwrap();
    runtime.revise_graph(candidate(true), PlanningSummary::default()).unwrap();
    runtime.revise_graph(candidate(false), PlanningSummary::default()).unwrap();
    assert!(runtime.revise_graph(candidate(true), PlanningSummary::default()).unwrap_err().contains("Enable Feedback"));
    assert_eq!(runtime.store.load(&runtime.state.run_id).unwrap().graph, candidate(false));
    // Explicit re-enabling authorizes additions even to an older disabled Run.
    config.feedback_enabled = true;
    runtime.save_default_config(&config).unwrap();
    runtime.revise_graph(candidate(true), PlanningSummary::default()).unwrap();
}

#[test]
fn feedback_settings_only_missing_files_may_use_the_initial_configuration() {
    let (temp, mut runtime, config) = setup(true);
    assert!(runtime.feedback_enabled(true).unwrap());
    assert!(!runtime.feedback_enabled(false).unwrap());
    let path = temp.path().join("config.json");
    for content in ["", "{", "{}"] {
        fs::write(&path, content).unwrap();
        assert!(runtime.feedback_enabled(true).unwrap_err().contains("Cannot read Feedback setting"));
        assert!(runtime.create(candidate(true), config.clone()).unwrap_err().contains("Cannot read Feedback setting"));
        assert!(runtime.state.events.is_empty());
    }
    fs::write(&path, r#"{"repository":"","model":""}"#).unwrap();
    assert!(!runtime.feedback_enabled(true).unwrap(), "legacy settings default off");
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(runtime.feedback_enabled(true).is_err(), "unreadable is not absent");
    assert!(runtime.save_default_config(&config).is_err());
    assert!(path.is_dir());
    assert!(!fs::read_dir(temp.path()).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".config-")));
}

#[test]
fn feedback_settings_concurrent_saves_never_reenable_a_stale_run() {
    let (temp, runtime, mut config) = setup(true);
    config.feedback_enabled = false;
    runtime.save_default_config(&config).unwrap();
    let writer = runtime.open_run("").unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let ready = barrier.clone();
    let thread = std::thread::spawn(move || {
        ready.wait();
        for index in 0..300 {
            config.model = format!("model/{index}");
            writer.save_default_config(&config).unwrap();
        }
    });
    barrier.wait();
    let reads: Vec<_> = (0..3000).map(|_| runtime.feedback_enabled(true)).collect();
    thread.join().unwrap();
    assert!(reads.iter().all(|result| result == &Ok(false)), "readers must see only complete disabled settings: {:?}", reads.iter().find(|value| value != &&Ok(false)));
    let saved: Config = serde_json::from_slice(&fs::read(temp.path().join("config.json")).unwrap()).unwrap();
    assert_eq!(saved.model, "model/299");
    assert!(!saved.feedback_enabled);
    assert!(!fs::read_dir(temp.path()).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".config-")));
}
