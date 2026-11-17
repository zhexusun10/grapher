use super::*;

const RUN_ID: &str = "48b8e1d1-2428-42a2-9b28-9d90f631f9d1";

mod environment_probe {
    include!("workspace_view/environment_probe.rs");
}

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
// Repositories created outside `source` are committed to directly, so they need
// an explicit author identity: CI runners have no global Git identity.
fn configure_author(repo: &Path) {
    workspace::project_git(repo, &["config", "user.name", "Project Author"]).unwrap();
    workspace::project_git(repo, &["config", "user.email", "project@example.invalid"]).unwrap();
    workspace::project_git(repo, &["config", "core.autocrlf", "false"]).unwrap();
}
fn slot(temp: &tempfile::TempDir, name: &str) -> PathBuf {
    temp.path()
        .join(".grapher-worktrees")
        .join(RUN_ID)
        .join(name)
}
fn bytes(path: &Path) -> Vec<u8> {
    fs::read(path).unwrap()
}

#[test]
fn parallel_project_collection_survives_snapshot_and_fork() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    // Exercise the parallel collector through real snapshot/materialization,
    // not just through its independent worker tests.
    for index in 0..300 {
        fs::write(source.join(format!("file-{index:04}.txt")), "before\n").unwrap();
    }
    let user_head = workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap();
    let user_index = bytes(&source.join(".git/index"));
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&temp, "parallel-collection");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    fs::write(node.join("file-0000.txt"), "after!\n").unwrap();
    fs::remove_file(node.join("file-0299.txt")).unwrap();
    fs::write(node.join("- new 中文.txt"), b"raw\0bytes\xff\r\n").unwrap();
    let head = workspace::snapshot_node(&node, &source, "parallel-collection").unwrap();
    let child = slot(&temp, "parallel-fork");
    workspace::prepare(&source, &child, &base, &[head]).unwrap();
    assert_eq!(bytes(&child.join("file-0000.txt")), b"after!\n");
    for index in 1..299 {
        assert_eq!(
            bytes(&child.join(format!("file-{index:04}.txt"))),
            b"before\n"
        );
    }
    assert!(!child.join("file-0299.txt").exists());
    assert_eq!(bytes(&child.join("- new 中文.txt")), b"raw\0bytes\xff\r\n");
    assert_eq!(bytes(&source.join("file-0000.txt")), b"before\n");
    assert!(source.join("file-0299.txt").is_file());
    assert!(!source.join("- new 中文.txt").exists());
    assert_eq!(bytes(&source.join(".git/index")), user_index);
    assert_eq!(
        workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap(),
        user_head
    );
}

#[test]
fn source_capture_keeps_identity_checks_and_revalidates_live_files() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let tree =
        workspace::repository_git(&source, &["rev-parse", &format!("{base}^{{tree}}")]).unwrap();
    let head = workspace::repository_git(
        &source,
        &["commit-tree", &tree, "-p", &base, "-m", "capture identity"],
    )
    .unwrap();
    let target = record_path(&source, &head).unwrap();
    let view = inspect_scoped(&source, &source, &[]).unwrap();
    let identity = view_identity(&view).unwrap();
    let user_head = workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap();
    let user_index = bytes(&source.join(".git/index"));

    let error = capture_source(&source, &head, "wrong identity").unwrap_err();
    assert!(error.contains("Source changed while capturing"), "{error}");
    assert!(!target.exists());
    // An unspecified identity accepts a freshly inspected view, while an
    // explicit matching identity reuses its immutable evidence unchanged.
    capture_source_scoped(&source, &head, &[]).unwrap();
    let recorded = bytes(&target.join("view.json"));
    let checksum = bytes(&target.join("checksum"));
    capture_source_with_view(&source, &head, &identity, &[], view.clone()).unwrap();
    assert_eq!(bytes(&target.join("view.json")), recorded);
    assert_eq!(bytes(&target.join("checksum")), checksum);

    let next = workspace::repository_git(
        &source,
        &["commit-tree", &tree, "-p", &head, "-m", "stale capture"],
    )
    .unwrap();
    fs::write(source.join("tracked.txt"), "changed after inspection\n").unwrap();
    let error = capture_source_with_view(&source, &next, &identity, &[], view).unwrap_err();
    assert!(
        error.contains("Source changed while copying project Git"),
        "{error}"
    );
    assert!(!record_path(&source, &next).unwrap().exists());
    assert_eq!(
        bytes(&source.join("tracked.txt")),
        b"changed after inspection\n"
    );
    assert_eq!(bytes(&source.join(".git/index")), user_index);
    assert_eq!(
        workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap(),
        user_head
    );
    assert_eq!(bytes(&target.join("view.json")), recorded);
    assert_eq!(bytes(&target.join("checksum")), checksum);
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
fn node_snapshot_staging_matches_fresh_scan_and_refreshes_between_attempts() {
    for format in ["plain", "sha1", "sha256"] {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("tracked.txt"), "initial\r\n").unwrap();
        fs::write(source.join("removed.txt"), "remove me").unwrap();
        fs::write(source.join(".gitignore"), "ignored/\n").unwrap();
        fs::write(source.join(".gitattributes"), "*.txt text eol=lf\n").unwrap();
        if format != "plain" {
            let result = workspace::git(
                &source,
                &["init", "-q", &format!("--object-format={format}")],
            );
            if format == "sha256" && result.is_err() {
                continue; // Older system Git lacks SHA-256 support.
            }
            result.unwrap();
            configure_author(&source);
            workspace::project_git(&source, &["add", "."]).unwrap();
            workspace::project_git(&source, &["commit", "-qm", "source"]).unwrap();
        }
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = slot(&temp, "node");
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        let metadata = workspace::private_git_dir(&node).unwrap();
        let native_index = fs::read(node.join(".git/index")).ok();
        fs::write(node.join("tracked.txt"), "first\r\n").unwrap();
        fs::remove_file(node.join("removed.txt")).unwrap();
        fs::create_dir_all(node.join("ignored/empty")).unwrap();
        fs::write(node.join("ignored/raw.bin"), b"\0raw\r\n\xff").unwrap();

        let first_identity = stage_node_snapshot(&node, &source, &[]).unwrap().unwrap();
        assert_eq!(
            Some(first_identity.clone()),
            node_identity_scoped(&node, &source, &[]).unwrap()
        );
        let first_tree = workspace::git(&node, &["write-tree"]).unwrap();
        // The independent collector is the reference for the exact graph tree,
        // including raw bytes, ignored files, deletions and index modes.
        stage_project(&node, &metadata).unwrap();
        assert_eq!(
            workspace::git(&node, &["write-tree"]).unwrap(),
            first_tree,
            "{format}"
        );
        assert_eq!(
            workspace::git_bytes(&node, &["show", ":tracked.txt"], None, None).unwrap(),
            b"first\r\n"
        );
        assert_eq!(
            workspace::git_bytes(&node, &["show", ":ignored/raw.bin"], None, None).unwrap(),
            b"\0raw\r\n\xff"
        );
        assert!(workspace::git(&node, &["show", ":removed.txt"]).is_err());

        // A later capture must read current bytes, even for a same-size edit:
        // there is no observation cache shared across snapshot attempts.
        fs::write(node.join("tracked.txt"), "other\r\n").unwrap();
        let next_identity = stage_node_snapshot(&node, &source, &[]).unwrap().unwrap();
        assert_ne!(next_identity, first_identity);
        let next_tree = workspace::git(&node, &["write-tree"]).unwrap();
        assert_ne!(next_tree, first_tree);
        stage_project(&node, &metadata).unwrap();
        assert_eq!(workspace::git(&node, &["write-tree"]).unwrap(), next_tree);
        assert_eq!(fs::read(node.join(".git/index")).ok(), native_index);

        let head = workspace::snapshot_node(&node, &source, "node").unwrap();
        verify_result(&node, &source, &head).unwrap();
        assert!(load(&record_path(&source, &head).unwrap())
            .unwrap()
            .entries
            .contains_key("ignored/empty"));
    }
}

#[cfg(windows)]
#[test]
fn node_snapshot_staging_keeps_exact_index_executable_bits() {
    for sha256 in [false, true] {
        check_node_index_executable_bits(sha256);
    }
}

