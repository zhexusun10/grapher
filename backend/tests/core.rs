use grapher::{
    compiler::{compile, compile_legacy, downstream},
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
        thinking_level: "medium".into(),
        max_parallel: 2,
        max_feedback: 3,
        auto_approve: false,
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
fn settings_do_not_change_approved_run_or_future_jobs() {
    let temp = TempDir::new().unwrap();
    let mut rt = runtime(temp.path());
    rt.approve().unwrap();
    let original = serde_json::to_value(&rt.state).unwrap();
    let version = rt.snapshot_version();
    let mut next = config();
    next.repository = "/another/project".into();
    next.model = "another/model".into();
    rt.save_default_config(&next).unwrap();
    assert_eq!(serde_json::to_value(&rt.state).unwrap(), original);
    assert_eq!(rt.snapshot_version(), version);
    assert_eq!(serde_json::to_value(rt.store.load(&rt.state.run_id).unwrap()).unwrap(), original);
    for job in rt.jobs().unwrap() {
        assert_eq!(job.config.repository, config().repository);
        assert_eq!(job.config.model, config().model);
    }
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&fs::read(temp.path().join("config.json")).unwrap()).unwrap()["model"], next.model);
}

#[test]
fn workspace_selection_survives_restart_and_missing_load_preserves_state() {
    let temp = TempDir::new().unwrap();
    let mut rt = runtime(temp.path());
    let first = rt.state.run_id.clone();
    rt.create(graph(), config()).unwrap();
    let second = rt.state.run_id.clone();
    let before = serde_json::to_value(&rt.state).unwrap();
    assert!(rt.load_run("missing").unwrap_err().contains("does not exist"));
    assert_eq!(serde_json::to_value(&rt.state).unwrap(), before);
    rt.load_run(&first).unwrap();
    drop(rt);
    let mut rt = Runtime::open(temp.path()).unwrap();
    assert_eq!(rt.state.run_id, first);
    rt.reset_workspace().unwrap();
    drop(rt);
    let mut rt = Runtime::open(temp.path()).unwrap();
    assert!(rt.state.run_id.is_empty());
    assert_eq!(rt.store.runs().unwrap().len(), 2);
    rt.load_run(&second).unwrap();
    rt.delete_run(&second).unwrap();
    assert!(rt.load_run(&second).unwrap_err().contains("does not exist"));
    drop(rt);
    let rt = Runtime::open(temp.path()).unwrap();
    assert!(rt.state.run_id.is_empty());
}

#[test]
fn compiler_and_snapshot_share_node_identity_validation() {
    for name in ["".into(), "a b".into(), "节点".into(), "a.b".into(), "a/../b".into(), "x".repeat(65)] {
        let graph = Graph { nodes: vec![Node { name: name.clone(), task: "task".into() }], ..Graph::default() };
        assert!(compile(&graph, true).unwrap_err().iter().any(|e| e.code == "E201"));
        let error = workspace::snapshot_node(Path::new("/missing/work"), Path::new("/missing/repo"), &name).unwrap_err();
        assert!(error.contains("Invalid node name"), "{error}");
    }
    for name in ["a-dep-b_9".into(), "x".repeat(64)] {
        let graph = Graph { nodes: vec![Node { name, task: "task".into() }], ..Graph::default() };
        compile(&graph, true).unwrap();
    }
}

