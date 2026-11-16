//! Deterministic Runtime contracts with actual native venvs and tool receipts.
//! No added Agent instructions, package downloads or paid providers.
use super::tests::{graph, policy, run, setup, state_policy};
use super::*;
use crate::{
    model::*,
    runtime::{perform, perform_result, Job, Runtime},
};

#[path = "environment_runtime_code_tests.rs"]
mod rooted_runtime_code_tests;
#[path = "environment_runtime_return_native_tests.rs"]
mod rooted_runtime_return_native_tests;
#[path = "environment_runtime_selector_tests.rs"]
mod rooted_runtime_selector_tests;

fn automatic() -> EnvironmentConfig {
    let mut config = state_policy();
    config.discovery = true;
    config.best_effort = true;
    config.allow_descendant = true;
    config.scopes = vec![
        ".env".into(),
        ".venv".into(),
        ".environments".into(),
        ".agent-home".into(),
    ];
    config
}

fn store(runtime: &Runtime) -> Environments {
    Environments::new(
        &runtime.root,
        &runtime.state.run_id,
        runtime
            .state
            .config
            .as_ref()
            .unwrap()
            .environment
            .as_ref()
            .unwrap(),
    )
    .unwrap()
}

fn state_of(runtime: &Runtime, worktree: &str) -> PathBuf {
    store(runtime).state_root(Path::new(worktree)).unwrap()
}

// Exercise the native adapter at the owning writer's Prepared boundary. The
// fixture Agent does only its existing business task; Rust creates/observes E.
fn run_created(runtime: &mut Runtime, job: &Job, prefix: &str) {
    run_created_at(runtime, job, prefix, false);
}

fn run_created_at(runtime: &mut Runtime, job: &Job, prefix: &str, workspace_owned: bool) {
    run_created_at_with(runtime, job, prefix, workspace_owned, |_, _| Ok(()));
}

fn run_created_at_with(
    runtime: &mut Runtime,
    job: &Job,
    prefix: &str,
    workspace_owned: bool,
    configure: impl Fn(&Path, &Path) -> Result<(), String>,
) {
    let mut prepared = job.clone();
    if prepared.materialize_source {
        let exclusions = runtime.exclusions().unwrap();
        runtime
            .attach_job_source(&mut prepared, &exclusions)
            .unwrap();
    }
    let job = &prepared;
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
            })?;
            let env = store(runtime);
            let input = env.load_record_metadata(&job.execution.id, "before")?;
            let launch = env
                .load_launch(&input.launch_ref)?
                .expanded(Path::new(&job.execution.worktree));
            let session = root.join("sessions").join(&job.execution.id);
            let state = env.state_root(Path::new(&job.execution.worktree))?;
            let context = crate::environment_discovery::context_with_source(
                Path::new(&job.execution.worktree),
                Some(&state),
                Some(Path::new(
                    &runtime.state.config.as_ref().unwrap().repository,
                )),
                &job.execution.id,
                &launch,
                &session,
                true,
            )?;
            let venv = if workspace_owned {
                Path::new(&job.execution.worktree).join(prefix)
            } else {
                state.join(prefix)
            };
            assert!(!venv.exists(), "unportable input must not be copied");
            let bootstrap = automatic().launch.entry;
            let code = crate::environment_discovery::tool(vec![
                context.to_string_lossy().into(),
                "python".into(),
                bootstrap,
                "-m".into(),
                "venv".into(),
                "--without-pip".into(),
                venv.to_string_lossy().into(),
            ])?;
            if code != 0 {
                return Err(format!("native venv creation failed: {code}"));
            }
            fs::write(venv.join("marker"), &job.execution.node).map_err(|e| e.to_string())?;
            configure(&venv, Path::new(&job.execution.worktree))?;
            Ok(())
        },
    );
    assert!(result.is_ok(), "{:?}", result);
    runtime.finish(&job.execution, result).unwrap();
    assert_eq!(
        runtime.state.nodes[&job.execution.node].status, "completed",
        "{:?}",
        runtime.state.nodes[&job.execution.node].error
    );
}

// A genuine project-owned native dependency, not a copied HOME/toolchain.
// This fixture's explicit .pth installation is business configuration; Runtime
// never rewrites it or native binaries to pretend relocation is supported.
fn install_project_native_input(venv: &Path, work: &Path) -> Result<(), String> {
    let python = venv.join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    });
    let mut command = Command::new(python);
    command.args(["-I", "-B", "-c", "import _hashlib,json,sysconfig; print(json.dumps({'native':_hashlib.__file__,'site':sysconfig.get_path('purelib')}))"]);
    let output = controlled_output(command)?;
    let info: serde_json::Value = serde_json::from_slice(&output).map_err(|e| e.to_string())?;
    let native = Path::new(info["native"].as_str().ok_or("Missing native extension")?);
    let site = Path::new(info["site"].as_str().ok_or("Missing venv site directory")?);
    let vendor = work.join("vendor/native");
    fs::create_dir_all(&vendor).map_err(|e| e.to_string())?;
    fs::copy(
        native,
        vendor.join(
            native
                .file_name()
                .ok_or("Missing native extension filename")?,
        ),
    )
    .map_err(|e| e.to_string())?;
    let path = crate::native::host_path(&vendor)
        .to_string_lossy()
        .into_owned();
    let literal = serde_json::to_string(&path)
        .map_err(|e| e.to_string())?
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
        site.join("project-native.pth"),
        format!("import sys; sys.path.insert(0, {literal})\n"),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn publish(runtime: &mut Runtime, source: &Path) -> ResultDescriptor {
    assert!(runtime.jobs().unwrap().is_empty());
    let Some(publication) = runtime
        .state
        .publication
        .clone()
        .filter(|p| p.status == "publishing")
    else {
        assert_eq!(runtime.state.phase, "completed");
        return runtime.result_descriptor().unwrap();
    };
    let head = crate::graph_merge::merge_graph_scoped(
        source,
        &publication.heads,
        &runtime.exclusions().unwrap(),
        |_| Err("unexpected Git conflict".into()),
    )
    .unwrap();
    let job = runtime.publication_environment_input().unwrap().unwrap();
    job.validate().unwrap();
    let descriptor = job.descriptor(&head).unwrap();
    // The descriptor seals the composed publication; use its code reference as
    // the published head so the result and the head describe the same commit.
    let published_head = descriptor.result.code_ref.clone();
    runtime
        .emit(EventKind::ResultPublished { descriptor })
        .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted {
            head: published_head,
        })
        .unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "completed");
    runtime.result_descriptor().unwrap()
}

