use grapher::{
    cleanup::{Manifest, Target},
    model::{Config, EventKind, Graph, Node},
    runtime::Runtime,
};
use std::{
    collections::BTreeSet,
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
        .env("GRAPHER_NATIVE_RUNTIME_PARENT", parent.join("runtimes"))
        .output()
        .unwrap()
}

fn graph() -> Graph {
    Graph {
        original_goal: "cleanup".into(),
        nodes: vec![Node {
            id: "task".into(),
            task: "test".into(),
        }],
        edges: vec![],
    }
}

fn config(source: &Path) -> Config {
    serde_json::from_value(serde_json::json!({"repository":source,"model":"test/model","maxParallel":2,"postTaskReview":false})).unwrap()
}

fn remember(runtime: &Runtime, parent: &Path, id: &str) {
    runtime
        .store
        .remember_cleanup_targets(
            id,
            &BTreeSet::from([Target::Workspace {
                parent: parent.canonicalize().unwrap(),
                bucket: ".grapher-worktrees".into(),
                owner: id.into(),
                checkout: None,
            }]),
        )
        .unwrap();
}

#[test]
fn offline_cleanup_reclaims_recorded_workspaces_but_keeps_conversation_and_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    let mut runtime = Runtime::open_lazy(&data).unwrap();
    runtime.create(graph(), config(&source)).unwrap();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    runtime
        .finish(&job.execution, Ok((String::new(), String::new())))
        .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted {
            head: "test".into(),
        })
        .unwrap();
    let id = runtime.state.run_id.clone();
    remember(&runtime, temp.path(), &id);
    let worktree = temp
        .path()
        .join(".grapher-worktrees")
        .join(&id)
        .join("node/dependencies");
    fs::create_dir_all(&worktree).unwrap();
    let history = data.join("sessions").join(Uuid::new_v4().to_string());
    fs::create_dir_all(&history).unwrap();
    fs::write(history.join("session.jsonl"), "history").unwrap();
    drop(runtime);
    let preview = cleanup(&data, temp.path(), &[]);
    assert!(
        preview.status.success(),
        "{}",
        String::from_utf8_lossy(&preview.stderr)
    );
    assert!(worktree.is_dir());
    let apply = cleanup(&data, temp.path(), &["--apply"]);
    assert!(
        apply.status.success(),
        "{}",
        String::from_utf8_lossy(&apply.stderr)
    );
    assert!(!worktree.exists());
    assert!(history.join("session.jsonl").is_file());
    assert!(Runtime::open_lazy(&data)
        .unwrap()
        .store
        .contains_run(&id)
        .unwrap());
}

#[test]
fn explicit_parent_does_not_adopt_unregistered_workspaces_or_clear_unresolved_ownership() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let source = temp.path().join("missing-source");
    let mut runtime = Runtime::open_lazy(&data).unwrap();
    runtime.create(graph(), config(&source)).unwrap();
    let id = runtime.state.run_id.clone();
    let session_id = Uuid::new_v4().to_string();
    let worktree = temp
        .path()
        .join(".grapher-worktrees")
        .join(&id)
        .join("node/dependencies");
    fs::create_dir_all(&worktree).unwrap();
    fs::write(worktree.join("keep"), "unregistered data").unwrap();
    let session = data.join("sessions").join(&session_id);
    fs::create_dir_all(&session).unwrap();
    runtime
        .store
        .delete_run_with_cleanup(
            &id,
            Some(&Manifest {
                targets: BTreeSet::from([Target::data("sessions", &session_id)]),
                unresolved_repository: Some(source.to_string_lossy().into_owned()),
                ..Default::default()
            }),
        )
        .unwrap();
    drop(runtime);
    let apply = cleanup(&data, temp.path(), &["--apply"]);
    assert!(
        !apply.status.success(),
        "unresolved ownership must stay visible"
    );
    assert_eq!(
        fs::read_to_string(worktree.join("keep")).unwrap(),
        "unregistered data"
    );
    assert_eq!(
        Runtime::open_lazy(&data)
            .unwrap()
            .store
            .pending_cleanups()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn offline_cleanup_requires_a_free_lease_and_apply_and_preserves_unmarked_engines() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("keep.txt"), "source data").unwrap();
    let mut runtime = Runtime::open_lazy(&data).unwrap();
    runtime.create(graph(), config(&source)).unwrap();
    let deleted = runtime.state.run_id.clone();
    remember(&runtime, temp.path(), &deleted);
    runtime.create(graph(), config(&source)).unwrap();
    let live = runtime.state.run_id.clone();
    remember(&runtime, temp.path(), &live);
    runtime.store.delete_run(&deleted).unwrap();
    let unknown = Uuid::new_v4().to_string();
    let ws = temp.path().join(".grapher-worktrees");
    for id in [&deleted, &live, &unknown] {
        fs::create_dir_all(ws.join(id).join("node/dependencies")).unwrap();
        fs::write(ws.join(id).join("node/dependencies/keep"), "workspace").unwrap();
    }
    let unmarked = temp.path().join("runtimes/grapher-native-engine-unmarked");
    for path in ["engine", "scripts", "pi/.git"] {
        fs::create_dir_all(unmarked.join(path)).unwrap();
    }
    for path in [
        "engine/entrypoint.mjs",
        "scripts/pi-baseline.mjs",
        "package.json",
    ] {
        fs::write(unmarked.join(path), "fixture").unwrap();
    }
    let blocked = cleanup(&data, temp.path(), &["--apply"]);
    assert!(!blocked.status.success());
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("Another Grapher instance"));
    assert!(ws.join(&deleted).exists());
    drop(runtime);
    let retired = cleanup(&data, temp.path(), &["--legacy-engines", "--apply"]);
    assert!(!retired.status.success());
    assert!(String::from_utf8_lossy(&retired.stderr).contains("Unknown cleanup argument"));
    assert!(unmarked.exists());
    let preview = cleanup(&data, temp.path(), &[]);
    assert!(
        preview.status.success(),
        "{}",
        String::from_utf8_lossy(&preview.stderr)
    );
    assert!(String::from_utf8_lossy(&preview.stdout)
        .contains("1 workspace paths, 0 unused engine copies"));
    assert!(ws.join(&deleted).join("node/dependencies/keep").is_file());
    let applied = cleanup(&data, temp.path(), &["--apply"]);
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    assert!(!ws.join(&deleted).exists());
    assert!(unmarked.exists());
    assert!(ws.join(&live).join("node/dependencies/keep").is_file());
    assert!(ws.join(&unknown).join("node/dependencies/keep").is_file());
    assert_eq!(
        fs::read_to_string(source.join("keep.txt")).unwrap(),
        "source data"
    );
    assert_eq!(
        Runtime::open_lazy(&data).unwrap().store.runs().unwrap(),
        vec![live]
    );
}
