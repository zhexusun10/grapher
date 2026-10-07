use super::*;

fn graph(names: &[&str]) -> Graph {
    Graph { original_goal: "workspace feedback".into(),
        nodes: names.iter().map(|name| Node { name: (*name).into(), task: (*name).into() }).collect(),
        edges: names.iter().filter(|name| **name != "owner").map(|name| Edge {
            from: "owner".into(), to: (*name).into(), feedback: false,
        }).chain(names.iter().filter(|name| name.starts_with("review")).map(|name| Edge {
            from: (*name).into(), to: "owner".into(), feedback: true,
        })).collect() }
}

fn configured(names: &[&str], limit: usize) -> (TempDir, PathBuf, Runtime) {
    let (temp, source, mut runtime) = setup(true, graph(names));
    fs::write(source.join(".gitignore"), ".cache/\n").unwrap();
    fs::create_dir(source.join(".cache")).unwrap();
    fs::write(source.join(".cache/source"), "source cache").unwrap();
    let script = temp.path().join("agent.sh");
    fs::write(&script, r#"cat >/dev/null
mkdir -p .cache
case "$GRAPHER_NODE_NAME" in
  owner)
    if [ -f reports/audit.json ]; then
      test "$(cat .cache/review)" = evidence || exit 17
      echo fixed > owner.txt
      echo fixed > .cache/owner
    else
      echo initial > owner.txt
      echo initial > .cache/owner
    fi ;;
  review*)
    test -f .cache/source && test -f .cache/owner || exit 18
    mkdir -p reports
    echo evidence > reports/audit.json
    echo evidence > .cache/review
    if grep -q fixed owner.txt; then verdict=ACCEPT; else verdict=FEEDBACK; fi
    printf '%s\n' "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Read reports/audit.json.\\n<$verdict>\"}]}}"
    exit 0 ;;
  related)
    test -f .cache/owner || exit 19
    cp owner.txt observed.txt
    echo related > .cache/related ;;
esac
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Completed"}]}}'
"#).unwrap();
    let config = runtime.state.config.as_mut().unwrap();
    config.engine = "pi".into();
    config.pi_command = "/bin/sh".into();
    config.pi_args = vec![script.to_string_lossy().into()];
    config.max_parallel = 4;
    config.max_feedback = limit;
    runtime.edit_draft_graph(graph(names), runtime.state.config.clone().unwrap()).unwrap();
    runtime.approve().unwrap();
    (temp, source, runtime)
}

fn execute(runtime: &mut Runtime, job: &Job) {
    let root = runtime.root.clone();
    let result = perform(job, &root, &[], |_| {}, |head| runtime.emit(EventKind::Prepared {
        execution_id: job.execution.id.clone(), head,
    }));
    if let Err(error) = &result { panic!("{} failed: {error}", job.execution.node); }
    runtime.finish(&job.execution, result).unwrap();
}

fn history(runtime: &Runtime, job: &Job, text: &str) {
    let directory = runtime.root.join("sessions").join(&job.execution.id);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(format!("test_{}.jsonl", job.execution.session_id)), format!("{}\n{}\n",
        serde_json::json!({"type":"session", "version":3, "id":job.execution.session_id, "cwd":job.execution.worktree}),
        serde_json::json!({"type":"message", "id":"user", "parentId":null, "message":{"role":"user", "content":text, "timestamp":job.execution.started_at}}))).unwrap();
}

