use super::*;
#[cfg(feature = "fixture")]
use crate::{
    model::*,
    runtime::{perform, Job, Runtime},
};
#[cfg(feature = "fixture")]
use tempfile::TempDir;

fn python() -> PathBuf {
    for program in if cfg!(windows) {
        vec!["python", "py"]
    } else {
        vec!["python3", "python"]
    } {
        if let Ok(output) = Command::new(program)
            .args(["-c", "import sys; print(sys.executable)"])
            .output()
        {
            if output.status.success() {
                return PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
            }
        }
    }
    panic!("Native Python required for environment acceptance");
}

fn shell() -> String {
    if cfg!(windows) {
        let output = Command::new("git").arg("--exec-path").output().unwrap();
        let path = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
        native::host_path(&path.ancestors().nth(3).unwrap().join("bin/bash.exe"))
            .to_string_lossy()
            .into()
    } else {
        "/bin/bash".into()
    }
}

fn policy() -> EnvironmentConfig {
    let python = python();
    EnvironmentConfig {
        mode: "native-workspace".into(),
        platform: platform().into(),
        arch: std::env::consts::ARCH.into(),
        scopes: vec![".env".into()],
        caches: vec![".cache".into()],
        layout: "fixed".into(),
        launch: LaunchConfig {
            entry: python.to_string_lossy().into(),
            path: vec![
                python.parent().unwrap().to_string_lossy().into(),
                Path::new(&shell())
                    .parent()
                    .unwrap()
                    .to_string_lossy()
                    .into(),
            ],
            shell: shell(),
            variables: BTreeMap::new(),
            inherit: vec![],
            hook: None,
            environment: None,
        },
        baseline: vec![python.to_string_lossy().into(), "--version".into()],
        initialize: vec![],
        import_source: false,
        launch_file: None,
        authority: BTreeMap::new(),
        allow_descendant: false,
        require: vec![],
        resources: None,
        discovery: false,
    }
}

#[cfg(feature = "fixture")]
fn graph(names: &[&str], edges: &[(&str, &str, bool)]) -> Graph {
    Graph {
        original_goal: "native environment test".into(),
        nodes: names
            .iter()
            .map(|name| Node {
                name: (*name).into(),
                task: (*name).into(),
            })
            .collect(),
        edges: edges
            .iter()
            .map(|(from, to, feedback)| Edge {
                from: (*from).into(),
                to: (*to).into(),
                feedback: *feedback,
            })
            .collect(),
    }
}

#[cfg(feature = "fixture")]
fn setup(graph: Graph, policy: EnvironmentConfig, body: &str) -> (TempDir, PathBuf, Runtime) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source 中文 space");
    fs::create_dir(&source).unwrap();
    fs::write(source.join(".gitignore"), ".env/\n.cache/\nordinary/\n").unwrap();
    fs::write(source.join("code.txt"), "current code").unwrap();
    if let Some(file) = &policy.launch_file {
        fs::write(
            source.join(file),
            serde_json::to_vec(&policy.launch).unwrap(),
        )
        .unwrap();
    }
    workspace::git(&source, &["init", "-q"]).unwrap();
    workspace::snapshot_repository(&source).unwrap();
    let script = temp.path().join("agent.mjs");
    let binding = native::host_path(&native::installation_root().join("engine/launch-binding.mjs"))
        .to_string_lossy()
        .replace('\\', "/");
    fs::write(&script, format!("import {{applyLaunchBinding}} from {}; import fs from 'node:fs'; applyLaunchBinding();\nlet task=''; for await (const chunk of process.stdin) task+=chunk; const name=process.env.GRAPHER_NODE_NAME;\nfs.mkdirSync('.env',{{recursive:true}}); let response='Completed';\n{body}\nconsole.log(JSON.stringify({{type:'message_end',message:{{role:'assistant',content:[{{type:'text',text:response}}]}}}}));", serde_json::to_string(&format!("file:///{binding}")).unwrap())).unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": source, "model": "local/test", "maxParallel": 4, "maxFeedback": 1,
        "engine": "pi", "piCommand": native::trusted_node().unwrap(), "piArgs": [script], "environment": policy,
    })).unwrap();
    let mut runtime = Runtime::open(&temp.path().join("data")).unwrap();
    runtime.create(graph, config).unwrap();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();
    (temp, source, runtime)
}

