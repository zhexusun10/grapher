use crate::model::{Graph, Plan};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

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

pub fn compile(graph: &Graph, final_check: bool) -> Result<Plan, Vec<Diagnostic>> {
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
    if graph.nodes.len() > 64 {
        add("E002", "MVP supports at most 64 nodes".into());
    }
    let mut names = BTreeSet::new();
    for node in &graph.nodes {
        if node.name.is_empty()
            || node.name.len() > 64
            || !node.name.chars().all(|character| {
                character.is_ascii_alphanumeric() || character == '_' || character == '-'
            })
        {
            add(
                "E201",
                format!(
                    "Invalid semantic node name: {:?}. Use 1–64 ASCII letters, digits, _ or -",
                    node.name
                ),
            );
        }
        if !names.insert(node.name.clone()) {
            add("E202", format!("Duplicate node: {}", node.name));
        }
        if node.task.trim().is_empty() {
            add("E203", format!("Empty task: {}", node.name));
        }
    }
    let mut pairs = BTreeSet::new();
    for edge in &graph.edges {
        if !names.contains(&edge.from) || !names.contains(&edge.to) {
            add(
                "E204",
                format!("Unknown endpoint in {} → {}. Missing: {}. Existing nodes: {}. Create missing nodes with node before adding this edge, or correct the endpoint names.", edge.from, edge.to,
                    [&edge.from, &edge.to].into_iter().filter(|name| !names.contains(*name)).cloned().collect::<Vec<_>>().join(", "),
                    names.iter().cloned().collect::<Vec<_>>().join(", ")),
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
    if !errors.is_empty() {
        return Err(errors);
    }
    let dependencies: Vec<_> = graph.edges.iter().filter(|edge| !edge.feedback).collect();
    let mut degrees: BTreeMap<String, usize> = names.iter().map(|name| (name.clone(), 0)).collect();
    for edge in &dependencies {
        *degrees.get_mut(&edge.to).unwrap() += 1;
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
                let degree = degrees.get_mut(&edge.to).unwrap();
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
                "Dependency cycle detected. Nodes in or blocked by the cycle: {}. Dependency edges within this unresolved set: {}. Remove or redirect a dependency to break the cycle. Use feedback=true only when the relationship is a revision route to a dependency ancestor.",
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
            errors.push(Diagnostic { code: "E207".into(), message: format!("Feedback {} → {} requires a dependency path from {} to {}. Nodes currently reachable from {} through dependencies: {}. Create the needed dependency path first, or choose an existing ancestor as the revision target. Feedback does not provide execution ordering.", edge.from, edge.to, edge.to, edge.from, edge.to, downstream(graph, &edge.to).into_iter().collect::<Vec<_>>().join(", ")) });
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let mut warnings: Vec<String> = if names.len() > 1 {
        names.iter().filter(|name| !graph.edges.iter().any(|edge| &edge.from == *name || &edge.to == *name)).map(|name| format!("W301: {name} is an isolated independent terminal; confirm it contributes to the goal")).collect()
    } else {
        Vec::new()
    };
    for node in &graph.nodes {
        if node.task.contains("<REVISE>") && !graph.edges.iter().any(|edge| edge.feedback && edge.from == node.name) {
            warnings.push(format!("W302: {} mentions <REVISE> but has no outgoing feedback edge. The marker alone cannot request a retry. If revision is required, connect a feedback edge to an authorized dependency ancestor; otherwise remove the retry instruction or state that it is only report text.", node.name));
        }
    }
    Ok(Plan {
        execution_batches: batches,
        roots,
        terminals,
        warnings,
    })
}
