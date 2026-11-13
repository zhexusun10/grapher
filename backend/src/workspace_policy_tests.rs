use super::*;

fn graph(names: &[&str], edges: &[(&str, &str)]) -> Graph {
    Graph {
        original_goal: "batch workspaces".into(),
        nodes: names
            .iter()
            .map(|name| Node {
                name: (*name).into(),
                task: (*name).into(),
            })
            .collect(),
        edges: edges
            .iter()
            .map(|(from, to)| Edge {
                from: (*from).into(),
                to: (*to).into(),
                feedback: false,
            })
            .collect(),
    }
}

fn adaptive(git: bool, plan: Graph, isolate: bool, limit: usize) -> (TempDir, PathBuf, Runtime) {
    let (temp, source, mut runtime) = setup(git, plan.clone());
    if !git {
        workspace::remove_shadow_repo(&source).unwrap();
    }
    let mut config = runtime.state.config.clone().unwrap();
    config.isolate_parallel_nodes = isolate;
    config.max_parallel = limit;
    runtime.create(plan, config).unwrap();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();
    (temp, source, runtime)
}

fn finish_shared(runtime: &mut Runtime, job: &Job, output: &str) {
    assert!(job.source_direct);
    runtime
        .finish(&job.execution, Ok((String::new(), output.into())))
        .unwrap();
}

#[cfg(feature = "fixture")]
fn prepare_private(runtime: &mut Runtime, job: &mut Job) {
    assert!(!job.source_direct);
    attach(runtime, job);
    let root = runtime.root.clone();
    let result = perform_with_merger(
        job,
        &root,
        &[],
        |_| {},
        |head| {
            runtime.emit(EventKind::Prepared {
                execution_id: job.execution.id.clone(),
                head,
            })?;
            Err("prepared only".into())
        },
        |_| Err("unexpected composition conflict".into()),
    );
    assert_eq!(result.unwrap_err(), "prepared only");
}

#[cfg(feature = "fixture")]
fn finish_private(runtime: &mut Runtime, job: &Job, file: &str, output: &str) {
    let path = Path::new(&job.execution.worktree);
    let repository = runtime.source_repository().unwrap().unwrap();
    fs::write(
        path.join(file),
        format!("{} attempt {}", job.execution.node, job.execution.attempt),
    )
    .unwrap();
    let head = workspace::snapshot_node_for_run(
        path,
        &repository,
        &job.execution.node,
        Some(&runtime.state.run_id),
    )
    .unwrap();
    runtime
        .finish(&job.execution, Ok((head, output.into())))
        .unwrap();
}

/// Exercise the same recoverable publication boundary as the server, without
/// launching a model. All file transfers still go through real Git publication.
#[cfg(feature = "fixture")]
fn deliver_batch(runtime: &mut Runtime) {
    assert_eq!(runtime.state.phase, "publishing");
    let recoveries = runtime
        .state
        .batch_handoff
        .as_ref()
        .unwrap()
        .recovery_execution_ids
        .clone();
    if !recoveries.is_empty() {
        let config = runtime.state.config.as_ref().unwrap();
        let heads = recoveries
            .iter()
            .map(|id| {
                let execution = runtime
                    .state
                    .executions
                    .iter()
                    .find(|execution| execution.id == *id)
                    .unwrap();
                let head = Runtime::capture_batch_recovery(
                    &runtime.root,
                    &runtime.state.run_id,
                    config,
                    execution,
                )
                .unwrap();
                (id.clone(), head)
            })
            .collect();
        runtime.record_batch_recoveries(heads).unwrap();
    }
    let publication = runtime.state.publication.clone().unwrap();
    let head = crate::graph_merge::merge_graph_scoped(
        Path::new(&publication.repository),
        &publication.heads,
        &runtime.exclusions().unwrap(),
        |_| Err("unexpected publication conflict".into()),
    )
    .unwrap();
    runtime
        .emit_outputs(vec![EventKind::PublicationCompleted { head }])
        .unwrap();
    assert_eq!(
        runtime.state.phase, "running",
        "delivery alone never completes unfinished nodes"
    );
}

#[cfg(feature = "fixture")]
#[test]
fn resolved_private_inputs_are_delivered_before_source_retry_across_restart() {
    for (git, prepared) in [(false, false), (false, true), (true, false), (true, true)] {
        let (_temp, source, mut runtime) =
            adaptive(git, graph(&["a", "b", "c"], &[]), true, 0);
        let mut resolved_id = String::new();
        for mut job in runtime.jobs().unwrap() {
            if job.execution.node == "a" && !prepared {
                // Materialized project inputs exist, but preparation has not yet
                // emitted Prepared or admitted an agent/session.
                attach(&mut runtime, &mut job);
                workspace::prepare(
                    &source, Path::new(&job.execution.worktree), &job.execution.before, &[],
                ).unwrap();
            } else {
                prepare_private(&mut runtime, &mut job);
            }
            if job.execution.node == "a" {
                let path = Path::new(&job.execution.worktree);
                fs::write(path.join("resolved-input.txt"), "manual resolution").unwrap();
                workspace::snapshot_node_for_run(
                    path, &source, "a", Some(&runtime.state.run_id),
                ).unwrap();
                runtime.finish(&job.execution, Err("Workspace composition blocked".into())).unwrap();
                resolved_id = job.execution.id.clone();
            } else {
                finish_private(&mut runtime, &job, &format!("{}.txt", job.execution.node), "done");
            }
        }
        runtime.jobs().unwrap();
        deliver_batch(&mut runtime);
        runtime.jobs().unwrap();
        let root = runtime.root.clone();
        drop(runtime);
        let mut runtime = Runtime::open(&root).unwrap();
        let previous = runtime.state.executions.iter()
            .find(|execution| execution.id == resolved_id).unwrap();
        assert_eq!(previous.before.is_empty(), !prepared);
        assert_eq!(runtime.state.events.iter().any(|event| matches!(&event.kind,
            EventKind::Prepared { execution_id, .. } if execution_id == &resolved_id)), prepared);
        runtime.resolved("a").unwrap();
        let resolved_head = runtime.state.nodes["a"].head.clone().unwrap();
        drop(runtime);
        let mut runtime = Runtime::open(&root).unwrap();
        runtime.resume_scheduling().unwrap();
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.phase, "publishing");
        assert_eq!(runtime.state.publication.as_ref().unwrap().heads, [resolved_head.clone()]);
        assert!(runtime.state.batch_handoff.as_ref().unwrap().recovery_execution_ids.is_empty());
        assert!(!source.join("resolved-input.txt").exists());

        // An interrupted handoff retries the exact resolved head, without
        // recapturing the directory or manufacturing task completion.
        drop(runtime);
        let mut runtime = Runtime::open(&root).unwrap();
        assert_eq!(runtime.state.phase, "publication_failed");
        assert!(runtime.jobs().unwrap().is_empty());
        runtime.retry_publication().unwrap();
        assert_eq!(runtime.state.publication.as_ref().unwrap().heads, [resolved_head]);
        deliver_batch(&mut runtime);
        runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
        let previous = runtime.state.executions.iter().find(|execution| execution.id == resolved_id).unwrap();
        assert_eq!(previous.status, "resolved");
        assert!(previous.after.is_none());
        assert_eq!(runtime.state.nodes["a"].status, "dirty");
        let retry = runtime.jobs().unwrap().remove(0);
        assert!(retry.source_direct);
        assert_eq!(Path::new(&retry.execution.worktree), source);
        assert_eq!(fs::read_to_string(source.join("resolved-input.txt")).unwrap(), "manual resolution");
        finish_shared(&mut runtime, &retry, "done");
        runtime.jobs().unwrap();
        assert_eq!(runtime.state.phase, "completed");
        assert_eq!(runtime.state.events.iter().filter(|event|
            matches!(event.kind, EventKind::PublicationCompleted { .. })).count(), 2);
    }
}

