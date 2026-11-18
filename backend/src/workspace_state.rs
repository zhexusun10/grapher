//! Slot-owned state outside the project. Identity follows the physical slot,
//! not a node/session label; the enclosing run is already a durable cleanup target.
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn is_managed_worktrees_bucket(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            if cfg!(windows)
                || (cfg!(target_os = "macos")
                    && crate::path_identity::case_insensitive_volume(path))
            {
                name.eq_ignore_ascii_case(".grapher-worktrees")
            } else {
                name == ".grapher-worktrees"
            }
        })
}

pub(crate) fn slot_digest_for_name(slot: &str) -> Result<String, String> {
    let id = git2::Oid::hash_object(git2::ObjectType::Blob, slot.as_bytes())
        .map_err(|e| e.to_string())?
        .to_string();
    Ok(id[..16].to_string())
}

pub(crate) fn slot_digest(workspace: &Path) -> Result<String, String> {
    // Resolve non-symlinked existing slots to their host directory spelling so
    // macOS/Windows case or Unicode aliases map to the same state/git digest.
    let resolved_name = if fs::symlink_metadata(workspace)
        .is_ok_and(|meta| !meta.file_type().is_symlink())
    {
        crate::path_identity::actual_path(workspace)
            .ok()
            .and_then(|actual| actual.file_name().map(std::ffi::OsStr::to_os_string))
    } else {
        None
    };
    let slot = resolved_name
        .as_deref()
        .or_else(|| workspace.file_name())
        .ok_or("Workspace has no slot identity")?;
    slot_digest_for_name(&slot.to_string_lossy())
}

pub(crate) fn root(workspace: &Path) -> Result<PathBuf, String> {
    let run = workspace
        .parent()
        .ok_or("Workspace has no owner directory")?;
    let bucket = run.parent().ok_or("Workspace has no managed parent")?;
    if !is_managed_worktrees_bucket(bucket) {
        return Err("External runtime state requires a recorded managed workspace slot".into());
    }
    Ok(run.join(".grapher-state").join(slot_digest(workspace)?))
}

pub(crate) fn process_root(workspace: &Path) -> Result<PathBuf, String> {
    Ok(root(workspace)?.join("process"))
}

/// Called only after the allocator releases the slot and all retained users.
pub(crate) fn reclaim(workspace: &Path) -> Result<(), String> {
    let root = root(workspace)?;
    let run = workspace.parent().ok_or("Missing workspace owner")?;
    if let Some(path) = crate::path_safety::real_child_path(run, &root, false)? {
        crate::workspace_cleanup::remove_tree(&path).map_err(|e| e.to_string())?;
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
