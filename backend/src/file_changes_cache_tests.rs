use super::*;
use std::cell::Cell;

const READ_ONLY: &str = "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"review only\"}]}}\n";
const WRITE: &str = "{\"type\":\"tool_execution_start\",\"toolCallId\":\"write\",\"toolName\":\"write\",\"args\":{\"path\":\"new.ts\",\"content\":\"hello\"}}\n{\"type\":\"tool_execution_end\",\"toolCallId\":\"write\",\"toolName\":\"write\",\"isError\":false}\n";

fn execution(bytes: usize, running: bool) -> Execution {
    Execution {
        id: uuid::Uuid::new_v4().to_string(), node: "worker".into(), revision: 1, attempt: 1,
        session_id: "session".into(), worktree: "/repo".into(), before: String::new(),
        workspace_lineage: vec![], after: None, input: None, result: None,
        status: if running { "running" } else { "completed" }.into(), output: String::new(),
        output_bytes: bytes, pid: None, started_at: 1, completed_at: None, metrics: None,
    }
}

fn snapshot_token(run: &str, exec: &Execution) -> CacheToken {
    let state = Snapshot { run_id: run.into(), executions: vec![exec.clone()], ..Default::default() };
    capture_warm_fence(&state, None).unwrap().logs[&exec.id]
}

// Sequential tests capture their fence at the snapshot boundary. Race tests
// retain an earlier token explicitly and call the production helper directly.
fn warm_execution_log(run: &str, exec: &Execution, repository: &str,
    read: impl FnOnce(usize) -> Result<String, String>) {
    super::warm_execution_log(run, exec, repository, snapshot_token(run, exec), read);
}

#[test]
fn unchanged_empty_logs_are_parsed_once_but_new_bytes_and_status_revalidate() {
    let run = uuid::Uuid::new_v4().to_string();
    let reads = Cell::new(0);
    let mut exec = execution(READ_ONLY.len(), true);
    let read = |bytes| {
        reads.set(reads.get() + 1);
        assert_eq!(bytes, READ_ONLY.len());
        Ok(READ_ONLY.to_string())
    };
    warm_execution_log(&run, &exec, "/repo", read);
    warm_execution_log(&run, &exec, "/repo", read);
    assert_eq!(reads.get(), 1, "an authoritative empty parse must be a cache hit");
    assert!(get_cached_execution_changes(&run, &exec).is_none());
    exec.status = "completed".into();
    warm_execution_log(&run, &exec, "/repo", read);
    assert_eq!(reads.get(), 2, "terminal status changes invalidate the live parse");
    warm_execution_log(&run, &exec, "/repo", read);
    assert_eq!(reads.get(), 2);
    let changed = format!("{READ_ONLY}{WRITE}");
    exec.output_bytes = changed.len();
    warm_execution_log(&run, &exec, "/repo", |_| {
        reads.set(reads.get() + 1);
        Ok(changed)
    });
    assert_eq!(reads.get(), 3);
    assert_eq!(get_cached_execution_changes(&run, &exec).unwrap().files[0].path, "new.ts");
    invalidate_run(&run);
}

#[test]
fn known_read_only_appends_advance_the_cursor_without_parsing_history() {
    let run = uuid::Uuid::new_v4().to_string();
    let mut exec = execution(READ_ONLY.len(), true);
    warm_execution_log(&run, &exec, "/repo", |_| Ok(READ_ONLY.into()));
    exec.output_bytes *= 2;
    note_read_only_log_append(&run, &exec.id, exec.output_bytes, true);
    warm_execution_log(&run, &exec, "/repo", |_| panic!("assistant-only appends do not require a full read"));
    update_from_log_chunk(&run, &exec.id, "worker", "/repo", "/repo", WRITE, true);
    assert_eq!(get_cached_execution_changes(&run, &exec).unwrap().total_files, 1);
    invalidate_run(&run);
}

#[test]
fn failed_or_partial_reads_do_not_poison_the_empty_cache() {
    let run = uuid::Uuid::new_v4().to_string();
    let exec = execution(READ_ONLY.len(), false);
    warm_execution_log(&run, &exec, "/repo", |_| Err("temporary read failure".into()));
    warm_execution_log(&run, &exec, "/repo", |_| Ok("partial".into()));
    let reads = Cell::new(0);
    for _ in 0..2 {
        warm_execution_log(&run, &exec, "/repo", |_| {
            reads.set(reads.get() + 1);
            Ok(READ_ONLY.into())
        });
    }
    assert_eq!(reads.get(), 1, "a successful retry is cached, earlier failures are not");
    invalidate_run(&run);
}

