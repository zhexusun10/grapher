use super::*;

#[cfg(feature = "fixture")]
#[path = "feedback_batch_tests.rs"]
mod batch;

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
    echo evidence > "reports/$GRAPHER_NODE_NAME.txt"
    echo evidence > .cache/review
    if grep -q fixed owner.txt || [ "$GRAPHER_NODE_NAME" = review_accept ]; then verdict=ACCEPT; else verdict=FEEDBACK; fi
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
    assert_eq!(runtime.state.nodes["owner"].status, "completed");
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
    assert_eq!(fs::read_to_string(Path::new(&repair.execution.worktree).join(".cache/owner")).unwrap().trim(), "fixed");
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
    assert_eq!(fs::read_to_string(source.join(".cache/source")).unwrap().trim(), "source cache");
    assert!(source.join(".cache/owner").is_file());
    assert!(source.join(".cache/review").is_file());
    assert!(workspace::repository_git(&source, &["ls-files"]).unwrap().contains(".cache/owner"));
    assert!(workspace::repository_git(&source, &["ls-files"]).unwrap().contains(".cache/review"));
    assert!(!workspace::git(&source, &["ls-files"]).unwrap().contains(".cache/owner"));
    assert!(!workspace::git(&source, &["ls-files"]).unwrap().contains(".cache/review"));
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
fn parallel_feedback_merges_only_feedback_senders_and_forks_owner_history() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two", "review_accept"], 3);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    history(&runtime, &owner, "OWNER PRIVATE HISTORY");
    let reviews = runtime.jobs().unwrap();
    assert_eq!(reviews.len(), 3);
    execute(&mut runtime, &reviews[0]);
    assert!(runtime.jobs().unwrap().is_empty(), "wait for already-running senders, not future ones");
    for review in &reviews[1..] { execute(&mut runtime, review); }
    for review in &reviews { history(&runtime, review, "REVIEW PRIVATE HISTORY"); }
    let repair = runtime.jobs().unwrap().remove(0);
    assert_eq!(repair.execution.node, "owner");
    assert!(reviews.iter().all(|review| review.execution.worktree != repair.execution.worktree));
    assert_eq!(repair.feedback_workspace.as_ref().unwrap().additional_sources.len(), 1);
    assert!(repair.task.contains("Feedback from review_one:\nRead reports/audit.json."));
    assert!(repair.task.contains("Feedback from review_two:\nRead reports/audit.json."));
    assert!(!repair.task.contains("Feedback from review_accept"));
    assert_eq!(runtime.state.feedback_counts.len(), 2);
    assert!(runtime.state.pending_feedback.is_empty());
    assert_eq!(runtime.state.events.iter().filter(|event| matches!(&event.kind,
        EventKind::Invalidated { target, human: false, .. } if target == "owner")).count(), 1);
    execute(&mut runtime, &repair);
    let path = Path::new(&repair.execution.worktree);
    assert!(path.join("reports/review_one.txt").is_file());
    assert!(path.join("reports/review_two.txt").is_file());
    assert!(!path.join("reports/review_accept.txt").exists());
    for review in reviews.iter().filter(|review| review.execution.node != "review_accept") {
        workspace::verify_prepared_ancestor(path, runtime.state.executions.iter()
            .find(|execution| execution.id == review.execution.id).unwrap().after.as_ref().unwrap()).unwrap();
    }
    let session = fs::read_to_string(runtime.root.join("sessions").join(&repair.execution.id)
        .join(format!("grapher_{}.jsonl", repair.execution.session_id))).unwrap();
    assert!(session.contains("OWNER PRIVATE HISTORY"));
    assert!(!session.contains("REVIEW PRIVATE HISTORY"));
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
    assert_eq!(runtime.state.nodes["owner"].status, "completed");
    assert_eq!(runtime.state.nodes["owner"].head, runtime.state.nodes["review"].head);
    assert!(runtime.state.nodes["owner"].feedback_workspace.is_none());
    assert!(runtime.state.feedback_counts.is_empty());
    assert!(runtime.state.events.iter().any(|event| matches!(event.kind, EventKind::FeedbackExhausted { .. })));
}

