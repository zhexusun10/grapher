use super::*;

#[test]
fn feedback_batch_survives_restart_before_and_after_atomic_application() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    history(&runtime, &owner, "OWNER HISTORY");
    let reviews = runtime.jobs().unwrap();
    for review in &reviews { execute(&mut runtime, review); }
    let root = runtime.root.clone();
    assert_eq!(runtime.state.pending_feedback.len(), 2);
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    runtime.pause(false).unwrap();
    runtime.drain_feedback().unwrap();
    assert!(runtime.state.pending_feedback.is_empty());
    assert_eq!(runtime.state.nodes["owner"].feedback_workspace.as_ref().unwrap().additional_sources.len(), 1);
    let counts = runtime.state.feedback_counts.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    runtime.pause(false).unwrap();
    runtime.drain_feedback().unwrap();
    for review in &reviews {
        runtime.apply_feedback(&review.execution.node, "Read reports/audit.json.\n<FEEDBACK>").unwrap();
    }
    assert_eq!(runtime.state.feedback_counts, counts);
    let repair = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &repair);
    assert!(Path::new(&repair.execution.worktree).join("reports/review_one.txt").exists());
    assert!(Path::new(&repair.execution.worktree).join("reports/review_two.txt").exists());
}

#[test]
fn feedback_batch_commit_failure_keeps_all_requests_and_budgets_unchanged() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    for review in runtime.jobs().unwrap() { execute(&mut runtime, &review); }
    let db = rusqlite::Connection::open(runtime.root.join("events.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_batch BEFORE INSERT ON events WHEN NEW.kind='invalidated' BEGIN SELECT RAISE(ABORT, 'test batch failure'); END;").unwrap();
    assert!(runtime.drain_feedback().is_err());
    assert_eq!(runtime.state.pending_feedback.len(), 2);
    assert!(runtime.state.feedback_counts.is_empty());
    assert!(runtime.state.nodes["owner"].feedback_workspace.is_none());
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(replay.pending_feedback.len(), 2);
    assert!(replay.feedback_counts.is_empty());
    assert_eq!(replay.nodes["owner"].status, "completed");
    db.execute_batch("DROP TRIGGER reject_batch;").unwrap();
    runtime.drain_feedback().unwrap();
    assert_eq!(runtime.state.feedback_counts.len(), 2);
    assert_eq!(runtime.state.nodes["owner"].feedback_workspace.as_ref().unwrap().additional_sources.len(), 1);
}

#[test]
fn exhausted_sender_is_not_merged_or_forwarded_with_applicable_feedback() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let reviews = runtime.jobs().unwrap();
    for review in &reviews { execute(&mut runtime, review); }
    runtime.emit(EventKind::Feedback { from: "review_two".into(), to: "owner".into(), accepted: false }).unwrap();
    let repair = runtime.jobs().unwrap().remove(0);
    assert!(repair.feedback_workspace.as_ref().unwrap().additional_sources.is_empty());
    assert!(repair.task.contains("Feedback from review_one"));
    assert!(!repair.task.contains("Feedback from review_two"));
    assert_eq!(runtime.state.feedback_counts["review_two->owner"], 1);
    execute(&mut runtime, &repair);
    let path = Path::new(&repair.execution.worktree);
    assert!(path.join("reports/review_one.txt").exists());
    assert!(!path.join("reports/review_two.txt").exists());
    assert!(runtime.state.events.iter().any(|event| matches!(&event.kind,
        EventKind::FeedbackExhausted { from, .. } if from == "review_two")));
}

#[test]
fn changed_target_generation_supersedes_old_parallel_feedback() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    for review in runtime.jobs().unwrap() { execute(&mut runtime, &review); }
    runtime.intervene("owner", "New owner request supersedes the reviewed generation").unwrap();
    runtime.drain_feedback().unwrap();
    assert!(runtime.state.pending_feedback.is_empty());
    assert!(runtime.state.feedback_counts.is_empty());
    assert!(runtime.state.nodes["owner"].feedback_workspace.is_none());
    assert_eq!(runtime.state.events.iter().filter(|event| matches!(&event.kind,
        EventKind::FeedbackResolved { disposition, .. } if disposition == "superseded")).count(), 2);
}

