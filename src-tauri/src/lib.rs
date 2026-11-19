//! Grapher Tauri v2 desktop shell.
//!
//! Owns the existing Rust `grapher` backend as a child process, runs
//! preserve-first legacy-data migration into `app_data_dir()/data`, exposes the
//! narrow `backend_url` IPC command, wires the Tauri v2 autostart + updater +
//! process relaunch plugins, and shuts down the backend cleanly on exit.
pub mod managed_git;
pub mod migration;
pub mod paths;
pub mod runtime_lock;
pub mod sidecar;

use managed_git::{
    existing_managed_git, expected_managed_git_path, GitBootstrapManager, GitBootstrapStatus,
};
use migration::{default_legacy_candidates, migrate_legacy_data_if_needed, MigrationOutcome};
use paths::{resolve_runtime_paths, ResolvedRuntimePaths};
use sidecar::{BackendSidecar, SidecarConfig};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{Manager, Resource, RunEvent};

pub struct BackendState {
    outcome: Result<Arc<BackendSidecar>, String>,
}

/// Resource registered in Tauri's app-level `ResourceTable` so `cleanup_before_exit()`
/// (called by `tauri-plugin-updater` on Windows right after signature verification and
/// installer extraction, immediately before launching NSIS and calling `std::process::exit(0)`)
/// shuts down the `grapher` sidecar before the installer replaces bundled binaries.
struct SidecarShutdownGuard(Arc<BackendSidecar>);

impl Resource for SidecarShutdownGuard {}

impl Drop for SidecarShutdownGuard {
    fn drop(&mut self) {
        let _ = self.0.shutdown();
    }
}

impl BackendState {
    pub fn ready(sidecar: BackendSidecar) -> Self {
        Self {
            outcome: Ok(Arc::new(sidecar)),
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            outcome: Err(message.into()),
        }
    }

    pub fn sidecar(&self) -> Option<Arc<BackendSidecar>> {
        self.outcome.as_ref().ok().map(Arc::clone)
    }

    pub fn backend_url(&self) -> Result<String, String> {
        match &self.outcome {
            Ok(sidecar) => sidecar.backend_url(),
            Err(error) => Err(error.clone()),
        }
    }

    pub fn shutdown(&self) {
        if let Ok(sidecar) = &self.outcome {
            let _ = sidecar.shutdown();
        }
    }
}

#[tauri::command]
fn backend_url(state: tauri::State<'_, BackendState>) -> Result<String, String> {
    state.backend_url()
}

#[tauri::command]
fn git_bootstrap_status(manager: tauri::State<'_, GitBootstrapManager>) -> GitBootstrapStatus {
    manager.status()
}

#[tauri::command]
fn retry_git_bootstrap(manager: tauri::State<'_, GitBootstrapManager>) -> GitBootstrapStatus {
    manager.retry()
}

fn decode_base64_std(input: &str) -> Result<Vec<u8>, &'static str> {
    let compact: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if compact.is_empty() || compact.len() % 4 != 0 {
        return Err("invalid base64 length");
    }
    let mut out = Vec::with_capacity((compact.len() / 4) * 3);
    for chunk in compact.chunks_exact(4) {
        let mut vals = [0u8; 4];
        let mut pad = 0usize;
        for (i, &b) in chunk.iter().enumerate() {
            vals[i] = match b {
                b'A'..=b'Z' => b - b'A',
                b'a'..=b'z' => b - b'a' + 26,
                b'0'..=b'9' => b - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' if i >= 2 => {
                    pad += 1;
                    0
                }
                _ => return Err("invalid base64 character"),
            };
        }
        if pad == 1 && chunk[3] != b'=' {
            return Err("invalid base64 padding");
        }
        if pad == 2 && (chunk[2] != b'=' || chunk[3] != b'=') {
            return Err("invalid base64 padding");
        }
        let n = ((vals[0] as u32) << 18)
            | ((vals[1] as u32) << 12)
            | ((vals[2] as u32) << 6)
            | (vals[3] as u32);
        out.push(((n >> 16) & 0xff) as u8);
        if pad < 2 {
            out.push(((n >> 8) & 0xff) as u8);
        }
        if pad < 1 {
            out.push((n & 0xff) as u8);
        }
    }
    Ok(out)
}

fn contains_secret_key_marker(text: &str) -> bool {
    let lowered = text.to_ascii_lowercase();
    lowered.contains("private key")
        || lowered.contains("secret key")
        || lowered.contains("encrypted secret")
}

