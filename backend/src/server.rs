use crate::{
    compiler,
    engine::{parse_route_decision, run_pi, PiModelConfig, PiRequest, PiRole},
    model::*,
    runtime::{perform_with_merger, Runtime},
    snapshot_view::{execution_page, snapshot_metadata},
};
use serde::Serialize;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

use uuid::Uuid;

pub struct Service {
    runtime: Mutex<Runtime>,
    driving: AtomicBool,
    planning: AtomicBool,
    extension: PathBuf,
}

// Worker logs flow through one bounded-batch event writer rather than each
// worker acquiring Runtime's mutex on every output chunk. A flush barrier
// commits all earlier output before that worker emits Finished/Failed.
enum OutputMessage {
    Text { execution_id: String, text: String },
    Flush(std::sync::mpsc::Sender<Result<(), String>>),
}

fn persist_outputs(service: Arc<Service>, rx: std::sync::mpsc::Receiver<OutputMessage>) {
    let mut failure: Option<String> = None;
    while let Ok(first) = rx.recv() {
        let mut events = Vec::with_capacity(64);
        let mut barrier = None;
        let mut next = Some(first);
        loop {
            match next.take() {
                Some(OutputMessage::Text { execution_id, text }) => {
                    events.push(EventKind::Output { execution_id, text });
                }
                Some(OutputMessage::Flush(reply)) => barrier = Some(reply),
                None => break,
            }
            if barrier.is_some() || events.len() == 64 { break; }
            next = rx.try_recv().ok();
        }
        if failure.is_none() && !events.is_empty() {
            failure = service.runtime.lock().map_err(|e| e.to_string())
                .and_then(|mut runtime| runtime.emit_outputs(events)).err();
            if let Some(error) = &failure { eprintln!("Cannot persist Pi output: {error}"); }
        }
        if let Some(reply) = barrier {
            let _ = reply.send(failure.clone().map_or(Ok(()), Err));
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    snapshot: serde_json::Value,
    config: Config,
    runs: Vec<String>,
    data_path: String,
    repository_info: Option<crate::workspace::RepositoryInfo>,
    pub effective_role_models: std::collections::HashMap<String, String>,
    pub env_overrides: std::collections::HashMap<String, String>,
}

const PARTITIONER_PROMPT: &str = include_str!("../resources/prompts/partitioner.md");
const PLANNER_PROMPT: &str = include_str!("../resources/prompts/planner.md");

#[cfg(test)]
mod prompt_tests {
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
        fs::write(&script, r#"printf '%s' '{"originalGoal":"test","nodes":[{"name":"change","task":"updated"},{"name":"other","task":"other"}],"edges":[]}' > "$GRAPHER_GRAPH_PATH"
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
        fs::write(&script, r#"printf '%s' '{"originalGoal":"test","nodes":[{"name":"work","task":"work"}],"edges":[]}' > "$GRAPHER_GRAPH_PATH"
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
        fs::write(&script, format!(r#"case "$PWD" in
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
}

fn load_env_file() {
    let candidates = [
        PathBuf::from(".env"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.env"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".env"),
    ];
    for path in &candidates {
        if let Ok(content) = fs::read_to_string(path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                if let Some((k, v)) = trimmed.split_once('=') {
                    let k = k.trim();
                    let v = v.trim().trim_matches('"').trim_matches('\'');
                    if std::env::var(k).is_err() {
                        std::env::set_var(k, v);
                    }
                }
            }
            break;
        }
    }
}

fn bootstrap(service: &Arc<Service>, metadata: bool) -> Result<Bootstrap, String> {
    load_env_file();
    let active_config = if service.planning.load(Ordering::SeqCst) {
        let active = list_plannings(service, None)?
            .into_iter()
            .find(|summary| summary.status.as_deref() == Some("running"));
        let root = service
            .runtime
            .lock()
            .map_err(|e| e.to_string())?
            .root
            .clone();
        active
            .and_then(|summary| {
                fs::read(
                    root.join("planning")
                        .join(summary.planning_id)
                        .join("request.json"),
                )
                .ok()
            })
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| serde_json::from_value::<Config>(value["config"].clone()).ok())
    } else {
        None
    };
    let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    #[cfg(feature = "fixture")]
    let entrypoint = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../engine/entrypoint.mjs");
    let detected_repo = crate::workspace::detect(None).ok().flatten();
    let saved_config_on_disk = {
        let path = runtime.root.join("config.json");
        if let Ok(bytes) = fs::read(&path) {
            serde_json::from_slice::<Config>(&bytes).ok()
        } else {
            None
        }
    };
    let mut config = active_config
        .or(saved_config_on_disk)
        .or_else(|| {
            let mut cfg = runtime.state.config.clone()?;
            if !cfg.model.is_empty() && !cfg.model.contains('/') {
                cfg.model = String::new();
            }
            Some(cfg)
        })
        .unwrap_or(Config {
            repository: detected_repo
                .as_ref()
                .map(|r| r.path.clone())
                .unwrap_or_default(),
            model: String::new(),
            thinking_level: "medium".into(),
            max_parallel: 4,
            max_feedback: 3, auto_approve: false,
            #[cfg(feature = "fixture")]
            engine: "pi".into(),
            #[cfg(feature = "fixture")]
            pi_command: "node".into(),
            #[cfg(feature = "fixture")]
            pi_args: vec![entrypoint.to_string_lossy().into()],
        });
    config.max_feedback = config.max_feedback.min(3);
    if config.repository.is_empty() {
        if let Some(ref repo) = detected_repo {
            config.repository = repo.path.clone();
        }
    }
    let repository_info = if !config.repository.is_empty() {
        if let Some(ref repo) = detected_repo {
            if repo.path == config.repository {
                Some(repo.clone())
            } else {
                crate::workspace::detect(Some(std::path::Path::new(&config.repository)))
                    .ok()
                    .flatten()
            }
        } else {
            crate::workspace::detect(Some(std::path::Path::new(&config.repository)))
                .ok()
                .flatten()
        }
    } else {
        None
    };
    let mut effective_role_models = std::collections::HashMap::new();
    let mut env_overrides = std::collections::HashMap::new();

    let planner_cfg = PiModelConfig::resolve(PiRole::Planner, &config);
    let partitioner_cfg = PiModelConfig::resolve(PiRole::Partitioner, &config);
    let node_cfg = PiModelConfig::resolve(PiRole::NodeAgent, &config);
    let merger_cfg = PiModelConfig::resolve(PiRole::Merger, &config);

    effective_role_models.insert("planner".into(), planner_cfg.model);
    effective_role_models.insert("partitioner".into(), partitioner_cfg.model);
    effective_role_models.insert("nodeAgent".into(), node_cfg.model);
    effective_role_models.insert("merger".into(), merger_cfg.model);

    for (role_name, env_var) in [
        ("planner", "PLANNER_MODEL"),
        ("partitioner", "PARTITIONER_MODEL"),
        ("nodeAgent", "NODE_AGENT_MODEL"),
        ("merger", "MERGER_MODEL"),
    ] {
        if let Ok(val) = std::env::var(env_var) {
            if !val.trim().is_empty() {
                env_overrides.insert(role_name.into(), val);
            }
        }
    }

    Ok(Bootstrap {
        snapshot: if metadata {
            snapshot_metadata(&runtime.state)?
        } else {
            serde_json::to_value(&runtime.state).map_err(|e| e.to_string())?
        },
        config,
        runs: runtime.store.runs()?,
        data_path: runtime.root.to_string_lossy().into(),
        repository_info,
        effective_role_models,
        env_overrides,
    })
}

fn snapshot(service: &Arc<Service>) -> Result<Snapshot, String> {
    Ok(service
        .runtime
        .lock()
        .map_err(|error| error.to_string())?
        .state
        .clone())
}

fn history(run_id: String, service: &Arc<Service>) -> Result<Snapshot, String> {
    service
        .runtime
        .lock()
        .map_err(|error| error.to_string())?
        .store
        .load(&run_id)
}

fn load_run(run_id: String, service: &Arc<Service>) -> Result<Snapshot, String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish before switching runs".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    runtime.load_run(&run_id)
}

fn compile_graph(graph: Graph) -> Result<Plan, Vec<compiler::Diagnostic>> {
    compiler::compile(&graph, true)
}

fn save_graph(
    graph: Graph,
    config: Config,
    run_id: Option<String>,
    service: &Arc<Service>,
) -> Result<Snapshot, String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    if let Some(expected) = run_id {
        if runtime.state.run_id != expected {
            return Err("Run changed while editing the graph".into());
        }
        runtime.edit_draft_graph(graph, config)?;
    } else {
        runtime.create(graph, config)?;
        // A new manual Graph IR is a graph even if its only node is "task".
        runtime.set_route("graph")?;
    }
    Ok(runtime.state.clone())
}

fn save_config(mut config: Config, service: &Arc<Service>) -> Result<Bootstrap, String> {
    config.max_feedback = 3;
    let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
    let config_path = runtime.root.join("config.json");
    if let Ok(bytes) = serde_json::to_vec_pretty(&config) {
        let _ = fs::write(&config_path, bytes);
    }
    runtime.state.config = Some(config.clone());
    drop(runtime);
    bootstrap(service, false)
}

pub fn parse_planning_role_metrics(model: &str, log: &str) -> PlanningRoleMetrics {
    let mut session_start = None;
    let mut last_event = None;
    let mut duration_seconds = 0.0;
    let mut assistant_messages = 0;
    let mut tools = 0;
    let mut tool_errors = 0;
    let mut usage = TokenUsage::default();

    for line in log.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("[stderr]") {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if let Some(ts) = value.get("timestamp") {
                let ts_str = if let Some(s) = ts.as_str() {
                    s.to_string()
                } else if let Some(n) = ts.as_u64() {
                    format!("{n}")
                } else {
                    String::new()
                };
                if !ts_str.is_empty() {
                    if session_start.is_none() {
                        session_start = Some(ts_str.clone());
                    }
                    last_event = Some(ts_str);
                }
            }
            match value
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
            {
                "grapher_process_exited" => {
                    if let Some(elapsed) = value.get("elapsedMs").and_then(|v| v.as_f64()) {
                        duration_seconds = elapsed / 1000.0;
                    }
                }
                "message_end" => {
                    if let Some(msg) = value.get("message") {
                        if msg.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                            assistant_messages += 1;
                            if let Some(u) = msg.get("usage") {
                                usage.input +=
                                    u.get("input").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                usage.output +=
                                    u.get("output").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                usage.cache_read +=
                                    u.get("cacheRead").and_then(|v| v.as_u64()).unwrap_or(0)
                                        as usize;
                                usage.cache_write +=
                                    u.get("cacheWrite").and_then(|v| v.as_u64()).unwrap_or(0)
                                        as usize;
                                usage.reasoning +=
                                    u.get("reasoning").and_then(|v| v.as_u64()).unwrap_or(0)
                                        as usize;
                                usage.total_tokens +=
                                    u.get("totalTokens").and_then(|v| v.as_u64()).unwrap_or(0)
                                        as usize;
                            }
                        }
                    }
                }
                "tool_execution_start" => {
                    tools += 1;
                }
                "tool_execution_end" => {
                    if value
                        .get("isError")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        tool_errors += 1;
                    }
                }
                _ => {}
            }
        }
    }

    PlanningRoleMetrics {
        model: model.to_string(),
        session_start,
        last_event,
        duration_seconds,
        assistant_messages,
        tools,
        tool_errors,
        usage,
    }
}

