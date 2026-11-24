//! Grapher Tauri v2 desktop shell.
//!
//! Owns the existing Rust `grapher` backend as a child process, runs
//! preserve-first legacy-data migration into `app_data_dir()/data`, exposes the
//! narrow `backend_url` IPC command, wires the Tauri v2 autostart + updater +
//! process relaunch plugins, and shuts down the backend cleanly on exit.
#[cfg(target_os = "macos")]
pub mod macos_notifications;
pub mod managed_git;
pub mod migration;
pub mod paths;
pub mod runtime_lock;
pub mod sidecar;
#[cfg(desktop)]
pub mod terminal;

use managed_git::{
    existing_managed_git, expected_managed_git_path, GitBootstrapManager, GitBootstrapStatus,
};
use migration::{default_legacy_candidates, migrate_legacy_data_if_needed, MigrationOutcome};
use paths::{resolve_runtime_paths, ResolvedRuntimePaths};
use sidecar::{BackendSidecar, SidecarConfig};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager, Resource, RunEvent};

pub const DESKTOP_NOTIFICATION_CLICKED_EVENT: &str = "grapher://notification-clicked";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NotificationClickEvent {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub seq: u64,
}

#[derive(Default)]
pub struct PendingNotificationClickState {
    next_seq: AtomicU64,
    pending: Mutex<Option<NotificationClickEvent>>,
}

impl PendingNotificationClickState {
    pub fn record(&self, run_id: String) -> NotificationClickEvent {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let event = NotificationClickEvent { run_id, seq };
        if let Ok(mut guard) = self.pending.lock() {
            *guard = Some(event.clone());
        }
        event
    }

    pub fn take(&self) -> Option<NotificationClickEvent> {
        self.pending
            .lock()
            .ok()
            .and_then(|mut guard| guard.take())
    }
}

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

#[cfg(desktop)]
struct TerminalShutdownGuard(Arc<terminal::TerminalManager>);

#[cfg(desktop)]
impl Resource for TerminalShutdownGuard {}

#[cfg(desktop)]
impl Drop for TerminalShutdownGuard {
    fn drop(&mut self) {
        self.0.kill_all();
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

const MAX_EXTERNAL_URL_BYTES: usize = 4096;

/// Validates an external browser URL for the desktop shell.
/// Only `http://` and `https://` URLs with a non-empty authority and no control
/// or whitespace characters are permitted.
pub fn validate_external_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("External URL is empty".to_string());
    }
    if trimmed.len() > MAX_EXTERNAL_URL_BYTES {
        return Err("External URL exceeds maximum allowed length".to_string());
    }
    if trimmed
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err("External URL contains invalid whitespace or control characters".to_string());
    }
    if trimmed.contains('\\') {
        return Err("External URL contains invalid backslash characters".to_string());
    }
    let Some((_, rest)) = trimmed.split_once("://") else {
        return Err("External URL must use http:// or https://".to_string());
    };
    if rest.starts_with('/') {
        return Err("External URL is missing a valid host".to_string());
    }
    let parsed = tauri::Url::parse(trimmed)
        .map_err(|_| "External URL must be a valid http:// or https:// URL".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!(
            "Refusing non-HTTP external URL scheme: {}",
            parsed.scheme()
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("External URL must not contain embedded credentials".to_string());
    }
    let Some(host) = parsed.host_str() else {
        return Err("External URL is missing a valid host".to_string());
    };
    if host.is_empty() || host.starts_with('.') {
        return Err("External URL is missing a valid host".to_string());
    }
    Ok(parsed.into())
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    let validated = validate_external_url(&url)?;
    // Run external browser launch off the UI thread so cold COM/Shell activation
    // cannot stall WebView rendering, and pass the URL directly without a shell.
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::{
                System::Com::{
                    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
                    COINIT_DISABLE_OLE1DDE,
                },
                UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
            };
            let operation: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
            let target: Vec<u16> = validated.encode_utf16().chain(std::iter::once(0)).collect();
            // ShellExecuteW delegates URL handling to the user's registered browser
            // (and may invoke COM verb handlers, so initialize STA COM on this worker).
            // explorer.exe treats some URL forms as filesystem paths in WebView contexts.
            let hr = unsafe {
                CoInitializeEx(
                    std::ptr::null(),
                    (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
                )
            };
            let result = unsafe {
                ShellExecuteW(
                    std::ptr::null_mut(),
                    operation.as_ptr(),
                    target.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    SW_SHOWNORMAL,
                )
            };
            if hr == 0 || hr == 1 {
                unsafe {
                    CoUninitialize();
                }
            }
            if result as isize <= 32 {
                return Err(format!(
                    "Failed to open external URL in system browser (ShellExecuteW: {})",
                    result as isize
                ));
            }
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut command = if cfg!(target_os = "macos") {
                let mut command = std::process::Command::new("open");
                command.arg(&validated);
                command
            } else {
                let mut command = std::process::Command::new("xdg-open");
                command.arg(&validated);
                command
            };
            let mut child = command
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|error| {
                    format!("Failed to open external URL in system browser: {error}")
                })?;
            std::thread::Builder::new()
                .name("grapher-open-external-url".to_string())
                .spawn(move || {
                    let _ = child.wait();
                })
                .map_err(|error| format!("Failed to monitor external browser launch: {error}"))?;
            Ok(())
        }
    })
    .await
    .map_err(|error| format!("External URL launcher task failed: {error}"))?
}

