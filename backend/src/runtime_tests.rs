use super::*;
use tempfile::TempDir;

#[path = "node_model_tests.rs"]
mod node_models;

#[path = "node_message_queue_tests.rs"]
mod node_message_queue;

#[cfg(feature = "fixture")]
#[path = "feedback_workspace_tests.rs"]
mod feedback_workspace;

#[cfg(feature = "fixture")]
#[path = "recovery_workspace_tests.rs"]
mod recovery_workspace;

fn setup(git: bool, graph: Graph) -> (TempDir, PathBuf, Runtime) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("tracked.txt"), "original").unwrap();
    fs::write(source.join("deleted.txt"), "delete during planning").unwrap();
    if git {
        workspace::git(&source, &["init", "-q"]).unwrap();
        workspace::snapshot_repository(&source).unwrap();
    } else {
        workspace::verify(&source).unwrap();
    }
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": source, "model": "test", "maxParallel": 2, "maxFeedback": 1
    }))
    .unwrap();
    let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
    // These scheduler/replay tests synthesize results without native E/L seals.
    // Seed a legacy Created record instead of admitting a new managed Run.
    runtime.state.run_id = Uuid::new_v4().to_string();
    runtime
        .emit(EventKind::Created {
            graph,
            config,
            planning_id: None,
            planning: None,
        })
        .unwrap();
    runtime.store.select_run(Some(&runtime.state.run_id)).unwrap();
    runtime.set_route("graph").unwrap();
    (temp, source, runtime)
}

fn single() -> Graph {
    Graph {
        original_goal: "test".into(),
        nodes: vec![Node {
            name: "task".into(),
            task: "self-contained task".into(),
        }],
        edges: vec![],
    }
}

/// Emulate the server worker's lazy source materialization for tests that drive
/// jobs directly instead of through `perform`. A no-op for standard Git and
/// serial Runs.
fn attach(runtime: &mut Runtime, job: &mut Job) {
    if job.materialize_source {
        let exclusions = runtime.exclusions().unwrap();
        runtime.attach_job_source(job, &exclusions).unwrap();
    }
}

#[test]
fn legacy_created_runs_keep_their_unmanaged_contract_on_replay_and_approval() {
    let (_temp, _source, runtime) = setup(true, single());
    let root = runtime.root.clone();
    let run_id = runtime.state.run_id.clone();
    drop(runtime);
    let mut replayed = Runtime::open(&root).unwrap();
    assert_eq!(replayed.state.run_id, run_id);
    assert!(replayed.state.environment_policy.is_none());
    replayed.approve().unwrap();
    assert!(replayed.state.environment_policy.is_none());
    assert!(replayed.state.config.as_ref().unwrap().environment.is_none());
    assert!(replayed.state.environment_baseline.is_none());
    assert!(replayed
        .store
        .load(&run_id)
        .unwrap()
        .environment_policy
        .is_none());
}

#[cfg(not(feature = "fixture"))]
#[test]
fn new_graph_runs_require_composite_evidence_and_retain_managed_workspaces() {
    let (_temp, source, mut runtime) = setup(true, single());
    runtime
        .create(single(), runtime.state.config.clone().unwrap())
        .unwrap();
    assert_eq!(
        runtime.state.environment_policy.as_deref(),
        Some("automatic-pending")
    );
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();
    assert_eq!(
        runtime.state.environment_policy.as_deref(),
        Some("automatic-lazy")
    );
    assert!(runtime.state.environment_baseline.is_some());
    let job = runtime.jobs().unwrap().remove(0);
    let checkout = Path::new(&job.execution.worktree);
    workspace::prepare(&source, checkout, &job.execution.before, &[]).unwrap();
    runtime
        .finish(
            &job.execution,
            Ok((job.execution.before.clone(), "unsealed result".into())),
        )
        .unwrap();
    assert_eq!(runtime.state.nodes["task"].status, "failed");
    assert!(runtime.state.nodes["task"]
        .error
        .as_deref()
        .unwrap()
        .contains("Missing composite execution evidence"));
    assert!(runtime.state.executions[0].result.is_none());
    assert!(runtime.state.executions[0].after.is_none());
    runtime.cleanup_worktrees().unwrap();
    assert!(checkout.is_dir(), "managed partial work is retained");
    let run_id = runtime.state.run_id.clone();
    runtime.delete_run(&run_id).unwrap();
    assert!(
        !checkout.exists(),
        "explicit deletion still cleans the managed layout"
    );
    assert!(source.join("tracked.txt").is_file());
}

#[test]
fn cached_graph_workspaces_keep_durable_cleanup_when_the_source_moves() {
    let (temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    let checkout = PathBuf::from(&job.execution.worktree);
    assert!(checkout.starts_with(crate::native::host_path(&workspace::workspaces_parent(&runtime.root)).join(".grapher-worktrees").join(&runtime.state.run_id)));
    assert!(!temp.path().join(".grapher-worktrees").exists(), "new workspaces are not project-adjacent");
    workspace::prepare(&source, &checkout, &job.execution.before, &[]).unwrap();
    assert!(runtime.store.owned_cleanup_targets(&runtime.state.run_id).unwrap().iter().any(|target| {
        matches!(target, crate::cleanup::Target::Workspace { parent, bucket, .. }
            if parent == &runtime.root.join("workspaces").canonicalize().unwrap() && bucket == ".grapher-worktrees")
    }));
    runtime.finish(&job.execution, Err("stopped".into())).unwrap();
    fs::rename(&source, temp.path().join("moved-source")).unwrap();
    runtime.cleanup_worktrees().unwrap();
    assert!(!checkout.exists());
    assert!(temp.path().join("moved-source/tracked.txt").is_file());
}

#[test]
fn cleanup_refuses_linked_workspace_roots_without_deleting_external_data() {
    for name in [".grapher-worktrees", ".grapher-workspaces"] {
        let (temp, _source, runtime) = setup(true, single());
        let outside = temp.path().join("external");
        let retained = outside.join(&runtime.state.run_id);
        fs::create_dir_all(&retained).unwrap();
        fs::write(retained.join("marker"), "external data").unwrap();
        crate::path_safety::directory_link(&outside, &temp.path().join(name));
        let own_node = temp.path().join(".grapher-worktrees").join(&runtime.state.run_id);
        if name == ".grapher-workspaces" {
            fs::create_dir_all(&own_node).unwrap();
            fs::write(own_node.join("marker"), "keep on rejected cleanup").unwrap();
        }
        assert!(runtime.cleanup_worktrees().unwrap_err().contains("Refusing"));
        assert_eq!(fs::read_to_string(retained.join("marker")).unwrap(), "external data");
        if name == ".grapher-workspaces" {
            assert_eq!(fs::read_to_string(own_node.join("marker")).unwrap(), "keep on rejected cleanup");
        }
    }
}

#[test]
fn cleanup_uses_physical_source_parent_and_preserves_alias_parent_workspaces() {
    let (temp, source, mut runtime) = setup(true, single());
    let alias_parent = temp.path().join("alias-parent");
    fs::create_dir(&alias_parent).unwrap();
    let alias = alias_parent.join("source-alias");
    crate::path_safety::directory_link(&source, &alias);
    runtime.state.config.as_mut().unwrap().repository = alias.to_string_lossy().into();
    let actual = temp.path().join(".grapher-worktrees").join(&runtime.state.run_id);
    let decoy = alias_parent.join(".grapher-worktrees").join(&runtime.state.run_id);
    let other = temp.path().join(".grapher-worktrees").join(Uuid::new_v4().to_string());
    for path in [&actual, &decoy, &other] {
        fs::create_dir_all(path).unwrap();
        fs::write(path.join("marker"), "retained").unwrap();
    }
    runtime.cleanup_worktrees().unwrap();
    assert!(!actual.exists());
    assert_eq!(fs::read_to_string(decoy.join("marker")).unwrap(), "retained");
    assert_eq!(fs::read_to_string(other.join("marker")).unwrap(), "retained");
}

#[test]
fn cleanup_unlinks_nested_directory_links_without_following_their_targets() {
    let (temp, _source, runtime) = setup(true, single());
    let owned = temp.path().join(".grapher-worktrees").join(&runtime.state.run_id);
    let outside = temp.path().join("external");
    fs::create_dir_all(&owned).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("marker"), "external data").unwrap();
    crate::path_safety::directory_link(&outside, &owned.join("nested-link"));
    runtime.cleanup_worktrees().unwrap();
    assert!(!owned.exists());
    assert_eq!(fs::read_to_string(outside.join("marker")).unwrap(), "external data");
}

#[test]
fn missing_source_binding_still_cleans_previously_recorded_workspace_ownership() {
    let (temp, source, mut runtime) = setup(true, single());
    let retained = temp.path().join(".grapher-worktrees").join(&runtime.state.run_id);
    fs::create_dir_all(&retained).unwrap();
    fs::write(retained.join("marker"), "retained").unwrap();
    fs::rename(&source, temp.path().join("moved-source")).unwrap();
    runtime.reset_workspace().unwrap();
    assert!(!retained.exists());
    assert_eq!(fs::read_to_string(temp.path().join("moved-source/tracked.txt")).unwrap(), "original");
}

#[test]
fn deleting_a_historical_run_recursively_cleans_its_nodes_without_changing_selection() {
    for git in [false, true] {
        let (temp, source, mut runtime) = setup(git, single());
        let historical = runtime.state.run_id.clone();
        let config = runtime.state.config.clone().unwrap();
        runtime.create(single(), config).unwrap();
        runtime.set_route("graph").unwrap();
        let current = runtime.state.run_id.clone();
        for name in [".grapher-worktrees", ".grapher-workspaces"] {
            for id in [&historical, &current] {
                let path = temp.path().join(name).join(id).join("node/retry/dependencies");
                fs::create_dir_all(&path).unwrap();
                fs::write(path.join("large-file"), "owned node data").unwrap();
            }
        }
        runtime.delete_run(&historical).unwrap();
        for name in [".grapher-worktrees", ".grapher-workspaces"] {
            assert!(!temp.path().join(name).join(&historical).exists());
            assert!(temp.path().join(name).join(&current).join("node/retry/dependencies/large-file").is_file());
        }
        assert_eq!(runtime.state.run_id, current);
        assert_eq!(runtime.store.selected_run().unwrap().as_deref(), Some(current.as_str()));
        assert!(!runtime.store.contains_run(&historical).unwrap());
        assert!(source.join("tracked.txt").is_file());
    }
}

#[test]
fn deleting_a_run_cleans_earlier_planner_copies_and_uncommitted_revision_attempts() {
    let (temp, source, mut runtime) = setup(true, single());
    let first = Uuid::new_v4().to_string();
    let latest = Uuid::new_v4().to_string();
    let failed_revision = Uuid::new_v4().to_string();
    let owner = Uuid::new_v4().to_string();
    runtime.create_with_planning(single(), runtime.state.config.clone().unwrap(),
        Some(first.clone()), None).unwrap();
    let run_id = runtime.state.run_id.clone();
    let legacy = temp.path().join(".grapher-workspaces").join(&owner).join(&first);
    let failed = temp.path().join(".grapher-workspaces").join(&owner).join(&failed_revision);
    let sibling = temp.path().join(".grapher-workspaces").join(&owner).join(Uuid::new_v4().to_string());
    for path in [&legacy, &failed, &sibling] {
        fs::create_dir_all(path.join("node/dependencies")).unwrap();
        fs::write(path.join("node/dependencies/marker"), "owned").unwrap();
    }
    for (id, workspace) in [(&first, &legacy), (&latest, &source), (&failed_revision, &failed)] {
        let attempt = runtime.root.join("planning").join(id);
        fs::create_dir_all(&attempt).unwrap();
        fs::write(attempt.join("planner-workspace"), workspace.to_string_lossy().as_bytes()).unwrap();
    }
    fs::write(runtime.root.join("planning").join(&failed_revision).join("request.json"),
        serde_json::json!({"revisionRunId": run_id}).to_string()).unwrap();
    runtime.emit(EventKind::GraphRevised {
        graph: single(), planning_id: latest.clone(), planning: PlanningSummary {
            planning_id: latest.clone(), ..Default::default()
        }, invalidated: Vec::new(), source_head: None,
    }).unwrap();
    assert_eq!(runtime.state.planning_id.as_deref(), Some(latest.as_str()));
    runtime.delete_run(&run_id).unwrap();
    assert!(!legacy.exists(), "Created's earlier planning marker must not be forgotten");
    assert!(!failed.exists(), "failed revision requests also own their private copies");
    assert!(sibling.join("node/dependencies/marker").is_file(), "do not remove another owner's siblings");
    assert!(source.join("tracked.txt").is_file(), "modern source cwd is not a deletion target");
}

#[test]
fn serial_cleanup_removes_owned_private_leftovers_but_never_the_source_cwd() {
    let (temp, source, mut runtime) = setup(true, single());
    runtime.set_route("serial").unwrap();
    for name in [".grapher-worktrees", ".grapher-workspaces"] {
        fs::create_dir_all(temp.path().join(name).join(&runtime.state.run_id).join("old-node/dependencies")).unwrap();
    }
    let id = runtime.state.run_id.clone();
    runtime.delete_run(&id).unwrap();
    for name in [".grapher-worktrees", ".grapher-workspaces"] {
        assert!(!temp.path().join(name).join(&id).exists());
    }
    assert_eq!(fs::read_to_string(source.join("tracked.txt")).unwrap(), "original");
}

#[test]
fn clearing_history_cleans_every_saved_run_and_preserves_unknown_directories() {
    let (temp, source, mut runtime) = setup(true, single());
    let mut ids = vec![runtime.state.run_id.clone()];
    for _ in 0..2 {
        runtime.create(single(), runtime.state.config.clone().unwrap()).unwrap();
        ids.push(runtime.state.run_id.clone());
    }
    let unknown = Uuid::new_v4().to_string();
    for name in [".grapher-worktrees", ".grapher-workspaces"] {
        for id in ids.iter().chain(std::iter::once(&unknown)) {
            let path = temp.path().join(name).join(id).join("nested/node");
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("marker"), "workspace").unwrap();
        }
    }
    runtime.clear_history().unwrap();
    for name in [".grapher-worktrees", ".grapher-workspaces"] {
        for id in &ids { assert!(!temp.path().join(name).join(id).exists()); }
        assert!(temp.path().join(name).join(&unknown).join("nested/node/marker").is_file());
    }
    assert!(runtime.store.runs().unwrap().is_empty());
    assert!(source.join("tracked.txt").is_file());
}

#[test]
fn failed_historical_cleanup_keeps_database_ownership_for_retry() {
    let (temp, _source, mut runtime) = setup(true, single());
    let old_id = runtime.state.run_id.clone();
    runtime.create(single(), runtime.state.config.clone().unwrap()).unwrap();
    let retained = temp.path().join(".grapher-worktrees").join(&old_id);
    fs::create_dir_all(&retained).unwrap();
    let outside = temp.path().join("outside");
    fs::create_dir_all(outside.join(&old_id)).unwrap();
    crate::path_safety::directory_link(&outside, &temp.path().join(".grapher-workspaces"));
    assert!(runtime.delete_run(&old_id).is_err());
    assert!(runtime.store.contains_run(&old_id).unwrap());
    assert!(retained.is_dir(), "validate all targets before deleting the first one");
    assert!(outside.join(&old_id).is_dir());
}

#[test]
fn deleting_a_noncurrent_running_run_is_rejected() {
    let (temp, _source, mut worker) = setup(true, single());
    worker.approve().unwrap();
    worker.jobs().unwrap();
    let id = worker.state.run_id.clone();
    let path = temp.path().join(".grapher-worktrees").join(&id);
    fs::create_dir_all(&path).unwrap();
    let mut idle = worker.open_run("").unwrap();
    assert!(idle.delete_run(&id).unwrap_err().contains("running"));
    assert!(path.is_dir());
    assert!(worker.store.contains_run(&id).unwrap());
}

#[test]
fn node_workers_respect_per_run_limit_and_keep_scheduling_as_slots_open() {
    let graph = Graph {
        original_goal: "parallel".into(),
        nodes: (0..12)
            .map(|i| Node {
                name: format!("worker{i}"),
                task: "work".into(),
            })
            .collect(),
        edges: vec![],
    };
    for (max_parallel, limit) in [(0, 8), (1, 1), (2, 2), (8, 8), (100, 8)] {
        let (_temp, _source, mut runtime) = setup(true, graph.clone());
        let mut config = runtime.state.config.clone().unwrap();
        config.max_parallel = max_parallel;
        runtime.edit_draft_graph(graph.clone(), config).unwrap();
        runtime.approve().unwrap();
        let mut jobs = runtime.jobs().unwrap();
        assert_eq!(jobs.len(), limit, "max_parallel={max_parallel}");
        assert!(runtime.jobs().unwrap().is_empty());
        let first = jobs.remove(0);
        runtime
            .emit(EventKind::Finished {
                execution_id: first.execution.id,
                head: runtime.state.base.clone(),
                output: "completed".into(), output_bytes: 0, metrics: None,
            })
            .unwrap();
        assert_eq!(
            runtime.jobs().unwrap().len(),
            1,
            "max_parallel={max_parallel}"
        );
    }
}

