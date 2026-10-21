use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, OnceLock, Weak},
};

static HOST_REF_LOCKS: OnceLock<Mutex<std::collections::HashMap<PathBuf, Weak<Mutex<()>>>>> =
    OnceLock::new();
static HOST_INDEX_LOCKS: OnceLock<Mutex<std::collections::HashMap<PathBuf, Weak<Mutex<()>>>>> =
    OnceLock::new();

fn host_lock(
    locks: &'static OnceLock<Mutex<std::collections::HashMap<PathBuf, Weak<Mutex<()>>>>>,
    repository: &Path,
) -> Result<Arc<Mutex<()>>, String> {
    let key = PathBuf::from(crate::path_identity::path_key(repository));
    let mut locks = locks
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    locks.retain(|_, weak| weak.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

pub(crate) fn host_ref_lock(repository: &Path) -> Result<Arc<Mutex<()>>, String> {
    host_lock(&HOST_REF_LOCKS, repository)
}

/// Serializes mutations of the source shadow index independently from ref
/// imports. Node result imports only need the ref lock, so a large source
/// `git add` no longer blocks node completion.
pub(crate) fn host_index_lock(repository: &Path) -> Result<Arc<Mutex<()>>, String> {
    host_lock(&HOST_INDEX_LOCKS, repository)
}

// Metadata can temporarily move back into a slot for native conflict repair.
// Serialize host Git discovery with that move, including fan-out readers. This
// small reentrant lease lets preparation/Merger call host Git on the same thread.
#[derive(Default)]
struct SlotGitLock {
    owner: Mutex<(Option<std::thread::ThreadId>, usize)>,
    changed: std::sync::Condvar,
    views: std::sync::atomic::AtomicUsize,
}
struct SlotGitGuard(Arc<SlotGitLock>);
impl SlotGitGuard {
    fn acquire(path: &Path) -> Result<Self, String> {
        static LOCKS: OnceLock<Mutex<std::collections::HashMap<PathBuf, Weak<SlotGitLock>>>> = OnceLock::new();
        let key = PathBuf::from(crate::path_identity::path_key(path));
        let lock = {
            let mut locks = LOCKS.get_or_init(Default::default).lock().map_err(|e| e.to_string())?;
            locks.retain(|_, weak| weak.strong_count() > 0);
            if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) { lock } else {
                let lock = Arc::new(SlotGitLock::default());
                locks.insert(key, Arc::downgrade(&lock));
                lock
            }
        };
        let thread = std::thread::current().id();
        let mut owner = lock.owner.lock().map_err(|e| e.to_string())?;
        while owner.0.is_some_and(|current| current != thread) {
            owner = lock.changed.wait(owner).map_err(|e| e.to_string())?;
        }
        owner.0 = Some(thread);
        owner.1 += 1;
        drop(owner);
        Ok(Self(lock))
    }
}
impl Drop for SlotGitGuard {
    fn drop(&mut self) {
        if let Ok(mut owner) = self.0.owner.lock() {
            owner.1 -= 1;
            if owner.1 == 0 { owner.0 = None; self.0.changed.notify_all(); }
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub head: String,
    pub clean: bool,
    #[serde(default)]
    pub is_shadow: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickResult {
    pub supported: bool,
    pub repository: Option<RepositoryInfo>,
    pub cancelled: bool,
}

pub fn data_root() -> PathBuf {
    let path = crate::native::environment_path("GRAPHER_DATA_DIR")
        .unwrap_or_else(|| {
            // Unit tests must never write shadow/workspace data into the
            // checkout; integration fixtures call `ensure_test_data_root()`
            // explicitly because this library is compiled without `cfg(test)`.
            #[cfg(test)]
            {
                crate::ensure_test_data_root()
            }
            #[cfg(not(test))]
            {
                crate::native::installation_root().join(".grapher")
            }
        });
    let path = if path.is_relative() {
        std::env::current_dir()
            .map(|cwd| cwd.join(&path))
            .unwrap_or(path)
    } else {
        path
    };
    // The server canonicalizes this directory after creating it. Other
    // callers (notably the execution sandbox) must resolve the same root,
    // including configured relative paths and platform aliases.
    path.canonicalize().unwrap_or(path)
}

/// Large disposable workspace/engine caches must not live beside the checkout.
/// Runtime records stay at data_root() so existing conversations remain visible.
fn default_cache_root(platform: &str, env: impl Fn(&str) -> Option<PathBuf>) -> PathBuf {
    let home = if platform == "windows" {
        env("USERPROFILE").or_else(|| env("HOME"))
    } else {
        env("HOME").or_else(|| env("USERPROFILE"))
    }
    .unwrap_or_else(std::env::temp_dir);
    match platform {
        "windows" => env("LOCALAPPDATA")
            .unwrap_or_else(|| home.join("AppData/Local"))
            .join("Grapher"),
        "macos" => home.join("Library/Caches/Grapher"),
        _ => env("XDG_CACHE_HOME")
            .unwrap_or_else(|| home.join(".cache"))
            .join("grapher"),
    }
}

fn absolute_path(path: PathBuf) -> PathBuf {
    if path.is_relative() {
        std::env::current_dir()
            .map(|cwd| cwd.join(&path))
            .unwrap_or(path)
    } else {
        path
    }
}

fn absolute_cache_path(path: PathBuf) -> PathBuf {
    let path = absolute_path(path);
    path.canonicalize().unwrap_or(path)
}

/// Host-user resource locks must not follow a per-backend cache override.
pub(crate) fn host_cache_root() -> PathBuf {
    absolute_cache_path(default_cache_root(std::env::consts::OS, |name| {
        std::env::var_os(name).map(PathBuf::from)
    }))
}

pub fn cache_root() -> PathBuf {
    absolute_cache_path(
        crate::native::environment_path("GRAPHER_CACHE_DIR")
            .unwrap_or_else(|| {
                default_cache_root(std::env::consts::OS, |name| {
                    std::env::var_os(name).map(PathBuf::from)
                })
            }),
    )
}

pub(crate) fn native_runtime_parent() -> PathBuf {
    // Keep the leaf spelling so storage can reject a linked/redirected parent.
    absolute_path(
        crate::native::environment_path("GRAPHER_NATIVE_RUNTIME_PARENT")
            .unwrap_or_else(|| cache_root().join("workspaces/.grapher-workspaces")),
    )
}

pub(crate) fn workspaces_parent(data: &Path) -> PathBuf {
    absolute_cache_path(
        crate::native::environment_path("GRAPHER_WORKSPACE_PARENT")
            .unwrap_or_else(|| {
                // Fixture/unit-test checkouts are disposable with their test data. Real
                // execution must stay outside both source and protected session data.
                if cfg!(any(test, feature = "fixture")) {
                    data.join("workspaces")
                } else {
                    cache_root().join("workspaces")
                }
            }),
    )
}

#[cfg(test)]
mod cache_path_tests {
    use super::*;

    #[test]
    fn windows_cache_defaults_to_local_appdata_not_desktop() {
        let profile = PathBuf::from("C:/Users/test");
        let local = PathBuf::from("D:/LocalAppData");
        let root = default_cache_root("windows", |name| match name {
            "USERPROFILE" => Some(profile.clone()),
            "LOCALAPPDATA" => Some(local.clone()),
            _ => None,
        });
        assert_eq!(root, local.join("Grapher"));
        assert_eq!(
            default_cache_root("windows", |name| (name == "USERPROFILE")
                .then(|| profile.clone())),
            profile.join("AppData/Local/Grapher")
        );
    }

    #[test]
    fn unix_caches_use_os_conventions() {
        let home = PathBuf::from("/users/test");
        let xdg = PathBuf::from("/custom/cache");
        let env = |name: &str| match name {
            "HOME" => Some(home.clone()),
            "XDG_CACHE_HOME" => Some(xdg.clone()),
            _ => None,
        };
        assert_eq!(
            default_cache_root("macos", env),
            home.join("Library/Caches/Grapher")
        );
        assert_eq!(default_cache_root("linux", env), xdg.join("grapher"));
        assert_eq!(
            default_cache_root("linux", |name| (name == "HOME").then(|| home.clone())),
            home.join(".cache/grapher")
        );
    }
}

#[cfg(test)]
mod workspace_guard_tests {
    use super::*;

    #[test]
    fn desktop_is_not_a_valid_workspace_root() {
        let home = PathBuf::from("C:/Users/test");
        let env = |name: &str| match name {
            "USERPROFILE" => Some(home.clone()),
            "OneDrive" => Some(home.join("OneDrive")),
            _ => None,
        };
        assert!(is_desktop_workspace(&home.join("Desktop"), "windows", env));
        assert!(is_desktop_workspace(
            &home.join("OneDrive").join("Desktop"),
            "windows",
            env
        ));
        assert!(is_desktop_workspace(
            &PathBuf::from(r"\\?\c:\users\test\desktop"),
            "windows",
            env
        ));
        assert!(!is_desktop_workspace(&home.join("DesktopX"), "windows", env));
        assert!(!is_desktop_workspace(
            &home.join("Desktop").join("project"),
            "windows",
            env
        ));
        assert!(is_desktop_workspace(
            &PathBuf::from("/home/test/Desktop"),
            "linux",
            |name| (name == "HOME").then(|| PathBuf::from("/home/test"))
        ));
        assert!(!is_desktop_workspace(
            &PathBuf::from("/home/test/DesktopX"),
            "linux",
            |name| (name == "HOME").then(|| PathBuf::from("/home/test"))
        ));
        // Default macOS volumes are case-insensitive; canonicalize() preserves
        // the caller's spelling, so the desktop guard must fold case itself.
        assert!(is_desktop_workspace(
            &PathBuf::from("/Users/test/desktop"),
            "macos",
            |name| (name == "HOME").then(|| PathBuf::from("/Users/test"))
        ));
        assert!(!is_desktop_workspace(
            &PathBuf::from("/Users/test/Desktop/Project"),
            "macos",
            |name| (name == "HOME").then(|| PathBuf::from("/Users/test"))
        ));
    }

    #[test]
    fn workspace_size_limit_rejects_oversized_directories() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("my-project");
        fs::create_dir_all(&project).unwrap();

        // Write small files: total 200 bytes
        fs::write(project.join("a.txt"), vec![b'a'; 100]).unwrap();
        fs::write(project.join("b.txt"), vec![b'b'; 100]).unwrap();

        // Under limit (1000 bytes) succeeds
        assert!(check_workspace_size(&project, 1000).is_ok());

        // Over limit (150 bytes) fails with actionable message
        let err = check_workspace_size(&project, 150).unwrap_err();
        assert!(err.contains("10GB"));
        assert!(err.contains("数据集"));

        // Files in .git and .grapher* are excluded from project size
        let git_dir = project.join(".git");
        fs::create_dir_all(&git_dir).unwrap();
        fs::write(git_dir.join("large_pack"), vec![b'x'; 500]).unwrap();

        let grapher_dir = project.join(".grapher-worktrees");
        fs::create_dir_all(&grapher_dir).unwrap();
        fs::write(grapher_dir.join("worktree_cache"), vec![b'y'; 500]).unwrap();

        // Still passes with 200 bytes of actual project files
        assert!(check_workspace_size(&project, 250).is_ok());
    }
}

/// Desktop folders are not valid project workspaces. Runtime collection is
/// forced and ignores `.gitignore`, so a desktop binding would drag unrelated
/// personal data into shadow Git history and stall every run. This is a
/// product guard, not a sandbox boundary.
fn is_desktop_workspace(
    candidate: &Path,
    platform: &str,
    env: impl Fn(&str) -> Option<PathBuf>,
) -> bool {
    let home = if platform == "windows" {
        env("USERPROFILE").or_else(|| env("HOME"))
    } else {
        env("HOME").or_else(|| env("USERPROFILE"))
    };
    let Some(home) = home else { return false };
    let mut roots = vec![home.join("Desktop")];
    if platform == "windows" {
        // Redirected desktops live under the OneDrive roots, not the profile.
        for key in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
            if let Some(root) = env(key) {
                roots.push(root.join("Desktop"));
            }
        }
    }
    let normalize = |path: &Path| {
        let text = path.to_string_lossy();
        let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
        let text = text.replace('\\', "/");
        let text = text.trim_end_matches('/').to_string();
        // Windows filesystems and default macOS APFS volumes are
        // case-insensitive, while canonicalize() keeps the input spelling.
        if platform == "windows" || platform == "macos" {
            text.to_lowercase()
        } else {
            text
        }
    };
    let target = normalize(candidate);
    roots.iter().any(|root| normalize(root) == target)
}

pub const MAX_WORKSPACE_BYTES: u64 = 10 * 1024 * 1024 * 1024; // 10 GB

pub fn check_workspace_size(root: &Path, max_bytes: u64) -> Result<(), String> {
    let mut total_bytes: u64 = 0;
    let mut stack = vec![root.to_path_buf()];

    while let Some(current_dir) = stack.pop() {
        let entries = match fs::read_dir(&current_dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            // Never follow symlinks or Windows junctions
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                // Exclude .git and internal .grapher* directories.
                if crate::path_identity::is_runtime_metadata_name(std::ffi::OsStr::new(file_name)) {
                    continue;
                }
                stack.push(path);
            } else if metadata.is_file() {
                total_bytes = total_bytes.saturating_add(metadata.len());
                if total_bytes > max_bytes {
                    return Err(
                        "工作区体积超过 10GB 限制。请将大型文件（例如数据集、模型权重或构建缓存）移至目录外，或进入更里层的子文件夹建立工作区。"
                            .to_string(),
                    );
                }
            }
        }
    }
    Ok(())
}

fn cached_check_workspace_size(canonical_root: &Path) -> Result<(), String> {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    static CACHE: Mutex<Option<HashMap<PathBuf, (Instant, Result<(), String>)>>> = Mutex::new(None);

    let now = Instant::now();
    let ttl = Duration::from_secs(30);

    {
        if let Ok(mut lock) = CACHE.lock() {
            let map = lock.get_or_insert_with(HashMap::new);
            if let Some((timestamp, cached_res)) = map.get(canonical_root) {
                if now.duration_since(*timestamp) < ttl {
                    return cached_res.clone();
                }
            }
        }
    }

    let result = check_workspace_size(canonical_root, MAX_WORKSPACE_BYTES);

    if let Ok(mut lock) = CACHE.lock() {
        let map = lock.get_or_insert_with(HashMap::new);
        if map.len() > 50 {
            map.retain(|_, (t, _)| now.duration_since(*t) < ttl);
        }
        map.insert(canonical_root.to_path_buf(), (now, result.clone()));
    }

    result
}

fn prohibited_workspace_reason(candidate: &Path) -> Option<String> {
    let probe = candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.to_path_buf());
    if is_desktop_workspace(&probe, std::env::consts::OS, |name| {
        std::env::var_os(name).map(PathBuf::from)
    }) {
        return Some(
            "不能选择系统桌面作为项目工作区：Grapher 会强制把工作区内所有文件收录进 Git 快照（无视 .gitignore），\
             而桌面通常包含大量无关个人数据，会让运行长时间卡住。请选择具体的项目或代码仓库目录。"
                .to_string(),
        );
    }
    if let Err(reason) = cached_check_workspace_size(&probe) {
        return Some(reason);
    }
    None
}