const MAX_NOTIFICATION_TITLE_CHARS: usize = 120;
const MAX_NOTIFICATION_BODY_CHARS: usize = 500;

/// Normalizes notification text by turning newlines/tabs into spaces, stripping
/// other control characters, collapsing consecutive whitespace, and bounding
/// character length cleanly with an ellipsis.
pub fn sanitize_notification_text(raw: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let mut cleaned = String::new();
    let mut char_count = 0usize;
    let mut pending_space = false;
    let mut overflowed = false;
    for ch in raw.chars() {
        let mapped = match ch {
            '\r' | '\n' | '\t' => ' ',
            c if c.is_control() => continue,
            c => c,
        };
        if mapped.is_whitespace() {
            if char_count > 0 {
                pending_space = true;
            }
            continue;
        }
        let needed = usize::from(pending_space) + 1;
        if char_count + needed > max_chars {
            overflowed = true;
            break;
        }
        if pending_space {
            cleaned.push(' ');
            char_count += 1;
            pending_space = false;
        }
        cleaned.push(mapped);
        char_count += 1;
    }
    if !overflowed {
        return cleaned;
    }
    let take_len = max_chars.saturating_sub(1);
    let mut truncated: String = cleaned.chars().take(take_len).collect();
    while truncated.ends_with(' ') {
        truncated.pop();
    }
    truncated.push('…');
    truncated
}

#[cfg(target_os = "macos")]
fn fallback_macos_osascript_notification(
    title: &str,
    body: &str,
    sound: bool,
) -> Result<(), String> {
    let script = if sound {
        "display notification (item 2 of argv) with title (item 1 of argv) sound name \"default\""
    } else {
        "display notification (item 2 of argv) with title (item 1 of argv)"
    };
    let mut child = std::process::Command::new("/usr/bin/osascript")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .args(["-e", "on run argv", "-e", script, "-e", "end run", "--", title, body])
        .spawn()
        .map_err(|error| format!("Failed to spawn osascript notification fallback: {error}"))?;
    std::thread::Builder::new()
        .name("grapher-macos-notification-fallback".to_string())
        .spawn(move || {
            let _ = child.wait();
        })
        .map_err(|error| format!("Failed to monitor osascript notification fallback: {error}"))?;
    Ok(())
}

