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

/// Compatibility fixture only: old schedulers could deliver successful siblings
/// and capture failed work before retry. New scheduling must never emit this.
#[cfg(feature = "fixture")]
fn legacy_handoff(runtime: &mut Runtime, recovery_nodes: &[&str]) {
    let recovery_execution_ids = recovery_nodes.iter().map(|name| {
        runtime.state.executions.iter().rev().find(|e| e.node == *name).unwrap().id.clone()
    }).collect();
    let heads = runtime.state.executions.iter().filter_map(|execution|
        execution.after.as_ref().filter(|head|
            !head.is_empty() && !runtime.state.published_heads.contains(head)).cloned()).collect();
    runtime.emit_outputs(vec![
        EventKind::BatchHandoffRequested { recovery_execution_ids },
        EventKind::PublicationStarted { repository: runtime.state.config.as_ref().unwrap().repository.clone(), heads },
    ]).unwrap();
}

#[test]
fn capped_dispatch_prioritizes_waiting_peers_without_blocking_ready_descendants() {
    // Deliberately put the child first: planner insertion order is not priority.
    let (_temp, _source, mut runtime) = adaptive(false,
        graph(&["child", "a", "b", "overflow"], &[("a", "child")]), false, 2);
    let first = runtime.jobs().unwrap();
    assert_eq!(first.iter().map(|j| j.execution.node.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    finish_shared(&mut runtime, &first[0], "done");
    let refill = runtime.jobs().unwrap();
    assert_eq!(refill.len(), 1);
    assert_eq!(refill[0].execution.node, "overflow", "already-ready peer must not be displaced by the child");
    finish_shared(&mut runtime, &first[1], "done");
    let child = runtime.jobs().unwrap();
    assert_eq!(child.len(), 1);
    assert_eq!(child[0].execution.node, "child", "layers must not block independent ready work");
}

#[cfg(feature = "fixture")]
#[test]
fn private_handoff_keeps_overflow_nodes_ahead_of_newly_ready_children() {
    let (_temp, _source, mut runtime) = adaptive(false,
        graph(&["child", "a", "b", "c", "overflow1", "overflow2"], &[("a", "child")]), true, 3);
    for mut job in runtime.jobs().unwrap() {
        prepare_private(&mut runtime, &mut job);
        finish_private(&mut runtime, &job, &format!("{}.txt", job.execution.node), "done");
    }
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "publishing", "successful dispatch may deliver before overflow runs");
    deliver_batch(&mut runtime);
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    let next = runtime.jobs().unwrap();
    assert_eq!(next.iter().map(|j| j.execution.node.as_str()).collect::<Vec<_>>(),
        ["overflow1", "overflow2", "child"]);
    assert!(next.iter().all(|j| !j.source_direct));
}

#[cfg(feature = "fixture")]
#[test]
fn resolved_private_inputs_wait_for_task_success_before_batch_delivery_across_restart() {
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
        assert!(runtime.jobs().unwrap().is_empty());
        assert!(runtime.state.publication.is_none());
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
        let mut retry = runtime.jobs().unwrap().remove(0);
        assert!(runtime.state.publication.is_none() && runtime.state.batch_handoff.is_none());
        assert!(!source.join("resolved-input.txt").exists() && !source.join("b.txt").exists());
        let previous = runtime.state.executions.iter().find(|execution| execution.id == resolved_id).unwrap();
        assert_eq!(previous.status, "resolved");
        assert!(previous.after.is_none(), "acknowledging a repair must not manufacture a result");
        assert_eq!(retry.execution.worktree, previous.worktree);
        assert_eq!(retry.execution.session_id, previous.session_id);
        assert!(!retry.source_direct && !retry.materialize_source);
        assert!(retry.preserved_workspace.is_some());
        assert_eq!(retry.execution.before, resolved_head);
        prepare_private(&mut runtime, &mut retry);
        assert_eq!(fs::read_to_string(Path::new(&retry.execution.worktree).join("resolved-input.txt")).unwrap(), "manual resolution");
        finish_private(&mut runtime, &retry, "a.txt", "done");
        runtime.jobs().unwrap();
        assert_eq!(runtime.state.publication.as_ref().unwrap().heads.len(), 3);
        deliver_batch(&mut runtime);
        assert_eq!(fs::read_to_string(source.join("resolved-input.txt")).unwrap(), "manual resolution");
        runtime.jobs().unwrap();
        assert_eq!(runtime.state.phase, "completed");
        assert_eq!(runtime.state.events.iter().filter(|event|
            matches!(event.kind, EventKind::PublicationCompleted { .. })).count(), 1);
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
        // Keep at least one queued child beyond the available slots regardless
        // of the configured default; the assertion tests capacity, not 8 names.
        let children: Vec<_> = (0..DEFAULT_MAX_PARALLEL.max(limit)).map(|i| format!("child-{i}")).collect();
        let names: Vec<_> = ["slow", "fast"].into_iter().chain(children.iter().map(String::as_str)).collect();
        let edges: Vec<_> = children.iter().map(|name| ("fast", name.as_str())).collect();
        let (_temp, source, mut runtime) = adaptive(
            false,
            graph(&names, &edges),
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
fn legacy_private_recovery_waits_for_live_source_writers_before_resuming_in_place() {
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
    legacy_handoff(&mut runtime, &[]);
    deliver_batch(&mut runtime);
    // An older scheduler could already have dispatched the next source batch.
    let slow = Execution {
        id: Uuid::new_v4().to_string(), node: "slow".into(),
        session_id: Uuid::new_v4().to_string(), worktree: source.to_string_lossy().into(),
        before: String::new(), workspace_lineage: vec!["slow".into()],
        ..first[0].execution.clone()
    };
    runtime.emit_outputs(vec![
        EventKind::ExecutionBatchStarted { nodes: vec!["slow".into()], isolated: false, resumed: false },
        EventKind::Started { execution: slow.clone(), message_sequences: Some(vec![]), fresh_restart: true },
    ]).unwrap();
    runtime.resume_node("a").unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "running", "never publish into an active source writer");
    assert!(runtime.state.batch_handoff.is_none());
    assert!(!source.join("partial.txt").exists());
    runtime.finish(&slow, Ok((String::new(), "done".into()))).unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.execution.node, "a");
    assert!(!retry.source_direct);
    assert_eq!(retry.execution.worktree, first[0].execution.worktree);
    assert!(!source.join("partial.txt").exists());
    prepare_private(&mut runtime, &mut retry);
    finish_private(&mut runtime, &retry, "a.txt", "done");
    runtime.jobs().unwrap();
    deliver_batch(&mut runtime);
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
                EventKind::ExecutionBatchStarted { nodes, isolated, .. } => {
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
fn resumed_batch_retains_source_baseline_on_replay_and_legacy_batches_refresh_it() {
    let (_temp, source, mut runtime) = adaptive(true, graph(&["a", "b", "c"], &[]), true, 0);
    let legacy: EventKind = serde_json::from_value(serde_json::json!({
        "type": "execution_batch_started", "nodes": ["a", "b", "c"], "isolated": true,
    })).unwrap();
    assert!(matches!(&legacy, EventKind::ExecutionBatchStarted { resumed: false, .. }));
    runtime.emit(legacy.clone()).unwrap();
    let head = workspace::snapshot_repository(&source).unwrap();
    runtime.emit(EventKind::SourceSnapshotted { head: head.clone() }).unwrap();
    runtime.emit(EventKind::ExecutionBatchStarted {
        nodes: vec!["a".into()], isolated: true, resumed: true,
    }).unwrap();
    assert_eq!(runtime.latest_source_head(), head);
    assert_eq!(runtime.store.load(&runtime.state.run_id).unwrap().phase, "running");
    let root = runtime.root.clone();
    drop(runtime);
    runtime = Runtime::open(&root).unwrap();
    assert_eq!(runtime.latest_source_head(), head);
    assert_eq!(runtime.state.isolated_workspaces, Some(true));
    assert!(runtime.state.paused, "restart retains the scheduling pause");
    runtime.resume_scheduling().unwrap();
    runtime.emit(legacy).unwrap();
    assert_eq!(runtime.latest_source_head(), "", "new batches must still refresh source");
}

#[cfg(feature = "fixture")]
#[test]
fn paused_private_nodes_resume_in_place_before_delivery_or_new_work() {
    for (git, paused_count, has_session) in [(true, 1, true), (false, 3, true), (false, 1, false)] {
        let (_temp, source, mut runtime) = adaptive(
            git,
            graph(
                &["done", "child", "child2", "child3", "child4", "child5", "failed", "a", "b", "c"],
                &[("done", "child"), ("done", "child2"), ("done", "child3"), ("done", "child4"), ("done", "child5")],
            ),
            true,
            5,
        );
        let mut paused = Vec::new();
        for mut job in runtime.jobs().unwrap() {
            prepare_private(&mut runtime, &mut job);
            if ["a", "b", "c"][..paused_count].contains(&job.execution.node.as_str()) {
                let path = Path::new(&job.execution.worktree);
                fs::write(path.join("tracked.txt"), "unfinished staged edit").unwrap();
                workspace::git(path, &["add", "tracked.txt"]).unwrap();
                fs::write(path.join("partial.txt"), "unfinished untracked work").unwrap();
                fs::remove_file(path.join("deleted.txt")).unwrap();
                if has_session {
                    let session = runtime.root.join("sessions").join(&job.execution.id);
                    fs::create_dir_all(&session).unwrap();
                    fs::write(session.join(format!("test_{}.jsonl", job.execution.session_id)),
                        format!("{}\n", serde_json::json!({"type":"session", "id":job.execution.session_id, "cwd":job.execution.worktree}))).unwrap();
                }
                paused.push(job.execution);
            } else if job.execution.node == "failed" {
                runtime.finish(&job.execution, Err("provider failed".into())).unwrap();
            } else {
                finish_private(&mut runtime, &job, &format!("{}.txt", job.execution.node), "done");
            }
        }
        let source_head = runtime.latest_source_head().to_owned();
        for (round, restart) in [false, true].into_iter().enumerate() {
            runtime.pause(true).unwrap();
            runtime.request_execution_stop(None).unwrap();
            for execution in &paused {
                runtime.finish(execution, Err("stopped".into())).unwrap();
            }
            fs::write(source.join("external.txt"), format!("source edit {round}")).unwrap();
            if restart {
                let root = runtime.root.clone();
                drop(runtime);
                runtime = Runtime::open(&root).unwrap();
            }
            runtime.pause(false).unwrap();
            let mut resumed = runtime.jobs().unwrap();
            assert_eq!(resumed.len(), paused_count, "Continue must dispatch paused nodes, not publish them");
            assert!(runtime.state.batch_handoff.is_none());
            assert!(runtime.state.publication.is_none());
            assert_eq!(runtime.state.nodes["child"].status, "waiting");
            assert_eq!(runtime.state.nodes["failed"].status, "failed");
            assert!(!source.join("done.txt").exists());
            assert!(!source.join("partial.txt").exists());
            for job in &mut resumed {
                let previous = paused.iter().find(|e| e.node == job.execution.node).unwrap();
                assert_ne!(job.execution.id, previous.id);
                assert_eq!(job.execution.attempt, previous.attempt);
                assert_eq!(job.execution.session_id, previous.session_id);
                assert_eq!(job.execution.worktree, previous.worktree);
                assert!(!job.source_direct);
                assert!(job.session_fork.is_none());
                assert!(job.recovered_workspace.is_none());
                assert!(job.preserved_workspace.is_some());
                assert_eq!(job.continuation, has_session);
                assert_eq!(job.initial_recovery, !has_session);
                let path = PathBuf::from(&job.execution.worktree);
                let head = workspace::git(&path, &["rev-parse", "HEAD"]).unwrap();
                let staged = workspace::git(&path, &["diff", "--cached"]).unwrap();
                prepare_private(&mut runtime, job);
                assert_eq!(workspace::git(&path, &["rev-parse", "HEAD"]).unwrap(), head);
                assert_eq!(workspace::git(&path, &["diff", "--cached"]).unwrap(), staged);
                assert_eq!(fs::read_to_string(path.join("partial.txt")).unwrap(), "unfinished untracked work");
                assert!(!path.join("deleted.txt").exists());
                assert!(!path.join("external.txt").exists(), "source edits must not enter the retained batch");
                assert!(!job.materialize_source, "resume must not collect a new source baseline");
                assert_eq!(job.expected_source_head, source_head);
            }
            assert_eq!(runtime.latest_source_head(), source_head);
            assert_eq!(fs::read_to_string(source.join("external.txt")).unwrap(), format!("source edit {round}"));
            assert!(runtime.jobs().unwrap().is_empty(), "new work waits for the resumed private batch");
            paused = resumed.into_iter().map(|job| job.execution).collect();
        }
        for execution in &paused {
            let head = workspace::snapshot_node_for_run(
                Path::new(&execution.worktree), &source, &execution.node, Some(&runtime.state.run_id),
            ).unwrap();
            runtime.finish(execution, Ok((head, "done".into()))).unwrap();
        }
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.phase, "needs_attention", "the unrelated failed member still holds the batch");
        assert!(runtime.state.publication.is_none());
        runtime.resume_node("failed").unwrap();
        let mut failed_retry = runtime.jobs().unwrap().remove(0);
        assert_eq!(failed_retry.execution.node, "failed");
        prepare_private(&mut runtime, &mut failed_retry);
        finish_private(&mut runtime, &failed_retry, "failed.txt", "done");
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.phase, "publishing", "only the complete batch may deliver");
        assert!(runtime.state.batch_handoff.as_ref().unwrap().recovery_execution_ids.is_empty());
        deliver_batch(&mut runtime);
        let mut children = runtime.jobs().unwrap();
        assert_eq!(children.len(), 5);
        assert_eq!(children[0].execution.node, "child");
        assert!(children.iter().all(|job| !job.source_direct));
        assert!(source.join("partial.txt").is_file());
        assert_eq!(fs::read_to_string(source.join("external.txt")).unwrap(), "source edit 1");
        prepare_private(&mut runtime, &mut children[0]);
        assert_eq!(fs::read_to_string(Path::new(&children[0].execution.worktree).join("external.txt")).unwrap(),
            "source edit 1", "a genuinely new private batch must still collect current source files");
    }
}

#[cfg(feature = "fixture")]
#[test]
fn paused_private_node_stop_holds_delivery_until_followup_finishes() {
    for (git, has_session, restart) in [(true, true, false), (false, true, true), (false, false, true)] {
        let (_temp, source, mut runtime) = adaptive(git,
            graph(&["a", "b", "c", "later"], &[("b", "later")]), true, 0);
        let mut jobs = runtime.jobs().unwrap();
        for job in &mut jobs {
            prepare_private(&mut runtime, job);
        }
        let original = runtime.state.executions.iter().find(|e| e.node == "a").unwrap().clone();
        let path = Path::new(&original.worktree);
        fs::write(path.join("tracked.txt"), "paused staged edit").unwrap();
        workspace::git(path, &["add", "tracked.txt"]).unwrap();
        fs::write(path.join("partial.txt"), "unfinished work").unwrap();
        fs::remove_file(path.join("deleted.txt")).unwrap();
        let staged = workspace::git(path, &["diff", "--cached"]).unwrap();
        if has_session {
            let session = runtime.root.join("sessions").join(&original.id);
            fs::create_dir_all(&session).unwrap();
            fs::write(session.join(format!("test_{}.jsonl", original.session_id)),
                format!("{}\n", serde_json::json!({"type":"session", "id":original.session_id, "cwd":original.worktree}))).unwrap();
        }
        runtime.request_execution_stop(Some("a")).unwrap();
        runtime.finish(&original, Err("stopped".into())).unwrap();
        assert!(!runtime.state.paused, "node stop must not interrupt sibling workers");
        assert!(runtime.jobs().unwrap().is_empty());
        for job in jobs.iter().filter(|j| j.execution.node != "a") {
            finish_private(&mut runtime, job, &format!("{}.txt", job.execution.node), "done");
        }
        assert!(runtime.jobs().unwrap().is_empty());
        assert!(runtime.state.publication.is_none(), "stopping the last writer is not permission to publish siblings");
        assert!(runtime.state.batch_handoff.is_none());
        assert_eq!(runtime.state.phase, "needs_attention");
        assert!(runtime.state.can_resume_node("a"));
        assert_eq!(runtime.state.nodes["later"].status, "waiting");
        assert!(!source.join("b.txt").exists());
        assert!(!source.join("partial.txt").exists());
        let root = runtime.root.clone();
        if restart {
            drop(runtime);
            runtime = Runtime::open(&root).unwrap();
            assert!(runtime.jobs().unwrap().is_empty());
            assert!(runtime.state.publication.is_none());
        }
        runtime.intervene("a", "finish the unfinished work").unwrap();
        runtime.intervene("a", "keep the staged changes").unwrap();
        let sequences: Vec<_> = runtime.state.nodes["a"].pending_messages.iter().map(|m| m.sequence).collect();
        if restart {
            drop(runtime);
            runtime = Runtime::open(&root).unwrap();
            assert_eq!(runtime.state.nodes["a"].pending_messages.len(), 2);
        }
        runtime.resume_after_intervention().unwrap();
        fs::write(source.join("external.txt"), "source edit during pause").unwrap();
        let mut resumed = runtime.jobs().unwrap();
        assert_eq!(resumed.len(), 1, "a follow-up must resume the paused writer before any handoff");
        let job = &mut resumed[0];
        assert_eq!(job.execution.node, "a");
        assert_eq!(job.execution.worktree, original.worktree);
        assert_eq!(job.execution.session_id, original.session_id);
        assert_eq!(job.execution.attempt, original.attempt + 1, "a new human turn still advances the logical attempt");
        assert!(job.session_fork.is_none() && job.recovered_workspace.is_none());
        assert!(job.preserved_workspace.is_some());
        assert!(!job.source_direct && !job.continuation && !job.materialize_source);
        assert_eq!(job.initial_recovery, !has_session);
        assert!(job.task.contains("finish the unfinished work") && job.task.contains("keep the staged changes"));
        assert!(runtime.state.nodes["a"].pending_messages.is_empty());
        assert!(runtime.state.events.iter().any(|e| matches!(&e.kind,
            EventKind::Started { execution, message_sequences: Some(claim), .. }
                if execution.id == job.execution.id && claim == &sequences)));
        prepare_private(&mut runtime, job);
        assert_eq!(job.expected_source_head, original.before);
        assert_eq!(workspace::git(path, &["diff", "--cached"]).unwrap(), staged);
        assert_eq!(fs::read_to_string(path.join("partial.txt")).unwrap(), "unfinished work");
        assert!(!path.join("deleted.txt").exists() && !path.join("external.txt").exists());
        assert!(runtime.jobs().unwrap().is_empty());
        assert!(runtime.state.publication.is_none());
        finish_private(&mut runtime, job, "a.txt", "done");
        assert!(runtime.jobs().unwrap().is_empty());
        assert!(runtime.state.batch_handoff.as_ref().unwrap().recovery_execution_ids.is_empty());
        deliver_batch(&mut runtime);
        assert!(source.join("partial.txt").is_file() && source.join("b.txt").is_file());
        assert_eq!(fs::read_to_string(source.join("external.txt")).unwrap(), "source edit during pause");
        assert_eq!(runtime.jobs().unwrap()[0].execution.node, "later");
    }
}

#[cfg(feature = "fixture")]
#[test]
fn private_followup_runs_beside_disjoint_publication_without_changing_its_inputs() {
    for (finish_first, restart) in [(false, false), (true, false), (false, true)] {
        let (_temp, source, mut runtime) = adaptive(false, graph(&["a", "b", "c"], &[]), true, 0);
        let mut jobs = runtime.jobs().unwrap();
        for job in &mut jobs {
            prepare_private(&mut runtime, job);
            if job.execution.node != "a" {
                finish_private(&mut runtime, job, &format!("{}.txt", job.execution.node), "done");
            }
        }
        let original = runtime.state.executions.iter().find(|e| e.node == "a").unwrap().clone();
        fs::write(Path::new(&original.worktree).join("partial.txt"), "unfinished").unwrap();
        runtime.request_execution_stop(Some("a")).unwrap();
        runtime.finish(&original, Err("stopped".into())).unwrap();
        // A handoff already started by an older scheduler, as in the reported Run.
        let heads: Vec<_> = runtime.state.executions.iter().filter_map(|e| e.after.clone()).collect();
        runtime.emit_outputs(vec![
            EventKind::BatchHandoffRequested { recovery_execution_ids: vec![original.id.clone()] },
            EventKind::PublicationStarted { repository: source.to_string_lossy().into(), heads: heads.clone() },
        ]).unwrap();
        assert!(runtime.intervene("a", "unsafe capture race").is_err());
        assert!(runtime.intervene("b", "unsafe input writer").is_err());
        runtime.emit(EventKind::BatchHandoffRequested { recovery_execution_ids: vec![] }).unwrap();
        assert!(runtime.edit_node_message("a", &original.id, "a", "rewrite history", None).is_err(),
            "history edits cannot borrow the disjoint follow-up exception");
        runtime.intervene("a", "finish independently").unwrap();
        runtime.intervene("a", "second turn").unwrap();
        assert_eq!(runtime.state.phase, "publishing");
        assert_eq!(runtime.state.publication.as_ref().unwrap().heads, heads);
        let replay = runtime.store.load(&runtime.state.run_id).unwrap();
        assert_eq!(replay.phase, "publishing");
        assert_eq!(replay.nodes["a"].pending_messages.len(), 2);
        let mut resumed = runtime.jobs().unwrap();
        assert_eq!(resumed.len(), 1, "independent private follow-up must not wait for publication");
        let job = &mut resumed[0];
        assert_eq!(job.execution.worktree, original.worktree);
        assert!(!job.source_direct && !job.materialize_source);
        prepare_private(&mut runtime, job);
        assert_eq!(runtime.state.phase, "publishing");
        assert_eq!(runtime.state.publication.as_ref().unwrap().heads, heads);
        assert!(runtime.jobs().unwrap().is_empty());
        if restart {
            let root = runtime.root.clone();
            drop(runtime);
            runtime = Runtime::open(&root).unwrap();
            assert_eq!(runtime.state.phase, "publication_failed");
            assert!(runtime.state.paused);
            assert_eq!(runtime.state.publication.as_ref().unwrap().heads, heads);
            assert_eq!(runtime.state.nodes["a"].status, "failed");
            assert!(runtime.state.nodes["a"].pending_messages.is_empty(), "claimed turns must not be resent after a crash");
            assert!(runtime.jobs().unwrap().is_empty());
            assert!(Path::new(&original.worktree).join("partial.txt").is_file());
            assert!(!source.join("partial.txt").exists());
            continue;
        }
        if finish_first {
            finish_private(&mut runtime, job, "a.txt", "done");
            assert_eq!(runtime.state.phase, "publishing");
            assert_eq!(runtime.state.publication.as_ref().unwrap().heads, heads);
        }
        deliver_batch(&mut runtime);
        runtime.cleanup_worktrees().unwrap();
        assert!(Path::new(&original.worktree).is_dir(), "first delivery cannot reclaim a live or undelivered result");
        assert!(!source.join("partial.txt").exists());
        if !finish_first {
            finish_private(&mut runtime, job, "a.txt", "done");
        }
        assert!(runtime.jobs().unwrap().is_empty());
        deliver_batch(&mut runtime);
        assert!(source.join("partial.txt").exists());
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.phase, "completed");
    }
}

