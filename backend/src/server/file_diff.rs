use super::{argument, open_file_context, open_file_roots, OpenFileContext, Service};
use crate::{
    file_changes::file_diff::{
        compute_git_file_diff, compute_head_file_diff, has_working_tree_git,
        path_exists_in_working_tree_head, read_added_file_diff, validate_relative_diff_path,
        FileDiffResult, ParsedFileDiff, TranscriptDiffAccumulator, MAX_DIFF_LINES_PER_FILE,
    },
    model::Snapshot,
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

const MAX_TRANSCRIPT_DIFF_LOG_BYTES: usize = 16 * 1024 * 1024;
const MAX_INLINE_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

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
    output: String,
    output_bytes: usize,
}

struct FileDiffContext {
    run_id: String,
    base: String,
    repository: PathBuf,
    publication: Option<(PathBuf, String)>,
    planning_id: Option<String>,
    planning_worktree: Option<PathBuf>,
    executions: Vec<DiffExecution>,
    open_file: OpenFileContext,
    store_root: PathBuf,
}

fn build_diff_context(state: &Snapshot, store_root: PathBuf) -> FileDiffContext {
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
    let planning_worktree = state
        .planning
        .as_ref()
        .and_then(|planning| planning.worktree.as_ref())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    FileDiffContext {
        run_id: state.run_id.clone(),
        base: state.base.clone(),
        repository,
        publication,
        planning_id: state.planning_id.clone(),
        planning_worktree,
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
                output: if exec.output.len() <= MAX_INLINE_OUTPUT_BYTES {
                    exec.output.clone()
                } else {
                    String::new()
                },
                output_bytes: exec.output_bytes,
            })
            .collect(),
        open_file: open_file_context(state),
        store_root,
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
    let has_after = exec.after.as_deref().is_some_and(|sha| !sha.is_empty());
    if (exec.status == "running" || !has_after) && exec.worktree.exists() {
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

fn read_execution_transcript(
    store: Option<&crate::store::Store>,
    run_id: &str,
    exec: &DiffExecution,
) -> Option<String> {
    let mut from_store = None;
    if let Some(reader) = store {
        if !run_id.is_empty() {
            let requested = if exec.output_bytes > 0 {
                exec.output_bytes.min(MAX_TRANSCRIPT_DIFF_LOG_BYTES)
            } else {
                MAX_TRANSCRIPT_DIFF_LOG_BYTES
            };
            if let Ok(page) = reader.execution_log_page(run_id, &exec.id, 0, requested) {
                if !page.content.is_empty() {
                    from_store = Some(page.content);
                }
            }
        }
    }
    match from_store {
        Some(stored) if stored.len() >= exec.output.len() => Some(stored),
        _ if !exec.output.is_empty() => Some(exec.output.clone()),
        other => other,
    }
}

fn read_planner_transcript(context: &FileDiffContext) -> Option<String> {
    let planning_id = context.planning_id.as_deref()?;
    if planning_id.is_empty()
        || !planning_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return None;
    }
    let log = context
        .store_root
        .join("planning")
        .join(planning_id)
        .join("planner.jsonl");
    let meta = fs::metadata(&log).ok()?;
    if meta.len() == 0 || meta.len() as usize > MAX_TRANSCRIPT_DIFF_LOG_BYTES {
        return None;
    }
    fs::read_to_string(&log).ok()
}

fn extract_transcript_diff_for_target(
    context: &FileDiffContext,
    reader: Option<&crate::store::Store>,
    executions: &[&DiffExecution],
    include_planner: bool,
    target_path: &str,
) -> Option<ParsedFileDiff> {
    let repo_str = context.repository.to_string_lossy();
    let mut acc = TranscriptDiffAccumulator::new(target_path);

    if include_planner {
        if let Some(jsonl) = read_planner_transcript(context) {
            let worktree = context
                .planning_worktree
                .as_deref()
                .unwrap_or(context.repository.as_path())
                .to_string_lossy();
            acc.feed_jsonl(&jsonl, &worktree, &repo_str, false);
        }
    }

    for exec in executions {
        let Some(jsonl) = read_execution_transcript(reader, &context.run_id, exec) else {
            continue;
        };
        let worktree = exec.worktree.to_string_lossy();
        acc.feed_jsonl(&jsonl, &worktree, &repo_str, exec.status == "running");
    }

    acc.finish(MAX_DIFF_LINES_PER_FILE)
}

