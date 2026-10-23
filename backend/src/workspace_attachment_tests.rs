use super::super::{api_service, collect_files_from_dir, dispatch, service_for_run, Service};
use super::*;
use crate::model::{Config, EventKind, Execution, Graph, Node, PlanningSummary};
use std::sync::{atomic::AtomicBool, Condvar, Mutex};

const UPLOAD: &str = "write_workspace_attachment";
const DELETE: &str = "delete_workspace_attachment";

fn service(runtime: Runtime) -> Arc<Service> {
    Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: PathBuf::from("unused.ts"),
    })
}

fn run(primary: &Arc<Service>, repo: &std::path::Path) -> (Arc<Service>, String) {
    fs::create_dir_all(repo).unwrap();
    let id = Uuid::new_v4().to_string();
    let child = service_for_run(primary, &id, true).unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repo, "model": "test/model", "maxParallel": 1,
    }))
    .unwrap();
    child
        .runtime
        .lock()
        .unwrap()
        .emit(EventKind::Created {
            graph: Graph {
                original_goal: "attachments".into(),
                nodes: vec![Node {
                    name: "worker".into(),
                    task: "work".into(),
                }],
                edges: vec![],
            },
            config,
            planning_id: None,
            planning: None,
        })
        .unwrap();
    (child, id)
}

fn execution(worktree: &std::path::Path, node: &str) -> Execution {
    fs::create_dir_all(worktree).unwrap();
    Execution {
        id: Uuid::new_v4().to_string(),
        node: node.into(),
        revision: 0,
        attempt: 1,
        session_id: Uuid::new_v4().to_string(),
        worktree: worktree.to_string_lossy().into(),
        before: String::new(),
        workspace_lineage: vec![node.into()],
        after: None,
        input: None,
        result: None,
        status: "running".into(),
        output: String::new(),
        output_bytes: 0,
        pid: None,
        started_at: 1,
        completed_at: None,
        metrics: None,
    }
}

fn start(child: &Arc<Service>, worktree: &std::path::Path) -> String {
    let execution = execution(worktree, "worker");
    let id = execution.id.clone();
    child
        .runtime
        .lock()
        .unwrap()
        .emit(EventKind::Started {
            execution,
            message_sequences: Some(vec![]),
            fresh_restart: false,
        })
        .unwrap();
    id
}

fn upload(repo: &std::path::Path, id: &str, node: Option<&str>) -> serde_json::Value {
    serde_json::json!({ "repository": repo, "runId": id, "node": node,
        "filename": "original.txt", "content": "aGVsbG8=" })
}

fn request(
    primary: &Arc<Service>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let selected = api_service(primary, command, &body)?;
    dispatch(&selected, command, body)
}

fn completed(
    primary: &Arc<Service>,
    repo: &std::path::Path,
) -> (Arc<Service>, String, crate::runtime::Job, String) {
    let (child, id) = run(primary, repo);
    fs::write(repo.join("base.txt"), "original").unwrap();
    crate::workspace::git(repo, &["init", "-q"]).unwrap();
    crate::workspace::git(repo, &["add", "-A"]).unwrap();
    crate::workspace::git(repo, &["commit", "-qm", "fixture"]).unwrap();
    let first = {
        let mut runtime = child.runtime.lock().unwrap();
        runtime.set_route("graph").unwrap();
        runtime.approve().unwrap();
        runtime.jobs().unwrap().remove(0)
    };
    let path = std::path::Path::new(&first.execution.worktree);
    crate::workspace::prepare(repo, path, &first.execution.before, &[]).unwrap();
    let head = crate::workspace::snapshot_node_for_run(path, repo, "worker", Some(&id)).unwrap();
    {
        let mut runtime = child.runtime.lock().unwrap();
        runtime
            .emit(EventKind::Prepared {
                execution_id: first.execution.id.clone(),
                head: first.execution.before.clone(),
            })
            .unwrap();
        runtime
            .emit(EventKind::Finished {
                execution_id: first.execution.id.clone(),
                head: head.clone(),
                output: "finished".into(),
                output_bytes: 0,
                metrics: None,
            })
            .unwrap();
    }
    (child, id, first, head)
}