#[cfg(feature = "fixture")]
fn run(runtime: &mut Runtime, job: &Job) {
    let root = runtime.root.clone();
    let result = perform(
        job,
        &root,
        &[],
        |_| {},
        |head| {
            runtime.emit(EventKind::Prepared {
                execution_id: job.execution.id.clone(),
                head,
            })
        },
    );
    if let Err(error) = &result {
        panic!("{}: {error}", job.execution.node);
    }
    runtime.finish(&job.execution, result).unwrap();
    assert_eq!(
        runtime
            .state
            .executions
            .iter()
            .find(|e| e.id == job.execution.id)
            .unwrap()
            .status,
        "completed",
        "{:?}",
        runtime.state.nodes[&job.execution.node].error
    );
}

#[test]
fn history_scope_transition_is_checked_before_touching_code_or_partial_environment() {
    let temp = tempfile::tempdir().unwrap();
    let mut lazy = policy();
    lazy.discovery = true;
    lazy.scopes = vec![".venv".into(), ".agent-home".into()];
    let store = Environments::new(temp.path(), &Uuid::new_v4().to_string(), &lazy).unwrap();
    let empty = store.launch(&lazy.launch).unwrap();
    let mut previous = lazy.launch.clone();
    previous.environment = Some(crate::environment_discovery::Binding {
        kind: "venv".into(),
        prefix: "business-env".into(),
        abi: "0".repeat(40),
    });
    let custom = store.launch(&previous).unwrap();
    assert!(store
        .validate_history_scopes(&empty, &custom)
        .unwrap_err()
        .contains("refusing unsafe"));
    store.validate_history_scopes(&custom, &custom).unwrap();
    previous.environment.as_mut().unwrap().prefix = ".venv".into();
    store
        .validate_history_scopes(&empty, &store.launch(&previous).unwrap())
        .unwrap();
}

#[cfg(feature = "fixture")]
#[test]
fn empty_business_binding_keeps_ordinary_parallel_fanout_and_fanin_without_layout_blocking() {
    let mut lazy = policy();
    lazy.discovery = true;
    lazy.scopes = vec![".venv".into(), ".agent-home".into()];
    let (_temp, _source, mut runtime) = setup(
        graph(
            &["A", "B", "C", "M"],
            &[
                ("A", "B", false),
                ("A", "C", false),
                ("B", "M", false),
                ("C", "M", false),
            ],
        ),
        lazy,
        "",
    );
    let a = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &a);
    let jobs = runtime.jobs().unwrap();
    assert_eq!(jobs.len(), 2, "No global environment serialization");
    assert_ne!(jobs[0].execution.worktree, jobs[1].execution.worktree);
    for job in jobs {
        run(&mut runtime, &job);
    }
    let merge = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &merge);
    assert!(runtime
        .state
        .nodes
        .values()
        .all(|node| node.status == "done"));
    let config = runtime
        .state
        .config
        .as_ref()
        .unwrap()
        .environment
        .as_ref()
        .unwrap();
    let store = Environments::new(&runtime.root, &runtime.state.run_id, config).unwrap();
    let result = runtime.state.nodes["M"].result.as_ref().unwrap();
    assert!(store
        .load_launch(&result.launch_ref)
        .unwrap()
        .environment
        .is_none());
    assert!(!Path::new(&runtime.state.executions[0].worktree)
        .join(".venv")
        .exists());
}

#[cfg(feature = "fixture")]
#[test]
fn future_model_settings_never_clear_a_legacy_runs_frozen_policy_or_composite_references() {
    let (_temp, _source, mut runtime) = setup(
        graph(&["A"], &[]),
        policy(),
        "fs.writeFileSync('.env/package', 'installed');",
    );
    let job = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &job);
    let policy = runtime.state.config.as_ref().unwrap().environment.clone();
    let baseline = runtime.state.environment_baseline.clone();
    let result = runtime.state.nodes["A"].result.clone().unwrap();
    let input = runtime.state.executions[0].input.clone();
    let mut defaults = runtime.state.config.clone().unwrap();
    defaults.model = "local/future".into();
    runtime.save_default_config(&defaults).unwrap();
    assert_eq!(runtime.state.config.as_ref().unwrap().environment, policy);
    assert_eq!(runtime.state.nodes["A"].result.as_ref(), Some(&result));
    let root = runtime.root.clone();
    drop(runtime);
    let restored = Runtime::open(&root).unwrap();
    assert_eq!(restored.state.config.as_ref().unwrap().environment, policy);
    assert_eq!(restored.state.environment_baseline, baseline);
    assert_eq!(restored.state.nodes["A"].result.as_ref(), Some(&result));
    assert_eq!(restored.state.executions[0].input, input);
    assert_eq!(restored.state.executions[0].result.as_ref(), Some(&result));
    let defaults: Config =
        serde_json::from_slice(&fs::read(root.join("config.json")).unwrap()).unwrap();
    assert_eq!(defaults.model, "local/future");
    assert!(
        defaults.environment.is_none(),
        "New Runs must get backend admission, not a previous Run's policy"
    );
}

