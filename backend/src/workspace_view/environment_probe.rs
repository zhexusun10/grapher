// Opt-in, model-free project/copy cost baseline. This is not sandbox acceptance
// or a package resolver: all dependencies are local, and no network is used.
use super::*;
use serde_json::{json, Value};
use std::{process::Command, time::Instant};

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Size {
    files: u64,
    directories: u64,
    links: u64,
    logical_bytes: u64,
}
fn size(root: &Path, skip_git: bool) -> Size {
    fn walk(root: &Path, result: &mut Size, skip_git: bool) {
        for entry in fs::read_dir(root).unwrap() {
            let entry = entry.unwrap();
            if skip_git && entry.file_name() == ".git" {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path()).unwrap();
            if metadata.file_type().is_symlink() {
                result.links += 1;
            } else if metadata.is_dir() {
                result.directories += 1;
                walk(&entry.path(), result, false);
            } else {
                result.files += 1;
                result.logical_bytes += metadata.len();
            }
        }
    }
    let mut result = Size::default();
    if root.exists() {
        walk(root, &mut result, skip_git);
    }
    result
}
// The path is obtained only for this uniquely named disposable source.
struct OwnedGraph(PathBuf);
impl Drop for OwnedGraph {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            if error.kind() == std::io::ErrorKind::NotFound {
                return;
            }
            eprintln!("Probe graph cleanup failed ({}): {error}", self.0.display());
        }
    }
}
fn put(root: &Path, name: &str, value: impl AsRef<[u8]>) {
    let path = root.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value).unwrap();
}
fn output(command: &mut Command) -> Vec<u8> {
    command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    crate::environment::controlled_output_with_timeout(
        std::mem::replace(command, Command::new("unused")),
        Some(std::time::Duration::from_secs(120)),
    )
    .unwrap()
}
fn text(command: &mut Command) -> String {
    String::from_utf8(output(command))
        .unwrap()
        .trim()
        .to_owned()
}
fn timed<T>(times: &mut serde_json::Map<String, Value>, name: &str, work: impl FnOnce() -> T) -> T {
    let start = Instant::now();
    let result = work();
    times.insert(name.into(), json!(start.elapsed().as_secs_f64() * 1000.0));
    result
}

// Cumulative process-only counters. Git/compiler child RSS and CPU, allocated
// filesystem blocks, and host-wide pressure are deliberately not claimed.
#[cfg(unix)]
fn resources() -> Value {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return json!({"gap":"getrusage unavailable"});
    }
    let usage = unsafe { usage.assume_init() };
    let scale = if cfg!(target_os = "macos") { 1 } else { 1024 };
    json!({"peakTestProcessRssBytes":usage.ru_maxrss as u64 * scale,
        "testProcessCpuMs":(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) as f64 * 1000.0
            + (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) as f64 / 1000.0})
}
#[cfg(windows)]
fn resources() -> Value {
    #[repr(C)]
    struct Counters {
        cb: u32,
        faults: u32,
        peak: usize,
        working: usize,
        pool_peak: usize,
        pool: usize,
        nonpool_peak: usize,
        nonpool: usize,
        pagefile: usize,
        pagefile_peak: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn GetProcessTimes(
            process: isize,
            created: *mut u64,
            exited: *mut u64,
            kernel: *mut u64,
            user: *mut u64,
        ) -> i32;
    }
    #[link(name = "psapi")]
    unsafe extern "system" {
        fn GetProcessMemoryInfo(process: isize, counters: *mut Counters, size: u32) -> i32;
    }
    let mut counters: Counters = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<Counters>() as u32;
    let (mut created, mut exited, mut kernel, mut user) = (0, 0, 0, 0);
    let process = unsafe { GetCurrentProcess() };
    let memory_ok = unsafe { GetProcessMemoryInfo(process, &mut counters, counters.cb) } != 0;
    let cpu_ok =
        unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) } != 0;
    json!({"peakTestProcessRssBytes":memory_ok.then_some(counters.peak),
        "testProcessCpuMs":cpu_ok.then_some((kernel + user) as f64 / 10000.0)})
}

fn npm(root: &Path) -> Command {
    let mut command = if cfg!(windows) {
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/s", "/c", "npm"]);
        command
    } else {
        Command::new("npm")
    };
    command.current_dir(root).env(
        "npm_config_cache",
        root.parent().unwrap().join("fixture-npm-cache"),
    );
    command
}
fn private_command(program: impl AsRef<std::ffi::OsStr>, root: &Path) -> Command {
    let bindings = crate::native::workspace_environment(root).unwrap();
    fs::create_dir_all(&bindings["HOME"]).unwrap();
    let mut command = Command::new(program);
    command
        .current_dir(root)
        .envs(bindings)
        .env("PYTHONDONTWRITEBYTECODE", "1");
    command
}