/// Validates a Tauri base64-encoded 2-line Ed25519 minisign public key.
/// Rejects raw or base64-encoded secret/private keys, raw unencoded 2-line text,
/// and truncated or non-Ed25519 payloads without echoing candidate contents.
pub fn validate_minisign_pubkey(candidate: &str) -> Result<String, String> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return Err("updater public key is empty".to_string());
    }
    if contains_secret_key_marker(trimmed) {
        return Err("refusing secret/private key material in updater public key".to_string());
    }
    if trimmed.starts_with("untrusted comment:") {
        return Err(
            "updater public key must be base64-encoded rather than raw 2-line minisign text"
                .to_string(),
        );
    }
    let decoded_bytes = decode_base64_std(trimmed)
        .map_err(|reason| format!("updater public key is not valid base64 ({reason})"))?;
    let decoded = String::from_utf8(decoded_bytes)
        .map_err(|_| "updater public key did not decode to valid UTF-8".to_string())?;
    if contains_secret_key_marker(&decoded) {
        return Err(
            "refusing base64-encoded secret/private key material in updater public key".to_string(),
        );
    }
    let lines: Vec<&str> = decoded
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.len() != 2 || !lines[0].starts_with("untrusted comment:") {
        return Err(
            "updater public key does not decode to a valid 2-line minisign public key".to_string(),
        );
    }
    let key_bytes = decode_base64_std(lines[1])
        .map_err(|reason| format!("updater public key inner line is not valid base64 ({reason})"))?;
    if key_bytes.len() != 42 || &key_bytes[..2] != b"Ed" {
        return Err(
            "updater public key does not contain a valid 42-byte Ed25519 minisign key".to_string(),
        );
    }
    let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    Ok(compact)
}

fn sanitize_updater_pubkey(candidate: &str) -> Option<&str> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return None;
    }
    if contains_secret_key_marker(trimmed) {
        return None;
    }
    if let Ok(decoded_bytes) = decode_base64_std(trimmed) {
        if let Ok(decoded) = std::str::from_utf8(&decoded_bytes) {
            if contains_secret_key_marker(decoded) {
                return None;
            }
        }
    }
    Some(trimmed)
}

/// Resolves an optional compile-time or configured minisign public key.
/// Never accepts private/secret key material; empty/whitespace values stay unset
/// so unsigned builds start cleanly while signature verification still fails closed.
pub fn resolve_updater_pubkey(
    configured: &str,
    compile_time_override: Option<&str>,
) -> Option<String> {
    resolve_updater_pubkey_from_sources(configured, compile_time_override, None)
}

/// Resolves an updater public key across primary override, fallback override, and
/// `tauri.conf.json` configured key. Empty/whitespace overrides fall through instead
/// of shadowing later sources (for example when CI exports `GRAPHER_UPDATER_PUBKEY=""`).
pub fn resolve_updater_pubkey_from_sources(
    configured: &str,
    primary_override: Option<&str>,
    fallback_override: Option<&str>,
) -> Option<String> {
    primary_override
        .and_then(sanitize_updater_pubkey)
        .or_else(|| fallback_override.and_then(sanitize_updater_pubkey))
        .or_else(|| sanitize_updater_pubkey(configured))
        .map(str::to_owned)
}

fn compile_time_updater_pubkey() -> Option<String> {
    resolve_updater_pubkey_from_sources(
        "",
        option_env!("GRAPHER_UPDATER_PUBKEY"),
        option_env!("TAURI_UPDATER_PUBKEY"),
    )
}

fn dev_repo_root() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(Path::to_path_buf)
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

