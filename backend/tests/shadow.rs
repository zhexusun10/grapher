use grapher::workspace;
use std::fs;
use tempfile::tempdir;

/// Keep fixture runs from writing shadow repositories into the checkout.
fn isolate_data_root() {
    #[cfg(feature = "fixture")]
    grapher::ensure_test_data_root();
}

#[test]
fn detect_plain_directory_creates_nothing() {
    isolate_data_root();
    let temp = tempdir().unwrap();
    let project = temp.path().join("my-cool-project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("main.py"), "print('hello shadow')\n").unwrap();

    // A pure filesystem report: no `.git`, no shadow metadata, empty HEAD.
    let detected = workspace::detect(Some(&project)).unwrap().unwrap();
    assert!(detected.is_shadow);
    assert_eq!(detected.name, "my-cool-project");
    assert_eq!(detected.branch, "shadow");
    assert_eq!(detected.head, "");
    assert!(detected.clean);
    assert!(!project.join(".git").exists());
    assert!(workspace::shadow_repo_if_exists(&project).unwrap().is_none());
    assert!(!workspace::shadow_repo_dir(&project).unwrap().exists());
}

#[test]
fn first_materialization_is_forced_and_reusable() {
    isolate_data_root();
    let temp = tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("main.py"), "print('hello')\n").unwrap();
    // Ignored files are still collected by design.
    fs::write(project.join(".gitignore"), ".cache/\n").unwrap();
    fs::create_dir(project.join(".cache")).unwrap();
    fs::write(project.join(".cache/package"), "ordinary bytes").unwrap();

    assert!(workspace::shadow_repo_if_exists(&project).unwrap().is_none());
    let head = workspace::materialize_shadow_repo(&project, &[]).unwrap();
    assert!(!head.is_empty());
    let shadow = workspace::shadow_repo_if_exists(&project).unwrap().unwrap();
    assert!(shadow.exists());
    assert!(!project.join(".git").exists(), "never pollute the source");
    let tracked = workspace::repository_git(&project, &["ls-files"]).unwrap();
    assert!(tracked.contains(".cache/package"));

    // Re-materializing an unchanged tree reuses HEAD instead of adding an
    // empty commit (crash recovery and shared sources rely on this).
    let again = workspace::materialize_shadow_repo(&project, &[]).unwrap();
    assert_eq!(again, head);
    assert_eq!(
        workspace::repository_git(&project, &["rev-list", "--count", "HEAD"]).unwrap(),
        "1"
    );

    // Explicit verify materializes again and yields a usable HEAD.
    let verified = workspace::verify(&project).unwrap();
    assert_eq!(verified, head);
    assert_eq!(
        workspace::repository_git(&project, &["rev-parse", "HEAD"]).unwrap(),
        verified
    );

    let worktree = temp.path().join("worktree");
    let before = workspace::prepare(&project, &worktree, &head, &[]).unwrap();
    assert_eq!(before, head);
    assert!(worktree.join("main.py").exists());
    fs::write(worktree.join("main.py"), "print('modified')\n").unwrap();
    let node = workspace::snapshot_node(&worktree, &project, "worktree").unwrap();
    assert_ne!(node, head);

    let published =
        grapher::graph_merge::merge_graph(&project, &[node], || Err("conflict".into())).unwrap();
    assert_ne!(published, head);
    assert_eq!(
        fs::read_to_string(project.join("main.py"))
            .unwrap()
            .replace("\r\n", "\n"),
        "print('modified')\n"
    );
    assert!(workspace::repository_git(&project, &["status", "--porcelain"])
        .unwrap()
        .is_empty());

    // Publication success reclaims the snapshot completely.
    workspace::remove_shadow_repo(&project).unwrap();
    assert!(workspace::shadow_repo_if_exists(&project).unwrap().is_none());
}

#[test]
fn missing_shadow_error_semantics() {
    isolate_data_root();
    let temp = tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("a.txt"), "a").unwrap();

    // Not materialized yet: an empty expectation is fine, a stale commit is not.
    assert!(workspace::check_shadow_base(&project, "").is_ok());
    let error = workspace::check_shadow_base(&project, "deadbeef").unwrap_err();
    assert!(error.contains("临时 Git 快照不存在"), "{error}");
    let error = workspace::repository_git(&project, &["rev-parse", "HEAD"]).unwrap_err();
    assert!(error.contains("临时 Git 快照不存在或已回收"), "{error}");
}

#[test]
fn serial_execution_never_materializes_a_plain_directory() {
    isolate_data_root();
    let temp = tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("main.py"), "print('hello')\n").unwrap();

    // A serial source-direct execution has no Git snapshot at all.
    let head = workspace::snapshot_execution(&project, &project, "task").unwrap();
    assert_eq!(head, "");
    assert!(workspace::shadow_repo_if_exists(&project).unwrap().is_none());
    assert!(!project.join(".git").exists());
}
