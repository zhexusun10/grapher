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
        if let Some(path) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(path);
        }
        if let Some(unc) = value.strip_prefix("//?/UNC/") {
            return PathBuf::from(format!(r"\\{}", unc.replace('/', "\\")));
        }
        if let Some(path) = value.strip_prefix("//?/") {
            return PathBuf::from(path.replace('/', "\\"));
        }
        PathBuf::from(value.into_owned())
    }
    #[cfg(not(windows))]
    path.to_path_buf()
}

#[cfg(windows)]
fn normalize_windows_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix("/cygdrive/") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b'/' {
            return PathBuf::from(format!(
                "{}:{}",
                (bytes[0] as char).to_ascii_uppercase(),
                &rest[1..]
            ));
        }
    }
    if let Some(rest) = text.strip_prefix('/') {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b'/' {
            return PathBuf::from(format!(
                "{}:{}",
                (bytes[0] as char).to_ascii_uppercase(),
                &rest[1..]
            ));
        }
    }
    path
}

#[cfg(not(windows))]
fn normalize_windows_path(path: PathBuf) -> PathBuf {
    path
}

/// Normalize a configured environment path from Git Bash/MSYS spelling on
/// Windows (`/c/Users/...`, `/cygdrive/c/...`) and expand a leading `~`.
pub(crate) fn environment_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(|value| {
        normalize_windows_path(expand_home_path(PathBuf::from(value)))
    })
}

/// Windows prefers USERPROFILE; Git Bash commonly exports a POSIX HOME that
/// native Win32 path handling must not treat as a current-drive path.
pub(crate) fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let value = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    #[cfg(not(windows))]
    let value = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    value.map(|value| normalize_windows_path(expand_home_path(PathBuf::from(value))))
}

pub(crate) fn expand_home_path(path: PathBuf) -> PathBuf {
    let Some(home) = home_dir_for_expansion() else { return path };
    let text = path.to_string_lossy();
    if text == "~" {
        return home;
    }
    if let Some(rest) = text.strip_prefix("~/").or_else(|| text.strip_prefix("~\\")) {
        return home.join(rest);
    }
    path
}

fn home_dir_for_expansion() -> Option<PathBuf> {
    #[cfg(windows)]
    let value = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    #[cfg(not(windows))]
    let value = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    value.map(PathBuf::from)
}

/// Keep temporary files inside the per-execution session and remove inherited
/// shell path state that would otherwise make relative `cd` unpredictable.
pub(crate) fn bind_process_paths(command: &mut Command, temp: &Path) {
    for key in ["CDPATH", "OLDPWD", "GLOBIGNORE"] {
        command.env_remove(key);
    }
    if !temp.as_os_str().is_empty() {
        let _ = fs::create_dir_all(temp);
    }
    let temp = host_path(temp);
    command
        .env("TMPDIR", &temp)
        .env("TMP", &temp)
        .env("TEMP", &temp)
        .env("XDG_RUNTIME_DIR", &temp);
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
        "GIT_CONFIG_PARAMETERS",
        "GIT_CEILING_DIRECTORIES",
    ] {
        command.env_remove(key);
    }
}

pub(crate) fn bind_workspace_state(command: &mut Command, workspace: &Path) -> Result<(), String> {
    let state = crate::workspace_state::prepare(workspace)?;
    let home = state.join(".agent-home");
    crate::path_safety::real_child_path(&state, &home, false)?;
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    if let Some(directory) = environment_path("GRAPHER_GLOBAL_PI_AGENT_DIR").or_else(|| home_dir().map(|home| home.join(".pi/agent"))) {
        command.env("GRAPHER_GLOBAL_PI_AGENT_DIR", host_path(&directory));
    }
    for (key, value) in workspace_environment(workspace)? { command.env(key, value); }
    Ok(())
}

