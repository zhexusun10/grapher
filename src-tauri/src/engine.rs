use crate::model::{Config, Execution};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

static PROCESSES: OnceLock<Mutex<BTreeSet<u32>>> = OnceLock::new();

struct ProcessGuard(u32);

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
        if let Ok(mut processes) = PROCESSES.get_or_init(Default::default).lock() {
            processes.remove(&self.0);
        }
    }
}

pub fn terminate_all() {
    if let Ok(processes) = PROCESSES.get_or_init(Default::default).lock() {
        for process in processes.iter() {
            unsafe {
                libc::kill(-(*process as i32), libc::SIGKILL);
            }
        }
    }
}

pub struct PiRequest<'request> {
    pub config: &'request Config,
    pub cwd: &'request Path,
    pub task: &'request str,
    pub session_dir: &'request Path,
    pub extension: Option<&'request Path>,
    pub tools: &'request str,
    pub session_id: Option<&'request str>,
    pub environment: Vec<(&'request str, String)>,
}

pub fn run_pi(request: PiRequest<'_>, mut on_output: impl FnMut(String)) -> Result<String, String> {
    let config = request.config;
    let mut command = Command::new(&config.pi_command);
    command.args(&config.pi_args).args([
        "--mode",
        "json",
        "--print",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-approve",
        "--tools",
        request.tools,
    ]);
    if let Some(extension) = request.extension {
        command.args([
            "--extension",
            extension.to_str().ok_or("Invalid extension path")?,
            "--no-context-files",
        ]);
    }
    if !config.model.trim().is_empty() {
        command.args(["--model", &config.model]);
    }
    if let Some(session_id) = request.session_id {
        command.args(["--session-id", session_id]);
    }
    fs::create_dir_all(request.session_dir).map_err(|error| error.to_string())?;
    command
        .arg("--session-dir")
        .arg(request.session_dir)
        .current_dir(request.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in request.environment {
        command.env(key, value);
    }
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start Pi ({}): {error}", config.pi_command))?;
    PROCESSES
        .get_or_init(Default::default)
        .lock()
        .map_err(|error| error.to_string())?
        .insert(child.id());
    let _guard = ProcessGuard(child.id());
    if let Err(error) = child
        .stdin
        .take()
        .ok_or("Pi stdin unavailable")?
        .write_all(request.task.as_bytes())
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.to_string());
    }
    let (sender, receiver) = mpsc::channel();
    let stdout = child.stdout.take().ok_or("Pi stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Pi stderr unavailable")?;
    let error_sender = sender.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if sender
                .send((false, line.unwrap_or_else(|error| error.to_string())))
                .is_err()
            {
                break;
            }
        }
    });
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            if error_sender
                .send((true, line.unwrap_or_else(|error| error.to_string())))
                .is_err()
            {
                break;
            }
        }
    });
    let started = Instant::now();
    let mut final_text = String::new();
    let mut agent_error = None;
    let mut stderr_tail = String::new();
    let mut exited_at = None;
    loop {
        if started.elapsed() > Duration::from_secs(900) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Pi timed out after 15 minutes; inspect the isolated worktree before retrying"
                    .into(),
            );
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok((is_error, line)) => {
                if is_error {
                    stderr_tail = line.clone();
                    on_output(format!("[stderr] {line}\n"));
                    continue;
                }
                if let Ok(event) = serde_json::from_str::<Value>(&line) {
                    match event["type"].as_str().unwrap_or_default() {
                        "message_end" if event["message"]["role"] == "assistant" => {
                            let message = &event["message"];
                            final_text = message["content"]
                                .as_array()
                                .map(|items| {
                                    items
                                        .iter()
                                        .filter(|item| item["type"] == "text")
                                        .filter_map(|item| item["text"].as_str())
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                })
                                .unwrap_or_default();
                            if matches!(message["stopReason"].as_str(), Some("error" | "aborted")) {
                                agent_error = Some(
                                    message["errorMessage"]
                                        .as_str()
                                        .unwrap_or("Pi assistant failed")
                                        .to_string(),
                                );
                            }
                        }
                        _ => {}
                    }
                }
                on_output(format!("{line}\n"));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if exited_at.is_none()
                    && child
                        .try_wait()
                        .map_err(|error| error.to_string())?
                        .is_some()
                {
                    exited_at = Some(Instant::now());
                }
                if exited_at.is_some_and(|time| time.elapsed() > Duration::from_secs(2)) {
                    break;
                }
            }
        }
    }
    let status = child.wait().map_err(|error| error.to_string())?;
    if !status.success() {
        return Err(format!("Pi exited with {status}: {stderr_tail}"));
    }
    if let Some(error) = agent_error {
        return Err(error);
    }
    if final_text.trim().is_empty() {
        return Err(
            "Pi returned no final assistant text; check model authentication and CLI compatibility"
                .into(),
        );
    }
    Ok(final_text)
}

pub fn execute(
    config: &Config,
    execution: &Execution,
    task: &str,
    reviewer: bool,
    mut on_output: impl FnMut(String),
) -> Result<String, String> {
    if config.engine == "demo" {
        on_output(format!(
            "[demo] Fresh execution {}\n[read] Inspecting isolated workspace\n",
            execution.session_id
        ));
        thread::sleep(Duration::from_millis(650));
        let output = if reviewer && execution.attempt == 1 {
            "Demo verification: add an empty-state message.\n<REVISE>".into()
        } else if reviewer {
            "Demo verification passed.\n<ACCEPT>".into()
        } else {
            fs::write(
                Path::new(&execution.worktree).join(format!("{}.md", execution.node)),
                format!(
                    "# {}\n\n{}\n\nAttempt {}\n",
                    execution.node, task, execution.attempt
                ),
            )
            .map_err(|error| error.to_string())?;
            format!(
                "Implemented {} in its isolated workspace.\nDemo execution #{} completed.",
                execution.node, execution.attempt
            )
        };
        on_output(format!("[assistant] {output}\n"));
        return Ok(output);
    }
    let task = if reviewer {
        format!("{task}\n\nEnd your response with exactly one standalone final line:\n<ACCEPT>\nor\n<REVISE>\nIf REVISE, clearly describe the changes needed before the marker.")
    } else {
        task.into()
    };
    let session_dir = Path::new(&execution.worktree)
        .parent()
        .ok_or("Invalid worktree")?
        .join(format!("sessions-{}", execution.id));
    run_pi(
        PiRequest {
            config,
            cwd: Path::new(&execution.worktree),
            task: &task,
            session_dir: &session_dir,
            extension: None,
            tools: "read,write,bash,edit",
            session_id: Some(&execution.session_id),
            environment: Vec::new(),
        },
        on_output,
    )
}

pub fn feedback(output: &str) -> Result<bool, String> {
    match output.trim().lines().last().map(str::trim) {
        Some("<ACCEPT>") => Ok(false),
        Some("<REVISE>") => Ok(true),
        _ => Err("Feedback protocol error: final line must be exactly <ACCEPT> or <REVISE>".into()),
    }
}
