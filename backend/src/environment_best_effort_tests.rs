//! Deterministic Runtime contracts with actual native venvs and tool receipts.
//! No added Agent instructions, package downloads or paid providers.
use super::*;
use super::tests::{graph, policy, run, setup};
use crate::{model::*, runtime::{perform, perform_result, Job, Runtime}};

fn automatic() -> EnvironmentConfig {
    let mut config = policy();
    config.discovery = true;
    config.best_effort = true;
    config.allow_descendant = true;
    config.scopes = vec![".env".into(), ".venv".into(), ".environments".into(), ".agent-home".into()];
    config
}

fn store(runtime: &Runtime) -> Environments {
    Environments::new(&runtime.root, &runtime.state.run_id,
        runtime.state.config.as_ref().unwrap().environment.as_ref().unwrap()).unwrap()
}

// Exercise the native adapter at the owning writer's Prepared boundary. The
// fixture Agent does only its existing business task; Rust creates/observes E.
fn run_created(runtime: &mut Runtime, job: &Job, prefix: &str) {
    let root = runtime.root.clone();
    let result = perform(job, &root, &[], |_| {}, |head| {
        runtime.emit(EventKind::Prepared { execution_id: job.execution.id.clone(), head })?;
        let env = store(runtime);
        let input = env.load_record_metadata(&job.execution.id, "before")?;
        let launch = env.load_launch(&input.launch_ref)?.expanded(Path::new(&job.execution.worktree));
        let session = root.join("sessions").join(&job.execution.id);
        let context = crate::environment_discovery::context(
            Path::new(&job.execution.worktree), &job.execution.id, &launch, &session, true,
        )?;
        assert!(!Path::new(&job.execution.worktree).join(prefix).exists(), "unportable input must not be copied");
        let bootstrap = automatic().launch.entry;
        let code = crate::environment_discovery::tool(vec![
            context.to_string_lossy().into(), "python".into(), bootstrap,
            "-m".into(), "venv".into(), "--without-pip".into(),
            Path::new(&job.execution.worktree).join(prefix).to_string_lossy().into(),
        ])?;
        if code != 0 { return Err(format!("native venv creation failed: {code}")); }
        fs::write(Path::new(&job.execution.worktree).join(prefix).join("marker"), &job.execution.node)
            .map_err(|e| e.to_string())?;
        Ok(())
    });
    assert!(result.is_ok(), "{:?}", result);
    runtime.finish(&job.execution, result).unwrap();
    assert_eq!(runtime.state.nodes[&job.execution.node].status, "done",
        "{:?}", runtime.state.nodes[&job.execution.node].error);
}

fn publish(runtime: &mut Runtime, source: &Path) -> ResultDescriptor {
    assert!(runtime.jobs().unwrap().is_empty());
    let publication = runtime.state.publication.clone().unwrap();
    let head = crate::graph_merge::merge_graph_scoped(source, &publication.heads,
        &runtime.exclusions().unwrap(), || Err("unexpected Git conflict".into())).unwrap();
    runtime.emit(EventKind::PublicationCompleted { head }).unwrap();
    assert_eq!(runtime.state.phase, "completed");
    runtime.result_descriptor().unwrap()
}

