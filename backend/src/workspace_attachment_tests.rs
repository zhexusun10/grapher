use super::super::{dispatch, Service};
use crate::{
    attachment_inputs,
    cleanup::Target,
    model::{Config, Execution, Graph, NodeState},
    runtime::Runtime,
};
use std::{
    fs,
    path::Path,
    sync::{atomic::AtomicBool, Arc, Mutex},
};
use uuid::Uuid;

const UPLOAD: &str = "write_workspace_attachment";
const DELETE: &str = "delete_workspace_attachment";

fn service_with_root(root: &Path) -> Arc<Service> {
    Arc::new(Service {
        runtime: Mutex::new(Runtime::open(root).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), std::sync::Condvar::new()),
        planning: AtomicBool::new(false),
        extension: root.join("unused.ts"),
    })
}

fn init_repo(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join("original.txt"), "tracked original\n").unwrap();
    for args in [
        &["init"][..],
        &["config", "user.email", "test@example.com"],
        &["config", "user.name", "Test"],
        &["add", "."],
        &["commit", "-m", "init"],
    ] {
        let status = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {:?} failed", args);
    }
}

fn seed_run(service: &Arc<Service>, repo: &Path, worktree: &Path) -> String {
    let run_id = Uuid::new_v4().to_string();
    let mut runtime = service.runtime.lock().unwrap();
    runtime.state.run_id = run_id.clone();
    runtime.state.phase = "running".into();
    runtime.state.config = Some(
        serde_json::from_value(serde_json::json!({
            "repository": repo,
            "model": "test/model",
            "maxParallel": 1,
        }))
        .unwrap(),
    );
    runtime.state.nodes.insert(
        "worker".into(),
        NodeState {
            status: "completed".into(),
            ..Default::default()
        },
    );
    runtime.state.executions.push(Execution {
        id: Uuid::new_v4().to_string(),
        node: "worker".into(),
        revision: 1,
        attempt: 1,
        session_id: Uuid::new_v4().to_string(),
        worktree: worktree.to_string_lossy().into(),
        before: "HEAD".into(),
        workspace_lineage: Default::default(),
        after: Some("HEAD".into()),
        input: None,
        result: None,
        status: "completed".into(),
        output: String::new(),
        output_bytes: 0,
        pid: None,
        started_at: 0,
        completed_at: Some(1),
        metrics: None,
    });
    runtime.state.mergers.push(Execution {
        id: Uuid::new_v4().to_string(),
        node: "merge:worker".into(),
        revision: 1,
        attempt: 1,
        session_id: Uuid::new_v4().to_string(),
        worktree: worktree.to_string_lossy().into(),
        before: "HEAD".into(),
        workspace_lineage: Default::default(),
        after: None,
        input: None,
        result: None,
        status: "running".into(),
        output: String::new(),
        output_bytes: 0,
        pid: None,
        started_at: 0,
        completed_at: None,
        metrics: None,
    });
    run_id
}

fn upload_body(
    repo: &Path,
    run_id: Option<&str>,
    node: Option<&str>,
    content: &str,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "repository": repo.to_string_lossy(),
        "filename": "original.txt",
        "content": content,
    });
    if let Some(run_id) = run_id {
        body["runId"] = run_id.into();
    }
    if let Some(node) = node {
        body["node"] = node.into();
    }
    body
}

#[test]
fn malformed_attachment_content_fails_before_any_files_are_created() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let repo = temp.path().join("repo");
    let worktree = temp.path().join("worktree");
    fs::create_dir_all(&repo).unwrap();
    fs::create_dir_all(&worktree).unwrap();
    let service = service_with_root(&root);
    let run_id = seed_run(&service, &repo, &worktree);

    for bad in [
        "!!!not-base64!!!",
        "data:text/plain,not-base64",
        "data:text/plain;base64,@@@",
    ] {
        for (run, node) in [(None, None), (Some(run_id.as_str()), Some("worker"))] {
            let err = dispatch(&service, UPLOAD, upload_body(&repo, run, node, bad)).unwrap_err();
            assert!(err.contains("Invalid base64"), "unexpected error: {err}");
        }
    }
    assert!(!root.join(attachment_inputs::BUCKET).exists());
    assert!(!repo.join("grapher-attachments").exists());
    assert!(!worktree.join("grapher-attachments").exists());
}

