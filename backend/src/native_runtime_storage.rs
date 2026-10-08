//! Content-keyed Pi copies are shared across backends and retained on exit.
//! Shared process leases protect readers; preparation/cleanup take exclusive
//! leases. Crashes release locks without losing cached engines or Run data.
use crate::path_safety::real_child_path;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use uuid::Uuid;

const PREFIX: &str = "grapher-native-engine-";
const MARKER: &str = ".grapher-native-runtime.json";
const LEASE: &str = "runtime.lock";

fn runtime_name(name: &str) -> bool {
    name.strip_prefix(PREFIX).is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}

pub(crate) struct NativeRuntime {
    pub directory: PathBuf,
    _lease: fs::File,
    // Offline cleanup keeps the cache lock until its entire plan is dropped.
    _parent_lease: Option<Arc<fs::File>>,
    persistent: bool,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct Overlapped {
    internal: usize,
    internal_high: usize,
    offset: u32,
    offset_high: u32,
    event: *mut std::ffi::c_void,
}

#[cfg(windows)]
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
    fn UnlockFileEx(
        file: *mut std::ffi::c_void,
        reserved: u32,
        bytes_low: u32,
        bytes_high: u32,
        overlapped: *mut Overlapped,
    ) -> i32;
}

pub(crate) fn lock_file(path: &Path, shared: bool) -> Result<Option<fs::File>, String> {
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|error| error.to_string())?;
    // File locks outlive the preparation thread, unlike Windows named mutexes.
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let mode = if shared { libc::LOCK_SH } else { libc::LOCK_EX };
        if unsafe { libc::flock(file.as_raw_fd(), mode | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::WouldBlock {
                return Ok(None);
            }
            return Err(error.to_string());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        let flags = if shared { 1 } else { 3 }; // FAIL_IMMEDIATELY, optional EXCLUSIVE_LOCK
        if unsafe {
            LockFileEx(
                file.as_raw_handle(),
                flags,
                0,
                1,
                0,
                &mut Overlapped::default(),
            )
        } == 0
        {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(33) {
                return Ok(None);
            } // ERROR_LOCK_VIOLATION
            return Err(error.to_string());
        }
    }
    #[cfg(not(any(unix, windows)))]
    return Err("Native runtime leases are unsupported on this host".into());
    Ok(Some(file))
}

