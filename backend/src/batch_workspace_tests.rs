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
import { execFileSync } from 'node:child_process';
const managed = !!process.env.GRAPHER_LAUNCH_BINDING;
applyLaunchBinding();
const control = path.dirname(fileURLToPath(import.meta.url));
let task = ''; for await (const chunk of process.stdin) task += chunk;
if (task.trim() === 'Resolve the current merge conflicts.') {
  fs.writeFileSync(path.join(control, 'active-merger'), 'ready');
  const deadline = Date.now() + 120_000;
  while (!fs.existsSync(path.join(control, 'release-merger'))) {
    if (Date.now() > deadline) throw Error('publication test timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (fs.existsSync(path.join(control, 'fail-merger'))) throw Error('deliberate publication failure');
  fs.writeFileSync('base.txt', 'merged siblings');
  execFileSync('git', ['add', '-f', '--', 'base.txt']);
  console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'merged'}]}}));
  process.exit(0);
}
const continuation = task.trim() === '__grapher_continue_interrupted__';
const followup = task.trim() === 'finish a';
const resumedNode = fs.existsSync(path.join(control, 'recover-b')) ? 'b' : 'a';
const name = continuation ? resumedNode : followup ? 'a' : task.trim();
const arg = key => process.argv[process.argv.indexOf(key)+1];
const sessionDir = arg('--session-dir'), id = arg('--session-id');
fs.mkdirSync(sessionDir, {recursive:true});
let session = fs.readdirSync(sessionDir).find(file => file.endsWith(`_${id}.jsonl`));
if (!session) {
  session = `fixture_${id}.jsonl`;
  fs.writeFileSync(path.join(sessionDir, session), JSON.stringify({type:'session',version:3,id,cwd:process.cwd(),timestamp:new Date().toISOString()})+'\n');
}
const sessionFile = path.join(sessionDir, session);
if (continuation || followup) {
  const history = fs.readFileSync(sessionFile, 'utf8');
  if (!history.includes(`"text":"${name}"`)) throw Error('lost the failed node conversation');
  if (JSON.parse(history.split('\n')[0]).cwd !== process.cwd()) throw Error('fork did not rebind cwd');
  if (fs.readFileSync(`partial-${name}.txt`,'utf8') !== 'unfinished work') throw Error('partial work disappeared');
  fs.writeFileSync(`partial-${name}.txt`,'recovered');
}
if (!continuation) {
  fs.appendFileSync(sessionFile, JSON.stringify({type:'message',id:crypto.randomUUID(),parentId:null,timestamp:new Date().toISOString(),message:{role:'user',content:[{type:'text',text:task.trim()}],timestamp:Date.now()}})+'\n');
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
if (['b', 'e'].includes(name) && fs.existsSync(path.join(control, `hold-${name}`))) {
  fs.writeFileSync(path.join(control, `active-${name}`), 'ready');
  const deadline = Date.now() + 120_000;
  while (!fs.existsSync(path.join(control, `release-${name}`))) {
    if (Date.now() > deadline) throw Error('shared replenishment test timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
if (name === 'a' && fs.existsSync(path.join(control, 'hold-source-a'))) {
  fs.writeFileSync(path.join(control, 'active-source-a'), 'ready');
  const deadline = Date.now() + 120_000;
  while (!fs.existsSync(path.join(control, 'release-source-a'))) {
    if (Date.now() > deadline) throw Error('source prerequisite test timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
if (name === 'b' && fs.existsSync(path.join(control, 'fail-b'))) {
  fs.writeFileSync('partial-b.txt', 'unfinished work');
  throw Error('source prerequisite failed');
}
if (name === 'b1' && fs.readFileSync('partial-b.txt', 'utf8') !== 'recovered') throw Error('private consumer missed source recovery');
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
  for (const node of ['a','b','c','d']) if (fs.readFileSync(`${node}.txt`, 'utf8') !== node) throw Error(`missing ${node} before shared join`);
}
if (['a','b','c','d'].includes(name) && fs.existsSync(path.join(control, 'chain')) && fs.readFileSync('root.txt','utf8') !== 'root') throw Error('private batch missed shared input');
if (['b', 'c'].includes(name) && fs.existsSync(path.join(control, 'conflict-bc'))) fs.writeFileSync('base.txt', name);
fs.writeFileSync(`${name}.txt`, name);
fs.writeFileSync(path.join(control, `audit-${name}.json`), JSON.stringify({cwd:process.cwd(), managed, continuation, followup, externalFilePresent:fs.existsSync('external.txt')}));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}}));
"#).unwrap();
    let names = if fail {
        vec!["a", "b", "c", "d"]
    } else {
        vec!["root", "a", "b", "c", "d", "join"]
    };
    let edges = if fail {
        vec![]
    } else {
        vec![
            ("root", "a"),
            ("root", "b"),
            ("root", "c"),
            ("root", "d"),
            ("a", "join"),
            ("b", "join"),
            ("c", "join"),
            ("d", "join"),
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
        assert_eq!(state.executions.len(), 6);
        assert_eq!(state.isolated_workspaces, Some(false));
        for name in ["root", "a", "b", "c", "d", "join"] {
            let audit: serde_json::Value = serde_json::from_slice(
                &fs::read(temp.path().join(format!("audit-{name}.json"))).unwrap(),
            )
            .unwrap();
            let private = isolate && ["a", "b", "c", "d"].contains(&name);
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
        graph.edges = [("root", "a"), ("root", "b"), ("root", "d"), ("a", "c"), ("b", "join"), ("c", "join"), ("d", "join")]
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
    assert_eq!(completed.executions.len(), 6);
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
    assert_eq!(completed.executions.len(), 6, "repair never reruns completed workers");
}

#[test]
fn driver_resumes_paused_private_node_without_recovery_publication() {
    assert_driver_resumes_private_node(true, false);
}

#[test]
fn driver_resumes_stopped_private_node_before_siblings_publish() {
    assert_driver_resumes_private_node(false, false);
}

#[test]
fn driver_follows_up_stopped_private_node_without_recovery_publication() {
    for pause_run in [false, true] {
        assert_driver_resumes_private_node(pause_run, true);
    }
}

fn assert_driver_resumes_private_node(pause_run: bool, followup: bool) {
    for managed in [false, true] {
        let (temp, repo, service) = setup(managed, true, true);
        fs::write(temp.path().join("hold-a"), "hold").unwrap();
        drive(service.clone());
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let state = service.runtime.lock().unwrap().state.clone();
            if temp.path().join("active-a").exists()
                && ["b", "c", "d"].iter().all(|node| state.nodes[*node].status == "completed") {
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
        assert!(paused.batch_handoff.is_none());
        if !pause_run {
            assert_eq!(paused.phase, "needs_attention");
            assert!(paused.can_resume_node("a"));
        }
        for name in ["b.txt", "c.txt"] {
            assert!(!repo.join(name).exists(), "a node stop must not trigger sibling publication");
        }
        assert!(!repo.join("partial-a.txt").exists());
        fs::write(repo.join("external.txt"), "edited while paused").unwrap();
        fs::remove_file(temp.path().join("fail-a")).unwrap();
        {
            let mut runtime = service.runtime.lock().unwrap();
            if followup {
                runtime.intervene("a", "finish a").unwrap();
                runtime.resume_after_intervention().unwrap();
            } else if pause_run {
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
        assert_eq!(resumed.attempt, original.attempt + usize::from(followup));
        assert_eq!(fs::read_to_string(repo.join("partial-a.txt")).unwrap(), "recovered");
        assert_eq!(fs::read_to_string(repo.join("external.txt")).unwrap(), "edited while paused");
        assert_eq!(completed.events.iter().filter(|event| matches!(event.kind, EventKind::SourceSnapshotted { .. })).count(),
            paused.events.iter().filter(|event| matches!(event.kind, EventKind::SourceSnapshotted { .. })).count(),
            "resuming the private batch must not refresh its source baseline");
        let audit: serde_json::Value = serde_json::from_slice(
            &fs::read(temp.path().join("audit-a.json")).unwrap(),
        ).unwrap();
        assert_eq!(audit["continuation"], !followup);
        assert_eq!(audit["followup"], followup);
        assert_eq!(audit["managed"], managed);
        assert_eq!(audit["externalFilePresent"], false, "the resumed agent must keep its original project view");
        assert!(!completed.events.iter().any(|event| matches!(event.kind, EventKind::BatchRecoveryCaptured { .. })));
        assert_eq!(completed.executions.len(), 5, "resume must succeed without another failed attempt");
        assert_eq!(completed.events.iter().filter(|event| matches!(event.kind, EventKind::PublicationCompleted { .. })).count(),
            1, "publish the batch only after the stopped task finishes");
    }
}

#[test]
fn driver_runs_private_followup_while_sibling_publication_merger_is_still_working() {
    for fail_publication in [false, true] {
        assert_private_followup_during_publication(fail_publication);
    }
}

fn assert_private_followup_during_publication(fail_publication: bool) {
    let (temp, repo, service) = setup(false, true, true);
    if fail_publication {
        fs::write(temp.path().join("fail-merger"), "fail").unwrap();
    }
    fs::write(temp.path().join("hold-a"), "hold").unwrap();
    fs::write(temp.path().join("conflict-bc"), "conflict").unwrap();
    drive(service.clone());
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let state = service.runtime.lock().unwrap().state.clone();
        if temp.path().join("active-a").exists()
            && ["b", "c", "d"].iter().all(|node| state.nodes[*node].status == "completed") { break; }
        assert!(Instant::now() < deadline, "workers never became ready: {:?}", state.nodes);
        thread::sleep(Duration::from_millis(20));
    }
    {
        let mut runtime = service.runtime.lock().unwrap();
        stop_node_executions(&mut runtime, Some("a")).unwrap();
    }
    let paused = wait_for_idle(&service);
    let original = paused.executions.iter().find(|e| e.node == "a").unwrap();
    {
        let mut runtime = service.runtime.lock().unwrap();
        // Existing Runs may already have entered this handoff before the fix.
        let heads = runtime.state.executions.iter().filter_map(|e| e.after.clone()).collect();
        runtime.emit_outputs(vec![
            EventKind::BatchHandoffRequested { recovery_execution_ids: vec![] },
            EventKind::PublicationStarted { repository: repo.to_string_lossy().into(), heads },
        ]).unwrap();
    }
    drive(service.clone());
    let deadline = Instant::now() + Duration::from_secs(120);
    while !temp.path().join("active-merger").exists() {
        assert!(Instant::now() < deadline && service.driving.load(Ordering::SeqCst), "publication did not reach merger");
        thread::sleep(Duration::from_millis(20));
    }
    fs::remove_file(temp.path().join("fail-a")).unwrap();
    let before = service.runtime.lock().unwrap().state.publication.clone().unwrap();
    control("intervene".into(), Some("a".into()), Some("finish a".into()),
        Some(paused.run_id.clone()), None, None, &service).unwrap();
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let state = service.runtime.lock().unwrap().state.clone();
        if state.nodes["a"].status == "completed" { break; }
        assert!(Instant::now() < deadline && service.driving.load(Ordering::SeqCst),
            "private follow-up was blocked by unrelated publication: {:?}", state.nodes);
        thread::sleep(Duration::from_millis(20));
    }
    {
        let runtime = service.runtime.lock().unwrap();
        assert_eq!(runtime.state.phase, "merging");
        assert_eq!(runtime.state.publication.as_ref().unwrap().heads, before.heads);
        let resumed = runtime.state.executions.last().unwrap();
        assert_eq!(resumed.worktree, original.worktree);
        assert_eq!(resumed.session_id, original.session_id);
        assert!(runtime.state.mergers.iter().any(|e| e.status == "running"));
        assert!(!repo.join("partial-a.txt").exists());
    }
    fs::write(temp.path().join("release-merger"), "release").unwrap();
    let mut completed = wait_for_idle(&service);
    if fail_publication {
        assert_eq!(completed.phase, "publication_failed");
        assert_eq!(completed.nodes["a"].status, "completed", "publication failure cannot discard the independent result");
        assert!(Path::new(&original.worktree).is_dir());
        let runtime = service.runtime.lock().unwrap();
        let replayed = runtime.store.load(&completed.run_id).unwrap();
        assert_eq!(replayed.phase, "publication_failed");
        assert_eq!(replayed.nodes["a"].head, completed.nodes["a"].head);
        drop(runtime);
        fs::remove_file(temp.path().join("fail-merger")).unwrap();
        control("retry_publication".into(), None, None, Some(completed.run_id.clone()), None, None, &service).unwrap();
        completed = wait_for_idle(&service);
    }
    assert_eq!(completed.phase, "completed", "{:?}", completed.publication);
    assert_eq!(completed.executions.len(), 5, "publication retry must not rerun the independent node");
    assert_eq!(fs::read_to_string(repo.join("partial-a.txt")).unwrap(), "recovered");
    assert_eq!(fs::read_to_string(repo.join("base.txt")).unwrap(), "merged siblings");
    assert_eq!(completed.events.iter().filter(|e| matches!(e.kind, EventKind::PublicationCompleted { .. })).count(), 2);
}

#[test]
fn driver_retries_private_node_before_its_independent_sibling_finishes() {
    let (temp, repo, service) = setup(false, true, true);
    fs::write(temp.path().join("hold-b"), "hold").unwrap();
    drive(service.clone());
    let deadline = Instant::now() + Duration::from_secs(120);
    let checks = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        loop {
            let state = service.runtime.lock().unwrap().state.clone();
            if state.nodes["a"].status == "failed" && state.nodes["c"].status == "completed"
                && temp.path().join("active-b").exists() { break; }
            assert!(Instant::now() < deadline, "initial private workers did not settle");
            thread::sleep(Duration::from_millis(20));
        }
        fs::remove_file(temp.path().join("fail-a")).unwrap();
        let run_id = service.runtime.lock().unwrap().state.run_id.clone();
        control("resume_node".into(), Some("a".into()), None, Some(run_id), None, None, &service).unwrap();
        loop {
            let state = service.runtime.lock().unwrap().state.clone();
            if state.nodes["a"].status == "completed" {
                assert_eq!(state.nodes["b"].status, "running");
                assert!(state.publication.is_none());
                assert!(!repo.join("partial-a.txt").exists());
                break;
            }
            assert!(Instant::now() < deadline, "private retry waited for an unrelated writer");
            thread::sleep(Duration::from_millis(20));
        }
    }));
    fs::write(temp.path().join("release-b"), "release").unwrap();
    let completed = wait_for_idle(&service);
    if let Err(error) = checks { std::panic::resume_unwind(error); }
    assert_eq!(completed.phase, "completed", "{:?}", completed.nodes);
    assert_eq!(completed.events.iter().filter(|e| matches!(e.kind, EventKind::PublicationCompleted { .. })).count(), 1);
}

#[test]
fn driver_publishes_the_whole_visible_private_batch_not_each_worker_group() {
    let (temp, repo, service) = setup(false, true, true);
    fs::remove_file(temp.path().join("fail-a")).unwrap();
    fs::write(temp.path().join("hold-e"), "hold").unwrap();
    {
        let mut runtime = service.runtime.lock().unwrap();
        let mut config = runtime.state.config.clone().unwrap();
        config.max_parallel = 4;
        let graph = Graph {
            original_goal: "whole private batch".into(),
            nodes: ["a", "b", "c", "d", "e", "child"].into_iter()
                .map(|name| Node { name: name.into(), task: name.into() }).collect(),
            edges: vec![crate::model::Edge { from: "a".into(), to: "child".into(), feedback: false }],
        };
        runtime.create(graph, config).unwrap();
        runtime.set_route("graph").unwrap();
        runtime.approve().unwrap();
    }
    drive(service.clone());
    let deadline = Instant::now() + Duration::from_secs(120);
    let checks = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        loop {
            let state = service.runtime.lock().unwrap().state.clone();
            if temp.path().join("active-e").exists() && state.nodes["d"].status == "completed" {
                assert_eq!(state.private_batch, state.plan.as_ref().unwrap().execution_batches[0]);
                assert_eq!(state.nodes["child"].status, "waiting");
                assert!(state.publication.is_none());
                for name in ["a", "b", "c", "d"] { assert!(!repo.join(format!("{name}.txt")).exists()); }
                break;
            }
            assert!(Instant::now() < deadline, "the capped private batch did not refill");
            thread::sleep(Duration::from_millis(20));
        }
    }));
    fs::write(temp.path().join("release-e"), "release").unwrap();
    let completed = wait_for_idle(&service);
    if let Err(error) = checks { std::panic::resume_unwind(error); }
    assert_eq!(completed.phase, "completed", "{:?}", completed.nodes);
    assert_eq!(completed.events.iter().filter(|e| matches!(e.kind, EventKind::PublicationCompleted { .. })).count(), 1);
    for name in ["a", "b", "c", "d", "e", "child"] { assert!(repo.join(format!("{name}.txt")).exists()); }
}

