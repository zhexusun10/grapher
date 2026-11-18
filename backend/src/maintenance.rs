//! Offline, opt-in maintenance; never bypass the runtime's exclusive lease.

use crate::{model::Snapshot, path_safety::real_child_path, store::Store};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Default)]
struct WorkspacePlan {
    paths: BTreeSet<PathBuf>,
    shadow_paths: BTreeSet<PathBuf>,
    retained: usize,
    shadow_retained: usize,
    tasks: Vec<crate::cleanup::Task>,
}

fn workspace_plan(root: &Path, store: &Store, parent: &Path) -> Result<WorkspacePlan, String> {
    let live: BTreeSet<_> = store.runs()?.into_iter().collect();
    let sources = store.cleanup_sources()?;
    let mut tasks = store.pending_cleanups()?;
    for id in &live {
        let state = store.load(id)?;
        if state.phase == "completed" && !tasks.iter().any(|task| task.run_id == *id) {
            let manifest = crate::cleanup::manifest(root, store, &state, false)?;
            if manifest.targets.iter().any(|target| matches!(target, crate::cleanup::Target::Workspace { parent: owner_parent, .. } if crate::path_identity::same_path(owner_parent, parent))
                && target.resolve(root, id).ok().flatten().is_some())
                {
                tasks.push(crate::cleanup::Task { run_id: id.clone(), manifest, attempts: 0, last_error: None });
            }
        }
    }
    let is_protected = |path: &Path| {
        sources
            .iter()
            .any(|source| crate::workspace::scope_contains(source, path))
    };
    let mut plan = WorkspacePlan {
        tasks,
        ..Default::default()
    };
    for name in [".grapher-worktrees"] {
        let Some(directory) = real_child_path(parent, &parent.join(name), false)? else {
            continue;
        };
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if Uuid::parse_str(&id).is_err() {
                continue;
            }
            let Some(path) = real_child_path(parent, &parent.join(name).join(&id), false)? else {
                continue;
            };
            // Absence from THIS database is not proof of garbage: another data
            // root or an archived database may still own this directory.
            let recorded = store.owned_cleanup_targets(&id)?.iter().any(|target| {
                matches!(
                    target,
                    crate::cleanup::Target::Workspace {
                        parent: owner_parent,
                        bucket,
                        owner,
                        checkout: None,
                    } if bucket == name
                        && owner == &id
                        && crate::path_identity::same_path(owner_parent, parent)
                )
            });
            if live.contains(&id)
                || is_protected(&path)
                || !store.run_was_deleted(&id)?
                || !recorded
            {
                plan.retained += 1;
            } else {
                plan.paths.insert(path);
            }
        }
    }
    for id in store.deleted_runs()? {
        let state = Snapshot {
            run_id: id,
            ..Default::default()
        };
        if !plan.tasks.iter().any(|task| task.run_id == state.run_id) {
            let manifest = crate::cleanup::manifest(root, store, &state, true)?;
            if !manifest.targets.is_empty() {
                plan.tasks.push(crate::cleanup::Task {
                    run_id: state.run_id.clone(),
                    manifest,
                    attempts: 0,
                    last_error: None,
                });
            }
        }
    }
    // Apply the source-database lifetime contract, including completed Git
    // Graphs whose private ancestry is still conversation-owned. Skip entries
    // that fail shadow name validation or are symlinks.
    if let Ok(Some(shadow_root)) = real_child_path(root, &root.join("shadow_repos"), false) {
        for entry in fs::read_dir(&shadow_root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let target = crate::cleanup::Target::Shadow {
                root: root.to_path_buf(),
                name,
                source: None,
            };
            let Ok(Some(path)) = target.resolve(root, "offline-gc") else {
                continue;
            };
            if store.shadow_repo_in_use(&path)? {
                plan.shadow_retained += 1;
            } else {
                plan.shadow_paths.insert(path);
            }
        }
    }
    Ok(plan)
}

