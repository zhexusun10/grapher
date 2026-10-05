use crate::{
    cleanup::{self, Manifest, Target},
    model::{Config, EventKind, Execution, Graph, Node},
    runtime::Runtime,
};
use std::{collections::BTreeSet, fs, path::PathBuf};
use uuid::Uuid;

fn setup() -> (tempfile::TempDir, PathBuf, Runtime) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("user.txt"), "keep user files").unwrap();
    crate::workspace::git(&source, &["init", "-q"]).unwrap();
    let config: Config = serde_json::from_value(
        serde_json::json!({"repository": source, "model":"test", "maxParallel":1}),
    )
    .unwrap();
    let mut runtime = Runtime::open(&temp.path().join("data")).unwrap();
    runtime.create(graph(), config).unwrap();
    (temp, source, runtime)
}

fn graph() -> Graph {
    Graph {
        original_goal: "cleanup".into(),
        nodes: vec![Node {
            name: "task".into(),
            task: "test".into(),
        }],
        edges: vec![],
    }
}

fn execution(runtime: &Runtime, id: &str) -> Execution {
    Execution {
        id: id.into(),
        node: "task".into(),
        revision: 1,
        attempt: 1,
        session_id: id.into(),
        worktree: runtime.state.config.as_ref().unwrap().repository.clone(),
        before: "base".into(),
        after: None,
        status: "running".into(),
        output: String::new(),
        output_bytes: 0,
        pid: None,
        started_at: crate::model::now(),
        completed_at: None,
        metrics: None,
    }
}

fn failed_execution(runtime: &mut Runtime, id: &str) {
    runtime
        .emit(EventKind::Started {
            execution: execution(runtime, id),
        })
        .unwrap();
    runtime
        .emit(EventKind::Failed {
            node: "task".into(),
            execution_id: Some(id.into()),
            error: "test".into(),
            output_bytes: 0,
            metrics: None,
        })
        .unwrap();
}

fn directory(path: &std::path::Path) {
    fs::create_dir_all(path.join("nested/dependencies")).unwrap();
    fs::write(path.join("nested/dependencies/file"), "owned").unwrap();
}