pub fn validate_planning_preflight(config: &Config, mode: Option<&str>) -> Result<(), String> {
    #[cfg(not(feature = "fixture"))]
    if mode == Some("graph") {
        crate::native::require_graph_execution()?;
    }
    validate_planning_models_preflight(config, mode, || {
        #[cfg(not(feature = "fixture"))]
        {
            crate::provider_auth::request(serde_json::json!({
                "version": 1,
                "operation": "catalog",
                "refresh": false
            })).ok()
        }
        #[cfg(feature = "fixture")]
        { None }
    })
}

fn validate_planning_models_preflight(
    config: &Config,
    mode: Option<&str>,
    fetch_catalog: impl Fn() -> Option<serde_json::Value>,
) -> Result<(), String> {
    let need_partitioner = mode.is_none();
    let need_planner = mode != Some("serial");
    // Keep validation order and failure behavior, but reuse one catalog response
    // when both roles need checking. Check each model's format before its lookup.
    let catalog = std::cell::OnceCell::new();

    if need_partitioner {
        let partitioner_cfg = PiModelConfig::resolve(PiRole::Partitioner, config);
        validate_role_model_preflight(PiRole::Partitioner, &partitioner_cfg.model, &catalog, &fetch_catalog)?;
    }
    if need_planner {
        let planner_cfg = PiModelConfig::resolve(PiRole::Planner, config);
        validate_role_model_preflight(PiRole::Planner, &planner_cfg.model, &catalog, &fetch_catalog)?;
    }
    Ok(())
}