#[test]
fn cold_parses_cannot_overwrite_live_output_or_terminal_settlement() {
    let run = uuid::Uuid::new_v4().to_string();
    let exec = execution(READ_ONLY.len(), true);
    warm_execution_log(&run, &exec, "/repo", |_| {
        update_from_log_chunk(&run, &exec.id, "worker", "/repo", "/repo", WRITE, true);
        Ok(READ_ONLY.into())
    });
    assert_eq!(get_cached_execution_changes(&run, &exec).unwrap().total_files, 1);
    invalidate_run(&run);

    let pending = WRITE.lines().next().unwrap().to_string() + "\n";
    let exec = execution(pending.len(), true);
    warm_execution_log(&run, &exec, "/repo", |_| {
        // The worker finishes while a reader still has its running snapshot.
        settle(&run, &exec.id);
        Ok(pending)
    });
    assert!(get_cached_execution_changes(&run, &exec).is_none(), "stale pending writes must not reappear");
    invalidate_run(&run);
}

#[test]
fn invalidation_fences_its_own_readers_without_discarding_other_runs() {
    let run = uuid::Uuid::new_v4().to_string();
    let other = uuid::Uuid::new_v4().to_string();
    let exec = execution(WRITE.len(), false);
    warm_execution_log(&run, &exec, "/repo", |_| {
        invalidate_run(&run);
        Ok(WRITE.into())
    });
    assert!(get_cached_execution_changes(&run, &exec).is_none());
    warm_execution_log(&run, &exec, "/repo", |_| {
        invalidate_run(&other);
        Ok(WRITE.into())
    });
    assert_eq!(get_cached_execution_changes(&run, &exec).unwrap().total_files, 1);
    invalidate_run(&run);
}

#[test]
fn an_empty_warm_does_not_hide_later_live_tool_changes() {
    let run = uuid::Uuid::new_v4().to_string();
    let exec = execution(READ_ONLY.len(), true);
    warm_execution_log(&run, &exec, "/repo", |_| Ok(READ_ONLY.into()));
    update_from_log_chunk(&run, &exec.id, "worker", "/repo", "/repo", WRITE, true);
    assert_eq!(get_cached_execution_changes(&run, &exec).unwrap().total_files, 1);
    settle(&run, &exec.id);
    assert!(!get_cached_execution_changes(&run, &exec).unwrap().is_running);
    invalidate_run(&run);
}

#[test]
fn scoped_warming_skips_other_executions_and_reader_cannot_write() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.sqlite");
    let store = crate::store::Store::open(&path).unwrap();
    let run = uuid::Uuid::new_v4().to_string();
    let first = execution(0, false);
    let second = execution(0, false);
    let mut state = Snapshot { run_id: run.clone(), executions: vec![first.clone(), second.clone()], ..Default::default() };
    for exec in [&first, &second] {
        store.append(&mut state, crate::model::EventKind::Output {
            execution_id: exec.id.clone(), text: READ_ONLY.into(),
        }).unwrap();
    }
    let reader = crate::store::Store::open_reader(&path).unwrap();
    let scope = Some(std::slice::from_ref(&first.id));
    let fence = capture_warm_fence(&state, scope).unwrap();
    warm_scoped_changes(&state, &reader, None, scope, &fence);
    {
        let guard = cache().lock().unwrap();
        assert_eq!(guard.log_state[&(run.clone(), first.id.clone())].scanned, Some((READ_ONLY.len(), false)));
        assert!(!guard.log_state.contains_key(&(run.clone(), second.id.clone())), "a scoped read must not warm unrelated history");
    }
    let fence = capture_warm_fence(&state, Some(&[])).unwrap();
    warm_scoped_changes(&state, &reader, None, Some(&[]), &fence);
    assert!(!cache().lock().unwrap().log_state.contains_key(&(run.clone(), second.id.clone())));
    let before = reader.log_bytes(&run, &first.id).unwrap();
    assert!(reader.append(&mut state, crate::model::EventKind::Output {
        execution_id: first.id.clone(), text: "cannot write".into(),
    }).is_err());
    assert_eq!(reader.log_bytes(&run, &first.id).unwrap(), before);
    invalidate_run(&run);
}

#[test]
fn stale_running_snapshot_cannot_replace_a_newer_terminal_empty_result() {
    let run = uuid::Uuid::new_v4().to_string();
    let pending = WRITE.lines().next().unwrap().to_string() + "\n";
    let stale = execution(pending.len(), true);
    let token = snapshot_token(&run, &stale);
    let closed = format!("{pending}{{\"type\":\"tool_execution_end\",\"toolCallId\":\"write\",\"toolName\":\"write\",\"isError\":true}}\n{{\"type\":\"grapher_process_exited\"}}\n");
    let mut terminal = stale.clone();
    terminal.status = "failed".into();
    terminal.output_bytes = closed.len();
    warm_execution_log(&run, &terminal, "/repo", |_| Ok(closed.clone()));
    super::warm_execution_log(&run, &stale, "/repo", token, |_| panic!("stale snapshot must be rejected before I/O"));
    warm_execution_log(&run, &terminal, "/repo", |_| Ok(closed));
    assert!(get_cached_execution_changes(&run, &terminal).is_none(), "a failed write cannot reappear in the final summary");
    invalidate_run(&run);
}

