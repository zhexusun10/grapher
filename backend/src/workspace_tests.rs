use crate::workspace;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tempfile::TempDir;

const RUN_ID: &str = "48b8e1d1-2428-42a2-9b28-9d90f631f9d1";

#[test]
fn directory_inspection_ignores_git_metadata_and_keeps_the_selected_path() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    // Broken Git metadata cannot prevent opening a readable directory. No Git
    // discovery, branch lookup or shadow repository initialization is needed.
    fs::write(project.join(".git"), "gitdir: missing-metadata").unwrap();
    for directory in [&project, &project.join("nested")] {
        fs::create_dir_all(directory).unwrap();
        let info = workspace::inspect_directory(Some(directory))
            .unwrap()
            .unwrap();
        assert_eq!(
            info.path,
            workspace::normalize_workspace_display_path(&directory.canonicalize().unwrap())
        );
        assert_eq!(info.name, directory.file_name().unwrap().to_string_lossy());
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({ "path": info.path, "name": info.name })
        );
    }
    assert_eq!(
        fs::read_to_string(project.join(".git")).unwrap(),
        "gitdir: missing-metadata"
    );
}

#[test]
fn directory_inspection_rejects_missing_files_and_failed_admission() {
    let temp = TempDir::new().unwrap();
    let missing = temp.path().join("missing");
    let file = temp.path().join("file.txt");
    fs::write(&file, "file").unwrap();
    for path in [&missing, &file] {
        assert!(
            workspace::inspect_directory_with_size_check(Some(path), |_| {
                panic!("non-directories must not be scanned");
            })
            .unwrap()
            .is_none()
        );
    }
    let error = workspace::inspect_directory_with_size_check(Some(temp.path()), |_| {
        Err("workspace exceeds size limit".into())
    })
    .unwrap_err();
    assert_eq!(error, "workspace exceeds size limit");
}

fn slot(temp: &TempDir, name: &str) -> PathBuf {
    temp.path()
        .join(".grapher-worktrees")
        .join(RUN_ID)
        .join(name)
}

#[test]
fn host_git_disables_automatic_maintenance() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path();
    workspace::git(repository, &["init", "-q"]).unwrap();
    // A node result is complete before its ref import; an opportunistic repack
    // must never keep the execution in Running after Pi has settled.
    assert_eq!(
        workspace::git(repository, &["config", "--get", "gc.auto"]).unwrap(),
        "0"
    );
    assert_eq!(
        workspace::git(repository, &["config", "--get", "maintenance.auto"]).unwrap(),
        "false"
    );
}

#[test]
fn private_git_queries_use_graph_metadata_and_keep_cli_fallbacks() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("source");
    fs::create_dir(&repository).unwrap();
    workspace::git(&repository, &["init", "-q"]).unwrap();
    fs::write(repository.join("tracked.txt"), "committed").unwrap();
    workspace::git(&repository, &["add", "tracked.txt"]).unwrap();
    workspace::git(&repository, &["commit", "-qm", "project"]).unwrap();
    let user_head = workspace::git(&repository, &["rev-parse", "HEAD"]).unwrap();
    fs::write(repository.join("tracked.txt"), "uncommitted input").unwrap();
    let base = workspace::snapshot_repository(&repository).unwrap();
    let node = slot(&temp, "node");
    workspace::prepare(&repository, &node, &base, &[]).unwrap();
    assert_ne!(base, user_head);
    workspace::project_git(&node, &["update-ref", "refs/grapher/base", &user_head]).unwrap();
    let cli = |args: &[&str]| {
        String::from_utf8(workspace::git_bytes(&node, args, None, None).unwrap())
            .unwrap()
            .trim()
            .to_string()
    };
    for args in [
        vec!["rev-parse", "HEAD"],
        vec!["rev-parse", "--verify", "HEAD"],
        vec!["rev-parse", "refs/grapher/base"],
        vec!["diff", "--name-only", "--diff-filter=U"],
    ] {
        assert_eq!(
            workspace::git_read(&node, &args).unwrap().unwrap(),
            cli(&args)
        );
    }
    assert_eq!(workspace::git(&node, &["rev-parse", "HEAD"]).unwrap(), base);
    assert_eq!(
        workspace::project_git(&node, &["rev-parse", "HEAD"]).unwrap(),
        user_head
    );
    assert!(workspace::git_read(&node, &["status", "--porcelain"]).is_none());
    let ancestry = [
        "merge-base",
        "--is-ancestor",
        user_head.as_str(),
        base.as_str(),
    ];
    assert!(workspace::git_read(&node, &ancestry).is_none());
    assert_eq!(workspace::git(&node, &ancestry).unwrap(), cli(&ancestry));
    for args in [
        vec!["rev-parse", "refs/grapher/missing"],
        vec!["merge-base", "--is-ancestor", &base, &user_head],
    ] {
        assert!(workspace::git_read(&node, &args).is_none());
        assert!(workspace::git(&node, &args).is_err());
    }

    // A graph-only conflict must not consult the project's clean index; quoted
    // paths retain CLI formatting rather than the fast reader's approximation.
    let blob = workspace::git(&node, &["rev-parse", "HEAD:tracked.txt"]).unwrap();
    let conflict = "conflict-é.txt";
    let entries = format!(
        "100644 {blob} 1\t{conflict}\0\
         100644 {blob} 2\t{conflict}\0\
         100644 {blob} 3\t{conflict}\0"
    );
    workspace::git_bytes(
        &node,
        &["update-index", "-z", "--index-info"],
        None,
        Some(entries.as_bytes()),
    )
    .unwrap();
    let args = ["diff", "--name-only", "--diff-filter=U"];
    let expected = cli(&args);
    assert!(!expected.is_empty(), "{}", cli(&["ls-files", "--stage"]));
    assert!(workspace::git_read(&node, &args).is_none(), "{expected:?}");
    assert_eq!(workspace::git(&node, &args).unwrap(), expected);
    assert!(workspace::project_git(&node, &["ls-files", "-u"])
        .unwrap()
        .is_empty());
}

#[test]
fn explicit_shadow_reads_use_the_selected_database_without_caching_refs() {
    for standard in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        let native_head = if standard {
            workspace::git(&source, &["init", "-q"]).unwrap();
            fs::write(source.join("file.txt"), "committed").unwrap();
            workspace::git(&source, &["add", "file.txt"]).unwrap();
            workspace::git(&source, &["commit", "-qm", "source"]).unwrap();
            Some(workspace::git(&source, &["rev-parse", "HEAD"]).unwrap())
        } else {
            None
        };
        let native_index = fs::read(source.join(".git/index")).ok();
        fs::write(source.join("file.txt"), "snapshot bytes").unwrap();
        let head = workspace::snapshot_repository(&source).unwrap();
        assert_ne!(native_head.as_deref(), Some(head.as_str()));
        workspace::repository_git(&source, &["update-ref", "refs/grapher/probe", &head]).unwrap();
        let shadow = workspace::shadow_repo_dir(&source).unwrap();
        for prefix in [
            vec!["--git-dir", shadow.to_str().unwrap()],
            vec![
                "--git-dir",
                shadow.to_str().unwrap(),
                "--work-tree",
                source.to_str().unwrap(),
            ],
        ] {
            for query in [
                vec!["rev-parse", "HEAD"],
                vec!["rev-parse", "--verify", "HEAD"],
                vec!["rev-parse", "refs/grapher/probe"],
                vec!["rev-parse", "--verify", "refs/grapher/probe"],
            ] {
                let mut args = prefix.clone();
                args.extend(query);
                let cli = workspace::git_bytes(&source, &args, None, None).unwrap();
                assert_eq!(
                    workspace::git_read(&source, &args).unwrap().unwrap(),
                    String::from_utf8(cli).unwrap().trim()
                );
            }
            for query in [
                vec!["status", "--porcelain"],
                vec!["diff", "--name-only", "--diff-filter=U"],
                vec!["merge-base", "--is-ancestor", &head, "HEAD"],
                vec!["rev-parse", "refs/grapher/probe^{tree}"],
                vec!["rev-parse", "--verify", "refs/grapher/probe^{tree}"],
                vec!["rev-parse", "refs/grapher/missing"],
                vec!["rev-parse", "--verify", "refs/grapher/missing"],
                vec!["update-ref", "refs/grapher/probe", &head],
            ] {
                let mut args = prefix.clone();
                args.extend(query);
                assert!(workspace::git_read(&source, &args).is_none());
            }
        }
        assert!(
            workspace::git_read(&source, &["--git-dir", ".git", "rev-parse", "HEAD"]).is_none()
        );
        let missing = source.join("missing.git");
        let args = ["--git-dir", missing.to_str().unwrap(), "rev-parse", "HEAD"];
        assert!(workspace::git_read(&source, &args).is_none());
        assert!(workspace::git(&source, &args).is_err());
        assert_eq!(
            workspace::repository_git(&source, &["rev-parse", "HEAD"]).unwrap(),
            head
        );
        let next = workspace::repository_git(
            &source,
            &[
                "commit-tree",
                &format!("{head}^{{tree}}"),
                "-p",
                &head,
                "-m",
                "next",
            ],
        )
        .unwrap();
        workspace::repository_git(&source, &["update-ref", "HEAD", &next]).unwrap();
        assert_eq!(
            workspace::repository_git(&source, &["rev-parse", "HEAD"]).unwrap(),
            next
        );
        if let Some(native_head) = native_head {
            assert_eq!(
                workspace::git(&source, &["rev-parse", "HEAD"]).unwrap(),
                native_head
            );
        } else {
            assert!(!source.join(".git").exists());
        }
        assert_eq!(fs::read(source.join(".git/index")).ok(), native_index);
        assert_eq!(
            fs::read_to_string(source.join("file.txt")).unwrap(),
            "snapshot bytes"
        );
    }
}