/// Usage: --cleanup-workspaces [--parent WORKSPACE_PARENT] [--apply]
/// Default is a preview; the server's exclusive data-directory lease applies.
pub fn cleanup_workspaces(args: Vec<String>) -> Result<(), String> {
    let mut parent = None;
    let mut apply = false;
    let mut args = args.into_iter();
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--apply" => apply = true,
            "--parent" => parent = Some(PathBuf::from(args.next().ok_or("--parent requires a project parent directory")?)),
            _ => return Err(format!("Unknown cleanup argument: {argument}. Usage: --cleanup-workspaces [--parent WORKSPACE_PARENT] [--apply]")),
        }
    }
    let root_raw = crate::workspace::data_root();
    let root = crate::path_identity::actual_path(&root_raw)
        .or_else(|_| {
            root_raw
                .canonicalize()
                .map_err(|error| format!("Cannot open Grapher data directory: {error}"))
        })?;
    let database = root.join("events.sqlite");
    if !database.is_file() {
        return Err(format!(
            "Grapher database not found: {}",
            database.display()
        ));
    }
    let _lease = crate::runtime_lock::acquire(&root)?;
    crate::native::check_retired_leases(&root)?;
    let store = Store::open(&database)?;
    store.backfill_cleanup_sources()?;
    let explicit_parent = parent.is_some();
    let parent = parent.unwrap_or_else(|| crate::workspace::workspaces_parent(&root));
    if !explicit_parent {
        fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
    }
    let parent = crate::path_identity::actual_path(&parent)
        .or_else(|_| {
            parent
                .canonicalize()
                .map_err(|error| format!("Cannot resolve workspace parent: {error}"))
        })?;
    let plan = workspace_plan(&root, &store, &parent)?;
    let engine_parent = crate::workspace::native_runtime_parent();
    let sources = store.cleanup_sources()?;
    let engines: Vec<_> = crate::native_runtime_storage::unused(&engine_parent)?
        .into_iter()
        .filter(|engine| {
            !sources
                .iter()
                .any(|source| crate::workspace::scope_contains(source, &engine.directory))
        })
        .collect();
    println!(
        "[cleanup] {} (data: {})",
        if apply {
            "Apply"
        } else {
            "Preview; nothing will be deleted"
        },
        root.display()
    );
    for path in &plan.paths {
        println!("[cleanup] workspace: {}", path.display());
    }
    for path in &plan.shadow_paths {
        println!("[cleanup] shadow repository: {}", path.display());
    }
    for task in &plan.tasks {
        println!(
            "[cleanup] queued Run {} (attempts: {}, last error: {})",
            task.run_id,
            task.attempts,
            task.last_error.as_deref().unwrap_or("none")
        );
        for target in &task.manifest.targets {
            match target.resolve(&root, &task.run_id) {
                Ok(Some(path))
                    if !task
                        .manifest
                        .protected_sources
                        .iter()
                        .chain(&sources)
                        .any(|source| crate::workspace::scope_contains(source, &path)) =>
                {
                    println!("[cleanup] owned resource: {}", path.display())
                }
                Err(error) => println!("[cleanup] blocked resource: {error}"),
                _ => {}
            }
        }
        if let Some(repository) = &task.manifest.unresolved_repository {
            println!("[cleanup] unresolved legacy binding: {repository}");
        }
    }
    for engine in &engines {
        println!("[cleanup] unused engine: {}", engine.directory.display());
    }
    println!("[cleanup] {} workspace paths, {} unused engine copies; retained {} live/unproven Run roots.",
        plan.paths.len(), engines.len(), plan.retained);
    println!(
        "[cleanup] {} shadow repositories; retained {} referenced by incomplete Runs.",
        plan.shadow_paths.len(),
        plan.shadow_retained
    );
    println!(
        "[cleanup] {} cleanup tasks (deleted conversations and completed-run workspaces).",
        plan.tasks.len()
    );
    if apply {
        for task in &plan.tasks {
            crate::cleanup::validate(&root, &task.run_id, &task.manifest)?;
        }
        for task in &plan.tasks {
            if task.manifest.sequence.is_none() && !store.run_was_deleted(&task.run_id)? {
                store.delete_run_with_cleanup(&task.run_id, Some(&task.manifest))?;
            } else {
                if task.manifest.sequence.is_some() {
                    store.remember_cleanup_targets(&task.run_id, &task.manifest.targets)?;
                }
                store.enqueue_cleanup(&task.run_id, &task.manifest)?;
            }
        }
        crate::workspace_cleanup::remove_paths(plan.paths.into_iter().collect())?;
        crate::workspace_cleanup::remove_paths(plan.shadow_paths.into_iter().collect())?;
        let mut failures = Vec::new();
        for task in &plan.tasks {
            if let Err(error) = crate::cleanup::attempt(&root, &store, task) {
                failures.push(format!("{}: {error}", task.run_id));
            }
        }
        for engine in engines {
            crate::native_runtime_storage::remove(&engine)?;
        }
        if !failures.is_empty() {
            return Err(format!("Cleanup remains queued:\n{}", failures.join("\n")));
        }
        println!("[cleanup] Completed. Conversations, source files and retained Run directories were not deleted.");
    } else {
        println!("[cleanup] Review the paths, then repeat with --apply to delete them.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Config, EventKind, Graph};

    #[test]
    fn preview_reclaims_only_recorded_current_roots_and_preserves_retired_layouts() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("data");
        let source = temp.path().join("source");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&source).unwrap();
        let store = Store::open(&root.join("events.sqlite")).unwrap();
        let live_id = Uuid::new_v4().to_string();
        let deleted_id = Uuid::new_v4().to_string();
        let unknown_id = Uuid::new_v4().to_string();
        let alias_id = Uuid::new_v4().to_string();
        let attempt_id = Uuid::new_v4().to_string();
        let config: Config = serde_json::from_value(
            serde_json::json!({"repository":source,"model":"test","maxParallel":1}),
        )
        .unwrap();
        for id in [&live_id, &deleted_id] {
            let mut state = Snapshot {
                run_id: id.clone(),
                ..Default::default()
            };
            store
                .append(
                    &mut state,
                    EventKind::Created {
                        graph: Graph::default(),
                        config: config.clone(),
                        planning_id: None,
                        planning: None,
                    },
                )
                .unwrap();
            store
                .remember_cleanup_targets(
                    id,
                    &BTreeSet::from([crate::cleanup::Target::Workspace {
                        parent: temp.path().canonicalize().unwrap(),
                        bucket: ".grapher-worktrees".into(),
                        owner: id.clone(),
                        checkout: None,
                    }]),
                )
                .unwrap();
        }
        store.delete_run(&deleted_id).unwrap();
        let ws = temp.path().join(".grapher-worktrees");
        let legacy = temp
            .path()
            .join(".grapher-workspaces")
            .join(&alias_id)
            .join(&attempt_id);
        for path in [
            ws.join(&live_id),
            ws.join(&deleted_id),
            ws.join(&unknown_id),
            legacy.clone(),
        ] {
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("marker"), "retained during preview").unwrap();
        }
        let attempt = root.join("planning").join(&attempt_id);
        fs::create_dir_all(&attempt).unwrap();
        fs::write(
            attempt.join("request.json"),
            serde_json::json!({"runId":live_id}).to_string(),
        )
        .unwrap();
        fs::write(
            attempt.join("planner-workspace"),
            legacy.to_string_lossy().as_bytes(),
        )
        .unwrap();
        // Even a matching tombstone cannot override a surviving legacy reference.
        store.delete_run(&alias_id).unwrap();
        let plan = workspace_plan(&root, &store, &temp.path().canonicalize().unwrap()).unwrap();
        assert_eq!(
            plan.paths,
            BTreeSet::from([ws.join(&deleted_id).canonicalize().unwrap()])
        );
        assert_eq!(plan.retained, 2);
        assert!(
            ws.join(&deleted_id).join("marker").is_file(),
            "preview does not delete"
        );
        crate::workspace_cleanup::remove_paths(plan.paths.into_iter().collect()).unwrap();
        assert!(!ws.join(&deleted_id).exists());
        assert!(ws.join(&live_id).exists());
        assert!(ws.join(&unknown_id).exists());
        assert!(legacy.exists());
        // Deleting the owner never adopts a retired path from a saved marker.
        store.delete_run(&live_id).unwrap();
        let plan = workspace_plan(&root, &store, &temp.path().canonicalize().unwrap()).unwrap();
        assert!(!plan.paths.contains(&legacy.canonicalize().unwrap()));
        assert!(!plan
            .paths
            .contains(&ws.join(&unknown_id).canonicalize().unwrap()));
    }

    #[test]
    fn offline_gc_reclaims_only_unreferenced_shadow_repos() {
        let temp = tempfile::tempdir().unwrap();
        let root = crate::workspace::data_root();
        let source = temp.path().join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("a.txt"), "a").unwrap();
        let store = Store::open(&root.join("events.sqlite")).unwrap();
        let run_id = Uuid::new_v4().to_string();
        let config: Config = serde_json::from_value(
            serde_json::json!({"repository":source,"model":"test","maxParallel":1}),
        )
        .unwrap();
        let mut state = Snapshot {
            run_id: run_id.clone(),
            ..Default::default()
        };
        store
            .append(
                &mut state,
                EventKind::Created {
                    graph: Graph::default(),
                    config,
                    planning_id: None,
                    planning: None,
                },
            )
            .unwrap();
        // An incomplete Run keeps its materialized snapshot.
        let head = crate::workspace::materialize_shadow_repo(&source, &[]).unwrap();
        assert!(!head.is_empty());
        let referenced = crate::workspace::shadow_repo_dir(&source).unwrap();
        assert!(store.shadow_repo_in_use(&referenced).unwrap());
        // A leftover directory with no owning Run is reclaimable.
        let orphan = root
            .join("shadow_repos")
            .join("orphan_0000000000000000.git");
        fs::create_dir_all(&orphan).unwrap();
        assert!(!store.shadow_repo_in_use(&orphan).unwrap());
        let plan = workspace_plan(&root, &store, temp.path()).unwrap();
        assert!(plan.shadow_paths.contains(&orphan));
        assert!(!plan.shadow_paths.contains(&referenced));
        let _ = fs::remove_dir_all(&orphan);
        let _ = fs::remove_dir_all(&referenced);
    }
}
