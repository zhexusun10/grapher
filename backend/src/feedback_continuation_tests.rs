use super::*;

#[path = "feedback_delivery_tests.rs"]
mod delivery;

fn configured(shared: bool) -> (TempDir, PathBuf, Runtime) {
    let graph = Graph {
        original_goal: "feedback continuity".into(),
        nodes: ["owner", "review", "related", "later", "unrelated"]
            .into_iter()
            .map(|name| Node {
                name: name.into(),
                task: format!("ORIGINAL {name}"),
            })
            .collect(),
        edges: [
            ("owner", "review", false),
            ("owner", "related", false),
            ("review", "later", false),
            ("related", "later", false),
            ("review", "owner", true),
        ]
        .into_iter()
        .map(|(from, to, feedback)| Edge {
            from: from.into(),
            to: to.into(),
            feedback,
        })
        .collect(),
    };
    let (temp, source, mut runtime) = setup(true, graph.clone());
    let mut config = runtime.state.config.clone().unwrap();
    config.max_feedback = 2;
    runtime.edit_draft_graph(graph, config).unwrap();
    runtime.approve().unwrap();
    if shared {
        runtime
            .emit(EventKind::WorkspaceIsolationSelected { isolated: false })
            .unwrap();
    }
    (temp, source, runtime)
}

fn history(runtime: &Runtime, job: &Job) {
    let directory = runtime.root.join("sessions").join(&job.execution.id);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(format!("test_{}.jsonl", job.execution.session_id)), format!("{}\n{}\n",
        serde_json::json!({"type":"session", "version":3, "id":job.execution.session_id, "cwd":job.execution.worktree}),
        serde_json::json!({"type":"message", "id":"user", "parentId":null, "message":{"role":"user", "content":format!("HISTORY {}", job.execution.node), "timestamp":1}}))).unwrap();
}

fn finish(runtime: &mut Runtime, job: &Job, output: &str) {
    let head = if job.source_direct {
        String::new()
    } else {
        runtime.state.base.clone()
    };
    runtime
        .finish(&job.execution, Ok((head, output.into())))
        .unwrap();
}

fn invalidate(runtime: &mut Runtime, stopped: bool) -> (Job, Job, Job) {
    let roots = runtime.jobs().unwrap();
    for job in &roots {
        history(runtime, job);
        finish(runtime, job, "done");
    }
    let owner = roots
        .into_iter()
        .find(|job| job.execution.node == "owner")
        .unwrap();
    let jobs = runtime.jobs().unwrap();
    let review = jobs
        .iter()
        .find(|job| job.execution.node == "review")
        .unwrap()
        .clone();
    let related = jobs
        .iter()
        .find(|job| job.execution.node == "related")
        .unwrap()
        .clone();
    history(runtime, &review);
    history(runtime, &related);
    finish(runtime, &review, "fix the issue\n<FEEDBACK>");
    assert!(
        runtime.jobs().unwrap().is_empty(),
        "affected writers must drain first"
    );
    if stopped {
        runtime
            .finish(&related.execution, Err("stopped by feedback".into()))
            .unwrap();
    } else {
        finish(runtime, &related, "done");
    }
    runtime.drain_feedback().unwrap();
    (owner, review, related)
}

#[test]
fn feedback_continuation_keeps_memory_but_rebuilds_inputs_in_dependency_order() {
    for shared in [false, true] {
        for stopped in [false, true] {
            let (_temp, _source, mut runtime) = configured(shared);
            let (owner, review, related) = invalidate(&mut runtime, stopped);
            assert!(
                runtime.state.nodes["review"]
                    .feedback_continuation
                    .as_ref()
                    .unwrap()
                    .sender
            );
            assert!(
                !runtime.state.nodes["related"]
                    .feedback_continuation
                    .as_ref()
                    .unwrap()
                    .sender
            );
            assert!(runtime.state.nodes["later"].feedback_continuation.is_none());
            assert!(runtime.state.nodes["unrelated"]
                .feedback_continuation
                .is_none());
            assert_eq!(runtime.state.nodes["unrelated"].status, "completed");
            let repair = runtime.jobs().unwrap().remove(0);
            assert_eq!(repair.execution.node, "owner");
            assert_eq!(repair.task, "Feedback:\nfix the issue");
            assert!(
                repair.resume_execution_id.as_deref() == Some(&owner.execution.id)
                    || repair
                        .session_fork
                        .as_ref()
                        .is_some_and(|fork| fork.id == owner.execution.id)
            );
            assert!(runtime.jobs().unwrap().is_empty());
            finish(&mut runtime, &repair, "repaired");
            let rechecks = runtime.jobs().unwrap();
            assert_eq!(rechecks.len(), 2);
            for job in &rechecks {
                let previous = if job.execution.node == "review" {
                    &review
                } else {
                    &related
                };
                assert_eq!(job.session_fork.as_ref().unwrap().id, previous.execution.id);
                assert_ne!(job.execution.session_id, previous.execution.session_id);
                assert!(!job.task.contains("ORIGINAL"));
                assert!(job.task.contains("fixture:"));
                assert!(
                    !job.continuation,
                    "append a new turn, not an interrupted old turn"
                );
                assert!(
                    job.preserved_workspace.is_none(),
                    "old partial files are invalidated"
                );
                assert!(!job.preserve_failed_environment);
                assert_eq!(job.feedback_source, job.execution.node == "review");
                if !shared {
                    assert_eq!(job.parent_heads, vec![runtime.state.base.clone()]);
                }
                assert!(!runtime
                    .state
                    .superseded_execution_ids
                    .contains(&previous.execution.id));
                finish(
                    &mut runtime,
                    job,
                    if job.feedback_source {
                        "<ACCEPT>"
                    } else {
                        "done"
                    },
                );
            }
            let later = runtime.jobs().unwrap().remove(0);
            assert_eq!(later.execution.node, "later");
            assert_eq!(later.task, "ORIGINAL later");
            assert!(later.session_fork.is_none() && later.resume_execution_id.is_none());
        }
    }
}