#[cfg(feature = "fixture")]
#[test]
fn resolved_rejects_missing_or_rewritten_preparation_evidence() {
    for damage in ["missing", "non-commit", "rewritten", "recorded"] {
        let (_temp, source, mut runtime) =
            adaptive(true, graph(&["a", "b", "c"], &[]), true, 0);
        let mut target = None;
        for mut job in runtime.jobs().unwrap() {
            if damage == "recorded" && job.execution.node == "a" {
                prepare_private(&mut runtime, &mut job);
            } else {
                attach(&mut runtime, &mut job);
                workspace::prepare(
                    &source, Path::new(&job.execution.worktree), &job.execution.before, &[],
                ).unwrap();
            }
            runtime.finish(&job.execution, Err("Workspace composition blocked".into())).unwrap();
            if job.execution.node == "a" {
                target = Some(job.execution);
            }
        }
        let target = target.unwrap();
        let path = Path::new(&target.worktree);
        match damage {
            "missing" => {
                workspace::git(path, &["update-ref", "-d", "refs/grapher/base"]).unwrap();
            }
            "non-commit" => {
                let tree = workspace::git(path, &["rev-parse", "HEAD^{tree}"]).unwrap();
                workspace::git(path, &["update-ref", "refs/grapher/base", &tree]).unwrap();
            }
            _ => {
                let tree = workspace::git(path, &["rev-parse", "HEAD^{tree}"]).unwrap();
                let head = workspace::git(path, &["commit-tree", &tree, "-m", "unrelated history"]).unwrap();
                workspace::git(path, &["update-ref", "HEAD", &head]).unwrap();
                if damage == "recorded" {
                    // A valid but different local ref must not override the
                    // stronger head already persisted by Prepared.
                    workspace::git(path, &["update-ref", "refs/grapher/base", &head]).unwrap();
                }
            }
        }
        fs::write(path.join("repair.txt"), "retain uncommitted manual work").unwrap();
        let head = workspace::git(path, &["rev-parse", "HEAD"]).unwrap();
        let index_path = workspace::private_git_dir(path).unwrap().join("index");
        let index = fs::read(&index_path).unwrap();
        runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
        let error = runtime.resolved("a").unwrap_err();
        assert!(error.contains("preparation base") || error.contains("prepared Git history"),
            "{damage}: {error}");
        assert_eq!(runtime.state.nodes["a"].status, "blocked");
        assert_eq!(runtime.state.executions.iter().find(|execution| execution.id == target.id).unwrap().status, "failed");
        assert!(!runtime.state.events.iter().any(|event|
            matches!(event.kind, EventKind::WorkspaceResolved { .. })));
        assert_eq!(workspace::git(path, &["rev-parse", "HEAD"]).unwrap(), head);
        assert_eq!(fs::read(index_path).unwrap(), index);
        assert_eq!(fs::read_to_string(path.join("repair.txt")).unwrap(), "retain uncommitted manual work");
        assert!(!source.join("repair.txt").exists());
    }
}

#[test]
fn one_and_two_nodes_share_source_without_snapshots_or_environment() {
    for git in [false, true] {
        for count in [1, 2] {
            let (_temp, source, mut runtime) =
                adaptive(git, graph(&["a", "b"][..count], &[]), true, 0);
            assert!(runtime.state.base.is_empty());
            assert!(runtime.state.environment_baseline.is_none());
            let jobs = runtime.jobs().unwrap();
            assert_eq!(jobs.len(), count);
            for job in &jobs {
                assert_eq!(Path::new(&job.execution.worktree), source);
                assert!(job.source_direct);
                assert!(!job.materialize_source);
                assert!(job.config.environment.is_none());
                assert!(job.environment_input.is_none());
            }
            if count == 2 {
                assert_ne!(jobs[0].execution.session_id, jobs[1].execution.session_id);
                fs::write(source.join("intermediate.txt"), "live").unwrap();
                assert_eq!(
                    fs::read_to_string(
                        Path::new(&jobs[1].execution.worktree).join("intermediate.txt")
                    )
                    .unwrap(),
                    "live"
                );
            }
            assert!(runtime.planner_workspace().unwrap().is_none());
            assert_eq!(
                runtime.planner_workspace_targets(None, &source).unwrap(),
                serde_json::json!({})
            );
            for job in jobs {
                finish_shared(&mut runtime, &job, "done");
            }
            runtime.jobs().unwrap();
            assert_eq!(runtime.state.phase, "completed");
            assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_none());
            assert!(!runtime.run_workspace_root().exists());
            assert!(!runtime
                .state
                .events
                .iter()
                .any(|event| matches!(event.kind, EventKind::PublicationStarted { .. })));
            assert_eq!(
                runtime
                    .store
                    .load(&runtime.state.run_id)
                    .unwrap()
                    .isolated_workspaces,
                Some(false)
            );
            let id = runtime.state.run_id.clone();
            runtime.delete_run(&id).unwrap();
            assert!(source.join("tracked.txt").is_file());
        }
    }
}

#[test]
fn shared_source_dispatches_ready_children_while_unrelated_sibling_runs() {
    for git in [false, true] {
        for isolate in [false, true] {
            let (_temp, source, mut runtime) = adaptive(
                git,
                graph(
                    &["foundation", "agent-runtime", "landing", "streaming-chat", "workspace-shell", "integration"],
                    &[
                        ("foundation", "agent-runtime"), ("foundation", "landing"),
                        ("agent-runtime", "streaming-chat"), ("agent-runtime", "workspace-shell"),
                        ("landing", "integration"), ("streaming-chat", "integration"), ("workspace-shell", "integration"),
                    ],
                ),
                isolate,
                10,
            );
            let foundation = runtime.jobs().unwrap().remove(0);
            finish_shared(&mut runtime, &foundation, "done");
            let first = runtime.jobs().unwrap();
            assert_eq!(first.len(), 2);
            finish_shared(&mut runtime, first.iter().find(|job| job.execution.node == "agent-runtime").unwrap(), "done");
            // Replay while landing is still live, rather than inventing readiness
            // in memory or waiting for the whole displayed topology layer.
            runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
            let children = runtime.jobs().unwrap();
            assert_eq!(children.iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(),
                ["streaming-chat", "workspace-shell"]);
            assert_eq!(runtime.state.nodes["landing"].status, "running");
            assert_eq!(runtime.state.nodes["integration"].status, "waiting");
            assert_eq!(runtime.state.isolated_workspaces, Some(false));
            assert!(children.iter().all(|job| job.source_direct
                && Path::new(&job.execution.worktree) == source
                && job.config.environment.is_none() && job.environment_input.is_none()));
            assert!(runtime.jobs().unwrap().is_empty(), "never dispatch a live node twice");
            for job in &children {
                finish_shared(&mut runtime, job, "done");
            }
            assert!(runtime.jobs().unwrap().is_empty(), "integration still requires landing");
            finish_shared(&mut runtime, first.iter().find(|job| job.execution.node == "landing").unwrap(), "done");
            let integration = runtime.jobs().unwrap().remove(0);
            assert_eq!(integration.execution.node, "integration");
            finish_shared(&mut runtime, &integration, "done");
            runtime.jobs().unwrap();
            assert_eq!(runtime.state.phase, "completed");
            assert!(runtime.state.environment_baseline.is_none());
            assert!(!runtime.run_workspace_root().exists());
            assert!(!runtime.state.events.iter().any(|event|
                matches!(event.kind, EventKind::PublicationStarted { .. })));
        }
    }
}

