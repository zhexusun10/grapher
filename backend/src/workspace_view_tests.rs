use super::*;

fn source(temp: &tempfile::TempDir) -> PathBuf {
    let root = temp.path().join("source");
    fs::create_dir(&root).unwrap();
    workspace::git(&root, &["init", "-q"]).unwrap();
    workspace::project_git(
        &root,
        &["symbolic-ref", "HEAD", "refs/heads/feature/current"],
    )
    .unwrap();
    workspace::project_git(&root, &["config", "user.name", "Project Author"]).unwrap();
    workspace::project_git(&root, &["config", "user.email", "project@example.invalid"]).unwrap();
    workspace::project_git(&root, &["config", "core.autocrlf", "false"]).unwrap();
    fs::write(root.join("tracked.txt"), "committed\n").unwrap();
    workspace::git(&root, &["add", "tracked.txt"]).unwrap();
    workspace::git(&root, &["commit", "-qm", "project history"]).unwrap();
    root
}
fn slot(temp: &tempfile::TempDir, name: &str) -> PathBuf {
    temp.path()
        .join(".grapher-worktrees")
        .join("48b8e1d1-2428-42a2-9b28-9d90f631f9d1")
        .join(name)
}
fn bytes(path: &Path) -> Vec<u8> {
    fs::read(path).unwrap()
}

#[test]
fn complete_project_view_keeps_dirty_index_names_bytes_and_native_git() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    fs::write(source.join("tracked.txt"), "staged\n").unwrap();
    workspace::git(&source, &["add", "tracked.txt"]).unwrap();
    fs::write(source.join("tracked.txt"), "unstaged\r\n").unwrap();
    fs::write(source.join(".gitignore"), "ignored/\n.venv/\n").unwrap();
    for (path, value) in [
        (".env", "native secret\n"),
        ("ignored/input", "ignored bytes\n"),
        (".venv/project-owned", "not runtime\n"),
        (".agent-home/native", "native home\n"),
        (".runtime-cache/native", "native cache\n"),
        (".grapher-project/config", "project config\n"),
    ] {
        fs::create_dir_all(source.join(path).parent().unwrap()).unwrap();
        fs::write(source.join(path), value).unwrap();
    }
    fs::create_dir_all(source.join("nested/empty")).unwrap();
    let user_head = workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap();
    let user_index = bytes(&source.join(".git/index"));
    let status =
        workspace::project_git(&source, &["status", "--porcelain", "--ignored", "-z"]).unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "node-a");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    assert!(target.join(".git").is_dir());
    assert!(target.join("nested/empty").is_dir());
    assert_eq!(
        workspace::project_git(&target, &["symbolic-ref", "HEAD"]).unwrap(),
        "refs/heads/feature/current"
    );
    assert_eq!(
        workspace::project_git(&target, &["rev-parse", "HEAD"]).unwrap(),
        user_head
    );
    assert_eq!(
        workspace::project_git(&target, &["status", "--porcelain", "--ignored", "-z"]).unwrap(),
        status
    );
    assert_eq!(
        workspace::project_git(&target, &["log", "--all", "--format=%s"]).unwrap(),
        "project history"
    );
    assert!(workspace::project_git(&target, &["cat-file", "-e", &base]).is_err());
    assert!(!target.join(".git/objects/info/alternates").exists());
    assert_eq!(bytes(&source.join(".git/index")), user_index);
    for file in [
        "tracked.txt",
        ".env",
        "ignored/input",
        ".venv/project-owned",
        ".agent-home/native",
        ".runtime-cache/native",
        ".grapher-project/config",
    ] {
        assert_eq!(
            bytes(&target.join(file)),
            bytes(&source.join(file)),
            "{file}"
        );
    }
    assert_eq!(
        workspace::git(&target, &["rev-parse", "HEAD"]).unwrap(),
        base
    );
    // Native Git and backend Git must not accidentally resolve the same index.
    assert_ne!(
        workspace::project_git(&target, &["rev-parse", "--git-dir"]).unwrap(),
        workspace::git(&target, &["rev-parse", "--git-dir"]).unwrap()
    );
}

