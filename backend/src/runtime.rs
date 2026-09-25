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
};
use uuid::Uuid;

#[derive(Clone)]
pub struct Job {
    pub execution: Execution,
    pub config: Config,
    pub task: String,
    pub resume_execution_id: Option<String>,
    pub feedback_source: bool,
    pub expected_source_head: String,
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
    pub root: PathBuf,
    _lock: RuntimeLock,
}

impl Runtime {
    pub fn open(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|error| error.to_string())?;
        let lock = acquire(root)?;
        let store = Store::open(&root.join("events.sqlite"))?;
        #[allow(unused_mut)]
        let mut state = if let Some(run) = store.runs()?.first() {
            store.load(run)?
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
            runtime.emit(EventKind::Failed { node: execution.node, execution_id: Some(execution.id), error: "Application stopped during this execution. Its result is not trusted; inspect and rerun with a fresh Execution Instance.".into() })?;
        }
        runtime.recover_publication()?;
        if runtime.state.approved
            && !matches!(
                runtime.state.phase.as_str(),
                "completed" | "needs_attention" | "publication_failed"
            )
        {
            runtime.emit(EventKind::Paused { paused: true })?;
        }
        Ok(runtime)
    }

    pub fn emit(&mut self, kind: EventKind) -> Result<(), String> {
        self.store.append(&mut self.state, kind)
    }

    pub fn emit_outputs(&mut self, events: Vec<EventKind>) -> Result<(), String> {
        self.store.append_batch(&mut self.state, events)
    }

    fn recover_publication(&mut self) -> Result<(), String> {
        let interrupted: Vec<String> = self
            .state
            .mergers
            .iter()
            .filter(|e| e.status == "running")
            .map(|e| e.id.clone())
            .collect();
        for execution_id in interrupted {
            let publication_merge = self.state.mergers.iter().any(|e| e.id == execution_id && e.node == "merger");
            self.emit(EventKind::MergerFailed {
                execution_id,
                error: if publication_merge {
                    "Merger interrupted; inspect the merge and retry publication."
                } else {
                    "Merger interrupted; inspect the node worktree and rerun or resolve it."
                }.into(),
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
        matches!(self.state.phase.as_str(), "publishing" | "merging")
            || self
                .state
                .nodes
                .values()
                .any(|node| node.status == "running")
    }

    /// Remove only the worktree directory owned by this run. Failed runs retain
    /// their checkout until explicitly reset/deleted so conflicts can be inspected.
    pub fn cleanup_worktrees(&self) -> Result<(), String> {
        if self.is_serial() || Uuid::parse_str(&self.state.run_id).is_err() {
            return Ok(());
        }
        let Some(config) = &self.state.config else { return Ok(()); };
        let repository = Path::new(&config.repository);
        if !repository.is_absolute() { return Ok(()); }
        let Some(parent) = repository.parent() else { return Ok(()); };
        let dir = parent.join(".grapher-worktrees").join(&self.state.run_id);
        if dir.is_dir() && !dir.is_symlink() {
            fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn reset_workspace(&mut self) -> Result<Snapshot, String> {
        if self.active() {
            return Err("Pause and wait for the current executions to finish first".into());
        }
        self.cleanup_worktrees()?;
        let current_config = self.state.config.clone();
        self.state = Snapshot {
            config: current_config,
            ..Snapshot::default()
        };
        Ok(self.state.clone())
    }

    pub fn clear_history(&mut self) -> Result<(), String> {
        if self.active() {
            return Err("Pause and wait for the current executions to finish first".into());
        }
        self.cleanup_worktrees()?;
        self.store.clear()?;
        let current_config = self.state.config.clone();
        self.state = Snapshot {
            config: current_config,
            ..Snapshot::default()
        };
        Ok(())
    }

    pub fn delete_run(&mut self, run_id: &str) -> Result<(), String> {
        if self.state.run_id == run_id && self.active() {
            return Err("Cannot delete the currently running execution".into());
        }
        if self.state.run_id == run_id { self.cleanup_worktrees()?; }
        self.store.delete_run(run_id)?;
        if self.state.run_id == run_id {
            let current_config = self.state.config.clone();
            self.state = Snapshot {
                config: current_config,
                ..Snapshot::default()
            };
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
        self.state = state;
        for execution in interrupted {
            self.emit(EventKind::Failed {
                node: execution.node,
                execution_id: Some(execution.id),
                error: "Execution was interrupted. Inspect and rerun.".into(),
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
        if !(1..=8).contains(&config.max_parallel) {
            return Err("Concurrency must be 1–8; feedback limit is capped at 3".into());
        }
        #[cfg(feature = "fixture")]
        if config.engine == "pi" && config.pi_command.trim().is_empty() {
            return Err("Test process command is required".into());
        }
        self.state = Snapshot {
            run_id: Uuid::new_v4().to_string(),
            ..Snapshot::default()
        };
        self.emit(EventKind::Created {
            graph,
            config,
            planning_id,
            planning,
        })
    }

    pub fn set_route(&mut self, plan_type: &str) -> Result<(), String> {
        if self.state.phase != "awaiting_approval"
            || !matches!(plan_type, "serial" | "graph")
            || (plan_type == "serial"
                && !(self.state.graph.nodes.len() == 1
                    && self.state.graph.nodes[0].name == "task"))
        {
            return Err("Invalid execution route or routing phase".into());
        }
        #[cfg(not(feature = "fixture"))]
        if plan_type == "graph" {
            crate::native::require_graph_execution()?;
        }
        self.emit(EventKind::Routed { plan_type: plan_type.into() })
    }

    fn is_serial(&self) -> bool {
        match self.state.plan_type.as_deref() {
            Some(mode) => mode == "serial",
            None => self.state.graph.nodes.len() == 1 && self.state.graph.nodes[0].name == "task",
        }
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
        workspace::verify(&repository)?;
        // Planning writes directly to source. Freeze the actual files only now,
        // after planning and approval, before any node workspace is allocated.
        let base = workspace::snapshot_repository(&repository)?;
        self.emit(EventKind::Approved { base })
    }

    pub fn edit_draft_graph(&mut self, graph: Graph, mut config: Config) -> Result<(), String> {
        if self.state.run_id.is_empty() || self.state.approved
            || !matches!(self.state.phase.as_str(), "rejected" | "awaiting_approval") {
            return Err("Only an unapproved graph draft can be edited in place".into());
        }
        let previous = self.state.config.as_ref().ok_or("Missing config")?;
        if config.repository != previous.repository {
            return Err("Cannot move a draft to another repository".into());
        }
        resolve_repository(&self.root, &config)?;
        compile(&graph, true).map_err(|errors| serde_json::to_string(&errors).unwrap_or_default())?;
        #[cfg(feature = "fixture")]
        if !known_engine(&config.engine) {
            return Err("Unknown test actuator".into());
        }
        config.max_feedback = config.max_feedback.min(3);
        if !(1..=8).contains(&config.max_parallel) {
            return Err("Concurrency must be 1–8; feedback limit is capped at 3".into());
        }
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
        resolve_repository(&self.root, self.state.config.as_ref().ok_or("Missing config")?)?;
        compile(&graph, true).map_err(|errors| serde_json::to_string(&errors).unwrap_or_default())?;
        self.emit(EventKind::GraphRevised {
            graph,
            planning_id,
            planning,
            invalidated: vec![],
        })
    }

    /// Nodes whose work or dependencies change, plus consumers of those nodes.
    /// Removed nodes must also finish before their execution state is discarded.
    pub fn revision_affected(&self, graph: &Graph) -> BTreeSet<String> {
        let previous = &self.state.graph;
        let names: BTreeSet<_> = graph.nodes.iter().map(|node| node.name.as_str()).collect();
        let mut affected: BTreeSet<String> = previous.nodes.iter()
            .filter(|node| !names.contains(node.name.as_str()))
            .map(|node| node.name.clone()).collect();
        for node in &graph.nodes {
            let Some(old) = previous.nodes.iter().find(|old| old.name == node.name) else { continue };
            let inputs = |g: &Graph| {
                g.edges.iter().filter(|edge| edge.to == node.name && !edge.feedback)
                    .map(|edge| edge.from.clone()).collect::<BTreeSet<_>>()
            };
            let reviews = |g: &Graph| {
                g.edges.iter().filter(|edge| edge.from == node.name && edge.feedback)
                    .map(|edge| edge.to.clone()).collect::<BTreeSet<_>>()
            };
            if old.task != node.task || inputs(previous) != inputs(graph) || reviews(previous) != reviews(graph) {
                affected.extend(downstream(graph, &node.name));
            }
        }
        affected
    }

    /// Apply a planner revision without discarding unrelated work. The caller
    /// must wait for any affected in-flight execution before replacing the graph.
    pub fn revise_graph(&mut self, graph: Graph, planning: PlanningSummary) -> Result<(), String> {
        if !self.state.approved || self.is_serial()
            || matches!(self.state.phase.as_str(), "publishing" | "merging" | "publication_failed") {
            return Err("Wait for active executions/publication before revising the approved graph".into());
        }
        resolve_repository(&self.root, self.state.config.as_ref().ok_or("Missing config")?)?;
        compile(&graph, true).map_err(|errors| serde_json::to_string(&errors).unwrap_or_default())?;
        let previous = &self.state.graph;
        let names: BTreeSet<_> = graph.nodes.iter().map(|node| node.name.as_str()).collect();
        if self.state.published_head.is_some() && previous.nodes.iter().any(|node| !names.contains(node.name.as_str()) && self.state.nodes[&node.name].status == "done") {
            return Err("Cannot remove already published nodes from this run".into());
        }
        let affected = self.revision_affected(&graph);
        if self.state.executions.iter().any(|execution| execution.status == "running" && affected.contains(&execution.node)) {
            return Err("Wait for affected running nodes before revising the graph".into());
        }
        // New consumers of changed nodes must also be invalidated; all others
        // retain their heads, revisions, execution history and worktrees.
        let invalidated: Vec<_> = affected.into_iter().filter(|name| names.contains(name.as_str())).collect();
        self.emit(EventKind::GraphRevised {
            graph, planning_id: planning.planning_id.clone(), planning, invalidated,
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
            resolve_repository(&self.root, self.state.config.as_ref().ok_or("Missing config")?)?;
        }
        self.emit(EventKind::Paused { paused })
    }

    pub fn intervene(&mut self, node: &str, instruction: &str) -> Result<(), String> {
        if instruction.trim().is_empty() {
            return Err("Enter an instruction for the node".into());
        }
        if !self.state.executions.iter().any(|execution| execution.node == node && execution.after.is_some()) {
            return Err("No completed node session to continue; revise the plan instead".into());
        }
        self.invalidate_node(node, instruction.trim())
    }

    pub fn rerun(&mut self, node: &str) -> Result<(), String> {
        self.invalidate_node(node, "")
    }

    fn invalidate_node(&mut self, node: &str, instruction: &str) -> Result<(), String> {
        if matches!(self.state.phase.as_str(), "publishing" | "merging" | "publication_failed") {
            return Err("Resolve or retry publication before changing node results".into());
        }
        if !self.state.approved {
            return Err("Approve the graph before updating a node".into());
        }
        if !self.state.nodes.contains_key(node) {
            return Err("Select a node to rerun".into());
        }
        let affected = downstream(&self.state.graph, node);
        if self.state.executions.iter().any(|execution| execution.status == "running" && affected.contains(&execution.node)) {
            return Err("Steer a running node directly; wait for running downstream nodes before rerunning their inputs".into());
        }
        let repository = resolve_repository(&self.root, self.state.config.as_ref().ok_or("Missing config")?)?;
        if !self.is_serial() && !workspace::is_standard_git(&repository) {
            workspace::check_shadow_source(&repository, self.state.published_head.as_deref().unwrap_or(&self.state.base))?;
        }
        self.emit(EventKind::Invalidated {
            nodes: affected.into_iter().collect(),
            target: node.into(),
            instruction: instruction.into(),
            human: true,
        })
    }

    pub fn resolved(&mut self, node: &str) -> Result<(), String> {
        resolve_repository(&self.root, self.state.config.as_ref().ok_or("Missing config")?)?;
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
        let head = workspace::snapshot_node(path, &repository, node)?;
        self.emit(EventKind::Finished {
            execution_id: execution.id,
            head,
            output: "Human-resolved workspace. Pi task will run in a fresh execution.".into(),
        })?;
        self.rerun(node)
    }

    pub fn jobs(&mut self) -> Result<Vec<Job>, String> {
        self.jobs_with_publication(true)
    }

    /// During a live Planner revision, schedule ready nodes but defer publishing
    /// or settling until the new graph has been committed (or planning failed).
    pub fn jobs_with_publication(&mut self, allow_publication: bool) -> Result<Vec<Job>, String> {
        if !self.state.approved || self.state.paused
            || matches!(self.state.phase.as_str(), "publishing" | "merging" | "publication_failed" | "completed")
            // Feedback may invalidate ancestors and their consumers. Drain the current
            // wave before applying revisions; ordinary DAGs can fill idle slots.
            || (self.active() && self.state.graph.edges.iter().any(|edge| edge.feedback))
        {
            return Ok(Vec::new());
        }
        let config = self.state.config.clone().ok_or("Missing config")?;
        // Check before emitting Started or allocating workspaces, including jobs
        // resumed without a UI request. perform() checks again before filesystem work.
        resolve_repository(&self.root, &config)?;
        #[cfg(not(feature = "fixture"))]
        if !self.is_serial() {
            crate::native::require_graph_execution()?;
        }
        let running = self
            .state
            .nodes
            .values()
            .filter(|node| node.status == "running")
            .count();
        let available = config.max_parallel.saturating_sub(running);
        loop {
            let blocked: Vec<_> = self
                .state
                .graph
                .nodes
                .iter()
                .filter(|node| {
                    matches!(
                        self.state.nodes[&node.name].status.as_str(),
                        "waiting" | "dirty"
                    ) && self.state.graph.edges.iter().any(|edge| {
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
                matches!(
                    self.state.nodes[&node.name].status.as_str(),
                    "waiting" | "dirty"
                ) && self
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
            let before = self.state.nodes[&node.name]
                .head
                .clone()
                .unwrap_or(self.state.base.clone());
            let resume = if self.state.nodes[&node.name].human_instruction {
                Some(self.state.executions.iter().rev()
                    .find(|execution| execution.node == node.name && execution.after.is_some())
                    .ok_or("No completed node session to continue")?)
            } else {
                None
            };
            let resume_execution_id = resume.map(|previous| self.state.executions.iter()
                .find(|execution| execution.session_id == previous.session_id)
                .map(|execution| execution.id.clone())
                .unwrap_or_else(|| previous.id.clone()));
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
                session_id: resume.map(|previous| previous.session_id.clone()).unwrap_or_else(|| Uuid::new_v4().to_string()),
                worktree: if let Some(previous) = resume {
                    previous.worktree.clone()
                } else if self.is_serial() {
                    resolve_repository(&self.root, &config)?
                        .to_string_lossy()
                        .into()
                } else {
                    // Graph worktrees belong beside the user's repository. Keeping
                    // them under Grapher's runtime directory makes the process
                    // discover a path that is unrelated to the project it edits.
                    let repository = resolve_repository(&self.root, &config)?;
                    let parent = repository
                        .parent()
                        .ok_or("Repository has no parent directory")?;
                    parent
                        .join(".grapher-worktrees")
                        .join(&self.state.run_id)
                        .join(format!("{}-{id}", node.name))
                        .to_string_lossy()
                        .into()
                },
                before,
                after: None,
                status: "running".into(),
                output: String::new(),
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
            let feedback_source = self
                .state
                .graph
                .edges
                .iter()
                .any(|edge| edge.feedback && edge.from == node.name);
            self.emit(EventKind::Started {
                execution: execution.clone(),
            })?;
            jobs.push(Job {
                execution,
                config: config.clone(),
                task,
                resume_execution_id,
                feedback_source,
                expected_source_head: self.state.published_head.clone().unwrap_or_else(|| self.state.base.clone()),
            });
        }
        if allow_publication && jobs.is_empty()
            && !self.active()
            && !matches!(self.state.phase.as_str(), "completed" | "needs_attention")
        {
            if !self.is_serial() && self.state.nodes.values().all(|node| node.status == "done") {
                let terminal_names: Vec<String> = if let Some(plan) = &self.state.plan {
                    if !plan.terminals.is_empty() {
                        plan.terminals.clone()
                    } else {
                        self.state.graph.nodes.iter().map(|node| node.name.clone()).collect()
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
                        self.state.graph.nodes.iter().map(|node| node.name.clone()).collect()
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

    pub fn parents(&self, node: &str) -> Vec<String> {
        self.state
            .graph
            .edges
            .iter()
            .filter(|edge| !edge.feedback && edge.to == node)
            .map(|edge| edge.from.clone())
            .collect()
    }

    pub fn finish(
        &mut self,
        execution: &Execution,
        result: Result<(String, String), String>,
    ) -> Result<Option<(String, String)>, String> {
        match result {
            Ok((head, output)) => {
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
                        })?;
                        return Ok(None);
                    }
                }
                let raw = self
                    .state
                    .executions
                    .iter()
                    .find(|item| item.id == execution.id)
                    .map(|item| item.output.clone())
                    .unwrap_or_default();
                self.emit(EventKind::Finished {
                    execution_id: execution.id.clone(),
                    head: head.clone(),
                    output: format!("{raw}\n── Final response ──\n{output}\n"),
                })?;
                if let Some(exec) = self.state.executions.iter().chain(&self.state.mergers).find(|item| item.id == execution.id) {
                    if let Some(m) = &exec.metrics {
                        eprintln!(
                            "[Grapher] [Execution] Node '{}' finished in {:.2}s (head: {}, tokens: in={}, out={}, tools: {}, errors: {})",
                            exec.node, m.duration_seconds, head, m.usage.input, m.usage.output, m.tools, m.tool_errors
                        );
                    } else {
                        eprintln!("[Grapher] [Execution] Node '{}' finished (head: {})", exec.node, head);
                    }
                }
                Ok(if feedback_source {
                    Some((execution.node.clone(), output))
                } else {
                    None
                })
            }
            Err(error) => {
                eprintln!("[Grapher] [Execution] Node '{}' failed: {error}", execution.node);
                self.emit(EventKind::Failed {
                    node: execution.node.clone(),
                    execution_id: Some(execution.id.clone()),
                    error: error.clone(),
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
        let revise = engine::feedback(output)?;
        let edges: Vec<_> = self
            .state
            .graph
            .edges
            .iter()
            .filter(|edge| edge.feedback && edge.from == from)
            .cloned()
            .collect();
        for edge in edges {
            if revise
                && self
                    .state
                    .feedback_counts
                    .get(&format!("{}->{}", edge.from, edge.to))
                    .copied()
                    .unwrap_or(0)
                    >= self.state.config.as_ref().unwrap().max_feedback.min(3)
            {
                self.emit(EventKind::Failed {
                    node: from.into(),
                    execution_id: None,
                    error: "Feedback retry limit exhausted; unrelated branches continue".into(),
                })?;
                return Ok(());
            }
        }
        let edges: Vec<_> = self
            .state
            .graph
            .edges
            .iter()
            .filter(|edge| edge.feedback && edge.from == from)
            .cloned()
            .collect();
        for edge in edges {
            self.emit(EventKind::Feedback {
                from: edge.from,
                to: edge.to.clone(),
                accepted: !revise,
            })?;
            if revise {
                self.emit(EventKind::Invalidated {
                    nodes: downstream(&self.state.graph, &edge.to)
                        .into_iter()
                        .collect(),
                    target: edge.to,
                    instruction: format!("Feedback from {from}:\n{output}"),
                    human: false,
                })?;
            }
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
    perform_with_merger(job, root, parents, on_output, on_prepared, |_| Err("Merger event sink is unavailable".into()))
}

pub fn perform_with_merger(
    job: &Job,
    root: &Path,
    parents: &[String],
    on_output: impl FnMut(String),
    mut on_prepared: impl FnMut(String) -> Result<(), String>,
    mut on_merger_event: impl FnMut(EventKind) -> Result<(), String>,
) -> Result<(String, String), String> {
    let repository = resolve_repository(root, &job.config)?;
    let path = Path::new(&job.execution.worktree);
    #[cfg(not(feature = "fixture"))]
    if path != repository {
        crate::native::require_graph_execution()?;
    }
    let before = workspace::prepare_with_merger_expected(&repository, path, &job.execution.before, parents, &job.expected_source_head, || {
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
    })?;
    on_prepared(before.clone())?;
    let output = engine::execute(
        &job.config,
        &job.execution,
        &job.task,
        job.feedback_source,
        job.resume_execution_id.as_deref(),
        root,
        on_output,
    )?;
    if path != repository {
        workspace::verify_prepared_ancestor(path, &before)?;
    }
    let head = workspace::snapshot_execution(path, &repository, &job.execution.node)?;
    Ok((head, output))
}
