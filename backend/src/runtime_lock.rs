//! Cross-platform exclusive ownership of the Grapher runtime directory.
use std::{fs, path::Path};

#[cfg(windows)]
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    hash::{Hash, Hasher},
    sync::{Mutex, OnceLock},
};

#[cfg(unix)]
use std::os::fd::AsRawFd;

pub struct RuntimeLock {
    marker: fs::File,
    #[cfg(windows)]
    mutex: usize,
    #[cfg(windows)]
    key: String,
}

#[cfg(windows)]
static PROCESS_LOCKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

pub fn acquire(root: &Path) -> Result<RuntimeLock, String> {
    let marker = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("runtime.lock"))
        .map_err(|error| error.to_string())?;

    #[cfg(unix)]
    {
        let result = unsafe { libc::flock(marker.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result != 0 {
            return Err("Another Grapher instance owns this runtime. Close it before opening this data directory again.".into());
        }
        return Ok(RuntimeLock { marker });
    }

    #[cfg(windows)]
    {
        let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let mut hasher = DefaultHasher::new();
        canonical.to_string_lossy().hash(&mut hasher);
        let key = format!("Local\\GrapherRuntime-{:016x}", hasher.finish());
        let locks = PROCESS_LOCKS.get_or_init(|| Mutex::new(HashSet::new()));
        {
            let mut owned = locks.lock().map_err(|error| error.to_string())?;
            if !owned.insert(key.clone()) {
                return Err("Another Grapher instance owns this runtime. Close it before opening this data directory again.".into());
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
            return Err("Another Grapher instance owns this runtime. Close it before opening this data directory again.".into());
        }
        return Ok(RuntimeLock {
            marker,
            mutex: mutex as usize,
            key,
        });
    }

    #[cfg(not(any(unix, windows)))]
    Ok(RuntimeLock { marker })
}

impl Drop for RuntimeLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            let _ = libc::flock(self.marker.as_raw_fd(), libc::LOCK_UN);
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
    fn lock_rejects_competing_owner_and_releases_on_drop() {
        let temp = tempfile::tempdir().unwrap();
        let first = acquire(temp.path()).unwrap();
        assert!(acquire(temp.path()).is_err());
        drop(first);
        let second = acquire(temp.path()).unwrap();
        drop(second);
    }
}
