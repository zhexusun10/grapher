use super::*;
use crate::runtime::Job;
use std::path::Path;

fn setup(shadow: bool) -> (tempfile::TempDir, PathBuf, Arc<Service>, Config) {
    setup_with_environment(shadow, false)
}

fn setup_with_environment(
    shadow: bool,
    managed: bool,
) -> (tempfile::TempDir, PathBuf, Arc<Service>, Config) {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("source");
    fs::create_dir(&repo).unwrap();
    fs::write(repo.join("base.txt"), "source").unwrap();
    if !shadow {
        crate::workspace::git(&repo, &["init", "-q"]).unwrap();
        crate::workspace::git(&repo, &["add", "-A"]).unwrap();
        crate::workspace::git(&repo, &["commit", "-q", "-m", "base"]).unwrap();
    }
    let script = temp.path().join("agent.mjs");
    fs::write(&script, r#"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
let input = ''; for await (const chunk of process.stdin) input += chunk;
  if (process.env.GRAPHER_MODE === 'planner') {
  const context = input.startsWith('You are now at ') && input.includes('\nCurrent graph node status:\n');
  const bare = input === 'additional information';
  if (!context && !bare)
    throw Error('Planner follow-up must be either transport context or a bare instruction');
  if (context && !input.endsWith('\nadditional information'))
    throw Error('Transport context must end with the user instruction');
  if (context && process.env.GRAPHER_PLANNER_FOLLOWUP !== 'true')
    throw Error('Context-bearing Planner turn must expose follow-up workspace mode');
  if (bare && process.env.GRAPHER_PLANNER_FOLLOWUP !== 'false')
    throw Error('Context-free Planner turn must not expose switch_workspace');
  const arg = name => process.argv[process.argv.indexOf(name)+1];
  const directory = arg('--session-dir'), id = arg('--session-id');
  const file = path.join(directory, `grapher_${id}.jsonl`);
  const rework = `Modifying a completed node's task re-runs that node in a fresh session and invalidates all its downstream dependents (they re-run their previous tasks with the updated dependencies' workspace states); unrelated branches keep their work.`;
  const priorTurn = fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('preserved history');
  if (bare && input.includes(rework))
    throw Error('A bare Planner turn must not contain the rework note');
  if (context && input.includes(rework) !== !priorTurn)
    throw Error('Planner rework note must appear only on the first context-bearing follow-up');
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
    } else if (actionText !== 'delete-right-no-write') {
      fs.writeFileSync('planner.txt', 'Planner writes at the frontier');
      if (actionText === 'fail') throw Error('deliberate Planner failure');
    }
    if (actionText.startsWith('delete-right')) {
      if (!input.includes('retained workspace from a superseded or removed execution'))
        throw Error('Planner must know this is a historical workspace');
      const graph = JSON.parse(fs.readFileSync(process.env.GRAPHER_GRAPH_PATH, 'utf8'));
      graph.nodes = graph.nodes.filter(node => node.name !== 'right');
      graph.edges = graph.edges.filter(edge => edge.from !== 'right' && edge.to !== 'right');
      fs.writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify(graph));
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
    let mut config: Config = serde_json::from_value(serde_json::json!({
        "repository": repo, "engine": "pi", "piCommand": "node", "piArgs": [script],
        "model": "mock/workspace", "maxParallel": 2, "postTaskReview": false,
    }))
    .unwrap();
    if managed {
        config.environment = crate::environment_automatic::resolve(&repo, false)
            .unwrap()
            .0;
    }
    let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
    runtime
        .create(
            Graph {
                original_goal: "frontier".into(),
                nodes: ["root", "left", "right", "join"]
                    .into_iter()
                    .map(|name| Node {
                        name: name.into(),
                        task: name.into(),
                    })
                    .collect(),
                edges: [
                    ("root", "left"),
                    ("root", "right"),
                    ("left", "join"),
                    ("right", "join"),
                ]
                .into_iter()
                .map(|(from, to)| Edge {
                    from: from.into(),
                    to: to.into(),
                    feedback: false,
                })
                .collect(),
            },
            config.clone(),
        )
        .unwrap();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(true),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
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
    let result = perform_with_merger(
        &job,
        &runtime.root,
        &runtime.parents(&job.execution.node),
        |_| {},
        |head| {
            prepared = Some(head);
            Ok(())
        },
        |_| Err("unexpected conflict".into()),
    );
    runtime
        .emit(EventKind::Prepared {
            execution_id: job.execution.id.clone(),
            head: prepared.unwrap(),
        })
        .unwrap();
    runtime.finish(&job.execution, result).unwrap();
    runtime
        .state
        .executions
        .iter()
        .find(|e| e.id == job.execution.id)
        .unwrap()
        .clone()
}

fn turn(
    service: &Arc<Service>,
    config: &Config,
) -> Result<Snapshot, (String, Option<PlanningSummary>)> {
    let run = service.runtime.lock().unwrap().state.run_id.clone();
    plan_goal_internal(
        "additional information".into(),
        config.clone(),
        Some("graph"),
        None,
        Some(run),
        service,
        |_| {},
        |_| {},
        |_| {},
    )
}

#[test]
fn planner_external_state_only_write_is_sealed_and_replayed_atomically_with_code() {
    let (temp, _repo, service, _) = setup_with_environment(false, true);
    let mut runtime = service.runtime.lock().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    let execution = complete(&mut runtime, job);
    let before = execution.result.as_ref().unwrap();
    let state = crate::workspace_state::process_root(Path::new(&execution.worktree)).unwrap();
    fs::create_dir_all(state.join(".agent-home")).unwrap();
    fs::write(state.join(".agent-home/planner-setting"), "retained").unwrap();
    runtime.capture_planner_workspace(&execution.id).unwrap();
    let result = runtime
        .state
        .executions
        .iter()
        .find(|e| e.id == execution.id)
        .unwrap()
        .result
        .clone()
        .unwrap();
    assert_eq!(
        result.code_ref, before.code_ref,
        "state-only changes do not invent code changes"
    );
    assert_ne!(result.environment_ref, before.environment_ref);
    assert_ne!(
        result.generation, execution.id,
        "Planner is not another node attempt"
    );
    let event = runtime
        .state
        .events
        .iter()
        .rev()
        .find(|event| matches!(event.kind, EventKind::PlannerWorkspaceSnapshotted { .. }))
        .unwrap();
    let mut legacy = serde_json::to_value(&event.kind).unwrap();
    legacy.as_object_mut().unwrap().remove("result");
    legacy.as_object_mut().unwrap().remove("detached");
    assert!(
        matches!(
            serde_json::from_value::<EventKind>(legacy),
            Ok(EventKind::PlannerWorkspaceSnapshotted {
                detached: false,
                ..
            })
        ),
        "legacy events stay readable"
    );
    let run = runtime.state.run_id.clone();
    let loaded = runtime.store.load(&run).unwrap();
    assert_eq!(
        loaded
            .executions
            .iter()
            .find(|e| e.id == execution.id)
            .unwrap()
            .result
            .as_ref(),
        Some(&result)
    );
    assert_eq!(loaded.nodes["root"].result.as_ref(), Some(&result));
    drop(runtime);
    drop(service);
    let recovered = Runtime::open(&temp.path().join("runtime")).unwrap();
    assert_eq!(
        recovered
            .state
            .executions
            .iter()
            .find(|e| e.id == execution.id)
            .unwrap()
            .result
            .as_ref(),
        Some(&result)
    );
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
        for job in jobs {
            complete(&mut runtime, job);
        }
    }
    fs::write(temp.path().join("action"), "move-left").unwrap();
    let moved = turn(&service, &config).unwrap();
    let left = moved
        .executions
        .iter()
        .rev()
        .find(|execution| execution.node == "left")
        .unwrap();
    assert_eq!(
        moved
            .planning
            .as_ref()
            .unwrap()
            .workspace_execution_id
            .as_deref(),
        Some(left.id.as_str())
    );
    assert_eq!(
        moved.planning.as_ref().unwrap().worktree.as_deref(),
        Some(left.worktree.as_str())
    );

    // No node execution was added after the explicit move, so another user
    // message keeps the same workspace instead of snapping back to right.
    let repeated = turn(&service, &config).unwrap();
    assert_eq!(
        repeated
            .planning
            .as_ref()
            .unwrap()
            .workspace_execution_id
            .as_deref(),
        Some(left.id.as_str())
    );
    assert_eq!(
        repeated.planning.as_ref().unwrap().worktree.as_deref(),
        Some(left.worktree.as_str())
    );
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
    let reused = [root, left, right]
        .into_iter()
        .find(|execution| execution.worktree == join.worktree)
        .expect("the linear handoff should reuse one parent workspace");
    let resolution = runtime
        .planner_workspace_for_node(&reused.node)
        .unwrap()
        .unwrap();
    assert_eq!(resolution.execution.id, join.id);
    assert_eq!(
        resolution.redirected_from.as_deref(),
        Some(reused.node.as_str())
    );
    assert_eq!(
        runtime
            .planner_workspace_for_node("join")
            .unwrap()
            .unwrap()
            .execution
            .id,
        join.id
    );
}
#[test]
fn planner_workspace_tracks_linear_and_parallel_frontiers_across_turns_and_reload() {
    for shadow in [false, true] {
        let (temp, repo, mut service, config) = setup(shadow);
        let initial = turn(&service, &config).unwrap();
        assert_eq!(
            PathBuf::from(initial.planning.unwrap().worktree.unwrap())
                .canonicalize()
                .unwrap(),
            repo.canonicalize().unwrap()
        );
        let root = {
            let mut runtime = service.runtime.lock().unwrap();
            let job = runtime.jobs().unwrap().remove(0);
            complete(&mut runtime, job)
        };
        let first = turn(&service, &config).unwrap();
        assert_eq!(
            first
                .planning
                .as_ref()
                .unwrap()
                .workspace_execution_id
                .as_deref(),
            Some(root.id.as_str())
        );
        let (left, right) = {
            let mut runtime = service.runtime.lock().unwrap();
            let mut jobs = runtime.jobs().unwrap();
            assert_eq!(jobs.len(), 2);
            let right_job = jobs.pop().unwrap();
            let left = complete(&mut runtime, jobs.pop().unwrap());
            let right = complete(&mut runtime, right_job);
            (left, right)
        };
        assert_ne!(
            left.worktree, right.worktree,
            "fan-out must provide a different cwd"
        );
        assert_ne!(root.worktree, right.worktree);
        // Reopen the actual store, not a cached pointer to the Planner's cwd.
        drop(service);
        service = Arc::new(Service {
            runtime: Mutex::new(Runtime::open(&temp.path().join("runtime")).unwrap()),
            driving: AtomicBool::new(true),
            drive_signal: (Mutex::new(0), Condvar::new()),
            planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });
        let second = turn(&service, &config).unwrap();
        let selected = second.planning.as_ref().unwrap();
        assert_eq!(selected.worktree.as_deref(), Some(right.worktree.as_str()));
        assert_eq!(
            selected.workspace_execution_id.as_deref(),
            Some(right.id.as_str())
        );
        let _join = {
            let mut runtime = service.runtime.lock().unwrap();
            if runtime.state.paused {
                runtime.pause(false).unwrap();
            }
            let job = runtime.jobs().unwrap().remove(0);
            complete(&mut runtime, job)
        };
        let final_turn = turn(&service, &config).unwrap();
        // With every node completed there is no node workspace to follow;
        // the next turn uses source and offers no workspace switch.
        assert_eq!(
            final_turn.planning.as_ref().unwrap().workspace_execution_id,
            None
        );
        assert_eq!(
            PathBuf::from(
                final_turn
                    .planning
                    .as_ref()
                    .unwrap()
                    .worktree
                    .as_deref()
                    .unwrap()
            )
            .canonicalize()
            .unwrap(),
            repo.canonicalize().unwrap()
        );
        let runtime = service.runtime.lock().unwrap();
        let session = runtime
            .root
            .join("planner-sessions")
            .join(&final_turn.run_id);
        let files: Vec<_> = fs::read_dir(session)
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl"))
            .collect();
        assert_eq!(
            files.len(),
            1,
            "cwd changes must not create another conversation"
        );
        let contents = fs::read_to_string(files[0].path()).unwrap();
        assert_eq!(contents.matches("preserved history").count(), 4);
        let replay = runtime.store.load(&final_turn.run_id).unwrap();
        assert_eq!(
            replay
                .events
                .iter()
                .filter(|event| matches!(event.kind, EventKind::PlannerWorkspaceSelected { .. }))
                .count(),
            4
        );
        assert_eq!(
            replay
                .events
                .iter()
                .filter(|event| matches!(event.kind, EventKind::PlannerReworkNoteInjected))
                .count(),
            1
        );
        assert_eq!(
            replay.planning.unwrap().worktree,
            final_turn.planning.unwrap().worktree
        );
    }
}

