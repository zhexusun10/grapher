use grapher::{
    graph_merge::{merge_graph, merge_graph_with_workspace, publication_workspace},
    workspace::{
        git, prepare, prepare_with_merger_expected, repository_git, snapshot_node,
        snapshot_node_for_run, snapshot_repository,
    },
};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tempfile::TempDir;

fn test_data() {
    static ROOT: std::sync::OnceLock<TempDir> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        let dir = TempDir::new().unwrap();
        std::env::set_var("GRAPHER_DATA_DIR", dir.path());
        dir
    });
}

fn assert_files_only(source: &Path, head: &str) {
    assert_eq!(git(source, &["rev-parse", "HEAD"]).unwrap(), head);
    assert!(git(source, &["diff", "--cached", "--name-only"])
        .unwrap()
        .is_empty());
    assert!(!git(source, &["status", "--porcelain"]).unwrap().is_empty());
}
fn repository(base: &Path) -> (PathBuf, String) {
    test_data();
    let path = base.join("source");
    fs::create_dir(&path).unwrap();
    git(&path, &["init"]).unwrap();
    fs::write(path.join("shared"), "base\n").unwrap();
    git(&path, &["add", "-A"]).unwrap();
    git(&path, &["commit", "-qm", "base"]).unwrap();
    (path.clone(), git(&path, &["rev-parse", "HEAD"]).unwrap())
}

fn branch(source: &Path, base: &str, path: &Path, file: &str, content: &str) -> String {
    prepare(source, path, base, &[]).unwrap();
    fs::write(path.join(file), content).unwrap();
    snapshot_node(
        path,
        source,
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("node"),
    )
    .unwrap()
}

#[test]
fn concurrent_graph_preparation_never_uses_another_runs_base() {
    let temp = TempDir::new().unwrap();
    let (source, _) = repository(temp.path());
    // Pin a snapshot before changing the source tree.
    let base_a = snapshot_repository(&source).unwrap();
    fs::write(source.join("shared"), "newer\n").unwrap();
    let base_b = snapshot_repository(&source).unwrap();
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    let source_a = source.clone();
    let source_b = source.clone();
    let a = std::thread::spawn(move || {
        prepare(&source_a, &first, &base_a, &[])
            .map(|_| fs::read_to_string(first.join("shared")).unwrap())
    });
    let b = std::thread::spawn(move || {
        prepare(&source_b, &second, &base_b, &[])
            .map(|_| fs::read_to_string(second.join("shared")).unwrap())
    });
    assert_eq!(a.join().unwrap().unwrap().replace("\r\n", "\n"), "base\n");
    assert_eq!(b.join().unwrap().unwrap().replace("\r\n", "\n"), "newer\n");
    assert!(git(&source, &["rev-parse", "refs/grapher/base"]).is_err());
}

#[test]
fn concurrent_runs_with_identical_node_names_keep_parent_commits_isolated() {
    let temp = TempDir::new().unwrap();
    let (source, base) = repository(temp.path());
    let run_a = uuid::Uuid::new_v4().to_string();
    let run_b = uuid::Uuid::new_v4().to_string();
    let node_a = temp.path().join("node-a");
    prepare(&source, &node_a, &base, &[]).unwrap();
    fs::write(node_a.join("from-a"), "a").unwrap();
    let head_a = snapshot_node_for_run(&node_a, &source, "worker", Some(&run_a)).unwrap();
    let node_b = temp.path().join("node-b");
    prepare(&source, &node_b, &base, &[]).unwrap();
    fs::write(node_b.join("from-b"), "b").unwrap();
    let head_b = snapshot_node_for_run(&node_b, &source, "worker", Some(&run_b)).unwrap();
    assert_eq!(
        repository_git(
            &source,
            &[
                "rev-parse",
                &format!("refs/grapher/runs/{run_a}/nodes/worker")
            ]
        )
        .unwrap(),
        head_a
    );
    assert_eq!(
        repository_git(
            &source,
            &[
                "rev-parse",
                &format!("refs/grapher/runs/{run_b}/nodes/worker")
            ]
        )
        .unwrap(),
        head_b
    );
    assert!(git(&source, &["rev-parse", "refs/grapher/nodes/worker"]).is_err());
    let child = temp.path().join("child-a");
    prepare_with_merger_expected(&source, &child, &base, &[head_a], &base, || {
        Err("Unexpected conflict".into())
    })
    .unwrap();
    assert!(child.join("from-a").is_file());
    assert!(!child.join("from-b").exists());
}

