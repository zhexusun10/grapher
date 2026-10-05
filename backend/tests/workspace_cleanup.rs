use grapher::{
    model::{Config, Graph, Node},
    runtime::Runtime,
};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
use uuid::Uuid;

fn cleanup(data: &Path, parent: &Path, flags: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_grapher"))
        .args(["--cleanup-workspaces", "--parent"])
        .arg(parent)
        .args(flags)
        .env("GRAPHER_DATA_DIR", data)
        .env(
            "GRAPHER_NATIVE_RUNTIME_PARENT",
            parent.join(".grapher-workspaces"),
        )
        .output()
        .unwrap()
}

#[test]
fn offline_cleanup_reclaims_completed_workspaces_but_keeps_the_conversation_and_sessions() {
    use grapher::model::EventKind;
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    let config = serde_json::from_value(serde_json::json!({"repository":source,"model":"test","maxParallel":1})).unwrap();
    let mut runtime = Runtime::open_lazy(&data).unwrap();
    runtime.create(Graph { original_goal: "test".into(), nodes: vec![Node { name: "task".into(), task: "test".into() }], edges: vec![] }, config).unwrap();
    runtime.emit(EventKind::PublicationCompleted { head: "test".into() }).unwrap();
    let id = runtime.state.run_id.clone();
    let worktree = temp.path().join(".grapher-worktrees").join(&id).join("node/dependencies");
    fs::create_dir_all(&worktree).unwrap();
    let history = data.join("sessions").join(Uuid::new_v4().to_string());
    fs::create_dir_all(&history).unwrap();
    fs::write(history.join("session.jsonl"), "history").unwrap();
    drop(runtime);
    let preview = cleanup(&data, temp.path(), &[]);
    assert!(preview.status.success(), "{}", String::from_utf8_lossy(&preview.stderr));
    assert!(worktree.is_dir());
    let apply = cleanup(&data, temp.path(), &["--apply"]);
    assert!(apply.status.success(), "{}", String::from_utf8_lossy(&apply.stderr));
    assert!(!worktree.exists());
    assert!(history.join("session.jsonl").is_file());
    assert!(Runtime::open_lazy(&data).unwrap().store.contains_run(&id).unwrap());
}

#[test]
fn explicit_parent_recovers_missing_legacy_binding_and_finishes_the_durable_queue() {
    use grapher::{cleanup::{Manifest, Target}, model::{EventKind, Snapshot}};
    use std::collections::BTreeSet;
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let source = temp.path().join("missing-source");
    let runtime = Runtime::open_lazy(&data).unwrap();
    let id = Uuid::new_v4().to_string();
    let session_id = Uuid::new_v4().to_string();
    let mut legacy = Snapshot { run_id: id.clone(), ..Default::default() };
    runtime.store.append(&mut legacy, EventKind::Created { graph: Graph::default(), config: serde_json::from_value(serde_json::json!({"repository":source,"model":"test","maxParallel":1})).unwrap(), planning_id: None, planning: None }).unwrap();
    let worktree = temp.path().join(".grapher-worktrees").join(&id).join("node/dependencies");
    fs::create_dir_all(&worktree).unwrap();
    let session = data.join("sessions").join(&session_id);
    fs::create_dir_all(&session).unwrap();
    fs::write(session.join("session.jsonl"), "history").unwrap();
    runtime.store.delete_run_with_cleanup(&id, Some(&Manifest {
        targets: BTreeSet::from([Target::data("sessions", &session_id)]),
        unresolved_repository: Some(source.to_string_lossy().into_owned()), ..Default::default()
    })).unwrap();
    drop(runtime);
    let apply = cleanup(&data, temp.path(), &["--apply"]);
    assert!(apply.status.success(), "{}", String::from_utf8_lossy(&apply.stderr));
    assert!(!worktree.exists());
    assert!(!session.exists());
    assert!(Runtime::open_lazy(&data).unwrap().store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn offline_cleanup_requires_a_free_data_lease_and_explicit_apply() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("keep.txt"), "source data").unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": source, "model": "test", "maxParallel": 1,
    }))
    .unwrap();
    let mut runtime = Runtime::open_lazy(&data).unwrap();
    let graph = Graph {
        original_goal: "cleanup test".into(),
        nodes: vec![Node {
            name: "task".into(),
            task: "not executed".into(),
        }],
        edges: vec![],
    };
    runtime.create(graph.clone(), config.clone()).unwrap();
    let deleted = runtime.state.run_id.clone();
    runtime.create(graph, config).unwrap();
    let live = runtime.state.run_id.clone();
    // Simulate old deletion that lost the database record but left directories.
    runtime.store.delete_run(&deleted).unwrap();
    let unknown = Uuid::new_v4().to_string();
    let ws = temp.path().join(".grapher-workspaces");
    for id in [&deleted, &live, &unknown] {
        fs::create_dir_all(ws.join(id).join("node/dependencies")).unwrap();
        fs::write(ws.join(id).join("node/dependencies/keep"), "workspace").unwrap();
    }
    let legacy = ws.join("grapher-native-engine-legacy");
    for path in ["engine", "scripts", "pi/.git"] {
        fs::create_dir_all(legacy.join(path)).unwrap();
    }
    for path in [
        "engine/entrypoint.mjs",
        "scripts/pi-baseline.mjs",
        "package.json",
    ] {
        fs::write(legacy.join(path), "fixture").unwrap();
    }
    let blocked = cleanup(&data, temp.path(), &["--legacy-engines", "--apply"]);
    assert!(!blocked.status.success());
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("Another Grapher instance"));
    assert!(ws.join(&deleted).exists());
    assert!(legacy.exists());
    drop(runtime);

    let preview = cleanup(&data, temp.path(), &["--legacy-engines"]);
    assert!(
        preview.status.success(),
        "{}",
        String::from_utf8_lossy(&preview.stderr)
    );
    let output = String::from_utf8_lossy(&preview.stdout);
    assert!(output.contains("Preview"));
    assert!(output.contains("1 workspace paths, 1 unused engine copies"));
    assert!(ws.join(&deleted).join("node/dependencies/keep").is_file());
    assert!(legacy.exists());

    let applied = cleanup(&data, temp.path(), &["--legacy-engines", "--apply"]);
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    assert!(!ws.join(&deleted).exists());
    assert!(!legacy.exists());
    assert!(ws.join(&live).join("node/dependencies/keep").is_file());
    assert!(ws.join(&unknown).join("node/dependencies/keep").is_file());
    assert_eq!(
        fs::read_to_string(source.join("keep.txt")).unwrap(),
        "source data"
    );
    let runtime = Runtime::open_lazy(&data).unwrap();
    assert_eq!(runtime.store.runs().unwrap(), vec![live]);
}
