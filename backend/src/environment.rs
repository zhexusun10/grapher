//! Native workspace environment control with backend-owned new-Run admission. Workspace allocation and writer
//! ownership remain Runtime's authority; this module never allocates a slot.
use crate::{native, path_safety::real_child_path, workspace, workspace_files::Files};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};
use uuid::Uuid;

#[path = "environment_forks.rs"]
mod forks;
#[path = "environment_snapshots.rs"]
mod snapshots;

/// Ownership evidence is independent of which environment is currently active.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentScope {
    pub root: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchConfig {
    /// An explicit native executable, bound to the project or external state root.
    pub entry: String,
    /// Complete business PATH, not additions to an inherited host PATH.
    pub path: Vec<String>,
    /// Business PATH before activation. Automatic policies persist it;
    /// explicit launches may omit activation/unbinding support.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unbound_path: Option<Vec<String>>,
    pub shell: String,
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
    /// Names only. Values (including credentials) are injected, never persisted.
    #[serde(default)]
    pub inherit: Vec<String>,
    /// Source-like business variables remain transient, never serialized into L.
    /// Older explicit policies retain their allowlisted inheritance contract.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub inherit_ambient: bool,
    /// Trusted Bash initialization, e.g. a declared Conda activation hook.
    #[serde(default)]
    pub hook: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub managed_scopes: Vec<String>,
    /// Root-qualified ownership. Persisted L records always carry this field;
    /// Some(empty) represents a current unbound launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owned_scopes: Option<Vec<EnvironmentScope>>,
    /// Non-owning hints from previous business processes. Runtime never copies,
    /// activates or cleans these environments.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ambient_hints: Vec<crate::environment_discovery::AmbientEnvironmentHint>,
    /// Runtime-verified lazy binding. Absent in all pre-discovery records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<crate::environment_discovery::Binding>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentConfig {
    pub mode: String,
    pub platform: String,
    pub arch: String,
    pub scopes: Vec<String>,
    #[serde(default)]
    pub caches: Vec<String>,
    /// "fixed" (default guarantee) or explicitly asserted "relocatable".
    pub layout: String,
    pub launch: LaunchConfig,
    /// Explicit native baseline identity probe. First element must be absolute.
    pub baseline: Vec<String>,
    /// Executed once in each independently initialized root view, without Agent.
    #[serde(default)]
    pub initialize: Vec<String>,
    /// Import source scopes only with an explicitly relocatable layout.
    #[serde(default)]
    pub import_source: bool,
    /// Only this predeclared file may update L; arbitrary activation is ignored.
    #[serde(default)]
    pub launch_file: Option<String>,
    /// Consumer -> authoritative ordinary parent. No directory/environment merge.
    #[serde(default)]
    pub authority: BTreeMap<String, String>,
    #[serde(default)]
    pub allow_descendant: bool,
    /// Strong requirements fail closed when not implemented/verified.
    #[serde(default)]
    pub require: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resources: Option<crate::environment_resources::Resources>,
    /// The current workspace starts unbound; ordinary business tools may create
    /// or switch environments and Runtime records only verifiable private ones.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub discovery: bool,
    /// Runtime may inherit a safe local environment without requiring parents to
    /// agree. This is an internal admission mode, not a user configuration.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub best_effort: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Domain {
    pub platform: String,
    pub arch: String,
    pub baseline: String,
    pub policy: String,
    pub contract: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InheritanceInput {
    pub node: String,
    pub environment_ref: String,
    pub launch_ref: String,
    pub layout: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InheritanceDecision {
    pub reason: String,
    pub inputs: Vec<InheritanceInput>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompositeResult {
    pub domain: Domain,
    pub code_ref: String,
    pub environment_ref: String,
    pub launch_ref: String,
    #[serde(deserialize_with = "deserialize_current_resource_refs")]
    pub resource_refs: Vec<String>,
    /// None only for an empty/unbound initialization snapshot.
    pub layout: Option<String>,
    pub generation: String,
    #[serde(default)]
    pub selected_from: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inheritance: Option<InheritanceDecision>,
}

fn deserialize_current_resource_refs<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<String>, D::Error> {
    let refs = Vec::<String>::deserialize(deserializer)?;
    if !refs.is_empty() {
        return Err(serde::de::Error::custom(
            "Unsupported project-file resource references",
        ));
    }
    Ok(refs)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultEntry {
    pub name: String,
    pub result: CompositeResult,
    pub workspace: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultDescriptor {
    #[serde(deserialize_with = "deserialize_result_schema")]
    pub schema: usize,
    pub run_id: String,
    pub result: CompositeResult,
    pub config: EnvironmentConfig,
    /// A result must be prepared by Runtime, not activated in the source folder.
    pub workspace: String,
    /// Schema 2 publishes independent business entries, never a merged env tree.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<ResultEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_entry: Option<String>,
}

fn deserialize_result_schema<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<usize, D::Error> {
    let schema = usize::deserialize(deserializer)?;
    if schema != 2 {
        return Err(serde::de::Error::custom(
            "Unsupported published result descriptor schema",
        ));
    }
    Ok(schema)
}

impl ResultDescriptor {
    pub(crate) fn validate_format(&self) -> Result<(), String> {
        if self.schema != 2 || self.entries.is_empty() {
            return Err("Unsupported published result descriptor format".into());
        }
        Ok(())
    }

    pub(crate) fn for_entry(&self, name: Option<&str>) -> Result<Self, String> {
        self.validate_format()?;
        let name = name
            .or(self.default_entry.as_deref())
            .ok_or("Published result has independent business entries; specify entryId")?;
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.name == name)
            .ok_or("Unknown published business entry")?;
        let mut selected = self.clone();
        selected.result = entry.result.clone();
        selected.workspace = entry.workspace.clone();
        Ok(selected)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub platform: &'static str,
    pub arch: &'static str,
    pub native_workspace: bool,
    pub fixed_physical_layout: bool,
    pub namespace_layout: bool,
    pub basic_snapshots: bool,
    pub extended_metadata: bool,
    pub shared_working_layers: bool,
    pub full_system_snapshot: bool,
    pub gpu_verified: bool,
    pub resource_quotas: bool,
    pub cpu_quota: bool,
    pub memory_quota: bool,
    pub device_leases: bool,
    pub storage: &'static str,
}

pub fn capabilities() -> Capabilities {
    Capabilities {
        platform: platform(),
        arch: std::env::consts::ARCH,
        native_workspace: cfg!(any(windows, target_os = "linux", target_os = "macos")),
        fixed_physical_layout: true,
        namespace_layout: false,
        basic_snapshots: true,
        extended_metadata: false,
        shared_working_layers: false,
        full_system_snapshot: false,
        gpu_verified: false,
        resource_quotas: false,
        cpu_quota: cfg!(windows),
        memory_quota: cfg!(windows),
        device_leases: cfg!(any(windows, target_os = "linux")),
        storage: "content-addressed bytes; independent copies",
    }
}

pub fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        std::env::consts::OS
    }
}

fn digest(bytes: &[u8]) -> Result<String, String> {
    git2::Oid::hash_object(git2::ObjectType::Blob, bytes)
        .map(|id| id.to_string())
        .map_err(|e| e.to_string())
}

pub(crate) fn safe_relative(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.contains(['\0', '\\', ':', '*', '?', '[', ']', '\n', '\r'])
        || !Path::new(value)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
        || Path::new(value).components().any(|p| match p {
            Component::Normal(name) => {
                let name = name.to_string_lossy().to_lowercase();
                let device = name.split('.').next().unwrap_or("");
                matches!(
                    name.as_str(),
                    ".git" | ".grapher" | ".grapher-worktrees" | ".grapher-workspaces"
                ) || cfg!(windows)
                    && (name.ends_with(['.', ' '])
                        || matches!(device, "con" | "prn" | "aux" | "nul" | "conin$" | "conout$")
                        || (device.starts_with("com") || device.starts_with("lpt"))
                            && device.chars().count() == 4
                            && device.ends_with([
                                '1', '2', '3', '4', '5', '6', '7', '8', '9', '¹', '²', '³',
                            ]))
            }
            _ => false,
        })
    {
        return Err(format!("Invalid managed environment path: {value}"));
    }
    Ok(())
}

fn variable_name(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || i > 0 && b.is_ascii_digit())
}

fn reserved(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key.starts_with("GRAPHER_")
        || key.starts_with("PI_")
        || key.starts_with("GIT_")
        || matches!(
            key.as_str(),
            "PATH"
                | "NODE_OPTIONS"
                | "NODE_PATH"
                | "BASH_ENV"
                | "ENV"
                | "SHELLOPTS"
                | "BASHOPTS"
                | "CDPATH"
                | "OLDPWD"
                | "GLOBIGNORE"
        )
}

/// Rebind an absolute project path without resolving away a project's own
/// directory links. Root aliases are accepted; external/relative paths and
/// dotted paths retain native semantics instead of guessing another layout.
pub(crate) fn project_path_template(path: &Path, source: &Path) -> Option<String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return None;
    }
    let relative = path
        .ancestors()
        .find_map(|ancestor| {
            crate::path_identity::same_path(ancestor, source)
                .then(|| path.strip_prefix(ancestor).ok().map(Path::to_path_buf))
                .flatten()
        })
        .or_else(|| {
            let actual = crate::path_identity::actual_path(path).ok()?;
            actual.ancestors().find_map(|ancestor| {
                crate::path_identity::same_path(ancestor, source)
                    .then(|| actual.strip_prefix(ancestor).ok().map(Path::to_path_buf))
                    .flatten()
            })
        })?;
    let suffix = relative.to_str()?;
    let suffix = if cfg!(windows) {
        suffix.replace('\\', "/")
    } else {
        suffix.to_string()
    };
    Some(if suffix.is_empty() {
        "{workspace}".into()
    } else {
        format!("{{workspace}}/{suffix}")
    })
}