#[test]
fn chained_source_alternates_fall_back_to_independent_fetch() {
    let temp = TempDir::new().unwrap();
    let (upstream, _) = repository(temp.path());
    let source = temp.path().join("clone");
    git(
        temp.path(),
        &[
            "clone",
            "-q",
            "--shared",
            upstream.to_str().unwrap(),
            source.to_str().unwrap(),
        ],
    )
    .unwrap();
    assert!(source.join(".git/objects/info/alternates").is_file());
    let base = snapshot_repository(&source).unwrap();
    let child = temp.path().join("child");
    prepare(&source, &child, &base, &[]).unwrap();
    let alternate = fs::read_to_string(child.join(".git/objects/info/alternates")).unwrap();
    assert_eq!(
        Path::new(alternate.trim()).canonicalize().unwrap(),
        grapher::workspace::shadow_repo_dir(&source)
            .unwrap()
            .join("objects")
            .canonicalize()
            .unwrap()
    );
    assert_eq!(git(&child, &["rev-parse", "HEAD"]).unwrap(), base);
    assert_eq!(
        fs::read_to_string(child.join("shared"))
            .unwrap()
            .replace("\r\n", "\n"),
        "base\n"
    );
}

#[test]
fn borrowed_objects_use_source_hash_format() {
    test_data();
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    if git(&source, &["init", "-q", "--object-format=sha256"]).is_err() {
        return; // Older Git releases do not support SHA-256 repositories.
    }
    fs::write(source.join("file"), "base").unwrap();
    let base = snapshot_repository(&source).unwrap();
    let node = temp.path().join("node");
    prepare(&source, &node, &base, &[]).unwrap();
    assert_eq!(git(&node, &["rev-parse", "HEAD"]).unwrap(), base);
    assert_eq!(
        git(&node, &["rev-parse", "--show-object-format=storage"]).unwrap(),
        "sha256"
    );
}

#[test]
fn node_reuses_source_objects_without_copying_history() {
    let temp = TempDir::new().unwrap();
    let (source, base) = repository(temp.path());
    let parent = temp.path().join("parent");
    let head = branch(&source, &base, &parent, "new", "parent");
    let child = temp.path().join("child");
    prepare(&source, &child, &base, &["parent".into()]).unwrap();
    let objects = fs::read_to_string(child.join(".git/objects/info/alternates")).unwrap();
    assert_eq!(
        Path::new(objects.trim()).canonicalize().unwrap(),
        grapher::workspace::shadow_repo_dir(&source)
            .unwrap()
            .join("objects")
            .canonicalize()
            .unwrap()
    );
    assert_eq!(
        git(&child, &["rev-parse", "refs/grapher/parents/parent"]).unwrap(),
        head
    );
    assert_eq!(fs::read_to_string(child.join("new")).unwrap(), "parent");
    assert!(fs::read_dir(child.join(".git/objects/pack"))
        .unwrap()
        .next()
        .is_none());
}

#[test]
fn completed_heads_land_in_source_and_repeated_publication_is_idempotent() {
    let temp = TempDir::new().unwrap();
    let (source, base) = repository(temp.path());
    let a = branch(&source, &base, &temp.path().join("a"), "a.txt", "a");
    let b = branch(&source, &base, &temp.path().join("b"), "b.txt", "b");
    let heads = [a, b];
    let index = PathBuf::from(
        git(
            &source,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )
        .unwrap(),
    );
    let before_index = fs::read(&index).unwrap();
    let published = merge_graph(&source, &heads, || panic!("No conflict expected")).unwrap();
    for file in ["a.txt", "b.txt"] {
        assert!(source.join(file).exists());
    }
    assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), base);
    assert_eq!(fs::read(&index).unwrap(), before_index);
    assert_files_only(&source, &base);
    assert!(repository_git(
        &source,
        &["cat-file", "-e", &format!("{published}^{{commit}}")]
    )
    .is_ok());
    assert!(git(
        &source,
        &["cat-file", "-e", &format!("{published}^{{commit}}")]
    )
    .is_err());
    assert_eq!(
        merge_graph(&source, &heads, || panic!("No conflict expected")).unwrap(),
        published
    );
    assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), base);
}

