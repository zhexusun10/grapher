use grapher::{model::*, store::Store};
use rusqlite::{params, Connection};
use tempfile::TempDir;

fn created(repository: &str, direct: Option<&str>, nested: Option<&str>) -> EventKind {
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repository, "model": "test", "maxParallel": 1
    }))
    .unwrap();
    let planning = nested.map(|id| {
        serde_json::from_value(serde_json::json!({
            "planningId": id, "roles": {}, "totalPlanningDuration": 0, "modelDuration": 0
        }))
        .unwrap()
    });
    EventKind::Created {
        graph: Graph {
            nodes: ["completed", "failed", "live"]
                .iter()
                .map(|name| Node {
                    id: (*name).into(),
                    task: "test".into(),
                })
                .collect(),
            ..Default::default()
        },
        config,
        planning_id: direct.map(str::to_string),
        planning,
    }
}

fn execution(id: &str) -> Execution {
    Execution {
        id: id.into(),
        node: id.into(),
        revision: 1,
        attempt: 1,
        session_id: id.into(),
        worktree: String::new(),
        before: String::new(),
        workspace_lineage: vec![],
        after: None,
        status: "running".into(),
        output: String::new(),
        output_bytes: 0,
        pid: None,
        input: None,
        result: None,
        started_at: 1,
        completed_at: None,
        metrics: None,
    }
}

// Seed through raw SQL: Store's new writer must never create legacy rows.
fn legacy(db: &Connection, run: &str, kind: EventKind, indexed: bool) {
    let value = serde_json::to_value(kind).unwrap();
    let id = value["execution_id"]
        .as_str()
        .or(value["execution"]["id"].as_str());
    db.execute(
        "INSERT INTO events(run_id,timestamp,payload,kind,execution_id) VALUES(?1,1000,?2,?3,?4)",
        params![
            run,
            value.to_string(),
            indexed.then(|| value["type"].as_str()).flatten(),
            if indexed { id } else { None }
        ],
    )
    .unwrap();
}

fn seed_legacy(path: &std::path::Path, indexed: bool) -> String {
    let _store = Store::open(path).unwrap();
    let db = Connection::open(path).unwrap();
    let text = format!("{}\n── Final response ──\n完成𠀀\n", "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"usage\":{\"input\":7,\"output\":3,\"totalTokens\":10}}}\n".repeat(500));
    for kind in [
        created("repo", Some("id"), None),
        EventKind::Started {
            execution: execution("completed"),
            message_sequences: None,
            fresh_restart: false,
        },
        EventKind::Output {
            execution_id: "completed".into(),
            text: "redundant".into(),
        },
        EventKind::Finished {
            execution_id: "completed".into(),
            head: "h".into(),
            output: text.clone(),
            output_bytes: 0,
            metrics: None,
        },
        EventKind::Started {
            execution: execution("failed"),
            message_sequences: None,
            fresh_restart: false,
        },
        EventKind::Output {
            execution_id: "failed".into(),
            text: "失败前\n".into(),
        },
        EventKind::Output {
            execution_id: "failed".into(),
            text: "𠀀𠀁\u{1b}[31m错误\u{1b}[0m".into(),
        },
        EventKind::Failed {
            node: "failed".into(),
            execution_id: Some("failed".into()),
            error: "failed".into(),
            output_bytes: 0,
            metrics: None,
        },
        EventKind::Started {
            execution: execution("live"),
            message_sequences: None,
            fresh_restart: false,
        },
        EventKind::Output {
            execution_id: "live".into(),
            text: "interrupted\n".into(),
        },
        EventKind::MergerStarted {
            execution: execution("merge"),
        },
        EventKind::Output {
            execution_id: "merge".into(),
            text: "conflict\n".into(),
        },
        EventKind::MergerFailed {
            execution_id: "merge".into(),
            error: "unresolved".into(),
            output_bytes: 0,
            metrics: None,
        },
    ] {
        legacy(&db, "run", kind, indexed);
    }
    text
}

#[test]
fn planning_duration_bits_survive_event_and_checkpoint_replay() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let store = Store::open(&path).unwrap();
    let mut state = Snapshot {
        run_id: "duration-replay".into(),
        ..Default::default()
    };
    let summary = PlanningSummary {
        planning_id: "planning".into(),
        total_planning_duration: 1.5581296660000001,
        model_duration: 0.10000000000000002,
        ..Default::default()
    };
    let mut event = created("repo", Some("planning"), None);
    if let EventKind::Created { planning, .. } = &mut event {
        *planning = Some(summary.clone());
    }
    store.append(&mut state, event).unwrap();
    let assert_replay = |run_id: &str| {
        let replay = Store::open(&path).unwrap().load(run_id).unwrap();
        assert_eq!(replay.planning, Some(summary.clone()));
    };
    assert_replay(&state.run_id); // Event replay, before the first checkpoint.
    store
        .append(
            &mut state,
            EventKind::Failed {
                node: "live".into(),
                execution_id: None,
                error: "test failure".into(),
                output_bytes: 0,
                metrics: None,
            },
        )
        .unwrap();
    assert_replay(&state.run_id); // A terminal event seals the same metrics into a checkpoint.
}

#[test]
fn migrates_planning_ids_and_uses_exact_index() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    {
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL);").unwrap();
        for (run, id, nested) in [("one", "a%_", false), ("two", "aXy", true)] {
            let kind = created(
                run,
                if nested { None } else { Some(id) },
                if nested { Some(id) } else { None },
            );
            db.execute(
                "INSERT INTO events(run_id,timestamp,payload) VALUES (?1,1,?2)",
                params![run, serde_json::to_string(&kind).unwrap()],
            )
            .unwrap();
        }
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.find_repository_by_planning_id("a%_"),
        Some("one".into())
    );
    assert_eq!(
        store.find_repository_by_planning_id("aXy"),
        Some("two".into())
    );
    assert_eq!(store.find_repository_by_planning_id("a"), None);
    let mut state = Snapshot {
        run_id: "three".into(),
        ..Default::default()
    };
    store
        .append(&mut state, created("both", Some("direct"), Some("nested")))
        .unwrap();
    assert_eq!(
        store.find_repository_by_planning_id("direct"),
        Some("both".into())
    );
    assert_eq!(
        store.find_repository_by_planning_id("nested"),
        Some("both".into())
    );
}