fn validate_role_model_preflight(
    role: PiRole,
    model: &str,
    _catalog: &std::cell::OnceCell<Option<serde_json::Value>>,
    _fetch_catalog: &impl Fn() -> Option<serde_json::Value>,
) -> Result<(), String> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Err(format!(
            "Pre-flight check failed: {} model is not configured. Please select or specify a model in settings.",
            role.name()
        ));
    }
    if !trimmed.contains('/') {
        return Err(format!(
            "Pre-flight check failed: {} model '{}' is missing a provider prefix (e.g. 'openai/{}' or 'opencode-go/{}'). Please specify the fully qualified provider/model identifier in settings.",
            role.name(),
            trimmed,
            trimmed,
            trimmed
        ));
    }
    let provider_id = trimmed.split('/').next().unwrap_or("");
    if provider_id.is_empty() {
        return Err(format!(
            "Pre-flight check failed: Invalid model identifier '{}'.",
            trimmed
        ));
    }

    #[cfg(not(feature = "fixture"))]
    {
        let catalog = _catalog.get_or_init(_fetch_catalog);
        if let Some(resp) = catalog {
            if let Some(providers) = resp.get("result").and_then(|r| r.get("providers")).and_then(|p| p.as_array()) {
                if let Some(prov) = providers.iter().find(|p| p.get("id").and_then(|i| i.as_str()) == Some(provider_id)) {
                    let is_configured = prov.get("configured").and_then(|c| c.as_bool()).unwrap_or(false);
                    if !is_configured {
                        return Err(format!(
                            "Pre-flight check failed: Provider '{}' for model '{}' is not authenticated. Please configure API credentials or log in before starting planning.",
                            provider_id,
                            trimmed
                        ));
                    }
                }
            }
        }
    }

    Ok(())
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    const TABLE: [i8; 256] = {
        let mut t = [-1i8; 256];
        let mut i = 0usize;
        while i < 26 { t[(b'A' + i as u8) as usize] = i as i8; i += 1; }
        let mut i = 0usize;
        while i < 26 { t[(b'a' + i as u8) as usize] = (26 + i) as i8; i += 1; }
        let mut i = 0usize;
        while i < 10 { t[(b'0' + i as u8) as usize] = (52 + i) as i8; i += 1; }
        t[b'+' as usize] = 62;
        t[b'/' as usize] = 63;
        t
    };
    let clean: Vec<u8> = input.bytes().filter(|&b| !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &b in &clean {
        if b == b'=' { break; }
        let val = TABLE[b as usize];
        if val < 0 { continue; }
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

fn planner_node_status(snapshot: &Snapshot) -> String {
    let mut text = String::from("Current graph node status:\n");
    for node in &snapshot.graph.nodes {
        if let Some(state) = snapshot.nodes.get(&node.name) {
            text.push_str(&format!("- {}: {}\n", node.name, state.status));
        }
    }
    text
}

fn planner_followup_prompt(instruction: &str, revision_run_id: Option<&str>, snapshot: &Snapshot) -> String {
    if revision_run_id == Some(snapshot.run_id.as_str()) && snapshot.approved
        && snapshot.plan_type.as_deref() == Some("graph") {
        format!("{}\n{}", planner_node_status(snapshot), instruction)
    } else {
        instruction.to_string()
    }
}

/// Planning attempts have separate logs/graph files, but a run has exactly one
/// Planner conversation. Older runs kept the Pi session in their first planning
/// attempt; manual graphs (and attempts without a persisted session) use a
/// dedicated run-scoped directory instead.
fn stored_planner_session_id(
    directory: &std::path::Path,
    repository: &std::path::Path,
    expected: &str,
) -> Result<Option<String>, String> {
    if !directory.is_dir() { return Ok(None); }
    let repository = repository.canonicalize().map_err(|error| error.to_string())?;
    let mut ids = std::collections::BTreeSet::new();
    let mut found_file = false;
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.path().extension().is_none_or(|ext| ext != "jsonl") ||
            !entry.file_type().map_err(|error| error.to_string())?.is_file() { continue; }
        found_file = true;
        // Pi's first JSONL entry is the session header. A corrupt or foreign
        // session must not silently start a second conversation.
        let mut header = String::new();
        BufReader::new(fs::File::open(entry.path()).map_err(|error| error.to_string())?)
            .take(8192).read_line(&mut header).map_err(|error| error.to_string())?;
        let value: serde_json::Value = serde_json::from_str(&header)
            .map_err(|_| "Invalid Planner session header".to_string())?;
        let id = value.get("id").and_then(|id| id.as_str()).ok_or("Missing Planner session ID")?;
        let cwd = value.get("cwd").and_then(|cwd| cwd.as_str()).ok_or("Missing Planner session repository")?;
        if value.get("type").and_then(|kind| kind.as_str()) != Some("session")
            || Uuid::parse_str(id).is_err()
            || std::path::Path::new(cwd).canonicalize().ok().as_deref() != Some(repository.as_path()) {
            return Err("Planner session belongs to another repository or is invalid".into());
        }
        ids.insert(id.to_string());
    }
    if !found_file { return Ok(None); }
    if ids.contains(expected) { return Ok(Some(expected.to_string())); }
    if ids.len() == 1 { return Ok(ids.into_iter().next()); } // Legacy session with a random Pi ID.
    Err("Multiple Planner conversations found for one run; cannot select one safely".into())
}

fn planner_session_directory(
    root: &std::path::Path,
    attempt: &std::path::Path,
    repository: &std::path::Path,
    revision: Option<&Snapshot>,
) -> Result<(PathBuf, String), String> {
    let Some(snapshot) = revision else {
        let id = attempt.file_name().and_then(|name| name.to_str()).ok_or("Invalid planning identity")?;
        return Ok((attempt.join("planner-session"), id.to_string()));
    };
    if Uuid::parse_str(&snapshot.run_id).is_err() {
        return Err("Invalid run identity for Planner session".into());
    }
    // Prefer the oldest surviving conversation, not the latest attempt. Its
    // directory and Pi ID are stable across retries, reloads, and revisions.
    let mut prior_planner_attempt = false;
    for event in &snapshot.events {
        let id = match &event.kind {
            EventKind::Created { planning_id: Some(id), .. } | EventKind::GraphRevised { planning_id: id, .. } => id,
            _ => continue,
        };
        if Uuid::parse_str(id).is_err() { continue; }
        prior_planner_attempt = true;
        let session = root.join("planning").join(id).join("planner-session");
        if let Some(pi_id) = stored_planner_session_id(&session, repository, id)? {
            return Ok((session, pi_id));
        }
    }
    let session = root.join("planner-sessions").join(&snapshot.run_id);
    if let Some(id) = stored_planner_session_id(&session, repository, &snapshot.run_id)? {
        return Ok((session, id));
    }
    // A committed Planner turn with a missing session cannot safely start a
    // new conversation. Fixtures do not persist Pi session files.
    if prior_planner_attempt && !cfg!(feature = "fixture") {
        return Err("Planner conversation is missing; cannot silently start a new session".into());
    }
    Ok((session, snapshot.run_id.clone()))
}

fn plan_goal_internal(
    goal: String,
    config: Config,
    mode: Option<&str>,
    images: Option<Vec<crate::model::ImageAttachment>>,
    revision_run_id: Option<String>,
    service: &Arc<Service>,
    mut on_partitioner_line: impl FnMut(&str),
    mut on_route: impl FnMut(&Route),
    mut on_planner_line: impl FnMut(&str),
) -> Result<Snapshot, (String, Option<PlanningSummary>)> {
    if goal.trim().is_empty() {
        return Err(("Enter a goal".into(), None));
    }
    let mut config = config;
    config.max_feedback = config.max_feedback.min(3);
    #[cfg(feature = "fixture")]
    if config.engine != "pi" {
        return Err((
            "Automatic planning requires the Execution Instance Engine".into(),
            None,
        ));
    }
    if revision_run_id.is_none() && service.driving.load(Ordering::SeqCst) {
        return Err(("Another operation is running".into(), None));
    }
    // Allow up to 1.5s if an explicitly interrupted planning process is terminating.
    let mut acquired = false;
    for _ in 0..30 {
        if !service.planning.swap(true, Ordering::SeqCst) {
            acquired = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if !acquired {
        return Err(("Another operation is running".into(), None));
    }
    let service = service.clone();
    let cleanup = service.clone();
    let mut resume_after = false;
    let result = (|| {
        let original_graph = if let Some(ref run_id) = revision_run_id {
            if mode != Some("graph") {
                return Err(("Graph revisions require graph mode".into(), None));
            }
            let runtime = service.runtime.lock().map_err(|error| (error.to_string(), None))?;
            if runtime.state.run_id != *run_id
                || runtime.state.plan_type.as_deref() != Some("graph")
                || runtime.state.config.as_ref().map(|c| c.repository.as_str()) != Some(config.repository.as_str())
                || matches!(runtime.state.phase.as_str(), "publishing" | "merging" | "publication_failed") {
                return Err(("Graph is no longer available for revision".into(), None));
            }
            Some(runtime.state.graph.clone())
        } else { None };
        let service = service.clone();
        let planning_start = std::time::Instant::now();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let root = service
            .runtime
            .lock()
            .map_err(|error| (error.to_string(), None))?
            .root
            .clone();
        let repository = PathBuf::from(&config.repository);
        let repo_str = repository.to_string_lossy().to_string();
        crate::workspace::verify(&repository).map_err(|error| (error, None))?;
        validate_planning_preflight(&config, mode).map_err(|error| (error, None))?;
        let planning_id = Uuid::new_v4().to_string();
        let directory = root.join("planning").join(&planning_id);
        fs::create_dir_all(&directory).map_err(|error| (error.to_string(), None))?;
        fs::write(
            directory.join("request.json"),
            serde_json::to_vec(&serde_json::json!({
                "goal": goal, "config": config, "mode": mode, "revisionRunId": revision_run_id
            }))
            .map_err(|e| (e.to_string(), None))?,
        )
        .map_err(|e| (e.to_string(), None))?;
        // Publish identity before launching Pi; a browser connection does not own planning.
        let running = PlanningSummary {
            planning_id: planning_id.clone(),
            status: Some("running".into()),
            created_at: Some(now_ms),
            repository: Some(repo_str.clone()),
            roles: ["partition", "planner"]
                .into_iter()
                .map(|role| (role.to_string(), PlanningRoleMetrics::default()))
                .collect(),
            ..Default::default()
        };
        write_planning_summary(&directory, &running).map_err(|error| (error, None))?;
        let mut image_file_args: Vec<String> = Vec::new();
        if let Some(ref imgs) = images {
            if !imgs.is_empty() {
                let attach_dir = directory.join("attachments");
                let _ = fs::create_dir_all(&attach_dir);
                for (idx, img) in imgs.iter().enumerate() {
                    let file_path = planning_attachment_path(&attach_dir, idx, img);
                    if let Some(bytes) = decode_base64(&img.data) {
                        if fs::write(&file_path, bytes).is_ok() {
                            if let Ok(canon) = file_path.canonicalize() {
                                image_file_args.push(format!("@{}", canon.to_string_lossy()));
                            } else {
                                image_file_args.push(format!("@{}", file_path.to_string_lossy()));
                            }
                        }
                    }
                }
            }
        }
        let plan_outcome = (|| -> Result<Snapshot, String> {
            let route_path = directory.join("route.json");
            let (route, partition_metrics) = match mode {
                Some("serial") => {
                    let route = Route {
                        plan_type: "serial".into(),
                    };
                    fs::write(&route_path, serde_json::to_string_pretty(&route).unwrap())
                        .map_err(|error| error.to_string())?;
                    on_route(&route);
                    (route, PlanningRoleMetrics::default())
                }
                Some("graph") => {
                    let route = Route {
                        plan_type: "graph".into(),
                    };
                    fs::write(&route_path, serde_json::to_string_pretty(&route).unwrap())
                        .map_err(|error| error.to_string())?;
                    on_route(&route);
                    (route, PlanningRoleMetrics::default())
                }
                _ => {
                    let partitioner_system_prompt = std::env::var("PARTITIONER_SYSTEM_PROMPT")
                        .unwrap_or_else(|_| PARTITIONER_PROMPT.trim().to_string());
                    let task = goal.clone();
                    let partitioner_model_cfg = PiModelConfig::resolve(PiRole::Partitioner, &config);
                    let partitioner_config = partitioner_model_cfg.effective_config(&config);
                    let mut partitioner_extra_args = vec!["--no-tools", "--no-context-files"];
                    if let Some(thinking) = &partitioner_model_cfg.thinking {
                        partitioner_extra_args.push("--thinking");
                        partitioner_extra_args.push(thinking.as_str());
                    }
                    for arg in &image_file_args {
                        partitioner_extra_args.push(arg.as_str());
                    }
                    let mut log = String::new();
                    let mut partition_log =
                        fs::File::create(directory.join("partition.jsonl")).map_err(|e| e.to_string())?;
                    let mut log_error = None;
                    let partition_start = std::time::Instant::now();
                    let partition_result = run_pi(
                        PiRequest {
                            role: PiRole::Partitioner,
                            config: &partitioner_config,
                            cwd: &repository,
                            task: &task,
                            session_dir: &directory.join("partition-session"),
                            extension: None,
                            tools: Some(""),
                            session_id: None,
                            extra_args: partitioner_extra_args,
                            environment: vec![
                                ("GRAPHER_MODE", "partition".into()),
                                ("GRAPHER_GRAPH_PATH", route_path.to_string_lossy().into()),
                            ],
                            system_prompt: Some(&partitioner_system_prompt),
                            images: None,
                        },
                        |text| {
                            if let Err(error) = partition_log.write_all(text.as_bytes()) {
                                log_error = Some(error.to_string());
                            }
                            log.push_str(&text);
                            on_partitioner_line(&text);
                        },
                    );
                    let partition_wall_sec = partition_start.elapsed().as_secs_f64();
                    if let Some(error) = log_error {
                        return Err(format!("Cannot persist planning output: {error}"));
                    }
                    let mut partition_metrics =
                        parse_planning_role_metrics(&partitioner_config.model, &log);
                    if partition_metrics.duration_seconds == 0.0 {
                        partition_metrics.duration_seconds = partition_wall_sec;
                    }
                    // A failed engine call is not a routing decision. In particular, do not
                    // turn authentication/provider failures into an auto-approved serial run.
                    let output =
                        partition_result.map_err(|error| format!("Partitioner failed: {error}"))?;
                    let route = parse_route_decision(&output);
                    fs::write(&route_path, serde_json::to_string_pretty(&route).unwrap())
                        .map_err(|error| error.to_string())?;
                    on_route(&route);
                    eprintln!(
                        "[Grapher] [Router] Goal routed as '{}' in {:.2}s (tokens: in={}, out={})",
                        route.plan_type, partition_metrics.duration_seconds, partition_metrics.usage.input, partition_metrics.usage.output
                    );
                    (route, partition_metrics)
                }
            };
            let mut planner_metrics = None;
            let graph = match route.plan_type.as_str() {
                "serial" => Graph {
                    original_goal: goal.clone(),
                    nodes: vec![Node {
                        name: "task".into(),
                        task: goal.clone(),
                    }],
                    edges: Vec::new(),
                },
                "graph" => {
                    let graph_path = directory.join("graph.json");
                    fs::write(
                        &graph_path,
                        serde_json::to_string(&original_graph.clone().unwrap_or_else(|| Graph {
                            original_goal: goal.clone(),
                            ..Graph::default()
                        }))
                        .unwrap(),
                    )
                    .map_err(|error| error.to_string())?;
                    let planner_model_cfg = PiModelConfig::resolve(PiRole::Planner, &config);
                    let planner_config = planner_model_cfg.effective_config(&config);
                    let planner_system_prompt = std::env::var("PLANNER_SYSTEM_PROMPT")
                        .unwrap_or_else(|_| PLANNER_PROMPT.trim().to_string());
                    // Append dynamic state only to the new user turn, never to
                    // the shared system prompt or previous Planner turns.
                    let task = {
                        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                        planner_followup_prompt(&goal, revision_run_id.as_deref(), &runtime.state)
                    };
                    let mut planner_extra_args = Vec::new();
                    if let Some(thinking) = &planner_model_cfg.thinking {
                        planner_extra_args.push("--thinking");
                        planner_extra_args.push(thinking.as_str());
                    }
                    for arg in &image_file_args {
                        planner_extra_args.push(arg.as_str());
                    }
                    let (planner_session_dir, planner_session_id) = {
                        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                        planner_session_directory(
                            &root, &directory, &repository,
                            original_graph.as_ref().map(|_| &runtime.state),
                        )?
                    };
                    let mut log = String::new();
                    // Each attempt retains its own stream/metrics for recovery;
                    // only Pi's private conversation directory is shared.
                    let mut planner_log = fs::File::create(directory.join("planner.jsonl"))
                        .map_err(|e| e.to_string())?;
                    let mut log_error = None;
                    let planner_start = std::time::Instant::now();
                    let planner_result = run_pi(
                        PiRequest {
                            role: PiRole::Planner,
                            config: &planner_config,
                            cwd: &repository,
                            task: &task,
                            session_dir: &planner_session_dir,
                            extension: Some(&service.extension),
                            tools: Some("node,edge,read,bash"),
                            session_id: Some(&planner_session_id),
                            extra_args: planner_extra_args,
                            environment: vec![
                                ("GRAPHER_MODE", "planner".into()),
                                ("GRAPHER_PLANNER_RUN_ID", revision_run_id.clone().unwrap_or_default()),
                                ("GRAPHER_GRAPH_PATH", graph_path.to_string_lossy().into()),
                                (
                                    "GRAPHER_COMPILER_PATH",
                                    std::env::current_exe()
                                        .map_err(|error| error.to_string())?
                                        .to_string_lossy()
                                        .into(),
                                ),
                            ],
                            system_prompt: Some(&planner_system_prompt),
                            images: None,
                        },
                        |text| {
                            if let Err(error) = planner_log.write_all(text.as_bytes()) {
                                log_error = Some(error.to_string());
                            }
                            log.push_str(&text);
                            on_planner_line(&text);
                        },
                    );
                    let planner_wall_sec = planner_start.elapsed().as_secs_f64();
                    if let Some(error) = log_error {
                        return Err(format!("Cannot persist planning output: {error}"));
                    }
                    let mut m = parse_planning_role_metrics(&planner_config.model, &log);
                    if m.duration_seconds == 0.0 {
                        m.duration_seconds = planner_wall_sec;
                    }
                    planner_metrics = Some(m);
                    planner_result?;
                    serde_json::from_str(
                        &fs::read_to_string(graph_path).map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| error.to_string())?
                }
                _ => return Err("Partitioner returned an invalid route".into()),
            };
            let total_planning_duration = planning_start.elapsed().as_secs_f64();
            let model_duration = partition_metrics.duration_seconds
                + planner_metrics
                    .as_ref()
                    .map(|p| p.duration_seconds)
                    .unwrap_or(0.0);
            let mut roles = std::collections::BTreeMap::new();
            roles.insert("partition".to_string(), partition_metrics);
            if let Some(m) = planner_metrics {
                roles.insert("planner".to_string(), m);
            }
            if let Some(m) = roles.get("planner") {
                eprintln!(
                    "[Grapher] [Planner] Plan compiled: {} nodes, {} edges in {:.2}s (tokens: {}, tools: {}, errors: {})",
                    graph.nodes.len(),
                    graph.edges.len(),
                    m.duration_seconds,
                    m.usage.total_tokens,
                    m.tools,
                    m.tool_errors
                );
            }

            let summary = PlanningSummary {
                planning_id: planning_id.clone(),
                roles,
                total_planning_duration,
                model_duration,
                status: Some("success".to_string()),
                error: None,
                created_at: Some(now_ms),
                repository: Some(repo_str.clone()),
            };

            let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
            if let Some(ref run_id) = revision_run_id {
                if runtime.state.run_id != *run_id {
                    return Err("Run changed during graph revision".into());
                }
                if runtime.state.approved {
                    // Validate before any pause. Unaffected executions keep running;
                    // only when an affected job is in flight do we stop scheduling
                    // new work and wait for that job to finish before invalidation.
                    compiler::compile(&graph, true).map_err(|errors| serde_json::to_string(&errors).unwrap_or_default())?;
                    loop {
                        let affected = runtime.revision_affected(&graph);
                        let busy = runtime.state.executions.iter().any(|execution|
                            execution.status == "running" && affected.contains(&execution.node));
                        if !busy { break; }
                        if !runtime.state.paused {
                            runtime.pause(true)?;
                            resume_after = true;
                        }
                        drop(runtime);
                        thread::sleep(std::time::Duration::from_millis(50));
                        runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                        if runtime.state.run_id != *run_id { return Err("Run changed during graph revision".into()); }
                    }
                    runtime.revise_graph(graph, summary.clone())?;
                } else {
                    runtime.update_draft_graph(graph, planning_id.clone(), summary.clone())?;
                }
            } else {
                runtime.create_with_planning(graph, config.clone(), Some(planning_id.clone()), Some(summary.clone()))?;
                runtime.set_route(&route.plan_type)?;
            }
            if (route.plan_type == "serial" && revision_run_id.is_none())
                || (route.plan_type == "graph" && config.auto_approve && !runtime.state.approved) {
                runtime.approve()?;
            }
            let snapshot = runtime.state.clone();
            drop(runtime);
            write_planning_summary(&directory, &summary)?;
            if snapshot.approved && (route.plan_type == "serial" || config.auto_approve) {
                drive(service.clone());
            }
            Ok(snapshot)
        })();
        match plan_outcome {
            Ok(snapshot) => Ok(snapshot),
            Err(err) => {
                let mut roles: std::collections::BTreeMap<String, PlanningRoleMetrics> =
                    Default::default();
                let mut model_duration = 0.0;
                let partition_file = directory.join("partition.jsonl");
                if partition_file.exists() {
                    if let Ok(content) = fs::read_to_string(&partition_file) {
                        let partitioner_model_cfg =
                            PiModelConfig::resolve(PiRole::Partitioner, &config);
                        let partitioner_config = partitioner_model_cfg.effective_config(&config);
                        let m = parse_planning_role_metrics(&partitioner_config.model, &content);
                        model_duration += m.duration_seconds;
                        roles.insert("partition".into(), m);
                    }
                }
                let planner_file = directory.join("planner.jsonl");
                if planner_file.exists() {
                    if let Ok(content) = fs::read_to_string(&planner_file) {
                        let planner_model_cfg = PiModelConfig::resolve(PiRole::Planner, &config);
                        let planner_config = planner_model_cfg.effective_config(&config);
                        let m = parse_planning_role_metrics(&planner_config.model, &content);
                        model_duration += m.duration_seconds;
                        roles.insert("planner".into(), m);
                    }
                }
                let failure_summary = PlanningSummary {
                    planning_id: planning_id.clone(),
                    roles,
                    total_planning_duration: planning_start.elapsed().as_secs_f64(),
                    model_duration,
                    status: Some("failed".to_string()),
                    error: Some(err.clone()),
                    created_at: Some(now_ms),
                    repository: Some(repo_str.clone()),
                };
                if let Err(error) = write_planning_summary(&directory, &failure_summary) {
                    eprintln!("Cannot persist planning failure: {error}");
                }
                Err((err, Some(failure_summary)))
            }
        }
    })();
    cleanup.planning.store(false, Ordering::SeqCst);
    if resume_after {
        if let Ok(mut runtime) = service.runtime.lock() {
            if runtime.state.approved && runtime.state.paused && runtime.state.phase == "paused" {
                let _ = runtime.pause(false);
            }
        }
    }
    if revision_run_id.is_some() && service.runtime.lock().map(|runtime| {
        runtime.state.phase == "running" && !runtime.state.paused
    }).unwrap_or(false) {
        drive(service.clone());
    }
    // A temporary pause is already undone; return that state rather than the
    // snapshot captured while the affected workers were being drained.
    result.map(|snapshot| {
        if resume_after {
            service.runtime.lock().map(|runtime| runtime.state.clone()).unwrap_or(snapshot)
        } else { snapshot }
    })
}

fn write_planning_summary(
    directory: &std::path::Path,
    summary: &PlanningSummary,
) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(summary).map_err(|e| e.to_string())?;
    let pending = directory.join("summary.pending");
    fs::write(&pending, &json).map_err(|e| e.to_string())?;
    fs::rename(pending, directory.join("summary.json")).map_err(|e| e.to_string())?;
    Ok(())
}

fn recover_plannings(root: &std::path::Path) -> Result<(), String> {
    if let Ok(entries) = fs::read_dir(root.join("planning")) {
        for entry in entries.flatten() {
            if let Ok(content) = fs::read(entry.path().join("summary.json")) {
                if let Ok(mut summary) = serde_json::from_slice::<PlanningSummary>(&content) {
                    if summary.status.as_deref() == Some("running") {
                        summary.status = Some("failed".into());
                        summary.error = Some("Backend stopped during planning. Saved output is preserved; start a new planning attempt.".into());
                        write_planning_summary(&entry.path(), &summary)?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn plan_goal(
    goal: String,
    config: Config,
    mode: Option<String>,
    images: Option<Vec<crate::model::ImageAttachment>>,
    service: &Arc<Service>,
) -> Result<Snapshot, String> {
    plan_goal_internal(
        goal,
        config,
        mode.as_deref(),
        images,
        None,
        service,
        |_| {},
        |_| {},
        |_| {},
    )
    .map_err(|(error, _)| error)
}

fn drive(service: Arc<Service>) {
    if service.driving.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        let (output_tx, output_rx) = std::sync::mpsc::sync_channel(256);
        let writer_service = service.clone();
        let writer = thread::spawn(move || persist_outputs(writer_service, output_rx));
        let result = (|| -> Result<(), String> {
            let (completed_tx, completed_rx) = std::sync::mpsc::channel();
            let mut in_flight = 0usize;
            let mut feedback_results = Vec::new();
            loop {
                let (jobs, root, parents) = {
                    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                    let feedback_barrier =
                        in_flight > 0 && runtime.state.graph.edges.iter().any(|edge| edge.feedback);
                    let jobs = if feedback_barrier {
                        Vec::new()
                    } else {
                        runtime.jobs_with_publication(!service.planning.load(Ordering::SeqCst))?
                    };
                    let parents: Vec<_> = jobs
                        .iter()
                        .map(|job| runtime.parents(&job.execution.node))
                        .collect();
                    (jobs, runtime.root.clone(), parents)
                };
                if jobs.is_empty() && in_flight == 0 {
                    if service.planning.load(Ordering::SeqCst) {
                        thread::sleep(std::time::Duration::from_millis(50));
                        continue;
                    }
                    // PublicationStarted is durable before any user files change.
                    let publication = {
                        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                        if runtime.state.phase == "publishing" {
                            Some((
                                runtime.state.config.clone().ok_or("Missing config")?,
                                runtime.state.graph.original_goal.clone(),
                                runtime
                                    .state
                                    .publication
                                    .clone()
                                    .ok_or("Missing publication state")?,
                            ))
                        } else {
                            None
                        }
                    };
                    if let Some((config, query, publication)) = publication {
                        let repository = PathBuf::from(&publication.repository);
                        let result = crate::graph_merge::merge_graph(
                            &repository,
                            &publication.heads,
                            || {
                                let attempt = service
                                    .runtime
                                    .lock()
                                    .map_err(|e| e.to_string())?
                                    .state
                                    .mergers
                                    .len()
                                    + 1;
                                crate::graph_merge::resolve_with_merger(
                                    &repository,
                                    &query,
                                    &config,
                                    &root,
                                    attempt,
                                    |event| {
                                        service
                                            .runtime
                                            .lock()
                                            .map_err(|e| e.to_string())?
                                            .emit(event)
                                    },
                                )
                            },
                        );
                        let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
                        match result {
                            Ok(head) => {
                                eprintln!("[Grapher] [Publication] Completed! Published HEAD: {head}");
                                runtime.emit(EventKind::PublicationCompleted { head })?;
                                if let Err(error) = runtime.cleanup_worktrees() {
                                    eprintln!("Cannot clean completed run worktrees: {error}");
                                }
                            },
                            Err(error) => {
                                eprintln!("[Grapher] [Publication] Failed: {error}");
                                runtime.emit(EventKind::PublicationFailed { error })?;
                            }
                        }
                    }
                    break;
                }
                in_flight += jobs.len();
                for (job, parents) in jobs.into_iter().zip(parents) {
                    let service = service.clone();
                    let root = root.clone();
                    let completed_tx = completed_tx.clone();
                    let output_tx = output_tx.clone();
                    eprintln!(
                        "[Grapher] [Execution] Started node '{}' (id: {}, attempt: {})",
                        job.execution.node, job.execution.id, job.execution.attempt
                    );
                    thread::spawn(move || {
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            perform_with_merger(
                                &job,
                                &root,
                                &parents,
                                |text| {
                                    let _ = output_tx.send(OutputMessage::Text {
                                        execution_id: job.execution.id.clone(), text,
                                    });
                                },
                                |head| {
                                    service
                                        .runtime
                                        .lock()
                                        .map_err(|error| error.to_string())?
                                        .emit(EventKind::Prepared {
                                            execution_id: job.execution.id.clone(),
                                            head,
                                        })
                                },
                                |event| {
                                    service.runtime.lock().map_err(|e| e.to_string())?.emit(event)
                                },
                            )
                        }))
                        .unwrap_or_else(|_| Err("Execution worker panicked".into()));
                        let (reply, ack) = std::sync::mpsc::channel();
                        let flushed = output_tx.send(OutputMessage::Flush(reply))
                            .map_err(|_| "Output writer stopped before execution finished".to_string())
                            .and_then(|_| ack.recv().map_err(|_| "Output writer stopped before flushing".to_string()))
                            .and_then(|result| result);
                        let result = if let Err(error) = flushed { Err(error) } else { result };
                        let result = service
                            .runtime
                            .lock()
                            .map_err(|error| error.to_string())
                            .and_then(|mut runtime| runtime.finish(&job.execution, result));
                        let _ = completed_tx.send(result);
                    });
                }
                if in_flight > 0 {
                    let completed = completed_rx
                        .recv()
                        .map_err(|_| "Execution channel closed")?;
                    in_flight -= 1;
                    if let Some(feedback) = completed? {
                        feedback_results.push(feedback);
                    }
                }
                if in_flight == 0 {
                    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                    for (from, output) in feedback_results.drain(..) {
                        if runtime.state.nodes[&from].status == "done" {
                            runtime.apply_feedback(&from, &output)?;
                        }
                    }
                }
            }
            Ok(())
        })();
        drop(output_tx);
        if writer.join().is_err() { eprintln!("Output writer panicked"); }
        if let Ok(runtime) = service.runtime.lock() {
            if let Some(m) = &runtime.state.run_metrics {
                eprintln!(
                    "[Grapher] [RunSummary] Run '{}' settled (phase: {}, wall-clock: {:.2}s, total tokens: {}, tools: {}, errors: {})",
                    runtime.state.run_id,
                    runtime.state.phase,
                    m.total_duration_seconds,
                    m.total_usage.total_tokens,
                    m.tools,
                    m.tool_errors
                );
            }
        }
        if let Err(error) = result {
            eprintln!("Runtime halted safely: {error}");
            if let Ok(mut runtime) = service.runtime.lock() {
                if matches!(runtime.state.phase.as_str(), "publishing" | "merging") {
                    let _ = runtime.emit(EventKind::PublicationFailed { error });
                } else {
                    let _ = runtime.emit(EventKind::Paused { paused: true });
                }
            }
        }
        service.driving.store(false, Ordering::SeqCst);
        let resume = service
            .runtime
            .lock()
            .map(|runtime| {
                runtime.state.approved
                    && !runtime.state.paused
                    && runtime.state.phase == "running"
                    && !runtime.active()
            })
            .unwrap_or(false);
        if resume {
            drive(service.clone());
        }
    });
}

fn control(
    action: String,
    node: Option<String>,
    instruction: Option<String>,
    run_id: Option<String>,
    execution_id: Option<String>,
    images: Option<Vec<crate::model::ImageAttachment>>,
    service: &Arc<Service>,
) -> Result<Snapshot, String> {
    if action == "steer_planner" {
        let instruction = instruction.ok_or("Enter a planning message")?;
        if instruction.trim().is_empty() { return Err("Enter a planning message".into()); }
        if !service.planning.load(Ordering::SeqCst) {
            return Err("Planner is no longer accepting messages".into());
        }
        let active_run_id = crate::engine::planner_revision_run_id()?;
        let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        if run_id.as_ref().is_some_and(|id| active_run_id.as_ref() != Some(id))
            || active_run_id.as_ref().is_some_and(|id| id != &runtime.state.run_id) {
            return Err("Run changed while steering Planner".into());
        }
        let message = planner_followup_prompt(instruction.trim(), active_run_id.as_deref(), &runtime.state);
        let snapshot = runtime.state.clone();
        drop(runtime);
        crate::engine::steer_planner(&message, images)?;
        return Ok(snapshot);
    }
    if action == "steer" {
        let node = node.ok_or("Select a node to steer")?;
        let instruction = instruction.ok_or("Enter a steering message")?;
        if instruction.trim().is_empty() { return Err("Enter a steering message".into()); }
        let execution_id = execution_id.ok_or("Missing execution identity")?;
        {
            let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
            if run_id.as_deref() != Some(runtime.state.run_id.as_str())
                || !runtime.state.executions.iter().any(|e| e.id == execution_id && e.node == node && e.status == "running") {
                return Err("Node execution is no longer running; send a new instruction instead".into());
            }
        }
        crate::engine::steer(&execution_id, instruction.trim(), images)?;
        let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        if run_id.as_deref() != Some(runtime.state.run_id.as_str()) {
            return Err("Run changed while steering".into());
        }
        runtime.emit(EventKind::Steered { execution_id, node, instruction: instruction.trim().into() })?;
        return Ok(runtime.state.clone());
    }
    if matches!(action.as_str(), "stop" | "cancel") {
        crate::engine::terminate_all();
        let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
        if runtime.state.approved {
            let _ = runtime.pause(true);
        }
        return Ok(runtime.state.clone());
    }
    if service.planning.load(Ordering::SeqCst) {
        return Err("Wait for planning to finish".into());
    }
    if matches!(
        action.as_str(),
        "resolve" | "retry_publication"
    ) && service.driving.load(Ordering::SeqCst)
    {
        return Err("Wait for active executions to finish before resolving or retrying publication".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    match action.as_str() {
        "retry_publication" => runtime.retry_publication()?,
        "approve" => runtime.approve()?,
        "pause" => runtime.pause(true)?,
        "resume" => runtime.pause(false)?,
        "reject" => {
            if runtime.state.phase != "awaiting_approval" {
                return Err("Only an unapproved plan can be rejected".into());
            }
            runtime.emit(EventKind::Rejected)?;
        }
        "intervene" => runtime.intervene(
            node.as_deref().unwrap_or_default(),
            instruction.as_deref().unwrap_or_default(),
        )?,
        "rerun" => runtime.rerun(node.as_deref().unwrap_or_default())?,
        "resolve" => runtime.resolved(node.as_deref().unwrap_or_default())?,
        _ => return Err("Unknown action".into()),
    }
    let snapshot = runtime.state.clone();
    drop(runtime);
    if matches!(
        action.as_str(),
        "approve" | "resume" | "intervene" | "rerun" | "resolve" | "retry_publication"
    ) {
        drive(service.clone());
    }
    Ok(snapshot)
}

fn detect_repository(
    path: Option<String>,
) -> Result<Option<crate::workspace::RepositoryInfo>, String> {
    crate::workspace::detect(path.as_deref().map(std::path::Path::new))
}

fn reset_workspace(service: &Arc<Service>) -> Result<Snapshot, String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    runtime.reset_workspace()
}

fn clear_history(service: &Arc<Service>) -> Result<(), String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    runtime.clear_history()
}

fn delete_run(run_id: String, service: &Arc<Service>) -> Result<(), String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    runtime.delete_run(&run_id)
}

fn planning_attachment_path(dir: &std::path::Path, index: usize, image: &ImageAttachment) -> PathBuf {
    let ext = match image.mime_type.as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    };
    // Client filenames are display data, not paths under our writable data dir.
    dir.join(format!("image_{index}.{ext}"))
}

fn is_valid_planning_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !id.starts_with('.')
        && id != ".."
}