/// Host-only metadata for a physical Graph slot. No .git marker is left in
/// the model's cwd, so ordinary node/Planner Git cannot discover runtime history.
fn private_slot_layout(path: &Path) -> bool {
    path.parent()
        .and_then(Path::parent)
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == ".grapher-worktrees" || name == ".grapher-workspaces")
}

pub(crate) fn private_git_dir(path: &Path) -> Option<PathBuf> {
    if !private_slot_layout(path) { return None; }
    let run = path.parent()?;
    let name = path.file_name()?.to_str()?;
    let metadata = run.join(".grapher-git").join(format!("{name}.git"));
    fs::symlink_metadata(&metadata).ok().filter(|m| m.is_dir() && !m.file_type().is_symlink())?;
    Some(metadata)
}

pub(crate) fn has_private_git(path: &Path) -> bool {
    let Ok(_lease) = SlotGitGuard::acquire(path) else { return false; };
    path.join(".git").is_dir() || private_git_dir(path).is_some()
}

pub(crate) fn hide_private_git(path: &Path) -> Result<(), String> {
    let lease = SlotGitGuard::acquire(path)?;
    if lease.0.views.load(std::sync::atomic::Ordering::SeqCst) > 0 { return Ok(()); }
    let Some(run) = path.parent() else { return Ok(()); };
    if !run.parent().and_then(Path::file_name).is_some_and(|name| name == ".grapher-worktrees" || name == ".grapher-workspaces") {
        return Ok(());
    }
    let visible = path.join(".git");
    if visible.is_dir() {
        let parent = run.join(".grapher-git");
        if fs::symlink_metadata(&parent).is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_dir()) {
            return Err("Refusing linked Graph Git metadata directory".into());
        }
        fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        let metadata = parent.join(format!("{}.git", path.file_name().ok_or("Invalid slot")?.to_string_lossy()));
        if metadata.exists() { return Err("Graph slot has conflicting Git metadata".into()); }
        fs::rename(visible, metadata).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Remove the host-only metadata belonging to a reclaimed slot. The slot
/// directory itself is removed by the caller; this keeps its object database
/// from accumulating after the physical workspace is released.
pub(crate) fn remove_private_git(path: &Path) -> Result<(), String> {
    let Some(run) = path.parent() else { return Ok(()) };
    let Some(root) = run.parent() else { return Ok(()) };
    if !root.file_name().and_then(|name| name.to_str())
        .is_some_and(|name| name == ".grapher-worktrees" || name == ".grapher-workspaces")
    {
        return Ok(());
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else { return Ok(()) };
    let metadata_root = run.join(".grapher-git");
    let metadata = metadata_root.join(format!("{name}.git"));
    match fs::symlink_metadata(&metadata) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(format!("Refusing linked Graph Git metadata: {}", metadata.display()));
        }
        Ok(meta) if meta.is_dir() => {
            fs::remove_dir_all(&metadata).map_err(|error| error.to_string())?;
        }
        Ok(_) => {
            return Err(format!("Graph Git metadata is not a directory: {}", metadata.display()));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    }
    // Best effort: leave no empty metadata directory behind.
    if fs::read_dir(&metadata_root).ok().is_some_and(|mut entries| entries.next().is_none()) {
        let _ = fs::remove_dir(&metadata_root);
    }
    Ok(())
}

/// Reclaim metadata left beside a Run root when its slot directory is already
/// gone. This is a migration and crash-recovery sweep, not a live-slot sweep.
pub(crate) fn reclaim_orphan_git_metadata(run_root: &Path) -> Result<(), String> {
    let metadata_root = run_root.join(".grapher-git");
    let Ok(meta) = fs::symlink_metadata(&metadata_root) else { return Ok(()) };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(format!("Refusing linked Graph Git metadata directory: {}", metadata_root.display()));
    }
    let mut remaining = false;
    for entry in fs::read_dir(&metadata_root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(slot) = name.strip_suffix(".git") else { remaining = true; continue; };
        if slot.is_empty() || slot.contains('/') || slot.contains('\\') {
            remaining = true;
            continue;
        }
        if run_root.join(slot).exists() {
            remaining = true;
            continue;
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(format!("Refusing linked Graph Git metadata: {}", path.display()));
        }
        fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
    }
    if !remaining {
        let _ = fs::remove_dir(&metadata_root);
    }
    Ok(())
}


/// Remove refs owned by a deleted Run and reclaim objects that are no longer
/// reachable from any remaining Grapher ref. Shared source databases keep
/// their other Run refs, source snapshots and published results intact.
pub(crate) fn prune_shadow_run_refs(shadow: &Path, run_id: &str, protected: &std::collections::BTreeSet<String>, reclaim_objects: bool) -> Result<(), String> {
    uuid::Uuid::parse_str(run_id).map_err(|_| "Invalid Run ID for shadow cleanup")?;
    let metadata = match fs::symlink_metadata(shadow) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("Refusing linked or non-directory shadow repository: {}", shadow.display()));
    }
    let shadow_text = shadow.to_str().ok_or("Invalid shadow path")?;
    let prefix = format!("refs/grapher/runs/{run_id}/");
    let run_refs = git(shadow, &["--git-dir", shadow_text, "for-each-ref", "--format=%(refname)", &prefix])?;
    let mut transaction = String::new();
    for reference in run_refs.lines().filter(|line| !line.is_empty()) {
        transaction.push_str(&format!("delete {reference}\n"));
    }
    let mut changed = !transaction.is_empty();
    if changed {
        git_bytes(shadow, &["--git-dir", shadow_text, "update-ref", "--stdin"], None, Some(transaction.as_bytes()))?;
    }

    // Node result commits are also pinned under refs/grapher/heads/<commit>.
    // Keep a head only while a non-head ref (another Run, a source input or a
    // published result) still points at the same object.
    let refs = git(shadow, &["--git-dir", shadow_text, "for-each-ref", "--format=%(refname) %(objectname)"])?;
    let mut referenced = std::collections::BTreeSet::new();
    let mut heads = Vec::new();
    for line in refs.lines() {
        let Some((reference, object)) = line.split_once(' ') else { continue };
        if reference.starts_with("refs/grapher/heads/") {
            heads.push((reference.to_string(), object.to_string()));
        } else {
            referenced.insert(object.to_string());
        }
    }
    let mut head_transaction = String::new();
    for (reference, object) in heads {
        if !referenced.contains(&object) && !protected.contains(&object) {
            head_transaction.push_str(&format!("delete {reference}\n"));
        }
    }
    if !head_transaction.is_empty() {
        changed = true;
        git_bytes(shadow, &["--git-dir", shadow_text, "update-ref", "--stdin"], None, Some(head_transaction.as_bytes()))?;
    }
    if changed && reclaim_objects {
        // Refuse to prune when another live Run references a commit that is no
        // longer pinned by any ref; a missing pin is recovery evidence, not a
        // reason to delete it.
        let remaining = git(shadow, &["--git-dir", shadow_text, "for-each-ref", "--format=%(objectname)"])?;
        let remaining: std::collections::BTreeSet<&str> = remaining.lines().collect();
        if protected.iter().all(|object| remaining.contains(object.as_str())) {
            // Reflogs can keep otherwise unreachable objects alive; expire them
            // before pruning. The host ref lock serializes this with Grapher Git.
            git(shadow, &["--git-dir", shadow_text, "reflog", "expire", "--expire=now", "--all"])?;
            git(shadow, &["--git-dir", shadow_text, "gc", "--prune=now", "--quiet"])?;
        }
    }
    Ok(())
}
/// Only conflict repair gets a discoverable Git view, and only for that turn.
pub(crate) struct MergerGitView { path: PathBuf, lock: Arc<SlotGitLock> }
impl MergerGitView {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        let lease = SlotGitGuard::acquire(path)?;
        if let Some(metadata) = private_git_dir(path) {
            fs::rename(metadata, path.join(".git")).map_err(|e| e.to_string())?;
        }
        lease.0.views.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(Self { path: path.to_path_buf(), lock: lease.0.clone() })
    }
}
impl Drop for MergerGitView {
    fn drop(&mut self) {
        // Never hold a relocation lease while invoking the model or emitting
        // runtime events: another actor may hold Runtime's mutex while reading
        // Git. Only discovery and the short rename itself are serialized.
        if let Ok(_lease) = SlotGitGuard::acquire(&self.path) {
            self.lock.views.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            if let Err(error) = hide_private_git(&self.path) { eprintln!("Cannot hide Graph Git metadata: {error}"); }
        }
    }
}

pub fn is_standard_git(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    if path.join(".git").exists() {
        return true;
    }
    if let Ok(top) = git(path, &["rev-parse", "--show-toplevel"]) {
        let top_buf = PathBuf::from(top);
        if let (Ok(c1), Ok(c2)) = (path.canonicalize(), top_buf.canonicalize()) {
            if crate::path_identity::same_path(&c1, &c2) {
                return true;
            }
        }
    }
    false
}

fn canonical_workspace_path(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|error| format!("Cannot resolve workspace path {}: {error}", path.display()))
}

pub(crate) fn normalize_workspace_display_path(path: &Path) -> String {
    crate::native::host_path(path).to_string_lossy().to_string()
}

pub fn shadow_repo_dir(target: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_workspace_path(target)?;
    let mut hasher = DefaultHasher::new();
    // Keep the historical hash input stable: changing it would orphan
    // existing shadow repositories and their snapshots.
    canonical.to_string_lossy().hash(&mut hasher);
    let hash = hasher.finish();
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".into());
    let safe_name: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    Ok(data_root()
        .join("shadow_repos")
        .join(format!("{}_{:016x}.git", safe_name, hash)))
}

fn checked_shadow_directory(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "Refusing shadow repository symlink {}",
            path.display()
        )),
        Ok(metadata) if !metadata.is_dir() => Err(format!(
            "Shadow repository path is not a directory: {}",
            path.display()
        )),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod shadow_safety_tests {
    use super::*;

    #[test]
    fn shadow_directory_validation_rejects_links_and_non_directories() {
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside");
        let linked = temp.path().join("linked-shadow.git");
        fs::create_dir(&outside).unwrap();
        crate::path_safety::directory_link(&outside, &linked);
        assert!(checked_shadow_directory(&linked)
            .unwrap_err()
            .contains("symlink"));
        let file = temp.path().join("file");
        fs::write(&file, "not a directory").unwrap();
        assert!(checked_shadow_directory(&file)
            .unwrap_err()
            .contains("not a directory"));
        let real = temp.path().join("real-shadow.git");
        fs::create_dir(&real).unwrap();
        assert!(checked_shadow_directory(&real).unwrap());
    }
}

const MISSING_SHADOW_ERROR: &str = "临时 Git 快照不存在或已回收：快照在首次派发节点时建立，发布成功后删除。请开启新对话后重试。";

const STALE_SHADOW_ERROR: &str = "临时 Git 快照不存在：图运行的快照在首次派发节点时建立，并在发布成功后回收。请开启新对话后重试。";

/// Return the existing host-only source database (Git or plain-directory binding).
/// Never creates, initializes, follows a symlink, or invokes Git.
pub fn shadow_repo_if_exists(target: &Path) -> Result<Option<PathBuf>, String> {
    let shadow = shadow_repo_dir(target)?;
    match checked_shadow_directory(&shadow)? {
        true => Ok(Some(shadow)),
        false => Ok(None),
    }
}