#[cfg(feature = "fixture")]
fn followup(child: &Arc<Service>, path: &str) -> crate::runtime::Job {
    let mut runtime = child.runtime.lock().unwrap();
    runtime
        .intervene("worker", &format!("Read @{path}"))
        .unwrap();
    if runtime.state.paused {
        runtime.pause(false).unwrap();
    }
    runtime.jobs().unwrap().remove(0)
}

#[cfg(feature = "fixture")]
fn perform(child: &Arc<Service>, job: &crate::runtime::Job) -> Result<(String, String), String> {
    let root = child.runtime.lock().unwrap().root.clone();
    let script = root.join("attachment-fixture.mjs");
    fs::write(&script, r#"import fs from 'node:fs';
let task = ''; for await (const bytes of process.stdin) task += bytes;
let path = task.match(/grapher-attachments\/[0-9a-f-]+\/original\.txt/)?.[0];
if (!path) {
  const input = fs.readdirSync('grapher-attachments', {recursive:true}).find(name => name.endsWith('original.txt'));
  if (input) path = 'grapher-attachments/' + input;
}
if (!path) throw Error('No accepted attachment was delivered: ' + task);
const input = fs.readFileSync(path, 'utf8');
fs.writeFileSync('agent-observed.txt', input);
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Consumed ' + input}]}}));
"#).unwrap();
    let mut local = job.clone();
    local.config.pi_command = crate::native::trusted_node()
        .unwrap()
        .to_string_lossy()
        .into();
    local.config.pi_args = vec![script.to_string_lossy().into()];
    crate::runtime::perform_with_merger(
        &local,
        &root,
        &[],
        |_| {},
        |head| {
            child.runtime.lock().unwrap().emit(EventKind::Prepared {
                execution_id: job.execution.id.clone(),
                head,
            })
        },
        |event| child.runtime.lock().unwrap().emit(event),
    )
}

#[test]
fn uploads_are_staged_per_run_and_delivered_only_to_their_owning_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (first, first_id) = run(&primary, &repo);
    let (second, second_id) = run(&primary, &repo);
    let first_tree = temp.path().join("first");
    let second_tree = temp.path().join("second");
    start(&first, &first_tree);
    start(&second, &second_tree);
    for tree in [&repo, &first_tree, &second_tree] {
        fs::write(tree.join("original.txt"), "unsaved original").unwrap();
    }
    let root = primary.runtime.lock().unwrap().root.clone();
    for (id, tree, other) in [
        (&first_id, &first_tree, &second_tree),
        (&second_id, &second_tree, &first_tree),
    ] {
        let body = upload(&repo, id, Some("worker"));
        let result = request(&primary, UPLOAD, body.clone()).unwrap();
        let path = result["path"].as_str().unwrap();
        // A private workspace is never edited at upload time.
        assert_eq!(result["staged"], true);
        assert!(!tree.join(path).exists());
        assert!(!other.join(path).exists());
        assert!(!repo.join(path).exists());
        // Delivery resolves the owning Run's scope only.
        crate::attachment_inputs::deliver(&root, id, "worker", &format!("Read @{path}"), tree)
            .unwrap();
        assert_eq!(fs::read_to_string(tree.join(path)).unwrap(), "hello");
        assert!(!other.join(path).exists());
        assert!(!repo.join(path).exists());
        let mut delete = body;
        delete["filename"] = path.into();
        request(&primary, DELETE, delete).unwrap();
    }
    for tree in [&repo, &first_tree, &second_tree] {
        assert_eq!(
            fs::read_to_string(tree.join("original.txt")).unwrap(),
            "unsaved original"
        );
    }
}

#[test]
fn legacy_commands_are_rejected_without_writing_or_deleting_project_basenames() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    fs::write(repo.join("original.txt"), "unsaved original").unwrap();
    for command in ["write_workspace_file", "delete_workspace_file"] {
        assert!(dispatch(
            &primary,
            command,
            serde_json::json!({
                "repository": repo, "filename": "original.txt", "content": "aGVsbG8=",
            })
        )
        .unwrap_err()
        .contains("Unknown command"));
    }
    assert_eq!(
        fs::read_to_string(repo.join("original.txt")).unwrap(),
        "unsaved original"
    );
    assert!(!repo.join(ATTACHMENTS).exists());
}

