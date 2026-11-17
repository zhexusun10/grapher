//! Native ACL-only edits must survive snapshot/fork and composed publication
//! evidence. Files-only delivery does not rewrite the user's source ACLs.
use super::*;
use std::process::Command;

fn source(temp: &tempfile::TempDir) -> PathBuf {
    let root = temp.path().join("source");
    fs::create_dir(&root).unwrap();
    workspace::git(&root, &["init", "-q"]).unwrap();
    workspace::project_git(&root, &["config", "user.name", "ACL Test"]).unwrap();
    workspace::project_git(&root, &["config", "user.email", "acl@example.invalid"]).unwrap();
    workspace::project_git(&root, &["config", "commit.gpgsign", "false"]).unwrap();
    fs::write(root.join("file"), "unchanged project bytes\n").unwrap();
    workspace::git(&root, &["add", "file"]).unwrap();
    workspace::git(&root, &["commit", "-qm", "baseline"]).unwrap();
    root
}

fn slot(temp: &tempfile::TempDir, name: &str) -> PathBuf {
    temp.path()
        .join(".grapher-worktrees")
        .join("48b8e1d1-2428-42a2-9b28-9d90f631f9d1")
        .join(name)
}

fn acl(path: &Path) -> serde_json::Value {
    let metadata = fs::symlink_metadata(path).unwrap();
    serde_json::to_value(crate::workspace_metadata::capture(path, &metadata).unwrap()).unwrap()
        ["security"]
        .clone()
}

fn change_acl(path: &Path, rule: &str) {
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("icacls.exe");
        command.arg(crate::native::host_path(path));
        match rule {
            "read" => {
                command.args(["/grant:r", "*S-1-1-0:(R)"]);
            }
            "execute" => {
                command.args(["/grant:r", "*S-1-1-0:(RX)"]);
            }
            "inherit-read" => {
                command.args(["/grant:r", "*S-1-1-0:(OI)(CI)(R)"]);
            }
            _ => unreachable!(),
        }
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("/bin/chmod");
        match rule {
            "read" => {
                command.args(["+a", "everyone allow read"]);
            }
            "execute" => {
                command.args(["+a", "everyone allow read,execute"]);
            }
            _ => unreachable!(),
        }
        command.arg(path);
        command
    };
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "native ACL edit failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn acl_only_edits_advance_snapshots_and_survive_fork_publication_and_removal() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let source_file = source.join("file");
    // Native CI volumes may already grant Everyone access. Exercise that case
    // explicitly rather than assuming the test owns every rule for this SID.
    change_acl(&source_file, "read");
    let original_metadata = crate::workspace_metadata::capture(
        &source_file,
        &fs::symlink_metadata(&source_file).unwrap(),
    )
    .unwrap();
    let original = acl(&source_file);
    let user_head = workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap();
    let user_index = fs::read(source.join(".git/index")).unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&temp, "acl-node");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    let before = workspace::snapshot_node(&node, &source, "acl").unwrap();
    change_acl(&node.join("file"), "execute");
    let edited = acl(&node.join("file"));
    assert_ne!(edited, original);
    let result = workspace::snapshot_node(&node, &source, "acl").unwrap();
    assert_ne!(
        before, result,
        "ACL-only work needs a distinct immutable reference"
    );
    let fork = slot(&temp, "acl-fork");
    workspace::prepare(&source, &fork, &result, &[]).unwrap();
    assert_eq!(acl(&fork.join("file")), edited);
    assert_eq!(
        acl(&source_file),
        original,
        "fork must not change source permissions"
    );
    let published = crate::graph_merge::merge_graph(&source, std::slice::from_ref(&result), || {
        panic!("no content conflict")
    })
    .unwrap();
    let published_fork = slot(&temp, "acl-published");
    workspace::prepare(&source, &published_fork, &published, &[]).unwrap();
    assert_eq!(acl(&published_fork.join("file")), edited);
    assert_eq!(
        acl(&source_file),
        original,
        "files-only delivery keeps source ACLs"
    );

    // Remove only our change, not pre-existing Everyone grants. Dropping all
    // rules for that SID would create a real conflict with unchanged source.
    crate::workspace_metadata::restore(&fork.join("file"), &original_metadata).unwrap();
    let removed = acl(&fork.join("file"));
    assert_ne!(removed, edited);
    assert_eq!(removed, original);
    let removal = workspace::snapshot_node(&fork, &source, "acl-removal").unwrap();
    assert_ne!(removal, result);
    let child = slot(&temp, "acl-removed");
    workspace::prepare(&source, &child, &removal, &[]).unwrap();
    assert_eq!(acl(&child.join("file")), removed);
    let published =
        crate::graph_merge::merge_graph(&source, &[removal], || panic!("no content conflict"))
            .unwrap();
    let published_child = slot(&temp, "acl-removal-published");
    workspace::prepare(&source, &published_child, &published, &[]).unwrap();
    assert_eq!(acl(&published_child.join("file")), removed);
    assert_eq!(acl(&source_file), original);
    assert_eq!(
        fs::read(&source_file).unwrap(),
        b"unchanged project bytes\n"
    );
    assert_eq!(
        workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap(),
        user_head
    );
    assert_eq!(fs::read(source.join(".git/index")).unwrap(), user_index);
}

#[cfg(windows)]
#[test]
fn source_inherited_acls_survive_a_different_cache_parent_and_new_private_files() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    fs::create_dir(source.join("nested")).unwrap();
    fs::write(source.join("nested/file"), "nested bytes").unwrap();
    change_acl(&source, "inherit-read");
    fs::write(source.join("new-reference"), "reference").unwrap();
    let source_acl = acl(&source);
    assert_ne!(source_acl, acl(temp.path()));
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = slot(&temp, "inherited-acls");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    for relative in ["", "file", "nested", "nested/file"] {
        assert_eq!(
            acl(&node.join(relative)),
            acl(&source.join(relative)),
            "{relative}"
        );
    }
    fs::write(node.join("private-new"), "private bytes").unwrap();
    let inherited = acl(&node.join("private-new"));
    assert_eq!(inherited, acl(&source.join("new-reference")));
    let head = workspace::snapshot_node(&node, &source, "inherited-acls").unwrap();
    let fork = slot(&temp, "inherited-acl-fork");
    workspace::prepare(&source, &fork, &head, &[]).unwrap();
    assert_eq!(acl(&fork.join("private-new")), inherited);
    assert_eq!(acl(&source), source_acl);
    assert!(!source.join("private-new").exists());
}

#[test]
fn conflicting_acl_only_parents_are_refused_and_completed_acl_edits_are_detected() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(&temp);
    let base = workspace::snapshot_repository(&source).unwrap();
    let mut results = Vec::new();
    for rule in ["read", "execute"] {
        let node = slot(&temp, rule);
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        change_acl(&node.join("file"), rule);
        let head = workspace::snapshot_node(&node, &source, rule).unwrap();
        verify_result(&node, &source, &head).unwrap();
        results.push(head);
    }
    let joined = slot(&temp, "conflicting-acls");
    let error = workspace::prepare(&source, &joined, &base, &results).unwrap_err();
    assert!(error.contains("metadata composition conflict"), "{error}");
    let node = slot(&temp, "read");
    change_acl(&node.join("file"), "execute");
    assert!(verify_result(&node, &source, &results[0])
        .unwrap_err()
        .contains("metadata changed outside"));
}
