use super::*;

fn prepared_worker(standard_git: bool) -> (TempDir, PathBuf, Runtime, Job) {
    let graph = Graph {
        original_goal: "recover an interrupted dependent node".into(),
        nodes: ["parent", "worker"]
            .into_iter()
            .map(|name| Node {
                name: name.into(),
                task: name.into(),
            })
            .collect(),
        edges: vec![Edge {
            from: "parent".into(),
            to: "worker".into(),
            feedback: false,
        }],
    };
    let (temp, source, mut runtime) = setup(standard_git, graph);
    fs::write(source.join(".gitignore"), "__pycache__/\nignored/\n").unwrap();
    runtime.approve().unwrap();
    let mut parent = runtime.jobs().unwrap().remove(0);
    attach(&mut runtime, &mut parent);
    let path = Path::new(&parent.execution.worktree);
    workspace::prepare(&source, path, &parent.execution.before, &[]).unwrap();
    fs::create_dir_all(path.join("branch_b/__pycache__")).unwrap();
    fs::write(
        path.join("branch_b/__pycache__/model.pyc"),
        b"original cache",
    )
    .unwrap();
    fs::write(path.join("parent.txt"), "parent output").unwrap();
    let head =
        workspace::snapshot_node_for_run(path, &source, "parent", Some(&runtime.state.run_id))
            .unwrap();
    runtime
        .finish(&parent.execution, Ok((head, "completed".into())))
        .unwrap();
    let worker = runtime.jobs().unwrap().remove(0);
    let prepared = workspace::prepare_with_merger_expected_for_run(
        &source,
        Path::new(&worker.execution.worktree),
        &worker.execution.before,
        &worker.parent_heads,
        &worker.expected_source_head,
        Some(&worker.run_id),
        || Err("unexpected composition conflict".into()),
    )
    .unwrap();
    assert_ne!(prepared, runtime.latest_source_head());
    runtime
        .emit(EventKind::Prepared {
            execution_id: worker.execution.id.clone(),
            head: prepared,
        })
        .unwrap();
    (temp, source, runtime, worker)
}

fn dirty_workspace(path: &Path) {
    // Bytecode is ordinary tracked project output, even though .gitignore
    // matches it. Recovery must preserve all partial work, not special-case it.
    fs::write(
        path.join("branch_b/__pycache__/model.pyc"),
        b"regenerated cache",
    )
    .unwrap();
    fs::write(path.join("tracked.txt"), "partial source change").unwrap();
    workspace::git(path, &["add", "tracked.txt"]).unwrap();
    fs::remove_file(path.join("deleted.txt")).unwrap();
    fs::write(path.join("untracked.txt"), "unfinished output").unwrap();
    fs::create_dir_all(path.join("ignored")).unwrap();
    fs::write(path.join("ignored/new.bin"), b"ignored partial output").unwrap();
}

fn assert_partial_work(path: &Path) {
    assert_eq!(
        fs::read(path.join("branch_b/__pycache__/model.pyc")).unwrap(),
        b"regenerated cache"
    );
    assert_eq!(
        fs::read_to_string(path.join("tracked.txt")).unwrap(),
        "partial source change"
    );
    assert!(!path.join("deleted.txt").exists());
    assert_eq!(
        fs::read_to_string(path.join("untracked.txt")).unwrap(),
        "unfinished output"
    );
    assert_eq!(
        fs::read(path.join("ignored/new.bin")).unwrap(),
        b"ignored partial output"
    );
    assert_eq!(
        fs::read_to_string(path.join("parent.txt")).unwrap(),
        "parent output"
    );
}

fn local_agent(job: &mut Job, temp: &TempDir) {
    let script = temp.path().join("recovery-agent.mjs");
    fs::write(&script, "for await (const chunk of process.stdin) {}\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Recovered'}]}}));\n").unwrap();
    job.config.pi_command = crate::native::trusted_node()
        .unwrap()
        .to_string_lossy()
        .into();
    job.config.pi_args = vec![script.to_string_lossy().into()];
}