#[test]
fn feedback_continuation_pending_and_bound_message_survive_restart_and_retry() {
    for stopped in [false, true] {
        let (_temp, _source, mut runtime) = configured(true);
        let (_, review, related) = invalidate(&mut runtime, stopped);
        let root = runtime.root.clone();
        drop(runtime);
        let mut runtime = Runtime::open(&root).unwrap();
        assert!(runtime.state.paused);
        runtime.pause(false).unwrap();
        let repair = runtime.jobs().unwrap().remove(0);
        finish(&mut runtime, &repair, "repaired");
        let rechecks = runtime.jobs().unwrap();
        let selected = if stopped { "related" } else { "review" };
        let recheck = rechecks
            .iter()
            .find(|job| job.execution.node == selected)
            .unwrap();
        let expected = recheck.task.clone();
        for job in &rechecks {
            runtime
                .finish(&job.execution, Err("failed before session fork".into()))
                .unwrap();
        }
        assert!(runtime.jobs().unwrap().is_empty());
        fs::write(
            root.join("prompts/feedback-returned.md"),
            "changed template",
        )
        .unwrap();
        fs::write(root.join("prompts/feedback-updated.md"), "changed template").unwrap();
        drop(runtime);
        let mut runtime = Runtime::open(&root).unwrap();
        runtime.pause(false).unwrap();
        let retries = runtime.jobs().unwrap();
        let retry = retries
            .iter()
            .find(|job| job.execution.node == selected)
            .unwrap();
        assert_eq!(retry.task, expected, "the already bound message is durable");
        assert!(!retry.initial_recovery && !retry.continuation);
        let anchor = if stopped { &related } else { &review };
        assert_eq!(retry.session_fork.as_ref().unwrap().id, anchor.execution.id);
        // Once the new session actually ran, retry continues it without another
        // notice and without replaying the original node task.
        delivery::deliver(&runtime, retry);
        for other in retries.iter().filter(|job| job.execution.node != selected) {
            finish(
                &mut runtime,
                other,
                if other.feedback_source {
                    "<ACCEPT>"
                } else {
                    "done"
                },
            );
        }
        runtime
            .emit(EventKind::Prepared {
                execution_id: retry.execution.id.clone(),
                head: String::new(),
            })
            .unwrap();
        runtime
            .finish(&retry.execution, Err("provider failure".into()))
            .unwrap();
        runtime.resume_node(selected).unwrap();
        let resumed = runtime
            .jobs()
            .unwrap()
            .into_iter()
            .find(|job| job.execution.node == selected)
            .unwrap();
        assert!(resumed.continuation);
        assert!(resumed.task.is_empty());
        assert_eq!(
            resumed.resume_execution_id.as_deref(),
            Some(retry.execution.id.as_str())
        );
    }
}

#[test]
fn feedback_continuation_unset_wording_never_sends_a_placeholder_or_restarts_task() {
    let (_temp, _source, mut runtime) = configured(true);
    let (_, review, _) = invalidate(&mut runtime, false);
    let repair = runtime.jobs().unwrap().remove(0);
    finish(&mut runtime, &repair, "repaired");
    fs::write(runtime.root.join("prompts/feedback-returned.md"), "  \n").unwrap();
    let count = runtime.state.executions.len();
    assert!(runtime
        .jobs()
        .err()
        .unwrap()
        .contains("message is not configured"));
    assert_eq!(runtime.state.executions.len(), count);
    assert!(runtime.state.nodes["review"]
        .feedback_continuation
        .as_ref()
        .unwrap()
        .instruction
        .is_none());
    assert!(!runtime
        .state
        .superseded_execution_ids
        .contains(&review.execution.id));
    fs::write(
        runtime.root.join("prompts/feedback-returned.md"),
        "approved wording for {{node}} / {{target}}",
    )
    .unwrap();
    let jobs = runtime.jobs().unwrap();
    assert_eq!(
        jobs.iter()
            .find(|job| job.execution.node == "review")
            .unwrap()
            .task,
        "approved wording for review / owner"
    );
}

