use super::*;

fn record_session(runtime: &Runtime, execution: &Execution) {
    let directory = runtime.root.join("sessions").join(&execution.id);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(format!("test_{}.jsonl", execution.session_id)),
        format!("{}\n{}\n", serde_json::json!({"type": "session", "id": execution.session_id, "cwd": execution.worktree}),
            serde_json::json!({"type": "message", "id": "opening", "parentId": null,
                "message": {"role": "user", "content": "retained session context"}}))).unwrap();
}

#[test]
fn unknown_failure_continue_replays_and_retains_session_and_partial_work() {
    for route in ["graph", "serial"] {
        let (_temp, source, mut runtime) = setup(true, single());
        runtime.set_route(route).unwrap();
        runtime.approve().unwrap();
        let failed = runtime.jobs().unwrap().remove(0);
        if route == "graph" {
            workspace::prepare(&source, Path::new(&failed.execution.worktree), &failed.execution.before, &[]).unwrap();
            runtime.emit(EventKind::Prepared {
                execution_id: failed.execution.id.clone(), head: failed.execution.before.clone(),
            }).unwrap();
        }
        record_session(&runtime, &failed.execution);
        let partial = Path::new(&failed.execution.worktree).join("unfinished.txt");
        fs::write(&partial, "do not discard").unwrap();
        runtime.finish(&failed.execution, Err("Unrecognized frobnicator error #843".into())).unwrap();
        runtime.jobs().unwrap();
        assert!(!runtime.state.can_resume_interrupted());
        assert!(runtime.state.can_resume());
        let metadata = crate::snapshot_view::snapshot_metadata(&runtime.state).unwrap();
        assert_eq!(metadata["canResume"], true);
        assert_eq!(metadata["nodes"]["task"]["status"], "failed");
        assert_eq!(metadata["executions"][0]["status"], "failed");

        let root = runtime.root.clone();
        drop(runtime);
        let mut runtime = Runtime::open(&root).unwrap();
        assert!(runtime.state.can_resume(), "the error remains retryable after restart");
        runtime.pause(false).unwrap();
        let replay = runtime.store.load(&runtime.state.run_id).unwrap();
        assert!(replay.nodes["task"].continuation, "the recovery decision replays without error classification");
        assert_eq!(replay.executions[0].status, "failed");
        drop(runtime);
        let mut runtime = Runtime::open(&root).unwrap();
        assert!(runtime.state.paused, "restart never dispatches a queued retry automatically");
        assert!(runtime.state.nodes["task"].continuation);
        runtime.pause(false).unwrap();
        let retry = runtime.jobs().unwrap().remove(0);
        assert!(retry.continuation);
        assert!(!retry.initial_recovery);
        assert!(retry.task.is_empty(), "do not invent or resend a user turn");
        assert_eq!(retry.execution.session_id, failed.execution.session_id);
        assert_eq!(retry.execution.worktree, failed.execution.worktree);
        assert_eq!(retry.resume_execution_id.as_deref(), Some(failed.execution.id.as_str()));
        assert_ne!(retry.execution.id, failed.execution.id);
        if route == "graph" { assert!(retry.preserved_workspace.is_some()); }
        assert_eq!(fs::read_to_string(partial).unwrap(), "do not discard");
        assert_eq!(runtime.state.executions[0].status, "failed");
        assert!(!runtime.state.can_resume(), "an active retry is not offered again");
        runtime.finish(&retry.execution, Ok((runtime.state.base.clone(), "recovered".into()))).unwrap();
        assert_eq!(runtime.state.nodes["task"].status, "completed");
    }
}

