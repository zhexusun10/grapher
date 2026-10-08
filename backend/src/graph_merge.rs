use crate::{
    engine::{run_pi, PiModelConfig, PiRequest, PiRole},
    model::{now, Config, EventKind, Execution},
    workspace::{self, repository_git as git},
};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
use uuid::Uuid;

fn merger_prompt(query: &str) -> String {
    format!("User query:\n{query}\n\nResolve the current Git merge conflicts. Preserve valid changes. Do not modify unrelated files. Stage the resolved files and verify that no unresolved conflicts remain. Do not discard the incoming commit.")
}

fn pending(repository: &Path) -> Option<String> {
    git(repository, &["rev-parse", "--verify", "MERGE_HEAD"]).ok()
}

fn finish_merge(repository: &Path, head: &str, exclusions: &[String]) -> Result<(), String> {
    if !git(repository, &["diff", "--name-only", "--diff-filter=U"])?.is_empty() {
        return Err("Merger left unresolved conflicts".into());
    }
    if pending(repository).is_some() {
        workspace::stage_scoped(repository, exclusions)?;
        git(repository, &["commit", "--no-edit"])?;
    }
    git(repository, &["merge-base", "--is-ancestor", head, "HEAD"])
        .map_err(|_| "Merger did not preserve the incoming commit".to_string())?;
    if !workspace::repository_status(repository, exclusions)?.is_empty() {
        return Err("Merge left uncommitted changes; inspect the affected workspace".into());
    }
    Ok(())
}

/// Use the same Git merge semantics for a checkout and an external shadow repo.
/// Do not resnapshot the user's files here: local changes must block publication.
/// Retrying may continue an existing merge only if its head belongs to this run.
pub fn merge_graph(
    repository: &Path,
    heads: &[String],
    resolve: impl FnMut() -> Result<(), String>,
) -> Result<String, String> {
    merge_graph_scoped(repository, heads, &[], resolve)
}

pub(crate) fn merge_graph_scoped(repository: &Path, heads: &[String], exclusions: &[String], mut resolve: impl FnMut() -> Result<(), String>) -> Result<String, String> {
    workspace::validate_binding(repository)?;
    if let Some(head) = pending(repository) {
        if !heads.contains(&head) {
            return Err(
                "An unrelated merge is in progress; finish it before retrying publication".into(),
            );
        }
        if !git(repository, &["diff", "--name-only", "--diff-filter=U"])?.is_empty() {
            resolve()?;
        }
        finish_merge(repository, &head, exclusions)?;
    }
    if !workspace::repository_status(repository, exclusions)?.is_empty() {
        return Err("User directory changed during execution. Preserve or reconcile local changes, then retry publication.".into());
    }
    // Complete a pending merge above before pruning, so publication retries
    // retain their original incoming commit even if it is now redundant.
    for head in &workspace::independent_heads(repository, heads)? {
        if git(repository, &["merge-base", "--is-ancestor", head, "HEAD"]).is_ok() {
            continue;
        }
        if let Err(error) = git(repository, &["merge", "--no-edit", "--no-ff", head]) {
            if pending(repository).as_deref() != Some(head.as_str())
                || git(repository, &["diff", "--name-only", "--diff-filter=U"])?.is_empty()
            {
                return Err(format!("Graph publication failed: {error}"));
            }
            resolve()?;
        }
        finish_merge(repository, head, exclusions)?;
    }
    git(repository, &["rev-parse", "HEAD"])
}

pub fn resolve_with_merger(
    repository: &Path,
    query: &str,
    config: &Config,
    root: &Path,
    attempt: usize,
    emit: impl FnMut(EventKind) -> Result<(), String>,
) -> Result<(), String> {
    resolve_with_merger_for_node(repository, query, config, root, attempt, "merger", emit)
}

