//! Graph workspace admission starts with an empty business-environment binding.
//! No project type guessing, eager venv, downloads, user choices or source activation.
use crate::{
    environment::{self, EnvironmentConfig, LaunchConfig},
    native, workspace,
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Command,
};
fn text(path: &Path) -> String {
    native::host_path(path).to_string_lossy().replace('\\', "/")
}
pub(crate) fn business_path(source: &Path, value: &std::ffi::OsStr) -> Result<Vec<String>, String> {
    std::env::split_paths(value)
        .map(|path| {
            if let Some(mapped) = environment::project_path_template(&path, source) {
                return Ok(mapped);
            }
            // Missing, relative and empty entries are meaningful native PATH
            // entries. Keep their spelling/order; do not resolve toolchain shims.
            native::host_path(&path)
                .into_os_string()
                .into_string()
                .map_err(|_| "Business PATH must be UTF-8; refusing lossy tool selection".into())
        })
        .collect()
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
    let mut path = business_path(
        &source,
        &std::env::var_os("PATH").ok_or("Native bootstrap PATH unavailable")?,
    )?;
    let node = native::trusted_node()?;
    if workspace::scope_contains(&node, &source) {
        return Err("Trusted Node must be outside the business project".into());
    }
    let git = native::trusted_git()?;
    if workspace::scope_contains(&git, &source) {
        return Err("Trusted Git must be outside the business project".into());
    }
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
    // Engine Node/Git/Bash are invoked by absolute path. Their installations
    // must not take precedence over the user's business-tool search order.
    let mut bootstrap = vec![
        text(shell.parent().ok_or("Missing Bash directory")?),
        text(node.parent().ok_or("Missing Node directory")?),
    ];
    if cfg!(windows) {
        let root = shell
            .parent()
            .and_then(Path::parent)
            .ok_or("Missing Git root")?;
        bootstrap.extend([text(&root.join("usr/bin")), text(&root.join("mingw64/bin"))]);
    }
    for directory in bootstrap {
        if !path.iter().any(|existing| {
            if cfg!(windows) {
                existing.eq_ignore_ascii_case(&directory)
            } else {
                existing == &directory
            }
        }) {
            path.push(directory);
        }
    }
    let proof = r#"const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto'),path=require('node:path');
const [git,shell]=process.argv.slice(1);
const probe=(exe,args)=>({path:exe,sha256:crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),output:cp.execFileSync(exe,args,{encoding:'utf8',timeout:30000}).trim()});
const directories=[];let directory='',quoted=false;for(const character of process.env.PATH){if(process.platform==='win32'&&character==='"')quoted=!quoted;else if(character===path.delimiter&&!quoted){directories.push(directory);directory='';}else directory+=character;}directories.push(directory);
const tools=[];for(const directory of directories){for(const name of process.platform==='win32'?['python.exe','python3.exe','conda.exe']:['python3','python','conda']){const file=path.join(directory,name);if(fs.existsSync(file)&&fs.statSync(file).isFile())tools.push({path:file,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});}}
console.log(JSON.stringify({node:probe(process.execPath,['-p','JSON.stringify(process.versions)']),git:probe(git,['--version']),shell:probe(shell,['--noprofile','--norc','--version']),tools}));"#;
    let mut caches = vec![".runtime-cache".to_string()];
    if cfg!(windows) {
        // The redirected HOME/USERPROFILE collects Windows and browser local
        // caches here (INetCache, D3DSCache, Chrome/Edge profiles, crash dumps).
        // They are machine-local and must not enter environment snapshots.
        caches.push(".agent-home/AppData/Local".to_string());
        caches.push(".agent-home/npm-cache".to_string());
    } else {
        caches.push(".agent-home/.cache".to_string());
        caches.push(".agent-home/.npm".to_string());
    }
    let config = EnvironmentConfig {
        mode: "native-workspace".into(),
        platform: environment::platform().into(),
        arch: std::env::consts::ARCH.into(),
        // These are ownership/exclusion boundaries, not pre-created environments.
        scopes: vec![".venv".into(), ".environments".into(), ".agent-home".into()],
        caches,
        layout: "fixed".into(),
        launch: LaunchConfig {
            entry: text(&shell),
            shell: text(&shell),
            unbound_path: Some(path.clone()),
            path,
            variables: BTreeMap::from([
                ("HOME".into(), "{state}/.agent-home".into()),
                ("USERPROFILE".into(), "{state}/.agent-home".into()),
                (
                    "APPDATA".into(),
                    "{state}/.agent-home/AppData/Roaming".into(),
                ),
                (
                    "LOCALAPPDATA".into(),
                    "{state}/.agent-home/AppData/Local".into(),
                ),
                (
                    "XDG_CONFIG_HOME".into(),
                    "{state}/.agent-home/.config".into(),
                ),
                (
                    "XDG_DATA_HOME".into(),
                    "{state}/.agent-home/.local/share".into(),
                ),
                ("XDG_CACHE_HOME".into(), "{state}/.runtime-cache/xdg".into()),
                (
                    "npm_config_cache".into(),
                    "{state}/.runtime-cache/npm".into(),
                ),
                ("PIP_CACHE_DIR".into(), "{state}/.runtime-cache/pip".into()),
                ("CONDA_ENVS_PATH".into(), "{state}/.environments".into()),
                (
                    "CONDA_PKGS_DIRS".into(),
                    "{state}/.runtime-cache/conda".into(),
                ),
                ("PYTHONUTF8".into(), "1".into()),
                ("PYTHONIOENCODING".into(), "utf-8".into()),
                ("CONDA_ALWAYS_COPY".into(), "true".into()),
            ]),
            inherit: vec![
                "CONDA_ENVS_PATH".into(),
                "CONDA_PKGS_DIRS".into(),
                "CONDARC".into(),
                "CONDA_PREFIX".into(),
                "CONDA_DEFAULT_ENV".into(),
                "CONDA_SHLVL".into(),
            ],
            inherit_ambient: true,
            managed_scopes: vec![],
            owned_scopes: Some(vec![]),
            ambient_hints: vec![],
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
        best_effort: true,
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
    fn automatic_unbound_launch_preserves_host_business_path_precedence() {
        let source = project();
        let policy = resolve(source.path(), false).unwrap().0.unwrap();
        assert!(policy.launch.inherit_ambient);
        assert!(!policy.launch.requires_entry_first());
        assert_eq!(policy.launch.owned_scopes, Some(vec![]));
        let expected: Vec<_> = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|directory| {
                environment::project_path_template(&directory, source.path())
                    .unwrap_or_else(|| native::host_path(&directory).to_string_lossy().into_owned())
            })
            .collect();
        assert!(
            policy.launch.path.starts_with(&expected),
            "bootstrap bins must not outrank host tools"
        );
        assert_eq!(
            policy.launch.unbound_path.as_ref(),
            Some(&policy.launch.path)
        );
        assert!(Path::new(&policy.launch.shell).is_absolute());
        assert!(policy.launch.environment.is_none());
    }

    #[test]
    fn business_path_rebinds_project_roots_without_dropping_native_search_entries() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("project space");
        let external = temp.path().join("external");
        fs::create_dir_all(source.join("tools")).unwrap();
        fs::create_dir_all(&external).unwrap();
        let alias = temp.path().join("project-alias");
        let subdir_alias = temp.path().join("tools-alias");
        let external_alias = temp.path().join("external-alias");
        crate::path_safety::directory_link(&source, &alias);
        crate::path_safety::directory_link(&source.join("tools"), &subdir_alias);
        crate::path_safety::directory_link(&external, &external_alias);
        crate::path_safety::directory_link(&external, &source.join("linked-external"));
        let paths = vec![
            source.join("tools"),
            alias.join("tools"),
            subdir_alias,
            source.clone(),
            source.join("future/bin"),
            PathBuf::from("relative-bin"),
            PathBuf::from(""),
            PathBuf::from("../shared-bin"),
            external_alias.clone(),
            external.join("not-installed-yet"),
            source.join("linked-external/bin"),
            source.join("../external"),
        ];
        let path = business_path(&source, &std::env::join_paths(&paths).unwrap()).unwrap();
        assert_eq!(
            &path[..8],
            [
                "{workspace}/tools",
                "{workspace}/tools",
                "{workspace}/tools",
                "{workspace}",
                "{workspace}/future/bin",
                "relative-bin",
                "",
                "../shared-bin",
            ]
        );
        assert_eq!(Path::new(&path[8]), external_alias);
        assert_eq!(Path::new(&path[9]), external.join("not-installed-yet"));
        assert_eq!(path[10], "{workspace}/linked-external/bin");
        assert_eq!(Path::new(&path[11]), source.join("../external"));
    }

    #[test]
    fn automatic_baseline_hashes_tools_in_semicolon_path_entries() {
        let source = project();
        let data = tempfile::tempdir().unwrap();
        let tools = data.path().join("native;tools");
        fs::create_dir_all(&tools).unwrap();
        let python = tools.join(if cfg!(windows) {
            "python.exe"
        } else {
            "python"
        });
        // The bootstrap inventory hashes these bytes; it must never execute
        // this deliberately non-executable fixture as a Python interpreter.
        fs::write(&python, "native-probe-before").unwrap();
        let mut policy = resolve(source.path(), false).unwrap().0.unwrap();
        policy.launch.path.insert(0, text(&tools));
        policy.launch.unbound_path = Some(policy.launch.path.clone());
        let store =
            environment::Environments::new(data.path(), &uuid::Uuid::new_v4().to_string(), &policy)
                .unwrap();
        let before = store.baseline().unwrap();
        fs::write(&python, "native-probe-after!").unwrap();
        let after = store.baseline().unwrap();
        assert_ne!(
            before.baseline, after.baseline,
            "a quoted PATH component must not disappear from bootstrap evidence"
        );
        assert_eq!(before.policy, after.policy);
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
                id: "A".into(),
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
