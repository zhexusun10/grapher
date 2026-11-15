use super::*;

fn complete_first(runtime: &mut Runtime) -> Execution {
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0).execution;
    runtime
        .emit(EventKind::Finished {
            execution_id: first.id.clone(),
            head: runtime.state.base.clone(),
            output: String::new(),
            output_bytes: 0,
            metrics: None,
        })
        .unwrap();
    first
}

fn image(data: &str) -> ImageAttachment {
    ImageAttachment {
        r#type: "image".into(),
        mime_type: "image/png".into(),
        data: data.into(),
        name: Some(data.into()),
    }
}

fn record_input_history(runtime: &Runtime, execution: &Execution) {
    let directory = runtime.root.join("sessions").join(&execution.id);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(format!("test_{}.jsonl", execution.session_id)), format!("{}\n{}\n",
        serde_json::json!({"type":"session", "version":3, "id":execution.session_id, "cwd":execution.worktree}),
        serde_json::json!({"type":"message", "id":"opening", "parentId":null,
            "message":{"role":"user", "content":"retained history"}}))).unwrap();
}

fn reopen_input_runtime(runtime: Runtime) -> Runtime {
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    runtime.resume_scheduling().unwrap();
    runtime
}

fn existing_input_runtime(mode: &str) -> (TempDir, PathBuf, Runtime) {
    let (temp, source, mut runtime) = setup(true, single());
    if mode == "serial" { runtime.set_route("serial").unwrap(); }
    runtime.approve().unwrap();
    if mode == "shared" {
        runtime.emit(EventKind::WorkspaceIsolationSelected { isolated: false }).unwrap();
    }
    (temp, source, runtime)
}

/// Persist the same per-attempt launch and session evidence as a consumed turn.
/// Earlier attempts can have activity while a later bound input is still unread.
fn consume_input(runtime: &mut Runtime, job: &Job) {
    use std::io::Write;
    let path = Path::new(&job.execution.worktree);
    if !job.source_direct && !path.is_dir() {
        workspace::prepare(Path::new(&job.config.repository), path, &job.execution.before, &job.parent_heads).unwrap();
    }
    if let Some(anchor) = &job.session_fork {
        crate::session_branch::fork_session(
            &runtime.root.join("sessions").join(&anchor.id), &anchor.session_id, Path::new(&anchor.worktree),
            &runtime.root.join("sessions").join(&job.execution.id), &job.execution.session_id, path,
        ).unwrap();
    }
    let origin = job.resume_execution_id.as_deref().unwrap_or(&job.execution.id);
    let directory = runtime.root.join("sessions").join(origin);
    fs::create_dir_all(&directory).unwrap();
    let suffix = format!("_{}.jsonl", job.execution.session_id);
    let session = fs::read_dir(&directory).unwrap().map(|entry| entry.unwrap().path())
        .find(|path| path.file_name().unwrap().to_string_lossy().ends_with(&suffix))
        .unwrap_or_else(|| directory.join(format!("test{suffix}")));
    if !session.exists() {
        fs::write(&session, format!("{}\n", serde_json::json!({
            "type":"session", "version":3, "id":job.execution.session_id, "cwd":job.execution.worktree,
        }))).unwrap();
    }
    let mut content = vec![serde_json::json!({"type":"text", "text":job.task})];
    content.extend(job.images.iter().flatten().map(|image| serde_json::to_value(image).unwrap()));
    writeln!(fs::OpenOptions::new().append(true).open(session).unwrap(), "{}", serde_json::json!({
        "type":"message", "id":Uuid::new_v4().to_string(), "parentId":null,
        "message":{"role":"user", "content":content},
    })).unwrap();
    runtime.emit(EventKind::Prepared { execution_id: job.execution.id.clone(), head: job.execution.before.clone() }).unwrap();
    runtime.emit(EventKind::Output { execution_id: job.execution.id.clone(), text: "model already processed this turn".into() }).unwrap();
}

fn claimed(state: &Snapshot, execution_id: &str) -> Vec<i64> {
    state
        .events
        .iter()
        .find_map(|event| match &event.kind {
            EventKind::Started {
                execution,
                message_sequences,
                ..
            } if execution.id == execution_id => message_sequences.clone(),
            _ => None,
        })
        .unwrap()
}