#[cfg(feature = "fixture")]
#[test]
fn paused_private_node_keeps_prepared_inputs_after_legacy_sibling_handoff_and_restart() {
    for (git, has_session) in [(true, true), (false, false)] {
        let (_temp, source, mut runtime) = adaptive(
            git,
            graph(
                &["a", "b", "c", "later", "x", "y", "z"],
                &[("b", "later"), ("c", "later"), ("a", "x"), ("a", "y"), ("a", "z"),
                    ("later", "x"), ("later", "y"), ("later", "z")],
            ),
            true,
            0,
        );
        let mut jobs = runtime.jobs().unwrap();
        for job in &mut jobs {
            prepare_private(&mut runtime, job);
            if job.execution.node != "a" {
                finish_private(&mut runtime, job, &format!("{}.txt", job.execution.node), "done");
            }
        }
        let original = runtime.state.executions.iter().find(|e| e.node == "a").unwrap().clone();
        let path = Path::new(&original.worktree);
        fs::write(path.join("tracked.txt"), "paused staged edit").unwrap();
        workspace::git(path, &["add", "tracked.txt"]).unwrap();
        fs::write(path.join("partial.txt"), "paused untracked edit").unwrap();
        fs::remove_file(path.join("deleted.txt")).unwrap();
        let staged = workspace::git(path, &["diff", "--cached"]).unwrap();
        if has_session {
            let session = runtime.root.join("sessions").join(&original.id);
            fs::create_dir_all(&session).unwrap();
            fs::write(session.join(format!("test_{}.jsonl", original.session_id)),
                format!("{}\n", serde_json::json!({"type":"session", "id":original.session_id, "cwd":original.worktree}))).unwrap();
        }
        runtime.request_execution_stop(Some("a")).unwrap();
        runtime.finish(&original, Err("stopped".into())).unwrap();
        assert!(!runtime.state.paused, "stopping one node must not pause its siblings");
        assert!(runtime.jobs().unwrap().is_empty());
        assert!(runtime.state.publication.is_none());
        // Replay compatibility: older schedulers delivered completed siblings
        // immediately after a node-only stop. New scheduling holds that handoff,
        // but an already-recorded delivery must still preserve paused inputs.
        let heads = runtime.state.executions.iter().filter_map(|e| e.after.clone()).collect();
        runtime.emit_outputs(vec![
            EventKind::BatchHandoffRequested { recovery_execution_ids: vec![] },
            EventKind::PublicationStarted { repository: source.to_string_lossy().into(), heads },
        ]).unwrap();
        deliver_batch(&mut runtime);
        let delivered = runtime.state.published_head.clone().unwrap();
        assert_ne!(delivered, original.before);
        assert!(source.join("b.txt").is_file() && source.join("c.txt").is_file());
        assert!(!source.join("partial.txt").exists());
        // Retain an older source-native dispatch too; new scheduling would
        // wait for the stopped private writer before switching workspaces.
        let later = Execution {
            id: Uuid::new_v4().to_string(), node: "later".into(),
            session_id: Uuid::new_v4().to_string(), worktree: source.to_string_lossy().into(),
            before: String::new(), workspace_lineage: vec!["later".into()],
            ..original.clone()
        };
        runtime.emit_outputs(vec![
            EventKind::ExecutionBatchStarted { nodes: vec!["later".into()], isolated: false, resumed: false },
            EventKind::Started { execution: later.clone(), message_sequences: Some(vec![]), fresh_restart: true },
        ]).unwrap();
        fs::write(source.join("later.txt"), "new shared work").unwrap();
        runtime.finish(&later, Ok((String::new(), "done".into()))).unwrap();
        assert!(runtime.jobs().unwrap().is_empty());
        let root = runtime.root.clone();
        drop(runtime);
        runtime = Runtime::open(&root).unwrap();
        runtime.resume_node("a").unwrap();
        // A second stop before Prepared must still find the earlier preparation
        // in this same session, not adopt the intervening publication's inputs.
        let unprepared = runtime.jobs().unwrap().remove(0);
        runtime.request_execution_stop(Some("a")).unwrap();
        runtime.finish(&unprepared.execution, Err("stopped before preparation".into())).unwrap();
        assert!(runtime.jobs().unwrap().is_empty());
        drop(runtime);
        runtime = Runtime::open(&root).unwrap();
        runtime.resume_node("a").unwrap();
        let mut resumed = runtime.jobs().unwrap().remove(0);
        assert_eq!(resumed.execution.worktree, original.worktree);
        assert_eq!(resumed.execution.session_id, original.session_id);
        assert_eq!(resumed.execution.attempt, original.attempt);
        assert!(resumed.session_fork.is_none() && resumed.recovered_workspace.is_none());
        assert_eq!(resumed.continuation, has_session);
        assert_eq!(resumed.initial_recovery, !has_session);
        prepare_private(&mut runtime, &mut resumed);
        assert_eq!(resumed.expected_source_head, original.before);
        assert!(!resumed.materialize_source);
        assert_eq!(runtime.latest_source_head(), delivered, "do not rewind the Run's current source baseline");
        assert_eq!(workspace::git(path, &["diff", "--cached"]).unwrap(), staged);
        assert_eq!(fs::read_to_string(path.join("partial.txt")).unwrap(), "paused untracked edit");
        assert!(!path.join("deleted.txt").exists());
        for name in ["b.txt", "c.txt", "later.txt"] {
            assert!(!path.join(name).exists(), "later results must not enter the retained node view");
        }
        assert!(!source.join("partial.txt").exists());
        finish_private(&mut runtime, &resumed, "a.txt", "done");
        assert!(runtime.jobs().unwrap().is_empty());
        deliver_batch(&mut runtime);
        let mut next = runtime.jobs().unwrap();
        assert_eq!(next.len(), 3);
        prepare_private(&mut runtime, &mut next[0]);
        for name in ["a.txt", "b.txt", "c.txt", "later.txt", "partial.txt"] {
            assert!(Path::new(&next[0].execution.worktree).join(name).is_file(),
                "the next private batch must include all delivered and shared work: {name}");
        }
        assert!(!runtime.state.events.iter().any(|event| matches!(event.kind, EventKind::BatchRecoveryCaptured { .. })));
    }
}

