//! Lazy environment binding from native tool receipts, not Shell-text inference.
//! The business task creates packages/environments. Rust verifies ownership,
//! interpreter metadata and unambiguous selection before sealing E/L.
use crate::{
    environment::{self, LaunchConfig},
    native,
    path_safety::real_child_path,
    workspace,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub kind: String,
    pub prefix: String,
    pub abi: String,
}
impl Binding {
    pub(crate) fn validate(&self) -> Result<(), String> {
        environment::safe_relative(&self.prefix)?;
        if !matches!(self.kind.as_str(), "venv" | "conda")
            || self.abi.len() != 40
            || !self.abi.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Invalid discovered native environment binding".into());
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Context {
    schema: u32,
    workspace: String,
    generation: String,
    launch: LaunchConfig,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema: u32,
    generation: String,
    tool: String,
    prefix: String,
    kind: String,
    created: bool,
}
fn text(path: &Path) -> String {
    native::host_path(path).to_string_lossy().replace('\\', "/")
}
fn canonical(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map(|path| native::host_path(&path))
        .map_err(|e| format!("Cannot resolve native path {}: {e}", path.display()))
}
fn owned(root: &Path, prefix: &Path) -> Result<String, String> {
    let root = canonical(root)?;
    let prefix = if prefix.is_absolute() {
        prefix.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(prefix)
    };
    if !workspace::scope_contains(&prefix, &root) || prefix == root {
        return Err("Environment prefix must belong to this workspace; shared host environments are not adopted".into());
    }
    real_child_path(&root, &prefix, false)?;
    let relative = prefix
        .strip_prefix(&root)
        .map_err(|_| "Environment prefix leaves its workspace")?;
    let name = text(relative);
    environment::safe_relative(&name)?;
    if [".runtime-cache", ".agent-home", ".pi"]
        .iter()
        .any(|scope| workspace::scope_contains(Path::new(&name), Path::new(scope)))
    {
        return Err("Environment prefix overlaps Runtime/engine state or excluded caches".into());
    }
    Ok(name)
}
fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing receipt directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!("pending-{}", Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())
}
pub(crate) fn context(
    root: &Path,
    generation: &str,
    launch: &LaunchConfig,
    session: &Path,
) -> Result<PathBuf, String> {
    Uuid::parse_str(generation).map_err(|_| "Invalid discovery writer generation")?;
    let file = session.join(format!("environment-observer-{generation}.json"));
    let bytes = serde_json::to_vec(&Context {
        schema: 1,
        workspace: text(&canonical(root)?),
        generation: generation.into(),
        launch: launch.clone(),
    })
    .map_err(|e| e.to_string())?;
    if file.exists() {
        if fs::read(&file).map_err(|e| e.to_string())? != bytes {
            return Err("Discovery writer context changed within a generation".into());
        }
    } else {
        write(&file, &bytes)?;
    }
    Ok(file)
}
fn kind(prefix: &Path) -> Result<Option<&'static str>, String> {
    let marker = |path: PathBuf| -> Result<bool, String> {
        match fs::metadata(&path) {
            Ok(metadata) => Ok(metadata.is_file()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!(
                "Cannot inspect native environment metadata {}: {error}",
                path.display()
            )),
        }
    };
    if marker(prefix.join("conda-meta/history"))? {
        Ok(Some("conda"))
    } else if marker(prefix.join("pyvenv.cfg"))? {
        Ok(Some("venv"))
    } else {
        Ok(None)
    }
}
fn interpreter(prefix: &Path, kind: &str) -> PathBuf {
    if cfg!(windows) {
        if kind == "conda" {
            prefix.join("python.exe")
        } else {
            prefix.join("Scripts/python.exe")
        }
    } else {
        prefix.join("bin/python")
    }
}
fn executable_prefix(program: &Path) -> Result<Option<PathBuf>, String> {
    let Some(parent) = program.parent() else {
        return Ok(None);
    };
    if kind(parent)?.is_some() {
        return Ok(Some(parent.to_path_buf()));
    }
    let Some(prefix) = parent.parent() else {
        return Ok(None);
    };
    Ok(kind(prefix)?.map(|_| prefix.to_path_buf()))
}
fn create_prefixes(tool: &str, args: &[String], root: &Path) -> Result<Vec<PathBuf>, String> {
    let module = args.windows(2).position(|pair| pair == ["-m", "venv"]);
    if matches!(tool, "python" | "python3") && module.is_some() {
        let mut prefixes = Vec::new();
        let mut skip = false;
        for arg in &args[module.unwrap() + 2..] {
            if skip {
                skip = false;
                continue;
            }
            if arg == "--prompt" {
                skip = true;
                continue;
            }
            if arg.starts_with('-') {
                continue;
            }
            let path = PathBuf::from(arg);
            owned(root, &path)?;
            prefixes.push(path);
        }
        if prefixes.is_empty() {
            return Err("Native venv creation has no provable workspace prefix".into());
        }
        return Ok(prefixes);
    }
    if tool == "conda"
        && (args.first().is_some_and(|s| s == "create")
            || args.first().is_some_and(|s| s == "env")
                && args.get(1).is_some_and(|s| s == "create"))
    {
        for (i, arg) in args.iter().enumerate() {
            if arg == "-p" || arg == "--prefix" || arg.starts_with("--prefix=") {
                let value = arg
                    .strip_prefix("--prefix=")
                    .map(String::from)
                    .or_else(|| args.get(i + 1).cloned())
                    .ok_or("Missing Conda prefix")?;
                let prefix = PathBuf::from(value);
                owned(root, &prefix)?;
                return Ok(vec![prefix]);
            }
            if arg == "-n" || arg == "--name" || arg.starts_with("--name=") {
                let name = arg
                    .strip_prefix("--name=")
                    .map(String::from)
                    .or_else(|| args.get(i + 1).cloned())
                    .ok_or("Missing Conda name")?;
                if name.contains(['/', '\\']) || matches!(name.as_str(), "base" | "root") {
                    return Err("Invalid private Conda environment name".into());
                }
                let prefix = root.join(".environments").join(name);
                owned(root, &prefix)?;
                return Ok(vec![prefix]);
            }
        }
        return Err(
            "Conda creation has no provable private prefix/name; shared host writes are forbidden"
                .into(),
        );
    }
    Ok(Vec::new())
}

