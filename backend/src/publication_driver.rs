//! Publication is a driver-owned worker, not a blocking scheduler turn.
use super::*;
use std::path::Path;

/// Extra user context belongs only to source publication. Node preparation still
/// passes its Job.task unchanged, and Merger continuations retain their own chat.
pub(super) fn merger_query(state: &Snapshot) -> String {
    let withdrawn = state.withdrawn_steer_sequences();
    let planner_statuses: std::collections::BTreeMap<_, _> = state
        .events
        .iter()
        .filter_map(|event| match &event.kind {
            EventKind::PlannerSteerStatus {
                planning_id,
                request_id,
                status,
                ..
            } => Some(((planning_id.as_str(), request_id.as_str()), status.as_str())),
            _ => None,
        })
        .collect();
    let requests: Vec<String> = state
        .events
        .iter()
        .filter(|event| !withdrawn.contains(&event.sequence))
        .filter_map(|event| match &event.kind {
            EventKind::Steered {
                execution_id,
                instruction,
                ..
            } if !state.superseded_execution_ids.contains(execution_id)
                && !instruction.trim().is_empty() =>
            {
                Some(instruction.clone())
            }
            EventKind::PlannerSteerSubmitted {
                planning_id,
                request_id,
                instruction,
                ..
            } if !instruction.trim().is_empty()
                && !matches!(
                    planner_statuses.get(&(planning_id.as_str(), request_id.as_str())),
                    Some(&"failed" | &"withdrawn" | &"handled")
                ) =>
            {
                Some(instruction.clone())
            }
            _ => None,
        })
        .collect();
    if requests.is_empty() {
        state.graph.original_goal.clone()
    } else {
        format!(
            "{}\n\n<user further request>\n{}\n</user further request>",
            state.graph.original_goal,
            requests.join("\n\n")
        )
    }
}

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
            runtime
                .state
                .batch_handoff
                .as_ref()
                .into_iter()
                .flat_map(|handoff| &handoff.recovery_execution_ids)
                .map(|id| {
                    runtime
                        .state
                        .executions
                        .iter()
                        .find(|execution| execution.id == *id)
                        .cloned()
                        .ok_or_else(|| "Missing batch recovery execution".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        if !recoveries.is_empty() {
            let heads = recoveries
                .iter()
                .map(|execution| {
                    Runtime::capture_batch_recovery(root, run_id, &config, execution)
                        .map(|head| (execution.id.clone(), head))
                })
                .collect::<Result<std::collections::BTreeMap<_, _>, _>>()?;
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
        let exclusions = service
            .runtime
            .lock()
            .map_err(|e| e.to_string())?
            .exclusions()?;
        let publication_path = crate::workspace::workspaces_parent(root)
            .join(".grapher-worktrees")
            .join(run_id)
            .join(
                crate::graph_merge::publication_workspace(&repository, &publication.heads)?
                    .file_name()
                    .ok_or("Invalid publication workspace")?,
            );
        let head = crate::graph_merge::merge_graph_scoped_at(
            &repository,
            &publication.heads,
            &exclusions,
            &publication_path,
            |publication_workspace| {
                let attempt = service
                    .runtime
                    .lock()
                    .map_err(|e| e.to_string())?
                    .state
                    .mergers
                    .len()
                    + 1;
                crate::graph_merge::resolve_with_merger(
                    publication_workspace,
                    &query,
                    &config,
                    root,
                    attempt,
                    |event| {
                        service
                            .runtime
                            .lock()
                            .map_err(|e| e.to_string())?
                            .emit(event)
                    },
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
        || runtime.state.publication.as_ref().is_none_or(|current| {
            current.heads != publication.heads || current.repository != publication.repository
        })
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
    if let Err(error) = runtime.defer_cleanup_worktrees() {
        eprintln!("Cannot retire completed run worktrees: {error}");
    }
    drop(runtime);
    crate::file_changes::record_publication_git_changes(
        run_id,
        &repository,
        &base_commit,
        &published_commit,
    );
    reclaim_source_snapshot(service, &repository);
    if !batch_workspaces {
        let review = {
            let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
            runtime
                .state
                .effective_config()
                .filter(|config| config.post_task_review)
                .filter(|_| {
                    runtime.state.plan_type.as_deref() == Some("graph")
                        && runtime.state.phase == "completed"
                        && !runtime.state.stop_requested
                        && runtime
                            .state
                            .nodes
                            .values()
                            .all(|node| node.status == "completed")
                })
        };
        if let Some(config) = review {
            if let Err((error, _)) = plan_goal_internal_with_started(
                POST_TASK_REVIEW_PROMPT.into(),
                config,
                Some("graph"),
                None,
                Some(run_id.to_string()),
                service,
                true,
                |_| {},
                |_| {},
                |_| {},
                |_| {},
            ) {
                eprintln!("Post-task Planner review failed: {error}");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Event, Graph};

    fn steer(execution: &str, node: &str, instruction: &str) -> EventKind {
        EventKind::Steered {
            execution_id: execution.into(),
            node: node.into(),
            instruction: instruction.into(),
            request_id: None,
            images: None,
        }
    }

    fn planner_steer(id: &str, instruction: &str) -> EventKind {
        EventKind::PlannerSteerSubmitted {
            planning_id: "plan".into(),
            request_id: id.into(),
            instruction: instruction.into(),
            images: None,
        }
    }

    fn planner_status(id: &str, status: &str) -> EventKind {
        EventKind::PlannerSteerStatus {
            planning_id: "plan".into(),
            request_id: id.into(),
            status: status.into(),
            error: None,
        }
    }

    fn state(events: Vec<EventKind>) -> Snapshot {
        Snapshot {
            graph: Graph {
                original_goal: "Refactor login".into(),
                ..Default::default()
            },
            events: events
                .into_iter()
                .enumerate()
                .map(|(index, kind)| Event {
                    sequence: index as i64 + 1,
                    timestamp: 0,
                    kind,
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn publication_steer_context_keeps_original_goal_and_ordered_request_text() {
        let mut state = state(vec![]);
        assert_eq!(merger_query(&state), "Refactor login");
        state = self::state(vec![
            planner_steer("first", "Keep the old API"),
            steer("a-1", "a", "不要修改数据库 schema"),
            planner_status("first", "consumed"),
            steer("merge-1", "merger", "Preserve the source-side validation"),
        ]);
        let query = merger_query(&state);
        assert_eq!(query, "Refactor login\n\n<user further request>\nKeep the old API\n\n不要修改数据库 schema\n\nPreserve the source-side validation\n</user further request>");
        assert_eq!(state.graph.original_goal, "Refactor login");
        let prompt =
            crate::graph_merge::merger_prompt(&query, crate::graph_merge::MergerConflicts::GIT);
        assert!(prompt.contains(&query));
        assert!(prompt.contains("context, not a task to execute"));
        // Node preparation still gets only its own Job.task, even in a Run with steers.
        let node_prompt = crate::graph_merge::merger_prompt(
            "Prepare node C",
            crate::graph_merge::MergerConflicts::GIT,
        );
        assert!(!node_prompt.contains("<user further request>"));
        assert!(
            node_prompt.contains("<workspace_objective>\nPrepare node C\n</workspace_objective>")
        );
    }

    #[test]
    fn publication_steer_context_excludes_withdrawn_failed_and_superseded_requests() {
        let mut state = state(vec![
            steer("a-1", "a", "withdrawn node request"),
            EventKind::SteersWithdrawn {
                execution_id: "a-1".into(),
                message_sequences: vec![1],
            },
            steer("old-a", "a", "superseded node request"),
            planner_steer("failed", "failed Planner request"),
            planner_status("failed", "failed"),
            planner_steer("withdrawn", "withdrawn Planner request"),
            planner_status("withdrawn", "queued"),
            planner_status("withdrawn", "withdrawn"),
            planner_steer("handled", "extension command"),
            planner_status("handled", "handled"),
            steer("a-1", "a", "  "),
            EventKind::Output {
                execution_id: "a-1".into(),
                text: "assistant output".into(),
            },
        ]);
        state.superseded_execution_ids.push("old-a".into());
        assert_eq!(merger_query(&state), state.graph.original_goal);
        state.events.push(Event {
            sequence: 13,
            timestamp: 0,
            kind: steer("a-2", "a", "Keep this request"),
        });
        assert!(merger_query(&state)
            .ends_with("<user further request>\nKeep this request\n</user further request>"));
    }

    #[test]
    fn publication_steer_context_survives_replay_without_duplicate_requests() {
        let temp = tempfile::TempDir::new().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        runtime
            .emit(EventKind::Created {
                graph: Graph {
                    original_goal: "Refactor login".into(),
                    ..Default::default()
                },
                config: serde_json::from_value(serde_json::json!({
                    "repository": temp.path(), "model": "fixture",
                }))
                .unwrap(),
                planning_id: None,
                planning: None,
            })
            .unwrap();
        runtime
            .emit(planner_steer("first", "Keep the old API"))
            .unwrap();
        runtime.emit(planner_status("first", "consumed")).unwrap();
        runtime.emit(steer("a-1", "a", "Keep the schema")).unwrap();
        let before = merger_query(&runtime.state);
        let restored = runtime.store.load(&runtime.state.run_id).unwrap();
        assert_eq!(merger_query(&restored), before);
        assert_eq!(before.matches("Keep the old API").count(), 1);
        assert_eq!(before.matches("Keep the schema").count(), 1);
    }
}
