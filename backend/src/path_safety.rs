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
        .map_err(|_| "Path is outside its trusted root")?;
    let parts = relative
        .components()
        .map(|part| match part {
            Component::Normal(name) => Ok(name),
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
    }
}