fn private_conda_args(args: &[String], root: &Path) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        let name = if arg == "-n" || arg == "--name" {
            index += 1;
            Some(
                args.get(index)
                    .ok_or("Missing private Conda name")?
                    .as_str(),
            )
        } else {
            arg.strip_prefix("--name=")
        };
        if let Some(name) = name {
            if name.is_empty() || name.contains(['/', '\\']) || matches!(name, "base" | "root") {
                return Err(
                    "Host-global or invalid Conda name is not a private environment".into(),
                );
            }
            let prefix = root.join(".environments").join(name);
            owned(root, &prefix)?;
            result.extend(["--prefix".into(), text(&prefix)]);
        } else {
            result.push(arg.clone());
        }
        index += 1;
    }
    Ok(result)
}

/// Grapher-owned Bash functions delegate an actual resolved native executable.
/// This is a tool adapter, not a model/fixture command-injection actuator.
pub fn tool(args: Vec<String>) -> Result<i32, String> {
    if args.len() < 3 {
        return Err("Invalid native environment tool invocation".into());
    }
    let file = PathBuf::from(&args[0]);
    let ctx: Context = serde_json::from_slice(&fs::read(&file).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if ctx.schema != 1 {
        return Err("Unsupported environment observer protocol".into());
    }
    Uuid::parse_str(&ctx.generation).map_err(|_| "Invalid environment observer generation")?;
    ctx.launch.validate()?;
    let root = canonical(Path::new(&ctx.workspace))?;
    let name = &args[1];
    if !matches!(
        name.as_str(),
        "python" | "python3" | "pip" | "pip3" | "conda"
    ) {
        return Err("Unsupported environment observer tool".into());
    }
    let requested = PathBuf::from(&args[2]);
    let mut requested = if requested.is_absolute() {
        requested
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(requested)
    };
    // Git Bash resolves .exe while reporting an extensionless `type -P` path.
    // This is native executable resolution, not an environment/layout fallback.
    if cfg!(windows) && !requested.is_file() && requested.extension().is_none() {
        requested.set_extension("exe");
    }
    let program = canonical(&requested)?;
    let private_prefix =
        executable_prefix(&requested)?.filter(|prefix| owned(&root, prefix).is_ok());
    let in_view = workspace::scope_contains(&program, &root) || private_prefix.is_some();
    if !in_view
        && !ctx.launch.path.iter().any(|path| {
            program.parent().is_some_and(|parent| {
                canonical(Path::new(path)).ok().as_ref() == Some(&parent.to_path_buf())
            })
        })
    {
        return Err("Native tool is outside the frozen bootstrap/view; no substitute".into());
    }
    let mut business = if name == "conda" {
        private_conda_args(&args[3..], &root)?
    } else {
        args[3..].to_vec()
    };
    let creates = if business.iter().any(|arg| arg == "--dry-run") {
        Vec::new()
    } else {
        create_prefixes(name, &business, &root)?
    };
    if name == "conda"
        && business.first().is_some_and(|s| s == "shell.posix")
        && business.get(1).is_some_and(|s| s == "activate")
    {
        let target = business
            .get(2)
            .ok_or("Conda activation has no private environment")?;
        let prefix = if target.contains(['/', '\\']) {
            PathBuf::from(target)
        } else {
            root.join(".environments").join(target)
        };
        if matches!(target.as_str(), "base" | "root") {
            return Err("Host-global Conda activation is not a business binding".into());
        }
        owned(&root, &prefix)?;
        if kind(&prefix)? != Some("conda") {
            return Err("Private Conda activation target is missing; no host name fallback".into());
        }
        business[2] = text(&prefix);
    }
    let pip_args = if matches!(name.as_str(), "pip" | "pip3") {
        Some(business.as_slice())
    } else if matches!(name.as_str(), "python" | "python3") {
        business
            .windows(2)
            .position(|pair| pair == ["-m", "pip"])
            .map(|index| &business[index + 2..])
    } else {
        None
    };
    // Parse native pip argv, including global flags before its subcommand.
    // Do not let --isolated or an explicit destination bypass host-write checks.
    let mut pip_action = None;
    if let Some(args) = pip_args {
        let mut index = 0;
        while index < args.len() {
            let arg = &args[index];
            if !arg.starts_with('-') {
                pip_action = Some(arg.as_str());
                break;
            }
            if [
                "--log",
                "--proxy",
                "--timeout",
                "--retries",
                "--trusted-host",
                "--cache-dir",
                "--cert",
                "--client-cert",
                "--keyring-provider",
                "--python",
            ]
            .contains(&arg.as_str())
            {
                index += 1;
            }
            index += 1;
        }
        for (index, arg) in args.iter().enumerate() {
            for flag in ["--target", "-t", "--prefix", "--root", "--python"] {
                let value = if arg == flag {
                    Some(
                        args.get(index + 1)
                            .ok_or("Missing pip destination")?
                            .as_str(),
                    )
                } else {
                    arg.strip_prefix(&format!("{flag}="))
                };
                if let Some(value) = value {
                    owned(&root, Path::new(value))?;
                }
            }
        }
    }
    let package_install = matches!(pip_action, Some("install" | "uninstall"));
    if package_install && !in_view {
        let target = business.iter().enumerate().find_map(|(index, arg)| {
            arg.strip_prefix("--target=").map(String::from).or_else(|| {
                if arg == "--target" || arg == "-t" {
                    business.get(index + 1).cloned()
                } else {
                    None
                }
            })
        });
        if let Some(target) = target {
            owned(&root, Path::new(&target))?;
        } else {
            return Err("Package installation into the host interpreter is forbidden; a workspace-owned environment is required".into());
        }
    }
    let conda_mutation = name == "conda"
        && (business.first().is_some_and(|s| {
            matches!(
                s.as_str(),
                "install" | "update" | "upgrade" | "remove" | "uninstall"
            )
        }) || business.first().is_some_and(|s| s == "env")
            && business
                .get(1)
                .is_some_and(|s| matches!(s.as_str(), "update" | "remove")));
    if conda_mutation && !business.iter().any(|s| s == "--help" || s == "-h") {
        let targeted = business.iter().enumerate().find_map(|(index, arg)| {
            if arg == "-p" || arg == "--prefix" {
                business.get(index + 1).map(PathBuf::from)
            } else if let Some(value) = arg.strip_prefix("--prefix=") {
                Some(PathBuf::from(value))
            } else if arg == "-n" || arg == "--name" {
                business
                    .get(index + 1)
                    .map(|value| root.join(".environments").join(value))
            } else {
                arg.strip_prefix("--name=")
                    .map(|value| root.join(".environments").join(value))
            }
        });
        let active = targeted
            .or_else(|| std::env::var_os("CONDA_PREFIX").map(PathBuf::from))
            .ok_or("Conda mutation has no owned active prefix")?;
        owned(&root, &active)?;
    }
    // Keep the lexical executable path: resolving a Unix venv symlink and
    // launching its host target would silently lose sys.prefix/pyvenv.cfg.
    let mut command = Command::new(&requested);
    command.args(&business);
    for key in ["HOME", "USERPROFILE", "CONDA_ENVS_PATH", "CONDA_PKGS_DIRS"] {
        if let Some(value) = ctx.launch.variables.get(key) {
            command.env(key, value);
        }
    }
    if name == "conda" {
        command
            .env("CONDA_ENVS_PATH", root.join(".environments"))
            .env("CONDA_PKGS_DIRS", {
                let cache = PathBuf::from(
                    ctx.launch
                        .variables
                        .get("CONDA_PKGS_DIRS")
                        .ok_or("Missing Run-owned Conda cache binding")?,
                );
                real_child_path(&root, &cache, false)?;
                if !workspace::scope_contains(&cache, &root.join(".runtime-cache")) {
                    return Err("Conda cache leaves its excluded workspace scope".into());
                }
                cache
            })
            .env("CONDA_ALWAYS_COPY", "true")
            .env("CONDA_AUTO_ACTIVATE_BASE", "false");
    }
    if name == "conda" && business == ["shell.bash", "hook"] {
        let output = environment::controlled_output(command)?;
        let hook = String::from_utf8(output).map_err(|e| e.to_string())?;
        if !hook.contains("__conda_exe()") {
            return Err("Unsupported native Conda Bash hook protocol".into());
        }
        let quote = |value: &str| format!("'{}'", value.replace('\\', "/").replace('\'', "'\\''"));
        let helper = std::env::var_os("GRAPHER_ENVIRONMENT_HELPER")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_exe().map_err(|e| e.to_string())?);
        // A supported Conda hook replaces `conda()`. Keep observing actual
        // native argv through its documented executable delegate, not a Shell
        // command parser or replay of arbitrary activation/export text.
        print!(
            "{hook}\n__conda_exe() {{ {} --grapher-env-tool {} conda {} \"$@\"; }}\n",
            quote(&text(&helper)),
            quote(&text(&file)),
            quote(&text(&requested))
        );
        return Ok(0);
    }
    let status = command.status().map_err(|e| e.to_string())?;
    if status.success() {
        let mut candidates: Vec<_> = creates.into_iter().map(|p| (p, true)).collect();
        if let Some(prefix) = private_prefix {
            candidates.push((prefix, false));
        }
        for (prefix, created) in candidates {
            let prefix = canonical(&prefix)?;
            let relative = owned(&root, &prefix)?;
            let kind =
                kind(&prefix)?.ok_or("Created environment has no verifiable native metadata")?;
            let receipt = Receipt {
                schema: 1,
                generation: ctx.generation.clone(),
                tool: text(&program),
                prefix: relative,
                kind: kind.into(),
                created,
            };
            let path = file
                .parent()
                .ok_or("Missing observer session")?
                .join("environment-observations")
                .join(&ctx.generation)
                .join(format!("{}.json", Uuid::new_v4()));
            write(
                &path,
                &serde_json::to_vec(&receipt).map_err(|e| e.to_string())?,
            )?;
        }
    }
    Ok(status.code().unwrap_or(1))
}

