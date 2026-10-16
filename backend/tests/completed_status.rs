use grapher::{
    model::{EventKind, Graph, Node, NodeState, Snapshot},
    store::Store,
};
use rusqlite::{params, Connection};
use tempfile::TempDir;

#[test]
fn node_status_round_trips_current_values_and_normalizes_legacy_completion() {
    for status in [
        "waiting",
        "running",
        "paused",
        "blocked",
        "completed",
        "failed",
        "dirty",
        "done",
    ] {
        let mut payload = serde_json::to_value(NodeState::default()).unwrap();
        payload["status"] = status.into();
        let node: NodeState = serde_json::from_value(payload).unwrap();
        let expected = if status == "done" {
            "completed"
        } else {
            status
        };
        assert_eq!(node.status, expected);
        assert_eq!(serde_json::to_value(node).unwrap()["status"], expected);
    }
}

#[test]
fn legacy_checkpoint_reopens_as_completed_without_rewriting_persisted_evidence() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let mut state = Snapshot {
        run_id: "legacy-completion".into(),
        plan_type: Some("serial".into()),
        graph: Graph {
            nodes: vec![Node {
                name: "task".into(),
                task: "Keep the saved result".into(),
            }],
            ..Graph::default()
        },
        ..Snapshot::default()
    };
    state.nodes.insert(
        "task".into(),
        NodeState {
            status: "completed".into(),
            head: Some("retained-head".into()),
            ..NodeState::default()
        },
    );
    let store = Store::open(&path).unwrap();
    store.append(&mut state, EventKind::Settled).unwrap();
    let sequence = state.events.last().unwrap().sequence;
    let mut checkpoint = serde_json::to_value(&state).unwrap();
    checkpoint["nodeMessageQueueVersion"] = 1.into();
    checkpoint["nodes"]["task"]["status"] = "done".into();
    let payload = serde_json::to_string(&checkpoint).unwrap();
    drop(store);

    let db = Connection::open(&path).unwrap();
    db.execute(
        "INSERT INTO checkpoints(run_id,sequence,payload) VALUES (?1,?2,?3)",
        params![state.run_id, sequence, payload],
    )
    .unwrap();
    let original_event: String = db
        .query_row(
            "SELECT payload FROM events WHERE sequence=?1",
            [sequence],
            |row| row.get(0),
        )
        .unwrap();
    drop(db);

    let store = Store::open(&path).unwrap();
    let mut restored = store.load(&state.run_id).unwrap();
    assert_eq!(restored.nodes["task"].status, "completed");
    assert_eq!(
        restored.nodes["task"].head.as_deref(),
        Some("retained-head")
    );
    assert_eq!(
        serde_json::to_value(&restored).unwrap()["nodes"]["task"]["status"],
        "completed"
    );
    store.append(&mut restored, EventKind::Settled).unwrap();
    assert_eq!(restored.phase, "completed");
    drop(store);

    let db = Connection::open(&path).unwrap();
    let stored_checkpoint: String = db
        .query_row(
            "SELECT payload FROM checkpoints WHERE run_id=?1",
            [&state.run_id],
            |row| row.get(0),
        )
        .unwrap();
    let stored_event: String = db
        .query_row(
            "SELECT payload FROM events WHERE sequence=?1",
            [sequence],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored_checkpoint, payload);
    assert_eq!(stored_event, original_event);
}