#[test]
fn shared_replenishment_pins_source_and_respects_available_worker_slots() {
    for limit in [0, 2, 3] {
        let (_temp, source, mut runtime) = adaptive(
            false,
            graph(&["slow", "fast", "c", "d", "e", "f", "g", "h", "i", "j"],
                &[("fast", "c"), ("fast", "d"), ("fast", "e"), ("fast", "f"),
                  ("fast", "g"), ("fast", "h"), ("fast", "i"), ("fast", "j")]),
            true,
            limit,
        );
        let first = runtime.jobs().unwrap();
        assert_eq!(first.len(), 2);
        finish_shared(&mut runtime, first.iter().find(|job| job.execution.node == "fast").unwrap(), "done");
        let capacity = if limit == 0 { DEFAULT_MAX_PARALLEL } else { limit };
        let next = runtime.jobs().unwrap();
        assert_eq!(next.len(), capacity - 1);
        assert!(next.iter().all(|job| job.source_direct
            && Path::new(&job.execution.worktree) == source && !job.materialize_source));
        assert_eq!(runtime.state.isolated_workspaces, Some(false),
            "even a replenishment larger than two cannot switch live source writers to private");
        assert!(runtime.state.environment_baseline.is_none());
        assert!(runtime.jobs().unwrap().is_empty());
        finish_shared(&mut runtime, first.iter().find(|job| job.execution.node == "slow").unwrap(), "done");
        runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
        let refill = runtime.jobs().unwrap();
        assert_eq!(refill.len(), 1);
        assert!(refill[0].source_direct);
        assert_eq!(runtime.state.nodes.values().filter(|node| node.status == "running").count(), capacity);
        assert!(runtime.jobs().unwrap().is_empty());
    }
}

#[test]
fn active_shared_batches_do_not_validate_source_without_dispatchable_work() {
    for full in [false, true] {
        let (_temp, source, mut runtime) = adaptive(false,
            graph(&["a", "b", "child"], &[("a", "child"), ("b", "child")]), true, 2);
        let first = runtime.jobs().unwrap();
        if !full {
            finish_shared(&mut runtime, &first[0], "done");
        }
        let moved = source.with_file_name("moved-source");
        fs::rename(&source, &moved).unwrap();
        // No new dispatch or handoff is possible. Do not halt a driver and
        // abandon its in-flight completion channel just to recheck admission.
        assert!(runtime.jobs().unwrap().is_empty());
        fs::rename(&moved, &source).unwrap();
        assert!(runtime.state.nodes.values().any(|node| node.status == "running"));
    }
}

#[test]
fn invalid_source_defers_shared_replenishment_error_until_existing_workers_drain() {
    let (_temp, source, mut runtime) = adaptive(false,
        graph(&["a", "b", "child"], &[("a", "child")]), true, 3);
    let first = runtime.jobs().unwrap();
    finish_shared(&mut runtime, &first[0], "done");
    let moved = source.with_file_name("moved-source");
    fs::rename(&source, &moved).unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.nodes["child"].status, "waiting");
    assert_eq!(runtime.state.executions.len(), 2, "invalid binding never admits a child");
    finish_shared(&mut runtime, &first[1], "done");
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    assert!(runtime.jobs().is_err(), "an idle Run must surface invalid admission explicitly");
    assert_eq!(runtime.state.phase, "running");
    assert_eq!(runtime.state.executions.len(), 2);
    fs::rename(&moved, &source).unwrap();
    let child = runtime.jobs().unwrap().remove(0);
    assert_eq!(child.execution.node, "child");
    finish_shared(&mut runtime, &child, "done");
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.phase, "completed");
}

#[test]
fn restart_during_invalid_source_wait_keeps_completed_and_unstarted_work_distinct() {
    let (_temp, source, mut runtime) = adaptive(false,
        graph(&["a", "b", "child"], &[("a", "child")]), true, 2);
    let first = runtime.jobs().unwrap();
    finish_shared(&mut runtime, &first[0], "done");
    let moved = source.with_file_name("moved-source");
    fs::rename(&source, &moved).unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    assert!(runtime.state.paused);
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.nodes["a"].status, "completed");
    assert_eq!(runtime.state.nodes["child"].status, "waiting");
    assert_eq!(runtime.state.executions.len(), 2);
    fs::rename(&moved, &source).unwrap();
    runtime.pause(false).unwrap();
    let recovered = runtime.jobs().unwrap();
    assert_eq!(recovered.iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(), ["b", "child"]);
    let resumed = &recovered[0].execution;
    assert_eq!(resumed.session_id, first[1].execution.session_id);
    // Crash recovery advances the attempt; only an explicit user-stop request
    // retains the logical attempt number across separate execution records.
    assert_eq!(resumed.attempt, first[1].execution.attempt + 1);
    for job in &recovered {
        assert!(job.source_direct);
        finish_shared(&mut runtime, job, "done");
    }
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.phase, "completed");
    assert_eq!(runtime.state.executions.iter().filter(|e| e.node == "a").count(), 1);
}

#[test]
fn standalone_merger_excludes_shared_replenishment_until_it_finishes() {
    let (_temp, _source, mut runtime) = adaptive(false,
        graph(&["a", "b", "child"], &[("a", "child")]), true, 3);
    let first = runtime.jobs().unwrap();
    finish_shared(&mut runtime, &first[0], "done");
    let mut merger = first[0].execution.clone();
    merger.id = Uuid::new_v4().to_string();
    merger.session_id = merger.id.clone();
    merger.node = "merge:child".into();
    runtime.emit(EventKind::MergerStarted { execution: merger.clone() }).unwrap();
    assert_eq!(runtime.state.phase, "running", "standalone Mergers do not enter publication");
    assert!(runtime.jobs().unwrap().is_empty());
    runtime.emit(EventKind::MergerFinished {
        execution_id: merger.id, head: String::new(), output_bytes: 0, metrics: None,
    }).unwrap();
    let child = runtime.jobs().unwrap().remove(0);
    assert_eq!(child.execution.node, "child");
    assert_eq!(runtime.state.nodes["b"].status, "running");
}

