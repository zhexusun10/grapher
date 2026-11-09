use super::{argument, Service};
use crate::model::Snapshot;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
};

#[derive(Clone)]
struct OpenFileExecution {
    id: String,
    worktree: PathBuf,
    started_at: u64,
    superseded: bool,
}

/// Display-independent copy of the state needed to resolve a changed file.
/// Snapshot and output payloads are deliberately excluded so the Run mutex can
/// be released before filesystem checks and process launch.
pub(super) struct OpenFileContext {
    repository: PathBuf,
    planning_worktree: Option<PathBuf>,
    published: bool,
    executions: Vec<OpenFileExecution>,
}

pub(super) fn open_file_context(state: &Snapshot) -> OpenFileContext {
    OpenFileContext {
        repository: state
            .config
            .as_ref()
            .map(|config| PathBuf::from(&config.repository))
            .unwrap_or_default(),
        planning_worktree: state
            .planning
            .as_ref()
            .and_then(|planning| planning.worktree.as_ref())
            .map(PathBuf::from),
        published: state
            .publication
            .as_ref()
            .is_some_and(|publication| publication.status == "completed"),
        executions: state
            .executions
            .iter()
            .chain(state.mergers.iter())
            .map(|execution| OpenFileExecution {
                id: execution.id.clone(),
                worktree: PathBuf::from(&execution.worktree),
                started_at: execution.started_at,
                superseded: state.superseded_execution_ids.contains(&execution.id),
            })
            .collect(),
    }
}

/// Roots are tried in priority order. A node view passes its attempt IDs so a
/// file is read from that conversation; the main view uses the newest active
/// workspace and only falls back to the source repository once no retained
/// workspace still has the file. After publication the repository is the final
/// result and therefore wins over stale retained workspaces.
pub(super) fn open_file_roots(
    context: &OpenFileContext,
    execution_ids: Option<&[String]>,
    nodes: &[String],
) -> Result<Vec<PathBuf>, String> {
    let mut roots = Vec::new();
    let mut seen = BTreeSet::new();
    let mut push = |path: &Path| {
        if path.as_os_str().is_empty() {
            return;
        }
        if seen.insert(crate::path_identity::path_key(path)) {
            roots.push(path.to_path_buf());
        }
    };

    if let Some(ids) = execution_ids {
        let mut found = false;
        // Attempt IDs arrive oldest-first; the newest retained attempt is the
        // best match when several attempts contain the same path.
        for id in ids.iter().rev() {
            if let Some(execution) = context
                .executions
                .iter()
                .find(|execution| &execution.id == id)
            {
                found = true;
                push(&execution.worktree);
            }
        }
        if !found {
            return Err("当前 Run 中找不到所选执行。".into());
        }
        push(&context.repository);
        return Ok(roots);
    }

    // Planner writes can live only in a separate planning workspace. Only
    // prefer it when the Planner is the sole owner of the path; otherwise an
    // execution may already contain a newer inherited version.
    let planner_only = !nodes.is_empty() && nodes.iter().all(|node| node == "planner");
    if context.published {
        push(&context.repository);
    }
    if planner_only {
        if let Some(worktree) = context.planning_worktree.as_deref() {
            push(worktree);
        }
    }
    let mut active: Vec<_> = context
        .executions
        .iter()
        .filter(|execution| !execution.superseded)
        .collect();
    active.sort_by_key(|execution| execution.started_at);
    for execution in active.iter().rev() {
        push(&execution.worktree);
    }
    if !planner_only {
        if let Some(worktree) = context.planning_worktree.as_deref() {
            push(worktree);
        }
    }
    if !context.published {
        push(&context.repository);
    }
    Ok(roots)
}

/// `real_child_path` rejects traversal, absolute child paths and symlinked
/// descendants while tolerating trusted-root aliases.
pub(super) fn resolve_open_file_target(roots: &[PathBuf], path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    if relative.as_os_str().is_empty() {
        return Err("必须提供文件路径。".into());
    }
    for root in roots {
        if let Ok(Some(target)) =
            crate::path_safety::real_child_path(root, &root.join(relative), true)
        {
            return Ok(target);
        }
    }
    Err("文件已不在当前 Run 的工作区或仓库中。".into())
}

fn open_path_with_system(path: &Path) -> Result<(), String> {
    // explorer.exe receives the path as one argument, so shell metacharacters
    // and spaces cannot alter a command line. `open` / `xdg-open` use the same
    // argument shape on their platforms.
    let mut command = if cfg!(target_os = "windows") {
        let mut command = std::process::Command::new("explorer.exe");
        command.arg(path);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = std::process::Command::new("open");
        command.arg(path);
        command
    } else {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(path);
        command
    };
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动系统文件打开器：{error}"))?;
    // The opener is detached from the HTTP worker, but its child still needs a
    // waiter so Unix does not accumulate zombies.
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

pub(super) fn open_workspace_file(
    body: &serde_json::Value,
    service: &Arc<Service>,
) -> Result<serde_json::Value, String> {
    let requested_run_id = body
        .get("runId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let path: String = argument(body, "path")?;
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
        if !requested_run_id.is_empty() && runtime.state.run_id != requested_run_id {
            return Err("Run does not match service".into());
        }
        open_file_context(&runtime.state)
    };
    let roots = open_file_roots(&context, scope.as_deref(), &nodes)?;
    let target = resolve_open_file_target(&roots, &path)?;
    open_path_with_system(&target)?;
    Ok(serde_json::json!({ "path": target.to_string_lossy() }))
}
