use grapher::{model::{Config, EventKind, Graph, Snapshot}, store::Store};
use rusqlite::{params, Connection};
use tempfile::TempDir;

fn created(repository: &str, direct: Option<&str>, nested: Option<&str>) -> EventKind {
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": repository, "model": "test", "maxParallel": 1
    })).unwrap();
    let planning = nested.map(|id| serde_json::from_value(serde_json::json!({
        "planningId": id, "roles": {}, "totalPlanningDuration": 0,
        "modelDuration": 0
    })).unwrap());
    EventKind::Created { graph: Graph::default(), config, planning_id: direct.map(str::to_string), planning }
}

#[test]
fn migrates_planning_ids_and_uses_exact_index() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    {
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL);").unwrap();
        for (run, id, nested) in [("one", "a%_", false), ("two", "aXy", true)] {
            let kind = created(run, if nested { None } else { Some(id) }, if nested { Some(id) } else { None });
            db.execute("INSERT INTO events(run_id,timestamp,payload) VALUES (?1,1,?2)", params![run, serde_json::to_string(&kind).unwrap()]).unwrap();
        }
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.find_repository_by_planning_id("a%_"), Some("one".into()));
    assert_eq!(store.find_repository_by_planning_id("aXy"), Some("two".into()));
    assert_eq!(store.find_repository_by_planning_id("a"), None);
    let mut state = Snapshot { run_id: "three".into(), ..Default::default() };
    store.append(&mut state, created("three", Some("fresh"), None)).unwrap();
    assert_eq!(store.find_repository_by_planning_id("fresh"), Some("three".into()));
    store.append(&mut state, created("both", Some("direct"), Some("nested"))).unwrap();
    assert_eq!(store.find_repository_by_planning_id("direct"), Some("both".into()));
    assert_eq!(store.find_repository_by_planning_id("nested"), Some("both".into()));
}

#[test]
fn checkpoint_restores_history_from_events_and_is_removed_with_run() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.db");
    let store = Store::open(&path).unwrap();
    let mut state = Snapshot { run_id: "run".into(), ..Default::default() };
    store.append(&mut state, created("repo", Some("id"), None)).unwrap();
    for i in 0..130 {
        store.append(&mut state, EventKind::Output { execution_id: "missing".into(), text: i.to_string() }).unwrap();
    }
    let db = Connection::open(&path).unwrap();
    let checkpoint: i64 = db.query_row("SELECT sequence FROM checkpoints WHERE run_id='run'", [], |r| r.get(0)).unwrap();
    assert_eq!(checkpoint, state.events[127].sequence);
    let payload: String = db.query_row("SELECT payload FROM checkpoints WHERE run_id='run'", [], |r| r.get(0)).unwrap();
    let projection: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(projection["events"], serde_json::json!([]));
    let loaded = store.load("run").unwrap();
    assert_eq!(loaded.events.len(), 131);
    assert_eq!(loaded.events.last().unwrap().sequence, state.events.last().unwrap().sequence);
    store.delete_run("run").unwrap();
    assert!(store.load("run").unwrap_err().contains("does not exist"));
    assert!(db.query_row("SELECT sequence FROM checkpoints WHERE run_id='run'", [], |r| r.get::<_, i64>(0)).is_err());
}