#[cfg(feature = "fixture")]
#[test]
fn feedback_workspace_round_trip_preserves_evidence_cache_and_owner_history() {
    let (_temp, source, mut runtime) = configured(&["owner", "review", "related"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    history(&runtime, &owner, "OWNER PRIVATE HISTORY");
    let jobs = runtime.jobs().unwrap();
    let review = jobs.iter().find(|job| job.execution.node == "review").unwrap();
    let related = jobs.iter().find(|job| job.execution.node == "related").unwrap();
    execute(&mut runtime, review);
    history(&runtime, review, "REVIEW PRIVATE HISTORY");
    assert_eq!(runtime.state.pending_feedback.len(), 1);
    assert!(runtime.jobs().unwrap().is_empty(), "running related branch must drain");
    assert_eq!(runtime.state.nodes["owner"].status, "done");
    execute(&mut runtime, related);
    let repair = runtime.jobs().unwrap().remove(0);
    assert_eq!(repair.execution.node, "owner");
    assert_eq!(repair.execution.worktree, review.execution.worktree);
    assert!(repair.session_fork.is_some());
    assert_eq!(repair.task, "Feedback from review:\nRead reports/audit.json.");
    execute(&mut runtime, &repair);
    let directory = runtime.root.join("sessions").join(&repair.execution.id);
    let text = fs::read_to_string(directory.join(format!("grapher_{}.jsonl", repair.execution.session_id))).unwrap();
    assert!(text.contains("OWNER PRIVATE HISTORY"));
    assert!(!text.contains("REVIEW PRIVATE HISTORY"));
    let header: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert_eq!(header["cwd"], serde_json::json!(crate::native::host_path(Path::new(&review.execution.worktree))));
    assert_eq!(fs::read_to_string(Path::new(&owner.execution.worktree).join(".cache/owner")).unwrap().trim(), "fixed");
    let next = runtime.jobs().unwrap();
    assert_eq!(next.len(), 2);
    for job in &next {
        if job.execution.node == "related" {
            assert_ne!(job.execution.worktree, repair.execution.worktree);
        } else {
            assert_eq!(job.execution.worktree, repair.execution.worktree);
        }
        execute(&mut runtime, job);
        assert_eq!(fs::read_to_string(Path::new(&job.execution.worktree).join(".cache/owner")).unwrap().trim(), "fixed");
    }
    assert!(runtime.jobs().unwrap().is_empty());
    let publication = runtime.state.publication.clone().unwrap();
    crate::graph_merge::merge_graph(&source, &publication.heads, || Err("unexpected merge".into())).unwrap();
    runtime.publish_workspace_files(&source, &publication.heads).unwrap();
    assert_eq!(fs::read_to_string(source.join(".cache/review")).unwrap().trim(), "evidence");
    assert_eq!(fs::read_to_string(source.join(".cache/owner")).unwrap().trim(), "fixed");
    assert_eq!(fs::read_to_string(source.join("observed.txt")).unwrap().trim(), "fixed");
    assert!(!workspace::git(&source, &["ls-files"]).unwrap().contains(".cache"));
    assert_eq!(runtime.state.feedback_counts["review->owner"], 1);
}

#[cfg(feature = "fixture")]
#[test]
fn pending_feedback_survives_restart_and_replays_its_exact_output_range() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let review = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Output { execution_id: review.execution.id.clone(), text: "streamed 中文🚀 that must not be forwarded\n".into() }).unwrap();
    execute(&mut runtime, &review);
    let root = runtime.root.clone();
    assert_eq!(runtime.state.pending_feedback.len(), 1);
    drop(runtime);
    let mut recovered = Runtime::open(&root).unwrap();
    assert!(recovered.state.paused);
    assert_eq!(recovered.state.pending_feedback.len(), 1);
    recovered.pause(false).unwrap();
    let repair = recovered.jobs().unwrap().remove(0);
    assert_eq!(repair.execution.worktree, review.execution.worktree);
    assert_eq!(repair.task, "Feedback from review:\nRead reports/audit.json.");
    assert!(!repair.task.contains("streamed 中文"));
    assert!(!repair.task.contains("<FEEDBACK>"));
    assert!(recovered.state.pending_feedback.is_empty());
    let counts = recovered.state.feedback_counts.clone();
    recovered.apply_feedback("review", "Read reports/audit.json.\n<FEEDBACK>").unwrap();
    assert_eq!(recovered.state.feedback_counts, counts, "delivery must be idempotent");
}

#[cfg(feature = "fixture")]
#[test]
fn concurrent_old_generation_reviews_do_not_overwrite_the_first_handoff() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 3);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let reviews = runtime.jobs().unwrap();
    for review in &reviews { execute(&mut runtime, review); }
    let repair = runtime.jobs().unwrap().remove(0);
    assert_eq!(repair.execution.worktree, reviews[0].execution.worktree);
    assert_eq!(runtime.state.feedback_counts.len(), 1);
    assert!(runtime.state.events.iter().any(|event| matches!(&event.kind,
        EventKind::FeedbackResolved { execution_id, disposition } if execution_id == &reviews[1].execution.id && disposition == "superseded")));
    assert!(runtime.state.pending_feedback.is_empty());
}

