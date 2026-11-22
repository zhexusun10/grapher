//! macOS Seatbelt path exclusions for Graph Execution Instances.
//! This is a filesystem boundary, not a host/network security sandbox: unrelated
//! host paths and networking intentionally remain available for tools and auth.
use std::{
    fs,
    path::{Path, PathBuf},
};

fn kernel_path(path: &Path) -> Result<PathBuf, String> {
    let resolved = path.canonicalize().map_err(|e| e.to_string())?;
    Ok(crate::path_identity::actual_path(&resolved).unwrap_or(resolved))
}

/// Allow platform aliases in the trusted root (e.g. /var on macOS), but
/// never let a writable exception traverse symlinks beneath that root.
fn canonical_exception(root: &Path, path: &Path) -> Result<PathBuf, String> {
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Sandbox exceptions must not contain parent traversal".into());
    }
    let relative = path
        .strip_prefix(root)
        .ok()
        .or_else(|| {
            #[cfg(target_os = "macos")]
            {
                // Prefer the outermost non-symlink root alias so symlinks beneath it still get checked.
                path.ancestors()
                    .filter(|ancestor| {
                        !fs::symlink_metadata(ancestor)
                            .is_ok_and(|meta| meta.file_type().is_symlink())
                            && crate::path_identity::same_path(ancestor, root)
                    })
                    .last()
                    .and_then(|ancestor| path.strip_prefix(ancestor).ok())
            }
            #[cfg(not(target_os = "macos"))]
            {
                None
            }
        })
        .ok_or_else(|| {
            format!(
                "Sandbox exception {} is outside {}",
                path.display(),
                root.display()
            )
        })?;
    let mut resolved = kernel_path(root)
        .map_err(|e| format!("Cannot resolve sandbox root {}: {e}", root.display()))?;
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err("Sandbox exceptions must not contain parent traversal".into());
        };
        resolved.push(name);
        let metadata = fs::symlink_metadata(&resolved)
            .map_err(|e| format!("Cannot inspect sandbox path {}: {e}", resolved.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!(
                "Sandbox exception must use real directories: {}",
                resolved.display()
            ));
        }
        resolved = crate::path_identity::actual_path(&resolved).unwrap_or(resolved);
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
    write_profile(path, repository, worktree_root, current, None, &[], &[], &[])
}

