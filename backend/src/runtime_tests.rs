use super::*;
use tempfile::TempDir;

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
    runtime.create(graph, config).unwrap();
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
        let job = runtime.jobs().unwrap().remove(0);
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
        assert_eq!(crate::snapshot_view::snapshot_metadata(&replay).unwrap()["planType"], "graph");
        if !standard_git {
            fs::remove_dir_all(workspace::shadow_repo_dir(&source)).unwrap();
        }
    }
}

#[test]
fn planner_revision_keeps_approval_and_unaffected_node_results() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: ["keep", "change", "child"].into_iter().map(|name| Node { name: name.into(), task: name.into() }).collect(),
        edges: vec![Edge { from: "change".into(), to: "child".into(), relation: "files".into(), feedback: false }],
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
        runtime.finish(&job.execution, Ok((head, "done".into()))).unwrap();
    }
    // Both roots finished while child has not started.
    let keep_head = runtime.state.nodes["keep"].head.clone();
    let mut revised = graph;
    revised.nodes.iter_mut().find(|node| node.name == "change").unwrap().task = "new task".into();
    revised.nodes.push(Node { name: "added".into(), task: "new node".into() });
    let planning = PlanningSummary { planning_id: "revision-1".into(), ..Default::default() };
    runtime.revise_graph(revised, planning).unwrap();
    assert_eq!(runtime.state.run_id, run_id);
    assert_eq!(runtime.state.base, base);
    assert!(runtime.state.approved);
    assert_eq!(runtime.state.nodes["keep"].status, "done");
    assert_eq!(runtime.state.nodes["keep"].head, keep_head);
    assert_eq!(runtime.state.nodes["change"].status, "dirty");
    assert_eq!(runtime.state.nodes["child"].status, "dirty");
    assert_eq!(runtime.state.nodes["added"].status, "waiting");
    let replay = runtime.store.load(&run_id).unwrap();
    assert_eq!(replay.nodes["keep"].head, keep_head);
    assert_eq!(replay.nodes["child"].status, "dirty");
    assert_eq!(replay.planning_id.as_deref(), Some("revision-1"));
    let jobs = runtime.jobs().unwrap();
    assert!(jobs.iter().all(|job| job.execution.node != "keep" && job.execution.node != "child"));
}

#[test]
fn graph_revision_invalidates_only_nodes_with_new_inputs() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: ["source", "other", "consumer"].into_iter().map(|name| Node { name: name.into(), task: name.into() }).collect(),
        edges: vec![],
    };
    let (_temp, _source, mut runtime) = setup(true, graph.clone());
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    for job in jobs {
        runtime.emit(EventKind::Finished { execution_id: job.execution.id, head: runtime.state.base.clone(), output: "done".into() }).unwrap();
    }
    let mut revised = graph;
    revised.edges.push(Edge { from: "source".into(), to: "consumer".into(), relation: "new input".into(), feedback: false });
    runtime.revise_graph(revised, PlanningSummary { planning_id: "new-edge".into(), ..Default::default() }).unwrap();
    assert_eq!(runtime.state.nodes["source"].status, "done");
    assert_eq!(runtime.state.nodes["other"].status, "done");
    assert_eq!(runtime.state.nodes["consumer"].status, "dirty");
    assert_eq!(runtime.state.nodes["consumer"].head, None);
    assert_eq!(runtime.jobs().unwrap().iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(), vec!["consumer"]);
}

#[test]
fn shadow_prepare_refuses_user_edits_after_approval() {
    let (_temp, source, mut runtime) = setup(false, single());
    runtime.approve().unwrap();
    let base = runtime.state.base.clone();
    let job = runtime.jobs().unwrap().remove(0);
    let node = Path::new(&job.execution.worktree);
    fs::write(source.join("tracked.txt"), "edited after approval").unwrap();
    let error = workspace::prepare(&source, node, &base, &[]).unwrap_err();
    assert!(error.contains("changed after approval"));
    assert!(!node.exists());
    assert_eq!(workspace::repository_git(&source, &["rev-parse", "HEAD"]).unwrap(), base);
    fs::write(source.join("tracked.txt"), "original").unwrap();
    workspace::prepare(&source, node, &base, &[]).unwrap();
}

