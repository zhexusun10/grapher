//! Per-backend Pi copies have a process-held lease. Reap only copies whose
//! lease can be acquired; crashes release the lease without losing Run data.
use crate::path_safety::real_child_path;
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const PREFIX: &str = "grapher-native-engine-";
const MARKER: &str = ".grapher-native-runtime.json";
const LEASE: &str = "runtime.lock";

pub(crate) struct NativeRuntime {
    pub directory: PathBuf,
    _lease: fs::File,
}

fn acquire(directory: &Path) -> Result<fs::File, String> {
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join(LEASE))
        .map_err(|error| error.to_string())?;
    // Unlike a Windows named mutex, a file lock is not abandoned when the
    // preparation THREAD exits. The backend keeps this handle for its lifetime.
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("Native runtime is in use".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        #[repr(C)]
        struct Overlapped {
            internal: usize,
            internal_high: usize,
            offset: u32,
            offset_high: u32,
            event: *mut std::ffi::c_void,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn LockFileEx(
                file: *mut std::ffi::c_void,
                flags: u32,
                reserved: u32,
                bytes_low: u32,
                bytes_high: u32,
                overlapped: *mut Overlapped,
            ) -> i32;
        }
        let mut overlapped = Overlapped {
            internal: 0,
            internal_high: 0,
            offset: 0,
            offset_high: 0,
            event: std::ptr::null_mut(),
        };
        if unsafe { LockFileEx(file.as_raw_handle(), 3, 0, 1, 0, &mut overlapped) } == 0 {
            return Err(format!(
                "Native runtime lease unavailable: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    #[cfg(not(any(unix, windows)))]
    return Err("Native runtime leases are unsupported on this host".into());
    Ok(file)
}

fn parent_directory(parent: &Path) -> Result<Option<PathBuf>, String> {
    match fs::symlink_metadata(parent) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(format!(
                "Refusing linked or non-directory native runtime parent: {}",
                parent.display()
            ));
        }
        Ok(_) => {}
    }
    let canonical = parent.canonicalize().map_err(|error| error.to_string())?;
    if let Some(base) = parent.parent().filter(|base| !base.as_os_str().is_empty()) {
        if canonical.parent()
            != Some(
                base.canonicalize()
                    .map_err(|error| error.to_string())?
                    .as_path(),
            )
        {
            return Err(format!(
                "Refusing redirected native runtime parent: {}",
                parent.display()
            ));
        }
    }
    Ok(Some(canonical))
}

pub(crate) fn create(parent: &Path) -> Result<NativeRuntime, String> {
    if parent_directory(parent)?.is_none() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let parent = parent_directory(parent)?.ok_or("Native runtime parent is missing")?;
    let directory = parent.join(format!("{PREFIX}{}", Uuid::new_v4()));
    fs::create_dir(&directory).map_err(|error| error.to_string())?;
    let result = (|| {
        let lease = acquire(&directory)?;
        fs::write(
            directory.join(MARKER),
            r#"{"kind":"grapher-native-runtime","version":1}"#,
        )
        .map_err(|error| error.to_string())?;
        Ok(NativeRuntime {
            directory: directory.clone(),
            _lease: lease,
        })
    })();
    if result.is_err() {
        if let Err(error) = fs::remove_dir_all(&directory) {
            eprintln!(
                "[Grapher] Cannot remove failed runtime allocation {}: {error}",
                directory.display()
            );
        }
    }
    result
}

/// An uncommitted preparation is disposable on EVERY early-return path,
/// including spawn errors, invalid output, missing entrypoints and shutdown.
pub(crate) struct Preparation(Option<NativeRuntime>);

impl Preparation {
    pub fn new(parent: &Path) -> Result<Self, String> {
        create(parent).map(|runtime| Self(Some(runtime)))
    }
    pub fn directory(&self) -> &Path {
        &self.0.as_ref().expect("uncommitted preparation").directory
    }
    pub fn commit(mut self) -> NativeRuntime {
        self.0.take().expect("uncommitted preparation")
    }
}

impl Drop for Preparation {
    fn drop(&mut self) {
        if let Some(runtime) = self.0.take() {
            if let Err(error) = remove(&runtime) {
                eprintln!("[Grapher] {error}");
            }
        }
    }
}

pub(crate) fn release(cache: &std::sync::Mutex<Option<NativeRuntime>>) -> Result<(), String> {
    let runtime = cache.lock().map_err(|error| error.to_string())?.take();
    if let Some(runtime) = runtime {
        remove(&runtime)?;
    }
    Ok(())
}

/// Unmarked legacy copies have no lease protocol. Include them only during an
/// explicitly requested offline cleanup after ALL Grapher backends are stopped.
pub(crate) fn unused(parent: &Path, legacy: bool) -> Result<Vec<NativeRuntime>, String> {
    let Some(parent) = parent_directory(parent)? else {
        return Ok(Vec::new());
    };
    let mut unused = Vec::new();
    for entry in fs::read_dir(&parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.strip_prefix(PREFIX).is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-')
        }) {
            continue;
        }
        let path = parent.join(&name);
        let Some(directory) = real_child_path(&parent, &path, false)? else {
            continue;
        };
        let marker = real_child_path(&parent, &path.join(MARKER), true)?;
        if let Some(marker) = marker {
            let owned = fs::read(marker)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .is_some_and(|value| {
                    value["kind"] == "grapher-native-runtime" && value["version"] == 1
                });
            if !owned {
                continue;
            }
        } else {
            if !legacy {
                continue;
            }
            // A prefix alone is not proof that this is a disposable engine copy.
            let mut complete = true;
            for (child, file) in [
                ("engine/entrypoint.mjs", true),
                ("scripts/pi-baseline.mjs", true),
                ("package.json", true),
                ("pi/.git", false),
            ] {
                complete &= real_child_path(&parent, &path.join(child), file)?.is_some();
            }
            if !complete {
                continue;
            }
        }
        // Validate an existing lock file before acquire() opens it.
        real_child_path(&parent, &path.join("runtime.lock"), true)?;
        if let Ok(lease) = acquire(&directory) {
            unused.push(NativeRuntime {
                directory,
                _lease: lease,
            });
        }
    }
    unused.sort_by(|a, b| a.directory.cmp(&b.directory));
    Ok(unused)
}

