use super::*;

#[test]
fn feedback_batch_survives_restart_before_and_after_atomic_application() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    history(&runtime, &owner, "OWNER HISTORY");
    let reviews = runtime.jobs().unwrap();
    for review in &reviews {
        execute(&mut runtime, review);
    }
    let root = runtime.root.clone();
    assert_eq!(runtime.state.pending_feedback.len(), 2);
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    runtime.pause(false).unwrap();
    runtime.drain_feedback().unwrap();
    assert!(runtime.state.pending_feedback.is_empty());
    assert_eq!(runtime.state.nodes["owner"].status, "dirty");
    assert!(runtime.state.nodes["owner"]
        .instruction
        .contains("Read reports/audit.json."));
    assert_eq!(
        runtime
            .state
            .events
            .iter()
            .filter(|event| matches!(event.kind, EventKind::Invalidated { .. }))
            .count(),
        1
    );
    let counts = runtime.state.feedback_counts.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    runtime.pause(false).unwrap();
    runtime.drain_feedback().unwrap();
    for review in &reviews {
        runtime
            .apply_feedback(
                &review.execution.node,
                "Read reports/audit.json.\n<FEEDBACK>",
            )
            .unwrap();
    }
    assert_eq!(runtime.state.feedback_counts, counts);
    assert!(
        runtime.0.jobs().unwrap().is_empty(),
        "private review results must be delivered before repair"
    );
    super::super::workspace_policy::deliver_batch(&mut runtime);
    let repair = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &repair);
    assert!(Path::new(&repair.execution.worktree)
        .join("reports/review_one.txt")
        .exists());
    assert!(Path::new(&repair.execution.worktree)
        .join("reports/review_two.txt")
        .exists());
}

#[test]
fn feedback_batch_commit_failure_keeps_all_requests_and_budgets_unchanged() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    for review in runtime.jobs().unwrap() {
        execute(&mut runtime, &review);
    }
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
    assert_eq!(runtime.state.nodes["owner"].status, "dirty");
    assert_eq!(
        runtime
            .state
            .events
            .iter()
            .filter(|event| matches!(event.kind, EventKind::Invalidated { .. }))
            .count(),
        1
    );
}

#[test]
fn exhausted_sender_does_not_forward_instructions_or_consume_another_budget() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let reviews = runtime.jobs().unwrap();
    for review in &reviews {
        execute(&mut runtime, review);
    }
    runtime
        .emit(EventKind::Feedback {
            from: "review_two".into(),
            to: "owner".into(),
            accepted: false,
        })
        .unwrap();
    let repair = runtime.jobs().unwrap().remove(0);
    assert!(repair.feedback_workspace.is_none());
    assert!(repair.source_direct);
    assert_eq!(repair.task.matches("Feedback:").count(), 1);
    assert!(repair.task.contains("Feedback:\nRead reports/audit.json."));
    assert_eq!(runtime.state.feedback_counts["review_two->owner"], 1);
    execute(&mut runtime, &repair);
    let path = Path::new(&repair.execution.worktree);
    assert!(path.join("reports/review_one.txt").exists());
    assert!(
        path.join("reports/review_two.txt").exists(),
        "successful private code is delivered independently of feedback budgets"
    );
    assert!(runtime
        .state
        .events
        .iter()
        .any(|event| matches!(&event.kind,
        EventKind::FeedbackExhausted { from, .. } if from == "review_two")));
}

#[test]
fn changed_target_generation_supersedes_old_parallel_feedback() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    for review in runtime.jobs().unwrap() {
        execute(&mut runtime, &review);
    }
    runtime
        .intervene(
            "owner",
            "New owner request supersedes the reviewed generation",
        )
        .unwrap();
    runtime.drain_feedback().unwrap();
    assert!(runtime.state.pending_feedback.is_empty());
    assert!(runtime.state.feedback_counts.is_empty());
    assert!(runtime.state.nodes["owner"].feedback_workspace.is_none());
    assert_eq!(
        runtime
            .state
            .events
            .iter()
            .filter(|event| matches!(&event.kind,
        EventKind::FeedbackResolved { disposition, .. } if disposition == "superseded"))
            .count(),
        2
    );
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
        assert!(runtime.allocation_workspace_reserved(
            Path::new(&review.execution.worktree),
            Some("unrelated")
        ));
        assert!(Path::new(&review.execution.worktree).is_dir());
    }
}

