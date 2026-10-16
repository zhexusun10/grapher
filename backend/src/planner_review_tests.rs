use super::*;
use std::time::{Duration, Instant};

fn wait(service: &Arc<Service>, predicate: impl Fn(&Snapshot) -> bool) -> Snapshot {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let state = service.runtime.lock().unwrap().state.clone();
        if predicate(&state) { return state; }
        assert!(Instant::now() < deadline, "timed out: {} {:?}", state.phase, state.planning);
        thread::sleep(Duration::from_millis(20));
    }
}

fn setup(enabled: bool, auto: bool) -> (tempfile::TempDir, PathBuf, Arc<Service>) {
    let temp = tempfile::tempdir().unwrap();
    let repo = crate::fixture::repository(temp.path()).unwrap();
    let script = temp.path().join("agent.mjs");
    fs::write(&script, r#"
import fs from 'node:fs';
let task = ''; for await (const chunk of process.stdin) task += chunk;
const emit = event => console.log(JSON.stringify(event));
const say = text => emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}]}});
if (process.env.GRAPHER_MODE === 'planner') {
  if (!fs.existsSync('first.txt')) throw Error('review ran before publication');
  emit({type:'message_start',message:{role:'user',content:[{type:'text',text:task}]}});
  emit({type:'message_end',message:{role:'user',content:[{type:'text',text:task}]}});
  if (fs.existsSync('second.txt')) { say('Final reply'); process.exit(0); }
  fs.writeFileSync('review.txt', 'fresh source');
  const graph = JSON.parse(fs.readFileSync(process.env.GRAPHER_GRAPH_PATH));
  graph.nodes.push({name:'second',task:'second'});
  fs.writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify(graph));
  emit({type:'tool_execution_end',toolName:'node',isError:false});
  if (fs.existsSync('fail-review')) throw Error('review failed deliberately');
  while (!fs.existsSync('release-review')) await new Promise(done=>setTimeout(done,20));
  graph.edges.push({from:'first',to:'second',feedback:false});
  fs.writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify(graph));
  emit({type:'tool_execution_end',toolName:'edge',isError:false});
  say('A next step');
} else {
  if (task.includes('second')) {
    if (fs.readFileSync('first.txt','utf8') !== 'published' || fs.readFileSync('review.txt','utf8') !== 'fresh source')
      throw Error('continuation did not branch from latest source');
    fs.writeFileSync('second.txt','continued');
  } else {
    if (fs.existsSync('fail-node')) throw Error('node failed deliberately');
    fs.writeFileSync('first.txt','published');
  }
  say('Done');
}
"#).unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repo, "engine": "pi", "piCommand": "node", "piArgs": [script],
        "model": "mock/review", "thinkingLevel": "off", "maxParallel": 2,
        "postTaskReview": enabled, "autoApprove": auto
    })).unwrap();
    let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
    runtime.create(Graph {
        original_goal: "Original user goal".into(),
        nodes: vec![Node { name: "first".into(), task: "first".into() }], edges: vec![],
    }, config).unwrap();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime), driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()), planning: AtomicBool::new(false),
        extension: temp.path().join("unused.ts"),
    });
    (temp, repo, service)
}