#[test]
fn driver_recovers_source_prerequisite_without_publishing_or_relocating_the_held_private_batch() {
    for managed in [false, true] {
        let (temp, repo, service) = setup(managed, true, true);
        fs::remove_file(temp.path().join("fail-a")).unwrap();
        fs::write(temp.path().join("fail-b"), "fail").unwrap();
        fs::write(temp.path().join("hold-source-a"), "hold").unwrap();
        {
            let mut runtime = service.runtime.lock().unwrap();
            let mut config = runtime.state.config.clone().unwrap();
            config.max_parallel = 4;
            runtime.create(Graph {
                original_goal: "source prerequisite recovery".into(),
                nodes: ["a", "b", "a1", "a2", "a3", "a4", "b1"].into_iter()
                    .map(|name| Node { name: name.into(), task: name.into() }).collect(),
                edges: [("a", "a1"), ("a", "a2"), ("a", "a3"), ("a", "a4"), ("b", "b1")].into_iter()
                    .map(|(from, to)| crate::model::Edge { from: from.into(), to: to.into(), feedback: false }).collect(),
            }, config).unwrap();
            runtime.set_route("graph").unwrap();
            runtime.approve().unwrap();
        }
        drive(service.clone());
        let deadline = Instant::now() + Duration::from_secs(120);
        let ready = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            loop {
                let state = service.runtime.lock().unwrap().state.clone();
                if state.nodes["b"].status == "failed" && temp.path().join("active-source-a").exists() { break; }
                assert!(Instant::now() < deadline, "source failure was not recorded");
                thread::sleep(Duration::from_millis(20));
            }
        }));
        fs::write(temp.path().join("release-source-a"), "release").unwrap();
        let held = wait_for_idle(&service);
        if let Err(error) = ready { std::panic::resume_unwind(error); }
        assert_eq!(held.phase, "needs_attention", "{:?}", held.nodes);
        assert_eq!(held.nodes["a1"].status, "completed");
        assert_eq!(held.nodes["b1"].status, "blocked");
        assert!(held.publication.is_none() && !repo.join("a1.txt").exists());
        let original = held.executions.iter().find(|e| e.node == "b").unwrap();
        fs::remove_file(temp.path().join("fail-b")).unwrap();
        fs::write(temp.path().join("recover-b"), "b").unwrap();
        control("resume_node".into(), Some("b".into()), None, Some(held.run_id.clone()), None, None, &service).unwrap();
        let completed = wait_for_idle(&service);
        assert_eq!(completed.phase, "completed", "{:?} {:?}", completed.nodes, completed.publication);
        let retry = completed.executions.iter().rev().find(|e| e.node == "b").unwrap();
        assert_eq!(retry.worktree, original.worktree);
        assert_eq!(retry.session_id, original.session_id);
        assert_eq!(completed.executions.len(), 8);
        assert_eq!(completed.events.iter().filter(|e| matches!(e.kind, EventKind::PublicationCompleted { .. })).count(), 1);
        let audit: serde_json::Value = serde_json::from_slice(&fs::read(temp.path().join("audit-b.json")).unwrap()).unwrap();
        assert_eq!(audit["managed"], false, "source recovery must not load the held private environment");
        let audit: serde_json::Value = serde_json::from_slice(&fs::read(temp.path().join("audit-b1.json")).unwrap()).unwrap();
        assert_eq!(audit["managed"], managed);
        assert_eq!(fs::read_to_string(repo.join("partial-b.txt")).unwrap(), "recovered");
        assert!(repo.join("a1.txt").exists() && repo.join("b1.txt").exists());
    }
}

#[test]
fn driver_retries_private_failure_in_place_and_delivers_the_complete_batch() {
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
        assert!(failed.publication.is_none() && failed.batch_handoff.is_none());
        for file in ["partial-a.txt", "b.txt", "c.txt"] {
            assert!(!repo.join(file).exists(), "failed batch must not deliver even its successful siblings");
        }
        assert!(Path::new(&original.worktree).join("partial-a.txt").is_file());
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
        assert_eq!(retry.session_id, original.session_id);
        assert_eq!(retry.worktree, original.worktree);
        assert_eq!(retry.attempt, original.attempt + 1);
        assert_eq!(completed.executions.len(), 5, "completed siblings must not rerun");
        assert_eq!(completed.events.iter().filter(|event|
            matches!(event.kind, EventKind::PublicationCompleted { .. })).count(), 1);
        assert_eq!(completed.executions[0].status, "failed");
        let audit: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.path().join("audit-a.json")).unwrap()).unwrap();
        assert_eq!(audit["managed"], managed);
        assert_eq!(audit["continuation"], true);
        assert_eq!(
            completed
                .events
                .iter()
                .filter(|event| matches!(event.kind, EventKind::BatchRecoveryCaptured { .. }))
                .count(),
            0
        );
    }
}
