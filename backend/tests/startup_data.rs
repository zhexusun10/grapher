//! Exercise the actual startup entry point with a disposable incompatible store.
use grapher::{
    model::{Config, EventKind, Graph, Snapshot},
    store::Store,
};
use rusqlite::Connection;
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

struct Backend(Child);
impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start(root: &Path, stderr: &Path) -> (Backend, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let child = Command::new(env!("CARGO_BIN_EXE_grapher"))
        .env("GRAPHER_DATA_DIR", root)
        .env("GRAPHER_PORT", port.to_string())
        .env("GRAPHER_DEV_LAZY_PRIMARY", "1")
        .stdout(Stdio::null())
        .stderr(fs::File::create(stderr).unwrap())
        .spawn()
        .unwrap();
    (Backend(child), port)
}

fn bootstrap(backend: &mut Backend, port: u16, stderr: &Path) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = backend.0.try_wait().unwrap() {
            panic!(
                "backend exited {status}: {}",
                fs::read_to_string(stderr).unwrap()
            );
        }
        if let Ok(mut stream) = TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_millis(100),
        ) {
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream.write_all(format!("POST /api/bootstrap HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").as_bytes()).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            let (headers, body) = response.split_once("\r\n\r\n").unwrap();
            assert!(
                headers.starts_with("HTTP/1.0 200") || headers.starts_with("HTTP/1.1 200"),
                "{response}"
            );
            return serde_json::from_str::<Value>(body).unwrap()["result"].clone();
        }
        assert!(
            Instant::now() < deadline,
            "startup timeout: {}",
            fs::read_to_string(stderr).unwrap()
        );
        thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn server_starts_on_incompatible_data_and_reopens_the_same_new_database() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("data");
    fs::create_dir(&root).unwrap();
    let original = root.join("events.sqlite");
    {
        let database = Connection::open(&original).unwrap();
        database
            .execute_batch(
                "CREATE TABLE old_events(payload TEXT); INSERT INTO old_events VALUES('preserve');",
            )
            .unwrap();
    }
    let before = fs::read(&original).unwrap();
    fs::write(root.join("config.json"), "old config remains unread").unwrap();
    fs::create_dir_all(root.join("planning/old")).unwrap();
    fs::write(
        root.join("planning/old/summary.json"),
        "old summary remains unread",
    )
    .unwrap();
    let selected = root
        .join("format-1")
        .canonicalize()
        .unwrap_or_else(|_| root.canonicalize().unwrap().join("format-1"));
    let stderr = temp.path().join("backend.log");
    let (mut backend, port) = start(&root, &stderr);
    let data = bootstrap(&mut backend, port, &stderr);
    assert_eq!(
        Path::new(data["dataPath"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        selected
    );
    assert_eq!(data["conversations"].as_array().unwrap().len(), 0);
    assert_eq!(fs::read(&original).unwrap(), before);
    assert!(fs::read_to_string(&stderr)
        .unwrap()
        .contains("previous data is preserved"));
    drop(backend);

    // Persist through the current writer, then verify the real server's next
    // bootstrap selects this store and lists its Run instead of starting empty.
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    {
        let store = Store::open(&selected.join("events.sqlite")).unwrap();
        let mut state = Snapshot {
            run_id: "retained".into(),
            ..Default::default()
        };
        let config: Config =
            serde_json::from_value(serde_json::json!({"repository":source, "model":"test/model"}))
                .unwrap();
        store
            .append(
                &mut state,
                EventKind::Created {
                    graph: Graph {
                        original_goal: "Retained after restart".into(),
                        nodes: vec![],
                        edges: vec![],
                    },
                    config,
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();
        store
            .append(
                &mut state,
                EventKind::Routed {
                    plan_type: "graph".into(),
                },
            )
            .unwrap();
        store.select_run(Some("retained")).unwrap();
    }
    let (mut backend, port) = start(&root, &stderr);
    let data = bootstrap(&mut backend, port, &stderr);
    assert_eq!(
        Path::new(data["dataPath"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        selected
    );
    assert!(data["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|run| run["runId"] == "retained"));
    assert!(!root.join("format-1-2").exists());
    assert_eq!(fs::read(&original).unwrap(), before);
    assert_eq!(
        fs::read_to_string(root.join("config.json")).unwrap(),
        "old config remains unread"
    );
    assert_eq!(
        fs::read_to_string(root.join("planning/old/summary.json")).unwrap(),
        "old summary remains unread"
    );
}