enum Project {
    Node {
        node: PathBuf,
    },
    Python {
        bootstrap: PathBuf,
        interpreter: String,
        dependency: String,
        uv: Option<PathBuf>,
    },
    Cargo {
        cargo: PathBuf,
        rustc: PathBuf,
        rustdoc: PathBuf,
        default: String,
    },
}
impl Project {
    fn dependency(&self) -> &str {
        match self {
            Self::Node { .. } => "node_modules/offline-local/index.js",
            Self::Python { dependency, .. } => dependency,
            Self::Cargo { .. } => "vendor/local-value/src/lib.rs",
        }
    }
    fn patch(&self, root: &Path, value: &str) {
        let value = match self {
            Self::Node { .. } => format!("exports.value={value:?};\n"),
            Self::Python { .. } => format!("VALUE={value:?}\n"),
            Self::Cargo { .. } => format!("pub const VALUE: &str = {value:?};\n"),
        };
        put(root, self.dependency(), value);
    }
    fn run(&self, root: &Path, private: bool) -> Value {
        let command = |program: &Path| {
            if private {
                private_command(program, root)
            } else {
                let mut command = Command::new(program);
                command
                    .current_dir(root)
                    .env("PYTHONDONTWRITEBYTECODE", "1");
                command
            }
        };
        match self {
            Self::Node { node } => {
                serde_json::from_slice(&output(command(node).arg("app.cjs"))).unwrap()
            }
            Self::Python {
                interpreter, uv, ..
            } => {
                let python = root.join(interpreter);
                let direct: Value =
                    serde_json::from_slice(&output(command(&python).arg("app.py"))).unwrap();
                assert!(crate::path_identity::same_path(
                    Path::new(direct["prefix"].as_str().unwrap()),
                    &root.join(".venv")
                ));
                assert!(crate::path_identity::same_path(
                    Path::new(direct["python"].as_str().unwrap()),
                    &python
                ));
                assert_ne!(direct["prefix"], direct["basePrefix"]);
                assert!(direct["abi"].is_string());
                assert!(!root.join("bytecode_only.py").exists());
                assert!(root.join("bytecode_only.pyc").is_file());
                if let Some(uv) = uv {
                    let modern: Value = serde_json::from_slice(&output(
                        command(uv)
                            .args(["run", "--offline", "--no-sync", "--python"])
                            .arg(&python)
                            // Script dispatch may select bin/python3, a distinct
                            // copied file under venv --copies on POSIX. Exercise
                            // uv with the exact interpreter whose bytes we verify.
                            .arg(&python)
                            .arg("app.py"),
                    ))
                    .unwrap();
                    assert_eq!(modern["value"], direct["value"]);
                    assert_eq!(modern["abi"], direct["abi"]);
                    for key in ["python", "prefix", "basePrefix"] {
                        assert!(crate::path_identity::same_path(Path::new(modern[key].as_str().unwrap()), Path::new(direct[key].as_str().unwrap())),
                            "uv must use the real selected interpreter/prefix, including native path aliases: {key}; direct={direct}, uv={modern}");
                    }
                }
                direct
            }
            Self::Cargo { .. } => {
                let executable = root.join(if cfg!(windows) {
                    "target/debug/env-probe.exe"
                } else {
                    "target/debug/env-probe"
                });
                serde_json::from_slice(&output(&mut command(&executable))).unwrap()
            }
        }
    }
    fn tool_versions(&self, root: &Path) -> Value {
        match self {
            Self::Node { node } => {
                json!({"node":text(Command::new(node).arg("--version")),"npm":text(npm(root).arg("--version"))})
            }
            Self::Python {
                interpreter, uv, ..
            } => json!({
                "python":text(Command::new(root.join(interpreter)).args(["-I","-c","import sys;print(sys.version)"])),
                "pip":text(Command::new(root.join(interpreter)).args(["-I","-X","utf8","-m","pip","--version"])),
                "uv":uv.as_ref().map(|uv|text(Command::new(uv).arg("--version")))}),
            Self::Cargo { cargo, rustc, .. } => {
                json!({"cargo":text(Command::new(cargo).arg("--version")),"rustc":text(Command::new(rustc).arg("-Vv"))})
            }
        }
    }
    fn explicit_rebuild(&self, root: &Path) -> Option<Value> {
        let Self::Python {
            bootstrap,
            interpreter,
            ..
        } = self
        else {
            return None;
        };
        // A declared project workflow, invoked explicitly in this disposable
        // profile. It never supplies authority to Runtime or borrows a sibling.
        let prefix = crate::workspace_state::process_root(root)
            .unwrap()
            .join(".environments/rebuild-probe");
        assert!(!prefix.exists());
        output(
            private_command(bootstrap, root)
                .args(["-I", "-m", "venv", "--copies", "--without-pip"])
                .arg(&prefix),
        );
        let python = prefix.join(if cfg!(windows) {
            "Scripts/python.exe"
        } else {
            "bin/python"
        });
        // Use this workspace's already recorded installer as an explicit tool,
        // not another node's environment or a host/global package installation.
        output(
            private_command(root.join(interpreter), root)
                .args(["-I", "-X", "utf8", "-m", "pip", "--python"])
                .arg(&python)
                .args([
                    "install",
                    "--no-index",
                    "--no-deps",
                    "--no-build-isolation",
                    "--no-compile",
                    ".",
                ]),
        );
        let evidence: Value =
            serde_json::from_slice(&output(private_command(&python, root).arg("app.py"))).unwrap();
        assert!(crate::path_identity::same_path(
            Path::new(evidence["prefix"].as_str().unwrap()),
            &prefix
        ));
        assert!(crate::path_identity::same_path(
            Path::new(evidence["python"].as_str().unwrap()),
            &python
        ));
        assert_ne!(evidence["prefix"], evidence["basePrefix"]);
        assert!(evidence["abi"].is_string());
        assert_eq!(
            evidence["value"], "preinstalled",
            "a project rebuild cannot recreate the captured installed local patch"
        );
        Some(
            json!({"runtimeEvidence":evidence,"byteEquivalentToCapturedDependency":false,
            "runtimeBinding":"not attempted; no binding or equivalence evidence", "automaticAdoption":false,
            "workflow":"explicit installed bootstrap -m venv --copies --without-pip; same-workspace recorded pip --python <new interpreter> install --no-index --no-deps --no-build-isolation --no-compile ."}),
        )
    }
    fn build_private(&self, root: &Path) {
        if let Self::Cargo {
            cargo,
            rustc,
            rustdoc,
            ..
        } = self
        {
            let home = crate::workspace_state::process_root(root)
                .unwrap()
                .join(".agent-home/.cargo");
            // Explicit project setup, not a runtime fallback. Build before the
            // seal, never mutate a sealed view just to validate its executable.
            output(
                private_command(cargo, root)
                    .args(["build", "--offline", "--quiet"])
                    .env("RUSTC", rustc)
                    .env("RUSTDOC", rustdoc)
                    .env("CARGO_HOME", home)
                    .env("CARGO_TARGET_DIR", root.join("target")),
            );
        }
    }
    fn prepare(name: &str, root: &Path, files: usize, gaps: &mut Vec<String>) -> Self {
        match name {
            "node" => {
                let node = crate::native::trusted_node().unwrap();
                put(root, ".gitignore", "node_modules/\n.next/\n");
                put(
                    root,
                    "package.json",
                    r#"{"name":"offline-env-probe","private":true,"scripts":{"build":"node build.cjs","start":"node app.cjs"}}"#,
                );
                put(root, "build.cjs", "require('node:fs').mkdirSync('.next/server',{recursive:true});require('node:fs').writeFileSync('.next/server/value.cjs',\"module.exports='built';\\n\");\n");
                put(root, "app.cjs", "console.log(JSON.stringify({value:require('offline-local').value,build:require('./.next/server/value.cjs'),tracked:require('tracked-local')}));\n");
                put(
                    root,
                    "vendor/offline-local/package.json",
                    r#"{"name":"offline-local","version":"1.0.0","main":"index.js"}"#,
                );
                put(
                    root,
                    "vendor/offline-local/index.js",
                    "exports.value='preinstalled';\n",
                );
                output(npm(root).args([
                    "install",
                    "--offline",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                    "--no-package-lock",
                    "--no-save",
                    "--install-links",
                    "./vendor/offline-local",
                ]));
                assert!(
                    !fs::symlink_metadata(root.join("node_modules/offline-local"))
                        .unwrap()
                        .file_type()
                        .is_symlink(),
                    "npm must install independent bytes, not a source link"
                );
                // Even the installed manifest is not needed by this package.
                fs::remove_file(root.join("node_modules/offline-local/package.json")).unwrap();
                put(
                    root,
                    "node_modules/tracked-local/index.js",
                    "module.exports='tracked';\n",
                );
                workspace::project_git(root, &["add", "-f", "node_modules/tracked-local/index.js"])
                    .unwrap();
                workspace::project_git(root, &["commit", "-qm", "tracked dependency bytes"])
                    .unwrap();
                // No manifest for offline-local: installed bytes, including a
                // local patch, are the only authority. Padding varies per file.
                for index in 0..files {
                    put(
                        root,
                        &format!("node_modules/offline-local/data/{index:04}.txt"),
                        format!("{index:04}:{}", "dependency bytes\n".repeat(256)),
                    );
                }
                output(npm(root).args(["run", "build", "--offline"]));
                Self::Node { node }
            }
            "python" => {
                let mut python = None;
                for name in if cfg!(windows) {
                    vec!["python", "py"]
                } else {
                    vec!["python3", "python"]
                } {
                    if let Ok(result) = Command::new(name)
                        .args([
                            "-I",
                            "-X",
                            "utf8",
                            "-c",
                            "import sys,venv,ensurepip;print(sys.executable)",
                        ])
                        .output()
                    {
                        if result.status.success() {
                            python = Some(PathBuf::from(
                                String::from_utf8(result.stdout).unwrap().trim(),
                            ));
                            break;
                        }
                    }
                }
                let python = python
                    .expect("Native Python with venv/ensurepip required; no installation fallback");
                output(
                    Command::new(&python)
                        .current_dir(root)
                        .args(["-I", "-m", "venv", "--copies", ".venv"]),
                );
                let interpreter = if cfg!(windows) {
                    ".venv/Scripts/python.exe"
                } else {
                    ".venv/bin/python"
                }
                .to_string();
                let interpreter_path = root.join(&interpreter);
                put(root, ".gitignore", ".venv/\n*.pyc\n");
                put(root, "pyproject.toml", "[build-system]\nrequires=[]\nbuild-backend='build_backend'\nbackend-path=['.']\n[project]\nname='offline-local'\nversion='1.0'\n");
                put(
                    root,
                    "build_backend.py",
                    r#"import pathlib,zipfile
def build_wheel(wheel_directory,config_settings=None,metadata_directory=None):
 name='offline_local-1.0-py3-none-any.whl'
 files={'offline_local.py':"VALUE='preinstalled'\n",'offline_local-1.0.dist-info/METADATA':'Metadata-Version: 2.1\nName: offline-local\nVersion: 1.0\n','offline_local-1.0.dist-info/WHEEL':'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n'}
 files['offline_local-1.0.dist-info/RECORD']=''.join(k+',,\n' for k in files)+'offline_local-1.0.dist-info/RECORD,,\n'
 with zipfile.ZipFile(pathlib.Path(wheel_directory)/name,'w') as wheel:
  for k,v in files.items(): wheel.writestr(k,v)
 return name
"#,
                );
                output(Command::new(&interpreter_path).current_dir(root).args([
                    "-I",
                    "-m",
                    "pip",
                    "install",
                    "--no-index",
                    "--no-deps",
                    "--no-build-isolation",
                    "--no-compile",
                    ".",
                ]));
                let dependency = text(Command::new(&interpreter_path).current_dir(root).args(["-I", "-c", "import pathlib,sysconfig;print(pathlib.Path(sysconfig.get_path('purelib')).relative_to(pathlib.Path.cwd())/'offline_local.py')"])).replace('\\', "/");
                put(root, "bytecode_only.py", "VALUE='sourceless'\n");
                output(Command::new(&interpreter_path).current_dir(root).args(["-I", "-c", "import py_compile,pathlib;py_compile.compile('bytecode_only.py',cfile='bytecode_only.pyc',doraise=True);pathlib.Path('bytecode_only.py').unlink()"]));
                put(root, "app.py", "import json,sys,sysconfig,offline_local,bytecode_only\nassert bytecode_only.VALUE=='sourceless'\nprint(json.dumps(dict(value=offline_local.VALUE,prefix=sys.prefix,basePrefix=sys.base_prefix,python=sys.executable,abi=sysconfig.get_config_var('SOABI') or sys.implementation.cache_tag)))\n");
                let explicit = std::env::var_os("GRAPHER_ENV_PROBE_UV");
                let uv = PathBuf::from(explicit.as_deref().unwrap_or(std::ffi::OsStr::new("uv")));
                let available = Command::new(&uv)
                    .arg("--version")
                    .output()
                    .is_ok_and(|out| out.status.success());
                assert!(
                    explicit.is_none() || available,
                    "Explicit GRAPHER_ENV_PROBE_UV is unavailable"
                );
                if !available {
                    gaps.push("uv not installed: real uv invocation NOT RUN (pip PEP-517 and direct venv interpreter run independently)".into());
                }
                Self::Python {
                    bootstrap: python,
                    interpreter,
                    dependency,
                    uv: available.then_some(uv),
                }
            }
            "cargo" => {
                put(root, ".gitignore", "target/\n.cargo-home/\n");
                put(root, "Cargo.toml", "[package]\nname='env-probe'\nversion='0.1.0'\nedition='2021'\n[dependencies]\nlocal-value={path='vendor/local-value'}\n");
                put(
                    root,
                    "vendor/local-value/Cargo.toml",
                    "[package]\nname='local-value'\nversion='0.1.0'\nedition='2021'\n",
                );
                put(
                    root,
                    "src/main.rs",
                    "fn main(){println!(\"{{\\\"value\\\":\\\"{}\\\"}}\",local_value::VALUE);}\n",
                );
                let default = text(
                    Command::new("rustup")
                        .current_dir(root)
                        .arg("default")
                        .env_remove("RUSTUP_TOOLCHAIN"),
                );
                let toolchain = default.split_whitespace().next().unwrap();
                let resolve = |tool: &str| {
                    PathBuf::from(text(
                        Command::new("rustup")
                            .current_dir(root)
                            .args(["which", "--toolchain", toolchain, tool])
                            .env_remove("RUSTUP_TOOLCHAIN"),
                    ))
                };
                let (cargo, rustc, rustdoc) =
                    (resolve("cargo"), resolve("rustc"), resolve("rustdoc"));
                Self::Cargo {
                    cargo,
                    rustc,
                    rustdoc,
                    default,
                }
            }
            _ => unreachable!(),
        }
    }
}

