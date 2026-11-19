//! End-to-end backend tests for desktop sidecar readiness, dynamic port,
//! resource/executable overrides, strict Tauri v2 origins, and stdin EOF shutdown.
use grapher::store::Store;
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

struct SidecarGuard(Child);
impl Drop for SidecarGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn http_exchange(port: u16, request: &str) -> String {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_secs(5),
    )
    .unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

fn read_first_line_with_timeout(
    stdout: impl Read + Send + 'static,
    timeout: Duration,
) -> (String, mpsc::Receiver<String>) {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            if tx.send(std::mem::take(&mut line)).is_err() {
                break;
            }
        }
    });
    let first = rx
        .recv_timeout(timeout)
        .expect("timed out waiting for backend readiness line on stdout");
    (first, rx)
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> std::process::ExitStatus {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "backend did not exit within {timeout:?}"
        );
        thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn desktop_sidecar_binds_dynamic_port_validates_tauri_origins_and_shuts_down_on_stdin_eof() {
    let temp = TempDir::new().unwrap();
    let data = temp.path().join("app-data");
    let resources = temp.path().join("tauri-resources");
    let stderr_path = temp.path().join("sidecar.stderr.log");
    fs::create_dir_all(resources.join("dist")).unwrap();
    fs::write(
        resources.join("dist/index.html"),
        "<!doctype html><title>Desktop Resources</title>",
    )
    .unwrap();

    let mut child = SidecarGuard(
        Command::new(env!("CARGO_BIN_EXE_grapher"))
            .arg("--desktop-sidecar")
            .env("GRAPHER_PORT", "0")
            .env("GRAPHER_DATA_DIR", &data)
            .env("GRAPHER_INSTALLATION_ROOT", &resources)
            .env("GRAPHER_DEV_LAZY_PRIMARY", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(fs::File::create(&stderr_path).unwrap())
            .spawn()
            .unwrap(),
    );

    let stdin = child.0.stdin.take().unwrap();
    let stdout = child.0.stdout.take().unwrap();
    let (ready_line, extra_stdout_rx) = read_first_line_with_timeout(stdout, Duration::from_secs(20));

    let ready: Value = serde_json::from_str(ready_line.trim()).unwrap_or_else(|error| {
        panic!(
            "invalid readiness JSON ({error}): {ready_line:?}\nstderr: {}",
            fs::read_to_string(&stderr_path).unwrap_or_default()
        )
    });
    assert_eq!(ready["type"], "grapher_ready");
    let port = ready["port"].as_u64().unwrap() as u16;
    assert_ne!(port, 0);
    assert_eq!(
        Path::new(ready["dataDir"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        data.canonicalize().unwrap()
    );

    // Diagnostics stay on stderr, never stdout.
    let stderr_log = fs::read_to_string(&stderr_path).unwrap();
    assert!(
        stderr_log.contains(&format!("http://127.0.0.1:{port}")),
        "expected bound port in stderr banner: {stderr_log}"
    );

    // Static assets are served from GRAPHER_INSTALLATION_ROOT/dist using the actual port.
    let index_resp = http_exchange(
        port,
        &format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"),
    );
    assert!(index_resp.starts_with("HTTP/1.1 200 OK"), "{index_resp}");
    assert!(index_resp.contains("Desktop Resources"), "{index_resp}");

    // Wrong Host (including port 0 or Tauri host) is rejected with 403.
    for bad_host in ["127.0.0.1:0", "localhost:1421", "tauri.localhost"] {
        let resp = http_exchange(
            port,
            &format!("GET / HTTP/1.1\r\nHost: {bad_host}\r\nConnection: close\r\n\r\n"),
        );
        assert!(
            resp.starts_with("HTTP/1.1 403 Forbidden"),
            "expected 403 for Host {bad_host}: {resp}"
        );
    }

    // Tauri v2 origins on macOS (tauri://localhost) and Windows (http/https://tauri.localhost)
    // are accepted for JSON POST and CORS preflight while untrusted origins are rejected.
    for origin in [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ] {
        let post_resp = http_exchange(
            port,
            &format!(
                "POST /api/snapshot HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: {origin}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            ),
        );
        assert!(
            post_resp.starts_with("HTTP/1.1 200 OK"),
            "POST failed for {origin}: {post_resp}"
        );
        assert!(
            post_resp.contains(&format!("Access-Control-Allow-Origin: {origin}\r\n")),
            "missing ACAO for {origin}: {post_resp}"
        );

        let opt_resp = http_exchange(
            port,
            &format!(
                "OPTIONS /api/snapshot HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: {origin}\r\nConnection: close\r\n\r\n"
            ),
        );
        assert!(
            opt_resp.starts_with("HTTP/1.1 204 No Content"),
            "OPTIONS failed for {origin}: {opt_resp}"
        );
        assert!(
            opt_resp.contains(&format!("Access-Control-Allow-Origin: {origin}\r\n")),
            "missing OPTIONS ACAO for {origin}: {opt_resp}"
        );
    }

    for bad_origin in [
        "http://evil.example",
        "tauri://evil",
        "tauri://localhost/path",
        "http://tauri.localhost.evil.example",
        "http://tauri.localhost:80",
        "null",
    ] {
        let resp = http_exchange(
            port,
            &format!(
                "POST /api/snapshot HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: {bad_origin}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            ),
        );
        assert!(
            resp.starts_with("HTTP/1.1 403 Forbidden"),
            "expected 403 for Origin {bad_origin}: {resp}"
        );
    }

    // Origin-less cross-site SSE is still rejected with 403.
    let cross_site_no_origin = http_exchange(
        port,
        &format!(
            "GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nSec-Fetch-Site: cross-site\r\nConnection: close\r\n\r\n"
        ),
    );
    assert!(
        cross_site_no_origin.starts_with("HTTP/1.1 403 Forbidden"),
        "{cross_site_no_origin}"
    );

    // Trusted Tauri origin SSE succeeds even with Sec-Fetch-Site: cross-site,
    // and closes cleanly when stdin EOF triggers graceful shutdown.
    let mut sse_socket = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_secs(5),
    )
    .unwrap();
    sse_socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write!(
        sse_socket,
        "GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: tauri://localhost\r\nSec-Fetch-Site: cross-site\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut sse_reader = BufReader::new(sse_socket);
    let mut sse_headers = String::new();
    loop {
        let mut line = String::new();
        assert_ne!(sse_reader.read_line(&mut line).unwrap(), 0);
        if line == "\r\n" {
            break;
        }
        sse_headers.push_str(&line);
    }
    assert!(sse_headers.starts_with("HTTP/1.1 200 OK"), "{sse_headers}");
    assert!(
        sse_headers.contains("Access-Control-Allow-Origin: tauri://localhost\r\n"),
        "{sse_headers}"
    );

    // Closing parent stdin (EOF) triggers full graceful shutdown.
    drop(stdin);
    let status = wait_for_exit(&mut child.0, Duration::from_secs(10));
    assert!(
        status.success(),
        "expected clean exit 0 on stdin EOF, got {status}\nstderr: {}",
        fs::read_to_string(&stderr_path).unwrap_or_default()
    );

    // SSE stream closed cleanly as part of graceful shutdown.
    let mut trailing = Vec::new();
    let _ = sse_reader.read_to_end(&mut trailing);

    // No extra stdout lines were emitted beyond the single readiness line.
    assert!(
        extra_stdout_rx.try_recv().is_err(),
        "unexpected extra stdout output from sidecar"
    );

    // runtime.lock was released cleanly so the data store can be reopened immediately.
    let _store = Store::open(&data.join("events.sqlite")).unwrap();
}

#[test]
fn desktop_sidecar_shuts_down_cleanly_on_stdin_shutdown_command() {
    let temp = TempDir::new().unwrap();
    let data = temp.path().join("app-data");
    let stderr_path = temp.path().join("sidecar.stderr.log");

    let mut child = SidecarGuard(
        Command::new(env!("CARGO_BIN_EXE_grapher"))
            .arg("--desktop-sidecar")
            .env("GRAPHER_PORT", "0")
            .env("GRAPHER_DATA_DIR", &data)
            .env("GRAPHER_DEV_LAZY_PRIMARY", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(fs::File::create(&stderr_path).unwrap())
            .spawn()
            .unwrap(),
    );

    let mut stdin = child.0.stdin.take().unwrap();
    let stdout = child.0.stdout.take().unwrap();
    let (ready_line, _) = read_first_line_with_timeout(stdout, Duration::from_secs(20));
    let ready: Value = serde_json::from_str(ready_line.trim()).unwrap();
    assert_eq!(ready["type"], "grapher_ready");
    assert_ne!(ready["port"].as_u64().unwrap(), 0);

    writeln!(stdin, "shutdown").unwrap();
    stdin.flush().unwrap();
    let status = wait_for_exit(&mut child.0, Duration::from_secs(10));
    assert!(
        status.success(),
        "expected clean exit 0 on stdin shutdown command, got {status}\nstderr: {}",
        fs::read_to_string(&stderr_path).unwrap_or_default()
    );
}

#[test]
fn fixed_port_browser_cli_mode_preserves_quiet_stdout_and_ignores_stdin_eof() {
    let temp = TempDir::new().unwrap();
    let data = temp.path().join("data");
    let stderr_path = temp.path().join("cli.stderr.log");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let mut child = SidecarGuard(
        Command::new(env!("CARGO_BIN_EXE_grapher"))
            .env("GRAPHER_PORT", port.to_string())
            .env("GRAPHER_DATA_DIR", &data)
            .env("GRAPHER_DEV_LAZY_PRIMARY", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(fs::File::create(&stderr_path).unwrap())
            .spawn()
            .unwrap(),
    );

    let stdout = child.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf = String::new();
        let _ = reader.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });

    // Wait for server readiness via HTTP probe; closed stdin must NOT shut down CLI/dev mode.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            panic!(
                "CLI/dev backend unexpectedly exited ({status}) with closed stdin: {}",
                fs::read_to_string(&stderr_path).unwrap_or_default()
            );
        }
        if let Ok(mut stream) = TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_millis(100),
        ) {
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            write!(
                stream,
                "POST /api/snapshot HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: tauri://localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            )
            .unwrap();
            let mut resp = String::new();
            stream.read_to_string(&mut resp).unwrap();
            // Browser/CLI mode rejects Tauri origin by default.
            assert!(
                resp.starts_with("HTTP/1.1 403 Forbidden"),
                "expected 403 for tauri origin in browser/CLI mode: {resp}"
            );
            break;
        }
        assert!(Instant::now() < deadline, "timeout waiting for CLI backend");
        thread::sleep(Duration::from_millis(25));
    }

    // Regular loopback origin works on the fixed port.
    let ok_resp = http_exchange(
        port,
        &format!(
            "POST /api/snapshot HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:1420\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        ),
    );
    assert!(ok_resp.starts_with("HTTP/1.1 200 OK"), "{ok_resp}");

    // OS signal shutdown continues to work in browser/CLI mode.
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(child.0.id() as libc::pid_t, libc::SIGTERM);
        }
        let status = wait_for_exit(&mut child.0, Duration::from_secs(10));
        assert!(status.success(), "expected clean exit on SIGTERM: {status}");
        let stdout_text = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            stdout_text.is_empty(),
            "expected quiet stdout in fixed-port browser/CLI mode, got: {stdout_text:?}"
        );
    }
    #[cfg(not(unix))]
    {
        let _ = child.0.kill();
        let _ = child.0.wait();
        let stdout_text = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            stdout_text.is_empty(),
            "expected quiet stdout in fixed-port browser/CLI mode, got: {stdout_text:?}"
        );
    }
}