fn private_query_fixture() -> (TempDir, PathBuf, String, String) {
    let temp = tempfile::tempdir().unwrap();
    let (source, base) = source(&temp);
    let node = slot(&temp, "query");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    fs::write(node.join("tracked.txt"), "new task bytes").unwrap();
    workspace::git(&node, &["add", "tracked.txt"]).unwrap();
    workspace::git(&node, &["commit", "-qm", "task"]).unwrap();
    let head = workspace::git(&node, &["rev-parse", "HEAD"]).unwrap();
    (temp, node, base, head)
}

#[test]
fn git_read_private_ancestry_obeys_replacement_refs() {
    let (_temp, node, base, head) = private_query_fixture();
    workspace::git(&node, &["replace", &head, &base]).unwrap();
    let args = ["merge-base", "--is-ancestor", &base, "HEAD"];
    assert!(workspace::git_bytes(&node, &args, None, None).is_err());
    assert!(
        workspace::verify_prepared_ancestor(&node, &base).is_err(),
        "the optimized reader must not accept ancestry rejected by Git"
    );
}

#[test]
fn git_read_private_revision_obeys_replacement_refs() {
    let (_temp, node, base, head) = private_query_fixture();
    workspace::git(&node, &["update-ref", "refs/grapher/query", &head]).unwrap();
    workspace::git(&node, &["replace", &head, &base]).unwrap();
    let args = ["rev-parse", "refs/grapher/query^{tree}"];
    let expected =
        String::from_utf8(workspace::git_bytes(&node, &args, None, None).unwrap()).unwrap();
    assert_eq!(workspace::git(&node, &args).unwrap(), expected.trim());
}

#[test]
fn git_read_private_ancestry_rejects_noncommit_objects() {
    let (_temp, node, _base, _head) = private_query_fixture();
    for revision in ["HEAD^{tree}", "HEAD:tracked.txt"] {
        let object = workspace::git(&node, &["rev-parse", revision]).unwrap();
        let args = ["merge-base", "--is-ancestor", &object, &object];
        assert!(workspace::git_bytes(&node, &args, None, None).is_err());
        assert!(
            workspace::git(&node, &args).is_err(),
            "{revision} is not a commit"
        );
    }
}

#[test]
fn git_read_explicit_directory_does_not_discover_dot_git() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path();
    workspace::git(source, &["init", "-q"]).unwrap();
    workspace::git(source, &["commit", "--allow-empty", "-qm", "source"]).unwrap();
    for args in [
        vec!["--git-dir", source.to_str().unwrap(), "rev-parse", "HEAD"],
        vec![
            "--git-dir",
            source.to_str().unwrap(),
            "--work-tree",
            source.to_str().unwrap(),
            "rev-parse",
            "HEAD",
        ],
    ] {
        assert!(workspace::git_bytes(source, &args, None, None).is_err());
        assert!(
            workspace::git(source, &args).is_err(),
            "an invalid explicit Git directory must not discover its nested .git"
        );
    }
}

#[test]
fn node_snapshot_stages_independent_slots_before_waiting_for_host_refs() {
    use std::time::{Duration, Instant};

    for standard in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("input.txt"), "input").unwrap();
        if standard {
            workspace::git(&source, &["init", "-q"]).unwrap();
            workspace::git(&source, &["add", "."]).unwrap();
            workspace::git(&source, &["commit", "-qm", "source"]).unwrap();
        }
        let base = workspace::snapshot_repository(&source).unwrap();
        let slots: Vec<_> = ["a", "b"]
            .into_iter()
            .map(|name| {
                let slot = slot(&temp, name);
                workspace::prepare(&source, &slot, &base, &[]).unwrap();
                fs::write(slot.join("result.txt"), name).unwrap();
                slot
            })
            .collect();
        let metadata: Vec<_> = slots
            .iter()
            .map(|slot| workspace::private_git_dir(slot).unwrap())
            .collect();
        let local_heads: Vec<_> = metadata
            .iter()
            .map(|dir| {
                git2::Repository::open(dir)
                    .unwrap()
                    .find_reference("refs/heads/grapher-node")
                    .unwrap()
                    .target()
                    .unwrap()
            })
            .collect();
        let lock = workspace::host_ref_lock(&source).unwrap();
        let guard = lock.lock().unwrap();
        let workers: Vec<_> = slots
            .iter()
            .cloned()
            .map(|slot| {
                let source = source.clone();
                std::thread::spawn(move || {
                    let name = slot.file_name().unwrap().to_str().unwrap();
                    workspace::snapshot_node(&slot, &source, name)
                })
            })
            .collect();

        // Observe private refs without acquiring the slot leases the workers
        // retain while waiting for import. This is a lock-order assertion, not
        // a performance threshold: the held host lock cannot be released until
        // both local commits exist. The deadline only bounds a broken test.
        let deadline = Instant::now() + Duration::from_secs(30);
        let staged = loop {
            let ready = metadata.iter().zip(&local_heads).all(|(dir, previous)| {
                git2::Repository::open(dir)
                    .ok()
                    .and_then(|repo| {
                        repo.find_reference("refs/heads/grapher-node")
                            .ok()
                            .and_then(|reference| reference.target())
                    })
                    .is_some_and(|head| head != *previous)
            });
            if ready || Instant::now() >= deadline {
                break ready;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        // Cleanup may run while local snapshots wait to import. The active
        // inputs must remain pinned in the shared alternate even after a GC;
        // the workers' new objects belong to their own private repositories.
        let collected =
            staged.then(|| workspace::repository_git(&source, &["gc", "--prune=now", "--quiet"]));
        drop(guard); // Release before asserting/joining, including regressions.
        let heads: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap().unwrap())
            .collect();
        assert!(
            staged,
            "private snapshots waited for the repository ref lock"
        );
        collected.unwrap().unwrap();
        assert_ne!(heads[0], heads[1]);
        for ((slot, head), name) in slots.iter().zip(&heads).zip(["a", "b"]) {
            assert_eq!(
                workspace::repository_git(
                    &source,
                    &["rev-parse", &format!("refs/grapher/heads/{head}"),]
                )
                .unwrap(),
                *head
            );
            assert_eq!(
                workspace::repository_git(
                    &source,
                    &[
                        "rev-parse",
                        &format!(
                            "refs/grapher/runs/{RUN_ID}/nodes/{}",
                            crate::compiler::node_id(name)
                        ),
                    ]
                )
                .unwrap(),
                *head
            );
            assert_eq!(
                workspace::repository_git(&source, &["show", &format!("{head}:result.txt"),])
                    .unwrap(),
                name
            );
            crate::workspace_view::verify_result(slot, &source, head).unwrap();
            let downstream = self::slot(&temp, &format!("child-{name}"));
            workspace::prepare(&source, &downstream, &base, std::slice::from_ref(head)).unwrap();
            assert_eq!(
                fs::read_to_string(downstream.join("result.txt")).unwrap(),
                name
            );
        }
        assert!(!source.join("result.txt").exists());
    }
}

