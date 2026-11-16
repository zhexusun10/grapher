//! Lazy environment observation from native tool receipts. The current workspace
//! lets Bash explore/use ambient tools and only records verifiable private environments.
use crate::{
    environment::{self, EnvironmentScope, LaunchConfig},
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

#[path = "environment_runtime_evidence.rs"]
mod runtime_evidence;
pub use runtime_evidence::RuntimeEvidence;

/// Non-owning description of an external environment actually selected by a
/// business Bash tool. It is evidence for the next Node, never an authorization.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AmbientEnvironmentHint {
    pub manager: String,
    pub selector: String,
    pub executable: String,
}
impl AmbientEnvironmentHint {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.manager.is_empty()
            || self.selector.is_empty()
            || self.executable.is_empty()
            || self.manager.contains('\0')
            || self.selector.contains('\0')
            || self.executable.contains('\0')
        {
            return Err("Invalid ambient environment hint".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub kind: String,
    pub prefix: String,
    pub abi: String,
    /// Ownership root for `prefix`: the visible project workspace or the
    /// external process-state root. Omitted only by pre-dual-root records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// Bounded native files observed with the ABI proof. Old L keeps None and
    /// its original checksum; never synthesize missing historical evidence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_evidence: Option<RuntimeEvidence>,
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
        if self
            .root
            .as_deref()
            .is_some_and(|root| !matches!(root, "workspace" | "state"))
        {
            return Err("Invalid discovered native environment root".into());
        }
        if let Some(evidence) = &self.runtime_evidence {
            evidence.validate()?;
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Context {
    schema: u32,
    workspace: String,
    /// Backend-bound source, never chosen by tool argv. Absent in old receipts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    /// External process-state root for state-bound launches. Absent in old
    /// receipts and for source-only policies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    state: Option<String>,
    generation: String,
    launch: LaunchConfig,
    /// Best-effort business environment tools are not policy-gated.
    #[serde(default)]
    best_effort: bool,
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
    /// Root that owns `prefix`; old receipts default to the policy root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    root: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AmbientReceipt {
    schema: u32,
    generation: String,
    hint: AmbientEnvironmentHint,
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
    let prefix = native::host_path(&prefix);
    let relative = prefix
        .strip_prefix(&root)
        .ok()
        .or_else(|| {
            // Resolve only the workspace ancestor: Windows 8.3 paths, extended
            // paths and trusted root aliases may name the same workspace. Resolving
            // the entire candidate would conceal redirected children. Prefer the
            // outermost root alias so links beneath it still get checked.
            prefix
                .ancestors()
                .filter(|ancestor| canonical(ancestor).is_ok_and(|resolved| resolved == root))
                .last()
                .and_then(|alias| prefix.strip_prefix(alias).ok())
        })
        .filter(|relative| !relative.as_os_str().is_empty())
        .ok_or("Environment prefix must belong to this workspace; shared host environments are not adopted")?;
    let name = text(relative);
    environment::safe_relative(&name)?;
    real_child_path(&root, &root.join(relative), false)?;
    if [
        ".runtime-cache",
        ".agent-home",
        ".pi",
        ".project-git",
        ".git-config",
    ]
    .iter()
    .any(|scope| workspace::scope_contains(Path::new(&name), Path::new(scope)))
    {
        return Err("Environment prefix overlaps Runtime/engine state or excluded caches".into());
    }
    Ok(name)
}
fn roots<'a>(workspace: &'a Path, state: Option<&'a Path>) -> Vec<(&'static str, &'a Path)> {
    match state {
        Some(state) if !crate::path_identity::same_path(workspace, state) => {
            vec![("workspace", workspace), ("state", state)]
        }
        _ => vec![("workspace", workspace)],
    }
}
fn root_for<'a>(roots: &[(&'static str, &'a Path)], label: &str) -> Result<&'a Path, String> {
    roots
        .iter()
        .find(|(candidate, _)| *candidate == label)
        .map(|(_, path)| *path)
        .ok_or_else(|| "Native environment root is unavailable".to_string())
}
pub(crate) fn binding_root_label(
    launch: &LaunchConfig,
    roots: &[(&'static str, &Path)],
) -> &'static str {
    launch
        .environment
        .as_ref()
        .and_then(|binding| binding.root.as_deref())
        .map(|root| {
            if root == "workspace" {
                "workspace"
            } else {
                "state"
            }
        })
        .unwrap_or_else(|| {
            if launch.state_bound() && roots.iter().any(|(label, _)| *label == "state") {
                "state"
            } else {
                "workspace"
            }
        })
}
/// Resolve a prefix against each candidate root. A path inside one root that
/// fails ownership (excluded scope, link escape) is a policy error; a path that
/// does not belong to a root simply continues to the next candidate.
fn owned_any(roots: &[(&'static str, &Path)], prefix: &Path) -> Result<(String, String), String> {
    let mut outside = None;
    for (label, root) in roots {
        match owned(root, prefix) {
            Ok(relative) => return Ok(((*label).to_string(), relative)),
            Err(error) if error.contains("must belong to this workspace") => {
                outside = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    Err(outside.unwrap_or_else(|| "Environment prefix has no owned root".into()))
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
#[cfg(test)]
pub(crate) fn context(
    root: &Path,
    generation: &str,
    launch: &LaunchConfig,
    session: &Path,
    best_effort: bool,
) -> Result<PathBuf, String> {
    context_with_state(root, None, generation, launch, session, best_effort)
}
#[cfg(test)]
pub(crate) fn context_with_state(
    workspace: &Path,
    state: Option<&Path>,
    generation: &str,
    launch: &LaunchConfig,
    session: &Path,
    best_effort: bool,
) -> Result<PathBuf, String> {
    context_with_source(workspace, state, None, generation, launch, session, best_effort)
}

pub(crate) fn context_with_source(
    workspace: &Path,
    state: Option<&Path>,
    source: Option<&Path>,
    generation: &str,
    launch: &LaunchConfig,
    session: &Path,
    best_effort: bool,
) -> Result<PathBuf, String> {
    Uuid::parse_str(generation).map_err(|_| "Invalid discovery writer generation")?;
    let file = session.join(format!("environment-observer-{generation}.json"));
    let mut context = Context {
        schema: 1,
        workspace: text(&canonical(workspace)?),
        source: source.map(canonical).transpose()?.map(|path| text(&path)),
        state: state.map(canonical).transpose()?.map(|path| text(&path)),
        generation: generation.into(),
        launch: launch.clone(),
        best_effort,
    };
    let bytes = serde_json::to_vec(&context).map_err(|e| e.to_string())?;
    if file.exists() {
        let saved = fs::read(&file).map_err(|e| e.to_string())?;
        if saved != bytes {
            // A resumed pre-guard generation keeps its immutable context. This
            // compatibility exception cannot change any other recorded input.
            let previous: Context = serde_json::from_slice(&saved).map_err(|e| e.to_string())?;
            if previous.source.is_some() {
                return Err("Discovery writer context changed within a generation".into());
            }
            context.source = None;
            if previous != context {
                return Err("Discovery writer context changed within a generation".into());
            }
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
/// Observe only the interpreter's entrypoint, never matching '-m' inside an
/// application's argv. This does not rewrite/reject commands: unfamiliar
/// interpreter options simply cannot supply module-based binding evidence.
fn python_module(args: &[String]) -> Option<(&str, &[String])> {
    let mut index = 0;
    while let Some(argument) = args.get(index) {
        if argument == "--check-hash-based-pycs" {
            args.get(index + 1)?;
            index += 2;
            continue;
        }
        let options = argument.strip_prefix('-')?;
        if options.is_empty() || options.starts_with('-') { return None; }
        for (offset, option) in options.char_indices() {
            let rest = &options[offset + option.len_utf8()..];
            match option {
                'm' => return if rest.is_empty() {
                    Some((args.get(index + 1)?.as_str(), &args[index + 2..]))
                } else { Some((rest, &args[index + 1..])) },
                'c' | 'h' | '?' | 'V' => return None,
                'W' | 'X' => {
                    if rest.is_empty() { args.get(index + 1)?; index += 1; }
                    break; // The remaining characters are the option's value.
                }
                'b' | 'B' | 'd' | 'E' | 'i' | 'I' | 'O' | 'P' | 'q' | 'R'
                | 's' | 'S' | 'u' | 'v' | 'x' => {}
                _ => return None,
            }
        }
        index += 1;
    }
    None
}

fn create_prefixes(
    tool: &str,
    args: &[String],
    workspace: &Path,
    state: Option<&Path>,
) -> Result<Vec<PathBuf>, String> {
    let roots = roots(workspace, state);
    let conda_root = state.unwrap_or(workspace);
    let module = matches!(tool, "python" | "python3")
        .then(|| python_module(args)).flatten().filter(|(module, _)| *module == "venv");
    if let Some((_, arguments)) = module {
        let mut prefixes = Vec::new();
        let mut skip = false;
        let mut literal = false;
        for arg in arguments {
            if skip {
                skip = false;
                continue;
            }
            if !literal {
                if matches!(arg.as_str(), "-h" | "--help") { return Ok(Vec::new()); }
                if arg == "--" { literal = true; continue; }
                if arg == "--prompt" { skip = true; continue; }
                if arg.starts_with('-') { continue; }
            }
            prefixes.push(PathBuf::from(arg));
        }
        if prefixes.is_empty() {
            return Err("Native venv creation has no provable workspace prefix".into());
        }
        for prefix in &prefixes { owned_any(&roots, prefix)?; }
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
                owned_any(&roots, &prefix)?;
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
                let prefix = conda_root.join(".environments").join(name);
                owned(conda_root, &prefix)?;
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

fn hint(
    name: &str,
    program: &Path,
    args: &[String],
    workspace: &Path,
    state: Option<&Path>,
    cwd: &Path,
    launch: &LaunchConfig,
) -> Option<AmbientEnvironmentHint> {
    let manager = match name {
        "conda" => "conda",
        "python" | "python3" | "pip" | "pip3" => "python",
        _ => return None,
    };
    let roots = roots(workspace, state);
    if executable_prefix(program)
        .ok()
        .flatten()
        .is_some_and(|prefix| owned_any(&roots, &prefix).is_ok())
    {
        return None;
    }
    let selector = if name == "conda" {
        conda_private_prefix(args, cwd)
            .map(|path| text(&path))
            .or_else(|| conda_environment_name(args).map(|name| format!("name:{name}")))
            .or_else(|| std::env::var("CONDA_PREFIX").ok())
    } else {
        Some(text(program))
    }?;
    let changed = launch
        .environment
        .as_ref()
        .is_none_or(|binding| binding.prefix != selector);
    changed.then(|| AmbientEnvironmentHint {
        manager: manager.into(),
        selector,
        executable: text(program),
    })
}
/// Conda run delegates the remaining argv to the child even without '--'.
/// The child's --prefix/--name flags are not evidence of manager selection.
fn conda_manager_args(args: &[String]) -> &[String] {
    let end = args.iter().position(|argument| argument == "--").unwrap_or(args.len());
    let mut options = &args[..end];
    if let Some(command) = options.iter().position(|argument| !argument.starts_with('-')) {
        if options[command] == "run" {
            let mut index = command + 1;
            while index < options.len() {
                let argument = &options[index];
                if !argument.starts_with('-') || argument == "-" {
                    options = &options[..index];
                    break;
                }
                index += if matches!(argument.as_str(), "-n" | "--name" | "-p" | "--prefix" | "--cwd") { 2 } else { 1 };
            }
        }
    }
    if options.iter().any(|argument| matches!(argument.as_str(), "-h" | "--help" | "-V" | "--version")) {
        &args[..0]
    } else { options }
}

fn conda_environment_name(args: &[String]) -> Option<&str> {
    let args = conda_manager_args(args);
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--" { break; }
        if args[index] == "-n" || args[index] == "--name" {
            return args.get(index + 1).map(String::as_str);
        }
        if let Some(name) = args[index].strip_prefix("--name=") {
            return Some(name);
        }
        index += 1;
    }
    None
}

fn conda_private_prefix(args: &[String], cwd: &Path) -> Option<PathBuf> {
    let args = conda_manager_args(args);
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        if argument == "--" { break; }
        let value = if argument == "-p" || argument == "--prefix" {
            index += 1;
            args.get(index).map(String::as_str)
        } else {
            argument.strip_prefix("--prefix=")
        };
        if let Some(value) = value {
            if value.is_empty() { return None; }
            // --prefix always names a filesystem path, including a bare leaf.
            // Native relative arguments belong to this invocation's cwd, not
            // the external state root used for legacy name-based provisioning.
            return Some(cwd.join(value));
        }
        index += 1;
    }
    if args
        .first()
        .is_some_and(|arg| arg == "shell.posix" || arg == "shell.bash")
        && args.get(1).is_some_and(|arg| arg == "activate")
    {
        let value = args.get(2)?;
        if value.contains(['/', '\\']) {
            let prefix = PathBuf::from(value);
            return Some(cwd.join(prefix));
        }
    }
    None
}

fn launch_environment_differs(
    launch: &LaunchConfig,
    workspace: &Path,
    state: Option<&Path>,
    name: &str,
    detected_prefix: Option<&Path>,
) -> bool {
    if !matches!(name, "python" | "python3" | "pip" | "pip3") {
        return false;
    }
    let Some(binding) = &launch.environment else {
        return false;
    };
    let roots = roots(workspace, state);
    let Ok(root) = root_for(&roots, binding_root_label(launch, &roots)) else {
        return false;
    };
    let expected = root.join(&binding.prefix);
    match detected_prefix {
        Some(prefix) => canonical(prefix).ok().as_deref() != canonical(&expected).ok().as_deref(),
        // A host interpreter is not the bound venv even when both resolve to
        // the same binary (the normal POSIX venv symlink layout). Its lexical
        // prefix determines sys.prefix; executable identity cannot stand in
        // for environment identity, including when old prefix metadata is gone.
        None => true,
    }
}

fn unbound_launch(launch: &LaunchConfig) -> Result<LaunchConfig, String> {
    let mut next = launch.clone();
    next.entry = next.shell.clone();
    next.restore_unbound_path();
    next.hook = None;
    next.environment = None;
    next.variables.remove("VIRTUAL_ENV");
    next.variables.remove("CONDA_PREFIX");
    next.variables.remove("CONDA_DEFAULT_ENV");
    // Explicit launches require the declared entry directory to remain first
    // even when a failed native verification falls back to the unbound shell.
    // Decide after clearing the binding: an ambient automatic launch must keep
    // its frozen business PATH order when it becomes unbound.
    if next.requires_entry_first() {
        if let Some(directory) = Path::new(&next.shell).parent().map(text) {
            next.path.retain(|path| path != &directory);
            next.path.insert(0, directory);
        }
    }
    // Ownership survives even when activation cannot be verified.
    next.validate()?;
    Ok(next)
}

fn receipt_path(file: &Path, generation: &str) -> Result<PathBuf, String> {
    Ok(file
        .parent()
        .ok_or("Missing observer session")?
        .join("environment-observations")
        .join(generation)
        .join(format!("{}.json", Uuid::new_v4())))
}

fn write_receipt(file: &Path, receipt: &Receipt, generation: &str) -> Result<(), String> {
    write(
        &receipt_path(file, generation)?,
        &serde_json::to_vec(receipt).map_err(|e| e.to_string())?,
    )
}

/// Standard venv activation/console launchers often retain their creation path.
/// Private execution must not silently run a source-bound environment tool,
/// even if its local copy was removed. This is a bounded tool diagnostic, not
/// path relocation or a sandbox for arbitrary programs. Unrelated ambient
/// environments remain usable; source permissions and project bytes are intact.
fn reject_source_environment_tool(
    workspace: &Path,
    source: Option<&str>,
    requested: &Path,
) -> Result<(), String> {
    let Some(source) = source else { return Ok(()); };
    if source.contains('\0') || !Path::new(source).is_absolute() {
        return Err("Invalid native observer source binding".into());
    }
    let source = Path::new(source);
    if crate::path_identity::same_path(workspace, source) {
        return Ok(());
    }
    // Compare executable directories BEFORE resolving the executable symlink:
    // Unix venv/bin/python usually points at an unrelated host Python binary.
    if requested.parent().is_some_and(|parent| workspace::scope_contains(parent, source)) {
        return Err("Source-bound environment tool selected from a private workspace; refusing source-environment execution. A copied activation script or launcher may still name its old location. Recreate/install the environment at its current workspace path or use an unrelated external environment; no automatic relocation is performed.".into());
    }
    Ok(())
}

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
    let workspace = canonical(Path::new(&ctx.workspace))?;
    let state = ctx
        .state
        .as_deref()
        .map(|path| canonical(Path::new(path)))
        .transpose()?;
    let roots = roots(&workspace, state.as_deref());
    let conda_root = state.as_deref().unwrap_or(&workspace);
    let name = &args[1];
    if !matches!(
        name.as_str(),
        "python" | "python3" | "pip" | "pip3" | "conda"
    ) {
        return Err("Unsupported environment observer tool".into());
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let mut requested = cwd.join(&args[2]);
    // Git Bash resolves .exe while reporting an extensionless `type -P` path.
    // This is native executable resolution, not an environment/layout fallback.
    if cfg!(windows) && !requested.is_file() && requested.extension().is_none() {
        requested.set_extension("exe");
    }
    reject_source_environment_tool(&workspace, ctx.source.as_deref(), &requested)?;
    let program = canonical(&requested)?;
    // Also catch executable-file aliases into source, not only directory aliases.
    reject_source_environment_tool(&workspace, ctx.source.as_deref(), &program)?;
    let detected_prefix = executable_prefix(&requested)?;
    let private = detected_prefix
        .clone()
        .and_then(|prefix| {
            owned_any(&roots, &prefix)
                .ok()
                .map(|(_, relative)| (prefix, relative))
        })
        .filter(|(_, relative)| !relative.is_empty());
    let private_prefix = private.as_ref().map(|(prefix, _)| prefix.clone());
    let in_view = workspace::scope_contains(&program, &workspace)
        || state
            .as_deref()
            .is_some_and(|state| workspace::scope_contains(&program, state))
        || private_prefix.is_some();
    if !ctx.best_effort
        && !in_view
        && !ctx.launch.path.iter().any(|path| {
            program.parent().is_some_and(|parent| {
                canonical(Path::new(path)).ok().as_ref() == Some(&parent.to_path_buf())
            })
        })
    {
        return Err("Native tool is outside the frozen bootstrap/view; no substitute".into());
    }
    let mut business = if name == "conda" && !ctx.best_effort {
        private_conda_args(&args[3..], conda_root)?
    } else {
        args[3..].to_vec()
    };
    let creates = if business.iter().any(|arg| arg == "--dry-run") {
        Vec::new()
    } else if ctx.best_effort && name == "conda" {
        // Name-based Conda creates may target the user's existing envs_dirs;
        // never guess a private prefix or rewrite those native arguments.
        Vec::new()
    } else if ctx.best_effort {
        create_prefixes(name, &business, &workspace, state.as_deref()).unwrap_or_default()
    } else {
        create_prefixes(name, &business, &workspace, state.as_deref())?
    };
    if !ctx.best_effort
        && name == "conda"
        && business.first().is_some_and(|s| s == "shell.posix")
        && business.get(1).is_some_and(|s| s == "activate")
    {
        let target = business
            .get(2)
            .ok_or("Conda activation has no private environment")?;
        let prefix = if target.contains(['/', '\\']) {
            PathBuf::from(target)
        } else {
            conda_root.join(".environments").join(target)
        };
        if matches!(target.as_str(), "base" | "root") {
            return Err("Host-global Conda activation is not a business binding".into());
        }
        owned_any(&roots, &prefix)?;
        if kind(&prefix)? != Some("conda") {
            return Err("Private Conda activation target is missing; no host name fallback".into());
        }
        business[2] = text(&prefix);
    }
    let pip_args = if matches!(name.as_str(), "pip" | "pip3") {
        Some(business.as_slice())
    } else if matches!(name.as_str(), "python" | "python3") {
        python_module(&business).and_then(|(module, arguments)| (module == "pip").then_some(arguments))
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
        if !ctx.best_effort {
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
                        owned_any(&roots, Path::new(value))?;
                    }
                }
            }
        }
    }
    let package_install = matches!(pip_action, Some("install" | "uninstall"));
    if package_install && !in_view && !ctx.best_effort {
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
            owned_any(&roots, Path::new(&target))?;
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
    if conda_mutation && !ctx.best_effort && !business.iter().any(|s| s == "--help" || s == "-h") {
        let targeted = business.iter().enumerate().find_map(|(index, arg)| {
            if arg == "-p" || arg == "--prefix" {
                business.get(index + 1).map(PathBuf::from)
            } else if let Some(value) = arg.strip_prefix("--prefix=") {
                Some(PathBuf::from(value))
            } else if arg == "-n" || arg == "--name" {
                business
                    .get(index + 1)
                    .map(|value| conda_root.join(".environments").join(value))
            } else {
                arg.strip_prefix("--name=")
                    .map(|value| conda_root.join(".environments").join(value))
            }
        });
        let active = targeted
            .or_else(|| std::env::var_os("CONDA_PREFIX").map(PathBuf::from))
            .ok_or("Conda mutation has no owned active prefix")?;
        owned_any(&roots, &active)?;
    }
    // Keep the lexical executable path: resolving a Unix venv symlink and
    // launching its host target would silently lose sys.prefix/pyvenv.cfg.
    let mut command = Command::new(&requested);
    command.current_dir(&cwd).args(&business);
    if !ctx.best_effort {
        for key in ["HOME", "USERPROFILE", "CONDA_ENVS_PATH", "CONDA_PKGS_DIRS"] {
            if let Some(value) = ctx.launch.variables.get(key) {
                command.env(key, value);
            }
        }
    }
    // Best-effort observation inherits this Bash invocation, including explicit
    // per-command exports. Recording provenance must not undo business setup.
    if name == "conda" && !ctx.best_effort {
        command
            .env("CONDA_ENVS_PATH", conda_root.join(".environments"))
            .env("CONDA_PKGS_DIRS", {
                let cache = PathBuf::from(
                    ctx.launch
                        .variables
                        .get("CONDA_PKGS_DIRS")
                        .ok_or("Missing Run-owned Conda cache binding")?,
                );
                real_child_path(conda_root, &cache, false)?;
                if !workspace::scope_contains(&cache, &conda_root.join(".runtime-cache")) {
                    return Err("Conda cache leaves its excluded workspace scope".into());
                }
                cache
            })
            .env("CONDA_ALWAYS_COPY", "true");
    } else if name == "conda" {
        // Preserve ambient Conda env discovery and package-manager configuration.
        for key in [
            "CONDA_ENVS_PATH",
            "CONDA_PKGS_DIRS",
            "CONDARC",
            "CONDA_PREFIX",
            "CONDA_DEFAULT_ENV",
            "CONDA_SHLVL",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
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
        if ctx.best_effort {
            if let Some(hint) = hint(
                name,
                &requested,
                &business,
                &workspace,
                state.as_deref(),
                &cwd,
                &ctx.launch,
            ) {
                let receipt = AmbientReceipt {
                    schema: 1,
                    generation: ctx.generation.clone(),
                    hint,
                };
                receipt.hint.validate()?;
                let directory = file
                    .parent()
                    .ok_or("Missing observer session")?
                    .join("ambient-observations")
                    .join(&ctx.generation);
                fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
                write(
                    &directory.join(format!("{}.json", Uuid::new_v4())),
                    &serde_json::to_vec(&receipt).map_err(|e| e.to_string())?,
                )?;
            }
        }
        let mut candidates: Vec<_> = creates.into_iter().map(|p| (p, true)).collect();
        if let Some(prefix) = private_prefix {
            candidates.push((prefix, false));
        }
        if ctx.best_effort && name == "conda" {
            if let Some(prefix) = conda_private_prefix(&business, &cwd) {
                if owned_any(&roots, &prefix).is_ok() {
                    candidates.push((prefix, false));
                }
            }
        }
        let mut unique = BTreeMap::new();
        for (prefix, created) in candidates {
            unique
                .entry(prefix)
                .and_modify(|seen| *seen |= created)
                .or_insert(created);
        }
        let mut private_use_recorded = false;
        for (prefix, created) in unique {
            let result = (|| -> Result<_, String> {
                let prefix = canonical(&prefix)?;
                let (root, relative) = owned_any(&roots, &prefix)?;
                let kind = kind(&prefix)?
                    .ok_or("Created environment has no verifiable native metadata")?;
                Ok((root, relative, kind))
            })();
            let (root, relative, kind) = match result {
                Ok(value) => value,
                Err(_) if ctx.best_effort => continue,
                Err(error) => return Err(error),
            };
            let receipt = Receipt {
                schema: 1,
                generation: ctx.generation.clone(),
                tool: text(&program),
                prefix: relative,
                kind: kind.into(),
                created,
                root: Some(root),
            };
            write_receipt(&file, &receipt, &ctx.generation)?;
            private_use_recorded |= detected_prefix.as_ref().is_some_and(|detected| {
                crate::path_identity::same_path(detected, &prefix)
            });
        }
        // A used private prefix is already a candidate for drain-time native
        // verification. Do not also label it external merely because the
        // previous binding named another owned prefix/root. Multiple candidates
        // still unbind; creating a prefix through a host interpreter is not use.
        let switched_from_bound = ctx.best_effort
            && !private_use_recorded
            && launch_environment_differs(
                &ctx.launch,
                &workspace,
                state.as_deref(),
                name,
                detected_prefix.as_deref(),
            );
        if switched_from_bound {
            let receipt = Receipt {
                schema: 1,
                generation: ctx.generation.clone(),
                tool: text(&program),
                prefix: "external".into(),
                kind: "external".into(),
                created: false,
                root: None,
            };
            write_receipt(&file, &receipt, &ctx.generation)?;
        }
    }
    Ok(status.code().unwrap_or(1))
}

fn verify(
    root: &Path,
    root_label: &str,
    prefix: &str,
    expected_kind: &str,
    project_requirements: bool,
    root_paths: &[(&str, &Path)],
    runtime_schema: Option<u32>,
) -> Result<Binding, String> {
    if !matches!(runtime_schema, None | Some(1 | 2 | 3)) {
        return Err("Unsupported native runtime evidence schema".into());
    }
    let path = root.join(prefix);
    let canonical_prefix = canonical(&path)?;
    owned(root, &canonical_prefix)?;
    if kind(&canonical_prefix)? != Some(expected_kind) {
        return Err("Discovered environment metadata changed or is missing".into());
    }
    let python = interpreter(&canonical_prefix, expected_kind);
    if let Some(parent) = python.parent() {
        if parent != canonical_prefix {
            real_child_path(&canonical_prefix, parent, false)?
                .ok_or("Discovered native interpreter directory is missing")?;
        }
    }
    if !python.is_file() {
        return Err("Discovered native interpreter is missing".into());
    }
    let script = r#"import sys,sysconfig,platform,ssl,zlib,struct,json,pathlib
root=pathlib.Path(sys.argv[1]); prefix=pathlib.Path(sys.argv[2])
assert pathlib.Path(sys.prefix).resolve()==prefix.resolve(), 'Native prefix differs from the owned environment'
assert pathlib.Path(sys.executable).absolute().is_relative_to(prefix.resolve()), 'Native interpreter entry leaves its environment'
constraints=[]
f=root/'.python-version'
if sys.argv[3]=='true' and f.exists():
 value=f.read_text().strip(); constraints.append('=='+value+('.*' if value.count('.')==1 else ''))
f=root/'pyproject.toml'
if sys.argv[3]=='true' and f.exists():
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
record_files=False
record_selectors=False
selector_schema=2
files=set(); references={}
def observe_file(filename):
 path=pathlib.Path(filename); resolved=str(path.resolve())
 files.add(resolved)
 if record_selectors: references[str(path.absolute())]=resolved
for filename in [sys.executable,getattr(sys,'_base_executable',sys.executable),_ssl.__file__,_hashlib.__file__,getattr(zlib,'__file__',None)]:
 if filename: observe_file(filename)
if sys.platform=='win32':
 import ctypes
 kernel=ctypes.WinDLL('kernel32',use_last_error=True); kernel.GetModuleHandleW.argtypes=[ctypes.c_wchar_p]; kernel.GetModuleHandleW.restype=ctypes.c_void_p; kernel.GetModuleFileNameW.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p,ctypes.c_uint32]
 for name in ['python3.dll','python%d%d.dll'%sys.version_info[:2],'libssl-3-x64.dll','libssl-3.dll','libcrypto-3-x64.dll','libcrypto-3.dll','zlib1.dll','zlib.dll','libzlib.dll']:
  handle=kernel.GetModuleHandleW(name)
  if handle:
   buffer=ctypes.create_unicode_buffer(32768)
   if not kernel.GetModuleFileNameW(handle,buffer,len(buffer)): raise OSError('Cannot resolve loaded native library '+name)
   observe_file(buffer.value)
digests={}; native_blobs={}
for filename in sorted(files):
 digest=hashlib.sha256()
 if record_files:
  size=pathlib.Path(filename).stat().st_size; seen=0
  blob=hashlib.sha1(usedforsecurity=False)
  blob.update(('blob '+str(size)+'\0').encode('ascii'))
 with open(filename,'rb') as stream:
  for chunk in iter(lambda:stream.read(1024*1024),b''):
   digest.update(chunk)
   if record_files: blob.update(chunk); seen+=len(chunk)
 if record_files:
  if seen!=size: raise RuntimeError('Native runtime file changed while observing bytes: '+filename)
  native_blobs[filename]=blob.hexdigest()
 digests[filename]=digest.hexdigest()
if record_files:
 evidence={'schema':selector_schema,'files':native_blobs,'references':references} if record_selectors else native_blobs
 sys.stdout.write('\0GRAPHER_NATIVE_FILES\0'+json.dumps(evidence,sort_keys=True)+'\0')
print(json.dumps({'version':sys.version,'abi':sysconfig.get_config_var('SOABI'),'platform':sysconfig.get_platform(),'machine':platform.machine(),'bits':struct.calcsize('P')*8,'openssl':ssl.OPENSSL_VERSION,'zlib':zlib.ZLIB_RUNTIME_VERSION,'nativeFiles':digests},sort_keys=True))
"#;
    // Keep the probe's argv/environment unchanged: ordinary .pth startup code
    // can inspect sys.argv and its stdout is part of the recorded legacy ABI.
    // Only backend-owned probe code switches the extra evidence output on.
    let mut script = if runtime_schema.is_some() {
        script.replacen("record_files=False", "record_files=True", 1)
    } else { script.to_string() };
    if matches!(runtime_schema, Some(2 | 3)) {
        script = script.replacen("record_selectors=False", "record_selectors=True", 1);
    }
    if runtime_schema == Some(3) {
        script = script.replacen("selector_schema=2", "selector_schema=3", 1);
    }
    let mut command = Command::new(&python);
    command
        .args(["-I", "-B", "-c", &script])
        .arg(native::host_path(root))
        .arg(&canonical_prefix)
        .arg(if project_requirements {
            "true"
        } else {
            "false"
        })
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
    // Old L is checked by its original native ABI contract. Do not construct
    // new recovery evidence (and apply its new admission rules) just to discard
    // it afterwards. New discoveries always request full evidence below.
    let (runtime_evidence, abi_output) = if runtime_schema.is_some() {
        let (evidence, abi) = RuntimeEvidence::from_probe(&output, root_paths)?;
        (Some(evidence), abi)
    } else { (None, output) };
    let abi = git2::Oid::hash_object(git2::ObjectType::Blob, &abi_output)
        .map_err(|e| e.to_string())?
        .to_string();
    Ok(Binding {
        kind: expected_kind.into(),
        prefix: prefix.into(),
        abi,
        root: Some(root_label.into()),
        runtime_evidence,
    })
}

#[cfg(test)]
pub(crate) fn validate_launch(
    root: &Path,
    launch: &LaunchConfig,
    project_requirements: bool,
) -> Result<(), String> {
    validate_launch_with_state(root, None, launch, project_requirements)
}

pub(crate) fn validate_launch_with_state(
    workspace: &Path,
    state: Option<&Path>,
    launch: &LaunchConfig,
    project_requirements: bool,
) -> Result<(), String> {
    if let Some(expected) = &launch.environment {
        let roots = roots(workspace, state);
        let label = binding_root_label(launch, &roots).to_string();
        let root = root_for(&roots, &label)?;
        let mut actual = verify(
            root,
            &label,
            &expected.prefix,
            &expected.kind,
            project_requirements,
            &roots,
            expected.runtime_evidence.as_ref().map(RuntimeEvidence::schema),
        )?;
        if let Some(recorded) = &expected.runtime_evidence {
            if !actual.runtime_evidence.as_ref().is_some_and(|current| current.same_runtime_files(recorded)) {
                return Err("Bound native interpreter runtime file evidence changed; refusing unsafe startup".into());
            }
            // Selector paths constrain historical recovery, not an otherwise
            // identical real startup. Do not rewrite the stored L in either case.
            actual.runtime_evidence = Some(recorded.clone());
        }
        // Validate legacy records by their recorded contract, without rewriting
        // L/ABI or retrofitting newly observed files into historical evidence.
        if expected.root.is_none() { actual.root = None; }
        if actual != *expected {
            return Err(
                "Bound native interpreter ABI/library bytes changed; refusing unsafe startup"
                    .into(),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn resolve(
    root: &Path,
    launch: &LaunchConfig,
    session: &Path,
    generation: &str,
) -> Result<LaunchConfig, String> {
    resolve_for_policy(root, launch, session, generation, true, false)
}

#[cfg(test)]
pub(crate) fn resolve_for_policy(
    root: &Path,
    launch: &LaunchConfig,
    session: &Path,
    generation: &str,
    project_requirements: bool,
    best_effort: bool,
) -> Result<LaunchConfig, String> {
    resolve_for_policy_with_state(
        root,
        None,
        launch,
        session,
        generation,
        project_requirements,
        best_effort,
    )
}

pub(crate) fn resolve_for_policy_with_state(
    workspace: &Path,
    state: Option<&Path>,
    launch: &LaunchConfig,
    session: &Path,
    generation: &str,
    project_requirements: bool,
    best_effort: bool,
) -> Result<LaunchConfig, String> {
    let roots = roots(workspace, state);
    let directory = session.join("environment-observations").join(generation);
    let mut candidates = BTreeMap::<(String, String), String>::new();
    let mut external_selected = false;
    let mut discovered_scopes = Vec::new();
    let mut ambient_hints = launch.ambient_hints.clone();
    let ambient_directory = session.join("ambient-observations").join(generation);
    if let Ok(entries) = fs::read_dir(&ambient_directory) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            real_child_path(&session.join("ambient-observations"), &path, true)?
                .ok_or("Missing ambient environment hint")?;
            let value: AmbientReceipt =
                serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if value.schema != 1 || value.generation != generation {
                return Err("Stale ambient environment hint".into());
            }
            ambient_hints.push(value.hint);
        }
    }
    ambient_hints.sort_by(|a, b| {
        (&a.manager, &a.selector, &a.executable).cmp(&(&b.manager, &b.selector, &b.executable))
    });
    ambient_hints.dedup();
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
                if receipt.kind == "external" && receipt.prefix == "external" {
                    if best_effort {
                        external_selected = true;
                        continue;
                    }
                    return Err(
                        "External interpreter receipt is invalid under the frozen policy".into(),
                    );
                }
                environment::safe_relative(&receipt.prefix)?;
                let label = receipt.root.as_deref().unwrap_or(if launch.state_bound() {
                    "state"
                } else {
                    "workspace"
                });
                if !matches!(label, "workspace" | "state") {
                    return Err("Invalid native environment receipt root".into());
                }
                if root_for(&roots, label).is_err() {
                    return Err("Native environment receipt root is unavailable".into());
                }
                let previous =
                    candidates.insert((label.into(), receipt.prefix), receipt.kind.clone());
                if previous.is_some_and(|previous| previous != receipt.kind) {
                    return Err("Conflicting native environment observations".into());
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    // Metadata inventory is a bounded refusal guard, never an adoption
    // heuristic. Do not traverse environment contents or follow directory links.
    for (label, root) in &roots {
        let mut inventory = vec![root.to_path_buf()];
        let mut visited = 0;
        while let Some(directory) = inventory.pop() {
            visited += 1;
            if visited > 50_000 {
                if best_effort {
                    break;
                }
                return Err(
                    "Native environment metadata inventory exceeded its safe directory bound"
                        .into(),
                );
            }
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(_) if best_effort => continue,
                Err(error) => return Err(error.to_string()),
            };
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) if best_effort => continue,
                    Err(error) => return Err(error.to_string()),
                };
                if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                    continue;
                }
                let prefix = entry.path();
                let relative = prefix
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                if [
                    ".git",
                    ".runtime-cache",
                    ".agent-home",
                    ".pi",
                    ".project-git",
                    ".git-config",
                ]
                .iter()
                .any(|scope| workspace::scope_contains(Path::new(&relative), Path::new(scope)))
                {
                    continue;
                }
                if let Ok(Some(_environment_kind)) = kind(&prefix) {
                    match owned(root, &prefix) {
                        Ok(relative) => {
                            discovered_scopes.push(EnvironmentScope {
                                root: (*label).into(),
                                path: relative.clone(),
                            });
                            let observed = candidates
                                .contains_key(&((*label).into(), relative.clone()))
                                || launch.environment.as_ref().is_some_and(|binding| {
                                    binding.prefix == relative
                                        && binding_root_label(launch, &roots) == *label
                                });
                            if !observed && !best_effort {
                                return Err(format!("Unobserved native environment at {relative}; refusing directory-name inference or a silent bootstrap binding"));
                            }
                        }
                        Err(_) if best_effort => {}
                        Err(error) => return Err(error),
                    }
                } else {
                    inventory.push(prefix);
                }
            }
        }
    }
    let mut next = launch.clone();
    // Version new ownership evidence in L, not the frozen policy. Legacy
    // single-root records stay readable; a dual-root discovery must never
    // collapse equal relative names from W and S into one scope.
    if state.is_some() && next.owned_scopes.is_none() {
        let root = binding_root_label(launch, &roots);
        next.owned_scopes = Some(next.managed_scopes.drain(..)
            .map(|path| EnvironmentScope { root: root.into(), path }).collect());
    }
    if best_effort {
        if let Some(scopes) = &mut next.owned_scopes {
            scopes.extend(discovered_scopes);
        } else {
            next.managed_scopes.extend(discovered_scopes.into_iter().map(|scope| scope.path));
        }
        next.ambient_hints = ambient_hints;
    }
    if let Some(scopes) = &mut next.owned_scopes {
        // Also retain a previously bound scope if its metadata was removed or
        // damaged during this turn; unbinding is not permission to publish it.
        if let Some(binding) = &launch.environment {
            scopes.push(EnvironmentScope {
                root: binding_root_label(launch, &roots).into(),
                path: binding.prefix.clone(),
            });
        }
        scopes.sort();
        scopes.dedup();
    } else {
        next.managed_scopes.sort();
        next.managed_scopes.dedup();
    }
    if best_effort && external_selected {
        return unbound_launch(&next);
    }
    if candidates.len() > 1 {
        if best_effort {
            return unbound_launch(&next);
        }
        return Err("Ambiguous independent native environments in this execution; no automatic authority or user selection".into());
    }
    if let Some(((root_label, prefix), kind)) = candidates.into_iter().next() {
        let root = root_for(&roots, &root_label)?;
        let binding = match verify(root, &root_label, &prefix, &kind, project_requirements, &roots, Some(3)) {
            Ok(binding) => binding,
            Err(_) if best_effort => return unbound_launch(&next),
            Err(error) => return Err(error),
        };
        let token = if root_label == "state" {
            "{state}"
        } else {
            "{workspace}"
        };
        let entry = interpreter(Path::new(&format!("{token}/{prefix}")), &kind);
        let bin = text(
            entry
                .parent()
                .ok_or("Missing environment entry directory")?,
        );
        next.entry = text(&entry);
        next.restore_unbound_path();
        next.path.insert(0, bin);
        next.variables.remove("VIRTUAL_ENV");
        next.variables.remove("CONDA_PREFIX");
        next.variables.remove("CONDA_DEFAULT_ENV");
        if kind == "conda" {
            let conda = fs::read(session.join(format!("environment-observer-{generation}.json")))
                .map_err(|e| e.to_string())?;
            let ctx: Context = serde_json::from_slice(&conda).map_err(|e| e.to_string())?;
            let tool = match find_conda(&ctx.launch.path, workspace) {
                Ok(tool) => tool,
                Err(_) if best_effort => return unbound_launch(&next),
                Err(error) => return Err(error),
            };
            let quoted = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
            next.hook = Some(format!(
                "eval \"$({} shell.bash hook)\" && conda activate {}",
                quoted(&tool),
                quoted(&format!("{token}/{prefix}"))
            ));
            if cfg!(windows) {
                next.path.insert(1, format!("{token}/{prefix}/Scripts"));
                next.path.insert(2, format!("{token}/{prefix}/Library/bin"));
            }
            next.variables
                .insert("CONDA_PREFIX".into(), format!("{token}/{prefix}"));
        } else {
            next.hook = None;
            next.variables
                .insert("VIRTUAL_ENV".into(), format!("{token}/{prefix}"));
        }
        next.environment = Some(binding);
        if let Some(scopes) = &mut next.owned_scopes {
            scopes.push(EnvironmentScope { root: root_label, path: prefix });
            scopes.sort();
            scopes.dedup();
        } else {
            next.managed_scopes.push(prefix);
            next.managed_scopes.sort();
            next.managed_scopes.dedup();
        }
    } else if let Some(binding) = &launch.environment {
        let root_label = binding_root_label(launch, &roots).to_string();
        let root = root_for(&roots, &root_label)?;
        match verify(
            root,
            &root_label,
            &binding.prefix,
            &binding.kind,
            project_requirements,
            &roots,
            Some(3),
        ) {
            Ok(verified) => next.environment = Some(verified),
            Err(_) if best_effort => return unbound_launch(&next),
            Err(error) => return Err(error),
        }
    }
    next.validate()?;
    Ok(next)
}

fn find_conda(paths: &[String], workspace: &Path) -> Result<String, String> {
    for directory in paths {
        // Native relative/empty PATH entries belong to the business cwd, never
        // the backend installation's cwd. Absolute entries remain unchanged.
        let path = workspace.join(directory).join(if cfg!(windows) { "conda.exe" } else { "conda" });
        if path.is_file() {
            return Ok(text(&canonical(&path)?));
        }
    }
    Err("Native Conda activation tool is unavailable; no interpreter fallback".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf, LaunchConfig, String) {
        setup_with_context()
    }
    fn setup_with_context() -> (tempfile::TempDir, PathBuf, PathBuf, LaunchConfig, String) {
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
        context(&root, &generation, &launch, &session, false).unwrap();
        (temp, root, session, launch, generation)
    }

    #[test]
    fn observer_source_binding_is_immutable_and_legacy_contexts_are_not_rewritten() {
        let (temp, root, session, launch, generation) = setup();
        let source = temp.path().join("source");
        fs::create_dir_all(&source).unwrap();
        let file = session.join(format!("environment-observer-{generation}.json"));
        let legacy = fs::read(&file).unwrap();
        context_with_source(&root, None, Some(&source), &generation, &launch, &session, false).unwrap();
        assert_eq!(fs::read(&file).unwrap(), legacy);
        let mut changed = launch.clone();
        changed.variables.insert("BUSINESS".into(), "changed".into());
        assert!(context_with_source(&root, None, Some(&source), &generation, &changed, &session, false).is_err());
        let generation = Uuid::new_v4().to_string();
        let file = context_with_source(&root, None, Some(&source), &generation, &launch, &session, true).unwrap();
        let current = fs::read(&file).unwrap();
        let context: Context = serde_json::from_slice(&current).unwrap();
        assert_eq!(context.source.as_deref(), Some(text(&canonical(&source).unwrap()).as_str()));
        assert!(context_with_source(&root, None, Some(&root), &generation, &launch, &session, true).is_err());
        assert_eq!(fs::read(&file).unwrap(), current);
    }

    #[test]
    fn copied_venv_activation_cannot_run_or_modify_the_source_environment_through_observed_tools() {
        let (temp, root, _session, launch, generation) = setup();
        let source = temp.path().join("source project");
        fs::create_dir_all(&source).unwrap();
        let source_env = source.join("custom-python");
        let private_env = root.join("custom-python");
        let python = python(&launch);
        let mut create = Command::new(&python);
        create.args(["-m", "venv", "--without-pip"]).arg(&source_env);
        environment::controlled_output(create).unwrap();
        fs::create_dir_all(&private_env).unwrap();
        crate::native_copy::copy_tree(&source_env, &private_env, |_| false).unwrap();
        let activation = if cfg!(windows) { "Scripts/activate" } else { "bin/activate" };
        let original = fs::read(source_env.join(activation)).unwrap();
        let quote = |value: &str| format!("'{}'", value.replace('\\', "/").replace('\'', "'\\''"));
        let script = "import json,sys; print(json.dumps({'executable':sys.executable,'prefix':sys.prefix}))";
        let mut bash = Command::new(&launch.shell);
        bash.args(["--noprofile", "--norc", "-c", &format!("source {} && python -c {}", quote(&text(&private_env.join(activation))), quote(script))])
            .current_dir(&root).env_remove("BASH_ENV").env_remove("ENV").env("PYTHONDONTWRITEBYTECODE", "1");
        let output: serde_json::Value = serde_json::from_slice(&environment::controlled_output(bash).unwrap()).unwrap();
        assert!(crate::path_identity::same_path(Path::new(output["prefix"].as_str().unwrap()), &source_env), "a standard copied activation still selects its original prefix");
        let session = temp.path().join("guarded-session");
        let observer = context_with_source(&root, None, Some(&source), &generation, &launch, &session, true).unwrap();
        let marker = source_env.join("must-not-be-written");
        let source_alias = temp.path().join("source-alias");
        crate::path_safety::directory_link(&source, &source_alias);
        for executable in [PathBuf::from(output["executable"].as_str().unwrap()), interpreter(&source_alias.join("custom-python"), "venv")] {
            let error = tool(vec![text(&observer), "python".into(), text(&executable), "-c".into(),
                "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('source modified')".into(), text(&marker)]).unwrap_err();
            assert!(error.contains("Source-bound environment tool") && error.contains("Recreate/install"), "{error}");
            assert!(!marker.exists());
        }
        assert_eq!(fs::read(source_env.join(activation)).unwrap(), original);
        assert_eq!(fs::read(private_env.join(activation)).unwrap(), original);
        // Direct local interpreter use remains valid; do not turn a copied
        // activation diagnostic into a blanket ban on private/ambient Python.
        assert_eq!(tool(vec![text(&observer), "python".into(), text(&interpreter(&private_env, "venv")), "-I".into(), "-c".into(),
            "import pathlib,sys; assert pathlib.Path(sys.prefix).resolve()==pathlib.Path(sys.argv[1]).resolve()".into(), text(&private_env)]).unwrap(), 0);
        assert_eq!(tool(vec![text(&observer), "python".into(), python, "-c".into(), "pass".into()]).unwrap(), 0);
        // Deleting a local environment after activation must not silently
        // authorize the stale source prefix again.
        fs::remove_dir_all(&private_env).unwrap();
        let error = tool(vec![text(&observer), "python".into(), text(&interpreter(&source_env, "venv")), "-c".into(),
            "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('source modified')".into(), text(&marker)]).unwrap_err();
        assert!(error.contains("Source-bound environment tool"), "{error}");
        assert!(!marker.exists());
        assert_eq!(fs::read(source_env.join(activation)).unwrap(), original);
        reject_source_environment_tool(&source, Some(&text(&source)), &interpreter(&source_env, "venv")).unwrap();
    }

    #[test]
    fn ownership_accepts_native_path_forms_and_trusted_workspace_root_aliases() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace 中文 space");
        fs::create_dir_all(root.join("tools/existing-env")).unwrap();
        let alias = temp.path().join("workspace-alias");
        crate::path_safety::directory_link(&root, &alias);
        let roots = [
            root.clone(),
            root.canonicalize().unwrap(),
            canonical(&root).unwrap(),
            alias,
        ];
        for root in &roots {
            for prefix_root in &roots {
                for name in ["tools/existing-env", "new/nested/env"] {
                    assert_eq!(owned(root, &prefix_root.join(name)).unwrap(), name);
                }
                assert!(
                    owned(root, prefix_root).is_err(),
                    "the workspace itself is not an environment"
                );
            }
            let args =
                private_conda_args(&["create".into(), "--name=business".into()], root).unwrap();
            assert_eq!(
                args,
                vec![
                    "create".to_string(),
                    "--prefix".into(),
                    text(&root.join(".environments/business"))
                ]
            );
        }
    }

    #[test]
    fn ownership_normalization_does_not_hide_traversal_child_links_or_excluded_scopes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("workspace-sibling");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("marker"), "retained").unwrap();
        fs::write(root.join("not-a-directory"), "retained").unwrap();
        let alias = temp.path().join("workspace-alias");
        crate::path_safety::directory_link(&root, &alias);
        crate::path_safety::directory_link(&outside, &root.join("redirected"));
        crate::path_safety::directory_link(&root, &root.join("redirected-root"));
        for prefix_root in [&root, &alias] {
            for name in [
                "missing/../env",
                "redirected/env",
                "redirected-root/env",
                ".runtime-cache/env",
                ".agent-home/env",
                ".pi/env",
                "not-a-directory",
            ] {
                assert!(
                    owned(&canonical(&root).unwrap(), &prefix_root.join(name)).is_err(),
                    "{name}"
                );
            }
        }
        assert!(owned(&root, &outside.join("env"))
            .unwrap_err()
            .contains("workspace"));
        assert_eq!(
            fs::read_to_string(outside.join("marker")).unwrap(),
            "retained"
        );
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
    fn best_effort_allows_ambient_tool_exploration_and_package_commands() {
        let (temp, root, _session, launch, generation) = setup();
        let session = temp.path().join("best-effort-session");
        let observer = context(&root, &generation, &launch, &session, true).unwrap();
        let python = python(&launch);
        assert_eq!(
            tool(vec![
                text(&observer),
                "python".into(),
                python.clone(),
                "--version".into(),
            ])
            .unwrap(),
            0
        );
        // Temporary per-command configuration is business state, not a change
        // to L. Observation must not reset it to the original launch values.
        assert_eq!(tool(vec![
            text(&observer), "python".into(), python.clone(), "-c".into(),
            "import json,os,sys; assert os.environ.get('HOME') == json.loads(sys.argv[1])".into(),
            serde_json::to_string(&std::env::var("HOME").ok()).unwrap(),
        ]).unwrap(), 0);
        // The adapter must not reject an ambient interpreter merely because the
        // pip target is outside the managed workspace. pip itself may reject the
        // disposable dry-run request; that is business command status, not Runtime policy.
        assert!(tool(vec![
            text(&observer),
            "python".into(),
            python,
            "-m".into(),
            "pip".into(),
            "install".into(),
            "--dry-run".into(),
            "--no-index".into(),
            "--target".into(),
            temp.path().join("ambient-target").to_string_lossy().into(),
            "not-a-real-package".into(),
        ])
        .is_ok());
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
    fn relative_conda_lookup_uses_the_business_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(workspace.join("tools")).unwrap();
        let name = if cfg!(windows) { "conda.exe" } else { "conda" };
        let tool = workspace.join("tools").join(name);
        fs::write(&tool, "not executed").unwrap();
        assert_eq!(find_conda(&["tools".into()], &workspace).unwrap(), text(&canonical(&tool).unwrap()));
        assert!(find_conda(&["missing".into()], &workspace).is_err());
        fs::write(workspace.join(name), "not executed").unwrap();
        assert_eq!(find_conda(&[String::new()], &workspace).unwrap(), text(&canonical(&workspace.join(name)).unwrap()));
    }

    #[test]
    fn verified_private_switches_follow_the_used_root_without_external_fallback() {
        let (temp, workspace, _, mut launch, _) = setup();
        let bootstrap = python(&launch);
        let state = temp.path().join("state");
        fs::create_dir(&state).unwrap();
        for (label, root) in [("workspace", &workspace), ("state", &state)] {
            let prefix = root.join("same-env");
            let mut command = Command::new(&bootstrap);
            command.args(["-m", "venv", "--without-pip"]).arg(&prefix);
            environment::controlled_output(command).unwrap();
            fs::write(prefix.join("local-patch"), label).unwrap();
        }
        for label in ["workspace", "state", "workspace"] {
            let root = if label == "workspace" { &workspace } else { &state };
            let prefix = root.join("same-env");
            let generation = Uuid::new_v4().to_string();
            let session = temp.path().join(&generation);
            let observer = context_with_state(&workspace, Some(&state), &generation,
                &launch.expanded(&workspace), &session, true).unwrap();
            assert_eq!(tool(vec![text(&observer), "python".into(), text(&interpreter(&prefix, "venv")),
                "-I".into(), "-c".into(), "import pathlib,sys; p=pathlib.Path(sys.prefix); assert p.resolve()==pathlib.Path(sys.argv[1]).resolve(); assert (p/'local-patch').read_text()==sys.argv[2]".into(),
                text(&prefix), label.into()]).unwrap(), 0);
            launch = resolve_for_policy_with_state(&workspace, Some(&state), &launch,
                &session, &generation, false, true).unwrap();
            let binding = launch.environment.as_ref().expect("unique verified private use must not be classified as an external switch");
            assert_eq!(binding.root.as_deref(), Some(label));
            assert_eq!(binding.prefix, "same-env");
            validate_launch_with_state(&workspace, Some(&state), &launch, false).unwrap();
            assert!(launch.ambient_hints.is_empty(), "a private interpreter symlink must not create a host-interpreter hint");
            assert_eq!(launch.owned_scopes.as_ref().unwrap().len(), 2);
            for (name, root) in [("workspace", &workspace), ("state", &state)] {
                assert_eq!(fs::read_to_string(root.join("same-env/local-patch")).unwrap(), name,
                    "switching does not copy or reset either private environment");
            }
        }
        // A receipt alone is not proof: losing native metadata before drain
        // must still unbind rather than adopt the switched prefix.
        let generation = Uuid::new_v4().to_string();
        let session = temp.path().join(&generation);
        let observer = context_with_state(&workspace, Some(&state), &generation,
            &launch.expanded(&workspace), &session, true).unwrap();
        assert_eq!(tool(vec![text(&observer), "python".into(), text(&interpreter(&state.join("same-env"), "venv")),
            "-I".into(), "-c".into(), "pass".into()]).unwrap(), 0);
        let metadata = state.join("same-env/pyvenv.cfg");
        let original = fs::read(&metadata).unwrap();
        fs::remove_file(&metadata).unwrap();
        let unverified = resolve_for_policy_with_state(&workspace, Some(&state), &launch,
            &session, &generation, false, true).unwrap();
        assert!(unverified.environment.is_none());
        assert_eq!(unverified.owned_scopes, launch.owned_scopes);
        fs::write(&metadata, original).unwrap();

        for external in [false, true] {
            let generation = Uuid::new_v4().to_string();
            let session = temp.path().join(&generation);
            let observer = context_with_state(&workspace, Some(&state), &generation,
                &launch.expanded(&workspace), &session, true).unwrap();
            let programs = if external { vec![PathBuf::from(&bootstrap)] } else {
                vec![interpreter(&workspace.join("same-env"), "venv"), interpreter(&state.join("same-env"), "venv")]
            };
            for program in programs {
                assert_eq!(tool(vec![text(&observer), "python".into(), text(&program),
                    "-I".into(), "-c".into(), "pass".into()]).unwrap(), 0);
            }
            let next = resolve_for_policy_with_state(&workspace, Some(&state), &launch,
                &session, &generation, false, true).unwrap();
            assert!(next.environment.is_none(), "external or ambiguous use must remain unbound");
            assert_eq!(next.owned_scopes, launch.owned_scopes);
        }
    }

    #[test]
    fn environment_switching_and_unbinding_preserve_project_and_relative_business_paths() {
        let (temp, root, _session, mut launch, _) = setup();
        let python = python(&launch);
        let mut business = vec!["{workspace}/tools".into(), "relative-bin".into(), String::new()];
        business.extend(launch.path.clone());
        launch.path = business.clone();
        launch.unbound_path = Some(business.clone());
        for name in ["first-env", "second-env"] {
            let session = temp.path().join(format!("session-{name}"));
            let generation = Uuid::new_v4().to_string();
            let observer = context(&root, &generation, &launch.expanded(&root), &session, true).unwrap();
            assert_eq!(tool(vec![text(&observer), "python".into(), python.clone(),
                "-m".into(), "venv".into(), "--without-pip".into(), text(&root.join(name))]).unwrap(), 0);
            let switching = launch.environment.is_some();
            launch = resolve_for_policy(&root, &launch, &session, &generation, false, true).unwrap();
            if switching {
                // Using another interpreter during a bound turn retains the
                // existing best-effort unbound decision, not automatic authority.
                assert!(launch.environment.is_none());
                assert_eq!(launch.path, business);
                let session = temp.path().join(format!("activate-{name}"));
                let generation = Uuid::new_v4().to_string();
                let observer = context(&root, &generation, &launch.expanded(&root), &session, true).unwrap();
                assert_eq!(tool(vec![text(&observer), "python".into(), text(&interpreter(&root.join(name), "venv")),
                    "-c".into(), "pass".into()]).unwrap(), 0);
                launch = resolve_for_policy(&root, &launch, &session, &generation, false, true).unwrap();
            }
            assert_eq!(launch.environment.as_ref().unwrap().prefix, name);
            assert!(launch.path[0].contains(name));
            assert_eq!(&launch.path[1..], business.as_slice(), "activation must not drop project tools or accumulate old prefixes");
        }
        let unbound = unbound_launch(&launch).unwrap();
        assert!(unbound.environment.is_none());
        assert_eq!(unbound.path, business);
        assert_eq!(unbound.unbound_path, launch.unbound_path);
    }

    #[test]
    fn business_created_custom_venv_binds_from_receipt_and_actual_native_prefix() {
        let (temp, root, session, launch, generation) = setup();
        let alias = temp.path().join("workspace-alias");
        crate::path_safety::directory_link(&root, &alias);
        create(&alias, &session, &launch, "business-env");
        let next = resolve(&root, &launch, &session, &generation).unwrap();
        assert_eq!(next.environment.as_ref().unwrap().prefix, "business-env");
        assert_eq!(next.environment.as_ref().unwrap().kind, "venv");
        assert!(next.entry.contains("business-env"));
        assert!(next.variables.contains_key("VIRTUAL_ENV"));
        assert_ne!(next, launch);
        validate_launch(&root, &next, true).unwrap();
        let mut damaged = next.clone();
        damaged.environment.as_mut().unwrap().abi = "changed".into();
        assert!(validate_launch(&root, &damaged, true)
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
        let unbound = resolve_for_policy(&root, &launch, &session, &generation, false, true).unwrap();
        assert!(unbound.environment.is_none());
        assert_eq!(unbound.owned_scopes.unwrap(), vec![
            EnvironmentScope { root: "workspace".into(), path: "first".into() },
            EnvironmentScope { root: "workspace".into(), path: "second".into() },
        ], "ambiguity must not release either observed environment into project Git");
    }
    #[test]
    fn python_application_arguments_do_not_create_environment_authority() {
        let (temp, root, _, launch, _) = setup();
        let bootstrap = python(&launch);
        let inactive = root.join("inactive");
        let mut create = Command::new(&bootstrap);
        create.args(["-m", "venv", "--without-pip"]).arg(&inactive);
        environment::controlled_output(create).unwrap();
        let script = root.join("business.py");
        fs::write(&script, "import sys; assert sys.argv[1:3] == ['-m', 'venv']\n").unwrap();
        for mut args in [
            vec!["-c".into(), "import sys; assert sys.argv[1:3] == ['-m', 'venv']".into()],
            vec![text(&script)],
            vec!["--".into(), text(&script)],
        ] {
            args.extend(["-m".into(), "venv".into(), text(&inactive)]);
            let generation = Uuid::new_v4().to_string();
            let session = temp.path().join(&generation);
            let observer = context(&root, &generation, &launch, &session, true).unwrap();
            let mut invocation = vec![text(&observer), "python".into(), bootstrap.clone()];
            invocation.extend(args);
            assert_eq!(tool(invocation).unwrap(), 0);
            let next = resolve_for_policy(&root, &launch, &session, &generation, false, true).unwrap();
            assert!(next.environment.is_none(), "application argv must not manufacture a venv creation receipt");
            assert!(next.owned_scopes.as_ref().unwrap().iter().any(|scope| scope.root == "workspace" && scope.path == "inactive"));
        }
        // Real module invocation still records creation, including valued
        // interpreter options and compact/grouped short-option spelling.
        let generation = Uuid::new_v4().to_string();
        let session = temp.path().join(&generation);
        let observer = context(&root, &generation, &launch, &session, true).unwrap();
        let created = root.join("created-with-options");
        assert_eq!(tool(vec![text(&observer), "python".into(), bootstrap.clone(),
            "-W".into(), "ignore".into(), "-X".into(), "utf8".into(),
            "--check-hash-based-pycs".into(), "default".into(), "-IBmvenv".into(),
            "--without-pip".into(), text(&created)]).unwrap(), 0);
        let next = resolve_for_policy(&root, &launch, &session, &generation, false, true).unwrap();
        assert_eq!(next.environment.unwrap().prefix, "created-with-options");

        let generation = Uuid::new_v4().to_string();
        let session = temp.path().join(&generation);
        let observer = context(&root, &generation, &launch, &session, false).unwrap();
        assert_eq!(tool(vec![text(&observer), "python".into(), bootstrap.clone(), "-c".into(),
            "pass".into(), "-m".into(), "pip".into(), "install".into(), "business-argument".into()]).unwrap(), 0,
            "application arguments must not trigger legacy pip policy checks");
        let error = tool(vec![text(&observer), "python".into(), bootstrap, "-mpip".into(),
            "install".into(), "--dry-run".into(), "--no-index".into(), "not-a-real-package".into()]).unwrap_err();
        assert!(error.contains("host interpreter"), "compact module spelling must retain the legacy host-write guard: {error}");
    }

    #[test]
    fn python_module_options_do_not_scan_option_values_or_application_argv() {
        let args = |values: &[&str]| values.iter().map(|value| (*value).to_string()).collect::<Vec<_>>();
        for values in [
            vec!["-W", "-m", "venv", "target"],
            vec!["-X", "-m", "venv", "target"],
            vec!["-Icpass", "-m", "venv", "target"],
            vec!["-", "-m", "venv", "target"],
            vec!["--help", "-m", "venv", "target"],
            vec!["--unknown-option", "-m", "venv", "target"],
        ] {
            assert!(python_module(&args(&values)).is_none(), "{values:?}");
        }
        let application = args(&["-m", "business_module", "-m", "venv", "target"]);
        assert_eq!(python_module(&application), Some(("business_module", &application[2..])));
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let help = vec!["-mvenv".into(), text(&temp.path().join("outside")), "--help".into()];
        assert!(create_prefixes("python", &help, &root, None).unwrap().is_empty(),
            "help does not create an environment or request a write destination");
    }

    #[test]
    fn conda_run_application_options_are_not_manager_selectors() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path();
        let args = |values: &[&str]| values.iter().map(|value| (*value).to_string()).collect::<Vec<_>>();
        for invocation in [
            args(&["run", "python", "business.py", "--prefix", "wrong", "--name", "wrong"]),
            args(&["run", "--cwd", "child-cwd", "python", "--prefix=wrong", "--name=wrong"]),
            args(&["--debug", "run", "--no-capture-output", "python", "--name", "wrong"]),
            args(&["create", "--prefix", "existing", "--help"]),
        ] {
            assert!(conda_private_prefix(&invocation, cwd).is_none(), "child argv is not a prefix selector: {invocation:?}");
            assert!(conda_environment_name(&invocation).is_none(), "child argv is not a name selector: {invocation:?}");
        }
        let selected = args(&["run", "--cwd", "child-cwd", "--prefix", "selected", "python", "--prefix", "wrong"]);
        assert_eq!(conda_private_prefix(&selected, cwd), Some(cwd.join("selected")));
        let named = args(&["run", "--name", "selected", "python", "--prefix", "wrong", "--name", "wrong"]);
        assert_eq!(conda_environment_name(&named), Some("selected"));
        assert!(conda_private_prefix(&named, cwd).is_none());
    }

    #[test]
    fn conda_prefix_arguments_use_command_cwd_without_reinterpreting_environment_names() {
        let (temp, workspace, _, launch, _) = setup();
        let state = temp.path().join("state");
        let cwd = workspace.join("subproject");
        fs::create_dir(&state).unwrap();
        fs::create_dir(&cwd).unwrap();
        let arguments = |values: &[&str]| values.iter().map(|value| (*value).to_string()).collect::<Vec<_>>();
        for args in [
            arguments(&["create", "--prefix", "env"]),
            arguments(&["install", "-p", "./env", "package"]),
            arguments(&["run", "--prefix=env", "--", "python"]),
            arguments(&["shell.bash", "activate", "./env"]),
        ] {
            let prefix = conda_private_prefix(&args, &cwd).expect("explicit prefix is a path even without a slash");
            assert!(crate::path_identity::same_path(&prefix, &cwd.join("env")), "{prefix:?}");
            let value = hint("conda", Path::new(&python(&launch)), &args,
                &workspace, Some(&state), &cwd, &launch).unwrap();
            assert!(crate::path_identity::same_path(Path::new(&value.selector), &cwd.join("env")), "{}", value.selector);
        }
        for args in [arguments(&["create", "--name", "env"]), arguments(&["shell.bash", "activate", "env"])] {
            assert!(conda_private_prefix(&args, &cwd).is_none(), "a Conda name is not a cwd-relative prefix");
        }
        let absolute = state.join("private-env");
        assert_eq!(conda_private_prefix(&["list".into(), "--prefix".into(), text(&absolute)], &cwd), Some(absolute));
        assert!(conda_private_prefix(&arguments(&["run", "--", "python", "--prefix", "not-conda"]), &cwd).is_none());
        assert!(conda_environment_name(&arguments(&["run", "--", "python", "--name", "not-conda"])).is_none());
    }

    #[test]
    fn conda_prefix_receipt_uses_actual_cwd_not_a_same_named_state_scope() {
        const CHILD: &str = "GRAPHER_TEST_CONDA_PREFIX_OBSERVATION";
        if let Ok(args) = std::env::var(CHILD) {
            assert_eq!(tool(serde_json::from_str(&args).unwrap()).unwrap(), 0);
            return;
        }
        let (temp, workspace, session, launch, _) = setup();
        let state = temp.path().join("state");
        let cwd = workspace.join("subproject");
        fs::create_dir(&state).unwrap();
        fs::create_dir(&cwd).unwrap();
        let bootstrap = python(&launch);
        for (root, marker) in [(&cwd, "business cwd"), (&state, "not the selected prefix")] {
            let prefix = root.join("env");
            let mut create = Command::new(&bootstrap);
            create.args(["-m", "venv", "--without-pip"]).arg(&prefix);
            environment::controlled_output(create).unwrap();
            fs::write(prefix.join("marker"), marker).unwrap();
        }
        let generation = Uuid::new_v4().to_string();
        let context = context_with_state(&workspace, Some(&state), &generation, &launch, &session, true).unwrap();
        // A native Python command stands in for the package-manager invocation;
        // this exercises argv/cwd/receipt plumbing, NOT native Conda acceptance.
        // Both candidate prefixes are real, independently created Python venvs.
        let args = vec![text(&context), "conda".into(), bootstrap, "-c".into(),
            "import pathlib,sys; assert sys.argv[1]=='--prefix'; p=pathlib.Path(sys.argv[2]); assert (p/'marker').read_text()=='business cwd'".into(),
            "--prefix".into(), "./env".into()];
        let mut child = Command::new(std::env::current_exe().unwrap());
        child.current_dir(&cwd).env(CHILD, serde_json::to_string(&args).unwrap())
            .args(["--exact", "environment_discovery::tests::conda_prefix_receipt_uses_actual_cwd_not_a_same_named_state_scope", "--nocapture"]);
        environment::controlled_output(child).unwrap();
        let selected = resolve_for_policy_with_state(&workspace, Some(&state), &launch,
            &session, &generation, false, true).unwrap();
        let binding = selected.environment.unwrap();
        assert_eq!(binding.root.as_deref(), Some("workspace"));
        assert_eq!(binding.prefix, "subproject/env");
        assert_eq!(fs::read_to_string(state.join("env/marker")).unwrap(), "not the selected prefix");
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