#[test]
fn node_message_queue_unstarted_waits_for_dependencies_and_survives_restart() {
    let graph = Graph {
        original_goal: "queued input".into(),
        nodes: ["parent", "child"].into_iter().map(|name| Node {
            name: name.into(), task: format!("original {name}"),
        }).collect(),
        edges: vec![Edge { from: "parent".into(), to: "child".into(), feedback: false }],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    assert!(runtime.intervene("child", "before approval").is_err());
    runtime.approve().unwrap();
    runtime.pause(true).unwrap();
    let before = runtime.state.nodes["child"].clone();
    for text in ["first", "same", "same"] {
        runtime.intervene_with_images("child", text, Some(vec![image(text)])).unwrap();
    }
    let mut expected = before;
    expected.pending_messages = runtime.state.nodes["child"].pending_messages.clone();
    assert_eq!(serde_json::to_value(&runtime.state.nodes["child"]).unwrap(), serde_json::to_value(expected).unwrap());
    assert!(runtime.state.paused && runtime.state.executions.is_empty());
    assert!(runtime.jobs().unwrap().is_empty());
    for _ in 0..128 { runtime.emit(EventKind::Paused { paused: true }).unwrap(); }
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    assert_eq!(runtime.state.nodes["child"].pending_messages.len(), 3);
    runtime.pause(false).unwrap();
    let parent = runtime.jobs().unwrap().remove(0);
    assert_eq!(parent.execution.node, "parent");
    assert!(runtime.jobs().unwrap().is_empty(), "queued input cannot bypass a live parent");
    runtime.finish(&parent.execution, Ok((runtime.state.base.clone(), "done".into()))).unwrap();
    let child = runtime.jobs().unwrap().remove(0);
    assert_eq!(child.execution.node, "child");
    assert!(child.task.starts_with("original child"));
    assert!(child.task.find("first").unwrap() < child.task.find("same").unwrap());
    assert_eq!(child.task.matches("same").count(), 2);
    assert_eq!(child.images.as_ref().unwrap().iter().map(|image| image.data.as_str()).collect::<Vec<_>>(), ["first", "same", "same"]);
    assert!(child.resume_execution_id.is_none() && child.session_fork.is_none());
    assert_eq!(claimed(&runtime.state, &child.execution.id).len(), 3);
    assert!(runtime.state.nodes["child"].pending_messages.is_empty());
    assert!(runtime.jobs().unwrap().is_empty());
}

#[test]
fn node_message_queue_initial_input_survives_failure_before_pi_session() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    runtime.intervene_with_images("task", "extra input", Some(vec![image("extra")])).unwrap();
    let mut job = runtime.jobs().unwrap().remove(0);
    let expected = job.task.clone();
    for _ in 0..2 {
        runtime.finish(&job.execution, Err("failed before creating Pi session".into())).unwrap();
        runtime.resume_node("task").unwrap();
        job = runtime.jobs().unwrap().remove(0);
        assert_eq!(job.task, expected);
        assert_eq!(job.images.as_ref().unwrap()[0].data, "extra");
        assert!(job.initial_recovery);
    }
    runtime.finish(&job.execution, Err("startup failed again".into())).unwrap();
    runtime.resume_node("task").unwrap();
    runtime.intervene_with_images("task", "later input", Some(vec![image("later")])).unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.initial_recovery);
    assert!(retry.task.starts_with("self-contained task"));
    assert_eq!(retry.task.matches("extra input").count(), 1);
    assert_eq!(retry.task.matches("later input").count(), 1);
    assert_eq!(retry.images.as_ref().unwrap().iter().map(|image| image.data.as_str()).collect::<Vec<_>>(), ["extra", "later"]);
}