fn missing_shadow_error(target: &Path) -> String {
    format!("{STALE_SHADOW_ERROR}（工作区：{}）", target.display())
}

/// Metadata-only initialization of the external shadow repository. Creates the
/// Git directory when needed but never stages or commits, so a caller that
/// needs a usable `HEAD` must do so explicitly.
fn copy_shadow_git_settings(source: &Path, shadow: &Path) -> Result<(), String> {
    let shadow_text = shadow.to_str().ok_or("Invalid shadow path")?;
    // Core conversion settings decide which bytes enter the snapshot. Copy the
    // effective local values so staging in the private repository matches the
    // user's checkout (notably autocrlf/eol/filemode differences).
    for key in ["core.autocrlf", "core.eol", "core.filemode", "core.symlinks", "core.ignorecase", "core.safecrlf"] {
        if let Ok(value) = git(source, &["config", "--local", "--get", key]) {
            git(source, &["--git-dir", shadow_text, "config", key, &value])?;
        }
    }
    // Local filter drivers are needed when .gitattributes refers to a filter
    // that is not defined in the global/system config. Only filter.* keys are
    // copied; remotes, credentials and other local settings stay out.
    if let Ok(entries) = git(source, &["config", "--local", "--null", "--get-regexp", "^filter\\."]) {
        for entry in entries.split('\0').filter(|entry| !entry.is_empty()) {
            let Some((key, value)) = entry.split_once('\n') else { continue };
            if !key.starts_with("filter.") { continue; }
            git(source, &["--git-dir", shadow_text, "config", "--add", key, value])?;
        }
    }
    // .git/info/attributes is local (not a project file) and can alter text
    // conversion or filters. Mirror it into the private repository.
    if let Ok(info) = git(source, &["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"]) {
        let info = PathBuf::from(info);
        if info.is_file() {
            let destination = shadow.join("info");
            fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
            fs::copy(&info, destination.join("attributes")).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn ensure_shadow_metadata(target: &Path) -> Result<PathBuf, String> {
    let canonical_target = canonical_workspace_path(target)?;
    if let Some(reason) = prohibited_workspace_reason(&canonical_target) {
        return Err(reason);
    }
    let shadow_dir = shadow_repo_dir(&canonical_target)?;
    let shadow_parent = data_root().join("shadow_repos");
    if !checked_shadow_directory(&shadow_parent)? {
        fs::create_dir_all(&shadow_parent).map_err(|e| e.to_string())?;
        checked_shadow_directory(&shadow_parent)?;
    }
    if !checked_shadow_directory(&shadow_dir)? {
        fs::create_dir_all(&shadow_dir).map_err(|e| e.to_string())?;
        checked_shadow_directory(&shadow_dir)?;
        let git_dir_str = shadow_dir.to_str().ok_or("Invalid shadow path")?;
        let work_tree_str = canonical_target.to_str().ok_or("Invalid target path")?;
        let format = if is_standard_git(&canonical_target) {
            git(&canonical_target, &["rev-parse", "--show-object-format=storage"])?
        } else { "sha1".into() };
        git(&canonical_target, &["--git-dir", git_dir_str, "--work-tree", work_tree_str,
            "init", &format!("--object-format={format}")])?;
        if is_standard_git(&canonical_target) {
            copy_shadow_git_settings(&canonical_target, &shadow_dir)?;
        }
    }
    if !checked_shadow_directory(&shadow_dir)? {
        return Err(format!(
            "Shadow repository is missing: {}",
            shadow_dir.display()
        ));
    }
    Ok(shadow_dir)
}

/// Initialize the host-only source database without collecting live files.
/// The source is read-only; even the first node import must never write a ref
/// or an internal commit into the user's .git.
fn ensure_graph_metadata(target: &Path) -> Result<PathBuf, String> {
    let shadow = ensure_shadow_metadata(target)?;
    if is_standard_git(target) {
        if let Ok(head) = git(target, &["rev-parse", "HEAD"]) {
            if repository_git(target, &["cat-file", "-e", &format!("{head}^{{commit}}")]).is_err() {
                let url = git_file_url(target)?;
                repository_git(target, &["fetch", "-q", "--no-tags", "--no-write-fetch-head", "--no-auto-gc", &url, &head])?;
            }
        }
    }
    Ok(shadow)
}

fn bridge_plain_snapshot(target: &Path) -> Result<String, String> {
    let head = repository_git(target, &["rev-parse", "HEAD"])?;
    if let (Ok(published), Ok(composed)) = (
        repository_git(target, &["rev-parse", "--verify", "refs/grapher/published/source"]),
        repository_git(target, &["rev-parse", "--verify", "refs/grapher/published/composed"]),
    ) {
        if repository_git(target, &["merge-base", "--is-ancestor", &published, &head]).is_ok()
            && repository_git(target, &["merge-base", "--is-ancestor", &composed, &head]).is_err()
        {
            let tree = repository_git(target, &["rev-parse", &format!("{head}^{{tree}}")])?;
            let bridge = repository_git(target, &["commit-tree", &tree, "-p", &head, "-p", &composed, "-m", SNAPSHOT_COMMIT_MESSAGE])?;
            repository_git(target, &["update-ref", "HEAD", &bridge])?;
            return Ok(bridge);
        }
    }
    Ok(head)
}

/// Materialize the external shadow repository for a plain directory: create
/// the metadata when needed, then force-collect the current source files into
/// one commit so a usable `HEAD` exists. This is the only lazy creation point.
pub fn materialize_shadow_repo(target: &Path, exclusions: &[String]) -> Result<String, String> {
    let canonical = canonical_workspace_path(target)?;
    let index_lock = host_index_lock(&canonical)?;
    let _index_guard = index_lock.lock().map_err(|e| e.to_string())?;
    let shadow = {
        let lock = host_ref_lock(&canonical)?;
        let _guard = lock.lock().map_err(|e| e.to_string())?;
        ensure_shadow_metadata(&canonical)?
    };
    let git_dir = shadow.to_str().ok_or("Invalid shadow path")?;
    let work_tree = canonical.to_str().ok_or("Invalid target path")?;
    let head_exists = git(
        &canonical,
        &["--git-dir", git_dir, "rev-parse", "-q", "--verify", "HEAD"],
    )
    .is_ok();
    if !head_exists {
        // A crashed first collection can leave a stale lock behind. Only a
        // missing `HEAD` justifies removing it; a valid repository keeps its lock.
        let lock = shadow.join("index.lock");
        if lock.exists() {
            fs::remove_file(&lock).map_err(|error| error.to_string())?;
        }
    }
    stage_scoped(&canonical, exclusions)?;
    let lock = host_ref_lock(&canonical)?;
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    let staged = git(
        &canonical,
        &[
            "--git-dir",
            git_dir,
            "--work-tree",
            work_tree,
            "diff",
            "--cached",
            "--name-only",
        ],
    )?;
    let mut commit = vec![
        "--git-dir",
        git_dir,
        "--work-tree",
        work_tree,
        "commit",
    ];
    if staged.trim().is_empty() {
        if head_exists {
            // Nothing changed and a usable HEAD already exists; reuse it instead
            // of adding a redundant empty commit (idempotent re-materialization
            // for crash recovery and shared sources).
            return bridge_plain_snapshot(&canonical);
        }
        // First collection of an empty directory: still create a HEAD.
        commit.push("--allow-empty");
    }
    commit.extend(["-m", "Grapher source snapshot"]);
    git(&canonical, &commit)?;
    bridge_plain_snapshot(&canonical)
}

pub fn remove_shadow_repo(target: &Path) -> Result<(), String> {
    let canonical = canonical_workspace_path(target)?;
    if is_standard_git(&canonical) {
        return Ok(());
    }
    let shadow = shadow_repo_dir(&canonical)?;
    if !checked_shadow_directory(&shadow)? {
        return Ok(());
    }
    if let Some(metadata) = fs::symlink_metadata(&shadow).ok() {
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Refusing to remove shadow repository symlink {}",
                shadow.display()
            ));
        }
    }
    if shadow.is_dir() {
        fs::remove_dir_all(shadow).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Compatibility alias for metadata-only initialization. It no longer stages
/// or commits; callers that need a usable `HEAD` must call
/// [`materialize_shadow_repo`] explicitly.
pub fn ensure_shadow_repo(target: &Path) -> Result<PathBuf, String> {
    ensure_shadow_metadata(target)
}

pub fn pick_folder() -> Result<Option<PathBuf>, String> {
    #[cfg(target_os = "macos")]
    {
        let script = r#"
            try
                tell application (path to frontmost application as text)
                    set chosenFolder to choose folder with prompt "请选择本地项目文件夹"
                    return POSIX path of chosenFolder
                end tell
            on error number -128
                return ""
            end try
        "#;
        let mut output = Command::new("osascript").arg("-e").arg(script).output();

        if !matches!(&output, Ok(out) if out.status.success()) {
            let fallback_script = r#"
                try
                    set chosenFolder to choose folder with prompt "请选择本地项目文件夹"
                    return POSIX path of chosenFolder
                on error number -128
                    return ""
                end try
            "#;
            output = Command::new("osascript")
                .arg("-e")
                .arg(fallback_script)
                .output();
        }

        match output {
            Ok(out) if out.status.success() => {
                let path_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !path_str.is_empty() {
                    Ok(Some(PathBuf::from(path_str)))
                } else {
                    Ok(None)
                }
            }
            Ok(out) => Err(format!(
                "macOS folder picker failed with exit status: {}",
                out.status
            )),
            Err(err) => Err(format!("macOS folder picker is unavailable: {err}")),
        }
    }
    #[cfg(target_os = "windows")]
    {
        // The script is constant: the selected path is returned through stdout,
        // never interpolated into PowerShell source.
        let script = r#"Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [System.Windows.Forms.Application]::EnableVisualStyles(); $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Select a project folder'; $dialog.ShowNewFolderButton = $false; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($dialog.SelectedPath) }"#;
        let output = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ])
            .output()
            .map_err(|error| format!("Windows folder picker is unavailable: {error}"))?;
        if !output.status.success() {
            return Err(
                "Windows folder picker failed; use the absolute path prompt instead".into(),
            );
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok((!path.is_empty()).then(|| PathBuf::from(path)))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(None)
    }
}

pub fn pick_repository() -> Result<PickResult, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let folder = match pick_folder() {
            Ok(Some(folder)) => folder,
            Ok(None) => {
                return Ok(PickResult {
                    supported: true,
                    repository: None,
                    cancelled: true,
                });
            }
            Err(err) => {
                eprintln!("Native folder picker unavailable: {err}");
                return Ok(PickResult {
                    supported: false,
                    repository: None,
                    cancelled: false,
                });
            }
        };

        let info = detect(Some(&folder))?;
        if let Some(info) = info {
            Ok(PickResult {
                supported: true,
                repository: Some(info),
                cancelled: false,
            })
        } else {
            Err(format!(
                "所选目录「{}」无法初始化为有效工作区。",
                folder.display()
            ))
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(PickResult {
            supported: false,
            repository: None,
            cancelled: false,
        })
    }
}

pub fn detect(target: Option<&Path>) -> Result<Option<RepositoryInfo>, String> {
    let candidate = match target {
        Some(path) => {
            if !path.exists() {
                return Ok(None);
            }
            path.to_path_buf()
        }
        None => match std::env::current_dir() {
            Ok(dir) => dir,
            Err(_) => return Ok(None),
        },
    };
    if let Some(reason) = prohibited_workspace_reason(&candidate) {
        return Err(reason);
    }

    if is_standard_git(&candidate) {
        let top_level = match git(&candidate, &["rev-parse", "--show-toplevel"]) {
            Ok(top) => PathBuf::from(top),
            Err(_) => return Ok(None),
        };
        let path_str = normalize_workspace_display_path(&top_level);
        let name = top_level
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path_str.clone());
        let branch = git(&top_level, &["rev-parse", "--abbrev-ref", "HEAD"])
            .unwrap_or_else(|_| "HEAD".into());
        let head = git(&top_level, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
        // 避免在添加/检测工作区时全量递归扫描大仓库的 untracked 状态导致 CPU 与 I/O 过载；
        // 前端仅消费分支与提交元信息，初始 clean 状态默认为 true。
        let clean = true;

        Ok(Some(RepositoryInfo {
            path: path_str,
            name,
            branch,
            head,
            clean,
            is_shadow: false,
        }))
    } else if candidate.is_dir() {
        // A pure filesystem report: never create, read or delete shadow Git
        // metadata here. The snapshot is materialized lazily on first dispatch.
        let canonical = canonical_workspace_path(&candidate)?;
        let path_str = normalize_workspace_display_path(&canonical);
        let name = candidate
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path_str.clone());

        Ok(Some(RepositoryInfo {
            path: path_str,
            name,
            branch: "shadow".into(),
            head: String::new(),
            clean: true,
            is_shadow: true,
        }))
    } else {
        Ok(None)
    }
}

