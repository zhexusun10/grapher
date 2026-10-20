//! Files-only delivery must survive interruption without changing user Git state.
use grapher::{graph_merge::{merge_graph_with_workspace as publish, publication_workspace}, workspace};
use std::{collections::BTreeSet, fs, path::{Path, PathBuf}, sync::OnceLock};
use tempfile::TempDir;
fn git(path: &Path, args: &[&str]) -> String { workspace::git(path, args).unwrap() }
fn source(sha256: bool) -> (TempDir, PathBuf, String) {
    static DATA: OnceLock<TempDir> = OnceLock::new();
    DATA.get_or_init(|| { let dir = TempDir::new().unwrap(); std::env::set_var("GRAPHER_DATA_DIR", dir.path()); dir });
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("source");
    fs::create_dir(&path).unwrap();
    git(&path, if sha256 { &["init", "-q", "--object-format=sha256"] } else { &["init", "-q"] });
    fs::write(path.join("file.txt"), "base\n").unwrap();
    fs::write(path.join("gone.txt"), "remove me\n").unwrap();
    git(&path, &["add", "-A"]); git(&path, &["commit", "-qm", "initial"]);
    let head = git(&path, &["rev-parse", "HEAD"]);
    (temp, path, head)
}
fn node(source: &Path, base: &str, path: &Path, value: &str) -> String {
    workspace::prepare(source, path, base, &[]).unwrap();
    fs::write(path.join("file.txt"), value).unwrap();
    workspace::snapshot_node(path, source, "worker").unwrap()
}
fn index(source: &Path) -> PathBuf { PathBuf::from(git(source, &["rev-parse", "--path-format=absolute", "--git-path", "index"])) }
fn objects(source: &Path) -> BTreeSet<String> {
    git(source, &["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"]).lines().map(str::to_owned).collect()
}
fn journal(source: &Path, heads: &[String]) -> PathBuf {
    publication_workspace(source, heads).unwrap().with_extension("publication").join("00000000")
}
fn interrupt(source: &Path, heads: &[String]) -> PathBuf {
    let journal = journal(source, heads);
    fs::remove_file(journal.join("installed")).unwrap();
    fs::write(index(source).with_extension("lock"), format!("Grapher publication {}\n", journal.display())).unwrap();
    journal
}
fn assert_private(source: &Path, base: &str, result: &str, before_index: &[u8], before_objects: &BTreeSet<String>) {
    assert_eq!(git(source, &["rev-parse", "HEAD"]), base);
    assert_eq!(fs::read(index(source)).unwrap(), before_index);
    assert_eq!(&objects(source), before_objects);
    assert!(git(source, &["for-each-ref", "--format=%(refname)", "refs/grapher"]).is_empty());
    workspace::repository_git(source, &["cat-file", "-e", &format!("{result}^{{commit}}")]).unwrap();
}

#[test]
fn crash_after_checkout_before_completion_reuses_the_internal_result_and_preserves_user_index() {
    let (temp, source, base) = source(false);
    let before_index = fs::read(index(&source)).unwrap();
    let before_objects = objects(&source);
    let heads = [node(&source, &base, &temp.path().join("node"), "result\n")];
    let result = publish(&source, &heads, |_| panic!()).unwrap();
    let journal = interrupt(&source, &heads);
    assert_eq!(publish(&source, &heads, |_| panic!()).unwrap(), result);
    assert!(!index(&source).with_extension("lock").exists());
    assert_private(&source, &base, &result, &before_index, &before_objects);
    // Repair private metadata without writing anything into the user's index.
    let (_, input): (String, String) = serde_json::from_slice(&fs::read(journal.join("input.json")).unwrap()).unwrap();
    workspace::repository_git(&source, &["update-ref", "HEAD", &result]).unwrap();
    workspace::repository_git(&source, &["read-tree", &input]).unwrap();
    publish(&source, &heads, |_| panic!()).unwrap();
    assert!(workspace::repository_git(&source, &["diff", "--cached", "--name-only"]).unwrap().is_empty());
    let lock = index(&source).with_extension("lock");
    fs::write(&lock, "foreign lease").unwrap();
    assert_eq!(publish(&source, &heads, |_| panic!()).unwrap(), result);
    assert_eq!(fs::read_to_string(lock).unwrap(), "foreign lease");
    assert_private(&source, &base, &result, &before_index, &before_objects);
}