#[test]
fn unknown_failure_unblocks_dependents_without_disturbing_completed_work() {
    let graph = Graph {
        original_goal: "retry one branch".into(),
        nodes: ["first", "after", "other"].into_iter().map(|name| Node {
            name: name.into(), task: name.into(),
        }).collect(),
        edges: vec![Edge { from: "first".into(), to: "after".into(), feedback: false }],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    let first = &jobs.iter().find(|job| job.execution.node == "first").unwrap().execution;
    let other = &jobs.iter().find(|job| job.execution.node == "other").unwrap().execution;
    record_session(&runtime, first);
    runtime.finish(first, Err("unrecognized failure".into())).unwrap();
    assert!(!runtime.state.can_resume(), "do not offer recovery while another writer runs");
    runtime.finish(other, Ok((runtime.state.base.clone(), "done".into()))).unwrap();
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.nodes["after"].status, "blocked");
    assert!(runtime.state.can_resume());
    runtime.pause(false).unwrap();
    assert_eq!(runtime.state.nodes["after"].status, "waiting");
    assert_eq!(runtime.state.nodes["other"].status, "completed");
    let retry = runtime.jobs().unwrap();
    assert_eq!(retry.len(), 1);
    assert_eq!(retry[0].execution.node, "first");
    assert!(retry[0].continuation);
    runtime.finish(&retry[0].execution, Ok((runtime.state.base.clone(), "recovered".into()))).unwrap();
    let after = runtime.jobs().unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].execution.node, "after");
    assert!(!after[0].continuation, "unstarted dependents get their own task");
    assert_eq!(runtime.state.nodes["other"].status, "completed");
}

#[test]
fn unknown_startup_failure_without_a_session_restarts_the_initial_task() {
    for route in ["graph", "serial"] {
        let (_temp, source, mut runtime) = setup(true, single());
        runtime.set_route(route).unwrap();
        runtime.approve().unwrap();
        let failed = runtime.jobs().unwrap().remove(0);
        if route == "graph" {
            workspace::prepare(&source, Path::new(&failed.execution.worktree), &failed.execution.before, &[]).unwrap();
            runtime.emit(EventKind::Prepared {
                execution_id: failed.execution.id.clone(), head: failed.execution.before.clone(),
            }).unwrap();
        }
        let partial = Path::new(&failed.execution.worktree).join("unfinished.txt");
        fs::write(&partial, "preserve").unwrap();
        runtime.finish(&failed.execution, Err("unknown startup failure".into())).unwrap();
        runtime.jobs().unwrap();
        assert!(runtime.state.can_resume());
        runtime.pause(false).unwrap();
        let retry = runtime.jobs().unwrap().remove(0);
        assert!(retry.initial_recovery);
        assert!(!retry.continuation);
        assert_eq!(retry.task, "self-contained task");
        assert_eq!(retry.execution.session_id, failed.execution.session_id);
        assert_eq!(retry.execution.worktree, failed.execution.worktree);
        assert_eq!(retry.resume_execution_id.as_deref(), Some(failed.execution.id.as_str()));
        if route == "graph" { assert!(retry.preserved_workspace.is_some()); }
        assert_eq!(fs::read_to_string(partial).unwrap(), "preserve");
    }
}

#[test]
fn missing_session_after_a_completed_turn_is_not_silently_restarted() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.set_route("serial").unwrap();
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    runtime.finish(&first.execution, Ok((String::new(), "done".into()))).unwrap();
    runtime.intervene("task", "follow up").unwrap();
    let failed = runtime.jobs().unwrap().remove(0);
    runtime.finish(&failed.execution, Err("unknown follow-up failure".into())).unwrap();
    runtime.jobs().unwrap();
    assert!(runtime.state.can_resume());
    runtime.pause(false).unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(!retry.initial_recovery, "lost completed history must not be replaced by a fresh task");
    assert!(retry.continuation);
    assert!(retry.task.is_empty());
}

