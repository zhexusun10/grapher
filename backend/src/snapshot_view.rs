//! Read projections for the browser. They never mutate the event-sourced state
//! or redefine the persisted Snapshot/Execution schema.
use crate::model::{Event, EventKind, Execution, Snapshot};
use serde::Serialize;
use serde_json::{json, Value};
use ts_rs::TS;

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "Execution")]
pub(crate) struct ExecutionMetadata<'a> {
    id: &'a str,
    node: &'a str,
    #[ts(type = "number")]
    revision: usize,
    #[ts(type = "number")]
    attempt: usize,
    session_id: &'a str,
    worktree: &'a str,
    before: &'a str,
    after: &'a Option<String>,
    workspace_lineage: &'a Vec<String>,
    #[ts(type = "unknown")]
    input: &'a Option<crate::environment::CompositeResult>,
    #[ts(type = "unknown")]
    result: &'a Option<crate::environment::CompositeResult>,
    status: &'a str,
    #[ts(type = "number")]
    started_at: u64,
    #[ts(type = "number | null")]
    completed_at: Option<u64>,
    output: &'static str,
    #[ts(type = "number")]
    output_bytes: usize,
    #[ts(type = "number | null")]
    pid: Option<u64>,
    #[ts(type = "ExecutionMetrics | null")]
    metrics: &'a Option<crate::model::ExecutionMetrics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "FileChangeSummary", optional)]
    file_changes: Option<Value>,
}

fn execution_metadata(execution: &Execution) -> ExecutionMetadata<'_> {
    ExecutionMetadata {
        id: &execution.id,
        node: &execution.node,
        revision: execution.revision,
        attempt: execution.attempt,
        session_id: &execution.session_id,
        worktree: &execution.worktree,
        before: &execution.before,
        after: &execution.after,
        workspace_lineage: &execution.workspace_lineage,
        input: &execution.input,
        result: &execution.result,
        status: &execution.status,
        started_at: execution.started_at,
        completed_at: execution.completed_at,
        output: "",
        output_bytes: if execution.status == "running" {
            execution.output.len().max(execution.output_bytes)
        } else {
            execution.output_bytes
        },
        pid: execution.pid,
        metrics: &execution.metrics,
        file_changes: None,
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum EventMetadata<'a> {
    Projected(Value),
    Finished {
        #[serde(rename = "type")]
        kind: &'static str,
        execution_id: &'a str,
        head: &'a str,
        sequence: i64,
        timestamp: u64,
    },
}

/// The browser reads the projected `graph`/`executions` fields, never the
/// durable graph, config or environment payloads embedded in a business event.
/// Re-sending them on every metadata poll only inflates the first-screen
/// response, so keep event identity, the Planner summary and the started
/// Execution's identity, and drop the rest.
fn metadata_event(event: &Event) -> Value {
    // Recovery owns the full bound turn. Browser polls need only its identity,
    // not another copy of the task, feedback notices and base64 image payloads.
    if let EventKind::NodeInputBound { execution_id, .. } = &event.kind {
        return json!({
            "type": "node_input_bound", "execution_id": execution_id,
            "sequence": event.sequence, "timestamp": event.timestamp,
        });
    }
    let Ok(mut value) = serde_json::to_value(event) else {
        return Value::Null;
    };
    let Some(object) = value.as_object_mut() else {
        return value;
    };
    for key in [
        "graph",
        "config",
        "goal",
        "input",
        "result",
        "descriptor",
        "files",
        "settings",
    ] {
        object.remove(key);
    }
    // Recall receipts are fetched only by their originating request. Repeating
    // their image payloads in every browser poll would duplicate durable input.
    if matches!(&event.kind, EventKind::QueueWithdrawalRecorded { .. }) {
        object.remove("messages");
    }
    if let Some(execution) = object.get_mut("execution").and_then(Value::as_object_mut) {
        execution.retain(|key, _| matches!(key.as_str(), "id" | "node"));
    }
    value
}