#[test]
fn unbound_dual_root_ownership_excludes_environments_without_hiding_project_files() {
    let (_temp, _source, mut runtime) = setup(
        graph(&["A"], &[]),
        automatic(),
        r#"
for (const name of ['env-a','env-b']) {
  fs.mkdirSync(name,{recursive:true});
  fs.writeFileSync(name+'/pyvenv.cfg','home = native-python\n');
  fs.writeFileSync(name+'/marker',name);
}
const state=process.env.GTEST_STATE;
for (const name of ['env-a','state-only']) {
  fs.mkdirSync(state+'/'+name,{recursive:true});
  fs.writeFileSync(state+'/'+name+'/pyvenv.cfg','home = native-python\n');
  fs.writeFileSync(state+'/'+name+'/marker','state');
}
for (const name of ['state-only','.agent-home']) {
  fs.mkdirSync(name,{recursive:true});
  fs.writeFileSync(name+'/authored.txt','project');
}
fs.writeFileSync('code.txt','business-code');
"#,
    );
    let job = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &job);
    let env = store(&runtime);
    let result = runtime.state.nodes["A"].result.as_ref().unwrap();
    let launch = env.load_launch(&result.launch_ref).unwrap();
    assert!(
        launch.environment.is_none(),
        "metadata alone must not activate an interpreter"
    );
    let scopes = launch.owned_scopes.as_ref().unwrap();
    assert!(launch.managed_scopes.is_empty());
    for (root, path) in [
        ("workspace", "env-a"),
        ("workspace", "env-b"),
        ("state", "env-a"),
        ("state", "state-only"),
    ] {
        assert!(scopes.contains(&EnvironmentScope {
            root: root.into(),
            path: path.into()
        }));
    }
    assert_eq!(
        env.exclusions(&result.launch_ref).unwrap(),
        vec!["env-a", "env-b"]
    );
    let tree = workspace::git(
        Path::new(&job.execution.worktree),
        &["ls-tree", "-r", "--name-only", &result.code_ref],
    )
    .unwrap();
    assert!(!tree.contains("env-a/"), "{tree}");
    assert!(!tree.contains("env-b/"), "{tree}");
    assert!(tree.contains("state-only/authored.txt"), "{tree}");
    assert!(tree.contains(".agent-home/authored.txt"), "{tree}");
    for name in ["env-a", "env-b"] {
        assert!(Path::new(&job.execution.worktree)
            .join(name)
            .join("marker")
            .is_file());
    }
    env.verify_view(
        Path::new(&job.execution.worktree),
        &result.launch_ref,
        &result.environment_ref,
    )
    .unwrap();

    // A later failed activation retains the same ownership, even though no
    // active binding remains. It must not reinterpret state paths as project paths.
    let mut bound = launch;
    bound.environment = Some(crate::environment_discovery::Binding {
        kind: "venv".into(),
        prefix: "env-a".into(),
        abi: "0".repeat(40),
        root: Some("workspace".into()),
        runtime_evidence: Some(super::tests::metadata_runtime_evidence(Path::new(
            &job.execution.worktree,
        ))),
    });
    let input = CompositeResult {
        launch_ref: env.launch(&bound).unwrap(),
        ..result.clone()
    };
    let next = env
        .discover(
            Path::new(&job.execution.worktree),
            &input,
            &runtime.root.join("empty-session"),
        )
        .unwrap();
    assert!(env
        .load_launch(&next.launch_ref)
        .unwrap()
        .environment
        .is_none());
    assert_eq!(
        env.exclusions(&next.launch_ref).unwrap(),
        vec!["env-a", "env-b"]
    );
}

#[test]
fn root_qualified_scopes_keep_state_names_out_of_project_capture_and_survive_local_unbinding() {
    let temp = tempfile::tempdir().unwrap();
    let mut config = automatic();
    config.launch.owned_scopes = Some(vec![]);
    let env = Environments::new(
        &temp.path().join("data"),
        &Uuid::new_v4().to_string(),
        &config,
    )
    .unwrap();
    let project = temp.path().join("source");
    fs::create_dir_all(&project).unwrap();
    workspace::git(&project, &["init", "-q"]).unwrap();
    let baseline = env.initialize(&project).unwrap();
    let mut launch = config.launch.clone();
    launch.owned_scopes = Some(vec![
        EnvironmentScope {
            root: "workspace".into(),
            path: "business-env".into(),
        },
        EnvironmentScope {
            root: "state".into(),
            path: "state-only".into(),
        },
    ]);
    launch.environment = Some(crate::environment_discovery::Binding {
        kind: "venv".into(),
        prefix: "business-env".into(),
        abi: "0".repeat(40),
        root: Some("workspace".into()),
        runtime_evidence: Some(super::tests::metadata_runtime_evidence(&project)),
    });
    let reference = env.launch(&launch).unwrap();
    assert_eq!(env.exclusions(&reference).unwrap(), vec!["business-env"]);
    assert_eq!(env.scope_paths(&reference).unwrap(), vec!["business-env"]);
    let slot = temp.path().join("current-slot");
    fs::create_dir(&slot).unwrap();
    let spelling = temp
        .path()
        .join(".")
        .join("current-slot")
        .to_string_lossy()
        .into_owned();
    let current = CompositeResult {
        launch_ref: reference,
        layout: Some(spelling),
        ..baseline.clone()
    };
    let selected = env
        .select_for_workspace(
            "next",
            &[("parent".into(), baseline.clone())],
            &slot.to_string_lossy(),
            &baseline,
            Some(&current),
        )
        .unwrap();
    assert!(env
        .load_launch(&selected.launch_ref)
        .unwrap()
        .environment
        .is_none());
    assert_eq!(
        env.exclusions(&selected.launch_ref).unwrap(),
        vec!["business-env"]
    );
    let state_scopes = env.scope_paths(&selected.launch_ref).unwrap();
    assert!(state_scopes.contains(&"state-only".into()));
    assert!(!state_scopes.contains(&"business-env".into()));
    let sibling = env
        .select_for_workspace(
            "sibling",
            &[("parent".into(), current.clone())],
            "other-slot",
            &baseline,
            Some(&current),
        )
        .unwrap();
    assert!(
        env.exclusions(&sibling.launch_ref).unwrap().is_empty(),
        "a sibling must not inherit physical-slot ownership"
    );
}

#[test]
fn retained_slot_ownership_cannot_be_inherited_from_invalid_current_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let mut config = automatic();
    config.launch.owned_scopes = Some(vec![]);
    let env = Environments::new(
        &temp.path().join("data"),
        &Uuid::new_v4().to_string(),
        &config,
    )
    .unwrap();
    let project = temp.path().join("source");
    fs::create_dir_all(&project).unwrap();
    workspace::git(&project, &["init", "-q"]).unwrap();
    let baseline = env.initialize(&project).unwrap();
    let mut launch = config.launch.clone();
    launch.owned_scopes = Some(vec![EnvironmentScope {
        root: "workspace".into(),
        path: "owned-env".into(),
    }]);
    let current = CompositeResult {
        layout: Some(temp.path().join("slot").to_string_lossy().into()),
        launch_ref: env.launch(&launch).unwrap(),
        ..baseline.clone()
    };
    let inputs = vec![("parent".into(), baseline.clone())];
    let path = current.layout.as_deref().unwrap();
    env.select_for_workspace("next", &inputs, path, &baseline, Some(&current))
        .unwrap();
    let mut foreign = current.clone();
    foreign.domain.baseline = "foreign-baseline".into();
    assert!(env
        .select_for_workspace("next", &inputs, path, &baseline, Some(&foreign))
        .is_err());
    let mut missing = current.clone();
    missing.environment_ref = Uuid::new_v4().to_string();
    assert!(env
        .select_for_workspace("next", &inputs, path, &baseline, Some(&missing))
        .is_err());
    assert_eq!(env.load_launch(&current.launch_ref).unwrap(), launch);
}

