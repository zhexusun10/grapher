//! Host-native execution with explicit Pi file-tool mapping and per-platform
//! Graph workspaces. macOS/Linux enforce filesystem boundaries; Windows runs
//! ordinary host processes (no per-agent sandbox). Bash keeps Pi's semantics.
use crate::engine::PiRole;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
};

static RUNTIME: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

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
    if let Some(root) = &*cached {
        return Ok(root.clone());
    }
    let installation = installation_root()
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Grapher installation root: {error}"))?;
    let runtime_parent = std::env::var_os("GRAPHER_NATIVE_RUNTIME_PARENT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            installation
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(".grapher-workspaces")
        });
    let output = Command::new("node")
        .arg(installation_root().join("scripts/prepare-native-runtime.mjs"))
        .env("GRAPHER_NATIVE_RUNTIME_PARENT", &runtime_parent)
        .output()
        .map_err(|error| format!("Cannot start native runtime preparation with Node: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Cannot prepare native Pi runtime (exit {}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let raw_root = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    let root = PathBuf::from(raw_root.trim());
    let root = root.canonicalize().map_err(|error| {
        format!(
            "Cannot resolve prepared native runtime {}: {error}",
            root.display()
        )
    })?;
    if !root.join("engine/entrypoint.mjs").is_file() {
        return Err("Incomplete native runtime: engine entrypoint is missing".into());
    }
    *cached = Some(root.clone());
    Ok(root)
}

pub fn installation_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
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

pub fn validate_workspace(role: PiRole, repository: &Path, cwd: &Path) -> Result<(), String> {
    crate::workspace::validate_binding(repository)?;
    let repository = repository.canonicalize().map_err(|e| e.to_string())?;
    let cwd = cwd
        .canonicalize()
        .map_err(|e| format!("Invalid execution directory: {e}"))?;
    if cwd != repository {
        if !matches!(role, PiRole::NodeAgent | PiRole::Planner) {
            return Err("Partitioner/Merger must use the bound source directory".into());
        }
        if cwd.starts_with(&repository) || repository.starts_with(&cwd) {
            return Err("Graph workspace must not overlap the source directory".into());
        }
        if role == PiRole::Planner
            && cwd
                .parent()
                .and_then(Path::parent)
                .and_then(|root| root.file_name())
                != Some(std::ffi::OsStr::new(".grapher-workspaces"))
        {
            return Err("Planner requires a private planning workspace".into());
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
        return Ok(command);
    }
    #[cfg(target_os = "linux")]
    {
        let pi_dir = agent_dir()?;
        crate::linux_sandbox::execution_command(
            &source,
            worktree_root,
            &current,
            data,
            session,
            &engine,
            &pi_dir,
        )
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
        assert!(validate_workspace(PiRole::NodeAgent, &source, &node)
            .unwrap_err()
            .contains("private Git"));
        assert!(validate_workspace(PiRole::Planner, &source, &node).is_err());
        let private = temp.path().join(".grapher-workspaces/run/planner");
        fs::create_dir_all(&private).unwrap();
        crate::workspace::git(&private, &["init", "-q"]).unwrap();
        let planner = validate_workspace(PiRole::Planner, &source, &private);
        #[cfg(not(windows))]
        assert!(planner.is_ok());
        #[cfg(windows)]
        match require_graph_execution() {
            Ok(()) => assert!(planner.is_ok()),
            Err(error) => assert_eq!(planner.unwrap_err(), error),
        }
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn private_planner_can_write_its_graph_but_not_the_source() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let source = base.join("source");
        let workspace = base.join(".grapher-workspaces/run/planner");
        let data = base.join("data");
        let session = data.join("planner-session");
        for path in [&source, &workspace, &session] {
            fs::create_dir_all(path).unwrap();
        }
        crate::workspace::git(&workspace, &["init", "-q"]).unwrap();
        crate::workspace::git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("marker"), "original").unwrap();
        let graph_path = session.join("graph.json");
        let probe = base.join("planner-probe.ts");
        fs::write(
            &probe,
            r#"import * as fs from 'node:fs';
export default function () {
  fs.writeFileSync(process.env.GRAPHER_GRAPH_PATH!, 'graph');
  fs.writeFileSync('private-output', 'private');
  try { fs.writeFileSync(process.env.GRAPHER_ORIGINAL_ROOT + '/marker', 'bad'); }
  catch { fs.writeFileSync('source-blocked', 'yes'); return; }
  throw new Error('Planner was allowed to overwrite source');
}
"#,
        )
        .unwrap();
        let mut command =
            execution_command(PiRole::Planner, &source, &workspace, &data, &session).unwrap();
        let output = command
            .args([
                "--mode",
                "json",
                "--print",
                "--no-session",
                "--no-skills",
                "--no-extensions",
                "--extension",
            ])
            .arg(&probe)
            .arg("--session-dir")
            .arg(&session)
            .env("GRAPHER_MODE", "planner")
            .env("GRAPHER_GRAPH_PATH", &graph_path)
            .env("GRAPHER_ORIGINAL_ROOT", &source)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read_to_string(&graph_path).unwrap(), "graph");
        assert_eq!(
            fs::read_to_string(workspace.join("private-output")).unwrap(),
            "private"
        );
        assert_eq!(
            fs::read_to_string(workspace.join("source-blocked")).unwrap(),
            "yes"
        );
        assert_eq!(
            fs::read_to_string(source.join("marker")).unwrap(),
            "original"
        );
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
        for (label, cwd, sibling) in [("A", &a, &b), ("B", &b, &a)] {
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
                execution_command(PiRole::NodeAgent, &source, cwd, &data, &session).unwrap();
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