fn verify(root: &Path, prefix: &str, expected_kind: &str) -> Result<Binding, String> {
    let path = root.join(prefix);
    let canonical_prefix = canonical(&path)?;
    owned(root, &canonical_prefix)?;
    if kind(&canonical_prefix)? != Some(expected_kind) {
        return Err("Discovered environment metadata changed or is missing".into());
    }
    let python = interpreter(&canonical_prefix, expected_kind);
    real_child_path(&canonical_prefix, &python, true)?
        .ok_or("Discovered native interpreter is missing")?;
    let script = r#"import sys,sysconfig,platform,ssl,zlib,struct,json,pathlib
root=pathlib.Path(sys.argv[1]); prefix=pathlib.Path(sys.argv[2])
assert pathlib.Path(sys.prefix).resolve()==prefix.resolve(), 'Native prefix differs from the owned environment'
assert pathlib.Path(sys.executable).absolute().is_relative_to(prefix.resolve()), 'Native interpreter entry leaves its environment'
constraints=[]
f=root/'.python-version'
if f.exists():
 value=f.read_text().strip(); constraints.append('=='+value+('.*' if value.count('.')==1 else ''))
f=root/'pyproject.toml'
if f.exists():
 import tomllib
 spec=tomllib.loads(f.read_text(encoding='utf-8')).get('project',{}).get('requires-python')
 if spec: constraints.append(spec)
import re
version=tuple(sys.version_info[:3])
for spec in constraints:
 for term in spec.split(','):
  match=re.fullmatch(r'\s*(>=|<=|==|!=|>|<)\s*(\d+(?:\.\d+){0,2})(\.\*)?\s*',term)
  if not match: raise RuntimeError('Unsupported Python requirement; no guessed compatibility: '+spec)
  op,number,wild=match.groups(); parts=tuple(map(int,number.split('.')))
  if wild:
   if op not in ('==','!='): raise RuntimeError('Invalid wildcard constraint')
   ok=version[:len(parts)]==parts
   if op=='!=': ok=not ok
  else:
   target=parts+(0,)*(3-len(parts)); ok={'==':version==target,'!=':version!=target,'>=':version>=target,'<=':version<=target,'>':version>target,'<':version<target}[op]
  if not ok: raise RuntimeError('Created native interpreter does not satisfy '+spec)
import hashlib,_ssl,_hashlib
files={str(pathlib.Path(f).resolve()) for f in [sys.executable,getattr(sys,'_base_executable',sys.executable),_ssl.__file__,_hashlib.__file__,getattr(zlib,'__file__',None)] if f}
if sys.platform=='win32':
 import ctypes
 kernel=ctypes.WinDLL('kernel32',use_last_error=True); kernel.GetModuleHandleW.argtypes=[ctypes.c_wchar_p]; kernel.GetModuleHandleW.restype=ctypes.c_void_p; kernel.GetModuleFileNameW.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p,ctypes.c_uint32]
 for name in ['python3.dll','python%d%d.dll'%sys.version_info[:2],'libssl-3-x64.dll','libssl-3.dll','libcrypto-3-x64.dll','libcrypto-3.dll','zlib1.dll','zlib.dll','libzlib.dll']:
  handle=kernel.GetModuleHandleW(name)
  if handle:
   buffer=ctypes.create_unicode_buffer(32768)
   if not kernel.GetModuleFileNameW(handle,buffer,len(buffer)): raise OSError('Cannot resolve loaded native library '+name)
   files.add(str(pathlib.Path(buffer.value).resolve()))