// Read-only hot paths use libgit2 rather than spawning Git for every node
// state check. Leave mutations and uncommon porcelain states to Git CLI.
fn git_read(cwd: &Path, args: &[&str]) -> Option<Result<String, String>> {
    let supported = matches!(
        args,
        ["rev-parse", "HEAD"]
            | ["rev-parse", "--verify", "HEAD"]
            | ["status", "--porcelain"]
            | ["diff", "--name-only", "--diff-filter=U"]
            | ["merge-base", "--is-ancestor", _, _]
    ) || matches!(args, ["rev-parse", spec] if spec.starts_with("refs/grapher/"));
    if !supported {
        return None;
    }
    let repo = git2::Repository::open(cwd).ok()?;
    // Git status/diff invoked from a subdirectory are scoped to that path;
    // libgit2 reports repository-wide results unless a pathspec is supplied.
    if matches!(
        args,
        ["status", "--porcelain"] | ["diff", "--name-only", "--diff-filter=U"]
    ) && !repo.workdir().and_then(|dir| dir.canonicalize().ok())
        .is_some_and(|workdir| crate::path_identity::same_path(&workdir, &cwd))
    {
        return None;
    }
    if args[0] == "rev-parse" {
        let (verify, spec) = match args {
            ["rev-parse", "HEAD"] | ["rev-parse", "--verify", "HEAD"] => (true, "HEAD"),
            ["rev-parse", spec] if spec.starts_with("refs/grapher/") => (true, *spec),
            _ => (false, ""),
        };
        if verify {
            return Some(
                repo.revparse_single(spec)
                    .map(|object| object.id().to_string())
                    .map_err(|e| e.to_string()),
            );
        }
    }
    if let ["merge-base", "--is-ancestor", ancestor, descendant] = args {
        let result = (|| -> Result<String, String> {
            let ancestor = repo
                .revparse_single(ancestor)
                .map_err(|e| e.to_string())?
                .id();
            let descendant = repo
                .revparse_single(descendant)
                .map_err(|e| e.to_string())?
                .id();
            let contained = ancestor == descendant
                || repo
                    .graph_descendant_of(descendant, ancestor)
                    .map_err(|e| e.to_string())?;
            if contained {
                Ok(String::new())
            } else {
                Err("Not an ancestor".into())
            }
        })();
        return Some(result);
    }
    if args == ["status", "--porcelain"] {
        let result = (|| -> Result<String, String> {
            let mut options = git2::StatusOptions::new();
            options.include_untracked(true);
            let statuses = repo
                .statuses(Some(&mut options))
                .map_err(|e| e.to_string())?;
            let mut lines = Vec::new();
            for entry in statuses.iter() {
                let status = entry.status();
                // Preserve Git's exact output for rename/copy/conflict and
                // other uncommon cases rather than approximating them.
                if status.intersects(
                    git2::Status::CONFLICTED
                        | git2::Status::INDEX_RENAMED
                        | git2::Status::WT_RENAMED
                        | git2::Status::INDEX_TYPECHANGE
                        | git2::Status::WT_TYPECHANGE,
                ) {
                    return Err("unsupported porcelain status".into());
                }
                let index = if status.contains(git2::Status::INDEX_NEW) {
                    'A'
                } else if status.contains(git2::Status::INDEX_DELETED) {
                    'D'
                } else if status.contains(git2::Status::INDEX_MODIFIED) {
                    'M'
                } else {
                    ' '
                };
                let worktree = if status.contains(git2::Status::WT_DELETED) {
                    'D'
                } else if status.contains(git2::Status::WT_MODIFIED) {
                    'M'
                } else {
                    ' '
                };
                let path = entry.path().ok_or("Invalid Git path")?;
                if path
                    .chars()
                    .any(|ch| ch.is_control() || ch == '"' || ch == '\\')
                {
                    return Err("Git must quote this path".into());
                }
                if status.contains(git2::Status::WT_NEW) {
                    // Untracked Finder/AppleDouble files are not project output.
                    if is_host_metadata(path) {
                        continue;
                    }
                    lines.push(format!("?? {path}"));
                } else if index != ' ' || worktree != ' ' {
                    lines.push(format!("{index}{worktree} {path}"));
                }
            }
            Ok(lines.join("\n"))
        })();
        if result.is_ok() {
            return Some(result);
        }
        // Use CLI on unsupported states or libgit2 errors.
    }
    if args == ["diff", "--name-only", "--diff-filter=U"] {
        let result = (|| -> Result<String, String> {
            let index = repo.index().map_err(|e| e.to_string())?;
            let mut paths = Vec::new();
            for conflict in index.conflicts().map_err(|e| e.to_string())? {
                let conflict = conflict.map_err(|e| e.to_string())?;
                if let Some(entry) = conflict.our.or(conflict.their).or(conflict.ancestor) {
                    paths.push(String::from_utf8_lossy(&entry.path).into_owned());
                }
            }
            Ok(paths.join("\n"))
        })();
        return Some(result);
    }
    None
}

#[cfg(windows)]
fn git_cli_path(value: &str) -> String {
    // Git for Windows cannot open Win32 extended-length paths supplied as
    // --git-dir/--work-tree, even though Rust's canonicalize() returns them.
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(value).to_string()
    }
}

#[cfg(all(test, windows))]
#[test]
fn git_cli_path_handles_windows_extended_paths() {
    assert_eq!(
        git_cli_path(r"\\?\D:\project\shadow.git"),
        r"D:\project\shadow.git"
    );
    assert_eq!(
        git_cli_path(r"\\?\UNC\server\share\repo"),
        r"\\server\share\repo"
    );
}

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

fn git_failure_cause(output: &std::process::Output) -> Option<&'static str> {
    #[cfg(windows)]
    if output.status.code().map(|code| code as u32) == Some(0xC000_013A) {
        return Some("Git was interrupted by a console control event (Ctrl+C/Ctrl+Break) or another process termination request");
    }
    #[cfg(unix)]
    if output.status.signal() == Some(libc::SIGINT) {
        return Some("Git was interrupted by SIGINT (Ctrl+C)");
    }
    None
}

fn git_command_failure(cwd: &Path, args: &[&str], output: &std::process::Output) -> String {
    let status = output.status.to_string();
    #[cfg(windows)]
    let status = match output.status.code() {
        Some(code) => format!("{status}, Windows status 0x{:08X}", code as u32),
        None => status,
    };
    // A terminated/crashed Git process can leave only warnings on stderr.
    // Always retain its exit status and both streams, not just the warnings.
    let mut message = format!(
        "git {args:?} failed in {} ({status})",
        cwd.display()
    );
    if let Some(cause) = git_failure_cause(output) {
        message.push_str(&format!("\n{cause}."));
    }
    for (label, bytes) in [("stderr", &output.stderr), ("stdout", &output.stdout)] {
        let text = String::from_utf8_lossy(bytes);
        let text = text.trim();
        if !text.is_empty() {
            message.push_str(&format!("\n{label}:\n{text}"));
        }
    }
    message
}

/// Host Git is a background utility, never an interactive console program.
/// Keep it out of the backend's console so Ctrl+C/Ctrl+Break aimed at the
/// service cannot abort a snapshot commit that is still writing Git metadata.
fn configure_host_git(command: &mut Command) {
    command.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

pub fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let _lease = SlotGitGuard::acquire(cwd)?;
    if private_git_dir(cwd).is_some() && cwd.join(".git").exists() {
        return Err("Graph node created unexpected Git metadata".into());
    }
    if let Some(result) = git_read(cwd, args) {
        return result;
    }
    let bytes = git_bytes(cwd, args, None, None)?;
    if args.contains(&"-z") {
        String::from_utf8(bytes).map_err(|_| "Non-UTF-8 Git paths are unsupported".into())
    } else {
        Ok(String::from_utf8_lossy(&bytes).trim().into())
    }
}

/// Binary-safe plumbing with an optional private index and stdin. Never inherit
/// the service's Git environment, and never let a pipe full of input deadlock
/// a child whose stdout is also a pipe.
pub(crate) fn git_bytes(cwd: &Path, args: &[&str], index: Option<&Path>, input: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let _lease = SlotGitGuard::acquire(cwd)?;
    let metadata = private_git_dir(cwd);
    let mut command_args = Vec::new();
    if !args.contains(&"--git-dir") {
        if let Some(metadata) = &metadata {
            if cwd.join(".git").exists() { return Err("Graph node created unexpected Git metadata".into()); }
            command_args.extend(["--git-dir", metadata.to_str().ok_or("Invalid private Git path")?, "--work-tree", cwd.to_str().ok_or("Invalid workspace path")?]);
        }
    }
    command_args.extend_from_slice(args);
    let args = command_args.as_slice();
    use std::io::Write;
    use std::process::Stdio;
    #[cfg(windows)]
    let cli_args: Vec<String> = args
        .iter()
        .enumerate()
        .map(|(i, arg)| {
            if i > 0 && matches!(args[i - 1], "--git-dir" | "--work-tree") {
                git_cli_path(arg)
            } else {
                (*arg).to_string()
            }
        })
        .collect();
    #[cfg(not(windows))]
    let cli_args = args;
    let hooks_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let hooks_config = format!("core.hooksPath={hooks_path}");
    let mut command = Command::new("git");
    configure_host_git(&mut command);
    crate::native::clear_git_environment(&mut command);
    #[cfg(windows)]
    command.args(["-c", "core.longpaths=true"]);
    command
        .args([
            "-c",
            hooks_config.as_str(),
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Grapher",
            "-c",
            "user.email=runtime@grapher.local",
            // Completion must not wait for an opportunistic repack. Importing
            // a node ref otherwise triggers fetch's automatic maintenance and
            // can hold the node in Running for minutes on a large repository.
            // Maintenance remains an explicit operation, never a side effect.
            "-c",
            "gc.auto=0",
            "-c",
            "maintenance.auto=false",
        ])
        .args(cli_args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(index) = index { command.env("GIT_INDEX_FILE", crate::native::host_path(index)); }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if input.is_some() { command.stdin(Stdio::piped()); }
    let mut child = command.spawn()
        .map_err(|error| format!("Cannot run git {args:?} in {}: {error}", cwd.display()))?;
    let (output, input_result) = std::thread::scope(|scope| {
        let writer = input.map(|bytes| {
            let mut stdin = child.stdin.take().expect("piped Git stdin");
            scope.spawn(move || stdin.write_all(bytes))
        });
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        let input_result = if let Some(writer) = writer { writer.join().map_err(|_| "Git input writer panicked")? } else { Ok(()) };
        Ok::<_, String>((output, input_result))
    })?;
    if !output.status.success() {
        return Err(git_command_failure(cwd, args, &output));
    }
    input_result.map_err(|e| format!("Cannot write Git input: {e}"))?;
    Ok(output.stdout)
}

/// Confirm a recorded source snapshot is still part of the shadow repository's
/// history. Live working-tree edits are deliberately ignored here: node
/// composition reads recorded snapshots, and publication commits pending user
/// edits as its base, so user work never blocks progress.
pub fn check_shadow_base(repository: &Path, expected_head: &str) -> Result<(), String> {
    if shadow_repo_if_exists(repository)?.is_none() {
        // Not materialized yet: the Run has not dispatched its first node.
        return if expected_head.is_empty() {
            Ok(())
        } else {
            Err(STALE_SHADOW_ERROR.to_string())
        };
    }
    let head = repository_git(repository, &["rev-parse", "HEAD"])?;
    if head == expected_head {
        return Ok(());
    }
    repository_git(
        repository,
        &["merge-base", "--is-ancestor", expected_head, "HEAD"],
    )
    .map(|_| ())
    .map_err(|_| {
        "Shadow repository no longer descends from the approved source snapshot; start a new run"
            .to_string()
    })
}

/// Run Git against either a normal checkout or the existing external shadow
/// repository. Publication must never create/rebaseline a shadow repository.
pub fn repository_git(repository: &Path, args: &[&str]) -> Result<String, String> {
    let repository = repository.canonicalize().map_err(|e| e.to_string())?;
    let shadow = match shadow_repo_if_exists(&repository) {
        Ok(Some(shadow)) => shadow,
        Ok(None) if is_standard_git(&repository) => return git(&repository, args),
        Ok(None) => return Err(MISSING_SHADOW_ERROR.into()),
        Err(error) => return Err(error),
    };
    let mut command = vec![
        "--git-dir",
        shadow.to_str().ok_or("Invalid shadow path")?,
        "--work-tree",
        repository.to_str().ok_or("Invalid repository path")?,
    ];
    command.extend_from_slice(args);
    git(&repository, &command)
}

/// Inspect the index belonging to the physical working tree, not a source
/// Graph snapshot that may predate newly staged user files. Private node slots
/// still resolve through host Git, and plain folders use their shadow index.
pub(crate) fn working_tree_git(repository: &Path, args: &[&str]) -> Result<String, String> {
    if is_standard_git(repository) { git(repository, args) }
    else { repository_git(repository, args) }
}

/// Read-only validation of the original binding. Never search, rebind, create a
/// shadow repository, or resolve a missing path relative to the backend cwd.
pub fn validate_binding(repository: &Path) -> Result<(), String> {
    if !repository.is_absolute() || !repository.is_dir() {
        return Err(format!(
            "项目绑定已失效：{}。原目录不存在、不可访问或不是绝对目录；请重新选择目录建立新绑定。",
            repository.display()
        ));
    }
    fs::read_dir(repository).map_err(|error| {
        format!(
            "项目绑定不可访问：{}：{error}。请重新选择目录建立新绑定。",
            repository.display()
        )
    })?;
    if let Some(reason) = prohibited_workspace_reason(repository) {
        return Err(reason);
    }
    Ok(())
}

pub fn verify(repository: &Path) -> Result<String, String> {
    validate_binding(repository)?;
    if is_standard_git(repository) {
        let root = git(repository, &["rev-parse", "--show-toplevel"])?;
        if fs::canonicalize(repository).map_err(|error| error.to_string())?
            != fs::canonicalize(&root).map_err(|error| error.to_string())?
        {
            return Err("Choose the Git repository root".into());
        }

        git(repository, &["rev-parse", "--verify", "HEAD"]).map_err(|error| {
            if error.contains("Needed a single revision") || error.contains("unknown revision") {
                "绑定的 Git 仓库还没有任何提交（HEAD 不存在）；请先完成一次提交再运行。".to_string()
            } else {
                error
            }
        })
    } else {
        if !repository.is_dir() {
            return Err(format!(
                "Directory does not exist: {}",
                repository.display()
            ));
        }
        let canonical = canonical_workspace_path(repository)?;
        materialize_shadow_repo(&canonical, &[])
            .map_err(|error| format!("工作区快照缺少可解析的 HEAD：{error}"))
    }
}

#[cfg(not(windows))]
struct PlannerCopy;

#[cfg(windows)]
struct PlannerCopy {
    repository: PathBuf,
    stack: Vec<PathBuf>,
    linked_bytes: u64,
    linked_entries: u64,
}

#[cfg(windows)]
impl PlannerCopy {
    fn count_linked_file(&mut self, path: &Path) -> Result<(), String> {
        self.linked_bytes = self
            .linked_bytes
            .saturating_add(fs::metadata(path).map_err(|e| e.to_string())?.len());
        self.linked_entries += 1;
        if self.linked_bytes > 512 * 1024 * 1024 || self.linked_entries > 100_000 {
            return Err("Planner symlink materialization limit exceeded".into());
        }
        Ok(())
    }
}

#[cfg(windows)]
fn copy_planner_symlink(
    original: &Path,
    copied: &Path,
    context: &mut PlannerCopy,
) -> Result<(), String> {
    let resolved = original.canonicalize().map_err(|error| {
        format!(
            "Cannot resolve Planner symlink {}: {error}",
            original.display()
        )
    })?;
    if !scope_contains(&resolved, &context.repository)
        || data_root().canonicalize().ok().is_some_and(|data| scope_contains(&resolved, &data))
        || resolved
            .strip_prefix(&context.repository)
            .unwrap()
            .components()
            .any(|component| {
                matches!(component, std::path::Component::Normal(name)
                    if crate::path_identity::is_runtime_metadata_name(name))
            })
    {
        return Err(format!(
            "Planner symlink leaves the allowed repository: {}",
            original.display()
        ));
    }
    let metadata = fs::metadata(&resolved).map_err(|error| {
        format!(
            "Cannot inspect Planner symlink target {}: {error}",
            resolved.display()
        )
    })?;
    if metadata.is_dir() {
        // Resolve only repository-local aliases. Track the active directory
        // chain and limit amplification for DAG-shaped link trees.
        fs::create_dir_all(copied).map_err(|error| error.to_string())?;
        copy_planner_files(&resolved, copied, &data_root(), context, true)
    } else if metadata.is_file() {
        context.count_linked_file(&resolved)?;
        fs::copy(&resolved, copied).map_err(|error| {
            format!(
                "Cannot copy Planner symlink target {}: {error}",
                resolved.display()
            )
        })?;
        Ok(())
    } else {
        Err(format!(
            "Unsupported Planner symlink target: {}",
            resolved.display()
        ))
    }
}

fn copy_planner_files(
    source: &Path,
    target: &Path,
    excluded_data: &Path,
    context: &mut PlannerCopy,
    linked: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let resolved = source.canonicalize().map_err(|error| error.to_string())?;
        if context.stack.contains(&resolved) || context.stack.len() >= 128 {
            return Err(format!(
                "Planner directory link cycle or depth limit: {}",
                source.display()
            ));
        }
        context.stack.push(resolved);
    }
    let result = (|| {
        for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if crate::path_identity::is_runtime_metadata_name(&entry.file_name()) {
                continue;
            }
            let original = entry.path();
            let meta = fs::symlink_metadata(&original).map_err(|e| e.to_string())?;
            if original == excluded_data
                || (meta.is_dir()
                    && original.canonicalize().ok().is_some_and(|original|
                        crate::path_identity::same_path(&original, excluded_data)))
            {
                continue;
            }
            // Cargo build output can contain millions of files and is not part of
            // the source workspace that a Planner needs to inspect or edit.
            if meta.is_dir()
                && entry.file_name() == std::ffi::OsStr::new("target")
                && source.join("Cargo.toml").is_file()
            {
                continue;
            }
            let copied = target.join(entry.file_name());
            if copied.exists() || copied.is_symlink() {
                if copied.is_dir() && !copied.is_symlink() && !meta.is_dir() {
                    fs::remove_dir_all(&copied).map_err(|e| e.to_string())?;
                } else if (!copied.is_dir() || copied.is_symlink()) && meta.is_dir() {
                    fs::remove_file(&copied).map_err(|e| e.to_string())?;
                }
            }
            if meta.is_dir() {
                fs::create_dir_all(&copied).map_err(|e| e.to_string())?;
                copy_planner_files(&original, &copied, excluded_data, context, linked)?;
            } else {
                if copied.exists() || copied.is_symlink() {
                    fs::remove_file(&copied).map_err(|e| e.to_string())?;
                }
                if meta.file_type().is_symlink() {
                    #[cfg(unix)]
                    {
                        let link = fs::read_link(&original).map_err(|e| e.to_string())?;
                        std::os::unix::fs::symlink(link, &copied).map_err(|e| e.to_string())?;
                    }
                    #[cfg(windows)]
                    copy_planner_symlink(&original, &copied, context)?;
                } else if meta.is_file() {
                    #[cfg(windows)]
                    if linked {
                        context.count_linked_file(&original)?;
                    }
                    fs::copy(&original, &copied).map_err(|e| e.to_string())?;
                } else {
                    return Err(format!("Unsupported source entry: {}", original.display()));
                }
            }
        }
        Ok(())
    })();
    #[cfg(windows)]
    context.stack.pop();
    result
}

