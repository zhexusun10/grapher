//! Durable, narrowly scoped cleanup. Database deletion and its cleanup manifest
//! commit together; failed filesystem operations never lose their ownership.
use crate::{
    model::{Config, EventKind, Snapshot},
    path_safety::real_child_path,
    store::Store,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Data {
        bucket: String,
        id: String,
    },
    Workspace {
        parent: PathBuf,
        bucket: String,
        owner: String,
        checkout: Option<String>,
    },
    Shadow {
        root: PathBuf,
        name: String,
    },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub targets: BTreeSet<Target>,
    /// None: deleted conversation; Some: workspace-only cleanup at this event.
    pub sequence: Option<i64>,
    #[serde(default)]
    pub protected_sources: BTreeSet<PathBuf>,
    #[serde(default)]
    pub unresolved_repository: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub run_id: String,
    pub manifest: Manifest,
    pub attempts: usize,
    pub last_error: Option<String>,
}

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Target {
    pub fn data(bucket: &str, id: &str) -> Self {
        Self::Data {
            bucket: bucket.into(),
            id: id.into(),
        }
    }

    pub(crate) fn resolve(&self, data: &Path, run_id: &str) -> Result<Option<PathBuf>, String> {
        let (root, child) = match self {
            Self::Data { bucket, id } => {
                if !matches!(
                    bucket.as_str(),
                    "sessions" | "planning" | "mergers" | "planner-sessions" | "partition-workers" | "environments"
                ) || !safe_id(id)
                {
                    return Err("Invalid owned session directory".into());
                }
                (data.to_path_buf(), data.join(bucket).join(id))
            }
            Self::Workspace {
                parent,
                bucket,
                owner,
                checkout,
            } => {
                if !parent.is_absolute()
                    || !matches!(
                        bucket.as_str(),
                        ".grapher-worktrees" | ".grapher-workspaces"
                    )
                    || Uuid::parse_str(owner).is_err()
                    || (checkout.is_none() && owner != run_id)
                    || checkout.as_ref().is_some_and(|id| {
                        bucket != ".grapher-workspaces" || Uuid::parse_str(id).is_err()
                    })
                {
                    return Err("Invalid owned workspace directory".into());
                }
                let mut child = parent.join(bucket).join(owner);
                if let Some(checkout) = checkout {
                    child.push(checkout);
                }
                (parent.clone(), child)
            }
            Self::Shadow { root, name } => {
                let valid = name
                    .strip_suffix(".git")
                    .and_then(|name| name.rsplit_once('_'))
                    .is_some_and(|(project, hash)| {
                        !project.is_empty()
                            && !project.contains(['/', '\\'])
                            && hash.len() == 16
                            && hash.chars().all(|c| c.is_ascii_hexdigit())
                    });
                if !root.is_absolute() || !valid {
                    return Err("Invalid owned shadow repository".into());
                }
                (root.clone(), root.join("shadow_repos").join(name))
            }
        };
        if !root.exists() {
            match fs::symlink_metadata(&root) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.to_string()),
                Ok(_) => {
                    return Err(format!(
                        "Refusing missing or linked cleanup root: {}",
                        root.display()
                    ))
                }
            }
        }
        real_child_path(&root, &child, false)
    }

    fn workspace(parent: &Path, run_id: &str, bucket: &str) -> Self {
        Self::Workspace {
            parent: parent.to_path_buf(),
            bucket: bucket.into(),
            owner: run_id.into(),
            checkout: None,
        }
    }
}

/// Record physical workspace ownership while the source still exists, before
/// any checkout is allocated. A moved/deleted source no longer loses this proof.
pub(crate) fn configuration_targets(
    root: &Path,
    run_id: &str,
    config: &Config,
) -> Result<BTreeSet<Target>, String> {
    let mut targets = BTreeSet::new();
    if config.environment.is_some() && Uuid::parse_str(run_id).is_ok() {
        targets.insert(Target::data("environments", run_id));
    }
    let source = Path::new(&config.repository);
    if !source.is_absolute() {
        return Ok(targets);
    }
    let source = match source.canonicalize() {
        Ok(source) if source.is_dir() => source,
        Ok(_) => return Ok(targets),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(targets),
        Err(error) => return Err(error.to_string()),
    };
    if Uuid::parse_str(run_id).is_ok() {
        let parent = crate::workspace::workspaces_parent(root);
        fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
        let parent = parent.canonicalize().map_err(|error| error.to_string())?;
        targets.insert(Target::workspace(&parent, run_id, ".grapher-worktrees"));
        // Keep legacy project-adjacent ownership; old executions can still be
        // resumed/removed without moving their recorded paths.
        if let Some(parent) = source.parent() {
            for bucket in [".grapher-worktrees", ".grapher-workspaces"] {
                targets.insert(Target::workspace(parent, run_id, bucket));
            }
        }
    }
    let shadow = crate::workspace::shadow_repo_dir(&source)?;
    if fs::symlink_metadata(&shadow).is_ok() {
        targets.insert(Target::Shadow {
            root: crate::workspace::data_root(),
            name: shadow
                .file_name()
                .ok_or("Invalid shadow directory")?
                .to_string_lossy()
                .into_owned(),
        });
    }
    Ok(targets)
}