fn continuation(auto: bool) {
    let (_temp, repo, service) = setup(true, auto);
    drive(service.clone());
    let live = wait(&service, |s| s.review_graph.as_ref().is_some_and(|g| g.nodes.len() == 2));
    assert_eq!(live.graph.nodes.len(), 1, "candidate must not execute during the Planner turn");
    assert_eq!(live.executions.len(), 1);
    let projected = snapshot_metadata(&live).unwrap();
    assert_eq!(projected["graph"]["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(live.graph.original_goal, "Original user goal");
    assert_eq!(fs::read_to_string(repo.join("first.txt")).unwrap(), "published");
    let publication = live.events.iter().position(|e| matches!(e.kind, EventKind::PublicationCompleted { .. })).unwrap();
    let review = live.events.iter().position(|e| matches!(e.kind, EventKind::PlannerReviewStarted { .. })).unwrap();
    assert!(review > publication);
    fs::write(repo.join("release-review"), "go").unwrap();
    if !auto {
        let pending = wait(&service, |s| s.phase == "awaiting_approval");
        assert!(!pending.approved);
        assert_eq!(pending.nodes["first"].status, "done");
        assert_eq!(pending.executions.len(), 1);
        let replay = service.runtime.lock().unwrap().store.load(&pending.run_id).unwrap();
        assert_eq!(replay.phase, "awaiting_approval");
        assert_eq!(replay.graph, pending.graph);
        service.runtime.lock().unwrap().approve().unwrap();
        drive(service.clone());
    }
    let done = wait(&service, |s| s.phase == "completed" && s.nodes.len() == 2 && s.planning.as_ref().is_some_and(|p| p.status.as_deref() == Some("success"))
        && s.events.iter().filter(|e| matches!(e.kind, EventKind::PlannerReviewFinished { .. })).count() == 2);
    assert_eq!(done.executions.len(), 2);
    assert_eq!(fs::read_to_string(repo.join("second.txt")).unwrap(), "continued");
    assert_eq!(done.events.iter().filter(|e| matches!(e.kind, EventKind::PublicationCompleted { .. })).count(), 2);
    let runtime = service.runtime.lock().unwrap();
    for event in &done.events {
        if let EventKind::PlannerReviewStarted { planning } = &event.kind {
            let output = fs::read_to_string(runtime.root.join("planning").join(&planning.planning_id).join("planner.jsonl")).unwrap();
            assert!(!output.contains(POST_TASK_REVIEW_PROMPT));
        }
    }
}

#[test]
fn post_task_review_auto_continuation_uses_published_source() { continuation(true); }

#[test]
fn post_task_review_manual_approval_preserves_done_nodes() { continuation(false); }

#[test]
fn post_task_review_disabled_does_not_call_planner() {
    let (_temp, _repo, service) = setup(false, false);
    drive(service.clone());
    let done = wait(&service, |s| s.phase == "completed");
    assert!(!done.events.iter().any(|e| matches!(e.kind, EventKind::PlannerReviewStarted { .. })));
}

#[test]
fn aborted_follow_up_revision_is_recorded_in_the_run_conversation() {
    let (temp, repo, service) = setup(false, false);
    drive(service.clone());
    let done = wait(&service, |s| s.phase == "completed");
    let run_id = done.run_id.clone();
    let (phase, graph_nodes) = (done.phase.clone(), done.graph.nodes.len());
    fs::write(repo.join("fail-review"), "fail").unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repo, "engine": "pi", "piCommand": "node", "piArgs": [temp.path().join("agent.mjs")],
        "model": "mock/review", "thinkingLevel": "off", "maxParallel": 2,
        "postTaskReview": false, "autoApprove": true
    })).unwrap();
    let outcome = plan_goal_internal_with_started(
        "continue".into(), config, Some("graph"), None, Some(run_id.clone()), &service, false,
        |_| {}, |_| {}, |_| {}, |_| {},
    );
    assert!(outcome.is_err(), "the follow-up revision must fail");
    let state = service.runtime.lock().unwrap().state.clone();
    assert_eq!(state.phase, phase, "an aborted revision keeps the Run phase");
    assert_eq!(state.graph.nodes.len(), graph_nodes, "an aborted revision keeps the compiled graph");
    let aborted = state.events.iter()
        .find(|event| matches!(event.kind, EventKind::PlannerTurnAborted { .. }))
        .unwrap_or_else(|| panic!("aborted turn must be recorded"));
    let EventKind::PlannerTurnAborted { planning } = &aborted.kind else { unreachable!() };
    assert_eq!(planning.status.as_deref(), Some("failed"));
    // The durable output stays replayable and the replay keeps the turn.
    let page = get_planning_output(planning.planning_id.clone(), "planner".into(), 0, true, None, None, &service).unwrap();
    assert!(page["content"].as_str().unwrap().contains("continue"));
    let replay = history(run_id, &service).unwrap();
    assert_eq!(replay.events.iter()
        .filter(|event| matches!(event.kind, EventKind::PlannerTurnAborted { .. })).count(), 1);
}

#[test]
fn post_task_review_failure_preserves_published_graph_and_source_writes() {
    let (_temp, repo, service) = setup(true, true);
    fs::write(repo.join("fail-review"), "fail").unwrap();
    drive(service.clone());
    let done = wait(&service, |s| s.phase == "completed" && s.planning.as_ref().is_some_and(|p| p.status.as_deref() == Some("failed")));
    assert_eq!(done.graph.nodes.len(), 1);
    assert_eq!(done.nodes["first"].status, "done");
    assert!(done.review_graph.is_none());
    assert_eq!(fs::read_to_string(repo.join("review.txt")).unwrap(), "fresh source");
    assert!(done.events.iter().any(|e| matches!(e.kind, EventKind::SourceSnapshotted { .. })));
}

