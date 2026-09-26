use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
};

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
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join(".grapher")
        });
    if path.is_relative() {
        std::env::current_dir()
            .map(|cwd| cwd.join(&path))
            .unwrap_or(path)
    } else {
        path
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

pub fn shadow_repo_dir(target: &Path) -> PathBuf {
    let canonical = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf());
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
    data_root()
        .join("shadow_repos")
        .join(format!("{}_{:016x}.git", safe_name, hash))
}

pub fn ensure_shadow_repo(target: &Path) -> Result<PathBuf, String> {
    let canonical_target = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf());
    let shadow_dir = shadow_repo_dir(&canonical_target);
    if !shadow_dir.exists() {
        fs::create_dir_all(&shadow_dir).map_err(|e| e.to_string())?;
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

        if output.is_err() || !output.as_ref().unwrap().status.success() {
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
        let path_str = top_level.to_string_lossy().to_string();
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
        let path_str = candidate
            .canonicalize()
            .unwrap_or_else(|_| candidate.clone())
            .to_string_lossy()
            .to_string();
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

pub fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    if let Some(result) = git_read(cwd, args) {
        return result;
    }
    let hooks_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let hooks_config = format!("core.hooksPath={hooks_path}");
    let output = Command::new("git")
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
        .args(args)
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
    let shadow = shadow_repo_dir(&repository);
    if !shadow.is_dir() {
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
        let canonical = repository
            .canonicalize()
            .unwrap_or_else(|_| repository.to_path_buf());
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

fn copy_planner_files(source: &Path, target: &Path, excluded_data: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() == std::ffi::OsStr::new(".git") {
            continue;
        }
        let original = entry.path();
        if original == excluded_data {
            continue;
        }
        let copied = target.join(entry.file_name());
        let meta = fs::symlink_metadata(&original).map_err(|e| e.to_string())?;
        if copied.exists() || copied.is_symlink() {
            if copied.is_dir() && !copied.is_symlink() && !meta.is_dir() {
                fs::remove_dir_all(&copied).map_err(|e| e.to_string())?;
            } else if (!copied.is_dir() || copied.is_symlink()) && meta.is_dir() {
                fs::remove_file(&copied).map_err(|e| e.to_string())?;
            }
        }
        if meta.is_dir() {
            fs::create_dir_all(&copied).map_err(|e| e.to_string())?;
            copy_planner_files(&original, &copied, excluded_data)?;
        } else {
            if copied.exists() || copied.is_symlink() {
                fs::remove_file(&copied).map_err(|e| e.to_string())?;
            }
            if meta.file_type().is_symlink() {
                let link = fs::read_link(&original).map_err(|e| e.to_string())?;
                #[cfg(unix)]
                std::os::unix::fs::symlink(link, &copied).map_err(|e| e.to_string())?;
                #[cfg(windows)]
                {
                    let _ = link;
                    fs::copy(&original, &copied).map_err(|e| e.to_string())?;
                }
            } else if meta.is_file() {
                fs::copy(&original, &copied).map_err(|e| e.to_string())?;
            } else {
                return Err(format!("Unsupported source entry: {}", original.display()));
            }
        }
    }
    Ok(())
}

/// Snapshot the source into a private Planner checkout. The source lock is held
/// only while taking this copy, never while Pi is running. Include ignored
/// project files (e.g. dependencies), but never Git internals or Grapher data.
pub fn prepare_planner(repository: &Path, path: &Path) -> Result<(), String> {
    let base = verify(repository)?;
    prepare(repository, path, &base, &[])?;
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
                    let target = fs::read_link(&original).map_err(|e| e.to_string())?;
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(target, &copied).map_err(|e| e.to_string())?;
                    #[cfg(windows)]
                    {
                        let _ = target;
                        fs::copy(&original, &copied).map_err(|e| e.to_string())?;
                    }
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
    copy_planner_files(repository, path, &data_root())?;
    // The input commit becomes the immutable parent for this Planner's edits.
    snapshot_repository(path)?;
    Ok(())
}

/// Merge one Planner's private changes under the project's short publication
/// lock. A dry run prevents ordinary merge conflicts from dirtying the source.
pub fn publish_planner(
    repository: &Path,
    planner: &Path,
    preview: &Path,
    run_id: &str,
    planning_id: &str,
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
    prepare(repository, preview, &source_head, &[head.clone()]).map_err(|error| {
        format!(
            "Planner changes conflict with the source; the private workspace is retained: {error}"
        )
    })?;
    crate::graph_merge::merge_graph(repository, &[head], || {
        Err(
            "Planner merge conflicted after preflight; resolve the source merge before retrying"
                .into(),
        )
    })?;
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
    mut resolve: impl FnMut() -> Result<(), String>,
) -> Result<String, String> {
    let canonical_repo = repository
        .canonicalize()
        .unwrap_or_else(|_| repository.to_path_buf());
    let canonical_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if canonical_path == canonical_repo {
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

    // Determine the source Git location (either standard repository or shadow repo)
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
        let node_ref = format!("refs/grapher/nodes/{parent}");
        let head_ref = format!("refs/grapher/heads/{parent}");
        if let Some(url) = source_url.as_deref() {
            let node_refspec = format!("+{node_ref}:refs/grapher/parents/{parent}");
            let head_refspec = format!("+{head_ref}:refs/grapher/parents/{parent}");
            if git(
                path,
                &[
                    "fetch",
                    "-q",
                    "--no-tags",
                    "--no-write-fetch-head",
                    url,
                    &node_refspec,
                ],
            )
            .is_err()
            {
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
            }
        } else {
            let head = source_git(&["rev-parse", &node_ref])
                .or_else(|_| source_git(&["rev-parse", &head_ref]))?;
            git(
                path,
                &[
                    "update-ref",
                    &format!("refs/grapher/parents/{parent}"),
                    &head,
                ],
            )?;
        }
        resolved_heads.push(git(
            path,
            &["rev-parse", &format!("refs/grapher/parents/{parent}")],
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
pub fn snapshot_node(path: &Path, repository: &Path, node_id: &str) -> Result<String, String> {
    snapshot_node_for_run(path, repository, node_id, None)
}

pub fn snapshot_node_for_run(
    path: &Path,
    repository: &Path,
    node_id: &str,
    run_id: Option<&str>,
) -> Result<String, String> {
    crate::compiler::validate_node_name(node_id)?;
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
    // The commit-addressed pin may already be written by a sibling Run.
    // Concurrent fetches of that same ref can race at Git's ref lock. Retry
    // with just this Run's private node ref once the shared pin is present.
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

/// Snapshot the user-owned Serial workspace. Graph workspaces must use
/// `snapshot_node` so their commits are imported into Grapher-owned host refs.
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
pub fn snapshot_execution(path: &Path, repository: &Path, node_id: &str) -> Result<String, String> {
    snapshot_execution_for_run(path, repository, node_id, None)
}

pub fn snapshot_execution_for_run(
    path: &Path,
    repository: &Path,
    node_id: &str,
    run_id: Option<&str>,
) -> Result<String, String> {
    let canonical_repo = repository
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let canonical_path = path.canonicalize().map_err(|error| error.to_string())?;
    if canonical_path == canonical_repo {
        snapshot_repository(&canonical_path)
    } else {
        snapshot_node_for_run(&canonical_path, &canonical_repo, node_id, run_id)
    }
}