#[cfg(feature = "fixture")]
#[test]
fn offline_paused_batch_restoration_is_guarded_replayable_and_stays_paused() {
    use crate::maintenance::paused_batch::{restoration, restore_paused_batch_at};
    let (_temp, source, mut runtime) = adaptive(false, graph(&["a", "b", "c"], &[]), true, 0);
    let mut jobs = runtime.jobs().unwrap();
    for job in &mut jobs {
        prepare_private(&mut runtime, job);
        if job.execution.node != "a" {
            finish_private(&mut runtime, job, &format!("{}.txt", job.execution.node), "done");
        }
    }
    let paused = &jobs[0].execution;
    let path = Path::new(&paused.worktree);
    fs::write(path.join("partial.txt"), "unfinished").unwrap();
    let session = runtime.root.join("sessions").join(&paused.id);
    fs::create_dir_all(&session).unwrap();
    let session_file = session.join(format!("test_{}.jsonl", paused.session_id));
    let session_bytes = format!("{}\n", serde_json::json!({"type":"session", "id":paused.session_id, "cwd":paused.worktree}));
    fs::write(&session_file, &session_bytes).unwrap();
    runtime.pause(true).unwrap();
    runtime.request_execution_stop(None).unwrap();
    runtime.finish(paused, Err("stopped".into())).unwrap();
    let original_node = serde_json::to_value(&runtime.state.nodes["a"]).unwrap();
    runtime.pause(false).unwrap();
    // Emulate the older scheduler's erroneous handoff, not the fixed dispatch.
    let heads = runtime.state.executions.iter().filter_map(|e| e.after.clone()).collect();
    runtime.emit_outputs(vec![
        EventKind::BatchHandoffRequested { recovery_execution_ids: vec![paused.id.clone()] },
        EventKind::PublicationStarted { repository: source.to_string_lossy().into_owned(), heads },
    ]).unwrap();
    let captured = Runtime::capture_batch_recovery(&runtime.root, &runtime.state.run_id,
        runtime.state.config.as_ref().unwrap(), paused).unwrap();
    runtime.record_batch_recoveries([(paused.id.clone(), captured.clone())].into_iter().collect()).unwrap();
    let publication = runtime.state.publication.as_ref().unwrap();
    let default = crate::graph_merge::publication_workspace(&source, &publication.heads).unwrap();
    let journal = path.parent().unwrap().join(default.file_name().unwrap()).with_extension("publication").join("00000000");
    fs::create_dir_all(&journal).unwrap();
    fs::write(journal.join("input.json"), serde_json::to_vec(&(String::new(), paused.before.clone())).unwrap()).unwrap();
    for marker in ["prepared.json", "applying", "installed"] {
        fs::write(journal.join(marker), "evidence").unwrap();
        let error = restoration(&runtime.root, &runtime.state).unwrap_err();
        assert!(error.contains("delivery"), "{error}");
        fs::remove_file(journal.join(marker)).unwrap();
    }
    fs::rename(&session_file, session.join("held.jsonl")).unwrap();
    assert!(restoration(&runtime.root, &runtime.state).is_err());
    fs::rename(session.join("held.jsonl"), &session_file).unwrap();
    let mut changed = runtime.state.clone();
    changed.published_heads.push(captured);
    assert!(restoration(&runtime.root, &changed).is_err());
    let event = Event { sequence: changed.events.last().unwrap().sequence + 1, timestamp: now(),
        kind: EventKind::PublicationCompleted { head: "delivered".into() } };
    apply(&mut changed, &event);
    assert!(restoration(&runtime.root, &changed).is_err());
    let mut active = runtime.state.clone();
    active.mergers.push(paused.clone());
    active.mergers.last_mut().unwrap().status = "running".into();
    assert!(restoration(&runtime.root, &active).is_err());
    let previous_events = runtime.state.events.len();
    let history = serde_json::to_value(&runtime.state.executions).unwrap();
    restoration(&runtime.root, &runtime.state).unwrap();
    let root = runtime.root.clone();
    let id = runtime.state.run_id.clone();
    let sequence = runtime.state.events.last().unwrap().sequence;
    let backup = _temp.path().join("recovery-backup");
    assert!(restore_paused_batch_at(&root, vec![id.clone()]).unwrap_err().contains("owns this runtime"));
    drop(runtime);
    restore_paused_batch_at(&root, vec![id.clone()]).unwrap();
    let mut args = vec![id.clone(), "--apply".into(), "--backup".into(), backup.to_string_lossy().into_owned(), "--expect-sequence".into(), (sequence - 1).to_string()];
    assert!(restore_paused_batch_at(&root, args.clone()).unwrap_err().contains("Run changed"));
    assert!(!backup.exists());
    *args.last_mut().unwrap() = sequence.to_string();
    restore_paused_batch_at(&root, args).unwrap();
    assert_eq!(crate::store::Store::open_reader(&backup.join("events.sqlite")).unwrap().load(&id).unwrap().events.len(), previous_events);
    runtime = Runtime::open(&root).unwrap();
    assert_eq!(runtime.state.events.len(), previous_events + 1);
    assert_eq!(serde_json::to_value(&runtime.state.executions).unwrap(), history);
    let mut replay = Snapshot { run_id: runtime.state.run_id.clone(), ..Default::default() };
    for event in &runtime.state.events { apply(&mut replay, event); }
    for state in [&runtime.state, &runtime.store.load(&runtime.state.run_id).unwrap(), &replay] {
        assert!(state.paused);
        assert_eq!(state.phase, "paused");
        assert!(state.publication.is_none() && state.batch_handoff.is_none());
        assert_eq!(serde_json::to_value(&state.nodes["a"]).unwrap(), original_node);
        assert_eq!(state.nodes["b"].status, "completed");
        assert!(state.can_resume());
        assert_eq!(crate::snapshot_view::snapshot_metadata(state).unwrap()["nodes"]["a"]["status"], "paused");
    }
    assert!(runtime.jobs().unwrap().is_empty());
    assert!(restoration(&runtime.root, &runtime.state).is_err(), "repeated apply must not append another restoration");
    assert_eq!(fs::read_to_string(&session_file).unwrap(), session_bytes);
    assert_eq!(fs::read_to_string(path.join("partial.txt")).unwrap(), "unfinished");
    assert!(!source.join("partial.txt").exists());
    let root = runtime.root.clone();
    drop(runtime);
    runtime = Runtime::open(&root).unwrap();
    assert!(runtime.state.paused && runtime.jobs().unwrap().is_empty());
    runtime.pause(false).unwrap();
    let resumed = runtime.jobs().unwrap().remove(0);
    assert_eq!(resumed.execution.worktree, paused.worktree);
    assert_eq!(resumed.execution.session_id, paused.session_id);
    assert_eq!(resumed.execution.attempt, paused.attempt);
    assert!(resumed.continuation && !resumed.source_direct);
    assert!(runtime.state.publication.is_none());
}