#[test]
fn feedback_inputs_stay_reserved_without_managed_environments() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let reviews = runtime.jobs().unwrap();
    execute(&mut runtime, &reviews[0]);
    assert!(runtime.workspace_reserved(Path::new(&reviews[0].execution.worktree), None));
    execute(&mut runtime, &reviews[1]);
    runtime.drain_feedback().unwrap();
    for review in &reviews {
        assert!(runtime.workspace_reserved(Path::new(&review.execution.worktree), Some("unrelated")));
        assert!(Path::new(&review.execution.worktree).is_dir());
    }
}

#[test]
fn parallel_acceptances_do_not_start_repair_or_consume_feedback_budget() {
    let (temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let script = temp.path().join("agent.sh");
    let body = fs::read_to_string(&script).unwrap().replace("else verdict=FEEDBACK", "else verdict=ACCEPT");
    fs::write(&script, body).unwrap();
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    for review in runtime.jobs().unwrap() { execute(&mut runtime, &review); }
    assert!(runtime.jobs().unwrap().is_empty());
    assert!(runtime.state.pending_feedback.is_empty());
    assert!(runtime.state.feedback_counts.is_empty());
    assert!(runtime.state.nodes["owner"].feedback_workspace.is_none());
    assert_eq!(runtime.state.publication.as_ref().unwrap().heads.len(), 2);
}

#[test]
fn batch_conflict_blocks_repair_preserves_sources_and_can_retry_with_merger() {
    fn run(runtime: &mut Runtime, job: &Job) -> Result<(String, String), String> {
        let events = std::cell::RefCell::new(Vec::new());
        let result = perform_with_merger(job, &runtime.root, &[], |_| {}, |head| {
            events.borrow_mut().push(EventKind::Prepared { execution_id: job.execution.id.clone(), head });
            Ok(())
        }, |event| { events.borrow_mut().push(event); Ok(()) });
        for event in events.into_inner() { runtime.emit(event).unwrap(); }
        runtime.finish(&job.execution, result.clone()).unwrap();
        result
    }
    let (temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let script = temp.path().join("agent.sh");
    let original = fs::read_to_string(&script).unwrap();
    fs::write(&script, original.replace("echo evidence > reports/audit.json",
        "echo evidence > reports/audit.json\n    echo \"$GRAPHER_NODE_NAME\" > reports/conflict.txt")).unwrap();
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    history(&runtime, &owner, "OWNER HISTORY");
    let reviews = runtime.jobs().unwrap();
    for review in &reviews { execute(&mut runtime, review); }
    let repair = runtime.jobs().unwrap().remove(0);
    let error = run(&mut runtime, &repair).unwrap_err();
    assert!(error.contains("Workspace composition blocked"));
    assert_eq!(runtime.state.nodes["owner"].status, "blocked");
    let failed_slot = Path::new(&repair.execution.worktree);
    assert!(workspace::git(failed_slot, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok());
    for source in repair.feedback_workspace.as_ref().unwrap().sources() {
        assert_eq!(workspace::git(Path::new(&source.worktree), &["rev-parse", "HEAD"]).unwrap(), source.head);
        assert!(workspace::repository_status(Path::new(&source.worktree), &[]).unwrap().is_empty());
    }
    // A deterministic fixture Merger resolves only the evidence conflict. The
    // target agent must not run until this merge has committed successfully.
    let resolver = r#"cat >/dev/null
if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  printf 'both review reports retained\n' > reports/conflict.txt
  git add reports/conflict.txt
  git commit --no-edit >/dev/null
  printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Conflict resolved"}]}}'
  exit 0
fi
"#;
    fs::write(&script, format!("{resolver}\n{original}")).unwrap();
    runtime.intervene("owner", "Retry the feedback batch after fixing the evidence Merger").unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &retry).unwrap();
    assert!(Path::new(&retry.execution.worktree).join("reports/review_one.txt").exists());
    assert!(Path::new(&retry.execution.worktree).join("reports/review_two.txt").exists());
    assert_eq!(fs::read_to_string(Path::new(&retry.execution.worktree).join("owner.txt")).unwrap().trim(), "fixed");
    assert!(runtime.state.events.iter().any(|event| matches!(&event.kind, EventKind::MergerFinished { .. })));
}

#[test]
fn legacy_feedback_records_default_to_single_input_and_exact_head_validation() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let review = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &review);
    let mut json = serde_json::to_value(&runtime.state.pending_feedback[0]).unwrap();
    json.as_object_mut().unwrap().remove("targetExecutionId");
    let legacy: PendingFeedback = serde_json::from_value(json).unwrap();
    assert!(legacy.target_execution_id.is_none());
    assert!(runtime.feedback_request_is_current(&legacy));
    runtime.state.pending_feedback[0] = legacy;
    runtime.drain_feedback().unwrap();
    let mut json = serde_json::to_value(runtime.state.nodes["owner"].feedback_workspace.as_ref().unwrap()).unwrap();
    json.as_object_mut().unwrap().remove("additionalSources");
    let legacy: FeedbackWorkspace = serde_json::from_value(json).unwrap();
    assert!(legacy.additional_sources.is_empty());
}