#[cfg(windows)]
fn check_node_index_executable_bits(sha256: bool) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("script.sh"), "echo original\n").unwrap();
    if sha256 {
        workspace::git(&source, &["init", "-q", "--object-format=sha256"]).unwrap();
        configure_author(&source);
        workspace::git(&source, &["add", "script.sh"]).unwrap();
        workspace::git(&source, &["update-index", "--chmod=+x", "script.sh"]).unwrap();
        workspace::git(&source, &["commit", "-qm", "executable source script"]).unwrap();
    }
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&temp, "node");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    let mode = |name: &str| {
        let output = workspace::git(&node, &["ls-files", "--stage", "-z"]).unwrap();
        let header = output
            .split('\0')
            .filter_map(|entry| entry.split_once('\t'))
            .find_map(|(header, path)| (path == name).then_some(header))
            .unwrap();
        u32::from_str_radix(header.split_whitespace().next().unwrap(), 8).unwrap()
    };
    if sha256 {
        assert_eq!(
            mode("script.sh"),
            0o100755,
            "source capture must retain its tracked executable bit"
        );
    }
    // Windows permissions cannot express this bit. The graph's previous
    // index, not the default mode of a newly built index, owns it.
    workspace::git(&node, &["update-index", "--chmod=+x", "script.sh"]).unwrap();
    fs::write(node.join("script.sh"), "echo changed\n").unwrap();
    stage_node_snapshot(&node, &source, &[]).unwrap();
    assert_eq!(mode("script.sh"), 0o100755);
    // A differently spelled new path must not borrow that executable bit
    // through libgit2's case-insensitive path lookup.
    fs::rename(node.join("script.sh"), node.join("temporary-name")).unwrap();
    fs::rename(node.join("temporary-name"), node.join("Script.sh")).unwrap();
    stage_node_snapshot(&node, &source, &[]).unwrap();
    assert_eq!(mode("Script.sh"), 0o100644);
    let head = workspace::snapshot_node(&node, &source, "node").unwrap();
    verify_result(&node, &source, &head).unwrap();
}

#[test]
fn node_snapshot_staging_keeps_scoped_removal_and_live_environment_files() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("input.txt"), "input").unwrap();
    let exclusions = vec![".venv".to_string()];
    let base = workspace::snapshot_repository_scoped(&source, &exclusions).unwrap();
    let node = slot(&temp, "node");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    fs::create_dir(node.join(".venv")).unwrap();
    fs::write(node.join(".venv/runtime"), "must remain live, not in Git").unwrap();
    fs::write(node.join("result.txt"), "result").unwrap();
    // Simulate an agent accidentally staging its managed environment.
    workspace::git(&node, &["add", "-f", "--", ".venv/runtime"]).unwrap();
    assert!(workspace::git(&node, &["show", ":.venv/runtime"]).is_ok());
    stage_node_snapshot(&node, &source, &exclusions)
        .unwrap()
        .unwrap();
    let tree = workspace::git(&node, &["write-tree"]).unwrap();
    workspace::stage_scoped_local(&node, &exclusions).unwrap();
    assert_eq!(workspace::git(&node, &["write-tree"]).unwrap(), tree);
    assert!(workspace::git(&node, &["show", ":.venv/runtime"]).is_err());
    assert_eq!(
        workspace::git(&node, &["show", ":result.txt"]).unwrap(),
        "result"
    );
    assert_eq!(
        bytes(&node.join(".venv/runtime")),
        b"must remain live, not in Git"
    );
    let head =
        workspace::snapshot_node_scoped(&node, &source, "node", Some(RUN_ID), &exclusions).unwrap();
    verify_result_scoped(&node, &source, &head, &exclusions).unwrap();
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