#[test]
fn admission_rejects_cross_domain_and_unverified_capabilities() {
    let config = policy();
    config.validate().unwrap();
    for requirement in [
        "namespace-layout",
        "system-snapshot",
        "cuda",
        "rocm",
        "mps",
        "reflink",
        "extended-metadata",
        "memory-quota",
    ] {
        let mut changed = config.clone();
        changed.require = vec![requirement.into()];
        assert!(changed.validate().unwrap_err().contains("not verified"));
    }
    let mut changed = config.clone();
    changed.platform = "another-os".into();
    assert!(changed.validate().unwrap_err().contains("architecture"));
    changed = config.clone();
    changed.arch = "another-arch".into();
    assert!(changed.validate().is_err());
    changed = config.clone();
    changed.scopes.push(".env/nested".into());
    assert!(changed.validate().unwrap_err().contains("Overlapping"));
    changed = config.clone();
    changed.scopes = vec!["../outside".into()];
    assert!(changed.validate().is_err());
    changed = config.clone();
    changed
        .launch
        .variables
        .insert("NODE_OPTIONS".into(), "bad".into());
    assert!(changed.validate().is_err());
    changed = config.clone();
    changed.import_source = true;
    assert!(changed.validate().is_err());
    changed = config;
    changed.mode = "linux-namespace".into();
    assert!(changed.validate().is_err());
    for name in [".GIT", ".grapher-worktrees/subtree"] {
        assert!(safe_relative(name).is_err());
    }
    if cfg!(windows) {
        for name in [".git.", "con.env", "nul", "com1/files"] {
            assert!(safe_relative(name).is_err());
        }
        let mut changed = policy();
        changed.caches = vec![".ENV/cache".into()];
        assert!(changed.validate().is_err());
    }
}

#[test]
fn opaque_versions_are_immutable_and_corruption_fails_before_materialization() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    workspace::git(&source, &["init", "-q"]).unwrap();
    fs::write(source.join("code"), "code").unwrap();
    workspace::snapshot_repository(&source).unwrap();
    let mut config = policy();
    config.layout = "relocatable".into();
    config.import_source = true;
    fs::create_dir(source.join(".env")).unwrap();
    fs::write(source.join(".env/package"), "v1").unwrap();
    let store = Environments::new(
        &temp.path().join("data"),
        &Uuid::new_v4().to_string(),
        &config,
    )
    .unwrap();
    let base = store.initialize(&source).unwrap();
    fs::write(source.join(".env/package"), "v2").unwrap();
    let e2 = store.capture(&source, &base.environment_ref).unwrap();
    assert_ne!(e2, base.environment_ref);
    assert!(store
        .files
        .descends_from(&e2, &base.environment_ref)
        .unwrap());
    let sibling = temp.path().join("sibling");
    fs::create_dir(&sibling).unwrap();
    workspace::git(&sibling, &["init", "-q"]).unwrap();
    store
        .files
        .materialize(&sibling, &[base.environment_ref.clone()], None, false)
        .unwrap();
    assert_eq!(
        fs::read_to_string(sibling.join(".env/package")).unwrap(),
        "v1"
    );
    fs::write(sibling.join(".env/package"), "sibling change").unwrap();
    assert_eq!(
        fs::read_to_string(source.join(".env/package")).unwrap(),
        "v2"
    );
    let blob = git2::Oid::hash_object(git2::ObjectType::Blob, b"v1")
        .unwrap()
        .to_string();
    fs::write(store.directory.join("files/blobs").join(blob), "damage").unwrap();
    assert!(store
        .files
        .materialize(&sibling, &[base.environment_ref], None, false)
        .unwrap_err()
        .contains("Damaged"));
    assert_eq!(
        fs::read_to_string(sibling.join(".env/package")).unwrap(),
        "sibling change"
    );
}

