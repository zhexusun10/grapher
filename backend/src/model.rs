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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub execution_batches: Vec<Vec<String>>,
    pub roots: Vec<String>,
    pub terminals: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub repository: String,
    pub engine: String,
    pub pi_command: String,
    pub pi_args: Vec<String>,
    pub model: String,
    pub max_parallel: usize,
    pub max_feedback: usize,
}

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
    Settled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub sequence: i64,
    pub timestamp: u64,
    #[serde(flatten)]
    pub kind: EventKind,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub run_id: String,
    pub graph: Graph,
    pub config: Option<Config>,
    pub plan: Option<Plan>,
    pub nodes: BTreeMap<String, NodeState>,
    pub executions: Vec<Execution>,
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
        EventKind::Created { graph, config } => {
            state.graph = graph.clone();
            state.config = Some(config.clone());
            state.plan = crate::compiler::compile(graph, true).ok();
            state.nodes = graph
                .nodes
                .iter()
                .map(|node| (node.name.clone(), NodeState::default()))
                .collect();
            state.phase = "awaiting_approval".into();
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