#[cfg(feature = "fixture")]
#[test]
fn failed_private_retries_keep_partial_work_and_successful_siblings_private_across_restart() {
    for (git, has_session, recovery) in [(true, true, "node"), (false, true, "run"), (false, false, "message")] {
        let (_temp, source, mut runtime) = adaptive(git,
            graph(&["a", "b", "c", "child"], &[("b", "child")]), true, 0);
        let mut jobs = runtime.jobs().unwrap();
        for job in &mut jobs {
            prepare_private(&mut runtime, job);
            if job.execution.node != "a" {
                finish_private(&mut runtime, job, &format!("{}.txt", job.execution.node), "done");
            }
        }
        let original = runtime.state.executions.iter().find(|e| e.node == "a").unwrap().clone();
        let path = Path::new(&original.worktree);
        fs::write(path.join("committed.txt"), "agent commit before failure").unwrap();
        workspace::git(path, &["add", "committed.txt"]).unwrap();
        workspace::git(path, &["commit", "-qm", "agent work"]).unwrap();
        let head = workspace::git(path, &["rev-parse", "HEAD"]).unwrap();
        fs::write(path.join("tracked.txt"), "unfinished staged work").unwrap();
        workspace::git(path, &["add", "tracked.txt"]).unwrap();
        fs::write(path.join("partial.txt"), "unfinished untracked work").unwrap();
        fs::write(path.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(path.join("ignored.txt"), "unfinished ignored work").unwrap();
        fs::remove_file(path.join("deleted.txt")).unwrap();
        let staged = workspace::git(path, &["diff", "--cached"]).unwrap();
        if has_session {
            let session = runtime.root.join("sessions").join(&original.id);
            fs::create_dir_all(&session).unwrap();
            fs::write(session.join(format!("test_{}.jsonl", original.session_id)),
                format!("{}\n", serde_json::json!({"type":"session", "id":original.session_id, "cwd":original.worktree}))).unwrap();
        }
        runtime.finish(&original, Err("unknown provider failure".into())).unwrap();
        let root = runtime.root.clone();
        let mut previous = original.clone();
        for round in 0..2 {
            assert!(runtime.jobs().unwrap().is_empty());
            assert_eq!(runtime.state.phase, "needs_attention");
            assert!(runtime.state.publication.is_none() && runtime.state.batch_handoff.is_none());
            assert_eq!(runtime.state.nodes["child"].status, "waiting");
            assert_eq!(runtime.state.nodes["b"].status, "completed");
            for file in ["b.txt", "c.txt", "partial.txt", "committed.txt", "ignored.txt"] {
                assert!(!source.join(file).exists(), "a failed batch must not leak any member to source");
            }
            assert!(source.join("deleted.txt").exists());
            drop(runtime);
            runtime = Runtime::open(&root).unwrap();
            match recovery {
                "node" => runtime.resume_node("a").unwrap(),
                "run" => runtime.pause(false).unwrap(),
                _ => {
                    runtime.intervene("a", "finish the task before delivery").unwrap();
                    runtime.resume_after_intervention().unwrap();
                }
            }
            // The queued retry must survive a second restart without a handoff.
            drop(runtime);
            runtime = Runtime::open(&root).unwrap();
            runtime.resume_scheduling().unwrap();
            fs::write(source.join("external.txt"), "source edit while recovering").unwrap();
            let mut retry = runtime.jobs().unwrap().remove(0);
            assert_eq!(retry.execution.node, "a");
            assert_eq!(retry.execution.worktree, original.worktree);
            assert_eq!(retry.execution.session_id, original.session_id);
            assert_eq!(retry.execution.attempt, previous.attempt + 1);
            assert!(!retry.source_direct && !retry.materialize_source);
            assert!(retry.session_fork.is_none() && retry.recovered_workspace.is_none());
            assert!(retry.preserved_workspace.is_some());
            assert_eq!(retry.initial_recovery, !has_session);
            prepare_private(&mut runtime, &mut retry);
            assert_eq!(retry.expected_source_head, if round == 0 { &original.before } else { &head }.as_str());
            assert_eq!(workspace::git(path, &["rev-parse", "HEAD"]).unwrap(), head);
            assert_eq!(workspace::git(path, &["diff", "--cached"]).unwrap(), staged);
            assert!(path.join("partial.txt").exists() && path.join("ignored.txt").exists());
            assert!(!path.join("deleted.txt").exists() && !path.join("external.txt").exists());
            assert!(runtime.jobs().unwrap().is_empty());
            assert!(runtime.state.publication.is_none());
            previous = retry.execution.clone();
            if round == 0 {
                runtime.finish(&retry.execution, Err("protocol failure on retry".into())).unwrap();
            } else {
                finish_private(&mut runtime, &retry, "a.txt", "done");
            }
        }
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.publication.as_ref().unwrap().heads.len(), 3);
        assert!(runtime.state.batch_handoff.as_ref().unwrap().recovery_execution_ids.is_empty());
        deliver_batch(&mut runtime);
        for file in ["a.txt", "b.txt", "c.txt", "partial.txt", "committed.txt", "ignored.txt", "external.txt"] {
            assert!(source.join(file).exists(), "completed batch must deliver every successful member: {file}");
        }
        assert!(!source.join("deleted.txt").exists());
        assert!(!runtime.state.events.iter().any(|e| matches!(e.kind, EventKind::BatchRecoveryCaptured { .. })));
        assert_eq!(runtime.state.events.iter().filter(|e| matches!(e.kind, EventKind::PublicationCompleted { .. })).count(), 1);
        assert_eq!(runtime.state.executions.iter().filter(|e| e.node == "b" || e.node == "c").count(), 2);
        assert_eq!(runtime.jobs().unwrap()[0].execution.node, "child");
    }
}

