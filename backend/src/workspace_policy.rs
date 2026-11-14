//! Choose isolation at idle boundaries; active source workers may refill slots.
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
        let mut skip_above = None;
        self.state
            .events
            .iter()
            .rev()
            .find_map(|event| {
                if let EventKind::PausedBatchRestored {
                    handoff_sequence, ..
                } = &event.kind
                {
                    skip_above = Some(
                        skip_above
                            .map_or(*handoff_sequence, |low: i64| low.min(*handoff_sequence)),
                    );
                    return None;
                }
                if skip_above.is_some_and(|low| event.sequence > low) {
                    return None;
                }
                match &event.kind {
                    EventKind::BatchRecoveryCaptured { heads } => heads.get(&execution.id),
                    _ => None,
                }
            })
            .is_some_and(|head| self.state.published_heads.contains(head))
    }

    /// Every unfinished private member holds the batch's delivery barrier.
    /// Failure, interruption and manual input resolution are not task results.
    /// Historical delivered recoveries keep their recorded ownership semantics.
    fn unfinished_private_execution(&self, node: &str) -> Option<&Execution> {
        if !self.batch_workspaces() {
            return None;
        }
        let state = self.state.nodes.get(node)?;
        let previous = self.state.executions.iter().rev().find(|execution| {
            execution.node == node && !self.state.superseded_execution_ids.contains(&execution.id)
        })?;
        let queued = state.continuation
            || (state.human_instruction && !state.pending_messages.is_empty());
        let failed = previous.status == "failed"
            && (queued || state.status == "failed"
                || (state.status == "blocked" && self.state.node_has_own_blocked_failure(node)));
        let resolved = previous.status == "resolved"
            && self.state.events.iter().rev().find_map(|event| match &event.kind {
                EventKind::WorkspaceResolved { execution_id, head, .. }
                    if execution_id == &previous.id => Some(head),
                _ => None,
            }).is_some_and(|head| state.head.as_ref() == Some(head)
                && !self.state.published_heads.contains(head));
        (state.edit_execution_id.is_none()
            && (failed || resolved)
            && !Self::same_workspace_path(
                Path::new(&previous.worktree),
                Path::new(&self.state.config.as_ref()?.repository),
            )
            && !self.batch_recovery_was_delivered(previous))
            .then_some(previous)
    }

    /// Recovery and new human turns stay private, even with only one member
    /// left. A resolved input also needs its node task to finish before delivery.
    pub(super) fn retained_private_continuation(&self, node: &str) -> Option<&Execution> {
        let previous = self.unfinished_private_execution(node)?;
        let state = self.state.nodes.get(node)?;
        (state.continuation || (state.human_instruction && !state.pending_messages.is_empty())
            || previous.status == "resolved").then_some(previous)
    }

    /// A retained unfinished writer may run beside an already-started handoff
    /// only when neither its directory nor its execution is a publication input.
    /// Completed inputs, recovery capture, history edits and source writers stay
    /// behind the publication barrier. No isolation decision is made here.
    pub(super) fn private_continuation_during_publication(&self, node: &str) -> bool {
        if !matches!(self.state.phase.as_str(), "publishing" | "merging")
            || self.state.isolated_workspaces != Some(true)
        {
            return false;
        }
        let (Some(publication), Some(handoff), Some(previous), Some(state)) = (
            self.state.publication.as_ref(), self.state.batch_handoff.as_ref(),
            self.unfinished_private_execution(node), self.state.nodes.get(node),
        ) else { return false; };
        state.head.is_none()
            && state.feedback_workspace.is_none()
            && Path::new(&previous.worktree).is_dir()
            && !self.path_is_running(Path::new(&previous.worktree))
            && self.planner_workspace_owner(previous).is_some_and(|owner| owner.id == previous.id)
            && !self.state.executions.iter().any(|execution| {
                Self::same_workspace_path(Path::new(&execution.worktree), Path::new(&previous.worktree))
                    && (execution.status == "running"
                        || handoff.recovery_execution_ids.contains(&execution.id)
                        || execution.after.as_ref().is_some_and(|head| publication.heads.contains(head)))
            })
            && self.state.events.iter().any(|event| matches!(&event.kind,
                EventKind::Prepared { execution_id, .. } if execution_id == &previous.id))
    }

    /// Shared source workers may refill free slots without draining siblings.
    /// Private writers must all succeed before delivery or workspace switching.
    /// Explicit retries preserve unfinished work privately, never publish it.
    pub(super) fn prepare_execution_batch(
        &mut self,
        ready: &[Node],
        allow_delivery: bool,
    ) -> Result<bool, String> {
        if !self.batch_workspaces() {
            return Ok(true);
        }
        if matches!(self.state.phase.as_str(), "publishing" | "merging") {
            return Ok(!ready.is_empty() && ready.iter().all(|node|
                self.private_continuation_during_publication(&node.name)));
        }
        let active = self.active();
        if active
            && (ready.is_empty()
                || !self.shared_source_workspace()
                || matches!(
                    self.state.phase.as_str(),
                    "publishing" | "merging" | "launching_result"
                )
                || self.state.result_execution.as_ref().is_some_and(|e| e.status == "running")
                || self.state.mergers.iter().any(|e| e.status == "running"))
        {
            return Ok(false);
        }
        let config = self.state.config.as_ref().ok_or("Missing config")?;
        let repository = match resolve_repository(&self.root, config) {
            // An invalid source cannot admit replenishment. Let existing workers
            // drain before surfacing the admission error, otherwise the driver's
            // error path would discard their completion channel and log writer.
            Err(_) if active => return Ok(false),
            result => result?,
        };
        if active && self.state.executions.iter().any(|execution| {
            execution.status == "running"
                && !Self::same_workspace_path(Path::new(&execution.worktree), &repository)
        }) {
            return Ok(false);
        }
        // Retry unfinished members before delivering even completed siblings.
        // A smaller retry group is still the same private batch, not a new
        // isolation decision. Newly ready descendants must wait for delivery.
        if !ready.is_empty()
            && ready.iter().all(|node| self.retained_private_continuation(&node.name).is_some())
        {
            if active {
                return Ok(false);
            }
            for node in ready {
                let previous = self.retained_private_continuation(&node.name).unwrap();
                if self.planner_workspace_owner(previous).is_none_or(|owner| owner.id != previous.id) {
                    return Err("Retained unfinished workspace was reassigned; refusing to resume another execution's files".into());
                }
            }
            self.emit(EventKind::ExecutionBatchStarted {
                nodes: ready.iter().map(|node| node.name.clone()).collect(),
                isolated: true,
                resumed: true,
            })?;
            return Ok(true);
        }
        // Idle is not successful: one failure or pause keeps every completed
        // sibling private until the unfinished member succeeds as well.
        if self.state.nodes.keys().any(|node| self.unfinished_private_execution(node).is_some()) {
            if !active && allow_delivery && self.state.phase != "needs_attention" {
                self.emit(EventKind::Settled)?;
            }
            return Ok(false);
        }
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
        // Never create new recovery-capture handoffs. The worker can still
        // replay an old durable handoff, but new delivery contains results only.
        if !heads.is_empty() {
            // Even source-native replenishment cannot publish over live writers.
            if allow_delivery && !active {
                self.emit_outputs(vec![
                    EventKind::BatchHandoffRequested {
                        recovery_execution_ids: vec![],
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

        // Choose isolation only at an idle boundary. Replenishment stays in the
        // active source workspace even if the ready group or total concurrency
        // exceeds two; never snapshot or relocate a live writer's directory.
        // The ready group is already dependency/feedback filtered and slot-capped.
        let isolated = !active && config.isolate_parallel_nodes && ready.len() > 2;
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
            resumed: false,
        });
        self.emit_outputs(events)?;
        Ok(true)
    }

    /// Replay-only compatibility for a previously recorded recovery handoff.
    /// New retries never request capture. Runs outside the Run mutex; capture
    /// only project bytes, keeping private environments in their own slot.
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