#[cfg(all(test, windows))]
mod planner_symlink_tests {
    use super::*;

    fn junction(link: &Path, target: &Path) {
        let result = Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[test]
    fn planner_rejects_outside_and_cyclic_junctions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        let external = temp.path().join("private");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("secret.txt"), "secret").unwrap();
        let mut context = PlannerCopy {
            repository: root.canonicalize().unwrap(),
            stack: Vec::new(),
            linked_bytes: 0,
            linked_entries: 0,
        };
        junction(&root.join("outside"), &external);
        assert!(copy_planner_symlink(
            &root.join("outside"),
            &temp.path().join("copy"),
            &mut context
        )
        .unwrap_err()
        .contains("leaves the allowed repository"));
        assert!(!temp.path().join("copy/secret.txt").exists());
        junction(&root.join("cycle"), &root);
        assert!(copy_planner_files(
            &root,
            &temp.path().join("copy"),
            &external,
            &mut context,
            false
        )
        .unwrap_err()
        .contains("cycle"));
    }

    #[test]
    fn planner_copies_repository_local_file_link_only() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("file.txt"), "allowed").unwrap();
        if let Err(error) = std::os::windows::fs::symlink_file("file.txt", root.join("alias.txt")) {
            eprintln!("Windows file symlink creation unavailable: {error}");
            return;
        }
        let mut context = PlannerCopy {
            repository: root.canonicalize().unwrap(),
            stack: Vec::new(),
            linked_bytes: 0,
            linked_entries: 0,
        };
        let copied = temp.path().join("copy.txt");
        copy_planner_symlink(&root.join("alias.txt"), &copied, &mut context).unwrap();
        assert_eq!(fs::read_to_string(copied).unwrap(), "allowed");
    }

    #[test]
    fn planner_materializes_internal_directory_junction() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        let library = root.join("library");
        fs::create_dir_all(&library).unwrap();
        fs::write(library.join("index.js"), "inside").unwrap();
        junction(&root.join("alias"), &library);
        let mut context = PlannerCopy {
            repository: root.canonicalize().unwrap(),
            stack: Vec::new(),
            linked_bytes: 0,
            linked_entries: 0,
        };
        let copied = temp.path().join("copy");
        copy_planner_files(
            &root,
            &copied,
            &temp.path().join("data"),
            &mut context,
            false,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(copied.join("alias/index.js")).unwrap(),
            "inside"
        );
    }
}

/// Current Partitioner/Planner sessions run in source; these helpers remain for
/// legacy checkout/publication compatibility tests.
/// Snapshot the source into a private Planner checkout. The source lock is held
/// only while taking this copy, never while Pi is running. Include ordinary
/// project files, but never Git internals or Grapher data.
pub fn prepare_planner(repository: &Path, path: &Path) -> Result<(), String> {
    let base = verify(repository)?;
    prepare(repository, path, &base, &[])?;
    #[cfg(not(windows))]
    let mut copy_context = PlannerCopy;
    #[cfg(windows)]
    let mut copy_context = PlannerCopy {
        repository: repository
            .canonicalize()
            .map_err(|error| error.to_string())?,
        stack: Vec::new(),
        linked_bytes: 0,
        linked_entries: 0,
    };
    if is_standard_git(repository) {
        let files = git(
            repository,
            &[
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
        )?;
        for name in files.split('\0').filter(|name| !name.is_empty()) {
            let relative = Path::new(name);
            if !relative
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_)))
            {
                return Err("Unsafe path in source Git index".into());
            }
            let original = repository.join(relative);
            let copied = path.join(relative);
            if let Ok(meta) = fs::symlink_metadata(&original) {
                if let Some(parent) = copied.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                if copied.exists() || copied.is_symlink() {
                    if copied.is_dir() && !copied.is_symlink() {
                        fs::remove_dir_all(&copied)
                    } else {
                        fs::remove_file(&copied)
                    }
                    .map_err(|e| e.to_string())?;
                }
                if meta.file_type().is_symlink() {
                    #[cfg(unix)]
                    {
                        let target = fs::read_link(&original).map_err(|e| e.to_string())?;
                        std::os::unix::fs::symlink(target, &copied).map_err(|e| e.to_string())?;
                    }
                    #[cfg(windows)]
                    copy_planner_symlink(&original, &copied, &mut copy_context)?;
                } else if meta.is_dir() {
                    // A Git submodule is stored in the index as a gitlink, but
                    // is a directory in the working tree. Its contents will
                    // be copied by copy_planner_files below; treating the
                    // directory as an unsupported regular file breaks Planner
                    // startup on projects containing a checked-out submodule.
                    continue;
                } else if meta.is_file() {
                    fs::copy(&original, &copied).map_err(|e| e.to_string())?;
                } else {
                    return Err(format!("Unsupported source entry: {}", original.display()));
                }
            } else if copied.exists() || copied.is_symlink() {
                if copied.is_dir() && !copied.is_symlink() {
                    fs::remove_dir_all(&copied)
                } else {
                    fs::remove_file(&copied)
                }
                .map_err(|e| e.to_string())?;
            }
        }
    }
    copy_planner_files(repository, path, &data_root(), &mut copy_context, false)?;
    // The input commit becomes the immutable parent for this Planner's edits.
    snapshot_repository(path)?;
    Ok(())
}

/// Merge one Planner's private changes under the project's short publication
/// lock. Without a resolver, preview conflicts fail without dirtying the source.
pub fn publish_planner(
    repository: &Path,
    planner: &Path,
    preview: &Path,
    run_id: &str,
    planning_id: &str,
) -> Result<(), String> {
    publish_planner_with_merger(repository, planner, preview, run_id, planning_id, |_| {
        Err("Planner merge conflict requires a Merger or manual resolution".into())
    })
}

/// Resolve Planner conflicts in a private preview first, then publish the
/// resolved snapshot. A late source conflict is repaired in the source itself.
pub fn publish_planner_with_merger(
    repository: &Path,
    planner: &Path,
    preview: &Path,
    run_id: &str,
    planning_id: &str,
    mut resolve: impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let source_head = snapshot_repository(repository)?;
    let head = snapshot_node_for_run(
        planner,
        repository,
        &format!("planner-{planning_id}"),
        Some(run_id),
    )?;
    if git(
        planner,
        &["merge-base", "--is-ancestor", &head, &source_head],
    )
    .is_ok()
    {
        return Ok(());
    }
    let mut resolved_preview = false;
    prepare_with_merger(repository, preview, &source_head, &[head.clone()], || {
        resolve(preview)?;
        resolved_preview = true;
        Ok(())
    })
    .map_err(|error| {
        format!(
            "Planner changes conflict with the source; the private workspace is retained: {error}"
        )
    })?;
    // Publish the actual repaired state, not the original conflicting Planner
    // head. Otherwise the source would repeat the already-resolved conflict.
    let head = if resolved_preview {
        snapshot_node_for_run(
            preview,
            repository,
            &format!("planner-{planning_id}-preview"),
            Some(run_id),
        )?
    } else {
        head
    };
    crate::graph_merge::merge_graph_with_workspace(repository, &[head], |path| resolve(path))?;
    Ok(())
}

pub fn prepare(
    repository: &Path,
    path: &Path,
    base: &str,
    parents: &[String],
) -> Result<String, String> {
    prepare_with_merger(repository, path, base, parents, || {
        Err("Workspace composition blocked; resolve and commit the merge manually".into())
    })
}

