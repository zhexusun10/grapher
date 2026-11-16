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

#[test]
fn ambient_launch_preserves_business_values_through_backend_binding_and_real_bash() {
    let temp = tempfile::tempdir().unwrap();
    let startup = temp.path().join("startup.sh");
    fs::write(&startup, "export GTEST_STARTUP=ready\n").unwrap();
    let binding = temp.path().join("launch.json");
    let adapter = native::installation_root().join("engine/launch-binding.mjs");
    for inherit_ambient in [false, true] {
        let mut launch = policy().launch;
        launch.inherit_ambient = inherit_ambient;
        launch.inherit.push("GTEST_AUTHORIZED".into());
        launch.variables.insert("HOME".into(), temp.path().to_string_lossy().into());
        let serialized = serde_json::to_vec(&launch).unwrap();
        fs::write(&binding, &serialized).unwrap();
        let mut ambient: BTreeMap<_, _> = std::env::vars_os().collect();
        for (key, value) in [
            ("GTEST_BUSINESS", "business-secret-not-persisted"),
            ("GTEST_AUTHORIZED", "authorized-secret-not-persisted"),
            ("GTEST_REMOVED", "remove-me"),
            ("HTTPS_PROXY", "http://proxy.invalid:9000"),
            ("SSL_CERT_FILE", "business-cert.pem"),
            ("PYTHONPATH", "business-modules"),
            ("GIT_ASKPASS", "host-credential-helper"),
            ("GIT_DIR", "/wrong-repository"),
            ("NODE_OPTIONS", "--stack-trace-limit=37"),
            ("NODE_PATH", "business-node-modules"),
            ("GRAPHER_MODE", "outer-agent"),
            ("PI_SESSION_ID", "outer-session"),
            ("HOME", "/wrong-home"),
            ("PYTHONDONTWRITEBYTECODE", "0"),
        ] {
            ambient.insert(key.into(), value.into());
        }
        // Explicitly avoid external loader/startup hooks in this native probe.
        ambient.retain(|key, _| {
            let key = key.to_string_lossy().to_ascii_uppercase();
            !key.starts_with("LD_") && !key.starts_with("DYLD_")
                && !matches!(key.as_str(), "ENV" | "BASH_ENV")
        });
        ambient.insert("BASH_ENV".into(), startup.as_os_str().into());
        let mut command = Command::new(native::trusted_node().unwrap());
        command.current_dir(temp.path()).args(["--input-type=module", "-e", r#"
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const {applyLaunchBinding,managedLaunch,managedBashOptions,managedBashCommand}=await import(pathToFileURL(process.argv[1]));
if(process.env.NODE_OPTIONS||process.env.NODE_PATH) throw Error('Business Node settings reached engine startup');
applyLaunchBinding();
if(process.env.NODE_OPTIONS||process.env.NODE_PATH) throw Error('Business Node settings reached factories');
const keys=['GTEST_BUSINESS','GTEST_AUTHORIZED','GTEST_REMOVED','HTTPS_PROXY','SSL_CERT_FILE','PYTHONPATH','GIT_ASKPASS','GIT_DIR','NODE_OPTIONS','NODE_PATH','GRAPHER_MODE','PI_SESSION_ID','HOME','PYTHONDONTWRITEBYTECODE','GTEST_STARTUP'];
const code=`console.log(JSON.stringify({...Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]??null])),limit:Error.stackTraceLimit}))`;
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const options=managedBashOptions({env:{...process.env}},true);
process.stdout.write(execFileSync(managedLaunch().shell,['--noprofile','--norc','-c',managedBashCommand(quote(process.execPath.replaceAll('\\','/'))+' -e '+quote(code),process.cwd())],{...options,encoding:'utf8'}));
"#]).arg(&adapter).env("GRAPHER_MODE", "node").env_remove("GTEST_REMOVED");
        clean_command_with_environment(&mut command, &launch, Some(&binding), ambient).unwrap();
        let output = command.output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let values: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        for (key, expected) in [
            ("GTEST_BUSINESS", "business-secret-not-persisted"),
            ("HTTPS_PROXY", "http://proxy.invalid:9000"),
            ("SSL_CERT_FILE", "business-cert.pem"),
            ("PYTHONPATH", "business-modules"),
            ("GIT_ASKPASS", "host-credential-helper"),
            ("GTEST_STARTUP", "ready"),
            ("NODE_OPTIONS", "--stack-trace-limit=37"),
            ("NODE_PATH", "business-node-modules"),
        ] {
            assert_eq!(values[key], if inherit_ambient { serde_json::json!(expected) } else { serde_json::Value::Null }, "{key}");
        }
        assert_eq!(values["GTEST_AUTHORIZED"], "authorized-secret-not-persisted");
        if inherit_ambient { assert_eq!(values["limit"], 37); }
        for key in ["GTEST_REMOVED", "GIT_DIR", "GRAPHER_MODE", "PI_SESSION_ID"] {
            assert!(values[key].is_null(), "{key}: {}", values[key]);
        }
        assert!(crate::path_identity::same_path(Path::new(values["HOME"].as_str().unwrap()), temp.path()));
        assert_eq!(values["PYTHONDONTWRITEBYTECODE"], "1");
        assert_eq!(serde_json::to_vec(&launch).unwrap(), serialized);
        assert!(!String::from_utf8(serialized).unwrap().contains("secret-not-persisted"));
    }
}

#[test]
fn ambient_business_node_settings_defer_overrides_and_honor_explicit_removal() {
    let mut launch = policy().launch;
    launch.inherit_ambient = true;
    let mut command = Command::new(native::trusted_node().unwrap());
    command.env_remove(if cfg!(windows) { "nOdE_OpTiOnS" } else { "NODE_OPTIONS" })
        .env("NODE_PATH", "explicit-modules");
    clean_command_with_environment(&mut command, &launch, Some(Path::new("binding.json")), [
        ("NODE_OPTIONS".into(), "--stack-trace-limit=37".into()),
        ("NODE_PATH".into(), "old-modules".into()),
    ].into_iter().collect()).unwrap();
    let values: BTreeMap<_, _> = command.get_envs().filter_map(|(key, value)| value.map(|value|
        (key.to_string_lossy().into_owned(), value.to_string_lossy().into_owned()))).collect();
    assert!(!values.keys().any(|key| matches!(key.to_ascii_uppercase().as_str(), "NODE_OPTIONS" | "NODE_PATH")));
    assert_eq!(serde_json::from_str::<serde_json::Value>(&values["GRAPHER_BUSINESS_NODE_ENV"]).unwrap(),
        serde_json::json!({"NODE_PATH":"explicit-modules"}));
}

#[test]
fn project_activated_python_path_and_markers_follow_the_private_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source project");
    fs::create_dir_all(&source).unwrap();
    git2::Repository::init(&source).unwrap();
    let prefix = source.join("tools/custom-python");
    let python = python();
    let mut create = Command::new(&python);
    create.args(["-m", "venv", "--without-pip"]).arg(&prefix).env("PYTHONDONTWRITEBYTECODE", "1");
    controlled_output(create).unwrap();
    let bin = if cfg!(windows) { "Scripts" } else { "bin" };
    let modules = source.join("extra-node-modules");
    fs::create_dir_all(modules.join("from-project")).unwrap();
    fs::write(modules.join("from-project/index.js"), "module.exports='private-snapshot';\n").unwrap();
    let python_modules = source.join("python-src");
    fs::create_dir_all(&python_modules).unwrap();
    fs::write(python_modules.join("snapshot_module.py"), "VALUE = 'private-snapshot'\n").unwrap();
    let startup = source.join("shell-startup.sh");
    fs::write(&startup, "export GTEST_PROJECT_STARTUP=private-snapshot\n").unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = temp.path().join(".grapher-worktrees/project-path/node");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    fs::write(modules.join("from-project/index.js"), "module.exports='source-later';\n").unwrap();
    fs::write(python_modules.join("snapshot_module.py"), "VALUE = 'source-later'\n").unwrap();
    fs::write(&startup, "export GTEST_PROJECT_STARTUP=source-later\n").unwrap();
    let mut source_command = Command::new(&python);
    source_command.current_dir(&source).env_remove("PYTHONHOME").env("PYTHONPATH", &python_modules)
        .args(["-B", "-c", "import snapshot_module; print(snapshot_module.VALUE)"]);
    assert_eq!(String::from_utf8(controlled_output(source_command).unwrap()).unwrap().trim(), "source-later");
    let config = crate::environment_automatic::resolve(&source, false).unwrap().0.unwrap();
    let mut launch = config.launch;
    let mut paths = vec![prefix.join(bin), source.join("future-tools")];
    paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
    launch.path = crate::environment_automatic::business_path(&source, &std::env::join_paths(paths).unwrap()).unwrap();
    launch.unbound_path = Some(launch.path.clone());
    let launch = launch.expanded(&node);
    let binding = temp.path().join("launch.json");
    fs::write(&binding, serde_json::to_vec(&launch).unwrap()).unwrap();
    let mut ambient: BTreeMap<_, _> = std::env::vars_os().collect();
    ambient.insert("VIRTUAL_ENV".into(), prefix.as_os_str().into());
    ambient.insert("CONDA_PREFIX".into(), prefix.as_os_str().into());
    ambient.insert("CONDA_DEFAULT_ENV".into(), "business-name".into());
    ambient.insert("NODE_PATH".into(), modules.as_os_str().into());
    ambient.insert("PYTHONPATH".into(), python_modules.as_os_str().into());
    ambient.insert("BASH_ENV".into(), startup.as_os_str().into());
    ambient.remove(std::ffi::OsStr::new("NODE_OPTIONS"));
    ambient.remove(std::ffi::OsStr::new("ENV"));
    ambient.remove(std::ffi::OsStr::new("PYTHONHOME"));
    let mut command = Command::new(native::trusted_node().unwrap());
    command.current_dir(&node).args(["--input-type=module", "-e", r#"
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const {applyLaunchBinding,managedLaunch,managedBashOptions,managedBashCommand,managedBusinessEnvironment}=await import(pathToFileURL(process.argv[1]));
applyLaunchBinding();
const code="import json,os,sys,snapshot_module; print(json.dumps({'prefix':sys.prefix,'virtual':os.environ['VIRTUAL_ENV'],'conda':os.environ['CONDA_PREFIX'],'name':os.environ['CONDA_DEFAULT_ENV'],'pythonModule':snapshot_module.VALUE,'pythonFile':snapshot_module.__file__,'startup':os.environ['GTEST_PROJECT_STARTUP']}))";
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const python=JSON.parse(execFileSync(managedLaunch().shell,['--noprofile','--norc','-c',managedBashCommand('python -c '+quote(code),process.cwd())],{env:managedBashOptions({env:{...process.env}},true).env,encoding:'utf8'}));
const module=execFileSync(process.execPath,['-e',"process.stdout.write(require('from-project'))"],{env:managedBusinessEnvironment(),encoding:'utf8'});
console.log(JSON.stringify({...python,module}));
"#]).arg(native::installation_root().join("engine/launch-binding.mjs"))
        .env("GRAPHER_ORIGINAL_ROOT", &source).env("GRAPHER_WORKSPACE_ROOT", &node);
    clean_command_with_environment(&mut command, &launch, Some(&binding), ambient).unwrap();
    let values: serde_json::Value = serde_json::from_slice(&controlled_output(command).unwrap()).unwrap();
    for key in ["prefix", "virtual", "conda"] {
        assert!(crate::path_identity::same_path(Path::new(values[key].as_str().unwrap()), &node.join("tools/custom-python")), "{key}: {}", values[key]);
    }
    assert_eq!(values["name"], "business-name");
    assert_eq!(values["module"], "private-snapshot", "NODE_PATH must not import today's source files");
    assert_eq!(values["pythonModule"], "private-snapshot", "PYTHONPATH must not import today's source files");
    assert_eq!(values["startup"], "private-snapshot", "BASH_ENV must not execute today's source script");
    assert_eq!(fs::read_to_string(&startup).unwrap(), "export GTEST_PROJECT_STARTUP=source-later\n");
    assert!(crate::path_identity::same_path(Path::new(values["pythonFile"].as_str().unwrap()), &node.join("python-src/snapshot_module.py")));
    assert!(!source.join("future-tools").exists());
    assert!(!node.join("future-tools").exists());
}

#[test]
fn project_package_config_paths_follow_latest_private_bytes_not_live_source() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source project");
    fs::create_dir_all(source.join("config")).unwrap();
    git2::Repository::init(&source).unwrap();
    let write_config = |root: &Path, value: u32| {
        fs::write(root.join("config/pip.ini"), format!("[global]\ntimeout = {value}\n")).unwrap();
        fs::write(root.join("config/npmrc"), format!("fetch-timeout={value}000\n")).unwrap();
    };
    write_config(&source, 17);
    let base = workspace::snapshot_repository(&source).unwrap();
    let config = crate::environment_automatic::resolve(&source, false).unwrap().0.unwrap();
    let mut ambient: BTreeMap<_, _> = std::env::vars_os().collect();
    // Explicit disposable project files, not a host configuration/HOME import.
    ambient.retain(|name, _| {
        let name = name.to_string_lossy().to_ascii_uppercase();
        !name.starts_with("PIP_") && !name.starts_with("NPM_CONFIG_")
            && !name.starts_with("LD_") && !name.starts_with("DYLD_")
            && !matches!(name.as_str(), "BASH_ENV" | "ENV" | "NODE_OPTIONS" | "NODE_PATH" | "PYTHONHOME" | "PYTHONPATH")
    });
    ambient.insert("PIP_CONFIG_FILE".into(), source.join("config/pip.ini").into_os_string());
    ambient.insert("npm_config_userconfig".into(), source.join("config/npmrc").into_os_string());
    ambient.insert("npm_config_cache".into(), temp.path().join("source-npm-cache").into_os_string());
    ambient.insert("npm_config_offline".into(), "true".into());
    ambient.insert("npm_config_update_notifier".into(), "false".into());
    ambient.insert("PYTHONUTF8".into(), "1".into());
    ambient.insert("PYTHONIOENCODING".into(), "utf-8".into());
    let python_command = if cfg!(windows) { "python" } else { "python3" };
    // `config list` reads pip's effective merged config; `config get` selects
    // a write-oriented file kind and does not include PIP_CONFIG_FILE values.
    let business = format!("{python_command} -m pip config list && npm config get fetch-timeout");
    let execute = |root: &Path, private: bool| -> Vec<String> {
        let mut command;
        if private {
            let launch = config.launch.expanded(root);
            let serialized = serde_json::to_vec(&launch).unwrap();
            let binding = temp.path().join("launch.json");
            fs::write(&binding, &serialized).unwrap();
            command = Command::new(native::trusted_node().unwrap());
            command.current_dir(root).args(["--input-type=module", "-e", r#"
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const {applyLaunchBinding,managedLaunch,managedBashOptions,managedBashCommand}=await import(pathToFileURL(process.argv[1]));
applyLaunchBinding();
process.stdout.write(execFileSync(managedLaunch().shell,['--noprofile','--norc','-c',managedBashCommand(process.argv[2],process.cwd())],{env:managedBashOptions({env:{...process.env}},true).env,encoding:'utf8'}));
"#]).arg(native::installation_root().join("engine/launch-binding.mjs")).arg(&business)
                .env("GRAPHER_ORIGINAL_ROOT", &source).env("GRAPHER_WORKSPACE_ROOT", root);
            clean_command_with_environment(&mut command, &launch, Some(&binding), ambient.clone()).unwrap();
            assert_eq!(serde_json::to_vec(&launch).unwrap(), serialized, "business config paths are transient, not new L");
        } else {
            command = Command::new(&config.launch.shell);
            command.current_dir(root).env_clear().envs(&ambient)
                .args(["--noprofile", "--norc", "-c", &business]);
        }
        let output = String::from_utf8(controlled_output(command).unwrap()).unwrap();
        let timeout = output.lines().find_map(|line| line.strip_prefix("global.timeout=")).expect("pip must read the project config");
        vec![timeout.trim_matches('\'').into(), output.lines().last().unwrap().trim().into()]
    };
    assert_eq!(execute(&source, false), ["17", "17000"]);
    write_config(&source, 91);
    let a = temp.path().join(".grapher-worktrees/config-paths/A");
    workspace::prepare(&source, &a, &base, &[]).unwrap();
    assert_eq!(execute(&a, true), ["17", "17000"], "private commands must not read today's source config");
    write_config(&a, 23);
    let latest = workspace::snapshot_node(&a, &source, "A").unwrap();
    let b = temp.path().join(".grapher-worktrees/config-paths/B");
    workspace::prepare(&source, &b, &latest, &[]).unwrap();
    assert_eq!(execute(&b, true), ["23", "23000"], "downstream must read A's latest config");
    let historical = temp.path().join(".grapher-worktrees/config-paths/history");
    workspace::prepare(&source, &historical, &base, &[]).unwrap();
    assert_eq!(execute(&historical, true), ["17", "17000"]);
    assert_eq!(execute(&source, false), ["91", "91000"]);
}

#[test]
fn project_config_and_startup_paths_preserve_external_values_overrides_and_legacy_rules() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let target = temp.path().join("target");
    let alias = temp.path().join("source-alias");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&target).unwrap();
    crate::path_safety::directory_link(&source, &alias);
    let text = |path: &Path| path.to_string_lossy().into_owned();
    let mut launch = policy().launch;
    launch.inherit_ambient = true;
    for automatic in [false, true] {
        launch.unbound_path = automatic.then(|| launch.path.clone());
        for name in ["BASH_ENV", "ENV", "PIP_CONFIG_FILE", "npm_config_userconfig", "NPM_CONFIG_USERCONFIG"] {
            let key = if cfg!(windows) { name.to_ascii_lowercase() } else { name.to_string() };
            for (value, mapped) in [
                (text(&source.join("startup.sh")), Some(text(&target.join("startup.sh")))),
                (text(&alias.join("future.sh")), Some(text(&target.join("future.sh")))),
                (text(&temp.path().join("host-startup.sh")), None),
                (text(&source.join("missing/../startup.sh")), None),
                (format!("\"{}\"", text(&source.join("startup.sh"))), None),
                (if cfg!(windows) { "NUL" } else { "/dev/null" }.into(), None),
                ("startup.sh".into(), None),
                ("$HOME/startup.sh".into(), None),
                (String::new(), None),
            ] {
                let mut command = Command::new(&launch.entry);
                command.env("GRAPHER_ORIGINAL_ROOT", &source).env("GRAPHER_WORKSPACE_ROOT", &target).env(&key, &value);
                clean_command_with_environment(&mut command, &launch, Some(Path::new("binding.json")),
                    [(name.into(), "ambient-not-the-override".into())].into_iter().collect()).unwrap();
                let actual = command.get_envs().find(|(name, _)| name.to_string_lossy().eq_ignore_ascii_case(&key))
                    .unwrap().1.unwrap().to_str().unwrap();
                let expected = if automatic { mapped.unwrap_or(value) } else { value };
                assert_eq!(actual.replace('\\', "/"), expected.replace('\\', "/"), "{name}");
            }
            let mut removed = Command::new(&launch.entry);
            removed.env("GRAPHER_ORIGINAL_ROOT", &source).env("GRAPHER_WORKSPACE_ROOT", &target).env_remove(&key);
            clean_command_with_environment(&mut removed, &launch, Some(Path::new("binding.json")),
                [(name.into(), source.join("startup.sh").into_os_string())].into_iter().collect()).unwrap();
            assert!(!removed.get_envs().any(|(name, value)| name.to_string_lossy().eq_ignore_ascii_case(&key) && value.is_some()));
        }
    }
}

#[test]
fn native_business_paths_do_not_relax_entry_or_legacy_validation() {
    let mut launch = policy().launch;
    launch.path = vec!["relative-bin".into(), String::new()];
    assert!(launch.validate().is_err());
    launch.unbound_path = Some(launch.path.clone());
    launch.validate().unwrap();
    let entry = launch.entry.clone();
    launch.entry = "relative-entry".into();
    assert!(launch.validate().is_err());
    launch.entry = entry;
    launch.unbound_path = Some(vec![]);
    assert!(launch.validate().is_err());
    launch.unbound_path = Some(vec!["bad\0path".into()]);
    assert!(launch.validate().is_err());
}

#[test]
fn recovery_runtime_locations_do_not_add_business_launch_compatibility_conditions() {
    let mut left = policy().launch;
    let root = std::env::temp_dir();
    left.environment = Some(serde_json::from_value(serde_json::json!({
        "kind":"venv","prefix":"env","abi":"0".repeat(40),"root":"workspace",
        "runtimeEvidence":{"schema":1,"roots":{"workspace":root.join("entry-a")},
            "files":[{"location":"external","path":root.join("native-input"),"blob":"0".repeat(40)}]}
    })).unwrap());
    let mut right = left.clone();
    let mut metadata = serde_json::to_value(right.environment.as_ref().unwrap()).unwrap();
    metadata["runtimeEvidence"]["roots"]["workspace"] = serde_json::json!(root.join("entry-b"));
    right.environment = Some(serde_json::from_value(metadata).unwrap());
    assert_ne!(left, right, "immutable L still retains distinct per-entry evidence");
    assert!(left.same_business_launch(&right));
    right.environment.as_mut().unwrap().abi = "1".repeat(40);
    assert!(!left.same_business_launch(&right), "actual ABI/business criteria are unchanged");
    right = left.clone();
    right.path.push("different-business-search-path".into());
    assert!(!left.same_business_launch(&right));
}

#[test]
fn ambient_python_home_is_retained_only_without_a_verified_prefix() {
    let mut launch = policy().launch;
    launch.inherit_ambient = true;
    for bound in [false, true] {
        launch.environment = bound.then(|| crate::environment_discovery::Binding {
            kind: "venv".into(), prefix: "business-env".into(), abi: "0".repeat(40), root: Some("workspace".into()), runtime_evidence: None,
        });
        let mut command = Command::new(native::trusted_node().unwrap());
        clean_command_with_environment(&mut command, &launch, Some(Path::new("binding.json")),
            [("PYTHONHOME".into(), "host-python-home".into())].into_iter().collect()).unwrap();
        let home = command.get_envs().find(|(key, _)| *key == "PYTHONHOME").and_then(|(_, value)| value);
        assert_eq!(home.is_some(), !bound);
    }
}

#[test]
fn ambient_loader_values_are_deferred_and_explicit_removals_win() {
    let mut launch = policy().launch;
    launch.inherit_ambient = true;
    let mut command = Command::new(native::trusted_node().unwrap());
    command.env_remove("LD_PRELOAD").env("DYLD_LIBRARY_PATH", "/explicit-business-libs");
    let ambient = [
        ("LD_PRELOAD", "/must-not-load"),
        ("LD_LIBRARY_PATH", "/ambient-business-libs"),
        ("DYLD_LIBRARY_PATH", "/old-business-libs"),
    ].into_iter().map(|(k, v)| (k.into(), v.into())).collect();
    clean_command_with_environment(&mut command, &launch, Some(Path::new("binding.json")), ambient).unwrap();
    let values: BTreeMap<_, _> = command.get_envs().filter_map(|(k, v)| v.map(|v|
        (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))).collect();
    assert!(!values.contains_key("LD_PRELOAD"));
    assert!(!values.contains_key("LD_LIBRARY_PATH"));
    assert!(!values.contains_key("DYLD_LIBRARY_PATH"));
    let loaders: serde_json::Value = serde_json::from_str(&values["GRAPHER_BUSINESS_LOADER_ENV"]).unwrap();
    assert_eq!(loaders, serde_json::json!({
        "LD_LIBRARY_PATH": "/ambient-business-libs",
        "DYLD_LIBRARY_PATH": "/explicit-business-libs",
    }));
}

#[test]
fn ignored_sourceless_python_dependency_runs_in_source_and_private_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join(".gitignore"), "*.pyc\n").unwrap();
    fs::write(source.join("offline_dependency.py"), "VALUE = 'sourceless'\n").unwrap();
    fs::write(source.join("app.py"), "import offline_dependency\nprint(offline_dependency.VALUE)\n").unwrap();
    let python = python();
    let mut compile = Command::new(&python);
    compile.current_dir(&source).args(["-c", "import py_compile; py_compile.compile('offline_dependency.py', cfile='offline_dependency.pyc', doraise=True)"]);
    controlled_output(compile).unwrap();
    fs::remove_file(source.join("offline_dependency.py")).unwrap();
    let bytecode = fs::read(source.join("offline_dependency.pyc")).unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let node = temp.path().join(".grapher-worktrees/sourceless/node");
    workspace::prepare(&source, &node, &base, &[]).unwrap();
    for path in [&source, &node] {
        let mut command = Command::new(&python);
        command.current_dir(path).arg("app.py").env("PYTHONDONTWRITEBYTECODE", "1");
        assert_eq!(String::from_utf8(controlled_output(command).unwrap()).unwrap().trim(), "sourceless");
        assert_eq!(fs::read(path.join("offline_dependency.pyc")).unwrap(), bytecode);
        assert!(!path.join("offline_dependency.py").exists());
        assert!(!path.join("__pycache__").exists());
    }
    assert!(!source.join(".git").exists());
}

