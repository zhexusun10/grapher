use grapher::{
    compiler::{compile, downstream},
    engine::feedback,
    model::*,
    runtime::{perform, Runtime},
    workspace,
};
use std::{fs, path::Path, thread};
use tempfile::TempDir;

fn graph() -> Graph {
    Graph {
        original_goal: "Build a feedback app".into(),
        nodes: ["spec", "frontend", "backend", "review"]
            .iter()
            .map(|name| Node {
                name: (*name).into(),
                task: format!("Implement {name}"),
            })
            .collect(),
        edges: [
            ("spec", "frontend", false),
            ("spec", "backend", false),
            ("frontend", "review", false),
            ("backend", "review", false),
            ("review", "frontend", true),
        ]
        .iter()
        .map(|(from, to, feedback)| Edge {
            from: (*from).into(),
            to: (*to).into(),
            relation: "test".into(),
            feedback: *feedback,
        })
        .collect(),
    }
}

fn config() -> Config {
    Config {
        repository: String::new(),
        engine: "fixture".into(),
        pi_command: "pi".into(),
        pi_args: vec![],
        model: String::new(),
        max_parallel: 2,
        max_feedback: 3,
    }
}

fn runtime(root: &Path) -> Runtime {
    let mut runtime = Runtime::open(root).unwrap();
    runtime.create(graph(), config()).unwrap();
    runtime
}

fn finish_wave(runtime: &mut Runtime, feedback_output: &str) {
    let jobs = runtime.jobs().unwrap();
    assert!(!jobs.is_empty());
    let mut feedback_results = Vec::new();
    for job in jobs {
        let output = if job.feedback_source {
            feedback_output
        } else {
            "done"
        };
        if let Some(feedback) = runtime
            .finish(&job.execution, Ok(("fake-head".into(), output.into())))
            .unwrap()
        {
            feedback_results.push(feedback);
        }
    }
    for (from, output) in feedback_results {
        runtime.apply_feedback(&from, &output).unwrap();
    }
}

#[test]
fn compiler_emits_dependency_layers_and_ignores_feedback_for_topology() {
    let plan = compile(&graph(), true).unwrap();
    assert_eq!(
        plan.execution_batches,
        vec![vec!["spec"], vec!["backend", "frontend"], vec!["review"]]
    );
    assert_eq!(plan.terminals, vec!["review"]);
}

#[test]
fn compiler_warns_when_revision_marker_cannot_route_a_retry() {
    let mut candidate = graph();
    candidate
        .nodes
        .iter_mut()
        .find(|node| node.name == "review")
        .unwrap()
        .task = "Check acceptance and finish with <REVISE> if corrections are needed".into();
    assert!(!compile(&candidate, true)
        .unwrap()
        .warnings
        .iter()
        .any(|warning| warning.starts_with("W302")));
    candidate.edges.retain(|edge| !edge.feedback);
    let plan = compile(&candidate, true).unwrap();
    assert!(plan
        .warnings
        .iter()
        .any(|warning| warning.starts_with("W302") && warning.contains("review")));
    // This is advisory: literal report examples do not make a structurally valid graph illegal.
    assert!(compile(&candidate, false).is_ok());
}

#[test]
fn compiler_rejects_cycles_unknown_nodes_duplicates_empty_tasks_and_self_edges() {
    let mut cycle = graph();
    cycle.edges.last_mut().unwrap().feedback = false;
    assert_eq!(compile(&cycle, true).unwrap_err()[0].code, "E101");
    let mut unknown = graph();
    unknown.edges[0].to = "missing".into();
    assert_eq!(compile(&unknown, true).unwrap_err()[0].code, "E204");
    let mut duplicate = graph();
    duplicate.nodes.push(duplicate.nodes[0].clone());
    assert_eq!(compile(&duplicate, true).unwrap_err()[0].code, "E202");
    let mut empty = graph();
    empty.nodes[0].task = "  ".into();
    assert_eq!(compile(&empty, true).unwrap_err()[0].code, "E203");
    let mut self_edge = graph();
    self_edge.edges[0].to = "spec".into();
    assert_eq!(compile(&self_edge, true).unwrap_err()[0].code, "E205");
    let mut parallel = graph();
    parallel.edges.push(parallel.edges[0].clone());
    assert_eq!(compile(&parallel, true).unwrap_err()[0].code, "E206");
}

