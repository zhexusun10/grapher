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

fn host_ref_lock(repository: &Path) -> Result<Arc<Mutex<()>>, String> {
    let mut locks = HOST_REF_LOCKS
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    locks.retain(|_, weak| weak.strong_count() > 0);
    if let Some(lock) = locks.get(repository).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(repository.to_path_buf(), Arc::downgrade(&lock));
    Ok(lock)
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
    let path = std::env::var_os("GRAPHER_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::native::installation_root().join(".grapher"));
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
    }.unwrap_or_else(std::env::temp_dir);
    match platform {
        "windows" => env("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData/Local")).join("Grapher"),
        "macos" => home.join("Library/Caches/Grapher"),
        _ => env("XDG_CACHE_HOME").unwrap_or_else(|| home.join(".cache")).join("grapher"),
    }
}

fn absolute_path(path: PathBuf) -> PathBuf {
    if path.is_relative() {
        std::env::current_dir().map(|cwd| cwd.join(&path)).unwrap_or(path)
    } else { path }
}

fn absolute_cache_path(path: PathBuf) -> PathBuf {
    let path = absolute_path(path);
    path.canonicalize().unwrap_or(path)
}

pub fn cache_root() -> PathBuf {
    absolute_cache_path(std::env::var_os("GRAPHER_CACHE_DIR").map(PathBuf::from).unwrap_or_else(|| {
        default_cache_root(std::env::consts::OS, |name| std::env::var_os(name).map(PathBuf::from))
    }))
}

pub(crate) fn native_runtime_parent() -> PathBuf {
    // Keep the leaf spelling so storage can reject a linked/redirected parent.
    absolute_path(std::env::var_os("GRAPHER_NATIVE_RUNTIME_PARENT").map(PathBuf::from)
        .unwrap_or_else(|| cache_root().join("workspaces/.grapher-workspaces")))
}