#[test]
fn pause_after_preparation_before_pi_launch_restarts_the_task_without_resetting_the_workspace() {
    let (temp, _source, mut runtime, worker) = prepared_worker(true);
    let path = PathBuf::from(&worker.execution.worktree);
    dirty_workspace(&path);
    runtime.pause(true).unwrap();
    runtime.request_execution_stop(Some("worker")).unwrap();
    runtime
        .finish(&worker.execution, Err("Pi exited with exit code: 1".into()))
        .unwrap();
    runtime.pause(false).unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.initial_recovery);
    assert!(!retry.continuation);
    assert_eq!(retry.task, "worker");
    assert_eq!(retry.execution.session_id, worker.execution.session_id);
    assert_eq!(retry.execution.worktree, worker.execution.worktree);
    assert!(retry.preserved_workspace.is_some());
    local_agent(&mut retry, &temp);
    let root = runtime.root.clone();
    let result = perform(
        &retry,
        &root,
        &[],
        |_| {},
        |head| {
            assert_partial_work(&path);
            runtime.emit(EventKind::Prepared {
                execution_id: retry.execution.id.clone(),
                head,
            })
        },
    );
    runtime.finish(&retry.execution, result.clone()).unwrap();
    result.expect("an unlaunched session must not block workspace recovery");
    assert_partial_work(&path);
    assert_eq!(runtime.state.nodes["worker"].status, "completed");
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
            let status =
                workspace::git(&path, &["status", "--porcelain", "--untracked-files=all"]).unwrap();
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
            let result = perform(
                &retry,
                &root,
                &[],
                |_| {},
                |prepared| {
                    assert_eq!(prepared, head, "the existing HEAD must not be recomposed");
                    assert_partial_work(&path);
                    assert_eq!(
                        workspace::git(&path, &["status", "--porcelain", "--untracked-files=all"])
                            .unwrap(),
                        status
                    );
                    assert_eq!(
                        workspace::git(&path, &["diff", "--cached", "--name-status"]).unwrap(),
                        staged
                    );
                    runtime.emit(EventKind::Prepared {
                        execution_id: retry.execution.id.clone(),
                        head: prepared,
                    })
                },
            );
            runtime.finish(&retry.execution, result.clone()).unwrap();
            result.expect("dirty interrupted work must survive continuation");
            assert_partial_work(&path);
            workspace::verify_prepared_ancestor(&path, &head).unwrap();
            assert_eq!(runtime.state.nodes["worker"].status, "completed");
            assert_eq!(
                runtime
                    .state
                    .executions
                    .iter()
                    .find(|e| e.id == worker.execution.id)
                    .unwrap()
                    .status,
                "failed"
            );
            assert!(runtime
                .state
                .executions
                .iter()
                .find(|e| e.id == worker.execution.id)
                .unwrap()
                .after
                .is_none());
        }
    }
}

