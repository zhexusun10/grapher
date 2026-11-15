//! Commit logs and business events before changing projections or cache cursors.
use super::*;

struct PendingChange {
    event: Event,
    transcript: Option<String>,
    output_bytes: usize,
}

impl Store {
    pub(super) fn append_events(
        &self,
        state: &mut Snapshot,
        kinds: Vec<EventKind>,
    ) -> Result<(), String> {
        if kinds
            .iter()
            .all(|kind| matches!(kind, EventKind::Output { .. }))
        {
            return self.append_logs(state, kinds);
        }
        let count = kinds.len();
        let _guard = store_write_guard()?;
        self.ensure_not_deleted(&state.run_id)?;
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        // Output events are retained only until commit, never inserted into the
        // business log. The optional text restores imported inline transcripts.
        let mut changes: Vec<PendingChange> = Vec::with_capacity(count);
        let mut offsets = HashMap::new();
        for mut kind in kinds {
            let timestamp = now();
            if let EventKind::Output { execution_id, text } = &kind {
                let offset = match offsets
                    .get(execution_id)
                    .copied()
                    .or_else(|| self.execution_offsets.borrow().get(execution_id).copied())
                {
                    Some(offset) => offset,
                    None => self.log_bytes(&state.run_id, execution_id)?,
                };
                logs::append_chunks(&tx, &state.run_id, execution_id, offset, text)?;
                offsets.insert(execution_id.clone(), offset + text.len());
                let output_bytes = offset + text.len();
                changes.push(PendingChange {
                    event: Event {
                        sequence: 0,
                        timestamp,
                        kind,
                    },
                    transcript: None,
                    output_bytes,
                });
                continue;
            }
            let mut transcript = None;
            match &mut kind {
                EventKind::Finished {
                    execution_id,
                    output,
                    output_bytes,
                    metrics,
                    ..
                } if !output.is_empty() => {
                    let started = changes
                        .iter()
                        .rev()
                        .find_map(|change| match &change.event.kind {
                            EventKind::Started { execution, .. }
                            | EventKind::MergerStarted { execution }
                                if execution.id == *execution_id =>
                            {
                                Some(execution.started_at)
                            }
                            _ => None,
                        })
                        .or_else(|| {
                            state
                                .executions
                                .iter()
                                .chain(&state.mergers)
                                .find(|e| e.id == *execution_id)
                                .map(|e| e.started_at)
                        })
                        .unwrap_or(0);
                    *metrics = metrics.take().or_else(|| {
                        Some(crate::model::parse_execution_metrics(
                            output, started, timestamp,
                        ))
                    });
                    *output_bytes = output.len();
                    logs::replace_logs(&tx, &state.run_id, execution_id, output)?;
                    offsets.insert(execution_id.clone(), output.len());
                    transcript = Some(std::mem::take(output));
                }
                EventKind::Started { execution, .. } | EventKind::MergerStarted { execution }
                    if !execution.output.is_empty() =>
                {
                    logs::replace_logs(&tx, &state.run_id, &execution.id, &execution.output)?;
                    execution.output_bytes = execution.output.len();
                    offsets.insert(execution.id.clone(), execution.output.len());
                    transcript = Some(std::mem::take(&mut execution.output));
                }
                _ => {}
            }
            let payload = serde_json::to_string(&kind).map_err(|e| e.to_string())?;
            let (direct, nested) = created_planning_ids(&kind);
            tx.execute(
                "INSERT INTO events(run_id,timestamp,payload,planning_id,nested_planning_id,kind,execution_id) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![state.run_id, timestamp, payload, direct, nested, event_kind_name(&kind), event_execution_id(&kind)],
            ).map_err(|e| e.to_string())?;
            changes.push(PendingChange {
                event: Event {
                    sequence: tx.last_insert_rowid(),
                    timestamp,
                    kind,
                },
                output_bytes: transcript.as_ref().map_or(0, String::len),
                transcript,
            });
        }
        tx.commit().map_err(|e| e.to_string())?;
        // No projection or cache mutation precedes the durable commit.
        let output_changed = !offsets.is_empty();
        self.execution_offsets.borrow_mut().extend(offsets);
        let mut terminal = false;
        for PendingChange {
            event,
            transcript,
            output_bytes,
        } in changes
        {
            if let EventKind::Output { execution_id, text } = &event.kind {
                logs::apply_output(state, execution_id, text, output_bytes);
                self.execution_offsets
                    .borrow_mut()
                    .insert(execution_id.clone(), output_bytes);
                continue;
            }
            apply(state, &event);
            if let Some(text) = transcript {
                let id = event_execution_id(&event.kind).expect("transcript event identity");
                if matches!(event.kind, EventKind::Finished { .. }) {
                    let execution = state
                        .executions
                        .iter()
                        .chain(&state.mergers)
                        .find(|e| e.id == id);
                    let (node, worktree) = execution
                        .map(|e| (e.node.as_str(), e.worktree.as_str()))
                        .unwrap_or_default();
                    let repo = state
                        .config
                        .as_ref()
                        .map(|c| c.repository.as_str())
                        .unwrap_or_default();
                    crate::file_changes::update_from_log_text(
                        &state.run_id,
                        id,
                        node,
                        worktree,
                        repo,
                        &text,
                        false,
                        true,
                    );
                } else {
                    logs::apply_output(state, id, &text, text.len());
                }
            }
            if matches!(
                event.kind,
                EventKind::Finished { .. }
                    | EventKind::Failed { .. }
                    | EventKind::MergerFinished { .. }
                    | EventKind::MergerFailed { .. }
            ) {
                terminal = true;
                if let Some(id) = event_execution_id(&event.kind) {
                    crate::file_changes::settle(&state.run_id, id);
                    self.forget_log_cursor(id);
                }
            }
        }
        if output_changed {
            state.run_metrics = Some(state.compute_run_metrics());
        }
        if terminal {
            // This checkpoint includes the whole committed batch. Reset the
            // interval instead of writing it again at the periodic threshold.
            self.appended_since_checkpoint.set(0);
            self.save_checkpoint(state);
        } else {
            self.note_appended(state, count);
        }
        Ok(())
    }
}
