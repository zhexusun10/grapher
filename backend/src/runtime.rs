use crate::{
    compiler::{compile, downstream},
    engine,
    model::*,
    runtime_lock::{acquire, RuntimeLock},
    store::Store,
    workspace,
};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

#[derive(Clone)]
pub struct Job {
    pub execution: Execution,
    pub run_id: String,
    pub parent_heads: Vec<String>,
    pub config: Config,
    pub task: String,
    pub images: Option<Vec<ImageAttachment>>,
    pub resume_execution_id: Option<String>,
    pub session_fork: Option<Execution>,
    pub feedback_workspace: Option<FeedbackWorkspace>,
    /// A previous attempt of this node already failed inside the pinned
    /// feedback source directory. Its residue (unrecorded snapshot commit or
    /// interrupted writes) belongs to this node's repair, not to a foreign
    /// mutation, so the cleanliness check may adopt it as the retry base.
    pub feedback_repair_retry: bool,
    /// The selected worktree already contains the inherited commit; do not rebuild it from refs.
    pub inherit_workspace: bool,
    /// A failed attempt with durable Prepared evidence. Its own working tree,
    /// including uncommitted files and agent commits, must not be recomposed.
    pub preserved_workspace: Option<Execution>,
    /// Physical baseline for one-time copies of files that are outside the
    /// recorded Git commit; normal project outputs are inherited through Git.
    pub copy_from_workspace: Option<String>,
    pub history_edit: bool,
    pub feedback_source: bool,
    /// First job batch of a plain-directory graph run: materialize the external
    /// shadow repository before any prepare/hand-off work.
    pub materialize_source: bool,
    /// Post-publication follow-up of a completed node runs directly in the source
    /// directory (no worktree, no commit, no invalidation of descendants).
    pub source_direct: bool,
    pub expected_source_head: String,
    pub environment_input: Option<crate::environment::CompositeResult>,
    pub environment_sources: Vec<crate::environment::CompositeResult>,
    pub environment_previous: Option<crate::environment::CompositeResult>,
    pub previous_environment_launch: Option<String>,
    pub preserve_failed_environment: bool,
    /// Resume the existing Pi session through its public continuation boundary
    /// rather than sending the original task again.
    pub continuation: bool,
    /// The previous attempt never persisted a Pi conversation (an explicitly
    /// paused preparation, or a startup failure before Pi created its session).
    /// Send the initial task, but retain the selected workspace and session slot.
    pub initial_recovery: bool,
}

pub(crate) struct PlannerWorkspaceResolution {
    pub execution: Execution,
    pub redirected_from: Option<String>,
}

pub(crate) struct ResultJob {
    run_id: String,
    root: PathBuf,
    config: Config,
    descriptor: crate::environment::ResultDescriptor,
    input: crate::environment::CompositeResult,
    args: Vec<String>,
    retry: bool,
}


/// Test builds alone support actuator selection.
#[cfg(feature = "fixture")]
fn known_engine(engine: &str) -> bool {
    #[cfg(feature = "fixture")]
    if engine == crate::fixture::ENGINE {
        return true;
    }
    engine == "pi"
}

pub(crate) fn resolve_repository(root: &Path, config: &Config) -> Result<PathBuf, String> {
    #[cfg(feature = "fixture")]
    if config.engine == crate::fixture::ENGINE {
        return crate::fixture::repository(root);
    }
    let _ = root;
    let repository = PathBuf::from(&config.repository);
    workspace::validate_binding(&repository)?;
    Ok(repository)
}

/// Collect (or reuse) the lazily created source snapshot for a plain-directory
/// job. `fresh` is true when this Run has no recorded snapshot yet: the current
/// source files are force-collected then. Git work runs without the runtime
/// lock; production callers serialize it with the per-source lock.
pub(crate) fn collect_source_snapshot(
    repository: &Path,
    exclusions: &[String],
    fresh: bool,
) -> Result<String, String> {
    if fresh {
        return workspace::materialize_shadow_repo(repository, exclusions);
    }
    let shadow = workspace::shadow_repo_if_exists(repository)?
        .ok_or_else(|| "临时 Git 快照不存在或已回收；请重新派发节点或开启新对话。".to_string())?;
    let git_dir = shadow.to_str().ok_or("Invalid shadow path")?;
    workspace::git(repository, &["--git-dir", git_dir, "rev-parse", "HEAD"])
}

pub struct Runtime {
    pub store: Store,
    pub state: Snapshot,
    // Changes whenever the in-memory snapshot changes. The epoch prevents a
    // client from reusing a version after a backend restart.
    epoch: Uuid,
    revision: u64,
    pub root: PathBuf,
    _lock: Arc<RuntimeLock>,
}

impl Runtime {
    pub fn open(root: &Path) -> Result<Self, String> {
        Self::open_with(root, true)
    }

    /// Dev-mode variant: open the store without replaying the selected Run.
    /// Long transcript logs are loaded on demand by `open_run` when a run is
    /// actually viewed, so restarting the dev backend does not pay for history
    /// that the browser is not going to display.
    pub fn open_lazy(root: &Path) -> Result<Self, String> {
        Self::open_with(root, false)
    }