#[test]
fn node_snapshot_refuses_changes_between_staging_and_capture() {
    use std::time::{Duration, Instant};

    for metadata_only in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("input.txt"), "input").unwrap();
        let base = workspace::snapshot_repository(&source).unwrap();
        let slot = slot(&temp, "node");
        workspace::prepare(&source, &slot, &base, &[]).unwrap();
        fs::write(slot.join("result.txt"), "first").unwrap();
        let metadata = workspace::private_git_dir(&slot).unwrap();
        let previous = workspace::git(&slot, &["rev-parse", "HEAD"]).unwrap();
        let lock = workspace::host_ref_lock(&source).unwrap();
        let guard = lock.lock().unwrap();
        let worker_source = source.clone();
        let worker_slot = slot.clone();
        let worker = std::thread::spawn(move || {
            workspace::snapshot_node(&worker_slot, &worker_source, "node")
        });
        // The held host lock separates local staging/commit from import and
        // final capture, without a production test hook or a timing race.
        let deadline = Instant::now() + Duration::from_secs(30);
        let staged = loop {
            let head = git2::Repository::open(&metadata)
                .ok()
                .and_then(|repo| {
                    repo.find_reference("refs/heads/grapher-node")
                        .ok()
                        .and_then(|reference| reference.target())
                })
                .filter(|head| head.to_string() != previous);
            if head.is_some() || Instant::now() >= deadline {
                break head;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        if staged.is_some() {
            if metadata_only {
                fs::create_dir(slot.join("late-empty-directory")).unwrap();
            } else {
                // Same-size external edits must not pass the blob-size check
                // and bind fresh view metadata to stale staged project bytes.
                fs::write(slot.join("result.txt"), "other").unwrap();
            }
        }
        drop(guard);
        let result = worker.join().unwrap();
        let head = staged
            .expect("node did not reach the import boundary")
            .to_string();
        let error = result.expect_err("a changed workspace must not produce a completed snapshot");
        assert!(
            error.contains("changed between staging and capture"),
            "{error}"
        );
        assert!(
            !crate::workspace_view::has_record(&source, &head),
            "failed capture must not publish mixed code/view evidence"
        );
        // A fresh attempt observes the actual new state and remains usable.
        let retried = workspace::snapshot_node(&slot, &source, "node").unwrap();
        crate::workspace_view::verify_result(&slot, &source, &retried).unwrap();
    }
}

#[test]
fn node_snapshot_allows_source_edits_between_staging_and_capture() {
    use std::time::{Duration, Instant};

    for standard in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("input.txt"), "recorded input").unwrap();
        fs::write(source.join("removed.txt"), "recorded file").unwrap();
        if standard {
            workspace::git(&source, &["init", "-q"]).unwrap();
            workspace::git(&source, &["config", "user.name", "Project Author"]).unwrap();
            workspace::git(
                &source,
                &["config", "user.email", "project@example.invalid"],
            )
            .unwrap();
            workspace::project_git(&source, &["add", "."]).unwrap();
            workspace::project_git(&source, &["commit", "-qm", "source"]).unwrap();
        }
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = slot(&temp, "node");
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        let original_project_head =
            standard.then(|| workspace::project_git(&node, &["rev-parse", "HEAD"]).unwrap());
        fs::write(node.join("result.txt"), "node result").unwrap();
        let metadata = workspace::private_git_dir(&node).unwrap();
        let previous = workspace::git(&node, &["rev-parse", "HEAD"]).unwrap();
        let lock = workspace::host_ref_lock(&source).unwrap();
        let guard = lock.lock().unwrap();
        let worker_node = node.clone();
        let worker_source = source.clone();
        let worker = std::thread::spawn(move || {
            workspace::snapshot_node(&worker_node, &worker_source, "node")
        });
        let deadline = Instant::now() + Duration::from_secs(30);
        let staged = loop {
            let ready = git2::Repository::open(&metadata)
                .ok()
                .and_then(|repo| {
                    repo.find_reference("refs/heads/grapher-node")
                        .ok()
                        .and_then(|reference| reference.target())
                })
                .is_some_and(|head| head.to_string() != previous);
            if ready || Instant::now() >= deadline {
                break ready;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        // Only the node slot is frozen. The user's live source, including its
        // own HEAD/index, can change after staging and before result capture.
        fs::write(source.join("input.txt"), "live source edit").unwrap();
        fs::write(source.join("source-only.txt"), "new source file").unwrap();
        fs::remove_file(source.join("removed.txt")).unwrap();
        fs::create_dir(source.join("source-only-directory")).unwrap();
        let live_head = standard.then(|| {
            workspace::project_git(&source, &["add", "-A"]).unwrap();
            workspace::project_git(&source, &["commit", "-qm", "concurrent source edit"]).unwrap();
            fs::write(source.join("input.txt"), "staged source edit").unwrap();
            workspace::project_git(&source, &["add", "input.txt"]).unwrap();
            fs::write(source.join("input.txt"), "unstaged source edit").unwrap();
            workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap()
        });
        let live_index = fs::read(source.join(".git/index")).ok();
        drop(guard);
        let result = worker.join().unwrap();
        assert!(staged, "node did not reach the import boundary");
        let head = result.expect("live source edits must not reject a private node result");
        crate::workspace_view::verify_result(&node, &source, &head).unwrap();
        assert_eq!(fs::read(source.join(".git/index")).ok(), live_index);
        if let Some(live_head) = live_head {
            assert_eq!(
                workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap(),
                live_head
            );
        }
        assert_eq!(
            fs::read_to_string(source.join("input.txt")).unwrap(),
            if standard {
                "unstaged source edit"
            } else {
                "live source edit"
            }
        );
        assert!(source.join("source-only.txt").is_file());
        assert!(!source.join("removed.txt").exists());
        assert!(!source.join("result.txt").exists());

        let child = slot(&temp, "child");
        workspace::prepare(&source, &child, &base, &[head]).unwrap();
        assert_eq!(
            fs::read_to_string(child.join("input.txt")).unwrap(),
            "recorded input"
        );
        assert_eq!(
            fs::read_to_string(child.join("removed.txt")).unwrap(),
            "recorded file"
        );
        assert_eq!(
            fs::read_to_string(child.join("result.txt")).unwrap(),
            "node result"
        );
        assert!(!child.join("source-only.txt").exists());
        assert!(!child.join("source-only-directory").exists());
        if let Some(original) = original_project_head {
            assert_eq!(
                workspace::project_git(&child, &["rev-parse", "HEAD"]).unwrap(),
                original
            );
        }
    }
}

#[test]
fn node_snapshot_rejects_conflicts_without_waiting_for_host_refs() {
    use std::sync::mpsc;
    use std::time::Duration;

    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("input.txt"), "input").unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let slot = slot(&temp, "node");
    workspace::prepare(&source, &slot, &base, &[]).unwrap();
    let blob = workspace::git(&slot, &["rev-parse", "HEAD:input.txt"]).unwrap();
    workspace::git_bytes(
        &slot,
        &["update-index", "--index-info"],
        None,
        Some(format!("100644 {blob} 1\tconflict.txt\n100644 {blob} 2\tconflict.txt\n").as_bytes()),
    )
    .unwrap();
    let lock = workspace::host_ref_lock(&source).unwrap();
    let guard = lock.lock().unwrap();
    let (send, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        send.send(workspace::snapshot_node(&slot, &source, "node"))
            .unwrap();
    });
    let result = receive.recv_timeout(Duration::from_secs(30));
    drop(guard);
    worker.join().unwrap();
    assert!(result
        .expect("conflict validation waited for the host ref lock")
        .unwrap_err()
        .contains("Unresolved merge conflicts remain"));
}

#[test]
fn snapshot_commits_use_neutral_subject() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path();
    workspace::git(repository, &["init", "-q"]).unwrap();
    fs::write(repository.join("tracked.txt"), "snapshot").unwrap();
    let head = workspace::snapshot_repository(repository).unwrap();
    assert_eq!(
        workspace::repository_git(repository, &["log", "-1", "--format=%s", &head]).unwrap(),
        "snapshot"
    );
    assert!(
        workspace::git(repository, &["log", "-1", "--format=%s"]).is_err(),
        "source snapshot must not create a user commit"
    );
}

