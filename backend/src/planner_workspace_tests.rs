use super::*;
use crate::runtime::Job;

fn setup(shadow: bool) -> (tempfile::TempDir, PathBuf, Arc<Service>, Config) {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("source");
    fs::create_dir(&repo).unwrap();
    fs::write(repo.join("base.txt"), "source").unwrap();
    if !shadow {
        crate::workspace::git(&repo, &["init", "-q"]).unwrap();
        crate::workspace::snapshot_repository(&repo).unwrap();
    }
    let script = temp.path().join("agent.mjs");
    fs::write(&script, r#"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
let input = ''; for await (const chunk of process.stdin) input += chunk;
  if (process.env.GRAPHER_MODE === 'planner') {
  const context = input.startsWith('You are now at ') && input.includes('\nCurrent graph node status:\n');
  if (!context || !input.endsWith('\nadditional information'))
    throw Error('Every Planner follow-up must contain the current workspace and graph status');
  const arg = name => process.argv[process.argv.indexOf(name)+1];
  const directory = arg('--session-dir'), id = arg('--session-id');
  const file = path.join(directory, `grapher_${id}.jsonl`);
  const rework = `Modifying a completed node's task re-runs that node in a fresh session and invalidates all its downstream dependents (they re-run their previous tasks with the updated dependencies' workspace states); unrelated branches keep their work.`;
  const priorTurn = fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('preserved history');
  if (input.includes(rework) !== !priorTurn)
    throw Error('Planner rework note must appear only on the first follow-up');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({type:'session',id,cwd:process.cwd()})+'\n');
  const header = JSON.parse(fs.readFileSync(file,'utf8').split('\n')[0]);
  // Pi matches a custom-session-dir resume by the literal header cwd
  // (resolvePath comparison, no realpath). Assert exactly that contract and
  // include both spellings so a host-specific mismatch is diagnosable.
  if (header.cwd !== process.cwd()) throw Error(`stale session cwd: ${JSON.stringify([header.cwd, process.cwd()])}`);
  fs.appendFileSync(file, JSON.stringify({type:'custom',id:crypto.randomUUID(),data:'preserved history'})+'\n');
  const action = path.join(path.dirname(fileURLToPath(import.meta.url)), 'action');
  if (fs.existsSync(action)) {
    const actionText = fs.readFileSync(action,'utf8');
    if (actionText === 'move-left') {
      // An exact node-name response is a Planner workspace move command.
    } else {
      fs.writeFileSync('planner.txt', 'Planner writes at the frontier');
      if (actionText === 'fail') throw Error('deliberate Planner failure');
    }
  }
} else {
  fs.writeFileSync(`${process.env.GRAPHER_NODE_NAME}.txt`, 'node result');
}
const actionText = fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'action'))
  ? fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'action'),'utf8') : '';
if (process.env.GRAPHER_MODE === 'planner' && actionText === 'move-left') {
  const target = JSON.parse(process.env.GRAPHER_PLANNER_WORKSPACES || '{}').left;
  console.log(JSON.stringify({type:'tool_execution_end',toolName:'switch_workspace',isError:false,result:{content:[{type:'text',text:JSON.stringify(target)}]}}));
}
const finalText = 'done';
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:finalText}]}}));
"#).unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repo, "engine": "pi", "piCommand": "node", "piArgs": [script],
        "model": "mock/workspace", "maxParallel": 2, "postTaskReview": false,
    })).unwrap();
    let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
    runtime.create(Graph {
        original_goal: "frontier".into(),
        nodes: ["root", "left", "right", "join"].into_iter()
            .map(|name| Node { name: name.into(), task: name.into() }).collect(),
        edges: [("root", "left"), ("root", "right"), ("left", "join"), ("right", "join")]
            .into_iter().map(|(from, to)| Edge { from: from.into(), to: to.into(), feedback: false }).collect(),
    }, config.clone()).unwrap();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime), driving: AtomicBool::new(true),
        drive_signal: (Mutex::new(0), Condvar::new()), planning: AtomicBool::new(false),
        extension: temp.path().join("unused.ts"),
    });
    (temp, repo, service, config)
}

