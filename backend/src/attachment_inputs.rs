//! Immutable, Run/node-scoped attachment inputs for a future execution.
//! Closed project views are never edited by upload. The accepted instruction
//! names each input, and the worker delivers only those inputs after preparation.
use crate::path_safety::real_child_path;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(crate) const BUCKET: &str = "attachment-inputs";
pub(crate) const PROJECT_DIRECTORY: &str = "grapher-attachments";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    node: String,
    name: String,
    hash: String,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !matches!(name, "." | "..")
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
}

fn hash(bytes: &[u8]) -> Result<String, String> {
    git2::Oid::hash_object(git2::ObjectType::Blob, bytes)
        .map(|id| id.to_string())
        .map_err(|error| error.to_string())
}

fn directory(root: &Path, run: &str, node: &str, id: &str) -> Result<PathBuf, String> {
    let run = Uuid::parse_str(run).map_err(|_| "Invalid attachment Run ID")?;
    let id = Uuid::parse_str(id).map_err(|_| "Invalid attachment ID")?;
    Ok(root
        .join(BUCKET)
        .join(run.to_string())
        .join(hash(node.as_bytes())?)
        .join(id.to_string()))
}

fn ensure_directory(root: &Path, path: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Attachment path is outside its root")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("Invalid attachment child path".into());
        }
        current.push(component);
        if real_child_path(root, &current, false)?.is_none() {
            match fs::create_dir(&current) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        real_child_path(root, &current, false)?.ok_or("Attachment directory disappeared")?;
    }
    Ok(())
}

fn immutable_file(root: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
    {
        Ok(mut file) => file
            .write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let actual = real_child_path(root, path, true)?.ok_or("Attachment disappeared")?;
            if fs::read(actual).map_err(|error| error.to_string())? == bytes {
                Ok(())
            } else {
                Err("Attachment contents changed; select the file again before sending".into())
            }
        }
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn stage(
    root: &Path,
    run: &str,
    node: &str,
    id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    if !valid_name(name) {
        return Err("Invalid attachment filename".into());
    }
    let directory = directory(root, run, node, id)?;
    ensure_directory(root, &directory)?;
    let metadata = serde_json::to_vec(&Input {
        node: node.into(),
        name: name.into(),
        hash: hash(bytes)?,
    })
    .map_err(|error| error.to_string())?;
    // Publish the manifest last. A partial upload is never a deliverable input.
    immutable_file(root, &directory.join("content"), bytes)?;
    immutable_file(root, &directory.join("input.json"), &metadata)
}

pub(crate) fn remove(
    root: &Path,
    run: &str,
    node: &str,
    id: &str,
    name: &str,
) -> Result<(), String> {
    let directory = directory(root, run, node, id)?;
    if let Some(metadata) = real_child_path(root, &directory.join("input.json"), true)? {
        let input: Input =
            serde_json::from_slice(&fs::read(metadata).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        if input.node != node || input.name != name {
            return Err("Attachment ownership mismatch".into());
        }
    }
    for name in ["input.json", "content"] {
        if let Some(path) = real_child_path(root, &directory.join(name), true)? {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    let _ = fs::remove_dir(directory);
    Ok(())
}

/// Deliver only immutable inputs explicitly referenced by this execution's
/// accepted task. Later/rejected uploads cannot become inputs of an older job.
pub(crate) fn deliver(
    root: &Path,
    run: &str,
    node: &str,
    task: &str,
    workspace: &Path,
) -> Result<(), String> {
    deliver_prepared(root, run, node, task, workspace, false)
}

pub(crate) fn deliver_prepared(
    root: &Path,
    run: &str,
    node: &str,
    task: &str,
    workspace: &Path,
    preserve_partial_work: bool,
) -> Result<(), String> {
    let prefix = format!("{PROJECT_DIRECTORY}/");
    let mut ids = BTreeSet::new();
    for (offset, _) in task.match_indices(prefix.as_str()) {
        let suffix = &task[offset + prefix.len()..];
        if suffix.as_bytes().get(36) != Some(&b'/') {
            continue;
        }
        if let Some(id) = suffix.get(..36).and_then(|text| Uuid::parse_str(text).ok()) {
            ids.insert(id.to_string());
        }
    }
    for id in ids {
        let directory = directory(root, run, node, &id)?;
        let Some(metadata) = real_child_path(root, &directory.join("input.json"), true)? else {
            // Initial source inputs and files inherited through recorded project
            // snapshots need no staged copy. Never search another node's scope.
            continue;
        };
        let input: Input =
            serde_json::from_slice(&fs::read(metadata).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        if input.node != node || !valid_name(&input.name) {
            return Err("Invalid attachment ownership".into());
        }
        let content = real_child_path(root, &directory.join("content"), true)?
            .ok_or("Staged attachment content is missing")?;
        let bytes = fs::read(content).map_err(|error| error.to_string())?;
        if hash(&bytes)? != input.hash {
            return Err("Staged attachment content is damaged".into());
        }
        let owned = workspace.join(PROJECT_DIRECTORY).join(&id);
        let path = owned.join(&input.name);
        let workspace_key = hash(
            workspace
                .canonicalize()
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .as_bytes(),
        )?;
        let receipt = directory.join("delivered").join(workspace_key);
        let completed = real_child_path(root, &receipt, true)?;
        if let Some(completed) = &completed {
            if fs::read(completed).map_err(|error| error.to_string())? != input.hash.as_bytes() {
                return Err("Attachment delivery receipt is damaged".into());
            }
        }
        if let Some(existing) = real_child_path(workspace, &path, true)? {
            // Preserve edits only after a proven complete delivery. An aborted
            // copy without a receipt must not pass a truncated input to Pi.
            if completed.is_none()
                && hash(&fs::read(existing).map_err(|error| error.to_string())?)? != input.hash
            {
                return Err(
                    "Attachment delivery is incomplete; select the file again before sending"
                        .into(),
                );
            }
        } else if preserve_partial_work && completed.is_some() {
            // A prepared agent may have deliberately deleted its input, or the
            // whole attachment directory. Recovery retains those deletions and
            // must not recreate any directory before deciding to keep them.
            continue;
        } else {
            // Recomposition may have removed an earlier copy. Invalidate its
            // receipt before creating a replacement, so a failed write remains
            // distinguishable from partial work produced by the agent. Create
            // directories only now, after the preserve decision above.
            if let Some(completed) = completed {
                fs::remove_file(completed).map_err(|error| error.to_string())?;
            }
            ensure_directory(workspace, &owned)?;
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .map_err(|error| format!("Cannot deliver attachment: {error}"))?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|error| error.to_string())?;
        }
        ensure_directory(
            root,
            receipt
                .parent()
                .ok_or("Missing attachment receipt directory")?,
        )?;
        immutable_file(root, &receipt, input.hash.as_bytes())?;
    }
    Ok(())
}
