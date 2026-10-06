//! Host-native execution with explicit Pi file-tool mapping and per-platform
//! Graph workspaces. macOS/Linux enforce filesystem boundaries; Windows runs
//! ordinary host processes (no per-agent sandbox). Bash keeps Pi's semantics.
use crate::engine::PiRole;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Mutex, OnceLock},
};
#[cfg(any(not(feature = "fixture"), test))]
use std::{
    thread,
};

static RUNTIME: OnceLock<Mutex<Option<crate::native_runtime_storage::NativeRuntime>>> = OnceLock::new();
static RUNTIME_SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

pub(crate) fn begin_shutdown() { RUNTIME_SHUTTING_DOWN.store(true, Ordering::SeqCst); }

pub(crate) fn shutdown_runtime() {
    begin_shutdown();
    if let Some(cache) = RUNTIME.get() {
        if let Err(error) = crate::native_runtime_storage::release(cache) {
            eprintln!("[Grapher] Native runtime cleanup deferred: {error}");
        }
    }
}
#[cfg(not(feature = "fixture"))]
static RUNTIME_PREWARM_STARTED: AtomicBool = AtomicBool::new(false);

/// Prepare Graph's shared, verified engine copy before a Planner needs it.
/// No project snapshots, sessions, tools or model calls are started here.
#[cfg(not(feature = "fixture"))]
pub(crate) fn warm_graph_runtime(repository: PathBuf) {
    if repository.as_os_str().is_empty() {
        return;
    }
    schedule_runtime_prewarm(&RUNTIME_PREWARM_STARTED, move || {
        crate::workspace::validate_binding(&repository)?;
        require_graph_execution()?;
        prepared_runtime().map(|_| ())
    });
}

#[cfg(any(not(feature = "fixture"), test))]
fn schedule_runtime_prewarm(
    started: &'static AtomicBool,
    prepare: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Option<thread::JoinHandle<()>> {
    // Saving configuration and starting concurrent runs must not queue threads
    // behind RUNTIME's expensive copy. A failure remains retryable; successful
    // preparation is shared by all Graph executions in this backend process.
    if started
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return None;
    }
    Some(thread::spawn(move || {
        if let Err(error) = prepare() {
            started.store(false, Ordering::SeqCst);
            eprintln!("[Grapher] Graph runtime prewarm unavailable: {error}");
        }
    }))
}

pub fn require_graph_execution() -> Result<(), String> {
    #[cfg(windows)]
    {
        // Windows deliberately uses the caller's ordinary host permissions.
        // Independent Git repositories isolate snapshots, not filesystem access.
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        return crate::linux_sandbox::require_supported();
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        if !crate::sandbox::supported() {
            return Err("Native Graph execution requires macOS sandbox-exec".into());
        }
        Ok(())
    }
}