fn check_unstarted_source_direct_followup(fork_created: bool) {
    let (_temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    record_session(&runtime, &first.execution);
    runtime.finish(&first.execution, Ok((runtime.state.base.clone(), "done".into()))).unwrap();
    runtime.emit(EventKind::PublicationCompleted { head: runtime.state.base.clone() }).unwrap();
    runtime.intervene("task", "the original follow-up").unwrap();
    let failed = runtime.jobs().unwrap().remove(0);
    assert!(failed.source_direct);
    let first_anchor = failed.session_fork.as_ref().unwrap();
    let root = runtime.root.clone();
    if fork_created {
        crate::session_branch::fork_session(
            &root.join("sessions").join(&first_anchor.id), &first_anchor.session_id, Path::new(&first_anchor.worktree),
            &root.join("sessions").join(&failed.execution.id), &failed.execution.session_id,
            Path::new(&failed.execution.worktree),
        ).unwrap();
    }
    // Fail before Pi received the follow-up, with or without a prepared fork.
    runtime.finish(&failed.execution, Err("unknown startup failure".into())).unwrap();
    runtime.jobs().unwrap();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    runtime.pause(false).unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.source_direct);
    assert!(!retry.initial_recovery);
    assert!(!retry.continuation);
    assert_eq!(retry.task, "the original follow-up");
    assert_eq!(Path::new(&retry.execution.worktree), source.as_path());
    let fork = if fork_created {
        assert!(retry.session_fork.is_none());
        assert_eq!(retry.resume_execution_id.as_deref(), Some(failed.execution.id.as_str()));
        root.join("sessions").join(&failed.execution.id)
            .join(format!("grapher_{}.jsonl", failed.execution.session_id))
    } else {
        let anchor = retry.session_fork.as_ref().unwrap();
        assert_eq!(anchor.id, first.execution.id);
        crate::session_branch::fork_session(
            &root.join("sessions").join(&anchor.id), &anchor.session_id, Path::new(&anchor.worktree),
            &root.join("sessions").join(&retry.execution.id), &retry.execution.session_id,
            Path::new(&retry.execution.worktree),
        ).unwrap();
        root.join("sessions").join(&retry.execution.id)
            .join(format!("grapher_{}.jsonl", retry.execution.session_id))
    };
    assert!(fs::read_to_string(fork).unwrap().contains("retained session context"));
}

#[test]
fn unstarted_source_direct_followup_preserves_session_and_instruction() {
    for fork_created in [false, true] {
        check_unstarted_source_direct_followup(fork_created);
    }
}

#[test]
fn unstarted_followup_in_an_existing_session_replays_only_its_original_instruction() {
    for route in ["graph", "serial"] {
        let (_temp, source, mut runtime) = setup(true, single());
        runtime.set_route(route).unwrap();
        runtime.approve().unwrap();
        let first = runtime.jobs().unwrap().remove(0);
        if route == "graph" {
            workspace::prepare(&source, Path::new(&first.execution.worktree), &first.execution.before, &[]).unwrap();
        }
        record_session(&runtime, &first.execution);
        runtime.finish(&first.execution, Ok((runtime.state.base.clone(), "done".into()))).unwrap();
        runtime.intervene("task", "the original follow-up").unwrap();
        let failed = runtime.jobs().unwrap().remove(0);
        assert_eq!(failed.execution.session_id, first.execution.session_id);
        runtime.finish(&failed.execution, Err("failed before launch".into())).unwrap();
        runtime.jobs().unwrap();
        let root = runtime.root.clone();
        drop(runtime);
        let mut runtime = Runtime::open(&root).unwrap();
        runtime.pause(false).unwrap();
        let retry = runtime.jobs().unwrap().remove(0);
        assert!(!retry.initial_recovery);
        assert!(!retry.continuation);
        assert_eq!(retry.task, "the original follow-up");
        assert_eq!(retry.execution.session_id, first.execution.session_id);
        assert_eq!(retry.resume_execution_id.as_deref(), Some(first.execution.id.as_str()));
    }
}