#[test]
fn node_input_recovery_source_followup_keeps_real_session_anchor_and_pending_input() {
    for fork_created in [false, true] {
        let (_temp, _source, mut runtime) = setup(true, single());
        let first = complete_first(&mut runtime);
        record_input_history(&runtime, &first);
        runtime.emit(EventKind::PublicationCompleted { head: runtime.state.base.clone() }).unwrap();
        runtime.intervene_with_images("task", "original follow-up", Some(vec![image("original")])).unwrap();
        let failed = runtime.jobs().unwrap().remove(0);
        assert!(failed.source_direct && failed.session_fork.is_some());
        if fork_created {
            let anchor = failed.session_fork.as_ref().unwrap();
            crate::session_branch::fork_session(
                &runtime.root.join("sessions").join(&anchor.id), &anchor.session_id, Path::new(&anchor.worktree),
                &runtime.root.join("sessions").join(&failed.execution.id), &failed.execution.session_id,
                Path::new(&failed.execution.worktree),
            ).unwrap();
        }
        runtime.finish(&failed.execution, Err("startup failed before Pi input".into())).unwrap();
        runtime = reopen_input_runtime(runtime);
        runtime.resume_node("task").unwrap();
        runtime.intervene_with_images("task", "extra queued constraint", Some(vec![image("extra")])).unwrap();
        let retry = runtime.jobs().unwrap().remove(0);
        if fork_created {
            assert!(retry.session_fork.is_none());
            assert_eq!(retry.resume_execution_id.as_deref(), Some(failed.execution.id.as_str()));
        } else {
            assert_eq!(retry.session_fork.as_ref().map(|fork| fork.id.as_str()), Some(first.id.as_str()));
        }
        assert!(retry.task.starts_with("original follow-up") && retry.task.contains("extra queued constraint"));
        assert_eq!(retry.images.as_ref().unwrap().iter().map(|image| image.data.as_str()).collect::<Vec<_>>(), ["original", "extra"]);
        assert!(retry.task.contains("attached images 2-2"));
        runtime.finish(&retry.execution, Err("startup failed again".into())).unwrap();
        runtime.resume_node("task").unwrap();
        let again = runtime.jobs().unwrap().remove(0);
        assert_eq!(again.task, retry.task);
        assert_eq!(serde_json::to_value(&again.images).unwrap(), serde_json::to_value(&retry.images).unwrap());
    }
}

#[test]
fn node_input_recovery_blocked_preparation_preserves_all_accepted_input() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    runtime.intervene("task", "first accepted constraint").unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    runtime.finish(&first.execution, Err("Workspace composition failed: temporary error".into())).unwrap();
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.nodes["task"].status, "blocked");
    runtime.intervene("task", "second accepted constraint").unwrap();
    // Exercise passive queue classification from checkpoint + event replay.
    for _ in 0..128 { runtime.emit(EventKind::Paused { paused: true }).unwrap(); }
    runtime = reopen_input_runtime(runtime);
    runtime.resume_node("task").unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.task.contains("first accepted constraint") && retry.task.contains("second accepted constraint"));
    assert_eq!(retry.execution.session_id, first.execution.session_id);
    assert_eq!(retry.resume_execution_id.as_deref(), Some(first.execution.id.as_str()));
    assert!(!runtime.state.superseded_execution_ids.contains(&first.execution.id));
}

#[test]
fn node_input_recovery_mixed_messages_preserve_fifo_images_and_identical_turns() {
    for legacy in [false, true] {
        let (_temp, _source, mut runtime) = setup(true, single());
        runtime.approve().unwrap();
        runtime.intervene_with_images("task", "first queued constraint", Some(vec![image("first")])).unwrap();
        let first = runtime.jobs().unwrap().remove(0);
        runtime.finish(&first.execution, Err("startup failed before Pi".into())).unwrap();
        runtime.intervene_with_images("task", "second followup constraint", Some(vec![image("second")])).unwrap();
        let second = runtime.jobs().unwrap().remove(0);
        assert!(second.task.find("first queued constraint").unwrap() < second.task.find("second followup constraint").unwrap());
        assert_eq!(second.images.as_ref().unwrap().len(), 2);
        runtime.finish(&second.execution, Err("startup failed again before Pi".into())).unwrap();
        runtime = reopen_input_runtime(runtime);
        if legacy {
            // Historical starts had claims, but no complete bound input.
            runtime.state.events.retain(|event| !matches!(event.kind, EventKind::NodeInputBound { .. }));
        }
        runtime.resume_node("task").unwrap();
        runtime.intervene_with_images("task", "second followup constraint", Some(vec![image("third")])).unwrap();
        let retry = runtime.jobs().unwrap().remove(0);
        assert_eq!(retry.images.as_ref().unwrap().iter().map(|image| image.data.as_str()).collect::<Vec<_>>(), ["first", "second", "third"]);
        assert!(retry.task.find("first queued constraint").unwrap() < retry.task.find("second followup constraint").unwrap());
        assert_eq!(retry.task.matches("second followup constraint").count(), 2, "equal messages remain distinct by sequence");
        assert!(retry.task.contains("attached images 3-3"));
    }
}

