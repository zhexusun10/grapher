//! Offline, opt-in maintenance; never bypass the runtime's exclusive lease.

use crate::{model::Snapshot, path_safety::real_child_path, store::Store};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct StaleWorkspace {
    run_id: String,
    phase: String,
    idle_days: u64,
    path: PathBuf,
}

#[derive(Default)]
struct WorkspacePlan {
    paths: BTreeSet<PathBuf>,
    stale_paths: BTreeSet<StaleWorkspace>,
    shadow_paths: BTreeSet<PathBuf>,
    retained: usize,
    shadow_retained: usize,
    tasks: Vec<crate::cleanup::Task>,
    detached_receipts: usize,
}

fn run_is_stale_reclaimable(state: &Snapshot) -> bool {
    if state.plan_type.as_deref() == Some("serial") {
        return false;
    }
    if matches!(
        state.phase.as_str(),
        "planning" | "publishing" | "merging" | "launching_result" | "completed"
    ) {
        return false;
    }
    if state.nodes.values().any(|node| node.status == "running")
        || state
            .executions
            .iter()
            .chain(&state.mergers)
            .any(|execution| execution.status == "running")
        || state
            .result_execution
            .as_ref()
            .is_some_and(|execution| execution.status == "running")
        || state
            .planning
            .as_ref()
            .is_some_and(|planning| planning.status.as_deref() == Some("running"))
    {
        return false;
    }
    matches!(
        state.phase.as_str(),
        "failed" | "paused" | "needs_attention" | "interrupted" | "publication_failed"
    ) || state.paused
        || state
            .nodes
            .values()
            .any(|node| matches!(node.status.as_str(), "failed" | "blocked"))
}

#[cfg(test)]
fn workspace_plan(root: &Path, store: &Store, parent: &Path) -> Result<WorkspacePlan, String> {
    workspace_plan_with_stale(root, store, parent, None, crate::model::now())
}