#[test]
fn compiler_rejects_meaningless_feedback_and_unsafe_names() {
    let mut invalid = graph();
    invalid.edges.last_mut().unwrap().from = "backend".into();
    assert_eq!(compile(&invalid, true).unwrap_err()[0].code, "E207");
    assert!(compile(&invalid, false).is_err());
    invalid.nodes[0].name = "../../escape".into();
    assert!(compile(&invalid, true)
        .unwrap_err()
        .iter()
        .any(|error| error.code == "E201"));
    assert!(compile(&Graph::default(), true).is_err());
    assert!(compile(&Graph::default(), false).is_ok());
}

#[test]
fn invalidation_follows_dependency_edges_only() {
    assert_eq!(
        downstream(&graph(), "frontend")
            .into_iter()
            .collect::<Vec<_>>(),
        vec!["frontend", "review"]
    );
    assert_eq!(
        downstream(&graph(), "review")
            .into_iter()
            .collect::<Vec<_>>(),
        vec!["review"]
    );
}

#[test]
fn approval_is_mandatory_and_rejected_graph_does_not_execute() {
    let temp = TempDir::new().unwrap();
    let mut runtime = runtime(temp.path());
    assert!(runtime.jobs().unwrap().is_empty());
    assert!(!temp.path().join("worktrees").exists());
    assert!(runtime.pause(false).is_err());
    runtime.emit(EventKind::Rejected).unwrap();
    assert!(runtime.approve().is_err());
    assert!(runtime.jobs().unwrap().is_empty());
}

#[test]
fn invalid_replacement_leaves_current_graph_unchanged() {
    let temp = TempDir::new().unwrap();
    let mut runtime = runtime(temp.path());
    let original = runtime.state.run_id.clone();
    let mut invalid = graph();
    invalid.nodes[0].task.clear();
    assert!(runtime.create(invalid, config()).is_err());
    assert_eq!(runtime.state.run_id, original);
    assert_eq!(runtime.state.graph, graph());
}

#[test]
fn feedback_has_exact_final_line_protocol() {
    assert_eq!(feedback("Need a fix\n<REVISE>\n").unwrap(), true);
    assert_eq!(
        feedback("Earlier text mentions <REVISE>\n<ACCEPT>").unwrap(),
        false
    );
    assert!(feedback("<ACCEPT> trailing text").is_err());
    assert!(feedback("```\n<ACCEPT>\n```").is_err());
    assert!(feedback("").is_err());
}

#[test]
fn feedback_reexecutes_only_affected_branch_with_fresh_sessions() {
    let temp = TempDir::new().unwrap();
    let mut runtime = runtime(temp.path());
    runtime
        .emit(EventKind::Approved {
            base: "base".into(),
        })
        .unwrap();
    finish_wave(&mut runtime, "<ACCEPT>");
    finish_wave(&mut runtime, "<ACCEPT>");
    finish_wave(&mut runtime, "Add empty state\n<REVISE>");
    assert_eq!(runtime.state.nodes["frontend"].status, "dirty");
    assert_eq!(runtime.state.nodes["review"].status, "dirty");
    assert_eq!(runtime.state.nodes["backend"].status, "done");
    finish_wave(&mut runtime, "<ACCEPT>");
    finish_wave(&mut runtime, "<ACCEPT>");
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "publishing");
    let frontend: Vec<_> = runtime
        .state
        .executions
        .iter()
        .filter(|execution| execution.node == "frontend")
        .collect();
    assert_eq!(frontend.len(), 2);
    assert_ne!(frontend[0].session_id, frontend[1].session_id);
    assert_ne!(frontend[0].worktree, frontend[1].worktree);
    assert_eq!(
        runtime
            .state
            .executions
            .iter()
            .filter(|execution| execution.node == "backend")
            .count(),
        1
    );
}

