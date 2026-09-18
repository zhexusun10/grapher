use crate::model::{Config, Execution, Route};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
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

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum PiRole {
    Partitioner,
    Planner,
    NodeAgent,
    Merger,
}

impl PiRole {
    pub fn name(&self) -> &'static str {
        match self {
            PiRole::Partitioner => "Partitioner",
            PiRole::Planner => "Planner",
            PiRole::NodeAgent => "NodeAgent",
            PiRole::Merger => "Merger",
        }
    }

    pub fn timeout_seconds(&self) -> u64 {
        match self {
            PiRole::Partitioner => 60,
            PiRole::Planner => 300,
            PiRole::NodeAgent => 900,
            PiRole::Merger => 900,
        }
    }

    pub fn timeout_env_var(&self) -> &'static str {
        match self {
            PiRole::Partitioner => "PARTITIONER_TIMEOUT_SECONDS",
            PiRole::Planner => "PLANNER_TIMEOUT_SECONDS",
            PiRole::NodeAgent => "NODE_AGENT_TIMEOUT_SECONDS",
            PiRole::Merger => "MERGER_TIMEOUT_SECONDS",
        }
    }

    pub fn model_env_var(&self) -> &'static str {
        match self {
            PiRole::Partitioner => "PARTITIONER_MODEL",
            PiRole::Planner => "PLANNER_MODEL",
            PiRole::NodeAgent => "NODE_AGENT_MODEL",
            PiRole::Merger => "MERGER_MODEL",
        }
    }

    pub fn thinking_env_var(&self) -> &'static str {
        match self {
            PiRole::Partitioner => "PARTITIONER_THINKING",
            PiRole::Planner => "PLANNER_THINKING",
            PiRole::NodeAgent => "NODE_AGENT_THINKING",
            PiRole::Merger => "MERGER_THINKING",
        }
    }

    pub fn from_mode(mode: Option<&str>) -> Self {
        match mode {
            Some("partition") => PiRole::Partitioner,
            Some("planner") => PiRole::Planner,
            Some("merger") => PiRole::Merger,
            _ => PiRole::NodeAgent,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PiModelConfig {
    pub model: String,
    pub thinking: Option<String>,
}

impl PiModelConfig {
    pub fn resolve(role: PiRole, base_config: &Config) -> Self {
        let model = std::env::var(role.model_env_var())
            .ok()
            .filter(|m| !m.trim().is_empty())
            .or_else(|| {
                if !base_config.model.trim().is_empty() {
                    Some(base_config.model.clone())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| "qwen3.8-flash".to_string());

        let thinking = std::env::var(role.thinking_env_var())
            .ok()
            .filter(|t| !t.trim().is_empty())
            .or_else(|| (role == PiRole::Partitioner).then(|| "off".into()));

        Self { model, thinking }
    }

    pub fn effective_config(&self, base_config: &Config) -> Config {
        let mut cfg = base_config.clone();
        cfg.model = self.model.clone();
        cfg
    }
}

/// Parses the model text output to determine whether it chose "graph" or "serial".
/// If ambiguous, missing, or model hallucinated, defaults safely to "serial".
pub fn parse_route_decision(text: &str) -> Route {
    let trimmed = text.trim();
    let lower = trimmed.to_lowercase();

    // 1. Direct single-word match (ignoring whitespace and surrounding punctuation)
    let clean_single = lower.trim_matches(|c: char| !c.is_alphanumeric());
    if clean_single == "graph" {
        return Route {
            plan_type: "graph".into(),
        };
    }
    if clean_single == "serial" {
        return Route {
            plan_type: "serial".into(),
        };
    }

    // 2. Check each line in reverse order (bottom-up priority)
    for line in lower.lines().rev() {
        let line_clean = line.trim().trim_matches(|c: char| !c.is_alphanumeric());
        if line_clean == "graph" {
            return Route {
                plan_type: "graph".into(),
            };
        }
        if line_clean == "serial" {
            return Route {
                plan_type: "serial".into(),
            };
        }

        let tokens: Vec<&str> = line
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .collect();
        let line_g = tokens.contains(&"graph");
        let line_s = tokens.contains(&"serial");
        if line_g && !line_s {
            return Route {
                plan_type: "graph".into(),
            };
        }
        if line_s && !line_g {
            return Route {
                plan_type: "serial".into(),
            };
        }
    }

    // 3. Check for explicit decision/choice markers if present
    for marker in ["decision:", "choice:", "conclusion:", "result:"] {
        if let Some(pos) = lower.rfind(marker) {
            let after = &lower[pos..];
            let after_tokens: Vec<&str> = after
                .split(|c: char| !c.is_alphanumeric())
                .filter(|w| !w.is_empty())
                .collect();
            let after_g = after_tokens.contains(&"graph");
            let after_s = after_tokens.contains(&"serial");
            if after_g && !after_s {
                return Route {
                    plan_type: "graph".into(),
                };
            }
            if after_s && !after_g {
                return Route {
                    plan_type: "serial".into(),
                };
            }
        }
    }

    // 4. Token scan across entire text
    let all_tokens: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let total_g = all_tokens.contains(&"graph");
    let total_s = all_tokens.contains(&"serial");

    if total_g && !total_s {
        return Route {
            plan_type: "graph".into(),
        };
    }
    if total_s && !total_g {
        return Route {
            plan_type: "serial".into(),
        };
    }

    // 5. If both words are mentioned in prose, the later occurrence represents the conclusion
    if total_g && total_s {
        let last_g = lower
            .match_indices("graph")
            .filter_map(|(idx, _)| {
                let before = lower[..idx].chars().next_back();
                let after = lower[idx + 5..].chars().next();
                let before_ok = before.map_or(true, |c| !c.is_alphanumeric());
                let after_ok = after.map_or(true, |c| !c.is_alphanumeric());
                if before_ok && after_ok {
                    Some(idx)
                } else {
                    None
                }
            })
            .last();

        let last_s = lower
            .match_indices("serial")
            .filter_map(|(idx, _)| {
                let before = lower[..idx].chars().next_back();
                let after = lower[idx + 6..].chars().next();
                let before_ok = before.map_or(true, |c| !c.is_alphanumeric());
                let after_ok = after.map_or(true, |c| !c.is_alphanumeric());
                if before_ok && after_ok {
                    Some(idx)
                } else {
                    None
                }
            })
            .last();

        match (last_g, last_s) {
            (Some(g), Some(s)) => {
                if g > s {
                    return Route {
                        plan_type: "graph".into(),
                    };
                } else {
                    return Route {
                        plan_type: "serial".into(),
                    };
                }
            }
            (Some(_), None) => {
                return Route {
                    plan_type: "graph".into(),
                }
            }
            (None, Some(_)) => {
                return Route {
                    plan_type: "serial".into(),
                }
            }
            (None, None) => {}
        }
    }

    // 6. Safe fallback for hallucination or completely unrelated output
    Route {
        plan_type: "serial".into(),
    }
}

pub struct PiRequest<'request> {
    pub role: PiRole,
    pub config: &'request Config,
    pub cwd: &'request Path,
    pub task: &'request str,
    pub session_dir: &'request Path,
    pub extension: Option<&'request Path>,
    pub tools: Option<&'request str>,
    pub session_id: Option<&'request str>,
    pub extra_args: Vec<&'request str>,
    pub environment: Vec<(&'request str, String)>,
    pub system_prompt: Option<&'request str>,
}

fn execution_budget(role: PiRole) -> (&'static str, Duration) {
    let seconds = std::env::var(role.timeout_env_var())
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or_else(|| role.timeout_seconds());
    (role.name(), Duration::from_secs(seconds))
}

pub fn run_pi(request: PiRequest<'_>, mut on_output: impl FnMut(String)) -> Result<String, String> {
    let (phase, budget) = execution_budget(request.role);
    let config = request.config;
    fs::create_dir_all(request.session_dir).map_err(|error| error.to_string())?;
    // Production always runs the pinned, Grapher-owned entrypoint. Persisted
    // legacy command fields cannot select a different engine implementation.
    #[cfg(not(feature = "fixture"))]
    let mut command = {
        let repository = Path::new(&config.repository)
            .canonicalize()
            .map_err(|_| "Invalid repository path")?;
        let current = request
            .cwd
            .canonicalize()
            .map_err(|_| "Invalid execution path")?;
        if current != repository {
            let profile = request.session_dir.join("execution-instance.sb");
            let worktree_root = current.parent().and_then(Path::parent)
                .filter(|path| path.file_name().is_some_and(|name| name == ".grapher-worktrees" || name == ".grapher-workspaces"))
                .ok_or("Graph execution must use .grapher-workspaces/<run>/<instance>; rerun legacy workspaces")?;
            crate::sandbox::write_graph_profile(&profile, &repository, worktree_root, &current)?;
            let mut command = Command::new("/usr/bin/sandbox-exec");
            command.args([
                "-f",
                profile.to_str().ok_or("Invalid sandbox profile path")?,
                "node",
            ]);
            command.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../engine/entrypoint.mjs"));
            command
        } else {
            let mut command = Command::new("node");
            command.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../engine/entrypoint.mjs"));
            command
        }
    };
    // Process substitution is exclusively a test capability.
    #[cfg(feature = "fixture")]
    let mut command = {
        let mut command = Command::new(&config.pi_command);
        command.args(&config.pi_args);
        command
    };
    command.args([
        "--mode",
        "json",
        "--print",
        "--no-prompt-templates",
        "--no-themes",
    ]);
    if request.role == PiRole::NodeAgent {
        command.arg("--approve");
    } else {
        command.args(["--no-extensions", "--no-skills", "--no-approve"]);
    }
    match request.tools {
        Some(tools) if tools.trim().is_empty() => {
            command.arg("--no-tools");
        }
        Some(tools) => {
            command.args(["--tools", tools]);
        }
        None => {}
    }
    if let Some(extension) = request.extension {
        command.args([
            "--extension",
            extension.to_str().ok_or("Invalid extension path")?,
            "--no-context-files",
        ]);
    }
    let model = if !config.model.trim().is_empty() {
        Some(config.model.as_str())
    } else {
        Some("qwen3.8-flash")
    };
    if let Some(model) = model {
        command.args(["--model", model]);
    }
    if let Some(session_id) = request.session_id {
        command.args(["--session-id", session_id]);
    }
    if !request.extra_args.is_empty() {
        command.args(&request.extra_args);
    }
    if let Some(system_prompt) = request.system_prompt {
        let prompt_path = if Path::new(system_prompt).is_file() {
            PathBuf::from(system_prompt)
        } else {
            let path = request.session_dir.join("system-prompt.md");
            fs::write(&path, system_prompt).map_err(|error| error.to_string())?;
            path
        };
        command.args([
            "--system-prompt",
            prompt_path.to_str().ok_or("Invalid system prompt path")?,
        ]);
    }
    command
        .arg("--session-dir")
        .arg(request.session_dir)
        .current_dir(request.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Strip external Pi environment variables so child Pi instances
    // are completely isolated from outer Pi CLI sessions or shell exports.
    command.env_remove("PI_MODEL");
    command.env_remove("PI_THINKING");
    command.env_remove("PI_PROVIDER");
    command.env_remove("PI_REASONING_LEVEL");
    command.env_remove("PI_SESSION_ID");
    command.env_remove("PI_SESSION_FILE");
    for (key, value) in request.environment {
        command.env(key, value);
    }
    // The host owns the instance identity. Never inherit another agent's role
    // or directory mapping from the parent process or role-specific overrides.
    command.env(
        "GRAPHER_MODE",
        match request.role {
            PiRole::Partitioner => "partition",
            PiRole::Planner => "planner",
            PiRole::NodeAgent => "node",
            PiRole::Merger => "merger",
        },
    );
    command.env(
        "GRAPHER_WORKSPACE_ROOT",
        request
            .cwd
            .canonicalize()
            .map_err(|error| error.to_string())?,
    );
    command.env(
        "GRAPHER_ORIGINAL_ROOT",
        context
            .original_repository
            .canonicalize()
            .map_err(|error| error.to_string())?,
    );
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start Execution Instance Engine: {error}"))?;
    PROCESSES
        .get_or_init(Default::default)
        .lock()
        .map_err(|error| error.to_string())?
        .insert(child.id());
    let _guard = ProcessGuard(child.id());
    on_output(format!(
        "{}\n",
        serde_json::json!({"type":"grapher_process_started", "pid":child.id(), "sessionId":request.session_id, "cwd":request.cwd, "timestamp":crate::model::now()})
    ));
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
        if started.elapsed() > budget {
            let _ = child.kill();
            let _ = child.wait();
            on_output(format!(
                "{}\n",
                serde_json::json!({"type":"grapher_process_exited", "pid":child.id(), "success":false, "timedOut":true, "phase":phase, "elapsedMs":started.elapsed().as_millis(), "timestamp":crate::model::now()})
            ));
            return Err(format!(
                "{phase} timed out after {} seconds; inspect the saved session before retrying",
                budget.as_secs()
            ));
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok((is_error, line)) => {
                if is_error {
                    if line.contains("No project session found with id")
                        && line.contains("creating a new session with that id")
                    {
                        continue;
                    }
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
                            } else {
                                // Pi can emit a transient error before its own successful retry.
                                // Keep the stream, but judge the final assistant response.
                                agent_error = None;
                            }
                        }
                        _ => {}
                    }
                }
                let received_line = if let Ok(mut event) = serde_json::from_str::<Value>(&line) {
                    if let Some(object) = event.as_object_mut() {
                        object.insert("grapherReceivedAt".into(), crate::model::now().into());
                    }
                    Some(serde_json::to_string(&event).map_err(|error| error.to_string())?)
                } else {
                    None
                };
                on_output(format!("{}\n", received_line.as_deref().unwrap_or(&line)));
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
    on_output(format!(
        "{}\n",
        serde_json::json!({"type":"grapher_process_exited", "pid":child.id(), "code":status.code(), "success":status.success(), "phase":phase, "elapsedMs":started.elapsed().as_millis(), "timestamp":crate::model::now()})
    ));
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
    feedback_source: bool,
    root: &Path,
    on_output: impl FnMut(String),
) -> Result<String, String> {
    #[cfg(feature = "fixture")]
    if config.engine == crate::fixture::ENGINE {
        return crate::fixture::execute(execution, task, feedback_source, on_output);
    }
    let task = if feedback_source {
        format!("{task}\n\nEnd your response with exactly one standalone final line:\n<ACCEPT>\nor\n<REVISE>\nIf REVISE, clearly describe the changes needed before the marker.")
    } else {
        task.into()
    };
    let execution_date = Command::new("/bin/date")
        .args(["-u", "+%Y-%m-%d"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|date| date.trim().to_string());
    let task = if let Some(date) = execution_date {
        format!("{task}\n\nHost execution date (UTC): {date}. If your deliverable requires a date, use this observed date rather than guessing.")
    } else {
        task
    };
    let session_dir = root.join("sessions").join(&execution.id);
    let model_config = PiModelConfig::resolve(PiRole::NodeAgent, config);
    let effective_config = model_config.effective_config(config);
    let mut extra_args = Vec::new();
    if let Some(thinking) = &model_config.thinking {
        extra_args.push("--thinking");
        extra_args.push(thinking.as_str());
    }
    run_pi(
        PiRequest {
            role: PiRole::NodeAgent,
            config: &effective_config,
            cwd: Path::new(&execution.worktree),
            task: &task,
            session_dir: &session_dir,
            extension: None,
            tools: None,
            session_id: Some(&execution.session_id),
            extra_args,
            environment: vec![("GRAPHER_MODE", "node".into())],
            system_prompt: None,
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