fn get_planning(planning_id: String, service: &Arc<Service>) -> Result<PlanningSummary, String> {
    if !is_valid_planning_id(&planning_id) {
        return Err(format!("Invalid planning ID: {planning_id}"));
    }
    let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    let planning_dir = runtime.root.join("planning");
    let summary_path = planning_dir.join(&planning_id).join("summary.json");
    if let Ok(canonical_summary) = summary_path.canonicalize() {
        if let Ok(canonical_planning_dir) = planning_dir.canonicalize() {
            if !canonical_summary.starts_with(&canonical_planning_dir) {
                return Err(format!(
                    "Invalid planning ID: path traversal detected: {planning_id}"
                ));
            }
        }
    }
    if summary_path.exists() {
        let content = fs::read_to_string(&summary_path).map_err(|error| error.to_string())?;
        let mut summary =
            serde_json::from_str::<PlanningSummary>(&content).map_err(|error| error.to_string())?;
        if summary.repository.is_none() {
            if let Some(repo) = runtime
                .store
                .find_repository_by_planning_id(&summary.planning_id)
            {
                summary.repository = Some(repo);
                if let Ok(migrated_json) = serde_json::to_string_pretty(&summary) {
                    let _ = fs::write(&summary_path, migrated_json);
                }
            }
        }
        Ok(summary)
    } else {
        Err(format!("Planning summary not found: {planning_id}"))
    }
}

