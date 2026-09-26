    use super::*;

    #[test]
    fn buffered_output_flushes_before_finish_and_replays() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().join("runtime");
        let service = Arc::new(Service {
            runtime: Mutex::new(Runtime::open(&root).unwrap()),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });
        let id = Uuid::new_v4().to_string();
        let execution = Execution {
            id: id.clone(), node: "task".into(), revision: 1, attempt: 1,
            session_id: id.clone(), worktree: "".into(), before: "".into(),
            after: None, status: "running".into(), output: String::new(),
            started_at: now(), completed_at: None, metrics: None,
        };
        {
            let mut runtime = service.runtime.lock().unwrap();
            let config = serde_json::from_value(serde_json::json!({
                "repository": temp.path(), "model": "test", "maxParallel": 8, "maxFeedback": 0
            })).unwrap();
            runtime.create(Graph {
                original_goal: "test".into(),
                nodes: vec![Node { name: "task".into(), task: "test".into() }],
                edges: vec![],
            }, config).unwrap();
            runtime.emit(EventKind::Started { execution: execution.clone() }).unwrap();
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(256);
        let writer_service = service.clone();
        let writer = thread::spawn(move || persist_outputs(writer_service, rx));
        let producers: Vec<_> = (0..8).map(|_| {
            let tx = tx.clone();
            let id = id.clone();
            thread::spawn(move || {
                for _ in 0..100 {
                    tx.send(OutputMessage::Text { execution_id: id.clone(), text: "x".into() }).unwrap();
                }
                let (reply, ack) = std::sync::mpsc::channel();
                tx.send(OutputMessage::Flush(reply)).unwrap();
                ack.recv().unwrap().unwrap();
            })
        }).collect();
        for producer in producers { producer.join().unwrap(); }
        service.runtime.lock().unwrap().emit(EventKind::Finished {
            execution_id: id.clone(), head: "done".into(), output: "result".into(),
        }).unwrap();
        drop(tx);
        writer.join().unwrap();
        let runtime = service.runtime.lock().unwrap();
        let replay = runtime.store.load(&runtime.state.run_id).unwrap();
        assert_eq!(replay.events.iter().filter(|e| matches!(e.kind, EventKind::Output { .. })).count(), 800);
        assert_eq!(replay.events.iter().filter(|e| matches!(e.kind, EventKind::Finished { .. })).count(), 1);
        let finish = replay.events.last().unwrap();
        assert!(matches!(finish.kind, EventKind::Finished { .. }));
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn planner_revision_updates_approved_run_without_reapproval() {
        let temp = tempfile::TempDir::new().unwrap();
        let repo = crate::fixture::repository(temp.path()).unwrap();
        let script = temp.path().join("revise.sh");
        fs::write(&script, r#"input="$(cat)"
printf '%s' "$input" | grep -q -- '- keep: waiting' || exit 11
printf '%s' "$input" | grep -q 'Add a node' || exit 12
printf '%s' '{"originalGoal":"test","nodes":[{"name":"keep","task":"keep"},{"name":"added","task":"added"}],"edges":[]}' > "$GRAPHER_GRAPH_PATH"
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Revised"}]}}'
"#).unwrap();
        let root = temp.path().join("runtime");
        let mut runtime = Runtime::open(&root).unwrap();
        let config = Config {
            repository: repo.to_string_lossy().into(), engine: "pi".into(),
            pi_command: "/bin/sh".into(), pi_args: vec![script.to_string_lossy().into()],
            model: "mock/model".into(), thinking_level: "medium".into(), max_parallel: 2, max_feedback: 1, auto_approve: false,
        };
        runtime.create(Graph {
            original_goal: "test".into(), nodes: vec![Node { name: "keep".into(), task: "keep".into() }], edges: vec![],
        }, config.clone()).unwrap();
        runtime.set_route("graph").unwrap();
        runtime.approve().unwrap();
        let run_id = runtime.state.run_id.clone();
        assert_eq!(planner_followup_prompt("New conversation", None, &runtime.state), "New conversation");
        assert_eq!(planner_followup_prompt("Follow up", Some(&run_id), &runtime.state),
            "Current graph node status:\n- keep: waiting\n\nFollow up");
        let base = runtime.state.base.clone();
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime), driving: AtomicBool::new(false), planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });
        let snapshot = plan_goal_internal(
            "Add a node".into(), config, Some("graph"), None, Some(run_id.clone()), &service,
            |_| {}, |_| {}, |_| {},
        ).unwrap();
        assert_eq!(snapshot.run_id, run_id);
        assert_eq!(snapshot.base, base);
        assert!(snapshot.approved);
        assert_eq!(snapshot.nodes["keep"].status, "waiting");
        assert_eq!(snapshot.nodes["added"].status, "waiting");
        let replay = service.runtime.lock().unwrap().store.load(&run_id).unwrap();
        assert!(replay.approved);
        assert!(replay.graph.nodes.iter().any(|node| node.name == "added"));
        assert_eq!(replay.events.iter().filter(|e| matches!(e.kind, EventKind::Approved { .. })).count(), 1);
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn manually_created_graph_uses_one_planner_session_even_before_first_revision_succeeds() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().join("runtime");
        let repo = crate::fixture::repository(temp.path()).unwrap();
        let mut runtime = Runtime::open(&root).unwrap();
        runtime.create(Graph {
            original_goal: "test".into(), nodes: vec![Node { name: "first".into(), task: "first".into() }], edges: vec![],
        }, Config { repository: repo.to_string_lossy().into(), engine: "pi".into(),
            pi_command: "/bin/sh".into(), pi_args: vec![], model: "mock/model".into(),
            thinking_level: "medium".into(), max_parallel: 2, max_feedback: 1, auto_approve: false }).unwrap();
        runtime.set_route("graph").unwrap();
        let attempt = root.join("planning").join(Uuid::new_v4().to_string());
        let expected = root.join("planner-sessions").join(&runtime.state.run_id);
        assert_eq!(planner_session_directory(&root, &attempt, &repo, Some(&runtime.state)).unwrap(),
            (expected.clone(), runtime.state.run_id.clone()));
        fs::create_dir_all(&expected).unwrap();
        fs::write(expected.join("turns.jsonl"), format!(
            "{{\"type\":\"session\",\"id\":\"{}\",\"cwd\":\"{}\"}}\n",
            runtime.state.run_id, repo.display(),
        )).unwrap();
        assert_eq!(planner_session_directory(&root, &attempt, &repo, Some(&runtime.state)).unwrap(),
            (expected, runtime.state.run_id.clone()));
        assert_eq!(planner_node_status(&runtime.state), "Current graph node status:\n- first: waiting\n");
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn legacy_planner_session_keeps_its_original_pi_identity() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().join("runtime");
        let repo = crate::fixture::repository(temp.path()).unwrap();
        let mut runtime = Runtime::open(&root).unwrap();
        let planning_id = Uuid::new_v4().to_string();
        runtime.create_with_planning(Graph {
            original_goal: "test".into(), nodes: vec![Node { name: "first".into(), task: "first".into() }], edges: vec![],
        }, Config { repository: repo.to_string_lossy().into(), engine: "pi".into(),
            pi_command: "/bin/sh".into(), pi_args: vec![], model: "mock/model".into(),
            thinking_level: "medium".into(), max_parallel: 2, max_feedback: 1, auto_approve: false },
        Some(planning_id.clone()), None).unwrap();
        runtime.set_route("graph").unwrap();
        let legacy = Uuid::new_v4().to_string();
        let session = root.join("planning").join(planning_id).join("planner-session");
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("legacy.jsonl"), format!(
            "{{\"type\":\"session\",\"id\":\"{legacy}\",\"cwd\":\"{}\"}}\n", repo.display(),
        )).unwrap();
        let attempt = root.join("planning").join(Uuid::new_v4().to_string());
        assert_eq!(planner_session_directory(&root, &attempt, &repo, Some(&runtime.state)).unwrap(),
            (session.clone(), legacy));
        fs::write(session.join("legacy.jsonl"), "corrupt\n").unwrap();
        assert!(planner_session_directory(&root, &attempt, &repo, Some(&runtime.state)).is_err());
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn planner_continues_the_same_run_session_across_revisions_and_reload() {
        let temp = tempfile::TempDir::new().unwrap();
        let repo = crate::fixture::repository(temp.path()).unwrap();
        let script = temp.path().join("planner-session.sh");
        fs::write(&script, r#"session=''
identity=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-dir) session="$2"; shift 2 ;;
    --session-id) identity="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$session" ] && [ -n "$identity" ] || exit 11