/// NODE_PATH and PYTHONPATH use literal native-delimiter lists, not Windows
/// PATH quoting. Rebind only known project paths; retain external/relative,
/// empty, quoted and not-yet-created entries without guessing their meaning.
fn rebind_project_module_path(
    value: &str,
    source: &Path,
    workspace: &Path,
    variable: &str,
) -> Result<String, String> {
    let workspace = native::host_path(workspace)
        .to_string_lossy()
        .replace('\\', "/");
    let delimiter = if cfg!(windows) { ';' } else { ':' };
    let paths = value.split(delimiter).map(|value| {
        if let Some(mapped) = project_path_template(Path::new(value), source) {
            let mapped = mapped.replace("{workspace}", &workspace);
            if mapped.contains(delimiter) {
                return Err(format!("Rebound {variable} directory contains its list delimiter; choose a workspace path representable by the module loader"));
            }
            Ok(mapped)
        } else { Ok(value.to_string()) }
    }).collect::<Result<Vec<_>, String>>()?;
    Ok(paths.join(&delimiter.to_string()))
}

impl LaunchConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.path.is_empty()
            || self.entry.is_empty()
            || !Path::new(&self.shell).is_absolute()
            || !Path::new(&self.shell).is_file()
        {
            return Err("Launch needs an explicit entry, complete PATH and an existing absolute native Bash shell".into());
        }
        let absolute = |path: &str| {
            Path::new(path).is_absolute()
                || matches!(path, "{workspace}" | "{state}")
                || path.starts_with("{workspace}/")
                || path.starts_with("{state}/")
        };
        if self.entry.contains('\0') || !absolute(&self.entry) {
            return Err("Launch entry must be absolute, workspace-bound or state-bound".into());
        }
        if self.unbound_path.as_ref().is_some_and(Vec::is_empty) {
            return Err("Unbound business PATH must not be empty".into());
        }
        for path in self.path.iter().chain(self.unbound_path.iter().flatten()) {
            if path.contains('\0') || self.unbound_path.is_none() && !absolute(path) {
                return Err(format!("Invalid launch PATH entry: {path}"));
            }
        }
        if let Some(binding) = &self.environment {
            binding.validate()?;
        }
        if !self.managed_scopes.is_empty() {
            return Err(
                "Unsupported single-root managed scopes; use root-qualified ownership".into(),
            );
        }
        if let Some(scopes) = &self.owned_scopes {
            for scope in scopes {
                if !matches!(scope.root.as_str(), "workspace" | "state") {
                    return Err("Invalid managed environment ownership root".into());
                }
                safe_relative(&scope.path)?;
            }
        }
        for hint in &self.ambient_hints {
            hint.validate()?;
        }
        for key in self.variables.keys().chain(&self.inherit) {
            if !variable_name(key) || reserved(key) {
                return Err(format!("Reserved/invalid launch variable: {key}"));
            }
        }
        if self.variables.values().any(|v| v.contains('\0'))
            || self.hook.as_ref().is_some_and(|v| v.contains('\0'))
        {
            return Err("NUL in launch configuration".into());
        }
        Ok(())
    }

    pub(crate) fn restore_unbound_path(&mut self) {
        if let Some(path) = &self.unbound_path {
            self.path.clone_from(path);
        }
    }

    pub(crate) fn requires_entry_first(&self) -> bool {
        // An unbound automatic entry is an absolute Bash executable, not a
        // business-tool selector. Its installation must not outrank host tools.
        !self.inherit_ambient || self.environment.is_some() || self.hook.is_some()
    }

    /// Recovery locations are evidence for each entry, not additional business
    /// compatibility criteria. Callers still validate every entry's native
    /// startup and compare its managed prefix bytes as before.
    pub(crate) fn same_business_launch(&self, other: &Self) -> bool {
        let mut left = self.clone();
        let mut right = other.clone();
        for launch in [&mut left, &mut right] {
            if let Some(binding) = &mut launch.environment {
                binding.runtime_evidence = None;
            }
        }
        left == right
    }

    pub(crate) fn state_bound(&self) -> bool {
        self.variables
            .values()
            .chain(&self.path)
            .chain(self.unbound_path.iter().flatten())
            .chain(std::iter::once(&self.entry))
            .any(|value| value.contains("{state}"))
    }

    pub(crate) fn expanded(&self, path: &Path) -> Self {
        let root = native::host_path(path).to_string_lossy().replace('\\', "/");
        let state = crate::workspace_state::process_root(path).ok().map(|path| {
            native::host_path(&path)
                .to_string_lossy()
                .replace('\\', "/")
        });
        let expand = |v: &str| {
            let value = v.replace("{workspace}", &root);
            state
                .as_ref()
                .map_or_else(|| value.clone(), |state| value.replace("{state}", state))
        };
        Self {
            entry: expand(&self.entry),
            path: self.path.iter().map(|v| expand(v)).collect(),
            unbound_path: self
                .unbound_path
                .as_ref()
                .map(|path| path.iter().map(|v| expand(v)).collect()),
            shell: self.shell.clone(),
            variables: self
                .variables
                .iter()
                .map(|(k, v)| (k.clone(), expand(v)))
                .collect(),
            inherit: self.inherit.clone(),
            inherit_ambient: self.inherit_ambient,
            hook: self.hook.as_ref().map(|v| expand(v)),
            managed_scopes: self.managed_scopes.clone(),
            owned_scopes: self.owned_scopes.clone(),
            ambient_hints: self.ambient_hints.clone(),
            environment: self.environment.clone(),
        }
    }
}

impl EnvironmentConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.mode != "native-workspace" || !capabilities().native_workspace {
            return Err(format!(
                "Unverified native environment mode: {} (no execution fallback)",
                self.mode
            ));
        }
        if self.platform != platform() || self.arch != std::env::consts::ARCH {
            return Err("Environment platform/architecture differs from the actual native host; explicit rebuild required".into());
        }
        if !matches!(self.layout.as_str(), "fixed" | "relocatable") || self.scopes.is_empty() {
            return Err("Declare nonempty environment scopes and fixed/relocatable layout".into());
        }
        if self.import_source && (self.layout != "relocatable" || !self.initialize.is_empty()) {
            return Err(
                "Source import requires explicitly relocatable layout and cannot also initialize"
                    .into(),
            );
        }
        if self.best_effort
            && (!self.discovery
                || self.import_source
                || !self.initialize.is_empty()
                || self.launch_file.is_some()
                || !self.authority.is_empty())
        {
            return Err("Best-effort inheritance requires an empty-start discovery policy".into());
        }
        for (i, path) in self.scopes.iter().enumerate() {
            safe_relative(path)?;
            if self.scopes[..i].iter().any(|other| {
                workspace::scope_contains(Path::new(path), Path::new(other))
                    || workspace::scope_contains(Path::new(other), Path::new(path))
            }) {
                return Err(format!("Overlapping environment scopes: {path}"));
            }
        }
        for (i, path) in self.caches.iter().enumerate() {
            safe_relative(path)?;
            if self.caches[..i].iter().any(|other| {
                workspace::scope_contains(Path::new(path), Path::new(other))
                    || workspace::scope_contains(Path::new(other), Path::new(path))
            }) {
                return Err(format!("Overlapping environment caches: {path}"));
            }
            for scope in &self.scopes {
                let inside = workspace::scope_contains(Path::new(path), Path::new(scope));
                let contains = workspace::scope_contains(Path::new(scope), Path::new(path));
                // A cache may carve a subtree out of a scope. It must not equal a
                // scope or contain one, which would make that scope unreachable.
                if (inside || contains) && !(inside && !contains) {
                    return Err(format!(
                        "Environment cache must be nested inside a managed scope, not overlap it: {path}"
                    ));
                }
            }
        }
        if let Some(path) = &self.launch_file {
            safe_relative(path)?;
            if self.exclusions().iter().any(|scope| {
                workspace::scope_contains(Path::new(path), Path::new(scope))
                    || workspace::scope_contains(Path::new(scope), Path::new(path))
            }) {
                return Err("Launch policy file overlaps a managed tree".into());
            }
        }
        if self.baseline.is_empty()
            || !Path::new(&self.baseline[0]).is_absolute()
            || !Path::new(&self.baseline[0]).is_file()
        {
            return Err("An existing absolute native baseline probe is required".into());
        }
        if self
            .baseline
            .iter()
            .chain(&self.initialize)
            .any(|v| v.contains('\0'))
        {
            return Err("NUL in environment command".into());
        }
        if let Some(resources) = &self.resources {
            resources.validate()?;
        }
        for requirement in &self.require {
            let resources = self.resources.as_ref();
            let supported = match requirement.as_str() {
                "fixed-layout" | "basic-snapshots" | "private-copies" | "process-drain" => true,
                "cpu-quota" => cfg!(windows) && resources.is_some_and(|r| r.cpu_rate.is_some()),
                "memory-quota" => {
                    cfg!(windows) && resources.is_some_and(|r| r.memory_bytes.is_some())
                }
                "cuda" | "device-leases" => {
                    resources
                        .and_then(|r| r.device.as_ref())
                        .is_some_and(|d| d.backend == "cuda")
                        && cfg!(any(windows, target_os = "linux"))
                }
                _ => false,
            };
            if !supported {
                return Err(format!("Native capability not verified: {requirement}; refusing rather than changing mode/OS"));
            }
        }
        self.launch.validate()
    }

    pub(crate) fn exclusions(&self) -> Vec<String> {
        if self.launch.state_bound() {
            Vec::new()
        } else {
            self.scopes.iter().chain(&self.caches).cloned().collect()
        }
    }

    pub(crate) fn check_tracked(&self, path: &Path) -> Result<(), String> {
        // External scopes are not project-relative exclusions. In particular a
        // source-owned .venv/.agent-home is ordinary project data, even tracked.
        if self.launch.state_bound() {
            return Ok(());
        }
        let tracked = workspace::working_tree_git(path, &["ls-files", "-z", "--cached"])?;
        for name in tracked.split('\0').filter(|s| !s.is_empty()) {
            if self.exclusions().iter().any(|scope| {
                workspace::scope_contains_at(path, Path::new(name), Path::new(scope))
                    || workspace::scope_contains_at(path, Path::new(scope), Path::new(name))
            }) {
                return Err(format!(
                    "Managed environment/cache conflicts with tracked file: {name}"
                ));
            }
        }
        for scope in self.exclusions() {
            real_child_path(path, &path.join(scope), false)?;
        }
        Ok(())
    }
}