    fn open_with(root: &Path, load_selected: bool) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|error| error.to_string())?;
        let lock = Arc::new(acquire(root)?);
        let store = Store::open(&root.join("events.sqlite"))?;
        #[allow(unused_mut)]
        let mut state = if load_selected {
            if let Some(run) = store.selected_run()? {
                store.load(&run)?
            } else {
                Snapshot::default()
            }
        } else {
            Snapshot::default()
        };
        // Production serde discards legacy engine fields automatically.
        #[cfg(feature = "fixture")]
        if let Some(config) = state.config.as_mut() {
            if !known_engine(&config.engine) {
                config.engine = "pi".into();
            }
        }
        let mut runtime = Self {
            store,
            state,
            epoch: Uuid::new_v4(),
            revision: 0,
            root: root.into(),
            _lock: lock,
        };
        let interrupted: Vec<_> = runtime
            .state
            .executions
            .iter()
            .filter(|execution| execution.status == "running")
            .cloned()
            .collect();
        for execution in interrupted {
            runtime.emit(EventKind::Failed { node: execution.node, execution_id: Some(execution.id), output_bytes: 0, metrics: None, error: "Application stopped during this execution. Its result is not trusted; inspect and rerun with a fresh Execution Instance.".into() })?;
        }
        runtime.recover_publication()?;
        if runtime.state.approved
            && !matches!(
                runtime.state.phase.as_str(),
                "completed" | "needs_attention" | "publication_failed" | "paused"
            )
        {
            runtime.emit(EventKind::Paused { paused: true })?;
        }
        Ok(runtime)
    }

    /// A run-scoped runtime has its own projection and scheduler but shares the
    /// database and the single-process data-directory lease with its parent.
    pub fn open_run(&self, run_id: &str) -> Result<Self, String> {
        self.run_opener()(run_id)
    }

    /// Capture only the immutable path/lease, not the parent's projection lock.
    /// HTTP routing can replay another Run after releasing the primary mutex.
    pub(crate) fn run_opener(&self) -> impl FnOnce(&str) -> Result<Self, String> + Send + 'static {
        let root = self.root.clone();
        let lock = self._lock.clone();
        move |run_id| Self::open_run_with_lease(root, lock, run_id)
    }

    fn open_run_with_lease(root: PathBuf, lock: Arc<RuntimeLock>, run_id: &str) -> Result<Self, String> {
        let store = Store::open(&root.join("events.sqlite"))?;
        #[allow(unused_mut)]
        let mut state = if run_id.is_empty() {
            Snapshot::default()
        } else {
            store.load(run_id)?
        };
        #[cfg(feature = "fixture")]
        if let Some(config) = state.config.as_mut() {
            if !known_engine(&config.engine) {
                config.engine = "pi".into();
            }
        }
        let mut runtime = Self {
            store,
            state,
            epoch: Uuid::new_v4(),
            revision: 0,
            root,
            _lock: lock,
        };
        let interrupted: Vec<_> = runtime
            .state
            .executions
            .iter()
            .filter(|execution| execution.status == "running")
            .cloned()
            .collect();
        for execution in interrupted {
            runtime.emit(EventKind::Failed {
                node: execution.node,
                execution_id: Some(execution.id),
                error: "Application stopped during this execution. Inspect and rerun.".into(),
                output_bytes: 0,
                metrics: None,
            })?;
        }
        runtime.recover_publication()?;
        if runtime.state.approved
            && !matches!(
                runtime.state.phase.as_str(),
                "completed" | "needs_attention" | "publication_failed" | "paused"
            )
        {
            runtime.emit(EventKind::Paused { paused: true })?;
        }
        Ok(runtime)
    }

    /// Defaults for future runs are deliberately separate from the event projection.
    pub fn save_default_config(&self, config: &Config) -> Result<(), String> {
        let mut defaults = config.clone();
        defaults.environment = None;
        let bytes = serde_json::to_vec_pretty(&defaults).map_err(|e| e.to_string())?;
        fs::write(self.root.join("config.json"), bytes).map_err(|e| e.to_string())
    }

    pub fn snapshot_version(&self) -> String {
        format!("{}:{}", self.epoch, self.revision)
    }

    pub fn touch(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        crate::server::notify_snapshot_changed(&self.state.run_id, &self.snapshot_version());
    }

    fn execution_bytes(&self, execution_id: &str) -> usize {
        self.state
            .executions
            .iter()
            .chain(&self.state.mergers)
            .find(|e| e.id == execution_id)
            .map(|e| e.output.len().max(e.output_bytes))
            .unwrap_or(0)
    }

    pub fn emit(&mut self, mut kind: EventKind) -> Result<(), String> {
        if let EventKind::Prepared { execution_id, .. } = &kind {
            if self
                .state
                .config
                .as_ref()
                .and_then(|c| c.environment.as_ref())
                .is_some()
                && self.state.executions.iter().any(|e| e.id == *execution_id)
            {
                let input = self
                    .environments()?
                    .ok_or("Missing environment store")?
                    .load_record_metadata(execution_id, "before")?;
                if self
                    .state
                    .environment_baseline
                    .as_ref()
                    .is_none_or(|baseline| baseline.domain != input.domain)
                {
                    return Err(
                        "Prepared composite evidence differs from the frozen native domain".into(),
                    );
                }
                return self.emit_outputs(vec![
                    kind.clone(),
                    EventKind::ExecutionInputRecorded {
                        execution_id: execution_id.clone(),
                        input,
                    },
                ]);
            }
        }
        if let EventKind::PublicationCompleted { head } = &kind {
            if let Some(descriptor) = self.publication_descriptor(head)? {
                return self.emit_outputs(vec![EventKind::ResultPublished { descriptor }, kind]);
            }
        }
        crate::cleanup::remember_event(&self.root, &self.store, &self.state, &kind)?;
        if let EventKind::MergerFailed {
            execution_id,
            error,
            ..
        } = &kind
        {
            self.store
                .ensure_legacy_logs(&self.state.run_id, execution_id)?;
            self.store.append(
                &mut self.state,
                EventKind::Output {
                    execution_id: execution_id.clone(),
                    text: format!("\nMerger failed: {error}\n"),
                },
            )?;
        }
        let terminal = match &mut kind {
            EventKind::Failed {
                execution_id: Some(id),
                output_bytes,
                metrics,
                ..
            }
            | EventKind::MergerFinished {
                execution_id: id,
                output_bytes,
                metrics,
                ..
            }
            | EventKind::MergerFailed {
                execution_id: id,
                output_bytes,
                metrics,
                ..
            } => Some((id, output_bytes, metrics)),
            _ => None,
        };
        if let Some((id, output_bytes, metrics)) = terminal {
            *output_bytes = self.store.ensure_legacy_logs(&self.state.run_id, id)?;
            if let Some(execution) = self
                .state
                .executions
                .iter()
                .chain(&self.state.mergers)
                .find(|e| e.id == *id)
            {
                *output_bytes = (*output_bytes)
                    .max(execution.output_bytes)
                    .max(execution.output.len());
                if metrics.is_none() {
                    // Restart recovery has metadata but no live buffer. Parse
                    // its committed logs once here, not during snapshot load.
                    let recovered;
                    let text = if execution.output.len() != *output_bytes {
                        recovered = self
                            .store
                            .execution_log_page(&self.state.run_id, id, 0, usize::MAX)?
                            .content;
                        &recovered
                    } else {
                        &execution.output
                    };
                    *metrics = Some(parse_execution_metrics(text, execution.started_at, now()));
                }
            }
        }
        let output_target = match &kind {
            EventKind::Output { execution_id, .. } => {
                Some((execution_id.clone(), self.execution_bytes(execution_id)))
            }
            _ => None,
        };
        let terminal_target = match &kind {
            EventKind::Finished { execution_id, .. }
            | EventKind::Failed {
                execution_id: Some(execution_id),
                ..
            }
            | EventKind::MergerFinished { execution_id, .. }
            | EventKind::MergerFailed { execution_id, .. } => Some(execution_id.clone()),
            _ => None,
        };
        self.store.append(&mut self.state, kind)?;
        if let Some((execution_id, before_bytes)) = output_target {
            let after_bytes = self.execution_bytes(&execution_id);
            if before_bytes == 0 && after_bytes > 0 {
                self.touch();
            } else {
                self.revision = self.revision.wrapping_add(1);
            }
            crate::server::notify_output_available(
                &self.state.run_id,
                &execution_id,
                after_bytes,
                false,
            );
        } else {
            self.touch();
            if let Some(execution_id) = terminal_target {
                let after_bytes = self.execution_bytes(&execution_id);
                crate::server::notify_output_available(
                    &self.state.run_id,
                    &execution_id,
                    after_bytes,
                    true,
                );
            }
        }
        Ok(())
    }

    pub fn emit_outputs(&mut self, events: Vec<EventKind>) -> Result<(), String> {
        if events.is_empty() {
            return Ok(());
        }
        // Batched creation/admission must preserve the same physical ownership
        // and adopted-source receipts as single-event emit before persistence.
        for kind in &events {
            crate::cleanup::remember_event(&self.root, &self.store, &self.state, kind)?;
        }
        let mut has_non_output = false;
        let mut targets: std::collections::BTreeMap<String, (usize, bool)> =
            std::collections::BTreeMap::new();
        for kind in &events {
            match kind {
                EventKind::Output { execution_id, .. } => {
                    let before = self.execution_bytes(execution_id);
                    targets.entry(execution_id.clone()).or_insert((before, false));
                }
                EventKind::Finished { execution_id, .. }
                | EventKind::Failed {
                    execution_id: Some(execution_id),
                    ..
                }
                | EventKind::MergerFinished { execution_id, .. }
                | EventKind::MergerFailed { execution_id, .. } => {
                    has_non_output = true;
                    let before = self.execution_bytes(execution_id);
                    targets
                        .entry(execution_id.clone())
                        .or_insert((before, false))
                        .1 = true;
                }
                _ => {
                    has_non_output = true;
                }
            }
        }
        self.store.append_batch(&mut self.state, events)?;
        let mut crossed_zero = false;
        let mut notifications = Vec::with_capacity(targets.len());
        for (execution_id, (before_bytes, settled)) in targets {
            let after_bytes = self.execution_bytes(&execution_id);
            if before_bytes == 0 && after_bytes > 0 {
                crossed_zero = true;
            }
            notifications.push((execution_id, after_bytes, settled));
        }
        if has_non_output || crossed_zero {
            self.touch();
        } else {
            self.revision = self.revision.wrapping_add(1);
        }
        for (execution_id, after_bytes, settled) in notifications {
            crate::server::notify_output_available(
                &self.state.run_id,
                &execution_id,
                after_bytes,
                settled,
            );
        }
        Ok(())
    }

    fn recover_publication(&mut self) -> Result<(), String> {
        if self.state.review_graph.is_some() {
            if let Some(mut planning) = self.state.planning.clone() {
                planning.status = Some("failed".into());
                planning.error = Some("Backend stopped during post-task Planner review. Saved output is preserved; send a follow-up to continue.".into());
                let approval_required = self.state.nodes.values().any(|node| node.status != "completed");
                self.emit(EventKind::PlannerReviewFinished { planning, approval_required })?;
            }
        }
        if let Some(execution) = self
            .state
            .result_execution
            .as_ref()
            .filter(|e| e.status == "running")
        {
            self.emit(EventKind::ResultExecutionFailed { generation: execution.input.generation.clone(), error: "Native result execution was interrupted; partial workspace retained for explicit retry".into() })?;
        }
        let interrupted: Vec<String> = self
            .state
            .mergers
            .iter()
            .filter(|e| e.status == "running")
            .map(|e| e.id.clone())
            .collect();
        for execution_id in interrupted {
            let publication_merge = self
                .state
                .mergers
                .iter()
                .any(|e| e.id == execution_id && e.node == "merger");
            self.emit(EventKind::MergerFailed {
                execution_id,
                output_bytes: 0,
                metrics: None,
                error: if publication_merge {
                    "Merger interrupted; inspect the merge and retry publication."
                } else {
                    "Merger interrupted; inspect the node worktree and rerun or resolve it."
                }
                .into(),
            })?;
        }
        if matches!(self.state.phase.as_str(), "publishing" | "merging") {
            self.emit(EventKind::PublicationFailed { error: "Publication interrupted. Results and any pending merge are preserved; retry publication to verify and continue.".into() })?;
        }
        Ok(())
    }

    pub fn retry_publication(&mut self) -> Result<(), String> {
        self.require_current_file_contract()?;
        if self.state.phase != "publication_failed" {
            return Err("Only failed publication can be retried".into());
        }
        let publication = self
            .state
            .publication
            .clone()
            .ok_or("No publication to retry")?;
        // A failed attempt over terminal heads that a completed publication
        // already merged cannot add anything, and the published snapshot's Git
        // objects may be reclaimed, so retrying would fail forever. Resolve the
        // attempt as completed at the already-published head: this restores the
        // completed phase and marks the publication record successful without
        // touching reclaimed Git state.
        if let Some(published_head) = self.state.published_head.clone() {
            if Self::same_published_heads(&self.state.published_heads, &publication.heads) {
                return self
                    .emit_outputs(vec![EventKind::PublicationCompleted { head: published_head }]);
            }
        }
        workspace::validate_binding(Path::new(&publication.repository))?;
        self.emit(EventKind::PublicationStarted {
            repository: publication.repository,
            heads: publication.heads,
        })
    }

    pub fn active(&self) -> bool {
        matches!(
            self.state.phase.as_str(),
            "publishing" | "merging" | "launching_result"
        ) || self
            .state
            .result_execution
            .as_ref()
            .is_some_and(|e| e.status == "running")
            || self
                .state
                .nodes
                .values()
                .any(|node| node.status == "running")
            || self
                .state
                .mergers
                .iter()
                .any(|merger| merger.status == "running")
    }

    /// Keep sessions for follow-ups, but persist workspace cleanup before any
    /// removal. Failed cleanup is retried without relying on a source binding.
    pub fn cleanup_worktrees(&self) -> Result<(), String> {
        if self.state.run_id.is_empty() {
            return Ok(());
        }
        // Managed launchable results retain their fixed layout, resources and
        // immutable evidence until explicit conversation deletion.
        if self
            .state
            .config
            .as_ref()
            .and_then(|c| c.environment.as_ref())
            .is_some()
        {
            return Ok(());
        }
        let mut targets = self.store.owned_cleanup_targets(&self.state.run_id)?;
        targets.retain(|target| matches!(target, crate::cleanup::Target::Workspace { .. }));
        // Queue before collecting/validating filesystem metadata. A temporarily
        // unreadable legacy marker or linked root must not lose the retry.
        let manifest = crate::cleanup::Manifest {
            targets,
            sequence: Some(self.state.events.last().map_or(0, |event| event.sequence)),
            ..Default::default()
        };
        self.store.enqueue_cleanup(&self.state.run_id, &manifest)?;
        self.retry_cleanup(&self.state.run_id)
    }

    pub fn retry_cleanup(&self, run_id: &str) -> Result<(), String> {
        if let Some(task) = self.store.cleanup_task(run_id)? {
            crate::cleanup::attempt(&self.root, &self.store, &task)?;
        }
        Ok(())
    }

    /// Whether a successful publication may reclaim the plain-directory shadow
    /// snapshot. Read-only; callers should release the runtime lock before the
    /// actual removal.
    pub(crate) fn shadow_reclaimable_after_publication(
        &self,
        repository: &Path,
    ) -> Result<bool, String> {
        if workspace::is_standard_git(repository) {
            return Ok(false);
        }
        if workspace::shadow_repo_if_exists(repository)?.is_none() {
            return Ok(false);
        }
        Ok(!self
            .store
            .shadow_repo_needed_by_other_run(&self.state.run_id, repository)?)
    }

    /// Reclaim the published source's shadow snapshot. Only a successful
    /// publication or an explicit Run deletion may release it; failed,
    /// interrupted and paused Runs keep their snapshot for retry/evidence.
    pub fn reclaim_shadow_after_publication(&self, repository: &Path) -> Result<(), String> {
        if self.shadow_reclaimable_after_publication(repository)? {
            workspace::remove_shadow_repo(repository)?;
        }
        Ok(())
    }

    /// A plain-directory Run has no source snapshot until its first node
    /// dispatch. A pre-existing shared snapshot is still re-collected so
    /// Planner writes made after another Run's snapshot are included.
    pub(crate) fn job_source_is_fresh(&self, repository: &Path) -> Result<bool, String> {
        Ok(self.latest_source_head().is_empty()
            || workspace::shadow_repo_if_exists(repository)?.is_none())
    }

    /// Record ownership, the one-time `SourceSnapshotted` event and the
    /// resolved base on the Job. Must be called after the (lock-free) Git
    /// collection; it only needs a short runtime lock.
    pub(crate) fn record_job_source(
        &mut self,
        job: &mut Job,
        repository: &Path,
        head: &str,
    ) -> Result<(), String> {
        let name = workspace::shadow_repo_dir(repository)?
            .file_name()
            .ok_or("Invalid shadow directory")?
            .to_string_lossy()
            .into_owned();
        self.store.remember_cleanup_targets(
            &job.run_id,
            &BTreeSet::from([crate::cleanup::Target::Shadow {
                root: workspace::data_root(),
                name,
            }]),
        )?;
        if head != self.latest_source_head() {
            self.emit(EventKind::SourceSnapshotted {
                head: head.to_string(),
            })?;
        }
        job.expected_source_head = head.to_string();
        job.execution.before = head.to_string();
        Ok(())
    }

    /// Convenience entry for tests: collect and record in one step.
    #[cfg(test)]
    pub(crate) fn attach_job_source(
        &mut self,
        job: &mut Job,
        exclusions: &[String],
    ) -> Result<String, String> {
        let repository = resolve_repository(&self.root, &job.config)?;
        let fresh = self.job_source_is_fresh(&repository)?;
        let head = collect_source_snapshot(&repository, exclusions, fresh)?;
        self.record_job_source(job, &repository, &head)?;
        Ok(head)
    }

    /// Safe without another Run's runtime mutex: deleted IDs cannot be reused,
    /// and stale writers are rejected by the store's deletion tombstones.
    pub fn retry_deleted_cleanups(&self) -> Result<(), String> {
        for task in self.store.pending_cleanups()? {
            if task.manifest.sequence.is_none() {
                if let Err(error) = crate::cleanup::attempt(&self.root, &self.store, &task) {
                    eprintln!("[Grapher] Pending cleanup {}: {error}", task.run_id);
                }
            }
        }
        Ok(())
    }

    pub fn reset_workspace(&mut self) -> Result<Snapshot, String> {
        if self.active() {
            return Err("Pause and wait for the current executions to finish first".into());
        }
        self.cleanup_worktrees()?;
        self.store.select_run(None)?;
        let current_config = self.state.config.clone();
        self.state = Snapshot {
            config: current_config,
            ..Snapshot::default()
        };
        self.touch();
        Ok(self.state.clone())
    }

    pub fn clear_history(&mut self) -> Result<(), String> {
        if self.active() {
            return Err("Pause and wait for the current executions to finish first".into());
        }
        let mut cleanups = Vec::new();
        for run_id in self.store.runs()? {
            let stored;
            let state = if run_id == self.state.run_id {
                &self.state
            } else {
                stored = self.store.load(&run_id)?;
                &stored
            };
            if matches!(state.phase.as_str(), "planning" | "publishing" | "merging")
                || state.nodes.values().any(|node| node.status == "running")
            {
                return Err("Cannot clear history while another Run is active; reopen interrupted Runs first".into());
            }
            cleanups.push((
                run_id,
                crate::cleanup::manifest(&self.root, &self.store, state, true)?,
            ));
        }
        // Validate every directory first, then atomically transfer ownership to
        // the cleanup queue with deletion. Filesystem failure cannot orphan it.
        self.store.clear_with_cleanup(&cleanups)?;
        let current_config = self.state.config.clone();
        self.state = Snapshot {
            config: current_config,
            ..Snapshot::default()
        };
        self.touch();
        if let Err(error) = self.retry_deleted_cleanups() {
            eprintln!("[Grapher] History cleared; filesystem cleanup remains queued: {error}");
        }
        Ok(())
    }

    pub fn delete_run(&mut self, run_id: &str) -> Result<(), String> {
        self.delete_runs(&[run_id.to_owned()])
    }

    pub fn delete_runs(&mut self, run_ids: &[String]) -> Result<(), String> {
        let mut cleanups = Vec::new();
        for run_id in run_ids {
            let stored;
            let target = if self.state.run_id == *run_id {
                &self.state
            } else {
                stored = self.store.load(run_id)?;
                &stored
            };
            if matches!(target.phase.as_str(), "planning" | "publishing" | "merging" | "launching_result")
                || target.nodes.values().any(|node| node.status == "running")
                || target.mergers.iter().any(|merger| merger.status == "running")
                || target.result_execution.as_ref().is_some_and(|result| result.status == "running")
            {
                return Err("Cannot delete a running execution".into());
            }
            cleanups.push((run_id.clone(), crate::cleanup::manifest(&self.root, &self.store, target, true)?));
        }
        // Validate the whole batch before either SQL deletion or filesystem I/O.
        self.store.delete_runs_with_cleanup(&cleanups)?;
        self.forget_deleted_runs(run_ids);
        // Logical deletion has committed. Filesystem failures remain retryable
        // without making the browser retain a conversation that no longer exists.
        for run_id in run_ids {
            if let Err(error) = self.retry_cleanup(run_id) {
                eprintln!("[Grapher] Run {run_id} deleted; filesystem cleanup remains queued: {error}");
            }
        }
        Ok(())
    }

    pub(crate) fn forget_deleted_runs(&mut self, run_ids: &[String]) {
        if run_ids.contains(&self.state.run_id) {
            self.state = Snapshot { config: self.state.config.clone(), ..Snapshot::default() };
            self.touch();
        }
    }

    pub fn load_run(&mut self, run_id: &str) -> Result<Snapshot, String> {
        if self.active() {
            return Err("Pause and wait for the current executions to finish first".into());
        }
        #[allow(unused_mut)]
        let mut state = self.store.load(run_id)?;
        #[cfg(feature = "fixture")]
        if let Some(config) = state.config.as_mut() {
            if !known_engine(&config.engine) {
                config.engine = "pi".into();
            }
        }
        let interrupted: Vec<_> = state
            .executions
            .iter()
            .filter(|execution| execution.status == "running")
            .cloned()
            .collect();
        self.store.select_run(Some(run_id))?;
        self.state = state;
        self.touch();
        for execution in interrupted {
            self.emit(EventKind::Failed {
                node: execution.node,
                execution_id: Some(execution.id),
                error: "Execution was interrupted. Inspect and rerun.".into(),
                output_bytes: 0,
                metrics: None,
            })?;
        }
        self.recover_publication()?;
        Ok(self.state.clone())
    }

    pub fn create(&mut self, graph: Graph, config: Config) -> Result<(), String> {
        self.create_with_planning(graph, config, None, None)
    }

    pub fn create_with_planning(
        &mut self,
        graph: Graph,
        config: Config,
        planning_id: Option<String>,
        planning: Option<crate::model::PlanningSummary>,
    ) -> Result<(), String> {
        if self.active() {
            return Err("Pause and wait for the current executions to finish first".into());
        }
        compile(&graph, true)
            .map_err(|errors| serde_json::to_string(&errors).unwrap_or_default())?;
        #[cfg(feature = "fixture")]
        if !known_engine(&config.engine) {
            return Err("Unknown test actuator".into());
        }
        let mut config = config;
        config.max_feedback = config.max_feedback.min(3);
        // max_parallel = 0 uses the default node worker limit.
        #[cfg(feature = "fixture")]
        if config.engine == "pi" && config.pi_command.trim().is_empty() {
            return Err("Test process command is required".into());
        }
        let completing_planning = self.state.phase == "planning"
            && planning_id.is_some()
            && self.state.planning_id == planning_id;
        if !completing_planning {
            let run_id = if self.state.events.is_empty() && !self.state.run_id.is_empty() {
                self.state.run_id.clone()
            } else {
                Uuid::new_v4().to_string()
            };
            self.state = Snapshot {
                run_id,
                ..Snapshot::default()
            };
            self.touch();
        }
        // Production workspace admission is resolved by Rust after planning;
        // it is not a frontend environment choice.
        let automatic = config.environment.is_none() && !cfg!(feature = "fixture");
        let mut events = vec![EventKind::Created {
            graph,
            config,
            planning_id,
            planning,
        }];
        if automatic {
            events.push(EventKind::EnvironmentPolicyRequested);
        }
        self.emit_outputs(events)?;
        self.store.select_run(Some(&self.state.run_id))
    }

    pub fn set_route(&mut self, plan_type: &str) -> Result<(), String> {
        if self.state.phase != "awaiting_approval"
            || !matches!(plan_type, "serial" | "graph")
            || (plan_type == "serial"
                && !(self.state.graph.nodes.len() == 1 && self.state.graph.nodes[0].name == "task"))
        {
            return Err("Invalid execution route or routing phase".into());
        }
        #[cfg(not(feature = "fixture"))]
        if plan_type == "graph" {
            crate::native::require_graph_execution()?;
        }
        self.emit(EventKind::Routed {
            plan_type: plan_type.into(),
        })
    }

    fn is_serial(&self) -> bool {
        match self.state.plan_type.as_deref() {
            Some(mode) => mode == "serial",
            None => self.state.graph.nodes.len() == 1 && self.state.graph.nodes[0].name == "task",
        }
    }

    fn uses_legacy_file_channel(&self) -> bool {
        self.state.source_files.is_some()
            || self.state.nodes.values().any(|node| {
                node.legacy_files_override.is_some()
                    || node.legacy_files_version.is_some()
                    || node.legacy_baseline_files_version.is_some()
                    || node.legacy_files_changed
                    || node.result.as_ref().is_some_and(|result| !result.resource_refs.is_empty())
            })
            || self.state.executions.iter().any(|execution| {
                execution.input.as_ref().is_some_and(|result| !result.resource_refs.is_empty())
                    || execution.result.as_ref().is_some_and(|result| !result.resource_refs.is_empty())
            })
            || self.state.published_result.as_ref().is_some_and(|descriptor| {
                !descriptor.result.resource_refs.is_empty()
            })
            || self.state.events.iter().any(|event| match &event.kind {
                EventKind::SourceFilesRecorded { .. } | EventKind::WorkspaceFilesChanged { .. } => true,
                EventKind::WorkspaceResolved { files_version, .. } => files_version.is_some(),
                _ => false,
            })
    }

    fn legacy_file_channel_error(&self) -> String {
        "This saved workspace uses legacy ignored-file snapshots and is read-only; use the current workspace Git inheritance contract".into()
    }

    fn require_current_file_contract(&self) -> Result<(), String> {
        if self.uses_legacy_file_channel() {
            Err(self.legacy_file_channel_error())
        } else {
            Ok(())
        }
    }

    /// Approval stays immutable; later Planner writes/publications advance the
    /// inputs of future jobs without replacing an in-flight node's workspace.
    pub(crate) fn latest_source_head(&self) -> &str {
        self.state
            .events
            .iter()
            .rev()
            .find_map(|event| match &event.kind {
                EventKind::GraphRevised {
                    source_head: Some(head),
                    ..
                }
                | EventKind::SourceSnapshotted { head }
                | EventKind::PublicationCompleted { head } => Some(head.as_str()),
                EventKind::Approved { base } => Some(base.as_str()),
                _ => None,
            })
            .unwrap_or_else(|| {
                self.state
                    .published_head
                    .as_deref()
                    .unwrap_or(&self.state.base)
            })
    }

    pub(crate) fn exclusions(&self) -> Result<Vec<String>, String> {
        let Some(store) = self.environments()? else {
            return Ok(Vec::new());
        };
        let mut paths = self
            .state
            .config
            .as_ref()
            .and_then(|c| c.environment.as_ref())
            .map(|e| e.exclusions())
            .unwrap_or_default();
        let refs = self
            .state
            .executions
            .iter()
            .flat_map(|execution| [execution.input.as_ref(), execution.result.as_ref()])
            .flatten()
            .chain(
                self.state
                    .nodes
                    .values()
                    .filter_map(|node| node.result.as_ref()),
            )
            .chain(
                self.state
                    .published_result
                    .as_ref()
                    .map(|descriptor| &descriptor.result),
            );
        for input in refs {
            paths.extend(store.exclusions(&input.launch_ref)?);
        }
        paths.sort();
        paths.dedup();
        Ok(paths)
    }

    fn environments(&self) -> Result<Option<crate::environment::Environments>, String> {
        self.state
            .config
            .as_ref()
            .and_then(|c| c.environment.as_ref())
            .map(|config| {
                crate::environment::Environments::new(&self.root, &self.state.run_id, config)
            })
            .transpose()
    }

    /// Called while the planning gate prevents dispatch/publication. The
    /// newest recorded workspace is always selected, even when its node/Merger
    /// writer is still active: a follow-up must start immediately instead of
    /// waiting or falling back to an older/source directory. Allocation names
    /// aren't ownership: linear handoff reuses directories.
    pub(crate) fn planner_workspace(&self) -> Result<Option<Execution>, String> {
        let root = PathBuf::from(workspace::normalize_workspace_display_path(&self.run_workspace_root()));
        // Retained published slots can be older than subsequent source edits.
        // Only work recorded since publication can supersede the source cwd.
        let unpublished: BTreeSet<_> = self.state.events.iter().rev()
            .take_while(|event| !matches!(event.kind, EventKind::PublicationCompleted { .. }))
            .filter_map(|event| match &event.kind {
                EventKind::Started { execution, .. } => Some(execution.id.as_str()),
                EventKind::Prepared { execution_id, .. } | EventKind::Finished { execution_id, .. }
                | EventKind::PlannerWorkspaceSnapshotted { execution_id, .. } => Some(execution_id.as_str()),
                _ => None,
            }).collect();

        // A Planner may explicitly ask to move to another existing node
        // workspace. Keep that choice for another follow-up when no newer node
        // execution has produced a workspace. This is important because the
        // Planner's current cwd is conversation state too: reselecting the
        // globally newest execution on every message would undo the explicit
        // move even when the graph has not changed.
        if let Some(current_id) = self.state.planning.as_ref().and_then(|planning| planning.workspace_execution_id.as_deref()) {
            let current_index = self.state.executions.iter().position(|execution| execution.id == current_id);
            let selection_sequence = self.state.events.iter().rev().find_map(|event| {
                matches!(&event.kind, EventKind::PlannerWorkspaceSelected { planning }
                    if planning.workspace_execution_id.as_deref() == Some(current_id))
                    .then_some(event.sequence)
            });
            let newer_workspace = if let Some(sequence) = selection_sequence {
                self.state.events.iter().filter(|event| event.sequence > sequence).any(|event| {
                    let execution_id = match &event.kind {
                        EventKind::Started { execution, .. } => Some(execution.id.as_str()),
                        EventKind::Prepared { execution_id, .. }
                        | EventKind::Finished { execution_id, .. }
                        | EventKind::PlannerWorkspaceSnapshotted { execution_id, .. }
                        | EventKind::WorkspaceResolved { execution_id, .. } => Some(execution_id.as_str()),
                        EventKind::Failed { execution_id: Some(execution_id), .. } => Some(execution_id.as_str()),
                        _ => None,
                    };
                    execution_id.is_some_and(|execution_id| execution_id != current_id)
                })
            } else {
                current_index.is_some_and(|index| self.state.executions.iter().skip(index + 1).any(|execution|
                    !self.state.superseded_execution_ids.contains(&execution.id)
                        && self.state.nodes.contains_key(&execution.node)))
            };
            let current_is_new = self.state.published_head.is_none() || unpublished.contains(current_id);
            if current_index.is_some() && !newer_workspace && current_is_new {
                if let Some(current) = self.state.executions.iter().find(|execution| execution.id == current_id) {
                    let path = Path::new(&current.worktree);
                    if self.path_is_running(path) {
                        return Ok(Some(current.clone()));
                    }
                    if path.is_dir() {
                        if self.state.config.as_ref().is_some_and(|config|
                            path.canonicalize().ok().zip(Path::new(&config.repository).canonicalize().ok())
                                .is_some_and(|(path, source)| path == source)) {
                            return Ok(Some(current.clone()));
                        }
                        if let Some(actual) = crate::path_safety::real_child_path(&root, path, false)? {
                            if actual.join(".git").is_dir() {
                                let mut selected = current.clone();
                                selected.worktree = workspace::normalize_workspace_display_path(&actual);
                                return Ok(Some(selected));
                            }
                        }
                    }
                }
            }
        }

        let mut seen = BTreeSet::new();
        let mut reserved = false;
        for execution in self.state.executions.iter().rev() {
            if self.state.superseded_execution_ids.contains(&execution.id)
                || !self.state.nodes.contains_key(&execution.node)
                || (self.state.published_head.is_some() && !unpublished.contains(execution.id.as_str()))
                || !seen.insert(execution.worktree.clone()) {
                continue;
            }
            let path = Path::new(&execution.worktree);
            // Even an active frontier is the latest workspace. Planner starts
            // directly in it; the writer snapshots the shared directory later.
            if self.path_is_running(path) { return Ok(Some(execution.clone())); }
            // Published-node follow-ups can use source directly, outside the
            // private Run root. Once their writer drains, Planner uses source too.
            if self.state.published_head.is_some() && self.state.config.as_ref().is_some_and(|config|
                path.canonicalize().ok().zip(Path::new(&config.repository).canonicalize().ok())
                    .is_some_and(|(path, source)| path == source)) {
                return Ok(None);
            }
            // Do not retreat to an ancestor just because its current child is
            // reserved. Another parallel frontier is valid; a stale ancestor isn't.
            let descendants = downstream(&self.state.graph, &execution.node);
            if descendants.iter().any(|name| name != &execution.node
                && self.state.nodes.get(name).is_some_and(|node| matches!(node.status.as_str(), "completed" | "failed" | "running"))
                && self.state.executions.iter().any(|child| child.node == *name
                    && Path::new(&child.worktree).is_dir()
                    && !self.state.superseded_execution_ids.contains(&child.id))) {
                continue;
            }
            if !path.is_dir() {
                if self.state.events.iter().rev()
                    .take_while(|event| !matches!(event.kind, EventKind::PublicationCompleted { .. }))
                    .any(|event| matches!(&event.kind,
                        EventKind::Prepared { execution_id, .. } | EventKind::PlannerWorkspaceSnapshotted { execution_id, .. }
                        if execution_id == &execution.id)) {
                    return Err("Latest Planner workspace is missing; refusing to use stale source files".into());
                }
                continue;
            }
            // Only a recorded, real child of this Run may become a Planner cwd.
            let Some(actual) = crate::path_safety::real_child_path(&root, path, false)? else { continue; };
            if self.workspace_reserved(path, None) {
                reserved = true;
                continue;
            }
            if !actual.join(".git").is_dir() {
                return Err("Latest Planner workspace is not a private Git repository".into());
            }
            let mut selected = execution.clone();
            selected.worktree = workspace::normalize_workspace_display_path(&actual);
            return Ok(Some(selected));
        }
        if reserved { return Err("Current workspaces are reserved for feedback; continue the repair before planning".into()); }
        Ok(None)
    }

    fn same_workspace_path(left: &Path, right: &Path) -> bool {
        crate::path_identity::same_path(left, right)
    }

    fn planner_workspace_owner(&self, target: &Execution) -> Option<&Execution> {
        self.state.executions.iter().rev().find(|execution| {
            !self.state.superseded_execution_ids.contains(&execution.id)
                && Self::same_workspace_path(Path::new(&target.worktree), Path::new(&execution.worktree))
        })
    }

    pub(crate) fn planner_workspace_for_node(&self, node: &str) -> Result<Option<PlannerWorkspaceResolution>, String> {
        let root = PathBuf::from(workspace::normalize_workspace_display_path(&self.run_workspace_root()));
        let unpublished: BTreeSet<_> = self.state.events.iter().rev()
            .take_while(|event| !matches!(event.kind, EventKind::PublicationCompleted { .. }))
            .filter_map(|event| match &event.kind {
                EventKind::Started { execution, .. } => Some(execution.id.as_str()),
                EventKind::Prepared { execution_id, .. } | EventKind::Finished { execution_id, .. }
                | EventKind::PlannerWorkspaceSnapshotted { execution_id, .. } => Some(execution_id.as_str()),
                _ => None,
            }).collect();
        for requested in self.state.executions.iter().rev() {
            if requested.node != node
                || self.state.superseded_execution_ids.contains(&requested.id)
                || (self.state.published_head.is_some() && !unpublished.contains(requested.id.as_str())) {
                continue;
            }
            let owner = self.planner_workspace_owner(requested).unwrap_or(requested);
            if self.state.superseded_execution_ids.contains(&owner.id)
                || !Path::new(&owner.worktree).is_dir() {
                continue;
            }
            let path = Path::new(&owner.worktree);
            let is_source = self.state.config.as_ref().is_some_and(|config|
                path.canonicalize().ok().zip(Path::new(&config.repository).canonicalize().ok())
                    .is_some_and(|(path, source)| path == source));
            let selected = if is_source {
                owner.clone()
            } else {
                let Some(actual) = crate::path_safety::real_child_path(&root, path, false)? else {
                    continue;
                };
                if !actual.join(".git").is_dir() {
                    continue;
                }
                let mut selected = owner.clone();
                selected.worktree = workspace::normalize_workspace_display_path(&actual);
                selected
            };
            return Ok(Some(PlannerWorkspaceResolution {
                redirected_from: (owner.node != node).then(|| node.to_string()),
                execution: selected,
            }));
        }
        Ok(None)
    }

    pub(crate) fn planner_workspace_targets(&self, current_node: Option<&str>) -> Result<serde_json::Value, String> {
        let mut targets = serde_json::Map::new();
        for node in &self.state.graph.nodes {
            if current_node == Some(node.name.as_str()) {
                continue;
            }
            let Some(resolution) = self.planner_workspace_for_node(&node.name)? else { continue; };
            targets.insert(node.name.clone(), serde_json::json!({
                "requestedNode": node.name,
                "actualNode": resolution.execution.node,
                "executionId": resolution.execution.id,
                "workspace": resolution.execution.worktree,
                "redirected": resolution.redirected_from.is_some(),
            }));
        }
        Ok(serde_json::Value::Object(targets))
    }

    pub(crate) fn capture_planner_workspace(&mut self, execution_id: &str) -> Result<(), String> {
        let execution = self.state.executions.iter().find(|e| e.id == execution_id)
            .cloned().ok_or("Planner workspace execution is missing")?;
        let path = Path::new(&execution.worktree);
        if self.path_is_running(path) { return Err("Planner workspace still has an active writer".into()); }
        let root = PathBuf::from(workspace::normalize_workspace_display_path(&self.run_workspace_root()));
        crate::path_safety::real_child_path(&root, path, false)?
            .ok_or("Planner workspace is no longer owned by this Run")?;
        let repository = resolve_repository(&self.root, self.state.config.as_ref().ok_or("Missing config")?)?;
        let expected = execution.after.as_deref().unwrap_or(&execution.before);
        workspace::verify_prepared_ancestor(path, expected)?;
        let head = workspace::snapshot_node_scoped(path, &repository, &execution.node,
            Some(&self.state.run_id), &self.exclusions()?)?;
        if head != expected {
            let invalidated = downstream(&self.state.graph, &execution.node).into_iter()
                .filter(|name| name != &execution.node && !execution.workspace_lineage.contains(name))
                .collect();
            self.emit(EventKind::PlannerWorkspaceSnapshotted { execution_id: execution.id, head, invalidated })?;
        }
        Ok(())
    }

    pub(crate) fn capture_planner_source(&mut self) -> Result<(), String> {
        self.require_current_file_contract()?;
        let repository = resolve_repository(
            &self.root,
            self.state.config.as_ref().ok_or("Missing config")?,
        )?;
        // Plain directories are not materialized until the first node dispatch;
        // a Planner turn before that has no Git snapshot to record.
        if !workspace::is_standard_git(&repository)
            && workspace::shadow_repo_if_exists(&repository)?.is_none()
        {
            return Ok(());
        }
        let head = workspace::snapshot_repository_scoped(&repository, &self.exclusions()?)?;
        if head != self.latest_source_head() {
            self.emit(EventKind::SourceSnapshotted { head })?;
        }
        Ok(())
    }

    pub fn approve(&mut self) -> Result<(), String> {
        self.require_current_file_contract()?;
        if self.state.phase != "awaiting_approval" {
            return Err("Only a compiled, unapproved graph can be approved".into());
        }
        let config = self.state.config.as_ref().ok_or("No graph")?;
        let repository = resolve_repository(&self.root, config)?;
        #[cfg(not(feature = "fixture"))]
        if !self.is_serial() {
            crate::native::require_graph_execution()?;
        }
        if self.state.environment_policy.as_deref() == Some("automatic-pending") {
            let (environment, reason) =
                crate::environment_automatic::resolve(&repository, self.is_serial())?;
            self.emit(EventKind::EnvironmentPolicyResolved {
                environment,
                reason,
            })?;
        }
        let config = self.state.config.as_ref().ok_or("No graph")?;
        if let Some(environment) = &config.environment {
            if self.is_serial() {
                return Err("Managed environments require explicit Graph mode; Planner/Serial keep native source semantics".into());
            }
            if !workspace::is_standard_git(&repository) {
                return Err(
                    "Managed environments currently require a native Git source repository".into(),
                );
            }
            environment.validate()?;
            environment.check_tracked(&repository)?;
        }
        workspace::validate_binding(&repository)?;
        if let Some(store) = self.environments()? {
            if self.state.environment_baseline.is_none() {
                let result = store.initialize(&repository)?;
                self.emit(EventKind::EnvironmentInitialized { result })?;
            }
        }
        // Approval is immutable. Plain directories (and serial on either
        // repository type) have no Git snapshot yet: the lazy snapshot is
        // materialized by the first node worker and recorded as `base` only
        // for a standard Git repository, whose commits stay user-owned.
        let base = if self.is_serial() || !workspace::is_standard_git(&repository) {
            String::new()
        } else {
            workspace::verify(&repository)?;
            workspace::snapshot_repository_scoped(&repository, &self.exclusions()?)?
        };
        self.emit(EventKind::Approved { base })
    }

    pub fn edit_draft_graph(&mut self, graph: Graph, mut config: Config) -> Result<(), String> {
        self.require_current_file_contract()?;
        if self.state.run_id.is_empty()
            || self.state.approved
            || !matches!(self.state.phase.as_str(), "rejected" | "awaiting_approval")
        {
            return Err("Only an unapproved graph draft can be edited in place".into());
        }
        let previous = self.state.config.as_ref().ok_or("Missing config")?;
        if config.repository != previous.repository {
            return Err("Cannot move a draft to another repository".into());
        }
        if self.state.environment_policy.is_some() {
            if config.environment.is_some() && config.environment != previous.environment {
                return Err("Environment policy is Runtime-owned; draft edits cannot select or override an environment".into());
            }
            config.environment = previous.environment.clone();
        }
        if config.environment != previous.environment && self.state.environment_baseline.is_some() {
            return Err(
                "Environment domain is already initialized for this workspace execution".into(),
            );
        }
        resolve_repository(&self.root, &config)?;
        compile(&graph, true)
            .map_err(|errors| serde_json::to_string(&errors).unwrap_or_default())?;
        #[cfg(feature = "fixture")]
        if !known_engine(&config.engine) {
            return Err("Unknown test actuator".into());
        }
        config.max_feedback = config.max_feedback.min(3);
        // max_parallel = 0 uses the default node worker limit.
        #[cfg(not(feature = "fixture"))]
        crate::native::require_graph_execution()?;
        self.emit(EventKind::DraftEdited { graph, config })
    }

    pub fn update_draft_graph(
        &mut self,
        graph: Graph,
        planning_id: String,
        planning: PlanningSummary,
    ) -> Result<(), String> {
        self.require_current_file_contract()?;
        if self.state.approved {
            return self.revise_graph(graph, planning);
        }
        resolve_repository(
            &self.root,
            self.state.config.as_ref().ok_or("Missing config")?,
        )?;
        compile(&graph, true)
            .map_err(|errors| serde_json::to_string(&errors).unwrap_or_default())?;
        self.emit(EventKind::GraphRevised {
            graph,
            planning_id,
            planning,
            invalidated: vec![],
            source_head: None,
        })
    }

    /// Nodes whose work or dependencies change, plus consumers of those nodes.
    /// Removed nodes must also finish before their execution state is discarded.
    pub fn revision_affected(&self, graph: &Graph) -> BTreeSet<String> {
        let previous = &self.state.graph;
        let names: BTreeSet<_> = graph.nodes.iter().map(|node| node.name.as_str()).collect();
        let mut affected: BTreeSet<String> = previous
            .nodes
            .iter()
            .filter(|node| !names.contains(node.name.as_str()))
            .map(|node| node.name.clone())
            .collect();
        for node in &graph.nodes {
            let Some(old) = previous.nodes.iter().find(|old| old.name == node.name) else {
                continue;
            };
            let inputs = |g: &Graph| {
                g.edges
                    .iter()
                    .filter(|edge| edge.to == node.name && !edge.feedback)
                    .map(|edge| edge.from.clone())
                    .collect::<BTreeSet<_>>()
            };
            let reviews = |g: &Graph| {
                g.edges
                    .iter()
                    .filter(|edge| edge.from == node.name && edge.feedback)
                    .map(|edge| edge.to.clone())
                    .collect::<BTreeSet<_>>()
            };
            if old.task != node.task
                || inputs(previous) != inputs(graph)
                || reviews(previous) != reviews(graph)
            {
                affected.extend(downstream(graph, &node.name));
            }
        }
        affected
    }

    /// Apply a planner revision without discarding unrelated work. The caller
    /// must wait for any affected in-flight execution before replacing the graph.
    pub fn revise_graph(&mut self, graph: Graph, planning: PlanningSummary) -> Result<(), String> {
        self.require_current_file_contract()?;
        if !self.state.approved
            || self.is_serial()
            || matches!(
                self.state.phase.as_str(),
                "publishing" | "merging" | "publication_failed"
            )
        {
            return Err(
                "Wait for active executions/publication before revising the approved graph".into(),
            );
        }
        let repository = resolve_repository(
            &self.root,
            self.state.config.as_ref().ok_or("Missing config")?,
        )?;
        compile(&graph, true)
            .map_err(|errors| serde_json::to_string(&errors).unwrap_or_default())?;
        let previous = &self.state.graph;
        let names: BTreeSet<_> = graph.nodes.iter().map(|node| node.name.as_str()).collect();
        if self.state.published_head.is_some()
            && previous.nodes.iter().any(|node| {
                !names.contains(node.name.as_str()) && self.state.nodes[&node.name].status == "completed"
            })
        {
            return Err("Cannot remove already published nodes from this run".into());
        }
        let affected = self.revision_affected(&graph);
        if self
            .state
            .executions
            .iter()
            .any(|execution| execution.status == "running" && affected.contains(&execution.node))
        {
            return Err("Wait for affected running nodes before revising the graph".into());
        }
        // New consumers of changed nodes must also be invalidated; all others
        // retain their heads, revisions, execution history and worktrees.
        let invalidated: Vec<_> = affected
            .into_iter()
            .filter(|name| names.contains(name.as_str()))
            .collect();
        // Capture the real source after Planner's native writes. Persist the
        // input head with the revision so reloads cannot fall back to old files.
        // Plain directories that were never materialized (no node dispatched
        // yet) have no snapshot to record; the eventual first dispatch will
        // materialize from the current source files instead.
        let source_head = if !workspace::is_standard_git(&repository)
            && workspace::shadow_repo_if_exists(&repository)?.is_none()
        {
            None
        } else {
            Some(workspace::snapshot_repository_scoped(
                &repository,
                &self.exclusions()?,
            )?)
        };
        self.emit(EventKind::GraphRevised {
            graph,
            planning_id: planning.planning_id.clone(),
            planning,
            invalidated,
            source_head,
        })
    }

    /// Synchronize this conversation's model selection to unstarted nodes and
    /// opt failed nodes into explicit Continue recovery. Never dispatch jobs,
    /// rewrite results/history, or touch another Run's settings.
    pub fn update_node_models(&mut self, config: &Config) -> Result<(), String> {
        config.validate_model_settings()?;
        let Some(original) = self.state.config.as_ref() else {
            return Ok(());
        };
        // The event only records the conversation selection and never rewrites
        // results, publication evidence, or already-executed nodes, so it is
        // safe in every phase.
        let settings = RunModelConfig::from_config(config);
        let previous = self.state.model_config.clone()
            .unwrap_or_else(|| RunModelConfig::from_config(original));
        if settings == previous {
            return Ok(());
        }
        let node_settings = settings.node_agent_settings();
        if node_settings.model.is_empty() {
            return Ok(());
        }
        let previous_node = previous.node_agent_settings();
        let nodes = if node_settings == previous_node {
            // Planner/Partitioner changes are conversation settings only; they
            // must never opt a failed Node Agent attempt into Continue.
            Vec::new()
        } else {
            let started: BTreeSet<_> = self.state.executions.iter()
                .map(|execution| execution.node.as_str()).collect();
            self.state.nodes.iter().filter_map(|(name, node)| {
                let unstarted = matches!(node.status.as_str(), "waiting" | "blocked" | "dirty")
                    && !started.contains(name.as_str());
                let failed = node.status == "failed"
                    && self.state.executions.iter().rev()
                        .find(|execution| execution.node == *name
                            && !self.state.superseded_execution_ids.contains(&execution.id))
                        .is_some_and(|execution| execution.status == "failed");
                ((unstarted || failed)
                    && node.model_config.as_ref().unwrap_or(&previous_node) != &node_settings)
                    .then(|| name.clone())
            }).collect()
        };
        self.emit(EventKind::ConversationModelsUpdated { settings, nodes })
    }

    fn queue_node_recovery(&mut self) -> Result<(), String> {
        let mut roots = self.state.interrupted_nodes();
        roots.extend(self.state.model_retry_nodes());
        roots.sort();
        roots.dedup();
        if roots.is_empty() {
            return Ok(());
        }
        let continuation_nodes = roots.clone();

        let mut recovery = BTreeSet::new();
        for root in roots {
            recovery.extend(downstream(&self.state.graph, &root));
        }
        // Do not disturb a completed branch. Only explicitly recoverable failures
        // and the blocked/failed work that depends on them are eligible for retry.
        recovery.retain(|name| {
            self.state
                .nodes
                .get(name)
                .is_some_and(|node| matches!(node.status.as_str(), "failed" | "blocked"))
        });
        if recovery.is_empty() {
            return Ok(());
        }
        self.emit(EventKind::RecoveryQueued {
            nodes: recovery.into_iter().collect(),
            continuation_nodes,
        })
    }

    /// Record intent before terminating processes, including workers not yet spawned.
    /// Scheduling-only pauses (e.g. Planner revision drain) do not call this.
    pub fn request_execution_stop(&mut self, node: Option<&str>) -> Result<Vec<(String, String)>, String> {
        let executions: Vec<_> = self.state.executions.iter()
            .filter(|execution| execution.status == "running"
                && node.is_none_or(|node| execution.node == node))
            .map(|execution| (execution.node.clone(), execution.id.clone())).collect();
        if !executions.is_empty() {
            self.emit(EventKind::ExecutionStopRequested {
                execution_ids: executions.iter().map(|(_, id)| id.clone()).collect(),
            })?;
        }
        Ok(executions)
    }

    pub fn pause(&mut self, paused: bool) -> Result<(), String> {
        if matches!(
            self.state.phase.as_str(),
            "publishing" | "merging" | "publication_failed"
        ) {
            return Err("Publication has its own lifecycle; wait for it to finish or retry failed publication".into());
        }
        if !self.state.approved {
            return Err("Approve the graph first".into());
        }
        if !paused {
            if self.state.executions.iter().any(|execution| execution.status == "running"
                && self.state.execution_stop_requests.contains(&execution.id)) {
                return Err("Wait for paused executions to stop before continuing".into());
            }
            resolve_repository(
                &self.root,
                self.state.config.as_ref().ok_or("Missing config")?,
            )?;
            self.queue_node_recovery()?;
        }
        self.emit(EventKind::Paused { paused })
    }

    /// Record a turn addressed to a completed node without changing its result
    /// or scheduling another execution. The finished Pi process cannot be steered.
    pub fn message_completed_node(
        &mut self,
        node: &str,
        instruction: &str,
        images: Option<Vec<ImageAttachment>>,
    ) -> Result<(), String> {
        if !self.state.approved
            || self.state.nodes.get(node).map(|n| n.status.as_str()) != Some("completed")
        {
            return Err("Select a completed node to message".into());
        }
        if instruction.trim().is_empty() {
            return Err("Enter a message for the node".into());
        }
        self.emit(EventKind::NodeMessaged {
            node: node.into(),
            instruction: instruction.trim().into(),
            images,
        })
    }

    pub fn intervene(&mut self, node: &str, instruction: &str) -> Result<(), String> {
        self.intervene_with_images(node, instruction, None)
    }

    pub fn intervene_with_images(
        &mut self,
        node: &str,
        instruction: &str,
        images: Option<Vec<ImageAttachment>>,
    ) -> Result<(), String> {
        if instruction.trim().is_empty() {
            return Err("Enter an instruction for the node".into());
        }
        if !self.state.executions.iter().any(|execution| {
            execution.node == node && (execution.after.is_some() || execution.status == "failed")
        }) {
            return Err("No previous node session to continue; revise the plan instead".into());
        }
        // A post-publication follow-up edits the user's source directory; the
        // shadow snapshot (if any) was already reclaimed and must not be rebuilt.
        let source_direct = self.source_direct_context(node);
        if source_direct {
            self.require_current_file_contract()?;
        } else {
            self.validate_invalidation(node)?;
        }
        // Failed executions also retain a session, even without a result head.
        // Replies on a node's unique terminal workspace update that shared tree
        // directly, so completed descendants remain valid and stay completed.
        let shared_workspace = !source_direct && self.terminal_workspace_for(node).is_some();
        self.emit(EventKind::Invalidated {
            nodes: vec![node.into()],
            target: node.into(),
            instruction: instruction.trim().into(),
            human: true,
            images,
            workspace: None,
            shared_workspace,
            source_direct,
        })
    }

    /// Re-edit a settled Pi user turn, keeping the abandoned conversation as
    /// another branch in Pi's session file. Only the edited conversation is rerun.
    pub fn edit_node_message(
        &mut self,
        node: &str,
        execution_id: &str,
        old_text: &str,
        instruction: &str,
        images: Option<Vec<ImageAttachment>>,
    ) -> Result<(), String> {
        self.edit_node_message_with_version(node, execution_id, old_text, instruction, images, None)
    }

    pub fn edit_node_message_with_version(
        &mut self,
        node: &str,
        execution_id: &str,
        old_text: &str,
        instruction: &str,
        images: Option<Vec<ImageAttachment>>,
        selected_version: Option<usize>,
    ) -> Result<(), String> {
        if instruction.trim().is_empty() {
            return Err("Enter a replacement message".into());
        }
        // Completed conversations run in the source directory: the replacement
        // message becomes a new source-direct execution, not a worktree replay.
        if self.source_direct_context(node) {
            self.require_current_file_contract()?;
            return self.emit(EventKind::Invalidated {
                nodes: vec![node.into()],
                target: node.into(),
                instruction: instruction.trim().into(),
                human: true,
                images,
                workspace: None,
                shared_workspace: false,
                source_direct: true,
            });
        }
        self.validate_invalidation(node)?;
        let anchor = self
            .state
            .executions
            .iter()
            .find(|execution| {
                execution.id == execution_id
                    && execution.node == node
                    && (execution.completed_at.is_some() || execution.status == "running")
                    && (selected_version.is_some()
                        || !self.state.superseded_execution_ids.contains(&execution.id))
            })
            .ok_or("Select an active node message to edit")?
            .clone();
        if let Some(store) = self.environments()? {
            let input = anchor
                .input
                .as_ref()
                .ok_or("Historical environment input is unavailable")?;
            store.validate_result_metadata(input)?;
        }
        // Editing branches the Pi session file, and Pi resumes from the last
        // entry. A live writer would keep appending past the branch marker, so
        // its process tree is stopped first — the same lifecycle as switching
        // a /tree branch before rewriting the opening prompt.
        for (_, stopped_execution) in self.request_execution_stop(Some(node))? {
            crate::process_control::stop_owner(&crate::process_control::execution_owner(
                &self.state.run_id,
                node,
                &stopped_execution,
            ))?;
        }
        let start = self
            .state
            .events
            .iter()
            .position(|event| {
                matches!(
                &event.kind, EventKind::Started { execution, .. } if execution.id == execution_id
                    )
            })
            .ok_or("Missing execution start")?;
        let from_event_sequence = self.state.events[..start]
            .iter()
            .rev()
            .find_map(|event| match &event.kind {
                EventKind::Invalidated {
                    target,
                    human: true,
                    ..
                }
                | EventKind::ConversationEdited { target, .. }
                    if target == node =>
                {
                    Some(event.sequence)
                }
                _ => None,
            })
            .unwrap_or(self.state.events[start].sequence);
        let first_id = self
            .state
            .executions
            .iter()
            .find(|execution| execution.session_id == anchor.session_id && execution.node == node)
            .ok_or("Missing Pi session origin")?
            .id
            .clone();
        let session_dir = self.root.join("sessions").join(&first_id);
        let suffix = format!("_{}.jsonl", anchor.session_id);
        let persisted = fs::read_dir(&session_dir).ok().is_some_and(|entries| {
            entries.filter_map(Result::ok)
                .any(|entry| entry.file_name().to_string_lossy().ends_with(&suffix))
        });
        // A failed attempt that exited before Pi created its conversation has
        // no user turn to branch. The edit then replaces the message and the
        // next attempt starts the first turn in the retained session slot. A
        // completed or running conversation still fails closed if its history
        // disappeared, instead of silently losing the abandoned branch.
        let branch = if !persisted && anchor.status == "failed" {
            None
        } else {
            Some(crate::session_branch::branch_before_user(
                &session_dir,
                &anchor.session_id,
                Path::new(&anchor.worktree),
                old_text,
                anchor.started_at,
                anchor.completed_at.unwrap_or(u64::MAX),
            )?)
        };
        if let Err(error) = self.emit(EventKind::ConversationEdited {
            nodes: vec![node.into()],
            target: node.into(),
            instruction: instruction.trim().into(),
            images,
            from_execution_id: execution_id.into(),
            from_event_sequence,
            old_instruction: old_text.into(),
            first_turn: anchor.id == first_id,
            selected_version,
        }) {
            return Err(match branch {
                Some(branch) => match branch.rollback() {
                    Ok(()) => error,
                    Err(rollback) => format!("{error}; {rollback}"),
                },
                None => error,
            });
        }
        Ok(())
    }

    /// Post-publication conversations with a completed node edit the user's source
    /// directory directly instead of rebuilding a Graph worktree. Managed
    /// environments keep their fixed-layout workspace contract, so they are
    /// excluded from source-direct follow-ups.
    fn source_direct_context(&self, node: &str) -> bool {
        if self.state.nodes.get(node).and_then(|state| state.pending_messages.first())
            .is_some_and(|message| message.source_direct) {
            return true;
        }
        !self.is_serial()
            && self
                .state
                .config
                .as_ref()
                .and_then(|config| config.environment.as_ref())
                .is_none()
            && matches!(self.state.phase.as_str(), "completed" | "followup")
            && self
                .state
                .nodes
                .get(node)
                .is_some_and(|state| state.status == "completed")
    }

    /// Refuses an update while a downstream node is still running, because a
    /// changed result would make that run stale. The result comparison itself
    /// happens when the target finishes.
    fn validate_invalidation(&self, node: &str) -> Result<(), String> {
        if self
            .state
            .result_execution
            .as_ref()
            .is_some_and(|e| e.status == "running")
        {
            return Err("Wait for the native result writer or recover its interrupted execution before editing nodes".into());
        }
        if matches!(
            self.state.phase.as_str(),
            "publishing" | "merging" | "publication_failed"
        ) {
            return Err("Resolve or retry publication before changing node results".into());
        }
        if !self.state.approved {
            return Err("Approve the graph before updating a node".into());
        }
        if !self.state.nodes.contains_key(node) {
            return Err("Select a node".into());
        }
        self.require_current_file_contract()?;
        let affected = downstream(&self.state.graph, node);
        if self.state.executions.iter().any(|execution| {
            execution.status == "running"
                && execution.node != node
                && affected.contains(&execution.node)
        }) {
            return Err("Steer a running node directly; wait for running downstream nodes before rerunning this node".into());
        }
        let repository = resolve_repository(
            &self.root,
            self.state.config.as_ref().ok_or("Missing config")?,
        )?;
        if !self.is_serial() && !workspace::is_standard_git(&repository) {
            // Explicit node updates must not be blocked by live user edits;
            // they only require the recorded source snapshot to still exist.
            workspace::check_shadow_base(&repository, self.latest_source_head())?;
        }
        Ok(())
    }

    pub fn resolved(&mut self, node: &str) -> Result<(), String> {
        self.require_current_file_contract()?;
        resolve_repository(
            &self.root,
            self.state.config.as_ref().ok_or("Missing config")?,
        )?;
        if self.active()
            || self.state.nodes.get(node).map(|node| node.status.as_str()) != Some("blocked")
        {
            return Err("Pause first and select a blocked node".into());
        }
        let execution = self
            .state
            .executions
            .iter()
            .rev()
            .find(|execution| execution.node == node)
            .cloned()
            .ok_or("No workspace to resolve")?;
        let path = Path::new(&execution.worktree);
        if !workspace::git(path, &["status", "--porcelain"])?.is_empty()
            || workspace::git(path, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok()
        {
            return Err("Resolve all conflicts and commit the merge in this worktree first".into());
        }
        let config = self.state.config.as_ref().ok_or("Missing config")?;
        let repository = resolve_repository(&self.root, config)?;
        workspace::verify_prepared_ancestor(path, &execution.before)?;
        let head =
            workspace::snapshot_node_for_run(path, &repository, node, Some(&self.state.run_id))?;
        // This was a preparation failure, not a completed node task. Commit
        // the resolved inputs without emitting a fictitious Finished event.
        self.emit(EventKind::WorkspaceResolved {
            execution_id: execution.id,
            head,
            nodes: downstream(&self.state.graph, node).into_iter().collect(),
            files_version: None,
        })
    }

    fn feedback_budget_available(&self, edge: &Edge) -> bool {
        let limit = self
            .state
            .config
            .as_ref()
            .map(|config| config.max_feedback.min(3))
            .unwrap_or(0);
        self.state
            .feedback_counts
            .get(&format!("{}->{}", edge.from, edge.to))
            .copied()
            .unwrap_or(0)
            < limit
    }

    /// A feedback verdict can only invalidate the target and its dependency
    /// descendants while budget remains. A shared ancestor's other branches
    /// are safe to schedule, and an exhausted edge cannot invalidate anything.
    fn feedback_scope(&self, source: &str) -> BTreeSet<String> {
        self.state
            .graph
            .edges
            .iter()
            .filter(|edge| {
                edge.feedback && edge.from == source && self.feedback_budget_available(edge)
            })
            .flat_map(|edge| downstream(&self.state.graph, &edge.to))
            .collect()
    }

    fn feedback_scope_has_running(&self, source: &str) -> bool {
        self.feedback_scope(source).iter().any(|name| {
            self.state
                .nodes
                .get(name)
                .is_some_and(|state| state.status == "running")
        })
    }

    fn busy_feedback_nodes(&self, pending_sources: &[&str]) -> BTreeSet<String> {
        self.state
            .graph
            .edges
            .iter()
            .filter(|edge| edge.feedback)
            // Only a future or unresolved verdict can invalidate this scope.
            // A resolved review must not become busy again just because one
            // of its accepted descendants is still running.
            .filter(|edge| {
                self.state.nodes.get(&edge.from).is_some_and(|node| {
                    matches!(node.status.as_str(), "waiting" | "dirty" | "running")
                }) || self.state.pending_feedback.iter().any(|pending| pending.from == edge.from)
                    || pending_sources.contains(&edge.from.as_str())
            })
            .filter(|edge| self.feedback_scope_has_running(&edge.from))
            .flat_map(|edge| self.feedback_scope(&edge.from))
            .collect()
    }

    pub fn feedback_source_busy(&self, source: &str) -> bool {
        self.feedback_scope_has_running(source)
    }

    pub fn jobs(&mut self) -> Result<Vec<Job>, String> {
        self.jobs_with_publication(true)
    }

    /// Terminal result sets match when they contain exactly the same commits;
    /// order follows plan terminals and is not stable across revisions.
    fn same_published_heads(published: &[String], heads: &[String]) -> bool {
        published.len() == heads.len() && heads.iter().all(|head| published.contains(head))
    }

    /// During a live Planner revision, schedule ready nodes but defer publishing
    /// or settling until the new graph has been committed (or planning failed).
    pub fn jobs_with_publication(&mut self, allow_publication: bool) -> Result<Vec<Job>, String> {
        self.jobs_with_pending_feedback(allow_publication, &[])
    }

    pub(crate) fn jobs_with_pending_feedback(
        &mut self,
        allow_publication: bool,
        pending_sources: &[&str],
    ) -> Result<Vec<Job>, String> {
        if !self.state.approved
            || self.state.paused
            || matches!(
                self.state.phase.as_str(),
                "publishing" | "merging" | "publication_failed"
            )
            || self.state.phase == "completed"
        {
            return Ok(Vec::new());
        }
        self.require_current_file_contract()?;
        self.drain_feedback()?;
        let config = self.state.effective_config().ok_or("Missing config")?;
        // Check before emitting Started or allocating workspaces, including jobs
        // resumed without a UI request. perform() checks again before filesystem work.
        resolve_repository(&self.root, &config)?;
        #[cfg(not(feature = "fixture"))]
        if !self.is_serial() {
            crate::native::require_graph_execution()?;
        }
        // Only Graph nodes share this Run's worker slots. There is no cap on
        // concurrent Runs, Planners, or sessions belonging to different Runs.
        // Serial has exactly one node and is not subject to a Graph worker cap.
        const MAX_GRAPH_NODE_WORKERS: usize = 8;
        let running = self
            .state
            .nodes
            .values()
            .filter(|state| state.status == "running")
            .count();
        let available = if self.is_serial() {
            1usize.saturating_sub(running)
        } else {
            let limit = if config.max_parallel == 0 {
                MAX_GRAPH_NODE_WORKERS
            } else {
                config.max_parallel.min(MAX_GRAPH_NODE_WORKERS)
            };
            limit.saturating_sub(running)
        };
        let mut busy_feedback = self.busy_feedback_nodes(pending_sources);
        // A completed review may still be waiting for its affected running
        // branch to drain. Its consumers must not start on the stale verdict.
        // This is distinct from the feedback target's scope: a consumer of
        // the review is not necessarily downstream of that target.
        for source in pending_sources.iter().copied().chain(
            self.state
                .pending_feedback
                .iter()
                .map(|item| item.from.as_str()),
        ) {
            busy_feedback.extend(downstream(&self.state.graph, source));
        }
        loop {
            let blocked: Vec<_> = self
                .state
                .graph
                .nodes
                .iter()
                .filter(|node| {
                    !busy_feedback.contains(&node.name)
                        && matches!(
                            self.state.nodes[&node.name].status.as_str(),
                            "waiting" | "dirty"
                        )
                        && self.state.graph.edges.iter().any(|edge| {
                            !edge.feedback
                                && edge.to == node.name
                                && matches!(
                                    self.state.nodes[&edge.from].status.as_str(),
                                    "failed" | "blocked"
                                )
                        })
                })
                .map(|node| node.name.clone())
                .collect();
            if blocked.is_empty() {
                break;
            }
            for node in blocked {
                self.emit(EventKind::Blocked {
                    node,
                    error: "Required upstream branch failed or is blocked".into(),
                })?;
            }
        }
        let ready: Vec<_> = self
            .state
            .graph
            .nodes
            .iter()
            .filter(|node| {
                !busy_feedback.contains(&node.name)
                    && matches!(
                        self.state.nodes[&node.name].status.as_str(),
                        "waiting" | "dirty"
                    )
                    && !self.state.executions.iter().any(|execution| {
                        execution.node == node.name && execution.status == "running"
                    })
                    && self
                        .state
                        .graph
                        .edges
                        .iter()
                        .filter(|edge| !edge.feedback && edge.to == node.name)
                        .all(|edge| self.state.nodes[&edge.from].status == "completed")
            })
            .take(available)
            .cloned()
            .collect();
        let mut jobs = Vec::new();
        // A source-direct follow-up runs in the user's directory and must not
        // rebuild/invalidate anything else. `followup` is entered only by a
        // source_direct Invalidated event, so every job scheduled here is one.
        let source_direct_run = self.state.phase == "followup" || self.state.nodes.values()
            .any(|node| node.pending_messages.first().is_some_and(|message| message.source_direct));
        let resolved_repository = resolve_repository(&self.root, &config)?;
        let materialize_source = !source_direct_run
            && !self.is_serial()
            && !workspace::is_standard_git(&resolved_repository)
            && self.job_source_is_fresh(&resolved_repository)?;
        for node in ready {
            let id = Uuid::new_v4().to_string();
            // Dependency nodes normally take over their parent's physical workspace.
            let source_head = self.latest_source_head().to_owned();
            let parent_names = self.parents(&node.name);
            let parent_heads = parent_names
                .iter()
                .map(|parent| {
                    self.state.nodes[parent]
                        .head
                        .clone()
                        .ok_or("Ready node has no completed parent head")
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut before = if source_direct_run {
                String::new()
            } else {
                self.state.nodes[&node.name]
                    .head
                    .clone()
                    .unwrap_or_else(|| source_head.clone())
            };
            let queued_prompt = self.state.nodes[&node.name].pending_prompt();
            let message_sequences = self.state.nodes[&node.name].pending_messages.iter()
                .map(|message| message.sequence).collect::<Vec<_>>();
            let continuation = self.state.nodes[&node.name].continuation && queued_prompt.is_none();
            // Pi writes the session file when it creates the conversation, before
            // the first turn. A startup failure (process exit, extension load
            // error, interrupted preparation) leaves the execution's session
            // directory empty, so there is no conversation to resume.
            let session_missing = |previous: &Execution| {
                let origin = self.state.executions.iter()
                    .find(|execution| execution.node == previous.node
                        && execution.session_id == previous.session_id)
                    .unwrap_or(previous);
                let suffix = format!("_{}.jsonl", previous.session_id);
                match fs::read_dir(self.root.join("sessions").join(&origin.id)) {
                    Ok(mut entries) => !entries.any(|entry| entry.map_or(true, |entry|
                        entry.file_name().to_string_lossy().ends_with(&suffix))),
                    Err(error) => error.kind() == std::io::ErrorKind::NotFound,
                }
            };
            let resume = if continuation {
                self.state
                    .executions
                    .iter()
                    .rev()
                    .find(|execution| {
                        execution.node == node.name
                            && execution.status == "failed"
                            && execution.completed_at.is_some()
                    })
            } else if self.state.nodes[&node.name].human_instruction {
                let anchor = self.state.nodes[&node.name].edit_execution_id.as_deref();
                let previous = self
                    .state
                    .executions
                    .iter()
                    .rev()
                    .find(|execution| {
                        execution.node == node.name
                            && execution.completed_at.is_some()
                            && anchor.is_none_or(|id| execution.id == id)
                    })
                    .ok_or("No previous node session to continue")?;
                if session_missing(previous) && self.state.nodes[&node.name].feedback_workspace.is_some() {
                    let input = self.state.nodes[&node.name]
                        .feedback_workspace
                        .as_ref()
                        .ok_or("Missing feedback input")?;
                    Some(
                        self.state
                            .executions
                            .iter()
                            .find(|execution| execution.id == input.target_execution_id)
                            .ok_or("Missing original target session")?,
                    )
                } else {
                    Some(previous)
                }
            } else {
                None
            };
            // Session continuation and physical workspace recovery are distinct:
            // a first preparation may have stopped before Pi accepted any task.
            // A human follow-up after an attempt that died during startup (for
            // example while loading an extension) has the same problem: there is
            // no persisted conversation to resume, but the attempt's workspace
            // and session slot must be retained and the task sent again.
            let stopped_recovery = continuation && resume.is_some_and(|previous| {
                if !self.state.execution_stop_requests.contains(&previous.id)
                    || self.state.nodes[&node.name].human_instruction
                    || self.state.nodes[&node.name].feedback_workspace.as_ref().is_some_and(|input| !input.additional_sources.is_empty())
                    || self.state.executions.iter().any(|execution| execution.node == node.name
                        && (execution.pid.is_some() || execution.status == "completed")) {
                    return false;
                }
                session_missing(previous)
            });
            let failed_before_session = self.state.nodes[&node.name].human_instruction
                && resume.is_some_and(|previous| previous.status == "failed" && session_missing(previous));
            let initial_recovery = stopped_recovery || failed_before_session;
            let continuation = continuation && !initial_recovery;
            let preserved_workspace = resume
                .filter(|previous| {
                    previous.status == "failed"
                        && !self.is_serial()
                        && !source_direct_run
                        && self.state.nodes[&node.name].edit_execution_id.is_none()
                        && self.state.nodes[&node.name].feedback_workspace.as_ref()
                            .is_none_or(|input| !input.additional_sources.is_empty())
                })
                .and_then(|previous| {
                    // A preparation-only retry may have failed before emitting
                    // Prepared. Find the last prepared failed attempt in this
                    // session, but never reach across a completed result or edit.
                    self.state.executions.iter().rev()
                        .filter(|execution| {
                            execution.node == previous.node
                                && execution.session_id == previous.session_id
                                && Self::same_workspace_path(Path::new(&execution.worktree), Path::new(&previous.worktree))
                                && !self.state.superseded_execution_ids.contains(&execution.id)
                        })
                        .take_while(|execution| execution.status == "failed")
                        .find(|execution| self.state.events.iter().any(|event| matches!(
                            &event.kind, EventKind::Prepared { execution_id, .. } if execution_id == &execution.id
                        )))
                        .cloned()
                });
            if let Some(previous) = &preserved_workspace {
                before = previous.before.clone();
            }
            let feedback_workspace = self.state.nodes[&node.name].feedback_workspace.clone();
            let fresh_path = || {
                workspace::normalize_workspace_display_path(
                    &self
                        .run_workspace_root()
                        .join(format!("{}-{id}", crate::compiler::node_id(&node.name))),
                )
            };
            let busy = |path: &Path| self.workspace_reserved(path, Some(&node.name));
            let shared_terminal = self.state.nodes[&node.name]
                .shared_workspace
                .then(|| self.terminal_workspace_for(&node.name))
                .flatten();
            let mut inherit_workspace = false;
            let mut workspace_lineage = BTreeSet::new();
            let worktree = if let Some(input) = &self.state.nodes[&node.name].feedback_workspace {
                for source in input.sources() {
                    if let Some(execution) = self.state.executions.iter()
                        .find(|execution| execution.id == source.source_execution_id) {
                        workspace_lineage.extend(execution.workspace_lineage.iter().cloned());
                    }
                }
                if input.additional_sources.is_empty() {
                    input.worktree.clone()
                } else {
                    // Compose into a target-owned slot: sending evidence stays
                    // immutable even if a Merger or repair fails halfway through.
                    // A failed prepared attempt continues in its own partial tree.
                    let prepared_failure = preserved_workspace.as_ref().filter(|previous|
                        previous.status == "failed" && Path::new(&previous.worktree).is_dir());
                    prepared_failure.map(|previous| previous.worktree.clone()).unwrap_or_else(fresh_path)
                }
            } else if self.is_serial() || source_direct_run {
                resolve_repository(&self.root, &config)?
                    .to_string_lossy()
                    .into()
            } else if let Some(terminal) = shared_terminal {
                before = self
                    .state
                    .nodes
                    .get(&terminal.node)
                    .and_then(|state| state.head.clone())
                    .or_else(|| terminal.after.clone())
                    .unwrap_or_else(|| source_head.clone());
                workspace_lineage.extend(terminal.workspace_lineage.iter().cloned());
                let path = Path::new(&terminal.worktree);
                if !busy(path) {
                    if path.is_dir() {
                        inherit_workspace = self.workspace_has_head(path, &before);
                        terminal.worktree.clone()
                    } else if let Some(idle) = self.idle_workspace_path() {
                        idle.to_string_lossy().into()
                    } else {
                        terminal.worktree.clone()
                    }
                } else {
                    self.idle_workspace_path()
                        .map(|path| path.to_string_lossy().into())
                        .unwrap_or_else(fresh_path)
                }
            } else if let Some(previous) = resume {
                let path = Path::new(&previous.worktree);
                workspace_lineage.extend(previous.workspace_lineage.iter().cloned());
                if !busy(path) {
                    if path.is_dir() {
                        inherit_workspace = self.workspace_has_head(path, &before);
                        previous.worktree.clone()
                    } else if let Some(idle) = self.idle_workspace_path() {
                        idle.to_string_lossy().into()
                    } else {
                        previous.worktree.clone()
                    }
                } else {
                    self.idle_workspace_path()
                        .map(|path| path.to_string_lossy().into())
                        .unwrap_or_else(fresh_path)
                }
            } else {
                let parent_executions: Vec<_> = parent_names
                    .iter()
                    .filter_map(|parent| self.latest_node_execution(parent))
                    .collect();
                let inherited_parent = parent_executions.iter().find(|execution| {
                    let path = Path::new(&execution.worktree);
                    self.has_single_consumer(&execution.node)
                        && path.is_dir()
                        && !busy(path)
                });
                let available_parent = inherited_parent.or_else(|| {
                    parent_executions.iter().find(|execution| {
                        self.has_single_consumer(&execution.node)
                            && !busy(Path::new(&execution.worktree))
                    })
                });
                if let Some(parent) = available_parent {
                    // A one-to-one edge is a physical handoff. Fan-in folds all
                    // dependency lineages into the selected parent's live slot.
                    if parent_executions.len() > 1 {
                        workspace_lineage.extend(self.dependency_ancestors(&node.name));
                    } else {
                        workspace_lineage.extend(parent.workspace_lineage.iter().cloned());
                        workspace_lineage.insert(parent.node.clone());
                    }
                    let selected_path = if inherited_parent.is_some() {
                        parent.worktree.clone()
                    } else if parent_executions.len() == 1
                        && !self.has_single_consumer(&parent.node)
                    {
                        // Fan-out branches must never claim the same parent slot:
                        // allocate each private directory and copy the parent once.
                        fresh_path()
                    } else {
                        self.idle_workspace_path()
                            .map(|path| path.to_string_lossy().into())
                            .unwrap_or_else(|| parent.worktree.clone())
                    };
                    let parent_head = self.state.nodes[&parent.node]
                        .head
                        .clone()
                        .or_else(|| parent.after.clone())
                        .unwrap_or_else(|| source_head.clone());
                    inherit_workspace = parent_names.len() == 1
                        && self.workspace_has_head(Path::new(&selected_path), &parent_head);
                    selected_path
                } else {
                    if parent_executions.len() > 1 {
                        workspace_lineage.extend(self.dependency_ancestors(&node.name));
                    } else if let Some(parent) = parent_executions.first() {
                        if self.has_single_consumer(&parent.node) {
                            workspace_lineage.extend(parent.workspace_lineage.iter().cloned());
                            workspace_lineage.insert(parent.node.clone());
                        }
                    }
                    self.idle_workspace_path()
                        .map(|path| path.to_string_lossy().into())
                        .unwrap_or_else(fresh_path)
                }
            };
            let copy_from_workspace = if !self.is_serial() && !Path::new(&worktree).is_dir() {
                if feedback_workspace.is_some() {
                    None
                } else if parent_names.is_empty() {
                    Some(
                        resolve_repository(&self.root, &config)?
                            .to_string_lossy()
                            .into_owned(),
                    )
                } else if let Some(terminal) = shared_terminal.filter(|terminal| {
                    !busy(Path::new(&terminal.worktree))
                        && Path::new(&terminal.worktree).is_dir()
                }) {
                    Some(terminal.worktree.clone())
                } else if let Some(previous) = resume.filter(|previous| {
                    !busy(Path::new(&previous.worktree))
                        && Path::new(&previous.worktree).is_dir()
                }) {
                    Some(previous.worktree.clone())
                } else {
                    parent_names
                        .iter()
                        .filter_map(|parent| self.latest_node_execution(parent))
                        .find(|execution| {
                            (!busy(Path::new(&execution.worktree))
                                || parent_names.len() == 1 && !self.has_single_consumer(&execution.node))
                                && Path::new(&execution.worktree).is_dir()
                        })
                        .map(|execution| execution.worktree.clone())
                }
            } else {
                None
            };
            workspace_lineage.insert(node.name.clone());
            if self
                .state
                .executions
                .iter()
                .any(|execution| execution.status == "running"
                    && Self::same_workspace_path(Path::new(&execution.worktree), Path::new(&worktree)))
            {
                continue;
            }
            let workspace_lineage: Vec<_> = workspace_lineage.into_iter().collect();
            // A prepared failed attempt continues in its retained tree without
            // forking: the Pi session already lives at that cwd.
            let session_fork = resume
                .filter(|previous| Some(previous.worktree.as_str()) != Some(worktree.as_str())
                    || feedback_workspace.as_ref().is_some_and(|input| {
                        input.additional_sources.is_empty() || preserved_workspace.is_none()
                    }))
                .map(|previous| {
                    let mut source = previous.clone();
                    source.id = self
                        .state
                        .executions
                        .iter()
                        .find(|execution| {
                            execution.node == node.name
                                && execution.session_id == previous.session_id
                        })
                        .map(|execution| execution.id.clone())
                        .unwrap_or_else(|| previous.id.clone());
                    source
                });
            let resume_execution_id = resume.filter(|_| session_fork.is_none()).map(|previous| {
                self.state
                    .executions
                    .iter()
                    .find(|execution| {
                        execution.node == node.name && execution.session_id == previous.session_id
                    })
                    .map(|execution| execution.id.clone())
                    .unwrap_or_else(|| previous.id.clone())
            });
            let mut execution = Execution {
                id: id.clone(),
                node: node.name.clone(),
                revision: self.state.nodes[&node.name].revision,
                attempt: self
                    .state
                    .executions
                    .iter()
                    .filter(|execution| execution.node == node.name)
                    .count()
                    + 1,
                session_id: resume
                    .filter(|_| session_fork.is_none())
                    .map(|previous| previous.session_id.clone())
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
                worktree,
                before,
                workspace_lineage,
                after: None,
                input: None,
                result: None,
                status: "running".into(),
                output: String::new(),
                output_bytes: 0,
                pid: None,
                started_at: now(),
                completed_at: None,
                metrics: None,
            };
            // Record the selected Node Agent model before launch so session
            // details can show what this attempt will actually use. Completion
            // replaces this placeholder with parsed live metrics.
            let node_settings = self.state.nodes[&node.name].model_config.clone().or_else(|| {
                (execution.attempt == 1)
                    .then(|| self.state.model_config.as_ref().map(RunModelConfig::node_agent_settings))
                    .flatten()
            });
            if let Some(settings) = &node_settings {
                execution.metrics = Some(ExecutionMetrics {
                    model: Some(settings.model.clone()),
                    thinking_level: settings.thinking_level.clone(),
                    ..Default::default()
                });
            }
            let state = &self.state.nodes[&node.name];
            // Editing the opening user turn replaces the node task itself; a
            // follow-up edit on a never-started attempt still needs the node
            // task sent first.
            let edited_opening_turn = state.edit_execution_id.as_deref().is_some_and(|anchor_id| {
                let Some(anchor) = self.state.executions.iter().find(|execution| execution.id == anchor_id) else {
                    return false;
                };
                self.state.executions.iter()
                    .find(|execution| execution.node == anchor.node && execution.session_id == anchor.session_id)
                    .is_some_and(|first| first.id == anchor.id)
            });
            let task = if failed_before_session {
                // The failed attempt never sent anything to Pi, so the retained
                // session slot starts with the node task, followed by the
                // accepted human turn(s).
                let followup = match &queued_prompt {
                    Some((prompt, _)) if !state.instruction.is_empty() && !state.pending_messages.iter()
                        .any(|message| message.instruction == state.instruction) => {
                        format!("{}\n\n{prompt}", state.instruction)
                    }
                    Some((prompt, _)) => prompt.clone(),
                    None => state.instruction.clone(),
                };
                if followup.is_empty() {
                    node.task.clone()
                } else if edited_opening_turn {
                    followup
                } else {
                    format!("{}\n{}", node.task, followup)
                }
            } else if let Some((prompt, _)) = &queued_prompt {
                if resume.is_none() {
                    // A Planner revision may have replaced the original task
                    // and session while these accepted turns were waiting.
                    format!("{}\n\n{prompt}", node.task)
                } else if !state.instruction.is_empty() && !state.pending_messages.iter()
                    .any(|message| message.instruction == state.instruction) {
                    // Pending feedback/history work is not replaced by the
                    // human-message batch either.
                    format!("{}\n\n{prompt}", state.instruction)
                } else {
                    prompt.clone()
                }
            } else if continuation {
                // The Pi continuation boundary restores the unfinished turn
                // from the existing session; do not resend the original task.
                String::new()
            } else if state.instruction.is_empty() {
                node.task.clone()
            } else if state.human_instruction {
                // A follow-up is its own user request in a fresh execution,
                // not an addendum to the original node task.
                state.instruction.clone()
            } else {
                format!("{}\n{}", node.task, state.instruction)
            };
            let images = queued_prompt.map(|(_, images)| images).unwrap_or_else(|| state.instruction_images.clone());
            let feedback_source = self
                .state
                .graph
                .edges
                .iter()
                .any(|edge| edge.feedback && edge.from == node.name);
            let history_edit = state.edit_execution_id.is_some();
            let environment_previous = self.state.executions.iter().rev()
                .filter(|previous| previous.status == "completed")
                .find(|previous| previous.result.as_ref()
                    .is_some_and(|result| result.layout.as_deref().is_some_and(|layout|
                        Self::same_workspace_path(Path::new(layout), Path::new(&execution.worktree)))))
                .and_then(|previous| self.state.nodes.get(&previous.node)
                    .and_then(|node| node.result.as_ref())
                    .filter(|result| result.layout.as_deref().is_some_and(|layout|
                        Self::same_workspace_path(Path::new(layout), Path::new(&execution.worktree))))
                    .or(previous.result.as_ref())).cloned();
            let mut environment_input = None;
            let mut environment_sources = Vec::new();
            let preserve_failed_environment = !history_edit
                && resume.is_some_and(|previous| {
                    previous.status == "failed"
                        && Self::same_workspace_path(Path::new(&previous.worktree), Path::new(&execution.worktree))
                        && Path::new(&execution.worktree).is_dir()
                });
            if let Some(store) = self.environments()? {
                let selected = (|| -> Result<_, String> {
                    if !history_edit
                        && feedback_workspace.is_none()
                        && resume.is_some_and(|previous| {
                            previous.status == "failed"
                                && (!Self::same_workspace_path(
                                    Path::new(&previous.worktree),
                                    Path::new(&execution.worktree),
                                ) || !Path::new(&previous.worktree).is_dir())
                        })
                    {
                        return Err("Failed partial environment view is missing or cannot be reused; refusing to silently restore old input".into());
                    }
                    let selected = if let Some(input) = &feedback_workspace {
                        store.load_record_metadata(&input.source_execution_id, "after")?
                    } else if history_edit {
                        resume
                            .and_then(|e| e.input.clone())
                            .ok_or("Historical environment input is unavailable")?
                    } else if let Some(terminal) = shared_terminal {
                        self.state.nodes[&terminal.node]
                            .result
                            .clone()
                            .ok_or("Current terminal composite result is missing")?
                    } else if let Some(previous) = resume {
                        if preserve_failed_environment {
                            previous.input.clone().map(Ok).unwrap_or_else(|| {
                                store.load_record_metadata(&previous.id, "selected")
                            })?
                        } else {
                            state
                                .result
                                .clone()
                                .or_else(|| previous.result.clone())
                                .or_else(|| previous.input.clone())
                                .ok_or("Continuation environment input is missing")?
                        }
                    } else if !parent_names.is_empty() {
                        let inputs = parent_names
                            .iter()
                            .map(|name| {
                                Ok((
                                    name.clone(),
                                    self.state.nodes[name]
                                        .result
                                        .clone()
                                        .ok_or("Parent composite result is missing")?,
                                ))
                            })
                            .collect::<Result<Vec<_>, String>>()?;
                        environment_sources.extend(inputs.iter().map(|(_, input)| input.clone()));
                        let baseline = self.state.environment_baseline.as_ref()
                            .ok_or("Environment baseline is missing")?;
                        match store.select_for_workspace(&node.name, &inputs, &execution.worktree, baseline, environment_previous.as_ref()) {
                            Ok(selected) => selected,
                            Err(error) => return Err(error),
                        }
                    } else {
                        self.state
                            .environment_baseline
                            .clone()
                            .ok_or("Environment was not explicitly initialized at approval")?
                    };
                    if self
                        .state
                        .environment_baseline
                        .as_ref()
                        .is_none_or(|baseline| baseline.domain != selected.domain)
                    {
                        return Err(
                            "Selected composite input differs from the frozen native domain".into(),
                        );
                    }
                    let mut selected = selected;
                    store.validate_result_metadata(&selected)?;
                    if config.environment.as_ref().is_some_and(|policy| policy.best_effort)
                        && !preserve_failed_environment && !history_edit
                        && feedback_workspace.as_ref().is_none_or(|input| !input.additional_sources.is_empty())
                        && store.requires_fixed_layout(&selected.launch_ref)?
                        && selected.layout.as_ref().is_some_and(|path| *path != execution.worktree)
                    {
                        environment_sources.push(selected.clone());
                        selected = store.select_for_workspace(
                            &node.name, &[(node.name.clone(), selected)], &execution.worktree,
                            self.state.environment_baseline.as_ref().ok_or("Environment baseline is missing")?,
                            environment_previous.as_ref(),
                        )?;
                    }
                    if store.requires_fixed_layout(&selected.launch_ref)?
                        && selected
                            .layout
                            .as_ref()
                            .is_some_and(|path| *path != execution.worktree)
                    {
                        return Err("Workspace composition blocked: fixed environment cannot move to another physical slot; no silent path repair/serialization".into());
                    }
                    store.record_selected(&execution.id, &execution.before, &selected)?;
                    Ok(selected)
                })();
                match selected {
                    Ok(input) => {
                        environment_input = Some(input);
                    }
                    Err(error) => {
                        self.emit(EventKind::Blocked {
                            node: node.name.clone(),
                            error,
                        })?;
                        continue;
                    }
                }
            }
            if config.environment.as_ref().is_some_and(|policy| policy.best_effort) {
                // An idle slot may retain a custom managed prefix from an older
                // owner. Keep its exclusion/ownership evidence when resetting it.
                environment_sources.extend(self.state.nodes.values()
                    .filter_map(|state| state.result.as_ref())
                    .filter(|result| result.layout.as_deref().is_some_and(|layout|
                        Self::same_workspace_path(Path::new(layout), Path::new(&execution.worktree))))
                    .cloned());
            }
            self.emit(EventKind::Started {
                execution: execution.clone(),
                message_sequences: Some(message_sequences),
                // A from-zero execution starts a new Pi session: prior attempts
                // of this node belong to a dead conversation lineage.
                fresh_restart: session_fork.is_none() && resume_execution_id.is_none(),
            })?;
            if config.environment.as_ref().is_some_and(|policy| policy.best_effort) {
                environment_sources.extend(environment_previous.iter().cloned());
            }
            let mut seen_environments = BTreeSet::new();
            environment_sources.retain(|source| seen_environments.insert(
                (source.environment_ref.clone(), source.launch_ref.clone())));
            let previous_environment_launch = if history_edit {
                self.state
                    .nodes
                    .get(&execution.node)
                    .and_then(|node| node.result.as_ref())
                    .filter(|result| result.layout.as_deref().is_some_and(|layout|
                        Self::same_workspace_path(Path::new(layout), Path::new(&execution.worktree))))
                    .map(|result| result.launch_ref.clone())
            } else {
                None
            };
            let mut node_config = config.clone();
            if let Some(settings) = node_settings {
                node_config.role_models.insert("nodeAgent".into(), settings);
            }
            jobs.push(Job {
                execution,
                run_id: self.state.run_id.clone(),
                parent_heads,
                config: node_config,
                task,
                images,
                resume_execution_id,
                session_fork,
                feedback_repair_retry: feedback_workspace.as_ref().is_some_and(|input| {
                    input.additional_sources.is_empty()
                        && self.state.executions.iter().any(|previous| {
                            previous.node == node.name
                                && previous.status == "failed"
                                && Self::same_workspace_path(Path::new(&previous.worktree), Path::new(&input.worktree))
                        })
                }),
                feedback_workspace,
                inherit_workspace,
                preserved_workspace,
                copy_from_workspace,
                history_edit,
                feedback_source,
                materialize_source,
                source_direct: source_direct_run,
                expected_source_head: source_head,
                environment_input,
                environment_sources,
                environment_previous,
                previous_environment_launch,
                preserve_failed_environment,
                continuation,
                initial_recovery,
            });
        }
        if allow_publication
            && pending_sources.is_empty()
            && self.state.pending_feedback.is_empty()
            && jobs.is_empty()
            && !self.active()
            && !matches!(self.state.phase.as_str(), "completed" | "needs_attention")
        {
            // A source-direct follow-up settles the Run instead of publishing:
            // the user's directory already holds the result.
            if self.state.phase != "followup"
                && !self.is_serial()
                && self.state.nodes.values().all(|node| node.status == "completed")
            {
                let terminal_names: Vec<String> = if let Some(plan) = &self.state.plan {
                    if !plan.terminals.is_empty() {
                        plan.terminals.clone()
                    } else {
                        self.state
                            .graph
                            .nodes
                            .iter()
                            .map(|node| node.name.clone())
                            .collect()
                    }
                } else {
                    let dependencies: Vec<_> = self
                        .state
                        .graph
                        .edges
                        .iter()
                        .filter(|edge| !edge.feedback)
                        .collect();
                    let terms: Vec<_> = self
                        .state
                        .graph
                        .nodes
                        .iter()
                        .filter(|node| !dependencies.iter().any(|edge| edge.from == node.name))
                        .map(|node| node.name.clone())
                        .collect();
                    if terms.is_empty() {
                        self.state
                            .graph
                            .nodes
                            .iter()
                            .map(|node| node.name.clone())
                            .collect()
                    } else {
                        terms
                    }
                };
                let heads = terminal_names
                    .iter()
                    .map(|name| {
                        self.state.nodes[name]
                            .head
                            .clone()
                            .ok_or("Completed node has no snapshot")
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                // Terminal results that a completed publication already merged
                // do not need another publication pass: a resumed Run or a
                // stopped post-task review replays this settle decision with
                // unchanged heads, while the published snapshot's Git objects
                // may already be reclaimed. Settling restores the completed
                // phase instead of failing a redundant merge forever.
                if self.state.published_head.is_some()
                    && Self::same_published_heads(&self.state.published_heads, &heads)
                {
                    self.emit(EventKind::Settled)?;
                } else {
                    let repository = resolve_repository(&self.root, &config)?
                        .canonicalize()
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .into();
                    self.emit(EventKind::PublicationStarted { repository, heads })?;
                }
            } else {
                self.emit(EventKind::Settled)?;
            }
        }
        Ok(jobs)
    }

    #[cfg(not(feature = "fixture"))]
    pub fn warm_completed_serial_node(&self) {
        #[cfg(not(test))]
        {
            if !self.is_serial()
                || self.state.paused
                || self.state.stop_requested
                || self
                    .state
                    .nodes
                    .get("task")
                    .is_none_or(|node| node.status != "completed")
            {
                return;
            }
            let Some(execution) = self
                .state
                .executions
                .iter()
                .rev()
                .find(|item| item.node == "task" && item.status == "completed")
            else {
                return;
            };
            let Some(origin) = self
                .state
                .executions
                .iter()
                .find(|item| item.node == "task" && item.session_id == execution.session_id)
            else {
                return;
            };
            if let Some(config) = self.state.effective_config() {
                engine::warm_node(
                    config,
                    PathBuf::from(&execution.worktree),
                    self.root.join("sessions").join(&origin.id),
                    execution.session_id.clone(),
                );
            }
        }
    }

    pub fn parents(&self, node: &str) -> Vec<String> {
        self.state
            .graph
            .edges
            .iter()
            .filter(|edge| !edge.feedback && edge.to == node)
            .map(|edge| edge.from.clone())
            .collect()
    }

    fn latest_node_execution(&self, node: &str) -> Option<&Execution> {
        self.state.executions.iter().rev().find(|execution| {
            execution.node == node
                && execution.status == "completed"
                && execution.completed_at.is_some()
                && !self.state.superseded_execution_ids.contains(&execution.id)
        })
    }

    fn dependency_ancestors(&self, node: &str) -> BTreeSet<String> {
        let mut result = BTreeSet::new();
        let mut pending = vec![node.to_owned()];
        while let Some(current) = pending.pop() {
            if !result.insert(current.clone()) {
                continue;
            }
            pending.extend(self.parents(&current));
        }
        result
    }

    fn has_single_consumer(&self, node: &str) -> bool {
        self.state
            .graph
            .edges
            .iter()
            .filter(|edge| !edge.feedback && edge.from == node)
            .count()
            == 1
    }

    fn terminal_workspace_for(&self, node: &str) -> Option<&Execution> {
        let terminal_nodes = self.state.graph.nodes.iter().filter(|candidate| {
            !self
                .state
                .graph
                .edges
                .iter()
                .any(|edge| !edge.feedback && edge.from == candidate.name)
        });
        let executions: Vec<_> = terminal_nodes
            .filter_map(|candidate| self.latest_node_execution(&candidate.name))
            .filter(|execution| execution.workspace_lineage.iter().any(|name| name == node))
            .collect();
        if executions.is_empty() {
            return None;
        }
        let path = &executions[0].worktree;
        if executions
            .iter()
            .any(|execution| !Self::same_workspace_path(Path::new(&execution.worktree), Path::new(path)))
        {
            return None;
        }
        executions
            .into_iter()
            .max_by_key(|execution| execution.completed_at.unwrap_or(execution.started_at))
    }

    fn run_workspace_root(&self) -> PathBuf {
        workspace::workspaces_parent(&self.root)
            .join(".grapher-worktrees")
            .join(&self.state.run_id)
    }

    fn existing_workspace_paths(&self) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(self.run_workspace_root()) else {
            return Vec::new();
        };
        entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name();
                if name == ".files" {
                    return None;
                }
                entry
                    .file_type()
                    .ok()
                    .filter(|kind| kind.is_dir())
                    .map(|_| {
                        PathBuf::from(workspace::normalize_workspace_display_path(&entry.path()))
                    })
            })
            .collect()
    }

    pub(crate) fn path_is_running(&self, path: &Path) -> bool {
        self.state
            .result_execution
            .as_ref()
            .is_some_and(|e| e.status == "running" && e.input.layout.as_deref()
                .is_some_and(|layout| crate::path_identity::same_path(Path::new(layout), path)))
            || self
                .state
                .executions
                .iter()
                .chain(&self.state.mergers)
                .any(|execution| {
                    execution.status == "running"
                        && crate::path_identity::same_path(Path::new(&execution.worktree), path)
                })
    }

    fn workspace_has_head(&self, path: &Path, head: &str) -> bool {
        path.is_dir()
            && workspace::git(path, &["rev-parse", "HEAD"]).is_ok_and(|actual| actual == head)
    }

    fn workspace_reserved(&self, path: &Path, owner: Option<&str>) -> bool {
        if self.path_is_running(path) {
            return true;
        }
        // Feedback evidence is reserved even without a managed environment.
        // Unrelated jobs must not recycle an input before batch composition.
        if self.state.pending_feedback.iter().any(|pending| {
            self.state.executions.iter().any(|execution| {
                execution.id == pending.execution_id
                    && crate::path_identity::same_path(Path::new(&execution.worktree), path)
            })
        }) || self.state.nodes.iter().any(|(name, node)| {
            Some(name.as_str()) != owner && node.feedback_workspace.as_ref()
                .is_some_and(|input| input.sources().any(|source|
                    crate::path_identity::same_path(Path::new(&source.worktree), path)))
        }) {
            return true;
        }
        if self
            .state
            .config
            .as_ref()
            .and_then(|c| c.environment.as_ref())
            .is_none()
        {
            return false;
        }
        let best_effort = self.state.config.as_ref().and_then(|c| c.environment.as_ref())
            .is_some_and(|policy| policy.best_effort);
        let shared_handoff = owner.is_some_and(|owner| self.state.nodes.get(owner)
            .is_some_and(|node| node.shared_workspace)
            && self.terminal_workspace_for(owner).is_some_and(|terminal|
                crate::path_identity::same_path(Path::new(&terminal.worktree), path)));
        if best_effort && !shared_handoff && self.state.graph.nodes.iter().any(|node|
            Some(node.name.as_str()) != owner
            && self.state.nodes[&node.name].status == "completed"
            && !self.state.graph.edges.iter().any(|edge| !edge.feedback && edge.from == node.name)
            && self.state.nodes[&node.name].result.as_ref()
                .is_some_and(|result| result.layout.as_deref()
                    .is_some_and(|layout| crate::path_identity::same_path(Path::new(layout), path)))) {
            return true;
        }
        self.state.executions.iter().any(|e| {
            e.status == "failed"
                && Some(e.node.as_str()) != owner
                && crate::path_identity::same_path(Path::new(&e.worktree), path)
                && self
                    .state
                    .nodes
                    .get(&e.node)
                    .is_some_and(|n| n.status == "failed")
        })
    }

    fn idle_workspace_path(&self) -> Option<PathBuf> {
        self.existing_workspace_paths()
            .into_iter()
            .find(|path| !self.workspace_reserved(path, None))
    }

    /// Keep only live worker workspaces and the just-completed handoff workspace.
    /// Git refs and commits are durable; a physical slot is still retained
    /// while it is needed by an active writer, feedback request, or recovery.
    fn reclaim_workspace_slots(&self, completed: &Execution) -> Result<(), String> {
        // Fixed native layouts and failed partial views are result dependencies,
        // not expendable allocator caches. Do not reclaim them opportunistically.
        if self
            .state
            .config
            .as_ref()
            .and_then(|c| c.environment.as_ref())
            .is_some()
        {
            return Ok(());
        }
        let root = self.run_workspace_root();
        let Ok(metadata) = fs::symlink_metadata(&root) else {
            return Ok(());
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Refusing linked Run workspace root".into());
        }
        let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
        let mut keep = BTreeSet::new();
        for execution in self
            .state
            .executions
            .iter()
            .filter(|execution| execution.status == "running")
            .chain(std::iter::once(completed))
        {
            if let Ok(path) = Path::new(&execution.worktree).canonicalize() {
                keep.insert(path);
            }
        }
        for pending in &self.state.pending_feedback {
            if let Some(execution) = self
                .state
                .executions
                .iter()
                .find(|execution| execution.id == pending.execution_id)
            {
                if let Ok(path) = Path::new(&execution.worktree).canonicalize() {
                    keep.insert(path);
                }
            }
        }
        for node in self.state.nodes.values() {
            if let Some(input) = &node.feedback_workspace {
                for source in input.sources() {
                    if let Ok(path) = Path::new(&source.worktree).canonicalize() {
                        keep.insert(path);
                    }
                }
            }
        }
        // A completed parent can still be the physical baseline for a new
        // slot when it contains files outside the recorded Git/environment scopes.
        for execution in self.state.executions.iter().filter(|execution| execution.status == "completed") {
            if self.state.graph.edges.iter().any(|edge| {
                !edge.feedback
                    && edge.from == execution.node
                    && self.state.nodes.get(&edge.to).is_some_and(|node| node.status != "completed")
            }) {
                if let Ok(path) = Path::new(&execution.worktree).canonicalize() {
                    keep.insert(path);
                }
            }
        }
        for entry in fs::read_dir(&canonical_root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                continue;
            }
            let path = entry.path();
            if entry.file_name() == ".files" {
                continue;
            }
            let Some(path) = crate::path_safety::real_child_path(&canonical_root, &path, false)?
            else {
                continue;
            };
            if !keep.contains(&path) {
                fs::remove_dir_all(path).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    pub fn finish(
        &mut self,
        execution: &Execution,
        result: Result<(String, String), String>,
    ) -> Result<Option<(String, String)>, String> {
        crate::process_control::clear_owner_stop(&crate::process_control::execution_owner(
            &self.state.run_id, &execution.node, &execution.id,
        ));
        // A worker may return success concurrently with the user's pause. The
        // persisted request wins; never publish or send feedback from that turn.
        let result = if self.state.execution_stop_requests.contains(&execution.id) {
            Err("用户已暂停本次执行；点击继续可恢复未完成的会话。".to_string())
        } else {
            result
        };
        match result {
            Ok((head, output)) => {
                let mut composite = None;
                if let Some(store) = self.environments()? {
                    let evidence = (|| {
                        let input = store.load_record_metadata(&execution.id, "before")?;
                        let result = store.load_record_metadata(&execution.id, "after")?;
                        if input.domain != result.domain
                            || self
                                .state
                                .environment_baseline
                                .as_ref()
                                .is_none_or(|baseline| baseline.domain != result.domain)
                        {
                            return Err("Completion composite evidence differs from the frozen native domain".into());
                        }
                        if input.code_ref
                            != self
                                .state
                                .executions
                                .iter()
                                .find(|e| e.id == execution.id)
                                .ok_or("Missing live execution")?
                                .before
                            || result.code_ref != head
                        {
                            return Err(
                                "Composite evidence does not match actual execution code".into()
                            );
                        }
                        Ok((input, result))
                    })();
                    match evidence {
                        Ok(records) => composite = Some(records),
                        Err(error) => return self.finish(execution, Err(error)),
                    }
                }
                let feedback_source = self
                    .state
                    .graph
                    .edges
                    .iter()
                    .any(|edge| edge.feedback && edge.from == execution.node);
                if feedback_source {
                    if let Err(error) = engine::feedback(&output) {
                        self.emit(EventKind::Failed {
                            node: execution.node.clone(),
                            execution_id: Some(execution.id.clone()),
                            error,
                            output_bytes: 0,
                            metrics: None,
                        })?;
                        return Ok(None);
                    }
                }
                // The driver has already awaited the writer's Flush. Commit
                // the tail synchronously under this same runtime lock: waiting
                // for a writer ACK here would deadlock on the lock we hold.
                let prefix = "\n── Final response ──\n";
                let output_offset = self
                    .state
                    .executions
                    .iter()
                    .find(|item| item.id == execution.id)
                    .ok_or("Execution not found")?
                    .output_bytes
                    + prefix.len();
                self.emit_outputs(vec![EventKind::Output {
                    execution_id: execution.id.clone(),
                    text: format!("{prefix}{output}\n"),
                }])?;
                let live = self
                    .state
                    .executions
                    .iter()
                    .find(|item| item.id == execution.id)
                    .ok_or("Execution not found")?;
                let output_bytes = live.output.len();
                let metrics = Some(parse_execution_metrics(
                    &live.output,
                    live.started_at,
                    now(),
                ));
                let mut terminal = Vec::new();
                if let Some((input, result)) = composite {
                    if live.input.is_none() {
                        terminal.push(EventKind::ExecutionInputRecorded {
                            execution_id: execution.id.clone(),
                            input,
                        });
                    }
                    terminal.push(EventKind::ExecutionResultRecorded {
                        execution_id: execution.id.clone(),
                        result,
                    });
                }
                terminal.push(EventKind::Finished {
                    execution_id: execution.id.clone(),
                    head: head.clone(),
                    output: String::new(),
                    output_bytes,
                    metrics,
                });
                if let Some(edge) = self
                    .state
                    .graph
                    .edges
                    .iter()
                    .find(|edge| edge.feedback && edge.from == execution.node)
                {
                    let target = &self.state.nodes[&edge.to];
                    terminal.push(EventKind::FeedbackQueued {
                        feedback: PendingFeedback {
                            execution_id: execution.id.clone(),
                            from: edge.from.clone(),
                            to: edge.to.clone(),
                            source_head: head.clone(),
                            target_head: if execution.workspace_lineage.contains(&edge.to) {
                                Some(head.clone())
                            } else {
                                target.head.clone()
                            },
                            target_revision: target.revision,
                            target_execution_id: self.reviewed_execution(&execution.id, &edge.to)
                                .map(|target| target.id.clone()),
                            accepted: !engine::feedback(&output)?,
                            output_offset,
                            output_bytes: output.len(),
                        },
                    });
                }
                // Completion and its pending verdict must survive/replay together.
                self.emit_outputs(terminal)?;
                if let Err(error) = self.reclaim_workspace_slots(execution) {
                    eprintln!("Cannot reclaim retired node workspaces: {error}");
                }
                #[cfg(not(feature = "fixture"))]
                self.warm_completed_serial_node();
                if let Some(exec) = self
                    .state
                    .executions
                    .iter()
                    .chain(&self.state.mergers)
                    .find(|item| item.id == execution.id)
                {
                    if let Some(m) = &exec.metrics {
                        eprintln!(
                            "[Grapher] [Execution] Node '{}' finished in {:.2}s (head: {}, tokens: in={}, out={}, tools: {}, errors: {})",
                            exec.node, m.duration_seconds, head, m.usage.input, m.usage.output, m.tools, m.tool_errors
                        );
                    } else {
                        eprintln!(
                            "[Grapher] [Execution] Node '{}' finished (head: {})",
                            exec.node, head
                        );
                    }
                }
                Ok(if feedback_source {
                    Some((execution.node.clone(), output))
                } else {
                    None
                })
            }
            Err(error) => {
                // Stop kills Pi's process tree; its nonzero exit code is a
                // consequence of the user's action, not a model failure.
                let error = if self.state.stop_requested
                    && !self.state.execution_stop_requests.contains(&execution.id) {
                    "用户已停止本次执行；可以修改消息或重新运行。".to_string()
                } else {
                    error
                };
                eprintln!(
                    "[Grapher] [Execution] Node '{}' failed: {error}",
                    execution.node
                );
                self.emit(EventKind::Failed {
                    node: execution.node.clone(),
                    execution_id: Some(execution.id.clone()),
                    error: error.clone(),
                    output_bytes: 0,
                    metrics: None,
                })?;
                if error.starts_with("Workspace composition blocked")
                    || error.starts_with("Workspace composition failed")
                    || error.contains("Merger:")
                {
                    self.emit(EventKind::Blocked {
                        node: execution.node.clone(),
                        error,
                    })?;
                }
                Ok(None)
            }
        }
    }

    pub fn apply_feedback(&mut self, from: &str, output: &str) -> Result<(), String> {
        let accepted = !engine::feedback(output)?;
        let source = self
            .state
            .executions
            .iter()
            .rev()
            .find(|execution| {
                execution.node == from
                    && execution.status == "completed"
                    && !self.state.superseded_execution_ids.contains(&execution.id)
            })
            .ok_or("Feedback source has no completed execution")?;
        if self.state.events.iter().any(|event| matches!(&event.kind, EventKind::FeedbackResolved { execution_id, .. } if execution_id == &source.id)) {
            return Ok(());
        }
        let pending = if let Some(pending) = self
            .state
            .pending_feedback
            .iter()
            .find(|pending| pending.execution_id == source.id)
        {
            pending.clone()
        } else {
            let edge = self
                .state
                .graph
                .edges
                .iter()
                .find(|edge| edge.feedback && edge.from == from)
                .ok_or("No feedback edge")?;
            let target = &self.state.nodes[&edge.to];
            PendingFeedback {
                execution_id: source.id.clone(),
                from: from.into(),
                to: edge.to.clone(),
                source_head: source
                    .after
                    .clone()
                    .ok_or("Feedback source has no result")?,
                target_head: target.head.clone(),
                target_revision: target.revision,
                target_execution_id: self.reviewed_execution(&source.id, &edge.to)
                    .map(|target| target.id.clone()),
                accepted,
                output_offset: 0,
                output_bytes: output.len(),
            }
        };
        self.resolve_feedback(&pending, Some(output))
    }

    pub(crate) fn drain_feedback(&mut self) -> Result<(), String> {
        for pending in self.state.pending_feedback.clone() {
            self.resolve_feedback(&pending, None)?;
        }
        Ok(())
    }

    /// Executions are appended in dispatch order. Pin the target that existed
    /// when this sender started, not its movable head after directory handoff.
    fn reviewed_execution(&self, source: &str, target: &str) -> Option<&Execution> {
        let index = self.state.executions.iter().position(|execution| execution.id == source)?;
        self.state.executions[..index].iter().rev().find(|execution| {
            execution.node == target && execution.completed_at.is_some()
        })
    }

    fn feedback_request_is_current(&self, pending: &PendingFeedback) -> bool {
        self.state.graph.edges.iter().any(|edge| {
            edge.feedback && edge.from == pending.from && edge.to == pending.to
        }) && self.state.nodes.get(&pending.from).is_some_and(|node| {
            node.status == "completed" && node.head.as_deref() == Some(&pending.source_head)
        }) && self.state.nodes.get(&pending.to).is_some_and(|node| {
            node.revision == pending.target_revision && match &pending.target_execution_id {
                Some(id) => node.status == "completed"
                    && self.latest_node_execution(&pending.to).is_some_and(|execution| {
                        execution.id == *id && execution.status == "completed"
                    }),
                None => node.head == pending.target_head,
            }
        }) && !self.state.superseded_execution_ids.contains(&pending.execution_id)
    }

    fn resolve_feedback(
        &mut self,
        pending: &PendingFeedback,
        output: Option<&str>,
    ) -> Result<(), String> {
        // drain_feedback iterates a snapshot; a previous batch may already have
        // resolved this entry. Never invalidate or consume its budget twice.
        if self.state.events.iter().any(|event| matches!(&event.kind,
            EventKind::FeedbackResolved { execution_id, .. } if execution_id == &pending.execution_id)) {
            return Ok(());
        }
        if !self.feedback_request_is_current(pending) {
            return self.emit(EventKind::FeedbackResolved {
                execution_id: pending.execution_id.clone(),
                disposition: "superseded".into(),
            });
        }
        let mut batch = self.state.pending_feedback.iter().filter(|candidate| {
            candidate.execution_id == pending.execution_id
                || pending.target_execution_id.is_some()
                    && candidate.to == pending.to
                    && candidate.target_execution_id == pending.target_execution_id
                    && candidate.target_revision == pending.target_revision
                    && self.feedback_request_is_current(candidate)
        }).cloned().collect::<Vec<_>>();
        if !batch.iter().any(|candidate| candidate.execution_id == pending.execution_id) {
            batch.push(pending.clone());
        }
        // A verdict that will apply makes every running execution in its scope
        // doomed: the repair recomputes them from the target's corrected
        // result. Stop them now instead of letting them finish into a
        // discarded result. Their failures settle on the driver before the
        // next pass re-runs this resolution, so the settle barrier below then
        // holds nothing and the repair dispatches immediately.
        let mut doomed = BTreeSet::new();
        for member in &batch {
            // Only a <FEEDBACK> verdict invalidates its scope; an <ACCEPT>
            // leaves every running result valid and must not stop anything.
            if !member.accepted {
                doomed.extend(self.feedback_scope(&member.from));
            }
        }
        let stopped: Vec<(String, String)> = if doomed.is_empty() {
            Vec::new()
        } else {
            self.state
                .executions
                .iter()
                .filter(|execution| {
                    execution.status == "running" && doomed.contains(&execution.node)
                })
                .map(|execution| (execution.node.clone(), execution.id.clone()))
                .collect()
        };
        if !stopped.is_empty() {
            for (node, execution_id) in &stopped {
                eprintln!(
                    "[Grapher] [Feedback] Stopping node '{node}': a queued <FEEDBACK> verdict invalidates its in-flight result",
                );
                crate::process_control::stop_owner(&crate::process_control::execution_owner(
                    &self.state.run_id,
                    node,
                    execution_id,
                ))?;
            }
            return Ok(());
        }
        // Only already-dispatched work can hold this barrier; waiting future
        // senders are not batch members and must not deadlock the repair.
        if batch.iter().any(|candidate| self.feedback_source_busy(&candidate.from)) {
            return Ok(());
        }
        let mut events = Vec::new();
        let mut instructions = Vec::new();
        let mut sources = Vec::new();
        for member in &batch {
            let edge = self.state.graph.edges.iter().find(|edge| {
                edge.feedback && edge.from == member.from && edge.to == member.to
            }).ok_or("No feedback edge")?;
            let disposition;
            if !member.accepted && !self.feedback_budget_available(edge) {
                disposition = "exhausted";
                events.push(EventKind::FeedbackExhausted {
                    from: member.from.clone(), to: member.to.clone(),
                    execution_id: member.execution_id.clone(),
                    count: self.state.feedback_counts.get(&format!("{}->{}", member.from, member.to))
                        .copied().unwrap_or(0),
                    limit: self.state.config.as_ref().ok_or("Missing config")?.max_feedback.min(3),
                });
            } else {
                disposition = if member.accepted { "accepted" } else { "applied" };
                events.push(EventKind::Feedback {
                    from: member.from.clone(), to: member.to.clone(), accepted: member.accepted,
                });
                if !member.accepted {
                    let stored;
                    let text = if member.execution_id == pending.execution_id && output.is_some() {
                        output.unwrap()
                    } else {
                        stored = self.store.execution_log_page(
                            &self.state.run_id, &member.execution_id,
                            member.output_offset, member.output_bytes,
                        )?.content;
                        if stored.len() != member.output_bytes {
                            return Err("Feedback output range is incomplete".into());
                        }
                        &stored
                    };
                    let body = engine::feedback_body(text)?;
                    let source = self.state.executions.iter().find(|execution| {
                        execution.id == member.execution_id
                    }).ok_or("Missing feedback execution")?;
                    instructions.push(format!("Feedback from {}:\n{body}", member.from));
                    sources.push(FeedbackSource {
                        source_execution_id: source.id.clone(),
                        worktree: source.worktree.clone(), head: member.source_head.clone(),
                    });
                }
            }
            events.push(EventKind::FeedbackResolved {
                execution_id: member.execution_id.clone(), disposition: disposition.into(),
            });
        }
        if !sources.is_empty() {
            let source = sources.remove(0);
            let target = self.state.executions.iter().rev().find(|execution| {
                execution.node == pending.to && execution.completed_at.is_some()
                    && pending.target_execution_id.as_ref().is_none_or(|id| execution.id == *id)
            }).ok_or("Missing feedback target session")?;
            events.push(EventKind::Invalidated {
                nodes: downstream(&self.state.graph, &pending.to).into_iter().collect(),
                target: pending.to.clone(), instruction: instructions.join("\n\n"),
                human: false, images: None,
                workspace: Some(FeedbackWorkspace {
                    source_execution_id: source.source_execution_id,
                    target_execution_id: target.id.clone(), worktree: source.worktree, head: source.head,
                    additional_sources: sources,
                }),
                shared_workspace: false, source_direct: false,
            });
        }
        // Pin all inputs, consume per-edge budgets, remove all requests and
        // invalidate once in one transaction. Restart cannot split the batch.
        self.emit_outputs(events)
    }

    /// Metadata-only reservation. All native scans and code preparation can run
    /// outside the actor, including independent terminal result publication.
    pub(crate) fn publication_environment_input(&self) -> Result<Option<PublicationJob>, String> {
        self.require_current_file_contract()?;
        let Some(store) = self.environments()? else { return Ok(None); };
        let config = self.state.config.as_ref().ok_or("Missing config")?;
        let independent = config.environment.as_ref().is_some_and(|policy| policy.best_effort);
        let terminals = self.terminal_results()?;
        let inputs = if independent { terminals }
            else { vec![("$publication".into(), store.select("$publication", &terminals)?)] };
        for (_, input) in &inputs {
            if self.state.environment_baseline.as_ref().is_none_or(|base| base.domain != input.domain) {
                return Err("Publication input differs from the frozen native domain".into());
            }
            store.validate_result_metadata(input)?;
            let path = input.layout.as_deref().ok_or("Published environment has no native layout")?;
            if self.path_is_running(Path::new(path)) {
                return Err("Cannot publish a launch descriptor over a live writer".into());
            }
        }
        Ok(Some(PublicationJob {
            run_id: self.state.run_id.clone(), repository: resolve_repository(&self.root, config)?,
            store, inputs, independent,
        }))
    }

    pub fn result_descriptor(&self) -> Result<crate::environment::ResultDescriptor, String> {
        self.require_current_file_contract()?;
        let descriptor = self
            .state
            .published_result
            .clone()
            .ok_or("No managed result has been published")?;
        let results: Vec<_> = std::iter::once(&descriptor.result)
            .chain(descriptor.entries.iter().map(|entry| &entry.result)).collect();
        let store = self.environments()?.ok_or("No managed environment store")?;
        for result in &results {
            if !result.resource_refs.is_empty() {
                return Err("This saved result depends on legacy ignored-file snapshots and is read-only; publish a new Run before using it".into());
            }
            store.validate_result_metadata(result)?;
            if result.code_ref != descriptor.result.code_ref {
                return Err("Published entries do not refer to the same project code".into());
            }
        }
        let repository = resolve_repository(
            &self.root,
            self.state.config.as_ref().ok_or("Missing config")?,
        )?;
        workspace::repository_git(
            &repository,
            &[
                "cat-file",
                "-e",
                &format!("{}^{{commit}}", descriptor.result.code_ref),
            ],
        )?;
        Ok(descriptor)
    }

    /// Synchronous convenience for offline callers; HTTP releases the Run mutex
    /// after reservation and reacquires it only for Prepared/Finished events.
    pub fn launch_result(&mut self, args: &[String]) -> Result<String, String> {
        let (job, control) = self.start_result(args)?;
        let outcome = perform_result(&job, &control, |input| {
            self.emit(EventKind::ResultExecutionPrepared { input })
        });
        self.finish_result(&job, &control, outcome)
    }

    pub(crate) fn start_result(
        &mut self,
        args: &[String],
    ) -> Result<(ResultJob, crate::process_control::ResultControl), String> {
        self.start_result_entry(args, None)
    }

    pub(crate) fn start_result_entry(
        &mut self, args: &[String], entry: Option<&str>,
    ) -> Result<(ResultJob, crate::process_control::ResultControl), String> {
        let retry = self
            .state
            .result_execution
            .as_ref()
            .is_some_and(|e| e.status == "failed");
        if self.active()
            || !(self.state.phase == "completed" || self.state.phase == "needs_attention" && retry)
        {
            return Err(
                "Wait for successful publication or explicitly retry the failed result execution"
                    .into(),
            );
        }
        if args.iter().any(|arg| arg.contains('\0')) {
            return Err("NUL in result arguments".into());
        }
        let descriptor = self
            .state
            .published_result
            .clone()
            .ok_or("No managed result has been published")?
            .for_entry(entry)?;
        if retry && self.state.result_execution.as_ref().is_some_and(|execution|
            execution.input.layout.as_deref() != Some(&descriptor.workspace)) {
            return Err("Retry must use the failed business entry and its partial workspace".into());
        }
        let config = self.state.config.clone().ok_or("Missing config")?;
        if !descriptor.result.resource_refs.is_empty() {
            return Err("This saved result depends on legacy ignored-file snapshots and is read-only; publish a new Run before launching it".into());
        }
        config
            .environment
            .as_ref()
            .ok_or("Missing environment policy")?
            .validate()?;
        let input = crate::environment::CompositeResult {
            generation: Uuid::new_v4().to_string(),
            ..descriptor.result.clone()
        };
        let control = crate::process_control::ResultControl::begin(&self.state.run_id)?;
        self.emit(EventKind::ResultExecutionStarted {
            input: input.clone(),
            args: args.to_vec(),
        })?;
        Ok((
            ResultJob {
                run_id: self.state.run_id.clone(),
                root: self.root.clone(),
                config,
                descriptor,
                input,
                args: args.to_vec(),
                retry,
            },
            control,
        ))
    }

    pub(crate) fn finish_result(
        &mut self,
        job: &ResultJob,
        control: &crate::process_control::ResultControl,
        outcome: Result<(String, crate::environment::ResultDescriptor), String>,
    ) -> Result<String, String> {
        if self.state.run_id != job.run_id
            || !self.state.result_execution.as_ref().is_some_and(|e| {
                e.status == "running" && e.input.generation == job.input.generation
            })
        {
            return Err("Stale native result writer cannot commit to this Run/generation".into());
        }
        let generation = job.input.generation.clone();
        match outcome {
            Ok((output, descriptor)) => {
                if let Err(error) =
                    control.finish(|| self.emit(EventKind::ResultExecutionFinished { descriptor }))
                {
                    let _ = self.emit(EventKind::ResultExecutionFailed {
                        generation,
                        error: format!("Native result commit failed: {error}"),
                    });
                    return Err(error);
                }
                Ok(output)
            }
            Err(error) => {
                self.emit(EventKind::ResultExecutionFailed {
                    generation,
                    error: error.clone(),
                })?;
                Err(error)
            }
        }
    }

    fn terminal_results(
        &self,
    ) -> Result<Vec<(String, crate::environment::CompositeResult)>, String> {
        self.state
            .graph
            .nodes
            .iter()
            .filter(|node| {
                !self
                    .state
                    .graph
                    .edges
                    .iter()
                    .any(|edge| !edge.feedback && edge.from == node.name)
            })
            .map(|node| {
                Ok((
                    node.name.clone(),
                    self.state.nodes[&node.name]
                        .result
                        .clone()
                        .ok_or("Terminal composite result is missing")?,
                ))
            })
            .collect()
    }

    fn publication_descriptor(
        &self,
        head: &str,
    ) -> Result<Option<crate::environment::ResultDescriptor>, String> {
        self.publication_environment_input()?.map(|job| job.descriptor(head)).transpose()
    }
}

pub(crate) struct PublicationJob {
    pub(crate) run_id: String,
    pub(crate) inputs: Vec<(String, crate::environment::CompositeResult)>,
    repository: PathBuf,
    store: crate::environment::Environments,
    independent: bool,
}

impl PublicationJob {
    pub(crate) fn validate(&self) -> Result<(), String> {
        for (_, input) in &self.inputs { self.store.validate_result(input)?; }
        Ok(())
    }

    pub(crate) fn descriptor(&self, head: &str) -> Result<crate::environment::ResultDescriptor, String> {
        let mut entries = Vec::new();
        for (name, selected) in &self.inputs {
            let path = Path::new(selected.layout.as_deref().ok_or("Result has no native layout")?);
            let exclusions = self.store.exclusions(&selected.launch_ref)?;
            let present = path.is_dir();
            if present {
                self.store.scoped_files(&selected.launch_ref)?.verify(path, &selected.environment_ref, "")?;
                if !workspace::repository_status(path, &exclusions)?.is_empty() {
                    return Err("Published code view changed outside its writer lease".into());
                }
            }
            let code = workspace::prepare_with_merger_expected_for_run(
                &self.repository, path, head, &[], head, Some(&self.run_id),
                || Err("Publication descriptor requires a clean composed code result".into()),
            )?;
            if !present {
                // Reconstruct a missing successful fixed view at its original path.
                self.store.prepare(path, selected, &Uuid::new_v4().to_string(), &code, vec![], false, true)?;
            }
            let result = crate::environment::CompositeResult { code_ref: code, resource_refs: vec![], ..selected.clone() };
            self.store.scoped_files(&result.launch_ref)?.verify(path, &result.environment_ref, "")?;
            crate::environment_discovery::validate_launch(path, &self.store.load_launch(&result.launch_ref)?, !self.independent)?;
            entries.push(crate::environment::ResultEntry {
                name: name.clone(), workspace: path.to_string_lossy().into(), result,
            });
        }
        let first = entries.first().ok_or("Missing terminal result")?;
        let mut descriptor = self.store.descriptor(&self.run_id, &first.result)?;
        if self.independent {
            // HOME differences are not runtime incompatibility. Bound package
            // bytes still have to agree before an implicit entry is available.
            let launch = self.store.load_launch(&first.result.launch_ref)?;
            let mut equivalent = true;
            for entry in &entries {
                equivalent &= entry.result.launch_ref == first.result.launch_ref;
                if let Some(binding) = &launch.environment {
                    equivalent &= self.store.files.same_scope_contents(
                        &first.result.environment_ref, &entry.result.environment_ref, &binding.prefix,
                    )?;
                }
            }
            descriptor.schema = 2;
            descriptor.default_entry = equivalent.then(|| first.name.clone());
            descriptor.entries = entries;
        }
        Ok(descriptor)
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

pub fn perform(
    job: &Job,
    root: &Path,
    parents: &[String],
    on_output: impl FnMut(String),
    on_prepared: impl FnMut(String) -> Result<(), String>,
) -> Result<(String, String), String> {
    perform_with_merger(job, root, parents, on_output, on_prepared, |_| {
        Err("Merger event sink is unavailable".into())
    })
}

pub(crate) fn perform_result(
    job: &ResultJob,
    control: &crate::process_control::ResultControl,
    mut on_prepared: impl FnMut(crate::environment::CompositeResult) -> Result<(), String>,
) -> Result<(String, crate::environment::ResultDescriptor), String> {
    crate::process_control::with_owner(&job.run_id, || {
        crate::process_control::with_resource_limits(
            job.config
                .environment
                .as_ref()
                .and_then(|e| e.resources.as_ref()),
            || {
                control.check()?;
                let policy = job
                    .config
                    .environment
                    .as_ref()
                    .ok_or("Missing environment policy")?;
                let _device = crate::environment_resources::acquire(policy)?;
                let store = crate::environment::Environments::new(&job.root, &job.run_id, policy)?;
                store.validate_result(&job.descriptor.result)?;
                if !job.descriptor.result.resource_refs.is_empty() {
                    return Err("This saved result depends on legacy ignored-file snapshots and is read-only; publish a new Run before launching it".into());
                }
                let mut exclusions = store.exclusions(&job.descriptor.result.launch_ref)?;
                let path = Path::new(&job.descriptor.workspace);
                let repository = resolve_repository(&job.root, &job.config)?;
                workspace::repository_git(
                    &repository,
                    &[
                        "cat-file",
                        "-e",
                        &format!("{}^{{commit}}", job.descriptor.result.code_ref),
                    ],
                )?;
                let present = path.is_dir();
                if job.retry && !present {
                    return Err("Failed native result partial view is missing; refusing a silent reset to the published result".into());
                }
                if present && !job.retry {
                    if workspace::git(path, &["rev-parse", "HEAD"])?
                        != job.descriptor.result.code_ref
                        || !workspace::repository_status(path, &exclusions)?.is_empty()
                    {
                        return Err("Published code view changed outside its writer lease".into());
                    }
                    store
                        .scoped_files(&job.descriptor.result.launch_ref)?
                        .verify(path, &job.descriptor.result.environment_ref, "")?;
                }
                control.check()?;
                store.record_selected(
                    &job.input.generation,
                    &job.input.code_ref,
                    &job.descriptor.result,
                )?;
                if !present {
                    workspace::prepare_with_merger_expected_for_run(
                        &repository,
                        path,
                        &job.descriptor.result.code_ref,
                        &[],
                        &job.descriptor.result.code_ref,
                        Some(&job.run_id),
                        || Err("Result reconstruction cannot require a Merger".into()),
                    )?;
                }
                let generation = &job.input.generation;
                let head = workspace::snapshot_node_scoped(
                    path,
                    &repository,
                    "result",
                    Some(&job.run_id),
                    &exclusions,
                )?;
                let input = store.prepare(
                    path,
                    &job.descriptor.result,
                    generation,
                    &head,
                    vec![],
                    present && job.retry,
                    !present,
                )?;
                control.check()?;
                on_prepared(input.clone())?;
                let session = job
                    .root
                    .join("environments")
                    .join(&job.run_id)
                    .join("sessions")
                    .join(generation);
                fs::create_dir_all(&session).map_err(|e| e.to_string())?;
                #[cfg(not(feature = "fixture"))]
                let mut command = crate::native::execution_command(
                    engine::PiRole::NodeAgent,
                    &repository,
                    path,
                    &job.root,
                    &session,
                )?;
                #[cfg(feature = "fixture")]
                let mut command = crate::native::fixture_execution_command(path)?;
                command.arg("--grapher-run-result").args(&job.args);
                command
                    .env("GRAPHER_MODE", "result")
                    .env("GRAPHER_EXECUTION_KIND", "graph")
                    .env("GRAPHER_WORKSPACE_ROOT", crate::native::host_path(path))
                    .env(
                        "GRAPHER_ORIGINAL_ROOT",
                        crate::native::host_path(&repository),
                    );
                crate::environment::bind_command(
                    &mut command,
                    &job.root,
                    &job.run_id,
                    policy,
                    &input,
                    path,
                    &session,
                )?;
                let timeout = policy
                    .resources
                    .as_ref()
                    .and_then(|r| r.result_timeout_seconds)
                    .map(std::time::Duration::from_secs);
                let output_limit = policy
                    .resources
                    .as_ref()
                    .and_then(|r| r.max_output_bytes)
                    .unwrap_or(4 * 1024 * 1024) as usize;
                let output = crate::environment::controlled_output_with_limits(
                    command,
                    timeout,
                    output_limit,
                )?;
                control.check()?;
                let input = store.discover(path, &input, &session)?;
                exclusions.extend(store.exclusions(&input.launch_ref)?);
                store.prove_accelerator(&repository, path, &input)?;
                policy.check_tracked(path)?;
                let head = workspace::snapshot_node_scoped(
                    path,
                    &repository,
                    "result",
                    Some(&job.run_id),
                    &exclusions,
                )?;
                let result = store.seal(path, &input, &head, vec![])?;
                let mut descriptor = store.descriptor(&job.run_id, &result)?;
                if !job.descriptor.entries.is_empty() {
                    descriptor.schema = job.descriptor.schema;
                    descriptor.default_entry = job.descriptor.default_entry.clone();
                    descriptor.entries = job.descriptor.entries.clone();
                    for entry in descriptor.entries.iter_mut().filter(|entry| entry.workspace == descriptor.workspace) {
                        entry.result = result.clone();
                    }
                }
                Ok((
                    String::from_utf8(output).map_err(|e| e.to_string())?,
                    descriptor,
                ))
            },
        )
    })
}

pub fn perform_with_merger(
    job: &Job,
    root: &Path,
    parents: &[String],
    on_output: impl FnMut(String),
    on_prepared: impl FnMut(String) -> Result<(), String>,
    on_merger_event: impl FnMut(EventKind) -> Result<(), String>,
) -> Result<(String, String), String> {
    let resources = job
        .config
        .environment
        .as_ref()
        .and_then(|e| e.resources.as_ref());
    crate::process_control::with_resource_limits(resources, || {
        let _device = job
            .config
            .environment
            .as_ref()
            .map(crate::environment_resources::acquire)
            .transpose()?;
        perform_with_merger_inner(job, root, parents, on_output, on_prepared, on_merger_event)
    })
}

fn perform_with_merger_inner(
    job: &Job,
    root: &Path,
    parents: &[String],
    on_output: impl FnMut(String),
    mut on_prepared: impl FnMut(String) -> Result<(), String>,
    mut on_merger_event: impl FnMut(EventKind) -> Result<(), String>,
) -> Result<(String, String), String> {
    let repository = resolve_repository(root, &job.config)?;
    let path = Path::new(&job.execution.worktree);
    let reused = path.is_dir();
    // Validate before any checkout, copying or native-environment preparation.
    // An interrupted writer's dirty files belong to that execution, not to an
    // expendable workspace slot. Never stash, clean or reset them on recovery.
    let preserved_head = if let Some(previous) = &job.preserved_workspace {
        if !reused || !crate::path_identity::same_path(
            Path::new(&previous.worktree),
            Path::new(&job.execution.worktree),
        )
            || previous.node != job.execution.node
            || previous.session_id != job.execution.session_id
            || job.history_edit || job.feedback_workspace.as_ref()
                .is_some_and(|input| input.additional_sources.is_empty())
        {
            return Err("Recovery workspace is missing or reassigned; refusing to replace preserved partial work".into());
        }
        workspace::verify_prepared_ancestor(path, &previous.before)?;
        for input in job.parent_heads.iter().chain(std::iter::once(&job.expected_source_head))
            .chain(job.feedback_workspace.iter().flat_map(|input| input.additional_sources.iter().map(|source| &source.head))) {
            if !input.is_empty() && workspace::git(
                path, &["merge-base", "--is-ancestor", input, &previous.before],
            ).is_err() {
                return Err("Recovery inputs changed after preparation; refusing to reset preserved partial work".into());
            }
        }
        Some(workspace::git(path, &["rev-parse", "HEAD"])?)
    } else {
        None
    };
    let mut selected_environment = job.environment_input.clone();
    if job.history_edit {
        if let (Some(policy), Some(input), Some(previous)) = (
            &job.config.environment,
            &selected_environment,
            &job.previous_environment_launch,
        ) {
            let store = crate::environment::Environments::new(root, &job.run_id, policy)?;
            store.validate_history_scopes(&input.launch_ref, previous)?;
        }
    }
    if job.preserve_failed_environment {
        if let (Some(policy), Some(input), Some(previous)) = (
            &job.config.environment,
            &selected_environment,
            &job.resume_execution_id,
        ) {
            let store = crate::environment::Environments::new(root, &job.run_id, policy)?;
            let previous_input = input.clone();
            selected_environment = Some(store.discover(
                path,
                &previous_input,
                &root.join("sessions").join(previous),
            )?);
        }
    }
    let mut exclusions = job
        .config
        .environment
        .as_ref()
        .map(|e| e.exclusions())
        .unwrap_or_default();
    if let (Some(policy), Some(input)) = (&job.config.environment, &selected_environment) {
        exclusions = crate::environment::Environments::new(root, &job.run_id, policy)?
            .exclusions(&input.launch_ref)?;
    }
    let environments = job
        .config
        .environment
        .as_ref()
        .map(|config| crate::environment::Environments::new(root, &job.run_id, config))
        .transpose()?;
    if let Some(store) = &environments {
        for source in &job.environment_sources {
            store.validate_result(source)?;
            exclusions.extend(store.exclusions(&source.launch_ref)?);
        }
        exclusions.sort();
        exclusions.dedup();
        if job.config.environment.as_ref().is_some_and(|policy| policy.best_effort)
            && selected_environment.as_ref().is_some_and(|selected| selected.layout.is_none())
            && reused && !job.preserve_failed_environment
        {
            if let Some(previous) = &job.environment_previous {
                store.scoped_files(&previous.launch_ref)?.verify(path, &previous.environment_ref, "")?;
            }
        }
    }
    if let (Some(store), Some(input)) = (&environments, &job.environment_input) {
        if !job.environment_sources.iter().any(|source|
            source.environment_ref == input.environment_ref && source.launch_ref == input.launch_ref) {
            store.validate_result(input)?;
        }
        if job.feedback_workspace.as_ref().is_some_and(|input| input.additional_sources.is_empty()) {
            store
                .scoped_files(&input.launch_ref)?
                .verify(path, &input.environment_ref, "")?;
        }
    }
    let mut adopted_feedback_head: Option<String> = None;
    if let Some(input) = &job.feedback_workspace {
        for source in input.sources() {
            let source_path = Path::new(&source.worktree);
            let owner = source_path.parent().and_then(Path::file_name).and_then(|name| name.to_str());
            let bucket = source_path.parent().and_then(Path::parent)
                .and_then(Path::file_name).and_then(|name| name.to_str());
            if owner != Some(&job.run_id) || bucket != Some(".grapher-worktrees") || !source_path.is_dir() {
                return Err("Feedback requires an existing worktree owned by this Run".into());
            }
            let mut source_exclusions = exclusions.clone();
            if let Some(store) = &environments {
                let result = store.load_record_metadata(&source.source_execution_id, "after")?;
                store.validate_result(&result)?;
                source_exclusions.extend(store.exclusions(&result.launch_ref)?);
            }
            let feedback_head = workspace::git(source_path, &["rev-parse", "HEAD"])?;
            let feedback_status = workspace::repository_status(source_path, &source_exclusions)?;
            if feedback_head != source.head || !feedback_status.is_empty() {
                // A single-source handoff executes the target in the sender's
                // directory, so a failed attempt of this very node can leave
                // residue there: its unrecorded after-snapshot commit or
                // interrupted writes. That residue belongs to the failed
                // attempt, and the directory stays reserved for it until the
                // repair releases the handoff. Refusing it would wedge every
                // retry on a pin nothing will ever satisfy again, so the retry
                // adopts the live head as its base — the mutation becomes
                // represented by the retry's own Prepared input — while any
                // residue that discarded the pinned history stays refused.
                // `feedback_repair_retry` is computed at launch from the run's
                // execution history, so attribution never depends on whether
                // the failed attempt's own session happened to be persisted.
                let own_residue = job.feedback_repair_retry
                    && crate::path_identity::same_path(Path::new(&source.worktree), Path::new(&job.execution.worktree))
                    && workspace::verify_prepared_ancestor(source_path, &source.head).is_ok();
                if !own_residue {
                    return Err("Feedback workspace changed after completion".into());
                }
                adopted_feedback_head = Some(feedback_head.clone());
            }
            if let Some(target) = &job.session_fork {
                if let Some(head) = &target.after {
                    workspace::verify_prepared_ancestor(source_path, head)?;
                }
            }
        }
    }
    #[cfg(not(feature = "fixture"))]
    if path != repository {
        crate::native::require_graph_execution()?;
    }
    // Direct `perform` callers (fixtures, embedded use) may not have gone
    // through the server worker's lazy materialization. Reuse the existing
    // snapshot or create it once. Production workers already did this under
    // the per-source lock and passed the commit in through the Job.
    let materialized_base = if job.materialize_source
        && !job.source_direct
        && !workspace::is_standard_git(&repository)
    {
        Some(collect_source_snapshot(
            &repository,
            &exclusions,
            job.expected_source_head.is_empty(),
        )?)
    } else {
        None
    };
    let expected_source_head = materialized_base
        .as_deref()
        .unwrap_or(&job.expected_source_head);
    let execution_before = if let Some(adopted) = &adopted_feedback_head {
        adopted.as_str()
    } else {
        materialized_base
            .as_deref()
            .unwrap_or(&job.execution.before)
    };
    let parent_refs = if job.parent_heads.is_empty() {
        parents
    } else {
        &job.parent_heads
    };
    let mut input_heads = parent_refs.to_vec();
    if let Some(input) = &job.feedback_workspace {
        // Unlike stale published parents, a pinned feedback input must never be
        // silently filtered out of composition when its commit is unavailable.
        for source in input.sources() {
            workspace::repository_git(&repository, &["cat-file", "-e", &format!("{}^{{commit}}", source.head)])
                .map_err(|error| format!("Feedback input commit is unavailable: {error}"))?;
        }
        input_heads.extend(input.additional_sources.iter().map(|source| source.head.clone()));
    }
    if job.history_edit && environments.is_some() {
        input_heads.clear();
    }
    // Serial runs and post-publication source-direct follow-ups execute in the
    // source directory: no shadow base pin, no worktree composition, no refs.
    let source_tree = path == repository;
    // A post-publication rebaseline recreates a plain folder's shadow snapshot
    // from the current source files, so parent commits recorded before it no
    // longer exist. Empty heads come from source-direct edits. In both cases the
    // parent's content is already part of the prepared source snapshot, so it
    // must not be resolved or merged as a commit.
    if !job.source_direct && !source_tree {
        let standard_git = workspace::is_standard_git(&repository);
        input_heads.retain(|head| {
            if head.is_empty() {
                return false;
            }
            standard_git
                || workspace::repository_git(
                    &repository,
                    &["cat-file", "-e", &format!("{head}^{{commit}}")],
                )
                .is_ok()
        });
    }
    if !job.source_direct
        && !source_tree
        && !expected_source_head.is_empty()
        && execution_before != expected_source_head
        && !(job.history_edit && environments.is_some())
    {
        // Continuations keep their own result and dependency inputs, while also
        // receiving source files written by a subsequent Planner turn.
        workspace::pin_repository_head(&repository, expected_source_head)?;
        if !input_heads.contains(&expected_source_head.to_string()) {
            input_heads.push(expected_source_head.to_string());
        }
    }
    let inherited_head = if job.source_direct || source_tree {
        None
    } else {
        workspace::git(path, &["rev-parse", "HEAD"]).ok()
    };
    let can_inherit = !job.source_direct
        && !source_tree
        && job.inherit_workspace
        && !job.history_edit
        && !expected_source_head.is_empty()
        && inherited_head.as_deref().is_some_and(|head| {
            (!job.parent_heads.is_empty() && job.parent_heads.iter().any(|parent| parent == head)
                || job.execution.workspace_lineage.len() > 1 && job.parent_heads.is_empty())
                && job.parent_heads.iter().all(|parent| {
                    workspace::git(path, &["merge-base", "--is-ancestor", parent, head]).is_ok()
                })
                && workspace::git(
                    path,
                    &["merge-base", "--is-ancestor", expected_source_head, head],
                )
                .is_ok()
        })
        && workspace::repository_status(path, &exclusions).is_ok_and(|status| status.is_empty())
        && workspace::git(path, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_err();
    let before = if let Some(head) = preserved_head {
        head
    } else if let Some(adopted) = &adopted_feedback_head {
        // Continue from the failed attempt's residue instead of recomposing
        // the pinned base, which would discard that attempt's recorded work.
        adopted.clone()
    } else if can_inherit {
        inherited_head.unwrap_or_else(|| execution_before.to_string())
    } else if job.source_direct || source_tree {
        execution_before.to_string()
    } else {
        workspace::prepare_with_merger_expected_for_run(
            &repository,
            path,
            execution_before,
            &input_heads,
            expected_source_head,
            Some(&job.run_id),
            || {
                crate::graph_merge::resolve_with_merger_for_node(
                    path,
                    &job.task,
                    &job.config,
                    root,
                    job.execution.attempt,
                    &format!("merge:{}", job.execution.node),
                    crate::graph_merge::MergerConflicts::GIT,
                    &mut on_merger_event,
                )?;
                Ok(())
            },
        )?
    };
    if !reused {
        if let Some(source) = &job.copy_from_workspace {
            workspace::copy_ordinary_files(
                Path::new(source),
                path,
                &exclusions,
                root,
            )?;
        }
    }
    let environment_input = if let Some(store) = &environments {
        Some(store.prepare(
            path,
            selected_environment
                .as_ref()
                .ok_or("Missing managed environment input")?,
            &job.execution.id,
            &before,
            vec![],
            job.preserve_failed_environment,
            job.history_edit || !reused,
        )?)
    } else {
        None
    };
    on_prepared(before.clone())?;
    if let Some(source) = &job.session_fork {
        let source_dir = root.join("sessions").join(&source.id);
        // Synthetic fixture agents have no Pi JSONL. Real executions always
        // fail closed when the target's persisted history cannot be migrated.
        let suffix = format!("_{}.jsonl", source.session_id);
        let persisted = fs::read_dir(&source_dir).ok().is_some_and(|entries| {
            entries
                .filter_map(Result::ok)
                .any(|entry| entry.file_name().to_string_lossy().ends_with(&suffix))
        });
        if !cfg!(feature = "fixture") || persisted {
            crate::session_branch::fork_session(
                &source_dir,
                &source.session_id,
                Path::new(&source.worktree),
                &root.join("sessions").join(&job.execution.id),
                &job.execution.session_id,
                path,
            )?;
        }
    }
    let mut execution_view = job.execution.clone();
    execution_view.input = environment_input.clone();
    let mut on_output = on_output;
    let output = engine::execute(
        &job.config,
        &execution_view,
        &job.task,
        job.feedback_source,
        job.resume_execution_id.as_deref(),
        job.continuation,
        job.initial_recovery,
        job.images.as_deref(),
        root,
        &mut on_output,
    )?;
    // A malformed verdict is a protocol error, not a node failure: push a
    // bounded repair turn into this node's own session and let it restate the
    // verdict before completion is committed. Exhausted repairs still fail
    // closed with the protocol error inside finish.
    let output = if job.feedback_source {
        engine::repair_feedback_verdict(
            &job.config,
            &execution_view,
            output,
            job.resume_execution_id.as_deref(),
            root,
            &mut on_output,
        )?
    } else {
        output
    };
    if path != repository {
        workspace::verify_prepared_ancestor(path, &before)?;
    }
    let environment_result_input =
        if let (Some(store), Some(input)) = (&environments, &environment_input) {
            let discovered = store.discover(
                path,
                input,
                &root.join("sessions").join(
                    job.resume_execution_id
                        .as_deref()
                        .unwrap_or(&job.execution.id),
                ),
            )?;
            exclusions.extend(store.exclusions(&discovered.launch_ref)?);
            Some(discovered)
        } else {
            None
        };
    if let Some(config) = &job.config.environment {
        config.check_tracked(path)?;
    }
    let head = if job.source_direct {
        // The source directory was edited directly; no commit belongs to Grapher.
        String::new()
    } else if environments.is_some() {
        workspace::snapshot_node_scoped(
            path,
            &repository,
            &job.execution.node,
            Some(&job.run_id),
            &exclusions,
        )?
    } else {
        workspace::snapshot_execution_scoped(
            path,
            &repository,
            &job.execution.node,
            Some(&job.run_id),
            execution_before,
        )?
    };
    if let (Some(store), Some(input)) = (&environments, &environment_result_input) {
        store.prove_accelerator(&repository, path, input)?;
        store.seal(
            path,
            input,
            &head,
            vec![],
        )?;
    }
    Ok((head, output))
}
