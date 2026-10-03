use crate::{
    model::{Config, Execution, Route},
    process_control,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

#[cfg(feature = "fixture")]
use std::process::Command;
#[cfg(not(feature = "fixture"))]
use std::{
    hash::{Hash, Hasher},
    process::Child,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};

#[cfg(not(feature = "fixture"))]
struct WarmPartitioner {
    child: Child,
    tree: process_control::ProcessTree,
    session_dir: PathBuf,
    key: (PathBuf, String, String, String),
}

#[cfg(not(feature = "fixture"))]
struct WarmNode {
    child: Child,
    tree: process_control::ProcessTree,
    key: (PathBuf, PathBuf, String, String, String, String),
    session_hash: u64,
    startup_output: Vec<String>,
}

#[cfg(not(feature = "fixture"))]
static WARM_PARTITIONER: OnceLock<Mutex<Option<WarmPartitioner>>> = OnceLock::new();
#[cfg(not(feature = "fixture"))]
static WARM_NODE: OnceLock<Mutex<Option<WarmNode>>> = OnceLock::new();
#[cfg(not(feature = "fixture"))]
static NODE_WARM_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(not(feature = "fixture"))]
static PREWARM_SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

#[cfg(not(feature = "fixture"))]
fn partitioner_key(config: &Config) -> Result<(PathBuf, String, String, String), String> {
    let model = PiModelConfig::resolve(PiRole::Partitioner, config);
    let repo = Path::new(&config.repository)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let prompt = std::env::var("PARTITIONER_SYSTEM_PROMPT").unwrap_or_else(|_| {
        include_str!("../resources/prompts/partitioner.md")
            .trim()
            .to_string()
    });
    let prompt = if Path::new(&prompt).is_file() {
        fs::read_to_string(&prompt).map_err(|e| e.to_string())?
    } else {
        prompt
    };
    Ok((
        repo,
        model.model,
        model.thinking.unwrap_or_else(|| "off".into()),
        prompt,
    ))
}

/// Warm both Auto routing and Graph's shared native engine off the request path.
#[cfg(not(feature = "fixture"))]
pub fn warm_planning_engines(config: Config) {
    if cfg!(test)
        || PREWARM_SHUTTING_DOWN.load(Ordering::SeqCst)
        || config.repository.trim().is_empty()
    {
        return;
    }
    crate::native::warm_graph_runtime(PathBuf::from(&config.repository));
    warm_partitioner(config);
}

/// Start a single idle, no-tools RPC Partitioner for the selected repository.
/// The worker never receives a goal until a matching planning request claims
/// it; mismatched configurations continue through the normal cold path.
#[cfg(not(feature = "fixture"))]
pub fn warm_partitioner(config: Config) {
    if cfg!(test)
        || PREWARM_SHUTTING_DOWN.load(Ordering::SeqCst)
        || config.repository.trim().is_empty()
        || PiModelConfig::resolve(PiRole::Partitioner, &config)
            .model
            .trim()
            .is_empty()
    {
        return;
    }
    thread::spawn(move || {
        if let Err(error) = start_warm_partitioner(&config) {
            eprintln!("[Grapher] Partitioner prewarm unavailable: {error}");
        }
    });
}

#[cfg(not(feature = "fixture"))]
fn start_warm_partitioner(config: &Config) -> Result<(), String> {
    start_warm_partitioner_at(config, &crate::workspace::data_root())
}

#[cfg(not(feature = "fixture"))]
fn start_warm_partitioner_at(config: &Config, data: &Path) -> Result<(), String> {
    crate::workspace::validate_binding(Path::new(&config.repository))?;
    let key = partitioner_key(config)?;
    let pool = WARM_PARTITIONER.get_or_init(Default::default);
    let mut slot = pool.lock().map_err(|e| e.to_string())?;
    if PREWARM_SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Ok(());
    }
    if slot
        .as_mut()
        .is_some_and(|worker| worker.key == key && worker.child.try_wait().ok().flatten().is_none())
    {
        return Ok(());
    }
    if let Some(mut old) = slot.take() {
        old.tree.terminate();
        let _ = old.child.wait();
        let _ = fs::remove_dir_all(old.session_dir);
    }
    let session_dir = data
        .join("partition-workers")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&session_dir).map_err(|e| e.to_string())?;
    let prompt_path = session_dir.join("system-prompt.md");
    fs::write(&prompt_path, &key.3).map_err(|e| e.to_string())?;
    let mut command = crate::native::command(PiRole::Partitioner, &key.0, &key.0)?;
    command.args([
        "--mode",
        "rpc",
        "--no-prompt-templates",
        "--no-themes",
        "--no-extensions",
        "--no-skills",
        "--no-approve",
        "--no-tools",
        "--no-context-files",
        "--model",
        &key.1,
        "--thinking",
        &key.2,
        "--system-prompt",
        prompt_path
            .to_str()
            .ok_or("Invalid Partitioner prompt path")?,
        "--session-dir",
        session_dir
            .to_str()
            .ok_or("Invalid Partitioner session path")?,
    ]);
    command
        .env_remove("PI_MODEL")
        .env_remove("PI_THINKING")
        .env_remove("PI_PROVIDER")
        .env_remove("PI_REASONING_LEVEL")
        .env_remove("PI_SESSION_ID")
        .env_remove("PI_SESSION_FILE")
        .env("GRAPHER_MODE", "partition")
        .env("GRAPHER_EXECUTION_KIND", "source")
        .env("GRAPHER_SOURCE_ALIAS", &key.0)
        .env("GRAPHER_WORKSPACE_ROOT", &key.0)
        .env("GRAPHER_ORIGINAL_ROOT", &key.0);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    process_control::configure_command(&mut command);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let tree = process_control::track(&child).map_err(|error| {
        let _ = child.kill();
        let _ = child.wait();
        error
    })?;
    *slot = Some(WarmPartitioner {
        child,
        tree,
        session_dir,
        key,
    });
    Ok(())
}

#[cfg(not(feature = "fixture"))]
pub fn stop_partition_prewarm() {
    PREWARM_SHUTTING_DOWN.store(true, Ordering::SeqCst);
    invalidate_warm_partitioner();
    invalidate_warm_node();
}

#[cfg(not(feature = "fixture"))]
pub fn invalidate_warm_partitioner() {
    if let Some(pool) = WARM_PARTITIONER.get() {
        if let Ok(mut slot) = pool.lock() {
            if let Some(mut old) = slot.take() {
                old.tree.terminate();
                let _ = old.child.wait();
                let _ = fs::remove_dir_all(old.session_dir);
            }
        }
    }
}

#[cfg(not(feature = "fixture"))]
fn claim_warm_partitioner(config: &Config) -> Option<WarmPartitioner> {
    let key = partitioner_key(config).ok()?;
    let pool = WARM_PARTITIONER.get()?;
    let mut slot = pool.lock().ok()?;
    if slot.as_ref()?.key != key {
        return None;
    }
    if slot.as_mut()?.child.try_wait().ok().flatten().is_some() {
        return None;
    }
    let worker = slot.take()?;
    if process_control::assign_to_current_owner(&worker.tree).is_err() {
        *slot = Some(worker);
        return None;
    }
    Some(worker)
}

#[cfg(not(feature = "fixture"))]
fn node_session_file(session_dir: &Path, session_id: &str) -> Result<PathBuf, String> {
    let suffix = format!("_{session_id}.jsonl");
    let files: Vec<_> = fs::read_dir(session_dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(&suffix))
        .collect();
    if files.len() != 1 {
        return Err("Node session file is missing or ambiguous".into());
    }
    Ok(files[0].path())
}

