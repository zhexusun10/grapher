//! Resolve the post-recovery pathname without constructing it. Owned entries
//! come from E, external links/caches from the filesystem, and ordinary project
//! paths are deferred until the existing codeRef preparation has completed.
use super::{canonical, text};
use crate::{
    native,
    workspace_files::{RuntimePath, RuntimePaths},
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

// No canonicalization here: following today's owned children would both hide
// redirects and require the interpreter that this operation is meant to repair.
fn relative_to(path: &Path, root: &Path) -> Option<PathBuf> {
    let mut parts = path.components();
    let mut prefix = PathBuf::new();
    for expected in root.components() {
        let actual = parts.next()?;
        let equal = if actual == expected {
            true
        } else if cfg!(windows) {
            actual
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(&expected.as_os_str().to_string_lossy())
        } else {
            #[cfg(target_os = "macos")]
            {
                let probe = prefix.join(expected.as_os_str());
                let insensitive = crate::path_identity::case_insensitive_volume(&probe);
                crate::path_identity::macos_fold_component(
                    &actual.as_os_str().to_string_lossy(),
                    insensitive,
                ) == crate::path_identity::macos_fold_component(
                    &expected.as_os_str().to_string_lossy(),
                    insensitive,
                )
            }
            #[cfg(not(target_os = "macos"))]
            false
        };
        if !equal {
            return None;
        }
        prefix.push(expected.as_os_str());
    }
    Some(parts.as_path().to_path_buf())
}

pub(super) fn resolve(
    requested: &str,
    roots: &BTreeMap<String, String>,
    snapshot: &RuntimePaths,
    project_ready: bool,
) -> Result<Option<PathBuf>, String> {
    let mut pending = native::host_path(Path::new(requested));
    'links: for _ in 0..64 {
        if !pending.is_absolute() || pending.as_os_str().to_string_lossy().contains('\0') {
            return Err("Native runtime selector link has no absolute resolution".into());
        }
        // Ordinary Win32 DOS paths collapse dot segments before consulting
        // junctions; POSIX resolves each link before interpreting a following
        // '..'. Do not impose POSIX traversal semantics on Windows selectors.
        #[cfg(windows)]
        {
            let mut normalized = PathBuf::new();
            for part in pending.components() {
                match part {
                    Component::ParentDir => {
                        normalized.pop();
                    }
                    Component::CurDir => {}
                    _ => normalized.push(part.as_os_str()),
                }
            }
            pending = normalized;
        }
        let mut current = PathBuf::new();
        let mut parts = pending.components();
        while let Some(part) = parts.next() {
            match part {
                Component::Prefix(_) | Component::RootDir => {
                    current.push(part.as_os_str());
                    continue;
                }
                Component::CurDir => continue,
                Component::ParentDir => {
                    current.pop();
                    continue;
                }
                Component::Normal(name) => current.push(name),
            }
            let owned = roots.iter().find_map(|(label, root)| {
                relative_to(&current, Path::new(root))
                    .map(|relative| (label, Path::new(root), relative))
            });
            let entry = if let Some((label, root, relative)) = owned {
                match snapshot.lookup(label, &text(&relative))? {
                    RuntimePath::Directory(name) => {
                        current = root.join(name);
                        Some(true)
                    }
                    RuntimePath::File(name) => {
                        current = root.join(name);
                        Some(false)
                    }
                    RuntimePath::Link { target, internal } => {
                        let target = native::host_path(Path::new(&target));
                        let next = if internal {
                            root.join(target)
                        } else if target.is_absolute() {
                            target
                        } else {
                            current
                                .parent()
                                .ok_or("Missing recorded selector parent")?
                                .join(target)
                        };
                        pending = next.join(parts.as_path());
                        continue 'links;
                    }
                    RuntimePath::Project if !project_ready => return Ok(None),
                    RuntimePath::Project | RuntimePath::Live => None,
                }
            } else if roots
                .values()
                .any(|root| relative_to(Path::new(root), &current).is_some())
            {
                // Root-layout preflight already checked these physical parents.
                // Missing S scaffold directories are recreated by preparation.
                Some(true)
            } else {
                None
            };
            let directory = if let Some(directory) = entry {
                directory
            } else {
                let metadata = fs::symlink_metadata(&current).map_err(|error| {
                    format!(
                        "Native runtime selector path is unavailable: {}: {error}",
                        current.display()
                    )
                })?;
                if metadata.file_type().is_symlink() {
                    let target =
                        native::host_path(&fs::read_link(&current).map_err(|e| e.to_string())?);
                    pending = if target.is_absolute() {
                        target
                    } else {
                        current
                            .parent()
                            .ok_or("Missing external selector parent")?
                            .join(target)
                    }
                    .join(parts.as_path());
                    continue 'links;
                }
                if !metadata.is_file() && !metadata.is_dir() {
                    return Err("Native runtime selector is not a file or directory".into());
                }
                current = canonical(&current)?;
                metadata.is_dir()
            };
            if !directory && parts.clone().next().is_some() {
                return Err(format!(
                    "Native runtime selector traverses a non-directory: {}",
                    current.display()
                ));
            }
        }
        return Ok(Some(current));
    }
    Err("Native runtime selector link chain exceeds its recovery bound".into())
}
