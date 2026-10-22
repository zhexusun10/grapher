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
fn normalized(path: &Path) -> PathBuf {
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
    result
}
fn relative(root: &Path, target: &Path) -> Option<PathBuf> {
    let root = normalized(&crate::native::host_path(root));
    let target = normalized(&crate::native::host_path(target));
    let rc: Vec<_> = root.components().collect();
    let tc: Vec<_> = target.components().collect();
    if tc.len() < rc.len()
        || rc.iter().zip(&tc).any(|(a, b)| {
            crate::path_identity::lexical_key(Path::new(a.as_os_str()))
                != crate::path_identity::lexical_key(Path::new(b.as_os_str()))
        })
    {
        return None;
    }
    Some(tc[rc.len()..].iter().map(|part| part.as_os_str()).collect())
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
    if metadata.permissions().readonly() {
        let mut p = metadata.permissions();
        p.set_readonly(false);
        fs::set_permissions(path, p).map_err(|e| e.to_string())?;
    }
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

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        ffi::c_void,
        os::windows::{ffi::OsStrExt, fs::MetadataExt},
    };
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
    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain([0]).collect()
    }
    fn ioctl(path: &Path, write: bool, data: &mut [u8]) -> Result<usize, String> {
        let handle = unsafe {
            CreateFileW(
                wide(path).as_ptr(),
                if write { 0x4000_0000 } else { 0 },
                7,
                std::ptr::null(),
                3,
                0x0220_0000,
                std::ptr::null_mut(),
            )
        };
        if handle as isize == -1 {
            return Err(std::io::Error::last_os_error().to_string());
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