#[cfg(feature = "fixture")]
#[test]
fn exhausted_feedback_does_not_transfer_a_workspace() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review"], 0);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let review = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &review);
    runtime.drain_feedback().unwrap();
    assert_eq!(runtime.state.nodes["owner"].status, "done");
    assert_eq!(runtime.state.nodes["owner"].head, runtime.state.nodes["review"].head);
    assert!(runtime.state.nodes["owner"].feedback_workspace.is_none());
    assert!(runtime.state.feedback_counts.is_empty());
    assert!(runtime.state.events.iter().any(|event| matches!(event.kind, EventKind::FeedbackExhausted { .. })));
}

#[test]
fn shared_terminal_workspace_ignored_followup_keeps_descendants_done() {
    let (temp, _source, mut runtime) = configured(&["owner", "related"], 0);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let related = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &related);
    let old_head = runtime.state.nodes["owner"].head.clone();
    let script = temp.path().join("agent.sh");
    fs::write(script, "cat >/dev/null\necho cache-only-change > .cache/owner\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    runtime.intervene("owner", "update the ignored cache only").unwrap();
    let update = runtime.jobs_with_publication(false).unwrap().remove(0);
    execute(&mut runtime, &update);
    assert_eq!(runtime.state.nodes["owner"].head, old_head, "Git code result did not change");
    assert_eq!(runtime.state.nodes["related"].status, "done", "a shared terminal workspace is updated in place");
    assert!(runtime.state.events.iter().any(|event| matches!(&event.kind,
        EventKind::WorkspaceFilesChanged { execution_id } if execution_id == &update.execution.id)));
}