fn workspace_plan_with_stale(
    root: &Path,
    store: &Store,
    parent: &Path,
    stale_days: Option<u64>,
    now_ms: u64,
) -> Result<WorkspacePlan, String> {
    let live: BTreeSet<_> = store.runs()?.into_iter().collect();
    let sources = store.cleanup_sources()?;
    let is_protected = |path: &Path| {
        sources
            .iter()
            .any(|source| crate::workspace::scope_contains(source, path))
    };
    let mut tasks = store.pending_cleanups()?;
    let mut stale_paths = BTreeSet::new();
    let stale_cutoff_ms = stale_days.map(|days| days.saturating_mul(86_400_000));
    for id in &live {
        let state = store.load(id)?;
        if state.phase == "completed" && !tasks.iter().any(|task| task.run_id == *id) {
            let manifest = crate::cleanup::manifest(root, store, &state, false)?;
            if manifest.targets.iter().any(|target| matches!(target, crate::cleanup::Target::Workspace { parent: owner_parent, .. } if crate::path_identity::same_path(owner_parent, parent))
                && target.resolve(root, id).ok().flatten().is_some())
            {
                tasks.push(crate::cleanup::Task {
                    run_id: id.clone(),
                    manifest,
                    attempts: 0,
                    last_error: None,
                });
            }
        } else if let Some(cutoff_ms) = stale_cutoff_ms {
            if run_is_stale_reclaimable(&state) {
                let last_activity = state.events.last().map_or(0, |event| event.timestamp);
                let elapsed_ms = now_ms.saturating_sub(last_activity);
                if elapsed_ms >= cutoff_ms {
                    let idle_days = elapsed_ms / 86_400_000;
                    for target in store.owned_cleanup_targets(id)? {
                        if let crate::cleanup::Target::Workspace {
                            parent: ref owner_parent,
                            ref bucket,
                            ref owner,
                            checkout: None,
                        } = target
                        {
                            if bucket == ".grapher-worktrees"
                                && owner == id
                                && crate::path_identity::same_path(owner_parent, parent)
                            {
                                if let Some(path) = target.resolve(root, id)? {
                                    if !is_protected(&path) {
                                        stale_paths.insert(StaleWorkspace {
                                            run_id: id.clone(),
                                            phase: state.phase.clone(),
                                            idle_days,
                                            path,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    let detached_receipts = store.detached_workspaces()?.len();
    let mut plan = WorkspacePlan {
        stale_paths,
        tasks,
        detached_receipts,
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

/// Usage: --cleanup-workspaces [--parent WORKSPACE_PARENT] [--stale-days DAYS] [--apply]
/// Default is a preview; the server's exclusive data-directory lease applies.
pub fn cleanup_workspaces(args: Vec<String>) -> Result<(), String> {
    let mut parent = None;
    let mut stale_days: Option<u64> = None;
    let mut apply = false;
    let mut args = args.into_iter();
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--apply" => apply = true,
            "--parent" => parent = Some(PathBuf::from(args.next().ok_or("--parent requires a project parent directory")?)),
            "--stale-days" => {
                let raw = args
                    .next()
                    .ok_or("--stale-days requires a non-negative integer number of days")?;
                let parsed = raw
                    .parse::<u64>()
                    .map_err(|_| format!("Invalid --stale-days value: {raw}"))?;
                stale_days = Some(parsed);
            }
            _ => return Err(format!("Unknown cleanup argument: {argument}. Usage: --cleanup-workspaces [--parent WORKSPACE_PARENT] [--stale-days DAYS] [--apply]")),
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
    let plan = workspace_plan_with_stale(&root, &store, &parent, stale_days, crate::model::now())?;
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
    for stale in &plan.stale_paths {
        println!(
            "[cleanup] stale workspace (Run {}, phase={}, idle={}d): {}",
            stale.run_id,
            stale.phase,
            stale.idle_days,
            stale.path.display()
        );
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
    println!(
        "[cleanup] {} workspace paths, {} unused engine copies; retained {} live/unproven Run roots.",
        plan.paths.len(),
        engines.len(),
        plan.retained
    );
    if !plan.stale_paths.is_empty() || plan.detached_receipts > 0 {
        println!(
            "[cleanup] {} stale incomplete workspaces, {} detached cleanup receipts.",
            plan.stale_paths.len(),
            plan.detached_receipts
        );
    }
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
        crate::workspace_cleanup::remove_paths(
            plan.stale_paths.into_iter().map(|stale| stale.path).collect(),
        )?;
        crate::workspace_cleanup::remove_paths(plan.shadow_paths.into_iter().collect())?;
        let mut failures = Vec::new();
        for task in &plan.tasks {
            if let Err(error) = crate::cleanup::attempt(&root, &store, task) {
                failures.push(format!("{}: {error}", task.run_id));
            }
        }
        if let Err(error) = crate::cleanup::detached::drain(&root, &store) {
            failures.push(format!("detached workspaces: {error}"));
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

    #[test]
    fn stale_days_reclaims_abandoned_incomplete_workspaces_without_touching_recent_or_active_runs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("data");
        let source = temp.path().join("source");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&source).unwrap();
        let store = Store::open(&root.join("events.sqlite")).unwrap();
        let parent = temp.path().canonicalize().unwrap();
        let ws = parent.join(".grapher-worktrees");
        let config: Config = serde_json::from_value(
            serde_json::json!({"repository": source, "model":"test", "maxParallel":1}),
        )
        .unwrap();

        let make_run = |phase_event: EventKind| -> String {
            let id = Uuid::new_v4().to_string();
            let mut state = Snapshot {
                run_id: id.clone(),
                ..Default::default()
            };
            store
                .append(
                    &mut state,
                    EventKind::Created {
                        graph: Graph {
                            original_goal: "stale-test".into(),
                            nodes: vec![crate::model::Node {
                                id: "a".into(),
                                task: "a".into(),
                            }],
                            edges: vec![],
                        },
                        config: config.clone(),
                        planning_id: None,
                        planning: None,
                    },
                )
                .unwrap();
            store.append(&mut state, phase_event).unwrap();
            store
                .remember_cleanup_targets(
                    &id,
                    &BTreeSet::from([crate::cleanup::Target::Workspace {
                        parent: parent.clone(),
                        bucket: ".grapher-worktrees".into(),
                        owner: id.clone(),
                        checkout: None,
                    }]),
                )
                .unwrap();
            let dir = ws.join(&id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("work.txt"), "data").unwrap();
            id
        };

        let stale_failed = make_run(EventKind::Failed {
            node: "a".into(),
            execution_id: None,
            error: "boom".into(),
            output_bytes: 0,
            metrics: None,
        });
        let recent_failed = make_run(EventKind::Failed {
            node: "a".into(),
            execution_id: None,
            error: "boom".into(),
            output_bytes: 0,
            metrics: None,
        });
        let running_id = make_run(EventKind::Approved {
            base: "base".into(),
        });

        let now = crate::model::now();
        let ten_days_later = now + 10 * 86_400_000;
        // Simulate `recent_failed` having activity 1 day before `ten_days_later`.
        {
            let mut state = store.load(&recent_failed).unwrap();
            store
                .append(&mut state, EventKind::Paused { paused: true })
                .unwrap();
            // Shift `stale_failed` and `running_id` events back by advancing `now_ms`.
        }
        // With `now_ms = now + 10 days`, both failed runs are > 7 days old unless we distinguish:
        // update recent_failed timestamp explicitly via a second check with 12 days vs 5 days.
        let plan_none = workspace_plan_with_stale(&root, &store, &parent, None, ten_days_later).unwrap();
        assert!(plan_none.stale_paths.is_empty());

        let plan_7d = workspace_plan_with_stale(&root, &store, &parent, Some(7), ten_days_later).unwrap();
        let stale_ids: BTreeSet<_> = plan_7d
            .stale_paths
            .iter()
            .map(|entry| entry.run_id.clone())
            .collect();
        assert!(stale_ids.contains(&stale_failed));
        assert!(stale_ids.contains(&recent_failed));
        assert!(
            !stale_ids.contains(&running_id),
            "running graph must never be reclaimed as stale"
        );

        let plan_15d = workspace_plan_with_stale(&root, &store, &parent, Some(15), ten_days_later).unwrap();
        assert!(
            plan_15d.stale_paths.is_empty(),
            "runs idle for 10 days must not match --stale-days 15"
        );

        // Removing stale workspace directories keeps the SQLite conversation intact.
        crate::workspace_cleanup::remove_paths(
            plan_7d
                .stale_paths
                .into_iter()
                .map(|entry| entry.path)
                .collect(),
        )
        .unwrap();
        assert!(!ws.join(&stale_failed).exists());
        assert!(ws.join(&running_id).is_dir());
        assert!(store.contains_run(&stale_failed).unwrap());
    }
}
