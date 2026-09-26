use crate::model::{Graph, Plan};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
}

pub fn downstream(graph: &Graph, start: &str) -> BTreeSet<String> {
    let mut seen = BTreeSet::from([start.to_string()]);
    let mut pending = vec![start.to_string()];
    while let Some(name) = pending.pop() {
        for edge in graph
            .edges
            .iter()
            .filter(|edge| !edge.feedback && edge.from == name)
        {
            if seen.insert(edge.to.clone()) {
                pending.push(edge.to.clone());
            }
        }
    }
    seen
}

fn alternate_dependency_path(graph: &Graph, from: &str, to: &str) -> Option<Vec<String>> {
    let mut queue = VecDeque::from([from.to_string()]);
    let mut previous = BTreeMap::<String, Option<String>>::from([(from.to_string(), None)]);
    while let Some(name) = queue.pop_front() {
        let neighbors: BTreeSet<_> = graph.edges.iter()
            .filter(|edge| !edge.feedback && edge.from == name && !(edge.from == from && edge.to == to))
            .map(|edge| edge.to.clone())
            .collect();
        for next in neighbors {
            if previous.contains_key(&next) {
                continue;
            }
            previous.insert(next.clone(), Some(name.clone()));
            if next == to {
                let mut path = vec![next];
                while let Some(Some(parent)) = path.last().and_then(|last| previous.get(last)) {
                    path.push(parent.clone());
                }
                path.reverse();
                return Some(path);
            }
            queue.push_back(next);
        }
    }
    None
}

/// Node names also become Git snapshot refs; keep the contract shared.
pub fn validate_node_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64
        || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(format!("Invalid node name {name:?}: use 1–64 ASCII letters, digits, '_' or '-'."));
    }
    Ok(())
}

pub fn compile(graph: &Graph, final_check: bool) -> Result<Plan, Vec<Diagnostic>> {
    compile_with_policy(graph, final_check, true)
}

/// Replay persisted graphs from older runs without changing their historical
/// plan. New graph mutations and runs use `compile`, which rejects redundancy.
pub fn compile_legacy(graph: &Graph, final_check: bool) -> Result<Plan, Vec<Diagnostic>> {
    compile_with_policy(graph, final_check, false)
}