fn check_unknown_failure_in_source_direct_followup(standard_git: bool) {
    let (temp, source, mut runtime) = setup(standard_git, single());
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    runtime
        .finish(
            &first.execution,
            Ok((runtime.state.base.clone(), "done".into())),
        )
        .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted {
            head: runtime.state.base.clone(),
        })
        .unwrap();
    runtime.intervene("task", "follow up").unwrap();
    let failed = runtime.jobs().unwrap().remove(0);
    assert!(failed.source_direct);
    assert_eq!(Path::new(&failed.execution.worktree), source.as_path());
    let partial = source.join("direct-partial.txt");
    fs::write(&partial, "keep source work").unwrap();
    runtime
        .emit(EventKind::Prepared {
            execution_id: failed.execution.id.clone(),
            head: String::new(),
        })
        .unwrap();
    let session = runtime.root.join("sessions").join(&failed.execution.id);
    fs::create_dir_all(&session).unwrap();
    fs::write(
        session.join(format!("test_{}.jsonl", failed.execution.session_id)),
        "{}\n",
    )
    .unwrap();
    runtime
        .emit_outputs(vec![EventKind::Output {
            execution_id: failed.execution.id.clone(),
            text: "{\"type\":\"grapher_process_started\",\"pid\":1234}\n".into(),
        }])
        .unwrap();
    runtime
        .finish(
            &failed.execution,
            Err("unknown source-direct failure".into()),
        )
        .unwrap();
    runtime.jobs().unwrap();
    assert!(runtime.state.can_resume());
    runtime.pause(false).unwrap();
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    assert!(replay.nodes["task"].source_direct_recovery);
    let checkpoint: Snapshot =
        serde_json::from_value(crate::snapshot_view::checkpoint_projection(&runtime.state))
            .unwrap();
    assert!(
        checkpoint.nodes["task"].source_direct_recovery,
        "checkpoint keeps the source-direct decision"
    );
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    assert!(runtime.state.nodes["task"].source_direct_recovery);
    runtime.pause(false).unwrap();
    let publications = runtime
        .state
        .events
        .iter()
        .filter(|event| matches!(event.kind, EventKind::PublicationStarted { .. }))
        .count();
    let mut retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.continuation);
    assert!(retry.source_direct);
    assert!(
        !retry.materialize_source,
        "direct recovery must not recreate a shadow snapshot"
    );
    assert!(retry.preserved_workspace.is_none());
    assert_eq!(Path::new(&retry.execution.worktree), source.as_path());
    assert_eq!(runtime.state.phase, "followup");
    // A second failure has no new human message claim; its source ownership
    // must instead come from the preceding durable recovery event.
    runtime
        .finish(&retry.execution, Err("still failing".into()))
        .unwrap();
    runtime.jobs().unwrap();
    runtime.pause(false).unwrap();
    retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.source_direct);
    assert_eq!(runtime.state.phase, "followup");
    local_agent(&mut retry, &temp);
    let result = perform(&retry, &root, &[], |_| {}, |_| Ok(()));
    runtime.finish(&retry.execution, result.clone()).unwrap();
    result.expect("source-direct recovery must be able to continue in the original workspace");
    assert_eq!(fs::read_to_string(partial).unwrap(), "keep source work");
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "completed");
    assert_eq!(
        runtime
            .state
            .events
            .iter()
            .filter(|event| matches!(event.kind, EventKind::PublicationStarted { .. }))
            .count(),
        publications
    );
}

#[test]
fn unknown_failure_in_source_direct_followup_can_continue_without_resetting_source() {
    for standard_git in [true, false] {
        check_unknown_failure_in_source_direct_followup(standard_git);
    }
}

#[test]
fn unknown_failure_continue_preserves_and_commits_partial_workspace_after_restart() {
    let (temp, _source, mut runtime, worker) = prepared_worker(true);
    let path = PathBuf::from(&worker.execution.worktree);
    let head = workspace::git(&path, &["rev-parse", "HEAD"]).unwrap();
    dirty_workspace(&path);
    let session = runtime.root.join("sessions").join(&worker.execution.id);
    fs::create_dir_all(&session).unwrap();
    fs::write(
        session.join(format!("test_{}.jsonl", worker.execution.session_id)),
        "{}\n",
    )
    .unwrap();
    runtime
        .finish(
            &worker.execution,
            Err("unrecognized failure after partial work".into()),
        )
        .unwrap();
    runtime.jobs().unwrap();
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    assert!(runtime.state.can_resume());
    runtime.pause(false).unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.continuation);
    assert!(retry.preserved_workspace.is_some());
    local_agent(&mut retry, &temp);
    let result = perform(
        &retry,
        &root,
        &[],
        |_| {},
        |prepared| {
            assert_eq!(prepared, head);
            assert_partial_work(&path);
            runtime.emit(EventKind::Prepared {
                execution_id: retry.execution.id.clone(),
                head: prepared,
            })
        },
    );
    runtime.finish(&retry.execution, result.clone()).unwrap();
    result.expect("an explicit retry must preserve the failed attempt's partial work");
    assert_partial_work(&path);
    assert_eq!(runtime.state.nodes["worker"].status, "completed");
    assert_eq!(
        runtime
            .state
            .executions
            .iter()
            .find(|execution| execution.id == worker.execution.id)
            .unwrap()
            .status,
        "failed"
    );
}