#[test]
fn feedback_scope_does_not_block_a_shared_ancestors_other_branch() {
    let graph = Graph {
        original_goal: "feedback and independent work".into(),
        nodes: ["root", "owner", "review", "related", "fast", "after_fast"]
            .into_iter()
            .map(|name| Node { name: name.into(), task: name.into() })
            .collect(),
        edges: [
            ("root", "owner", false),
            ("root", "fast", false),
            ("owner", "review", false),
            ("owner", "related", false),
            ("review", "owner", true),
            ("fast", "after_fast", false),
        ]
        .into_iter()
        .map(|(from, to, feedback)| Edge {
            from: from.into(), to: to.into(), feedback,
        }).collect(),
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let root = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: root.execution.id, head: runtime.state.base.clone(), output: "completed".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    let first = runtime.jobs().unwrap();
    assert_eq!(first.len(), 2);
    assert!(runtime.feedback_source_busy("review"));
    let fast = first.iter().find(|job| job.execution.node == "fast").unwrap();
    runtime.emit(EventKind::Finished {
        execution_id: fast.execution.id.clone(), head: runtime.state.base.clone(), output: "completed".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    assert_eq!(runtime.jobs().unwrap().iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(), vec!["after_fast"]);
    assert_eq!(runtime.state.nodes["owner"].status, "running");
    assert_eq!(runtime.state.nodes["related"].status, "waiting");
}


#[test]
fn pending_feedback_blocks_review_consumers_but_not_independent_work() {
    let graph = Graph {
        original_goal: "pending review".into(),
        nodes: ["owner", "related", "review", "consumer", "other", "after_other"]
            .into_iter()
            .map(|name| Node { name: name.into(), task: name.into() })
            .collect(),
        edges: [
            ("owner", "related", false),
            ("owner", "review", false),
            ("review", "owner", true),
            ("review", "consumer", false),
            ("other", "after_other", false),
        ]
        .into_iter()
        .map(|(from, to, feedback)| Edge {
            from: from.into(), to: to.into(), feedback,
        })
        .collect(),
    };
    let (_temp, _source, mut runtime) = setup(true, graph.clone());
    let mut config = runtime.state.config.clone().unwrap();
    config.max_parallel = 4;
    runtime.edit_draft_graph(graph, config).unwrap();
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap();
    let owner = first.iter().find(|job| job.execution.node == "owner").unwrap();
    runtime.emit(EventKind::Finished {
        execution_id: owner.execution.id.clone(), head: runtime.state.base.clone(), output: "completed".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    let next = runtime.jobs().unwrap();
    let review = next.iter().find(|job| job.execution.node == "review").unwrap();
    runtime.emit(EventKind::Finished {
        execution_id: review.execution.id.clone(), head: runtime.state.base.clone(), output: "<FEEDBACK>".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    assert!(runtime.feedback_source_busy("review"));
    let other = first.iter().find(|job| job.execution.node == "other").unwrap();
    runtime.emit(EventKind::Finished {
        execution_id: other.execution.id.clone(), head: runtime.state.base.clone(), output: "completed".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    let jobs = runtime.jobs_with_pending_feedback(true, &["review"]).unwrap();
    assert_eq!(jobs.iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(), vec!["after_other"]);
    assert_eq!(runtime.state.nodes["consumer"].status, "waiting");
    assert_eq!(runtime.state.phase, "running");
}

#[test]
fn resolved_feedback_allows_ready_descendants_while_sibling_runs() {
    // Reproduce the two accepted reviews in the BranchB graph: node 13 must
    // not stop nodes 11/14/15 from consuming node 10's completed result.
    let graph = Graph {
        original_goal: "accepted reviews do not serialize downstream work".into(),
        nodes: ["04", "06", "08", "09", "10", "13", "11", "14", "15", "16"]
            .into_iter()
            .map(|name| Node { name: name.into(), task: name.into() })
            .collect(),
        edges: [
            ("04", "06", false),
            ("06", "04", true),
            ("06", "08", false),
            ("08", "09", false),
            ("09", "08", true),
            ("09", "10", false),
            ("09", "13", false),
            ("10", "11", false),
            ("10", "14", false),
            ("10", "15", false),
            ("11", "16", false),
            ("13", "16", false),
            ("14", "16", false),
            ("15", "16", false),
        ]
        .into_iter()
        .map(|(from, to, feedback)| Edge { from: from.into(), to: to.into(), feedback })
        .collect(),
    };
    let (_temp, _source, mut runtime) = setup(true, graph.clone());
    let mut config = runtime.state.config.clone().unwrap();
    config.max_parallel = 0;
    config.max_feedback = 3;
    runtime.edit_draft_graph(graph, config).unwrap();
    runtime.approve().unwrap();
    for name in ["04", "06", "08", "09"] {
        let jobs = runtime.jobs().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].execution.node, name);
        let output = if jobs[0].feedback_source { "<ACCEPT>" } else { "completed" };
        runtime.finish(&jobs[0].execution, Ok((runtime.state.base.clone(), output.into()))).unwrap();
    }
    let jobs = runtime.jobs().unwrap();
    assert_eq!(jobs.iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(), vec!["10", "13"]);
    assert!(runtime.state.pending_feedback.is_empty());
    for from in ["06", "09"] {
        assert!(runtime.state.events.iter().any(|event| matches!(
            &event.kind, EventKind::Feedback { from: source, accepted: true, .. } if source == from
        )));
    }
    let evaluation = jobs.iter().find(|job| job.execution.node == "10").unwrap();
    runtime.finish(&evaluation.execution, Ok((runtime.state.base.clone(), "evaluated".into()))).unwrap();
    // Replay the durable projection, without restarting/recovering live workers.
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(runtime.state.nodes["13"].status, "running");
    assert!(runtime.state.pending_feedback.is_empty());
    assert!(runtime.state.feedback_counts.is_empty(), "acceptance does not exhaust the feedback budget");
    let consumers = runtime.jobs().unwrap();
    assert_eq!(consumers.iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(), vec!["11", "14", "15"]);
    assert_eq!(runtime.state.nodes["13"].status, "running");
    assert_eq!(runtime.state.nodes["16"].status, "waiting");
    assert!(runtime.jobs().unwrap().is_empty());
}

#[test]
fn queued_feedback_keeps_scope_blocked_until_related_workers_drain() {
    for verdict in ["<ACCEPT>", "<FEEDBACK>"] {
        let graph = Graph {
            original_goal: "queued verdict retains its drain barrier".into(),
            nodes: ["owner", "review", "slow", "fast", "after_fast", "consumer", "other", "after_other"]
                .into_iter()
                .map(|name| Node { name: name.into(), task: name.into() })
                .collect(),
            edges: [
                ("owner", "review", false),
                ("owner", "slow", false),
                ("owner", "fast", false),
                ("fast", "after_fast", false),
                ("review", "consumer", false),
                ("review", "owner", true),
                ("other", "after_other", false),
            ]
            .into_iter()
            .map(|(from, to, feedback)| Edge { from: from.into(), to: to.into(), feedback })
            .collect(),
        };
        let (_temp, _source, mut runtime) = setup(true, graph.clone());
        let mut config = runtime.state.config.clone().unwrap();
        config.max_parallel = 4;
        runtime.edit_draft_graph(graph, config).unwrap();
        runtime.approve().unwrap();
        let roots = runtime.jobs().unwrap();
        let owner = roots.iter().find(|job| job.execution.node == "owner").unwrap();
        runtime.finish(&owner.execution, Ok((runtime.state.base.clone(), "completed".into()))).unwrap();
        let jobs = runtime.jobs().unwrap();
        assert_eq!(jobs.iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(), vec!["review", "slow", "fast"]);
        let fast = jobs.iter().find(|job| job.execution.node == "fast").unwrap();
        runtime.finish(&fast.execution, Ok((runtime.state.base.clone(), "completed".into()))).unwrap();
        let review = jobs.iter().find(|job| job.execution.node == "review").unwrap();
        runtime.finish(&review.execution, Ok((runtime.state.base.clone(), verdict.into()))).unwrap();
        let other = roots.iter().find(|job| job.execution.node == "other").unwrap();
        runtime.finish(&other.execution, Ok((runtime.state.base.clone(), "completed".into()))).unwrap();
        runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
        assert_eq!(runtime.state.nodes["review"].status, "completed");
        assert_eq!(runtime.state.nodes["slow"].status, "running");
        assert_eq!(runtime.state.pending_feedback.len(), 1);
        let independent = runtime.jobs().unwrap();
        assert_eq!(independent.iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(), vec!["after_other"]);
        assert_eq!(runtime.state.nodes["after_fast"].status, "waiting");
        assert_eq!(runtime.state.nodes["consumer"].status, "waiting");
        assert_eq!(runtime.state.pending_feedback.len(), 1, "{verdict} must still wait for the related worker");
    }
}

#[test]
fn resolved_feedback_barrier_reactivates_when_review_is_rerun() {
    let graph = Graph {
        original_goal: "a new review can invalidate its target again".into(),
        nodes: ["owner", "review", "related", "after_related"]
            .into_iter()
            .map(|name| Node { name: name.into(), task: name.into() })
            .collect(),
        edges: [
            ("owner", "review", false),
            ("owner", "related", false),
            ("related", "after_related", false),
            ("review", "owner", true),
        ]
        .into_iter()
        .map(|(from, to, feedback)| Edge { from: from.into(), to: to.into(), feedback })
        .collect(),
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let owner = runtime.jobs().unwrap().remove(0);
    runtime.finish(&owner.execution, Ok((runtime.state.base.clone(), "completed".into()))).unwrap();
    for job in runtime.jobs().unwrap() {
        let output = if job.feedback_source { "<ACCEPT>" } else { "completed" };
        runtime.finish(&job.execution, Ok((runtime.state.base.clone(), output.into()))).unwrap();
    }
    let related = runtime.jobs().unwrap().remove(0);
    assert_eq!(related.execution.node, "after_related");
    assert!(runtime.state.pending_feedback.is_empty());
    runtime.intervene("review", "review the owner again").unwrap();
    assert_eq!(runtime.state.nodes["review"].status, "dirty");
    assert!(runtime.jobs().unwrap().is_empty(), "a new verdict must wait for the affected worker");
    runtime.finish(&related.execution, Ok((runtime.state.base.clone(), "completed".into()))).unwrap();
    let review = runtime.jobs().unwrap().remove(0);
    assert_eq!(review.execution.node, "review");
    assert!(review.feedback_source);
}

#[test]
fn named_parents_resolve_against_their_own_run_refs() {
    let (temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let other_run = Uuid::new_v4().to_string();
    for (id, content) in [(&runtime.state.run_id, "first"), (&other_run, "second")] {
        let path = temp.path().join(content);
        workspace::prepare(&source, &path, &runtime.state.base, &[]).unwrap();
        fs::write(path.join("tracked.txt"), content).unwrap();
        workspace::snapshot_node_for_run(&path, &source, "task", Some(id)).unwrap();
    }
    let target = temp.path().join("named-parent");
    workspace::prepare_with_merger_expected_for_run(
        &source, &target, &runtime.state.base, &["task".into()], &runtime.state.base,
        Some(&runtime.state.run_id), || Err("unexpected conflict".into()),
    ).unwrap();
    assert_eq!(fs::read_to_string(target.join("tracked.txt")).unwrap(), "first");
}

#[test]
fn parallel_snapshots_of_one_host_repository_do_not_race_ref_locks() {
    let (temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let run_id = runtime.state.run_id.clone();
    let mut paths = Vec::new();
    for i in 0..8 {
        let path = temp.path().join(format!("worker{i}"));
        workspace::prepare(&source, &path, &runtime.state.base, &[]).unwrap();
        fs::write(path.join(format!("worker{i}.txt")), format!("{i}")).unwrap();
        paths.push(path);
    }
    std::thread::scope(|scope| {
        let workers: Vec<_> = paths.iter().enumerate().map(|(i, path)| {
            let source = &source;
            let run_id = &run_id;
            scope.spawn(move || workspace::snapshot_node_for_run(path, source, &format!("worker{i}"), Some(run_id)))
        }).collect();
        for (i, worker) in workers.into_iter().enumerate() {
            let head = worker.join().unwrap().unwrap();
            assert_eq!(workspace::git(&source, &["rev-parse", &format!("refs/grapher/runs/{run_id}/nodes/worker{i}")]).unwrap(), head);
        }
    });
}

#[test]
fn messaging_completed_node_preserves_its_result_and_running_downstream() {
    let graph = Graph {
        original_goal: "message".into(),
        nodes: ["parent", "child"].into_iter().map(|name| Node {
            name: name.into(), task: name.into(),
        }).collect(),
        edges: vec![Edge {
            from: "parent".into(), to: "child".into(), feedback: false,
        }],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let parent = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: parent.execution.id, head: runtime.state.base.clone(), output: "completed".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    let child = runtime.jobs().unwrap().remove(0);
    let before = runtime.state.nodes.clone();
    let executions = runtime.state.executions.len();
    let images = Some(vec![ImageAttachment {
        r#type: "image".into(), mime_type: "image/png".into(), data: "abc".into(), name: None,
    }]);
    runtime.message_completed_node("parent", "  new instruction  ", images.clone()).unwrap();
    assert_eq!(serde_json::to_value(&runtime.state.nodes).unwrap(), serde_json::to_value(before).unwrap());
    assert_eq!(runtime.state.executions.len(), executions);
    assert_eq!(runtime.state.nodes["child"].status, "running");
    assert!(runtime.jobs().unwrap().is_empty());
    let replayed = runtime.store.load(&runtime.state.run_id).unwrap();
    assert!(matches!(replayed.events.last().unwrap().kind, EventKind::NodeMessaged {
        ref node, ref instruction, images: ref saved,
    } if node == "parent" && instruction == "new instruction" &&
        serde_json::to_value(saved).unwrap() == serde_json::to_value(&images).unwrap()));
    assert!(runtime.message_completed_node("child", "no", None).is_err());
    assert!(runtime.message_completed_node("parent", "   ", None).is_err());
    assert_eq!(runtime.state.executions.last().unwrap().id, child.execution.id);
}

#[test]
fn message_after_run_completed_keeps_it_completed() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: job.execution.id, head: runtime.state.base.clone(), output: "completed".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    runtime.emit(EventKind::Settled).unwrap();
    let head = runtime.state.nodes["task"].head.clone();
    runtime.message_completed_node("task", "hello", None).unwrap();
    assert_eq!(runtime.state.phase, "completed");
    assert_eq!(runtime.state.nodes["task"].head, head);
    assert_eq!(runtime.state.nodes["task"].status, "completed");
    assert_eq!(runtime.state.executions.len(), 1);
    assert!(runtime.jobs().unwrap().is_empty());
}

#[test]
fn intervention_continues_the_previous_result_in_place() {
    let (_temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    let session_id = first.execution.session_id.clone();
    let first_execution_id = first.execution.id.clone();
    let path = Path::new(&first.execution.worktree);
    workspace::prepare(&source, path, &first.execution.before, &[]).unwrap();
    fs::write(path.join("tracked.txt"), "first result").unwrap();
    let head = workspace::snapshot_node_for_run(path, &source, "task", Some(&runtime.state.run_id)).unwrap();
    runtime.emit(EventKind::Finished {
        execution_id: first.execution.id, head: head.clone(), output: "completed".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    runtime.intervene("task", "continue").unwrap();
    assert_eq!(runtime.state.nodes["task"].head, Some(head.clone()));
    let followup = runtime.jobs().unwrap().remove(0);
    assert_eq!(followup.execution.before, head);
    assert_eq!(followup.execution.worktree, path.to_string_lossy());
    assert_eq!(followup.execution.session_id, session_id);
    assert_eq!(followup.resume_execution_id.as_deref(), Some(first_execution_id.as_str()));
}

#[test]
fn serial_followup_resumes_completed_pi_session_with_images_after_settlement() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.set_route("serial").unwrap();
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: first.execution.id.clone(), head: runtime.state.base.clone(), output: "completed".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    runtime.jobs().unwrap(); // settle the run
    assert_eq!(runtime.state.phase, "completed");

    let images = vec![ImageAttachment {
        r#type: "image".into(), mime_type: "image/png".into(), data: "aGVsbG8=".into(), name: None,
    }];
    runtime.intervene_with_images("task", "next turn", Some(images.clone())).unwrap();
    assert_eq!(runtime.state.phase, "running");
    let replayed = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(serde_json::to_value(&replayed.nodes["task"].instruction_images).unwrap(), serde_json::to_value(&images).unwrap());
    let next = runtime.jobs().unwrap().remove(0);
    assert_eq!(next.task, "next turn");
    assert_eq!(serde_json::to_value(&next.images).unwrap(), serde_json::to_value(&images).unwrap());
    assert_eq!(next.resume_execution_id, Some(first.execution.id));
    assert_eq!(next.execution.session_id, first.execution.session_id);
    assert_eq!(next.execution.worktree, first.execution.worktree);
}

#[test]
fn messaging_a_failed_node_resumes_its_session_without_a_successful_result() {
    for route in ["graph", "serial"] {
        for paused in [false, true] {
            let (_temp, _source, mut runtime) = setup(true, single());
            runtime.set_route(route).unwrap();
            runtime.approve().unwrap();
            let failed = runtime.jobs().unwrap().remove(0);
            runtime.finish(&failed.execution, Err("Provider failed".into())).unwrap();
            runtime.jobs().unwrap();
            assert_eq!(runtime.state.phase, "needs_attention");
            assert!(!runtime.state.can_resume_interrupted());
            assert_eq!(runtime.state.nodes["task"].status, "failed");
            assert!(runtime.state.executions[0].after.is_none());
            if paused {
                runtime.pause(true).unwrap();
            }
            let event_count = runtime.state.events.len();
            assert!(runtime.intervene("task", "   ").is_err());
            assert!(runtime.intervene("missing", "retry").is_err());
            assert_eq!(runtime.state.events.len(), event_count);

            let images = Some(vec![ImageAttachment {
                r#type: "image".into(), mime_type: "image/png".into(),
                data: "aGVsbG8=".into(), name: None,
            }]);
            runtime.intervene_with_images("task", "  retry with this image  ", images.clone()).unwrap();
            assert_eq!(runtime.state.nodes["task"].status, "dirty");
            assert_eq!(runtime.state.nodes["task"].error, None);
            assert_eq!(runtime.state.nodes["task"].revision, 2);
            let replayed = runtime.store.load(&runtime.state.run_id).unwrap();
            assert_eq!(replayed.phase, if paused { "paused" } else { "running" });
            assert_eq!(replayed.nodes["task"].instruction, "retry with this image");
            assert_eq!(replayed.executions[0].status, "failed");
            if paused {
                assert!(runtime.jobs().unwrap().is_empty());
                runtime.pause(false).unwrap();
            }

            let next = runtime.jobs().unwrap().remove(0);
            assert_eq!(runtime.state.phase, "running");
            assert_eq!(runtime.state.nodes["task"].status, "running");
            assert_eq!(next.task, "retry with this image");
            assert_eq!(serde_json::to_value(&next.images).unwrap(), serde_json::to_value(&images).unwrap());
            assert_ne!(next.execution.id, failed.execution.id);
            assert_eq!(next.execution.attempt, 2);
            assert_eq!(next.execution.session_id, failed.execution.session_id);
            assert_eq!(next.execution.worktree, failed.execution.worktree);
            assert_eq!(next.resume_execution_id, Some(failed.execution.id.clone()));
            assert_eq!(runtime.state.executions[0].status, "failed");
            assert!(runtime.state.executions[0].after.is_none());
            runtime.finish(&next.execution, Ok((runtime.state.base.clone(), "recovered".into()))).unwrap();
            assert_eq!(runtime.state.nodes["task"].status, "completed");
        }
    }
}

#[test]
fn messaging_a_failed_followup_keeps_the_original_session_and_last_result() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    let head = runtime.state.base.clone();
    runtime.finish(&first.execution, Ok((head.clone(), "completed".into()))).unwrap();
    runtime.intervene("task", "second turn").unwrap();
    let failed = runtime.jobs().unwrap().remove(0);
    runtime.finish(&failed.execution, Err("Provider failed".into())).unwrap();
    runtime.jobs().unwrap();
    runtime.intervene("task", "try again").unwrap();
    let next = runtime.jobs().unwrap().remove(0);
    assert_eq!(runtime.state.nodes["task"].status, "running");
    assert_eq!(next.execution.before, head);
    assert_eq!(next.execution.attempt, 3);
    assert_eq!(next.execution.session_id, failed.execution.session_id);
    assert_eq!(next.execution.worktree, failed.execution.worktree);
    assert_eq!(next.resume_execution_id, Some(first.execution.id));
    assert_eq!(runtime.state.executions[1].status, "failed");
}

#[test]
fn editing_an_earlier_serial_turn_branches_pi_and_supersedes_later_executions() {
    let (_temp, source, mut runtime) = setup(true, single());
    runtime.set_route("serial").unwrap();
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: first.execution.id.clone(), head: runtime.state.base.clone(), output: "first".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    runtime.intervene("task", "second").unwrap();
    let second = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: second.execution.id.clone(), head: runtime.state.base.clone(), output: "second".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    runtime.intervene("task", "third").unwrap();
    let third = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: third.execution.id.clone(), head: runtime.state.base.clone(), output: "third".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    let session_dir = runtime.root.join("sessions").join(&first.execution.id);
    fs::create_dir_all(&session_dir).unwrap();
    let file = session_dir.join(format!("test_{}.jsonl", first.execution.session_id));
    let entries = [
        serde_json::json!({"type":"session", "id":first.execution.session_id, "cwd":source}),
        serde_json::json!({"type":"message", "id":"root", "parentId":null, "message":{"role":"system", "content":"system"}}),
        serde_json::json!({"type":"message", "id":"one", "parentId":"root", "message":{"role":"user", "content":"self-contained task", "timestamp":first.execution.started_at}}),
        serde_json::json!({"type":"message", "id":"answer1", "parentId":"one", "message":{"role":"assistant", "content":[]}}),
        serde_json::json!({"type":"message", "id":"two", "parentId":"answer1", "message":{"role":"user", "content":"second", "timestamp":second.execution.started_at}}),
        serde_json::json!({"type":"message", "id":"answer2", "parentId":"two", "message":{"role":"assistant", "content":[]}}),
        serde_json::json!({"type":"message", "id":"three", "parentId":"answer2", "message":{"role":"user", "content":"third", "timestamp":third.execution.started_at}}),
    ];
    fs::write(&file, entries.iter().map(|e| format!("{e}\n")).collect::<String>()).unwrap();
    let before = fs::read(&file).unwrap();
    assert!(runtime.edit_node_message("task", &second.execution.id, "wrong", "edited", None).is_err());
    assert_eq!(fs::read(&file).unwrap(), before);
    runtime.edit_node_message("task", &second.execution.id, "second", "edited second", None).unwrap();
    let replayed = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(replayed.superseded_execution_ids.len(), 2);
    assert_eq!(replayed.nodes["task"].edit_execution_id.as_deref(), Some(second.execution.id.as_str()));
    let marker: serde_json::Value = serde_json::from_str(fs::read_to_string(&file).unwrap().lines().last().unwrap()).unwrap();
    assert_eq!(marker["parentId"], "answer1");
    let edited = runtime.jobs().unwrap().remove(0);
    assert_eq!(edited.task, "edited second");
    assert_eq!(edited.execution.session_id, first.execution.session_id);
    assert_eq!(edited.resume_execution_id.as_deref(), Some(first.execution.id.as_str()));
    assert_eq!(edited.execution.before, second.execution.before);
    assert!(!runtime.state.superseded_execution_ids.contains(&edited.execution.id));
}

#[test]
fn editing_a_running_node_stops_its_execution_and_branches_from_the_start() {
    let (_temp, source, mut runtime) = setup(true, single());
    runtime.set_route("serial").unwrap();
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: first.execution.id.clone(), head: runtime.state.base.clone(), output: "first".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    runtime.intervene("task", "second").unwrap();
    let second = runtime.jobs().unwrap().remove(0);
    // The follow-up execution is still running when the opening prompt is edited.
    let session_dir = runtime.root.join("sessions").join(&first.execution.id);
    fs::create_dir_all(&session_dir).unwrap();
    let file = session_dir.join(format!("test_{}.jsonl", first.execution.session_id));
    let entries = [
        serde_json::json!({"type":"session", "id":first.execution.session_id, "cwd":source}),
        serde_json::json!({"type":"message", "id":"root", "parentId":null, "message":{"role":"system", "content":"system"}}),
        serde_json::json!({"type":"message", "id":"one", "parentId":"root", "message":{"role":"user", "content":"self-contained task", "timestamp":first.execution.started_at}}),
        serde_json::json!({"type":"message", "id":"answer1", "parentId":"one", "message":{"role":"assistant", "content":[]}}),
        serde_json::json!({"type":"message", "id":"two", "parentId":"answer1", "message":{"role":"user", "content":"second", "timestamp":second.execution.started_at}}),
    ];
    fs::write(&file, entries.iter().map(|e| format!("{e}\n")).collect::<String>()).unwrap();
    runtime.edit_node_message("task", &first.execution.id, "self-contained task", "new goal", None).unwrap();
    // The live execution is stopped (recorded request) and superseded, and the
    // node waits to rerun from the branched opening turn.
    assert!(runtime.state.execution_stop_requests.contains(&second.execution.id));
    assert!(runtime.state.superseded_execution_ids.contains(&second.execution.id));
    assert_eq!(runtime.state.nodes["task"].status, "dirty");
    assert_eq!(runtime.state.graph.nodes[0].task, "new goal");
    let marker: serde_json::Value = serde_json::from_str(fs::read_to_string(&file).unwrap().lines().last().unwrap()).unwrap();
    assert_eq!(marker["parentId"], "root");
    // The stopped writer's observed failure must not flip the node back to failed.
    runtime.emit(EventKind::Failed {
        node: "task".into(), execution_id: Some(second.execution.id.clone()), error: "killed".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    assert_eq!(runtime.state.nodes["task"].status, "dirty");
    let edited = runtime.jobs().unwrap().remove(0);
    assert_eq!(edited.task, "new goal");
    assert_eq!(edited.execution.session_id, first.execution.session_id);
    assert_eq!(edited.resume_execution_id.as_deref(), Some(first.execution.id.as_str()));
    assert!(!runtime.state.superseded_execution_ids.contains(&edited.execution.id));
}

#[test]
fn interrupted_nodes_and_blocked_descendants_resume_from_the_topology_control() {
    let graph = Graph {
        original_goal: "interrupted graph".into(),
        nodes: vec![
            Node { name: "first".into(), task: "first".into() },
            Node { name: "second".into(), task: "second".into() },
            Node { name: "after".into(), task: "after".into() },
        ],
        edges: vec![
            Edge { from: "first".into(), to: "after".into(), feedback: false },
            Edge { from: "second".into(), to: "after".into(), feedback: false },
        ],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    assert_eq!(jobs.len(), 2);
    let interrupted = jobs.iter().find(|job| job.execution.node == "first").unwrap().execution.clone();
    let completed = jobs.iter().find(|job| job.execution.node == "second").unwrap().execution.clone();

    runtime.finish(&interrupted, Err("Pi exited with exit code: 0xc000013a".into())).unwrap();
    runtime.finish(&completed, Ok((runtime.state.base.clone(), "completed".into()))).unwrap();
    runtime.jobs().unwrap(); // The failed root blocks its dependent and settles the Run.
    assert_eq!(runtime.state.phase, "needs_attention");
    assert_eq!(runtime.state.nodes["first"].status, "failed");
    assert_eq!(runtime.state.nodes["after"].status, "blocked");
    assert!(runtime.state.can_resume_interrupted());
    assert_eq!(crate::snapshot_view::snapshot_metadata(&runtime.state).unwrap()["canResume"], true);

    runtime.pause(true).unwrap();
    runtime.pause(false).unwrap();
    assert_eq!(runtime.state.phase, "running");
    assert_eq!(runtime.state.nodes["first"].status, "waiting");
    assert_eq!(runtime.state.nodes["after"].status, "waiting");
    assert!(runtime.state.events.iter().any(|event| matches!(
        event.kind,
        EventKind::RecoveryQueued { ref nodes, .. } if nodes.iter().any(|node| node == "first") && nodes.iter().any(|node| node == "after")
    )));

    let resumed = runtime.jobs().unwrap();
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].execution.node, "first");
    assert!(resumed[0].continuation);
    assert!(resumed[0].task.is_empty());
    assert_eq!(resumed[0].resume_execution_id.as_deref(), Some(interrupted.id.as_str()));
    assert_eq!(resumed[0].execution.session_id, interrupted.session_id);
    assert_ne!(resumed[0].execution.id, interrupted.id);
}

#[test]
fn starting_an_upstream_node_returns_its_blocked_descendants_to_waiting() {
    let graph = Graph {
        original_goal: "recover blocked descendants".into(),
        nodes: ["first", "after", "last", "second", "other"].into_iter()
            .map(|name| Node { name: name.into(), task: name.into() })
            .collect(),
        edges: vec![
            Edge { from: "first".into(), to: "after".into(), feedback: false },
            Edge { from: "after".into(), to: "last".into(), feedback: false },
            Edge { from: "second".into(), to: "other".into(), feedback: false },
        ],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    assert_eq!(jobs.len(), 2);
    let first = jobs.iter().find(|job| job.execution.node == "first").unwrap().execution.clone();
    let second = jobs.iter().find(|job| job.execution.node == "second").unwrap().execution.clone();
    runtime.finish(&first, Err("boom".into())).unwrap();
    runtime.finish(&second, Err("boom".into())).unwrap();
    runtime.jobs().unwrap(); // Both failed roots block their branches.
    for name in ["after", "last", "other"] {
        assert_eq!(runtime.state.nodes[name].status, "blocked");
        assert!(runtime.state.nodes[name].error.is_some());
    }

    // Retrying one root clears only its own blocked dependency branch, and the
    // scheduler waits for the new result instead of the failed one.
    runtime.intervene("first", "retry the first root").unwrap();
    let retried = runtime.jobs().unwrap().remove(0);
    assert_eq!(retried.execution.node, "first");
    for name in ["after", "last"] {
        assert_eq!(runtime.state.nodes[name].status, "waiting");
        assert!(runtime.state.nodes[name].error.is_none());
    }
    assert_eq!(runtime.state.nodes["other"].status, "blocked");
    assert!(runtime.state.nodes["other"].error.is_some());
}

#[test]
fn manual_node_pause_is_replayable_and_does_not_disguise_an_unrelated_failure() {
    let graph = Graph {
        original_goal: "pause one branch".into(),
        nodes: ["left", "right"].into_iter().map(|name| Node {
            name: name.into(), task: name.into(),
        }).collect(),
        edges: vec![],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    let left = &jobs.iter().find(|job| job.execution.node == "left").unwrap().execution;
    let right = &jobs.iter().find(|job| job.execution.node == "right").unwrap().execution;
    runtime.emit_outputs(vec![EventKind::Output {
        execution_id: left.id.clone(),
        text: "{\"type\":\"grapher_process_started\",\"pid\":1234}\n".into(),
    }]).unwrap();
    let stopped = runtime.request_execution_stop(Some("left")).unwrap();
    assert_eq!(stopped.len(), 1);
    assert!(!runtime.state.paused, "node stop must not pause unrelated branches");
    assert!(runtime.pause(false).is_err(), "do not resume before the writer drains");
    runtime.finish(left, Err("Pi exited with exit code: 1".into())).unwrap();
    runtime.finish(right, Err("Pi exited with exit code: 1".into())).unwrap();
    runtime.jobs().unwrap();
    assert!(runtime.state.can_resume());
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    for state in [&runtime.state, &replay] {
        let view = crate::snapshot_view::snapshot_metadata(state).unwrap();
        assert_eq!(view["nodes"]["left"]["status"], "paused");
        assert_eq!(view["nodes"]["right"]["status"], "failed");
        assert_eq!(view["executions"][0]["status"], "paused");
        assert_eq!(view["executions"][1]["status"], "failed");
        assert!(!view["nodes"]["left"]["error"].as_str().unwrap().contains("exit code"));
        assert_eq!(view["canResume"], true);
    }
    let checkpoint: Snapshot = serde_json::from_value(
        crate::snapshot_view::checkpoint_projection(&runtime.state),
    ).unwrap();
    assert_eq!(checkpoint.execution_stop_requests, vec![left.id.clone()]);
    assert_eq!(crate::snapshot_view::snapshot_metadata(&checkpoint).unwrap()["executions"][0]["status"], "paused");
    runtime.pause(false).unwrap();
    let resumed = runtime.jobs().unwrap();
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].execution.node, "left");
    assert!(resumed[0].continuation);
    assert_eq!(resumed[0].execution.session_id, left.session_id);
    assert_eq!(resumed[0].execution.worktree, left.worktree);
    assert_eq!(resumed[0].resume_execution_id.as_deref(), Some(left.id.as_str()));
    assert_eq!(runtime.state.nodes["right"].status, "failed");
}

#[test]
fn explicit_pause_wins_a_completion_race_without_publishing_a_result() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    runtime.pause(true).unwrap();
    runtime.request_execution_stop(None).unwrap();
    runtime.finish(&job.execution, Ok((runtime.state.base.clone(), "racing success".into()))).unwrap();
    assert_eq!(runtime.state.phase, "paused");
    assert!(runtime.state.nodes["task"].head.is_none());
    assert!(runtime.state.executions[0].after.is_none());
    assert!(runtime.state.publication.is_none());
    assert_eq!(crate::snapshot_view::snapshot_metadata(&runtime.state).unwrap()["nodes"]["task"]["status"], "paused");
    runtime.pause(false).unwrap();
    assert_eq!(runtime.jobs().unwrap().len(), 1);
}

#[test]
fn scheduling_only_pause_does_not_reclassify_provider_failure() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    runtime.pause(true).unwrap(); // Planner's temporary drain is not a user stop.
    runtime.finish(&job.execution, Err("Pi exited with exit code: 1".into())).unwrap();
    let view = crate::snapshot_view::snapshot_metadata(&runtime.state).unwrap();
    assert_eq!(view["nodes"]["task"]["status"], "failed");
    assert_eq!(view["executions"][0]["status"], "failed");
    assert!(!runtime.state.can_resume());
}

#[test]
fn only_an_explicit_stop_hides_pis_forced_exit_code() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.set_route("serial").unwrap();
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    runtime.pause(true).unwrap();
    runtime.emit(EventKind::StopRequested).unwrap();
    runtime.finish(&job.execution, Err("Pi exited with exit code: 1: ".into())).unwrap();
    assert!(!runtime.state.nodes["task"].error.as_deref().unwrap().contains("exit code"));
    runtime.pause(false).unwrap();
    assert!(!runtime.state.stop_requested);
}

#[test]
fn editing_serial_initial_turn_updates_goal_without_replacing_the_run() {
    let (_temp, source, mut runtime) = setup(true, single());
    runtime.set_route("serial").unwrap();
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: first.execution.id.clone(), head: runtime.state.base.clone(), output: "completed".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    let session_dir = runtime.root.join("sessions").join(&first.execution.id);
    fs::create_dir_all(&session_dir).unwrap();
    let file = session_dir.join(format!("test_{}.jsonl", first.execution.session_id));
    fs::write(&file, [
        serde_json::json!({"type":"session", "id":first.execution.session_id, "cwd":source}),
        serde_json::json!({"type":"message", "id":"root", "parentId":null, "message":{"role":"system", "content":"system"}}),
        serde_json::json!({"type":"message", "id":"first", "parentId":"root", "message":{"role":"user", "content":"self-contained task", "timestamp":first.execution.started_at}}),
    ].iter().map(|e| format!("{e}\n")).collect::<String>()).unwrap();
    let run_id = runtime.state.run_id.clone();
    runtime.edit_node_message("task", &first.execution.id, "self-contained task", "new goal", None).unwrap();
    assert_eq!(runtime.state.run_id, run_id);
    assert_eq!(runtime.state.graph.original_goal, "new goal");
    assert_eq!(runtime.state.graph.nodes[0].task, "new goal");
    let next = runtime.jobs().unwrap().remove(0);
    assert_eq!(next.task, "new goal");
    assert_eq!(next.execution.session_id, first.execution.session_id);
}

#[test]
fn editing_graph_node_uses_earlier_checkpoint_and_propagates_change() {
    let graph = Graph {
        original_goal: "graph".into(),
        nodes: ["parent", "child"].into_iter().map(|name| Node {
            name: name.into(), task: name.into(),
        }).collect(),
        edges: vec![Edge { from: "parent".into(), to: "child".into(), feedback: false }],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    // This reducer-focused test synthesizes Finished, so record the filesystem
    // checkpoint that a real perform would create before opening the session.
    workspace::prepare(&_source, Path::new(&first.execution.worktree), &first.execution.before, &[]).unwrap();
    runtime.emit(EventKind::Finished {
        execution_id: first.execution.id.clone(), head: runtime.state.base.clone(), output: "first".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    let child = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: child.execution.id.clone(), head: runtime.state.base.clone(), output: "child".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    runtime.intervene("parent", "later").unwrap();
    let later = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: later.execution.id.clone(), head: runtime.state.base.clone(), output: "later".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    // The follow-up returned the same result, so the descendant stays valid.
    assert_eq!(runtime.state.nodes["child"].status, "completed");
    let session_dir = runtime.root.join("sessions").join(&first.execution.id);
    fs::create_dir_all(&session_dir).unwrap();
    fs::create_dir_all(&first.execution.worktree).unwrap();
    let file = session_dir.join(format!("test_{}.jsonl", first.execution.session_id));
    fs::write(&file, [
        serde_json::json!({"type":"session", "id":first.execution.session_id, "cwd":first.execution.worktree}),
        serde_json::json!({"type":"message", "id":"start", "parentId":null, "message":{"role":"user", "content":"parent", "timestamp":first.execution.started_at}}),
        serde_json::json!({"type":"message", "id":"answer", "parentId":"start", "message":{"role":"assistant", "content":[]}}),
        serde_json::json!({"type":"message", "id":"next", "parentId":"answer", "message":{"role":"user", "content":"later", "timestamp":later.execution.started_at}}),
    ].iter().map(|e| format!("{e}\n")).collect::<String>()).unwrap();
    runtime.edit_node_message("parent", &first.execution.id, "parent", "edited parent", None).unwrap();
    assert_eq!(runtime.state.graph.nodes[0].task, "edited parent");
    assert_eq!(runtime.state.nodes["parent"].head.as_deref(), Some(first.execution.before.as_str()));
    // The edited run has not finished, so the descendant is still valid.
    assert_eq!(runtime.state.nodes["child"].status, "completed");
    assert!(runtime.state.superseded_execution_ids.contains(&first.execution.id));
    assert!(!runtime.state.superseded_execution_ids.contains(&child.execution.id));
    assert!(runtime.state.superseded_execution_ids.contains(&later.execution.id));
    let new_job = runtime.jobs().unwrap().remove(0);
    assert_eq!(new_job.execution.worktree, first.execution.worktree);
    assert_eq!(new_job.execution.before, first.execution.before);
    assert_eq!(new_job.task, "edited parent");
    // The edited run changed the result, so the descendant recomputes.
    runtime.emit(EventKind::Finished {
        execution_id: new_job.execution.id.clone(), head: "changed-parent".into(), output: "edited".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    assert_eq!(runtime.state.nodes["parent"].head.as_deref(), Some("changed-parent"));
    assert_eq!(runtime.state.nodes["child"].status, "dirty");
}

#[cfg(feature = "fixture")]
#[test]
fn dependency_chain_hands_off_one_workspace_and_earlier_node_messages_use_the_terminal_tree() {
    let graph = Graph {
        original_goal: "chain".into(),
        nodes: ["a", "b", "c"].into_iter().map(|name| Node {
            name: name.into(), task: name.into(),
        }).collect(),
        edges: [("a", "b"), ("b", "c")].into_iter().map(|(from, to)| Edge {
            from: from.into(), to: to.into(), feedback: false,
        }).collect(),
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    let script = _temp.path().join("chain-agent.sh");
    fs::write(&script, r#"task=$(cat)
echo "$GRAPHER_NODE_NAME" > "$GRAPHER_NODE_NAME.txt"
if printf '%s' "$task" | grep -q 'add a final adjustment'; then echo 'shared final tree' > from-a-followup.txt; fi
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Completed"}]}}'
"#).unwrap();
    let config = runtime.state.config.as_mut().unwrap();
    config.engine = "pi".into();
    config.pi_command = "/bin/sh".into();
    config.pi_args = vec![script.to_string_lossy().into()];
    runtime.approve().unwrap();
    let mut shared_path = None;
    let mut terminal_head = None;
    for name in ["a", "b", "c"] {
        let job = runtime.jobs().unwrap().remove(0);
        assert_eq!(job.execution.node, name);
        if let Some(path) = &shared_path {
            assert_eq!(&job.execution.worktree, path, "a dependency must take over its parent's directory");
            assert!(job.inherit_workspace);
        }
        let root_dir = runtime.root.clone();
        let result = perform(&job, &root_dir, &[], |_| {}, |head| runtime.emit(EventKind::Prepared {
            execution_id: job.execution.id.clone(), head,
        }));
        let head = result.as_ref().unwrap().0.clone();
        runtime.finish(&job.execution, result).unwrap();
        shared_path = Some(job.execution.worktree.clone());
        terminal_head = Some(head);
    }
    let path = PathBuf::from(shared_path.unwrap());
    assert!(path.join("a.txt").exists() && path.join("b.txt").exists() && path.join("c.txt").exists());
    let root = runtime.run_workspace_root();
    let worktree_count = fs::read_dir(root).unwrap().filter_map(Result::ok)
        .filter(|entry| entry.file_name() != ".files" && entry.file_type().unwrap().is_dir()).count();
    assert_eq!(worktree_count, 1, "linear dependencies should retain exactly one physical worktree");

    let old_session = runtime.latest_node_execution("a").unwrap().session_id.clone();
    runtime.intervene("a", "add a final adjustment").unwrap();
    let reply = runtime.jobs().unwrap().remove(0);
    assert_eq!(reply.execution.node, "a");
    assert_eq!(reply.execution.worktree, path.to_string_lossy());
    assert_eq!(reply.execution.before, terminal_head.unwrap());
    assert_eq!(reply.execution.session_id, old_session);
    assert!(reply.inherit_workspace);
    let root_dir = runtime.root.clone();
    let result = perform(&reply, &root_dir, &[], |_| {}, |head| runtime.emit(EventKind::Prepared {
        execution_id: reply.execution.id.clone(), head,
    }));
    let new_head = result.as_ref().unwrap().0.clone();
    runtime.finish(&reply.execution, result).unwrap();
    for name in ["a", "b", "c"] {
        assert_eq!(runtime.state.nodes[name].status, "completed");
        assert_eq!(runtime.state.nodes[name].head.as_deref(), Some(new_head.as_str()));
    }
    assert!(runtime.jobs().unwrap().is_empty(), "editing a node in the terminal workspace must not rerun descendants");
    assert!(path.join("from-a-followup.txt").exists());
}

#[test]
fn fanout_allocates_one_workspace_per_parallel_branch_and_fanin_reclaims_extras() {
    let graph = Graph {
        original_goal: "fanout".into(),
        nodes: ["root", "left", "right", "join"].into_iter().map(|name| Node {
            name: name.into(), task: name.into(),
        }).collect(),
        edges: [("root", "left"), ("root", "right"), ("left", "join"), ("right", "join")]
            .into_iter().map(|(from, to)| Edge {
                from: from.into(), to: to.into(), feedback: false,
            }).collect(),
    };
    let (_temp, source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let root_job = runtime.jobs().unwrap().remove(0);
    let root_path = PathBuf::from(&root_job.execution.worktree);
    workspace::prepare(&source, &root_path, &root_job.execution.before, &[]).unwrap();
    fs::write(root_path.join("root.txt"), "root").unwrap();
    let root_head = workspace::snapshot_node_for_run(&root_path, &source, "root", Some(&runtime.state.run_id)).unwrap();
    runtime.finish(&root_job.execution, Ok((root_head, "completed".into()))).unwrap();

    let branches = runtime.jobs().unwrap();
    assert_eq!(branches.len(), 2);
    assert_ne!(branches[0].execution.worktree, branches[1].execution.worktree);
    assert!(branches.iter().any(|job| Path::new(&job.execution.worktree) == root_path));
    let mut branch_count = 0;
    for job in &branches {
        let path = Path::new(&job.execution.worktree);
        workspace::prepare(&source, path, &job.execution.before, &job.parent_heads).unwrap();
        fs::write(path.join(format!("{}.txt", job.execution.node)), &job.execution.node).unwrap();
        let head = workspace::snapshot_node_for_run(path, &source, &job.execution.node, Some(&runtime.state.run_id)).unwrap();
        branch_count += 1;
        runtime.finish(&job.execution, Ok((head, "completed".into()))).unwrap();
    }
    let join = runtime.jobs().unwrap().remove(0);
    assert_eq!(join.execution.node, "join");
    let path = Path::new(&join.execution.worktree);
    workspace::prepare(&source, path, &join.execution.before, &join.parent_heads).unwrap();
    for name in ["root", "left", "right"] {
        assert!(path.join(format!("{name}.txt")).exists());
    }
    fs::write(path.join("join.txt"), "joined").unwrap();
    let head = workspace::snapshot_node_for_run(path, &source, "join", Some(&runtime.state.run_id)).unwrap();
    runtime.finish(&join.execution, Ok((head, "completed".into()))).unwrap();
    let worktree_count = fs::read_dir(runtime.run_workspace_root()).unwrap().filter_map(Result::ok)
        .filter(|entry| entry.file_name() != ".files" && entry.file_type().unwrap().is_dir()).count();
    assert_eq!(worktree_count, 1, "after fan-in only its final workspace remains");
    assert_eq!(runtime.state.nodes["left"].head, runtime.state.nodes["join"].head);
    assert_eq!(runtime.state.nodes["right"].head, runtime.state.nodes["join"].head);
    assert_eq!(branch_count, 2);
}

#[test]
fn graph_followup_on_terminal_workspace_updates_without_rerunning_descendants() {
    let graph = Graph {
        original_goal: "graph".into(),
        nodes: ["parent", "child", "independent"].into_iter().map(|name| Node {
            name: name.into(), task: name.into(),
        }).collect(),
        edges: vec![Edge { from: "parent".into(), to: "child".into(), feedback: false }],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap();
    for job in &first {
        runtime.emit(EventKind::Finished {
            execution_id: job.execution.id.clone(), head: runtime.state.base.clone(), output: "completed".into(), output_bytes: 0, metrics: None,
        }).unwrap();
    }
    let child = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: child.execution.id, head: runtime.state.base.clone(), output: "completed".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    runtime.intervene("parent", "continue parent").unwrap();
    assert_eq!(runtime.state.nodes["parent"].status, "dirty");
    // Unchanged until the follow-up actually produces a new result.
    assert_eq!(runtime.state.nodes["child"].status, "completed");
    assert_eq!(runtime.state.nodes["independent"].status, "completed");
    let next = runtime.jobs().unwrap().remove(0);
    assert_eq!(next.execution.node, "parent");
    assert_eq!(next.task, "continue parent");
    assert!(next.resume_execution_id.is_some());
    runtime.emit(EventKind::Finished {
        execution_id: next.execution.id.clone(), head: "changed-parent".into(), output: "completed".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    assert_eq!(runtime.state.nodes["parent"].status, "completed");
    assert_eq!(runtime.state.nodes["child"].status, "completed");
    assert_eq!(runtime.state.nodes["child"].head.as_deref(), Some("changed-parent"));
    assert_eq!(runtime.state.nodes["independent"].status, "completed");
    assert!(runtime.jobs().unwrap().is_empty(), "the terminal descendant is not rerun after a shared-workspace reply");
}

#[test]
fn resolved_preparation_is_not_a_completed_node_execution() {
    let (_temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    let path = Path::new(&first.execution.worktree);
    workspace::prepare(&source, path, &first.execution.before, &[]).unwrap();
    fs::write(path.join("tracked.txt"), "human merged inputs").unwrap();
    workspace::snapshot_repository(path).unwrap();
    runtime.emit(EventKind::Failed {
        node: "task".into(), execution_id: Some(first.execution.id.clone()),
        error: "Workspace composition blocked".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    runtime.emit(EventKind::Blocked { node: "task".into(), error: "Resolve".into() }).unwrap();
    runtime.resolved("task").unwrap();
    assert_eq!(runtime.state.executions[0].status, "resolved");
    assert_eq!(runtime.state.executions[0].after, None);
    assert_eq!(runtime.state.nodes["task"].status, "dirty");
    // Resolving workspace preparation does not create a Pi conversation.
    assert!(runtime.intervene("task", "continue").is_err());
    let head = runtime.state.nodes["task"].head.clone().unwrap();
    let replayed = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(replayed.executions[0].status, "resolved");
    assert_eq!(replayed.nodes["task"].status, "dirty");
    assert_eq!(runtime.jobs().unwrap().remove(0).execution.before, head);
}

#[test]
fn planner_revision_refreshes_future_node_inputs_without_replacing_running_workspaces() {
    for standard_git in [true, false] {
        let graph = Graph {
            original_goal: "test".into(),
            nodes: ["parent", "running", "child"].into_iter()
                .map(|name| Node { name: name.into(), task: name.into() }).collect(),
            edges: vec![Edge { from: "parent".into(), to: "child".into(), feedback: false }],
        };
        let (_temp, source, mut runtime) = setup(standard_git, graph.clone());
        let mut config = runtime.state.config.clone().unwrap();
        config.max_parallel = 3;
        runtime.edit_draft_graph(graph.clone(), config).unwrap();
        runtime.approve().unwrap();
        let approval = runtime.state.base.clone();
        let mut roots = runtime.jobs().unwrap();
        for job in roots.iter_mut() {
            attach(&mut runtime, job);
        }
        let parent = roots.iter().find(|job| job.execution.node == "parent").unwrap();
        let running = roots.iter().find(|job| job.execution.node == "running").unwrap();
        let parent_path = Path::new(&parent.execution.worktree);
        workspace::prepare(&source, parent_path, &parent.execution.before, &[]).unwrap();
        fs::write(parent_path.join("parent.txt"), "parent result").unwrap();
        let head = workspace::snapshot_node_for_run(parent_path, &source, "parent", Some(&runtime.state.run_id)).unwrap();
        runtime.finish(&parent.execution, Ok((head, "completed".into()))).unwrap();
        let running_path = Path::new(&running.execution.worktree);
        workspace::prepare(&source, running_path, &running.execution.before, &[]).unwrap();
        fs::write(running_path.join("in-flight.txt"), "do not overwrite").unwrap();

        // Planner's next turn writes directly into the source after approval.
        fs::write(source.join("tracked.txt"), "latest planner content").unwrap();
        fs::write(source.join("planner.txt"), "new source file").unwrap();
        fs::remove_file(source.join("deleted.txt")).unwrap();
        let mut revised = graph;
        revised.nodes.push(Node { name: "added".into(), task: "new task".into() });
        runtime.revise_graph(revised, PlanningSummary { planning_id: "revision".into(), ..Default::default() }).unwrap();
        let source_head = runtime.latest_source_head().to_owned();
        assert_ne!(source_head, approval);
        assert_eq!(runtime.state.base, approval, "approval history stays immutable");
        assert_eq!(runtime.state.nodes["running"].status, "running");
        assert_eq!(fs::read_to_string(running_path.join("tracked.txt")).unwrap(), "original");
        assert_eq!(fs::read_to_string(running_path.join("in-flight.txt")).unwrap(), "do not overwrite");

        let run_id = runtime.state.run_id.clone();
        runtime.state = runtime.store.load(&run_id).unwrap(); // Replay without interrupting the running node.
        assert_eq!(runtime.latest_source_head(), source_head);
        let jobs = runtime.jobs().unwrap();
        assert_eq!(jobs.len(), 2);
        for job in jobs {
            assert_eq!(job.execution.before, source_head);
            assert_eq!(job.expected_source_head, source_head);
            let path = Path::new(&job.execution.worktree);
            workspace::prepare_with_merger_expected_for_run(&source, path, &job.execution.before,
                &job.parent_heads, &job.expected_source_head, Some(&run_id), || Err("unexpected conflict".into())).unwrap();
            assert_eq!(fs::read_to_string(path.join("tracked.txt")).unwrap(), "latest planner content");
            assert_eq!(fs::read_to_string(path.join("planner.txt")).unwrap(), "new source file");
            assert!(!path.join("deleted.txt").exists());
            if job.execution.node == "child" {
                assert_eq!(fs::read_to_string(path.join("parent.txt")).unwrap(), "parent result");
            } else {
                assert_eq!(job.execution.node, "added");
                assert!(!path.join("parent.txt").exists(), "unrelated node results must not leak");
            }
        }
        if !standard_git { fs::remove_dir_all(workspace::shadow_repo_dir(&source).unwrap()).unwrap(); }
    }
}

#[cfg(feature = "fixture")]
#[test]
fn retained_node_result_is_composed_with_subsequent_planner_source_writes() {
    for standard_git in [true, false] {
        let (temp, source, mut runtime) = setup(standard_git, single());
        runtime.approve().unwrap();
        let first = runtime.jobs().unwrap().remove(0);
        let mut first = first;
        attach(&mut runtime, &mut first);
        let path = Path::new(&first.execution.worktree);
        workspace::prepare(&source, path, &first.execution.before, &[]).unwrap();
        fs::write(path.join("node.txt"), "retained node result").unwrap();
        let node_head = workspace::snapshot_node_for_run(path, &source, "task", Some(&runtime.state.run_id)).unwrap();
        runtime.finish(&first.execution, Ok((node_head.clone(), "completed".into()))).unwrap();
        fs::write(source.join("planner.txt"), "latest source").unwrap();
        runtime.revise_graph(single(), PlanningSummary { planning_id: "revision".into(), ..Default::default() }).unwrap();
        runtime.intervene("task", "continue").unwrap();
        let mut job = runtime.jobs().unwrap().remove(0);
        attach(&mut runtime, &mut job);
        assert_eq!(job.execution.before, node_head);
        assert_ne!(job.expected_source_head, node_head);
        let script = temp.path().join("node.sh");
        fs::write(&script, "cat >/dev/null\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
        job.config.pi_command = "/bin/sh".into();
        job.config.pi_args = vec![script.to_string_lossy().into()];
        perform(&job, &runtime.root, &[], |_| {}, |_| Ok(())).unwrap();
        assert_eq!(fs::read_to_string(path.join("node.txt")).unwrap(), "retained node result");
        assert_eq!(fs::read_to_string(path.join("planner.txt")).unwrap(), "latest source");
        if !standard_git { fs::remove_dir_all(workspace::shadow_repo_dir(&source).unwrap()).unwrap(); }
    }
}

#[test]
fn new_runs_force_collect_gitignored_project_files_without_creating_run_file_snapshots() {
    let (_temp, source, mut runtime) = setup(true, single());
    fs::write(source.join(".gitignore"), ".cache/\n").unwrap();
    fs::create_dir(source.join(".cache")).unwrap();
    fs::write(source.join(".cache/package"), "ordinary bytes").unwrap();
    runtime.approve().unwrap();

    let run_root = runtime.run_workspace_root();
    assert!(!run_root.join(".files").exists());
    assert!(!runtime.state.events.iter().any(|event| matches!(
        event.kind,
        EventKind::SourceFilesRecorded { .. } | EventKind::WorkspaceFilesChanged { .. }
    )));
    let job = runtime.jobs().unwrap().remove(0);
    let workspace_path = Path::new(&job.execution.worktree);
    workspace::prepare(&source, workspace_path, &job.execution.before, &[]).unwrap();
    workspace::copy_ordinary_files(&source, workspace_path, &[], &runtime.root).unwrap();
    assert_eq!(fs::read_to_string(workspace_path.join(".cache/package")).unwrap(), "ordinary bytes");
    assert!(workspace::git(workspace_path, &["ls-files"]).unwrap().contains(".cache/package"));
    assert!(!run_root.join(".files").exists());
    let serialized = serde_json::to_value(&runtime.state).unwrap();
    assert!(serialized.get("sourceFiles").is_none());
}

#[test]
fn legacy_run_file_channel_records_are_read_only_and_deserialize_without_reemitting_fields() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    runtime.emit(EventKind::SourceFilesRecorded {
        files: SourceFiles {
            head: runtime.state.base.clone(),
            version: Uuid::new_v4().to_string(),
        },
    }).unwrap();
    let error = match runtime.jobs() {
        Ok(_) => panic!("legacy file-channel Run must not schedule"),
        Err(error) => error,
    };
    assert!(error.contains("legacy ignored-file snapshots"));

    let mut legacy_json = serde_json::to_value(NodeState::default()).unwrap();
    legacy_json["filesOverride"] = serde_json::json!("old-override");
    legacy_json["filesVersion"] = serde_json::json!("old-version");
    legacy_json["baselineFilesVersion"] = serde_json::json!("old-baseline");
    legacy_json["filesChanged"] = serde_json::json!(true);
    let legacy: NodeState = serde_json::from_value(legacy_json).unwrap();
    let encoded = serde_json::to_value(legacy).unwrap();
    for key in ["filesOverride", "filesVersion", "baselineFilesVersion", "filesChanged"] {
        assert!(encoded.get(key).is_none());
    }
}

#[test]
fn approval_captures_planner_files_before_allocating_graph_workspaces() {
    for standard_git in [true, false] {
        let (temp, source, mut runtime) = setup(standard_git, single());
        let old_head = workspace::verify(&source).unwrap();
        assert!(runtime.jobs().unwrap().is_empty());
        assert!(!temp.path().join(".grapher-worktrees").exists());
        // Both staged and unstaged planner changes, new files, and deletions.
        fs::write(source.join("tracked.txt"), "staged").unwrap();
        workspace::repository_git(&source, &["add", "tracked.txt"]).unwrap();
        fs::write(source.join("tracked.txt"), "final planner content").unwrap();
        fs::write(source.join("new.txt"), "created by planner").unwrap();
        fs::remove_file(source.join("deleted.txt")).unwrap();
        runtime.approve().unwrap();
        assert_ne!(runtime.state.base, old_head);
        let mut job = runtime.jobs().unwrap().remove(0);
        attach(&mut runtime, &mut job);
        let node = Path::new(&job.execution.worktree);
        assert_ne!(node, source);
        assert!(!node.exists());
        workspace::prepare(&source, node, &job.execution.before, &[]).unwrap();
        assert_eq!(
            fs::read_to_string(node.join("tracked.txt")).unwrap(),
            "final planner content"
        );
        assert_eq!(
            fs::read_to_string(node.join("new.txt")).unwrap(),
            "created by planner"
        );
        assert!(!node.join("deleted.txt").exists());
        assert!(
            workspace::repository_git(&source, &["status", "--porcelain"])
                .unwrap()
                .is_empty()
        );
        // A planner-authored single 'task' stays a graph after event replay.
        let id = runtime.state.run_id.clone();
        let replay = runtime.store.load(&id).unwrap();
        assert_eq!(replay.plan_type.as_deref(), Some("graph"));
        assert_eq!(
            crate::snapshot_view::snapshot_metadata(&replay).unwrap()["planType"],
            "graph"
        );
        if !standard_git {
            fs::remove_dir_all(workspace::shadow_repo_dir(&source).unwrap()).unwrap();
        }
    }
}

#[test]
fn planner_revision_keeps_approval_and_unaffected_node_results() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: ["keep", "change", "child"]
            .into_iter()
            .map(|name| Node {
                name: name.into(),
                task: name.into(),
            })
            .collect(),
        edges: vec![Edge {
            from: "change".into(),
            to: "child".into(),
            feedback: false,
        }],
    };
    let (_temp, source, mut runtime) = setup(true, graph.clone());
    runtime.approve().unwrap();
    let run_id = runtime.state.run_id.clone();
    let base = runtime.state.base.clone();
    let roots = runtime.jobs().unwrap();
    assert_eq!(roots.len(), 2);
    for job in roots {
        let name = &job.execution.node;
        let path = Path::new(&job.execution.worktree);
        workspace::prepare(&source, path, &job.execution.before, &runtime.parents(name)).unwrap();
        fs::write(path.join(format!("{name}.txt")), name).unwrap();
        let head = workspace::snapshot_node(path, &source, name).unwrap();
        runtime
            .finish(&job.execution, Ok((head, "completed".into())))
            .unwrap();
    }
    // Both roots finished while child has not started.
    let keep_head = runtime.state.nodes["keep"].head.clone();
    let mut revised = graph;
    revised
        .nodes
        .iter_mut()
        .find(|node| node.name == "change")
        .unwrap()
        .task = "new task".into();
    revised.nodes.push(Node {
        name: "added".into(),
        task: "new node".into(),
    });
    let planning = PlanningSummary {
        planning_id: "revision-1".into(),
        ..Default::default()
    };
    runtime.revise_graph(revised, planning).unwrap();
    assert_eq!(runtime.state.run_id, run_id);
    assert_eq!(runtime.state.base, base);
    assert!(runtime.state.approved);
    assert_eq!(runtime.state.nodes["keep"].status, "completed");
    assert_eq!(runtime.state.nodes["keep"].head, keep_head);
    assert_eq!(runtime.state.nodes["change"].status, "dirty");
    assert_eq!(runtime.state.nodes["child"].status, "waiting");
    assert_eq!(runtime.state.nodes["added"].status, "waiting");
    let replay = runtime.store.load(&run_id).unwrap();
    assert_eq!(replay.nodes["keep"].head, keep_head);
    assert_eq!(replay.nodes["child"].status, "waiting");
    assert_eq!(replay.planning_id.as_deref(), Some("revision-1"));
    let jobs = runtime.jobs().unwrap();
    assert!(jobs
        .iter()
        .all(|job| job.execution.node != "keep" && job.execution.node != "child"));
}

#[test]
fn reworked_node_discards_its_previous_session_while_unaffected_nodes_keep_theirs() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: ["keep", "change", "child"]
            .into_iter()
            .map(|name| Node {
                name: name.into(),
                task: name.into(),
            })
            .collect(),
        edges: vec![Edge {
            from: "change".into(),
            to: "child".into(),
            feedback: false,
        }],
    };
    let (_temp, source, mut runtime) = setup(true, graph.clone());
    runtime.approve().unwrap();
    let roots = runtime.jobs().unwrap();
    for job in roots {
        let name = job.execution.node.clone();
        let path = Path::new(&job.execution.worktree);
        workspace::prepare(&source, path, &job.execution.before, &runtime.parents(&name)).unwrap();
        fs::write(path.join(format!("{name}.txt")), name.clone()).unwrap();
        let head = workspace::snapshot_node(path, &source, &name).unwrap();
        runtime
            .finish(&job.execution, Ok((head, "completed".into())))
            .unwrap();
    }
    let changed = runtime
        .state
        .executions
        .iter()
        .find(|execution| execution.node == "change")
        .unwrap()
        .clone();
    let kept = runtime
        .state
        .executions
        .iter()
        .find(|execution| execution.node == "keep")
        .unwrap()
        .clone();
    assert!(runtime.state.superseded_execution_ids.is_empty());
    let mut revised = graph;
    revised
        .nodes
        .iter_mut()
        .find(|node| node.name == "change")
        .unwrap()
        .task = "new task".into();
    runtime
        .revise_graph(revised, PlanningSummary {
            planning_id: "revision".into(),
            ..Default::default()
        })
        .unwrap();
    // The reworked node's whole previous session is discarded, exactly like a
    // superseded edit; unaffected nodes keep their conversation.
    assert_eq!(runtime.state.nodes["change"].status, "dirty");
    assert_eq!(runtime.state.nodes["child"].status, "waiting");
    assert_eq!(runtime.state.nodes["keep"].status, "completed");
    assert!(runtime
        .state
        .superseded_execution_ids
        .contains(&changed.id));
    assert!(!runtime
        .state
        .superseded_execution_ids
        .contains(&kept.id));
    let run_id = runtime.state.run_id.clone();
    let replay = runtime.store.load(&run_id).unwrap();
    assert!(replay.superseded_execution_ids.contains(&changed.id));
    assert!(!replay.superseded_execution_ids.contains(&kept.id));
    // The rework runs as a fresh session and attempt, not a continuation.
    let jobs = runtime.jobs().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].execution.node, "change");
    assert_ne!(jobs[0].execution.session_id, changed.session_id);
    assert_eq!(jobs[0].execution.attempt, 2);
    assert!(!jobs[0].continuation);
}

#[test]
fn planning_revision_defers_publication_but_not_ready_jobs() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: vec![Node {
            name: "first".into(),
            task: "first".into(),
        }],
        edges: vec![],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let jobs = runtime.jobs_with_publication(false).unwrap();
    assert_eq!(jobs.len(), 1);
    runtime
        .emit(EventKind::Finished {
            execution_id: jobs[0].execution.id.clone(),
            head: runtime.state.base.clone(),
            output: "completed".into(), output_bytes: 0, metrics: None,
        })
        .unwrap();
    assert!(runtime.jobs_with_publication(false).unwrap().is_empty());
    assert_ne!(runtime.state.phase, "publishing");
    assert!(runtime.jobs_with_publication(true).unwrap().is_empty());
    assert_eq!(runtime.state.phase, "publishing");
}

#[test]
fn live_revision_keeps_unaffected_running_and_resets_only_changed_failed_or_waiting() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: ["running", "failed", "waiting"]
            .into_iter()
            .map(|name| Node {
                name: name.into(),
                task: name.into(),
            })
            .collect(),
        edges: vec![Edge {
            from: "running".into(),
            to: "waiting".into(),
            feedback: false,
        }],
    };
    let (_temp, _source, mut runtime) = setup(true, graph.clone());
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    let active = jobs
        .iter()
        .find(|job| job.execution.node == "running")
        .unwrap();
    let failed = jobs
        .iter()
        .find(|job| job.execution.node == "failed")
        .unwrap();
    runtime
        .emit(EventKind::Failed {
            node: "failed".into(),
            execution_id: Some(failed.execution.id.clone()),
            error: "failed".into(), output_bytes: 0, metrics: None,
        })
        .unwrap();
    assert_eq!(runtime.state.nodes["waiting"].status, "waiting");
    let mut revised = graph.clone();
    revised
        .nodes
        .iter_mut()
        .find(|node| node.name == "failed")
        .unwrap()
        .task = "fix".into();
    revised
        .nodes
        .iter_mut()
        .find(|node| node.name == "waiting")
        .unwrap()
        .task = "new task".into();
    runtime
        .revise_graph(
            revised.clone(),
            PlanningSummary {
                planning_id: "live".into(),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(!runtime.state.paused);
    assert_eq!(runtime.state.nodes["running"].status, "running");
    assert_eq!(
        runtime
            .state
            .executions
            .iter()
            .find(|e| e.id == active.execution.id)
            .unwrap()
            .status,
        "running"
    );
    assert_eq!(runtime.state.nodes["failed"].status, "waiting");
    assert_eq!(runtime.state.nodes["waiting"].status, "waiting");
    assert_eq!(runtime.state.nodes["failed"].error, None);
    revised
        .nodes
        .iter_mut()
        .find(|node| node.name == "running")
        .unwrap()
        .task = "changed".into();
    assert!(runtime
        .revise_graph(revised, PlanningSummary::default())
        .unwrap_err()
        .contains("affected running"));
    assert_eq!(runtime.state.nodes["running"].status, "running");
}

#[test]
fn graph_revision_invalidates_only_nodes_with_new_inputs() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: ["source", "other", "consumer"]
            .into_iter()
            .map(|name| Node {
                name: name.into(),
                task: name.into(),
            })
            .collect(),
        edges: vec![Edge {
            from: "other".into(),
            to: "consumer".into(),
            feedback: false,
        }],
    };
    let (_temp, _source, mut runtime) = setup(true, graph.clone());
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    for job in jobs {
        runtime
            .emit(EventKind::Finished { output_bytes: 0, metrics: None,
                execution_id: job.execution.id,
                head: runtime.state.base.clone(),
                output: "completed".into(),
            })
            .unwrap();
    }
    // The consumer has actually executed, so changing its input invalidates its result.
    for job in runtime.jobs().unwrap() {
        runtime
            .emit(EventKind::Finished { output_bytes: 0, metrics: None,
                execution_id: job.execution.id,
                head: runtime.state.base.clone(),
                output: "completed".into(),
            })
            .unwrap();
    }
    let mut revised = graph;
    revised.edges.push(Edge {
        from: "source".into(),
        to: "consumer".into(),
        feedback: false,
    });
    runtime
        .revise_graph(
            revised,
            PlanningSummary {
                planning_id: "new-edge".into(),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(runtime.state.nodes["source"].status, "completed");
    assert_eq!(runtime.state.nodes["other"].status, "completed");
    assert_eq!(runtime.state.nodes["consumer"].status, "dirty");
    assert_eq!(runtime.state.nodes["consumer"].head, None);
    assert_eq!(
        runtime
            .jobs()
            .unwrap()
            .iter()
            .map(|job| job.execution.node.as_str())
            .collect::<Vec<_>>(),
        vec!["consumer"]
    );
}

#[test]
fn shadow_prepare_uses_approved_snapshot_despite_live_edits() {
    let (_temp, source, mut runtime) = setup(false, single());
    runtime.approve().unwrap();
    // The plain-directory snapshot is created lazily on first dispatch.
    let mut job = runtime.jobs().unwrap().remove(0);
    attach(&mut runtime, &mut job);
    let base = job.execution.before.clone();
    let node = Path::new(&job.execution.worktree);
    fs::write(source.join("tracked.txt"), "edited after approval").unwrap();
    // Live edits never block preparation: the node starts from the approved
    // snapshot, and publication later commits the edit as its base.
    workspace::prepare(&source, node, &base, &[]).unwrap();
    assert_eq!(
        fs::read_to_string(node.join("tracked.txt")).unwrap(),
        "original"
    );
    assert!(!workspace::repository_status(&source, &[]).unwrap().is_empty());
    // Publication commits the live edit as its base instead of rejecting it.
    let published = crate::graph_merge::merge_graph(&source, &[], || panic!("no merge expected"))
        .unwrap();
    assert_ne!(published, base);
    assert_eq!(
        fs::read_to_string(source.join("tracked.txt")).unwrap(),
        "edited after approval"
    );
    assert!(workspace::repository_status(&source, &[]).unwrap().is_empty());
    // The earlier recorded base remains composable for nodes scheduled against it.
    workspace::prepare(&source, node, &base, &[]).unwrap();
    assert_eq!(
        fs::read_to_string(node.join("tracked.txt")).unwrap(),
        "original"
    );
    // A later recorded source snapshot does not invalidate an earlier base either.
    fs::write(source.join("later.txt"), "later source").unwrap();
    assert_ne!(
        workspace::snapshot_repository_scoped(&source, &[]).unwrap(),
        published
    );
    workspace::prepare(&source, node, &base, &[]).unwrap();
    assert_eq!(
        fs::read_to_string(node.join("tracked.txt")).unwrap(),
        "original"
    );
    assert!(!node.join("later.txt").exists());
}

#[test]
fn shadow_source_edits_do_not_block_downstream_handoff() {
    let graph = Graph {
        original_goal: "handoff".into(),
        nodes: vec![
            Node { name: "parent".into(), task: "parent task".into() },
            Node { name: "child".into(), task: "child task".into() },
        ],
        edges: vec![Edge {
            from: "parent".into(),
            to: "child".into(),
            feedback: false,
        }],
    };
    let (_temp, source, mut runtime) = setup(false, graph);
    runtime.approve().unwrap();
    let mut parent = runtime.jobs().unwrap().remove(0);
    attach(&mut runtime, &mut parent);
    let parent_path = Path::new(&parent.execution.worktree);
    workspace::prepare(&source, parent_path, &parent.execution.before, &[]).unwrap();
    fs::write(parent_path.join("parent.txt"), "parent result").unwrap();
    let parent_head = workspace::snapshot_node(parent_path, &source, "parent").unwrap();
    runtime
        .finish(&parent.execution, Ok((parent_head, "completed".into())))
        .unwrap();

    // The user edits the source directory while the graph is still running.
    fs::write(source.join("tracked.txt"), "user edit during run").unwrap();

    let mut child = runtime.jobs().unwrap().remove(0);
    attach(&mut runtime, &mut child);
    assert_eq!(child.execution.node, "child");
    let child_path = Path::new(&child.execution.worktree);
    // Handoff composes the recorded snapshots instead of failing on the dirty source.
    workspace::prepare_with_merger_expected_for_run(
        &source,
        child_path,
        &child.execution.before,
        &child.parent_heads,
        &child.expected_source_head,
        Some(&runtime.state.run_id),
        || Err("unexpected merge".into()),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(child_path.join("tracked.txt")).unwrap(),
        "original"
    );
    assert_eq!(
        fs::read_to_string(child_path.join("parent.txt")).unwrap(),
        "parent result"
    );
    // Publication commits the user edit and merges the node result on top.
    let child_head = workspace::snapshot_node(child_path, &source, "child").unwrap();
    crate::graph_merge::merge_graph(&source, &[child_head], || panic!("no conflict")).unwrap();
    assert_eq!(
        fs::read_to_string(source.join("tracked.txt")).unwrap(),
        "user edit during run"
    );
    assert_eq!(
        fs::read_to_string(source.join("parent.txt")).unwrap(),
        "parent result"
    );
    assert!(workspace::repository_status(&source, &[]).unwrap().is_empty());
}

#[test]
fn feedback_transfers_the_review_workspace_and_forks_the_owner_history() {
    let graph = Graph {
        original_goal: "feedback rework".into(),
        nodes: ["owner", "review"]
            .into_iter()
            .map(|name| Node { name: name.into(), task: name.into() })
            .collect(),
        edges: [
            ("owner", "review", false),
            ("review", "owner", true),
        ]
        .into_iter()
        .map(|(from, to, feedback)| Edge {
            from: from.into(), to: to.into(), feedback,
        })
        .collect(),
    };
    let (_temp, source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let owner = runtime.jobs().unwrap().remove(0);
    let owner_session = owner.execution.session_id.clone();
    let owner_id = owner.execution.id.clone();
    let owner_path = Path::new(&owner.execution.worktree);
    workspace::prepare(&source, owner_path, &owner.execution.before, &[]).unwrap();
    fs::write(owner_path.join("tracked.txt"), "owner result").unwrap();
    let owner_head = workspace::snapshot_node_for_run(owner_path, &source, "owner", Some(&runtime.state.run_id)).unwrap();
    runtime.finish(&owner.execution, Ok((owner_head, "completed".into()))).unwrap();

    let review = runtime.jobs().unwrap().remove(0);
    assert_eq!(review.execution.node, "review");
    let review_path = Path::new(&review.execution.worktree);
    workspace::prepare(&source, review_path, &review.execution.before, &review.parent_heads).unwrap();
    fs::create_dir(review_path.join("reports")).unwrap();
    fs::write(review_path.join("reports/audit.json"), "review evidence").unwrap();
    let review_head = workspace::snapshot_node_for_run(review_path, &source, "review", Some(&runtime.state.run_id)).unwrap();
    runtime.finish(&review.execution, Ok((review_head.clone(), "please adjust\n<FEEDBACK>".into()))).unwrap();
    runtime.apply_feedback("review", "please adjust\n<FEEDBACK>").unwrap();

    assert_eq!(runtime.state.nodes["owner"].status, "dirty");
    assert!(runtime.state.nodes["review"].head.is_none());
    let jobs = runtime.jobs_with_pending_feedback(true, &[]).unwrap();
    let rework = jobs.iter().find(|job| job.execution.node == "owner").unwrap();
    assert_ne!(rework.execution.session_id, owner_session);
    assert!(rework.resume_execution_id.is_none());
    assert_eq!(rework.session_fork.as_ref().unwrap().id, owner_id);
    assert_eq!(rework.execution.worktree, review.execution.worktree);
    assert_eq!(rework.execution.before, review_head);
    assert_eq!(rework.task, "Feedback from review:\nplease adjust");
    assert!(!rework.task.contains("<FEEDBACK>"));
    let before = workspace::prepare_with_merger_expected_for_run(&source, review_path, &rework.execution.before,
        &rework.parent_heads, &runtime.state.base, Some(&runtime.state.run_id), || Err("unexpected merge".into())).unwrap();
    assert_eq!(before, review_head);
    assert_eq!(fs::read_to_string(review_path.join("reports/audit.json")).unwrap(), "review evidence");
    assert!(runtime.state.pending_feedback.is_empty());
}

#[test]
fn completed_shadow_graph_intervention_accepts_source_changes() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: vec![
            Node { name: "parent".into(), task: "parent task".into() },
            Node { name: "child".into(), task: "child task".into() },
        ],
        edges: vec![Edge {
            from: "parent".into(),
            to: "child".into(),
            feedback: false,
        }],
    };
    let (_temp, source, mut runtime) = setup(false, graph);
    runtime.approve().unwrap();
    let base = runtime.state.base.clone();
    for name in ["parent", "child"] {
        let mut job = runtime.jobs().unwrap().remove(0);
        attach(&mut runtime, &mut job);
        let path = Path::new(&job.execution.worktree);
        workspace::prepare(&source, path, &job.execution.before, &runtime.parents(name)).unwrap();
        fs::write(path.join(format!("{name}.txt")), name).unwrap();
        let head = workspace::snapshot_node(path, &source, name).unwrap();
        runtime.finish(&job.execution, Ok((head, "completed".into()))).unwrap();
    }
    runtime.jobs().unwrap();
    let publication = runtime.state.publication.clone().unwrap();
    let published = crate::graph_merge::merge_graph(&source, &publication.heads, || {
        Err("merge conflict".into())
    })
    .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted { head: published.clone() })
        .unwrap();
    assert_ne!(published, base);
    fs::write(source.join("tracked.txt"), "external edit").unwrap();
    // Explicit node updates accept live source edits instead of failing fast.
    runtime.intervene("parent", "again").unwrap();
    assert_eq!(runtime.state.nodes["parent"].status, "dirty");
    // The follow-up only recomputes downstream once its result changes.
    assert_eq!(runtime.state.nodes["child"].status, "completed");
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(replay.published_head.as_deref(), Some(published.as_str()));
    fs::remove_dir_all(workspace::shadow_repo_dir(&source).unwrap()).unwrap();
}

#[test]
fn child_inherits_parent_files_with_a_fresh_task_and_session() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: vec![
            Node {
                name: "parent".into(),
                task: "parent task".into(),
            },
            Node {
                name: "child".into(),
                task: "child task".into(),
            },
        ],
        edges: vec![Edge {
            from: "parent".into(),
            to: "child".into(),
            feedback: false,
        }],
    };
    let (_temp, source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let parent = runtime.jobs().unwrap().remove(0);
    let path = Path::new(&parent.execution.worktree);
    workspace::prepare(&source, path, &parent.execution.before, &[]).unwrap();
    fs::write(path.join("from-parent.txt"), "parent result").unwrap();
    let head = workspace::snapshot_node(path, &source, "parent").unwrap();
    runtime
        .finish(
            &parent.execution,
            Ok((head, "PRIVATE PARENT CONVERSATION".into())),
        )
        .unwrap();
    let child = runtime.jobs().unwrap().remove(0);
    assert_ne!(child.execution.session_id, parent.execution.session_id);
    assert_eq!(child.execution.worktree, parent.execution.worktree);
    assert_eq!(child.task.trim(), "child task");
    let path = Path::new(&child.execution.worktree);
    workspace::prepare(
        &source,
        path,
        &child.execution.before,
        &runtime.parents("child"),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(path.join("from-parent.txt")).unwrap(),
        "parent result"
    );
    assert!(!source.join("from-parent.txt").exists());
}

#[test]
fn fan_in_conflict_invokes_merger_and_preserves_both_parents() {
    for standard_git in [true, false] {
        let (_temp, source, mut runtime) = setup(standard_git, single());
        runtime.approve().unwrap();
        let base = if standard_git {
            runtime.state.base.clone()
        } else {
            workspace::materialize_shadow_repo(&source, &runtime.exclusions().unwrap()).unwrap()
        };
        for (name, text) in [("left", "left\n"), ("right", "right\n")] {
            let path = source.parent().unwrap().join(format!("{name}-workspace"));
            workspace::prepare(&source, &path, &base, &[]).unwrap();
            fs::write(path.join("tracked.txt"), text).unwrap();
            workspace::snapshot_node(&path, &source, name).unwrap();
        }
        let target = source.parent().unwrap().join("fan-in");
        let mut calls = 0;
        let head = workspace::prepare_with_merger(
            &source,
            &target,
            &base,
            &["left".into(), "right".into()],
            || {
                calls += 1;
                assert!(workspace::git(&target, &["rev-parse", "MERGE_HEAD"]).is_ok());
                fs::write(target.join("tracked.txt"), "left and right\n").unwrap();
                workspace::git(&target, &["add", "-A"]).unwrap();
                workspace::git(&target, &["commit", "--no-edit"]).unwrap();
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(calls, 1);
        for name in ["left", "right"] {
            workspace::git(
                &target,
                &[
                    "merge-base",
                    "--is-ancestor",
                    &format!("refs/grapher/parents/{name}"),
                    &head,
                ],
            )
            .unwrap();
        }
        assert_eq!(
            fs::read_to_string(target.join("tracked.txt")).unwrap(),
            "left and right\n"
        );
    }
}

#[test]
fn failed_fan_in_merger_preserves_conflict_for_manual_resolution() {
    let (_temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let base = runtime.state.base.clone();
    for (name, content) in [("a", "a"), ("b", "b")] {
        let path = source.parent().unwrap().join(format!("workspace-{name}"));
        workspace::prepare(&source, &path, &base, &[]).unwrap();
        fs::write(path.join("tracked.txt"), content).unwrap();
        workspace::snapshot_node(&path, &source, name).unwrap();
    }
    let target = source.parent().unwrap().join("conflicted");
    let error =
        workspace::prepare_with_merger(&source, &target, &base, &["a".into(), "b".into()], || {
            Err("resolver unavailable".into())
        })
        .unwrap_err();
    assert!(error.starts_with("Workspace composition blocked"));
    assert!(error.contains("resolver unavailable"));
    assert!(workspace::git(&target, &["rev-parse", "MERGE_HEAD"]).is_ok());
    assert!(
        !workspace::git(&target, &["diff", "--name-only", "--diff-filter=U"])
            .unwrap()
            .is_empty()
    );
}

#[test]
fn node_merger_events_do_not_enter_publication_phase() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let mut merger = runtime.jobs().unwrap().remove(0).execution;
    merger.id = Uuid::new_v4().to_string();
    merger.node = "merge:task".into();
    runtime
        .emit(EventKind::MergerStarted {
            execution: merger.clone(),
        })
        .unwrap();
    assert_eq!(runtime.state.phase, "running");
    runtime
        .emit(EventKind::MergerFinished {
            execution_id: merger.id,
            head: runtime.state.base.clone(), output_bytes: 0, metrics: None,
        })
        .unwrap();
    assert_eq!(runtime.state.phase, "running");
    assert!(runtime.state.publication.is_none());
}

#[test]
fn running_merger_reserves_its_workspace() {
    let (_temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let id = Uuid::new_v4().to_string();
    let path = source.parent().unwrap().join("merge-workspace");
    let merger = Execution {
        id: id.clone(),
        node: "merge:task".into(),
        revision: 1,
        attempt: 1,
        session_id: id.clone(),
        worktree: path.to_string_lossy().into(),
        before: runtime.state.base.clone(),
        workspace_lineage: vec![],
        after: None,
        input: None, result: None,
        status: "running".into(),
        output: String::new(), output_bytes: 0, pid: None,
        started_at: now(),
        completed_at: None,
        metrics: None,
    };
    assert!(!runtime.path_is_running(&path));
    runtime
        .emit(EventKind::MergerStarted {
            execution: merger.clone(),
        })
        .unwrap();
    assert!(runtime.path_is_running(&path));
    runtime
        .emit(EventKind::MergerFailed {
            execution_id: id,
            error: "fixture".into(),
            output_bytes: 0,
            metrics: None,
        })
        .unwrap();
    assert!(!runtime.path_is_running(&path));
}

#[test]
fn failed_node_merger_marks_posterior_node_blocked_and_descendants_recover_on_node_start() {
    let graph = Graph {
        original_goal: "merger failure blocks target node".into(),
        nodes: ["left", "right", "join", "after"].into_iter()
            .map(|name| Node { name: name.into(), task: name.into() })
            .collect(),
        edges: vec![
            Edge { from: "left".into(), to: "join".into(), feedback: false },
            Edge { from: "right".into(), to: "join".into(), feedback: false },
            Edge { from: "join".into(), to: "after".into(), feedback: false },
        ],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    assert_eq!(jobs.len(), 2);
    let left = jobs.iter().find(|j| j.execution.node == "left").unwrap().execution.clone();
    let right = jobs.iter().find(|j| j.execution.node == "right").unwrap().execution.clone();
    runtime.finish(&left, Ok(("head-left".into(), "ok".into()))).unwrap();
    runtime.finish(&right, Ok(("head-right".into(), "ok".into()))).unwrap();

    // Now start a merger for node "join".
    let merger_id = Uuid::new_v4().to_string();
    let merger = Execution {
        id: merger_id.clone(),
        node: "merge:join".into(),
        revision: 1,
        attempt: 1,
        session_id: merger_id.clone(),
        worktree: "test-tree".into(),
        before: "head-left".into(),
        workspace_lineage: vec![],
        after: None, input: None, result: None,
        status: "running".into(),
        output: String::new(), output_bytes: 0, pid: None,
        started_at: now(), completed_at: None, metrics: None,
    };
    runtime.emit(EventKind::MergerStarted { execution: merger.clone() }).unwrap();

    // Merger fails: its corresponding posterior node "join" must be "blocked", NOT "failed".
    runtime.emit(EventKind::MergerFailed {
        execution_id: merger_id.clone(),
        error: "conflict could not be resolved".into(),
        output_bytes: 0,
        metrics: None,
    }).unwrap();

    assert_eq!(runtime.state.nodes["join"].status, "blocked");
    assert!(runtime.state.nodes["join"].error.as_deref().unwrap().contains("Merger failed"));

    // Schedule passes: descendants of "join" ("after") are blocked as well.
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.nodes["after"].status, "blocked");

    // Sending a message to the failed merger starts a new merger execution.
    // Downstream blocked nodes must NOT become "waiting" yet; they remain blocked.
    let merger_retry_id = Uuid::new_v4().to_string();
    let mut retry_merger = merger.clone();
    retry_merger.id = merger_retry_id.clone();
    retry_merger.attempt = 2;
    runtime.emit(EventKind::MergerStarted { execution: retry_merger.clone() }).unwrap();
    runtime.emit(EventKind::Steered {
        execution_id: merger_retry_id.clone(),
        node: "merge:join".into(),
        instruction: "please fix conflict".into(),
        images: None,
    }).unwrap();

    // Nodes still remain blocked while the merger is retrying.
    assert_eq!(runtime.state.nodes["join"].status, "blocked");
    assert_eq!(runtime.state.nodes["after"].status, "blocked");

    // Once the merger finishes and "join" starts running (Started), its descendants return to "waiting".
    runtime.emit(EventKind::MergerFinished {
        execution_id: merger_retry_id,
        head: "merged-head".into(),
        output_bytes: 0,
        metrics: None,
    }).unwrap();

    // Emitting Started for "join" resets its blocked descendants to waiting.
    let mut join_exec = merger.clone();
    join_exec.node = "join".into();
    runtime.emit(EventKind::Started { execution: join_exec, message_sequences: None }).unwrap();
    assert_eq!(runtime.state.nodes["after"].status, "waiting");
}

#[test]
fn reset_cleans_only_its_run_worktrees() {
    let (temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    let path = Path::new(&job.execution.worktree);
    fs::create_dir_all(path).unwrap();
    let other = temp.path().join(".grapher-worktrees").join("other-run");
    fs::create_dir_all(&other).unwrap();
    runtime
        .emit(EventKind::Failed {
            node: job.execution.node,
            execution_id: Some(job.execution.id),
            error: "test".into(), output_bytes: 0, metrics: None,
        })
        .unwrap();
    runtime.reset_workspace().unwrap();
    assert!(!path.exists());
    assert!(other.exists());
    assert!(source.exists());
}

#[test]
fn explicit_serial_route_still_uses_source() {
    let (_temp, source, mut runtime) = setup(true, single());
    runtime.set_route("serial").unwrap();
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    assert_eq!(Path::new(&job.execution.worktree), source);
}

#[test]
fn moved_binding_blocks_approval_without_migrating_or_snapshotting() {
    let (temp, source, mut runtime) = setup(true, single());
    fs::write(source.join("planner.txt"), "retain planner work").unwrap();
    let moved = temp.path().join("moved");
    fs::rename(&source, &moved).unwrap();
    let before = workspace::git(&moved, &["rev-parse", "HEAD"]).unwrap();
    assert!(runtime.approve().unwrap_err().contains("项目绑定已失效"));
    assert!(!runtime.state.approved);
    assert!(runtime.state.executions.is_empty());
    assert_eq!(
        workspace::git(&moved, &["rev-parse", "HEAD"]).unwrap(),
        before
    );
    assert_eq!(
        fs::read_to_string(moved.join("planner.txt")).unwrap(),
        "retain planner work"
    );
    assert!(!source.exists());
}

#[test]
fn moved_binding_blocks_scheduling_and_publication() {
    let (temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    fs::rename(&source, temp.path().join("moved")).unwrap();
    assert!(runtime.jobs().err().unwrap().contains("项目绑定已失效"));
    assert!(runtime.state.executions.is_empty());
    runtime.pause(true).unwrap();
    assert!(runtime.pause(false).unwrap_err().contains("项目绑定已失效"));
    assert!(runtime.state.paused);
    assert!(runtime
        .resolved("task")
        .unwrap_err()
        .contains("项目绑定已失效"));
    runtime
        .emit(EventKind::PublicationStarted {
            repository: source.to_string_lossy().into(),
            heads: vec![runtime.state.base.clone()],
        })
        .unwrap();
    runtime
        .emit(EventKind::PublicationFailed {
            error: "interrupted".into(),
        })
        .unwrap();
    assert!(runtime
        .retry_publication()
        .unwrap_err()
        .contains("项目绑定已失效"));
    assert_eq!(runtime.state.phase, "publication_failed");
    assert!(
        crate::graph_merge::merge_graph(&source, &[], || panic!("must not launch merger"))
            .unwrap_err()
            .contains("项目绑定已失效")
    );
    assert!(!source.exists());
}

/// Complete the single node and run a successful publication for it, leaving
/// the Run in the completed phase with reclaimed publication inputs.
fn publish_single_node() -> (TempDir, PathBuf, Runtime, String) {
    let (temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    let path = Path::new(&job.execution.worktree);
    workspace::prepare(&source, path, &job.execution.before, &[]).unwrap();
    fs::write(path.join("task.txt"), "v1").unwrap();
    let head = workspace::snapshot_node(path, &source, "task").unwrap();
    runtime
        .finish(&job.execution, Ok((head, "completed".into())))
        .unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    let publication = runtime.state.publication.clone().unwrap();
    let published = crate::graph_merge::merge_graph(&source, &publication.heads, || {
        Err("conflict".into())
    })
    .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted { head: published })
        .unwrap();
    assert_eq!(runtime.state.phase, "completed");
    (temp, source, runtime, publication.heads[0].clone())
}

#[test]
fn resume_after_stopped_post_task_review_settles_instead_of_republishing() {
    let (_temp, source, mut runtime, task_head) = publish_single_node();
    // The successful publication reclaimed the snapshot and worktrees, so the
    // terminal commit only exists in the recorded state.
    runtime.cleanup_worktrees().unwrap();
    runtime.reclaim_shadow_after_publication(&source).unwrap();
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_none());

    // A post-task review stopped by the user walks completed -> planning ->
    // paused; resuming returns the Run to running with unchanged results.
    runtime
        .emit(EventKind::PlannerReviewStarted {
            planning: Default::default(),
        })
        .unwrap();
    runtime.emit(EventKind::StopRequested).unwrap();
    runtime
        .emit(EventKind::PlannerReviewFinished {
            planning: Default::default(),
            approval_required: false,
        })
        .unwrap();
    runtime.pause(false).unwrap();
    assert_eq!(runtime.state.phase, "running");

    // The next scheduling turn must settle, not start a doomed second
    // publication over commits whose Git objects no longer exist.
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "completed");
    assert_eq!(runtime.state.published_heads, vec![task_head]);
    assert_eq!(
        runtime
            .state
            .events
            .iter()
            .filter(|event| matches!(event.kind, EventKind::PublicationStarted { .. }))
            .count(),
        1
    );
    let publication = runtime.state.publication.clone().unwrap();
    assert_eq!(publication.status, "completed");
    assert!(publication.completed_at.is_some());
}

#[test]
fn retry_publication_settles_a_redundant_attempt_over_published_heads() {
    let (_temp, source, mut runtime, task_head) = publish_single_node();
    // Legacy poisoned state: a redundant second attempt over the same heads
    // replaced the completed publication record and then failed.
    runtime
        .emit(EventKind::PublicationStarted {
            repository: source.to_string_lossy().into(),
            heads: vec![task_head.clone()],
        })
        .unwrap();
    runtime
        .emit(EventKind::PublicationFailed {
            error: "merge: gone - not something we can merge".into(),
        })
        .unwrap();
    assert_eq!(runtime.state.phase, "publication_failed");
    assert!(runtime.state.paused);

    runtime.retry_publication().unwrap();
    assert_eq!(runtime.state.phase, "completed");
    assert!(!runtime.state.paused);
    // The redundant attempt resolves at the already-published head, so the
    // publication record no longer advertises a recoverable failure.
    let publication = runtime.state.publication.clone().unwrap();
    assert_eq!(publication.status, "completed");
    assert_eq!(publication.head.as_deref(), runtime.state.published_head.as_deref());
    assert!(publication.error.is_none());
}

#[test]
fn deleting_last_plain_directory_run_removes_only_unused_shadow_repo() {
    let (_temp, source, mut runtime) = setup(false, single());
    let shadow = workspace::shadow_repo_dir(&source).unwrap();
    assert!(shadow.exists());

    let first = runtime.state.run_id.clone();
    let config = runtime.state.config.clone().unwrap();
    runtime.create(single(), config).unwrap();
    let second = runtime.state.run_id.clone();
    assert_ne!(first, second);
    assert!(shadow.exists());

    runtime.delete_run(&first).unwrap();
    assert!(shadow.exists(), "a remaining run still needs the shadow repo");

    runtime.delete_run(&second).unwrap();
    assert!(!shadow.exists(), "the final conversation should release the shadow repo");
}

#[test]
fn viewing_another_project_does_not_change_a_valid_run_binding() {
    let (temp, source, mut runtime) = setup(true, single());
    let other = temp.path().join("other");
    fs::create_dir(&other).unwrap();
    workspace::validate_binding(&other).unwrap();
    // Read-only status must not initialize Git or change the runtime binding.
    assert!(!other.join(".git").exists());
    assert!(!workspace::shadow_repo_dir(&other).unwrap().exists());
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    assert_eq!(Path::new(&job.config.repository), source);
}

#[test]
fn post_publication_revision_rebuilds_from_published_head_and_merges_new_terminal() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: ["root", "child"]
            .into_iter()
            .map(|name| Node {
                name: name.into(),
                task: name.into(),
            })
            .collect(),
        edges: vec![Edge {
            from: "root".into(),
            to: "child".into(),
            feedback: false,
        }],
    };
    let (_temp, source, mut runtime) = setup(true, graph.clone());
    runtime.approve().unwrap();
    let root_job = runtime.jobs().unwrap().remove(0);
    let path = Path::new(&root_job.execution.worktree);
    workspace::prepare(&source, path, &root_job.execution.before, &[]).unwrap();
    fs::write(path.join("root.txt"), "root v1").unwrap();
    let root_head = workspace::snapshot_node(path, &source, "root").unwrap();
    runtime
        .finish(&root_job.execution, Ok((root_head, "completed".into())))
        .unwrap();
    let child_job = runtime.jobs().unwrap().remove(0);
    let path = Path::new(&child_job.execution.worktree);
    workspace::prepare(
        &source,
        path,
        &child_job.execution.before,
        &runtime.parents("child"),
    )
    .unwrap();
    fs::write(path.join("child.txt"), "child v1").unwrap();
    let child_head = workspace::snapshot_node(path, &source, "child").unwrap();
    runtime
        .finish(&child_job.execution, Ok((child_head.clone(), "completed".into())))
        .unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    let publication = runtime.state.publication.clone().unwrap();
    let published = crate::graph_merge::merge_graph(&source, &publication.heads, || {
        Err("conflict".into())
    })
    .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted {
            head: published.clone(),
        })
        .unwrap();
    assert_eq!(runtime.state.phase, "completed");
    runtime.cleanup_worktrees().unwrap();

    let mut revised = graph.clone();
    revised
        .nodes
        .iter_mut()
        .find(|node| node.name == "root")
        .unwrap()
        .task = "root v2".into();
    revised.nodes.push(Node {
        name: "extra".into(),
        task: "extra".into(),
    });
    runtime
        .revise_graph(
            revised,
            PlanningSummary {
                planning_id: "revision-after-publication".into(),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(runtime.state.nodes["root"].status, "dirty");
    assert!(matches!(
        runtime.state.nodes["child"].status.as_str(),
        "waiting" | "dirty"
    ));
    assert_eq!(runtime.state.nodes["extra"].status, "waiting");

    let mut jobs = runtime.jobs().unwrap();
    let mut names: Vec<String> = jobs.iter().map(|job| job.execution.node.clone()).collect();
    names.sort();
    assert_eq!(names, vec!["extra".to_string(), "root".to_string()]);
    for job in &jobs {
        // New and invalidated work starts from the workspace users received,
        // so its commit merges back cleanly instead of replaying the approval base.
        assert_eq!(job.execution.before, published);
    }
    let root_position = jobs
        .iter()
        .position(|job| job.execution.node == "root")
        .unwrap();
    let root_job = jobs.remove(root_position);
    let path = Path::new(&root_job.execution.worktree);
    workspace::prepare(&source, path, &root_job.execution.before, &[]).unwrap();
    fs::write(path.join("root.txt"), "root v2").unwrap();
    let root_head = workspace::snapshot_node(path, &source, "root").unwrap();
    runtime
        .finish(&root_job.execution, Ok((root_head, "completed".into())))
        .unwrap();
    let extra_job = jobs.remove(0);
    assert_eq!(extra_job.execution.node, "extra");
    let path = Path::new(&extra_job.execution.worktree);
    workspace::prepare(&source, path, &extra_job.execution.before, &[]).unwrap();
    fs::write(path.join("extra.txt"), "extra v1").unwrap();
    let extra_head = workspace::snapshot_node(path, &source, "extra").unwrap();
    runtime
        .finish(&extra_job.execution, Ok((extra_head.clone(), "completed".into())))
        .unwrap();
    let child_job = runtime.jobs().unwrap().remove(0);
    assert_eq!(child_job.execution.node, "child");
    assert_eq!(child_job.execution.before, published);
    let path = Path::new(&child_job.execution.worktree);
    workspace::prepare(
        &source,
        path,
        &child_job.execution.before,
        &runtime.parents("child"),
    )
    .unwrap();
    fs::write(path.join("child.txt"), "child v2").unwrap();
    let child_head = workspace::snapshot_node(path, &source, "child").unwrap();
    runtime
        .finish(&child_job.execution, Ok((child_head.clone(), "completed".into())))
        .unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    let publication = runtime.state.publication.clone().unwrap();
    assert!(publication.heads.contains(&child_head));
    assert!(publication.heads.contains(&extra_head));
    crate::graph_merge::merge_graph(&source, &publication.heads, || Err("conflict".into())).unwrap();
    assert_eq!(fs::read_to_string(source.join("root.txt")).unwrap(), "root v2");
    assert_eq!(fs::read_to_string(source.join("child.txt")).unwrap(), "child v2");
    assert_eq!(fs::read_to_string(source.join("extra.txt")).unwrap(), "extra v1");
}

#[test]
fn plan_and_approve_do_not_materialize_a_plain_directory() {
    let (_temp, source, mut runtime) = setup(false, single());
    workspace::remove_shadow_repo(&source).unwrap();
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_none());
    runtime.approve().unwrap();
    assert_eq!(runtime.state.base, "");
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_none());
}

#[test]
fn first_graph_dispatch_materializes_once() {
    let (_temp, source, mut runtime) = setup(false, single());
    workspace::remove_shadow_repo(&source).unwrap();
    runtime.approve().unwrap();
    let mut job = runtime.jobs().unwrap().remove(0);
    assert!(job.materialize_source);
    assert!(job.execution.before.is_empty());
    attach(&mut runtime, &mut job);
    let snapshots = |runtime: &Runtime| {
        runtime
            .state
            .events
            .iter()
            .filter(|event| matches!(event.kind, EventKind::SourceSnapshotted { .. }))
            .count()
    };
    assert_eq!(snapshots(&runtime), 1);
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_some());
    let head = job.execution.before.clone();
    assert!(!head.is_empty());
    runtime
        .emit(EventKind::Prepared {
            execution_id: job.execution.id.clone(),
            head: head.clone(),
        })
        .unwrap();
    assert_eq!(runtime.state.executions[0].before, head);
    // A second worker reuses the snapshot without another event.
    attach(&mut runtime, &mut job);
    assert_eq!(snapshots(&runtime), 1);
}

#[test]
fn serial_run_never_materializes_a_plain_directory() {
    let (_temp, source, mut runtime) = setup(false, single());
    workspace::remove_shadow_repo(&source).unwrap();
    runtime.set_route("serial").unwrap();
    runtime.approve().unwrap();
    assert_eq!(runtime.state.base, "");
    let job = runtime.jobs().unwrap().remove(0);
    assert_eq!(Path::new(&job.execution.worktree), source);
    assert!(!job.materialize_source);
    assert_eq!(
        workspace::snapshot_execution(Path::new(&job.execution.worktree), &source, "task").unwrap(),
        ""
    );
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_none());
}

#[test]
fn publication_reclaims_shadow_and_failure_retains_it() {
    let (_temp, source, mut runtime) = setup(false, single());
    workspace::remove_shadow_repo(&source).unwrap();
    runtime.approve().unwrap();
    let mut job = runtime.jobs().unwrap().remove(0);
    attach(&mut runtime, &mut job);
    let path = Path::new(&job.execution.worktree);
    workspace::prepare(&source, path, &job.execution.before, &[]).unwrap();
    fs::write(path.join("result.txt"), "completed").unwrap();
    let node_head = workspace::snapshot_node(path, &source, "task").unwrap();
    runtime
        .finish(&job.execution, Ok((node_head, "completed".into())))
        .unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    // A failed publication keeps the snapshot for retry and evidence.
    runtime
        .emit(EventKind::PublicationFailed {
            error: "conflict".into(),
        })
        .unwrap();
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_some());
    // Retry succeeds: the merged result is written back and the snapshot freed.
    let publication = runtime.state.publication.clone().unwrap();
    let published = crate::graph_merge::merge_graph(&source, &publication.heads, || {
        Err("conflict".into())
    })
    .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted { head: published })
        .unwrap();
    assert!(runtime.shadow_reclaimable_after_publication(&source).unwrap());
    runtime.reclaim_shadow_after_publication(&source).unwrap();
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_none());
    assert!(source.join("result.txt").is_file());
}

#[test]
fn shared_source_reclaims_after_last_incomplete_run() {
    let (_temp, source, mut runtime) = setup(false, single());
    workspace::remove_shadow_repo(&source).unwrap();
    runtime.approve().unwrap();
    let mut job = runtime.jobs().unwrap().remove(0);
    attach(&mut runtime, &mut job);
    let run_id = runtime.state.run_id.clone();
    // A second, still-incomplete Run on the same source keeps the snapshot.
    let config = runtime.state.config.clone().unwrap();
    let mut other = Snapshot {
        run_id: Uuid::new_v4().to_string(),
        ..Default::default()
    };
    runtime
        .store
        .append(
            &mut other,
            EventKind::Created {
                graph: single(),
                config,
                planning_id: None,
                planning: None,
            },
        )
        .unwrap();
    assert!(runtime
        .store
        .shadow_repo_needed_by_other_run(&run_id, &source)
        .unwrap());
    runtime.reclaim_shadow_after_publication(&source).unwrap();
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_some());
    // Once every other Run is completed, the last finisher reclaims it.
    let mut other = runtime.store.load(&other.run_id).unwrap();
    runtime
        .store
        .append(
            &mut other,
            EventKind::PublicationCompleted {
                head: "deadbeef".into(),
            },
        )
        .unwrap();
    runtime.reclaim_shadow_after_publication(&source).unwrap();
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_none());
}

#[test]
#[cfg(feature = "fixture")]
fn post_publication_node_followup_runs_in_source() {
    let (temp, source, mut runtime) = setup(false, single());
    workspace::remove_shadow_repo(&source).unwrap();
    runtime.approve().unwrap();
    let mut job = runtime.jobs().unwrap().remove(0);
    attach(&mut runtime, &mut job);
    let path = Path::new(&job.execution.worktree);
    workspace::prepare(&source, path, &job.execution.before, &[]).unwrap();
    fs::write(path.join("result.txt"), "v1").unwrap();
    let head = workspace::snapshot_node(path, &source, "task").unwrap();
    runtime
        .finish(&job.execution, Ok((head, "completed".into())))
        .unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    let publication = runtime.state.publication.clone().unwrap();
    let published = crate::graph_merge::merge_graph(&source, &publication.heads, || {
        Err("conflict".into())
    })
    .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted { head: published })
        .unwrap();
    runtime.reclaim_shadow_after_publication(&source).unwrap();
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_none());

    runtime.intervene("task", "again").unwrap();
    assert_eq!(runtime.state.phase, "followup");
    let mut followup = runtime.jobs().unwrap().remove(0);
    assert!(followup.source_direct);
    assert!(!followup.materialize_source);
    assert_eq!(Path::new(&followup.execution.worktree), source);
    assert_eq!(followup.execution.before, "");
    let script = temp.path().join("agent.sh");
    fs::write(&script, "cat >/dev/null
printf '%s\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'
").unwrap();
    followup.config.pi_command = "/bin/sh".into();
    followup.config.pi_args = vec![script.to_string_lossy().into()];
    let result = perform(&followup, &runtime.root, &[], |_| {}, |_| Ok(()));
    runtime.finish(&followup.execution, result).unwrap();
    assert_eq!(runtime.state.executions.last().unwrap().after.as_deref(), Some(""));
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_none());
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "completed");
    assert_eq!(runtime.state.nodes["task"].status, "completed");
    // A source-direct result is not a tracked Git change: the completed
    // publication survives the follow-up.
    assert!(runtime.state.publication.is_some());
}

#[test]
#[cfg(feature = "fixture")]
fn post_publication_direct_edit_keeps_downstream_and_publication() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: vec![
            Node {
                name: "parent".into(),
                task: "parent task".into(),
            },
            Node {
                name: "child".into(),
                task: "child task".into(),
            },
        ],
        edges: vec![Edge {
            from: "parent".into(),
            to: "child".into(),
            feedback: false,
        }],
    };
    let (temp, source, mut runtime) = setup(false, graph);
    workspace::remove_shadow_repo(&source).unwrap();
    runtime.approve().unwrap();
    for name in ["parent", "child"] {
        let mut job = runtime.jobs().unwrap().remove(0);
        assert_eq!(job.execution.node, name);
        attach(&mut runtime, &mut job);
        let path = Path::new(&job.execution.worktree);
        let parents: Vec<String> = runtime
            .parents(name)
            .iter()
            .filter_map(|parent| runtime.state.nodes[parent].head.clone())
            .collect();
        workspace::prepare(&source, path, &job.execution.before, &parents).unwrap();
        fs::write(path.join(format!("{name}.txt")), name).unwrap();
        let head = workspace::snapshot_node(path, &source, name).unwrap();
        runtime
            .finish(&job.execution, Ok((head, "completed".into())))
            .unwrap();
    }
    assert!(runtime.jobs().unwrap().is_empty());
    let publication = runtime.state.publication.clone().unwrap();
    let published = crate::graph_merge::merge_graph(&source, &publication.heads, || {
        Err("merge conflict".into())
    })
    .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted { head: published })
        .unwrap();
    runtime.reclaim_shadow_after_publication(&source).unwrap();
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_none());
    let child_head = runtime.state.nodes["child"].head.clone().unwrap();

    runtime.intervene("parent", "direct edit").unwrap();
    assert_eq!(runtime.state.phase, "followup");
    assert_eq!(runtime.state.nodes["child"].status, "completed");
    let mut followup = runtime.jobs().unwrap().remove(0);
    assert!(followup.source_direct);
    let script = temp.path().join("agent.sh");
    fs::write(&script, "cat >/dev/null\nprintf '%s\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    followup.config.pi_command = "/bin/sh".into();
    followup.config.pi_args = vec![script.to_string_lossy().into()];
    let result = perform(&followup, &runtime.root, &[], |_| {}, |_| Ok(()));
    runtime.finish(&followup.execution, result).unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "completed");
    assert_eq!(runtime.state.nodes["parent"].status, "completed");
    assert_eq!(runtime.state.nodes["child"].status, "completed");
    assert_eq!(
        runtime.state.nodes["child"].head.as_deref(),
        Some(child_head.as_str())
    );
    assert!(runtime.state.publication.is_some());
}

