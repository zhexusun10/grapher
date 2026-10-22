use grapher::{graph_merge::{merge_graph_with_workspace as publish, publication_workspace}, workspace};
use std::{fs, path::{Path, PathBuf}, sync::OnceLock};
use tempfile::TempDir;

fn data() {
    static DATA: OnceLock<TempDir> = OnceLock::new();
    DATA.get_or_init(|| {
        let dir = TempDir::new().unwrap();
        std::env::set_var("GRAPHER_DATA_DIR", dir.path());
        dir
    });
}
fn git(path: &Path, args: &[&str]) -> String { workspace::git(path, args).unwrap() }
fn source() -> (TempDir, PathBuf, String) {
    data();
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("source");
    fs::create_dir(&path).unwrap();
    git(&path, &["init", "-q"]);
    fs::write(path.join("shared.txt"), "base\n").unwrap();
    git(&path, &["add", "-A"]);
    git(&path, &["commit", "-qm", "initial"]);
    let head = git(&path, &["rev-parse", "HEAD"]);
    (temp, path, head)
}
fn node(source: &Path, path: &Path, base: &str, parents: &[String], file: &str, content: &str) -> String {
    workspace::prepare(source, path, base, parents).unwrap();
    fs::write(path.join(file), content).unwrap();
    workspace::snapshot_node(path, source, "worker").unwrap()
}
fn assert_delivery(source: &Path, base: &str, head: &str, internal: &[String]) {
    assert_eq!(git(source, &["rev-parse", "HEAD"]), base);
    assert_eq!(git(source, &["log", "--format=%s", &format!("{base}..HEAD")]), "");
    workspace::repository_git(source, &["cat-file", "-e", &format!("{head}^{{commit}}")]).unwrap();
    assert!(workspace::git(source, &["cat-file", "-e", &format!("{head}^{{commit}}")]).is_err());
    assert_eq!(git(source, &["for-each-ref", "--format=%(refname)", "refs/grapher"]), "");
    for commit in internal {
        assert!(workspace::git(source, &["cat-file", "-e", &format!("{commit}^{{commit}}")]).is_err(), "internal commit leaked: {commit}");
    }
}

#[test]
fn node_cwd_exposes_source_git_but_keeps_host_snapshots_independent() {
    let (temp, source, _) = source();
    let base = workspace::snapshot_repository(&source).unwrap();
    let slot = temp.path().join(".grapher-worktrees").join(uuid::Uuid::new_v4().to_string()).join("node");
    let a = node(&source, &slot, &base, &[], "a.txt", "a");
    assert!(slot.join(".git").is_dir());
    let output = std::process::Command::new("git").args(["log", "--all", "--format=%s"]).current_dir(&slot).output().unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "initial");
    workspace::prepare(&source, &slot, &a, &[]).unwrap();
    assert!(slot.join(".git").is_dir());
    assert_eq!(git(&slot, &["rev-parse", "HEAD"]), a);
}

#[test]
fn explicit_node_commits_are_project_history_without_source_or_graph_bookkeeping_leaks() {
    let (temp, source, base) = source();
    let slot = temp.path().join(".grapher-worktrees").join(uuid::Uuid::new_v4().to_string()).join("node");
    workspace::prepare(&source, &slot, &base, &[]).unwrap();
    let raw_git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .args(["-c", "core.longpaths=true", "-c", "commit.gpgsign=false", "-c", "user.name=Node", "-c", "user.email=node@invalid"])
            .args(args).current_dir(&slot).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    };
    raw_git(&["init", "-q"]);
    fs::write(slot.join("unaccepted.txt"), "node-local commit").unwrap();
    raw_git(&["add", "unaccepted.txt"]);
    raw_git(&["commit", "-qm", "node-local"]);
    let unexpected = raw_git(&["rev-parse", "HEAD"]);
    let result = workspace::snapshot_node(&slot, &source, "node").unwrap();
    assert!(slot.join(".git").is_dir());
    assert_eq!(raw_git(&["rev-parse", "HEAD"]), unexpected);
    assert!(raw_git(&["for-each-ref", "--format=%(refname)", "refs/grapher"]).is_empty());
    let output = std::process::Command::new("git").args(["cat-file", "-e", &result]).current_dir(&slot).output().unwrap();
    assert!(!output.status.success(), "internal snapshot must not enter visible Git");
    assert!(workspace::repository_git(&source, &["cat-file", "-e", &format!("{unexpected}^{{commit}}")]).is_err());
    assert!(workspace::git(&source, &["cat-file", "-e", &format!("{unexpected}^{{commit}}")]).is_err());
    let other = temp.path().join("other");
    workspace::prepare(&source, &other, &base, &[]).unwrap();
    assert!(!other.join("unaccepted.txt").exists());
    assert!(workspace::git(&other, &["cat-file", "-e", &format!("{unexpected}^{{commit}}")]).is_err());
    assert_eq!(git(&source, &["rev-parse", "HEAD"]), base);
}

