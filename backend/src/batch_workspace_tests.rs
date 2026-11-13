use super::*;
use std::path::Path;
use std::time::{Duration, Instant};

fn wait_for_idle(service: &Arc<Service>) -> Snapshot {
    let deadline = Instant::now() + Duration::from_secs(120);
    while service.driving.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline, "batch driver did not settle");
        thread::sleep(Duration::from_millis(20));
    }
    service.runtime.lock().unwrap().state.clone()
}

fn setup(managed: bool, isolate: bool, fail: bool) -> (tempfile::TempDir, PathBuf, Arc<Service>) {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("source");
    fs::create_dir(&repo).unwrap();
    fs::write(repo.join("base.txt"), "base").unwrap();
    crate::workspace::git(&repo, &["init", "-q"]).unwrap();
    crate::workspace::git(&repo, &["add", "-A"]).unwrap();
    crate::workspace::git(&repo, &["commit", "-q", "-m", "base"]).unwrap();
    let script = temp.path().join("agent.mjs");
    let binding = crate::native::host_path(
        &crate::native::installation_root().join("engine/launch-binding.mjs"),
    )
    .to_string_lossy()
    .replace('\\', "/");
    let binding = serde_json::to_string(&format!("file:///{binding}")).unwrap();
    fs::write(&script, format!("import {{ applyLaunchBinding }} from {binding};\n") + r#"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const managed = !!process.env.GRAPHER_LAUNCH_BINDING;
applyLaunchBinding();
const control = path.dirname(fileURLToPath(import.meta.url));
let task = ''; for await (const chunk of process.stdin) task += chunk;
const continuation = task.trim() === '__grapher_continue_interrupted__';
const name = continuation ? 'a' : task.trim();
const arg = key => process.argv[process.argv.indexOf(key)+1];
const sessionDir = arg('--session-dir'), id = arg('--session-id');
fs.mkdirSync(sessionDir, {recursive:true});
let session = fs.readdirSync(sessionDir).find(file => file.endsWith(`_${id}.jsonl`));
if (!session) {
  session = `fixture_${id}.jsonl`;
  fs.writeFileSync(path.join(sessionDir, session), JSON.stringify({type:'session',version:3,id,cwd:process.cwd(),timestamp:new Date().toISOString()})+'\n');
}
const sessionFile = path.join(sessionDir, session);
if (continuation) {
  const history = fs.readFileSync(sessionFile, 'utf8');
  if (!history.includes('"text":"a"')) throw Error('lost the failed node conversation');
  if (JSON.parse(history.split('\n')[0]).cwd !== process.cwd()) throw Error('fork did not rebind cwd');
  if (fs.readFileSync('partial-a.txt','utf8') !== 'unfinished work') throw Error('partial work disappeared');
  fs.writeFileSync('partial-a.txt','recovered');
} else {
  fs.appendFileSync(sessionFile, JSON.stringify({type:'message',id:crypto.randomUUID(),parentId:null,timestamp:new Date().toISOString(),message:{role:'user',content:[{type:'text',text:name}],timestamp:Date.now()}})+'\n');
}
if (['root','join'].includes(name) && fs.existsSync(path.join(control, 'external-edits'))) {
  if (name === 'root' && fs.readFileSync('base.txt', 'utf8') !== 'before dispatch') throw Error('source edit before dispatch was lost');
  fs.writeFileSync(path.join(control, `active-${name}`), 'ready');
  const deadline = Date.now() + 120_000;
  while (!fs.existsSync(path.join(control, `release-${name}`))) {
    if (Date.now() > deadline) throw Error('external edit test timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (fs.readFileSync('base.txt', 'utf8') !== `during ${name}`) throw Error('live source edit was lost');
}
if (name === 'b' && fs.existsSync(path.join(control, 'hold-b'))) {
  fs.writeFileSync(path.join(control, 'active-b'), 'ready');
  const deadline = Date.now() + 120_000;
  while (!fs.existsSync(path.join(control, 'release-b'))) {
    if (Date.now() > deadline) throw Error('shared replenishment test timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
if (name === 'a' && fs.existsSync(path.join(control, 'fail-a'))) {
  fs.writeFileSync('partial-a.txt', 'unfinished work');
  if (fs.existsSync(path.join(control, 'hold-a'))) {
    fs.writeFileSync(path.join(control, 'active-a'), 'ready');
    const deadline = Date.now() + 120_000;
    while (!fs.existsSync(path.join(control, 'release-a'))) {
      if (Date.now() > deadline) throw Error('pause test timed out');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw Error('deliberate provider failure');
}
if (name === 'join') {
  for (const node of ['a','b','c']) if (fs.readFileSync(`${node}.txt`, 'utf8') !== node) throw Error(`missing ${node} before shared join`);
}
if (['a','b','c'].includes(name) && fs.existsSync(path.join(control, 'chain')) && fs.readFileSync('root.txt','utf8') !== 'root') throw Error('private batch missed shared input');
fs.writeFileSync(`${name}.txt`, name);
fs.writeFileSync(path.join(control, `audit-${name}.json`), JSON.stringify({cwd:process.cwd(), managed, continuation, externalFilePresent:fs.existsSync('external.txt')}));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}}));
"#).unwrap();
    let names = if fail {
        vec!["a", "b", "c"]
    } else {
        vec!["root", "a", "b", "c", "join"]
    };
    let edges = if fail {
        vec![]
    } else {
        vec![
            ("root", "a"),
            ("root", "b"),
            ("root", "c"),
            ("a", "join"),
            ("b", "join"),
            ("c", "join"),
        ]
    };
    if fail {
        fs::write(temp.path().join("fail-a"), "fail").unwrap();
    } else {
        fs::write(temp.path().join("chain"), "chain").unwrap();
    }
    let mut config: Config = serde_json::from_value(serde_json::json!({
        "repository": repo, "engine":"pi", "piCommand":"node", "piArgs":[script],
        "model":"test/batches", "maxParallel":0, "postTaskReview":false,
        "isolateParallelNodes":isolate,
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
                original_goal: "batch integration".into(),
                nodes: names
                    .into_iter()
                    .map(|name| Node {
                        name: name.into(),
                        task: name.into(),
                    })
                    .collect(),
                edges: edges
                    .into_iter()
                    .map(|(from, to)| Edge {
                        from: from.into(),
                        to: to.into(),
                        feedback: false,
                    })
                    .collect(),
            },
            config,
        )
        .unwrap();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused.ts"),
    });
    (temp, repo, service)
}

#[test]
fn driver_delivers_private_batch_before_shared_join_without_leaking_environment() {
    for (managed, isolate) in [(false, true), (true, true), (true, false)] {
        let (temp, repo, service) = setup(managed, isolate, false);
        let head = crate::workspace::git(&repo, &["rev-parse", "HEAD"]).unwrap();
        let index = fs::read(repo.join(".git/index")).unwrap();
        drive(service.clone());
        let state = wait_for_idle(&service);
        assert_eq!(state.phase, "completed", "{:?}", state.nodes);
        assert_eq!(state.executions.len(), 5);
        assert_eq!(state.isolated_workspaces, Some(false));
        for name in ["root", "a", "b", "c", "join"] {
            let audit: serde_json::Value = serde_json::from_slice(
                &fs::read(temp.path().join(format!("audit-{name}.json"))).unwrap(),
            )
            .unwrap();
            let private = isolate && ["a", "b", "c"].contains(&name);
            assert_eq!(
                crate::path_identity::same_path(Path::new(audit["cwd"].as_str().unwrap()), &repo),
                !private
            );
            assert_eq!(audit["managed"], managed && private);
            assert_eq!(
                fs::read_to_string(repo.join(format!("{name}.txt"))).unwrap(),
                name
            );
        }
        assert_eq!(
            state
                .events
                .iter()
                .filter(|event| matches!(event.kind, EventKind::PublicationCompleted { .. }))
                .count(),
            usize::from(isolate)
        );
        assert_eq!(
            crate::workspace::git(&repo, &["rev-parse", "HEAD"]).unwrap(),
            head
        );
        assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
        assert!(state.batch_handoff.is_none());
        let runtime = service.runtime.lock().unwrap();
        if !isolate {
            assert!(state.environment_baseline.is_none());
            assert!(
                !runtime
                    .root
                    .join("environments")
                    .join(&state.run_id)
                    .exists(),
                "an unused explicit policy must not initialize a private environment"
            );
        }
        assert_eq!(
            runtime.store.load(&state.run_id).unwrap().phase,
            "completed"
        );
        assert!(state.nodes["join"].result.is_none());
        assert!(state
            .executions
            .iter()
            .find(|execution| execution.node == "join")
            .unwrap()
            .input
            .is_none());
    }
}

#[test]
fn source_nodes_accept_external_edits_before_and_during_execution() {
    for (managed, isolate) in [(false, true), (true, true), (true, false)] {
        let (temp, repo, service) = setup(managed, isolate, false);
        fs::write(temp.path().join("external-edits"), "enabled").unwrap();
        fs::write(repo.join("base.txt"), "before dispatch").unwrap();
        fs::write(repo.join("removed.txt"), "remove during execution").unwrap();
        drive(service.clone());
        let mut index = Vec::new();
        for node in ["root", "join"] {
            let deadline = Instant::now() + Duration::from_secs(120);
            while !temp.path().join(format!("active-{node}")).exists() {
                assert!(Instant::now() < deadline && service.driving.load(Ordering::SeqCst),
                    "source writer did not start: {:?}", service.runtime.lock().unwrap().state.nodes);
                thread::sleep(Duration::from_millis(20));
            }
            fs::write(repo.join("base.txt"), format!("during {node}")).unwrap();
            fs::write(repo.join("external.txt"), format!("external {node}")).unwrap();
            if node == "root" {
                fs::remove_file(repo.join("removed.txt")).unwrap();
            }
            crate::workspace::git(&repo, &["add", "base.txt"]).unwrap();
            index = fs::read(repo.join(".git/index")).unwrap();
            fs::write(temp.path().join(format!("release-{node}")), "continue").unwrap();
        }
        let state = wait_for_idle(&service);
        assert_eq!(state.phase, "completed", "{:?}", state.nodes);
        assert!(state.executions.iter().all(|execution| execution.status == "completed"));
        for node in ["root", "join"] {
            let execution = state.executions.iter().find(|execution| execution.node == node).unwrap();
            assert!(crate::path_identity::same_path(Path::new(&execution.worktree), &repo));
            assert_eq!(execution.after.as_deref(), Some(""));
            assert!(execution.input.is_none() && execution.result.is_none());
        }
        assert_eq!(fs::read_to_string(repo.join("base.txt")).unwrap(), "during join");
        assert_eq!(fs::read_to_string(repo.join("external.txt")).unwrap(), "external join");
        assert!(!repo.join("removed.txt").exists());
        assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    }
}

#[test]
fn driver_dispatches_ready_child_before_unrelated_shared_worker_finishes() {
    let (temp, repo, service) = setup(false, true, false);
    fs::write(temp.path().join("hold-b"), "hold").unwrap();
    {
        let mut runtime = service.runtime.lock().unwrap();
        let mut graph = runtime.state.graph.clone();
        graph.edges = [("root", "a"), ("root", "b"), ("a", "c"), ("b", "join"), ("c", "join")]
            .into_iter()
            .map(|(from, to)| Edge { from: from.into(), to: to.into(), feedback: false })
            .collect();
        runtime.revise_graph(graph, PlanningSummary::default()).unwrap();
    }
    drive(service.clone());
    let deadline = Instant::now() + Duration::from_secs(30);
    while !(temp.path().join("audit-c.json").exists() && temp.path().join("active-b").exists())
        && Instant::now() < deadline && service.driving.load(Ordering::SeqCst)
    {
        thread::sleep(Duration::from_millis(20));
    }
    let during = service.runtime.lock().unwrap().state.clone();
    let child_ran = temp.path().join("audit-c.json").exists();
    // Release even on a regression so no fixture worker survives the assertion.
    fs::write(temp.path().join("release-b"), "release").unwrap();
    let completed = wait_for_idle(&service);
    assert!(child_ran, "ready child stalled behind b: {:?}", during.nodes);
    assert_eq!(during.nodes["b"].status, "running");
    assert_eq!(during.nodes["join"].status, "waiting");
    assert_eq!(completed.phase, "completed", "{:?}", completed.nodes);
    assert_eq!(completed.executions.len(), 5);
    assert!(completed.executions.iter().all(|execution|
        execution.status == "completed" && crate::path_identity::same_path(Path::new(&execution.worktree), &repo)));
    assert!(!completed.events.iter().any(|event|
        matches!(event.kind, EventKind::PublicationStarted { .. })));
}

#[test]
fn driver_drains_active_workers_before_reporting_invalid_source_binding() {
    let (temp, repo, service) = setup(false, true, false);
    fs::write(temp.path().join("hold-b"), "hold").unwrap();
    {
        let mut runtime = service.runtime.lock().unwrap();
        let mut graph = runtime.state.graph.clone();
        graph.edges.retain(|edge|
            !(edge.from == "root" && edge.to == "c" || edge.from == "a" && edge.to == "join"));
        graph.edges.push(Edge { from: "a".into(), to: "c".into(), feedback: false });
        runtime.revise_graph(graph, PlanningSummary::default()).unwrap();
    }
    drive(service.clone());
    let deadline = Instant::now() + Duration::from_secs(30);
    while !temp.path().join("active-b").exists() && Instant::now() < deadline
        && service.driving.load(Ordering::SeqCst)
    {
        thread::sleep(Duration::from_millis(20));
    }
    let active = temp.path().join("active-b").exists();
    if active {
        // Simulate binding loss without renaming a live process's cwd (which
        // Windows forbids). Already-dispatched jobs keep their original cwd.
        service.runtime.lock().unwrap().state.config.as_mut().unwrap().repository =
            temp.path().join("missing-source").to_string_lossy().into_owned();
        drive(service.clone());
    }
    fs::write(temp.path().join("release-b"), "release").unwrap();
    let paused = wait_for_idle(&service);
    assert!(active, "shared fixture never started: {:?}", paused.nodes);
    assert!(paused.paused);
    assert!(paused.executions.iter().all(|execution|
        execution.status == "completed" && execution.output_bytes > 0),
        "admission failure must retain worker completion and logs: {:?}", paused.nodes);
    assert_eq!(paused.nodes["b"].status, "completed");
    assert!(temp.path().join("audit-b.json").exists());
    assert_eq!(paused.nodes["join"].status, "waiting");
    {
        let mut runtime = service.runtime.lock().unwrap();
        runtime.state.config.as_mut().unwrap().repository = repo.to_string_lossy().into_owned();
        runtime.resume_scheduling().unwrap();
    }
    drive(service.clone());
    let completed = wait_for_idle(&service);
    assert_eq!(completed.phase, "completed", "{:?}", completed.nodes);
    assert_eq!(completed.executions.len(), 5, "repair never reruns completed workers");
}

#[test]
fn driver_resumes_paused_private_node_without_recovery_publication() {
    assert_driver_resumes_private_node(true);
}

#[test]
fn driver_resumes_stopped_private_node_after_siblings_publish() {
    assert_driver_resumes_private_node(false);
}

fn assert_driver_resumes_private_node(pause_run: bool) {
    for managed in [false, true] {
        let (temp, repo, service) = setup(managed, true, true);
        fs::write(temp.path().join("hold-a"), "hold").unwrap();
        drive(service.clone());
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let state = service.runtime.lock().unwrap().state.clone();
            if temp.path().join("active-a").exists()
                && ["b", "c"].iter().all(|node| state.nodes[*node].status == "completed") {
                break;
            }
            assert!(Instant::now() < deadline && service.driving.load(Ordering::SeqCst),
                "private workers did not reach pause boundary: {:?}", state.nodes);
            thread::sleep(Duration::from_millis(20));
        }
        {
            let mut runtime = service.runtime.lock().unwrap();
            if pause_run {
                runtime.pause(true).unwrap();
            }
            stop_node_executions(&mut runtime, Some("a")).unwrap();
        }
        let paused = wait_for_idle(&service);
        let original = paused.executions.iter().find(|e| e.node == "a").unwrap();
        assert!(paused.execution_stop_requests.contains(&original.id));
        assert_eq!(original.status, "failed");
        assert!(paused.publication.is_none());
        assert_eq!(paused.paused, pause_run);
        for name in ["b.txt", "c.txt"] {
            assert_eq!(repo.join(name).exists(), !pause_run, "a node stop must let sibling results publish");
        }
        assert!(!repo.join("partial-a.txt").exists());
        fs::write(repo.join("external.txt"), "edited while paused").unwrap();
        fs::remove_file(temp.path().join("fail-a")).unwrap();
        {
            let mut runtime = service.runtime.lock().unwrap();
            if pause_run {
                runtime.pause(false).unwrap();
            } else {
                runtime.resume_node("a").unwrap();
            }
        }
        drive(service.clone());
        let completed = wait_for_idle(&service);
        assert_eq!(completed.phase, "completed", "{:?} {:?}", completed.nodes, completed.publication);
        let resumed = completed.executions.last().unwrap();
        assert_eq!(resumed.node, "a");
        assert_eq!(resumed.worktree, original.worktree);
        assert_eq!(resumed.session_id, original.session_id);
        assert_eq!(resumed.attempt, original.attempt);
        assert_eq!(fs::read_to_string(repo.join("partial-a.txt")).unwrap(), "recovered");
        assert_eq!(fs::read_to_string(repo.join("external.txt")).unwrap(), "edited while paused");
        assert_eq!(completed.events.iter().filter(|event| matches!(event.kind, EventKind::SourceSnapshotted { .. })).count(),
            paused.events.iter().filter(|event| matches!(event.kind, EventKind::SourceSnapshotted { .. })).count(),
            "resuming the private batch must not refresh its source baseline");
        let audit: serde_json::Value = serde_json::from_slice(
            &fs::read(temp.path().join("audit-a.json")).unwrap(),
        ).unwrap();
        assert_eq!(audit["continuation"], true);
        assert_eq!(audit["managed"], managed);
        assert_eq!(audit["externalFilePresent"], false, "the resumed agent must keep its original project view");
        assert!(!completed.events.iter().any(|event| matches!(event.kind, EventKind::BatchRecoveryCaptured { .. })));
        assert_eq!(completed.executions.len(), 4, "resume must succeed without another failed attempt");
        assert_eq!(completed.events.iter().filter(|event| matches!(event.kind, EventKind::PublicationCompleted { .. })).count(),
            if pause_run { 1 } else { 2 }, "only finished results should be published");
    }
}

#[test]
fn driver_retries_private_failure_in_source_with_its_partial_files_and_own_session() {
    for managed in [false, true] {
        let (temp, repo, service) = setup(managed, true, true);
        drive(service.clone());
        let failed = wait_for_idle(&service);
        assert_eq!(failed.phase, "needs_attention", "{:?}", failed.nodes);
        let original = failed
            .executions
            .iter()
            .find(|execution| execution.node == "a")
            .unwrap();
        assert!(!repo.join("partial-a.txt").exists());
        assert!(Path::new(&original.worktree)
            .join("partial-a.txt")
            .is_file());
        fs::remove_file(temp.path().join("fail-a")).unwrap();
        service.runtime.lock().unwrap().resume_node("a").unwrap();
        drive(service.clone());
        let completed = wait_for_idle(&service);
        assert_eq!(
            completed.phase, "completed",
            "{:?} {:?}",
            completed.nodes, completed.publication
        );
        assert_eq!(
            fs::read_to_string(repo.join("partial-a.txt")).unwrap(),
            "recovered"
        );
        let retry = completed.executions.last().unwrap();
        assert_eq!(retry.node, "a");
        assert_ne!(retry.session_id, original.session_id);
        assert!(crate::path_identity::same_path(
            Path::new(&retry.worktree),
            &repo
        ));
        assert_eq!(completed.executions[0].status, "failed");
        let audit: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.path().join("audit-a.json")).unwrap()).unwrap();
        assert_eq!(audit["managed"], false);
        assert_eq!(audit["continuation"], true);
        assert_eq!(
            completed
                .events
                .iter()
                .filter(|event| matches!(event.kind, EventKind::BatchRecoveryCaptured { .. }))
                .count(),
            1
        );
    }
}