#[test]
#[cfg(feature = "fixture")]
fn standard_git_post_publication_followup_runs_in_source() {
    let (temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    let path = Path::new(&job.execution.worktree);
    workspace::prepare(&source, path, &job.execution.before, &[]).unwrap();
    fs::write(path.join("result.txt"), "v1").unwrap();
    let head = workspace::snapshot_node(path, &source, "task").unwrap();
    runtime
        .finish(&job.execution, Ok((head, "completed".into())))
        .unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    let publication = runtime.state.publication.clone().unwrap();
    let published = crate::graph_merge::merge_graph(&source, &publication.heads, || {
        Err("conflict".into())
    })
    .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted { head: published })
        .unwrap();
    let before = workspace::git(&source, &["rev-parse", "HEAD"]).unwrap();

    runtime.intervene("task", "again").unwrap();
    let mut followup = runtime.jobs().unwrap().remove(0);
    assert!(followup.source_direct);
    assert_eq!(Path::new(&followup.execution.worktree), source);
    let script = temp.path().join("agent.sh");
    fs::write(&script, "cat >/dev/null
printf '%s\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'
").unwrap();
    followup.config.pi_command = "/bin/sh".into();
    followup.config.pi_args = vec![script.to_string_lossy().into()];
    let result = perform(&followup, &runtime.root, &[], |_| {}, |_| Ok(()));
    runtime.finish(&followup.execution, result).unwrap();
    assert_eq!(
        workspace::git(&source, &["rev-parse", "HEAD"]).unwrap(),
        before
    );
    assert_eq!(
        runtime.state.executions.last().unwrap().after.as_deref(),
        Some("")
    );
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "completed");
}

