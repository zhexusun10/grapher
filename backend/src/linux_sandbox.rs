//! Linux Graph filesystem boundary. A Harbor task container is NOT a
//! per-node sandbox: each Graph node needs its own filesystem view.
#![cfg(target_os = "linux")]

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
};

fn canonical(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|e| format!("Invalid Linux sandbox path {}: {e}", path.display()))
}

const BWRAP: &str = "/usr/bin/bwrap";

fn base_command() -> Command {
    let mut command = Command::new(BWRAP);
    // The private PID namespace prevents /proc/<backend-pid>/root or /fd from
    // reaching the parent's unmasked view. Network remains inherited for Pi.
    // Dropping capabilities prevents an agent from unmounting the barriers.
    // A bind of / can inherit MS_NODEV in an unprivileged user namespace.
    // Preserve the task container's /dev for Git, Pi, and native tools.
    command.args([
        "--die-with-parent",
        "--unshare-user",
        "--unshare-pid",
        "--cap-drop",
        "ALL",
        "--bind",
        "/",
        "/",
        "--dev-bind",
        "/dev",
        "/dev",
        "--proc",
        "/proc",
    ]);
    command
}

/// Prepare empty, read-only mount trees OUTSIDE the protected paths. A tmpfs
/// over source would preserve integrity but falsely let source writes succeed;
/// read-only binds make those writes fail like the macOS/Windows boundaries.
/// Directories for the private exceptions exist before their parents are masked.
fn mount_boundaries(
    command: &mut Command,
    mut masks: Vec<PathBuf>,
    current: &Path,
    session: &Path,
    engine: &Path,
    installation: &Path,
) -> Result<(), String> {
    masks.sort_by(|a, b| {
        a.components()
            .count()
            .cmp(&b.components().count())
            .then_with(|| a.cmp(b))
    });
    masks.dedup();
    let staging = engine.join(format!(".grapher-masks-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    // The copied engine is read-only below, but dependency symlinks may
    // resolve into the original installation. Do not let one node modify
    // code/dependencies loaded by later nodes or backend roles.
    command.arg("--ro-bind").arg(installation).arg(installation);
    for (index, mask) in masks.iter().enumerate() {
        let empty = staging.join(index.to_string());
        fs::create_dir_all(&empty).map_err(|e| e.to_string())?;
        for path in masks.iter().map(PathBuf::as_path).chain([current, session]) {
            if let Ok(relative) = path.strip_prefix(mask) {
                fs::create_dir_all(empty.join(relative)).map_err(|e| e.to_string())?;
            }
        }
        command.arg("--ro-bind").arg(&empty).arg(mask);
    }
    command
        .arg("--bind")
        .arg(current)
        .arg(current)
        .arg("--bind")
        .arg(session)
        .arg(session)
        .arg("--ro-bind")
        .arg(engine)
        .arg(engine);
    Ok(())
}

/// Docker may block user/mount namespaces even when bwrap is installed. Probe
/// actual mounts and write denial before accepting ANY Graph plan. Fail closed.
pub fn require_supported() -> Result<(), String> {
    static CHECK: OnceLock<Result<(), String>> = OnceLock::new();
    CHECK.get_or_init(probe).clone()
}

fn probe() -> Result<(), String> {
    let base = std::env::temp_dir().join(format!("grapher-bwrap-probe-{}", uuid::Uuid::new_v4()));
    let source = base.join("source");
    let root = base.join(".grapher-worktrees");
    let current = root.join("run/node");
    let data = base.join("data");
    let session = data.join("sessions/current");
    let engine = base.join("engine");
    let installation = base.join("installation");
    let result = (|| {
        for path in [&source, &current, &session, &engine, &installation] {
            fs::create_dir_all(path).map_err(|e| e.to_string())?;
        }
        fs::write(source.join("secret"), "protected").map_err(|e| e.to_string())?;
        fs::write(installation.join("code"), "protected").map_err(|e| e.to_string())?;
        let mut command = base_command();
        mount_boundaries(
            &mut command,
            vec![source.clone(), root, data],
            &current,
            &session,
            &engine,
            &installation,
        )?;
        command.args(["--", "/bin/sh", "-c",
            ": <>/dev/null && test ! -e \"$1/secret\" && ! (echo bad > \"$1/secret\") 2>/dev/null && ! (echo bad > \"$4/code\") 2>/dev/null && echo ok > \"$2/write\" && echo ok > \"$3/write\"",
            "probe"])
            .args([&source, &current, &session, &installation]);
        let output = command.stdout(Stdio::null()).output().map_err(|e| {
            format!("Linux Graph requires bubblewrap (bwrap) and user namespaces: {e}")
        })?;
        if !output.status.success()
            || fs::read_to_string(source.join("secret")).ok().as_deref() != Some("protected")
            || fs::read_to_string(installation.join("code"))
                .ok()
                .as_deref()
                != Some("protected")
        {
            return Err(format!(
                "Linux Graph filesystem isolation unavailable: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&base);
    result
}

/// Node inherits task tools/network but cannot see source, sibling repos,
/// backend data (other than its session) or external source Git metadata.
pub fn execution_command(
    source: &Path,
    root: &Path,
    current: &Path,
    data: &Path,
    session: &Path,
    engine: &Path,
    pi_dir: &Path,
) -> Result<Command, String> {
    require_supported()?;
    let source = canonical(source)?;
    let root = canonical(root)?;
    let current = canonical(current)?;
    let data = canonical(data)?;
    let session = canonical(session)?;
    let engine = canonical(engine)?;
    let pi_dir = canonical(pi_dir)?;
    let installation = canonical(&crate::native::installation_root())?;
    if [
        source.as_path(),
        root.as_path(),
        data.as_path(),
        installation.as_path(),
    ]
    .contains(&Path::new("/"))
        || !current.starts_with(&root)
        || current == root
        || !session.starts_with(&data)
        || session == data
        || source.starts_with(&root)
        || root.starts_with(&source)
        || source.starts_with(&data)
        || root.starts_with(&data)
        || current.starts_with(&source)
        || source.starts_with(&current)
        || engine.starts_with(&source)
        || engine.starts_with(&root)
        || engine.starts_with(&data)
        || data.starts_with(&current)
        || current.starts_with(&data)
        || [&source, &root, &data, &engine, &installation]
            .iter()
            .any(|hidden| pi_dir.starts_with(hidden))
    {
        return Err("Overlapping Linux Graph filesystem sandbox paths".into());
    }
    let mut masks = vec![source.clone(), root.clone(), data.clone()];
    let shadow = crate::workspace::shadow_repo_dir(&source);
    if shadow.exists() {
        masks.push(canonical(&shadow)?);
    }
    for common in [
        crate::workspace::repository_git(
            &source,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?,
        crate::workspace::git(
            &current,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?,
    ] {
        masks.push(canonical(Path::new(&common))?);
    }
    masks.retain(|path| {
        path == &data
            || ![&source, &root, &data]
                .iter()
                .any(|parent| path != *parent && path.starts_with(parent))
    });
    for mask in &masks {
        if mask == Path::new("/")
            || [&current, &session, &engine, &pi_dir].iter().any(|needed| {
                needed.starts_with(mask)
                    && !(mask == &root && *needed == &current)
                    && !(mask == &data && *needed == &session)
                    && !(mask == &source && *needed == &session && session.starts_with(&source))
            })
        {
            return Err("Git or runtime directory overlaps the Linux Graph sandbox".into());
        }
    }
    let mut command = base_command();
    mount_boundaries(
        &mut command,
        masks,
        &current,
        &session,
        &engine,
        &installation,
    )?;
    command
        .arg("--")
        .arg("node")
        .arg(engine.join("engine/entrypoint.mjs"));
    // PID namespaces reuse small PIDs across concurrent Graph nodes. tsx
    // names its IPC socket <os.tmpdir()>/tsx-<uid>/<pid>.pipe, so a shared
    // /tmp makes independent nodes collide (EADDRINUSE).
    command
        .current_dir(&current)
        .env("PI_CODING_AGENT_DIR", pi_dir)
        .env("TMPDIR", &session);
    Ok(command)
}

#[cfg(all(test, not(feature = "fixture")))]
mod tests {
    use super::*;

    #[test]
    fn retains_container_device_nodes() {
        let command = base_command();
        let args: Vec<_> = command.get_args().collect();
        assert!(args
            .windows(3)
            .any(|part| part == ["--dev-bind", "/dev", "/dev"]));
    }

    #[test]
    fn session_inside_masked_source_remains_writable() {
        require_supported().expect("Linux Graph requires bwrap in CI");
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let source = base.join("source");
        let root = base.join(".grapher-worktrees");
        let current = root.join("run/node");
        let data = source.join(".grapher");
        let session = data.join("sessions/node");
        let engine = base.join("engine");
        let pi_dir = base.join("pi-agent");
        for path in [&source, &current, &session, &engine, &pi_dir] {
            fs::create_dir_all(path).unwrap();
        }
        crate::workspace::git(&source, &["init", "-q"]).unwrap();
        crate::workspace::git(&current, &["init", "-q"]).unwrap();
        fs::write(source.join("secret"), "protected").unwrap();
        let command =
            execution_command(&source, &root, &current, &data, &session, &engine, &pi_dir).unwrap();
        let args = command
            .get_args()
            .map(|a| a.to_os_string())
            .collect::<Vec<_>>();
        let mut probe = Command::new(BWRAP);
        let result = probe.args(&args[..args.len()-2]).args([
            "/bin/sh", "-c",
            "set -e; : <>/dev/null; test ! -f \"$1/secret\"; ! (echo bad > \"$1/secret\") 2>/dev/null; echo ok > \"$2/new\"",
            "probe",
        ]).args([&source, &session]).current_dir(&current).output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(fs::read_to_string(session.join("new")).unwrap(), "ok\n");
        assert_eq!(
            fs::read_to_string(source.join("secret")).unwrap(),
            "protected"
        );
    }

    #[test]
    fn external_git_database_is_not_accessible_to_node() {
        require_supported().expect("Linux Graph requires bwrap in CI");
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let source = base.join("source");
        let root = base.join(".grapher-worktrees");
        let current = root.join("run/node");
        let data = base.join("data");
        let session = data.join("sessions/node");
        let engine = base.join("engine");
        let pi_dir = base.join("pi-agent");
        let common = base.join("git-common");
        for path in [&source, &current, &session, &engine, &pi_dir] {
            fs::create_dir_all(path).unwrap();
        }
        crate::workspace::git(
            &source,
            &["init", "-q", "--separate-git-dir", common.to_str().unwrap()],
        )
        .unwrap();
        crate::workspace::git(&current, &["init", "-q"]).unwrap();
        fs::write(common.join("protected"), "original").unwrap();
        let command =
            execution_command(&source, &root, &current, &data, &session, &engine, &pi_dir).unwrap();
        let args = command
            .get_args()
            .map(|a| a.to_os_string())
            .collect::<Vec<_>>();
        let output = Command::new(BWRAP).args(&args[..args.len()-2]).args([
            "/bin/sh", "-c",
            "set -e; : <>/dev/null; test ! -f \"$1/protected\"; ! (echo leak > \"$1/protected\") 2>/dev/null; echo ok > \"$2/new\"",
            "probe",
        ]).args([&common, &current]).current_dir(&current).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read_to_string(common.join("protected")).unwrap(),
            "original"
        );
        assert_eq!(fs::read_to_string(current.join("new")).unwrap(), "ok\n");
    }

    #[test]
    fn self_hosted_installation_does_not_reexpose_source() {
        require_supported().expect("Linux Graph requires bwrap in CI");
        let source = canonical(&crate::native::installation_root()).unwrap();
        assert!(source.join("package.json").is_file());
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join(".grapher-worktrees");
        let current = root.join("run/node");
        let data = base.join("data");
        let session = data.join("sessions/current");
        let engine = base.join("engine");
        let pi_dir = base.join("agent");
        for path in [&current, &session, &engine, &pi_dir] {
            fs::create_dir_all(path).unwrap();
        }
        crate::workspace::git(&current, &["init", "-q"]).unwrap();
        let command =
            execution_command(&source, &root, &current, &data, &session, &engine, &pi_dir).unwrap();
        let args = command
            .get_args()
            .map(|arg| arg.to_os_string())
            .collect::<Vec<_>>();
        let output = Command::new(BWRAP)
            .args(&args[..args.len() - 2])
            .args([
                "/bin/sh",
                "-c",
                "set -e; : <>/dev/null; test ! -e \"$1/package.json\"; echo ok > \"$2/write\"",
                "probe",
            ])
            .args([&source, &current])
            .current_dir(&current)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read_to_string(current.join("write")).unwrap(), "ok\n");
        assert!(source.join("package.json").is_file());
    }

    #[test]
    fn graph_nodes_are_isolated_from_source_siblings_and_sessions() {
        require_supported().expect("Linux Graph requires functional bwrap/user namespaces in CI");
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let source = base.join("source");
        let root = base.join(".grapher-worktrees");
        let current = root.join("run/current");
        let sibling = root.join("run/sibling");
        let data = base.join("runtime");
        let session = data.join("sessions/current");
        let other = data.join("sessions/other");
        let engine = base.join("engine");
        let pi_dir = base.join("pi-agent");
        let outside = base.join("outside");
        for path in [
            &source, &current, &sibling, &session, &other, &engine, &pi_dir, &outside,
        ] {
            fs::create_dir_all(path).unwrap();
            fs::write(path.join("marker"), "original").unwrap();
        }
        crate::workspace::git(&source, &["init", "-q"]).unwrap();
        crate::workspace::git(&current, &["init", "-q"]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&source, outside.join("source-link")).unwrap();
        let command =
            execution_command(&source, &root, &current, &data, &session, &engine, &pi_dir).unwrap();
        let args = command
            .get_args()
            .map(|a| a.to_os_string())
            .collect::<Vec<_>>();
        assert!(
            execution_command(
                &source,
                &root,
                &current,
                &data,
                &session,
                &engine,
                &crate::native::installation_root(),
            )
            .is_err(),
            "Pi config inside the read-only installation must fail closed"
        );
        let mut cmd = Command::new(BWRAP);
        cmd.args(&args[..args.len() - 2]); // keep production mounts through `--`
        cmd.args(["/bin/sh", "-c", "set -e; : <>/dev/null; test ! -f \"$1/marker\"; test ! -f \"/proc/1/root$1/marker\"; test ! -f \"$2/marker\"; test ! -f \"$3/marker\"; test ! -f \"$4/source-link/marker\"; ! (echo leak > \"$1/new\") 2>/dev/null; ! (echo leak > \"$2/new\") 2>/dev/null; echo ok > new; echo ok > \"$5/new\"; echo ok > \"$4/new\"; test -f \"$6/marker\"; test -f \"$7/marker\"; ! (echo leak > \"$7/marker\") 2>/dev/null", "probe"])
            .args([&source, &sibling, &other, &outside, &session, &pi_dir, &engine])
            .current_dir(&current);
        let output = cmd.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        // Git/Pi opens /dev/null; it must also work in the real node view.
        let git = Command::new(BWRAP)
            .args(&args[..args.len() - 2])
            .args(["git", "-C"])
            .arg(&current)
            .args(["rev-parse", "--is-inside-work-tree"])
            .current_dir(&current)
            .output()
            .unwrap();
        assert!(
            git.status.success(),
            "{}",
            String::from_utf8_lossy(&git.stderr)
        );
        assert_eq!(git.stdout, b"true\n");
        assert!(!source.join("new").exists());
        assert!(!sibling.join("new").exists());
        assert!(!other.join("new").exists());
        assert_eq!(
            fs::read_to_string(source.join("marker")).unwrap(),
            "original"
        );
        assert_eq!(fs::read_to_string(current.join("new")).unwrap(), "ok\n");
        assert_eq!(
            fs::read_to_string(engine.join("marker")).unwrap(),
            "original"
        );
    }
}