#[test]
fn root_qualified_discovery_refuses_to_hide_authored_tracked_environment_files() {
    let temp = tempfile::tempdir().unwrap();
    let config = automatic();
    let env = Environments::new(
        &temp.path().join("data"),
        &Uuid::new_v4().to_string(),
        &config,
    )
    .unwrap();
    let project = temp.path().join(".grapher-worktrees/ownership/slot");
    fs::create_dir_all(project.join("authored-env")).unwrap();
    git2::Repository::init(&project).unwrap();
    fs::write(
        project.join("authored-env/pyvenv.cfg"),
        "home = native-python\n",
    )
    .unwrap();
    workspace::project_git(&project, &["add", "authored-env/pyvenv.cfg"]).unwrap();
    let baseline = env.initialize(&project).unwrap();
    let error = env
        .discover(&project, &baseline, &temp.path().join("session"))
        .unwrap_err();
    assert!(error.contains("authored-env/pyvenv.cfg"), "{error}");
    assert!(project.join("authored-env/pyvenv.cfg").is_file());
}

#[test]
fn publication_still_refuses_a_live_writer() {
    let (_temp, _source, mut runtime) = setup(graph(&["A"], &[]), automatic(), "");
    let job = runtime.jobs().unwrap().remove(0);
    run_created(&mut runtime, &job, ".venv");
    let input = runtime.state.nodes["A"].result.clone().unwrap();
    runtime
        .emit(EventKind::ResultExecutionStarted {
            input,
            args: Vec::new(),
        })
        .unwrap();
    assert!(runtime.publication_live_writer().unwrap().is_some());
}

#[test]
fn unavailable_result_descriptor_does_not_block_code_publication() {
    let (_temp, source, mut runtime) = setup(graph(&["A"], &[]), automatic(), "");
    let job = runtime.jobs().unwrap().remove(0);
    run_created(&mut runtime, &job, ".venv");
    assert!(runtime.jobs().unwrap().is_empty());
    fs::remove_file(state_of(&runtime, &job.execution.worktree).join(".venv/marker")).unwrap();
    let publication = runtime.state.publication.clone().unwrap();
    let head = crate::graph_merge::merge_graph_scoped(
        &source,
        &publication.heads,
        &runtime.exclusions().unwrap(),
        |_| Err("unexpected Git conflict".into()),
    )
    .unwrap();
    runtime
        .emit(EventKind::PublicationCompleted { head })
        .unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "completed");
    assert!(runtime.state.published_result.is_none());
    assert!(runtime.result_descriptor().is_err());
}

#[test]
fn best_effort_bound_fanout_is_parallel_and_custom_prefixes_never_enter_git() {
    let (_temp, source, mut runtime) = setup(
        graph(&["A", "B", "C", "D"], &[("A", "B", false), ("A", "C", false),
            ("B", "D", false), ("C", "D", false)]), automatic(),
        "const state=process.env.GTEST_STATE; if(name==='C') { if(fs.existsSync(state+'/business-env')) throw Error('fixed environment was copied'); }\nif(name==='B') fs.writeFileSync(state+'/business-env/marker','B');\nif(name==='D' && fs.readFileSync(state+'/business-env/marker','utf8')!=='B') throw Error('local input was not inherited');\nfs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/'+name+'.txt',name);",
    );
    let a = runtime.jobs().unwrap().remove(0);
    run_created(&mut runtime, &a, "business-env");
    let historical = runtime.state.executions[0].result.clone().unwrap();
    let branches = runtime.jobs().unwrap();
    assert_eq!(branches.len(), 2);
    assert_ne!(
        branches[0].execution.worktree,
        branches[1].execution.worktree
    );
    assert!(
        branches
            .iter()
            .all(|branch| branch.execution.worktree != a.execution.worktree),
        "parallel children retain independent slots while the parent is unpublished"
    );
    for branch in &branches {
        let input = branch.environment_input.as_ref().unwrap();
        let bound = store(&runtime)
            .load_launch(&input.launch_ref)
            .unwrap()
            .environment
            .is_some();
        assert!(
            !bound,
            "a fixed environment cannot move to either fresh branch"
        );
        assert_eq!(
            input.inheritance.as_ref().unwrap().reason,
            "fixed-layout-not-reusable"
        );
    }
    // B provisions its own environment; C remains an ordinary report task.
    run_created(&mut runtime, &branches[0], "business-env");
    run(&mut runtime, &branches[1]);
    let d = runtime.jobs().unwrap().remove(0);
    assert_eq!(d.execution.worktree, branches[0].execution.worktree);
    assert_eq!(
        d.environment_input.as_ref().unwrap().selected_from,
        vec!["B", "C"]
    );
    run(&mut runtime, &d);
    let descriptor = publish(&mut runtime, &source);
    assert_eq!(descriptor.schema, 2);
    assert_eq!(descriptor.default_entry.as_deref(), Some("D"));
    assert!(runtime.state.mergers.is_empty());
    assert_eq!(
        runtime.state.executions[0].result.as_ref(),
        Some(&historical)
    );
    assert_eq!(
        store(&runtime)
            .load_record(&a.execution.id, "after")
            .unwrap(),
        historical
    );
    let tracked = workspace::git(&source, &["ls-files"]).unwrap();
    assert!(!tracked.contains("business-env"));
    assert!(source.join("reports/C.txt").is_file());
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(
        replay.executions[1].input.as_ref().unwrap().inheritance,
        runtime.state.executions[1]
            .input
            .as_ref()
            .unwrap()
            .inheritance
    );
    runtime.intervene("A", "A").unwrap();
    let followup = runtime.jobs().unwrap().remove(0);
    assert!(followup.source_direct && followup.config.environment.is_none());
    assert_eq!(Path::new(&followup.execution.worktree), source);
    run(&mut runtime, &followup);
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "completed");
    assert_eq!(
        runtime.state.executions[0].result.as_ref(),
        Some(&historical)
    );
}