#[test]
fn staged_upload_retries_are_idempotent_and_reject_changed_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (child, id) = run(&primary, &repo);
    let first = temp.path().join("first");
    start(&child, &first);
    let mut body = upload(&repo, &id, Some("worker"));
    body["attachmentId"] = Uuid::new_v4().to_string().into();
    let initial = request(&primary, UPLOAD, body.clone()).unwrap();
    assert_eq!(initial["staged"], true);
    assert_eq!(initial, request(&primary, UPLOAD, body.clone()).unwrap());
    let mut changed = body.clone();
    changed["content"] = "Y2hhbmdlZA==".into();
    assert!(request(&primary, UPLOAD, changed).is_err());
    let root = child.runtime.lock().unwrap().root.clone();
    let path = initial["path"].as_str().unwrap();
    crate::attachment_inputs::deliver(&root, &id, "worker", &format!("Read @{path}"), &first)
        .unwrap();
    assert_eq!(fs::read_to_string(first.join(path)).unwrap(), "hello");
    assert!(!repo.join(ATTACHMENTS).exists());
}

#[test]
fn missing_mismatched_or_unwritable_targets_fail_without_source_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (child, id) = run(&primary, &repo);
    let tree = temp.path().join("node");
    let mut body = upload(&repo, &id, Some("worker"));
    // A node without any attempt has no conversation to address yet.
    assert!(request(&primary, UPLOAD, body.clone()).is_err());
    start(&child, &tree);
    body["node"] = "unknown".into();
    assert!(request(&primary, UPLOAD, body.clone()).is_err());
    body["node"] = "worker".into();
    body["repository"] = temp.path().to_string_lossy().as_ref().into();
    assert!(request(&primary, UPLOAD, body.clone()).is_err());
    body["repository"] = repo.to_string_lossy().as_ref().into();
    assert!(dispatch(&primary, UPLOAD, body.clone()).is_err());
    let mut stale = body.clone();
    stale["runId"] = Uuid::new_v4().to_string().into();
    assert!(request(&primary, UPLOAD, stale).is_err());
    // A private workspace is only written through delivery, never at upload, so
    // its state (even a missing directory) cannot affect the upload target.
    assert!(request(&primary, UPLOAD, body.clone()).is_ok());
    assert!(!repo.join(ATTACHMENTS).exists());
    // A direct source upload still requires a usable directory.
    let missing_repo = temp.path().join("missing-repo");
    assert!(dispatch(
        &primary,
        UPLOAD,
        serde_json::json!({ "repository": missing_repo, "filename": "a.txt", "content": "aGVsbG8=" })
    )
    .is_err());
}

#[cfg(feature = "fixture")]
#[test]
fn settled_node_upload_survives_reload_and_is_consumed_by_a_real_followup() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (_child, id, first, old_head) = completed(&primary, &repo);
    let path = std::path::Path::new(&first.execution.worktree);
    let body = upload(&repo, &id, Some("worker"));
    let uploaded = request(&primary, UPLOAD, body).unwrap();
    let relative = uploaded["path"].as_str().unwrap();
    assert_eq!(uploaded["staged"], true);
    assert!(
        !path.join(relative).exists(),
        "upload must not modify the completed project view"
    );
    crate::workspace_view::verify_result(path, &repo, &old_head).unwrap();
    let reopened = service(primary.runtime.lock().unwrap().open_run(&id).unwrap());
    assert_eq!(
        reopened.runtime.lock().unwrap().state.nodes["worker"]
            .head
            .as_deref(),
        Some(old_head.as_str())
    );
    let job = followup(&reopened, relative);
    let result = perform(&reopened, &job);
    assert!(
        result.is_ok(),
        "actual followup preparation failed: {result:?}"
    );
    assert_eq!(
        fs::read_to_string(std::path::Path::new(&job.execution.worktree).join(relative)).unwrap(),
        "hello"
    );
    reopened
        .runtime
        .lock()
        .unwrap()
        .finish(&job.execution, result)
        .unwrap();
    let state = reopened.runtime.lock().unwrap().store.load(&id).unwrap();
    assert_eq!(state.nodes["worker"].status, "completed");
    assert_eq!(
        state.executions[0].after.as_deref(),
        Some(old_head.as_str()),
        "old evidence stays immutable"
    );
    crate::workspace_view::verify_result(
        std::path::Path::new(&job.execution.worktree),
        &repo,
        state.nodes["worker"].head.as_deref().unwrap(),
    )
    .unwrap();
    assert!(!repo.join(relative).exists());
}

