//! Read projections for the browser. They never mutate the event-sourced state
//! or redefine the persisted Snapshot/Execution schema.
use crate::model::{Event, EventKind, Execution, Snapshot};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionMetadata<'a> {
    id: &'a str,
    node: &'a str,
    revision: usize,
    attempt: usize,
    session_id: &'a str,
    worktree: &'a str,
    before: &'a str,
    after: &'a Option<String>,
    workspace_lineage: &'a Vec<String>,
    input: &'a Option<crate::environment::CompositeResult>,
    result: &'a Option<crate::environment::CompositeResult>,
    status: &'a str,
    started_at: u64,
    completed_at: Option<u64>,
    output: &'static str,
    output_bytes: usize,
    pid: Option<u64>,
    metrics: &'a Option<crate::model::ExecutionMetrics>,
}

fn execution_metadata(execution: &Execution) -> ExecutionMetadata<'_> {
    ExecutionMetadata {
        id: &execution.id, node: &execution.node, revision: execution.revision,
        attempt: execution.attempt, session_id: &execution.session_id,
        worktree: &execution.worktree, before: &execution.before, after: &execution.after,
        workspace_lineage: &execution.workspace_lineage, input: &execution.input, result: &execution.result,
        status: &execution.status, started_at: execution.started_at,
        completed_at: execution.completed_at, output: "",
        output_bytes: if execution.status == "running" { execution.output.len().max(execution.output_bytes) } else { execution.output_bytes },
        pid: execution.pid, metrics: &execution.metrics,
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
    let Ok(mut value) = serde_json::to_value(event) else { return Value::Null };
    let Some(object) = value.as_object_mut() else { return value };
    for key in ["graph", "config", "input", "result", "descriptor", "files", "settings"] {
        object.remove(key);
    }
    if let Some(execution) = object.get_mut("execution").and_then(Value::as_object_mut) {
        execution.retain(|key, _| matches!(key.as_str(), "id" | "node"));
    }
    value
}

/// Durable projection only: history stays in events, transcripts in execution_logs.
pub(crate) fn checkpoint_projection(state: &Snapshot) -> Value {
    json!({
        "nodeMessageQueueVersion": 1,
        "runId": state.run_id, "planType": state.plan_type,
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
        "publishedHead": state.published_head, "feedbackCounts": state.feedback_counts,
        "pendingFeedback": state.pending_feedback, "reviewGraph": state.review_graph,
        "previewGraph": state.preview_graph,
        "environmentPolicy": state.environment_policy,
        "environmentBaseline": state.environment_baseline, "publishedResult": state.published_result,
        "resultExecution": state.result_execution,
        "runMetrics": state.run_metrics
    })
}

