//! Cross-platform exclusive runtime locks interoperable with `backend/src/runtime_lock.rs`.
use std::{fs, path::Path};

#[cfg(unix)]
use std::os::fd::AsRawFd;

#[cfg(windows)]
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    hash::{Hash, Hasher},
    sync::{Mutex, OnceLock},
};

pub struct RuntimeLock {
    _marker: fs::File,
    #[cfg(windows)]
    mutex: usize,
    #[cfg(windows)]
    key: String,
}

#[cfg(windows)]
static PROCESS_LOCKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// Acquire the exact exclusive runtime lock used by the Grapher backend
/// (`<root>/runtime.lock` via `flock` on Unix and `Local\GrapherRuntime-<hash>`
/// named mutex on Windows).
pub fn acquire_runtime(root: &Path) -> Result<RuntimeLock, String> {
    let lock_path = root.join("runtime.lock");
    reject_symlink_lock_file(&lock_path)?;
    acquire_lock_file(
        root,
        &lock_path,
        "Local\\GrapherRuntime",
        "Another Grapher instance owns this runtime. Close it before migrating or opening this data directory.",
    )
}

/// Acquire an exclusive migration guard lock under the desktop `app_data_dir()`
/// so concurrent first launches cannot race while publishing `data`.
pub fn acquire_migration_guard(parent: &Path) -> Result<RuntimeLock, String> {
    let lock_path = parent.join(".grapher-migration.lock");
    reject_symlink_lock_file(&lock_path)?;
    acquire_lock_file(
        parent,
        &lock_path,
        "Local\\GrapherDesktopMigration",
        "Another Grapher desktop launch is currently initializing this app-data directory.",
    )
}

fn reject_symlink_lock_file(lock_path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(lock_path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.file_type().is_file() {
                return Err(format!(
                    "Refusing to open unsafe lock file path: {}",
                    lock_path.display()
                ));
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
                if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return Err(format!(
                        "Refusing to open reparse-point lock file path: {}",
                        lock_path.display()
                    ));
                }
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Cannot inspect lock file {}: {error}",
            lock_path.display()
        )),
    }
}

fn acquire_lock_file(
    scope_dir: &Path,
    lock_path: &Path,
    #[allow(unused_variables)] windows_prefix: &str,
    busy_message: &str,
) -> Result<RuntimeLock, String> {
    let mut open_options = fs::OpenOptions::new();
    open_options
        .read(true)
        .write(true)
        .create(true)
        .truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_options.custom_flags(libc::O_NOFOLLOW);
    }
    let marker = open_options
        .open(lock_path)
        .map_err(|error| format!("Cannot open lock file {}: {error}", lock_path.display()))?;

    #[cfg(unix)]
    {
        let _ = scope_dir;
        let result = unsafe { libc::flock(marker.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result != 0 {
            return Err(busy_message.into());
        }
        Ok(RuntimeLock { _marker: marker })
    }

    #[cfg(windows)]
    {
        let canonical = scope_dir
            .canonicalize()
            .unwrap_or_else(|_| scope_dir.to_path_buf());
        let mut hasher = DefaultHasher::new();
        canonical.to_string_lossy().hash(&mut hasher);
        let key = format!("{windows_prefix}-{:016x}", hasher.finish());
        let locks = PROCESS_LOCKS.get_or_init(|| Mutex::new(HashSet::new()));
        {
            let mut owned = locks.lock().map_err(|error| error.to_string())?;
            if !owned.insert(key.clone()) {
                return Err(busy_message.into());
            }
        }
        let wide: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
        let mutex = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
        if mutex.is_null() {
            let _ = locks.lock().map(|mut owned| owned.remove(&key));
            return Err(windows_error("CreateMutex"));
        }
        let waited = unsafe { WaitForSingleObject(mutex, 0) };
        if waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED {
            unsafe { CloseHandle(mutex) };
            let _ = locks.lock().map(|mut owned| owned.remove(&key));
            return Err(busy_message.into());
        }
        Ok(RuntimeLock {
            _marker: marker,
            mutex: mutex as usize,
            key,
        })
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (scope_dir, busy_message);
        Ok(RuntimeLock { _marker: marker })
    }
}

impl Drop for RuntimeLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            let _ = libc::flock(self._marker.as_raw_fd(), libc::LOCK_UN);
        }

        #[cfg(windows)]
        unsafe {
            let mutex = self.mutex as RawHandle;
            let _ = ReleaseMutex(mutex);
            let _ = CloseHandle(mutex);
            if let Some(locks) = PROCESS_LOCKS.get() {
                let _ = locks.lock().map(|mut owned| owned.remove(&self.key));
            }
        }
    }
}

#[cfg(windows)]
type RawHandle = *mut std::ffi::c_void;

#[cfg(windows)]
const WAIT_OBJECT_0: u32 = 0;
#[cfg(windows)]
const WAIT_ABANDONED: u32 = 0x0000_0080;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CloseHandle(handle: RawHandle) -> i32;
    fn CreateMutexW(
        attributes: *const std::ffi::c_void,
        initial_owner: i32,
        name: *const u16,
    ) -> RawHandle;
    fn GetLastError() -> u32;
    fn ReleaseMutex(mutex: RawHandle) -> i32;
    fn WaitForSingleObject(handle: RawHandle, milliseconds: u32) -> u32;
}

#[cfg(windows)]
fn windows_error(operation: &str) -> String {
    format!("{operation} failed with Windows error {}", unsafe {
        GetLastError()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_lock_rejects_competing_owner_and_releases_on_drop() {
        let temp = tempfile::tempdir().unwrap();
        let first = acquire_runtime(temp.path()).unwrap();
        assert!(acquire_runtime(temp.path()).is_err());
        drop(first);
        let second = acquire_runtime(temp.path()).unwrap();
        drop(second);
    }

    #[cfg(unix)]
    #[test]
    fn runtime_lock_rejects_symlink_lock_file() {
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, b"sensitive").unwrap();
        let store = temp.path().join("store");
        fs::create_dir_all(&store).unwrap();
        std::os::unix::fs::symlink(&outside, store.join("runtime.lock")).unwrap();
        let err = acquire_runtime(&store).err().unwrap();
        assert!(err.contains("unsafe lock file"), "{err}");
    }
}