pub fn prepare_with_merger(
    repository: &Path,
    path: &Path,
    base: &str,
    parents: &[String],
    resolve: impl FnMut() -> Result<(), String>,
) -> Result<String, String> {
    prepare_with_merger_expected(repository, path, base, parents, base, resolve)
}

pub(crate) fn git_file_url(path: &Path) -> Result<String, String> {
    let value = path.to_str().ok_or("Invalid Git repository path")?;
    #[cfg(windows)]
    {
        // canonicalize() returns \\?\C:\... on Windows. Git for Windows does
        // not understand that device prefix in a file URL (file:////?/C:/...).
        // Convert only at the Git URL boundary, leaving OS paths untouched.
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return Ok(format!("file://{}", unc.replace('\\', "/")));
        }
        let local = value.strip_prefix(r"\\?\").unwrap_or(value);
        if local.as_bytes().get(1) == Some(&b':') && local.as_bytes()[0].is_ascii_alphabetic() {
            return Ok(format!("file:///{}", local.replace('\\', "/")));
        }
        if let Some(unc) = local.strip_prefix(r"\\") {
            return Ok(format!("file://{}", unc.replace('\\', "/")));
        }
        return Err(format!("Unsupported Windows Git repository path: {value}"));
    }
    #[cfg(not(windows))]
    Ok(format!("file://{value}"))
}

#[cfg(all(test, windows))]
#[test]
fn git_file_url_handles_windows_extended_paths() {
    assert_eq!(
        git_file_url(Path::new(r"\\?\C:\Users\Test User\source")).unwrap(),
        "file:///C:/Users/Test User/source"
    );
    assert_eq!(
        git_file_url(Path::new(r"\\?\UNC\server\share\repo")).unwrap(),
        "file://server/share/repo"
    );
}

/// Allow a previously published graph to rerun from its original base, but
/// only if the user directory still matches the exact published snapshot.
pub fn prepare_with_merger_expected(
    repository: &Path,
    path: &Path,
    base: &str,
    parents: &[String],
    expected_source_head: &str,
    resolve: impl FnMut() -> Result<(), String>,
) -> Result<String, String> {
    prepare_with_merger_expected_for_run(
        repository,
        path,
        base,
        parents,
        expected_source_head,
        None,
        resolve,
    )
}

pub(crate) fn prepare_with_merger_expected_for_run(
    repository: &Path,
    path: &Path,
    base: &str,
    parents: &[String],
    expected_source_head: &str,
    run_id: Option<&str>,
    mut resolve: impl FnMut() -> Result<(), String>,
) -> Result<String, String> {
    if let Some(id) = run_id {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid Run ID for parent snapshot")?;
    }
    let canonical_repo = canonical_workspace_path(repository)?;
    // A new destination is allowed to be absent; existing paths (including
    // dangling symlinks) must resolve successfully before comparing identity.
    let destination_exists = path.try_exists().map_err(|error| error.to_string())?;
    let canonical_path = if destination_exists || path.is_symlink() {
        Some(canonical_workspace_path(path)?)
    } else {
        None
    };
    if canonical_path.as_ref()
        .is_some_and(|path| crate::path_identity::same_path(path, &canonical_repo))
    {
        if is_standard_git(repository) {
            return git(repository, &["rev-parse", "HEAD"]);
        } else {
            let shadow = shadow_repo_if_exists(&canonical_repo)?
                .ok_or_else(|| missing_shadow_error(&canonical_repo))?;
            let git_dir_str = shadow.to_str().ok_or("Invalid shadow path")?;
            return git(
                &canonical_repo,
                &["--git-dir", git_dir_str, "rev-parse", "HEAD"],
            );
        }
    }

    // Node composition only depends on the recorded source snapshot. Live
    // edits in the user directory must not block preparation or handoff;
    // final publication revalidates the working tree before writing back.
    if !is_standard_git(&canonical_repo) {
        check_shadow_base(&canonical_repo, expected_source_head)?;
    }

    // A deleted workspace leaves its hidden Git metadata beside the Run root.
    // Never revive that stale index/HEAD for a newly materialized slot.
    if !destination_exists && !path.is_symlink() {
        remove_private_git(path)?;
    }
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    canonical_workspace_path(path)?;

    // Determine the source Git location (either standard repository or shadow repo)
    let lock = host_ref_lock(&canonical_repo)?;
    let guard = lock.lock().map_err(|error| error.to_string())?;
    let source_git_path = if is_standard_git(&canonical_repo) {
        ensure_graph_metadata(&canonical_repo)?
    } else {
        shadow_repo_if_exists(&canonical_repo)?.ok_or_else(|| missing_shadow_error(&canonical_repo))?
    };
    let pin = format!("refs/grapher/heads/{base}");
    repository_git(&canonical_repo, &["update-ref", &pin, base])?;
    drop(guard);
    // Resolve refs in the host repository first, then borrow its object store.
    // An alternate is read-only: node commits and refs remain local until
    // snapshot_node explicitly imports them back into the host repository.
    let source_args = if crate::path_identity::same_path(&source_git_path, &canonical_repo) {
        Vec::new()
    } else {
        vec![
            "--git-dir",
            source_git_path.to_str().ok_or("Invalid shadow path")?,
        ]
    };
    // Re-preparation is host work. Expose metadata only for allocation and
    // composition; the completed slot is hidden again before a node starts.
    let _view = MergerGitView::open(path)?;
    let source_git = |args: &[&str]| -> Result<String, String> {
        let mut command = source_args.clone();
        command.extend_from_slice(args);
        git(&canonical_repo, &command)
    };
    let objects = source_git(&[
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
    ])?;
    let objects = PathBuf::from(objects)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let base_head = source_git(&["rev-parse", &format!("refs/grapher/heads/{base}")])?;
    // Alternates must use the same object ID format as their source.
    let object_format = source_git(&["rev-parse", "--show-object-format=storage"])
        .unwrap_or_else(|_| "sha1".into());
    match object_format.as_str() {
        "sha1" => {
            git(path, &["init", "-q"])?;
        }
        "sha256" => {
            git(path, &["init", "-q", "--object-format=sha256"])?;
        }
        _ => return Err(format!("Unsupported Git object format: {object_format}")),
    }
    // Native agent Bash/Git must also handle the deeper AppData checkouts.
    #[cfg(windows)]
    git(path, &["config", "core.longpaths", "true"])?;
    // A source with its own alternates or promisor packs may need additional
    // object databases (or lazy network fetches). Exposing those paths to an
    // agent would bypass the sandbox's narrowly scoped object-store grant.
    // Fall back to an independent fetch for these uncommon repositories.
    let chained_objects = objects.join("info/alternates").is_file()
        || fs::read_dir(objects.join("pack"))
            .map(|entries| {
                entries.filter_map(Result::ok).any(|entry| {
                    entry
                        .path()
                        .extension()
                        .is_some_and(|ext| ext == "promisor")
                })
            })
            .unwrap_or(false);
    let source_url = if chained_objects {
        Some(git_file_url(&source_git_path)?)
    } else {
        None
    };
    if let Some(url) = source_url.as_deref() {
        git(
            path,
            &[
                "fetch",
                "-q",
                "--no-tags",
                "--no-write-fetch-head",
                url,
                &format!("+refs/grapher/heads/{base}:refs/grapher/base"),
            ],
        )?;
    } else {
        #[cfg(windows)]
        let objects_for_git = {
            let value = objects.to_str().ok_or("Invalid Git object path")?;
            if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
                format!(r"\\{unc}")
            } else {
                value.strip_prefix(r"\\?\").unwrap_or(value).to_string()
            }
        };
        #[cfg(not(windows))]
        let objects_for_git = objects
            .to_str()
            .ok_or("Invalid Git object path")?
            .to_string();
        fs::write(
            path.join(".git/objects/info/alternates"),
            format!("{objects_for_git}\n"),
        )
        .map_err(|e| e.to_string())?;
        // No fetch or pack copying: pin just the needed refs in this isolated repo.
        git(path, &["update-ref", "refs/grapher/base", &base_head])?;
    }
    git(
        path,
        &["checkout", "-q", "-f", "-B", "grapher-node", "refs/grapher/base"],
    )?;
    let mut resolved_heads = Vec::new();
    for parent in parents {
        // Runtime parents are commit IDs and use immutable pins. Named
        // parents resolve against this Run's refs, or legacy unscoped refs
        // when using the public prepare() API.
        let is_head =
            matches!(parent.len(), 40 | 64) && parent.bytes().all(|b| b.is_ascii_hexdigit());
        // Node names are arbitrary labels; refs key on their deterministic id.
        let parent_id = if is_head {
            parent.clone()
        } else {
            crate::compiler::node_id(parent)
        };
        let parent_ref = if is_head {
            format!("refs/grapher/heads/{parent_id}")
        } else if let Some(id) = run_id {
            format!("refs/grapher/runs/{id}/nodes/{parent_id}")
        } else {
            format!("refs/grapher/nodes/{parent_id}")
        };
        if let Some(url) = source_url.as_deref() {
            let head_refspec = format!("+{parent_ref}:refs/grapher/parents/{parent_id}");
            git(
                path,
                &[
                    "fetch",
                    "-q",
                    "--no-tags",
                    "--no-write-fetch-head",
                    url,
                    &head_refspec,
                ],
            )?;
        } else {
            let head = source_git(&["rev-parse", &parent_ref])?;
            git(
                path,
                &[
                    "update-ref",
                    &format!("refs/grapher/parents/{parent_id}"),
                    &head,
                ],
            )?;
        }
        resolved_heads.push(git(
            path,
            &["rev-parse", &format!("refs/grapher/parents/{parent_id}")],
        )?);
    }
    for incoming in independent_heads(path, &resolved_heads)? {
        if git(path, &["merge-base", "--is-ancestor", &incoming, "HEAD"]).is_ok() {
            continue;
        }
        if let Err(error) = git(path, &["merge", "--no-edit", "--no-ff", &incoming]) {
            let pending = git(path, &["rev-parse", "--verify", "MERGE_HEAD"]).ok();
            if pending.is_none()
                || git(path, &["diff", "--name-only", "--diff-filter=U"])?.is_empty()
            {
                return Err(format!(
                    "Workspace composition blocked at {}: {error}",
                    path.display()
                ));
            }
            if let Err(merger_error) = resolve() {
                return Err(format!("Workspace composition blocked at {}. The conflicted worktree is preserved; retry the node to re-attempt composition.\nMerger: {merger_error}", path.display()));
            }
            if git(path, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok()
                || !git(path, &["diff", "--name-only", "--diff-filter=U"])?.is_empty()
                || git(path, &["merge-base", "--is-ancestor", &incoming, "HEAD"]).is_err()
                // Managed environment scopes stay untracked by design; only
                // tracked changes mean the Merger left the merge unfinished.
                || !git(path, &["status", "--porcelain", "--untracked-files=no"])?.is_empty()
            {
                return Err(format!("Workspace composition blocked at {}. Merger did not finish a clean merge preserving the incoming parent; the worktree is preserved and retrying the node re-attempts composition.", path.display()));
            }
        }
    }
    git(path, &["rev-parse", "HEAD"])
}

/// Keep only commits not contained in another input, preserving input order.
/// Callers supply resolved commit IDs, not movable refs. Use actual Git history
/// rather than graph reachability: an agent may have rewritten its history.
pub(crate) fn independent_heads(
    repository: &Path,
    heads: &[String],
) -> Result<Vec<String>, String> {
    if heads.len() < 2 {
        return Ok(heads.to_vec());
    }
    let mut args = vec!["merge-base", "--independent"];
    args.extend(heads.iter().map(String::as_str));
    let output = repository_git(repository, &args)?;
    let mut remaining: std::collections::BTreeSet<_> = output.lines().collect();
    let result = heads
        .iter()
        .filter(|head| remaining.remove(head.as_str()))
        .cloned()
        .collect();
    if !remaining.is_empty() {
        return Err("Dependency inputs must be resolved full commit IDs".into());
    }
    Ok(result)
}

/// A graph node must retain its prepared commit so dependency paths carry
/// their upstream filesystem history.
pub fn verify_prepared_ancestor(path: &Path, prepared_head: &str) -> Result<(), String> {
    git(path, &["merge-base", "--is-ancestor", prepared_head, "HEAD"])
        .map(|_| ())
        .map_err(|_| "Node rewrote or discarded its prepared Git history; downstream dependencies cannot safely inherit its result".into())
}

/// Snapshot an isolated node and import its commit into the host repository.
/// Repository identity stays in the host Runtime rather than the agent checkout.
pub fn snapshot_node(path: &Path, repository: &Path, node_name: &str) -> Result<String, String> {
    snapshot_node_for_run(path, repository, node_name, None)
}

pub fn snapshot_node_for_run(
    path: &Path,
    repository: &Path,
    node_name: &str,
    run_id: Option<&str>,
) -> Result<String, String> {
    snapshot_node_scoped(path, repository, node_name, run_id, &[])
}

pub(crate) fn snapshot_node_scoped(
    path: &Path,
    repository: &Path,
    node_name: &str,
    run_id: Option<&str>,
    exclusions: &[String],
) -> Result<String, String> {
    if let Some(id) = run_id {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid Run ID for node snapshot")?;
    }
    let canonical_repo = repository
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let canonical_path = path.canonicalize().map_err(|error| error.to_string())?;
    if scope_contains(&canonical_path, &canonical_repo)
        || scope_contains(&canonical_repo, &canonical_path)
    {
        return Err("Node snapshot requires a non-overlapping isolated workspace".into());
    }
    // Keep one lock order for source/host refs and slot Git metadata. Node
    // staging is part of the same host operation as its ref import.
    let lock = host_ref_lock(&canonical_repo)?;
    let _guard = lock.lock().map_err(|error| error.to_string())?;
    let _lease = SlotGitGuard::acquire(&canonical_path)?;
    if !git(&canonical_path, &["diff", "--name-only", "--diff-filter=U"])?.is_empty() {
        return Err("Unresolved merge conflicts remain".into());
    }
    stage_scoped_local(&canonical_path, exclusions)?;
    if !git(&canonical_path, &["diff", "--cached", "--name-only"])?.is_empty() {
        git(
            &canonical_path,
            &["commit", "-m", SNAPSHOT_COMMIT_MESSAGE],
        )?;
    }
    let head = git(&canonical_path, &["rev-parse", "HEAD"])?;
    git(
        &canonical_path,
        &["update-ref", "refs/heads/grapher-node", &head],
    )?;

    let path_url = git_file_url(private_git_dir(&canonical_path).as_deref().unwrap_or(&canonical_path))?;
    let head_ref = format!("refs/grapher/heads/{head}");
    let head_refspec = format!("+refs/heads/grapher-node:{head_ref}");
    // The label stays human-readable; only the ref uses the safe id.
    let node_id = crate::compiler::node_id(node_name);
    let node_ref = if let Some(id) = run_id {
        format!("refs/grapher/runs/{id}/nodes/{node_id}")
    } else {
        format!("refs/grapher/nodes/{node_id}")
    };
    let node_refspec = format!("+refs/heads/grapher-node:{node_ref}");
    let shadow = if is_standard_git(&canonical_repo) { Some(ensure_graph_metadata(&canonical_repo)?) }
        else { shadow_repo_if_exists(&canonical_repo)? };
    let source_args = shadow.as_ref().map(|shadow| vec![
        "--git-dir".to_string(), shadow.to_string_lossy().into_owned(),
        "--work-tree".to_string(), canonical_repo.to_string_lossy().into_owned(),
    ]).unwrap_or_default();
    // Serialize host ref writes for this repository, not node execution or
    // writes to other repositories. Git's packed-refs lock can outlive a
    // short retry window even when each worker writes a different node ref.
    // External Git processes may still contend, so retain bounded retries.
    for attempt in 0..4 {
        let mut check = source_args.iter().map(String::as_str).collect::<Vec<_>>();
        check.extend(["rev-parse", &head_ref]);
        let pinned = git(&canonical_repo, &check).ok().as_deref() == Some(head.as_str());
        let mut args = source_args.iter().map(String::as_str).collect::<Vec<_>>();
        args.extend([
            "fetch",
            "-q",
            "--no-tags",
            "--no-write-fetch-head",
            // Ref import is part of node completion; never run maintenance here.
            "--no-auto-gc",
            &path_url,
        ]);
        if !pinned {
            args.push(&head_refspec);
        }
        args.push(&node_refspec);
        match git(&canonical_repo, &args) {
            Ok(_) => return Ok(head),
            Err(error) if attempt == 3 => return Err(error),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
    unreachable!()
}

/// Pin an immutable source input for composition with a retained node result.
/// This changes only Grapher-owned refs, never the source working files.
pub fn pin_repository_head(repository: &Path, head: &str) -> Result<(), String> {
    let repository = canonical_workspace_path(repository)?;
    let lock = host_ref_lock(&repository)?;
    let _guard = lock.lock().map_err(|error| error.to_string())?;
    repository_git(
        &repository,
        &["update-ref", &format!("refs/grapher/heads/{head}"), head],
    )?;
    Ok(())
}

/// Snapshot the user-owned source workspace (Planner or Serial). Graph workspaces
/// must use `snapshot_node` to import their commits into Grapher-owned host refs.
/// This never stages, commits or moves the user's branch/index, including for an
/// unborn repository.
pub fn snapshot_repository(path: &Path) -> Result<String, String> {
    snapshot_repository_scoped(path, &[])
}

pub(crate) fn scope_contains(path: &Path, scope: &Path) -> bool {
    if path.starts_with(scope) {
        return true;
    }
    let key = |value: &Path| {
        if value.is_absolute() {
            crate::path_identity::path_key(value)
        } else {
            crate::path_identity::lexical_key(value)
        }
    };
    Path::new(&key(path)).starts_with(Path::new(&key(scope)))
}

pub(crate) fn scoped_args<'a>(base: &[&'a str], exclusions: &'a [String]) -> Vec<String> {
    let mut args: Vec<String> = base.iter().map(|s| s.to_string()).collect();
    if !exclusions.is_empty() {
        args.extend(["--".into(), ".".into()]);
        args.extend(exclusions.iter().map(|s| {
            if cfg!(windows) {
                format!(":(exclude,literal,icase){s}")
            } else {
                format!(":(exclude,literal){s}")
            }
        }));
    }
    args
}

pub(crate) fn repository_status(path: &Path, exclusions: &[String]) -> Result<String, String> {
    // Graph source status compares the working tree against the host snapshot;
    // node workspaces resolve to their own Git view. The user's staged state is
    // preserved separately and is intentionally not part of Graph collection.
    let args = scoped_args(&["status", "--porcelain", "-z"], exclusions);
    let raw = repository_git(path, &args.iter().map(String::as_str).collect::<Vec<_>>())?;
    let mut status = filtered_status(raw, path, exclusions);
    if !cfg!(target_os = "macos") {
        let args = scoped_args(
            &[
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "-z",
            ],
            exclusions,
        );
        let ignored = repository_git(path, &args.iter().map(String::as_str).collect::<Vec<_>>())?;
        let ignored = ignored_host_metadata(&ignored, path, exclusions);
        if !ignored.is_empty() {
            if !status.is_empty() {
                status.push('\n');
            }
            status.push_str(&ignored);
        }
    }
    Ok(status)
}

fn status_path_excluded(
    name: &str,
    root: Option<&Path>,
    data: Option<&Path>,
    exclusions: &[String],
) -> bool {
    if crate::path_identity::is_runtime_metadata_path(Path::new(name)) {
        return true;
    }
    if exclusions
        .iter()
        .any(|scope| scope_contains(Path::new(name), Path::new(scope)))
    {
        return true;
    }
    root.zip(data).is_some_and(|(root, data)| {
        data.strip_prefix(root).ok().is_some_and(|relative| {
            let relative = relative.to_string_lossy().replace('\\', "/");
            !relative.is_empty()
                && (name == relative || name.starts_with(&format!("{relative}/")))
        })
    })
}

fn filtered_status(raw: String, root: &Path, exclusions: &[String]) -> String {
    filtered_status_for(raw, root, exclusions, cfg!(target_os = "macos"))
}

fn filtered_status_for(raw: String, root: &Path, exclusions: &[String], macos: bool) -> String {
    if raw.is_empty() {
        return raw;
    }
    let root = root.canonicalize().ok();
    let data = data_root().canonicalize().ok();
    let mut lines = Vec::new();
    let mut fields = raw.split('\0');
    while let Some(entry) = fields.next() {
        if entry.len() < 4 {
            continue;
        }
        let code = &entry[..2];
        let path = &entry[3..];
        let renamed = code.contains('R') || code.contains('C');
        // macOS treats Finder bookkeeping as host metadata. Elsewhere it is an
        // ordinary project file, but tracked edits remain visible on every host.
        if is_host_metadata_name(path) {
            if macos && (code == "??" || code == "!!") {
                continue;
            }
            if code == "!!" && status_path_excluded(path, root.as_deref(), data.as_deref(), exclusions) {
                continue;
            }
        } else if code == "!!" {
            continue;
        }
        let mut line = format!("{code} {path}");
        if renamed {
            if let Some(original) = fields.next() {
                line.push_str(&format!(" -> {original}"));
            }
        }
        lines.push(line);
    }
    lines.join("\n")
}

fn ignored_host_metadata(raw: &str, root: &Path, exclusions: &[String]) -> String {
    let root = root.canonicalize().ok();
    let data = data_root().canonicalize().ok();
    raw.split('\0')
        .filter(|path| !path.is_empty()
            && is_host_metadata_name(path)
            && !status_path_excluded(path, root.as_deref(), data.as_deref(), exclusions))
        .map(|path| format!("!! {path}"))
        .collect::<Vec<_>>()
        .join("\n")
}


/// Host bookkeeping that macOS filters from dirty reports; other hosts still
/// force-collect it as ordinary project data.
fn is_host_metadata_name(relative: &str) -> bool {
    let relative = relative.trim_end_matches('/');
    let name = relative.rsplit('/').next().unwrap_or(relative);
    name == ".DS_Store" || name.starts_with("._")
}


/// macOS host bookkeeping is not project output. Windows keeps its existing
/// collection strategy because its metadata files are not part of this policy.
/// Tracked metadata remains in the snapshot: the caller re-adds exact paths.
fn is_host_metadata(relative: &str) -> bool {
    cfg!(target_os = "macos") && is_host_metadata_name(relative)
}

fn host_metadata_exclusions() -> Vec<String> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    [".DS_Store", "**/.DS_Store", "._*", "**/._*"]
        .into_iter()
        .map(|pattern| format!(":(exclude,glob){pattern}"))
        .collect()
}