pub(crate) fn workspaces_parent(data: &Path) -> PathBuf {
    absolute_cache_path(std::env::var_os("GRAPHER_WORKSPACE_PARENT").map(PathBuf::from).unwrap_or_else(|| {
        // Fixture/unit-test checkouts are disposable with their test data. Real
        // execution must stay outside both source and protected session data.
        if cfg!(any(test, feature = "fixture")) {
            data.join("workspaces")
        } else {
            cache_root().join("workspaces")
        }
    }))
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
        assert_eq!(default_cache_root("windows", |name| (name == "USERPROFILE").then(|| profile.clone())),
            profile.join("AppData/Local/Grapher"));
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
        assert_eq!(default_cache_root("macos", env), home.join("Library/Caches/Grapher"));
        assert_eq!(default_cache_root("linux", env), xdg.join("grapher"));
        assert_eq!(default_cache_root("linux", |name| (name == "HOME").then(|| home.clone())), home.join(".cache/grapher"));
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
            if c1 == c2 {
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
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        return value.strip_prefix(r"\\?\").unwrap_or(&value).to_string();
    }
    #[cfg(not(windows))]
    path.to_string_lossy().to_string()
}

pub fn shadow_repo_dir(target: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_workspace_path(target)?;
    let mut hasher = DefaultHasher::new();
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
        assert!(checked_shadow_directory(&linked).unwrap_err().contains("symlink"));
        let file = temp.path().join("file");
        fs::write(&file, "not a directory").unwrap();
        assert!(checked_shadow_directory(&file).unwrap_err().contains("not a directory"));
        let real = temp.path().join("real-shadow.git");
        fs::create_dir(&real).unwrap();
        assert!(checked_shadow_directory(&real).unwrap());
    }
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

pub fn ensure_shadow_repo(target: &Path) -> Result<PathBuf, String> {
    let canonical_target = canonical_workspace_path(target)?;
    let shadow_dir = shadow_repo_dir(&canonical_target)?;
    let shadow_parent = data_root().join("shadow_repos");
    if !checked_shadow_directory(&shadow_parent)? {
        fs::create_dir_all(&shadow_parent).map_err(|e| e.to_string())?;
        checked_shadow_directory(&shadow_parent)?;
    }
    let initialize = !checked_shadow_directory(&shadow_dir)?;
    if initialize {
        fs::create_dir_all(&shadow_dir).map_err(|e| e.to_string())?;
        checked_shadow_directory(&shadow_dir)?;
        let git_dir_str = shadow_dir.to_str().ok_or("Invalid shadow path")?;
        let work_tree_str = canonical_target.to_str().ok_or("Invalid target path")?;

        git(
            &canonical_target,
            &[
                "--git-dir",
                git_dir_str,
                "--work-tree",
                work_tree_str,
                "init",
            ],
        )?;
        let _ = git(
            &canonical_target,
            &[
                "--git-dir",
                git_dir_str,
                "--work-tree",
                work_tree_str,
                "add",
                "-A",
            ],
        );
        let _ = git(
            &canonical_target,
            &[
                "--git-dir",
                git_dir_str,
                "--work-tree",
                work_tree_str,
                "commit",
                "--allow-empty",
                "-m",
                "Initial shadow snapshot by Grapher",
            ],
        );
    }
    if !checked_shadow_directory(&shadow_dir)? {

        return Err(format!("Shadow repository is missing: {}", shadow_dir.display()));
    }
    Ok(shadow_dir)
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

        if let Ok(out) = output {
            if out.status.success() {
                let path_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !path_str.is_empty() {
                    return Ok(Some(PathBuf::from(path_str)));
                } else {
                    return Ok(None);
                }
            }
        }
        Ok(None)
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
        if let Some(folder) = pick_folder()? {
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
        } else {
            Ok(PickResult {
                supported: true,
                repository: None,
                cancelled: true,
            })
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
        let status = git(&top_level, &["status", "--porcelain"]).unwrap_or_default();
        let clean = status.trim().is_empty();

        Ok(Some(RepositoryInfo {
            path: path_str,
            name,
            branch,
            head,
            clean,
            is_shadow: false,
        }))
    } else if candidate.is_dir() {
        let shadow = ensure_shadow_repo(&candidate)?;
        let git_dir_str = shadow.to_str().ok_or("Invalid shadow path")?;
        let canonical = canonical_workspace_path(&candidate)?;
        let path_str = normalize_workspace_display_path(&canonical);
        let name = candidate
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path_str.clone());
        let head = git(
            &candidate,
            &["--git-dir", git_dir_str, "rev-parse", "--short", "HEAD"],
        )
        .unwrap_or_default();

        Ok(Some(RepositoryInfo {
            path: path_str,
            name,
            branch: "shadow".into(),
            head,
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
    ) && repo.workdir().and_then(|dir| dir.canonicalize().ok()) != cwd.canonicalize().ok()
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

pub fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    if let Some(result) = git_read(cwd, args) {
        return result;
    }
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
    crate::native::clear_git_environment(&mut command);
    #[cfg(windows)]
    command.args(["-c", "core.longpaths=true"]);
    let output = command
        .args([
            "-c",
            hooks_config.as_str(),
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Grapher",
            "-c",
            "user.email=runtime@grapher.local",
        ])
        .args(cli_args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!(
                "git failed with exit code {:?} in {:?}: git {:?}",
                output.status.code(),
                cwd,
                args
            )
        };
        return Err(msg);
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}

/// Guard a shadow checkout against edits outside this run without creating a
/// fresh snapshot or moving its approval base.
pub fn check_shadow_source(repository: &Path, expected_head: &str) -> Result<(), String> {
    let head = repository_git(repository, &["rev-parse", "HEAD"])?;
    let status = repository_git(repository, &["status", "--porcelain"])?;
    if head != expected_head || !status.is_empty() {
        return Err("Shadow workspace changed after approval; restore the approved files or start a new run".into());
    }
    Ok(())
}

/// Run Git against either a normal checkout or the existing external shadow
/// repository. Publication must never create/rebaseline a shadow repository.
pub fn repository_git(repository: &Path, args: &[&str]) -> Result<String, String> {
    let repository = repository.canonicalize().map_err(|e| e.to_string())?;
    if is_standard_git(&repository) {
        return git(&repository, args);
    }
    let shadow = shadow_repo_dir(&repository)?;
    if !checked_shadow_directory(&shadow)? {
        return Err(
            "Shadow repository is missing; retained node results have not been published".into(),
        );
    }
    let mut command = vec![
        "--git-dir",
        shadow.to_str().ok_or("Invalid shadow path")?,
        "--work-tree",
        repository.to_str().ok_or("Invalid repository path")?,
    ];
    command.extend_from_slice(args);
    git(&repository, &command)
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

        git(repository, &["rev-parse", "--verify", "HEAD"])
    } else {
        if !repository.is_dir() {
            return Err(format!(
                "Directory does not exist: {}",
                repository.display()
            ));
        }
        let canonical = canonical_workspace_path(repository)?;
        let shadow = ensure_shadow_repo(&canonical)?;
        let git_dir_str = shadow.to_str().ok_or("Invalid shadow path")?;
        let work_tree_str = canonical.to_str().ok_or("Invalid target path")?;

        let _ = git(
            &canonical,
            &[
                "--git-dir",
                git_dir_str,
                "--work-tree",
                work_tree_str,
                "add",
                "-A",
            ],
        );
        let status = git(
            &canonical,
            &[
                "--git-dir",
                git_dir_str,
                "--work-tree",
                work_tree_str,
                "status",
                "--porcelain",
            ],
        )?;
        if !status.trim().is_empty() {
            let _ = git(
                &canonical,
                &[
                    "--git-dir",
                    git_dir_str,
                    "--work-tree",
                    work_tree_str,
                    "commit",
                    "-m",
                    "Grapher snapshot before run",
                ],
            );
        }
        git(
            &canonical,
            &["--git-dir", git_dir_str, "rev-parse", "--verify", "HEAD"],
        )
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
    if !resolved.starts_with(&context.repository)
        || data_root().canonicalize().ok().is_some_and(|data| resolved.starts_with(data))
        || resolved
            .strip_prefix(&context.repository)
            .unwrap()
            .components()
            .any(|component| {
                matches!(component, std::path::Component::Normal(name) if name == ".git" || name == ".grapher" || name == ".grapher-workspaces")
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
            if entry.file_name() == std::ffi::OsStr::new(".git") {
                continue;
            }
            let original = entry.path();
            if entry.file_name() == std::ffi::OsStr::new(".grapher")
                || entry.file_name() == std::ffi::OsStr::new(".grapher-workspaces")
            {
                continue;
            }
            let meta = fs::symlink_metadata(&original).map_err(|e| e.to_string())?;
            if original == excluded_data
                || (meta.is_dir()
                    && excluded_data
                        .canonicalize()
                        .ok()
                        .is_some_and(|data| original.canonicalize().ok().as_ref() == Some(&data)))
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

/// Legacy private-Planner checkout helper (not used by current planning).
/// Current Partitioner/Planner sessions run in source; these helpers remain for
/// legacy checkout/publication compatibility tests.
/// Snapshot the source into a private Planner checkout. The source lock is held
/// only while taking this copy, never while Pi is running. Include ignored
/// project files (e.g. dependencies), but never Git internals or Grapher data.
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
    }).map_err(|error| {
        format!(
            "Planner changes conflict with the source; the private workspace is retained: {error}"
        )
    })?;
    // Publish the actual repaired state, not the original conflicting Planner
    // head. Otherwise the source would repeat the already-resolved conflict.
    let head = if resolved_preview {
        snapshot_node_for_run(
            preview, repository, &format!("planner-{planning_id}-preview"), Some(run_id),
        )?
    } else {
        head
    };
    crate::graph_merge::merge_graph(repository, &[head], || resolve(repository))?;
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

fn git_file_url(path: &Path) -> Result<String, String> {
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
    let canonical_path =
        if path.try_exists().map_err(|error| error.to_string())? || path.is_symlink() {
            Some(canonical_workspace_path(path)?)
        } else {
            None
        };
    if canonical_path.as_ref() == Some(&canonical_repo) {
        if is_standard_git(repository) {
            return git(repository, &["rev-parse", "HEAD"]);
        } else {
            let shadow = ensure_shadow_repo(&canonical_repo)?;
            let git_dir_str = shadow.to_str().ok_or("Invalid shadow path")?;
            return git(
                &canonical_repo,
                &["--git-dir", git_dir_str, "rev-parse", "HEAD"],
            );
        }
    }

    // The shadow HEAD is frozen at approval. Do not silently build a graph
    // against a different user directory if files changed since then.
    // Publication checks again before writing back to catch later edits.
    if !is_standard_git(&canonical_repo) {
        check_shadow_source(&canonical_repo, expected_source_head)?;
    }

    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    canonical_workspace_path(path)?;

    // Determine the source Git location (either standard repository or shadow repo)
    let lock = host_ref_lock(&canonical_repo)?;
    let guard = lock.lock().map_err(|error| error.to_string())?;
    let source_git_path = if is_standard_git(&canonical_repo) {
        // A commit-addressed pin cannot be redirected by another Run's base.
        let pin = format!("refs/grapher/heads/{base}");
        if git(&canonical_repo, &["rev-parse", &pin]).ok().as_deref() != Some(base) {
            if let Err(error) = git(&canonical_repo, &["update-ref", &pin, base]) {
                if git(&canonical_repo, &["rev-parse", &pin]).ok().as_deref() != Some(base) {
                    return Err(error);
                }
            }
        }
        canonical_repo.clone()
    } else {
        let shadow = ensure_shadow_repo(&canonical_repo)?;
        let git_dir_str = shadow.to_str().ok_or("Invalid shadow path")?;
        let work_tree_str = canonical_repo.to_str().ok_or("Invalid target path")?;
        let pin = format!("refs/grapher/heads/{base}");
        let existing = git(
            &canonical_repo,
            &["--git-dir", git_dir_str, "rev-parse", &pin],
        );
        if existing.as_deref() != Ok(base) {
            if let Err(error) = git(
                &canonical_repo,
                &[
                    "--git-dir",
                    git_dir_str,
                    "--work-tree",
                    work_tree_str,
                    "update-ref",
                    &pin,
                    base,
                ],
            ) {
                if git(
                    &canonical_repo,
                    &["--git-dir", git_dir_str, "rev-parse", &pin],
                )
                .as_deref()
                    != Ok(base)
                {
                    return Err(error);
                }
            }
        }
        shadow
    };
    drop(guard);
    // Resolve refs in the host repository first, then borrow its object store.
    // An alternate is read-only: node commits and refs remain local until
    // snapshot_node explicitly imports them back into the host repository.
    let source_args = if source_git_path == canonical_repo {
        Vec::new()
    } else {
        vec![
            "--git-dir",
            source_git_path.to_str().ok_or("Invalid shadow path")?,
        ]
    };
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
        &["checkout", "-q", "-B", "grapher-node", "refs/grapher/base"],
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
                    "Workspace composition failed at {}: {error}",
                    path.display()
                ));
            }
            if let Err(merger_error) = resolve() {
                return Err(format!("Workspace composition blocked at {}. Resolve and commit the merge in this worktree, then use 'Use resolved workspace'.\nMerger: {merger_error}", path.display()));
            }
            if git(path, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok()
                || !git(path, &["diff", "--name-only", "--diff-filter=U"])?.is_empty()
                || git(path, &["merge-base", "--is-ancestor", &incoming, "HEAD"]).is_err()
                || !git(path, &["status", "--porcelain"])?.is_empty()
            {
                return Err(format!("Workspace composition blocked at {}. Merger did not finish a clean merge preserving the incoming parent; resolve and commit, then use 'Use resolved workspace'.", path.display()));
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
    if let Some(id) = run_id {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid Run ID for node snapshot")?;
    }
    let canonical_repo = repository
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let canonical_path = path.canonicalize().map_err(|error| error.to_string())?;
    if canonical_path == canonical_repo
        || canonical_path.starts_with(&canonical_repo)
        || canonical_repo.starts_with(&canonical_path)
    {
        return Err("Node snapshot requires a non-overlapping isolated workspace".into());
    }
    if !git(&canonical_path, &["diff", "--name-only", "--diff-filter=U"])?.is_empty() {
        return Err("Unresolved merge conflicts remain".into());
    }
    git(&canonical_path, &["add", "-A"])?;
    if !git(&canonical_path, &["status", "--porcelain"])?.is_empty() {
        git(
            &canonical_path,
            &["commit", "-m", "Grapher execution snapshot"],
        )?;
    }
    let head = git(&canonical_path, &["rev-parse", "HEAD"])?;
    git(
        &canonical_path,
        &["update-ref", "refs/heads/grapher-node", &head],
    )?;

    let path_url = git_file_url(&canonical_path)?;
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
    let source_args = if is_standard_git(&canonical_repo) {
        Vec::new()
    } else {
        let shadow = ensure_shadow_repo(&canonical_repo)?;
        vec![
            "--git-dir".to_string(),
            shadow.to_string_lossy().into_owned(),
            "--work-tree".to_string(),
            canonical_repo.to_string_lossy().into_owned(),
        ]
    };
    // Serialize host ref writes for this repository, not node execution or
    // writes to other repositories. Git's packed-refs lock can outlive a
    // short retry window even when each worker writes a different node ref.
    let lock = host_ref_lock(&canonical_repo)?;
    let _guard = lock.lock().map_err(|error| error.to_string())?;
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
    repository_git(&repository, &["update-ref", &format!("refs/grapher/heads/{head}"), head])?;
    Ok(())
}

/// Snapshot the user-owned source workspace (Planner or Serial). Graph workspaces
/// must use `snapshot_node` to import their commits into Grapher-owned host refs.
pub fn snapshot_repository(path: &Path) -> Result<String, String> {
    if is_standard_git(path) {
        if !git(path, &["diff", "--name-only", "--diff-filter=U"])?.is_empty() {
            return Err("Unresolved merge conflicts remain".into());
        }
        git(path, &["add", "-A"])?;
        if !git(path, &["status", "--porcelain"])?.is_empty() {
            git(path, &["commit", "-m", "Grapher execution snapshot"])?;
        }
        git(path, &["rev-parse", "HEAD"])
    } else {
        let canonical = path.canonicalize().map_err(|error| error.to_string())?;
        let shadow = ensure_shadow_repo(&canonical)?;
        let git_dir_str = shadow.to_str().ok_or("Invalid shadow path")?;
        let work_tree_str = canonical.to_str().ok_or("Invalid target path")?;
        git(
            &canonical,
            &[
                "--git-dir",
                git_dir_str,
                "--work-tree",
                work_tree_str,
                "add",
                "-A",
            ],
        )?;
        let status = git(
            &canonical,
            &[
                "--git-dir",
                git_dir_str,
                "--work-tree",
                work_tree_str,
                "status",
                "--porcelain",
            ],
        )?;
        if !status.trim().is_empty() {
            git(
                &canonical,
                &[
                    "--git-dir",
                    git_dir_str,
                    "--work-tree",
                    work_tree_str,
                    "commit",
                    "-m",
                    "Grapher execution snapshot",
                ],
            )?;
        }
        git(&canonical, &["--git-dir", git_dir_str, "rev-parse", "HEAD"])
    }
}

/// Choose the Serial source/shadow or Graph isolated-node snapshot contract
/// from canonical workspace identity.
pub fn snapshot_execution(path: &Path, repository: &Path, node_name: &str) -> Result<String, String> {
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
    if canonical_path == canonical_repo {
        snapshot_repository(&canonical_path)
    } else {
        snapshot_node_for_run(&canonical_path, &canonical_repo, node_name, run_id)
    }
}
