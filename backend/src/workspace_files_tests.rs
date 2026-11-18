use super::*;
use tempfile::TempDir;

mod rooted_tests {
    include!("workspace_files/rooted_tests.rs");
}

mod seal_tests {
    include!("workspace_files/seal_tests.rs");
}

mod runtime_evidence_tests {
    include!("workspace_files/runtime_evidence_tests.rs");
}

fn managed_store(temp: &TempDir, workspace: &Path) -> Files {
    workspace::git(workspace, &["init", "-q"]).unwrap();
    let version_store = temp.path().join("environment-files");
    Files::environment(&version_store, &[".venv".into()], &[]).unwrap()
}

// Small regressions compare the complete immutable store, not just manifests.
fn stored_files(files: &Files) -> BTreeMap<PathBuf, Vec<u8>> {
    ["blobs", "versions"]
        .into_iter()
        .flat_map(|directory| {
            fs::read_dir(files.directory.join(directory))
                .unwrap()
                .map(|entry| {
                    let path = entry.unwrap().path();
                    let bytes = fs::read(&path).unwrap();
                    (path, bytes)
                })
                .collect::<Vec<_>>()
        })
        .collect()
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
    let stored = stored_files(&files);
    files
        .materialize(&workspace, std::slice::from_ref(&version), None, false)
        .unwrap();
    assert_eq!(
        stored_files(&files),
        stored,
        "restoration must not snapshot discarded live bytes"
    );
    files.verify(&workspace, &version, "").unwrap();

    assert_eq!(
        fs::read_to_string(workspace.join(".venv/bin/python")).unwrap(),
        "initial environment"
    );
    assert_eq!(
        fs::read_to_string(workspace.join(".cache")).unwrap(),
        "ordinary cache"
    );
    assert!(
        !workspace::repository_git(&workspace, &["ls-files", "--cached"])
            .unwrap()
            .contains(".venv")
    );
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
    files
        .capture(&workspace, &branch, "", std::slice::from_ref(&base))
        .unwrap();
    assert!(files.exists(&branch));
    fs::remove_file(workspace.join(".venv/package")).unwrap();
    files.materialize(&workspace, &[base], None, false).unwrap();
    assert_eq!(
        fs::read_to_string(workspace.join(".venv/package")).unwrap(),
        "base"
    );
}

#[test]
fn legacy_sealing_reuses_only_fully_verified_unchanged_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(workspace.join(".venv")).unwrap();
    fs::write(workspace.join(".venv/package"), "offline patched bytes").unwrap();
    let files = managed_store(&temp, &workspace);
    let base = Uuid::new_v4().to_string();
    files.capture(&workspace, &base, "", &[]).unwrap();
    let stored = stored_files(&files);
    for _ in 0..3 {
        assert_eq!(files.capture_reusing(&workspace, &base).unwrap(), base);
    }
    assert_eq!(stored_files(&files), stored);
    fs::write(workspace.join(".venv/package"), "explicit dependency edit").unwrap();
    let changed = files.capture_reusing(&workspace, &base).unwrap();
    assert_ne!(changed, base);
    assert_eq!(
        files.load(&changed).unwrap().parents,
        std::slice::from_ref(&base)
    );
    files.verify(&workspace, &changed, "").unwrap();
    let Entry::File { blob, .. } = &files.load(&base).unwrap().entries[".venv/package"] else {
        panic!()
    };
    let blob = files.blob_path(blob).unwrap();
    fs::remove_file(&blob).unwrap();
    // Today's matching bytes cannot repair missing historical evidence.
    fs::write(workspace.join(".venv/package"), "offline patched bytes").unwrap();
    let damaged = stored_files(&files);
    assert!(files
        .capture_reusing(&workspace, &base)
        .unwrap_err()
        .contains("Missing workspace file blob"));
    assert!(!blob.exists());
    assert_eq!(stored_files(&files), damaged);
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
fn legacy_predecessor_does_not_delete_or_traverse_a_skipped_live_link() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(workspace.join(".venv/nested")).unwrap();
    fs::write(workspace.join(".venv/nested/old"), "older bytes").unwrap();
    fs::write(workspace.join(".venv/package"), "recorded package").unwrap();
    let files = managed_store(&temp, &workspace);
    let previous = Uuid::new_v4().to_string();
    files.capture(&workspace, &previous, "", &[]).unwrap();
    fs::remove_dir_all(workspace.join(".venv/nested")).unwrap();
    let target = Uuid::new_v4().to_string();
    files
        .capture(&workspace, &target, "", std::slice::from_ref(&previous))
        .unwrap();

    let outside = temp.path().join("unavailable-target");
    fs::create_dir(&outside).unwrap();
    let link = workspace.join(".venv/nested");
    crate::path_safety::directory_link(&outside, &link);
    fs::remove_dir(&outside).unwrap();
    fs::write(workspace.join(".venv/package"), "partial package").unwrap();
    let stored = stored_files(&files);
    files
        .materialize(
            &workspace,
            std::slice::from_ref(&target),
            Some(&previous),
            false,
        )
        .unwrap();
    files.verify(&workspace, &target, "").unwrap();
    assert_eq!(
        fs::read_to_string(workspace.join(".venv/package")).unwrap(),
        "recorded package"
    );
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(stored_files(&files), stored);
}