#[test]
fn shared_failure_retry_and_feedback_repair_can_refill_beside_unrelated_work() {
    for feedback in [false, true] {
        let mut plan = graph(&["owner", "other", "review", "related"],
            &[("owner", "review"), ("owner", "related")]);
        if feedback {
            plan.edges.push(Edge { from: "review".into(), to: "owner".into(), feedback: true });
        }
        let (_temp, source, mut runtime) = adaptive(false, plan, true, 4);
        let first = runtime.jobs().unwrap();
        let owner = first.iter().find(|job| job.execution.node == "owner").unwrap();
        if feedback {
            finish_shared(&mut runtime, owner, "done");
            let reviews = runtime.jobs().unwrap();
            assert_eq!(reviews.len(), 2);
            let review = reviews.iter().find(|job| job.execution.node == "review").unwrap();
            finish_shared(&mut runtime, review, "correct the owner\n<FEEDBACK>");
            assert!(runtime.jobs().unwrap().is_empty(), "repair must drain its affected running scope");
            assert_eq!(runtime.state.pending_feedback.len(), 1);
            let related = reviews.iter().find(|job| job.execution.node == "related").unwrap();
            runtime.finish(&related.execution, Err("stopped for feedback".into())).unwrap();
        } else {
            fs::write(source.join("partial.txt"), "retain this work").unwrap();
            runtime.finish(&owner.execution, Err("provider failed".into())).unwrap();
            runtime.jobs().unwrap();
            assert_eq!(runtime.state.nodes["review"].status, "blocked");
            runtime.resume_node("owner").unwrap();
        }
        runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
        let retry = runtime.jobs().unwrap().remove(0);
        assert_eq!(retry.execution.node, "owner");
        assert_eq!(retry.execution.attempt, 2);
        assert!(retry.source_direct && Path::new(&retry.execution.worktree) == source);
        assert_eq!(runtime.state.nodes["other"].status, "running");
        assert_eq!(runtime.state.nodes["review"].status, if feedback { "dirty" } else { "waiting" });
        if feedback {
            assert_eq!(retry.task, "Feedback:\ncorrect the owner");
            assert_eq!(runtime.state.feedback_counts["review->owner"], 1);
            assert!(runtime.state.pending_feedback.is_empty());
        } else {
            assert_eq!(retry.execution.session_id, owner.execution.session_id);
            assert_eq!(fs::read_to_string(source.join("partial.txt")).unwrap(), "retain this work");
        }
        assert!(runtime.jobs().unwrap().is_empty());
    }
}

#[cfg(feature = "fixture")]
#[test]
fn active_private_batches_do_not_validate_source_before_the_drain_barrier() {
    let (_temp, source, mut runtime) = adaptive(false,
        graph(&["a", "b", "c", "child"], &[("a", "child")]), true, 0);
    let mut first = runtime.jobs().unwrap();
    prepare_private(&mut runtime, &mut first[0]);
    finish_private(&mut runtime, &first[0], "a.txt", "done");
    let moved = source.with_file_name("moved-source");
    fs::rename(&source, &moved).unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    fs::rename(&moved, &source).unwrap();
    assert_eq!(runtime.state.nodes["child"].status, "waiting");
    assert_eq!(runtime.state.phase, "running");
    assert!(runtime.state.batch_handoff.is_none());
}

#[test]
fn shared_replenishment_respects_pending_feedback_scope() {
    let mut plan = graph(&["owner", "review", "consumer", "other", "after-other"],
        &[("owner", "review"), ("review", "consumer"), ("other", "after-other")]);
    plan.edges.push(Edge { from: "review".into(), to: "owner".into(), feedback: true });
    let (_temp, _source, mut runtime) = adaptive(false, plan, true, 4);
    let first = runtime.jobs().unwrap();
    assert_eq!(first.len(), 2);
    finish_shared(&mut runtime, first.iter().find(|job| job.execution.node == "owner").unwrap(), "done");
    let review = runtime.jobs().unwrap().remove(0);
    assert_eq!(review.execution.node, "review");
    finish_shared(&mut runtime, &review, "<ACCEPT>");
    assert!(runtime.jobs_with_pending_feedback(true, &["review"]).unwrap().is_empty());
    finish_shared(&mut runtime, first.iter().find(|job| job.execution.node == "other").unwrap(), "done");
    let unrelated = runtime.jobs_with_pending_feedback(true, &["review"]).unwrap();
    assert_eq!(unrelated.len(), 1);
    assert_eq!(unrelated[0].execution.node, "after-other");
    assert_eq!(runtime.state.nodes["consumer"].status, "waiting");
    let consumer = runtime.jobs().unwrap();
    assert_eq!(consumer.len(), 1);
    assert_eq!(consumer[0].execution.node, "consumer");
    assert_eq!(runtime.state.nodes["after-other"].status, "running");
}

#[test]
fn shared_replenishment_respects_pause_and_restart_recovery() {
    let (_temp, source, mut runtime) = adaptive(false,
        graph(&["a", "b", "c", "d"], &[("b", "c"), ("b", "d")]), true, 2);
    let first = runtime.jobs().unwrap();
    finish_shared(&mut runtime, first.iter().find(|job| job.execution.node == "b").unwrap(), "done");
    runtime.pause(true).unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    runtime.resume_scheduling().unwrap();
    let child = runtime.jobs().unwrap().remove(0);
    assert_eq!(child.execution.node, "c");
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    assert!(runtime.state.paused);
    assert!(runtime.jobs().unwrap().is_empty(), "restart never auto-dispatches");
    assert_eq!(runtime.state.nodes["b"].status, "completed");
    runtime.pause(false).unwrap();
    let recovered = runtime.jobs().unwrap();
    assert_eq!(recovered.iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(), ["a", "c"]);
    assert!(recovered.iter().all(|job| job.source_direct && Path::new(&job.execution.worktree) == source));
    assert_eq!(runtime.state.nodes["d"].status, "waiting");
    for job in &recovered {
        finish_shared(&mut runtime, job, "done");
    }
    let last = runtime.jobs().unwrap().remove(0);
    assert_eq!(last.execution.node, "d");
    finish_shared(&mut runtime, &last, "done");
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.phase, "completed");
}

#[cfg(feature = "fixture")]
#[test]
fn private_writers_drain_before_delivering_to_ready_descendants() {
    let (_temp, source, mut runtime) = adaptive(false,
        graph(&["fast", "slow", "other", "child"], &[("fast", "child")]), true, 0);
    let mut first = runtime.jobs().unwrap();
    assert_eq!(first.len(), 3);
    for job in &mut first {
        prepare_private(&mut runtime, job);
    }
    finish_private(&mut runtime, &first[0], "fast.txt", "done");
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "running");
    assert!(runtime.state.batch_handoff.is_none());
    assert!(!source.join("fast.txt").exists());
    for job in &first[1..] {
        finish_private(&mut runtime, job, &format!("{}.txt", job.execution.node), "done");
    }
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "publishing");
    deliver_batch(&mut runtime);
    let child = runtime.jobs().unwrap().remove(0);
    assert_eq!(child.execution.node, "child");
    assert!(child.source_direct);
    assert!(source.join("fast.txt").is_file());
}

#[cfg(feature = "fixture")]
#[test]
fn private_recovery_waits_for_live_source_writers_before_handoff() {
    let (_temp, source, mut runtime) = adaptive(false,
        graph(&["a", "b", "c", "slow"], &[("b", "slow"), ("c", "slow")]), true, 0);
    let mut first = runtime.jobs().unwrap();
    for job in &mut first {
        prepare_private(&mut runtime, job);
        if job.execution.node == "a" {
            fs::write(Path::new(&job.execution.worktree).join("partial.txt"), "retained work").unwrap();
            runtime.finish(&job.execution, Err("provider failed".into())).unwrap();
        } else {
            finish_private(&mut runtime, job, &format!("{}.txt", job.execution.node), "done");
        }
    }
    runtime.jobs().unwrap();
    deliver_batch(&mut runtime);
    let slow = runtime.jobs().unwrap().remove(0);
    assert_eq!(slow.execution.node, "slow");
    assert!(slow.source_direct);
    runtime.resume_node("a").unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "running", "never publish into an active source writer");
    assert!(runtime.state.batch_handoff.is_none());
    assert!(!source.join("partial.txt").exists());
    finish_shared(&mut runtime, &slow, "done");
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.phase, "publishing");
    deliver_batch(&mut runtime);
    let retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.execution.node, "a");
    assert!(retry.source_direct);
    assert_eq!(fs::read_to_string(source.join("partial.txt")).unwrap(), "retained work");
}

