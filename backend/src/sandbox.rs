//! macOS Seatbelt path exclusions for Graph Execution Instances.
//! This is a filesystem boundary, not a host/network security sandbox: unrelated
//! host paths and networking intentionally remain available for tools and auth.
use std::{
    fs,
    path::{Path, PathBuf},
};

fn quote(path: &Path) -> Result<String, String> {
    let value = path.to_str().ok_or("Sandbox paths must be valid UTF-8")?;
    if value.chars().any(char::is_control) {
        return Err("Sandbox paths cannot contain control characters".into());
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

/// Deny the source and all other worktrees, including directories created after
/// this profile. Canonical paths prevent /var aliases and symlinks in inputs
/// from accidentally leaving the actual protected directory outside the rule.
pub fn write_graph_profile(
    path: &Path,
    repository: &Path,
    worktree_root: &Path,
    current: &Path,
) -> Result<PathBuf, String> {
    if !supported() {
        return Err("Graph sandbox requires /usr/bin/sandbox-exec on macOS".into());
    }
    let repository = repository.canonicalize().map_err(|e| e.to_string())?;
    let worktree_root = worktree_root.canonicalize().map_err(|e| e.to_string())?;
    let current = current.canonicalize().map_err(|e| e.to_string())?;
    if !current.starts_with(&worktree_root)
        || current == worktree_root
        || current.starts_with(&repository)
        || repository.starts_with(&current)
    {
        return Err("Invalid or overlapping Graph sandbox paths".into());
    }
    let mut text = format!(
        "(version 1)\n(allow default)\n\
         (deny file-read* file-write* (subpath {repository}))\n\
         (deny file-read-data file-write*\n\
           (require-all (subpath {root}) (require-not (subpath {current}))))\n\
         (deny file-read-metadata\n\
           (require-all (subpath {root}) (require-not (subpath {current}))\n\
             (require-not (literal {root})) (require-not (literal {run}))))\n",
        repository = quote(&repository)?,
        root = quote(&worktree_root)?,
        current = quote(&current)?,
        run = quote(current.parent().ok_or("Invalid execution path")?)?,
    );
    // External shadow repositories keep Git metadata outside source; explicitly deny them.
    let shadow_dir = crate::workspace::shadow_repo_dir(&repository);
    if shadow_dir.exists() {
        if let Ok(canonical_shadow) = shadow_dir.canonicalize() {
            text.push_str(&format!(
                "(deny file-read* file-write* (subpath {}))\n",
                quote(&canonical_shadow)?
            ));
        }
    }
    // Linked worktrees, separate git-dir and shadow repositories can keep the
    // shared object database outside the source folder. It contains all branch
    // snapshots and worktree locations, so it must not bypass the path boundary.
    // Standalone workspaces keep their .git strictly inside current, which is allowed.
    if current.join(".git").exists() {
        if let Ok(common) = crate::workspace::git(
            &current,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ) {
            if let Ok(common) = PathBuf::from(common).canonicalize() {
                if !common.starts_with(&current) {
                    text.push_str(&format!(
                        "(deny file-read* file-write* (subpath {}))\n",
                        quote(&common)?
                    ));
                }
            }
        }
    }
    fs::create_dir_all(path.parent().ok_or("Invalid sandbox profile path")?)
        .map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())?;
    Ok(path.to_path_buf())
}

pub fn supported() -> bool {
    cfg!(target_os = "macos") && Path::new("/usr/bin/sandbox-exec").is_file()
}