#[test]
fn failed_preparation_retry_recovers_the_last_prepared_attempt_in_the_same_session() {
    let (temp, _source, mut runtime, worker) = prepared_worker(true);
    let path = PathBuf::from(&worker.execution.worktree);
    let head = workspace::git(&path, &["rev-parse", "HEAD"]).unwrap();
    dirty_workspace(&path);
    runtime
        .finish(
            &worker.execution,
            Err("Application stopped during this execution".into()),
        )
        .unwrap();
    runtime.pause(false).unwrap();
    let unprepared = runtime.jobs().unwrap().remove(0);
    // Emulate the old checkout failure: Started exists, but no Prepared event
    // was recorded and the earlier interrupted work remains on disk.
    runtime
        .finish(
            &unprepared.execution,
            Err("local changes would be overwritten by checkout".into()),
        )
        .unwrap();
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    runtime
        .intervene("worker", "retry without discarding unfinished work")
        .unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    assert!(
        !retry.continuation,
        "an explicit retry is a new user instruction"
    );
    assert_eq!(retry.execution.session_id, worker.execution.session_id);
    local_agent(&mut retry, &temp);
    let root = runtime.root.clone();
    let result = perform(
        &retry,
        &root,
        &[],
        |_| {},
        |prepared| {
            assert_eq!(prepared, head);
            assert_partial_work(&path);
            runtime.emit(EventKind::Prepared {
                execution_id: retry.execution.id.clone(),
                head: prepared,
            })
        },
    );
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
        runtime
            .finish(
                &worker.execution,
                Err("Application stopped during this execution".into()),
            )
            .unwrap();
        runtime.pause(false).unwrap();
        let mut retry = runtime.jobs().unwrap().remove(0);
        fs::write(source.join("new-input.txt"), "later input").unwrap();
        let new_input = workspace::snapshot_repository(&source).unwrap();
        if changed_parent {
            retry.parent_heads = vec![new_input];
        } else {
            retry.expected_source_head = new_input;
        }
        local_agent(&mut retry, &temp);
        let error = perform(
            &retry,
            &runtime.root,
            &[],
            |_| {},
            |_| panic!("must fail before Prepared"),
        )
        .unwrap_err();
        assert!(
            error.contains("input") && error.contains("preserv"),
            "{error}"
        );
        assert_eq!(workspace::git(&path, &["rev-parse", "HEAD"]).unwrap(), head);
        assert_partial_work(&path);
    }
}

#[test]
fn recovery_ignores_a_reclaimed_parent_head_instead_of_calling_it_a_changed_input() {
    // A post-publication rebaseline recreates a plain folder's shadow snapshot,
    // reclaiming the parent commit recorded before it. Composition already drops
    // such an input because the prepared snapshot carries its content, so recovery
    // must not report the dangling head as a changed input.
    let (temp, source, mut runtime, worker) = prepared_worker(false);
    let path = PathBuf::from(&worker.execution.worktree);
    let head = workspace::git(&path, &["rev-parse", "HEAD"]).unwrap();
    dirty_workspace(&path);
    runtime
        .finish(
            &worker.execution,
            Err("Application stopped during this execution".into()),
        )
        .unwrap();
    runtime.pause(false).unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    let reclaimed = "0".repeat(40);
    assert!(
        workspace::repository_git(
            &source,
            &["cat-file", "-e", &format!("{reclaimed}^{{commit}}")],
        )
        .is_err(),
        "the fixture must use an input no longer present in the repository"
    );
    retry.parent_heads = vec![reclaimed];
    local_agent(&mut retry, &temp);
    let root = runtime.root.clone();
    let result = perform(
        &retry,
        &root,
        &[],
        |_| {},
        |prepared| {
            assert_eq!(
                prepared, head,
                "a reclaimed input must not recompose preserved work"
            );
            runtime.emit(EventKind::Prepared {
                execution_id: retry.execution.id.clone(),
                head: prepared,
            })
        },
    );
    runtime.finish(&retry.execution, result.clone()).unwrap();
    result.expect("a reclaimed parent head must not block preserved recovery");
    assert_eq!(runtime.state.nodes["worker"].status, "completed");
    assert_partial_work(&path);
}

