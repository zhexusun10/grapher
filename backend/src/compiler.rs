use crate::model::{Graph, Plan};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    // E209 evidence lets callers distinguish an existing redundant edge from
    // a rejected addition without parsing node ids out of diagnostic prose.
    #[serde(
        default,
        rename = "dependencyPath",
        skip_serializing_if = "Option::is_none"
    )]
    pub dependency_path: Option<Vec<String>>,
}

// Advisory facts, not rendered messages, define identity across two candidates.
// No session history is involved: a resolved warning can reappear on a later edit.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum Advisory<'a> {
    DuplicateTask { task: &'a str, nodes: Vec<&'a str> },
    MissingFeedback { node: &'a str },
}

impl Advisory<'_> {
    fn code(&self) -> &'static str {
        match self {
            Self::DuplicateTask { .. } => "W301",
            Self::MissingFeedback { .. } => "W302",
        }
    }

    fn message(&self, multiline: bool) -> String {
        match self {
            Self::DuplicateTask { nodes, .. } if multiline => format!(
                "{} nodes have identical task text; they may duplicate work. Confirm that this is intentional.\n- {}",
                nodes.len(), nodes.join("\n- ")
            ),
            Self::DuplicateTask { nodes, .. } => format!(
                "Nodes {} have identical task text; they may duplicate work. Confirm that this is intentional.",
                nodes.join(", ")
            ),
            Self::MissingFeedback { node } => format!(
                "{node} mentions <FEEDBACK> but has no outgoing feedback edge; the marker cannot send feedback."
            ),
        }
    }
}

fn advisories(graph: &Graph) -> Vec<Advisory<'_>> {
    // Compare literal task text, not inferred intent or overlapping file paths.
    let mut task_nodes: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for node in &graph.nodes {
        task_nodes.entry(&node.task).or_default().insert(&node.id);
    }
    let mut warnings: Vec<_> = task_nodes.into_iter()
        .filter(|(_, nodes)| nodes.len() > 1)
        .map(|(task, nodes)| Advisory::DuplicateTask { task, nodes: nodes.into_iter().collect() })
        .collect();
    for node in &graph.nodes {
        if node.task.contains("<FEEDBACK>")
            && !graph.edges.iter().any(|edge| edge.feedback && edge.from == node.id)
        {
            warnings.push(Advisory::MissingFeedback { node: &node.id });
        }
    }
    warnings
}

