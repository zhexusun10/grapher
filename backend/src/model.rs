use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[cfg(feature = "acceptance")]
pub static LOG_TEXT_DESERIALIZED_BYTES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(feature = "acceptance")]
fn count_log_deserialization<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let text = String::deserialize(deserializer)?;
    LOG_TEXT_DESERIALIZED_BYTES.fetch_add(text.len(), std::sync::atomic::Ordering::Relaxed);
    Ok(text)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Node {
    pub name: String,
    pub task: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub relation: String,
    pub feedback: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Graph {
    pub original_goal: String,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub plan_type: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub execution_batches: Vec<Vec<String>>,
    pub roots: Vec<String>,
    pub terminals: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    #[serde(default)]
    pub input: usize,
    #[serde(default)]
    pub output: usize,
    #[serde(default)]
    pub cache_read: usize,
    #[serde(default)]
    pub cache_write: usize,
    #[serde(default)]
    pub reasoning: usize,
    #[serde(default)]
    pub total_tokens: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanningRoleMetrics {
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_event: Option<String>,
    pub duration_seconds: f64,
    pub assistant_messages: usize,
    pub tools: usize,
    pub tool_errors: usize,
    pub usage: TokenUsage,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanningSummary {
    pub planning_id: String,
    pub roles: BTreeMap<String, PlanningRoleMetrics>,
    pub total_planning_duration: f64,
    pub model_duration: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoleModelConfig {
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub repository: String,
    // Test-only actuator injection. Legacy engine/command JSON fields are
    // ignored by production deserialization and never serialized back to UI.
    #[cfg(feature = "fixture")]
    #[serde(default = "test_engine")]
    pub engine: String,
    #[cfg(feature = "fixture")]
    #[serde(default = "test_command")]
    pub pi_command: String,
    #[cfg(feature = "fixture")]
    #[serde(default = "test_args")]
    pub pi_args: Vec<String>,
    pub model: String,
    #[serde(default = "default_thinking_level")]
    pub thinking_level: String,
    // Missing role settings retain the legacy model/thinking defaults.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub role_models: BTreeMap<String, RoleModelConfig>,
    pub max_parallel: usize,
    #[serde(default = "default_max_feedback")]
    pub max_feedback: usize,
    #[serde(default)]
    pub auto_approve: bool,
}

impl Config {
    pub fn validate_model_settings(&self) -> Result<(), String> {
        const LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        if !LEVELS.contains(&self.thinking_level.as_str()) {
            return Err(format!("Invalid default thinking level: {}", self.thinking_level));
        }
        for (role, settings) in &self.role_models {
            if !matches!(role.as_str(), "partitioner" | "planner" | "nodeAgent") {
                return Err(format!("Unknown model role: {role}"));
            }
            if let Some(level) = &settings.thinking_level {
                if !LEVELS.contains(&level.as_str()) {
                    return Err(format!("Invalid {role} thinking level: {level}"));
                }
            }
        }
        Ok(())
    }
}

fn default_max_feedback() -> usize {
    3
}

fn default_thinking_level() -> String {
    "medium".into()
}

#[cfg(feature = "fixture")]
fn test_engine() -> String {
    "pi".into()
}
#[cfg(feature = "fixture")]
fn test_command() -> String {
    "node".into()
}
#[cfg(feature = "fixture")]
fn test_args() -> Vec<String> {
    vec![std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../engine/entrypoint.mjs")
        .to_string_lossy()
        .into()]
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionMetrics {
    #[serde(default)]
    pub duration_seconds: f64,
    #[serde(default)]
    pub assistant_messages: usize,
    #[serde(default)]
    pub tools: usize,
    #[serde(default)]
    pub tool_errors: usize,
    #[serde(default)]
    pub usage: TokenUsage,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunMetrics {
    pub total_duration_seconds: f64,
    pub planning_duration_seconds: f64,
    pub execution_duration_seconds: f64,
    pub assistant_messages: usize,
    pub tools: usize,
    pub tool_errors: usize,
    pub total_usage: TokenUsage,
    pub planning_usage: TokenUsage,
    pub execution_usage: TokenUsage,
}

/// One actual Execution Instance; its serialized event schema remains stable.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub id: String,
    pub node: String,
    pub revision: usize,
    pub attempt: usize,
    pub session_id: String,
    pub worktree: String,
    pub before: String,
    /// Nodes whose results are represented by this live, inherited workspace.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspace_lineage: Vec<String>,
    pub after: Option<String>,
    pub status: String,
    #[serde(default)]
    #[cfg_attr(feature = "acceptance", serde(deserialize_with = "count_log_deserialization"))]
    pub output: String,
    #[serde(default)]
    pub output_bytes: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u64>,
    pub started_at: u64,
    pub completed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<ExecutionMetrics>,
}

/// A feedback input is pinned to an execution, never to a movable node ref.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackWorkspace {
    pub source_execution_id: String,
    pub target_execution_id: String,
    pub worktree: String,
    pub head: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFeedback {
    pub execution_id: String,
    pub from: String,
    pub to: String,
    pub source_head: String,
    pub target_head: Option<String>,
    pub target_revision: usize,
    pub accepted: bool,
    pub output_offset: usize,
    pub output_bytes: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFiles {
    pub head: String,
    pub version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeState {
    pub status: String,
    pub revision: usize,
    pub head: Option<String>,
    pub instruction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction_images: Option<Vec<ImageAttachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_execution_id: Option<String>,
    #[serde(default)]
    pub human_instruction: bool,
    /// Continue this node's conversation in the current terminal workspace
    /// without invalidating already-completed descendants.
    #[serde(default)]
    pub shared_workspace: bool,
    /// Result the node held when a non-shared follow-up/edit started. A finished
    /// run that produces a different head invalidates dependency descendants.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback_workspace: Option<FeedbackWorkspace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_files_version: Option<String>,
    #[serde(default)]
    pub files_changed: bool,
    pub error: Option<String>,
}

impl Default for NodeState {
    fn default() -> Self {
        Self {
            status: "waiting".into(),
            revision: 1,
            head: None,
            instruction: String::new(),
            instruction_images: None,
            edit_execution_id: None,
            human_instruction: false,
            shared_workspace: false,
            baseline_head: None,
            feedback_workspace: None,
            files_override: None,
            files_version: None,
            baseline_files_version: None,
            files_changed: false,
            error: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventKind {
    /// A conversation exists before its graph has been compiled.
    PlanningStarted {
        goal: String,
        config: Config,
        planning: PlanningSummary,
        plan_type: Option<String>,
    },
    PlanningFailed {
        planning: PlanningSummary,
    },
    Created {
        graph: Graph,
        config: Config,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        planning_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        planning: Option<PlanningSummary>,
    },
    /// Persist routing separately from graph shape. Older event stores did not
    /// record it and retain their legacy shape-based interpretation.
    Routed {
        plan_type: String,
    },
    Approved {
        base: String,
    },
    /// Native Planner writes survive a failed/cancelled revision too.
    SourceSnapshotted {
        head: String,
    },
    SourceFilesRecorded {
        files: SourceFiles,
    },
    WorkspaceFilesChanged {
        execution_id: String,
    },
    GraphRevised {
        graph: Graph,
        planning_id: String,
        planning: PlanningSummary,
        invalidated: Vec<String>,
        /// Source files after this approved Planner turn; absent in legacy/draft events.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_head: Option<String>,
    },
    /// A manual edit of an unapproved draft. Keep its Run and Planner history.
    DraftEdited {
        graph: Graph,
        config: Config,
    },
    Paused {
        paused: bool,
    },
    StopRequested,
    Rejected,
    Started {
        execution: Execution,
    },
    Prepared {
        execution_id: String,
        head: String,
    },
    Steered {
        execution_id: String,
        node: String,
        instruction: String,
    },
    /// A message addressed to a finished node. It does not start an execution.
    NodeMessaged {
        node: String,
        instruction: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        images: Option<Vec<ImageAttachment>>,
    },
    Output {
        execution_id: String,
        #[cfg_attr(feature = "acceptance", serde(deserialize_with = "count_log_deserialization"))]
        text: String,
    },
    Finished {
        execution_id: String,
        head: String,
        #[serde(default)]
        #[cfg_attr(feature = "acceptance", serde(deserialize_with = "count_log_deserialization"))]
        output: String,
        #[serde(default)]
        output_bytes: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metrics: Option<ExecutionMetrics>,
    },
    Failed {
        node: String,
        execution_id: Option<String>,
        error: String,
        #[serde(default)]
        output_bytes: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metrics: Option<ExecutionMetrics>,
    },
    Blocked {
        node: String,
        error: String,
    },
    /// Human committed a conflicted preparation; the node task has not run.
    WorkspaceResolved {
        execution_id: String,
        head: String,
        nodes: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        files_version: Option<String>,
    },
    Invalidated {
        nodes: Vec<String>,
        target: String,
        instruction: String,
        human: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        images: Option<Vec<ImageAttachment>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace: Option<FeedbackWorkspace>,
        /// The message runs on the final inherited workspace; descendants stay valid.
        #[serde(default)]
        shared_workspace: bool,
    },
    /// Move Pi's active leaf before an earlier user turn. Old executions and
    /// transcript entries remain durable but no longer belong to this branch.
    ConversationEdited {
        nodes: Vec<String>,
        target: String,
        instruction: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        images: Option<Vec<ImageAttachment>>,
        from_execution_id: String,
        from_event_sequence: i64,
        old_instruction: String,
        first_turn: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selected_version: Option<usize>,
    },
    /// The Planner shares a Pi session across revisions. Preserve the old
    /// branch while replaying a replacement turn in the same Run.
    PlannerConversationEdited {
        old_instruction: String,
        instruction: String,
        first_turn: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selected_version: Option<usize>,
    },
    FeedbackQueued {
        feedback: PendingFeedback,
    },
    FeedbackResolved {
        execution_id: String,
        disposition: String,
    },
    Feedback {
        from: String,
        to: String,
        accepted: bool,
    },
    /// Warning metadata only: no rework, failure, or downstream text injection.
    FeedbackExhausted {
        from: String,
        to: String,
        execution_id: String,
        count: usize,
        limit: usize,
    },
    PublicationStarted {
        repository: String,
        heads: Vec<String>,
    },
    PublicationCompleted {
        head: String,
    },
    PublicationFailed {
        error: String,
    },
    MergerStarted {
        execution: Execution,
    },
    MergerFinished {
        execution_id: String,
        head: String,
        #[serde(default)]
        output_bytes: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metrics: Option<ExecutionMetrics>,
    },
    MergerFailed {
        execution_id: String,
        error: String,
        #[serde(default)]
        output_bytes: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metrics: Option<ExecutionMetrics>,
    },
    Settled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub sequence: i64,
    pub timestamp: u64,
    #[serde(flatten)]
    pub kind: EventKind,
}

/// Publication state is separate from node state. Retain the exact heads and
/// target across retries/restarts instead of replaying historical attempts.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publication {
    pub repository: String,
    pub heads: Vec<String>,
    pub status: String,
    pub head: Option<String>,
    pub error: Option<String>,
    pub started_at: u64,
    pub completed_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<PlanningSummary>,
    pub graph: Graph,
    pub config: Option<Config>,
    pub plan: Option<Plan>,
    pub nodes: BTreeMap<String, NodeState>,
    pub executions: Vec<Execution>,
    #[serde(default)]
    pub superseded_execution_ids: Vec<String>,
    #[serde(default)]
    pub mergers: Vec<Execution>,
    #[serde(default)]
    pub publication: Option<Publication>,
    pub events: Vec<Event>,
    pub approved: bool,
    pub paused: bool,
    #[serde(default)]
    pub stop_requested: bool,
    pub phase: String,
    pub base: String,
    /// Last successfully published source HEAD, distinct from the graph's approval base.
    #[serde(default)]
    pub published_head: Option<String>,
    pub feedback_counts: BTreeMap<String, usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_feedback: Vec<PendingFeedback>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_files: Option<SourceFiles>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_metrics: Option<RunMetrics>,
}

pub fn parse_execution_metrics(output: &str, started_at: u64, completed_at: u64) -> ExecutionMetrics {
    let mut duration_seconds = 0.0;
    let mut assistant_messages = 0;
    let mut tools = 0;
    let mut tool_errors = 0;
    let mut usage = TokenUsage::default();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("[stderr]") {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            match value
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
            {
                "grapher_process_exited" => {
                    if let Some(elapsed) = value.get("elapsedMs").and_then(|v| v.as_f64()) {
                        duration_seconds = elapsed / 1000.0;
                    }
                }
                "message_end" => {
                    if let Some(msg) = value.get("message") {
                        if msg.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                            assistant_messages += 1;
                            if let Some(u) = msg.get("usage") {
                                usage.input +=
                                    u.get("input").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                usage.output +=
                                    u.get("output").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                usage.cache_read +=
                                    u.get("cacheRead").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                usage.cache_write +=
                                    u.get("cacheWrite").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                usage.reasoning +=
                                    u.get("reasoning").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                usage.total_tokens +=
                                    u.get("totalTokens").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                            }
                        }
                    }
                }
                "tool_execution_start" => {
                    tools += 1;
                }
                "tool_execution_end" => {
                    if value.get("isError").and_then(|v| v.as_bool()).unwrap_or(false)
                        || value
                            .get("result")
                            .and_then(|r| r.get("isError"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                    {
                        tool_errors += 1;
                    }
                }
                _ => {}
            }
        }
    }

    if duration_seconds == 0.0 && completed_at >= started_at && started_at > 0 {
        duration_seconds = (completed_at - started_at) as f64 / 1000.0;
    }

    ExecutionMetrics {
        duration_seconds,
        assistant_messages,
        tools,
        tool_errors,
        usage,
    }
}

impl Snapshot {
    pub fn compute_run_metrics(&self) -> RunMetrics {
        let mut planning_duration = 0.0;
        let mut planning_messages = 0;
        let mut planning_tools = 0;
        let mut planning_tool_errors = 0;
        let mut planning_usage = TokenUsage::default();

        if let Some(planning) = &self.planning {
            planning_duration = planning.total_planning_duration;
            for metrics in planning.roles.values() {
                planning_messages += metrics.assistant_messages;
                planning_tools += metrics.tools;
                planning_tool_errors += metrics.tool_errors;
                planning_usage.input += metrics.usage.input;
                planning_usage.output += metrics.usage.output;
                planning_usage.cache_read += metrics.usage.cache_read;
                planning_usage.cache_write += metrics.usage.cache_write;
                planning_usage.reasoning += metrics.usage.reasoning;
                planning_usage.total_tokens += metrics.usage.total_tokens;
            }
        }

        let mut exec_duration = 0.0;
        let mut exec_messages = 0;
        let mut exec_tools = 0;
        let mut exec_tool_errors = 0;
        let mut exec_usage = TokenUsage::default();

        for exec in self.executions.iter().chain(self.mergers.iter()) {
            if let Some(metrics) = &exec.metrics {
                exec_duration += metrics.duration_seconds;
                exec_messages += metrics.assistant_messages;
                exec_tools += metrics.tools;
                exec_tool_errors += metrics.tool_errors;
                exec_usage.input += metrics.usage.input;
                exec_usage.output += metrics.usage.output;
                exec_usage.cache_read += metrics.usage.cache_read;
                exec_usage.cache_write += metrics.usage.cache_write;
                exec_usage.reasoning += metrics.usage.reasoning;
                exec_usage.total_tokens += metrics.usage.total_tokens;
            }
        }

        let wall_clock_duration = if let (Some(first), Some(last)) = (self.events.first(), self.events.last()) {
            if last.timestamp >= first.timestamp {
                (last.timestamp - first.timestamp) as f64 / 1000.0
            } else {
                planning_duration + exec_duration
            }
        } else {
            planning_duration + exec_duration
        };

        RunMetrics {
            total_duration_seconds: wall_clock_duration,
            planning_duration_seconds: planning_duration,
            execution_duration_seconds: exec_duration,
            assistant_messages: planning_messages + exec_messages,
            tools: planning_tools + exec_tools,
            tool_errors: planning_tool_errors + exec_tool_errors,
            total_usage: TokenUsage {
                input: planning_usage.input + exec_usage.input,
                output: planning_usage.output + exec_usage.output,
                cache_read: planning_usage.cache_read + exec_usage.cache_read,
                cache_write: planning_usage.cache_write + exec_usage.cache_write,
                reasoning: planning_usage.reasoning + exec_usage.reasoning,
                total_tokens: planning_usage.total_tokens + exec_usage.total_tokens,
            },
            planning_usage,
            execution_usage: exec_usage,
        }
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn append_live_output(execution: &mut Execution, text: &str) {
    execution.output.push_str(text);
    execution.output_bytes = execution.output.len();
    if execution.pid.is_none() {
        // The lifecycle record may itself span multiple output messages.
        if let Some(line) = execution.output.split_once('\n').map(|(line, _)| line) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                if value["type"] == "grapher_process_started" {
                    execution.pid = value["pid"].as_u64();
                }
            }
        }
    }
}

pub fn apply(state: &mut Snapshot, event: &Event) {
    match &event.kind {
        EventKind::PlanningStarted { goal, config, planning, plan_type } => {
            state.graph.original_goal = goal.clone();
            state.config = Some(config.clone());
            state.planning_id = Some(planning.planning_id.clone());
            state.planning = Some(planning.clone());
            state.plan_type = plan_type.clone();
            state.phase = "planning".into();
        }
        EventKind::PlanningFailed { planning } => {
            state.planning = Some(planning.clone());
            state.phase = "planning_failed".into();
        }
        EventKind::Created {
            graph,
            config,
            planning_id,
            planning,
        } => {
            state.graph = graph.clone();
            state.config = Some(config.clone());
            state.planning_id = planning_id.clone();
            state.planning = planning.clone();
            state.plan = crate::compiler::compile_legacy(graph, true).ok();
            state.nodes = graph
                .nodes
                .iter()
                .map(|node| (node.name.clone(), NodeState::default()))
                .collect();
            state.phase = "awaiting_approval".into();
        }
        EventKind::Routed { plan_type } => {
            state.plan_type = Some(plan_type.clone());
        }
        EventKind::Approved { base } => {
            state.approved = true;
            state.base = base.clone();
            state.phase = "running".into();
        }
        EventKind::GraphRevised { graph, planning_id, planning, invalidated, .. } => {
            state.stop_requested = false;
            let changed = state.graph != *graph;
            state.graph = graph.clone();
            state.plan = crate::compiler::compile_legacy(graph, true).ok();
            state.planning_id = Some(planning_id.clone());
            state.planning = Some(planning.clone());
            state.nodes.retain(|name, _| graph.nodes.iter().any(|node| node.name == *name));
            for node in &graph.nodes {
                state.nodes.entry(node.name.clone()).or_default();
            }
            for name in invalidated {
                let node = state.nodes.get_mut(name).unwrap();
                // A node with no prior execution has no result to invalidate.
                node.status = if matches!(node.status.as_str(), "waiting" | "failed" | "blocked") {
                    "waiting"
                } else {
                    "dirty"
                }.into();
                node.head = None;
                node.error = None;
                node.instruction.clear();
                node.instruction_images = None;
                node.edit_execution_id = None;
                node.human_instruction = false;
                node.feedback_workspace = None;
                node.files_override = None;
                node.files_version = None;
                node.baseline_files_version = None;
                if node.status == "dirty" { node.revision += 1; }
            }
            state.feedback_counts.retain(|key, _| graph.edges.iter().any(|edge| edge.feedback && key == &format!("{}->{}", edge.from, edge.to)));
            if !state.approved {
                // Draft revisions must stay approvable, including after Reject.
                // No Approved event means there can be no execution.
                state.phase = "awaiting_approval".into();
            } else if changed {
                state.publication = None;
                state.phase = if state.paused { "paused" } else { "running" }.into();
            }
        }
        EventKind::DraftEdited { graph, config } => {
            state.graph = graph.clone();
            state.config = Some(config.clone());
            state.plan_type = Some("graph".into());
            state.plan = crate::compiler::compile_legacy(graph, true).ok();
            state.nodes = graph.nodes.iter()
                .map(|node| (node.name.clone(), NodeState::default()))
                .collect();
            state.phase = "awaiting_approval".into();
            // Planning identity and conversation history stay with this Run.
        }
        EventKind::StopRequested => { state.stop_requested = true; }
        EventKind::Paused { paused } => {
            state.paused = *paused;
            if !paused { state.stop_requested = false; }
            state.phase = if *paused { "paused" } else { "running" }.into();
        }
        EventKind::Rejected => {
            state.phase = "rejected".into();
            state.approved = false;
        }
        EventKind::Started { execution } => {
            let node = state.nodes.get_mut(&execution.node).unwrap();
            node.edit_execution_id = None;
            node.status = "running".into();
            node.files_changed = false;
            node.error = None;
            state.executions.push(execution.clone());
        }
        EventKind::SourceSnapshotted { .. } | EventKind::Steered { .. } | EventKind::NodeMessaged { .. } => {}
        EventKind::SourceFilesRecorded { files } => state.source_files = Some(files.clone()),
        EventKind::WorkspaceFilesChanged { execution_id } => {
            if let Some(execution) = state.executions.iter().find(|execution| execution.id == *execution_id && execution.status == "running") {
                if let Some(node) = state.nodes.get_mut(&execution.node) { node.files_changed = true; }
            }
        }
        EventKind::Output { execution_id, text } => {
            if let Some(execution) = state
                .executions
                .iter_mut()
                .chain(state.mergers.iter_mut())
                .find(|item| item.id == *execution_id)
            {
                append_live_output(execution, text);
            }
            // Streaming logs are not business events and must not accumulate
            // a second, unbounded copy in state.events.
            return;
        }
        EventKind::Prepared { execution_id, head } => {
            if let Some(execution) = state
                .executions
                .iter_mut()
                .find(|item| item.id == *execution_id)
            {
                execution.before = head.clone();
            }
        }
        EventKind::Finished {
            execution_id,
            head,
            output,
            output_bytes,
            metrics,
        } => {
            let superseded = state.superseded_execution_ids.contains(execution_id);
            let completed = state
                .executions
                .iter_mut()
                .chain(state.mergers.iter_mut())
                .find(|item| item.id == *execution_id)
                .map(|execution| {
                    let node_name = execution.node.clone();
                    let lineage = execution.workspace_lineage.clone();
                    execution.status = "completed".into();
                    execution.after = Some(head.clone());
                    execution.completed_at = Some(event.timestamp);
                    execution.output_bytes = (*output_bytes).max(output.len());
                    execution.metrics = metrics.clone().or_else(|| (!output.is_empty()).then(||
                        parse_execution_metrics(output, execution.started_at, event.timestamp)));
                    execution.output = String::new();
                    (node_name, lineage)
                });
            if let Some((node_name, lineage)) = completed {
                if !superseded {
                    let changed = state
                        .nodes
                        .get(&node_name)
                        .and_then(|node| node.baseline_head.as_deref())
                        .is_some_and(|baseline| baseline != head.as_str() || state.nodes[&node_name].files_changed);
                    let dependents: Vec<String> = if changed && !state.nodes[&node_name].shared_workspace {
                        crate::compiler::downstream(&state.graph, &node_name)
                            .into_iter()
                            .filter(|name| name != &node_name)
                            .collect()
                    } else {
                        Vec::new()
                    };
                    if let Some(node) = state.nodes.get_mut(&node_name) {
                        node.status = "done".into();
                        node.head = Some(head.clone());
                        node.instruction_images = None;
                        node.baseline_head = None;
                        node.shared_workspace = false;
                        node.feedback_workspace = None;
                        node.files_override = None;
                        node.files_version = Some(format!("after-{execution_id}"));
                        node.baseline_files_version = None;
                        node.files_changed = false;
                    }
                    // A downstream execution on the inherited workspace advances
                    // the live result for every node represented by that workspace.
                    // This is metadata-only: their conversations and task results
                    // remain intact, and no dependent node needs to run again.
                    for inherited in lineage.into_iter().filter(|name| name != &node_name) {
                        if let Some(node) = state.nodes.get_mut(&inherited) {
                            if node.status == "done" {
                                node.head = Some(head.clone());
                                node.files_version = Some(format!("after-{execution_id}"));
                                node.files_override = None;
                                node.files_changed = false;
                            }
                        }
                    }
                    // A follow-up that changed the result makes every descendant
                    // recompute from it. Unrelated branches stay valid.
                    for name in dependents {
                        let never_executed =
                            !state.executions.iter().any(|execution| execution.node == name);
                        if let Some(node) = state.nodes.get_mut(&name) {
                            let unstarted = node.status == "waiting"
                                || (node.status == "blocked" && never_executed);
                            node.status = if unstarted { "waiting" } else { "dirty" }.into();
                            node.error = None;
                            node.head = None;
                            node.baseline_head = None;
                            node.instruction.clear();
                            node.instruction_images = None;
                            node.edit_execution_id = None;
                            node.human_instruction = false;
                            node.feedback_workspace = None;
                            node.files_override = None;
                            node.files_version = None;
                            node.baseline_files_version = None;
                            if !unstarted {
                                node.revision += 1;
                            }
                        }
                    }
                    if changed {
                        state.publication = None;
                    }
                }
            }
        }
        EventKind::Failed {
            node,
            execution_id,
            error,
            output_bytes,
            metrics,
        } => {
            let superseded = execution_id
                .as_ref()
                .is_some_and(|id| state.superseded_execution_ids.contains(id));
            if !superseded {
                let node = state.nodes.get_mut(node).unwrap();
                node.status = "failed".into();
                node.error = Some(error.clone());
                node.baseline_head = None;
                node.baseline_files_version = None;
            }
            if let Some(execution) = state
                .executions
                .iter_mut()
                .chain(state.mergers.iter_mut())
                .find(|item| Some(&item.id) == execution_id.as_ref())
            {
                execution.status = "failed".into();
                execution.completed_at = Some(event.timestamp);
                execution.output_bytes = (*output_bytes).max(execution.output_bytes).max(execution.output.len());
                execution.metrics = metrics.clone().or_else(|| (!execution.output.is_empty()).then(|| parse_execution_metrics(&execution.output, execution.started_at, event.timestamp)));
                execution.output = String::new();
            }
        }
        EventKind::Blocked { node, error } => {
            let node = state.nodes.get_mut(node).unwrap();
            node.status = "blocked".into();
            node.error = Some(error.clone());
        }
        EventKind::WorkspaceResolved { execution_id, head, nodes, files_version } => {
            let execution = state.executions.iter_mut().find(|item| item.id == *execution_id).unwrap();
            execution.status = "resolved".into();
            execution.completed_at = Some(event.timestamp);
            let target = execution.node.clone();
            state.publication = None;
            for name in nodes {
                let never_executed = !state.executions.iter().any(|execution| execution.node == *name);
                let node = state.nodes.get_mut(name).unwrap();
                let unstarted = name != &target &&
                    (node.status == "waiting" || (node.status == "blocked" && never_executed));
                node.status = if unstarted { "waiting" } else { "dirty" }.into();
                node.error = None;
                node.head = if *name == target { Some(head.clone()) } else { None };
                if !unstarted { node.revision += 1; }
                if *name == target {
                    node.files_override = files_version.clone();
                    node.files_version = files_version.clone();
                    node.baseline_files_version = None;
                    if let Some(input) = &mut node.feedback_workspace {
                        input.head = head.clone();
                    } else if !node.human_instruction {
                        node.instruction.clear();
                        node.instruction_images = None;
                        node.edit_execution_id = None;
                    }
                }
            }
            state.phase = if state.paused { "paused" } else { "running" }.into();
        }
        EventKind::Invalidated {
            nodes,
            target,
            instruction,
            human,
            images,
            workspace,
            shared_workspace,
        } => {
            state.stop_requested = false;
            state.publication = None;
            for name in nodes {
                let never_executed = !state.executions.iter().any(|execution| execution.node == *name);
                let node = state.nodes.get_mut(name).unwrap();
                let unstarted = node.status == "waiting" || (node.status == "blocked" && never_executed);
                node.status = if unstarted { "waiting" } else { "dirty" }.into();
                node.error = None;
                // Only the target continues from its previous result; every
                // other affected node is recomputed from its parents.
                if name != target {
                    node.head = None;
                    node.baseline_head = None;
                    node.instruction.clear();
                    node.instruction_images = None;
                    node.edit_execution_id = None;
                    node.human_instruction = false;
                    node.feedback_workspace = None;
                    node.files_override = None;
                    node.files_version = None;
                    node.baseline_files_version = None;
                }
                if *human && !unstarted {
                    node.revision += 1;
                }
            }
            let target_node = state.nodes.get_mut(target).unwrap();
            target_node.shared_workspace = false;
            if workspace.is_some() || !*human { target_node.feedback_workspace = workspace.clone(); }
            if let Some(input) = workspace {
                target_node.head = Some(input.head.clone());
                target_node.files_override = None;
                target_node.files_version = Some(format!("after-{}", input.source_execution_id));
            }
            if *human && !instruction.is_empty() {
                // A user follow-up continues from the target's current result.
                // A shared-workspace follow-up already edits the terminal result,
                // so completed descendants remain valid and are not rescheduled.
                target_node.baseline_head = target_node.head.clone();
                target_node.baseline_files_version = target_node.files_version.clone();
                target_node.instruction = instruction.clone();
                target_node.instruction_images = images.clone();
                target_node.edit_execution_id = None;
                target_node.human_instruction = true;
                target_node.shared_workspace = *shared_workspace;
            } else if !instruction.is_empty() {
                // Feedback retains the target's conversation, but a pinned
                // workspace input can transfer the reviewer's completed tree.
                target_node.baseline_head = None;
                target_node.baseline_files_version = None;
                target_node.instruction = instruction.clone();
                target_node.instruction_images = None;
                target_node.edit_execution_id = None;
                target_node.human_instruction = true;
            } else {
                target_node.baseline_head = None;
                target_node.shared_workspace = false;
            }
            state.phase = if state.paused { "paused" } else { "running" }.into();
        }
        EventKind::ConversationEdited {
            nodes, target, instruction, images, from_execution_id, first_turn, ..
        } => {
            state.stop_requested = false;
            let anchor = state.executions.iter().find(|execution| execution.id == *from_execution_id)
                .expect("validated edit anchor").clone();
            for execution in &state.executions {
                if nodes.contains(&execution.node) && execution.started_at >= anchor.started_at
                    && !state.superseded_execution_ids.contains(&execution.id)
                {
                    state.superseded_execution_ids.push(execution.id.clone());
                }
            }
            state.publication = None;
            if *first_turn {
                if state.plan_type.as_deref() == Some("serial") {
                    state.graph.original_goal = instruction.clone();
                }
                if let Some(node) = state.graph.nodes.iter_mut().find(|node| node.name == *target) {
                    node.task = instruction.clone();
                }
            }
            for name in nodes {
                let node = state.nodes.get_mut(name).expect("validated edit scope");
                node.status = "dirty".into();
                node.error = None;
                node.revision += 1;
                node.feedback_workspace = None;
                node.files_override = None;
                if name == target {
                    node.baseline_head = node.head.clone();
                    node.baseline_files_version = node.files_version.clone();
                    node.files_version = Some(format!("before-{}", anchor.id));
                    node.head = Some(anchor.before.clone());
                    node.instruction = instruction.clone();
                    node.instruction_images = images.clone();
                    node.human_instruction = true;
                    node.edit_execution_id = Some(from_execution_id.clone());
                } else {
                    node.head = None;
                    node.baseline_head = None;
                    node.instruction.clear();
                    node.instruction_images = None;
                    node.edit_execution_id = None;
                    node.human_instruction = false;
                }
            }
            state.phase = if state.paused { "paused" } else { "running" }.into();
        }
        EventKind::PlannerConversationEdited { instruction, first_turn, .. } => {
            state.stop_requested = false;
            if *first_turn { state.graph.original_goal = instruction.clone(); }
        }
        EventKind::FeedbackQueued { feedback } => {
            if !state.pending_feedback.iter().any(|item| item.execution_id == feedback.execution_id) {
                state.pending_feedback.push(feedback.clone());
            }
        }
        EventKind::FeedbackResolved { execution_id, .. } => {
            state.pending_feedback.retain(|item| item.execution_id != *execution_id);
        }
        EventKind::Feedback { from, to, accepted } => {
            if !accepted {
                *state
                    .feedback_counts
                    .entry(format!("{from}->{to}"))
                    .or_default() += 1;
            }
        }
        // Exhaustion is a warning, not acceptance, failure, or invalidation.
        EventKind::FeedbackExhausted { .. } => {}
        EventKind::PublicationStarted { repository, heads } => {
            state.publication = Some(Publication {
                repository: repository.clone(),
                heads: heads.clone(),
                status: "publishing".into(),
                head: None,
                error: None,
                started_at: event.timestamp,
                completed_at: None,
            });
            state.paused = false;
            state.phase = "publishing".into();
        }
        EventKind::PublicationCompleted { head } => {
            state.published_head = Some(head.clone());
            if let Some(publication) = &mut state.publication {
                publication.status = "completed".into();
                publication.head = Some(head.clone());
                publication.completed_at = Some(event.timestamp);
                publication.error = None;
            }
            state.phase = "completed".into();
            state.paused = false;
        }
        EventKind::PublicationFailed { error } => {
            if let Some(publication) = &mut state.publication {
                publication.status = "failed".into();
                publication.error = Some(error.clone());
            }
            state.phase = "publication_failed".into();
            state.paused = true;
        }
        EventKind::MergerStarted { execution } => {
            state.mergers.push(execution.clone());
            if execution.node == "merger" {
                state.phase = "merging".into();
                if let Some(publication) = &mut state.publication {
                    publication.status = "merging".into();
                }
            }
        }
        EventKind::MergerFinished { execution_id, head, output_bytes, metrics } => {
            if let Some(execution) = state.mergers.iter_mut().find(|e| e.id == *execution_id) {
                execution.status = "completed".into();
                execution.after = Some(head.clone());
                execution.completed_at = Some(event.timestamp);
                execution.output_bytes = (*output_bytes).max(execution.output_bytes).max(execution.output.len());
                execution.metrics = metrics.clone().or_else(|| (!execution.output.is_empty()).then(|| parse_execution_metrics(&execution.output, execution.started_at, event.timestamp)));
                execution.output = String::new();
            }
            if state.mergers.iter().any(|e| e.id == *execution_id && e.node == "merger") {
                state.phase = "publishing".into();
                if let Some(publication) = &mut state.publication {
                    publication.status = "publishing".into();
                }
            }
        }
        EventKind::MergerFailed {
            execution_id,
            error,
            output_bytes,
            metrics,
        } => {
            if let Some(execution) = state.mergers.iter_mut().find(|e| e.id == *execution_id) {
                execution.status = "failed".into();
                // Runtime persists the annotation before this terminal event.
                // Replay restores byte counts from the log table, not text.
                let _ = error;
                execution.completed_at = Some(event.timestamp);
                execution.output_bytes = (*output_bytes).max(execution.output_bytes).max(execution.output.len());
                execution.metrics = metrics.clone().or_else(|| (!execution.output.is_empty()).then(|| parse_execution_metrics(&execution.output, execution.started_at, event.timestamp)));
                execution.output = String::new();
            }
        }
        EventKind::Settled => {
            state.phase = if state.nodes.values().all(|node| node.status == "done") {
                "completed"
            } else {
                "needs_attention"
            }
            .into();
        }
    }
    state.events.push(event.clone());
    state.run_metrics = Some(state.compute_run_metrics());
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageAttachment {
    #[serde(default = "default_image_type")]
    pub r#type: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub data: String,
    #[serde(default)]
    pub name: Option<String>,
}

fn default_image_type() -> String {
    "image".to_string()
}

#[cfg(test)]
mod metrics_tests {
    use super::*;

    #[test]
    fn streaming_output_is_not_retained_as_business_history() {
        let mut state = Snapshot::default();
        let mut roles = BTreeMap::new();
        roles.insert("planner".into(), PlanningRoleMetrics {
            duration_seconds: 2.0,
            ..Default::default()
        });
        state.planning = Some(PlanningSummary { total_planning_duration: 3.0, roles, ..Default::default() });

        for (sequence, timestamp, kind) in [
            (1, 1_000, EventKind::Routed { plan_type: "serial".into() }),
            (2, 2_500, EventKind::Output { execution_id: "node".into(), text: "first".into() }),
            (3, 3_000, EventKind::Output { execution_id: "node".into(), text: "second".into() }),
            // Preserve the existing fallback for non-monotonic persisted timestamps.
            (4, 500, EventKind::Output { execution_id: "node".into(), text: "third".into() }),
        ] {
            apply(&mut state, &Event { sequence, timestamp, kind });
            assert_eq!(state.run_metrics, Some(state.compute_run_metrics()));
        }
        assert_eq!(state.events.len(), 1);
        assert_eq!(state.run_metrics.unwrap().total_duration_seconds, 0.0);
    }
}