#[test]
fn missing_feedback_fork_uses_the_target_session_and_original_instruction() {
    let graph = Graph {
        original_goal: "recover feedback".into(),
        nodes: ["owner", "review"].into_iter().map(|name| Node {
            name: name.into(), task: name.into(),
        }).collect(),
        edges: vec![],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    let owner = &jobs.iter().find(|job| job.execution.node == "owner").unwrap().execution;
    let review = &jobs.iter().find(|job| job.execution.node == "review").unwrap().execution;
    fs::create_dir_all(&owner.worktree).unwrap();
    fs::create_dir_all(&review.worktree).unwrap();
    record_session(&runtime, owner);
    runtime.finish(owner, Ok((runtime.state.base.clone(), "owner done".into()))).unwrap();
    runtime.finish(review, Ok((runtime.state.base.clone(), "review done".into()))).unwrap();
    runtime.emit(EventKind::Invalidated {
        nodes: vec!["owner".into()], target: "owner".into(), instruction: "apply the review".into(),
        human: false, images: None, workspace: Some(FeedbackWorkspace {
            source_execution_id: review.id.clone(), target_execution_id: owner.id.clone(),
            worktree: review.worktree.clone(), head: runtime.state.base.clone(), additional_sources: vec![],
        }), shared_workspace: false, source_direct: false,
    }).unwrap();
    let failed = runtime.jobs().unwrap().remove(0);
    assert!(failed.session_fork.is_some());
    runtime.finish(&failed.execution, Err("unknown startup failure".into())).unwrap();
    runtime.jobs().unwrap();
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    runtime.pause(false).unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(!retry.initial_recovery);
    assert!(!retry.continuation);
    assert_eq!(retry.task, "apply the review");
    assert_eq!(retry.feedback_workspace.as_ref().unwrap().source_execution_id, review.id);
    assert_eq!(retry.execution.worktree, review.worktree);
    let anchor = retry.session_fork.as_ref().unwrap();
    assert_eq!(anchor.id, owner.id);
    crate::session_branch::fork_session(
        &root.join("sessions").join(&anchor.id), &anchor.session_id, Path::new(&anchor.worktree),
        &root.join("sessions").join(&retry.execution.id), &retry.execution.session_id,
        Path::new(&retry.execution.worktree),
    ).unwrap();
    let fork = root.join("sessions").join(&retry.execution.id)
        .join(format!("grapher_{}.jsonl", retry.execution.session_id));
    assert!(fs::read_to_string(fork).unwrap().contains("retained session context"));
}

#[test]
fn missing_session_after_observed_activity_never_restarts_the_original_task() {
    for route in ["graph", "serial"] {
        let (_temp, source, mut runtime) = setup(true, single());
        runtime.set_route(route).unwrap();
        runtime.approve().unwrap();
        let failed = runtime.jobs().unwrap().remove(0);
        if route == "graph" {
            workspace::prepare(&source, Path::new(&failed.execution.worktree), &failed.execution.before, &[]).unwrap();
            runtime.emit(EventKind::Prepared {
                execution_id: failed.execution.id.clone(), head: failed.execution.before.clone(),
            }).unwrap();
        }
        runtime.emit_outputs(vec![EventKind::Output {
            execution_id: failed.execution.id.clone(),
            text: "{\"type\":\"grapher_process_started\",\"pid\":1234}\n{\"type\":\"tool_execution_start\",\"toolName\":\"bash\"}\n".into(),
        }]).unwrap();
        runtime.finish(&failed.execution, Err("unrecognized failure".into())).unwrap();
        runtime.jobs().unwrap();
        let root = runtime.root.clone();
        drop(runtime);
        let mut runtime = Runtime::open(&root).unwrap();
        assert_eq!(runtime.state.executions[0].pid, Some(1234));
        for _ in 0..2 {
            assert!(runtime.state.can_resume());
            runtime.pause(false).unwrap();
            let retry = runtime.jobs().unwrap().remove(0);
            assert!(retry.continuation);
            assert!(!retry.initial_recovery, "missing history must not be replaced with a fresh task");
            assert!(retry.task.is_empty());
            assert_eq!(retry.execution.session_id, failed.execution.session_id);
            assert!(crate::session_branch::validate_session(
                &root.join("sessions").join(&failed.execution.id), &retry.execution.session_id,
                Path::new(&retry.execution.worktree),
            ).is_err(), "production fails explicitly instead of silently starting over");
            runtime.finish(&retry.execution, Err("Cannot resume node session: missing history".into())).unwrap();
            runtime.jobs().unwrap();
        }
    }
}

#[cfg(not(feature = "fixture"))]
#[test]
fn production_continue_fails_closed_when_an_active_session_is_missing() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.set_route("serial").unwrap();
    runtime.approve().unwrap();
    let failed = runtime.jobs().unwrap().remove(0);
    runtime.emit_outputs(vec![EventKind::Output {
        execution_id: failed.execution.id.clone(),
        text: "{\"type\":\"grapher_process_started\",\"pid\":1234}\n{\"type\":\"tool_execution_start\",\"toolName\":\"bash\"}\n".into(),
    }]).unwrap();
    runtime.finish(&failed.execution, Err("unrecognized failure".into())).unwrap();
    runtime.jobs().unwrap();
    runtime.pause(false).unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.continuation && !retry.initial_recovery);
    let error = crate::engine::execute(
        &retry.config, &retry.execution, &retry.task, retry.feedback_source,
        retry.resume_execution_id.as_deref(), retry.continuation, retry.initial_recovery,
        retry.images.as_deref(), &runtime.root, |_| {},
    ).unwrap_err();
    assert!(error.contains("Cannot resume node session"), "{error}");
}