#[test]
fn deletion_removes_sessions_mergers_planning_and_planner_sessions_only_for_its_owner() {
    let (_temp, source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let node = Uuid::new_v4().to_string();
    let merger = Uuid::new_v4().to_string();
    failed_execution(&mut runtime, &node);
    runtime
        .emit(EventKind::MergerStarted {
            execution: execution(&runtime, &merger),
        })
        .unwrap();
    runtime
        .emit(EventKind::MergerFailed {
            execution_id: merger.clone(),
            error: "test".into(),
            output_bytes: 0,
            metrics: None,
        })
        .unwrap();
    runtime
        .emit(EventKind::PublicationFailed {
            error: "test".into(),
        })
        .unwrap();
    let mut owned = vec![
        runtime.root.join("sessions").join(&node),
        runtime.root.join("mergers").join(&merger),
        runtime.root.join("planner-sessions").join(&id),
    ];
    for key in ["runId", "revisionRunId"] {
        let planning = runtime
            .root
            .join("planning")
            .join(Uuid::new_v4().to_string());
        directory(&planning);
        fs::write(
            planning.join("request.json"),
            serde_json::json!({key: id}).to_string(),
        )
        .unwrap();
        owned.push(planning);
    }
    let unrelated = runtime
        .root
        .join("sessions")
        .join(Uuid::new_v4().to_string());
    for path in owned.iter().chain([&unrelated]) {
        directory(path);
    }
    runtime.delete_run(&id).unwrap();
    assert!(owned.iter().all(|path| !path.exists()));
    assert!(unrelated.join("nested/dependencies/file").is_file());
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "keep user files"
    );
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn shared_node_sessions_survive_until_their_last_run_is_deleted() {
    let (_temp, _source, mut runtime) = setup();
    let first = runtime.state.run_id.clone();
    let node = Uuid::new_v4().to_string();
    failed_execution(&mut runtime, &node);
    let session = runtime.root.join("sessions").join(&node);
    directory(&session);
    runtime
        .create(graph(), runtime.state.config.clone().unwrap())
        .unwrap();
    let second = runtime.state.run_id.clone();
    failed_execution(&mut runtime, &node);
    runtime.delete_run(&first).unwrap();
    assert!(session.is_dir());
    runtime.delete_run(&second).unwrap();
    assert!(!session.exists());
}

fn legacy_runtime(source: &std::path::Path, root: &std::path::Path) -> Runtime {
    let mut runtime = Runtime::open_lazy(root).unwrap();
    runtime.state.run_id = Uuid::new_v4().to_string();
    runtime
        .store
        .append(
            &mut runtime.state,
            EventKind::Created {
                graph: graph(),
                config: serde_json::from_value(
                    serde_json::json!({"repository":source,"model":"test","maxParallel":1}),
                )
                .unwrap(),
                planning_id: None,
                planning: None,
            },
        )
        .unwrap();
    assert!(runtime
        .store
        .owned_cleanup_targets(&runtime.state.run_id)
        .unwrap()
        .is_empty());
    runtime
}

#[test]
fn missing_legacy_source_cleans_all_owned_workspace_roots_on_delete_clear_and_reset() {
    for moved in [false, true] {
        for operation in ["delete", "clear", "reset"] {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("source");
            directory(&source);
            let mut runtime = legacy_runtime(&source, &temp.path().join("data"));
            let id = runtime.state.run_id.clone();
            let mut owned = Vec::new();
            let mut unrelated = Vec::new();
            for bucket in [".grapher-worktrees", ".grapher-workspaces"] {
                let path = temp.path().join(bucket).join(&id);
                let other = temp.path().join(bucket).join(Uuid::new_v4().to_string());
                directory(&path);
                directory(&other);
                owned.push(path);
                unrelated.push(other);
            }
            let moved_source = temp.path().join("moved-source");
            if moved {
                fs::rename(&source, &moved_source).unwrap();
            } else {
                fs::remove_dir_all(&source).unwrap();
            }
            match operation {
                "delete" => runtime.delete_run(&id).unwrap(),
                "clear" => runtime.clear_history().unwrap(),
                _ => {
                    runtime.reset_workspace().unwrap();
                }
            }
            assert!(
                owned.iter().all(|path| !path.exists()),
                "{operation}, moved={moved}"
            );
            assert!(unrelated
                .iter()
                .all(|path| path.join("nested/dependencies/file").is_file()));
            if moved {
                assert_eq!(
                    fs::read_to_string(moved_source.join("nested/dependencies/file")).unwrap(),
                    "owned"
                );
            }
            assert!(runtime.store.pending_cleanups().unwrap().is_empty());
        }
    }
}

#[test]
fn unresolved_legacy_cleanup_recovers_from_the_saved_parent_without_restoring_source() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("already-missing-source");
    let runtime = legacy_runtime(&source, &temp.path().join("data"));
    let id = runtime.state.run_id.clone();
    let root = runtime.root.clone();
    let owned: Vec<_> = [".grapher-worktrees", ".grapher-workspaces"]
        .iter()
        .map(|bucket| temp.path().join(bucket).join(&id))
        .collect();
    for path in &owned {
        directory(path);
    }
    runtime
        .store
        .delete_run_with_cleanup(
            &id,
            Some(&Manifest {
                unresolved_repository: Some(source.to_string_lossy().into_owned()),
                ..Default::default()
            }),
        )
        .unwrap();
    drop(runtime);
    let runtime = Runtime::open_lazy(&root).unwrap();
    runtime.retry_deleted_cleanups().unwrap();
    assert!(owned.iter().all(|path| !path.exists()));
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn missing_source_prefers_recorded_physical_parent_over_a_dangling_alias_parent() {
    let (temp, source, mut runtime) = setup();
    let alias_parent = temp.path().join("alias-parent");
    fs::create_dir(&alias_parent).unwrap();
    let alias = alias_parent.join("source-alias");
    crate::path_safety::directory_link(&source, &alias);
    runtime.state.config.as_mut().unwrap().repository = alias.to_string_lossy().into_owned();
    let id = runtime.state.run_id.clone();
    let actual = temp.path().join(".grapher-workspaces").join(&id);
    let decoy = alias_parent.join(".grapher-workspaces").join(&id);
    directory(&actual);
    directory(&decoy);
    fs::remove_dir_all(source).unwrap();
    runtime.delete_run(&id).unwrap();
    assert!(!actual.exists());
    assert!(decoy.join("nested/dependencies/file").is_file());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn missing_legacy_source_still_refuses_redirected_workspace_roots_before_deletion() {
    for bucket in [".grapher-worktrees", ".grapher-workspaces"] {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("already-missing-source");
        let mut runtime = legacy_runtime(&source, &temp.path().join("data"));
        let id = runtime.state.run_id.clone();
        let outside = temp.path().join("outside");
        directory(&outside.join(&id));
        crate::path_safety::directory_link(&outside, &temp.path().join(bucket));
        assert!(runtime.delete_run(&id).unwrap_err().contains("Refusing"));
        assert!(runtime.store.contains_run(&id).unwrap());
        assert!(outside.join(&id).join("nested/dependencies/file").is_file());
    }
}

#[test]
fn physical_workspace_ownership_survives_source_removal_and_restart() {
    let (temp, source, runtime) = setup();
    let id = runtime.state.run_id.clone();
    let root = runtime.root.clone();
    let workspace = temp.path().join(".grapher-worktrees").join(&id);
    directory(&workspace);
    fs::remove_dir_all(source).unwrap();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    runtime.delete_run(&id).unwrap();
    assert!(!workspace.exists());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn committed_deletion_keeps_cleanup_on_failure_and_retries_after_restart() {
    let (temp, _source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let root = runtime.root.clone();
    let session_id = Uuid::new_v4().to_string();
    let session = root.join("sessions").join(&session_id);
    directory(&session);
    let manifest = Manifest {
        targets: BTreeSet::from([Target::data("sessions", &session_id)]),
        ..Default::default()
    };
    runtime
        .store
        .delete_run_with_cleanup(&id, Some(&manifest))
        .unwrap();
    fs::remove_dir_all(&session).unwrap();
    let outside = temp.path().join("outside");
    directory(&outside);
    crate::path_safety::directory_link(&outside, &session);
    assert!(runtime.retry_cleanup(&id).unwrap_err().contains("Refusing"));
    let task = runtime.store.cleanup_task(&id).unwrap().unwrap();
    assert_eq!(task.attempts, 1);
    assert!(task.last_error.unwrap().contains("Refusing"));
    assert!(outside.join("nested/dependencies/file").is_file());
    let mut stale = runtime.state.clone();
    assert!(runtime
        .store
        .append(&mut stale, EventKind::Paused { paused: true })
        .unwrap_err()
        .contains("deleted"));
    assert!(runtime
        .store
        .append_batch(
            &mut stale,
            vec![EventKind::Output {
                execution_id: session_id,
                text: "late".into()
            }]
        )
        .unwrap_err()
        .contains("deleted"));
    fs::remove_dir(&session).unwrap();
    directory(&session);
    drop(runtime);
    let runtime = Runtime::open_lazy(&root).unwrap();
    runtime.retry_deleted_cleanups().unwrap();
    assert!(!session.exists());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn failed_completed_run_cleanup_is_durable_and_stale_generations_are_cancelled() {
    let (temp, _source, mut runtime) = setup();
    runtime
        .emit(EventKind::PublicationCompleted {
            head: "published".into(),
        })
        .unwrap();
    let id = runtime.state.run_id.clone();
    let workspace = temp.path().join(".grapher-worktrees").join(&id);
    directory(&workspace);
    let outside = temp.path().join("outside");
    directory(&outside);
    let root = temp.path().join(".grapher-workspaces");
    crate::path_safety::directory_link(&outside, &root);
    assert!(runtime.cleanup_worktrees().is_err());
    assert!(runtime
        .store
        .cleanup_task(&id)
        .unwrap()
        .unwrap()
        .last_error
        .is_some());
    assert!(workspace.is_dir());
    fs::remove_dir(&root).unwrap();
    runtime.retry_cleanup(&id).unwrap();
    assert!(!workspace.exists());
    assert!(runtime.store.completed_workspace_runs().unwrap().is_empty());
    directory(&workspace);
    let manifest = cleanup::manifest(&runtime.root, &runtime.store, &runtime.state, false).unwrap();
    runtime.store.enqueue_cleanup(&id, &manifest).unwrap();
    runtime.emit(EventKind::Paused { paused: true }).unwrap();
    runtime.retry_cleanup(&id).unwrap();
    assert!(
        workspace.is_dir(),
        "a follow-up invalidates old cleanup authorization"
    );
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn only_marked_unowned_idle_partitioners_are_disposable() {
    let (_temp, _source, runtime) = setup();
    let mut paths = Vec::new();
    for marked in [true, true, false] {
        let id = Uuid::new_v4().to_string();
        let path = runtime.root.join("partition-workers").join(&id);
        directory(&path);
        if marked {
            fs::write(
                path.join(".grapher-partition-worker.json"),
                r#"{"kind":"grapher-partition-worker","version":1}"#,
            )
            .unwrap();
        }
        paths.push((id, path));
    }
    runtime
        .store
        .remember_cleanup_targets(
            &runtime.state.run_id,
            &BTreeSet::from([Target::data("partition-workers", &paths[1].0)]),
        )
        .unwrap();
    let tasks = cleanup::idle_partitioners(&runtime.root, &runtime.store).unwrap();
    assert_eq!(tasks.len(), 1);
    runtime
        .store
        .delete_run_with_cleanup(&tasks[0].run_id, Some(&tasks[0].manifest))
        .unwrap();
    runtime.retry_deleted_cleanups().unwrap();
    assert!(!paths[0].1.exists());
    assert!(
        paths[1].1.is_dir(),
        "failed copy-back belongs to a recoverable Run"
    );
    assert!(
        paths[2].1.is_dir(),
        "old unmarked directories lack disposal proof"
    );
}

#[test]
fn forged_planner_marker_cannot_authorize_another_checkout() {
    let (temp, _source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let attempt = Uuid::new_v4().to_string();
    let outside = temp
        .path()
        .join(".grapher-workspaces")
        .join(Uuid::new_v4().to_string())
        .join(Uuid::new_v4().to_string());
    directory(&outside);
    let planning = runtime.root.join("planning").join(attempt);
    directory(&planning);
    fs::write(
        planning.join("request.json"),
        serde_json::json!({"runId":id}).to_string(),
    )
    .unwrap();
    fs::write(
        planning.join("planner-workspace"),
        outside.to_string_lossy().as_bytes(),
    )
    .unwrap();
    runtime.delete_run(&id).unwrap();
    assert!(!planning.exists());
    assert!(outside.join("nested/dependencies/file").is_file());
}

#[test]
fn deletion_and_cleanup_manifest_rollback_together_on_database_failure() {
    let (temp, _source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let workspace = temp.path().join(".grapher-worktrees").join(&id);
    directory(&workspace);
    let db = rusqlite::Connection::open(runtime.root.join("events.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER deny_deletion BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    assert!(runtime
        .delete_run(&id)
        .unwrap_err()
        .contains("test failure"));
    assert!(workspace.is_dir());
    assert!(runtime.store.contains_run(&id).unwrap());
    assert!(!runtime.store.run_was_deleted(&id).unwrap());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[cfg(windows)]
#[test]
fn locked_session_files_leave_retryable_cleanup_not_orphaned_ownership() {
    use std::os::windows::fs::OpenOptionsExt;
    let (_temp, _source, mut runtime) = setup();
    let id = runtime.state.run_id.clone();
    let node = Uuid::new_v4().to_string();
    failed_execution(&mut runtime, &node);
    let session = runtime.root.join("sessions").join(&node);
    directory(&session);
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(session.join("nested/dependencies/file"))
        .unwrap();
    runtime.delete_run(&id).unwrap();
    assert!(!runtime.store.contains_run(&id).unwrap());
    assert!(runtime
        .store
        .cleanup_task(&id)
        .unwrap()
        .unwrap()
        .last_error
        .is_some());
    drop(locked);
    runtime.retry_deleted_cleanups().unwrap();
    assert!(!session.exists());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}

#[test]
fn workspace_adopted_as_source_is_not_erased_even_after_all_history_is_cleared() {
    let (temp, _source, mut runtime) = setup();
    let original = runtime.state.run_id.clone();
    let workspace = temp.path().join(".grapher-worktrees").join(&original);
    let adopted = workspace.join("adopted-project");
    directory(&adopted);
    crate::workspace::git(&adopted, &["init", "-q"]).unwrap();
    let mut config = runtime.state.config.clone().unwrap();
    config.repository = adopted.to_string_lossy().into_owned();
    runtime.create(graph(), config).unwrap();
    runtime.clear_history().unwrap();
    assert!(adopted.join("nested/dependencies/file").is_file());
    assert!(runtime.store.pending_cleanups().unwrap().is_empty());
}
