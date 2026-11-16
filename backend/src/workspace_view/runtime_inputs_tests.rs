use super::*;

fn project(format: &str) -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    workspace::git(
        &source,
        &["init", "-q", &format!("--object-format={format}")],
    )
    .unwrap();
    workspace::project_git(&source, &["config", "user.name", "Native Input Test"]).unwrap();
    workspace::project_git(&source, &["config", "user.email", "native@example.invalid"]).unwrap();
    workspace::project_git(&source, &["config", "core.autocrlf", "false"]).unwrap();
    fs::write(source.join("README"), "initial").unwrap();
    fs::write(source.join(".gitignore"), "vendor/\n").unwrap();
    workspace::git(&source, &["add", "README", ".gitignore"]).unwrap();
    workspace::git(&source, &["commit", "-qm", "initial"]).unwrap();
    fs::create_dir(source.join("vendor")).unwrap();
    (temp, source)
}
fn input(source: &Path, name: &str) -> Vec<(String, String, String)> {
    vec![(
        "workspace".into(),
        name.into(),
        git2::Oid::hash_file(git2::ObjectType::Blob, &source.join(name))
            .unwrap()
            .to_string(),
    )]
}

#[test]
fn runtime_project_code_proof_uses_raw_recorded_bytes_for_sha1_and_sha256() {
    for format in ["sha1", "sha256"] {
        let (_temp, source) = project(format);
        let name = "vendor/-native [x] 中文.bin";
        fs::write(source.join(name), b"native\0bytes\xff\r\n").unwrap();
        let expected = input(&source, name);
        let native_head = workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap();
        let native_index = fs::read(source.join(".git/index")).unwrap();
        let first = workspace::snapshot_repository(&source).unwrap();
        assert_eq!(first.len(), if format == "sha256" { 64 } else { 40 });
        let record = super::super::record_path(&source, &first).unwrap();
        let original_record = fs::read(record.join("view.json")).unwrap();
        fs::write(source.join(name), "newer source bytes").unwrap();
        let second = workspace::snapshot_repository(&source).unwrap();
        let refs = workspace::repository_git(&source, &["show-ref"]).unwrap();
        verify_native_inputs(&source, &first, &expected).unwrap();
        assert!(verify_native_inputs(&source, &second, &expected)
            .unwrap_err()
            .contains(if format == "sha1" {
                "differs from codeRef"
            } else {
                "blob bytes failed"
            }));
        fs::remove_file(source.join(name)).unwrap();
        verify_native_inputs(&source, &first, &expected).unwrap();
        assert!(
            !source.join(name).exists(),
            "read-only proof must not reconstruct source files"
        );
        assert_eq!(
            workspace::repository_git(&source, &["show-ref"]).unwrap(),
            refs
        );
        assert_eq!(
            workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap(),
            native_head
        );
        assert_eq!(fs::read(source.join(".git/index")).unwrap(), native_index);
        assert_eq!(fs::read(record.join("view.json")).unwrap(), original_record);
    }
}

#[test]
fn runtime_project_code_proof_rejects_missing_or_corrupt_objects_without_live_repair() {
    for missing in [true, false] {
        let (_temp, source) = project("sha1");
        fs::write(source.join("vendor/native"), "captured native bytes").unwrap();
        fs::write(source.join("vendor/replacement"), "different native bytes").unwrap();
        let expected = input(&source, "vendor/native");
        let other = input(&source, "vendor/replacement");
        let head = workspace::snapshot_repository(&source).unwrap();
        let shadow = workspace::shadow_repo_if_exists(&source).unwrap().unwrap();
        let object_path = |oid: &str| shadow.join("objects").join(&oid[..2]).join(&oid[2..]);
        let object = object_path(&expected[0].2);
        let replacement = fs::read(object_path(&other[0].2)).unwrap();
        fs::remove_file(&object).unwrap();
        if !missing {
            fs::write(&object, &replacement).unwrap();
        }
        let error = verify_native_inputs(&source, &head, &expected).unwrap_err();
        if !missing {
            assert!(error.contains("blob bytes failed"), "{error}");
        }
        assert_eq!(
            fs::read_to_string(source.join("vendor/native")).unwrap(),
            "captured native bytes"
        );
        assert_eq!(
            fs::read(&object).ok(),
            if missing { None } else { Some(replacement) }
        );
    }
}

#[test]
fn runtime_project_code_proof_rejects_absence_links_and_non_directory_traversal() {
    let (_temp, source) = project("sha1");
    fs::write(source.join("vendor/native"), "native bytes").unwrap();
    crate::path_safety::directory_link(&source.join("vendor"), &source.join("selected"));
    let head = workspace::snapshot_repository(&source).unwrap();
    let expected = input(&source, "vendor/native");
    for (path, diagnostic) in [
        ("vendor/missing", "missing from codeRef"),
        ("vendor", "lacks regular-file bytes"),
        ("selected", "lacks regular-file bytes"),
        ("selected/native", "non-directory"),
        ("vendor/native/child", "non-directory"),
    ] {
        let mut invalid = expected.clone();
        invalid[0].1 = path.into();
        let outcome = verify_native_inputs(&source, &head, &invalid);
        if cfg!(target_os = "macos") && path == "vendor/missing" {
            outcome.expect("nonexact macOS spelling keeps the old prepared-file check");
        } else {
            assert!(outcome.unwrap_err().contains(diagnostic), "{path}");
        }
    }
    crate::path_safety::remove_directory_link(&source.join("selected"));
}