#[test]
fn disabled_isolation_and_worker_limit_apply_to_every_batch_including_revisions() {
    for (isolate, limit, expected) in [(false, 0, 4), (true, 2, 2), (true, 1, 1)] {
        let (_temp, source, mut runtime) = adaptive(false, graph(&["root"], &[]), isolate, limit);
        let root = runtime.jobs().unwrap().remove(0);
        finish_shared(&mut runtime, &root, "done");
        runtime.jobs().unwrap();
        runtime
            .revise_graph(
                graph(&["root", "a", "b", "c", "d"], &[]),
                PlanningSummary::default(),
            )
            .unwrap();
        let jobs = runtime.jobs().unwrap();
        assert_eq!(jobs.len(), expected);
        assert!(jobs
            .iter()
            .all(|job| job.source_direct && Path::new(&job.execution.worktree) == source));
        assert_eq!(
            runtime
                .store
                .load(&runtime.state.run_id)
                .unwrap()
                .isolated_workspaces,
            Some(false)
        );
    }
}

#[cfg(feature = "fixture")]
#[test]
fn batches_switch_shared_private_shared_private_and_deliver_before_dependents_run() {
    for git in [false, true] {
        let (_temp, source, mut runtime) = adaptive(
            git,
            graph(
                &["root", "a", "b", "c", "join", "x", "y", "z"],
                &[
                    ("root", "a"),
                    ("root", "b"),
                    ("root", "c"),
                    ("a", "join"),
                    ("b", "join"),
                    ("c", "join"),
                    ("join", "x"),
                    ("join", "y"),
                    ("join", "z"),
                ],
            ),
            true,
            0,
        );
        let root = runtime.jobs().unwrap().remove(0);
        fs::write(source.join("root.txt"), "shared root").unwrap();
        finish_shared(&mut runtime, &root, "done");
        let mut branches = runtime.jobs().unwrap();
        assert_eq!(branches.len(), 3);
        assert_eq!(runtime.state.isolated_workspaces, Some(true));
        assert_eq!(
            branches
                .iter()
                .map(|job| &job.execution.worktree)
                .collect::<BTreeSet<_>>()
                .len(),
            3
        );
        for (index, job) in branches.iter_mut().enumerate() {
            prepare_private(&mut runtime, job);
            assert_eq!(
                fs::read_to_string(Path::new(&job.execution.worktree).join("root.txt")).unwrap(),
                "shared root"
            );
            finish_private(
                &mut runtime,
                job,
                &format!("{}.txt", job.execution.node),
                "done",
            );
            if index < 2 {
                assert!(runtime.jobs().unwrap().is_empty());
            }
        }
        assert!(!source.join("a.txt").exists());
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.phase, "publishing");
        assert!(runtime.take_shared_workspace_review().unwrap().is_none());
        runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
        deliver_batch(&mut runtime);
        assert!(
            runtime.state.publication.is_none(),
            "intermediate delivery must not render graph completion"
        );
        let join = runtime.jobs().unwrap().remove(0);
        assert!(join.source_direct);
        for name in ["a", "b", "c"] {
            assert!(source.join(format!("{name}.txt")).is_file());
        }
        fs::write(source.join("join.txt"), "fresh shared result").unwrap();
        finish_shared(&mut runtime, &join, "done");
        let mut final_batch = runtime.jobs().unwrap();
        assert_eq!(final_batch.len(), 3);
        for job in &mut final_batch {
            prepare_private(&mut runtime, job);
            assert_eq!(
                fs::read_to_string(Path::new(&job.execution.worktree).join("join.txt")).unwrap(),
                "fresh shared result"
            );
            finish_private(
                &mut runtime,
                job,
                &format!("{}.txt", job.execution.node),
                "done",
            );
        }
        runtime.jobs().unwrap();
        deliver_batch(&mut runtime);
        runtime.jobs().unwrap();
        assert_eq!(runtime.state.phase, "completed");
        assert!(runtime.take_shared_workspace_review().unwrap().is_some());
        assert!(runtime.take_shared_workspace_review().unwrap().is_none());
        let batches: Vec<_> = runtime
            .state
            .events
            .iter()
            .filter_map(|event| match &event.kind {
                EventKind::ExecutionBatchStarted { nodes, isolated } => {
                    Some((nodes.len(), *isolated))
                }
                _ => None,
            })
            .collect();
        assert_eq!(batches, [(1, false), (3, true), (1, false), (3, true)]);
        assert_eq!(
            runtime
                .state
                .events
                .iter()
                .filter(|event| matches!(event.kind, EventKind::PublicationCompleted { .. }))
                .count(),
            2
        );
        let id = runtime.state.run_id.clone();
        runtime.delete_run(&id).unwrap();
        assert!(source.join("x.txt").is_file());
    }
}

#[cfg(feature = "fixture")]
#[test]
fn failed_private_retry_preserves_uncommitted_work_across_handoff_and_restart() {
    let (_temp, source, mut runtime) = adaptive(true, graph(&["a", "b", "c"], &[]), true, 0);
    let mut jobs = runtime.jobs().unwrap();
    for job in &mut jobs {
        prepare_private(&mut runtime, job);
        if job.execution.node == "a" {
            fs::write(
                Path::new(&job.execution.worktree).join("partial.txt"),
                "unfinished work",
            )
            .unwrap();
            runtime
                .finish(&job.execution, Err("provider failed".into()))
                .unwrap();
        } else {
            finish_private(
                &mut runtime,
                job,
                &format!("{}.txt", job.execution.node),
                "done",
            );
        }
    }
    runtime.jobs().unwrap();
    deliver_batch(&mut runtime);
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.phase, "needs_attention");
    assert_eq!(
        runtime.planner_workspace().unwrap().unwrap().node,
        "a",
        "undelivered failures remain inspectable after sibling publication"
    );
    assert!(
        !source.join("partial.txt").exists(),
        "failed work is only delivered for an explicit retry"
    );
    let failed = jobs
        .iter()
        .find(|job| job.execution.node == "a")
        .unwrap()
        .execution
        .clone();
    assert!(Path::new(&failed.worktree).join("partial.txt").is_file());
    runtime.resume_node("a").unwrap();
    runtime.jobs().unwrap();
    assert_eq!(
        runtime
            .state
            .batch_handoff
            .as_ref()
            .unwrap()
            .recovery_execution_ids,
        [failed.id.clone()]
    );
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    deliver_batch(&mut runtime);
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.source_direct);
    assert_eq!(Path::new(&retry.execution.worktree), source);
    assert!(retry.preserved_workspace.is_none());
    assert_eq!(
        retry.recovered_workspace.as_deref(),
        Some(failed.worktree.as_str())
    );
    assert_eq!(
        fs::read_to_string(source.join("partial.txt")).unwrap(),
        "unfinished work"
    );
    assert_eq!(
        runtime
            .state
            .executions
            .iter()
            .find(|execution| execution.id == failed.id)
            .unwrap()
            .status,
        "failed"
    );
    finish_shared(&mut runtime, &retry, "done");
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.phase, "completed");
}

