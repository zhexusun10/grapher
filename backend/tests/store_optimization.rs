use grapher::{model::*, store::Store};
use rusqlite::{params, Connection};
use tempfile::TempDir;

fn created(repository: &str, direct: Option<&str>, nested: Option<&str>) -> EventKind {
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repository, "model": "test", "maxParallel": 1
    })).unwrap();
    let planning = nested.map(|id| serde_json::from_value(serde_json::json!({
        "planningId": id, "roles": {}, "totalPlanningDuration": 0, "modelDuration": 0
    })).unwrap());
    EventKind::Created {
        graph: Graph { nodes: ["done", "failed", "live"].iter().map(|name| Node { name: (*name).into(), task: "test".into() }).collect(), ..Default::default() },
        config, planning_id: direct.map(str::to_string), planning,
    }
}

fn execution(id: &str) -> Execution {
    Execution {
        id: id.into(), node: id.into(), revision: 1, attempt: 1,
        session_id: id.into(), worktree: String::new(), before: String::new(),
        workspace_lineage: vec![],
        after: None, status: "running".into(), output: String::new(), output_bytes: 0, pid: None,
        input: None, result: None,
        started_at: 1, completed_at: None, metrics: None,
    }
}

// Seed through raw SQL: Store's new writer must never create legacy rows.
fn legacy(db: &Connection, run: &str, kind: EventKind, indexed: bool) {
    let value = serde_json::to_value(kind).unwrap();
    let id = value["execution_id"].as_str().or(value["execution"]["id"].as_str());
    db.execute("INSERT INTO events(run_id,timestamp,payload,kind,execution_id) VALUES(?1,1000,?2,?3,?4)",
        params![run, value.to_string(), indexed.then(|| value["type"].as_str()).flatten(), if indexed { id } else { None }]).unwrap();
}

fn seed_legacy(path: &std::path::Path, indexed: bool) -> String {
    let _store = Store::open(path).unwrap();
    let db = Connection::open(path).unwrap();
    let text = format!("{}\n── Final response ──\n完成🚀\n", "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"usage\":{\"input\":7,\"output\":3,\"totalTokens\":10}}}\n".repeat(500));
    for kind in [
        created("repo", Some("id"), None),
        EventKind::Started { execution: execution("done") },
        EventKind::Output { execution_id: "done".into(), text: "redundant".into() },
        EventKind::Finished { execution_id: "done".into(), head: "h".into(), output: text.clone(), output_bytes: 0, metrics: None },
        EventKind::Started { execution: execution("failed") },
        EventKind::Output { execution_id: "failed".into(), text: "失败前\n".into() },
        EventKind::Output { execution_id: "failed".into(), text: "🚀🎉\u{1b}[31m错误\u{1b}[0m".into() },
        EventKind::Failed { node: "failed".into(), execution_id: Some("failed".into()), error: "failed".into(), output_bytes: 0, metrics: None },
        EventKind::Started { execution: execution("live") },
        EventKind::Output { execution_id: "live".into(), text: "interrupted\n".into() },
        EventKind::MergerStarted { execution: execution("merge") },
        EventKind::Output { execution_id: "merge".into(), text: "conflict\n".into() },
        EventKind::MergerFailed { execution_id: "merge".into(), error: "unresolved".into(), output_bytes: 0, metrics: None },
    ] { legacy(&db, "run", kind, indexed); }
    text
}

#[test]
fn migrates_planning_ids_and_uses_exact_index() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    {
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL);").unwrap();
        for (run, id, nested) in [("one", "a%_", false), ("two", "aXy", true)] {
            let kind = created(run, if nested { None } else { Some(id) }, if nested { Some(id) } else { None });
            db.execute("INSERT INTO events(run_id,timestamp,payload) VALUES (?1,1,?2)", params![run, serde_json::to_string(&kind).unwrap()]).unwrap();
        }
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.find_repository_by_planning_id("a%_"), Some("one".into()));
    assert_eq!(store.find_repository_by_planning_id("aXy"), Some("two".into()));
    assert_eq!(store.find_repository_by_planning_id("a"), None);
    let mut state = Snapshot { run_id: "three".into(), ..Default::default() };
    store.append(&mut state, created("both", Some("direct"), Some("nested"))).unwrap();
    assert_eq!(store.find_repository_by_planning_id("direct"), Some("both".into()));
    assert_eq!(store.find_repository_by_planning_id("nested"), Some("both".into()));
}