#[test]
fn fork_inherits_explicit_project_commits_without_internal_snapshots() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let a = slot(&temp, "a");
    workspace::prepare(&source, &a, &base, &[]).unwrap();
    fs::write(a.join("tracked.txt"), "agent change\n").unwrap();
    workspace::project_git(&a, &["add", "tracked.txt"]).unwrap();
    workspace::project_git(&a, &["commit", "-qm", "actual task commit"]).unwrap();
    let agent_head = workspace::project_git(&a, &["rev-parse", "HEAD"]).unwrap();
    let result = workspace::snapshot_node(&a, &source, "a").unwrap();
    assert_eq!(
        workspace::project_git(&a, &["rev-parse", "HEAD"]).unwrap(),
        agent_head
    );
    let b = slot(&temp, "b");
    workspace::prepare(&source, &b, &result, &[]).unwrap();
    assert_eq!(
        workspace::project_git(&b, &["rev-parse", "HEAD"]).unwrap(),
        agent_head
    );
    assert_eq!(
        workspace::project_git(&b, &["log", "--all", "--format=%s"]).unwrap(),
        "actual task commit\nproject history"
    );
    assert!(workspace::project_git(&b, &["cat-file", "-e", &result]).is_err());
    fs::write(b.join("tracked.txt"), "independent fork\n").unwrap();
    assert_eq!(bytes(&a.join("tracked.txt")), b"agent change\n");
    assert_eq!(bytes(&source.join("tracked.txt")), b"committed\n");
}

#[test]
fn plain_project_stays_without_git_and_keeps_empty_directories() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("plain");
    fs::create_dir_all(source.join("empty")).unwrap();
    fs::write(source.join(".env"), "plain config\n").unwrap();
    let base = workspace::materialize_shadow_repo(&source, &[]).unwrap();
    let target = slot(&temp, "plain");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    assert!(!target.join(".git").exists());
    assert!(target.join("empty").is_dir());
    assert_eq!(bytes(&target.join(".env")), b"plain config\n");
    assert!(workspace::project_git(&target, &["rev-parse", "--show-toplevel"]).is_err());
    fs::write(target.join("result"), "task result").unwrap();
    let result = workspace::snapshot_node(&target, &source, "plain").unwrap();
    let fork = slot(&temp, "plain-fork");
    workspace::prepare(&source, &fork, &base, &[result]).unwrap();
    assert!(!fork.join(".git").exists());
    assert_eq!(bytes(&fork.join("result")), b"task result");
}

#[test]
fn automatic_environment_never_owns_same_named_project_files() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    fs::create_dir_all(source.join(".venv")).unwrap();
    fs::write(source.join(".venv/native"), "native project environment").unwrap();
    workspace::git(&source, &["add", "-f", ".venv/native"]).unwrap();
    workspace::git(&source, &["commit", "-qm", "native environment file"]).unwrap();
    let config = crate::environment_automatic::resolve(&source, false)
        .unwrap()
        .0
        .unwrap();
    assert!(config.launch.state_bound());
    assert!(config.exclusions().is_empty());
    config.check_tracked(&source).unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "environment");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    let run = "48b8e1d1-2428-42a2-9b28-9d90f631f9d1";
    let store =
        crate::environment::Environments::new(&temp.path().join("data"), run, &config).unwrap();
    let initial = store.initialize(&source).unwrap();
    assert_eq!(initial.domain.contract, "native-workspace-v4");
    let generation = uuid::Uuid::new_v4().to_string();
    let before = store
        .prepare(&target, &initial, &generation, &base, vec![], false, false)
        .unwrap();
    let state = store.state_root(&target).unwrap();
    let launch = config.launch.expanded(&target);
    for key in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CACHE_HOME",
        "npm_config_cache",
        "CONDA_ENVS_PATH",
    ] {
        assert!(
            workspace::scope_contains(Path::new(&launch.variables[key]), &state),
            "{key}"
        );
        assert!(
            !workspace::scope_contains(Path::new(&launch.variables[key]), &target),
            "{key}"
        );
    }
    assert!(!target.join(".agent-home").exists());
    assert!(!target.join(".runtime-cache").exists());
    fs::create_dir_all(state.join(".agent-home")).unwrap();
    fs::write(state.join(".agent-home/config"), "inherited state").unwrap();
    fs::create_dir_all(state.join(".runtime-cache/npm")).unwrap();
    fs::write(state.join(".runtime-cache/npm/cache"), "rebuildable").unwrap();
    let after = store.seal(&target, &before, &base, vec![]).unwrap();
    store
        .verify_view(&target, &after.launch_ref, &after.environment_ref)
        .unwrap();
    fs::write(state.join(".runtime-cache/npm/cache"), "cache changed").unwrap();
    store
        .verify_view(&target, &after.launch_ref, &after.environment_ref)
        .unwrap();
    assert_eq!(
        bytes(&target.join(".venv/native")),
        b"native project environment"
    );
    assert!(store.exclusions(&after.launch_ref).unwrap().is_empty());
}