#[cfg(unix)]
#[test]
fn legacy_foreign_ownership_is_inherited_without_privileged_chown() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let temp = tempfile::tempdir().unwrap();
    let project_metadata = fs::metadata(temp.path()).unwrap();
    let source = temp.path().join("plain");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("original"), "unchanged source").unwrap();
    let base = workspace::materialize_shadow_repo(&source, &[]).unwrap();
    let upstream = slot(&temp, "upstream");
    workspace::prepare(&source, &upstream, &base, &[]).unwrap();
    let upstream_file = upstream.join("output");
    fs::write(&upstream_file, "task output").unwrap();
    #[cfg(target_os = "macos")]
    {
        let xattr = std::ffi::CString::new("com.example.grapher-test").unwrap();
        let upstream_path = std::ffi::CString::new(std::os::unix::ffi::OsStrExt::as_bytes(
            upstream_file.as_os_str(),
        ))
        .unwrap();
        assert_eq!(
            unsafe {
                libc::setxattr(
                    upstream_path.as_ptr(),
                    xattr.as_ptr(),
                    b"preserved".as_ptr().cast(),
                    b"preserved".len(),
                    0,
                    0,
                )
            },
            0
        );
    }
    let upstream_meta = fs::symlink_metadata(&upstream_file).unwrap();
    let upstream_extra =
        crate::workspace_metadata::capture(&upstream_file, &upstream_meta).unwrap();
    let result = workspace::snapshot_node(&upstream, &source, "upstream").unwrap();

    // Reconstruct an older sealed record that contains numeric owner/group IDs.
    // It remains immutable and must pass its original checksum before the IDs
    // are normalized in memory.
    let mut recorded = Vec::new();
    for head in [&base, &result] {
        let record = record_path(&source, head).unwrap();
        let mut legacy = serde_json::to_value(load(&record).unwrap()).unwrap();
        legacy["root_extra"]["owner"] =
            serde_json::json!([project_metadata.uid(), project_metadata.gid()]);
        for (name, entry) in legacy["entries"].as_object_mut().unwrap() {
            let owner = if name == "output" {
                (u32::MAX - 1, u32::MAX - 2)
            } else {
                (project_metadata.uid(), project_metadata.gid())
            };
            entry["extra"]["owner"] = serde_json::json!([owner.0, owner.1]);
        }
        save(&record, &serde_json::from_value(legacy).unwrap()).unwrap();
        let original_view = fs::read(record.join("view.json")).unwrap();
        let original_checksum = fs::read(record.join("checksum")).unwrap();
        recorded.push((record, original_view, original_checksum));
    }

    let identity = node_identity_scoped(&upstream, &source, &[])
        .unwrap()
        .unwrap();
    assert!(record_matches(&source, &result, &identity).unwrap());
    let downstream = slot(&temp, "downstream");
    let inherited = downstream.join("output");
    workspace::prepare(&source, &downstream, &base, &[result.clone()]).unwrap();
    let actual = fs::symlink_metadata(&inherited).unwrap();
    assert_eq!(
        (actual.uid(), actual.gid()),
        (project_metadata.uid(), project_metadata.gid())
    );
    assert_eq!(actual.mode() & 0o7777, upstream_meta.mode() & 0o7777);
    assert!(crate::workspace_metadata::capture(&inherited, &actual)
        .unwrap()
        .identical(&upstream_extra));
    assert_ne!(actual.ino(), upstream_meta.ino());
    assert_eq!(fs::read(&inherited).unwrap(), b"task output");
    assert_eq!(fs::read(&upstream_file).unwrap(), b"task output");
    let upstream_after = fs::symlink_metadata(&upstream_file).unwrap();
    assert_eq!(
        (upstream_after.uid(), upstream_after.gid()),
        (upstream_meta.uid(), upstream_meta.gid())
    );
    assert!(!source.join("output").exists());
    assert_eq!(
        fs::read(source.join("original")).unwrap(),
        b"unchanged source"
    );
    for (record, original_view, original_checksum) in recorded {
        assert_eq!(fs::read(record.join("view.json")).unwrap(), original_view);
        assert_eq!(
            fs::read(record.join("checksum")).unwrap(),
            original_checksum
        );
    }
    validate_ready(&downstream, &source).unwrap();

    // A previous failed preparation can leave this slot and its Git merge
    // present without a ready marker. Retry the retained slot as-is.
    fs::remove_file(ready(&downstream).unwrap()).unwrap();
    assert!(validate_ready(&downstream, &source).is_err());
    workspace::prepare(&source, &downstream, &base, std::slice::from_ref(&result)).unwrap();
    assert_eq!(fs::read(&inherited).unwrap(), b"task output");
    assert_ne!(
        fs::symlink_metadata(&inherited).unwrap().ino(),
        upstream_meta.ino()
    );
    validate_ready(&downstream, &source).unwrap();

    // Where another supplementary group is available, verify an actual
    // ownership-only change rather than relying solely on synthetic evidence.
    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    if count > 0 {
        let mut groups = vec![0 as libc::gid_t; count as usize];
        let count = unsafe { libc::getgroups(count, groups.as_mut_ptr()) };
        assert!(count >= 0);
        groups.truncate(count as usize);
        if groups
            .into_iter()
            .filter(|gid| *gid != upstream_meta.gid())
            .any(|gid| std::os::unix::fs::chown(&upstream_file, None, Some(gid)).is_ok())
        {
            assert_ne!(
                fs::symlink_metadata(&upstream_file).unwrap().gid(),
                upstream_meta.gid()
            );
            assert_eq!(
                workspace::snapshot_node(&upstream, &source, "upstream").unwrap(),
                result
            );
            verify_result(&upstream, &source, &result).unwrap();
        }
    }

    // Ignoring host ownership must not hide actual project-permission changes.
    fs::set_permissions(
        &upstream_file,
        fs::Permissions::from_mode((upstream_meta.mode() & 0o7777) ^ 0o100),
    )
    .unwrap();
    assert!(verify_result(&upstream, &source, &result).is_err());
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
fn fan_in_and_publication_keep_deleted_intent_to_add_without_recreating_files() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let user_index = bytes(&source.join(".git/index"));
    let base = workspace::snapshot_repository(&source).unwrap();
    let a = slot(&temp, "intent-a");
    let b = slot(&temp, "intent-b");
    workspace::prepare(&source, &a, &base, &[]).unwrap();
    workspace::prepare(&source, &b, &base, &[]).unwrap();
    let intent_names = ["missing intent", "Missing intent"];
    for name in intent_names {
        fs::write(a.join(name), "unfinished\n").unwrap();
        workspace::project_git(
            &a,
            &[
                "-c",
                "core.ignorecase=false",
                "add",
                "-N",
                "--chmod=+x",
                "--",
                name,
            ],
        )
        .unwrap();
        fs::remove_file(a.join(name)).unwrap();
    }
    fs::write(b.join("other.txt"), "other staged work\n").unwrap();
    workspace::project_git(&b, &["add", "other.txt"]).unwrap();
    let ah = workspace::snapshot_node(&a, &source, "intent-a").unwrap();
    let bh = workspace::snapshot_node(&b, &source, "intent-b").unwrap();
    let target = slot(&temp, "intent-join");
    workspace::prepare(&source, &target, &base, &[ah.clone(), bh.clone()]).unwrap();
    let published =
        crate::graph_merge::merge_graph(&source, &[ah, bh], || panic!("no conflict")).unwrap();
    let follow = slot(&temp, "intent-follow");
    workspace::prepare(&source, &follow, &published, &[]).unwrap();
    for path in [&target, &follow] {
        let staged = workspace::project_git(path, &["ls-files", "--stage"]).unwrap();
        let visible = workspace::project_git(
            path,
            &[
                "diff",
                "--cached",
                "--ita-visible-in-index",
                "--name-only",
                "-z",
            ],
        )
        .unwrap();
        let invisible = workspace::project_git(
            path,
            &[
                "diff",
                "--cached",
                "--ita-invisible-in-index",
                "--name-only",
                "-z",
            ],
        )
        .unwrap();
        for name in intent_names {
            assert!(fs::symlink_metadata(path.join(name)).is_err());
            assert!(staged.contains(&format!(
                "100755 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\t{name}"
            )));
            assert!(visible.split('\0').any(|candidate| candidate == name));
            assert!(!invisible.split('\0').any(|candidate| candidate == name));
        }
    }
    assert!(intent_names.iter().all(|name| !source.join(name).exists()));
    assert_eq!(bytes(&source.join("other.txt")), b"other staged work\n");
    assert_eq!(bytes(&source.join(".git/index")), user_index);
    verify_result(&follow, &source, &published).unwrap();
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
fn git_inspection_keeps_effective_path_scopes_and_git_path_expansion() {
    fn check(project: &Path, name: &str, key: &str, local: bool) {
        let file = workspace::project_git(project, &["config", "--path", "--get", key]).unwrap();
        let scope =
            workspace::project_git(project, &["config", "--null", "--show-scope", "--get", key])
                .unwrap();
        assert_eq!(
            matches!(scope.split('\0').next(), Some("local" | "worktree")),
            local
        );
        let files = inspect_git(project).unwrap().4;
        if Path::new(&file).is_absolute() {
            let expected = crate::native::host_path(Path::new(&file))
                .to_string_lossy()
                .replace('\\', "/");
            assert_eq!(files.get(name), Some(&(expected, local)));
        } else {
            assert!(!files.contains_key(name));
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let external = crate::native::host_path(&temp.path().join("path with spaces"))
        .to_string_lossy()
        .replace('\\', "/");
    workspace::project_git(&source, &["config", "core.excludesfile", &external]).unwrap();
    workspace::project_git(
        &source,
        &["config", "core.attributesfile", "relative attrs"],
    )
    .unwrap();
    check(&source, "excludes", "core.excludesfile", true);
    check(&source, "attributes", "core.attributesfile", true);

    let include = crate::native::host_path(&temp.path().join("paths.inc"))
        .to_string_lossy()
        .replace('\\', "/");
    workspace::project_git(
        &source,
        &[
            "config",
            "--file",
            &include,
            "core.attributesfile",
            &external,
        ],
    )
    .unwrap();
    workspace::project_git(&source, &["config", "--add", "include.path", &include]).unwrap();
    check(&source, "attributes", "core.attributesfile", true);
    workspace::project_git(&source, &["config", "extensions.worktreeConfig", "true"]).unwrap();
    let worktree_path = format!("{external}-worktree");
    workspace::project_git(
        &source,
        &[
            "config",
            "--worktree",
            "core.attributesfile",
            &worktree_path,
        ],
    )
    .unwrap();
    check(&source, "attributes", "core.attributesfile", true);

    // Use a slot-owned HOME/global config, never mutate the host's settings.
    let other = tempfile::tempdir().unwrap();
    let source = self::source(&other);
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&other, "config-paths");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    workspace::project_git(
        &node,
        &[
            "config",
            "--global",
            "core.excludesfile",
            "~/ignore with spaces",
        ],
    )
    .unwrap();
    check(&node, "excludes", "core.excludesfile", false);
}

#[cfg(unix)]
#[test]
fn git_root_discovery_handles_newlines_without_splitting_a_path() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let multiline = temp.path().join("project\nwith-newline");
    fs::rename(&source, &multiline).unwrap();
    let (common, current, git_file, git_link) = git_roots(&multiline).unwrap().unwrap();
    assert_eq!(current, multiline.join(".git").canonicalize().unwrap());
    assert_eq!(common, current);
    assert!(!git_file && !git_link);
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
fn metadata_materialization_requires_full_equality_and_never_hides_a_restore() {
    use crate::workspace_metadata::Extra;
    let plain = Extra::default();
    let secured: Extra = serde_json::from_value(serde_json::json!({
        "attributes": [], "security": [1, 2, 3], "protected": false,
        "flags": 0, "owner": null, "efs": false
    }))
    .unwrap();
    let file = |mode: u32, extra: Extra| Entry::File {
        mode,
        blob: String::new(),
        extra,
    };

    // Identical kind, mode and full metadata (including the ACL) is the only
    // case that may skip a restore.
    assert!(metadata_materialized(
        Some(&file(0, plain.clone())),
        &file(0, plain.clone())
    ));
    // A mode change (for example a read-only bit cleared before a rewrite) is
    // not already materialized.
    assert!(!metadata_materialized(
        Some(&file(1, plain.clone())),
        &file(0, plain.clone())
    ));
    // A security-descriptor difference requires a restore just like a mode edit.
    assert!(!metadata_materialized(
        Some(&file(0, secured.clone())),
        &file(0, plain.clone())
    ));
    // A missing or differently-typed on-disk entry never counts as materialized.
    assert!(!metadata_materialized(None, &file(0, plain.clone())));
    assert!(!metadata_materialized(
        Some(&Entry::Directory {
            mode: 0,
            extra: plain.clone()
        }),
        &file(0, plain.clone())
    ));
}

#[cfg(unix)]
#[test]
fn current_unix_ownership_is_normalized_only_after_checksum_validation() {
    let temp = tempfile::tempdir().unwrap();
    let extra = serde_json::json!({
        "attributes": [], "security": [], "protected": false, "flags": 0,
        "owner": [123456, 654321], "efs": false
    });
    let view = serde_json::json!({
        "schema": VIEW_SCHEMA,
        "source": "/legacy/source",
        "root_mode": 0o750,
        "root_extra": extra,
        "entries": {"file": {"kind": "file", "mode": 0o640, "blob": "blob", "extra": extra}},
        "hardlinks": {"aliases": {}, "outside": {}},
        "repositories": {},
        "git_entries": null,
        "git_file": false,
        "git_file_metadata": null,
        "git_link": false,
        "git_link_metadata": null,
        "git_config": [],
        "git_files": {},
        "git_global": []
    });
    let raw = serde_json::to_vec(&view).unwrap();
    fs::write(temp.path().join("view.json"), &raw).unwrap();
    // Independently calculated Git blob SHA-1 of the sorted schema-6 JSON,
    // including security fields. Do not generate it with the production saver.
    fs::write(
        temp.path().join("checksum"),
        "75823a1797798d79147e76c20cf95ecf620b6b74",
    )
    .unwrap();
    let loaded = load(temp.path()).unwrap();
    assert_eq!(loaded.root_mode, 0o750);
    assert!(serde_json::to_value(&loaded.root_extra).unwrap()["owner"].is_null());
    let Some(Entry::File { mode, extra, .. }) = loaded.entries.get("file") else {
        panic!("missing legacy file");
    };
    assert_eq!(*mode, 0o640);
    assert!(serde_json::to_value(extra).unwrap()["owner"].is_null());
    assert_eq!(fs::read(temp.path().join("view.json")).unwrap(), raw);

    let mut damaged: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    damaged["root_extra"]["owner"] = serde_json::json!([1, 2]);
    fs::write(
        temp.path().join("view.json"),
        serde_json::to_vec(&damaged).unwrap(),
    )
    .unwrap();
    assert!(load(temp.path())
        .unwrap_err()
        .contains("Damaged project-view evidence"));
}

#[cfg(target_os = "macos")]
#[test]
fn current_provenance_metadata_is_ignored_after_load() {
    let temp = tempfile::tempdir().unwrap();
    let legacy_extra: crate::workspace_metadata::Extra =
        serde_json::from_value(serde_json::json!({
            "attributes": [["com.apple.provenance", [1, 2, 3]]],
            "security": [], "protected": false, "flags": 64, "owner": null, "efs": false
        }))
        .unwrap();
    let view = View {
        schema: VIEW_SCHEMA,
        source: "/legacy/source".into(),
        root_mode: 0o755,
        root_extra: legacy_extra.clone(),
        entries: BTreeMap::from([(
            "legacy".into(),
            Entry::Directory {
                mode: 0o755,
                extra: legacy_extra,
            },
        )]),
        hardlinks: Default::default(),
        repositories: BTreeMap::new(),
        git_entries: None,
        git_file: false,
        git_file_metadata: None,
        git_link: false,
        git_link_metadata: None,
        git_config: vec![],
        git_files: BTreeMap::new(),
        git_global: vec![],
    };
    save(temp.path(), &view).unwrap();

    let loaded = load(temp.path()).unwrap();
    assert_eq!(
        loaded.root_extra,
        crate::workspace_metadata::Extra::default()
    );
    assert!(matches!(
        loaded.entries.get("legacy"),
        Some(Entry::Directory { extra, .. })
            if *extra == crate::workspace_metadata::Extra::default()
    ));
}

#[test]
fn sha256_repository_prepares_and_materializes_project_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("sha256-source");
    fs::create_dir(&source).unwrap();
    if workspace::git(&source, &["init", "-q", "--object-format=sha256"]).is_err() {
        eprintln!("Git lacks SHA-256 object format support; skipping");
        return;
    }
    configure_author(&source);
    fs::write(source.join("tracked.txt"), "sha256 committed\n").unwrap();
    fs::create_dir_all(source.join("nested/empty")).unwrap();
    workspace::git(&source, &["add", "tracked.txt"]).unwrap();
    workspace::git(&source, &["commit", "-qm", "sha256 history"]).unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "sha256");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    // The recorded blob identity stays the SHA-1 content hash even though the
    // graph tree is SHA-256; the complete-view comparison must still succeed.
    assert_eq!(bytes(&target.join("tracked.txt")), b"sha256 committed\n");
    assert!(target.join("nested/empty").is_dir());
    verify_result(
        &target,
        &source,
        &workspace::git(&target, &["rev-parse", "HEAD"]).unwrap(),
    )
    .unwrap();
}

