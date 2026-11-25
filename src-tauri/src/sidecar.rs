//! Owned Grapher backend child-process supervisor.
//!
//! Launches the compiled `grapher` binary in `--desktop-sidecar` dynamic-port
//! mode, reads the machine-readable stdout readiness handshake with bounded
//! timeout and early-exit diagnostics, and shuts down cleanly by closing stdin
//! before falling back to bounded force-termination.
use crate::paths::{build_fallback_path, path_env_key};
use serde::Deserialize;
use std::{
    collections::VecDeque,
    ffi::OsString,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

pub const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const STDERR_RING_MAX_LINES: usize = 80;
const STDERR_RING_MAX_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug)]
pub struct SidecarConfig {
    pub backend_executable: PathBuf,
    pub installation_root: PathBuf,
    pub bundled_node: Option<PathBuf>,
    pub trusted_git: Option<PathBuf>,
    pub managed_git_path: Option<PathBuf>,
    pub base_path: Option<OsString>,
    pub data_dir: PathBuf,
    pub startup_timeout: Duration,
    pub shutdown_timeout: Duration,
    pub extra_args: Vec<String>,
    pub extra_env: Vec<(String, String)>,
}

impl SidecarConfig {
    pub fn new(
        backend_executable: PathBuf,
        installation_root: PathBuf,
        bundled_node: Option<PathBuf>,
        trusted_git: Option<PathBuf>,
        data_dir: PathBuf,
    ) -> Self {
        Self {
            backend_executable,
            installation_root,
            bundled_node,
            trusted_git,
            managed_git_path: None,
            base_path: None,
            data_dir,
            startup_timeout: DEFAULT_STARTUP_TIMEOUT,
            shutdown_timeout: DEFAULT_SHUTDOWN_TIMEOUT,
            extra_args: Vec::new(),
            extra_env: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadyInfo {
    pub port: u16,
    pub base_url: String,
    pub data_dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyMessage {
    #[serde(rename = "type")]
    kind: String,
    port: u16,
    data_dir: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShutdownKind {
    AlreadyStopped,
    Graceful,
    Forced,
}

struct StderrBuffer {
    lines: VecDeque<String>,
    total_bytes: usize,
}

impl StderrBuffer {
    fn new() -> Self {
        Self {
            lines: VecDeque::new(),
            total_bytes: 0,
        }
    }

    fn push(&mut self, line: String) {
        self.total_bytes += line.len();
        self.lines.push_back(line);
        while self.lines.len() > STDERR_RING_MAX_LINES || self.total_bytes > STDERR_RING_MAX_BYTES {
            if let Some(removed) = self.lines.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(removed.len());
            } else {
                break;
            }
        }
    }

    fn snapshot(&self) -> String {
        self.lines
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }
}

enum StdoutEvent {
    Ready(ReadyInfo),
    InvalidLine(String),
    Closed,
}

#[cfg(windows)]
struct SidecarJobObject(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for SidecarJobObject {}

#[cfg(windows)]
impl SidecarJobObject {
    fn assign_child(child: &Child) -> Option<Self> {
        use std::{ffi::c_void, mem::size_of, os::windows::io::AsRawHandle, ptr};
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        unsafe {
            let job = CreateJobObjectW(ptr::null(), ptr::null());
            if job.is_null() {
                eprintln!("[grapher-desktop] Warning: failed to create Windows Job Object for backend sidecar");
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                eprintln!("[grapher-desktop] Warning: failed to configure Windows Job Object kill-on-close");
                CloseHandle(job);
                return None;
            }
            let process_handle = child.as_raw_handle();
            if AssignProcessToJobObject(job, process_handle) == 0 {
                eprintln!("[grapher-desktop] Warning: failed to assign backend sidecar to Windows Job Object");
                CloseHandle(job);
                return None;
            }
            Some(Self(job))
        }
    }
}

#[cfg(windows)]
impl Drop for SidecarJobObject {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
}

struct RunningChild {
    child: Child,
    stdin: Option<ChildStdin>,
    shutdown_timeout: Duration,
    #[cfg(windows)]
    _job: Option<SidecarJobObject>,
}

pub struct BackendSidecar {
    info: ReadyInfo,
    running: Mutex<Option<RunningChild>>,
    stderr_buffer: Arc<Mutex<StderrBuffer>>,
}

impl BackendSidecar {
    pub fn start(config: SidecarConfig) -> Result<Self, String> {
        let mut command = build_sidecar_command(&config)?;
        let mut child = command.spawn().map_err(|error| {
            format!(
                "Cannot launch Grapher backend `{}`: {error}",
                config.backend_executable.display()
            )
        })?;
        #[cfg(windows)]
        let job = SidecarJobObject::assign_child(&child);

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to attach stdin pipe to Grapher backend".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to attach stdout pipe to Grapher backend".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to attach stderr pipe to Grapher backend".to_string())?;

        let stderr_buffer = Arc::new(Mutex::new(StderrBuffer::new()));
        spawn_stderr_drain(stderr, Arc::clone(&stderr_buffer));

        let ready_rx = spawn_stdout_reader(stdout);
        let ready = match wait_for_readiness(
            &mut child,
            &ready_rx,
            &stderr_buffer,
            config.startup_timeout,
        ) {
            Ok(info) => info,
            Err(error) => {
                drop(stdin);
                force_terminate_child(&mut child);
                return Err(error);
            }
        };

        Ok(Self {
            info: ready,
            running: Mutex::new(Some(RunningChild {
                child,
                stdin: Some(stdin),
                shutdown_timeout: config.shutdown_timeout,
                #[cfg(windows)]
                _job: job,
            })),
            stderr_buffer,
        })
    }

    pub fn info(&self) -> &ReadyInfo {
        &self.info
    }

    /// Return the backend loopback base URL if the owned backend is still alive.
    pub fn backend_url(&self) -> Result<String, String> {
        let mut guard = self
            .running
            .lock()
            .map_err(|_| "Grapher backend supervisor state was poisoned".to_string())?;
        let Some(running) = guard.as_mut() else {
            return Err("Grapher backend has already shut down.".into());
        };
        match running.child.try_wait() {
            Ok(None) => Ok(self.info.base_url.clone()),
            Ok(Some(status)) => {
                let tail = read_stderr_tail(&self.stderr_buffer);
                *guard = None;
                Err(format_early_exit(
                    "Grapher backend exited unexpectedly after startup",
                    status,
                    &tail,
                ))
            }
            Err(error) => Err(format!("Cannot inspect Grapher backend process state: {error}")),
        }
    }

    /// Close stdin to trigger graceful backend shutdown, wait up to
    /// `shutdown_timeout`, and force-terminate only as a bounded fallback.
    pub fn shutdown(&self) -> ShutdownKind {
        let mut running = match self.running.lock() {
            Ok(mut guard) => match guard.take() {
                Some(running) => running,
                None => return ShutdownKind::AlreadyStopped,
            },
            Err(poisoned) => match poisoned.into_inner().take() {
                Some(running) => running,
                None => return ShutdownKind::AlreadyStopped,
            },
        };

        // Close stdin pipe (EOF) to signal graceful shutdown to `--desktop-sidecar`.
        drop(running.stdin.take());

        let deadline = Instant::now() + running.shutdown_timeout;
        loop {
            match running.child.try_wait() {
                Ok(Some(_)) => return ShutdownKind::Graceful,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        break;
                    }
                    thread::sleep(Duration::from_millis(25));
                }
                Err(_) => break,
            }
        }

        force_terminate_child(&mut running.child);
        ShutdownKind::Forced
    }
}

impl Drop for BackendSidecar {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

pub fn build_sidecar_command(config: &SidecarConfig) -> Result<Command, String> {
    let mut command = Command::new(&config.backend_executable);
    command
        .arg("--desktop-sidecar")
        .args(&config.extra_args)
        .env("GRAPHER_PORT", "0")
        .env("GRAPHER_DATA_DIR", &config.data_dir)
        // Supply both the backend contract env var (`GRAPHER_INSTALLATION_ROOT`)
        // and `GRAPHER_INSTALLATION_DIR` so bundled resources resolve uniformly.
        .env("GRAPHER_INSTALLATION_ROOT", &config.installation_root)
        .env("GRAPHER_INSTALLATION_DIR", &config.installation_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut fallback_dirs = Vec::new();
    if let Some(node) = &config.bundled_node {
        command
            .env("GRAPHER_TRUSTED_NODE", node)
            .env("GRAPHER_NODE_PATH", node);
        if let Some(parent) = node.parent() {
            fallback_dirs.push(parent.to_path_buf());
        }
    }
    if let Some(git) = &config.trusted_git {
        command.env("GRAPHER_TRUSTED_GIT", git);
        if let Some(parent) = git.parent() {
            fallback_dirs.push(parent.to_path_buf());
        }
    }
    if let Some(managed_git) = &config.managed_git_path {
        command.env("GRAPHER_MANAGED_GIT_PATH", managed_git);
    }
    if !fallback_dirs.is_empty() || config.base_path.is_some() {
        let key = path_env_key();
        let existing = std::env::var_os(&key);
        let base = config.base_path.as_deref().or(existing.as_deref());
        let merged = build_fallback_path(base, &fallback_dirs)?;
        command.env(key, merged);
    }

    for (key, value) in &config.extra_env {
        command.env(key, value);
    }

    configure_child_isolation(&mut command);
    Ok(command)
}

fn configure_child_isolation(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Put the backend in its own process group so bounded force-termination
        // can reap the entire group without signaling the desktop shell.
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
}

const MAX_STDERR_LINE_BYTES: usize = 8 * 1024;
const MAX_READY_LINE_BYTES: usize = 64 * 1024;

fn spawn_stderr_drain(stderr: impl std::io::Read + Send + 'static, buffer: Arc<Mutex<StderrBuffer>>) {
    let _ = thread::Builder::new()
        .name("grapher-sidecar-stderr".into())
        .spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = Vec::with_capacity(512);
            let emit = |bytes: &[u8]| {
                let mut trimmed = bytes;
                if trimmed.ends_with(b"\n") {
                    trimmed = &trimmed[..trimmed.len() - 1];
                }
                if trimmed.ends_with(b"\r") {
                    trimmed = &trimmed[..trimmed.len() - 1];
                }
                let text = String::from_utf8_lossy(trimmed).into_owned();
                eprintln!("[grapher-backend] {text}");
                if let Ok(mut guard) = buffer.lock() {
                    guard.push(text);
                }
            };
            loop {
                let available = match reader.fill_buf() {
                    Ok([]) => {
                        if !line.is_empty() {
                            emit(&line);
                        }
                        break;
                    }
                    Ok(buf) => buf,
                    Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => {
                        if !line.is_empty() {
                            emit(&line);
                        }
                        break;
                    }
                };
                if let Some(pos) = available.iter().position(|&b| b == b'\n') {
                    let take = pos + 1;
                    let remaining_cap = MAX_STDERR_LINE_BYTES.saturating_sub(line.len());
                    line.extend_from_slice(&available[..take.min(remaining_cap)]);
                    reader.consume(take);
                    emit(&line);
                    line.clear();
                } else {
                    let count = available.len();
                    let remaining_cap = MAX_STDERR_LINE_BYTES.saturating_sub(line.len());
                    if remaining_cap > 0 {
                        line.extend_from_slice(&available[..count.min(remaining_cap)]);
                    }
                    reader.consume(count);
                    if line.len() >= MAX_STDERR_LINE_BYTES {
                        emit(&line);
                        line.clear();
                    }
                }
            }
        });
}

fn spawn_stdout_reader(
    stdout: impl std::io::Read + Send + 'static,
) -> mpsc::Receiver<StdoutEvent> {
    let (tx, rx) = mpsc::channel();
    let _ = thread::Builder::new()
        .name("grapher-sidecar-stdout".into())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut raw = Vec::with_capacity(256);
            let mut announced = false;
            while !announced {
                raw.clear();
                let mut overflowed = false;
                loop {
                    let available = match reader.fill_buf() {
                        Ok([]) => break,
                        Ok(buf) => buf,
                        Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => {
                            raw.clear();
                            break;
                        }
                    };
                    if let Some(pos) = available.iter().position(|&b| b == b'\n') {
                        let take = pos + 1;
                        let cap = MAX_READY_LINE_BYTES.saturating_sub(raw.len());
                        raw.extend_from_slice(&available[..take.min(cap)]);
                        if take > cap {
                            overflowed = true;
                        }
                        reader.consume(take);
                        break;
                    }
                    let count = available.len();
                    let cap = MAX_READY_LINE_BYTES.saturating_sub(raw.len());
                    raw.extend_from_slice(&available[..count.min(cap)]);
                    if count > cap {
                        overflowed = true;
                    }
                    reader.consume(count);
                }
                if raw.is_empty() && !overflowed {
                    let _ = tx.send(StdoutEvent::Closed);
                    return;
                }
                if overflowed {
                    let _ = tx.send(StdoutEvent::InvalidLine(
                        "Backend readiness line exceeded 64 KiB".into(),
                    ));
                    break;
                }
                let text = String::from_utf8_lossy(&raw);
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    continue;
                }
                announced = true;
                match parse_ready_line(trimmed) {
                    Ok(info) => {
                        let _ = tx.send(StdoutEvent::Ready(info));
                    }
                    Err(reason) => {
                        let _ = tx.send(StdoutEvent::InvalidLine(format!(
                            "{reason} (line: {trimmed:?})"
                        )));
                    }
                }
            }
            // Drain any subsequent stdout without heap allocations so the pipe never blocks.
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
    rx
}

pub fn parse_ready_line(line: &str) -> Result<ReadyInfo, String> {
    let parsed: ReadyMessage = serde_json::from_str(line)
        .map_err(|error| format!("Invalid backend readiness JSON: {error}"))?;
    if parsed.kind != "grapher_ready" {
        return Err(format!(
            "Unexpected backend readiness event type: {:?}",
            parsed.kind
        ));
    }
    if parsed.port == 0 {
        return Err("Backend reported invalid readiness port 0".into());
    }
    Ok(ReadyInfo {
        port: parsed.port,
        base_url: format!("http://127.0.0.1:{}", parsed.port),
        data_dir: parsed.data_dir,
    })
}

fn wait_for_readiness(
    child: &mut Child,
    rx: &mpsc::Receiver<StdoutEvent>,
    stderr_buffer: &Arc<Mutex<StderrBuffer>>,
    timeout: Duration,
) -> Result<ReadyInfo, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            thread::sleep(Duration::from_millis(30));
            let tail = read_stderr_tail(stderr_buffer);
            return Err(format_with_stderr(
                &format!(
                    "Timed out after {}ms waiting for Grapher backend readiness signal.",
                    timeout.as_millis()
                ),
                &tail,
            ));
        }