fn compile_with_policy(graph: &Graph, final_check: bool, reject_redundant: bool) -> Result<Plan, Vec<Diagnostic>> {
    let mut errors = Vec::new();
    let mut add = |code: &str, message: String| {
        errors.push(Diagnostic {
            code: code.into(),
            message,
        })
    };
    if final_check && graph.nodes.is_empty() {
        add("E001", "Graph must contain at least one node".into());
    }
    let mut names = BTreeSet::new();
    for node in &graph.nodes {
        if let Err(message) = validate_node_name(&node.name) {
            add("E201", message);
        }
        if !names.insert(node.name.clone()) {
            add("E202", format!("Duplicate node: {}", node.name));
        }
        if node.task.trim().is_empty() {
            add(
                "E203",
                format!(
                    "Node '{}' has an empty task. Each node must have a non-empty task description that will be passed to the executor.",
                    node.name
                ),
            );
        }
    }
    let mut pairs = BTreeSet::new();
    for edge in &graph.edges {
        if !names.contains(&edge.from) || !names.contains(&edge.to) {
            add(
                "E204",
                format!(
                    "Unknown endpoint in {} → {}. Missing: {}. Existing nodes: {}.",
                    edge.from,
                    edge.to,
                    [&edge.from, &edge.to]
                        .into_iter()
                        .filter(|name| !names.contains(*name))
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", "),
                    names.iter().cloned().collect::<Vec<_>>().join(", ")
                ),
            );
        }
        if edge.from == edge.to {
            add("E205", format!("Self edge is not allowed: {}", edge.from));
        }
        if !pairs.insert((&edge.from, &edge.to)) {
            add(
                "E206",
                format!("Duplicate edge: {} → {}", edge.from, edge.to),
            );
        }
    }
    let mut feedback_targets: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for edge in graph.edges.iter().filter(|edge| edge.feedback) {
        feedback_targets
            .entry(&edge.from)
            .or_default()
            .insert(&edge.to);
    }
    for (source, targets) in feedback_targets
        .into_iter()
        .filter(|(_, targets)| targets.len() > 1)
    {
        add(
            "E208",
            format!(
                "Feedback source {source} has multiple targets: {}. A feedback verdict does not identify a target, so each source may have at most one feedback target.",
                targets.into_iter().collect::<Vec<_>>().join(", ")
            ),
        );
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let dependencies: Vec<_> = graph.edges.iter().filter(|edge| !edge.feedback).collect();
    let mut degrees: BTreeMap<String, usize> = names.iter().map(|name| (name.clone(), 0)).collect();
    for edge in &dependencies {
        *degrees.entry(edge.to.clone()).or_default() += 1;
    }
    let roots: Vec<_> = degrees
        .iter()
        .filter(|(_, degree)| **degree == 0)
        .map(|(name, _)| name.clone())
        .collect();
    let terminals = names
        .iter()
        .filter(|name| !dependencies.iter().any(|edge| &edge.from == *name))
        .cloned()
        .collect();
    let mut batches = Vec::new();
    let mut ready = roots.clone();
    let mut visited = BTreeSet::new();
    while !ready.is_empty() {
        batches.push(ready.clone());
        let mut next = BTreeSet::new();
        for name in &ready {
            visited.insert(name.clone());
            for edge in dependencies.iter().filter(|edge| edge.from == *name) {
                let degree = degrees.get_mut(&edge.to).ok_or_else(|| vec![Diagnostic {
                    code: "E204".into(),
                    message: format!("Unknown endpoint: {}", edge.to),
                }])?;
                *degree -= 1;
                if *degree == 0 {
                    next.insert(edge.to.clone());
                }
            }
        }
        ready = next.into_iter().collect();
    }
    if visited.len() != names.len() {
        return Err(vec![Diagnostic {
            code: "E101".into(),
            message: format!(
                "Dependency cycle detected. Nodes in or blocked by the cycle: {}. Dependency edges within this unresolved set: {}.",
                names
                    .difference(&visited)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", "),
                dependencies.iter()
                    .filter(|edge| !visited.contains(&edge.from) && !visited.contains(&edge.to))
                    .map(|edge| format!("{} → {}", edge.from, edge.to))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }]);
    }
    for edge in graph.edges.iter().filter(|edge| edge.feedback) {
        if !downstream(graph, &edge.to).contains(&edge.from) {
            errors.push(Diagnostic { code: "E207".into(), message: format!("Feedback {} → {} requires a dependency path from {} to {}. Nodes currently reachable from {} through dependencies: {}. Feedback does not provide execution ordering.", edge.from, edge.to, edge.to, edge.from, edge.to, downstream(graph, &edge.to).into_iter().collect::<Vec<_>>().join(", ")) });
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    if reject_redundant {
        for edge in &dependencies {
            if let Some(path) = alternate_dependency_path(graph, &edge.from, &edge.to) {
                errors.push(Diagnostic {
                    code: "E209".into(),
                    message: format!(
                        "Redundant dependency {} → {}. Remove this direct edge: {} already provides execution ordering and carries upstream filesystem state to {}.",
                        edge.from, edge.to, path.join(" → "), edge.to
                    ),
                });
            }
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let mut warnings = Vec::new();
    for node in &graph.nodes {
        if node.task.contains("<REVISE>")
            && !graph
                .edges
                .iter()
                .any(|edge| edge.feedback && edge.from == node.name)
        {
            warnings.push(format!("W302: {} mentions <REVISE> but has no outgoing feedback edge; the marker cannot trigger revision.", node.name));
        }
    }
    Ok(Plan {
        execution_batches: batches,
        roots,
        terminals,
        warnings,
    })
}
