use super::*;

pub(super) fn fixture() -> (
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
    let stored = stored_files(&files);
    files.preflight_roots(&paths, &version).unwrap();
    assert_eq!(
        stored_files(&files),
        stored,
        "preflight is read-only, even for dirty live files"
    );
    for path in paths.values() {
        assert_eq!(fs::read_to_string(path.join("env/value")).unwrap(), "later");
    }
    files.materialize_roots(&paths, &version).unwrap();
    assert_eq!(
        stored_files(&files),
        stored,
        "discarded partial bytes are not new history"
    );
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
        files
            .capture_roots(&paths, &layouts, &version, &[])
            .unwrap();
        for path in paths.values() {
            fs::remove_dir_all(path.join(replacement)).unwrap();
            fs::write(path.join(replacement), "later regular file").unwrap();
        }
        files.preflight_roots(&paths, &version).unwrap();
        for path in paths.values() {
            assert_eq!(
                fs::read_to_string(path.join(replacement)).unwrap(),
                "later regular file"
            );
        }
        files.materialize_roots(&paths, &version).unwrap();
        files.verify_roots(&paths, &version).unwrap();
        for path in paths.values() {
            assert_eq!(
                fs::read_to_string(path.join("env/nested/deeper/value")).unwrap(),
                "historical"
            );
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
    let stored = stored_files(&files);
    assert!(files.preflight_roots(&paths, &version).is_err());
    assert_eq!(
        stored_files(&files),
        stored,
        "refused preflight must not retain first-root partial bytes"
    );
    assert!(files.materialize_roots(&paths, &version).is_err());
    assert_eq!(stored_files(&files), stored);
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
fn rooted_skipped_link_destination_refuses_before_either_root_changes() {
    let (temp, files, paths, layouts) = fixture();
    let version = Uuid::new_v4().to_string();
    files
        .capture_roots(&paths, &layouts, &version, &[])
        .unwrap();
    fs::write(paths["state"].join("env/value"), "partial S").unwrap();
    // This is a leaf destination, so checking only its parent misses it.
    fs::remove_file(paths["workspace"].join("env/value")).unwrap();
    let target = temp.path().join("unavailable-target");
    fs::create_dir(&target).unwrap();
    crate::path_safety::directory_link(&target, &paths["workspace"].join("env/value"));
    fs::remove_dir(&target).unwrap();
    let stored = stored_files(&files);
    let error = files.preflight_roots(&paths, &version).unwrap_err();
    assert!(
        error.contains("untouched") && error.contains("env/value"),
        "{error}"
    );
    assert!(files.materialize_roots(&paths, &version).is_err());
    assert_eq!(
        fs::read_to_string(paths["state"].join("env/value")).unwrap(),
        "partial S"
    );
    assert!(fs::symlink_metadata(paths["workspace"].join("env/value"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(stored_files(&files), stored);

    // Removing the obstruction explicitly permits ordinary byte restoration;
    // the immutable record is not changed or repaired from today's live tree.
    crate::path_safety::remove_directory_link(&paths["workspace"].join("env/value"));
    files.materialize_roots(&paths, &version).unwrap();
    files.verify_roots(&paths, &version).unwrap();
    assert_eq!(stored_files(&files), stored);
}

#[test]
fn rooted_retained_cache_or_skipped_link_cannot_be_replaced_by_a_recorded_file() {
    for cache in [false, true] {
        let (temp, files, paths, mut layouts) = fixture();
        if cache {
            layouts
                .get_mut("workspace")
                .unwrap()
                .caches
                .push("env/value/retained".into());
        }
        let version = Uuid::new_v4().to_string();
        files
            .capture_roots(&paths, &layouts, &version, &[])
            .unwrap();
        fs::write(paths["state"].join("env/value"), "partial S").unwrap();
        fs::remove_file(paths["workspace"].join("env/value")).unwrap();
        fs::create_dir(paths["workspace"].join("env/value")).unwrap();
        let retained = paths["workspace"].join("env/value/retained");
        if cache {
            fs::create_dir(&retained).unwrap();
            fs::write(retained.join("cache-byte"), "keep cache").unwrap();
        } else {
            let target = temp.path().join("unavailable-target");
            fs::create_dir(&target).unwrap();
            crate::path_safety::directory_link(&target, &retained);
            fs::remove_dir(&target).unwrap();
        }
        let stored = stored_files(&files);
        let error = files.preflight_roots(&paths, &version).unwrap_err();
        assert!(
            error.contains("untouched") && error.contains("env/value"),
            "{error}"
        );
        assert!(files.materialize_roots(&paths, &version).is_err());
        assert_eq!(
            fs::read_to_string(paths["state"].join("env/value")).unwrap(),
            "partial S"
        );
        assert!(fs::symlink_metadata(&retained).is_ok());
        if cache {
            assert_eq!(
                fs::read_to_string(retained.join("cache-byte")).unwrap(),
                "keep cache"
            );
        }
        assert_eq!(stored_files(&files), stored);
    }
}

#[test]
fn rooted_unrelated_skipped_links_and_cache_do_not_prevent_valid_recovery() {
    let (temp, files, paths, layouts) = fixture();
    let version = Uuid::new_v4().to_string();
    files
        .capture_roots(&paths, &layouts, &version, &[])
        .unwrap();
    let target = temp.path().join("unavailable-target");
    fs::create_dir(&target).unwrap();
    let link = paths["workspace"].join("env/skipped");
    crate::path_safety::directory_link(&target, &link);
    fs::remove_dir(&target).unwrap();
    for path in paths.values() {
        fs::write(path.join("env/value"), "partial").unwrap();
    }
    fs::write(
        paths["state"].join(".agent-home/cache/value"),
        "keep newer cache",
    )
    .unwrap();
    let stored = stored_files(&files);
    files.preflight_roots(&paths, &version).unwrap();
    files.materialize_roots(&paths, &version).unwrap();
    files.verify_roots(&paths, &version).unwrap();
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read_to_string(paths["state"].join(".agent-home/cache/value")).unwrap(),
        "keep newer cache"
    );
    assert_eq!(stored_files(&files), stored);
}

#[test]
fn rooted_corrupt_blob_refuses_read_only_preflight_and_preserves_both_live_roots() {
    let (_temp, files, paths, layouts) = fixture();
    let version = Uuid::new_v4().to_string();
    files
        .capture_roots(&paths, &layouts, &version, &[])
        .unwrap();
    let record = files.load(&version).unwrap();
    let Entry::File { blob, .. } = &record.rooted.unwrap().roots["workspace"].entries["env/value"]
    else {
        panic!()
    };
    let blob_path = files.blob_path(blob).unwrap();
    // Preserve size and mtime: neither may authorize skipping byte validation.
    let modified = fs::metadata(&blob_path).unwrap().modified().unwrap();
    fs::write(&blob_path, "damaged!!").unwrap();
    fs::File::options()
        .write(true)
        .open(&blob_path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    for path in paths.values() {
        fs::write(path.join("env/value"), "keep partial").unwrap();
    }
    let stored = stored_files(&files);
    assert!(files
        .preflight_roots(&paths, &version)
        .unwrap_err()
        .contains("Damaged workspace file blob"));
    assert!(files
        .materialize_roots(&paths, &version)
        .unwrap_err()
        .contains("Damaged workspace file blob"));
    assert_eq!(stored_files(&files), stored);
    for path in paths.values() {
        assert_eq!(
            fs::read_to_string(path.join("env/value")).unwrap(),
            "keep partial"
        );
    }
}

// This isolates managed restoration's dirty-view cost from project Git/ACL
// preparation. The real-tool project probe remains separate; no sandbox claim.
#[test]
#[ignore = "opt-in managed dirty-view preflight/materialization cost probe"]
fn managed_recovery_preflight_benchmark() {
    use std::time::Instant;
    let store_size = |files: &Files| {
        let mut count = 0u64;
        let mut bytes = 0u64;
        for directory in ["blobs", "versions"] {
            for entry in fs::read_dir(files.directory.join(directory)).unwrap() {
                let metadata = entry.unwrap().metadata().unwrap();
                count += 1;
                bytes += metadata.len();
            }
        }
        serde_json::json!({"files":count,"logicalBytes":bytes})
    };
    let mut samples = Vec::new();
    for (count, bytes) in [(64, 4096), (512, 4096), (8, 1024 * 1024)] {
        for sample in 0..3 {
            let (_temp, files, paths, layouts) = fixture();
            for (label, path) in &paths {
                for index in 0..count {
                    let mut data = vec![b'x'; bytes];
                    let identity = format!("{label}/{index:04}/recorded");
                    data[..identity.len()].copy_from_slice(identity.as_bytes());
                    fs::write(path.join(format!("env/dependency-{index:04}")), data).unwrap();
                }
            }
            let version = Uuid::new_v4().to_string();
            files
                .capture_roots(&paths, &layouts, &version, &[])
                .unwrap();
            for path in paths.values() {
                for index in 0..count {
                    let path = path.join(format!("env/dependency-{index:04}"));
                    let mut data = fs::read(&path).unwrap();
                    data[0] = b'!';
                    fs::write(path, data).unwrap();
                }
            }
            let before = store_size(&files);
            let start = Instant::now();
            files.preflight_roots(&paths, &version).unwrap();
            let preflight_ms = start.elapsed().as_secs_f64() * 1000.0;
            let after_preflight = store_size(&files);
            // Preflight must leave the dirty live view intact.
            assert_eq!(
                fs::read(paths["workspace"].join("env/dependency-0000")).unwrap()[0],
                b'!'
            );
            let start = Instant::now();
            files.materialize_roots(&paths, &version).unwrap();
            let materialize_ms = start.elapsed().as_secs_f64() * 1000.0;
            files.verify_roots(&paths, &version).unwrap();
            samples.push(
                serde_json::json!({"filesPerRoot":count,"bytesPerFile":bytes,"sample":sample,
                "preflightMs":preflight_ms,"materializeMs":materialize_ms,"storeBefore":before,
                "storeAfterPreflight":after_preflight,"storeAfterMaterialize":store_size(&files)}),
            );
        }
    }
    println!(
        "GRAPHER_MANAGED_RECOVERY_PROBE {}",
        serde_json::json!({"schema":1,
        "platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"samples":samples,
        "limits":"warm filesystem cache; test profile; logical bytes; excludes project Git preparation, child resources and native sandbox acceptance"})
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
fn snapshot_schema_and_root_coverage_are_integrity_protected() {
    let value = Version {
        schema: 1,
        head: "head".into(),
        parents: vec![],
        entries: Entries::new(),
        checksum: None,
        rooted: None,
    };
    assert_eq!(
        serde_json::to_string(&value).unwrap(),
        r#"{"schema":1,"head":"head","parents":[],"entries":{},"checksum":null}"#
    );
    assert_eq!(
        value.checksum().unwrap(),
        git2::Oid::hash_object(git2::ObjectType::Blob, br#"[1,"head",[],{},null]"#)
            .unwrap()
            .to_string()
    );
    let (_temp, files, paths, layouts) = fixture();
    let version = Uuid::new_v4().to_string();
    files
        .capture_roots(&paths, &layouts, &version, &[])
        .unwrap();
    let path = files.version_path(&version).unwrap();
    let original = fs::read(&path).unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
    value.as_object_mut().unwrap().remove("schema");
    let unsupported = serde_json::to_vec(&value).unwrap();
    fs::write(&path, &unsupported).unwrap();
    assert!(files.validate_manifest(&version).is_err());
    assert_eq!(fs::read(&path).unwrap(), unsupported);
    let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
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