#[test]
fn git_line_ending_warnings_do_not_fail_snapshots() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path();
    workspace::git(repository, &["init", "-q"]).unwrap();
    workspace::git(repository, &["config", "core.autocrlf", "true"]).unwrap();
    workspace::git(repository, &["config", "core.safecrlf", "warn"]).unwrap();
    fs::write(repository.join(".gitattributes"), "*.txt text\n").unwrap();
    fs::write(repository.join("input.txt"), "first\nsecond\n").unwrap();

    // Confirm this repository really produces a successful add with warnings.
    let mut command = std::process::Command::new("git");
    crate::native::clear_git_environment(&mut command);
    let output = command
        .args(["add", "--", "input.txt"])
        .env("LC_ALL", "C")
        .current_dir(repository)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("LF will be replaced by CRLF"), "{stderr}");

    fs::write(repository.join("input.txt"), "updated\nsecond\n").unwrap();
    let head = workspace::snapshot_repository(repository).unwrap();
    assert!(!head.is_empty());
    assert_eq!(
        workspace::repository_git(repository, &["show", &format!("{head}:input.txt")]).unwrap(),
        "updated\nsecond"
    );
    assert_eq!(workspace::snapshot_repository(repository).unwrap(), head);
    assert!(workspace::git(repository, &["rev-parse", "--verify", "HEAD"]).is_err());
}

#[test]
fn raw_workspace_capture_preserves_bytes_without_running_line_ending_filters() {
    let temp = tempfile::tempdir().unwrap();
    workspace::git(temp.path(), &["init", "-q"]).unwrap();
    workspace::git(temp.path(), &["config", "core.autocrlf", "true"]).unwrap();
    workspace::git(temp.path(), &["config", "core.safecrlf", "true"]).unwrap();
    fs::write(
        temp.path().join(".gitattributes"),
        "*.txt text\n.gitattributes -text\n",
    )
    .unwrap();
    fs::write(temp.path().join("input.txt"), "first\nsecond\n").unwrap();
    let head = workspace::snapshot_repository(temp.path()).unwrap();
    let blob = workspace::repository_git(temp.path(), &["rev-parse", &format!("{head}:input.txt")])
        .unwrap();
    let metadata = workspace::shadow_repo_dir(temp.path()).unwrap();
    assert_eq!(
        workspace::git_bytes(
            temp.path(),
            &[
                "--git-dir",
                metadata.to_str().unwrap(),
                "cat-file",
                "blob",
                &blob
            ],
            None,
            None
        )
        .unwrap(),
        b"first\nsecond\n"
    );
    assert!(workspace::project_git(temp.path(), &["rev-parse", "--verify", "HEAD"]).is_err());
}

#[test]
fn git_failure_keeps_exit_status_command_directory_and_both_streams() {
    let temp = tempfile::tempdir().unwrap();
    let error = workspace::git(temp.path(), &[
        "-c",
        "alias.grapher-fail=!printf 'failure detail on stdout\\n'; printf 'warning: line endings\\n' >&2; exit 23",
        "grapher-fail",
    ]).unwrap_err();
    assert!(
        error.contains("exit code: 23") || error.contains("exit status: 23"),
        "{error}"
    );
    assert!(error.contains("grapher-fail"), "{error}");
    assert!(
        error.contains(&temp.path().display().to_string()),
        "{error}"
    );
    assert!(error.contains("stderr:\nwarning: line endings"), "{error}");
    assert!(
        error.contains("stdout:\nfailure detail on stdout"),
        "{error}"
    );
}

#[test]
fn git_failure_without_output_still_explains_which_command_failed() {
    let temp = tempfile::tempdir().unwrap();
    let error = workspace::git(
        temp.path(),
        &["-c", "alias.grapher-fail=!exit 19", "grapher-fail"],
    )
    .unwrap_err();
    assert!(
        error.contains("exit code: 19") || error.contains("exit status: 19"),
        "{error}"
    );
    assert!(error.contains("grapher-fail"), "{error}");
    assert!(
        error.contains(&temp.path().display().to_string()),
        "{error}"
    );
}

#[cfg(windows)]
#[test]
fn git_crash_with_only_warnings_keeps_windows_exception_status() {
    use std::os::windows::process::ExitStatusExt;
    let output = std::process::Output {
        status: std::process::ExitStatus::from_raw(0xC0000005),
        stdout: Vec::new(),
        stderr: b"warning: LF will be replaced by CRLF\n".to_vec(),
    };
    let error =
        workspace::git_command_failure(Path::new("C:/project"), &["add", "-f", "-A"], &output);
    assert!(error.contains("0xC0000005"), "{error}");
    assert!(error.contains("add"), "{error}");
    assert!(
        error.contains("warning: LF will be replaced by CRLF"),
        "{error}"
    );
}

