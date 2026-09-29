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
                output: "done".into(),
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
            from: from.into(), to: to.into(), feedback, relation: String::new(),
        }).collect(),
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let root = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: root.execution.id, head: runtime.state.base.clone(), output: "done".into(),
    }).unwrap();
    let first = runtime.jobs().unwrap();
    assert_eq!(first.len(), 2);
    assert!(runtime.feedback_source_busy("review"));
    let fast = first.iter().find(|job| job.execution.node == "fast").unwrap();
    runtime.emit(EventKind::Finished {
        execution_id: fast.execution.id.clone(), head: runtime.state.base.clone(), output: "done".into(),
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
            from: from.into(), to: to.into(), feedback, relation: String::new(),
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
        execution_id: owner.execution.id.clone(), head: runtime.state.base.clone(), output: "done".into(),
    }).unwrap();
    let next = runtime.jobs().unwrap();
    let review = next.iter().find(|job| job.execution.node == "review").unwrap();
    runtime.emit(EventKind::Finished {
        execution_id: review.execution.id.clone(), head: runtime.state.base.clone(), output: "<REVISE>".into(),
    }).unwrap();
    assert!(runtime.feedback_source_busy("review"));
    let other = first.iter().find(|job| job.execution.node == "other").unwrap();
    runtime.emit(EventKind::Finished {
        execution_id: other.execution.id.clone(), head: runtime.state.base.clone(), output: "done".into(),
    }).unwrap();
    let jobs = runtime.jobs_with_pending_feedback(true, &["review"]).unwrap();
    assert_eq!(jobs.iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(), vec!["after_other"]);
    assert_eq!(runtime.state.nodes["consumer"].status, "waiting");
    assert_eq!(runtime.state.phase, "running");
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
fn messaging_done_node_preserves_its_result_and_running_downstream() {
    let graph = Graph {
        original_goal: "message".into(),
        nodes: ["parent", "child"].into_iter().map(|name| Node {
            name: name.into(), task: name.into(),
        }).collect(),
        edges: vec![Edge {
            from: "parent".into(), to: "child".into(), relation: String::new(), feedback: false,
        }],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let parent = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: parent.execution.id, head: runtime.state.base.clone(), output: "done".into(),
    }).unwrap();
    let child = runtime.jobs().unwrap().remove(0);
    let before = runtime.state.nodes.clone();
    let executions = runtime.state.executions.len();
    let images = Some(vec![ImageAttachment {
        r#type: "image".into(), mime_type: "image/png".into(), data: "abc".into(), name: None,
    }]);
    runtime.message_done_node("parent", "  new instruction  ", images.clone()).unwrap();
    assert_eq!(serde_json::to_value(&runtime.state.nodes).unwrap(), serde_json::to_value(before).unwrap());
    assert_eq!(runtime.state.executions.len(), executions);
    assert_eq!(runtime.state.nodes["child"].status, "running");
    assert!(runtime.jobs().unwrap().is_empty());
    let replayed = runtime.store.load(&runtime.state.run_id).unwrap();
    assert!(matches!(replayed.events.last().unwrap().kind, EventKind::NodeMessaged {
        ref node, ref instruction, images: ref saved,
    } if node == "parent" && instruction == "new instruction" &&
        serde_json::to_value(saved).unwrap() == serde_json::to_value(&images).unwrap()));
    assert!(runtime.message_done_node("child", "no", None).is_err());
    assert!(runtime.message_done_node("parent", "   ", None).is_err());
    assert_eq!(runtime.state.executions.last().unwrap().id, child.execution.id);
}

#[test]
fn message_after_run_completed_keeps_it_completed() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: job.execution.id, head: runtime.state.base.clone(), output: "done".into(),
    }).unwrap();
    runtime.emit(EventKind::Settled).unwrap();
    let head = runtime.state.nodes["task"].head.clone();
    runtime.message_done_node("task", "hello", None).unwrap();
    assert_eq!(runtime.state.phase, "completed");
    assert_eq!(runtime.state.nodes["task"].head, head);
    assert_eq!(runtime.state.nodes["task"].status, "done");
    assert_eq!(runtime.state.executions.len(), 1);
    assert!(runtime.jobs().unwrap().is_empty());
}

