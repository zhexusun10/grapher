//! Publication is a driver-owned worker, not a blocking scheduler turn.
use super::*;
use std::path::Path;

/// Choose context by the purpose of this delivery, independently of its cwd.
/// Intermediate handoffs prepare downstream work; final publication keeps the
/// user's goal and accepted requests.
pub(super) fn merger_query(state: &Snapshot) -> String {
    if let Some(objective) = handoff_merger_query(state) {
        return objective;
    }
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

fn handoff_merger_query(state: &Snapshot) -> Option<String> {
    if state.batch_handoff.is_none()
        || (state.pending_feedback.is_empty()
            && state.graph.nodes.iter().all(|node| {
                state
                    .nodes
                    .get(&node.id)
                    .is_some_and(|node| node.status == "completed")
            }))
    {
        return None;
    }
    let heads: BTreeSet<&str> = state
        .publication
        .iter()
        .flat_map(|publication| publication.heads.iter().map(String::as_str))
        .collect();
    let mut producers: BTreeSet<&str> = state
        .nodes
        .iter()
        .filter(|(_, node)| {
            node.head
                .as_deref()
                .is_some_and(|head| heads.contains(head))
        })
        .map(|(name, _)| name.as_str())
        .collect();
    producers.extend(state.executions.iter().filter_map(|execution| {
        (execution.status == "completed"
            && !state.superseded_execution_ids.contains(&execution.id)
            && execution
                .after
                .as_deref()
                .is_some_and(|head| heads.contains(head)))
        .then_some(execution.node.as_str())
    }));
    let mut targets: BTreeSet<&str> = state
        .graph
        .edges
        .iter()
        .filter(|edge| {
            !edge.feedback
                && producers.contains(edge.from.as_str())
                && state
                    .nodes
                    .get(&edge.to)
                    .is_none_or(|node| node.status != "completed")
        })
        .map(|edge| edge.to.as_str())
        .collect();
    targets.extend(state.pending_feedback.iter().filter_map(|feedback| {
        (!feedback.accepted && heads.contains(feedback.source_head.as_str()))
            .then_some(feedback.to.as_str())
    }));
    let tasks: Vec<_> = state
        .graph
        .nodes
        .iter()
        .filter(|node| targets.contains(node.id.as_str()))
        .map(|node| format!("Node {}:\n{}", node.id, node.task))
        .collect();
    let mut objective = "Integrate the completed upstream results into the source workspace so the remaining graph work can proceed.".to_string();
    if !tasks.is_empty() {
        objective.push_str("\n\nDownstream workspace objectives:\n\n");
        objective.push_str(&tasks.join("\n\n"));
    }
    Some(objective)
}

/// A missing saved prompt must use the execution's launch context, even after
/// its handoff clears, downstream tasks finish, or Planner revises the graph.
pub(super) fn merger_query_at_start(state: &Snapshot, execution_id: &str) -> String {
    let Some(start) = state.events.iter().position(|event| {
        matches!(&event.kind, EventKind::MergerStarted { execution } if execution.id == execution_id)
    }) else {
        return merger_query(state);
    };
    let mut historical = Snapshot::default();
    for event in &state.events[..=start] {
        crate::model::apply(&mut historical, event);
    }
    merger_query(&historical)
}

pub(super) fn publish_batch(
    service: &Arc<Service>,
    root: &Path,
    run_id: &str,
    config: Config,
    query: String,
    publication: crate::model::Publication,
) -> Result<(), String> {
    let repository = PathBuf::from(&publication.repository);
    // Recovery captures belonged to an older scheduler. New handoffs publish
    // completed inputs only and retain unfinished writers in their own slots.
    {
        let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        if runtime
            .state
            .batch_handoff
            .as_ref()
            .is_some_and(|handoff| !handoff.recovery_execution_ids.is_empty())
        {
            return Err("Unsupported batch recovery handoff format".into());
        }
    }
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
    if let Err(error) = runtime.defer_cleanup_worktrees() {
        eprintln!("Cannot retire completed run worktrees: {error}");
    }
    if runtime.batch_workspaces() && runtime.state.phase != "completed" {
        if let Err(error) = runtime.retire_idle_workspace_slots() {
            eprintln!("Cannot retire idle batch workspace slots: {error}");
        }
    }
    if runtime.state.phase == "completed" {
        if let Err(error) = runtime.prune_stale_environment_snapshots() {
            eprintln!("Cannot prune stale environment snapshots: {error}");
        }
    }
    drop(runtime);
    crate::file_changes::record_publication_git_changes(
        run_id,
        &repository,
        &base_commit,
        &published_commit,
    );
    reclaim_source_snapshot(service, &repository);
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

    fn handoff_state() -> Snapshot {
        let mut snapshot = state(vec![planner_steer("global", "A global user follow-up")]);
        snapshot.graph.nodes = [
            ("left", "Implement the left branch"),
            ("right", "Implement the right branch"),
            ("qa", "Integrate both branches and run build plus visual QA"),
            ("later", "A later task after QA"),
            ("unrelated", "An unrelated task"),
        ]
        .into_iter()
        .map(|(id, task)| Node {
            id: id.into(),
            task: task.into(),
        })
        .collect();
        snapshot.graph.edges = [("left", "qa"), ("right", "qa"), ("qa", "later")]
            .into_iter()
            .map(|(from, to)| Edge {
                from: from.into(),
                to: to.into(),
                feedback: false,
            })
            .collect();
        snapshot.nodes = snapshot
            .graph
            .nodes
            .iter()
            .map(|node| {
                let completed = matches!(node.id.as_str(), "left" | "right");
                (
                    node.id.clone(),
                    NodeState {
                        status: if completed { "completed" } else { "waiting" }.into(),
                        head: completed.then(|| format!("head-{}", node.id)),
                        ..Default::default()
                    },
                )
            })
            .collect();
        snapshot.batch_handoff = Some(BatchHandoff {
            recovery_execution_ids: vec![],
        });
        snapshot.publication = Some(Publication {
            repository: "/source".into(),
            heads: vec!["head-left".into(), "head-right".into()],
            status: "publishing".into(),
            head: None,
            error: None,
            started_at: 0,
            completed_at: None,
        });
        snapshot
    }

    #[test]
    fn handoff_merger_objective_uses_downstream_task_instead_of_global_requests() {
        let snapshot = handoff_state();
        let query = merger_query(&snapshot);
        assert!(query.contains("Node qa:\nIntegrate both branches and run build plus visual QA"));
        assert_eq!(
            query.matches("Node qa:").count(),
            1,
            "fan-in lists the target once"
        );
        for excluded in [
            "Refactor login",
            "A global user follow-up",
            "Implement the left branch",
            "A later task after QA",
            "An unrelated task",
            "<user further request>",
        ] {
            assert!(
                !query.contains(excluded),
                "unrelated context leaked: {excluded}"
            );
        }
        let prompt =
            crate::graph_merge::merger_prompt(&query, crate::graph_merge::MergerConflicts::GIT);
        assert!(prompt.contains("context, not a task to execute"));
        assert!(prompt.contains(&format!(
            "<workspace_objective>\n{query}\n</workspace_objective>"
        )));
    }

    #[test]
    fn handoff_merger_objective_handles_multiple_consumers_and_only_delivered_heads() {
        let mut snapshot = handoff_state();
        snapshot.graph.edges.extend([
            Edge {
                from: "right".into(),
                to: "unrelated".into(),
                feedback: false,
            },
            Edge {
                from: "left".into(),
                to: "later".into(),
                feedback: true,
            },
        ]);
        let query = merger_query(&snapshot);
        assert!(query.contains("Node qa:"));
        assert!(query.contains("Node unrelated:"));
        assert!(
            !query.contains("Node later:"),
            "feedback is not an incoming dependency"
        );
        snapshot.publication.as_mut().unwrap().heads = vec!["head-left".into()];
        assert!(!merger_query(&snapshot).contains("Node unrelated:"));
        snapshot.nodes.get_mut("qa").unwrap().status = "completed".into();
        let query = merger_query(&snapshot);
        assert!(
            !query.contains("Node qa:"),
            "completed consumers are not upcoming work"
        );
        assert!(
            !query.contains(&snapshot.graph.original_goal),
            "a handoff with remaining work stays scoped even without a direct consumer"
        );
    }

    #[test]
    fn handoff_merger_objective_includes_a_pending_feedback_target() {
        let mut snapshot = handoff_state();
        for node in snapshot.nodes.values_mut() {
            node.status = "completed".into();
        }
        snapshot.pending_feedback.push(PendingFeedback {
            execution_id: "review".into(),
            from: "right".into(),
            to: "left".into(),
            source_head: "head-right".into(),
            target_head: Some("head-left".into()),
            target_revision: 1,
            target_execution_id: Some("left-execution".into()),
            accepted: false,
            output_offset: 0,
            output_bytes: 0,
        });
        let query = merger_query(&snapshot);
        assert!(query.contains("Node left:\nImplement the left branch"));
        assert!(!query.contains("Refactor login"));
        assert!(!query.contains("A global user follow-up"));
    }

    #[test]
    fn final_batch_publication_keeps_user_goal_and_requests() {
        let mut snapshot = handoff_state();
        for node in snapshot.nodes.values_mut() {
            node.status = "completed".into();
        }
        let query = merger_query(&snapshot);
        assert!(query.starts_with("Refactor login\n\n<user further request>"));
        assert!(query.contains("A global user follow-up"));
        assert!(!query.contains("Node qa:"));
    }

    #[test]
    fn historical_merger_objective_retains_its_launch_context_after_downstream_completion() {
        let original = handoff_state();
        let mut snapshot = Snapshot::default();
        let mut append = |kind| {
            let event = Event {
                sequence: snapshot.events.len() as i64 + 1,
                timestamp: 0,
                kind,
            };
            crate::model::apply(&mut snapshot, &event);
        };
        append(EventKind::Created {
            graph: original.graph.clone(),
            config: serde_json::from_value(
                serde_json::json!({"repository": "/source", "model": "fixture"}),
            )
            .unwrap(),
            planning_id: None,
            planning: None,
        });
        for node in ["left", "right"] {
            let execution: Execution = serde_json::from_value(serde_json::json!({
                "id": node, "node": node, "revision": 1, "attempt": 1, "sessionId": node,
                "worktree": "/private", "before": "base", "status": "running", "startedAt": 0,
            }))
            .unwrap();
            append(EventKind::Started {
                execution,
                message_sequences: None,
                fresh_restart: false,
            });
            append(EventKind::Finished {
                execution_id: node.into(),
                head: format!("head-{node}"),
                output: String::new(),
                output_bytes: 0,
                metrics: None,
            });
        }
        append(EventKind::BatchHandoffRequested {
            recovery_execution_ids: vec![],
        });
        append(EventKind::PublicationStarted {
            repository: "/source".into(),
            heads: original.publication.unwrap().heads,
        });
        let execution: Execution = serde_json::from_value(serde_json::json!({
            "id": "handoff-merger", "node": "merger", "revision": 1, "attempt": 1, "sessionId": "handoff-merger",
            "worktree": "/private", "before": "base", "status": "running", "startedAt": 0,
        })).unwrap();
        append(EventKind::MergerStarted { execution });
        let before = merger_query_at_start(&snapshot, "handoff-merger");
        assert!(before.contains("Node qa:"));
        let event = Event {
            sequence: snapshot.events.len() as i64 + 1,
            timestamp: 0,
            kind: EventKind::PublicationCompleted {
                head: "delivered".into(),
            },
        };
        crate::model::apply(&mut snapshot, &event);
        snapshot
            .graph
            .nodes
            .iter_mut()
            .find(|node| node.id == "qa")
            .unwrap()
            .task = "A revised QA task".into();
        for node in snapshot.nodes.values_mut() {
            node.status = "completed".into();
        }
        assert!(!merger_query(&snapshot).contains("Node qa:"));
        assert_eq!(merger_query_at_start(&snapshot, "handoff-merger"), before);
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