#[test]
fn best_effort_same_slot_path_spelling_keeps_latest_environment() {
    let (_temp, _source, mut runtime) = setup(
        graph(&["A", "B", "C"], &[("A", "B", false), ("B", "C", false)]),
        automatic(),
        r#"
if(name!=='A') {
  const {execFileSync}=await import('node:child_process');
  const expected=name==='B'?'A':'B';
  const script="import pathlib,sys; prefix=pathlib.Path(sys.prefix); assert prefix.resolve()==pathlib.Path(sys.argv[1]).resolve(); marker=prefix/'marker'; assert marker.read_text()==sys.argv[2]; marker.write_text(sys.argv[3])";
  execFileSync('python',['-I','-c',script,process.env.GTEST_STATE+'/business-env',expected,name],{env:process.env});
}
"#,
    );
    let a = runtime.jobs().unwrap().remove(0);
    run_created(&mut runtime, &a, "business-env");
    let first = runtime.state.executions[0].result.clone().unwrap();
    for (parent, child) in [("A", "B"), ("B", "C")] {
        let previous = runtime.state.nodes[parent].result.clone().unwrap();
        let path = Path::new(previous.layout.as_ref().unwrap());
        let alias = path
            .parent()
            .unwrap()
            .join(".")
            .join(path.file_name().unwrap());
        let alias = alias.to_string_lossy().into_owned();
        assert_ne!(Some(&alias), previous.layout.as_ref());
        assert!(crate::path_identity::same_path(Path::new(&alias), path));
        // A recorded current reference may use another spelling of the same
        // physical slot. Historical execution evidence remains untouched.
        runtime
            .state
            .nodes
            .get_mut(parent)
            .unwrap()
            .result
            .as_mut()
            .unwrap()
            .layout = Some(alias);
        let job = runtime.jobs().unwrap().remove(0);
        assert_eq!(job.execution.node, child);
        assert!(crate::path_identity::same_path(
            Path::new(&job.execution.worktree),
            path
        ));
        let input = job.environment_input.as_ref().unwrap();
        assert_eq!(
            input.environment_ref, previous.environment_ref,
            "inherit the latest parent bytes, not the initial baseline"
        );
        assert_eq!(input.inheritance.as_ref().unwrap().reason, "same-layout");
        assert!(
            store(&runtime)
                .load_launch(&input.launch_ref)
                .unwrap()
                .environment
                .is_some(),
            "path spelling must not unbind the current interpreter"
        );
        run(&mut runtime, &job);
        assert_ne!(
            runtime.state.nodes[child]
                .result
                .as_ref()
                .unwrap()
                .environment_ref,
            previous.environment_ref
        );
    }
    assert_eq!(runtime.state.executions[0].result.as_ref(), Some(&first));
    assert_eq!(
        fs::read_to_string(state_of(&runtime, &a.execution.worktree).join("business-env/marker"))
            .unwrap(),
        "C"
    );
    let env = store(&runtime);
    let latest = runtime.state.nodes["C"].result.as_ref().unwrap();
    let elsewhere = CompositeResult {
        layout: Some(
            Path::new(&a.execution.worktree)
                .with_file_name("different-slot")
                .to_string_lossy()
                .into_owned(),
        ),
        ..latest.clone()
    };
    let selected = env
        .select_for_workspace(
            "next",
            &[("C".into(), latest.clone())],
            &a.execution.worktree,
            runtime.state.environment_baseline.as_ref().unwrap(),
            Some(&elsewhere),
        )
        .unwrap();
    assert!(
        env.load_launch(&selected.launch_ref)
            .unwrap()
            .environment
            .is_none(),
        "matching E/L alone cannot make another slot the current owner"
    );
}

#[test]
fn best_effort_independent_terminal_environments_publish_and_launch_named_entries() {
    let (_temp, source, mut runtime) = setup(
        graph(&["A", "B"], &[]),
        automatic(),
        "fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/'+name+'.txt',name);",
    );
    let roots = runtime.jobs().unwrap();
    for job in &roots {
        run_created(&mut runtime, job, ".venv");
    }
    let descriptor = publish(&mut runtime, &source);
    assert_eq!(descriptor.entries.len(), 2);
    assert!(descriptor.default_entry.is_none());
    for entry in &descriptor.entries {
        assert_eq!(
            entry.result.code_ref,
            runtime.state.published_head.clone().unwrap()
        );
        assert!(Path::new(&entry.workspace).join("reports/A.txt").is_file());
        assert!(Path::new(&entry.workspace).join("reports/B.txt").is_file());
        assert_eq!(
            fs::read_to_string(state_of(&runtime, &entry.workspace).join(".venv/marker")).unwrap(),
            entry.name
        );
    }
    assert!(runtime.start_result(&[]).err().unwrap().contains("entryId"));
    assert!(runtime.state.result_execution.is_none());
    assert!(descriptor.for_entry(Some("unknown")).is_err());
    let args = vec!["-c".into(), "import os,pathlib; print(pathlib.Path(os.environ['GTEST_STATE'],'.venv/marker').read_text())".into()];
    let (job, control) = runtime.start_result_entry(&args, Some("B")).unwrap();
    let outcome = perform_result(&job, &control, |input| {
        runtime.emit(EventKind::ResultExecutionPrepared { input })
    });
    let output = runtime.finish_result(&job, &control, outcome).unwrap();
    assert_eq!(output.trim(), "B");
    assert_eq!(
        runtime
            .state
            .published_result
            .as_ref()
            .unwrap()
            .entries
            .len(),
        2
    );
    let republished = publish(&mut runtime, &source);
    assert_eq!(republished.entries.len(), 2);
    assert!(runtime.state.mergers.is_empty());
}