/// Production adds session/data, engine and installation boundaries. The
/// installation is the Grapher source checkout (or packaged app); like the
/// shared engine copy it stays readable but must never be writable by an
/// execution, matching the Linux bubblewrap read-only bind.
#[allow(clippy::too_many_arguments)]
pub fn write_execution_profile(
    path: &Path,
    repository: &Path,
    worktree_root: &Path,
    current: &Path,
    data: &Path,
    session: &Path,
    engine: &Path,
    installation: &Path,
) -> Result<PathBuf, String> {
    write_execution_profile_scoped(
        path,
        repository,
        worktree_root,
        current,
        data,
        session,
        engine,
        installation,
        &[],
        &[],
        &[],
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn write_execution_profile_scoped(
    path: &Path,
    repository: &Path,
    worktree_root: &Path,
    current: &Path,
    data: &Path,
    session: &Path,
    engine: &Path,
    installation: &Path,
    workspaces: &[PathBuf],
    extra_exceptions: &[PathBuf],
    read_only_data: &[PathBuf],
) -> Result<PathBuf, String> {
    write_profile(
        path,
        repository,
        worktree_root,
        current,
        Some((data, session, engine, installation)),
        workspaces,
        extra_exceptions,
        read_only_data,
    )
}

#[allow(clippy::too_many_arguments)]
fn write_profile(
    path: &Path,
    repository: &Path,
    worktree_root: &Path,
    current: &Path,
    execution: Option<(&Path, &Path, &Path, &Path)>,
    workspaces: &[PathBuf],
    extra_exceptions: &[PathBuf],
    read_only_data: &[PathBuf],
) -> Result<PathBuf, String> {
    if !supported() {
        return Err("Graph sandbox requires /usr/bin/sandbox-exec on macOS".into());
    }
    let current = canonical_exception(worktree_root, current)?;
    let repository = kernel_path(repository)?;
    let worktree_root = kernel_path(worktree_root)?;
    if !current.starts_with(&worktree_root)
        || current == worktree_root
        || current.starts_with(&repository)
        || repository.starts_with(&current)
    {
        return Err("Invalid or overlapping Graph sandbox paths".into());
    }
    // The Merger's own graph Git is a legitimate exception, not a hidden
    // database to protect. Later deny rules must not re-deny it.
    let extra_resolved = extra_exceptions
        .iter()
        .map(|path| canonical_exception(&worktree_root, path))
        .collect::<Result<Vec<_>, _>>()?;
    let extra = execution
        .map(
            |(data, session, engine, installation)| -> Result<_, String> {
                Ok((
                    kernel_path(data)?,
                    canonical_exception(data, session)?,
                    kernel_path(engine)?,
                    kernel_path(installation)?,
                ))
            },
        )
        .transpose()?;
    if let Some((data, session, engine, installation)) = &extra {
        if installation == Path::new("/") {
            return Err("Invalid Grapher installation location".into());
        }
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
    // path written by an agent when generating a profile. The Merger's graph
    // Git borrows the same object store through its own alternate.
    let borrowed_objects = (|| -> Option<PathBuf> {
        let expected = crate::workspace::repository_git(
            &repository,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "objects",
            ],
        )
        .ok()?;
        let expected = kernel_path(Path::new(&expected)).ok()?;
        for alternate in std::iter::once(current.join(".git/objects/info/alternates")).chain(
            extra_exceptions
                .iter()
                .map(|path| path.join("objects/info/alternates")),
        ) {
            if let Ok(value) = fs::read_to_string(&alternate) {
                if let Ok(objects) = kernel_path(Path::new(value.trim())) {
                    if objects == expected {
                        return Some(objects);
                    }
                }
            }
        }
        None
    })();
    let source_rule = if let Some((_, session, _, _)) = &extra {
        format!(
            "(require-all (subpath {}) (require-not (subpath {})))",
            quote(&repository)?,
            quote(session)?
        )
    } else {
        format!("(subpath {})", quote(&repository)?)
    };
    let read_source_rule = if let Some(objects) = &borrowed_objects {
        format!(
            "(require-all {source_rule} (require-not (subpath {})))",
            quote(objects)?
        )
    } else {
        source_rule.clone()
    };
    let metadata_rule = if let Some(objects) = &borrowed_objects {
        if objects.starts_with(&repository) {
            format!("(require-all {read_source_rule} (require-not (literal {})) (require-not (literal {})))",
                quote(&repository)?, quote(objects.parent().ok_or("Invalid object path")?)?)
        } else {
            read_source_rule.clone()
        }
    } else {
        read_source_rule.clone()
    };
    let state = crate::workspace_state::process_root(&current)
        .ok()
        .filter(|path| path.is_dir())
        .map(|path| canonical_exception(&worktree_root, &path))
        .transpose()?;
    let mut exceptions = state.into_iter().collect::<Vec<_>>();
    for workspace in workspaces {
        let target = canonical_exception(&worktree_root, workspace)?;
        if target.parent() != current.parent() {
            return Err("Planner sandbox exception leaves the current Run".into());
        }
        crate::workspace_view::validate_ready(&target, &repository)?;
        exceptions.push(canonical_exception(
            &worktree_root,
            &crate::workspace_state::prepare(&target)?,
        )?);
        exceptions.push(target);
    }
    // The Merger's hidden graph Git lives beside the masked worktrees root and
    // must stay readable and writable so it can resolve the composition merge.
    for exception in &extra_resolved {
        exceptions.push(exception.clone());
    }
    exceptions.sort();
    exceptions.dedup();
    let state_exception = exceptions
        .iter()
        .map(|path| quote(path).map(|path| format!(" (require-not (subpath {path}))")))
        .collect::<Result<Vec<_>, _>>()?
        .concat();
    let mut state_ancestors = String::new();
    for exception in &exceptions {
        let mut parent = exception.parent();
        while let Some(path) = parent.filter(|path| path.starts_with(&worktree_root)) {
            state_ancestors.push_str(&format!(" (require-not (literal {}))", quote(path)?));
            parent = path.parent();
        }
    }
    let mut text = format!(
        "(version 1)\n(allow default)\n\
         (deny file-read-data {read_source_rule})\n\
         (deny file-read-metadata {metadata_rule})\n\
         (deny file-write* {source_rule})\n\
         (deny file-read-data file-write*\n\
           (require-all (subpath {root}) (require-not (subpath {current})){state_exception}))\n\
         (deny file-read-metadata\n\
           (require-all (subpath {root}) (require-not (subpath {current})){state_exception}\n\
             (require-not (literal {root})) (require-not (literal {run})){state_ancestors}))\n",
        root = quote(&worktree_root)?,
        current = quote(&current)?,
        run = quote(current.parent().ok_or("Invalid execution path")?)?,
    );
    if let Some((data, session, engine, installation)) = &extra {
        let data_rule = format!(
            "(require-all (subpath {}) (require-not (subpath {})))",
            quote(data)?,
            quote(session)?
        );
        let attachment_bucket = data.join(crate::attachment_inputs::BUCKET);
        let mut data_read_only = Vec::new();
        if let Some(objects) = borrowed_objects.as_ref().filter(|p| p.starts_with(data)) {
            data_read_only.push(objects.clone());
        }
        for path in read_only_data {
            let resolved = canonical_exception(data, path)?;
            if !resolved.starts_with(&attachment_bucket) || resolved == attachment_bucket {
                return Err("Read-only attachment exception must live inside attachment-inputs".into());
            }
            data_read_only.push(resolved);
        }
        data_read_only.sort();
        data_read_only.dedup();
        if !data_read_only.is_empty() {
            let read_exceptions = data_read_only
                .iter()
                .map(|dir| quote(dir).map(|dir| format!(" (require-not (subpath {dir}))")))
                .collect::<Result<Vec<_>, _>>()?
                .concat();
            let read_rule = format!("(require-all {data_rule}{read_exceptions})");
            let mut ancestor_dirs = Vec::new();
            for target in &data_read_only {
                let mut parent = target.parent();
                while let Some(dir) = parent.filter(|dir| dir.starts_with(data)) {
                    ancestor_dirs.push(dir.to_path_buf());
                    parent = dir.parent();
                }
            }
            ancestor_dirs.sort();
            ancestor_dirs.dedup();
            let ancestors = ancestor_dirs
                .iter()
                .map(|dir| quote(dir).map(|dir| format!(" (require-not (literal {dir}))")))
                .collect::<Result<Vec<_>, _>>()?
                .concat();
            text.push_str(&format!(
                "(deny file-read-data {read_rule})\n(deny file-read-metadata (require-all {read_rule}{ancestors}))\n"
            ));
        } else {
            text.push_str(&format!("(deny file-read* {data_rule})\n"));
        }
        text.push_str(&format!(
            "(deny file-write* {data_rule})\n(deny file-write* (subpath {}))\n",
            quote(engine)?
        ));
        // The original Grapher installation (source checkout or packaged app)
        // is shared host state. An execution may load from the prepared engine
        // copy but must not modify the installation, exactly as Linux mounts it
        // read-only. Reads stay allowed so linked dependency targets resolve.
        // The default runtime data root (`<installation>/.grapher`) lives inside
        // the installation, so its writable session/workspace exceptions are
        // carved out of this write denial just as they are elsewhere.
        let installation_rule = format!(
            "(require-all (subpath {installation}) (require-not (subpath {session})) (require-not (subpath {current})){state_exception})",
            installation = quote(installation)?,
            session = quote(session)?,
            current = quote(&current)?,
        );
        text.push_str(&format!("(deny file-write* {installation_rule})\n"));
    }
    // External shadow repositories keep Git metadata outside source; explicitly deny them.
    let shadow_dir = crate::workspace::shadow_repo_dir(&repository)?;
    if shadow_dir.exists() || shadow_dir.is_symlink() {
        let canonical_shadow = kernel_path(&shadow_dir).map_err(|e| {
            format!(
                "Cannot resolve shadow repository {}: {e}",
                shadow_dir.display()
            )
        })?;
        append_git_dir_rule(&mut text, &canonical_shadow, borrowed_objects.as_deref())?;
    }
    // Source linked worktrees can keep all node snapshots in a shared Git
    // directory outside the source path. Protect that database as well.
    let mut common_dirs = vec![crate::workspace::repository_git(
        &repository,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )];
    if crate::workspace::is_standard_git(&repository) {
        // Internal snapshots no longer live in the user's database. A linked
        // source worktree's real external database still needs protection.
        common_dirs.push(crate::workspace::git(
            &repository,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ));
    }
    for common in common_dirs.into_iter().flatten() {
        let common = kernel_path(Path::new(&common))?;
        if !common.starts_with(&repository)
            && !common.starts_with(&current)
            && !extra_resolved.contains(&common)
        {
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
            let common = kernel_path(Path::new(&common))?;
            if !common.starts_with(&current) && !extra_resolved.contains(&common) {
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

fn append_git_dir_rule(
    text: &mut String,
    git_dir: &Path,
    borrowed: Option<&Path>,
) -> Result<(), String> {
    let rule = format!("(subpath {})", quote(git_dir)?);
    if let Some(objects) = borrowed.filter(|objects| objects.starts_with(git_dir)) {
        text.push_str(&format!(
            "(deny file-read-data (require-all {rule} (require-not (subpath {}))))\n",
            quote(objects)?
        ));
        text.push_str(&format!("(deny file-read-metadata (require-all {rule} (require-not (subpath {})) (require-not (literal {}))))\n",
            quote(objects)?, quote(git_dir)?));
    } else {
        text.push_str(&format!("(deny file-read* {rule})\n"));
    }
    text.push_str(&format!("(deny file-write* {rule})\n"));
    Ok(())
}

pub fn supported() -> bool {
    cfg!(target_os = "windows")
        || (cfg!(target_os = "macos") && Path::new("/usr/bin/sandbox-exec").is_file())
}