pub(crate) fn prepared_runtime() -> Result<PathBuf, String> {
    let mut cached = RUNTIME
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|e| e.to_string())?;
    if RUNTIME_SHUTTING_DOWN.load(Ordering::SeqCst) { return Err("Backend is shutting down".into()); }
    if let Some(runtime) = &*cached {
        return Ok(runtime.directory.clone());
    }
    let installation = installation_root()
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Grapher installation root: {error}"))?;
    let runtime_parent = crate::workspace::native_runtime_parent();
    // Recover marked, unused per-backend copies from the old desktop/project
    // default too. Unmarked copies still require explicit offline opt-in.
    if std::env::var_os("GRAPHER_NATIVE_RUNTIME_PARENT").is_none() {
        if let Some(parent) = installation.parent() {
            match crate::native_runtime_storage::unused_with_cancel(&parent.join(".grapher-workspaces"), false,
                || RUNTIME_SHUTTING_DOWN.load(Ordering::SeqCst)) {
                Ok(copies) => for copy in copies {
                    if let Err(error) = crate::native_runtime_storage::remove(&copy) { eprintln!("[Grapher] {error}"); }
                },
                Err(error) => eprintln!("[Grapher] Cannot clean legacy native runtimes: {error}"),
            }
        }
    }
    let key = run_runtime_preparation(&installation, &runtime_parent, None, None)?;
    let runtime = crate::native_runtime_storage::get_or_prepare_verified(
        &runtime_parent,
        key.trim(),
        || RUNTIME_SHUTTING_DOWN.load(Ordering::SeqCst),
        |destination| {
            let output = run_runtime_preparation(&installation, &runtime_parent, Some(destination), None)?;
            let returned = PathBuf::from(output.trim()).canonicalize().map_err(|error| error.to_string())?;
            if returned != destination { return Err("Native runtime preparation returned a different destination".into()); }
            Ok(())
        },
        |directory| match run_runtime_preparation(&installation, &runtime_parent, None, Some(directory)) {
            Ok(actual) => Ok(actual.trim() == key.trim()),
            Err(error) => {
                eprintln!("[Grapher] Native runtime verification failed: {error}");
                Ok(false)
            }
        },
    )?;
    let root = runtime.directory.clone();
    eprintln!("[Grapher] Shared Graph runtime ready: {}", host_path(&root).display());
    *cached = Some(runtime);
    Ok(root)
}

