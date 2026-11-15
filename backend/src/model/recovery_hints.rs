//! Batched browser hints. Build execution/event indexes once per projection;
//! the individual scheduler predicates remain the authority for mutations.
use super::*;

pub(super) fn project(state: &Snapshot) -> (bool, BTreeSet<String>) {
    if !state.approved
        || matches!(
            state.phase.as_str(),
            "completed" | "publishing" | "merging" | "publication_failed"
        )
    {
        return (false, BTreeSet::new());
    }
    let superseded: BTreeSet<_> = state
        .superseded_execution_ids
        .iter()
        .map(String::as_str)
        .collect();
    let mut latest = BTreeMap::new();
    let mut latest_active = BTreeMap::new();
    let mut running = BTreeSet::new();
    for execution in &state.executions {
        latest.insert(execution.node.as_str(), execution);
        if !superseded.contains(execution.id.as_str()) {
            latest_active.insert(execution.node.as_str(), execution);
        }
        if execution.status == "running" {
            running.insert(execution.node.as_str());
        }
    }
    let mut prepared = BTreeSet::new();
    let mut failures = BTreeMap::new();
    for event in &state.events {
        match &event.kind {
            EventKind::Prepared { execution_id, .. } => {
                prepared.insert(execution_id.as_str());
            }
            EventKind::Failed {
                execution_id: Some(id),
                error,
                ..
            } => {
                failures.insert(id.as_str(), error.as_str());
            }
            _ => {}
        }
    }
    let preparation_only = |execution: &Execution| {
        execution.status == "failed"
            && execution.output_bytes == 0
            && (failures.get(execution.id.as_str()).is_some_and(|error| {
                error.starts_with("Cannot resume node session")
                    || error.starts_with("Cannot open node session")
            }) || !prepared.contains(execution.id.as_str()))
    };
    let managed = state
        .config
        .as_ref()
        .and_then(|config| config.environment.as_ref())
        .is_some();
    let mut paired_failures = BTreeSet::new();
    for pair in state.events.windows(2) {
        let (
            EventKind::Failed {
                node: failed_node,
                execution_id: Some(id),
                error: failed_error,
                ..
            },
            EventKind::Blocked {
                node: blocked_node,
                error: blocked_error,
            },
        ) = (&pair[0].kind, &pair[1].kind)
        else {
            continue;
        };
        if failed_node != blocked_node {
            continue;
        }
        let Some(node) = state
            .nodes
            .get(blocked_node)
            .filter(|node| node.status == "blocked")
        else {
            continue;
        };
        let Some(execution) = latest_active
            .get(blocked_node.as_str())
            .filter(|execution| execution.id == *id && execution.status == "failed")
        else {
            continue;
        };
        if node.error.as_ref() == Some(blocked_error)
            && (failed_error == blocked_error || (managed && preparation_only(execution)))
        {
            paired_failures.insert(blocked_node.as_str());
        }
    }
    let mut blocked_dependencies = BTreeSet::new();
    let mut failed_dependencies = BTreeSet::new();
    for edge in state.graph.edges.iter().filter(|edge| !edge.feedback) {
        if !state
            .nodes
            .get(&edge.from)
            .is_some_and(|parent| parent.status == "completed")
        {
            blocked_dependencies.insert(edge.to.as_str());
        }
        if state
            .nodes
            .get(&edge.from)
            .is_some_and(|parent| matches!(parent.status.as_str(), "failed" | "blocked"))
        {
            failed_dependencies.insert(edge.to.as_str());
        }
    }
    let latest_mergers: BTreeMap<_, _> = state
        .mergers
        .iter()
        .map(|merger| (merger.node.as_str(), merger))
        .collect();
    let candidates: BTreeSet<_> = state
        .nodes
        .iter()
        .filter_map(|(name, node)| {
            if !matches!(node.status.as_str(), "failed" | "blocked") {
                return None;
            }
            let execution = latest_active.get(name.as_str())?;
            if node.status == "failed" && execution.status == "failed" {
                return Some(name.clone());
            }
            let preparation = preparation_only(execution);
            let own_merger_failure = node.status == "blocked"
                && preparation
                && node.error.as_deref().is_some_and(|error| {
                    error.starts_with("Workspace composition blocked: Merger failed:")
                })
                && latest_mergers
                    .get(format!("merge:{name}").as_str())
                    .is_some_and(|merger| merger.status == "failed")
                && !failed_dependencies.contains(name.as_str());
            (paired_failures.contains(name.as_str())
                || own_merger_failure
                || (managed && preparation))
                .then(|| name.clone())
        })
        .collect();
    let can_resume = state.recovery_is_idle() && !candidates.is_empty();
    if candidates.is_empty() || (state.paused && state.graph.nodes.len() != 1) {
        return (can_resume, BTreeSet::new());
    }
    let mergers: Vec<_> = state
        .mergers
        .iter()
        .filter(|merger| merger.status == "running")
        .collect();
    let nodes = candidates
        .into_iter()
        .filter(|name| {
            !running.contains(name.as_str())
                && !blocked_dependencies.contains(name.as_str())
                && !mergers.iter().any(|merger| {
                    state.isolated_workspaces != Some(true)
                        || merger.node == format!("merge:{name}")
                        || latest.get(name.as_str()).is_some_and(|execution| {
                            crate::path_identity::same_path(
                                std::path::Path::new(&execution.worktree),
                                std::path::Path::new(&merger.worktree),
                            )
                        })
                })
        })
        .collect();
    (can_resume, nodes)
}
