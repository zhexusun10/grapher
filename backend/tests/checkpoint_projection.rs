use grapher::{model::*, store::Store};
use rusqlite::Connection;
use tempfile::TempDir;

fn execution(id: &str, node: &str) -> Execution {
    Execution {
        id: id.into(), node: node.into(), revision: 1, attempt: 1,
        session_id: id.into(), worktree: String::new(), before: String::new(),
        after: None, status: "running".into(), output: "initial\n".into(),
        started_at: 1, completed_at: None, metrics: None,
    }
}

#[test]
fn compact_checkpoints_preserve_full_replay_and_do_not_grow_with_streams() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let mut store = Store::open(&path).unwrap();
    assert!(store.load("missing").is_err());
    let mut state = Snapshot { run_id: "run".into(), ..Default::default() };
    let config = serde_json::from_value(serde_json::json!({
        "repository": "/repo", "model": "test", "maxParallel": 1
    })).unwrap();
    store.append(&mut state, EventKind::Created {
        graph: Graph { nodes: vec![Node { name: "task".into(), task: "test".into() }], ..Default::default() },
        config, planning_id: None, planning: None,
    }).unwrap();
    store.append(&mut state, EventKind::Started { execution: execution("node", "task") }).unwrap();
    store.append(&mut state, EventKind::MergerStarted { execution: execution("merge", "merge:task") }).unwrap();
    let db = Connection::open(&path).unwrap();
    let mut sizes = Vec::new();
    for _ in 0..3 {
        store.append_batch(&mut state, (0..128).map(|i| EventKind::Output {
            execution_id: if i % 2 == 0 { "node" } else { "merge" }.into(),
            text: "stream payload\n".repeat(1024),
        }).collect()).unwrap();
        let payload: String = db.query_row("SELECT payload FROM checkpoints", [], |r| r.get(0)).unwrap();
        sizes.push(payload.len());
        let projection: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(projection["events"], serde_json::json!([]));
        assert_eq!(projection["executions"][0]["output"], "");
        assert_eq!(projection["mergers"][0]["output"], "");
        assert_eq!(serde_json::to_value(store.load("run").unwrap()).unwrap(), serde_json::to_value(&state).unwrap());
    }
    assert!(sizes.iter().max().unwrap() - sizes.iter().min().unwrap() < 128);
    store.append(&mut state, EventKind::Finished {
        execution_id: "node".into(), head: "head".into(), output: "replacement transcript".into(),
    }).unwrap();
    store.append(&mut state, EventKind::MergerFailed { execution_id: "merge".into(), error: "conflict".into() }).unwrap();
    store.append(&mut state, EventKind::PublicationCompleted { head: "published".into() }).unwrap();
    store.append_batch(&mut state, (0..128).map(|_| EventKind::Paused { paused: true }).collect()).unwrap();
    let expected = serde_json::to_value(&state).unwrap();
    assert_eq!(serde_json::to_value(store.load("run").unwrap()).unwrap(), expected);

    // Old checkpoints containing history remain readable.
    db.execute("UPDATE checkpoints SET sequence=?1,payload=?2", rusqlite::params![state.events.last().unwrap().sequence, expected.to_string()]).unwrap();
    assert_eq!(serde_json::to_value(store.load("run").unwrap()).unwrap(), expected);
    // Invalid optional checkpoints fall back to the authoritative event log.
    db.execute("UPDATE checkpoints SET payload='invalid'", []).unwrap();
    assert_eq!(serde_json::to_value(store.load("run").unwrap()).unwrap(), expected);
    db.execute("DELETE FROM checkpoints", []).unwrap();
    assert_eq!(serde_json::to_value(store.load("run").unwrap()).unwrap(), expected);
}
