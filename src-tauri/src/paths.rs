//! Bundled desktop resource discovery, executable validation, Git detection,
//! and cross-platform PATH construction.
use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
#[cfg(unix)]
use std::{
    io::Read,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedRuntimePaths {
    pub installation_root: PathBuf,
    pub backend_executable: PathBuf,
    pub bundled_node: Option<PathBuf>,
    pub trusted_git: Option<PathBuf>,
}

pub fn backend_binary_name() -> &'static str {
    if cfg!(windows) {
        "grapher.exe"
    } else {
        "grapher"
    }
}

pub fn bundled_node_relpath() -> &'static str {
    if cfg!(windows) {
        "node/node.exe"
    } else {
        "node/bin/node"
    }
}

/// Strip Windows verbatim `\\?\` prefixes so child tools (Git/Node/shells)
/// receive ordinary host paths.
pub fn host_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

pub fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.to_string_lossy().trim().is_empty())
        .map(PathBuf::from)
}

/// Infer the bundled resource directory directly from `current_exe` when
/// Tauri's `resource_dir()` is unavailable (for example, on macOS when the
/// `.app` is launched through a path containing a symlink ancestor like
/// `/var/folders/...` or `/tmp/...`).
fn infer_bundle_resource_dir(current_exe: Option<&Path>) -> Option<PathBuf> {
    let exe = current_exe?;
    let canonical_exe = exe.canonicalize().ok().unwrap_or_else(|| exe.to_path_buf());
    let exe_dir = canonical_exe.parent()?;

    // macOS `.app/Contents/MacOS/<exe>` -> `.app/Contents/Resources`
    if exe_dir.file_name() == Some(OsStr::new("MacOS")) {
        if let Some(contents) = exe_dir.parent() {
            let resources = contents.join("Resources");
            if resources.is_dir() {
                return Some(host_path(&resources));
            }
        }
    }

    // Windows NSIS / portable layouts co-locate `runtime/` and `node/` beside the executable.
    if exe_dir.join("runtime/engine/entrypoint.mjs").is_file() {
        return Some(host_path(exe_dir));
    }

    None
}

/// Resolve bundled production runtime paths first, with a development checkout
/// fallback when running unbundled (`debug_assertions` / `cargo run`).
pub fn resolve_runtime_paths(
    resource_dir: Option<&Path>,
    current_exe: Option<&Path>,
    dev_repo_root: Option<&Path>,
    require_bundled_node: bool,
) -> Result<ResolvedRuntimePaths, String> {
    resolve_runtime_paths_with_path(
        resource_dir,
        current_exe,
        dev_repo_root,
        require_bundled_node,
        None,
    )
}

/// Same as [`resolve_runtime_paths`], allowing callers to supply a resolved
/// desktop user `PATH` so host Git discovery sees user-installed toolchains
/// even when the GUI launcher started with a minimal environment.
pub fn resolve_runtime_paths_with_path(
    resource_dir: Option<&Path>,
    current_exe: Option<&Path>,
    dev_repo_root: Option<&Path>,
    require_bundled_node: bool,
    path_override: Option<&OsStr>,
) -> Result<ResolvedRuntimePaths, String> {
    let inferred_resource_dir = if resource_dir.is_none() {
        infer_bundle_resource_dir(current_exe)
    } else {
        None
    };
    let effective_resource_dir = resource_dir.or(inferred_resource_dir.as_deref());

    let runtime_root = effective_resource_dir
        .map(|dir| dir.join("runtime"))
        .filter(|dir| dir.join("engine/entrypoint.mjs").is_file());

    let installation_root = if let Some(root) = runtime_root {
        canonical_host_dir(&root)?
    } else if let Some(override_root) = non_empty_env_path("GRAPHER_INSTALLATION_ROOT")
        .or_else(|| non_empty_env_path("GRAPHER_INSTALLATION_DIR"))
    {
        if !override_root.join("engine/entrypoint.mjs").is_file() {
            return Err(format!(
                "Configured Grapher installation root does not contain engine/entrypoint.mjs: {}",
                override_root.display()
            ));
        }
        canonical_host_dir(&override_root)?
    } else if let Some(repo) = dev_repo_root.filter(|p| p.join("engine/entrypoint.mjs").is_file()) {
        canonical_host_dir(repo)?
    } else {
        return Err(format!(
            "Bundled Grapher runtime resources are missing (expected `runtime/engine/entrypoint.mjs` under {}). Reinstall Grapher or run `npm run desktop:stage`.",
            effective_resource_dir
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "<resource_dir>".into())
        ));
    };

    let backend_executable = resolve_backend_executable(
        &installation_root,
        effective_resource_dir,
        current_exe,
        dev_repo_root,
    )?;

    let bundled_node = resolve_bundled_node(effective_resource_dir, require_bundled_node)?;
    let trusted_git = discover_git_with_path(path_override);

    Ok(ResolvedRuntimePaths {
        installation_root,
        backend_executable,
        bundled_node,
        trusted_git,
    })
}