#[test]
fn retry_limit_halts_branch_without_halting_runtime() {
    let temp = TempDir::new().unwrap();
    let mut runtime = runtime(temp.path());
    runtime
        .emit(EventKind::Approved {
            base: "base".into(),
        })
        .unwrap();
    finish_wave(&mut runtime, "<ACCEPT>");
    finish_wave(&mut runtime, "<ACCEPT>");
    for _ in 0..3 {
        finish_wave(&mut runtime, "<REVISE>");
        finish_wave(&mut runtime, "<ACCEPT>");
    }
    finish_wave(&mut runtime, "<REVISE>");
    assert_eq!(runtime.state.nodes["review"].status, "failed");
    assert_eq!(runtime.state.nodes["backend"].status, "done");
    assert_eq!(runtime.state.feedback_counts["review->frontend"], 3);
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "needs_attention");
}

#[test]
fn failure_propagates_but_independent_work_remains_ready() {
    let temp = TempDir::new().unwrap();
    let mut runtime = runtime(temp.path());
    runtime
        .emit(EventKind::Approved {
            base: "base".into(),
        })
        .unwrap();
    finish_wave(&mut runtime, "<ACCEPT>");
    let jobs = runtime.jobs().unwrap();
    for job in jobs {
        let result = if job.execution.node == "frontend" {
            Err("Pi failed".into())
        } else {
            Ok(("backend-head".into(), "done".into()))
        };
        runtime.finish(&job.execution, result).unwrap();
    }
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.nodes["frontend"].status, "failed");
    assert_eq!(runtime.state.nodes["review"].status, "blocked");
    assert_eq!(runtime.state.nodes["backend"].status, "done");
}

#[test]
fn pause_drains_and_human_intervention_preserves_history() {
    let temp = TempDir::new().unwrap();
    let mut runtime = runtime(temp.path());
    runtime
        .emit(EventKind::Approved {
            base: "base".into(),
        })
        .unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    runtime.pause(true).unwrap();
    assert!(runtime.intervene("spec", "change").is_err());
    runtime
        .finish(&job.execution, Ok(("spec-head".into(), "done".into())))
        .unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    runtime.intervene("frontend", "Use Svelte").unwrap();
    assert_eq!(runtime.state.nodes["frontend"].revision, 2);
    assert_eq!(runtime.state.nodes["backend"].revision, 1);
    assert_eq!(runtime.state.nodes["spec"].status, "done");
    assert_eq!(runtime.state.executions.len(), 1);
    assert!(runtime.state.nodes["frontend"]
        .instruction
        .contains("Use Svelte"));
}

#[test]
fn sqlite_replay_restores_state_and_crash_marks_running_attempt_failed() {
    let temp = TempDir::new().unwrap();
    let mut runtime = runtime(temp.path());
    runtime
        .emit(EventKind::Approved {
            base: "base".into(),
        })
        .unwrap();
    runtime.jobs().unwrap();
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(
        serde_json::to_value(&runtime.state).unwrap(),
        serde_json::to_value(replay).unwrap()
    );
    drop(runtime);
    let recovered = Runtime::open(temp.path()).unwrap();
    assert!(recovered.state.paused);
    assert_eq!(recovered.state.nodes["spec"].status, "failed");
    assert_eq!(recovered.state.executions[0].status, "failed");
}

#[test]
fn load_run_switches_active_state_and_allows_continuation() {
    let temp = TempDir::new().unwrap();
    let mut rt = runtime(temp.path());
    let run1 = rt.state.run_id.clone();
    rt.approve().unwrap();

    // Create a second run
    rt.create(graph(), config()).unwrap();
    let run2 = rt.state.run_id.clone();
    assert_ne!(run1, run2);
    assert_eq!(rt.state.run_id, run2);

    // Switch back to run1 via load_run
    let snapshot1 = rt.load_run(&run1).unwrap();
    assert_eq!(snapshot1.run_id, run1);
    assert_eq!(rt.state.run_id, run1);
    assert!(rt.state.approved);

    // Continue run1: pause and resume
    rt.pause(true).unwrap();
    assert!(rt.state.paused);
    rt.pause(false).unwrap();
    assert!(!rt.state.paused);
}

