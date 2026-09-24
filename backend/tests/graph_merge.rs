use grapher::{
    graph_merge::merge_graph,
    workspace::{git, prepare, snapshot_node, snapshot_repository},
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