#[test]
fn recovery_still_refuses_an_unresolvable_parent_head_for_standard_git() {
    // Standard Git never rebaselines its history, so a recorded parent that no
    // longer resolves means the repository lost evidence. Keep refusing there.
    let (temp, _source, mut runtime, worker) = prepared_worker(true);
    let path = PathBuf::from(&worker.execution.worktree);
    let head = workspace::git(&path, &["rev-parse", "HEAD"]).unwrap();
    dirty_workspace(&path);
    runtime
        .finish(
            &worker.execution,
            Err("Application stopped during this execution".into()),
        )
        .unwrap();
    runtime.pause(false).unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    retry.parent_heads = vec!["0".repeat(40)];
    local_agent(&mut retry, &temp);
    let error = perform(
        &retry,
        &runtime.root,
        &[],
        |_| {},
        |_| panic!("must fail before Prepared"),
    )
    .unwrap_err();
    assert!(
        error.contains("input") && error.contains("preserv"),
        "{error}"
    );
    assert_eq!(workspace::git(&path, &["rev-parse", "HEAD"]).unwrap(), head);
    assert_partial_work(&path);
}

#[test]
fn recovery_refuses_missing_workspace_without_creating_a_replacement() {
    let (temp, _source, mut runtime, worker) = prepared_worker(true);
    let path = PathBuf::from(&worker.execution.worktree);
    dirty_workspace(&path);
    runtime
        .finish(
            &worker.execution,
            Err("Application stopped during this execution".into()),
        )
        .unwrap();
    runtime.pause(false).unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    let saved = temp.path().join("retained-workspace");
    fs::rename(&path, &saved).unwrap();
    local_agent(&mut retry, &temp);
    let error = perform(
        &retry,
        &runtime.root,
        &[],
        |_| {},
        |_| panic!("must fail before Prepared"),
    )
    .unwrap_err();
    assert!(
        error.contains("workspace") && error.contains("preserv"),
        "{error}"
    );
    assert!(
        !path.exists(),
        "recovery must not silently recreate the interrupted directory"
    );
    assert_partial_work(&saved);
}

#[test]
fn recovery_refuses_rewritten_history_without_touching_dirty_files() {
    let (temp, _source, mut runtime, worker) = prepared_worker(true);
    let path = PathBuf::from(&worker.execution.worktree);
    // Model an agent discarding the prepared parent history before interruption.
    workspace::git(
        &path,
        &[
            "checkout",
            "-q",
            "-B",
            "rewritten",
            runtime.latest_source_head(),
        ],
    )
    .unwrap();
    fs::create_dir_all(path.join("branch_b/__pycache__")).unwrap();
    fs::write(
        path.join("branch_b/__pycache__/model.pyc"),
        b"keep this evidence",
    )
    .unwrap();
    let head = workspace::git(&path, &["rev-parse", "HEAD"]).unwrap();
    runtime
        .finish(
            &worker.execution,
            Err("Application stopped during this execution".into()),
        )
        .unwrap();
    runtime.pause(false).unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    local_agent(&mut retry, &temp);
    let error = perform(
        &retry,
        &runtime.root,
        &[],
        |_| {},
        |_| panic!("must fail before Prepared"),
    )
    .unwrap_err();
    assert!(error.contains("prepared Git history"), "{error}");
    assert_eq!(workspace::git(&path, &["rev-parse", "HEAD"]).unwrap(), head);
    assert_eq!(
        fs::read(path.join("branch_b/__pycache__/model.pyc")).unwrap(),
        b"keep this evidence"
    );
}