fn resolve_backend_executable(
    installation_root: &Path,
    resource_dir: Option<&Path>,
    current_exe: Option<&Path>,
    dev_repo_root: Option<&Path>,
) -> Result<PathBuf, String> {
    let name = backend_binary_name();
    let mut candidates = Vec::new();
    if let Some(explicit) = non_empty_env_path("GRAPHER_BACKEND_BIN") {
        candidates.push(explicit);
    }
    // Staged directly inside the relocatable runtime root (preferred).
    candidates.push(installation_root.join(name));
    // Also support sibling sidecar layout (e.g. Contents/MacOS/grapher or install_dir/grapher.exe).
    if let Some(exe_dir) = current_exe.and_then(Path::parent) {
        let sibling = exe_dir.join(name);
        if Some(sibling.as_path()) != current_exe {
            candidates.push(sibling);
        }
    }
    if let Some(res_dir) = resource_dir {
        candidates.push(res_dir.join("bin").join(name));
    }
    // Development checkout fallbacks when running `desktop:dev` without staged resources.
    if let Some(repo) = dev_repo_root {
        let target_base = non_empty_env_path("CARGO_TARGET_DIR")
            .unwrap_or_else(|| repo.join("backend").join("target"));
        candidates.push(target_base.join("debug").join(name));
        candidates.push(target_base.join("release").join(name));
    }

    for candidate in &candidates {
        if let Ok(valid) = validate_executable_file(candidate, "Grapher backend") {
            return Ok(valid);
        }
    }

    let searched = candidates
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "Grapher backend binary `{name}` was not found (searched: {searched})."
    ))
}

fn resolve_bundled_node(
    resource_dir: Option<&Path>,
    required: bool,
) -> Result<Option<PathBuf>, String> {
    if let Some(explicit) = non_empty_env_path("GRAPHER_TRUSTED_NODE")
        .or_else(|| non_empty_env_path("GRAPHER_NODE_PATH"))
    {
        return validate_executable_file(&explicit, "Node").map(Some);
    }

    if let Some(res_dir) = resource_dir {
        let staged = res_dir.join(bundled_node_relpath());
        if staged.exists() {
            return validate_executable_file(&staged, "bundled Node").map(Some);
        }
    }

    if required {
        return Err(format!(
            "Bundled Node.js runtime is missing (expected `{}` under {}). Reinstall Grapher or run `npm run desktop:stage`.",
            bundled_node_relpath(),
            resource_dir
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "<resource_dir>".into())
        ));
    }

    Ok(None)
}

fn canonical_host_dir(path: &Path) -> Result<PathBuf, String> {
    let canonical = path.canonicalize().map_err(|error| {
        format!(
            "Cannot resolve directory {}: {error}",
            path.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!("Expected a directory at {}", canonical.display()));
    }
    Ok(host_path(&canonical))
}

pub fn validate_executable_file(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "Configured {label} executable is unavailable ({}): {error}",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "Configured {label} executable is not a regular file: {}",
            path.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(format!(
                "Configured {label} executable is not executable: {}",
                path.display()
            ));
        }
    }
    let canonical = path.canonicalize().map_err(|error| {
        format!(
            "Cannot resolve {label} executable ({}): {error}",
            path.display()
        )
    })?;
    Ok(host_path(&canonical))
}

fn configure_probe_command(command: &mut Command) {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
}

#[cfg(target_os = "macos")]
fn macos_clt_installed() -> bool {
    let mut command = Command::new("/usr/bin/xcode-select");
    configure_probe_command(&mut command);
    command
        .arg("-p")
        .output()
        .is_ok_and(|output| output.status.success() && !output.stdout.is_empty())
}

