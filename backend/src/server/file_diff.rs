use super::{argument, open_file_context, open_file_roots, OpenFileContext, Service};
use crate::{
    file_changes::file_diff::{
        compute_git_file_diff, compute_head_file_diff, read_added_file_diff,
        validate_relative_diff_path, FileDiffResult, ParsedFileDiff,
    },
    model::Snapshot,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Clone)]
struct DiffExecution {
    id: String,
    node: String,
    worktree: PathBuf,
    before: String,
    after: Option<String>,
    status: String,
    started_at: u64,
    superseded: bool,
}

struct FileDiffContext {
    run_id: String,
    base: String,
    repository: PathBuf,
    publication: Option<(PathBuf, String)>,
    executions: Vec<DiffExecution>,
    open_file: OpenFileContext,
}

fn build_diff_context(state: &Snapshot) -> FileDiffContext {
    let repository = state
        .config
        .as_ref()
        .map(|config| PathBuf::from(&config.repository))
        .unwrap_or_default();
    let publication = state.publication.as_ref().and_then(|pub_state| {
        let head = pub_state.head.as_ref().filter(|head| !head.is_empty())?;
        let repo = if pub_state.repository.is_empty() {
            repository.clone()
        } else {
            PathBuf::from(&pub_state.repository)
        };
        (!repo.as_os_str().is_empty()).then_some((repo, head.clone()))
    });
    FileDiffContext {
        run_id: state.run_id.clone(),
        base: state.base.clone(),
        repository,
        publication,
        executions: state
            .executions
            .iter()
            .chain(state.mergers.iter())
            .map(|exec| DiffExecution {
                id: exec.id.clone(),
                node: exec.node.clone(),
                worktree: PathBuf::from(&exec.worktree),
                before: exec.before.clone(),
                after: exec.after.clone(),
                status: exec.status.clone(),
                started_at: exec.started_at,
                superseded: state.superseded_execution_ids.contains(&exec.id),
            })
            .collect(),
        open_file: open_file_context(state),
    }
}

fn path_exists_in_commit(repo_or_worktree: &Path, commit: &str, path: &str) -> bool {
    if commit.is_empty() || !repo_or_worktree.exists() {
        return false;
    }
    let spec = format!("{commit}:{path}");
    crate::workspace::repository_git(repo_or_worktree, &["cat-file", "-e", &spec])
        .or_else(|_| crate::workspace::git(repo_or_worktree, &["cat-file", "-e", &spec]))
        .is_ok()
}

fn try_execution_diff(
    exec: &DiffExecution,
    repository: &Path,
    path: &str,
    old_path: Option<&str>,
) -> Option<ParsedFileDiff> {
    if exec.before.is_empty() {
        return None;
    }
    if exec.status == "running" && exec.worktree.exists() {
        if let Some(diff) =
            compute_git_file_diff(&exec.worktree, &exec.before, None, path, old_path)
        {
            return Some(diff);
        }
        if !path_exists_in_commit(&exec.worktree, &exec.before, path) {
            if let Some(added) = read_added_file_diff(&exec.worktree, path) {
                return Some(added);
            }
        }
    }
    if let Some(after) = exec.after.as_deref().filter(|sha| !sha.is_empty()) {
        if exec.worktree.exists() {
            if let Some(diff) =
                compute_git_file_diff(&exec.worktree, &exec.before, Some(after), path, old_path)
            {
                return Some(diff);
            }
        }
        if !repository.as_os_str().is_empty() && repository.exists() {
            if let Some(diff) =
                compute_git_file_diff(repository, &exec.before, Some(after), path, old_path)
            {
                return Some(diff);
            }
        }
    }
    None
}

