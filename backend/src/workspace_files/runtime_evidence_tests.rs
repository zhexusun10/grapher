use super::rooted_tests::fixture;
use super::*;

#[test]
fn rooted_runtime_files_require_the_recorded_root_file_not_live_or_sibling_bytes() {
    let (_temp, files, paths, layouts) = fixture();
    let data = b"identical native input";
    fs::write(paths["state"].join("env/value"), data).unwrap();
    fs::remove_file(paths["workspace"].join("env/value")).unwrap();
    let version = Uuid::new_v4().to_string();
    files
        .capture_roots(&paths, &layouts, &version, &[])
        .unwrap();
    fs::write(paths["workspace"].join("env/value"), data).unwrap();
    let blob = git2::Oid::hash_object(git2::ObjectType::Blob, data)
        .unwrap()
        .to_string();
    // Both a live W file and identical stored S bytes exist. Neither can fill
    // the historical W absence, even though its global CAS blob is available.
    let error = files
        .verify_recorded_runtime_files(&version, "state", &[("workspace", "env/value", &blob)])
        .unwrap_err();
    assert!(
        error.contains("lacks captured file bytes") && error.contains("workspace:env/value"),
        "{error}"
    );
    files
        .verify_recorded_runtime_files(&version, "state", &[("state", "env/value", &blob)])
        .unwrap();
    fs::write(files.blob_path(&blob).unwrap(), "corrupted stored data").unwrap();
    assert!(files
        .verify_recorded_runtime_files(&version, "state", &[("state", "env/value", &blob)])
        .unwrap_err()
        .contains("Damaged workspace file blob"));
}

#[test]
fn rooted_runtime_cache_classification_is_root_qualified_and_not_a_byte_restore_promise() {
    let (_temp, files, paths, layouts) = fixture();
    let version = Uuid::new_v4().to_string();
    files
        .capture_roots(&paths, &layouts, &version, &[])
        .unwrap();
    let blob = "0".repeat(40);
    let caches = files
        .verify_recorded_runtime_files(
            &version,
            "state",
            &[("state", ".agent-home/cache/native", &blob)],
        )
        .unwrap();
    assert_eq!(
        caches.caches,
        [(
            "state".into(),
            ".agent-home/cache/native".into(),
            blob.clone()
        )]
    );
    assert!(caches.project.is_empty());
    let code = files
        .verify_recorded_runtime_files(
            &version,
            "state",
            &[("workspace", ".agent-home/cache/native", &blob)],
        )
        .unwrap();
    // The same W name is ordinary project code, NOT S's excluded cache and
    // NOT E byte evidence. Its check follows codeRef preparation.
    assert!(code.caches.is_empty());
    assert_eq!(
        code.project,
        [(
            "workspace".into(),
            ".agent-home/cache/native".into(),
            blob.clone()
        )]
    );
    assert!(!files.blob_path(&blob).unwrap().exists());
    assert!(files
        .verify_recorded_runtime_files(&version, "state", &[("state", "unknown/native", &blob)])
        .unwrap_err()
        .contains("outside captured E scope coverage"));
    assert!(files
        .verify_recorded_runtime_files(&version, "state", &[("other", "env/value", &blob)])
        .is_err());
}

#[test]
fn legacy_runtime_byte_evidence_stays_single_root_without_rewriting_its_manifest() {
    let (temp, _rooted_files, paths, _layouts) = fixture();
    let files = Files::environment(&temp.path().join("legacy-store"), &["env".into()], &[])
        .unwrap()
        .with_project_index(false);
    let version = Uuid::new_v4().to_string();
    files
        .capture(&paths["workspace"], &version, "", &[])
        .unwrap();
    let original = fs::read(files.version_path(&version).unwrap()).unwrap();
    let record = files.load(&version).unwrap();
    let Entry::File { blob, .. } = &record.entries["env/value"] else {
        panic!()
    };
    files
        .verify_recorded_runtime_files(&version, "workspace", &[("workspace", "env/value", blob)])
        .unwrap();
    assert!(files
        .verify_recorded_runtime_files(&version, "workspace", &[("state", "env/value", blob)])
        .unwrap_err()
        .contains("Legacy environment has no byte evidence"));
    assert_eq!(
        fs::read(files.version_path(&version).unwrap()).unwrap(),
        original
    );
}
