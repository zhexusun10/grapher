//! Slot-owned state outside the project. Identity follows the physical slot,
//! not a node/session label; the enclosing run is already a durable cleanup target.
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn root(workspace: &Path) -> Result<PathBuf, String> {
    let run = workspace
        .parent()
        .ok_or("Workspace has no owner directory")?;
    let bucket = run.parent().ok_or("Workspace has no managed parent")?;
    if !bucket
        .file_name()
        .is_some_and(|name| name == ".grapher-worktrees" || name == ".grapher-workspaces")
    {
        return Err("External runtime state requires a recorded managed workspace slot".into());
    }
    let slot = workspace
        .file_name()
        .ok_or("Workspace has no slot identity")?;
    // The slot name already carries a full execution UUID. Repeat it in the
    // external state path only as a fixed-length digest so Windows MAX_PATH
    // still leaves room for Git config/index lock files and agent caches.
    let id = git2::Oid::hash_object(git2::ObjectType::Blob, slot.to_string_lossy().as_bytes())
        .map_err(|e| e.to_string())?
        .to_string();
    Ok(run.join(".grapher-state").join(&id[..16]))
}

pub(crate) fn process_root(workspace: &Path) -> Result<PathBuf, String> {
    Ok(root(workspace)?.join("process"))
}

/// Called only after the allocator releases the slot and all retained users.
pub(crate) fn reclaim(workspace: &Path) -> Result<(), String> {
    let root = root(workspace)?;
    let run = workspace.parent().ok_or("Missing workspace owner")?;
    if let Some(path) = crate::path_safety::real_child_path(run, &root, false)? {
        fs::remove_dir_all(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn prepare(workspace: &Path) -> Result<PathBuf, String> {
    let root = process_root(workspace)?;
    let run = workspace.parent().ok_or("Missing workspace owner")?;
    crate::path_safety::real_child_path(run, &root, false)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    crate::path_safety::real_child_path(run, &root, false)?;
    // The project Git binding advertises this as GIT_CONFIG_GLOBAL, including
    // for plain sources whose agent may initialize Git later. Create the
    // container now; the file itself stays absent/empty until a project view or
    // Git writes it, and no host secret is copied.
    let git_config = root.join(".git-config");
    crate::path_safety::real_child_path(&root, &git_config, false)?;
    fs::create_dir_all(&git_config).map_err(|e| e.to_string())?;
    let project = workspace.canonicalize().map_err(|e| e.to_string())?;
    let state = root.canonicalize().map_err(|e| e.to_string())?;
    if crate::workspace::scope_contains(&state, &project)
        || crate::workspace::scope_contains(&project, &state)
    {
        return Err("Runtime state overlaps the project workspace".into());
    }
    Ok(root)
}
