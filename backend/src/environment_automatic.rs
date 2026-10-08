//! New Graph Runs start with an empty business-environment binding. No project
//! type guessing, eager venv, downloads, user choices or activation of source.
use crate::{
    environment::{self, EnvironmentConfig, LaunchConfig},
    native, workspace,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    process::Command,
};
fn text(path: &Path) -> String {
    native::host_path(path).to_string_lossy().replace('\\', "/")
}
fn executable(paths: &[PathBuf], name: &str) -> Result<PathBuf, String> {
    for directory in paths {
        let path = directory.join(name);
        if path.is_file() {
            return path
                .canonicalize()
                .map(|path| native::host_path(&path))
                .map_err(|e| e.to_string());
        }
    }
    Err(format!(
        "Native bootstrap tool unavailable: {name}; no installation/OS fallback"
    ))
}
pub(crate) fn resolve(
    source: &Path,
    serial: bool,
) -> Result<(Option<EnvironmentConfig>, String), String> {
    if serial {
        return Ok((None, "Serial retains source-native execution".into()));
    }
    if !workspace::is_standard_git(source) {
        return Ok((
            None,
            "Shadow project retains its existing native resource contract".into(),
        ));
    }
    let source = source
        .canonicalize()
        .map(|path| native::host_path(&path))
        .map_err(|e| e.to_string())?;
    let mut paths = Vec::new();
    let mut seen = BTreeSet::new();
    for path in
        std::env::split_paths(&std::env::var_os("PATH").ok_or("Native bootstrap PATH unavailable")?)
    {
        if !path.is_absolute() || !path.is_dir() {
            continue;
        }
        let path = path
            .canonicalize()
            .map(|path| native::host_path(&path))
            .map_err(|e| e.to_string())?;
        if workspace::scope_contains(&path, &source) {
            continue;
        }
        let key = if cfg!(windows) {
            text(&path).to_lowercase()
        } else {
            text(&path)
        };
        if seen.insert(key) {
            paths.push(path);
        }
    }
    let node = native::trusted_node()?;
    if workspace::scope_contains(&node, &source) {
        return Err("Trusted Node must be outside the business project".into());
    }
    let git = executable(&paths, if cfg!(windows) { "git.exe" } else { "git" })?;
    let shell = if cfg!(windows) {
        let mut command = Command::new(&git);
        command.arg("--exec-path").env_clear();
        for key in ["SystemRoot", "WINDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let output = environment::controlled_output(command)?;
        let path = PathBuf::from(String::from_utf8(output).map_err(|e| e.to_string())?.trim());
        path.ancestors()
            .nth(3)
            .ok_or("Invalid native Git installation")?
            .join("bin/bash.exe")
    } else {
        PathBuf::from("/bin/bash")
    };
    if !shell.is_file() {
        return Err("Native bootstrap Bash is unavailable; no substitute".into());
    }
    let mut path = vec![
        text(shell.parent().ok_or("Missing Bash directory")?),
        text(node.parent().ok_or("Missing Node directory")?),
    ];
    path.extend(paths.iter().map(|p| text(p)));
    if cfg!(windows) {
        let root = shell
            .parent()
            .and_then(Path::parent)
            .ok_or("Missing Git root")?;
        path.extend([text(&root.join("usr/bin")), text(&root.join("mingw64/bin"))]);
    }
    let proof = r#"const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto'),path=require('node:path');
const [git,shell]=process.argv.slice(1);
const probe=(exe,args)=>({path:exe,sha256:crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),output:cp.execFileSync(exe,args,{encoding:'utf8',timeout:30000}).trim()});
const tools=[];for(const directory of process.env.PATH.split(path.delimiter)){for(const name of process.platform==='win32'?['python.exe','python3.exe','conda.exe']:['python3','python','conda']){const file=path.join(directory,name);if(fs.existsSync(file)&&fs.statSync(file).isFile())tools.push({path:file,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});}}
console.log(JSON.stringify({node:probe(process.execPath,['-p','JSON.stringify(process.versions)']),git:probe(git,['--version']),shell:probe(shell,['--noprofile','--norc','--version']),tools}));"#;
    let config = EnvironmentConfig {
        mode: "native-workspace".into(),
        platform: environment::platform().into(),
        arch: std::env::consts::ARCH.into(),
        // These are ownership/exclusion boundaries, not pre-created environments.
        scopes: vec![".venv".into(), ".environments".into(), ".agent-home".into()],
        caches: vec![".runtime-cache".into()],
        layout: "fixed".into(),
        launch: LaunchConfig {
            entry: text(&shell),
            shell: text(&shell),
            path,
            variables: BTreeMap::from([
                ("HOME".into(), "{workspace}/.agent-home".into()),
                ("USERPROFILE".into(), "{workspace}/.agent-home".into()),
                (
                    "PYTHONPYCACHEPREFIX".into(),
                    "{workspace}/.runtime-cache/pycache".into(),
                ),
                ("PYTHONUTF8".into(), "1".into()),
                ("PYTHONIOENCODING".into(), "utf-8".into()),
                ("CONDA_ENVS_PATH".into(), "{workspace}/.environments".into()),
                (
                    "CONDA_PKGS_DIRS".into(),
                    "{workspace}/.runtime-cache/c".into(),
                ),
                ("CONDA_ALWAYS_COPY".into(), "true".into()),
            ]),
            inherit: vec![],
            hook: None,
            environment: None,
        },
        baseline: vec![
            text(&node),
            "-e".into(),
            proof.into(),
            text(&git),
            text(&shell),
        ],
        initialize: vec![],
        import_source: false,
        launch_file: None,
        authority: BTreeMap::new(),
        allow_descendant: true,
        require: vec![
            "fixed-layout".into(),
            "basic-snapshots".into(),
            "private-copies".into(),
            "process-drain".into(),
        ],
        resources: None,
        discovery: true,
    };
    config.validate()?;
    config.check_tracked(&source)?;
    Ok((Some(config), "Lazy native environment tracking: empty binding, business-created private environments only".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn project() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        git2::Repository::init(temp.path()).unwrap();
        temp
    }
    #[test]
    fn empty_python_conda_and_non_ml_projects_all_start_without_creating_or_selecting_an_environment(
    ) {
        let source = project();
        for file in [
            None,
            Some("pyproject.toml"),
            Some("environment.yml"),
            Some("uv.lock"),
            Some("package.json"),
        ] {
            if let Some(file) = file {
                fs::write(source.path().join(file), "").unwrap();
            }
            let (policy, _) = resolve(source.path(), false).unwrap();
            let policy = policy.unwrap();
            assert!(policy.discovery);
            assert!(policy.initialize.is_empty());
            assert!(policy.launch.environment.is_none());
            assert!(!policy.import_source);
            assert!(policy.authority.is_empty());
            assert!(policy.launch_file.is_none());
            assert!(!source.path().join(".venv").exists());
        }
    }
    #[test]
    fn automatic_policy_events_replay_without_changing_legacy_runs_or_allowing_stale_policy_replacement(
    ) {
        use crate::{model::*, store::Store};
        let data = tempfile::tempdir().unwrap();
        let store = Store::open(&data.path().join("events.sqlite")).unwrap();
        let source = project();
        let config: Config = serde_json::from_value(
            serde_json::json!({"repository":source.path(),"model":"test/local","maxParallel":2}),
        )
        .unwrap();
        let mut state = Snapshot {
            run_id: uuid::Uuid::new_v4().to_string(),
            ..Default::default()
        };
        store
            .append(
                &mut state,
                EventKind::Created {
                    graph: Graph::default(),
                    config,
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();
        assert!(store
            .load(&state.run_id)
            .unwrap()
            .environment_policy
            .is_none());
        store
            .append(&mut state, EventKind::EnvironmentPolicyRequested)
            .unwrap();
        let (environment, reason) = resolve(source.path(), false).unwrap();
        store
            .append(
                &mut state,
                EventKind::EnvironmentPolicyResolved {
                    environment: environment.clone(),
                    reason,
                },
            )
            .unwrap();
        let replay = store.load(&state.run_id).unwrap();
        assert_eq!(replay.environment_policy.as_deref(), Some("automatic-lazy"));
        assert_eq!(
            crate::snapshot_view::snapshot_metadata(&replay).unwrap()["environmentPolicy"],
            "automatic-lazy"
        );
        let checkpoint: Snapshot =
            serde_json::from_value(crate::snapshot_view::checkpoint_projection(&replay)).unwrap();
        assert_eq!(checkpoint.config.unwrap().environment, environment);
        store
            .append(&mut state, EventKind::EnvironmentPolicyRequested)
            .unwrap();
        store
            .append(
                &mut state,
                EventKind::EnvironmentPolicyResolved {
                    environment: None,
                    reason: "stale".into(),
                },
            )
            .unwrap();
        assert_eq!(
            store
                .load(&state.run_id)
                .unwrap()
                .config
                .unwrap()
                .environment,
            environment
        );
    }
    #[cfg(feature = "fixture")]
    #[test]
    fn automatic_draft_policy_is_preserved_when_unrelated_client_settings_omit_it() {
        use crate::{model::*, runtime::Runtime};
        let data = tempfile::tempdir().unwrap();
        let source = project();
        let config: Config = serde_json::from_value(serde_json::json!({"repository":source.path(),"model":"test/local","maxParallel":2,"piCommand":native::trusted_node().unwrap()})).unwrap();
        let graph = Graph {
            original_goal: "draft policy".into(),
            nodes: vec![Node {
                name: "A".into(),
                task: "business".into(),
            }],
            edges: vec![],
        };
        let mut runtime = Runtime::open(data.path()).unwrap();
        runtime.create(graph.clone(), config.clone()).unwrap();
        runtime.emit(EventKind::EnvironmentPolicyRequested).unwrap();
        let (environment, reason) = resolve(source.path(), false).unwrap();
        runtime
            .emit(EventKind::EnvironmentPolicyResolved {
                environment: environment.clone(),
                reason,
            })
            .unwrap();
        runtime
            .edit_draft_graph(graph.clone(), config.clone())
            .unwrap();
        assert_eq!(
            runtime.state.config.as_ref().unwrap().environment,
            environment
        );
        runtime
            .save_default_config(runtime.state.config.as_ref().unwrap())
            .unwrap();
        let defaults: Config =
            serde_json::from_slice(&fs::read(data.path().join("config.json")).unwrap()).unwrap();
        assert!(defaults.environment.is_none());
        assert_eq!(
            runtime.state.config.as_ref().unwrap().environment,
            environment
        );
        let mut injected = config;
        injected.environment = environment;
        injected.environment.as_mut().unwrap().discovery = false;
        assert!(runtime
            .edit_draft_graph(graph, injected)
            .unwrap_err()
            .contains("Runtime-owned"));
    }
    #[test]
    fn serial_and_shadow_projects_preserve_their_existing_native_contract() {
        let source = project();
        assert!(resolve(source.path(), true).unwrap().0.is_none());
        fs::remove_dir_all(source.path().join(".git")).unwrap();
        assert!(resolve(source.path(), false).unwrap().0.is_none());
    }
}