digests={}
for filename in sorted(files):
 digest=hashlib.sha256()
 with open(filename,'rb') as stream:
  for chunk in iter(lambda:stream.read(1024*1024),b''): digest.update(chunk)
 digests[filename]=digest.hexdigest()
print(json.dumps({'version':sys.version,'abi':sysconfig.get_config_var('SOABI'),'platform':sysconfig.get_platform(),'machine':platform.machine(),'bits':struct.calcsize('P')*8,'openssl':ssl.OPENSSL_VERSION,'zlib':zlib.ZLIB_RUNTIME_VERSION,'nativeFiles':digests},sort_keys=True))
"#;
    let mut command = Command::new(&python);
    command
        .args(["-I", "-B", "-c", script])
        .arg(native::host_path(root))
        .arg(&canonical_prefix)
        .env_clear();
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    if cfg!(windows) {
        command.env(
            "PATH",
            std::env::join_paths([
                canonical_prefix.join("Library/bin"),
                PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_default()).join("System32"),
            ])
            .map_err(|e| e.to_string())?,
        );
    }
    command.env("PYTHONDONTWRITEBYTECODE", "1");
    let output = environment::controlled_output(command)?;
    let abi = git2::Oid::hash_object(git2::ObjectType::Blob, &output)
        .map_err(|e| e.to_string())?
        .to_string();
    Ok(Binding {
        kind: expected_kind.into(),
        prefix: prefix.into(),
        abi,
    })
}

