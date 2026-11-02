use super::*;

fn chain() -> Graph {
    Graph {
        original_goal: "manual graph".into(),
        nodes: ["up", "target", "child", "keep"].into_iter()
            .map(|name| Node { name: name.into(), task: format!("task {name}") }).collect(),
        edges: [("up", "target"), ("target", "child")].into_iter()
            .map(|(from, to)| Edge { from: from.into(), to: to.into(), feedback: false }).collect(),
    }
}

fn request(from: Option<&str>, to: Option<&str>, feedback: bool) -> ManualNodeRequest {
    ManualNodeRequest {
        node: Node { name: "new".into(), task: "new task".into() },
        from: from.map(str::to_string), to: to.map(str::to_string), feedback,
        confirmed_completed: Vec::new(),
    }
}

fn confirmed(runtime: &Runtime, names: &[&str]) -> Vec<ManualNodeConfirmation> {
    names.iter().map(|name| {
        let node = &runtime.state.nodes[*name];
        ManualNodeConfirmation { name: (*name).into(), revision: node.revision, head: node.head.clone() }
    }).collect()
}

fn completed_chain() -> (tempfile::TempDir, PathBuf, Runtime) {
    let (temp, source, mut runtime) = setup(true, chain());
    runtime.emit(EventKind::GraphRevised {
        graph: chain(), planning_id: "existing-planner".into(),
        planning: PlanningSummary { planning_id: "existing-planner".into(), ..Default::default() },
        invalidated: vec![], source_head: None,
    }).unwrap();
    runtime.approve().unwrap();
    for _ in 0..3 {
        let jobs = runtime.jobs().unwrap();
        assert!(!jobs.is_empty());
        for job in jobs {
            let name = &job.execution.node;
            let path = Path::new(&job.execution.worktree);
            workspace::prepare(&source, path, &job.execution.before, &runtime.parents(name)).unwrap();
            fs::write(path.join(format!("{name}.txt")), name).unwrap();
            let head = workspace::snapshot_node(path, &source, name).unwrap();
            runtime.finish(&job.execution, Ok((head, "completed".into()))).unwrap();
        }
    }
    assert!(runtime.state.nodes.values().all(|node| node.status == "completed"));
    (temp, source, runtime)
}

#[test]
fn manual_node_draft_validates_atomically_and_replays() {
    let (_temp, _source, mut runtime) = setup(true, chain());
    let run_id = runtime.state.run_id.clone();
    let mut bad = request(None, None, false);
    bad.node.name = "UP".into();
    assert!(runtime.add_manual_node(bad).unwrap_err().contains("E202"));
    assert_eq!(runtime.state.graph, chain());
    assert!(runtime.add_manual_node(request(None, None, true)).is_err());
    assert!(runtime.add_manual_node(request(None, Some("target"), true)).is_err(),
        "feedback targets must be dependency ancestors");
    assert_eq!(runtime.state.graph, chain());
    runtime.add_manual_node(request(Some("up"), Some("target"), false)).unwrap();
    assert!(!runtime.state.approved);
    assert_eq!(runtime.state.phase, "awaiting_approval");
    assert_eq!(runtime.state.nodes["new"].status, "waiting");
    assert!(!runtime.state.graph.edges.iter().any(|edge| edge.from == "up" && edge.to == "target"));
    assert_eq!(runtime.store.load(&run_id).unwrap().graph, runtime.state.graph);
}