#[cfg(feature = "fixture")]
#[test]
fn native_chain_and_ancestor_followup_advance_current_el_not_history() {
    let (_temp, source, mut runtime) = setup(
        graph(&["A", "B", "C"], &[("A", "B", false), ("B", "C", false)]),
        policy(),
        r#"
const previous=fs.existsSync('.env/version')?fs.readFileSync('.env/version','utf8'):'';
if(name==='A' && !previous) fs.writeFileSync('.env/version','1');
else if(name==='B'){ if(previous!=='1') throw Error('wrong B environment'); fs.writeFileSync('.env/version','2'); }
else if(name==='C'){ if(previous!=='2') throw Error('wrong C environment'); fs.writeFileSync('.env/version','3'); fs.mkdirSync('ordinary',{recursive:true}); fs.writeFileSync('ordinary/result','C artifact'); }
else if(task.includes('rebuild after C')) { if(previous!=='4') throw Error('rebuild restored historical environment'); }
else { if(previous!=='3') throw Error('ancestor restored old environment'); fs.writeFileSync('.env/version','4'); }
fs.writeFileSync('.cache/runtime','cache should not fork E');
"#,
    );
    let a = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &a);
    let a0 = runtime.state.executions[0].result.clone().unwrap();
    let b = runtime.jobs().unwrap().remove(0);
    assert_eq!(a.execution.worktree, b.execution.worktree);
    run(&mut runtime, &b);
    let c = runtime.jobs().unwrap().remove(0);
    assert_eq!(b.execution.worktree, c.execution.worktree);
    run(&mut runtime, &c);
    let histories = runtime
        .state
        .executions
        .iter()
        .map(|e| e.result.clone().unwrap())
        .collect::<Vec<_>>();
    for name in ["A", "B", "C"] {
        assert_eq!(
            runtime.state.nodes[name].result.as_ref().unwrap(),
            &histories[2]
        );
    }
    assert_ne!(a0.environment_ref, histories[2].environment_ref);
    assert_eq!(
        a0.code_ref, histories[2].code_ref,
        "ignored environment changes do not force Git commits"
    );
    runtime
        .intervene("A", "continue A in current view")
        .unwrap();
    let a1 = runtime.jobs().unwrap().remove(0);
    assert_eq!(a.execution.worktree, a1.execution.worktree);
    assert_eq!(
        a1.environment_input.as_ref().unwrap().environment_ref,
        histories[2].environment_ref
    );
    assert_eq!(a1.execution.session_id, a.execution.session_id);
    run(&mut runtime, &a1);
    assert_eq!(
        fs::read_to_string(Path::new(&a1.execution.worktree).join("ordinary/result")).unwrap(),
        "C artifact"
    );
    for name in ["A", "B", "C"] {
        assert_eq!(runtime.state.nodes[name].status, "done");
        assert_eq!(
            runtime.state.nodes[name].result,
            runtime.state.executions.last().unwrap().result
        );
    }
    for (index, expected) in histories.iter().enumerate() {
        assert_eq!(
            runtime.state.executions[index].result.as_ref().unwrap(),
            expected
        );
    }
    assert!(runtime.jobs().unwrap().is_empty());
    let publication = runtime.state.publication.clone().unwrap();
    let head = crate::graph_merge::merge_graph_scoped(
        &source,
        &publication.heads,
        &policy().exclusions(),
        || Err("unexpected conflict".into()),
    )
    .unwrap();
    runtime
        .publish_workspace_files(&source, &publication.heads)
        .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted { head })
        .unwrap();
    assert!(runtime.state.published_result.is_some());
    assert!(
        !source.join(".env").exists(),
        "managed environment is delivered by reference, never copied to source"
    );
    runtime.cleanup_worktrees().unwrap();
    assert!(
        Path::new(&a.execution.worktree).exists(),
        "fixed published layout is retained"
    );
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(replay.nodes["A"].result, runtime.state.nodes["A"].result);
    assert_eq!(replay.executions[0].result.as_ref().unwrap(), &a0);
    fs::remove_dir_all(&a.execution.worktree).unwrap();
    runtime.intervene("A", "rebuild after C").unwrap();
    let rebuilt = runtime.jobs().unwrap().remove(0);
    assert_eq!(rebuilt.execution.worktree, a.execution.worktree);
    run(&mut runtime, &rebuilt);
    assert_eq!(
        fs::read_to_string(Path::new(&rebuilt.execution.worktree).join(".env/version")).unwrap(),
        "4"
    );
    assert_eq!(
        fs::read_to_string(Path::new(&rebuilt.execution.worktree).join("ordinary/result")).unwrap(),
        "C artifact"
    );
}

