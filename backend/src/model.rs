use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
    pub max_parallel: usize,
    #[serde(default = "default_max_feedback")]
    pub max_feedback: usize,
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
    pub after: Option<String>,
    pub status: String,
    pub output: String,
    pub started_at: u64,
    pub completed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<ExecutionMetrics>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeState {
    pub status: String,
    pub revision: usize,
    pub head: Option<String>,
    pub instruction: String,
    #[serde(default)]
    pub human_instruction: bool,
    pub error: Option<String>,
}

impl Default for NodeState {
    fn default() -> Self {
        Self {
            status: "waiting".into(),
            revision: 1,
            head: None,
            instruction: String::new(),
            human_instruction: false,
            error: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventKind {
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
    GraphRevised {
        graph: Graph,
        planning_id: String,
        planning: PlanningSummary,
        invalidated: Vec<String>,
    },
    Paused {
        paused: bool,
    },
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
    Output {
        execution_id: String,
        text: String,
    },
    Finished {
        execution_id: String,
        head: String,
        output: String,
    },
    Failed {
        node: String,
        execution_id: Option<String>,
        error: String,
    },
    Blocked {
        node: String,
        error: String,
    },
    Invalidated {
        nodes: Vec<String>,
        target: String,
        instruction: String,
        human: bool,
    },
    Feedback {
        from: String,
        to: String,
        accepted: bool,
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
    },
    MergerFailed {
        execution_id: String,
        error: String,
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
    pub mergers: Vec<Execution>,
    #[serde(default)]
    pub publication: Option<Publication>,
    pub events: Vec<Event>,
    pub approved: bool,
    pub paused: bool,
    pub phase: String,
    pub base: String,
    /// Last successfully published source HEAD, distinct from the graph's approval base.
    #[serde(default)]
    pub published_head: Option<String>,
    pub feedback_counts: BTreeMap<String, usize>,
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

pub fn apply(state: &mut Snapshot, event: &Event) {
    match &event.kind {
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
        EventKind::GraphRevised { graph, planning_id, planning, invalidated } => {
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
                node.human_instruction = false;
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
        EventKind::Paused { paused } => {
            state.paused = *paused;
            state.phase = if *paused { "paused" } else { "running" }.into();
        }
        EventKind::Rejected => {
            state.phase = "rejected".into();
            state.approved = false;
        }
        EventKind::Started { execution } => {
            let node = state.nodes.get_mut(&execution.node).unwrap();
            node.status = "running".into();
            node.error = None;
            state.executions.push(execution.clone());
        }
        EventKind::Steered { .. } => {}
        EventKind::Output { execution_id, text } => {
            if let Some(execution) = state
                .executions
                .iter_mut()
                .chain(state.mergers.iter_mut())
                .find(|item| item.id == *execution_id)
            {
                execution.output.push_str(text);
            }
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
        } => {
            if let Some(execution) = state
                .executions
                .iter_mut()
                .chain(state.mergers.iter_mut())
                .find(|item| item.id == *execution_id)
            {
                execution.status = "completed".into();
                execution.after = Some(head.clone());
                execution.completed_at = Some(event.timestamp);
                execution.output = output.clone();
                execution.metrics = Some(parse_execution_metrics(output, execution.started_at, event.timestamp));
                if let Some(node) = state.nodes.get_mut(&execution.node) {
                    node.status = "done".into();
                    node.head = Some(head.clone());
                }
            }
        }
        EventKind::Failed {
            node,
            execution_id,
            error,
        } => {
            let node = state.nodes.get_mut(node).unwrap();
            node.status = "failed".into();
            node.error = Some(error.clone());
            if let Some(execution) = state
                .executions
                .iter_mut()
                .chain(state.mergers.iter_mut())
                .find(|item| Some(&item.id) == execution_id.as_ref())
            {
                execution.status = "failed".into();
                execution.completed_at = Some(event.timestamp);
                execution.metrics = Some(parse_execution_metrics(&execution.output, execution.started_at, event.timestamp));
            }
        }
        EventKind::Blocked { node, error } => {
            let node = state.nodes.get_mut(node).unwrap();
            node.status = "blocked".into();
            node.error = Some(error.clone());
        }
        EventKind::Invalidated {
            nodes,
            target,
            instruction,
            human,
        } => {
            state.publication = None;
            for name in nodes {
                let never_executed = !state.executions.iter().any(|execution| execution.node == *name);
                let node = state.nodes.get_mut(name).unwrap();
                let unstarted = node.status == "waiting" || (node.status == "blocked" && never_executed);
                node.status = if unstarted { "waiting" } else { "dirty" }.into();
                node.error = None;
                if name != target {
                    node.head = None;
                }
                if *human && !unstarted {
                    node.revision += 1;
                }
            }
            let target_node = state.nodes.get_mut(target).unwrap();
            if *human {
                // A new user follow-up replaces previous instructions rather than
                // accumulating prompt suffixes across fresh executions.
                target_node.instruction = instruction.clone();
                target_node.human_instruction = !instruction.is_empty();
            } else {
                target_node.instruction.push_str(&format!("\n{instruction}"));
            }
            state.phase = if state.paused { "paused" } else { "running" }.into();
        }
        EventKind::Feedback { from, to, accepted } => {
            if !accepted {
                *state
                    .feedback_counts
                    .entry(format!("{from}->{to}"))
                    .or_default() += 1;
            }
        }
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
        EventKind::MergerFinished { execution_id, head } => {
            if let Some(execution) = state.mergers.iter_mut().find(|e| e.id == *execution_id) {
                execution.status = "completed".into();
                execution.after = Some(head.clone());
                execution.completed_at = Some(event.timestamp);
                execution.metrics = Some(parse_execution_metrics(&execution.output, execution.started_at, event.timestamp));
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
        } => {
            if let Some(execution) = state.mergers.iter_mut().find(|e| e.id == *execution_id) {
                execution.status = "failed".into();
                execution
                    .output
                    .push_str(&format!("\nMerger failed: {error}\n"));
                execution.completed_at = Some(event.timestamp);
                execution.metrics = Some(parse_execution_metrics(&execution.output, execution.started_at, event.timestamp));
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
    if matches!(&event.kind, EventKind::Output { .. }) {
        // Output only changes the event clock; execution usage/duration is
        // parsed on Finished/Failed. Preserve the live and replayed wall clock
        // without rescanning every execution for each streamed chunk.
        if let Some(metrics) = state.run_metrics.as_mut() {
            let first = state.events.first().expect("just appended an event").timestamp;
            metrics.total_duration_seconds = if event.timestamp >= first {
                (event.timestamp - first) as f64 / 1000.0
            } else {
                metrics.planning_duration_seconds + metrics.execution_duration_seconds
            };
        } else {
            state.run_metrics = Some(state.compute_run_metrics());
        }
    } else {
        state.run_metrics = Some(state.compute_run_metrics());
    }
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
    fn output_updates_wall_clock_without_changing_other_metrics() {
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
        assert_eq!(state.run_metrics.unwrap().total_duration_seconds, 3.0);
    }
}