#[test]
fn fan_in_preserves_each_parents_staging_without_committing_it_to_user_history() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let a = slot(&temp, "staging-a");
    let b = slot(&temp, "staging-b");
    workspace::prepare(&source, &a, &base, &[]).unwrap();
    workspace::prepare(&source, &b, &base, &[]).unwrap();
    fs::write(a.join("a.txt"), "staged a").unwrap();
    workspace::project_git(&a, &["add", "a.txt"]).unwrap();
    fs::write(b.join("b.txt"), "staged b").unwrap();
    workspace::project_git(&b, &["add", "b.txt"]).unwrap();
    let ah = workspace::snapshot_node(&a, &source, "a").unwrap();
    let bh = workspace::snapshot_node(&b, &source, "b").unwrap();
    let target = slot(&temp, "staging-join");
    workspace::prepare(&source, &target, &base, &[ah, bh]).unwrap();
    assert_eq!(
        workspace::project_git(&target, &["diff", "--cached", "--name-only"]).unwrap(),
        "a.txt\nb.txt"
    );
    assert_eq!(
        workspace::project_git(&target, &["log", "--all", "--format=%s"]).unwrap(),
        "project history"
    );
}

#[test]
fn fan_in_merges_real_task_commits_not_graph_snapshots() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let mut results = Vec::new();
    for label in ["a", "b"] {
        let path = slot(&temp, label);
        workspace::prepare(&source, &path, &base, &[]).unwrap();
        fs::write(path.join(label), label).unwrap();
        workspace::project_git(&path, &["add", label]).unwrap();
        workspace::project_git(&path, &["commit", "-qm", &format!("task {label}")]).unwrap();
        results.push(workspace::snapshot_node(&path, &source, label).unwrap());
    }
    let target = slot(&temp, "commit-join");
    workspace::prepare(&source, &target, &base, &results).unwrap();
    let log = workspace::project_git(&target, &["log", "--all", "--format=%s"]).unwrap();
    for label in ["task a", "task b", "project history"] {
        assert!(log.contains(label), "{log}");
    }
    assert!(!log.contains("snapshot"), "{log}");
    for head in results {
        assert!(workspace::project_git(&target, &["cat-file", "-e", &head]).is_err());
    }
    assert!(workspace::project_git(&target, &["status", "--porcelain"])
        .unwrap()
        .is_empty());
}

#[test]
fn metadata_only_changes_get_an_immutable_reference_and_survive_fork() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let a = slot(&temp, "metadata-a");
    workspace::prepare(&source, &a, &base, &[]).unwrap();
    fs::create_dir_all(a.join("new-empty/nested")).unwrap();
    let result = workspace::snapshot_node(&a, &source, "a").unwrap();
    assert_ne!(base, result);
    let b = slot(&temp, "metadata-b");
    workspace::prepare(&source, &b, &result, &[]).unwrap();
    assert!(b.join("new-empty/nested").is_dir());
    verify_result(
        &b,
        &source,
        &workspace::git(&b, &["rev-parse", "HEAD"]).unwrap(),
    )
    .unwrap();
}

#[test]
fn git_configuration_literal_values_are_not_path_rewritten() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    workspace::project_git(&source, &["config", "user.name", "Literal {workspace}"]).unwrap();
    workspace::project_git(
        &source,
        &["config", "remote.self.url", source.to_str().unwrap()],
    )
    .unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "literal-settings");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    for key in ["user.name", "remote.self.url"] {
        assert_eq!(
            workspace::project_git(&target, &["config", "--get", key]).unwrap(),
            workspace::project_git(&source, &["config", "--get", key]).unwrap()
        );
    }
}

#[test]
fn worktree_specific_git_configuration_survives_private_rebinding() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    workspace::project_git(&source, &["config", "extensions.worktreeConfig", "true"]).unwrap();
    workspace::project_git(
        &source,
        &["config", "--local", "user.name", "Common author"],
    )
    .unwrap();
    workspace::project_git(
        &source,
        &["config", "--worktree", "user.name", "Worktree author"],
    )
    .unwrap();
    workspace::project_git(
        &source,
        &[
            "config",
            "--worktree",
            "core.worktree",
            source.to_str().unwrap(),
        ],
    )
    .unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "worktree-settings");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    assert_eq!(
        workspace::project_git(&target, &["config", "--get", "user.name"]).unwrap(),
        "Worktree author"
    );
    assert_eq!(
        workspace::project_git(&target, &["config", "--local", "--get", "user.name"]).unwrap(),
        "Common author"
    );
    validate_ready(&target, &source).unwrap();
    assert!(crate::path_identity::same_path(
        Path::new(&workspace::project_git(&target, &["rev-parse", "--show-toplevel"]).unwrap()),
        &target
    ));
}

