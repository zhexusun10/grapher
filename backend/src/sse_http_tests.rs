use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::mpsc;
use std::time::Duration;

fn read_chunk(reader: &mut BufReader<TcpStream>) -> Vec<u8> {
    let mut header = String::new();
    reader.read_line(&mut header).unwrap();
    let size = usize::from_str_radix(header.trim(), 16).unwrap();
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes).unwrap();
    let mut end = [0; 2];
    reader.read_exact(&mut end).unwrap();
    assert_eq!(&end, b"\r\n");
    bytes
}

fn exercise_sse(http10: bool, advertise_events: bool) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = server.server_addr().to_ip().unwrap();
    let (tx, rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        let request = server.recv().unwrap();
        respond_sse(
            request,
            SseStreamReceiver {
                rx,
                current: Vec::new(),
                pos: 0,
                subscriber_id: None,
            },
            Some("http://127.0.0.1:1420"),
            advertise_events,
        )
    });
    let mut socket = TcpStream::connect(address).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(
        socket,
        "GET / HTTP/1.{}\r\nHost: {address}\r\nConnection: close\r\n\r\n",
        if http10 { 0 } else { 1 }
    )
    .unwrap();
    let mut reader = BufReader::new(socket);

    // No event has been sent yet. Headers must arrive while the producer is
    // still idle, rather than waiting for 8 KiB or the end of the stream.
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        assert_ne!(reader.read_line(&mut line).unwrap(), 0);
        if line == "\r\n" {
            break;
        }
        headers.push_str(&line);
    }
    assert!(headers.starts_with(if http10 {
        "HTTP/1.0 200"
    } else {
        "HTTP/1.1 200"
    }));
    assert!(headers.contains("Content-Type: text/event-stream\r\n"));
    assert!(headers.contains("Access-Control-Allow-Origin: http://127.0.0.1:1420\r\n"));
    assert_eq!(headers.contains("Transfer-Encoding: chunked\r\n"), !http10);
    assert_eq!(
        headers.contains("X-Grapher-Events: 1\r\n"),
        advertise_events
    );
    assert_eq!(
        headers.contains("Access-Control-Expose-Headers: X-Grapher-Events\r\n"),
        advertise_events
    );

    for payload in [
        b": connected\n\n".to_vec(),
        "event: planner\ndata: {\"delta\":\"思考🚀\"}\n\n"
            .as_bytes()
            .to_vec(),
        b"event: output_available\ndata: {}\n\n".to_vec(),
    ] {
        tx.send(payload.clone()).unwrap();
        let received = if http10 {
            let mut data = vec![0; payload.len()];
            reader.read_exact(&mut data).unwrap();
            data
        } else {
            read_chunk(&mut reader)
        };
        // Each frame is well under the old buffer limit, and the next frame is
        // not sent until this one arrives: coalescing cannot hide buffering.
        assert_eq!(received, payload);
    }

    // A single large event spans several socket chunks without losing bytes.
    let large = vec![b'x'; 20_000];
    tx.send(large.clone()).unwrap();
    let mut received = Vec::new();
    while received.len() < large.len() {
        if http10 {
            let mut data = vec![0; large.len() - received.len()];
            reader.read_exact(&mut data).unwrap();
            received.extend(data);
        } else {
            received.extend(read_chunk(&mut reader));
        }
    }
    assert_eq!(received, large);
    tx.send(Vec::new()).unwrap();
    if !http10 {
        assert!(
            read_chunk(&mut reader).is_empty(),
            "a terminal chunk closes HTTP/1.1 cleanly"
        );
    } else {
        let mut extra = [0; 1];
        assert_eq!(reader.read(&mut extra).unwrap(), 0, "HTTP/1.0 ends at EOF");
    }
    worker.join().unwrap().unwrap();
}

#[test]
fn sse_flushes_headers_and_each_small_frame_over_http11() {
    exercise_sse(false, true);
    exercise_sse(false, false);
}

#[test]
fn sse_streams_http10_without_chunk_encoding() {
    exercise_sse(true, true);
}

#[test]
fn completed_sse_allows_http11_connection_reuse() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = server.server_addr().to_ip().unwrap();
    let (tx, rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        respond_sse(
            server.recv().unwrap(),
            SseStreamReceiver {
                rx,
                current: Vec::new(),
                pos: 0,
                subscriber_id: None,
            },
            None,
            false,
        )
        .unwrap();
        server
            .recv()
            .unwrap()
            .respond(tiny_http::Response::from_string("ok"))
            .unwrap();
    });
    let mut socket = TcpStream::connect(address).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(
        socket,
        "GET /api/events HTTP/1.1\r\nHost: {address}\r\n\r\n"
    )
    .unwrap();
    let mut reader = BufReader::new(socket);
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        assert_ne!(reader.read_line(&mut line).unwrap(), 0);
        if line == "\r\n" {
            break;
        }
        headers.push_str(&line);
    }
    assert!(headers.contains("Connection: keep-alive\r\n"));
    tx.send(b"data: first\n\n".to_vec()).unwrap();
    assert_eq!(read_chunk(&mut reader), b"data: first\n\n");
    tx.send(Vec::new()).unwrap();
    assert!(read_chunk(&mut reader).is_empty());
    write!(
        reader.get_mut(),
        "GET /next HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut second = String::new();
    reader.read_to_string(&mut second).unwrap();
    assert!(second.starts_with("HTTP/1.1 200"), "{second}");
    assert!(second.ends_with("\r\n\r\nok"), "{second}");
    worker.join().unwrap();
}