/// Planner-only projection. Full Plan warnings and all blocking diagnostics stay
/// unchanged. Compare the saved candidate, not the runtime's committed graph.
pub fn changed_advisories(before: &Graph, after: &Graph) -> Vec<Diagnostic> {
    let previous: BTreeSet<_> = advisories(before).into_iter().collect();
    advisories(after).into_iter()
        .filter(|warning| !previous.contains(warning))
        .map(|warning| Diagnostic {
            code: warning.code().into(),
            message: warning.message(true),
            dependency_path: None,
        })
        .collect()
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
        let neighbors: BTreeSet<_> = graph
            .edges
            .iter()
            .filter(|edge| {
                !edge.feedback && edge.from == name && !(edge.from == from && edge.to == to)
            })
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

/// Graph node IDs may contain any text. Worktree directories and Git refs use
/// a deterministic, safe path component: portable IDs map to themselves;
/// everything else becomes a bounded slug plus a short content hash.
pub fn node_id(name: &str) -> String {
    if is_portable_node_id(name) {
        return name.to_string();
    }
    let mut slug = String::new();
    let mut separator = false;
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            separator = false;
        } else if !separator && !slug.is_empty() {
            slug.push('-');
            separator = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.len() > 24 {
        slug.truncate(24);
        while slug.ends_with('-') {
            slug.pop();
        }
    }
    if slug.is_empty() {
        slug.push_str("node");
    }
    // A dotted hash is an extension on Windows: CON.<hash> is still a
    // device name. Escape the stem before adding the deterministic suffix.
    if is_windows_reserved_name(&slug) {
        slug.push_str("-node");
    }
    let digest = git2::Oid::hash_object(git2::ObjectType::Blob, name.as_bytes())
        .map(|oid| oid.to_string())
        .unwrap_or_else(|_| "0000000000000000000000000000000000000000".into());
    let short = digest.get(..12).unwrap_or(digest.as_str());
    format!("{slug}.{short}")
}

fn is_windows_reserved_name(name: &str) -> bool {
    let device = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(
        device.as_str(),
        "con" | "prn" | "aux" | "nul" | "conin$" | "conout$"
    ) || ((device.starts_with("com") || device.starts_with("lpt"))
        && device.chars().count() == 4
        && device.ends_with(['1', '2', '3', '4', '5', '6', '7', '8', '9']))
}

fn is_portable_node_id(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        && !is_windows_reserved_name(name)
}

/// Runtime-state constraint surfaced at the Planner tool boundary: once a
/// run has published, a node whose result was delivered may be reworked (a
/// task change invalidates and re-runs it) but never removed. Graph structure
/// alone cannot express this, so the caller supplies the run's unremovable
/// node IDs and a missing one is reported as an actionable diagnostic
/// instead of failing the whole commit inside Runtime.
pub fn unremovable_node_diagnostics(graph: &Graph, unremovable: &[String]) -> Vec<Diagnostic> {
    unremovable
        .iter()
        .filter(|name| !graph.nodes.iter().any(|node| &node.id == *name))
        .map(|name| Diagnostic {
            code: "E210".into(),
            message: format!(
                "Cannot remove node '{name}': its workspace state is already published in this run.",
            ),
            dependency_path: None,
        })
        .collect()
}

pub fn compile(graph: &Graph, final_check: bool) -> Result<Plan, Vec<Diagnostic>> {
    let mut errors = Vec::new();
    let mut add = |code: &str, message: String| {
        errors.push(Diagnostic {
            code: code.into(),
            message,
            dependency_path: None,
        })
    };
    if final_check && graph.nodes.is_empty() {
        add("E001", "Graph must contain at least one node".into());
    }
    let mut names = BTreeSet::new();
    let mut folded_names = BTreeMap::new();
    for node in &graph.nodes {
        if node.id.is_empty() {
            add("E201", "Node id must not be empty".into());
        }
        if !names.insert(node.id.clone()) {
            add("E202", format!("Duplicate node: {}", node.id));
        } else if let Some(previous) =
            folded_names.insert(node.id.to_lowercase(), node.id.clone())
        {
            add("E202", format!(
                "Node ids '{previous}' and '{}' differ only by case and would collide on case-insensitive filesystems",
                node.id
            ));
        }
        if node.task.trim().is_empty() {
            add(
                "E203",
                format!(
                    "Node '{}' has an empty task. Each node must have a non-empty task description that will be passed to the executor.",
                    node.id
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
                "Feedback source {source} has multiple targets: {}. A feedback verdict does not identify a target, so each source may have at most one feedback target. Consider restructuring feedback ownership rather than merely dropping routes: possible approaches include separate feedback sources for independent workstreams or a shared owner responsible for reworking the combined result. Choose what fits the task, and check that node tasks remain consistent with the resulting feedback routes.",
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
                let degree = degrees.get_mut(&edge.to).ok_or_else(|| {
                    vec![Diagnostic {
                        code: "E204".into(),
                        message: format!("Unknown endpoint: {}", edge.to),
                        dependency_path: None,
                    }]
                })?;
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
            dependency_path: None,
        }]);
    }
    for edge in graph.edges.iter().filter(|edge| edge.feedback) {
        if !downstream(graph, &edge.to).contains(&edge.from) {
            errors.push(Diagnostic { code: "E207".into(), message: format!("Feedback {} → {} requires a dependency path from {} to {}. Nodes currently reachable from {} through dependencies: {}. Feedback does not provide execution ordering.", edge.from, edge.to, edge.to, edge.from, edge.to, downstream(graph, &edge.to).into_iter().collect::<Vec<_>>().join(", ")), dependency_path: None });
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    for edge in &dependencies {
        if let Some(path) = alternate_dependency_path(graph, &edge.from, &edge.to) {
            errors.push(Diagnostic {
                code: "E209".into(),
                message: format!(
                    "Redundant dependency {} → {}. Remove this direct edge: {} already provides execution ordering and carries upstream workspace results to {}.",
                    edge.from, edge.to, path.join(" → "), edge.to
                ),
                dependency_path: Some(path),
            });
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let mut warnings: Vec<_> = advisories(graph).into_iter()
        .map(|warning| format!("{}: {}", warning.code(), warning.message(false)))
        .collect();
    for edge in graph.edges.iter().filter(|edge| edge.feedback) {
        // Match the runtime's invalidation set exactly: target plus dependency
        // descendants, without following other feedback edges or judging size.
        // Keep one W303 per feedback edge in graph order for Planner projection.
        warnings.push(format!(
            "W303: If <FEEDBACK> is sent from {} to {}, these nodes will rerun: {}.",
            edge.from,
            edge.to,
            downstream(graph, &edge.to)
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    Ok(Plan {
        execution_batches: batches,
        root_nodes: roots,
        terminals,
        warnings,
    })
}

#[cfg(test)]
mod node_id_tests {
    use super::*;

    #[test]
    fn windows_device_names_never_become_git_ref_components() {
        let temp = tempfile::tempdir().unwrap();
        for name in [
            "CON", "con", "NUL", "COM1", "lpt9", "AUX", "PRN", "CONIN$", "CONOUT$", "con...",
            "NUL ", "COM1!",
        ] {
            let id = node_id(name);
            assert_ne!(id, name);
            assert!(
                !is_windows_reserved_name(&id),
                "{name:?} produced a reserved component: {id}"
            );
            // Windows rejects reserved device stems even with a .hash suffix.
            // Exercise real paths, not just the shape of the generated string.
            let directory = temp.path().join(&id);
            std::fs::create_dir(&directory).unwrap();
            std::fs::write(directory.join("marker"), name).unwrap();
            assert_eq!(
                std::fs::read_to_string(directory.join("marker")).unwrap(),
                name
            );
        }
        assert_eq!(node_id("worker"), "worker");
    }

    #[test]
    fn case_only_node_names_are_rejected_for_portable_refs() {
        let graph = Graph {
            original_goal: String::new(),
            nodes: vec![
                crate::model::Node {
                    id: "Worker".into(),
                    task: "one".into(),
                },
                crate::model::Node {
                    id: "worker".into(),
                    task: "two".into(),
                },
            ],
            edges: vec![],
        };
        let errors = compile(&graph, true).unwrap_err();
        assert!(errors
            .iter()
            .any(|error| error.code == "E202" && error.message.contains("differ only by case")));
    }
}
