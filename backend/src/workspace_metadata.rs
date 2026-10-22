//! Supplemental filesystem metadata. Bytes in named streams/xattrs are part of
//! the sealed metadata evidence, never silently discarded by a copy fallback.
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Extra {
    attributes: Vec<(String, Vec<u8>)>,
    security: Vec<u8>,
    protected: bool,
    flags: u32,
    owner: Option<(u32, u32)>,
    #[serde(default)]
    efs: bool,
}

// `security` is the SDDL/inheritance history of the source path. Windows
// re-inherits ACLs from the destination parent on restore, so it must not make
// two project views with the same explicit permissions compare unequal. It is
// still serialized in the record for restore.
impl PartialEq for Extra {
    fn eq(&self, other: &Self) -> bool {
        self.attributes == other.attributes
            && self.protected == other.protected
            && self.flags == other.flags
            && self.owner == other.owner
            && self.efs == other.efs
    }
}
impl Eq for Extra {}

pub(crate) fn capture(path: &Path, _metadata: &fs::Metadata) -> Result<Extra, String> {
    platform::capture(path)
}

#[cfg(all(windows, test))]
pub(crate) fn set_encrypted(path: &Path, encrypted: bool) -> Result<(), String> {
    platform::set_encrypted(path, encrypted)
}