#[cfg(windows)]
#[test]
fn git_control_c_exit_is_reported_as_console_interruption() {
    use std::os::windows::process::ExitStatusExt;
    let output = std::process::Output {
        status: std::process::ExitStatus::from_raw(0xC000013A),
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    let error = workspace::git_command_failure(
        Path::new("C:/project"),
        &["commit", "-m", "snapshot"],
        &output,
    );
    assert!(error.contains("0xC000013A"), "{error}");
    assert!(error.contains("console control event"), "{error}");
    assert!(error.contains("Ctrl+C/Ctrl+Break"), "{error}");
}

#[cfg(unix)]
#[test]
fn git_killed_with_only_warnings_keeps_signal_status() {
    use std::os::unix::process::ExitStatusExt;
    let output = std::process::Output {
        status: std::process::ExitStatus::from_raw(9),
        stdout: Vec::new(),
        stderr: b"warning: line endings\n".to_vec(),
    };
    let error =
        workspace::git_command_failure(Path::new("/project"), &["add", "-f", "-A"], &output);
    assert!(error.contains(&output.status.to_string()), "{error}");
    assert!(error.contains("warning: line endings"), "{error}");
}

fn source(temp: &TempDir) -> (PathBuf, String) {
    let repository = temp.path().join("source");
    fs::create_dir(&repository).unwrap();
    workspace::git(&repository, &["init", "-q"]).unwrap();
    fs::write(
        repository.join(".gitignore"),
        ".cache/\npackages/\n*.large\n",
    )
    .unwrap();
    fs::write(repository.join("tracked.txt"), "from Git history").unwrap();
    let head = workspace::snapshot_repository(&repository).unwrap();
    (repository, head)
}

fn prepared_copy(
    source: &Path,
    destination: &Path,
    head: &str,
    exclusions: &[String],
    runtime_data: &Path,
) {
    workspace::prepare(source, destination, head, &[]).unwrap();
    workspace::copy_ordinary_files(source, destination, exclusions, runtime_data).unwrap();
}

#[test]
fn ordinary_copy_ignores_gitignore_and_keeps_tracked_files_from_the_git_commit() {
    let temp = tempfile::tempdir().unwrap();
    let (source, head) = source(&temp);
    fs::create_dir(source.join(".cache")).unwrap();
    fs::write(source.join(".cache/input"), "ordinary bytes").unwrap();
    fs::write(source.join("tracked.txt"), "late source edit").unwrap();
    let a = temp.path().join("a");
    let b = temp.path().join("b");

    prepared_copy(&source, &a, &head, &[], &temp.path().join("runtime"));
    prepared_copy(&source, &b, &head, &[], &temp.path().join("runtime"));

    assert_eq!(
        fs::read_to_string(a.join(".cache/input")).unwrap(),
        "ordinary bytes"
    );
    assert_eq!(
        fs::read_to_string(a.join("tracked.txt")).unwrap(),
        "from Git history"
    );
    fs::write(a.join(".cache/input"), "changed in A").unwrap();
    assert_eq!(
        fs::read_to_string(b.join(".cache/input")).unwrap(),
        "ordinary bytes"
    );
    assert_eq!(
        fs::read_to_string(source.join(".cache/input")).unwrap(),
        "ordinary bytes"
    );
    assert!(a.join(".git").is_dir());
}

#[test]
fn ordinary_copy_excludes_runtime_data_environment_scopes_and_grapher_internals() {
    let temp = tempfile::tempdir().unwrap();
    let (source, head) = source(&temp);
    fs::create_dir_all(source.join("packages/wheels")).unwrap();
    fs::write(source.join("packages/wheels/big.whl"), "environment data").unwrap();
    fs::create_dir_all(source.join("local-data")).unwrap();
    fs::write(source.join("local-data/runtime.db"), "runtime data").unwrap();
    fs::create_dir_all(source.join(".grapher-private")).unwrap();
    fs::write(source.join(".grapher-private/secret"), "internal").unwrap();
    let destination = temp.path().join("target");
    prepared_copy(
        &source,
        &destination,
        &head,
        &["packages".into()],
        &source.join("local-data"),
    );

    assert!(!destination.join("packages").exists());
    assert!(!destination.join("local-data").exists());
    assert!(!destination.join(".grapher-private").exists());
}

#[cfg(unix)]
#[test]
fn ordinary_copy_preserves_symbolic_links_and_permissions_without_following_targets() {
    use std::os::unix::{fs::symlink, fs::PermissionsExt};
    let temp = tempfile::tempdir().unwrap();
    let (source, head) = source(&temp);
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), "external").unwrap();
    fs::create_dir(source.join(".cache")).unwrap();
    fs::write(source.join(".cache/tool"), "tool").unwrap();
    fs::set_permissions(
        source.join(".cache/tool"),
        fs::Permissions::from_mode(0o750),
    )
    .unwrap();
    symlink(&outside, source.join(".cache/external")).unwrap();
    let destination = temp.path().join("target");
    prepared_copy(
        &source,
        &destination,
        &head,
        &[],
        &temp.path().join("runtime"),
    );

    let link = destination.join(".cache/external");
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_link(link).unwrap(), outside);
    assert_eq!(
        fs::metadata(destination.join(".cache/tool"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o750
    );
}

#[cfg(unix)]
#[test]
fn ordinary_copy_rejects_unsupported_special_files_explicitly() {
    let temp = tempfile::tempdir().unwrap();
    let (source, head) = source(&temp);
    let special = source.join(".cache/pipe");
    fs::create_dir(source.join(".cache")).unwrap();
    let name = std::ffi::CString::new(special.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let destination = temp.path().join("target");
    workspace::prepare(&source, &destination, &head, &[]).unwrap();
    let error =
        workspace::copy_ordinary_files(&source, &destination, &[], &temp.path().join("runtime"))
            .unwrap_err();
    assert!(error.contains("Unsupported special workspace file"));
}

#[test]
fn collection_predicates_keep_case_unicode_and_tracked_override_rules() {
    use std::collections::BTreeSet;
    let cases = [
        ("src/file.ts", false, false, false),
        ("src/你好.PyC", false, false, false),
        ("é", false, false, false),
        ("代码", false, false, false),
        (".pYc", false, false, false),
        ("pyc", false, false, false),
        ("nested/cache.PYO", false, false, false),
        ("file.TsBuIlDiNfO", true, false, false),
        ("NODE_MODULES/pkg/file.js", false, false, false),
        ("src/__PyCache__/module", true, false, false),
        (".Next/build-id", false, false, false),
        ("not_node_modules/file.js", false, false, false),
        ("dist/build/out/target/authored", false, false, false),
        (
            "x/.grapher-publish-0123456789abcdef.tmp",
            false,
            true,
            false,
        ),
        (
            "x/.grapher-publish-0123456789abcdeG.tmp",
            false,
            false,
            false,
        ),
        ("x/.grapher-publish-01234.tmp", false, false, false),
        ("managed/normal.txt", false, false, true),
        ("managed/tracked.pyc", false, false, true),
        (
            "managed/.grapher-publish-0123456789abcdef.tmp",
            false,
            true,
            true,
        ),
    ];
    for (name, generated, reserved, managed) in cases {
        assert_eq!(
            workspace::is_generated_artifact(Path::new(name)),
            generated,
            "{name}"
        );
        for tracked in [false, true] {
            let paths = if tracked {
                BTreeSet::from([name.to_string()])
            } else {
                BTreeSet::new()
            };
            for exclude_managed in [false, true] {
                let exclusions = if exclude_managed {
                    vec!["managed".into()]
                } else {
                    vec![]
                };
                assert_eq!(
                    workspace::collection_excluded(Path::new(name), &paths, &exclusions),
                    (managed && exclude_managed) || (!tracked && (generated || reserved)),
                    "{name}, tracked={tracked}, managed={exclude_managed}"
                );
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn generated_suffix_checks_keep_non_utf8_name_behavior() {
    use std::os::unix::ffi::OsStrExt;
    for (bytes, generated) in [
        (b"cache/\xff.PyC".as_slice(), false),
        (b"cache/\xff.TsBuildInfo".as_slice(), true),
        (b"__pycache__/\xff.pyc".as_slice(), true),
        (b"src/\xff.rs".as_slice(), false),
        (b"\xff".as_slice(), false),
    ] {
        let path = Path::new(std::ffi::OsStr::from_bytes(bytes));
        assert_eq!(workspace::is_generated_artifact(path), generated);
    }
}

#[test]
fn host_metadata_is_excluded_from_forced_snapshots_unless_already_tracked() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("source");
    fs::create_dir(&repository).unwrap();
    workspace::git(&repository, &["init", "-q"]).unwrap();
    fs::write(repository.join(".gitignore"), ".DS_Store\n._*\n").unwrap();
    fs::write(repository.join("keep.txt"), "keep").unwrap();
    fs::write(repository.join(".DS_Store"), "tracked metadata").unwrap();
    workspace::git(
        &repository,
        &["add", "-f", ".gitignore", "keep.txt", ".DS_Store"],
    )
    .unwrap();
    workspace::git(&repository, &["commit", "-qm", "base"]).unwrap();

    fs::create_dir(repository.join("nested")).unwrap();
    fs::write(repository.join("nested/.DS_Store"), "untracked nested").unwrap();
    fs::write(repository.join("._xattr"), "untracked apple double").unwrap();
    fs::write(repository.join(".DS_Store"), "tracked metadata updated").unwrap();
    fs::write(repository.join("keep.txt"), "keep updated").unwrap();
    let head = workspace::snapshot_repository(&repository).unwrap();
    let tree =
        workspace::repository_git(&repository, &["ls-tree", "-r", "--name-only", &head]).unwrap();
    let names: Vec<&str> = tree.lines().collect();

    if cfg!(target_os = "macos") {
        assert!(
            names.contains(&".DS_Store"),
            "explicitly tracked metadata remains: {names:?}"
        );
        assert_eq!(
            workspace::repository_git(&repository, &["show", &format!("{head}:.DS_Store")])
                .unwrap(),
            "tracked metadata updated"
        );
        assert!(
            !names.contains(&"nested/.DS_Store"),
            "Finder metadata entered the snapshot: {names:?}"
        );
        assert!(
            !names.contains(&"._xattr"),
            "AppleDouble metadata entered the snapshot: {names:?}"
        );
    } else {
        // Keep the Windows/Linux collection contract unchanged.
        assert!(
            names.contains(&"nested/.DS_Store"),
            "non-macOS metadata collection changed: {names:?}"
        );
        assert!(
            names.contains(&"._xattr"),
            "non-macOS metadata collection changed: {names:?}"
        );
    }

    // Untracked Finder metadata created after a snapshot must not keep the
    // workspace permanently dirty, while tracked metadata edits stay visible.
    fs::write(repository.join("._late"), "late apple double").unwrap();
    fs::write(repository.join("._space file"), "quoted apple double").unwrap();
    assert_eq!(
        workspace::repository_status(&repository, &[])
            .unwrap()
            .is_empty(),
        cfg!(target_os = "macos")
    );
    assert_eq!(
        workspace::repository_status(&repository, &["managed".into()])
            .unwrap()
            .is_empty(),
        cfg!(target_os = "macos")
    );
    fs::write(repository.join(".DS_Store"), "pending tracked edit").unwrap();
    assert!(!workspace::repository_status(&repository, &[])
        .unwrap()
        .is_empty());
    assert!(
        !workspace::repository_status(&repository, &["managed".into()])
            .unwrap()
            .is_empty()
    );
    fs::write(repository.join(".DS_Store"), "tracked metadata updated").unwrap();

    let destination = temp.path().join("target");
    prepared_copy(
        &repository,
        &destination,
        &head,
        &[],
        &temp.path().join("runtime"),
    );
    assert_eq!(
        fs::read_to_string(destination.join(".DS_Store")).unwrap(),
        "tracked metadata updated"
    );
    if cfg!(target_os = "macos") {
        assert!(!destination.join("nested/.DS_Store").exists());
        assert!(!destination.join("._xattr").exists());
        assert!(!destination.join("._space file").exists());
    } else {
        assert_eq!(
            fs::read_to_string(destination.join("nested/.DS_Store")).unwrap(),
            "untracked nested"
        );
        assert_eq!(
            fs::read_to_string(destination.join("._xattr")).unwrap(),
            "untracked apple double"
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn untracked_finder_metadata_is_not_restored_into_a_private_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("source");
    fs::create_dir(&repository).unwrap();
    workspace::git(&repository, &["init", "-q"]).unwrap();
    fs::write(repository.join("main.txt"), "project file").unwrap();
    workspace::git(&repository, &["add", "main.txt"]).unwrap();
    workspace::git(&repository, &["commit", "-qm", "base"]).unwrap();
    fs::write(repository.join(".DS_Store"), "Finder metadata").unwrap();
    fs::create_dir(repository.join("nested")).unwrap();
    fs::write(repository.join("nested/._resource"), "AppleDouble metadata").unwrap();

    let base = workspace::snapshot_repository(&repository).unwrap();
    let node = slot(&temp, "finder-metadata");
    workspace::prepare(&repository, &node, &base, &[]).unwrap();

    assert_eq!(
        fs::read_to_string(node.join("main.txt")).unwrap(),
        "project file"
    );
    assert!(!node.join(".DS_Store").exists());
    assert!(!node.join("nested/._resource").exists());
}

#[test]
fn host_metadata_does_not_dirty_a_shadow_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    fs::write(project.join("main.py"), "print('hello')\n").unwrap();
    workspace::materialize_shadow_repo(&project, &[]).unwrap();
    fs::write(project.join("._late"), "metadata").unwrap();
    assert_eq!(
        workspace::repository_status(&project, &[])
            .unwrap()
            .is_empty(),
        cfg!(target_os = "macos")
    );
}

#[cfg(target_os = "macos")]
#[test]
fn macos_filtered_status_preserves_tracked_and_rename_entries() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("source");
    fs::create_dir(&repository).unwrap();
    workspace::git(&repository, &["init", "-q"]).unwrap();
    fs::write(repository.join("a.txt"), "a").unwrap();
    workspace::git(&repository, &["add", "-A"]).unwrap();
    workspace::git(&repository, &["commit", "-qm", "base"]).unwrap();
    workspace::git(&repository, &["mv", "a.txt", "b.txt"]).unwrap();
    workspace::repository_status(&repository, &["managed".into()]).unwrap();
    fs::write(repository.join("._late"), "metadata").unwrap();
    let status = workspace::repository_status(&repository, &["managed".into()]).unwrap();
    assert!(
        status.contains("R  b.txt -> a.txt"),
        "rename status lost: {status}"
    );
    assert!(
        !status.contains("._late"),
        "host metadata leaked into status: {status}"
    );
}

#[test]
fn git_snapshots_collect_gitignored_project_files_without_a_large_file_gate() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("source");
    fs::create_dir(&repository).unwrap();
    workspace::git(&repository, &["init", "-q"]).unwrap();
    fs::write(repository.join(".gitignore"), "packages/\n").unwrap();
    fs::write(repository.join("tracked.txt"), "tracked").unwrap();
    workspace::snapshot_repository(&repository).unwrap();

    fs::create_dir_all(repository.join("packages")).unwrap();
    fs::write(
        repository.join("packages/data.bin"),
        vec![7; 2 * 1024 * 1024],
    )
    .unwrap();
    workspace::snapshot_repository(&repository).unwrap();

    let tracked = workspace::repository_git(&repository, &["ls-files"]).unwrap();
    assert!(tracked.lines().any(|name| name == "packages/data.bin"));
}

#[test]
fn unborn_source_snapshot_is_internal_and_keeps_user_head_unborn() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("source");
    fs::create_dir(&repository).unwrap();
    workspace::git(&repository, &["init", "-q"]).unwrap();
    fs::write(repository.join("tracked.txt"), "snapshot").unwrap();
    let head = workspace::snapshot_repository(&repository).unwrap();
    assert!(!head.is_empty());
    assert!(workspace::git(&repository, &["rev-parse", "--verify", "HEAD"]).is_err());
    assert_eq!(
        workspace::repository_git(&repository, &["rev-parse", &format!("{head}^{{tree}}")])
            .unwrap(),
        workspace::repository_git(&repository, &["rev-parse", "HEAD^{tree}"]).unwrap()
    );
    assert_eq!(
        workspace::repository_git(&repository, &["show", &format!("{head}:tracked.txt")]).unwrap(),
        "snapshot"
    );
}

#[test]
fn graph_snapshot_copies_local_filter_and_attribute_settings() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("source");
    fs::create_dir(&repository).unwrap();
    workspace::git(&repository, &["init", "-q"]).unwrap();
    workspace::git(&repository, &["config", "filter.demo.clean", "tr a-z A-Z"]).unwrap();
    fs::create_dir_all(repository.join(".git/info")).unwrap();
    fs::write(repository.join(".git/info/attributes"), "*.txt -text\n").unwrap();
    fs::write(repository.join("tracked.txt"), "snapshot").unwrap();
    workspace::snapshot_repository(&repository).unwrap();
    assert_eq!(
        workspace::repository_git(&repository, &["config", "--get", "filter.demo.clean"]).unwrap(),
        "tr a-z A-Z"
    );
    let shadow = workspace::shadow_repo_dir(&repository).unwrap();
    assert_eq!(
        fs::read_to_string(shadow.join("info/attributes")).unwrap(),
        "*.txt -text\n"
    );
}

#[test]
fn unscoped_node_refs_are_rejected_before_workspace_mutation() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("file.txt"), "original").unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let target = temp.path().join("unscoped");
    assert!(
        workspace::prepare(&source, &target, &base, &["named-parent".into()])
            .unwrap_err()
            .contains("Run identity")
    );
    assert!(
        workspace::snapshot_node_for_run(&target, &source, "worker", None)
            .unwrap_err()
            .contains("Run identity")
    );
    assert!(!target.exists());
    assert_eq!(fs::read(source.join("file.txt")).unwrap(), b"original");
}