fn resolve_file_diff(
    context: &FileDiffContext,
    scope: Option<&[String]>,
    nodes: &[String],
    path: &str,
    old_path: Option<&str>,
    status: Option<&str>,
) -> Result<ParsedFileDiff, String> {
    if let Some(ids) = scope {
        let selected: Vec<&DiffExecution> = context
            .executions
            .iter()
            .filter(|exec| ids.contains(&exec.id))
            .collect();
        // Prefer live working-tree diff on a running attempt, then the full
        // before..after span across attempts, then individual attempts newest-first.
        if let Some(running) = selected.iter().rev().find(|exec| exec.status == "running") {
            if let Some(diff) = try_execution_diff(running, &context.repository, path, old_path) {
                return Ok(diff);
            }
        }
        let earliest_before = selected
            .iter()
            .find(|exec| !exec.before.is_empty())
            .map(|exec| exec.before.as_str());
        let latest_after = selected
            .iter()
            .rev()
            .find_map(|exec| exec.after.as_deref().filter(|sha| !sha.is_empty()));
        if let (Some(before), Some(after)) = (earliest_before, latest_after) {
            let preferred_root = selected
                .iter()
                .rev()
                .find(|exec| exec.worktree.exists())
                .map(|exec| exec.worktree.as_path())
                .unwrap_or(context.repository.as_path());
            if let Some(diff) =
                compute_git_file_diff(preferred_root, before, Some(after), path, old_path)
            {
                return Ok(diff);
            }
            if preferred_root != context.repository.as_path() && context.repository.exists() {
                if let Some(diff) =
                    compute_git_file_diff(&context.repository, before, Some(after), path, old_path)
                {
                    return Ok(diff);
                }
            }
        }
        for exec in selected.iter().rev() {
            if let Some(diff) = try_execution_diff(exec, &context.repository, path, old_path) {
                return Ok(diff);
            }
        }
    } else {
        // Published runs compare the authoritative base..publication.head span first.
        if let Some((pub_repo, head)) = &context.publication {
            if !context.base.is_empty() {
                if let Some(diff) =
                    compute_git_file_diff(pub_repo, &context.base, Some(head), path, old_path)
                {
                    return Ok(diff);
                }
            }
        }

        let mut active: Vec<&DiffExecution> = context
            .executions
            .iter()
            .filter(|exec| !exec.superseded)
            .collect();
        active.sort_by_key(|exec| exec.started_at);

        // Try executions belonging to the file's owning nodes first, then any active execution.
        if !nodes.is_empty() {
            for exec in active.iter().rev().filter(|exec| nodes.contains(&exec.node)) {
                if let Some(diff) = try_execution_diff(exec, &context.repository, path, old_path) {
                    return Ok(diff);
                }
            }
        }
        for exec in active.iter().rev() {
            if let Some(diff) = try_execution_diff(exec, &context.repository, path, old_path) {
                return Ok(diff);
            }
        }
    }

    // Fallback to safe workspace/repository roots (handles direct edits,
    // follow-up runs without snapshots, and planner writes).
    if let Ok(roots) = open_file_roots(&context.open_file, scope, nodes) {
        for root in &roots {
            if !context.base.is_empty() {
                if let Some(diff) =
                    compute_git_file_diff(root, &context.base, None, path, old_path)
                {
                    return Ok(diff);
                }
            }
            if let Some(diff) = compute_head_file_diff(root, path, old_path) {
                return Ok(diff);
            }
        }
        for root in &roots {
            if status == Some("added") || !path_exists_in_commit(root, "HEAD", path) {
                if let Some(added) = read_added_file_diff(root, path) {
                    return Ok(added);
                }
            }
        }
    }

    Ok(ParsedFileDiff::default())
}

pub(super) fn get_file_diff(
    body: &serde_json::Value,
    service: &Arc<Service>,
) -> Result<serde_json::Value, String> {
    let requested_run_id = body
        .get("runId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let raw_path: String = argument(body, "path")?;
    let path = validate_relative_diff_path(&raw_path)?;
    let old_path = body
        .get("oldPath")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(validate_relative_diff_path)
        .transpose()?;
    let status = body
        .get("status")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let execution_id = body
        .get("executionId")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let execution_ids: Option<Vec<String>> = body
        .get("executionIds")
        .filter(|value| !value.is_null())
        .map(|_| argument(body, "executionIds"))
        .transpose()?;
    if execution_id.is_some() && execution_ids.is_some() {
        return Err("Specify executionId or executionIds, not both".into());
    }
    let scope = execution_ids.or_else(|| execution_id.map(|id| vec![id]));
    let nodes: Vec<String> = body
        .get("nodes")
        .filter(|value| !value.is_null())
        .map(|_| argument(body, "nodes"))
        .transpose()?
        .unwrap_or_default();

    let context = {
        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
        let state = if requested_run_id.is_empty() || runtime.state.run_id == requested_run_id {
            runtime.state.clone()
        } else {
            runtime.store.load(&requested_run_id)?
        };
        build_diff_context(&state)
    };

    let parsed = resolve_file_diff(
        &context,
        scope.as_deref(),
        &nodes,
        &path,
        old_path.as_deref(),
        status.as_deref(),
    )?;

    let result = FileDiffResult {
        run_id: context.run_id,
        path,
        old_path: parsed.old_path.or(old_path),
        binary: parsed.binary,
        truncated: parsed.truncated,
        hidden_lines: parsed.hidden_lines,
        lines: parsed.lines,
    };

    serde_json::to_value(result).map_err(|error| error.to_string())
}