#[test]
fn node_input_recovery_pending_history_edit_keeps_images_with_passive_input() {
    for extra_image in [false, true] {
        let (_temp, _source, mut runtime) = setup(true, single());
        runtime.approve().unwrap();
        let first = runtime.jobs().unwrap().remove(0);
        runtime.finish(&first.execution, Err("startup failed before Pi".into())).unwrap();
        runtime.edit_node_message("task", &first.execution.id, "self-contained task", "edited task",
            Some(vec![image("edit")])).unwrap();
        runtime.intervene_with_images("task", "extra queued constraint", extra_image.then(|| vec![image("extra")])).unwrap();
        let next = runtime.jobs().unwrap().remove(0);
        assert!(next.task.contains("edited task") && next.task.contains("extra queued constraint"));
        let expected = if extra_image { vec!["edit", "extra"] } else { vec!["edit"] };
        assert_eq!(next.images.as_ref().unwrap().iter().map(|image| image.data.as_str()).collect::<Vec<_>>(), expected);
        if extra_image { assert!(next.task.contains("attached images 2-2")); }
        runtime.finish(&next.execution, Err("failed before edited input".into())).unwrap();
        runtime = reopen_input_runtime(runtime);
        runtime.resume_node("task").unwrap();
        let retry = runtime.jobs().unwrap().remove(0);
        assert_eq!(retry.task, next.task);
        assert_eq!(serde_json::to_value(&retry.images).unwrap(), serde_json::to_value(&next.images).unwrap());
    }
}

#[test]
fn node_input_recovery_does_not_replay_consumed_bound_input() {
    let (_temp, _source, mut runtime) = setup(true, single());
    runtime.approve().unwrap();
    runtime.intervene_with_images("task", "already delivered", Some(vec![image("old")])).unwrap();
    let first = runtime.jobs().unwrap().remove(0);
    record_input_history(&runtime, &first.execution);
    runtime.emit(EventKind::Prepared { execution_id: first.execution.id.clone(), head: first.execution.before.clone() }).unwrap();
    runtime.emit(EventKind::Output { execution_id: first.execution.id.clone(), text: "model already acted".into() }).unwrap();
    runtime.finish(&first.execution, Err("provider failure after input".into())).unwrap();
    runtime = reopen_input_runtime(runtime);
    runtime.resume_node("task").unwrap();
    runtime.intervene_with_images("task", "new constraint", Some(vec![image("new")])).unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.task, "new constraint");
    assert_eq!(retry.images.as_ref().unwrap().iter().map(|image| image.data.as_str()).collect::<Vec<_>>(), ["new"]);
    assert_eq!(retry.execution.session_id, first.execution.session_id);
    assert!(!retry.initial_recovery);
}

