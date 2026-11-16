//! Actual production E capture/prepare with disposable W/S; no model, package
//! downloads, alternate publication path or claim of arbitrary venv relocation.
use super::tests::policy;
use super::*;

fn write(root: &Path, path: &str, bytes: &str) {
    fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
    fs::write(root.join(path), bytes).unwrap();
}

fn fixture() -> (tempfile::TempDir, Environments, PathBuf, CompositeResult) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir_all(&source).unwrap();
    workspace::git(&source, &["init", "-q"]).unwrap();
    write(&source, "business.txt", "code");
    let code = workspace::snapshot_repository(&source).unwrap();
    let run = Uuid::new_v4().to_string();
    let path = temp
        .path()
        .join(".grapher-worktrees")
        .join(&run)
        .join("node");
    workspace::prepare(&source, &path, &code, &[]).unwrap();
    let mut config = policy();
    config.discovery = true;
    config.scopes = vec!["shared-env".into(), ".agent-home".into()];
    config.caches = vec![".runtime-cache".into(), ".agent-home/cache".into()];
    config
        .launch
        .variables
        .insert("HOME".into(), "{state}/.agent-home".into());
    config.launch.owned_scopes = Some(vec![
        EnvironmentScope {
            root: "workspace".into(),
            path: "shared-env".into(),
        },
        EnvironmentScope {
            root: "workspace".into(),
            path: "absent-env".into(),
        },
        EnvironmentScope {
            root: "state".into(),
            path: "unbound-env".into(),
        },
    ]);
    let store = Environments::new(&temp.path().join("data"), &run, &config).unwrap();
    let baseline = store.initialize(&source).unwrap();
    let input = store
        .prepare(
            &path,
            &baseline,
            &Uuid::new_v4().to_string(),
            &code,
            vec![],
            false,
            false,
        )
        .unwrap();
    (temp, store, path, input)
}

fn record(store: &Environments, path: &Path, input: &CompositeResult) -> CompositeResult {
    let state = store.state_root(path).unwrap();
    write(path, "shared-env/value", "W recorded");
    write(&state, "shared-env/value", "S recorded");
    write(&state, "unbound-env/value", "inactive recorded");
    write(&state, ".agent-home/config", "business config");
    write(&state, ".agent-home/cache/value", "rebuildable cache");
    write(path, ".agent-home/authored", "ordinary W file");
    store.seal(path, input, &input.code_ref, vec![]).unwrap()
}