#[test]
fn runtime_artifacts_are_collected_but_rebuildable_caches_still_require_tracking() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    for (path, value) in [
        ("node_modules/pkg/index.js", "dep\n"),
        (".next/build-id", "build\n"),
        ("standalone.pyc", "sourceless module\n"),
        ("standalone.pyo", "legacy sourceless module\n"),
        ("src/__pycache__/mod.pyc", "bytecode\n"),
        ("tsconfig.tsbuildinfo", "cache\n"),
        ("dist/authored.txt", "authored\n"),
    ] {
        fs::create_dir_all(source.join(path).parent().unwrap()).unwrap();
        fs::write(source.join(path), value).unwrap();
    }
    // A generated-looking file that the user committed is authored content.
    fs::write(
        source.join("committed.tsbuildinfo"),
        "tracked compiler state\n",
    )
    .unwrap();
    workspace::git(&source, &["add", "-f", "committed.tsbuildinfo"]).unwrap();
    workspace::git(&source, &["commit", "-qm", "commit compiler state"]).unwrap();

    let assert_collected = |target: &Path| {
        assert_eq!(bytes(&target.join("node_modules/pkg/index.js")), b"dep\n");
        assert_eq!(bytes(&target.join(".next/build-id")), b"build\n");
        assert_eq!(
            bytes(&target.join("standalone.pyc")),
            b"sourceless module\n"
        );
        assert_eq!(
            bytes(&target.join("standalone.pyo")),
            b"legacy sourceless module\n"
        );
        assert!(
            !target.join("src/__pycache__").exists(),
            "__pycache__ must not be collected"
        );
        assert!(
            !target.join("tsconfig.tsbuildinfo").exists(),
            "tsbuildinfo must not be collected"
        );
        // An ambiguous authored directory and a committed generated file stay.
        assert_eq!(bytes(&target.join("dist/authored.txt")), b"authored\n");
        assert_eq!(
            bytes(&target.join("committed.tsbuildinfo")),
            b"tracked compiler state\n"
        );
    };

    // Default snapshot (scanned/staged project view).
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "generated");
    workspace::prepare(&source, &target, &base, &[]).unwrap();
    assert_collected(&target);

    // A non-empty exclusion forces the forced-`git add` path too.
    let scoped = workspace::snapshot_repository_scoped(&source, &[".venv".into()]).unwrap();
    let forced = slot(&temp, "generated-forced-add");
    workspace::prepare(&source, &forced, &scoped, &[]).unwrap();
    assert_collected(&forced);
}

#[test]
fn offline_dependencies_and_runnable_output_survive_snapshots_forks_and_source_drift() {
    for project_git in [false, true] {
        for scoped in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let source = if project_git {
                source(&temp)
            } else {
                let source = temp.path().join("source");
                fs::create_dir_all(&source).unwrap();
                source
            };
            fs::write(source.join(".gitignore"), "node_modules/\n.next/\n").unwrap();
            fs::create_dir_all(source.join("node_modules/offline-local")).unwrap();
            fs::create_dir_all(source.join(".next/server")).unwrap();
            fs::write(
                source.join("node_modules/offline-local/index.js"),
                "exports.value='captured';\n",
            )
            .unwrap();
            fs::write(
                source.join(".next/server/value.cjs"),
                "module.exports='build';\n",
            )
            .unwrap();
            fs::write(source.join("app.cjs"), "console.log(require('offline-local').value+':'+require('./.next/server/value.cjs'));\n").unwrap();
            // No manifest/lockfile or registry access: the installed bytes are
            // the only available dependency, as with offline/local patches.
            let index = project_git.then(|| bytes(&source.join(".git/index")));
            let head = project_git
                .then(|| workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap());
            let exclusions = if scoped {
                vec!["managed-env".into()]
            } else {
                vec![]
            };
            let base = workspace::snapshot_repository_scoped(&source, &exclusions).unwrap();
            let run = |root: &Path| {
                let output = std::process::Command::new(crate::native::trusted_node().unwrap())
                    .arg("app.cjs")
                    .current_dir(root)
                    .env_remove("NODE_PATH")
                    .env_remove("NODE_OPTIONS")
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                String::from_utf8(output.stdout).unwrap().trim().to_string()
            };
            // A recorded base is authoritative. Preparing a node must not
            // refresh a dependency from today's live source directory.
            fs::write(
                source.join("node_modules/offline-local/index.js"),
                "exports.value='source-later';\n",
            )
            .unwrap();
            let node = slot(&temp, "offline-dependencies");
            workspace::prepare(&source, &node, &base, &[]).unwrap();
            assert_eq!(run(&node), "captured:build");
            assert_eq!(run(&source), "source-later:build");
            fs::write(
                node.join("node_modules/offline-local/index.js"),
                "exports.value='node-patch';\n",
            )
            .unwrap();
            assert!(workspace::repository_status(&node, &exclusions)
                .unwrap()
                .contains("node_modules/offline-local/index.js"));
            let result = workspace::snapshot_node_scoped(
                &node,
                &source,
                "offline",
                Some(RUN_ID),
                &exclusions,
            )
            .unwrap();
            verify_result(&node, &source, &result).unwrap();
            let child = slot(&temp, "offline-fork");
            workspace::prepare(&source, &child, &base, std::slice::from_ref(&result)).unwrap();
            assert_eq!(run(&child), "node-patch:build");
            verify_result(&child, &source, &result).unwrap();
            fs::write(
                child.join("node_modules/offline-local/index.js"),
                "exports.value='child-only';\n",
            )
            .unwrap();
            assert_eq!(run(&node), "node-patch:build");
            assert_eq!(run(&source), "source-later:build");
            assert!(
                verify_result(&child, &source, &result).is_err(),
                "dependency edits must be observable"
            );
            fs::create_dir_all(child.join("node_modules/new-local")).unwrap();
            fs::write(
                child.join("node_modules/new-local/index.js"),
                "module.exports=1;\n",
            )
            .unwrap();
            assert!(
                workspace::repository_status(&child, &exclusions)
                    .unwrap()
                    .contains("node_modules/new-local/index.js"),
                "new ignored dependencies must not be hidden from private status"
            );
            if let (Some(index), Some(head)) = (index, head) {
                assert_eq!(bytes(&source.join(".git/index")), index);
                assert_eq!(
                    workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap(),
                    head
                );
            } else {
                assert!(!source.join(".git").exists());
            }
        }
    }
}

