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
        engine: "demo".into(),
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

fn finish_wave(runtime: &mut Runtime, reviewer_output: &str) {
    let jobs = runtime.jobs().unwrap();
    assert!(!jobs.is_empty());
    let mut reviews = Vec::new();
    for job in jobs {
        let output = if job.reviewer {
            reviewer_output
        } else {
            "done"
        };
        if let Some(review) = runtime
            .finish(&job.execution, Ok(("fake-head".into(), output.into())))
            .unwrap()
        {
            reviews.push(review);
        }
    }
    for (from, output) in reviews {
        runtime.review(&from, &output).unwrap();
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
    assert_eq!(runtime.state.phase, "completed");
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
fn actual_worktrees_parallel_merge_and_feedback_demo_complete() {
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
        let mut reviews = Vec::new();
        for handle in handles {
            let (execution, result) = handle.join().unwrap();
            if let Some(review) = runtime.finish(&execution, result).unwrap() {
                reviews.push(review);
            }
        }
        for (from, output) in reviews {
            runtime.review(&from, &output).unwrap();
        }
    }
    assert_eq!(
        runtime.state.phase, "completed",
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
        &temp.path().join("demo-repository"),
        &["status", "--porcelain"]
    )
    .unwrap()
    .is_empty());
    assert!(!temp.path().join("demo-repository/frontend.md").exists());
}

#[test]
fn conflicting_worktrees_block_without_modifying_source_repository() {
    let temp = TempDir::new().unwrap();
    let repository = workspace::demo_repository(temp.path()).unwrap();
    let base = workspace::verify(&repository).unwrap();
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    workspace::prepare(&repository, &first, &base, &[]).unwrap();
    workspace::prepare(&repository, &second, &base, &[]).unwrap();
    fs::write(first.join("README.md"), "first\n").unwrap();
    fs::write(second.join("README.md"), "second\n").unwrap();
    let first_head = workspace::snapshot(&first).unwrap();
    let second_head = workspace::snapshot(&second).unwrap();
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
    let repository = workspace::demo_repository(temp.path()).unwrap();
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