#[test]
fn feedback_continuation_keeps_queued_human_messages_even_after_wording_was_bound() {
    let (_temp, _source, mut runtime) = configured(true);
    invalidate(&mut runtime, false);
    let repair = runtime.jobs().unwrap().remove(0);
    finish(&mut runtime, &repair, "repaired");
    let nodes = runtime
        .state
        .graph
        .nodes
        .iter()
        .filter(|node| node.name == "review")
        .cloned()
        .collect::<Vec<_>>();
    runtime.prepare_feedback_continuations(&nodes).unwrap();
    runtime.intervene("review", "human follow-up one").unwrap();
    runtime.intervene("review", "human follow-up two").unwrap();
    let jobs = runtime.jobs().unwrap();
    let review = jobs
        .iter()
        .find(|job| job.execution.node == "review")
        .unwrap();
    assert_eq!(review.task.matches("fixture: feedback returned").count(), 1);
    assert_eq!(review.task.matches("human follow-up one").count(), 1);
    assert_eq!(review.task.matches("human follow-up two").count(), 1);
    for job in &jobs {
        if job.execution.node == "review" {
            runtime
                .finish(&job.execution, Err("fork not written".into()))
                .unwrap();
        } else {
            finish(&mut runtime, job, "done");
        }
    }
    runtime.resume_node("review").unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.task, review.task);
    assert!(runtime.state.nodes["review"].pending_messages.is_empty());
}

#[test]
fn feedback_continuation_second_round_skips_only_an_unwritten_session_fork() {
    for launched in [false, true] {
        let (_temp, _source, mut runtime) = configured(true);
        let (_, _, original_related) = invalidate(&mut runtime, true);
        let repair = runtime.jobs().unwrap().remove(0);
        finish(&mut runtime, &repair, "repaired");
        let jobs = runtime.jobs().unwrap();
        let review = jobs
            .iter()
            .find(|job| job.execution.node == "review")
            .unwrap();
        let related = jobs
            .iter()
            .find(|job| job.execution.node == "related")
            .unwrap();
        history(&runtime, review);
        if launched {
            runtime
                .emit(EventKind::Output {
                    execution_id: related.execution.id.clone(),
                    text: "model already acted".into(),
                })
                .unwrap();
        }
        runtime
            .finish(&related.execution, Err("missing fork".into()))
            .unwrap();
        finish(&mut runtime, review, "another issue\n<FEEDBACK>");
        runtime.drain_feedback().unwrap();
        let input = runtime.state.nodes["related"]
            .feedback_continuation
            .as_ref()
            .unwrap();
        assert_eq!(
            input.anchor_execution_id,
            if launched {
                &related.execution.id
            } else {
                &original_related.execution.id
            }
            .to_owned()
        );
        assert_eq!(
            runtime.state.nodes["review"]
                .feedback_continuation
                .as_ref()
                .unwrap()
                .anchor_execution_id,
            review.execution.id
        );
        assert_eq!(runtime.state.feedback_counts["review->owner"], 2);
    }
}

#[test]
fn feedback_continuation_queue_is_atomic_with_invalidation_and_budget() {
    let (_temp, _source, mut runtime) = configured(true);
    let roots = runtime.jobs().unwrap();
    for job in &roots {
        finish(&mut runtime, job, "done");
    }
    let jobs = runtime.jobs().unwrap();
    for job in &jobs {
        finish(
            &mut runtime,
            job,
            if job.feedback_source {
                "fix\n<FEEDBACK>"
            } else {
                "done"
            },
        );
    }
    let db = rusqlite::Connection::open(runtime.root.join("events.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_continuation BEFORE INSERT ON events WHEN NEW.kind='feedback_continuation_queued' BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
    assert!(runtime.drain_feedback().is_err());
    for snapshot in [
        &runtime.state,
        &runtime.store.load(&runtime.state.run_id).unwrap(),
    ] {
        assert!(snapshot.feedback_counts.is_empty());
        assert_eq!(snapshot.pending_feedback.len(), 1);
        assert_eq!(snapshot.nodes["owner"].status, "completed");
        assert!(snapshot.nodes["review"].feedback_continuation.is_none());
    }
    db.execute_batch("DROP TRIGGER reject_continuation")
        .unwrap();
    runtime.drain_feedback().unwrap();
    let count = runtime
        .state
        .events
        .iter()
        .filter(|event| matches!(event.kind, EventKind::FeedbackContinuationQueued { .. }))
        .count();
    runtime.drain_feedback().unwrap();
    assert_eq!(count, 2);
    assert_eq!(
        runtime
            .state
            .events
            .iter()
            .filter(|event| matches!(event.kind, EventKind::FeedbackContinuationQueued { .. }))
            .count(),
        count
    );
}