#[test]
fn post_task_review_does_not_trigger_on_failed_execution() {
    let (_temp, repo, service) = setup(true, true);
    fs::write(repo.join("fail-node"), "fail").unwrap();
    // Include the failure input in the source snapshot used by the first node.
    service.runtime.lock().unwrap().capture_planner_source().unwrap();
    drive(service.clone());
    let failed = wait(&service, |s| s.nodes["first"].status == "failed");
    assert!(!failed.events.iter().any(|e| matches!(e.kind, EventKind::PlannerReviewStarted { .. })));
}

#[test]
fn post_task_review_stop_discards_live_candidate_without_dispatch() {
    let (_temp, _repo, service) = setup(true, true);
    drive(service.clone());
    let live = wait(&service, |s| s.review_graph.as_ref().is_some_and(|g| g.nodes.len() == 2));
    control("stop".into(), None, None, Some(live.run_id), None, None, &service).unwrap();
    let stopped = wait(&service, |s| s.review_graph.is_none() && s.planning.as_ref().is_some_and(|p| p.status.as_deref() == Some("failed")));
    assert!(stopped.stop_requested);
    assert_eq!(stopped.graph.nodes.len(), 1);
    assert_eq!(stopped.executions.len(), 1);
    assert_eq!(stopped.phase, "paused");
}

#[test]
fn post_task_review_interruption_discards_candidate_and_never_retries_model() {
    let (_temp, _repo, service) = setup(true, false);
    let mut runtime = service.runtime.lock().unwrap();
    let planning = PlanningSummary { planning_id: Uuid::new_v4().to_string(), status: Some("running".into()), ..Default::default() };
    runtime.emit(EventKind::PlannerReviewStarted { planning }).unwrap();
    let mut candidate = runtime.state.graph.clone();
    candidate.nodes.push(Node { name: "uncommitted".into(), task: "uncommitted".into() });
    runtime.emit(EventKind::PlannerReviewProgress { graph: candidate }).unwrap();
    let root = runtime.root.clone();
    let id = runtime.state.run_id.clone();
    drop(runtime);
    drop(service);
    let reopened = Runtime::open(&root).unwrap().open_run(&id).unwrap();
    assert!(reopened.state.review_graph.is_none());
    assert_eq!(reopened.state.graph.nodes.len(), 1);
    assert_eq!(reopened.state.planning.unwrap().status.as_deref(), Some("failed"));
}

#[test]
fn transcript_projection_hides_the_synthetic_review_turn_everywhere() {
    let task = post_task_review_task();
    let user_message = serde_json::json!({
        "type": "message_end",
        "message": { "role": "user", "content": [{ "type": "text", "text": task }] },
    });
    let line = format!("{}\n", user_message);
    // Ordinary turns pass through untouched; the synthetic review turn is dropped.
    assert_eq!(review_transcript_line(&line, false).as_deref(), Some(line.as_str()));
    assert_eq!(review_transcript_line(&line, true), None);
    // Lifecycle records embed the conversation: the synthetic user message is
    // scrubbed while the assistant entry, metrics and the trailing newline stay.
    let agent_end = serde_json::json!({
        "grapherReceivedAt": 1000u64, "type": "agent_end", "willRetry": true,
        "messages": [
            { "role": "user", "content": [{ "type": "text", "text": task }] },
            { "role": "assistant", "content": [], "stopReason": "error", "errorMessage": "Request timed out.",
              "usage": { "input": 0, "output": 0, "totalTokens": 0 } },
        ],
    });
    let embedded = format!("{}\n", agent_end);
    let projected = review_transcript_line(&embedded, true).expect("embedded record is kept, not dropped");
    assert!(projected.ends_with('\n'));
    let projected: serde_json::Value = serde_json::from_str(projected.trim()).unwrap();
    assert_eq!(projected["type"], "agent_end");
    assert_eq!(projected["willRetry"], true);
    let messages = projected["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["role"], "assistant");
    assert_eq!(messages[0]["errorMessage"], "Request timed out.");
    // A lifecycle record without the synthetic turn stays byte-identical.
    let plain = format!("{}\n", serde_json::json!({ "type": "agent_end", "messages": [] }));
    assert_eq!(review_transcript_line(&plain, true).as_deref(), Some(plain.as_str()));
}