pub(crate) fn validate_launch(root: &Path, launch: &LaunchConfig) -> Result<(), String> {
    if let Some(expected) = &launch.environment {
        if verify(root, &expected.prefix, &expected.kind)? != *expected {
            return Err(
                "Bound native interpreter ABI/library bytes changed; refusing unsafe startup"
                    .into(),
            );
        }
    }
    Ok(())
}

pub(crate) fn resolve(
    root: &Path,
    launch: &LaunchConfig,
    session: &Path,
    generation: &str,
) -> Result<LaunchConfig, String> {
    let directory = session.join("environment-observations").join(generation);
    let mut candidates = BTreeMap::new();
    match fs::read_dir(&directory) {
        Ok(entries) => {
            for entry in entries {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.extension().is_none_or(|ext| ext != "json") {
                    continue;
                }
                real_child_path(session, &path, true)?
                    .ok_or("Missing native environment receipt")?;
                let receipt: Receipt =
                    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                if receipt.schema != 1 || receipt.generation != generation {
                    return Err(
                        "Stale native environment observation cannot bind this generation".into(),
                    );
                }
                environment::safe_relative(&receipt.prefix)?;
                candidates.insert(receipt.prefix, receipt.kind);
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    // Metadata inventory is a bounded refusal guard, never an adoption
    // heuristic. Do not traverse environment contents or follow directory links.
    let mut inventory = vec![root.to_path_buf()];
    let mut visited = 0;
    while let Some(directory) = inventory.pop() {
        visited += 1;
        if visited > 50_000 {
            return Err(
                "Native environment metadata inventory exceeded its safe directory bound".into(),
            );
        }
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                continue;
            }
            let prefix = entry.path();
            let relative = prefix
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if [".git", ".runtime-cache", ".agent-home", ".pi"]
                .iter()
                .any(|scope| workspace::scope_contains(Path::new(&relative), Path::new(scope)))
            {
                continue;
            }
            if kind(&prefix)?.is_some() {
                let relative = owned(root, &prefix)?;
                if !candidates.contains_key(&relative)
                    && launch
                        .environment
                        .as_ref()
                        .is_none_or(|binding| binding.prefix != relative)
                {
                    return Err(format!("Unobserved native environment at {relative}; refusing directory-name inference or a silent bootstrap binding"));
                }
            } else {
                inventory.push(prefix);
            }
        }
    }
    if candidates.len() > 1 {
        return Err("Ambiguous independent native environments in this execution; no automatic authority or user selection".into());
    }
    let mut next = launch.clone();
    if let Some((prefix, kind)) = candidates.into_iter().next() {
        let binding = verify(root, &prefix, &kind)?;
        let entry = interpreter(Path::new(&format!("{{workspace}}/{prefix}")), &kind);
        let bin = text(
            entry
                .parent()
                .ok_or("Missing environment entry directory")?,
        );
        next.entry = text(&entry);
        next.path.retain(|p| !p.starts_with("{workspace}/"));
        next.path.insert(0, bin);
        next.variables.remove("VIRTUAL_ENV");
        next.variables.remove("CONDA_PREFIX");
        next.variables.remove("CONDA_DEFAULT_ENV");
        if kind == "conda" {
            let conda = fs::read(session.join(format!("environment-observer-{generation}.json")))
                .map_err(|e| e.to_string())?;
            let ctx: Context = serde_json::from_slice(&conda).map_err(|e| e.to_string())?;
            let tool = find_conda(&ctx.launch.path)?;
            let quoted = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
            next.hook = Some(format!(
                "eval \"$({} shell.bash hook)\" && conda activate {}",
                quoted(&tool),
                quoted(&format!("{{workspace}}/{prefix}"))
            ));
            if cfg!(windows) {
                next.path
                    .insert(1, format!("{{workspace}}/{prefix}/Scripts"));
                next.path
                    .insert(2, format!("{{workspace}}/{prefix}/Library/bin"));
            }
            next.variables
                .insert("CONDA_PREFIX".into(), format!("{{workspace}}/{prefix}"));
        } else {
            next.hook = None;
            next.variables
                .insert("VIRTUAL_ENV".into(), format!("{{workspace}}/{prefix}"));
        }
        next.environment = Some(binding);
    } else if let Some(binding) = &launch.environment {
        let verified = verify(root, &binding.prefix, &binding.kind)?;
        next.environment = Some(verified);
    }
    next.validate()?;
    Ok(next)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf, LaunchConfig, String) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).unwrap();
        git2::Repository::init(&root).unwrap();
        let policy = crate::environment_automatic::resolve(&root, false)
            .unwrap()
            .0
            .unwrap();
        let launch = policy.launch.expanded(&root);
        let session = temp.path().join("session");
        let generation = Uuid::new_v4().to_string();
        context(&root, &generation, &launch, &session).unwrap();
        (temp, root, session, launch, generation)
    }
    fn python(launch: &LaunchConfig) -> String {
        for directory in &launch.path {
            let path = Path::new(directory).join(if cfg!(windows) {
                "python.exe"
            } else {
                "python3"
            });
            if path.is_file() {
                return text(&path);
            }
        }
        panic!("Native Python required for the focused discovery test");
    }
    fn create(root: &Path, session: &Path, launch: &LaunchConfig, name: &str) {
        let path = root.join(name);
        let observer = fs::read_dir(session)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("environment-observer-")
            })
            .unwrap()
            .path();
        assert_eq!(
            tool(vec![
                text(&observer),
                "python".into(),
                python(launch),
                "-m".into(),
                "venv".into(),
                text(&path)
            ])
            .unwrap(),
            0
        );
    }
    #[test]
    fn empty_and_configuration_files_do_not_bind_or_create_an_environment() {
        let (_temp, root, session, launch, generation) = setup();
        fs::write(root.join(".env"), "NOT_AN_ENVIRONMENT=1").unwrap();
        fs::write(
            root.join("environment.yml"),
            "name: future\ndependencies: [python]",
        )
        .unwrap();
        let next = resolve(&root, &launch, &session, &generation).unwrap();
        assert!(next.environment.is_none());
        assert!(!root.join(".venv").exists());
    }
    #[test]
    fn business_created_custom_venv_binds_from_receipt_and_actual_native_prefix() {
        let (_temp, root, session, launch, generation) = setup();
        create(&root, &session, &launch, "business-env");
        let next = resolve(&root, &launch, &session, &generation).unwrap();
        assert_eq!(next.environment.as_ref().unwrap().prefix, "business-env");
        assert_eq!(next.environment.as_ref().unwrap().kind, "venv");
        assert!(next.entry.contains("business-env"));
        assert!(next.variables.contains_key("VIRTUAL_ENV"));
        assert_ne!(next, launch);
        validate_launch(&root, &next).unwrap();
        let mut damaged = next.clone();
        damaged.environment.as_mut().unwrap().abi = "changed".into();
        assert!(validate_launch(&root, &damaged)
            .unwrap_err()
            .contains("unsafe startup"));
        let entry = interpreter(&root.join("business-env"), "venv");
        assert_eq!(tool(vec![text(&session.join(format!("environment-observer-{generation}.json"))), "python".into(), text(&entry), "-c".into(), "import sys,pathlib; assert pathlib.Path(sys.prefix).resolve()==pathlib.Path(sys.argv[1]).resolve()".into(), text(&root.join("business-env"))]).unwrap(), 0);
        let empty_session = session.join("followup");
        fs::create_dir(&empty_session).unwrap();
        let unchanged = resolve(&root, &next, &empty_session, &Uuid::new_v4().to_string()).unwrap();
        assert_eq!(next, unchanged, "No metadata-only version increment");
    }
    #[test]
    fn ambiguous_creations_stale_receipts_and_unobserved_directories_fail_without_user_authority() {
        let (_temp, root, session, launch, generation) = setup();
        create(&root, &session, &launch, "first");
        let unknown = session.join("unknown");
        fs::create_dir(&unknown).unwrap();
        assert!(resolve(&root, &launch, &unknown, &generation)
            .unwrap_err()
            .contains("Unobserved"));
        let stale_generation = Uuid::new_v4().to_string();
        let stale = session
            .join("environment-observations")
            .join(&stale_generation);
        fs::create_dir_all(&stale).unwrap();
        let receipt = fs::read_dir(session.join("environment-observations").join(&generation))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::copy(receipt, stale.join("stale.json")).unwrap();
        assert!(resolve(&root, &launch, &session, &stale_generation)
            .unwrap_err()
            .contains("Stale"));
        create(&root, &session, &launch, "second");
        assert!(resolve(&root, &launch, &session, &generation)
            .unwrap_err()
            .contains("Ambiguous"));
    }
    #[test]
    fn native_conda_names_are_private_prefixes_and_never_host_base_or_a_name_search() {
        let (_temp, root, _session, _launch, _generation) = setup();
        let args = private_conda_args(
            &[
                "create".into(),
                "-n".into(),
                "business".into(),
                "--offline".into(),
            ],
            &root,
        )
        .unwrap();
        assert_eq!(
            args,
            vec![
                "create".to_string(),
                "--prefix".into(),
                text(&root.join(".environments/business")),
                "--offline".into()
            ]
        );
        for name in ["base", "root", "../shared", "other/shared", ""] {
            assert!(
                private_conda_args(&["install".into(), format!("--name={name}")], &root).is_err()
            );
        }
        let nested = root.join("tools/unobserved");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("pyvenv.cfg"), "home = unavailable").unwrap();
        let unknown = root.join("session");
        fs::create_dir(&unknown).unwrap();
        assert!(resolve(&root, &_launch, &unknown, &_generation)
            .unwrap_err()
            .contains("Unobserved"));
    }

    #[test]
    fn shared_prefixes_and_host_package_mutation_are_refused_before_execution() {
        let (temp, _root, session, launch, _generation) = setup();
        let file = text(&session.join(format!("environment-observer-{}.json", _generation)));
        let python = python(&launch);
        let external = temp.path().join("shared");
        assert!(tool(vec![
            file.clone(),
            "python".into(),
            python.clone(),
            "-m".into(),
            "venv".into(),
            text(&external)
        ])
        .unwrap_err()
        .contains("workspace"));
        assert!(!external.exists());
        assert!(tool(vec![
            file.clone(),
            "python".into(),
            python.clone(),
            "-m".into(),
            "pip".into(),
            "--isolated".into(),
            "install".into(),
            "fake-no-network-package".into()
        ])
        .unwrap_err()
        .contains("host interpreter"));
        assert!(tool(vec![
            file.clone(),
            "python".into(),
            python.clone(),
            "-m".into(),
            "pip".into(),
            "install".into(),
            "--target".into(),
            text(&external),
            "fake-no-network-package".into()
        ])
        .unwrap_err()
        .contains("workspace"));
        assert!(tool(vec![
            file,
            "python".into(),
            python,
            "-m".into(),
            "pip".into(),
            "install".into(),
            "fake-no-network-package".into()
        ])
        .unwrap_err()
        .contains("host interpreter"));
    }
}

fn find_conda(paths: &[String]) -> Result<String, String> {
    for directory in paths {
        let path = Path::new(directory).join(if cfg!(windows) { "conda.exe" } else { "conda" });
        if path.is_file() {
            return Ok(text(&canonical(&path)?));
        }
    }
    Err("Native Conda activation tool is unavailable; no interpreter fallback".into())
}