#[test]
fn partial_checkout_recovers_additions_deletions_and_modified_files_without_a_commit() {
    let (temp, source, base) = source(false);
    let before_index = fs::read(index(&source)).unwrap();
    let before_objects = objects(&source);
    let path = temp.path().join("node");
    workspace::prepare(&source, &path, &base, &[]).unwrap();
    fs::write(path.join("file.txt"), "result\n").unwrap();
    fs::write(path.join("added.txt"), "added").unwrap();
    fs::remove_file(path.join("gone.txt")).unwrap();
    let heads = [workspace::snapshot_node(&path, &source, "worker").unwrap()];
    let result = publish(&source, &heads, |_| panic!()).unwrap();
    interrupt(&source, &heads);
    // Some paths still have input entries while the addition reached its result.
    fs::write(source.join("file.txt"), "base\n").unwrap();
    fs::write(source.join("gone.txt"), "remove me\n").unwrap();
    assert_eq!(publish(&source, &heads, |_| panic!()).unwrap(), result);
    assert_eq!(fs::read_to_string(source.join("file.txt")).unwrap().replace("\r\n", "\n"), "result\n");
    assert_eq!(fs::read_to_string(source.join("added.txt")).unwrap(), "added");
    assert!(!source.join("gone.txt").exists());
    assert_private(&source, &base, &result, &before_index, &before_objects);
}

#[test]
fn recovery_never_absorbs_a_user_edit_that_matches_neither_input_nor_result() {
    let (temp, source, base) = source(false);
    let heads = [node(&source, &base, &temp.path().join("node"), "result\n")];
    publish(&source, &heads, |_| panic!()).unwrap();
    interrupt(&source, &heads);
    fs::write(source.join("file.txt"), "new user work\n").unwrap();
    assert!(publish(&source, &heads, |_| panic!()).unwrap_err().contains("Source files changed"));
    assert_eq!(fs::read_to_string(source.join("file.txt")).unwrap(), "new user work\n");
    assert_eq!(git(&source, &["rev-parse", "HEAD"]), base);
}

#[test]
fn changing_source_branch_without_changing_head_oid_does_not_deliver_to_the_wrong_checkout() {
    let (temp, source, base) = source(false);
    let original_ref = git(&source, &["symbolic-ref", "HEAD"]);
    let heads = [node(&source, &base, &temp.path().join("a"), "left\n"), node(&source, &base, &temp.path().join("b"), "right\n")];
    let result = publish(&source, &heads, |private| {
        git(&source, &["update-ref", "refs/heads/other", &base]);
        git(&source, &["symbolic-ref", "HEAD", "refs/heads/other"]);
        fs::write(private.join("file.txt"), "left\nright\n").unwrap();
        workspace::git(private, &["add", "file.txt"])?;
        Ok(())
    });
    assert!(result.unwrap_err().contains("Source branch changed"));
    assert_eq!(fs::read_to_string(source.join("file.txt")).unwrap(), "base\n");
    let result = publish(&source, &heads, |_| panic!()).unwrap();
    assert_eq!(git(&source, &["rev-parse", "refs/heads/other"]), base);
    assert_eq!(git(&source, &["rev-parse", &original_ref]), base);
    assert!(workspace::git(&source, &["cat-file", "-e", &format!("{result}^{{commit}}")]).is_err());
}