#[test]
fn settlement_before_cold_io_invalidates_the_snapshot_fence() {
    let run = uuid::Uuid::new_v4().to_string();
    let pending = WRITE.lines().next().unwrap().to_string() + "\n";
    let exec = execution(pending.len(), true);
    update_from_log_chunk(&run, &exec.id, "worker", "/repo", "/repo", &pending, true);
    let token = snapshot_token(&run, &exec);
    settle(&run, &exec.id);
    super::warm_execution_log(&run, &exec, "/repo", token, |_| panic!("settled writer has superseded this snapshot"));
    assert!(get_cached_execution_changes(&run, &exec).is_none());
    invalidate_run(&run);
}

#[test]
fn snapshot_fence_preserves_reads_that_arrived_before_cold_io() {
    let run = uuid::Uuid::new_v4().to_string();
    let exec = execution(READ_ONLY.len(), true);
    let token = snapshot_token(&run, &exec);
    let read_start = "{\"type\":\"tool_execution_start\",\"toolCallId\":\"read\",\"toolName\":\"read\",\"args\":{\"path\":\"new.ts\"}}\n";
    update_from_log_chunk(&run, &exec.id, "worker", "/repo", "/repo", read_start, true);
    super::warm_execution_log(&run, &exec, "/repo", token, |_| panic!("older prefix must not overwrite a newer pending read"));
    let read_end = "{\"type\":\"tool_execution_end\",\"toolCallId\":\"read\",\"toolName\":\"read\",\"isError\":false}\n";
    update_from_log_chunk(&run, &exec.id, "worker", "/repo", "/repo", read_end, true);
    update_from_log_chunk(&run, &exec.id, "worker", "/repo", "/repo", WRITE, true);
    assert_eq!(get_cached_execution_changes(&run, &exec).unwrap().files[0].status, "modified");
    invalidate_run(&run);
}

#[test]
fn read_only_cursor_hints_do_not_block_another_runs_event_commit() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.sqlite");
    let writer = crate::store::Store::open(&path).unwrap();
    let other = crate::store::Store::open(&path).unwrap();
    let exec = execution(0, true);
    let mut a = Snapshot { run_id: uuid::Uuid::new_v4().to_string(), executions: vec![exec.clone()], ..Default::default() };
    let mut b = Snapshot { run_id: uuid::Uuid::new_v4().to_string(), ..Default::default() };
    // A display reader may hold this global cache while merging a large Run.
    let reading = cache().lock().unwrap();
    let (a_tx, a_rx) = std::sync::mpsc::channel();
    let thread_a = std::thread::spawn(move || {
        a_tx.send(writer.append(&mut a, crate::model::EventKind::Output {
            execution_id: exec.id, text: READ_ONLY.into(),
        })).unwrap();
    });
    let a_done = a_rx.recv_timeout(std::time::Duration::from_secs(1));
    let (b_tx, b_rx) = std::sync::mpsc::channel();
    let thread_b = std::thread::spawn(move || {
        b_tx.send(other.append(&mut b, crate::model::EventKind::Paused { paused: true })).unwrap();
    });
    let b_done = b_rx.recv_timeout(std::time::Duration::from_secs(1));
    // Release before asserting/joining, so a regression fails rather than
    // hanging workers or poisoning the cache for the remaining tests.
    drop(reading);
    thread_a.join().unwrap();
    thread_b.join().unwrap();
    assert!(matches!(a_done, Ok(Ok(()))), "text output waited for the display cache: {a_done:?}");
    assert!(matches!(b_done, Ok(Ok(()))), "an unrelated Run commit was blocked: {b_done:?}");
}

#[test]
fn snapshot_fence_capture_does_not_wait_while_the_run_is_locked() {
    let reading = cache().lock().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || tx.send(capture_warm_fence(&Snapshot::default(), None).map(|_| ())).unwrap());
    let result = rx.recv_timeout(std::time::Duration::from_secs(1));
    drop(reading);
    thread.join().unwrap();
    assert!(matches!(result, Ok(Err(_))), "cache contention must be retryable, not block the Run mutex");
}

#[test]
fn empty_planner_warms_are_cached_and_live_writes_supersede_them() {
    let temp = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&temp.path().join("events.sqlite")).unwrap();
    let run = uuid::Uuid::new_v4().to_string();
    let planning = uuid::Uuid::new_v4().to_string();
    let directory = temp.path().join("planning").join(&planning);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("planner.jsonl"), READ_ONLY).unwrap();
    let state = Snapshot { run_id: run.clone(), planning_id: Some(planning.clone()), ..Default::default() };
    warm_run_changes(&state, &store, Some(temp.path()));
    assert!(cache().lock().unwrap().planning_changes[&(run.clone(), planning.clone())].is_empty());
    update_planning_from_log_chunk(&run, &planning, "/repo", "/repo", WRITE);
    warm_run_changes(&state, &store, Some(temp.path()));
    assert_eq!(get_cached_run_changes(&state).unwrap().total_files, 1);
    invalidate_run(&run);
}