#[test]
fn rooted_terminals_with_w_and_s_bindings_keep_named_results_and_real_interpreters() {
    let (_temp, source, mut runtime) = setup(graph(&["A", "B"], &[]), automatic(), "");
    for job in runtime.jobs().unwrap() {
        run_created_at(&mut runtime, &job, ".venv", job.execution.node == "A");
    }
    let descriptor = publish(&mut runtime, &source);
    assert_eq!(descriptor.entries.len(), 2);
    assert!(descriptor.default_entry.is_none());
    assert!(
        !source.join(".venv").exists(),
        "managed scopes do not gain a source delivery channel"
    );
    for name in ["A", "B"] {
        let result = runtime.state.nodes[name].result.as_ref().unwrap();
        let env = store(&runtime);
        let launch = env.load_launch(&result.launch_ref).unwrap();
        assert_eq!(
            launch.environment.as_ref().unwrap().root.as_deref(),
            Some(if name == "A" { "workspace" } else { "state" })
        );
        assert!(launch
            .environment
            .as_ref()
            .unwrap()
            .runtime_evidence
            .is_some());
        env.verify_view(
            Path::new(result.layout.as_deref().unwrap()),
            &result.launch_ref,
            &result.environment_ref,
        )
        .unwrap();
        let entry = descriptor
            .entries
            .iter()
            .find(|entry| entry.name == name)
            .unwrap();
        let expected = if name == "A" {
            PathBuf::from(&entry.workspace).join(".venv")
        } else {
            state_of(&runtime, &entry.workspace).join(".venv")
        };
        fs::write(expected.join("marker"), "partial environment edit").unwrap();
        // Preflight must use captured native bytes, not execute the broken live
        // prefix. Removing the whole bin directory also avoids retaining broken
        // sibling interpreter links that intentionally cannot be overwritten.
        fs::remove_dir_all(expected.join(if cfg!(windows) { "Scripts" } else { "bin" })).unwrap();
        env.preflight_history_result(
            Path::new(&entry.workspace),
            &entry.result,
            &entry.result.launch_ref,
        )
        .unwrap();
        let restored = env
            .prepare(
                Path::new(&entry.workspace),
                &entry.result,
                &Uuid::new_v4().to_string(),
                &entry.result.code_ref,
                vec![],
                false,
                true,
            )
            .unwrap();
        assert_eq!(fs::read_to_string(expected.join("marker")).unwrap(), name);
        assert_eq!(restored.environment_ref, entry.result.environment_ref);
        env.validate_launch(
            Path::new(&entry.workspace),
            &env.load_launch(&restored.launch_ref).unwrap(),
        )
        .unwrap();
        let mut legacy = env.load_launch(&restored.launch_ref).unwrap();
        legacy.environment.as_mut().unwrap().runtime_evidence = None;
        assert!(env
            .launch(&legacy)
            .unwrap_err()
            .contains("runtime file evidence"));
        if name == "B" {
            let mut missing_root = env.load_launch(&restored.launch_ref).unwrap();
            missing_root.environment.as_mut().unwrap().root = None;
            assert!(env.launch(&missing_root).unwrap_err().contains("root"));
        }
        env.validate_launch(
            Path::new(&entry.workspace),
            &env.load_launch(&restored.launch_ref).unwrap(),
        )
        .unwrap();
        let launch = env
            .load_launch(&restored.launch_ref)
            .unwrap()
            .expanded(Path::new(&entry.workspace));
        let mut command = Command::new(&launch.entry);
        command.args(["-I", "-c", "import sys,pathlib; assert pathlib.Path(sys.prefix).resolve()==pathlib.Path(sys.argv[1]).resolve(); print(sys.executable)"]).arg(&expected);
        controlled_output(command).unwrap();
    }
}

// Deliberately stale evidence is written as a NEW L; installed host tools and
// historical execution/launch records remain untouched.
fn stale_external_launch(env: &Environments, reference: &str) -> String {
    let mut value = serde_json::to_value(env.load_launch(reference).unwrap()).unwrap();
    let external = value["environment"]["runtimeEvidence"]["files"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|file| file["location"] == "external")
        .expect("real venv has observed external native inputs");
    external["blob"] = serde_json::Value::String("0".repeat(40));
    env.launch(&serde_json::from_value(value).unwrap()).unwrap()
}

#[test]
fn rooted_runtime_preflight_mismatch_preserves_code_both_roots_and_history() {
    let (_temp, _source, mut runtime) = setup(graph(&["A"], &[]), automatic(), "");
    let job = runtime.jobs().unwrap().remove(0);
    run_created_at(&mut runtime, &job, ".venv", true);
    let result = runtime.state.nodes["A"].result.as_ref().unwrap().clone();
    let env = store(&runtime);
    let path = Path::new(&job.execution.worktree);
    let state = env.state_root(path).unwrap();
    let history = runtime
        .state
        .executions
        .iter()
        .map(|execution| execution.result.clone())
        .collect::<Vec<_>>();
    let stale = CompositeResult {
        launch_ref: stale_external_launch(&env, &result.launch_ref),
        ..result.clone()
    };
    fs::write(path.join("partial-code"), "keep code").unwrap();
    fs::write(path.join(".venv/marker"), "keep W").unwrap();
    fs::create_dir_all(state.join(".agent-home")).unwrap();
    fs::write(state.join(".agent-home/partial"), "keep S").unwrap();
    env.validate_result_metadata(&stale).unwrap(); // Actor still does no native IO.
    let error = env
        .preflight_history_result(path, &stale, &result.launch_ref)
        .unwrap_err();
    assert!(error.contains("runtime input bytes changed"), "{error}");
    assert!(env
        .prepare(
            path,
            &stale,
            &Uuid::new_v4().to_string(),
            &stale.code_ref,
            vec![],
            false,
            true
        )
        .is_err());
    assert_eq!(
        fs::read_to_string(path.join("partial-code")).unwrap(),
        "keep code"
    );
    assert_eq!(
        fs::read_to_string(path.join(".venv/marker")).unwrap(),
        "keep W"
    );
    assert_eq!(
        fs::read_to_string(state.join(".agent-home/partial")).unwrap(),
        "keep S"
    );
    assert_eq!(
        runtime
            .state
            .executions
            .iter()
            .map(|execution| execution.result.clone())
            .collect::<Vec<_>>(),
        history
    );
    env.validate_result(&result).unwrap();
}

#[test]
fn rooted_missing_w_result_checks_runtime_inputs_before_reconstruction_or_s_restore() {
    let (_temp, source, mut runtime) = setup(graph(&["A"], &[]), automatic(), "");
    let job = runtime.jobs().unwrap().remove(0);
    run_created_at(&mut runtime, &job, ".venv", true);
    let descriptor = publish(&mut runtime, &source);
    let env = store(&runtime);
    let stale = stale_external_launch(&env, &descriptor.result.launch_ref);
    let state = env.state_root(Path::new(&descriptor.workspace)).unwrap();
    fs::create_dir_all(state.join(".agent-home")).unwrap();
    fs::write(state.join(".agent-home/partial"), "keep S without W").unwrap();
    fs::remove_dir_all(&descriptor.workspace).unwrap();
    let history = runtime
        .state
        .executions
        .iter()
        .map(|execution| execution.result.clone())
        .collect::<Vec<_>>();
    let (mut job, control) = runtime
        .start_result(&["-c".into(), "print('must not execute')".into()])
        .unwrap();
    // Inject only a copied worker input to model stale external bytes without
    // mutating the machine's installed Python or manufacturing a publication.
    job.fixture_environment_launch(stale);
    let outcome = perform_result(&job, &control, |_| {
        panic!("bad preflight cannot prepare a writer")
    });
    assert!(
        outcome
            .as_ref()
            .unwrap_err()
            .contains("runtime input bytes changed"),
        "{outcome:?}"
    );
    assert!(runtime.finish_result(&job, &control, outcome).is_err());
    assert!(
        !Path::new(&descriptor.workspace).exists(),
        "no code was reconstructed before rejecting the native input"
    );
    assert_eq!(
        fs::read_to_string(state.join(".agent-home/partial")).unwrap(),
        "keep S without W"
    );
    assert_eq!(
        runtime
            .state
            .executions
            .iter()
            .map(|execution| execution.result.clone())
            .collect::<Vec<_>>(),
        history
    );
}