#[test]
fn migration_preserves_finished_failed_interrupted_and_merger_logs_and_is_idempotent() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let full = seed_legacy(&path, false);
    let store = Store::open(&path).unwrap();
    // JIT may have run before the offline command; deterministic chunks match.
    store.ensure_legacy_logs("run", "done").unwrap();
    let report = store.migrate_legacy_logs().unwrap();
    assert_eq!(report.backfilled_rows, 13);
    assert_eq!(report.migrated_executions, 4);
    assert_eq!(report.deleted_chunks, 5);
    for (id, expected) in [
        ("done", full.as_str()),
        ("failed", "失败前\n🚀🎉\u{1b}[31m错误\u{1b}[0m"),
        ("live", "interrupted\n"),
        ("merge", "conflict\n\nMerger failed: unresolved\n"),
    ] {
        let page = store.execution_log_page("run", id, 0, usize::MAX).unwrap();
        assert_eq!(page.content, expected);
        assert_eq!(page.total_bytes, expected.len());
    }
    let loaded = store.load("run").unwrap();
    assert!(loaded.executions.iter().chain(&loaded.mergers).all(|e| e.output.is_empty() && e.output_bytes > 0));
    assert_eq!(loaded.executions[0].metrics.as_ref().unwrap().usage.total_tokens, 5000);
    let db = Connection::open(&path).unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM events WHERE kind='output'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(db.query_row("SELECT length(json_extract(payload,'$.output')) FROM events WHERE kind='finished'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    store.vacuum().unwrap();
    assert_eq!(db.query_row("PRAGMA auto_vacuum", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    let again = store.migrate_legacy_logs().unwrap();
    assert_eq!(again.updated_rows + again.backfilled_rows + again.deleted_chunks + again.migrated_executions, 0);
}

#[test]
fn jit_is_concurrent_idempotent_and_never_mutates_events() {
    for indexed in [false, true] {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("events.db");
        let full = seed_legacy(&path, indexed);
        let db = Connection::open(&path).unwrap();
        let before: String = db.query_row("SELECT json_group_array(json_object('sequence',sequence,'payload',payload,'kind',kind,'execution_id',execution_id)) FROM events", [], |r| r.get(0)).unwrap();
        let loaded = Store::open(&path).unwrap().load("run").unwrap();
        assert!(loaded.executions.iter().all(|e| e.output.is_empty()));
        let responses = std::thread::scope(|scope| {
            let readers: Vec<_> = (0..2).map(|_| {
                let path = &path;
                scope.spawn(move || {
                    let store = Store::open(path).unwrap();
                    store.ensure_legacy_logs("run", "done").unwrap();
                    store.ensure_legacy_logs("run", "merge").unwrap();
                    store.execution_log_page("run", "done", 0, usize::MAX).unwrap().content
                })
            }).collect();
            readers.into_iter().map(|reader| reader.join().unwrap()).collect::<Vec<_>>()
        });
        assert_eq!(responses, vec![full.clone(), full]);
        let after: String = db.query_row("SELECT json_group_array(json_object('sequence',sequence,'payload',payload,'kind',kind,'execution_id',execution_id)) FROM events", [], |r| r.get(0)).unwrap();
        assert_eq!(before, after);
        assert_eq!(Store::open(&path).unwrap().execution_log_page("run", "merge", 0, usize::MAX).unwrap().content, "conflict\n\nMerger failed: unresolved\n");
    }
}

#[test]
fn utf8_paging_and_interleaved_cursors_survive_reopen_and_cascade_deletion() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let mut store = Store::open(&path).unwrap();
    let mut state = Snapshot { run_id: "run".into(), ..Default::default() };
    store.append(&mut state, created("repo", None, None)).unwrap();
    for id in ["done", "live"] { store.append(&mut state, EventKind::Started { execution: execution(id) }).unwrap(); }
    let chunk = format!("{}🚀🎉中文\u{1b}[31m\n", "a".repeat(32 * 1024 - 1));
    let mut expected = String::new();
    for _ in 0..3 {
        store.append_batch(&mut state, vec![
            EventKind::Output { execution_id: "done".into(), text: chunk.clone() },
            EventKind::Output { execution_id: "live".into(), text: "其他日志\n".into() },
        ]).unwrap();
        expected.push_str(&chunk);
        store = Store::open(&path).unwrap(); // No cached offset: recover from DB.
    }
    assert_eq!(store.log_bytes("run", "done").unwrap(), expected.len());
    assert_eq!(state.executions[0].output, expected);
    assert!(state.events.iter().all(|e| !matches!(e.kind, EventKind::Output { .. })));
    let mut restored = String::new();
    let mut offset = 0;
    loop {
        let page = store.execution_log_page("run", "done", offset, 32 * 1024).unwrap();
        assert!(page.content.len() <= 32 * 1024);
        restored.push_str(&page.content);
        offset = page.next_offset;
        if page.complete { break; }
    }
    assert_eq!(restored.as_bytes(), expected.as_bytes());
    assert!(store.execution_log_page("run", "done", 32 * 1024, 1024).is_err());
    assert!(store.execution_log_page("wrong-run", "done", 1, 1024).is_err());
    let db = Connection::open(&path).unwrap();
    let mut previous = 0;
    let mut stmt = db.prepare("SELECT offset,bytes,text FROM execution_logs WHERE execution_id='done' ORDER BY offset").unwrap();
    for row in stmt.query_map([], |r| Ok((r.get::<_, usize>(0)?, r.get::<_, usize>(1)?, r.get::<_, String>(2)?))).unwrap() {
        let (offset, bytes, text) = row.unwrap();
        assert_eq!(offset, previous); assert_eq!(bytes, text.len()); assert!(bytes <= 32 * 1024);
        previous += bytes;
    }
    drop(stmt);
    store.delete_run("run").unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM execution_logs", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert!(store.load("run").is_err());
    store.clear().unwrap();
}

#[test]
fn committed_finished_has_no_text_and_carries_metrics_and_pid() {
    let temp = TempDir::new().unwrap();
    let mut runtime = grapher::runtime::Runtime::open(temp.path()).unwrap();
    runtime.state.run_id = "run".into();
    runtime.emit(created("repo", None, None)).unwrap();
    let exec = execution("done");
    runtime.emit(EventKind::Started { execution: exec.clone() }).unwrap();
    let first = "{\"type\":\"grapher_process_started\",\"pid\":123}";
    runtime.emit_outputs(vec![EventKind::Output { execution_id: "done".into(), text: first.into() }]).unwrap();
    runtime.emit_outputs(vec![EventKind::Output { execution_id: "done".into(), text: "\n{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"usage\":{\"totalTokens\":42}}}\n".into() }]).unwrap();
    assert_eq!(runtime.state.executions[0].pid, Some(123));
    runtime.finish(&exec, Ok(("head".into(), "完成🚀".into()))).unwrap();
    let page = runtime.store.execution_log_page("run", "done", 0, usize::MAX).unwrap();
    assert!(page.content.ends_with("\n── Final response ──\n完成🚀\n"));
    let loaded = runtime.store.load("run").unwrap();
    assert_eq!(loaded.executions[0].output_bytes, page.total_bytes);
    assert_eq!(loaded.executions[0].metrics.as_ref().unwrap().usage.total_tokens, 42);
    assert!(loaded.executions[0].output.is_empty());
    let db = Connection::open(temp.path().join("events.sqlite")).unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM events WHERE kind='output'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert!(db.query_row("SELECT length(payload) FROM events WHERE kind='finished'", [], |r| r.get::<_, usize>(0)).unwrap() < 1024);
}

#[test]
fn runtime_merger_failure_and_failed_bytes_survive_reload() {
    let temp = TempDir::new().unwrap();
    let mut runtime = grapher::runtime::Runtime::open(temp.path()).unwrap();
    runtime.state.run_id = "run".into();
    runtime.emit(created("repo", None, None)).unwrap();
    runtime.emit(EventKind::Started { execution: execution("failed") }).unwrap();
    runtime.emit(EventKind::Output { execution_id: "failed".into(), text: "失败日志🎉".into() }).unwrap();
    runtime.emit(EventKind::Failed { node: "failed".into(), execution_id: Some("failed".into()), error: "oops".into(), output_bytes: 0, metrics: None }).unwrap();
    runtime.emit(EventKind::MergerStarted { execution: execution("merge") }).unwrap();
    runtime.emit(EventKind::Output { execution_id: "merge".into(), text: "merge\n".into() }).unwrap();
    runtime.emit(EventKind::MergerFailed { execution_id: "merge".into(), error: "conflict".into(), output_bytes: 0, metrics: None }).unwrap();
    let loaded = runtime.store.load("run").unwrap();
    assert_eq!(loaded.executions[0].output_bytes, "失败日志🎉".len());
    assert_eq!(loaded.mergers[0].output_bytes, "merge\n\nMerger failed: conflict\n".len());
    assert_eq!(runtime.store.execution_log_page("run", "merge", 0, usize::MAX).unwrap().content, "merge\n\nMerger failed: conflict\n");
}

#[test]
fn interrupted_runtime_preserves_committed_logs_bytes_and_metrics() {
    let temp = TempDir::new().unwrap();
    let text = "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"usage\":{\"totalTokens\":42}}}\n失败前🚀\n";
    {
        let mut runtime = grapher::runtime::Runtime::open(temp.path()).unwrap();
        runtime.state.run_id = "run".into();
        runtime.emit(created("repo", None, None)).unwrap();
        runtime.emit(EventKind::Started { execution: execution("failed") }).unwrap();
        runtime.emit(EventKind::Output { execution_id: "failed".into(), text: text.into() }).unwrap();
        // No terminal event: equivalent durable state to an interrupted process.
    }
    let runtime = grapher::runtime::Runtime::open(temp.path()).unwrap();
    let exec = &runtime.state.executions[0];
    assert_eq!(exec.status, "failed");
    assert!(exec.output.is_empty());
    assert_eq!(exec.output_bytes, text.len());
    assert_eq!(exec.metrics.as_ref().unwrap().usage.total_tokens, 42);
    assert_eq!(runtime.store.execution_log_page("run", "failed", 0, usize::MAX).unwrap().content, text);
    runtime.store.migrate_legacy_logs().unwrap();
    assert_eq!(runtime.store.load("run").unwrap().executions[0].output_bytes, text.len());
}

#[test]
fn failed_log_commit_never_advances_projection_or_offset_cursor() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let mut store = Store::open(&path).unwrap();
    let mut state = Snapshot { run_id: "run".into(), ..Default::default() };
    store.append(&mut state, created("repo", None, None)).unwrap();
    store.append(&mut state, EventKind::Started { execution: execution("done") }).unwrap();
    store.append(&mut state, EventKind::Output { execution_id: "done".into(), text: "before\n".into() }).unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER fail_log BEFORE INSERT ON execution_logs WHEN NEW.text='reject' BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    assert!(store.append_batch(&mut state, vec![
        EventKind::Output { execution_id: "done".into(), text: "reject".into() },
        EventKind::Output { execution_id: "other".into(), text: "also rollback".into() },
    ]).is_err());
    assert_eq!(state.executions[0].output, "before\n");
    assert_eq!(store.log_bytes("run", "done").unwrap(), 7);
    assert_eq!(store.log_bytes("run", "other").unwrap(), 0);
    db.execute_batch("DROP TRIGGER fail_log;").unwrap();
    store.append(&mut state, EventKind::Output { execution_id: "done".into(), text: "after🚀\n".into() }).unwrap();
    assert_eq!(store.execution_log_page("run", "done", 0, usize::MAX).unwrap().content, "before\nafter🚀\n");
    assert_eq!(store.log_bytes("run", "done").unwrap(), state.executions[0].output.len());
}

#[test]
fn delete_run_releases_incremental_pages_and_cascades_logs() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let mut store = Store::open(&path).unwrap();
    let mut state = Snapshot { run_id: "run".into(), ..Default::default() };
    store.append(&mut state, created("repo", None, None)).unwrap();
    store.append(&mut state, EventKind::Started { execution: execution("done") }).unwrap();
    for batch in 0..8 {
        store.append_batch(&mut state, (0..32).map(|i| EventKind::Output {
            execution_id: "done".into(), text: format!("{batch}-{i}-{}", "y".repeat(64 * 1024)),
        }).collect()).unwrap();
    }
    let db = Connection::open(&path).unwrap();
    assert_eq!(db.query_row("PRAGMA auto_vacuum", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let before_pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    let before_free: i64 = db.query_row("PRAGMA freelist_count", [], |r| r.get(0)).unwrap();
    let before_size = std::fs::metadata(&path).unwrap().len();
    let log_rows: i64 = db.query_row("SELECT COUNT(*) FROM execution_logs WHERE run_id='run'", [], |r| r.get(0)).unwrap();
    assert!(log_rows > 0);
    store.delete_run("run").unwrap();
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let after_pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    let after_free: i64 = db.query_row("PRAGMA freelist_count", [], |r| r.get(0)).unwrap();
    let after_size = std::fs::metadata(&path).unwrap().len();
    eprintln!("pages {before_pages} -> {after_pages}, free {before_free} -> {after_free}, file {before_size} -> {after_size}");
    assert_eq!(db.query_row("SELECT COUNT(*) FROM execution_logs", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(db.query_row("SELECT COUNT(*) FROM events WHERE run_id='run'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(db.query_row("SELECT COUNT(*) FROM checkpoints WHERE run_id='run'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    // Fully step the PRAGMA, not just its first yielded page. Reclaim all
    // freed pages or exhaust the bounded 4096-page per-delete budget.
    assert!(after_pages < before_pages, "incremental_vacuum did not release pages: {before_pages} -> {after_pages}");
    assert!(after_free == 0 || before_pages - after_pages >= 4096,
        "vacuum stopped before its page budget: reclaimed {}, remaining {after_free}", before_pages - after_pages);
    assert!(after_size < before_size, "file did not shrink: {before_size} -> {after_size}");
    assert!(after_free >= 0 && after_free < after_pages, "freelist must not cover the live database");
}

#[test]
#[ignore = "large synthetic load; run with --release --ignored"]
fn metadata_load_performance_budgets() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let store = Store::open(&path).unwrap();
    let mut state = Snapshot { run_id: "history".into(), ..Default::default() };
    store.append(&mut state, created("repo", None, None)).unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch("WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<889999)
        INSERT INTO execution_logs SELECT 'history','huge', x*128,128,printf('%0128d',x) FROM n;").unwrap();
    let start = std::time::Instant::now();
    let loaded = store.load("history").unwrap();
    let history_elapsed = start.elapsed();
    eprintln!("890,000 log blocks (~109 MiB), metadata load: {history_elapsed:?}");
    assert!(history_elapsed.as_millis() < 50, "history load: {history_elapsed:?}");
    assert_eq!(loaded.events.len(), 1);
    state.run_id = "business".into(); state.events.clear();
    store.append(&mut state, created("repo", None, None)).unwrap();
    for _ in 0..10_000 { store.append(&mut state, EventKind::Paused { paused: true }).unwrap(); }
    let start = std::time::Instant::now();
    assert_eq!(store.load("business").unwrap().events.len(), 10_001);
    let business_elapsed = start.elapsed();
    eprintln!("10,001 business events + checkpoint, metadata load: {business_elapsed:?}");
    assert!(business_elapsed.as_millis() < 100, "business load: {business_elapsed:?}");
}