        let step = remaining.min(Duration::from_millis(25));
        match rx.recv_timeout(step) {
            Ok(StdoutEvent::Ready(info)) => return Ok(info),
            Ok(StdoutEvent::InvalidLine(detail)) => {
                thread::sleep(Duration::from_millis(50));
                let tail = read_stderr_tail(stderr_buffer);
                return Err(format_with_stderr(
                    &format!("Grapher backend violated readiness protocol: {detail}"),
                    &tail,
                ));
            }
            Ok(StdoutEvent::Closed) => {
                // Allow the process a brief moment to settle its exit status & stderr flush.
                let status = wait_briefly_for_exit(child, Duration::from_millis(300));
                thread::sleep(Duration::from_millis(50));
                let tail = read_stderr_tail(stderr_buffer);
                if let Some(status) = status {
                    return Err(format_early_exit(
                        "Grapher backend exited before becoming ready",
                        status,
                        &tail,
                    ));
                }
                return Err(format_with_stderr(
                    "Grapher backend closed stdout before emitting a readiness signal.",
                    &tail,
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let status = wait_briefly_for_exit(child, Duration::from_millis(300));
                let tail = read_stderr_tail(stderr_buffer);
                if let Some(status) = status {
                    return Err(format_early_exit(
                        "Grapher backend exited before becoming ready",
                        status,
                        &tail,
                    ));
                }
                return Err(format_with_stderr(
                    "Grapher backend readiness channel closed unexpectedly.",
                    &tail,
                ));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(Some(status)) = child.try_wait() {
                    thread::sleep(Duration::from_millis(75));
                    let tail = read_stderr_tail(stderr_buffer);
                    return Err(format_early_exit(
                        "Grapher backend exited before becoming ready",
                        status,
                        &tail,
                    ));
                }
            }
        }
    }
}

fn wait_briefly_for_exit(child: &mut Child, max_wait: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + max_wait;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(Duration::from_millis(15));
    }
}