#[test]
fn repeated_rebaseline_retry_recognizes_earlier_pending_source_inputs() {
    let (temp, source, base) = source(false);
    let heads = [node(&source, &base, &temp.path().join("node"), "node\n")];
    fs::write(source.join("file.txt"), "user one\n").unwrap();
    assert!(publish(&source, &heads, |_| Err("first interruption".into())).is_err());
    fs::write(source.join("file.txt"), "user two\n").unwrap();
    let mut calls = 0;
    assert!(publish(&source, &heads, |private| {
        calls += 1;
        if calls > 1 { return Err("second interruption".into()); }
        fs::write(private.join("file.txt"), "user one\nnode\n").unwrap();
        workspace::git(private, &["add", "file.txt"])?;
        Ok(())
    }).is_err());
    assert_eq!(calls, 2);
    fs::write(source.join("file.txt"), "user three\n").unwrap();
    publish(&source, &heads, |private| {
        fs::write(private.join("file.txt"), "user one\nuser two\nuser three\nnode\n").unwrap();
        workspace::git(private, &["add", "file.txt"])?;
        Ok(())
    }).unwrap();
    assert_eq!(git(&source, &["rev-parse", "HEAD"]), base);
    assert!(fs::read_to_string(source.join("file.txt")).unwrap().contains("user three"));
}

#[test]
fn interrupted_delivery_cannot_resume_in_a_different_checked_out_branch() {
    let (temp, source, base) = source(false);
    let original_ref = git(&source, &["symbolic-ref", "HEAD"]);
    let heads = [node(&source, &base, &temp.path().join("node"), "result\n")];
    let result = publish(&source, &heads, |_| panic!()).unwrap();
    let journal = interrupt(&source, &heads);
    let before = fs::read(index(&source)).unwrap();
    git(&source, &["update-ref", "refs/heads/other", &base]);
    git(&source, &["symbolic-ref", "HEAD", "refs/heads/other"]);
    assert!(publish(&source, &heads, |_| panic!()).unwrap_err().contains("Source branch changed"));
    assert_eq!(fs::read(index(&source)).unwrap(), before);
    assert!(!journal.join("installed").exists());
    git(&source, &["symbolic-ref", "HEAD", &original_ref]);
    assert_eq!(publish(&source, &heads, |_| panic!()).unwrap(), result);
    assert_eq!(git(&source, &["rev-parse", "HEAD"]), base);
}

#[test]
fn completed_delivery_is_not_reapplied_after_user_switches_branch_and_discards_files() {
    let (temp, source, base) = source(false);
    let heads = [node(&source, &base, &temp.path().join("node"), "result\n")];
    let result = publish(&source, &heads, |_| panic!()).unwrap();
    git(&source, &["checkout", "-q", "-b", "other", &base]);
    git(&source, &["restore", "file.txt"]);
    let before = fs::read(index(&source)).unwrap();
    assert_eq!(publish(&source, &heads, |_| panic!()).unwrap(), result);
    assert_eq!(git(&source, &["rev-parse", "HEAD"]), base);
    assert_eq!(fs::read(index(&source)).unwrap(), before);
    assert_eq!(fs::read_to_string(source.join("file.txt")).unwrap().replace("\r\n", "\n"), "base\n");
}

#[test]
fn user_commits_during_composition_are_preserved_and_no_additional_commit_is_created() {
    let (temp, source, base) = source(false);
    let heads = [node(&source, &base, &temp.path().join("a"), "left\n"), node(&source, &base, &temp.path().join("b"), "right\n")];
    let first = publish(&source, &heads, |private| {
        fs::write(source.join("user.txt"), "user").unwrap();
        git(&source, &["add", "user.txt"]); git(&source, &["commit", "-qm", "user change"]);
        fs::write(private.join("file.txt"), "left\nright\n").unwrap();
        workspace::git(private, &["add", "file.txt"])?;
        Ok(())
    });
    assert!(first.unwrap_err().contains("Source HEAD changed"));
    let user = git(&source, &["rev-parse", "HEAD"]);
    let before_index = fs::read(index(&source)).unwrap();
    let before_objects = objects(&source);
    let result = publish(&source, &heads, |_| panic!()).unwrap();
    assert_private(&source, &user, &result, &before_index, &before_objects);
    assert_eq!(git(&source, &["show", "HEAD:user.txt"]), "user");
}