#[cfg(feature = "fixture")]
#[test]
fn staged_inputs_do_not_weaken_completed_view_validation() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (child, id, first, _) = completed(&primary, &repo);
    let uploaded = request(&primary, UPLOAD, upload(&repo, &id, Some("worker"))).unwrap();
    let relative = uploaded["path"].as_str().unwrap();
    fs::write(
        std::path::Path::new(&first.execution.worktree).join("base.txt"),
        "foreign modification",
    )
    .unwrap();
    let job = followup(&child, relative);
    assert!(perform(&child, &job)
        .unwrap_err()
        .contains("changed outside its recorded execution"));
    assert!(!std::path::Path::new(&job.execution.worktree)
        .join(relative)
        .exists());
}

#[cfg(feature = "fixture")]
#[test]
fn prepared_attachment_delivery_remains_retryable_after_failure_and_restart() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (child, id, _, _) = completed(&primary, &repo);
    let uploaded = request(&primary, UPLOAD, upload(&repo, &id, Some("worker"))).unwrap();
    let relative = uploaded["path"].as_str().unwrap();
    let job = followup(&child, relative);
    perform(&child, &job).unwrap();
    let attachment = std::path::Path::new(&job.execution.worktree).join(relative);
    fs::write(&attachment, "partial agent work").unwrap();
    child
        .runtime
        .lock()
        .unwrap()
        .finish(
            &job.execution,
            Err("application interrupted after preparation".into()),
        )
        .unwrap();
    let reopened = service(primary.runtime.lock().unwrap().open_run(&id).unwrap());
    let retry = followup(&reopened, relative);
    assert!(retry.preserved_workspace.is_some());
    let result = perform(&reopened, &retry);
    assert!(
        result.is_ok(),
        "prepared partial work must remain recoverable: {result:?}"
    );
    assert_eq!(
        fs::read_to_string(&attachment).unwrap(),
        "partial agent work"
    );
    reopened
        .runtime
        .lock()
        .unwrap()
        .finish(&retry.execution, result)
        .unwrap();
}

#[cfg(feature = "fixture")]
#[test]
fn interrupted_before_attachment_copy_recovers_without_resending_the_user_prompt() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (child, id, first, _) = completed(&primary, &repo);
    let root = child.runtime.lock().unwrap().root.clone();
    // This continuation has an existing Pi session, so Continue must not send
    // the user message again merely to reconstruct its filesystem inputs.
    let session = root.join("sessions").join(&first.execution.id);
    fs::create_dir_all(&session).unwrap();
    fs::write(
        session.join(format!("fixture_{}.jsonl", first.execution.session_id)),
        serde_json::to_vec(&serde_json::json!({ "type": "session", "version": 3,
            "id": first.execution.session_id, "cwd": first.execution.worktree }))
        .unwrap(),
    )
    .unwrap();
    let uploaded = request(&primary, UPLOAD, upload(&repo, &id, Some("worker"))).unwrap();
    let relative = uploaded["path"].as_str().unwrap();
    let job = followup(&child, relative);
    let result = crate::runtime::perform_with_merger(
        &job,
        &root,
        &[],
        |_| {},
        |head| {
            child.runtime.lock().unwrap().emit(EventKind::Prepared {
                execution_id: job.execution.id.clone(),
                head,
            })?;
            Err("interrupted immediately after Prepared".into())
        },
        |_| Ok(()),
    );
    assert!(result
        .as_ref()
        .unwrap_err()
        .contains("immediately after Prepared"));
    assert!(!std::path::Path::new(&job.execution.worktree)
        .join(relative)
        .exists());
    {
        let mut runtime = child.runtime.lock().unwrap();
        runtime.pause(true).unwrap();
        runtime.request_execution_stop(Some("worker")).unwrap();
        runtime.finish(&job.execution, result).unwrap();
    }
    let reopened = service(primary.runtime.lock().unwrap().open_run(&id).unwrap());
    let retry = {
        let mut runtime = reopened.runtime.lock().unwrap();
        runtime.pause(false).unwrap();
        runtime.jobs().unwrap().remove(0)
    };
    assert!(retry.continuation);
    assert!(
        retry.task.is_empty(),
        "continuity must not resend the user prompt"
    );
    assert!(retry.attachment_instructions.contains(relative));
    let result = perform(&reopened, &retry);
    assert!(
        result.is_ok(),
        "accepted inputs must recover before Pi continuity: {result:?}"
    );
    assert_eq!(
        fs::read_to_string(
            std::path::Path::new(&retry.execution.worktree).join("agent-observed.txt")
        )
        .unwrap(),
        "hello"
    );
    reopened
        .runtime
        .lock()
        .unwrap()
        .finish(&retry.execution, result)
        .unwrap();
}

