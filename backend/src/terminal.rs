//! Shared native PTY terminal sessions for the HTTP backend and desktop shell.
//!
//! Runs native interactive shells via `portable-pty` (POSIX PTY on macOS/Unix,
//! ConPTY on Windows), streams raw base64-encoded terminal output through an event sink, supports live resizing, and terminates child processes cleanly on
//! explicit close or application exit.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, SyncSender, TrySendError},
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
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_TERMINAL_SESSIONS: usize = 32;

fn is_internal_control_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.starts_with("GRAPHER_")
        || matches!(
            upper.as_str(),
            "PI_SESSION_FILE"
                | "PI_SESSION_ID"
                | "PI_CODING_AGENT_DIR"
                | "PI_CODING_AGENT"
                | "PI_MODEL"
                | "PI_PROVIDER"
                | "PI_REASONING_LEVEL"
                | "PI_THINKING"
        )
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub session_id: String,
    pub shell: String,
    pub cwd: String,
    pub pty_backend: &'static str,
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

struct TerminalSession {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<SyncSender<Vec<u8>>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    child_pid: Option<u32>,
    killed: Arc<AtomicBool>,
    child_exited: Arc<AtomicBool>,
}

impl TerminalSession {
    fn write_bytes(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > MAX_INPUT_BYTES {
            return Err("Terminal input is too large".into());
        }
        let guard = self
            .writer
            .lock()
            .map_err(|_| "Terminal writer lock poisoned".to_string())?;
        let Some(writer) = guard.as_ref() else {
            return Err("Terminal session is closed".to_string());
        };
        writer
            .try_send(bytes.to_vec())
            .map_err(|error| match error {
                TrySendError::Full(_) => {
                    "Terminal input queue is full; wait for the shell to read input".into()
                }
                TrySendError::Disconnected(_) => "Terminal session is closed".into(),
            })
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
        if !self.child_exited.load(Ordering::Acquire) {
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
                        if pid_i32 > 0 && !self.child_exited.load(Ordering::Acquire) {
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

            if !self.child_exited.load(Ordering::Acquire) {
                if let Ok(mut killer) = self.killer.lock() {
                    let _ = killer.kill();
                }
            }
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
        if self.active_count() >= MAX_TERMINAL_SESSIONS {
            return Err("Too many open terminals; close an existing terminal first".into());
        }
        let cwd = validate_workspace_dir(workspace_path)?;
        let size = clamped_pty_size(cols, rows);
        let (shell_program, shell_args, shell_label) = resolve_default_shell();

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|error| format!("Failed to open PTY: {error}"))?;

        #[cfg(unix)]
        let poll_fd = {
            let fd = pair
                .master
                .as_raw_fd()
                .ok_or("PTY has no pollable descriptor")?;
            let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
            if duplicate < 0 {
                return Err(format!(
                    "Failed to clone PTY poll descriptor: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let duplicate = unsafe { OwnedFd::from_raw_fd(duplicate) };
            // The cloned master descriptors share status flags. Nonblocking
            // I/O lets the writer abandon backpressure when the shell exits,
            // even if a disowned descendant retains an unused slave handle.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
            {
                return Err(format!(
                    "Failed to configure PTY I/O: {}",
                    std::io::Error::last_os_error()
                ));
            }
            duplicate
        };
        // Acquire all fallible I/O handles before spawning, so descriptor
        // exhaustion cannot leave an unregistered shell running.
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("Failed to clone PTY reader: {error}"))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("Failed to acquire PTY writer: {error}"))?;

        let mut cmd = CommandBuilder::new(&shell_program);
        for arg in &shell_args {
            cmd.arg(arg);
        }
        for (key, _) in std::env::vars_os() {
            if is_internal_control_env_key(&key.to_string_lossy()) {
                cmd.env_remove(&key);
            }
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
        // PTY writes can block indefinitely when a child stops reading. Never
        // block the HTTP worker or the desktop UI thread on that backpressure.
        let (input_tx, input_rx) = sync_channel::<Vec<u8>>(8);
        let killed = Arc::new(AtomicBool::new(false));
        let child_exited = Arc::new(AtomicBool::new(false));
        let writer_killed = Arc::clone(&killed);
        let writer_exited = Arc::clone(&child_exited);
        if let Err(error) = std::thread::Builder::new()
            .name("grapher-pty-write".into())
            .spawn(move || {
                while let Ok(bytes) = input_rx.recv() {
                    let mut offset = 0;
                    while offset < bytes.len() {
                        if writer_killed.load(Ordering::Acquire)
                            || writer_exited.load(Ordering::Acquire)
                        {
                            return;
                        }
                        match writer.write(&bytes[offset..]) {
                            Ok(0) => return,
                            Ok(n) => offset += n,
                            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                                continue
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                std::thread::sleep(std::time::Duration::from_millis(5));
                            }
                            Err(_) => return,
                        }
                    }
                    if writer.flush().is_err() {
                        return;
                    }
                }
            })
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Failed to start PTY writer thread: {error}"));
        }

        let session_id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(TerminalSession {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(input_tx)),
            killer: Mutex::new(killer),
            child_pid,
            killed,
            child_exited,
        });

        {
            let mut map = match self.sessions.lock() {
                Ok(map) => map,
                Err(_) => {
                    session.kill();
                    let _ = child.wait();
                    return Err("Terminal session registry lock poisoned".to_string());
                }
            };
            if map.len() >= MAX_TERMINAL_SESSIONS {
                drop(map);
                session.kill();
                let _ = child.wait();
                return Err("Too many open terminals; close an existing terminal first".into());
            }
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
                #[cfg(unix)]
                let mut after_exit_bytes = 0usize;
                loop {
                    if session_ref.killed.load(Ordering::Acquire) {
                        break;
                    }
                    #[cfg(unix)]
                    {
                        let mut descriptor = libc::pollfd {
                            fd: poll_fd.as_raw_fd(),
                            events: libc::POLLIN,
                            revents: 0,
                        };
                        let ready = unsafe { libc::poll(&mut descriptor, 1, 50) };
                        if ready < 0 {
                            if std::io::Error::last_os_error().kind()
                                == std::io::ErrorKind::Interrupted
                            {
                                continue;
                            }
                            break;
                        }
                        if ready == 0 {
                            if session_ref.child_exited.load(Ordering::Acquire) {
                                break;
                            }
                            continue;
                        }
                    }
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
                            #[cfg(unix)]
                            if session_ref.child_exited.load(Ordering::Acquire) {
                                // Drain the shell's buffered tail, but do not
                                // follow a disowned descendant's output forever.
                                after_exit_bytes += n;
                                if after_exit_bytes >= 256 * 1024 {
                                    break;
                                }
                            }
                        }
                        Err(error) => {
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                            ) {
                                continue;
                            }
                            break;
                        }
                    }
                }
            });

        let reader_thread = match reader_thread {
            Ok(thread) => thread,
            Err(error) => {
                self.kill_session(&session_id);
                let _ = child.wait();
                return Err(format!("Failed to start PTY reader thread: {error}"));
            }
        };

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
                wait_session_ref.child_exited.store(true, Ordering::Release);
                if let Ok(mut writer) = wait_session_ref.writer.lock() {
                    writer.take();
                }
                #[cfg(not(unix))]
                {
                    // Closing ConPTY is required to release its output pipe.
                    if let Ok(mut master) = wait_session_ref.master.lock() {
                        master.take();
                    }
                }
                // The last output and process exit are produced by different
                // threads. Drain the PTY before publishing exit so clients can
                // safely retire their session-to-view mapping on that event.
                let _ = reader_thread.join();
                #[cfg(unix)]
                if let Ok(mut master) = wait_session_ref.master.lock() {
                    master.take();
                }
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
            pty_backend: if cfg!(windows) { "conpty" } else { "unix" },
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