#[test]
fn tracked_scope_admission_uses_the_live_source_index_not_an_older_graph_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    workspace::git(&source, &["init", "-q"]).unwrap();
    fs::write(source.join("base.txt"), "base").unwrap();
    workspace::snapshot_repository(&source).unwrap();
    workspace::snapshot_repository(&source).unwrap(); // materialize a private Graph index
    fs::create_dir(source.join(".env")).unwrap();
    fs::write(source.join(".env/user.txt"), "user-owned tracked data").unwrap();
    workspace::git(&source, &["add", "-f", ".env/user.txt"]).unwrap();
    assert!(policy()
        .check_tracked(&source)
        .unwrap_err()
        .contains(".env/user.txt"));
}

pub(super) fn policy() -> EnvironmentConfig {
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
            unbound_path: None,
            shell: shell(),
            variables: BTreeMap::new(),
            inherit: vec![],
            inherit_ambient: false,
            managed_scopes: vec![],
            owned_scopes: None,
            ambient_hints: vec![],
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
        best_effort: false,
    }
}

/// State-bound variant of [`policy`] for fixtures that exercise the current
/// external process-state contract. `GTEST_STATE` is the `{state}` root the
/// agent must use instead of writing `.env`/`.cache` into the project tree.
#[cfg(feature = "fixture")]
pub(super) fn state_policy() -> EnvironmentConfig {
    let mut config = policy();
    config
        .launch
        .variables
        .insert("HOME".into(), "{state}/.agent-home".into());
    config
        .launch
        .variables
        .insert("GTEST_STATE".into(), "{state}".into());
    config
}