#[test]
fn unrelated_source_merge_and_index_locks_are_never_adopted_or_removed() {
    let (temp, source, base) = source(false);
    let heads = [node(&source, &base, &temp.path().join("node"), "result\n")];
    let merge = source.join(".git/MERGE_HEAD");
    fs::write(&merge, format!("{base}\n")).unwrap();
    assert!(publish(&source, &heads, |_| panic!()).unwrap_err().contains("source merge"));
    assert_eq!(fs::read_to_string(&merge).unwrap().trim(), base);
    fs::remove_file(merge).unwrap();
    let lock = index(&source).with_extension("lock");
    fs::write(&lock, "other Git process").unwrap();
    assert!(publish(&source, &heads, |_| panic!()).unwrap_err().contains("index lease"));
    assert_eq!(fs::read_to_string(&lock).unwrap(), "other Git process");
    fs::remove_file(lock).unwrap();
    publish(&source, &heads, |_| panic!()).unwrap();
    assert_eq!(git(&source, &["rev-parse", "HEAD"]), base);
}

#[test]
fn detached_head_delivery_neither_commits_nor_advances_a_branch() {
    let (temp, source, base) = source(false);
    let original_ref = git(&source, &["symbolic-ref", "HEAD"]);
    git(&source, &["checkout", "-q", "--detach", &base]);
    let before_index = fs::read(index(&source)).unwrap();
    let before_objects = objects(&source);
    let heads = [node(&source, &base, &temp.path().join("node"), "detached result\n")];
    let result = publish(&source, &heads, |_| panic!()).unwrap();
    assert_private(&source, &base, &result, &before_index, &before_objects);
    assert_eq!(git(&source, &["rev-parse", &original_ref]), base);
    assert!(workspace::git(&source, &["symbolic-ref", "-q", "HEAD"]).is_err());
    git(&source, &["checkout", "-q", original_ref.strip_prefix("refs/heads/").unwrap()]);
    assert_eq!(publish(&source, &heads, |_| panic!()).unwrap(), result);
    assert_eq!(git(&source, &["rev-parse", "HEAD"]), base);
}

#[test]
fn linked_worktree_delivery_changes_files_only_in_its_checkout_and_preserves_both_indices() {
    let (temp, source, base) = source(false);
    let linked = temp.path().join("linked checkout");
    git(&source, &["worktree", "add", "-q", "-b", "linked-task", linked.to_str().unwrap(), &base]);
    let main_index = fs::read(index(&source)).unwrap();
    let linked_index = fs::read(index(&linked)).unwrap();
    let before_objects = objects(&source);
    let heads = [node(&linked, &base, &temp.path().join("node"), "linked result\n")];
    let result = publish(&linked, &heads, |_| panic!()).unwrap();
    assert_private(&linked, &base, &result, &linked_index, &before_objects);
    assert_eq!(git(&source, &["rev-parse", "HEAD"]), base);
    assert_eq!(fs::read(index(&source)).unwrap(), main_index);
    assert_eq!(fs::read_to_string(source.join("file.txt")).unwrap().replace("\r\n", "\n"), "base\n");
    assert_eq!(fs::read_to_string(linked.join("file.txt")).unwrap().replace("\r\n", "\n"), "linked result\n");
}

#[test]
fn sha256_delivery_keeps_all_new_objects_private() {
    let (temp, source, base) = source(true);
    let before_index = fs::read(index(&source)).unwrap();
    let before_objects = objects(&source);
    let heads = [node(&source, &base, &temp.path().join("node"), "sha256\n")];
    let result = publish(&source, &heads, |_| panic!()).unwrap();
    assert_eq!(result.len(), 64);
    assert_private(&source, &base, &result, &before_index, &before_objects);
}

#[test]
fn an_absent_user_index_stays_absent() {
    let (temp, source, base) = source(false);
    let heads = [node(&source, &base, &temp.path().join("node"), "result\n")];
    let index = index(&source);
    fs::remove_file(&index).unwrap();
    let before_objects = objects(&source);
    publish(&source, &heads, |_| panic!()).unwrap();
    assert!(!index.exists());
    assert_eq!(git(&source, &["rev-parse", "HEAD"]), base);
    assert_eq!(objects(&source), before_objects);
}