// Planning traces are loaded only when opened in the UI. Keep raw model output
// out of bootstrap/list/poll responses and cap each UTF-8-safe page.
fn get_planning_output(
    planning_id: String,
    role: String,
    offset: u64,
    service: &Arc<Service>,
) -> Result<serde_json::Value, String> {
    if !is_valid_planning_id(&planning_id) {
        return Err("Invalid planning ID".into());
    }
    if !matches!(role.as_str(), "partition" | "planner") {
        return Err("Invalid planning role".into());
    }
    let root = service
        .runtime
        .lock()
        .map_err(|e| e.to_string())?
        .root
        .join("planning");
    let root = root
        .canonicalize()
        .map_err(|_| "Planning output not found")?;
    let directory = root
        .join(&planning_id)
        .canonicalize()
        .map_err(|_| "Planning output not found")?;
    if !directory.starts_with(&root) {
        return Err("Invalid planning output path".into());
    }
    let running = fs::read(directory.join("summary.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PlanningSummary>(&bytes).ok())
        .is_some_and(|summary| summary.status.as_deref() == Some("running"));
    let file_path = directory.join(format!("{role}.jsonl"));
    if !file_path.exists() && running && offset == 0 {
        return Ok(
            serde_json::json!({ "planningId": planning_id, "role": role, "content": "",
            "nextOffset": 0, "totalBytes": 0, "complete": true, "running": true }),
        );
    }
    let file_path = file_path
        .canonicalize()
        .map_err(|_| "Planning output not found")?;
    if !file_path.starts_with(&root) {
        return Err("Invalid planning output path".into());
    }
    let mut file = fs::File::open(file_path).map_err(|e| e.to_string())?;
    let total_bytes = file.metadata().map_err(|e| e.to_string())?.len();
    if offset > total_bytes {
        return Err("Invalid planning output offset".into());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(256 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let length = match std::str::from_utf8(&bytes) {
        Ok(_) => bytes.len(),
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(_) => return Err("Invalid planning output UTF-8 offset".into()),
    };
    let content = std::str::from_utf8(&bytes[..length]).map_err(|e| e.to_string())?;
    let next_offset = offset + length as u64;
    Ok(serde_json::json!({ "planningId": planning_id, "role": role,
        "content": content, "nextOffset": next_offset, "totalBytes": total_bytes,
        "complete": next_offset >= total_bytes, "running": running }))
}

fn list_plannings(
    service: &Arc<Service>,
    repository_filter: Option<String>,
) -> Result<Vec<PlanningSummary>, String> {
    let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    let planning_dir = runtime.root.join("planning");
    if !planning_dir.exists() {
        return Ok(Vec::new());
    }
    let mut summaries = Vec::new();
    if let Ok(entries) = fs::read_dir(planning_dir) {
        for entry in entries.flatten() {
            let summary_path = entry.path().join("summary.json");
            if summary_path.exists() {
                if let Ok(content) = fs::read_to_string(&summary_path) {
                    if let Ok(mut summary) = serde_json::from_str::<PlanningSummary>(&content) {
                        // If repository is missing, attempt to backfill from associated run in event store
                        if summary.repository.is_none() {
                            if let Some(repo) = runtime
                                .store
                                .find_repository_by_planning_id(&summary.planning_id)
                            {
                                summary.repository = Some(repo);
                                if let Ok(migrated_json) = serde_json::to_string_pretty(&summary) {
                                    let _ = fs::write(&summary_path, migrated_json);
                                }
                            }
                        }

                        // Filter by repository if requested (fail closed)
                        if let Some(ref repo) = repository_filter {
                            let filter = repo.trim();
                            if !filter.is_empty() {
                                match &summary.repository {
                                    Some(summary_repo) if summary_repo == filter => {}
                                    _ => continue, // Fail closed: reject mismatched or unattributed summaries
                                }
                            }
                        }
                        summaries.push(summary);
                    }
                }
            }
        }
    }
    summaries.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.planning_id.cmp(&a.planning_id))
    });
    Ok(summaries)
}

fn argument<T: serde::de::DeserializeOwned>(
    body: &serde_json::Value,
    key: &str,
) -> Result<T, String> {
    serde_json::from_value(body.get(key).cloned().unwrap_or(serde_json::Value::Null))
        .map_err(|error| format!("Invalid {key}: {error}"))
}

fn get_execution_output(
    body: &serde_json::Value,
    service: &Arc<Service>,
) -> Result<serde_json::Value, String> {
    let run_id: String = argument(body, "runId")?;
    let execution_id: String = argument(body, "executionId")?;
    let offset: usize = body
        .get("offset")
        .map(|_| argument(body, "offset"))
        .transpose()?
        .unwrap_or(0);
    let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
    let historical;
    let state = if runtime.state.run_id == run_id {
        &runtime.state
    } else {
        historical = runtime.store.load(&run_id)?;
        &historical
    };
    execution_page(state, &execution_id, offset)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillItem {
    name: String,
    description: String,
    path: String,
    scope: String,
}

fn parse_skill_markdown(path: &std::path::Path) -> Option<(String, String)> {
    let content = fs::read_to_string(path).ok()?;
    let mut name = None;
    let mut description = None;

    if content.starts_with("---") {
        if let Some(end_idx) = content[3..].find("---") {
            let frontmatter = &content[3..3 + end_idx];
            let mut in_desc_block = false;
            let mut desc_lines = Vec::new();

            for line in frontmatter.lines() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("name:") {
                    in_desc_block = false;
                    let val = rest.trim().trim_matches('"').trim_matches('\'').trim();
                    if !val.is_empty() {
                        name = Some(val.to_string());
                    }
                } else if let Some(rest) = trimmed.strip_prefix("description:") {
                    let val = rest.trim().trim_matches('"').trim_matches('\'').trim();
                    if val.is_empty() || val == ">-" || val == "|" || val == ">" {
                        in_desc_block = true;
                    } else {
                        in_desc_block = false;
                        description = Some(val.to_string());
                    }
                } else if in_desc_block {
                    if line.starts_with("  ") || line.starts_with('\t') {
                        let t = line.trim();
                        if !t.is_empty() {
                            desc_lines.push(t);
                        }
                    } else if !trimmed.is_empty() {
                        in_desc_block = false;
                    }
                }
            }

            if description.is_none() && !desc_lines.is_empty() {
                description = Some(desc_lines.join(" "));
            }
        }
    }

    let skill_name = name.unwrap_or_else(|| {
        path.parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "skill".to_string())
    });

    let skill_desc = description.unwrap_or_else(|| {
        content
            .lines()
            .find(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with('#') && !t.starts_with("---")
            })
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    });

    Some((skill_name, skill_desc))
}