#[test]
fn reused_slot_prunes_ignored_leftover_directories() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("plain");
    fs::create_dir_all(source.join("src/pkg")).unwrap();
    fs::write(source.join("src/pkg/mod.py"), "pkg\n").unwrap();
    let first = workspace::materialize_shadow_repo(&source, &[]).unwrap();
    let target = slot(&temp, "reused");
    workspace::prepare(&source, &target, &first, &[]).unwrap();
    assert_eq!(bytes(&target.join("src/pkg/mod.py")), b"pkg\n");

    // An earlier execution in this slot left an ignored cache behind. Graph
    // `checkout -f` rewrites tracked files only, so just the enclosing
    // directory survives and the scan records it.
    fs::create_dir_all(target.join("src/pkg/__pycache__")).unwrap();
    fs::write(
        target.join("src/pkg/__pycache__/mod.cpython-312.pyc"),
        "cache\n",
    )
    .unwrap();

    fs::remove_dir_all(source.join("src/pkg")).unwrap();
    let second = workspace::materialize_shadow_repo(&source, &[]).unwrap();
    workspace::prepare(&source, &target, &second, &[]).unwrap();
    assert!(
        !target.join("src/pkg").exists(),
        "an ignored-only leftover directory must not block a reused slot"
    );
    validate_ready(&target, &source).unwrap();
}

#[test]
fn reused_slot_keeps_unrecorded_project_content() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    fs::create_dir_all(source.join("src/pkg")).unwrap();
    fs::write(source.join("src/pkg/mod.py"), "pkg\n").unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "unrecorded");
    workspace::prepare(&source, &target, &base, &[]).unwrap();

    // Caches are pruned, but an unrecorded authored file is never discarded.
    fs::create_dir_all(target.join("src/pkg/__pycache__")).unwrap();
    fs::write(target.join("src/pkg/__pycache__/mod.pyc"), "cache\n").unwrap();
    fs::write(target.join("notes.md"), "authored\n").unwrap();
    let error = workspace::prepare(&source, &target, &base, &[]).unwrap_err();
    assert!(
        error.contains("notes.md") && error.contains("unexpected entry"),
        "{error}"
    );
    assert_eq!(
        bytes(&target.join("src/pkg/__pycache__/mod.pyc")),
        b"cache\n"
    );
    assert_eq!(bytes(&target.join("notes.md")), b"authored\n");
}

#[test]
fn git_metadata_scan_keeps_generated_looking_entries_but_not_runtime_locks() {
    let temp = tempfile::tempdir().unwrap();
    for file in [
        "HEAD",
        "node_modules/pkg/cache.tsbuildinfo",
        "index.lock",
        "refs/heads/topic.lock",
        "worktrees/other/state",
    ] {
        let path = temp.path().join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "metadata bytes").unwrap();
    }
    let mut entries = BTreeMap::new();
    scan(temp.path(), Path::new(""), &mut entries, true).unwrap();
    let blob = git2::Oid::hash_object(git2::ObjectType::Blob, b"metadata bytes")
        .unwrap()
        .to_string();
    for name in ["HEAD", "node_modules/pkg/cache.tsbuildinfo"] {
        assert!(
            matches!(entries.get(name), Some(Entry::File { blob: actual, .. }) if actual == &blob)
        );
    }
    for name in [
        "index.lock",
        "refs/heads/topic.lock",
        "worktrees",
        "worktrees/other/state",
    ] {
        assert!(!entries.contains_key(name), "{name}");
    }
}

#[test]
fn in_place_generated_filter_matches_cloning_for_nested_views_and_hardlinks() {
    fn cloning_reference(view: &View, tracked: &std::collections::BTreeSet<String>) -> View {
        let keep = |name: &str| {
            !workspace::is_generated_artifact(Path::new(name)) || tracked.contains(name)
        };
        let mut view = view.clone();
        view.entries.retain(|name, _| keep(name));
        view.hardlinks.retain(keep);
        view.repositories.retain(|name, nested| {
            *nested = cloning_reference(nested, tracked);
            keep(name)
        });
        view
    }
    let temp = tempfile::tempdir().unwrap();
    let mut view = inspect(temp.path()).unwrap();
    let entry = Entry::File {
        mode: 0o644,
        blob: "a".repeat(40),
        extra: Default::default(),
    };
    for name in [
        "keep.txt",
        "alias.txt",
        "untracked.tsbuildinfo",
        "tracked.TSBUILDINFO",
    ] {
        view.entries.insert(name.into(), entry.clone());
    }
    // Git evidence is not project-generated content and must remain untouched.
    view.git_entries = Some(view.entries.clone());
    view.hardlinks = serde_json::from_value(serde_json::json!({
        "aliases": { "alias.txt": "keep.txt", "untracked.tsbuildinfo": "keep.txt", "tracked.TSBUILDINFO": "keep.txt" },
        "outside": { "keep.txt": 2, "untracked.tsbuildinfo": 1 }
    })).unwrap();
    let mut nested = view.clone();
    nested.repositories.insert("child".into(), view.clone());
    view.repositories
        .insert("node_modules".into(), nested.clone());
    view.repositories
        .insert("__pycache__".into(), nested.clone());
    view.repositories.insert("nested".into(), nested);
    for tracked in [
        std::collections::BTreeSet::new(),
        std::collections::BTreeSet::from([
            "tracked.TSBUILDINFO".to_string(),
            "__pycache__".to_string(),
        ]),
    ] {
        let expected = cloning_reference(&view, &tracked);
        let mut actual = view.clone();
        strip_generated(&mut actual, &tracked);
        // Compare every serialized field, not the weaker normalized equality.
        assert_eq!(
            serde_json::to_vec(&actual).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
    }
}

#[test]
fn completed_view_check_tolerates_recorded_generated_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&temp, "tolerant");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    fs::write(node.join("result.txt"), "r\n").unwrap();
    let head = workspace::snapshot_node(&node, &source, "node").unwrap();
    verify_result(&node, &source, &head).unwrap();

    // Simulate a view recorded before the generated-artifact policy: it still
    // lists an untracked generated artifact that the current scan omits.
    let record = record_path(&source, &head).unwrap();
    let mut view = load(&record).unwrap();
    view.entries.insert(
        "__pycache__/old.pyc".into(),
        Entry::Directory {
            mode: 0,
            extra: crate::workspace_metadata::Extra::default(),
        },
    );
    save(&record, &view).unwrap();

    // The completed-view check must not fail on that difference alone, and
    // in-memory filtering must never rewrite the durable legacy evidence.
    let recorded_bytes = bytes(&record.join("view.json"));
    let recorded_checksum = bytes(&record.join("checksum"));
    verify_result(&node, &source, &head).unwrap();
    assert_eq!(bytes(&record.join("view.json")), recorded_bytes);
    assert_eq!(bytes(&record.join("checksum")), recorded_checksum);

    // A real content change is still detected.
    fs::write(node.join("result.txt"), "changed\n").unwrap();
    assert!(verify_result(&node, &source, &head).is_err());
}