#[test]
fn raw_and_data_url_uploads_store_externally_and_support_idempotent_retries() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let repo = temp.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    fs::write(repo.join("original.txt"), "project file").unwrap();
    let service = service_with_root(&root);

    for content in [
        "aGVsbG8gd29ybGQ=",
        "data:text/plain;charset=utf-8;base64,aGVsbG8gd29ybGQ=",
    ] {
        let attachment_id = Uuid::new_v4().to_string();
        let mut body = upload_body(&repo, None, None, content);
        body["attachmentId"] = attachment_id.clone().into();
        let uploaded = dispatch(&service, UPLOAD, body.clone()).unwrap();
        let retried = dispatch(&service, UPLOAD, body.clone()).unwrap();
        assert_eq!(retried, uploaded);
        assert_eq!(uploaded["external"], true);
        let stored_path = uploaded["path"].as_str().unwrap();
        assert!(stored_path.contains(&format!("/attachment-inputs/{attachment_id}/original.txt")));
        assert_eq!(fs::read(stored_path).unwrap(), b"hello world");

        // Same attachmentId with different bytes must be rejected.
        let mut mutated = body;
        mutated["content"] = "ZGlmZmVyZW50".into();
        assert!(dispatch(&service, UPLOAD, mutated)
            .unwrap_err()
            .contains("contents changed"));
    }

    // Repository remains completely untouched.
    assert!(!repo.join("grapher-attachments").exists());
    assert_eq!(fs::read_to_string(repo.join("original.txt")).unwrap(), "project file");
}

#[test]
fn run_scoped_uploads_work_for_planner_node_and_merger_even_during_publication_without_touching_workspaces()
{
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let repo = temp.path().join("repo");
    let worktree = temp.path().join("worktree");
    fs::create_dir_all(&repo).unwrap();
    fs::create_dir_all(&worktree).unwrap();
    let service = service_with_root(&root);
    let run_id = seed_run(&service, &repo, &worktree);
    service.runtime.lock().unwrap().state.phase = "publishing".into();

    for node in [None, Some("worker"), Some("merge:worker")] {
        let uploaded = dispatch(
            &service,
            UPLOAD,
            upload_body(&repo, Some(&run_id), node, "Ynl0ZXM="),
        )
        .unwrap();
        let path = uploaded["path"].as_str().unwrap();
        assert!(path.contains(&format!("/attachment-inputs/{run_id}/")));
        assert_eq!(fs::read(path).unwrap(), b"bytes");
    }

    // Neither the source repo nor the private worktree received any file.
    assert!(fs::read_dir(&repo).unwrap().next().is_none());
    assert!(fs::read_dir(&worktree).unwrap().next().is_none());

    // Cleanup targets recorded the run's attachment bucket.
    let owned = service
        .runtime
        .lock()
        .unwrap()
        .store
        .owned_cleanup_targets(&run_id)
        .unwrap();
    assert!(owned.contains(&Target::data(attachment_inputs::BUCKET, &run_id)));
}