#[test]
fn incomplete_delivery_is_not_confused_with_an_agents_preserved_partial_work() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (child, id, _, _) = completed(&primary, &repo);
    let uploaded = request(&primary, UPLOAD, upload(&repo, &id, Some("worker"))).unwrap();
    let relative = uploaded["path"].as_str().unwrap();
    let root = child.runtime.lock().unwrap().root.clone();
    let target = temp.path().join("prepared-target");
    let path = target.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "truncated upload").unwrap();
    let task = format!("Read @{relative}");
    assert!(
        crate::attachment_inputs::deliver(&root, &id, "worker", &task, &target)
            .unwrap_err()
            .contains("incomplete")
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "truncated upload");
    fs::write(&path, "hello").unwrap();
    crate::attachment_inputs::deliver(&root, &id, "worker", &task, &target).unwrap();
    fs::write(&path, "agent edited this input").unwrap();
    crate::attachment_inputs::deliver(&root, &id, "worker", &task, &target).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "agent edited this input"
    );
    fs::remove_file(&path).unwrap();
    crate::attachment_inputs::deliver_prepared(&root, &id, "worker", &task, &target, true).unwrap();
    assert!(
        !path.exists(),
        "recovery must preserve an agent's deletion too"
    );
    crate::attachment_inputs::deliver(&root, &id, "worker", &task, &target).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "hello",
        "a newly prepared input may be restored after recomposition"
    );
}

#[test]
fn staged_scope_isolation_integrity_rejected_uploads_and_owned_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (child, id, first, old_head) = completed(&primary, &repo);
    let mut body = upload(&repo, &id, Some("worker"));
    let input_id = Uuid::new_v4().to_string();
    body["attachmentId"] = input_id.clone().into();
    let uploaded = request(&primary, UPLOAD, body.clone()).unwrap();
    assert_eq!(uploaded, request(&primary, UPLOAD, body.clone()).unwrap());
    let mut changed = body.clone();
    changed["content"] = "Y2hhbmdlZA==".into();
    assert!(request(&primary, UPLOAD, changed).is_err());
    let relative = uploaded["path"].as_str().unwrap();
    let root = child.runtime.lock().unwrap().root.clone();
    let alternate = temp.path().join("alternate");
    fs::create_dir(&alternate).unwrap();
    crate::attachment_inputs::deliver(
        &root,
        &id,
        "other-node",
        &format!("Read @{relative}"),
        &alternate,
    )
    .unwrap();
    crate::attachment_inputs::deliver(
        &root,
        &Uuid::new_v4().to_string(),
        "worker",
        &format!("Read @{relative}"),
        &alternate,
    )
    .unwrap();
    crate::attachment_inputs::deliver(
        &root,
        &id,
        "worker",
        "This job accepted no attachment",
        &alternate,
    )
    .unwrap();
    assert!(!alternate.join(ATTACHMENTS).exists());
    let content = root
        .join(crate::attachment_inputs::BUCKET)
        .join(&id)
        .join(
            git2::Oid::hash_object(git2::ObjectType::Blob, b"worker")
                .unwrap()
                .to_string(),
        )
        .join(&input_id)
        .join("content");
    fs::write(&content, "damaged input").unwrap();
    assert!(crate::attachment_inputs::deliver(
        &root,
        &id,
        "worker",
        &format!("Read @{relative}"),
        &alternate
    )
    .unwrap_err()
    .contains("damaged"));
    crate::workspace_view::verify_result(
        std::path::Path::new(&first.execution.worktree),
        &repo,
        &old_head,
    )
    .unwrap();
    child.runtime.lock().unwrap().delete_run(&id).unwrap();
    assert!(!root
        .join(crate::attachment_inputs::BUCKET)
        .join(&id)
        .exists());
    assert_eq!(
        fs::read_to_string(repo.join("base.txt")).unwrap(),
        "original"
    );
}

