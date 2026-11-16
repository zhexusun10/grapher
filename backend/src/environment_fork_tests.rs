//! Fresh-slot HOME inheritance through the real Runtime snapshot/preparation
//! path. Fixture agents exercise lifecycle; business reads use native Node.
use super::tests::{graph, run, setup, state_policy};
use super::*;
use crate::{
    model::EventKind,
    runtime::{perform, Runtime},
};

fn automatic_home() -> EnvironmentConfig {
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
    config.caches = vec![".cache".into(), ".agent-home/cache".into()];
    config.launch.entry = config.launch.shell.clone();
    config.launch.inherit_ambient = true;
    config.launch.unbound_path = Some(config.launch.path.clone());
    config.launch.owned_scopes = Some(vec![]);
    config
        .launch
        .variables
        .insert("USERPROFILE".into(), "{state}/.agent-home".into());
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

fn home(runtime: &Runtime, worktree: &str) -> PathBuf {
    store(runtime)
        .state_root(Path::new(worktree))
        .unwrap()
        .join(".agent-home")
}

fn fixture() -> (
    tempfile::TempDir,
    Environments,
    CompositeResult,
    CompositeResult,
) {
    fixture_with_config(automatic_home())
}

fn fixture_with_config(
    config: EnvironmentConfig,
) -> (
    tempfile::TempDir,
    Environments,
    CompositeResult,
    CompositeResult,
) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    git2::Repository::init(&source).unwrap();
    fs::write(source.join("code.txt"), "project").unwrap();
    let code = workspace::snapshot_repository(&source).unwrap();
    let run = Uuid::new_v4().to_string();
    let env = Environments::new(&temp.path().join("data"), &run, &config).unwrap();
    let baseline = env.initialize(&source).unwrap();
    let path = temp.path().join(".grapher-worktrees").join(run).join("A");
    workspace::prepare(&source, &path, &code, &[]).unwrap();
    let input = env
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
    fs::create_dir_all(env.state_root(&path).unwrap().join(".agent-home")).unwrap();
    fs::write(
        env.state_root(&path)
            .unwrap()
            .join(".agent-home/business-state"),
        "A",
    )
    .unwrap();
    let result = env.seal(&path, &input, &code, vec![]).unwrap();
    (temp, env, baseline, result)
}

fn next_path(parent: &CompositeResult, name: &str) -> PathBuf {
    Path::new(parent.layout.as_deref().unwrap())
        .parent()
        .unwrap()
        .join(name)
}

fn selected(
    env: &Environments,
    baseline: &CompositeResult,
    inputs: &[(&str, &CompositeResult)],
    path: &Path,
    current: Option<&CompositeResult>,
) -> CompositeResult {
    let inputs = inputs
        .iter()
        .map(|(name, result)| ((*name).into(), (*result).clone()))
        .collect::<Vec<_>>();
    env.select_for_workspace("next", &inputs, &path.to_string_lossy(), baseline, current)
        .unwrap()
}

fn advance(env: &Environments, parent: &CompositeResult, value: &str) -> CompositeResult {
    let path = Path::new(parent.layout.as_deref().unwrap());
    let input = env
        .prepare(
            path,
            parent,
            &Uuid::new_v4().to_string(),
            &parent.code_ref,
            vec![],
            false,
            false,
        )
        .unwrap();
    fs::write(
        env.state_root(path)
            .unwrap()
            .join(".agent-home/business-state"),
        value,
    )
    .unwrap();
    env.seal(path, &input, &parent.code_ref, vec![]).unwrap()
}

