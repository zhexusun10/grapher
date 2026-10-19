use super::*;

#[derive(Clone, Copy, Debug)]
enum SourceKind {
    Plain,
    UnbornGit,
    Git,
}

const SOURCES: [SourceKind; 3] = [SourceKind::Plain, SourceKind::UnbornGit, SourceKind::Git];

fn serial_run(kind: SourceKind) -> (TempDir, PathBuf, Runtime) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("tracked.txt"), "original").unwrap();
    fs::write(source.join("deleted.txt"), "original").unwrap();
    fs::write(source.join(".gitignore"), "ignored/\n").unwrap();
    if !matches!(kind, SourceKind::Plain) {
        workspace::git(&source, &["init", "-q"]).unwrap();
        if matches!(kind, SourceKind::Git) {
            workspace::snapshot_repository(&source).unwrap();
        }
        fs::write(source.join("tracked.txt"), "staged user work").unwrap();
        workspace::git(&source, &["add", "tracked.txt"]).unwrap();
        fs::write(source.join("tracked.txt"), "unstaged user work").unwrap();
    }
    fs::create_dir(source.join("ignored")).unwrap();
    fs::write(source.join("ignored/input.bin"), "user data").unwrap();
    let config = serde_json::from_value(serde_json::json!({
        "repository": source, "model": "test/model", "maxParallel": 1, "maxFeedback": 0,
    })).unwrap();
    let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
    runtime.create(single(), config).unwrap();
    runtime.set_route("serial").unwrap();
    (temp, source, runtime)
}

#[derive(Debug, PartialEq, Eq)]
struct GitState {
    head: Option<String>,
    index: Option<Vec<u8>>,
    refs: String,
}

fn git_state(source: &Path) -> Option<GitState> {
    source.join(".git").exists().then(|| GitState {
        head: workspace::git(source, &["rev-parse", "--verify", "HEAD"]).ok(),
        index: fs::read(source.join(".git/index")).ok(),
        refs: workspace::git(source, &["for-each-ref"]).unwrap(),
    })
}

fn agent(job: &mut Job, temp: &TempDir, fail: bool) {
    let script = temp.path().join("serial-agent.mjs");
    fs::write(&script, format!(r#"
import {{ writeFileSync, existsSync, unlinkSync }} from 'node:fs';
for await (const chunk of process.stdin) {{}}
writeFileSync('tracked.txt', 'agent edit');
writeFileSync('result.txt', 'source result');
writeFileSync('ignored/output.bin', 'agent data');
if (existsSync('deleted.txt')) unlinkSync('deleted.txt');
if ({fail}) process.exit(23);
console.log(JSON.stringify({{type:'message_end',message:{{role:'assistant',content:[{{type:'text',text:'Completed'}}]}}}}));
"#)).unwrap();
    job.config.pi_command = crate::native::trusted_node().unwrap().to_string_lossy().into();
    job.config.pi_args = vec![script.to_string_lossy().into()];
}

fn assert_source_only(runtime: &Runtime, source: &Path, git: &Option<GitState>) {
    assert_eq!(&git_state(source), git, "Serial must preserve HEAD, refs and the index");
    assert!(!workspace::shadow_repo_dir(source).unwrap().exists());
    assert!(!runtime.run_workspace_root().exists());
    assert_eq!(runtime.state.base, "");
    assert!(runtime.state.publication.is_none());
    assert!(runtime.state.events.iter().all(|event| !matches!(event.kind,
        EventKind::SourceSnapshotted { .. } | EventKind::PublicationStarted { .. }
    )));
    for execution in &runtime.state.executions {
        assert!(crate::path_identity::same_path(Path::new(&execution.worktree), source));
        assert!(execution.before.is_empty());
        assert!(execution.after.as_ref().is_none_or(String::is_empty));
    }
}

fn run_agent(runtime: &mut Runtime, temp: &TempDir, fail: bool) -> Job {
    let mut job = runtime.jobs().unwrap().remove(0);
    assert!(!job.materialize_source);
    assert!(job.expected_source_head.is_empty());
    agent(&mut job, temp, fail);
    let result = perform(&job, &runtime.root.clone(), &[], |_| {}, |head| {
        assert!(head.is_empty());
        runtime.emit(EventKind::Prepared { execution_id: job.execution.id.clone(), head })
    });
    assert_eq!(result.is_err(), fail, "{result:?}");
    if let Ok((head, _)) = &result {
        assert!(head.is_empty());
    }
    runtime.finish(&job.execution, result).unwrap();
    job
}

#[test]
fn serial_execution_and_followup_never_snapshot_or_commit_the_source() {
    for kind in SOURCES {
        let (temp, source, mut runtime) = serial_run(kind);
        let git = git_state(&source);
        runtime.approve().unwrap();
        let first = run_agent(&mut runtime, &temp, false);
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.phase, "completed");
        assert_source_only(&runtime, &source, &git);
        runtime.reclaim_shadow(&source).unwrap();

        runtime.intervene("task", "continue in the source").unwrap();
        let followup = run_agent(&mut runtime, &temp, false);
        assert_eq!(followup.execution.session_id, first.execution.session_id);
        assert_eq!(followup.resume_execution_id, Some(first.execution.id));
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.phase, "completed");
        assert_source_only(&runtime, &source, &git);
        assert_eq!(fs::read_to_string(source.join("tracked.txt")).unwrap(), "agent edit");
        assert_eq!(fs::read_to_string(source.join("result.txt")).unwrap(), "source result");
        assert_eq!(fs::read_to_string(source.join("ignored/output.bin")).unwrap(), "agent data");
        assert!(!source.join("deleted.txt").exists());
    }
}

