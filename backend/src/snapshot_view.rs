//! Read projections for the browser. They never mutate the event-sourced state
//! or redefine the persisted Snapshot/Execution schema.
use crate::model::{EventKind, Execution, Snapshot};
use serde_json::{json, Value};

fn execution_metadata(execution: &Execution) -> Value {
    let pid = execution
        .output
        .lines()
        .next()
        .and_then(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| event["type"] == "grapher_process_started")
        .and_then(|event| event["pid"].as_u64());
    json!({
        "id": execution.id, "node": execution.node, "revision": execution.revision,
        "attempt": execution.attempt, "sessionId": execution.session_id,
        "worktree": execution.worktree, "before": execution.before, "after": execution.after,
        "status": execution.status, "startedAt": execution.started_at, "completedAt": execution.completed_at,
        "output": "", "outputBytes": execution.output.len(), "pid": pid, "metrics": execution.metrics
    })
}

pub fn snapshot_metadata(state: &Snapshot) -> Result<Value, String> {
    let mut events = Vec::new();
    for event in &state.events {
        let value = match &event.kind {
            EventKind::Output { .. } => continue,
            EventKind::Finished {
                execution_id, head, ..
            } => json!({
                "type": "finished", "execution_id": execution_id, "head": head,
                "sequence": event.sequence, "timestamp": event.timestamp
            }),
            _ => serde_json::to_value(event).map_err(|e| e.to_string())?,
        };
        events.push(value);
    }
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