fn complete(runtime: &mut Runtime, mut job: Job) -> Execution {
    if job.materialize_source {
        let exclusions = runtime.exclusions().unwrap();
        runtime.attach_job_source(&mut job, &exclusions).unwrap();
    }
    let mut prepared = None;
    let result = perform_with_merger(&job, &runtime.root, &runtime.parents(&job.execution.node),
        |_| {}, |head| { prepared = Some(head); Ok(()) }, |_| Err("unexpected conflict".into()));
    runtime.emit(EventKind::Prepared { execution_id: job.execution.id.clone(), head: prepared.unwrap() }).unwrap();
    runtime.finish(&job.execution, result).unwrap();
    runtime.state.executions.iter().find(|e| e.id == job.execution.id).unwrap().clone()
}

fn turn(service: &Arc<Service>, config: &Config) -> Result<Snapshot, (String, Option<PlanningSummary>)> {
    let run = service.runtime.lock().unwrap().state.run_id.clone();
    plan_goal_internal("additional information".into(), config.clone(), Some("graph"), None,
        Some(run), service, |_| {}, |_| {}, |_| {})
}

#[test]
fn planner_workspace_output_move_is_persisted_and_stable_until_a_new_execution() {
    let (temp, _repo, service, config) = setup(false);
    {
        let mut runtime = service.runtime.lock().unwrap();
        let job = runtime.jobs().unwrap().remove(0);
        complete(&mut runtime, job);
    }
    // Establish the first follow-up and complete both parallel branches so
    // that the next turn starts in the most recently completed branch.
    turn(&service, &config).unwrap();
    {
        let mut runtime = service.runtime.lock().unwrap();
        let jobs = runtime.jobs().unwrap();
        assert_eq!(jobs.len(), 2);
        for job in jobs { complete(&mut runtime, job); }
    }
    fs::write(temp.path().join("action"), "move-left").unwrap();
    let moved = turn(&service, &config).unwrap();
    let left = moved.executions.iter().rev().find(|execution| execution.node == "left").unwrap();
    assert_eq!(moved.planning.as_ref().unwrap().workspace_execution_id.as_deref(), Some(left.id.as_str()));
    assert_eq!(moved.planning.as_ref().unwrap().worktree.as_deref(), Some(left.worktree.as_str()));

    // No node execution was added after the explicit move, so another user
    // message keeps the same workspace instead of snapping back to right.
    let repeated = turn(&service, &config).unwrap();
    assert_eq!(repeated.planning.as_ref().unwrap().workspace_execution_id.as_deref(), Some(left.id.as_str()));
    assert_eq!(repeated.planning.as_ref().unwrap().worktree.as_deref(), Some(left.worktree.as_str()));
}