#[cfg(feature = "fixture")]
#[test]
fn failed_private_retry_rejects_missing_or_rewritten_work_without_borrowing_sibling_slots() {
    for missing in [true, false] {
        let (temp, source, mut runtime) = adaptive(true, graph(&["a", "b", "c"], &[]), true, 0);
        let mut jobs = runtime.jobs().unwrap();
        for job in &mut jobs {
            prepare_private(&mut runtime, job);
            if job.execution.node == "a" {
                fs::write(Path::new(&job.execution.worktree).join("partial.txt"), "preserve me").unwrap();
                runtime.finish(&job.execution, Err("provider failed".into())).unwrap();
            } else {
                finish_private(&mut runtime, job, &format!("{}.txt", job.execution.node), "done");
            }
        }
        let original = runtime.state.executions.iter().find(|e| e.node == "a").unwrap().clone();
        let path = Path::new(&original.worktree);
        let head = workspace::git(path, &["rev-parse", "HEAD"]).unwrap();
        let parked = temp.path().join("parked");
        if missing {
            fs::rename(path, &parked).unwrap();
        } else {
            let tree = workspace::git(path, &["rev-parse", "HEAD^{tree}"]).unwrap();
            let rewritten = workspace::git(path, &["commit-tree", &tree, "-m", "unrelated root"]).unwrap();
            workspace::git(path, &["reset", "--soft", &rewritten]).unwrap();
        }
        for _ in 0..2 {
            assert!(runtime.jobs().unwrap().is_empty());
            assert!(runtime.state.publication.is_none());
            runtime.resume_node("a").unwrap();
            let retry = runtime.jobs().unwrap().remove(0);
            assert_eq!(retry.execution.worktree, original.worktree, "damaged recovery must never adopt a sibling's slot");
            let error = perform_with_merger(&retry, &runtime.root, &[], |_| {}, |_| Ok(()),
                |_| Err("unexpected merger".into())).unwrap_err();
            assert!(error.contains("missing or reassigned") || error.contains("prepared Git history"), "{error}");
            runtime.finish(&retry.execution, Err(error)).unwrap();
            assert!(!source.join("partial.txt").exists() && !source.join("b.txt").exists());
            let root = runtime.root.clone();
            drop(runtime);
            runtime = Runtime::open(&root).unwrap();
            runtime.resume_scheduling().unwrap();
        }
        if missing { fs::rename(parked, path).unwrap(); }
        else { workspace::git(path, &["reset", "--soft", &head]).unwrap(); }
        runtime.resume_node("a").unwrap();
        let mut retry = runtime.jobs().unwrap().remove(0);
        prepare_private(&mut runtime, &mut retry);
        assert_eq!(fs::read_to_string(path.join("partial.txt")).unwrap(), "preserve me");
        finish_private(&mut runtime, &retry, "a.txt", "done");
        runtime.jobs().unwrap();
        deliver_batch(&mut runtime);
        assert!(source.join("partial.txt").exists() && source.join("b.txt").exists());
    }
}

