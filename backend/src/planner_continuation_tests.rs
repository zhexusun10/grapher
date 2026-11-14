use super::*;

fn service(root: &std::path::Path) -> Arc<Service> {
    Arc::new(Service {
        runtime: Mutex::new(Runtime::open(root).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: root.join("unused.ts"),
    })
}

#[test]
fn private_planner_continuation_cannot_bypass_a_later_shared_batch() {
    let temp = tempfile::tempdir().unwrap();
    let repository = crate::fixture::repository(temp.path()).unwrap();
    let script = temp.path().join("planner.mjs");
    fs::write(&script, r#"
import fs from 'node:fs'; import path from 'node:path';
let input=''; for await (const chunk of process.stdin) input += chunk;
const arg = name => process.argv[process.argv.indexOf(name)+1];
const dir=arg('--session-dir'), id=arg('--session-id');
if (process.env.GRAPHER_CONTINUE_INTERRUPTED !== 'true') {
  fs.writeFileSync(path.join(dir, `test_${id}.jsonl`), JSON.stringify({type:'session',id,cwd:process.cwd()})+'\n'+
    JSON.stringify({type:'message',id:'request',parentId:null,message:{role:'user',content:'retained turn'}})+'\n');
  process.exit(1);
}
fs.writeFileSync('continued-in-private.txt', 'must not execute in the previous batch');
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}}));
"#).unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository":repository, "piCommand":"node", "piArgs":[script],
        "model":"mock/model", "postTaskReview":false, "maxParallel":4
    })).unwrap();
    let current = service(&temp.path().join("runtime"));
    current.driving.store(true, Ordering::SeqCst);
    let run_id = {
        let mut runtime = current.runtime.lock().unwrap();
        runtime.create(Graph {
            original_goal:"batch handoff".into(),
            nodes:["a","b","c","d","join"].into_iter().map(|name| Node { name:name.into(), task:name.into() }).collect(),
            edges:["a","b","c","d"].into_iter().map(|name| Edge { from:name.into(), to:"join".into(), feedback:false }).collect(),
        }, config.clone()).unwrap();
        runtime.set_route("graph").unwrap();
        runtime.approve().unwrap();
        let root = runtime.root.clone();
        for mut job in runtime.jobs().unwrap() {
            runtime.attach_job_source(&mut job, &[]).unwrap();
            let error = perform_with_merger(&job, &root, &[], |_| {}, |head| {
                runtime.emit(EventKind::Prepared { execution_id:job.execution.id.clone(), head })?;
                Err("prepared only".into())
            }, |_| Err("unexpected merger".into())).unwrap_err();
            assert_eq!(error, "prepared only");
            let head = crate::workspace::git(std::path::Path::new(&job.execution.worktree), &["rev-parse", "HEAD"]).unwrap();
            runtime.finish(&job.execution, Ok((head, "done".into()))).unwrap();
        }
        runtime.state.run_id.clone()
    };
    let failed = plan_goal_internal("revise".into(), config.clone(), Some("graph"), None,
        Some(run_id.clone()), &current, |_| {}, |_| {}, |_| {}).unwrap_err().1.unwrap();
    let private = PathBuf::from(failed.worktree.as_ref().unwrap());
    assert!(!crate::path_identity::same_path(&private, &repository));
    {
        let mut runtime = current.runtime.lock().unwrap();
        assert!(runtime.jobs().unwrap().is_empty());
        let publication = runtime.state.publication.clone().unwrap();
        let head = crate::graph_merge::merge_graph_scoped(&repository, &publication.heads,
            &runtime.exclusions().unwrap(), |_| Err("unexpected merger".into())).unwrap();
        runtime.emit(EventKind::PublicationCompleted { head }).unwrap();
        let join = runtime.jobs().unwrap().remove(0);
        assert!(join.source_direct);
        runtime.finish(&join.execution, Ok((String::new(), "done".into()))).unwrap();
        runtime.jobs().unwrap();
        assert!(runtime.shared_source_workspace());
    }
    let mut started = false;
    let result = plan_goal_internal_with_options("revise".into(), config, Some("graph"), None,
        Some(run_id), &current, false, Some(&failed.planning_id),
        |_| { started = true; }, |_| {}, |_| {}, |_| {});
    let error = result.unwrap_err().0;
    assert!(error.contains("workspace policy"), "{error}");
    assert!(!started, "reject before recording or launching a replacement turn");
    assert!(!private.join("continued-in-private.txt").exists());
    assert_eq!(current.runtime.lock().unwrap().state.planning.as_ref().unwrap().planning_id, failed.planning_id);
}