#[test]
fn completed_graph_consumes_rework_marker_and_uses_source_without_switch() {
    let (_temp, repo, service, config) = setup(false);
    {
        let mut runtime = service.runtime.lock().unwrap();
        while !runtime
            .state
            .nodes
            .values()
            .all(|node| node.status == "completed")
        {
            let jobs = runtime.jobs().unwrap();
            assert!(!jobs.is_empty());
            for job in jobs {
                complete(&mut runtime, job);
            }
        }
    }
    let snapshot = turn(&service, &config).unwrap();
    let planning = snapshot.planning.as_ref().unwrap();
    assert_eq!(planning.workspace_execution_id, None);
    assert_eq!(
        PathBuf::from(planning.worktree.as_deref().unwrap())
            .canonicalize()
            .unwrap(),
        repo.canonicalize().unwrap()
    );
    let replay = service
        .runtime
        .lock()
        .unwrap()
        .store
        .load(&snapshot.run_id)
        .unwrap();
    assert_eq!(
        replay
            .events
            .iter()
            .filter(|event| matches!(event.kind, EventKind::PlannerReworkNoteInjected))
            .count(),
        1
    );
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
    assert_eq!(
        service.runtime.lock().unwrap().state.nodes["left"].status,
        "running"
    );
    let snapshot = turn(&service, &config).unwrap();
    assert_eq!(
        snapshot.planning.unwrap().workspace_execution_id.as_deref(),
        Some(right.id.as_str())
    );
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
    assert!(jobs
        .iter()
        .all(|job| runtime.state.nodes[&job.execution.node].status == "running"));
    // A still-preparing latest slot is retired instead of failing the turn:
    // Planner answers from the source project until preparation is recorded.
    assert!(runtime.planner_workspace().unwrap().is_none());
    let job = jobs.last().unwrap();
    let head = crate::workspace::prepare(
        Path::new(&job.config.repository),
        Path::new(&job.execution.worktree),
        &job.execution.before,
        &job.parent_heads,
    )
    .unwrap();
    runtime
        .emit(EventKind::Prepared {
            execution_id: job.execution.id.clone(),
            head,
        })
        .unwrap();
    let selected = runtime
        .planner_workspace()
        .unwrap()
        .expect("a prepared frontier is selected directly");
    assert!(
        jobs.iter().any(|job| job.execution.id == selected.id),
        "an active frontier is selected directly instead of falling back to source"
    );
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
        assert!(
            !repo.join("planner.txt").exists(),
            "a private turn must not modify the source"
        );
        let mut runtime = service.runtime.lock().unwrap();
        assert_eq!(runtime.state.graph, graph);
        assert_ne!(runtime.state.nodes["root"].head, root.after);
        let run = runtime.state.run_id.clone();
        runtime.state = runtime.store.load(&run).unwrap();
        let jobs = runtime.jobs().unwrap();
        for job in jobs {
            let child = complete(&mut runtime, job);
            assert_eq!(
                fs::read_to_string(PathBuf::from(child.worktree).join("planner.txt")).unwrap(),
                "Planner writes at the frontier"
            );
        }
        let job = runtime.jobs().unwrap().remove(0);
        complete(&mut runtime, job);
        runtime.jobs().unwrap();
        let heads = runtime.state.publication.as_ref().unwrap().heads.clone();
        let head = crate::graph_merge::merge_graph_scoped(&repo, &heads, &[], |_| {
            Err("unexpected conflict".into())
        })
        .unwrap();
        runtime
            .emit(EventKind::PublicationCompleted { head })
            .unwrap();
        assert_eq!(
            fs::read_to_string(repo.join("planner.txt")).unwrap(),
            "Planner writes at the frontier"
        );
    }
}