#[cfg(windows)]
#[test]
fn windows_long_path_fan_in_prepares_after_conflict_and_retry() {
    use std::os::windows::ffi::OsStrExt;
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    // A long authored path (not a generated artifact name, which the runtime
    // no longer collects).
    let mut relative = PathBuf::from("UI/deep");
    while source.join(&relative).as_os_str().encode_wide().count() < 280 {
        relative.push("nested-dependency");
    }
    relative.push("index.js");
    let name = name(&relative).unwrap();
    let mut parents = Vec::new();
    for label in ["left", "right"] {
        let path = slot(&temp, label);
        workspace::prepare(&source, &path, &base, &[]).unwrap();
        fs::create_dir_all(path.join(&relative).parent().unwrap()).unwrap();
        fs::write(path.join(&relative), format!("{label}\n")).unwrap();
        parents.push(workspace::snapshot_node(&path, &source, label).unwrap());
    }
    let target = slot(&temp, "long-path-join");
    let error = workspace::prepare_with_merger(&source, &target, &base, &parents, || {
        Err("injected interrupted conflict repair".into())
    })
    .unwrap_err();
    assert!(error.contains("injected interrupted conflict repair"));
    assert!(target.join(&relative).is_file());

    let mut repairs = 0;
    let head = workspace::prepare_with_merger(&source, &target, &base, &parents, || {
        repairs += 1;
        // Like the real Merger, repair through the canonical (extended) cwd.
        let canonical = target.canonicalize().unwrap();
        fs::write(canonical.join(&relative), "resolved\n").unwrap();
        workspace::git(&canonical, &["add", "-f", "--", &name])?;
        workspace::git(&canonical, &["commit", "--no-edit"])?;
        Ok(())
    })
    .unwrap();
    assert_eq!(repairs, 1);
    assert_eq!(bytes(&target.join(&relative)), b"resolved\n");
    validate_ready(&target, &source).unwrap();
    verify_result(&target, &source, &head).unwrap();
    for parent in &parents {
        workspace::verify_prepared_ancestor(&target, parent).unwrap();
    }
    // Import the result as Runtime does before passing it to the next node.
    let result = workspace::snapshot_node(&target, &source, "long-path-join").unwrap();
    let next = slot(&temp, "long-path-next");
    workspace::prepare(&source, &next, &result, &[]).unwrap();
    validate_ready(&next, &source).unwrap();
    assert_eq!(bytes(&next.join(&relative)), b"resolved\n");
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
        .to_string()
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
fn named_pipes_are_reconstructed_and_survive_forks() {
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
    // Files-only publication cannot deliver the removal of a special entry, so
    // the task result is refused explicitly instead of silently dropping it.
    let error = workspace::snapshot_node(&target, &source, "fifo-delete").unwrap_err();
    assert!(
        error.contains("files-only publication cannot deliver"),
        "{error}"
    );
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
    configure_author(&nested);
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
    configure_author(&seed);
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
    configure_author(&child);
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
fn existing_immutable_view_refreshes_the_local_ready_gate_without_rewriting_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&temp, "shared-record");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    fs::write(node.join("tracked.txt"), "new project bytes").unwrap();
    let head = workspace::snapshot_node(&node, &source, "shared-record").unwrap();
    let record = record_path(&source, &head).unwrap();
    let original = fs::read(record.join("view.json")).unwrap();
    // Another slot can publish the same immutable commit before this slot
    // refreshes its own gate after moving HEAD. Reuse must finish local setup.
    fs::write(ready(&node).unwrap(), &base).unwrap();
    assert!(validate_ready(&node, &source).is_err());
    capture_node_scoped(&node, &source, &head, &[], None).unwrap();
    validate_ready(&node, &source).unwrap();
    assert_eq!(fs::read(record.join("view.json")).unwrap(), original);

    fs::write(ready(&node).unwrap(), &base).unwrap();
    fs::write(record.join("checksum"), "damaged").unwrap();
    assert!(capture_node_scoped(&node, &source, &head, &[], None).is_err());
    assert_eq!(
        fs::read_to_string(ready(&node).unwrap()).unwrap(),
        base,
        "corrupt shared evidence must never authorize a launch"
    );
}

#[test]
fn snapshot_readiness_recovery_refuses_unproven_or_changed_work_without_mutation() {
    for damage in [
        "dirty",
        "dirty-recorded",
        "checksum",
        "missing-checksum",
        "missing-view",
        "unknown-commit",
        "wrong-tree",
        "discarded-history",
        "missing-gate",
        "invalid-gate",
        "binding",
        "git-binding",
        "merge",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let source = source(&temp);
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = slot(&temp, "snapshot-recovery-refusal");
        let prepared = workspace::prepare(&source, &node, &base, &[]).unwrap();
        fs::write(node.join("tracked.txt"), "snapshot bytes\n").unwrap();
        let identity = stage_node_snapshot(&node, &source, &[]).unwrap().unwrap();
        let message = format!("snapshot\n\nworkspace-view:{identity}");
        workspace::git(&node, &["commit", "-m", &message]).unwrap();
        let snapshot = workspace::git(&node, &["rev-parse", "HEAD"]).unwrap();
        let immutable = record_path(&source, &snapshot).unwrap();
        if matches!(
            damage,
            "dirty-recorded" | "checksum" | "missing-checksum" | "missing-view"
        ) {
            capture_node_scoped(&node, &source, &snapshot, &[], None).unwrap();
            fs::write(ready(&node).unwrap(), &prepared).unwrap();
        }
        match damage {
            "dirty" | "dirty-recorded" => {
                fs::write(node.join("tracked.txt"), "later unfinished work\n").unwrap()
            }
            "checksum" => fs::write(immutable.join("checksum"), "damaged").unwrap(),
            "missing-checksum" => fs::remove_file(immutable.join("checksum")).unwrap(),
            "missing-view" => fs::remove_file(immutable.join("view.json")).unwrap(),
            "unknown-commit" => {
                workspace::git(
                    &node,
                    &["commit", "--allow-empty", "-m", "not a host snapshot"],
                )
                .unwrap();
            }
            "wrong-tree" | "discarded-history" => {
                let tree =
                    workspace::git(&node, &["rev-parse", &format!("{prepared}^{{tree}}")]).unwrap();
                let head = if damage == "wrong-tree" {
                    workspace::git(
                        &node,
                        &["commit-tree", &tree, "-p", &snapshot, "-m", &message],
                    )
                    .unwrap()
                } else {
                    workspace::git(&node, &["commit-tree", &tree, "-m", &message]).unwrap()
                };
                workspace::git(&node, &["update-ref", "HEAD", &head]).unwrap();
            }
            "missing-gate" => fs::remove_file(ready(&node).unwrap()).unwrap(),
            "invalid-gate" => fs::write(ready(&node).unwrap(), "invalid").unwrap(),
            "binding" => fs::write(binding(&node).unwrap(), "another source").unwrap(),
            "git-binding" => {
                workspace::project_git(
                    &node,
                    &["config", "core.worktree", source.to_str().unwrap()],
                )
                .unwrap();
            }
            "merge" => fs::write(
                workspace::private_git_dir(&node)
                    .unwrap()
                    .join("MERGE_HEAD"),
                &prepared,
            )
            .unwrap(),
            _ => unreachable!(),
        }
        let head = workspace::git(&node, &["rev-parse", "HEAD"]).unwrap();
        let gate = fs::read(ready(&node).unwrap()).ok();
        let index = fs::read(workspace::private_git_dir(&node).unwrap().join("index")).unwrap();
        let project = bytes(&node.join("tracked.txt"));
        let evidence = fs::read(immutable.join("view.json")).ok();
        let checksum = fs::read(immutable.join("checksum")).ok();
        let error =
            workspace::recover_snapshot_readiness(&node, &source, &prepared, &[]).unwrap_err();
        assert!(!error.is_empty(), "{damage}");
        assert_eq!(fs::read(ready(&node).unwrap()).ok(), gate, "{damage}");
        assert_eq!(
            workspace::git(&node, &["rev-parse", "HEAD"]).unwrap(),
            head,
            "{damage}"
        );
        assert_eq!(
            fs::read(workspace::private_git_dir(&node).unwrap().join("index")).unwrap(),
            index,
            "{damage}"
        );
        assert_eq!(bytes(&node.join("tracked.txt")), project, "{damage}");
        assert_eq!(
            fs::read(immutable.join("view.json")).ok(),
            evidence,
            "{damage}"
        );
        assert_eq!(
            fs::read(immutable.join("checksum")).ok(),
            checksum,
            "{damage}"
        );
        assert_eq!(
            bytes(&source.join("tracked.txt")),
            b"committed\n",
            "{damage}"
        );
    }
}

