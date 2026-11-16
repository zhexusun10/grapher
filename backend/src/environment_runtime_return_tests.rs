use super::*;

fn returned(paths: &[&Path], roots: &[(&str, &Path)]) -> RuntimeEvidence {
    let files: BTreeMap<_, _> = paths
        .iter()
        .map(|path| (text(&canonical(path).unwrap()), blob(path)))
        .collect();
    let references: BTreeMap<_, _> = paths
        .iter()
        .map(|path| (text(path), text(&canonical(path).unwrap())))
        .collect();
    let proof = serde_json::json!({"schema":3,"files":files,"references":references});
    let mut output = MARKER.to_vec();
    output.extend_from_slice(&serde_json::to_vec(&proof).unwrap());
    output.extend_from_slice(b"\0legacy ABI\n");
    let (value, abi) = RuntimeEvidence::from_probe(&output, roots).unwrap();
    assert_eq!(abi, b"legacy ABI\n");
    value
}

#[test]
fn native_runtime_return_selectors_preserve_missing_roots_but_reject_external_retarget() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    let state = temp.path().join("S");
    let replacement = temp.path().join("replacement");
    for root in [&work, &state, &replacement] {
        fs::create_dir_all(root.join("env")).unwrap();
        fs::write(root.join("env/native"), "equal bytes").unwrap();
    }
    let w_alias = temp.path().join("W-selected");
    let s_alias = temp.path().join("S-selected");
    crate::path_safety::directory_link(&work.join("env"), &w_alias);
    crate::path_safety::directory_link(&state.join("env"), &s_alias);
    let evidence = returned(
        &[&w_alias.join("native"), &s_alias.join("native")],
        &[("workspace", &work), ("state", &state)],
    );
    let roots: BTreeMap<String, PathBuf> = BTreeMap::from([
        ("workspace".into(), work.clone()),
        ("state".into(), state.clone()),
    ]);
    let layouts = roots
        .keys()
        .map(|label| {
            (
                label.clone(),
                RootScope::normalized(vec!["env".into()], vec![]),
            )
        })
        .collect();
    let files = Files::environment(&temp.path().join("store"), &[], &[])
        .unwrap()
        .with_project_index(false);
    let version = uuid::Uuid::new_v4().to_string();
    files
        .capture_roots(&roots, &layouts, &version, &[])
        .unwrap();
    evidence
        .preflight(&files, &version, "state", &roots)
        .unwrap();
    crate::path_safety::remove_directory_link(&w_alias);
    crate::path_safety::directory_link(&replacement.join("env"), &w_alias);
    assert!(evidence.preflight(&files, &version, "state", &roots).is_err(),
        "an external selector returning to W must not be ignored just because its old owned target survives");
    crate::path_safety::remove_directory_link(&w_alias);
    crate::path_safety::directory_link(&work.join("env"), &w_alias);
    fs::remove_dir_all(&work).unwrap();
    fs::remove_dir_all(&state).unwrap();
    evidence
        .preflight(&files, &version, "state", &roots)
        .unwrap();
    assert!(
        !work.exists() && !state.exists(),
        "preflight cannot reconstruct its own evidence"
    );
    crate::path_safety::remove_directory_link(&s_alias);
    crate::path_safety::directory_link(&work.join("env"), &s_alias);
    assert!(
        evidence
            .preflight(&files, &version, "state", &roots)
            .is_err(),
        "same-named W bytes are not S authority"
    );
    crate::path_safety::remove_directory_link(&s_alias);
    crate::path_safety::directory_link(&state.join("env"), &s_alias);
    for root in roots.values() {
        fs::create_dir_all(root).unwrap();
    }
    files.materialize_roots(&roots, &version).unwrap();
    assert_eq!(
        fs::read_to_string(w_alias.join("native")).unwrap(),
        "equal bytes"
    );
    assert_eq!(
        fs::read_to_string(s_alias.join("native")).unwrap(),
        "equal bytes"
    );
    crate::path_safety::remove_directory_link(&w_alias);
    crate::path_safety::remove_directory_link(&s_alias);
}

