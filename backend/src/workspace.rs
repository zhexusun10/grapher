use serde::{Deserialize, Serialize};
use std::{
    fs,
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
    }))
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

pub fn verify(repository: &Path) -> Result<String, String> {
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
}

pub fn prepare(
    repository: &Path,
    path: &Path,
    base: &str,
    parents: &[String],
) -> Result<String, String> {
    fs::create_dir_all(path.parent().ok_or("Invalid worktree path")?)
        .map_err(|error| error.to_string())?;
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
    for parent in parents {
        if let Err(error) = git(path, &["merge", "--no-edit", "--no-ff", parent]) {
            return Err(format!("Workspace composition blocked at {}. Resolve and commit the merge in this worktree, then use 'Use resolved workspace'.\n{error}", path.display()));
        }
    }
    git(path, &["rev-parse", "HEAD"])
}

pub fn snapshot(path: &Path) -> Result<String, String> {
    if !git(path, &["diff", "--name-only", "--diff-filter=U"])?.is_empty() {
        return Err("Unresolved merge conflicts remain".into());
    }
    git(path, &["add", "-A"])?;
    if !git(path, &["status", "--porcelain"])?.is_empty() {
        git(path, &["commit", "-m", "Grapher execution snapshot"])?;
    }
    git(path, &["rev-parse", "HEAD"])
}