/// Sends a native OS notification only when the main desktop window is NOT
/// currently visible and focused in the foreground. Returns `Ok(true)` if a
/// notification was dispatched and `Ok(false)` when suppressed (focused,
/// permission denied, or empty).
#[tauri::command]
async fn send_desktop_notification(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    title: String,
    body: String,
    run_id: Option<String>,
    sound: Option<bool>,
) -> Result<bool, String> {
    let is_foreground_focused = window.is_focused().unwrap_or(false)
        && window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(false);
    if is_foreground_focused {
        return Ok(false);
    }

    let clean_body = sanitize_notification_text(&body, MAX_NOTIFICATION_BODY_CHARS);
    if clean_body.is_empty() {
        return Ok(false);
    }
    let clean_title = {
        let candidate = sanitize_notification_text(&title, MAX_NOTIFICATION_TITLE_CHARS);
        if candidate.is_empty() {
            "Grapher".to_string()
        } else {
            candidate
        }
    };
    let clean_run_id = run_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let play_sound = sound.unwrap_or(true);

    #[cfg(target_os = "macos")]
    {
        let _ = app;
        match macos_notifications::send_notification(
            &clean_title,
            &clean_body,
            clean_run_id.as_deref(),
            play_sound,
        )
        .await
        {
            macos_notifications::MacosNotificationDelivery::Delivered => Ok(true),
            macos_notifications::MacosNotificationDelivery::PermissionDenied => {
                eprintln!(
                    "[grapher-desktop] macOS notification permission is denied; enable notifications for Grapher in System Settings -> Notifications"
                );
                Ok(false)
            }
            macos_notifications::MacosNotificationDelivery::Unavailable => {
                eprintln!(
                    "[grapher-desktop] UNUserNotificationCenter unavailable (not running inside a .app bundle); using macOS osascript fallback"
                );
                fallback_macos_osascript_notification(&clean_title, &clean_body, play_sound)?;
                Ok(true)
            }
            macos_notifications::MacosNotificationDelivery::Failed(error) => {
                Err(format!("Failed to send macOS desktop notification: {error}"))
            }
        }
    }
    #[cfg(all(desktop, not(target_os = "macos")))]
    {
        use tauri_plugin_notification::NotificationExt;
        let mut builder = app
            .notification()
            .builder()
            .title(&clean_title)
            .body(&clean_body);
        if let Some(ref run_id) = clean_run_id {
            builder = builder.extra("runId", run_id.clone());
        }
        if play_sound {
            #[cfg(target_os = "windows")]
            {
                builder = builder.sound("Default");
            }
            #[cfg(not(target_os = "windows"))]
            {
                builder = builder.sound("message-new-instant");
            }
        }
        builder
            .show()
            .map(|()| true)
            .map_err(|error| format!("Failed to send desktop notification: {error}"))
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, clean_title, clean_body, clean_run_id, play_sound);
        Ok(false)
    }
}

#[tauri::command]
fn take_pending_notification_click(
    state: tauri::State<'_, PendingNotificationClickState>,
) -> Option<NotificationClickEvent> {
    state.take()
}

#[tauri::command]
async fn desktop_notification_permission_status() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos_notifications::permission_status()
            .await
            .as_str()
            .to_string())
    }
    #[cfg(all(desktop, not(target_os = "macos")))]
    {
        Ok("granted".to_string())
    }
    #[cfg(not(desktop))]
    {
        Ok("unsupported".to_string())
    }
}

#[tauri::command]
async fn request_desktop_notification_permission() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos_notifications::request_permission()
            .await
            .as_str()
            .to_string())
    }
    #[cfg(all(desktop, not(target_os = "macos")))]
    {
        Ok("granted".to_string())
    }
    #[cfg(not(desktop))]
    {
        Ok("unsupported".to_string())
    }
}

#[tauri::command]
fn open_desktop_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos_notifications::open_notification_settings()
    }
    #[cfg(target_os = "windows")]
    {
        let mut child = std::process::Command::new("explorer.exe")
            .arg("ms-settings:notifications")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|error| format!("Failed to open Windows notification settings: {error}"))?;
        std::thread::Builder::new()
            .name("grapher-open-notification-settings".to_string())
            .spawn(move || {
                let _ = child.wait();
            })
            .map_err(|error| {
                format!("Failed to monitor Windows notification settings launch: {error}")
            })?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(())
    }
}