/// Resolve an in-progress merge in either the publication checkout or a DAG node checkout.
pub fn resolve_with_merger_for_node(
    repository: &Path,
    query: &str,
    config: &Config,
    root: &Path,
    attempt: usize,
    node: &str,
    mut emit: impl FnMut(EventKind) -> Result<(), String>,
) -> Result<(), String> {
    let canonical = repository.canonicalize().map_err(|e| e.to_string())?;
    let repository = canonical.as_path();
    let id = Uuid::new_v4().to_string();
    let incoming = pending(repository).ok_or("No pending merge to resolve")?;
    let directory = root.join("mergers").join(&id);
    // Commit ownership before allocation; even a failed mkdir/open belongs to
    // this Run and can be reclaimed when the conversation is deleted.
    emit(EventKind::MergerStarted {
        execution: Execution {
            id: id.clone(),
            node: node.into(),
            revision: 1,
            attempt,
            session_id: id.clone(),
            worktree: repository.to_string_lossy().into(),
            before: git(repository, &["rev-parse", "HEAD"])?,
            workspace_lineage: vec![],
            after: None,
            input: None, result: None,
            status: "running".into(),
            output: String::new(), output_bytes: 0, pid: None,
            started_at: now(),
            completed_at: None,
            metrics: None,
        },
    })?;
    let mut log = match (|| -> Result<_, String> {
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        OpenOptions::new().create_new(true).write(true).open(directory.join("output.jsonl"))
            .map_err(|error| error.to_string())
    })() {
        Ok(log) => log,
        Err(error) => {
            emit(EventKind::MergerFailed { execution_id: id, error: error.clone(), output_bytes: 0, metrics: None })?;
            return Err(error);
        }
    };
    let prompt = merger_prompt(query);
    // Make native Git commands work in a plain folder without adding a .git
    // entry there. This environment is scoped to the merger process tree;
    // stock Git/Bash must receive host paths, not Windows device prefixes.
    let environment = if workspace::is_standard_git(repository) {
        Vec::new()
    } else {
        vec![
            (
                "GIT_DIR",
                crate::native::host_path(&workspace::shadow_repo_dir(repository)?)
                    .to_string_lossy()
                    .into(),
            ),
            ("GIT_WORK_TREE", crate::native::host_path(repository).to_string_lossy().into()),
        ]
    };
    let mut output_error = None;
    let merger_model_cfg = PiModelConfig::resolve(PiRole::Merger, config);
    let merger_config = merger_model_cfg.effective_config(config);
    let mut extra_args = vec!["--no-context-files"];
    if let Some(thinking) = &merger_model_cfg.thinking {
        extra_args.push("--thinking");
        extra_args.push(thinking.as_str());
    }
    let result = run_pi(
        PiRequest {
            role: PiRole::Merger,
            config: &merger_config,
            cwd: repository,
            task: "Resolve the current merge conflicts.",
            session_dir: &directory,
            extension: None,
            tools: Some("read,write,bash,edit"),
            session_id: Some(&id),
            extra_args,
            environment,
            system_prompt: Some(&prompt),
            images: None,
        },
        |text| {
            if let Err(error) = log.write_all(text.as_bytes()) {
                output_error = Some(error.to_string());
            }
            if let Err(error) = emit(EventKind::Output {
                execution_id: id.clone(),
                text,
            }) {
                output_error = Some(error);
            }
        },
    )
    .and_then(|_| {
        if let Some(error) = output_error {
            return Err(format!("Cannot persist merger output: {error}"));
        }
        finish_merge(repository, &incoming, &config.environment.as_ref().map(|e| e.exclusions()).unwrap_or_default())
    });
    match &result {
        Ok(()) => {
            let head = git(repository, &["rev-parse", "HEAD"])?;
            eprintln!("[Grapher] [Merger] Finished resolving conflicts for '{node}' (HEAD: {head})");
            emit(EventKind::MergerFinished {
                execution_id: id.clone(),
                head, output_bytes: 0, metrics: None,
            })?
        }
        Err(error) => {
            eprintln!("[Grapher] [Merger] Failed resolving conflicts for '{node}': {error}");
            emit(EventKind::MergerFailed {
                execution_id: id.clone(),
                error: error.clone(), output_bytes: 0, metrics: None,
            })?
        }
    }
    fs::write(directory.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "id": id, "name": "merger", "node": node, "cwd": repository,
        "status": if result.is_ok() { "completed" } else { "failed" }, "error": result.as_ref().err(),
    })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn merger_prompt_preserves_task_context_without_graph_specific_terminology() {
        assert_eq!(
            super::merger_prompt("Combine results"),
            "User query:\nCombine results\n\nResolve the current Git merge conflicts. Preserve valid changes. Do not modify unrelated files. Stage the resolved files and verify that no unresolved conflicts remain. Do not discard the incoming commit."
        );
    }
}
