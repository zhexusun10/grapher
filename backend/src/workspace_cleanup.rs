//! Run-owned directory cleanup. Never use an execution's arbitrary cwd as a
//! deletion target: Serial/Planner cwd may be the user's source; borrowed node
//! slots are already covered by their recorded Run-owned workspace root.
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
            | EventKind::PlanningFailed { planning }
            | EventKind::PlannerReviewStarted { planning }
            | EventKind::PlannerReviewFinished { planning, .. }
            | EventKind::PlannerTurnAborted { planning }
            | EventKind::PlannerWorkspaceSelected { planning } => {
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
        match remove_tree(path) {
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

/// Recursively remove an owned tree without following links or junctions.
///
/// `fs::remove_dir_all` lists a directory before deleting it. Windows shell
/// caches such as `INetCache\Content.IE5` are reparse points carrying an
/// explicit `Everyone:(DENY)(RD)` ACE, so listing them fails with access denied
/// (os error 5) and the cleanup would retry forever. Unlink such entries from
/// their parent instead of descending into them, and clear read-only attributes
/// that block deletion.
///
/// Shared with other callers that delete Run-owned agent workspaces, which can
/// contain the same protected Windows shell caches.
pub(crate) fn remove_tree(path: &Path) -> std::io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(cleanup_error("inspect", path, error)),
    };
    if is_link_or_reparse(&metadata) {
        // Never follow a link to clear the target's attributes; the link itself
        // (junctions, symlinks) is removed without needing that.
        return remove_link(path, &metadata).map_err(|error| cleanup_error("unlink", path, error));
    }
    if metadata.is_dir() {
        let entries = fs::read_dir(path).map_err(|error| cleanup_error("list", path, error))?;
        for entry in entries {
            let entry = entry.map_err(|error| cleanup_error("list entry in", path, error))?;
            remove_tree(&entry.path())?;
        }
        remove_directory(path, &metadata).map_err(|error| cleanup_error("remove directory", path, error))
    } else {
        clear_readonly(path, &metadata).map_err(|error| cleanup_error("clear read-only attribute on", path, error))?;
        fs::remove_file(path).map_err(|error| cleanup_error("remove file", path, error))
    }
}

fn cleanup_error(operation: &str, path: &Path, error: std::io::Error) -> std::io::Error {
    std::io::Error::new(error.kind(), format!("Cannot {operation} {}: {error}", path.display()))
}

/// Try plain removal first. Windows can reject a read-only directory with
/// access denied, even when its ACL permits deletion.
fn remove_directory(path: &Path, metadata: &fs::Metadata) -> std::io::Result<()> {
    match fs::remove_dir(path) {
        #[cfg(windows)]
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied && metadata.permissions().readonly() => {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_WRITE_ATTRIBUTES: u32 = 0x100;
            const FILE_SHARE_ALL: u32 = 0x7;
            const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x02000000;
            const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
            // Open the directory itself, never a substituted link's target.
            let directory = fs::OpenOptions::new()
                .access_mode(FILE_WRITE_ATTRIBUTES)
                .share_mode(FILE_SHARE_ALL)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
                .map_err(|error| cleanup_error("open directory to clear read-only attribute on", path, error))?;
            let mut permissions = directory.metadata()?.permissions();
            permissions.set_readonly(false);
            directory.set_permissions(permissions)
                .map_err(|error| cleanup_error("clear read-only attribute on", path, error))?;
            drop(directory);
            fs::remove_dir(path)
        }
        result => {
            let _ = metadata;
            result
        }
    }
}

/// Detect links and Windows reparse points. Besides symlinks this also covers
/// other reparse tags (for example dedup or appexeclink) that `is_symlink`
/// does not report but must never be recursed into.
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

/// Remove a link itself, never its target.
///
/// Rust reports Windows junctions as `is_symlink` with `is_dir == false`, so
/// decide directory-ness from the raw `FILE_ATTRIBUTE_DIRECTORY` bit; a
/// junction or directory symlink must be unlinked with `remove_dir`.
fn remove_link(path: &Path, metadata: &fs::Metadata) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
        if metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0 {
            return fs::remove_dir(path);
        }
    }
    let _ = metadata;
    fs::remove_file(path)
}

/// A read-only attribute blocks `remove_file` on Windows.
fn clear_readonly(path: &Path, metadata: &fs::Metadata) -> std::io::Result<()> {
    #[cfg(windows)]
    if metadata.permissions().readonly() {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions)?;
    }
    let _ = (path, metadata);
    Ok(())
}