/// Acceptance target, deliberately not counted as passing component coverage.
/// Run explicitly; current native private HOME has no generic source read layer.
#[test]
#[ignore = "zero-config source HOME discovery requires an unimplemented native private read/write view"]
fn zero_configuration_home_source_and_parent_without_setup() {
    const CASE: &str =
        "environment::fork_tests::zero_configuration_home_source_and_parent_without_setup";
    const FIXTURE: &str = "GRAPHER_ZERO_CONFIG_HOME_FIXTURE";
    if std::env::var_os(FIXTURE).is_none() {
        let temp = tempfile::tempdir().unwrap();
        let origin = temp.path().join("source-home");
        fs::create_dir_all(origin.join(".config/example-tool")).unwrap();
        fs::write(
            origin.join(".config/example-tool/defaults"),
            "source-default",
        )
        .unwrap();
        fs::write(
            origin.join("unrequested-sensitive-file"),
            "fixture-canary-not-for-persistence",
        )
        .unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                CASE,
                "--nocapture",
                "--test-threads=1",
            ])
            .env(FIXTURE, &origin)
            .env("HOME", &origin)
            .env("USERPROFILE", &origin)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Zero-configuration source/parent HOME inheritance is NOT accepted:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let origin = PathBuf::from(std::env::var_os(FIXTURE).unwrap());
    let business = r#"
const fs0=await import('node:fs'); const path0=await import('node:path');
const phase=typeof name==='string'?name:'source';
const home0=process.env.HOME;
const config0=path0.join(home0,'.config/example-tool/defaults');
const actual0=fs0.readFileSync(config0,'utf8');
const expected0=phase==='source'||phase==='A'?'source-default':'from-A';
if(actual0!==expected0) throw Error('ordinary HOME discovery lost source or latest parent: '+phase+': '+actual0);
if(phase!=='source') fs0.writeFileSync(config0,'from-'+phase);
fs0.writeFileSync(path0.join(home0,'run-state'),phase);
console.log(actual0);
"#;
    let (_temp, source, mut runtime) = setup(
        graph(&["A", "B", "C"], &[("A", "B", false), ("A", "C", false)]),
        automatic_home(),
        business,
    );
    let output = Command::new(crate::native::trusted_node().unwrap())
        .args(["--input-type=module", "-e", business])
        .current_dir(&source)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "source workflow must work first: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let a = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &a); // No query helper, setup config, tool paths or source-HOME override.
    let branches = runtime.jobs().unwrap();
    assert_eq!(branches.len(), 2);
    assert_ne!(
        branches[0].execution.worktree,
        branches[1].execution.worktree
    );
    for branch in &branches {
        run(&mut runtime, branch);
    }
    assert_eq!(
        fs::read_to_string(origin.join(".config/example-tool/defaults")).unwrap(),
        "source-default"
    );
    assert_eq!(
        fs::read_to_string(origin.join("run-state")).unwrap(),
        "source"
    );
    for branch in &branches {
        assert_eq!(
            fs::read_to_string(home(&runtime, &branch.execution.worktree).join("run-state"))
                .unwrap(),
            branch.execution.node
        );
    }
    // A lazy read layer must not turn an unrequested source HOME into bulk E.
    for entry in fs::read_dir(store(&runtime).directory.join("files/blobs")).unwrap() {
        assert_ne!(
            fs::read(entry.unwrap().path()).unwrap(),
            b"fixture-canary-not-for-persistence"
        );
    }
}