#[test]
fn cache_exclusions_follow_case_behavior_of_the_workspace_volume() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(workspace.join("managed/Cache")).unwrap();
    fs::write(workspace.join("managed/package"), "environment").unwrap();
    fs::write(workspace.join("managed/Cache/blob"), "cache").unwrap();
    let insensitive = crate::path_identity::case_insensitive_volume(&workspace);
    let files = Files::environment(
        &temp.path().join("environment-files"),
        &["managed".into()],
        &["managed/cache".into()],
    )
    .unwrap();
    let version = Uuid::new_v4().to_string();
    files.capture(&workspace, &version, "", &[]).unwrap();

    let entries = files.load(&version).unwrap().entries;
    assert!(entries.contains_key("managed/package"));
    assert_eq!(entries.contains_key("managed/Cache/blob"), !insensitive);
    assert_eq!(
        entries
            .keys()
            .any(|name| name.starts_with("managed/Cache/")),
        !insensitive
    );
}

#[test]
fn overlapping_scope_aliases_are_rejected_only_when_the_workspace_volume_aliases_them() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(workspace.join("managed")).unwrap();
    let insensitive = crate::path_identity::case_insensitive_volume(&workspace);
    if !insensitive {
        fs::create_dir_all(workspace.join("Managed")).unwrap();
        fs::write(workspace.join("managed/lower"), "lower").unwrap();
        fs::write(workspace.join("Managed/upper"), "upper").unwrap();
    }
    let files = Files::environment(
        &temp.path().join("environment-files"),
        &["managed".into(), "Managed".into()],
        &[],
    )
    .unwrap();
    let version = Uuid::new_v4().to_string();
    let result = files.capture(&workspace, &version, "", &[]);
    assert_eq!(result.is_err(), insensitive, "{result:?}");
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
    let files =
        Files::environment(&version_store, &[".venv".into()], &[".venv/cache".into()]).unwrap();

    let version = Uuid::new_v4().to_string();
    files.capture(&workspace, &version, "", &[]).unwrap();

    let entries = files.load(&version).unwrap().entries;
    assert!(entries.contains_key(".venv/package"));
    assert!(!entries.keys().any(|name| name.starts_with(".venv/cache")));
    // The live cache directory is left untouched.
    assert!(workspace.join(".venv/cache/INetCache/blob").is_file());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_case_aliased_workspace_retains_internal_directory_symlinks() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("MixedCaseSlot");
    fs::create_dir_all(workspace.join(".venv/lib")).unwrap();
    fs::write(workspace.join(".venv/lib/mod.py"), "ok").unwrap();
    std::os::unix::fs::symlink(workspace.join(".venv/lib"), workspace.join(".venv/lib64")).unwrap();

    let files = Files::environment(&temp.path().join("env-files"), &[".venv".into()], &[]).unwrap();
    let aliased = if crate::path_identity::case_insensitive_volume(&workspace) {
        temp.path().join("mixedcaseslot")
    } else {
        workspace.clone()
    };
    let version = Uuid::new_v4().to_string();
    files.capture(&aliased, &version, "", &[]).unwrap();
    let loaded = files.load(&version).unwrap();
    assert!(matches!(
        loaded.entries.get(".venv/lib64"),
        Some(Entry::Link {
            target,
            internal: true,
            directory: true
        }) if target == ".venv/lib"
    ));

    // NFC scope over an NFD disk directory must also rebase internal link targets to the scope spelling.
    let nfd_dir = workspace.join("Cafe\u{0301}Env/lib");
    fs::create_dir_all(&nfd_dir).unwrap();
    fs::write(nfd_dir.join("mod.py"), "ok").unwrap();
    std::os::unix::fs::symlink(&nfd_dir, workspace.join("Cafe\u{0301}Env/lib64")).unwrap();
    let nfc_files =
        Files::environment(&temp.path().join("env-nfc"), &["Caf\u{00e9}Env".into()], &[]).unwrap();
    let nfc_version = Uuid::new_v4().to_string();
    nfc_files.capture(&aliased, &nfc_version, "", &[]).unwrap();
    let nfc_loaded = nfc_files.load(&nfc_version).unwrap();
    assert!(matches!(
        nfc_loaded.entries.get("Caf\u{00e9}Env/lib64"),
        Some(Entry::Link {
            target,
            internal: true,
            directory: true
        }) if target == "Caf\u{00e9}Env/lib" && nfc_loaded.entries.contains_key(target)
    ));
}