/// Snapshot storage is retained with the conversation, independently of code cwd.
pub(crate) struct Environments {
    pub(crate) files: Files,
    directory: PathBuf,
    config: EnvironmentConfig,
}

fn persist(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        if fs::read(path).map_err(|e| e.to_string())? == bytes {
            return Ok(());
        }
        return Err(format!(
            "Immutable environment record already exists: {}",
            path.display()
        ));
    }
    let parent = path.parent().ok_or("Missing snapshot parent")?;
    let temporary = parent.join(format!("pending-{}", Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

impl Environments {
    pub(crate) fn new(data: &Path, run: &str, config: &EnvironmentConfig) -> Result<Self, String> {
        config.validate()?;
        #[cfg(not(any(test, feature = "fixture")))]
        if !config.launch.state_bound() {
            return Err("Unsupported workspace contract: native process state must use the external {state} root; create a new Run".into());
        }
        Uuid::parse_str(run).map_err(|_| "Invalid environment Run ID")?;
        fs::create_dir_all(data).map_err(|e| e.to_string())?;
        let directory = data.join("environments").join(run);
        real_child_path(data, &directory, false)?;
        for name in ["launches", "records", "files"] {
            real_child_path(data, &directory.join(name), false)?;
            fs::create_dir_all(directory.join(name)).map_err(|e| e.to_string())?;
        }
        real_child_path(data, &directory, false)?;
        let files = Files::environment(&directory.join("files"), &config.scopes, &config.caches)?
            .with_project_index(!config.launch.state_bound());
        Ok(Self {
            files,
            directory,
            config: config.clone(),
        })
    }

    pub(crate) fn state_root(&self, path: &Path) -> Result<PathBuf, String> {
        if self.config.launch.state_bound() {
            crate::workspace_state::prepare(path)
        } else {
            Ok(path.to_path_buf())
        }
    }

    pub(crate) fn state_root_path(&self, path: &Path) -> Result<PathBuf, String> {
        if self.config.launch.state_bound() {
            crate::workspace_state::process_root(path)
        } else {
            Ok(path.to_path_buf())
        }
    }

    fn discovery_roots(&self, path: &Path) -> Result<(PathBuf, Option<PathBuf>), String> {
        let workspace = path.to_path_buf();
        let state = if self.config.launch.state_bound() {
            Some(self.state_root(path)?)
        } else {
            None
        };
        Ok((workspace, state))
    }

    /// A binding owns its prefix in either the visible workspace (genuine
    /// project `.venv`) or the external process-state root (provisioned envs).
    fn environment_root(&self, path: &Path, launch: &LaunchConfig) -> Result<PathBuf, String> {
        let (workspace, state) = self.discovery_roots(path)?;
        let roots = match state.as_deref() {
            Some(state) => vec![("workspace", workspace.as_path()), ("state", state)],
            None => vec![("workspace", workspace.as_path())],
        };
        let label = crate::environment_discovery::binding_root_label(launch, &roots);
        if label == "state" {
            state.ok_or("Native environment state root is unavailable".into())
        } else {
            Ok(workspace)
        }
    }

    fn environment_root_for(&self, path: &Path, reference: &str) -> Result<PathBuf, String> {
        self.environment_root(path, &self.load_launch(reference)?)
    }

    pub(crate) fn verify_view(
        &self,
        path: &Path,
        launch: &str,
        version: &str,
    ) -> Result<(), String> {
        if let Some(layouts) = self.snapshot_layouts(launch, version)? {
            self.files
                .verify_roots(&self.snapshot_targets(path, &layouts)?, version)
        } else {
            self.scoped_files_at(Some(path), launch)?.verify(
                &self.environment_root_for(path, launch)?,
                version,
                "",
            )
        }
    }

    pub(crate) fn validate_launch(&self, path: &Path, launch: &LaunchConfig) -> Result<(), String> {
        let (_, state) = self.discovery_roots(path)?;
        crate::environment_discovery::validate_launch_with_state(
            path,
            state.as_deref(),
            launch,
            !self.config.best_effort,
        )
    }

    pub(crate) fn launch(&self, config: &LaunchConfig) -> Result<String, String> {
        config.validate()?;
        let mut launch = config.clone();
        launch.owned_scopes.get_or_insert_with(Vec::new);
        let bytes = serde_json::to_vec(&serde_json::json!({"schema": 1, "launch": launch}))
            .map_err(|e| e.to_string())?;
        let id = digest(&bytes)?;
        persist(
            &self.directory.join("launches").join(format!("{id}.json")),
            &bytes,
        )?;
        Ok(id)
    }

    pub(crate) fn load_launch(&self, id: &str) -> Result<LaunchConfig, String> {
        if id.len() != 40 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid launch reference".into());
        }
        let path = self.directory.join("launches").join(format!("{id}.json"));
        let path =
            real_child_path(&self.directory, &path, true)?.ok_or("Missing launch configuration")?;
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        if digest(&bytes)? != id {
            return Err("Damaged launch configuration".into());
        }
        let record: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if record["schema"] != 1 {
            return Err("Unsupported native launch record format".into());
        }
        let launch: LaunchConfig =
            serde_json::from_value(record["launch"].clone()).map_err(|e| e.to_string())?;
        if launch.owned_scopes.is_none() {
            return Err("Native launch lacks root-qualified ownership".into());
        }
        launch.validate()?;
        Ok(launch)
    }

    pub(crate) fn baseline(&self) -> Result<Domain, String> {
        self.config.validate()?;
        let mut command = Command::new(&self.config.baseline[0]);
        command.args(&self.config.baseline[1..]);
        let mut probe = self.config.launch.clone();
        // Business variables must not inject code/configuration into the trusted
        // baseline probe, or make unrelated host configuration part of D.
        probe.inherit_ambient = false;
        probe
            .variables
            .retain(|_, value| !value.contains("{workspace}") && !value.contains("{state}"));
        probe.path.retain(|value| {
            Path::new(value).is_absolute()
                && !value.contains("{workspace}")
                && !value.contains("{state}")
        });
        clean_command(&mut command, &probe, None)?;
        command.env("PYTHONDONTWRITEBYTECODE", "1");
        let output = controlled_output(command)?;
        let executable =
            git2::Oid::hash_file(git2::ObjectType::Blob, Path::new(&self.config.baseline[0]))
                .map_err(|e| e.to_string())?;
        let device = self
            .config
            .resources
            .as_ref()
            .map(|r| r.device_identity())
            .transpose()?
            .flatten();
        let bytes = if let Some(device) = device {
            serde_json::to_vec(&(executable.to_string(), &output, device))
        } else {
            // Preserve pre-resource-policy domain identities for saved Runs.
            serde_json::to_vec(&(executable.to_string(), &output))
        }
        .map_err(|e| e.to_string())?;
        Ok(Domain {
            platform: platform().into(),
            arch: std::env::consts::ARCH.into(),
            baseline: digest(&bytes)?,
            policy: digest(&serde_json::to_vec(&self.config).map_err(|e| e.to_string())?)?,
            contract: "native-workspace-v4".into(),
        })
    }

    pub(crate) fn initialize(&self, source: &Path) -> Result<CompositeResult, String> {
        self.config.check_tracked(source)?;
        let domain = self.baseline()?;
        let launch_ref = self.launch(&self.config.launch)?;
        let environment_ref = Uuid::new_v4().to_string();
        if self.config.import_source {
            self.files.capture(source, &environment_ref, "", &[])?;
        } else {
            self.files.capture_empty(&environment_ref)?;
        }
        Ok(CompositeResult {
            domain,
            code_ref: String::new(),
            environment_ref,
            launch_ref,
            resource_refs: vec![],
            layout: None,
            generation: "baseline".into(),
            selected_from: vec!["baseline".into()],
            inheritance: None,
        })
    }

    /// Metadata-only actor admission. Native workers still perform complete
    /// baseline/byte validation before reading, reusing or materializing a view.
    pub(crate) fn validate_result_metadata(&self, result: &CompositeResult) -> Result<(), String> {
        if result.domain.platform != platform()
            || result.domain.arch != std::env::consts::ARCH
            || result.domain.contract != "native-workspace-v4"
            || result.domain.policy
                != digest(&serde_json::to_vec(&self.config).map_err(|e| e.to_string())?)?
        {
            return Err("Composite record does not match its frozen native policy".into());
        }
        self.scoped_files(&result.launch_ref)?
            .validate_manifest(&result.environment_ref)?;
        self.snapshot_layouts(&result.launch_ref, &result.environment_ref)?;
        self.load_launch(&result.launch_ref)?;
        Ok(())
    }

    pub(crate) fn validate_result(&self, result: &CompositeResult) -> Result<(), String> {
        if self.baseline()? != result.domain {
            return Err("Native baseline/domain changed; explicit rebuild required".into());
        }
        self.scoped_files(&result.launch_ref)?
            .validate(std::slice::from_ref(&result.environment_ref))?;
        self.snapshot_layouts(&result.launch_ref, &result.environment_ref)?;
        self.load_launch(&result.launch_ref)?;
        Ok(())
    }

    pub(crate) fn select(
        &self,
        node: &str,
        inputs: &[(String, CompositeResult)],
    ) -> Result<CompositeResult, String> {
        let first = inputs.first().ok_or("Missing environment input")?;
        if inputs
            .iter()
            .any(|(_, input)| input.domain != first.1.domain)
        {
            return Err("Environment inputs belong to different native domains".into());
        }
        if let Some(parent) = self.config.authority.get(node) {
            let mut selected = inputs
                .iter()
                .find(|(name, _)| name == parent)
                .ok_or_else(|| format!("Environment authority {parent} is not an input of {node}"))?
                .1
                .clone();
            selected.selected_from = vec![parent.clone()];
            return Ok(selected);
        }
        let same = |a: &CompositeResult, b: &CompositeResult| {
            a.environment_ref == b.environment_ref && a.launch_ref == b.launch_ref
        };
        let selected = if inputs.iter().all(|(_, input)| same(input, &first.1)) {
            &first.1
        } else if self.config.allow_descendant
            && inputs
                .iter()
                .all(|(_, input)| input.launch_ref == first.1.launch_ref)
        {
            inputs.iter().find(|(_, candidate)| inputs.iter().all(|(_, input)| self.files.descends_from(&candidate.environment_ref, &input.environment_ref).unwrap_or(false)))
                    .map(|(_, input)| input).ok_or("Workspace composition blocked: ambiguous independent environments; no provable automatic input")?
        } else {
            return Err("Workspace composition blocked: incompatible E/L inputs; no provable automatic selection (environment directories are never merged)".into());
        };
        let mut selected = selected.clone();
        selected.selected_from = inputs.iter().map(|(name, _)| name.clone()).collect();
        Ok(selected)
    }

    /// Metadata-only selection. Other parents remain provenance, not runtime
    /// constraints. Fixed-layout environments are reused only at their own path.
    pub(crate) fn select_for_workspace(
        &self,
        node: &str,
        inputs: &[(String, CompositeResult)],
        path: &str,
        baseline: &CompositeResult,
        current: Option<&CompositeResult>,
    ) -> Result<CompositeResult, String> {
        if !self.config.best_effort {
            return self.select(node, inputs);
        }
        self.validate_result_metadata(baseline)?;
        for input in inputs.iter().map(|(_, input)| input).chain(current) {
            if input.domain != baseline.domain {
                return Err("Environment inputs belong to different native domains".into());
            }
            self.validate_result_metadata(input)?;
        }
        // Layout spelling is not physical-slot identity (separators, root
        // aliases and redundant components may differ in persisted references).
        // Reuse still needs the current slot's exact E/L, never a sibling's.
        let same_layout = |input: &CompositeResult| {
            input.layout.as_deref().is_some_and(|layout| {
                crate::path_identity::same_path(Path::new(layout), Path::new(path))
            })
        };
        let local_current = current.filter(|input| same_layout(input));
        let local: Vec<_> = inputs
            .iter()
            .filter(|(_, input)| {
                same_layout(input)
                    && local_current.is_some_and(|current| {
                        current.environment_ref == input.environment_ref
                            && current.launch_ref == input.launch_ref
                    })
            })
            .cloned()
            .collect();
        let reusable = local.first().map(|(_, input)| input.clone());
        // A fresh slot may inherit plain private HOME state without inheriting
        // a fixed interpreter or another slot's owned prefixes. Existing slots
        // keep their own current state; this never authorizes a partial reset.
        let home_fork = if reusable.is_none() && local_current.is_none() {
            self.select_home_fork(inputs)?
        } else {
            None
        };
        let reason = if reusable.is_some() {
            "same-layout"
        } else if home_fork.is_some() {
            "unbound-home-fork"
        } else if inputs.iter().any(|(_, input)| {
            self.load_launch(&input.launch_ref)
                .is_ok_and(|launch| launch.environment.is_some())
        }) {
            "fixed-layout-not-reusable"
        } else {
            "unbound-inputs"
        };
        let mut selected = reusable.or(home_fork).unwrap_or_else(|| baseline.clone());
        let mut hints = Vec::new();
        for input in inputs.iter().map(|(_, input)| input).chain(current) {
            hints.extend(self.load_launch(&input.launch_ref)?.ambient_hints);
        }
        hints.sort_by(|a, b| {
            (&a.manager, &a.selector, &a.executable).cmp(&(&b.manager, &b.selector, &b.executable))
        });
        hints.dedup();
        let mut launch = self.load_launch(&selected.launch_ref)?;
        launch.ambient_hints = hints;
        // Falling back to an unbound launch does not relinquish environments
        // already owned by this physical slot. Never import sibling ownership.
        if let Some(current) = local_current {
            if let Some(scopes) = self.load_launch(&current.launch_ref)?.owned_scopes {
                let owned = launch.owned_scopes.get_or_insert_with(Vec::new);
                owned.extend(scopes);
                owned.sort();
                owned.dedup();
            }
        }
        selected.launch_ref = self.launch(&launch)?;
        selected.selected_from = inputs.iter().map(|(name, _)| name.clone()).collect();
        selected.inheritance = Some(InheritanceDecision {
            reason: reason.into(),
            inputs: inputs
                .iter()
                .map(|(name, input)| InheritanceInput {
                    node: name.clone(),
                    environment_ref: input.environment_ref.clone(),
                    launch_ref: input.launch_ref.clone(),
                    layout: input.layout.clone(),
                })
                .collect(),
        });
        Ok(selected)
    }

    fn configured_launch(&self, path: &Path, reference: &str) -> Result<LaunchConfig, String> {
        if let Some(file) = &self.config.launch_file {
            let file = real_child_path(path, &path.join(file), true)?
                .ok_or("Declared launch policy file is missing")?;
            let launch: LaunchConfig =
                serde_json::from_slice(&fs::read(file).map_err(|e| e.to_string())?)
                    .map_err(|e| format!("Invalid declared launch configuration: {e}"))?;
            launch.validate()?;
            Ok(launch)
        } else {
            self.load_launch(reference)
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn prepare(
        &self,
        path: &Path,
        selected: &CompositeResult,
        generation: &str,
        head: &str,
        resources: Vec<String>,
        preserve_failed: bool,
        history_edit: bool,
    ) -> Result<CompositeResult, String> {
        self.validate_result_metadata(selected)?;
        let root_layouts =
            self.snapshot_layouts(&selected.launch_ref, &selected.environment_ref)?;
        let project_exclusions = if root_layouts.is_some() {
            self.exclusions_at(path, &selected.launch_ref)?
        } else {
            Vec::new()
        };
        let project_guard = if self.config.launch.state_bound() {
            Some(crate::workspace_view::preparation_guard(
                path,
                &project_exclusions,
            )?)
        } else {
            None
        };
        if history_edit {
            self.validate_history_result_at(path, selected, &selected.launch_ref)?;
        }
        if self.baseline()? != selected.domain {
            return Err("Native baseline/domain changed; refusing unsafe environment reuse".into());
        }
        self.config.check_tracked(path)?;
        let layout = workspace::normalize_workspace_display_path(path);
        if self.requires_fixed_layout(&selected.launch_ref)?
            && selected.layout.as_ref().is_some_and(|original| {
                !crate::path_identity::same_path(Path::new(original), Path::new(&layout))
            })
        {
            return Err("Workspace composition blocked: fixed native environment cannot change physical layout; namespace/relocatable capability required".into());
        }
        let same_view = selected.layout.as_deref().is_some_and(|original| {
            crate::path_identity::same_path(Path::new(original), Path::new(&layout))
        });
        let scoped = self.scoped_files_at(Some(path), &selected.launch_ref)?;
        let unbound_best_effort = self.config.best_effort
            && selected.layout.is_none()
            && self
                .load_launch(&selected.launch_ref)?
                .environment
                .is_none();
        if !preserve_failed && !unbound_best_effort && (history_edit || !same_view) {
            self.preflight_prepared_runtime_evidence(path, selected)?;
        }
        let state = self.environment_root_for(path, &selected.launch_ref)?;
        let mut retained_home = None;
        if !unbound_best_effort && same_view && !history_edit && !preserve_failed {
            self.verify_view(path, &selected.launch_ref, &selected.environment_ref)?;
        } else if !preserve_failed && !unbound_best_effort {
            // Operation intent and recorded byte/launch coverage govern this
            // protection, never a diagnostic reason inherited from an old job.
            // An explicit history restoration retains its existing semantics.
            if !same_view && !history_edit {
                retained_home = self.retain_existing_home_target(path, selected)?;
            }
            if retained_home.is_some() {
                scoped.validate(std::slice::from_ref(&selected.environment_ref))?;
            } else {
                // Materialization validates every root's bytes and destinations
                // before applying any root. Legacy records keep their own format.
                if let Some(layouts) = &root_layouts {
                    self.files.materialize_roots(
                        &self.snapshot_targets(path, layouts)?,
                        &selected.environment_ref,
                    )?;
                } else {
                    scoped.materialize(
                        &state,
                        std::slice::from_ref(&selected.environment_ref),
                        None,
                        false,
                    )?;
                }
            }
        } else {
            scoped.validate(std::slice::from_ref(&selected.environment_ref))?;
        }
        if selected.layout.is_none()
            && !self.config.import_source
            && !self.config.initialize.is_empty()
        {
            let launch = self.load_launch(&selected.launch_ref)?.expanded(path);
            let expand = |v: &str| {
                v.replace(
                    "{workspace}",
                    &native::host_path(path).to_string_lossy().replace('\\', "/"),
                )
            };
            let program = expand(&self.config.initialize[0]);
            if !Path::new(&program).is_absolute() {
                return Err(
                    "Environment initializer must use an absolute native executable".into(),
                );
            }
            let mut command = Command::new(program);
            command
                .args(self.config.initialize[1..].iter().map(|v| expand(v)))
                .current_dir(native::host_path(path));
            clean_command(&mut command, &launch, None)?;
            let timeout = self
                .config
                .resources
                .as_ref()
                .and_then(|r| r.initialize_timeout_seconds)
                .unwrap_or(120);
            controlled_output_with_timeout(command, Some(std::time::Duration::from_secs(timeout)))?;
        }
        // Cache leaves are created by their actual consumer, outside project Git.
        if let Some(expected) = project_guard {
            if crate::workspace_view::preparation_guard(path, &project_exclusions)? != expected {
                return Err("Native environment preparation modified the project view; no agent may see runtime-injected files".into());
            }
        }
        self.finalize_input(
            path,
            retained_home.as_ref().unwrap_or(selected),
            generation,
            head,
            resources,
        )
    }

    /// Seal the current workspace view as this execution's input composite.
    /// Shared by ordinary preparation after Runtime has selected the current
    /// workspace environment.
    /// The caller has already materialized the selected current view.
    fn finalize_input(
        &self,
        path: &Path,
        selected: &CompositeResult,
        generation: &str,
        head: &str,
        resources: Vec<String>,
    ) -> Result<CompositeResult, String> {
        let launch = self.configured_launch(path, &selected.launch_ref)?;
        if self.config.discovery {
            self.validate_launch(path, &launch)?;
        }
        let expanded = launch.expanded(path);
        if launch.requires_entry_first()
            && Path::new(&expanded.entry).parent() != expanded.path.first().map(Path::new)
        {
            return Err(
                "Default entry directory must be first in the declared business PATH".into(),
            );
        }
        if !Path::new(&expanded.entry).is_file() {
            return Err("Declared default native entry is missing".into());
        }
        let launch_ref = self.launch(&launch)?;
        let environment_ref = self.capture_scoped(path, &selected.environment_ref, &launch_ref)?;
        let input = CompositeResult {
            domain: selected.domain.clone(),
            code_ref: head.into(),
            environment_ref,
            launch_ref,
            resource_refs: resources,
            layout: Some(workspace::normalize_workspace_display_path(path)),
            generation: generation.into(),
            selected_from: selected.selected_from.clone(),
            inheritance: selected.inheritance.clone(),
        };
        self.record(generation, "before", &input)?;
        Ok(input)
    }

    #[cfg(test)]
    pub(crate) fn validate_history_scopes(
        &self,
        selected: &str,
        previous: &str,
    ) -> Result<(), String> {
        self.validate_history_scopes_impl(None, selected, previous)
    }

    pub(super) fn validate_history_scopes_impl(
        &self,
        path: Option<&Path>,
        selected: &str,
        previous: &str,
    ) -> Result<(), String> {
        if self.config.discovery {
            let before = self.load_launch(previous)?;
            let target = self.load_launch(selected)?;
            // Git exclusions describe W only. Rollback restores the E snapshot,
            // whose root may instead be S; equal relative names are not proof
            // that a snapshot can restore another ownership root.
            if self.scope_root(&before) != self.scope_root(&target) {
                return Err("Historical rollback changes the environment ownership root; refusing unsafe partial scope restoration".into());
            }
            // L records ownership in both W and S, but the historical Files
            // format captures only the active root. Never treat exclusion or
            // ownership evidence as restorable bytes from the other root.
            for launch in [&before, &target] {
                let captured_root = self.scope_root(launch);
                if self.config.launch.state_bound() && captured_root != "state" {
                    return Err("Historical rollback lacks state-root byte evidence (including private HOME); refusing unsafe partial scope restoration".into());
                }
                if let Some(scope) = launch
                    .owned_scopes
                    .as_ref()
                    .and_then(|scopes| scopes.iter().find(|scope| scope.root != captured_root))
                {
                    return Err(format!("Historical rollback has ownership only, not captured bytes, for {}:{}; refusing unsafe partial scope restoration", scope.root, scope.path));
                }
            }
            let owner_root = match (self.scope_root(&before), path) {
                ("workspace", Some(path)) => Some(path.to_path_buf()),
                ("state", Some(path)) => Some(self.state_root_path(path)?),
                ("state", None) => Some(self.directory.clone()),
                _ => None,
            };
            let target_scopes = self.scope_paths_for_owner(owner_root.as_deref(), selected)?;
            if self
                .scope_paths_for_owner(owner_root.as_deref(), previous)?
                .iter()
                .any(|previous| {
                    !target_scopes.iter().any(|scope| {
                        owner_root.as_deref().map_or_else(
                            || workspace::scope_contains(Path::new(previous), Path::new(scope)),
                            |root| {
                                workspace::scope_contains_at(
                                    root,
                                    Path::new(previous),
                                    Path::new(scope),
                                )
                            },
                        )
                    })
                })
            {
                return Err("Historical rollback drops a dynamic environment scope outside the frozen roots; refusing unsafe partial scope restoration".into());
            }
        }
        Ok(())
    }

    pub(crate) fn requires_fixed_layout(&self, reference: &str) -> Result<bool, String> {
        Ok(self.config.layout == "fixed"
            && (!self.config.discovery || self.load_launch(reference)?.environment.is_some()))
    }

    pub(crate) fn prune_unreferenced_snapshots(
        &self,
        retained_env_refs: &std::collections::BTreeSet<String>,
        retained_launch_refs: &std::collections::BTreeSet<String>,
    ) -> Result<usize, String> {
        // Preflight both record families before deleting either one.
        for launch_ref in retained_launch_refs {
            if !launch_ref.is_empty() && self.load_launch(launch_ref).is_err() {
                return Ok(0);
            }
        }
        let mut removed = self.files.prune_unreferenced(retained_env_refs)?;
        let launches_dir = self.directory.join("launches");
        if let Some(dir) = real_child_path(&self.directory, &launches_dir, false)? {
            for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                let Ok(meta) = fs::symlink_metadata(&path) else {
                    continue;
                };
                if meta.file_type().is_symlink() || !meta.is_file() {
                    continue;
                }
                let name = entry.file_name();
                let Some(stem) = name.to_str().and_then(|s| s.strip_suffix(".json")) else {
                    continue;
                };
                if !retained_launch_refs.contains(stem) {
                    if fs::remove_file(&path).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
        Ok(removed)
    }

    fn dedup_scopes(root: Option<&Path>, mut paths: Vec<String>) -> Vec<String> {
        paths.sort();
        let mut unique: Vec<String> = Vec::with_capacity(paths.len());
        for candidate in paths {
            let duplicate = unique.iter().any(|existing| {
                if existing == &candidate {
                    return true;
                }
                let a = Path::new(existing);
                let b = Path::new(&candidate);
                root.map_or_else(
                    || workspace::scope_contains(a, b) && workspace::scope_contains(b, a),
                    |root| {
                        workspace::scope_contains_at(root, a, b)
                            && workspace::scope_contains_at(root, b, a)
                    },
                )
            });
            if !duplicate {
                unique.push(candidate);
            }
        }
        unique
    }

    pub(crate) fn exclusions(&self, reference: &str) -> Result<Vec<String>, String> {
        self.exclusions_impl(None, reference)
    }

    pub(crate) fn exclusions_at(&self, root: &Path, reference: &str) -> Result<Vec<String>, String> {
        self.exclusions_impl(Some(root), reference)
    }

    fn exclusions_impl(&self, root: Option<&Path>, reference: &str) -> Result<Vec<String>, String> {
        if self.config.launch.state_bound() {
            let launch = self.load_launch(reference)?;
            if let Some(scopes) = &launch.owned_scopes {
                let mut paths: Vec<_> = scopes
                    .iter()
                    .filter(|scope| scope.root == "workspace")
                    .map(|scope| scope.path.clone())
                    .collect();
                if let Some(binding) = &launch.environment {
                    if binding.root.as_deref() == Some("workspace") {
                        paths.push(binding.prefix.clone());
                    }
                }
                return Ok(Self::dedup_scopes(root, paths));
            }
            // A genuine project environment stays in the visible workspace, so
            // its project-relative scopes must remain excluded from Git. An
            // environment provisioned under {state} is not project-relative.
            let project = launch
                .environment
                .as_ref()
                .and_then(|binding| binding.root.as_deref())
                .is_some_and(|root| root == "workspace");
            if !project {
                return Ok(Vec::new());
            }
            let mut paths = self.config.scopes.clone();
            if let Some(binding) = &launch.environment {
                let covered = paths.iter().any(|scope| {
                    root.map_or_else(
                        || workspace::scope_contains(Path::new(&binding.prefix), Path::new(scope)),
                        |root| {
                            workspace::scope_contains_at(
                                root,
                                Path::new(&binding.prefix),
                                Path::new(scope),
                            )
                        },
                    )
                });
                if !covered {
                    paths.push(binding.prefix.clone());
                }
            }
            return Ok(Self::dedup_scopes(root, paths));
        }
        self.scope_paths_impl(root, reference)
    }

    fn scope_root<'a>(&self, launch: &'a LaunchConfig) -> &'a str {
        launch
            .environment
            .as_ref()
            .and_then(|binding| binding.root.as_deref())
            .unwrap_or(if self.config.launch.state_bound() {
                "state"
            } else {
                "workspace"
            })
    }

    fn uses_project_scopes(&self, launch: &LaunchConfig) -> bool {
        self.config.launch.state_bound()
            && launch.owned_scopes.is_some()
            && self.scope_root(launch) == "workspace"
    }

    #[cfg(all(test, feature = "fixture"))]
    fn scope_paths(&self, reference: &str) -> Result<Vec<String>, String> {
        self.scope_paths_impl(None, reference)
    }

    pub(super) fn scope_paths_impl(
        &self,
        root: Option<&Path>,
        reference: &str,
    ) -> Result<Vec<String>, String> {
        let launch = self.load_launch(reference)?;
        let owner_root = if self.scope_root(&launch) == "state" {
            root.and_then(|path| self.state_root_path(path).ok())
                .or_else(|| Some(self.directory.clone()))
        } else {
            root.map(Path::to_path_buf)
        };
        self.scope_paths_for_owner_launch(owner_root.as_deref(), &launch)
    }

    pub(super) fn scope_paths_for_owner(
        &self,
        owner_root: Option<&Path>,
        reference: &str,
    ) -> Result<Vec<String>, String> {
        let launch = self.load_launch(reference)?;
        self.scope_paths_for_owner_launch(owner_root, &launch)
    }

    fn scope_paths_for_owner_launch(
        &self,
        owner_root: Option<&Path>,
        launch: &LaunchConfig,
    ) -> Result<Vec<String>, String> {
        // State HOME/cache names must never become project exclusions simply
        // because the selected interpreter lives in the project.
        let mut paths: Vec<_> = if self.uses_project_scopes(launch) {
            Vec::new()
        } else {
            self.config
                .scopes
                .iter()
                .chain(&self.config.caches)
                .cloned()
                .collect()
        };
        if let Some(binding) = &launch.environment {
            paths.push(binding.prefix.clone());
        }
        if let Some(scopes) = &launch.owned_scopes {
            paths.extend(
                scopes
                    .iter()
                    .filter(|scope| scope.root == self.scope_root(launch))
                    .map(|scope| scope.path.clone()),
            );
        }
        Ok(Self::dedup_scopes(owner_root, paths))
    }

    pub(crate) fn scoped_files(&self, reference: &str) -> Result<Files, String> {
        self.scoped_files_at(None, reference)
    }

    pub(crate) fn scoped_files_at(
        &self,
        path: Option<&Path>,
        reference: &str,
    ) -> Result<Files, String> {
        let launch = self.load_launch(reference)?;
        let caches = if self.uses_project_scopes(&launch) {
            &[][..]
        } else {
            &self.config.caches
        };
        let owner_root = if self.scope_root(&launch) == "state" {
            path.and_then(|path| self.state_root_path(path).ok())
                .or_else(|| Some(self.directory.clone()))
        } else {
            path.map(Path::to_path_buf)
        };
        let scopes: Vec<_> = self
            .scope_paths_for_owner_launch(owner_root.as_deref(), &launch)?
            .into_iter()
            .filter(|scope| {
                !caches.iter().any(|cache| {
                    owner_root.as_deref().map_or_else(
                        || cache == scope,
                        |root| {
                            workspace::scope_contains_at(root, Path::new(scope), Path::new(cache))
                                && workspace::scope_contains_at(
                                    root,
                                    Path::new(cache),
                                    Path::new(scope),
                                )
                        },
                    )
                })
            })
            .collect();
        Ok(
            Files::environment(&self.directory.join("files"), &scopes, caches)?
                .with_project_index(!self.config.launch.state_bound()),
        )
    }

    fn capture_scoped(&self, path: &Path, parent: &str, reference: &str) -> Result<String, String> {
        if let Some(layouts) = self.root_layouts_for_launch(&self.load_launch(reference)?)? {
            self.files.capture_roots_reusing(
                &self.snapshot_targets(path, &layouts)?,
                &layouts,
                parent,
            )
        } else {
            self.scoped_files_at(Some(path), reference)?
                .capture_reusing(&self.environment_root_for(path, reference)?, parent)
        }
    }

    pub(crate) fn discover(
        &self,
        path: &Path,
        input: &CompositeResult,
        session: &Path,
    ) -> Result<CompositeResult, String> {
        if !self.config.discovery {
            return Ok(input.clone());
        }
        let (_, state) = self.discovery_roots(path)?;
        let launch = crate::environment_discovery::resolve_for_policy_with_state(
            path,
            state.as_deref(),
            &self.load_launch(&input.launch_ref)?,
            session,
            &input.generation,
            !self.config.best_effort,
            self.config.best_effort,
        )?;
        let reference = self.launch(&launch)?;
        let exclusions = self.exclusions_at(path, &reference)?;
        if self.config.launch.state_bound() && launch.owned_scopes.is_some() {
            // Inspect authored project Git, not the force-collected graph index.
            // Ordinary folders have no native index. Never silently hide a
            // tracked file or adopt an escaping link as an environment scope.
            let tracked = if path.join(".git").exists() {
                workspace::project_git(path, &["ls-files", "-z", "--cached"])?
            } else {
                String::new()
            };
            for scope in &exclusions {
                real_child_path(path, &path.join(scope), false)?;
                if let Some(name) =
                    tracked
                        .split('\0')
                        .filter(|name| !name.is_empty())
                        .find(|name| {
                            workspace::scope_contains_at(path, Path::new(name), Path::new(scope))
                                || workspace::scope_contains_at(
                                    path,
                                    Path::new(scope),
                                    Path::new(name),
                                )
                        })
                {
                    return Err(format!(
                        "Managed environment/cache conflicts with tracked file: {name}"
                    ));
                }
            }
        } else {
            let mut policy = self.config.clone();
            policy.scopes = exclusions
                .into_iter()
                .filter(|scope| {
                    !policy.caches.iter().any(|cache| {
                        workspace::scope_contains_at(path, Path::new(scope), Path::new(cache))
                            && workspace::scope_contains_at(
                                path,
                                Path::new(cache),
                                Path::new(scope),
                            )
                    })
                })
                .collect();
            policy.check_tracked(path)?;
        }
        Ok(CompositeResult {
            launch_ref: reference,
            ..input.clone()
        })
    }

    #[cfg(test)]
    fn capture(&self, path: &Path, parent: &str) -> Result<String, String> {
        self.files.capture_reusing(path, parent)
    }

    pub(crate) fn seal(
        &self,
        path: &Path,
        input: &CompositeResult,
        head: &str,
        resources: Vec<String>,
    ) -> Result<CompositeResult, String> {
        self.config.check_tracked(path)?;
        if self.baseline()? != input.domain {
            return Err("Native baseline changed during execution".into());
        }
        let launch_ref = self.launch(&self.configured_launch(path, &input.launch_ref)?)?;
        let result = CompositeResult {
            code_ref: head.into(),
            environment_ref: self.capture_scoped(path, &input.environment_ref, &launch_ref)?,
            launch_ref,
            resource_refs: resources,
            ..input.clone()
        };
        self.record(&input.generation, "after", &result)?;
        Ok(result)
    }

    pub(crate) fn prove_accelerator(
        &self,
        repository: &Path,
        path: &Path,
        input: &CompositeResult,
    ) -> Result<(), String> {
        if self
            .config
            .resources
            .as_ref()
            .and_then(|r| r.device.as_ref())
            .is_none()
        {
            return Ok(());
        }
        let data = self
            .directory
            .parent()
            .and_then(Path::parent)
            .ok_or("Missing native data root")?;
        let run = self
            .directory
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("Missing native Run ID")?;
        let session = self.directory.join("proofs").join(&input.generation);
        fs::create_dir_all(&session).map_err(|e| e.to_string())?;
        let mut command = native::execution_command(
            crate::engine::PiRole::NodeAgent,
            repository,
            path,
            data,
            &session,
        )?;
        command.arg("--grapher-run-result").args([
            "-I",
            "-c",
            crate::environment_resources::CUDA_PROOF,
        ]);
        command
            .env("GRAPHER_MODE", "result")
            .env("GRAPHER_EXECUTION_KIND", "graph")
            .env("GRAPHER_WORKSPACE_ROOT", native::host_path(path))
            .env("GRAPHER_ORIGINAL_ROOT", native::host_path(repository));
        bind_command(&mut command, data, run, &self.config, input, path, &session)?;
        let output = controlled_output(command)?;
        let proof: serde_json::Value = serde_json::from_slice(&output)
            .map_err(|e| format!("Invalid native accelerator computation proof: {e}"))?;
        if proof["backend"] != "cuda"
            || proof["devices"]
                .as_array()
                .is_none_or(|devices| devices.is_empty())
        {
            return Err("Missing native accelerator computation proof; no CPU fallback".into());
        }
        persist(
            &session.join("accelerator.json"),
            &serde_json::to_vec(&proof).map_err(|e| e.to_string())?,
        )
    }

    fn record_path(&self, execution: &str, phase: &str) -> Result<PathBuf, String> {
        Uuid::parse_str(execution).map_err(|_| "Invalid environment execution ID")?;
        if !matches!(phase, "selected" | "before" | "after") {
            return Err("Invalid environment record phase".into());
        }
        Ok(self
            .directory
            .join("records")
            .join(format!("{phase}-{execution}.json")))
    }

    /// Persist the selection before native preparation, so a failed initializer
    /// can be retried in its partial view even when no Agent was launched.
    pub(crate) fn record_selected(
        &self,
        execution: &str,
        code: &str,
        selected: &CompositeResult,
    ) -> Result<(), String> {
        let selected = CompositeResult {
            generation: execution.into(),
            code_ref: code.into(),
            ..selected.clone()
        };
        self.record(execution, "selected", &selected)
    }

    fn record(&self, execution: &str, phase: &str, result: &CompositeResult) -> Result<(), String> {
        persist(
            &self.record_path(execution, phase)?,
            &serde_json::to_vec(result).map_err(|e| e.to_string())?,
        )
    }

    /// Bounded reference/manifest checks for the event actor. The native writer
    /// already validates all bytes and baseline outside the Run mutex; do not
    /// scan a multi-GiB environment while blocking metadata/cancellation events.
    pub(crate) fn load_record_metadata(
        &self,
        execution: &str,
        phase: &str,
    ) -> Result<CompositeResult, String> {
        let path = self.record_path(execution, phase)?;
        let path = real_child_path(&self.directory, &path, true)?
            .ok_or("Missing composite execution evidence")?;
        let result: CompositeResult =
            serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if result.generation != execution {
            return Err("Composite result generation mismatch".into());
        }
        self.validate_result_metadata(&result)?;
        Ok(result)
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn load_record(
        &self,
        execution: &str,
        phase: &str,
    ) -> Result<CompositeResult, String> {
        let result = self.load_record_metadata(execution, phase)?;
        self.validate_result(&result)?;
        Ok(result)
    }

    pub(crate) fn descriptor(
        &self,
        run: &str,
        result: &CompositeResult,
    ) -> Result<ResultDescriptor, String> {
        // A descriptor identifies a sealed output, not another materialization.
        // Native use validates baseline/bytes outside the event actor.
        self.validate_result_metadata(result)?;
        Ok(ResultDescriptor {
            schema: 2,
            entries: vec![ResultEntry {
                name: "default".into(),
                result: result.clone(),
                workspace: result
                    .layout
                    .clone()
                    .ok_or("Result has no launchable native layout")?,
            }],
            default_entry: Some("default".into()),
            run_id: run.into(),
            result: result.clone(),
            config: self.config.clone(),
            workspace: result
                .layout
                .clone()
                .ok_or("Result has no launchable native layout")?,
        })
    }
}

/// Business values are transient, not part of immutable L. Legacy launches
/// keep explicit inheritance; automatic launches retain ordinary host variables.
pub(crate) fn clean_command(
    command: &mut Command,
    launch: &LaunchConfig,
    binding: Option<&Path>,
) -> Result<(), String> {
    clean_command_with_environment(command, launch, binding, std::env::vars_os().collect())
}

fn clean_command_with_environment(
    command: &mut Command,
    launch: &LaunchConfig,
    binding: Option<&Path>,
    ambient: BTreeMap<std::ffi::OsString, std::ffi::OsString>,
) -> Result<(), String> {
    let loader_variable = |key: &str| {
        key.to_ascii_uppercase().starts_with("LD_") || key.to_ascii_uppercase().starts_with("DYLD_")
    };
    let node_variable = |key: &std::ffi::OsStr| {
        let key = key.to_string_lossy();
        matches!(key.as_ref(), "NODE_OPTIONS" | "NODE_PATH")
            || cfg!(windows)
                && matches!(
                    key.to_ascii_uppercase().as_str(),
                    "NODE_OPTIONS" | "NODE_PATH"
                )
    };
    let mut loaders = BTreeMap::<String, String>::new();
    let mut business_node = BTreeMap::<String, String>::new();
    let overrides: Vec<_> = command
        .get_envs()
        .map(|(k, v)| (k.to_os_string(), v.map(|v| v.to_os_string())))
        .collect();
    let root = |name: &str| {
        overrides.iter().find_map(|(key, value)| {
            (key == name)
                .then(|| value.as_ref().map(PathBuf::from))
                .flatten()
        })
    };
    let project_roots = root("GRAPHER_ORIGINAL_ROOT").zip(root("GRAPHER_WORKSPACE_ROOT"));
    command.env_clear();
    let mut inherited = BTreeMap::new();
    if launch.inherit_ambient {
        for (key, value) in &ambient {
            let upper = key.to_string_lossy().to_ascii_uppercase();
            if binding.is_some() && node_variable(key) {
                business_node.insert(
                    upper,
                    value
                        .clone()
                        .into_string()
                        .map_err(|_| "Non-UTF-8 business Node binding")?,
                );
                continue;
            }
            // Keep business configuration and credentials, not an outer Agent's
            // identity or code injected into the trusted engine's Node startup.
            if !upper.starts_with("GRAPHER_") && !upper.starts_with("PI_")
                && !matches!(upper.as_str(), "PATH" | "NODE_OPTIONS" | "NODE_PATH")
                // Like native activation, a verified Python prefix must not be
                // redirected to a different installation by ambient PYTHONHOME.
                && !(launch.environment.is_some() && upper == "PYTHONHOME")
            {
                inherited.insert(key.clone(), value.clone());
            }
        }
    }
    for key in [
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
    ]
    .into_iter()
    .chain(launch.inherit.iter().map(String::as_str))
    {
        if let Some((name, value)) = ambient.iter().find(|(name, _)| {
            if cfg!(windows) {
                name.to_string_lossy().eq_ignore_ascii_case(key)
            } else {
                name.as_os_str() == std::ffi::OsStr::new(key)
            }
        }) {
            inherited.insert(name.clone(), value.clone());
        }
    }
    for (key, value) in inherited {
        // These are activation metadata, not arbitrary strings or secrets.
        // Match project PATH rebinding without adopting/relocating an environment.
        let value = if launch.unbound_path.is_some()
            && matches!(
                key.to_string_lossy().to_ascii_uppercase().as_str(),
                "VIRTUAL_ENV" | "CONDA_PREFIX" | "CONDA_DEFAULT_ENV"
            ) {
            project_roots
                .as_ref()
                .and_then(|(source, workspace)| {
                    let mapped = project_path_template(Path::new(value.to_str()?), source)?;
                    Some(std::ffi::OsString::from(
                        mapped.replace(
                            "{workspace}",
                            &native::host_path(workspace)
                                .to_string_lossy()
                                .replace('\\', "/"),
                        ),
                    ))
                })
                .unwrap_or(value)
        } else {
            value
        };
        if binding.is_some() && loader_variable(&key.to_string_lossy()) {
            loaders.insert(
                key.to_string_lossy().into(),
                value
                    .into_string()
                    .map_err(|_| "Non-UTF-8 loader binding")?,
            );
        } else {
            command.env(key, value);
        }
    }
    native::clear_git_environment(command);
    for (key, value) in overrides {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if binding.is_some() && node_variable(&key) {
            business_node.remove(&upper);
            if let Some(value) = value {
                business_node.insert(
                    upper,
                    value
                        .into_string()
                        .map_err(|_| "Non-UTF-8 business Node binding")?,
                );
            }
            command.env_remove(key);
            continue;
        }
        if binding.is_some() && loader_variable(&key.to_string_lossy()) {
            loaders.retain(|name, _| {
                if cfg!(windows) {
                    !name.eq_ignore_ascii_case(&key.to_string_lossy())
                } else {
                    name != &key.to_string_lossy()
                }
            });
            if let Some(value) = value {
                loaders.insert(
                    key.to_string_lossy().into(),
                    value
                        .into_string()
                        .map_err(|_| "Non-UTF-8 loader binding")?,
                );
            }
            command.env_remove(key);
            continue;
        }
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
    command.env(
        "PATH",
        std::env::join_paths(&launch.path).map_err(|e| format!("Invalid launch PATH: {e}"))?,
    );
    for (key, value) in &launch.variables {
        if binding.is_some() && loader_variable(key) {
            loaders.insert(key.clone(), value.clone());
        } else {
            command.env(key, value);
        }
    }
    if let Some((source, workspace)) = project_roots
        .as_ref()
        .filter(|_| launch.unbound_path.is_some())
    {
        if let Some(value) = business_node.get("NODE_PATH") {
            let value = rebind_project_module_path(value, source, workspace, "NODE_PATH")?;
            business_node.insert("NODE_PATH".into(), value);
        }
        // Use effective values AFTER explicit overrides/removals and frozen
        // launch variables. These known business paths stay transient, not new
        // L. Startup/config files are paths, not contents to parse or rewrite.
        let business_paths: Vec<_> = command
            .get_envs()
            .filter_map(|(key, value)| {
                let name = key.to_str()?;
                // npm treats its config-variable names case-insensitively on every
                // host (including npm's own lowercase variables in script children).
                let name = if cfg!(windows) || name.eq_ignore_ascii_case("NPM_CONFIG_USERCONFIG") {
                    name.to_ascii_uppercase()
                } else {
                    name.to_string()
                };
                if !matches!(
                    name.as_str(),
                    "PYTHONPATH" | "BASH_ENV" | "ENV" | "PIP_CONFIG_FILE" | "NPM_CONFIG_USERCONFIG"
                ) {
                    return None;
                }
                Some((key.to_os_string(), name, value?.to_str()?.to_string()))
            })
            .collect();
        for (key, name, value) in business_paths {
            let mapped = if name == "PYTHONPATH" {
                Some(rebind_project_module_path(
                    &value, source, workspace, &name,
                )?)
            } else {
                project_path_template(Path::new(&value), source).map(|mapped| {
                    mapped.replace(
                        "{workspace}",
                        &native::host_path(workspace)
                            .to_string_lossy()
                            .replace('\\', "/"),
                    )
                })
            };
            if let Some(value) = mapped {
                command.env(key, value);
            }
        }
    }
    // Business loader variables must not inject code into bubblewrap/Seatbelt
    // or trusted Node BEFORE the established native boundary. Values inherited
    // by name stay transient; the inner CLI applies them before factories.
    if binding.is_some() {
        command.env(
            "GRAPHER_BUSINESS_LOADER_ENV",
            serde_json::to_string(&loaders).map_err(|e| e.to_string())?,
        );
        // Apply only to business children, never the trusted Node, its build
        // bootstrap, activation capture, extension/MCP factories or probes.
        command.env(
            "GRAPHER_BUSINESS_NODE_ENV",
            serde_json::to_string(&business_node).map_err(|e| e.to_string())?,
        );
    }
    if let Some(path) = binding {
        command.env("GRAPHER_LAUNCH_BINDING", native::host_path(path));
    }
    command.env("PYTHONDONTWRITEBYTECODE", "1");
    Ok(())
}

pub(crate) fn controlled_output(command: Command) -> Result<Vec<u8>, String> {
    controlled_output_with_limits(
        command,
        Some(std::time::Duration::from_secs(120)),
        4 * 1024 * 1024,
    )
}

pub(crate) fn controlled_output_with_timeout(
    command: Command,
    timeout: Option<std::time::Duration>,
) -> Result<Vec<u8>, String> {
    controlled_output_with_limits(command, timeout, 4 * 1024 * 1024)
}

pub(crate) fn controlled_output_with_limits(
    mut command: Command,
    timeout: Option<std::time::Duration>,
    output_limit: usize,
) -> Result<Vec<u8>, String> {
    if !(4 * 1024 * 1024..=256 * 1024 * 1024).contains(&output_limit) {
        return Err("Native output cap is outside the supported range".into());
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::process_control::configure_command(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Native environment process could not start: {e}"))?;
    let tree = crate::process_control::track(&child).inspect_err(|_error| {
        let _ = child.kill();
        let _ = child.wait();
    })?;
    let collect = |mut pipe: Box<dyn std::io::Read + Send>| {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = (|| -> Result<Vec<u8>, String> {
                let mut output = Vec::new();
                let mut buffer = [0; 8192];
                let mut exceeded = false;
                loop {
                    let count = pipe.read(&mut buffer).map_err(|e| e.to_string())?;
                    if count == 0 {
                        break;
                    }
                    if output.len() + count <= output_limit {
                        output.extend_from_slice(&buffer[..count]);
                    } else {
                        exceeded = true;
                    }
                }
                if exceeded {
                    Err(format!(
                        "Native command output exceeds {output_limit} bytes per stream"
                    ))
                } else {
                    Ok(output)
                }
            })();
            let _ = sender.send(result);
        });
        receiver
    };
    let stdout = collect(Box::new(
        child.stdout.take().ok_or("Missing native stdout")?,
    ));
    let stderr = collect(Box::new(
        child.stderr.take().ok_or("Missing native stderr")?,
    ));
    let deadline = timeout.map(|timeout| std::time::Instant::now() + timeout);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
            tree.terminate();
            let _ = child.wait();
            return Err("Native environment command timed out; partial workspace retained".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    tree.drain_for_handoff(crate::process_control::OBSERVE_DRAIN)?;
    let output = stdout
        .recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| "Native stdout handles have not drained")??;
    let stderr = stderr
        .recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| "Native stderr handles have not drained")??;
    if !status.success() {
        let detail: String = String::from_utf8_lossy(&stderr)
            .chars()
            .take(4096)
            .collect();
        let stdout: String = String::from_utf8_lossy(&output)
            .chars()
            .take(4096)
            .collect();
        return Err(format!(
            "Native environment command failed ({status}); no fallback\n{detail}\n{stdout}"
        ));
    }
    Ok(output)
}

/// Bind a persisted L before Pi/extension initialization. No warmed private
/// process may survive an environment/view change; managed launches are cold.
pub(crate) fn bind_command(
    command: &mut Command,
    data: &Path,
    run: &str,
    config: &EnvironmentConfig,
    input: &CompositeResult,
    path: &Path,
    session: &Path,
) -> Result<(), String> {
    let store = Environments::new(data, run, config)?;
    // Called only after the owning worker prepares/validates the selected view.
    // Rebinding L (also for proofs) must not rescan every environment byte.
    store.validate_result_metadata(input)?;
    let launch = store.load_launch(&input.launch_ref)?.expanded(path);
    let state = if config.launch.state_bound() {
        Some(store.state_root(path)?)
    } else {
        None
    };
    if let Some(state) = state.as_deref() {
        for key in [
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
            "npm_config_cache",
            "PIP_CACHE_DIR",
            "CONDA_ENVS_PATH",
            "CONDA_PKGS_DIRS",
        ] {
            if let Some(value) = launch.variables.get(key) {
                let paths: Vec<_> = if matches!(key, "CONDA_ENVS_PATH" | "CONDA_PKGS_DIRS") {
                    std::env::split_paths(value).collect()
                } else {
                    vec![PathBuf::from(value)]
                };
                for value in paths {
                    if !value.is_absolute() || !workspace::scope_contains(&value, state) {
                        return Err(format!(
                            "Runtime variable {key} leaves its external owned state root"
                        ));
                    }
                    real_child_path(state, &value, false)?;
                }
            }
        }
    }
    let global_agent = crate::native::environment_path("GRAPHER_GLOBAL_PI_AGENT_DIR")
        .or_else(|| crate::native::home_dir().map(|home| home.join(".pi/agent")));
    if let Some(directory) = global_agent {
        command.env("GRAPHER_GLOBAL_PI_AGENT_DIR", native::host_path(&directory));
    }
    let binding = session.join(format!("launch-{}.json", input.generation));
    fs::create_dir_all(session).map_err(|e| e.to_string())?;
    persist(
        &binding,
        &serde_json::to_vec(&launch).map_err(|e| e.to_string())?,
    )?;
    clean_command(command, &launch, Some(&binding))?;
    if let Some(hints) = previous_agent_environment_hints(&launch) {
        command.env("GRAPHER_PREVIOUS_AGENT_ENVIRONMENT_HINTS", hints);
    }
    if config.discovery {
        // Read only the launcher's explicit source binding, never a model
        // argument or an inherited outer Agent's environment variable.
        let source = command
            .get_envs()
            .find_map(|(key, value)| {
                (key == "GRAPHER_ORIGINAL_ROOT")
                    .then(|| value.map(PathBuf::from))
                    .flatten()
            })
            .ok_or("Missing source binding for native environment observation")?;
        let context = crate::environment_discovery::context_with_source(
            path,
            state.as_deref(),
            Some(&source),
            &input.generation,
            &launch,
            session,
            config.best_effort,
        )?;
        command
            .env("GRAPHER_ENVIRONMENT_DISCOVERY", native::host_path(&context))
            .env(
                "GRAPHER_ENVIRONMENT_HELPER",
                native::host_path(&std::env::current_exe().map_err(|e| e.to_string())?),
            );
    }
    crate::environment_resources::bind(command, config)
}

fn previous_agent_environment_hints(launch: &LaunchConfig) -> Option<String> {
    (!launch.ambient_hints.is_empty()).then(|| {
        launch
            .ambient_hints
            .iter()
            .map(|hint| {
                format!(
                    "previous agent used: {} {} ({})",
                    hint.manager, hint.selector, hint.executable
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    })
}

#[cfg(test)]
#[path = "environment_snapshot_tests.rs"]
mod snapshot_tests;

#[cfg(test)]
#[path = "environment_tests.rs"]
mod tests;

#[cfg(all(test, feature = "fixture"))]
#[path = "environment_best_effort_tests.rs"]
mod best_effort_tests;

#[cfg(all(test, feature = "fixture"))]
#[path = "environment_fork_tests.rs"]
mod fork_tests;