#[test]
fn planner_workspace_uses_a_running_writer_and_retires_an_unusable_latest_slot() {
    let (_temp, _repo, service, _config) = setup(false);
    let mut runtime = service.runtime.lock().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    assert!(
        runtime.planner_workspace().unwrap().is_none(),
        "an unprepared latest slot is retired instead of failing the turn"
    );
    let head = crate::workspace::prepare(
        Path::new(&job.config.repository),
        Path::new(&job.execution.worktree),
        &job.execution.before,
        &[],
    )
    .unwrap();
    runtime
        .emit(EventKind::Prepared {
            execution_id: job.execution.id.clone(),
            head,
        })
        .unwrap();
    assert_eq!(
        runtime.planner_workspace().unwrap().unwrap().id,
        job.execution.id
    );
    assert!(runtime
        .capture_planner_workspace(&job.execution.id)
        .unwrap_err()
        .contains("active writer"));
    let root = complete(&mut runtime, job);
    let path = PathBuf::from(&root.worktree);
    let saved = path.with_extension("saved");
    fs::rename(&path, &saved).unwrap();
    assert!(
        runtime.planner_workspace().unwrap().is_none(),
        "a vanished latest slot retires to the source project, never an older slot"
    );
    crate::path_safety::directory_link(&saved, &path);
    assert!(
        runtime.planner_workspace().unwrap().is_none(),
        "a linked latest slot is retired instead of failing the Planner turn"
    );
    crate::path_safety::remove_directory_link(&path);
    fs::rename(saved, path).unwrap();
    assert_eq!(runtime.planner_workspace().unwrap().unwrap().id, root.id);
}