#[test]
fn native_runtime_return_projection_uses_the_links_e_will_restore_not_obsolete_external_detours() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    fs::create_dir_all(work.join("env/real")).unwrap();
    fs::write(work.join("env/real/native"), "captured bytes").unwrap();
    let external = temp.path().join("external-detour");
    crate::path_safety::directory_link(&work.join("env/real"), &external);
    crate::path_safety::directory_link(&external, &work.join("env/alias"));
    let evidence = returned(&[&work.join("env/alias/native")], &[("workspace", &work)]);
    let roots = BTreeMap::from([("workspace".into(), work.clone())]);
    let layouts = BTreeMap::from([(
        "workspace".into(),
        RootScope::normalized(vec!["env".into()], vec![]),
    )]);
    let files = Files::environment(&temp.path().join("store"), &[], &[])
        .unwrap()
        .with_project_index(false);
    let version = uuid::Uuid::new_v4().to_string();
    files
        .capture_roots(&roots, &layouts, &version, &[])
        .unwrap();
    crate::path_safety::remove_directory_link(&external);
    assert!(canonical(&work.join("env/alias/native")).is_err());
    // E stores this as a root-relative internal link. Requiring the obsolete
    // external detour would reject a valid independent historical restoration.
    evidence
        .preflight(&files, &version, "workspace", &roots)
        .unwrap();
    crate::path_safety::remove_directory_link(&work.join("env/alias"));
    fs::remove_dir_all(&work).unwrap();
    evidence
        .preflight(&files, &version, "workspace", &roots)
        .unwrap();
    fs::create_dir(&work).unwrap();
    files.materialize_roots(&roots, &version).unwrap();
    assert_eq!(
        fs::read_to_string(work.join("env/alias/native")).unwrap(),
        "captured bytes"
    );
    crate::path_safety::remove_directory_link(&work.join("env/alias"));
}

#[test]
fn native_runtime_return_project_paths_remain_staged_and_caches_are_not_reconstructed() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    let state = temp.path().join("S");
    fs::create_dir_all(work.join("vendor")).unwrap();
    fs::create_dir_all(state.join("home/cache")).unwrap();
    fs::write(work.join("vendor/native"), "codeRef bytes").unwrap();
    fs::write(state.join("home/cache/native"), "cache bytes").unwrap();
    let alias = temp.path().join("project-alias");
    crate::path_safety::directory_link(&work.join("vendor"), &alias);
    let roots = BTreeMap::from([
        ("workspace".into(), work.clone()),
        ("state".into(), state.clone()),
    ]);
    let evidence = returned(
        &[&alias.join("native"), &state.join("home/cache/native")],
        &[("workspace", &work), ("state", &state)],
    );
    let files = Files::environment(&temp.path().join("store"), &[], &[])
        .unwrap()
        .with_project_index(false);
    let version = uuid::Uuid::new_v4().to_string();
    let layouts = BTreeMap::from([(
        "state".into(),
        RootScope::normalized(vec!["home".into()], vec!["home/cache".into()]),
    )]);
    files
        .capture_roots(
            &BTreeMap::from([("state".into(), state.clone())]),
            &layouts,
            &version,
            &[],
        )
        .unwrap();
    fs::remove_dir_all(&work).unwrap();
    evidence
        .preflight(&files, &version, "state", &roots)
        .unwrap();
    assert!(evidence
        .preflight_prepared(&files, &version, "state", &roots)
        .is_err());
    fs::create_dir_all(work.join("vendor")).unwrap();
    fs::write(work.join("vendor/native"), "codeRef bytes").unwrap();
    evidence
        .preflight_prepared(&files, &version, "state", &roots)
        .unwrap();
    fs::create_dir_all(work.join("other")).unwrap();
    fs::write(work.join("other/native"), "codeRef bytes").unwrap();
    crate::path_safety::remove_directory_link(&alias);
    crate::path_safety::directory_link(&work.join("other"), &alias);
    evidence
        .preflight(&files, &version, "state", &roots)
        .unwrap();
    assert!(evidence
        .preflight_prepared(&files, &version, "state", &roots)
        .unwrap_err()
        .contains("selector was redirected"));
    fs::remove_file(state.join("home/cache/native")).unwrap();
    assert!(evidence
        .preflight(&files, &version, "state", &roots)
        .is_err());
    crate::path_safety::remove_directory_link(&alias);
}

