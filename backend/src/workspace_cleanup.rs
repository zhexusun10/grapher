//! Run-owned directory cleanup. Never use an execution's arbitrary cwd as a
//! deletion target: Serial executions and modern Planners use the user's source.
use crate::{
    model::{EventKind, Snapshot},
    path_safety::real_child_path,
};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(crate) fn planning_ids(root: &Path, state: &Snapshot) -> Result<BTreeSet<String>, String> {
    let mut ids = BTreeSet::new();
    if let Some(id) = &state.planning_id {
        ids.insert(id.clone());
    }
    if let Some(summary) = &state.planning {
        ids.insert(summary.planning_id.clone());
    }
    for event in &state.events {
        match &event.kind {
            EventKind::Created {
                planning_id,
                planning,
                ..
            } => {
                ids.extend(planning_id.iter().cloned());
                ids.extend(planning.iter().map(|summary| summary.planning_id.clone()));
            }
            EventKind::GraphRevised {
                planning_id,
                planning,
                ..
            } => {
                ids.insert(planning_id.clone());
                ids.insert(planning.planning_id.clone());
            }
            EventKind::PlanningStarted { planning, .. }
            | EventKind::PlanningFailed { planning } => {
                ids.insert(planning.planning_id.clone());
            }
            _ => {}
        }
    }
    // Failed/cancelled revisions may have no GraphRevised event. Their durable
    // requests still identify the owning Run, including reused Planner copies.
    if let Some(directory) = real_child_path(root, &root.join("planning"), false)? {
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if Uuid::parse_str(&id).is_err() {
                continue;
            }
            let request = root.join("planning").join(&id).join("request.json");
            let Ok(Some(request)) = real_child_path(root, &request, true) else {
                continue;
            };
            let Some(request) = fs::read(request)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            else {
                continue;
            };
            if request["runId"].as_str() == Some(&state.run_id)
                || request["revisionRunId"].as_str() == Some(&state.run_id)
            {
                ids.insert(id);
            }
        }
    }
    ids.retain(|id| !id.is_empty() && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    Ok(ids)
}

/// Legacy Planner markers can name a provisional UUID different from the
/// committed Run's UUID. Only remove the marked checkout, never its siblings.
pub(crate) fn planning_workspace_paths(
    root: &Path,
    state: &Snapshot,
    parent: &Path,
) -> Result<Vec<PathBuf>, String> {
    let workspaces = parent.join(".grapher-workspaces");
    let mut paths = Vec::new();
    for id in planning_ids(root, state)? {
        let marker = root.join("planning").join(id).join("planner-workspace");
        let Some(marker) = real_child_path(root, &marker, true)? else {
            continue;
        };
        let path = PathBuf::from(fs::read_to_string(marker).map_err(|error| error.to_string())?);
        let Some(owner) = path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
        else {
            continue;
        };
        let Some(checkout) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if Uuid::parse_str(owner).is_err() || Uuid::parse_str(checkout).is_err() {
            continue;
        }
        // Reconstruct under the trusted physical project parent. A source cwd,
        // forged external path, traversal, or alias parent cannot authorize removal.
        let expected = workspaces.join(owner).join(checkout);
        let Some(actual_root) = path
            .parent()
            .and_then(Path::parent)
            .and_then(|p| p.canonicalize().ok())
        else {
            continue;
        };
        if workspaces.canonicalize().ok().as_ref() != Some(&actual_root) {
            continue;
        }
        if let Some(path) = real_child_path(parent, &expected, false)? {
            paths.push(path);
        }
    }
    Ok(paths)
}

/// Collect/validate the entire plan before calling this. Removing a Run root
/// recursively includes all node executions, retries, and preparation copies.
pub(crate) fn remove_paths(paths: Vec<PathBuf>) -> Result<(), String> {
    let paths: BTreeSet<_> = paths.into_iter().collect();
    for path in &paths {
        if paths
            .iter()
            .any(|ancestor| ancestor != path && path.starts_with(ancestor))
        {
            continue;
        }
        match fs::remove_dir_all(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot remove owned directory {}: {error}", path.display())),
        }
        // A legacy Planner owner may now be empty. Never recursively remove
        // that parent; another conversation may still have a checkout there.
        if path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .is_some_and(|name| name == ".grapher-workspaces")
        {
            if let Some(parent) = path.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
    }
    Ok(())
}
