//! Native project links. Internal absolute targets are rebound to the private
//! project, retaining their absolute kind; directory junctions stay junctions.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Kind {
    SymbolicFile,
    SymbolicDirectory,
    Junction,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Link {
    pub value: String,
    pub project_absolute: bool,
    pub kind: Kind,
}

pub(crate) fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn text(path: &Path) -> Result<String, String> {
    let path = path.to_str().ok_or("Project link target is not UTF-8")?;
    Ok(if cfg!(windows) {
        path.replace('\\', "/")
    } else {
        path.into()
    })
}
fn normalized(path: &Path) -> Option<PathBuf> {
    #[cfg(unix)]
    if path
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        // POSIX resolves a directory link before processing the following '..'.
        // Lexically popping the link would change which file the target names.
        // An unresolvable traversal is not proof of project ownership.
        return if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
            // Preserve a final link's name: only its parent traversal decides
            // ownership, and private edits to that link must remain visible.
            crate::path_identity::actual_path(parent)
                .ok()
                .map(|parent| parent.join(name))
        } else {
            crate::path_identity::actual_path(path).ok()
        };
    }
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            _ => result.push(component.as_os_str()),
        }
    }
    Some(result)
}
fn relative(root: &Path, target: &Path) -> Option<PathBuf> {
    let root = normalized(&crate::native::host_path(root))?;
    let target = normalized(&crate::native::host_path(target))?;
    if let Ok(suffix) = target.strip_prefix(&root) {
        return Some(suffix.to_path_buf());
    }
    // Root aliases can have different component counts (/var vs /private/var,
    // or a junction elsewhere). Find the first physical root boundary, not a
    // same-length spelling or a later descendant link back to the root.
    let parts: Vec<_> = target.components().collect();
    let mut prefix = PathBuf::new();
    for (index, part) in parts.iter().enumerate() {
        prefix.push(part.as_os_str());
        if prefix.is_absolute() && crate::path_identity::same_path(&root, &prefix) {
            return Some(
                parts[index + 1..]
                    .iter()
                    .map(|part| part.as_os_str())
                    .collect(),
            );
        }
    }
    None
}
pub(crate) fn capture(root: &Path, path: &Path, metadata: &fs::Metadata) -> Result<Link, String> {
    let target = fs::read_link(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let kind = windows::kind(path, metadata)?;
    #[cfg(not(windows))]
    let kind = {
        let _ = metadata;
        Kind::SymbolicFile
    };
    let internal = if target.is_absolute() {
        relative(root, &target).or_else(|| {
            crate::path_identity::actual_path(&target)
                .ok()
                .and_then(|actual| relative(root, &actual))
        })
    } else {
        None
    };
    Ok(Link {
        project_absolute: internal.is_some(),
        value: text(internal.as_deref().unwrap_or(&target))?,
        kind,
    })
}
impl Link {
    pub(crate) fn metadata(&self) -> Self {
        Self {
            value: String::new(),
            ..self.clone()
        }
    }
    pub(crate) fn target(&self, root: &Path) -> Result<PathBuf, String> {
        let path = Path::new(&self.value);
        if self.project_absolute {
            if !path
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            {
                return Err("Unsafe project-relative absolute link".into());
            }
            Ok(root.join(path))
        } else {
            Ok(path.into())
        }
    }
}
pub(crate) fn remove(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if is_link(&metadata) {
        #[cfg(target_os = "macos")]
        crate::workspace_cleanup::clear_macos_immutable_flags(path, &metadata)
            .map_err(|e| e.to_string())?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x10 != 0 {
                return fs::remove_dir(path).map_err(|e| e.to_string());
            }
        }
        return fs::remove_file(path).map_err(|e| e.to_string());
    }
    if metadata.is_dir() {
        return Err(format!(
            "Refusing to replace an unrecorded real directory by a project link: {}",
            path.display()
        ));
    }
    #[cfg(windows)]
    crate::workspace_cleanup::clear_readonly_attribute(path, &metadata)
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    crate::workspace_cleanup::clear_macos_immutable_flags(path, &metadata)
        .map_err(|e| e.to_string())?;
    fs::remove_file(path).map_err(|e| e.to_string())
}
pub(crate) fn materialize(root: &Path, path: &Path, link: &Link) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing link parent")?;
    if parent != root {
        crate::path_safety::real_child_path(root, parent, false)?;
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if is_link(&metadata) && capture(root, path, &metadata)? == *link {
            return Ok(());
        }
    }
    remove(path)?;
    let target = link.target(root)?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, path).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        match link.kind {
            Kind::Junction => windows::junction(&target, path),
            Kind::SymbolicDirectory => std::os::windows::fs::symlink_dir(target, path).map_err(|e| format!("Cannot create native project directory symlink (enable Developer Mode or symlink privilege): {e}")),
            Kind::SymbolicFile => std::os::windows::fs::symlink_file(target, path).map_err(|e| format!("Cannot create native project file symlink (enable Developer Mode or symlink privilege): {e}")),
        }
    }
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn absolute_links_obey_volume_case_rules_and_preserve_missing_leaf_spelling() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Project");
        let lower = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        assert_eq!(
            relative(&root, &root.join("MissingLeaf")),
            Some("MissingLeaf".into())
        );
        if lower.exists() {
            assert_eq!(
                relative(&root, &lower.join("MissingLeaf")),
                Some("MissingLeaf".into())
            );
        } else {
            fs::create_dir(&lower).unwrap();
            assert_eq!(relative(&root, &lower.join("MissingLeaf")), None);
        }
        assert_eq!(
            relative(&root, &temp.path().join("Project-other/MissingLeaf")),
            None
        );
    }

    #[test]
    fn root_aliases_at_different_depths_preserve_the_logical_suffix() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir_all(root.join("sub")).unwrap();
        let parent = temp.path().join("holder");
        fs::create_dir(&parent).unwrap();
        let alias = parent.join("alias");
        crate::path_safety::directory_link(&root, &alias);
        crate::path_safety::directory_link(&root, &root.join("sub/back"));
        assert_eq!(
            relative(&alias, &root.join("MissingLeaf")),
            Some("MissingLeaf".into())
        );
        assert_eq!(
            relative(&root, &alias.join("MissingLeaf")),
            Some("MissingLeaf".into())
        );
        // Do not match a later link back to root and drop its logical path.
        assert_eq!(
            relative(&alias, &root.join("sub/back/MissingLeaf")),
            Some("sub/back/MissingLeaf".into())
        );
        let selected = root.join("selected");
        crate::path_safety::directory_link(&root.join("sub"), &selected);
        let link = capture(&alias, &selected, &fs::symlink_metadata(&selected).unwrap()).unwrap();
        assert!(link.project_absolute);
        assert_eq!(link.value, "sub");
    }

    #[cfg(unix)]
    #[test]
    fn absolute_link_parent_traversal_preserves_native_link_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let outside = temp.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir_all(outside.join("nested")).unwrap();
        fs::write(root.join("payload"), "project bytes").unwrap();
        fs::write(outside.join("payload"), "external bytes").unwrap();
        std::os::unix::fs::symlink(outside.join("nested"), root.join("jump")).unwrap();
        let raw = root.join("jump/../payload");
        let path = root.join("alias");
        std::os::unix::fs::symlink(&raw, &path).unwrap();
        let link = capture(&root, &path, &fs::symlink_metadata(&path).unwrap()).unwrap();
        assert!(!link.project_absolute);
        let fork = temp.path().join("fork");
        fs::create_dir(&fork).unwrap();
        fs::write(fork.join("payload"), "wrong private bytes").unwrap();
        materialize(&fork, &fork.join("alias"), &link).unwrap();
        assert_eq!(
            fs::read_to_string(fork.join("alias")).unwrap(),
            "external bytes"
        );
        assert_eq!(relative(&root, &root.join("jump/../missing")), None);

        fs::create_dir(root.join("sub")).unwrap();
        std::os::unix::fs::symlink(outside.join("payload"), root.join("inner")).unwrap();
        let path = root.join("via-inner");
        std::os::unix::fs::symlink(root.join("sub/../inner"), &path).unwrap();
        let link = capture(&root, &path, &fs::symlink_metadata(&path).unwrap()).unwrap();
        assert!(link.project_absolute);
        assert_eq!(link.value, "inner");
        std::os::unix::fs::symlink(fork.join("payload"), fork.join("inner")).unwrap();
        materialize(&fork, &fork.join("via-inner"), &link).unwrap();
        assert_eq!(
            fs::read_to_string(fork.join("via-inner")).unwrap(),
            "wrong private bytes"
        );
    }

    #[test]
    fn case_distinct_external_directory_link_is_not_rebound_as_project_owned() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Project");
        let lower = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        if lower.exists() {
            return; // This host volume does not admit two case-distinct roots.
        }
        fs::create_dir(&lower).unwrap();
        let path = root.join("external");
        crate::path_safety::directory_link(&lower, &path);
        let link = capture(&root, &path, &fs::symlink_metadata(&path).unwrap()).unwrap();
        assert!(!link.project_absolute);
        assert!(crate::path_identity::same_path(
            &link.target(&root).unwrap(),
            &lower
        ));
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::path_identity::windows_api_path as wide;
    use std::{ffi::c_void, os::windows::fs::MetadataExt};
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            path: *const u16,
            access: u32,
            share: u32,
            security: *const c_void,
            creation: u32,
            flags: u32,
            template: *mut c_void,
        ) -> *mut c_void;
        fn DeviceIoControl(
            handle: *mut c_void,
            code: u32,
            input: *mut c_void,
            input_size: u32,
            output: *mut c_void,
            output_size: u32,
            returned: *mut u32,
            overlap: *mut c_void,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    fn ioctl(path: &Path, write: bool, data: &mut [u8]) -> Result<usize, String> {
        let name = wide(path)?;
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                if write { 0x4000_0000 } else { 0 },
                7,
                std::ptr::null(),
                3,
                0x0220_0000,
                std::ptr::null_mut(),
            )
        };
        if handle as isize == -1 {
            return Err(format!(
                "Cannot open project reparse point {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        let mut returned = 0;
        let result = unsafe {
            if write {
                DeviceIoControl(
                    handle,
                    0x0009_00a4,
                    data.as_mut_ptr().cast(),
                    data.len() as u32,
                    std::ptr::null_mut(),
                    0,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            } else {
                DeviceIoControl(
                    handle,
                    0x0009_00a8,
                    std::ptr::null_mut(),
                    0,
                    data.as_mut_ptr().cast(),
                    data.len() as u32,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            }
        };
        let error = std::io::Error::last_os_error();
        unsafe {
            CloseHandle(handle);
        }
        if result == 0 {
            return Err(format!(
                "Cannot preserve native project reparse point: {error}"
            ));
        }
        Ok(returned as usize)
    }
    pub(super) fn kind(path: &Path, metadata: &fs::Metadata) -> Result<Kind, String> {
        let mut data = vec![0; 16384];
        let size = ioctl(path, false, &mut data)?;
        if size < 8 {
            return Err("Truncated project reparse point".into());
        }
        match u32::from_le_bytes(data[..4].try_into().unwrap()) {
            0xa000_0003=>Ok(Kind::Junction),
            0xa000_000c=>Ok(if metadata.file_attributes() & 0x10 != 0 {Kind::SymbolicDirectory} else {Kind::SymbolicFile}),
            tag=>Err(format!("Project reparse provider {tag:#x} cannot be privately reconstructed by this filesystem")),
        }
    }
    pub(super) fn junction(target: &Path, path: &Path) -> Result<(), String> {
        if !target.is_absolute() {
            return Err("Directory junction target must be absolute".into());
        }
        let target = crate::native::host_path(target)
            .to_string_lossy()
            .replace('/', "\\");
        let substitute = if let Some(unc) = target.strip_prefix("\\\\") {
            format!("\\??\\UNC\\{unc}")
        } else {
            format!("\\??\\{target}")
        };
        let substitute: Vec<u16> = substitute.encode_utf16().collect();
        let print: Vec<u16> = target.encode_utf16().collect();
        let bytes = 8 + (substitute.len() + 1 + print.len() + 1) * 2;
        if bytes + 8 > 16384 || bytes > u16::MAX as usize {
            return Err("Project junction target exceeds native reparse capacity".into());
        }
        let mut data = Vec::with_capacity(bytes + 8);
        data.extend(0xa000_0003u32.to_le_bytes());
        data.extend((bytes as u16).to_le_bytes());
        data.extend(0u16.to_le_bytes());
        for value in [
            0,
            (substitute.len() * 2) as u16,
            ((substitute.len() + 1) * 2) as u16,
            (print.len() * 2) as u16,
        ] {
            data.extend(value.to_le_bytes());
        }
        for value in substitute.into_iter().chain([0]).chain(print).chain([0]) {
            data.extend(value.to_le_bytes());
        }
        fs::create_dir(path).map_err(|e| e.to_string())?;
        if let Err(error) = ioctl(path, true, &mut data) {
            let _ = fs::remove_dir(path);
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::ffi::OsStrExt;

    #[test]
    fn windows_long_path_junction_capture_and_materialization() {
        let temp = tempfile::tempdir().unwrap();
        let mut root = crate::native::host_path(temp.path());
        while root.as_os_str().encode_wide().count() < 300 {
            root.push("中文 dependency directory");
        }
        fs::create_dir_all(&root).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let link = root.join("original");
        crate::path_safety::directory_link(&outside, &link);
        fs::remove_dir(&outside).unwrap();

        // Read/rebuild the reparse point itself, even with a missing target.
        let metadata = fs::symlink_metadata(&link).unwrap();
        let expected = capture(&root, &link, &metadata).unwrap();
        assert_eq!(expected.kind, Kind::Junction);
        assert!(!expected.project_absolute);
        let copied = root.join("copied");
        materialize(&root, &copied, &expected).unwrap();
        let metadata = fs::symlink_metadata(&copied).unwrap();
        assert_eq!(capture(&root, &copied, &metadata).unwrap(), expected);
        assert!(!outside.exists());
    }
}
