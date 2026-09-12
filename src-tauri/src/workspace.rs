use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

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

pub fn demo_repository(root: &Path) -> Result<PathBuf, String> {
    let path = root.join("demo-repository");
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    if !path.join(".git").exists() {
        git(&path, &["init"])?;
        fs::write(
            path.join("README.md"),
            "# Grapher demo\nAn isolated fixture; no model calls.\n",
        )
        .map_err(|error| error.to_string())?;
        git(&path, &["add", "README.md"])?;
        git(&path, &["commit", "-m", "Initialize isolated demo"])?;
    }
    Ok(path)
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
