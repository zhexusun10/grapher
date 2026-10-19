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
    Original(&'a Event),
    Finished {
        #[serde(rename = "type")]
        kind: &'static str,
        execution_id: &'a str,
        head: &'a str,
        sequence: i64,
        timestamp: u64,
    },
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
        _ => Some(EventMetadata::Original(event)),
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
    }
    if let Some(plan_type) = &state.plan_type {
        metadata["planType"] = json!(plan_type);
    }
    if !state.run_id.is_empty() {
        for (idx, exec) in state.executions.iter().enumerate() {
            if let Some(changes) = crate::file_changes::get_cached_execution_changes(&state.run_id, exec) {
                metadata["executions"][idx]["fileChanges"] = json!(changes);
            }
        }
        for (idx, exec) in state.mergers.iter().enumerate() {
            if let Some(changes) = crate::file_changes::get_cached_execution_changes(&state.run_id, exec) {
                metadata["mergers"][idx]["fileChanges"] = json!(changes);
            }
        }
        if let Some(run_changes) = crate::file_changes::get_cached_run_changes(state) {
            metadata["fileChanges"] = json!(run_changes);
        }
    }
    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Event, EventKind};

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
        let changes = &projected["executions"][0]["fileChanges"];
        assert_eq!(changes["totalFiles"], 1);
        assert_eq!(changes["files"][0]["path"], "src/a.ts");
        assert_eq!(changes["files"][0]["additions"], 1);
        assert_eq!(changes["files"][0]["deletions"], 1);
        assert!(changes["files"][0].get("diff").is_none());
        assert_eq!(projected["fileChanges"]["totalFiles"], 1);
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
}
