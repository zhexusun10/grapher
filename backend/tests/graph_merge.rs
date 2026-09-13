use grapher::{
    graph_merge::merge_graph,
    workspace::{git, prepare, snapshot},
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
    (path.clone(), snapshot(&path).unwrap())
}

fn branch(source: &Path, base: &str, path: &Path, file: &str, content: &str) -> String {
    prepare(source, path, base, &[]).unwrap();
    fs::write(path.join(file), content).unwrap();
    snapshot(path).unwrap()
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
        fs::read_to_string(source.join("shared")).unwrap(),
        "first\nsecond\n"
    );
    assert_eq!(
        fs::read_to_string(source.join("last.txt")).unwrap(),
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