#[cfg(target_os = "macos")]
fn stage_tracked_host_metadata_impl(path: &Path, local: bool) -> Result<(), String> {
    // The exclusion above also hides metadata the user explicitly tracked.
    // Re-stage only paths already in the index, never newly discovered files.
    let run = |args: &[&str]| if local { git(path, args) } else { repository_git(path, args) };
    let tracked = run(&[
        "ls-files",
        "-z",
        "--",
        ".DS_Store",
        "**/.DS_Store",
        "._*",
        "**/._*",
    ])?;
    let tracked: Vec<&str> = tracked.split('\0').filter(|name| !name.is_empty()).collect();
    for chunk in tracked.chunks(100) {
        let mut args = vec!["add", "-f", "-A", "--"];
        args.extend(chunk.iter().copied());
        run(&args)?;
    }
    Ok(())
}

/// Internal snapshot label. All Graph commits stay private; delivery never
/// creates a commit in the user's repository.
pub(crate) const SNAPSHOT_COMMIT_MESSAGE: &str = "snapshot";

pub(crate) fn stage_scoped(path: &Path, exclusions: &[String]) -> Result<(), String> {
    stage_scoped_impl(path, exclusions, false)
}

/// Stage into the physical workspace's own Git index (or its hidden metadata),
/// never into a source shadow database keyed by that path.
pub(crate) fn stage_scoped_local(path: &Path, exclusions: &[String]) -> Result<(), String> {
    stage_scoped_impl(path, exclusions, true)
}

/// Remove managed environment/cache scopes from the index without touching the
/// working tree. A Merger that staged one itself must not leak it into the merge
/// commit, while the live files stay available to the environment.
pub(crate) fn unstage_scoped(path: &Path, exclusions: &[String]) -> Result<(), String> {
    if exclusions.is_empty() {
        return Ok(());
    }
    let mut args = vec![
        "rm".to_string(),
        "-r".to_string(),
        "--cached".to_string(),
        "--ignore-unmatch".to_string(),
        "-q".to_string(),
        "--".to_string(),
    ];
    args.extend(scope_pathspecs(exclusions));
    let args = args.iter().map(String::as_str).collect::<Vec<_>>();
    git(path, &args)?;
    Ok(())
}

/// Whether the index currently tracks a managed environment/cache scope.
pub(crate) fn has_tracked_scoped(path: &Path, exclusions: &[String]) -> Result<bool, String> {
    if exclusions.is_empty() {
        return Ok(false);
    }
    let mut args = vec!["ls-files".to_string(), "-z".to_string(), "--".to_string()];
    args.extend(scope_pathspecs(exclusions));
    let args = args.iter().map(String::as_str).collect::<Vec<_>>();
    Ok(!git(path, &args)?.trim_matches('\0').is_empty())
}

fn scope_pathspecs(exclusions: &[String]) -> Vec<String> {
    exclusions
        .iter()
        .map(|scope| {
            let scope = scope.replace('\\', "/");
            if cfg!(windows) {
                format!(":(literal,icase){scope}")
            } else {
                format!(":(literal){scope}")
            }
        })
        .collect()
}

