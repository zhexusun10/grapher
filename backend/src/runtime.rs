use crate::{
    compiler::{compile, downstream},
    engine,
    model::*,
    store::Store,
    workspace,
};
use std::{
    fs,
    os::fd::AsRawFd,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone)]
pub struct Job {
    pub execution: Execution,
    pub config: Config,
    pub task: String,
    pub reviewer: bool,
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
    Ok(PathBuf::from(&config.repository))
}

pub struct Runtime {
    pub store: Store,
    pub state: Snapshot,
    pub root: PathBuf,
    _lock: fs::File,
}

impl Drop for Runtime {
    fn drop(&mut self) {
        // A concurrent process spawn can inherit this file description until exec.
        // Release the owner's lock explicitly instead of waiting for every copy to close.
        unsafe {
            libc::flock(self._lock.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

impl Runtime {
    pub fn open(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|error| error.to_string())?;
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("runtime.lock"))
            .map_err(|error| error.to_string())?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("Another Grapher instance owns this runtime. Close it before opening this data directory again.".into());
        }
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

    fn recover_publication(&mut self) -> Result<(), String> {
        let interrupted: Vec<String> = self.state.mergers.iter()
            .filter(|e| e.status == "running").map(|e| e.id.clone()).collect();
        for execution_id in interrupted {
            self.emit(EventKind::MergerFailed { execution_id, error: "Merger interrupted; inspect the merge and retry publication.".into() })?;
        }
        if matches!(self.state.phase.as_str(), "publishing" | "merging") {
            self.emit(EventKind::PublicationFailed { error: "Publication interrupted. Results and any pending merge are preserved; retry publication to verify and continue.".into() })?;
        }
        Ok(())
    }

    pub fn retry_publication(&mut self) -> Result<(), String> {
        if self.state.phase != "publication_failed" { return Err("Only failed publication can be retried".into()); }
        let publication = self.state.publication.clone().ok_or("No publication to retry")?;
        self.emit(EventKind::PublicationStarted { repository: publication.repository, heads: publication.heads })
    }

    pub fn active(&self) -> bool {
        matches!(self.state.phase.as_str(), "publishing" | "merging") || self.state
            .nodes
            .values()
            .any(|node| node.status == "running")
    }

    pub fn reset_workspace(&mut self) -> Result<Snapshot, String> {
        if self.active() {
            return Err("Pause and wait for the current executions to finish first".into());
        }
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
        if self.active() {
            return Err("Pause and wait for the current executions to finish first".into());
        }
        compile(&graph, true)
            .map_err(|errors| serde_json::to_string(&errors).unwrap_or_default())?;
        #[cfg(feature = "fixture")]
        if !known_engine(&config.engine) {
            return Err("Unknown test actuator".into());
        }
        if !(1..=8).contains(&config.max_parallel) || config.max_feedback > 10 {
            return Err("Concurrency must be 1–8; feedback limit must be 0–10".into());
        }
        #[cfg(feature = "fixture")]
        if config.engine == "pi" && config.pi_command.trim().is_empty() {
            return Err("Test process command is required".into());
        }
        self.state = Snapshot {
            run_id: Uuid::new_v4().to_string(),
            ..Snapshot::default()
        };
        self.emit(EventKind::Created { graph, config })
    }

    pub fn approve(&mut self) -> Result<(), String> {
        if self.state.phase != "awaiting_approval" {
            return Err("Only a compiled, unapproved graph can be approved".into());
        }
        let config = self.state.config.as_ref().ok_or("No graph")?;
        let repository = resolve_repository(&self.root, config)?;
        let base = workspace::verify(&repository)?;
        self.emit(EventKind::Approved { base })
    }

    pub fn pause(&mut self, paused: bool) -> Result<(), String> {
        if matches!(self.state.phase.as_str(), "publishing" | "merging" | "publication_failed") {
            return Err("Publication has its own lifecycle; wait for it to finish or retry failed publication".into());
        }
        if !self.state.approved {
            return Err("Approve the graph first".into());
        }
        self.emit(EventKind::Paused { paused })
    }

    pub fn intervene(&mut self, node: &str, instruction: &str) -> Result<(), String> {
        if self.state.phase == "publication_failed" {
            return Err("Resolve or retry publication before changing node results".into());
        }
        if !self.state.approved || self.active() {
            return Err(
                "Approve, then pause and wait for active executions before intervening".into(),
            );
        }
        if !self.state.nodes.contains_key(node) || instruction.trim().is_empty() {
            return Err("Select a node and enter an instruction".into());
        }
        self.emit(EventKind::Invalidated {
            nodes: downstream(&self.state.graph, node).into_iter().collect(),
            target: node.into(),
            instruction: instruction.trim().into(),
            human: true,
        })
    }

    pub fn resolved(&mut self, node: &str) -> Result<(), String> {
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
        let head = workspace::git(path, &["rev-parse", "HEAD"])?;
        self.emit(EventKind::Finished {
            execution_id: execution.id,
            head,
            output: "Human-resolved workspace. Pi task will run in a fresh execution.".into(),
        })?;
        self.intervene(
            node,
            "Continue from the human-resolved workspace and complete the original task.",
        )
    }

    pub fn jobs(&mut self) -> Result<Vec<Job>, String> {
        if !self.state.approved || self.state.paused || self.active() {
            return Ok(Vec::new());
        }
        let config = self.state.config.clone().ok_or("Missing config")?;
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
            .take(config.max_parallel)
            .cloned()
            .collect();
        let mut jobs = Vec::new();
        for node in ready {
            let id = Uuid::new_v4().to_string();
            let before = self.state.nodes[&node.name]
                .head
                .clone()
                .unwrap_or(self.state.base.clone());
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
                session_id: Uuid::new_v4().to_string(),
                worktree: if self.state.graph.nodes.len() == 1 && self.state.graph.nodes[0].name == "task" {
                    resolve_repository(&self.root, &config)?.to_string_lossy().into()
                } else {
                    // Graph worktrees belong beside the user's repository. Keeping
                    // them under Grapher's runtime directory makes the process
                    // discover a path that is unrelated to the project it edits.
                    let repository = resolve_repository(&self.root, &config)?;
                    let parent = repository.parent().ok_or("Repository has no parent directory")?;
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
            };
            let task = format!(
                "{}\n{}",
                node.task, self.state.nodes[&node.name].instruction
            );
            let reviewer = self
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
                reviewer,
            });
        }
        if jobs.is_empty() && !matches!(self.state.phase.as_str(), "completed" | "needs_attention") {
            let serial = self.state.graph.nodes.len() == 1 && self.state.graph.nodes[0].name == "task";
            if !serial && self.state.nodes.values().all(|node| node.status == "done") {
                let heads = self.state.graph.nodes.iter().map(|node|
                    self.state.nodes[&node.name].head.clone().ok_or("Completed node has no snapshot")
                ).collect::<Result<Vec<_>, _>>()?;
                let repository = resolve_repository(&self.root, &config)?.canonicalize()
                    .map_err(|e| e.to_string())?.to_string_lossy().into();
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
            .filter_map(|edge| self.state.nodes[&edge.from].head.clone())
            .collect()
    }

    pub fn finish(
        &mut self,
        execution: &Execution,
        result: Result<(String, String), String>,
    ) -> Result<Option<(String, String)>, String> {
        match result {
            Ok((head, output)) => {
                let reviewer = self
                    .state
                    .graph
                    .edges
                    .iter()
                    .any(|edge| edge.feedback && edge.from == execution.node);
                if reviewer {
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
                    head,
                    output: format!("{raw}\n── Final response ──\n{output}"),
                })?;
                Ok(if reviewer {
                    Some((execution.node.clone(), output))
                } else {
                    None
                })
            }
            Err(error) => {
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

    pub fn review(&mut self, from: &str, output: &str) -> Result<(), String> {
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
                    >= self.state.config.as_ref().unwrap().max_feedback
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
                    instruction: format!("Verification feedback:\n{output}"),
                    human: false,
                })?;
            }
        }
        Ok(())
    }
}

pub fn perform(
    job: &Job,
    root: &Path,
    parents: &[String],
    on_output: impl FnMut(String),
    mut on_prepared: impl FnMut(String) -> Result<(), String>,
) -> Result<(String, String), String> {
    let repository = resolve_repository(root, &job.config)?;
    let path = Path::new(&job.execution.worktree);
    let before = workspace::prepare(&repository, path, &job.execution.before, parents)?;
    on_prepared(before)?;
    let output = engine::execute(
        &job.config,
        &job.execution,
        &job.task,
        job.reviewer,
        root,
        on_output,
    )?;
    let head = workspace::snapshot(path)?;
    Ok((head, output))
}