#[test]
fn node_input_recovery_existing_session_keeps_unstarted_passive_turn() {
    for mode in ["serial", "shared", "private"] {
        for append_followup in [false, true] {
            let (_temp, _source, mut runtime) = existing_input_runtime(mode);
            let first = runtime.jobs().unwrap().remove(0);
            consume_input(&mut runtime, &first);
            runtime.finish(&first.execution, Err("provider failure after model activity".into())).unwrap();
            runtime.resume_node("task").unwrap();
            runtime.intervene_with_images("task", "new queued requirement", Some(vec![image("new")])).unwrap();
            let mut pending = runtime.jobs().unwrap().remove(0);
            assert_eq!(pending.task, "new queued requirement");
            for cycle in 0..2 {
                // No Prepared for THIS attempt: the older session/activity is
                // not evidence that this queued turn reached Pi.
                runtime.finish(&pending.execution, Err("startup failure before sending the queued turn".into())).unwrap();
                assert!(runtime.state.execution_is_preparation_only(runtime.state.executions.last().unwrap()));
                runtime = reopen_input_runtime(runtime);
                if append_followup && cycle == 0 {
                    runtime.intervene_with_images("task", "one more requirement", Some(vec![image("extra")])).unwrap();
                } else {
                    runtime.resume_node("task").unwrap();
                }
                let retry = runtime.jobs().unwrap().remove(0);
                assert!(!retry.continuation && !retry.initial_recovery, "{mode}: resend only this unread turn");
                assert_eq!(retry.execution.session_id, first.execution.session_id);
                assert!(!retry.task.contains("self-contained task"));
                assert_eq!(retry.task.matches("new queued requirement").count(), 1);
                if append_followup && cycle == 0 {
                    assert!(retry.task.find("new queued requirement").unwrap() < retry.task.find("one more requirement").unwrap());
                    assert!(retry.task.contains("attached images 2-2"));
                } else {
                    assert_eq!(retry.task, pending.task);
                }
                let expected = if append_followup { vec!["new", "extra"] } else { vec!["new"] };
                assert_eq!(retry.images.as_ref().unwrap().iter().map(|image| image.data.as_str()).collect::<Vec<_>>(), expected);
                pending = retry;
            }
            consume_input(&mut runtime, &pending);
            runtime.finish(&pending.execution, Err("provider failure after queued input was consumed".into())).unwrap();
            runtime.resume_node("task").unwrap();
            let continued = runtime.jobs().unwrap().remove(0);
            assert!(continued.continuation && continued.task.is_empty(), "a consumed binding must not be replayed");
            assert!(continued.images.is_none());
        }
    }
}

#[test]
fn node_input_recovery_existing_session_does_not_prepend_consumed_directive() {
    for mode in ["serial", "shared", "private"] {
        for equal_text in [false, true] {
            let (_temp, _source, mut runtime) = existing_input_runtime(mode);
            let first = runtime.jobs().unwrap().remove(0);
            consume_input(&mut runtime, &first);
            let head = if first.source_direct || mode == "serial" { String::new() } else { runtime.state.base.clone() };
            runtime.finish(&first.execution, Ok((head, "initial task completed".into()))).unwrap();
            runtime.intervene_with_images("task", "old follow-up already acted on", Some(vec![image("old")])).unwrap();
            let followup = runtime.jobs().unwrap().remove(0);
            consume_input(&mut runtime, &followup);
            runtime.finish(&followup.execution, Err("provider failed after acting on the follow-up".into())).unwrap();
            runtime = reopen_input_runtime(runtime);
            runtime.resume_node("task").unwrap();
            let new_text = if equal_text { "old follow-up already acted on" } else { "new requirement only" };
            runtime.intervene_with_images("task", new_text, Some(vec![image("new")])).unwrap();
            let retry = runtime.jobs().unwrap().remove(0);
            assert_eq!(retry.task, new_text, "{mode}: dispatched directives are not new user requests");
            assert_eq!(retry.images.as_ref().unwrap().iter().map(|image| image.data.as_str()).collect::<Vec<_>>(), ["new"]);
            assert_eq!(retry.execution.session_id, followup.execution.session_id);
            runtime.finish(&retry.execution, Err("preparation failed before the new input".into())).unwrap();
            runtime = reopen_input_runtime(runtime);
            runtime.resume_node("task").unwrap();
            let again = runtime.jobs().unwrap().remove(0);
            assert_eq!(again.task, new_text);
            assert_eq!(again.images.as_ref().unwrap().iter().map(|image| image.data.as_str()).collect::<Vec<_>>(), ["new"]);
        }
    }
}

#[test]
fn node_message_queue_blocked_input_does_not_retry_failed_dependencies() {
    let graph = Graph {
        original_goal: "blocked input".into(),
        nodes: ["parent", "child"].into_iter().map(|name| Node { name: name.into(), task: name.into() }).collect(),
        edges: vec![Edge { from: "parent".into(), to: "child".into(), feedback: false }],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let parent = runtime.jobs().unwrap().remove(0);
    runtime.finish(&parent.execution, Err("provider failed".into())).unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.nodes["child"].status, "blocked");
    runtime.intervene("child", "when ready").unwrap();
    assert_eq!(runtime.state.nodes["parent"].status, "failed");
    assert_eq!(runtime.state.nodes["child"].status, "blocked");
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.executions.len(), 1);
}