#[test]
fn actual_worktrees_parallel_merge_and_feedback_fixture_complete() {
    let temp = TempDir::new().unwrap();
    let mut runtime = runtime(temp.path());
    runtime.approve().unwrap();
    loop {
        let jobs = runtime.jobs().unwrap();
        if jobs.is_empty() {
            break;
        }
        let handles: Vec<_> = jobs
            .into_iter()
            .map(|job| {
                let root = runtime.root.clone();
                let parents = runtime.parents(&job.execution.node);
                thread::spawn(move || {
                    let result = perform(&job, &root, &parents, |_| {}, |_| Ok(()));
                    (job.execution, result)
                })
            })
            .collect();
        let mut feedback_results = Vec::new();
        for handle in handles {
            let (execution, result) = handle.join().unwrap();
            if let Some(feedback) = runtime.finish(&execution, result).unwrap() {
                feedback_results.push(feedback);
            }
        }
        for (from, output) in feedback_results {
            runtime.apply_feedback(&from, &output).unwrap();
        }
    }
    assert_eq!(
        runtime.state.phase, "publishing",
        "{:?}",
        runtime.state.nodes
    );
    assert_eq!(runtime.state.executions.len(), 6);
    let final_workspace = Path::new(&runtime.state.executions.last().unwrap().worktree);
    for file in ["spec.md", "frontend.md", "backend.md"] {
        assert!(final_workspace.join(file).exists());
    }
    assert!(fs::read_to_string(final_workspace.join("frontend.md"))
        .unwrap()
        .contains("Attempt 2"));
    assert!(workspace::git(
        &temp.path().join("fixture-repository"),
        &["status", "--porcelain"]
    )
    .unwrap()
    .is_empty());
    assert!(!temp.path().join("fixture-repository/frontend.md").exists());
}

#[test]
fn conflicting_worktrees_block_without_modifying_source_repository() {
    let temp = TempDir::new().unwrap();
    let repository = grapher::fixture::repository(temp.path()).unwrap();
    let base = workspace::verify(&repository).unwrap();
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    workspace::prepare(&repository, &first, &base, &[]).unwrap();
    workspace::prepare(&repository, &second, &base, &[]).unwrap();
    fs::write(first.join("README.md"), "first\n").unwrap();
    fs::write(second.join("README.md"), "second\n").unwrap();
    let first_head = workspace::snapshot_node(&first, &repository, "first").unwrap();
    let second_head = workspace::snapshot_node(&second, &repository, "second").unwrap();
    let merged = temp.path().join("merged");
    let error =
        workspace::prepare(&repository, &merged, &base, &[first_head, second_head]).unwrap_err();
    assert!(error.contains("Workspace composition blocked"));
    assert!(
        !workspace::git(&merged, &["diff", "--name-only", "--diff-filter=U"])
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        workspace::git(&repository, &["rev-parse", "HEAD"]).unwrap(),
        base
    );
}

#[test]
fn dirty_source_repository_is_rejected() {
    let temp = TempDir::new().unwrap();
    let repository = grapher::fixture::repository(temp.path()).unwrap();
    fs::write(repository.join("untracked.txt"), "keep my work").unwrap();
    assert!(workspace::verify(&repository)
        .unwrap_err()
        .contains("must be clean"));
    assert_eq!(
        fs::read_to_string(repository.join("untracked.txt")).unwrap(),
        "keep my work"
    );
}

#[test]
fn second_runtime_cannot_execute_the_same_event_store() {
    let temp = TempDir::new().unwrap();
    let first = Runtime::open(temp.path()).unwrap();
    assert!(Runtime::open(temp.path()).is_err());
    drop(first);
    assert!(Runtime::open(temp.path()).is_ok());
}