pub(crate) fn file_identity(path: &Path, metadata: &fs::Metadata) -> Result<(u128, u64), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        Ok((
            (u128::from(metadata.dev()) << 64) | u128::from(metadata.ino()),
            metadata.nlink(),
        ))
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        platform::file_identity(path)
    }
}
pub(crate) fn restore(path: &Path, value: &Extra) -> Result<(), String> {
    platform::restore(path, value, None)
}
pub(crate) fn restore_with_mode(path: &Path, value: &Extra, mode: u32) -> Result<(), String> {
    platform::restore(path, value, Some(mode))
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    fn path(value: &Path) -> Result<CString, String> {
        CString::new(value.as_os_str().as_bytes()).map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    extern "C" {
        fn acl_get_link_np(path: *const libc::c_char, kind: i32) -> *mut libc::c_void;
        fn acl_to_text(acl: *mut libc::c_void, length: *mut isize) -> *mut libc::c_char;
        fn acl_from_text(text: *const libc::c_char) -> *mut libc::c_void;
        fn acl_set_link_np(path: *const libc::c_char, kind: i32, acl: *mut libc::c_void) -> i32;
        fn acl_free(value: *mut libc::c_void) -> i32;
        fn lchflags(path: *const libc::c_char, flags: u32) -> i32;
    }
    #[cfg(target_os = "macos")]
    fn acl(path: &CString) -> Result<Vec<u8>, String> {
        let acl = unsafe { acl_get_link_np(path.as_ptr(), 0x100) };
        if acl.is_null() {
            let error = std::io::Error::last_os_error();
            // A file without an extended ACL reports ENOENT (or an
            // unsupported-ACL filesystem); that is an empty ACL, not a
            // capability failure.
            if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTSUP)) {
                return Ok(Vec::new());
            }
            return Err(format!("Cannot capture native macOS ACL: {error}"));
        }
        let mut length = 0;
        let text = unsafe { acl_to_text(acl, &mut length) };
        if text.is_null() {
            unsafe {
                acl_free(acl);
            }
            return Err(std::io::Error::last_os_error().to_string());
        }
        let value =
            unsafe { std::slice::from_raw_parts(text.cast::<u8>(), length as usize) }.to_vec();
        unsafe {
            acl_free(text.cast());
            acl_free(acl);
        }
        Ok(value)
    }
    unsafe fn list(p: *const libc::c_char, out: *mut libc::c_char, size: usize) -> isize {
        #[cfg(target_os = "linux")]
        {
            libc::llistxattr(p, out, size)
        }
        #[cfg(target_os = "macos")]
        {
            libc::listxattr(p, out, size, 1)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (p, out, size);
            -1
        }
    }
    unsafe fn get(
        p: *const libc::c_char,
        key: *const libc::c_char,
        out: *mut libc::c_void,
        size: usize,
    ) -> isize {
        #[cfg(target_os = "linux")]
        {
            libc::lgetxattr(p, key, out, size)
        }
        #[cfg(target_os = "macos")]
        {
            libc::getxattr(p, key, out, size, 0, 1)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (p, key, out, size);
            -1
        }
    }
    #[cfg(target_os = "linux")]
    fn linux_flags(value: &Path, desired: Option<u32>) -> Result<u32, String> {
        use std::os::fd::AsRawFd;
        // Index/extent/inline layout flags describe physical storage, not user
        // metadata. Preserve the destination's own filesystem layout bits.
        const STORAGE: u32 = 0x1008_1000;
        let file = fs::File::open(value).map_err(|e| e.to_string())?;
        let size = (std::mem::size_of::<libc::c_long>() as u64) << 16;
        let mut flags: libc::c_long = 0;
        if unsafe { libc::ioctl(file.as_raw_fd(), (0x8000_6601u64 | size) as _, &mut flags) } == -1
        {
            let error = std::io::Error::last_os_error();
            if matches!(
                error.raw_os_error(),
                Some(libc::ENOTTY | libc::EOPNOTSUPP | libc::ENOSYS)
            ) && desired.unwrap_or(0) == 0
            {
                return Ok(0);
            }
            return Err(format!(
                "Cannot inspect/preserve Linux project inode flags: {error}"
            ));
        }
        if let Some(desired) = desired {
            let mut next = ((flags as u32 & STORAGE) | desired) as libc::c_long;
            if next != flags
                && unsafe { libc::ioctl(file.as_raw_fd(), (0x4000_6602u64 | size) as _, &mut next) }
                    == -1
            {
                return Err(format!("Native filesystem/privileges cannot preserve Linux project inode flags {desired:#x}: {}", std::io::Error::last_os_error()));
            }
            flags = next;
        }
        Ok(flags as u32 & !STORAGE)
    }
    pub(super) fn capture(value: &Path) -> Result<Extra, String> {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::symlink_metadata(value).map_err(|e| e.to_string())?;
        let owner = Some((metadata.uid(), metadata.gid()));
        #[cfg(target_os = "linux")]
        let flags = if metadata.is_file() || metadata.is_dir() {
            linux_flags(value, None)?
        } else {
            0
        };
        let p = path(value)?;
        #[cfg(target_os = "macos")]
        let security = acl(&p)?;
        #[cfg(not(target_os = "macos"))]
        let security = Vec::new();
        #[cfg(target_os = "macos")]
        let flags = {
            use std::os::macos::fs::MetadataExt;
            metadata.st_flags()
        };
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let flags = 0;
        let size = unsafe { list(p.as_ptr(), std::ptr::null_mut(), 0) };
        if size < 0 {
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(libc::ENOTSUP)) {
                return Ok(Extra {
                    owner,
                    security,
                    flags,
                    ..Extra::default()
                });
            }
            return Err(format!(
                "Cannot capture project metadata {}: {error}",
                value.display()
            ));
        }
        let mut names = vec![0u8; size as usize];
        let count = unsafe { list(p.as_ptr(), names.as_mut_ptr().cast(), names.len()) };
        if count < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut attributes = Vec::new();
        for name in names[..count as usize]
            .split(|b| *b == 0)
            .filter(|name| !name.is_empty())
        {
            let key = CString::new(name).map_err(|e| e.to_string())?;
            let size = unsafe { get(p.as_ptr(), key.as_ptr(), std::ptr::null_mut(), 0) };
            if size < 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut bytes = vec![0; size as usize];
            let count = unsafe {
                get(
                    p.as_ptr(),
                    key.as_ptr(),
                    bytes.as_mut_ptr().cast(),
                    bytes.len(),
                )
            };
            if count < 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            bytes.truncate(count as usize);
            attributes.push((
                String::from_utf8(name.to_vec())
                    .map_err(|_| "Non-UTF-8 xattr name is unsupported")?,
                bytes,
            ));
        }
        attributes.sort();
        Ok(Extra {
            attributes,
            owner,
            security,
            flags,
            ..Extra::default()
        })
    }
    pub(super) fn restore(value: &Path, extra: &Extra, mode: Option<u32>) -> Result<(), String> {
        let p = path(value)?;
        if let Some((uid, gid)) = extra.owner {
            if unsafe { libc::lchown(p.as_ptr(), uid, gid) } != 0 {
                return Err(format!(
                    "Cannot preserve project ownership: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        for (name, data) in &extra.attributes {
            let key = CString::new(name.as_str()).map_err(|e| e.to_string())?;
            #[cfg(target_os = "linux")]
            let result = unsafe {
                libc::lsetxattr(
                    p.as_ptr(),
                    key.as_ptr(),
                    data.as_ptr().cast(),
                    data.len(),
                    0,
                )
            };
            #[cfg(target_os = "macos")]
            let result = unsafe {
                libc::setxattr(
                    p.as_ptr(),
                    key.as_ptr(),
                    data.as_ptr().cast(),
                    data.len(),
                    0,
                    1,
                )
            };
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            let result = -1;
            if result != 0 {
                return Err(format!(
                    "Cannot preserve project xattr {name}: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        #[cfg(target_os = "macos")]
        if !extra.security.is_empty() {
            let text = CString::new(extra.security.clone()).map_err(|e| e.to_string())?;
            let acl = unsafe { acl_from_text(text.as_ptr()) };
            if acl.is_null() {
                return Err("Damaged macOS project ACL evidence".into());
            }
            let result = unsafe { acl_set_link_np(p.as_ptr(), 0x100, acl) };
            unsafe {
                acl_free(acl);
            }
            if result != 0 {
                return Err(format!(
                    "Cannot preserve macOS ACL: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        if let Some(mode) = mode {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(value, fs::Permissions::from_mode(mode))
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "macos")]
        if unsafe { lchflags(p.as_ptr(), extra.flags) } != 0 {
            return Err(format!(
                "Cannot preserve macOS project flags: {}",
                std::io::Error::last_os_error()
            ));
        }
        #[cfg(target_os = "linux")]
        {
            let metadata = fs::symlink_metadata(value).map_err(|e| e.to_string())?;
            if metadata.is_file() || metadata.is_dir() {
                linux_flags(value, Some(extra.flags))?;
            }
        }
        if capture(value)? != *extra {
            return Err(format!(
                "Project metadata differs after materialization: {}",
                value.display()
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ffi::c_void, os::windows::ffi::OsStrExt};
    #[repr(C)]
    struct Stream {
        size: i64,
        name: [u16; 296],
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn FindFirstStreamW(
            path: *const u16,
            level: i32,
            data: *mut Stream,
            flags: u32,
        ) -> *mut c_void;
        fn FindNextStreamW(handle: *mut c_void, data: *mut Stream) -> i32;
        fn FindClose(handle: *mut c_void) -> i32;
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
        fn CreateFileW(
            path: *const u16,
            access: u32,
            share: u32,
            security: *const c_void,
            creation: u32,
            flags: u32,
            template: *mut c_void,
        ) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetFileInformationByHandle(handle: *mut c_void, information: *mut u32) -> i32;
        fn SetFileAttributesW(path: *const u16, attributes: u32) -> i32;
        fn EncryptFileW(path: *const u16) -> i32;
        fn DecryptFileW(path: *const u16) -> i32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn GetSecurityInfo(
            handle: *mut c_void,
            kind: u32,
            info: u32,
            owner: *mut *mut c_void,
            group: *mut *mut c_void,
            dacl: *mut *mut c_void,
            sacl: *mut *mut c_void,
            descriptor: *mut *mut c_void,
        ) -> u32;
        fn GetSecurityDescriptorLength(descriptor: *const c_void) -> u32;
        fn SetKernelObjectSecurity(handle: *mut c_void, info: u32, data: *const c_void) -> i32;
        fn GetSecurityDescriptorControl(
            data: *const c_void,
            control: *mut u16,
            revision: *mut u32,
        ) -> i32;
        fn ConvertSecurityDescriptorToStringSecurityDescriptorW(
            data: *const c_void,
            revision: u32,
            info: u32,
            text: *mut *mut u16,
            length: *mut u32,
        ) -> i32;
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text: *const u16,
            revision: u32,
            data: *mut *mut c_void,
            length: *mut u32,
        ) -> i32;
    }
    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain([0]).collect()
    }
    pub(super) fn file_identity(path: &Path) -> Result<(u128, u64), String> {
        use std::os::windows::io::AsRawHandle;
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut information = [0u32; 13]; // BY_HANDLE_FILE_INFORMATION, DWORD aligned
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) }
            == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok((
            (u128::from(information[7]) << 64)
                | (u128::from(information[11]) << 32)
                | u128::from(information[12]),
            u64::from(information[10]),
        ))
    }
    pub(super) fn set_encrypted(path: &Path, encrypted: bool) -> Result<(), String> {
        let result = unsafe {
            if encrypted {
                EncryptFileW(wide(path).as_ptr())
            } else {
                DecryptFileW(wide(path).as_ptr())
            }
        };
        if result == 0 {
            let error = std::io::Error::last_os_error();
            if !encrypted && matches!(error.raw_os_error(), Some(5 | 87)) {
                // The destination is not encrypted and needs no decryption.
                return Ok(());
            }
            return Err(format!(
                "Native EFS support cannot {} project entry {}: {error}",
                if encrypted { "encrypt" } else { "decrypt" },
                path.display()
            ));
        }
        Ok(())
    }
    pub(super) fn capture(path: &Path) -> Result<Extra, String> {
        use std::os::windows::fs::MetadataExt;
        let source_metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        let efs = source_metadata.file_attributes() & 0x4000 != 0;
        let name = wide(path);
        // Open the link itself, never canonicalize/follow it to a live source
        // target when capturing or restoring security metadata.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                0x0002_0000,
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
        let mut descriptor = std::ptr::null_mut();
        let result = unsafe {
            GetSecurityInfo(
                handle,
                1,
                7,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        unsafe {
            CloseHandle(handle);
        }
        if result != 0 {
            return Err(format!(
                "Cannot capture project ACL {}: {}",
                path.display(),
                std::io::Error::from_raw_os_error(result as i32)
            ));
        }
        let security = unsafe {
            std::slice::from_raw_parts(
                descriptor.cast::<u8>(),
                GetSecurityDescriptorLength(descriptor) as usize,
            )
        }
        .to_vec();
        unsafe {
            LocalFree(descriptor);
        }
        let mut control = 0;
        let mut revision = 0;
        if unsafe {
            GetSecurityDescriptorControl(security.as_ptr().cast(), &mut control, &mut revision)
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // Self-relative descriptor layouts/padding can differ after a faithful
        // restore. SDDL compares the actual owner/group/ACL semantics instead.
        let mut sddl = std::ptr::null_mut();
        let mut length = 0;
        if unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                security.as_ptr().cast(),
                1,
                7,
                &mut sddl,
                &mut length,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let sddl_bytes = unsafe { std::slice::from_raw_parts(sddl, length as usize) };
        let end = sddl_bytes
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(sddl_bytes.len());
        let text = String::from_utf16(&sddl_bytes[..end]);
        unsafe {
            LocalFree(sddl.cast());
        }
        let mut text = text.map_err(|e| e.to_string())?;
        // AI/AR describe how Windows last computed the descriptor, not its
        // access rules. Compare owner/group, protected state and every ordered
        // ACE (including OI/CI flags), independent of that storage history.
        if let Some(start) = text.find("D:") {
            let end = text[start..]
                .find('(')
                .map(|offset| start + offset)
                .unwrap_or(text.len());
            let flags = text[start..end].replace("AI", "").replace("AR", "");
            text.replace_range(start..end, &flags);
        }
        let security = text.into_bytes();
        let mut attributes = Vec::new();
        if !crate::workspace_symlinks::is_link(
            &fs::symlink_metadata(path).map_err(|e| e.to_string())?,
        ) {
            let mut stream = Stream {
                size: 0,
                name: [0; 296],
            };
            let handle = unsafe { FindFirstStreamW(name.as_ptr(), 0, &mut stream, 0) };
            if handle as isize == -1 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(38) {
                    return Err(format!("Cannot enumerate project streams: {error}"));
                }
            } else {
                let result = (|| {
                    loop {
                        let length = stream
                            .name
                            .iter()
                            .position(|c| *c == 0)
                            .unwrap_or(stream.name.len());
                        let key = String::from_utf16(&stream.name[..length])
                            .map_err(|e| e.to_string())?;
                        if key != "::$DATA" {
                            if !key.starts_with(':') || !key.ends_with(":$DATA") {
                                return Err(format!(
                                    "Workspace capability gap: unsupported project stream {key}"
                                ));
                            }
                            let mut stream_path = path.as_os_str().to_os_string();
                            stream_path.push(&key);
                            attributes.push((
                                key,
                                fs::read(Path::new(&stream_path)).map_err(|e| e.to_string())?,
                            ));
                        }
                        if unsafe { FindNextStreamW(handle, &mut stream) } == 0 {
                            if std::io::Error::last_os_error().raw_os_error() != Some(38) {
                                return Err(std::io::Error::last_os_error().to_string());
                            }
                            break;
                        }
                    }
                    Ok(())
                })();
                unsafe {
                    FindClose(handle);
                }
                result?;
            }
        }
        attributes.sort();
        let flags = fs::symlink_metadata(path)
            .map_err(|e| e.to_string())?
            .file_attributes()
            & 0x3127;
        Ok(Extra {
            attributes,
            security,
            protected: control & 0x1000 != 0,
            flags,
            owner: None,
            efs,
        })
    }
    pub(super) fn restore(path: &Path, extra: &Extra, _mode: Option<u32>) -> Result<(), String> {
        for (key, bytes) in &extra.attributes {
            if !key.starts_with(':') || !key.ends_with(":$DATA") || key.contains(['/', '\\', '\0'])
            {
                return Err("Unsafe project stream name".into());
            }
            let mut name = path.as_os_str().to_os_string();
            name.push(key);
            fs::write(Path::new(&name), bytes).map_err(|e| e.to_string())?;
        }
        if unsafe {
            SetFileAttributesW(
                wide(path).as_ptr(),
                if extra.flags == 0 { 0x80 } else { extra.flags },
            )
        } == 0
        {
            return Err(format!(
                "Cannot preserve project attributes: {}",
                std::io::Error::last_os_error()
            ));
        }
        let flags = 7 | if extra.protected {
            0x8000_0000
        } else {
            0x2000_0000
        };
        let security = String::from_utf8(extra.security.clone()).map_err(|e| e.to_string())?;
        let text: Vec<u16> = security.encode_utf16().chain([0]).collect();
        let mut descriptor = std::ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err("Damaged project ACL evidence".into());
        }
        // Named-security setters re-inherit ACEs from the destination parent.
        // Restore the recorded descriptor directly so a different cache parent
        // cannot silently add permissions or alter the source's ordered ACEs.
        let handle = unsafe {
            CreateFileW(
                wide(path).as_ptr(),
                0x000e_0000,
                7,
                std::ptr::null(),
                3,
                0x0220_0000,
                std::ptr::null_mut(),
            )
        };
        let result = handle as isize != -1
            && unsafe { SetKernelObjectSecurity(handle, flags, descriptor) } != 0;
        let error = std::io::Error::last_os_error();
        if handle as isize != -1 {
            unsafe {
                CloseHandle(handle);
            }
        }
        unsafe {
            LocalFree(descriptor);
        }
        if !result {
            return Err(format!(
                "Cannot preserve project ACL {}: {error}",
                path.display()
            ));
        }
        set_encrypted(path, extra.efs)?;
        let actual = capture(path)?;
        if actual != *extra {
            return Err(format!(
                "Project ACL/streams/encryption differ after materialization: {}",
                path.display()
            ));
        }
        Ok(())
    }
}