#[test]
fn node_message_queue_batches_fifo_text_images_and_identical_turns() {
    for route in ["serial", "graph"] {
        let (_temp, _source, mut runtime) = setup(true, single());
        runtime.set_route(route).unwrap();
        let first = complete_first(&mut runtime);
        runtime.pause(true).unwrap();
        let texts = [
            "first\n<file path=\"notes.txt\">附件内容🚀</file>",
            "same",
            "same",
            "last",
        ];
        for (index, text) in texts.iter().enumerate() {
            runtime
                .intervene_with_images("task", text, Some(vec![image(&index.to_string())]))
                .unwrap();
        }
        let queue = &runtime.state.nodes["task"].pending_messages;
        assert_eq!(queue.len(), texts.len());
        let sequences = queue
            .iter()
            .map(|message| message.sequence)
            .collect::<Vec<_>>();
        assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(
            runtime.state.nodes["task"].instruction, texts[0],
            "later turns cannot overwrite the first pending instruction"
        );
        assert!(runtime.jobs().unwrap().is_empty());
        runtime.pause(false).unwrap();
        let job = runtime.jobs().unwrap().remove(0);
        assert_eq!(job.execution.session_id, first.session_id);
        let mut previous_end = 0;
        for text in texts {
            let position = job.task[previous_end..].find(text).unwrap() + previous_end;
            previous_end = position + text.len();
        }
        assert_eq!(job.task.matches("[User message ").count(), 4);
        assert_eq!(
            job.images
                .unwrap()
                .iter()
                .map(|image| image.data.as_str())
                .collect::<Vec<_>>(),
            ["0", "1", "2", "3"]
        );
        assert_eq!(claimed(&runtime.state, &job.execution.id), sequences);
        assert!(runtime.state.nodes["task"].pending_messages.is_empty());
        assert!(
            runtime.store.load(&runtime.state.run_id).unwrap().nodes["task"]
                .pending_messages
                .is_empty()
        );
        assert!(
            runtime.jobs().unwrap().is_empty(),
            "the batch has exactly one live writer"
        );
    }
}

#[test]
fn node_message_queue_survives_checkpoint_restart_and_claims_exactly_once() {
    let (_temp, _source, mut runtime) = setup(true, single());
    complete_first(&mut runtime);
    runtime.pause(true).unwrap();
    for text in ["before checkpoint", "after checkpoint"] {
        runtime
            .intervene_with_images("task", text, Some(vec![image(text)]))
            .unwrap();
        // Exercise a real projection checkpoint while the queue is pending.
        for _ in 0..128 {
            runtime.emit(EventKind::Paused { paused: true }).unwrap();
        }
    }
    let sequences = runtime.state.nodes["task"]
        .pending_messages
        .iter()
        .map(|message| message.sequence)
        .collect::<Vec<_>>();
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    assert!(runtime.state.paused);
    assert_eq!(runtime.state.nodes["task"].pending_messages.len(), 2);
    runtime.pause(false).unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    assert!(job.task.contains("before checkpoint") && job.task.contains("after checkpoint"));
    assert_eq!(job.images.as_ref().unwrap().len(), 2);
    assert_eq!(claimed(&runtime.state, &job.execution.id), sequences);
    let replayed = runtime.store.load(&runtime.state.run_id).unwrap();
    assert!(replayed.nodes["task"].pending_messages.is_empty());
    assert_eq!(claimed(&replayed, &job.execution.id), sequences);
    runtime
        .finish(
            &job.execution,
            Ok((runtime.state.base.clone(), "completed".into())),
        )
        .unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(
        runtime.state.executions.len(),
        2,
        "a completed claim is never replayed as another user turn"
    );
}

#[test]
fn node_message_queue_legacy_checkpoint_rebuilds_pending_turns_without_rewriting_events() {
    let (_temp, _source, mut runtime) = setup(true, single());
    complete_first(&mut runtime);
    runtime.pause(true).unwrap();
    runtime.intervene("task", "legacy first").unwrap();
    runtime.intervene("task", "legacy second").unwrap();
    let mut projection = crate::snapshot_view::checkpoint_projection(&runtime.state);
    projection
        .as_object_mut()
        .unwrap()
        .remove("nodeMessageQueueVersion");
    projection["nodes"]["task"]
        .as_object_mut()
        .unwrap()
        .remove("pendingMessages");
    let db = rusqlite::Connection::open(runtime.root.join("events.sqlite")).unwrap();
    db.execute(
        "INSERT OR REPLACE INTO checkpoints(run_id,sequence,payload) VALUES(?1,?2,?3)",
        rusqlite::params![
            runtime.state.run_id,
            runtime.state.events.last().unwrap().sequence,
            projection.to_string()
        ],
    )
    .unwrap();
    let replayed = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(replayed.nodes["task"].pending_messages.len(), 2);
    assert_eq!(replayed.events.len(), runtime.state.events.len());
}