printf '%s|%s\n' "$session" "$identity" >> "$(dirname "$0")/session-trace.txt"
if [ -f "$session/turns.jsonl" ]; then
  grep -q "\"id\":\"$identity\"" "$session/turns.jsonl" || exit 12
  printf '%s' '{"originalGoal":"initial","nodes":[{"name":"first","task":"first"},{"name":"next","task":"next"}],"edges":[]}' > "$GRAPHER_GRAPH_PATH"
else
  printf '%s' '{"originalGoal":"initial","nodes":[{"name":"first","task":"first"}],"edges":[]}' > "$GRAPHER_GRAPH_PATH"
  printf '{"type":"session","id":"%s","cwd":"%s"}\n' "$identity" "$PWD" > "$session/turns.jsonl"
fi
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Planned"}]}}'
"#).unwrap();
        let root = temp.path().join("runtime");
        let config = Config {
            repository: repo.to_string_lossy().into(), engine: "pi".into(),
            pi_command: "/bin/sh".into(), pi_args: vec![script.to_string_lossy().into()],
            model: "mock/model".into(), thinking_level: "medium".into(), max_parallel: 2, max_feedback: 1, auto_approve: false,
        };
        let make_service = || Arc::new(Service {
            runtime: Mutex::new(Runtime::open(&root).unwrap()),
            driving: AtomicBool::new(false), planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });
        let first_service = make_service();
        let first = plan_goal_internal(
            "initial".into(), config.clone(), Some("graph"), None, None, &first_service,
            |_| {}, |_| {}, |_| {},
        ).unwrap();
        let first_id = first.planning_id.clone().unwrap();
        drop(first_service);
        // Reload from the event store, not a process-local session pointer.
        let service = make_service();
        assert_eq!(service.runtime.lock().unwrap().state.run_id, first.run_id);
        let second = plan_goal_internal(
            "revision".into(), config, Some("graph"), None, Some(first.run_id.clone()), &service,
            |_| {}, |_| {}, |_| {},
        ).unwrap();
        assert_ne!(first_id, second.planning_id.clone().unwrap());
        assert_eq!(second.graph.nodes.len(), 2);
        let trace = fs::read_to_string(temp.path().join("session-trace.txt")).unwrap();
        let lines: Vec<_> = trace.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], format!("{}|{}", root.join("planning").join(&first_id).join("planner-session").display(), first_id));
        assert_eq!(lines[1], lines[0]);
        for id in [&first_id, second.planning_id.as_ref().unwrap()] {
            assert!(root.join("planning").join(id).join("planner.jsonl").is_file());
        }
        assert!(!root.join("planning").join(second.planning_id.unwrap()).join("planner-session").exists());
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn planner_revises_waiting_node_while_unaffected_node_is_running() {
        let temp = tempfile::TempDir::new().unwrap();
        let repo = crate::fixture::repository(temp.path()).unwrap();
        let script = temp.path().join("live-revise.sh");
        fs::write(&script, r#"input="$(cat)"
printf '%s' "$input" | grep -q -- '- keep: running' || exit 11
printf '%s' "$input" | grep -q -- '- pending: waiting' || exit 12
printf '%s' "$input" | grep -q 'Update pending' || exit 13
printf '%s' '{"originalGoal":"test","nodes":[{"name":"keep","task":"keep"},{"name":"pending","task":"updated"}],"edges":[{"from":"keep","to":"pending","relation":"files","feedback":false}]}' > "$GRAPHER_GRAPH_PATH"
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Updated"}]}}'
"#).unwrap();
        let config = Config {
            repository: repo.to_string_lossy().into(), engine: "pi".into(),
            pi_command: "/bin/sh".into(), pi_args: vec![script.to_string_lossy().into()],
            model: "mock/model".into(), thinking_level: "medium".into(), max_parallel: 2, max_feedback: 1, auto_approve: false,
        };
        let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
        runtime.create(Graph {
            original_goal: "test".into(),
            nodes: vec![Node { name: "keep".into(), task: "keep".into() }, Node { name: "pending".into(), task: "pending".into() }],
            edges: vec![Edge { from: "keep".into(), to: "pending".into(), relation: "files".into(), feedback: false }],
        }, config.clone()).unwrap();
        runtime.set_route("graph").unwrap();
        runtime.approve().unwrap();
        let run_id = runtime.state.run_id.clone();
        let running = runtime.jobs().unwrap().remove(0).execution;
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime), driving: AtomicBool::new(false), planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });
        let snapshot = plan_goal_internal(
            "Update pending".into(), config, Some("graph"), None, Some(run_id.clone()), &service,
            |_| {}, |_| {}, |_| {},
        ).unwrap();
        assert_eq!(snapshot.run_id, run_id);
        assert!(snapshot.approved);
        assert!(!snapshot.paused);
        assert_eq!(snapshot.nodes["keep"].status, "running");
        assert_eq!(snapshot.executions.iter().find(|exec| exec.id == running.id).unwrap().status, "running");
        assert_eq!(snapshot.nodes["pending"].status, "waiting");
        assert_eq!(snapshot.graph.nodes.iter().find(|node| node.name == "pending").unwrap().task, "updated");
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn running_revision_drains_only_affected_execution_before_commit() {
        let temp = tempfile::TempDir::new().unwrap();
        let repo = crate::fixture::repository(temp.path()).unwrap();
        let script = temp.path().join("running-revise.sh");
        fs::write(&script, r#"cat >/dev/null
printf '%s' '{"originalGoal":"test","nodes":[{"name":"change","task":"updated"},{"name":"other","task":"other"}],"edges":[]}' > "$GRAPHER_GRAPH_PATH"
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Updated"}]}}'
"#).unwrap();
        let config = Config {
            repository: repo.to_string_lossy().into(), engine: "pi".into(),
            pi_command: "/bin/sh".into(), pi_args: vec![script.to_string_lossy().into()],
            model: "mock/model".into(), thinking_level: "medium".into(), max_parallel: 2, max_feedback: 1, auto_approve: false,
        };
        let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
        runtime.create(Graph {
            original_goal: "test".into(),
            nodes: ["change", "other"].into_iter().map(|name| Node { name: name.into(), task: name.into() }).collect(),
            edges: vec![],
        }, config.clone()).unwrap();
        runtime.set_route("graph").unwrap();
        runtime.approve().unwrap();
        let run_id = runtime.state.run_id.clone();
        runtime.jobs().unwrap();
        // Pretend the driver owns the already-started jobs; complete only the
        // affected one below. The unrelated job remains running throughout.
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime), driving: AtomicBool::new(true), planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });
        let worker = {
            let service = service.clone();
            thread::spawn(move || plan_goal_internal(
                "Change active node".into(), config, Some("graph"), None, Some(run_id), &service,
                |_| {}, |_| {}, |_| {},
            ))
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let snapshot = service.runtime.lock().unwrap().state.clone();
            if snapshot.paused {
                assert_eq!(snapshot.nodes["other"].status, "running");
                let execution = snapshot.executions.iter().find(|item| item.node == "change").unwrap();
                service.runtime.lock().unwrap().emit(EventKind::Finished {
                    execution_id: execution.id.clone(), head: snapshot.base, output: "completed".into(),
                }).unwrap();
                break;
            }
            assert!(std::time::Instant::now() < deadline, "Planner did not pause for affected execution");
            thread::sleep(std::time::Duration::from_millis(10));
        }
        let snapshot = worker.join().unwrap().unwrap();
        assert!(!snapshot.paused);
        assert_eq!(snapshot.nodes["change"].status, "dirty");
        assert_eq!(snapshot.nodes["other"].status, "running");
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn planner_auto_approve_only_when_enabled() {
        let temp = tempfile::TempDir::new().unwrap();
        let repo = crate::fixture::repository(temp.path()).unwrap();
        let script = temp.path().join("auto-approve.sh");
        fs::write(&script, r#"cat >/dev/null
printf '%s' '{"originalGoal":"test","nodes":[{"name":"work","task":"work"}],"edges":[]}' > "$GRAPHER_GRAPH_PATH"
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Planned"}]}}'
"#).unwrap();
        let config = Config {
            repository: repo.to_string_lossy().into(), engine: "pi".into(),
            pi_command: "/bin/sh".into(), pi_args: vec![script.to_string_lossy().into()],
            model: "mock/model".into(), thinking_level: "medium".into(), max_parallel: 2,
            max_feedback: 1, auto_approve: false,
        };
        let service = Arc::new(Service {
            runtime: Mutex::new(Runtime::open(&temp.path().join("runtime")).unwrap()),
            driving: AtomicBool::new(false), planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });
        let plan = |config: Config, revision: Option<String>| plan_goal_internal(
            "test".into(), config, Some("graph"), None, revision, &service,
            |_| {}, |_| {}, |_| {},
        ).unwrap();
        let draft = plan(config.clone(), None);
        assert_eq!(draft.phase, "awaiting_approval");
        assert!(!draft.approved);
        assert!(!service.driving.load(Ordering::SeqCst));
        let mut enabled = config;
        enabled.auto_approve = true;
        let approved = plan(enabled, Some(draft.run_id.clone()));
        assert!(approved.approved);
        assert_eq!(approved.run_id, draft.run_id);
        let replay = service.runtime.lock().unwrap().store.load(&draft.run_id).unwrap();
        assert_eq!(replay.events.iter().filter(|event| matches!(event.kind, EventKind::Approved { .. })).count(), 1);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while service.driving.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!service.runtime.lock().unwrap().state.executions.is_empty());
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn draft_planner_revision_stays_unapproved_and_approvable() {
        let temp = tempfile::TempDir::new().unwrap();
        let repo = crate::fixture::repository(temp.path()).unwrap();
        let script = temp.path().join("revise-draft.sh");
        fs::write(&script, r#"test "$(cat)" = "Update the draft" || exit 14
printf '%s' '{"originalGoal":"test","nodes":[{"name":"keep","task":"keep"},{"name":"added","task":"added"}],"edges":[]}' > "$GRAPHER_GRAPH_PATH"
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Revised"}]}}'
"#).unwrap();
        let root = temp.path().join("runtime");
        let mut runtime = Runtime::open(&root).unwrap();
        let config = Config {
            repository: repo.to_string_lossy().into(), engine: "pi".into(),
            pi_command: "/bin/sh".into(), pi_args: vec![script.to_string_lossy().into()],
            model: "mock/model".into(), thinking_level: "medium".into(), max_parallel: 2, max_feedback: 1, auto_approve: false,
        };
        runtime.create(Graph {
            original_goal: "test".into(), nodes: vec![Node { name: "keep".into(), task: "keep".into() }], edges: vec![],
        }, config.clone()).unwrap();
        runtime.set_route("graph").unwrap();
        let run_id = runtime.state.run_id.clone();
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime), driving: AtomicBool::new(false), planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });
        for rejected in [false, true] {
            if rejected {
                service.runtime.lock().unwrap().emit(EventKind::Rejected).unwrap();
            }
            let snapshot = plan_goal_internal(
                "Update the draft".into(), config.clone(), Some("graph"), None, Some(run_id.clone()), &service,
                |_| {}, |_| {}, |_| {},
            ).unwrap();
            assert_eq!(snapshot.phase, "awaiting_approval");
            assert!(!snapshot.approved);
            assert!(snapshot.executions.is_empty());
            let replay = service.runtime.lock().unwrap().store.load(&run_id).unwrap();
            assert_eq!(replay.phase, "awaiting_approval");
            assert!(!replay.approved);
            assert!(replay.events.iter().all(|e| !matches!(e.kind, EventKind::Approved { .. } | EventKind::Started { .. })));
            let planning_id = snapshot.planning_id.clone();
            let planning = snapshot.planning.clone();
            let mut edited = snapshot.graph.clone();
            edited.nodes[0].task = "manually edited prompt".into();
            let edited_snapshot = save_graph(edited.clone(), config.clone(), Some(run_id.clone()), &service).unwrap();
            assert_eq!(edited_snapshot.run_id, run_id);
            assert_eq!(edited_snapshot.planning_id, planning_id);
            assert_eq!(edited_snapshot.planning, planning);
            let edited_replay = service.runtime.lock().unwrap().store.load(&run_id).unwrap();
            assert_eq!(edited_replay.graph, edited);
            assert_eq!(edited_replay.planning_id, planning_id);
        }
        service.runtime.lock().unwrap().approve().unwrap();
        assert!(service.runtime.lock().unwrap().state.approved);
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn manual_graph_edits_after_reject_create_approvable_graph_drafts() {
        let temp = tempfile::TempDir::new().unwrap();
        let repo = crate::fixture::repository(temp.path()).unwrap();
        let service = Arc::new(Service {
            runtime: Mutex::new(Runtime::open(&temp.path().join("runtime")).unwrap()),
            driving: AtomicBool::new(false), planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });
        let config = Config {
            repository: repo.to_string_lossy().into(), engine: "pi".into(),
            pi_command: "/bin/sh".into(), pi_args: vec![],
            model: "mock/model".into(), thinking_level: "medium".into(), max_parallel: 2, max_feedback: 1, auto_approve: false,
        };
        let graph = Graph {
            original_goal: "test".into(),
            nodes: vec![Node { name: "task".into(), task: "original prompt".into() }], edges: vec![],
        };
        let initial = save_graph(graph.clone(), config.clone(), None, &service).unwrap();
        assert_eq!(initial.plan_type.as_deref(), Some("graph"));
        let run_id = initial.run_id.clone();
        service.runtime.lock().unwrap().emit(EventKind::Rejected).unwrap();

        // Saving Graph IR or editing a node prompt must update the same Run.
        for task in ["edited IR", "edited node prompt"] {
            let mut edited = graph.clone();
            edited.nodes[0].task = task.into();
            let snapshot = save_graph(edited.clone(), config.clone(), Some(run_id.clone()), &service).unwrap();
            assert_eq!(snapshot.run_id, run_id);
            assert_eq!(snapshot.graph, edited);
            assert_eq!(snapshot.plan_type.as_deref(), Some("graph"));
            assert_eq!(snapshot.phase, "awaiting_approval");
            assert!(!snapshot.approved);
            assert!(snapshot.executions.is_empty());
            let runtime = service.runtime.lock().unwrap();
            let replay = runtime.store.load(&run_id).unwrap();
            assert_eq!(replay.graph, edited);
            assert_eq!(replay.phase, "awaiting_approval");
            assert_eq!(replay.plan_type.as_deref(), Some("graph"));
            assert_eq!(runtime.store.runs().unwrap().len(), 1);
            drop(runtime);
            service.runtime.lock().unwrap().emit(EventKind::Rejected).unwrap();
        }
        assert!(save_graph(graph.clone(), config.clone(), Some("wrong-run".into()), &service).is_err());
        assert_eq!(service.runtime.lock().unwrap().store.runs().unwrap().len(), 1);
        service.runtime.lock().unwrap().approve().unwrap_err(); // Still rejected until edited again.
        let restored = save_graph(graph, config.clone(), Some(run_id.clone()), &service).unwrap();
        assert_eq!(restored.run_id, run_id);
        service.runtime.lock().unwrap().approve().unwrap();
        assert!(save_graph(restored.graph, config, Some(run_id.clone()), &service).is_err());
        assert_eq!(service.runtime.lock().unwrap().store.runs().unwrap().len(), 1);
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn partitioner_receives_unmodified_goal() {
        let temp = tempfile::TempDir::new().unwrap();
        let repo = crate::fixture::repository(temp.path()).unwrap();
        let script = temp.path().join("partition.sh");
        fs::write(&script, r#"test "$(cat)" = "Build two modules" || exit 17
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"serial"}]}}'
"#).unwrap();
        let service = Arc::new(Service {
            runtime: Mutex::new(Runtime::open(&temp.path().join("runtime")).unwrap()),
            driving: AtomicBool::new(false), planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });
        let config = Config {
            repository: repo.to_string_lossy().into(), engine: "pi".into(),
            pi_command: "/bin/sh".into(), pi_args: vec![script.to_string_lossy().into()],
            model: "mock/model".into(), thinking_level: "medium".into(), max_parallel: 2, max_feedback: 1, auto_approve: false,
        };
        let snapshot = plan_goal_internal(
            "Build two modules".into(), config, None, None, None, &service,
            |_| {}, |_| {}, |_| {},
        ).unwrap();
        assert_eq!(snapshot.plan_type.as_deref(), Some("serial"));
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn partitioner_failure_does_not_create_or_approve_a_run() {
        let temp = tempfile::TempDir::new().unwrap();
        let repo = temp.path().join("repository");
        fs::create_dir_all(&repo).unwrap();
        fs::write(repo.join("README.md"), "Two independent modules").unwrap();
        let script = temp.path().join("failed-pi.sh");
        fs::write(&script, "echo 'provider unavailable' >&2\nexit 1\n").unwrap();
        let root = temp.path().join("runtime");
        let service = Arc::new(Service {
            runtime: Mutex::new(Runtime::open(&root).unwrap()),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });
        let before = service.runtime.lock().unwrap().state.run_id.clone();
        let result = plan_goal_internal(
            "Build two modules".into(),
            Config {
                repository: repo.to_string_lossy().into(),
                engine: "pi".into(),
                pi_command: "/bin/sh".into(),
                pi_args: vec![script.to_string_lossy().into()],
                model: "mock/model".into(),
                thinking_level: "medium".into(),
                max_parallel: 4,
                max_feedback: 3, auto_approve: false,
            },
            None,
            None,
            None,
            &service,
            |_| {},
            |_| panic!("Failure must not emit a route"),
            |_| {},
        );
        assert!(result.unwrap_err().0.contains("Partitioner failed"));
        let runtime = service.runtime.lock().unwrap();
        assert_eq!(runtime.state.run_id, before);
        assert!(runtime.state.executions.is_empty());
        assert!(!runtime.state.approved);
        assert!(!service.planning.load(Ordering::SeqCst));
        let directory = fs::read_dir(root.join("planning"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(fs::read_to_string(directory.join("partition.jsonl"))
            .unwrap()
            .contains("provider unavailable"));
        assert!(!directory.join("route.json").exists());
        let summary_content = fs::read_to_string(directory.join("summary.json")).unwrap();
        let failure_summary: PlanningSummary = serde_json::from_str(&summary_content).unwrap();
        assert_eq!(failure_summary.status.as_deref(), Some("failed"));
        assert!(failure_summary.roles.contains_key("partition"));
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn fast_sibling_releases_slot_for_downstream_before_slow_sibling() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path();
        let repository = crate::fixture::repository(root).unwrap();
        let release = root.join("release-slow");
        let script = root.join("worker.sh");
        fs::write(&script, format!(r#"cat >/dev/null
case "$PWD" in
  *a_slow-*) while [ ! -f '{}' ]; do sleep 0.02; done; echo done > slow.txt ;;
  *z_fast-*) echo done > fast.txt ;;
  *) echo done > downstream.txt ;;
esac
printf '%s\n' '{{"type":"message_end","message":{{"role":"assistant","content":[{{"type":"text","text":"Completed"}}]}}}}'
"#, release.display())).unwrap();
        let mut runtime = Runtime::open(root).unwrap();
        runtime
            .create(
                Graph {
                    original_goal: "Check real completion order".into(),
                    nodes: ["a_slow", "z_fast", "after_fast"]
                        .into_iter()
                        .map(|name| Node {
                            name: name.into(),
                            task: "Write your result".into(),
                        })
                        .collect(),
                    edges: vec![Edge {
                        from: "z_fast".into(),
                        to: "after_fast".into(),
                        feedback: false,
                        relation: String::new(),
                    }],
                },
                Config {
                    repository: repository.to_string_lossy().into(),
                    engine: "pi".into(),
                    pi_command: "/bin/sh".into(),
                    pi_args: vec![script.to_string_lossy().into()],
                    model: "test".into(),
                    thinking_level: "medium".into(),
                    max_parallel: 4,
                    max_feedback: 2, auto_approve: false,
                },
            )
            .unwrap();
        runtime.approve().unwrap();
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: root.join("unused.ts"),
        });
        drive(service.clone());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let observed = loop {
            let state = service.runtime.lock().unwrap().state.clone();
            if state.nodes["after_fast"].status == "done" || std::time::Instant::now() > deadline {
                break state;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        };
        // Always release and drain before assertions, even on a regression.
        fs::write(&release, "release").unwrap();
        while service.driving.load(Ordering::SeqCst) {
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(observed.nodes["z_fast"].status, "done");
        assert_eq!(observed.nodes["a_slow"].status, "running");
        assert_eq!(observed.nodes["after_fast"].status, "done");
        let fast = observed
            .executions
            .iter()
            .find(|e| e.node == "z_fast")
            .unwrap();
        assert!(fast.completed_at.is_some());
        let runtime = service.runtime.lock().unwrap();
        let replayed = runtime.store.load(&runtime.state.run_id).unwrap();
        assert_eq!(
            replayed
                .executions
                .iter()
                .find(|e| e.node == "z_fast")
                .unwrap()
                .completed_at,
            fast.completed_at
        );
        assert_eq!(replayed.phase, "completed");
    }

    #[test]
    fn metadata_and_output_pages_preserve_unicode_without_copying_logs_into_polls() {
        let temp = tempfile::TempDir::new().unwrap();
        let runtime = Runtime::open(temp.path()).unwrap();
        let text = format!(
            "{}{}\n",
            "a".repeat(256 * 1024 - 1),
            "规划输出".repeat(100_000)
        );
        let execution = Execution {
            id: "large".into(),
            node: "worker".into(),
            revision: 1,
            attempt: 1,
            session_id: "fresh".into(),
            worktree: String::new(),
            before: String::new(),
            after: None,
            status: "running".into(),
            output: text.clone(),
            started_at: now(),
            completed_at: None,
            metrics: None,
        };
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: temp.path().join("unused"),
        });
        {
            let mut runtime = service.runtime.lock().unwrap();
            runtime.state.run_id = "large-run".into();
            runtime.state.executions.push(execution);
            runtime.state.events.push(Event {
                sequence: 1,
                timestamp: now(),
                kind: EventKind::Finished {
                    execution_id: "large".into(),
                    head: "head".into(),
                    output: text.clone(),
                },
            });
        }
        let metadata = dispatch(
            &service,
            "snapshot",
            serde_json::json!({"detail":"metadata"}),
        )
        .unwrap();
        assert!(metadata.to_string().len() < 2048);
        assert_eq!(metadata["executions"][0]["outputBytes"], text.len());
        let first = dispatch(&service, "snapshot_if_changed", serde_json::json!({"detail":"metadata", "compact":true})).unwrap();
        assert_eq!(first["snapshot"]["executions"][0]["outputBytes"], text.len());
        let version = first["version"].as_str().unwrap();
        let unchanged = dispatch(&service, "snapshot_if_changed", serde_json::json!({"version":version, "detail":"metadata"})).unwrap();
        assert!(unchanged["snapshot"].is_null());
        {
            let mut runtime = service.runtime.lock().unwrap();
            runtime.state.phase = "paused".into();
            runtime.touch();
        }
        let changed = dispatch(&service, "snapshot_if_changed", serde_json::json!({"version":version, "detail":"metadata"})).unwrap();
        assert_ne!(changed["version"], first["version"]);
        assert_eq!(changed["snapshot"]["phase"], "paused");
        let mut restored = String::new();
        let mut offset = 0;
        loop {
            let page = get_execution_output(
                &serde_json::json!({"runId":"large-run", "executionId":"large", "offset":offset}),
                &service,
            )
            .unwrap();
            let content = page["content"].as_str().unwrap();
            assert!(content.len() <= 256 * 1024);
            restored.push_str(content);
            offset = page["nextOffset"].as_u64().unwrap();
            if page["complete"] == true {
                break;
            }
        }
        assert_eq!(restored, text);
        assert!(get_execution_output(
            &serde_json::json!({"runId":"large-run", "executionId":"large", "offset":256*1024}),
            &service
        )
        .is_err());
        assert_eq!(
            service.runtime.lock().unwrap().state.executions[0].output,
            text
        );
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn feedback_graph_drains_siblings_before_invalidating_and_never_runs_stale_consumer() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path();
        let repository = crate::fixture::repository(root).unwrap();
        let release = root.join("release-slow");
        let script = root.join("worker.sh");
        fs::write(&script, format!(r#"cat >/dev/null
case "$PWD" in
  *slow-*) while [ ! -f '{}' ]; do sleep 0.02; done; echo done > slow.txt ;;
  *review-*) printf '%s\n' '{{"type":"message_end","message":{{"role":"assistant","content":[{{"type":"text","text":"Fix owner.\n<REVISE>"}}]}}}}'; exit 0 ;;
  *consumer-*) echo invalid > stale.txt ;;
  *) echo done > owner.txt ;;