#[cfg(not(feature = "fixture"))]
fn session_hash(bytes: &[u8]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

#[cfg(not(feature = "fixture"))]
fn startup_session_hash(
    before: &[u8],
    after: &[u8],
    model: &str,
    thinking: &str,
) -> Result<u64, String> {
    let appended = after
        .strip_prefix(before)
        .ok_or("Node session changed during prewarm")?;
    let changes: Vec<Value> = appended
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;
    let (provider, model_id) = model.split_once('/').unwrap_or(("", model));
    if changes.len() > 2
        || changes
            .iter()
            .enumerate()
            .any(|(index, event)| match index {
                0 => {
                    event["type"] != "model_change"
                        || event["provider"] != provider
                        || event["modelId"] != model_id
                }
                1 => event["type"] != "thinking_level_change" || event["thinkingLevel"] != thinking,
                _ => true,
            })
    {
        return Err("Node session had unexpected changes during prewarm".into());
    }
    Ok(session_hash(after))
}

#[cfg(not(feature = "fixture"))]
fn node_key(
    config: &Config,
    cwd: &Path,
    session_dir: &Path,
    session_id: &str,
) -> Result<((PathBuf, PathBuf, String, String, String, String), u64), String> {
    let repo = Path::new(&config.repository)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let cwd = cwd.canonicalize().map_err(|e| e.to_string())?;
    if cwd != repo {
        return Err("Only source-checkout nodes can be prewarmed".into());
    }
    let session_dir = session_dir.canonicalize().map_err(|e| e.to_string())?;
    let bytes =
        fs::read(node_session_file(&session_dir, session_id)?).map_err(|e| e.to_string())?;
    let model = PiModelConfig::resolve(PiRole::NodeAgent, config);
    Ok((
        (
            cwd,
            session_dir,
            session_id.into(),
            model.model,
            model.thinking.unwrap_or_default(),
            config.repository.clone(),
        ),
        session_hash(&bytes),
    ))
}

/// Keep one idle RPC node for the next turn of a completed serial conversation.
#[cfg(not(feature = "fixture"))]
pub fn warm_node(config: Config, cwd: PathBuf, session_dir: PathBuf, session_id: String) {
    if PREWARM_SHUTTING_DOWN.load(Ordering::SeqCst) {
        return;
    }
    let generation = NODE_WARM_GENERATION.load(Ordering::SeqCst);
    thread::spawn(move || {
        if let Err(error) = start_warm_node(&config, &cwd, &session_dir, &session_id, generation) {
            eprintln!("[Grapher] Node prewarm unavailable: {error}");
        }
    });
}

#[cfg(not(feature = "fixture"))]
fn start_warm_node(
    config: &Config,
    cwd: &Path,
    session_dir: &Path,
    session_id: &str,
    generation: u64,
) -> Result<(), String> {
    crate::workspace::validate_binding(Path::new(&config.repository))?;
    let (key, initial_hash) = node_key(config, cwd, session_dir, session_id)?;
    let session_file = node_session_file(&key.1, session_id)?;
    let before = fs::read(&session_file).map_err(|e| e.to_string())?;
    if session_hash(&before) != initial_hash {
        return Ok(());
    }
    let pool = WARM_NODE.get_or_init(Default::default);
    let mut slot = pool.lock().map_err(|e| e.to_string())?;
    if PREWARM_SHUTTING_DOWN.load(Ordering::SeqCst)
        || generation != NODE_WARM_GENERATION.load(Ordering::SeqCst)
    {
        return Ok(());
    }
    if slot.as_mut().is_some_and(|worker| {
        worker.key == key
            && worker.session_hash == initial_hash
            && worker.child.try_wait().ok().flatten().is_none()
    }) {
        return Ok(());
    }
    if let Some(mut old) = slot.take() {
        old.tree.terminate();
        let _ = old.child.wait();
    }
    drop(slot);
    let mut command = crate::native::command(PiRole::NodeAgent, &key.0, &key.0)?;
    command.args([
        "--mode",
        "rpc",
        "--no-prompt-templates",
        "--no-themes",
        "--approve",
        "--session-id",
        &key.2,
        "--session-dir",
        key.1.to_str().ok_or("Invalid node session path")?,
    ]);
    if !key.3.is_empty() {
        command.args(["--model", &key.3]);
    }
    if !key.4.is_empty() {
        command.args(["--thinking", &key.4]);
    }
    command
        .env_remove("PI_MODEL")
        .env_remove("PI_THINKING")
        .env_remove("PI_PROVIDER")
        .env_remove("PI_REASONING_LEVEL")
        .env_remove("PI_SESSION_ID")
        .env_remove("PI_SESSION_FILE")
        .env("GRAPHER_MODE", "node")
        .env("GRAPHER_EXECUTION_KIND", "source")
        .env("GRAPHER_SOURCE_ALIAS", &key.5)
        .env("GRAPHER_WORKSPACE_ROOT", &key.0)
        .env("GRAPHER_ORIGINAL_ROOT", &key.0);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    process_control::configure_command(&mut command);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let tree = process_control::track(&child).map_err(|error| {
        let _ = child.kill();
        let _ = child.wait();
        error
    })?;
    let probe = uuid::Uuid::new_v4().to_string();
    let stdout = child
        .stdout
        .take()
        .ok_or("Prewarmed node stdout unavailable")?;
    let (tx, rx) = mpsc::channel();
    let probe_id = probe.clone();
    thread::spawn(move || {
        let mut reader = BufReader::with_capacity(1, stdout);
        let mut startup_output = Vec::new();
        let ready = loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break Err("Prewarmed node exited before RPC was ready".to_string()),
                Err(error) => break Err(error.to_string()),
                Ok(_) => {}
            }
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                if event["id"] == probe_id {
                    break if event["success"] == true {
                        Ok(())
                    } else {
                        Err(format!("Prewarmed node rejected get_state: {event}"))
                    };
                }
            }
            startup_output.push(line);
        };
        let _ = tx.send((ready, reader.into_inner(), startup_output));
    });
    let ready = (|| -> Result<Vec<String>, String> {
        writeln!(
            child
                .stdin
                .as_mut()
                .ok_or("Prewarmed node stdin unavailable")?,
            "{}",
            serde_json::json!({"id": probe, "type": "get_state"})
        )
        .map_err(|e| e.to_string())?;
        child
            .stdin
            .as_mut()
            .unwrap()
            .flush()
            .map_err(|e| e.to_string())?;
        let (result, stdout, startup_output) = rx
            .recv_timeout(Duration::from_secs(30))
            .map_err(|e| format!("Prewarmed node readiness timed out: {e}"))?;
        child.stdout = Some(stdout);
        result?;
        Ok(startup_output)
    })();
    let startup_output = match ready {
        Ok(output) => output,
        Err(error) => {
            tree.terminate();
            let _ = child.wait();
            return Err(error);
        }
    };
    let ready_hash = fs::read(&session_file)
        .map_err(|e| e.to_string())
        .and_then(|after| startup_session_hash(&before, &after, &key.3, &key.4));
    let session_hash = match ready_hash {
        Ok(hash) => hash,
        Err(error) => {
            tree.terminate();
            let _ = child.wait();
            return Err(error);
        }
    };
    let pool = WARM_NODE.get_or_init(Default::default);
    let mut slot = pool.lock().map_err(|e| e.to_string())?;
    if generation != NODE_WARM_GENERATION.load(Ordering::SeqCst) {
        tree.terminate();
        let _ = child.wait();
        return Ok(());
    }
    if let Some(mut old) = slot.take() {
        old.tree.terminate();
        let _ = old.child.wait();
    }
    *slot = Some(WarmNode {
        child,
        tree,
        key,
        session_hash,
        startup_output,
    });
    Ok(())
}

#[cfg(not(feature = "fixture"))]
pub fn invalidate_warm_node() {
    NODE_WARM_GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Some(pool) = WARM_NODE.get() {
        if let Ok(mut slot) = pool.lock() {
            if let Some(mut old) = slot.take() {
                old.tree.terminate();
                let _ = old.child.wait();
            }
        }
    }
}

#[cfg(not(feature = "fixture"))]
fn claim_warm_node(
    config: &Config,
    cwd: &Path,
    session_dir: &Path,
    session_id: &str,
) -> Option<WarmNode> {
    let (key, hash) = node_key(config, cwd, session_dir, session_id).ok()?;
    let pool = WARM_NODE.get()?;
    let mut slot = pool.lock().ok()?;
    let worker = slot.as_mut()?;
    if worker.key != key {
        return None;
    }
    if worker.session_hash != hash || worker.child.try_wait().ok().flatten().is_some() {
        let mut old = slot.take()?;
        old.tree.terminate();
        let _ = old.child.wait();
        return None;
    }
    let worker = slot.take()?;
    if process_control::assign_to_current_owner(&worker.tree).is_err() {
        *slot = Some(worker);
        return None;
    }
    Some(worker)
}

#[derive(Clone)]
struct NodeRpc {
    sender: mpsc::Sender<String>,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Result<(), String>>>>>,
    revision_run_id: Option<String>,
    run_id: Option<String>,
}
static NODE_RPC: OnceLock<Mutex<HashMap<String, NodeRpc>>> = OnceLock::new();

/// A legacy unscoped RPC request is only safe if exactly one Planner exists.
fn sole_planner() -> Result<(String, NodeRpc), String> {
    let rpc = NODE_RPC
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    let mut planners = rpc.iter().filter(|(id, _)| id.starts_with("planner:"));
    let (id, planner) = planners
        .next()
        .ok_or("Planner is no longer accepting messages")?;
    if planners.next().is_some() {
        return Err("Multiple Planners are running; provide a Run ID".into());
    }
    Ok((id.clone(), planner.clone()))
}

pub fn planner_revision_run_id() -> Result<Option<String>, String> {
    Ok(sole_planner()?.1.revision_run_id)
}

pub fn planner_revision_run_id_for_run(run_id: &str) -> Result<Option<String>, String> {
    let rpc = NODE_RPC
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    rpc.iter()
        .find(|(id, planner)| {
            id.starts_with("planner:") && planner.run_id.as_deref() == Some(run_id)
        })
        .map(|(_, planner)| planner.revision_run_id.clone())
        .ok_or("Planner is no longer accepting messages".into())
}

pub fn steer_planner(
    instruction: &str,
    images: Option<Vec<crate::model::ImageAttachment>>,
) -> Result<(), String> {
    steer(&sole_planner()?.0, instruction, images)
}

pub fn steer_planner_for_run(
    run_id: &str,
    instruction: &str,
    images: Option<Vec<crate::model::ImageAttachment>>,
) -> Result<(), String> {
    let rpc = NODE_RPC
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    let id = rpc
        .iter()
        .find(|(id, planner)| {
            id.starts_with("planner:") && planner.run_id.as_deref() == Some(run_id)
        })
        .map(|(id, _)| id.clone())
        .ok_or("Planner is no longer accepting messages")?;
    drop(rpc);
    steer(&id, instruction, images)
}

/// Acknowledged by Pi's RPC protocol, not merely by a successful pipe write.
pub fn steer(
    execution_id: &str,
    instruction: &str,
    images: Option<Vec<crate::model::ImageAttachment>>,
) -> Result<(), String> {
    let rpc = NODE_RPC
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?
        .get(execution_id)
        .cloned()
        .ok_or("Node execution is no longer accepting messages")?;
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    rpc.pending
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), tx);
    let mut command_val = serde_json::json!({"id": id, "type": "prompt", "message": instruction, "streamingBehavior": "steer"});
    if let Some(imgs) = images {
        if !imgs.is_empty() {
            command_val["images"] = serde_json::json!(imgs);
        }
    }
    let command = command_val.to_string();
    if rpc.sender.send(command).is_err() {
        rpc.pending.lock().map_err(|e| e.to_string())?.remove(&id);
        return Err("Node RPC input closed".into());
    }
    let result = rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "Node did not acknowledge the steer request".to_string());
    rpc.pending.lock().map_err(|e| e.to_string())?.remove(&id);
    result?
}

struct NodeRpcGuard(String);
impl Drop for NodeRpcGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = NODE_RPC.get_or_init(Default::default).lock() {
            map.remove(&self.0);
        }
    }
}

struct ProcessGuard(process_control::ProcessTree);

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        self.0.terminate();
    }
}

pub fn terminate_all() {
    process_control::terminate_all();
}

