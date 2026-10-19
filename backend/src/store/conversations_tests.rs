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
        assert_eq!(summary.title, loaded.graph.original_goal);
        assert_eq!(summary.repository, loaded.config.unwrap().repository);
        let active = loaded
            .executions
            .iter()
            .chain(&loaded.mergers)
            .any(|e| e.status == "running")
            || loaded
                .nodes
                .values()
                .any(|n| n.status == "running" || n.status == "dirty")
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
fn sidebar_summaries_never_materialize_legacy_transcripts() {
    let fixture = Fixture::new();
    fixture.create("first", "C:/Alpha", "First");
    fixture.create("second", "/beta", "");
    fixture.create("unbound", "", "Not a workspace");
    let connection = Connection::open(&fixture.path).unwrap();
    // Deliberately invalid log JSON must never be parsed. Large legacy Finished
    // records are read from the metadata prefix, not their transcript bodies.
    for payload in [
        "{\"type\":\"output\",broken legacy transcript".into(),
        format!(
            "{{\"type\":\"finished\",\"execution_id\":\"old\",\"head\":\"head\",\"output\":\"{}",
            "x".repeat(8192)
        ),
    ] {
        connection
            .execute(
                "INSERT INTO events(run_id,timestamp,kind,payload) VALUES('first',1,NULL,?1)",
                [payload],
            )
            .unwrap();
    }
    connection
        .execute("UPDATE events SET kind=NULL WHERE kind='created'", [])
        .unwrap();
    let summaries = fixture.summaries();
    assert_eq!(
        summaries
            .iter()
            .map(|s| s.run_id.as_str())
            .collect::<Vec<_>>(),
        ["first", "second"]
    );
    assert_eq!(summaries[0].repository, "C:/Alpha");
    assert_eq!(summaries[0].title, "First");
    assert_eq!(summaries[1].title, "");
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
        "originalGoal": "Status", "nodes": [{"name":"worker", "task":"Work"}], "edges":[]
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
            message_sequences: None,
            fresh_restart: false,
        },
        EventKind::Finished {
            execution_id: "node".into(),
            head: "head".into(),
            output: String::new(),
            output_bytes: 0,
            metrics: None,
        },
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
}

#[test]
fn sidebar_title_edits_use_the_canonical_reducer() {
    let fixture = Fixture::new();
    let mut state = fixture.create("serial", "/repo", "Original");
    let config = state.config.clone().unwrap();
    let graph: Graph = serde_json::from_value(serde_json::json!({
        "originalGoal": "Original", "nodes": [{"name":"worker", "task":"Work"}], "edges":[]
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
            },
        )
        .unwrap();
    fixture
        .store
        .append(
            &mut state,
            EventKind::Started {
                execution: execution("anchor", "worker"),
                message_sequences: None,
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
                message_sequences: None,
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