#[test]
fn serial_does_not_update_or_reclaim_an_existing_graph_shadow_snapshot() {
    let (temp, source, mut runtime) = serial_run(SourceKind::Plain);
    let head = workspace::materialize_shadow_repo(&source, &[]).unwrap();
    let shadow = workspace::shadow_repo_dir(&source).unwrap();
    let index = fs::read(shadow.join("index")).unwrap();
    runtime.approve().unwrap();
    // Old Serial histories may already contain Git heads. New executions must
    // not propagate or resolve them, even when the snapshot is still present.
    runtime.emit(EventKind::SourceSnapshotted { head: head.clone() }).unwrap();
    let job = run_agent(&mut runtime, &temp, false);
    assert!(job.execution.before.is_empty());
    runtime.capture_planner_source().unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "completed");
    assert!(!runtime.shadow_reclaimable(&source).unwrap());
    runtime.reclaim_shadow(&source).unwrap();
    assert!(shadow.is_dir());
    assert_eq!(workspace::repository_git(&source, &["rev-parse", "HEAD"]).unwrap(), head);
    assert_eq!(fs::read(shadow.join("index")).unwrap(), index);
    assert!(!source.join(".git").exists());
    assert!(runtime.state.publication.is_none());
}

#[test]
fn serial_runs_do_not_keep_published_graph_snapshots_alive() {
    for phase in ["draft", "running", "paused", "failed", "interrupted"] {
        let (temp, source, mut graph) = setup(false, single());
        graph.approve().unwrap();
        let mut job = graph.jobs().unwrap().remove(0);
        attach(&mut graph, &mut job);
        let path = Path::new(&job.execution.worktree);
        workspace::prepare(&source, path, &job.execution.before, &[]).unwrap();
        fs::write(path.join("result.txt"), "published").unwrap();
        let head = workspace::snapshot_node(path, &source, "task").unwrap();
        graph.finish(&job.execution, Ok((head, "completed".into()))).unwrap();
        assert!(graph.jobs().unwrap().is_empty());
        let publication = graph.state.publication.clone().unwrap();
        let head = crate::graph_merge::merge_graph(&source, &publication.heads, || {
            Err("unexpected conflict".into())
        }).unwrap();
        graph.emit(EventKind::PublicationCompleted { head }).unwrap();
        let mut serial = graph.open_run("").unwrap();
        serial.create(single(), graph.state.config.clone().unwrap()).unwrap();
        serial.set_route("serial").unwrap();
        if phase != "draft" {
            serial.approve().unwrap();
            let job = serial.jobs().unwrap().remove(0);
            match phase {
                "paused" => serial.pause(true).unwrap(),
                "failed" => {
                    serial.finish(&job.execution, Err("provider failed".into())).unwrap();
                }
                "interrupted" => {
                    let id = serial.state.run_id.clone();
                    drop(serial);
                    serial = graph.open_run(&id).unwrap();
                }
                _ => {}
            }
        }
        assert!(!graph.store.shadow_repo_needed_by_other_run(&graph.state.run_id, &source).unwrap(),
            "{phase} Serial must not pin a Graph snapshot");
        assert!(!graph.store.shadow_repo_in_use(&workspace::shadow_repo_dir(&source).unwrap()).unwrap());
        assert!(graph.shadow_reclaimable(&source).unwrap());
        graph.reclaim_shadow(&source).unwrap();
        assert!(!workspace::shadow_repo_dir(&source).unwrap().exists());
        assert_eq!(fs::read_to_string(source.join("result.txt")).unwrap(), "published");
        // Starting the draft Serial after Graph cleanup still needs no snapshot.
        if phase == "draft" {
            fs::create_dir(source.join("ignored")).unwrap();
            serial.approve().unwrap();
            run_agent(&mut serial, &temp, false);
            assert!(serial.jobs().unwrap().is_empty());
            assert_source_only(&serial, &source, &None);
        }
    }
}