pub fn verify_git_executable(candidate: &Path) -> Result<PathBuf, String> {
    let resolved = validate_executable_file(candidate, "Git")?;
    #[cfg(target_os = "macos")]
    if (candidate == Path::new("/usr/bin/git") || resolved == Path::new("/usr/bin/git"))
        && !macos_clt_installed()
    {
        return Err("macOS /usr/bin/git is an uninstalled Xcode Command Line Tools shim".into());
    }
    let mut command = Command::new(&resolved);
    configure_probe_command(&mut command);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command
        .arg("--version")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("Cannot execute Git at {}: {error}", resolved.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || !stdout.to_ascii_lowercase().contains("git version") {
        return Err(format!(
            "Git executable at {} failed `--version` verification",
            resolved.display()
        ));
    }
    Ok(resolved)
}

fn standard_git_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    {
        for path in [
            "/opt/homebrew/bin/git",
            "/usr/local/bin/git",
            "/usr/bin/git",
            "/Library/Developer/CommandLineTools/usr/bin/git",
        ] {
            candidates.push(PathBuf::from(path));
        }
    }
    #[cfg(windows)]
    {
        for (env_var, suffix) in [
            ("ProgramFiles", r"Git\cmd\git.exe"),
            ("ProgramFiles(x86)", r"Git\cmd\git.exe"),
            ("LOCALAPPDATA", r"Programs\Git\cmd\git.exe"),
        ] {
            if let Some(base) = non_empty_env_path(env_var) {
                candidates.push(base.join(suffix));
            }
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        for path in ["/usr/bin/git", "/usr/local/bin/git"] {
            candidates.push(PathBuf::from(path));
        }
    }
    candidates
}

/// Discover a verified host Git binary from `GRAPHER_TRUSTED_GIT`, inherited
/// `PATH`, and platform standard locations. Returns `None` when absent so the
/// desktop shell can still start and surface actionable diagnostics.
pub fn discover_git() -> Option<PathBuf> {
    discover_git_with_path(None)
}

pub fn discover_git_with_path(path_override: Option<&OsStr>) -> Option<PathBuf> {
    if let Some(override_path) = non_empty_env_path("GRAPHER_TRUSTED_GIT") {
        return verify_git_executable(&override_path).ok();
    }
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    let mut candidates = Vec::new();
    let inherited_path = std::env::var_os("PATH");
    if let Some(path_var) = path_override.or(inherited_path.as_deref()) {
        for dir in std::env::split_paths(path_var) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            let candidate = dir.join(name);
            if !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }
    }
    for candidate in standard_git_candidates() {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
        .into_iter()
        .filter(|candidate| candidate.is_file())
        .find_map(|candidate| verify_git_executable(&candidate).ok())
}

/// Return the single PATH environment key casing currently present (`Path` vs
/// `PATH` on Windows) so child processes never receive duplicate PATH entries.
pub fn path_env_key() -> OsString {
    std::env::vars_os()
        .map(|(k, _)| k)
        .find(|key| key.to_string_lossy().eq_ignore_ascii_case("PATH"))
        .unwrap_or_else(|| OsString::from("PATH"))
}

/// Append `fallback_dirs` after `base_path` without duplicating directories.
/// Keeps the user's own tool search order ahead of bundled fallback binaries
/// (for example bundled `node` without `npm`) so tools stay consistent.
pub fn build_fallback_path(
    base_path: Option<&OsStr>,
    fallback_dirs: &[PathBuf],
) -> Result<OsString, String> {
    let mut entries: Vec<PathBuf> = Vec::new();
    if let Some(base) = base_path {
        push_unique_path_entries(&mut entries, base);
    }
    for dir in fallback_dirs {
        push_unique_path_entry(&mut entries, dir.clone());
    }
    std::env::join_paths(entries).map_err(|error| format!("Cannot build child PATH: {error}"))
}

fn contains_nul_byte(value: &OsStr) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        value.as_bytes().contains(&0)
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        value.encode_wide().any(|unit| unit == 0)
    }
    #[cfg(not(any(unix, windows)))]
    {
        value.to_string_lossy().contains('\0')
    }
}

fn push_unique_path_entry(entries: &mut Vec<PathBuf>, dir: PathBuf) {
    if dir.as_os_str().is_empty() || contains_nul_byte(dir.as_os_str()) {
        return;
    }
    // Reject single malformed entries (e.g. a stray `"` in Windows registry Path)
    // instead of letting `join_paths` fail and break sidecar startup.
    if std::env::join_paths(std::iter::once(&dir)).is_err() {
        return;
    }
    if !entries
        .iter()
        .any(|existing| same_path_entry(existing, &dir))
    {
        entries.push(dir);
    }
}

