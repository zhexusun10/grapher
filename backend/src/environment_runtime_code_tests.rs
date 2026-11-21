//! Native project bytes must be checked before a missing W is reconstructed.
use super::*;

#[test]
fn rooted_project_native_mismatch_is_rejected_before_missing_w_descriptor_reconstruction() {
    let (_temp, source, mut runtime) = setup(graph(&["A"], &[]), automatic_with_native_module(),
        "const {execFileSync}=await import('node:child_process');execFileSync('git',['add','--','vendor/native']);");
    let execution = runtime.jobs().unwrap().remove(0);
    run_created_at_with(
        &mut runtime,
        &execution,
        ".venv",
        false,
        install_project_native_input,
    );
    let descriptor = publish(&mut runtime, &source);
    let env = store(&runtime);
    let work = PathBuf::from(&descriptor.workspace);
    let state = env.state_root(&work).unwrap();
    let original = env.load_launch(&descriptor.result.launch_ref).unwrap();
    let historical_launch = serde_json::to_vec(&original).unwrap();
    let historical = runtime
        .state
        .executions
        .iter()
        .map(|e| e.result.clone())
        .collect::<Vec<_>>();
    // A new stale L models a native file/ABI recorded against different code.
    // Keep all historical records and machine-installed libraries untouched.
    let mut value = serde_json::to_value(&original).unwrap();
    let input = value["environment"]["runtimeEvidence"]["files"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|file| {
            file["root"] == "workspace"
                && file["path"]
                    .as_str()
                    .is_some_and(|path| path.starts_with("vendor/native/"))
        })
        .unwrap();
    input["blob"] = serde_json::Value::String("0".repeat(40));
    let stale = env.launch(&serde_json::from_value(value).unwrap()).unwrap();
    for schema in [1, 2] {
        let mut legacy = serde_json::to_value(&original).unwrap();
        let evidence = legacy["environment"]["runtimeEvidence"]
            .as_object_mut()
            .unwrap();
        evidence.insert("schema".into(), schema.into());
        let external = evidence.remove("externalSelectors").unwrap();
        if schema == 1 {
            evidence.remove("selectors");
        } else {
            evidence.insert("selectors".into(), external);
        }
        let legacy = CompositeResult {
            launch_ref: env
                .launch(&serde_json::from_value(legacy).unwrap())
                .unwrap(),
            ..descriptor.result.clone()
        };
        env.preflight_project_runtime_evidence(
            Path::new("missing source"),
            "missing codeRef",
            &legacy,
        )
        .unwrap();
    }
    fs::write(work.join("partial-code"), "keep W").unwrap();
    fs::create_dir_all(state.join(".agent-home")).unwrap();
    fs::write(state.join(".agent-home/partial"), "keep S").unwrap();
    let mut rewind = execution.clone();
    rewind.history_edit = true;
    rewind.execution.before = descriptor.result.code_ref.clone();
    rewind.environment_input = Some(CompositeResult {
        launch_ref: stale.clone(),
        ..descriptor.result.clone()
    });
    rewind.previous_environment_launch = Some(descriptor.result.launch_ref.clone());
    let error = perform(
        &rewind,
        &runtime.root,
        &[],
        |_| {},
        |_| panic!("bad history input cannot prepare a writer"),
    )
    .unwrap_err();
    assert!(error.contains("differs from codeRef"), "{error}");
    assert_eq!(
        fs::read_to_string(work.join("partial-code")).unwrap(),
        "keep W"
    );
    assert_eq!(
        fs::read_to_string(state.join(".agent-home/partial")).unwrap(),
        "keep S"
    );
    fs::remove_dir_all(&work).unwrap();
    let mut publication = runtime.publication_environment_input().unwrap().unwrap();
    publication.inputs[0].1.launch_ref = stale.clone();
    let error = publication
        .descriptor(&descriptor.result.code_ref)
        .unwrap_err();
    assert!(error.contains("native"), "{error}");
    assert!(
        !work.exists(),
        "project native mismatch was detected only after reconstructing W: {error}"
    );
    assert_eq!(
        fs::read_to_string(state.join(".agent-home/partial")).unwrap(),
        "keep S"
    );
    assert_eq!(
        serde_json::to_vec(&env.load_launch(&descriptor.result.launch_ref).unwrap()).unwrap(),
        historical_launch
    );
    assert_eq!(
        runtime
            .state
            .executions
            .iter()
            .map(|e| e.result.clone())
            .collect::<Vec<_>>(),
        historical
    );

    // Descriptor composition can select a NEW codeRef while retaining an
    // entry's environment. Check the code actually about to be installed.
    let native_name = fs::read_dir(source.join("vendor/native"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::write(
        &native_name,
        "new composition has incompatible native bytes",
    )
    .unwrap();
    let changed_code = workspace::snapshot_repository_scoped(
        &source,
        &env.exclusions(&descriptor.result.launch_ref).unwrap(),
    )
    .unwrap();
    assert_ne!(changed_code, descriptor.result.code_ref);
    let valid_publication = runtime.publication_environment_input().unwrap().unwrap();
    let error = valid_publication.descriptor(&changed_code).unwrap_err();
    assert!(error.contains("differs from codeRef"), "{error}");
    assert!(!work.exists());
    env.preflight_project_runtime_evidence(
        &source,
        &descriptor.result.code_ref,
        &descriptor.result,
    )
    .unwrap();

    let (mut entry, control) = runtime
        .start_result(&["-c".into(), "print('must not run')".into()])
        .unwrap();
    entry.fixture_environment_launch(stale);
    let outcome = perform_result(&entry, &control, |_| {
        panic!("bad code proof cannot prepare a writer")
    });
    assert!(outcome.is_err());
    assert!(runtime.finish_result(&entry, &control, outcome).is_err());
    assert!(!work.exists());
    assert_eq!(
        fs::read_to_string(state.join(".agent-home/partial")).unwrap(),
        "keep S"
    );
}