#[test]
fn desktop_sidecar_first_launch_reports_actionable_git_preflight_when_host_git_absent() {
    let temp = TempDir::new().unwrap();
    let data = temp.path().join("app-data");
    let stderr_path = temp.path().join("sidecar-nogit.stderr.log");
    let missing_git = temp.path().join("no-such-git");

    let mut child = SidecarGuard(
        Command::new(env!("CARGO_BIN_EXE_grapher"))
            .arg("--desktop-sidecar")
            .env("GRAPHER_PORT", "0")
            .env("GRAPHER_DATA_DIR", &data)
            .env("GRAPHER_TRUSTED_GIT", &missing_git)
            .env("GRAPHER_DEV_LAZY_PRIMARY", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(fs::File::create(&stderr_path).unwrap())
            .spawn()
            .unwrap(),
    );

    let stdin = child.0.stdin.take().unwrap();
    let stdout = child.0.stdout.take().unwrap();
    let (ready_line, _) = read_first_line_with_timeout(stdout, Duration::from_secs(20));
    let ready: Value = serde_json::from_str(ready_line.trim()).unwrap();
    let port = ready["port"].as_u64().unwrap() as u16;
    assert_ne!(port, 0);

    // Bootstrap succeeds without crashing and reports actionable Git diagnostics.
    let boot_resp = http_exchange(
        port,
        &format!(
            "POST /api/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: tauri://localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        ),
    );
    assert!(boot_resp.starts_with("HTTP/1.1 200 OK"), "{boot_resp}");
    let body_text = boot_resp.split("\r\n\r\n").nth(1).unwrap();
    let boot_json: Value = serde_json::from_str(body_text).unwrap();
    let preflight = &boot_json["result"]["hostPreflight"];
    assert_eq!(preflight["gitAvailable"], Value::Bool(false), "{preflight}");
    let git_error = preflight["gitError"].as_str().unwrap_or("");
    assert!(git_error.contains("GRAPHER_TRUSTED_GIT"), "{git_error}");
    #[cfg(target_os = "macos")]
    assert!(
        git_error.contains("xcode-select --install"),
        "expected macOS Xcode Command Line Tools guidance: {git_error}"
    );
    #[cfg(windows)]
    assert!(
        git_error.contains("Git for Windows"),
        "expected Windows Git guidance: {git_error}"
    );

    // Dedicated re-check endpoint reports the same structured diagnostic.
    let preflight_resp = http_exchange(
        port,
        &format!(
            "POST /api/host_preflight HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: tauri://localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        ),
    );
    assert!(
        preflight_resp.starts_with("HTTP/1.1 200 OK"),
        "{preflight_resp}"
    );
    let preflight_body = preflight_resp.split("\r\n\r\n").nth(1).unwrap();
    let preflight_json: Value = serde_json::from_str(preflight_body).unwrap();
    assert_eq!(preflight_json["result"]["gitAvailable"], Value::Bool(false));

    drop(stdin);
    let status = wait_for_exit(&mut child.0, Duration::from_secs(10));
    assert!(status.success(), "expected clean exit, got {status}");
}
