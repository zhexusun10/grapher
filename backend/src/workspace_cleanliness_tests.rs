//! Acceptance regression for the workspace-cleanliness target: the slot the
//! agent sees is the project tree, and Grapher state lives outside it.

use std::{fs, path::{Path, PathBuf}};

fn source(temp: &tempfile::TempDir) -> PathBuf {
    let root = temp.path().join("source");
    fs::create_dir(&root).unwrap();
    crate::workspace::git(&root, &["init", "-q"]).unwrap();
    crate::workspace::project_git(&root, &["symbolic-ref", "HEAD", "refs/heads/feature/current"]).unwrap();
    crate::workspace::project_git(&root, &["config", "user.name", "Project Author"]).unwrap();
    crate::workspace::project_git(&root, &["config", "user.email", "project@example.invalid"]).unwrap();
    crate::workspace::project_git(&root, &["config", "core.autocrlf", "false"]).unwrap();
    fs::create_dir_all(root.join("src/empty")).unwrap();
    fs::write(root.join("src/main.txt"), "project\n").unwrap();
    fs::write(root.join(".env"), "native secret\n").unwrap();
    crate::workspace::git(&root, &["add", "-A"]).unwrap();
    crate::workspace::git(&root, &["commit", "-qm", "project history"]).unwrap();
    root
}

fn slot(temp: &tempfile::TempDir, name: &str) -> PathBuf {
    temp.path()
        .join(".grapher-worktrees")
        .join("48b8e1d1-2428-42a2-9b28-9d90f631f9d1")
        .join(name)
}

#[derive(Debug, PartialEq, Eq)]
enum Kind {
    Dir,
    File(Vec<u8>),
    Link(PathBuf),
}

/// Recursive project tree (relative path, kind, bytes). `.git` is compared by
/// the Git assertions instead: the source's repository and the slot's project
/// view are deliberately different storage for the same visible semantics.
fn tree(root: &Path) -> Vec<(String, Kind)> {
    fn walk(base: &Path, relative: &Path, out: &mut Vec<(String, Kind)>) {
        let mut entries = fs::read_dir(base.join(relative))
            .unwrap()
            .map(|entry| entry.unwrap())
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name();
            if relative.as_os_str().is_empty() && name == ".git" {
                continue;
            }
            let relative = relative.join(&name);
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            let key = relative.to_string_lossy().replace('\\', "/");
            if metadata.file_type().is_symlink() {
                out.push((key, Kind::Link(fs::read_link(&path).unwrap())));
            } else if metadata.is_dir() {
                out.push((key, Kind::Dir));
                walk(base, &relative, out);
            } else {
                out.push((key, Kind::File(fs::read(&path).unwrap())));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, Path::new(""), &mut out);
    out
}

#[test]
fn workspace_is_the_project_tree_and_runtime_state_reclaims_outside_it() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let source_head = crate::workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap();
    let source_index = fs::read(source.join(".git/index")).unwrap();
    let base = crate::workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "node-a");
    crate::workspace::prepare(&source, &target, &base, &[]).unwrap();

    // The visible slot is the source tree (project files plus a normal .git).
    assert_eq!(tree(&target), tree(&source));
    assert!(target.join(".git").is_dir());
    assert_eq!(
        crate::workspace::project_git(&target, &["symbolic-ref", "HEAD"]).unwrap(),
        "refs/heads/feature/current"
    );
    let refs = crate::workspace::project_git(&target, &["show-ref"]).unwrap();
    assert!(!refs.contains("refs/grapher/"), "{refs}");
    assert!(!refs.contains("refs/heads/grapher-node"), "{refs}");
    assert!(crate::workspace::project_git(&target, &["status", "--porcelain"]).unwrap().is_empty());

    // The managed environment materializes no state inside the project tree.
    let config = crate::environment_automatic::resolve(&source, false).unwrap().0.unwrap();
    assert!(config.launch.state_bound());
    let run = "48b8e1d1-2428-42a2-9b28-9d90f631f9d1";
    let store = crate::environment::Environments::new(&temp.path().join("data"), run, &config).unwrap();
    let initial = store.initialize(&source).unwrap();
    let generation = uuid::Uuid::new_v4().to_string();
    store.prepare(&target, &initial, &generation, &base, vec![], false, false).unwrap();

    assert_eq!(tree(&target), tree(&source), "environment must not change the project tree");
    assert!(!target.join(".agent-home").exists());
    assert!(!target.join(".runtime-cache").exists());
    let state = store.state_root(&target).unwrap();
    assert!(state.exists(), "{}", state.display());
    assert!(!crate::workspace::scope_contains(&state, &target), "{}", state.display());
    assert!(!crate::workspace::scope_contains(&target, &state), "{}", state.display());
    let launch = config.launch.expanded(&target);
    for key in ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CACHE_HOME", "npm_config_cache"] {
        assert!(crate::workspace::scope_contains(Path::new(&launch.variables[key]), &state), "{key}");
    }

    // Runtime-only writes under the state root do not enter the project view.
    fs::create_dir_all(state.join(".runtime-cache")).unwrap();
    fs::write(state.join(".runtime-cache/probe"), "runtime only").unwrap();
    assert_eq!(tree(&target), tree(&source), "runtime state must not enter the project tree");

    // Private work never mutates the bound source.
    assert_eq!(crate::workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap(), source_head);
    assert_eq!(fs::read(source.join(".git/index")).unwrap(), source_index);
    assert!(!source.join(".grapher-state").exists());

    // Reclaim removes the external state and leaves the project tree.
    crate::workspace_state::reclaim(&target).unwrap();
    assert!(!state.exists(), "{}", state.display());
    assert!(target.join("src/main.txt").is_file());
}