#[test]
fn unbound_home_fork_inherits_latest_bytes_and_keeps_branch_retries_independent() {
    let (_temp, source, mut runtime) = setup(
        graph(
            &["A", "B", "C", "D", "E"],
            &[
                ("A", "B", false),
                ("A", "C", false),
                ("C", "D", false),
                ("C", "E", false),
            ],
        ),
        automatic_home(),
        r#"
const home=process.env.HOME;
fs.mkdirSync(home,{recursive:true});
const marker=home+'/business-state';
const {execFileSync}=await import('node:child_process');
const read=()=>execFileSync(process.execPath,['-e',"process.stdout.write(require('node:fs').readFileSync(require('node:path').join(require('node:os').homedir(),'business-state'),'utf8'))"],{env:process.env,encoding:'utf8'});
if(name==='A') {
  fs.writeFileSync(marker,'A');
  fs.mkdirSync(home+'/cache',{recursive:true});
  fs.writeFileSync(home+'/cache/ephemeral','not inherited');
} else if(name==='C') {
  if(!fs.existsSync(home+'/partial')) {
    if(read()!=='A') throw Error('C lost parent HOME');
    if(fs.existsSync(home+'/cache/ephemeral')) throw Error('cache copied into independent branch');
    fs.writeFileSync(marker,'partial-C');
    fs.writeFileSync(home+'/partial','retry keeps this');
    process.exit(9);
  }
  if(read()!=='partial-C') throw Error('retry reset partial HOME');
  fs.writeFileSync(marker,'C');
} else {
  const expected=name==='B'?'A':'C';
  if(read()!==expected) throw Error('latest upstream HOME not inherited: '+name);
  fs.writeFileSync(marker,name);
}
fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/'+name+'.txt',name);
"#,
    );
    let a = runtime.jobs().unwrap().remove(0);
    run(&mut runtime, &a);
    let original = runtime.state.executions[0].result.clone().unwrap();
    let branches = runtime.jobs().unwrap();
    assert_eq!(branches.len(), 2);
    let b = branches
        .iter()
        .find(|job| job.execution.node == "B")
        .unwrap();
    let c = branches
        .iter()
        .find(|job| job.execution.node == "C")
        .unwrap();
    assert_ne!(b.execution.worktree, c.execution.worktree);
    assert_eq!(b.execution.worktree, a.execution.worktree);
    assert_eq!(
        c.environment_input.as_ref().unwrap().environment_ref,
        original.environment_ref,
        "fresh unbound branches must receive the parent's latest E, not the initial empty E"
    );
    assert_eq!(
        c.environment_input
            .as_ref()
            .unwrap()
            .inheritance
            .as_ref()
            .unwrap()
            .reason,
        "unbound-home-fork"
    );
    run(&mut runtime, b);
    let root = runtime.root.clone();
    let outcome = perform(
        c,
        &root,
        &[],
        |_| {},
        |head| {
            runtime.emit(EventKind::Prepared {
                execution_id: c.execution.id.clone(),
                head,
            })
        },
    );
    assert!(
        outcome.is_err(),
        "fixture deliberately fails after its partial HOME write"
    );
    runtime.finish(&c.execution, outcome).unwrap();
    assert_eq!(
        fs::read_to_string(home(&runtime, &c.execution.worktree).join("business-state")).unwrap(),
        "partial-C"
    );
    assert_eq!(
        fs::read_to_string(home(&runtime, &b.execution.worktree).join("business-state")).unwrap(),
        "B"
    );
    let failed = runtime
        .state
        .executions
        .iter()
        .find(|execution| execution.id == c.execution.id)
        .unwrap()
        .clone();
    runtime
        .intervene("C", "retry without resetting private state")
        .unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.preserve_failed_environment);
    assert_eq!(retry.execution.worktree, c.execution.worktree);
    run(&mut runtime, &retry);
    let latest = runtime.state.nodes["C"].result.clone().unwrap();
    let children = runtime.jobs().unwrap();
    assert_eq!(children.len(), 2);
    assert_ne!(
        children[0].execution.worktree,
        children[1].execution.worktree
    );
    for child in &children {
        assert_eq!(
            child.environment_input.as_ref().unwrap().environment_ref,
            latest.environment_ref
        );
        run(&mut runtime, child);
    }
    for child in &children {
        assert_eq!(
            fs::read_to_string(home(&runtime, &child.execution.worktree).join("business-state"))
                .unwrap(),
            child.execution.node
        );
    }
    let env = store(&runtime);
    assert_eq!(env.load_record(&a.execution.id, "after").unwrap(), original);
    assert_eq!(
        runtime
            .state
            .executions
            .iter()
            .find(|execution| execution.id == c.execution.id)
            .unwrap()
            .input,
        failed.input
    );
    let replay = runtime.store.load(&runtime.state.run_id).unwrap();
    assert_eq!(replay.executions[0].result.as_ref(), Some(&original));
    assert!(replay.executions.iter().any(|execution| execution
        .input
        .as_ref()
        .and_then(|input| input.inheritance.as_ref())
        .is_some_and(|decision| decision.reason == "unbound-home-fork")));
    assert!(
        !source.join(".agent-home").exists(),
        "private HOME gains no source-delivery channel"
    );
    assert!(!source.join("business-state").exists());
}

