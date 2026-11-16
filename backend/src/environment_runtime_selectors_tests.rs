use super::*;

fn selected(paths: &[&Path], roots: &[(&str, &Path)]) -> RuntimeEvidence {
    let files: BTreeMap<_, _> = paths
        .iter()
        .map(|path| (text(&canonical(path).unwrap()), blob(path)))
        .collect();
    let references: BTreeMap<_, _> = paths
        .iter()
        .map(|path| (text(path), text(&canonical(path).unwrap())))
        .collect();
    let raw = serde_json::json!({"schema":2,"files":files,"references":references});
    let mut output = b"startup\n\xff".to_vec();
    output.extend_from_slice(MARKER);
    output.extend_from_slice(&serde_json::to_vec(&raw).unwrap());
    output.extend_from_slice(b"\0old ABI\n");
    let (evidence, abi) = RuntimeEvidence::from_probe(&output, roots).unwrap();
    assert_eq!(abi, b"startup\n\xffold ABI\n");
    assert_eq!(evidence.schema(), 2);
    evidence
}

#[test]
fn native_runtime_selectors_follow_external_chains_not_equal_replacement_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let a = temp.path().join("a");
    let b = temp.path().join("b");
    for path in [&a, &b] {
        fs::create_dir(path).unwrap();
        fs::write(path.join("native"), "equal bytes").unwrap();
    }
    let outer = temp.path().join("outer");
    let inner = temp.path().join("inner");
    crate::path_safety::directory_link(&a, &inner);
    crate::path_safety::directory_link(&inner, &outer);
    let evidence = selected(&[&outer.join("native")], &[]);
    let legacy = observed(&[&a.join("native")], &[]);
    let legacy_bytes = serde_json::to_vec(&legacy).unwrap();
    assert!(!serde_json::to_value(&legacy)
        .unwrap()
        .as_object()
        .unwrap()
        .contains_key("selectors"));
    let files = Files::environment(&temp.path().join("store"), &[], &[]).unwrap();
    let version = uuid::Uuid::new_v4().to_string();
    files.capture_empty(&version).unwrap();
    let check = |e: &RuntimeEvidence| e.preflight(&files, &version, "workspace", &BTreeMap::new());
    check(&evidence).unwrap();
    crate::path_safety::remove_directory_link(&inner);
    crate::path_safety::directory_link(&b, &inner);
    assert!(check(&evidence)
        .unwrap_err()
        .contains("selector was redirected"));
    check(&legacy).expect("schema 1 has no original-selector evidence; do not fabricate any");
    assert_eq!(serde_json::to_vec(&legacy).unwrap(), legacy_bytes);
    assert_eq!(fs::read_to_string(a.join("native")).unwrap(), "equal bytes");
    // Equivalent intermediate aliases are allowed: the original selector still
    // selects the same canonical file. We do not freeze link spelling/topology.
    let equivalent = temp.path().join("equivalent");
    crate::path_safety::directory_link(&a, &equivalent);
    crate::path_safety::remove_directory_link(&inner);
    crate::path_safety::directory_link(&equivalent, &inner);
    check(&evidence).unwrap();
    crate::path_safety::remove_directory_link(&outer);
    crate::path_safety::remove_directory_link(&inner);
    crate::path_safety::remove_directory_link(&equivalent);
}

#[test]
fn native_runtime_selectors_leave_owned_links_without_requiring_missing_w_or_s() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    let state = temp.path().join("S");
    let host = temp.path().join("host");
    let replacement = temp.path().join("replacement");
    for path in [&work, &state, &host, &replacement] {
        fs::create_dir(path).unwrap();
    }
    for path in [&host, &replacement] {
        fs::write(path.join("native"), "equal bytes").unwrap();
    }
    let external = temp.path().join("external-selector");
    let work_alias = temp.path().join("W-alias");
    crate::path_safety::directory_link(&host, &external);
    crate::path_safety::directory_link(&work, &work_alias);
    for root in [&work, &state] {
        crate::path_safety::directory_link(&external, &root.join("prefix"));
    }
    // This is a selector traversal fixture, not authority to snapshot an
    // external directory link as owned bytes. Only its external file is listed.
    let evidence = selected(
        &[
            &work_alias.join("prefix/native"),
            &state.join("prefix/native"),
        ],
        &[("workspace", &work_alias), ("state", &state)],
    );
    let files = Files::environment(&temp.path().join("store"), &[], &[]).unwrap();
    let version = uuid::Uuid::new_v4().to_string();
    files.capture_empty(&version).unwrap();
    for root in [&work, &state] {
        crate::path_safety::remove_directory_link(&root.join("prefix"));
        fs::remove_dir(root).unwrap();
    }
    let roots = BTreeMap::from([("workspace".into(), work), ("state".into(), state)]);
    evidence
        .preflight(&files, &version, "state", &roots)
        .unwrap();
    crate::path_safety::remove_directory_link(&external);
    crate::path_safety::directory_link(&replacement, &external);
    assert!(evidence
        .preflight(&files, &version, "state", &roots)
        .unwrap_err()
        .contains("selector was redirected"));
    assert!(roots.values().all(|root| !root.exists()));
    crate::path_safety::remove_directory_link(&work_alias);
    crate::path_safety::remove_directory_link(&external);
}