#[cfg(feature = "fixture")]
#[test]
fn later_private_batches_cannot_recycle_an_unmanaged_failed_slot() {
    let (_temp, _source, mut runtime) = adaptive(
        false,
        graph(
            &["a", "b", "c", "x", "y", "z"],
            &[("b", "x"), ("b", "y"), ("c", "z")],
        ),
        true,
        0,
    );
    let mut failed_path = String::new();
    for mut job in runtime.jobs().unwrap() {
        prepare_private(&mut runtime, &mut job);
        if job.execution.node == "a" {
            failed_path = job.execution.worktree.clone();
            fs::write(Path::new(&failed_path).join("partial.txt"), "retained").unwrap();
            runtime
                .finish(&job.execution, Err("provider failed".into()))
                .unwrap();
        } else {
            finish_private(
                &mut runtime,
                &job,
                &format!("{}.txt", job.execution.node),
                "done",
            );
        }
    }
    runtime.jobs().unwrap();
    deliver_batch(&mut runtime);
    let next = runtime.jobs().unwrap();
    assert_eq!(next.len(), 3);
    assert!(next.iter().all(|job| job.execution.worktree != failed_path));
    assert_eq!(
        fs::read_to_string(Path::new(&failed_path).join("partial.txt")).unwrap(),
        "retained"
    );
}

#[cfg(feature = "fixture")]
#[test]
fn retry_of_a_private_standalone_followup_does_not_trigger_graph_review() {
    let (_temp, _source, mut runtime) = adaptive(false, graph(&["root"], &[]), true, 0);
    let root = runtime.jobs().unwrap().remove(0);
    finish_shared(&mut runtime, &root, "done");
    runtime.jobs().unwrap();
    runtime
        .revise_graph(graph(&["root", "a", "b"], &[]), PlanningSummary::default())
        .unwrap();
    for job in runtime.jobs().unwrap() {
        finish_shared(&mut runtime, &job, "done");
    }
    runtime.jobs().unwrap();
    assert!(runtime.take_shared_workspace_review().unwrap().is_some());
    for name in ["root", "a", "b"] {
        runtime.intervene(name, "standalone follow-up").unwrap();
    }
    for mut job in runtime.jobs().unwrap() {
        prepare_private(&mut runtime, &mut job);
        if job.execution.node == "root" {
            fs::write(
                Path::new(&job.execution.worktree).join("partial-root.txt"),
                "retained",
            )
            .unwrap();
            runtime
                .finish(&job.execution, Err("provider failed".into()))
                .unwrap();
        } else {
            finish_private(
                &mut runtime,
                &job,
                &format!("{}.txt", job.execution.node),
                "done",
            );
        }
    }
    runtime.jobs().unwrap();
    deliver_batch(&mut runtime);
    runtime.jobs().unwrap();
    runtime.resume_node("root").unwrap();
    runtime.jobs().unwrap();
    deliver_batch(&mut runtime);
    let retry = runtime.jobs().unwrap().remove(0);
    finish_shared(&mut runtime, &retry, "done");
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.phase, "completed");
    assert!(runtime.take_shared_workspace_review().unwrap().is_none());
}

#[cfg(feature = "fixture")]
#[test]
fn failed_recovery_capture_stays_retryable_even_after_an_earlier_batch_published() {
    let (temp, _source, mut runtime) = adaptive(false, graph(&["a", "b", "c"], &[]), true, 0);
    let mut jobs = runtime.jobs().unwrap();
    for job in &mut jobs {
        prepare_private(&mut runtime, job);
        if job.execution.node == "a" {
            fs::write(
                Path::new(&job.execution.worktree).join("partial.txt"),
                "keep",
            )
            .unwrap();
            runtime
                .finish(&job.execution, Err("provider failed".into()))
                .unwrap();
        } else {
            finish_private(
                &mut runtime,
                job,
                &format!("{}.txt", job.execution.node),
                "done",
            );
        }
    }
    runtime.jobs().unwrap();
    deliver_batch(&mut runtime);
    runtime.jobs().unwrap();
    runtime.resume_node("a").unwrap();
    runtime.jobs().unwrap();
    let failed = runtime
        .state
        .executions
        .iter()
        .find(|execution| execution.node == "a")
        .unwrap()
        .clone();
    let parked = temp.path().join("parked");
    fs::rename(&failed.worktree, &parked).unwrap();
    let error = Runtime::capture_batch_recovery(
        &runtime.root,
        &runtime.state.run_id,
        runtime.state.config.as_ref().unwrap(),
        &failed,
    )
    .unwrap_err();
    runtime
        .emit(EventKind::PublicationFailed { error })
        .unwrap();
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    runtime.retry_publication().unwrap();
    assert_eq!(
        runtime.state.phase, "publishing",
        "empty original heads do not mean the recovery was delivered"
    );
    assert!(runtime.jobs().unwrap().is_empty());
    fs::rename(parked, &failed.worktree).unwrap();
    deliver_batch(&mut runtime);
    assert!(runtime.jobs().unwrap().remove(0).source_direct);
}

#[cfg(feature = "fixture")]
#[test]
fn captured_unchanged_recovery_can_finish_without_republishing_an_empty_head_set() {
    let (_temp, source, mut runtime) = adaptive(false, graph(&["a", "b", "c"], &[]), true, 0);
    for mut job in runtime.jobs().unwrap() {
        prepare_private(&mut runtime, &mut job);
        if job.execution.node == "a" {
            runtime
                .finish(&job.execution, Err("provider failed before edits".into()))
                .unwrap();
        } else {
            let head = workspace::snapshot_node_for_run(
                Path::new(&job.execution.worktree),
                &source,
                &job.execution.node,
                Some(&runtime.state.run_id),
            )
            .unwrap();
            runtime
                .finish(&job.execution, Ok((head, "done".into())))
                .unwrap();
        }
    }
    runtime.jobs().unwrap();
    deliver_batch(&mut runtime);
    runtime.jobs().unwrap();
    runtime.resume_node("a").unwrap();
    runtime.jobs().unwrap();
    let failed = runtime
        .state
        .executions
        .iter()
        .find(|execution| execution.node == "a")
        .unwrap();
    let head = Runtime::capture_batch_recovery(
        &runtime.root,
        &runtime.state.run_id,
        runtime.state.config.as_ref().unwrap(),
        failed,
    )
    .unwrap();
    assert!(runtime.state.published_heads.contains(&head));
    runtime
        .record_batch_recoveries([(failed.id.clone(), head)].into_iter().collect())
        .unwrap();
    runtime
        .emit(EventKind::PublicationFailed {
            error: "interrupted after capture".into(),
        })
        .unwrap();
    runtime.retry_publication().unwrap();
    assert_eq!(runtime.state.phase, "running");
    assert!(runtime.state.batch_handoff.is_none());
    assert!(runtime.jobs().unwrap().remove(0).source_direct);
}