#[cfg(all(feature = "fixture", unix))]
#[test]
fn planner_endpoint_delivers_thinking_while_the_model_is_still_running() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("repository");
    fs::create_dir_all(&repository).unwrap();
    let root = temp.path().join("runtime");
    let release = temp.path().join("release");
    let script = temp.path().join("planner.sh");
    fs::write(&script, format!(r#"
printf '%s\n' '{{"type":"message_start","message":{{"role":"assistant","content":[]}}}}'
printf '%s\n' '{{"type":"message_update","assistantMessageEvent":{{"type":"thinking_delta","contentIndex":0,"delta":"LIVE_PROBE"}}}}'
while [ ! -f {release:?} ]; do sleep 0.02; done
printf '%s' '{{"originalGoal":"Goal","nodes":[{{"name":"work","task":"Do work"}}],"edges":[]}}' > "$GRAPHER_GRAPH_PATH"
printf '%s\n' '{{"type":"message_end","message":{{"role":"assistant","content":[{{"type":"text","text":"completed"}}],"stopReason":"stop"}}}}'
"#, release = release.to_string_lossy())).unwrap();
    let service = Arc::new(Service {
        runtime: Mutex::new(Runtime::open_lazy(&root).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused.ts"),
    });
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = server.server_addr().to_ip().unwrap();
    let web_root = temp.path().to_path_buf();
    let worker = thread::spawn(move || {
        let request = server.recv().unwrap();
        handle_http_request(request, &service, &web_root, address.port());
    });
    let body = serde_json::json!({
        "goal": "Goal", "mode": "graph", "config": {
            "repository": repository, "model": "mock/model", "maxParallel": 1,
            "engine": "pi", "piCommand": "/bin/sh", "piArgs": [script],
        }
    })
    .to_string();
    let mut socket = TcpStream::connect(address).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    write!(socket, "POST /api/plan_goal_stream HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut reader = BufReader::new(socket);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0);
            if line == "\r\n" {
                break;
            }
            headers.push_str(&line);
        }
        assert!(headers.starts_with("HTTP/1.1 200"), "{headers}");
        assert!(headers.contains("X-Grapher-Events: 1\r\n"));
        let mut output = String::new();
        while !output.contains("LIVE_PROBE") {
            let frame = String::from_utf8(read_chunk(&mut reader)).unwrap();
            assert!(
                !frame.is_empty(),
                "stream ended before the model delta: {output}"
            );
            output.push_str(&frame);
        }
        assert!(output.contains("event: run_started\n"));
        assert!(output.contains("event: planner\n"));
        assert!(
            !release.exists(),
            "the model must still be running when the delta arrives"
        );
    }));
    fs::write(&release, "continue").unwrap();
    if result.is_ok() {
        let mut output = String::new();
        loop {
            let frame = read_chunk(&mut reader);
            if frame.is_empty() {
                break;
            }
            output.push_str(&String::from_utf8(frame).unwrap());
        }
        assert!(output.contains("event: complete\n"), "{output}");
    }
    let _ = reader.get_ref().shutdown(Shutdown::Both);
    worker.join().unwrap();
    invalidate_service_cache(&root, None);
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[test]
fn events_endpoint_pushes_small_notifications_before_stream_end() {
    let temp = tempfile::tempdir().unwrap();
    let service = Arc::new(Service {
        runtime: Mutex::new(Runtime::open_lazy(temp.path()).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused.ts"),
    });
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = server.server_addr().to_ip().unwrap();
    let web_root = temp.path().to_path_buf();
    let (done_tx, done_rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        let request = server.recv().unwrap();
        handle_http_request(request, &service, &web_root, address.port());
        let _ = done_tx.send(());
    });
    let mut socket = TcpStream::connect(address).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(
        socket,
        "GET /api/events HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut reader = BufReader::new(socket);
    let result = || {
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0);
            if line == "\r\n" {
                break;
            }
            headers.push_str(&line);
        }
        assert!(headers.starts_with("HTTP/1.1 200"));
        assert_eq!(read_chunk(&mut reader), b": connected\n\n");
        let run_id = format!("sse-http-{}", Uuid::new_v4());
        notify_output_available(&run_id, "execution", 42, false);
        loop {
            let frame = String::from_utf8(read_chunk(&mut reader)).unwrap();
            if frame.contains(&run_id) {
                assert!(frame.contains("event: output_available\n"));
                assert!(frame.contains("\"totalBytes\":42"));
                break;
            }
        }
    };
    // Always close and wake the reader, even if an assertion fails. A client
    // disconnect must not leave a subscriber or HTTP worker indefinitely live.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(result));
    let _ = reader.get_ref().shutdown(Shutdown::Both);
    for _ in 0..30 {
        notify_output_available("sse-http-disconnect", "execution", 1, false);
        if done_rx.recv_timeout(Duration::from_millis(100)).is_ok() {
            worker.join().unwrap();
            if let Err(error) = result {
                std::panic::resume_unwind(error);
            }
            return;
        }
    }
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
    panic!("SSE worker did not stop after the client disconnected");
}