#[test]
fn manual_node_confirmed_insertion_invalidates_only_dependents_and_replays() {
    let (_temp, _source, mut runtime) = completed_chain();
    let run_id = runtime.state.run_id.clone();
    let keep = runtime.state.nodes["keep"].head.clone();
    let up = runtime.state.nodes["up"].head.clone();
    let mut add = request(Some("up"), Some("target"), false);
    let event_count = runtime.state.events.len();
    assert!(runtime.add_manual_node(add.clone()).unwrap_err().contains("confirmation"));
    add.confirmed_completed = confirmed(&runtime, &["target"]);
    assert!(runtime.add_manual_node(add.clone()).is_err(), "downstream completion also needs confirmation");
    add.confirmed_completed = confirmed(&runtime, &["target", "child"]);
    add.confirmed_completed[0].revision += 1;
    assert!(runtime.add_manual_node(add.clone()).is_err(), "stale confirmations cannot authorize another result");
    assert_eq!(runtime.state.events.len(), event_count);
    add.confirmed_completed = confirmed(&runtime, &["target", "child"]);
    runtime.add_manual_node(add).unwrap();
    assert_eq!(runtime.state.nodes["new"].status, "waiting");
    assert_eq!(runtime.state.nodes["target"].status, "dirty");
    assert_eq!(runtime.state.nodes["child"].status, "dirty");
    assert_eq!(runtime.state.nodes["keep"].head, keep);
    assert_eq!(runtime.state.nodes["up"].head, up);
    assert_eq!(runtime.state.planning_id.as_deref(), Some("existing-planner"));
    assert_eq!(runtime.state.phase, "running");
    let replay = runtime.store.load(&run_id).unwrap();
    assert_eq!(replay.graph, runtime.state.graph);
    assert_eq!(replay.nodes["target"].status, "dirty");
    assert_eq!(replay.nodes["keep"].head, keep);
    assert_eq!(replay.planning_id.as_deref(), Some("existing-planner"));
    assert_eq!(runtime.jobs().unwrap().iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(), vec!["new"]);
}

#[test]
fn manual_node_after_review_awaits_approval_without_resetting_completed_work() {
    let (_temp, _source, mut runtime) = completed_chain();
    runtime.emit(EventKind::PlannerReviewFinished {
        planning: PlanningSummary { planning_id: "review".into(), ..Default::default() },
        approval_required: true,
    }).unwrap();
    let keep_head = runtime.state.nodes["keep"].head.clone();
    let up_head = runtime.state.nodes["up"].head.clone();
    let mut add = request(Some("up"), Some("target"), false);
    add.confirmed_completed = confirmed(&runtime, &["target", "child"]);
    runtime.add_manual_node(add).unwrap();
    assert!(!runtime.state.approved);
    assert_eq!(runtime.state.phase, "awaiting_approval");
    assert_eq!(runtime.state.nodes["keep"].status, "completed");
    assert_eq!(runtime.state.nodes["keep"].head, keep_head);
    assert_eq!(runtime.state.nodes["up"].head, up_head);
    assert_eq!(runtime.state.nodes["target"].status, "dirty");
    assert_eq!(runtime.state.nodes["child"].status, "dirty");
    assert_eq!(runtime.state.nodes["new"].status, "waiting");
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    assert!(!replay.approved);
    assert_eq!(replay.nodes["keep"].head, keep_head);
    assert_eq!(replay.nodes["target"].status, "dirty");
}

#[test]
fn manual_node_feedback_warns_but_does_not_invalidate_until_verdict_and_keeps_pause() {
    let (_temp, _source, mut runtime) = completed_chain();
    runtime.pause(true).unwrap();
    let mut add = request(Some("child"), Some("target"), true);
    assert!(runtime.add_manual_node(add.clone()).unwrap_err().contains("confirmation"));
    add.confirmed_completed = confirmed(&runtime, &["target", "child"]);
    runtime.add_manual_node(add).unwrap();
    assert!(runtime.state.paused);
    assert_eq!(runtime.state.phase, "paused");
    assert_eq!(runtime.state.nodes["target"].status, "completed");
    assert_eq!(runtime.state.nodes["child"].status, "completed");
    assert!(runtime.state.graph.edges.iter().any(|edge| edge.from == "new" && edge.to == "target" && edge.feedback));
    assert!(runtime.jobs().unwrap().is_empty());
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    assert!(replay.paused);
    assert_eq!(replay.nodes["target"].status, "completed");
}

#[test]
fn manual_node_rejects_affected_running_writers_but_allows_unrelated_work() {
    let (_temp, _source, mut runtime) = setup(true, chain());
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    assert!(jobs.iter().any(|job| job.execution.node == "up"));
    assert!(runtime.add_manual_node(request(None, Some("target"), false)).is_ok(),
        "a waiting target can acquire a new dependency while unrelated roots run");
    let mut other = request(None, Some("up"), false);
    other.node.name = "other".into();
    let before = runtime.state.graph.clone();
    assert!(runtime.add_manual_node(other).unwrap_err().contains("running"));
    assert_eq!(runtime.state.graph, before);
}

