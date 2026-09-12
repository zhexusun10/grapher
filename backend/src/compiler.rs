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
                    "Invalid semantic node name: {}. Use letters, digits, _ or -",
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
                format!("Unknown node in {} → {}", edge.from, edge.to),
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
                "Dependency cycle among: {}. Only explicit feedback edges may form cycles.",
                names
                    .difference(&visited)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" → ")
            ),
        }]);
    }
    for edge in graph.edges.iter().filter(|edge| edge.feedback) {
        if !downstream(graph, &edge.to).contains(&edge.from) {
            errors.push(Diagnostic { code: "E207".into(), message: format!("Feedback {} → {} must return to a dependency ancestor; create its dependency path first", edge.from, edge.to) });
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let warnings = if names.len() > 1 {
        names.iter().filter(|name| !graph.edges.iter().any(|edge| &edge.from == *name || &edge.to == *name)).map(|name| format!("W301: {name} is an isolated independent terminal; confirm it contributes to the goal")).collect()
    } else {
        Vec::new()
    };
    Ok(Plan {
        execution_batches: batches,
        roots,
        terminals,
        warnings,
    })
}