#[test]
fn deleting_pending_staged_input_leaves_the_completed_view_untouched() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (child, id, first, old_head) = completed(&primary, &repo);
    let mut body = upload(&repo, &id, Some("worker"));
    let uploaded = request(&primary, UPLOAD, body.clone()).unwrap();
    body["filename"] = uploaded["path"].clone();
    request(&primary, DELETE, body.clone()).unwrap();
    request(&primary, DELETE, body).unwrap();
    crate::workspace_view::verify_result(
        std::path::Path::new(&first.execution.worktree),
        &repo,
        &old_head,
    )
    .unwrap();
    assert_eq!(
        child.runtime.lock().unwrap().state.nodes["worker"].status,
        "completed"
    );
}

#[test]
fn planner_and_merger_attachments_are_staged_for_their_scope_and_delivered_on_use() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (child, id) = run(&primary, &repo);
    let planner = temp.path().join("planner");
    fs::create_dir(&planner).unwrap();
    child.runtime.lock().unwrap().state.planning = Some(PlanningSummary {
        worktree: Some(planner.to_string_lossy().into()),
        status: Some("running".into()),
        ..Default::default()
    });
    let root = child.runtime.lock().unwrap().root.clone();
    // A completed Planner upload must not edit the borrowed node view.
    let result = request(&primary, UPLOAD, upload(&repo, &id, None)).unwrap();
    let relative = result["path"].as_str().unwrap();
    assert_eq!(result["staged"], true);
    assert!(!planner.join(relative).exists());
    crate::attachment_inputs::deliver(
        &root,
        &id,
        "planner",
        &format!("Read @{relative}"),
        &planner,
    )
    .unwrap();
    assert!(planner.join(relative).is_file());
    let merger = temp.path().join("merger");
    child
        .runtime
        .lock()
        .unwrap()
        .emit(EventKind::MergerStarted {
            execution: execution(&merger, "merge:worker"),
        })
        .unwrap();
    let result = request(&primary, UPLOAD, upload(&repo, &id, Some("merge:worker"))).unwrap();
    let relative = result["path"].as_str().unwrap();
    assert_eq!(result["staged"], true);
    assert!(!merger.join(relative).exists());
    crate::attachment_inputs::deliver(
        &root,
        &id,
        "merge:worker",
        &format!("Read @{relative}"),
        &merger,
    )
    .unwrap();
    assert!(merger.join(relative).is_file());
    assert!(!repo.join(ATTACHMENTS).exists());
}

#[test]
fn post_publication_node_followups_upload_to_source_not_the_old_slot() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (child, id) = run(&primary, &repo);
    let tree = temp.path().join("old-slot");
    start(&child, &tree);
    {
        let mut runtime = child.runtime.lock().unwrap();
        runtime.state.phase = "completed".into();
        runtime.state.nodes.get_mut("worker").unwrap().status = "completed".into();
        runtime.state.executions.last_mut().unwrap().status = "completed".into();
    }
    let result = request(&primary, UPLOAD, upload(&repo, &id, Some("worker"))).unwrap();
    let path = result["path"].as_str().unwrap();
    assert_eq!(result["staged"], false);
    assert!(repo.join(path).is_file());
    assert!(!tree.join(path).exists());
}

