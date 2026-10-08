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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchConfig {
    /// An explicit native executable, usually {workspace}/.venv/.../python.
    pub entry: String,
    /// Complete business PATH, not additions to an inherited host PATH.
    pub path: Vec<String>,
    pub shell: String,
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
    /// Names only. Values (including credentials) are injected, never persisted.
    #[serde(default)]
    pub inherit: Vec<String>,
    /// Trusted Bash initialization, e.g. a declared Conda activation hook.
    #[serde(default)]
    pub hook: Option<String>,
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
    /// Project-relative opaque persistent trees, frozen by native admission.
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
    /// New Runs start unbound; ordinary business tools create the environment.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub discovery: bool,
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
pub struct CompositeResult {
    pub domain: Domain,
    pub code_ref: String,
    pub environment_ref: String,
    pub launch_ref: String,
    pub resource_refs: Vec<String>,
    /// None only for an empty/unbound initialization snapshot.
    pub layout: Option<String>,
    pub generation: String,
    #[serde(default)]
    pub selected_from: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultDescriptor {
    pub schema: usize,
    pub run_id: String,
    pub result: CompositeResult,
    pub config: EnvironmentConfig,
    /// A result must be prepared by Runtime, not activated in the source folder.
    pub workspace: String,
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
            "PATH" | "NODE_OPTIONS" | "NODE_PATH" | "BASH_ENV" | "ENV" | "SHELLOPTS" | "BASHOPTS"
        )
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
        for path in self.path.iter().chain(std::iter::once(&self.entry)) {
            if path.contains('\0')
                || !(Path::new(path).is_absolute() || path.starts_with("{workspace}/"))
            {
                return Err(format!(
                    "Launch path must be absolute or workspace-bound: {path}"
                ));
            }
        }
        if let Some(binding) = &self.environment {
            binding.validate()?;
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

    pub(crate) fn expanded(&self, path: &Path) -> Self {
        let root = native::host_path(path).to_string_lossy().replace('\\', "/");
        let expand = |v: &str| v.replace("{workspace}", &root);
        Self {
            entry: expand(&self.entry),
            path: self.path.iter().map(|v| expand(v)).collect(),
            shell: self.shell.clone(),
            variables: self
                .variables
                .iter()
                .map(|(k, v)| (k.clone(), expand(v)))
                .collect(),
            inherit: self.inherit.clone(),
            hook: self.hook.as_ref().map(|v| expand(v)),
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
        let paths = self.exclusions();
        for (i, path) in paths.iter().enumerate() {
            safe_relative(path)?;
            if paths[..i].iter().any(|other| {
                workspace::scope_contains(Path::new(path), Path::new(other))
                    || workspace::scope_contains(Path::new(other), Path::new(path))
            }) {
                return Err(format!("Overlapping environment/cache scopes: {path}"));
            }
        }
        if let Some(path) = &self.launch_file {
            safe_relative(path)?;
            if paths.iter().any(|scope| {
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
        self.scopes.iter().chain(&self.caches).cloned().collect()
    }

    pub(crate) fn check_tracked(&self, path: &Path) -> Result<(), String> {
        let tracked = workspace::repository_git(path, &["ls-files", "-z", "--cached"])?;
        for name in tracked.split('\0').filter(|s| !s.is_empty()) {
            if self.exclusions().iter().any(|scope| {
                workspace::scope_contains(Path::new(name), Path::new(scope))
                    || workspace::scope_contains(Path::new(scope), Path::new(name))
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
        Uuid::parse_str(run).map_err(|_| "Invalid environment Run ID")?;
        fs::create_dir_all(data).map_err(|e| e.to_string())?;
        let directory = data.join("environments").join(run);
        real_child_path(data, &directory, false)?;
        for name in ["launches", "records", "files"] {
            real_child_path(data, &directory.join(name), false)?;
            fs::create_dir_all(directory.join(name)).map_err(|e| e.to_string())?;
        }
        real_child_path(data, &directory, false)?;
        let files = Files::environment(&directory.join("files"), &config.scopes)?;
        Ok(Self {
            files,
            directory,
            config: config.clone(),
        })
    }

    pub(crate) fn launch(&self, config: &LaunchConfig) -> Result<String, String> {
        config.validate()?;
        let bytes = serde_json::to_vec(config).map_err(|e| e.to_string())?;
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
        let launch: LaunchConfig = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        launch.validate()?;
        Ok(launch)
    }

    pub(crate) fn baseline(&self) -> Result<Domain, String> {
        self.config.validate()?;
        let mut command = Command::new(&self.config.baseline[0]);
        command.args(&self.config.baseline[1..]);
        let mut probe = self.config.launch.clone();
        probe
            .variables
            .retain(|_, value| !value.contains("{workspace}"));
        probe.path.retain(|value| !value.contains("{workspace}"));
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
            contract: "native-workspace-v1".into(),
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
        })
    }

    /// Metadata-only actor admission. Native workers still perform complete
    /// baseline/byte validation before reading, reusing or materializing a view.
    pub(crate) fn validate_result_metadata(&self, result: &CompositeResult) -> Result<(), String> {
        if result.domain.platform != platform()
            || result.domain.arch != std::env::consts::ARCH
            || result.domain.contract != "native-workspace-v1"
            || result.domain.policy
                != digest(&serde_json::to_vec(&self.config).map_err(|e| e.to_string())?)?
        {
            return Err("Composite record does not match its frozen native policy".into());
        }
        self.scoped_files(&result.launch_ref)?
            .validate_manifest(&result.environment_ref)?;
        self.load_launch(&result.launch_ref)?;
        Ok(())
    }

    pub(crate) fn validate_result(&self, result: &CompositeResult) -> Result<(), String> {
        if self.baseline()? != result.domain {
            return Err("Native baseline/domain changed; explicit rebuild required".into());
        }
        self.scoped_files(&result.launch_ref)?
            .validate(&[result.environment_ref.clone()])?;
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
        if self.baseline()? != selected.domain {
            return Err("Native baseline/domain changed; refusing unsafe environment reuse".into());
        }
        self.config.check_tracked(path)?;
        let layout = workspace::normalize_workspace_display_path(path);
        if self.requires_fixed_layout(&selected.launch_ref)?
            && selected
                .layout
                .as_ref()
                .is_some_and(|original| *original != layout)
        {
            return Err("Workspace composition blocked: fixed native environment cannot change physical layout; namespace/relocatable capability required".into());
        }
        let same_view = selected.layout.as_deref() == Some(&layout);
        let scoped = self.scoped_files(&selected.launch_ref)?;
        if same_view && !history_edit && !preserve_failed {
            scoped.verify(path, &selected.environment_ref, "")?;
        } else if !preserve_failed {
            // Materialization itself validates every stored byte before touching
            // the view; do not repeat the same multi-GiB scan beforehand.
            scoped.materialize(path, &[selected.environment_ref.clone()], None, false)?;
        } else {
            scoped.validate(&[selected.environment_ref.clone()])?;
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
        for cache in &self.config.caches {
            fs::create_dir_all(path.join(cache)).map_err(|e| e.to_string())?;
        }
        let launch = self.configured_launch(path, &selected.launch_ref)?;
        if self.config.discovery {
            crate::environment_discovery::validate_launch(path, &launch)?;
        }
        let expanded = launch.expanded(path);
        if Path::new(&expanded.entry).parent() != expanded.path.first().map(Path::new) {
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
            layout: Some(layout),
            generation: generation.into(),
            selected_from: selected.selected_from.clone(),
        };
        self.record(generation, "before", &input)?;
        Ok(input)
    }

    pub(crate) fn validate_history_scopes(
        &self,
        selected: &str,
        previous: &str,
    ) -> Result<(), String> {
        if self.config.discovery {
            if let Some(binding) = self.load_launch(previous)?.environment {
                if !self.exclusions(selected)?.iter().any(|scope| {
                    workspace::scope_contains(Path::new(&binding.prefix), Path::new(scope))
                }) {
                    return Err("Historical rollback drops a dynamic environment scope outside the frozen roots; refusing unsafe partial scope restoration".into());
                }
            }
        }
        Ok(())
    }

    pub(crate) fn requires_fixed_layout(&self, reference: &str) -> Result<bool, String> {
        Ok(self.config.layout == "fixed"
            && (!self.config.discovery || self.load_launch(reference)?.environment.is_some()))
    }

    pub(crate) fn exclusions(&self, reference: &str) -> Result<Vec<String>, String> {
        let mut paths = self.config.exclusions();
        if let Some(binding) = self.load_launch(reference)?.environment {
            if !paths.iter().any(|scope| {
                workspace::scope_contains(Path::new(&binding.prefix), Path::new(scope))
            }) {
                paths.push(binding.prefix);
            }
        }
        Ok(paths)
    }

    pub(crate) fn scoped_files(&self, reference: &str) -> Result<Files, String> {
        let scopes: Vec<_> = self
            .exclusions(reference)?
            .into_iter()
            .filter(|scope| !self.config.caches.contains(scope))
            .collect();
        Files::environment(&self.directory.join("files"), &scopes)
    }

    fn capture_scoped(&self, path: &Path, parent: &str, reference: &str) -> Result<String, String> {
        let files = self.scoped_files(reference)?;
        let version = Uuid::new_v4().to_string();
        files.capture(path, &version, "", &[parent.into()])?;
        if files.same_contents(parent, &version)? {
            Ok(parent.into())
        } else {
            Ok(version)
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
        let launch = crate::environment_discovery::resolve(
            path,
            &self.load_launch(&input.launch_ref)?,
            session,
            &input.generation,
        )?;
        let reference = self.launch(&launch)?;
        let exclusions = self.exclusions(&reference)?;
        let mut policy = self.config.clone();
        policy.scopes = exclusions
            .into_iter()
            .filter(|scope| !policy.caches.contains(scope))
            .collect();
        policy.check_tracked(path)?;
        Ok(CompositeResult {
            launch_ref: reference,
            ..input.clone()
        })
    }

    #[cfg(test)]
    fn capture(&self, path: &Path, parent: &str) -> Result<String, String> {
        let version = Uuid::new_v4().to_string();
        self.files.capture(path, &version, "", &[parent.into()])?;
        if self.files.same_contents(parent, &version)? {
            Ok(parent.into())
        } else {
            Ok(version)
        }
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
            schema: 1,
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

/// No inherited business environment; OS plumbing and explicitly authorized
/// values are separate from immutable L. Native launcher overrides survive.
pub(crate) fn clean_command(
    command: &mut Command,
    launch: &LaunchConfig,
    binding: Option<&Path>,
) -> Result<(), String> {
    let loader_variable = |key: &str| {
        key.to_ascii_uppercase().starts_with("LD_") || key.to_ascii_uppercase().starts_with("DYLD_")
    };
    let mut loaders = BTreeMap::<String, String>::new();
    let overrides: Vec<_> = command
        .get_envs()
        .map(|(k, v)| (k.to_os_string(), v.map(|v| v.to_os_string())))
        .collect();
    command.env_clear();
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
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    for key in &launch.inherit {
        if let Some(value) = std::env::var_os(key) {
            if binding.is_some() && loader_variable(key) {
                loaders.insert(
                    key.clone(),
                    value
                        .into_string()
                        .map_err(|_| "Non-UTF-8 loader binding")?,
                );
            } else {
                command.env(key, value);
            }
        }
    }
    for (key, value) in overrides {
        if binding.is_some() && loader_variable(&key.to_string_lossy()) {
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
    // Business loader variables must not inject code into bubblewrap/Seatbelt
    // or trusted Node BEFORE the established native boundary. Values inherited
    // by name stay transient; the inner CLI applies them before factories.
    if binding.is_some() {
        command.env(
            "GRAPHER_BUSINESS_LOADER_ENV",
            serde_json::to_string(&loaders).map_err(|e| e.to_string())?,
        );
    }
    if let Some(path) = binding {
        command.env("GRAPHER_LAUNCH_BINDING", native::host_path(path));
    }
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
    let tree = crate::process_control::track(&child).map_err(|error| {
        let _ = child.kill();
        let _ = child.wait();
        error
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
    tree.ensure_drained()?;
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
    let global_agent = std::env::var_os("GRAPHER_GLOBAL_PI_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|home| PathBuf::from(home).join(".pi/agent"))
        });
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
    if config.discovery {
        let context =
            crate::environment_discovery::context(path, &input.generation, &launch, session)?;
        command
            .env("GRAPHER_ENVIRONMENT_DISCOVERY", native::host_path(&context))
            .env(
                "GRAPHER_ENVIRONMENT_HELPER",
                native::host_path(&std::env::current_exe().map_err(|e| e.to_string())?),
            );
    }
    crate::environment_resources::bind(command, config)
}

#[cfg(test)]
#[path = "environment_tests.rs"]
mod tests;