#[test]
fn snapshot_readiness_seal_reuse_finishes_only_the_local_gate() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&temp, "seal-gate-reuse");
    let prepared = workspace::prepare(&source, &node, &base, &[]).unwrap();
    fs::write(node.join("tracked.txt"), "snapshot bytes\n").unwrap();
    let head = workspace::snapshot_node(&node, &source, "seal-gate-reuse").unwrap();
    let record = record_path(&source, &head).unwrap();
    let original = bytes(&record.join("view.json"));
    fs::write(ready(&node).unwrap(), &prepared).unwrap();
    assert_eq!(
        seal_prepared_scoped(&node, &source, &[], None).unwrap(),
        head
    );
    validate_ready(&node, &source).unwrap();
    assert_eq!(bytes(&record.join("view.json")), original);
    fs::write(ready(&node).unwrap(), &prepared).unwrap();
    fs::write(record.join("checksum"), "damaged").unwrap();
    assert!(seal_prepared_scoped(&node, &source, &[], None).is_err());
    assert_eq!(fs::read_to_string(ready(&node).unwrap()).unwrap(), prepared);
}

#[test]
fn prepared_reuse_rejects_corrupt_view_even_with_the_original_checksum() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&temp, "corrupt-reuse");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    let head = workspace::snapshot_node(&node, &source, "corrupt-reuse").unwrap();
    let record = record_path(&source, &head).unwrap();
    let checksum = fs::read(record.join("checksum")).unwrap();
    let mut damaged: serde_json::Value =
        serde_json::from_slice(&fs::read(record.join("view.json")).unwrap()).unwrap();
    damaged["entries"]["tracked.txt"]["extra"]["security"] = serde_json::json!([9, 8, 7]);
    fs::write(
        record.join("view.json"),
        serde_json::to_vec(&damaged).unwrap(),
    )
    .unwrap();

    let error = seal_prepared_scoped(&node, &source, &[], None).unwrap_err();
    assert!(error.contains("Damaged project-view evidence"), "{error}");
    assert!(workspace::snapshot_node(&node, &source, "corrupt-reuse")
        .unwrap_err()
        .contains("Damaged project-view evidence"));
    assert_eq!(workspace::git(&node, &["rev-parse", "HEAD"]).unwrap(), head);
    assert_eq!(fs::read(record.join("checksum")).unwrap(), checksum);
}

#[test]
fn snapshot_does_not_repair_bad_checksum_or_partial_evidence_from_live_files() {
    for damage in ["checksum", "missing-checksum", "missing-view"] {
        let temp = tempfile::tempdir().unwrap();
        let source = source(&temp);
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = slot(&temp, "partial-record");
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        let head = workspace::snapshot_node(&node, &source, "partial-record").unwrap();
        let record = record_path(&source, &head).unwrap();
        match damage {
            "checksum" => fs::write(record.join("checksum"), "damaged").unwrap(),
            "missing-checksum" => fs::remove_file(record.join("checksum")).unwrap(),
            "missing-view" => fs::remove_file(record.join("view.json")).unwrap(),
            _ => unreachable!(),
        }
        assert!(
            workspace::snapshot_node(&node, &source, "partial-record").is_err(),
            "{damage}"
        );
        assert_eq!(
            workspace::git(&node, &["rev-parse", "HEAD"]).unwrap(),
            head,
            "{damage}"
        );
    }
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

#[test]
fn reused_slot_rebinds_project_git_to_the_new_base() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    fs::create_dir_all(source.join("src/pkg")).unwrap();
    fs::write(source.join("src/pkg/mod.py"), "pkg\n").unwrap();
    workspace::git(&source, &["add", "src/pkg/mod.py"]).unwrap();
    workspace::git(&source, &["commit", "-qm", "add pkg"]).unwrap();
    let first = workspace::snapshot_repository(&source).unwrap();
    let target = slot(&temp, "reused-git");
    workspace::prepare(&source, &target, &first, &[]).unwrap();
    assert_eq!(
        workspace::project_git(&target, &["rev-parse", "HEAD"]).unwrap(),
        first
    );

    fs::create_dir_all(target.join("src/pkg/__pycache__")).unwrap();
    fs::write(
        target.join("src/pkg/__pycache__/mod.cpython-312.pyc"),
        "cache\n",
    )
    .unwrap();
    workspace::git(&source, &["rm", "-q", "-r", "src/pkg"]).unwrap();
    workspace::git(&source, &["commit", "-qm", "drop pkg"]).unwrap();
    let second = workspace::snapshot_repository(&source).unwrap();

    // The slot's native project Git still stops at the previous base, which
    // cannot describe this one. Reusing the slot must follow the new reference
    // instead of failing staging composition on a missing tree object.
    workspace::prepare(&source, &target, &second, &[]).unwrap();
    assert_eq!(
        workspace::project_git(&target, &["rev-parse", "HEAD"]).unwrap(),
        second
    );
    assert!(!target.join("src/pkg").exists());
    assert_eq!(
        workspace::project_git(&target, &["status", "--porcelain"]).unwrap(),
        ""
    );
    validate_ready(&target, &source).unwrap();

    // Reusing the same slot for an ancestor base keeps the objects readable,
    // but the native index must still describe the files on disk.
    workspace::prepare(&source, &target, &first, &[]).unwrap();
    assert_eq!(
        workspace::project_git(&target, &["rev-parse", "HEAD"]).unwrap(),
        first
    );
    assert_eq!(
        workspace::project_git(&target, &["status", "--porcelain"]).unwrap(),
        ""
    );
    assert_eq!(bytes(&target.join("src/pkg/mod.py")), b"pkg\n");
}

#[test]
fn source_snapshots_advance_when_only_project_metadata_changes() {
    for (plain, scoped) in [(false, false), (false, true), (true, false), (true, true)] {
        let temp = tempfile::tempdir().unwrap();
        let source = if plain {
            let source = temp.path().join("plain");
            fs::create_dir(&source).unwrap();
            fs::write(source.join("tracked.txt"), "committed\n").unwrap();
            source
        } else {
            source(&temp)
        };
        let exclusions = if scoped {
            vec!["managed".to_string()]
        } else {
            vec![]
        };
        fs::create_dir(source.join("managed")).unwrap();
        fs::write(source.join("managed/cache"), "cache").unwrap();
        let first = workspace::snapshot_repository_scoped(&source, &exclusions).unwrap();
        fs::create_dir_all(source.join("source-empty/nested")).unwrap();
        let second = workspace::snapshot_repository_scoped(&source, &exclusions).unwrap();
        assert_ne!(
            first, second,
            "metadata-only change needs a new view reference"
        );
        let follow = slot(&temp, "source-metadata-follow");
        workspace::prepare(&source, &follow, &second, &[]).unwrap();
        assert!(follow.join("source-empty/nested").is_dir());

        // The normal plain-folder entry point must also advance on metadata-only
        // changes instead of reusing stale evidence.
        if plain {
            fs::create_dir(source.join("another-empty")).unwrap();
            let third = workspace::materialize_shadow_repo(&source, &exclusions).unwrap();
            assert_ne!(second, third);
            let follow = slot(&temp, "source-metadata-materialized");
            workspace::prepare(&source, &follow, &third, &[]).unwrap();
            assert!(follow.join("another-empty").is_dir());
        }
    }
}

#[test]
fn publication_retains_empty_directories_added_to_source_after_fork() {
    for (plain, hardlinks, source_file_edit) in [
        (false, false, false),
        (true, false, false),
        (false, true, false),
        (true, true, false),
        (false, false, true),
        (true, false, true),
        (false, true, true),
        (true, true, true),
    ] {
        if hardlinks && !cfg!(unix) {
            continue;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = if plain {
            let source = temp.path().join("plain");
            fs::create_dir(&source).unwrap();
            fs::write(source.join("tracked.txt"), "committed\n").unwrap();
            source
        } else {
            source(&temp)
        };
        if hardlinks {
            fs::hard_link(source.join("tracked.txt"), source.join("alias.txt")).unwrap();
        }
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = slot(&temp, "source-late-node");
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        fs::write(node.join("result"), "result").unwrap();
        let head = workspace::snapshot_node(&node, &source, "node").unwrap();
        fs::create_dir_all(source.join("late-empty/nested")).unwrap();
        if source_file_edit {
            fs::write(source.join("late-file"), "source edit").unwrap();
        }
        let published =
            crate::graph_merge::merge_graph(&source, &[head], || panic!("no conflict")).unwrap();
        let recorded = load(&record_path(&source, &published).unwrap()).unwrap();
        let follow = slot(&temp, "source-late-follow");
        workspace::prepare(&source, &follow, &published, &[]).unwrap();
        assert!(
            follow.join("late-empty/nested").is_dir(),
            "plain={plain}, hardlinks={hardlinks}, source_file_edit={source_file_edit}, recorded={:?}",
            recorded.entries.keys().collect::<Vec<_>>()
        );
    }
}

#[test]
fn publication_refuses_to_guess_when_common_view_evidence_is_missing() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&temp, "missing-common-node");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    fs::write(node.join("result"), "result").unwrap();
    let head = workspace::snapshot_node(&node, &source, "node").unwrap();
    fs::create_dir(source.join("late-empty")).unwrap();
    let input = workspace::snapshot_repository(&source).unwrap();
    assert_ne!(base, input);
    fs::remove_dir_all(record_path(&source, &base).unwrap()).unwrap();
    let error =
        crate::graph_merge::merge_graph(&source, &[head], || panic!("no conflict")).unwrap_err();
    assert!(error.contains("common project-view evidence"), "{error}");
    assert!(!source.join("result").exists());
    assert!(source.join("late-empty").is_dir());
}