#[test]
fn resolved_conflict_does_not_drop_remaining_heads() {
    let temp = TempDir::new().unwrap();
    let (source, base) = repository(temp.path());
    let a = branch(&source, &base, &temp.path().join("a"), "shared", "first\n");
    let b = branch(&source, &base, &temp.path().join("b"), "shared", "second\n");
    let c = branch(&source, &base, &temp.path().join("c"), "last.txt", "last\n");
    let mut resolutions = 0;
    let published = merge_graph_with_workspace(&source, &[a, b, c.clone()], |private| {
        resolutions += 1;
        assert!(!git(private, &["diff", "--name-only", "--diff-filter=U"])?.is_empty());
        fs::write(private.join("shared"), "first\nsecond\n").unwrap();
        git(private, &["add", "shared"])?;
        git(private, &["commit", "--no-edit"])?;
        Ok(())
    })
    .unwrap();
    assert_eq!(resolutions, 1);
    assert_eq!(
        fs::read_to_string(source.join("shared"))
            .unwrap()
            .replace("\r\n", "\n"),
        "first\nsecond\n"
    );
    assert_eq!(
        fs::read_to_string(source.join("last.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "last\n"
    );
    assert!(repository_git(
        &source,
        &["cat-file", "-e", &format!("{published}^{{commit}}")]
    )
    .is_ok());
    assert!(git(
        &source,
        &["cat-file", "-e", &format!("{published}^{{commit}}")]
    )
    .is_err());
    assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), base);
    assert_files_only(&source, &base);
}

#[test]
fn failed_resolver_preserves_conflict_and_user_edits_publish_before_merge() {
    let temp = TempDir::new().unwrap();
    let (source, base) = repository(temp.path());
    let a = branch(&source, &base, &temp.path().join("a"), "shared", "first\n");
    let b = branch(&source, &base, &temp.path().join("b"), "shared", "second\n");
    fs::write(source.join("local"), "user changes").unwrap();
    // Non-conflicting user edits stay uncommitted and need no Merger.
    merge_graph(&source, std::slice::from_ref(&a), || {
        panic!("User edits are not a merge conflict")
    })
    .unwrap();
    assert_eq!(
        fs::read_to_string(source.join("local")).unwrap(),
        "user changes"
    );
    assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), base);
    let before_status = git(&source, &["status", "--porcelain"]).unwrap();
    let heads = [a, b];
    assert!(merge_graph(&source, &heads, || Err("Resolver failed".into())).is_err());
    let private = publication_workspace(&source, &heads).unwrap();
    assert!(!git(&private, &["diff", "--name-only", "--diff-filter=U"])
        .unwrap()
        .is_empty());
    assert!(git(&private, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok());
    assert_eq!(
        git(&source, &["status", "--porcelain"]).unwrap(),
        before_status
    );
}

// Merge descendants directly to avoid reopening resolved ancestor conflicts.
#[test]
fn redundant_ancestors_do_not_create_extra_merges_in_either_order() {
    for reverse in [false, true] {
        let temp = TempDir::new().unwrap();
        let (source, source_head) = repository(temp.path());
        let base = snapshot_repository(&source).unwrap();
        let a = branch(&source, &base, &temp.path().join("a"), "a.txt", "a");
        let b_path = temp.path().join("b");
        prepare(&source, &b_path, &base, std::slice::from_ref(&a)).unwrap();
        fs::write(b_path.join("b.txt"), "b").unwrap();
        let b = snapshot_node(&b_path, &source, "b").unwrap();
        let mut heads = vec![a.clone(), b.clone(), b.clone()];
        if reverse {
            heads.reverse();
        }
        let child = temp.path().join("child");
        prepare(&source, &child, &base, &heads).unwrap();
        merge_graph(&source, &heads, || panic!("No conflict expected")).unwrap();
        for path in [&child, &source] {
            // Compare the child to its snapshot and the source to its original HEAD.
            let from = if path == &child { &base } else { &source_head };
            assert_eq!(
                git(
                    path,
                    &[
                        "rev-list",
                        "--first-parent",
                        "--count",
                        &format!("{from}..HEAD")
                    ]
                )
                .unwrap(),
                if path == &child { "1" } else { "0" }
            );
            assert_eq!(fs::read_to_string(path.join("a.txt")).unwrap(), "a");
            assert_eq!(fs::read_to_string(path.join("b.txt")).unwrap(), "b");
            if path == &child {
                for head in &heads {
                    git(path, &["merge-base", "--is-ancestor", head, "HEAD"]).unwrap();
                }
            } else {
                assert_files_only(path, &source_head);
            }
        }
    }
}

