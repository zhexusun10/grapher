use grapher::workspace;
use std::fs;
use tempfile::tempdir;

#[test]
fn shadow_git_zero_pollution_for_plain_directory() {
    let temp = tempdir().unwrap();
    let data_dir = temp.path().join(".grapher");
    let plain_project = temp.path().join("my-cool-project");
    fs::create_dir_all(&plain_project).unwrap();
    fs::write(plain_project.join("main.py"), "print('hello shadow')\n").unwrap();

    // Set GRAPHER_DATA_DIR so shadow repo is placed in data_dir
    std::env::set_var("GRAPHER_DATA_DIR", &data_dir);

    // 1. Plain project has no .git
    assert!(!plain_project.join(".git").exists());

    // 2. workspace::detect identifies it as a shadow repo
    let detected = workspace::detect(Some(&plain_project)).unwrap().unwrap();
    assert!(detected.is_shadow);
    assert_eq!(detected.name, "my-cool-project");
    assert_eq!(detected.branch, "shadow");
    assert!(!detected.head.is_empty());

    // 3. Confirm zero pollution in the user project
    assert!(
        !plain_project.join(".git").exists(),
        "Plain project must not contain .git"
    );

    // 4. Verify that the shadow repo exists under data_dir
    let shadow_dir = workspace::shadow_repo_dir(&plain_project);
    assert!(
        shadow_dir.exists(),
        "Shadow git repo directory should exist"
    );

    // 5. Test verify() with uncommitted changes in plain_project
    fs::write(plain_project.join("new_file.txt"), "new content").unwrap();
    let head = workspace::verify(&plain_project).unwrap();
    assert!(!head.is_empty());

    // 6. Test prepare() worktree from shadow repository
    let wt1 = temp.path().join("worktree1");
    let before = workspace::prepare(&plain_project, &wt1, &head, &[]).unwrap();
    assert_eq!(before, head);
    assert!(wt1.join("main.py").exists());
    assert!(wt1.join("new_file.txt").exists());

    // 7. Make a commit in worktree1 and snapshot
    fs::write(wt1.join("main.py"), "print('modified in worktree')\n").unwrap();
    let after_wt1 = workspace::snapshot_node(&wt1, &plain_project, "worktree1").unwrap();
    assert_ne!(after_wt1, head);

    // 8. Prepare another worktree and merge wt1's changes
    let wt2 = temp.path().join("worktree2");
    let before_wt2 = workspace::prepare(&plain_project, &wt2, &head, &[after_wt1]).unwrap();
    assert_ne!(before_wt2, head);
    assert_eq!(
        fs::read_to_string(wt2.join("main.py"))
            .unwrap()
            .replace("\r\n", "\n"),
        "print('modified in worktree')\n"
    );

    // 9. Serial execution snapshots through the external shadow repository.
    fs::write(plain_project.join("serial.txt"), "serial result\n").unwrap();
    let serial_head =
        workspace::snapshot_execution(&plain_project, &plain_project, "task").unwrap();
    assert_eq!(
        serial_head,
        workspace::repository_git(&plain_project, &["rev-parse", "HEAD"]).unwrap()
    );

    // 10. Plain project STILL has zero .git pollution
    assert!(
        !plain_project.join(".git").exists(),
        "Plain project must never have .git created inside it"
    );
}
