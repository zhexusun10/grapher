//! macOS Seatbelt path exclusions for Graph Execution Instances.
//! This is a filesystem boundary, not a host/network security sandbox: unrelated
//! host paths and networking intentionally remain available for tools and auth.
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Allow platform aliases in the trusted root (e.g. /var on macOS), but
/// never let a writable exception traverse symlinks beneath that root.
fn canonical_exception(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let relative = path.strip_prefix(root)
        .map_err(|_| format!("Sandbox exception {} is outside {}", path.display(), root.display()))?;
    let mut resolved = root.canonicalize()
        .map_err(|e| format!("Cannot resolve sandbox root {}: {e}", root.display()))?;
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err("Sandbox exceptions must not contain parent traversal".into());
        };
        resolved.push(name);
        let metadata = fs::symlink_metadata(&resolved)
            .map_err(|e| format!("Cannot inspect sandbox path {}: {e}", resolved.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!("Sandbox exception must use real directories: {}", resolved.display()));
        }
    }
    Ok(resolved)
}

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
    write_profile(path, repository, worktree_root, current, None)
}

/// Production adds session/data and engine boundaries. The current session is
/// the only writable exception when runtime data lives inside the source tree.
pub fn write_execution_profile(
    path: &Path,
    repository: &Path,
    worktree_root: &Path,
    current: &Path,
    data: &Path,
    session: &Path,
    engine: &Path,
) -> Result<PathBuf, String> {
    write_profile(
        path,
        repository,
        worktree_root,
        current,
        Some((data, session, engine)),
    )
}