#[test]
fn native_runtime_return_projection_does_not_delay_known_external_failures_behind_project_code() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    let host = temp.path().join("host");
    let replacement = temp.path().join("replacement");
    fs::create_dir(&work).unwrap();
    for dir in [&host, &replacement] {
        fs::create_dir(dir).unwrap();
        fs::write(dir.join("native"), "equal bytes").unwrap();
    }
    let alias = temp.path().join("external-selector");
    crate::path_safety::directory_link(&host, &alias);
    crate::path_safety::directory_link(&alias, &work.join("project-link"));
    let evidence = returned(
        &[&work.join("project-link/native")],
        &[("workspace", &work)],
    );
    let files = Files::environment(&temp.path().join("store"), &[], &[]).unwrap();
    let version = uuid::Uuid::new_v4().to_string();
    files.capture_empty(&version).unwrap();
    let roots = BTreeMap::from([("workspace".into(), work.clone())]);
    crate::path_safety::remove_directory_link(&work.join("project-link"));
    fs::remove_dir(&work).unwrap();
    evidence
        .preflight(&files, &version, "state", &roots)
        .unwrap();
    crate::path_safety::remove_directory_link(&alias);
    crate::path_safety::directory_link(&replacement, &alias);
    assert!(
        evidence
            .preflight(&files, &version, "state", &roots)
            .unwrap_err()
            .contains("selector was redirected"),
        "project deferral must not drop the earlier external-continuation guarantee"
    );
    assert!(!work.exists());
    crate::path_safety::remove_directory_link(&alias);
}

#[cfg(unix)]
#[test]
fn native_runtime_return_projection_keeps_native_parent_and_cycle_semantics() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    fs::create_dir_all(work.join("env/step")).unwrap();
    fs::write(work.join("env/native"), "native bytes").unwrap();
    let alias = temp.path().join("selected");
    crate::path_safety::directory_link(&work.join("env/step"), &alias);
    let evidence = returned(&[&alias.join("../native")], &[("workspace", &work)]);
    let roots = BTreeMap::from([("workspace".into(), work.clone())]);
    let layouts = BTreeMap::from([(
        "workspace".into(),
        RootScope::normalized(vec!["env".into()], vec![]),
    )]);
    let files = Files::environment(&temp.path().join("store"), &[], &[])
        .unwrap()
        .with_project_index(false);
    let original = uuid::Uuid::new_v4().to_string();
    files
        .capture_roots(&roots, &layouts, &original, &[])
        .unwrap();
    fs::remove_dir(work.join("env/step")).unwrap();
    fs::write(work.join("env/step"), "not a directory").unwrap();
    evidence
        .preflight(&files, &original, "workspace", &roots)
        .unwrap();
    let changed = uuid::Uuid::new_v4().to_string();
    files
        .capture_roots(&roots, &layouts, &changed, &[original.clone()])
        .unwrap();
    assert!(
        evidence
            .preflight(&files, &changed, "workspace", &roots)
            .unwrap_err()
            .contains("non-directory"),
        "lexically collapsing '..' cannot skip the recorded component type"
    );
    crate::path_safety::remove_directory_link(&alias);
    let loop_link = temp.path().join("loop");
    crate::path_safety::directory_link(&loop_link, &alias);
    crate::path_safety::directory_link(&alias, &loop_link);
    assert!(evidence
        .preflight(&files, &original, "workspace", &roots)
        .unwrap_err()
        .contains("recovery bound"));
    crate::path_safety::remove_directory_link(&alias);
    crate::path_safety::remove_directory_link(&loop_link);
}

#[cfg(windows)]
#[test]
fn native_runtime_return_projection_keeps_win32_parent_semantics() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    fs::create_dir_all(work.join("env/step")).unwrap();
    fs::write(work.join("env/native"), "not selected by Win32").unwrap();
    fs::write(temp.path().join("native"), "selected by Win32").unwrap();
    let alias = temp.path().join("selected");
    crate::path_safety::directory_link(&work.join("env/step"), &alias);
    let requested = alias.join("../native");
    assert_eq!(fs::read_to_string(&requested).unwrap(), "selected by Win32");
    let evidence = returned(&[&requested], &[("workspace", &work)]);
    let files = Files::environment(&temp.path().join("store"), &[], &[]).unwrap();
    let version = uuid::Uuid::new_v4().to_string();
    files.capture_empty(&version).unwrap();
    crate::path_safety::remove_directory_link(&alias);
    assert_eq!(fs::read_to_string(&requested).unwrap(), "selected by Win32");
    evidence
        .preflight(
            &files,
            &version,
            "state",
            &BTreeMap::from([("workspace".into(), work)]),
        )
        .unwrap();
}

