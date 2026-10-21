use super::*;
use tempfile::TempDir;

fn managed_store(temp: &TempDir, workspace: &Path) -> Files {
    workspace::git(workspace, &["init", "-q"]).unwrap();
    let version_store = temp.path().join("environment-files");
    Files::environment(&version_store, &[".venv".into()], &[]).unwrap()
}

#[test]
fn managed_environment_scopes_remain_versioned_and_independent_of_gitignore() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(workspace.join(".venv/bin")).unwrap();
    fs::write(workspace.join(".gitignore"), ".venv/\n").unwrap();
    fs::write(workspace.join(".venv/bin/python"), "initial environment").unwrap();
    fs::write(workspace.join(".cache"), "ordinary cache").unwrap();
    let files = managed_store(&temp, &workspace);

    let version = Uuid::new_v4().to_string();
    files.capture(&workspace, &version, "", &[]).unwrap();
    fs::write(workspace.join(".venv/bin/python"), "mutated environment").unwrap();
    files.materialize(&workspace, &[version.clone()], None, false).unwrap();

    assert_eq!(fs::read_to_string(workspace.join(".venv/bin/python")).unwrap(), "initial environment");
    assert_eq!(fs::read_to_string(workspace.join(".cache")).unwrap(), "ordinary cache");
    assert!(!workspace::repository_git(&workspace, &["ls-files", "--cached"]).unwrap().contains(".venv"));
}

#[test]
fn managed_environment_scope_conflicts_and_missing_versions_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(workspace.join(".venv")).unwrap();
    fs::write(workspace.join(".venv/package"), "base").unwrap();
    let files = managed_store(&temp, &workspace);
    let base = Uuid::new_v4().to_string();
    files.capture(&workspace, &base, "", &[]).unwrap();

    fs::write(workspace.join(".venv/package"), "changed").unwrap();
    let branch = Uuid::new_v4().to_string();
    files.capture(&workspace, &branch, "", &[base.clone()]).unwrap();
    assert!(files.exists(&branch));
    fs::remove_file(workspace.join(".venv/package")).unwrap();
    files.materialize(&workspace, &[base], None, false).unwrap();
    assert_eq!(fs::read_to_string(workspace.join(".venv/package")).unwrap(), "base");
}

#[test]
fn unresolvable_environment_links_are_skipped_instead_of_failing_the_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(workspace.join(".venv")).unwrap();
    fs::write(workspace.join(".venv/package"), "base").unwrap();
    let files = managed_store(&temp, &workspace);

    // A directory link whose target is then removed mirrors Windows reparse
    // points (for example Content.IE5) that survive without a resolvable target.
    let target = workspace.join(".venv/target");
    fs::create_dir(&target).unwrap();
    crate::path_safety::directory_link(&target, &workspace.join(".venv/broken"));
    fs::remove_dir(&target).unwrap();

    let version = Uuid::new_v4().to_string();
    files.capture(&workspace, &version, "", &[]).unwrap();

    let entries = files.load(&version).unwrap().entries;
    assert!(!entries.contains_key(".venv/broken"));
    assert!(entries.contains_key(".venv/package"));
}

#[test]
fn nested_cache_paths_are_left_out_of_the_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(workspace.join(".venv/cache/INetCache")).unwrap();
    fs::write(workspace.join(".venv/package"), "base").unwrap();
    fs::write(workspace.join(".venv/cache/INetCache/blob"), "junk").unwrap();
    // A directory link whose target is removed mirrors a broken Windows reparse
    // point. The cache must not be walked, so this cannot fail the snapshot.
    let target = workspace.join(".venv/cache/target");
    fs::create_dir(&target).unwrap();
    crate::path_safety::directory_link(&target, &workspace.join(".venv/cache/broken"));
    fs::remove_dir(&target).unwrap();
    let version_store = temp.path().join("environment-files");
    let files = Files::environment(
        &version_store,
        &[".venv".into()],
        &[".venv/cache".into()],
    )
    .unwrap();

    let version = Uuid::new_v4().to_string();
    files.capture(&workspace, &version, "", &[]).unwrap();

    let entries = files.load(&version).unwrap().entries;
    assert!(entries.contains_key(".venv/package"));
    assert!(!entries.keys().any(|name| name.starts_with(".venv/cache")));
    // The live cache directory is left untouched.
    assert!(workspace.join(".venv/cache/INetCache/blob").is_file());
}