#[test]
fn linked_source_keeps_a_gitfile_bound_only_to_private_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let main = source(&temp);
    let source = temp.path().join("linked-source");
    workspace::git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "linked",
            source.to_str().unwrap(),
        ],
    )
    .unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "linked");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    let main_ref =
        workspace::project_git(&main, &["rev-parse", "--symbolic-full-name", "HEAD"]).unwrap();
    let native_git = PathBuf::from(
        workspace::project_git(&target, &["rev-parse", "--absolute-git-dir"]).unwrap(),
    );
    assert_eq!(
        bytes(&native_git.join("logs").join(&main_ref)),
        bytes(&main.join(".git/logs").join(&main_ref)),
        "linked copy must retain common branch reflogs"
    );
    let native_file = fs::symlink_metadata(target.join(".git")).unwrap();
    let original_file = fs::symlink_metadata(source.join(".git")).unwrap();
    assert_eq!(mode(&native_file), mode(&original_file));
    assert_eq!(
        crate::workspace_metadata::capture(&target.join(".git"), &native_file).unwrap(),
        crate::workspace_metadata::capture(&source.join(".git"), &original_file).unwrap()
    );
    assert!(target.join(".git").is_file());
    validate_ready(&target, &source).unwrap();
    let metadata = workspace::project_git(&target, &["rev-parse", "--absolute-git-dir"]).unwrap();
    assert!(workspace::scope_contains(
        Path::new(&metadata),
        &crate::workspace_state::process_root(&target).unwrap()
    ));
    assert_eq!(
        workspace::project_git(&target, &["branch", "--show-current"]).unwrap(),
        "linked"
    );
}

#[cfg(windows)]
#[cfg(windows)]
#[test]
fn efs_encrypted_entries_stay_encrypted_and_readable() {
    use std::os::windows::fs::MetadataExt;
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let file = source.join("tracked.txt");
    if let Err(error) = crate::workspace_metadata::set_encrypted(&file, true) {
        // The host volume genuinely lacks EFS; report it instead of pretending.
        eprintln!("EFS is unavailable on this Windows host volume: {error}");
        return;
    }
    assert_ne!(
        fs::symlink_metadata(&file).unwrap().file_attributes() & 0x4000,
        0
    );
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "efs");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    let metadata = fs::symlink_metadata(target.join("tracked.txt")).unwrap();
    assert_ne!(
        metadata.file_attributes() & 0x4000,
        0,
        "private project entry lost native EFS encryption"
    );
    assert_eq!(bytes(&target.join("tracked.txt")), b"committed\n");
    let result = workspace::snapshot_node(&target, &source, "efs").unwrap();
    let fork = slot(&temp, "efs-fork");
    workspace::prepare(&source, &fork, &result, &[]).unwrap();
    assert_ne!(
        fs::symlink_metadata(fork.join("tracked.txt"))
            .unwrap()
            .file_attributes()
            & 0x4000,
        0
    );
}

#[test]
fn named_streams_and_readonly_flags_survive_private_materialization() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    fs::write(source.join("tracked.txt:business"), "native stream").unwrap();
    let mut permissions = fs::metadata(source.join("tracked.txt"))
        .unwrap()
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(source.join("tracked.txt"), permissions).unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "streams");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    assert_eq!(
        bytes(&target.join("tracked.txt:business")),
        b"native stream"
    );
    assert!(fs::metadata(target.join("tracked.txt"))
        .unwrap()
        .permissions()
        .readonly());
}

#[test]
fn plain_conflict_noop_does_not_manufacture_completion_or_a_git_entry() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("plain-conflict");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("file"), "base\n").unwrap();
    let base = workspace::materialize_shadow_repo(&source, &[]).unwrap();
    let mut results = Vec::new();
    for label in ["a", "b"] {
        let path = slot(&temp, label);
        workspace::prepare(&source, &path, &base, &[]).unwrap();
        fs::write(path.join("file"), format!("{label}\n")).unwrap();
        results.push(workspace::snapshot_node(&path, &source, label).unwrap());
    }
    let target = slot(&temp, "plain-conflict-join");
    assert!(workspace::prepare(&source, &target, &base, &results).is_err());
    prepare_conflicts(&source, &target).unwrap();
    assert!(import_resolution(&target)
        .unwrap_err()
        .contains("refusing synthetic completion"));
    assert!(
        !workspace::git(&target, &["diff", "--name-only", "--diff-filter=U"])
            .unwrap()
            .is_empty()
    );
    fs::write(target.join("file"), "resolved\n").unwrap();
    import_resolution(&target).unwrap();
    assert!(
        workspace::git(&target, &["diff", "--name-only", "--diff-filter=U"])
            .unwrap()
            .is_empty()
    );
    assert!(!target.join(".git").exists());
}