fn initialize_backend(
    app_data_dir: &Path,
    resource_dir: Option<&Path>,
    current_exe: Option<&Path>,
    dev_root: Option<&Path>,
    require_bundled_node: bool,
) -> Result<(BackendSidecar, GitBootstrapManager), String> {
    let resolved: ResolvedRuntimePaths = resolve_runtime_paths(
        resource_dir,
        current_exe,
        dev_root,
        require_bundled_node,
    )?;

    let (explicit_legacy, implicit_legacy) =
        default_legacy_candidates(current_exe, &resolved.installation_root);
    match migrate_legacy_data_if_needed(app_data_dir, explicit_legacy.as_deref(), &implicit_legacy)?
    {
        MigrationOutcome::Migrated {
            source,
            destination,
            files_copied,
            bytes_copied,
        } => {
            eprintln!(
                "[grapher-desktop] Migrated legacy store from {} to {} ({files_copied} files, {bytes_copied} bytes; source preserved).",
                source.display(),
                destination.display()
            );
        }
        MigrationOutcome::SkippedDestinationExists | MigrationOutcome::SkippedNoLegacySource => {}
    }

    let effective_git = resolved
        .trusted_git
        .or_else(|| existing_managed_git(app_data_dir));
    let git_bootstrap = GitBootstrapManager::new(app_data_dir.to_path_buf(), effective_git.clone());
    git_bootstrap.start_background_if_needed();

    let data_dir = app_data_dir.join("data");
    let mut config = SidecarConfig::new(
        resolved.backend_executable,
        resolved.installation_root,
        resolved.bundled_node,
        effective_git,
        data_dir,
    );
    config.managed_git_path = expected_managed_git_path(app_data_dir);
    let sidecar = BackendSidecar::start(config)?;
    Ok((sidecar, git_bootstrap))
}