fn push_unique_path_entries(entries: &mut Vec<PathBuf>, raw: &OsStr) {
    for dir in std::env::split_paths(raw) {
        push_unique_path_entry(entries, dir);
    }
}

#[cfg(unix)]
fn trim_trailing_unix_slashes(path: &Path) -> &[u8] {
    use std::os::unix::ffi::OsStrExt;
    let bytes = path.as_os_str().as_bytes();
    let mut end = bytes.len();
    while end > 1 && bytes[end - 1] == b'/' {
        end -= 1;
    }
    &bytes[..end]
}

fn same_path_entry(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        trim_trailing_unix_slashes(a) == trim_trailing_unix_slashes(b)
    }
    #[cfg(not(unix))]
    {
        let a = trim_trailing_separators(a);
        let b = trim_trailing_separators(b);
        if cfg!(windows) {
            a.eq_ignore_ascii_case(&b)
        } else {
            a == b
        }
    }
}

#[cfg(not(unix))]
fn trim_trailing_separators(path: &Path) -> String {
    let text = path.to_string_lossy();
    let trimmed = if cfg!(windows) {
        let stripped = text.trim_end_matches(['\\', '/']);
        if stripped.len() == 2 && stripped.ends_with(':') {
            return format!("{stripped}\\");
        }
        if stripped.is_empty() && (text.starts_with('\\') || text.starts_with('/')) {
            return "\\".into();
        }
        stripped
    } else {
        let stripped = text.trim_end_matches('/');
        if stripped.is_empty() && text.starts_with('/') {
            return "/".into();
        }
        stripped
    };
    trimmed.to_string()
}

fn is_unix_default_system_path_entry(path: &Path) -> bool {
    #[cfg(unix)]
    {
        matches!(
            trim_trailing_unix_slashes(path),
            b"/usr/bin" | b"/bin" | b"/usr/sbin" | b"/sbin"
        )
    }
    #[cfg(not(unix))]
    {
        matches!(
            trim_trailing_separators(path).as_str(),
            "/usr/bin" | "/bin" | "/usr/sbin" | "/sbin"
        )
    }
}

/// Merge a Unix login shell `PATH` with the current process `PATH`.
///
/// GUI launchers on macOS/Linux pass a minimal system `PATH` such as
/// `/usr/bin:/bin:/usr/sbin:/sbin`. Placing `shell_path` ahead of those
/// default system directories restores user toolchain precedence (Homebrew,
/// Node, Cargo, etc.) while still preserving any custom directories explicitly
/// prepended before `/usr/bin` (for example from a terminal or active venv).
pub fn merge_unix_shell_path(
    existing_path: Option<&OsStr>,
    shell_path: Option<&OsStr>,
) -> Option<OsString> {
    let Some(shell) = shell_path.filter(|value| !value.is_empty()) else {
        return existing_path.map(OsStr::to_os_string);
    };

    let mut entries: Vec<PathBuf> = Vec::new();
    let mut existing_entries: Vec<PathBuf> = Vec::new();
    if let Some(existing) = existing_path {
        for dir in std::env::split_paths(existing) {
            if !dir.as_os_str().is_empty() {
                existing_entries.push(dir);
            }
        }
    }

    for dir in &existing_entries {
        if is_unix_default_system_path_entry(dir) {
            break;
        }
        push_unique_path_entry(&mut entries, dir.clone());
    }
    push_unique_path_entries(&mut entries, shell);
    for dir in existing_entries {
        push_unique_path_entry(&mut entries, dir);
    }

    if entries.is_empty() {
        existing_path.map(OsStr::to_os_string)
    } else {
        std::env::join_paths(entries).ok()
    }
}

/// Merge the current Windows process `PATH` with freshly read Machine and User
/// registry `Path` values (already expanded). Preserves any explicit CLI/session
/// prefixes while ensuring GUI / autostart launches pick up newly installed
/// toolchains (Node, Rust/Cargo, Git, etc.).
pub fn merge_windows_registry_paths(
    existing_path: Option<&OsStr>,
    machine_path: Option<&OsStr>,
    user_path: Option<&OsStr>,
) -> Option<OsString> {
    let mut entries: Vec<PathBuf> = Vec::new();
    if let Some(existing) = existing_path {
        push_unique_path_entries(&mut entries, existing);
    }
    if let Some(machine) = machine_path {
        push_unique_path_entries(&mut entries, machine);
    }
    if let Some(user) = user_path {
        push_unique_path_entries(&mut entries, user);
    }
    if entries.is_empty() {
        None
    } else {
        std::env::join_paths(entries).ok()
    }
}

