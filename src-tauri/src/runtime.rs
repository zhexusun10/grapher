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

pub struct Runtime {
    pub store: Store,
    pub state: Snapshot,
    pub root: PathBuf,
    _lock: fs::File,
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
        let state = if let Some(run) = store.runs()?.first() {
            store.load(run)?
        } else {
            Snapshot::default()
        };
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
            runtime.emit(EventKind::Failed { node: execution.node, execution_id: Some(execution.id), error: "Application stopped during this execution. Its result is not trusted; inspect and rerun with a fresh Pi session.".into() })?;
        }
        if runtime.state.approved
            && !matches!(
                runtime.state.phase.as_str(),
                "completed" | "needs_attention"
            )
        {
            runtime.emit(EventKind::Paused { paused: true })?;
        }
        Ok(runtime)
    }

    pub fn emit(&mut self, kind: EventKind) -> Result<(), String> {
        self.store.append(&mut self.state, kind)
    }

    pub fn active(&self) -> bool {
        self.state
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

    pub fn create(&mut self, graph: Graph, config: Config) -> Result<(), String> {
        if self.active() {
            return Err("Pause and wait for the current executions to finish first".into());
        }
        compile(&graph, true)
            .map_err(|errors| serde_json::to_string(&errors).unwrap_or_default())?;
        if !matches!(config.engine.as_str(), "demo" | "pi") {
            return Err("Unknown engine".into());
        }
        if !(1..=8).contains(&config.max_parallel) || config.max_feedback > 10 {
            return Err("Concurrency must be 1–8; feedback limit must be 0–10".into());
        }
        if config.engine == "pi" && config.pi_command.trim().is_empty() {
            return Err("Pi command is required".into());
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
        let repository = if config.engine == "demo" {
            workspace::demo_repository(&self.root)?
        } else {
            PathBuf::from(&config.repository)
        };
        let base = workspace::verify(&repository)?;
        self.emit(EventKind::Approved { base })
    }

    pub fn pause(&mut self, paused: bool) -> Result<(), String> {
        if !self.state.approved {
            return Err("Approve the graph first".into());
        }
        self.emit(EventKind::Paused { paused })
    }

    pub fn intervene(&mut self, node: &str, instruction: &str) -> Result<(), String> {
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
                worktree: self
                    .root
                    .join("worktrees")
                    .join(&self.state.run_id)
                    .join(format!("{}-{id}", node.name))
                    .to_string_lossy()
                    .into(),
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
        if jobs.is_empty() && !matches!(self.state.phase.as_str(), "completed" | "needs_attention")
        {
            self.emit(EventKind::Settled)?;
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
    let repository = if job.config.engine == "demo" {
        root.join("demo-repository")
    } else {
        PathBuf::from(&job.config.repository)
    };
    let path = Path::new(&job.execution.worktree);
    let before = workspace::prepare(&repository, path, &job.execution.before, parents)?;
    on_prepared(before)?;
    let output = engine::execute(
        &job.config,
        &job.execution,
        &job.task,
        job.reviewer,
        on_output,
    )?;
    let head = workspace::snapshot(path)?;
    Ok((head, output))
}
