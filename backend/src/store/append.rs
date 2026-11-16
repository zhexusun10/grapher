//! Commit logs and business events before changing projections or cache cursors.
use super::*;

struct PendingChange {
    event: Event,
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
        // Inline imports could replace already committed logs. All output must
        // pass through the append-only output channel, including mixed batches.
        for kind in &kinds {
            kind.validate_current_format()?;
            match kind {
                EventKind::Finished { output, .. } if !output.is_empty() => {
                    return Err(
                        "Inline execution transcripts are unsupported; append output first".into(),
                    );
                }
                EventKind::Started { execution, .. } | EventKind::MergerStarted { execution }
                    if !execution.output.is_empty() =>
                {
                    return Err("Executions must start without inline output".into());
                }
                _ => {}
            }
        }
        let count = kinds.len();
        let _guard = store_write_guard()?;
        self.ensure_not_deleted(&state.run_id)?;
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let mut changes = Vec::with_capacity(count);
        let mut offsets = HashMap::new();
        for kind in kinds {
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
                changes.push(PendingChange {
                    output_bytes: offset + text.len(),
                    event: Event {
                        sequence: 0,
                        timestamp,
                        kind,
                    },
                });
                continue;
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
                output_bytes: 0,
            });
        }
        tx.commit().map_err(|e| e.to_string())?;
        // No projection or cache mutation precedes the durable commit.
        let output_changed = !offsets.is_empty();
        self.execution_offsets.borrow_mut().extend(offsets);
        let mut terminal = false;
        for PendingChange {
            event,
            output_bytes,
        } in changes
        {
            if let EventKind::Output { execution_id, text } = &event.kind {
                logs::apply_output(state, execution_id, text, output_bytes);
                continue;
            }
            apply(state, &event);
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
            self.appended_since_checkpoint.set(0);
            self.save_checkpoint(state);
        } else {
            self.note_appended(state, count);
        }
        Ok(())
    }
}