#[test]
fn legacy_projection_preserves_sha1_and_sha256_heads_without_rewriting_history() {
    for indexed in [false, true] {
        for length in [40, 64] {
            let temp = TempDir::new().unwrap();
            let path = temp.path().join("events.db");
            let store = Store::open(&path).unwrap();
            let mut state = Snapshot {
                run_id: "run".into(),
                ..Default::default()
            };
            store
                .append(&mut state, created("repo", None, None))
                .unwrap();
            store
                .append(
                    &mut state,
                    EventKind::Started {
                        execution: execution("completed"),
                        message_sequences: None,
                        fresh_restart: false,
                    },
                )
                .unwrap();
            let head = "a".repeat(length);
            let output = "legacy 中文𠀀 transcript\n".repeat(512);
            // Keep the historical tag-first shape for bounded metadata projection.
            let payload = serde_json::to_string(&EventKind::Finished {
                execution_id: "completed".into(),
                head: head.clone(),
                output: output.clone(),
                output_bytes: 0,
                metrics: None,
            })
            .unwrap();
            let db = Connection::open(&path).unwrap();
            db.execute("INSERT INTO events(run_id,timestamp,payload,kind,execution_id) VALUES('run',1000,?1,?2,?3)",
                params![payload, indexed.then_some("finished"), indexed.then_some("completed")]).unwrap();
            let loaded = store.load("run").unwrap();
            assert_eq!(
                loaded.nodes["completed"].head.as_deref(),
                Some(head.as_str()),
                "indexed={indexed}, length={length}"
            );
            assert_eq!(loaded.executions[0].after.as_deref(), Some(head.as_str()));
            assert!(loaded.executions[0].output.is_empty());
            assert_eq!(
                store.ensure_legacy_logs("run", "completed").unwrap(),
                output.len()
            );
            assert_eq!(
                store
                    .execution_log_page("run", "completed", 0, usize::MAX)
                    .unwrap()
                    .content,
                output
            );
            let saved: String = db
                .query_row(
                    "SELECT payload FROM events ORDER BY sequence DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(saved, payload, "reads must never rewrite the legacy event");
        }
    }
}

#[test]
fn legacy_projection_keeps_64_byte_execution_ids_readable_on_demand() {
    for indexed in [false, true] {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("events.db");
        let store = Store::open(&path).unwrap();
        let id = "e".repeat(64);
        let output = "retained log 中文𠀀\n".repeat(512);
        let mut initial = execution("completed");
        initial.id = id.clone();
        let db = Connection::open(&path).unwrap();
        for kind in [
            created("repo", None, None),
            EventKind::Started {
                execution: initial,
                message_sequences: None,
                fresh_restart: false,
            },
            EventKind::Finished {
                execution_id: id.clone(),
                head: "a".repeat(40),
                output: output.clone(),
                output_bytes: 0,
                metrics: None,
            },
        ] {
            let value = serde_json::to_value(&kind).unwrap();
            let payload = serde_json::to_string(&kind).unwrap();
            let event_id = value["execution_id"]
                .as_str()
                .or(value["execution"]["id"].as_str());
            db.execute("INSERT INTO events(run_id,timestamp,payload,kind,execution_id) VALUES('run',1000,?1,?2,?3)",
                params![payload, indexed.then(|| value["type"].as_str()).flatten(), indexed.then_some(event_id).flatten()]).unwrap();
        }
        assert_eq!(
            store.ensure_legacy_logs("run", &id).unwrap(),
            output.len(),
            "indexed={indexed}"
        );
        assert_eq!(
            store
                .execution_log_page("run", &id, 0, usize::MAX)
                .unwrap()
                .content,
            output
        );
        let loaded = store.load("run").unwrap();
        assert_eq!(loaded.executions[0].id, id);
        assert_eq!(loaded.executions[0].status, "completed");
    }
}

#[test]
fn log_pages_reject_gaps_overlaps_and_invalid_byte_ranges_without_mutation() {
    for damage in [
        "gap",
        "overlap",
        "negative_offset",
        "negative_bytes",
        "overflow",
        "wrong_length",
    ] {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("events.db");
        let store = Store::open(&path).unwrap();
        let db = Connection::open(&path).unwrap();
        let blocks: Vec<(i64, i64, &str)> = match damage {
            "gap" => vec![(0, 3, "abc"), (9, 3, "xyz")],
            "overlap" => vec![(0, 4, "abcd"), (2, 4, "wxyz")],
            "negative_offset" => vec![(-1, 2, "xx")],
            "negative_bytes" => vec![(0, -1, "")],
            "overflow" => vec![(i64::MAX, 1, "x")],
            _ => vec![(0, 3, "ab")],
        };
        for (offset, bytes, text) in &blocks {
            db.execute("INSERT INTO execution_logs(run_id,execution_id,offset,bytes,text) VALUES('run','log',?1,?2,?3)", params![offset, bytes, text]).unwrap();
        }
        let evidence = || {
            db.query_row(
                "SELECT json_group_array(json_array(offset,bytes,text)) FROM execution_logs",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
        };
        let original = evidence();
        if damage.starts_with("negative") || damage == "overflow" {
            assert!(
                store.log_bytes("run", "log").is_err(),
                "{damage}: invalid metadata must not wrap into a usable cursor"
            );
        }
        assert!(
            store.execution_log_page("run", "log", 0, 6).is_err(),
            "{damage}: forward paging must not succeed partially or stall"
        );
        assert!(
            store.execution_log_tail_page("run", "log", 6, 6).is_err(),
            "{damage}: tail paging must reject invalid byte coverage"
        );
        assert_eq!(
            evidence(),
            original,
            "a read must not repair or discard evidence"
        );
        // Readers must work after external repair.
        let text = "a中文𠀀z";
        db.execute("DELETE FROM execution_logs", []).unwrap();
        db.execute("INSERT INTO execution_logs(run_id,execution_id,offset,bytes,text) VALUES('run','log',0,?1,?2)", params![text.len(), text]).unwrap();
        assert_eq!(
            store
                .execution_log_page("run", "log", 0, usize::MAX)
                .unwrap()
                .content,
            text
        );
        assert_eq!(
            store
                .execution_log_tail_page("run", "log", text.len(), usize::MAX)
                .unwrap()
                .content,
            text
        );
        assert_eq!(
            store
                .execution_log_page("run", "log", 0, 0)
                .unwrap()
                .content,
            ""
        );
        assert_eq!(
            store
                .execution_log_page("run", "log", 0, 3)
                .unwrap()
                .content,
            "a",
            "UTF-8 flooring is not missing log data"
        );
    }
}

#[test]
fn migration_preserves_finished_failed_interrupted_and_merger_logs_and_is_idempotent() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let full = seed_legacy(&path, false);
    let store = Store::open(&path).unwrap();
    // JIT may have run before the offline command; deterministic chunks match.
    store.ensure_legacy_logs("run", "completed").unwrap();
    let report = store.migrate_legacy_logs().unwrap();
    assert_eq!(report.backfilled_rows, 13);
    assert_eq!(report.migrated_executions, 4);
    assert_eq!(report.deleted_chunks, 5);
    for (id, expected) in [
        ("completed", full.as_str()),
        ("failed", "失败前\n𠀀𠀁\u{1b}[31m错误\u{1b}[0m"),
        ("live", "interrupted\n"),
        ("merge", "conflict\n\nMerger failed: unresolved\n"),
    ] {
        let page = store.execution_log_page("run", id, 0, usize::MAX).unwrap();
        assert_eq!(page.content, expected);
        assert_eq!(page.total_bytes, expected.len());
    }
    let loaded = store.load("run").unwrap();
    assert!(loaded
        .executions
        .iter()
        .chain(&loaded.mergers)
        .all(|e| e.output.is_empty() && e.output_bytes > 0));
    assert_eq!(
        loaded.executions[0]
            .metrics
            .as_ref()
            .unwrap()
            .usage
            .total_tokens,
        5000
    );
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM events WHERE kind='output'", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row(
            "SELECT length(json_extract(payload,'$.output')) FROM events WHERE kind='finished'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    store.vacuum().unwrap();
    assert_eq!(
        db.query_row("PRAGMA auto_vacuum", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    let again = store.migrate_legacy_logs().unwrap();
    assert_eq!(
        again.updated_rows
            + again.backfilled_rows
            + again.deleted_chunks
            + again.migrated_executions,
        0
    );
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
            let readers: Vec<_> = (0..2)
                .map(|_| {
                    let path = &path;
                    scope.spawn(move || {
                        let store = Store::open(path).unwrap();
                        store.ensure_legacy_logs("run", "completed").unwrap();
                        store.ensure_legacy_logs("run", "merge").unwrap();
                        store
                            .execution_log_page("run", "completed", 0, usize::MAX)
                            .unwrap()
                            .content
                    })
                })
                .collect();
            readers
                .into_iter()
                .map(|reader| reader.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(responses, vec![full.clone(), full]);
        let after: String = db.query_row("SELECT json_group_array(json_object('sequence',sequence,'payload',payload,'kind',kind,'execution_id',execution_id)) FROM events", [], |r| r.get(0)).unwrap();
        assert_eq!(before, after);
        assert_eq!(
            Store::open(&path)
                .unwrap()
                .execution_log_page("run", "merge", 0, usize::MAX)
                .unwrap()
                .content,
            "conflict\n\nMerger failed: unresolved\n"
        );
    }
}

#[test]
fn utf8_paging_and_interleaved_cursors_survive_reopen_and_cascade_deletion() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let mut store = Store::open(&path).unwrap();
    let mut state = Snapshot {
        run_id: "run".into(),
        ..Default::default()
    };
    store
        .append(&mut state, created("repo", None, None))
        .unwrap();
    for id in ["completed", "live"] {
        store
            .append(
                &mut state,
                EventKind::Started {
                    execution: execution(id),
                    message_sequences: None,
                    fresh_restart: false,
                },
            )
            .unwrap();
    }
    // Four-byte CJK characters cross the chunk boundary.
    let chunk = format!("{}𠀀𠀁中文\u{1b}[31m\n", "a".repeat(32 * 1024 - 1));
    let mut expected = String::new();
    for _ in 0..3 {
        store
            .append_batch(
                &mut state,
                vec![
                    EventKind::Output {
                        execution_id: "completed".into(),
                        text: chunk.clone(),
                    },
                    EventKind::Output {
                        execution_id: "live".into(),
                        text: "其他日志\n".into(),
                    },
                ],
            )
            .unwrap();
        expected.push_str(&chunk);
        store = Store::open(&path).unwrap(); // No cached offset: recover from DB.
    }
    assert_eq!(store.log_bytes("run", "completed").unwrap(), expected.len());
    assert_eq!(state.executions[0].output, expected);
    assert!(state
        .events
        .iter()
        .all(|e| !matches!(e.kind, EventKind::Output { .. })));
    let mut restored = String::new();
    let mut offset = 0;
    loop {
        let page = store
            .execution_log_page("run", "completed", offset, 32 * 1024)
            .unwrap();
        assert!(page.content.len() <= 32 * 1024);
        restored.push_str(&page.content);
        offset = page.next_offset;
        if page.complete {
            break;
        }
    }
    assert_eq!(restored.as_bytes(), expected.as_bytes());
    let tail = store
        .execution_log_tail_page("run", "completed", expected.len(), 32 * 1024)
        .unwrap();
    assert!(expected.ends_with(&tail.content));
    let mut older = String::new();
    let mut before = tail.start_offset;
    while before > 0 {
        let page = store
            .execution_log_tail_page("run", "completed", before, 32 * 1024)
            .unwrap();
        older.insert_str(0, &page.content);
        before = page.start_offset;
    }
    assert_eq!(
        format!("{older}{}", tail.content).as_bytes(),
        expected.as_bytes()
    );
    assert!(store
        .execution_log_page("run", "completed", 32 * 1024, 1024)
        .is_err());
    assert!(store
        .execution_log_page("wrong-run", "completed", 1, 1024)
        .is_err());
    let db = Connection::open(&path).unwrap();
    let mut previous = 0;
    let mut stmt = db.prepare("SELECT offset,bytes,text FROM execution_logs WHERE execution_id='completed' ORDER BY offset").unwrap();
    for row in stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, usize>(0)?,
                r.get::<_, usize>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
    {
        let (offset, bytes, text) = row.unwrap();
        assert_eq!(offset, previous);
        assert_eq!(bytes, text.len());
        assert!(bytes <= 32 * 1024);
        previous += bytes;
    }
    drop(stmt);
    store.delete_run("run").unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM execution_logs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(store.load("run").is_err());
    store.clear().unwrap();
}

#[test]
fn tail_pages_never_discard_a_tool_result_larger_than_the_page() {
    let temp = TempDir::new().unwrap();
    let store = Store::open(&temp.path().join("events.db")).unwrap();
    let mut state = Snapshot {
        run_id: "run".into(),
        ..Default::default()
    };
    store
        .append(&mut state, created("repo", None, None))
        .unwrap();
    store
        .append(
            &mut state,
            EventKind::Started {
                execution: execution("completed"),
                message_sequences: None,
                fresh_restart: false,
            },
        )
        .unwrap();
    let text = format!(
        "{}\n",
        serde_json::json!({ "type": "tool_execution_end", "toolCallId": "tool",
        "toolName": "read", "result": { "content": [{ "type": "text", "text": "中文𠀀".repeat(100_000) }] } })
    );
    store
        .append(
            &mut state,
            EventKind::Output {
                execution_id: "completed".into(),
                text: text.clone(),
            },
        )
        .unwrap();
    let mut before = text.len();
    let mut restored = String::new();
    loop {
        let page = store
            .execution_log_tail_page("run", "completed", before, 32 * 1024)
            .unwrap();
        assert!(page.start_offset < before);
        assert_eq!(page.next_offset, before);
        assert_eq!(page.content, text[page.start_offset..before]);
        restored.insert_str(0, &page.content);
        if page.start_offset == 0 {
            break;
        }
        before = page.start_offset;
    }
    assert_eq!(restored, text);
}

#[test]
fn committed_finished_has_no_text_and_carries_metrics_and_pid() {
    let temp = TempDir::new().unwrap();
    let mut runtime = grapher::runtime::Runtime::open(temp.path()).unwrap();
    runtime.state.run_id = "run".into();
    runtime.emit(created("repo", None, None)).unwrap();
    let exec = execution("completed");
    runtime
        .emit(EventKind::Started {
            execution: exec.clone(),
            message_sequences: None,
            fresh_restart: false,
        })
        .unwrap();
    let first = "{\"type\":\"grapher_process_started\",\"pid\":123}";
    runtime
        .emit_outputs(vec![EventKind::Output {
            execution_id: "completed".into(),
            text: first.into(),
        }])
        .unwrap();
    runtime.emit_outputs(vec![EventKind::Output { execution_id: "completed".into(), text: "\n{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"usage\":{\"totalTokens\":42}}}\n".into() }]).unwrap();
    assert_eq!(runtime.state.executions[0].pid, Some(123));
    runtime
        .finish(&exec, Ok(("head".into(), "完成𠀀".into())))
        .unwrap();
    let page = runtime
        .store
        .execution_log_page("run", "completed", 0, usize::MAX)
        .unwrap();
    assert!(page.content.ends_with("\n── Final response ──\n完成𠀀\n"));
    let loaded = runtime.store.load("run").unwrap();
    assert_eq!(loaded.executions[0].output_bytes, page.total_bytes);
    assert_eq!(
        loaded.executions[0]
            .metrics
            .as_ref()
            .unwrap()
            .usage
            .total_tokens,
        42
    );
    assert!(loaded.executions[0].output.is_empty());
    let db = Connection::open(temp.path().join("events.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM events WHERE kind='output'", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(
        db.query_row(
            "SELECT length(payload) FROM events WHERE kind='finished'",
            [],
            |r| r.get::<_, usize>(0)
        )
        .unwrap()
            < 1024
    );
}

#[test]
fn runtime_completion_tail_and_feedback_roll_back_and_retry_together() {
    for rejected in ["finished", "feedback_queued"] {
        let temp = TempDir::new().unwrap();
        let mut runtime = grapher::runtime::Runtime::open(temp.path()).unwrap();
        runtime.state.run_id = "run".into();
        let mut initial = created("repo", None, None);
        if let EventKind::Created { graph, .. } = &mut initial {
            graph.edges = vec![
                Edge {
                    from: "live".into(),
                    to: "completed".into(),
                    feedback: false,
                },
                Edge {
                    from: "completed".into(),
                    to: "live".into(),
                    feedback: true,
                },
            ];
        }
        runtime.emit(initial).unwrap();
        runtime
            .emit(EventKind::Started {
                execution: execution("live"),
                message_sequences: None,
                fresh_restart: false,
            })
            .unwrap();
        runtime
            .emit(EventKind::Finished {
                execution_id: "live".into(),
                head: "parent".into(),
                output: String::new(),
                output_bytes: 0,
                metrics: Some(ExecutionMetrics::default()),
            })
            .unwrap();
        let exec = execution("completed");
        runtime
            .emit(EventKind::Started {
                execution: exec.clone(),
                message_sequences: None,
                fresh_restart: false,
            })
            .unwrap();
        // Final accounting must recover metrics split across writer batches.
        let stream = "{\"type\":\"grapher_process_started\",\"pid\":123}\n{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"provider\":\"p\",\"model\":\"m\",\"thinkingLevel\":\"high\",\"usage\":{\"input\":7,\"output\":3,\"totalTokens\":10}}}";
        for text in [&stream[..70], &stream[70..]] {
            runtime
                .emit_outputs(vec![EventKind::Output {
                    execution_id: exec.id.clone(),
                    text: text.into(),
                }])
                .unwrap();
        }
        let db = Connection::open(temp.path().join("events.sqlite")).unwrap();
        db.execute_batch(&format!("CREATE TRIGGER reject_completion BEFORE INSERT ON events WHEN NEW.kind='{rejected}' BEGIN SELECT RAISE(ABORT,'injected completion failure'); END;")).unwrap();
        let before = serde_json::to_value(&runtime.state).unwrap();
        let output = "完成𠀀\n{\"type\":\"grapher_process_exited\",\"elapsedMs\":1250}\n<ACCEPT>";
        assert!(runtime
            .finish(&exec, Ok(("head".into(), output.into())))
            .is_err());
        assert_eq!(
            serde_json::to_value(&runtime.state).unwrap(),
            before,
            "{rejected}"
        );
        assert_eq!(
            runtime
                .store
                .execution_log_page("run", &exec.id, 0, usize::MAX)
                .unwrap()
                .content,
            stream
        );
        let replayed = runtime.store.load("run").unwrap();
        assert_eq!(replayed.nodes["completed"].status, "running");
        assert!(replayed.pending_feedback.is_empty());
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM events WHERE kind='finished' AND execution_id='completed'",
                [],
                |row| row.get::<_, usize>(0)
            )
            .unwrap(),
            0
        );

        db.execute_batch("DROP TRIGGER reject_completion").unwrap();
        let retry_prefix = "\nretry-prefix𠀂";
        runtime
            .emit_outputs(vec![EventKind::Output {
                execution_id: exec.id.clone(),
                text: retry_prefix.into(),
            }])
            .unwrap();
        runtime
            .finish(&exec, Ok(("head".into(), output.into())))
            .unwrap();
        let expected = format!("{stream}{retry_prefix}\n── Final response ──\n{output}\n");
        let page = runtime
            .store
            .execution_log_page("run", &exec.id, 0, usize::MAX)
            .unwrap();
        assert_eq!(
            page.content, expected,
            "failed completion must not duplicate the tail"
        );
        let pending = &runtime.state.pending_feedback[0];
        assert_eq!(
            pending.output_offset,
            stream.len() + retry_prefix.len() + "\n── Final response ──\n".len()
        );
        assert_eq!(pending.output_bytes, output.len());
        assert_eq!(
            &page.content[pending.output_offset..pending.output_offset + pending.output_bytes],
            output
        );
        assert!(pending.accepted);
        let completed = runtime
            .state
            .executions
            .iter()
            .find(|item| item.id == exec.id)
            .unwrap();
        assert_eq!(completed.pid, Some(123));
        assert_eq!(completed.output_bytes, expected.len());
        assert_eq!(
            completed.metrics.as_ref().unwrap(),
            &parse_execution_metrics(&expected, exec.started_at, 0)
        );
        for without_checkpoint in [false, true] {
            if without_checkpoint {
                db.execute("DELETE FROM checkpoints", []).unwrap();
            }
            let replayed = runtime.store.load("run").unwrap();
            let restored = replayed
                .executions
                .iter()
                .find(|item| item.id == exec.id)
                .unwrap();
            assert_eq!(restored.status, "completed");
            assert_eq!(restored.after.as_deref(), Some("head"));
            assert_eq!(restored.output_bytes, completed.output_bytes);
            assert_eq!(restored.metrics, completed.metrics);
            assert!(restored.output.is_empty());
            assert_eq!(
                serde_json::to_value(&replayed.pending_feedback).unwrap(),
                serde_json::to_value(&runtime.state.pending_feedback).unwrap()
            );
            // PID is observed checkpoint metadata, not a business event.
            if !without_checkpoint {
                assert_eq!(restored.pid, Some(123));
            }
        }
    }
}

#[test]
fn runtime_completion_recovers_the_log_prefix_missing_from_live_metadata() {
    let stream = concat!(
        "{\"type\":\"grapher_process_started\",\"pid\":123}\n",
        "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"model\":\"actual/model\",\"usage\":{\"input\":7,\"output\":3,\"totalTokens\":10}}}\n",
        "{\"type\":\"grapher_process_exited\",\"elapsedMs\":1250}\n",
    );
    for split in [stream.len(), 70] {
        let temp = TempDir::new().unwrap();
        let mut runtime = grapher::runtime::Runtime::open(temp.path()).unwrap();
        runtime.state.run_id = "run".into();
        runtime.emit(created("repo", None, None)).unwrap();
        let exec = execution("completed");
        runtime.emit(EventKind::Started {
            execution: exec.clone(), message_sequences: None, fresh_restart: false,
        }).unwrap();
        runtime.emit_outputs(vec![EventKind::Output {
            execution_id: exec.id.clone(), text: stream[..split].into(),
        }]).unwrap();
        runtime.state = runtime.store.load("run").unwrap();
        assert!(runtime.state.executions[0].output.is_empty());
        if split < stream.len() {
            runtime.emit_outputs(vec![EventKind::Output {
                execution_id: exec.id.clone(), text: stream[split..].into(),
            }]).unwrap();
        }
        let output = "完成𠀀";
        runtime.finish(&exec, Ok(("head".into(), output.into()))).unwrap();
        let expected = format!("{stream}\n── Final response ──\n{output}\n");
        let completed = &runtime.state.executions[0];
        assert_eq!(completed.metrics.as_ref().unwrap(), &parse_execution_metrics(&expected, exec.started_at, 0), "split={split}");
        assert_eq!(completed.output_bytes, expected.len());
        assert_eq!(runtime.store.execution_log_page("run", &exec.id, 0, usize::MAX).unwrap().content, expected);
        assert_eq!(runtime.store.load("run").unwrap().executions[0].metrics, completed.metrics);
    }
}

#[test]
fn runtime_completion_rejects_an_incomplete_recovered_log_before_writing_its_tail() {
    for damage in ["missing", "truncated", "inflated-metadata"] {
        let temp = TempDir::new().unwrap();
        let mut runtime = grapher::runtime::Runtime::open(temp.path()).unwrap();
        runtime.state.run_id = "run".into();
        runtime.emit(created("repo", None, None)).unwrap();
        let exec = execution("completed");
        runtime.emit(EventKind::Started {
            execution: exec.clone(), message_sequences: None, fresh_restart: false,
        }).unwrap();
        runtime.emit_outputs(vec![EventKind::Output {
            execution_id: exec.id.clone(), text: "committed 中文 prefix\n".into(),
        }]).unwrap();
        runtime.state = runtime.store.load("run").unwrap();
        let db = Connection::open(temp.path().join("events.sqlite")).unwrap();
        match damage {
            "missing" => { db.execute("DELETE FROM execution_logs", []).unwrap(); }
            "truncated" => { db.execute("UPDATE execution_logs SET text='x',bytes=1", []).unwrap(); }
            _ => { runtime.state.executions[0].output_bytes += 1; }
        }
        let before = serde_json::to_value(&runtime.state).unwrap();
        let text = runtime.store.execution_log_page("run", &exec.id, 0, usize::MAX).unwrap().content;
        let error = runtime.finish(&exec, Ok(("head".into(), "must not commit".into()))).unwrap_err();
        assert!(error.contains("incomplete terminal evidence"), "{damage}: {error}");
        assert_eq!(serde_json::to_value(&runtime.state).unwrap(), before);
        assert_eq!(runtime.store.execution_log_page("run", &exec.id, 0, usize::MAX).unwrap().content, text);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM events WHERE kind='finished'", [], |row| row.get::<_, usize>(0)).unwrap(), 0);
    }
}

#[test]
fn terminal_checkpoint_is_written_once_and_resets_the_periodic_interval() {
    for prefix_count in [0, 125] {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("events.db");
        let mut store = Store::open(&path).unwrap();
        let mut state = Snapshot {
            run_id: "run".into(),
            ..Default::default()
        };
        store
            .append(&mut state, created("repo", None, None))
            .unwrap();
        store
            .append(
                &mut state,
                EventKind::Started {
                    execution: execution("completed"),
                    message_sequences: None,
                    fresh_restart: false,
                },
            )
            .unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE checkpoint_writes(id INTEGER PRIMARY KEY);
            CREATE TRIGGER checkpoint_insert AFTER INSERT ON checkpoints BEGIN INSERT INTO checkpoint_writes(id) VALUES(NULL); END;
            CREATE TRIGGER checkpoint_update AFTER UPDATE ON checkpoints BEGIN INSERT INTO checkpoint_writes(id) VALUES(NULL); END;").unwrap();
        store
            .append_batch(
                &mut state,
                (0..prefix_count)
                    .map(|_| EventKind::Output {
                        execution_id: "completed".into(),
                        text: "前缀𠀂\n".into(),
                    })
                    .collect(),
            )
            .unwrap();
        let expected = format!("{}tail𠀀\n", "前缀𠀂\n".repeat(prefix_count));
        store
            .append_batch(
                &mut state,
                vec![
                    EventKind::Output {
                        execution_id: "completed".into(),
                        text: "tail𠀀\n".into(),
                    },
                    EventKind::Finished {
                        execution_id: "completed".into(),
                        head: "head".into(),
                        output: String::new(),
                        output_bytes: expected.len(),
                        metrics: Some(ExecutionMetrics::default()),
                    },
                ],
            )
            .unwrap();
        let writes = || {
            db.query_row("SELECT COUNT(*) FROM checkpoint_writes", [], |row| {
                row.get::<_, usize>(0)
            })
            .unwrap()
        };
        assert_eq!(
            writes(),
            1,
            "terminal batch crossing the interval must not checkpoint twice"
        );
        assert_eq!(
            store
                .execution_log_page("run", "completed", 0, usize::MAX)
                .unwrap()
                .content,
            expected
        );
        store
            .append_batch(
                &mut state,
                (0..127)
                    .map(|_| EventKind::Paused { paused: false })
                    .collect(),
            )
            .unwrap();
        assert_eq!(
            writes(),
            1,
            "terminal checkpoint already covered all preceding events"
        );
        store
            .append(&mut state, EventKind::Paused { paused: false })
            .unwrap();
        assert_eq!(writes(), 2);
        assert_eq!(
            grapher::snapshot_view::snapshot_metadata(&store.load("run").unwrap()).unwrap(),
            grapher::snapshot_view::snapshot_metadata(&state).unwrap()
        );
    }
}

#[test]
fn runtime_merger_failure_and_failed_bytes_survive_reload() {
    let temp = TempDir::new().unwrap();
    let mut runtime = grapher::runtime::Runtime::open(temp.path()).unwrap();
    runtime.state.run_id = "run".into();
    runtime.emit(created("repo", None, None)).unwrap();
    runtime
        .emit(EventKind::Started {
            execution: execution("failed"),
            message_sequences: None,
            fresh_restart: false,
        })
        .unwrap();
    runtime
        .emit(EventKind::Output {
            execution_id: "failed".into(),
            text: "失败日志𠀁".into(),
        })
        .unwrap();
    runtime
        .emit(EventKind::Failed {
            node: "failed".into(),
            execution_id: Some("failed".into()),
            error: "oops".into(),
            output_bytes: 0,
            metrics: None,
        })
        .unwrap();
    runtime
        .emit(EventKind::MergerStarted {
            execution: execution("merge"),
        })
        .unwrap();
    runtime
        .emit(EventKind::Output {
            execution_id: "merge".into(),
            text: "merge\n".into(),
        })
        .unwrap();
    runtime
        .emit(EventKind::MergerFailed {
            execution_id: "merge".into(),
            error: "conflict".into(),
            output_bytes: 0,
            metrics: None,
        })
        .unwrap();
    let loaded = runtime.store.load("run").unwrap();
    assert_eq!(loaded.executions[0].output_bytes, "失败日志𠀁".len());
    assert_eq!(
        loaded.mergers[0].output_bytes,
        "merge\n\nMerger failed: conflict\n".len()
    );
    assert_eq!(
        runtime
            .store
            .execution_log_page("run", "merge", 0, usize::MAX)
            .unwrap()
            .content,
        "merge\n\nMerger failed: conflict\n"
    );
}

#[test]
fn interrupted_runtime_preserves_committed_logs_bytes_and_metrics() {
    let temp = TempDir::new().unwrap();
    let text = "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"usage\":{\"totalTokens\":42}}}\n失败前𠀀\n";
    {
        let mut runtime = grapher::runtime::Runtime::open(temp.path()).unwrap();
        runtime.state.run_id = "run".into();
        runtime.emit(created("repo", None, None)).unwrap();
        runtime
            .emit(EventKind::Started {
                execution: execution("failed"),
                message_sequences: None,
                fresh_restart: false,
            })
            .unwrap();
        runtime
            .emit(EventKind::Output {
                execution_id: "failed".into(),
                text: text.into(),
            })
            .unwrap();
        // Drop without a terminal event to simulate interruption.
    }
    let runtime = grapher::runtime::Runtime::open(temp.path()).unwrap();
    let exec = &runtime.state.executions[0];
    assert_eq!(exec.status, "failed");
    assert!(exec.output.is_empty());
    assert_eq!(exec.output_bytes, text.len());
    assert_eq!(exec.metrics.as_ref().unwrap().usage.total_tokens, 42);
    assert_eq!(
        runtime
            .store
            .execution_log_page("run", "failed", 0, usize::MAX)
            .unwrap()
            .content,
        text
    );
    runtime.store.migrate_legacy_logs().unwrap();
    assert_eq!(
        runtime.store.load("run").unwrap().executions[0].output_bytes,
        text.len()
    );
}

#[test]
fn terminal_cache_settlement_matches_single_and_batch_event_commits() {
    for batched in [false, true] {
        for terminal in ["finished", "failed", "merger_finished", "merger_failed"] {
            let temp = TempDir::new().unwrap();
            let path = temp.path().join("events.db");
            let mut store = Store::open(&path).unwrap();
            let run = uuid::Uuid::new_v4().to_string();
            let mut state = Snapshot {
                run_id: run.clone(),
                ..Default::default()
            };
            store
                .append(&mut state, created("/repo", None, None))
                .unwrap();
            let mut exec = execution("completed");
            exec.id = uuid::Uuid::new_v4().to_string();
            exec.worktree = "/repo".into();
            let merger = terminal.starts_with("merger_");
            let started = if merger {
                EventKind::MergerStarted {
                    execution: exec.clone(),
                }
            } else {
                EventKind::Started {
                    execution: exec.clone(),
                    message_sequences: None,
                    fresh_restart: false,
                }
            };
            store.append(&mut state, started).unwrap();
            let text = [
                serde_json::json!({"type":"tool_execution_start", "toolCallId":"done", "toolName":"write", "args":{"path":"committed.txt", "content":"done"}}),
                serde_json::json!({"type":"tool_execution_end", "toolCallId":"done", "toolName":"write", "isError":false}),
                serde_json::json!({"type":"tool_execution_start", "toolCallId":"pending", "toolName":"write", "args":{"path":"unconfirmed.txt", "content":"not completed"}}),
            ].iter().map(|event| format!("{event}\n")).collect::<String>();
            store
                .append(
                    &mut state,
                    EventKind::Output {
                        execution_id: exec.id.clone(),
                        text,
                    },
                )
                .unwrap();
            let kind = match terminal {
                "finished" => EventKind::Finished {
                    execution_id: exec.id.clone(),
                    head: "head".into(),
                    output: String::new(),
                    output_bytes: 0,
                    metrics: None,
                },
                "failed" => EventKind::Failed {
                    node: exec.node.clone(),
                    execution_id: Some(exec.id.clone()),
                    error: "failed".into(),
                    output_bytes: 0,
                    metrics: None,
                },
                "merger_finished" => EventKind::MergerFinished {
                    execution_id: exec.id.clone(),
                    head: "head".into(),
                    output_bytes: 0,
                    metrics: None,
                },
                _ => EventKind::MergerFailed {
                    execution_id: exec.id.clone(),
                    error: "failed".into(),
                    output_bytes: 0,
                    metrics: None,
                },
            };
            let db = Connection::open(&path).unwrap();
            db.execute_batch("CREATE TRIGGER reject_terminal BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected terminal failure'); END;").unwrap();
            let before = state.events.len();
            let mut append = |kind| {
                if batched {
                    store.append_batch(&mut state, vec![EventKind::Paused { paused: true }, kind])
                } else {
                    store.append(&mut state, kind)
                }
            };
            assert!(append(kind.clone()).is_err());
            drop(append);
            assert_eq!(state.events.len(), before);
            assert!(!state.paused);
            let pending = grapher::file_changes::get_cached_execution_changes(&run, &exec).unwrap();
            assert_eq!(
                pending.total_files, 2,
                "{terminal}, batched={batched}: rollback must retain live changes"
            );
            assert!(pending.is_running);
            db.execute_batch("DROP TRIGGER reject_terminal").unwrap();
            if batched {
                store
                    .append_batch(&mut state, vec![EventKind::Paused { paused: true }, kind])
                    .unwrap();
            } else {
                store.append(&mut state, kind).unwrap();
            }
            // A terminal commit must also fence stale running snapshots.
            let settled = grapher::file_changes::get_cached_execution_changes(&run, &exec).unwrap();
            assert_eq!(
                settled
                    .files
                    .iter()
                    .map(|file| file.path.as_str())
                    .collect::<Vec<_>>(),
                ["committed.txt"],
                "{terminal}, batched={batched}"
            );
            assert!(!settled.is_running);
            assert!(settled.active_file_path.is_none());
            grapher::file_changes::invalidate_run(&run);
        }
    }
}

#[test]
fn failed_log_commit_never_advances_projection_or_offset_cursor() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let mut store = Store::open(&path).unwrap();
    let mut state = Snapshot {
        run_id: "run".into(),
        ..Default::default()
    };
    store
        .append(&mut state, created("repo", None, None))
        .unwrap();
    store
        .append(
            &mut state,
            EventKind::Started {
                execution: execution("completed"),
                message_sequences: None,
                fresh_restart: false,
            },
        )
        .unwrap();
    store
        .append(
            &mut state,
            EventKind::Output {
                execution_id: "completed".into(),
                text: "before\n".into(),
            },
        )
        .unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER fail_log BEFORE INSERT ON execution_logs WHEN NEW.text='reject' BEGIN SELECT RAISE(ABORT,'injected failure'); END;
        CREATE TRIGGER fail_log_update BEFORE UPDATE ON execution_logs WHEN NEW.text LIKE '%reject%' BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    assert!(store
        .append_batch(
            &mut state,
            vec![
                EventKind::Output {
                    execution_id: "completed".into(),
                    text: "reject".into()
                },
                EventKind::Output {
                    execution_id: "other".into(),
                    text: "also rollback".into()
                },
            ]
        )
        .is_err());
    assert_eq!(state.executions[0].output, "before\n");
    assert_eq!(store.log_bytes("run", "completed").unwrap(), 7);
    assert_eq!(store.log_bytes("run", "other").unwrap(), 0);
    db.execute_batch("DROP TRIGGER fail_log; DROP TRIGGER fail_log_update;")
        .unwrap();
    store
        .append(
            &mut state,
            EventKind::Output {
                execution_id: "completed".into(),
                text: "after𠀀\n".into(),
            },
        )
        .unwrap();
    assert_eq!(
        store
            .execution_log_page("run", "completed", 0, usize::MAX)
            .unwrap()
            .content,
        "before\nafter𠀀\n"
    );
    assert_eq!(
        store.log_bytes("run", "completed").unwrap(),
        state.executions[0].output.len()
    );
}

#[test]
fn small_output_batches_fill_bounded_chunks_across_reopens_without_changing_byte_cursors() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let mut store = Store::open(&path).unwrap();
    let mut state = Snapshot {
        run_id: "run".into(),
        ..Default::default()
    };
    store
        .append(&mut state, created("repo", None, None))
        .unwrap();
    for id in ["completed", "live"] {
        store
            .append(
                &mut state,
                EventKind::Started {
                    execution: execution(id),
                    message_sequences: None,
                    fresh_restart: false,
                },
            )
            .unwrap();
    }
    let mut expected = String::new();
    let mut saved_cursor = 0;
    for i in 0..512 {
        let text = format!("{i}:中文𠀀\n").repeat(12);
        store
            .append_batch(
                &mut state,
                vec![
                    EventKind::Output {
                        execution_id: "completed".into(),
                        text: text.clone(),
                    },
                    EventKind::Output {
                        execution_id: "live".into(),
                        text: "other\n".into(),
                    },
                ],
            )
            .unwrap();
        expected.push_str(&text);
        if i == 0 {
            saved_cursor = expected.len();
        }
        if i % 64 == 0 {
            store = Store::open(&path).unwrap();
        }
    }
    let db = Connection::open(&path).unwrap();
    let rows: usize = db
        .query_row(
            "SELECT COUNT(*) FROM execution_logs WHERE execution_id='completed'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        rows <= expected.len() / (32 * 1024 - 3) + 1,
        "small writes left {rows} permanent rows"
    );
    let mut previous = 0;
    let mut statement = db.prepare("SELECT offset,bytes,text FROM execution_logs WHERE execution_id='completed' ORDER BY offset").unwrap();
    for row in statement
        .query_map([], |r| {
            Ok((
                r.get::<_, usize>(0)?,
                r.get::<_, usize>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
    {
        let (offset, bytes, text) = row.unwrap();
        assert_eq!(offset, previous);
        assert_eq!(bytes, text.len());
        assert!(bytes <= 32 * 1024);
        previous += bytes;
    }
    assert_eq!(previous, expected.len());
    assert_eq!(
        store
            .execution_log_page("run", "completed", 0, usize::MAX)
            .unwrap()
            .content,
        expected
    );
    assert_eq!(
        store
            .execution_log_page("run", "completed", saved_cursor, usize::MAX)
            .unwrap()
            .content,
        expected[saved_cursor..]
    );
    assert_eq!(
        store
            .execution_log_page("run", "live", 0, usize::MAX)
            .unwrap()
            .content,
        "other\n".repeat(512)
    );
    let tail = store
        .execution_log_tail_page("run", "completed", saved_cursor, 32 * 1024)
        .unwrap();
    assert_eq!(tail.content, expected[..saved_cursor]);
}

#[test]
fn delete_run_releases_incremental_pages_and_cascades_logs() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let mut store = Store::open(&path).unwrap();
    let mut state = Snapshot {
        run_id: "run".into(),
        ..Default::default()
    };
    store
        .append(&mut state, created("repo", None, None))
        .unwrap();
    store
        .append(
            &mut state,
            EventKind::Started {
                execution: execution("completed"),
                message_sequences: None,
                fresh_restart: false,
            },
        )
        .unwrap();
    for batch in 0..8 {
        store
            .append_batch(
                &mut state,
                (0..32)
                    .map(|i| EventKind::Output {
                        execution_id: "completed".into(),
                        text: format!("{batch}-{i}-{}", "y".repeat(64 * 1024)),
                    })
                    .collect(),
            )
            .unwrap();
    }
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("PRAGMA auto_vacuum", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    let before_pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    let before_size = std::fs::metadata(&path).unwrap().len();
    let log_rows: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM execution_logs WHERE run_id='run'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(log_rows > 0);
    store.delete_run("run").unwrap();
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    let after_pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    let after_free: i64 = db
        .query_row("PRAGMA freelist_count", [], |r| r.get(0))
        .unwrap();
    let after_size = std::fs::metadata(&path).unwrap().len();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM execution_logs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM events WHERE run_id='run'", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM checkpoints WHERE run_id='run'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    // Step the PRAGMA until all free pages or the 4096-page budget are exhausted.
    assert!(
        after_pages < before_pages,
        "incremental_vacuum did not release pages: {before_pages} -> {after_pages}"
    );
    assert!(
        after_free == 0 || before_pages - after_pages >= 4096,
        "vacuum stopped before its page budget: reclaimed {}, remaining {after_free}",
        before_pages - after_pages
    );
    assert!(
        after_size < before_size,
        "file did not shrink: {before_size} -> {after_size}"
    );
    assert!(
        after_free >= 0 && after_free < after_pages,
        "freelist must not cover the live database"
    );
}

#[test]
fn transcript_events_and_mixed_batches_roll_back_logs_state_and_cursors_together() {
    for batched in [false, true] {
        for form in ["started", "finished", "output"] {
            if !batched && form == "output" {
                continue; // Pure output rollback is covered above.
            }
            let temp = TempDir::new().unwrap();
            let path = temp.path().join("events.db");
            let mut store = Store::open(&path).unwrap();
            let mut state = Snapshot {
                run_id: "run".into(),
                ..Default::default()
            };
            store
                .append(&mut state, created("repo", None, None))
                .unwrap();
            store
                .append(
                    &mut state,
                    EventKind::Started {
                        execution: execution("completed"),
                        message_sequences: None,
                        fresh_restart: false,
                    },
                )
                .unwrap();
            store
                .append(
                    &mut state,
                    EventKind::Output {
                        execution_id: "completed".into(),
                        text: "original 中文\n".into(),
                    },
                )
                .unwrap();
            let kind = match form {
                "started" => {
                    let mut exec = execution("live");
                    exec.output = "imported 𠀀\n".into();
                    EventKind::Started {
                        execution: exec,
                        message_sequences: None,
                        fresh_restart: false,
                    }
                }
                "finished" => EventKind::Finished {
                    execution_id: "completed".into(),
                    head: "head".into(),
                    output: "replacement 𠀀\n".into(),
                    output_bytes: 0,
                    metrics: None,
                },
                _ => EventKind::Output {
                    execution_id: "completed".into(),
                    text: "suffix 𠀀\n".into(),
                },
            };
            let before = serde_json::to_value(&state).unwrap();
            let db = Connection::open(&path).unwrap();
            db.execute_batch(if batched {
                "CREATE TRIGGER reject_event BEFORE INSERT ON events WHEN NEW.kind='paused' AND json_extract(NEW.payload,'$.paused')=0 BEGIN SELECT RAISE(ABORT,'injected failure'); END;"
            } else {
                "CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected failure'); END;"
            }).unwrap();
            let result = if batched {
                store.append_batch(
                    &mut state,
                    vec![
                        EventKind::Paused { paused: true },
                        kind.clone(),
                        EventKind::Paused { paused: false },
                    ],
                )
            } else {
                store.append(&mut state, kind.clone())
            };
            assert!(result.is_err(), "{form}, batched={batched}");
            assert_eq!(
                serde_json::to_value(&state).unwrap(),
                before,
                "{form}, batched={batched}"
            );
            assert_eq!(
                store
                    .execution_log_page("run", "completed", 0, usize::MAX)
                    .unwrap()
                    .content,
                "original 中文\n",
                "{form}, batched={batched}"
            );
            assert_eq!(
                store.log_bytes("run", "live").unwrap(),
                0,
                "failed start must not import a log"
            );
            assert_eq!(store.load("run").unwrap().events.len(), state.events.len());
            db.execute_batch("DROP TRIGGER reject_event").unwrap();
            store
                .append(
                    &mut state,
                    EventKind::Output {
                        execution_id: "completed".into(),
                        text: "after\n".into(),
                    },
                )
                .unwrap();
            assert_eq!(
                store
                    .execution_log_page("run", "completed", 0, usize::MAX)
                    .unwrap()
                    .content,
                "original 中文\nafter\n"
            );
            if batched {
                store
                    .append_batch(
                        &mut state,
                        vec![
                            EventKind::Paused { paused: true },
                            kind,
                            EventKind::Paused { paused: false },
                        ],
                    )
                    .unwrap();
            } else {
                store.append(&mut state, kind).unwrap();
            }
            let expected = match form {
                "finished" => "replacement 𠀀\n",
                "output" => "original 中文\nafter\nsuffix 𠀀\n",
                _ => "original 中文\nafter\n",
            };
            assert_eq!(
                store
                    .execution_log_page("run", "completed", 0, usize::MAX)
                    .unwrap()
                    .content,
                expected
            );
            if form == "started" {
                assert_eq!(state.executions.last().unwrap().output, "imported 𠀀\n");
                assert_eq!(
                    store
                        .execution_log_page("run", "live", 0, usize::MAX)
                        .unwrap()
                        .content,
                    "imported 𠀀\n"
                );
            }
            assert_eq!(store.load("run").unwrap().events.len(), state.events.len());
        }
    }
}

#[test]
fn failed_workspace_deletion_preserves_live_change_accumulators_until_commit() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let store = Store::open(&path).unwrap();
    let mut states = Vec::new();
    for _ in 0..2 {
        let mut state = Snapshot {
            run_id: uuid::Uuid::new_v4().to_string(),
            ..Default::default()
        };
        store
            .append(&mut state, created("/repo", None, None))
            .unwrap();
        let mut exec = execution("completed");
        exec.id = uuid::Uuid::new_v4().to_string();
        exec.worktree = "/repo".into();
        store
            .append(
                &mut state,
                EventKind::Started {
                    execution: exec.clone(),
                    message_sequences: None,
                    fresh_restart: false,
                },
            )
            .unwrap();
        let text = format!(
            "{}\n",
            serde_json::json!({"type":"tool_execution_start", "toolCallId":"pending", "toolName":"write", "args":{"path":"pending.txt", "content":"not completed"}})
        );
        store
            .append(
                &mut state,
                EventKind::Output {
                    execution_id: exec.id.clone(),
                    text,
                },
            )
            .unwrap();
        assert_eq!(
            grapher::file_changes::get_cached_execution_changes(&state.run_id, &exec)
                .unwrap()
                .total_files,
            1
        );
        states.push(state);
    }
    let db = Connection::open(&path).unwrap();
    db.execute_batch(&format!("CREATE TRIGGER reject_delete BEFORE DELETE ON events WHEN OLD.run_id='{}' BEGIN SELECT RAISE(ABORT,'injected deletion failure'); END;", states[1].run_id)).unwrap();
    let cleanups = states
        .iter()
        .map(|state| (state.run_id.clone(), grapher::cleanup::Manifest::default()))
        .collect::<Vec<_>>();
    assert!(store.delete_runs_with_cleanup(&cleanups).is_err());
    for state in &states {
        assert!(store.load(&state.run_id).is_ok());
        let cached = grapher::file_changes::get_cached_execution_changes(
            &state.run_id,
            &state.executions[0],
        );
        assert_eq!(
            cached.unwrap().total_files,
            1,
            "rollback must retain in-flight tool tracking"
        );
    }
    db.execute_batch("DROP TRIGGER reject_delete").unwrap();
    store.delete_runs_with_cleanup(&cleanups).unwrap();
    for state in &states {
        assert!(store.load(&state.run_id).is_err());
        assert!(grapher::file_changes::get_cached_execution_changes(
            &state.run_id,
            &state.executions[0]
        )
        .is_none());
    }
}

#[test]
fn clearing_one_store_does_not_reset_another_stores_live_tool_tracking() {
    let temp = TempDir::new().unwrap();
    let owner = Store::open(&temp.path().join("owner.db")).unwrap();
    let mut state = Snapshot {
        run_id: uuid::Uuid::new_v4().to_string(),
        ..Default::default()
    };
    owner
        .append(&mut state, created("/repo", None, None))
        .unwrap();
    let mut exec = execution("completed");
    exec.id = uuid::Uuid::new_v4().to_string();
    exec.worktree = "/repo".into();
    owner
        .append(
            &mut state,
            EventKind::Started {
                execution: exec.clone(),
                message_sequences: None,
                fresh_restart: false,
            },
        )
        .unwrap();
    owner.append(&mut state, EventKind::Output {
        execution_id: exec.id.clone(),
        text: format!("{}\n", serde_json::json!({"type":"tool_execution_start", "toolCallId":"pending", "toolName":"write", "args":{"path":"pending.txt", "content":"not completed"}})),
    }).unwrap();
    let unrelated = Store::open(&temp.path().join("unrelated.db")).unwrap();
    unrelated.clear().unwrap();
    assert_eq!(
        grapher::file_changes::get_cached_execution_changes(&state.run_id, &exec)
            .unwrap()
            .total_files,
        1
    );
    owner.clear().unwrap();
    assert!(grapher::file_changes::get_cached_execution_changes(&state.run_id, &exec).is_none());
}

#[test]
#[ignore = "large synthetic load; run with --release --ignored"]
fn metadata_load_performance_budgets() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let store = Store::open(&path).unwrap();
    let mut state = Snapshot {
        run_id: "history".into(),
        ..Default::default()
    };
    store
        .append(&mut state, created("repo", None, None))
        .unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<889999)
        INSERT INTO execution_logs SELECT 'history','huge', x*128,128,printf('%0128d',x) FROM n;",
    )
    .unwrap();
    let start = std::time::Instant::now();
    let loaded = store.load("history").unwrap();
    let history_elapsed = start.elapsed();
    eprintln!("890,000 log blocks (~109 MiB), metadata load: {history_elapsed:?}");
    assert!(
        history_elapsed.as_millis() < 50,
        "history load: {history_elapsed:?}"
    );
    assert_eq!(loaded.events.len(), 1);
    state.run_id = "business".into();
    state.events.clear();
    store
        .append(&mut state, created("repo", None, None))
        .unwrap();
    for _ in 0..10_000 {
        store
            .append(&mut state, EventKind::Paused { paused: true })
            .unwrap();
    }
    let start = std::time::Instant::now();
    assert_eq!(store.load("business").unwrap().events.len(), 10_001);
    let business_elapsed = start.elapsed();
    eprintln!("10,001 business events + checkpoint, metadata load: {business_elapsed:?}");
    assert!(
        business_elapsed.as_millis() < 100,
        "business load: {business_elapsed:?}"
    );
}