#[test]
fn best_effort_bound_fanout_is_parallel_and_custom_prefixes_never_enter_git() {
    let (_temp, source, mut runtime) = setup(
        graph(&["A", "B", "C", "D"], &[("A", "B", false), ("A", "C", false),
            ("B", "D", false), ("C", "D", false)]), automatic(),
        "if(name==='C') { if(fs.existsSync('business-env')) throw Error('fixed environment was copied'); }\nif(name==='B') fs.writeFileSync('business-env/marker','B');\nif(name==='D' && fs.readFileSync('business-env/marker','utf8')!=='B') throw Error('local input was not inherited');\nfs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/'+name+'.txt',name);",
    );
    let a = runtime.jobs().unwrap().remove(0);
    run_created(&mut runtime, &a, "business-env");
    let historical = runtime.state.executions[0].result.clone().unwrap();
    let branches = runtime.jobs().unwrap();
    assert_eq!(branches.len(), 2);
    assert_ne!(branches[0].execution.worktree, branches[1].execution.worktree);
    assert_eq!(branches[0].execution.worktree, a.execution.worktree);
    for (index, branch) in branches.iter().enumerate() {
        let input = branch.environment_input.as_ref().unwrap();
        let bound = store(&runtime).load_launch(&input.launch_ref).unwrap().environment.is_some();
        assert_eq!(bound, index == 0, "only the exclusive local branch reuses E");
        assert_eq!(input.inheritance.as_ref().unwrap().reason,
            if index == 0 { "same-layout" } else { "fixed-layout-not-reusable" });
    }
    // B takes the exclusive parent slot; C remains an ordinary report task.
    run(&mut runtime, &branches[0]);
    run(&mut runtime, &branches[1]);
    let d = runtime.jobs().unwrap().remove(0);
    assert_eq!(d.execution.worktree, branches[0].execution.worktree);
    assert_eq!(d.environment_input.as_ref().unwrap().selected_from, vec!["B", "C"]);
    run(&mut runtime, &d);
    let descriptor = publish(&mut runtime, &source);
    assert_eq!(descriptor.schema, 2);
    assert_eq!(descriptor.default_entry.as_deref(), Some("D"));
    assert!(runtime.state.mergers.is_empty());
    assert_eq!(runtime.state.executions[0].result.as_ref(), Some(&historical));
    assert_eq!(store(&runtime).load_record(&a.execution.id, "after").unwrap(), historical);
    let tracked = workspace::git(&source, &["ls-files"]).unwrap();
    assert!(!tracked.contains("business-env"));
    assert!(source.join("reports/C.txt").is_file());
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(replay.executions[1].input.as_ref().unwrap().inheritance,
        runtime.state.executions[1].input.as_ref().unwrap().inheritance);
    runtime.intervene("A", "A").unwrap();
    let followup = runtime.jobs().unwrap().remove(0);
    assert_eq!(followup.execution.worktree, d.execution.worktree, "terminal reservation allows explicit ancestor handoff");
    run(&mut runtime, &followup);
    publish(&mut runtime, &source);
    assert_eq!(runtime.state.executions[0].result.as_ref(), Some(&historical));
}

#[test]
fn best_effort_independent_terminal_environments_publish_and_launch_named_entries() {
    let (_temp, source, mut runtime) = setup(graph(&["A", "B"], &[]), automatic(),
        "fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/'+name+'.txt',name);");
    let roots = runtime.jobs().unwrap();
    for job in &roots { run_created(&mut runtime, job, ".venv"); }
    let descriptor = publish(&mut runtime, &source);
    assert_eq!(descriptor.entries.len(), 2);
    assert!(descriptor.default_entry.is_none());
    for entry in &descriptor.entries {
        assert_eq!(entry.result.code_ref, runtime.state.published_head.clone().unwrap());
        assert!(Path::new(&entry.workspace).join("reports/A.txt").is_file());
        assert!(Path::new(&entry.workspace).join("reports/B.txt").is_file());
        assert_eq!(fs::read_to_string(Path::new(&entry.workspace).join(".venv/marker")).unwrap(), entry.name);
    }
    assert!(runtime.start_result(&[]).err().unwrap().contains("entryId"));
    assert!(runtime.state.result_execution.is_none());
    assert!(descriptor.for_entry(Some("unknown")).is_err());
    let args = vec!["-c".into(), "import pathlib; print(pathlib.Path('.venv/marker').read_text())".into()];
    let (job, control) = runtime.start_result_entry(&args, Some("B")).unwrap();
    let outcome = perform_result(&job, &control, |input| runtime.emit(EventKind::ResultExecutionPrepared { input }));
    let output = runtime.finish_result(&job, &control, outcome).unwrap();
    assert_eq!(output.trim(), "B");
    assert_eq!(runtime.state.published_result.as_ref().unwrap().entries.len(), 2);
    let republished = publish(&mut runtime, &source);
    assert_eq!(republished.entries.len(), 2);
    assert!(runtime.state.mergers.is_empty());
}

