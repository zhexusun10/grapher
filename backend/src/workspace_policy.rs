//! Workspace choice belongs to a dispatch batch, never to graph width or phase.
use super::*;
use std::collections::BTreeMap;

impl Runtime {
    /// Missing selection identifies legacy Runs, whose existing ownership
    /// contract is replayed without changing directories underneath them.
    pub(crate) fn batch_workspaces(&self) -> bool {
        !self.is_serial() && self.state.isolated_workspaces.is_some()
    }

    pub(crate) fn shared_source_workspace(&self) -> bool {
        self.batch_workspaces() && self.state.isolated_workspaces == Some(false)
    }

    /// Recycling a slot and visiting it with Planner are different rights.
    /// Retain failed partial work against allocation without hiding it from repair.
    pub(super) fn allocation_workspace_reserved(&self, path: &Path, owner: Option<&str>) -> bool {
        (self.batch_workspaces()
            && self.state.executions.iter().any(|execution| {
                execution.status == "failed"
                    && Some(execution.node.as_str()) != owner
                    && !self.state.superseded_execution_ids.contains(&execution.id)
                    && self
                        .state
                        .nodes
                        .get(&execution.node)
                        .is_some_and(|node| node.status != "completed")
                    && Self::same_workspace_path(Path::new(&execution.worktree), path)
            }))
            || self.workspace_reserved(path, owner)
    }

    pub(super) fn batch_recovery_was_delivered(&self, execution: &Execution) -> bool {
        self.state
            .events
            .iter()
            .rev()
            .find_map(|event| match &event.kind {
                EventKind::BatchRecoveryCaptured { heads } => heads.get(&execution.id),
                _ => None,
            })
            .is_some_and(|head| self.state.published_heads.contains(head))
    }