fn unlock(file: &fs::File) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        if unsafe { UnlockFileEx(file.as_raw_handle(), 0, 1, 0, &mut Overlapped::default()) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

fn acquire(directory: &Path) -> Result<fs::File, String> {
    lock_file(&directory.join(LEASE), false)?.ok_or_else(|| "Native runtime is in use".into())
}

fn lock_parent(parent: &Path, cancelled: &impl Fn() -> bool) -> Result<fs::File, String> {
    let path = parent.join(".native-runtime-cache.lock");
    real_child_path(parent, &path, true)?;
    loop {
        if cancelled() {
            return Err("Backend is shutting down".into());
        }
        if let Some(lease) = lock_file(&path, false)? {
            return Ok(lease);
        }
        std::thread::sleep(Duration::from_millis(30));
    }
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
            _parent_lease: None,
            persistent: false,
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
    fn commit_shared(mut self, key: &str) -> Result<NativeRuntime, String> {
        let runtime = self.0.as_mut().expect("uncommitted preparation");
        let marker = runtime.directory.join(".grapher-native-runtime.tmp");
        fs::write(
            &marker,
            serde_json::to_vec(&serde_json::json!({
                "kind": "grapher-native-runtime", "version": 2, "ready": true, "cacheKey": key,
            }))
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        // Never truncate the ownership marker: an interrupted commit remains
        // a recognizable v1 preparation that the next backend can reclaim.
        fs::rename(marker, runtime.directory.join(MARKER)).map_err(|error| error.to_string())?;
        // The parent lock prevents cleanup/another preparer during downgrade.
        unlock(&runtime._lease)?;
        runtime._lease = lock_file(&runtime.directory.join(LEASE), true)?
            .ok_or("Cannot acquire shared native runtime lease")?;
        runtime.persistent = true;
        Ok(self.commit())
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
        if !runtime.persistent {
            remove(&runtime)?;
        }
        // Shared caches survive shutdown; only this backend's reader is released.
    }
    Ok(())
}

/// Unmarked legacy copies have no lease protocol. Include them only during an
/// explicitly requested offline cleanup after ALL Grapher backends are stopped.
pub(crate) fn unused(parent: &Path, legacy: bool) -> Result<Vec<NativeRuntime>, String> {
    unused_with_cancel(parent, legacy, || false)
}

pub(crate) fn unused_with_cancel(
    parent: &Path,
    legacy: bool,
    cancelled: impl Fn() -> bool,
) -> Result<Vec<NativeRuntime>, String> {
    let Some(parent) = parent_directory(parent)? else {
        return Ok(Vec::new());
    };
    let guard = Arc::new(lock_parent(&parent, &cancelled)?);
    let mut copies = unused_locked(&parent, legacy, None)?;
    for copy in &mut copies {
        copy._parent_lease = Some(guard.clone());
    }
    Ok(copies)
}

fn unused_locked(
    parent: &Path,
    legacy: bool,
    keep_key: Option<&str>,
) -> Result<Vec<NativeRuntime>, String> {
    let mut unused = Vec::new();
    for entry in fs::read_dir(&parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !runtime_name(&name) {
            continue;
        }
        let path = parent.join(&name);
        let Some(directory) = real_child_path(&parent, &path, false)? else {
            continue;
        };
        let marker = real_child_path(&parent, &path.join(MARKER), true)?;
        if let Some(marker) = marker {
            let value = fs::read(marker)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
            let Some(value) = value.filter(|value| {
                value["kind"] == "grapher-native-runtime"
                    && matches!(value["version"].as_u64(), Some(1 | 2))
            }) else {
                continue;
            };
            if keep_key.is_some_and(|key| {
                value["version"] == 2
                    && value["ready"] == true
                    && value["cacheKey"].as_str() == Some(key)
            }) && real_child_path(parent, &path.join("engine/entrypoint.mjs"), true)?.is_some()
            {
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
                _parent_lease: None,
                persistent: false,
            });
        }
    }
    unused.sort_by(|a, b| a.directory.cmp(&b.directory));
    Ok(unused)
}

#[cfg(test)]
fn get_or_prepare(
    parent: &Path,
    key: &str,
    cancelled: impl Fn() -> bool,
    prepare: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<NativeRuntime, String> {
    get_or_prepare_verified(parent, key, cancelled, prepare, |_| Ok(true))
}

pub(crate) fn get_or_prepare_verified(
    parent: &Path,
    key: &str,
    cancelled: impl Fn() -> bool,
    prepare: impl FnOnce(&Path) -> Result<(), String>,
    validate: impl Fn(&Path) -> Result<bool, String>,
) -> Result<NativeRuntime, String> {
    if key.len() != 64 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid native runtime cache key".into());
    }
    if parent_directory(parent)?.is_none() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let parent = parent_directory(parent)?.ok_or("Native runtime parent is missing")?;
    let _guard = lock_parent(&parent, &cancelled)?;
    // Reap failed/old preparations and obsolete versions, never live readers.
    for copy in unused_locked(&parent, false, Some(key))? {
        if let Err(error) = remove(&copy) {
            eprintln!("[Grapher] {error}");
        }
    }
    for entry in fs::read_dir(&parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !runtime_name(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let path = entry.path();
        let Some(directory) = real_child_path(&parent, &path, false)? else {
            continue;
        };
        let Some(marker) = real_child_path(&parent, &path.join(MARKER), true)? else {
            continue;
        };
        let value = fs::read(marker)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        if !value.is_some_and(|value| {
            value["kind"] == "grapher-native-runtime"
                && value["version"] == 2
                && value["ready"] == true
                && value["cacheKey"].as_str() == Some(key)
        }) {
            continue;
        }
        if real_child_path(&parent, &path.join("engine/entrypoint.mjs"), true)?.is_none() {
            continue;
        }
        real_child_path(&parent, &path.join(LEASE), true)?;
        let lease = lock_file(&directory.join(LEASE), true)?
            .ok_or("Native runtime cache is being cleaned; retry preparation")?;
        if cancelled() {
            return Err("Backend is shutting down".into());
        }
        let valid = validate(&directory)?;
        if cancelled() {
            return Err("Backend is shutting down".into());
        }
        if !valid {
            drop(lease);
            let lease = acquire(&directory)
                .map_err(|_| "Shared native runtime failed verification and is still in use")?;
            remove(&NativeRuntime {
                directory,
                _lease: lease,
                _parent_lease: None,
                persistent: false,
            })?;
            continue;
        }
        return Ok(NativeRuntime {
            directory,
            _lease: lease,
            _parent_lease: None,
            persistent: true,
        });
    }
    let preparation = Preparation::new(&parent)?;
    prepare(preparation.directory())?;
    if cancelled() {
        return Err("Backend is shutting down".into());
    }
    if !preparation
        .directory()
        .join("engine/entrypoint.mjs")
        .is_file()
    {
        return Err("Incomplete native runtime: engine entrypoint is missing".into());
    }
    let valid = validate(preparation.directory())?;
    if cancelled() {
        return Err("Backend is shutting down".into());
    }
    if !valid {
        return Err("Native runtime inputs changed during preparation; retry".into());
    }
    preparation.commit_shared(key)
}

pub(crate) fn remove(runtime: &NativeRuntime) -> Result<(), String> {
    if runtime.persistent {
        return Err("Cannot delete a shared native runtime reader".into());
    }
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

    fn prepare_fixture(directory: &Path) -> Result<(), String> {
        fs::create_dir_all(directory.join("engine")).map_err(|error| error.to_string())?;
        fs::write(directory.join("engine/entrypoint.mjs"), "export {};")
            .map_err(|error| error.to_string())
    }

    #[test]
    fn concurrent_backends_share_one_copy_and_restart_reuses_it() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        };
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("runtimes");
        let preparations = Arc::new(AtomicUsize::new(0));
        let (started, preparation_started) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let first_parent = parent.clone();
        let first_count = preparations.clone();
        let first = std::thread::spawn(move || {
            get_or_prepare(
                &first_parent,
                &"a".repeat(64),
                || false,
                |directory| {
                    first_count.fetch_add(1, Ordering::SeqCst);
                    started.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(5)).unwrap();
                    prepare_fixture(directory)
                },
            )
            .unwrap()
        });
        preparation_started
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        let second_parent = parent.clone();
        let second = std::thread::spawn(move || {
            get_or_prepare(
                &second_parent,
                &"a".repeat(64),
                || false,
                |_| panic!("same engine must not be copied twice"),
            )
            .unwrap()
        });
        release.send(()).unwrap();
        let first = first.join().unwrap();
        let second = second.join().unwrap();
        assert_eq!(first.directory, second.directory);
        assert_eq!(preparations.load(Ordering::SeqCst), 1);
        assert!(
            unused(&parent, false).unwrap().is_empty(),
            "live shared readers block cleanup"
        );
        let path = first.directory.clone();
        release_cache_for_test(first);
        assert!(path.is_dir());
        assert!(
            unused(&parent, false).unwrap().is_empty(),
            "other backend still holds its reader"
        );
        release_cache_for_test(second);
        let restarted = get_or_prepare(
            &parent,
            &"a".repeat(64),
            || false,
            |_| panic!("restart must reuse cache"),
        )
        .unwrap();
        assert_eq!(restarted.directory, path);
        assert_eq!(
            fs::read_dir(&parent)
                .unwrap()
                .filter(|entry| entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(PREFIX))
                .count(),
            1
        );
        drop(restarted);
        let copies = unused(&parent, false).unwrap();
        assert_eq!(copies.len(), 1);
        remove(&copies[0]).unwrap();
        assert!(!path.exists());
    }

    fn release_cache_for_test(runtime: NativeRuntime) {
        release(&std::sync::Mutex::new(Some(runtime))).unwrap();
    }

    #[test]
    fn engine_changes_rebuild_without_deleting_another_backends_live_version() {
        let temp = tempfile::tempdir().unwrap();
        let first =
            get_or_prepare(temp.path(), &"a".repeat(64), || false, prepare_fixture).unwrap();
        let first_path = first.directory.clone();
        let second =
            get_or_prepare(temp.path(), &"b".repeat(64), || false, prepare_fixture).unwrap();
        assert_ne!(first.directory, second.directory);
        assert!(first_path.is_dir());
        drop(first);
        let reused = get_or_prepare(
            temp.path(),
            &"b".repeat(64),
            || false,
            |_| panic!("same version"),
        )
        .unwrap();
        assert_eq!(reused.directory, second.directory);
        assert!(!first_path.exists(), "obsolete unused engine is reclaimed");
    }

    #[test]
    fn shared_preparation_failure_is_removed_and_remains_retryable() {
        let temp = tempfile::tempdir().unwrap();
        let key = "a".repeat(64);
        let mut failed_path = PathBuf::new();
        let failed = get_or_prepare(
            temp.path(),
            &key,
            || false,
            |directory| {
                failed_path = directory.to_path_buf();
                prepare_fixture(directory)?;
                Err("copy failed".into())
            },
        );
        assert!(failed.is_err());
        assert!(!failed_path.exists());
        let ready = get_or_prepare(temp.path(), &key, || false, prepare_fixture).unwrap();
        let path = ready.directory.clone();
        drop(ready);
        fs::remove_file(path.join("engine/entrypoint.mjs")).unwrap();
        let repaired = get_or_prepare(temp.path(), &key, || false, prepare_fixture).unwrap();
        assert_ne!(repaired.directory, path);
        assert!(!path.exists(), "incomplete cache is not reused");
    }

    #[test]
    fn modified_caches_are_rebuilt_only_after_their_readers_release() {
        let temp = tempfile::tempdir().unwrap();
        let key = "a".repeat(64);
        let ready = get_or_prepare(temp.path(), &key, || false, prepare_fixture).unwrap();
        let path = ready.directory.clone();
        fs::write(path.join("engine/entrypoint.mjs"), "modified engine").unwrap();
        let valid = |directory: &Path| {
            Ok(
                fs::read_to_string(directory.join("engine/entrypoint.mjs")).unwrap()
                    == "export {};",
            )
        };
        let blocked = get_or_prepare_verified(
            temp.path(),
            &key,
            || false,
            |_| panic!("must not overwrite a live cache"),
            valid,
        );
        assert!(blocked.err().unwrap().contains("still in use"));
        assert!(path.is_dir());
        drop(ready);
        let repaired =
            get_or_prepare_verified(temp.path(), &key, || false, prepare_fixture, valid).unwrap();
        assert_ne!(repaired.directory, path);
        assert!(!path.exists());
    }

    #[test]
    fn shutdown_cancels_waiting_for_another_backends_preparation() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            mpsc,
        };
        let temp = tempfile::tempdir().unwrap();
        let _guard = lock_parent(temp.path(), &|| false).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = cancelled.clone();
        let parent = temp.path().to_path_buf();
        let (done, result) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            done.send(
                get_or_prepare(
                    &parent,
                    &"a".repeat(64),
                    || worker_cancelled.load(Ordering::SeqCst),
                    |_| panic!("cancelled preparation must not start"),
                )
                .err(),
            )
            .unwrap();
        });
        cancelled.store(true, Ordering::SeqCst);
        assert!(result
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap()
            .contains("shutting down"));
        worker.join().unwrap();
    }

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
