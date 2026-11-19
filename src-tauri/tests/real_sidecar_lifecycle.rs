//! End-to-end desktop shell tests against the real compiled `grapher` backend:
//! - Launches the backend via `BackendSidecar` in dynamic-port desktop mode.
//! - Verifies bundled `GRAPHER_INSTALLATION_ROOT/dist` serving and Tauri origin access.
//! - Verifies live cross-process `runtime.lock` exclusion during legacy migration,
//!   followed by graceful stdin-EOF shutdown and successful preserve-first migration.
use grapher_desktop_lib::{
    migration::{migrate_legacy_data_if_needed, MigrationOutcome},
    paths::backend_binary_name,
    sidecar::{BackendSidecar, ShutdownKind, SidecarConfig},
};
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    time::Duration,
};
use tempfile::TempDir;

fn locate_real_backend() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("GRAPHER_TEST_BACKEND_BIN") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
    }
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let name = backend_binary_name();
    for profile in ["debug", "release"] {
        let candidate = repo_root.join("backend/target").join(profile).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
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

#[test]
fn real_backend_sidecar_lifecycle_and_live_lock_migration_interoperability() {
    let Some(backend) = locate_real_backend() else {
        eprintln!(
            "Skipping real backend lifecycle test: backend binary not built yet (build backend first)."
        );
        return;
    };

    let temp = TempDir::new().unwrap();
    let resources = temp.path().join("staged-runtime");
    fs::create_dir_all(resources.join("dist")).unwrap();
    fs::write(
        resources.join("dist/index.html"),
        "<!doctype html><title>Tauri Shell Resource</title>",
    )
    .unwrap();

    let legacy_data = temp.path().join("legacy-store");
    let app_data = temp.path().join("desktop-app-data");

    // 1. Start the real backend on `legacy_data` (holding its real runtime.lock).
    let mut config = SidecarConfig::new(
        backend.clone(),
        resources.clone(),
        None,
        None,
        legacy_data.clone(),
    );
    config
        .extra_env
        .push(("GRAPHER_DEV_LAZY_PRIMARY".into(), "1".into()));

    let sidecar = BackendSidecar::start(config).unwrap();
    let url = sidecar.backend_url().unwrap();
    let port = sidecar.info().port;
    assert_eq!(url, format!("http://127.0.0.1:{port}"));
    assert_ne!(port, 0);

    // 2. Verify bundled resource static serving and Tauri v2 origin access.
    let index_resp = http_exchange(
        port,
        &format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"),
    );
    assert!(index_resp.starts_with("HTTP/1.1 200 OK"), "{index_resp}");
    assert!(index_resp.contains("Tauri Shell Resource"), "{index_resp}");

    let api_resp = http_exchange(
        port,
        &format!(
            "POST /api/snapshot HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: tauri://localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        ),
    );
    assert!(api_resp.starts_with("HTTP/1.1 200 OK"), "{api_resp}");
    assert!(
        api_resp.contains("Access-Control-Allow-Origin: tauri://localhost\r\n"),
        "{api_resp}"
    );

    // Add an unrelated user file inside the legacy store.
    fs::write(legacy_data.join("custom-note.txt"), b"keep-me-intact").unwrap();

    // 3. While the real backend is alive, migration MUST refuse because runtime.lock is held.
    let lock_err = migrate_legacy_data_if_needed(&app_data, Some(&legacy_data), &[]).unwrap_err();
    assert!(
        lock_err.contains("Another Grapher instance owns this runtime"),
        "{lock_err}"
    );
    assert!(!app_data.join("data").exists());

    // 4. Close stdin -> graceful backend shutdown releases runtime.lock cleanly.
    assert_eq!(sidecar.shutdown(), ShutdownKind::Graceful);

    // 5. Now migration succeeds, preserves source + unrelated files, and desktop backend can boot on it.
    let outcome = migrate_legacy_data_if_needed(&app_data, Some(&legacy_data), &[]).unwrap();
    assert!(matches!(outcome, MigrationOutcome::Migrated { .. }), "{outcome:?}");

    let migrated_data = app_data.join("data");
    assert_eq!(
        fs::read(migrated_data.join("custom-note.txt")).unwrap(),
        b"keep-me-intact"
    );
    assert_eq!(
        fs::read(legacy_data.join("custom-note.txt")).unwrap(),
        b"keep-me-intact"
    );
    assert!(migrated_data.join("events.sqlite").is_file());
    assert!(!migrated_data.join("runtime.lock").exists());

    // 6. Launch desktop sidecar directly against the migrated `app_data/data` store.
    let mut desktop_config = SidecarConfig::new(
        backend,
        resources,
        None,
        None,
        migrated_data,
    );
    desktop_config
        .extra_env
        .push(("GRAPHER_DEV_LAZY_PRIMARY".into(), "1".into()));
    let desktop_sidecar = BackendSidecar::start(desktop_config).unwrap();
    assert_ne!(desktop_sidecar.info().port, 0);
    assert_eq!(desktop_sidecar.shutdown(), ShutdownKind::Graceful);
}