#[test]
#[ignore = "opt-in offline real-tool project cost baseline; not native sandbox acceptance"]
fn environment_project_baseline() {
    let parent = std::env::var_os("GRAPHER_ENV_TEST_PARENT")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    fs::create_dir_all(&parent).unwrap();
    let files: usize = std::env::var("GRAPHER_ENV_PROBE_FILES")
        .unwrap_or_else(|_| "128".into())
        .parse()
        .unwrap();
    assert!((1..=4096).contains(&files));
    let requested =
        std::env::var("GRAPHER_ENV_PROBE_PROJECTS").unwrap_or_else(|_| "node,python,cargo".into());
    let selected: Vec<_> = requested.split(',').collect();
    assert!(
        !selected.is_empty()
            && selected
                .iter()
                .all(|name| ["node", "python", "cargo"].contains(name))
    );
    assert_eq!(
        selected
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        selected.len()
    );
    let mut reports = Vec::new();
    let mut gaps = Vec::new();
    for name in selected.iter().copied() {
        let gap_start = gaps.len();
        let mut times = serde_json::Map::new();
        let mut completed_evidence = json!({});
        let started = Instant::now();
        // Preserve completed measurements and continue the explicitly selected
        // profiles after a fixture/tool/permission failure. This is diagnostic
        // collection only: any failed profile still fails the test below.
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let temp = tempfile::Builder::new()
                .prefix("g-env-probe-")
                .tempdir_in(&parent)
                .unwrap();
            let source = source(&temp);
            let project = timed(&mut times, "fixtureSetup", || {
                Project::prepare(name, &source, files, &mut gaps)
            });
            let tool_versions = project.tool_versions(&source);
            completed_evidence["toolVersions"] = tool_versions.clone();
            project.patch(&source, "captured-local-patch");
            // Rustup's source default is exercised before redirecting HOME. The
            // Cargo package cache is nevertheless disposable, not the host cache.
            if let Project::Cargo { .. } = &project {
                timed(&mut times, "sourceDefaultCargoBuild", || {
                    output(
                        Command::new("cargo")
                            .current_dir(&source)
                            .args(["build", "--offline", "--quiet"])
                            .env_remove("RUSTUP_TOOLCHAIN")
                            .env("CARGO_HOME", source.join(".cargo-home"))
                            .env("CARGO_TARGET_DIR", source.join("target")),
                    );
                });
            }
            let source_output = timed(&mut times, "sourceExecution", || {
                project.run(&source, false)
            });
            assert_eq!(source_output["value"], "captured-local-patch");
            let source_size = size(&source, true);
            completed_evidence["sourceExecutionEvidence"] = source_output.clone();
            completed_evidence["sourceProject"] = serde_json::to_value(&source_size).unwrap();
            let source_head = workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap();
            let source_index = bytes(&source.join(".git/index"));
            let graph_directory = workspace::shadow_repo_dir(&source).unwrap();
            assert!(
                !graph_directory.exists(),
                "Probe never takes ownership of a pre-existing graph store"
            );
            let _graph_cleanup = OwnedGraph(graph_directory.clone());
            let base = timed(&mut times, "sourceSnapshot", || {
                workspace::snapshot_repository(&source).unwrap()
            });
            let graph_after_base = size(&graph_directory, false);
            completed_evidence["graphAfterBaseSnapshot"] =
                serde_json::to_value(&graph_after_base).unwrap();
            let managed = if let Project::Python { .. } = &project {
                let directory = temp.path().join("environment-evidence");
                let files =
                    crate::workspace_files::Files::environment(&directory, &[".venv".into()], &[])
                        .unwrap()
                        .with_project_index(false);
                let state = temp.path().join("managed-state");
                put(
                    &state,
                    ".agent-home/config",
                    "explicit private business config",
                );
                let roots = std::collections::BTreeMap::from([
                    ("workspace".into(), source.clone()),
                    ("state".into(), state),
                ]);
                let layouts = std::collections::BTreeMap::from([
                    (
                        "workspace".into(),
                        crate::workspace_files::RootScope::normalized(vec![".venv".into()], vec![]),
                    ),
                    (
                        "state".into(),
                        crate::workspace_files::RootScope::normalized(
                            vec![".agent-home".into()],
                            vec![".agent-home/cache".into()],
                        ),
                    ),
                ]);
                let version = uuid::Uuid::new_v4().to_string();
                timed(&mut times, "managedEnvironmentCapture", || {
                    files
                        .capture_roots(&roots, &layouts, &version, &[])
                        .unwrap()
                });
                let store_before = serde_json::to_value(size(&directory, false)).unwrap();
                let before_resources = resources();
                timed(&mut times, "managedEnvironmentUnchangedSeals", || {
                    for _ in 0..3 {
                        assert_eq!(
                            files
                                .capture_roots_reusing(&roots, &layouts, &version)
                                .unwrap(),
                            version
                        );
                    }
                });
                let store_after = serde_json::to_value(size(&directory, false)).unwrap();
                assert_eq!(
                    store_after, store_before,
                    "unchanged seals must not retain orphan manifests"
                );
                let unchanged = json!({"seals":3,"storeBefore":store_before,"storeAfter":store_after,
                "resourcesBefore":before_resources,"resourcesAfter":resources(),"sameImmutableRef":true});
                // Disposable reference store only; never duplicate production E or
                // execute from another workspace's mutable prefix. Both scans read
                // this same quiescent real venv and explicitly private config.
                let reference_directory = temp.path().join("environment-evidence-reference");
                let reference_files =
                    crate::workspace_files::Files::environment(&reference_directory, &[], &[])
                        .unwrap()
                        .with_project_index(false);
                reference_files
                    .capture_roots(&roots, &layouts, &version, &[])
                    .unwrap();
                let reference_before =
                    serde_json::to_value(size(&reference_directory, false)).unwrap();
                let reference_resources = resources();
                timed(
                    &mut times,
                    "managedEnvironmentReferenceUnchangedSeals",
                    || {
                        for _ in 0..3 {
                            assert_eq!(
                                reference_files
                                    .capture_roots_unbatched(&roots, &layouts, &version)
                                    .unwrap(),
                                version
                            );
                        }
                    },
                );
                let reference = json!({"seals":3,"storeBefore":reference_before,
                "storeAfter":size(&reference_directory,false),"resourcesBefore":reference_resources,
                "resourcesAfter":resources(),"strategy":"test-only per-file single-path-check; no checked-set lookup/insertion; write-then-compare; separate disposable store"});
                Some((
                    files, version, directory, roots, layouts, unchanged, reference,
                ))
            } else {
                None
            };
            project.patch(&source, "source-later");
            let mut managed_report = Value::Null;
            if let Some((files, version, directory, roots, layouts, unchanged, reference)) =
                &managed
            {
                put(&roots["state"], ".agent-home/config", "source state later");
                let changed = timed(&mut times, "managedEnvironmentChangedSeal", || {
                    files
                        .capture_roots_reusing(roots, layouts, version)
                        .unwrap()
                });
                assert_ne!(
                    changed, *version,
                    "real dependency/config edits must append new evidence"
                );
                timed(&mut times, "managedEnvironmentValidate", || {
                    files.validate(std::slice::from_ref(version)).unwrap()
                });
                let restored = temp.path().join("environment-byte-restore-W");
                let restored_state = temp.path().join("environment-byte-restore-S");
                fs::create_dir(&restored).unwrap();
                put(&restored_state, ".agent-home/cache/value", "new cache");
                let targets = std::collections::BTreeMap::from([
                    ("workspace".into(), restored.clone()),
                    ("state".into(), restored_state.clone()),
                ]);
                timed(&mut times, "managedEnvironmentMaterialize", || {
                    files.materialize_roots(&targets, version).unwrap()
                });
                assert_eq!(
                    fs::read_to_string(restored_state.join(".agent-home/config")).unwrap(),
                    "explicit private business config"
                );
                assert_eq!(
                    fs::read_to_string(restored_state.join(".agent-home/cache/value")).unwrap(),
                    "new cache"
                );
                assert!(fs::read_to_string(restored.join(project.dependency()))
                    .unwrap()
                    .contains("captured-local-patch"));
                project.patch(&restored, "restored-only");
                assert!(fs::read_to_string(source.join(project.dependency()))
                    .unwrap()
                    .contains("source-later"));
                files.validate(std::slice::from_ref(version)).unwrap();
                assert!(files.verify_roots(&targets, version).is_err());
                timed(&mut times, "managedEnvironmentPatchedMaterialize", || {
                    files.materialize_roots(&targets, &changed).unwrap()
                });
                files.verify_roots(&targets, &changed).unwrap();
                files.validate(std::slice::from_ref(&changed)).unwrap();
                assert!(fs::read_to_string(restored.join(project.dependency()))
                    .unwrap()
                    .contains("source-later"));
                assert_eq!(
                    fs::read_to_string(restored_state.join(".agent-home/config")).unwrap(),
                    "source state later"
                );
                assert_eq!(
                    fs::read_to_string(restored_state.join(".agent-home/cache/value")).unwrap(),
                    "new cache"
                );
                managed_report = json!({"snapshotStore":size(directory,false),"unchangedSeals":unchanged,
                "referenceUnchangedSeals":reference,"changedSealHasDistinctRef":true,"oldAndPatchedRecordedBytesRestored":true,
                "restoredViews":{"workspace":size(&restored,false),"state":size(&restored_state,false)},
                "coverage":"rooted schema 1: W:.venv and S:.agent-home excluding cache; byte materialization, not launcher/editable relocation or cross-slot environment reuse"});
            }
            completed_evidence["managedEnvironment"] = managed_report.clone();
            let node = slot(&temp, "node");
            timed(&mut times, "workspacePrepare", || {
                workspace::prepare(&source, &node, &base, &[]).unwrap()
            });
            let mut home_discovery = Value::Null;
            if let Project::Cargo {
                default,
                cargo,
                rustc,
                ..
            } = &project
            {
                // A host PATH may expose a standalone Cargo binary (not a Rustup
                // proxy), especially with Homebrew. Query Rustup's default directly
                // with private configuration roots instead of assuming cargo --version
                // must dispatch through Rustup on every host.
                let private_home = crate::workspace_state::process_root(&node)
                    .unwrap()
                    .join(".agent-home");
                let mut command = private_command("rustup", &node);
                command
                    .arg("default")
                    .env_remove("RUSTUP_TOOLCHAIN")
                    .env("RUSTUP_HOME", private_home.join(".rustup"))
                    .env("CARGO_HOME", private_home.join(".cargo"));
                let result = command.output().unwrap();
                let diagnostic = String::from_utf8_lossy(&result.stderr).into_owned();
                let configured = String::from_utf8_lossy(&result.stdout).trim().to_owned();
                // Homebrew's Rustup wrapper supplies system fallback settings even
                // with private HOME/RUSTUP_HOME. Record that real outcome instead of
                // claiming every platform must lack a default. This query installs
                // nothing; the actual build below uses explicit installed tools.
                if result.status.success() {
                    assert!(
                        !configured.is_empty(),
                        "successful Rustup default query returned no evidence"
                    );
                } else {
                    assert!(
                        diagnostic.contains("toolchain") && diagnostic.contains("default"),
                        "{diagnostic}"
                    );
                }
                home_discovery = json!({"sourceDefault":default,"privateDefaultExit":result.status.code(),
                "privateDefaultConfigured":result.status.success(),"privateDefaultOutput":configured,
                "privateDiagnostic":diagnostic,"explicitCargo":cargo,"explicitRustc":rustc,
                "setup":"direct installed Cargo plus explicit RUSTC/RUSTDOC; private HOME/CARGO_HOME and target; no home copy or automatic fallback"});
            }
            if matches!(project, Project::Cargo { .. }) {
                timed(&mut times, "explicitPrivateBuild", || {
                    project.build_private(&node)
                });
            }
            let node_output = timed(&mut times, "nodeExecution", || project.run(&node, true));
            assert_eq!(node_output["value"], "captured-local-patch");
            project.patch(&node, "node-patch");
            if matches!(project, Project::Cargo { .. }) {
                timed(&mut times, "patchedPrivateBuild", || {
                    project.build_private(&node)
                });
            }
            let result = timed(&mut times, "nodeSnapshot", || {
                workspace::snapshot_node(&node, &source, "node").unwrap()
            });
            let before_concurrent = resources();
            let branches = timed(&mut times, "concurrentForkAndSnapshotWall", || {
                std::thread::scope(|scope| {
                    let workers: Vec<_> = ["a", "b"].into_iter().map(|name| {
                let (source, temp, base, result) = (&source, &temp, &base, &result);
                scope.spawn(move || {
                    let path = slot(temp, name);
                    let start = Instant::now();
                    workspace::prepare(source, &path, base, std::slice::from_ref(result)).unwrap();
                    let prepare_ms = start.elapsed().as_secs_f64() * 1000.0;
                    put(&path, &format!("branch-{name}.txt"), name);
                    let start = Instant::now();
                    let head = workspace::snapshot_node(&path, source, name).unwrap();
                    (path, head, json!({"prepareMs":prepare_ms,"snapshotMs":start.elapsed().as_secs_f64()*1000.0}))
                })
            }).collect();
                    workers
                        .into_iter()
                        .map(|worker| worker.join().unwrap())
                        .collect::<Vec<_>>()
                })
            });
            let after_concurrent = resources();
            for (path, head, _) in &branches {
                assert_eq!(project.run(path, true)["value"], "node-patch");
                verify_result(path, &source, head).unwrap();
            }
            let joined = slot(&temp, "joined");
            let parents: Vec<_> = branches.iter().map(|(_, head, _)| head.clone()).collect();
            timed(&mut times, "mergePrepare", || {
                workspace::prepare(&source, &joined, &base, &parents).unwrap()
            });
            assert_eq!(project.run(&joined, true)["value"], "node-patch");
            let rebuild = if matches!(project, Project::Python { .. }) {
                let evidence = timed(&mut times, "explicitOfflineRebuild", || {
                    project.explicit_rebuild(&joined)
                })
                .unwrap();
                assert_eq!(evidence["runtimeEvidence"]["abi"], node_output["abi"]);
                Some(evidence)
            } else {
                None
            };
            assert_eq!(bytes(&joined.join("branch-a.txt")), b"a");
            assert_eq!(bytes(&joined.join("branch-b.txt")), b"b");
            // Mutation, not inode assumptions: this detects writable hardlink/copy
            // sharing regardless of whether the native copy used a reflink.
            project.patch(&branches[0].0, "branch-only");
            for path in [&node, &branches[1].0, &joined] {
                assert_eq!(
                    fs::read_to_string(path.join(project.dependency())).unwrap(),
                    fs::read_to_string(node.join(project.dependency())).unwrap()
                );
            }
            assert_ne!(
                bytes(&source.join(project.dependency())),
                bytes(&node.join(project.dependency()))
            );
            assert!(verify_result(&branches[0].0, &source, &branches[0].1).is_err());
            let recovered = slot(&temp, "recovered");
            timed(&mut times, "immutableSnapshotReconstruction", || {
                workspace::prepare(&source, &recovered, &base, &parents).unwrap()
            });
            assert_eq!(project.run(&recovered, true)["value"], "node-patch");
            assert_eq!(
                workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap(),
                source_head
            );
            assert_eq!(bytes(&source.join(".git/index")), source_index);
            let private_size = size(node.parent().unwrap(), false);
            let graph_size = size(&graph_directory, false);
            let amplification = (private_size.logical_bytes + graph_size.logical_bytes) as f64
                / source_size.logical_bytes.max(1) as f64;
            let report = json!({"project":name,"profile":"offline-small-real-tools","componentStatus":if gaps.len() == gap_start {"completed"} else {"incomplete"},"toolVersions":tool_versions,"nodeDependencyPaddingFiles":if name == "node" {Some(files)}else{None},
            "timingsMs":times,"sourceProject":source_size,"graphAfterBaseSnapshot":graph_after_base,
            "graphFinal":graph_size,"fivePrivateViewsAndMetadata":private_size,
            "retainedLogicalStorageOverSourceProject":amplification,"concurrentWriters":2,
            "workers":branches.iter().map(|(_,_,timing)|timing).collect::<Vec<_>>(),
            "resourcesBeforeConcurrent":before_concurrent,"resourcesAfterConcurrent":after_concurrent,
            "sourceExecutionEvidence":source_output,"nodeExecutionEvidence":node_output,
            "explicitProjectRebuild":rebuild,"managedEnvironment":managed_report,"homeDiscovery":home_discovery,"sourceDriftIsolated":true,"mutableBranchSharingDetected":false,"validationGaps":&gaps[gap_start..],
            "nativeSandboxAcceptance":"NOT RUN by this component probe",
            "measurementLimits":"warm OS cache; test profile; logical bytes not allocated blocks; process counters exclude child Git/compiler resources; no publication timing or compatibility claim"});
            // The owned graph guard and TempDir also run on assertion failures.
            report
        }));
        let mut report = match attempt {
            Ok(report) => report,
            Err(error) => {
                let diagnostic = error
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| {
                        error
                            .downcast_ref::<&str>()
                            .map(|message| (*message).to_owned())
                    })
                    .unwrap_or_else(|| "Non-string panic in project baseline".into());
                json!({"project":name,"profile":"offline-small-real-tools","componentStatus":"failed",
                    "diagnostic":diagnostic,"timingsMs":times,"completedEvidence":completed_evidence,"validationGaps":&gaps[gap_start..],
                    "measurementLimits":"completed phases only; failed/incomplete phases have no timing or compatibility evidence",
                    "nativeSandboxAcceptance":"NOT RUN by this component probe"})
            }
        };
        report["totalAttemptMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
        println!("GRAPHER_ENVIRONMENT_PROBE {}", report);
        reports.push(report);
    }
    let failed: Vec<_> = reports
        .iter()
        .filter(|report| report["componentStatus"] == "failed")
        .map(|report| report["project"].as_str().unwrap())
        .collect();
    if std::env::var_os("GRAPHER_ENV_PROBE_REQUIRE_UV").is_some() && !selected.contains(&"python") {
        gaps.push("Required uv invocation NOT RUN: Python profile was not selected".into());
    }
    let status = if !failed.is_empty() {
        "failed"
    } else if !gaps.is_empty() {
        "incomplete"
    } else {
        "completed"
    };
    let report = json!({"schema":1,"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,
        "componentStatus":status,"requestedProjects":selected,"profiles":reports,"failedProjects":failed,"validationGaps":gaps});
    if let Some(path) = std::env::var_os("GRAPHER_ENV_PROBE_REPORT") {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
            .unwrap();
        file.write_all(serde_json::to_string_pretty(&report).unwrap().as_bytes())
            .unwrap();
    }
    println!("GRAPHER_ENVIRONMENT_PROBE_SUMMARY {}", report);
    assert!(
        failed.is_empty(),
        "Project baseline failed (report retained): {failed:?}"
    );
    assert!(
        std::env::var_os("GRAPHER_ENV_PROBE_REQUIRE_UV").is_none()
            || selected.contains(&"python") && gaps.is_empty(),
        "Required native tool coverage missing: {gaps:?}"
    );
}