#[test]
fn publication_uses_current_ignored_results_not_every_attempt_with_the_same_git_head() {
    let (temp, source, mut runtime) = configured(&["owner"], 0);
    let script = temp.path().join("agent.sh");
    fs::write(&script, "cat >/dev/null\necho first > .cache/owner\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &first);
    history(&runtime, &first, &first.task);
    runtime.edit_node_message("owner", &first.execution.id, &first.task, "rewrite ignored data", None).unwrap();
    fs::write(&script, "cat >/dev/null\necho edited > .cache/owner\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    let edited = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &edited);
    assert_eq!(runtime.state.executions[0].after, runtime.state.executions[1].after);
    let heads = vec![runtime.state.nodes["owner"].head.clone().unwrap()];
    runtime.validate_publication_files(&source, &heads).unwrap();
    runtime.publish_workspace_files(&source, &heads).unwrap();
    assert_eq!(fs::read_to_string(source.join(".cache/owner")).unwrap().trim(), "edited");
    fs::write(source.join(".cache/source"), "concurrent source cache").unwrap();
    let files = crate::workspace_files::Files::new(&runtime.root, &runtime.state.run_id).unwrap();
    let active = runtime.state.nodes["owner"].files_version.clone().unwrap();
    let workspace = Path::new(&edited.execution.worktree);
    fs::write(workspace.join(".cache/source"), "conflicting node cache").unwrap();
    let replacement = uuid::Uuid::new_v4().to_string();
    files.capture(workspace, &replacement, &heads[0], &[active]).unwrap();
    runtime.state.nodes.get_mut("owner").unwrap().files_version = Some(replacement);
    assert!(runtime.validate_publication_files(&source, &heads).unwrap_err().contains("conflicting ignored file .cache/source"));
    assert_eq!(fs::read_to_string(source.join(".cache/source")).unwrap(), "concurrent source cache");
}

#[test]
fn shared_terminal_workspace_retry_preserves_partial_ignored_work_without_rerunning_descendants() {
    let (temp, source, mut runtime) = configured(&["owner", "related"], 0);
    let script = temp.path().join("agent.sh");
    fs::write(&script, "cat >/dev/null\necho first > .cache/$GRAPHER_NODE_NAME\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let related = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &related);
    let head = runtime.state.nodes["owner"].head.clone().unwrap();
    let heads = vec![runtime.state.nodes["related"].head.clone().unwrap()];
    runtime.publish_workspace_files(&source, &heads).unwrap();
    runtime.emit(EventKind::PublicationCompleted { head: head.clone() }).unwrap();
    runtime.cleanup_worktrees().unwrap();
    runtime.intervene("owner", "change only the ignored result").unwrap();
    fs::write(&script, "cat >/dev/null\necho partial-update > .cache/owner\nexit 21\n").unwrap();
    let failed = runtime.jobs().unwrap().remove(0);
    let result = perform(&failed, &runtime.root, &[], |_| {}, |_| Ok(()));
    assert!(result.is_err());
    runtime.finish(&failed.execution, result).unwrap();
    runtime.intervene("owner", "finish without discarding partial ignored work").unwrap();
    fs::write(&script, "cat >/dev/null\n[ \"$(cat .cache/owner)\" = partial-update ] || exit 82\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.previous_file_version.as_deref(), Some(format!("before-{}", failed.execution.id).as_str()));
    execute(&mut runtime, &retry);
    assert_eq!(runtime.state.nodes["owner"].head.as_deref(), Some(head.as_str()));
    assert_eq!(runtime.state.nodes["related"].status, "done");
}

#[test]
fn missing_historical_ignored_snapshot_fails_before_mutating_the_conversation() {
    let (_temp, _source, mut runtime) = configured(&["owner"], 0);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    history(&runtime, &owner, &owner.task);
    let path = runtime.root.join("sessions").join(&owner.execution.id).join(format!("test_{}.jsonl", owner.execution.session_id));
    let bytes = fs::read(&path).unwrap();
    fs::remove_dir_all(workspace::workspaces_parent(&runtime.root).join(".grapher-worktrees").join(&runtime.state.run_id).join(".files")).unwrap();
    assert!(runtime.edit_node_message("owner", &owner.execution.id, &owner.task, "rewrite", None)
        .unwrap_err().contains("Historical ignored-file snapshot is unavailable"));
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn manually_resolved_ignored_fan_in_is_a_versioned_input() {
    let candidate = Graph { original_goal: "ignored conflict".into(),
        nodes: ["left", "right", "join"].iter().map(|name| Node { name: (*name).into(), task: (*name).into() }).collect(),
        edges: ["left", "right"].iter().map(|name| Edge { from: (*name).into(), to: "join".into(), feedback: false }).collect() };
    let (temp, source, mut runtime) = setup(true, candidate.clone());
    fs::write(source.join(".gitignore"), ".cache/\n").unwrap();
    let script = temp.path().join("agent.sh");
    fs::write(&script, "cat >/dev/null\nmkdir -p .cache\nif [ \"$GRAPHER_NODE_NAME\" != join ]; then echo \"$GRAPHER_NODE_NAME\" > .cache/shared; fi\necho done > \"$GRAPHER_NODE_NAME.txt\"\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    let config = runtime.state.config.as_mut().unwrap();
    config.pi_command = "/bin/sh".into();
    config.pi_args = vec![script.to_string_lossy().into()];
    runtime.edit_draft_graph(candidate, runtime.state.config.clone().unwrap()).unwrap();
    runtime.approve().unwrap();
    for job in runtime.jobs().unwrap() { execute(&mut runtime, &job); }
    let blocked = runtime.jobs().unwrap().remove(0);
    let result = perform(&blocked, &runtime.root, &[], |_| {}, |_| Ok(()));
    assert!(result.as_ref().unwrap_err().contains("conflicting ignored file .cache/shared"));
    runtime.finish(&blocked.execution, result).unwrap();
    assert_eq!(runtime.state.nodes["join"].status, "blocked");
    let path = Path::new(&blocked.execution.worktree);
    fs::create_dir_all(path.join(".cache")).unwrap();
    fs::write(path.join(".cache/shared"), "resolved").unwrap();
    runtime.pause(true).unwrap();
    runtime.resolved("join").unwrap();
    assert!(runtime.state.nodes["join"].files_override.is_some());
    runtime.pause(false).unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &retry);
    assert_eq!(fs::read_to_string(Path::new(&retry.execution.worktree).join(".cache/shared")).unwrap(), "resolved");
    assert_eq!(runtime.state.nodes["join"].status, "done");
}

#[test]
fn terminal_node_followup_uses_the_shared_workspace_and_preserves_its_conversation_history() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    history(&runtime, &owner, "OWNER HISTORY");
    let review = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &review);
    history(&runtime, &review, "REVIEW HISTORY");
    let repair = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &repair);
    runtime.intervene("review", "additional inspection").unwrap();
    let next = runtime.jobs().unwrap().remove(0);
    assert_eq!(next.execution.worktree, repair.execution.worktree);
    assert!(next.session_fork.is_none());
    execute(&mut runtime, &next);
    let text = fs::read_to_string(runtime.root.join("sessions").join(&review.execution.id)
        .join(format!("test_{}.jsonl", next.execution.session_id))).unwrap();
    assert!(text.contains("REVIEW HISTORY"));
    assert!(!text.contains("OWNER HISTORY"));
    assert_eq!(
        workspace::git(Path::new(&repair.execution.worktree), &["rev-parse", "HEAD"]).unwrap(),
        runtime.state.nodes["review"].head.clone().unwrap(),
    );
}

#[test]
fn failed_preparation_before_session_fork_retries_in_the_transferred_tree() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    history(&runtime, &owner, "OWNER HISTORY");
    let review = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &review);
    let repair = runtime.jobs().unwrap().remove(0);
    let result = perform(&repair, &runtime.root, &[], |_| {}, |_| Err("simulate interruption before session fork".into()));
    assert!(result.is_err());
    runtime.finish(&repair.execution, result).unwrap();
    runtime.intervene("owner", "retry the interrupted repair").unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.execution.worktree, review.execution.worktree);
    assert_eq!(retry.session_fork.as_ref().unwrap().id, owner.execution.id);
    assert_eq!(retry.previous_file_version.as_deref(), Some(format!("after-{}", review.execution.id).as_str()));
    execute(&mut runtime, &retry);
    assert_eq!(fs::read_to_string(Path::new(&retry.execution.worktree).join("owner.txt")).unwrap().trim(), "fixed");
}

