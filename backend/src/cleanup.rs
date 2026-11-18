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

pub(crate) mod detached;

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
        /// Source binding owned when this target was recorded. Used to serialize
        /// live ref/object reclamation with Grapher Git work on that source.
        #[serde(deserialize_with = "Option::deserialize")]
        source: Option<PathBuf>,
    },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub targets: BTreeSet<Target>,
    /// None: deleted conversation; Some: workspace-only cleanup at this event.
    pub sequence: Option<i64>,
    pub protected_sources: BTreeSet<PathBuf>,
    #[serde(deserialize_with = "Option::deserialize")]
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

    fn location(&self, data: &Path, run_id: &str) -> Result<(PathBuf, PathBuf), String> {
        let location = match self {
            Self::Data { bucket, id } => {
                if !matches!(
                    bucket.as_str(),
                    "sessions"
                        | "planning"
                        | "mergers"
                        | "planner-sessions"
                        | "environments"
                        | "file-changes"
                        | "attachment-inputs"
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
                    || bucket != ".grapher-worktrees"
                    || Uuid::parse_str(owner).is_err()
                    || owner != run_id
                    || checkout.is_some()
                {
                    return Err("Invalid owned workspace directory".into());
                }
                (parent.clone(), parent.join(bucket).join(owner))
            }
            Self::Shadow { root, name, .. } => {
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
        Ok(location)
    }

    pub(crate) fn resolve(&self, data: &Path, run_id: &str) -> Result<Option<PathBuf>, String> {
        let (root, child) = self.location(data, run_id)?;
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
        Ok(source) if source.is_dir() => {
            crate::path_identity::actual_path(&source).unwrap_or(source)
        }
        Ok(_) => return Ok(targets),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(targets),
        Err(error) => return Err(error.to_string()),
    };
    if Uuid::parse_str(run_id).is_ok() {
        let parent = crate::workspace::workspaces_parent(root);
        fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
        let parent = parent
            .canonicalize()
            .map(|resolved| crate::path_identity::actual_path(&resolved).unwrap_or(resolved))
            .map_err(|error| error.to_string())?;
        targets.insert(Target::workspace(&parent, run_id, ".grapher-worktrees"));
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
            source: Some(source.clone()),
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
        | EventKind::GraphRevised { .. }
        | EventKind::ManualGraphRevised { .. } => state.config.as_ref(),
        _ => None,
    };
    if let Some(config) = config {
        store.remember_cleanup_source(Path::new(&config.repository))?;
        targets.extend(configuration_targets(root, &state.run_id, config)?);
    }
    match kind {
        EventKind::EnvironmentPolicyResolved {
            environment: Some(_),
            ..
        } => {
            targets.insert(Target::data("environments", &state.run_id));
        }
        EventKind::Started { execution, .. } => {
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
    let planning = crate::workspace_cleanup::planning_ids(root, state)?;
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
                EventKind::Started { execution, .. } => {
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
        if safe_id(&state.run_id) {
            targets.insert(Target::data("file-changes", &state.run_id));
        }
    } else {
        targets.retain(|target| matches!(target, Target::Workspace { .. }));
    }
    let mut protected_sources = store.cleanup_sources()?;
    let mut protect = |config: &Config| {
        let path = PathBuf::from(&config.repository);
        if path.is_absolute() {
            let resolved = crate::path_identity::actual_path(&path)
                .or_else(|_| path.canonicalize())
                .unwrap_or(path);
            protected_sources.insert(resolved);
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

/// Commits that another live Run may still resolve while its node results are
/// prepared. They keep their `refs/grapher/heads/*` pins during a deleted Run's
/// object reclamation even if no current ref points at them yet.
fn protected_shadow_objects(store: &Store, excluded: &str) -> Result<BTreeSet<String>, String> {
    let mut protected = BTreeSet::new();
    for id in store.runs()? {
        if id == excluded {
            continue;
        }
        let state: Snapshot = store.load(&id)?;
        let mut add = |head: &str| {
            if !head.is_empty() {
                protected.insert(head.to_string());
            }
        };
        add(&state.base);
        if let Some(head) = &state.published_head {
            add(head);
        }
        for head in &state.published_heads {
            add(head);
        }
        for node in state.nodes.values() {
            if let Some(head) = &node.head {
                add(head);
            }
            if let Some(input) = &node.feedback_workspace {
                for source in input.sources() {
                    add(&source.head);
                }
            }
        }
        for execution in state.executions.iter().chain(state.mergers.iter()) {
            add(&execution.before);
            if let Some(head) = &execution.after {
                add(head);
            }
        }
        for event in &state.events {
            match &event.kind {
                EventKind::Approved { base } => add(base),
                EventKind::SourceSnapshotted { head }
                | EventKind::PublicationCompleted { head }
                | EventKind::Prepared { head, .. }
                | EventKind::WorkspaceResolved { head, .. } => add(head),
                EventKind::GraphRevised {
                    source_head: Some(head),
                    ..
                }
                | EventKind::ManualGraphRevised {
                    source_head: Some(head),
                    ..
                } => add(head),
                _ => {}
            }
        }
    }
    Ok(protected)
}
/// Lifetime checks shared by normal completion and durable cleanup retries.
/// A matching event sequence proves freshness, not that recovery/result files
/// are disposable. Retrying an older queued task must honor today's policy.
pub(crate) fn retains_workspaces(state: &Snapshot) -> bool {
    if state
        .config
        .as_ref()
        .and_then(|config| config.environment.as_ref())
        .is_some()
    {
        return true;
    }
    let serial = state.plan_type.as_deref() == Some("serial");
    !serial
        && (!state.pending_feedback.is_empty()
            || state.nodes.values().any(|node| node.status != "completed")
            || state.executions.iter().any(|execution| {
                execution.status == "completed"
                    && state.nodes.contains_key(&execution.node)
                    && !state.superseded_execution_ids.contains(&execution.id)
                    && execution.after.as_ref().is_some_and(|head| {
                        !head.is_empty() && !state.published_heads.contains(head)
                    })
            }))
}

/// Caller must hold the Run's runtime mutex for workspace-only tasks. The
/// sequence check cancels stale cleanup once a follow-up/revision changes it.
pub(crate) fn execute(root: &Path, store: &Store, task: &Task) -> Result<(), String> {
    execute_inner(root, store, task, false)
}

/// Under the owning Run lock, retire workspace paths without recursively
/// deleting them. Independent durable receipts own the detached directories.
pub(crate) fn retire_workspaces(root: &Path, store: &Store, task: &Task) -> Result<(), String> {
    if task.manifest.sequence.is_none() {
        return Err("Only workspace-only cleanup can be detached".into());
    }
    match execute_inner(root, store, task, true) {
        Ok(()) => Ok(()),
        Err(error) => {
            store.fail_cleanup(&task.run_id, &error)?;
            Err(error)
        }
    }
}

fn execute_inner(root: &Path, store: &Store, task: &Task, detach: bool) -> Result<(), String> {
    let mut manifest = task.manifest.clone();
    if let Some(sequence) = task.manifest.sequence {
        if store.contains_run(&task.run_id)? {
            let state = store.load(&task.run_id)?;
            if state.events.last().map_or(0, |event| event.sequence) != sequence {
                return store.finish_cleanup(&task.run_id);
            }
            if matches!(
                state.phase.as_str(),
                "planning" | "publishing" | "merging" | "launching_result"
            ) || state.nodes.values().any(|node| node.status == "running")
                || state
                    .executions
                    .iter()
                    .chain(&state.mergers)
                    .any(|execution| execution.status == "running")
                || state
                    .result_execution
                    .as_ref()
                    .is_some_and(|execution| execution.status == "running")
            {
                return Err("Run is active; workspace cleanup is deferred".into());
            }
            if retains_workspaces(&state) {
                // Handle/cancel this cleanup generation without dropping its
                // ownership records. Explicit conversation deletion still owns
                // eventual removal; a later publication can queue a new task.
                return store.finish_cleanup(&task.run_id);
            }
            // Refresh recorded ownership while the Run generation is unchanged.
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
            BTreeSet::new()
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
    let deleting = task.manifest.sequence.is_none();
    let protected = if deleting {
        protected_shadow_objects(store, &task.run_id)?
    } else {
        BTreeSet::new()
    };
    let mut paths = Vec::new();
    let mut detached_targets = Vec::new();
    for target in &manifest.targets {
        let shared = store.cleanup_target_is_shared(&task.run_id, target)?;
        if shared && deleting {
            if let Target::Shadow { source, .. } = target {
                if let Some(path) = target.resolve(root, &task.run_id)? {
                    if let Some(source) = source {
                        let lock = crate::workspace::host_ref_lock(source)?;
                        let _guard = lock.lock().map_err(|error| error.to_string())?;
                        crate::workspace::prune_shadow_run_refs(
                            &path,
                            &task.run_id,
                            &protected,
                            true,
                        )?;
                    } else {
                        // Without a source lock, defer object GC to offline cleanup.
                        crate::workspace::prune_shadow_run_refs(
                            &path,
                            &task.run_id,
                            &protected,
                            false,
                        )?;
                    }
                }
            }
        }
        if shared {
            continue;
        }
        if let Some(path) = target.resolve(root, &task.run_id)? {
            if !manifest
                .protected_sources
                .iter()
                .any(|source| crate::workspace::scope_contains(source, &path))
            {
                if detach {
                    if !matches!(target, Target::Workspace { .. }) {
                        return Err("Detached cleanup cannot remove non-workspace resources".into());
                    }
                    detached_targets.push((target.clone(), path.clone()));
                }
                paths.push(path);
            }
        }
    }
    if detach {
        // Retire only the top-level targets; a parent's receipt owns its entire tree.
        for (target, path) in &detached_targets {
            if paths
                .iter()
                .any(|parent| parent != path && path.starts_with(parent))
            {
                continue;
            }
            detached::retire(root, store, &task.run_id, target)?;
        }
    } else {
        crate::workspace_cleanup::remove_paths(paths)?;
    }
    if let Some(repository) = &manifest.unresolved_repository {
        return Err(format!("Workspace ownership predates this version and the binding is missing: {repository}. Restore it or explicitly inspect its project parent with cleanup:workspaces."));
    }
    store.finish_cleanup(&task.run_id)
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