#[cfg(feature = "fixture")]
#[test]
fn fanout_private_c_input_is_not_b_upgrade_and_fanin_requires_authority() {
    for authority in [false, true] {
        let mut config = policy();
        config.layout = "relocatable".into();
        if authority {
            config.authority.insert("D".into(), "B".into());
        }
        let (_temp, _source, mut runtime) = setup(
            graph(
                &["A", "B", "C", "D"],
                &[
                    ("A", "B", false),
                    ("A", "C", false),
                    ("B", "D", false),
                    ("C", "D", false),
                ],
            ),
            config,
            r#"
if(name==='A') fs.writeFileSync('.env/version','1');
else if(name==='B' || name==='C') {
  if(fs.readFileSync('.env/version','utf8')!=='1') throw Error('sibling environment leaked');
  fs.writeFileSync('.env/version',name==='B'?'2':'3');
} else { if(fs.readFileSync('.env/version','utf8')!=='2') throw Error('authority not applied'); }
"#,
        );
        let a = runtime.jobs().unwrap().remove(0);
        run(&mut runtime, &a);
        let siblings = runtime.jobs().unwrap();
        assert_eq!(siblings.len(), 2);
        assert_ne!(
            siblings[0].execution.worktree,
            siblings[1].execution.worktree
        );
        assert_eq!(
            siblings[0]
                .environment_input
                .as_ref()
                .unwrap()
                .environment_ref,
            siblings[1]
                .environment_input
                .as_ref()
                .unwrap()
                .environment_ref
        );
        run(&mut runtime, &siblings[0]);
        run(&mut runtime, &siblings[1]);
        let b = runtime.state.nodes["B"].result.clone().unwrap();
        let jobs = runtime.jobs().unwrap();
        if authority {
            assert_eq!(jobs.len(), 1);
            assert_eq!(
                jobs[0].environment_input.as_ref().unwrap().environment_ref,
                b.environment_ref
            );
            assert_eq!(
                jobs[0].environment_input.as_ref().unwrap().selected_from,
                vec!["B"]
            );
            run(&mut runtime, &jobs[0]);
        } else {
            assert!(jobs.is_empty());
            assert!(runtime.state.nodes["D"]
                .error
                .as_ref()
                .unwrap()
                .contains("incompatible E/L"));
        }
        assert_eq!(
            fs::read_to_string(Path::new(&siblings[0].execution.worktree).join(".env/version"))
                .unwrap(),
            "2"
        );
    }
}

#[cfg(feature = "fixture")]
#[test]
fn fixed_fanout_blocks_only_missing_path_capability_not_global_parallelism() {
    let (_temp, _source, mut runtime) = setup(
        graph(&["A", "B", "C"], &[("A", "B", false), ("A", "C", false)]),
        policy(),
        "fs.writeFileSync('.env/version','1');",
    );
    let a = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &a);
    let next = runtime.jobs().unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].execution.worktree, a.execution.worktree);
    assert_eq!(runtime.state.nodes["C"].status, "blocked");
    assert!(runtime.state.nodes["C"]
        .error
        .as_ref()
        .unwrap()
        .contains("no silent"));
}

#[cfg(feature = "fixture")]
#[test]
fn cache_does_not_fork_environment_but_unknown_persistent_write_does() {
    let (_temp, _source, mut runtime) = setup(
        graph(&["A", "B", "C"], &[("A", "B", false), ("B", "C", false)]),
        policy(),
        r#"
if(name==='A') fs.writeFileSync('.env/package','dependency');
if(name==='B') fs.writeFileSync('.cache/bytecode','ephemeral');
if(name==='C') fs.writeFileSync('.env/unknown-config','must retain');
"#,
    );
    let a = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &a);
    let e1 = runtime.state.nodes["A"]
        .result
        .clone()
        .unwrap()
        .environment_ref;
    let b = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &b);
    assert_eq!(
        runtime.state.nodes["B"]
            .result
            .as_ref()
            .unwrap()
            .environment_ref,
        e1
    );
    let c = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &c);
    assert_ne!(
        runtime.state.nodes["C"]
            .result
            .as_ref()
            .unwrap()
            .environment_ref,
        e1
    );
}