pub(crate) fn workspace_environment(workspace: &Path) -> Result<std::collections::BTreeMap<String, String>, String> {
    let state = crate::workspace_state::process_root(workspace)?;
    let home = state.join(".agent-home");
    let mut bindings = std::collections::BTreeMap::new();
    for (key, path) in [
        ("GIT_CONFIG_GLOBAL", state.join(".git-config/global")),
        ("GIT_CEILING_DIRECTORIES", workspace.parent().ok_or("Missing project parent")?.to_path_buf()),
        ("HOME", home.clone()), ("USERPROFILE", home.clone()),
        ("APPDATA", home.join("AppData/Roaming")), ("LOCALAPPDATA", home.join("AppData/Local")),
        ("XDG_CONFIG_HOME", home.join(".config")), ("XDG_DATA_HOME", home.join(".local/share")),
        ("XDG_CACHE_HOME", state.join(".runtime-cache/xdg")),
        ("npm_config_cache", state.join(".runtime-cache/npm")),
        ("PIP_CACHE_DIR", state.join(".runtime-cache/pip")),
        ("CONDA_ENVS_PATH", state.join(".environments")),
        ("CONDA_PKGS_DIRS", state.join(".runtime-cache/conda")),
    ] { bindings.insert(key.to_string(), host_path(&path).to_string_lossy().into_owned()); }
    Ok(bindings)
}

