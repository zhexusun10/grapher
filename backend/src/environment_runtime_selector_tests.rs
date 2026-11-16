//! Actual venv regression: changing an external directory selector must fail
//! before recovery writes, without changing installed tools or historical L/E.
use super::*;

#[test]
fn rooted_runtime_external_selector_retarget_is_caught_before_restore() {
    let (temp, source, mut runtime) = setup(graph(&["A"], &[]), automatic(), "");
    let host_python = PathBuf::from(automatic().launch.entry);
    let alias = temp.path().join("selected-python");
    crate::path_safety::directory_link(host_python.parent().unwrap(), &alias);
    let bootstrap = alias.join(host_python.file_name().unwrap());
    let job = runtime.jobs().unwrap().remove(0);
    let data = runtime.root.clone();
    let outcome = perform(
        &job,
        &data,
        &[],
        |_| {},
        |head| {
            runtime.emit(EventKind::Prepared {
                execution_id: job.execution.id.clone(),
                head,
            })?;
            let env = store(&runtime);
            let path = Path::new(&job.execution.worktree);
            let input = env.load_record_metadata(&job.execution.id, "before")?;
            let state = env.state_root(path)?;
            let launch = env.load_launch(&input.launch_ref)?.expanded(path);
            let observer = crate::environment_discovery::context_with_source(
                path,
                Some(&state),
                Some(&source),
                &job.execution.id,
                &launch,
                &data.join("sessions").join(&job.execution.id),
                true,
            )?;
            let code = crate::environment_discovery::tool(vec![
                observer.to_string_lossy().into_owned(),
                "python".into(),
                bootstrap.to_string_lossy().into_owned(),
                "-m".into(),
                "venv".into(),
                "--copies".into(),
                "--without-pip".into(),
                path.join(".venv").to_string_lossy().into_owned(),
            ])?;
            if code != 0 {
                return Err(format!("native venv creation failed: {code}"));
            }
            Ok(())
        },
    );
    assert!(outcome.is_ok(), "{outcome:?}");
    runtime.finish(&job.execution, outcome).unwrap();
    let descriptor = publish(&mut runtime, &source);
    let result = runtime.state.nodes["A"].result.clone().unwrap();
    let env = store(&runtime);
    let path = Path::new(&job.execution.worktree);
    let state = env.state_root(path).unwrap();
    let launch = env.load_launch(&result.launch_ref).unwrap();
    let historical = serde_json::to_vec(&launch).unwrap();
    let cfg = fs::read_to_string(path.join(".venv/pyvenv.cfg"))
        .unwrap()
        .replace('\\', "/");
    let host_home = host_python.parent().unwrap().to_string_lossy().replace('\\', "/");
    let alias_home = alias.to_string_lossy().replace('\\', "/");
    assert!(cfg.contains(&alias_home) || cfg.contains(&host_home),
        "venv must retain a usable selected bootstrap home: {cfg}");
    env.preflight_history_result(path, &result, &result.launch_ref)
        .unwrap();
    fs::write(path.join("partial-code"), "retain W").unwrap();
    fs::create_dir_all(state.join(".agent-home")).unwrap();
    fs::write(state.join(".agent-home/partial"), "retain S").unwrap();
    let empty = temp.path().join("replacement-python");
    fs::create_dir(&empty).unwrap();
    crate::path_safety::remove_directory_link(&alias);
    crate::path_safety::directory_link(&empty, &alias);
    assert!(
        host_python.is_file(),
        "the original installed interpreter remains untouched"
    );
    assert!(
        env.validate_launch(path, &launch).is_err(),
        "the real interpreter no longer starts through that selector"
    );
    let preflight = env.preflight_history_result(path, &result, &result.launch_ref);
    assert!(
        preflight.is_err(),
        "preflight accepted a known-broken external selector"
    );
    assert!(env
        .prepare(
            path,
            &result,
            &Uuid::new_v4().to_string(),
            &result.code_ref,
            vec![],
            false,
            true
        )
        .is_err());
    assert_eq!(
        fs::read_to_string(path.join("partial-code")).unwrap(),
        "retain W"
    );
    assert_eq!(
        fs::read_to_string(state.join(".agent-home/partial")).unwrap(),
        "retain S"
    );
    crate::path_safety::remove_directory_link(&alias);
    crate::path_safety::directory_link(host_python.parent().unwrap(), &alias);
    fs::remove_dir_all(
        path.join(".venv")
            .join(if cfg!(windows) { "Scripts" } else { "bin" }),
    )
    .unwrap();
    // Checking external selectors must not require the recoverable interpreter
    // or its own prefix links to remain present in the current W.
    env.preflight_history_result(path, &result, &result.launch_ref)
        .unwrap();
    let restored = env
        .prepare(
            path,
            &result,
            &Uuid::new_v4().to_string(),
            &result.code_ref,
            vec![],
            false,
            true,
        )
        .unwrap();
    env.validate_launch(path, &env.load_launch(&restored.launch_ref).unwrap())
        .unwrap();
    assert_eq!(
        serde_json::to_vec(&env.load_launch(&result.launch_ref).unwrap()).unwrap(),
        historical
    );
    assert_eq!(runtime.state.nodes["A"].result.as_ref(), Some(&result));

    // Exercise both worker entry paths with W entirely absent. A known-broken
    // selector must not cause codeRef reconstruction or an S reset first.
    fs::create_dir_all(state.join(".agent-home")).unwrap();
    fs::write(state.join(".agent-home/partial"), "retain S without W").unwrap();
    fs::remove_dir_all(path).unwrap();
    crate::path_safety::remove_directory_link(&alias);
    crate::path_safety::directory_link(&empty, &alias);
    let publication = runtime.publication_environment_input().unwrap().unwrap();
    assert!(publication
        .descriptor(&descriptor.result.code_ref)
        .unwrap_err()
        .contains("selector"));
    let (entry, control) = runtime
        .start_result(&["-c".into(), "print('must not run')".into()])
        .unwrap();
    let outcome = perform_result(&entry, &control, |_| {
        panic!("bad selector cannot prepare a writer")
    });
    assert!(
        outcome.as_ref().unwrap_err().contains("selector"),
        "{outcome:?}"
    );
    assert!(runtime.finish_result(&entry, &control, outcome).is_err());
    assert!(
        !path.exists(),
        "known-bad selector was checked before reconstructing code"
    );
    assert_eq!(
        fs::read_to_string(state.join(".agent-home/partial")).unwrap(),
        "retain S without W"
    );
    assert_eq!(
        serde_json::to_vec(&env.load_launch(&result.launch_ref).unwrap()).unwrap(),
        historical
    );
    crate::path_safety::remove_directory_link(&alias);
}