#[test]
fn resolved_descendant_avoids_reopening_ancestor_conflicts() {
    let temp = TempDir::new().unwrap();
    let (source, base) = repository(temp.path());
    let a = branch(&source, &base, &temp.path().join("a"), "shared", "first\n");
    let b = branch(&source, &base, &temp.path().join("b"), "shared", "second\n");
    let resolved = temp.path().join("resolved");
    grapher::workspace::prepare_with_merger(
        &source,
        &resolved,
        &base,
        &[a.clone(), b.clone()],
        || {
            fs::write(resolved.join("shared"), "combined\n").unwrap();
            git(&resolved, &["add", "shared"])?;
            git(&resolved, &["commit", "--no-edit"])?;
            Ok(())
        },
    )
    .unwrap();
    let c = snapshot_node(&resolved, &source, "resolved").unwrap();
    let heads = vec![a, b, c];
    let child = temp.path().join("child");
    prepare(&source, &child, &base, &heads).unwrap();
    merge_graph(&source, &heads, || {
        panic!("Conflict was already resolved by a descendant")
    })
    .unwrap();
    for path in [&child, &source] {
        assert_eq!(
            fs::read_to_string(path.join("shared"))
                .unwrap()
                .replace("\r\n", "\n"),
            "combined\n"
        );
        if path == &child {
            for head in &heads {
                git(path, &["merge-base", "--is-ancestor", head, "HEAD"]).unwrap();
            }
        } else {
            assert_files_only(path, &base);
        }
    }
}

#[test]
fn missing_parent_fails_before_partial_composition() {
    let temp = TempDir::new().unwrap();
    let (source, source_head) = repository(temp.path());
    let base = snapshot_repository(&source).unwrap();
    let a = branch(&source, &base, &temp.path().join("a"), "a.txt", "a");
    let child = temp.path().join("child");
    assert!(prepare(&source, &child, &base, &[a.clone(), "missing".into()]).is_err());
    assert_eq!(git(&child, &["rev-parse", "HEAD"]).unwrap(), base);
    assert!(!child.join("a.txt").exists());
    assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), source_head);
    assert!(git(&source, &["status", "--porcelain"]).unwrap().is_empty());
}

#[test]
fn retry_finishes_pending_merge_before_pruning_redundant_incoming() {
    let temp = TempDir::new().unwrap();
    let (source, base) = repository(temp.path());
    let a = branch(&source, &base, &temp.path().join("a"), "shared", "first\n");
    let b = branch(&source, &base, &temp.path().join("b"), "shared", "second\n");
    let c_path = temp.path().join("c");
    prepare(&source, &c_path, &base, std::slice::from_ref(&b)).unwrap();
    fs::write(c_path.join("c.txt"), "c").unwrap();
    let c = snapshot_node(&c_path, &source, "c").unwrap();
    assert!(merge_graph(&source, &[a.clone(), b.clone()], || Err(
        "Interrupted".into()
    ))
    .is_err());
    let first_private = publication_workspace(&source, &[a.clone(), b.clone()]).unwrap();
    assert_eq!(
        git(&first_private, &["rev-parse", "MERGE_HEAD"]).unwrap(),
        b
    );
    let heads = vec![a, b, c];
    let mut resolutions = 0;
    let published = merge_graph_with_workspace(&source, &heads, |private| {
        resolutions += 1;
        fs::write(private.join("shared"), "combined\n").unwrap();
        git(private, &["add", "shared"])?;
        Ok(())
    })
    .unwrap();
    assert_eq!(resolutions, 1);
    assert_eq!(fs::read_to_string(source.join("c.txt")).unwrap(), "c");
    for head in heads {
        assert!(
            repository_git(&source, &["cat-file", "-e", &format!("{head}^{{commit}}")]).is_ok()
        );
        assert!(git(&source, &["cat-file", "-e", &format!("{head}^{{commit}}")]).is_err());
    }
    assert!(repository_git(
        &source,
        &["cat-file", "-e", &format!("{published}^{{commit}}")]
    )
    .is_ok());
    assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), base);
    assert_files_only(&source, &base);
}