#[cfg(target_os = "macos")]
#[test]
fn runtime_project_code_proof_nonexact_macos_spelling_defers_without_live_file_authority() {
    let (_temp, source) = project("sha1");
    fs::write(source.join("vendor/Native"), "captured bytes").unwrap();
    let head = workspace::snapshot_repository(&source).unwrap();
    let mut expected = input(&source, "vendor/Native");
    expected[0].1 = "VENDOR/native".into();
    // Either kind of volume is permitted. No live lookup or name folding can
    // grant byte authority; regular prepared-path validation remains required.
    fs::remove_file(source.join("vendor/Native")).unwrap();
    verify_native_inputs(&source, &head, &expected).unwrap();
    assert!(!source.join("vendor/Native").exists());
    expected[0].2 = "0".repeat(40);
    verify_native_inputs(&source, &head, &expected).unwrap(); // explicitly deferred
    expected[0].1 = "vendor/Native".into();
    assert!(verify_native_inputs(&source, &head, &expected)
        .unwrap_err()
        .contains("differs from codeRef"));
}

#[cfg(windows)]
#[test]
fn runtime_project_code_proof_review_distinct_unicode_names_are_not_false_case_collisions() {
    let (_temp, source) = project("sha1");
    let latin = source.join("vendor/K");
    let kelvin = source.join("vendor/\u{212a}");
    fs::write(&latin, "Latin K native bytes").unwrap();
    fs::write(&kelvin, "Kelvin native bytes").unwrap();
    assert_ne!(
        fs::read(&latin).unwrap(),
        fs::read(&kelvin).unwrap(),
        "the volume must distinguish these names"
    );
    let head = workspace::snapshot_repository(&source).unwrap();
    verify_native_inputs(&source, &head, &input(&source, "vendor/K"))
        .expect("Unicode lowercase equivalence is not Windows file identity");
}

#[cfg(windows)]
#[test]
fn runtime_project_code_proof_review_unicode_lowercase_cannot_authorize_a_missing_path() {
    let (_temp, source) = project("sha1");
    fs::write(source.join("vendor/\u{212a}"), "equal bytes").unwrap();
    assert!(
        !source.join("vendor/K").exists(),
        "the volume distinguishes Kelvin from Latin K"
    );
    let mut expected = input(&source, "vendor/\u{212a}");
    expected[0].1 = "vendor/K".into();
    let head = workspace::snapshot_repository(&source).unwrap();
    let error = verify_native_inputs(&source, &head, &expected).expect_err(
        "a same-byte, lowercase-equivalent filename cannot supply missing native history",
    );
    assert!(error.contains("missing from codeRef"), "{error}");
}

#[cfg(windows)]
#[test]
fn runtime_project_code_proof_prefers_exact_names_and_requires_unambiguous_native_aliases() {
    let (_temp, source) = project("sha1");
    fs::write(source.join("vendor/Native"), "native bytes").unwrap();
    fs::write(source.join("vendor/É-native"), "accented bytes").unwrap();
    assert_eq!(
        fs::read(source.join("vendor/é-native")).unwrap(),
        b"accented bytes"
    );
    let head = workspace::snapshot_repository(&source).unwrap();
    let mut expected = input(&source, "vendor/Native");
    expected[0].1 = "VENDOR/native".into();
    verify_native_inputs(&source, &head, &expected).unwrap();
    let mut accented = input(&source, "vendor/É-native");
    accented[0].1 = "VENDOR/é-native".into();
    verify_native_inputs(&source, &head, &accented).unwrap();
    let shadow = workspace::shadow_repo_if_exists(&source).unwrap().unwrap();
    let duplicate = format!(
        "100644 blob {}\tNative\n100644 blob {}\tnative\n",
        expected[0].2, expected[0].2
    );
    let tree = workspace::git_bytes(
        &source,
        &["--git-dir", shadow.to_str().unwrap(), "mktree"],
        None,
        Some(duplicate.as_bytes()),
    )
    .unwrap();
    let tree = String::from_utf8(tree).unwrap().trim().to_string();
    let commit =
        workspace::repository_git(&source, &["commit-tree", &tree, "-m", "ambiguous fixture"])
            .unwrap();
    expected[0].1 = "Native".into();
    verify_native_inputs(&source, &commit, &expected).unwrap();
    expected[0].1 = "NATIVE".into();
    assert!(verify_native_inputs(&source, &commit, &expected)
        .unwrap_err()
        .contains("Ambiguous"));
}
