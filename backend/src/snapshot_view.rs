//! Read projections for the browser. They never mutate the event-sourced state
//! or redefine the persisted Snapshot/Execution schema.
use crate::model::{Event, EventKind, Execution, Snapshot};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize)]
struct ProcessStart<'a> {
    #[serde(rename = "type", borrow)]
    kind: &'a str,
    pid: Option<u64>,
}

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
    status: &'a str,
    started_at: u64,
    completed_at: Option<u64>,
    output: &'static str,
    output_bytes: usize,
    pid: Option<u64>,
    metrics: &'a Option<crate::model::ExecutionMetrics>,
}

fn execution_metadata(execution: &Execution) -> ExecutionMetadata<'_> {
    let pid = execution.output.lines().next()
        .and_then(|line| serde_json::from_str::<ProcessStart<'_>>(line).ok())
        .filter(|event| event.kind == "grapher_process_started")
        .and_then(|event| event.pid);
    ExecutionMetadata {
        id: &execution.id, node: &execution.node, revision: execution.revision,
        attempt: execution.attempt, session_id: &execution.session_id,
        worktree: &execution.worktree, before: &execution.before, after: &execution.after,
        status: &execution.status, started_at: execution.started_at,
        completed_at: execution.completed_at, output: "", output_bytes: execution.output.len(),
        pid, metrics: &execution.metrics,
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

/// Durable projection only: history and transcripts remain in the event table.
pub(crate) fn checkpoint_projection(state: &Snapshot) -> Value {
    json!({
        "runId": state.run_id, "planType": state.plan_type,
        "planningId": state.planning_id, "planning": state.planning,
        "graph": state.graph, "config": state.config, "plan": state.plan, "nodes": state.nodes,
        "executions": state.executions.iter().map(execution_metadata).collect::<Vec<_>>(),
        "mergers": state.mergers.iter().map(execution_metadata).collect::<Vec<_>>(),
        "publication": state.publication, "events": [], "approved": state.approved,
        "paused": state.paused, "phase": state.phase, "base": state.base,
        "publishedHead": state.published_head, "feedbackCounts": state.feedback_counts,
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
        "graph": state.graph, "config": state.config, "plan": state.plan, "nodes": state.nodes,
        "executions": state.executions.iter().map(execution_metadata).collect::<Vec<_>>(),
        "mergers": state.mergers.iter().map(execution_metadata).collect::<Vec<_>>(),
        "publication": state.publication, "events": events, "approved": state.approved,
        "paused": state.paused, "phase": state.phase, "base": state.base, "feedbackCounts": state.feedback_counts,
        "runMetrics": state.run_metrics
    });
    if let Some(plan_type) = &state.plan_type {
        metadata["planType"] = json!(plan_type);
    }
    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Event, EventKind};

    #[test]
    fn metadata_filters_large_outputs_without_changing_event_schema() {
        let mut state = Snapshot::default();
        state.events.push(Event {
            sequence: 1, timestamp: 42,
            kind: EventKind::Finished {
                execution_id: "worker".into(), head: "abc".into(),
                output: "large output".repeat(1000),
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
            after: None, status: "running".into(), started_at: 42,
            completed_at: None, metrics: None,
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

pub fn execution_page(
    state: &Snapshot,
    execution_id: &str,
    offset: usize,
) -> Result<Value, String> {
    let execution = state
        .executions
        .iter()
        .chain(&state.mergers)
        .find(|e| e.id == execution_id)
        .ok_or("Execution not found in run")?;
    let text = &execution.output;
    if offset > text.len() || !text.is_char_boundary(offset) {
        return Err("Invalid output offset".into());
    }
    let mut end = offset.saturating_add(256 * 1024).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok(json!({ "runId": state.run_id, "executionId": execution_id,
        "content": &text[offset..end], "nextOffset": end, "totalBytes": text.len(),
        "complete": end == text.len(), "status": execution.status }))
}
