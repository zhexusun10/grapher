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
fn missing_source_binding_can_reset_but_does_not_authorize_directory_deletion() {
    let (temp, source, mut runtime) = setup(true, single());
    let retained = temp.path().join(".grapher-worktrees").join(&runtime.state.run_id);
    fs::create_dir_all(&retained).unwrap();
    fs::write(retained.join("marker"), "retained").unwrap();
    fs::rename(&source, temp.path().join("moved-source")).unwrap();
    runtime.reset_workspace().unwrap();
    assert_eq!(fs::read_to_string(retained.join("marker")).unwrap(), "retained");
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
                output: "done".into(), output_bytes: 0, metrics: None,
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
        execution_id: root.execution.id, head: runtime.state.base.clone(), output: "done".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    let first = runtime.jobs().unwrap();
    assert_eq!(first.len(), 2);
    assert!(runtime.feedback_source_busy("review"));
    let fast = first.iter().find(|job| job.execution.node == "fast").unwrap();
    runtime.emit(EventKind::Finished {
        execution_id: fast.execution.id.clone(), head: runtime.state.base.clone(), output: "done".into(), output_bytes: 0, metrics: None,
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
        execution_id: owner.execution.id.clone(), head: runtime.state.base.clone(), output: "done".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    let next = runtime.jobs().unwrap();
    let review = next.iter().find(|job| job.execution.node == "review").unwrap();
    runtime.emit(EventKind::Finished {
        execution_id: review.execution.id.clone(), head: runtime.state.base.clone(), output: "<FEEDBACK>".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    assert!(runtime.feedback_source_busy("review"));
    let other = first.iter().find(|job| job.execution.node == "other").unwrap();
    runtime.emit(EventKind::Finished {
        execution_id: other.execution.id.clone(), head: runtime.state.base.clone(), output: "done".into(), output_bytes: 0, metrics: None,
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
        execution_id: parent.execution.id, head: runtime.state.base.clone(), output: "done".into(), output_bytes: 0, metrics: None,
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
        execution_id: job.execution.id, head: runtime.state.base.clone(), output: "done".into(), output_bytes: 0, metrics: None,
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
        execution_id: first.execution.id, head: head.clone(), output: "done".into(), output_bytes: 0, metrics: None,
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
        execution_id: first.execution.id.clone(), head: runtime.state.base.clone(), output: "done".into(), output_bytes: 0, metrics: None,
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
            assert_eq!(runtime.state.nodes["task"].status, "done");
        }
    }
}

#[test]
fn messaging_a_failed_followup_keeps_the_original_session_and_last_result() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    let head = runtime.state.base.clone();
    runtime.finish(&first.execution, Ok((head.clone(), "done".into()))).unwrap();
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
        execution_id: first.execution.id.clone(), head: runtime.state.base.clone(), output: "done".into(), output_bytes: 0, metrics: None,
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
        edges: vec![Edge { from: "parent".into(), to: "child".into(), relation: String::new(), feedback: false }],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
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
    assert_eq!(runtime.state.nodes["child"].status, "done");
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
    assert_eq!(runtime.state.nodes["child"].status, "done");
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

#[test]
fn graph_followup_propagates_only_when_the_result_changes() {
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
            execution_id: job.execution.id.clone(), head: runtime.state.base.clone(), output: "done".into(), output_bytes: 0, metrics: None,
        }).unwrap();
    }
    let child = runtime.jobs().unwrap().remove(0);
    runtime.emit(EventKind::Finished {
        execution_id: child.execution.id, head: runtime.state.base.clone(), output: "done".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    runtime.intervene("parent", "continue parent").unwrap();
    assert_eq!(runtime.state.nodes["parent"].status, "dirty");
    // Unchanged until the follow-up actually produces a new result.
    assert_eq!(runtime.state.nodes["child"].status, "done");
    assert_eq!(runtime.state.nodes["independent"].status, "done");
    let next = runtime.jobs().unwrap().remove(0);
    assert_eq!(next.execution.node, "parent");
    assert_eq!(next.task, "continue parent");
    assert!(next.resume_execution_id.is_some());
    runtime.emit(EventKind::Finished {
        execution_id: next.execution.id.clone(), head: "changed-parent".into(), output: "done".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    assert_eq!(runtime.state.nodes["parent"].status, "done");
    assert_eq!(runtime.state.nodes["child"].status, "dirty");
    assert_eq!(runtime.state.nodes["independent"].status, "done");
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
            edges: vec![Edge { from: "parent".into(), to: "child".into(), relation: "files".into(), feedback: false }],
        };
        let (_temp, source, mut runtime) = setup(standard_git, graph.clone());
        let mut config = runtime.state.config.clone().unwrap();
        config.max_parallel = 3;
        runtime.edit_draft_graph(graph.clone(), config).unwrap();
        runtime.approve().unwrap();
        let approval = runtime.state.base.clone();
        let roots = runtime.jobs().unwrap();
        let parent = roots.iter().find(|job| job.execution.node == "parent").unwrap();
        let running = roots.iter().find(|job| job.execution.node == "running").unwrap();
        let parent_path = Path::new(&parent.execution.worktree);
        workspace::prepare(&source, parent_path, &parent.execution.before, &[]).unwrap();
        fs::write(parent_path.join("parent.txt"), "parent result").unwrap();
        let head = workspace::snapshot_node_for_run(parent_path, &source, "parent", Some(&runtime.state.run_id)).unwrap();
        runtime.finish(&parent.execution, Ok((head, "done".into()))).unwrap();
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
        let path = Path::new(&first.execution.worktree);
        workspace::prepare(&source, path, &first.execution.before, &[]).unwrap();
        fs::write(path.join("node.txt"), "retained node result").unwrap();
        let node_head = workspace::snapshot_node_for_run(path, &source, "task", Some(&runtime.state.run_id)).unwrap();
        runtime.finish(&first.execution, Ok((node_head.clone(), "done".into()))).unwrap();
        fs::write(source.join("planner.txt"), "latest source").unwrap();
        runtime.revise_graph(single(), PlanningSummary { planning_id: "revision".into(), ..Default::default() }).unwrap();
        runtime.intervene("task", "continue").unwrap();
        let mut job = runtime.jobs().unwrap().remove(0);
        assert_eq!(job.execution.before, node_head);
        assert_ne!(job.expected_source_head, node_head);
        let script = temp.path().join("node.sh");
        fs::write(&script, "cat >/dev/null\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Done\"}]}}'\n").unwrap();
        job.config.pi_command = "/bin/sh".into();
        job.config.pi_args = vec![script.to_string_lossy().into()];
        perform(&job, &runtime.root, &[], |_| {}, |_| Ok(())).unwrap();
        assert_eq!(fs::read_to_string(path.join("node.txt")).unwrap(), "retained node result");
        assert_eq!(fs::read_to_string(path.join("planner.txt")).unwrap(), "latest source");
        if !standard_git { fs::remove_dir_all(workspace::shadow_repo_dir(&source).unwrap()).unwrap(); }
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
            output: "done".into(), output_bytes: 0, metrics: None,
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
            relation: "existing input".into(),
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
                output: "done".into(),
            })
            .unwrap();
    }
    // The consumer has actually executed, so changing its input invalidates its result.
    for job in runtime.jobs().unwrap() {
        runtime
            .emit(EventKind::Finished { output_bytes: 0, metrics: None,
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
fn feedback_continues_the_owner_session_and_worktree() {
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
            from: from.into(), to: to.into(), relation: String::new(), feedback,
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
    runtime.finish(&owner.execution, Ok((owner_head, "done".into()))).unwrap();

    let review = runtime.jobs().unwrap().remove(0);
    assert_eq!(review.execution.node, "review");
    runtime.finish(&review.execution, Ok((runtime.state.base.clone(), "please adjust\n<FEEDBACK>".into()))).unwrap();
    runtime.apply_feedback("review", "please adjust\n<FEEDBACK>").unwrap();

    assert_eq!(runtime.state.nodes["owner"].status, "dirty");
    assert!(runtime.state.nodes["review"].head.is_none());
    let jobs = runtime.jobs_with_pending_feedback(true, &[]).unwrap();
    let rework = jobs.iter().find(|job| job.execution.node == "owner").unwrap();
    assert_eq!(rework.execution.session_id, owner_session);
    assert_eq!(rework.resume_execution_id.as_deref(), Some(owner_id.as_str()));
    assert_eq!(rework.execution.worktree, owner_path.to_string_lossy());
    assert_eq!(rework.task, "Feedback from review:\nplease adjust\n<FEEDBACK>");
}

#[test]
fn completed_shadow_graph_intervention_is_blocked_when_source_changed() {
    let graph = Graph {
        original_goal: "test".into(),
        nodes: vec![
            Node { name: "parent".into(), task: "parent task".into() },
            Node { name: "child".into(), task: "child task".into() },
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
        runtime.finish(&job.execution, Ok((head, "done".into()))).unwrap();
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
    assert!(runtime
        .intervene("parent", "again")
        .unwrap_err()
        .contains("changed after approval"));
    assert_eq!(runtime.state.nodes["parent"].status, "done");
    fs::write(source.join("tracked.txt"), "original").unwrap();
    runtime.intervene("parent", "again").unwrap();
    assert_eq!(runtime.state.nodes["parent"].status, "dirty");
    // The follow-up only recomputes downstream once its result changes.
    assert_eq!(runtime.state.nodes["child"].status, "done");
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
            head: runtime.state.base.clone(), output_bytes: 0, metrics: None,
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
            relation: "files".into(),
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
        .finish(&root_job.execution, Ok((root_head, "done".into())))
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
        .finish(&child_job.execution, Ok((child_head.clone(), "done".into())))
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
        .finish(&root_job.execution, Ok((root_head, "done".into())))
        .unwrap();
    let extra_job = jobs.remove(0);
    assert_eq!(extra_job.execution.node, "extra");
    let path = Path::new(&extra_job.execution.worktree);
    workspace::prepare(&source, path, &extra_job.execution.before, &[]).unwrap();
    fs::write(path.join("extra.txt"), "extra v1").unwrap();
    let extra_head = workspace::snapshot_node(path, &source, "extra").unwrap();
    runtime
        .finish(&extra_job.execution, Ok((extra_head.clone(), "done".into())))
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
        .finish(&child_job.execution, Ok((child_head.clone(), "done".into())))
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