#[cfg(feature = "fixture")]
#[test]
fn failure_retry_preserves_partial_environment_and_original_input() {
    let (_temp, _source, mut runtime) = setup(
        graph(&["A"], &[]),
        policy(),
        r#"
if(!fs.existsSync('.env/partial')){fs.writeFileSync('.env/partial','partially installed');process.exit(9);}
if(fs.readFileSync('.env/partial','utf8')!=='partially installed')throw Error('partial state lost');
fs.writeFileSync('.env/finished','finished');
"#,
    );
    let first = runtime.jobs().unwrap().remove(0);
    let root = runtime.root.clone();
    let result = perform(
        &first,
        &root,
        &[],
        |_| {},
        |head| {
            runtime.emit(EventKind::Prepared {
                execution_id: first.execution.id.clone(),
                head,
            })
        },
    );
    assert!(result.is_err());
    runtime.finish(&first.execution, result).unwrap();
    let input = runtime.state.executions[0].input.clone().unwrap();
    runtime
        .intervene("A", "retry keeping partial work")
        .unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.preserve_failed_environment);
    assert_eq!(first.execution.worktree, retry.execution.worktree);
    run(&mut runtime, &retry);
    assert_eq!(runtime.state.executions[0].input.as_ref().unwrap(), &input);
    assert_ne!(
        runtime.state.executions[1]
            .input
            .as_ref()
            .unwrap()
            .environment_ref,
        input.environment_ref
    );
}

#[test]
fn manifest_metadata_corruption_fails_before_overwriting_a_live_view() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    workspace::git(&source, &["init", "-q"]).unwrap();
    fs::create_dir(source.join(".env")).unwrap();
    fs::write(source.join(".env/package"), "immutable").unwrap();
    let mut config = policy();
    config.layout = "relocatable".into();
    config.import_source = true;
    let store = Environments::new(
        &temp.path().join("data"),
        &Uuid::new_v4().to_string(),
        &config,
    )
    .unwrap();
    let base = store.initialize(&source).unwrap();
    let manifest = store
        .directory
        .join("files/versions")
        .join(format!("{}.json", base.environment_ref));
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    value["entries"][".env/package"]["mode"] = serde_json::json!(123);
    fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    fs::write(source.join(".env/package"), "live partial work").unwrap();
    assert!(store
        .files
        .materialize(&source, &[base.environment_ref], None, false)
        .unwrap_err()
        .contains("Damaged"));
    assert_eq!(
        fs::read_to_string(source.join(".env/package")).unwrap(),
        "live partial work"
    );
}

#[cfg(feature = "fixture")]
#[test]
fn failed_native_initialization_retains_selection_and_partial_work_for_retry() {
    let mut config = policy();
    config.initialize = vec![native::trusted_node().unwrap().to_string_lossy().into(), "-e".into(),
        "const fs=require('fs'); fs.mkdirSync('.env',{recursive:true}); if(!fs.existsSync('.env/partial-init')){fs.writeFileSync('.env/partial-init','partial');process.exit(7)}; if(fs.readFileSync('.env/partial-init','utf8')!=='partial')process.exit(8);".into()];
    let (_temp, _source, mut runtime) = setup(graph(&["A"], &[]), config.clone(), "if(fs.readFileSync('.env/partial-init','utf8')!=='partial')throw Error('initializer partial lost');");
    let first = runtime.jobs().unwrap().remove(0);
    let root = runtime.root.clone();
    let result = perform(
        &first,
        &root,
        &[],
        |_| {},
        |head| {
            runtime.emit(EventKind::Prepared {
                execution_id: first.execution.id.clone(),
                head,
            })
        },
    );
    assert!(result.is_err());
    runtime.finish(&first.execution, result).unwrap();
    assert!(
        runtime.state.executions[0].input.is_none(),
        "Agent was never launched"
    );
    let selected = Environments::new(&root, &runtime.state.run_id, &config)
        .unwrap()
        .load_record(&first.execution.id, "selected")
        .unwrap();
    assert_eq!(
        selected.environment_ref,
        runtime
            .state
            .environment_baseline
            .as_ref()
            .unwrap()
            .environment_ref
    );
    runtime
        .intervene("A", "retry configured initialization")
        .unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.preserve_failed_environment);
    run(&mut runtime, &retry);
    assert_eq!(retry.execution.worktree, first.execution.worktree);
    assert_eq!(runtime.state.nodes["A"].status, "done");
}

