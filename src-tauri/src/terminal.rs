//! Workspace-scoped native PTY terminal sessions for the Grapher desktop shell.
//!
//! Runs native interactive shells via `portable-pty` (POSIX PTY on macOS/Unix,
//! ConPTY on Windows), streams raw base64-encoded terminal output over Tauri
//! events, supports live resizing, and terminates child processes cleanly on
//! explicit close or application exit.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

pub const DESKTOP_TERMINAL_OUTPUT_EVENT: &str = "grapher://terminal-output";
pub const DESKTOP_TERMINAL_EXIT_EVENT: &str = "grapher://terminal-exit";

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
const MIN_COLS: u16 = 20;
const MAX_COLS: u16 = 500;
const MIN_ROWS: u16 = 5;
const MAX_ROWS: u16 = 200;
const READ_CHUNK_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub session_id: String,
    pub shell: String,
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub session_id: String,
    /// Standard base64-encoded raw bytes from the PTY so multi-byte UTF-8 and
    /// ANSI control sequences are never split or corrupted in transit.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub session_id: String,
    pub exit_code: Option<i32>,
}

pub trait TerminalEventSink: Send + Sync + 'static {
    fn emit_output(&self, event: TerminalOutputEvent);
    fn emit_exit(&self, event: TerminalExitEvent);
}

#[derive(Clone)]
pub struct TauriTerminalEventSink {
    app_handle: tauri::AppHandle,
}

impl TauriTerminalEventSink {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self { app_handle }
    }
}

impl TerminalEventSink for TauriTerminalEventSink {
    fn emit_output(&self, event: TerminalOutputEvent) {
        use tauri::Emitter;
        let _ = self
            .app_handle
            .emit_to("main", DESKTOP_TERMINAL_OUTPUT_EVENT, event);
    }

    fn emit_exit(&self, event: TerminalExitEvent) {
        use tauri::Emitter;
        let _ = self
            .app_handle
            .emit_to("main", DESKTOP_TERMINAL_EXIT_EVENT, event);
    }
}

struct TerminalSession {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    child_pid: Option<u32>,
    killed: AtomicBool,
}

impl TerminalSession {
    fn write_bytes(&self, bytes: &[u8]) -> Result<(), String> {
        let mut guard = self
            .writer
            .lock()
            .map_err(|_| "Terminal writer lock poisoned".to_string())?;
        let Some(writer) = guard.as_mut() else {
            return Err("Terminal session is closed".to_string());
        };
        writer
            .write_all(bytes)
            .and_then(|()| writer.flush())
            .map_err(|error| format!("Failed to write to terminal: {error}"))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let size = clamped_pty_size(Some(cols), Some(rows));
        let guard = self
            .master
            .lock()
            .map_err(|_| "Terminal master lock poisoned".to_string())?;
        let Some(master) = guard.as_ref() else {
            return Ok(());
        };
        master
            .resize(size)
            .map_err(|error| format!("Failed to resize terminal: {error}"))
    }