#[test]
fn rerun_starts_from_clean_inputs_but_intervention_continues_the_result() {
    let (_temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    let path = Path::new(&first.execution.worktree);
    workspace::prepare(&source, path, &first.execution.before, &[]).unwrap();
    fs::write(path.join("tracked.txt"), "first result").unwrap();
    let head = workspace::snapshot_node_for_run(path, &source, "task", Some(&runtime.state.run_id)).unwrap();
    runtime.emit(EventKind::Finished {
        execution_id: first.execution.id, head: head.clone(), output: "done".into(),
    }).unwrap();
    runtime.rerun("task").unwrap();
    assert_eq!(runtime.state.nodes["task"].head, None);
    let again = runtime.jobs().unwrap().remove(0);
    assert_eq!(again.execution.before, runtime.state.base);
    assert_ne!(again.execution.worktree, path.to_string_lossy());
    workspace::prepare(&source, Path::new(&again.execution.worktree), &again.execution.before, &[]).unwrap();
    assert_eq!(fs::read_to_string(Path::new(&again.execution.worktree).join("tracked.txt")).unwrap(), "original");
    runtime.emit(EventKind::Finished {
        execution_id: again.execution.id, head: head.clone(), output: "done".into(),
    }).unwrap();
    runtime.intervene("task", "continue").unwrap();
    let followup = runtime.jobs().unwrap().remove(0);
    assert_eq!(followup.execution.before, head);
}

#[test]
fn serial_followup_resumes_completed_pi_session_with_images_after_settlement() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.set_route("serial").unwrap();
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: first.execution.id.clone(), head: runtime.state.base.clone(), output: "done".into(),
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
fn editing_an_earlier_serial_turn_branches_pi_and_supersedes_later_executions() {
    let (_temp, source, mut runtime) = setup(true, single());
    runtime.set_route("serial").unwrap();
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: first.execution.id.clone(), head: runtime.state.base.clone(), output: "first".into(),
    }).unwrap();
    runtime.intervene("task", "second").unwrap();
    let second = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: second.execution.id.clone(), head: runtime.state.base.clone(), output: "second".into(),
    }).unwrap();
    runtime.intervene("task", "third").unwrap();
    let third = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: third.execution.id.clone(), head: runtime.state.base.clone(), output: "third".into(),
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
        execution_id: first.execution.id.clone(), head: runtime.state.base.clone(), output: "done".into(),
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
fn editing_graph_node_uses_earlier_checkpoint_without_rerunning_descendants() {
    let graph = Graph {
        original_goal: "graph".into(),
        nodes: ["parent", "child"].into_iter().map(|name| Node {
            name: name.into(), task: name.into(),
        }).collect(),
        edges: vec![Edge { from: "parent".into(), to: "child".into(), relation: String::new(), feedback: false }],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: first.execution.id.clone(), head: runtime.state.base.clone(), output: "first".into(),
    }).unwrap();
    let child = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: child.execution.id.clone(), head: runtime.state.base.clone(), output: "child".into(),
    }).unwrap();
    runtime.intervene("parent", "later").unwrap();
    let later = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: later.execution.id.clone(), head: runtime.state.base.clone(), output: "later".into(),
    }).unwrap();
    assert_eq!(runtime.state.nodes["child"].status, "done", "a follow-up does not restart its child");
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
    assert_eq!(runtime.state.nodes["child"].status, "done");
    assert!(runtime.state.superseded_execution_ids.contains(&first.execution.id));
    assert!(!runtime.state.superseded_execution_ids.contains(&child.execution.id));
    assert!(runtime.state.superseded_execution_ids.contains(&later.execution.id));
    let new_job = runtime.jobs().unwrap().remove(0);
    assert_eq!(new_job.execution.worktree, first.execution.worktree);
    assert_eq!(new_job.execution.before, first.execution.before);
    assert_eq!(new_job.task, "edited parent");
}