#[test]
fn unbound_home_fork_fanin_uses_only_a_common_descendant_or_current_local_input() {
    let (temp, env, baseline, a) = fixture();
    let c_path = next_path(&a, "C");
    workspace::prepare(&temp.path().join("source"), &c_path, &a.code_ref, &[]).unwrap();
    let c_input = selected(&env, &baseline, &[("A", &a)], &c_path, None);
    let c = env
        .prepare(
            &c_path,
            &c_input,
            &Uuid::new_v4().to_string(),
            &a.code_ref,
            vec![],
            false,
            false,
        )
        .unwrap();
    let c = advance(&env, &c, "C");
    let b = advance(&env, &a, "B");
    let target = next_path(&a, "join");
    for inputs in [vec![("A", &a), ("B", &b)], vec![("B", &b), ("A", &a)]] {
        let join = selected(&env, &baseline, &inputs, &target, None);
        assert_eq!(
            join.environment_ref, b.environment_ref,
            "select ancestry, not parent ordering"
        );
        assert_eq!(join.inheritance.unwrap().reason, "unbound-home-fork");
    }
    for inputs in [vec![("B", &b), ("C", &c)], vec![("C", &c), ("B", &b)]] {
        let join = selected(&env, &baseline, &inputs, &target, None);
        assert_eq!(
            join.environment_ref, baseline.environment_ref,
            "independent HOME changes have no automatic merge authority"
        );
        assert_eq!(join.inheritance.unwrap().reason, "unbound-inputs");
        let local = selected(&env, &baseline, &inputs, &c_path, Some(&c));
        assert_eq!(local.environment_ref, c.environment_ref);
        assert_eq!(local.inheritance.unwrap().reason, "same-layout");
    }
    // An existing target keeps its current state even if it is not a direct
    // input. HOME forking cannot turn an unbound fallback into a rollback.
    let local = selected(&env, &baseline, &[("B", &b)], &c_path, Some(&c));
    assert_eq!(local.environment_ref, baseline.environment_ref);
    env.prepare(
        &c_path,
        &local,
        &Uuid::new_v4().to_string(),
        &c.code_ref,
        vec![],
        false,
        false,
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(
            env.state_root(&c_path)
                .unwrap()
                .join(".agent-home/business-state")
        )
        .unwrap(),
        "C"
    );
}

#[test]
fn unbound_home_fork_does_not_adopt_owned_prefixes_extra_state_or_legacy_coverage() {
    for case in ["prefix", "outside-home", "legacy", "launch-change"] {
        let (_temp, env, baseline, a) = fixture();
        let path = Path::new(a.layout.as_deref().unwrap());
        let state = env.state_root(path).unwrap();
        let mut input = env
            .prepare(
                path,
                &a,
                &Uuid::new_v4().to_string(),
                &a.code_ref,
                vec![],
                false,
                false,
            )
            .unwrap();
        match case {
            "prefix" => {
                let mut launch = env.load_launch(&input.launch_ref).unwrap();
                launch
                    .owned_scopes
                    .as_mut()
                    .unwrap()
                    .push(EnvironmentScope {
                        root: "state".into(),
                        path: "inactive-env".into(),
                    });
                input.launch_ref = env.launch(&launch).unwrap();
                fs::create_dir(state.join("inactive-env")).unwrap();
                fs::write(
                    state.join("inactive-env/native"),
                    "not relocatable evidence",
                )
                .unwrap();
            }
            "outside-home" => {
                fs::create_dir_all(state.join(".venv")).unwrap();
                fs::write(state.join(".venv/native"), "not HOME state").unwrap();
            }
            "launch-change" => {
                let mut launch = env.load_launch(&input.launch_ref).unwrap();
                launch
                    .variables
                    .insert("CUSTOM_SETUP".into(), "explicit".into());
                input.launch_ref = env.launch(&launch).unwrap();
            }
            _ => {}
        }
        let mut candidate = env.seal(path, &input, &a.code_ref, vec![]).unwrap();
        if case == "legacy" {
            let version = Uuid::new_v4().to_string();
            env.files.capture(&state, &version, "", &[]).unwrap();
            candidate.environment_ref = version;
        }
        let target = next_path(&a, "fresh");
        let fallback = selected(&env, &baseline, &[("A", &candidate)], &target, None);
        assert_eq!(fallback.environment_ref, baseline.environment_ref, "{case}");
        assert_ne!(
            fallback.inheritance.unwrap().reason,
            "unbound-home-fork",
            "{case}"
        );
        assert!(
            !target.exists(),
            "selection is metadata-only and creates no target"
        );
    }
}