#[cfg(feature = "fixture")]
#[test]
fn declared_launch_updates_are_versioned_but_temporary_exports_do_not_change_l() {
    let mut config = policy();
    config.launch_file = Some("launch.json".into());
    let (_temp, _source, mut runtime) = setup(
        graph(&["A", "B"], &[("A", "B", false)]),
        config.clone(),
        r#"
if(name==='A') { let launch=JSON.parse(fs.readFileSync('launch.json','utf8')); launch.variables.CURRENT_L='explicit'; fs.writeFileSync('launch.json',JSON.stringify(launch)); process.env.CURRENT_L='temporary'; }
else if(process.env.CURRENT_L!=='explicit') throw Error('downstream launch not bound');
"#,
    );
    // The predeclared policy is ordinary code, not an activation heuristic.
    let a = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &a);
    let a0 = runtime.state.executions[0].clone();
    assert_ne!(
        a0.input.as_ref().unwrap().launch_ref,
        a0.result.as_ref().unwrap().launch_ref
    );
    let b = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &b);
    assert_eq!(
        runtime.state.executions[1]
            .input
            .as_ref()
            .unwrap()
            .launch_ref,
        a0.result.as_ref().unwrap().launch_ref
    );
    assert_eq!(
        runtime.state.executions[1]
            .result
            .as_ref()
            .unwrap()
            .launch_ref,
        a0.result.as_ref().unwrap().launch_ref
    );
}

#[cfg(feature = "fixture")]
#[test]
fn feedback_pins_el_and_forks_only_the_owners_history() {
    let (_temp, _source, mut runtime) = setup(
        graph(&["A", "B"], &[("A", "B", false), ("B", "A", true)]),
        policy(),
        r#"
if(name==='A') { const repair=fs.existsSync('.env/version'); if(repair && fs.readFileSync('.env/version','utf8')!=='2')throw Error('feedback lost E2'); fs.writeFileSync('.env/version',repair?'3':'1'); }
else { const version=fs.readFileSync('.env/version','utf8'); if(version==='1'){fs.writeFileSync('.env/version','2');response='Review proof.\n<FEEDBACK>';} else {if(version!=='3')throw Error('repair environment not inherited');response='<ACCEPT>';}}
"#,
    );
    let history = |runtime: &Runtime, job: &Job, text: &str| {
        let directory = runtime.root.join("sessions").join(&job.execution.id);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(format!("test_{}.jsonl", job.execution.session_id)), format!("{}\n{}\n",
            serde_json::json!({"type":"session","version":3,"id":job.execution.session_id,"cwd":job.execution.worktree}),
            serde_json::json!({"type":"message","id":"user","parentId":null,"message":{"role":"user","content":text,"timestamp":job.execution.started_at}}))).unwrap();
    };
    let a = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &a);
    history(&runtime, &a, "OWNER PRIVATE HISTORY");
    let b = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &b);
    history(&runtime, &b, "REVIEW PRIVATE HISTORY");
    let b0 = runtime.state.executions[1].result.clone().unwrap();
    assert_eq!(runtime.state.pending_feedback.len(), 1);
    let repair = runtime.jobs().unwrap().remove(0);
    assert_eq!(repair.execution.worktree, b.execution.worktree);
    assert_eq!(
        repair.environment_input.as_ref().unwrap().environment_ref,
        b0.environment_ref
    );
    assert_eq!(repair.task, "Feedback from B:\nReview proof.");
    run(&mut runtime, &repair);
    let text = fs::read_to_string(
        runtime
            .root
            .join("sessions")
            .join(&repair.execution.id)
            .join(format!("grapher_{}.jsonl", repair.execution.session_id)),
    )
    .unwrap();
    assert!(text.contains("OWNER PRIVATE HISTORY"));
    assert!(!text.contains("REVIEW PRIVATE HISTORY"));
    assert_eq!(runtime.state.executions[1].result.as_ref().unwrap(), &b0);
    let verify = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &verify);
    assert_eq!(runtime.state.feedback_counts["B->A"], 1);
}

