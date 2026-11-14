//! Publication is a driver-owned worker, not a blocking scheduler turn.
use super::*;
use std::path::Path;

pub(super) fn publish_batch(
    service: &Arc<Service>,
    root: &Path,
    run_id: &str,
    config: Config,
    query: String,
    mut publication: crate::model::Publication,
) -> Result<(), String> {
    let repository = PathBuf::from(&publication.repository);
    // Capture only the explicitly reserved recoveries. Concurrent admission
    // excludes these executions and every workspace supplying pinned heads.
    crate::process_control::with_owner(run_id, || -> Result<(), String> {
        let recoveries = {
            let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
            runtime.state.batch_handoff.as_ref().into_iter()
                .flat_map(|handoff| &handoff.recovery_execution_ids)
                .map(|id| runtime.state.executions.iter().find(|execution| execution.id == *id)
                    .cloned().ok_or_else(|| "Missing batch recovery execution".to_string()))
                .collect::<Result<Vec<_>, _>>()?
        };
        if !recoveries.is_empty() {
            let heads = recoveries.iter().map(|execution| {
                Runtime::capture_batch_recovery(root, run_id, &config, execution)
                    .map(|head| (execution.id.clone(), head))
            }).collect::<Result<std::collections::BTreeMap<_, _>, _>>()?;
            let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
            if runtime.state.run_id != run_id {
                return Err("Run changed during batch recovery capture".into());
            }
            publication = runtime.record_batch_recoveries(heads)?;
        }
        Ok(())
    })?;
    let preflight = {
        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
        runtime.publication_environment_input()
    };
    {
        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
        if let Some(layout) = runtime.publication_live_writer()? {
            return Err(format!("Cannot publish over a live writer: {layout}"));
        }
    }
    let (head, descriptor) = crate::process_control::with_owner(run_id, || {
        let exclusions = service.runtime.lock().map_err(|e| e.to_string())?.exclusions()?;
        let publication_path = crate::workspace::workspaces_parent(root)
            .join(".grapher-worktrees").join(run_id).join(
                crate::graph_merge::publication_workspace(&repository, &publication.heads)?
                    .file_name().ok_or("Invalid publication workspace")?);
        let head = crate::graph_merge::merge_graph_scoped_at(
            &repository, &publication.heads, &exclusions, &publication_path,
            |publication_workspace| {
                let attempt = service.runtime.lock().map_err(|e| e.to_string())?.state.mergers.len() + 1;
                crate::graph_merge::resolve_with_merger(
                    publication_workspace, &query, &config, root, attempt,
                    |event| service.runtime.lock().map_err(|e| e.to_string())?.emit(event),
                )
            },
        )?;
        let descriptor = match preflight {
            Ok(Some(job)) => match job.validate().and_then(|_| job.descriptor(&head)) {
                Ok(descriptor) => Some(descriptor),
                Err(error) => {
                    eprintln!("[Grapher] Result descriptor unavailable; publishing code without it: {error}");
                    None
                }
            },
            Ok(None) => None,
            Err(error) => {
                eprintln!("[Grapher] Environment preflight unavailable; publishing code without it: {error}");
                None
            }
        };
        Ok::<_, String>((head, descriptor))
    })?;
    let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
    if runtime.state.run_id != run_id
        || !matches!(runtime.state.phase.as_str(), "publishing" | "merging")
        || runtime.state.publication.as_ref().is_none_or(|current|
            current.heads != publication.heads || current.repository != publication.repository)
    {
        return Err("Stale publication worker cannot commit to this Run".into());
    }
    eprintln!("[Grapher] [Publication] Files delivered; internal result: {head}");
    let base_commit = runtime.state.base.clone();
    let published_commit = head.clone();
    let mut events = Vec::new();
    if let Some(descriptor) = descriptor {
        events.push(EventKind::ResultPublished { descriptor });
    }
    events.push(EventKind::PublicationCompleted { head });
    runtime.emit_outputs(events)?;
    let batch_workspaces = runtime.batch_workspaces();
    if let Err(error) = runtime.cleanup_worktrees() {
        eprintln!("Cannot clean completed run worktrees: {error}");
    }
    drop(runtime);
    crate::file_changes::record_publication_git_changes(
        run_id, &repository, &base_commit, &published_commit,
    );
    reclaim_source_snapshot(service, &repository);
    if !batch_workspaces {
        let review = {
            let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
            runtime.state.effective_config().filter(|config| config.post_task_review)
                .filter(|_| runtime.state.plan_type.as_deref() == Some("graph")
                    && runtime.state.phase == "completed" && !runtime.state.stop_requested
                    && runtime.state.nodes.values().all(|node| node.status == "completed"))
        };
        if let Some(config) = review {
            if let Err((error, _)) = plan_goal_internal_with_started(
                POST_TASK_REVIEW_PROMPT.into(), config, Some("graph"), None,
                Some(run_id.to_string()), service, true, |_| {}, |_| {}, |_| {}, |_| {},
            ) {
                eprintln!("Post-task Planner review failed: {error}");
            }
        }
    }
    Ok(())
}