/// Windows path shape and file-state cases from the compatibility row: spaces,
/// non-ASCII names, readonly files and the visible Git view. Runs in the same
/// crate so it can use the public `workspace` entry points without touching the
/// running implementation files.
#[cfg(windows)]
#[test]
fn windows_spaces_unicode_and_readonly_paths_keep_the_project_view_clean() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().join("run 根目录");
    let source = base.join("源 项目 source");
    fs::create_dir_all(&source).unwrap();
    crate::workspace::git(&source, &["init", "-q"]).unwrap();
    crate::workspace::project_git(&source, &["symbolic-ref", "HEAD", "refs/heads/feature/current"]).unwrap();
    crate::workspace::project_git(&source, &["config", "user.name", "Project Author"]).unwrap();
    crate::workspace::project_git(&source, &["config", "user.email", "project@example.invalid"]).unwrap();
    fs::write(source.join("中文 文件.txt"), "unicode\n").unwrap();
    fs::write(source.join("readonly.txt"), "readonly\n").unwrap();
    let mut permissions = fs::metadata(source.join("readonly.txt")).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(source.join("readonly.txt"), permissions).unwrap();
    crate::workspace::git(&source, &["add", "-A"]).unwrap();
    crate::workspace::git(&source, &["commit", "-qm", "project history"]).unwrap();
    let base_commit = crate::workspace::snapshot_repository(&source).unwrap();
    let target = base
        .join(".grapher-worktrees")
        .join("48b8e1d1-2428-42a2-9b28-9d90f631f9d1")
        .join("node 源");
    crate::workspace::prepare(&source, &target, &base_commit, &[]).unwrap();

    assert_eq!(tree(&target), tree(&source));
    assert!(target.join("中文 文件.txt").is_file());
    assert!(fs::metadata(target.join("readonly.txt")).unwrap().permissions().readonly());
    assert!(target.join(".git").is_dir());
    assert!(!target.join(".agent-home").exists());
    assert!(!target.join(".runtime-cache").exists());
    assert!(!target.join(".grapher-state").exists());
    let refs = std::process::Command::new("git")
        .args(["show-ref"])
        .current_dir(&target)
        .output()
        .unwrap();
    let refs = String::from_utf8_lossy(&refs.stdout);
    assert!(!refs.contains("refs/grapher/"), "{refs}");
    assert!(!refs.contains("refs/heads/grapher-node"), "{refs}");
}

#[cfg(windows)]
#[test]
fn windows_case_alias_resolves_to_the_same_project_view() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = crate::workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "case-alias");
    let upper = PathBuf::from(source.to_string_lossy().to_ascii_uppercase());
    assert_ne!(upper, source);
    crate::workspace::prepare(&upper, &target, &base, &[]).unwrap();
    assert_eq!(tree(&target), tree(&source));
    assert!(target.join(".git").is_dir());
}

#[cfg(windows)]
#[test]
fn windows_extended_length_source_alias_resolves_to_the_same_project_view() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = crate::workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "extended-length");
    let extended = PathBuf::from(format!("\\\\?\\{}\\", source.display()));
    crate::workspace::prepare(&extended, &target, &base, &[]).unwrap();
    assert_eq!(tree(&target), tree(&source));
}

#[cfg(windows)]
#[test]
fn windows_locked_live_source_file_does_not_block_prepare() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = crate::workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "locked-file");
    // The bound base snapshot already owns the project bytes. A share-denied
    // live source file must not force preparation to read it or fail: the slot
    // is built from the snapshot, not from the live working tree.
    let locked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(source.join("src/main.txt"))
        .unwrap();
    crate::workspace::prepare(&source, &target, &base, &[]).unwrap();
    drop(locked);
    assert_eq!(fs::read(source.join("src/main.txt")).unwrap(), b"project\n");
    assert_eq!(tree(&target), tree(&source));
    assert!(target.join(".git").is_dir());
}

/// A raw user HEAD without a captured snapshot binds the live source folder
/// exactly as it is: uncommitted, untracked and ignored entries are included.
/// The source's Git status is never consulted. A frozen base is opt-in through
/// `snapshot_repository`, which production takes once during planning.
#[test]
fn raw_head_binds_the_live_source_as_is() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let raw_head = crate::workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap();
    fs::write(source.join("src/main.txt"), "dirty\n").unwrap();
    fs::write(source.join("untracked.txt"), "new\n").unwrap();
    let target = slot(&temp, "live-source");
    crate::workspace::prepare(&source, &target, &raw_head, &[]).unwrap();
    assert_eq!(fs::read(target.join("src/main.txt")).unwrap(), b"dirty\n");
    assert_eq!(fs::read(target.join("untracked.txt")).unwrap(), b"new\n");
    assert_eq!(fs::read(source.join("src/main.txt")).unwrap(), b"dirty\n");

    // A frozen base is opt-in: capture the folder, then reuse that snapshot even
    // after the live folder changes again.
    let base = crate::workspace::snapshot_repository(&source).unwrap();
    fs::write(source.join("src/main.txt"), "changed-after-snapshot\n").unwrap();
    let frozen = slot(&temp, "frozen-base");
    crate::workspace::prepare(&source, &frozen, &base, &[]).unwrap();
    assert_eq!(fs::read(frozen.join("src/main.txt")).unwrap(), b"dirty\n");
}