#[test]
fn native_runtime_selectors_reject_a_target_redirected_after_the_probe() {
    let temp = tempfile::tempdir().unwrap();
    let a = temp.path().join("a");
    let b = temp.path().join("b");
    for path in [&a, &b] {
        fs::create_dir(path).unwrap();
        fs::write(path.join("native"), "equal bytes").unwrap();
    }
    let recorded = text(&canonical(&a.join("native")).unwrap());
    let proof = serde_json::json!({"schema":2,
        "files":{recorded.clone():blob(&a.join("native"))},
        "references":{recorded.clone():recorded}});
    let mut output = MARKER.to_vec();
    output.extend_from_slice(&serde_json::to_vec(&proof).unwrap());
    output.extend_from_slice(b"\0old ABI\n");
    fs::rename(&a, temp.path().join("original-a")).unwrap();
    crate::path_safety::directory_link(&b, &a);
    assert!(RuntimeEvidence::from_probe(&output, &[])
        .unwrap_err()
        .contains("target changed during observation"));
    crate::path_safety::remove_directory_link(&a);
}

#[cfg(unix)]
#[test]
fn native_runtime_selectors_follow_relative_owned_interpreter_links() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    let host = temp.path().join("host");
    fs::create_dir_all(work.join("env/bin")).unwrap();
    fs::create_dir(&host).unwrap();
    fs::write(host.join("native"), "native bytes").unwrap();
    let alias = temp.path().join("selected-host");
    crate::path_safety::directory_link(&host, &alias);
    std::os::unix::fs::symlink("../../../selected-host/native", work.join("env/bin/python"))
        .unwrap();
    let evidence = selected(&[&work.join("env/bin/python")], &[("workspace", &work)]);
    let files = Files::environment(&temp.path().join("store"), &[], &[]).unwrap();
    let version = uuid::Uuid::new_v4().to_string();
    files.capture_empty(&version).unwrap();
    fs::remove_dir_all(&work).unwrap();
    evidence
        .preflight(
            &files,
            &version,
            "workspace",
            &BTreeMap::from([("workspace".into(), work)]),
        )
        .unwrap();
    crate::path_safety::remove_directory_link(&alias);
}

#[test]
fn native_runtime_selector_metadata_is_bounded_complete_and_validated_without_io() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("native");
    fs::write(&path, "input").unwrap();
    let evidence = selected(&[&path], &[]);
    let valid = serde_json::to_value(&evidence).unwrap();
    fs::remove_file(&path).unwrap();
    evidence.validate().unwrap(); // Metadata validation never resolves selectors.
    let selector = valid["selectors"][0].clone();
    for invalid in [
        serde_json::Value::Null,
        serde_json::json!([]),
        serde_json::json!([selector.clone(), selector.clone()]),
        serde_json::json!([{"path":"relative", "target":selector["target"]}]),
        serde_json::json!([{"path":selector["path"], "target":text(&temp.path().join("unobserved"))}]),
    ] {
        let mut value = valid.clone();
        value["selectors"] = invalid;
        assert!(serde_json::from_value::<RuntimeEvidence>(value)
            .unwrap()
            .validate()
            .is_err());
    }
    let mut stale = valid.clone();
    stale["schema"] = 1.into();
    assert!(serde_json::from_value::<RuntimeEvidence>(stale)
        .unwrap()
        .validate()
        .is_err());
    let mut huge = valid;
    huge["selectors"] = serde_json::json!(vec![selector; 129]);
    assert!(serde_json::from_value::<RuntimeEvidence>(huge)
        .unwrap()
        .validate()
        .is_err());
}

#[test]
fn native_runtime_selector_schema_preserves_abi_and_schema_one_startup() {
    use std::process::Command;
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    fs::create_dir(&work).unwrap();
    git2::Repository::init(&work).unwrap();
    let prefix = work.join("env");
    let mut create = Command::new(if cfg!(windows) { "python" } else { "python3" });
    create
        .args(["-m", "venv", "--copies", "--without-pip"])
        .arg(&prefix);
    crate::environment::controlled_output(create).unwrap();
    let roots = [("workspace", work.as_path())];
    let mut bindings = Vec::new();
    for schema in [None, Some(1), Some(2), Some(3)] {
        bindings.push(
            super::super::super::verify(&work, "workspace", "env", "venv", false, &roots, schema)
                .unwrap(),
        );
    }
    assert!(bindings.windows(2).all(|pair| pair[0].abi == pair[1].abi));
    let python = super::super::super::interpreter(&prefix, "venv");
    let mut launch = crate::environment_automatic::resolve(&work, false)
        .unwrap()
        .0
        .unwrap()
        .launch;
    launch.entry = text(&python);
    launch.path.insert(0, text(python.parent().unwrap()));
    for binding in bindings {
        launch.environment = Some(binding);
        let bytes = serde_json::to_vec(&launch).unwrap();
        super::super::super::validate_launch(&work, &launch, false).unwrap();
        assert_eq!(serde_json::to_vec(&launch).unwrap(), bytes);
    }
}
