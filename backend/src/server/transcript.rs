//! Byte reads do not hold a Run's projection mutex while reading SQLite,
//! parsing derived counters, or serializing the page.
use super::*;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

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
    has_steers: bool,
}

pub(super) fn capture_execution_output(
    body: &serde_json::Value,
    service: &Arc<Service>,
) -> Result<ExecutionOutputRead, String> {
    let run_id: String = argument(body, "runId")?;
    let execution_id: String = argument(body, "executionId")?;
    match service.runtime.try_lock() {
        Ok(runtime) => {
            if runtime.state.run_id != run_id {
                return Err("Run does not match service".into());
            }
            execution_output_read_from_state(
                runtime.root.clone(),
                run_id,
                execution_id,
                &runtime.state,
            )
        }
        Err(std::sync::TryLockError::WouldBlock) => {
            // Transcript pages are immutable/read-only SQLite reads. A worker
            // may hold the projection mutex while preparing or committing an
            // event; replay the small metadata projection from the read
            // connection instead of making the browser wait for that worker.
            let root = service_data_root(service)?;
            let store = crate::store::Store::open_reader(&root.join("events.sqlite"))?;
            let state = store.load(&run_id)?;
            execution_output_read_from_state(root, run_id, execution_id, &state)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn execution_output_read_from_state(
    root: PathBuf,
    run_id: String,
    execution_id: String,
    state: &Snapshot,
) -> Result<ExecutionOutputRead, String> {
    if state.run_id != run_id {
        return Err("Run does not match service".into());
    }
    let execution = state
        .executions
        .iter()
        .chain(&state.mergers)
        .find(|execution| execution.id == execution_id)
        .ok_or("Execution not found in run")?;
    Ok(ExecutionOutputRead {
        root,
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
        has_steers: state.events.iter().any(|event| {
            matches!(&event.kind, EventKind::Steered { execution_id, .. } if execution_id == &execution.id)
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

const MAX_HYDRATE_RANGES: usize = 64;
const MAX_HYDRATE_RAW_BYTES: usize = 8 * 1024 * 1024;
const MAX_STEER_CACHE_ENTRIES: usize = 256;

struct SteerOffsetCacheEntry {
    scanned_end: usize,
    offsets: BTreeMap<String, usize>,
}

struct SteerOffsetCache {
    entries: HashMap<(PathBuf, String, String), SteerOffsetCacheEntry>,
    order: std::collections::VecDeque<(PathBuf, String, String)>,
}

impl SteerOffsetCache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            order: std::collections::VecDeque::new(),
        }
    }

    fn invalidate(&mut self, run_id: Option<&str>) {
        match run_id {
            Some(target) => {
                self.entries.retain(|(_, r, _), _| r != target);
                self.order.retain(|(_, r, _)| r != target);
            }
            None => {
                self.entries.clear();
                self.order.clear();
            }
        }
    }
}

fn steer_offset_cache() -> &'static Mutex<SteerOffsetCache> {
    static CACHE: OnceLock<Mutex<SteerOffsetCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(SteerOffsetCache::new()))
}

pub(crate) fn invalidate_steer_offset_cache(run_id: Option<&str>) {
    if let Ok(mut cache) = steer_offset_cache().lock() {
        cache.invalidate(run_id);
    }
}

fn cached_steer_offsets(
    store: &crate::store::Store,
    root: &Path,
    run_id: &str,
    execution_id: &str,
    end: usize,
) -> Result<BTreeMap<String, usize>, String> {
    let key = (
        root.to_path_buf(),
        run_id.to_string(),
        execution_id.to_string(),
    );
    let (cached_end, mut cached_offsets) = {
        let guard = steer_offset_cache().lock().map_err(|e| e.to_string())?;
        if let Some(entry) = guard.entries.get(&key) {
            if entry.scanned_end >= end {
                let filtered = entry
                    .offsets
                    .iter()
                    .filter(|(_, &offset)| offset < end)
                    .map(|(req, &offset)| (req.clone(), offset))
                    .collect();
                return Ok(filtered);
            }
            (entry.scanned_end, entry.offsets.clone())
        } else {
            (0, BTreeMap::new())
        }
    };

    let delta = store.execution_steer_offsets_from(run_id, execution_id, cached_end, end)?;
    for (req, offset) in delta {
        cached_offsets.entry(req).or_insert(offset);
    }

    if let Ok(mut guard) = steer_offset_cache().lock() {
        if let Some(entry) = guard.entries.get_mut(&key) {
            if end > entry.scanned_end {
                entry.scanned_end = end;
                for (req, &offset) in &cached_offsets {
                    entry.offsets.entry(req.clone()).or_insert(offset);
                }
            }
        } else {
            while guard.entries.len() >= MAX_STEER_CACHE_ENTRIES {
                if let Some(oldest) = guard.order.pop_front() {
                    guard.entries.remove(&oldest);
                } else {
                    break;
                }
            }
            guard.order.push_back(key.clone());
            guard.entries.insert(
                key,
                SteerOffsetCacheEntry {
                    scanned_end: end,
                    offsets: cached_offsets.clone(),
                },
            );
        }
    }

    Ok(cached_offsets
        .into_iter()
        .filter(|(_, offset)| *offset < end)
        .collect())
}

pub(super) fn parse_hydrate_ranges(
    body: &serde_json::Value,
    max_end: usize,
) -> Result<Option<Vec<(usize, usize)>>, String> {
    let Some(raw_ranges) = body.get("ranges") else {
        return Ok(None);
    };
    let Some(items) = raw_ranges.as_array() else {
        return Err("Invalid hydrate ranges".into());
    };
    if items.is_empty() {
        return Ok(None);
    }
    if items.len() > MAX_HYDRATE_RANGES {
        return Err("Too many hydrate ranges".into());
    }
    let mut spans = Vec::with_capacity(items.len());
    for item in items {
        let Some(pair) = item.as_array() else {
            return Err("Invalid hydrate range entry".into());
        };
        if pair.len() != 2 {
            return Err("Invalid hydrate range entry".into());
        }
        let start = pair[0]
            .as_u64()
            .ok_or("Invalid hydrate range start")? as usize;
        let end = pair[1]
            .as_u64()
            .ok_or("Invalid hydrate range end")? as usize;
        let clamped_end = end.min(max_end);
        if start >= clamped_end {
            continue;
        }
        spans.push((start, clamped_end));
    }
    if spans.is_empty() {
        return Ok(Some(Vec::new()));
    }
    spans.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(spans.len());
    let mut total_bytes = 0usize;
    for (start, end) in spans {
        if let Some(last) = merged.last_mut() {
            if start <= last.1 {
                let extra = end.saturating_sub(last.1);
                if total_bytes.saturating_add(extra) > MAX_HYDRATE_RAW_BYTES {
                    return Err("Hydrate range exceeds byte budget".into());
                }
                total_bytes += extra;
                last.1 = last.1.max(end);
                continue;
            }
        }
        let len = end - start;
        if total_bytes.saturating_add(len) > MAX_HYDRATE_RAW_BYTES {
            return Err("Hydrate range exceeds byte budget".into());
        }
        total_bytes += len;
        merged.push((start, end));
    }
    Ok(Some(merged))
}

pub(super) fn parse_requested_projection(
    body: &serde_json::Value,
    settled: bool,
) -> Option<crate::compact_transcript::TranscriptProjection> {
    if body.get("full").and_then(serde_json::Value::as_bool) == Some(true) {
        return None;
    }
    if body
        .get("summaryOnly")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Some(crate::compact_transcript::TranscriptProjection::Summary);
    }
    match body.get("projection").and_then(serde_json::Value::as_str) {
        Some("summary") => Some(crate::compact_transcript::TranscriptProjection::Summary),
        Some("cards") if settled => {
            Some(crate::compact_transcript::TranscriptProjection::CardShell)
        }
        _ => None,
    }
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
    let settled = read.status != "running";
    let projection = parse_requested_projection(body, settled);
    let summary_only =
        projection == Some(crate::compact_transcript::TranscriptProjection::Summary);
    let path = read.root.join("events.sqlite");
    let store = crate::store::Store::open_reader(&path)?;
    store.ensure_not_deleted(&read.run_id)?;
    let total = store.log_bytes(&read.run_id, &read.execution_id)?;
    let end = body
        .get("endOffset")
        .map(|_| argument::<usize>(body, "endOffset"))
        .transpose()?
        .unwrap_or(total)
        .min(total);

    if let Some(ranges) = parse_hydrate_ranges(body, end)? {
        let mut content = String::new();
        let mut min_start = end;
        let mut max_end = 0usize;
        for (range_start, range_end) in ranges {
            min_start = min_start.min(range_start);
            max_end = max_end.max(range_end);
            let raw_page = store.execution_log_page(
                &read.run_id,
                &read.execution_id,
                range_start,
                range_end - range_start,
            )?;
            content.push_str(&crate::compact_transcript::hydrate_raw_slice(
                &raw_page.content,
                raw_page.start_offset,
            ));
        }
        if min_start > max_end {
            min_start = 0;
        }
        return serde_json::to_value(crate::api_contract::ExecutionOutputPage {
            run_id: read.run_id,
            execution_id: read.execution_id,
            content,
            start_offset: min_start,
            next_offset: max_end,
            total_bytes: end,
            complete: true,
            status: read.status,
            steer_offsets: None,
            steer_offsets_authoritative: None,
            summary_only: None,
            projection: Some("hydrated".into()),
        })
        .map_err(|e| e.to_string());
    }

    let max_limit = if projection.is_some() {
        2 * 1024 * 1024
    } else {
        1024 * 1024
    };
    let limit = if settled
        && body.get("full").and_then(serde_json::Value::as_bool) == Some(true)
    {
        usize::MAX
    } else {
        body.get("limit")
            .map(|_| argument::<usize>(body, "limit"))
            .transpose()?
            .unwrap_or(256 * 1024)
            .clamp(4, max_limit)
    };
    let mut page = if let Some(proj) = projection {
        if tail {
            let target_end = before.unwrap_or(end).min(end);
            let compact_limit = limit.clamp(4, 2 * 1024 * 1024);
            let (content, start_offset) =
                crate::compact_transcript::compact_tail_pages_with_options(
                    target_end,
                    compact_limit,
                    proj,
                    settled,
                    |cursor, raw_limit| {
                        let raw_page = store.execution_log_tail_page(
                            &read.run_id,
                            &read.execution_id,
                            cursor,
                            raw_limit,
                        )?;
                        Ok((raw_page.start_offset, raw_page.content))
                    },
                )?;
            crate::store::LogPage {
                content,
                start_offset,
                next_offset: target_end,
                total_bytes: end,
                complete: target_end == end,
            }
        } else {
            if offset > end {
                return Err("Invalid prefix output offset".into());
            }
            let raw_limit = (4 * 1024 * 1024usize).min(end - offset);
            let raw_page =
                store.execution_log_page(&read.run_id, &read.execution_id, offset, raw_limit)?;
            let reached_eof = raw_page.next_offset == end;
            let (content, consumed) =
                crate::compact_transcript::compact_forward_chunk_with_options(
                    &raw_page.content,
                    raw_page.start_offset,
                    reached_eof,
                    proj,
                    settled,
                );
            let next_offset = raw_page.start_offset + consumed;
            crate::store::LogPage {
                content,
                start_offset: raw_page.start_offset,
                next_offset,
                total_bytes: end,
                complete: next_offset == end,
            }
        }
    } else if tail {
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
    let terminal_eof = projection.is_none() && end == total && settled && page.complete;
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
    if settled && (metrics.is_some() || context.is_some() || total > read.output_bytes) {
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
    let (steer_offsets, steer_offsets_authoritative) = if read.has_steers {
        let offsets =
            cached_steer_offsets(&store, &read.root, &read.run_id, &read.execution_id, end)?;
        let authoritative = !settled || !offsets.is_empty();
        (Some(offsets), Some(authoritative))
    } else {
        (None, None)
    };
    serde_json::to_value(crate::api_contract::ExecutionOutputPage {
        run_id: read.run_id,
        execution_id: read.execution_id,
        content: page.content,
        start_offset: page.start_offset,
        next_offset: page.next_offset,
        total_bytes: page.total_bytes,
        complete: page.complete,
        status: read.status,
        steer_offsets,
        steer_offsets_authoritative,
        summary_only: summary_only.then_some(true),
        projection: projection.map(|p| p.as_str().to_string()),
    })
    .map_err(|e| e.to_string())
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