#[cfg(feature = "fixture")]
pub(super) fn graph(names: &[&str], edges: &[(&str, &str, bool)]) -> Graph {
    Graph {
        original_goal: "native environment test".into(),
        nodes: names
            .iter()
            .map(|name| Node {
                id: (*name).into(),
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
pub(super) fn setup(
    graph: Graph,
    policy: EnvironmentConfig,
    body: &str,
) -> (TempDir, PathBuf, Runtime) {
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
    workspace::git(&source, &["add", "-A"]).unwrap();
    workspace::git(&source, &["commit", "-q", "-m", "base"]).unwrap();
    let script = temp.path().join("agent.mjs");
    let binding = native::host_path(&native::installation_root().join("engine/launch-binding.mjs"))
        .to_string_lossy()
        .replace('\\', "/");
    fs::write(&script, format!("import {{applyLaunchBinding}} from {}; import fs from 'node:fs'; applyLaunchBinding();\nlet task=''; for await (const chunk of process.stdin) task+=chunk; const name=task.startsWith('Feedback:')?'A':task.split('\\n')[0];\nconst envRoot=process.env.GTEST_STATE?process.env.GTEST_STATE+'/.env':'.env'; fs.mkdirSync(envRoot,{{recursive:true}}); if(process.env.GTEST_STATE) fs.mkdirSync(process.env.GTEST_STATE+'/.cache',{{recursive:true}}); let response='Completed';\n{body}\nconsole.log(JSON.stringify({{type:'message_end',message:{{role:'assistant',content:[{{type:'text',text:response}}]}}}}));", serde_json::to_string(&format!("file:///{binding}")).unwrap())).unwrap();
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository": source, "model": "local/test", "maxParallel": 4, "maxFeedback": 1,
        "engine": "pi", "piCommand": native::trusted_node().unwrap(), "piArgs": [script], "environment": policy,
    })).unwrap();
    let mut runtime = Runtime::open(&temp.path().join("data")).unwrap();
    // Explicit E/L fixtures test private workspace mechanics, not adaptive admission.
    runtime.state.run_id = Uuid::new_v4().to_string();
    runtime.emit(EventKind::Created { graph, config, planning_id: None, planning: None }).unwrap();
    runtime.store.select_run(Some(&runtime.state.run_id)).unwrap();
    runtime.set_route("graph").unwrap();
    runtime.approve().unwrap();
    (temp, source, runtime)
}

#[cfg(feature = "fixture")]
pub(super) fn run(runtime: &mut Runtime, job: &Job) {
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

#[cfg(feature = "fixture")]
#[test]
fn shared_batch_cannot_launch_an_older_private_result() {
    let mut policy = state_policy();
    policy.best_effort = true;
    policy.discovery = true;
    // Four ready nodes cross the shared-source limit and select private work.
    let (_temp, source, mut runtime) = setup(graph(&["A", "B", "C", "D"], &[]), policy, "");
    // The fixture seeds frozen native E/L; exercise batch scheduling on that
    // real evidence rather than manufacturing a launchable descriptor.
    runtime.emit(EventKind::WorkspaceIsolationSelected { isolated: false }).unwrap();
    for job in runtime.jobs().unwrap() {
        run(&mut runtime, &job);
    }
    runtime.jobs().unwrap();
    let publication = runtime.state.publication.clone().unwrap();
    let head = crate::graph_merge::merge_graph_scoped(&source, &publication.heads,
        &runtime.exclusions().unwrap(), |_| Err("unexpected conflict".into())).unwrap();
    runtime.emit(EventKind::PublicationCompleted { head }).unwrap();
    runtime.jobs().unwrap();
    assert!(runtime.state.published_result.is_some());
    assert!(runtime.result_descriptor().is_ok());
    runtime.intervene("A", "update source code").unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    assert!(job.source_direct);
    fs::write(source.join("code.txt"), "new source version").unwrap();
    runtime.finish(&job.execution, Ok((String::new(), "done".into()))).unwrap();
    runtime.jobs().unwrap();
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    let error = match runtime.start_result_entry(&[], Some("A")) {
        Err(error) => error,
        Ok(_) => panic!("a shared-source update must not launch the previous private code/environment"),
    };
    assert!(error.contains("source"), "{error}");
    assert!(runtime.state.result_execution.is_none(), "refuse before reserving a result launch");
    assert!(runtime.result_descriptor().unwrap_err().contains("latest batch"));
    // Selecting private work again does not make the old descriptor current:
    // only a new ResultPublished can prove the new batch's code/E/L together.
    for node in ["A", "B", "C", "D"] { runtime.intervene(node, "new work").unwrap(); }
    let next = runtime.jobs().unwrap();
    assert_eq!(next.len(), 4);
    assert!(next.iter().all(|job| !job.source_direct));
    assert!(runtime.result_descriptor().unwrap_err().contains("latest batch"));
}

#[cfg(feature = "fixture")]
#[test]
fn batch_business_result_republishes_code_and_remains_launchable_after_restart() {
    fn publish(runtime: &mut Runtime, source: &Path) {
        assert_eq!(runtime.state.phase, "publishing");
        let publication = runtime.state.publication.clone().unwrap();
        let job = runtime.publication_environment_input().unwrap().unwrap();
        job.validate().unwrap();
        let head = crate::graph_merge::merge_graph_scoped(
            source, &publication.heads, &runtime.exclusions().unwrap(),
            |_| Err("unexpected publication conflict".into()),
        ).unwrap();
        if runtime.state.result_execution.is_some() {
            // Accept an unchanged prior publication in another private entry,
            // but still reject unrecorded mutations of that sealed project.
            let sibling = Path::new(job.inputs.last().unwrap().1.layout.as_deref().unwrap());
            let file = sibling.join("code.txt");
            let original = fs::read(&file).unwrap();
            fs::write(&file, "unrecorded private change").unwrap();
            let error = job.descriptor(&head).unwrap_err();
            assert!(error.contains("changed"), "{error}");
            assert_eq!(fs::read_to_string(&file).unwrap(), "unrecorded private change");
            fs::write(file, original).unwrap();
        }
        let descriptor = job.descriptor(&head).unwrap();
        runtime.emit_outputs(vec![
            EventKind::ResultPublished { descriptor },
            EventKind::PublicationCompleted { head },
        ]).unwrap();
        runtime.jobs().unwrap();
        assert_eq!(runtime.state.phase, "completed");
        runtime.result_descriptor().unwrap();
    }

    let mut policy = state_policy();
    policy.best_effort = true;
    policy.discovery = true;
    let (_temp, source, mut runtime) = setup(
        graph(&["A", "B", "C", "D"], &[]), policy,
        "fs.writeFileSync(`${name}.txt`, name);",
    );
    let source_head = workspace::git(&source, &["rev-parse", "HEAD"]).unwrap();
    let source_index = fs::read(source.join(".git/index")).unwrap();
    runtime.emit(EventKind::WorkspaceIsolationSelected { isolated: false }).unwrap();
    for job in runtime.jobs().unwrap() { run(&mut runtime, &job); }
    runtime.jobs().unwrap();
    publish(&mut runtime, &source);
    assert!(runtime.take_shared_workspace_review().unwrap().is_some());
    let historical_heads: Vec<_> = runtime.state.executions.iter()
        .map(|execution| execution.after.clone()).collect();

    for (entry, script) in [
        ("A", "from pathlib import Path; Path('business.txt').write_text('first output')"),
        ("B", "from pathlib import Path; p = Path('business.txt'); assert p.read_text() == 'first output'; p.write_text('second output')"),
    ] {
        let (job, control) = runtime.start_result_entry(&["-c".into(), script.into()], Some(entry)).unwrap();
        let outcome = crate::runtime::perform_result(&job, &control, |input|
            runtime.emit(EventKind::ResultExecutionPrepared { input }));
        runtime.finish_result(&job, &control, outcome).unwrap();
        let result_head = runtime.state.result_execution.as_ref().unwrap()
            .result.as_ref().unwrap().code_ref.clone();
        let root = runtime.root.clone();
        drop(runtime);
        runtime = Runtime::open(&root).unwrap();
        runtime.resume_scheduling().unwrap();
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.phase, "publishing");
        assert_eq!(runtime.state.publication.as_ref().unwrap().heads, [result_head.clone()]);
        assert!(runtime.start_result_entry(&[], Some(entry)).is_err());

        drop(runtime);
        runtime = Runtime::open(&root).unwrap();
        assert_eq!(runtime.state.phase, "publication_failed");
        runtime.retry_publication().unwrap();
        assert_eq!(runtime.state.publication.as_ref().unwrap().heads, [result_head]);
        publish(&mut runtime, &source);
        assert_eq!(fs::read_to_string(source.join("business.txt")).unwrap(),
            if entry == "A" { "first output" } else { "second output" });
        assert!(runtime.take_shared_workspace_review().unwrap().is_none());
        assert_eq!(runtime.state.executions.iter().map(|execution| execution.after.clone()).collect::<Vec<_>>(), historical_heads);
    }
    assert_eq!(workspace::git(&source, &["rev-parse", "HEAD"]).unwrap(), source_head);
    assert_eq!(fs::read(source.join(".git/index")).unwrap(), source_index);
    assert_eq!(runtime.state.events.iter().filter(|event|
        matches!(event.kind, EventKind::PublicationCompleted { .. })).count(), 3);
    runtime.state = runtime.store.load(&runtime.state.run_id).unwrap();
    runtime.result_descriptor().unwrap();
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "completed");
}