#[test]
fn linked_attachment_directories_cannot_escape_the_selected_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let id = Uuid::new_v4().to_string();
    fs::create_dir(outside.join(&id)).unwrap();
    fs::write(outside.join(&id).join("original.txt"), "must survive").unwrap();
    crate::path_safety::directory_link(&outside, &repo.join(ATTACHMENTS));
    assert!(dispatch(
        &primary,
        UPLOAD,
        serde_json::json!({ "repository": repo, "filename": "original.txt", "content": "aGVsbG8=" })
    )
    .is_err());
    assert!(dispatch(&primary, DELETE, serde_json::json!({ "repository": repo, "filename": format!("{ATTACHMENTS}/{id}/original.txt") })).is_err());
    assert_eq!(
        fs::read_to_string(outside.join(&id).join("original.txt")).unwrap(),
        "must survive"
    );
    crate::path_safety::remove_directory_link(&repo.join(ATTACHMENTS));
}

#[test]
fn planner_upload_does_not_mutate_a_completed_node_view_before_acceptance() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (_child, id, first, head) = completed(&primary, &repo);
    // The Planner borrows the latest node workspace, so this upload resolves to
    // a sealed project view even though no Planner turn has been accepted yet.
    let result = request(&primary, UPLOAD, upload(&repo, &id, None)).unwrap();
    assert_eq!(result["staged"], true);
    crate::workspace_view::verify_result(
        std::path::Path::new(&first.execution.worktree),
        &repo,
        &head,
    )
    .unwrap();
}

#[cfg(feature = "fixture")]
#[test]
fn upload_during_the_sealed_window_does_not_corrupt_the_recorded_result() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (child, id, _, _) = completed(&primary, &repo);
    let next = followup(&child, "nothing attached yet");
    let path = std::path::Path::new(&next.execution.worktree);
    // A worker seals its result before Runtime::finish records `Finished`, so
    // `running` alone must never authorize an in-place write.
    let sealed = crate::workspace::snapshot_node_for_run(path, &repo, "worker", Some(&id)).unwrap();
    let uploaded = request(&primary, UPLOAD, upload(&repo, &id, Some("worker"))).unwrap();
    assert_eq!(uploaded["staged"], true);
    child
        .runtime
        .lock()
        .unwrap()
        .emit(EventKind::Finished {
            execution_id: next.execution.id,
            head: sealed.clone(),
            output: "finished".into(),
            output_bytes: 0,
            metrics: None,
        })
        .unwrap();
    crate::workspace_view::verify_result(path, &repo, &sealed).unwrap();
}

#[test]
fn recovery_preserves_deletion_of_the_whole_attachment_directory() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    fs::create_dir(&root).unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let run = Uuid::new_v4().to_string();
    let id = Uuid::new_v4().to_string();
    crate::attachment_inputs::stage(&root, &run, "worker", &id, "input.txt", b"hello").unwrap();
    let task = format!("Read @grapher-attachments/{id}/input.txt");
    crate::attachment_inputs::deliver_prepared(&root, &run, "worker", &task, &workspace, false)
        .unwrap();
    assert!(workspace.join(ATTACHMENTS).is_dir());
    fs::remove_dir_all(workspace.join(ATTACHMENTS)).unwrap();
    crate::attachment_inputs::deliver_prepared(&root, &run, "worker", &task, &workspace, true)
        .unwrap();
    assert!(
        !workspace.join(ATTACHMENTS).exists(),
        "recovery resurrected a directory the agent deleted"
    );
}

