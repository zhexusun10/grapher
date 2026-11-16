//! Real native modules loaded through an external alias back into W or S.
//! The explicit .pth install is fixture business configuration, never a Runtime
//! rewrite or a host toolchain import. No installed interpreter is modified.
use super::*;

#[test]
fn rooted_returning_native_selector_recovers_w_and_s_without_live_prefixes() {
    for workspace_owned in [true, false] {
        let (temp, source, mut runtime) = setup(graph(&["A"], &[]), automatic(), "");
        let alias = temp.path().join("selected-native");
        let captured = std::cell::RefCell::new(None);
        let job = runtime.jobs().unwrap().remove(0);
        run_created_at_with(&mut runtime, &job, ".venv", workspace_owned, |prefix, _| {
            let python = prefix.join(if cfg!(windows) {
                "Scripts/python.exe"
            } else {
                "bin/python"
            });
            let mut query = Command::new(python);
            query.args(["-I", "-B", "-c", "import _hashlib,json,sysconfig; print(json.dumps({'native':_hashlib.__file__,'site':sysconfig.get_path('purelib')}))"]);
            let info: serde_json::Value =
                serde_json::from_slice(&controlled_output(query)?).map_err(|e| e.to_string())?;
            let original = Path::new(info["native"].as_str().unwrap());
            let target = prefix.join("native-input");
            fs::create_dir(&target).map_err(|e| e.to_string())?;
            let module = target.join(original.file_name().unwrap());
            fs::copy(original, &module).map_err(|e| e.to_string())?;
            crate::path_safety::directory_link(&target, &alias);
            let literal =
                serde_json::to_string(&crate::native::host_path(&alias).to_string_lossy())
                    .unwrap()
                    .chars()
                    .map(|c| {
                        if c.is_ascii() {
                            c.to_string()
                        } else {
                            format!("\\U{:08x}", c as u32)
                        }
                    })
                    .collect::<String>();
            fs::write(
                Path::new(info["site"].as_str().unwrap()).join("selected-native.pth"),
                format!("import sys; sys.path.insert(0, {literal})\n"),
            )
            .map_err(|e| e.to_string())?;
            *captured.borrow_mut() = Some(module);
            Ok(())
        });
        let module = captured.into_inner().unwrap();
        let descriptor = publish(&mut runtime, &source);
        let work = PathBuf::from(&descriptor.workspace);
        let env = store(&runtime);
        let state = env.state_root(&work).unwrap();
        let launch = env.load_launch(&descriptor.result.launch_ref).unwrap();
        let evidence =
            serde_json::to_value(&launch.environment.as_ref().unwrap().runtime_evidence).unwrap();
        assert_eq!(evidence["schema"], 3);
        assert!(evidence["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["root"]
                == if workspace_owned {
                    "workspace"
                } else {
                    "state"
                }
                && file["path"]
                    .as_str()
                    .is_some_and(|path| path.starts_with(".venv/native-input/"))));
        let historical_launch = serde_json::to_vec(&launch).unwrap();
        let historical = runtime
            .state
            .executions
            .iter()
            .map(|execution| execution.result.clone())
            .collect::<Vec<_>>();
        env.preflight_history_result(&work, &descriptor.result, &descriptor.result.launch_ref)
            .unwrap();
        fs::write(work.join("partial-code"), "keep W").unwrap();
        fs::create_dir_all(state.join(".agent-home")).unwrap();
        fs::write(state.join(".agent-home/partial"), "keep S").unwrap();
        let replacement = temp.path().join("replacement-native");
        fs::create_dir(&replacement).unwrap();
        fs::copy(&module, replacement.join(module.file_name().unwrap())).unwrap();
        crate::path_safety::remove_directory_link(&alias);
        crate::path_safety::directory_link(&replacement, &alias);
        assert!(
            env.validate_launch(&work, &launch).is_err(),
            "the real ABI must reject a different native path, even with equal bytes"
        );
        assert!(env
            .preflight_history_result(&work, &descriptor.result, &descriptor.result.launch_ref)
            .unwrap_err()
            .contains("selector"));
        assert!(env
            .prepare(
                &work,
                &descriptor.result,
                &Uuid::new_v4().to_string(),
                &descriptor.result.code_ref,
                vec![],
                false,
                true
            )
            .is_err());
        assert!(
            module.is_file(),
            "the old canonical target survived the selector change"
        );
        assert_eq!(
            fs::read_to_string(work.join("partial-code")).unwrap(),
            "keep W"
        );
        assert_eq!(
            fs::read_to_string(state.join(".agent-home/partial")).unwrap(),
            "keep S"
        );

        fs::remove_dir_all(&work).unwrap();
        if !workspace_owned {
            fs::remove_dir_all(state.join(".venv")).unwrap();
        }
        let publication = runtime.publication_environment_input().unwrap().unwrap();
        assert!(publication
            .descriptor(&descriptor.result.code_ref)
            .unwrap_err()
            .contains("selector"));
        assert!(!work.exists());
        assert_eq!(
            fs::read_to_string(state.join(".agent-home/partial")).unwrap(),
            "keep S"
        );

        crate::path_safety::remove_directory_link(&alias);
        crate::path_safety::directory_link(module.parent().unwrap(), &alias);
        assert!(!module.exists());
        // Missing-W workers use this early phase before constructing the roots
        // required by the full filesystem materialization preflight.
        env.preflight_runtime_evidence(&work, &descriptor.result)
            .unwrap();
        assert!(!work.exists(), "projection cannot restore its own evidence");
        let args = vec!["-I".into(), "-B".into(), "-c".into(),
            "import ssl,_hashlib,pathlib,sys; assert pathlib.Path(_hashlib.__file__).resolve()==pathlib.Path(sys.prefix,'native-input',pathlib.Path(_hashlib.__file__).name).resolve(); print('restored-native')".into()];
        let (entry, control) = runtime.start_result(&args).unwrap();
        let outcome = perform_result(&entry, &control, |input| {
            runtime.emit(EventKind::ResultExecutionPrepared { input })
        });
        assert_eq!(
            runtime
                .finish_result(&entry, &control, outcome)
                .unwrap()
                .trim(),
            "restored-native"
        );
        drop(control);
        assert!(module.is_file());
        assert!(!state.join(".agent-home/partial").exists());
        assert_eq!(
            serde_json::to_vec(&env.load_launch(&descriptor.result.launch_ref).unwrap()).unwrap(),
            historical_launch
        );
        assert_eq!(
            runtime
                .state
                .executions
                .iter()
                .map(|execution| execution.result.clone())
                .collect::<Vec<_>>(),
            historical
        );
        assert!(!source.join(".venv").exists());
        // Successful result execution advances the current view; finish the
        // existing publication cycle before starting another result run.
        assert!(runtime.jobs().unwrap().is_empty());
        if runtime.state.publication.is_some() {
            publish(&mut runtime, &source);
        }
        assert_eq!(runtime.state.phase, "completed");
        // A separate failed result run must preserve partial state. Do this
        // after successful reconstruction; a failed-run retry is deliberately
        // not allowed to silently recreate a missing partial workspace.
        fs::create_dir_all(state.join(".agent-home")).unwrap();
        fs::write(state.join(".agent-home/partial"), "keep failed S").unwrap();
        fs::remove_dir_all(&work).unwrap();
        crate::path_safety::remove_directory_link(&alias);
        crate::path_safety::directory_link(&replacement, &alias);
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
        assert!(!work.exists());
        assert_eq!(
            fs::read_to_string(state.join(".agent-home/partial")).unwrap(),
            "keep failed S"
        );
        assert_eq!(
            runtime
                .state
                .executions
                .iter()
                .map(|execution| execution.result.clone())
                .collect::<Vec<_>>(),
            historical
        );
        crate::path_safety::remove_directory_link(&alias);
    }
}