#[test]
fn ambient_environment_hints_use_non_authoritative_previous_agent_wording() {
    let mut launch = policy().launch;
    launch.ambient_hints = vec![crate::environment_discovery::AmbientEnvironmentHint {
        manager: "conda".into(),
        selector: "name:ml".into(),
        executable: "conda".into(),
    }];
    assert_eq!(
        super::previous_agent_environment_hints(&launch).as_deref(),
        Some("previous agent used: conda name:ml (conda)"),
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
        root: None,
        runtime_evidence: None,
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

#[test]
fn history_scope_checks_compare_snapshot_roots_not_project_exclusions() {
    let temp = tempfile::tempdir().unwrap();
    let mut config = policy();
    config.discovery = true;
    config.scopes = vec![".venv".into(), ".agent-home".into()];
    config.launch.variables.insert("HOME".into(), "{state}/.agent-home".into());
    config.launch.owned_scopes = Some(vec![]);
    let store = Environments::new(temp.path(), &Uuid::new_v4().to_string(), &config).unwrap();
    let empty = store.launch(&config.launch).unwrap();
    let bound = |root: &str, prefix: &str| {
        let mut launch = config.launch.clone();
        launch.environment = Some(crate::environment_discovery::Binding {
            kind: "venv".into(), prefix: prefix.into(), abi: "0".repeat(40), root: Some(root.into()), runtime_evidence: None,
        });
        launch.owned_scopes = Some(vec![EnvironmentScope { root: root.into(), path: prefix.into() }]);
        store.launch(&launch).unwrap()
    };
    let state = bound("state", ".venv");
    let project = bound("workspace", ".venv");
    assert!(store.exclusions(&state).unwrap().is_empty());
    store.validate_history_scopes(&state, &state).unwrap();
    store.validate_history_scopes(&empty, &state).unwrap();
    assert!(store.validate_history_scopes(&project, &project).unwrap_err().contains("state-root byte evidence"), "a W snapshot does not also capture private HOME in S");
    assert!(store.validate_history_scopes(&project, &state).is_err(), "equal relative names do not identify the same ownership root");
    assert!(store.validate_history_scopes(&state, &project).is_err());
    let custom = bound("state", "custom-env");
    store.validate_history_scopes(&custom, &custom).unwrap();
    assert!(store.validate_history_scopes(&empty, &custom).is_err());
    let mut unbound = config.launch.clone();
    unbound.owned_scopes = Some(vec![EnvironmentScope { root: "state".into(), path: "unbound-custom".into() }]);
    let unbound = store.launch(&unbound).unwrap();
    assert!(store.validate_history_scopes(&empty, &unbound).is_err(), "unbinding must not hide a captured dynamic scope from rollback validation");
}

#[test]
fn history_restores_recorded_unbound_state_scopes_without_touching_w_names_or_caches() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir_all(&source).unwrap();
    workspace::git(&source, &["init", "-q"]).unwrap();
    fs::write(source.join("business.txt"), "code").unwrap();
    let code = workspace::snapshot_repository(&source).unwrap();
    let path = temp.path().join(".grapher-worktrees/48b8e1d1-2428-42a2-9b28-9d90f631f9d1/node");
    workspace::prepare(&source, &path, &code, &[]).unwrap();
    let mut config = policy();
    config.discovery = true;
    config.scopes.push(".agent-home".into());
    config.launch.variables.insert("HOME".into(), "{state}/.agent-home".into());
    config.launch.owned_scopes = Some(vec![EnvironmentScope {
        root: "state".into(), path: "second-env".into(),
    }]);
    let store = Environments::new(temp.path(), &Uuid::new_v4().to_string(), &config).unwrap();
    let baseline = store.initialize(&source).unwrap();
    let input = store.prepare(&path, &baseline, &Uuid::new_v4().to_string(), &code, vec![], false, false).unwrap();
    let state = store.state_root(&path).unwrap();
    for name in [".env", "second-env", ".agent-home", ".cache"] {
        fs::create_dir_all(state.join(name)).unwrap();
        fs::write(state.join(name).join("value"), format!("recorded {name}")).unwrap();
    }
    let result = store.seal(&path, &input, &code, vec![]).unwrap();
    let historical_manifest = store.directory.join("files/versions").join(format!("{}.json", result.environment_ref));
    let historical_bytes = fs::read(&historical_manifest).unwrap();
    for name in [".env", "second-env", ".agent-home", ".cache"] {
        fs::write(state.join(name).join("value"), "later state").unwrap();
        fs::create_dir_all(path.join(name)).unwrap();
        fs::write(path.join(name).join("value"), "unrelated W bytes").unwrap();
    }
    fs::write(state.join("second-env/later-only"), "remove on rollback").unwrap();
    let restored = store.prepare(&path, &result, &Uuid::new_v4().to_string(), &code, vec![], false, true).unwrap();
    for name in [".env", "second-env", ".agent-home"] {
        assert_eq!(fs::read_to_string(state.join(name).join("value")).unwrap(), format!("recorded {name}"));
        assert_eq!(fs::read_to_string(path.join(name).join("value")).unwrap(), "unrelated W bytes");
    }
    assert!(!state.join("second-env/later-only").exists());
    assert_eq!(fs::read_to_string(state.join(".cache/value")).unwrap(), "later state");
    assert_eq!(fs::read(&historical_manifest).unwrap(), historical_bytes);
    assert!(store.load_launch(&restored.launch_ref).unwrap().environment.is_none());
    store.verify_view(&path, &restored.launch_ref, &restored.environment_ref).unwrap();
}

#[test]
fn history_rejects_unbound_other_root_ownership_without_touching_live_state_or_history() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir_all(&source).unwrap();
    workspace::git(&source, &["init", "-q"]).unwrap();
    fs::write(source.join("business.txt"), "recorded code").unwrap();
    let code = workspace::snapshot_repository(&source).unwrap();
    let path = temp.path().join(".grapher-worktrees/48b8e1d1-2428-42a2-9b28-9d90f631f9d1/node");
    workspace::prepare(&source, &path, &code, &[]).unwrap();
    let mut config = policy();
    config.discovery = true;
    config.launch.variables.insert("HOME".into(), "{state}/.agent-home".into());
    config.launch.owned_scopes = Some(vec![EnvironmentScope {
        root: "workspace".into(), path: "business-env".into(),
    }]);
    let store = Environments::new(temp.path(), &Uuid::new_v4().to_string(), &config).unwrap();
    let baseline = store.initialize(&source).unwrap();
    let generation = Uuid::new_v4().to_string();
    let input = store.prepare(&path, &baseline, &generation, &code, vec![], false, false).unwrap();
    let state = store.state_root(&path).unwrap();
    fs::create_dir_all(state.join(".env")).unwrap();
    fs::write(state.join(".env/value"), "recorded state").unwrap();
    let sealed = store.seal(&path, &input, &code, vec![]).unwrap();
    // Simulate an old single-root E without rewriting the newly sealed record.
    let legacy_version = Uuid::new_v4().to_string();
    store.scoped_files(&sealed.launch_ref).unwrap().capture(&state, &legacy_version, "", &[]).unwrap();
    let result = CompositeResult { environment_ref: legacy_version, ..sealed };
    let launch_bytes = fs::read(store.directory.join("launches").join(format!("{}.json", result.launch_ref))).unwrap();
    let manifest_path = store.directory.join("files/versions").join(format!("{}.json", result.environment_ref));
    let manifest_bytes = fs::read(&manifest_path).unwrap();
    fs::create_dir_all(path.join("business-env")).unwrap();
    fs::write(path.join("business-env/value"), "uncaptured W state").unwrap();
    fs::write(state.join(".env/value"), "partial S state").unwrap();
    let error = store.prepare(&path, &result, &Uuid::new_v4().to_string(), &code, vec![], false, true).unwrap_err();
    assert!(error.contains("workspace:business-env"), "{error}");
    assert_eq!(fs::read_to_string(path.join("business.txt")).unwrap(), "recorded code");
    assert_eq!(fs::read_to_string(path.join("business-env/value")).unwrap(), "uncaptured W state");
    assert_eq!(fs::read_to_string(state.join(".env/value")).unwrap(), "partial S state");
    assert_eq!(fs::read(manifest_path).unwrap(), manifest_bytes);
    assert_eq!(fs::read(store.directory.join("launches").join(format!("{}.json", result.launch_ref))).unwrap(), launch_bytes);
    // Reading/retrying the legacy single-root record is still supported; only
    // an unsupported whole-environment rollback is refused.
    store.validate_result(&result).unwrap();
}