#[test]
fn native_runtime_return_projection_bounds_external_cycles() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    fs::create_dir_all(work.join("env")).unwrap();
    fs::write(work.join("env/native"), "native bytes").unwrap();
    let alias = temp.path().join("selected");
    crate::path_safety::directory_link(&work.join("env"), &alias);
    let evidence = returned(&[&alias.join("native")], &[("workspace", &work)]);
    let roots = BTreeMap::from([("workspace".into(), work)]);
    let layouts = BTreeMap::from([(
        "workspace".into(),
        RootScope::normalized(vec!["env".into()], vec![]),
    )]);
    let files = Files::environment(&temp.path().join("store"), &[], &[])
        .unwrap()
        .with_project_index(false);
    let version = uuid::Uuid::new_v4().to_string();
    files
        .capture_roots(&roots, &layouts, &version, &[])
        .unwrap();
    crate::path_safety::remove_directory_link(&alias);
    let loop_link = temp.path().join("loop");
    crate::path_safety::directory_link(&loop_link, &alias);
    crate::path_safety::directory_link(&alias, &loop_link);
    assert!(evidence
        .preflight(&files, &version, "workspace", &roots)
        .unwrap_err()
        .contains("recovery bound"));
    crate::path_safety::remove_directory_link(&alias);
    crate::path_safety::remove_directory_link(&loop_link);
}

#[test]
fn native_runtime_return_projection_cannot_borrow_a_live_link_missing_from_history() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    fs::create_dir_all(work.join("env/real")).unwrap();
    fs::write(work.join("env/real/native"), "native bytes").unwrap();
    let alias = work.join("env/selected");
    crate::path_safety::directory_link(&work.join("env/real"), &alias);
    let evidence = returned(&[&alias.join("native")], &[("workspace", &work)]);
    let roots = BTreeMap::from([("workspace".into(), work.clone())]);
    let layouts = BTreeMap::from([(
        "workspace".into(),
        RootScope::normalized(vec!["env".into()], vec![]),
    )]);
    let files = Files::environment(&temp.path().join("store"), &[], &[])
        .unwrap()
        .with_project_index(false);
    let complete = uuid::Uuid::new_v4().to_string();
    files
        .capture_roots(&roots, &layouts, &complete, &[])
        .unwrap();
    crate::path_safety::remove_directory_link(&alias);
    let missing_link = uuid::Uuid::new_v4().to_string();
    files
        .capture_roots(&roots, &layouts, &missing_link, &[complete.clone()])
        .unwrap();
    crate::path_safety::directory_link(&work.join("env/real"), &alias);
    let stored = fs::read(
        temp.path()
            .join("store/versions")
            .join(format!("{missing_link}.json")),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(alias.join("native")).unwrap(),
        "native bytes"
    );
    assert!(evidence
        .preflight(&files, &missing_link, "workspace", &roots)
        .unwrap_err()
        .contains("lacks a captured entry"));
    evidence
        .preflight(&files, &complete, "workspace", &roots)
        .unwrap();
    assert_eq!(
        fs::read(
            temp.path()
                .join("store/versions")
                .join(format!("{missing_link}.json"))
        )
        .unwrap(),
        stored
    );
    crate::path_safety::remove_directory_link(&alias);
}

#[test]
fn native_runtime_return_projection_requires_complete_metadata_and_preserves_schema_two_limits() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    fs::create_dir_all(work.join("env")).unwrap();
    fs::write(work.join("env/native"), "bytes").unwrap();
    let alias = temp.path().join("selected");
    crate::path_safety::directory_link(&work.join("env"), &alias);
    let latest = returned(&[&alias.join("native")], &[("workspace", &work)]);
    let mut value = serde_json::to_value(&latest).unwrap();
    value["selectors"] = serde_json::json!([]);
    assert!(serde_json::from_value::<RuntimeEvidence>(value.clone())
        .unwrap()
        .validate()
        .is_err());
    value["schema"] = 2.into();
    value.as_object_mut().unwrap().remove("externalSelectors");
    let old: RuntimeEvidence = serde_json::from_value(value).unwrap();
    old.validate().unwrap();
    let old_bytes = serde_json::to_vec(&old).unwrap();
    let roots = BTreeMap::from([("workspace".into(), work.clone())]);
    let layouts = BTreeMap::from([(
        "workspace".into(),
        RootScope::normalized(vec!["env".into()], vec![]),
    )]);
    let files = Files::environment(&temp.path().join("store"), &[], &[])
        .unwrap()
        .with_project_index(false);
    let version = uuid::Uuid::new_v4().to_string();
    files
        .capture_roots(&roots, &layouts, &version, &[])
        .unwrap();
    crate::path_safety::remove_directory_link(&alias);
    old.preflight(&files, &version, "workspace", &roots)
        .unwrap();
    assert!(latest
        .preflight(&files, &version, "workspace", &roots)
        .is_err());
    assert_eq!(serde_json::to_vec(&old).unwrap(), old_bytes);
}