#[cfg(desktop)]
#[tauri::command]
async fn terminal_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<terminal::TerminalManager>>,
    workspace_path: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<terminal::TerminalSessionInfo, String> {
    let manager = Arc::clone(state.inner());
    let sink = Arc::new(terminal::TauriTerminalEventSink::new(app));
    tauri::async_runtime::spawn_blocking(move || {
        manager.create_session(sink, &workspace_path, cols, rows)
    })
    .await
    .map_err(|error| format!("Terminal startup task failed: {error}"))?
}

#[cfg(desktop)]
#[tauri::command]
fn terminal_write(
    state: tauri::State<'_, Arc<terminal::TerminalManager>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state.write_session(&session_id, &data)
}

#[cfg(desktop)]
#[tauri::command]
fn terminal_resize(
    state: tauri::State<'_, Arc<terminal::TerminalManager>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize_session(&session_id, cols, rows)
}

#[cfg(desktop)]
#[tauri::command]
fn terminal_kill(
    state: tauri::State<'_, Arc<terminal::TerminalManager>>,
    session_id: String,
) -> Result<(), String> {
    state.kill_session(&session_id);
    Ok(())
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

pub const WINDOWS_AUTOSTART_ARG: &str = "--autostart";

pub fn launched_from_autostart(args: &[String]) -> bool {
    args.iter().skip(1).any(|arg| arg == WINDOWS_AUTOSTART_ARG)
}

pub fn tray_labels_for_windows_lang_id(lang_id: u16) -> (&'static str, &'static str) {
    // Primary language ID sits in the low 10 bits; 0x04 is LANG_CHINESE.
    if (lang_id & 0x03ff) == 0x0004 {
        ("显示 Grapher", "退出 Grapher")
    } else {
        ("Show Grapher", "Quit Grapher")
    }
}

#[cfg(desktop)]
fn build_autostart_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    #[cfg(target_os = "windows")]
    let args: Option<Vec<&'static str>> = Some(vec![WINDOWS_AUTOSTART_ARG]);
    #[cfg(not(target_os = "windows"))]
    let args: Option<Vec<&'static str>> = None;
    tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, args)
}

#[derive(Default)]
pub struct WindowsTrayState {
    tray_available: AtomicBool,
    hidden_to_tray: AtomicBool,
    quitting: AtomicBool,
}

impl WindowsTrayState {
    pub fn set_tray_available(&self, available: bool) {
        self.tray_available.store(available, Ordering::Release);
    }

    pub fn should_hide_on_close(&self) -> bool {
        self.tray_available.load(Ordering::Acquire) && !self.quitting.load(Ordering::Acquire)
    }

    pub fn mark_hidden_to_tray(&self) {
        self.hidden_to_tray.store(true, Ordering::Release);
    }

    pub fn mark_restored(&self) {
        self.hidden_to_tray.store(false, Ordering::Release);
    }

    pub fn is_hidden_to_tray(&self) -> bool {
        self.hidden_to_tray.load(Ordering::Acquire)
    }

    pub fn mark_quitting(&self) {
        self.quitting.store(true, Ordering::Release);
        self.hidden_to_tray.store(false, Ordering::Release);
    }
}

#[cfg(target_os = "windows")]
const WINDOWS_TRAY_ID: &str = "grapher-tray";
#[cfg(target_os = "windows")]
const WINDOWS_TRAY_SHOW_ID: &str = "tray-show";
#[cfg(target_os = "windows")]
const WINDOWS_TRAY_QUIT_ID: &str = "tray-quit";

#[cfg(target_os = "macos")]
fn handle_macos_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    if window.label() != "main" {
        return;
    }
    api.prevent_close();
    // On macOS, calling `window.hide()` while in native fullscreen can leave an
    // empty fullscreen Space; hiding the app switches Spaces cleanly.
    if window.is_fullscreen().unwrap_or(false) {
        let _ = window.app_handle().hide();
    } else {
        let _ = window.hide();
    }
}