#[test]
fn scoped_validation_and_deletion_reject_invalid_targets_and_arbitrary_paths() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let repo = temp.path().join("repo");
    let other_repo = temp.path().join("other-repo");
    let worktree = temp.path().join("worktree");
    for dir in [&repo, &other_repo, &worktree] {
        fs::create_dir_all(dir).unwrap();
    }
    fs::write(repo.join("keep.txt"), "keep").unwrap();
    let service = service_with_root(&root);
    let run_id = seed_run(&service, &repo, &worktree);

    // Node without runId is rejected.
    assert!(dispatch(&service, UPLOAD, upload_body(&repo, None, Some("worker"), "YWI=")).is_err());
    // Wrong runId or mismatched repo is rejected.
    assert!(dispatch(
        &service,
        UPLOAD,
        upload_body(&repo, Some(&Uuid::new_v4().to_string()), None, "YWI=")
    )
    .is_err());
    assert!(dispatch(
        &service,
        UPLOAD,
        upload_body(&other_repo, Some(&run_id), None, "YWI=")
    )
    .is_err());
    // Missing node is rejected.
    assert!(dispatch(
        &service,
        UPLOAD,
        upload_body(&repo, Some(&run_id), Some("ghost"), "YWI=")
    )
    .is_err());

    // Upload a real run-scoped attachment and verify deletion safety.
    let uploaded = dispatch(
        &service,
        UPLOAD,
        upload_body(&repo, Some(&run_id), Some("worker"), "YWI="),
    )
    .unwrap();
    let path = uploaded["path"].as_str().unwrap().to_string();

    // Cannot delete project files, wrong-scope paths, or lookalike external paths.
    let spoof = temp
        .path()
        .join("elsewhere/attachment-inputs")
        .join(&run_id)
        .join(Uuid::new_v4().to_string())
        .join("keep.txt");
    fs::create_dir_all(spoof.parent().unwrap()).unwrap();
    fs::write(&spoof, "do not delete").unwrap();
    for bad in [
        "keep.txt".to_string(),
        repo.join("keep.txt").to_string_lossy().into_owned(),
        spoof.to_string_lossy().into_owned(),
    ] {
        assert!(dispatch(
            &service,
            DELETE,
            serde_json::json!({
                "repository": repo,
                "runId": run_id,
                "node": "worker",
                "filename": bad,
            })
        )
        .is_err());
    }
    assert!(spoof.is_file());
    assert!(repo.join("keep.txt").is_file());

    // Deleting without runId cannot delete a run-scoped attachment.
    assert!(dispatch(
        &service,
        DELETE,
        serde_json::json!({
            "repository": repo,
            "filename": path,
        })
    )
    .is_err());
    assert!(Path::new(&path).is_file());

    // Relative attachment paths are rejected; only the returned managed absolute path is accepted.
    let suffix = path.rsplit_once("/attachment-inputs/").unwrap().1;
    assert!(dispatch(
        &service,
        DELETE,
        serde_json::json!({
            "repository": repo,
            "runId": run_id,
            "node": "worker",
            "filename": format!("attachment-inputs/{suffix}"),
        })
    )
    .is_err());
    assert!(Path::new(&path).is_file());

    // Deleting with matching runId removes the file and its empty UUID directory.
    let removed = dispatch(
        &service,
        DELETE,
        serde_json::json!({
            "repository": repo,
            "runId": run_id,
            "node": "worker",
            "filename": path,
        }),
    )
    .unwrap();
    assert_eq!(removed["success"], true);
    assert!(!Path::new(&path).exists());
    assert!(!Path::new(&path).parent().unwrap().exists());
}

#[test]
fn pre_run_attachments_are_adopted_into_new_runs_exposed_read_only_and_isolated_from_other_runs() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let repo = temp.path().join("repo");
    init_repo(&repo);

    // Pre-run landing-page attachment (no Run ID yet).
    let pre_id = Uuid::new_v4().to_string();
    let pre_path = attachment_inputs::store(&root, None, &pre_id, "spec.md", b"# Spec").unwrap();
    let pre_display = attachment_inputs::display_path(&pre_path);

    // Another Run's attachment must never be adopted by mentioning its path.
    let other_run = Uuid::new_v4().to_string();
    let other_id = Uuid::new_v4().to_string();
    let other_path =
        attachment_inputs::store(&root, Some(&other_run), &other_id, "secret.txt", b"secret")
            .unwrap();
    let other_display = attachment_inputs::display_path(&other_path);

    let mut runtime = Runtime::open(&root).unwrap();
    let graph: Graph = serde_json::from_value(serde_json::json!({
        "originalGoal": format!("Implement @{pre_display} and ignore @{other_display}"),
        "nodes": [{
            "id": "task",
            "task": format!("Read @{pre_display}"),
        }],
        "edges": [],
    }))
    .unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repo,
        "model": "test/model",
        "maxParallel": 1,
    }))
    .unwrap();
    runtime.create(graph, config).unwrap();
    let run_id = runtime.state.run_id.clone();

    let owned = runtime.store.owned_cleanup_targets(&run_id).unwrap();
    assert!(owned.contains(&Target::data(attachment_inputs::BUCKET, &pre_id)));
    assert!(!owned.contains(&Target::data(attachment_inputs::BUCKET, &other_run)));
    assert!(!owned.contains(&Target::data(attachment_inputs::BUCKET, &other_id)));

    let ro_dirs =
        attachment_inputs::read_only_directories_for_run(&root, &run_id, Some(&runtime.store))
            .unwrap();
    let canonical_run_dir =
        attachment_inputs::ensure_run_directory(&root, &run_id).unwrap();
    let canonical_pre_dir = pre_path.parent().unwrap().to_path_buf();
    assert!(ro_dirs.contains(&canonical_run_dir));
    assert!(ro_dirs.contains(&canonical_pre_dir));
    assert!(!ro_dirs.iter().any(|dir| dir.starts_with(other_path.parent().unwrap().parent().unwrap())));

    // Run deletion manifest includes both the run's attachment dir and the adopted pre-run dir.
    let manifest = crate::cleanup::manifest(&root, &runtime.store, &runtime.state, true).unwrap();
    assert!(manifest
        .targets
        .contains(&Target::data(attachment_inputs::BUCKET, &run_id)));
    assert!(manifest
        .targets
        .contains(&Target::data(attachment_inputs::BUCKET, &pre_id)));

    // If a second Run also adopts the same pre-run attachment (e.g. retry after a
    // failed first planning attempt), deleting the first Run keeps the file alive.
    let graph2: Graph = serde_json::from_value(serde_json::json!({
        "originalGoal": format!("Retry @{pre_display}"),
        "nodes": [{ "id": "task", "task": format!("Read @{pre_display}") }],
        "edges": [],
    }))
    .unwrap();
    let config2: Config = serde_json::from_value(serde_json::json!({
        "repository": repo,
        "model": "test/model",
        "maxParallel": 1,
    }))
    .unwrap();
    runtime.create(graph2, config2).unwrap();
    assert!(runtime
        .store
        .cleanup_target_is_shared(&run_id, &Target::data(attachment_inputs::BUCKET, &pre_id))
        .unwrap());
}