#[test]
fn node_path_rebinding_preserves_nodes_literal_quote_semantics() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let target = temp.path().join("target");
    for (root, value) in [(&source, "source"), (&target, "private")] {
        for (directory, package) in [("modules", "ordinary"), ("quoted", "quoted-only")] {
            fs::create_dir_all(root.join(directory).join(package)).unwrap();
            fs::write(root.join(directory).join(package).join("index.js"), format!("module.exports='{value}';")).unwrap();
        }
    }
    let delimiter = if cfg!(windows) { ';' } else { ':' };
    // Node splits NODE_PATH on its delimiter; quotes are literal path bytes,
    // unlike Windows PATH. The quoted directory must stay non-resolving.
    let original = format!("\"{}\"{delimiter}{}", source.join("quoted").display(), source.join("modules").display());
    let expected = format!("\"{}\"{delimiter}{}", source.join("quoted").display(), target.join("modules").display());
    let mut launch = policy().launch;
    launch.inherit_ambient = true;
    launch.unbound_path = Some(launch.path.clone());
    let mut command = Command::new(native::trusted_node().unwrap());
    command.env("GRAPHER_ORIGINAL_ROOT", &source).env("GRAPHER_WORKSPACE_ROOT", &target);
    clean_command_with_environment(&mut command, &launch, Some(Path::new("binding.json")),
        [("NODE_PATH".into(), original.clone().into())].into_iter().collect()).unwrap();
    let encoded = command.get_envs().find(|(name, _)| *name == "GRAPHER_BUSINESS_NODE_ENV").unwrap().1.unwrap();
    let values: serde_json::Value = serde_json::from_str(encoded.to_str().unwrap()).unwrap();
    let private = values["NODE_PATH"].as_str().unwrap();
    assert_eq!(private.replace('\\', "/"), expected.replace('\\', "/"));
    for (root, path, expected_value) in [(&source, original.as_str(), "source"), (&target, private, "private")] {
        let mut child = Command::new(native::trusted_node().unwrap());
        child.current_dir(root).env_remove("NODE_OPTIONS").env("NODE_PATH", path)
            .args(["-e", "let quoted=false;try{require('quoted-only');quoted=true}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}console.log(JSON.stringify({ordinary:require('ordinary'),quoted}))"]);
        let output: serde_json::Value = serde_json::from_slice(&controlled_output(child).unwrap()).unwrap();
        assert_eq!(output, serde_json::json!({"ordinary":expected_value,"quoted":false}));
    }
}