    /// No next batch can start until all previous writers drain and their
    /// successful private results reach source. Explicit retries additionally
    /// deliver their retained partial work, without marking it completed.
    pub(super) fn prepare_execution_batch(
        &mut self,
        ready: &[Node],
        allow_delivery: bool,
    ) -> Result<bool, String> {
        if !self.batch_workspaces() {
            return Ok(true);
        }
        if self.active() {
            return Ok(false);
        }
        let config = self.state.config.as_ref().ok_or("Missing config")?;
        let repository = resolve_repository(&self.root, config)?;
        let mut heads = BTreeSet::new();
        for execution in &self.state.executions {
            if execution.status == "completed"
                && self.state.nodes.contains_key(&execution.node)
                && !self.state.superseded_execution_ids.contains(&execution.id)
                && !Self::same_workspace_path(Path::new(&execution.worktree), &repository)
            {
                if let Some(head) = execution
                    .after
                    .as_ref()
                    .filter(|head| !head.is_empty() && !self.state.published_heads.contains(head))
                {
                    heads.insert(head.clone());
                }
            }
        }
        // A business entry is a separate writer: its accepted result advances
        // current code without rewriting any node execution's historical `after`.
        if let Some(result) = self
            .state
            .result_execution
            .as_ref()
            .filter(|execution| execution.status == "completed")
            .and_then(|execution| execution.result.as_ref())
        {
            let head = &result.code_ref;
            if !head.is_empty()
                && self.state.published_head.as_ref() != Some(head)
                && !self.state.published_heads.contains(head)
            {
                heads.insert(head.clone());
            }
        }
        let mut recoveries = Vec::new();
        for node in ready {
            let node_state = &self.state.nodes[&node.name];
            let Some(previous) = self.state.executions.iter().rev().find(|execution| {
                execution.node == node.name
                    && !self.state.superseded_execution_ids.contains(&execution.id)
            }) else {
                continue;
            };
            if previous.status == "resolved" {
                // Manual resolution already captured immutable inputs, not a
                // completed task. Deliver only the still-selected resolution;
                // an invalidated descendant must not revive its abandoned input.
                if let Some(head) = self
                    .state
                    .events
                    .iter()
                    .rev()
                    .find_map(|event| match &event.kind {
                        EventKind::WorkspaceResolved { execution_id, head, .. }
                            if execution_id == &previous.id => Some(head),
                        _ => None,
                    })
                    .filter(|head| {
                        node_state.head.as_ref() == Some(*head)
                            && !head.is_empty()
                            && !self.state.published_heads.contains(head)
                    })
                {
                    heads.insert(head.clone());
                }
                continue;
            }
            if !node_state.continuation && !node_state.human_instruction {
                continue; // invalidated descendants recompute, not resume doomed work
            }
            if previous.status != "failed"
                || Self::same_workspace_path(Path::new(&previous.worktree), &repository)
                || self.batch_recovery_was_delivered(previous)
            {
                continue;
            }
            if self
                .state
                .executions
                .iter()
                .rev()
                .find(|execution| {
                    Self::same_workspace_path(
                        Path::new(&execution.worktree),
                        Path::new(&previous.worktree),
                    )
                })
                .is_some_and(|owner| owner.id != previous.id)
            {
                return Err("Retained private recovery workspace was reassigned; refusing to capture another execution".into());
            }
            // A failure before allocating a slot has no project work to move.
            // Missing prepared/observed work, however, must fail explicitly in
            // the handoff worker instead of silently restarting in source.
            let prepared = self.state.events.iter().any(|event| {
                matches!(&event.kind,
                EventKind::Prepared { execution_id, .. } if execution_id == &previous.id)
            });
            if prepared
                || previous.pid.is_some()
                || previous.output_bytes > 0
                || Path::new(&previous.worktree).exists()
            {
                recoveries.push(previous.id.clone());
            }
        }
        if !heads.is_empty() || !recoveries.is_empty() {
            if allow_delivery {
                self.emit_outputs(vec![
                    EventKind::BatchHandoffRequested {
                        recovery_execution_ids: recoveries,
                    },
                    EventKind::PublicationStarted {
                        repository: repository.to_string_lossy().into_owned(),
                        heads: heads.into_iter().collect(),
                    },
                ])?;
            }
            return Ok(false);
        }
        if ready.is_empty() {
            return Ok(true);
        }

        // The ready group is already dependency/feedback filtered and capped by
        // maxParallel. A preparation failure never changes a live batch's cwd.
        let isolated = config.isolate_parallel_nodes && ready.len() > 2;
        let mut events = Vec::new();
        if isolated {
            #[cfg(not(feature = "fixture"))]
            crate::native::require_graph_execution()?;
            let environment =
                if config.environment.is_none() && self.state.environment_policy.is_some() {
                    let (environment, reason) =
                        crate::environment_automatic::resolve(&repository, false)?;
                    events.push(EventKind::EnvironmentPolicyResolved {
                        environment: environment.clone(),
                        reason,
                    });
                    environment
                } else {
                    config.environment.clone()
                };
            if let Some(policy) = &environment {
                if self.state.environment_baseline.is_none() {
                    policy.validate()?;
                    let store = crate::environment::Environments::new(
                        &self.root,
                        &self.state.run_id,
                        policy,
                    )?;
                    let result = store.initialize(&repository)?;
                    events.push(EventKind::EnvironmentInitialized { result });
                }
            }
        }
        events.push(EventKind::ExecutionBatchStarted {
            nodes: ready.iter().map(|node| node.name.clone()).collect(),
            isolated,
        });
        self.emit_outputs(events)?;
        Ok(true)
    }