#[cfg(feature = "fixture")]
#[test]
fn batch_conflict_blocks_next_batch_until_publication_retry_resolves_it() {
    let (_temp, source, mut runtime) = adaptive(
        false,
        graph(
            &["a", "b", "c", "join"],
            &[("a", "join"), ("b", "join"), ("c", "join")],
        ),
        true,
        0,
    );
    for mut job in runtime.jobs().unwrap() {
        prepare_private(&mut runtime, &mut job);
        finish_private(
            &mut runtime,
            &job,
            if job.execution.node == "c" {
                "c.txt"
            } else {
                "conflict.txt"
            },
            "done",
        );
    }
    runtime.jobs().unwrap();
    let publication = runtime.state.publication.clone().unwrap();
    let error = crate::graph_merge::merge_graph_scoped(&source, &publication.heads, &[], |_| {
        Err("repair required".into())
    })
    .unwrap_err();
    assert!(error.contains("repair required"));
    assert!(!source.join("conflict.txt").exists());
    runtime
        .emit(EventKind::PublicationFailed { error })
        .unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.nodes["join"].status, "waiting");
    assert!(runtime.take_shared_workspace_review().unwrap().is_none());
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    runtime.retry_publication().unwrap();
    let head = crate::graph_merge::merge_graph_scoped(&source, &publication.heads, &[], |path| {
        fs::write(path.join("conflict.txt"), "resolved together")
            .map_err(|error| error.to_string())?;
        // The test resolver acts at the host Git boundary, as a successful
        // Merger does after importing/staging its project-file resolutions.
        workspace::git(path, &["add", "conflict.txt"]).map(|_| ())
    })
    .unwrap();
    runtime
        .emit_outputs(vec![EventKind::PublicationCompleted { head }])
        .unwrap();
    let join = runtime.jobs().unwrap().remove(0);
    assert_eq!(join.execution.node, "join");
    assert!(join.source_direct);
    assert_eq!(
        fs::read_to_string(source.join("conflict.txt")).unwrap(),
        "resolved together"
    );
}

#[cfg(feature = "fixture")]
#[test]
fn private_feedback_is_delivered_before_the_single_source_repair() {
    let mut plan = graph(
        &["owner", "r1", "r2", "r3"],
        &[("owner", "r1"), ("owner", "r2"), ("owner", "r3")],
    );
    for name in ["r1", "r2", "r3"] {
        plan.edges.push(Edge {
            from: name.into(),
            to: "owner".into(),
            feedback: true,
        });
    }
    let (_temp, source, mut runtime) = adaptive(false, plan, true, 0);
    let owner = runtime.jobs().unwrap().remove(0);
    finish_shared(&mut runtime, &owner, "done");
    for mut job in runtime.jobs().unwrap() {
        prepare_private(&mut runtime, &mut job);
        let output = if job.execution.node == "r1" {
            "fix it\n<FEEDBACK>"
        } else {
            "<ACCEPT>"
        };
        finish_private(
            &mut runtime,
            &job,
            &format!("{}.txt", job.execution.node),
            output,
        );
    }
    assert!(runtime.jobs().unwrap().is_empty());
    assert!(runtime.state.nodes["owner"].feedback_workspace.is_none());
    deliver_batch(&mut runtime);
    let repair = runtime.jobs().unwrap().remove(0);
    assert!(repair.source_direct);
    assert_eq!(repair.execution.session_id, owner.execution.session_id);
    assert!(repair.task.contains("Feedback:\nfix it"));
    for name in ["r1", "r2", "r3"] {
        assert!(source.join(format!("{name}.txt")).exists());
    }
    assert_eq!(runtime.state.feedback_counts["r1->owner"], 1);
}

#[test]
fn queued_and_recovered_source_followups_cannot_override_a_new_private_batch() {
    for failed in [false, true] {
        let (_temp, source, mut runtime) = adaptive(false, graph(&["owner"], &[]), true, 0);
        let first = runtime.jobs().unwrap().remove(0);
        finish_shared(&mut runtime, &first, "done");
        runtime.jobs().unwrap();
        runtime.intervene("owner", "follow-up").unwrap();
        if failed {
            let followup = runtime.jobs().unwrap().remove(0);
            runtime
                .finish(&followup.execution, Err("provider failed".into()))
                .unwrap();
            runtime.jobs().unwrap();
            runtime.resume_node("owner").unwrap();
            assert!(runtime.state.nodes["owner"].source_direct_recovery);
        }
        runtime
            .revise_graph(
                graph(&["owner", "a", "b", "c"], &[]),
                PlanningSummary::default(),
            )
            .unwrap();
        let jobs = runtime.jobs().unwrap();
        assert_eq!(jobs.len(), 4);
        assert_eq!(runtime.state.phase, "running");
        assert!(jobs
            .iter()
            .all(|job| !job.source_direct && Path::new(&job.execution.worktree) != source));
        // Projection-only completion tests that followup cannot bypass handoff.
        for job in jobs {
            runtime
                .finish(
                    &job.execution,
                    Ok((format!("head-{}", job.execution.node), "done".into())),
                )
                .unwrap();
        }
        runtime.jobs().unwrap();
        assert_eq!(runtime.state.phase, "publishing");
    }
}

#[test]
fn failed_shared_retry_stays_in_place_and_review_is_claimed_once() {
    let (_temp, source, mut runtime) = adaptive(false, graph(&["a"], &[]), true, 0);
    let job = runtime.jobs().unwrap().remove(0);
    fs::write(source.join("partial.txt"), "keep me").unwrap();
    runtime
        .finish(&job.execution, Err("provider unavailable".into()))
        .unwrap();
    runtime.resume_node("a").unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(Path::new(&retry.execution.worktree), source);
    assert_eq!(retry.execution.session_id, job.execution.session_id);
    assert!(retry.source_direct && retry.preserved_workspace.is_none());
    assert_eq!(
        fs::read_to_string(source.join("partial.txt")).unwrap(),
        "keep me"
    );
    finish_shared(&mut runtime, &retry, "done");
    runtime.jobs().unwrap();
    assert!(runtime.take_shared_workspace_review().unwrap().is_some());
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    assert!(runtime.take_shared_workspace_review().unwrap().is_none());
}

#[test]
fn recovered_attachment_receipts_preserve_edits_and_deletions_but_not_incomplete_copies() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let previous = temp.path().join("private");
    let source = temp.path().join("source");
    for path in [&root, &previous, &source] {
        fs::create_dir(path).unwrap();
    }
    let run = Uuid::new_v4().to_string();
    for case in ["edited", "deleted", "incomplete"] {
        let id = Uuid::new_v4().to_string();
        let relative = format!("grapher-attachments/{id}/data.csv");
        crate::attachment_inputs::stage(&root, &run, "owner", &id, "data.csv", b"original")
            .unwrap();
        if case != "incomplete" {
            crate::attachment_inputs::deliver(&root, &run, "owner", &relative, &previous).unwrap();
        }
        if case == "deleted" {
            fs::remove_file(previous.join(&relative)).unwrap();
        } else {
            fs::create_dir_all(source.join(&relative).parent().unwrap()).unwrap();
            fs::write(source.join(&relative), case).unwrap();
        }
        let result = crate::attachment_inputs::deliver_recovered(
            &root, &run, "owner", &relative, &source, &previous,
        );
        if case == "incomplete" {
            assert!(result.unwrap_err().contains("incomplete"));
        } else {
            result.unwrap();
            crate::attachment_inputs::deliver_recovered(
                &root, &run, "owner", &relative, &source, &previous,
            )
            .unwrap();
        }
        if case == "deleted" {
            assert!(!source.join(&relative).exists());
        } else {
            assert_eq!(fs::read_to_string(source.join(&relative)).unwrap(), case);
        }
    }
}