esac
printf '%s\n' '{{"type":"message_end","message":{{"role":"assistant","content":[{{"type":"text","text":"Completed"}}]}}}}'
"#, release.display())).unwrap();
        let mut runtime = Runtime::open(root).unwrap();
        runtime
            .create(
                Graph {
                    original_goal: "Feedback barrier".into(),
                    nodes: ["owner", "slow", "review", "consumer"]
                        .into_iter()
                        .map(|name| Node {
                            name: name.into(),
                            task: "Work".into(),
                        })
                        .collect(),
                    edges: [
                        ("owner", "review", false),
                        ("review", "owner", true),
                        ("review", "consumer", false),
                    ]
                    .into_iter()
                    .map(|(from, to, feedback)| Edge {
                        from: from.into(),
                        to: to.into(),
                        feedback,
                        relation: String::new(),
                    })
                    .collect(),
                },
                Config {
                    repository: repository.to_string_lossy().into(),
                    engine: "pi".into(),
                    pi_command: "/bin/sh".into(),
                    pi_args: vec![script.to_string_lossy().into()],
                    model: "test".into(),
                    thinking_level: "medium".into(),
                    max_parallel: 4,
                    max_feedback: 1, auto_approve: false,
                },
            )
            .unwrap();
        runtime.approve().unwrap();
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: root.join("unused"),
        });
        drive(service.clone());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let observed = loop {
            let state = service.runtime.lock().unwrap().state.clone();
            if state.nodes["owner"].status == "done" || std::time::Instant::now() > deadline {
                break state;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        };
        fs::write(&release, "release").unwrap();
        while service.driving.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(observed.nodes["slow"].status, "running");
        assert_eq!(observed.nodes["review"].status, "waiting");
        let runtime = service.runtime.lock().unwrap();
        assert_eq!(
            runtime
                .state
                .executions
                .iter()
                .filter(|e| e.node == "slow")
                .count(),
            1
        );
        assert_eq!(
            runtime
                .state
                .executions
                .iter()
                .filter(|e| e.node == "owner")
                .count(),
            2
        );
        assert!(!runtime
            .state
            .executions
            .iter()
            .any(|e| e.node == "consumer"));
        assert_eq!(runtime.state.phase, "needs_attention");
    }

    #[test]
    fn planning_metrics_parsing_and_persistence() {
        let sample_log = r#"{"type":"grapher_process_started","timestamp":1726300000000}
{"type":"tool_execution_start","toolName":"bash"}
{"type":"tool_execution_end","toolName":"bash","isError":true}
{"type":"tool_execution_start","toolName":"read"}
{"type":"tool_execution_end","toolName":"read","isError":false}
{"type":"message_end","message":{"role":"assistant","usage":{"input":200,"output":300,"cacheRead":50,"cacheWrite":0,"reasoning":100,"totalTokens":500}}}
{"type":"grapher_process_exited","elapsedMs":12345,"success":true,"timestamp":1726300012345}
"#;
        let metrics = parse_planning_role_metrics("test-model", sample_log);
        assert_eq!(metrics.model, "test-model");
        assert_eq!(metrics.assistant_messages, 1);
        assert_eq!(metrics.tools, 2);
        assert_eq!(metrics.tool_errors, 1);
        assert_eq!(metrics.duration_seconds, 12.345);
        assert_eq!(metrics.usage.input, 200);
        assert_eq!(metrics.usage.output, 300);
        assert_eq!(metrics.usage.total_tokens, 500);

        let temp = tempfile::TempDir::new().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        let config = Config {
            repository: String::new(),
            #[cfg(feature = "fixture")]
            engine: "fixture".into(),
            #[cfg(feature = "fixture")]
            pi_command: String::new(),
            #[cfg(feature = "fixture")]
            pi_args: Vec::new(),
            model: "test-model".into(),
            thinking_level: "medium".into(),
            max_parallel: 4,
            max_feedback: 1, auto_approve: false,
        };
        let mut roles = std::collections::BTreeMap::new();
        roles.insert("planner".to_string(), metrics);
        let summary = PlanningSummary {
            planning_id: "test-plan-id".into(),
            roles,
            total_planning_duration: 15.0,
            model_duration: 12.345,
            status: Some("success".into()),
            error: None,
            created_at: None,
            repository: None,
        };
        runtime
            .create_with_planning(
                Graph {
                    original_goal: "Test plan persistence".into(),
                    nodes: vec![Node {
                        name: "task".into(),
                        task: "Run task".into(),
                    }],
                    edges: Vec::new(),
                },
                config,
                Some("test-plan-id".into()),
                Some(summary.clone()),
            )
            .unwrap();
        assert_eq!(runtime.state.planning_id.as_deref(), Some("test-plan-id"));
        assert_eq!(runtime.state.planning.as_ref(), Some(&summary));

        // Replay from store to ensure durability across reload
        let loaded = runtime.store.load(&runtime.state.run_id).unwrap();
        assert_eq!(loaded.planning_id.as_deref(), Some("test-plan-id"));
        assert_eq!(loaded.planning.as_ref(), Some(&summary));
    }

    #[test]
    fn execution_and_run_metrics_parsing_and_persistence() {
        let sample_output = r#"
{"type":"grapher_process_started","pid":123,"timestamp":1726300000000}
{"type":"tool_execution_start","toolName":"read"}
{"type":"tool_execution_end","toolName":"read","isError":false}
{"type":"tool_execution_start","toolName":"bash"}
{"type":"tool_execution_end","toolName":"bash","isError":true}
{"type":"message_end","message":{"role":"assistant","usage":{"input":150,"output":250,"cacheRead":20,"cacheWrite":10,"reasoning":80,"totalTokens":400}}}
{"type":"grapher_process_exited","elapsedMs":8500,"success":true,"timestamp":1726300008500}
"#;
        let exec_metrics = crate::model::parse_execution_metrics(sample_output, 1726300000000, 1726300008500);
        assert_eq!(exec_metrics.duration_seconds, 8.5);
        assert_eq!(exec_metrics.assistant_messages, 1);
        assert_eq!(exec_metrics.tools, 2);
        assert_eq!(exec_metrics.tool_errors, 1);
        assert_eq!(exec_metrics.usage.input, 150);
        assert_eq!(exec_metrics.usage.output, 250);
        assert_eq!(exec_metrics.usage.total_tokens, 400);

        let temp = tempfile::TempDir::new().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        let config = Config {
            repository: String::new(),
            #[cfg(feature = "fixture")]
            engine: "fixture".into(),
            #[cfg(feature = "fixture")]
            pi_command: String::new(),
            #[cfg(feature = "fixture")]
            pi_args: Vec::new(),
            model: "test-model".into(),
            thinking_level: "medium".into(),
            max_parallel: 2,
            max_feedback: 1, auto_approve: false,
        };
        runtime
            .create(
                Graph {
                    original_goal: "Test execution metrics".into(),
                    nodes: vec![Node {
                        name: "worker".into(),
                        task: "Run worker".into(),
                    }],
                    edges: Vec::new(),
                },
                config,
            )
            .unwrap();

        let execution = Execution {
            id: "exec-1".into(),
            node: "worker".into(),
            revision: 1,
            attempt: 1,
            session_id: "session-1".into(),
            worktree: "".into(),
            before: "base-head".into(),
            after: None,
            status: "running".into(),
            output: String::new(),
            started_at: 1726300000000,
            completed_at: None,
            metrics: None,
        };
        runtime.emit(EventKind::Started { execution }).unwrap();
        runtime
            .emit(EventKind::Finished {
                execution_id: "exec-1".into(),
                head: "finished-head".into(),
                output: sample_output.into(),
            })
            .unwrap();

        // Execution metrics should be populated
        let execution = &runtime.state.executions[0];
        assert_eq!(execution.status, "completed");
        let m = execution.metrics.as_ref().expect("Execution metrics must be parsed");
        assert_eq!(m.duration_seconds, 8.5);
        assert_eq!(m.tools, 2);
        assert_eq!(m.tool_errors, 1);
        assert_eq!(m.usage.total_tokens, 400);

        // RunMetrics should be updated in snapshot
        let run_m = runtime.state.run_metrics.as_ref().expect("Run metrics must be present");
        assert_eq!(run_m.execution_usage.total_tokens, 400);
        assert_eq!(run_m.total_usage.total_tokens, 400);
        assert_eq!(run_m.tools, 2);

        // Snapshot metadata projection should include metrics and runMetrics
        let meta = crate::snapshot_view::snapshot_metadata(&runtime.state).unwrap();
        assert!(meta.get("runMetrics").is_some());
        assert_eq!(meta["executions"][0]["metrics"]["durationSeconds"], 8.5);

        // Replay from sqlite store
        let replayed = runtime.store.load(&runtime.state.run_id).unwrap();
        assert_eq!(replayed.executions[0].metrics, execution.metrics);
        assert!(replayed.run_metrics.is_some());
    }

    #[test]
    fn legacy_planning_summary_backfill_and_fail_closed_filtering() {
        let temp = tempfile::TempDir::new().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        let config = Config {
            repository: "/workspace/repo-a".into(),
            #[cfg(feature = "fixture")]
            engine: "fixture".into(),
            #[cfg(feature = "fixture")]
            pi_command: String::new(),
            #[cfg(feature = "fixture")]
            pi_args: Vec::new(),
            model: String::new(),
            thinking_level: "medium".into(),
            max_parallel: 4,
            max_feedback: 1, auto_approve: false,
        };
        let summary = PlanningSummary {
            planning_id: "legacy-plan-a".into(),
            roles: Default::default(),
            total_planning_duration: 10.0,
            model_duration: 8.0,
            status: Some("success".into()),
            error: None,
            created_at: Some(100),
            repository: None, // legacy: missing repository
        };
        runtime
            .create_with_planning(
                Graph {
                    original_goal: "Goal A".into(),
                    nodes: vec![Node {
                        name: "task".into(),
                        task: "Run task".into(),
                    }],
                    edges: Vec::new(),
                },
                config,
                Some("legacy-plan-a".into()),
                Some(summary.clone()),
            )
            .unwrap();

        // Write legacy summary on disk with NO repository
        let plan_a_dir = temp.path().join("planning").join("legacy-plan-a");
        fs::create_dir_all(&plan_a_dir).unwrap();
        let legacy_json = serde_json::to_string_pretty(&summary).unwrap();
        fs::write(plan_a_dir.join("summary.json"), &legacy_json).unwrap();

        // Write an unattributed legacy summary (failed planning never tied to a run)
        let unattr_summary = PlanningSummary {
            planning_id: "unattributed-plan".into(),
            roles: Default::default(),
            total_planning_duration: 5.0,
            model_duration: 4.0,
            status: Some("failed".into()),
            error: Some("Planner crashed".into()),
            created_at: Some(200),
            repository: None,
        };
        let unattr_dir = temp.path().join("planning").join("unattributed-plan");
        fs::create_dir_all(&unattr_dir).unwrap();
        fs::write(
            unattr_dir.join("summary.json"),
            serde_json::to_string_pretty(&unattr_summary).unwrap(),
        )
        .unwrap();

        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: temp.path().join("ext.ts"),
        });

        // 1. Filter by repo-b: must return NOTHING (fail closed against repo-a and unattributed)
        let res_b = list_plannings(&service, Some("/workspace/repo-b".into())).unwrap();
        assert_eq!(
            res_b.len(),
            0,
            "Repo B must not receive Repo A or unattributed plannings"
        );

        // 2. Filter by repo-a: must backfill legacy-plan-a and return it, and exclude unattributed
        let res_a = list_plannings(&service, Some("/workspace/repo-a".into())).unwrap();
        assert_eq!(res_a.len(), 1, "Repo A must receive backfilled planning");
        assert_eq!(res_a[0].planning_id, "legacy-plan-a");
        assert_eq!(res_a[0].repository.as_deref(), Some("/workspace/repo-a"));

        // Verify summary on disk was migrated
        let migrated_disk = fs::read_to_string(plan_a_dir.join("summary.json")).unwrap();
        let parsed_disk: PlanningSummary = serde_json::from_str(&migrated_disk).unwrap();
        assert_eq!(parsed_disk.repository.as_deref(), Some("/workspace/repo-a"));

        // 3. Unfiltered: returns both legacy-plan-a and unattributed-plan
        let res_all = list_plannings(&service, None).unwrap();
        assert_eq!(res_all.len(), 2, "Unfiltered query returns all plannings");
        assert_eq!(res_all[0].planning_id, "unattributed-plan"); // created_at 200 > 100
        assert_eq!(res_all[1].planning_id, "legacy-plan-a");
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn completed_graph_is_published_by_driver() {
        let temp = tempfile::TempDir::new().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        let config = Config {
            repository: String::new(),
            engine: "fixture".into(),
            pi_command: String::new(),
            pi_args: Vec::new(),
            model: String::new(),
            thinking_level: "medium".into(),
            max_parallel: 4,
            max_feedback: 1, auto_approve: false,
        };
        runtime
            .create(
                Graph {
                    original_goal: "Publish both independent outcomes".into(),
                    nodes: vec![
                        Node {
                            name: "first".into(),
                            task: "First".into(),
                        },
                        Node {
                            name: "last".into(),
                            task: "Last".into(),
                        },
                    ],
                    edges: Vec::new(),
                },
                config,
            )
            .unwrap();
        runtime.approve().unwrap();
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: temp.path().join("unused-extension.ts"),
        });
        drive(service.clone());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while service.driving.load(Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < deadline,
                "Driver did not settle"
            );
            thread::sleep(std::time::Duration::from_millis(20));
        }
        let runtime = service.runtime.lock().unwrap();
        assert_eq!(runtime.state.phase, "completed");
        let source = temp.path().join("fixture-repository");
        assert!(source.join("first.md").exists());
        assert!(source.join("last.md").exists());
        assert!(crate::workspace::git(&source, &["status", "--porcelain"])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn planning_prompts_separate_user_query_from_system() {
        for template in [PLANNER_PROMPT, PARTITIONER_PROMPT] {
            assert!(!template.contains("{{query}}"));
            assert!(!template.contains("User query:"));
        }
    }

    #[test]
    fn planning_attachment_ignores_client_filename() {
        let image = ImageAttachment {
            r#type: "image".into(), mime_type: "image/png".into(),
            data: String::new(), name: Some("../../config.json".into()),
        };
        let dir = PathBuf::from("planning").join("attachments");
        assert_eq!(planning_attachment_path(&dir, 2, &image), dir.join("image_2.png"));
        let image = ImageAttachment { name: Some("/tmp/other".into()), ..image };
        assert_eq!(planning_attachment_path(&dir, 2, &image), dir.join("image_2.png"));
    }

    #[test]
    fn local_http_boundary_rejects_other_ports_and_malformed_origins() {
        assert!(is_trusted_host("127.0.0.1:1421", 1421));
        assert!(is_trusted_host("localhost:1421", 1421));
        assert!(!is_trusted_host("localhost:1420", 1421));
        assert!(!is_trusted_host("0.0.0.0:1421", 1421));
        assert!(!is_trusted_host("localhost:1421.evil.com", 1421));
        assert!(!is_trusted_host("localhost:1421@evil.com", 1421));
        assert!(!is_trusted_host("evil.com:1421", 1421));

        assert!(is_trusted_origin("http://localhost:1420", 1421));
        assert!(is_trusted_origin("http://127.0.0.1:1420", 1421));
        assert!(is_trusted_origin("http://localhost:1421", 1421));
        assert!(!is_trusted_origin("http://localhost:5173", 1421));
        assert!(!is_trusted_origin("http://127.0.0.1:3000", 1421));
        assert!(!is_trusted_origin("http://evil.com", 1421));
        assert!(!is_trusted_origin("http://localhost.evil.com:1420", 1421));
        assert!(!is_trusted_origin("http://localhost:1420.evil.com", 1421));
        assert!(!is_trusted_origin("http://localhost:1420/path", 1421));
        assert!(!is_trusted_origin("http://localhost:1420@evil.com", 1421));
        assert!(!is_trusted_origin("null", 1421));
        assert!(!is_trusted_origin("tauri://localhost", 1421));
        assert!(origin_matches_allowlist("https://example.com:443", "https://example.com:443"));
        assert!(!origin_matches_allowlist("https://example.com.evil", "https://example.com"));
        assert!(!origin_matches_allowlist("http://example.com/path", "http://example.com/path"));
        assert!(!origin_matches_allowlist("http://", "http://"));
    }

    #[test]
    fn list_files_and_list_skills_dispatch() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().join("runtime");
        let service = Arc::new(Service {
            runtime: Mutex::new(Runtime::open(&root).unwrap()),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });

        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join("src")).unwrap();
        fs::write(repo.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(repo.join("package.json"), "{}").unwrap();

        let skill_dir = repo.join(".agents").join("skills").join("my-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: my-skill\ndescription: Test skill description\n---\n# My Skill\n",
        )
        .unwrap();

        let files_res = dispatch(
            &service,
            "list_files",
            serde_json::json!({ "repository": repo.to_string_lossy() }),
        )
        .unwrap();
        let files: Vec<String> = serde_json::from_value(files_res["files"].clone()).unwrap();
        assert!(files.contains(&"package.json".to_string()));
        assert!(files.contains(&"src/main.rs".to_string()));

        let skills_res = dispatch(
            &service,
            "list_skills",
            serde_json::json!({ "repository": repo.to_string_lossy() }),
        )
        .unwrap();
        let skills: Vec<serde_json::Value> =
            serde_json::from_value(skills_res["skills"].clone()).unwrap();
        assert!(skills.iter().any(|s| s["name"] == "my-skill" && s["scope"] == "workspace"));
    }

    #[test]
    fn planning_preflight_checks_model_format() {
        let mut config = Config {
            repository: "/tmp/fake".into(),
            model: "".into(),
            thinking_level: "medium".into(),
            max_parallel: 4,
            max_feedback: 3, auto_approve: false,
            #[cfg(feature = "fixture")]
            engine: "pi".into(),
            #[cfg(feature = "fixture")]
            pi_command: "node".into(),
            #[cfg(feature = "fixture")]
            pi_args: vec![],
        };

        // 1. Empty model fails preflight
        let err = validate_planning_preflight(&config, None).unwrap_err();
        assert!(err.contains("is not configured"));

        // 2. Model without provider prefix fails preflight
        config.model = "qwen3.8-flash".into();
        let err = validate_planning_preflight(&config, None).unwrap_err();
        assert!(err.contains("is missing a provider prefix"));

        // 3. Model with valid provider prefix passes preflight format check
        config.model = "openai/gpt-4o".into();
        assert!(validate_planning_preflight(&config, None).is_ok());
    }

    #[cfg(not(feature = "fixture"))]
    #[test]
    fn planning_preflight_fetches_catalog_only_once_for_both_roles() {
        let config = Config {
            repository: "/tmp/fake".into(),
            model: "example/test".into(),
            thinking_level: "medium".into(),
            max_parallel: 2,
            max_feedback: 0, auto_approve: false,
        };
        let calls = std::cell::Cell::new(0);
        let fetch = || {
            calls.set(calls.get() + 1);
            Some(serde_json::json!({ "result": { "providers": [] } }))
        };
        validate_planning_models_preflight(&config, None, &fetch).unwrap();
        assert_eq!(calls.get(), 1);

        calls.set(0);
        let unavailable = || {
            calls.set(calls.get() + 1);
            None
        };
        validate_planning_models_preflight(&config, None, &unavailable).unwrap();
        assert_eq!(calls.get(), 1); // A failed lookup is also reused.

        calls.set(0);
        let partitioner_model = PiModelConfig::resolve(PiRole::Partitioner, &config).model;
        let provider = partitioner_model.split('/').next().unwrap();
        let unauthenticated = || {
            calls.set(calls.get() + 1);
            Some(serde_json::json!({ "result": { "providers": [{ "id": provider, "configured": false }] } }))
        };
        let error = validate_planning_models_preflight(&config, None, &unauthenticated).unwrap_err();
        assert!(error.contains("not authenticated"));
        assert!(error.contains(&partitioner_model));
        assert_eq!(calls.get(), 1);

        let catalog = std::cell::OnceCell::new();
        validate_role_model_preflight(PiRole::Partitioner, "invalid", &catalog, &fetch).unwrap_err();
        assert!(catalog.get().is_none()); // Invalid format still fails before the lookup.
    }

    #[test]
    fn save_config_updates_bootstrap_and_persists() {
        let temp_dir = tempfile::tempdir().unwrap();
        let runtime = crate::runtime::Runtime::open(temp_dir.path()).unwrap();
        let service = Arc::new(Service {
            runtime: std::sync::Mutex::new(runtime),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: temp_dir.path().to_path_buf(),
        });

        // 1. Initial bootstrap has empty model
        let initial = bootstrap(&service, false).unwrap();
        assert_eq!(initial.config.model, "");
        assert!(!initial.config.auto_approve);
        let mut legacy = serde_json::to_value(&initial.config).unwrap();
        legacy.as_object_mut().unwrap().remove("autoApprove");
        assert!(!serde_json::from_value::<Config>(legacy).unwrap().auto_approve);
        assert_eq!(initial.effective_role_models.get("planner").unwrap(), "");

        // 2. Save new config with valid model
        let new_config = Config {
            repository: temp_dir.path().to_string_lossy().into(),
            model: "openai/gpt-4o".into(),
            thinking_level: "high".into(),
            max_parallel: 2,
            max_feedback: 3, auto_approve: true,
            #[cfg(feature = "fixture")]
            engine: "pi".into(),
            #[cfg(feature = "fixture")]
            pi_command: "node".into(),
            #[cfg(feature = "fixture")]
            pi_args: vec![],
        };
        let updated = save_config(new_config.clone(), &service).unwrap();
        assert_eq!(updated.config.model, "openai/gpt-4o");
        assert_eq!(updated.config.thinking_level, "high");
        assert!(updated.config.auto_approve);
        assert_eq!(updated.effective_role_models.get("planner").unwrap(), "openai/gpt-4o");
        assert_eq!(updated.effective_role_models.get("partitioner").unwrap(), "openai/gpt-4o");
        assert_eq!(updated.effective_role_models.get("nodeAgent").unwrap(), "openai/gpt-4o");

        // 3. Verify config.json file was written
        let config_file = temp_dir.path().join("config.json");
        assert!(config_file.exists());
        let saved_disk: Config = serde_json::from_str(&fs::read_to_string(&config_file).unwrap()).unwrap();
        assert_eq!(saved_disk.model, "openai/gpt-4o");
        assert_eq!(saved_disk.thinking_level, "high");
        assert!(saved_disk.auto_approve);

        // 4. Verify new bootstrap reloads the persisted config
        let reloaded = bootstrap(&service, false).unwrap();
        assert_eq!(reloaded.config.model, "openai/gpt-4o");
        assert_eq!(reloaded.config.thinking_level, "high");
        assert!(reloaded.config.auto_approve);
        assert_eq!(reloaded.effective_role_models.get("planner").unwrap(), "openai/gpt-4o");
    }