/// Extract the payload between the last pair of `start_marker` and `end_marker`
/// in shell probe stdout, ignoring any login banner or rc chatter around it.
pub fn parse_marked_shell_path(
    output: &[u8],
    start_marker: &str,
    end_marker: &str,
) -> Option<OsString> {
    let start_bytes = start_marker.as_bytes();
    let end_bytes = end_marker.as_bytes();
    if start_bytes.is_empty() || end_bytes.is_empty() {
        return None;
    }
    let end_idx = output
        .windows(end_bytes.len())
        .rposition(|window| window == end_bytes)?;
    let prefix = &output[..end_idx];
    let start_idx = prefix
        .windows(start_bytes.len())
        .rposition(|window| window == start_bytes)?;
    let mut payload = &prefix[start_idx + start_bytes.len()..];
    while let Some(&last) = payload.last() {
        if last == b'\n' || last == b'\r' {
            payload = &payload[..payload.len() - 1];
        } else {
            break;
        }
    }
    if payload.is_empty() || payload.contains(&0) {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Some(OsStr::from_bytes(payload).to_os_string())
    }
    #[cfg(not(unix))]
    {
        std::str::from_utf8(payload).ok().map(OsString::from)
    }
}

/// Resolve the desktop user's full `PATH` once during desktop startup so GUI
/// launches on macOS, Linux, and Windows expose user-installed toolchains
/// (`node`, `npm`, `cargo`, `git`, `rg`, etc.) to the backend and agents.
pub fn resolve_desktop_user_path() -> Option<OsString> {
    let key = path_env_key();
    let existing = std::env::var_os(&key);

    #[cfg(unix)]
    {
        let shell_path = probe_user_unix_shell_path();
        merge_unix_shell_path(existing.as_deref(), shell_path.as_deref())
    }
    #[cfg(windows)]
    {
        let machine = read_windows_registry_path(
            windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        );
        let user = read_windows_registry_path(
            windows_sys::Win32::System::Registry::HKEY_CURRENT_USER,
            "Environment",
        );
        merge_windows_registry_paths(
            existing.as_deref(),
            machine.as_deref(),
            user.as_deref(),
        )
    }
    #[cfg(not(any(unix, windows)))]
    {
        existing
    }
}

#[cfg(unix)]
const SHELL_PATH_START_MARKER: &str = "__GRAPHER_SHELL_PATH_START__";
#[cfg(unix)]
const SHELL_PATH_END_MARKER: &str = "__GRAPHER_SHELL_PATH_END__";
#[cfg(unix)]
const MAX_SHELL_PROBE_OUTPUT_BYTES: u64 = 1024 * 1024;

#[cfg(unix)]
fn is_supported_unix_probe_shell(path: &Path) -> bool {
    path.file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                "zsh" | "bash" | "sh" | "ksh" | "mksh" | "dash" | "ash" | "fish"
            )
        })
}

#[cfg(unix)]
fn select_unix_login_shell() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(shell) = non_empty_env_path("SHELL") {
        if shell.is_absolute() && is_supported_unix_probe_shell(&shell) {
            candidates.push(shell);
        }
    }
    for fallback in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        let candidate = PathBuf::from(fallback);
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
        .into_iter()
        .find(|candidate| validate_executable_file(candidate, "login shell").is_ok())
}

#[cfg(unix)]
fn probe_user_unix_shell_path() -> Option<OsString> {
    let shell = select_unix_login_shell()?;
    let is_fish = shell
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.eq_ignore_ascii_case("fish"));
    let script = if is_fish {
        format!(
            "printf '{SHELL_PATH_START_MARKER}%s{SHELL_PATH_END_MARKER}' (string join : $PATH)"
        )
    } else {
        format!(
            "printf '{SHELL_PATH_START_MARKER}%s{SHELL_PATH_END_MARKER}' \"$PATH\""
        )
    };
    // Try interactive login shell first so entries configured in ~/.zshrc or
    // ~/.bashrc (Homebrew, nvm, fnm, cargo) are captured; fall back to a
    // non-interactive login shell if interactive rc startup stalls or fails.
    probe_unix_shell_path(&shell, &["-i", "-l", "-c", &script], Duration::from_millis(2500))
        .or_else(|| {
            probe_unix_shell_path(&shell, &["-l", "-c", &script], Duration::from_millis(1500))
        })
}