#[test]
fn unbound_home_fork_review_occupied_target_keeps_running_without_resetting_it() {
    let (temp, env, baseline, a) = fixture();
    let path = next_path(&a, "fresh");
    let input = selected(&env, &baseline, &[("A", &a)], &path, None);
    workspace::prepare(&temp.path().join("source"), &path, &a.code_ref, &[]).unwrap();
    let home = env.state_root(&path).unwrap().join(".agent-home");
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("business-state"), "unexplained partial work").unwrap();
    let prepared = env
        .prepare(
            &path,
            &input,
            &Uuid::new_v4().to_string(),
            &a.code_ref,
            vec![],
            false,
            false,
        )
        .unwrap();
    assert_eq!(
        prepared.inheritance.as_ref().unwrap().reason,
        "unbound-home-target-preserved"
    );
    assert_ne!(prepared.environment_ref, a.environment_ref);
    let launch = env
        .load_launch(&prepared.launch_ref)
        .unwrap()
        .expanded(&path);
    let mut command = Command::new(native::trusted_node().unwrap());
    command.current_dir(&path).args(["-p", "require('node:fs').readFileSync(require('node:path').join(require('node:os').homedir(),'business-state'),'utf8')"]);
    clean_command(&mut command, &launch, None).unwrap();
    assert_eq!(
        String::from_utf8(controlled_output(command).unwrap())
            .unwrap()
            .trim(),
        "unexplained partial work"
    );
    assert_eq!(
        fs::read_to_string(home.join("business-state")).unwrap(),
        "unexplained partial work"
    );
    assert_eq!(
        fs::read_to_string(path.join("code.txt")).unwrap(),
        "project"
    );
    env.validate_result(&a).unwrap();
}

#[test]
fn unbound_home_fork_review_target_protection_is_not_a_diagnostic_string_policy() {
    let (temp, env, baseline, a) = fixture();
    let path = next_path(&a, "fresh");
    let mut input = selected(&env, &baseline, &[("A", &a)], &path, None);
    input.inheritance = None;
    workspace::prepare(&temp.path().join("source"), &path, &a.code_ref, &[]).unwrap();
    let home = env.state_root(&path).unwrap().join(".agent-home");
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("business-state"), "retained target").unwrap();
    let prepared = env
        .prepare(
            &path,
            &input,
            &Uuid::new_v4().to_string(),
            &a.code_ref,
            vec![],
            false,
            false,
        )
        .unwrap();
    assert_eq!(
        fs::read_to_string(home.join("business-state")).unwrap(),
        "retained target"
    );
    assert_eq!(
        prepared.inheritance.unwrap().reason,
        "unbound-home-target-preserved"
    );
}

#[test]
fn unbound_home_fork_review_explicit_restoration_is_not_blocked_by_old_fork_provenance() {
    let (temp, env, baseline, a) = fixture();
    let path = next_path(&a, "restore");
    let input = selected(&env, &baseline, &[("A", &a)], &path, None);
    workspace::prepare(&temp.path().join("source"), &path, &a.code_ref, &[]).unwrap();
    let home = env.state_root(&path).unwrap().join(".agent-home");
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("business-state"), "intentionally rolled back").unwrap();
    let restored = env
        .prepare(
            &path,
            &input,
            &Uuid::new_v4().to_string(),
            &a.code_ref,
            vec![],
            false,
            true,
        )
        .unwrap();
    assert_eq!(restored.environment_ref, a.environment_ref);
    assert_eq!(
        fs::read_to_string(home.join("business-state")).unwrap(),
        "A"
    );
}