#[test]
fn source_alternates_are_imported_without_borrowed_dangling_snapshot_objects() {
    let temp = tempfile::tempdir().unwrap();
    let pool = source(&temp);
    let hidden = workspace::project_git_bytes(
        &pool,
        &["hash-object", "-w", "--stdin"],
        Some(b"internal bookkeeping must not leak"),
    )
    .unwrap();
    let hidden = String::from_utf8(hidden).unwrap().trim().to_string();
    let source = temp.path().join("borrowed");
    workspace::project_git(
        &pool,
        &[
            "clone",
            "--shared",
            "-q",
            pool.to_str().unwrap(),
            source.to_str().unwrap(),
        ],
    )
    .unwrap();
    fs::write(source.join("staged-only"), "staged business").unwrap();
    workspace::project_git(&source, &["add", "staged-only"]).unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "alternate-free");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    assert!(!target.join(".git/objects/info/alternates").exists());
    assert_eq!(
        workspace::project_git(&target, &["log", "--all", "--format=%s"]).unwrap(),
        "project history"
    );
    assert_eq!(
        workspace::project_git(&target, &["show", ":staged-only"]).unwrap(),
        "staged business"
    );
    assert!(workspace::project_git(&target, &["cat-file", "-e", &hidden]).is_err());
    workspace::project_git(&target, &["fsck", "--full", "--no-dangling"]).unwrap();
}

#[cfg(unix)]
#[test]
fn named_pipes_are_reconstructed_and_deleted_by_task_state_without_blocking() {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let fifo = source.join("events");
    let value = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(value.as_ptr(), 0o640) }, 0);
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "fifo");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    let metadata = fs::symlink_metadata(target.join("events")).unwrap();
    assert!(metadata.file_type().is_fifo());
    assert_eq!(metadata.permissions().mode() & 0o777, 0o640);
    let result = workspace::snapshot_node(&target, &source, "fifo").unwrap();
    let fork = slot(&temp, "fifo-fork");
    workspace::prepare(&source, &fork, &result, &[]).unwrap();
    assert!(fs::symlink_metadata(fork.join("events"))
        .unwrap()
        .file_type()
        .is_fifo());
    fs::remove_file(target.join("events")).unwrap();
    let deleted = workspace::snapshot_node(&target, &source, "fifo-delete").unwrap();
    let removed = slot(&temp, "fifo-removed");
    workspace::prepare(&source, &removed, &deleted, &[]).unwrap();
    assert!(fs::symlink_metadata(removed.join("events")).is_err());
    assert!(fs::symlink_metadata(fork.join("events"))
        .unwrap()
        .file_type()
        .is_fifo());
}

#[cfg(unix)]
#[test]
fn symbolic_git_directories_are_rebound_to_private_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let shared = temp.path().join("shared-git");
    fs::rename(source.join(".git"), &shared).unwrap();
    std::os::unix::fs::symlink(&shared, source.join(".git")).unwrap();
    let branch = workspace::project_git(&source, &["branch", "--show-current"]).unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "git-link");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    let metadata = fs::symlink_metadata(target.join(".git")).unwrap();
    assert!(metadata.file_type().is_symlink());
    let resolved = target.join(".git").canonicalize().unwrap();
    assert!(workspace::scope_contains(
        &resolved,
        &crate::workspace_state::process_root(&target).unwrap()
    ));
    assert_eq!(
        workspace::project_git(&target, &["branch", "--show-current"]).unwrap(),
        branch
    );
    assert_eq!(
        workspace::project_git(&target, &["log", "--format=%s"]).unwrap(),
        "project history"
    );
    workspace::project_git(&target, &["config", "user.name", "Private"]).unwrap();
    workspace::project_git(
        &target,
        &["config", "user.email", "private@example.invalid"],
    )
    .unwrap();
    fs::write(target.join("task"), "private").unwrap();
    workspace::project_git(&target, &["add", "task"]).unwrap();
    workspace::project_git(&target, &["commit", "-qm", "private task"]).unwrap();
    assert_eq!(
        workspace::project_git(&source, &["log", "--format=%s"]).unwrap(),
        "project history"
    );
    assert!(workspace::project_git(&source, &["cat-file", "-e", "HEAD:task"]).is_err());
    let result = workspace::snapshot_node(&target, &source, "git-link").unwrap();
    let fork = slot(&temp, "git-link-fork");
    workspace::prepare(&source, &fork, &result, &[]).unwrap();
    assert!(fs::symlink_metadata(fork.join(".git"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        workspace::project_git(&fork, &["log", "-1", "--format=%s"]).unwrap(),
        "private task"
    );
}

#[cfg(unix)]
#[test]
fn task_changes_to_special_entries_fail_instead_of_being_silently_unpublished() {
    use std::os::unix::ffi::OsStrExt;
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let fifo = source.join("events");
    let value = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(value.as_ptr(), 0o600) }, 0);
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "fifo-task");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    fs::remove_file(target.join("events")).unwrap();
    let error = workspace::snapshot_node(&target, &source, "fifo-task").unwrap_err();
    assert!(
        error.contains("files-only publication cannot deliver"),
        "{error}"
    );
}

