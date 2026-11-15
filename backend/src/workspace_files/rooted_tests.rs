use super::*;

fn fixture() -> (
    TempDir,
    Files,
    BTreeMap<String, PathBuf>,
    BTreeMap<String, RootScope>,
) {
    let temp = tempfile::tempdir().unwrap();
    let paths = BTreeMap::from([
        ("workspace".into(), temp.path().join("W")),
        ("state".into(), temp.path().join("S")),
    ]);
    for (label, path) in &paths {
        fs::create_dir_all(path.join("env")).unwrap();
        fs::write(path.join("env/value"), label).unwrap();
    }
    let layouts = BTreeMap::from([
        (
            "workspace".into(),
            RootScope::normalized(vec!["env".into(), "absent".into()], vec![]),
        ),
        (
            "state".into(),
            RootScope::normalized(
                vec!["env".into(), ".agent-home".into()],
                vec![".agent-home/cache".into()],
            ),
        ),
    ]);
    fs::create_dir_all(paths["state"].join(".agent-home/cache")).unwrap();
    fs::write(paths["state"].join(".agent-home/cache/value"), "cache").unwrap();
    let files = Files::environment(&temp.path().join("store"), &[], &[])
        .unwrap()
        .with_project_index(false);
    (temp, files, paths, layouts)
}

#[test]
fn rooted_snapshot_restores_distinct_roots_absence_and_keeps_caches() {
    let (_temp, files, paths, layouts) = fixture();
    let parent = Uuid::new_v4().to_string();
    files.capture_empty(&parent).unwrap();
    let version = Uuid::new_v4().to_string();
    files
        .capture_roots(&paths, &layouts, &version, std::slice::from_ref(&parent))
        .unwrap();
    let manifest = fs::read(files.version_path(&version).unwrap()).unwrap();
    assert_eq!(files.root_layouts(&version).unwrap(), Some(layouts));
    assert!(files.descends_from(&version, &parent).unwrap());
    for path in paths.values() {
        fs::write(path.join("env/value"), "later").unwrap();
    }
    fs::create_dir_all(paths["workspace"].join("absent")).unwrap();
    fs::write(paths["workspace"].join("absent/later"), "not historical").unwrap();
    fs::write(paths["state"].join(".agent-home/cache/value"), "new cache").unwrap();
    files.materialize_roots(&paths, &version).unwrap();
    for (label, path) in &paths {
        assert_eq!(fs::read_to_string(path.join("env/value")).unwrap(), *label);
    }
    assert!(!paths["workspace"].join("absent").exists());
    assert_eq!(
        fs::read_to_string(paths["state"].join(".agent-home/cache/value")).unwrap(),
        "new cache"
    );
    files.verify_roots(&paths, &version).unwrap();
    assert_eq!(
        fs::read(files.version_path(&version).unwrap()).unwrap(),
        manifest
    );
    fs::write(paths["workspace"].join("env/value"), "W-only").unwrap();
    assert_eq!(
        fs::read_to_string(paths["state"].join("env/value")).unwrap(),
        "state"
    );
    files.validate(&[version]).unwrap();
}

#[test]
fn rooted_history_restores_a_directory_replaced_by_an_owned_regular_file() {
    for replacement in ["env/nested", "env/nested/deeper"] {
        let (_temp, files, paths, layouts) = fixture();
        for path in paths.values() {
            fs::create_dir_all(path.join("env/nested/deeper")).unwrap();
            fs::write(path.join("env/nested/deeper/value"), "historical").unwrap();
        }
        let version = Uuid::new_v4().to_string();
        files.capture_roots(&paths, &layouts, &version, &[]).unwrap();
        for path in paths.values() {
            fs::remove_dir_all(path.join(replacement)).unwrap();
            fs::write(path.join(replacement), "later regular file").unwrap();
        }
        files.preflight_roots(&paths, &version).unwrap();
        for path in paths.values() {
            assert_eq!(fs::read_to_string(path.join(replacement)).unwrap(), "later regular file");
        }
        files.materialize_roots(&paths, &version).unwrap();
        files.verify_roots(&paths, &version).unwrap();
        for path in paths.values() {
            assert_eq!(fs::read_to_string(path.join("env/nested/deeper/value")).unwrap(), "historical");
        }
    }
}

#[test]
fn rooted_missing_blob_is_not_repaired_and_neither_root_is_partly_restored() {
    let (_temp, files, paths, layouts) = fixture();
    let version = Uuid::new_v4().to_string();
    files
        .capture_roots(&paths, &layouts, &version, &[])
        .unwrap();
    let record = files.load(&version).unwrap();
    let Entry::File { blob, .. } =
        &record.rooted.as_ref().unwrap().roots["workspace"].entries["env/value"]
    else {
        panic!()
    };
    let blob_path = files.blob_path(blob).unwrap();
    fs::remove_file(&blob_path).unwrap();
    assert!(
        files
            .verify_roots(&paths, &version)
            .unwrap_err()
            .contains("Missing workspace file blob"),
        "unchanged live bytes cannot replace missing immutable evidence"
    );
    for path in paths.values() {
        fs::write(path.join("env/value"), "partial").unwrap();
    }
    files.validate_manifest(&version).unwrap(); // Actor work is metadata-only.
    let error = files.materialize_roots(&paths, &version).unwrap_err();
    assert!(error.contains("Missing workspace file blob"), "{error}");
    assert!(!blob_path.exists());
    for path in paths.values() {
        assert_eq!(
            fs::read_to_string(path.join("env/value")).unwrap(),
            "partial"
        );
    }
}