#[test]
fn rooted_missing_w_descriptor_checks_runtime_inputs_before_reconstructing_code() {
    let (_temp, source, mut runtime) = setup(graph(&["A"], &[]), automatic(), "");
    let execution = runtime.jobs().unwrap().remove(0);
    run_created_at(&mut runtime, &execution, ".venv", true);
    let descriptor = publish(&mut runtime, &source);
    let env = store(&runtime);
    let stale = stale_external_launch(&env, &descriptor.result.launch_ref);
    let state = env.state_root(Path::new(&descriptor.workspace)).unwrap();
    fs::create_dir_all(state.join(".agent-home")).unwrap();
    fs::write(state.join(".agent-home/partial"), "keep S without W").unwrap();
    fs::remove_dir_all(&descriptor.workspace).unwrap();
    let history = runtime
        .state
        .executions
        .iter()
        .map(|execution| execution.result.clone())
        .collect::<Vec<_>>();
    let mut job = runtime.publication_environment_input().unwrap().unwrap();
    // Change only the copied worker input, never a published historical L.
    job.inputs[0].1.launch_ref = stale;
    job.validate().unwrap();
    let error = job.descriptor(&descriptor.result.code_ref).unwrap_err();
    assert!(error.contains("runtime input bytes changed"), "{error}");
    assert!(
        !Path::new(&descriptor.workspace).exists(),
        "descriptor reconstruction wrote W before rejecting a known bad native input"
    );
    assert_eq!(
        fs::read_to_string(state.join(".agent-home/partial")).unwrap(),
        "keep S without W"
    );
    assert_eq!(
        runtime
            .state
            .executions
            .iter()
            .map(|execution| execution.result.clone())
            .collect::<Vec<_>>(),
        history
    );
}

#[test]
fn rooted_private_switch_inherits_the_new_binding_and_restores_both_histories() {
    let (_temp, source, mut runtime) = setup(
        graph(&["A", "B", "C"], &[("A", "B", false), ("B", "C", false)]),
        automatic(),
        r#"
const {execFileSync}=await import('node:child_process');
const prefix=process.env.GTEST_STATE+'/same-env';
if(name==='A') {
  execFileSync('python',['-m','venv','--without-pip',prefix],{env:process.env});
  fs.writeFileSync(prefix+'/marker','S original');
}
if(name==='C') {
  execFileSync('python',['-I','-c',"import pathlib,sys; p=pathlib.Path(sys.prefix); assert p.resolve()==pathlib.Path(sys.argv[1]).resolve(); assert (p/'marker').read_text()=='B patch'",prefix],{env:process.env});
}
"#,
    );
    let a = runtime.jobs().unwrap().remove(0);
    run_created_at(&mut runtime, &a, "same-env", true);
    let first = runtime.state.nodes["A"].result.clone().unwrap();
    let b = runtime.jobs().unwrap().remove(0);
    let data = runtime.root.clone();
    let outcome = perform(
        &b,
        &data,
        &[],
        |_| {},
        |head| {
            runtime.emit(EventKind::Prepared {
                execution_id: b.execution.id.clone(),
                head,
            })?;
            let env = store(&runtime);
            let input = env.load_record_metadata(&b.execution.id, "before")?;
            let path = Path::new(&b.execution.worktree);
            let launch = env.load_launch(&input.launch_ref)?.expanded(path);
            let state = env.state_root(path)?;
            let prefix = state.join("same-env");
            let interpreter = prefix.join(if cfg!(windows) {
                "Scripts/python.exe"
            } else {
                "bin/python"
            });
            let session = data.join("sessions").join(&b.execution.id);
            let context = crate::environment_discovery::context_with_source(
                path,
                Some(&state),
                Some(&source),
                &b.execution.id,
                &launch,
                &session,
                true,
            )?;
            let code = crate::environment_discovery::tool(vec![context.to_string_lossy().into_owned(),
            "python".into(), interpreter.to_string_lossy().into_owned(), "-I".into(), "-c".into(),
            "import pathlib,sys; p=pathlib.Path(sys.prefix); assert p.resolve()==pathlib.Path(sys.argv[1]).resolve(); (p/'marker').write_text('B patch')".into(),
            prefix.to_string_lossy().into_owned()])?;
            if code != 0 {
                return Err(format!("private switch command failed: {code}"));
            }
            Ok(())
        },
    );
    assert!(outcome.is_ok(), "{outcome:?}");
    runtime.finish(&b.execution, outcome).unwrap();
    let second = runtime.state.nodes["B"].result.clone().unwrap();
    let env = store(&runtime);
    assert_eq!(
        env.load_launch(&first.launch_ref)
            .unwrap()
            .environment
            .unwrap()
            .root
            .as_deref(),
        Some("workspace")
    );
    assert_eq!(
        env.load_launch(&second.launch_ref)
            .unwrap()
            .environment
            .unwrap()
            .root
            .as_deref(),
        Some("state")
    );
    let c = runtime.jobs().unwrap().remove(0);
    assert_eq!(
        c.environment_input.as_ref().unwrap().launch_ref,
        second.launch_ref
    );
    run(&mut runtime, &c);
    let historical = runtime
        .state
        .executions
        .iter()
        .map(|execution| execution.result.clone())
        .collect::<Vec<_>>();
    let path = Path::new(&c.execution.worktree);
    let state = env.state_root(path).unwrap();
    let mut previous = runtime.state.nodes["C"]
        .result
        .as_ref()
        .unwrap()
        .launch_ref
        .clone();
    for (selected, expected_state) in [(&first, "S original"), (&second, "B patch")] {
        env.preflight_history_result(path, selected, &previous)
            .unwrap();
        let restored = env
            .prepare(
                path,
                selected,
                &Uuid::new_v4().to_string(),
                &selected.code_ref,
                vec![],
                false,
                true,
            )
            .unwrap();
        let launch = env.load_launch(&restored.launch_ref).unwrap();
        env.validate_launch(path, &launch).unwrap();
        assert_eq!(restored.launch_ref, selected.launch_ref);
        assert_eq!(restored.environment_ref, selected.environment_ref);
        assert_eq!(
            fs::read_to_string(path.join("same-env/marker")).unwrap(),
            "A"
        );
        assert_eq!(
            fs::read_to_string(state.join("same-env/marker")).unwrap(),
            expected_state
        );
        previous = restored.launch_ref;
    }
    assert_eq!(
        runtime
            .state
            .executions
            .iter()
            .map(|execution| execution.result.clone())
            .collect::<Vec<_>>(),
        historical
    );
}