pub(crate) fn remember_event(
    root: &Path,
    store: &Store,
    state: &Snapshot,
    kind: &EventKind,
) -> Result<(), String> {
    let mut targets = BTreeSet::new();
    let config = match kind {
        EventKind::Created { config, .. }
        | EventKind::PlanningStarted { config, .. }
        | EventKind::DraftEdited { config, .. } => Some(config),
        EventKind::Approved { .. }
        | EventKind::Started { .. }
        | EventKind::MergerStarted { .. }
        | EventKind::GraphRevised { .. } => state.config.as_ref(),
        _ => None,
    };
    if let Some(config) = config {
        store.remember_cleanup_source(Path::new(&config.repository))?;
        targets.extend(configuration_targets(root, &state.run_id, config)?);
    }
    match kind {
        EventKind::EnvironmentPolicyResolved { environment: Some(_), .. } => {
            targets.insert(Target::data("environments", &state.run_id));
        }
        EventKind::Started { execution } => {
            targets.insert(Target::data("sessions", &execution.id));
        }
        EventKind::MergerStarted { execution } => {
            targets.insert(Target::data("mergers", &execution.id));
        }
        _ => {}
    }
    if !targets.is_empty() {
        store.remember_cleanup_targets(&state.run_id, &targets)?;
    }
    Ok(())
}

fn legacy_workspace(path: &Path, run_id: &str) -> Option<Target> {
    if !path.is_absolute() {
        return None;
    }
    let checkout = path.file_name()?.to_str()?;
    let owner_dir = path.parent()?;
    let owner = owner_dir.file_name()?.to_str()?;
    let bucket_dir = owner_dir.parent()?;
    let bucket = bucket_dir.file_name()?.to_str()?;
    if Uuid::parse_str(owner).is_err() || Uuid::parse_str(run_id).is_err() {
        return None;
    }
    let parent = bucket_dir.parent()?.canonicalize().ok()?;
    if bucket == ".grapher-worktrees" && owner == run_id {
        Some(Target::workspace(&parent, run_id, bucket))
    } else if bucket == ".grapher-workspaces" && Uuid::parse_str(checkout).is_ok() {
        Some(Target::Workspace {
            parent,
            bucket: bucket.into(),
            owner: owner.into(),
            checkout: Some(checkout.into()),
        })
    } else {
        None
    }
}

/// Recover legacy workspace roots without requiring the source folder. Prefer
/// already proven physical parents (including execution/Planner metadata) over
/// the binding's lexical parent, which may have been only a source alias.
fn missing_source_workspaces(
    run_id: &str,
    repository: &str,
    targets: &BTreeSet<Target>,
) -> Result<BTreeSet<Target>, String> {
    let mut recovered = BTreeSet::new();
    if Uuid::parse_str(run_id).is_err() {
        return Ok(recovered);
    }
    let mut parents: BTreeSet<PathBuf> = targets
        .iter()
        .filter_map(|target| match target {
            Target::Workspace { parent, .. } => Some(parent.clone()),
            _ => None,
        })
        .collect();
    if parents.is_empty() {
        let source = Path::new(repository);
        if !source.is_absolute()
            || source.file_name().is_none()
            || source
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Ok(recovered);
        }
        let Some(parent) = source.parent() else {
            return Ok(recovered);
        };
        let parent = match parent.canonicalize() {
            Ok(parent) => parent,
            // Nothing exists at this recorded location, but retaining it in
            // the manifest keeps retries idempotent if deletion is interrupted.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => parent.to_path_buf(),
            Err(error) => return Err(error.to_string()),
        };
        parents.insert(parent);
    }
    for parent in parents {
        for bucket in [".grapher-worktrees", ".grapher-workspaces"] {
            recovered.insert(Target::workspace(&parent, run_id, bucket));
        }
    }
    Ok(recovered)
}