pub fn terminate_run(run_id: &str) {
    process_control::terminate_owner(run_id);
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
        let key = match role {
            PiRole::Partitioner => "partitioner",
            PiRole::Planner => "planner",
            // Merger is also a Pi Instance and follows Node Agent settings
            // unless MERGER_MODEL / MERGER_THINKING explicitly override them.
            PiRole::NodeAgent | PiRole::Merger => "nodeAgent",
        };
        let settings = base_config.role_models.get(key);
        let model = std::env::var(role.model_env_var())
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| settings.map(|value| value.model.clone()).filter(|value| !value.trim().is_empty()))
            .unwrap_or_else(|| base_config.model.clone());
        let thinking = std::env::var(role.thinking_env_var())
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| settings.and_then(|value| value.thinking_level.clone()))
            .unwrap_or_else(|| {
                if role == PiRole::Partitioner {
                    "off".into()
                } else {
                    base_config.thinking_level.clone()
                }
            });
        Self { model: model.trim().into(), thinking: Some(thinking) }
    }

    pub fn effective_config(&self, base_config: &Config) -> Config {
        let mut cfg = base_config.clone();
        cfg.model = self.model.clone();
        cfg
    }
}

/// Parses the model text output to determine whether it chose "parallel" or "serial".
/// Maps "parallel" to the internal "graph" execution mode.
/// If ambiguous, missing, or model hallucinated, defaults safely to "serial".
pub fn parse_route_decision(text: &str) -> Route {
    let trimmed = text.trim();
    let lower = trimmed.to_lowercase();

    // 1. Direct single-word match (ignoring whitespace and surrounding punctuation)
    let clean_single = lower.trim_matches(|c: char| !c.is_alphanumeric());
    if clean_single == "parallel" {
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
        if line_clean == "parallel" {
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
        let line_g = tokens.contains(&"parallel");
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
            let after_g = after_tokens.contains(&"parallel");
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
    let total_g = all_tokens.contains(&"parallel");
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
            .match_indices("parallel")
            .filter_map(|(idx, _)| {
                let before = lower[..idx].chars().next_back();
                let after = lower[idx + "parallel".len()..].chars().next();
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
    /// Appended to Pi's default prompt for Merger; replaces it for other roles.
    pub system_prompt: Option<&'request str>,
    pub images: Option<&'request [crate::model::ImageAttachment]>,
}

pub fn clean_model_error(error: &str) -> String {
    let trimmed = error.trim();
    if let Some((code, rest)) = trimmed.split_once(':') {
        let rest = rest.trim();
        let code_clean = code.trim();
        if !code_clean.contains('{') && !code_clean.contains('"') {
            if let Ok(value) = serde_json::from_str::<Value>(rest) {
                let extracted = value
                    .get("message")
                    .and_then(|m| m.as_str())
                    .or_else(|| {
                        value.get("error").and_then(|e| {
                            e.get("message")
                                .and_then(|m| m.as_str())
                                .or_else(|| e.as_str())
                        })
                    });
                if let Some(msg) = extracted {
                    return format!("{}: {}", code_clean, msg.trim());
                }
            }
        }
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        let extracted = value
            .get("message")
            .and_then(|m| m.as_str())
            .or_else(|| {
                value.get("error").and_then(|e| {
                    e.get("message")
                        .and_then(|m| m.as_str())
                        .or_else(|| e.as_str())
                })
            });
        if let Some(msg) = extracted {
            return msg.trim().to_string();
        }
    }
    trimmed.to_string()
}

pub fn run_pi(request: PiRequest<'_>, on_output: impl FnMut(String)) -> Result<String, String> {
    // All roles run until completion or explicit cancellation.
    run_pi_with_timeout(request, on_output, None)
}

fn run_pi_with_timeout(
    request: PiRequest<'_>,
    mut on_output: impl FnMut(String),
    timeout: Option<Duration>,
) -> Result<String, String> {
    let phase = request.role.name();
    let config = request.config;
    #[cfg(not(feature = "fixture"))]
    crate::workspace::validate_binding(Path::new(&config.repository))?;
    fs::create_dir_all(request.session_dir).map_err(|error| error.to_string())?;
    // Production always runs the pinned, Grapher-owned entrypoint. Persisted
    // legacy command fields cannot select a different engine implementation.
    #[cfg(not(feature = "fixture"))]
    let mut command = crate::native::execution_command(
        request.role,
        Path::new(&config.repository),
        request.cwd,
        &crate::workspace::data_root(),
        request.session_dir,
    )?;
    // Process substitution is exclusively a test capability.
    #[cfg(feature = "fixture")]
    let mut command = {
        #[cfg(windows)]
        let executable = if config.pi_command == "/bin/sh" {
            // Fixture shell scripts need Git for Windows' sh.exe. The POSIX
            // /bin/sh path is not a Windows executable path, even in Git Bash.
            let output = Command::new("git")
                .arg("--exec-path")
                .output()
                .map_err(|error| format!("Cannot locate Git for Windows shell: {error}"))?;
            if !output.status.success() {
                return Err("Cannot locate Git for Windows shell".into());
            }
            let exec_dir = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
            let root = exec_dir
                .ancestors()
                .nth(3)
                .ok_or("Invalid Git for Windows install path")?;
            let shell = root.join("bin/sh.exe");
            if !shell.is_file() {
                return Err(format!(
                    "Git for Windows shell is missing: {}",
                    shell.display()
                ));
            }
            shell
        } else {
            PathBuf::from(&config.pi_command)
        };
        #[cfg(not(windows))]
        let executable = &config.pi_command;
        let mut command = Command::new(executable);
        command.args(&config.pi_args);
        command
    };
    // Fixture tests opt in with an explicit marker; existing print-mode fixtures
    // retain their original protocol.
    // RPC's stdin-EOF shutdown exits promptly after agent_settled. Print mode
    // can keep Node's provider handles alive for seconds after the route text.
    let rpc_agent = (request.role == PiRole::NodeAgent
        || request.role == PiRole::Planner
        || request.role == PiRole::Partitioner)
        && (!cfg!(feature = "fixture")
            || request
                .environment
                .iter()
                .any(|(key, value)| *key == "GRAPHER_TEST_NODE_RPC" && value == "1"));
    command.args([
        "--mode",
        if rpc_agent { "rpc" } else { "json" },
        "--no-prompt-templates",
        "--no-themes",
    ]);
    if !rpc_agent {
        command.arg("--print");
    }
    if request.role == PiRole::NodeAgent {
        command.arg("--approve");
    } else if request.role == PiRole::Planner {
        command.arg("--no-approve");
    } else {
        command.args(["--no-extensions", "--no-skills", "--no-approve"]);
    }
    // An allowlist would also hide tools contributed by user extensions/MCP.
    // Retain the Planner's read/bash base while allowing extension tools.
    if request.role == PiRole::Planner {
        command.args(["--exclude-tools", "edit,write,ls,find,grep"]);
    }
    match request.tools {
        Some(tools) if tools.trim().is_empty() => {
            command.arg("--no-tools");
        }
        Some(tools) if request.role != PiRole::Planner => {
            command.args(["--tools", tools]);
        }
        _ => {}
    }
    if let Some(_extension) = request.extension {
        #[cfg(feature = "fixture")]
        let extension = _extension.to_str().ok_or("Invalid extension path")?;
        #[cfg(not(feature = "fixture"))]
        let extension_path = {
            if request.role != PiRole::Planner {
                return Err("Only the Grapher-owned Planner extension may be injected".into());
            }
            crate::native::installation_root().join("backend/resources/planner.ts")
        };
        #[cfg(not(feature = "fixture"))]
        let extension = extension_path
            .to_str()
            .ok_or("Invalid Planner extension path")?;
        command.args(["--extension", extension, "--no-context-files"]);
    }
    if !config.model.trim().is_empty() {
        command.args(["--model", config.model.as_str()]);
    }
    if let Some(session_id) = request.session_id {
        command.args(["--session-id", session_id]);
    }
    if !request.extra_args.is_empty() {
        command.args(&request.extra_args);
    }
    if request.role == PiRole::Partitioner
        && !request.extra_args.iter().any(|arg| *arg == "--thinking")
    {
        command.args(["--thinking", "off"]);
    }
    if let Some(system_prompt) = request.system_prompt {
        let prompt_path = if Path::new(system_prompt).is_file() {
            PathBuf::from(system_prompt)
        } else {
            let path = request.session_dir.join("system-prompt.md");
            fs::write(&path, system_prompt).map_err(|error| error.to_string())?;
            path
        };
        command.arg(if request.role == PiRole::Merger {
            "--append-system-prompt"
        } else {
            "--system-prompt"
        }).arg(crate::native::host_path(&prompt_path));
    }
    let session_dir = request.session_dir;
    command
        .arg("--session-dir")
        .arg(crate::native::host_path(session_dir))
        .current_dir(crate::native::host_path(request.cwd))
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
    crate::native::clear_git_environment(&mut command);
    for (key, value) in &request.environment {
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
    #[cfg(not(feature = "fixture"))]
    {
        let graph = request.cwd.canonicalize().map_err(|e| e.to_string())?
            != Path::new(&config.repository)
                .canonicalize()
                .map_err(|e| e.to_string())?;
        command.env(
            "GRAPHER_EXECUTION_KIND",
            if graph { "graph" } else { "source" },
        );
        command.env("GRAPHER_SOURCE_ALIAS", &config.repository);
    }
    command.env(
        "GRAPHER_WORKSPACE_ROOT",
        request
            .cwd
            .canonicalize()
            .map_err(|error| error.to_string())?,
    );
    command.env(
        "GRAPHER_ORIGINAL_ROOT",
        Path::new(if config.repository.trim().is_empty() {
            request.cwd.as_os_str()
        } else {
            config.repository.as_ref()
        })
        .canonicalize()
        .map_err(|error| error.to_string())?,
    );
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    process_control::configure_command(&mut command);
    let started = Instant::now();
    #[cfg(not(feature = "fixture"))]
    let warm_compatible = request.role == PiRole::Partitioner
        && request.tools == Some("")
        && request.extension.is_none()
        && request.session_id.is_none()
        && request.images.is_none_or(<[_]>::is_empty)
        // In particular, @image attachments require the per-request CLI args.
        && request.extra_args.iter().all(|arg| matches!(
            *arg, "--no-tools" | "--no-context-files" | "--thinking" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
        ))
        && request.environment.iter().all(|(key, _)| {
            matches!(*key, "GRAPHER_MODE" | "GRAPHER_GRAPH_PATH")
        });
    #[cfg(not(feature = "fixture"))]
    let warm = warm_compatible
        .then(|| claim_warm_partitioner(config))
        .flatten();
    #[cfg(not(feature = "fixture"))]
    let warm_node = (request.role == PiRole::NodeAgent
        && request.extension.is_none()
        && request.tools.is_none()
        && request.system_prompt.is_none()
        && request.session_id.is_some()
        && request.extra_args.iter().all(|arg| {
            matches!(
                *arg,
                "--thinking" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
            )
        }))
    .then(|| {
        claim_warm_node(
            config,
            request.cwd,
            request.session_dir,
            request.session_id.unwrap(),
        )
    })
        .flatten();
    #[cfg(not(feature = "fixture"))]
    if request.role == PiRole::NodeAgent {
        invalidate_warm_node();
    }
    #[cfg(not(feature = "fixture"))]
    let warm_startup_output = warm_node
        .as_ref()
        .map(|worker| worker.startup_output.clone())
        .unwrap_or_default();
    #[cfg(not(feature = "fixture"))]
    let prewarmed = warm.is_some() || warm_node.is_some();
    #[cfg(not(feature = "fixture"))]
    let warm_session = warm.as_ref().map(|worker| worker.session_dir.clone());
    #[cfg(not(feature = "fixture"))]
    let (mut child, process_tree) = if let Some(worker) = warm_node {
        (worker.child, worker.tree)
    } else if let Some(worker) = warm {
        (worker.child, worker.tree)
    } else {
        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot start Execution Instance Engine: {error}"))?;
        let tree = process_control::track(&child).map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            error
        })?;
        (child, tree)
    };
    #[cfg(feature = "fixture")]
    let (mut child, process_tree) = {
        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot start Execution Instance Engine: {error}"))?;
        let tree = process_control::track(&child).map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            error
        })?;
        (child, tree)
    };
    let _guard = ProcessGuard(process_tree.clone());
    #[cfg(feature = "fixture")]
    let prewarmed = false;
    on_output(format!(
        "{}\n",
        serde_json::json!({"type":"grapher_process_started", "pid":child.id(), "sessionId":request.session_id, "cwd":request.cwd, "prewarmed":prewarmed, "timestamp":crate::model::now()})
    ));
    #[cfg(not(feature = "fixture"))]
    for line in warm_startup_output {
        on_output(line);
    }
    let mut stdin = child.stdin.take().ok_or("Pi stdin unavailable")?;
    let (input_sender, input_receiver) = mpsc::channel::<Result<(), std::io::Error>>();
    let mut rpc_sender = None;
    let mut rpc_guard = None;
    let mut rpc_pending = None;
    let initial_rpc_id = uuid::Uuid::new_v4().to_string();
    if rpc_agent {
        let run_id = if request.role == PiRole::Planner {
            request
                .environment
                .iter()
                .find(|(key, _)| *key == "GRAPHER_ACTIVE_RUN_ID")
                .map(|(_, id)| id.clone())
                .filter(|id| !id.is_empty())
        } else {
            None
        };
        let id = if request.role == PiRole::Planner {
            // Manual Graph revisions keep their session at planner-sessions/<runId>;
            // its parent name is shared by every Run. Use the Run ID, or the
            // full session path when called without one (e.g. fixture tests).
            let identity = run_id
                .clone()
                .unwrap_or_else(|| request.session_dir.to_string_lossy().into_owned());
            format!("planner:{identity}")
        } else if request.role == PiRole::Partitioner {
            format!("partition:{}", request.session_dir.display())
        } else {
            request
                .environment
                .iter()
                .find(|(key, _)| *key == "GRAPHER_NODE_EXECUTION_ID")
                .map(|(_, value)| value.clone())
                .or_else(|| {
                    request
                        .session_dir
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                })
                .ok_or("Missing execution identity")?
        };
        let (tx, rx) = mpsc::channel::<String>();
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let revision_run_id = if request.role == PiRole::Planner {
            request
                .environment
                .iter()
                .find(|(key, _)| *key == "GRAPHER_PLANNER_RUN_ID")
                .map(|(_, id)| id.clone())
                .filter(|id| !id.is_empty())
        } else {
            None
        };
        NODE_RPC
            .get_or_init(Default::default)
            .lock()
            .map_err(|e| e.to_string())?
            .insert(
                id.clone(),
                NodeRpc {
                    sender: tx.clone(),
                    pending: pending.clone(),
                    revision_run_id,
                    run_id,
                },
            );
        rpc_guard = Some(NodeRpcGuard(id));
        rpc_pending = Some(pending);
        let mut initial_val =
            serde_json::json!({"id": initial_rpc_id, "type": "prompt", "message": request.task});
        if let Some(imgs) = request.images {
            if !imgs.is_empty() {
                initial_val["images"] = serde_json::json!(imgs);
            }
        }
        let initial = initial_val.to_string();
        tx.send(initial).map_err(|e| e.to_string())?;
        rpc_sender = Some(tx);
        thread::spawn(move || {
            for command in rx {
                if let Err(error) = writeln!(stdin, "{command}").and_then(|_| stdin.flush()) {
                    let _ = input_sender.send(Err(error));
                    break;
                }
            }
            // Closing stdin asks RPC Pi to shut down cleanly after agent_end.
        });
    } else {
        let task = request.task.as_bytes().to_vec();
        // Large tasks can fill the pipe before an unresponsive child reads stdin.
        thread::spawn(move || {
            let _ = input_sender.send(stdin.write_all(&task));
        });
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
    let mut input_error = None;
    let mut final_text = String::new();
    let mut agent_error = None;
    let mut stderr_tail = String::new();
    let mut stderr_lines = Vec::<String>::new();
    let mut raw_stdout_lines = Vec::<String>::new();
    let mut exited_at = None;
    let mut timed_out = false;
    let mut agent_ended = None::<Instant>;
    loop {
        // Planners/nodes need a steer handoff window. The Partitioner has no
        // follow-up commands, so close RPC stdin as soon as its turn settles.
        let handoff = if request.role == PiRole::Partitioner {
            Duration::ZERO
        } else {
            Duration::from_millis(500)
        };
        if rpc_agent && agent_ended.is_some_and(|t| t.elapsed() > handoff) {
            let pending_empty = rpc_pending
                .as_ref()
                .is_some_and(|p| p.lock().is_ok_and(|p| p.is_empty()));
            if pending_empty {
                break;
            }
        }
        // Check even while output is arriving: a noisy child can also hang.
        if timeout.is_some_and(|limit| started.elapsed() >= limit) {
            timed_out = true;
            process_tree.terminate();
            let _ = child.kill();
            break;
        }
        if let Ok(Err(error)) = input_receiver.try_recv() {
            input_error = Some(error);
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok((is_error, line)) => {
                if is_error {
                    if line.contains("No project session found with id")
                        && line.contains("creating a new session with that id")
                    {
                        continue;
                    }
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        stderr_lines.push(trimmed.to_string());
                    }
                    stderr_tail = line.clone();
                    on_output(format!("[stderr] {line}\n"));
                    continue;
                }
                let mut event = serde_json::from_str::<Value>(&line).ok();
                if event.is_none() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        raw_stdout_lines.push(trimmed.to_string());
                    }
                }
                if let Some(event) = event.as_ref() {
                    match event["type"].as_str().unwrap_or_default() {
                        "agent_start" | "turn_start" if rpc_agent => agent_ended = None,
                        "agent_settled" if rpc_agent => agent_ended = Some(Instant::now()),
                        "response" if rpc_agent => {
                            if event["id"].as_str() == Some(initial_rpc_id.as_str())
                                && event["success"] == false
                            {
                                agent_error = Some(
                                    event["error"]
                                        .as_str()
                                        .unwrap_or("Pi rejected the initial prompt")
                                        .to_string(),
                                );
                                agent_ended = Some(Instant::now());
                            }
                            if let (Some(id), Some(pending)) = (event["id"].as_str(), &rpc_pending)
                            {
                                if let Ok(mut pending) = pending.lock() {
                                    if let Some(reply) = pending.remove(id) {
                                        let result = if event["success"] == true {
                                            Ok(())
                                        } else {
                                            Err(event["error"]
                                                .as_str()
                                                .unwrap_or("Pi rejected steer")
                                                .to_string())
                                        };
                                        // Acceptance can precede the next turn_start. Do not
                                        // exit on an earlier agent_settled and drop this turn.
                                        if result.is_ok() {
                                            agent_ended = None;
                                        }
                                        let _ = reply.send(result);
                                    }
                                }
                            }
                        }
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
                        "turn_end" => {
                            if agent_error.is_none() {
                                if let Some(err) = event["message"]["errorMessage"].as_str() {
                                    agent_error = Some(err.to_string());
                                }
                            }
                        }
                        "agent_end" => {
                            if agent_error.is_none() {
                                if let Some(messages) = event["messages"].as_array() {
                                    for msg in messages.iter().rev() {
                                        if let Some(err) = msg["errorMessage"].as_str() {
                                            agent_error = Some(err.to_string());
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        "error" => {
                            let msg = event["error"]["message"]
                                .as_str()
                                .or_else(|| event["error"].as_str())
                                .or_else(|| event["message"].as_str())
                                .unwrap_or("Pi encountered an error");
                            agent_error = Some(msg.to_string());
                        }
                        _ => {}
                    }
                }
                if let Some(object) = event.as_mut().and_then(Value::as_object_mut) {
                    object.insert("grapherReceivedAt".into(), crate::model::now().into());
                }
                let mut output = if let Some(event) = event {
                    serde_json::to_string(&event).map_err(|error| error.to_string())?
                } else {
                    line
                };
                output.push('\n');
                on_output(output);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_some()
                {
                    break;
                }
                // A child may close its pipes and keep running. Keep the deadline
                // active instead of blocking indefinitely in wait().
                thread::sleep(Duration::from_millis(10));
            }
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
    // Do not hold the input pipe open after the final agent turn.
    drop(rpc_guard);
    drop(rpc_sender);
    let status = child.wait().map_err(|error| error.to_string())?;
    while let Ok(Err(error)) = input_receiver.try_recv() {
        if input_error.is_none() {
            input_error = Some(error);
        }
    }
    #[cfg(not(feature = "fixture"))]
    let copied_session = if let Some(warm_dir) = warm_session {
        // Keep the per-attempt Pi conversation alongside partition.jsonl even
        // when its process was started before the planning ID existed.
        let copied = (|| -> Result<(), String> {
            for entry in fs::read_dir(&warm_dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.path().extension().is_some_and(|ext| ext == "jsonl") {
                    fs::copy(entry.path(), request.session_dir.join(entry.file_name()))
                        .map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        })();
        if copied.is_ok() {
            let _ = fs::remove_dir_all(&warm_dir);
        }
        copied
    } else {
        Ok(())
    };
    #[cfg(not(feature = "fixture"))]
    if request.role == PiRole::Partitioner {
        warm_partitioner(config.clone());
    }
    // If the process completed successfully and emitted valid assistant text,
    // a BrokenPipe on writing stdin simply indicates that the process finished
    // its work and closed its stdin pipe early.
    let input_broken_pipe_on_success = input_error
        .as_ref()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::BrokenPipe && status.success() && !final_text.trim().is_empty());
    // ProcessGuard clears the process group. Detached descendants are not
    // guaranteed to be covered; tasks must finish background work before returning.
    on_output(format!(
        "{}\n",
        serde_json::json!({"type":"grapher_process_exited", "pid":child.id(), "code":status.code(), "success":status.success() && !timed_out && (input_error.is_none() || input_broken_pipe_on_success), "timedOut":timed_out, "phase":phase, "elapsedMs":started.elapsed().as_millis(), "timestamp":crate::model::now()})
    ));
    #[cfg(not(feature = "fixture"))]
    copied_session?;
    if timed_out {
        return Err(format!(
            "{phase} timed out after {} seconds",
            timeout.expect("timed out with a deadline").as_secs_f64()
        ));
    }
    if let Some(error) = agent_error {
        return Err(clean_model_error(&error));
    }
    if !status.success() {
        let stderr_summary = if !stderr_tail.trim().is_empty() {
            stderr_tail.trim().to_string()
        } else {
            stderr_lines
                .iter()
                .rev()
                .find(|l| !l.trim().is_empty())
                .cloned()
                .unwrap_or_default()
        };
        let tail = if !stderr_summary.is_empty() {
            stderr_summary
        } else {
            raw_stdout_lines
                .iter()
                .rev()
                .find(|l| !l.trim().is_empty())
                .cloned()
                .unwrap_or_default()
        };
        return Err(if tail.is_empty() {
            format!("Pi exited with {status}")
        } else {
            format!("Pi exited with {status}: {tail}")
        });
    }
    if let Some(error) = input_error {
        if !input_broken_pipe_on_success {
            return Err(format!("Cannot send task to {phase}: {error}"));
        }
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
    resume_execution_id: Option<&str>,
    images: Option<&[crate::model::ImageAttachment]>,
    root: &Path,
    on_output: impl FnMut(String),
) -> Result<String, String> {
    #[cfg(feature = "fixture")]
    if config.engine == crate::fixture::ENGINE {
        return crate::fixture::execute(execution, task, feedback_source, on_output);
    }
    let task = if feedback_source {
        format!("{task}\n\nEnd your response with exactly one standalone final line:\n<ACCEPT>\nor\n<FEEDBACK>\nIf sending <FEEDBACK>, clearly describe the additional instruction for the target before the marker.")
    } else {
        task.into()
    };
    let session_dir = root
        .join("sessions")
        .join(resume_execution_id.unwrap_or(&execution.id));
    if resume_execution_id.is_some() && !cfg!(feature = "fixture") {
        let suffix = format!("_{}.jsonl", execution.session_id);
        let found = fs::read_dir(&session_dir)
            .map_err(|error| format!("Cannot resume node session: {error}"))?
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().ends_with(&suffix));
        if !found {
            return Err("Cannot resume node session: persisted Pi conversation is missing".into());
        }
    }
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
            environment: vec![
                ("GRAPHER_MODE", "node".into()),
                ("GRAPHER_NODE_EXECUTION_ID", execution.id.clone()),
            ],
            system_prompt: None,
            images,
        },
        on_output,
    )
}

pub fn feedback(output: &str) -> Result<bool, String> {
    match output.trim().lines().last().map(str::trim) {
        Some("<ACCEPT>") => Ok(false),
        Some("<FEEDBACK>") => Ok(true),
        _ => Err("Feedback protocol error: final line must be exactly <ACCEPT> or <FEEDBACK>".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(feature = "fixture")]
    fn test_python() -> String {
        #[cfg(windows)]
        {
            // Windows' python3.exe on PATH may be the Microsoft Store alias.
            for (program, launcher_args) in [
                ("py", &["-3"][..]),
                ("python", &[][..]),
                ("python3", &[][..]),
            ] {
                if let Ok(output) = std::process::Command::new(program)
                    .args(launcher_args)
                    .args(["-c", "import sys; print(sys.executable)"])
                    .env("PYTHONIOENCODING", "utf-8")
                    .output()
                {
                    if output.status.success() {
                        return String::from_utf8_lossy(&output.stdout).trim().into();
                    }
                }
            }
            panic!("Python 3 is required to run Pi fixture tests on Windows");
        }
        #[cfg(not(windows))]
        {
            "python3".into()
        }
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn feedback_source_prompt_uses_generic_feedback_marker() {
        let _guard = lock_env();
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("capture_task.py");
        fs::write(&script, r#"import json, sys
text = sys.stdin.read()
print(json.dumps({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':text}]}}), flush=True)
"#).unwrap();
        let config = Config {
            engine: "pi".into(),
            pi_command: test_python(),
            pi_args: vec!["-u".into(), script.to_string_lossy().into_owned()],
            repository: temp.path().to_string_lossy().into(),
            model: "mock/model".into(),
            thinking_level: "medium".into(),
            max_parallel: 1,
            max_feedback: 3,
            auto_approve: false,
            role_models: Default::default(),
        };
        let execution = Execution {
            id: "feedback-prompt".into(), node: "review".into(), revision: 1, attempt: 1,
            session_id: "feedback-prompt".into(), worktree: temp.path().to_string_lossy().into(),
            before: String::new(), after: None, status: "running".into(),
            output: String::new(), output_bytes: 0, pid: None, started_at: 0,
            completed_at: None, metrics: None,
        };
        let task = "Inspect the result";
        for feedback_source in [false, true] {
            let captured = execute(&config, &execution, task, feedback_source, None, None, temp.path(), |_| {}).unwrap();
            if feedback_source {
                assert_eq!(captured, format!("{task}\n\nEnd your response with exactly one standalone final line:\n<ACCEPT>\nor\n<FEEDBACK>\nIf sending <FEEDBACK>, clearly describe the additional instruction for the target before the marker."));
            } else {
                assert_eq!(captured, task);
            }
        }
    }

    #[cfg(not(feature = "fixture"))]
    #[test]
    fn prestarted_partitioner_is_claimed_by_matching_repository_and_exits_on_eof() {
        let _guard = lock_env();
        invalidate_warm_partitioner();
        let temp = tempfile::tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let config = Config {
            repository: repository.to_string_lossy().into(),
            model: "openai-codex/gpt-6-sol".into(),
            thinking_level: "high".into(),
            max_parallel: 1,
            max_feedback: 0,
            auto_approve: false,
            role_models: Default::default(),
        };
        start_warm_partitioner_at(&config, temp.path()).unwrap();
        let mut other = config.clone();
        other.model = "other/model".into();
        assert!(claim_warm_partitioner(&other).is_none());
        let mut worker =
            process_control::with_owner("prewarm-test", || claim_warm_partitioner(&config))
            .expect("matching idle worker");
        assert!(claim_warm_partitioner(&config).is_none());
        let mut stdin = worker.child.stdin.take().unwrap();
        writeln!(
            stdin,
            "{}",
            serde_json::json!({"id":"probe", "type":"get_state"})
        )
        .unwrap();
        stdin.flush().unwrap();
        let mut stdout = BufReader::new(worker.child.stdout.take().unwrap());
        let response = (&mut stdout)
            .lines()
            .map(|line| serde_json::from_str::<Value>(&line.unwrap()).unwrap())
            .find(|event| event["id"] == "probe")
            .unwrap();
        assert_eq!(response["success"], true);
        assert_eq!(response["data"]["thinkingLevel"], "off");
        drop(stdin);
        use std::io::Read;
        let mut tail = String::new();
        stdout.read_to_string(&mut tail).unwrap();
        let status = worker.child.wait().unwrap();
        let mut stderr = String::new();
        worker
            .child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert!(status.success(), "{status}: {stderr}");
        let _ = fs::remove_dir_all(worker.session_dir);
    }

    #[cfg(not(feature = "fixture"))]
    #[test]
    #[ignore = "requires an isolated real Pi process and warm-node slot"]
    fn serial_node_prewarm_reuses_session_and_rejects_modified_history() {
        use std::io::Read;
        let temp = tempfile::tempdir().unwrap();
        invalidate_warm_node();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let session_dir = temp.path().join("sessions");
        fs::create_dir(&session_dir).unwrap();
        let session_id = uuid::Uuid::new_v4().to_string();
        let session_file = session_dir.join(format!("2026-01-01T00-00-00-000Z_{session_id}.jsonl"));
        fs::write(&session_file, format!("{}\n{}\n{}\n",
            serde_json::json!({
                "type": "session", "version": 3, "id": session_id,
                "timestamp": "2026-01-01T00:00:00.000Z", "cwd": repository,
            }),
            serde_json::json!({"type":"model_change", "id":"model-1", "parentId":null,
                "timestamp":"2026-01-01T00:00:01.000Z", "provider":"openai-codex", "modelId":"gpt-6-sol"}),
            serde_json::json!({"type":"thinking_level_change", "id":"thinking-1", "parentId":"model-1",
                "timestamp":"2026-01-01T00:00:02.000Z", "thinkingLevel":"high"}),
        )).unwrap();
        let config = Config {
            repository: repository.to_string_lossy().into(),
            model: "openai-codex/gpt-6-sol".into(),
            thinking_level: "high".into(),
            max_parallel: 1,
            max_feedback: 0,
            auto_approve: false,
            role_models: Default::default(),
        };
        let generation = NODE_WARM_GENERATION.load(Ordering::SeqCst);
        start_warm_node(&config, &repository, &session_dir, &session_id, generation).unwrap();
        let mut other = config.clone();
        other.model = "other/model".into();
        assert!(claim_warm_node(&other, &repository, &session_dir, &session_id).is_none());
        let mut worker = process_control::with_owner("warm-node-test", || {
            claim_warm_node(&config, &repository, &session_dir, &session_id)
        })
        .unwrap();
        let mut stdin = worker.child.stdin.take().unwrap();
        writeln!(
            stdin,
            "{}",
            serde_json::json!({"id":"probe", "type":"get_state"})
        )
        .unwrap();
        stdin.flush().unwrap();
        let mut stdout = BufReader::new(worker.child.stdout.take().unwrap());
        let response = (&mut stdout)
            .lines()
            .map(|line| serde_json::from_str::<Value>(&line.unwrap()).unwrap())
            .find(|event| event["id"] == "probe")
            .unwrap();
        assert_eq!(response["success"], true);
        drop(stdin);
        stdout.read_to_string(&mut String::new()).unwrap();
        let status = worker.child.wait().unwrap();
        let mut stderr = String::new();
        worker
            .child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert!(status.success(), "{status}: {stderr}");

        start_warm_node(&config, &repository, &session_dir, &session_id, generation).unwrap();
        fs::write(
            &session_file,
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "session", "version": 3, "id": session_id,
                    "timestamp": "2026-01-02T00:00:00.000Z", "cwd": repository,
                })
            ),
        )
        .unwrap();
        assert!(claim_warm_node(&config, &repository, &session_dir, &session_id).is_none());
        invalidate_warm_node();
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn partitioner_rpc_closes_after_final_turn_without_waiting_for_print_mode() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("partition_rpc.py");
        fs::write(&script, r#"import json, sys
assert '--mode' in sys.argv and sys.argv[sys.argv.index('--mode')+1] == 'rpc'
request = json.loads(sys.stdin.readline())
assert request['type'] == 'prompt'
print(json.dumps({'type':'response','id':request['id'],'success':True}), flush=True)
print(json.dumps({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'parallel'}]}}), flush=True)
print(json.dumps({'type':'agent_settled'}), flush=True)
sys.stdin.read() # RPC shutdown is requested by closing stdin.
"#).unwrap();
        let config = Config {
            engine: "pi".into(),
            pi_command: test_python(),
            pi_args: vec!["-u".into(), script.to_string_lossy().into_owned()],
            repository: temp.path().to_string_lossy().into(),
            model: "mock/model".into(),
            thinking_level: "medium".into(),
            max_parallel: 1,
            max_feedback: 0,
            auto_approve: false,
            role_models: Default::default(),
        };
        let mut events = String::new();
        let result = run_pi(
            PiRequest {
            role: PiRole::Partitioner,
            config: &config,
            cwd: temp.path(),
            task: "test",
            session_dir: &temp.path().join("partition-session"),
            extension: None,
            tools: Some(""),
            session_id: None,
            extra_args: vec![],
            environment: vec![("GRAPHER_TEST_NODE_RPC", "1".into())],
            system_prompt: None,
            images: None,
            },
            |line| events.push_str(&line),
        );
        assert_eq!(result.unwrap(), "parallel");
        assert!(events.contains("grapher_process_exited"));
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn planner_rpc_steer_keeps_session_and_delivers_follow_up() {
        let _guard = lock_env();
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("planner_rpc.py");
        fs::write(&script, r#"import json, sys
first = json.loads(sys.stdin.readline())
assert first['type'] == 'prompt' and first['message'] == 'original'
print(json.dumps({'type':'tool_execution_start'}), flush=True)
print(json.dumps({'type':'agent_settled'}), flush=True)
second = json.loads(sys.stdin.readline())
assert second['type'] == 'prompt' and second['streamingBehavior'] == 'steer'
assert second['message'] == 'additional requirement'
print(json.dumps({'type':'response','id':second['id'],'success':True}), flush=True)
import time; time.sleep(0.7)
print(json.dumps({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'revised'}]}}), flush=True)
print(json.dumps({'type':'agent_settled'}), flush=True)
sys.stdin.read()
"#).unwrap();
        let config = Config {
            engine: "pi".into(),
            pi_command: test_python(),
            pi_args: vec!["-u".into(), script.to_string_lossy().into_owned()],
            repository: temp.path().to_string_lossy().into(),
            model: "mock/model".into(),
            thinking_level: "medium".into(),
            max_parallel: 1,
            max_feedback: 0,
            auto_approve: false,
            role_models: Default::default(),
        };
        let session = temp.path().join("planning-1").join("planner-session");
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker = thread::spawn({
            let root = temp.path().to_path_buf();
            move || {
                run_pi(
                    PiRequest {
                        role: PiRole::Planner,
                        config: &config,
                        cwd: &root,
                        task: "original",
                        session_dir: &session,
                        extension: None,
                        tools: None,
                        session_id: None,
                        extra_args: vec![],
                        environment: vec![
                            ("GRAPHER_TEST_NODE_RPC", "1".into()),
                            ("GRAPHER_PLANNER_RUN_ID", "run-test".into()),
                        ],
                        system_prompt: None,
                        images: None,
                    },
                    |line| {
                        if line.contains("tool_execution_start") {
                            let _ = ready_tx.send(());
                        }
                    },
                )
            }
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            planner_revision_run_id().unwrap().as_deref(),
            Some("run-test")
        );
        steer_planner("additional requirement", None).unwrap();
        assert_eq!(worker.join().unwrap().unwrap(), "revised");
        assert!(planner_revision_run_id().is_err());
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn concurrent_planners_steer_only_their_own_run() {
        let _guard = lock_env();
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("concurrent_planners.py");
        fs::write(&script, r#"import json, os, sys
first = json.loads(sys.stdin.readline())
assert first['type'] == 'prompt'
print(json.dumps({'type':'tool_execution_start'}), flush=True)
second = json.loads(sys.stdin.readline())
assert second['type'] == 'prompt' and second['streamingBehavior'] == 'steer'
assert second['message'] == os.environ['GRAPHER_ACTIVE_RUN_ID']
print(json.dumps({'type':'response','id':second['id'],'success':True}), flush=True)
print(json.dumps({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':second['message']}]}}), flush=True)
print(json.dumps({'type':'agent_settled'}), flush=True)
sys.stdin.read()
"#).unwrap();
        let config = Config {
            engine: "pi".into(),
            pi_command: test_python(),
            pi_args: vec!["-u".into(), script.to_string_lossy().into_owned()],
            repository: temp.path().to_string_lossy().into(),
            model: "mock/model".into(),
            thinking_level: "medium".into(),
            max_parallel: 1,
            max_feedback: 0,
            auto_approve: false,
            role_models: Default::default(),
        };
        // Both the first-attempt layout and manual Graph revisions must keep
        // independent RPC channels. Manual revisions share the parent directory
        // `planner-sessions`, so deriving an RPC key from it would collide.
        for manual_revision in [false, true] {
            let (ready_tx, ready_rx) = mpsc::channel();
            let mut workers = Vec::new();
            for run_id in ["run-a", "run-b"] {
                let config = config.clone();
                let root = temp.path().to_path_buf();
                let session = if manual_revision {
                    root.join("planner-sessions").join(run_id)
                } else {
                    root.join(format!("planning-{run_id}"))
                        .join("planner-session")
                };
                let ready = ready_tx.clone();
                workers.push(thread::spawn(move || {
                    run_pi(
                        PiRequest {
                            role: PiRole::Planner,
                            config: &config,
                            cwd: &root,
                            task: "original",
                            session_dir: &session,
                            extension: None,
                            tools: None,
                            session_id: None,
                            extra_args: vec![],
                            environment: vec![
                                ("GRAPHER_TEST_NODE_RPC", "1".into()),
                                ("GRAPHER_PLANNER_RUN_ID", run_id.into()),
                                ("GRAPHER_ACTIVE_RUN_ID", run_id.into()),
                            ],
                            system_prompt: None,
                            images: None,
                        },
                        |line| {
                            if line.contains("tool_execution_start") {
                                let _ = ready.send(());
                            }
                        },
                    )
                }));
            }
            ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(planner_revision_run_id().is_err());
            for run_id in ["run-a", "run-b"] {
                assert_eq!(
                    planner_revision_run_id_for_run(run_id).unwrap().as_deref(),
                    Some(run_id)
                );
            }
            steer_planner_for_run("run-b", "run-b", None).unwrap();
            steer_planner_for_run("run-a", "run-a", None).unwrap();
            for (worker, expected) in workers.into_iter().zip(["run-a", "run-b"]) {
                assert_eq!(worker.join().unwrap().unwrap(), expected);
            }
        }
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn node_rpc_steer_uses_current_execution_without_restart() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("rpc.py");
        fs::write(&script, r#"import json, sys
first = json.loads(sys.stdin.readline())
assert first['type'] == 'prompt' and first['message'] == 'original'
print(json.dumps({'type':'response','command':'prompt','success':True}), flush=True)
print(json.dumps({'type':'tool_execution_start'}), flush=True)
second = json.loads(sys.stdin.readline())
assert second['type'] == 'prompt' and second['streamingBehavior'] == 'steer'
assert second['message'] == 'new instruction'
print(json.dumps({'type':'response','id':second['id'],'command':'prompt','success':True}), flush=True)
print(json.dumps({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'steered result'}]}}), flush=True)
print(json.dumps({'type':'agent_settled'}), flush=True)
sys.stdin.read()
"#).unwrap();
        let config = Config {
            engine: "pi".into(),
            pi_command: test_python(),
            pi_args: vec!["-u".into(), script.to_string_lossy().into_owned()],
            repository: temp.path().to_string_lossy().into(),
            model: "mock/model".into(),
            role_models: Default::default(),
            thinking_level: "medium".into(),
            max_parallel: 1,
            max_feedback: 0,
            auto_approve: false,
        };
        let id = uuid::Uuid::new_v4().to_string();
        let session = temp.path().join(&id);
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker = thread::spawn({
            let root = temp.path().to_path_buf();
            move || {
                let mut output = String::new();
                let result = run_pi(
                    PiRequest {
                        role: PiRole::NodeAgent,
                        config: &config,
                        cwd: &root,
                        task: "original",
                        session_dir: &session,
                        extension: None,
                        tools: None,
                        session_id: None,
                        extra_args: vec![],
                        environment: vec![("GRAPHER_TEST_NODE_RPC", "1".into())],
                        system_prompt: None,
                        images: None,
                    },
                    |line| {
                        if line.contains("tool_execution_start") {
                            let _ = ready_tx.send(());
                        }
                        output.push_str(&line);
                    },
                );
                (result, output)
            }
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        steer(&id, "new instruction", None).unwrap();
        let (result, output) = worker.join().unwrap();
        assert_eq!(result.unwrap(), "steered result");
        assert!(output.contains("steered result"));
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn node_rpc_steer_transmits_images_properly() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("rpc_images.py");
        fs::write(&script, r#"import json, sys
first = json.loads(sys.stdin.readline())
assert first['type'] == 'prompt' and first['message'] == 'original'
print(json.dumps({'type':'response','command':'prompt','success':True}), flush=True)
print(json.dumps({'type':'tool_execution_start'}), flush=True)
second = json.loads(sys.stdin.readline())
assert second['type'] == 'prompt' and second['streamingBehavior'] == 'steer'
assert second['message'] == 'instruction with image'
assert 'images' in second and len(second['images']) == 1
assert second['images'][0]['mimeType'] == 'image/png'
assert second['images'][0]['data'] == 'ZmFrZQ=='
print(json.dumps({'type':'response','id':second['id'],'command':'prompt','success':True}), flush=True)
print(json.dumps({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'image received'}]}}), flush=True)
print(json.dumps({'type':'agent_settled'}), flush=True)
sys.stdin.read()
"#).unwrap();
        let config = Config {
            engine: "pi".into(),
            pi_command: test_python(),
            pi_args: vec!["-u".into(), script.to_string_lossy().into_owned()],
            repository: temp.path().to_string_lossy().into(),
            model: "mock/model".into(),
            role_models: Default::default(),
            thinking_level: "medium".into(),
            max_parallel: 1,
            max_feedback: 0,
            auto_approve: false,
        };
        let id = uuid::Uuid::new_v4().to_string();
        let session = temp.path().join(&id);
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker = thread::spawn({
            let root = temp.path().to_path_buf();
            move || {
                let mut output = String::new();
                let result = run_pi(
                    PiRequest {
                        role: PiRole::NodeAgent,
                        config: &config,
                        cwd: &root,
                        task: "original",
                        session_dir: &session,
                        extension: None,
                        tools: None,
                        session_id: None,
                        extra_args: vec![],
                        environment: vec![("GRAPHER_TEST_NODE_RPC", "1".into())],
                        system_prompt: None,
                        images: None,
                    },
                    |line| {
                        if line.contains("tool_execution_start") {
                            let _ = ready_tx.send(());
                        }
                        output.push_str(&line);
                    },
                );
                (result, output)
            }
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let test_image = crate::model::ImageAttachment {
            r#type: "image".into(),
            mime_type: "image/png".into(),
            data: "ZmFrZQ==".into(),
            name: Some("test.png".into()),
        };
        steer(&id, "instruction with image", Some(vec![test_image])).unwrap();
        let (result, output) = worker.join().unwrap();
        assert_eq!(result.unwrap(), "image received");
        assert!(output.contains("image received"));
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn node_rpc_initial_prompt_failure_closes_session() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("reject.py");
        fs::write(&script, r#"import json, sys
prompt = json.loads(sys.stdin.readline())
print(json.dumps({'type':'response','id':prompt['id'],'command':'prompt','success':False,'error':'no model available'}), flush=True)
sys.stdin.read()
"#).unwrap();
        let config = Config {
            engine: "pi".into(),
            pi_command: test_python(),
            pi_args: vec!["-u".into(), script.to_string_lossy().into_owned()],
            repository: temp.path().to_string_lossy().into(),
            model: "mock/model".into(),
            thinking_level: "medium".into(),
            max_parallel: 1,
            max_feedback: 0,
            auto_approve: false,
            role_models: Default::default(),
        };
        let result = run_pi_with_timeout(
            PiRequest {
                role: PiRole::NodeAgent,
                config: &config,
                cwd: temp.path(),
                task: "original",
                session_dir: &temp.path().join("session"),
                extension: None,
                tools: None,
                session_id: None,
                extra_args: vec![],
                environment: vec![("GRAPHER_TEST_NODE_RPC", "1".into())],
                system_prompt: None,
                images: None,
            },
            |_| {},
            Some(Duration::from_secs(5)),
        );
        assert_eq!(result.unwrap_err(), "no model available");
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn timeout_settles_silent_and_streaming_children() {
        for script in [
            "while :; do sleep 1; done",
            "while :; do echo '{}'; sleep 0.01; done",
            "exec 1>&- 2>&-; sleep 10",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let config = Config {
                engine: "pi".into(),
                pi_command: "/bin/sh".into(),
                pi_args: vec!["-c".into(), script.into()],
                repository: temp.path().to_string_lossy().into(),
                model: "mock/model".into(),
                role_models: Default::default(),
                thinking_level: "medium".into(),
                max_parallel: 1,
                max_feedback: 0,
                auto_approve: false,
            };
            let mut output = String::new();
            let task = "x".repeat(1024 * 1024);
            let start = Instant::now();
            let result = run_pi_with_timeout(
                PiRequest {
                    role: PiRole::Planner,
                    config: &config,
                    cwd: temp.path(),
                    task: &task,
                    session_dir: &temp.path().join("session"),
                    extension: None,
                    tools: Some(""),
                    session_id: None,
                    extra_args: vec![],
                    environment: vec![],
                    system_prompt: None,
                    images: None,
                },
                |line| output.push_str(&line),
                Some(Duration::from_millis(150)),
            );
            assert!(result.unwrap_err().contains("Planner timed out"));
            assert!(start.elapsed() < Duration::from_secs(5));
            let exited: Value = serde_json::from_str(output.lines().last().unwrap()).unwrap();
            assert_eq!(exited["type"], "grapher_process_exited");
            assert_eq!(exited["timedOut"], true);
            assert_eq!(exited["success"], false);
        }
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn node_agent_has_no_deadline_even_if_timeout_env_is_set() {
        let _guard = lock_env();
        let variable = PiRole::NodeAgent
            .model_env_var()
            .replace("_MODEL", "_TIMEOUT_SECONDS");
        let original = std::env::var_os(&variable);
        std::env::set_var(&variable, "1");
        let temp = tempfile::tempdir().unwrap();
        let config = Config {
            engine: "pi".into(),
            pi_command: "/bin/sh".into(),
            pi_args: vec!["-c".into(), "cat >/dev/null; sleep 1.2; echo '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"stopReason\":\"stop\"}}'".into()],
            repository: temp.path().to_string_lossy().into(),
            model: "mock/model".into(),
            thinking_level: "medium".into(),
            max_parallel: 1,
            max_feedback: 0, auto_approve: false,
            role_models: Default::default(),
        };
        let result = run_pi(
            PiRequest {
                role: PiRole::NodeAgent,
                config: &config,
                cwd: temp.path(),
                task: "test",
                session_dir: &temp.path().join("session"),
                extension: None,
                tools: None,
                session_id: None,
                extra_args: vec![],
                environment: vec![],
                system_prompt: None,
                images: None,
            },
            |_| {},
        );
        match original {
            Some(value) => std::env::set_var(&variable, value),
            None => std::env::remove_var(&variable),
        }
        assert_eq!(result.unwrap(), "done");
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn other_roles_ignore_legacy_timeout_environment() {
        let _guard = lock_env();
        let temp = tempfile::tempdir().unwrap();
        let config = Config {
            engine: "pi".into(),
            pi_command: "/bin/sh".into(),
            pi_args: vec!["-c".into(), "cat >/dev/null; echo '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"stopReason\":\"stop\"}}'".into()],
            repository: temp.path().to_string_lossy().into(),
            model: "mock/model".into(),
            thinking_level: "medium".into(),
            max_parallel: 1,
            max_feedback: 0,
            auto_approve: false,
            role_models: Default::default(),
        };
        for role in [PiRole::Partitioner, PiRole::Planner, PiRole::Merger] {
            let variable = role.model_env_var().replace("_MODEL", "_TIMEOUT_SECONDS");
            let original = std::env::var_os(&variable);
            std::env::set_var(&variable, "invalid");
            let result = run_pi(
                PiRequest {
                    role,
                    config: &config,
                    cwd: temp.path(),
                    task: "test",
                    session_dir: &temp.path().join(role.name()),
                    extension: None,
                    tools: None,
                    session_id: None,
                    extra_args: vec![],
                    environment: vec![],
                    system_prompt: None,
                    images: None,
                },
                |_| {},
            );
            match original {
                Some(value) => std::env::set_var(&variable, value),
                None => std::env::remove_var(&variable),
            }
            assert_eq!(result.unwrap(), "done", "{role:?}");
        }
    }

    #[test]
    fn planner_budget_is_explicit_and_overridable() {
        let _guard = lock_env();
        let original = std::env::var_os("PLANNER_THINKING");
        let mut config = Config {
            repository: "/tmp/fake".into(),
            model: "mock/model".into(),
            thinking_level: "medium".into(),
            max_parallel: 1,
            max_feedback: 0,
            auto_approve: false,
            #[cfg(feature = "fixture")]
            engine: "pi".into(),
            #[cfg(feature = "fixture")]
            pi_command: "node".into(),
            #[cfg(feature = "fixture")]
            pi_args: vec![],
            role_models: Default::default(),
        };
        std::env::remove_var("PLANNER_THINKING");
        assert_eq!(
            PiModelConfig::resolve(PiRole::Planner, &config)
                .thinking
                .as_deref(),
            Some("medium")
        );
        config.thinking_level = "low".into();
        assert_eq!(
            PiModelConfig::resolve(PiRole::Planner, &config)
                .thinking
                .as_deref(),
            Some("low")
        );
        assert_eq!(
            PiModelConfig::resolve(PiRole::NodeAgent, &config)
                .thinking
                .as_deref(),
            Some("low")
        );
        assert_eq!(
            PiModelConfig::resolve(PiRole::Merger, &config)
                .thinking
                .as_deref(),
            Some("low")
        );
        assert_eq!(
            PiModelConfig::resolve(PiRole::Partitioner, &config)
                .thinking
                .as_deref(),
            Some("off")
        );
        std::env::set_var("PLANNER_THINKING", "high");
        assert_eq!(
            PiModelConfig::resolve(PiRole::Planner, &config)
                .thinking
                .as_deref(),
            Some("high")
        );
        match original {
            Some(value) => std::env::set_var("PLANNER_THINKING", value),
            None => std::env::remove_var("PLANNER_THINKING"),
        }
    }

    #[test]
    fn partitioner_model_follows_base_config_model_with_thinking_off() {
        let _guard = lock_env();
        std::env::remove_var("PARTITIONER_MODEL");
        std::env::remove_var("PARTITIONER_THINKING");

        let custom_config = Config {
            repository: "/tmp/fake".into(),
            model: "anthropic/claude-3-7-sonnet".into(),
            thinking_level: "medium".into(),
            max_parallel: 4,
            max_feedback: 3,
            auto_approve: false,
            #[cfg(feature = "fixture")]
            engine: "pi".into(),
            #[cfg(feature = "fixture")]
            pi_command: "node".into(),
            #[cfg(feature = "fixture")]
            pi_args: vec![],
            role_models: Default::default(),
        };

        // Legacy Partitioner follows the base model and defaults to thinking off
        let partitioner_cfg = PiModelConfig::resolve(PiRole::Partitioner, &custom_config);
        assert_eq!(partitioner_cfg.model, "anthropic/claude-3-7-sonnet");
        assert_eq!(partitioner_cfg.thinking, Some("off".to_string()));

        // Planner and NodeAgent should also inherit custom base_config.model
        let planner_cfg = PiModelConfig::resolve(PiRole::Planner, &custom_config);
        assert_eq!(planner_cfg.model, "anthropic/claude-3-7-sonnet");

        let node_cfg = PiModelConfig::resolve(PiRole::NodeAgent, &custom_config);
        assert_eq!(node_cfg.model, "anthropic/claude-3-7-sonnet");
    }

    #[test]
    fn partitioner_thinking_defaults_to_off() {
        let _guard = lock_env();
        std::env::remove_var("PARTITIONER_THINKING");

        let config = Config {
            repository: "/tmp/fake".into(),
            model: String::new(),
            role_models: Default::default(),
            thinking_level: "medium".into(),
            max_parallel: 4,
            max_feedback: 3,
            auto_approve: false,
            #[cfg(feature = "fixture")]
            engine: "pi".into(),
            #[cfg(feature = "fixture")]
            pi_command: "node".into(),
            #[cfg(feature = "fixture")]
            pi_args: vec![],
        };

        // When base_config.model is empty, model remains empty (no qwen3.8-flash fallback)
        let cfg = PiModelConfig::resolve(PiRole::Partitioner, &config);
        assert_eq!(cfg.model, "");
        assert_eq!(cfg.thinking, Some("off".to_string()));
    }

    #[test]
    fn partitioner_thinking_allows_explicit_levels() {
        let _guard = lock_env();

        let config = Config {
            repository: "/tmp/fake".into(),
            model: "some-model".into(),
            thinking_level: "medium".into(),
            max_parallel: 4,
            max_feedback: 3,
            auto_approve: false,
            #[cfg(feature = "fixture")]
            engine: "pi".into(),
            #[cfg(feature = "fixture")]
            pi_command: "node".into(),
            #[cfg(feature = "fixture")]
            pi_args: vec![],
            role_models: Default::default(),
        };

        std::env::set_var("PARTITIONER_THINKING", "high");
        let cfg = PiModelConfig::resolve(PiRole::Partitioner, &config);
        assert_eq!(cfg.thinking, Some("high".to_string()));

        std::env::set_var("PARTITIONER_THINKING", "minimal");
        let cfg = PiModelConfig::resolve(PiRole::Partitioner, &config);
        assert_eq!(cfg.thinking, Some("minimal".to_string()));

        std::env::set_var("PARTITIONER_THINKING", "low");
        let cfg = PiModelConfig::resolve(PiRole::Partitioner, &config);
        assert_eq!(cfg.thinking, Some("low".to_string()));

        std::env::remove_var("PARTITIONER_THINKING");
    }

    #[test]
    fn role_models_resolve_independently_and_environment_still_wins() {
        let _guard = lock_env();
        struct Restore(Vec<(&'static str, Option<std::ffi::OsString>)>);
        impl Drop for Restore {
            fn drop(&mut self) {
                for (key, value) in &self.0 {
                    match value {
                        Some(value) => std::env::set_var(key, value),
                        None => std::env::remove_var(key),
                    }
                }
            }
        }
        let _restore = Restore([
            "PARTITIONER_MODEL", "PARTITIONER_THINKING", "PLANNER_MODEL", "PLANNER_THINKING",
            "NODE_AGENT_MODEL", "NODE_AGENT_THINKING", "MERGER_MODEL", "MERGER_THINKING",
        ].into_iter().map(|key| {
            let value = std::env::var_os(key);
            std::env::remove_var(key);
            (key, value)
        }).collect());
        let config: Config = serde_json::from_value(serde_json::json!({
            "repository": "/tmp/fake", "model": "legacy/default", "thinkingLevel": "medium",
            "maxParallel": 2, "roleModels": {
                "partitioner": {"model": "example/small", "thinkingLevel": "off"},
                "planner": {"model": "example/large", "thinkingLevel": "high"},
                "nodeAgent": {"model": "example/coder", "thinkingLevel": "low"}
            }
        })).unwrap();
        for (role, model, thinking) in [
            (PiRole::Partitioner, "example/small", "off"),
            (PiRole::Planner, "example/large", "high"),
            (PiRole::NodeAgent, "example/coder", "low"),
            (PiRole::Merger, "example/coder", "low"),
        ] {
            let resolved = PiModelConfig::resolve(role, &config);
            assert_eq!(resolved.model, model);
            assert_eq!(resolved.thinking.as_deref(), Some(thinking));
            assert_eq!(resolved.effective_config(&config).model, model);
        }
        let mut partial = config.clone();
        partial.role_models = serde_json::from_value(serde_json::json!({
            "partitioner": {"model": "example/small"},
            "planner": {"thinkingLevel": "max"}
        })).unwrap();
        assert_eq!(PiModelConfig::resolve(PiRole::Partitioner, &partial).thinking.as_deref(), Some("off"));
        assert_eq!(PiModelConfig::resolve(PiRole::Planner, &partial).model, "legacy/default");
        assert_eq!(PiModelConfig::resolve(PiRole::Planner, &partial).thinking.as_deref(), Some("max"));
        assert_eq!(PiModelConfig::resolve(PiRole::NodeAgent, &partial).thinking.as_deref(), Some("medium"));

        std::env::set_var("PLANNER_MODEL", "env/planner");
        std::env::set_var("PARTITIONER_THINKING", "high");
        assert_eq!(PiModelConfig::resolve(PiRole::Planner, &config).model, "env/planner");
        assert_eq!(PiModelConfig::resolve(PiRole::Partitioner, &config).thinking.as_deref(), Some("high"));
        assert_eq!(PiModelConfig::resolve(PiRole::NodeAgent, &config).model, "example/coder");
    }

    #[test]
    fn partitioner_model_env_override_works_independently() {
        let _guard = lock_env();

        let config = Config {
            repository: "/tmp/fake".into(),
            model: "claude-3-7-sonnet".into(),
            thinking_level: "medium".into(),
            max_parallel: 4,
            max_feedback: 3,
            auto_approve: false,
            #[cfg(feature = "fixture")]
            engine: "pi".into(),
            #[cfg(feature = "fixture")]
            pi_command: "node".into(),
            #[cfg(feature = "fixture")]
            pi_args: vec![],
            role_models: Default::default(),
        };

        std::env::set_var("PARTITIONER_MODEL", "custom-partitioner-model");
        let partitioner_cfg = PiModelConfig::resolve(PiRole::Partitioner, &config);
        assert_eq!(partitioner_cfg.model, "custom-partitioner-model");

        let planner_cfg = PiModelConfig::resolve(PiRole::Planner, &config);
        assert_eq!(planner_cfg.model, "claude-3-7-sonnet");

        std::env::remove_var("PARTITIONER_MODEL");
    }

    #[test]
    fn clean_model_error_formats_json_and_plain_messages() {
        let quota = r#"402: {"message":"Insufficient Balance (request_id: 3377e532-1486-4f6f-af77-71b9023c1ac8)","type":"unknown_error","param":null,"code":"invalid_request_error"}"#;
        assert_eq!(
            clean_model_error(quota),
            "402: Insufficient Balance (request_id: 3377e532-1486-4f6f-af77-71b9023c1ac8)"
        );

        let error_nested = r#"{"error":{"message":"You exceeded your current quota"}}"#;
        assert_eq!(clean_model_error(error_nested), "You exceeded your current quota");

        let plain = "Authentication failed";
        assert_eq!(clean_model_error(plain), "Authentication failed");

        let code_and_plain = "401: Unauthorized access";
        assert_eq!(clean_model_error(code_and_plain), "401: Unauthorized access");
    }
}
