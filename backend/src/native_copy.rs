//! Private byte views: native CoW clones where supported, otherwise reliable
//! copies. No writable hard links, shared mutable inode, or execution fallback.
use std::{fs, io, path::Path};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CopyKind {
    Clone,
    Bytes,
}

pub(crate) fn copy(source: &Path, destination: &Path) -> Result<CopyKind, String> {
    if fs::symlink_metadata(destination).is_ok() {
        return Err(format!(
            "Private copy destination already exists: {}",
            destination.display()
        ));
    }
    if !fs::symlink_metadata(source)
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err("Private copy source must be a regular file".into());
    }
    match clone(source, destination) {
        Ok(()) => Ok(CopyKind::Clone),
        Err(error) if unsupported(&error) => {
            // Failed native clones may have created an empty/partial destination.
            match fs::remove_file(destination) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
            fs::copy(source, destination).map_err(|e| e.to_string())?;
            Ok(CopyKind::Bytes)
        }
        Err(error) => {
            let _ = fs::remove_file(destination);
            Err(format!("Native private clone failed: {error}"))
        }
    }
}

fn unsupported(error: &io::Error) -> bool {
    #[cfg(windows)]
    {
        matches!(error.raw_os_error(), Some(1 | 17 | 50 | 87))
            || error.kind() == io::ErrorKind::Unsupported
    }
    #[cfg(unix)]
    {
        matches!(
            error.raw_os_error(),
            Some(libc::EXDEV | libc::ENOTSUP | libc::ENOTTY | libc::EINVAL | libc::ENOSYS)
        ) || error.kind() == io::ErrorKind::Unsupported
    }
    #[cfg(not(any(unix, windows)))]
    {
        error.kind() == io::ErrorKind::Unsupported
    }
}

#[cfg(target_os = "linux")]
fn clone(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let source = fs::File::open(source)?;
    let destination = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    if unsafe {
        libc::ioctl(
            destination.as_raw_fd(),
            0x4004_9409 as libc::c_ulong,
            source.as_raw_fd(),
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn clone(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    if unsafe { clonefile(source.as_ptr(), destination.as_ptr(), 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(target_os = "macos")]
extern "C" {
    fn clonefile(source: *const libc::c_char, destination: *const libc::c_char, flags: u32) -> i32;
}

#[cfg(windows)]
fn clone(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{
        io::{Read, Seek, Write},
        os::windows::io::AsRawHandle,
    };
    #[repr(C)]
    struct Extents {
        source: *mut std::ffi::c_void,
        source_offset: i64,
        target_offset: i64,
        bytes: i64,
    }
    let mut source = fs::File::open(source)?;
    let mut destination = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(destination)?;
    let size = source.metadata()?.len();
    if size > i64::MAX as u64 || size < 65536 {
        return Err(io::Error::from(io::ErrorKind::Unsupported));
    }
    // A conservative cluster-aligned range; unsupported FS/alignment is an
    // explicit byte-copy outcome, not a claim that NTFS/ReFS clones always work.
    let bytes = size / 65536 * 65536;
    destination.set_len(size)?;
    let mut extents = Extents {
        source: source.as_raw_handle(),
        source_offset: 0,
        target_offset: 0,
        bytes: bytes as i64,
    };
    let mut returned = 0;
    if unsafe {
        DeviceIoControl(
            destination.as_raw_handle(),
            0x0009_8344,
            (&mut extents as *mut Extents).cast(),
            std::mem::size_of_val(&extents) as u32,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    source.seek(io::SeekFrom::Start(bytes))?;
    destination.seek(io::SeekFrom::Start(bytes))?;
    let mut tail = [0; 65536];
    let count = source.read(&mut tail)?;
    destination.write_all(&tail[..count])?;
    if bytes + count as u64 != size {
        return Err(io::Error::other(
            "Source changed during private block clone",
        ));
    }
    destination.sync_all()?;
    Ok(())
}
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn DeviceIoControl(
        file: *mut std::ffi::c_void,
        code: u32,
        input: *mut std::ffi::c_void,
        input_size: u32,
        output: *mut std::ffi::c_void,
        output_size: u32,
        returned: *mut u32,
        overlapped: *mut std::ffi::c_void,
    ) -> i32;
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn clone(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_copies_never_alias_writers_and_never_overwrite_existing_paths() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let a = root.path().join("a");
        let b = root.path().join("b");
        fs::write(&source, vec![7; 2 * 1024 * 1024 + 57]).unwrap();
        let kind = copy(&source, &a).unwrap();
        copy(&source, &b).unwrap();
        assert_eq!(fs::read(&source).unwrap(), fs::read(&a).unwrap());
        fs::write(&a, b"private replacement").unwrap();
        assert_eq!(fs::read(&source).unwrap(), fs::read(&b).unwrap());
        assert!(copy(&source, &a).is_err());
        assert_eq!(fs::read(&a).unwrap(), b"private replacement");
        eprintln!("Native filesystem private copy outcome: {kind:?}");
    }
}
