//! Read-only raster previews scoped to a retained conversation workspace.
use super::{argument, open_file_context, open_file_roots, resolve_open_file_target, Service};
use std::{fs, io::Read, path::PathBuf, sync::Arc};

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

fn read_image(roots: &[PathBuf], path: &str) -> Result<(Vec<u8>, &'static str), String> {
    // Validate independently of the host: Windows prefixes/ADS and backslash
    // traversal must remain invalid when a transcript is opened on Unix too.
    let path = path.replace('\\', "/");
    let path = path.strip_prefix("./").unwrap_or(&path);
    if path.is_empty()
        || path.contains(':')
        || path.chars().any(char::is_control)
        || path.split('/').any(|part| {
            part.is_empty()
                || matches!(part, "." | "..")
                || part.eq_ignore_ascii_case(".git")
                || part.eq_ignore_ascii_case(".grapher")
        })
    {
        return Err("Invalid workspace image path".into());
    }
    let target = resolve_open_file_target(roots, path)?;
    let file = fs::File::open(target).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() > MAX_IMAGE_BYTES {
        return Err("Workspace image exceeds 20 MiB".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("Workspace image exceeds 20 MiB".into());
    }
    // Inspect bytes, not an extension supplied by the model. SVG/HTML are
    // deliberately excluded: this endpoint never serves active documents.
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if bytes.starts_with(b"BM") {
        "image/bmp"
    } else {
        return Err("Unsupported workspace image format".into());
    };
    Ok((bytes, mime))
}

pub(super) fn get_workspace_image(
    service: &Arc<Service>,
    body: &serde_json::Value,
) -> Result<(Vec<u8>, &'static str), String> {
    let run_id: String = argument(body, "runId")?;
    if run_id.is_empty() {
        return Err("A Run ID is required for workspace images".into());
    }
    let path: String = argument(body, "path")?;
    let execution_id: Option<String> = argument(body, "executionId")?;
    let context = {
        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
        if runtime.state.run_id != run_id {
            return Err("Run does not match service".into());
        }
        open_file_context(&runtime.state)
    };
    let scope = execution_id.map(|id| vec![id]);
    let roots = open_file_roots(&context, scope.as_deref(), &["planner".into()])?;
    read_image(&roots, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_images_require_run_and_execution_scope_and_fall_back_to_source() {
        use crate::{model::*, runtime::Runtime};
        use std::sync::{atomic::AtomicBool, Condvar, Mutex};
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let first = temp.path().join("first");
        let other = temp.path().join("other");
        for (root, text) in [(&source, "source"), (&first, "first"), (&other, "other")] {
            fs::create_dir(root).unwrap();
            fs::write(
                root.join("image.png"),
                [b"\x89PNG\r\n\x1a\n".as_slice(), text.as_bytes()].concat(),
            )
            .unwrap();
        }
        let mut runtime = Runtime::open(&temp.path().join("data")).unwrap();
        runtime.state.run_id = "image-run".into();
        runtime.state.config = Some(
            serde_json::from_value(serde_json::json!({
                "repository": source, "model": "test", "maxParallel": 1
            }))
            .unwrap(),
        );
        runtime.state.executions = [(&first, "first"), (&other, "other")]
            .into_iter()
            .map(|(root, id)| Execution {
                id: id.into(),
                node: id.into(),
                revision: 1,
                attempt: 1,
                session_id: id.into(),
                worktree: root.to_string_lossy().into(),
                before: String::new(),
                workspace_lineage: vec![],
                after: None,
                input: None,
                result: None,
                status: "completed".into(),
                output: String::new(),
                output_bytes: 0,
                pid: None,
                started_at: 1,
                completed_at: Some(2),
                metrics: None,
            })
            .collect();
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            drive_signal: (Mutex::new(0), Condvar::new()),
            planning: AtomicBool::new(false),
            extension: PathBuf::new(),
        });
        let body = serde_json::json!({ "runId": "image-run", "executionId": "first", "path": "image.png" });
        assert!(get_workspace_image(&service, &body)
            .unwrap()
            .0
            .ends_with(b"first"));
        fs::remove_file(first.join("image.png")).unwrap();
        assert!(
            get_workspace_image(&service, &body)
                .unwrap()
                .0
                .ends_with(b"source"),
            "do not substitute another node's image"
        );
        for body in [
            serde_json::json!({ "path": "image.png" }),
            serde_json::json!({ "runId": "wrong", "path": "image.png" }),
            serde_json::json!({ "runId": "image-run", "executionId": "unknown", "path": "image.png" }),
        ] {
            assert!(get_workspace_image(&service, &body).is_err());
        }

        // Exercise the binary HTTP response and the same JSON-POST admission
        // used by the rest of the local API (an <img> GET must not read files).
        use std::{io::Write, net::TcpStream, thread, time::Duration};
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let web_root = temp.path().to_path_buf();
        let worker = thread::spawn(move || {
            for _ in 0..2 {
                let request = server.recv().unwrap();
                super::super::handle_http_request(request, &service, &web_root, address.port());
            }
        });
        for method in ["POST", "GET"] {
            let mut socket = TcpStream::connect(address).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let input = if method == "POST" {
                body.to_string()
            } else {
                String::new()
            };
            write!(socket, "{method} /api/get_workspace_image HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{input}", input.len()).unwrap();
            let mut response = Vec::new();
            socket.read_to_end(&mut response).unwrap();
            let boundary = response
                .windows(4)
                .position(|bytes| bytes == b"\r\n\r\n")
                .unwrap();
            let headers = String::from_utf8_lossy(&response[..boundary]).to_lowercase();
            if method == "POST" {
                assert!(headers.starts_with("http/1.1 200"), "{headers}");
                assert!(headers.contains("content-type: image/png"));
                assert!(headers.contains("cache-control: no-store"));
                assert!(headers.contains("x-content-type-options: nosniff"));
                assert_eq!(&response[boundary + 4..], b"\x89PNG\r\n\x1a\nsource");
            } else {
                assert!(headers.starts_with("http/1.1 415"), "{headers}");
            }
        }
        worker.join().unwrap();
    }

    #[test]
    fn workspace_images_read_rasters_and_reject_unsafe_or_unbounded_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        fs::create_dir_all(root.join("artifacts/中文 space")).unwrap();
        let png = b"\x89PNG\r\n\x1a\npreview";
        fs::write(root.join("artifacts/中文 space/截图.png"), png).unwrap();
        let roots = vec![root.clone()];
        let (bytes, mime) = read_image(&roots, "./artifacts/中文 space/截图.png").unwrap();
        assert_eq!(bytes, png);
        assert_eq!(mime, "image/png");
        for path in [
            "../outside.png",
            "/absolute.png",
            "C:\\image.png",
            "artifacts/../x.png",
            "..\\outside.png",
            ".git/image.png",
            ".GRAPHER/image.png",
            "image.png:stream",
            "missing.png",
            "artifacts",
        ] {
            assert!(read_image(&roots, path).is_err(), "{path}");
        }
        fs::write(root.join("fake.png"), b"<svg onload='evil()'></svg>").unwrap();
        assert!(read_image(&roots, "fake.png").is_err());
        let large = fs::File::create(root.join("large.png")).unwrap();
        large.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert!(read_image(&roots, "large.png")
            .unwrap_err()
            .contains("20 MiB"));

        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("image.png"), png).unwrap();
        crate::path_safety::directory_link(&outside, &root.join("linked"));
        assert!(read_image(&roots, "linked/image.png").is_err());
    }
}