#[test]
fn approved_graph_revision_continues_its_failed_draft_without_replacing_the_run() {
    let temp = tempfile::tempdir().unwrap();
    let repository = crate::fixture::repository(temp.path()).unwrap();
    let script = temp.path().join("revision.mjs");
    fs::write(&script, r#"
import fs from 'node:fs'; import path from 'node:path';
let input=''; for await (const chunk of process.stdin) input += chunk;
const arg = name => process.argv[process.argv.indexOf(name)+1];
const dir=arg('--session-dir'), id=arg('--session-id');
const session=path.join(dir, `test_${id}.jsonl`);
const graph=JSON.parse(fs.readFileSync(process.env.GRAPHER_GRAPH_PATH,'utf8'));
if (process.env.GRAPHER_CONTINUE_INTERRUPTED !== 'true') {
  fs.writeFileSync(session, JSON.stringify({type:'session',id,cwd:process.cwd()})+'\n'+
    JSON.stringify({type:'message',id:'revision',parentId:null,message:{role:'user',content:'revision'}})+'\n');
  graph.nodes.push({name:'partial',task:'retained'});
  fs.writeFileSync(process.env.GRAPHER_GRAPH_PATH,JSON.stringify(graph)); process.exit(1);
}
if (input !== '__grapher_continue_interrupted__') throw Error('unexpected prompt');
if (!fs.existsSync(session) || !graph.nodes.some(node => node.name === 'partial')) throw Error('missing history or draft');
graph.nodes.push({name:'finished',task:'done'});
fs.writeFileSync(process.env.GRAPHER_GRAPH_PATH,JSON.stringify(graph));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}}));
"#).unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repository, "engine": "pi", "piCommand": "node", "piArgs": [script],
        "model": "mock/model", "autoApprove": false, "maxParallel": 2
    }))
    .unwrap();
    let root = temp.path().join("runtime");
    let current = service(&root);
    let run_id = {
        let mut runtime = current.runtime.lock().unwrap();
        runtime
            .create(
                Graph {
                    original_goal: "goal".into(),
                    nodes: vec![Node {
                        name: "worker".into(),
                        task: "work".into(),
                    }],
                    edges: vec![],
                },
                config.clone(),
            )
            .unwrap();
        runtime.set_route("graph").unwrap();
        runtime.approve().unwrap();
        runtime.state.run_id.clone()
    };
    // Keep the fake driver from launching real workers after a revision.
    current.driving.store(true, Ordering::SeqCst);
    let failed = plan_goal_internal(
        "revision".into(),
        config.clone(),
        Some("graph"),
        None,
        Some(run_id.clone()),
        &current,
        |_| {},
        |_| {},
        |_| {},
    )
    .unwrap_err()
    .1
    .unwrap();
    assert_eq!(current.runtime.lock().unwrap().state.graph.nodes.len(), 1);
    let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = plan_goal_internal_with_options(
            "revision".into(),
            config.clone(),
            Some("graph"),
            None,
            Some(run_id.clone()),
            &current,
            false,
            Some(&failed.planning_id),
            |_| panic!("simulated crash before revision launch"),
            |_| {},
            |_| {},
            |_| {},
        );
    }));
    assert!(crashed.is_err());
    drop(current);
    let current = service(&root);
    recover_plannings(&current).unwrap();
    current.driving.store(true, Ordering::SeqCst);
    let interrupted = current
        .runtime
        .lock()
        .unwrap()
        .state
        .planning
        .clone()
        .unwrap();
    assert_eq!(interrupted.status.as_deref(), Some("failed"));
    assert_ne!(interrupted.planning_id, failed.planning_id);
    let result = plan_goal_internal_with_options(
        "revision".into(),
        config,
        Some("graph"),
        None,
        Some(run_id.clone()),
        &current,
        false,
        Some(&interrupted.planning_id),
        |_| {},
        |_| {},
        |_| {},
        |_| {},
    )
    .unwrap();
    assert_eq!(result.run_id, run_id);
    assert!(result.approved);
    assert_eq!(
        result
            .graph
            .nodes
            .iter()
            .map(|node| node.name.as_str())
            .collect::<Vec<_>>(),
        vec!["worker", "partial", "finished"]
    );
}