#[test]
fn post_publication_planner_revision_materializes_only_on_dispatch() {
    let (_temp, source, mut runtime) = setup(false, single());
    workspace::remove_shadow_repo(&source).unwrap();
    runtime.approve().unwrap();
    let mut job = runtime.jobs().unwrap().remove(0);
    attach(&mut runtime, &mut job);
    let path = Path::new(&job.execution.worktree);
    workspace::prepare(&source, path, &job.execution.before, &[]).unwrap();
    fs::write(path.join("result.txt"), "v1").unwrap();
    let head = workspace::snapshot_node(path, &source, "task").unwrap();
    runtime
        .finish(&job.execution, Ok((head, "completed".into())))
        .unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    let publication = runtime.state.publication.clone().unwrap();
    let published = crate::graph_merge::merge_graph(&source, &publication.heads, || {
        Err("conflict".into())
    })
    .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted { head: published })
        .unwrap();
    runtime.reclaim_shadow_after_publication(&source).unwrap();
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_none());

    let mut revised = single();
    revised.nodes[0].task = "revised task".into();
    runtime
        .revise_graph(
            revised,
            PlanningSummary {
                planning_id: "revision".into(),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_none());
    let mut job = runtime.jobs().unwrap().remove(0);
    assert!(job.materialize_source);
    attach(&mut runtime, &mut job);
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_some());
    assert!(!job.execution.before.is_empty());
}