#[test]
fn python_path_rebinding_preserves_literal_entries_overrides_and_legacy_rules() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let target = temp.path().join("target");
    let external = temp.path().join("external");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("external_module.py"), "VALUE = 'external'\n").unwrap();
    for (root, value) in [(&source, "source"), (&target, "private")] {
        for (directory, module) in [("modules", "ordinary_module"), ("quoted", "quoted_module"), ("relative", "relative_module")] {
            fs::create_dir_all(root.join(directory)).unwrap();
            fs::write(root.join(directory).join(format!("{module}.py")), format!("VALUE = '{value}'\n")).unwrap();
        }
    }
    let delimiter = if cfg!(windows) { ';' } else { ':' };
    let original = format!("\"{}\"{delimiter}{}{delimiter}{}{delimiter}relative{delimiter}{delimiter}{}",
        source.join("quoted").display(), source.join("modules").display(), external.display(), source.join("future").display());
    let rebased = format!("\"{}\"{delimiter}{}{delimiter}{}{delimiter}relative{delimiter}{delimiter}{}",
        source.join("quoted").display(), target.join("modules").display(), external.display(), target.join("future").display());
    let key = if cfg!(windows) { "pYtHoNpAtH" } else { "PYTHONPATH" };
    let mut launch = policy().launch;
    launch.inherit_ambient = true;
    for automatic in [false, true] {
        launch.unbound_path = automatic.then(|| launch.path.clone());
        let serialized = serde_json::to_vec(&launch).unwrap();
        let mut command = Command::new(&launch.entry);
        command.current_dir(&target).args(["-B", "-c",
            "import json,importlib.util,ordinary_module,external_module,relative_module; print(json.dumps([ordinary_module.VALUE,external_module.VALUE,relative_module.VALUE,importlib.util.find_spec('quoted_module') is None]))"])
            .env("GRAPHER_ORIGINAL_ROOT", &source).env("GRAPHER_WORKSPACE_ROOT", &target)
            .env(key, &original);
        let ambient = [("PYTHONPATH".into(), "not-the-explicit-value".into())].into_iter().collect();
        clean_command_with_environment(&mut command, &launch, Some(Path::new("binding.json")), ambient).unwrap();
        let effective = command.get_envs().find(|(name, _)| name.to_string_lossy().eq_ignore_ascii_case("PYTHONPATH"))
            .unwrap().1.unwrap().to_str().unwrap();
        assert_eq!(effective.replace('\\', "/"), (if automatic { &rebased } else { &original }).replace('\\', "/"));
        let output: serde_json::Value = serde_json::from_slice(&controlled_output(command).unwrap()).unwrap();
        assert_eq!(output, serde_json::json!([if automatic { "private" } else { "source" }, "external", "private", true]));
        assert_eq!(serde_json::to_vec(&launch).unwrap(), serialized, "transient values must not enter L");
    }
    let mut removed = Command::new(&launch.entry);
    removed.env("GRAPHER_ORIGINAL_ROOT", &source).env("GRAPHER_WORKSPACE_ROOT", &target).env_remove(key);
    clean_command_with_environment(&mut removed, &launch, Some(Path::new("binding.json")),
        [("PYTHONPATH".into(), original.into())].into_iter().collect()).unwrap();
    assert!(!removed.get_envs().any(|(name, value)| name.to_string_lossy().eq_ignore_ascii_case("PYTHONPATH") && value.is_some()));
}