#[test]
fn node_ref_namespace_and_no_write_fetch_head_transport_contract() {
    let temp = TempDir::new().unwrap();
    let repository = grapher::fixture::repository(temp.path()).unwrap();
    let base = workspace::verify(&repository).unwrap();
    let node_a = temp.path().join("node_a");
    let node_b = temp.path().join("node_b");

    // 1. Prepare Node A
    workspace::prepare(&repository, &node_a, &base, &[]).unwrap();
    assert!(!node_a.join(".git/grapher-repository").exists());
    assert!(!node_a.join(".git/grapher-node-id").exists());
    assert_eq!(
        workspace::git(&node_a, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(),
        "grapher-node"
    );
    fs::write(node_a.join("a.txt"), "hello from node A\n").unwrap();
    assert!(workspace::snapshot_node(&node_a, &repository, "../invalid").is_err());
    let head_a = workspace::snapshot_node(&node_a, &repository, "nodeA").unwrap();

    // 2. Verify Host has refs/grapher/nodes/nodeA pointing to head_a
    let host_ref_a =
        workspace::git(&repository, &["rev-parse", "refs/grapher/nodes/nodeA"]).unwrap();
    assert_eq!(host_ref_a, head_a);

    // Verify .git/FETCH_HEAD does NOT exist in host repository (avoiding parallel race conditions)
    assert!(
        !repository.join(".git/FETCH_HEAD").exists(),
        ".git/FETCH_HEAD was written to host repository!"
    );

    // 3. Prepare child Node B depending on parent "nodeA"
    workspace::prepare(&repository, &node_b, &base, &["nodeA".to_string()]).unwrap();
    assert!(
        node_b.join("a.txt").exists(),
        "Child did not receive parent's files"
    );
    let child_parent_ref =
        workspace::git(&node_b, &["rev-parse", "refs/grapher/parents/nodeA"]).unwrap();
    assert_eq!(child_parent_ref, head_a);

    // 4. Node B completes and snapshots
    fs::write(node_b.join("b.txt"), "hello from node B\n").unwrap();
    let head_b = workspace::snapshot_node(&node_b, &repository, "nodeB").unwrap();

    // 5. Verify Host has refs/grapher/nodes/nodeB pointing to head_b
    let host_ref_b =
        workspace::git(&repository, &["rev-parse", "refs/grapher/nodes/nodeB"]).unwrap();
    assert_eq!(host_ref_b, head_b);
}

#[test]
fn serial_snapshot_does_not_create_or_move_graph_refs() {
    let temp = TempDir::new().unwrap();
    let repository = grapher::fixture::repository(temp.path()).unwrap();
    fs::write(repository.join("serial.txt"), "serial result\n").unwrap();

    let head = workspace::snapshot_execution(&repository, &repository, "task").unwrap();
    assert_eq!(
        head,
        workspace::git(&repository, &["rev-parse", "HEAD"]).unwrap()
    );
    assert!(workspace::git(
        &repository,
        &["rev-parse", "--verify", "refs/heads/grapher-node"]
    )
    .is_err());
    assert!(workspace::git(
        &repository,
        &["rev-parse", "--verify", "refs/grapher/nodes/task"]
    )
    .is_err());
    assert!(workspace::snapshot_node(&repository, &repository, "task").is_err());
}

#[test]
fn human_resolved_workspace_is_imported_before_fresh_execution() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("runtime");
    let mut runtime = Runtime::open(&root).unwrap();
    runtime
        .create(
            Graph {
                original_goal: "Resolve a composed workspace".into(),
                nodes: vec![Node {
                    name: "worker".into(),
                    task: "Complete the work".into(),
                }],
                edges: Vec::new(),
            },
            config(),
        )
        .unwrap();
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    let repository = grapher::fixture::repository(&root).unwrap();
    let workspace_path = Path::new(&job.execution.worktree);
    workspace::prepare(&repository, workspace_path, &job.execution.before, &[]).unwrap();
    fs::write(workspace_path.join("resolved.txt"), "human resolution\n").unwrap();
    workspace::git(workspace_path, &["add", "resolved.txt"]).unwrap();
    workspace::git(workspace_path, &["commit", "-m", "Resolve composition"]).unwrap();
    let resolved_head = workspace::git(workspace_path, &["rev-parse", "HEAD"]).unwrap();
    assert!(workspace::git(&repository, &["cat-file", "-e", &resolved_head]).is_err());

    runtime
        .emit(EventKind::Blocked {
            node: "worker".into(),
            error: "Workspace composition blocked".into(),
        })
        .unwrap();
    runtime.pause(true).unwrap();
    runtime.resolved("worker").unwrap();
    assert_eq!(
        runtime.state.nodes["worker"].head.as_deref(),
        Some(resolved_head.as_str())
    );
    assert_eq!(
        workspace::git(&repository, &["rev-parse", "refs/grapher/nodes/worker"]).unwrap(),
        resolved_head
    );

    runtime.pause(false).unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.execution.before, resolved_head);
    workspace::prepare(
        &repository,
        Path::new(&retry.execution.worktree),
        &retry.execution.before,
        &[],
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(Path::new(&retry.execution.worktree).join("resolved.txt")).unwrap(),
        "human resolution\n"
    );
}