fn resolve_transcript_diff(
    context: &FileDiffContext,
    scope: Option<&[String]>,
    nodes: &[String],
    path: &str,
    old_path: Option<&str>,
) -> Option<ParsedFileDiff> {
    let db_path = context.store_root.join("events.sqlite");
    let reader = db_path
        .is_file()
        .then(|| crate::store::Store::open_reader(&db_path).ok())
        .flatten();

    let try_target = |target: &str| -> Option<ParsedFileDiff> {
        if let Some(ids) = scope {
            let mut selected: Vec<&DiffExecution> = context
                .executions
                .iter()
                .filter(|exec| ids.contains(&exec.id))
                .collect();
            selected.sort_by_key(|exec| exec.started_at);
            return extract_transcript_diff_for_target(
                context,
                reader.as_ref(),
                &selected,
                false,
                target,
            );
        }

        let mut active: Vec<&DiffExecution> = context
            .executions
            .iter()
            .filter(|exec| !exec.superseded)
            .collect();
        active.sort_by_key(|exec| exec.started_at);

        if !nodes.is_empty() {
            let include_planner = nodes.iter().any(|node| node == "planner");
            let owned: Vec<&DiffExecution> = active
                .iter()
                .copied()
                .filter(|exec| nodes.contains(&exec.node))
                .collect();
            if let Some(diff) = extract_transcript_diff_for_target(
                context,
                reader.as_ref(),
                &owned,
                include_planner,
                target,
            ) {
                return Some(diff);
            }
        }

        extract_transcript_diff_for_target(context, reader.as_ref(), &active, true, target)
    };

    try_target(path).or_else(|| {
        old_path
            .filter(|old| !old.is_empty() && *old != path)
            .and_then(try_target)
    })
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
        let mut selected: Vec<&DiffExecution> = context
            .executions
            .iter()
            .filter(|exec| ids.contains(&exec.id))
            .collect();
        selected.sort_by_key(|exec| exec.started_at);
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
        let mut active: Vec<&DiffExecution> = context
            .executions
            .iter()
            .filter(|exec| !exec.superseded)
            .collect();
        active.sort_by_key(|exec| exec.started_at);

        // Published runs compare the authoritative base..publication.head span first.
        // Adaptive batch runs leave `state.base` empty, so fall back to the
        // earliest active execution's `before` commit when present.
        if let Some((pub_repo, head)) = &context.publication {
            let pub_base = if !context.base.is_empty() {
                Some(context.base.as_str())
            } else {
                active
                    .iter()
                    .find(|exec| !exec.before.is_empty() && (nodes.is_empty() || nodes.contains(&exec.node)))
                    .or_else(|| active.iter().find(|exec| !exec.before.is_empty()))
                    .map(|exec| exec.before.as_str())
            };
            if let Some(base) = pub_base {
                if let Some(diff) = compute_git_file_diff(pub_repo, base, Some(head), path, old_path)
                {
                    return Ok(diff);
                }
            }
        }

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
    let roots = open_file_roots(&context.open_file, scope, nodes).ok();
    if let Some(roots) = &roots {
        for root in roots {
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
        for root in roots {
            if status == Some("added")
                || (has_working_tree_git(root) && !path_exists_in_working_tree_head(root, path))
            {
                if let Some(added) = read_added_file_diff(root, path) {
                    return Ok(added);
                }
            }
        }
    }

    // Reconstruct edits/writes from the execution/planning JSONL transcripts
    // when Git diff is empty or unavailable (serial/source-direct runs whose
    // changes were committed, plain folders, planner writes, or reclaimed slots).
    if let Some(diff) = resolve_transcript_diff(context, scope, nodes, path, old_path) {
        return Ok(diff);
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
        let (active_context, root) = {
            let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
            if requested_run_id.is_empty() || runtime.state.run_id == requested_run_id {
                (
                    Some(build_diff_context(&runtime.state, runtime.root.clone())),
                    PathBuf::new(),
                )
            } else {
                (None, runtime.root.clone())
            }
        };
        match active_context {
            Some(context) => context,
            None => {
                let store = crate::store::Store::open_reader(&root.join("events.sqlite"))?;
                let state = store.load(&requested_run_id)?;
                build_diff_context(&state, root)
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_changes::file_diff::DiffLineKind;
    use std::process::Command;
    use tempfile::TempDir;

    fn git_commit(repo: &Path, file: &str, content: &str, msg: &str) -> String {
        fs::write(repo.join(file), content).unwrap();
        let add = Command::new("git")
            .current_dir(repo)
            .args(["add", file])
            .output()
            .unwrap();
        assert!(add.status.success(), "{:?}", add);
        let commit = Command::new("git")
            .current_dir(repo)
            .args([
                "-c",
                "user.name=Grapher Test",
                "-c",
                "user.email=test@grapher.invalid",
                "commit",
                "-m",
                msg,
            ])
            .output()
            .unwrap();
        assert!(commit.status.success(), "{:?}", commit);
        let rev = Command::new("git")
            .current_dir(repo)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        assert!(rev.status.success(), "{:?}", rev);
        String::from_utf8_lossy(&rev.stdout).trim().to_string()
    }

    #[test]
    fn resolve_file_diff_sorts_scoped_executions_by_started_at() {
        let dir = TempDir::new().unwrap();
        let repo = dir.path();
        let init = Command::new("git")
            .current_dir(repo)
            .args(["init"])
            .output()
            .unwrap();
        assert!(init.status.success(), "{:?}", init);

        let c0 = git_commit(repo, "app.txt", "line0\n", "c0");
        let c1 = git_commit(repo, "app.txt", "line0\nline1\n", "c1");
        let c2 = git_commit(repo, "app.txt", "line0\nline1\nline2\n", "c2");

        // Deliberately provide executions in reverse chronological order.
        let context = FileDiffContext {
            run_id: "run-1".into(),
            repository: repo.to_path_buf(),
            base: c0.clone(),
            publication: None,
            planning_id: None,
            planning_worktree: None,
            open_file: open_file_context(&Snapshot::default()),
            store_root: repo.to_path_buf(),
            executions: vec![
                DiffExecution {
                    id: "exec-2".into(),
                    node: "n1".into(),
                    status: "completed".into(),
                    superseded: false,
                    started_at: 200,
                    before: c1.clone(),
                    after: Some(c2.clone()),
                    worktree: repo.to_path_buf(),
                    output: String::new(),
                    output_bytes: 0,
                },
                DiffExecution {
                    id: "exec-1".into(),
                    node: "n1".into(),
                    status: "completed".into(),
                    superseded: false,
                    started_at: 100,
                    before: c0.clone(),
                    after: Some(c1.clone()),
                    worktree: repo.to_path_buf(),
                    output: String::new(),
                    output_bytes: 0,
                },
            ],
        };

        let scope = vec!["exec-2".to_string(), "exec-1".to_string()];
        let diff = resolve_file_diff(&context, Some(&scope), &[], "app.txt", None, None).unwrap();
        let added: Vec<&str> = diff
            .lines
            .iter()
            .filter(|line| line.kind == DiffLineKind::Added)
            .map(|line| line.text.as_str())
            .collect();
        assert_eq!(added, vec!["line1", "line2"]);
    }
}
