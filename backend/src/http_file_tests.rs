use super::static_asset_path;
use std::fs;

#[test]
fn json_request_limits_apply_to_streaming_and_regular_api_requests() {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let temp = tempfile::tempdir().unwrap();
    let service = Arc::new(Service {
        runtime: Mutex::new(Runtime::open_lazy(temp.path()).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = server.server_addr().to_ip().unwrap();
    let web_root = temp.path().to_path_buf();
    let worker = std::thread::spawn(move || {
        for _ in 0..4 {
            handle_http_request(server.recv().unwrap(), &service, &web_root, address.port());
        }
    });
    for command in ["get_snapshot", "plan_goal_stream"] {
        // Valid JSON followed by whitespace is still valid after truncation.
        // Reject by byte count before command validation or side effects.
        for size in [10 * 1024 * 1024, 10 * 1024 * 1024 + 1] {
            let body = format!("{{}}{}", " ".repeat(size - 2));
            let mut socket = TcpStream::connect(address).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            write!(socket, "POST /api/{command} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            let mut response = String::new();
            socket.read_to_string(&mut response).unwrap();
            assert_eq!(
                response.contains("Request too large"),
                size > 10 * 1024 * 1024,
                "{command}: {}",
                &response[..response.len().min(600)]
            );
        }
    }
    worker.join().unwrap();
}

#[test]
fn base64_attachment_decoding_preserves_valid_bytes_and_rejects_malformed_input() {
    use super::decode_base64;
    for (encoded, expected) in [
        ("", &b""[..]),
        ("Zg==", &b"f"[..]),
        ("Zg", &b"f"[..]),
        ("Zm8=", &b"fo"[..]),
        ("Zm8", &b"fo"[..]),
        ("Zm9v", &b"foo"[..]),
        (" Z m 9 v\r\n", &b"foo"[..]),
        ("AAEC/f7/", &b"\x00\x01\x02\xfd\xfe\xff"[..]),
    ] {
        assert_eq!(
            decode_base64(encoded).as_deref(),
            Some(expected),
            "{encoded:?}"
        );
    }
    for encoded in [
        "%%%%",
        "Z",
        "Zg=",
        "Zg===",
        "=Zg",
        "Zg==trailer",
        "Zm9v!",
        "Zg==💥",
        "Zh==",
        "Zm9=",
    ] {
        assert!(
            decode_base64(encoded).is_none(),
            "malformed input was accepted: {encoded:?}"
        );
    }
}

#[test]
fn static_files_accept_real_assets_and_reject_cross_platform_path_escapes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("web 中文 space");
    fs::create_dir_all(root.join("assets")).unwrap();
    fs::write(root.join("index.html"), "index").unwrap();
    fs::write(root.join("assets/app.js"), "app").unwrap();
    assert_eq!(
        static_asset_path(&root, "/"),
        Some(root.join("index.html").canonicalize().unwrap())
    );
    assert_eq!(
        static_asset_path(&root, "/assets/app.js"),
        Some(root.join("assets/app.js").canonicalize().unwrap())
    );
    for path in [
        "/../secret",
        "/assets/../../secret",
        r"/..\secret",
        r"/C:\secret",
        "/C:/secret",
        r"/\\server\share\secret",
        r"/\\?\C:\secret",
        r"/\\.\NUL",
        "/index.html:secret",
        "/missing",
        "/assets",
        "/\0",
    ] {
        assert!(
            static_asset_path(&root, path).is_none(),
            "unexpected accepted path: {path:?}"
        );
    }
}

#[test]
fn static_files_refuse_symlinks_and_windows_junctions_below_the_web_root() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("web");
    let outside = temp.path().join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), "private").unwrap();
    crate::path_safety::directory_link(&outside, &root.join("linked"));
    assert!(static_asset_path(&root, "/linked/secret").is_none());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.join("secret"), root.join("file-link")).unwrap();
        assert!(static_asset_path(&root, "/file-link").is_none());
    }
    let root_link = temp.path().join("web-link");
    crate::path_safety::directory_link(&root, &root_link);
    assert!(static_asset_path(&root_link, "/index.html").is_none());
    assert_eq!(
        fs::read_to_string(outside.join("secret")).unwrap(),
        "private"
    );
}

#[test]
fn static_assets_send_connection_close_and_cache_headers_without_keep_alive_starvation() {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::{Duration, Instant};

    let temp = tempfile::tempdir().unwrap();
    let web_root = temp.path().join("dist");
    fs::create_dir_all(web_root.join("assets")).unwrap();
    fs::write(web_root.join("index.html"), "<!doctype html>").unwrap();
    fs::write(web_root.join("assets/app-abc123.js"), "console.log(1);").unwrap();

    let service = Arc::new(Service {
        runtime: Mutex::new(Runtime::open_lazy(temp.path()).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
    let address = server.server_addr().to_ip().unwrap();
    let server_worker = server.clone();
    let worker = std::thread::spawn(move || {
        for _ in 0..8 {
            handle_http_request(
                server_worker.recv().unwrap(),
                &service,
                &web_root,
                address.port(),
            );
        }
    });

    // Open 8 simultaneous keep-alive requests (exceeding tiny_http's 4-thread
    // TaskPool minimum). Like a real HTTP/1.1 client honoring `Connection: close`,
    // each client reads headers + Content-Length body and closes its socket,
    // releasing tiny_http's reader thread immediately so none stalls.
    let started = Instant::now();
    let mut clients = Vec::new();
    for index in 0..8 {
        let path = if index % 2 == 0 {
            "/"
        } else {
            "/assets/app-abc123.js"
        };
        clients.push(std::thread::spawn(move || {
            let mut socket = TcpStream::connect(address).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            write!(
                socket,
                "GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: keep-alive\r\n\r\n"
            )
            .unwrap();
            let mut reader = std::io::BufReader::new(socket);
            let mut headers = String::new();
            let mut content_length = 0usize;
            loop {
                let mut line = String::new();
                assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                if let Some(value) = line
                    .strip_prefix("Content-Length:")
                    .or_else(|| line.strip_prefix("content-length:"))
                {
                    content_length = value.trim().parse().unwrap();
                }
                headers.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let mut body = vec![0u8; content_length];
            reader.read_exact(&mut body).unwrap();
            (path, headers, String::from_utf8(body).unwrap())
        }));
    }
    for client in clients {
        let (path, headers, body) = client.join().unwrap();
        assert!(headers.starts_with("HTTP/1.1 200 OK\r\n"), "{headers}");
        assert!(
            headers.contains("Connection: close\r\n"),
            "missing Connection: close for {path}: {headers}"
        );
        if path.starts_with("/assets/") {
            assert!(
                headers.contains("Cache-Control: public, max-age=31536000, immutable\r\n"),
                "{headers}"
            );
            assert_eq!(body, "console.log(1);");
        } else {
            assert!(headers.contains("Cache-Control: no-cache\r\n"), "{headers}");
            assert_eq!(body, "<!doctype html>");
        }
    }
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "parallel requests stalled for {:?}",
        started.elapsed()
    );
    worker.join().unwrap();
}