#[cfg(feature = "fixture")]
#[test]
fn unmanaged_composition_failure_can_retry_without_forking_a_missing_session() {
    let graph = Graph {
        original_goal: "recover composition".into(),
        nodes: ["first", "after", "other"].into_iter().map(|name| Node {
            name: name.into(), task: name.into(),
        }).collect(),
        edges: vec![Edge { from: "first".into(), to: "after".into(), feedback: false }],
    };
    let (temp, source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    let first = &jobs.iter().find(|job| job.execution.node == "first").unwrap().execution;
    let other = &jobs.iter().find(|job| job.execution.node == "other").unwrap().execution;
    workspace::prepare(&source, Path::new(&other.worktree), &other.before, &[]).unwrap();
    runtime.finish(other, Ok((runtime.state.base.clone(), "done".into()))).unwrap();
    runtime.finish(first, Err("Workspace composition failed: opaque underlying error".into())).unwrap();
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.nodes["first"].status, "blocked");
    assert_eq!(runtime.state.nodes["after"].status, "blocked");
    assert_eq!(runtime.state.preparation_failed_nodes(), vec!["first"]);
    assert!(runtime.state.can_resume());
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    assert!(runtime.state.can_resume());
    runtime.pause(false).unwrap();
    assert_eq!(runtime.state.nodes["after"].status, "waiting");
    let mut retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.execution.node, "first");
    assert!(retry.initial_recovery);
    assert!(retry.session_fork.is_none(), "a missing session cannot be forked");
    assert_eq!(retry.resume_execution_id.as_deref(), Some(first.id.as_str()));
    assert_eq!(retry.execution.session_id, first.session_id);
    assert_eq!(retry.execution.worktree, other.worktree, "the idle slot is safely reusable");
    let script = temp.path().join("recover.mjs");
    fs::write(&script, "for await (const chunk of process.stdin) {}\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Recovered'}]}}));\n").unwrap();
    retry.config.pi_command = crate::native::trusted_node().unwrap().to_string_lossy().into();
    retry.config.pi_args = vec![script.to_string_lossy().into()];
    let result = perform(&retry, &root, &[], |_| {}, |head| runtime.emit(EventKind::Prepared {
        execution_id: retry.execution.id.clone(), head,
    }));
    runtime.finish(&retry.execution, result.clone()).unwrap();
    result.expect("initial recovery should dispatch without a nonexistent session fork");
    assert_eq!(runtime.state.nodes["first"].status, "completed");
    assert_eq!(runtime.jobs().unwrap()[0].execution.node, "after");
}

#[test]
fn upstream_block_does_not_turn_an_old_descendant_failure_into_a_recovery_root() {
    let graph = Graph {
        original_goal: "recompute after upstream failure".into(),
        nodes: ["first", "after"].into_iter().map(|name| Node { name: name.into(), task: name.into() }).collect(),
        edges: vec![Edge { from: "first".into(), to: "after".into(), feedback: false }],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    runtime.finish(&first.execution, Ok((runtime.state.base.clone(), "done".into()))).unwrap();
    let after = runtime.jobs().unwrap().remove(0);
    runtime.finish(&after.execution, Err("old descendant failure".into())).unwrap();
    runtime.intervene("first", "recompute first").unwrap();
    let again = runtime.jobs().unwrap().remove(0);
    runtime.finish(&again.execution, Err("new upstream failure".into())).unwrap();
    runtime.emit(EventKind::Blocked {
        node: "after".into(), error: "Required upstream branch failed or is blocked".into(),
    }).unwrap();
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.nodes["after"].status, "blocked");
    assert!(runtime.state.preparation_failed_nodes().is_empty(), "the block belongs to the upstream failure");
    runtime.pause(false).unwrap();
    assert_eq!(runtime.state.nodes["after"].status, "waiting");
    assert!(!runtime.state.nodes["after"].continuation, "the descendant must recompute, not resume its old failure");
}