pub(crate) fn remove(runtime: &NativeRuntime) -> Result<(), String> {
    // Hold the lease through deletion; Windows file handles allow delete sharing.
    let removal = (|| -> std::io::Result<()> {
        // Keep proof/lease until every payload is gone. A locked dependency
        // must not turn a marked cache into unrecognizable partial garbage.
        for entry in fs::read_dir(&runtime.directory)? {
            let entry = entry?;
            if matches!(entry.file_name().to_str(), Some(MARKER | LEASE)) {
                continue;
            }
            if entry.path().is_dir() {
                fs::remove_dir_all(entry.path())?;
            } else {
                fs::remove_file(entry.path())?;
            }
        }
        fs::remove_dir_all(&runtime.directory)
    })();
    match removal {
        Ok(()) => Ok(()),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound && !runtime.directory.exists() =>
        {
            Ok(())
        }
        Err(error) => {
            if runtime.directory.is_dir() && !runtime.directory.join(MARKER).exists() {
                let _ = fs::write(
                    runtime.directory.join(MARKER),
                    r#"{"kind":"grapher-native-runtime","version":1}"#,
                );
            }
            Err(format!(
                "Cannot remove native runtime {}: {error}",
                runtime.directory.display()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_copies_are_reaped_but_live_leases_and_unmarked_data_are_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("runtimes");
        let live = create(&parent).unwrap();
        let stale = create(&parent).unwrap();
        let stale_path = stale.directory.clone();
        fs::create_dir_all(stale_path.join("pi/node_modules/dependency")).unwrap();
        fs::write(stale_path.join("pi/node_modules/dependency/file"), "copy").unwrap();
        drop(stale);
        let unknown = parent.join("grapher-native-engine-unknown");
        fs::create_dir(&unknown).unwrap();
        let candidates = unused(&parent, false).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].directory, stale_path);
        remove(&candidates[0]).unwrap();
        assert!(!stale_path.exists());
        assert!(live.directory.exists());
        assert!(unknown.exists());
    }

    #[test]
    fn lease_survives_the_preparation_thread_exiting() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("runtimes");
        let worker_parent = parent.clone();
        let live = std::thread::spawn(move || create(&worker_parent).unwrap())
            .join()
            .unwrap();
        assert!(unused(&parent, false).unwrap().is_empty());
        drop(live);
        assert_eq!(unused(&parent, false).unwrap().len(), 1);
    }

    #[test]
    fn failed_preparations_and_released_caches_are_removed_immediately() {
        let temp = tempfile::tempdir().unwrap();
        let pending = Preparation::new(temp.path()).unwrap();
        let path = pending.directory().to_path_buf();
        fs::create_dir_all(path.join("pi/dependencies")).unwrap();
        fs::write(path.join("pi/dependencies/file"), "incomplete").unwrap();
        drop(pending);
        assert!(!path.exists());
        let ready = Preparation::new(temp.path()).unwrap();
        let path = ready.directory().to_path_buf();
        let cache = std::sync::Mutex::new(Some(ready.commit()));
        assert!(path.exists());
        release(&cache).unwrap();
        assert!(!path.exists());
        assert!(cache.lock().unwrap().is_none());
        release(&cache).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn failed_removal_preserves_marker_and_can_be_reclaimed_later() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let runtime = create(temp.path()).unwrap();
        fs::create_dir_all(runtime.directory.join("pi/dependencies")).unwrap();
        let file = runtime.directory.join("pi/dependencies/locked");
        fs::write(&file, "locked").unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(file)
            .unwrap();
        assert!(remove(&runtime).is_err());
        assert!(runtime.directory.join(MARKER).is_file());
        let path = runtime.directory.clone();
        drop(runtime);
        drop(locked);
        let candidates = unused(temp.path(), false).unwrap();
        assert_eq!(candidates.len(), 1);
        remove(&candidates[0]).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn legacy_engines_require_opt_in_and_a_complete_real_layout() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("grapher-native-engine-old");
        for path in ["engine", "scripts", "pi/.git"] {
            fs::create_dir_all(legacy.join(path)).unwrap();
        }
        for path in [
            "engine/entrypoint.mjs",
            "scripts/pi-baseline.mjs",
            "package.json",
        ] {
            fs::write(legacy.join(path), "fixture").unwrap();
        }
        let unknown = temp.path().join("grapher-native-engine-userdata");
        fs::create_dir(&unknown).unwrap();
        assert!(unused(temp.path(), false).unwrap().is_empty());
        let candidates = unused(temp.path(), true).unwrap();
        assert_eq!(candidates.len(), 1);
        remove(&candidates[0]).unwrap();
        assert!(!legacy.exists());
        assert!(unknown.exists());
    }

    #[test]
    fn linked_runtime_roots_and_lock_files_cannot_authorize_cleanup() {
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep"), "external").unwrap();
        let linked = temp.path().join("linked");
        crate::path_safety::directory_link(&outside, &linked);
        assert!(unused(&linked, true).is_err());
        let parent = temp.path().join("runtimes");
        let runtime = create(&parent).unwrap();
        let path = runtime.directory.clone();
        drop(runtime);
        fs::remove_file(path.join("runtime.lock")).unwrap();
        crate::path_safety::directory_link(&outside, &path.join("runtime.lock"));
        assert!(unused(&parent, false).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("keep")).unwrap(),
            "external"
        );
    }
}