#[test]
fn planner_redirects_to_a_workspace_reused_by_a_later_node() {
    let (_temp, _repo, service, config) = setup(false);
    let mut runtime = service.runtime.lock().unwrap();
    let root_job = runtime.jobs().unwrap().remove(0);
    let root = complete(&mut runtime, root_job);
    drop(runtime);
    turn(&service, &config).unwrap();
    let mut runtime = service.runtime.lock().unwrap();
    let mut jobs = runtime.jobs().unwrap();
    let right_job = jobs.pop().unwrap();
    let left = complete(&mut runtime, jobs.pop().unwrap());
    let right = complete(&mut runtime, right_job);
    let join_job = runtime.jobs().unwrap().remove(0);
    let join = complete(&mut runtime, join_job);
    let reused = [root, left, right].into_iter().find(|execution| execution.worktree == join.worktree)
        .expect("the linear handoff should reuse one parent workspace");
    let resolution = runtime.planner_workspace_for_node(&reused.node).unwrap().unwrap();
    assert_eq!(resolution.execution.id, join.id);
    assert_eq!(resolution.redirected_from.as_deref(), Some(reused.node.as_str()));
    assert_eq!(runtime.planner_workspace_for_node("join").unwrap().unwrap().execution.id, join.id);
}
#[test]
fn planner_workspace_tracks_linear_and_parallel_frontiers_across_turns_and_reload() {
    for shadow in [false, true] {
        let (temp, repo, mut service, config) = setup(shadow);
        let initial = turn(&service, &config).unwrap();
        assert_eq!(PathBuf::from(initial.planning.unwrap().worktree.unwrap()).canonicalize().unwrap(), repo.canonicalize().unwrap());
        let root = {
            let mut runtime = service.runtime.lock().unwrap();
            let job = runtime.jobs().unwrap().remove(0);
            complete(&mut runtime, job)
        };
        let first = turn(&service, &config).unwrap();
        assert_eq!(first.planning.as_ref().unwrap().workspace_execution_id.as_deref(), Some(root.id.as_str()));
        let (left, right) = {
            let mut runtime = service.runtime.lock().unwrap();
            let mut jobs = runtime.jobs().unwrap();
            assert_eq!(jobs.len(), 2);
            let right_job = jobs.pop().unwrap();
            let left = complete(&mut runtime, jobs.pop().unwrap());
            let right = complete(&mut runtime, right_job);
            (left, right)
        };
        assert_ne!(left.worktree, right.worktree, "fan-out must provide a different cwd");
        assert_ne!(root.worktree, right.worktree);
        // Reopen the actual store, not a cached pointer to the Planner's cwd.
        drop(service);
        service = Arc::new(Service {
            runtime: Mutex::new(Runtime::open(&temp.path().join("runtime")).unwrap()),
            driving: AtomicBool::new(true), drive_signal: (Mutex::new(0), Condvar::new()),
            planning: AtomicBool::new(false), extension: temp.path().join("unused.ts"),
        });
        let second = turn(&service, &config).unwrap();
        let selected = second.planning.as_ref().unwrap();
        assert_eq!(selected.worktree.as_deref(), Some(right.worktree.as_str()));
        assert_eq!(selected.workspace_execution_id.as_deref(), Some(right.id.as_str()));
        let join = {
            let mut runtime = service.runtime.lock().unwrap();
            if runtime.state.paused { runtime.pause(false).unwrap(); }
            let job = runtime.jobs().unwrap().remove(0);
            complete(&mut runtime, job)
        };
        let final_turn = turn(&service, &config).unwrap();
        assert_eq!(final_turn.planning.as_ref().unwrap().workspace_execution_id.as_deref(), Some(join.id.as_str()));
        let runtime = service.runtime.lock().unwrap();
        let session = runtime.root.join("planner-sessions").join(&final_turn.run_id);
        let files: Vec<_> = fs::read_dir(session).unwrap().flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl")).collect();
        assert_eq!(files.len(), 1, "cwd changes must not create another conversation");
        let contents = fs::read_to_string(files[0].path()).unwrap();
        assert_eq!(contents.matches("preserved history").count(), 4);
        let replay = runtime.store.load(&final_turn.run_id).unwrap();
        assert_eq!(replay.events.iter().filter(|event| matches!(event.kind, EventKind::PlannerWorkspaceSelected { .. })).count(), 4);
        assert_eq!(replay.events.iter().filter(|event| matches!(event.kind, EventKind::PlannerReworkNoteInjected)).count(), 1);
        assert_eq!(replay.planning.unwrap().worktree, final_turn.planning.unwrap().worktree);
    }
}

#[test]
fn planner_workspace_does_not_wait_for_an_unrelated_parallel_writer() {
    let (_temp, _repo, service, config) = setup(false);
    let (left, right) = {
        let mut runtime = service.runtime.lock().unwrap();
        let job = runtime.jobs().unwrap().remove(0);
        complete(&mut runtime, job);
        let mut jobs = runtime.jobs().unwrap();
        let right = complete(&mut runtime, jobs.pop().unwrap());
        (jobs.pop().unwrap(), right)
    };
    assert_eq!(service.runtime.lock().unwrap().state.nodes["left"].status, "running");
    let snapshot = turn(&service, &config).unwrap();
    assert_eq!(snapshot.planning.unwrap().workspace_execution_id.as_deref(), Some(right.id.as_str()));
    assert_eq!(snapshot.nodes["left"].status, "running");
    complete(&mut service.runtime.lock().unwrap(), left);
}