#[test]
fn best_effort_home_changes_do_not_require_environment_agreement_or_a_default_choice() {
    let (_temp, source, mut runtime) = setup(graph(&["A", "B"], &[]), automatic(),
        "fs.mkdirSync('.agent-home',{recursive:true});fs.writeFileSync('.agent-home/writer',name);");
    for job in runtime.jobs().unwrap() { run(&mut runtime, &job); }
    let descriptor = publish(&mut runtime, &source);
    assert_ne!(descriptor.entries[0].result.environment_ref, descriptor.entries[1].result.environment_ref);
    assert_eq!(descriptor.default_entry.as_deref(), Some("A"));
    assert!(descriptor.for_entry(None).is_ok());
    assert!(runtime.state.mergers.is_empty());
}

#[test]
fn best_effort_ignored_input_corruption_fails_before_a_writer_or_reset() {
    let (_temp, _source, mut runtime) = setup(
        graph(&["A", "B", "C"], &[("A", "C", false), ("B", "C", false)]), automatic(), "");
    for job in runtime.jobs().unwrap() { run_created(&mut runtime, &job, ".venv"); }
    let c = runtime.jobs().unwrap().remove(0);
    let ignored = &runtime.state.nodes["B"].result.as_ref().unwrap().environment_ref;
    let version: serde_json::Value = serde_json::from_slice(&fs::read(
        runtime.root.join("environments").join(&runtime.state.run_id).join("files/versions").join(format!("{ignored}.json"))).unwrap()).unwrap();
    let blob = version["entries"][".venv/marker"]["blob"].as_str().unwrap();
    fs::write(runtime.root.join("environments").join(&runtime.state.run_id).join("files/blobs").join(blob), "X").unwrap();
    let result = perform(&c, &runtime.root, &[], |_| panic!("Agent must not run"), |_| panic!("view must not prepare"));
    assert!(result.unwrap_err().contains("Damaged workspace file blob"));
    assert_eq!(fs::read_to_string(Path::new(&c.execution.worktree).join(".venv/marker")).unwrap(), "A");
}

#[test]
fn best_effort_failed_entry_cannot_switch_to_another_terminal_on_retry() {
    let (_temp, source, mut runtime) = setup(graph(&["A", "B"], &[]), automatic(), "");
    for job in runtime.jobs().unwrap() { run_created(&mut runtime, &job, ".venv"); }
    publish(&mut runtime, &source);
    let args = vec!["-c".into(), "import pathlib; pathlib.Path('.venv/partial').write_text('kept'); raise SystemExit(1)".into()];
    let (job, control) = runtime.start_result_entry(&args, Some("B")).unwrap();
    let outcome = perform_result(&job, &control, |input| runtime.emit(EventKind::ResultExecutionPrepared { input }));
    assert!(runtime.finish_result(&job, &control, outcome).is_err());
    drop(control);
    let generation = runtime.state.result_execution.as_ref().unwrap().input.generation.clone();
    assert!(runtime.start_result_entry(&[], Some("A")).err().unwrap().contains("partial workspace"));
    assert_eq!(runtime.state.result_execution.as_ref().unwrap().input.generation, generation);
    let args = vec!["-c".into(), "import pathlib; print(pathlib.Path('.venv/partial').read_text())".into()];
    let (job, control) = runtime.start_result_entry(&args, Some("B")).unwrap();
    let outcome = perform_result(&job, &control, |input| runtime.emit(EventKind::ResultExecutionPrepared { input }));
    assert_eq!(runtime.finish_result(&job, &control, outcome).unwrap().trim(), "kept");
}

#[test]
fn best_effort_project_requirement_declarations_do_not_block_native_input_or_binding() {
    let (_temp, source, mut runtime) = setup(
        graph(&["A", "B"], &[("A", "B", false)]), automatic(),
        "fs.writeFileSync('pyproject.toml','[project]\\nrequires-python=\"~=99.0\"\\n');",
    );
    let a = runtime.jobs().unwrap().remove(0);
    run_created(&mut runtime, &a, ".venv");
    let b = runtime.jobs().unwrap().remove(0);
    assert_eq!(a.execution.worktree, b.execution.worktree);
    run(&mut runtime, &b);
    let launch = store(&runtime).load_launch(&runtime.state.nodes["B"].result.as_ref().unwrap().launch_ref).unwrap();
    assert!(launch.environment.is_some());
    assert!(crate::environment_discovery::validate_launch(Path::new(&b.execution.worktree), &launch, true).is_err(),
        "the saved strict contract still checks project requirements");
    publish(&mut runtime, &source);
}