#[cfg(unix)]
fn probe_unix_shell_path(shell: &Path, args: &[&str], timeout: Duration) -> Option<OsString> {
    use std::os::unix::process::CommandExt;

    let mut command = Command::new(shell);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("TERM", "dumb")
        .env("NO_COLOR", "1");
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.take(MAX_SHELL_PROBE_OUTPUT_BYTES).read_to_end(&mut buf);
        let _ = tx.send(buf);
    });

    let kill_child_group = |child: &mut std::process::Child| {
        if let Ok(pid) = libc::pid_t::try_from(child.id()) {
            if pid > 0 {
                unsafe {
                    let _ = libc::kill(-pid, libc::SIGKILL);
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    };

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    kill_child_group(&mut child);
                    break None;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                kill_child_group(&mut child);
                break None;
            }
        }
    };

    if !status.is_some_and(|exit| exit.success()) {
        return None;
    }
    // Bound stdout drain so a detached grandchild holding stdout open cannot hang startup.
    let bytes = rx.recv_timeout(Duration::from_millis(250)).ok()?;
    parse_marked_shell_path(&bytes, SHELL_PATH_START_MARKER, SHELL_PATH_END_MARKER)
}

#[cfg(windows)]
fn read_windows_registry_path(
    root: windows_sys::Win32::System::Registry::HKEY,
    subkey: &str,
) -> Option<OsString> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Registry::{
            RegGetValueW, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
        },
    };

    let subkey_wide: Vec<u16> = OsStr::new(subkey)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let value_wide: Vec<u16> = OsStr::new("Path")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;

    let mut byte_len: u32 = 0;
    let query_status = unsafe {
        RegGetValueW(
            root,
            subkey_wide.as_ptr(),
            value_wide.as_ptr(),
            flags,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut byte_len,
        )
    };
    if query_status != ERROR_SUCCESS || byte_len == 0 {
        return None;
    }

    let mut buf = vec![0u16; (byte_len as usize).div_ceil(2)];
    let mut actual_len = u32::try_from(buf.len() * 2).ok()?;
    let read_status = unsafe {
        RegGetValueW(
            root,
            subkey_wide.as_ptr(),
            value_wide.as_ptr(),
            flags,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast::<std::ffi::c_void>(),
            &mut actual_len,
        )
    };
    if read_status != ERROR_SUCCESS {
        return None;
    }

    let mut len = ((actual_len as usize) / 2).min(buf.len());
    while len > 0 && buf[len - 1] == 0 {
        len -= 1;
    }
    if len == 0 {
        return None;
    }
    let raw = OsString::from_wide(&buf[..len]);
    Some(expand_windows_env_strings(&raw))
}