fn read_stderr_tail(buffer: &Arc<Mutex<StderrBuffer>>) -> String {
    buffer
        .lock()
        .map(|guard| guard.snapshot())
        .unwrap_or_default()
}

fn format_early_exit(prefix: &str, status: ExitStatus, stderr_tail: &str) -> String {
    format_with_stderr(&format!("{prefix} ({status})."), stderr_tail)
}

fn format_with_stderr(message: &str, stderr_tail: &str) -> String {
    let trimmed = stderr_tail.trim();
    if trimmed.is_empty() {
        message.to_string()
    } else {
        format!("{message}\nBackend stderr:\n{trimmed}")
    }
}

fn force_terminate_child(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    #[cfg(unix)]
    {
        if let Ok(pid) = libc::pid_t::try_from(child.id()) {
            if pid > 0 {
                unsafe {
                    let _ = libc::kill(-pid, libc::SIGKILL);
                }
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::fs;

    #[cfg(unix)]
    fn write_script(dir: &std::path::Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn parse_ready_line_accepts_valid_payload_and_rejects_invalid_ones() {
        let info = parse_ready_line(
            r#"{"type":"grapher_ready","port":54321,"dataDir":"/tmp/grapher/data"}"#,
        )
        .unwrap();
        assert_eq!(info.port, 54321);
        assert_eq!(info.base_url, "http://127.0.0.1:54321");
        assert_eq!(info.data_dir, "/tmp/grapher/data");

        assert!(parse_ready_line(r#"{"type":"grapher_ready","port":0,"dataDir":"/x"}"#).is_err());
        assert!(parse_ready_line(r#"{"type":"other","port":1234,"dataDir":"/x"}"#).is_err());
        assert!(parse_ready_line("not json").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn sidecar_reads_readiness_passes_desktop_env_and_exits_gracefully_on_stdin_close() {
        let temp = tempfile::tempdir().unwrap();
        let env_dump = temp.path().join("env.txt");
        let fake_node = temp.path().join("node/bin/node");
        fs::create_dir_all(fake_node.parent().unwrap()).unwrap();
        fs::write(&fake_node, "#!/bin/sh\nexit 0\n").unwrap();
        let resources = temp.path().join("resources/runtime");
        fs::create_dir_all(&resources).unwrap();
        let data = temp.path().join("app-data/data");
        fs::create_dir_all(&data).unwrap();

        let script = write_script(
            temp.path(),
            "fake-backend.sh",
            &format!(
                r#"printf 'ARGS=%s\nPORT=%s\nDATA=%s\nROOT=%s\nDIR=%s\nNODE=%s\nPATH=%s\n' "$*" "$GRAPHER_PORT" "$GRAPHER_DATA_DIR" "$GRAPHER_INSTALLATION_ROOT" "$GRAPHER_INSTALLATION_DIR" "$GRAPHER_TRUSTED_NODE" "$PATH" > "{}"
printf '{{"type":"grapher_ready","port":43210,"dataDir":"%s"}}\n' "$GRAPHER_DATA_DIR"
# Block until parent closes stdin, then exit cleanly.
cat >/dev/null
exit 0"#,
                env_dump.display()
            ),
        );

        let mut config = SidecarConfig::new(
            script,
            resources.clone(),
            Some(fake_node.clone()),
            None,
            data.clone(),
        );
        let user_bin = temp.path().join("user/bin");
        config.base_path = Some(
            std::env::join_paths([&user_bin, &PathBuf::from("/usr/bin")]).unwrap(),
        );
        let sidecar = BackendSidecar::start(config).unwrap();
        assert_eq!(sidecar.backend_url().unwrap(), "http://127.0.0.1:43210");

        let dumped = fs::read_to_string(&env_dump).unwrap();
        assert!(dumped.contains("ARGS=--desktop-sidecar\n"), "{dumped}");
        assert!(dumped.contains("PORT=0\n"), "{dumped}");
        assert!(dumped.contains(&format!("DATA={}\n", data.display())), "{dumped}");
        assert!(dumped.contains(&format!("ROOT={}\n", resources.display())), "{dumped}");
        assert!(dumped.contains(&format!("DIR={}\n", resources.display())), "{dumped}");
        assert!(dumped.contains(&format!("NODE={}\n", fake_node.display())), "{dumped}");
        assert!(
            dumped.contains(&format!(
                "PATH={}:/usr/bin:{}\n",
                user_bin.display(),
                fake_node.parent().unwrap().display()
            )),
            "{dumped}"
        );

        assert_eq!(sidecar.shutdown(), ShutdownKind::Graceful);
        assert_eq!(sidecar.shutdown(), ShutdownKind::AlreadyStopped);
        assert!(sidecar.backend_url().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn sidecar_reports_early_exit_with_stderr_diagnostics() {
        let temp = tempfile::tempdir().unwrap();
        let script = write_script(
            temp.path(),
            "crash-backend.sh",
            "echo 'fatal startup failure: lock busy' >&2\nexit 23",
        );

        let mut config = SidecarConfig::new(
            script,
            temp.path().to_path_buf(),
            None,
            None,
            temp.path().join("data"),
        );
        config.startup_timeout = Duration::from_secs(3);

        let err = BackendSidecar::start(config).err().unwrap();
        assert!(err.contains("exited before becoming ready"), "{err}");
        assert!(err.contains("fatal startup failure: lock busy"), "{err}");
    }

    #[test]
    fn stderr_drain_survives_non_utf8_bytes_and_captures_following_lines() {
        let buffer = Arc::new(Mutex::new(StderrBuffer::new()));
        let mut payload = b"first line\nlegacy byte: ".to_vec();
        payload.extend_from_slice(&[0xff, 0xfe]);
        payload.extend_from_slice(b"\nafter invalid utf8\n");
        spawn_stderr_drain(std::io::Cursor::new(payload), Arc::clone(&buffer));

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let snap = read_stderr_tail(&buffer);
            if snap.contains("after invalid utf8") {
                assert!(snap.contains("first line"), "{snap}");
                assert!(snap.contains("legacy byte: "), "{snap}");
                break;
            }
            assert!(Instant::now() < deadline, "stderr drain dropped trailing lines: {snap}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    #[test]
    fn sidecar_times_out_with_diagnostics_and_terminates_hung_startup() {
        let temp = tempfile::tempdir().unwrap();
        let script = write_script(
            temp.path(),
            "hang-backend.sh",
            "echo 'still initializing...' >&2\nsleep 30",
        );

        let mut config = SidecarConfig::new(
            script,
            temp.path().to_path_buf(),
            None,
            None,
            temp.path().join("data"),
        );
        config.startup_timeout = Duration::from_millis(1500);

        let err = BackendSidecar::start(config).err().unwrap();
        assert!(err.contains("Timed out"), "{err}");
        assert!(err.contains("still initializing..."), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn sidecar_force_terminates_when_child_ignores_stdin_eof() {
        let temp = tempfile::tempdir().unwrap();
        let script = write_script(
            temp.path(),
            "stubborn-backend.sh",
            r#"printf '{"type":"grapher_ready","port":43211,"dataDir":"/tmp/d"}\n'
# Ignore stdin EOF and keep sleeping so bounded force-kill fallback triggers.
sleep 30"#,
        );

        let mut config = SidecarConfig::new(
            script,
            temp.path().to_path_buf(),
            None,
            None,
            temp.path().join("data"),
        );
        config.shutdown_timeout = Duration::from_millis(200);

        let sidecar = BackendSidecar::start(config).unwrap();
        let started = Instant::now();
        assert_eq!(sidecar.shutdown(), ShutdownKind::Forced);
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
