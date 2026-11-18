//! Resolve children of a trusted filesystem root without following child links.
//! Root aliases (e.g. macOS /var) are allowed; symlinks/junctions beneath it are not.
//! These checks do not claim to defeat hostile concurrent filesystem replacement.
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub(crate) fn real_child_path(
    root: &Path,
    path: &Path,
    file: bool,
) -> Result<Option<PathBuf>, String> {
    let relative = path
        .strip_prefix(root)
        .ok()
        .or_else(|| {
            #[cfg(any(target_os = "macos", windows))]
            {
                if path.is_absolute() != root.is_absolute() {
                    return None;
                }
                #[cfg(windows)]
                let win_lexical = |value: &Path| {
                    let text = crate::path_identity::lexical_key(value);
                    if let Some(unc) = text.strip_prefix(r"\\?\unc\") {
                        format!(r"\\{unc}")
                    } else {
                        text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
                    }
                };
                #[cfg(windows)]
                let lexical_root = win_lexical(root);
                #[cfg(target_os = "macos")]
                let macos_insensitive = crate::path_identity::case_insensitive_volume(root);
                path.ancestors()
                    .filter(|ancestor| {
                        let same_lexical = {
                            #[cfg(windows)]
                            {
                                win_lexical(ancestor) == lexical_root
                            }
                            #[cfg(target_os = "macos")]
                            {
                                crate::path_identity::macos_equivalent_path(
                                    ancestor,
                                    root,
                                    macos_insensitive,
                                )
                            }
                        };
                        same_lexical
                            || (!ancestor
                                .components()
                                .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
                                && !fs::symlink_metadata(ancestor)
                                    .is_ok_and(|meta| crate::workspace_symlinks::is_link(&meta))
                                && crate::path_identity::same_path(ancestor, root))
                    })
                    .last()
                    .and_then(|ancestor| path.strip_prefix(ancestor).ok())
            }
            #[cfg(not(any(target_os = "macos", windows)))]
            {
                None
            }
        })
        .ok_or("Path is outside its trusted root")?;
    let parts = relative
        .components()
        .map(|part| match part {
            Component::Normal(name) if name != "." && name != ".." => Ok(name),
            _ => Err("Child paths must not contain traversal or absolute prefixes"),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if parts.is_empty() {
        return Err("Refusing to use the trusted root itself".into());
    }
    let mut current = root.canonicalize().map_err(|error| error.to_string())?;
    for (index, name) in parts.iter().enumerate() {
        let parent = current.clone();
        current.push(name);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Refusing symlink or redirected child path: {}",
                current.display()
            ));
        }
        let valid_type = if file && index + 1 == parts.len() {
            metadata.is_file()
        } else {
            metadata.is_dir()
        };
        if !valid_type {
            return Err(format!(
                "Child path must use real directories and regular files: {}",
                current.display()
            ));
        }
        current = current.canonicalize().map_err(|error| error.to_string())?;
        // Also catches Windows reparse-point redirection not classified as a symlink.
        if current.parent() != Some(parent.as_path()) {
            return Err(format!(
                "Refusing redirected child path: {}",
                current.display()
            ));
        }
    }
    Ok(Some(current))
}

#[cfg(test)]
pub(crate) fn directory_link(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        // NTFS junctions work without Developer Mode or symlink privilege.
        let output = std::process::Command::new("node")
            .args([
                "-e",
                "require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')",
            ])
            .arg(target)
            .arg(link)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

/// Unlink a test directory link without removing its target.
#[cfg(test)]
pub(crate) fn remove_directory_link(link: &Path) {
    // Unix directory symlinks are unlinked as files; Windows junctions as directories.
    #[cfg(unix)]
    fs::remove_file(link).unwrap();
    #[cfg(windows)]
    fs::remove_dir(link).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_linked_ancestors_and_leaf_directories_on_each_host() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir_all(outside.join("run")).unwrap();
        fs::write(outside.join("run/marker"), "must survive").unwrap();
        directory_link(&outside, &root.join("linked"));
        for (path, file) in [
            (root.join("linked/run"), false),
            (root.join("linked/run/marker"), true),
        ] {
            assert!(real_child_path(&root, &path, file).is_err());
        }
        assert_eq!(
            fs::read_to_string(outside.join("run/marker")).unwrap(),
            "must survive"
        );
    }

    #[test]
    fn removing_directory_links_preserves_their_targets() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let link = temp.path().join("link");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("marker"), "must survive").unwrap();
        directory_link(&target, &link);

        remove_directory_link(&link);

        assert_eq!(
            fs::symlink_metadata(&link).unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
        assert_eq!(
            fs::read_to_string(target.join("marker")).unwrap(),
            "must survive"
        );
    }

    #[test]
    fn allows_trusted_root_aliases_and_real_children_but_not_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("中文 space # %");
        fs::create_dir_all(root.join("child")).unwrap();
        fs::write(root.join("child/marker"), "ok").unwrap();
        let alias = temp.path().join("alias");
        directory_link(&root, &alias);
        assert_eq!(
            real_child_path(&alias, &alias.join("child/marker"), true).unwrap(),
            Some(root.join("child/marker").canonicalize().unwrap())
        );
        assert!(real_child_path(&root, &root, false).is_err());
        assert!(real_child_path(&root, &root.join("missing/../child"), false).is_err());
        assert!(real_child_path(&root, &root.join("missing"), false)
            .unwrap()
            .is_none());

        // Case-aliased root (including when `root` is itself a directory link) works on
        // case-insensitive volumes while an inner loop symlink back to `root` still fails.
        let mixed = temp.path().join("MixedRoot");
        fs::create_dir_all(mixed.join("sub")).unwrap();
        fs::write(mixed.join("sub/file"), "ok").unwrap();
        directory_link(&mixed, &mixed.join("loop"));
        if crate::path_identity::case_insensitive_volume(&mixed) {
            let lower_mixed = temp.path().join("mixedroot");
            assert_eq!(
                real_child_path(&mixed, &lower_mixed.join("sub/file"), true).unwrap(),
                Some(mixed.join("sub/file").canonicalize().unwrap())
            );
            let link_root = temp.path().join("LinkRoot");
            directory_link(&mixed, &link_root);
            let lower_link_root = temp.path().join("linkroot");
            assert_eq!(
                real_child_path(&link_root, &lower_link_root.join("sub/file"), true).unwrap(),
                Some(mixed.join("sub/file").canonicalize().unwrap())
            );
        }
        assert!(real_child_path(&mixed, &mixed.join("loop/sub/file"), true).is_err());

        // A trusted root that itself contains `..` or leading `.` still admits valid
        // children while rejecting traversal in the child portion or before a root alias.
        let sibling = temp.path().join("sibling");
        fs::create_dir(&sibling).unwrap();
        let dotdot_root = sibling.join("..").join("中文 space # %");
        assert_eq!(
            real_child_path(&dotdot_root, &dotdot_root.join("child/marker"), true).unwrap(),
            Some(root.join("child/marker").canonicalize().unwrap())
        );
        assert!(real_child_path(&dotdot_root, &dotdot_root.join("missing/../child"), false).is_err());
        assert!(real_child_path(
            Path::new("."),
            Path::new("./definitely-missing-child-for-path-safety-test"),
            false
        )
        .unwrap()
        .is_none());
        assert!(real_child_path(
            &mixed,
            &sibling.join("..").join("mixedroot/sub/file"),
            true
        )
        .is_err());
    }
}