#[test]
fn nested_repositories_keep_native_history_and_staging_without_graph_objects() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let nested = source.join("nested");
    fs::create_dir(&nested).unwrap();
    workspace::project_git(&nested, &["init", "-q"]).unwrap();
    fs::write(nested.join("business"), "base").unwrap();
    workspace::project_git(&nested, &["add", "business"]).unwrap();
    workspace::project_git(&nested, &["commit", "-qm", "nested history"]).unwrap();
    fs::write(nested.join("business"), "staged").unwrap();
    workspace::project_git(&nested, &["add", "business"]).unwrap();
    fs::write(nested.join("business"), "dirty").unwrap();
    fs::create_dir(nested.join("empty")).unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "nested");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    let child = target.join("nested");
    assert!(child.join(".git").is_dir());
    assert!(child.join("empty").is_dir());
    assert_eq!(
        workspace::project_git(&child, &["log", "--all", "--format=%s"]).unwrap(),
        "nested history"
    );
    assert_eq!(
        workspace::project_git(&child, &["show", ":business"]).unwrap(),
        "staged"
    );
    assert_eq!(bytes(&child.join("business")), b"dirty");
    assert!(workspace::project_git(&child, &["cat-file", "-e", &base]).is_err());
    fs::write(child.join("business"), "task").unwrap();
    workspace::project_git(&child, &["add", "business"]).unwrap();
    let result = workspace::snapshot_node(&target, &source, "nested").unwrap();
    let fork = slot(&temp, "nested-fork");
    workspace::prepare(&source, &fork, &result, &[]).unwrap();
    assert_eq!(
        workspace::project_git(&fork.join("nested"), &["show", ":business"]).unwrap(),
        "task"
    );
    assert_eq!(bytes(&source.join("nested/business")), b"dirty");
}

#[test]
fn submodules_rebind_gitfiles_and_preserve_dirty_project_contents() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let seed = temp.path().join("dependency");
    fs::create_dir(&seed).unwrap();
    workspace::project_git(&seed, &["init", "-q"]).unwrap();
    fs::write(seed.join("business"), "dependency").unwrap();
    workspace::project_git(&seed, &["add", "business"]).unwrap();
    workspace::project_git(&seed, &["commit", "-qm", "dependency history"]).unwrap();
    workspace::project_git(
        &source,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            seed.to_str().unwrap(),
            "modules/dependency",
        ],
    )
    .unwrap();
    workspace::project_git(&source, &["commit", "-qam", "project dependency"]).unwrap();
    fs::write(
        source.join("modules/dependency/business"),
        "dirty dependency",
    )
    .unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "submodule");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    let child = target.join("modules/dependency");
    assert!(child.join(".git").is_file());
    assert_eq!(bytes(&child.join("business")), b"dirty dependency");
    let metadata = PathBuf::from(
        workspace::project_git(&child, &["rev-parse", "--absolute-git-dir"]).unwrap(),
    );
    assert!(workspace::scope_contains(
        &metadata,
        &crate::workspace_state::process_root(&target).unwrap()
    ));
    assert_eq!(
        workspace::project_git(&child, &["log", "--format=%s"]).unwrap(),
        "dependency history"
    );
    assert!(workspace::project_git(&target, &["submodule", "status"])
        .unwrap()
        .contains("modules/dependency"));
    fs::write(child.join("business"), "private dependency task").unwrap();
    workspace::project_git(&child, &["add", "business"]).unwrap();
    workspace::project_git(&child, &["commit", "-qm", "dependency task commit"]).unwrap();
    let result = workspace::snapshot_node(&target, &source, "submodule").unwrap();
    let fork = slot(&temp, "submodule-fork");
    workspace::prepare(&source, &fork, &result, &[]).unwrap();
    assert_eq!(
        workspace::project_git(
            &fork.join("modules/dependency"),
            &["log", "-1", "--format=%s"]
        )
        .unwrap(),
        "dependency task commit"
    );
    assert_eq!(
        bytes(&fork.join("modules/dependency/business")),
        b"private dependency task"
    );
    validate_ready(&fork, &source).unwrap();
    assert_eq!(
        bytes(&source.join("modules/dependency/business")),
        b"dirty dependency"
    );
}