#[test]
#[cfg(feature = "fixture")]
fn post_publication_revision_with_completed_parent_ignores_stale_commit() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: vec![
            Node {
                name: "parent".into(),
                task: "parent task".into(),
            },
            Node {
                name: "child".into(),
                task: "child task".into(),
            },
        ],
        edges: vec![Edge {
            from: "parent".into(),
            to: "child".into(),
            feedback: false,
        }],
    };
    let (temp, source, mut runtime) = setup(false, graph.clone());
    workspace::remove_shadow_repo(&source).unwrap();
    runtime.approve().unwrap();
    for name in ["parent", "child"] {
        let mut job = runtime.jobs().unwrap().remove(0);
        attach(&mut runtime, &mut job);
        let path = Path::new(&job.execution.worktree);
        let parents: Vec<String> = runtime
            .parents(name)
            .iter()
            .filter_map(|parent| runtime.state.nodes[parent].head.clone())
            .collect();
        workspace::prepare(&source, path, &job.execution.before, &parents).unwrap();
        fs::write(path.join(format!("{name}.txt")), name).unwrap();
        let head = workspace::snapshot_node(path, &source, name).unwrap();
        runtime
            .finish(&job.execution, Ok((head, "completed".into())))
            .unwrap();
    }
    assert!(runtime.jobs().unwrap().is_empty());
    let publication = runtime.state.publication.clone().unwrap();
    let published = crate::graph_merge::merge_graph(&source, &publication.heads, || {
        Err("conflict".into())
    })
    .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted { head: published })
        .unwrap();
    runtime.reclaim_shadow_after_publication(&source).unwrap();
    let child_head = runtime.state.nodes["child"].head.clone().unwrap();

    // The revision adds a node after a node whose commit only existed in the
    // reclaimed snapshot. Its published content is in the fresh source
    // snapshot, so the stale parent commit must not be resolved or merged.
    let mut revised = graph;
    revised.nodes.push(Node {
        name: "late".into(),
        task: "late task".into(),
    });
    revised.edges.push(Edge {
        from: "child".into(),
        to: "late".into(),
        feedback: false,
    });
    runtime
        .revise_graph(
            revised,
            PlanningSummary {
                planning_id: "revision-after-publication".into(),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_none());
    let mut job = runtime.jobs().unwrap().remove(0);
    assert_eq!(job.execution.node, "late");
    assert!(job.materialize_source);
    assert_eq!(job.parent_heads, vec![child_head.clone()]);
    attach(&mut runtime, &mut job);
    let fresh = job.expected_source_head.clone();
    assert!(!fresh.is_empty());
    assert_ne!(fresh, child_head);

    let script = temp.path().join("agent.sh");
    fs::write(
        &script,
        "cat >/dev/null\nprintf late > late.txt\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n",
    )
    .unwrap();
    job.config.pi_command = "/bin/sh".into();
    job.config.pi_args = vec![script.to_string_lossy().into()];
    let result = perform(
        &job,
        &runtime.root,
        &runtime.parents("late"),
        |_| {},
        |_| Ok(()),
    );
    let (head, _) = result.expect("a stale parent commit must not block the rebaseline");
    let worktree = Path::new(&job.execution.worktree).to_path_buf();
    runtime
        .finish(&job.execution, Ok((head, "completed".into())))
        .unwrap();
    assert_eq!(runtime.state.nodes["late"].status, "completed");
    assert_eq!(fs::read_to_string(worktree.join("late.txt")).unwrap(), "late");
    assert_eq!(fs::read_to_string(worktree.join("child.txt")).unwrap(), "child");
}