/// Durable projection only: history stays in events, transcripts in execution_logs.
pub(crate) fn checkpoint_projection(state: &Snapshot) -> Value {
    json!({
        "formatVersion": 1,
        "privateBatch": state.private_batch,
        "isolatedWorkspaces": state.isolated_workspaces,
        "batchHandoff": state.batch_handoff,
        "runId": state.run_id, "title": state.title, "planType": state.plan_type,
        "planningId": state.planning_id, "planning": state.planning,
        "graph": state.graph, "config": state.config, "modelConfig": state.model_config,
        "plan": state.plan, "nodes": state.nodes,
        "executions": state.executions.iter().map(execution_metadata).collect::<Vec<_>>(),
        "mergers": state.mergers.iter().map(execution_metadata).collect::<Vec<_>>(),
        "supersededExecutionIds": state.superseded_execution_ids,
        "publication": state.publication, "events": [], "approved": state.approved,
        "paused": state.paused, "stopRequested": state.stop_requested,
        "executionStopRequests": state.execution_stop_requests,
        "canResume": state.can_resume(), "phase": state.phase, "base": state.base,
        "publishedHead": state.published_head,
        "publishedHeads": state.published_heads, "feedbackCounts": state.feedback_counts,
        "pendingFeedback": state.pending_feedback, "reviewGraph": state.review_graph,
        "previewGraph": state.preview_graph,
        "environmentPolicy": state.environment_policy,
        "environmentBaseline": state.environment_baseline, "publishedResult": state.published_result,
        "resultExecution": state.result_execution,
        "runMetrics": state.run_metrics
    })
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "Snapshot")]
pub(crate) struct SnapshotMetadata<'a> {
    run_id: &'a str,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
    #[ts(optional = nullable)]
    isolated_workspaces: Option<bool>,
    #[ts(optional)]
    private_batch: Option<&'a Vec<String>>,
    #[ts(type = "{ recoveryExecutionIds: string[] } | null", optional)]
    batch_handoff: Option<&'a crate::model::BatchHandoff>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    planning_id: Option<&'a str>,
    #[ts(type = "PlanningSummary | null", optional)]
    planning: Option<&'a crate::model::PlanningSummary>,
    #[ts(type = "Graph")]
    graph: &'a crate::model::Graph,
    #[ts(type = "Config | null")]
    config: &'a Option<crate::model::Config>,
    #[ts(type = "ConversationModelConfig | null", optional)]
    model_config: Option<&'a crate::model::RunModelConfig>,
    #[ts(type = "Plan | null")]
    plan: &'a Option<crate::model::Plan>,
    #[ts(type = "Record<string, NodeState>")]
    nodes: &'a std::collections::BTreeMap<String, crate::model::NodeState>,
    executions: Vec<ExecutionMetadata<'a>>,
    #[ts(optional)]
    mergers: Option<Vec<ExecutionMetadata<'a>>>,
    #[ts(optional)]
    superseded_execution_ids: Option<&'a Vec<String>>,
    #[ts(type = "Publication | null", optional)]
    publication: Option<&'a crate::model::Publication>,
    #[ts(type = "GraphEvent[]")]
    events: Vec<EventMetadata<'a>>,
    approved: bool,
    paused: bool,
    #[ts(optional)]
    can_resume: Option<bool>,
    phase: &'a str,
    base: &'a str,
    #[ts(type = "Record<string, number>")]
    feedback_counts: &'a std::collections::BTreeMap<String, usize>,
    #[ts(skip)]
    environment_policy: &'a Option<String>,
    #[ts(skip)]
    environment_baseline: &'a Option<crate::environment::CompositeResult>,
    #[ts(skip)]
    published_result: &'a Option<crate::environment::ResultDescriptor>,
    #[ts(type = "{ status: string } | null", optional)]
    result_execution: Option<&'a crate::model::ResultExecution>,
    #[ts(type = "RunMetrics | null", optional)]
    run_metrics: Option<&'a crate::model::RunMetrics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "'serial' | 'graph'", optional)]
    plan_type: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    file_changes_omitted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "FileChangeSummary", optional)]
    file_changes: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    stop_requested: Option<bool>,
}