pub fn validate_workspace(role: PiRole, repository: &Path, cwd: &Path) -> Result<(), String> {
    crate::workspace::validate_binding(repository)?;
    if let Some(bucket) = cwd.parent().and_then(Path::parent).filter(|root| root.file_name().is_some_and(|name| name == ".grapher-worktrees" || name == ".grapher-workspaces")) {
        crate::path_safety::real_child_path(bucket, cwd, false)?;
    }
    let repository = crate::path_identity::actual_path(repository).map_err(|e| e.to_string())?;
    let cwd = crate::path_identity::actual_path(cwd)
        .map_err(|e| format!("Invalid execution directory: {e}"))?;
    crate::path_identity::ensure_windows_path(&repository, "Source repository")?;
    crate::path_identity::ensure_windows_path(&cwd, "Execution workspace")?;
    let data = crate::workspace::data_root();
    if data.exists() && crate::workspace::scope_contains(&data, &repository) {
        return Err("Runtime data is inside the source project; configure an external GRAPHER_DATA_DIR before launching an agent (existing data is not migrated or deleted)".into());
    }
    #[cfg(unix)]
    if repository.to_str().is_none() || cwd.to_str().is_none() {
        return Err("Source and execution paths must be valid UTF-8 for model path mapping".into());
    }
    if !crate::path_identity::same_path(&cwd, &repository) {
        // Planner follow-ups and conflict repair can use a current node slot.
        // Private Planner/Merger turns retain the same workspace validation and
        // platform boundaries as other private executions.
        if role == PiRole::Partitioner {
            return Err("Partitioner must use the bound source directory".into());
        }
        if cwd.starts_with(&repository) || repository.starts_with(&cwd) {
            return Err("Graph workspace must not overlap the source directory".into());
        }
        if !crate::workspace::has_private_git(&cwd) {
            return Err("Graph requires a private Git repository".into());
        }
        // A linked/worktree project Git may live under the slot's external
        // process root; validate_ready below still requires that exact binding.
        if cwd.join(".git").exists() {
            let git = cwd
                .join(".git")
                .canonicalize()
                .map_err(|e| e.to_string())?;
            let state = crate::workspace_state::process_root(&cwd)?;
            if !git.starts_with(&cwd) && !git.starts_with(&state) {
                return Err("Graph requires a private Git repository".into());
            }
        }
        crate::workspace_view::validate_ready(&cwd, &repository)?;
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

/// Resolve the engine before applying business PATH. Never let an environment
/// replace the pinned Pi's Node executable with an arbitrary workspace binary.
pub(crate) fn trusted_node() -> Result<PathBuf, String> {
    static NODE: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    NODE.get_or_init(|| {
        let output = Command::new("node").args(["-p", "process.execPath"]).output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err("Cannot resolve trusted native Node".into()); }
        let path = PathBuf::from(String::from_utf8(output.stdout).map_err(|e| e.to_string())?.trim());
        if !path.is_absolute() || !path.is_file() { return Err("Invalid trusted native Node executable".into()); }
        Ok(host_path(&path.canonicalize().map_err(|e| e.to_string())?))
    }).clone()
}

/// Resolve the bootstrap Git before applying business PATH. The Grapher-owned
/// entrypoint verifies the pinned Pi baseline with the host's Git; a business
/// environment may keep a deliberately minimal PATH and must not choose it.
pub(crate) fn trusted_git() -> Result<PathBuf, String> {
    static GIT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    GIT.get_or_init(|| {
        let name = if cfg!(windows) { "git.exe" } else { "git" };
        let path = std::env::var_os("PATH")
            .and_then(|value| std::env::split_paths(&value)
                .map(|directory| directory.join(name))
                .find(|candidate| candidate.is_file()))
            .ok_or("Native Git is unavailable for pinned baseline verification")?;
        Ok(host_path(&path.canonicalize().map_err(|e| e.to_string())?))
    }).clone()
}

pub fn command(role: PiRole, repository: &Path, cwd: &Path) -> Result<Command, String> {
    let repository = crate::path_identity::actual_path(repository).map_err(|e| e.to_string())?;
    let cwd = crate::path_identity::actual_path(cwd).map_err(|e| e.to_string())?;
    validate_workspace(role, &repository, &cwd)?;
    if !crate::path_identity::same_path(&repository, &cwd) {
        return Err("Private workspaces require execution_command and its platform context".into());
    }
    let mut command = Command::new(trusted_node()?);
    command.arg(host_path(&installation_root().join("engine/entrypoint.mjs")));
    command.current_dir(host_path(&cwd));
    command.env("PI_CODING_AGENT_DIR", host_path(&agent_dir()?));
    command.env_remove("GRAPHER_EXECUTION_KIND");
    clear_git_environment(&mut command);
    for key in ["CDPATH", "OLDPWD", "GLOBIGNORE"] {
        command.env_remove(key);
    }
    bind_trusted_git(&mut command)?;
    command.env("PYTHONDONTWRITEBYTECODE", "1");
    Ok(command)
}

/// The business launch binding replaces PATH before Pi/extension factories.
/// The bootstrap needs host Git even when that PATH omits it; the protected
/// GRAPHER_ namespace keeps business variables from forging the value.
fn bind_trusted_git(command: &mut Command) -> Result<(), String> {
    command.env("GRAPHER_TRUSTED_GIT", host_path(&trusted_git()?));
    Ok(())
}

pub fn execution_command(
    role: PiRole,
    repository: &Path,
    cwd: &Path,
    data: &Path,
    session: &Path,
) -> Result<Command, String> {
    execution_command_scoped(role, repository, cwd, data, session, &[])
}

/// Describe the private-execution deny set for model-visible diagnostics.
///
/// This value grants no access; the platform profile (macOS Seatbelt) or mount
/// layout (Linux bubblewrap) remains the boundary. It lets the engine report a
/// uniform "permission denied" for a denied path instead of the platform's raw
/// errno (EPERM on macOS; ENOENT for masked reads and EROFS for read-only
/// writes on Linux). `allowed` lists the exempted paths so a genuine error
/// inside them stays a genuine error rather than a reported denial.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn denied_paths_value(
    repository: &Path,
    source: &Path,
    worktree_root: &Path,
    current: &Path,
    data: &Path,
    session: &Path,
    engine: &Path,
    allowances: &[PathBuf],
    merger_git: &[PathBuf],
) -> String {
    let mut allowed = vec![current.to_path_buf(), session.to_path_buf()];
    if let Ok(state) = crate::workspace_state::prepare(current) {
        allowed.push(state);
    }
    // The sandbox also exposes each authorized Planner follow-up workspace and
    // its per-slot state, so both are allowed here or a switched Planner would
    // misreport a genuine error under the new state as a sandbox denial.
    for workspace in allowances {
        allowed.push(workspace.clone());
        if let Ok(state) = crate::workspace_state::prepare(workspace) {
            allowed.push(state);
        }
    }
    allowed.extend(merger_git.iter().cloned());
    let mut read = vec![source.to_path_buf(), worktree_root.to_path_buf(), data.to_path_buf()];
    if !crate::path_identity::same_path(repository, source) {
        read.push(repository.to_path_buf());
    }
    let mut write = read.clone();
    write.push(engine.to_path_buf());
    write.push(installation_root());
    let host = |paths: &[PathBuf]| {
        paths
            .iter()
            .map(|path| host_path(path).to_string_lossy().into_owned())
            .collect::<Vec<_>>()
    };
    serde_json::json!({
        "read": host(&read),
        "write": host(&write),
        "allowed": host(&allowed),
    })
    .to_string()
}

