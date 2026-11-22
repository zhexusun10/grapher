//! External attachment upload/deletion endpoints.
//! Attachments are persisted immutably under Grapher's data directory
//! (`<data_root>/attachment-inputs/`) and exposed read-only to sandboxed
//! executions — they are never written into the user's project directory or
//! any private Run worktree.
use super::{argument, decode_base64, resolve_repo_path, same_repository_binding, Service};
use crate::{attachment_inputs, cleanup::Target, runtime::Runtime};
use std::{path::PathBuf, sync::Arc};
use uuid::Uuid;

fn filename(raw: &str) -> Result<&str, String> {
    let name = raw.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    if !attachment_inputs::valid_name(name) {
        return Err("Invalid attachment filename".into());
    }
    Ok(name)
}

fn validate_target(
    runtime: &Runtime,
    repository: &PathBuf,
    run_id: Option<&str>,
    node: Option<&str>,
) -> Result<(), String> {
    let Some(id) = run_id else {
        if node.is_some() {
            return Err("A Run ID is required for node attachments".into());
        }
        if !repository.is_dir() {
            return Err("Attachment workspace directory is unavailable".into());
        }
        return Ok(());
    };
    if id != runtime.state.run_id {
        return Err("Run changed while preparing an attachment".into());
    }
    let config = runtime.state.config.as_ref().ok_or("Missing Run config")?;
    if !same_repository_binding(&config.repository, &repository.to_string_lossy()) {
        return Err("Attachment repository does not match the selected Run".into());
    }
    match node {
        Some(name) if name == "merger" || name.starts_with("merge:") => {
            if !runtime
                .state
                .mergers
                .iter()
                .any(|execution| execution.node == name)
            {
                return Err("Merger workspace not found in this Run".into());
            }
        }
        Some(name) => {
            if !runtime.state.nodes.contains_key(name) {
                return Err("Attachment node not found in this Run".into());
            }
            // A node without any attempt has no conversation to address yet.
            if !runtime.state.executions.iter().any(|execution| {
                execution.node == name
                    && !runtime
                        .state
                        .superseded_execution_ids
                        .contains(&execution.id)
            }) {
                return Err("Node workspace is not ready for attachments".into());
            }
        }
        None => {}
    }
    Ok(())
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
    let data = if content
        .get(..5)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("data:"))
    {
        let (header, data) = content
            .split_once(',')
            .ok_or("Invalid base64 attachment content")?;
        if !header
            .rsplit_once(';')
            .is_some_and(|(_, encoding)| encoding.eq_ignore_ascii_case("base64"))
        {
            return Err("Invalid base64 attachment content".into());
        }
        data
    } else {
        content.as_str()
    };
    let bytes = decode_base64(data).ok_or("Invalid base64 attachment content")?;
    // The optional client UUID is an idempotency key for safe retries.
    let id = argument::<Option<String>>(&body, "attachmentId")?
        .map(|id| Uuid::parse_str(&id).map_err(|_| "Invalid attachment ID"))
        .transpose()?
        .unwrap_or_else(Uuid::new_v4)
        .to_string();
    let root = {
        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
        validate_target(&runtime, &repository, run_id.as_deref(), node.as_deref())?;
        if let Some(run) = run_id.as_deref() {
            runtime.store.remember_cleanup_targets(
                run,
                &[Target::data(attachment_inputs::BUCKET, run)]
                    .into_iter()
                    .collect(),
            )?;
        }
        runtime.root.clone()
    };
    let stored = attachment_inputs::store(&root, run_id.as_deref(), &id, name, &bytes)?;
    Ok(serde_json::json!({
        "name": name,
        "path": attachment_inputs::display_path(&stored),
        "size": bytes.len(),
        "external": true,
    }))
}

pub(super) fn delete_workspace_attachment(
    service: &Arc<Service>,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let repository = resolve_repo_path(service, argument(&body, "repository")?);
    let run_id: Option<String> = argument(&body, "runId")?;
    let node: Option<String> = argument(&body, "node")?;
    let target: String = argument(&body, "filename")?;
    let root = {
        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
        if let Some(id) = run_id.as_deref() {
            validate_target(&runtime, &repository, Some(id), node.as_deref())?;
        } else if node.is_some() {
            return Err("A Run ID is required for node attachments".into());
        }
        runtime.root.clone()
    };
    let removed = attachment_inputs::remove(&root, run_id.as_deref(), &target)?;
    Ok(serde_json::json!({ "success": true, "name": removed }))
}

#[cfg(test)]
#[path = "workspace_attachment_tests.rs"]
mod tests;
