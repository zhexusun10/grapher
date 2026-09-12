//! Deterministic test actuator, compiled only with the `fixture` Cargo feature.
//!
//! It replaces just the node-execution step so compiler, scheduler, workspaces,
//! event store and feedback logic can be exercised without a model. Shipping
//! builds contain no reference to it and only accept the `pi` engine.
use crate::model::Execution;
use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

pub const ENGINE: &str = "fixture";
pub const REPOSITORY: &str = "fixture-repository";

/// Isolated Git repository used as the source of worktrees for fixture runs.
pub fn repository(root: &Path) -> Result<PathBuf, String> {
    let path = root.join(REPOSITORY);
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    if !path.join(".git").exists() {
        crate::workspace::git(&path, &["init"])?;
        fs::write(
            path.join("README.md"),
            "# Grapher fixture\nAn isolated repository; no model calls.\n",
        )
        .map_err(|error| error.to_string())?;
        crate::workspace::git(&path, &["add", "README.md"])?;
        crate::workspace::git(&path, &["commit", "-m", "Initialize isolated fixture"])?;
    }
    Ok(path)
}

pub fn execute(
    execution: &Execution,
    task: &str,
    reviewer: bool,
    mut on_output: impl FnMut(String),
) -> Result<String, String> {
    on_output(format!(
        "[fixture] Fresh execution {}\n[read] Inspecting isolated workspace\n",
        execution.session_id
    ));
    thread::sleep(Duration::from_millis(650));
    let output = if reviewer && execution.attempt == 1 {
        "Fixture verification: add an empty-state message.\n<REVISE>".into()
    } else if reviewer {
        "Fixture verification passed.\n<ACCEPT>".into()
    } else {
        fs::write(
            Path::new(&execution.worktree).join(format!("{}.md", execution.node)),
            format!(
                "# {}\n\n{}\n\nAttempt {}\n",
                execution.node, task, execution.attempt
            ),
        )
        .map_err(|error| error.to_string())?;
        format!(
            "Implemented {} in its isolated workspace.\nFixture execution #{} completed.",
            execution.node, execution.attempt
        )
    };
    on_output(format!("[assistant] {output}\n"));
    Ok(output)
}