#[test]
fn node_message_queue_waits_for_capacity_without_cross_node_claims() {
    let graph = Graph {
        original_goal: "capacity".into(),
        nodes: ["task", "other"]
            .into_iter()
            .map(|name| Node {
                name: name.into(),
                task: name.into(),
            })
            .collect(),
        edges: vec![],
    };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    let task = jobs
        .iter()
        .find(|job| job.execution.node == "task")
        .unwrap();
    let other = jobs
        .iter()
        .find(|job| job.execution.node == "other")
        .unwrap();
    runtime
        .finish(
            &task.execution,
            Ok((runtime.state.base.clone(), "completed".into())),
        )
        .unwrap();
    runtime.state.config.as_mut().unwrap().max_parallel = 1;
    runtime.intervene("task", "first waiting turn").unwrap();
    runtime.intervene("task", "second waiting turn").unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.nodes["task"].pending_messages.len(), 2);
    assert!(runtime.state.nodes["other"].pending_messages.is_empty());
    runtime
        .finish(
            &other.execution,
            Ok((runtime.state.base.clone(), "completed".into())),
        )
        .unwrap();
    let next = runtime.jobs().unwrap().remove(0);
    assert_eq!(next.execution.node, "task");
    assert!(next.task.contains("first waiting turn") && next.task.contains("second waiting turn"));
    assert_eq!(claimed(&runtime.state, &next.execution.id).len(), 2);
}

#[test]
fn node_message_queue_post_publication_keeps_source_direct_mode_across_restart() {
    let (_temp, source, mut runtime) = setup(true, single());
    complete_first(&mut runtime);
    runtime
        .emit(EventKind::PublicationCompleted {
            head: runtime.state.base.clone(),
        })
        .unwrap();
    runtime.intervene("task", "source first").unwrap();
    runtime.intervene("task", "source second").unwrap();
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    runtime.pause(false).unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    assert!(job.source_direct);
    assert_eq!(Path::new(&job.execution.worktree), source);
    assert!(job.task.contains("source first") && job.task.contains("source second"));
    assert_eq!(runtime.state.phase, "followup");
}

#[test]
fn node_message_queue_claim_failure_keeps_all_pending_turns() {
    let (_temp, _source, mut runtime) = setup(true, single());
    complete_first(&mut runtime);
    runtime.intervene("task", "first").unwrap();
    runtime.intervene("task", "second").unwrap();
    let bound_inputs = runtime.state.events.iter().filter(|event| matches!(event.kind, EventKind::NodeInputBound { .. })).count();
    let db = rusqlite::Connection::open(runtime.root.join("events.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_claim BEFORE INSERT ON events WHEN NEW.kind='started' BEGIN SELECT RAISE(ABORT,'claim failed'); END;").unwrap();
    assert!(runtime.jobs().is_err());
    assert_eq!(runtime.state.nodes["task"].pending_messages.len(), 2);
    assert_eq!(runtime.state.executions.len(), 1);
    for state in [&runtime.state, &runtime.store.load(&runtime.state.run_id).unwrap()] {
        assert_eq!(state.events.iter().filter(|event| matches!(event.kind, EventKind::NodeInputBound { .. })).count(), bound_inputs,
            "input binding and the rejected Started claim must roll back together");
    }
    assert_eq!(
        runtime.store.load(&runtime.state.run_id).unwrap().nodes["task"]
            .pending_messages
            .len(),
        2
    );
    db.execute_batch("DROP TRIGGER reject_claim;").unwrap();
    let next = runtime.jobs().unwrap().remove(0);
    assert_eq!(claimed(&runtime.state, &next.execution.id).len(), 2);
}