#[test]
fn unbound_home_fork_review_only_the_selected_descendant_needs_forkable_bytes() {
    let (_temp, env, baseline, a) = fixture();
    let path = Path::new(a.layout.as_deref().unwrap());
    let state = env.state_root(path).unwrap();
    let prepared = env
        .prepare(
            path,
            &a,
            &Uuid::new_v4().to_string(),
            &a.code_ref,
            vec![],
            false,
            false,
        )
        .unwrap();
    fs::create_dir_all(state.join(".env")).unwrap();
    fs::write(state.join(".env/ordinary-data"), "older non-HOME data").unwrap();
    let older = env.seal(path, &prepared, &a.code_ref, vec![]).unwrap();
    let prepared = env
        .prepare(
            path,
            &older,
            &Uuid::new_v4().to_string(),
            &a.code_ref,
            vec![],
            false,
            false,
        )
        .unwrap();
    fs::remove_file(state.join(".env/ordinary-data")).unwrap();
    fs::write(state.join(".agent-home/business-state"), "latest").unwrap();
    let latest = env.seal(path, &prepared, &a.code_ref, vec![]).unwrap();
    for inputs in [
        vec![("old", &older), ("latest", &latest)],
        vec![("latest", &latest), ("old", &older)],
        vec![("empty", &baseline), ("latest", &latest)],
    ] {
        let fork = selected(&env, &baseline, &inputs, &next_path(&a, "join"), None);
        assert_eq!(
            fork.environment_ref, latest.environment_ref,
            "an older ineligible frame must not discard the proven latest HOME"
        );
        assert_eq!(fork.inheritance.unwrap().reason, "unbound-home-fork");
    }
    // Equal byte refs cannot order conflicting launches. Removing the all-input
    // eligibility restriction must not make input order choose launch authority.
    let mut other = latest.clone();
    let mut launch = env.load_launch(&other.launch_ref).unwrap();
    launch
        .variables
        .insert("CUSTOM_SETUP".into(), "different launch".into());
    other.launch_ref = env.launch(&launch).unwrap();
    for inputs in [
        vec![("current", &latest), ("other", &other)],
        vec![("other", &other), ("current", &latest)],
    ] {
        let fork = selected(&env, &baseline, &inputs, &next_path(&a, "join"), None);
        assert_eq!(fork.environment_ref, baseline.environment_ref);
    }
}

#[test]
fn unbound_home_fork_review_respects_the_frozen_descendant_rule() {
    let mut config = automatic_home();
    config.allow_descendant = false;
    let (_temp, env, baseline, a) = fixture_with_config(config);
    let b = advance(&env, &a, "B");
    let target = next_path(&a, "join");
    let independent = selected(&env, &baseline, &[("A", &a), ("B", &b)], &target, None);
    assert_eq!(independent.environment_ref, baseline.environment_ref);
    let identical = selected(
        &env,
        &baseline,
        &[("B", &b), ("B-again", &b)],
        &target,
        None,
    );
    assert_eq!(identical.environment_ref, b.environment_ref);
}