#[test]
fn best_effort_serialized_roots_keep_independent_terminal_slots() {
    let (_temp, source, mut runtime) = setup(graph(&["A", "B"], &[]), automatic(), "");
    runtime.state.config.as_mut().unwrap().max_parallel = 1;
    let a = runtime.jobs().unwrap().remove(0);
    run_created(&mut runtime, &a, ".venv");
    let b = runtime.jobs().unwrap().remove(0);
    assert_ne!(a.execution.worktree, b.execution.worktree, "a terminal result is not an idle slot");
    run_created(&mut runtime, &b, ".venv");
    assert_eq!(publish(&mut runtime, &source).entries.len(), 2);
}

#[test]
fn best_effort_reused_path_preserves_business_environment_when_binding_is_unavailable() {
    let (_temp, source, mut runtime) = setup(
        graph(&["A", "B", "C", "D"], &[("A", "C", false), ("B", "D", false)]), automatic(),
        "if(name==='C' && (!fs.existsSync('business-env') || !fs.existsSync('.venv'))) throw Error('Runtime cleaned a business environment');",
    );
    runtime.state.config.as_mut().unwrap().max_parallel = 1;
    let a = runtime.jobs().unwrap().remove(0);
    run_created(&mut runtime, &a, "business-env");
    let b = runtime.jobs().unwrap().remove(0);
    assert_eq!(a.execution.worktree, b.execution.worktree);
    run_created(&mut runtime, &b, ".venv");
    let c = runtime.jobs().unwrap().remove(0);
    assert_eq!(c.execution.worktree, b.execution.worktree);
    assert!(Path::new(&c.execution.worktree).join("business-env").exists(), "Runtime must preserve the business environment");
    assert!(Path::new(&c.execution.worktree).join(".venv").exists(), "Runtime must preserve the current workspace environment");
    run(&mut runtime, &c);
    let d = runtime.jobs().unwrap().remove(0);
    assert_ne!(d.execution.worktree, c.execution.worktree, "C's terminal slot must stay pinned");
    run(&mut runtime, &d);
    assert_eq!(publish(&mut runtime, &source).entries.len(), 2);
    assert!(!workspace::git(&source, &["ls-files"]).unwrap().contains("business-env"));
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
        launch.ambient_hints.push(crate::environment_discovery::AmbientEnvironmentHint {
            manager: "conda".into(), selector: selector.into(), executable: "conda".into(),
        });
        let launch_ref = store.launch(&launch).unwrap();
        (name.into(), CompositeResult {
            layout: Some(temp.path().join(name).to_string_lossy().into()),
            launch_ref,
            ..baseline.clone()
        })
    };
    let inputs = vec![parent("B", "name:train"), parent("C", "name:report")];
    let selected = store.select_for_workspace("D", &inputs,
        &temp.path().join("D").to_string_lossy(), &baseline, None).unwrap();
    let launch = store.load_launch(&selected.launch_ref).unwrap();
    assert!(launch.environment.is_none(), "fanin with external-only inputs remains unbound");
    assert_eq!(launch.ambient_hints.iter().map(|hint| hint.selector.as_str()).collect::<Vec<_>>(),
        vec!["name:report", "name:train"], "fanin preserves and deterministically deduplicates every parent hint");
}

#[test]
fn saved_policy_without_best_effort_preserves_the_old_domain_and_semantics() {
    let original = policy();
    let json = serde_json::to_value(&original).unwrap();
    assert!(json.get("bestEffort").is_none());
    let restored: EnvironmentConfig = serde_json::from_value(json.clone()).unwrap();
    assert!(!restored.best_effort);
    assert_eq!(serde_json::to_value(restored).unwrap(), json);
}