#[test]
fn graph_followup_only_continues_the_target_conversation() {
    let graph = Graph {
        original_goal: "graph".into(),
        nodes: ["parent", "child", "independent"].into_iter().map(|name| Node {
            name: name.into(), task: name.into(),
        }).collect(),
        edges: vec![Edge { from: "parent".into(), to: "child".into(), relation: String::new(), feedback: false }],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap();
    for job in &first {
        runtime.emit(EventKind::Finished {
            execution_id: job.execution.id.clone(), head: runtime.state.base.clone(), output: "done".into(),
        }).unwrap();
    }
    let child = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: child.execution.id, head: runtime.state.base.clone(), output: "done".into(),
    }).unwrap();
    runtime.intervene("parent", "continue parent").unwrap();
    assert_eq!(runtime.state.nodes["parent"].status, "dirty");
    assert_eq!(runtime.state.nodes["child"].status, "done");
    assert_eq!(runtime.state.nodes["independent"].status, "done");
    let next = runtime.jobs().unwrap().remove(0);
    assert_eq!(next.execution.node, "parent");
    assert_eq!(next.task, "continue parent");
    assert!(next.resume_execution_id.is_some());
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
        error: "Workspace composition blocked".into(),
    }).unwrap();
    runtime.emit(EventKind::Blocked { node: "task".into(), error: "Resolve".into() }).unwrap();
    runtime.resolved("task").unwrap();
    assert_eq!(runtime.state.executions[0].status, "resolved");
    assert_eq!(runtime.state.executions[0].after, None);
    assert_eq!(runtime.state.nodes["task"].status, "dirty");
    let head = runtime.state.nodes["task"].head.clone().unwrap();
    let replayed = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(replayed.executions[0].status, "resolved");
    assert_eq!(replayed.nodes["task"].status, "dirty");
    assert_eq!(runtime.jobs().unwrap().remove(0).execution.before, head);
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
            relation: "files".into(),
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
            .finish(&job.execution, Ok((head, "done".into())))
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
    assert_eq!(runtime.state.nodes["keep"].status, "done");
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
            output: "done".into(),
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
            relation: String::new(),
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
            error: "failed".into(),
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
            relation: "existing input".into(),
            feedback: false,
        }],
    };
    let (_temp, _source, mut runtime) = setup(true, graph.clone());
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    for job in jobs {
        runtime
            .emit(EventKind::Finished {
                execution_id: job.execution.id,
                head: runtime.state.base.clone(),
                output: "done".into(),
            })
            .unwrap();
    }
    // The consumer has actually executed, so changing its input invalidates its result.
    for job in runtime.jobs().unwrap() {
        runtime
            .emit(EventKind::Finished {
                execution_id: job.execution.id,
                head: runtime.state.base.clone(),
                output: "done".into(),
            })
            .unwrap();
    }
    let mut revised = graph;
    revised.edges.push(Edge {
        from: "source".into(),
        to: "consumer".into(),
        relation: "new input".into(),
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
    assert_eq!(runtime.state.nodes["source"].status, "done");
    assert_eq!(runtime.state.nodes["other"].status, "done");
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
    assert_eq!(
        workspace::repository_git(&source, &["rev-parse", "HEAD"]).unwrap(),
        base
    );
    fs::write(source.join("tracked.txt"), "original").unwrap();
    workspace::prepare(&source, node, &base, &[]).unwrap();
}

#[test]
fn completed_shadow_graph_intervention_reruns_target_and_downstream_without_rebasing() {
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
    let (_temp, source, mut runtime) = setup(false, graph);
    runtime.approve().unwrap();
    let base = runtime.state.base.clone();
    for name in ["parent", "child"] {
        let job = runtime.jobs().unwrap().remove(0);
        let path = Path::new(&job.execution.worktree);
        workspace::prepare(&source, path, &job.execution.before, &runtime.parents(name)).unwrap();
        fs::write(path.join(format!("{name}.txt")), name).unwrap();
        let head = workspace::snapshot_node(path, &source, name).unwrap();
        runtime
            .finish(&job.execution, Ok((head, "done".into())))
            .unwrap();
    }
    runtime.jobs().unwrap();
    let publication = runtime.state.publication.clone().unwrap();
    let published = crate::graph_merge::merge_graph(&source, &publication.heads, || {
        Err("merge conflict".into())
    })
    .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted {
            head: published.clone(),
        })
        .unwrap();
    assert_ne!(published, base);
    fs::write(source.join("tracked.txt"), "external edit").unwrap();
    assert!(runtime
        .rerun("parent")
        .unwrap_err()
        .contains("changed after approval"));
    assert_eq!(runtime.state.nodes["parent"].status, "done");
    fs::write(source.join("tracked.txt"), "original").unwrap();
    runtime.rerun("parent").unwrap();
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
    workspace::prepare_with_merger_expected(
        &source,
        path,
        &job.execution.before,
        &[],
        &job.expected_source_head,
        || Err("merge conflict".into()),
    )
    .unwrap();
    fs::write(source.join("tracked.txt"), "external edit").unwrap();
    let next = source.parent().unwrap().join("another-worktree");
    assert!(workspace::prepare_with_merger_expected(
        &source,
        &next,
        &base,
        &[],
        &job.expected_source_head,
        || Err("merge conflict".into())
    )
    .unwrap_err()
    .contains("changed after approval"));
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
            head: runtime.state.base.clone(),
        })
        .unwrap();
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
    runtime
        .emit(EventKind::Failed {
            node: job.execution.node,
            execution_id: Some(job.execution.id),
            error: "test".into(),
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
fn moved_binding_blocks_scheduling_resume_intervention_and_publication() {
    let (temp, source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    fs::rename(&source, temp.path().join("moved")).unwrap();
    assert!(runtime.jobs().err().unwrap().contains("项目绑定已失效"));
    assert!(runtime.state.executions.is_empty());
    runtime.pause(true).unwrap();
    assert!(runtime.pause(false).unwrap_err().contains("项目绑定已失效"));
    assert!(runtime.state.paused);
    assert!(runtime
        .rerun("task")
        .unwrap_err()
        .contains("项目绑定已失效"));
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