#[cfg(windows)]
fn expand_windows_env_strings(raw: &OsStr) -> OsString {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;

    let wide: Vec<u16> = raw.encode_wide().chain(std::iter::once(0)).collect();
    let required = unsafe { ExpandEnvironmentStringsW(wide.as_ptr(), std::ptr::null_mut(), 0) };
    if required == 0 {
        return raw.to_os_string();
    }
    let mut buf = vec![0u16; required as usize];
    let written =
        unsafe { ExpandEnvironmentStringsW(wide.as_ptr(), buf.as_mut_ptr(), required) };
    if written == 0 || written > required {
        return raw.to_os_string();
    }
    let mut len = (written as usize).saturating_sub(1);
    while len > 0 && buf[len - 1] == 0 {
        len -= 1;
    }
    OsString::from_wide(&buf[..len])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_runtime_paths_uses_staged_resources_and_bundled_node() {
        let temp = tempfile::tempdir().unwrap();
        let res = temp.path().join("Resources");
        let runtime = res.join("runtime");
        fs::create_dir_all(runtime.join("engine")).unwrap();
        fs::write(runtime.join("engine/entrypoint.mjs"), "// entry").unwrap();

        let backend = runtime.join(backend_binary_name());
        fs::write(&backend, b"stub-backend").unwrap();
        let node = res.join(bundled_node_relpath());
        fs::create_dir_all(node.parent().unwrap()).unwrap();
        fs::write(&node, b"stub-node").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&backend, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let resolved = resolve_runtime_paths(Some(&res), None, None, true).unwrap();
        assert_eq!(resolved.installation_root, canonical_host_dir(&runtime).unwrap());
        assert_eq!(
            resolved.backend_executable,
            host_path(&backend.canonicalize().unwrap())
        );
        assert_eq!(
            resolved.bundled_node.unwrap(),
            host_path(&node.canonicalize().unwrap())
        );
    }

    #[test]
    fn resolve_runtime_paths_errors_when_required_bundled_node_missing() {
        let temp = tempfile::tempdir().unwrap();
        let res = temp.path().join("Resources");
        let runtime = res.join("runtime");
        fs::create_dir_all(runtime.join("engine")).unwrap();
        fs::write(runtime.join("engine/entrypoint.mjs"), "// entry").unwrap();
        let backend = runtime.join(backend_binary_name());
        fs::write(&backend, b"stub-backend").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&backend, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let err = resolve_runtime_paths(Some(&res), None, None, true).unwrap_err();
        assert!(err.contains("Bundled Node.js runtime is missing"), "{err}");
    }

    #[test]
    fn resolve_runtime_paths_infers_macos_app_resources_when_resource_dir_is_none() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("Relocated/Grapher.app");
        let macos_exe = app.join("Contents/MacOS/grapher-desktop");
        let res = app.join("Contents/Resources");
        let runtime = res.join("runtime");
        fs::create_dir_all(macos_exe.parent().unwrap()).unwrap();
        fs::write(&macos_exe, b"stub-app").unwrap();
        fs::create_dir_all(runtime.join("engine")).unwrap();
        fs::write(runtime.join("engine/entrypoint.mjs"), "// entry").unwrap();
        let backend = runtime.join(backend_binary_name());
        fs::write(&backend, b"stub-backend").unwrap();
        let node = res.join(bundled_node_relpath());
        fs::create_dir_all(node.parent().unwrap()).unwrap();
        fs::write(&node, b"stub-node").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&macos_exe, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&backend, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let resolved = resolve_runtime_paths(None, Some(&macos_exe), None, true).unwrap();
        assert_eq!(resolved.installation_root, canonical_host_dir(&runtime).unwrap());
        assert_eq!(
            resolved.backend_executable,
            host_path(&backend.canonicalize().unwrap())
        );
        assert_eq!(
            resolved.bundled_node.unwrap(),
            host_path(&node.canonicalize().unwrap())
        );
    }

    #[test]
    fn build_fallback_path_keeps_user_bins_first_and_appends_bundled_fallbacks_without_duplicates() {
        let node_dir = PathBuf::from("/app/node/bin");
        let git_dir = PathBuf::from("/opt/homebrew/bin");
        let existing = std::env::join_paths([&git_dir, &PathBuf::from("/usr/bin")]).unwrap();
        let combined =
            build_fallback_path(Some(&existing), &[node_dir.clone(), git_dir.clone()]).unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&combined).collect();
        assert_eq!(parts, vec![git_dir, PathBuf::from("/usr/bin"), node_dir]);
    }

    #[test]
    fn merge_unix_shell_path_restores_homebrew_precedence_for_gui_launches() {
        let gui_existing = std::env::join_paths([
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
        ])
        .unwrap();
        let shell = std::env::join_paths([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/Users/test/.cargo/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ])
        .unwrap();

        let merged = merge_unix_shell_path(Some(&gui_existing), Some(&shell)).unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&merged).collect();
        assert_eq!(
            parts,
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/Users/test/.cargo/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin"),
                PathBuf::from("/usr/sbin"),
                PathBuf::from("/sbin"),
            ]
        );
    }

    #[test]
    fn merge_unix_shell_path_preserves_explicit_cli_prefix_before_shell_entries() {
        let cli_existing = std::env::join_paths([
            PathBuf::from("/project/.venv/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/custom/tail"),
        ])
        .unwrap();
        let shell = std::env::join_paths([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/bin"),
        ])
        .unwrap();

        let merged = merge_unix_shell_path(Some(&cli_existing), Some(&shell)).unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&merged).collect();
        assert_eq!(
            parts,
            vec![
                PathBuf::from("/project/.venv/bin"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/custom/tail"),
            ]
        );
    }

    #[test]
    fn merge_windows_registry_paths_preserves_existing_and_appends_fresh_machine_and_user_bins() {
        let venv = PathBuf::from(if cfg!(windows) {
            r"C:\project\.venv\Scripts"
        } else {
            "/project/.venv/Scripts"
        });
        let sys = PathBuf::from(if cfg!(windows) {
            r"C:\Windows\System32"
        } else {
            "/Windows/System32"
        });
        let nodejs = PathBuf::from(if cfg!(windows) {
            r"C:\Program Files\nodejs"
        } else {
            "/Program Files/nodejs"
        });
        let cargo = PathBuf::from(if cfg!(windows) {
            r"C:\Users\dev\.cargo\bin"
        } else {
            "/Users/dev/.cargo/bin"
        });
        let existing = std::env::join_paths([&venv, &sys]).unwrap();
        let machine = std::env::join_paths([&sys, &nodejs]).unwrap();
        let user = std::env::join_paths([&cargo, &nodejs]).unwrap();

        let merged =
            merge_windows_registry_paths(Some(&existing), Some(&machine), Some(&user)).unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&merged).collect();
        assert_eq!(parts, vec![venv, sys, nodejs, cargo]);
    }

    #[test]
    fn parse_marked_shell_path_ignores_chatter_and_uses_last_marker_pair() {
        let output = b"welcome banner\n__GRAPHER_SHELL_PATH_START__/stale__GRAPHER_SHELL_PATH_END__\nnoise\n__GRAPHER_SHELL_PATH_START__/opt/homebrew/bin:/usr/bin\n__GRAPHER_SHELL_PATH_END__\nbye\n";
        let parsed = parse_marked_shell_path(
            output,
            "__GRAPHER_SHELL_PATH_START__",
            "__GRAPHER_SHELL_PATH_END__",
        )
        .unwrap();
        assert_eq!(parsed, OsString::from("/opt/homebrew/bin:/usr/bin"));

        assert!(parse_marked_shell_path(
            b"no markers here",
            "__GRAPHER_SHELL_PATH_START__",
            "__GRAPHER_SHELL_PATH_END__",
        )
        .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn probe_unix_shell_path_captures_output_and_enforces_timeout() {
        let script = format!(
            "echo noisy startup; printf '{SHELL_PATH_START_MARKER}%s{SHELL_PATH_END_MARKER}' '/custom/bin:/usr/bin'"
        );
        let parsed = probe_unix_shell_path(
            Path::new("/bin/sh"),
            &["-c", &script],
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(parsed, OsString::from("/custom/bin:/usr/bin"));

        let timed_out = probe_unix_shell_path(
            Path::new("/bin/sh"),
            &["-c", "sleep 5"],
            Duration::from_millis(120),
        );
        assert!(timed_out.is_none());

        assert!(is_supported_unix_probe_shell(Path::new("/bin/zsh")));
        assert!(is_supported_unix_probe_shell(Path::new("/opt/homebrew/bin/fish")));
        assert!(!is_supported_unix_probe_shell(Path::new("/opt/homebrew/bin/nu")));
        assert!(!is_supported_unix_probe_shell(Path::new("/bin/tcsh")));
    }

    #[test]
    fn build_fallback_path_skips_malformed_entries_instead_of_failing() {
        let good = PathBuf::from("/usr/bin");
        let fallback = PathBuf::from("/app/node/bin");
        let bad = PathBuf::from(if cfg!(windows) {
            r#"C:\bad"entry"#
        } else {
            "/bad:entry"
        });
        let combined = build_fallback_path(Some(good.as_os_str()), &[bad, fallback.clone()])
            .unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&combined).collect();
        assert_eq!(parts, vec![good, fallback]);
    }

    #[test]
    fn parse_marked_shell_path_handles_empty_markers_and_rejects_nul_bytes() {
        assert!(parse_marked_shell_path(b"abc", "", "END").is_none());
        assert!(parse_marked_shell_path(b"abc", "START", "").is_none());
        assert!(parse_marked_shell_path(
            b"__S__/usr/bin\0/bad__E__",
            "__S__",
            "__E__",
        )
        .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn build_fallback_path_preserves_distinct_non_utf8_paths_and_rejects_nul() {
        use std::os::unix::ffi::OsStrExt;
        let path_a = PathBuf::from(OsStr::from_bytes(b"/opt/dir-\xfe/bin"));
        let path_b = PathBuf::from(OsStr::from_bytes(b"/opt/dir-\xff/bin"));
        let path_a_slash = PathBuf::from(OsStr::from_bytes(b"/opt/dir-\xfe/bin/"));
        let path_nul = PathBuf::from(OsStr::from_bytes(b"/opt/bad\0/bin"));

        let combined = build_fallback_path(
            None,
            &[path_a.clone(), path_b.clone(), path_a_slash, path_nul],
        )
        .unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&combined).collect();
        assert_eq!(parts, vec![path_a, path_b]);
    }
}
