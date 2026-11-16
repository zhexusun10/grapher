use grapher::{
    model::{Config, EventKind, Execution, Graph, Node, NodeState, Snapshot},
    store::Store,
};
use rusqlite::Connection;
use tempfile::TempDir;

#[test]
fn node_status_round_trips_current_values_and_rejects_retired_completion() {
    for status in [
        "waiting",
        "running",
        "paused",
        "blocked",
        "completed",
        "failed",
        "dirty",
    ] {
        let mut payload = serde_json::to_value(NodeState::default()).unwrap();
        payload["status"] = status.into();
        let node: NodeState = serde_json::from_value(payload).unwrap();
        assert_eq!(node.status, status);
        assert_eq!(serde_json::to_value(node).unwrap()["status"], status);
    }
    for status in ["done", "unknown"] {
        let mut payload = serde_json::to_value(NodeState::default()).unwrap();
        payload["status"] = status.into();
        assert!(serde_json::from_value::<NodeState>(payload).is_err());
    }
}

#[test]
fn corrupt_checkpoint_replays_current_completion_without_rewriting_evidence() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.sqlite");
    let store = Store::open(&path).unwrap();
    let mut state = Snapshot {
        run_id: "run".into(),
        ..Default::default()
    };
    let config: Config =
        serde_json::from_value(serde_json::json!({"repository":"/repo","model":"test"})).unwrap();
    store
        .append(
            &mut state,
            EventKind::Created {
                graph: Graph {
                    nodes: vec![Node {
                        id: "task".into(),
                        task: "test".into(),
                    }],
                    ..Default::default()
                },
                config,
                planning_id: None,
                planning: None,
            },
        )
        .unwrap();
    let execution: Execution = serde_json::from_value(serde_json::json!({
        "id":"execution","node":"task","revision":1,"attempt":1,"sessionId":"execution",
        "worktree":"/repo","before":"","after":null,"status":"running","output":"",
        "startedAt":1,"completedAt":null
    }))
    .unwrap();
    store
        .append(
            &mut state,
            EventKind::Started {
                execution,
                message_sequences: Some(vec![]),
                fresh_restart: false,
            },
        )
        .unwrap();
    store
        .append(
            &mut state,
            EventKind::Finished {
                execution_id: "execution".into(),
                head: "retained-head".into(),
                output: String::new(),
                output_bytes: 0,
                metrics: None,
            },
        )
        .unwrap();
    let db = Connection::open(&path).unwrap();
    let checkpoint: String = db
        .query_row("SELECT payload FROM checkpoints", [], |row| row.get(0))
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&checkpoint).unwrap();
    value["nodes"]["task"]["status"] = "done".into();
    let corrupted = value.to_string();
    db.execute("UPDATE checkpoints SET payload=?1", [&corrupted])
        .unwrap();
    let events: String = db
        .query_row("SELECT json_group_array(payload) FROM events", [], |row| {
            row.get(0)
        })
        .unwrap();
    let restored = store.load("run").unwrap();
    assert_eq!(restored.nodes["task"].status, "completed");
    assert_eq!(
        restored.nodes["task"].head.as_deref(),
        Some("retained-head")
    );
    assert_eq!(
        db.query_row("SELECT payload FROM checkpoints", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        corrupted
    );
    assert_eq!(
        db.query_row("SELECT json_group_array(payload) FROM events", [], |row| {
            row.get::<_, String>(0)
        })
        .unwrap(),
        events
    );
}