fn write_profile(
    path: &Path,
    repository: &Path,
    worktree_root: &Path,
    current: &Path,
    execution: Option<(&Path, &Path, &Path)>,
) -> Result<PathBuf, String> {
    if !supported() {
        return Err("Graph sandbox requires /usr/bin/sandbox-exec on macOS".into());
    }
    let current = canonical_exception(worktree_root, current)?;
    let repository = repository.canonicalize().map_err(|e| e.to_string())?;
    let worktree_root = worktree_root.canonicalize().map_err(|e| e.to_string())?;
    if !current.starts_with(&worktree_root)
        || current == worktree_root
        || current.starts_with(&repository)
        || repository.starts_with(&current)
    {
        return Err("Invalid or overlapping Graph sandbox paths".into());
    }
    let extra = execution
        .map(|(data, session, engine)| -> Result<_, String> {
            Ok((
                data.canonicalize().map_err(|e| e.to_string())?,
                canonical_exception(data, session)?,
                engine.canonicalize().map_err(|e| e.to_string())?,
            ))
        })
        .transpose()?;
    if let Some((data, session, engine)) = &extra {
        if !session.starts_with(data)
            || session == data
            || current.starts_with(session)
            || session.starts_with(&current)
            || repository.starts_with(session)
            || session.starts_with(engine)
            || engine.starts_with(session)
            || engine.starts_with(&current)
            || current.starts_with(engine)
            || engine.starts_with(&repository)
        {
            return Err("Invalid execution session or native engine location".into());
        }
    }
    // Only a Grapher-created alternate pointing at the bound repository's
    // actual object database may be read. Never trust an arbitrary alternate
    // path written by an agent when generating a profile.
    let borrowed_objects = (|| -> Option<PathBuf> {
        let alternate = fs::read_to_string(current.join(".git/objects/info/alternates")).ok()?;
        let alternate = PathBuf::from(alternate.trim()).canonicalize().ok()?;
        let expected = crate::workspace::repository_git(
            &repository, &["rev-parse", "--path-format=absolute", "--git-path", "objects"]
        ).ok()?;
        (alternate == PathBuf::from(expected).canonicalize().ok()?).then_some(alternate)
    })();
    let source_rule = if let Some((_, session, _)) = &extra {
        format!(
            "(require-all (subpath {}) (require-not (subpath {})))",
            quote(&repository)?,
            quote(session)?
        )
    } else {
        format!("(subpath {})", quote(&repository)?)
    };
    let read_source_rule = if let Some(objects) = &borrowed_objects {
        format!("(require-all {source_rule} (require-not (subpath {})))", quote(objects)?)
    } else {
        source_rule.clone()
    };
    let metadata_rule = if let Some(objects) = &borrowed_objects {
        if objects.starts_with(&repository) {
            format!("(require-all {read_source_rule} (require-not (literal {})) (require-not (literal {})))",
                quote(&repository)?, quote(objects.parent().ok_or("Invalid object path")?)?)
        } else { read_source_rule.clone() }
    } else { read_source_rule.clone() };
    let mut text = format!(
        "(version 1)\n(allow default)\n\
         (deny file-read-data {read_source_rule})\n\
         (deny file-read-metadata {metadata_rule})\n\
         (deny file-write* {source_rule})\n\
         (deny file-read-data file-write*\n\
           (require-all (subpath {root}) (require-not (subpath {current}))))\n\
         (deny file-read-metadata\n\
           (require-all (subpath {root}) (require-not (subpath {current}))\n\
             (require-not (literal {root})) (require-not (literal {run}))))\n",
        root = quote(&worktree_root)?,
        current = quote(&current)?,
        run = quote(current.parent().ok_or("Invalid execution path")?)?,
    );
    if let Some((data, session, engine)) = &extra {
        let data_rule = format!("(require-all (subpath {}) (require-not (subpath {})))",
            quote(data)?, quote(session)?);
        if let Some(objects) = borrowed_objects.as_ref().filter(|p| p.starts_with(data)) {
            let read_rule = format!("(require-all {data_rule} (require-not (subpath {})))", quote(objects)?);
            let mut ancestors = String::new();
            let mut parent = objects.parent();
            while let Some(dir) = parent.filter(|dir| dir.starts_with(data)) {
                ancestors.push_str(&format!(" (require-not (literal {}))", quote(dir)?));
                parent = dir.parent();
            }
            text.push_str(&format!("(deny file-read-data {read_rule})\n(deny file-read-metadata (require-all {read_rule}{ancestors}))\n"));
        } else {
            text.push_str(&format!("(deny file-read* {data_rule})\n"));
        }
        text.push_str(&format!("(deny file-write* {data_rule})\n(deny file-write* (subpath {}))\n", quote(engine)?));
    }
    // External shadow repositories keep Git metadata outside source; explicitly deny them.
    let shadow_dir = crate::workspace::shadow_repo_dir(&repository)?;
    if shadow_dir.exists() || shadow_dir.is_symlink() {
        let canonical_shadow = shadow_dir.canonicalize()
            .map_err(|e| format!("Cannot resolve shadow repository {}: {e}", shadow_dir.display()))?;
        append_git_dir_rule(&mut text, &canonical_shadow, borrowed_objects.as_deref())?;
    }
    // Source linked worktrees can keep all node snapshots in a shared Git
    // directory outside the source path. Protect that database as well.
    if let Ok(common) = crate::workspace::repository_git(
        &repository,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ) {
        let common = PathBuf::from(common).canonicalize().map_err(|e| e.to_string())?;
        if !common.starts_with(&repository) && !common.starts_with(&current) {
            append_git_dir_rule(&mut text, &common, borrowed_objects.as_deref())?;
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
            let common = PathBuf::from(common).canonicalize().map_err(|e| e.to_string())?;
            if !common.starts_with(&current) {
                text.push_str(&format!(
                    "(deny file-read* file-write* (subpath {}))\n",
                    quote(&common)?
                ));
            }
        }
    }
    fs::create_dir_all(path.parent().ok_or("Invalid sandbox profile path")?)
        .map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())?;
    Ok(path.to_path_buf())
}

fn append_git_dir_rule(text: &mut String, git_dir: &Path, borrowed: Option<&Path>) -> Result<(), String> {
    let rule = format!("(subpath {})", quote(git_dir)?);
    if let Some(objects) = borrowed.filter(|objects| objects.starts_with(git_dir)) {
        text.push_str(&format!("(deny file-read-data (require-all {rule} (require-not (subpath {}))))\n", quote(objects)?));
        text.push_str(&format!("(deny file-read-metadata (require-all {rule} (require-not (subpath {})) (require-not (literal {}))))\n",
            quote(objects)?, quote(git_dir)?));
    } else {
        text.push_str(&format!("(deny file-read* {rule})\n"));
    }
    text.push_str(&format!("(deny file-write* {rule})\n"));
    Ok(())
}

pub fn supported() -> bool {
    cfg!(target_os = "windows") || (cfg!(target_os = "macos") && Path::new("/usr/bin/sandbox-exec").is_file())
}