#[test]
fn shared_terminal_workspace_project_file_followup_keeps_descendants_completed() {
    let (temp, _source, mut runtime) = configured(&["owner", "related"], 0);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let related = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &related);
    let old_head = runtime.state.nodes["owner"].head.clone();
    let script = temp.path().join("agent.sh");
    fs::write(script, "cat >/dev/null\necho cache-only-change > .cache/owner\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    runtime.intervene("owner", "update the ordinary cache only").unwrap();
    let update = runtime.jobs_with_publication(false).unwrap().remove(0);
    execute(&mut runtime, &update);
    assert_ne!(runtime.state.nodes["owner"].head, old_head, "ordinary output changes the Git result");
    assert_eq!(runtime.state.nodes["related"].status, "completed", "a shared terminal workspace is updated in place");
    assert!(!runtime.state.events.iter().any(|event| matches!(&event.kind,
        EventKind::WorkspaceFilesChanged { execution_id } if execution_id == &update.execution.id)));
    assert_eq!(fs::read_to_string(Path::new(&update.execution.worktree).join(".cache/owner")).unwrap().trim(), "cache-only-change");
}

#[test]
fn publication_writes_ordinary_files_back_to_source_through_git() {
    let (temp, source, mut runtime) = configured(&["owner"], 0);
    let script = temp.path().join("agent.sh");
    fs::write(&script, "cat >/dev/null\necho first > .cache/owner\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &first);
    history(&runtime, &first, &first.task);
    runtime.edit_node_message("owner", &first.execution.id, &first.task, "rewrite ordinary data", None).unwrap();
    fs::write(&script, "cat >/dev/null\necho edited > .cache/owner\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    let edited = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &edited);
    assert_ne!(runtime.state.executions[0].after, runtime.state.executions[1].after);
    let heads = vec![runtime.state.nodes["owner"].head.clone().unwrap()];
    crate::graph_merge::merge_graph(&source, &heads, || Err("unexpected merge".into())).unwrap();
    assert_eq!(fs::read_to_string(source.join(".cache/owner")).unwrap().trim(), "edited");
    assert_eq!(fs::read_to_string(Path::new(&edited.execution.worktree).join(".cache/owner")).unwrap().trim(), "edited");
    fs::write(source.join(".cache/source"), "concurrent source cache").unwrap();
    assert_eq!(fs::read_to_string(source.join(".cache/source")).unwrap(), "concurrent source cache");
}

#[test]
fn post_publication_direct_edit_runs_in_source_and_failed_retry_uses_graph_worktree() {
    let (temp, source, mut runtime) = configured(&["owner", "related"], 0);
    let script = temp.path().join("agent.sh");
    fs::write(&script, "cat >/dev/null\necho first > .cache/$GRAPHER_NODE_NAME\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let related = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &related);
    let head = runtime.state.nodes["owner"].head.clone().unwrap();
    let heads = vec![runtime.state.nodes["related"].head.clone().unwrap()];
    crate::graph_merge::merge_graph(&source, &heads, || Err("unexpected merge".into())).unwrap();
    runtime.emit(EventKind::PublicationCompleted { head: head.clone() }).unwrap();
    runtime.cleanup_worktrees().unwrap();
    // A completed conversation edits the source directory directly.
    runtime.intervene("owner", "change only the ordinary result").unwrap();
    assert_eq!(runtime.state.phase, "followup");
    fs::write(&script, "cat >/dev/null\necho partial-update > .cache/owner\nexit 21\n").unwrap();
    let failed = runtime.jobs().unwrap().remove(0);
    assert!(failed.source_direct);
    assert_eq!(Path::new(&failed.execution.worktree), source.as_path());
    let result = perform(&failed, &runtime.root, &[], |_| {}, |_| Ok(()));
    assert!(result.is_err());
    runtime.finish(&failed.execution, result).unwrap();
    assert_eq!(
        fs::read_to_string(source.join(".cache/owner")).unwrap().trim(),
        "partial-update"
    );
    // A message while the Run is no longer `completed` keeps the existing graph
    // worktree semantics; it does not silently rebuild the shadow snapshot.
    runtime.intervene("owner", "finish without discarding partial ordinary work").unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(!retry.source_direct);
    assert_ne!(Path::new(&retry.execution.worktree), source.as_path());
}

#[test]
fn history_edit_does_not_depend_on_before_file_snapshots() {
    let (_temp, _source, mut runtime) = configured(&["owner"], 0);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    history(&runtime, &owner, &owner.task);
    let path = runtime.root.join("sessions").join(&owner.execution.id).join(format!("test_{}.jsonl", owner.execution.session_id));
    let bytes = fs::read(&path).unwrap();
    runtime.edit_node_message("owner", &owner.execution.id, &owner.task, "rewrite", None).unwrap();
    assert_ne!(fs::read(path).unwrap(), bytes);
}

#[test]
fn fan_in_tracked_file_conflict_invokes_git_merger() {
    let candidate = Graph { original_goal: "ordinary conflict".into(),
        nodes: ["left", "right", "join"].iter().map(|name| Node { name: (*name).into(), task: (*name).into() }).collect(),
        edges: ["left", "right"].iter().map(|name| Edge { from: (*name).into(), to: "join".into(), feedback: false }).collect() };
    let (temp, source, mut runtime) = setup(true, candidate.clone());
    fs::write(source.join(".gitignore"), ".cache/\n").unwrap();
    let script = temp.path().join("agent.sh");
    fs::write(&script, "cat >/dev/null\nmkdir -p .cache\nif [ \"$GRAPHER_NODE_NAME\" != join ]; then echo \"$GRAPHER_NODE_NAME\" > .cache/shared; fi\necho completed > \"$GRAPHER_NODE_NAME.txt\"\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    let config = runtime.state.config.as_mut().unwrap();
    config.pi_command = "/bin/sh".into();
    config.pi_args = vec![script.to_string_lossy().into()];
    runtime.edit_draft_graph(candidate, runtime.state.config.clone().unwrap()).unwrap();
    runtime.approve().unwrap();
    for job in runtime.jobs().unwrap() { execute(&mut runtime, &job); }
    let joined = runtime.jobs().unwrap().remove(0);
    let result = perform(&joined, &runtime.root, &[], |_| {}, |_| Ok(()));
    assert!(result.as_ref().unwrap_err().contains("Workspace composition blocked"));
    runtime.finish(&joined.execution, result).unwrap();
    assert_eq!(runtime.state.nodes["join"].status, "blocked");
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
    assert_eq!(fs::read_to_string(Path::new(&retry.execution.worktree).join("owner.txt")).unwrap().trim(), "initial");
    execute(&mut runtime, &retry);
    assert_eq!(fs::read_to_string(Path::new(&retry.execution.worktree).join("owner.txt")).unwrap().trim(), "fixed");
}

#[test]
fn historical_edit_does_not_restore_project_files_from_the_original_execution() {
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
    fs::write(script, "cat >/dev/null\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    // `Prepared` records the actual prepared head on the stored execution, so
    // compare the edit against that, not the original Job object.
    let owner_before = runtime.state.executions.iter().find(|e| e.id == owner.execution.id).unwrap().before.clone();
    let edited = runtime.jobs().unwrap().remove(0);
    assert_eq!(edited.execution.before, owner_before);
    execute(&mut runtime, &edited);
    assert_eq!(runtime.state.nodes["owner"].status, "completed");
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
fn modified_completed_workspace_blocks_feedback_handoff() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let review = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &review);
    fs::write(Path::new(&review.execution.worktree).join(".cache/review"), "late mutation").unwrap();
    let repair = runtime.jobs().unwrap().remove(0);
    let result = perform(&repair, &runtime.root, &[], |_| {}, |_| panic!("must not start model"));
    let error = result.unwrap_err();
    // A late mutation is refused either by the completed project-view check or
    // by the feedback handoff check; both are correct.
    assert!(
        error.contains("Feedback workspace changed after completion")
            || error.contains("changed outside its recorded execution"),
        "{error}"
    );
}

#[cfg(feature = "fixture")]
fn unrecorded_host_commit(original: &str) -> String {
    original.replace("      echo fixed > owner.txt", r#"      echo residue > residue.txt
      export GIT_DIR="../.grapher-git/$(printf %s "$(basename "$PWD")" | git hash-object --stdin | cut -c1-16).git" GIT_WORK_TREE="$PWD"
      git add -A
      git -c user.name=residue -c user.email=residue@invalid commit -qm residue
      exit 19"#)
}

#[cfg(feature = "fixture")]
#[test]
fn failed_feedback_repair_adopts_its_committed_residue_on_retry() {
    let (temp, _source, mut runtime) = configured(&["owner", "review"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let review = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &review);
    let repair = runtime.jobs().unwrap().remove(0);
    assert_eq!(repair.execution.node, "owner");
    assert_eq!(repair.execution.worktree, review.execution.worktree);
    let pin_head = repair.feedback_workspace.as_ref().unwrap().head.clone();
    // First repair attempt: commit residue, then fail without recording it.
    let script = temp.path().join("agent.sh");
    let original = fs::read_to_string(&script).unwrap();
    fs::write(&script, unrecorded_host_commit(&original)).unwrap();
    let root = runtime.root.clone();
    let result = perform(&repair, &root, &[], |_| {}, |head| runtime.emit(EventKind::Prepared {
        execution_id: repair.execution.id.clone(), head,
    }));
    assert!(result.is_err());
    runtime.finish(&repair.execution, result).unwrap();
    assert_eq!(runtime.state.nodes["owner"].status, "failed");
    // The residue advanced the worktree past the pinned head, clean but unrecorded.
    let worktree = Path::new(&repair.execution.worktree);
    let residue_head = workspace::git(worktree, &["rev-parse", "HEAD"]).unwrap();
    assert_ne!(residue_head, pin_head);
    // The retry adopts the residue as its base instead of refusing the handoff.
    fs::write(&script, original).unwrap();
    history(&runtime, &repair, "OWNER REPAIR HISTORY");
    runtime.intervene("owner", "Continue the failed repair").unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.session_fork.as_ref().is_some_and(|previous| {
        previous.status == "failed" && previous.worktree == repair.execution.worktree
    }));
    execute(&mut runtime, &retry);
    assert_eq!(runtime.state.nodes["owner"].status, "completed");
    let retry_execution = runtime.state.executions.iter().rev()
        .find(|execution| execution.id == retry.execution.id).unwrap();
    assert_eq!(retry_execution.before, residue_head);
    let final_head = retry_execution.after.clone().unwrap();
    assert!(workspace::git(worktree, &["merge-base", "--is-ancestor", &residue_head, &final_head]).is_ok());
    assert_eq!(fs::read_to_string(worktree.join("residue.txt")).unwrap().trim(), "residue");
    assert_eq!(fs::read_to_string(worktree.join("owner.txt")).unwrap().trim(), "fixed");
}

#[cfg(feature = "fixture")]
#[test]
fn adoption_survives_a_failed_attempt_without_a_persisted_session() {
    // Mirrors the production wedge: the failed attempt died before or without
    // persisting its Pi session, so the retry's resume falls back to the
    // original target session (completed) instead of the failed attempt.
    // Attribution must come from the run's execution history, not from the
    // forked session, or the workspace stays wedged.
    let (temp, _source, mut runtime) = configured(&["owner", "review"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let review = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &review);
    let repair = runtime.jobs().unwrap().remove(0);
    let pin_head = repair.feedback_workspace.as_ref().unwrap().head.clone();
    let script = temp.path().join("agent.sh");
    let original = fs::read_to_string(&script).unwrap();
    fs::write(&script, unrecorded_host_commit(&original)).unwrap();
    let root = runtime.root.clone();
    let result = perform(&repair, &root, &[], |_| {}, |head| runtime.emit(EventKind::Prepared {
        execution_id: repair.execution.id.clone(), head,
    }));
    assert!(result.is_err());
    runtime.finish(&repair.execution, result).unwrap();
    // No history() here: the failed attempt has no persisted Pi session.
    let worktree = Path::new(&repair.execution.worktree);
    let residue_head = workspace::git(worktree, &["rev-parse", "HEAD"]).unwrap();
    fs::write(&script, original).unwrap();
    runtime.intervene("owner", "Continue the failed repair").unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    // The resume fallback points at the original completed target session...
    assert!(retry.session_fork.as_ref().is_some_and(|previous| previous.status == "completed"));
    // ...and the residue is still adopted as the retry base.
    execute(&mut runtime, &retry);
    assert_eq!(runtime.state.nodes["owner"].status, "completed");
    let retry_execution = runtime.state.executions.iter().rev()
        .find(|execution| execution.id == retry.execution.id).unwrap();
    assert_eq!(retry_execution.before, residue_head);
    assert_ne!(residue_head, pin_head);
    assert_eq!(fs::read_to_string(worktree.join("residue.txt")).unwrap().trim(), "residue");
}

#[cfg(feature = "fixture")]
#[test]
fn recomputed_descendant_supersedes_its_previous_attempts() {
    // Downstream recomputation starts the node's conversation from zero in the
    // new workspace: the fresh execution supersedes the node's prior attempts
    // so the conversation view renders only the live lineage.
    let (_temp, _source, mut runtime) = configured(&["owner", "review"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let review = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &review);
    assert_eq!(runtime.state.pending_feedback.len(), 1);
    let repair = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &repair);
    let recomputed = runtime.jobs().unwrap().remove(0);
    assert_eq!(recomputed.execution.node, "review");
    assert_eq!(recomputed.execution.attempt, 2);
    assert!(recomputed.session_fork.is_none());
    assert!(runtime.state.superseded_execution_ids.contains(&review.execution.id));
    assert!(runtime.state.events.iter().any(|event| matches!(
        &event.kind,
        EventKind::Started { execution, fresh_restart: true, .. } if execution.id == recomputed.execution.id
    )));
    execute(&mut runtime, &recomputed);
    assert_eq!(runtime.state.nodes["review"].status, "completed");
}

#[cfg(feature = "fixture")]
#[test]
fn failed_feedback_repair_keeps_its_dirty_files_for_the_retry() {
    let (temp, _source, mut runtime) = configured(&["owner", "review"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let review = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &review);
    let repair = runtime.jobs().unwrap().remove(0);
    let pin_head = repair.feedback_workspace.as_ref().unwrap().head.clone();
    let script = temp.path().join("agent.sh");
    let original = fs::read_to_string(&script).unwrap();
    // First repair attempt leaves uncommitted writes behind and fails.
    fs::write(&script, original.replace("      echo fixed > owner.txt",
        "      echo partial > partial.txt\n      exit 19")).unwrap();
    let root = runtime.root.clone();
    let result = perform(&repair, &root, &[], |_| {}, |head| runtime.emit(EventKind::Prepared {
        execution_id: repair.execution.id.clone(), head,
    }));
    assert!(result.is_err());
    runtime.finish(&repair.execution, result).unwrap();
    assert_eq!(runtime.state.nodes["owner"].status, "failed");
    let worktree = Path::new(&repair.execution.worktree);
    assert_eq!(workspace::git(worktree, &["rev-parse", "HEAD"]).unwrap(), pin_head);
    fs::write(&script, original).unwrap();
    history(&runtime, &repair, "OWNER REPAIR HISTORY");
    runtime.intervene("owner", "Continue the failed repair").unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &retry);
    assert_eq!(runtime.state.nodes["owner"].status, "completed");
    let retry_execution = runtime.state.executions.iter().rev()
        .find(|execution| execution.id == retry.execution.id).unwrap();
    assert_eq!(retry_execution.before, pin_head);
    assert_eq!(fs::read_to_string(worktree.join("partial.txt")).unwrap().trim(), "partial");
    assert_eq!(fs::read_to_string(worktree.join("owner.txt")).unwrap().trim(), "fixed");
}

fn verdict_runtime(names: &[&str], script_body: &str) -> (TempDir, Runtime) {
    let (temp, _source, mut runtime) = setup(true, graph(names));
    let script = temp.path().join("agent.sh");
    fs::write(&script, script_body).unwrap();
    let config = runtime.state.config.as_mut().unwrap();
    config.engine = "pi".into();
    config.pi_command = "/bin/sh".into();
    config.pi_args = vec![script.to_string_lossy().into()];
    runtime.edit_draft_graph(graph(names), runtime.state.config.clone().unwrap()).unwrap();
    runtime.approve().unwrap();
    (temp, runtime)
}

#[test]
fn malformed_feedback_verdict_pushes_a_synchronous_repair_turn_instead_of_failing() {
    let (_temp, mut runtime) = verdict_runtime(&["owner", "review"], r##"task=$(cat)
if [ "$GRAPHER_NODE_NAME" = owner ]; then
  echo initial > owner.txt
  printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Completed"}]}}'
  exit 0
fi
echo turn >> .launches
if printf '%s' "$task" | grep -q 'Feedback Protocol Error'; then
  printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Restated verdict\n<FEEDBACK>"}]}}'
else
  printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Review notes\n<FEEDBACK> trailing"}]}}'
fi
"##);
    let owner = runtime.jobs().unwrap().remove(0);
    assert_eq!(owner.execution.node, "owner");
    assert!(!owner.feedback_source);
    execute(&mut runtime, &owner);
    let review = runtime.jobs().unwrap().remove(0);
    assert!(review.feedback_source);
    let mut streamed = String::new();
    let root_dir = runtime.root.clone();
    let result = perform(&review, &root_dir, &[], |text| streamed.push_str(&text), |head| {
        runtime.emit(EventKind::Prepared { execution_id: review.execution.id.clone(), head })
    });
    // The node completed; the protocol repair turn restated the verdict.
    let (head, output) = result.unwrap();
    assert_eq!(output, "Restated verdict\n<FEEDBACK>");
    assert_eq!(runtime.state.nodes["review"].status, "running");
    runtime.finish(&review.execution, Ok((head, output))).unwrap();
    assert_eq!(runtime.state.nodes["review"].status, "completed");
    // Exactly one repair turn was pushed into the node's own session.
    let launches = fs::read_to_string(Path::new(&review.execution.worktree).join(".launches")).unwrap();
    assert_eq!(launches.lines().count(), 2, "original turn plus one synchronous repair: {launches}");
    // The repair turn streamed into the same execution transcript.
    assert!(streamed.contains("Review notes"));
    assert!(streamed.contains("Restated verdict"));
    // The repaired verdict entered the feedback pipeline instead of a failure.
    assert_eq!(runtime.state.pending_feedback.len(), 1);
    let repair = runtime.jobs().unwrap().remove(0);
    assert_eq!(repair.execution.node, "owner");
    assert_eq!(repair.task, "Feedback from review:\nRestated verdict");
}

#[test]
fn exhausted_feedback_repairs_still_fail_the_node_closed() {
    let (_temp, mut runtime) = verdict_runtime(&["owner", "review"], r##"task=$(cat)
if [ "$GRAPHER_NODE_NAME" = owner ]; then
  echo initial > owner.txt
  printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Completed"}]}}'
  exit 0
fi
echo turn >> .launches
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Review notes\n<FEEDBACK> trailing"}]}}'
"##);
    let owner = runtime.jobs().unwrap().remove(0);
    assert_eq!(owner.execution.node, "owner");
    execute(&mut runtime, &owner);
    let review = runtime.jobs().unwrap().remove(0);
    let root_dir = runtime.root.clone();
    let result = perform(&review, &root_dir, &[], |_| {}, |head| {
        runtime.emit(EventKind::Prepared { execution_id: review.execution.id.clone(), head })
    });
    let error = result.unwrap_err();
    assert_eq!(error, "Feedback protocol error: final line must be exactly <ACCEPT> or <FEEDBACK>");
    runtime.finish(&review.execution, Err(error)).unwrap();
    assert_eq!(runtime.state.nodes["review"].status, "failed");
    // Original turn plus the bounded repair budget; no unbounded loop.
    let launches = fs::read_to_string(Path::new(&review.execution.worktree).join(".launches")).unwrap();
    assert_eq!(launches.lines().count(), 3, "original plus two repair attempts: {launches}");
    assert!(runtime.state.pending_feedback.is_empty());
}

#[test]
fn pending_feedback_stops_running_scope_work_instead_of_waiting_for_it() {
    let (_temp, mut runtime) = verdict_runtime(&["owner", "review", "related"], r##"task=$(cat)
if [ "$GRAPHER_NODE_NAME" = owner ]; then
  echo initial > owner.txt
fi
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Review notes\n<FEEDBACK>"}]}}'
"##);
    let owner = runtime.jobs().unwrap().remove(0);
    assert_eq!(owner.execution.node, "owner");
    execute(&mut runtime, &owner);
    // Dispatch the reviewer and the in-scope sibling; leave the sibling running.
    let jobs = runtime.jobs().unwrap();
    let review = jobs.iter().find(|job| job.execution.node == "review").unwrap().clone();
    let related = jobs.iter().find(|job| job.execution.node == "related").unwrap().clone();
    assert!(related.feedback_source == false);
    execute(&mut runtime, &review);
    assert_eq!(runtime.state.pending_feedback.len(), 1);
    let root_dir = runtime.root.clone();
    let result = perform(&related, &root_dir, &[], |_| {}, |head| {
        runtime.emit(EventKind::Prepared { execution_id: related.execution.id.clone(), head })
    });
    assert!(result.is_ok(), "the sibling runs until the verdict resolves");
    let related_execution = runtime.state.executions.iter().rev()
        .find(|execution| execution.node == "related").unwrap().clone();
    assert_eq!(related_execution.status, "running");

    // The queued verdict stops the in-scope sibling instead of waiting for it.
    let held = runtime.jobs().unwrap();
    assert!(held.is_empty(), "the unresolved verdict dispatches nothing into its scope");
    assert_eq!(runtime.state.pending_feedback.len(), 1, "the verdict stays queued while the stopped work settles");
    assert_eq!(runtime.state.feedback_counts.get("review->owner"), None);
    let stopped = runtime.state.executions.iter().rev()
        .find(|execution| execution.node == "related").unwrap();
    assert_eq!(stopped.status, "running", "the stop signal lands; the worker settles on the driver");

    // The stopped worker reports its kill, then the verdict resolves immediately.
    runtime.finish(&related_execution, Err("Execution paused by user".into())).unwrap();
    assert_eq!(runtime.state.nodes["related"].status, "failed");
    let repair = runtime.jobs().unwrap().remove(0);
    assert_eq!(repair.execution.node, "owner");
    assert_eq!(repair.task, "Feedback from review:\nReview notes");
    assert_eq!(runtime.state.feedback_counts.get("review->owner"), Some(&1));
    assert_eq!(runtime.state.nodes["related"].status, "dirty", "the stopped sibling is invalidated for recomputation, not resumed");
    assert!(runtime.state.pending_feedback.is_empty());
    assert_eq!(runtime.state.executions.iter().filter(|execution| execution.node == "related").count(), 1);
}
