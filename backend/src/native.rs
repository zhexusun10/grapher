//! Host-native execution with explicit Pi file-tool mapping and macOS path
//! exclusions. Bash keeps native path semantics; there is no universal remap.
use crate::engine::PiRole;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
};

static RUNTIME: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

pub fn require_graph_execution() -> Result<(), String> {
    if !crate::sandbox::supported() {
        return Err("Native Graph execution requires macOS sandbox-exec".into());
    }
    Ok(())
}

fn prepared_runtime() -> Result<PathBuf, String> {
    let mut cached = RUNTIME
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(root) = &*cached {
        return Ok(root.clone());
    }
    let output = Command::new("node")
        .arg(installation_root().join("scripts/prepare-native-runtime.mjs"))
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Cannot prepare native Pi runtime: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let root = PathBuf::from(String::from_utf8(output.stdout).map_err(|e| e.to_string())?);
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if !root.join("engine/entrypoint.mjs").is_file() {
        return Err("Incomplete native runtime".into());
    }
    *cached = Some(root.clone());
    Ok(root)
}

pub fn installation_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

pub fn validate_workspace(role: PiRole, repository: &Path, cwd: &Path) -> Result<(), String> {
    crate::workspace::validate_binding(repository)?;
    let repository = repository.canonicalize().map_err(|e| e.to_string())?;
    let cwd = cwd
        .canonicalize()
        .map_err(|e| format!("Invalid execution directory: {e}"))?;
    if cwd != repository {
        if role != PiRole::NodeAgent {
            return Err("Planner/Partitioner/Merger must use the bound source directory".into());
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
    if !cfg!(target_os = "macos") {
        return Err("The native execution backend is currently validated only on macOS".into());
    }
    Ok(())
}

pub fn command(role: PiRole, repository: &Path, cwd: &Path) -> Result<Command, String> {
    validate_workspace(role, repository, cwd)?;
    if repository.canonicalize().map_err(|e| e.to_string())?
        != cwd.canonicalize().map_err(|e| e.to_string())?
    {
        return Err("Private workspaces require execution_command and its sandbox profile".into());
    }
    let mut command = Command::new("node");
    command.arg(installation_root().join("engine/entrypoint.mjs"));
    command.current_dir(cwd);
    command.env("PI_CODING_AGENT_DIR", agent_dir()?);
    command.env_remove("GRAPHER_EXECUTION_KIND");
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
    let engine = prepared_runtime()?;
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
    Ok(command)
}

/// Shared upstream-owned credentials/config; this is not a directory mapping.
pub fn agent_dir() -> Result<PathBuf, String> {
    let path = if let Some(path) = std::env::var_os("PI_CODING_AGENT_DIR") {
        PathBuf::from(path)
    } else {
        PathBuf::from(std::env::var_os("HOME").ok_or("HOME is required")?).join(".grapher/pi-agent")
    };
    let path = if path == Path::new("~") || path.starts_with("~/") {
        PathBuf::from(std::env::var_os("HOME").ok_or("HOME is required")?)
            .join(path.strip_prefix("~").unwrap())
    } else {
        path
    };
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&path)
        .map_err(|e| e.to_string())?;
    let target_models = path.join("models.json");
    if !target_models.exists() {
        if let Some(home) = std::env::var_os("HOME") {
            let source_models = PathBuf::from(home).join(".pi/agent/models.json");
            if source_models.exists() {
                let _ = std::os::unix::fs::symlink(&source_models, &target_models);
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
    #[cfg(target_os = "macos")]
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
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&node, &alias).unwrap();
        for cwd in [&node, &alias] {
            assert!(validate_workspace(PiRole::NodeAgent, &source, cwd)
                .unwrap_err()
                .contains("private Git"));
            assert!(validate_workspace(PiRole::Planner, &source, cwd).is_err());
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn graph_launcher_runs_parallel_native_tools_and_absolute_scripts() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
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
        for (label, cwd, sibling) in [("A", &a, &b), ("B", &b, &a)] {
            symlink(&source, cwd.join("source-link")).unwrap();
            symlink(&material, cwd.join("external-link")).unwrap();
            let session = data.join(format!("sessions/{label}"));
            fs::create_dir_all(&session).unwrap();
            let mut command =
                execution_command(PiRole::NodeAgent, &source, cwd, &data, &session).unwrap();
            // Also exclude the real installation, proving the copied Pi/.git
            // and dependency symlinks do not reach back into it for self-hosting.
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
                .env("GRAPHER_MODE", "node")
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
            workers.push((label, command.spawn().unwrap()));
        }
        for (label, worker) in workers {
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