#[test]
fn serial_initial_route_delivers_images_to_first_job_and_survives_replay() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let repo = temp.path().join("repo");
    init_repo(&repo);

    let image = crate::model::ImageAttachment {
        r#type: "image".into(),
        mime_type: "image/png".into(),
        data: "iVBORw0KGgo=".into(),
        name: Some("screen.png".into()),
    };
    let mut runtime = Runtime::open(&root).unwrap();
    let graph: Graph = serde_json::from_value(serde_json::json!({
        "originalGoal": "Explain this screenshot",
        "nodes": [{ "id": "task", "task": "Explain this screenshot" }],
        "edges": [],
    }))
    .unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repo,
        "model": "test/model",
        "maxParallel": 1,
    }))
    .unwrap();
    runtime.create(graph, config).unwrap();
    runtime
        .set_route_with_images("serial", Some(vec![image.clone()]))
        .unwrap();
    runtime.approve().unwrap();
    let run_id = runtime.state.run_id.clone();

    // Replay from SQLite before dispatch must retain the initial images.
    drop(runtime);
    let mut replayed = Runtime::open(&root).unwrap().open_run(&run_id).unwrap();
    replayed.resume_scheduling().unwrap();
    assert_eq!(
        serde_json::to_value(&replayed.state.nodes["task"].instruction_images).unwrap(),
        serde_json::to_value(&Some(vec![image.clone()])).unwrap(),
    );
    let jobs = replayed.jobs().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(
        serde_json::to_value(&jobs[0].images).unwrap(),
        serde_json::to_value(&Some(vec![image])).unwrap(),
    );
    assert!(!repo.join("grapher-attachments").exists());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_sandbox_grants_read_only_access_to_run_attachments_including_live_steers() {
    if !crate::sandbox::supported() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path();
    let repo = base.join("source");
    let worktree_root = base.join("worktrees");
    let current = worktree_root.join("run/node");
    let data = base.join("data");
    let session = data.join("sessions/exec-1");
    let engine = base.join("engine");
    let installation = base.join("installation");
    for dir in [&repo, &current, &session, &engine, &installation] {
        fs::create_dir_all(dir).unwrap();
    }
    fs::write(data.join("events.sqlite"), "private-db").unwrap();

    let run_id = Uuid::new_v4().to_string();
    let other_run = Uuid::new_v4().to_string();
    let initial_id = Uuid::new_v4().to_string();
    let initial_file =
        attachment_inputs::store(&data, Some(&run_id), &initial_id, "input.txt", b"initial-data")
            .unwrap();
    let other_file = attachment_inputs::store(
        &data,
        Some(&other_run),
        &Uuid::new_v4().to_string(),
        "secret.txt",
        b"other-run-secret",
    )
    .unwrap();
    let run_attach_dir = attachment_inputs::ensure_run_directory(&data, &run_id).unwrap();

    // Generate the profile BEFORE a live-steer attachment exists.
    let profile = session.join("attachments.sb");
    crate::sandbox::write_execution_profile_scoped(
        &profile,
        &repo,
        &worktree_root,
        &current,
        &data,
        &session,
        &engine,
        &installation,
        &[],
        &[],
        &[run_attach_dir.clone()],
    )
    .unwrap();

    // Simulate a live-steer upload arriving AFTER the sandbox profile was written.
    let steer_id = Uuid::new_v4().to_string();
    let steer_file =
        attachment_inputs::store(&data, Some(&run_id), &steer_id, "steer.txt", b"live-steer")
            .unwrap();

    let output = std::process::Command::new("/usr/bin/sandbox-exec")
        .arg("-f")
        .arg(&profile)
        .args([
            "/bin/sh",
            "-c",
            r#"
set -e
test "$(cat "$1")" = "initial-data"
test "$(cat "$2")" = "live-steer"
if (echo bad >> "$1") 2>/dev/null; then exit 11; fi
if (echo bad > "$3/new.txt") 2>/dev/null; then exit 12; fi
if cat "$4" >/dev/null 2>&1; then exit 13; fi
if cat "$5" >/dev/null 2>&1; then exit 14; fi
"#,
            "probe",
        ])
        .arg(&initial_file)
        .arg(&steer_file)
        .arg(&run_attach_dir)
        .arg(&other_file)
        .arg(data.join("events.sqlite"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "sandbox attachment check failed (code {:?}): {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fs::read(&initial_file).unwrap(), b"initial-data");
    assert!(!run_attach_dir.join("new.txt").exists());
}

#[test]
fn prune_orphaned_unscoped_removes_only_stale_unowned_directories() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    init_repo(&repo);
    let root = temp.path().join("data");
    let mut runtime = Runtime::open(&root).unwrap();

    let stale_unowned_id = Uuid::new_v4().to_string();
    let stale_unowned_file =
        attachment_inputs::store(&root, None, &stale_unowned_id, "orphan.txt", b"orphan").unwrap();
    let adopted_id = Uuid::new_v4().to_string();
    let adopted_file =
        attachment_inputs::store(&root, None, &adopted_id, "spec.md", b"# Spec").unwrap();
    let adopted_display = attachment_inputs::display_path(&adopted_file);

    let graph: Graph = serde_json::from_value(serde_json::json!({
        "originalGoal": format!("@{adopted_display} implement"),
        "nodes": [{ "id": "task", "task": "implement" }],
        "edges": [],
    }))
    .unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repo,
        "model": "test/model",
        "maxParallel": 1,
    }))
    .unwrap();
    runtime.create(graph, config).unwrap();
    let run_id = runtime.state.run_id.clone();

    let run_scoped_id = Uuid::new_v4().to_string();
    let run_scoped_file = attachment_inputs::store(
        &root,
        Some(&run_id),
        &run_scoped_id,
        "live.txt",
        b"live",
    )
    .unwrap();

    // Fresh unowned attachments within max_age must survive.
    let removed_none = attachment_inputs::prune_orphaned_unscoped(
        &root,
        &runtime.store,
        std::time::Duration::from_secs(3600),
    )
    .unwrap();
    assert_eq!(removed_none, 0);
    assert!(stale_unowned_file.is_file());

    // With max_age = 0, only the unowned unscoped directory is reclaimed;
    // adopted pre-run and run-scoped directories remain intact.
    let removed = attachment_inputs::prune_orphaned_unscoped(
        &root,
        &runtime.store,
        std::time::Duration::ZERO,
    )
    .unwrap();
    assert_eq!(removed, 1);
    assert!(!stale_unowned_file.exists());
    assert!(!root.join(attachment_inputs::BUCKET).join(&stale_unowned_id).exists());
    assert!(adopted_file.is_file());
    assert!(run_scoped_file.is_file());
}