#[test]
fn modified_additional_sender_blocks_batch_before_target_starts() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    for review in runtime.jobs().unwrap() { execute(&mut runtime, &review); }
    let repair = runtime.jobs().unwrap().remove(0);
    let input = repair.feedback_workspace.as_ref().unwrap();
    fs::write(Path::new(&input.additional_sources[0].worktree).join("late.txt"), "unrecorded").unwrap();
    let result = perform(&repair, &runtime.root, &[], |_| {}, |_| panic!("target must not start"));
    assert!(result.unwrap_err().contains("Feedback workspace changed after completion"));
    assert_eq!(workspace::git(Path::new(&input.worktree), &["rev-parse", "HEAD"]).unwrap(), input.head);
}

#[test]
fn failed_batch_agent_keeps_its_prepared_workspace_and_partial_edits_on_retry() {
    let (temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let script = temp.path().join("agent.sh");
    let original = fs::read_to_string(&script).unwrap();
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    history(&runtime, &owner, "OWNER HISTORY");
    for review in runtime.jobs().unwrap() { execute(&mut runtime, &review); }
    let repair = runtime.jobs().unwrap().remove(0);
    fs::write(&script, original.replace("echo fixed > .cache/owner",
        "echo fixed > .cache/owner\n      echo partial > partial.txt\n      exit 19")).unwrap();
    let root = runtime.root.clone();
    let result = perform(&repair, &root, &[], |_| {}, |head| runtime.emit(EventKind::Prepared {
        execution_id: repair.execution.id.clone(), head,
    }));
    assert!(result.is_err());
    runtime.finish(&repair.execution, result).unwrap();
    history(&runtime, &repair, "OWNER REPAIR HISTORY");
    fs::write(&script, original).unwrap();
    runtime.intervene("owner", "Continue the failed repair without losing partial work").unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.execution.worktree, repair.execution.worktree);
    assert!(retry.preserved_workspace.is_some());
    execute(&mut runtime, &retry);
    let path = Path::new(&retry.execution.worktree);
    assert_eq!(fs::read_to_string(path.join("partial.txt")).unwrap().trim(), "partial");
    assert!(path.join("reports/review_one.txt").exists());
    assert!(path.join("reports/review_two.txt").exists());
}
