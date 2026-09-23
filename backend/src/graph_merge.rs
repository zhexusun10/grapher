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

fn pending(repository: &Path) -> Option<String> {
    git(repository, &["rev-parse", "--verify", "MERGE_HEAD"]).ok()
}

fn finish_merge(repository: &Path, head: &str) -> Result<(), String> {
    if !git(repository, &["diff", "--name-only", "--diff-filter=U"])?.is_empty() {
        return Err("Merger left unresolved conflicts".into());
    }
    if pending(repository).is_some() {
        git(repository, &["add", "-A"])?;
        git(repository, &["commit", "--no-edit"])?;
    }
    git(repository, &["merge-base", "--is-ancestor", head, "HEAD"])
        .map_err(|_| "Merger did not preserve the incoming commit".to_string())?;
    if !git(repository, &["status", "--porcelain"])?.is_empty() {
        return Err("Publication left uncommitted changes; inspect the user directory".into());
    }
    Ok(())
}

/// Use the same Git merge semantics for a checkout and an external shadow repo.
/// Do not resnapshot the user's files here: local changes must block publication.
/// Retrying may continue an existing merge only if its head belongs to this run.
pub fn merge_graph(
    repository: &Path,
    heads: &[String],
    mut resolve: impl FnMut() -> Result<(), String>,
) -> Result<String, String> {
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
        finish_merge(repository, &head)?;
    }
    if !git(repository, &["status", "--porcelain"])?.is_empty() {
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
        finish_merge(repository, head)?;
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
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let mut log = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(directory.join("output.jsonl"))
        .map_err(|e| e.to_string())?;
    emit(EventKind::MergerStarted {
        execution: Execution {
            id: id.clone(),
            node: node.into(),
            revision: 1,
            attempt,
            session_id: id.clone(),
            worktree: repository.to_string_lossy().into(),
            before: git(repository, &["rev-parse", "HEAD"])?,
            after: None,
            status: "running".into(),
            output: String::new(),
            started_at: now(),
            completed_at: None,
        },
    })?;
    let prompt = format!("User query:\n{query}\n\n修复当前 Git merge conflicts。保留各节点已完成的有效修改，不要修改与冲突无关的内容。解决冲突后暂存已解决的文件，并检查不存在未解决的冲突。不要丢弃 incoming parent 的提交。");
    // Make native Git commands work in a plain folder without adding a .git
    // entry there. This environment is scoped to the merger process tree.
    let environment = if workspace::is_standard_git(repository) {
        Vec::new()
    } else {
        vec![
            (
                "GIT_DIR",
                workspace::shadow_repo_dir(repository)
                    .to_string_lossy()
                    .into(),
            ),
            ("GIT_WORK_TREE", repository.to_string_lossy().into()),
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
            task: "修复当前合并冲突。",
            session_dir: &directory,
            extension: None,
            tools: Some("read,write,bash,edit"),
            session_id: Some(&id),
            extra_args,
            environment,
            system_prompt: Some(&prompt),
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
        finish_merge(repository, &incoming)
    });
    match &result {
        Ok(()) => emit(EventKind::MergerFinished {
            execution_id: id.clone(),
            head: git(repository, &["rev-parse", "HEAD"])?,
        })?,
        Err(error) => emit(EventKind::MergerFailed {
            execution_id: id.clone(),
            error: error.clone(),
        })?,
    }
    fs::write(directory.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "id": id, "name": "merger", "node": node, "cwd": repository,
        "status": if result.is_ok() { "completed" } else { "failed" }, "error": result.as_ref().err(),
    })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    result
}