#[test]
fn mid_run_completed_node_message_keeps_worktree_semantics() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: vec![
            Node {
                name: "parent".into(),
                task: "parent".into(),
            },
            Node {
                name: "child".into(),
                task: "child".into(),
            },
        ],
        edges: vec![Edge {
            from: "parent".into(),
            to: "child".into(),
            feedback: false,
        }],
    };
    let (_temp, source, mut runtime) = setup(false, graph);
    workspace::remove_shadow_repo(&source).unwrap();
    runtime.approve().unwrap();
    let mut parent = runtime.jobs().unwrap().remove(0);
    attach(&mut runtime, &mut parent);
    let path = Path::new(&parent.execution.worktree);
    workspace::prepare(&source, path, &parent.execution.before, &[]).unwrap();
    fs::write(path.join("parent.txt"), "parent").unwrap();
    let head = workspace::snapshot_node(path, &source, "parent").unwrap();
    runtime
        .finish(&parent.execution, Ok((head, "completed".into())))
        .unwrap();
    // The Run is still executing, so a completed-node message keeps worktree
    // (and downstream invalidation) semantics instead of source-direct editing.
    assert_ne!(runtime.state.phase, "completed");
    runtime.intervene("parent", "again").unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(!retry.source_direct);
    assert_ne!(Path::new(&retry.execution.worktree), source);
}