#[cfg(feature = "fixture")]
#[test]
fn retained_planner_edits_after_completion_reopen_the_batch_handoff() {
    let (_temp, source, mut runtime) = adaptive(false, graph(&["a", "b", "c"], &[]), true, 0);
    let mut jobs = runtime.jobs().unwrap();
    for job in &mut jobs {
        prepare_private(&mut runtime, job);
        finish_private(
            &mut runtime,
            job,
            &format!("{}.txt", job.execution.node),
            "done",
        );
    }
    runtime.jobs().unwrap();
    deliver_batch(&mut runtime);
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.phase, "completed");
    let selected = &jobs[2].execution;
    fs::write(
        Path::new(&selected.worktree).join("planner-patch.txt"),
        "retained Planner work",
    )
    .unwrap();
    runtime.capture_planner_workspace(&selected.id).unwrap();
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(
        runtime.state.phase, "running",
        "changed private files need a new handoff even without a graph edit"
    );
    assert!(runtime.jobs().unwrap().is_empty());
    deliver_batch(&mut runtime);
    assert_eq!(
        fs::read_to_string(source.join("planner-patch.txt")).unwrap(),
        "retained Planner work"
    );
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.phase, "completed");
}

#[cfg(feature = "fixture")]
#[test]
fn cwd_changing_recovery_keeps_the_original_sessions_attachment_claims() {
    let (_temp, source, mut runtime) = adaptive(true, graph(&["a", "b", "c"], &[]), true, 0);
    let mut jobs = runtime.jobs().unwrap();
    let input_id = Uuid::new_v4().to_string();
    let reference = format!("grapher-attachments/{input_id}/input.txt");
    for job in &mut jobs {
        prepare_private(&mut runtime, job);
        if job.execution.node == "a" {
            crate::attachment_inputs::stage(
                &runtime.root,
                &runtime.state.run_id,
                "a",
                &input_id,
                "input.txt",
                b"complete input",
            )
            .unwrap();
            runtime
                .emit(EventKind::Steered {
                    execution_id: job.execution.id.clone(),
                    node: "a".into(),
                    instruction: reference.clone(),
                    images: None,
                })
                .unwrap();
            let path = Path::new(&job.execution.worktree).join(&reference);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "truncated").unwrap(); // interrupted copy: no delivery receipt
            let session = runtime.root.join("sessions").join(&job.execution.id);
            fs::create_dir_all(&session).unwrap();
            fs::write(session.join(format!("test_{}.jsonl", job.execution.session_id)),
                format!("{}\n", serde_json::json!({"type":"session", "id":job.execution.session_id, "cwd":job.execution.worktree}))).unwrap();
            runtime
                .finish(&job.execution, Err("interrupted delivery".into()))
                .unwrap();
        } else {
            finish_private(
                &mut runtime,
                job,
                &format!("{}.txt", job.execution.node),
                "done",
            );
        }
    }
    runtime.jobs().unwrap();
    deliver_batch(&mut runtime);
    runtime.jobs().unwrap();
    runtime.resume_node("a").unwrap();
    runtime.jobs().unwrap();
    deliver_batch(&mut runtime);
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.continuation && retry.session_fork.is_some() && retry.source_direct);
    assert!(
        retry.attachment_instructions.contains(&reference),
        "forking the Pi session must not lose the unfinished turn's accepted input claims"
    );
    let error = crate::attachment_inputs::deliver_recovered(
        &runtime.root,
        &retry.run_id,
        "a",
        &retry.attachment_instructions,
        &source,
        Path::new(retry.recovered_workspace.as_ref().unwrap()),
    )
    .unwrap_err();
    assert!(error.contains("incomplete"), "{error}");
    assert_eq!(
        fs::read_to_string(source.join(&reference)).unwrap(),
        "truncated"
    );

    // A failed source retry now owns the forked session ID. The next retry
    // still needs the original private turn's claims, not an empty input set.
    let session = runtime.root.join("sessions").join(&retry.execution.id);
    fs::create_dir_all(&session).unwrap();
    fs::write(
        session.join(format!("test_{}.jsonl", retry.execution.session_id)),
        "retained fork",
    )
    .unwrap();
    runtime.finish(&retry.execution, Err(error)).unwrap();
    runtime.resume_node("a").unwrap();
    let again = runtime.jobs().unwrap().remove(0);
    assert!(again.attachment_instructions.contains(&reference));
    assert!(again.session_fork.is_none());
    let error = perform_with_merger(
        &again,
        &runtime.root,
        &[],
        |_| {},
        |_| Ok(()),
        |_| Err("unexpected merger".into()),
    )
    .unwrap_err();
    assert!(error.contains("incomplete"), "{error}");
}

#[cfg(feature = "fixture")]
#[test]
fn shared_retry_does_not_recreate_a_proven_deleted_input() {
    let (_temp, source, mut runtime) = adaptive(true, graph(&["a"], &[]), true, 0);
    let job = runtime.jobs().unwrap().remove(0);
    let id = Uuid::new_v4().to_string();
    let reference = format!("grapher-attachments/{id}/input.txt");
    crate::attachment_inputs::stage(
        &runtime.root,
        &job.run_id,
        "a",
        &id,
        "input.txt",
        b"original",
    )
    .unwrap();
    crate::attachment_inputs::deliver(&runtime.root, &job.run_id, "a", &reference, &source)
        .unwrap();
    runtime
        .emit(EventKind::Steered {
            execution_id: job.execution.id.clone(),
            node: "a".into(),
            instruction: reference.clone(),
            images: None,
        })
        .unwrap();
    let session = runtime.root.join("sessions").join(&job.execution.id);
    fs::create_dir_all(&session).unwrap();
    fs::write(
        session.join(format!("test_{}.jsonl", job.execution.session_id)),
        "retained history",
    )
    .unwrap();
    fs::remove_file(source.join(&reference)).unwrap();
    runtime
        .finish(
            &job.execution,
            Err("failed after deleting its input".into()),
        )
        .unwrap();
    runtime.resume_node("a").unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.attachment_instructions.contains(&reference));
    retry.config.pi_command = "grapher-nonexistent-fixture-command".into();
    // Stop at engine admission, after the real host input-delivery path. No model
    // is needed to observe whether the host has wrongly resurrected the input.
    assert!(perform_with_merger(
        &retry,
        &runtime.root,
        &[],
        |_| {},
        |_| Ok(()),
        |_| Err("unexpected merger".into())
    )
    .is_err());
    assert!(
        !source.join(&reference).exists(),
        "recovery must retain source deletions"
    );
}

#[cfg(not(feature = "fixture"))]
#[test]
fn approval_is_filesystem_only_and_native_admission_waits_for_a_private_batch() {
    let (_temp, _source, mut runtime) = adaptive(
        true,
        graph(
            &["root", "a", "b", "c"],
            &[("root", "a"), ("root", "b"), ("root", "c")],
        ),
        true,
        0,
    );
    assert!(runtime.state.environment_baseline.is_none());
    assert!(runtime.state.config.as_ref().unwrap().environment.is_none());
    let root = runtime.jobs().unwrap().remove(0);
    assert!(root.config.environment.is_none());
    finish_shared(&mut runtime, &root, "done");
    let jobs = runtime.jobs().unwrap();
    assert_eq!(jobs.len(), 3);
    assert!(runtime.state.environment_baseline.is_some());
    assert!(jobs
        .iter()
        .all(|job| job.config.environment.is_some() && job.environment_input.is_some()));
    assert!(jobs.iter().all(|job| job.environment_sources.is_empty()));
}