#[test]
fn parallel_acceptances_do_not_start_repair_or_consume_feedback_budget() {
    let (temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let script = temp.path().join("agent.sh");
    let body = fs::read_to_string(&script)
        .unwrap()
        .replace("else verdict=FEEDBACK", "else verdict=ACCEPT");
    fs::write(&script, body).unwrap();
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    for review in runtime.jobs().unwrap() {
        execute(&mut runtime, &review);
    }
    assert!(runtime.jobs().unwrap().is_empty());
    assert!(runtime.state.pending_feedback.is_empty());
    assert!(runtime.state.feedback_counts.is_empty());
    assert!(runtime.state.nodes["owner"].feedback_workspace.is_none());
    assert_eq!(runtime.state.publication.as_ref().unwrap().heads.len(), 3);
}

#[test]
fn batch_conflict_blocks_repair_preserves_sources_and_can_retry_with_merger() {
    let (temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let script = temp.path().join("agent.sh");
    let original = fs::read_to_string(&script).unwrap();
    fs::write(
        &script,
        original.replace(
            "echo evidence > reports/audit.json",
            "echo evidence > reports/audit.json\n    echo \"$name\" > reports/conflict.txt",
        ),
    )
    .unwrap();
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    history(&runtime, &owner, "OWNER HISTORY");
    let reviews = runtime.jobs().unwrap();
    for review in &reviews {
        execute(&mut runtime, review);
    }
    assert!(runtime.0.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "publishing");
    let publication = runtime.state.publication.clone().unwrap();
    let source = PathBuf::from(&publication.repository);
    let error = crate::graph_merge::merge_graph_scoped(&source, &publication.heads, &[], |_| {
        Err("resolver unavailable".into())
    })
    .unwrap_err();
    assert!(error.contains("resolver unavailable"));
    assert!(!source.join("reports").exists());
    runtime
        .emit(EventKind::PublicationFailed { error })
        .unwrap();
    assert!(runtime.0.jobs().unwrap().is_empty());
    assert_eq!(
        runtime
            .state
            .executions
            .iter()
            .filter(|e| e.node == "owner")
            .count(),
        1,
        "repair must not start on a failed publication"
    );
    for review in &reviews {
        let recorded = runtime
            .state
            .executions
            .iter()
            .find(|e| e.id == review.execution.id)
            .unwrap();
        assert_eq!(
            workspace::git(
                Path::new(&review.execution.worktree),
                &["rev-parse", "HEAD"]
            )
            .unwrap(),
            recorded.after.as_ref().unwrap().as_str()
        );
        assert!(
            workspace::repository_status(Path::new(&review.execution.worktree), &[])
                .unwrap()
                .is_empty()
        );
    }
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    runtime.retry_publication().unwrap();
    let mut calls = 0;
    let head = crate::graph_merge::merge_graph_scoped(&source, &publication.heads, &[], |path| {
        calls += 1;
        fs::write(
            path.join("reports/conflict.txt"),
            "both review reports retained\n",
        )
        .map_err(|e| e.to_string())?;
        workspace::git(path, &["add", "-f", "reports/conflict.txt"]).map(|_| ())
    })
    .unwrap();
    assert_eq!(calls, 1);
    runtime
        .emit(EventKind::PublicationCompleted { head })
        .unwrap();
    let repair = runtime.jobs().unwrap().remove(0);
    assert!(repair.source_direct);
    execute(&mut runtime, &repair);
    for file in ["review_one.txt", "review_two.txt", "conflict.txt"] {
        assert!(source.join("reports").join(file).is_file());
    }
    assert_eq!(
        fs::read_to_string(source.join("owner.txt")).unwrap().trim(),
        "fixed"
    );
}

#[test]
fn feedback_without_reviewed_execution_is_superseded_without_invalidating_the_target() {
    let (_temp, _source, mut runtime) = configured(&["owner", "review"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let review = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &review);
    let mut json = serde_json::to_value(&runtime.state.pending_feedback[0]).unwrap();
    json.as_object_mut().unwrap().remove("targetExecutionId");
    assert!(serde_json::from_value::<PendingFeedback>(json).is_err());
    let mut missing = runtime.state.pending_feedback[0].clone();
    missing.target_execution_id = None;
    assert!(!runtime.feedback_request_is_current(&missing));
    runtime.state.pending_feedback[0] = missing;
    let before = serde_json::to_value(&runtime.state.nodes["owner"]).unwrap();
    runtime.drain_feedback().unwrap();
    assert_eq!(
        serde_json::to_value(&runtime.state.nodes["owner"]).unwrap(),
        before
    );
    assert!(runtime.state.pending_feedback.is_empty());
}

#[test]
fn publication_keeps_additional_senders_unrecorded_edits_out_of_source() {
    let (_temp, source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    let reviews = runtime.jobs().unwrap();
    for review in &reviews {
        execute(&mut runtime, review);
    }
    let late = Path::new(&reviews[1].execution.worktree).join("late.txt");
    fs::write(&late, "unrecorded").unwrap();
    let repair = runtime.jobs().unwrap().remove(0);
    assert!(repair.source_direct);
    assert!(!source.join("late.txt").exists());
    assert_eq!(fs::read_to_string(late).unwrap(), "unrecorded");
    execute(&mut runtime, &repair);
    assert!(source.join("reports/review_one.txt").is_file());
    assert!(source.join("reports/review_two.txt").is_file());
}

#[test]
fn failed_batch_agent_keeps_its_prepared_workspace_and_partial_edits_on_retry() {
    let (temp, _source, mut runtime) = configured(&["owner", "review_one", "review_two"], 1);
    let script = temp.path().join("agent.sh");
    let original = fs::read_to_string(&script).unwrap();
    let owner = runtime.jobs().unwrap().remove(0);
    execute(&mut runtime, &owner);
    history(&runtime, &owner, "OWNER HISTORY");
    for review in runtime.jobs().unwrap() {
        execute(&mut runtime, &review);
    }
    let repair = runtime.jobs().unwrap().remove(0);
    fs::write(
        &script,
        original.replace(
            "echo fixed > .cache/owner",
            "echo fixed > .cache/owner\n      echo partial > partial.txt\n      exit 19",
        ),
    )
    .unwrap();
    let root = runtime.root.clone();
    let result = perform(
        &repair,
        &root,
        &[],
        |_| {},
        |head| {
            runtime.emit(EventKind::Prepared {
                execution_id: repair.execution.id.clone(),
                head,
            })
        },
    );
    assert!(result.is_err());
    runtime.finish(&repair.execution, result).unwrap();
    history(&runtime, &repair, "OWNER REPAIR HISTORY");
    fs::write(&script, original).unwrap();
    runtime
        .intervene(
            "owner",
            "Continue the failed repair without losing partial work",
        )
        .unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.execution.worktree, repair.execution.worktree);
    assert!(retry.source_direct);
    assert!(retry.preserved_workspace.is_none());
    execute(&mut runtime, &retry);
    let path = Path::new(&retry.execution.worktree);
    assert_eq!(
        fs::read_to_string(path.join("partial.txt")).unwrap().trim(),
        "partial"
    );
    assert!(path.join("reports/review_one.txt").exists());
    assert!(path.join("reports/review_two.txt").exists());
}