#[test]
fn failed_node_intervention_resumes_running_phase_and_clears_needs_attention() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    runtime.finish(&job.execution, Err("Model error".into())).unwrap();
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.phase, "needs_attention");
    assert_eq!(runtime.state.nodes["task"].status, "failed");

    // Intervening sets the node to dirty and transitions phase to running
    runtime.intervene("task", "retry please").unwrap();
    assert_eq!(runtime.state.nodes["task"].status, "dirty");
    assert_eq!(runtime.state.phase, "running");

    // When the job is dispatched, Started is emitted and phase remains running
    let retry_job = runtime.jobs().unwrap().remove(0);
    assert_eq!(runtime.state.nodes["task"].status, "running");
    assert_eq!(runtime.state.phase, "running");

    // If phase somehow stayed needs_attention before Started or Steered, verify they clear it
    runtime.state.phase = "needs_attention".into();
    runtime.emit(EventKind::Started { execution: retry_job.execution.clone(), message_sequences: None }).unwrap();
    assert_eq!(runtime.state.phase, "running");

    runtime.state.phase = "needs_attention".into();
    runtime.emit(EventKind::Steered {
        execution_id: retry_job.execution.id.clone(),
        node: "task".into(),
        instruction: "steer msg".into(),
        images: None,
    }).unwrap();
    assert_eq!(runtime.state.phase, "running");

    runtime.state.phase = "needs_attention".into();
    let merger_exec = Execution {
        id: "merger-1".into(),
        node: "merge:task".into(),
        revision: 1,
        attempt: 1,
        session_id: "s1".into(),
        worktree: "w1".into(),
        before: String::new(),
        workspace_lineage: vec![],
        after: None,
        input: None,
        result: None,
        status: "running".into(),
        output: String::new(),
        output_bytes: 0,
        pid: None,
        started_at: 0,
        completed_at: None,
        metrics: None,
    };
    runtime.emit(EventKind::MergerStarted { execution: merger_exec }).unwrap();
    assert_eq!(runtime.state.phase, "running");
}
