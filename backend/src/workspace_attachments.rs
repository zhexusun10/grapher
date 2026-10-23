//! Attachment files are uniquely owned project inputs, never replacements for
//! a user's existing basename. Closed node views receive inputs only when the
//! next execution has passed preparation; upload itself cannot mutate a seal.
use super::{argument, decode_base64, resolve_repo_path, same_repository_binding, Service};
use crate::{path_safety::real_child_path, runtime::Runtime};
use std::{fs, io::Write, path::PathBuf, sync::Arc};
use uuid::Uuid;

const ATTACHMENTS: &str = crate::attachment_inputs::PROJECT_DIRECTORY;
/// Scope used for attachments addressed to the Planner rather than a node.
const PLANNER_SCOPE: &str = "planner";

fn filename(raw: &str) -> Result<&str, String> {
    let name = raw.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.chars().any(|c| c.is_control() || c == ':')
    {
        return Err("Invalid attachment filename".into());
    }
    Ok(name)
}

/// Where an accepted attachment goes. A private Run workspace (a node slot, a
/// Merger directory, or a Planner cwd borrowed from one) is a sealed project
/// view or an active writer's tree: it is never edited at upload time. The file
/// is persisted as a Run/node-scoped execution input instead and delivered only
/// when an agent actually owns the directory. Only the user's source directory
/// is written in place. Deciding from the target rather than from node status
/// also covers a completed Planner upload and the window where a worker has
/// sealed its result but `Finished` is not yet recorded.
enum Destination {
    Direct(PathBuf),
    Staged(String),
}

fn destination(
    runtime: &Runtime,
    repository: PathBuf,
    run_id: Option<&str>,
    node: Option<&str>,
) -> Result<Destination, String> {
    let Some(id) = run_id else {
        if node.is_some() {
            return Err("A Run ID is required for node attachments".into());
        }
        return Ok(Destination::Direct(directory(repository)?));
    };
    if id != runtime.state.run_id {
        return Err("Run changed while preparing an attachment".into());
    }
    let config = runtime.state.config.as_ref().ok_or("Missing Run config")?;
    if !same_repository_binding(&config.repository, &repository.to_string_lossy()) {
        return Err("Attachment repository does not match the selected Run".into());
    }
    let live_merger = node.is_some_and(|name| {
        runtime
            .state
            .mergers
            .iter()
            .any(|execution| execution.node == name && execution.status == "running")
    });
    if matches!(runtime.state.phase.as_str(), "publishing" | "merging") && !live_merger {
        return Err("Wait for publication before uploading attachments".into());
    }
    let workspace = match node {
        Some(name) if name == "merger" || name.starts_with("merge:") => {
            runtime.merger_attachment_workspace(name)?
        }
        Some(name) => {
            if !runtime.state.nodes.contains_key(name) {
                return Err("Attachment node not found in this Run".into());
            }
            // A node without any attempt has no conversation to address yet, so
            // it cannot accept an attachment either (the message would be
            // rejected the same way). Every attempted node is staged or source.
            if !runtime.state.executions.iter().any(|execution| {
                execution.node == name
                    && !runtime
                        .state
                        .superseded_execution_ids
                        .contains(&execution.id)
            }) {
                return Err("Node workspace is not ready for attachments".into());
            }
            if !runtime.node_attachment_is_source_direct(name) {
                return Ok(Destination::Staged(name.to_string()));
            }
            PathBuf::from(&config.repository)
        }
        None => runtime
            .planner_attachment_workspace()?
            .unwrap_or_else(|| PathBuf::from(&config.repository)),
    };
    if same_repository_binding(&workspace.to_string_lossy(), &repository.to_string_lossy()) {
        Ok(Destination::Direct(directory(workspace)?))
    } else {
        Ok(Destination::Staged(
            node.unwrap_or(PLANNER_SCOPE).to_string(),
        ))
    }
}

fn directory(path: PathBuf) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err("Attachment workspace directory is unavailable".into());
    }
    path.canonicalize().map_err(|error| error.to_string())
}

