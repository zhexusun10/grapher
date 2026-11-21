use super::*;
use serde_json::json;

fn service(root: &std::path::Path) -> Arc<Service> {
    Arc::new(Service {
        runtime: Mutex::new(Runtime::open_lazy(root).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: root.join("unused"),
    })
}

#[test]
fn browser_poll_uses_deltas_for_matching_versions_and_full_projection_after_a_missed_base() {
    let temp = tempfile::tempdir().unwrap();
    let service = service(temp.path());
    {
        let mut runtime = service.runtime.lock().unwrap();
        runtime.state.run_id = Uuid::new_v4().to_string();
        runtime.state.graph.original_goal = "large unchanged graph".repeat(1000);
    }
    let first = dispatch(
        &service,
        "snapshot_if_changed",
        json!({"detail":"metadata","delta":true}),
    )
    .unwrap();
    service.runtime.lock().unwrap().state.phase = "running".into();
    service.runtime.lock().unwrap().touch();
    let next = dispatch(
        &service,
        "snapshot_if_changed",
        json!({"detail":"metadata","delta":true,"version":first["version"]}),
    )
    .unwrap();
    assert!(next["snapshot"].is_null());
    assert_eq!(next["delta"]["set"]["phase"], "running");
    assert!(next["delta"]["set"]["graph"].is_null());
    assert_eq!(next["delta"]["baseVersion"], first["version"]);
    assert!(next.to_string().len() * 10 < first.to_string().len());
    service.runtime.lock().unwrap().touch();
    let missed = dispatch(
        &service,
        "snapshot_if_changed",
        json!({"detail":"metadata","delta":true,"version":first["version"]}),
    )
    .unwrap();
    assert!(missed["delta"].is_null());
    assert_eq!(missed["snapshot"]["phase"], "running");
    let unchanged = dispatch(
        &service,
        "snapshot_if_changed",
        json!({"detail":"metadata","delta":true,"version":missed["version"]}),
    )
    .unwrap();
    assert!(unchanged["snapshot"].is_null());
    assert!(unchanged["delta"].is_null());
    assert!(unchanged["busy"].is_null());
}

#[test]
fn planner_frames_send_either_parsed_data_or_raw_diagnostics() {
    let parsed = serde_json::to_value(crate::api_contract::PlannerOutputFrame::from_line(
        r#"{"type":"message_update","delta":"中文🚀"}"#,
    ))
    .unwrap();
    assert!(parsed.get("raw").is_none());
    assert_eq!(parsed["event"]["delta"], "中文🚀");
    let raw = serde_json::to_value(crate::api_contract::PlannerOutputFrame::from_line(
        "diagnostic text",
    ))
    .unwrap();
    assert_eq!(raw, json!({"raw":"diagnostic text"}));
}

#[test]
fn http_receipts_prevent_repeated_writes_before_service_creation_and_expose_machine_errors() {
    use std::{
        io::{Read, Write},
        net::TcpStream,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    let temp = tempfile::tempdir().unwrap();
    let service = service(temp.path());
    let run = Uuid::new_v4().to_string();
    service.runtime.lock().unwrap().state.run_id = run.clone();
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = server.server_addr().to_ip().unwrap();
    let worker_service = service.clone();
    let root = temp.path().to_path_buf();
    let worker = thread::spawn(move || {
        for _ in 0..7 {
            handle_http_request(
                server.recv().unwrap(),
                &worker_service,
                &root,
                address.port(),
            );
        }
    });
    let post = |command: &str, body: serde_json::Value, token: Option<&str>| {
        let mut socket = TcpStream::connect(address).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let body = body.to_string();
        let token = token
            .map(|token| format!("X-Grapher-Operation: {token}\r\n"))
            .unwrap_or_default();
        write!(socket,"POST /api/{command} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\n{token}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).unwrap();
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        (
            headers.to_owned(),
            serde_json::from_str::<serde_json::Value>(body).unwrap(),
        )
    };
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let token = format!("{}:{time}:{}", api_transport::instance(), Uuid::new_v4());
    let body = json!({"runId":run,"title":"First title","detail":"metadata"});
    let (headers, first) = post("composer_rename", body.clone(), Some(&token));
    assert!(headers.starts_with("HTTP/1.1 200"), "{first}");
    assert!(headers.contains("X-Grapher-Instance:"));
    let count = service.runtime.lock().unwrap().state.events.len();
    let (headers, second) = post("composer_rename", body, Some(&token));
    assert!(headers.contains("X-Grapher-Replayed: 1"));
    assert_eq!(second, first);
    assert_eq!(service.runtime.lock().unwrap().state.events.len(), count);
    let (headers, conflict) = post(
        "composer_rename",
        json!({"runId":run,"title":"Different title"}),
        Some(&token),
    );
    assert!(headers.starts_with("HTTP/1.1 409 Conflict"));
    assert_eq!(conflict["errorInfo"]["code"], "IDEMPOTENCY_CONFLICT");
    let (_, receipt) = post("operation_status", json!({"operationId":token}), None);
    assert_eq!(receipt["result"]["state"], "completed");
    let (headers, missing) = post("snapshot", json!({"runId":Uuid::new_v4()}), None);
    assert!(headers.starts_with("HTTP/1.1 404 Not Found"));
    assert_eq!(missing["errorInfo"]["code"], "RUN_NOT_FOUND");
    let withdrawal_id = Uuid::new_v4().to_string();
    let large_message = "recovered draft ".repeat(80_000);
    service
        .runtime
        .lock()
        .unwrap()
        .emit(EventKind::QueueWithdrawalRecorded {
            request_id: withdrawal_id.clone(),
            node: None,
            messages: vec![RecalledMessage {
                text: large_message.clone(),
                images: None,
            }],
        })
        .unwrap();
    let count = service.runtime.lock().unwrap().state.events.len();
    for _ in 0..2 {
        let (headers, reply) = post(
            "composer_command",
            json!({
                "runId":run,"node":null,"operation":"withdraw","requestId":withdrawal_id,"detail":"metadata"
            }),
            Some("expired-backend-token"),
        );
        assert!(
            headers.starts_with("HTTP/1.1 200"),
            "{}",
            &reply.to_string()[..200]
        );
        assert_eq!(reply["result"]["messages"][0]["text"], large_message);
        assert_eq!(service.runtime.lock().unwrap().state.events.len(), count);
    }
    worker.join().unwrap();
}
