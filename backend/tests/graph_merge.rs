use grapher::{
    graph_merge::merge_graph,
    workspace::{
        git, prepare, prepare_with_merger_expected, snapshot_node, snapshot_node_for_run,
        snapshot_repository,
    },
};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tempfile::TempDir;

fn repository(base: &Path) -> (PathBuf, String) {
    let path = base.join("source");
    fs::create_dir(&path).unwrap();
    git(&path, &["init"]).unwrap();
    fs::write(path.join("shared"), "base\n").unwrap();
    (path.clone(), snapshot_repository(&path).unwrap())
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
fn private_planner_copies_dirty_and_ignored_files_without_modifying_source() {
    let temp = TempDir::new().unwrap();
    let (source, _) = repository(temp.path());
    fs::write(source.join("shared"), "dirty\n").unwrap();
    fs::write(source.join(".gitignore"), "ignored-dir/\n").unwrap();
    fs::create_dir(source.join("ignored-dir")).unwrap();
    fs::write(source.join("ignored-dir/dependency"), "local\n").unwrap();
    fs::write(source.join("untracked"), "new\n").unwrap();
    let before = git(&source, &["status", "--porcelain"]).unwrap();
    let private = temp.path().join(".grapher-workspaces/run/planner");
    grapher::workspace::prepare_planner(&source, &private).unwrap();
    assert_eq!(
        fs::read_to_string(private.join("shared")).unwrap(),
        "dirty\n"
    );
    assert_eq!(
        fs::read_to_string(private.join("ignored-dir/dependency")).unwrap(),
        "local\n"
    );
    assert_eq!(
        fs::read_to_string(private.join("untracked")).unwrap(),
        "new\n"
    );
    assert!(private.join(".git").is_dir());
    assert_eq!(git(&source, &["status", "--porcelain"]).unwrap(), before);
}

#[test]
fn concurrent_planner_merges_preserve_source_on_conflict() {
    let temp = TempDir::new().unwrap();
    let (source, _) = repository(temp.path());
    let root = temp.path().join(".grapher-workspaces");
    let first = root.join("b44201e4-2c8b-4c80-b1a1-3e660a83c7b1/a");
    let second = root.join("c55201e4-2c8b-4c80-b1a1-3e660a83c7b1/b");
    grapher::workspace::prepare_planner(&source, &first).unwrap();
    grapher::workspace::prepare_planner(&source, &second).unwrap();
    fs::write(first.join("shared"), "first\n").unwrap();
    fs::write(second.join("shared"), "second\n").unwrap();
    grapher::workspace::publish_planner(
        &source,
        &first,
        &root.join("first-preview"),
        "b44201e4-2c8b-4c80-b1a1-3e660a83c7b1",
        "b44201e4-2c8b-4c80-b1a1-3e660a83c7b1",
    )
    .unwrap();
    // Git may check out CRLF on Windows. Check logical content separately
    // from the byte-for-byte preservation required when publication fails.
    let published = fs::read(source.join("shared")).unwrap();
    assert_eq!(
        std::str::from_utf8(&published).unwrap().replace("\r\n", "\n"),
        "first\n"
    );
    let unpublished = fs::read(second.join("shared")).unwrap();
    assert!(grapher::workspace::publish_planner(
        &source,
        &second,
        &root.join("second-preview"),
        "c55201e4-2c8b-4c80-b1a1-3e660a83c7b1",
        "c55201e4-2c8b-4c80-b1a1-3e660a83c7b1"
    )
    .is_err());
    assert_eq!(fs::read(source.join("shared")).unwrap(), published);
    assert_eq!(fs::read(second.join("shared")).unwrap(), unpublished);
    assert!(git(&source, &["status", "--porcelain"]).unwrap().is_empty());
}

#[test]
fn concurrent_graph_preparation_never_uses_another_runs_base() {
    let temp = TempDir::new().unwrap();
    let (source, base_a) = repository(temp.path());
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
        git(
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
        git(
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
    assert!(!child.join(".git/objects/info/alternates").exists());
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
        source.join(".git/objects").canonicalize().unwrap()
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
    merge_graph(&source, &heads, || panic!("No conflict expected")).unwrap();
    for file in ["a.txt", "b.txt"] {
        assert!(source.join(file).exists());
    }
    let published = git(&source, &["rev-parse", "HEAD"]).unwrap();
    merge_graph(&source, &heads, || panic!("No conflict expected")).unwrap();
    assert_eq!(published, git(&source, &["rev-parse", "HEAD"]).unwrap());
    assert!(git(&source, &["status", "--porcelain"]).unwrap().is_empty());
}

#[test]
fn resolved_conflict_does_not_drop_remaining_heads() {
    let temp = TempDir::new().unwrap();
    let (source, base) = repository(temp.path());
    let a = branch(&source, &base, &temp.path().join("a"), "shared", "first\n");
    let b = branch(&source, &base, &temp.path().join("b"), "shared", "second\n");
    let c = branch(&source, &base, &temp.path().join("c"), "last.txt", "last\n");
    let mut resolutions = 0;
    merge_graph(&source, &[a, b, c.clone()], || {
        resolutions += 1;
        assert!(!git(&source, &["diff", "--name-only", "--diff-filter=U"])?.is_empty());
        fs::write(source.join("shared"), "first\nsecond\n").unwrap();
        git(&source, &["add", "shared"])?;
        git(&source, &["commit", "--no-edit"])?;
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
    git(&source, &["merge-base", "--is-ancestor", &c, "HEAD"]).unwrap();
}

#[test]
fn failed_resolver_preserves_conflict_and_dirty_source_never_invokes_merger() {
    let temp = TempDir::new().unwrap();
    let (source, base) = repository(temp.path());
    let a = branch(&source, &base, &temp.path().join("a"), "shared", "first\n");
    let b = branch(&source, &base, &temp.path().join("b"), "shared", "second\n");
    fs::write(source.join("local"), "user changes").unwrap();
    assert!(merge_graph(&source, &[a.clone()], || panic!(
        "Dirty source is not a merge conflict"
    ))
    .is_err());
    assert_eq!(
        fs::read_to_string(source.join("local")).unwrap(),
        "user changes"
    );
    fs::remove_file(source.join("local")).unwrap();
    assert!(merge_graph(&source, &[a, b], || Err("Resolver failed".into())).is_err());
    assert!(!git(&source, &["diff", "--name-only", "--diff-filter=U"])
        .unwrap()
        .is_empty());
    assert!(git(&source, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok());
}

// Ancestor-first inputs used to create two merges (and could re-open conflicts
// already resolved in a later input). Both composition and publication must
// consume the descendant directly while retaining every input in history.
#[test]
fn redundant_ancestors_do_not_create_extra_merges_in_either_order() {
    for reverse in [false, true] {
        let temp = TempDir::new().unwrap();
        let (source, base) = repository(temp.path());
        let a = branch(&source, &base, &temp.path().join("a"), "a.txt", "a");
        let b_path = temp.path().join("b");
        prepare(&source, &b_path, &base, &[a.clone()]).unwrap();
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
            assert_eq!(
                git(
                    path,
                    &[
                        "rev-list",
                        "--first-parent",
                        "--count",
                        &format!("{base}..HEAD")
                    ]
                )
                .unwrap(),
                "1"
            );
            assert_eq!(fs::read_to_string(path.join("a.txt")).unwrap(), "a");
            assert_eq!(fs::read_to_string(path.join("b.txt")).unwrap(), "b");
            for head in &heads {
                git(path, &["merge-base", "--is-ancestor", head, "HEAD"]).unwrap();
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
        for head in &heads {
            git(path, &["merge-base", "--is-ancestor", head, "HEAD"]).unwrap();
        }
    }
}

#[test]
fn missing_parent_fails_before_partial_composition() {
    let temp = TempDir::new().unwrap();
    let (source, base) = repository(temp.path());
    let a = branch(&source, &base, &temp.path().join("a"), "a.txt", "a");
    let child = temp.path().join("child");
    assert!(prepare(&source, &child, &base, &[a.clone(), "missing".into()]).is_err());
    assert_eq!(git(&child, &["rev-parse", "HEAD"]).unwrap(), base);
    assert!(!child.join("a.txt").exists());
    assert!(merge_graph(&source, &[a, "missing".into()], || panic!(
        "Invalid input is not a conflict"
    ))
    .is_err());
    assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), base);
}

#[test]
fn retry_finishes_pending_merge_before_pruning_redundant_incoming() {
    let temp = TempDir::new().unwrap();
    let (source, base) = repository(temp.path());
    let a = branch(&source, &base, &temp.path().join("a"), "shared", "first\n");
    let b = branch(&source, &base, &temp.path().join("b"), "shared", "second\n");
    let c_path = temp.path().join("c");
    prepare(&source, &c_path, &base, &[b.clone()]).unwrap();
    fs::write(c_path.join("c.txt"), "c").unwrap();
    let c = snapshot_node(&c_path, &source, "c").unwrap();
    assert!(merge_graph(&source, &[a.clone(), b.clone()], || Err(
        "Interrupted".into()
    ))
    .is_err());
    assert_eq!(git(&source, &["rev-parse", "MERGE_HEAD"]).unwrap(), b);
    let heads = vec![a, b, c];
    let mut resolutions = 0;
    merge_graph(&source, &heads, || {
        resolutions += 1;
        fs::write(source.join("shared"), "combined\n").unwrap();
        git(&source, &["add", "shared"])?;
        Ok(())
    })
    .unwrap();
    assert_eq!(resolutions, 1);
    assert_eq!(fs::read_to_string(source.join("c.txt")).unwrap(), "c");
    for head in heads {
        git(&source, &["merge-base", "--is-ancestor", &head, "HEAD"]).unwrap();
    }
    assert!(git(&source, &["status", "--porcelain"]).unwrap().is_empty());
}
