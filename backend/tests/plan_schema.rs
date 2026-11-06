use grapher::{
    compiler::compile,
    model::{Config, Edge, EventKind, Graph, Node, Plan, Snapshot},
    snapshot_view::snapshot_metadata,
    store::Store,
};
use rusqlite::{params, Connection};
use serde_json::json;
use tempfile::TempDir;

fn graph() -> Graph {
    Graph {
        original_goal: "Build and review".into(),
        nodes: ["build", "review", "independent"]
            .into_iter()
            .map(|name| Node {
                name: name.into(),
                task: name.into(),
            })
            .collect(),
        edges: vec![Edge {
            from: "build".into(),
            to: "review".into(),
            feedback: false,
        }],
    }
}

#[test]
fn plan_serializes_root_nodes_and_accepts_legacy_roots() {
    let plan = compile(&graph(), true).unwrap();
    assert_eq!(plan.root_nodes, vec!["build", "independent"]);
    let canonical = serde_json::to_value(&plan).unwrap();
    assert_eq!(canonical["rootNodes"], json!(["build", "independent"]));
    assert!(canonical.get("roots").is_none());

    let mut legacy = canonical.clone();
    let fields = legacy.as_object_mut().unwrap();
    let roots = fields.remove("rootNodes").unwrap();
    fields.insert("roots".into(), roots);
    let restored: Plan = serde_json::from_value(legacy).unwrap();
    assert_eq!(restored.root_nodes, plan.root_nodes);
    assert_eq!(serde_json::to_value(restored).unwrap(), canonical);
    assert!(serde_json::from_value::<Plan>(json!({
        "executionBatches": [], "terminals": [], "warnings": []
    }))
    .is_err());
}

#[test]
fn checkpoint_with_legacy_roots_loads_without_rewriting_events() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.sqlite");
    let store = Store::open(&path).unwrap();
    let mut state = Snapshot {
        run_id: "legacy-plan".into(),
        ..Default::default()
    };
    let config: Config = serde_json::from_value(json!({
        "repository": "/repo", "model": "test", "maxParallel": 1
    }))
    .unwrap();
    store
        .append(
            &mut state,
            EventKind::Created {
                graph: graph(),
                config,
                planning_id: None,
                planning: None,
            },
        )
        .unwrap();

    let mut checkpoint = serde_json::to_value(&state).unwrap();
    checkpoint["nodeMessageQueueVersion"] = json!(1);
    checkpoint["events"] = json!([]);
    checkpoint["base"] = json!("loaded-from-checkpoint");
    let fields = checkpoint["plan"].as_object_mut().unwrap();
    let roots = fields.remove("rootNodes").unwrap();
    fields.insert("roots".into(), roots);
    let decoded: Snapshot = serde_json::from_value(checkpoint.clone()).unwrap();
    assert_eq!(
        decoded.plan.unwrap().root_nodes,
        vec!["build", "independent"]
    );

    let db = Connection::open(&path).unwrap();
    let event_before: String = db
        .query_row(
            "SELECT payload FROM events WHERE run_id=?1",
            [&state.run_id],
            |row| row.get(0),
        )
        .unwrap();
    db.execute(
        "INSERT OR REPLACE INTO checkpoints(run_id,sequence,payload) VALUES(?1,?2,?3)",
        params![
            state.run_id,
            state.events.last().unwrap().sequence,
            checkpoint.to_string()
        ],
    )
    .unwrap();
    let loaded = store.load(&state.run_id).unwrap();
    assert_eq!(
        loaded.base, "loaded-from-checkpoint",
        "must load the checkpoint rather than silently replaying"
    );
    assert_eq!(
        loaded.plan.as_ref().unwrap().root_nodes,
        vec!["build", "independent"]
    );
    let metadata = snapshot_metadata(&loaded).unwrap();
    assert_eq!(
        metadata["plan"]["rootNodes"],
        json!(["build", "independent"])
    );
    assert!(metadata["plan"].get("roots").is_none());
    let event_after: String = db
        .query_row(
            "SELECT payload FROM events WHERE run_id=?1",
            [&state.run_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        event_after, event_before,
        "legacy reads must not rewrite business events"
    );
}