#[test]
fn unbound_home_fork_rebases_internal_links_and_leaves_target_caches_untouched() {
    let (temp, env, baseline, a) = fixture();
    let parent = Path::new(a.layout.as_deref().unwrap());
    let input = env
        .prepare(
            parent,
            &a,
            &Uuid::new_v4().to_string(),
            &a.code_ref,
            vec![],
            false,
            false,
        )
        .unwrap();
    let parent_home = env.state_root(parent).unwrap().join(".agent-home");
    fs::create_dir(parent_home.join("real")).unwrap();
    fs::write(parent_home.join("real/value"), "recorded").unwrap();
    crate::path_safety::directory_link(&parent_home.join("real"), &parent_home.join("linked"));
    let a = env.seal(parent, &input, &a.code_ref, vec![]).unwrap();
    // Fork from immutable bytes, not a copy of the live parent tree.
    fs::write(parent_home.join("real/value"), "later live parent").unwrap();
    let path = next_path(&a, "fresh");
    let input = selected(&env, &baseline, &[("A", &a)], &path, None);
    assert_eq!(
        input.inheritance.as_ref().unwrap().reason,
        "unbound-home-fork"
    );
    workspace::prepare(&temp.path().join("source"), &path, &a.code_ref, &[]).unwrap();
    let home = env.state_root(&path).unwrap().join(".agent-home");
    fs::create_dir_all(home.join("cache")).unwrap();
    fs::write(home.join("cache/value"), "target cache").unwrap();
    let copied = env
        .prepare(
            &path,
            &input,
            &Uuid::new_v4().to_string(),
            &a.code_ref,
            vec![],
            false,
            false,
        )
        .unwrap();
    assert_eq!(copied.environment_ref, a.environment_ref);
    assert_eq!(
        fs::read_to_string(home.join("linked/value")).unwrap(),
        "recorded"
    );
    assert!(crate::path_identity::same_path(
        &home.join("linked"),
        &home.join("real")
    ));
    fs::write(home.join("linked/value"), "child only").unwrap();
    assert_eq!(
        fs::read_to_string(home.join("real/value")).unwrap(),
        "child only"
    );
    assert_eq!(
        fs::read_to_string(parent_home.join("real/value")).unwrap(),
        "later live parent"
    );
    assert_eq!(
        fs::read_to_string(home.join("cache/value")).unwrap(),
        "target cache"
    );
    env.validate_result(&a).unwrap();
}

#[test]
fn unbound_home_fork_missing_parent_bytes_are_not_repaired_from_the_live_parent() {
    let (temp, env, baseline, a) = fixture();
    let manifest_path = env
        .directory
        .join("files/versions")
        .join(format!("{}.json", a.environment_ref));
    let manifest = fs::read(&manifest_path).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
    let blob = value["rooted"]["roots"]["state"]["entries"][".agent-home/business-state"]["blob"]
        .as_str()
        .unwrap();
    let blob_path = env.directory.join("files/blobs").join(blob);
    fs::remove_file(&blob_path).unwrap();
    let path = next_path(&a, "fresh");
    let input = selected(&env, &baseline, &[("A", &a)], &path, None);
    workspace::prepare(&temp.path().join("source"), &path, &a.code_ref, &[]).unwrap();
    let error = env
        .prepare(
            &path,
            &input,
            &Uuid::new_v4().to_string(),
            &a.code_ref,
            vec![],
            false,
            false,
        )
        .unwrap_err();
    assert!(error.contains("Missing workspace file blob"), "{error}");
    assert!(!blob_path.exists());
    assert_eq!(fs::read(&manifest_path).unwrap(), manifest);
    assert_eq!(
        fs::read_to_string(
            env.state_root(Path::new(a.layout.as_deref().unwrap()))
                .unwrap()
                .join(".agent-home/business-state")
        )
        .unwrap(),
        "A"
    );
    assert!(!env
        .state_root(&path)
        .unwrap()
        .join(".agent-home/business-state")
        .exists());
    // Preserving a pre-existing target is not a bypass for missing input
    // history, even when those live bytes could reproduce the missing blob.
    let home = env.state_root(&path).unwrap().join(".agent-home");
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("business-state"), "A").unwrap();
    let error = env
        .prepare(
            &path,
            &input,
            &Uuid::new_v4().to_string(),
            &a.code_ref,
            vec![],
            false,
            false,
        )
        .unwrap_err();
    assert!(error.contains("Missing workspace file blob"), "{error}");
    assert!(!blob_path.exists());
    assert_eq!(
        fs::read_to_string(home.join("business-state")).unwrap(),
        "A"
    );
}