#[test]
fn historical_edit_restores_ignored_files_from_before_the_original_execution() {
    let (temp, _source, mut runtime) = configured(&["owner", "review"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    history(&runtime, &owner, &owner.task);
    let review = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &review);
    let repair = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &repair);
    runtime.edit_node_message("owner", &owner.execution.id, &owner.task, "rewritten owner", None).unwrap();
    let script = temp.path().join("agent.sh");
    fs::write(script, "cat >/dev/null\n[ \"$(cat .cache/source)\" = \"source cache\" ] || exit 81\n[ ! -e .cache/owner ] || exit 82\n[ ! -e .cache/review ] || exit 83\n[ ! -e reports/audit.json ] || exit 84\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    let edited = runtime.jobs().unwrap().remove(0);
    assert_eq!(edited.previous_file_version.as_deref(), Some(format!("before-{}", owner.execution.id).as_str()));
    execute(&mut runtime, &edited);
    assert_eq!(runtime.state.nodes["owner"].status, "done");
    assert_eq!(runtime.state.nodes["review"].status, "dirty");
}

#[test]
fn feedback_completion_and_queue_rollback_together_on_database_failure() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let review = runtime.jobs().unwrap().remove(0);
    let result = perform(&review, &runtime.root, &[], |_| {}, |_| Ok(())).unwrap();
    let db = rusqlite::Connection::open(runtime.root.join("events.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_feedback BEFORE INSERT ON events WHEN NEW.kind='feedback_queued' BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
    assert!(runtime.finish(&review.execution, Ok(result)).is_err());
    assert_eq!(runtime.state.nodes["review"].status, "running");
    assert!(runtime.state.pending_feedback.is_empty());
    let replayed = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(replayed.nodes["review"].status, "running");
    assert!(replayed.pending_feedback.is_empty());
}

#[cfg(feature = "fixture")]
#[test]
fn modified_completed_review_files_block_the_handoff_before_execution() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let review = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &review);
    fs::write(Path::new(&review.execution.worktree).join(".cache/review"), "late mutation").unwrap();
    let repair = runtime.jobs().unwrap().remove(0);
    let result = perform(&repair, &runtime.root, &[], |_| {}, |_| panic!("must not start model"));
    assert!(result.unwrap_err().contains("changed after completion"));
    assert_eq!(fs::read_to_string(Path::new(&review.execution.worktree).join(".cache/review")).unwrap(), "late mutation");
}
