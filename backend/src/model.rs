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
    pub max_feedback: usize,
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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeState {
    pub status: String,
    pub revision: usize,
    pub head: Option<String>,
    pub instruction: String,
    pub error: Option<String>,
}

impl Default for NodeState {
    fn default() -> Self {
        Self {
            status: "waiting".into(),
            revision: 1,
            head: None,
            instruction: String::new(),
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
    pub feedback_counts: BTreeMap<String, usize>,
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
            state.plan = crate::compiler::compile(graph, true).ok();
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
                .find(|item| item.id == *execution_id)
            {
                execution.status = "completed".into();
                execution.after = Some(head.clone());
                execution.completed_at = Some(event.timestamp);
                execution.output = output.clone();
                let node = state.nodes.get_mut(&execution.node).unwrap();
                node.status = "done".into();
                node.head = Some(head.clone());
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
                .find(|item| Some(&item.id) == execution_id.as_ref())
            {
                execution.status = "failed".into();
                execution.completed_at = Some(event.timestamp);
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
                let node = state.nodes.get_mut(name).unwrap();
                node.status = "dirty".into();
                node.error = None;
                if name != target {
                    node.head = None;
                }
                if *human {
                    node.revision += 1;
                }
            }
            state
                .nodes
                .get_mut(target)
                .unwrap()
                .instruction
                .push_str(&format!("\n{instruction}"));
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
}