#[test]
fn module_path_rebinding_refuses_unrepresentable_destination_components() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir_all(source.join("modules")).unwrap();
    let target = temp.path().join(if cfg!(windows) { "target;part" } else { "target:part" });
    fs::create_dir_all(&target).unwrap();
    let mut launch = policy().launch;
    launch.inherit_ambient = true;
    launch.unbound_path = Some(launch.path.clone());
    for key in ["NODE_PATH", "PYTHONPATH"] {
        let mut command = Command::new(native::trusted_node().unwrap());
        command.env("GRAPHER_ORIGINAL_ROOT", &source).env("GRAPHER_WORKSPACE_ROOT", &target);
        let error = clean_command_with_environment(&mut command, &launch, Some(Path::new("binding.json")),
            [(key.into(), source.join("modules").into_os_string())].into_iter().collect()).unwrap_err();
        assert!(error.contains(key), "{error}");
    }
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
        .all(|node| node.status == "completed"));
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
        changed.caches = vec![".ENV".into()];
        assert!(changed.validate().is_err());
        // A cache nested inside a scope is a carve-out and is accepted.
        let mut nested = policy();
        nested.caches = vec![".ENV/cache".into()];
        nested.validate().unwrap();
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
        .materialize(
            &sibling,
            std::slice::from_ref(&base.environment_ref),
            None,
            false,
        )
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
        state_policy(),
        r#"