#[cfg(feature = "fixture")]
#[test]
fn initial_recovery_keeps_every_claimed_attachment_reference_in_a_batch() {
    let temp = tempfile::tempdir().unwrap();
    let primary = service(Runtime::open(&temp.path().join("runtime")).unwrap());
    let repo = temp.path().join("repo");
    let (child, id) = run(&primary, &repo);
    fs::write(repo.join("base.txt"), "base").unwrap();
    crate::workspace::git(&repo, &["init", "-q"]).unwrap();
    crate::workspace::git(&repo, &["add", "-A"]).unwrap();
    crate::workspace::git(&repo, &["commit", "-qm", "fixture"]).unwrap();
    let initial = {
        let mut runtime = child.runtime.lock().unwrap();
        runtime.set_route("graph").unwrap();
        runtime.approve().unwrap();
        runtime.jobs().unwrap().remove(0)
    };
    crate::workspace::prepare(
        &repo,
        std::path::Path::new(&initial.execution.worktree),
        &initial.execution.before,
        &[],
    )
    .unwrap();
    {
        let mut runtime = child.runtime.lock().unwrap();
        runtime
            .emit(EventKind::Prepared {
                execution_id: initial.execution.id.clone(),
                head: initial.execution.before.clone(),
            })
            .unwrap();
        runtime
            .finish(
                &initial.execution,
                Err("extension failed before Pi created its session".into()),
            )
            .unwrap();
        runtime.pause(true).unwrap();
    }
    let first = request(&primary, UPLOAD, upload(&repo, &id, Some("worker"))).unwrap();
    let second = request(&primary, UPLOAD, upload(&repo, &id, Some("worker"))).unwrap();
    let first_path = first["path"].as_str().unwrap().to_string();
    let second_path = second["path"].as_str().unwrap().to_string();
    assert_ne!(first_path, second_path);
    let batch = {
        let mut runtime = child.runtime.lock().unwrap();
        runtime
            .intervene("worker", &format!("First @{first_path}"))
            .unwrap();
        runtime
            .intervene("worker", &format!("Second @{second_path}"))
            .unwrap();
        runtime.pause(false).unwrap();
        runtime.jobs().unwrap().remove(0)
    };
    assert!(batch.attachment_instructions.contains(&first_path));
    assert!(batch.attachment_instructions.contains(&second_path));
    let root = child.runtime.lock().unwrap().root.clone();
    let result = crate::runtime::perform_with_merger(
        &batch,
        &root,
        &[],
        |_| {},
        |head| {
            child.runtime.lock().unwrap().emit(EventKind::Prepared {
                execution_id: batch.execution.id.clone(),
                head,
            })?;
            Err("interrupted after Prepared, before input delivery".into())
        },
        |_| Ok(()),
    );
    assert!(result
        .as_ref()
        .unwrap_err()
        .contains("before input delivery"));
    {
        let mut runtime = child.runtime.lock().unwrap();
        runtime.pause(true).unwrap();
        runtime.request_execution_stop(Some("worker")).unwrap();
        runtime.finish(&batch.execution, result).unwrap();
    }
    let reopened = service(primary.runtime.lock().unwrap().open_run(&id).unwrap());
    let retry = {
        let mut runtime = reopened.runtime.lock().unwrap();
        runtime.pause(false).unwrap();
        runtime.jobs().unwrap().remove(0)
    };
    assert!(retry.initial_recovery);
    assert!(
        retry.attachment_instructions.contains(&first_path)
            && retry.attachment_instructions.contains(&second_path),
        "recovery dropped a claimed batch input: {:?}",
        retry.attachment_instructions
    );
}

#[test]
fn git_completions_preserve_unicode_whitespace_and_special_filenames() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path();
    crate::workspace::git(repo, &["init", "-q"]).unwrap();
    crate::workspace::git(repo, &["config", "core.quotePath", "true"]).unwrap();
    let names = [
        "中文说明.txt",
        "résumé.md",
        "with spaces.txt",
        " leading.txt",
        #[cfg(unix)]
        "trailing ",
        #[cfg(unix)]
        "line\nbreak.txt",
        #[cfg(unix)]
        "quote\".txt",
        #[cfg(unix)]
        "slash\\.txt",
    ];
    for name in &names {
        fs::write(repo.join(name), "fixture").unwrap();
    }
    crate::workspace::git(repo, &["add", "--", "中文说明.txt"]).unwrap();
    let files = collect_files_from_dir(repo);
    for name in names {
        assert!(
            files.iter().any(|file| file == name),
            "missing {name:?}: {files:?}"
        );
    }
}
