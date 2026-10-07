use grapher::{
    compiler::{compile, compile_legacy, downstream, node_id},
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
        role_models: Default::default(),
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
fn arbitrary_node_names_map_to_safe_internal_ids() {
    for name in ["a b".into(), "节点".into(), "a.b".into(), "a/../b".into(), "x".repeat(65)] {
        let graph = Graph { nodes: vec![Node { name: name.clone(), task: "task".into() }], ..Graph::default() };
        compile(&graph, true).unwrap();
        let id = node_id(&name);
        assert!(!id.is_empty());
        assert!(id.len() <= 64);
        assert!(id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-' || c == b'.'));
        assert!(!id.contains('/') && !id.contains('\\'));
        assert!(!id.starts_with('.') && !id.ends_with('.'));
        assert!(!id.contains(".."));
    }
    // Distinct labels must not collapse to one internal id.
    assert_ne!(node_id("Foo"), node_id("foo"));
    assert_ne!(node_id("a b"), node_id("a-b"));
    assert_ne!(node_id(""), node_id("node"));
    // The empty name stays a presence error, not a format constraint.
    let graph = Graph { nodes: vec![Node { name: String::new(), task: "task".into() }], ..Graph::default() };
    assert!(compile(&graph, true).unwrap_err().iter().any(|e| e.code == "E201"));
    // Legacy-safe names keep their identity so existing refs and worktrees stay valid.
    for name in ["a-dep-b_9".into(), "x".repeat(64)] {
        assert_eq!(node_id(&name), name);
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
fn compiler_warns_about_identical_tasks_without_rejecting_the_graph() {
    let mut candidate = Graph {
        original_goal: "Check repeated task text".into(),
        nodes: [
            ("third", "Shared task"),
            ("first", "Shared task"),
            ("other_b", "Other task"),
            ("other_a", "Other task"),
            ("spaced", "Shared task "),
            ("case", "shared task"),
        ]
        .into_iter()
        .map(|(name, task)| Node { name: name.into(), task: task.into() })
        .collect(),
        edges: vec![],
    };
    let expected = vec![
        "W301: Nodes other_a, other_b have identical task text; they may duplicate work. Confirm that this is intentional.",
        "W301: Nodes first, third have identical task text; they may duplicate work. Confirm that this is intentional.",
    ];
    assert_eq!(compile(&candidate, false).unwrap().warnings, expected);
    assert_eq!(compile(&candidate, true).unwrap().warnings, expected);
    // Group names deterministically, but do not normalize text or infer similarity.
    candidate.nodes.reverse();
    assert_eq!(compile(&candidate, true).unwrap().warnings, expected);
    candidate.nodes.iter_mut().find(|node| node.name == "first").unwrap().task = "First task".into();
    candidate.nodes.iter_mut().find(|node| node.name == "other_a").unwrap().task = "Another task".into();
    assert!(compile(&candidate, true).unwrap().warnings.is_empty());
}

#[test]
fn compiler_describes_feedback_invalidation_without_following_feedback_edges() {
    let mut candidate = graph();
    for name in ["inspect", "delivery"] {
        candidate.nodes.push(Node { name: name.into(), task: format!("Implement {name}") });
    }
    candidate.edges.extend([
        Edge { from: "frontend".into(), to: "inspect".into(), feedback: false },
        Edge { from: "inspect".into(), to: "spec".into(), feedback: true },
        Edge { from: "review".into(), to: "delivery".into(), feedback: false },
    ]);
    let plan = compile(&candidate, true).unwrap();
    assert_eq!(plan.warnings.len(), 2);
    assert!(plan.warnings.iter().all(|warning| warning.starts_with("W303:")));
    assert!(plan.warnings.iter().any(|warning| warning ==
        "W303: If <FEEDBACK> from review to frontend is applied, the target and dependency descendants will be invalidated: delivery, frontend, inspect, review. Completed results must be recomputed; frontend continues its conversation. Nodes outside this set are unaffected."
    ));
    assert!(plan.warnings.iter().any(|warning| warning ==
        "W303: If <FEEDBACK> from inspect to spec is applied, the target and dependency descendants will be invalidated: backend, delivery, frontend, inspect, review, spec. Completed results must be recomputed; spec continues its conversation. Nodes outside this set are unaffected."
    ));
    // Compare the reported set to the actual event, not a size heuristic or
    // merely the dependency path from the target to the feedback source.
    let temp = TempDir::new().unwrap();
    let mut runtime = Runtime::open(temp.path()).unwrap();
    runtime.create(candidate, config()).unwrap();
    runtime.emit(EventKind::Approved { base: "base".into() }).unwrap();
    finish_wave(&mut runtime, "<ACCEPT>");
    finish_wave(&mut runtime, "<ACCEPT>");
    let unaffected = ["backend", "spec"].map(|name| {
        let node = &runtime.state.nodes[name];
        (node.status.clone(), node.revision)
    });
    let jobs = runtime.jobs().unwrap();
    for job in jobs {
        let output = if job.execution.node == "review" { "Additional instruction\n<FEEDBACK>" } else { "<ACCEPT>" };
        let verdict = runtime.finish(&job.execution, Ok(("fake-head".into(), output.into()))).unwrap();
        if let Some((from, output)) = verdict { runtime.apply_feedback(&from, &output).unwrap(); }
    }
    runtime.jobs().unwrap();
    let invalidated = runtime.state.events.iter().rev().find_map(|event| match &event.kind {
        EventKind::Invalidated { nodes, target, .. } if target == "frontend" => Some(nodes),
        _ => None,
    }).unwrap();
    assert_eq!(invalidated, &vec!["delivery", "frontend", "inspect", "review"]);
    assert_eq!(
        ["backend", "spec"].map(|name| {
            let node = &runtime.state.nodes[name];
            (node.status.clone(), node.revision)
        }),
        unaffected
    );
}

#[test]
fn compiler_warns_when_feedback_marker_cannot_route_an_instruction() {
    let mut candidate = graph();
    candidate
        .nodes
        .iter_mut()
        .find(|node| node.name == "review")
        .unwrap()
        .task = "Check acceptance and finish with <FEEDBACK> if an additional instruction is needed".into();
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
        feedback: true,
    });
    let errors = compile(&candidate, true).unwrap_err();
    let error = errors.iter().find(|error| error.code == "E208").unwrap();
    assert!(error.message.contains("review"));
    assert!(error.message.contains("backend, frontend"));
    assert!(error.message.contains("at most one feedback target"));
    assert!(error.message.contains("Consider restructuring feedback ownership rather than merely dropping routes"));
    assert!(error.message.contains("possible approaches include separate feedback sources"));
    assert!(error.message.contains("a shared owner responsible for reworking the combined result"));
    assert!(error.message.contains("node tasks remain consistent with the resulting feedback routes"));
    // The suggestions add no graph-shape or task-wording requirements.
    assert!(compile(&graph(), true).is_ok());
    let mut retargeted = graph();
    retargeted.edges.iter_mut().find(|edge| edge.feedback).unwrap().to = "backend".into();
    assert!(compile(&retargeted, true).is_ok());
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
fn compiler_rejects_meaningless_feedback() {
    let mut invalid = graph();
    invalid.edges.last_mut().unwrap().from = "backend".into();
    assert_eq!(compile(&invalid, true).unwrap_err()[0].code, "E207");
    assert!(compile(&invalid, false).is_err());
    // Arbitrary labels are valid; only their internal id must stay safe.
    let arbitrary = Graph {
        original_goal: "g".into(),
        nodes: vec![Node { name: "../../escape".into(), task: "task".into() }],
        edges: Vec::new(),
    };
    compile(&arbitrary, true).unwrap();
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
    assert_eq!(feedback("Additional instruction\n<FEEDBACK>\n").unwrap(), true);
    assert_eq!(
        feedback("Earlier text mentions <FEEDBACK>\n<ACCEPT>").unwrap(),
        false
    );
    assert!(feedback("<ACCEPT> trailing text").is_err());
    assert!(feedback("<FEEDBACK> trailing text").is_err());
    assert!(feedback("```\n<ACCEPT>\n```").is_err());
    assert!(feedback("```\n<FEEDBACK>\n```").is_err());
    assert!(feedback("<Feedback>").is_err());
    assert!(feedback("<feedback>").is_err());
    assert!(feedback("<FEEDBACK>\nAdditional instruction").is_err());
    assert_eq!(feedback("").unwrap_err(), "Feedback protocol error: final line must be exactly <ACCEPT> or <FEEDBACK>");
}

#[test]
fn feedback_reexecutes_only_affected_branch_in_place() {
    let temp = TempDir::new().unwrap();
    let mut runtime = runtime(temp.path());
    runtime
        .emit(EventKind::Approved {
            base: "base".into(),
        })
        .unwrap();
    finish_wave(&mut runtime, "<ACCEPT>");
    finish_wave(&mut runtime, "<ACCEPT>");
    finish_wave(&mut runtime, "Add empty state\n<FEEDBACK>");
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
    // The owner's history is forked, but the reviewer's completed tree is used.
    assert_ne!(frontend[0].session_id, frontend[1].session_id);
    let review = runtime.state.executions.iter().find(|execution| execution.node == "review").unwrap();
    assert_eq!(frontend[1].worktree, review.worktree);
    assert_eq!(frontend[1].before, review.after.clone().unwrap());
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
fn exhausted_feedback_continues_downstream_without_rework_or_text_injection() {
    for configured_limit in [0, 1, 3, 8] {
        let temp = TempDir::new().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        let mut graph = graph();
        for name in ["delivery", "also_delivery"] {
            graph.nodes.push(Node { name: name.into(), task: format!("Implement {name}") });
            graph.edges.push(Edge { from: "review".into(), to: name.into(), feedback: false });
        }
        let mut config = config();
        config.max_feedback = configured_limit;
        runtime.create(graph, config).unwrap();
        runtime.emit(EventKind::Approved { base: "base".into() }).unwrap();
        finish_wave(&mut runtime, "<ACCEPT>");
        finish_wave(&mut runtime, "<ACCEPT>");
        let limit = configured_limit.min(3);
        for _ in 0..limit {
            finish_wave(&mut runtime, "Earlier rework\n<FEEDBACK>");
            finish_wave(&mut runtime, "<ACCEPT>");
        }
        let review = runtime.jobs().unwrap().remove(0);
        assert_eq!(review.execution.node, "review");
        assert!(!runtime.feedback_source_busy("review"), "exhausted edges cannot invalidate running work");
        // Even a large final response must not change consumers' task text.
        let body = format!("请处理未解决的问题🚀\n{}\n── Final response ──\nLast instruction", "反馈内容🚀".repeat(6000));
        let output = format!("{body}\n<FEEDBACK>\n");
        runtime.emit(EventKind::Output { execution_id: review.execution.id.clone(), text: "Earlier stream text must not be forwarded\n".into() }).unwrap();
        let (from, final_output) = runtime.finish(&review.execution, Ok(("review-head".into(), output.clone()))).unwrap().unwrap();
        let counts = runtime.state.feedback_counts.clone();
        let event_count = runtime.state.events.len();
        let frontend_head = runtime.state.nodes["frontend"].head.clone();
        runtime.apply_feedback(&from, &final_output).unwrap();
        assert_eq!(runtime.state.nodes["review"].status, "done");
        assert!(runtime.state.nodes["review"].error.is_none());
        assert_eq!(runtime.state.nodes["frontend"].head, frontend_head);
        assert_eq!(runtime.state.nodes["frontend"].status, "done");
        assert_eq!(runtime.state.nodes["backend"].status, "done");
        assert_eq!(runtime.state.feedback_counts, counts);
        assert_eq!(runtime.state.feedback_counts.get("review->frontend").copied().unwrap_or(0), limit);
        let warning: Vec<_> = runtime.state.events[event_count..].iter().filter(|event| matches!(event.kind, EventKind::FeedbackExhausted { .. })).collect();
        assert_eq!(warning.len(), 1);
        match &warning[0].kind {
            EventKind::FeedbackExhausted { from, to, execution_id, count, limit: recorded_limit } => {
                assert_eq!(from, "review");
                assert_eq!(to, "frontend");
                assert_eq!(execution_id, &review.execution.id);
                assert_eq!((*count, *recorded_limit), (limit, limit));
            }
            other => panic!("Expected exhaustion warning, got {other:?}"),
        }
        assert!(!serde_json::to_string(&runtime.state).unwrap().contains("Last instruction"), "do not duplicate the body in node state or events");
        // Event replay preserves the warning without altering task inputs.
        runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
        let jobs = runtime.jobs().unwrap();
        assert_eq!(jobs.iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(), vec!["delivery", "also_delivery"]);
        for job in jobs {
            assert_eq!(job.task, format!("Implement {}", job.execution.node), "dependency consumers receive no upstream text");
            assert_eq!(job.parent_heads, vec!["review-head".to_string()]);
            runtime.finish(&job.execution, Ok(("delivery-head".into(), "done".into()))).unwrap();
        }
        assert_eq!(runtime.state.feedback_counts, counts);
        assert_eq!(runtime.state.executions.iter().filter(|execution| execution.node == "frontend").count(), limit + 1);
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.phase, "publishing");
    }
}

#[test]
fn exhausted_feedback_does_not_wait_for_running_siblings() {
    let temp = TempDir::new().unwrap();
    let mut runtime = Runtime::open(temp.path()).unwrap();
    let graph = Graph {
        original_goal: "exhausted feedback with a running sibling".into(),
        nodes: ["owner", "review", "related", "consumer"].into_iter().map(|name| Node { name: name.into(), task: name.into() }).collect(),
        edges: [("owner", "review", false), ("owner", "related", false), ("review", "consumer", false), ("review", "owner", true)]
            .into_iter().map(|(from, to, feedback)| Edge { from: from.into(), to: to.into(), feedback }).collect(),
    };
    let mut config = config();
    config.max_feedback = 0;
    runtime.create(graph, config).unwrap();
    runtime.emit(EventKind::Approved { base: "base".into() }).unwrap();
    finish_wave(&mut runtime, "<ACCEPT>");
    let jobs = runtime.jobs().unwrap();
    assert_eq!(jobs.len(), 2);
    let review = jobs.iter().find(|job| job.execution.node == "review").unwrap();
    let (from, output) = runtime.finish(&review.execution, Ok(("review-head".into(), "Unresolved issue\n<FEEDBACK>".into()))).unwrap().unwrap();
    assert_eq!(runtime.state.nodes["related"].status, "running");
    assert!(!runtime.feedback_source_busy(&from));
    runtime.apply_feedback(&from, &output).unwrap();
    let consumer = runtime.jobs().unwrap().remove(0);
    assert_eq!(consumer.execution.node, "consumer");
    assert_eq!(consumer.task, "consumer");
    assert_eq!(runtime.state.nodes["owner"].status, "done");
    assert_eq!(runtime.state.nodes["related"].status, "running");
    assert!(runtime.state.feedback_counts.is_empty());
}

#[test]
fn exhausted_budget_does_not_mask_execution_or_protocol_failures() {
    for result in [Err("Pi failed".into()), Ok(("review-head".into(), "Missing final marker".into()))] {
        let temp = TempDir::new().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        let mut graph = graph();
        graph.nodes.push(Node { name: "consumer".into(), task: "consume".into() });
        graph.edges.push(Edge { from: "review".into(), to: "consumer".into(), feedback: false });
        let mut config = config();
        config.max_feedback = 0;
        runtime.create(graph, config).unwrap();
        runtime.emit(EventKind::Approved { base: "base".into() }).unwrap();
        finish_wave(&mut runtime, "<ACCEPT>");
        finish_wave(&mut runtime, "<ACCEPT>");
        let review = runtime.jobs().unwrap().remove(0);
        assert!(runtime.finish(&review.execution, result).unwrap().is_none());
        assert_eq!(runtime.state.nodes["review"].status, "failed");
        assert_eq!(runtime.state.executions.last().unwrap().status, "failed");
        assert!(!runtime.state.events.iter().any(|event| matches!(event.kind, EventKind::FeedbackExhausted { .. })));
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.nodes["consumer"].status, "blocked");
        assert_eq!(runtime.state.phase, "needs_attention");
    }
}

#[test]
fn acceptance_at_exhausted_budget_is_not_a_skipped_feedback_warning() {
    let temp = TempDir::new().unwrap();
    let mut runtime = Runtime::open(temp.path()).unwrap();
    let mut config = config();
    config.max_feedback = 0;
    runtime.create(graph(), config).unwrap();
    runtime.emit(EventKind::Approved { base: "base".into() }).unwrap();
    finish_wave(&mut runtime, "<ACCEPT>");
    finish_wave(&mut runtime, "<ACCEPT>");
    finish_wave(&mut runtime, "Summary\n<ACCEPT>");
    assert_eq!(runtime.state.nodes["review"].status, "done");
    assert!(runtime.state.feedback_counts.is_empty());
    assert!(!runtime.state.events.iter().any(|event| matches!(event.kind, EventKind::FeedbackExhausted { .. })));
    assert!(runtime.state.events.iter().any(|event| matches!(event.kind, EventKind::Feedback { accepted: true, .. })));
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
fn pause_drains_and_intervention_preserves_history() {
    let temp = TempDir::new().unwrap();
    let mut runtime = runtime(temp.path());
    runtime
        .emit(EventKind::Approved {
            base: "base".into(),
        })
        .unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    runtime.pause(true).unwrap();
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
    // Arbitrary labels are accepted but reach the ref namespace only as safe ids.
    let invalid_ref = format!("refs/grapher/nodes/{}", node_id("../invalid"));
    assert!(workspace::snapshot_node(&node_a, &repository, "../invalid").is_ok());
    assert!(workspace::git(&repository, &["rev-parse", "--verify", &invalid_ref]).is_ok());
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