#[test]
fn interrupted_initial_planner_resumes_its_session_and_draft_after_restart() {
    let temp = tempfile::tempdir().unwrap();
    let repository = crate::fixture::repository(temp.path()).unwrap();
    let script = temp.path().join("planner.mjs");
    fs::write(&script, r#"
import fs from 'node:fs';
import path from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const directory = arg('--session-dir'), id = arg('--session-id');
const session = path.join(directory, `test_${id}.jsonl`);
const graph = JSON.parse(fs.readFileSync(process.env.GRAPHER_GRAPH_PATH, 'utf8'));
if (process.env.GRAPHER_CONTINUE_INTERRUPTED !== 'true') {
  if (fs.existsSync(session)) {
    if (input !== 'revision') throw Error(`unexpected revision: ${input}`);
    fs.appendFileSync(session, JSON.stringify({type:'message',id:'revision',parentId:'original',message:{role:'user',content:'revision'}})+'\n');
    graph.nodes.push({name:'revision-partial',task:'retained revision'});
    fs.writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify(graph));
    process.exit(1);
  }
  fs.writeFileSync(session, JSON.stringify({type:'session', id, cwd:process.cwd()})+'\n'+
    JSON.stringify({type:'message',id:'original',parentId:null,message:{role:'user',content:'original goal'}})+'\n');
  graph.nodes.push({name:'before',task:'retained'});
  fs.writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify(graph));
  console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'partial'}]}}));
  process.exit(1);
}
if (input !== '__grapher_continue_interrupted__') throw Error(`unexpected prompt: ${input}`);
if (!fs.readFileSync(session, 'utf8').includes('original goal')) throw Error('missing session history');
if (graph.nodes[0]?.name !== 'before') throw Error('missing retained draft');
const failOnce = path.join(path.dirname(process.argv[1]), 'fail-once');
if (fs.existsSync(failOnce)) {
  fs.unlinkSync(failOnce);
  graph.nodes.push({name:'retry',task:'retained after second failure'});
  fs.writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify(graph));
  process.exit(1);
}
graph.nodes.push({name:graph.nodes.some(node => node.name === 'after') ? 'revision-finished' : 'after',task:'finished'});
fs.writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify(graph));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}}));
"#).unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repository, "engine": "pi", "piCommand": "node", "piArgs": [script],
        "model": "mock/model", "autoApprove": false, "maxParallel": 2
    }))
    .unwrap();
    let root = temp.path().join("runtime");
    let first = service(&root);
    let failed = plan_goal_internal(
        "original goal".into(),
        config.clone(),
        Some("graph"),
        None,
        None,
        &first,
        |_| {},
        |_| {},
        |_| {},
    )
    .unwrap_err()
    .1
    .unwrap();
    let run_id = failed.run_id.clone().unwrap();
    assert_eq!(failed.status.as_deref(), Some("failed"));
    assert_eq!(first.runtime.lock().unwrap().state.run_id, run_id);
    drop(first);

    let resumed = service(&root);
    let before = resumed.runtime.lock().unwrap().state.events.len();
    let stale = plan_goal_internal_with_options(
        "original goal".into(),
        config.clone(),
        Some("graph"),
        None,
        Some(run_id.clone()),
        &resumed,
        false,
        Some(&Uuid::new_v4().to_string()),
        |_| {},
        |_| {},
        |_| {},
        |_| {},
    );
    assert!(stale.is_err());
    assert_eq!(resumed.runtime.lock().unwrap().state.events.len(), before);
    let draft = root
        .join("planning")
        .join(&failed.planning_id)
        .join("planner-session")
        .join(format!("graph-{}.json", failed.planning_id));
    let bytes = fs::read(&draft).unwrap();
    fs::remove_file(&draft).unwrap();
    let missing = plan_goal_internal_with_options(
        "original goal".into(),
        config.clone(),
        Some("graph"),
        None,
        Some(run_id.clone()),
        &resumed,
        false,
        Some(&failed.planning_id),
        |_| {},
        |_| {},
        |_| {},
        |_| {},
    );
    assert!(missing.unwrap_err().0.contains("retained Planner draft"));
    assert_eq!(
        resumed.runtime.lock().unwrap().state.events.len(),
        before,
        "a rejected preflight must not replace the failed turn"
    );
    fs::write(draft, bytes).unwrap();
    let session_file = root
        .join("planning")
        .join(&failed.planning_id)
        .join("planner-session")
        .join(format!("test_{}.jsonl", failed.planning_id));
    let history = fs::read(&session_file).unwrap();
    let mut header = history
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap()
        .to_vec();
    header.push(b'\n');
    fs::write(&session_file, header).unwrap();
    let header_only = plan_goal_internal_with_options(
        "original goal".into(),
        config.clone(),
        Some("graph"),
        None,
        Some(run_id.clone()),
        &resumed,
        false,
        Some(&failed.planning_id),
        |_| {},
        |_| {},
        |_| {},
        |_| {},
    );
    assert!(header_only.is_err());
    assert_eq!(resumed.runtime.lock().unwrap().state.events.len(), before);
    fs::write(&session_file, history).unwrap();
    // Simulate a crash immediately after publishing the new attempt, before Pi
    // launches. The retry's own draft and workspace must already be durable.
    let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = plan_goal_internal_with_options(
            "original goal".into(),
            config.clone(),
            Some("graph"),
            None,
            Some(run_id.clone()),
            &resumed,
            false,
            Some(&failed.planning_id),
            |_| panic!("simulated crash before Planner launch"),
            |_| {},
            |_| {},
            |_| {},
        );
    }));
    assert!(crashed.is_err());
    drop(resumed);
    let resumed = service(&root);
    recover_plannings(&resumed).unwrap();
    let interrupted = resumed
        .runtime
        .lock()
        .unwrap()
        .state
        .planning
        .clone()
        .unwrap();
    assert_eq!(interrupted.status.as_deref(), Some("failed"));
    assert_ne!(interrupted.planning_id, failed.planning_id);
    fs::write(temp.path().join("fail-once"), "").unwrap();
    let failed_again = plan_goal_internal_with_options(
        "original goal".into(),
        config.clone(),
        Some("graph"),
        None,
        Some(run_id.clone()),
        &resumed,
        false,
        Some(&interrupted.planning_id),
        |_| {},
        |_| {},
        |_| {},
        |_| {},
    )
    .unwrap_err()
    .1
    .unwrap();
    assert_ne!(failed_again.planning_id, failed.planning_id);
    assert_eq!(
        resumed.runtime.lock().unwrap().state.phase,
        "planning_failed"
    );
    let result = plan_goal_internal_with_options(
        "original goal".into(),
        config.clone(),
        Some("graph"),
        None,
        Some(run_id.clone()),
        &resumed,
        false,
        Some(&failed_again.planning_id),
        |_| {},
        |_| {},
        |_| {},
        |_| {},
    )
    .unwrap();
    assert_eq!(result.run_id, run_id);
    assert_eq!(
        result
            .graph
            .nodes
            .iter()
            .map(|node| node.name.as_str())
            .collect::<Vec<_>>(),
        vec!["before", "retry", "after"]
    );
    assert!(!result.approved);
    assert_eq!(result.phase, "awaiting_approval");
    let failed_revision = plan_goal_internal(
        "revision".into(),
        config.clone(),
        Some("graph"),
        None,
        Some(run_id.clone()),
        &resumed,
        |_| {},
        |_| {},
        |_| {},
    )
    .unwrap_err()
    .1
    .unwrap();
    assert_eq!(
        resumed.runtime.lock().unwrap().state.graph.nodes.len(),
        3,
        "failed draft never commits"
    );
    let result = plan_goal_internal_with_options(
        "revision".into(),
        config.clone(),
        Some("graph"),
        None,
        Some(run_id.clone()),
        &resumed,
        false,
        Some(&failed_revision.planning_id),
        |_| {},
        |_| {},
        |_| {},
        |_| {},
    )
    .unwrap();
    assert_eq!(result.run_id, run_id);
    assert_eq!(
        result
            .graph
            .nodes
            .iter()
            .map(|node| node.name.as_str())
            .collect::<Vec<_>>(),
        vec![
            "before",
            "retry",
            "after",
            "revision-partial",
            "revision-finished"
        ]
    );
    let stale_revision = plan_goal_internal(
        "revision".into(),
        config.clone(),
        Some("graph"),
        None,
        Some(run_id.clone()),
        &resumed,
        |_| {},
        |_| {},
        |_| {},
    )
    .unwrap_err()
    .1
    .unwrap();
    {
        let mut runtime = resumed.runtime.lock().unwrap();
        runtime
            .update_unstarted_node_task("before", "retained", "changed by the user")
            .unwrap();
    }
    let count = resumed.runtime.lock().unwrap().state.events.len();
    let stale = plan_goal_internal_with_options(
        "revision".into(),
        config,
        Some("graph"),
        None,
        Some(run_id.clone()),
        &resumed,
        false,
        Some(&stale_revision.planning_id),
        |_| {},
        |_| {},
        |_| {},
        |_| {},
    );
    assert!(stale.unwrap_err().0.contains("graph changed"));
    assert_eq!(resumed.runtime.lock().unwrap().state.events.len(), count);
    let session_dir = root
        .join("planning")
        .join(&failed.planning_id)
        .join("planner-session");
    let session =
        fs::read_to_string(session_dir.join(format!("test_{}.jsonl", failed.planning_id))).unwrap();
    assert_eq!(session.matches("original goal").count(), 1);
    assert_eq!(session.matches("\"content\":\"revision\"").count(), 2);
    assert!(!session.contains("__grapher_continue_interrupted__"));
}