    /// Runs outside the Run mutex, after the whole prior batch has drained.
    /// Capture only project bytes; private environments stay in their own slot.
    pub(crate) fn capture_batch_recovery(
        root: &Path,
        run_id: &str,
        config: &Config,
        execution: &Execution,
    ) -> Result<String, String> {
        let repository = resolve_repository(root, config)?;
        let path = Path::new(&execution.worktree);
        let run_root = PathBuf::from(workspace::normalize_workspace_display_path(
            &workspace::workspaces_parent(root)
                .join(".grapher-worktrees")
                .join(run_id),
        ));
        if crate::path_safety::real_child_path(&run_root, path, false)?.is_none()
            || Self::same_workspace_path(path, &repository)
            || !workspace::has_private_git(path)
        {
            return Err("Retained private recovery workspace is missing or reassigned; partial work was not replaced".into());
        }
        let base = if execution.before.is_empty() {
            workspace::git(path, &["rev-parse", "refs/grapher/base"])?
        } else {
            execution.before.clone()
        };
        workspace::verify_prepared_ancestor(path, &base)?;
        let mut exclusions = config
            .environment
            .as_ref()
            .map(|policy| policy.exclusions())
            .unwrap_or_default();
        if let (Some(policy), Some(input)) = (&config.environment, &execution.input) {
            let store = crate::environment::Environments::new(root, run_id, policy)?;
            let discovered =
                store.discover(path, input, &root.join("sessions").join(&execution.id))?;
            exclusions.extend(store.exclusions(&discovered.launch_ref)?);
        }
        let head = workspace::snapshot_node_scoped(path, &repository, &execution.node, Some(run_id), &exclusions)
            .map_err(|error| format!("Cannot hand off partial work for '{}': {error}. The private workspace is retained for repair and retry", execution.node))?;
        crate::file_changes::record_git_commit_changes(
            run_id,
            &execution.id,
            &execution.node,
            path,
            &repository,
            &base,
            &head,
        );
        Ok(head)
    }

    /// Captured heads and publication inputs become durable together. A crash
    /// after capture or partial checkout must retry these exact inputs.
    pub(crate) fn record_batch_recoveries(
        &mut self,
        heads: BTreeMap<String, String>,
    ) -> Result<Publication, String> {
        let handoff = self
            .state
            .batch_handoff
            .as_ref()
            .ok_or("Missing batch handoff")?;
        if !matches!(self.state.phase.as_str(), "publishing" | "merging")
            || heads.len() != handoff.recovery_execution_ids.len()
            || handoff
                .recovery_execution_ids
                .iter()
                .any(|id| !heads.contains_key(id))
        {
            return Err("Batch recovery inputs changed during capture".into());
        }
        let publication = self
            .state
            .publication
            .as_ref()
            .ok_or("Missing publication")?;
        let mut inputs: BTreeSet<_> = publication.heads.iter().cloned().collect();
        inputs.extend(heads.values().cloned());
        let repository = publication.repository.clone();
        self.emit_outputs(vec![
            EventKind::BatchRecoveryCaptured { heads },
            EventKind::PublicationStarted {
                repository,
                heads: inputs.into_iter().collect(),
            },
        ])?;
        self.state
            .publication
            .clone()
            .ok_or_else(|| "Missing publication".into())
    }

    /// All adaptive batches use one completion/review path, independent of
    /// whether the final batch needed publication. Human-only follow-ups do not
    /// trigger review; mixed follow-up/new-work batches still do.
    pub(crate) fn take_shared_workspace_review(&mut self) -> Result<Option<Config>, String> {
        if !self.batch_workspaces()
            || self.state.phase != "completed"
            || self.state.paused
            || self.state.stop_requested
            || self.active()
            || !self.state.pending_feedback.is_empty()
        {
            return Ok(None);
        }
        let Some(config) = self
            .state
            .effective_config()
            .filter(|config| config.post_task_review)
        else {
            return Ok(None);
        };
        let claimed = self
            .state
            .events
            .iter()
            .rev()
            .find_map(|event| match &event.kind {
                EventKind::SharedWorkspaceReviewRequested { execution_id } => self
                    .state
                    .executions
                    .iter()
                    .position(|execution| execution.id == *execution_id),
                _ => None,
            });
        let candidate =
            self.state
                .executions
                .iter()
                .enumerate()
                .rev()
                .find(|(index, execution)| {
                    claimed.is_none_or(|claimed| *index > claimed)
                        && execution.status == "completed"
                        && !self.state.superseded_execution_ids.contains(&execution.id)
                        && !self.execution_was_source_direct(execution)
                });
        let Some((_, execution)) = candidate else {
            return Ok(None);
        };
        self.emit(EventKind::SharedWorkspaceReviewRequested {
            execution_id: execution.id.clone(),
        })?;
        Ok(Some(config))
    }
}
