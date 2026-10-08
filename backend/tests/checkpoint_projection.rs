use grapher::{model::*, snapshot_view::snapshot_metadata};
use rusqlite::Connection;
use tempfile::TempDir;

fn execution(id: &str, node: &str) -> Execution {
    Execution {
        id: id.into(), node: node.into(), revision: 1, attempt: 1,
        session_id: id.into(), worktree: String::new(), before: String::new(),
        workspace_lineage: vec![],
        after: None, status: "running".into(), output: String::new(), output_bytes: 0, pid: None,
        input: None, result: None,
        started_at: 1, completed_at: None, metrics: None,
    }
}

#[test]
fn compact_checkpoints_preserve_business_history_without_materializing_streams() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.sqlite");
    let mut runtime = grapher::runtime::Runtime::open(temp.path()).unwrap();
    assert!(runtime.store.load("missing").is_err());
    runtime.state.run_id = "run".into();
    let config = serde_json::from_value(serde_json::json!({
        "repository": "/repo", "model": "test", "maxParallel": 1
    })).unwrap();
    runtime.emit(EventKind::Created {
        graph: Graph { nodes: vec![Node { name: "task".into(), task: "test".into() }], ..Default::default() },
        config, planning_id: None, planning: None,
    }).unwrap();
    runtime.emit(EventKind::Started { execution: execution("node", "task") }).unwrap();
    runtime.emit(EventKind::MergerStarted { execution: execution("merge", "merge:task") }).unwrap();
    let db = Connection::open(&path).unwrap();
    let mut sizes = Vec::new();
    for _ in 0..3 {
        runtime.emit_outputs((0..128).map(|i| EventKind::Output {
            execution_id: if i % 2 == 0 { "node" } else { "merge" }.into(),
            text: "stream payload\n".repeat(1024),
        }).collect()).unwrap();
        let payload: String = db.query_row("SELECT payload FROM checkpoints", [], |r| r.get(0)).unwrap();
        sizes.push(payload.len());
        let projection: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(projection["events"], serde_json::json!([]));
        assert_eq!(projection["executions"][0]["output"], "");
        assert_eq!(projection["mergers"][0]["output"], "");
        let loaded = runtime.store.load("run").unwrap();
        assert_eq!(loaded.events.len(), 3);
        assert!(loaded.executions[0].output.is_empty());
        assert_eq!(snapshot_metadata(&loaded).unwrap(), snapshot_metadata(&runtime.state).unwrap());
    }
    assert!(sizes.iter().max().unwrap() - sizes.iter().min().unwrap() < 128);
    runtime.emit(EventKind::Finished {
        execution_id: "node".into(), head: "head".into(), output: "replacement transcript".into(), output_bytes: 0, metrics: None,
    }).unwrap();
    runtime.emit(EventKind::MergerFailed { execution_id: "merge".into(), error: "conflict".into(), output_bytes: 0, metrics: None }).unwrap();
    runtime.emit(EventKind::PublicationCompleted { head: "published".into() }).unwrap();
    runtime.emit_outputs(Vec::new()).unwrap();
    for _ in 0..128 { runtime.emit(EventKind::Paused { paused: true }).unwrap(); }
    let expected = snapshot_metadata(&runtime.state).unwrap();
    assert_eq!(snapshot_metadata(&runtime.store.load("run").unwrap()).unwrap(), expected);

    // Old checkpoints containing history remain readable; output is discarded.
    let old = serde_json::to_value(&runtime.state).unwrap();
    db.execute("UPDATE checkpoints SET sequence=?1,payload=?2", rusqlite::params![runtime.state.events.last().unwrap().sequence, old.to_string()]).unwrap();
    assert_eq!(snapshot_metadata(&runtime.store.load("run").unwrap()).unwrap(), expected);
    db.execute("UPDATE checkpoints SET payload='invalid'", []).unwrap();
    assert_eq!(snapshot_metadata(&runtime.store.load("run").unwrap()).unwrap(), expected);
    db.execute("DELETE FROM checkpoints", []).unwrap();
    assert_eq!(snapshot_metadata(&runtime.store.load("run").unwrap()).unwrap(), expected);
    runtime.store.delete_run("run").unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM checkpoints", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(db.query_row("SELECT COUNT(*) FROM execution_logs", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
}