pub fn snapshot_metadata(state: &Snapshot) -> Result<Value, String> {
    let events = state.events.iter().filter_map(|event| match &event.kind {
        EventKind::Output { .. } => None,
        EventKind::Finished { execution_id, head, .. } => Some(EventMetadata::Finished {
            kind: "finished", execution_id, head,
            sequence: event.sequence, timestamp: event.timestamp,
        }),
        _ => Some(EventMetadata::Projected(metadata_event(event))),
    }).collect::<Vec<_>>();
    let mut metadata = json!({
        "runId": state.run_id, "planningId": state.planning_id, "planning": state.planning,
        "graph": state.graph, "config": state.config, "modelConfig": state.model_config,
        "plan": state.plan, "nodes": state.nodes,
        "executions": state.executions.iter().map(execution_metadata).collect::<Vec<_>>(),
        "mergers": state.mergers.iter().map(execution_metadata).collect::<Vec<_>>(),
        "supersededExecutionIds": state.superseded_execution_ids,
        "publication": state.publication, "events": events, "approved": state.approved,
        "paused": state.paused, "canResume": state.can_resume(), "phase": state.phase, "base": state.base, "feedbackCounts": state.feedback_counts,
        "environmentPolicy": state.environment_policy,
        "environmentBaseline": state.environment_baseline, "publishedResult": state.published_result,
        "resultExecution": state.result_execution,
        "runMetrics": state.run_metrics
    });
    // Keep legacy persisted failure events/checkpoints compatible while exposing
    // interruption as a distinct UI state. Ordinary provider errors stay failed.
    for (name, node) in &state.nodes {
        if node.is_user_paused() {
            metadata["nodes"][name]["status"] = json!("paused");
        }
    }
    let interrupted: std::collections::BTreeSet<_> = state.events.iter().filter_map(|event| {
        match &event.kind {
            EventKind::Failed { execution_id: Some(id), error, .. }
                if crate::model::is_interrupted_error(error) => Some(id.as_str()),
            _ => None,
        }
    }).chain(state.execution_stop_requests.iter().map(String::as_str)).collect();
    for execution in metadata["executions"].as_array_mut().unwrap() {
        if execution["status"] == "failed"
            && execution["id"].as_str().is_some_and(|id| interrupted.contains(id)) {
            execution["status"] = json!("paused");
        }
    }
    if let Some(graph) = &state.review_graph {
        metadata["graph"] = json!(graph);
        metadata["plan"] = json!(crate::compiler::compile(graph, false).ok());
    } else if let Some(graph) = state.preview_graph.as_ref().filter(|_| !state.has_live_work()) {
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
    fn file_change_metadata_exposes_counts_for_the_browser() {
        use crate::model::{Event, EventKind};

        let mut state = Snapshot::default();
        state.run_id = "changes-run".into();
        state.events.push(Event {
            sequence: 1, timestamp: 1,
            kind: EventKind::Paused { paused: false },
        });
        state.executions.push(crate::model::Execution {
            id: "exec".into(), node: "worker".into(), revision: 0, attempt: 1,
            session_id: "session".into(), worktree: "/repo".into(), before: String::new(),
            workspace_lineage: vec![], after: None, input: None, result: None,
            status: "completed".into(), output: String::new(), output_bytes: 0, pid: None,
            started_at: 1, completed_at: Some(2), metrics: None,
        });
        let jsonl = [
            r#"{"type":"tool_execution_start","toolCallId":"t","toolName":"edit","args":{"path":"src/a.ts","edits":[{"oldText":"old","newText":"new"}]}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t","toolName":"edit","isError":false}"#,
        ].join("
");
        crate::file_changes::update_from_log_text(
            "changes-run", "exec", "worker", "/repo", "/repo", &jsonl, false, true,
        );

        let projected = snapshot_metadata(&state).unwrap();
        assert_eq!(projected["fileChangesOmitted"], true);
        assert!(projected.get("fileChanges").is_none());
        assert!(projected["executions"][0].get("fileChanges").is_none());
        // Counts remain available through the on-demand projection.
        let changes = crate::file_changes::get_cached_run_changes(&state).unwrap();
        let value = serde_json::to_value(crate::file_changes::cap_summary_files(
            changes, crate::file_changes::MAX_DISPLAYED_FILE_CHANGES)).unwrap();
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
            sequence: 1, timestamp: 42,
            kind: EventKind::Finished {
                execution_id: "worker".into(), head: "abc".into(),
                output: "large output".repeat(1000), output_bytes: 0, metrics: None,
            },
        });
        state.events.push(Event {
            sequence: 2, timestamp: 43,
            kind: EventKind::Output { execution_id: "worker".into(), text: "secret".into() },
        });
        state.events.push(Event {
            sequence: 3, timestamp: 44,
            kind: EventKind::Paused { paused: true },
        });
        state.executions.push(Execution {
            id: "worker".into(), node: "n".into(), revision: 1, attempt: 1,
            session_id: "s".into(), worktree: String::new(), before: String::new(),
            workspace_lineage: vec![],
            after: None, status: "running".into(), started_at: 42,
            input: None, result: None,
            completed_at: None, metrics: None, output_bytes: 0, pid: Some(123),
            output: "{\"type\":\"grapher_process_started\",\"pid\":123,\"cwd\":\"x\"}\nsecret".into(),
        });
        let metadata = snapshot_metadata(&state).unwrap();
        assert_eq!(metadata["events"], json!([
            {"type":"finished", "execution_id":"worker", "head":"abc", "sequence":1, "timestamp":42},
            {"type":"paused", "paused":true, "sequence":3, "timestamp":44}
        ]));
        assert_eq!(metadata["executions"][0]["pid"], 123);
        assert_eq!(metadata["executions"][0]["output"], "");
        assert_eq!(metadata["executions"][0]["outputBytes"], state.executions[0].output.len());
    }

    #[test]
    fn metadata_events_drop_durable_payloads_but_keep_conversation_fields() {
        let mut state = Snapshot::default();
        state.run_id = "trim-run".into();
        state.events.push(Event {
            sequence: 1, timestamp: 1,
            kind: EventKind::Started {
                execution: Execution {
                    id: "worker".into(), node: "task".into(), revision: 1, attempt: 1,
                    session_id: "s".into(), worktree: "/repo".into(), before: String::new(),
                    workspace_lineage: vec!["/repo".into()], after: None, input: None, result: None,
                    status: "completed".into(), started_at: 1, completed_at: Some(2),
                    metrics: None, output_bytes: 0, pid: None, output: "secret".into(),
                },
                message_sequences: Some(vec![1]), fresh_restart: false,
            },
        });
        state.events.push(Event {
            sequence: 2, timestamp: 2,
            kind: EventKind::GraphRevised {
                graph: Graph { original_goal: "goal".into(), nodes: vec![], edges: vec![] },
                planning_id: "plan".into(), planning: PlanningSummary::default(),
                invalidated: vec![], source_head: None,
            },
        });
        let metadata = snapshot_metadata(&state).unwrap();
        let events = metadata["events"].as_array().unwrap();
        // The browser needs the Execution identity, not its worktree/output.
        assert_eq!(events[0]["execution"], json!({"id": "worker", "node": "task"}));
        assert_eq!(events[0]["message_sequences"], json!([1]));
        // The projected `graph`/`config` fields carry these; the event copy is redundant.
        assert!(events[1].get("graph").is_none());
        assert!(events[1].get("config").is_none());
        assert_eq!(events[1]["planning_id"], "plan");
        assert!(events[1]["planning"].is_object());
    }

    #[test]
    fn metadata_caps_large_change_lists_but_keeps_true_totals() {
        use crate::file_changes::{FileChangeItem, FileChangeSummary};
        let files = (0..120).map(|index| FileChangeItem {
            path: format!("UI/.next/standalone/node_modules/pkg-{index}.js"),
            old_path: None,
            status: if index % 40 == 0 { "added".into() } else { "modified".into() },
            additions: index, deletions: 0, is_running: false,
            nodes: vec![], execution_ids: vec![], source: Some("git".into()),
        }).collect::<Vec<_>>();
        let summary = FileChangeSummary::from_files(files, false, None);
        let capped = crate::file_changes::cap_summary_files(
            summary, crate::file_changes::MAX_DISPLAYED_FILE_CHANGES);
        let projected = serde_json::to_value(&capped).unwrap();
        assert_eq!(projected["totalFiles"], 120);
        assert_eq!(projected["files"].as_array().unwrap().len(), crate::file_changes::MAX_DISPLAYED_FILE_CHANGES);
        // Added files lead the retained slice, matching the browser display order.
        assert_eq!(projected["files"][0]["status"], "added");
    }

    #[test]
    fn planner_preview_graph_is_display_only_and_cleared_by_its_turn() {
        let draft = Graph {
            original_goal: "Draft a topology".into(),
            nodes: vec![crate::model::Node { name: "one".into(), task: "Do one".into() }],
            edges: vec![],
        };
        let mut state = Snapshot::default();
        crate::model::apply(&mut state, &Event {
            sequence: 1, timestamp: 1,
            kind: EventKind::PlannerPreviewProgress { graph: draft.clone() },
        });
        // Accepted edits preview before the turn commits, and a reload replays
        // them from the checkpoint/event log instead of waiting for the commit.
        assert_eq!(state.preview_graph, Some(draft.clone()));
        assert_eq!(state.graph.nodes.len(), 0, "the committed graph stays unchanged");
        let metadata = snapshot_metadata(&state).unwrap();
        assert_eq!(metadata["graph"], serde_json::to_value(&draft).unwrap());
        assert_eq!(metadata["plan"]["executionBatches"], json!([["one"]]));
        assert_eq!(checkpoint_projection(&state)["previewGraph"],
            serde_json::to_value(&draft).unwrap());

        // Live work keeps owning the displayed topology; provisional edits
        // must never pass for a running graph.
        state.nodes.insert("one".into(), crate::model::NodeState { status: "running".into(), ..Default::default() });
        assert_eq!(snapshot_metadata(&state).unwrap()["graph"], json!(state.graph));
        state.nodes.get_mut("one").unwrap().status = "waiting".into();
        assert_eq!(snapshot_metadata(&state).unwrap()["graph"], serde_json::to_value(&draft).unwrap());

        // A failed or aborted turn restores the committed topology.
        crate::model::apply(&mut state, &Event {
            sequence: 2, timestamp: 2,
            kind: EventKind::PlannerTurnAborted { planning: PlanningSummary::default() },
        });
        assert_eq!(state.preview_graph, None);
        assert_eq!(snapshot_metadata(&state).unwrap()["graph"], json!(state.graph));
    }
}