#[test]
fn reclaimed_slots_remove_only_current_owned_git_metadata_and_orphans() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("file.txt"), "content").unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let run = temp
        .path()
        .join(".grapher-worktrees")
        .join(uuid::Uuid::new_v4().to_string());
    let slot = run.join("slot");
    workspace::prepare(&source, &slot, &base, &[]).unwrap();
    let metadata = workspace::private_git_dir(&slot).unwrap();
    assert!(metadata.join("workspace-layout-v4").is_file());
    workspace::remove_private_git(&slot).unwrap();
    assert!(workspace::private_git_dir(&slot).is_none());
    let orphan = run.join("orphan");
    workspace::prepare(&source, &orphan, &base, &[]).unwrap();
    let metadata = workspace::private_git_dir(&orphan).unwrap();
    fs::remove_dir_all(&orphan).unwrap();
    let unknown = run.join(".grapher-git").join("0123456789abcdef.git");
    let retired = run.join(".grapher-git").join("legacy-slot.git");
    for path in [&unknown, &retired] {
        fs::create_dir_all(path).unwrap();
        fs::write(path.join("keep"), "unowned").unwrap();
    }
    workspace::reclaim_orphan_git_metadata(&run).unwrap();
    assert!(!metadata.exists());
    assert_eq!(fs::read(unknown.join("keep")).unwrap(), b"unowned");
    assert_eq!(fs::read(retired.join("keep")).unwrap(), b"unowned");
    assert_eq!(fs::read(source.join("file.txt")).unwrap(), b"content");
}

