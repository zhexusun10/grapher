//! Byte reads do not hold a Run's projection mutex while reading SQLite,
//! parsing derived counters, or serializing the page.
use super::*;

pub(super) struct ExecutionOutputRead {
    root: PathBuf,
    run_id: String,
    execution_id: String,
    status: String,
    started_at: u64,
    completed_at: Option<u64>,
    output_bytes: usize,
    missing_metrics: bool,
    missing_context: bool,
}

pub(super) fn capture_execution_output(
    body: &serde_json::Value,
    service: &Arc<Service>,
) -> Result<ExecutionOutputRead, String> {
    let run_id: String = argument(body, "runId")?;
    let execution_id: String = argument(body, "executionId")?;
    let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
    if runtime.state.run_id != run_id {
        return Err("Run does not match service".into());
    }
    let execution = runtime
        .state
        .executions
        .iter()
        .chain(&runtime.state.mergers)
        .find(|execution| execution.id == execution_id)
        .ok_or("Execution not found in run")?;
    Ok(ExecutionOutputRead {
        root: runtime.root.clone(),
        run_id,
        execution_id,
        status: execution.status.clone(),
        started_at: execution.started_at,
        completed_at: execution.completed_at,
        output_bytes: execution.output_bytes,
        missing_metrics: execution.metrics.is_none(),
        missing_context: execution.metrics.as_ref().is_some_and(|metrics| {
            metrics.context_usage.is_none() && metrics.assistant_messages > 0
        }),
    })
}

pub(super) fn get_execution_output(
    body: &serde_json::Value,
    service: &Arc<Service>,
) -> Result<serde_json::Value, String> {
    let read = capture_execution_output(body, service)?;
    read_execution_output(body, service, read)
}

pub(super) fn read_execution_output(
    body: &serde_json::Value,
    service: &Arc<Service>,
    read: ExecutionOutputRead,
) -> Result<serde_json::Value, String> {
    let offset: usize = body
        .get("offset")
        .map(|_| argument(body, "offset"))
        .transpose()?
        .unwrap_or(0);
    let tail = body
        .get("tail")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let before: Option<usize> = body
        .get("before")
        .map(|_| argument(body, "before"))
        .transpose()?;
    let path = read.root.join("events.sqlite");
    let store = crate::store::Store::open_reader(&path)?;
    store.ensure_not_deleted(&read.run_id)?;
    let total = store.log_bytes(&read.run_id, &read.execution_id)?;
    let limit = if read.status != "running"
        && body.get("full").and_then(serde_json::Value::as_bool) == Some(true)
    {
        usize::MAX
    } else {
        body.get("limit")
            .map(|_| argument::<usize>(body, "limit"))
            .transpose()?
            .unwrap_or(256 * 1024)
            .clamp(4, 1024 * 1024)
    };
    let end = body
        .get("endOffset")
        .map(|_| argument::<usize>(body, "endOffset"))
        .transpose()?
        .unwrap_or(total)
        .min(total);
    let mut page = if tail {
        store.execution_log_tail_page(
            &read.run_id,
            &read.execution_id,
            before.unwrap_or(end).min(end),
            limit,
        )?
    } else {
        if offset > end {
            return Err("Invalid prefix output offset".into());
        }
        store.execution_log_page(
            &read.run_id,
            &read.execution_id,
            offset,
            limit.min(end - offset),
        )?
    };
    page.total_bytes = end;
    page.complete = page.next_offset == end;
    let terminal_eof = end == total && read.status != "running" && page.complete;
    let metrics = (terminal_eof && page.start_offset == 0 && read.missing_metrics).then(|| {
        parse_execution_metrics(
            &page.content,
            read.started_at,
            read.completed_at.unwrap_or_else(now),
        )
    });
    let context = if terminal_eof && read.missing_context {
        crate::model::parse_context_from_tail(&page.content).or_else(|| {
            store
                .execution_log_tail_page(&read.run_id, &read.execution_id, total, 1024 * 1024)
                .ok()
                .and_then(|wide| crate::model::parse_context_from_tail(&wide.content))
        })
    } else {
        None
    };
    // File changes have their own fenced, scoped API. Reading a transcript
    // must not also parse tools or refresh a file-change cache as a side effect.
    if read.status != "running"
        && (metrics.is_some() || context.is_some() || total > read.output_bytes)
    {
        publish_read_metadata(
            service,
            ReadMetadata {
                run_id: read.run_id.clone(),
                execution_id: read.execution_id.clone(),
                started_at: read.started_at,
                completed_at: read.completed_at,
                total,
                metrics,
                context,
            },
        );
    }
    Ok(
        serde_json::json!({ "runId": read.run_id, "executionId": read.execution_id,
        "content": page.content, "startOffset": page.start_offset, "nextOffset": page.next_offset,
        "totalBytes": page.total_bytes, "complete": page.complete, "status": read.status }),
    )
}

struct ReadMetadata {
    run_id: String,
    execution_id: String,
    started_at: u64,
    completed_at: Option<u64>,
    total: usize,
    metrics: Option<ExecutionMetrics>,
    context: Option<SessionContext>,
}

fn apply_read_metadata(runtime: &mut Runtime, update: ReadMetadata) {
    if runtime.state.run_id != update.run_id {
        return;
    }
    let Some(execution) = runtime
        .state
        .executions
        .iter_mut()
        .chain(&mut runtime.state.mergers)
        .find(|execution| {
            execution.id == update.execution_id
                && execution.status != "running"
                && execution.started_at == update.started_at
                && execution.completed_at == update.completed_at
        })
    else {
        return;
    };
    let mut changed = false;
    if update.total > execution.output_bytes {
        execution.output_bytes = update.total;
        changed = true;
    }
    if execution.metrics.is_none() && update.metrics.is_some() {
        execution.metrics = update.metrics;
        changed = true;
    }
    if let (Some(metrics), Some(mut context)) = (execution.metrics.as_mut(), update.context) {
        if metrics.context_usage.is_none() && metrics.assistant_messages > 0 {
            metrics.context_tokens = context.tokens;
            metrics.context_peak = metrics.context_peak.max(context.peak);
            context.peak = metrics.context_peak;
            metrics.context_usage = Some(context);
            changed = true;
        }
    }
    if changed {
        runtime.state.run_metrics = Some(runtime.state.compute_run_metrics());
        runtime.touch();
    }
}

fn publish_read_metadata(service: &Arc<Service>, update: ReadMetadata) {
    if let Ok(mut runtime) = service.runtime.try_lock() {
        apply_read_metadata(&mut runtime, update);
        return;
    }
    // Derived legacy counters must not put the HTTP reader back behind a long
    // Run operation. One bounded worker carries counters only, never log text.
    // A saturated queue is best-effort; another read can recover those counters.
    type Pending = (Weak<Service>, ReadMetadata);
    static UPDATES: OnceLock<Option<std::sync::mpsc::SyncSender<Pending>>> = OnceLock::new();
    if let Some(sender) = UPDATES.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Pending>(64);
        thread::Builder::new()
            .name("transcript-metadata".into())
            .spawn(move || {
                while let Ok((service, update)) = receiver.recv() {
                    if let Some(service) = service.upgrade() {
                        if let Ok(mut runtime) = service.runtime.lock() {
                            apply_read_metadata(&mut runtime, update);
                        }
                    }
                }
            })
            .ok()
            .map(|_| sender)
    }) {
        let _ = sender.try_send((Arc::downgrade(service), update));
    }
}