#[test]
fn completed_shadow_graph_intervention_reruns_target_and_downstream_without_rebasing() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: vec![
            Node { name: "parent".into(), task: "parent task".into() },
            Node { name: "child".into(), task: "child task".into() },
        ],
        edges: vec![Edge { from: "parent".into(), to: "child".into(), relation: "files".into(), feedback: false }],
    };
    let (_temp, source, mut runtime) = setup(false, graph);
    runtime.approve().unwrap();
    let base = runtime.state.base.clone();
    for name in ["parent", "child"] {
        let job = runtime.jobs().unwrap().remove(0);
        let path = Path::new(&job.execution.worktree);
        workspace::prepare(&source, path, &job.execution.before, &runtime.parents(name)).unwrap();
        fs::write(path.join(format!("{name}.txt")), name).unwrap();
        let head = workspace::snapshot_node(path, &source, name).unwrap();
        runtime.finish(&job.execution, Ok((head, "done".into()))).unwrap();
    }
    runtime.jobs().unwrap();
    let publication = runtime.state.publication.clone().unwrap();
    let published = crate::graph_merge::merge_graph(&source, &publication.heads, || Err("merge conflict".into())).unwrap();
    runtime.emit(EventKind::PublicationCompleted { head: published.clone() }).unwrap();
    assert_ne!(published, base);
    fs::write(source.join("tracked.txt"), "external edit").unwrap();
    assert!(runtime.intervene("parent", "new instruction").unwrap_err().contains("changed after approval"));
    assert_eq!(runtime.state.nodes["parent"].status, "done");
    fs::write(source.join("tracked.txt"), "original").unwrap();
    runtime.intervene("parent", "new instruction").unwrap();
    assert_eq!(runtime.state.nodes["parent"].status, "dirty");
    assert_eq!(runtime.state.nodes["child"].status, "dirty");
    assert!(runtime.state.nodes["child"].head.is_none());
    assert_eq!(runtime.state.base, base);
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(replay.published_head.as_deref(), Some(published.as_str()));
    let job = runtime.jobs().unwrap().remove(0);
    assert_eq!(job.execution.node, "parent");
    assert_eq!(job.expected_source_head, published);
    let path = Path::new(&job.execution.worktree);
    workspace::prepare_with_merger_expected(&source, path, &job.execution.before, &[], &job.expected_source_head, || Err("merge conflict".into())).unwrap();
    fs::write(source.join("tracked.txt"), "external edit").unwrap();
    let next = source.parent().unwrap().join("another-worktree");
    assert!(workspace::prepare_with_merger_expected(&source, &next, &base, &[], &job.expected_source_head, || Err("merge conflict".into())).unwrap_err().contains("changed after approval"));
    fs::remove_dir_all(workspace::shadow_repo_dir(&source)).unwrap();
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
            relation: "files".into(),
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
    assert_ne!(child.execution.worktree, parent.execution.worktree);
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
        let base = runtime.state.base.clone();
        for (name, text) in [("left", "left\n"), ("right", "right\n")] {
            let path = source.parent().unwrap().join(format!("{name}-workspace"));
            workspace::prepare(&source, &path, &base, &[]).unwrap();
            fs::write(path.join("tracked.txt"), text).unwrap();
            workspace::snapshot_node(&path, &source, name).unwrap();
        }
        let target = source.parent().unwrap().join("fan-in");
        let mut calls = 0;
        let head = workspace::prepare_with_merger(
            &source, &target, &base, &["left".into(), "right".into()], || {
                calls += 1;
                assert!(workspace::git(&target, &["rev-parse", "MERGE_HEAD"]).is_ok());
                fs::write(target.join("tracked.txt"), "left and right\n").unwrap();
                workspace::git(&target, &["add", "-A"]).unwrap();
                workspace::git(&target, &["commit", "--no-edit"]).unwrap();
                Ok(())
            },
        ).unwrap();
        assert_eq!(calls, 1);
        for name in ["left", "right"] {
            workspace::git(&target, &["merge-base", "--is-ancestor", &format!("refs/grapher/parents/{name}"), &head]).unwrap();
        }
        assert_eq!(fs::read_to_string(target.join("tracked.txt")).unwrap(), "left and right\n");
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
    let error = workspace::prepare_with_merger(&source, &target, &base, &["a".into(), "b".into()], || {
        Err("resolver unavailable".into())
    }).unwrap_err();
    assert!(error.starts_with("Workspace composition blocked"));
    assert!(error.contains("resolver unavailable"));
    assert!(workspace::git(&target, &["rev-parse", "MERGE_HEAD"]).is_ok());
    assert!(!workspace::git(&target, &["diff", "--name-only", "--diff-filter=U"]).unwrap().is_empty());
}