#[cfg(desktop)]
fn build_autostart_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.set_decorations(false) {
                    eprintln!(
                        "[grapher-desktop] Warning: failed to disable native window decorations on Windows: {error}"
                    );
                }
            }

            #[cfg(desktop)]
            {
                let mut updater_builder = tauri_plugin_updater::Builder::new();
                if let Some(pubkey) = compile_time_updater_pubkey() {
                    updater_builder = updater_builder.pubkey(pubkey);
                }
                app.handle().plugin(updater_builder.build())?;

                // Register user-level launch-at-login support (macOS LaunchAgent /
                // Windows HKCU Run) without altering OS registration on startup.
                // Plugin init errors stay non-fatal so app startup never breaks
                // and Settings surfaces an explicit diagnostic if queried.
                if let Err(error) = app.handle().plugin(build_autostart_plugin()) {
                    eprintln!(
                        "[grapher-desktop] Warning: failed to register autostart plugin (continuing startup): {error}"
                    );
                }
            }

            let app_data_dir = app.path().app_data_dir().map_err(|error| {
                format!("Cannot resolve Tauri application data directory: {error}")
            })?;
            let resource_dir = app.path().resource_dir().ok();
            let current_exe = std::env::current_exe().ok();
            let require_bundled_node = !cfg!(debug_assertions);

            let (state, git_bootstrap) = match initialize_backend(
                &app_data_dir,
                resource_dir.as_deref(),
                current_exe.as_deref(),
                dev_repo_root().as_deref(),
                require_bundled_node,
            ) {
                Ok((sidecar, git_bootstrap)) => {
                    eprintln!(
                        "[grapher-desktop] Backend ready at {} (data: {})",
                        sidecar.info().base_url,
                        sidecar.info().data_dir
                    );
                    (BackendState::ready(sidecar), git_bootstrap)
                }
                Err(error) => {
                    eprintln!("[grapher-desktop] Startup failed: {error}");
                    (
                        BackendState::failed(error),
                        GitBootstrapManager::new(app_data_dir.clone(), None),
                    )
                }
            };

            if let Some(sidecar) = state.sidecar() {
                app.resources_table().add(SidecarShutdownGuard(sidecar));
            }
            app.manage(state);
            app.manage(git_bootstrap);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_url,
            git_bootstrap_status,
            retry_git_bootstrap
        ])
        .build(tauri::generate_context!())
        .expect("error while building Grapher desktop application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(state) = app_handle.try_state::<BackendState>() {
                state.shutdown();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn backend_state_surfaces_setup_failure_and_handles_idempotent_shutdown() {
        let state = BackendState::failed("Bundled runtime missing");
        let err = state.backend_url().unwrap_err();
        assert_eq!(err, "Bundled runtime missing");
        state.shutdown();
        assert_eq!(state.backend_url().unwrap_err(), "Bundled runtime missing");
    }

    #[test]
    fn initialize_backend_fails_cleanly_when_bundled_resources_are_absent() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app-data");
        let empty_res = temp.path().join("empty-resources");
        fs::create_dir_all(&empty_res).unwrap();

        let err = initialize_backend(&app_data, Some(&empty_res), None, None, true)
            .err()
            .unwrap();
        assert!(
            err.contains("Bundled Grapher runtime resources are missing"),
            "{err}"
        );
        // Setup failure must not leave a partial `data` directory behind.
        assert!(!app_data.join("data").exists());
    }

    #[test]
    fn resolve_updater_pubkey_prefers_override_and_treats_blank_as_unsigned() {
        assert_eq!(resolve_updater_pubkey("", None), None);
        assert_eq!(resolve_updater_pubkey("   ", Some(" \n ")), None);
        assert_eq!(
            resolve_updater_pubkey("dW50cnVzdGVkIGNvbW1lbnQ=", None).as_deref(),
            Some("dW50cnVzdGVkIGNvbW1lbnQ=")
        );
        assert_eq!(
            resolve_updater_pubkey("old-key", Some("  new-key  ")).as_deref(),
            Some("new-key")
        );
        // Empty primary override (such as unset CI vars) must fall through to fallback/config.
        assert_eq!(
            resolve_updater_pubkey_from_sources("config-key", Some(""), Some("  fallback-key  "))
                .as_deref(),
            Some("fallback-key")
        );
        assert_eq!(
            resolve_updater_pubkey_from_sources("config-key", Some("  "), Some("")).as_deref(),
            Some("config-key")
        );
        // Never accept raw or base64-encoded private/secret key material in a public-key slot.
        assert_eq!(
            resolve_updater_pubkey_from_sources(
                "",
                Some("-----BEGIN PRIVATE KEY-----"),
                Some("untrusted comment: minisign encrypted secret key"),
            ),
            None
        );
        // Base64 of "untrusted comment: rsign encrypted secret key\nRWQf...\n" (Tauri CLI private key format).
        let base64_rsign_secret =
            "dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5ClJXUWY2TFJDR0E5aTUzbWxZZWNPNEk9Cg==";
        assert_eq!(
            resolve_updater_pubkey_from_sources("", Some(base64_rsign_secret), None),
            None
        );
        assert!(validate_minisign_pubkey(base64_rsign_secret).is_err());

        // Valid base64-encoded 2-line 42-byte Ed25519 minisign public key passes strict validation.
        // Inner payload: "Ed" + 8-byte key id + 32-byte pubkey = 42 bytes -> base64 "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"
        let valid_pubkey =
            "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEY5NjJEQ0QyMjgyQTZFMzIKUldRZjZMUkNHQTlpNTNtbFllY080SXpUNTFUR1Bwdld1Y05TQ2gxQ0JNMFFUYUxuNzNZN0dGTzMK";
        assert_eq!(
            validate_minisign_pubkey(valid_pubkey).as_deref(),
            Ok(valid_pubkey)
        );
        // Raw (un-base64-encoded) 2-line public key is rejected with explicit guidance.
        assert!(
            validate_minisign_pubkey(
                "untrusted comment: minisign public key: F962DCD2282A6E32\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n"
            )
            .unwrap_err()
            .contains("base64-encoded")
        );
        // Truncated/invalid Ed25519 key payload is rejected.
        assert!(
            validate_minisign_pubkey("dW50cnVzdGVkIGNvbW1lbnQ6IGJhZAoKQUFBQQo=").is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn sidecar_shutdown_guard_stops_sidecar_when_resource_is_dropped() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("fake-backend.sh");
        fs::write(
            &script,
            "#!/bin/sh\nprintf '{\"type\":\"grapher_ready\",\"port\":43219,\"dataDir\":\"/tmp/d\"}\\n'\ncat >/dev/null\nexit 0\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        let config = SidecarConfig::new(
            script,
            temp.path().to_path_buf(),
            None,
            None,
            temp.path().join("data"),
        );
        let state = BackendState::ready(BackendSidecar::start(config).unwrap());
        let guard = SidecarShutdownGuard(state.sidecar().unwrap());
        assert!(state.backend_url().is_ok());

        // Simulates Tauri's `cleanup_before_exit()` clearing `app.resources_table()`
        // right before Windows NSIS handoff + `std::process::exit(0)`.
        drop(guard);
        assert!(state.backend_url().is_err());

        // Subsequent `RunEvent::Exit` shutdown stays idempotent.
        state.shutdown();
    }

    #[cfg(desktop)]
    #[test]
    fn build_autostart_plugin_registers_autostart_namespace_without_side_effects() {
        use tauri::plugin::Plugin;
        let plugin = build_autostart_plugin::<tauri::Wry>();
        assert_eq!(plugin.name(), "autostart");
    }
}