#[cfg(feature = "fixture")]
#[test]
fn stale_result_events_do_not_advance_current_aliases_or_stop_a_new_generation() {
    let (_temp, _source, mut runtime) = setup(
        graph(&["A"], &[]),
        policy(),
        "fs.writeFileSync('.env/package','v1');",
    );
    let job = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &job);
    let original = runtime.state.nodes["A"].result.clone().unwrap();
    let mut next = original.clone();
    next.generation = Uuid::new_v4().to_string();
    let descriptor = Environments::new(&runtime.root, &runtime.state.run_id, &policy())
        .unwrap()
        .descriptor(&runtime.state.run_id, &next)
        .unwrap();
    runtime
        .emit(EventKind::ResultExecutionStarted {
            input: next.clone(),
            args: vec!["entry-arg".into()],
        })
        .unwrap();
    let mut stale = descriptor.clone();
    stale.result = original.clone();
    runtime
        .emit(EventKind::ResultExecutionFinished { descriptor: stale })
        .unwrap();
    runtime
        .emit(EventKind::ResultExecutionFailed {
            generation: original.generation.clone(),
            error: "stale".into(),
        })
        .unwrap();
    assert_eq!(runtime.state.phase, "launching_result");
    assert_eq!(runtime.state.nodes["A"].result.as_ref().unwrap(), &original);
    runtime
        .emit(EventKind::ResultExecutionFinished { descriptor })
        .unwrap();
    assert_eq!(runtime.state.nodes["A"].result.as_ref().unwrap(), &next);
    assert_eq!(
        runtime.state.result_execution.as_ref().unwrap().args,
        vec!["entry-arg"]
    );
    assert_eq!(
        runtime.state.executions[0].result.as_ref().unwrap(),
        &original
    );
}

#[cfg(unix)]
#[test]
fn basic_environment_snapshot_restores_readonly_and_executable_modes() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    fs::create_dir(&root).unwrap();
    workspace::git(&root, &["init", "-q"]).unwrap();
    fs::create_dir(root.join(".env")).unwrap();
    for (name, mode) in [("readonly", 0o444), ("executable", 0o755)] {
        fs::write(root.join(".env").join(name), name).unwrap();
        fs::set_permissions(
            root.join(".env").join(name),
            fs::Permissions::from_mode(mode),
        )
        .unwrap();
    }
    let mut config = policy();
    config.import_source = true;
    config.layout = "relocatable".into();
    let store = Environments::new(
        &temp.path().join("data"),
        &Uuid::new_v4().to_string(),
        &config,
    )
    .unwrap();
    std::os::unix::fs::symlink("readonly", root.join(".env/link")).unwrap();
    fs::set_permissions(root.join(".env"), fs::Permissions::from_mode(0o555)).unwrap();
    let baseline = store.initialize(&root).unwrap();
    let target = temp.path().join("target");
    fs::create_dir(&target).unwrap();
    workspace::git(&target, &["init", "-q"]).unwrap();
    store
        .files
        .materialize(&target, &[baseline.environment_ref.clone()], None, false)
        .unwrap();
    store
        .files
        .materialize(&target, &[baseline.environment_ref], None, false)
        .unwrap();
    assert_eq!(
        fs::read_to_string(target.join(".env/link")).unwrap(),
        "readonly"
    );
    assert_eq!(
        fs::metadata(target.join(".env"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o555
    );
    fs::set_permissions(root.join(".env"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(target.join(".env"), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        fs::metadata(target.join(".env/readonly"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o444
    );
    assert_eq!(
        fs::metadata(target.join(".env/executable"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
}

#[cfg(feature = "fixture")]
#[test]
fn snapshot_then_transaction_failure_never_commits_half_a_composite_result() {
    let (_temp, _source, mut runtime) = setup(
        graph(&["A"], &[]),
        policy(),
        "fs.writeFileSync('.env/package','sealed bytes');",
    );
    let job = runtime.jobs().unwrap().remove(0);
    let root = runtime.root.clone();
    let result = perform(
        &job,
        &root,
        &[],
        |_| {},
        |head| {
            runtime.emit(EventKind::Prepared {
                execution_id: job.execution.id.clone(),
                head,
            })
        },
    )
    .unwrap();
    let db = rusqlite::Connection::open(root.join("events.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_finished BEFORE INSERT ON events WHEN NEW.kind='finished' BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    assert!(runtime.finish(&job.execution, Ok(result)).is_err());
    assert_eq!(runtime.state.nodes["A"].status, "running");
    assert!(runtime.state.nodes["A"].result.is_none());
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    assert!(replay.executions[0].result.is_none());
    assert!(replay.pending_feedback.is_empty());
    assert!(Environments::new(&root, &runtime.state.run_id, &policy())
        .unwrap()
        .load_record(&job.execution.id, "after")
        .is_ok());
    drop(db);
    let run = runtime.state.run_id.clone();
    drop(runtime);
    let recovered = Runtime::open(&root).unwrap();
    assert_eq!(recovered.state.run_id, run);
    assert_eq!(recovered.state.nodes["A"].status, "failed");
    assert!(recovered.state.executions[0].result.is_none());
}
