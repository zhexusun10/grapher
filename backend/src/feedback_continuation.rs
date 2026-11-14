//! Feedback rechecks retain conversation identity independently of file inputs.
use super::*;

#[path = "feedback_delivery.rs"]
mod delivery;
pub(super) use delivery::record_feedback_input;

const SENDER_TEMPLATE: &str = "feedback-returned.md";
const AFFECTED_TEMPLATE: &str = "feedback-updated.md";

impl Runtime {
    pub(super) fn node_session_missing(&self, previous: &Execution) -> bool {
        let origin = self
            .state
            .executions
            .iter()
            .find(|execution| {
                execution.node == previous.node && execution.session_id == previous.session_id
            })
            .unwrap_or(previous);
        let suffix = format!("_{}.jsonl", previous.session_id);
        match fs::read_dir(self.root.join("sessions").join(&origin.id)) {
            Ok(mut entries) => !entries.any(|entry| {
                entry.map_or(true, |entry| {
                    entry.file_name().to_string_lossy().ends_with(&suffix)
                })
            }),
            // Unreadable/ambiguous evidence is not proof that Pi never ran.
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        }
    }

    /// Queue alongside invalidation, before any repair can dispatch. Never copy
    /// a parent's/sender's conversation into another node, or revive a lineage
    /// superseded by an edit. Nodes without an attempt still start normally.
    pub(super) fn feedback_continuations(
        &self,
        target: &str,
        senders: &BTreeSet<String>,
    ) -> Vec<EventKind> {
        downstream(&self.state.graph, target)
            .into_iter()
            .filter(|name| name != target)
            .filter_map(|node| {
                let previous = self.state.executions.iter().rev().find(|execution| {
                    execution.node == node
                        && execution.completed_at.is_some()
                        && !self.state.superseded_execution_ids.contains(&execution.id)
                })?;
                // Another feedback round can invalidate a recheck before its
                // fork was written. Keep the last real own-history anchor,
                // but never skip a missing session with model/tool activity.
                let unstarted = previous.status == "failed"
                    && self.node_session_missing(previous)
                    && !self.state.executions.iter().any(|execution| {
                        execution.node == node
                            && execution.session_id == previous.session_id
                            && (execution.status == "completed"
                                || execution.pid.is_some()
                                || execution.output_bytes > 0)
                    });
                let previous = if unstarted {
                    self.state
                        .executions
                        .iter()
                        .rev()
                        .find(|execution| {
                            execution.node == node
                                && execution.completed_at.is_some()
                                && !self.state.superseded_execution_ids.contains(&execution.id)
                                && !self.node_session_missing(execution)
                        })
                        .unwrap_or(previous)
                } else {
                    previous
                };
                Some(EventKind::FeedbackContinuationQueued {
                    node,
                    continuation: FeedbackContinuation {
                        anchor_execution_id: previous.id.clone(),
                        target: target.into(),
                        sender: senders.contains(&previous.node),
                        instruction: None,
                        images: None,
                        delivery_id: None,
                        dispatched: false,
                    },
                })
            })
            .collect()
    }

    /// Resolve text only when fresh dependencies are ready, and persist it before
    /// Started. An unset template must not silently resend the original task.
    /// Runtime-owned overrides let wording be finalized without changing Rust;
    /// no prompt is ever loaded from an agent-writable project directory.
    pub(super) fn prepare_feedback_continuations(&mut self, ready: &[Node]) -> Result<BTreeSet<String>, String> {
        let mut events = Vec::new();
        let mut undelivered = BTreeSet::new();
        for node in ready {
            let Some(mut continuation) = self.state.nodes[&node.name].feedback_continuation.clone() else {
                continue;
            };
            if continuation.dispatched && continuation.delivery_id.is_some()
                && !delivery::feedback_input_delivered(self, &continuation)? {
                undelivered.insert(node.name.clone());
            }
            if continuation.instruction.is_some() {
                continue;
            }
            let (filename, bundled) = if continuation.sender {
                (
                    SENDER_TEMPLATE,
                    include_str!("../resources/prompts/feedback-returned.md"),
                )
            } else {
                (
                    AFFECTED_TEMPLATE,
                    include_str!("../resources/prompts/feedback-updated.md"),
                )
            };
            let path = self.root.join("prompts").join(filename);
            let template = match fs::read_to_string(&path) {
                Ok(text) => text,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => bundled.into(),
                Err(error) => {
                    return Err(format!(
                        "Cannot read feedback continuation template {}: {error}",
                        path.display()
                    ))
                }
            };
            if template.trim().is_empty() {
                return Err(format!("Feedback continuation message is not configured: fill {} (or backend/resources/prompts/{filename}); the node's history is retained", path.display()));
            }
            continuation.instruction = Some(
                template
                    .trim()
                    .replace("{{node}}", &node.name)
                    .replace("{{target}}", &continuation.target),
            );
            events.push(EventKind::FeedbackContinuationQueued {
                node: node.name.clone(),
                continuation,
            });
        }
        if !events.is_empty() {
            self.emit_outputs(events)?;
        }
        Ok(undelivered)
    }
}
