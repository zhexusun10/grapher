use super::*;

fn prepared_worker(standard_git: bool) -> (TempDir, PathBuf, Runtime, Job) {
    let graph = Graph {
        original_goal: "recover an interrupted dependent node".into(),
        nodes: ["parent", "worker"].into_iter()
            .map(|name| Node { name: name.into(), task: name.into() }).collect(),
        edges: vec![Edge { from: "parent".into(), to: "worker".into(), feedback: false }],
    };
    let (temp, source, mut runtime) = setup(standard_git, graph);
    fs::write(source.join(".gitignore"), "__pycache__/\nignored/\n").unwrap();
    runtime.approve().unwrap();
    let mut parent = runtime.jobs().unwrap().remove(0);
    attach(&mut runtime, &mut parent);
    let path = Path::new(&parent.execution.worktree);
    workspace::prepare(&source, path, &parent.execution.before, &[]).unwrap();
    fs::create_dir_all(path.join("branch_b/__pycache__")).unwrap();
    fs::write(path.join("branch_b/__pycache__/model.pyc"), b"original cache").unwrap();
    fs::write(path.join("parent.txt"), "parent output").unwrap();
    let head = workspace::snapshot_node_for_run(path, &source, "parent", Some(&runtime.state.run_id)).unwrap();
    runtime.finish(&parent.execution, Ok((head, "done".into()))).unwrap();
    let worker = runtime.jobs().unwrap().remove(0);
    let prepared = workspace::prepare_with_merger_expected_for_run(
        &source, Path::new(&worker.execution.worktree), &worker.execution.before,
        &worker.parent_heads, &worker.expected_source_head, Some(&worker.run_id),
        || Err("unexpected composition conflict".into()),
    ).unwrap();
    assert_ne!(prepared, runtime.latest_source_head());
    runtime.emit(EventKind::Prepared { execution_id: worker.execution.id.clone(), head: prepared }).unwrap();
    (temp, source, runtime, worker)
}

fn dirty_workspace(path: &Path) {
    // Bytecode is ordinary tracked project output, even though .gitignore
    // matches it. Recovery must preserve all partial work, not special-case it.
    fs::write(path.join("branch_b/__pycache__/model.pyc"), b"regenerated cache").unwrap();
    fs::write(path.join("tracked.txt"), "partial source change").unwrap();
    workspace::git(path, &["add", "tracked.txt"]).unwrap();
    fs::remove_file(path.join("deleted.txt")).unwrap();
    fs::write(path.join("untracked.txt"), "unfinished output").unwrap();
    fs::create_dir_all(path.join("ignored")).unwrap();
    fs::write(path.join("ignored/new.bin"), b"ignored partial output").unwrap();
}

fn assert_partial_work(path: &Path) {
    assert_eq!(fs::read(path.join("branch_b/__pycache__/model.pyc")).unwrap(), b"regenerated cache");
    assert_eq!(fs::read_to_string(path.join("tracked.txt")).unwrap(), "partial source change");
    assert!(!path.join("deleted.txt").exists());
    assert_eq!(fs::read_to_string(path.join("untracked.txt")).unwrap(), "unfinished output");
    assert_eq!(fs::read(path.join("ignored/new.bin")).unwrap(), b"ignored partial output");
    assert_eq!(fs::read_to_string(path.join("parent.txt")).unwrap(), "parent output");
}

fn local_agent(job: &mut Job, temp: &TempDir) {
    let script = temp.path().join("recovery-agent.mjs");
    fs::write(&script, "for await (const chunk of process.stdin) {}\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Recovered'}]}}));\n").unwrap();
    job.config.pi_command = crate::native::trusted_node().unwrap().to_string_lossy().into();
    job.config.pi_args = vec![script.to_string_lossy().into()];
}

#[test]
fn interrupted_resume_preserves_dirty_files_index_and_agent_commits_after_restart() {
    for standard_git in [true, false] {
        for agent_commit in [false, true] {
            let (temp, _source, mut runtime, worker) = prepared_worker(standard_git);
            let path = PathBuf::from(&worker.execution.worktree);
            if agent_commit {
                fs::write(path.join("agent-commit.txt"), "committed progress").unwrap();
                workspace::git(&path, &["add", "agent-commit.txt"]).unwrap();
                workspace::git(&path, &["commit", "-q", "-m", "agent progress"]).unwrap();
            }
            let head = workspace::git(&path, &["rev-parse", "HEAD"]).unwrap();
            dirty_workspace(&path);
            let status = workspace::git(&path, &["status", "--porcelain", "--untracked-files=all"]).unwrap();
            let staged = workspace::git(&path, &["diff", "--cached", "--name-status"]).unwrap();
            let root = runtime.root.clone();
            drop(runtime); // Simulate backend loss while the prepared node is running.
            runtime = Runtime::open(&root).unwrap();
            assert!(runtime.state.can_resume_interrupted());
            runtime.pause(false).unwrap();
            let mut retry = runtime.jobs().unwrap().remove(0);
            assert!(retry.continuation);
            assert!(retry.task.is_empty());
            assert_eq!(retry.execution.session_id, worker.execution.session_id);
            assert_eq!(retry.execution.worktree, worker.execution.worktree);
            local_agent(&mut retry, &temp);
            let result = perform(&retry, &root, &[], |_| {}, |prepared| {
                assert_eq!(prepared, head, "the existing HEAD must not be recomposed");
                assert_partial_work(&path);
                assert_eq!(workspace::git(&path, &["status", "--porcelain", "--untracked-files=all"]).unwrap(), status);
                assert_eq!(workspace::git(&path, &["diff", "--cached", "--name-status"]).unwrap(), staged);
                runtime.emit(EventKind::Prepared { execution_id: retry.execution.id.clone(), head: prepared })
            });
            runtime.finish(&retry.execution, result.clone()).unwrap();
            result.expect("dirty interrupted work must survive continuation");
            assert_partial_work(&path);
            workspace::verify_prepared_ancestor(&path, &head).unwrap();
            assert_eq!(runtime.state.nodes["worker"].status, "done");
            assert_eq!(runtime.state.executions.iter().find(|e| e.id == worker.execution.id).unwrap().status, "failed");
            assert!(runtime.state.executions.iter().find(|e| e.id == worker.execution.id).unwrap().after.is_none());
        }
    }
}