#[cfg(target_os = "windows")]
fn set_windows_webview_hidden_state(window: &tauri::WebviewWindow, hidden: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;

    let visible = !hidden;
    if let Err(error) = window.with_webview(move |webview| unsafe {
        let controller = webview.controller();
        if let Err(err) = controller.SetIsVisible(visible) {
            eprintln!(
                "[grapher-desktop] Warning: failed to set WebView2 visibility to {visible}: {err}"
            );
        }
        // Lower WebView2's V8/Blink memory target when hidden in the tray without
        // calling `TrySuspend()`, so background completion notifications keep running.
        if let Ok(core) = controller.CoreWebView2() {
            if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                let level = if hidden {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                };
                if let Err(err) = core19.SetMemoryUsageTargetLevel(level) {
                    eprintln!(
                        "[grapher-desktop] Warning: failed to set WebView2 memory target level (hidden={hidden}): {err}"
                    );
                }
            }
        }
    }) {
        eprintln!(
            "[grapher-desktop] Warning: failed to access WebView2 controller for hidden={hidden}: {error}"
        );
    }
}

#[cfg(target_os = "windows")]
fn mark_windows_webview_start_hidden(window: &tauri::WebviewWindow) {
    use windows_core::w;

    let _ = window.with_webview(|webview| unsafe {
        if let Ok(core) = webview.controller().CoreWebView2() {
            let _ = core.AddScriptToExecuteOnDocumentCreated(
                w!("window.__GRAPHER_START_HIDDEN__ = true;"),
                None,
            );
        }
    });
    let _ = window.eval("window.__GRAPHER_START_HIDDEN__ = true;");
    set_windows_webview_hidden_state(window, true);
    let _ = window.hide();
}

#[cfg(target_os = "windows")]
fn handle_windows_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    if window.label() != "main" {
        return;
    }
    let app_handle = window.app_handle();
    let should_hide = app_handle
        .try_state::<WindowsTrayState>()
        .map(|state| state.should_hide_on_close())
        .unwrap_or(false);
    if !should_hide {
        return;
    }
    api.prevent_close();
    if let Some(state) = app_handle.try_state::<WindowsTrayState>() {
        state.mark_hidden_to_tray();
    }
    // Tauri's `Window::hide()` only hides the outer Win32 HWND (`ShowWindow(SW_HIDE)`),
    // which does NOT set WebView2's `ICoreWebView2Controller::IsVisible` to `FALSE`.
    // Explicitly setting `IsVisible(false)` + low memory target triggers
    // `document.hidden = true` + `visibilitychange` (closing SSE, suspending
    // polling/rAF/timers/CSS animations) and stops WebView2 GPU compositing,
    // matching macOS hidden-window optimization.
    if let Some(webview_window) = app_handle.get_webview_window("main") {
        set_windows_webview_hidden_state(&webview_window, true);
    }
    let _ = window.hide();
}

#[cfg(target_os = "windows")]
fn quit_windows_app(app_handle: &tauri::AppHandle) {
    if let Some(tray_state) = app_handle.try_state::<WindowsTrayState>() {
        tray_state.mark_quitting();
    }
    let _ = app_handle.remove_tray_by_id(WINDOWS_TRAY_ID);
    if let Some(state) = app_handle.try_state::<BackendState>() {
        state.shutdown();
    }
    app_handle.exit(0);
}

#[cfg(target_os = "windows")]
fn setup_windows_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{MenuBuilder, MenuItemBuilder},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let lang_id = unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() };
    let (show_label, quit_label) = tray_labels_for_windows_lang_id(lang_id);
    let show_item = MenuItemBuilder::with_id(WINDOWS_TRAY_SHOW_ID, show_label).build(app)?;
    let quit_item = MenuItemBuilder::with_id(WINDOWS_TRAY_QUIT_ID, quit_label).build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let mut builder = TrayIconBuilder::with_id(WINDOWS_TRAY_ID)
        .tooltip("Grapher")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            WINDOWS_TRAY_SHOW_ID => show_main_window(app_handle),
            WINDOWS_TRAY_QUIT_ID => quit_windows_app(app_handle),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                show_main_window(tray.app_handle());
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