#[test]
fn rooted_result_reconstructs_missing_w_and_restores_s_without_rewriting_execution_history() {
    let (_temp, source, mut runtime) = setup(
        graph(&["A"], &[]),
        automatic(),
        r#"
fs.mkdirSync(process.env.HOME,{recursive:true});
fs.writeFileSync(process.env.HOME+'/recorded-config','S config');
"#,
    );
    let job = runtime.jobs().unwrap().remove(0);
    run_created_at(&mut runtime, &job, ".venv", true);
    let descriptor = publish(&mut runtime, &source);
    let path = PathBuf::from(&descriptor.workspace);
    let state = state_of(&runtime, &descriptor.workspace);
    let historical = runtime
        .state
        .executions
        .iter()
        .map(|execution| execution.result.clone())
        .collect::<Vec<_>>();
    fs::remove_dir_all(&path).unwrap();
    fs::write(
        state.join(".agent-home/recorded-config"),
        "partial S config",
    )
    .unwrap();
    fs::create_dir_all(state.join(".venv")).unwrap();
    fs::write(
        state.join(".venv/later-only"),
        "absent from selected S coverage",
    )
    .unwrap();
    let args = vec!["-I".into(), "-c".into(), "import pathlib,os,sys; assert pathlib.Path(sys.prefix).resolve()==pathlib.Path(os.getcwd(),'.venv').resolve(); assert pathlib.Path(os.environ['HOME'],'recorded-config').read_text()=='S config'; print(pathlib.Path(sys.prefix,'marker').read_text())".into()];
    let (job, control) = runtime.start_result(&args).unwrap();
    let outcome = perform_result(&job, &control, |input| {
        runtime.emit(EventKind::ResultExecutionPrepared { input })
    });
    assert_eq!(
        runtime
            .finish_result(&job, &control, outcome)
            .unwrap()
            .trim(),
        "A"
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
    assert_eq!(
        fs::read_to_string(state.join(".agent-home/recorded-config")).unwrap(),
        "S config"
    );
    assert!(
        !state.join(".venv").exists(),
        "recorded S absence is distinct from W .venv"
    );
    assert!(path.join(".venv/marker").is_file());
    assert!(!source.join(".venv").exists());
}

#[test]
fn rooted_project_native_dependency_uses_coderef_not_e_and_runs_after_missing_w_recovery() {
    let (_temp, source, mut runtime) = setup(graph(&["A"], &[]), automatic(),
        "const {execFileSync}=await import('node:child_process');execFileSync('git',['add','--','vendor/native']);");
    let job = runtime.jobs().unwrap().remove(0);
    run_created_at_with(
        &mut runtime,
        &job,
        ".venv",
        false,
        install_project_native_input,
    );
    assert!(
        workspace::project_git(Path::new(&job.execution.worktree), &["ls-files"])
            .unwrap()
            .contains("vendor/native/")
    );
    let descriptor = publish(&mut runtime, &source);
    let env = store(&runtime);
    let binding = serde_json::to_value(
        env.load_launch(&descriptor.result.launch_ref)
            .unwrap()
            .environment
            .unwrap(),
    )
    .unwrap();
    assert_eq!(binding["root"], "state");
    assert!(binding["runtimeEvidence"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["root"] == "workspace"
            && file["path"]
                .as_str()
                .is_some_and(|path| path.starts_with("vendor/native/"))));
    let frame: serde_json::Value = serde_json::from_slice(
        &fs::read(
            env.directory
                .join("files/versions")
                .join(format!("{}.json", descriptor.result.environment_ref)),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(
        frame["rooted"]["roots"].get("workspace").is_none(),
        "project native code must not acquire a second E delivery path"
    );
    let work = PathBuf::from(&descriptor.workspace);
    let state = state_of(&runtime, &descriptor.workspace);
    let source_modules = fs::read_dir(source.join("vendor/native"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(
        source_modules.len(),
        1,
        "native project dependency follows normal publication"
    );
    let historical = runtime
        .state
        .executions
        .iter()
        .map(|execution| execution.result.clone())
        .collect::<Vec<_>>();
    fs::remove_dir_all(&work).unwrap();
    fs::remove_dir_all(
        state
            .join(".venv")
            .join(if cfg!(windows) { "Scripts" } else { "bin" }),
    )
    .unwrap();
    let args = vec!["-I".into(), "-B".into(), "-c".into(), "import ssl,_hashlib,pathlib,sys; assert pathlib.Path(_hashlib.__file__).resolve().is_relative_to(pathlib.Path.cwd().resolve()/'vendor'/'native'); print(pathlib.Path(sys.prefix,'marker').read_text())".into()];
    let (job, control) = runtime.start_result(&args).unwrap();
    let outcome = perform_result(&job, &control, |input| {
        runtime.emit(EventKind::ResultExecutionPrepared { input })
    });
    assert_eq!(
        runtime
            .finish_result(&job, &control, outcome)
            .unwrap()
            .trim(),
        "A"
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
    assert!(work
        .join("vendor/native")
        .join(&source_modules[0])
        .is_file());
}

#[test]
fn best_effort_home_changes_do_not_require_environment_agreement_or_a_default_choice() {
    let (_temp, source, mut runtime) = setup(graph(&["A", "B"], &[]), automatic(),
        "fs.mkdirSync(process.env.HOME,{recursive:true});fs.writeFileSync(process.env.HOME+'/writer',name);");
    for job in runtime.jobs().unwrap() {
        run(&mut runtime, &job);
    }
    let descriptor = publish(&mut runtime, &source);
    assert_ne!(
        descriptor.entries[0].result.environment_ref,
        descriptor.entries[1].result.environment_ref
    );
    assert_eq!(descriptor.default_entry.as_deref(), Some("A"));
    assert!(descriptor.for_entry(None).is_ok());
    assert!(runtime.state.mergers.is_empty());
}

#[test]
fn best_effort_ignored_input_corruption_fails_before_a_writer_or_reset() {
    let (_temp, _source, mut runtime) = setup(
        graph(&["A", "B", "C"], &[("A", "C", false), ("B", "C", false)]),
        automatic(),
        "",
    );
    for job in runtime.jobs().unwrap() {
        run_created(&mut runtime, &job, ".venv");
    }
    let c = runtime.jobs().unwrap().remove(0);
    let ignored = &runtime.state.nodes["B"]
        .result
        .as_ref()
        .unwrap()
        .environment_ref;
    let version: serde_json::Value = serde_json::from_slice(
        &fs::read(
            runtime
                .root
                .join("environments")
                .join(&runtime.state.run_id)
                .join("files/versions")
                .join(format!("{ignored}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    let blob = version["rooted"]["roots"]["state"]["entries"][".venv/marker"]["blob"]
        .as_str()
        .unwrap();
    fs::write(
        runtime
            .root
            .join("environments")
            .join(&runtime.state.run_id)
            .join("files/blobs")
            .join(blob),
        "X",
    )
    .unwrap();
    let result = perform(
        &c,
        &runtime.root,
        &[],
        |_| panic!("Agent must not run"),
        |_| panic!("view must not prepare"),
    );
    assert!(result.unwrap_err().contains("Damaged workspace file blob"));
    assert_eq!(
        fs::read_to_string(state_of(&runtime, &c.execution.worktree).join(".venv/marker")).unwrap(),
        "A"
    );
}

#[test]
fn best_effort_failed_entry_cannot_switch_to_another_terminal_on_retry() {
    let (_temp, source, mut runtime) = setup(graph(&["A", "B"], &[]), automatic(), "");
    for job in runtime.jobs().unwrap() {
        run_created(&mut runtime, &job, ".venv");
    }
    publish(&mut runtime, &source);
    let args = vec!["-c".into(), "import os,pathlib; pathlib.Path(os.environ['GTEST_STATE'],'.venv/partial').write_text('kept'); raise SystemExit(1)".into()];
    let (job, control) = runtime.start_result_entry(&args, Some("B")).unwrap();
    let outcome = perform_result(&job, &control, |input| {
        runtime.emit(EventKind::ResultExecutionPrepared { input })
    });
    assert!(runtime.finish_result(&job, &control, outcome).is_err());
    drop(control);
    let generation = runtime
        .state
        .result_execution
        .as_ref()
        .unwrap()
        .input
        .generation
        .clone();
    assert!(runtime
        .start_result_entry(&[], Some("A"))
        .err()
        .unwrap()
        .contains("partial workspace"));
    assert_eq!(
        runtime
            .state
            .result_execution
            .as_ref()
            .unwrap()
            .input
            .generation,
        generation
    );
    let args = vec!["-c".into(), "import os,pathlib; print(pathlib.Path(os.environ['GTEST_STATE'],'.venv/partial').read_text())".into()];
    let (job, control) = runtime.start_result_entry(&args, Some("B")).unwrap();
    let outcome = perform_result(&job, &control, |input| {
        runtime.emit(EventKind::ResultExecutionPrepared { input })
    });
    assert_eq!(
        runtime
            .finish_result(&job, &control, outcome)
            .unwrap()
            .trim(),
        "kept"
    );
}

#[test]
fn best_effort_project_requirement_declarations_do_not_block_native_input_or_binding() {
    let (_temp, source, mut runtime) = setup(
        graph(&["A", "B"], &[("A", "B", false)]),
        automatic(),
        "fs.writeFileSync('pyproject.toml','[project]\\nrequires-python=\"~=99.0\"\\n');",
    );
    let a = runtime.jobs().unwrap().remove(0);
    run_created(&mut runtime, &a, ".venv");
    let b = runtime.jobs().unwrap().remove(0);
    assert_eq!(a.execution.worktree, b.execution.worktree);
    run(&mut runtime, &b);
    let launch = store(&runtime)
        .load_launch(&runtime.state.nodes["B"].result.as_ref().unwrap().launch_ref)
        .unwrap();
    assert!(launch.environment.is_some());
    assert!(
        crate::environment_discovery::validate_launch(
            Path::new(&b.execution.worktree),
            &launch,
            true
        )
        .is_err(),
        "the saved strict contract still checks project requirements"
    );
    publish(&mut runtime, &source);
}

#[test]
fn best_effort_serialized_roots_keep_independent_terminal_slots() {
    let (_temp, source, mut runtime) = setup(graph(&["A", "B"], &[]), automatic(), "");
    runtime.state.config.as_mut().unwrap().max_parallel = 1;
    let a = runtime.jobs().unwrap().remove(0);
    run_created(&mut runtime, &a, ".venv");
    let b = runtime.jobs().unwrap().remove(0);
    assert_ne!(
        a.execution.worktree, b.execution.worktree,
        "a terminal result is not an idle slot"
    );
    run_created(&mut runtime, &b, ".venv");
    assert_eq!(publish(&mut runtime, &source).entries.len(), 2);
}

#[test]
fn independent_unpublished_paths_keep_their_business_environments() {
    let (_temp, source, mut runtime) = setup(
        graph(&["A", "B", "C", "D"], &[("A", "C", false), ("B", "D", false)]), automatic(),
        "const state=process.env.GTEST_STATE; if(name==='C' && (!fs.existsSync(state+'/business-env') || fs.existsSync(state+'/.venv'))) throw Error('Runtime lost A environment or borrowed B environment');",
    );
    runtime.state.config.as_mut().unwrap().max_parallel = 1;
    let a = runtime.jobs().unwrap().remove(0);
    run_created(&mut runtime, &a, "business-env");
    let b = runtime.jobs().unwrap().remove(0);
    assert_ne!(a.execution.worktree, b.execution.worktree);
    run_created(&mut runtime, &b, ".venv");
    let c = runtime.jobs().unwrap().remove(0);
    assert_eq!(c.execution.worktree, a.execution.worktree);
    let c_state = state_of(&runtime, &c.execution.worktree);
    assert!(
        c_state.join("business-env").exists(),
        "Runtime must preserve the business environment"
    );
    assert!(
        !c_state.join(".venv").exists(),
        "C must not borrow B's independent environment"
    );
    run(&mut runtime, &c);
    let d = runtime.jobs().unwrap().remove(0);
    assert_ne!(
        d.execution.worktree, c.execution.worktree,
        "C's terminal slot must stay pinned"
    );
    run(&mut runtime, &d);
    assert_eq!(publish(&mut runtime, &source).entries.len(), 2);
    assert!(!workspace::git(&source, &["ls-files"])
        .unwrap()
        .contains("business-env"));
}

#[test]
fn fan_in_merges_external_environment_hints_without_choosing_or_blocking() {
    let temp = tempfile::tempdir().unwrap();
    let run = Uuid::new_v4().to_string();
    let config = automatic();
    let store = Environments::new(&temp.path().join("data"), &run, &config).unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    workspace::git(&workspace, &["init", "-q"]).unwrap();
    let baseline = store.initialize(&workspace).unwrap();
    let parent = |name: &str, selector: &str| {
        let mut launch = store.load_launch(&baseline.launch_ref).unwrap();
        launch
            .ambient_hints
            .push(crate::environment_discovery::AmbientEnvironmentHint {
                manager: "conda".into(),
                selector: selector.into(),
                executable: "conda".into(),
            });
        let launch_ref = store.launch(&launch).unwrap();
        (
            name.into(),
            CompositeResult {
                layout: Some(temp.path().join(name).to_string_lossy().into()),
                launch_ref,
                ..baseline.clone()
            },
        )
    };
    let inputs = vec![parent("B", "name:train"), parent("C", "name:report")];
    let selected = store
        .select_for_workspace(
            "D",
            &inputs,
            &temp.path().join("D").to_string_lossy(),
            &baseline,
            None,
        )
        .unwrap();
    let launch = store.load_launch(&selected.launch_ref).unwrap();
    assert!(
        launch.environment.is_none(),
        "fanin with external-only inputs remains unbound"
    );
    assert_eq!(
        launch
            .ambient_hints
            .iter()
            .map(|hint| hint.selector.as_str())
            .collect::<Vec<_>>(),
        vec!["name:report", "name:train"],
        "fanin preserves and deterministically deduplicates every parent hint"
    );
}

#[test]
fn saved_policy_without_best_effort_preserves_the_old_domain_and_semantics() {
    let original = policy();
    let json = serde_json::to_value(&original).unwrap();
    assert!(json.get("bestEffort").is_none());
    assert!(json["launch"].get("inheritAmbient").is_none());
    assert!(json["launch"].get("ownedScopes").is_none());
    assert!(json["launch"].get("unboundPath").is_none());
    let restored: EnvironmentConfig = serde_json::from_value(json.clone()).unwrap();
    assert!(!restored.best_effort);
    assert_eq!(serde_json::to_value(restored).unwrap(), json);
}