#[test]
fn failed_preparation_retry_recovers_the_last_prepared_attempt_in_the_same_session() {
    let (temp, _source, mut runtime, worker) = prepared_worker(true);
    let path = PathBuf::from(&worker.execution.worktree);
    let head = workspace::git(&path, &["rev-parse", "HEAD"]).unwrap();
    dirty_workspace(&path);
    runtime.finish(&worker.execution, Err("Application stopped during this execution".into())).unwrap();
    runtime.pause(false).unwrap();
    let unprepared = runtime.jobs().unwrap().remove(0);
    // Emulate the old checkout failure: Started exists, but no Prepared event
    // was recorded and the earlier interrupted work remains on disk.
    runtime.finish(&unprepared.execution, Err("local changes would be overwritten by checkout".into())).unwrap();
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    runtime.intervene("worker", "retry without discarding unfinished work").unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    assert!(!retry.continuation, "an explicit retry is a new user instruction");
    assert_eq!(retry.execution.session_id, worker.execution.session_id);
    local_agent(&mut retry, &temp);
    let root = runtime.root.clone();
    let result = perform(&retry, &root, &[], |_| {}, |prepared| {
        assert_eq!(prepared, head);
        assert_partial_work(&path);
        runtime.emit(EventKind::Prepared { execution_id: retry.execution.id.clone(), head: prepared })
    });
    runtime.finish(&retry.execution, result.clone()).unwrap();
    result.expect("a failed preparation must not hide the previous prepared workspace");
    assert_partial_work(&path);
}

#[test]
fn recovery_refuses_changed_inputs_without_resetting_partial_work() {
    for changed_parent in [false, true] {
        let (temp, source, mut runtime, worker) = prepared_worker(true);
        let path = PathBuf::from(&worker.execution.worktree);
        let head = workspace::git(&path, &["rev-parse", "HEAD"]).unwrap();
        dirty_workspace(&path);
        runtime.finish(&worker.execution, Err("Application stopped during this execution".into())).unwrap();
        runtime.pause(false).unwrap();
        let mut retry = runtime.jobs().unwrap().remove(0);
        fs::write(source.join("new-input.txt"), "later input").unwrap();
        let new_input = workspace::snapshot_repository(&source).unwrap();
        if changed_parent { retry.parent_heads = vec![new_input]; }
        else { retry.expected_source_head = new_input; }
        local_agent(&mut retry, &temp);
        let error = perform(&retry, &runtime.root, &[], |_| {}, |_| panic!("must fail before Prepared")).unwrap_err();
        assert!(error.contains("input") && error.contains("preserv"), "{error}");
        assert_eq!(workspace::git(&path, &["rev-parse", "HEAD"]).unwrap(), head);
        assert_partial_work(&path);
    }
}

#[test]
fn recovery_refuses_missing_workspace_without_creating_a_replacement() {
    let (temp, _source, mut runtime, worker) = prepared_worker(true);
    let path = PathBuf::from(&worker.execution.worktree);
    dirty_workspace(&path);
    runtime.finish(&worker.execution, Err("Application stopped during this execution".into())).unwrap();
    runtime.pause(false).unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    let saved = temp.path().join("retained-workspace");
    fs::rename(&path, &saved).unwrap();
    local_agent(&mut retry, &temp);
    let error = perform(&retry, &runtime.root, &[], |_| {}, |_| panic!("must fail before Prepared")).unwrap_err();
    assert!(error.contains("workspace") && error.contains("preserv"), "{error}");
    assert!(!path.exists(), "recovery must not silently recreate the interrupted directory");
    assert_partial_work(&saved);
}

#[test]
fn recovery_refuses_rewritten_history_without_touching_dirty_files() {
    let (temp, _source, mut runtime, worker) = prepared_worker(true);
    let path = PathBuf::from(&worker.execution.worktree);
    // Model an agent discarding the prepared parent history before interruption.
    workspace::git(&path, &["checkout", "-q", "-B", "rewritten", runtime.latest_source_head()]).unwrap();
    fs::create_dir_all(path.join("branch_b/__pycache__")).unwrap();
    fs::write(path.join("branch_b/__pycache__/model.pyc"), b"keep this evidence").unwrap();
    let head = workspace::git(&path, &["rev-parse", "HEAD"]).unwrap();
    runtime.finish(&worker.execution, Err("Application stopped during this execution".into())).unwrap();
    runtime.pause(false).unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    local_agent(&mut retry, &temp);
    let error = perform(&retry, &runtime.root, &[], |_| {}, |_| panic!("must fail before Prepared")).unwrap_err();
    assert!(error.contains("prepared Git history"), "{error}");
    assert_eq!(workspace::git(&path, &["rev-parse", "HEAD"]).unwrap(), head);
    assert_eq!(fs::read(path.join("branch_b/__pycache__/model.pyc")).unwrap(), b"keep this evidence");
}