#[test]
fn graph_source_alias_is_not_treated_as_a_serial_execution() {
    for standard_git in [false, true] {
        let (temp, source, mut runtime) = setup(standard_git, single());
        fs::create_dir(source.join("alias-child")).unwrap();
        fs::create_dir(source.join("ignored")).unwrap();
        runtime.approve().unwrap();
        let mut job = runtime.jobs().unwrap().remove(0);
        let alias = source.join("alias-child").join("..");
        assert_ne!(alias, source);
        assert!(crate::path_identity::same_path(&alias, &source));
        job.execution.worktree = alias.to_string_lossy().into();
        agent(&mut job, &temp, false);
        let git = git_state(&source);
        let mut prepared = false;
        let result = perform(&job, &runtime.root, &[], |_| {}, |_| {
            prepared = true;
            Ok(())
        });
        assert!(result.is_err(), "Graph must reject a source alias, not run directly: {result:?}");
        assert!(!prepared, "reject before launching the agent");
        assert_eq!(fs::read_to_string(source.join("tracked.txt")).unwrap(), "original");
        assert!(!source.join("result.txt").exists());
        assert_eq!(git_state(&source), git);
    }
}

#[test]
fn serial_legacy_commit_heads_do_not_block_followup_after_restart() {
    for kind in SOURCES {
        let (temp, source, mut runtime) = serial_run(kind);
        let git = git_state(&source);
        runtime.approve().unwrap();
        let legacy = runtime.jobs().unwrap().remove(0);
        // Retain old append-only evidence, but never resolve these historical
        // heads when executing a new Serial turn (the objects may be gone).
        let old_head = "0123456789012345678901234567890123456789".to_string();
        runtime.emit(EventKind::Prepared {
            execution_id: legacy.execution.id.clone(), head: old_head.clone(),
        }).unwrap();
        runtime.finish(&legacy.execution, Ok((old_head.clone(), "legacy result".into()))).unwrap();
        assert!(runtime.jobs().unwrap().is_empty());
        let root = runtime.root.clone();
        drop(runtime);
        let mut runtime = Runtime::open(&root).unwrap();
        runtime.intervene("task", "continue without historical Git objects").unwrap();
        let followup = run_agent(&mut runtime, &temp, false);
        assert_eq!(followup.execution.session_id, legacy.execution.session_id);
        assert!(followup.execution.before.is_empty());
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.phase, "completed");
        let saved = runtime.store.load(&runtime.state.run_id).unwrap();
        assert_eq!(saved.executions[0].before, old_head);
        assert_eq!(saved.executions[0].after.as_deref(), Some(old_head.as_str()));
        assert_eq!(saved.executions[1].after.as_deref(), Some(""));
        assert_eq!(git_state(&source), git);
        assert!(!workspace::shadow_repo_dir(&source).unwrap().exists());
        assert!(!runtime.run_workspace_root().exists());
    }
}

#[test]
fn serial_failed_execution_retries_after_restart_without_git_snapshots() {
    for kind in SOURCES {
        let (temp, source, mut runtime) = serial_run(kind);
        let git = git_state(&source);
        runtime.approve().unwrap();
        let failed = run_agent(&mut runtime, &temp, true);
        assert_eq!(runtime.state.nodes["task"].status, "failed");
        assert_source_only(&runtime, &source, &git);
        let root = runtime.root.clone();
        drop(runtime);
        let mut runtime = Runtime::open(&root).unwrap();
        runtime.intervene("task", "retry without changing Git").unwrap();
        runtime.pause(false).unwrap();
        let retry = run_agent(&mut runtime, &temp, false);
        assert_eq!(retry.execution.session_id, failed.execution.session_id);
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.phase, "completed");
        assert_source_only(&runtime, &source, &git);
    }
}

#[test]
fn serial_interrupted_execution_resumes_in_the_source_without_git_snapshots() {
    for kind in SOURCES {
        let (temp, source, mut runtime) = serial_run(kind);
        let git = git_state(&source);
        runtime.approve().unwrap();
        let interrupted = runtime.jobs().unwrap().remove(0);
        runtime.emit(EventKind::Prepared {
            execution_id: interrupted.execution.id.clone(), head: String::new(),
        }).unwrap();
        fs::write(source.join("partial.txt"), "unfinished work").unwrap();
        let root = runtime.root.clone();
        drop(runtime);
        let mut runtime = Runtime::open(&root).unwrap();
        assert!(runtime.state.can_resume_interrupted());
        runtime.pause(false).unwrap();
        let retry = run_agent(&mut runtime, &temp, false);
        assert_eq!(retry.execution.session_id, interrupted.execution.session_id);
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.phase, "completed");
        assert_source_only(&runtime, &source, &git);
        assert_eq!(fs::read_to_string(source.join("partial.txt")).unwrap(), "unfinished work");
    }
}