pub(crate) fn manifest(
    root: &Path,
    store: &Store,
    state: &Snapshot,
    deleted: bool,
) -> Result<Manifest, String> {
    let mut targets = store.owned_cleanup_targets(&state.run_id)?;
    if let Some(config) = &state.config {
        match configuration_targets(root, &state.run_id, config) {
            Ok(current) => targets.extend(current),
            Err(_)
                if targets
                    .iter()
                    .any(|target| matches!(target, Target::Workspace { .. })) => {}
            Err(error) => return Err(error),
        }
    }
    // Legacy databases lack recorded physical parents. Execution metadata and
    // owned planning markers authorize only the standard private layout.
    for execution in state.executions.iter().chain(&state.mergers) {
        if let Some(target) = legacy_workspace(Path::new(&execution.worktree), &state.run_id) {
            if !matches!(&target, Target::Workspace { owner, checkout: Some(checkout), .. } if owner != &state.run_id && checkout != &execution.id)
            {
                targets.insert(target);
            }
        }
    }
    for event in &state.events {
        if let EventKind::Started { execution } | EventKind::MergerStarted { execution } =
            &event.kind
        {
            if let Some(target) = legacy_workspace(Path::new(&execution.worktree), &state.run_id) {
                if !matches!(&target, Target::Workspace { owner, checkout: Some(checkout), .. } if owner != &state.run_id && checkout != &execution.id)
                {
                    targets.insert(target);
                }
            }
        }
    }
    let planning = crate::workspace_cleanup::planning_ids(root, state)?;
    for id in &planning {
        let marker = root.join("planning").join(id).join("planner-workspace");
        if let Some(marker) = real_child_path(root, &marker, true)? {
            let path =
                PathBuf::from(fs::read_to_string(marker).map_err(|error| error.to_string())?);
            if let Some(target) = legacy_workspace(&path, &state.run_id) {
                if matches!(&target, Target::Workspace { checkout: Some(checkout), .. } if checkout == id)
                {
                    targets.insert(target);
                }
            }
        }
    }
    if let Some(config) = &state.config {
        if !Path::new(&config.repository).is_dir() {
            targets.extend(missing_source_workspaces(
                &state.run_id,
                &config.repository,
                &targets,
            )?);
        }
    }
    let unresolved_repository = state
        .config
        .as_ref()
        .filter(|config| {
            Path::new(&config.repository).is_absolute()
                && !Path::new(&config.repository).is_dir()
                && Uuid::parse_str(&state.run_id).is_ok()
                && !targets
                    .iter()
                    .any(|target| matches!(target, Target::Workspace { .. }))
        })
        .map(|config| config.repository.clone());
    if deleted {
        for execution in &state.executions {
            targets.insert(Target::data("sessions", &execution.id));
        }
        for execution in &state.mergers {
            targets.insert(Target::data("mergers", &execution.id));
        }
        for event in &state.events {
            match &event.kind {
                EventKind::Started { execution } => {
                    targets.insert(Target::data("sessions", &execution.id));
                }
                EventKind::MergerStarted { execution } => {
                    targets.insert(Target::data("mergers", &execution.id));
                }
                _ => {}
            }
        }
        for id in planning {
            targets.insert(Target::data("planning", &id));
        }
        if safe_id(&state.run_id) {
            targets.insert(Target::data("planner-sessions", &state.run_id));
        }
    } else {
        targets.retain(|target| matches!(target, Target::Workspace { .. }));
    }
    let mut protected_sources = store.cleanup_sources()?;
    let mut protect = |config: &Config| {
        let path = PathBuf::from(&config.repository);
        if path.is_absolute() {
            protected_sources.insert(path.canonicalize().unwrap_or(path));
        }
    };
    if let Some(config) = &state.config {
        protect(config);
    }
    for event in &state.events {
        if let EventKind::Created { config, .. }
        | EventKind::PlanningStarted { config, .. }
        | EventKind::DraftEdited { config, .. } = &event.kind
        {
            protect(config);
        }
    }
    let manifest = Manifest {
        targets,
        sequence: if deleted {
            None
        } else {
            Some(state.events.last().map_or(0, |event| event.sequence))
        },
        protected_sources,
        unresolved_repository,
    };
    if deleted {
        validate(root, &state.run_id, &manifest)?;
    }
    Ok(manifest)
}

pub(crate) fn validate(root: &Path, run_id: &str, manifest: &Manifest) -> Result<(), String> {
    for target in &manifest.targets {
        target.resolve(root, run_id)?;
    }
    Ok(())
}

