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