#[cfg(desktop)]
pub(crate) fn show_main_window(app_handle: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app_handle.show();
    #[cfg(target_os = "windows")]
    if let Some(state) = app_handle.try_state::<WindowsTrayState>() {
        state.mark_restored();
    }
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        #[cfg(target_os = "windows")]
        set_windows_webview_hidden_state(&window, false);
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
pub(crate) fn handle_desktop_notification_clicked(
    app_handle: &tauri::AppHandle,
    run_id: Option<String>,
) {
    show_main_window(app_handle);
    let Some(clean_run_id) = run_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
    else {
        return;
    };
    let payload = if let Some(pending) = app_handle.try_state::<PendingNotificationClickState>() {
        pending.record(clean_run_id)
    } else {
        NotificationClickEvent {
            run_id: clean_run_id,
            seq: 1,
        }
    };
    let _ = app_handle.emit_to("main", DESKTOP_NOTIFICATION_CLICKED_EVENT, payload);
}

#[cfg(target_os = "windows")]
fn schedule_windows_startup_reveal(app_handle: &tauri::AppHandle) {
    let fallback_handle = app_handle.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("grapher-startup-window".to_string())
        .spawn(move || {
            // The frontend normally shows the window after mounting its shell.
            // A failed JS import/IPC must not leave an invisible running app.
            std::thread::sleep(std::time::Duration::from_secs(5));
            let Some(window) = fallback_handle.get_webview_window("main") else {
                return;
            };
            // Never restore a window the user has already minimized or hidden to the tray.
            // Failed state queries also leave its current visibility untouched.
            let hidden_to_tray = fallback_handle
                .try_state::<WindowsTrayState>()
                .map(|state| state.is_hidden_to_tray())
                .unwrap_or(false);
            if !hidden_to_tray
                && matches!(window.is_visible(), Ok(false))
                && matches!(window.is_minimized(), Ok(false))
            {
                eprintln!("[grapher-desktop] Frontend window reveal timed out; showing the main window");
                set_windows_webview_hidden_state(&window, false);
                if let Err(error) = window.show() {
                    eprintln!("[grapher-desktop] Failed to show the main window: {error}");
                }
            }
        })
    {
        eprintln!("[grapher-desktop] Failed to start window reveal watchdog: {error}");
        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.show();
        }
    }
}