#[test]
fn recreated_slot_ignores_metadata_from_a_deleted_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    workspace::git(&source, &["init", "-q"]).unwrap();
    fs::write(source.join("keep.txt"), "base").unwrap();
    workspace::git(&source, &["add", "-A"]).unwrap();
    workspace::git(&source, &["commit", "-q", "-m", "base"]).unwrap();
    let base = workspace::git(&source, &["rev-parse", "HEAD"]).unwrap();
    let slot = slot(&temp, "slot");
    workspace::prepare(&source, &slot, &base, &[]).unwrap();
    workspace::hide_private_git(&slot).unwrap();
    assert!(workspace::private_git_dir(&slot).is_some());
    fs::remove_dir_all(&slot).unwrap();
    workspace::prepare(&source, &slot, &base, &[]).unwrap();
    assert_eq!(fs::read_to_string(slot.join("keep.txt")).unwrap(), "base");
    assert!(workspace::git(&slot, &["rev-parse", "HEAD"]).is_ok());
}

#[test]
fn deleted_run_refs_and_orphan_heads_are_pruned_with_objects() {
    let temp = tempfile::tempdir().unwrap();
    let shadow = temp.path().join("shadow.git");
    fs::create_dir(&shadow).unwrap();
    workspace::git(&shadow, &["init", "--bare", "-q"]).unwrap();
    let shadow_text = shadow.to_str().unwrap();
    let run = uuid::Uuid::new_v4().to_string();
    let blob = String::from_utf8(
        workspace::git_bytes(
            &shadow,
            &["--git-dir", shadow_text, "hash-object", "-w", "--stdin"],
            None,
            Some(b"content\n"),
        )
        .unwrap(),
    )
    .unwrap()
    .trim()
    .to_string();
    let tree = String::from_utf8(
        workspace::git_bytes(
            &shadow,
            &["--git-dir", shadow_text, "mktree"],
            None,
            Some(format!("100644 blob {blob}\tfile\n").as_bytes()),
        )
        .unwrap(),
    )
    .unwrap()
    .trim()
    .to_string();
    let kept = workspace::git(
        &shadow,
        &["--git-dir", shadow_text, "commit-tree", &tree, "-m", "kept"],
    )
    .unwrap();
    let orphan = workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "commit-tree",
            &tree,
            "-m",
            "orphan",
        ],
    )
    .unwrap();
    let run_ref = format!("refs/grapher/runs/{run}/nodes/node");
    let detached_ref = format!(
        "refs/grapher/runs/{run}/planner-detached/{}",
        uuid::Uuid::new_v4()
    );
    workspace::git(
        &shadow,
        &["--git-dir", shadow_text, "update-ref", &run_ref, &orphan],
    )
    .unwrap();
    workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "update-ref",
            &detached_ref,
            &orphan,
        ],
    )
    .unwrap();
    workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "update-ref",
            &format!("refs/grapher/heads/{orphan}"),
            &orphan,
        ],
    )
    .unwrap();
    workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "update-ref",
            &format!("refs/grapher/heads/{kept}"),
            &kept,
        ],
    )
    .unwrap();
    workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "update-ref",
            "refs/grapher/published/result",
            &kept,
        ],
    )
    .unwrap();

    workspace::prune_shadow_run_refs(&shadow, &run, &std::collections::BTreeSet::new(), true)
        .unwrap();

    assert!(workspace::git(
        &shadow,
        &["--git-dir", shadow_text, "rev-parse", "--verify", &run_ref]
    )
    .is_err());
    assert!(workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "rev-parse",
            "--verify",
            &detached_ref
        ]
    )
    .is_err());
    assert!(workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "rev-parse",
            "--verify",
            &format!("refs/grapher/heads/{orphan}")
        ]
    )
    .is_err());
    assert!(workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "rev-parse",
            "--verify",
            &format!("refs/grapher/heads/{kept}")
        ]
    )
    .is_ok());
    assert!(workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "cat-file",
            "-e",
            &format!("{orphan}^{{commit}}")
        ]
    )
    .is_err());
    assert!(workspace::git(
        &shadow,
        &[
            "--git-dir",
            shadow_text,
            "cat-file",
            "-e",
            &format!("{kept}^{{commit}}")
        ]
    )
    .is_ok());
}

#[test]
fn tracked_managed_scope_is_detected_and_removed_from_the_index() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("repository");
    fs::create_dir(&repository).unwrap();
    workspace::git(&repository, &["init", "-q"]).unwrap();
    workspace::git(&repository, &["config", "user.email", "graph@test"]).unwrap();
    workspace::git(&repository, &["config", "user.name", "Graph"]).unwrap();
    fs::create_dir_all(repository.join(".agent-home/AppData")).unwrap();
    fs::write(repository.join(".agent-home/AppData/config.json"), "junk").unwrap();
    fs::write(repository.join("app.txt"), "code").unwrap();
    workspace::git(&repository, &["add", "-A"]).unwrap();
    workspace::git(&repository, &["commit", "-qm", "base"]).unwrap();

    let exclusions = vec![".agent-home".to_string()];
    assert!(workspace::has_tracked_scoped(&repository, &exclusions).unwrap());
    workspace::unstage_scoped(&repository, &exclusions).unwrap();
    assert!(!workspace::has_tracked_scoped(&repository, &exclusions).unwrap());
    assert!(repository.join(".agent-home/AppData/config.json").is_file());
}

#[test]
fn private_git_requires_committed_history_not_only_project_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir_all(source.join(".git")).unwrap();
    assert!(
        !workspace::has_private_git(&source),
        "an empty .git is not usable history"
    );
    workspace::git(&source, &["init", "-q"]).unwrap();
    assert!(
        !workspace::has_private_git(&source),
        "an unborn HEAD is not usable history"
    );
    fs::write(source.join("keep.txt"), "base").unwrap();
    workspace::git(&source, &["add", "-A"]).unwrap();
    workspace::git(&source, &["commit", "-qm", "base"]).unwrap();
    assert!(workspace::project_git(&source, &["rev-parse", "HEAD"]).is_ok());
    assert!(
        !workspace::has_private_git(&source),
        "project history is not Graph metadata"
    );

    let base = workspace::snapshot_repository(&source).unwrap();
    let slot = slot(&temp, "node");
    workspace::prepare(&source, &slot, &base, &[]).unwrap();
    assert!(workspace::has_private_git(&slot));
    let metadata = workspace::private_git_dir(&slot).unwrap();
    let retained = metadata.with_extension("retained");
    fs::rename(&metadata, &retained).unwrap();
    assert!(crate::workspace_view::is_bound(&slot));
    assert!(git2::Repository::open(&slot)
        .unwrap()
        .head()
        .unwrap()
        .peel_to_commit()
        .is_ok());
    assert!(
        !workspace::has_private_git(&slot),
        "project Git must not substitute for missing Graph history"
    );
    assert_eq!(fs::read_to_string(slot.join("keep.txt")).unwrap(), "base");
    fs::rename(retained, metadata).unwrap();
    assert!(workspace::has_private_git(&slot));
}

#[test]
fn prepare_recovers_from_incomplete_or_unborn_private_git_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    workspace::git(&source, &["init", "-q"]).unwrap();
    fs::write(source.join("keep.txt"), "base").unwrap();
    workspace::git(&source, &["add", "-A"]).unwrap();
    workspace::git(&source, &["commit", "-qm", "base"]).unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();

    // 1. Interrupted right after allocate_private_git: only workspace-layout-v4 exists.
    let allocated_only = slot(&temp, "allocated-only");
    fs::create_dir_all(&allocated_only).unwrap();
    super::allocate_private_git(&allocated_only).unwrap();
    assert!(workspace::private_git_dir(&allocated_only).is_some());
    assert!(!workspace::has_private_git(&allocated_only));
    workspace::prepare(&source, &allocated_only, &base, &[]).unwrap();
    assert!(workspace::has_private_git(&allocated_only));
    assert_eq!(
        fs::read_to_string(allocated_only.join("keep.txt")).unwrap(),
        "base"
    );

    // 2. Interrupted right after git init: HEAD exists as an unborn branch without a commit.
    let unborn = slot(&temp, "unborn");
    fs::create_dir_all(&unborn).unwrap();
    super::allocate_private_git(&unborn).unwrap();
    workspace::git(&unborn, &["init", "-q"]).unwrap();
    assert!(!workspace::has_private_git(&unborn));
    workspace::prepare(&source, &unborn, &base, &[]).unwrap();
    assert!(workspace::has_private_git(&unborn));
    assert_eq!(fs::read_to_string(unborn.join("keep.txt")).unwrap(), "base");

    // 3. Unsupported legacy metadata (HEAD without workspace-layout-v4) is still refused.
    let legacy = slot(&temp, "legacy");
    fs::create_dir_all(&legacy).unwrap();
    let metadata = legacy
        .parent()
        .unwrap()
        .join(".grapher-git")
        .join(super::graph_metadata_name("legacy").unwrap());
    fs::create_dir_all(&metadata).unwrap();
    fs::write(metadata.join("HEAD"), "ref: refs/heads/master\n").unwrap();
    let error = workspace::prepare(&source, &legacy, &base, &[]).unwrap_err();
    assert!(error.contains("Unsupported slot metadata"), "{error}");
}