#[test]
fn planner_omits_unready_optional_slots_and_rechecks_after_restart() {
    let (temp, repo, mut service, config) = setup(false);
    let (left, right) = {
        let mut runtime = service.runtime.lock().unwrap();
        let root = runtime.jobs().unwrap().remove(0);
        complete(&mut runtime, root);
        let mut jobs = runtime.jobs().unwrap();
        let right_job = jobs.pop().unwrap();
        let left = complete(&mut runtime, jobs.pop().unwrap());
        let right = complete(&mut runtime, right_job);
        (left, right)
    };
    assert_ne!(left.worktree, right.worktree);
    let marker = crate::workspace_state::root(Path::new(&left.worktree))
        .unwrap()
        .join("project-ready");
    let saved = fs::read(&marker).unwrap();
    fs::remove_file(&marker).unwrap();
    {
        let runtime = service.runtime.lock().unwrap();
        assert!(runtime
            .planner_workspace_for_node("left")
            .unwrap()
            .is_none());
        let targets = runtime
            .planner_workspace_targets(Some("right"), Path::new(&right.worktree))
            .unwrap();
        assert!(targets
            .as_object()
            .unwrap()
            .values()
            .all(|target| target["workspace"] != left.worktree));
    }
    let snapshot = turn(&service, &config).unwrap();
    assert_eq!(
        snapshot.planning.unwrap().workspace_execution_id.as_deref(),
        Some(right.id.as_str())
    );
    drop(service);
    service = Arc::new(Service {
        runtime: Mutex::new(Runtime::open(&temp.path().join("runtime")).unwrap()),
        driving: AtomicBool::new(true),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused.ts"),
    });
    assert!(service
        .runtime
        .lock()
        .unwrap()
        .planner_workspace_for_node("left")
        .unwrap()
        .is_none());
    fs::write(&marker, "not-the-prepared-head").unwrap();
    assert!(service
        .runtime
        .lock()
        .unwrap()
        .planner_workspace_for_node("left")
        .unwrap()
        .is_none());
    fs::write(&marker, saved).unwrap();
    let runtime = service.runtime.lock().unwrap();
    assert_eq!(
        runtime
            .planner_workspace_for_node("left")
            .unwrap()
            .unwrap()
            .execution
            .id,
        left.id
    );
    let targets = runtime
        .planner_workspace_targets(Some("right"), Path::new(&right.worktree))
        .unwrap();
    assert_eq!(targets["left"]["executionId"], left.id);
    assert!(
        runtime
            .planner_workspace_targets(None, &repo)
            .unwrap()
            .as_object()
            .unwrap()
            .is_empty(),
        "a source-native Planner cannot grant private slots from another parent"
    );
}

#[test]
fn planner_rejects_a_reused_ready_marker_before_the_new_attempt_is_prepared() {
    let (_temp, _repo, service, _config) = setup(false);
    let mut runtime = service.runtime.lock().unwrap();
    let root_job = runtime.jobs().unwrap().remove(0);
    let root = complete(&mut runtime, root_job);
    let jobs = runtime.jobs().unwrap();
    let reused = jobs
        .iter()
        .find(|job| job.execution.worktree == root.worktree)
        .expect("one parallel child reuses the prepared root slot");
    let marker = crate::workspace_state::root(Path::new(&reused.execution.worktree))
        .unwrap()
        .join("project-ready");
    assert!(
        marker.is_file(),
        "the old occupant's marker is still present"
    );
    assert!(
        runtime
            .planner_workspace_for_node(&reused.execution.node)
            .unwrap()
            .is_none(),
        "an old marker is not Prepared evidence for the new occupant"
    );
}

#[test]
fn planner_does_not_offer_an_older_slot_when_the_latest_owner_is_missing() {
    let (_temp, _repo, service, _config) = setup(false);
    let mut runtime = service.runtime.lock().unwrap();
    let root_job = runtime.jobs().unwrap().remove(0);
    complete(&mut runtime, root_job);
    let mut jobs = runtime.jobs().unwrap();
    let right = jobs.pop().unwrap();
    let left = complete(&mut runtime, jobs.pop().unwrap());
    complete(&mut runtime, right);
    assert!(runtime
        .planner_workspace_for_node("left")
        .unwrap()
        .is_some());
    let mut missing = left.clone();
    missing.id = Uuid::new_v4().to_string();
    missing.worktree = Path::new(&left.worktree)
        .with_file_name("missing-new-slot")
        .to_string_lossy()
        .into_owned();
    missing.status = "running".into();
    missing.after = None;
    let id = missing.id.clone();
    runtime
        .emit(EventKind::Started {
            execution: missing,
            message_sequences: None,
            fresh_restart: false,
        })
        .unwrap();
    assert!(
        runtime
            .planner_workspace_for_node("left")
            .unwrap()
            .is_none(),
        "a previous execution must not masquerade as the node's latest workspace"
    );
    runtime
        .emit(EventKind::Failed {
            node: "left".into(),
            execution_id: Some(id),
            error: "failed before preparation".into(),
            output_bytes: 0,
            metrics: None,
        })
        .unwrap();
    assert!(
        runtime.planner_workspace().unwrap().is_none(),
        "an unusable latest owner retires to the source project instead of the older slot"
    );
}

#[test]
fn planner_retires_an_unready_latest_slot_and_plans_in_the_source_project() {
    let (_temp, repo, service, config) = setup(false);
    let (latest, selections, captures) = {
        let mut runtime = service.runtime.lock().unwrap();
        let root = runtime.jobs().unwrap().remove(0);
        complete(&mut runtime, root);
        let mut jobs = runtime.jobs().unwrap();
        let right = jobs.pop().unwrap();
        complete(&mut runtime, jobs.pop().unwrap());
        let latest = complete(&mut runtime, right);
        let count = |predicate: fn(&EventKind) -> bool| {
            runtime
                .state
                .events
                .iter()
                .filter(|event| predicate(&event.kind))
                .count()
        };
        (
            latest,
            count(|kind| matches!(kind, EventKind::PlannerWorkspaceSelected { .. })),
            count(|kind| matches!(kind, EventKind::PlannerWorkspaceSnapshotted { .. })),
        )
    };
    let marker = crate::workspace_state::root(Path::new(&latest.worktree))
        .unwrap()
        .join("project-ready");
    let saved = fs::read(&marker).unwrap();
    fs::remove_file(&marker).unwrap();
    let next = turn(&service, &config)
        .expect("an unready latest workspace must not fail the user's Planner turn");
    let planning = next.planning.as_ref().unwrap();
    assert_eq!(
        planning.workspace_execution_id, None,
        "the unready slot is retired for this turn"
    );
    assert_eq!(
        PathBuf::from(planning.worktree.as_deref().unwrap())
            .canonicalize()
            .unwrap(),
        repo.canonicalize().unwrap(),
        "Planner plans in the source project instead"
    );
    {
        let mut runtime = service.runtime.lock().unwrap();
        // Retirement is a selection decision, not a capture permission.
        let error = runtime.capture_planner_workspace(&latest.id).unwrap_err();
        assert!(error.contains("unready Planner workspace"), "{error}");
        assert_eq!(
            runtime
                .state
                .events
                .iter()
                .filter(|event| matches!(event.kind, EventKind::PlannerWorkspaceSelected { .. }))
                .count(),
            selections + 1,
            "the source selection is recorded durably"
        );
        assert_eq!(
            runtime
                .state
                .events
                .iter()
                .filter(|event| matches!(event.kind, EventKind::PlannerWorkspaceSnapshotted { .. }))
                .count(),
            captures,
            "the unvisited partial slot is never snapshotted"
        );
        assert!(
            next.events.iter().any(|event| matches!(
                &event.kind,
                EventKind::GraphRevised {
                    source_head: Some(_),
                    ..
                }
            )),
            "the source turn records its own input head instead of a node result"
        );
        assert!(runtime.planner_workspace().unwrap().is_none());
    }
    fs::write(marker, saved).unwrap();
    assert_eq!(
        turn(&service, &config)
            .unwrap()
            .planning
            .unwrap()
            .workspace_execution_id
            .as_deref(),
        Some(latest.id.as_str())
    );
}