fn stage_scoped_impl(path: &Path, exclusions: &[String], local: bool) -> Result<(), String> {
    // Runtime deliberately overrides Git's ignore rules for project files:
    // every ordinary project file becomes part of the node/source Git snapshot.
    // Only Grapher internals, Runtime data, managed environment scopes and
    // untracked macOS host metadata stay outside the code snapshot.
    let mut pathspecs = vec![
        ":(exclude,glob).grapher*".to_string(),
        ":(exclude,glob).grapher*/**".to_string(),
        ":(exclude,glob)**/.grapher*".to_string(),
        ":(exclude,glob)**/.grapher*/**".to_string(),
    ];
    pathspecs.extend(host_metadata_exclusions());
    if let (Ok(root), Ok(data)) = (path.canonicalize(), data_root().canonicalize()) {
        if let Ok(relative) = data.strip_prefix(&root) {
            if !relative.as_os_str().is_empty() {
                let relative = relative.to_string_lossy().replace('\\', "/");
                pathspecs.push(format!(":(exclude,literal){relative}"));
                pathspecs.push(format!(":(exclude,glob){relative}/**"));
            }
        }
    }
    pathspecs.extend(exclusions.iter().map(|scope| {
        let scope = scope.replace('\\', "/");
        if cfg!(windows) {
            format!(":(exclude,literal,icase){scope}")
        } else {
            format!(":(exclude,literal){scope}")
        }
    }));
    let mut args = vec!["add".to_string(), "-f".to_string(), "-A".to_string(), "--".to_string(), ".".to_string()];
    args.extend(pathspecs);
    let args = args.iter().map(String::as_str).collect::<Vec<_>>();
    if local {
        git(path, &args)?;
        if !exclusions.is_empty() {
            // Even when an agent staged a managed scope itself, a node snapshot
            // must not carry it. Keep the live files and stage only their removal.
            let mut unstage = vec![
                "rm".to_string(),
                "-r".to_string(),
                "--cached".to_string(),
                "--ignore-unmatch".to_string(),
                "-q".to_string(),
                "--".to_string(),
            ];
            unstage.extend(scope_pathspecs(exclusions));
            let unstage = unstage.iter().map(String::as_str).collect::<Vec<_>>();
            git(path, &unstage)?;
        }
    } else {
        repository_git(path, &args)?;
    }
    #[cfg(target_os = "macos")]
    stage_tracked_host_metadata_impl(path, local)?;
    Ok(())
}

pub(crate) fn copy_ordinary_files(
    source: &Path,
    destination: &Path,
    exclusions: &[String],
    runtime_data: &Path,
) -> Result<(), String> {
    let source = source.canonicalize().map_err(|error| error.to_string())?;
    let destination = destination
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let source_tracked = tracked_paths(&source)?;
    let destination_tracked = tracked_paths(&destination)?;
    let runtime_data = runtime_data.canonicalize().ok();
    crate::native_copy::copy_tree(&source, &destination, |relative| {
        let Some(name) = relative.to_str().map(|name| {
            if cfg!(windows) {
                name.replace('\\', "/")
            } else {
                name.to_owned()
            }
        }) else {
            return false;
        };
        crate::path_identity::is_runtime_metadata_path(relative)
            || source_tracked.contains(&name)
            || is_host_metadata(&name)
            || destination_tracked.iter().any(|tracked| {
                tracked == &name
                    || tracked.starts_with(&format!("{name}/"))
                    || name.starts_with(&format!("{tracked}/"))
            })
            || exclusions
                .iter()
                .any(|scope| scope_contains(relative, Path::new(scope)))
            || runtime_data.as_ref().is_some_and(|data| {
                data != &source && data.starts_with(&source) && source.join(relative).starts_with(data)
            })
    })
}

fn tracked_paths(repository: &Path) -> Result<std::collections::BTreeSet<String>, String> {
    Ok(repository_git(repository, &["ls-files", "-z", "--cached"])?
        .split('\0')
        .filter(|name| !name.is_empty())
        .map(|name| {
            if cfg!(windows) {
                name.replace('\\', "/")
            } else {
                name.to_owned()
            }
        })
        .collect())
}

/// Match the collection boundary when validating a private checkout index.
/// Dirty excluded paths must remain untouched, including their user index state.
pub(crate) fn collection_path_excluded(path: &Path, name: &str, exclusions: &[String]) -> bool {
    let root = path.canonicalize().ok();
    let data = data_root().canonicalize().ok();
    status_path_excluded(name, root.as_deref(), data.as_deref(), exclusions)
}

/// A private Planner/node slot owns its own Git database (visible or hidden).
/// Never route it through the source shadow used for source capture.
fn snapshot_private_workspace_scoped(path: &Path, exclusions: &[String]) -> Result<String, String> {
    if !git(path, &["diff", "--name-only", "--diff-filter=U"])?.is_empty() {
        return Err("Unresolved merge conflicts remain".into());
    }
    stage_scoped_local(path, exclusions)?;
    if !git(path, &["diff", "--cached", "--name-only"])?.is_empty() {
        git(path, &["commit", "-m", SNAPSHOT_COMMIT_MESSAGE])?;
    }
    git(path, &["rev-parse", "HEAD"])
}

/// Exclusions never alter source .gitignore or unstage unrelated user changes.
pub(crate) fn snapshot_repository_scoped(
    path: &Path,
    exclusions: &[String],
) -> Result<String, String> {
    if private_slot_layout(path) {
        return snapshot_private_workspace_scoped(path, exclusions);
    }
    if is_standard_git(path) {
        if !git(path, &["diff", "--name-only", "--diff-filter=U"])?.is_empty()
            || git(path, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok()
        {
            return Err("Unresolved or unrelated source merge remains".into());
        }
        let index_lock = host_index_lock(path)?;
        let _index_guard = index_lock.lock().map_err(|e| e.to_string())?;
        let head = git(path, &["rev-parse", "HEAD"]).ok();
        let shadow = {
            let lock = host_ref_lock(path)?;
            let _guard = lock.lock().map_err(|e| e.to_string())?;
            ensure_shadow_metadata(path)?
        };
        let shadow_text = shadow.to_str().ok_or("Invalid internal repository path")?;
        if let Some(head) = head.as_deref() {
            if repository_git(path, &["cat-file", "-e", &format!("{head}^{{commit}}")]).is_err() {
                let url = git_file_url(private_git_dir(path).as_deref().unwrap_or(path))?;
                git(path, &["--git-dir", shadow_text, "fetch", "-q", "--no-tags",
                    "--no-write-fetch-head", "--no-auto-gc", &url, head])?;
            }
            // Read/write only the private index. The user's index and branch are
            // untouched, even when their staged content differs from the worktree.
            repository_git(path, &["read-tree", head])?;
        } else {
            // An unborn repository has no user commit to copy. Build a root
            // snapshot from the current files without creating one in the user
            // repository.
            repository_git(path, &["read-tree", "--empty"])?;
        }
        stage_scoped(path, exclusions)?;
        let tree = repository_git(path, &["write-tree"])?;
        let original = match head.as_deref() {
            Some(head) => Some(repository_git(path, &["rev-parse", &format!("{head}^{{tree}}")])?),
            None => None,
        };
        let lock = host_ref_lock(path)?;
        let _guard = lock.lock().map_err(|e| e.to_string())?;
        let published = repository_git(path, &["rev-parse", "--verify", "refs/grapher/published/source"]).ok();
        let composed = repository_git(path, &["rev-parse", "--verify", "refs/grapher/published/composed"]).ok();
        let bridge = head.as_deref().zip(published.as_deref()).zip(composed.as_deref()).and_then(|((head, published), composed)| {
            repository_git(path, &["merge-base", "--is-ancestor", published, head]).is_ok().then_some(composed)
        });
        let input_ref = format!("refs/grapher/inputs/{}-{}-{}", head.as_deref().unwrap_or("unborn"), tree, bridge.unwrap_or("source"));
        let snapshot = if let Ok(existing) = repository_git(path, &["rev-parse", "--verify", &input_ref]) {
            existing
        } else {
            let snapshot = match (head.as_deref(), bridge) {
                // Carry delivered node ancestry only in the internal history,
                // so later revisions don't reapply already published changes.
                (Some(head), Some(composed)) => repository_git(path, &["commit-tree", &tree, "-p", head, "-p", composed, "-m", SNAPSHOT_COMMIT_MESSAGE])?,
                (Some(head), None) if original.as_deref() == Some(tree.as_str()) => head.to_string(),
                (Some(head), None) => repository_git(path, &["commit-tree", &tree, "-p", head, "-m", SNAPSHOT_COMMIT_MESSAGE])?,
                (None, _) => repository_git(path, &["commit-tree", &tree, "-m", SNAPSHOT_COMMIT_MESSAGE])?,
            };
            repository_git(path, &["update-ref", &input_ref, &snapshot])?;
            snapshot
        };
        repository_git(path, &["update-ref", "HEAD", &snapshot])?;
        repository_git(path, &["update-ref", &format!("refs/grapher/heads/{snapshot}"), &snapshot])?;
        Ok(snapshot)
    } else {
        let canonical = path.canonicalize().map_err(|error| error.to_string())?;
        let index_lock = host_index_lock(&canonical)?;
        let _index_guard = index_lock.lock().map_err(|e| e.to_string())?;
        let shadow = {
            let lock = host_ref_lock(&canonical)?;
            let _guard = lock.lock().map_err(|e| e.to_string())?;
            ensure_shadow_metadata(&canonical)?
        };
        let git_dir_str = shadow.to_str().ok_or("Invalid shadow path")?;
        let work_tree_str = canonical.to_str().ok_or("Invalid target path")?;
        stage_scoped(&canonical, exclusions)?;
        let status = git(
            &canonical,
            &[
                "--git-dir",
                git_dir_str,
                "--work-tree",
                work_tree_str,
                "diff",
                "--cached",
                "--name-only",
            ],
        )?;
        let unborn = git(
            &canonical,
            &["--git-dir", git_dir_str, "rev-parse", "--verify", "HEAD"],
        )
        .is_err();
        let lock = host_ref_lock(&canonical)?;
        let _guard = lock.lock().map_err(|e| e.to_string())?;
        if !status.trim().is_empty() || unborn {
            let mut commit = vec![
                "--git-dir",
                git_dir_str,
                "--work-tree",
                work_tree_str,
                "commit",
            ];
            if status.trim().is_empty() {
                commit.push("--allow-empty");
            }
            commit.extend(["-m", SNAPSHOT_COMMIT_MESSAGE]);
            git(&canonical, &commit)?;
        }
        bridge_plain_snapshot(&canonical)
    }
}

/// Snapshot only isolated Graph workspaces. Executions in the source directory
/// (Serial and source-direct follow-ups) never stage, commit or create Git metadata.
pub fn snapshot_execution(
    path: &Path,
    repository: &Path,
    node_name: &str,
) -> Result<String, String> {
    snapshot_execution_for_run(path, repository, node_name, None)
}

pub fn snapshot_execution_for_run(
    path: &Path,
    repository: &Path,
    node_name: &str,
    run_id: Option<&str>,
) -> Result<String, String> {
    let canonical_repo = repository
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let canonical_path = path.canonicalize().map_err(|error| error.to_string())?;
    if crate::path_identity::same_path(&canonical_path, &canonical_repo) {
        Ok(String::new())
    } else {
        snapshot_node_for_run(&canonical_path, &canonical_repo, node_name, run_id)
    }
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod workspace_tests;

#[cfg(all(test, windows))]
#[path = "git_console_tests.rs"]
mod git_console_tests;


#[cfg(test)]
mod status_filter_tests {
    use super::*;

    #[test]
    fn ignored_host_metadata_is_platform_specific_and_scoped() {
        let raw = concat!(
            "!! ._late\0",
            "!! nested/.DS_Store\0",
            "!! node_modules/build.o\0",
            "!! managed/._cache\0",
            "?? ._new\0",
            " M .DS_Store\0",
        ).to_string();
        let root = Path::new("/nonexistent-grapher-status-root");
        let exclusions = vec!["managed".to_string()];

        let macos = filtered_status_for(raw.clone(), root, &exclusions, true);
        assert!(!macos.contains("._late"), "{macos}");
        assert!(!macos.contains("nested/.DS_Store"), "{macos}");
        assert!(!macos.contains("._new"), "{macos}");
        assert!(macos.contains(" M .DS_Store"), "{macos}");

        let other = filtered_status_for(raw, root, &exclusions, false);
        assert!(other.contains("!! ._late"), "{other}");
        assert!(other.contains("!! nested/.DS_Store"), "{other}");
        assert!(!other.contains("node_modules"), "{other}");
        assert!(!other.contains("managed/._cache"), "{other}");
        assert!(other.contains("?? ._new"), "{other}");
        assert!(other.contains(" M .DS_Store"), "{other}");

        let ignored = ignored_host_metadata(
            "._late\0nested/.DS_Store\0node_modules/build.o\0managed/._cache\0",
            root,
            &exclusions,
        );
        assert!(ignored.contains("!! ._late"), "{ignored}");
        assert!(ignored.contains("!! nested/.DS_Store"), "{ignored}");
        assert!(!ignored.contains("node_modules"), "{ignored}");
        assert!(!ignored.contains("managed/._cache"), "{ignored}");
    }

    #[test]
    fn ignored_host_metadata_is_collected_from_git_ls_files() {
        let temp = tempfile::tempdir().unwrap();
        let repository = temp.path().join("repo");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-q"]).unwrap();
        fs::write(repository.join(".gitignore"), ".DS_Store\n._*\n").unwrap();
        fs::create_dir(repository.join("nested")).unwrap();
        fs::write(repository.join("._late"), "late").unwrap();
        fs::write(repository.join("nested/.DS_Store"), "nested").unwrap();
        fs::write(repository.join("nested/keep.txt"), "keep").unwrap();
        let raw = repository_git(
            &repository,
            &["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
        )
        .unwrap();
        let result = ignored_host_metadata(&raw, &repository, &[]);
        assert!(result.contains("!! ._late"), "{result}");
        assert!(result.contains("!! nested/.DS_Store"), "{result}");
        assert!(!result.contains("nested/keep.txt"), "{result}");
    }
}