#[cfg(target_os = "macos")]
#[test]
fn macos_nfd_case_shadow_verify_and_unstage_behave_consistently() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let repo = base.join("MixedRepo");
    fs::create_dir(&repo).unwrap();
    workspace::git(&repo, &["init", "-q"]).unwrap();
    workspace::project_git(&repo, &["config", "user.name", "Project Author"]).unwrap();
    workspace::project_git(&repo, &["config", "user.email", "project@example.invalid"]).unwrap();

    // Test scope_contains_at for uncreated and symlinked non-ASCII directories.
    assert!(workspace::scope_contains_at(
        &repo,
        Path::new("Cafe\u{0301}/sub/file.py"),
        Path::new("Caf\u{00e9}")
    ));
    let outside = base.join("OutsideEnv");
    fs::create_dir(&outside).unwrap();
    crate::path_safety::directory_link(&outside, &repo.join("Cafe\u{0301}Link"));
    assert!(!workspace::scope_contains_at(
        &repo,
        Path::new("OutsideEnv/file.py"),
        Path::new("Caf\u{00e9}Link")
    ));

    // Commit NFC filenames, tracked .DS_Store, and tracked generated file.
    let nfc_name = "Caf\u{00e9}.txt";
    let nfd_name = "Cafe\u{0301}.txt";
    fs::write(repo.join(nfc_name), "nfc content").unwrap();
    fs::write(repo.join("README.md"), "readme").unwrap();
    fs::write(repo.join(".DS_Store"), "tracked ds").unwrap();
    fs::create_dir_all(repo.join("__pycache__")).unwrap();
    fs::write(repo.join("__pycache__/Caf\u{00e9}.pyc"), "pyc").unwrap();
    workspace::project_git(
        &repo,
        &[
            "add",
            "-f",
            nfc_name,
            "README.md",
            ".DS_Store",
            "__pycache__/Caf\u{00e9}.pyc",
        ],
    )
    .unwrap();
    workspace::project_git(&repo, &["commit", "-qm", "init"]).unwrap();

    // Switch on APFS disk to NFD and lowercase case spelling.
    let tmp_nfd = repo.join(".tmp-nfd");
    fs::rename(repo.join(nfc_name), &tmp_nfd).unwrap();
    fs::rename(&tmp_nfd, repo.join(nfd_name)).unwrap();
    let tmp_pyc = repo.join("__pycache__/.tmp-pyc");
    fs::rename(repo.join("__pycache__/Caf\u{00e9}.pyc"), &tmp_pyc).unwrap();
    fs::rename(&tmp_pyc, repo.join("__pycache__/Cafe\u{0301}.pyc")).unwrap();
    if crate::path_identity::case_insensitive_volume(&repo) {
        let tmp_case = repo.join(".tmp-case");
        fs::rename(repo.join("README.md"), &tmp_case).unwrap();
        fs::rename(&tmp_case, repo.join("readme.md")).unwrap();

        let alias_repo = base.join("mixedrepo");
        assert!(workspace::verify(&alias_repo).is_ok());
        assert_eq!(
            workspace::shadow_repo_dir(&alias_repo).unwrap(),
            workspace::shadow_repo_dir(&repo).unwrap()
        );
    }

    fs::create_dir_all(repo.join(".venv/lib")).unwrap();
    fs::write(repo.join(".venv/lib/mod.py"), "excluded").unwrap();
    let insensitive = crate::path_identity::case_insensitive_volume(&repo);
    let venv_scope = if insensitive { ".Venv" } else { ".venv" };
    let exclusions = vec![venv_scope.to_string(), "UncreatedCaf\u{00e9}".to_string()];
    let snap = workspace::snapshot_repository_scoped(&repo, &exclusions).unwrap();
    let files = workspace::repository_git(&repo, &["ls-tree", "-r", "-z", &snap]).unwrap();
    let names: Vec<&str> = files
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.split_once('\t').unwrap().1)
        .collect();
    assert_eq!(
        names.iter().filter(|name| **name == nfd_name).count(),
        1,
        "must not stage duplicate NFC+NFD index entries: {names:?}"
    );
    assert!(
        !names.contains(&nfc_name),
        "index must reflect on-disk NFD spelling without precomposition: {names:?}"
    );
    assert!(names.contains(&".DS_Store"), "{names:?}");
    assert!(
        names.contains(&"__pycache__/Cafe\u{0301}.pyc"),
        "{names:?}"
    );
    assert!(
        !names.iter().any(|name| name.to_ascii_lowercase().starts_with(".venv")),
        "{names:?}"
    );

    // Local unstage_scoped / has_tracked_scoped on NFD + case alias.
    let node = slot(&temp, "node");
    workspace::prepare(&repo, &node, &snap, &[]).unwrap();
    fs::create_dir_all(node.join(".Venv")).unwrap();
    fs::write(node.join(".Venv/item"), "env").unwrap();
    workspace::git(&node, &["add", "-f", "--", ".Venv/item"]).unwrap();
    let check_scopes = vec![if crate::path_identity::case_insensitive_volume(&node) {
        ".venv".to_string()
    } else {
        ".Venv".to_string()
    }];
    assert!(workspace::has_tracked_scoped(&node, &check_scopes).unwrap());
    workspace::unstage_scoped(&node, &check_scopes).unwrap();
    assert!(!workspace::has_tracked_scoped(&node, &check_scopes).unwrap());

    #[cfg(target_os = "macos")]
    {
        let link_root = temp.path().join("disk-rel");
        let real_sub = link_root.join("RealDir");
        let outside = temp.path().join("outside-target");
        fs::create_dir_all(&real_sub).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(real_sub.join("Cafe\u{301}.txt"), "disk").unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(&outside, link_root.join("LinkDir")).unwrap();
        std::os::unix::fs::symlink(
            "RealDir/Cafe\u{301}.txt",
            link_root.join("leaf-link"),
        )
        .unwrap();

        assert_eq!(
            workspace::resolve_disk_relative(&link_root, Path::new("RealDir/Caf\u{00e9}.txt")),
            Some("RealDir/Cafe\u{301}.txt".into())
        );
        assert_eq!(
            workspace::resolve_disk_relative(&link_root, Path::new("LinkDir/secret.txt")),
            None
        );
        assert_eq!(
            workspace::resolve_disk_relative(&link_root, Path::new("leaf-link")),
            Some("leaf-link".into())
        );

        // Newly staged (uncommitted) .DS_Store in standard Git repo survives scoped snapshot.
        let staged_repo = temp.path().join("staged-ds");
        fs::create_dir(&staged_repo).unwrap();
        workspace::git(&staged_repo, &["init", "-q"]).unwrap();
        workspace::project_git(&staged_repo, &["config", "user.name", "Project Author"]).unwrap();
        workspace::project_git(&staged_repo, &["config", "user.email", "project@example.invalid"]).unwrap();
        fs::write(staged_repo.join("app.txt"), "base").unwrap();
        workspace::project_git(&staged_repo, &["add", "app.txt"]).unwrap();
        workspace::project_git(&staged_repo, &["commit", "-qm", "init"]).unwrap();
        fs::write(staged_repo.join(".DS_Store"), "staged ds").unwrap();
        workspace::project_git(&staged_repo, &["add", "-f", ".DS_Store"]).unwrap();
        let staged_snap = workspace::snapshot_repository_scoped(&staged_repo, &[".venv".into()]).unwrap();
        let staged_files = workspace::repository_git(&staged_repo, &["ls-tree", "-r", "-z", &staged_snap]).unwrap();
        assert!(staged_files.split('\0').any(|entry| entry.ends_with("\t.DS_Store")), "{staged_files:?}");
    }
}
