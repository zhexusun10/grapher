//! Restore only a proven, not-yet-delivered handoff of user-paused private work.
use crate::{model::{apply, EventKind, Snapshot}, store::Store, workspace};
use std::{collections::{BTreeMap, BTreeSet}, fs, path::{Path, PathBuf}};

pub(crate) fn restoration(root: &Path, state: &Snapshot) -> Result<EventKind, String> {
    if !state.approved || state.isolated_workspaces != Some(true)
        || state.batch_handoff.is_none()
        || !matches!(state.phase.as_str(), "publishing" | "merging" | "publication_failed")
        || state.executions.iter().chain(&state.mergers).any(|e| e.status == "running")
        || state.result_execution.as_ref().is_some_and(|e| e.status == "running")
        || state.planning.as_ref().is_some_and(|p| p.status.as_deref() == Some("running"))
        || !state.pending_feedback.is_empty()
    {
        return Err("Only an idle, undelivered paused-private batch handoff can be restored".into());
    }
    let (handoff_index, ids) = state.events.iter().enumerate().rev().find_map(|(i, event)| {
        match &event.kind {
            EventKind::BatchHandoffRequested { recovery_execution_ids } => Some((i, recovery_execution_ids)),
            _ => None,
        }
    }).ok_or("Missing handoff evidence")?;
    if ids.is_empty() {
        return Err("This handoff did not capture paused nodes".into());
    }
    let recovery_index = state.events[..handoff_index].iter().rposition(|event| {
        matches!(event.kind, EventKind::RecoveryQueued { .. })
    }).ok_or("Missing continuation request")?;
    // Never roll back a later user instruction, graph edit, execution, or a
    // delivery. Only the erroneous handoff and its own Merger history may follow.
    for event in &state.events[recovery_index + 1..] {
        if !matches!(&event.kind,
            EventKind::Paused { .. } | EventKind::BatchHandoffRequested { .. }
            | EventKind::BatchRecoveryCaptured { .. } | EventKind::PublicationStarted { .. }
            | EventKind::PublicationFailed { .. } | EventKind::MergerStarted { .. }
            | EventKind::MergerFinished { .. } | EventKind::MergerFailed { .. }) {
            return Err(format!("Later state changes prevent restoration (event {})", event.sequence));
        }
    }
    if state.events[recovery_index + 1..].iter().filter(|e| matches!(e.kind, EventKind::BatchHandoffRequested { .. })).count() != 1 {
        return Err("Ambiguous recovery/handoff boundary".into());
    }
    let mut original = Snapshot { run_id: state.run_id.clone(), ..Default::default() };
    for event in &state.events[..recovery_index] {
        apply(&mut original, event);
    }
    let repository = Path::new(&state.config.as_ref().ok_or("Missing config")?.repository);
    workspace::validate_binding(repository)?;
    let run_root = PathBuf::from(workspace::normalize_workspace_display_path(
        &workspace::workspaces_parent(root).join(".grapher-worktrees").join(&state.run_id),
    ));
    let mut restored_nodes = BTreeMap::new();
    for id in ids {
        let execution = state.executions.iter().find(|e| e.id == *id).ok_or("Missing paused execution")?;
        let node = original.nodes.get(&execution.node).ok_or("Missing original node")?;
        let current = state.nodes.get(&execution.node).ok_or("Missing current node")?;
        if execution.status != "failed" || !original.execution_stop_requests.contains(id)
            || !node.is_user_paused() || !node.pending_messages.is_empty()
            || !current.continuation || !matches!(current.status.as_str(), "waiting" | "dirty")
            || !current.pending_messages.is_empty() || state.superseded_execution_ids.contains(id)
            || state.executions.iter().rev().find(|e| e.node == execution.node).map(|e| &e.id) != Some(id)
        {
            return Err(format!("Node '{}' is not the unchanged user-paused attempt", execution.node));
        }
        let path = Path::new(&execution.worktree);
        if crate::path_safety::real_child_path(&run_root, path, false)?.is_none()
            || crate::path_identity::same_path(path, repository)
            || state.executions.iter().rev().find(|e| crate::path_identity::same_path(Path::new(&e.worktree), path)).map(|e| &e.id) != Some(id)
        {
            return Err("Paused workspace is missing, outside its Run, or reassigned".into());
        }
        if execution.before.is_empty() {
            return Err("Restoration requires recorded preparation evidence".into());
        }
        workspace::verify_prepared_ancestor(path, &execution.before)?;
        let origin = state.executions.iter().find(|e| e.node == execution.node && e.session_id == execution.session_id)
            .ok_or("Missing session origin")?;
        crate::session_branch::validate_session(&root.join("sessions").join(&origin.id), &execution.session_id, path)?;
        restored_nodes.insert(execution.node.clone(), node.clone());
    }
    let queued: BTreeSet<_> = match &state.events[recovery_index].kind {
        EventKind::RecoveryQueued { nodes, continuation_nodes, .. } if nodes == continuation_nodes => nodes.iter().cloned().collect(),
        _ => return Err("The recovery request also changed other work".into()),
    };
    if queued != restored_nodes.keys().cloned().collect() {
        return Err("The recovery request does not match the paused batch".into());
    }
    let mut publications = BTreeSet::new();
    for event in &state.events[handoff_index + 1..] {
        if let EventKind::PublicationStarted { repository: target, heads } = &event.kind {
            if !crate::path_identity::same_path(repository, Path::new(target)) {
                return Err("Publication target changed".into());
            }
            let default = crate::graph_merge::publication_workspace(repository, heads)?;
            publications.insert(run_root.join(default.file_name().ok_or("Invalid publication path")?));
        }
        if let EventKind::BatchRecoveryCaptured { heads } = &event.kind {
            if heads.keys().any(|id| !ids.contains(id))
                || heads.values().any(|head| state.published_heads.contains(head)) {
                return Err("Recovery inputs changed or were already delivered".into());
            }
        }
    }
    if publications.is_empty() {
        return Err("Missing publication input evidence".into());
    }
    for event in &state.events[handoff_index + 1..] {
        if let EventKind::MergerStarted { execution } = &event.kind {
            let path = Path::new(&execution.worktree);
            if execution.node != "merger" || !publications.iter().any(|p| crate::path_identity::same_path(p, path))
                || !path.with_extension("publication").is_dir() {
                return Err("Merger workspace or publication journal is missing or mismatched".into());
            }
        }
    }
    for path in publications {
        let journal = path.with_extension("publication");
        if crate::path_safety::real_child_path(&run_root, &journal, false)?.is_none() {
            continue; // Capture can replace the initial heads before publication starts.
        }
        let mut attempts = 0usize;
        for entry in fs::read_dir(&journal).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let attempt = entry.path();
            if entry.file_name().to_string_lossy().parse::<u32>().is_err()
                || crate::path_safety::real_child_path(&journal, &attempt, false)?.is_none()
                || !attempt.is_dir() {
                return Err("Unrecognized publication journal layout".into());
            }
            attempts += 1;
            // Fail closed even if a prepared result has not yet been installed.
            // Only the pre-delivery composition phase is eligible for this repair.
            for record in fs::read_dir(&attempt).map_err(|e| e.to_string())? {
                let record = record.map_err(|e| e.to_string())?;
                if !matches!(record.file_name().to_str(), Some("input.json" | "original-index" | "index-missing" | "source-branch")) {
                    return Err("Publication may have begun delivery; refusing to restore paused work".into());
                }
            }
            let _: (String, String) = serde_json::from_slice(&fs::read(attempt.join("input.json")).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        }
        if attempts == 0 {
            return Err("Publication journal has no attempt records".into());
        }
    }
    Ok(EventKind::PausedBatchRestored {
        handoff_sequence: state.events[handoff_index].sequence,
        restored_nodes,
        reason: "Offline repair: cancel an undelivered handoff of user-paused private nodes; retain files and sessions and leave the Run paused".into(),
    })
}