#[test]
fn node_merger_events_do_not_enter_publication_phase() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let mut merger = runtime.jobs().unwrap().remove(0).execution;
    merger.id = Uuid::new_v4().to_string();
    merger.node = "merge:task".into();
    runtime.emit(EventKind::MergerStarted { execution: merger.clone() }).unwrap();
    assert_eq!(runtime.state.phase, "running");
    runtime.emit(EventKind::MergerFinished { execution_id: merger.id, head: runtime.state.base.clone() }).unwrap();
    assert_eq!(runtime.state.phase, "running");
    assert!(runtime.state.publication.is_none());
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
    runtime.emit(EventKind::Failed { node: job.execution.node, execution_id: Some(job.execution.id), error: "test".into() }).unwrap();
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
    assert_eq!(workspace::git(&moved, &["rev-parse", "HEAD"]).unwrap(), before);
    assert_eq!(fs::read_to_string(moved.join("planner.txt")).unwrap(), "retain planner work");
    assert!(!source.exists());
}

#[test]
fn moved_binding_blocks_scheduling_resume_intervention_and_publication() {
    let (temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    fs::rename(&source, temp.path().join("moved")).unwrap();
    assert!(runtime.jobs().err().unwrap().contains("项目绑定已失效"));
    assert!(runtime.state.executions.is_empty());
    runtime.pause(true).unwrap();
    assert!(runtime.pause(false).unwrap_err().contains("项目绑定已失效"));
    assert!(runtime.state.paused);
    assert!(runtime.intervene("task", "retry").unwrap_err().contains("项目绑定已失效"));
    assert!(runtime.resolved("task").unwrap_err().contains("项目绑定已失效"));
    runtime.emit(EventKind::PublicationStarted { repository: source.to_string_lossy().into(), heads: vec![runtime.state.base.clone()] }).unwrap();
    runtime.emit(EventKind::PublicationFailed { error: "interrupted".into() }).unwrap();
    assert!(runtime.retry_publication().unwrap_err().contains("项目绑定已失效"));
    assert_eq!(runtime.state.phase, "publication_failed");
    assert!(crate::graph_merge::merge_graph(&source, &[], || panic!("must not launch merger"))
        .unwrap_err().contains("项目绑定已失效"));
    assert!(!source.exists());
}

#[test]
fn viewing_another_project_does_not_change_a_valid_run_binding() {
    let (temp, source, mut runtime) = setup(true, single());
    let other = temp.path().join("other");
    fs::create_dir(&other).unwrap();
    workspace::validate_binding(&other).unwrap();
    // Read-only status must not initialize Git or change the runtime binding.
    assert!(!other.join(".git").exists());
    assert!(!workspace::shadow_repo_dir(&other).exists());
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    assert_eq!(Path::new(&job.config.repository), source);
}