#[test]
fn fanout_host_readers_and_visible_git_remain_independent_during_reprepare() {
    let (temp, source, _) = source();
    let base = workspace::snapshot_repository(&source).unwrap();
    let slot = temp.path().join(".grapher-worktrees").join(uuid::Uuid::new_v4().to_string()).join("node");
    workspace::prepare(&source, &slot, &base, &[]).unwrap();
    std::thread::scope(|scope| {
        scope.spawn(|| { for _ in 0..12 { workspace::prepare(&source, &slot, &base, &[]).unwrap(); } });
        scope.spawn(|| { for _ in 0..40 { assert!(git(&slot, &["ls-files"]).contains("shared.txt")); } });
    });
    assert!(slot.join(".git").is_dir());
    let output = std::process::Command::new("git").args(["log", "--all", "--format=%s"]).current_dir(&slot).output().unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "initial");
}

#[test]
fn linear_and_parallel_results_deliver_files_without_any_source_commit_objects() {
    let (temp, source, original) = source();
    fs::write(source.join("planner.txt"), "planner").unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    assert_ne!(base, original);
    assert_eq!(git(&source, &["rev-parse", "HEAD"]), original);
    let a = node(&source, &temp.path().join("a"), &base, &[], "a.txt", "a");
    let b = node(&source, &temp.path().join("b"), &base, &[], "b.txt", "b");
    let c = node(&source, &temp.path().join("c"), &base, &[a.clone(), b.clone()], "c.txt", "c");
    let d = node(&source, &temp.path().join("d"), &c, &[], "d.txt", "d");
    let published = publish(&source, &[d.clone()], |_| panic!("unexpected conflict")).unwrap();
    assert_delivery(&source, &original, &published, &[base, a, b, c, d.clone()]);
    for name in ["planner", "a", "b", "c", "d"] { assert!(source.join(format!("{name}.txt")).is_file()); }
    assert_eq!(publish(&source, &[d.clone()], |_| panic!()).unwrap(), published);
    fs::write(source.join("later-user.txt"), "not part of publication").unwrap();
    assert_eq!(publish(&source, &[d], |_| panic!()).unwrap(), published);
    assert_eq!(git(&source, &["log", "--format=%s", &format!("{original}..HEAD")]), "");
    assert!(git(&source, &["status", "--porcelain"]).contains("later-user.txt"));
}

#[test]
fn delivery_preserves_user_index_and_leaves_staged_unstaged_ignored_changes_uncommitted() {
    let (temp, source, original) = source();
    fs::write(source.join(".gitignore"), "ignored.txt\n").unwrap();
    fs::write(source.join("ignored.txt"), "project content").unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let a = node(&source, &temp.path().join("a"), &base, &[], "a.txt", "a");
    fs::write(source.join("user.txt"), "staged").unwrap();
    git(&source, &["add", "user.txt"]);
    fs::write(source.join("user.txt"), "working tree").unwrap();
    fs::remove_file(source.join("shared.txt")).unwrap();
    let index = PathBuf::from(git(&source, &["rev-parse", "--path-format=absolute", "--git-path", "index"]));
    let before = fs::read(&index).unwrap();
    let head = publish(&source, &[a.clone()], |_| panic!()).unwrap();
    assert_delivery(&source, &original, &head, &[base, a]);
    assert_eq!(fs::read(index).unwrap(), before);
    assert_eq!(git(&source, &["show", ":user.txt"]), "staged");
    assert_eq!(fs::read_to_string(source.join("user.txt")).unwrap(), "working tree");
    assert_eq!(fs::read_to_string(source.join("ignored.txt")).unwrap(), "project content");
    assert!(!source.join("shared.txt").exists());
}

