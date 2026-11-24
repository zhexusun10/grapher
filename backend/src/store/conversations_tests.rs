use super::*;
use crate::{
    model::{Config, EventKind, Execution, Graph},
    store::Store,
};

struct Fixture {
    path: PathBuf,
    store: Store,
    _directory: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let store = Store::open(&path).unwrap();
        Self {
            path,
            store,
            _directory: directory,
        }
    }
    fn create(&self, id: &str, repository: &str, title: &str) -> Snapshot {
        let config: Config = serde_json::from_value(serde_json::json!({
            "repository": repository, "model": "test/model", "maxParallel": 1
        }))
        .unwrap();
        let mut state = Snapshot {
            run_id: id.into(),
            ..Default::default()
        };
        self.store
            .append(
                &mut state,
                EventKind::Created {
                    graph: Graph {
                        original_goal: title.into(),
                        ..Default::default()
                    },
                    config,
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();
        state
    }
    fn summaries(&self) -> Vec<ConversationSummary> {
        conversation_summaries(&self.path).unwrap().conversations
    }
    fn check(&self, state: &Snapshot) {
        let summaries = self.summaries();
        let summary = summaries
            .iter()
            .find(|summary| summary.run_id == state.run_id)
            .unwrap();
        let loaded = self.store.load(&state.run_id).unwrap();
        assert_eq!(summary.phase, loaded.phase);
        let expected_title = loaded
            .title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or(&loaded.graph.original_goal);
        assert_eq!(summary.title, expected_title);
        assert_eq!(summary.repository, loaded.config.unwrap().repository);
        let active = loaded
            .executions
            .iter()
            .chain(&loaded.mergers)
            .any(|e| e.status == "running")
            || loaded.nodes.values().any(|n| n.status == "running")
            || loaded
                .result_execution
                .as_ref()
                .is_some_and(|e| e.status == "running");
        assert_eq!(summary.has_active_executions, active);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        forget_catalog(&self.path);
    }
}

fn execution(id: &str, node: &str) -> Execution {
    serde_json::from_value(serde_json::json!({
        "id": id, "node": node, "revision": 0, "attempt": 1, "sessionId": id,
        "worktree": "/repo", "before": "base", "after": null, "status": "running", "startedAt": 1,
        "completedAt": null
    }))
    .unwrap()
}

#[test]
fn sidebar_summaries_never_materialize_current_logs() {
    let fixture = Fixture::new();
    fixture.create("first", "C:/Alpha", "First");
    fixture.create("second", "/beta", "");
    fixture.create("unbound", "", "Not a workspace");
    let connection = Connection::open(&fixture.path).unwrap();
    let text = format!("broken log JSON {}", "x".repeat(2 * 1024 * 1024));
    connection.execute(
        "INSERT INTO execution_logs(run_id,execution_id,offset,bytes,text) VALUES('first','log',0,?1,?2)",
        rusqlite::params![text.len(),text],
    ).unwrap();
    let summaries = fixture.summaries();
    assert_eq!(
        summaries
            .iter()
            .map(|s| s.run_id.as_str())
            .collect::<Vec<_>>(),
        ["second", "first"]
    );
    assert_eq!(summaries[1].repository, "C:/Alpha");
    assert_eq!(summaries[1].title, "First");
    assert_eq!(summaries[0].title, "");
}

#[test]
fn sidebar_cache_refreshes_after_commits_from_another_store_and_deletion() {
    let fixture = Fixture::new();
    let mut state = fixture.create("one", "/old", "Old goal");
    fixture.check(&state);
    assert_eq!(fixture.summaries()[0].title, "Old goal");
    let other = Store::open(&fixture.path).unwrap();
    let mut config = state.config.clone().unwrap();
    config.repository = "/new".into();
    other
        .append(
            &mut state,
            EventKind::DraftEdited {
                graph: Graph {
                    original_goal: "Edited goal".into(),
                    ..Default::default()
                },
                config,
            },
        )
        .unwrap();
    fixture.check(&state);
    assert_eq!(fixture.summaries()[0].plan_type.as_deref(), Some("graph"));
    let connection = Connection::open(&fixture.path).unwrap();
    connection
        .execute("INSERT INTO deleted_runs(run_id) VALUES('one')", [])
        .unwrap();
    assert!(fixture.summaries().is_empty());
    connection
        .execute_batch("DELETE FROM events; DELETE FROM deleted_runs;")
        .unwrap();
    assert!(fixture.summaries().is_empty());
    fixture.create("replacement", "/replacement", "New after cleanup");
    assert_eq!(fixture.summaries()[0].run_id, "replacement");
}

#[test]
fn sidebar_status_matches_reducer_including_standalone_mergers_and_dirty_nodes() {
    let fixture = Fixture::new();
    let mut state = fixture.create("status", "/repo", "Status");
    let graph: Graph = serde_json::from_value(serde_json::json!({
        "originalGoal": "Status", "nodes": [{"id":"worker", "task":"Work"}], "edges":[]
    }))
    .unwrap();
    let config = state.config.clone().unwrap();
    for kind in [
        EventKind::DraftEdited { graph, config },
        EventKind::Approved {
            base: "base".into(),
        },
        EventKind::Started {
            execution: execution("node", "worker"),
            message_sequences: Some(vec![]),
            fresh_restart: false,
        },
        // Pause intent does not make a draining execution idle.
        EventKind::Paused { paused: true },
        EventKind::Finished {
            execution_id: "node".into(),
            head: "head".into(),
            output: String::new(),
            output_bytes: 0,
            metrics: None,
        },
        EventKind::Paused { paused: false },
        EventKind::Settled,
        // Completed Run + running standalone Merger must still be watched.
        EventKind::MergerStarted {
            execution: execution("standalone", "merger"),
        },
        EventKind::MergerFinished {
            execution_id: "standalone".into(),
            head: "head".into(),
            output_bytes: 0,
            metrics: None,
        },
        EventKind::PublicationStarted {
            repository: "/repo".into(),
            heads: vec!["head".into()],
        },
        EventKind::MergerStarted {
            execution: execution("publication", "merger"),
        },
        EventKind::MergerFailed {
            execution_id: "publication".into(),
            error: "conflict".into(),
            output_bytes: 0,
            metrics: None,
        },
        EventKind::PublicationFailed {
            error: "conflict".into(),
        },
        EventKind::PublicationCompleted {
            head: "published".into(),
        },
        EventKind::Invalidated {
            nodes: vec!["worker".into()],
            target: "worker".into(),
            instruction: "Follow-up".into(),
            human: true,
            request_id: None,
            images: None,
            workspace: None,
            shared_workspace: false,
            source_direct: true,
        },
        EventKind::Paused { paused: true },
    ] {
        fixture.store.append(&mut state, kind).unwrap();
        fixture.check(&state);
    }
    assert!(state.paused);
    assert_eq!(state.nodes["worker"].status, "dirty");
    assert!(!fixture.summaries()[0].has_active_executions);
}

#[test]
fn sidebar_title_edits_use_the_canonical_reducer() {
    let fixture = Fixture::new();
    let mut state = fixture.create("serial", "/repo", "Original");
    let config = state.config.clone().unwrap();
    let graph: Graph = serde_json::from_value(serde_json::json!({
        "originalGoal": "Original", "nodes": [{"id":"worker", "task":"Work"}], "edges":[]
    }))
    .unwrap();
    fixture
        .store
        .append(&mut state, EventKind::DraftEdited { graph, config })
        .unwrap();
    fixture
        .store
        .append(
            &mut state,
            EventKind::Routed {
                plan_type: "serial".into(),
                images: None,
            },
        )
        .unwrap();
    fixture
        .store
        .append(
            &mut state,
            EventKind::Started {
                execution: execution("anchor", "worker"),
                message_sequences: Some(vec![]),
                fresh_restart: false,
            },
        )
        .unwrap();
    for first_turn in [false, true] {
        fixture
            .store
            .append(
                &mut state,
                EventKind::ConversationEdited {
                    nodes: vec!["worker".into()],
                    target: "worker".into(),
                    instruction: "Edited".into(),
                    images: None,
                    from_execution_id: "anchor".into(),
                    from_event_sequence: 1,
                    from_output_offset: Some(17),
                    old_instruction: "Original".into(),
                    first_turn,
                    selected_version: None,
                },
            )
            .unwrap();
        fixture.check(&state);
    }
    fixture
        .store
        .append(
            &mut state,
            EventKind::PlannerConversationEdited {
                instruction: "Planner first turn".into(),
                old_instruction: "Original".into(),
                first_turn: true,
                selected_version: None,
            },
        )
        .unwrap();
    fixture.check(&state);
}

#[test]
fn sidebar_isolates_corrupt_runs_and_recovers_after_the_bad_row_is_removed() {
    let fixture = Fixture::new();
    fixture.create("healthy", "/repo", "Healthy");
    fixture.create("damaged", "/other", "Damaged");
    let connection = Connection::open(&fixture.path).unwrap();
    connection.execute("INSERT INTO events(run_id,timestamp,kind,payload) VALUES('damaged',1,'created','invalid JSON')", []).unwrap();
    let bad_row = connection.last_insert_rowid();
    let catalog = conversation_summaries(&fixture.path).unwrap();
    assert_eq!(catalog.conversations.len(), 1);
    assert_eq!(catalog.conversations[0].run_id, "healthy");
    assert_eq!(catalog.unavailable_run_ids, ["damaged"]);
    connection
        .execute("DELETE FROM events WHERE sequence=?1", [bad_row])
        .unwrap();
    let catalog = conversation_summaries(&fixture.path).unwrap();
    assert_eq!(catalog.conversations.len(), 2);
    assert!(catalog.unavailable_run_ids.is_empty());
    // A valid JSON event with an invalid reference must also stay isolated.
    connection
        .execute(
            "INSERT INTO events(run_id,timestamp,kind,payload) VALUES('damaged',1,'started',?1)",
            [serde_json::to_string(&EventKind::Started {
                execution: execution("missing", "nonexistent"),
                message_sequences: Some(vec![]),
                fresh_restart: false,
            })
            .unwrap()],
        )
        .unwrap();
    assert_eq!(
        conversation_summaries(&fixture.path)
            .unwrap()
            .unavailable_run_ids,
        ["damaged"]
    );
}

#[test]
fn sidebar_summary_reflects_conversation_rename_without_changing_original_goal() {
    let fixture = Fixture::new();
    let mut state = fixture.create("renamed-run", "/repo", "Original prompt");
    fixture.check(&state);
    fixture
        .store
        .append(
            &mut state,
            EventKind::ConversationRenamed {
                title: "Sidebar Custom Title".into(),
            },
        )
        .unwrap();
    fixture.check(&state);
    let loaded = fixture.store.load("renamed-run").unwrap();
    assert_eq!(loaded.graph.original_goal, "Original prompt");
    assert_eq!(loaded.title.as_deref(), Some("Sidebar Custom Title"));
}

#[test]
fn sidebar_summary_truncates_oversized_goal_titles_at_char_boundary() {
    let fixture = Fixture::new();
    let huge_goal = format!("前缀报错：{}", "日志行\n".repeat(40_000));
    fixture.create("huge-goal-run", "/repo", &huge_goal);
    let summary = fixture
        .summaries()
        .into_iter()
        .find(|s| s.run_id == "huge-goal-run")
        .unwrap();
    assert!(summary.title.starts_with("前缀报错："));
    assert!(summary.title.ends_with('…'));
    assert!(summary.title.chars().count() <= MAX_SUMMARY_TITLE_CHARS + 1);
    let loaded = fixture.store.load("huge-goal-run").unwrap();
    assert_eq!(loaded.graph.original_goal, huge_goal);
}

#[test]
fn sidebar_catalog_reopens_replaced_database_file_and_handles_log_only_commits() {
    let directory = tempfile::tempdir().unwrap();
    let db_path = directory.path().join("events.sqlite");
    {
        let store = Store::open(&db_path).unwrap();
        let config: Config = serde_json::from_value(serde_json::json!({
            "repository": "/alpha", "model": "test/model", "maxParallel": 1
        }))
        .unwrap();
        let mut state = Snapshot {
            run_id: "initial-run".into(),
            ..Default::default()
        };
        store
            .append(
                &mut state,
                EventKind::Created {
                    graph: Graph {
                        original_goal: "Initial".into(),
                        ..Default::default()
                    },
                    config,
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();
        assert_eq!(
            conversation_summaries(&db_path).unwrap().conversations[0].run_id,
            "initial-run"
        );
        // Log-only commits advance SQLite data_version without mutating events.
        store
            .append(
                &mut state,
                EventKind::Output {
                    execution_id: "exec-1".into(),
                    text: "streamed chunk\n".into(),
                },
            )
            .unwrap();
        assert_eq!(
            conversation_summaries(&db_path).unwrap().conversations[0].run_id,
            "initial-run"
        );
    }

    // Replace the SQLite file at the same path via rename; the cached connection
    // must detect the new file identity instead of reading the unlinked inode.
    let replacement = directory.path().join("replacement.sqlite");
    {
        let store = Store::open(&replacement).unwrap();
        let config: Config = serde_json::from_value(serde_json::json!({
            "repository": "/beta", "model": "test/model", "maxParallel": 1
        }))
        .unwrap();
        let mut state = Snapshot {
            run_id: "replaced-run".into(),
            ..Default::default()
        };
        store
            .append(
                &mut state,
                EventKind::Created {
                    graph: Graph {
                        original_goal: "Replaced".into(),
                        ..Default::default()
                    },
                    config,
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();
    }
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(directory.path().join(format!("events.sqlite{suffix}")));
    }
    std::fs::rename(&replacement, &db_path).unwrap();

    let summaries = conversation_summaries(&db_path).unwrap().conversations;
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].run_id, "replaced-run");
    assert_eq!(summaries[0].title, "Replaced");
    forget_catalog(&db_path);
}