#[test]
fn native_directory_links_rebind_to_the_private_project_and_survive_fork() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    fs::create_dir(source.join("assets")).unwrap();
    fs::write(source.join("assets/business"), "source").unwrap();
    crate::path_safety::directory_link(&source.join("assets"), &source.join("alias"));
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "native-links");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    assert!(crate::workspace_symlinks::is_link(
        &fs::symlink_metadata(target.join("alias")).unwrap()
    ));
    assert!(crate::path_identity::same_path(
        &target.join("alias"),
        &target.join("assets")
    ));
    fs::write(target.join("alias/business"), "private task").unwrap();
    assert_eq!(bytes(&target.join("assets/business")), b"private task");
    assert_eq!(bytes(&source.join("assets/business")), b"source");
    let result = workspace::snapshot_node(&target, &source, "native-links").unwrap();
    let fork = slot(&temp, "native-link-fork");
    workspace::prepare(&source, &fork, &result, &[]).unwrap();
    assert!(crate::path_identity::same_path(
        &fork.join("alias"),
        &fork.join("assets")
    ));
    fs::write(fork.join("alias/business"), "fork only").unwrap();
    assert_eq!(bytes(&fork.join("assets/business")), b"fork only");
    assert_eq!(bytes(&target.join("assets/business")), b"private task");
}

#[test]
fn git_config_subsections_with_dots_and_absolute_includes_survive_rebinding() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let included = temp.path().join("included.cfg");
    fs::write(&included, "[included]\n\tvalue = from-absolute-file\n").unwrap();
    workspace::project_git(
        &source,
        &["config", "remote.dotted.name.url", "ssh://example/repo"],
    )
    .unwrap();
    workspace::project_git(
        &source,
        &[
            "config",
            "--add",
            "include.path",
            included.to_str().unwrap(),
        ],
    )
    .unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "config-includes");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    for key in ["remote.dotted.name.url", "included.value"] {
        assert_eq!(
            workspace::project_git(&target, &["config", "--get", key]).unwrap(),
            workspace::project_git(&source, &["config", "--get", key]).unwrap(),
            "{key}"
        );
    }
}

#[test]
fn relative_git_includes_and_matched_conditional_includes_fail_instead_of_being_ignored() {
    let relative_temp = tempfile::tempdir().unwrap();
    let relative = source(&relative_temp);
    fs::write(
        relative_temp.path().join("outside.cfg"),
        "[outside]
	value = yes
",
    )
    .unwrap();
    workspace::project_git(
        &relative,
        &["config", "--add", "include.path", "../outside.cfg"],
    )
    .unwrap();
    let error = workspace::snapshot_repository(&relative).unwrap_err();
    assert!(error.contains("relative Git include"), "{error}");

    let matched_temp = tempfile::tempdir().unwrap();
    let conditional = source(&matched_temp);
    let included = matched_temp.path().join("matched.cfg");
    fs::write(
        &included,
        "[matched]
	value = yes
",
    )
    .unwrap();
    let git_dir =
        workspace::project_git(&conditional, &["rev-parse", "--absolute-git-dir"]).unwrap();
    workspace::project_git(
        &conditional,
        &[
            "config",
            &format!("includeif.gitdir:{}.path", git_dir.replace('\\', "/")),
            included.to_str().unwrap(),
        ],
    )
    .unwrap();
    let error = workspace::snapshot_repository(&conditional).unwrap_err();
    assert!(error.contains("matched conditional Git include"), "{error}");

    let unmatched_temp = tempfile::tempdir().unwrap();
    let unmatched = source(&unmatched_temp);
    workspace::project_git(
        &unmatched,
        &[
            "config",
            "includeif.gitdir:/definitely/not/this/repository/.git/.path",
            included.to_str().unwrap(),
        ],
    )
    .unwrap();
    workspace::snapshot_repository(&unmatched).unwrap();
}

#[cfg(unix)]
#[test]
fn live_unix_sockets_are_refused_without_exposing_a_partial_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let _listener = std::os::unix::net::UnixListener::bind(source.join("runtime.sock")).unwrap();
    let error = workspace::snapshot_repository(&source).unwrap_err();
    assert!(error.contains("live Unix socket"), "{error}");
}

#[test]
fn implicit_ancestor_git_is_refused_before_a_partial_workspace_is_exposed() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("parent-repo");
    fs::create_dir(&parent).unwrap();
    workspace::project_git(&parent, &["init", "-q"]).unwrap();
    let project = parent.join("project");
    fs::create_dir(&project).unwrap();
    fs::write(project.join("business.txt"), "nested project").unwrap();
    let error = workspace::snapshot_repository(&project).unwrap_err();
    assert!(error.contains("implicit ancestor Git"), "{error}");
}

#[test]
fn broken_nested_git_metadata_is_reported_instead_of_silently_omitted() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let nested = source.join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join(".git"), "gitdir: does-not-exist\n").unwrap();
    assert!(workspace::snapshot_repository(&source).is_err());
}