#[test]
fn rooted_sealing_unchanged_preparation_and_completion_do_not_grow_dependency_storage() {
    let (_temp, store, path, input) = fixture();
    let result = record(&store, &path, &input);
    let stored = || {
        ["blobs", "versions"]
            .into_iter()
            .flat_map(|name| {
                fs::read_dir(store.directory.join("files").join(name))
                    .unwrap()
                    .map(|entry| {
                        let path = entry.unwrap().path();
                        let bytes = fs::read(&path).unwrap();
                        (path, bytes)
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<BTreeMap<_, _>>()
    };
    let before = stored();
    for _ in 0..3 {
        let generation = Uuid::new_v4().to_string();
        let prepared = store
            .prepare(
                &path,
                &result,
                &generation,
                &result.code_ref,
                vec![],
                false,
                false,
            )
            .unwrap();
        let sealed = store
            .seal(&path, &prepared, &prepared.code_ref, vec![])
            .unwrap();
        assert_eq!(prepared.environment_ref, result.environment_ref);
        assert_eq!(sealed.environment_ref, result.environment_ref);
        // Execution evidence still appends even though E bytes are unchanged.
        assert_eq!(
            store
                .load_record_metadata(&generation, "before")
                .unwrap()
                .environment_ref,
            result.environment_ref
        );
        assert_eq!(
            store
                .load_record_metadata(&generation, "after")
                .unwrap()
                .environment_ref,
            result.environment_ref
        );
    }
    assert_eq!(stored(), before);
}

#[test]
fn rooted_history_restores_w_s_inactive_scopes_and_recorded_absence_not_live_names() {
    let (_temp, store, path, input) = fixture();
    let result = record(&store, &path, &input);
    let manifest = store
        .directory
        .join("files/versions")
        .join(format!("{}.json", result.environment_ref));
    let bytes = fs::read(&manifest).unwrap();
    let state = store.state_root(&path).unwrap();
    for root in [&path, &state] {
        write(root, "shared-env/value", "partial");
    }
    write(&state, "unbound-env/value", "partial inactive");
    write(&state, ".agent-home/config", "partial config");
    write(&state, ".agent-home/cache/value", "later cache");
    write(
        &path,
        "absent-env/later",
        "was absent in the recorded scope",
    );
    store
        .preflight_history_result(&path, &result, &result.launch_ref)
        .unwrap();
    let restored = store
        .prepare(
            &path,
            &result,
            &Uuid::new_v4().to_string(),
            &result.code_ref,
            vec![],
            false,
            true,
        )
        .unwrap();
    assert_eq!(
        fs::read_to_string(path.join("shared-env/value")).unwrap(),
        "W recorded"
    );
    assert_eq!(
        fs::read_to_string(state.join("shared-env/value")).unwrap(),
        "S recorded"
    );
    assert_eq!(
        fs::read_to_string(state.join("unbound-env/value")).unwrap(),
        "inactive recorded"
    );
    assert_eq!(
        fs::read_to_string(state.join(".agent-home/config")).unwrap(),
        "business config"
    );
    assert_eq!(
        fs::read_to_string(state.join(".agent-home/cache/value")).unwrap(),
        "later cache"
    );
    assert_eq!(
        fs::read_to_string(path.join(".agent-home/authored")).unwrap(),
        "ordinary W file"
    );
    assert_eq!(
        fs::read_to_string(path.join("business.txt")).unwrap(),
        "code"
    );
    assert!(!path.join("absent-env").exists());
    assert_eq!(fs::read(&manifest).unwrap(), bytes);
    assert_eq!(
        restored.environment_ref, result.environment_ref,
        "unchanged full-root bytes deduplicate without rewriting history"
    );
    assert!(store
        .load_launch(&restored.launch_ref)
        .unwrap()
        .environment
        .is_none());
    store
        .verify_view(&path, &restored.launch_ref, &restored.environment_ref)
        .unwrap();
}

#[test]
fn rooted_history_missing_w_blob_refuses_before_code_or_s_is_reset_and_does_not_repair() {
    let (_temp, store, path, input) = fixture();
    let result = record(&store, &path, &input);
    let version_path = store
        .directory
        .join("files/versions")
        .join(format!("{}.json", result.environment_ref));
    let manifest = fs::read(&version_path).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
    let blob = value["rooted"]["roots"]["workspace"]["entries"]["shared-env/value"]["blob"]
        .as_str()
        .unwrap();
    let blob = store.directory.join("files/blobs").join(blob);
    fs::remove_file(&blob).unwrap();
    let state = store.state_root(&path).unwrap();
    write(&path, "business.txt", "partial code");
    write(&path, "shared-env/value", "partial W");
    write(&state, "shared-env/value", "partial S");
    store.validate_result_metadata(&result).unwrap();
    let error = store
        .preflight_history_result(&path, &result, &result.launch_ref)
        .unwrap_err();
    assert!(error.contains("Missing workspace file blob"), "{error}");
    assert!(store
        .prepare(
            &path,
            &result,
            &Uuid::new_v4().to_string(),
            &result.code_ref,
            vec![],
            false,
            true
        )
        .is_err());
    assert_eq!(
        fs::read_to_string(path.join("business.txt")).unwrap(),
        "partial code"
    );
    assert_eq!(
        fs::read_to_string(path.join("shared-env/value")).unwrap(),
        "partial W"
    );
    assert_eq!(
        fs::read_to_string(state.join("shared-env/value")).unwrap(),
        "partial S"
    );
    assert!(!blob.exists());
    assert_eq!(fs::read(&version_path).unwrap(), manifest);
}

#[test]
fn rooted_history_skipped_destination_link_preserves_code_state_and_immutable_evidence() {
    let (temp, store, path, input) = fixture();
    let result = record(&store, &path, &input);
    let state = store.state_root(&path).unwrap();
    let manifest_path = store
        .directory
        .join("files/versions")
        .join(format!("{}.json", result.environment_ref));
    let manifest = fs::read(&manifest_path).unwrap();
    write(&path, "business.txt", "partial code");
    write(&state, "shared-env/value", "partial S");
    write(&state, ".agent-home/config", "partial HOME config");
    let destination = path.join("shared-env/value");
    fs::remove_file(&destination).unwrap();
    let unavailable = temp.path().join("unavailable-target");
    fs::create_dir(&unavailable).unwrap();
    crate::path_safety::directory_link(&unavailable, &destination);
    fs::remove_dir(&unavailable).unwrap();
    let error = store
        .preflight_history_result(&path, &result, &result.launch_ref)
        .unwrap_err();
    assert!(
        error.contains("untouched") && error.contains("shared-env/value"),
        "{error}"
    );
    assert!(store
        .prepare(
            &path,
            &result,
            &Uuid::new_v4().to_string(),
            &result.code_ref,
            vec![],
            false,
            true
        )
        .is_err());
    assert_eq!(
        fs::read_to_string(path.join("business.txt")).unwrap(),
        "partial code"
    );
    assert_eq!(
        fs::read_to_string(state.join("shared-env/value")).unwrap(),
        "partial S"
    );
    assert_eq!(
        fs::read_to_string(state.join(".agent-home/config")).unwrap(),
        "partial HOME config"
    );
    assert!(fs::symlink_metadata(&destination)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read(&manifest_path).unwrap(), manifest);
    store.validate_result(&result).unwrap();
}

#[test]
fn rooted_coverage_is_bound_to_launch_and_cannot_drop_unbound_other_root_ownership() {
    let (_temp, store, path, input) = fixture();
    let result = record(&store, &path, &input);
    let mut missing = store.load_launch(&result.launch_ref).unwrap();
    missing
        .owned_scopes
        .as_mut()
        .unwrap()
        .retain(|scope| scope.root != "workspace");
    let forged = CompositeResult {
        launch_ref: store.launch(&missing).unwrap(),
        ..result.clone()
    };
    assert!(store
        .validate_result_metadata(&forged)
        .unwrap_err()
        .contains("coverage differs"));
    let mut later = store.load_launch(&result.launch_ref).unwrap();
    later.owned_scopes.as_mut().unwrap().push(EnvironmentScope {
        root: "workspace".into(),
        path: "later-env".into(),
    });
    write(&path, "later-env/value", "not captured by selected history");
    let later = store.launch(&later).unwrap();
    let error = store
        .preflight_history_result(&path, &result, &later)
        .unwrap_err();
    assert!(error.contains("workspace:later-env"), "{error}");
    assert_eq!(
        fs::read_to_string(path.join("later-env/value")).unwrap(),
        "not captured by selected history"
    );
    store.validate_result(&result).unwrap();
}

#[test]
fn rooted_retry_keeps_partial_roots_without_changing_unbound_layout_rules() {
    let (_temp, store, path, input) = fixture();
    let result = record(&store, &path, &input);
    let state = store.state_root(&path).unwrap();
    write(&path, "shared-env/value", "partial W");
    write(&state, "shared-env/value", "partial S");
    let retry = store
        .prepare(
            &path,
            &result,
            &Uuid::new_v4().to_string(),
            &result.code_ref,
            vec![],
            true,
            false,
        )
        .unwrap();
    assert_ne!(retry.environment_ref, result.environment_ref);
    assert_eq!(
        fs::read_to_string(path.join("shared-env/value")).unwrap(),
        "partial W"
    );
    assert_eq!(
        fs::read_to_string(state.join("shared-env/value")).unwrap(),
        "partial S"
    );
    store
        .verify_view(&path, &retry.launch_ref, &retry.environment_ref)
        .unwrap();
    assert!(!store.requires_fixed_layout(&retry.launch_ref).unwrap());
    store.validate_result(&result).unwrap();
}
