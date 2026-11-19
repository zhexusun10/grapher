//! Bundled desktop resource discovery, executable validation, Git detection,
//! and cross-platform PATH construction.
use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
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
    let trusted_git = discover_git();

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
    if let Some(override_path) = non_empty_env_path("GRAPHER_TRUSTED_GIT") {
        return verify_git_executable(&override_path).ok();
    }
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    let mut candidates = Vec::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
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

/// Prepend `prepend_dirs` to `existing_path` without duplicating directories.
pub fn build_prepended_path(
    prepend_dirs: &[PathBuf],
    existing_path: Option<&OsStr>,
) -> Result<OsString, String> {
    let mut entries: Vec<PathBuf> = Vec::new();
    for dir in prepend_dirs {
        if !dir.as_os_str().is_empty() && !entries.iter().any(|existing| same_path_entry(existing, dir)) {
            entries.push(dir.clone());
        }
    }
    if let Some(existing) = existing_path {
        for dir in std::env::split_paths(existing) {
            if !dir.as_os_str().is_empty() && !entries.iter().any(|item| same_path_entry(item, &dir)) {
                entries.push(dir);
            }
        }
    }
    std::env::join_paths(entries).map_err(|error| format!("Cannot build child PATH: {error}"))
}

fn same_path_entry(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
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
    fn build_prepended_path_orders_private_bins_first_without_duplicates() {
        let node_dir = PathBuf::from("/app/node/bin");
        let git_dir = PathBuf::from("/opt/homebrew/bin");
        let existing = std::env::join_paths([&git_dir, &PathBuf::from("/usr/bin")]).unwrap();
        let combined = build_prepended_path(&[node_dir.clone(), git_dir.clone()], Some(&existing))
            .unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&combined).collect();
        assert_eq!(parts, vec![node_dir, git_dir, PathBuf::from("/usr/bin")]);
    }
}