/// Caller must hold the Run's runtime mutex for workspace-only tasks. The
/// sequence check cancels stale cleanup once a follow-up/revision changes it.
pub(crate) fn execute(root: &Path, store: &Store, task: &Task) -> Result<(), String> {
    let mut manifest = task.manifest.clone();
    if let Some(sequence) = task.manifest.sequence {
        if store.contains_run(&task.run_id)? {
            let state = store.load(&task.run_id)?;
            if state.events.last().map_or(0, |event| event.sequence) != sequence {
                return store.finish_cleanup(&task.run_id);
            }
            if matches!(state.phase.as_str(), "planning" | "publishing" | "merging")
                || state.nodes.values().any(|node| node.status == "running")
            {
                return Err("Run is active; workspace cleanup is deferred".into());
            }
            // Retry collecting legacy markers too, if the first attempt could
            // not read them. The Run's event generation is still unchanged.
            manifest = self::manifest(root, store, &state, false)?;
            store.enqueue_cleanup(&task.run_id, &manifest)?;
        } else if !store.run_was_deleted(&task.run_id)? {
            return Err("Cleanup has no Run ownership".into());
        }
    } else if !store.run_was_deleted(&task.run_id)? {
        return Err("Refusing conversation cleanup without a deletion tombstone".into());
    }
    if let Some(repository) = &manifest.unresolved_repository {
        let recovered = if Path::new(repository).is_dir() {
            let config: Config = serde_json::from_value(
                serde_json::json!({"repository":repository,"model":"cleanup","maxParallel":1}),
            )
            .map_err(|error| error.to_string())?;
            configuration_targets(root, &task.run_id, &config)?
        } else {
            missing_source_workspaces(&task.run_id, repository, &manifest.targets)?
        };
        if recovered
            .iter()
            .any(|target| matches!(target, Target::Workspace { .. }))
        {
            manifest.targets.extend(recovered);
            manifest.unresolved_repository = None;
            store.enqueue_cleanup(&task.run_id, &manifest)?;
        }
    }
    // Revalidate the entire plan on EVERY retry, before the first removal.
    validate(root, &task.run_id, &manifest)?;
    manifest.protected_sources.extend(store.cleanup_sources()?);
    let mut paths = Vec::new();
    for target in &manifest.targets {
        if store.cleanup_target_is_shared(&task.run_id, target)? {
            continue;
        }
        if let Some(path) = target.resolve(root, &task.run_id)? {
            if !manifest
                .protected_sources
                .iter()
                .any(|source| source.starts_with(&path))
            {
                paths.push(path);
            }
        }
    }
    crate::workspace_cleanup::remove_paths(paths)?;
    if let Some(repository) = &manifest.unresolved_repository {
        return Err(format!("Workspace ownership predates this version and the binding is missing: {repository}. Restore it or explicitly inspect its project parent with cleanup:workspaces."));
    }
    store.finish_cleanup(&task.run_id)
}

/// Only new, marked idle workers are disposable. Claimed workers with failed
/// copy-back have durable Run ownership and retain their recoverable histories.
pub(crate) fn idle_partitioners(root: &Path, store: &Store) -> Result<Vec<Task>, String> {
    let mut tasks = Vec::new();
    let Some(directory) = real_child_path(root, &root.join("partition-workers"), false)? else {
        return Ok(tasks);
    };
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if Uuid::parse_str(&id).is_err() {
            continue;
        }
        let target = Target::data("partition-workers", &id);
        if store.has_cleanup_owner(&target)? {
            continue;
        }
        let Some(marker) = real_child_path(
            root,
            &root
                .join("partition-workers")
                .join(&id)
                .join(".grapher-partition-worker.json"),
            true,
        )?
        else {
            continue;
        };
        let marker: serde_json::Value =
            serde_json::from_slice(&fs::read(marker).map_err(|error| error.to_string())?)
                .unwrap_or_default();
        if marker["kind"] != "grapher-partition-worker" || marker["version"] != 1 {
            continue;
        }
        tasks.push(Task {
            run_id: format!("partition-prewarm-{id}"),
            manifest: Manifest {
                targets: BTreeSet::from([target]),
                ..Default::default()
            },
            attempts: 0,
            last_error: None,
        });
    }
    Ok(tasks)
}

pub(crate) fn attempt(root: &Path, store: &Store, task: &Task) -> Result<(), String> {
    match execute(root, store, task) {
        Ok(()) => Ok(()),
        Err(error) => {
            store.fail_cleanup(&task.run_id, &error)?;
            Err(error)
        }
    }
}