#[cfg(feature = "fixture")]
#[test]
fn crash_before_private_preparation_holds_successful_siblings_and_retries_in_the_same_slot() {
    let (_temp, source, mut runtime) = adaptive(false, graph(&["a", "b", "c"], &[]), true, 0);
    let mut jobs = runtime.jobs().unwrap();
    let original = jobs[0].execution.clone();
    assert_eq!(original.node, "a");
    for job in &mut jobs[1..] {
        prepare_private(&mut runtime, job);
        finish_private(&mut runtime, job, &format!("{}.txt", job.execution.node), "done");
    }
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    assert_eq!(runtime.state.nodes["a"].status, "failed");
    assert!(runtime.state.paused && runtime.state.publication.is_none());
    runtime.pause(false).unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.execution.worktree, original.worktree);
    assert_eq!(retry.execution.session_id, original.session_id);
    assert!(retry.initial_recovery && !retry.source_direct);
    assert!(!source.join("b.txt").exists());
    prepare_private(&mut runtime, &mut retry);
    finish_private(&mut runtime, &retry, "a.txt", "done");
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.publication.as_ref().unwrap().heads.len(), 3);
    deliver_batch(&mut runtime);
    assert!(source.join("a.txt").exists() && source.join("b.txt").exists());
}

#[cfg(feature = "fixture")]
#[test]
fn failed_private_batch_holds_ready_children_until_every_retry_succeeds() {
    let (_temp, source, mut runtime) = adaptive(
        false,
        graph(
            &["a", "b", "c", "x", "y", "z"],
            &[("b", "x"), ("b", "y"), ("c", "z")],
        ),
        true,
        0,
    );
    let mut failed = Vec::new();
    for mut job in runtime.jobs().unwrap() {
        prepare_private(&mut runtime, &mut job);
        if job.execution.node != "b" {
            failed.push(job.execution.clone());
            fs::write(Path::new(&job.execution.worktree).join(format!("partial-{}.txt", job.execution.node)), "retained").unwrap();
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
    for previous in &failed {
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.phase, "needs_attention");
        assert!(runtime.state.publication.is_none());
        assert_eq!(runtime.state.nodes["x"].status, "waiting");
        assert!(!source.join("b.txt").exists());
        runtime.resume_node(&previous.node).unwrap();
        let mut retry = runtime.jobs().unwrap().remove(0);
        assert_eq!(retry.execution.node, previous.node);
        assert_eq!(retry.execution.worktree, previous.worktree);
        prepare_private(&mut runtime, &mut retry);
        assert_eq!(fs::read_to_string(Path::new(&retry.execution.worktree).join(format!("partial-{}.txt", previous.node))).unwrap(), "retained");
        finish_private(&mut runtime, &retry, &format!("{}.txt", previous.node), "done");
    }
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.publication.as_ref().unwrap().heads.len(), 3);
    deliver_batch(&mut runtime);
    let next = runtime.jobs().unwrap();
    assert_eq!(next.len(), 3);
    for file in ["a.txt", "b.txt", "c.txt", "partial-a.txt", "partial-c.txt"] {
        assert!(source.join(file).exists());
    }
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
    assert!(runtime.state.publication.is_none());
    runtime.resume_node("root").unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    assert!(!retry.source_direct);
    prepare_private(&mut runtime, &mut retry);
    finish_private(&mut runtime, &retry, "root.txt", "done");
    runtime.jobs().unwrap();
    deliver_batch(&mut runtime);
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.phase, "completed");
    assert!(runtime.take_shared_workspace_review().unwrap().is_none());
}

#[cfg(feature = "fixture")]
#[test]
fn legacy_recovery_capture_stays_retryable_even_after_an_earlier_batch_published() {
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
    legacy_handoff(&mut runtime, &[]);
    deliver_batch(&mut runtime);
    runtime.jobs().unwrap();
    runtime.resume_node("a").unwrap();
    legacy_handoff(&mut runtime, &["a"]);
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
fn legacy_captured_unchanged_recovery_can_finish_without_republishing_an_empty_head_set() {
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
    legacy_handoff(&mut runtime, &[]);
    deliver_batch(&mut runtime);
    runtime.jobs().unwrap();
    runtime.resume_node("a").unwrap();
    legacy_handoff(&mut runtime, &["a"]);
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
fn legacy_cwd_changing_recovery_keeps_the_original_sessions_attachment_claims() {
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
    legacy_handoff(&mut runtime, &[]);
    deliver_batch(&mut runtime);
    runtime.jobs().unwrap();
    runtime.resume_node("a").unwrap();
    legacy_handoff(&mut runtime, &["a"]);
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