#[test]
fn large_external_hardlink_counts_are_retained_and_released_with_the_slot_state() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    for index in 0..16 {
        fs::hard_link(
            source.join("tracked.txt"),
            outside.join(format!("external-{index}")),
        )
        .unwrap();
    }
    for index in 0..32 {
        fs::hard_link(
            source.join("tracked.txt"),
            source.join(format!("alias-{index}")),
        )
        .unwrap();
    }
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "many-links");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    let identity = crate::workspace_metadata::file_identity(
        &target.join("tracked.txt"),
        &fs::metadata(target.join("tracked.txt")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        identity.1, 49,
        "32 project aliases + 16 external links + target"
    );
    let state = crate::workspace_state::root(&target).unwrap();
    assert!(state.join("project-links").is_dir());
    eprintln!(
        "witnesses={}",
        fs::read_dir(state.join("project-links")).unwrap().count()
    );
    eprintln!(
        "external before={:?}",
        crate::workspace_metadata::file_identity(
            &outside.join("external-0"),
            &fs::metadata(outside.join("external-0")).unwrap()
        )
        .unwrap()
    );
    crate::workspace_state::reclaim(&target).unwrap();
    assert!(!state.exists());
    eprintln!(
        "state removed={} external after={:?}",
        !state.exists(),
        crate::workspace_metadata::file_identity(
            &outside.join("external-0"),
            &fs::metadata(outside.join("external-0")).unwrap()
        )
        .unwrap()
    );
    // Releasing the slot state removes the witnesses that mirrored the
    // external link count; the private inode keeps only its in-project links.
    let private = target.join("tracked.txt");
    let metadata = fs::metadata(&private).unwrap();
    assert_eq!(
        crate::workspace_metadata::file_identity(&private, &metadata)
            .unwrap()
            .1,
        33
    );
    assert_eq!(
        crate::workspace_metadata::file_identity(
            &outside.join("external-0"),
            &fs::metadata(outside.join("external-0")).unwrap()
        )
        .unwrap()
        .1,
        49,
        "the source inode is independent of the private witnesses"
    );
}

#[test]
fn old_unhashed_state_directories_are_never_read_or_rewritten() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "state-legacy");
    let run = target.parent().unwrap();
    let old = run.join(".grapher-state").join("state-legacy");
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("keep.txt"), "old data").unwrap();
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    assert_eq!(
        fs::read_to_string(old.join("keep.txt")).unwrap(),
        "old data"
    );
    assert_ne!(crate::workspace_state::root(&target).unwrap(), old);
    assert!(crate::workspace_state::process_root(&target)
        .unwrap()
        .is_dir());
}

#[test]
fn hardlinks_keep_alias_semantics_and_counts_without_sharing_source_or_sibling_inodes() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    fs::hard_link(source.join("tracked.txt"), source.join("same-inode")).unwrap();
    fs::hard_link(
        source.join("tracked.txt"),
        temp.path().join("outside-alias"),
    )
    .unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "hardlinks");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    let identity = |path: &Path| {
        crate::workspace_metadata::file_identity(path, &fs::metadata(path).unwrap()).unwrap()
    };
    let id = identity(&target.join("tracked.txt"));
    assert_eq!(id.1, 3);
    assert_eq!(id, identity(&target.join("same-inode")));
    assert_ne!(id.0, identity(&source.join("tracked.txt")).0);
    fs::write(target.join("tracked.txt"), "private task").unwrap();
    assert_eq!(bytes(&target.join("same-inode")), b"private task");
    assert_ne!(bytes(&source.join("tracked.txt")), b"private task");
    let result = workspace::snapshot_node(&target, &source, "hardlinks").unwrap();
    let fork = slot(&temp, "hardlink-fork");
    workspace::prepare(&source, &fork, &result, &[]).unwrap();
    assert_eq!(identity(&fork.join("tracked.txt")).1, 3);
    assert_ne!(identity(&fork.join("tracked.txt")).0, id.0);
    fs::write(fork.join("same-inode"), "fork only").unwrap();
    assert_eq!(bytes(&fork.join("tracked.txt")), b"fork only");
    assert_eq!(bytes(&target.join("tracked.txt")), b"private task");
}

#[test]
fn missing_or_corrupt_view_evidence_fails_without_exposing_graph_git() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let record = record_path(&source, &base).unwrap();
    fs::write(record.join("checksum"), "damaged").unwrap();
    let target = slot(&temp, "refused");
    assert!(workspace::prepare(&source, &target, &base, &[])
        .unwrap_err()
        .contains("Damaged project-view"));
    assert!(!target.join(".git").exists());
    assert!(!is_bound(&target));
    assert_eq!(
        workspace::project_git(&source, &["log", "--format=%s"]).unwrap(),
        "project history"
    );
}