pub fn snapshot_metadata(state: &Snapshot) -> Result<Value, String> {
    let mut latest_planning_event_index: std::collections::HashMap<&str, usize> =
        std::collections::HashMap::new();
    for (index, event) in state.events.iter().enumerate() {
        if let Some(id) = event
            .planning_summary()
            .map(|summary| summary.planning_id.as_str())
            .filter(|id| !id.is_empty())
        {
            latest_planning_event_index.insert(id, index);
        }
    }
    let events = state
        .events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| match &event.kind {
            EventKind::Output { .. } => None,
            EventKind::Finished {
                execution_id, head, ..
            } => Some(EventMetadata::Finished {
                kind: "finished",
                execution_id,
                head,
                sequence: event.sequence,
                timestamp: event.timestamp,
            }),
            _ => {
                let mut projected = metadata_event(event);
                // When a later event for the same planning turn already carries
                // its authoritative summary, drop the duplicated `planning.goal`
                // from earlier events so large pasted prompts are not repeated.
                if let Some(planning) = projected
                    .get_mut("planning")
                    .and_then(Value::as_object_mut)
                {
                    let is_superseded = planning
                        .get("planningId")
                        .and_then(Value::as_str)
                        .and_then(|id| latest_planning_event_index.get(id))
                        .is_some_and(|&latest| latest > index);
                    if is_superseded {
                        planning.remove("goal");
                    }
                }
                Some(EventMetadata::Projected(projected))
            }
        })
        .collect::<Vec<_>>();
    let (can_resume, resumable) = state.recovery_hints();
    let mut metadata = serde_json::to_value(SnapshotMetadata {
        run_id: &state.run_id,
        title: state.title.as_deref(),
        isolated_workspaces: state.isolated_workspaces,
        private_batch: Some(&state.private_batch),
        batch_handoff: state.batch_handoff.as_ref(),
        planning_id: state.planning_id.as_deref(),
        planning: state.planning.as_ref(),
        graph: &state.graph,
        config: &state.config,
        model_config: state.model_config.as_ref(),
        plan: &state.plan,
        nodes: &state.nodes,
        executions: state.executions.iter().map(execution_metadata).collect(),
        mergers: Some(state.mergers.iter().map(execution_metadata).collect()),
        superseded_execution_ids: Some(&state.superseded_execution_ids),
        publication: state.publication.as_ref(),
        events,
        approved: state.approved,
        paused: state.paused,
        can_resume: Some(can_resume),
        phase: &state.phase,
        base: &state.base,
        feedback_counts: &state.feedback_counts,
        environment_policy: &state.environment_policy,
        environment_baseline: &state.environment_baseline,
        published_result: &state.published_result,
        result_execution: state.result_execution.as_ref(),
        run_metrics: state.run_metrics.as_ref(),
        plan_type: state.plan_type.as_deref(),
        file_changes_omitted: (!state.run_id.is_empty()).then_some(true),
        file_changes: None,
        stop_requested: None,
    })
    .map_err(|e| e.to_string())?;
    // Persist failure events as recorded; expose user interruptions as a
    // distinct UI state. Ordinary provider errors stay failed.
    let running_merge_targets: std::collections::BTreeSet<_> = state
        .mergers
        .iter()
        .filter(|merger| merger.status == "running")
        .filter_map(|merger| merger.node.strip_prefix("merge:"))
        .collect();
    for (name, node) in &state.nodes {
        if let Some(node_obj) = metadata["nodes"][name].as_object_mut() {
            // Browser projections read user images from events; stripping
            // internal recovery/queue image copies avoids duplicating large
            // base64 payloads on every snapshot poll.
            node_obj.remove("instructionImages");
            if let Some(continuation) = node_obj
                .get_mut("feedbackContinuation")
                .and_then(Value::as_object_mut)
            {
                continuation.remove("images");
            }
            if let Some(pending) = node_obj
                .get_mut("pendingMessages")
                .and_then(Value::as_array_mut)
            {
                for message in pending {
                    if let Some(msg_obj) = message.as_object_mut() {
                        msg_obj.remove("images");
                    }
                }
            }
        }
        metadata["nodes"][name]["canResume"] = json!(resumable.contains(name));
        if node.is_user_paused() {
            metadata["nodes"][name]["status"] = json!("paused");
        } else if node.status == "running" && running_merge_targets.contains(name.as_str()) {
            // While a node-composition merger is resolving conflicts for `name`,
            // the node's own execution has not started yet; expose it as waiting
            // until the merger settles and preparation advances to the node.
            metadata["nodes"][name]["status"] = json!("waiting");
        }
    }
    let interrupted: std::collections::BTreeSet<_> = state
        .events
        .iter()
        .filter_map(|event| match &event.kind {
            EventKind::Failed {
                execution_id: Some(id),
                error,
                ..
            } if crate::model::is_interrupted_error(error) => Some(id.as_str()),
            _ => None,
        })
        .chain(state.execution_stop_requests.iter().map(String::as_str))
        .collect();
    for execution in metadata["executions"].as_array_mut().unwrap() {
        if execution["status"] == "failed"
            && execution["id"]
                .as_str()
                .is_some_and(|id| interrupted.contains(id))
        {
            execution["status"] = json!("paused");
        }
    }
    if let Some(graph) = &state.review_graph {
        metadata["graph"] = json!(graph);
        metadata["plan"] = json!(crate::compiler::compile(graph, false).ok());
    } else if let Some(graph) = state
        .preview_graph
        .as_ref()
        .filter(|_| !state.has_live_work())
    {
        // The foreground Planner draft is display-only, so a reload rebuilds
        // the incremental topology from the durable projection. Running work
        // keeps the committed graph; a commit, failure or abort clears it.
        metadata["graph"] = json!(graph);
        metadata["plan"] = json!(crate::compiler::compile(graph, false).ok());
    }
    if let Some(plan_type) = &state.plan_type {
        metadata["planType"] = json!(plan_type);
    }
    if !state.run_id.is_empty() {
        // File changes are read on demand through `get_file_changes`: a
        // build-heavy Run can hold tens of thousands of paths, and the first
        // screen only shows a collapsed trigger. Mark the omission so the
        // browser knows to fetch instead of reading a stale empty summary.
        metadata["fileChangesOmitted"] = json!(true);
    }
    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Event, EventKind, Graph, PlanningSummary};

    #[test]
    fn batched_recovery_matches_individual_checks_for_mixed_nodes_and_mergers() {
        let mut state = Snapshot {
            run_id: "recovery-projection".into(),
            approved: true,
            phase: "needs_attention".into(),
            ..Default::default()
        };
        for index in 0..64 {
            let name = format!("node-{index}");
            let status = match index % 4 {
                0 => "running",
                1 => "failed",
                2 => "blocked",
                _ => "completed",
            };
            state.graph.nodes.push(crate::model::Node {
                id: name.clone(),
                task: name.clone(),
            });
            state.nodes.insert(
                name.clone(),
                crate::model::NodeState {
                    status: status.into(),
                    ..Default::default()
                },
            );
            state.executions.push(serde_json::from_value(json!({
                "id":format!("exec-{index}"),"node":name,"revision":1,"attempt":1,
                "sessionId":name,"worktree":format!("/work/{index}"),"before":"","after":null,
                "status":if status == "blocked" { "failed" } else { status },
                "startedAt":1,"completedAt":2,"output":"","outputBytes":if status == "blocked" { 0 } else { 1 }
            })).unwrap());
            if status == "blocked" {
                let error = format!("blocked-{index}");
                state.nodes.get_mut(&name).unwrap().error = Some(error.clone());
                if index % 3 == 0 {
                    state.events.push(Event {
                        sequence: state.events.len() as i64 + 1,
                        timestamp: 1,
                        kind: EventKind::Prepared {
                            execution_id: format!("exec-{index}"),
                            head: "head".into(),
                        },
                    });
                }
                state.events.push(Event {
                    sequence: state.events.len() as i64 + 1,
                    timestamp: 2,
                    kind: EventKind::Failed {
                        node: name.clone(),
                        execution_id: Some(format!("exec-{index}")),
                        error: "different preparation error".into(),
                        output_bytes: 0,
                        metrics: None,
                    },
                });
                state.events.push(Event {
                    sequence: state.events.len() as i64 + 1,
                    timestamp: 2,
                    kind: EventKind::Blocked {
                        node: name.clone(),
                        error,
                    },
                });
            }
            if index > 0 {
                state.graph.edges.push(
                    serde_json::from_value(
                        json!({"from":format!("node-{}",index-1),"to":name,"feedback":false}),
                    )
                    .unwrap(),
                );
            }
        }
        state.superseded_execution_ids.push("exec-5".into());
        let mut merger = state.executions[1].clone();
        merger.id = "merge".into();
        merger.node = "merge:node-9".into();
        merger.status = "running".into();
        state.mergers.push(merger);
        let managed_config: crate::model::Config = serde_json::from_value(json!({
            "repository":"/work", "model":"test/model", "maxParallel":1,
            "environment":{"mode":"native", "platform":"test", "arch":"test", "scopes":[],
                "layout":"fixed", "launch":{"entry":"/bin/bash", "path":[], "shell":"/bin/bash"}, "baseline":[]}
        })).unwrap();
        for managed in [false, true] {
            state.config = managed.then(|| managed_config.clone());
            for phase in [
                "running",
                "needs_attention",
                "completed",
                "publishing",
                "paused",
            ] {
                for isolated in [None, Some(false), Some(true)] {
                    for paused in [false, true] {
                        state.phase = phase.into();
                        state.isolated_workspaces = isolated;
                        state.paused = paused;
                        let (run_hint, batched) = state.recovery_hints();
                        assert_eq!(run_hint, state.can_resume());
                        for name in state.nodes.keys() {
                            assert_eq!(batched.contains(name), state.can_resume_node(name),
                                "{name}: {phase}, isolated={isolated:?}, paused={paused}, managed={managed}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn indexed_recovery_preserves_preparation_session_and_merger_failure_evidence() {
        let mut state = Snapshot {
            approved: true,
            phase: "needs_attention".into(),
            ..Default::default()
        };
        state.graph.nodes.push(crate::model::Node {
            id: "task".into(),
            task: "test".into(),
        });
        state.nodes.insert(
            "task".into(),
            crate::model::NodeState {
                status: "blocked".into(),
                error: Some("Workspace composition blocked: Merger failed: conflict".into()),
                ..Default::default()
            },
        );
        let execution: crate::model::Execution = serde_json::from_value(json!({
            "id":"attempt","node":"task","revision":1,"attempt":1,"sessionId":"session",
            "worktree":"/work","before":"","after":null,"status":"failed",
            "startedAt":1,"completedAt":2,"output":"","outputBytes":0
        }))
        .unwrap();
        let mut merger = execution.clone();
        merger.id = "merge-attempt".into();
        merger.node = "merge:task".into();
        state.executions.push(execution);
        state.mergers.push(merger);
        let check = |state: &Snapshot| {
            let (run, nodes) = state.recovery_hints();
            assert_eq!(run, state.can_resume());
            for name in state.nodes.keys() {
                assert_eq!(nodes.contains(name), state.can_resume_node(name));
            }
        };
        check(&state);
        assert!(state.resumable_nodes().contains("task"));
        state.events.push(Event {
            sequence: 1,
            timestamp: 1,
            kind: EventKind::Prepared {
                execution_id: "attempt".into(),
                head: "head".into(),
            },
        });
        check(&state);
        assert!(state.resumable_nodes().is_empty());
        // Session-open failures remain preparation-only even after Prepared.
        state.events.push(Event {
            sequence: 2,
            timestamp: 2,
            kind: EventKind::Failed {
                node: "task".into(),
                execution_id: Some("attempt".into()),
                error: "Cannot open node session: missing".into(),
                output_bytes: 0,
                metrics: None,
            },
        });
        check(&state);
        assert!(state.resumable_nodes().contains("task"));
        // Only the newest failure explains the current preparation state.
        state.events.push(Event {
            sequence: 3,
            timestamp: 3,
            kind: EventKind::Failed {
                node: "task".into(),
                execution_id: Some("attempt".into()),
                error: "ordinary error".into(),
                output_bytes: 0,
                metrics: None,
            },
        });
        check(&state);
        assert!(state.resumable_nodes().is_empty());
        state.superseded_execution_ids.push("attempt".into());
        check(&state);
        assert!(state.resumable_nodes().is_empty());
    }

    #[test]
    fn large_failed_graph_projects_recovery_without_per_card_global_rescans() {
        let count = 2000;
        let mut state = Snapshot {
            run_id: "large-recovery".into(),
            approved: true,
            phase: "needs_attention".into(),
            ..Default::default()
        };
        for index in 0..count {
            let name = format!("task-{index}");
            state.graph.nodes.push(crate::model::Node {
                id: name.clone(),
                task: name.clone(),
            });
            let blocked = index % 2 == 0;
            state.nodes.insert(
                name.clone(),
                crate::model::NodeState {
                    status: if blocked { "blocked" } else { "failed" }.into(),
                    error: blocked.then(|| "preparation failed".into()),
                    ..Default::default()
                },
            );
            if blocked {
                state.events.push(Event {
                    sequence: state.events.len() as i64 + 1,
                    timestamp: 1,
                    kind: EventKind::Failed {
                        node: name.clone(),
                        execution_id: Some(name.clone()),
                        error: "preparation failed".into(),
                        output_bytes: 0,
                        metrics: None,
                    },
                });
                state.events.push(Event {
                    sequence: state.events.len() as i64 + 1,
                    timestamp: 1,
                    kind: EventKind::Blocked {
                        node: name.clone(),
                        error: "preparation failed".into(),
                    },
                });
            }
            state.executions.push(serde_json::from_value(json!({
                "id":name,"node":name,"revision":1,"attempt":1,"sessionId":name,
                "worktree":"/work","before":"","after":null,"status":"failed",
                "startedAt":1,"completedAt":2,"output":"","outputBytes":if blocked { 0 } else { 1 }
            })).unwrap());
        }
        let metadata = snapshot_metadata(&state).unwrap();
        assert_eq!(metadata["nodes"].as_object().unwrap().len(), count);
        assert!(metadata["nodes"]
            .as_object()
            .unwrap()
            .values()
            .all(|node| node["canResume"] == true));
        assert_eq!(metadata["canResume"], true);
        // A run-wide Continue may clear the pause, but node-specific Continue
        // must still respect it even when both hints share the same indexes.
        state.paused = true;
        let paused = snapshot_metadata(&state).unwrap();
        assert_eq!(paused["canResume"], true);
        assert!(paused["nodes"]
            .as_object()
            .unwrap()
            .values()
            .all(|node| node["canResume"] == false));
    }

    #[test]
    fn file_change_metadata_exposes_counts_for_the_browser() {
        use crate::model::{Event, EventKind};

        let mut state = Snapshot {
            run_id: "changes-run".into(),
            ..Snapshot::default()
        };
        state.events.push(Event {
            sequence: 1,
            timestamp: 1,
            kind: EventKind::Paused { paused: false },
        });
        state.executions.push(crate::model::Execution {
            id: "exec".into(),
            node: "worker".into(),
            revision: 0,
            attempt: 1,
            session_id: "session".into(),
            worktree: "/repo".into(),
            before: String::new(),
            workspace_lineage: vec![],
            after: None,
            input: None,
            result: None,
            status: "completed".into(),
            output: String::new(),
            output_bytes: 0,
            pid: None,
            started_at: 1,
            completed_at: Some(2),
            metrics: None,
        });
        let jsonl = [
            r#"{"type":"tool_execution_start","toolCallId":"t","toolName":"edit","args":{"path":"src/a.ts","edits":[{"oldText":"old","newText":"new"}]}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t","toolName":"edit","isError":false}"#,
        ].join("
");
        crate::file_changes::update_from_log_text(
            "changes-run",
            "exec",
            "worker",
            "/repo",
            "/repo",
            &jsonl,
            false,
            true,
        );

        let projected = snapshot_metadata(&state).unwrap();
        assert_eq!(projected["fileChangesOmitted"], true);
        assert!(projected.get("fileChanges").is_none());
        assert!(projected["executions"][0].get("fileChanges").is_none());
        // Counts remain available through the on-demand projection.
        let changes = crate::file_changes::get_cached_run_changes(&state).unwrap();
        let value = serde_json::to_value(crate::file_changes::cap_summary_files(
            changes,
            crate::file_changes::MAX_DISPLAYED_FILE_CHANGES,
        ))
        .unwrap();
        assert_eq!(value["totalFiles"], 1);
        assert_eq!(value["files"][0]["path"], "src/a.ts");
        assert_eq!(value["files"][0]["additions"], 1);
        assert_eq!(value["files"][0]["deletions"], 1);
        assert!(value["files"][0].get("diff").is_none());
        crate::file_changes::invalidate_run("changes-run");
    }

    #[test]
    fn metadata_filters_large_outputs_without_changing_event_schema() {
        let mut state = Snapshot::default();
        state.events.push(Event {
            sequence: 1,
            timestamp: 42,
            kind: EventKind::Finished {
                execution_id: "worker".into(),
                head: "abc".into(),
                output: "large output".repeat(1000),
                output_bytes: 0,
                metrics: None,
            },
        });
        state.events.push(Event {
            sequence: 2,
            timestamp: 43,
            kind: EventKind::Output {
                execution_id: "worker".into(),
                text: "secret".into(),
            },
        });
        state.events.push(Event {
            sequence: 3,
            timestamp: 44,
            kind: EventKind::Paused { paused: true },
        });
        state.executions.push(Execution {
            id: "worker".into(),
            node: "n".into(),
            revision: 1,
            attempt: 1,
            session_id: "s".into(),
            worktree: String::new(),
            before: String::new(),
            workspace_lineage: vec![],
            after: None,
            status: "running".into(),
            started_at: 42,
            input: None,
            result: None,
            completed_at: None,
            metrics: None,
            output_bytes: 0,
            pid: Some(123),
            output: "{\"type\":\"grapher_process_started\",\"pid\":123,\"cwd\":\"x\"}\nsecret"
                .into(),
        });
        let metadata = snapshot_metadata(&state).unwrap();
        assert_eq!(
            metadata["events"],
            json!([
                {"type":"finished", "execution_id":"worker", "head":"abc", "sequence":1, "timestamp":42},
                {"type":"paused", "paused":true, "sequence":3, "timestamp":44}
            ])
        );
        assert_eq!(metadata["executions"][0]["pid"], 123);
        assert_eq!(metadata["executions"][0]["output"], "");
        assert_eq!(
            metadata["executions"][0]["outputBytes"],
            state.executions[0].output.len()
        );
    }

    #[test]
    fn metadata_events_drop_durable_payloads_but_keep_conversation_fields() {
        let mut state = Snapshot {
            run_id: "trim-run".into(),
            ..Snapshot::default()
        };
        state.events.push(Event {
            sequence: 1,
            timestamp: 1,
            kind: EventKind::Started {
                execution: Execution {
                    id: "worker".into(),
                    node: "task".into(),
                    revision: 1,
                    attempt: 1,
                    session_id: "s".into(),
                    worktree: "/repo".into(),
                    before: String::new(),
                    workspace_lineage: vec!["/repo".into()],
                    after: None,
                    input: None,
                    result: None,
                    status: "completed".into(),
                    started_at: 1,
                    completed_at: Some(2),
                    metrics: None,
                    output_bytes: 0,
                    pid: None,
                    output: "secret".into(),
                },
                message_sequences: Some(vec![1]),
                fresh_restart: false,
            },
        });
        state.events.push(Event {
            sequence: 2,
            timestamp: 2,
            kind: EventKind::GraphRevised {
                graph: Graph {
                    original_goal: "goal".into(),
                    nodes: vec![],
                    edges: vec![],
                },
                planning_id: "plan".into(),
                planning: PlanningSummary::default(),
                invalidated: vec![],
                source_head: None,
            },
        });
        let metadata = snapshot_metadata(&state).unwrap();
        let events = metadata["events"].as_array().unwrap();
        // The browser needs the Execution identity, not its worktree/output.
        assert_eq!(
            events[0]["execution"],
            json!({"id": "worker", "node": "task"})
        );
        assert_eq!(events[0]["message_sequences"], json!([1]));
        // The projected `graph`/`config` fields carry these; the event copy is redundant.
        assert!(events[1].get("graph").is_none());
        assert!(events[1].get("config").is_none());
        assert_eq!(events[1]["planning_id"], "plan");
        assert!(events[1]["planning"].is_object());
    }

    #[test]
    fn metadata_omits_recovery_input_without_mutating_durable_events() {
        let event = Event {
            sequence: 1,
            timestamp: 42,
            kind: EventKind::NodeInputBound {
                execution_id: "worker".into(),
                instruction: "complete recovery input".into(),
                images: Some(vec![crate::model::ImageAttachment {
                    r#type: "image".into(),
                    mime_type: "image/png".into(),
                    data: "a".repeat(8192),
                    name: None,
                }]),
            },
        };
        let durable = serde_json::to_value(&event).unwrap();
        let state = Snapshot {
            events: vec![event],
            ..Default::default()
        };
        let metadata = snapshot_metadata(&state).unwrap();
        assert_eq!(
            metadata["events"],
            json!([{
                "type": "node_input_bound", "execution_id": "worker", "sequence": 1, "timestamp": 42,
            }])
        );
        assert_eq!(serde_json::to_value(&state.events[0]).unwrap(), durable);
        assert_eq!(durable["instruction"], "complete recovery input");
        assert_eq!(durable["images"][0]["data"].as_str().unwrap().len(), 8192);
    }

    #[test]
    fn metadata_caps_large_change_lists_but_keeps_true_totals() {
        use crate::file_changes::{FileChangeItem, FileChangeSummary};
        let files = (0..120)
            .map(|index| FileChangeItem {
                path: format!("UI/.next/standalone/node_modules/pkg-{index}.js"),
                old_path: None,
                status: if index % 40 == 0 {
                    "added".into()
                } else {
                    "modified".into()
                },
                additions: index,
                deletions: 0,
                is_running: false,
                nodes: vec![],
                execution_ids: vec![],
                source: Some("git".into()),
            })
            .collect::<Vec<_>>();
        let summary = FileChangeSummary::from_files(files, false, None);
        let capped = crate::file_changes::cap_summary_files(
            summary,
            crate::file_changes::MAX_DISPLAYED_FILE_CHANGES,
        );
        let projected = serde_json::to_value(&capped).unwrap();
        assert_eq!(projected["totalFiles"], 120);
        assert_eq!(
            projected["files"].as_array().unwrap().len(),
            crate::file_changes::MAX_DISPLAYED_FILE_CHANGES
        );
        // Added files lead the retained slice, matching the browser display order.
        assert_eq!(projected["files"][0]["status"], "added");
    }

    #[test]
    fn planner_preview_graph_is_display_only_and_cleared_by_its_turn() {
        let draft = Graph {
            original_goal: "Draft a topology".into(),
            nodes: vec![crate::model::Node {
                id: "one".into(),
                task: "Do one".into(),
            }],
            edges: vec![],
        };
        let mut state = Snapshot::default();
        crate::model::apply(
            &mut state,
            &Event {
                sequence: 1,
                timestamp: 1,
                kind: EventKind::PlannerPreviewProgress {
                    graph: draft.clone(),
                },
            },
        );
        // Accepted edits preview before the turn commits, and a reload replays
        // them from the checkpoint/event log instead of waiting for the commit.
        assert_eq!(state.preview_graph, Some(draft.clone()));
        assert_eq!(
            state.graph.nodes.len(),
            0,
            "the committed graph stays unchanged"
        );
        let metadata = snapshot_metadata(&state).unwrap();
        assert_eq!(metadata["graph"], serde_json::to_value(&draft).unwrap());
        assert_eq!(metadata["plan"]["executionBatches"], json!([["one"]]));
        assert_eq!(
            checkpoint_projection(&state)["previewGraph"],
            serde_json::to_value(&draft).unwrap()
        );

        // Live work keeps owning the displayed topology; provisional edits
        // must never pass for a running graph.
        state.nodes.insert(
            "one".into(),
            crate::model::NodeState {
                status: "running".into(),
                ..Default::default()
            },
        );
        assert_eq!(
            snapshot_metadata(&state).unwrap()["graph"],
            json!(state.graph)
        );
        state.nodes.get_mut("one").unwrap().status = "waiting".into();
        assert_eq!(
            snapshot_metadata(&state).unwrap()["graph"],
            serde_json::to_value(&draft).unwrap()
        );

        // A failed or aborted turn restores the committed topology.
        crate::model::apply(
            &mut state,
            &Event {
                sequence: 2,
                timestamp: 2,
                kind: EventKind::PlannerTurnAborted {
                    planning: PlanningSummary::default(),
                },
            },
        );
        assert_eq!(state.preview_graph, None);
        assert_eq!(
            snapshot_metadata(&state).unwrap()["graph"],
            json!(state.graph)
        );
    }

    #[test]
    fn running_node_merger_projects_its_target_node_as_waiting() {
        let mut state = Snapshot::default();
        state.nodes.insert(
            "join".into(),
            crate::model::NodeState {
                status: "running".into(),
                revision: 1,
                ..Default::default()
            },
        );
        state.nodes.insert(
            "blocked_node".into(),
            crate::model::NodeState {
                status: "blocked".into(),
                revision: 1,
                ..Default::default()
            },
        );
        state.mergers.push(Execution {
            id: "merger-running".into(),
            node: "merge:join".into(),
            revision: 1,
            attempt: 1,
            session_id: "merger-running".into(),
            worktree: "/worktrees/join".into(),
            before: "base".into(),
            workspace_lineage: vec![],
            after: None,
            input: None,
            result: None,
            status: "running".into(),
            output: String::new(),
            output_bytes: 0,
            pid: None,
            started_at: 1,
            completed_at: None,
            metrics: None,
        });
        state.mergers.push(Execution {
            id: "merger-retry".into(),
            node: "merge:blocked_node".into(),
            revision: 1,
            attempt: 2,
            session_id: "merger-retry".into(),
            worktree: "/worktrees/blocked".into(),
            before: "base".into(),
            workspace_lineage: vec![],
            after: None,
            input: None,
            result: None,
            status: "running".into(),
            output: String::new(),
            output_bytes: 0,
            pid: None,
            started_at: 2,
            completed_at: None,
            metrics: None,
        });

        let metadata = snapshot_metadata(&state).unwrap();
        assert_eq!(metadata["nodes"]["join"]["status"], json!("waiting"));
        assert_eq!(
            metadata["nodes"]["blocked_node"]["status"],
            json!("blocked")
        );

        // Once the merger completes, the target node returns to running.
        state.mergers[0].status = "completed".into();
        state.mergers[0].completed_at = Some(3);
        let settled = snapshot_metadata(&state).unwrap();
        assert_eq!(settled["nodes"]["join"]["status"], json!("running"));
    }

    #[test]
    fn metadata_omits_redundant_event_goal_and_superseded_planning_goal() {
        let large_goal = "massive pasted log ".repeat(5_000);
        let planning = PlanningSummary {
            planning_id: "plan-1".into(),
            goal: Some(large_goal.clone()),
            ..Default::default()
        };
        let config: crate::model::Config = serde_json::from_value(json!({
            "repository": "/repo", "model": "test/model", "maxParallel": 1
        }))
        .unwrap();
        let mut state = Snapshot {
            run_id: "dedup-goal".into(),
            planning_id: Some("plan-1".into()),
            planning: Some(planning.clone()),
            graph: Graph {
                original_goal: large_goal.clone(),
                ..Default::default()
            },
            ..Default::default()
        };
        state.events.push(Event {
            sequence: 1,
            timestamp: 1,
            kind: EventKind::PlanningStarted {
                goal: large_goal.clone(),
                config: config.clone(),
                planning: planning.clone(),
                plan_type: Some("serial".into()),
            },
        });
        state.events.push(Event {
            sequence: 2,
            timestamp: 2,
            kind: EventKind::Created {
                graph: state.graph.clone(),
                config,
                planning_id: Some("plan-1".into()),
                planning: Some(planning.clone()),
            },
        });
        let metadata = snapshot_metadata(&state).unwrap();
        let events = metadata["events"].as_array().unwrap();
        assert!(events[0].get("goal").is_none());
        assert!(events[0]["planning"].get("goal").is_none());
        assert_eq!(events[0]["planning"]["planningId"], "plan-1");
        assert_eq!(events[1]["planning"]["goal"], large_goal);
        assert_eq!(metadata["graph"]["originalGoal"], large_goal);
    }
}