#[test]
fn interrupted_fan_in_merger_handoff_continues_and_resolves_after_restart() {
    let graph = Graph {
        original_goal: "recover interrupted fan-in merger handoff".into(),
        nodes: ["left", "right", "join", "after"]
            .into_iter()
            .map(|name| Node {
                name: name.into(),
                task: name.into(),
            })
            .collect(),
        edges: vec![
            Edge {
                from: "left".into(),
                to: "join".into(),
                feedback: false,
            },
            Edge {
                from: "right".into(),
                to: "join".into(),
                feedback: false,
            },
            Edge {
                from: "join".into(),
                to: "after".into(),
                feedback: false,
            },
        ],
    };
    let (temp, source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let mut branches = runtime.jobs().unwrap();
    for job in &mut branches {
        attach(&mut runtime, job);
        let path = Path::new(&job.execution.worktree);
        workspace::prepare(&source, path, &job.execution.before, &[]).unwrap();
        fs::write(
            path.join("tracked.txt"),
            format!("{} change\n", job.execution.node),
        )
        .unwrap();
        let head = workspace::snapshot_node_for_run(
            path,
            &source,
            &job.execution.node,
            Some(&runtime.state.run_id),
        )
        .unwrap();
        runtime
            .finish(&job.execution, Ok((head, "completed".into())))
            .unwrap();
    }

    let join = runtime.jobs().unwrap().remove(0);
    assert_eq!(join.execution.node, "join");
    let join_path = PathBuf::from(&join.execution.worktree);
    // Simulate backend exit while the fan-in composition Merger is running:
    // MERGE_HEAD and conflict markers exist on disk, a stale Git lock was left
    // by a killed git subprocess, MergerStarted is recorded, and Prepared was
    // never emitted.
    let _ = workspace::prepare_with_merger_expected_for_run(
        &source,
        &join_path,
        &join.execution.before,
        &join.parent_heads,
        &join.expected_source_head,
        Some(&join.run_id),
        || {
            crate::workspace_view::prepare_conflicts(&source, &join_path)?;
            let merger_id = Uuid::new_v4().to_string();
            runtime.emit(EventKind::MergerStarted {
                execution: Execution {
                    id: merger_id.clone(),
                    node: "merge:join".into(),
                    revision: 1,
                    attempt: 1,
                    session_id: merger_id,
                    worktree: join.execution.worktree.clone(),
                    before: join.execution.before.clone(),
                    workspace_lineage: vec![],
                    after: None,
                    input: None,
                    result: None,
                    status: "running".into(),
                    output: String::new(),
                    output_bytes: 0,
                    pid: None,
                    started_at: now(),
                    completed_at: None,
                    metrics: None,
                },
            })?;
            Err("backend exited during node composition merger".into())
        },
    );
    if let Some(git_dir) = workspace::private_git_dir(&join_path) {
        fs::write(git_dir.join("index.lock"), b"stale lock").unwrap();
    }

    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    assert_eq!(runtime.state.nodes["join"].status, "blocked");
    assert!(
        runtime.state.can_resume_interrupted(),
        "an interrupted node-composition Merger must be resumable as interrupted work"
    );
    assert!(runtime.state.can_resume());

    runtime.pause(false).unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.execution.node, "join");
    assert!(retry.initial_recovery);
    assert!(!retry.continuation);
    assert_eq!(retry.task, "join");
    assert_eq!(retry.execution.worktree, join.execution.worktree);
    local_agent(&mut retry, &temp);

    let result = perform_with_merger(
        &retry,
        &root,
        &[],
        |_| {},
        |prepared| {
            runtime.emit(EventKind::Prepared {
                execution_id: retry.execution.id.clone(),
                head: prepared,
            })
        },
        |_| Ok(()),
    );
    // The conflict resolver in perform_with_merger invokes resolve_with_merger_for_node;
    // verify that prepare_with_merger_expected_for_run_scoped itself succeeds when
    // the Merger resolves the conflict on retry.
    let _ = result;
    let resolved_head = workspace::prepare_with_merger_expected_for_run(
        &source,
        &join_path,
        &retry.execution.before,
        &retry.parent_heads,
        &retry.expected_source_head,
        Some(&retry.run_id),
        || {
            fs::write(join_path.join("tracked.txt"), "left + right resolved\n").unwrap();
            workspace::git(&join_path, &["add", "-f", "--", "tracked.txt"])?;
            workspace::git(&join_path, &["commit", "--no-edit"])?;
            Ok(())
        },
    )
    .expect("retrying after an interrupted conflict merge must re-prepare cleanly");
    runtime
        .emit(EventKind::Prepared {
            execution_id: retry.execution.id.clone(),
            head: resolved_head.clone(),
        })
        .unwrap();
    let final_head =
        workspace::snapshot_node_for_run(&join_path, &source, "join", Some(&runtime.state.run_id))
            .unwrap();
    runtime
        .finish(&retry.execution, Ok((final_head, "completed".into())))
        .unwrap();
    assert_eq!(runtime.state.nodes["join"].status, "completed");
    let next = runtime.jobs().unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].execution.node, "after");
}

