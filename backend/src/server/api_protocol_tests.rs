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

#[cfg(unix)]
#[test]
fn browser_terminal_http_runs_in_workspace_replays_output_and_checks_origin() {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::{Duration, Instant};
    let temp = tempfile::tempdir().unwrap();
    let service = service(temp.path());
    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
    let address = server.server_addr().to_ip().unwrap();
    let worker_server = Arc::clone(&server);
    let web_root = temp.path().to_path_buf();
    let worker = std::thread::spawn(move || {
        while let Ok(request) = worker_server.recv() {
            handle_http_request(request, &service, &web_root, address.port());
        }
    });
    let post = |command: &str, body: serde_json::Value, origin: &str| {
        let mut socket = TcpStream::connect(address).unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let body = body.to_string();
        write!(socket, "POST /api/{command} HTTP/1.1\r\nHost: {address}\r\nOrigin: {origin}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).unwrap();
        response
    };
    let create = json!({"workspacePath":temp.path(),"cols":90,"rows":28});
    assert!(post("terminal_create", create.clone(), "https://untrusted.invalid").starts_with("HTTP/1.1 403"));
    let origin = format!("http://{address}");
    let result = post("terminal_create", create, &origin);
    assert!(result.starts_with("HTTP/1.1 200"), "{result}");
    let created: serde_json::Value = serde_json::from_str(result.split_once("\r\n\r\n").unwrap().1).unwrap();
    let id = created["result"]["sessionId"].as_str().unwrap();
    assert!(post("terminal_resize", json!({"sessionId":id,"cols":100,"rows":32}), &origin).starts_with("HTTP/1.1 200"));
    assert!(post("terminal_write", json!({"sessionId":id,"data":"printf 'web-%s\\n' terminal-ready > pty-proof.txt; exit\r"}), &origin).starts_with("HTTP/1.1 200"));
    let deadline = Instant::now() + Duration::from_secs(8);
    let final_page = loop {
        let response = post("terminal_read", json!({"sessionId":id,"cursor":0}), &origin);
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        let page: serde_json::Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
        if page["result"]["exited"] == true { break page; }
        assert!(Instant::now() < deadline, "shell did not exit");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(final_page["result"]["exitCode"], 0);
    assert!(!final_page["result"]["chunks"].as_array().unwrap().is_empty());
    assert_eq!(fs::read_to_string(temp.path().join("pty-proof.txt")).unwrap(), "web-terminal-ready\n");
    let replay = post("terminal_read", json!({"sessionId":id,"cursor":0}), &origin);
    let replay: serde_json::Value = serde_json::from_str(replay.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(replay, final_page);
    assert!(post("terminal_kill", json!({"sessionId":id}), &origin).starts_with("HTTP/1.1 200"));
    assert!(post("terminal_read", json!({"sessionId":id}), &origin).starts_with("HTTP/1.1 404"));
    server.unblock();
    worker.join().unwrap();
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