#[test]
fn conflict_failure_and_restart_retry_never_partially_publish_or_touch_user_index() {
    let (temp, source, original) = source();
    let base = workspace::snapshot_repository(&source).unwrap();
    let a = node(&source, &temp.path().join("a"), &base, &[], "shared.txt", "node\n");
    fs::write(source.join("shared.txt"), "user\n").unwrap();
    git(&source, &["add", "shared.txt"]);
    let index_path = PathBuf::from(git(&source, &["rev-parse", "--path-format=absolute", "--git-path", "index"]));
    let before_index = fs::read(&index_path).unwrap();
    assert!(publish(&source, &[a.clone()], |private| {
        assert_ne!(private.canonicalize().unwrap(), source.canonicalize().unwrap());
        assert_eq!(git(private, &["show", "HEAD:shared.txt"]), "user");
        Err("interrupted merger".into())
    }).is_err());
    assert_eq!(fs::read_to_string(source.join("shared.txt")).unwrap(), "user\n");
    assert_eq!(fs::read(&index_path).unwrap(), before_index);
    assert_eq!(git(&source, &["rev-parse", "HEAD"]), original);
    assert!(workspace::git(&source, &["rev-parse", "--verify", "MERGE_HEAD"]).is_err());
    let head = publish(&source, &[a.clone()], |private| {
        fs::write(private.join("shared.txt"), "user\nnode\n").map_err(|e| e.to_string())?;
        workspace::git(private, &["add", "shared.txt"])?;
        Ok(())
    }).unwrap();
    assert_delivery(&source, &original, &head, &[a]);
    assert_eq!(fs::read_to_string(source.join("shared.txt")).unwrap().replace("\r\n", "\n"), "user\nnode\n");
}

#[test]
fn concurrent_source_changes_and_unrelated_merges_fail_closed() {
    let (temp, source, original) = source();
    let base = workspace::snapshot_repository(&source).unwrap();
    let a = node(&source, &temp.path().join("a"), &base, &[], "shared.txt", "a\n");
    let b = node(&source, &temp.path().join("b"), &base, &[], "shared.txt", "b\n");
    let heads = [a, b];
    let result = publish(&source, &heads, |private| {
        fs::write(source.join("new-user.txt"), "concurrent").unwrap();
        fs::write(private.join("shared.txt"), "a\nb\n").unwrap();
        workspace::git(private, &["add", "shared.txt"])?;
        Ok(())
    });
    assert!(result.unwrap_err().contains("Source files changed"));
    assert_eq!(git(&source, &["rev-parse", "HEAD"]), original);
    assert_eq!(fs::read_to_string(source.join("shared.txt")).unwrap(), "base\n");
    assert_eq!(fs::read_to_string(source.join("new-user.txt")).unwrap(), "concurrent");
    assert!(workspace::git(&source, &["rev-parse", "--verify", "MERGE_HEAD"]).is_err());
    let published = publish(&source, &heads, |_| panic!("retained conflict resolution should be reused")).unwrap();
    assert_delivery(&source, &original, &published, &heads);
    assert_eq!(fs::read_to_string(source.join("new-user.txt")).unwrap(), "concurrent");
}

#[test]
fn subsequent_publication_retains_internal_ancestry_without_reapplying_delivered_nodes() {
    let (temp, source, original) = source();
    let base = workspace::snapshot_repository(&source).unwrap();
    let a = node(&source, &temp.path().join("a"), &base, &[], "shared.txt", "first\n");
    let first = publish(&source, &[a.clone()], |_| panic!()).unwrap();
    let revised_base = workspace::snapshot_repository(&source).unwrap();
    let b = node(&source, &temp.path().join("b"), &revised_base, &[a.clone()], "shared.txt", "second\n");
    let second = publish(&source, &[b.clone()], |_| panic!("delivered ancestors must not conflict again")).unwrap();
    assert_delivery(&source, &original, &second, &[a, b, revised_base]);
    workspace::repository_git(&source, &["merge-base", "--is-ancestor", &first, &second]).unwrap();
    assert_eq!(git(&source, &["rev-list", "--count", &format!("{original}..HEAD")]), "0");
    assert_eq!(fs::read_to_string(source.join("shared.txt")).unwrap().replace("\r\n", "\n"), "second\n");
}

#[test]
fn plain_folder_delivery_has_no_git_entry_and_conflict_retry_is_private() {
    data();
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("plain");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("shared.txt"), "base\n").unwrap();
    let base = workspace::verify(&source).unwrap();
    let a = node(&source, &temp.path().join("a"), &base, &[], "shared.txt", "left\n");
    let b = node(&source, &temp.path().join("b"), &base, &[], "shared.txt", "right\n");
    let heads = [a, b];
    assert!(publish(&source, &heads, |_| Err("interrupted".into())).is_err());
    assert_eq!(fs::read_to_string(source.join("shared.txt")).unwrap(), "base\n");
    assert!(workspace::git(&publication_workspace(&source, &heads).unwrap(), &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok());
    let published = publish(&source, &heads, |private| {
        fs::write(private.join("shared.txt"), "resolved\n").unwrap();
        workspace::git(private, &["add", "shared.txt"])?;
        Ok(())
    }).unwrap();
    assert!(!source.join(".git").exists());
    assert_eq!(publish(&source, &heads, |_| panic!()).unwrap(), published);
    assert_eq!(fs::read_to_string(source.join("shared.txt")).unwrap().replace("\r\n", "\n"), "resolved\n");
}
