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
    let canonical = target.canonicalize().unwrap_or_else(|_| target.to_path_buf());
    let mut hasher = DefaultHasher::new();
    canonical.to_string_lossy().hash(&mut hasher);
    let hash = hasher.finish();
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".into());
    let safe_name: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    data_root()
        .join("shadow_repos")
        .join(format!("{}_{:016x}.git", safe_name, hash))
}

pub fn ensure_shadow_repo(target: &Path) -> Result<PathBuf, String> {
    let canonical_target = target.canonicalize().unwrap_or_else(|_| target.to_path_buf());
    let shadow_dir = shadow_repo_dir(&canonical_target);
    if !shadow_dir.exists() {
        fs::create_dir_all(&shadow_dir).map_err(|e| e.to_string())?;
        let git_dir_str = shadow_dir.to_str().ok_or("Invalid shadow path")?;
        let work_tree_str = canonical_target.to_str().ok_or("Invalid target path")?;

        git(
            &canonical_target,
            &["--git-dir", git_dir_str, "--work-tree", work_tree_str, "init"],
        )?;
        let _ = git(
            &canonical_target,
            &["--git-dir", git_dir_str, "--work-tree", work_tree_str, "add", "-A"],
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
        let mut output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output();

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
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

pub fn pick_repository() -> Result<PickResult, String> {
    #[cfg(target_os = "macos")]
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
    #[cfg(not(target_os = "macos"))]
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
        let head = git(&top_level, &["rev-parse", "--short", "HEAD"])
            .unwrap_or_default();
        let status = git(&top_level, &["status", "--porcelain"])
            .unwrap_or_default();
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

pub fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
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
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}

/// Run Git against either a normal checkout or the existing external shadow
/// repository. Publication must never create/rebaseline a shadow repository.
pub fn repository_git(repository: &Path, args: &[&str]) -> Result<String, String> {
    let repository = repository.canonicalize().map_err(|e| e.to_string())?;
    if is_standard_git(&repository) { return git(&repository, args); }
    let shadow = shadow_repo_dir(&repository);
    if !shadow.is_dir() { return Err("Shadow repository is missing; retained node results have not been published".into()); }
    let mut command = vec!["--git-dir", shadow.to_str().ok_or("Invalid shadow path")?,
        "--work-tree", repository.to_str().ok_or("Invalid repository path")?];
    command.extend_from_slice(args);
    git(&repository, &command)
}

pub fn verify(repository: &Path) -> Result<String, String> {
    if is_standard_git(repository) {
        let root = git(repository, &["rev-parse", "--show-toplevel"])?;
        if fs::canonicalize(repository).map_err(|error| error.to_string())?
            != fs::canonicalize(&root).map_err(|error| error.to_string())?
        {
            return Err("Choose the Git repository root".into());
        }
        if !git(repository, &["status", "--porcelain"])?.is_empty() {
            return Err("Repository must be clean, including untracked files. Commit or move your changes first; Grapher will not touch them.".into());
        }
        git(repository, &["rev-parse", "--verify", "HEAD"])
    } else {
        if !repository.is_dir() {
            return Err(format!("Directory does not exist: {}", repository.display()));
        }
        let canonical = repository.canonicalize().unwrap_or_else(|_| repository.to_path_buf());
        let shadow = ensure_shadow_repo(&canonical)?;
        let git_dir_str = shadow.to_str().ok_or("Invalid shadow path")?;
        let work_tree_str = canonical.to_str().ok_or("Invalid target path")?;

        let _ = git(
            &canonical,
            &["--git-dir", git_dir_str, "--work-tree", work_tree_str, "add", "-A"],
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
        git(&canonical, &["--git-dir", git_dir_str, "rev-parse", "--verify", "HEAD"])
    }
}

pub fn prepare(
    repository: &Path,
    path: &Path,
    base: &str,
    parents: &[String],
) -> Result<String, String> {
    let canonical_repo = repository.canonicalize().unwrap_or_else(|_| repository.to_path_buf());
    let canonical_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if canonical_path == canonical_repo {
        if is_standard_git(repository) {
            return git(repository, &["rev-parse", "HEAD"]);
        } else {
            let shadow = ensure_shadow_repo(&canonical_repo)?;
            let git_dir_str = shadow.to_str().ok_or("Invalid shadow path")?;
            return git(&canonical_repo, &["--git-dir", git_dir_str, "rev-parse", "HEAD"]);
        }
    }

    fs::create_dir_all(path.parent().ok_or("Invalid worktree path")?)
        .map_err(|error| error.to_string())?;
    if is_standard_git(repository) {
        git(
            repository,
            &[
                "worktree",
                "add",
                "--detach",
                path.to_str().ok_or("Invalid path")?,
                base,
            ],
        )?;
    } else {
        let canonical = repository.canonicalize().unwrap_or_else(|_| repository.to_path_buf());
        let shadow = ensure_shadow_repo(&canonical)?;
        let git_dir_str = shadow.to_str().ok_or("Invalid shadow path")?;
        let abs_path = if path.is_relative() {
            std::env::current_dir()
                .map(|cwd| cwd.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        } else {
            path.to_path_buf()
        };
        git(
            &canonical,
            &[
                "--git-dir",
                git_dir_str,
                "worktree",
                "add",
                "--detach",
                abs_path.to_str().ok_or("Invalid path")?,
                base,
            ],
        )?;
    }
    for parent in parents {
        if let Err(error) = git(path, &["merge", "--no-edit", "--no-ff", parent]) {
            return Err(format!("Workspace composition blocked at {}. Resolve and commit the merge in this worktree, then use 'Use resolved workspace'.\n{error}", path.display()));
        }
    }
    git(path, &["rev-parse", "HEAD"])
}

pub fn snapshot(path: &Path) -> Result<String, String> {
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
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let shadow = ensure_shadow_repo(&canonical)?;
        let git_dir_str = shadow.to_str().ok_or("Invalid shadow path")?;
        let work_tree_str = canonical.to_str().ok_or("Invalid target path")?;
        let _ = git(&canonical, &["--git-dir", git_dir_str, "--work-tree", work_tree_str, "add", "-A"]);
        let status = git(&canonical, &["--git-dir", git_dir_str, "--work-tree", work_tree_str, "status", "--porcelain"])?;
        if !status.trim().is_empty() {
            let _ = git(&canonical, &["--git-dir", git_dir_str, "--work-tree", work_tree_str, "commit", "-m", "Grapher execution snapshot"]);
        }
        git(&canonical, &["--git-dir", git_dir_str, "rev-parse", "HEAD"])
    }
}