#[test]
fn planner_workspace_uses_the_latest_running_frontier_without_waiting() {
    let (_temp, _repo, service, _config) = setup(false);
    let mut runtime = service.runtime.lock().unwrap();
    let root = runtime.jobs().unwrap().remove(0);
    complete(&mut runtime, root);
    // Starting both parallel children leaves the whole frontier busy.
    let jobs = runtime.jobs().unwrap();
    assert_eq!(jobs.len(), 2);
    assert!(jobs.iter().all(|job| runtime.state.nodes[&job.execution.node].status == "running"));
    let selected = runtime.planner_workspace().unwrap().expect("the latest workspace is mandatory");
    assert!(jobs.iter().any(|job| job.execution.id == selected.id),
        "an active frontier is selected directly instead of falling back to source");
    assert!(runtime.path_is_running(std::path::Path::new(&selected.worktree)));
}

#[test]
fn planner_workspace_writes_survive_success_failure_and_reach_children() {
    for action in ["success", "fail"] {
        let (temp, repo, service, config) = setup(false);
        let root = {
            let mut runtime = service.runtime.lock().unwrap();
            let job = runtime.jobs().unwrap().remove(0);
            complete(&mut runtime, job)
        };
        fs::write(temp.path().join("action"), action).unwrap();
        let graph = service.runtime.lock().unwrap().state.graph.clone();
        let result = turn(&service, &config);
        assert_eq!(result.is_err(), action == "fail", "{result:?}");
        assert!(!repo.join("planner.txt").exists(), "a private turn must not modify the source");
        let mut runtime = service.runtime.lock().unwrap();
        assert_eq!(runtime.state.graph, graph);
        assert_ne!(runtime.state.nodes["root"].head, root.after);
        let run = runtime.state.run_id.clone();
        runtime.state = runtime.store.load(&run).unwrap();
        let jobs = runtime.jobs().unwrap();
        for job in jobs {
            let child = complete(&mut runtime, job);
            assert_eq!(fs::read_to_string(PathBuf::from(child.worktree).join("planner.txt")).unwrap(),
                "Planner writes at the frontier");
        }
        let job = runtime.jobs().unwrap().remove(0);
        complete(&mut runtime, job);
        runtime.jobs().unwrap();
        let heads = runtime.state.publication.as_ref().unwrap().heads.clone();
        let head = crate::graph_merge::merge_graph_scoped(&repo, &heads, &[], || Err("unexpected conflict".into())).unwrap();
        runtime.emit(EventKind::PublicationCompleted { head }).unwrap();
        assert_eq!(fs::read_to_string(repo.join("planner.txt")).unwrap(), "Planner writes at the frontier");
    }
}

#[test]
fn planner_workspace_uses_a_running_writer_and_rejects_a_missing_frontier() {
    let (_temp, _repo, service, _config) = setup(false);
    let mut runtime = service.runtime.lock().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    assert_eq!(runtime.planner_workspace().unwrap().unwrap().id, job.execution.id);
    assert!(runtime.capture_planner_workspace(&job.execution.id).unwrap_err().contains("active writer"));
    let root = complete(&mut runtime, job);
    let path = PathBuf::from(&root.worktree);
    let saved = path.with_extension("saved");
    fs::rename(&path, &saved).unwrap();
    assert!(runtime.planner_workspace().unwrap_err().contains("missing"));
    crate::path_safety::directory_link(&saved, &path);
    assert!(runtime.planner_workspace().is_err());
    crate::path_safety::remove_directory_link(&path);
    fs::rename(saved, path).unwrap();
}