impl Drop for TerminalManager {
    fn drop(&mut self) {
        self.kill_all();
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
        return Err(format!(
            "Workspace directory does not exist: {}",
            path.display()
        ));
    }
    if !path.is_dir() {
        return Err(format!(
            "Workspace path is not a directory: {}",
            path.display()
        ));
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
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut bits = 0u32;
        let mut count = 0;
        let mut bytes = Vec::new();
        for byte in input.bytes().filter(|b| *b != b'=') {
            bits = (bits << 6) | alphabet.iter().position(|b| *b == byte).unwrap() as u32;
            count += 6;
            if count >= 8 {
                count -= 8;
                bytes.push((bits >> count) as u8);
                bits &= (1 << count) - 1;
            }
        }
        bytes
    }

    fn prepare_test_terminal(
        manager: &TerminalManager,
        sink: &TestSink,
        info: &TerminalSessionInfo,
    ) {
        #[cfg(windows)]
        {
            // portable-pty enables PSEUDOCONSOLE_INHERIT_CURSOR. Unlike xterm,
            // this test sink is not a terminal emulator: answer the initial
            // DSR query before sending commands or ConPTY cannot finish startup.
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                let output: Vec<u8> = sink
                    .outputs
                    .lock()
                    .unwrap()
                    .iter()
                    .flat_map(|e| decode_base64_for_test(&e.data))
                    .collect();
                if output.windows(4).any(|bytes| bytes == b"\x1b[6n") {
                    manager
                        .write_session(&info.session_id, "\x1b[1;1R")
                        .unwrap();
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "ConPTY did not send its startup cursor query: {:?}",
                    String::from_utf8_lossy(&output)
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        #[cfg(not(windows))]
        let _ = (manager, sink, info);
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
        prepare_test_terminal(&manager, &sink, &info);

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

    #[test]
    fn natural_exit_drains_output_and_retires_the_session() {
        let temp = tempfile::tempdir().unwrap();
        let manager = TerminalManager::new();
        let sink = Arc::new(TestSink::default());
        let info = manager
            .create_session(
                Arc::clone(&sink),
                &temp.path().to_string_lossy(),
                None,
                None,
            )
            .unwrap();
        prepare_test_terminal(&manager, &sink, &info);
        manager
            .write_session(&info.session_id, "echo GRAPHER_FINAL_OUTPUT\rexit\r")
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        while sink.exits.lock().unwrap().is_empty() {
            assert!(
                Instant::now() < deadline,
                "terminal did not report natural exit"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let output: Vec<u8> = sink
            .outputs
            .lock()
            .unwrap()
            .iter()
            .flat_map(|e| decode_base64_for_test(&e.data))
            .collect();
        assert!(String::from_utf8_lossy(&output).contains("GRAPHER_FINAL_OUTPUT"));
        assert_eq!(manager.active_count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn shell_exit_does_not_wait_for_a_disowned_child_to_close_stdin() {
        let (_, _, shell) = resolve_default_shell();
        if !matches!(shell.as_str(), "bash" | "zsh") {
            return;
        }
        struct BackgroundChild(i32);
        impl Drop for BackgroundChild {
            fn drop(&mut self) {
                unsafe {
                    libc::kill(self.0, libc::SIGKILL);
                }
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let manager = TerminalManager::new();
        let sink = Arc::new(TestSink::default());
        let info = manager
            .create_session(
                Arc::clone(&sink),
                &temp.path().to_string_lossy(),
                None,
                None,
            )
            .unwrap();
        manager
            .write_session(
                &info.session_id,
                "sleep 30 >/dev/null 2>&1 & echo $! > bg.pid; disown; exit\r",
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let pid = loop {
            if let Ok(pid) = std::fs::read_to_string(temp.path().join("bg.pid")) {
                if let Ok(pid) = pid.trim().parse::<i32>() {
                    break pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "background fixture did not start"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        let _background = BackgroundChild(pid);
        let deadline = Instant::now() + Duration::from_secs(1);
        while sink.exits.lock().unwrap().is_empty() {
            assert!(
                Instant::now() < deadline,
                "shell exit was blocked by an inherited PTY descriptor"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(manager.active_count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_child_that_stops_reading_does_not_block_input_or_close() {
        let temp = tempfile::tempdir().unwrap();
        let manager = TerminalManager::new();
        let sink = Arc::new(TestSink::default());
        let info = manager
            .create_session(
                Arc::clone(&sink),
                &temp.path().to_string_lossy(),
                None,
                None,
            )
            .unwrap();
        manager
            .write_session(
                &info.session_id,
                "stty -echo -icanon; printf 'ready-%s\\n' no-read; sleep 30\r",
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let output: Vec<u8> = sink
                .outputs
                .lock()
                .unwrap()
                .iter()
                .flat_map(|e| decode_base64_for_test(&e.data))
                .collect();
            if String::from_utf8_lossy(&output).contains("ready-no-read") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "terminal did not enter no-read mode"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let started = Instant::now();
        let data = "x".repeat(MAX_INPUT_BYTES);
        let results: Vec<_> = (0..20)
            .map(|_| manager.write_session(&info.session_id, &data))
            .collect();
        assert!(results
            .iter()
            .any(|r| r.as_ref().is_err_and(|e| e.contains("queue is full"))));
        manager.kill_session(&info.session_id);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "input backpressure blocked the caller"
        );
        assert_eq!(manager.active_count(), 0);
    }
}