#[test]
#[cfg(feature = "fixture")]
fn manual_node_after_plain_folder_publication_uses_fresh_source_when_shadow_was_reclaimed() {
    let (temp, source, mut runtime) = setup(false, single());
    workspace::remove_shadow_repo(&source).unwrap();
    runtime.approve().unwrap();
    let mut initial = runtime.jobs().unwrap().remove(0);
    attach(&mut runtime, &mut initial);
    let path = Path::new(&initial.execution.worktree);
    workspace::prepare(&source, path, &initial.execution.before, &[]).unwrap();
    fs::write(path.join("published.txt"), "published").unwrap();
    let head = workspace::snapshot_node(path, &source, "task").unwrap();
    runtime.finish(&initial.execution, Ok((head, "completed".into()))).unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    let publication = runtime.state.publication.clone().unwrap();
    let head = crate::graph_merge::merge_graph(&source, &publication.heads, || Err("conflict".into())).unwrap();
    runtime.emit(EventKind::PublicationCompleted { head }).unwrap();
    runtime.reclaim_shadow(&source).unwrap();
    fs::write(source.join("user-edit.txt"), "current").unwrap();

    runtime.add_manual_node(request(Some("task"), None, false)).unwrap();
    assert!(workspace::shadow_repo_if_exists(&source).unwrap().is_none());
    let mut job = runtime.jobs().unwrap().remove(0);
    assert_eq!(job.execution.node, "new");
    assert!(job.materialize_source);
    attach(&mut runtime, &mut job);
    let script = temp.path().join("manual-node.sh");
    fs::write(&script, "cat >/dev/null\ntest -f published.txt && test \"$(cat user-edit.txt)\" = current || exit 1\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Completed\"}]}}'\n").unwrap();
    job.config.pi_command = "/bin/sh".into();
    job.config.pi_args = vec![script.to_string_lossy().into()];
    let result = perform(&job, &runtime.root, &runtime.parents("new"), |_| {}, |_| Ok(()));
    let (head, output) = result.expect("reclaimed parent snapshots must not hide published or current source files");
    runtime.finish(&job.execution, Ok((head, output))).unwrap();
    assert_eq!(runtime.state.nodes["new"].status, "completed");
}

#[test]
fn manual_node_never_races_a_running_published_result() {
    let (_temp, _source, mut runtime) = setup(true, chain());
    runtime.approve().unwrap();
    let input = crate::environment::CompositeResult {
        domain: crate::environment::Domain {
            platform: "test".into(), arch: "test".into(), baseline: "base".into(),
            policy: "test".into(), contract: "test".into(),
        },
        code_ref: "code".into(), environment_ref: "env".into(), launch_ref: "launch".into(),
        resource_refs: vec![], layout: None, generation: "generation".into(),
        selected_from: vec![], inheritance: None,
    };
    runtime.emit(EventKind::ResultExecutionStarted { input, args: vec![] }).unwrap();
    let graph = runtime.state.graph.clone();
    let events = runtime.state.events.len();
    assert!(runtime.add_manual_node(request(None, None, false)).unwrap_err().contains("published result"));
    assert_eq!(runtime.state.phase, "launching_result");
    assert_eq!(runtime.state.graph, graph);
    assert_eq!(runtime.state.events.len(), events);
    // A writer's durable status is authoritative even if another operation
    // or an old checkpoint left the phase stale.
    runtime.state.phase = "completed".into();
    assert!(runtime.add_manual_node(request(None, None, false)).unwrap_err().contains("published result"));
    assert_eq!(runtime.state.graph, graph);
}

#[test]
fn manual_node_never_interrupts_a_paused_source_direct_recovery() {
    let (_temp, _source, mut runtime) = setup(true, chain());
    runtime.approve().unwrap();
    runtime.pause(true).unwrap();
    runtime.state.nodes.get_mut("up").unwrap().source_direct_recovery = true;
    let before = runtime.state.graph.clone();
    assert!(runtime.add_manual_node(request(None, None, false)).unwrap_err().contains("follow-up"));
    assert_eq!(runtime.state.graph, before);
    assert!(runtime.state.paused);
}
