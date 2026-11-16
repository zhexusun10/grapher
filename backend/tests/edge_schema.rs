use grapher::{model::*, store::Store};
use rusqlite::{params, Connection};
use serde_json::json;
use tempfile::TempDir;

#[test]
fn nodes_use_only_id_and_task() {
    let value = json!({ "id": "review", "task": "Review name stays literal" });
    let node: Node = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(node.id, "review");
    assert_eq!(serde_json::to_value(node).unwrap(), value);
    for invalid in [
        json!({ "name": "review", "task": "Review" }),
        json!({ "id": "review", "name": "review", "task": "Review" }),
        json!({ "id": "review", "task": "Review", "feedback": true }),
    ] {
        assert!(serde_json::from_value::<Node>(invalid).is_err());
    }
}

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
fn edges_reject_retired_and_unknown_fields_and_missing_required_fields() {
    let canonical = json!({ "from": "review", "to": "owner", "feedback": true });
    for field in ["relation", "unexpected"] {
        for value in [json!("description"), json!(null)] {
            let mut invalid = canonical.clone();
            invalid[field] = value;
            assert!(serde_json::from_value::<Edge>(invalid).is_err());
        }
    }
    for field in ["from", "to", "feedback"] {
        let mut missing = canonical.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<Edge>(missing).is_err());
    }
}

#[test]
fn graph_ids_roundtrip_through_events_and_checkpoints() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.sqlite");
    let store = Store::open(&path).unwrap();
    let mut state = Snapshot {
        run_id: "graph-ids".into(),
        ..Default::default()
    };
    let graph = Graph {
        original_goal: "Review the implementation".into(),
        nodes: [
            "owner",
            "review",
            "__proto__",
            "constructor",
            "toString",
            "merger:publication",
            "merge:join",
            "阶段",
        ]
        .into_iter()
        .map(|id| Node {
            id: id.into(),
            task: id.into(),
        })
        .collect(),
        edges: vec![
            Edge {
                from: "owner".into(),
                to: "review".into(),
                feedback: false,
            },
            Edge {
                from: "review".into(),
                to: "owner".into(),
                feedback: true,
            },
        ],
    };
    let config: Config = serde_json::from_value(json!({
        "repository": "/repo", "model": "test", "maxParallel": 1
    }))
    .unwrap();
    for kind in [
        EventKind::Created {
            graph: graph.clone(),
            config: config.clone(),
            planning_id: None,
            planning: None,
        },
        EventKind::DraftEdited {
            graph: graph.clone(),
            config,
        },
        EventKind::GraphRevised {
            graph: graph.clone(),
            planning_id: "revision".into(),
            planning: PlanningSummary {
                planning_id: "revision".into(),
                ..Default::default()
            },
            invalidated: vec![],
            source_head: None,
        },
    ] {
        store.append(&mut state, kind).unwrap();
    }
    let expected_events = serde_json::to_value(&state.events).unwrap();
    let mut checkpoint = serde_json::to_value(&state).unwrap();
    checkpoint["nodeMessageQueueVersion"] = json!(1);
    checkpoint["events"] = json!([]);
    assert_eq!(checkpoint["graph"]["nodes"][0]["id"], "owner");
    assert!(checkpoint["graph"]["nodes"][0].get("name").is_none());
    let db = Connection::open(&path).unwrap();
    for use_checkpoint in [false, true] {
        if use_checkpoint {
            let sequence = state.events.last().unwrap().sequence;
            db.execute(
                "INSERT INTO checkpoints(run_id,sequence,payload) VALUES(?1,?2,?3)",
                params![state.run_id, sequence, checkpoint.to_string()],
            )
            .unwrap();
            let mut covered_event: serde_json::Value = db
                .query_row(
                    "SELECT payload FROM events WHERE run_id=?1 AND sequence=?2",
                    params![state.run_id, sequence],
                    |row| row.get::<_, String>(0),
                )
                .map(|payload| serde_json::from_str(&payload).unwrap())
                .unwrap();
            covered_event["graph"]["nodes"][0]["id"] = json!("event-only");
            db.execute(
                "UPDATE events SET payload=?1 WHERE run_id=?2 AND sequence=?3",
                params![covered_event.to_string(), state.run_id, sequence],
            )
            .unwrap();
        }
        let loaded = store.load(&state.run_id).unwrap();
        assert_eq!(loaded.graph, graph, "checkpoint={use_checkpoint}");
        if use_checkpoint {
            assert_eq!(
                serde_json::to_value(loaded.events.last().unwrap()).unwrap()["graph"]["nodes"][0]
                    ["id"],
                "event-only",
                "covered events remain available as history",
            );
        } else {
            assert_eq!(
                serde_json::to_value(&loaded.events).unwrap(),
                expected_events
            );
        }
        assert_eq!(
            loaded.plan.unwrap().execution_batches,
            state.plan.as_ref().unwrap().execution_batches
        );
    }
}