pub(super) fn write_workspace_attachment(
    service: &Arc<Service>,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let repository = resolve_repo_path(service, argument(&body, "repository")?);
    let run_id: Option<String> = argument(&body, "runId")?;
    let node: Option<String> = argument(&body, "node")?;
    let raw: String = argument(&body, "filename")?;
    let name = filename(&raw)?;
    let content: String = argument(&body, "content")?;
    let bytes = decode_base64(
        content
            .split_once(',')
            .map(|(_, data)| data)
            .unwrap_or(&content),
    )
    .ok_or("Invalid base64 attachment content")?;
    // The optional client UUID is an idempotency key, not a workspace hint.
    // Target ownership is still resolved from the current backend state.
    let id = argument::<Option<String>>(&body, "attachmentId")?
        .map(|id| Uuid::parse_str(&id).map_err(|_| "Invalid attachment ID"))
        .transpose()?
        .unwrap_or_else(Uuid::new_v4)
        .to_string();
    // Keep workspace selection and writing together: handoff must not move the
    // target between resolving a node and delivering its attachment.
    let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    let staged = match destination(
        &runtime,
        repository.clone(),
        run_id.as_deref(),
        node.as_deref(),
    )? {
        Destination::Staged(scope) => {
            let run = &runtime.state.run_id;
            runtime.store.remember_cleanup_targets(
                run,
                &[crate::cleanup::Target::data(
                    crate::attachment_inputs::BUCKET,
                    run,
                )]
                .into_iter()
                .collect(),
            )?;
            crate::attachment_inputs::stage(&runtime.root, run, &scope, &id, name, &bytes)?;
            Some(scope)
        }
        Destination::Direct(workspace) => {
            direct_write(&workspace, &id, name, &bytes)?;
            None
        }
    };
    Ok(serde_json::json!({
        "name": name,
        "path": format!("{ATTACHMENTS}/{id}/{name}"),
        "size": bytes.len(),
        "staged": staged.is_some(),
        // A private workspace is only ever written through delivery, so an
        // upload never reports an in-place node write.
        "written_to_worktree": false,
    }))
}

/// Write directly into the user's source directory. Only reachable for
/// source-direct follow-ups and runs without a conversation.
fn direct_write(
    workspace: &std::path::Path,
    id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    {
        let directory = workspace.join(ATTACHMENTS);
        if real_child_path(&workspace, &directory, false)?.is_none() {
            match fs::create_dir(&directory) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(format!("Cannot create attachment directory: {error}")),
            }
        }
        real_child_path(&workspace, &directory, false)?
            .ok_or("Attachment directory disappeared")?;
        let owned = directory.join(id);
        if real_child_path(workspace, &owned, false)?.is_none() {
            fs::create_dir(&owned)
                .map_err(|error| format!("Cannot allocate attachment: {error}"))?;
        }
        let path = owned.join(name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => file
                .write_all(bytes)
                .and_then(|()| file.sync_all())
                .map_err(|error| format!("Cannot write attachment file: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let actual = real_child_path(workspace, &path, true)?
                    .ok_or("Attachment disappeared while retrying")?;
                if fs::read(actual).map_err(|error| error.to_string())? != bytes {
                    return Err(
                        "Attachment contents changed; select the file again before sending".into(),
                    );
                }
            }
            Err(error) => return Err(format!("Cannot create attachment file: {error}")),
        }
    }
    Ok(())
}

pub(super) fn delete_workspace_attachment(
    service: &Arc<Service>,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let repository = resolve_repo_path(service, argument(&body, "repository")?);
    let run_id: Option<String> = argument(&body, "runId")?;
    let node: Option<String> = argument(&body, "node")?;
    let relative: String = argument(&body, "filename")?;
    // Only the returned managed path is deletable; a legacy basename must not
    // turn Cancel into an arbitrary project-file deletion.
    let parts: Vec<_> = relative.split('/').collect();
    if parts.len() != 3
        || parts[0] != ATTACHMENTS
        || Uuid::parse_str(parts[1]).is_err()
        || filename(parts[2])? != parts[2]
        || parts[2].contains('\\')
    {
        return Err("Only managed attachment paths can be deleted".into());
    }
    let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    match destination(
        &runtime,
        repository.clone(),
        run_id.as_deref(),
        node.as_deref(),
    )? {
        Destination::Staged(scope) => crate::attachment_inputs::remove(
            &runtime.root,
            &runtime.state.run_id,
            &scope,
            parts[1],
            parts[2],
        )?,
        Destination::Direct(workspace) => {
            let path = workspace.join(&relative);
            if let Some(path) = real_child_path(&workspace, &path, true)? {
                fs::remove_file(path)
                    .map_err(|error| format!("Cannot delete attachment: {error}"))?;
                // Remove only our now-empty UUID directory, never a project subtree.
                let _ = fs::remove_dir(workspace.join(ATTACHMENTS).join(parts[1]));
            }
        }
    }
    Ok(serde_json::json!({ "success": true, "name": parts[2] }))
}

#[cfg(test)]
#[path = "workspace_attachment_tests.rs"]
mod tests;
