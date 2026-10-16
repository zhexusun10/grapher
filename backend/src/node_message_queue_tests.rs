use super::*;

fn complete_first(runtime: &mut Runtime) -> Execution {
    runtime.approve().unwrap();
    let first = runtime.jobs().unwrap().remove(0).execution;
    runtime.emit(EventKind::Finished {
        execution_id: first.id.clone(), head: runtime.state.base.clone(), output: String::new(),
        output_bytes: 0, metrics: None,
    }).unwrap();
    first
}

fn image(data: &str) -> ImageAttachment {
    ImageAttachment { r#type: "image".into(), mime_type: "image/png".into(), data: data.into(), name: Some(data.into()) }
}

fn claimed(state: &Snapshot, execution_id: &str) -> Vec<i64> {
    state.events.iter().find_map(|event| match &event.kind {
        EventKind::Started { execution, message_sequences } if execution.id == execution_id => message_sequences.clone(),
        _ => None,
    }).unwrap()
}

#[test]
fn node_message_queue_batches_fifo_text_images_and_identical_turns() {
    for route in ["serial", "graph"] {
        let (_temp, _source, mut runtime) = setup(true, single());
        runtime.set_route(route).unwrap();
        let first = complete_first(&mut runtime);
        runtime.pause(true).unwrap();
        let texts = ["first\n<file path=\"notes.txt\">附件内容🚀</file>", "same", "same", "last"];
        for (index, text) in texts.iter().enumerate() {
            runtime.intervene_with_images("task", text, Some(vec![image(&index.to_string())])).unwrap();
        }
        let queue = &runtime.state.nodes["task"].pending_messages;
        assert_eq!(queue.len(), texts.len());
        let sequences = queue.iter().map(|message| message.sequence).collect::<Vec<_>>();
        assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(runtime.state.nodes["task"].instruction, texts[0], "later turns cannot overwrite the first pending instruction");
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
        assert_eq!(job.images.unwrap().iter().map(|image| image.data.as_str()).collect::<Vec<_>>(), ["0", "1", "2", "3"]);
        assert_eq!(claimed(&runtime.state, &job.execution.id), sequences);
        assert!(runtime.state.nodes["task"].pending_messages.is_empty());
        assert!(runtime.store.load(&runtime.state.run_id).unwrap().nodes["task"].pending_messages.is_empty());
        assert!(runtime.jobs().unwrap().is_empty(), "the batch has exactly one live writer");
    }
}

#[test]
fn node_message_queue_survives_checkpoint_restart_and_claims_exactly_once() {
    let (_temp, _source, mut runtime) = setup(true, single());
    complete_first(&mut runtime);
    runtime.pause(true).unwrap();
    for text in ["before checkpoint", "after checkpoint"] {
        runtime.intervene_with_images("task", text, Some(vec![image(text)])).unwrap();
        // Exercise a real projection checkpoint while the queue is pending.
        for _ in 0..128 { runtime.emit(EventKind::Paused { paused: true }).unwrap(); }
    }
    let sequences = runtime.state.nodes["task"].pending_messages.iter().map(|message| message.sequence).collect::<Vec<_>>();
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
    runtime.finish(&job.execution, Ok((runtime.state.base.clone(), "done".into()))).unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.executions.len(), 2, "a completed claim is never replayed as another user turn");
}

#[test]
fn node_message_queue_legacy_checkpoint_rebuilds_pending_turns_without_rewriting_events() {
    let (_temp, _source, mut runtime) = setup(true, single());
    complete_first(&mut runtime);
    runtime.pause(true).unwrap();
    runtime.intervene("task", "legacy first").unwrap();
    runtime.intervene("task", "legacy second").unwrap();
    let mut projection = crate::snapshot_view::checkpoint_projection(&runtime.state);
    projection.as_object_mut().unwrap().remove("nodeMessageQueueVersion");
    projection["nodes"]["task"].as_object_mut().unwrap().remove("pendingMessages");
    let db = rusqlite::Connection::open(runtime.root.join("events.sqlite")).unwrap();
    db.execute("INSERT OR REPLACE INTO checkpoints(run_id,sequence,payload) VALUES(?1,?2,?3)",
        rusqlite::params![runtime.state.run_id, runtime.state.events.last().unwrap().sequence, projection.to_string()]).unwrap();
    let replayed = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(replayed.nodes["task"].pending_messages.len(), 2);
    assert_eq!(replayed.events.len(), runtime.state.events.len());
}

#[test]
fn node_message_queue_waits_for_capacity_without_cross_node_claims() {
    let graph = Graph { original_goal: "capacity".into(), nodes: ["task", "other"].into_iter()
        .map(|name| Node { name: name.into(), task: name.into() }).collect(), edges: vec![] };
    let (_temp, _source, mut runtime) = setup(true, graph);
    runtime.approve().unwrap();
    let jobs = runtime.jobs().unwrap();
    let task = jobs.iter().find(|job| job.execution.node == "task").unwrap();
    let other = jobs.iter().find(|job| job.execution.node == "other").unwrap();
    runtime.finish(&task.execution, Ok((runtime.state.base.clone(), "done".into()))).unwrap();
    runtime.state.config.as_mut().unwrap().max_parallel = 1;
    runtime.intervene("task", "first waiting turn").unwrap();
    runtime.intervene("task", "second waiting turn").unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.nodes["task"].pending_messages.len(), 2);
    assert!(runtime.state.nodes["other"].pending_messages.is_empty());
    runtime.finish(&other.execution, Ok((runtime.state.base.clone(), "done".into()))).unwrap();
    let next = runtime.jobs().unwrap().remove(0);
    assert_eq!(next.execution.node, "task");
    assert!(next.task.contains("first waiting turn") && next.task.contains("second waiting turn"));
    assert_eq!(claimed(&runtime.state, &next.execution.id).len(), 2);
}

#[test]
fn node_message_queue_post_publication_keeps_source_direct_mode_across_restart() {
    let (_temp, source, mut runtime) = setup(true, single());
    complete_first(&mut runtime);
    runtime.emit(EventKind::PublicationCompleted { head: runtime.state.base.clone() }).unwrap();
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
    let db = rusqlite::Connection::open(runtime.root.join("events.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_claim BEFORE INSERT ON events WHEN NEW.kind='started' BEGIN SELECT RAISE(ABORT,'claim failed'); END;").unwrap();
    assert!(runtime.jobs().is_err());
    assert_eq!(runtime.state.nodes["task"].pending_messages.len(), 2);
    assert_eq!(runtime.state.executions.len(), 1);
    assert_eq!(runtime.store.load(&runtime.state.run_id).unwrap().nodes["task"].pending_messages.len(), 2);
    db.execute_batch("DROP TRIGGER reject_claim;").unwrap();
    let next = runtime.jobs().unwrap().remove(0);
    assert_eq!(claimed(&runtime.state, &next.execution.id).len(), 2);
}