fn run_runtime_preparation(installation: &Path, parent: &Path, destination: Option<&Path>, key_for: Option<&Path>) -> Result<String, String> {
    let mut command = Command::new("node");
    command.arg(host_path(&installation.join("scripts/prepare-native-runtime.mjs")))
        .env("GRAPHER_NATIVE_RUNTIME_PARENT", host_path(parent))
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(destination) = destination {
        command.env("GRAPHER_NATIVE_RUNTIME_DIR", host_path(destination));
    } else {
        command.arg("--cache-key").env_remove("GRAPHER_NATIVE_RUNTIME_DIR");
        if let Some(directory) = key_for { command.arg(host_path(directory)); }
    }
    crate::process_control::configure_command(&mut command);
    // Shared preparation is backend-owned, not cancelled with one particular
    // Run. Track its copier/Git descendants so exit cannot leave them writing.
    let output = crate::process_control::with_owner("native-runtime", || {
        let mut child = command.spawn().map_err(|error| format!("Cannot start native runtime preparation with Node: {error}"))?;
        let tree = crate::process_control::track(&child).map_err(|error| {
            let _ = child.kill(); let _ = child.wait(); error
        })?;
        if RUNTIME_SHUTTING_DOWN.load(Ordering::SeqCst) { tree.terminate(); }
        child.wait_with_output().map_err(|error| error.to_string())
    })?;
    if !output.status.success() {
        return Err(format!(
            "Cannot prepare native Pi runtime (exit {}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

fn installation_root_for(executable: Option<&Path>, source_root: &Path) -> PathBuf {
    // Distributions are relocatable; never use the CI checkout embedded by Cargo
    // when the executable has its own runtime alongside it. Dev/test binaries
    // under backend/target still use the source checkout.
    if let Some(parent) = executable.and_then(Path::parent) {
        if parent.join("engine/entrypoint.mjs").is_file() {
            return parent.to_path_buf();
        }
    }
    source_root.to_path_buf()
}

pub fn installation_root() -> PathBuf {
    installation_root_for(
        std::env::current_exe().ok().as_deref(),
        &Path::new(env!("CARGO_MANIFEST_DIR")).join(".."),
    )
}

/// Rust's extended Windows paths are valid filesystem identities, but stock
/// Node's CLI/module loader and Git Bash expect ordinary drive/UNC paths.
pub(crate) fn host_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(value.strip_prefix(r"\\?\").unwrap_or(&value));
    }
    #[cfg(not(windows))]
    path.to_path_buf()
}

pub(crate) fn clear_git_environment(command: &mut Command) {
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_CONFIG_COUNT",
    ] {
        command.env_remove(key);
    }
}

pub fn validate_workspace(role: PiRole, repository: &Path, cwd: &Path) -> Result<(), String> {
    crate::workspace::validate_binding(repository)?;
    let repository = repository.canonicalize().map_err(|e| e.to_string())?;
    let cwd = cwd
        .canonicalize()
        .map_err(|e| format!("Invalid execution directory: {e}"))?;
    if cwd != repository {
        // Conflict repair belongs in the checkout containing the merge, not
        // necessarily the source. Private Mergers retain the same workspace
        // validation and platform boundaries as other private executions.
        if matches!(role, PiRole::Partitioner | PiRole::Planner) {
            return Err(format!("{} must use the bound source directory", if role == PiRole::Planner { "Planner" } else { "Partitioner" }));
        }
        if cwd.starts_with(&repository) || repository.starts_with(&cwd) {
            return Err("Graph workspace must not overlap the source directory".into());
        }
        if !cwd.join(".git").is_dir()
            || !cwd
                .join(".git")
                .canonicalize()
                .map_err(|e| e.to_string())?
                .starts_with(&cwd)
        {
            return Err("Graph requires a private Git repository".into());
        }
        require_graph_execution()?;
    }
    if !cfg!(target_os = "macos")
        && !cfg!(target_os = "windows")
        && !cfg!(target_os = "linux")
        && cwd != repository
    {
        return Err("Private Graph workspaces are unavailable on this host".into());
    }
    Ok(())
}

pub fn command(role: PiRole, repository: &Path, cwd: &Path) -> Result<Command, String> {
    validate_workspace(role, repository, cwd)?;
    if repository.canonicalize().map_err(|e| e.to_string())?
        != cwd.canonicalize().map_err(|e| e.to_string())?
    {
        return Err("Private workspaces require execution_command and its platform context".into());
    }
    let mut command = Command::new("node");
    command.arg(host_path(&installation_root().join("engine/entrypoint.mjs")));
    command.current_dir(host_path(cwd));
    command.env("PI_CODING_AGENT_DIR", host_path(&agent_dir()?));
    command.env_remove("GRAPHER_EXECUTION_KIND");
    clear_git_environment(&mut command);
    Ok(command)
}

pub fn execution_command(
    role: PiRole,
    repository: &Path,
    cwd: &Path,
    data: &Path,
    session: &Path,
) -> Result<Command, String> {
    validate_workspace(role, repository, cwd)?;
    let source = repository.canonicalize().map_err(|e| e.to_string())?;
    let current = cwd.canonicalize().map_err(|e| e.to_string())?;
    if source == current {
        return command(role, repository, cwd);
    }
    let worktree_root = current
        .parent()
        .and_then(Path::parent)
        .filter(|root| {
            root.file_name()
                .is_some_and(|name| name == ".grapher-worktrees" || name == ".grapher-workspaces")
        })
        .ok_or("Graph workspace must be .grapher-worktrees/<run>/<instance>")?;
    #[cfg(windows)]
    let _ = worktree_root; // Keep the same workspace layout validation on Windows.
    let engine = prepared_runtime()?;
    #[cfg(target_os = "macos")]
    {
        let profile = session.join("execution-instance.sb");
        crate::sandbox::write_execution_profile(
            &profile,
            &source,
            worktree_root,
            &current,
            data,
            session,
            &engine,
        )?;
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .arg("-f")
            .arg(profile)
            .arg("node")
            .arg(engine.join("engine/entrypoint.mjs"));
        command
            .current_dir(&current)
            .env("PI_CODING_AGENT_DIR", agent_dir()?);
        clear_git_environment(&mut command);
        return Ok(command);
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (data, session);
        let mut command = Command::new("node");
        command
            .arg(host_path(&engine.join("engine/entrypoint.mjs")))
            .current_dir(host_path(&current))
            .env("PI_CODING_AGENT_DIR", host_path(&agent_dir()?));
        clear_git_environment(&mut command);
        return Ok(command);
    }
    #[cfg(target_os = "linux")]
    {
        let pi_dir = agent_dir()?;
        let mut command = crate::linux_sandbox::execution_command(
            &source,
            worktree_root,
            &current,
            data,
            session,
            &engine,
            &pi_dir,
        )?;
        clear_git_environment(&mut command);
        Ok(command)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (source, worktree_root, data, session, engine);
        Err(
            "Native Graph execution is not available without a validated host filesystem sandbox"
                .into(),
        )
    }
}

/// Shared upstream-owned credentials/config; this is not a directory mapping.
pub fn agent_dir() -> Result<PathBuf, String> {
    let home = PathBuf::from(
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or("HOME or USERPROFILE is required")?,
    );
    let path = if let Some(path) = std::env::var_os("PI_CODING_AGENT_DIR") {
        PathBuf::from(path)
    } else {
        PathBuf::from(&home).join(".grapher/pi-agent")
    };
    let path = if path == Path::new("~") || path.starts_with("~/") {
        home.join(path.strip_prefix("~").unwrap())
    } else {
        path
    };
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let target_models = path.join("models.json");
    let isolated_models = std::env::var_os("GRAPHER_ISOLATED_PI_MODELS").as_deref()
        == Some(std::ffi::OsStr::new("1"));
    if !target_models.exists() && !isolated_models {
        let source_models = home.join(".pi/agent/models.json");
        if source_models.exists() {
            #[cfg(unix)]
            {
                let _ = std::os::unix::fs::symlink(&source_models, &target_models);
            }
            #[cfg(windows)]
            {
                // Windows symlink creation commonly requires a developer mode
                // or elevated privilege; a private copy preserves startup.
                let _ = fs::copy(&source_models, &target_models);
            }
        }
    }
    path.canonicalize().map_err(|e| e.to_string())
}

/// Do not silently discard old execution leases: an old backend may have left
/// writers alive. This check never calls the retired executor or deletes state.
pub fn check_retired_leases(data: &Path) -> Result<(), String> {
    let directory = data.join("containers");
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name().to_string_lossy().starts_with("grapher-") {
            return Err(format!("发现旧执行器的未清理 lease：{}。请先使用旧版本停止对应执行并确认没有后台写入；新原生后端不会删除记录或接管旧执行。", entry.path().display()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graph_prewarm_is_async_single_flight_and_retries_after_failure() {
        use std::{sync::mpsc, time::Duration};
        static STARTED: AtomicBool = AtomicBool::new(false);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = schedule_runtime_prewarm(&STARTED, move || {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Err("test preparation failure".into())
        })
        .unwrap();
        // Scheduling returned while preparation is still blocked. Repeated
        // config saves/requests neither wait nor launch another copy.
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(schedule_runtime_prewarm(&STARTED, || panic!("duplicate preparation")).is_none());
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert!(!STARTED.load(Ordering::SeqCst));

        schedule_runtime_prewarm(&STARTED, || Ok(()))
            .unwrap()
            .join()
            .unwrap();
        assert!(STARTED.load(Ordering::SeqCst));
        assert!(schedule_runtime_prewarm(&STARTED, || panic!("already prepared")).is_none());
    }

    #[test]
    fn native_child_commands_clear_external_git_path_overrides() {
        let mut command = Command::new("node");
        for key in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_SYSTEM",
            "GIT_CONFIG_COUNT",
        ] {
            command.env(key, "external");
        }
        clear_git_environment(&mut command);
        for key in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_SYSTEM",
            "GIT_CONFIG_COUNT",
        ] {
            assert!(command
                .get_envs()
                .any(|(name, value)| name == std::ffi::OsStr::new(key) && value.is_none()));
        }
    }

    #[test]
    fn installation_root_prefers_relocated_package_and_retains_dev_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let packaged = temp.path().join("Grapher 安装 # %");
        let source = temp.path().join("source");
        let executable = packaged.join("grapher");
        assert_eq!(installation_root_for(Some(&executable), &source), source);
        fs::create_dir_all(packaged.join("engine")).unwrap();
        fs::write(packaged.join("engine/entrypoint.mjs"), "").unwrap();
        assert_eq!(installation_root_for(Some(&executable), &source), packaged);
        assert_eq!(installation_root_for(None, &source), source);
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    fn source_role_launches_the_pinned_native_entrypoint() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        let mut launcher = command(PiRole::Planner, &source, &source).unwrap();
        let result = launcher
            .arg("--version")
            .env("PI_CODING_AGENT_DIR", temp.path().join("agent"))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(!result.stdout.is_empty());
    }

    #[test]
    fn overlapping_workspace_and_role_mismatch_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let node = temp.path().join("node");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&node).unwrap();
        assert!(validate_workspace(PiRole::NodeAgent, &source, &node)
            .unwrap_err()
            .contains("private Git"));
        assert!(validate_workspace(PiRole::Planner, &source, &node).is_err());
        let private = temp.path().join(".grapher-workspaces/run/planner");
        fs::create_dir_all(&private).unwrap();
        crate::workspace::git(&private, &["init", "-q"]).unwrap();
        assert!(validate_workspace(PiRole::Planner, &source, &private)
            .unwrap_err().contains("Planner must use the bound source directory"));
        assert!(validate_workspace(PiRole::Partitioner, &source, &private).is_err());
        #[cfg(unix)]
        {
            let alias = temp.path().join("alias");
            std::os::unix::fs::symlink(&node, &alias).unwrap();
            assert!(validate_workspace(PiRole::NodeAgent, &source, &alias)
                .unwrap_err()
                .contains("private Git"));
            assert!(validate_workspace(PiRole::Planner, &source, &alias).is_err());
        }
    }

    #[test]
    fn merger_can_use_source_node_and_planner_workspaces_without_bypassing_validation() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        assert!(validate_workspace(PiRole::Merger, &source, &source).is_ok());
        for relative in [".grapher-worktrees/run/node", ".grapher-workspaces/run/preview"] {
            let private = temp.path().join(relative);
            fs::create_dir_all(&private).unwrap();
            assert!(validate_workspace(PiRole::Merger, &source, &private)
                .unwrap_err().contains("private Git"));
            crate::workspace::git(&private, &["init", "-q"]).unwrap();
            validate_workspace(PiRole::Merger, &source, &private).unwrap();
            assert!(validate_workspace(PiRole::Partitioner, &source, &private).is_err());
            assert!(command(PiRole::Merger, &source, &private)
                .unwrap_err().contains("platform context"));
        }
        let overlapping = source.join("nested");
        fs::create_dir(&overlapping).unwrap();
        crate::workspace::git(&overlapping, &["init", "-q"]).unwrap();
        assert!(validate_workspace(PiRole::Merger, &source, &overlapping)
            .unwrap_err().contains("overlap"));
        assert!(validate_workspace(PiRole::Merger, &source, temp.path())
            .unwrap_err().contains("overlap"));
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    fn source_planner_launcher_keeps_source_writes_and_graph_output() {
        let temp = tempfile::tempdir().unwrap();
        let base = host_path(&temp.path().canonicalize().unwrap());
        let source = base.join("源项目 space # %");
        let data = base.join("data");
        let session = data.join("planner-session");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&session).unwrap();
        let graph_path = session.join("graph.json");
        let probe = base.join("planner-probe.ts");
        fs::write(&probe, r#"import * as fs from 'node:fs';
export default function () {
  fs.writeFileSync(process.env.GRAPHER_GRAPH_PATH!, 'graph');
  fs.writeFileSync('planner-output', 'source content');
}
"#).unwrap();
        // Windows canonical paths use the extended prefix; macOS commonly
        // canonicalizes /var to /private/var. Both identities must stay native.
        let canonical_source = source.canonicalize().unwrap();
        let mut command = execution_command(PiRole::Planner, &canonical_source, &canonical_source, &data, &session).unwrap();
        assert_eq!(command.get_program(), std::ffi::OsStr::new("node"));
        assert_eq!(command.get_current_dir(), Some(host_path(&canonical_source).as_path()));
        let output = command.args(["--mode", "json", "--print", "--no-session", "--no-skills", "--no-extensions", "--extension"])
            .arg(&probe).arg("--session-dir").arg(&session)
            .env("GRAPHER_MODE", "planner").env("GRAPHER_GRAPH_PATH", &graph_path)
            .stdin(std::process::Stdio::null()).output().unwrap();
        assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert_eq!(fs::read_to_string(&graph_path).unwrap(), "graph");
        assert_eq!(fs::read_to_string(source.join("planner-output")).unwrap(), "source content");
    }

    #[test]
    fn planning_roles_use_source_aliases_without_private_workspaces_or_engine_copies() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("源项目 space # %");
        fs::create_dir(&source).unwrap();
        let canonical = source.canonicalize().unwrap();
        let alias = temp.path().join("source-link");
        crate::path_safety::directory_link(&source, &alias);
        for role in [PiRole::Partitioner, PiRole::Planner] {
            for cwd in [&source, &canonical, &alias] {
                let command = execution_command(role, &source, cwd, temp.path(), temp.path()).unwrap();
                assert_eq!(command.get_program(), std::ffi::OsStr::new("node"));
                assert_eq!(command.get_current_dir().unwrap().canonicalize().unwrap(), canonical);
                assert_eq!(command.get_args().next(), Some(host_path(&installation_root().join("engine/entrypoint.mjs")).as_os_str()));
                assert!(!temp.path().join(".grapher-workspaces").exists());
                assert!(!temp.path().join(".grapher-worktrees").exists());
            }
        }
    }

    #[test]
    #[cfg(windows)]
    fn source_launcher_normalizes_windows_drive_and_unc_prefixes_only() {
        for (input, expected) in [
            (r"\\?\C:\源项目 space\src", r"C:\源项目 space\src"),
            (r"\\?\UNC\server\share\源项目 space", r"\\server\share\源项目 space"),
            (r"C:\source\file", r"C:\source\file"),
        ] {
            assert_eq!(host_path(Path::new(input)), PathBuf::from(expected));
        }
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    fn graph_launcher_runs_parallel_native_tools_and_absolute_scripts() {
        let temp = tempfile::tempdir().unwrap();
        let base = host_path(&temp.path().canonicalize().unwrap());
        let source = base.join("source");
        let data = source.join(".grapher"); // exercise data inside protected source
        let root = base.join(".grapher-worktrees");
        let a = root.join("run/a");
        let b = root.join("run/b");
        for path in [&source, &data, &a, &b] {
            fs::create_dir_all(path).unwrap();
        }
        for path in [&a, &b] {
            crate::workspace::git(path, &["init", "-q"]).unwrap();
        }
        // Linux also checks the source's (possibly external) Git common dir.
        crate::workspace::git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("source-marker"), "SOURCE").unwrap();
        let other_session = data.join("sessions/other/private");
        fs::create_dir_all(other_session.parent().unwrap()).unwrap();
        fs::write(&other_session, "SESSION").unwrap();
        let external = base.join("external.cjs");
        fs::write(
            &external,
            "require('node:fs').writeFileSync('external-ran',process.argv[2])",
        )
        .unwrap();
        let material = base.join("material.txt");
        fs::write(&material, "external material").unwrap();
        let probe = base.join("probe.ts");
        fs::write(
            &probe,
            include_str!("../../scripts/native-tools-launcher-probe.ts"),
        )
        .unwrap();
        let engine = prepared_runtime().unwrap();
        let mut workers = Vec::new();
        for (label, role, cwd, sibling) in [
            ("A", PiRole::NodeAgent, &a, &b),
            ("B", PiRole::Merger, &b, &a),
        ] {
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&source, cwd.join("source-link")).unwrap();
                std::os::unix::fs::symlink(&material, cwd.join("external-link")).unwrap();
            }
            #[cfg(windows)]
            fs::copy(&material, cwd.join("external-link")).unwrap();
            let session = data.join(format!("sessions/{label}"));
            fs::create_dir_all(&session).unwrap();
            let mut command =
                execution_command(role, &source, cwd, &data, &session).unwrap();
            // macOS additionally denies the original installation when
            // testing Grapher on its own source; Linux's copied engine is RO.
            #[cfg(target_os = "macos")]
            {
                let profile = session.join("execution-instance.sb");
                let mut policy = fs::read_to_string(&profile).unwrap();
                policy.push_str(&format!(
                    "(deny file-read* file-write* (subpath {}))\n",
                    serde_json::to_string(
                        &installation_root()
                            .canonicalize()
                            .unwrap()
                            .to_string_lossy()
                    )
                    .unwrap()
                ));
                fs::write(profile, policy).unwrap();
            }
            command
                .args([
                    "--mode",
                    "json",
                    "--print",
                    "--no-session",
                    "--no-extensions",
                    "--no-skills",
                    "--extension",
                ])
                .arg(&probe)
                .arg("--session-dir")
                .arg(&session)
                .env("GRAPHER_MODE", if role == PiRole::Merger { "merger" } else { "node" })
                .env("GRAPHER_EXECUTION_KIND", "graph")
                .env("GRAPHER_ORIGINAL_ROOT", &source)
                .env("GRAPHER_SOURCE_ALIAS", &source)
                .env("GRAPHER_TEST_RUNTIME", &engine)
                .env("GRAPHER_TEST_LABEL", label)
                .env("GRAPHER_TEST_EXTERNAL", &external)
                .env("GRAPHER_TEST_SIBLING", sibling.join("private"))
                .env("GRAPHER_TEST_OTHER_SESSION", &other_session)
                .env("PI_CODING_AGENT_DIR", base.join(format!("agent-{label}")))
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            crate::process_control::configure_command(&mut command);
            let child = command.spawn().unwrap();
            let tree = crate::process_control::track(&child).unwrap();
            workers.push((label, child, tree));
        }
        for (label, worker, _tree) in workers {
            let output = worker.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{label}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let cwd = if label == "A" { &a } else { &b };
            assert_eq!(
                fs::read_to_string(cwd.join("launcher-tools-passed")).unwrap(),
                label
            );
            assert_eq!(
                fs::read_to_string(data.join(format!("sessions/{label}/probe-session-write")))
                    .unwrap(),
                label
            );
        }
        assert_eq!(fs::read_to_string(a.join("mapped.txt")).unwrap(), "final-A");
        assert_eq!(fs::read_to_string(b.join("mapped.txt")).unwrap(), "final-B");
        assert_eq!(
            fs::read_to_string(source.join("source-marker")).unwrap(),
            "SOURCE"
        );
        assert_eq!(fs::read_to_string(other_session).unwrap(), "SESSION");
        assert!(!source.join("mapped.txt").exists());
    }

    #[test]
    fn stale_leases_block_startup_without_discarding_evidence() {
        let temp = tempfile::tempdir().unwrap();
        check_retired_leases(temp.path()).unwrap();
        let directory = temp.path().join("containers");
        fs::create_dir(&directory).unwrap();
        let record = directory.join("grapher-old-execution");
        fs::write(&record, "1").unwrap();
        assert!(check_retired_leases(temp.path()).is_err());
        assert_eq!(fs::read_to_string(record).unwrap(), "1");
    }
}