#[test]
fn interrupted_mid_view_handoff_before_prepared_recovers_on_continue_after_restart() {
    let graph = Graph {
        original_goal: "recover interrupted workspace view handoff".into(),
        nodes: ["parent", "worker"]
            .into_iter()
            .map(|name| Node {
                name: name.into(),
                task: name.into(),
            })
            .collect(),
        edges: vec![Edge {
            from: "parent".into(),
            to: "worker".into(),
            feedback: false,
        }],
    };
    let (temp, source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let mut parent = runtime.jobs().unwrap().remove(0);
    attach(&mut runtime, &mut parent);
    let parent_path = PathBuf::from(&parent.execution.worktree);
    workspace::prepare(&source, &parent_path, &parent.execution.before, &[]).unwrap();
    fs::write(parent_path.join("parent.txt"), "from parent\n").unwrap();
    let parent_head = workspace::snapshot_node_for_run(
        &parent_path,
        &source,
        "parent",
        Some(&runtime.state.run_id),
    )
    .unwrap();
    runtime
        .finish(&parent.execution, Ok((parent_head, "completed".into())))
        .unwrap();

    let worker = runtime.jobs().unwrap().remove(0);
    let worker_path = PathBuf::from(&worker.execution.worktree);
    // Simulate a backend crash mid-handoff: project-ready and .git-config/global
    // were missing/incomplete while .git and half-modified files existed on disk,
    // and Prepared was never emitted.
    crate::workspace_view::clear_ready(&worker_path).unwrap();
    let global_cfg = crate::workspace_state::process_root(&worker_path)
        .unwrap()
        .join(".git-config/global");
    if global_cfg.exists() {
        fs::remove_file(&global_cfg).unwrap();
    }
    fs::write(worker_path.join("tracked.txt"), "half-prepared bytes").unwrap();

    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    assert!(runtime.state.can_resume_interrupted());
    runtime.pause(false).unwrap();

    let mut retry = runtime.jobs().unwrap().remove(0);
    assert!(
        retry.initial_recovery,
        "an unmanaged node that crashed before Prepared must use initial_recovery"
    );
    assert!(!retry.continuation);
    assert_eq!(retry.task, "worker");
    assert_eq!(retry.execution.worktree, worker.execution.worktree);
    local_agent(&mut retry, &temp);

    let result = perform(
        &retry,
        &root,
        &[],
        |_| {},
        |prepared| {
            runtime.emit(EventKind::Prepared {
                execution_id: retry.execution.id.clone(),
                head: prepared,
            })
        },
    );
    runtime.finish(&retry.execution, result.clone()).unwrap();
    result.expect("Continue must re-prepare the half-handed-off workspace instead of rejecting it");
    assert_eq!(runtime.state.nodes["worker"].status, "completed");
    assert_eq!(
        fs::read_to_string(worker_path.join("parent.txt")).unwrap(),
        "from parent\n"
    );
}

#[test]
fn interrupted_followup_before_session_fork_recovers_after_restart() {
    let graph = Graph {
        original_goal: "recover follow-up that crashed before session fork".into(),
        nodes: ["first", "second"]
            .into_iter()
            .map(|name| Node {
                name: name.into(),
                task: name.into(),
            })
            .collect(),
        edges: vec![Edge {
            from: "first".into(),
            to: "second".into(),
            feedback: false,
        }],
    };
    let (temp, source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let mut first = runtime.jobs().unwrap().remove(0);
    attach(&mut runtime, &mut first);
    let first_path = PathBuf::from(&first.execution.worktree);
    workspace::prepare(&source, &first_path, &first.execution.before, &[]).unwrap();
    let first_session_dir = runtime.root.join("sessions").join(&first.execution.id);
    fs::create_dir_all(&first_session_dir).unwrap();
    fs::write(
        first_session_dir.join(format!("test_{}.jsonl", first.execution.session_id)),
        format!(
            "{}\n{}\n",
            serde_json::json!({
                "type": "session",
                "version": 3,
                "id": first.execution.session_id,
                "cwd": crate::native::host_path(&first_path),
            }),
            serde_json::json!({
                "type": "message",
                "id": "m1",
                "parentId": null,
                "message": { "role": "user", "content": "first", "timestamp": 1 }
            })
        ),
    )
    .unwrap();
    let first_head = workspace::snapshot_node_for_run(
        &first_path,
        &source,
        "first",
        Some(&runtime.state.run_id),
    )
    .unwrap();
    runtime
        .finish(&first.execution, Ok((first_head, "completed".into())))
        .unwrap();

    let mut second = runtime.jobs().unwrap().remove(0);
    // Put `second` in its own terminal directory so a shared-terminal follow-up
    // on `first` must move workspaces and fork `first`'s session.
    second.execution.worktree = runtime
        .run_workspace_root()
        .join("second-terminal")
        .to_string_lossy()
        .into();
    let second_path = PathBuf::from(&second.execution.worktree);
    workspace::prepare(
        &source,
        &second_path,
        &second.execution.before,
        &second.parent_heads,
    )
    .unwrap();
    let second_head = workspace::snapshot_node_for_run(
        &second_path,
        &source,
        "second",
        Some(&runtime.state.run_id),
    )
    .unwrap();
    runtime
        .finish(&second.execution, Ok((second_head, "completed".into())))
        .unwrap();

    runtime
        .intervene("first", "follow up in shared terminal")
        .unwrap();
    let followup = runtime.jobs().unwrap().remove(0);
    assert!(
        followup.session_fork.is_some(),
        "moving to the terminal workspace requires a session fork"
    );
    // Simulate backend exit before `Prepared` and before `fork_session` wrote
    // the new JSONL session file.
    let root = runtime.root.clone();
    drop(runtime);

    let mut runtime = Runtime::open(&root).unwrap();
    assert!(runtime.state.can_resume_interrupted());
    runtime.pause(false).unwrap();
    let mut retry = runtime.jobs().unwrap().remove(0);
    assert!(!retry.continuation);
    assert_eq!(retry.task, "follow up in shared terminal");
    assert_eq!(
        retry.session_fork.as_ref().unwrap().id,
        first.execution.id,
        "Continue must fall back to the last completed session when the previous fork was never written"
    );
    local_agent(&mut retry, &temp);
    let result = perform(
        &retry,
        &root,
        &[],
        |_| {},
        |prepared| {
            runtime.emit(EventKind::Prepared {
                execution_id: retry.execution.id.clone(),
                head: prepared,
            })
        },
    );
    runtime.finish(&retry.execution, result.clone()).unwrap();
    result.expect("follow-up recovery must fork from the completed anchor session and succeed");
    assert_eq!(runtime.state.nodes["first"].status, "completed");
}