    fn kill(&self) {
        if self.killed.swap(true, Ordering::AcqRel) {
            return;
        }
        #[cfg(unix)]
        {
            // Terminate the entire foreground/session process group first so
            // nested dev servers or commands started inside the shell exit too.
            if let Ok(guard) = self.master.lock() {
                if let Some(master) = guard.as_ref() {
                    if let Some(pgid) = master.process_group_leader() {
                        if pgid > 0 {
                            unsafe {
                                libc::kill(-pgid, libc::SIGHUP);
                                libc::kill(-pgid, libc::SIGTERM);
                            }
                        }
                    }
                }
            }
            if let Some(pid) = self.child_pid {
                if let Ok(pid_i32) = i32::try_from(pid) {
                    if pid_i32 > 0 {
                        unsafe {
                            libc::kill(-pid_i32, libc::SIGHUP);
                            libc::kill(-pid_i32, libc::SIGTERM);
                        }
                    }
                }
            }
        }
        #[cfg(not(unix))]
        let _ = self.child_pid;

        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
        // Drop writer & master PTY handles so the reader thread unblocks and
        // ConPTY / POSIX PTY descriptors are released immediately.
        if let Ok(mut writer) = self.writer.lock() {
            writer.take();
        }
        if let Ok(mut master) = self.master.lock() {
            master.take();
        }
    }
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_session<S: TerminalEventSink>(
        &self,
        sink: Arc<S>,
        workspace_path: &str,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<TerminalSessionInfo, String> {
        let cwd = validate_workspace_dir(workspace_path)?;
        let size = clamped_pty_size(cols, rows);
        let (shell_program, shell_args, shell_label) = resolve_default_shell();

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|error| format!("Failed to open PTY: {error}"))?;

        let mut cmd = CommandBuilder::new(&shell_program);
        for arg in &shell_args {
            cmd.arg(arg);
        }
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("GRAPHER_TERMINAL", "1");
        #[cfg(unix)]
        if std::env::var_os("LANG").is_none() {
            cmd.env("LANG", "en_US.UTF-8");
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|error| format!("Failed to spawn shell `{shell_program}`: {error}"))?;
        // Release the slave fd in the parent immediately so master reads hit
        // EOF as soon as the shell exits.
        drop(pair.slave);

        let child_pid = child.process_id();
        let killer = child.clone_killer();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("Failed to clone PTY reader: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("Failed to acquire PTY writer: {error}"))?;

        let session_id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(TerminalSession {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(killer),
            child_pid,
            killed: AtomicBool::new(false),
        });

        {
            let mut map = self
                .sessions
                .lock()
                .map_err(|_| "Terminal session registry lock poisoned".to_string())?;
            map.insert(session_id.clone(), Arc::clone(&session));
        }

        let sessions_ref = Arc::clone(&self.sessions);
        let session_ref = Arc::clone(&session);
        let output_session_id = session_id.clone();
        let output_sink = Arc::clone(&sink);
        let reader_thread = std::thread::Builder::new()
            .name(format!("grapher-pty-read-{}", &session_id[..8]))
            .spawn(move || {
                let mut buf = [0u8; READ_CHUNK_BYTES];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if session_ref.killed.load(Ordering::Acquire) {
                                break;
                            }
                            output_sink.emit_output(TerminalOutputEvent {
                                session_id: output_session_id.clone(),
                                data: encode_base64_std(&buf[..n]),
                            });
                        }
                        Err(error) => {
                            if error.kind() == std::io::ErrorKind::Interrupted {
                                continue;
                            }
                            break;
                        }
                    }
                }
            });

        if let Err(error) = reader_thread {
            self.kill_session(&session_id);
            return Err(format!("Failed to start PTY reader thread: {error}"));
        }

        let wait_session_id = session_id.clone();
        let wait_session_ref = Arc::clone(&session);
        let wait_sink = sink;
        let waiter_thread = std::thread::Builder::new()
            .name(format!("grapher-pty-wait-{}", &session_id[..8]))
            .spawn(move || {
                let exit_code = match child.wait() {
                    Ok(status) => Some(status.exit_code() as i32),
                    Err(_) => None,
                };
                if let Ok(mut map) = sessions_ref.lock() {
                    map.remove(&wait_session_id);
                }
                let was_killed = wait_session_ref.killed.load(Ordering::Acquire);
                if !was_killed {
                    wait_sink.emit_exit(TerminalExitEvent {
                        session_id: wait_session_id,
                        exit_code,
                    });
                }
            });

        if let Err(error) = waiter_thread {
            self.kill_session(&session_id);
            return Err(format!("Failed to start PTY waiter thread: {error}"));
        }

        Ok(TerminalSessionInfo {
            session_id,
            shell: shell_label,
            cwd: cwd.to_string_lossy().to_string(),
        })
    }

    pub fn write_session(&self, session_id: &str, data: &str) -> Result<(), String> {
        let session = self.get_session(session_id)?;
        session.write_bytes(data.as_bytes())
    }

    pub fn resize_session(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.get_session(session_id)?;
        session.resize(cols, rows)
    }

    pub fn kill_session(&self, session_id: &str) {
        let removed = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut map| map.remove(session_id));
        if let Some(session) = removed {
            session.kill();
        }
    }

    pub fn kill_all(&self) {
        let all: Vec<Arc<TerminalSession>> = self
            .sessions
            .lock()
            .ok()
            .map(|mut map| map.drain().map(|(_, session)| session).collect())
            .unwrap_or_default();
        for session in all {
            session.kill();
        }
    }

    pub fn active_count(&self) -> usize {
        self.sessions.lock().map(|map| map.len()).unwrap_or(0)
    }

    fn get_session(&self, session_id: &str) -> Result<Arc<TerminalSession>, String> {
        let map = self
            .sessions
            .lock()
            .map_err(|_| "Terminal session registry lock poisoned".to_string())?;
        map.get(session_id)
            .cloned()
            .ok_or_else(|| "Terminal session not found".to_string())
    }
}