#[test]
fn planner_workspace_returns_to_source_after_publication_reclaims_its_previous_cwd() {
    let (temp, repo, service, config) = setup(false);
    let root = {
        let mut runtime = service.runtime.lock().unwrap();
        let job = runtime.jobs().unwrap().remove(0);
        complete(&mut runtime, job)
    };
    let prior = turn(&service, &config).unwrap();
    // Finish and publish before cleanup; the old session header still names
    // the now-reclaimed node directory.
    {
        let mut runtime = service.runtime.lock().unwrap();
        while runtime.state.nodes.values().any(|node| node.status != "completed") {
            let jobs = runtime.jobs().unwrap();
            assert!(!jobs.is_empty());
            for job in jobs { complete(&mut runtime, job); }
        }
        runtime.jobs().unwrap();
        let heads = runtime.state.publication.as_ref().unwrap().heads.clone();
        let head = crate::graph_merge::merge_graph_scoped(&repo, &heads, &[], || Err("unexpected conflict".into())).unwrap();
        runtime.emit(EventKind::PublicationCompleted { head }).unwrap();
        runtime.cleanup_worktrees().unwrap();
    }
    assert!(!PathBuf::from(root.worktree).exists());
    let next = turn(&service, &config).unwrap();
    assert_eq!(PathBuf::from(next.planning.unwrap().worktree.unwrap()).canonicalize().unwrap(), repo.canonicalize().unwrap());
    assert_eq!(next.run_id, prior.run_id);
    let session = temp.path().join("runtime/planner-sessions").join(next.run_id);
    assert_eq!(fs::read_dir(session).unwrap().flatten().filter(|e| e.path().extension().is_some_and(|ext| ext == "jsonl")).count(), 1);
    // A later revision's missing unpublished slot is not permission to fall
    // back to the older published source merely because published_head exists.
    let mut runtime = service.runtime.lock().unwrap();
    let mut graph = runtime.state.graph.clone();
    graph.nodes.push(Node { name: "later".into(), task: "later".into() });
    graph.edges.push(Edge { from: "join".into(), to: "later".into(), feedback: false });
    runtime.revise_graph(graph, PlanningSummary { planning_id: Uuid::new_v4().to_string(), ..Default::default() }).unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    let later = complete(&mut runtime, job);
    fs::remove_dir_all(later.worktree).unwrap();
    assert!(runtime.planner_workspace().unwrap_err().contains("missing"));
}

#[test]
fn interrupted_planner_workspace_is_snapshotted_once_before_recovery() {
    let (temp, _repo, service, _config) = setup(false);
    let root = {
        let mut runtime = service.runtime.lock().unwrap();
        let job = runtime.jobs().unwrap().remove(0);
        complete(&mut runtime, job)
    };
    let id = Uuid::new_v4().to_string();
    let attempt = temp.path().join("runtime/planning").join(&id);
    fs::create_dir_all(&attempt).unwrap();
    let mut runtime = service.runtime.lock().unwrap();
    let run = runtime.state.run_id.clone();
    let summary = PlanningSummary { planning_id: id, status: Some("running".into()),
        worktree: Some(root.worktree.clone()), workspace_execution_id: Some(root.id),
        ..Default::default() };
    write_planning_summary(&attempt, &summary).unwrap();
    fs::write(attempt.join("request.json"), serde_json::to_vec(&serde_json::json!({
        "revisionRunId": run, "runId": run,
    })).unwrap()).unwrap();
    runtime.emit(EventKind::PlannerWorkspaceSelected { planning: summary }).unwrap();
    fs::write(PathBuf::from(root.worktree).join("interrupted.txt"), "keep me").unwrap();
    drop(runtime);
    recover_plannings(&service).unwrap();
    recover_plannings(&service).unwrap();
    let runtime = service.runtime.lock().unwrap();
    assert_ne!(runtime.state.nodes["root"].head, root.after);
    assert_eq!(runtime.state.events.iter().filter(|e| matches!(e.kind, EventKind::PlannerWorkspaceSnapshotted { .. })).count(), 1);
    assert_eq!(runtime.state.events.iter().filter(|e| matches!(e.kind, EventKind::PlannerTurnAborted { .. })).count(), 1);
}