#[test]
fn feedback_is_edge_data_not_node_data() {
    assert!(serde_json::from_value::<Node>(serde_json::json!({
        "name": "review",
        "task": "Review",
        "feedback": true
    }))
    .is_err());
    let edge = serde_json::from_value::<Edge>(serde_json::json!({
        "from": "review",
        "to": "implementation",
        "relation": "revision",
        "feedback": true
    }))
    .unwrap();
    assert!(edge.feedback);
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
fn compiler_reports_each_transitive_dependency_and_preserves_legacy_replay() {
    let mut candidate = Graph {
        original_goal: "Implement and verify two branches".into(),
        nodes: ["server", "server_tests", "web", "web_tests", "acceptance"]
            .into_iter()
            .map(|name| Node {
                name: name.into(),
                task: name.into(),
            })
            .collect(),
        edges: [
            ("server", "server_tests", false),
            ("server", "acceptance", false),
            ("web", "web_tests", false),
            ("web", "acceptance", false),
            ("server_tests", "acceptance", false),
            ("web_tests", "acceptance", false),
            ("acceptance", "server_tests", true),
        ]
        .into_iter()
        .map(|(from, to, feedback)| Edge {
            from: from.into(),
            to: to.into(),
            relation: String::new(),
            feedback,
        })
        .collect(),
    };
    let diagnostics = compile(&candidate, false).unwrap_err();
    assert_eq!(
        diagnostics
            .iter()
            .filter(|item| item.code == "E209")
            .count(),
        2
    );
    assert!(diagnostics
        .iter()
        .any(|item| item.message.contains("server → server_tests → acceptance")));
    assert!(diagnostics
        .iter()
        .any(|item| item.message.contains("web → web_tests → acceptance")));
    assert!(compile_legacy(&candidate, true).is_ok());
    let mut historical = Snapshot::default();
    grapher::model::apply(
        &mut historical,
        &Event {
            sequence: 1,
            timestamp: 0,
            kind: EventKind::Created {
                graph: candidate.clone(),
                config: config(),
                planning_id: None,
                planning: None,
            },
        },
    );
    assert_eq!(historical.graph, candidate);
    assert!(historical.plan.is_some());
    candidate
        .edges
        .retain(|edge| !(edge.to == "acceptance" && (edge.from == "server" || edge.from == "web")));
    assert!(compile(&candidate, true).is_ok());
    assert!(candidate.edges.iter().any(|edge| edge.feedback));
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
fn compiler_rejects_multiple_feedback_targets_from_one_source() {
    let mut candidate = graph();
    candidate.edges.push(Edge {
        from: "review".into(),
        to: "backend".into(),
        relation: "test both implementations".into(),
        feedback: true,
    });
    let errors = compile(&candidate, true).unwrap_err();
    let error = errors.iter().find(|error| error.code == "E208").unwrap();
    assert!(error.message.contains("review"));
    assert!(error.message.contains("backend, frontend"));
    assert!(error.message.contains("at most one feedback target"));
    assert!(!error.message.contains("integration owner"));
    assert!(!error.message.contains("separate review nodes"));
    assert!(compile(&graph(), true).is_ok());
}

#[test]
fn compiler_does_not_warn_about_valid_isolated_nodes() {
    let candidate = Graph {
        original_goal: "Two independent outputs".into(),
        nodes: vec![
            Node {
                name: "first".into(),
                task: "First output".into(),
            },
            Node {
                name: "second".into(),
                task: "Second output".into(),
            },
        ],
        edges: vec![],
    };
    assert!(compile(&candidate, true).unwrap().warnings.is_empty());
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
fn pause_drains_and_rerun_preserves_history() {
    let temp = TempDir::new().unwrap();
    let mut runtime = runtime(temp.path());
    runtime
        .emit(EventKind::Approved {
            base: "base".into(),
        })
        .unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    runtime.pause(true).unwrap();
    assert!(runtime.rerun("spec").is_err());
    runtime
        .finish(&job.execution, Ok(("spec-head".into(), "done".into())))
        .unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert!(runtime.intervene("frontend", "Use Svelte").is_err()); // No session yet.
    runtime.intervene("spec", "Use Svelte").unwrap();
    runtime.intervene("spec", "Switch to React").unwrap();
    assert_eq!(runtime.state.nodes["spec"].revision, 3);
    assert_eq!(runtime.state.nodes["backend"].revision, 1);
    assert_eq!(runtime.state.nodes["backend"].status, "waiting");
    assert_eq!(runtime.state.executions.len(), 1);
    assert_eq!(runtime.state.nodes["spec"].instruction, "Switch to React");
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(replay.nodes["spec"].instruction, "Switch to React");
    runtime.pause(false).unwrap();
    let follow_up = runtime.jobs().unwrap().remove(0);
    assert_eq!(follow_up.task, "Switch to React");
    assert_eq!(follow_up.execution.session_id, job.execution.session_id);
    assert_eq!(follow_up.execution.worktree, job.execution.worktree);
    assert_eq!(
        follow_up.resume_execution_id.as_deref(),
        Some(job.execution.id.as_str())
    );
}

#[test]
fn steer_does_not_invalidate_and_unrelated_running_node_does_not_block_follow_up() {
    let temp = TempDir::new().unwrap();
    let mut runtime = runtime(temp.path());
    runtime
        .emit(EventKind::Approved {
            base: "base".into(),
        })
        .unwrap();
    let spec = runtime.jobs().unwrap().remove(0);
    runtime
        .emit(EventKind::Steered {
            execution_id: spec.execution.id.clone(),
            node: "spec".into(),
            instruction: "clarify".into(),
        })
        .unwrap();
    assert_eq!(runtime.state.nodes["spec"].status, "running");
    assert!(runtime
        .state
        .graph
        .nodes
        .iter()
        .all(|node| runtime.state.nodes[&node.name].status != "dirty"));
    runtime
        .finish(&spec.execution, Ok(("spec-head".into(), "done".into())))
        .unwrap();
    let jobs = runtime.jobs().unwrap();
    let frontend = jobs
        .iter()
        .find(|job| job.execution.node == "frontend")
        .unwrap();
    runtime
        .finish(
            &frontend.execution,
            Ok(("frontend-head".into(), "done".into())),
        )
        .unwrap();
    assert_eq!(runtime.state.nodes["backend"].status, "running");
    runtime.intervene("frontend", "new instruction").unwrap();
    assert_eq!(runtime.state.nodes["frontend"].status, "dirty");
    assert_eq!(runtime.state.nodes["review"].status, "waiting");
    assert_eq!(runtime.state.nodes["review"].revision, 1);
    assert_eq!(runtime.state.nodes["backend"].status, "running");
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
fn dirty_source_is_preserved_until_approval() {
    let temp = TempDir::new().unwrap();
    let repository = grapher::fixture::repository(temp.path()).unwrap();
    let head = workspace::git(&repository, &["rev-parse", "HEAD"]).unwrap();
    fs::write(repository.join("untracked.txt"), "keep my work").unwrap();
    assert_eq!(workspace::verify(&repository).unwrap(), head);
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
fn graph_result_cannot_discard_its_prepared_commit() {
    let temp = TempDir::new().unwrap();
    let repository = grapher::fixture::repository(temp.path()).unwrap();
    let base = workspace::verify(&repository).unwrap();
    let child = temp.path().join("child");
    let prepared = workspace::prepare(&repository, &child, &base, &[]).unwrap();
    workspace::verify_prepared_ancestor(&child, &prepared).unwrap();
    workspace::git(&child, &["checkout", "--orphan", "rewritten"]).unwrap();
    workspace::git(&child, &["add", "-A"]).unwrap();
    workspace::git(&child, &["commit", "-m", "Rewrite history"]).unwrap();
    assert!(workspace::verify_prepared_ancestor(&child, &prepared)
        .unwrap_err()
        .contains("discarded its prepared Git history"));
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
        workspace::git(
            &repository,
            &[
                "rev-parse",
                &format!("refs/grapher/runs/{}/nodes/worker", runtime.state.run_id)
            ]
        )
        .unwrap(),
        resolved_head
    );

    runtime.pause(false).unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.task, "Complete the work");
    assert_eq!(retry.execution.before, resolved_head);
    workspace::prepare(
        &repository,
        Path::new(&retry.execution.worktree),
        &retry.execution.before,
        &[],
    )
    .unwrap();
    // Git for Windows may check out text as CRLF (core.autocrlf=true).
    assert_eq!(
        fs::read_to_string(Path::new(&retry.execution.worktree).join("resolved.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "human resolution\n"
    );
}
