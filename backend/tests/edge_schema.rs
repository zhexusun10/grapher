use grapher::{model::*, store::Store};
use rusqlite::{params, Connection};
use serde_json::json;
use tempfile::TempDir;

#[test]
fn edges_roundtrip_with_only_endpoints_and_feedback() {
    for feedback in [false, true] {
        let value = json!({ "from": "review", "to": "owner", "feedback": feedback });
        let edge: Edge = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(edge.from, "review");
        assert_eq!(edge.to, "owner");
        assert_eq!(edge.feedback, feedback);
        assert_eq!(serde_json::to_value(edge).unwrap(), value);
    }
}

#[test]
fn legacy_relation_is_discarded_without_relaxing_edge_validation() {
    let canonical = json!({ "from": "review", "to": "owner", "feedback": true });
    for relation in [json!("Request a revision"), json!(null)] {
        let mut legacy = canonical.clone();
        legacy["relation"] = relation;
        let edge: Edge = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(edge).unwrap(), canonical);
        legacy["unexpected"] = json!("not an edge field");
        assert!(serde_json::from_value::<Edge>(legacy).is_err());
    }
    for field in ["from", "to", "feedback"] {
        let mut missing = canonical.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<Edge>(missing).is_err());
    }
}

#[test]
fn legacy_graph_events_and_checkpoints_replay_without_relation() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.sqlite");
    let store = Store::open(&path).unwrap();
    let mut state = Snapshot { run_id: "legacy".into(), ..Default::default() };
    let graph = Graph {
        original_goal: "Review the implementation".into(),
        nodes: ["owner", "review"].into_iter()
            .map(|name| Node { name: name.into(), task: name.into() }).collect(),
        edges: vec![
            Edge { from: "owner".into(), to: "review".into(), feedback: false },
            Edge { from: "review".into(), to: "owner".into(), feedback: true },
        ],
    };
    let config: Config = serde_json::from_value(json!({
        "repository": "/repo", "model": "test", "maxParallel": 1
    })).unwrap();
    for kind in [
        EventKind::Created {
            graph: graph.clone(), config: config.clone(), planning_id: None, planning: None,
        },
        EventKind::DraftEdited { graph: graph.clone(), config },
        EventKind::GraphRevised {
            graph: graph.clone(), planning_id: "revision".into(),
            planning: PlanningSummary { planning_id: "revision".into(), ..Default::default() },
            invalidated: vec![], source_head: None,
        },
    ] {
        store.append(&mut state, kind).unwrap();
    }
    let expected_events = serde_json::to_value(&state.events).unwrap();
    let db = Connection::open(&path).unwrap();
    assert_eq!(db.execute(
        "UPDATE events SET payload=json_set(payload,
            '$.graph.edges[0].relation', 'legacy dependency',
            '$.graph.edges[1].relation', 'legacy feedback') WHERE run_id=?1",
        [&state.run_id],
    ).unwrap(), 3);
    drop(store);
    let store = Store::open(&path).unwrap();
    let mut checkpoint = serde_json::to_value(&state).unwrap();
    checkpoint["events"] = json!([]);
    for edge in checkpoint["graph"]["edges"].as_array_mut().unwrap() {
        edge["relation"] = json!("legacy description");
    }
    // Checkpoint decoding must succeed, not merely fall back to event replay.
    assert_eq!(serde_json::from_value::<Snapshot>(checkpoint.clone()).unwrap().graph, graph);
    for use_checkpoint in [false, true] {
        if use_checkpoint {
            db.execute("INSERT INTO checkpoints(run_id,sequence,payload) VALUES(?1,?2,?3)",
                params![state.run_id, state.events.last().unwrap().sequence, checkpoint.to_string()],
            ).unwrap();
        }
        let loaded = store.load(&state.run_id).unwrap();
        assert_eq!(loaded.graph, graph);
        assert_eq!(serde_json::to_value(&loaded.graph).unwrap(), serde_json::to_value(&graph).unwrap());
        assert_eq!(serde_json::to_value(&loaded.events).unwrap(), expected_events);
        assert_eq!(loaded.plan.unwrap().execution_batches, state.plan.as_ref().unwrap().execution_batches);
    }
    // Compatibility is read-only: historical business events are not migrated.
    let preserved: usize = db.query_row(
        "SELECT COUNT(*) FROM events WHERE json_extract(payload,'$.graph.edges[0].relation')='legacy dependency'",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(preserved, 3);
}
