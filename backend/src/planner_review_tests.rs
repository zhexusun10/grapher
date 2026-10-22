use super::*;
use std::time::{Duration, Instant};

fn wait(service: &Arc<Service>, predicate: impl Fn(&Snapshot) -> bool) -> Snapshot {
    let deadline = Instant::now() + Duration::from_secs(120);
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
  fs.appendFileSync(new URL('./planner-tasks.jsonl', import.meta.url), JSON.stringify(task)+'\n');
  if (task.endsWith('\nFollow up')) { say('Follow-up reply'); process.exit(0); }
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
  while (!fs.existsSync('release-review')) await new Promise(completed=>setTimeout(completed,20));
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
  say('Completed');
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

fn planner_tasks(temp: &tempfile::TempDir) -> Vec<String> {
    fs::read_to_string(temp.path().join("planner-tasks.jsonl")).unwrap()
        .lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

fn continuation(auto: bool, followup_first: bool) {
    let (temp, repo, service) = setup(true, auto);
    if followup_first {
        // Hold the driver while an ordinary follow-up consumes the shared marker.
        service.driving.store(true, Ordering::SeqCst);
        let (run_id, config) = {
            let runtime = service.runtime.lock().unwrap();
            (runtime.state.run_id.clone(), runtime.state.effective_config().unwrap())
        };
        plan_goal_internal("Follow up".into(), config, Some("graph"), None,
            Some(run_id.clone()), &service, |_| {}, |_| {}, |_| {}).unwrap();
        let mut runtime = service.runtime.lock().unwrap();
        let mut reopened = runtime.open_run(&run_id).unwrap();
        assert!(!planner_rework_note_pending(&reopened.state, Some(&run_id)));
        reopened.pause(false).unwrap();
        *runtime = reopened;
        service.driving.store(false, Ordering::SeqCst);
    }
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
        assert_eq!(pending.nodes["first"].status, "completed");
        assert_eq!(pending.executions.len(), 1);
        let replay = service.runtime.lock().unwrap().store.load(&pending.run_id).unwrap();
        assert_eq!(replay.phase, "awaiting_approval");
        assert_eq!(replay.graph, pending.graph);
        service.runtime.lock().unwrap().approve().unwrap();
        drive(service.clone());
    }
    let completed = wait(&service, |s| s.phase == "completed" && s.nodes.len() == 2 && s.planning.as_ref().is_some_and(|p| p.status.as_deref() == Some("success"))
        && s.events.iter().filter(|e| matches!(e.kind, EventKind::PlannerReviewFinished { .. })).count() == 2);
    assert_eq!(completed.executions.len(), 2);
    assert_eq!(fs::read_to_string(repo.join("second.txt")).unwrap(), "continued");
    assert_eq!(completed.events.iter().filter(|e| matches!(e.kind, EventKind::PublicationCompleted { .. })).count(), 2);
    let tasks = planner_tasks(&temp);
    assert_eq!(tasks.len(), if followup_first { 3 } else { 2 });
    assert!(tasks[0].contains(PLANNER_REWORK_NOTE));
    assert!(tasks[1..].iter().all(|task| !task.contains(PLANNER_REWORK_NOTE)));
    let reviews: Vec<_> = tasks.iter().filter(|task| task.starts_with(POST_TASK_REVIEW_PROMPT)).collect();
    assert_eq!(reviews.len(), 2);
    assert_eq!(reviews[1], POST_TASK_REVIEW_PROMPT);
    if followup_first { assert_eq!(reviews[0], POST_TASK_REVIEW_PROMPT); }
    let runtime = service.runtime.lock().unwrap();
    let replay = runtime.store.load(&completed.run_id).unwrap();
    assert_eq!(replay.events.iter().filter(|e| matches!(e.kind, EventKind::PlannerReworkNoteInjected)).count(), 1);
    assert!(!planner_rework_note_pending(&replay, Some(&completed.run_id)));
    for event in &completed.events {
        if let EventKind::PlannerReviewStarted { planning } = &event.kind {
            let output = fs::read_to_string(runtime.root.join("planning").join(&planning.planning_id).join("planner.jsonl")).unwrap();
            assert!(!output.contains(POST_TASK_REVIEW_PROMPT));
            assert!(!output.contains(PLANNER_REWORK_NOTE));
        }
    }
}

#[test]
fn post_task_review_auto_continuation_uses_published_source() { continuation(true, false); }

#[test]
fn post_task_review_manual_approval_preserves_completed_nodes() { continuation(false, false); }

#[test]
fn post_task_review_omits_rework_note_after_followup_and_reload() { continuation(true, true); }

#[test]
fn post_task_review_disabled_does_not_call_planner() {
    let (_temp, _repo, service) = setup(false, false);
    drive(service.clone());
    let completed = wait(&service, |s| s.phase == "completed");
    assert!(!completed.events.iter().any(|e| matches!(e.kind, EventKind::PlannerReviewStarted { .. })));
}

#[test]
fn aborted_follow_up_revision_is_recorded_in_the_run_conversation() {
    let (temp, repo, service) = setup(false, false);
    drive(service.clone());
    let completed = wait(&service, |s| s.phase == "completed");
    let run_id = completed.run_id.clone();
    let (phase, graph_nodes) = (completed.phase.clone(), completed.graph.nodes.len());
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
    let (temp, repo, service) = setup(true, true);
    fs::write(repo.join("fail-review"), "fail").unwrap();
    drive(service.clone());
    let completed = wait(&service, |s| s.phase == "completed" && s.planning.as_ref().is_some_and(|p| p.status.as_deref() == Some("failed")));
    assert_eq!(completed.graph.nodes.len(), 1);
    assert_eq!(completed.nodes["first"].status, "completed");
    assert!(completed.review_graph.is_none());
    assert_eq!(fs::read_to_string(repo.join("review.txt")).unwrap(), "fresh source");
    assert!(completed.events.iter().any(|e| matches!(e.kind, EventKind::SourceSnapshotted { .. })));
    assert!(planner_tasks(&temp)[0].contains(PLANNER_REWORK_NOTE));
    wait(&service, |_| !service.driving.load(Ordering::SeqCst));
    let reopened = service.runtime.lock().unwrap().open_run(&completed.run_id).unwrap();
    assert_eq!(reopened.state.events.iter().filter(|e| matches!(e.kind, EventKind::PlannerReworkNoteInjected)).count(), 1);
    assert!(!planner_rework_note_pending(&reopened.state, Some(&completed.run_id)));
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
    runtime.emit(EventKind::PlannerReworkNoteInjected).unwrap();
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
    assert_eq!(reopened.state.planning.as_ref().unwrap().status.as_deref(), Some("failed"));
    assert!(!planner_rework_note_pending(&reopened.state, Some(&id)));
}

#[test]
fn transcript_projection_hides_the_synthetic_review_turn_everywhere() {
    for include_rework_note in [true, false] {
        let task = post_task_review_task(include_rework_note);
        for event_type in ["message_start", "message_end"] {
            let user_message = serde_json::json!({
                "type": event_type,
                "message": { "role": "user", "content": [{ "type": "text", "text": task }] },
            });
            let line = format!("{}\n", user_message);
            // Ordinary turns pass through untouched; both review variants are dropped.
            assert_eq!(review_transcript_line(&line, false).as_deref(), Some(line.as_str()));
            assert_eq!(review_transcript_line(&line, true), None);
        }
    }
    // A resumed conversation can embed both review variants. Hide both but
    // preserve real user messages, assistant errors, metrics and the newline.
    let agent_end = serde_json::json!({
        "grapherReceivedAt": 1000u64, "type": "agent_end", "willRetry": true,
        "messages": [
            { "role": "user", "content": [{ "type": "text", "text": post_task_review_task(true) }] },
            { "role": "user", "content": [{ "type": "text", "text": post_task_review_task(false) }] },
            { "role": "user", "content": [{ "type": "text", "text": "Follow up" }] },
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
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["content"][0]["text"], "Follow up");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["errorMessage"], "Request timed out.");
    // A lifecycle record without the synthetic turn stays byte-identical.
    let plain = format!("{}\n", serde_json::json!({ "type": "agent_end", "messages": [] }));
    assert_eq!(review_transcript_line(&plain, true).as_deref(), Some(plain.as_str()));
}