fn check_implicit_unpause_after_intervention(error: &str) {
    let graph = Graph {
        nodes: ["interrupted", "unknown"].into_iter().map(|name| Node {
            name: name.into(), task: name.into(),
        }).collect(),
        ..Graph::default()
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    let interrupted = &jobs.iter().find(|job| job.execution.node == "interrupted").unwrap().execution;
    let unknown = &jobs.iter().find(|job| job.execution.node == "unknown").unwrap().execution;
    record_session(&runtime, interrupted);
    record_session(&runtime, unknown);
    runtime.pause(true).unwrap();
    runtime.finish(interrupted, Err("Application stopped during this execution".into())).unwrap();
    runtime.finish(unknown, Err(error.into())).unwrap();
    runtime.resume_after_intervention().unwrap();
    assert_eq!(runtime.state.nodes["unknown"].status, "failed");
    assert_eq!(runtime.store.load(&runtime.state.run_id).unwrap().nodes["unknown"].status, "failed");
    let retry = runtime.jobs().unwrap();
    assert_eq!(retry.len(), 1);
    assert_eq!(retry[0].execution.node, "interrupted");
    runtime.finish(&retry[0].execution, Ok((runtime.state.base.clone(), "recovered".into()))).unwrap();
    runtime.jobs().unwrap();
    assert!(runtime.state.can_resume());
    runtime.pause(false).unwrap();
    let retry = runtime.jobs().unwrap();
    assert_eq!(retry.len(), 1);
    assert_eq!(retry[0].execution.node, "unknown", "explicit Continue opts in the unrelated failure");
}

#[test]
fn implicit_unpause_after_intervention_does_not_retry_unrelated_failures() {
    for error in ["unrecognized failure", "Connection error.", "OAuth refresh failed: invalid_grant"] {
        check_implicit_unpause_after_intervention(error);
    }
}

#[test]
fn recovery_hint_excludes_superseded_attempts_and_publication() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let failed = runtime.jobs().unwrap().remove(0);
    runtime.finish(&failed.execution, Err("unknown failure".into())).unwrap();
    runtime.jobs().unwrap();
    assert!(runtime.state.can_resume());
    let mut missing_reason = runtime.state.clone();
    missing_reason.nodes.get_mut("task").unwrap().error = None;
    assert!(missing_reason.can_resume(), "recovery does not require an error message");
    let mut superseded = runtime.state.clone();
    superseded.superseded_execution_ids.push(failed.execution.id.clone());
    assert!(!superseded.can_resume());
    for phase in ["completed", "publishing", "merging", "publication_failed"] {
        let mut snapshot = runtime.state.clone();
        snapshot.phase = phase.into();
        assert!(!snapshot.can_resume(), "{phase} has its own lifecycle");
    }
}

#[test]
fn a_workspace_alias_alone_does_not_authorize_source_direct_recovery() {
    let (_temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let failed = runtime.jobs().unwrap().remove(0);
    runtime.finish(&failed.execution, Err("unknown failure".into())).unwrap();
    runtime.jobs().unwrap();
    // Model a corrupt or aliased Graph slot, without any source-direct message
    // claim. A matching path must not grant source-direct execution.
    runtime.state.executions[0].worktree = source.to_string_lossy().into_owned();
    runtime.pause(false).unwrap();
    assert!(!runtime.state.nodes["task"].source_direct_recovery);
}

#[test]
fn legacy_recovery_event_keeps_its_original_replay_semantics() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let failed = runtime.jobs().unwrap().remove(0);
    runtime.finish(&failed.execution, Err("unknown failure".into())).unwrap();
    let event = EventKind::RecoveryQueued {
        nodes: vec!["task".into()], continuation_nodes: vec!["task".into()], resume_failed: false,
        source_direct_nodes: vec![],
    };
    let json = serde_json::to_value(&event).unwrap();
    assert!(json.get("resume_failed").is_none(), "old events omit the new flag");
    assert!(json.get("source_direct_nodes").is_none(), "old events omit source-direct recovery");
    runtime.emit(serde_json::from_value(json).unwrap()).unwrap();
    assert!(!runtime.state.nodes["task"].continuation);
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    assert!(!replay.nodes["task"].continuation, "legacy replay must not reinterpret the old event");
}