fn resolve_repo_path(
    service: &Arc<Service>,
    repository_param: Option<String>,
) -> PathBuf {
    if let Some(repo) = repository_param.filter(|s| !s.trim().is_empty()) {
        return PathBuf::from(repo);
    }
    if let Ok(runtime) = service.runtime.lock() {
        if let Some(config) = &runtime.state.config {
            if !config.repository.trim().is_empty() {
                return PathBuf::from(&config.repository);
            }
        }
    }
    if let Ok(Some(repo)) = crate::workspace::detect(None) {
        return PathBuf::from(repo.path);
    }
    // 当进程在子目录（如 backend/）执行时，通过 git rev-parse 向上查找仓库根目录
    if let Ok(output) = std::process::Command::new("git")
        .arg("rev-parse")
        .arg("--show-toplevel")
        .output()
    {
        if output.status.success() {
            let toplevel = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !toplevel.is_empty() {
                return PathBuf::from(toplevel);
            }
        }
    }
    if let Some(parent) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
        if parent.exists() {
            return parent.to_path_buf();
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn is_excluded_project_path(rel_path: &str) -> bool {
    let lower = rel_path.to_lowercase();
    // 排除技能目录、内部框架目录、版本控制和编译产物，不把 skill 规则文档当做项目文件
    if lower.starts_with(".agents/")
        || lower == ".agents"
        || lower.starts_with(".pi/")
        || lower == ".pi"
        || lower.starts_with(".git/")
        || lower == ".git"
        || lower.starts_with(".grapher/")
        || lower == ".grapher"
        || lower.starts_with(".gemini/")
        || lower == ".gemini"
        || lower.starts_with(".codex/")
        || lower == ".codex"
        || lower.starts_with("node_modules/")
        || lower == "node_modules"
        || lower.starts_with("target/")
        || lower == "target"
        || lower.starts_with("dist/")
        || lower == "dist"
        || lower.starts_with("build/")
        || lower == "build"
        || lower.starts_with(".next/")
        || lower == ".next"
        || lower.ends_with(".ds_store")
    {
        return true;
    }
    // 排除任何以点开头的隐藏目录（如 .cache/, .husky/ 等），保留根目录常规点文件（如 .gitignore, .env.example）
    for (idx, part) in rel_path.split('/').enumerate() {
        if part.starts_with('.') {
            let is_root_file = idx == 0 && !rel_path.contains('/');
            let is_allowed_dotfile = part == ".gitignore" || part == ".gitmodules" || part.starts_with(".env");
            if !(is_root_file && is_allowed_dotfile) {
                return true;
            }
        }
    }
    false
}

fn collect_files_from_dir(dir: &std::path::Path) -> Vec<String> {
    let mut files = Vec::new();
    let is_git = dir.join(".git").exists() || crate::workspace::is_standard_git(dir);
    if is_git {
        if let Ok(output) = std::process::Command::new("git")
            .arg("ls-files")
            .arg("--cached")
            .arg("--others")
            .arg("--exclude-standard")
            .current_dir(dir)
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() && !is_excluded_project_path(trimmed) {
                        files.push(trimmed.to_string());
                    }
                }
            }
        }
    }

    if files.is_empty() {
        fn walk(walk_dir: &std::path::Path, base: &std::path::Path, files: &mut Vec<String>, limit: usize) {
            if files.len() >= limit {
                return;
            }
            if let Ok(entries) = fs::read_dir(walk_dir) {
                for entry in entries.flatten() {
                    if files.len() >= limit {
                        break;
                    }
                    let path = entry.path();
                    if let Ok(rel) = path.strip_prefix(base) {
                        let rel_str = rel.to_string_lossy().replace('\\', "/");
                        if is_excluded_project_path(&rel_str) {
                            continue;
                        }
                    }
                    if path.is_dir() {
                        walk(&path, base, files, limit);
                    } else if path.is_file() {
                        if let Ok(rel) = path.strip_prefix(base) {
                            let rel_str = rel.to_string_lossy().replace('\\', "/");
                            if !is_excluded_project_path(&rel_str) {
                                files.push(rel_str);
                            }
                        }
                    }
                }
            }
        }
        walk(dir, dir, &mut files, 3000);
    }
    files
}

fn list_files(
    service: &Arc<Service>,
    repository_param: Option<String>,
) -> Result<serde_json::Value, String> {
    let repo_path = resolve_repo_path(service, repository_param);
    let mut files = if repo_path.exists() {
        collect_files_from_dir(&repo_path)
    } else {
        Vec::new()
    };

    files.sort();
    Ok(serde_json::json!({ "files": files }))
}