pub(super) fn prepare_backup_directory(backup: &Path, root: &Path, source: &Path) -> Result<PathBuf, String> {
    if !backup.is_absolute() || backup.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return Err("Backup directory must be absolute, without traversal, and outside runtime/project workspaces".into());
    }
    let protected = [
        root.canonicalize().map_err(|e| e.to_string())?,
        source.canonicalize().map_err(|e| e.to_string())?,
        workspace::workspaces_parent(root),
    ];
    // Resolve existing aliases before creating anything. Canonicalizing only
    // after mkdir would already change a protected project on a rejected path.
    let mut existing = backup;
    loop {
        match fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                existing = existing.parent().ok_or("Backup has no existing ancestor")?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let candidate = existing.canonicalize().map_err(|e| e.to_string())?
        .join(backup.strip_prefix(existing).map_err(|e| e.to_string())?);
    let validate = |path: &Path| {
        if protected.iter().any(|scope| {
            workspace::scope_contains(path, scope) || workspace::scope_contains(scope, path)
        }) {
            Err("Backup must be outside runtime, source and private workspaces".to_string())
        } else {
            Ok(())
        }
    };
    validate(&candidate)?;
    fs::create_dir_all(&candidate).map_err(|e| e.to_string())?;
    let backup = candidate.canonicalize().map_err(|e| e.to_string())?;
    validate(&backup)?;
    Ok(backup)
}

/// --restore-paused-batch RUN_ID [--apply --expect-sequence N --backup DIRECTORY]
/// No Runtime/driver is opened: preview never repairs other Runs or launches work.
pub fn restore_paused_batch(args: Vec<String>) -> Result<(), String> {
    restore_paused_batch_at(&workspace::data_root(), args)
}

