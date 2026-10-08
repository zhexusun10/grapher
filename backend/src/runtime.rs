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
    /// The selected worktree already contains the inherited commit; do not rebuild it from refs.
    pub inherit_workspace: bool,
    pub file_versions: Vec<String>,
    pub previous_file_version: Option<String>,
    pub history_edit: bool,
    pub feedback_source: bool,
    pub expected_source_head: String,
    pub environment_input: Option<crate::environment::CompositeResult>,
    pub previous_environment_launch: Option<String>,
    pub preserve_failed_environment: bool,
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
        let store = Store::open(&self.root.join("events.sqlite"))?;
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
            root: self.root.clone(),
            _lock: self._lock.clone(),
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
        self.store.append(&mut self.state, kind)?;
        self.touch();
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
        self.store.append_batch(&mut self.state, events)?;
        self.touch();
        Ok(())
    }

    fn recover_publication(&mut self) -> Result<(), String> {
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
        if self.state.phase != "publication_failed" {
            return Err("Only failed publication can be retried".into());
        }
        let publication = self
            .state
            .publication
            .clone()
            .ok_or("No publication to retry")?;
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
        let stored;
        let target = if self.state.run_id == run_id {
            &self.state
        } else {
            stored = self.store.load(run_id)?;
            &stored
        };
        if matches!(target.phase.as_str(), "planning" | "publishing" | "merging")
            || target.nodes.values().any(|node| node.status == "running")
        {
            return Err("Cannot delete a running execution".into());
        }
        let manifest = crate::cleanup::manifest(&self.root, &self.store, target, true)?;
        let deleting_current = self.state.run_id == run_id;
        self.store
            .delete_run_with_cleanup(run_id, Some(&manifest))?;
        if deleting_current {
            let current_config = self.state.config.clone();
            self.state = Snapshot {
                config: current_config,
                ..Snapshot::default()
            };
            self.touch();
        }
        // Logical deletion has committed. Report filesystem failures through
        // the durable queue, not an error that would retain a stale UI/service.
        if let Err(error) = self.retry_cleanup(run_id) {
            eprintln!("[Grapher] Run {run_id} deleted; filesystem cleanup remains queued: {error}");
        }
        Ok(())
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
        // Admission is durable and opt-out is not a frontend decision. Fixture
        // actuators keep their injected tool contract; production new Runs with
        // no historical policy are resolved by Rust at approval, after Planner.
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

    /// Approval stays immutable; later Planner writes/publications advance the
    /// inputs of future jobs without replacing an in-flight node's workspace.
    fn latest_source_head(&self) -> &str {
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

    fn files(&self) -> Result<crate::workspace_files::Files, String> {
        Ok(
            crate::workspace_files::Files::new(&self.root, &self.state.run_id)?
                .with_exclusions(&self.exclusions()?),
        )
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

    pub(crate) fn capture_planner_source(&mut self) -> Result<(), String> {
        let repository = resolve_repository(
            &self.root,
            self.state.config.as_ref().ok_or("Missing config")?,
        )?;
        let head = workspace::snapshot_repository_scoped(&repository, &self.exclusions()?)?;
        self.record_source_files(&repository, &head)?;
        if head != self.latest_source_head() {
            self.emit(EventKind::SourceSnapshotted { head })?;
        }
        Ok(())
    }

    fn record_source_files(&mut self, repository: &Path, head: &str) -> Result<(), String> {
        if self.is_serial() {
            return Ok(());
        }
        let files = self.files()?;
        let parents = self
            .state
            .source_files
            .as_ref()
            .filter(|source| files.exists(&source.version))
            .map(|source| vec![source.version.clone()])
            .unwrap_or_default();
        let version = Uuid::new_v4().to_string();
        files.capture(repository, &version, head, &parents)?;
        self.emit(EventKind::SourceFilesRecorded {
            files: SourceFiles {
                head: head.into(),
                version,
            },
        })
    }

    pub fn approve(&mut self) -> Result<(), String> {
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
        workspace::verify(&repository)?;
        if let Some(store) = self.environments()? {
            if self.state.environment_baseline.is_none() {
                let result = store.initialize(&repository)?;
                self.emit(EventKind::EnvironmentInitialized { result })?;
            }
        }
        // Planning writes directly to source. Freeze the actual files only now,
        // after planning and approval, before any node workspace is allocated.
        let base = workspace::snapshot_repository_scoped(&repository, &self.exclusions()?)?;
        self.record_source_files(&repository, &base)?;
        self.emit(EventKind::Approved { base })
    }

    pub fn edit_draft_graph(&mut self, graph: Graph, mut config: Config) -> Result<(), String> {
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
                "Environment domain was already initialized; create a new Run to change its policy"
                    .into(),
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
                !names.contains(node.name.as_str()) && self.state.nodes[&node.name].status == "done"
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
        let source_head = workspace::snapshot_repository_scoped(&repository, &self.exclusions()?)?;
        self.record_source_files(&repository, &source_head)?;
        self.emit(EventKind::GraphRevised {
            graph,
            planning_id: planning.planning_id.clone(),
            planning,
            invalidated,
            source_head: Some(source_head),
        })
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
            resolve_repository(
                &self.root,
                self.state.config.as_ref().ok_or("Missing config")?,
            )?;
        }
        self.emit(EventKind::Paused { paused })
    }

    /// Record a turn addressed to a completed node without changing its result
    /// or scheduling another execution. The finished Pi process cannot be steered.
    pub fn message_done_node(
        &mut self,
        node: &str,
        instruction: &str,
        images: Option<Vec<ImageAttachment>>,
    ) -> Result<(), String> {
        if !self.state.approved
            || self.state.nodes.get(node).map(|n| n.status.as_str()) != Some("done")
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
        // Failed executions also retain a session, even without a result head.
        // Replies on a node's unique terminal workspace update that shared tree
        // directly, so completed descendants remain valid and stay done.
        self.validate_invalidation(node)?;
        let shared_workspace = self.terminal_workspace_for(node).is_some();
        self.emit(EventKind::Invalidated {
            nodes: vec![node.into()],
            target: node.into(),
            instruction: instruction.trim().into(),
            human: true,
            images,
            workspace: None,
            shared_workspace,
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
        if !self.is_serial() && self.state.source_files.is_some() {
            let files = self.files()?;
            if !files.exists(&format!("before-{}", anchor.id)) {
                return Err("Historical ignored-file snapshot is unavailable; use a new follow-up from the current source instead".into());
            }
        }
        if let Some(store) = self.environments()? {
            let input = anchor
                .input
                .as_ref()
                .ok_or("Historical environment input is unavailable")?;
            store.validate_result_metadata(input)?;
        }
        let start = self
            .state
            .events
            .iter()
            .position(|event| {
                matches!(
                &event.kind, EventKind::Started { execution } if execution.id == execution_id
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
        let branch = crate::session_branch::branch_before_user(
            &self.root.join("sessions").join(&first_id),
            &anchor.session_id,
            Path::new(&anchor.worktree),
            old_text,
            anchor.started_at,
            anchor.completed_at.unwrap_or(u64::MAX),
        )?;
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
            return Err(match branch.rollback() {
                Ok(()) => error,
                Err(rollback) => format!("{error}; {rollback}"),
            });
        }
        Ok(())
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
            workspace::check_shadow_source(&repository, self.latest_source_head())?;
        }
        Ok(())
    }

    pub fn resolved(&mut self, node: &str) -> Result<(), String> {
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
        let mut files_version = None;
        if self.state.nodes[node]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("ignored"))
        {
            let files = self.files()?;
            let mut parents = self
                .state
                .source_files
                .as_ref()
                .map(|source| vec![source.version.clone()])
                .unwrap_or_default();
            let mut inputs = self.parents(node);
            inputs.push(node.into());
            for name in inputs {
                if let Some(version) = &self.state.nodes[&name].files_version {
                    if files.exists(version) {
                        parents.push(version.clone());
                    }
                }
            }
            if let Some(input) = &self.state.nodes[node].feedback_workspace {
                let version = format!("after-{}", input.source_execution_id);
                if files.exists(&version) {
                    parents.push(version);
                }
            }
            let version = Uuid::new_v4().to_string();
            files.capture(path, &version, &head, &parents)?;
            files_version = Some(version);
        }
        // This was a preparation failure, not a completed node task. Commit
        // the resolved inputs without emitting a fictitious Finished event.
        self.emit(EventKind::WorkspaceResolved {
            execution_id: execution.id,
            head,
            nodes: downstream(&self.state.graph, node).into_iter().collect(),
            files_version,
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

    fn busy_feedback_nodes(&self) -> BTreeSet<String> {
        self.state
            .graph
            .edges
            .iter()
            .filter(|edge| edge.feedback)
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
                "publishing" | "merging" | "publication_failed" | "completed"
            )
        {
            return Ok(Vec::new());
        }
        self.drain_feedback()?;
        let config = self.state.config.clone().ok_or("Missing config")?;
        if !self.is_serial() {
            let files = self.files()?;
            if self.state.source_files.as_ref().is_none_or(|source| {
                source.head != self.latest_source_head() || !files.exists(&source.version)
            }) {
                let repository = resolve_repository(&self.root, &config)?;
                let head = self.latest_source_head().to_owned();
                self.record_source_files(&repository, &head)?;
            }
        }
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
        let mut busy_feedback = self.busy_feedback_nodes();
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
                        .all(|edge| self.state.nodes[&edge.from].status == "done")
            })
            .take(available)
            .cloned()
            .collect();
        let mut jobs = Vec::new();
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
            let mut before = self.state.nodes[&node.name]
                .head
                .clone()
                .unwrap_or_else(|| source_head.clone());
            let resume = if self.state.nodes[&node.name].human_instruction {
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
                let origin = self
                    .state
                    .executions
                    .iter()
                    .find(|execution| execution.session_id == previous.session_id)
                    .unwrap_or(previous);
                let suffix = format!("_{}.jsonl", previous.session_id);
                let persisted = fs::read_dir(self.root.join("sessions").join(&origin.id))
                    .ok()
                    .is_some_and(|entries| {
                        entries
                            .filter_map(Result::ok)
                            .any(|entry| entry.file_name().to_string_lossy().ends_with(&suffix))
                    });
                if !persisted && self.state.nodes[&node.name].feedback_workspace.is_some() {
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
                if let Some(source) = self
                    .state
                    .executions
                    .iter()
                    .find(|execution| execution.id == input.source_execution_id)
                {
                    workspace_lineage.extend(source.workspace_lineage.iter().cloned());
                }
                input.worktree.clone()
            } else if self.is_serial() {
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
                    path.is_dir() && !busy(path)
                });
                let available_parent = inherited_parent.or_else(|| {
                    parent_executions
                        .iter()
                        .find(|execution| !busy(Path::new(&execution.worktree)))
                });
                if let Some(parent) = available_parent {
                    // A one-to-one edge is a physical handoff. Fan-in folds all
                    // dependency lineages into the selected parent's live slot.
                    if parent_executions.len() > 1 {
                        workspace_lineage.extend(self.dependency_ancestors(&node.name));
                    } else if self.has_single_consumer(&parent.node) {
                        workspace_lineage.extend(parent.workspace_lineage.iter().cloned());
                        workspace_lineage.insert(parent.node.clone());
                    }
                    let selected_path = if inherited_parent.is_some() {
                        parent.worktree.clone()
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
                    }
                    self.idle_workspace_path()
                        .map(|path| path.to_string_lossy().into())
                        .unwrap_or_else(fresh_path)
                }
            };
            workspace_lineage.insert(node.name.clone());
            if self
                .state
                .executions
                .iter()
                .any(|execution| execution.status == "running" && execution.worktree == worktree)
            {
                continue;
            }
            let workspace_lineage: Vec<_> = workspace_lineage.into_iter().collect();
            let session_fork = resume
                .filter(|previous| previous.worktree != worktree || feedback_workspace.is_some())
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
            let execution = Execution {
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
            let state = &self.state.nodes[&node.name];
            let task = if state.instruction.is_empty() {
                node.task.clone()
            } else if state.human_instruction {
                // A follow-up is its own user request in a fresh execution,
                // not an addendum to the original node task.
                state.instruction.clone()
            } else {
                format!("{}\n{}", node.task, state.instruction)
            };
            let images = state.instruction_images.clone();
            let feedback_source = self
                .state
                .graph
                .edges
                .iter()
                .any(|edge| edge.feedback && edge.from == node.name);
            let mut file_versions = Vec::new();
            let mut previous_file_version = None;
            let history_edit = state.edit_execution_id.is_some();
            if !self.is_serial() {
                let files = self.files()?;
                if let Some(source) = &self.state.source_files {
                    file_versions.push(source.version.clone());
                }
                for parent in self.parents(&node.name) {
                    if let Some(version) = &self.state.nodes[&parent].files_version {
                        if files.exists(version) {
                            file_versions.push(version.clone());
                        }
                    }
                }
                previous_file_version = if let Some(version) = &state.files_override {
                    Some(version.clone())
                } else if let Some(input) = &feedback_workspace {
                    Some(format!("after-{}", input.source_execution_id))
                } else if let Some(input) = &state.feedback_workspace {
                    self.state
                        .executions
                        .iter()
                        .rev()
                        .find(|previous| {
                            previous.node == node.name
                                && previous.worktree == input.worktree
                                && previous.completed_at.is_some()
                        })
                        .map(|previous| {
                            let after = format!("after-{}", previous.id);
                            if files.exists(&after) {
                                after
                            } else {
                                format!("before-{}", previous.id)
                            }
                        })
                        .filter(|version| files.exists(version))
                        .or_else(|| Some(format!("after-{}", input.source_execution_id)))
                } else if let Some(previous) = resume {
                    let after = format!("after-{}", previous.id);
                    if state.edit_execution_id.is_some() || !files.exists(&after) {
                        Some(format!("before-{}", previous.id))
                    } else {
                        Some(after)
                    }
                } else {
                    None
                }
                .filter(|version| files.exists(version));
                if previous_file_version.is_none() {
                    previous_file_version = state
                        .files_version
                        .clone()
                        .filter(|version| files.exists(version));
                }
                if previous_file_version.is_none() {
                    previous_file_version = state
                        .feedback_workspace
                        .as_ref()
                        .map(|input| format!("after-{}", input.source_execution_id))
                        .filter(|version| files.exists(version));
                }
                if let Some(version) = &previous_file_version {
                    file_versions.push(version.clone());
                }
            }
            let mut environment_input = None;
            let preserve_failed_environment = !history_edit
                && resume.is_some_and(|previous| {
                    previous.status == "failed"
                        && previous.worktree == execution.worktree
                        && Path::new(&execution.worktree).is_dir()
                });
            if let Some(store) = self.environments()? {
                let selected = (|| -> Result<_, String> {
                    if !history_edit
                        && feedback_workspace.is_none()
                        && resume.is_some_and(|previous| {
                            previous.status == "failed"
                                && (previous.worktree != execution.worktree
                                    || !Path::new(&previous.worktree).is_dir())
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
                        store.select(&node.name, &inputs)?
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
                    store.validate_result_metadata(&selected)?;
                    self.files()?.validate(&selected.resource_refs)?;
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
                        file_versions.extend(input.resource_refs.iter().cloned());
                        if history_edit {
                            file_versions = input.resource_refs.clone();
                            previous_file_version = input.resource_refs.last().cloned();
                        }
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
            self.emit(EventKind::Started {
                execution: execution.clone(),
            })?;
            let previous_environment_launch = if history_edit {
                self.state
                    .nodes
                    .get(&execution.node)
                    .and_then(|node| node.result.as_ref())
                    .filter(|result| result.layout.as_deref() == Some(&execution.worktree))
                    .map(|result| result.launch_ref.clone())
            } else {
                None
            };
            jobs.push(Job {
                execution,
                run_id: self.state.run_id.clone(),
                parent_heads,
                config: config.clone(),
                task,
                images,
                resume_execution_id,
                session_fork,
                feedback_workspace,
                inherit_workspace,
                file_versions,
                previous_file_version,
                history_edit,
                feedback_source,
                expected_source_head: source_head,
                environment_input,
                previous_environment_launch,
                preserve_failed_environment,
            });
        }
        if allow_publication
            && pending_sources.is_empty()
            && self.state.pending_feedback.is_empty()
            && jobs.is_empty()
            && !self.active()
            && !matches!(self.state.phase.as_str(), "completed" | "needs_attention")
        {
            if !self.is_serial() && self.state.nodes.values().all(|node| node.status == "done") {
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
                let repository = resolve_repository(&self.root, &config)?
                    .canonicalize()
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .into();
                self.emit(EventKind::PublicationStarted { repository, heads })?;
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
                    .is_none_or(|node| node.status != "done")
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
            if let Some(config) = self.state.config.clone() {
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
            .any(|execution| &execution.worktree != path)
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

    fn path_is_running(&self, path: &Path) -> bool {
        self.state
            .result_execution
            .as_ref()
            .is_some_and(|e| e.status == "running" && e.input.layout.as_deref() == path.to_str())
            || self.state.executions.iter().any(|execution| {
                execution.status == "running" && Path::new(&execution.worktree) == path
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
        if self
            .state
            .config
            .as_ref()
            .and_then(|c| c.environment.as_ref())
            .is_none()
        {
            return false;
        }
        self.state.pending_feedback.iter().any(|pending| {
            self.state
                .executions
                .iter()
                .any(|e| e.id == pending.execution_id && Path::new(&e.worktree) == path)
        }) || self.state.nodes.iter().any(|(name, node)| {
            Some(name.as_str()) != owner
                && node
                    .feedback_workspace
                    .as_ref()
                    .is_some_and(|w| Path::new(&w.worktree) == path)
        }) || self.state.executions.iter().any(|e| {
            e.status == "failed"
                && Some(e.node.as_str()) != owner
                && Path::new(&e.worktree) == path
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
    /// Git refs and ignored-file snapshots are durable, so retired branches can
    /// be recreated from those inputs if they are needed again.
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
                if let Ok(path) = Path::new(&input.worktree).canonicalize() {
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
                if !self.is_serial() && self.state.nodes[&execution.node].baseline_head.is_some() {
                    let files = self.files()?;
                    let baseline = self.state.nodes[&execution.node]
                        .baseline_files_version
                        .clone()
                        .filter(|version| files.exists(version))
                        .or_else(|| {
                            self.state
                                .source_files
                                .as_ref()
                                .map(|source| source.version.clone())
                                .filter(|version| files.exists(version))
                        })
                        .unwrap_or_else(|| format!("before-{}", execution.id));
                    let after = format!("after-{}", execution.id);
                    if files.exists(&baseline)
                        && files.exists(&after)
                        && !files.same_contents(&baseline, &after)?
                    {
                        terminal.push(EventKind::WorkspaceFilesChanged {
                            execution_id: execution.id.clone(),
                        });
                    }
                }
                if let Some((input, result)) = composite {
                    if input.environment_ref != result.environment_ref
                        || input.launch_ref != result.launch_ref
                    {
                        terminal.push(EventKind::WorkspaceFilesChanged {
                            execution_id: execution.id.clone(),
                        });
                    }
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
                let error = if self.state.stop_requested && error.starts_with("Pi exited with ") {
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
                if error.starts_with("Workspace composition blocked") {
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

    fn resolve_feedback(
        &mut self,
        pending: &PendingFeedback,
        output: Option<&str>,
    ) -> Result<(), String> {
        let edge = self
            .state
            .graph
            .edges
            .iter()
            .find(|edge| edge.feedback && edge.from == pending.from && edge.to == pending.to)
            .cloned();
        let valid = edge.is_some()
            && self.state.nodes.get(&pending.from).is_some_and(|node| {
                node.status == "done" && node.head.as_deref() == Some(&pending.source_head)
            })
            && self.state.nodes.get(&pending.to).is_some_and(|node| {
                node.head == pending.target_head && node.revision == pending.target_revision
            })
            && !self
                .state
                .superseded_execution_ids
                .contains(&pending.execution_id);
        if !valid {
            return self.emit(EventKind::FeedbackResolved {
                execution_id: pending.execution_id.clone(),
                disposition: "superseded".into(),
            });
        }
        let edge = edge.ok_or("No feedback edge")?;
        if self.feedback_source_busy(&pending.from) {
            return Ok(());
        }
        let mut events = Vec::new();
        let disposition;
        if !pending.accepted && !self.feedback_budget_available(&edge) {
            disposition = "exhausted";
            events.push(EventKind::FeedbackExhausted {
                from: pending.from.clone(),
                to: pending.to.clone(),
                execution_id: pending.execution_id.clone(),
                count: self
                    .state
                    .feedback_counts
                    .get(&format!("{}->{}", pending.from, pending.to))
                    .copied()
                    .unwrap_or(0),
                limit: self
                    .state
                    .config
                    .as_ref()
                    .ok_or("Missing config")?
                    .max_feedback
                    .min(3),
            });
        } else {
            disposition = if pending.accepted {
                "accepted"
            } else {
                "applied"
            };
            events.push(EventKind::Feedback {
                from: pending.from.clone(),
                to: pending.to.clone(),
                accepted: pending.accepted,
            });
            if !pending.accepted {
                let stored;
                let output = if let Some(output) = output {
                    output
                } else {
                    stored = self
                        .store
                        .execution_log_page(
                            &self.state.run_id,
                            &pending.execution_id,
                            pending.output_offset,
                            pending.output_bytes,
                        )?
                        .content;
                    if stored.len() != pending.output_bytes {
                        return Err("Feedback output range is incomplete".into());
                    }
                    &stored
                };
                let body = engine::feedback_body(output)?;
                let source = self
                    .state
                    .executions
                    .iter()
                    .find(|execution| execution.id == pending.execution_id)
                    .ok_or("Missing feedback execution")?;
                let target = self
                    .state
                    .executions
                    .iter()
                    .rev()
                    .find(|execution| {
                        execution.node == pending.to && execution.completed_at.is_some()
                    })
                    .ok_or("Missing feedback target session")?;
                events.push(EventKind::Invalidated {
                    nodes: downstream(&self.state.graph, &pending.to)
                        .into_iter()
                        .collect(),
                    target: pending.to.clone(),
                    instruction: format!("Feedback from {}:\n{body}", pending.from),
                    human: false,
                    images: None,
                    workspace: Some(FeedbackWorkspace {
                        source_execution_id: source.id.clone(),
                        target_execution_id: target.id.clone(),
                        worktree: source.worktree.clone(),
                        head: pending.source_head.clone(),
                    }),
                    shared_workspace: false,
                });
            }
        }
        events.push(EventKind::FeedbackResolved {
            execution_id: pending.execution_id.clone(),
            disposition: disposition.into(),
        });
        self.emit_outputs(events)
    }

    fn publication_file_inputs(
        &self,
        repository: &Path,
        heads: &[String],
    ) -> Result<Option<(crate::workspace_files::Files, Vec<String>, String)>, String> {
        let files = self.files()?;
        // Git heads are not resource identities: ignored-only attempts can all
        // share one head. Select current terminal outputs, never old attempts.
        let mut versions: Vec<_> = self
            .state
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
            .filter(|node| {
                self.state.nodes[&node.name]
                    .head
                    .as_ref()
                    .is_some_and(|head| heads.contains(head))
            })
            .filter_map(|node| self.state.nodes[&node.name].files_version.clone())
            .filter(|version| files.exists(version))
            .collect();
        if versions.is_empty() {
            return Ok(None);
        }
        let parents = self
            .state
            .source_files
            .as_ref()
            .filter(|source| files.exists(&source.version))
            .map(|source| vec![source.version.clone()])
            .unwrap_or_default();
        let current = Uuid::new_v4().to_string();
        let head = workspace::repository_git(repository, &["rev-parse", "HEAD"])?;
        files.capture(repository, &current, &head, &parents)?;
        versions.push(current.clone());
        Ok(Some((files, versions, current)))
    }

    /// Select immutable publication inputs under the actor; actual native
    /// baseline/byte validation happens before Git publication, outside it.
    pub(crate) fn publication_environment_input(
        &self,
    ) -> Result<
        Option<(
            crate::environment::Environments,
            crate::environment::CompositeResult,
        )>,
        String,
    > {
        let Some(store) = self.environments()? else {
            return Ok(None);
        };
        let selected = store.select("$publication", &self.terminal_results()?)?;
        if self
            .state
            .environment_baseline
            .as_ref()
            .is_none_or(|baseline| baseline.domain != selected.domain)
        {
            return Err("Publication input differs from the frozen native domain".into());
        }
        store.validate_result_metadata(&selected)?;
        Ok(Some((store, selected)))
    }

    pub(crate) fn validate_publication_files(
        &self,
        repository: &Path,
        heads: &[String],
    ) -> Result<(), String> {
        self.publication_environment_input()?;
        if let Some((files, versions, _)) = self.publication_file_inputs(repository, heads)? {
            files.validate(&versions)?;
        }
        Ok(())
    }

    pub fn result_descriptor(&self) -> Result<crate::environment::ResultDescriptor, String> {
        let descriptor = self
            .state
            .published_result
            .clone()
            .ok_or("No managed result has been published")?;
        let store = self.environments()?.ok_or("No managed environment store")?;
        store.validate_result_metadata(&descriptor.result)?;
        self.files()?
            .validate_manifest_refs(&descriptor.result.resource_refs)?;
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
            .ok_or("No managed result has been published")?;
        let config = self.state.config.clone().ok_or("Missing config")?;
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
        let Some(store) = self.environments()? else {
            return Ok(None);
        };
        let selected = store.select("$publication", &self.terminal_results()?)?;
        let path = Path::new(
            selected
                .layout
                .as_deref()
                .ok_or("Published environment has no native layout")?,
        );
        if self.path_is_running(path) {
            return Err("Cannot publish a launch descriptor over a live writer".into());
        }
        store.files.verify(path, &selected.environment_ref, "")?;
        let repository = resolve_repository(
            &self.root,
            self.state.config.as_ref().ok_or("Missing config")?,
        )?;
        let code = workspace::prepare_with_merger_expected_for_run(
            &repository,
            path,
            head,
            &[],
            head,
            Some(&self.state.run_id),
            || Err("Publication descriptor requires a clean composed code result".into()),
        )?;
        let files = self.files()?;
        let parents: Vec<_> = self
            .terminal_results()?
            .iter()
            .flat_map(|(_, result)| result.resource_refs.clone())
            .collect();
        let published_resources = Uuid::new_v4().to_string();
        files.capture(&repository, &published_resources, head, &parents)?;
        let versions = vec![published_resources];
        files.materialize(path, &versions, None, false)?;
        let resources = Uuid::new_v4().to_string();
        files.capture(path, &resources, &code, &versions)?;
        let result = crate::environment::CompositeResult {
            code_ref: code,
            resource_refs: vec![resources],
            ..selected
        };
        Ok(Some(store.descriptor(&self.state.run_id, &result)?))
    }

    pub(crate) fn publish_workspace_files(
        &self,
        repository: &Path,
        heads: &[String],
    ) -> Result<(), String> {
        if let Some((files, versions, current)) = self.publication_file_inputs(repository, heads)? {
            files.materialize(repository, &versions, Some(&current), true)?;
        }
        Ok(())
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
                let mut exclusions = store.exclusions(&job.descriptor.result.launch_ref)?;
                let files = crate::workspace_files::Files::new(&job.root, &job.run_id)?
                    .with_exclusions(&exclusions);
                files.validate(&job.descriptor.result.resource_refs)?;
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
                    if let Some(version) = job.descriptor.result.resource_refs.last() {
                        files.verify(path, version, &job.descriptor.result.code_ref)?;
                    }
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
                    files.materialize(path, &job.descriptor.result.resource_refs, None, false)?;
                }
                let generation = &job.input.generation;
                let head = workspace::snapshot_node_scoped(
                    path,
                    &repository,
                    "result",
                    Some(&job.run_id),
                    &exclusions,
                )?;
                let before_files = format!("before-{generation}");
                files.capture(
                    path,
                    &before_files,
                    &head,
                    &job.descriptor.result.resource_refs,
                )?;
                let input = store.prepare(
                    path,
                    &job.descriptor.result,
                    generation,
                    &head,
                    vec![before_files.clone()],
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
                let mut command = crate::native::execution_command(
                    engine::PiRole::NodeAgent,
                    &repository,
                    path,
                    &job.root,
                    &session,
                )?;
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
                let after_files = format!("after-{generation}");
                let files = crate::workspace_files::Files::new(&job.root, &job.run_id)?
                    .with_exclusions(&exclusions);
                files.capture(path, &after_files, &head, &[before_files])?;
                let result = store.seal(path, &input, &head, vec![after_files])?;
                let descriptor = store.descriptor(&job.run_id, &result)?;
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
    let files = if path != repository {
        Some(crate::workspace_files::Files::new(root, &job.run_id)?.with_exclusions(&exclusions))
    } else {
        None
    };
    let environments = job
        .config
        .environment
        .as_ref()
        .map(|config| crate::environment::Environments::new(root, &job.run_id, config))
        .transpose()?;
    if let (Some(store), Some(input)) = (&environments, &job.environment_input) {
        store.validate_result(input)?;
        if job.feedback_workspace.is_some() {
            store
                .scoped_files(&input.launch_ref)?
                .verify(path, &input.environment_ref, "")?;
        }
    }
    if let Some(input) = &job.feedback_workspace {
        let owner = path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str());
        let bucket = path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|name| name.to_str());
        if owner != Some(&job.run_id) || bucket != Some(".grapher-worktrees") || !reused {
            return Err("Feedback requires an existing worktree owned by this Run".into());
        }
        let feedback_head = workspace::git(path, &["rev-parse", "HEAD"])?;
        let feedback_status = workspace::repository_status(path, &exclusions)?;
        if feedback_head != input.head || !feedback_status.is_empty() {
            return Err("Feedback workspace changed after completion".into());
        }
        if let Some(target) = &job.session_fork {
            if let Some(head) = &target.after {
                workspace::verify_prepared_ancestor(path, head)?;
            }
        }
        if let Some(version) = &job.previous_file_version {
            files
                .as_ref()
                .ok_or("Missing feedback file store")?
                .verify(path, version, &input.head)?;
        }
    }
    #[cfg(not(feature = "fixture"))]
    if path != repository {
        crate::native::require_graph_execution()?;
    }
    let parent_refs = if job.parent_heads.is_empty() {
        parents
    } else {
        &job.parent_heads
    };
    let mut input_heads = parent_refs.to_vec();
    if job.history_edit && environments.is_some() {
        input_heads.clear();
    }
    if path != repository
        && job.execution.before != job.expected_source_head
        && !(job.history_edit && environments.is_some())
    {
        // Continuations keep their own result and dependency inputs, while also
        // receiving source files written by a subsequent Planner turn.
        workspace::pin_repository_head(&repository, &job.expected_source_head)?;
        if !input_heads.contains(&job.expected_source_head) {
            input_heads.push(job.expected_source_head.clone());
        }
    }
    let inherited_head = workspace::git(path, &["rev-parse", "HEAD"]).ok();
    let can_inherit = job.inherit_workspace
        && !job.history_edit
        && inherited_head.as_deref().is_some_and(|head| {
            (!job.parent_heads.is_empty() && job.parent_heads.iter().any(|parent| parent == head)
                || job.execution.workspace_lineage.len() > 1 && job.parent_heads.is_empty())
                && job.parent_heads.iter().all(|parent| {
                    workspace::git(path, &["merge-base", "--is-ancestor", parent, head]).is_ok()
                })
                && workspace::git(
                    path,
                    &[
                        "merge-base",
                        "--is-ancestor",
                        &job.expected_source_head,
                        head,
                    ],
                )
                .is_ok()
        })
        && workspace::repository_status(path, &exclusions).is_ok_and(|status| status.is_empty())
        && workspace::git(path, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_err();
    let before = if can_inherit {
        inherited_head.unwrap_or_else(|| job.execution.before.clone())
    } else {
        workspace::prepare_with_merger_expected_for_run(
            &repository,
            path,
            &job.execution.before,
            &input_heads,
            &job.expected_source_head,
            Some(&job.run_id),
            || {
                let attempt = job.execution.attempt;
                crate::graph_merge::resolve_with_merger_for_node(
                    path,
                    &job.task,
                    &job.config,
                    root,
                    attempt,
                    &format!("merge:{}", job.execution.node),
                    &mut on_merger_event,
                )
            },
        )?
    };
    let before_files = format!("before-{}", job.execution.id);
    if let Some(files) = &files {
        let mut versions = job.file_versions.clone();
        let editing = job.history_edit;
        let mut previous = job.previous_file_version.clone();
        // Keep partial ignored work on an ordinary continuation. History edits
        // instead restore the selected pre-execution file snapshot exactly.
        let preserve = reused
            && !editing
            && (job.inherit_workspace
                || job.resume_execution_id.is_some()
                || job.session_fork.is_some()
                || job.feedback_workspace.is_some());
        if preserve {
            let live = Uuid::new_v4().to_string();
            let parents = previous
                .clone()
                .map(|version| vec![version])
                .unwrap_or_else(|| versions.clone());
            files.capture(path, &live, &before, &parents)?;
            versions.push(live.clone());
            previous = Some(live);
        }
        files.materialize(path, &versions, previous.as_deref(), preserve)?;
        files.capture(path, &before_files, &before, &versions)?;
    }
    let environment_input = if let Some(store) = &environments {
        Some(
            store.prepare(
                path,
                selected_environment
                    .as_ref()
                    .ok_or("Missing managed environment input")?,
                &job.execution.id,
                &before,
                vec![before_files.clone()],
                job.preserve_failed_environment,
                job.history_edit || !reused,
            )?,
        )
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
    let output = engine::execute(
        &job.config,
        &execution_view,
        &job.task,
        job.feedback_source,
        job.resume_execution_id.as_deref(),
        job.images.as_deref(),
        root,
        on_output,
    )?;
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
    let head = if environments.is_some() {
        workspace::snapshot_node_scoped(
            path,
            &repository,
            &job.execution.node,
            Some(&job.run_id),
            &exclusions,
        )?
    } else {
        workspace::snapshot_execution_for_run(
            path,
            &repository,
            &job.execution.node,
            Some(&job.run_id),
        )?
    };
    if files.is_some() {
        let files =
            crate::workspace_files::Files::new(root, &job.run_id)?.with_exclusions(&exclusions);
        files.capture(
            path,
            &format!("after-{}", job.execution.id),
            &head,
            &[before_files],
        )?;
    }
    if let (Some(store), Some(input)) = (&environments, &environment_result_input) {
        store.prove_accelerator(&repository, path, input)?;
        store.seal(
            path,
            input,
            &head,
            vec![format!("after-{}", job.execution.id)],
        )?;
    }
    Ok((head, output))
}