#[test]
fn planner_keeps_a_superseded_physical_owner_without_attributing_it_to_an_older_attempt() {
    for (write, fail) in [(false, false), (true, false), (true, true)] {
        let (temp, repo, mut service, config) = setup(false);
        let (selected, prior, run, original_ref) = {
            let mut runtime = service.runtime.lock().unwrap();
            let root_job = runtime.jobs().unwrap().remove(0);
            let root = complete(&mut runtime, root_job);
            let head = root.after.clone().unwrap();
            // An older occupant failed before preparation; a later execution
            // successfully prepared and then retained this same physical slot.
            let mut prior = root.clone();
            prior.id = Uuid::new_v4().to_string();
            prior.node = "right".into();
            prior.status = "running".into();
            prior.before = head.clone();
            prior.after = None;
            prior.completed_at = None;
            runtime
                .emit(EventKind::Started {
                    execution: prior.clone(),
                    message_sequences: None,
                    fresh_restart: false,
                })
                .unwrap();
            runtime
                .emit(EventKind::Failed {
                    node: prior.node.clone(),
                    execution_id: Some(prior.id.clone()),
                    error: "preparation failed".into(),
                    output_bytes: 0,
                    metrics: None,
                })
                .unwrap();
            let mut selected = prior.clone();
            selected.id = Uuid::new_v4().to_string();
            selected.node = "left".into();
            selected.status = "running".into();
            runtime
                .emit(EventKind::Started {
                    execution: selected.clone(),
                    message_sequences: None,
                    fresh_restart: false,
                })
                .unwrap();
            runtime
                .emit(EventKind::Prepared {
                    execution_id: selected.id.clone(),
                    head: head.clone(),
                })
                .unwrap();
            runtime
                .emit(EventKind::Failed {
                    node: selected.node.clone(),
                    execution_id: Some(selected.id.clone()),
                    error: "paused".into(),
                    output_bytes: 0,
                    metrics: None,
                })
                .unwrap();
            let summary = PlanningSummary {
                planning_id: Uuid::new_v4().to_string(),
                worktree: Some(selected.worktree.clone()),
                workspace_execution_id: Some(selected.id.clone()),
                ..Default::default()
            };
            runtime
                .emit(EventKind::PlannerWorkspaceSelected {
                    planning: summary.clone(),
                })
                .unwrap();
            // Rewire the selected node, superseding its attempt without a new
            // physical owner, as in the reported follow-up failure.
            let mut graph = runtime.state.graph.clone();
            graph.nodes.push(Node {
                name: "pre".into(),
                task: "pre".into(),
            });
            graph
                .edges
                .retain(|edge| !(edge.from == "root" && edge.to == "left" && !edge.feedback));
            graph.edges.push(Edge {
                from: "root".into(),
                to: "pre".into(),
                feedback: false,
            });
            graph.edges.push(Edge {
                from: "pre".into(),
                to: "left".into(),
                feedback: false,
            });
            runtime.revise_graph(graph, summary).unwrap();
            assert!(runtime
                .state
                .superseded_execution_ids
                .contains(&selected.id));
            assert!(!runtime.state.superseded_execution_ids.contains(&prior.id));
            let run = runtime.state.run_id.clone();
            let node_ref = format!("refs/grapher/runs/{run}/nodes/left");
            let original_ref =
                crate::workspace::repository_git(&repo, &["rev-parse", "--verify", &node_ref]).ok();
            (selected, prior, run, original_ref)
        };
        // Recovery must identify the same physical owner after reopening.
        drop(service);
        service = Arc::new(Service {
            runtime: Mutex::new(Runtime::open(&temp.path().join("runtime")).unwrap()),
            driving: AtomicBool::new(true),
            drive_signal: (Mutex::new(0), Condvar::new()),
            planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });
        assert_eq!(
            service
                .runtime
                .lock()
                .unwrap()
                .planner_workspace()
                .unwrap()
                .unwrap()
                .id,
            selected.id
        );
        let action = if fail {
            "fail"
        } else if write {
            "delete-right"
        } else {
            "delete-right-no-write"
        };
        fs::write(temp.path().join("action"), action).unwrap();
        let outcome = turn(&service, &config);
        let snapshot = if fail {
            assert!(
                outcome.is_err(),
                "the deliberate Planner error must remain visible"
            );
            service.runtime.lock().unwrap().state.clone()
        } else {
            outcome.unwrap()
        };
        assert_eq!(
            snapshot.graph.nodes.iter().any(|node| node.name == "right"),
            fail,
            "a successful deletion commits; a failed turn retains the prior graph"
        );
        assert!(snapshot.superseded_execution_ids.contains(&selected.id));
        assert_eq!(snapshot.nodes["left"].status, "waiting");
        assert_eq!(
            snapshot.nodes["left"].head, None,
            "historical writes are not a current node result"
        );
        assert_eq!(
            snapshot
                .executions
                .iter()
                .find(|e| e.id == prior.id)
                .unwrap()
                .after,
            None,
            "the older unprepared occupant must not receive Planner writes"
        );
        assert!(
            !repo.join("planner.txt").exists(),
            "private writes must not reach source"
        );
        let detached = snapshot
            .events
            .iter()
            .filter_map(|event| match &event.kind {
                EventKind::PlannerWorkspaceSnapshotted {
                    execution_id,
                    head,
                    invalidated,
                    detached: true,
                    ..
                } if execution_id == &selected.id => Some((head.clone(), invalidated.clone())),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(detached.len(), usize::from(write));
        if write {
            assert!(detached[0].1.is_empty());
            assert_eq!(
                fs::read_to_string(Path::new(&selected.worktree).join("planner.txt")).unwrap(),
                "Planner writes at the frontier"
            );
            assert_eq!(
                snapshot
                    .executions
                    .iter()
                    .find(|e| e.id == selected.id)
                    .unwrap()
                    .after
                    .as_deref(),
                Some(detached[0].0.as_str())
            );
        }
        let node_ref = format!("refs/grapher/runs/{run}/nodes/left");
        assert_eq!(
            crate::workspace::repository_git(&repo, &["rev-parse", "--verify", &node_ref]).ok(),
            original_ref,
            "historical Planner capture must not advance the active node ref"
        );
        let detached_ref = format!("refs/grapher/runs/{run}/planner-detached/{}", selected.id);
        let retained =
            crate::workspace::repository_git(&repo, &["rev-parse", "--verify", &detached_ref])
                .unwrap();
        assert_eq!(
            retained,
            if write {
                detached[0].0.clone()
            } else {
                selected.before.clone()
            }
        );
        drop(service);
        let recovered = Runtime::open(&temp.path().join("runtime")).unwrap();
        assert_eq!(recovered.state.nodes["left"].head, None);
        assert_eq!(
            recovered
                .state
                .graph
                .nodes
                .iter()
                .any(|node| node.name == "right"),
            fail
        );
        assert_eq!(recovered.state.events.iter().filter(|event| matches!(&event.kind,
            EventKind::PlannerWorkspaceSnapshotted { execution_id, detached: true, .. } if execution_id == &selected.id)).count(), usize::from(write));
    }
}

#[test]
fn interrupted_planner_in_superseded_workspace_recovers_detached_once() {
    check_interrupted_detached_recovery(false);
    check_interrupted_detached_recovery(true);
}

fn check_interrupted_detached_recovery(sealed_before_event: bool) {
    let (temp, repo, service, _config) = setup(false);
    let mut runtime = service.runtime.lock().unwrap();
    let root_job = runtime.jobs().unwrap().remove(0);
    let root = complete(&mut runtime, root_job);
    let run = runtime.state.run_id.clone();
    let node_ref = format!("refs/grapher/runs/{run}/nodes/root");
    let original_ref =
        crate::workspace::repository_git(&repo, &["rev-parse", "--verify", &node_ref]).unwrap();
    let mut graph = runtime.state.graph.clone();
    graph
        .nodes
        .iter_mut()
        .find(|node| node.name == "root")
        .unwrap()
        .task = "reworked".into();
    runtime
        .revise_graph(
            graph,
            PlanningSummary {
                planning_id: Uuid::new_v4().to_string(),
                workspace_execution_id: Some(root.id.clone()),
                worktree: Some(root.worktree.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(runtime.state.superseded_execution_ids.contains(&root.id));
    let planning_id = Uuid::new_v4().to_string();
    let attempt = temp.path().join("runtime/planning").join(&planning_id);
    fs::create_dir_all(&attempt).unwrap();
    let summary = PlanningSummary {
        planning_id: planning_id.clone(),
        status: Some("running".into()),
        worktree: Some(root.worktree.clone()),
        workspace_execution_id: Some(root.id.clone()),
        ..Default::default()
    };
    write_planning_summary(&attempt, &summary).unwrap();
    fs::write(
        attempt.join("request.json"),
        serde_json::to_vec(&serde_json::json!({
            "revisionRunId": run, "runId": run,
        }))
        .unwrap(),
    )
    .unwrap();
    runtime
        .emit(EventKind::PlannerWorkspaceSelected { planning: summary })
        .unwrap();
    fs::write(
        Path::new(&root.worktree).join("interrupted-detached.txt"),
        "retained",
    )
    .unwrap();
    if sealed_before_event {
        // Crash after the Git/ref write but before the durable event: replay
        // must adopt the sealed head once rather than lose or duplicate it.
        let head = crate::workspace::snapshot_detached_planner_scoped(
            Path::new(&root.worktree),
            &repo,
            &run,
            &root.id,
            &runtime.exclusions().unwrap(),
        )
        .unwrap();
        assert_ne!(Some(head), root.after);
    }
    drop(runtime);
    recover_plannings(&service).unwrap();
    recover_plannings(&service).unwrap();
    let runtime = service.runtime.lock().unwrap();
    let historical = runtime
        .state
        .executions
        .iter()
        .find(|execution| execution.id == root.id)
        .unwrap();
    assert_ne!(historical.after, root.after);
    assert_eq!(
        runtime.state.nodes["root"].head, None,
        "historical writes are not an active result"
    );
    assert_eq!(runtime.state.events.iter().filter(|event| matches!(&event.kind,
        EventKind::PlannerWorkspaceSnapshotted { execution_id, detached: true, .. } if execution_id == &root.id)).count(), 1);
    assert_eq!(
        runtime
            .state
            .events
            .iter()
            .filter(|event| matches!(&event.kind,
        EventKind::PlannerTurnAborted { planning } if planning.planning_id == planning_id))
            .count(),
        1
    );
    assert_eq!(
        crate::workspace::repository_git(&repo, &["rev-parse", "--verify", &node_ref]).unwrap(),
        original_ref
    );
    let detached_ref = format!("refs/grapher/runs/{run}/planner-detached/{}", root.id);
    assert_eq!(
        crate::workspace::repository_git(&repo, &["rev-parse", "--verify", &detached_ref]).unwrap(),
        historical.after.as_ref().unwrap().as_str()
    );
    assert!(!repo.join("interrupted-detached.txt").exists());
    let replay = runtime.store.load(&run).unwrap();
    assert_eq!(replay.nodes["root"].head, None);
    assert_eq!(
        replay
            .executions
            .iter()
            .find(|execution| execution.id == root.id)
            .unwrap()
            .after,
        historical.after
    );
}

#[test]
fn planner_refuses_capture_when_a_newer_physical_owner_is_superseded() {
    let (_temp, _repo, service, _config) = setup(false);
    let mut runtime = service.runtime.lock().unwrap();
    let root_job = runtime.jobs().unwrap().remove(0);
    let root = complete(&mut runtime, root_job);
    let mut newer = root.clone();
    newer.id = Uuid::new_v4().to_string();
    newer.node = "left".into();
    newer.status = "running".into();
    newer.after = None;
    newer.completed_at = None;
    runtime
        .emit(EventKind::Started {
            execution: newer.clone(),
            message_sequences: None,
            fresh_restart: false,
        })
        .unwrap();
    runtime
        .emit(EventKind::Failed {
            node: newer.node.clone(),
            execution_id: Some(newer.id.clone()),
            error: "preparation failed".into(),
            output_bytes: 0,
            metrics: None,
        })
        .unwrap();
    let graph = runtime.state.graph.clone();
    runtime
        .emit(EventKind::GraphRevised {
            graph,
            planning_id: Uuid::new_v4().to_string(),
            planning: PlanningSummary::default(),
            invalidated: vec!["left".into()],
            source_head: None,
        })
        .unwrap();
    assert!(runtime.state.superseded_execution_ids.contains(&newer.id));
    let error = runtime.capture_planner_workspace(&root.id).unwrap_err();
    assert!(error.contains("ownership changed"), "{error}");
    assert!(runtime
        .planner_workspace_for_node("root")
        .unwrap()
        .is_none());
}

#[test]
fn planner_steering_cannot_add_ungranted_workspaces() {
    let temp = tempfile::tempdir().unwrap();
    let initial = temp.path().join("initial");
    let allowed = temp.path().join("allowed");
    let late = temp.path().join("late");
    for path in [&initial, &allowed, &late] {
        fs::create_dir(path).unwrap();
    }
    let original = serde_json::json!({"allowed": {"workspace": allowed}});
    let grants = planner_workspace_grants(&initial, &original);
    let mut refreshed = serde_json::json!({
        "back": {"workspace": initial}, "allowed": {"workspace": allowed}, "late": {"workspace": late},
    });
    restrict_planner_workspace_targets(&mut refreshed, &grants);
    assert!(refreshed.get("back").is_some());
    assert!(refreshed.get("allowed").is_some());
    assert!(refreshed.get("late").is_none());
    restrict_planner_workspace_targets(&mut refreshed, &[]);
    assert!(refreshed.as_object().unwrap().is_empty());
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
        while runtime
            .state
            .nodes
            .values()
            .any(|node| node.status != "completed")
        {
            let jobs = runtime.jobs().unwrap();
            assert!(!jobs.is_empty());
            for job in jobs {
                complete(&mut runtime, job);
            }
        }
        runtime.jobs().unwrap();
        let heads = runtime.state.publication.as_ref().unwrap().heads.clone();
        let head = crate::graph_merge::merge_graph_scoped(&repo, &heads, &[], |_| {
            Err("unexpected conflict".into())
        })
        .unwrap();
        runtime
            .emit(EventKind::PublicationCompleted { head })
            .unwrap();
        runtime.cleanup_worktrees().unwrap();
    }
    assert!(!PathBuf::from(root.worktree).exists());
    let next = turn(&service, &config).unwrap();
    assert_eq!(
        PathBuf::from(next.planning.unwrap().worktree.unwrap())
            .canonicalize()
            .unwrap(),
        repo.canonicalize().unwrap()
    );
    assert_eq!(next.run_id, prior.run_id);
    let session = temp
        .path()
        .join("runtime/planner-sessions")
        .join(next.run_id);
    assert_eq!(
        fs::read_dir(session)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "jsonl"))
            .count(),
        1
    );
    // A later revision's missing unpublished slot retires to the source
    // project; it never falls back to the older published slot.
    let mut runtime = service.runtime.lock().unwrap();
    let mut graph = runtime.state.graph.clone();
    graph.nodes.push(Node {
        name: "later".into(),
        task: "later".into(),
    });
    graph.edges.push(Edge {
        from: "join".into(),
        to: "later".into(),
        feedback: false,
    });
    runtime
        .revise_graph(
            graph,
            PlanningSummary {
                planning_id: Uuid::new_v4().to_string(),
                ..Default::default()
            },
        )
        .unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    let later = complete(&mut runtime, job);
    fs::remove_dir_all(later.worktree).unwrap();
    assert!(
        runtime.planner_workspace().unwrap().is_none(),
        "a vanished latest slot must not resolve to the older published slot"
    );
}

#[test]
fn interrupted_planner_recovers_all_visited_slots_including_external_state() {
    let (temp, _repo, service, _) = setup_with_environment(false, true);
    let mut runtime = service.runtime.lock().unwrap();
    let root = runtime.jobs().unwrap().remove(0);
    complete(&mut runtime, root);
    let jobs = runtime.jobs().unwrap();
    assert_eq!(jobs.len(), 2);
    let executions: Vec<_> = jobs
        .into_iter()
        .map(|job| complete(&mut runtime, job))
        .collect();
    let id = Uuid::new_v4().to_string();
    let attempt = temp.path().join("runtime/planning").join(&id);
    fs::create_dir_all(&attempt).unwrap();
    let run = runtime.state.run_id.clone();
    for execution in &executions {
        let summary = PlanningSummary {
            planning_id: id.clone(),
            status: Some("running".into()),
            worktree: Some(execution.worktree.clone()),
            workspace_execution_id: Some(execution.id.clone()),
            ..Default::default()
        };
        runtime
            .emit(EventKind::PlannerWorkspaceSelected {
                planning: summary.clone(),
            })
            .unwrap();
        write_planning_summary(&attempt, &summary).unwrap();
        fs::write(
            Path::new(&execution.worktree).join("planner-retained"),
            &execution.node,
        )
        .unwrap();
        let state = crate::workspace_state::process_root(Path::new(&execution.worktree)).unwrap();
        fs::create_dir_all(state.join(".agent-home")).unwrap();
        fs::write(state.join(".agent-home/planner-retained"), &execution.node).unwrap();
    }
    fs::write(
        attempt.join("request.json"),
        serde_json::to_vec(&serde_json::json!({
            "revisionRunId": run, "runId": run,
        }))
        .unwrap(),
    )
    .unwrap();
    drop(runtime);
    recover_plannings(&service).unwrap();
    recover_plannings(&service).unwrap();
    let runtime = service.runtime.lock().unwrap();
    for original in executions {
        let updated = runtime
            .state
            .executions
            .iter()
            .find(|e| e.id == original.id)
            .unwrap();
        assert_ne!(updated.after, original.after);
        assert_ne!(
            updated.result.as_ref().unwrap().environment_ref,
            original.result.unwrap().environment_ref
        );
    }
    assert_eq!(
        runtime
            .state
            .events
            .iter()
            .filter(|e| matches!(e.kind, EventKind::PlannerWorkspaceSnapshotted { .. }))
            .count(),
        2
    );
    assert_eq!(
        runtime
            .state
            .events
            .iter()
            .filter(|e| matches!(e.kind, EventKind::PlannerTurnAborted { .. }))
            .count(),
        1
    );
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
    let summary = PlanningSummary {
        planning_id: id,
        status: Some("running".into()),
        worktree: Some(root.worktree.clone()),
        workspace_execution_id: Some(root.id),
        ..Default::default()
    };
    write_planning_summary(&attempt, &summary).unwrap();
    fs::write(
        attempt.join("request.json"),
        serde_json::to_vec(&serde_json::json!({
            "revisionRunId": run, "runId": run,
        }))
        .unwrap(),
    )
    .unwrap();
    runtime
        .emit(EventKind::PlannerWorkspaceSelected { planning: summary })
        .unwrap();
    fs::write(
        PathBuf::from(root.worktree).join("interrupted.txt"),
        "keep me",
    )
    .unwrap();
    drop(runtime);
    recover_plannings(&service).unwrap();
    recover_plannings(&service).unwrap();
    let runtime = service.runtime.lock().unwrap();
    assert_ne!(runtime.state.nodes["root"].head, root.after);
    assert_eq!(
        runtime
            .state
            .events
            .iter()
            .filter(|e| matches!(e.kind, EventKind::PlannerWorkspaceSnapshotted { .. }))
            .count(),
        1
    );
    assert_eq!(
        runtime
            .state
            .events
            .iter()
            .filter(|e| matches!(e.kind, EventKind::PlannerTurnAborted { .. }))
            .count(),
        1
    );
}

#[test]
fn planner_conversation_stop_undoes_a_revision_drain_pause_and_keeps_scheduling() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("source");
    fs::create_dir(&repo).unwrap();
    fs::write(repo.join("base.txt"), "source").unwrap();
    crate::workspace::git(&repo, &["init", "-q"]).unwrap();
    crate::workspace::git(&repo, &["add", "-A"]).unwrap();
    crate::workspace::git(&repo, &["commit", "-q", "-m", "base"]).unwrap();
    let script = temp.path().join("planner.mjs");
    fs::write(
        &script,
        r#"
import fs from 'node:fs';
for await (const _ of process.stdin) {}
fs.writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify({
  originalGoal: 'frontier',
  nodes: [{ name: 'root', task: 'root revised' }, { name: 'join', task: 'join' }],
  edges: [{ from: 'root', to: 'join', feedback: false }],
}));
console.log(JSON.stringify({ type: 'message_end', message: {
  role: 'assistant', content: [{ type: 'text', text: 'revised' }],
} }));
"#,
    )
    .unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repo, "engine": "pi", "piCommand": "node", "piArgs": [script],
        "model": "mock/workspace", "maxParallel": 2, "postTaskReview": false,
    }))
    .unwrap();
    let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
    runtime
        .create(
            Graph {
                original_goal: "frontier".into(),
                nodes: ["root", "join"]
                    .into_iter()
                    .map(|name| Node {
                        name: name.into(),
                        task: name.into(),
                    })
                    .collect(),
                edges: vec![Edge {
                    from: "root".into(),
                    to: "join".into(),
                    feedback: false,
                }],
            },
            config.clone(),
        )
        .unwrap();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();
    let running = runtime.jobs().unwrap().remove(0);
    crate::workspace::prepare(
        &repo,
        Path::new(&running.execution.worktree),
        &running.execution.before,
        &[],
    )
    .unwrap();
    runtime
        .emit(EventKind::Prepared {
            execution_id: running.execution.id.clone(),
            head: running.execution.before.clone(),
        })
        .unwrap();
    let run_id = runtime.state.run_id.clone();
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(true),
        drive_signal: (Mutex::new(0), std::sync::Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused.ts"),
    });
    let planning_service = service.clone();
    let planning_run = run_id.clone();
    let (result_tx, result_rx) = std::sync::mpsc::channel();
    let planner = std::thread::spawn(move || {
        let result = plan_goal_internal(
            "revise root".into(),
            config,
            Some("graph"),
            None,
            Some(planning_run),
            &planning_service,
            |_| {},
            |_| {},
            |_| {},
        );
        let _ = result_tx.send(result.err().map(|error| error.0));
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if let Ok(error) = result_rx.try_recv() {
            panic!("Planner revision ended before the drain pause: {error:?}");
        }
        let paused = service.runtime.lock().unwrap().state.paused;
        if paused {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Planner revision never paused to drain the running node"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    control(
        "stop_planner".into(),
        None,
        None,
        Some(run_id.clone()),
        None,
        None,
        &service,
    )
    .unwrap();
    service
        .runtime
        .lock()
        .unwrap()
        .finish(&running.execution, Err("node interrupted by test".into()))
        .unwrap();
    let _ = planner.join().unwrap();
    assert!(
        result_rx.recv().unwrap().is_some(),
        "Stop must abort the revision before it commits"
    );
    let runtime = service.runtime.lock().unwrap();
    assert!(
        !runtime.state.paused,
        "Planner conversation Stop must undo the internal drain pause"
    );
    assert!(!runtime.state.stop_requested);
    assert_eq!(runtime.state.nodes["root"].status, "failed");
    drop(runtime);
    assert!(!service.planning.load(Ordering::SeqCst));
    assert!(!planner_conversation_stopped(&run_id).unwrap());
}