#[cfg(target_os = "windows")]
fn set_windows_corner_preference<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use std::{ffi::c_void, mem::size_of_val};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };

    let Ok(hwnd) = window.hwnd() else {
        eprintln!("[grapher-desktop] Warning: failed to get the Windows window handle for rounded corners");
        return;
    };
    let preference = DWMWCP_ROUND;
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            (&preference as *const i32).cast::<c_void>(),
            size_of_val(&preference) as u32,
        )
    };
    if result != 0 {
        // Windows 10 and older Windows 11 builds may not support this DWM
        // attribute. The app remains usable with the platform default corners.
        eprintln!(
            "[grapher-desktop] Warning: failed to set rounded Windows window corners (HRESULT 0x{result:08X})"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // macOS natively enforces single-instance for `.app` bundles via `RunEvent::Reopen`
    // and uses `tauri-plugin-process::relaunch()` after in-app updates, so only Windows
    // registers `tauri-plugin-single-instance` (waking a tray-hidden instance on relaunch).
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        show_main_window(app);
    }));
    let app = builder
        .plugin(tauri_plugin_process::init())
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                #[cfg(desktop)]
                if let Some(terminals) =
                    webview.app_handle().try_state::<Arc<terminal::TerminalManager>>()
                {
                    terminals.kill_all();
                }
            }
        })
        .on_window_event(|_window, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                handle_macos_close_requested(_window, api);
            }
            #[cfg(target_os = "windows")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                handle_windows_close_requested(_window, api);
            }
        })
        .setup(|app| {
            app.manage(WindowsTrayState::default());
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    set_windows_corner_preference(&window);
                }
                let start_hidden = launched_from_autostart(&std::env::args().collect::<Vec<_>>());
                match setup_windows_tray(app) {
                    Ok(()) => {
                        if let Some(tray_state) = app.try_state::<WindowsTrayState>() {
                            tray_state.set_tray_available(true);
                            if start_hidden {
                                tray_state.mark_hidden_to_tray();
                                if let Some(window) = app.get_webview_window("main") {
                                    mark_windows_webview_start_hidden(&window);
                                }
                            }
                        }
                    }
                    Err(error) => {
                        eprintln!(
                            "[grapher-desktop] Warning: failed to register Windows system tray icon (close will exit normally): {error}"
                        );
                    }
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

                #[cfg(target_os = "macos")]
                {
                    // Use native UNUserNotificationCenter on macOS so the OS
                    // registers Grapher in System Settings -> Notifications and
                    // prompts for permission immediately on first launch.
                    macos_notifications::init_and_request_permission_on_startup(app.handle());
                }

                #[cfg(not(target_os = "macos"))]
                match app.handle().plugin(tauri_plugin_notification::init()) {
                    Ok(()) => {
                        use tauri_plugin_notification::NotificationExt;
                        let click_handle = app.handle().clone();
                        let _ = app.notification().on_action(move |performed| {
                            if performed.action_id() != "tap" {
                                return;
                            }
                            let run_id = performed
                                .notification()
                                .and_then(|n| n.extra().get("runId"))
                                .and_then(|value| value.as_str())
                                .map(str::to_owned);
                            handle_desktop_notification_clicked(&click_handle, run_id);
                        });
                    }
                    Err(error) => {
                        eprintln!(
                            "[grapher-desktop] Warning: failed to register notification plugin (continuing startup): {error}"
                        );
                    }
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
            #[cfg(desktop)]
            {
                let terminal_manager = Arc::new(terminal::TerminalManager::new());
                app.resources_table()
                    .add(TerminalShutdownGuard(Arc::clone(&terminal_manager)));
                app.manage(terminal_manager);
            }
            app.manage(state);
            app.manage(git_bootstrap);
            app.manage(PendingNotificationClickState::default());
            #[cfg(target_os = "windows")]
            schedule_windows_startup_reveal(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_url,
            git_bootstrap_status,
            retry_git_bootstrap,
            open_external_url,
            send_desktop_notification,
            desktop_notification_permission_status,
            request_desktop_notification_permission,
            open_desktop_notification_settings,
            take_pending_notification_click,
            terminal_create,
            terminal_write,
            terminal_resize,
            terminal_kill
        ])
        .build(tauri::generate_context!())
        .expect("error while building Grapher desktop application");

    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                show_main_window(app_handle);
            }
        }
        RunEvent::Exit => {
            #[cfg(desktop)]
            if let Some(terminals) = app_handle.try_state::<Arc<terminal::TerminalManager>>() {
                terminals.kill_all();
            }
            if let Some(state) = app_handle.try_state::<BackendState>() {
                state.shutdown();
            }
        }
        _ => {}
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

    #[test]
    fn url_origin_handles_deeply_nested_blob_urls_without_recursing() {
        // RUSTSEC-2026-0592: url <= 2.5.8 exhausted a worker's stack here.
        let input = format!("{}https://example.com/", "blob:".repeat(10_000));
        let parsed = tauri::Url::parse(&input).unwrap();
        assert_eq!(parsed.origin().ascii_serialization(), "null");
    }

    #[test]
    fn validate_external_url_allows_only_clean_http_and_https_urls() {
        assert_eq!(
            validate_external_url(" https://github.com/zhexusun10/grapher/releases ").unwrap(),
            "https://github.com/zhexusun10/grapher/releases"
        );
        assert_eq!(
            validate_external_url("HTTP://example.com/auth?a=1&b=2#top").unwrap(),
            "http://example.com/auth?a=1&b=2#top"
        );
        for rejected in [
            "",
            "   ",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,<h1>x</h1>",
            "mailto:test@example.com",
            "https://",
            "https:///path",
            "https://:80/path",
            "https://user@:80/path",
            "https://user@.example.com/path",
            "https://example.com\\path",
            "https://[invalid/path",
            "https://example.com/a\nb",
            "https://example.com/a b",
            &format!("https://example.com/{}", "a".repeat(MAX_EXTERNAL_URL_BYTES)),
        ] {
            assert!(
                validate_external_url(rejected).is_err(),
                "expected rejection for {rejected:?}"
            );
        }
    }

    #[test]
    fn pending_notification_click_state_tracks_monotonic_seq_and_takes_once() {
        let state = PendingNotificationClickState::default();
        assert_eq!(state.take(), None);

        let first = state.record("run-1".to_string());
        assert_eq!(
            first,
            NotificationClickEvent {
                run_id: "run-1".to_string(),
                seq: 1,
            }
        );
        let second = state.record("run-2".to_string());
        assert_eq!(
            second,
            NotificationClickEvent {
                run_id: "run-2".to_string(),
                seq: 2,
            }
        );
        assert_eq!(state.take(), Some(second));
        assert_eq!(state.take(), None);
    }

    #[test]
    fn sanitize_notification_text_normalizes_whitespace_strips_controls_and_truncates() {
        assert_eq!(sanitize_notification_text("   \r\n\t  ", 50), "");
        assert_eq!(
            sanitize_notification_text("  Hello\n\nworld\t\u{0007}from\rGrapher  ", 50),
            "Hello world from Grapher"
        );
        assert_eq!(
            sanitize_notification_text("你好世界，这是一条很长的通知内容", 6),
            "你好世界，…"
        );
        assert_eq!(sanitize_notification_text("exact", 5), "exact");
        assert_eq!(sanitize_notification_text("exact   ", 5), "exact");
        assert_eq!(sanitize_notification_text("hello world", 7), "hello…");
        assert_eq!(sanitize_notification_text("hello world", 6), "hello…");
        assert_eq!(sanitize_notification_text("a b", 1), "…");
    }

    #[test]
    fn windows_tray_state_controls_close_to_tray_and_quit_lifecycle() {
        let state = WindowsTrayState::default();
        // Without an active tray icon, closing must not trap the window.
        assert!(!state.should_hide_on_close());
        assert!(!state.is_hidden_to_tray());

        // Once the tray icon is registered, closing hides to tray.
        state.set_tray_available(true);
        assert!(state.should_hide_on_close());
        state.mark_hidden_to_tray();
        assert!(state.is_hidden_to_tray());

        // Restoring clears hidden-to-tray while keeping close-to-tray active.
        state.mark_restored();
        assert!(!state.is_hidden_to_tray());
        assert!(state.should_hide_on_close());

        // Explicit quit from the tray disables close-to-tray interception.
        state.mark_hidden_to_tray();
        state.mark_quitting();
        assert!(!state.is_hidden_to_tray());
        assert!(!state.should_hide_on_close());
    }

    #[test]
    fn launched_from_autostart_detects_flag_only_in_arguments() {
        assert!(!launched_from_autostart(&[]));
        assert!(!launched_from_autostart(&["--autostart".to_string()]));
        assert!(!launched_from_autostart(&[
            "grapher.exe".to_string(),
            "--other".to_string()
        ]));
        assert!(launched_from_autostart(&[
            "grapher.exe".to_string(),
            "--autostart".to_string()
        ]));
    }

    #[test]
    fn tray_labels_follow_windows_primary_language() {
        // Simplified Chinese (0x0804) & Traditional Chinese (0x0404)
        assert_eq!(
            tray_labels_for_windows_lang_id(0x0804),
            ("显示 Grapher", "退出 Grapher")
        );
        assert_eq!(
            tray_labels_for_windows_lang_id(0x0404),
            ("显示 Grapher", "退出 Grapher")
        );
        // English US (0x0409) & Japanese (0x0411)
        assert_eq!(
            tray_labels_for_windows_lang_id(0x0409),
            ("Show Grapher", "Quit Grapher")
        );
        assert_eq!(
            tray_labels_for_windows_lang_id(0x0411),
            ("Show Grapher", "Quit Grapher")
        );
    }
}