#[test]
fn rooted_second_target_failure_preflights_before_first_root_write() {
    let (temp, files, paths, layouts) = fixture();
    let version = Uuid::new_v4().to_string();
    files
        .capture_roots(&paths, &layouts, &version, &[])
        .unwrap();
    fs::write(paths["state"].join("env/value"), "partial S").unwrap();
    fs::remove_dir_all(paths["workspace"].join("env")).unwrap();
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("value"), "outside").unwrap();
    crate::path_safety::directory_link(&outside, &paths["workspace"].join("env"));
    assert!(files.materialize_roots(&paths, &version).is_err());
    assert_eq!(
        fs::read_to_string(paths["state"].join("env/value")).unwrap(),
        "partial S"
    );
    assert_eq!(
        fs::read_to_string(outside.join("value")).unwrap(),
        "outside"
    );
}

#[test]
fn rooted_root_targets_and_scope_comparisons_are_qualified_not_same_named_aliases() {
    let (_temp, files, paths, layouts) = fixture();
    let first = Uuid::new_v4().to_string();
    files.capture_roots(&paths, &layouts, &first, &[]).unwrap();
    fs::write(paths["workspace"].join("env/value"), "different W").unwrap();
    let second = Uuid::new_v4().to_string();
    files
        .capture_roots(&paths, &layouts, &second, std::slice::from_ref(&first))
        .unwrap();
    assert!(!files
        .same_scope_contents(&first, &second, "env", "workspace")
        .unwrap());
    assert!(files
        .same_scope_contents(&first, &second, "env", "state")
        .unwrap());
    let mut wrong = paths.clone();
    wrong.insert("workspace".into(), paths["state"].clone());
    assert!(files
        .materialize_roots(&wrong, &first)
        .unwrap_err()
        .contains("alias or overlap"));
    assert_eq!(
        fs::read_to_string(paths["workspace"].join("env/value")).unwrap(),
        "different W"
    );
    assert!(
        files
            .materialize(&paths["workspace"], &[first], None, false)
            .is_err(),
        "unqualified materialization is not a fallback"
    );
}

#[test]
fn rooted_native_tracked_scope_conflict_refuses_before_s_writes() {
    let (_temp, files, paths, layouts) = fixture();
    let version = Uuid::new_v4().to_string();
    files
        .capture_roots(&paths, &layouts, &version, &[])
        .unwrap();
    workspace::git(&paths["workspace"], &["init", "-q"]).unwrap();
    workspace::project_git(&paths["workspace"], &["add", "env/value"]).unwrap();
    fs::write(paths["state"].join("env/value"), "partial S").unwrap();
    let error = files.materialize_roots(&paths, &version).unwrap_err();
    assert!(
        error.contains("conflicts with tracked path env/value"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(paths["state"].join("env/value")).unwrap(),
        "partial S"
    );
}

#[test]
fn rooted_internal_directory_links_materialize_without_cross_root_targets() {
    let (_temp, files, paths, layouts) = fixture();
    for path in paths.values() {
        fs::create_dir(path.join("env/target")).unwrap();
        fs::write(
            path.join("env/target/value"),
            path.to_string_lossy().as_bytes(),
        )
        .unwrap();
        crate::path_safety::directory_link(&path.join("env/target"), &path.join("env/alias"));
    }
    let version = Uuid::new_v4().to_string();
    files
        .capture_roots(&paths, &layouts, &version, &[])
        .unwrap();
    files.materialize_roots(&paths, &version).unwrap();
    for path in paths.values() {
        assert!(crate::path_identity::same_path(
            &path.join("env/alias"),
            &path.join("env/target")
        ));
        assert_eq!(
            fs::read(path.join("env/alias/value")).unwrap(),
            path.to_string_lossy().as_bytes()
        );
    }
    files.verify_roots(&paths, &version).unwrap();
}

#[cfg(windows)]
#[test]
fn rooted_case_aliased_scope_coverage_keeps_one_rooted_copy() {
    let (_temp, files, paths, mut layouts) = fixture();
    layouts.insert(
        "workspace".into(),
        RootScope::normalized(vec!["env".into(), "ENV".into()], vec![]),
    );
    assert_eq!(layouts["workspace"].scopes, vec!["ENV"]);
    let version = Uuid::new_v4().to_string();
    files
        .capture_roots(&paths, &layouts, &version, &[])
        .unwrap();
    fs::write(paths["workspace"].join("env/value"), "changed").unwrap();
    files.materialize_roots(&paths, &version).unwrap();
    assert_eq!(
        fs::read_to_string(paths["workspace"].join("env/value")).unwrap(),
        "workspace"
    );
    files.verify_roots(&paths, &version).unwrap();
}

#[test]
fn rooted_extension_does_not_change_legacy_json_or_checksum() {
    let value = Version {
        head: "head".into(),
        parents: vec![],
        entries: Entries::new(),
        checksum: None,
        rooted: None,
    };
    assert_eq!(
        serde_json::to_string(&value).unwrap(),
        r#"{"head":"head","parents":[],"entries":{},"checksum":null}"#
    );
    assert_eq!(
        value.checksum().unwrap(),
        git2::Oid::hash_object(git2::ObjectType::Blob, br#"["head",[],{}]"#)
            .unwrap()
            .to_string()
    );
    let (_temp, files, paths, layouts) = fixture();
    let version = Uuid::new_v4().to_string();
    files
        .capture_roots(&paths, &layouts, &version, &[])
        .unwrap();
    let path = files.version_path(&version).unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    value["rooted"]["roots"]
        .as_object_mut()
        .unwrap()
        .remove("workspace");
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(files
        .validate_manifest(&version)
        .unwrap_err()
        .contains("Damaged workspace file manifest"));
}