pub fn clamped_pty_size(cols: Option<u16>, rows: Option<u16>) -> PtySize {
    let cols = cols.unwrap_or(DEFAULT_COLS).clamp(MIN_COLS, MAX_COLS);
    let rows = rows.unwrap_or(DEFAULT_ROWS).clamp(MIN_ROWS, MAX_ROWS);
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

pub fn validate_workspace_dir(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Workspace path is empty".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.exists() {
        return Err(format!("Workspace directory does not exist: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("Workspace path is not a directory: {}", path.display()));
    }
    Ok(path)
}

#[cfg(target_os = "windows")]
fn find_executable_in_path(candidate: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let full = dir.join(candidate);
        if full.is_file() {
            return Some(full);
        }
    }
    None
}

pub fn resolve_default_shell() -> (String, Vec<String>, String) {
    #[cfg(target_os = "windows")]
    {
        if let Some(pwsh) = find_executable_in_path("pwsh.exe") {
            return (
                pwsh.to_string_lossy().to_string(),
                vec!["-NoLogo".to_string()],
                "pwsh".to_string(),
            );
        }
        if let Some(powershell) = find_executable_in_path("powershell.exe") {
            return (
                powershell.to_string_lossy().to_string(),
                vec!["-NoLogo".to_string()],
                "PowerShell".to_string(),
            );
        }
        let comspec = std::env::var("COMSPEC")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "cmd.exe".to_string());
        return (comspec, Vec::new(), "cmd".to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let candidates = [
            std::env::var("SHELL").ok(),
            Some("/bin/zsh".to_string()),
            Some("/bin/bash".to_string()),
            Some("/bin/sh".to_string()),
        ];
        let program = candidates
            .into_iter()
            .flatten()
            .map(|value| value.trim().to_string())
            .find(|value| !value.is_empty() && Path::new(value).is_file())
            .unwrap_or_else(|| "/bin/sh".to_string());
        let label = Path::new(&program)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("sh")
            .to_string();
        let args = if matches!(label.as_str(), "zsh" | "bash" | "fish") {
            vec!["-l".to_string()]
        } else {
            Vec::new()
        };
        (program, args, label)
    }
}

pub fn encode_base64_std(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct TestSink {
        outputs: Mutex<Vec<TerminalOutputEvent>>,
        exits: Mutex<Vec<TerminalExitEvent>>,
    }

    impl TerminalEventSink for TestSink {
        fn emit_output(&self, event: TerminalOutputEvent) {
            if let Ok(mut guard) = self.outputs.lock() {
                guard.push(event);
            }
        }

        fn emit_exit(&self, event: TerminalExitEvent) {
            if let Ok(mut guard) = self.exits.lock() {
                guard.push(event);
            }
        }
    }

    fn decode_base64_for_test(input: &str) -> Vec<u8> {
        crate::decode_base64_std(input).expect("valid base64")
    }

    #[test]
    fn encode_base64_round_trips_binary_and_utf8() {
        assert_eq!(encode_base64_std(b""), "");
        assert_eq!(encode_base64_std(b"f"), "Zg==");
        assert_eq!(encode_base64_std(b"fo"), "Zm8=");
        assert_eq!(encode_base64_std(b"foo"), "Zm9v");
        let sample = "终端输出\x1b[32mOK\x1b[0m\r\n".as_bytes();
        assert_eq!(decode_base64_for_test(&encode_base64_std(sample)), sample);
    }

    #[test]
    fn clamped_pty_size_bounds_extreme_dimensions() {
        assert_eq!(
            clamped_pty_size(None, None),
            PtySize {
                cols: DEFAULT_COLS,
                rows: DEFAULT_ROWS,
                pixel_width: 0,
                pixel_height: 0
            }
        );
        assert_eq!(
            clamped_pty_size(Some(1), Some(999)),
            PtySize {
                cols: MIN_COLS,
                rows: MAX_ROWS,
                pixel_width: 0,
                pixel_height: 0
            }
        );
    }

    #[test]
    fn validate_workspace_dir_rejects_empty_missing_and_files() {
        let temp = tempfile::tempdir().unwrap();
        let file_path = temp.path().join("file.txt");
        std::fs::write(&file_path, "hi").unwrap();

        assert!(validate_workspace_dir("   ").is_err());
        assert!(validate_workspace_dir(&temp.path().join("nope").to_string_lossy()).is_err());
        assert!(validate_workspace_dir(&file_path.to_string_lossy()).is_err());
        assert_eq!(
            validate_workspace_dir(&temp.path().to_string_lossy()).unwrap(),
            temp.path()
        );
    }

    #[test]
    fn pty_session_spawns_writes_resizes_and_kills_cleanly() {
        let temp = tempfile::tempdir().unwrap();
        let manager = TerminalManager::new();
        let sink = Arc::new(TestSink::default());

        let info = manager
            .create_session(
                Arc::clone(&sink),
                &temp.path().to_string_lossy(),
                Some(90),
                Some(28),
            )
            .expect("spawn PTY");
        assert!(!info.session_id.is_empty());
        assert!(!info.shell.is_empty());
        assert_eq!(manager.active_count(), 1);

        manager
            .resize_session(&info.session_id, 110, 32)
            .expect("resize PTY");
        manager
            .write_session(&info.session_id, "echo GRAPHER_PTY_PROBE\r")
            .expect("write command");

        let deadline = Instant::now() + Duration::from_secs(8);
        let mut saw_marker = false;
        while Instant::now() < deadline {
            let combined: Vec<u8> = sink
                .outputs
                .lock()
                .unwrap()
                .iter()
                .filter(|event| event.session_id == info.session_id)
                .flat_map(|event| decode_base64_for_test(&event.data))
                .collect();
            if String::from_utf8_lossy(&combined).contains("GRAPHER_PTY_PROBE") {
                saw_marker = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(saw_marker, "expected PTY output to echo marker");

        manager.kill_session(&info.session_id);
        assert_eq!(manager.active_count(), 0);
        // Second kill is idempotent.
        manager.kill_session(&info.session_id);
        assert!(manager.write_session(&info.session_id, "hi\r").is_err());
    }
}