#[test]
fn publication_keeps_source_metadata_when_the_user_commits_after_the_fork() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    fs::write(source.join("untracked"), "initial dirty file").unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&temp, "source-commit-node");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    fs::write(node.join("result"), "result").unwrap();
    let head = workspace::snapshot_node(&node, &source, "node").unwrap();
    fs::write(source.join("user-commit"), "user history").unwrap();
    workspace::project_git(&source, &["add", "user-commit"]).unwrap();
    workspace::project_git(&source, &["commit", "-qm", "user commit"]).unwrap();
    fs::create_dir_all(source.join("late-empty/nested")).unwrap();
    let published =
        crate::graph_merge::merge_graph(&source, &[head], || panic!("no conflict")).unwrap();
    let follow = slot(&temp, "source-commit-follow");
    workspace::prepare(&source, &follow, &published, &[]).unwrap();
    assert!(follow.join("late-empty/nested").is_dir());
}

#[test]
fn publication_does_not_reintroduce_source_changes_reverted_after_fork() {
    for capture_clean_first in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let source = source(&temp);
        if capture_clean_first {
            workspace::snapshot_repository(&source).unwrap();
        }
        fs::write(source.join("tracked.txt"), "temporary source edit\n").unwrap();
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = slot(&temp, "reverted-source-node");
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        fs::write(node.join("result"), "result").unwrap();
        let head = workspace::snapshot_node(&node, &source, "node").unwrap();
        fs::write(source.join("tracked.txt"), "committed\n").unwrap();
        crate::graph_merge::merge_graph(&source, &[head], || panic!("no conflict")).unwrap();
        assert_eq!(
            bytes(&source.join("tracked.txt")),
            b"committed\n",
            "capture_clean_first={capture_clean_first}"
        );
        assert_eq!(bytes(&source.join("result")), b"result");
    }
}

#[cfg(unix)]
#[test]
fn workspace_free_publication_preserves_file_metadata_and_empty_directories() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    fs::create_dir_all(source.join("source-empty/nested")).unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&temp, "metadata-publication-node");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    fs::write(node.join("tracked.txt"), "updated bytes\n").unwrap();
    fs::set_permissions(node.join("tracked.txt"), fs::Permissions::from_mode(0o600)).unwrap();
    fs::create_dir_all(node.join("node-empty/nested")).unwrap();
    let head = workspace::snapshot_node(&node, &source, "metadata-publication").unwrap();

    let published =
        crate::graph_merge::merge_graph(&source, &[head], || panic!("no conflict")).unwrap();
    let follow = slot(&temp, "metadata-publication-follow");
    workspace::prepare(&source, &follow, &published, &[]).unwrap();
    assert_eq!(bytes(&follow.join("tracked.txt")), b"updated bytes\n");
    assert_eq!(
        fs::metadata(follow.join("tracked.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(follow.join("source-empty/nested").is_dir());
    assert!(follow.join("node-empty/nested").is_dir());
    verify_result(&follow, &source, &published).unwrap();
}

#[cfg(unix)]
#[test]
fn workspace_free_publication_rejects_conflicting_file_metadata() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let mut heads = Vec::new();
    for (name, mode) in [("metadata-left", 0o600), ("metadata-right", 0o640)] {
        let node = slot(&temp, name);
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        fs::set_permissions(node.join("tracked.txt"), fs::Permissions::from_mode(mode)).unwrap();
        heads.push(workspace::snapshot_node(&node, &source, name).unwrap());
    }
    let error =
        crate::graph_merge::merge_graph(&source, &heads, || panic!("no Git conflict")).unwrap_err();
    assert!(error.contains("metadata composition conflict"), "{error}");
    assert_eq!(bytes(&source.join("tracked.txt")), b"committed\n");
}

#[cfg(unix)]
#[test]
fn workspace_free_publication_keeps_link_target_whitespace() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    symlink(" target \n", source.join("link")).unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&temp, "link-publication-node");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    fs::write(node.join("result"), "result").unwrap();
    let head = workspace::snapshot_node(&node, &source, "link-publication").unwrap();
    let published =
        crate::graph_merge::merge_graph(&source, &[head], || panic!("no conflict")).unwrap();
    let follow = slot(&temp, "link-publication-follow");
    workspace::prepare(&source, &follow, &published, &[]).unwrap();
    assert_eq!(
        fs::read_link(follow.join("link")).unwrap(),
        Path::new(" target \n")
    );
    verify_result(&follow, &source, &published).unwrap();
}

#[cfg(unix)]
#[test]
fn publication_rejects_hardlinks_with_divergent_composed_contents() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    fs::write(source.join("a"), "same\n").unwrap();
    fs::write(source.join("b"), "same\n").unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let linked = slot(&temp, "hardlink-publication-linked");
    workspace::prepare(&source, &linked, &base, &[]).unwrap();
    fs::remove_file(linked.join("b")).unwrap();
    fs::hard_link(linked.join("a"), linked.join("b")).unwrap();
    let linked_head = workspace::snapshot_node(&linked, &source, "link").unwrap();
    let edited = slot(&temp, "hardlink-publication-edited");
    workspace::prepare(&source, &edited, &base, &[]).unwrap();
    fs::write(edited.join("a"), "different\n").unwrap();
    let edited_head = workspace::snapshot_node(&edited, &source, "edit").unwrap();

    let error = crate::graph_merge::merge_graph(&source, &[linked_head, edited_head], || {
        panic!("no Git conflict")
    })
    .unwrap_err();
    assert!(error.contains("Hardlinked task paths"), "{error}");
    assert_eq!(bytes(&source.join("a")), b"same\n");
    assert_eq!(bytes(&source.join("b")), b"same\n");
}

#[cfg(unix)]
#[test]
fn publication_retains_unchanged_special_entries_in_the_composed_view() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::FileTypeExt;

    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let fifo = CString::new(source.join("events").as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&temp, "fifo-publication-node");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    fs::write(node.join("result"), "result").unwrap();
    let head = workspace::snapshot_node(&node, &source, "fifo-publication").unwrap();
    let published =
        crate::graph_merge::merge_graph(&source, &[head], || panic!("no conflict")).unwrap();
    let follow = slot(&temp, "fifo-publication-follow");
    workspace::prepare(&source, &follow, &published, &[]).unwrap();
    assert!(fs::symlink_metadata(follow.join("events"))
        .unwrap()
        .file_type()
        .is_fifo());
    verify_result(&follow, &source, &published).unwrap();
}

/// A publication that changes only a file's executable bit must record that
/// mode: the composed view is what a later result workspace is verified against.
#[cfg(unix)]
#[test]
fn workspace_free_composition_records_a_mode_only_change() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&temp, "node");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    fs::set_permissions(node.join("tracked.txt"), fs::Permissions::from_mode(0o755)).unwrap();
    let head = workspace::snapshot_node(&node, &source, "node").unwrap();
    let published =
        crate::graph_merge::merge_graph(&source, &[head], || Err("no conflict".into())).unwrap();
    assert!(
        source
            .join("tracked.txt")
            .metadata()
            .unwrap()
            .permissions()
            .mode()
            & 0o111
            != 0,
        "delivery keeps the tree's executable bit"
    );

    // The composed record must agree with the tree's executable bit, not with
    // the earlier view that still describes the unchanged bytes.
    let recorded = load(&record_path(&source, &published).unwrap()).unwrap();
    match recorded.entries.get("tracked.txt") {
        Some(Entry::File { mode, .. }) => {
            assert_eq!(
                mode & 0o111,
                0o111,
                "composed view keeps the executable bit"
            )
        }
        other => panic!("missing recorded file entry: {other:?}"),
    }
    let follow = slot(&temp, "follow-up");
    workspace::prepare(&source, &follow, &published, &[]).unwrap();
    verify_result(&follow, &source, &published).unwrap();
}