pub(crate) fn execution_command_scoped(
    role: PiRole,
    repository: &Path,
    cwd: &Path,
    data: &Path,
    session: &Path,
    workspaces: &[PathBuf],
) -> Result<Command, String> {
    validate_workspace(role, repository, cwd)?;
    let mut allowances = Vec::new();
    for workspace in workspaces {
        if role != PiRole::Planner { return Err("Only Planner can switch authorized workspaces".into()); }
        validate_workspace(role, repository, workspace)?;
        let target = crate::path_identity::actual_path(workspace).map_err(|e| e.to_string())?;
        let current = crate::path_identity::actual_path(cwd).map_err(|e| e.to_string())?;
        if target.parent() != current.parent() { return Err("Planner workspace belongs to a different physical Run owner".into()); }
        let state = crate::workspace_state::prepare(&target)?;
        let home = state.join(".agent-home");
        crate::path_safety::real_child_path(&state, &home, false)?;
        fs::create_dir_all(home).map_err(|e| e.to_string())?;
        if target != current && !allowances.contains(&target) { allowances.push(target); }
    }
    let bound_source = crate::path_identity::actual_path(repository).map_err(|e| e.to_string())?;
    let bound_data = crate::path_identity::actual_path(data).map_err(|e| e.to_string())?;
    let bound_session = crate::path_identity::actual_path(session).map_err(|e| e.to_string())?;
    if crate::workspace::scope_contains(&bound_data, &bound_source) || crate::workspace::scope_contains(&bound_session, &bound_source) {
        return Err("Agent runtime/session data must be outside the source project; existing data is retained, not migrated".into());
    }
    let source = crate::path_identity::actual_path(repository).map_err(|e| e.to_string())?;
    let current = crate::path_identity::actual_path(cwd).map_err(|e| e.to_string())?;
    if crate::path_identity::same_path(&source, &current) {
        return command(role, &source, &current);
    }
    crate::workspace_view::validate_ready(&current, &source)?;
    crate::workspace_state::prepare(&current)?;
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
    crate::path_identity::ensure_windows_path(&engine, "Native engine")?;
    crate::path_identity::ensure_windows_path(session, "Execution session")?;
    // A bound project view keeps its composition merge (MERGE_HEAD and the
    // unmerged index) in the hidden graph Git; the Merger is the only role that
    // targets it (through GIT_DIR). Expose exactly that repository to the
    // platform sandbox without opening graph history to node/Planner agents.
    let merger_git: Vec<PathBuf> = if role == PiRole::Merger {
        crate::workspace::private_git_dir(&current).into_iter().collect()
    } else {
        Vec::new()
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let denied_paths = denied_paths_value(
        repository,
        &source,
        worktree_root,
        &current,
        data,
        session,
        &engine,
        &allowances,
        &merger_git,
    );
    #[cfg(target_os = "macos")]
    {
        let profile = session.join("execution-instance.sb");
        crate::sandbox::write_execution_profile_scoped(
            &profile,
            &source,
            worktree_root,
            &current,
            data,
            session,
            &engine,
            &crate::native::installation_root(),
            &allowances,
            &merger_git,
        )?;
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .arg("-f")
            .arg(profile)
            .arg(trusted_node()?)
            .arg(engine.join("engine/entrypoint.mjs"));
        command
            .current_dir(&current)
            .env("PI_CODING_AGENT_DIR", agent_dir()?)
            .env("GRAPHER_DENIED_PATHS", &denied_paths);
        clear_git_environment(&mut command);
        bind_trusted_git(&mut command)?;
        bind_process_paths(&mut command, session);
        bind_workspace_state(&mut command, &current)?;
        command.env("PYTHONDONTWRITEBYTECODE", "1");
        return Ok(command);
    }
    #[cfg(target_os = "windows")]
    {
        let _ = data;
        let _ = &merger_git;
        let mut command = unsandboxed_command(&engine, &current)?;
        bind_process_paths(&mut command, session);
        bind_workspace_state(&mut command, &current)?;
        return Ok(command);
    }
    #[cfg(target_os = "linux")]
    {
        let pi_dir = agent_dir()?;
        let mut command = crate::linux_sandbox::execution_command_scoped(
            &source,
            worktree_root,
            &current,
            data,
            session,
            &engine,
            &pi_dir,
            &allowances,
            &merger_git,
        )?;
        command.env("GRAPHER_DENIED_PATHS", &denied_paths);
        clear_git_environment(&mut command);
        bind_trusted_git(&mut command)?;
        bind_process_paths(&mut command, session);
        bind_workspace_state(&mut command, &current)?;
        Ok(command)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (&merger_git, source, worktree_root, data, session, engine);
        Err(
            "Native Graph execution is not available without a validated host filesystem sandbox"
                .into(),
        )
    }
}

/// Run the verified engine without a platform sandbox. Windows uses the host
/// boundary directly; fixture result launches cannot use production sandbox
/// geometry because their disposable workspaces live under the test data root.
#[cfg(any(windows, feature = "fixture"))]
fn unsandboxed_command(engine: &Path, current: &Path) -> Result<Command, String> {
    let mut command = Command::new(trusted_node()?);
    command
        .arg(host_path(&engine.join("engine/entrypoint.mjs")))
        .current_dir(host_path(current))
        .env("PI_CODING_AGENT_DIR", host_path(&agent_dir()?));
    clear_git_environment(&mut command);
    bind_trusted_git(&mut command)?;
    command.env("PYTHONDONTWRITEBYTECODE", "1");
    Ok(command)
}

/// Fixture result-entry launches substitute the engine and keep disposable
/// workspaces under the test data root, which production sandbox geometry
/// rejects. Platform boundaries stay covered by the native suites built
/// without the fixture feature.
#[cfg(feature = "fixture")]
pub fn fixture_execution_command(cwd: &Path) -> Result<Command, String> {
    unsandboxed_command(&prepared_runtime()?, cwd)
}

/// Shared upstream-owned credentials/config; this is not a directory mapping.
pub fn agent_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("HOME or USERPROFILE is required")?;
    let path = if let Some(path) = environment_path("PI_CODING_AGENT_DIR") {
        expand_home_path(path)
    } else {
        home.join(".grapher/pi-agent")
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
    fn source_binding_named_like_a_graph_slot_keeps_its_own_git_directory() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join(".grapher-worktrees").join(uuid::Uuid::new_v4().to_string()).join("source");
        fs::create_dir_all(&source).unwrap();
        crate::workspace::git(&source, &["init", "-q"]).unwrap();
        execution_command(PiRole::Planner, &source, &source, &temp.path().join("data"), &temp.path().join("session")).unwrap();
        assert!(source.join(".git").is_dir(), "source metadata must never be hidden as node metadata");
        assert!(crate::workspace::private_git_dir(&source).is_none());
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
    fn engine_bootstrap_binds_host_git_outside_the_business_path() {
        let git = trusted_git().unwrap();
        assert!(git.is_file(), "baseline verification requires a real Git: {}", git.display());
        let mut command = Command::new("node");
        bind_trusted_git(&mut command).unwrap();
        let value = command
            .get_envs()
            .find(|(name, _)| *name == std::ffi::OsStr::new("GRAPHER_TRUSTED_GIT"))
            .and_then(|(_, value)| value)
            .expect("bootstrap Git binding is required");
        assert_eq!(Path::new(value), git);
    }

    #[test]
    fn engine_command_binds_python_dont_write_bytecode() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let cmd = command(PiRole::NodeAgent, &repo, &repo).unwrap();
        let value = cmd
            .get_envs()
            .find(|(name, _)| *name == std::ffi::OsStr::new("PYTHONDONTWRITEBYTECODE"))
            .and_then(|(_, value)| value)
            .expect("PYTHONDONTWRITEBYTECODE binding is required");
        assert_eq!(value, "1");
    }

    #[test]
    fn environment_paths_expand_home_without_rewriting_absolute_paths() {
        let expanded = expand_home_path(PathBuf::from("~/grapher-agent"));
        assert!(expanded.is_absolute(), "{}", expanded.display());
        assert!(expanded.ends_with("grapher-agent"));
        let absolute = PathBuf::from("/tmp/absolute-agent");
        assert_eq!(expand_home_path(absolute.clone()), absolute);
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
    fn external_project_git_metadata_is_a_valid_private_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let common = temp.path().join("git-common");
        fs::create_dir(&source).unwrap();
        crate::workspace::git(
            &source,
            &[
                "init",
                "-q",
                "--separate-git-dir",
                common.to_str().unwrap(),
            ],
        )
        .unwrap();
        fs::write(source.join("file.txt"), "project\n").unwrap();
        crate::workspace::git(&source, &["add", "-A"]).unwrap();
        crate::workspace::git(&source, &["commit", "-qm", "base"]).unwrap();
        let base = crate::workspace::snapshot_repository(&source).unwrap();
        let slot = temp
            .path()
            .join(".grapher-worktrees")
            .join(uuid::Uuid::new_v4().to_string())
            .join("node");
        crate::workspace::prepare(&source, &slot, &base, &[]).unwrap();
        assert!(slot.join(".git").is_file());
        validate_workspace(PiRole::NodeAgent, &source, &slot).unwrap();
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
        let error = validate_workspace(PiRole::Planner, &source, &private).unwrap_err();
        assert!(error.contains("source-equivalent"), "{error}");
        let private = private.with_file_name("planner-v2");
        let input = crate::workspace::materialize_shadow_repo(&source, &[]).unwrap();
        crate::workspace::prepare(&source, &private, &input, &[]).unwrap();
        validate_workspace(PiRole::Planner, &source, &private).unwrap();
        assert!(command(PiRole::Planner, &source, &private)
            .unwrap_err().contains("platform context"));
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
            assert!(validate_workspace(PiRole::Merger, &source, &private).is_err());
            let private = private.with_file_name(format!("{}-v2", private.file_name().unwrap().to_string_lossy()));
            let input = crate::workspace::materialize_shadow_repo(&source, &[]).unwrap();
            crate::workspace::prepare(&source, &private, &input, &[]).unwrap();
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
        assert_eq!(command.get_program(), trusted_node().unwrap().as_os_str());
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
                assert_eq!(command.get_program(), trusted_node().unwrap().as_os_str());
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
    fn planner_private_launcher_uses_each_selected_worktree_and_native_bash() {
        let temp = tempfile::tempdir().unwrap();
        let base = host_path(&temp.path().canonicalize().unwrap());
        let source = base.join("source");
        let data = base.join("data");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&data).unwrap();
        crate::workspace::git(&source, &["init", "-q"]).unwrap();
        let engine = prepared_runtime().unwrap();
        let probe = base.join("planner-probe.ts");
        fs::write(&probe, r#"
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export default async function () {
  try {
    assert.equal(realpathSync(process.cwd()), realpathSync(process.env.EXPECTED_CWD));
    const { default: policy } = await import(pathToFileURL(join(process.env.GRAPHER_TEST_RUNTIME, 'engine/prompt-extension.ts')).href);
    const tools = new Map(), hooks = new Map();
    policy({ registerTool(tool) { tools.set(tool.name, tool); }, on(name, hook) { hooks.set(name, hook); } });
    assert.deepEqual([...tools.keys()].sort(), ['bash', 'edit', 'read', 'write']);
    const bash = tools.get('bash');
    const text = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
    await bash.execute('planner-cwd', { command: 'printf frontier > planner-probe.txt' });
    assert.equal(readFileSync('planner-probe.txt', 'utf8'), 'frontier');
    assert.equal(text(await bash.execute('pwd', { command: 'pwd -P' })), '.');
    assert.equal(text(await tools.get('read').execute('read', { path: join(process.env.GRAPHER_ORIGINAL_ROOT, 'planner-probe.txt') })), 'frontier');
    const modelPath = join(process.env.GRAPHER_ORIGINAL_ROOT, 'planner-plan.md');
    await tools.get('write').execute('write', { path: modelPath, content: 'planned: first\n' });
    assert.equal(readFileSync('planner-plan.md', 'utf8'), 'planned: first\n');
    await tools.get('edit').execute('edit', { path: modelPath, edits: [{ oldText: 'first', newText: 'second' }] });
    assert.equal(readFileSync('planner-plan.md', 'utf8'), 'planned: second\n');
    const options = { cwd: process.cwd(), appendSystemPrompt: 'Existing instructions.' };
    await hooks.get('before_agent_start')({ systemPromptOptions: options });
    assert.equal(options.cwd, '.');
    assert.equal(options.appendSystemPrompt, 'Existing instructions.');
    process.exit(0);
  } catch (error) { console.error(error); process.exit(1); }
}
"#).unwrap();
        for label in ["first", "next"] {
            let cwd = base.join(".grapher-worktrees/run").join(label);
            let session = data.join("planner-session");
            fs::create_dir_all(&session).unwrap();
            let input = crate::workspace::snapshot_repository(&source).unwrap();
            crate::workspace::prepare(&source, &cwd, &input, &[]).unwrap();
            let mut command = execution_command(PiRole::Planner, &source, &cwd, &data, &session).unwrap();
            command.args(["--mode", "json", "--print", "--no-session", "--no-extensions", "--no-skills", "--extension"])
                .arg(&probe).arg("--session-dir").arg(&session)
                .env("GRAPHER_MODE", "planner").env("GRAPHER_EXECUTION_KIND", "graph")
                .env("GRAPHER_PLANNER_WRITE_TOOLS", "true")
                .env("GRAPHER_TEST_RUNTIME", &engine).env("EXPECTED_CWD", &cwd)
                .env("GRAPHER_ORIGINAL_ROOT", &source).env("GRAPHER_SOURCE_ALIAS", &source)
                .env("PI_CODING_AGENT_DIR", base.join("agent"))
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
            crate::process_control::configure_command(&mut command);
            let child = command.spawn().unwrap();
            let _tree = crate::process_control::track(&child).unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            assert_eq!(fs::read_to_string(cwd.join("planner-probe.txt")).unwrap(), "frontier");
            assert!(!source.join("planner-probe.txt").exists());
            assert_eq!(fs::read_to_string(cwd.join("planner-plan.md")).unwrap(), "planned: second\n");
            assert!(!source.join("planner-plan.md").exists());
        }
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    fn planner_switch_keeps_exact_slot_permissions_and_native_runtime_state() {
        let temp = tempfile::tempdir().unwrap();
        let base = host_path(&temp.path().canonicalize().unwrap());
        let source = base.join("source");
        let data = base.join("data");
        let session = data.join("session");
        for path in [&source, &session] { fs::create_dir_all(path).unwrap(); }
        crate::workspace::git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("business.txt"), "source").unwrap();
        let input = crate::workspace::snapshot_repository(&source).unwrap();
        let mut slots = Vec::new();
        for label in ["initial", "target", "denied"] {
            let path = base.join(".grapher-worktrees/run").join(label);
            crate::workspace::prepare(&source, &path, &input, &[]).unwrap();
            fs::write(path.join("business.txt"), label).unwrap();
            slots.push(path);
        }
        let state = crate::workspace_state::process_root(&slots[1]).unwrap();
        fs::write(state.join(".git-config/global"), "[user]\n\tname = target-state\n").unwrap();
        let targets = serde_json::json!({ "target": {
            "requestedNode": "target", "actualNode": "target", "executionId": "target-execution",
            "workspace": slots[1], "runtimeEnvironment": workspace_environment(&slots[1]).unwrap(),
        }});
        let runtime = prepared_runtime().unwrap();
        let probe = base.join("planner-switch.ts");
        fs::write(&probe, include_str!("../../scripts/planner-switch-launcher-probe.ts")).unwrap();
        let mut command = execution_command_scoped(PiRole::Planner, &source, &slots[0], &data, &session, &slots[1..2]).unwrap();
        command.args(["--mode", "json", "--print", "--no-session", "--no-extensions", "--no-skills", "--extension"])
            .arg(&probe).arg("--session-dir").arg(&session)
            .env("GRAPHER_MODE", "planner").env("GRAPHER_EXECUTION_KIND", "graph")
            .env("GRAPHER_ORIGINAL_ROOT", &source).env("GRAPHER_SOURCE_ALIAS", &source)
            .env("GRAPHER_PLANNER_FOLLOWUP", "true").env("GRAPHER_PLANNER_WRITE_TOOLS", "true")
            .env("GRAPHER_PLANNER_WORKSPACES", targets.to_string())
            .env("GRAPHER_TEST_RUNTIME", runtime).env("GRAPHER_TEST_DENIED", &slots[2]);
        command.env_remove("GRAPHER_PLANNER_WORKSPACES_FILE");
        let output = command.output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        // Pi redirects factory-time stdout to stderr until initialization ends.
        let log = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(log.contains("planner-switch-ok"), "{log}");
        assert_eq!(fs::read_to_string(slots[1].join("task.txt")).unwrap(), "selected target");
        assert!(!slots[0].join("task.txt").exists());
        assert_eq!(fs::read_to_string(state.join(".agent-home/planner-written")).unwrap(), "target-owned");
        assert!(!crate::workspace_state::process_root(&slots[0]).unwrap().join(".agent-home/planner-written").exists());
        assert!(execution_command_scoped(PiRole::NodeAgent, &source, &slots[0], &data, &session, &slots[1..2]).is_err());
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    fn graph_launcher_runs_parallel_native_tools_and_absolute_scripts() {
        let temp = tempfile::tempdir().unwrap();
        let base = host_path(&temp.path().canonicalize().unwrap());
        let source = base.join("source");
        let data = base.join("data"); // runtime state never belongs in the project
        let root = base.join(".grapher-worktrees");
        let a = root.join("run/a");
        let b = root.join("run/b");
        for path in [&source, &data, &a, &b] {
            fs::create_dir_all(path).unwrap();
        }
        // Linux also checks the source's (possibly external) Git common dir.
        crate::workspace::git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("source-marker"), "SOURCE").unwrap();
        let input = crate::workspace::snapshot_repository(&source).unwrap();
        for path in [&a, &b] { crate::workspace::prepare(&source, path, &input, &[]).unwrap(); }
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
            // The production profile already makes the Grapher installation
            // read-only (write-denied) on every platform boundary.
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