const env=process.env.GTEST_STATE+'/.env/version';
const previous=fs.existsSync(env)?fs.readFileSync(env,'utf8'):'';
if(name==='A' && !previous) fs.writeFileSync(env,'1');
else if(name==='B'){ if(previous!=='1') throw Error('wrong B environment'); fs.writeFileSync(env,'2'); }
else if(name==='C'){ if(previous!=='2') throw Error('wrong C environment'); fs.writeFileSync(env,'3'); fs.mkdirSync('ordinary',{recursive:true}); fs.writeFileSync('ordinary/result','C artifact'); }
else if(task.includes('rebuild after C')) { if(previous!=='4') throw Error('rebuild restored historical environment'); }
else { if(previous!=='3') throw Error('ancestor restored old environment'); fs.writeFileSync(env,'4'); }
fs.writeFileSync(process.env.GTEST_STATE+'/.cache/runtime','cache should not fork E');
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
    assert_ne!(
        a0.code_ref, histories[2].code_ref,
        "ordinary node outputs are recorded in Git"
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
        assert_eq!(runtime.state.nodes[name].status, "completed");
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
        &runtime.exclusions().unwrap(),
        |_| Err("unexpected conflict".into()),
    )
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
    let rebuilt_policy = runtime
        .state
        .config
        .as_ref()
        .unwrap()
        .environment
        .clone()
        .unwrap();
    let rebuilt_state = Environments::new(&runtime.root, &runtime.state.run_id, &rebuilt_policy)
        .unwrap()
        .state_root(Path::new(&rebuilt.execution.worktree))
        .unwrap();
    assert_eq!(
        fs::read_to_string(rebuilt_state.join(".env/version")).unwrap(),
        "4"
    );
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
        state_policy(),
        r#"
if(name==='A') fs.writeFileSync(process.env.GTEST_STATE+'/.env/package','dependency');
if(name==='B') fs.writeFileSync(process.env.GTEST_STATE+'/.cache/bytecode','ephemeral');
if(name==='C') fs.writeFileSync(process.env.GTEST_STATE+'/.env/unknown-config','must retain');
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
    let mut config = state_policy();
    config.initialize = vec![native::trusted_node().unwrap().to_string_lossy().into(), "-e".into(),
        "const fs=require('fs'); const p=process.env.GTEST_STATE+'/.env/partial-init'; fs.mkdirSync(process.env.GTEST_STATE+'/.env',{recursive:true}); if(!fs.existsSync(p)){fs.writeFileSync(p,'partial');process.exit(7)}; if(fs.readFileSync(p,'utf8')!=='partial')process.exit(8);".into()];
    let (_temp, _source, mut runtime) = setup(graph(&["A"], &[]), config.clone(), "if(fs.readFileSync(process.env.GTEST_STATE+'/.env/partial-init','utf8')!=='partial')throw Error('initializer partial lost');");
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
    assert_eq!(runtime.state.nodes["A"].status, "completed");
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
        state_policy(),
        r#"
if(name==='A') { const repair=fs.existsSync(process.env.GTEST_STATE+'/.env/version'); if(repair && fs.readFileSync(process.env.GTEST_STATE+'/.env/version','utf8')!=='2')throw Error('feedback lost E2'); fs.writeFileSync(process.env.GTEST_STATE+'/.env/version',repair?'3':'1'); }
else { const version=fs.readFileSync(process.env.GTEST_STATE+'/.env/version','utf8'); if(version==='1'){fs.writeFileSync(process.env.GTEST_STATE+'/.env/version','2');response='Review proof.\n<FEEDBACK>';} else {if(version!=='3')throw Error('repair environment not inherited');response='<ACCEPT>';}}
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
    assert_eq!(repair.task, "Feedback:\nReview proof.");
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
    fs::create_dir_all(runtime.root.join("prompts")).unwrap();
    fs::write(runtime.root.join("prompts/feedback-returned.md"), "{{node}}\n[fixture recheck]").unwrap();
    let repaired_environment = runtime.state.nodes["A"].result.clone().unwrap();
    let verify = runtime.jobs().unwrap().remove(0);
    assert_eq!(verify.session_fork.as_ref().unwrap().id, b.execution.id);
    assert_eq!(verify.environment_input.as_ref().unwrap().environment_ref, repaired_environment.environment_ref);
    run(&mut runtime, &verify);
    let history = fs::read_to_string(runtime.root.join("sessions").join(&verify.execution.id)
        .join(format!("grapher_{}.jsonl", verify.execution.session_id))).unwrap();
    assert!(history.contains("REVIEW PRIVATE HISTORY"));
    assert!(!history.contains("OWNER PRIVATE HISTORY"));
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

#[cfg(feature = "fixture")]
#[test]
fn managed_environment_handoff_recovers_after_crash_before_directory_or_environment_prepare() {
    let mut policy = state_policy();
    policy.layout = "relocatable".into();
    let (_temp, source, mut runtime) = setup(
        graph(&["A", "B", "C"], &[("A", "B", false), ("A", "C", false)]),
        policy,
        r#"
if (name === 'A') {
  fs.mkdirSync(process.env.GTEST_STATE + '/.env', { recursive: true });
  fs.writeFileSync(process.env.GTEST_STATE + '/.env/pkg', 'from-A');
} else {
  if (fs.readFileSync(process.env.GTEST_STATE + '/.env/pkg', 'utf8') !== 'from-A') {
    throw Error('managed environment was not materialized for ' + name);
  }
}
"#,
    );
    // 1. Crash right after `Started(A)` before `A.worktree` is created on disk.
    let a_uncreated = runtime.jobs().unwrap().remove(0);
    assert!(!Path::new(&a_uncreated.execution.worktree).exists());
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    assert!(runtime.state.can_resume_interrupted());
    runtime.pause(false).unwrap();
    let a_retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(a_retry.execution.worktree, a_uncreated.execution.worktree);
    run(&mut runtime, &a_retry);

    // 2. Fan-out `B` and `C` allocate fresh slots. Simulate a crash during `B`'s
    // Git/view handoff after `B.worktree` is created on disk (with `project-ready`
    // cleared), before `store.prepare` materialized `.env/pkg`.
    let mut children = runtime.jobs().unwrap();
    let c_job = children.pop().unwrap();
    let b_job = children.pop().unwrap();
    run(&mut runtime, &c_job);
    let b_path = PathBuf::from(&b_job.execution.worktree);
    workspace::prepare(
        &source,
        &b_path,
        &b_job.execution.before,
        &b_job.parent_heads,
    )
    .unwrap();
    crate::workspace_view::clear_ready(&b_path).unwrap();
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    assert!(runtime.state.can_resume_interrupted());
    runtime.pause(false).unwrap();
    let b_retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(b_retry.execution.node, "B");
    assert_eq!(b_retry.execution.worktree, b_job.execution.worktree);
    run(&mut runtime, &b_retry);
    assert_eq!(runtime.state.nodes["B"].status, "completed");
}