fn list_skills(
    service: &Arc<Service>,
    repository_param: Option<String>,
) -> Result<serde_json::Value, String> {
    let repo_path = resolve_repo_path(service, repository_param);
    let home_dir = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let mut search_dirs: Vec<(PathBuf, &'static str)> = Vec::new();

    // 1. Pi 工作区技能规范 (Project Skills: .agents/skills, .pi/skills, skills)
    search_dirs.push((repo_path.join(".agents").join("skills"), "workspace"));
    search_dirs.push((repo_path.join(".pi").join("skills"), "workspace"));
    search_dirs.push((repo_path.join("skills"), "workspace"));

    // 2. Grapher 宿主内置技能规范 (Grapher Host App: .agents/skills, .pi/skills, skills)
    if let Some(grapher_root) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
        if grapher_root != repo_path {
            search_dirs.push((grapher_root.join(".agents").join("skills"), "builtin"));
            search_dirs.push((grapher_root.join(".pi").join("skills"), "builtin"));
            search_dirs.push((grapher_root.join("skills"), "builtin"));
        }
    }

    // 3. Pi 全局用户技能规范 (User Skills: agent_dir/skills, ~/.pi/agent/skills, ~/.agents/skills, ~/.pi/skills)
    if let Ok(agent_dir) = crate::native::agent_dir() {
        search_dirs.push((agent_dir.join("skills"), "global"));
    }
    if let Some(ref home) = home_dir {
        search_dirs.push((home.join(".grapher").join("pi-agent").join("skills"), "global"));
        search_dirs.push((home.join(".pi").join("agent").join("skills"), "global"));
        search_dirs.push((home.join(".agents").join("skills"), "global"));
        search_dirs.push((home.join(".pi").join("skills"), "global"));
    }

    let mut skills = Vec::new();
    let mut seen_names = std::collections::HashSet::new();

    fn scan_skills_dir(
        dir: &std::path::Path,
        scope: &str,
        skills: &mut Vec<SkillItem>,
        seen_names: &mut std::collections::HashSet<String>,
    ) {
        if !dir.exists() || !dir.is_dir() {
            return;
        }
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let skill_md = path.join("SKILL.md");
                    if skill_md.exists() {
                        if let Some((name, desc)) = parse_skill_markdown(&skill_md) {
                            if !seen_names.contains(&name) {
                                seen_names.insert(name.clone());
                                skills.push(SkillItem {
                                    name,
                                    description: desc,
                                    path: skill_md.to_string_lossy().to_string(),
                                    scope: scope.to_string(),
                                });
                            }
                        }
                    } else {
                        // 深入子分组目录扫描
                        scan_skills_dir(&path, scope, skills, seen_names);
                    }
                } else if path.is_file() {
                    // Pi 规范：~/.pi/agent/skills 与 ~/.pi/skills 支持直接根级单文件技能
                    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if file_name.ends_with(".md") && file_name != "README.md" && file_name != "AGENTS.md" {
                        if let Some((name, desc)) = parse_skill_markdown(&path) {
                            if !seen_names.contains(&name) {
                                seen_names.insert(name.clone());
                                skills.push(SkillItem {
                                    name,
                                    description: desc,
                                    path: path.to_string_lossy().to_string(),
                                    scope: scope.to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    for (dir, scope) in &search_dirs {
        scan_skills_dir(dir, scope, &mut skills, &mut seen_names);
    }

    skills.sort_by(|a, b| {
        let scope_order = |s: &str| match s {
            "workspace" => 0,
            "builtin" => 1,
            "global" => 2,
            _ => 3,
        };
        scope_order(&a.scope)
            .cmp(&scope_order(&b.scope))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(serde_json::json!({ "skills": skills }))
}

pub fn dispatch(
    service: &Arc<Service>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use serde_json::to_value;
    let compact = body
        .get("compact")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let metadata = body.get("detail").and_then(serde_json::Value::as_str) == Some("metadata");
    if command == "snapshot" && metadata {
        let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        return snapshot_metadata(&runtime.state);
    }
    if command == "history" && metadata {
        return snapshot_metadata(&history(argument(&body, "runId")?, service)?);
    }
    let result = match command {
        "provider_auth" => to_value(crate::provider_auth::request(body)?),
        "bootstrap" => to_value(bootstrap(service, metadata)?),
        "snapshot" => to_value(snapshot(service)?),
        "history" => to_value(history(argument(&body, "runId")?, service)?),
        "load_run" => to_value(load_run(argument(&body, "runId")?, service)?),
        "compile_graph" => to_value(
            compile_graph(argument(&body, "graph")?)
                .map_err(|errors| serde_json::to_string(&errors).unwrap())?,
        ),
        "save_graph" => to_value(save_graph(
            argument(&body, "graph")?,
            argument(&body, "config")?,
            argument(&body, "runId")?,
            service,
        )?),
        "save_config" => to_value(save_config(argument(&body, "config")?, service)?),
        "plan_goal" => to_value(plan_goal(
            argument(&body, "goal")?,
            argument(&body, "config")?,
            argument(&body, "mode").ok(),
            argument(&body, "images").ok(),
            service,
        )?),
        "get_execution_output" => return get_execution_output(&body, service),
        "get_planning_snapshot" => {
            let id: String = argument(&body, "planningId")?;
            let repository: String = argument(&body, "repository")?;
            let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
            let state = if runtime.state.planning_id.as_ref() == Some(&id) {
                snapshot_metadata(&runtime.state)?
            } else {
                let run = runtime
                    .store
                    .runs()?
                    .into_iter()
                    .find_map(|run| {
                        let state = runtime.store.load(&run).ok()?;
                        (state.planning_id.as_ref() == Some(&id)).then_some(state)
                    })
                    .ok_or("Planning run not found")?;
                snapshot_metadata(&run)?
            };
            if state["config"]["repository"].as_str() != Some(repository.as_str()) {
                return Err("Planning repository mismatch".into());
            }
            return Ok(state);
        }
        "get_planning_output" => to_value(get_planning_output(
            argument(&body, "planningId")?,
            argument(&body, "role")?,
            body.get("offset")
                .map(|_| argument(&body, "offset"))
                .transpose()?
                .unwrap_or(0),
            service,
        )?),
        "get_planning" => to_value(get_planning(argument(&body, "planningId")?, service)?),
        "list_plannings" => to_value(list_plannings(service, argument(&body, "repository").ok())?),
        "control" => to_value(control(
            argument(&body, "action")?,
            argument(&body, "node")?,
            argument(&body, "instruction")?,
            argument(&body, "runId")?,
            argument(&body, "executionId")?,
            argument(&body, "images").ok(),
            service,
        )?),
        "repository_status" => {
            let repository: String = argument(&body, "repository")?;
            let error = crate::workspace::validate_binding(std::path::Path::new(&repository)).err();
            Ok(serde_json::json!({ "repository": repository, "valid": error.is_none(), "error": error }))
        }
        "detect_repository" => to_value(detect_repository(argument(&body, "path")?)?),
        "pick_repository" => to_value(crate::workspace::pick_repository()?),
        "list_files" => to_value(list_files(service, argument(&body, "repository").ok())?),
        "list_skills" => to_value(list_skills(service, argument(&body, "repository").ok())?),
        "reset_workspace" => to_value(reset_workspace(service)?),
        "clear_history" => to_value(clear_history(service)?),
        "delete_run" => to_value(delete_run(argument(&body, "runId")?, service)?),
        _ => return Err("Unknown command".into()),
    };
    let mut value = result.map_err(|error| error.to_string())?;
    if metadata && command != "bootstrap" {
        let target = if value.get("executions").is_some() {
            Some(&mut value)
        } else {
            None
        };
        if let Some(target) = target {
            let state: Snapshot =
                serde_json::from_value(target.take()).map_err(|e| e.to_string())?;
            *target = snapshot_metadata(&state)?;
        }
    }
    // UI transcripts already live on executions/mergers. Avoid sending every
    // raw Output frame a second time on each poll; the durable event store and
    // default API responses retain the complete history for replay/export.
    if compact {
        let snapshot = if command == "bootstrap" {
            value.get_mut("snapshot")
        } else if matches!(
            command,
            "snapshot"
                | "history"
                | "load_run"
                | "save_graph"
                | "plan_goal"
                | "control"
                | "reset_workspace"
        ) {
            Some(&mut value)
        } else {
            None
        };
        if let Some(events) = snapshot
            .and_then(|snapshot| snapshot.get_mut("events"))
            .and_then(serde_json::Value::as_array_mut)
        {
            events.retain(|event| {
                event.get("type").and_then(serde_json::Value::as_str) != Some("output")
            });
        }
    }
    Ok(value)
}

struct SseStreamReceiver {
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
    current: Vec<u8>,
    pos: usize,
}

impl std::io::Read for SseStreamReceiver {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos < self.current.len() {
            let n = (self.current.len() - self.pos).min(buf.len());
            buf[..n].copy_from_slice(&self.current[self.pos..self.pos + n]);
            self.pos += n;
            return Ok(n);
        }
        match self.rx.recv() {
            Ok(bytes) => {
                if bytes.is_empty() {
                    return Ok(0);
                }
                let n = bytes.len().min(buf.len());
                buf[..n].copy_from_slice(&bytes[..n]);
                if n < bytes.len() {
                    self.current = bytes;
                    self.pos = n;
                } else {
                    self.current.clear();
                    self.pos = 0;
                }
                Ok(n)
            }
            Err(_) => Ok(0),
        }
    }
}

fn send_sse_event(tx: &std::sync::mpsc::Sender<Vec<u8>>, event: &str, data: &serde_json::Value) {
    let payload = format!("event: {event}\ndata: {}\n\n", data);
    let _ = tx.send(payload.into_bytes());
}

// Host is not an authentication mechanism, but an exact loopback authority
// check prevents DNS rebinding from using a remote hostname to reach this API.
fn is_trusted_host(host: &str, backend_port: u16) -> bool {
    host == format!("127.0.0.1:{backend_port}")
        || host == format!("localhost:{backend_port}")
}

fn is_trusted_origin(origin: &str, backend_port: u16) -> bool {
    let local = ["localhost", "127.0.0.1"];
    if local.iter().any(|host| {
        origin == format!("http://{host}:{backend_port}")
            || origin == format!("http://{host}:1420")
    }) {
        return true;
    }
    // Opt-in for nonstandard frontends only. Never use this to authorize Host.
    std::env::var("GRAPHER_ALLOWED_ORIGINS")
        .is_ok_and(|allowed| origin_matches_allowlist(origin, &allowed))
}

fn origin_matches_allowlist(origin: &str, allowed: &str) -> bool {
    allowed.split(',').any(|entry| {
        let entry = entry.trim();
        let authority = entry.strip_prefix("http://")
            .or_else(|| entry.strip_prefix("https://"));
        authority.is_some_and(|host| {
            !host.is_empty()
                && !host.chars().any(|c| c.is_whitespace() || matches!(c, '/' | '?' | '#' | '@'))
                && entry == origin
        })
    })
}

pub fn run() -> Result<(), String> {
    use tiny_http::{Header, Response, Server};
    load_env_file();
    let root = std::env::var_os("GRAPHER_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.grapher"));
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let extension = root.join("grapher-planner.ts");
    fs::write(&extension, include_str!("../resources/planner.ts"))
        .map_err(|error| error.to_string())?;
    let service = Arc::new(Service {
        runtime: Mutex::new(Runtime::open(&root)?),
        driving: AtomicBool::new(false),
        planning: AtomicBool::new(false),
        extension,
    });
    #[cfg(not(feature = "fixture"))]
    crate::native::check_retired_leases(&root)?;
    recover_plannings(&root)?;
    let port: u16 = std::env::var("GRAPHER_PORT")
        .unwrap_or_else(|_| "1421".into())
        .parse()
        .map_err(|_| "Invalid GRAPHER_PORT")?;
    let server = Arc::new(Server::http(("127.0.0.1", port)).map_err(|error| error.to_string())?);
    #[cfg(unix)]
    let mut signals = signal_hook::iterator::Signals::new([
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGTERM,
    ])
    .map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let shutdown_requested = {
        // signal-hook's iterator module is Unix-only; its flag API supports
        // the Windows CRT SIGINT handler without doing work in the handler.
        let requested = Arc::new(AtomicBool::new(false));
        signal_hook::flag::register(signal_hook::consts::SIGINT, requested.clone())
            .map_err(|error| error.to_string())?;
        requested
    };
    let shutdown_service = service.clone();
    let shutdown_server = server.clone();
    thread::spawn(move || {
        #[cfg(unix)]
        let stop = signals.forever().next().is_some();
        #[cfg(windows)]
        let stop = {
            while !shutdown_requested.load(Ordering::SeqCst) {
                thread::sleep(std::time::Duration::from_millis(50));
            }
            true
        };
        if stop {
            if let Ok(mut runtime) = shutdown_service.runtime.lock() {
                if matches!(runtime.state.phase.as_str(), "publishing" | "merging") {
                    let _ = runtime.emit(EventKind::PublicationFailed {
                        error: "Backend stopped during publication; inspect and retry publication."
                            .into(),
                    });
                } else if runtime.state.approved
                    && (runtime.active() || runtime.state.phase == "running")
                {
                    let _ = runtime.emit(EventKind::Paused { paused: true });
                }
            }
            crate::engine::terminate_all();
            crate::provider_auth::shutdown();
            shutdown_server.unblock();
        }
    });
    eprintln!(
        "Grapher backend: http://127.0.0.1:{port} (data: {})",
        root.display()
    );
    let web_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
    for mut request in server.incoming_requests() {
        let service = service.clone();
        let web_root = web_root.clone();
        thread::spawn(move || {
            let req_origin = request
                .headers()
                .iter()
                .find(|h| h.field.equiv("Origin"))
                .map(|h| h.value.as_str().to_string());
            let hosts: Vec<_> = request.headers().iter().filter(|h| h.field.equiv("Host")).collect();
            let origins: Vec<_> = request.headers().iter().filter(|h| h.field.equiv("Origin")).collect();
            let trusted = hosts.len() == 1
                && is_trusted_host(hosts[0].value.as_str(), port)
                && origins.len() <= 1
                && origins.iter().all(|h| is_trusted_origin(h.value.as_str(), port));
            if !trusted {
                let _ = request
                    .respond(Response::from_string("Untrusted origin").with_status_code(403));
                return;
            }
            if request.method() == &tiny_http::Method::Options {
                let mut response = Response::empty(204)
                    .with_header(tiny_http::Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"POST, OPTIONS"[..]).unwrap())
                    .with_header(tiny_http::Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type"[..]).unwrap());
                if let Some(ref origin) = req_origin {
                    response = response.with_header(tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], origin.as_bytes()).unwrap());
                }
                let _ = request.respond(response);
                return;
            }
            let url = request.url().split('?').next().unwrap_or("/").to_string();
            if let Some(command) = url.strip_prefix("/api/") {
                // JSON-only POST + exact Host/Origin checks limit browser access.
                // This is still an unauthenticated, trusted-user local API.
                let is_json = request.headers().iter().any(|h| {
                    h.field.equiv("Content-Type")
                        && h.value.as_str().split(';').next() == Some("application/json")
                });
                if request.method() != &tiny_http::Method::Post || !is_json {
                    let _ = request
                        .respond(Response::from_string("JSON POST required").with_status_code(415));
                    return;
                }

                if command == "plan_goal_stream" {
                    let mut input = String::new();
                    let body_res = std::io::Read::read_to_string(
                        &mut request.as_reader().take(10 * 1024 * 1024 + 1),
                        &mut input,
                    )
                    .map_err(|e| e.to_string())
                    .and_then(|_| {
                        serde_json::from_str::<serde_json::Value>(&input).map_err(|e| e.to_string())
                    });

                    let (goal, config, plan_mode, images, revision_run_id): (String, Config, Option<String>, Option<Vec<crate::model::ImageAttachment>>, Option<String>) = match body_res.and_then(|body| {
                        let goal: String = argument(&body, "goal")?;
                        let config: Config = argument(&body, "config")?;
                        let mode: Option<String> = argument(&body, "mode").ok();
                        let images: Option<Vec<crate::model::ImageAttachment>> = argument(&body, "images").ok();
                        let revision_run_id: Option<String> = argument(&body, "revisionRunId").ok();
                        Ok((goal, config, mode, images, revision_run_id))
                    }) {
                        Ok(tuple) => tuple,
                        Err(err) => {
                            let mut resp = Response::from_string(
                                serde_json::json!({"error": err}).to_string(),
                            )
                            .with_status_code(400)
                            .with_header(
                                Header::from_bytes("Content-Type", "application/json").unwrap(),
                            );
                            if let Some(ref origin) = req_origin {
                                if let Ok(hdr) = Header::from_bytes("Access-Control-Allow-Origin", origin.as_bytes()) {
                                    resp = resp.with_header(hdr);
                                }
                            }
                            let _ = request.respond(resp);
                            return;
                        }
                    };

                    if let Err(err) = validate_planning_preflight(&config, plan_mode.as_deref()) {
                        let mut resp = Response::from_string(
                            serde_json::json!({"error": err}).to_string(),
                        )
                        .with_status_code(400)
                        .with_header(
                            Header::from_bytes("Content-Type", "application/json").unwrap(),
                        );
                        if let Some(ref origin) = req_origin {
                            if let Ok(hdr) = Header::from_bytes("Access-Control-Allow-Origin", origin.as_bytes()) {
                                resp = resp.with_header(hdr);
                            }
                        }
                        let _ = request.respond(resp);
                        return;
                    }

                    let (tx, rx) = std::sync::mpsc::channel();
                    let service_clone = service.clone();

                    thread::spawn(move || {
                        let tx_part = tx.clone();
                        let tx_route = tx.clone();
                        let tx_plan = tx.clone();
                        let result = plan_goal_internal(
                            goal,
                            config,
                            plan_mode.as_deref(),
                            images,
                            revision_run_id,
                            &service_clone,
                            |line| {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line)
                                {
                                    send_sse_event(
                                        &tx_part,
                                        "partitioner",
                                        &serde_json::json!({ "raw": line, "event": parsed }),
                                    );
                                } else {
                                    send_sse_event(
                                        &tx_part,
                                        "partitioner",
                                        &serde_json::json!({ "raw": line }),
                                    );
                                }
                            },
                            |route| {
                                send_sse_event(
                                    &tx_route,
                                    "route_decision",
                                    &serde_json::json!({ "planType": route.plan_type }),
                                );
                            },
                            |line| {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line)
                                {
                                    send_sse_event(
                                        &tx_plan,
                                        "planner",
                                        &serde_json::json!({ "raw": line, "event": parsed }),
                                    );
                                } else {
                                    send_sse_event(
                                        &tx_plan,
                                        "planner",
                                        &serde_json::json!({ "raw": line }),
                                    );
                                }
                            },
                        );

                        match result {
                            Ok(snapshot) => {
                                send_sse_event(
                                    &tx,
                                    "complete",
                                    &serde_json::json!({ "snapshot": snapshot }),
                                );
                            }
                            Err((err, summary)) => {
                                let mut err_payload = serde_json::json!({ "error": err });
                                if let Some(s) = summary {
                                    err_payload["planningId"] = serde_json::json!(s.planning_id);
                                    err_payload["summary"] = serde_json::json!(s);
                                }
                                send_sse_event(&tx, "error", &err_payload);
                            }
                        }
                        let _ = tx.send(Vec::new());
                    });

                    let stream = SseStreamReceiver {
                        rx,
                        current: Vec::new(),
                        pos: 0,
                    };
                    let mut response = Response::empty(200)
                        .with_data(stream, None)
                        .with_header(
                            Header::from_bytes("Content-Type", "text/event-stream").unwrap(),
                        )
                        .with_header(Header::from_bytes("Cache-Control", "no-cache").unwrap())
                        .with_header(Header::from_bytes("Connection", "keep-alive").unwrap())
                        .with_header(Header::from_bytes("X-Accel-Buffering", "no").unwrap());
                    if let Some(ref origin) = req_origin {
                        if let Ok(hdr) = Header::from_bytes("Access-Control-Allow-Origin", origin.as_bytes()) {
                            response = response.with_header(hdr);
                        }
                    }
                    let _ = request.respond(response);
                    return;
                }

                let mut input = String::new();
                let result = std::io::Read::read_to_string(
                    &mut request.as_reader().take(10 * 1024 * 1024 + 1),
                    &mut input,
                )
                .map_err(|e| e.to_string())
                .and_then(|_| {
                    if input.len() > 10 * 1024 * 1024 {
                        return Err("Request too large".into());
                    }
                    let body = serde_json::from_str(&input).map_err(|e| e.to_string())?;
                    dispatch(&service, command, body)
                });
                let (status, body) = match result {
                    Ok(value) => (200, serde_json::json!({"result": value})),
                    Err(error) => (400, serde_json::json!({"error": error})),
                };
                let mut response = Response::from_string(body.to_string())
                        .with_status_code(status)
                        .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap())
                        .with_header(
                            Header::from_bytes("Content-Type", "application/json").unwrap(),
                        );
                if let Some(ref origin) = req_origin {
                    if let Ok(hdr) = Header::from_bytes("Access-Control-Allow-Origin", origin.as_bytes()) {
                        response = response.with_header(hdr);
                    }
                }
                let _ = request.respond(response);
            } else {
                let relative = url.trim_start_matches('/');
                if relative.split('/').any(|part| part == "..") {
                    let _ = request.respond(Response::empty(404));
                    return;
                }
                let path = web_root.join(if relative.is_empty() {
                    "index.html"
                } else {
                    relative
                });
                let mime = match path.extension().and_then(|s| s.to_str()) {
                    Some("html") => "text/html; charset=utf-8",
                    Some("js") => "text/javascript",
                    Some("css") => "text/css",
                    Some("svg") => "image/svg+xml",
                    _ => "application/octet-stream",
                };
                match fs::read(path) {
                    Ok(bytes) => {
                        let _ =
                            request
                                .respond(Response::from_data(bytes).with_header(
                                    Header::from_bytes("Content-Type", mime).unwrap(),
                                ));
                    }
                    Err(_) => {
                        let _ = request.respond(
                            Response::from_string("Run npm run build to build the frontend")
                                .with_status_code(404),
                        );
                    }
                }
            }
        });
    }
    Ok(())
}