pub(crate) fn restore_paused_batch_at(data_root: &Path, args: Vec<String>) -> Result<(), String> {
    let mut args = args.into_iter();
    let run_id = args.next().ok_or("Specify a Run ID")?;
    uuid::Uuid::parse_str(&run_id).map_err(|_| "Invalid Run ID")?;
    let mut apply_change = false;
    let mut backup = None;
    let mut expected = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--apply" => apply_change = true,
            "--backup" => backup = Some(PathBuf::from(args.next().ok_or("Missing backup directory")?)),
            "--expect-sequence" => expected = Some(args.next().ok_or("Missing sequence")?.parse::<i64>().map_err(|e| e.to_string())?),
            _ => return Err(format!("Unknown recovery argument: {arg}")),
        }
    }
    let root = data_root.canonicalize().map_err(|e| e.to_string())?;
    let _lease = crate::runtime_lock::acquire(&root)?;
    crate::native::check_retired_leases(&root)?;
    let database = root.join("events.sqlite");
    let reader = Store::open_reader(&database)?;
    let state = reader.load(&run_id)?;
    let event = restoration(&root, &state)?;
    let sequence = state.events.last().ok_or("Empty Run")?.sequence;
    let EventKind::PausedBatchRestored { restored_nodes, handoff_sequence, .. } = &event else { unreachable!() };
    println!("Run: {run_id}\nSequence: {sequence}\nHandoff: {handoff_sequence}\nRestore paused nodes: {}", restored_nodes.keys().cloned().collect::<Vec<_>>().join(", "));
    if !apply_change {
        println!("Preview only. No events or project files changed.");
        return Ok(());
    }
    if expected != Some(sequence) {
        return Err("Run changed or --expect-sequence is missing; preview again".into());
    }
    let backup = backup.ok_or("--apply requires --backup DIRECTORY")?;
    let source = Path::new(&state.config.as_ref().ok_or("Missing config")?.repository);
    let backup = prepare_backup_directory(&backup, &root, source)?;
    let target = backup.join("events.sqlite");
    if target.exists() || backup.join("before.json").exists() || backup.join("after.json").exists() {
        return Err("Recovery backup files already exist; choose a new directory".into());
    }
    let connection = rusqlite::Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    connection.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()]).map_err(|e| e.to_string())?;
    drop(connection);
    let copied = Store::open_reader(&target)?;
    let saved = copied.load(&run_id)?;
    if saved.events.last().map(|e| e.sequence) != Some(sequence) {
        return Err("Backup does not match the previewed Run".into());
    }
    fs::write(backup.join("before.json"), serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    drop(copied);
    drop(reader);
    let store = Store::open(&database)?;
    let mut current = store.load(&run_id)?;
    if current.events.last().map(|e| e.sequence) != Some(sequence) {
        return Err("Run changed before repair; nothing appended".into());
    }
    restoration(&root, &current)?;
    store.append(&mut current, event)?;
    let restored = store.load(&run_id)?;
    if restored.phase != "paused" || !restored.paused || restored.publication.is_some() || restored.batch_handoff.is_some() {
        return Err("Repair was appended but verification failed; keep backend stopped and inspect backup".into());
    }
    fs::write(backup.join("after.json"), serde_json::to_vec_pretty(&restored).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    println!("Restored and paused. No Agent started. Backup: {}", backup.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_directory_rejection_does_not_modify_protected_trees() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        let source = temp.path().join("source");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&source).unwrap();
        let workspaces = workspace::workspaces_parent(&root);
        for protected in [&root, &source, &workspaces] {
            let backup = protected.join("new/recovery-backup");
            assert!(prepare_backup_directory(&backup, &root, &source).is_err());
            assert!(!protected.join("new").exists(), "a rejected backup must not change project/runtime files");
        }
        let traversal = temp.path().join("missing/../source/new");
        assert!(prepare_backup_directory(&traversal, &root, &source).is_err());
        assert!(!temp.path().join("missing").exists());
        assert!(!source.join("new").exists());
        let valid = temp.path().join("backups/new");
        assert_eq!(prepare_backup_directory(&valid, &root, &source).unwrap(), valid.canonicalize().unwrap());
    }

    #[test]
    fn backup_directory_rejects_aliases_into_source_before_creating_children() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        let source = temp.path().join("source");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&source).unwrap();
        let alias = temp.path().join("alias");
        crate::path_safety::directory_link(&source, &alias);
        assert!(prepare_backup_directory(&alias.join("new/backup"), &root, &source).is_err());
        assert!(!source.join("new").exists());
        crate::path_safety::remove_directory_link(&alias);
    }
}