#[test]
fn snapshot_metadata_strips_duplicate_node_images_while_preserving_routed_event_images() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    init_repo(&repo);
    let root = temp.path().join("data");
    let mut runtime = Runtime::open(&root).unwrap();
    let graph: Graph = serde_json::from_value(serde_json::json!({
        "originalGoal": "Inspect image",
        "nodes": [{ "id": "task", "task": "Inspect image" }],
        "edges": [],
    }))
    .unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repo,
        "model": "test/model",
        "maxParallel": 1,
    }))
    .unwrap();
    runtime.create(graph, config).unwrap();
    let image = crate::model::ImageAttachment {
        r#type: "image".into(),
        mime_type: "image/png".into(),
        data: "iVBORw0KGgo=".into(),
        name: Some("ui.png".into()),
    };
    runtime
        .set_route_with_images("serial", Some(vec![image]))
        .unwrap();

    let view = crate::snapshot_view::snapshot_metadata(&runtime.state).unwrap();
    assert!(
        view["nodes"]["task"].get("instructionImages").is_none(),
        "node state must not duplicate base64 images already carried on events"
    );
    let routed = view["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["type"] == "routed")
        .unwrap();
    assert_eq!(routed["images"][0]["data"], "iVBORw0KGgo=");
}

#[test]
fn graph_planner_images_persist_under_run_attachments_and_support_session_branch_matching() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data with space");
    let run_id = Uuid::new_v4().to_string();
    let images = vec![
        crate::model::ImageAttachment {
            r#type: "image".into(),
            mime_type: "image/jpeg".into(),
            data: "aGVsbG8=".into(),
            name: Some("retina.png".into()),
        },
        crate::model::ImageAttachment {
            r#type: "image".into(),
            mime_type: "image/png".into(),
            data: "d29ybGQ=".into(),
            name: None,
        },
    ];

    let stored = attachment_inputs::store_run_images(&root, &run_id, &images).unwrap();
    assert_eq!(stored.len(), 2);
    assert_eq!(stored[0].file_name().unwrap().to_str().unwrap(), "retina.jpg");
    assert_eq!(stored[1].file_name().unwrap().to_str().unwrap(), "image-2.png");
    assert_eq!(fs::read(&stored[0]).unwrap(), b"hello");
    assert_eq!(fs::read(&stored[1]).unwrap(), b"world");

    let prompt = attachment_inputs::prepend_mentions(&stored, "Implement this layout");
    assert!(prompt.starts_with("@\""));
    assert!(prompt.ends_with(" Implement this layout"));
    assert_eq!(
        attachment_inputs::strip_leading_managed_mentions(&prompt),
        "Implement this layout"
    );
    assert_eq!(
        attachment_inputs::strip_leading_managed_mentions("@src/App.tsx keep this"),
        "@src/App.tsx keep this"
    );

    // Editing a Planner turn whose transport text received backend-injected
    // `@<image_path>` mentions must still match the clean user text.
    let session_dir = temp.path().join("planner-session");
    fs::create_dir_all(&session_dir).unwrap();
    let session_id = Uuid::new_v4().to_string();
    let cwd = temp.path().join("repo");
    fs::create_dir_all(&cwd).unwrap();
    let session_file = session_dir.join(format!("grapher_{session_id}.jsonl"));
    let followup_prompt = format!(
        "You are now at nodeA's workspace.\nCurrent graph node status:\n- nodeA: completed\n{}",
        attachment_inputs::prepend_mentions(&stored, "Refine spacing")
    );
    let lines = [
        serde_json::json!({
            "type": "session",
            "version": 3,
            "grapherFormat": 1,
            "id": session_id,
            "cwd": cwd.to_string_lossy(),
        }),
        serde_json::json!({
            "type": "message",
            "id": "u1",
            "parentId": null,
            "message": { "role": "user", "content": prompt },
        }),
        serde_json::json!({
            "type": "message",
            "id": "a1",
            "parentId": "u1",
            "message": { "role": "assistant", "content": [{ "type": "text", "text": "Planned" }] },
        }),
        serde_json::json!({
            "type": "message",
            "id": "u2",
            "parentId": "a1",
            "message": { "role": "user", "content": followup_prompt },
        }),
    ];
    fs::write(
        &session_file,
        lines
            .iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();

    // Follow-up turn with context header + injected `@<image_path>` matches clean user text.
    let followup_branch = crate::session_branch::branch_before_planner_user(
        &session_dir,
        &session_id,
        &cwd,
        "Refine spacing",
    )
    .unwrap();
    assert!(!followup_branch.first_user_turn);

    // Initial turn with injected `@<image_path>` also matches clean user text.
    let initial_branch = crate::session_branch::branch_before_planner_user(
        &session_dir,
        &session_id,
        &cwd,
        "Implement this layout",
    )
    .unwrap();
    assert!(initial_branch.first_user_turn);
}
