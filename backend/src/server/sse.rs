use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Mutex, OnceLock,
    },
    thread,
};

enum RuntimeSignal {
    SnapshotChanged {
        run_id: String,
        version: String,
    },
    PlanningOutputAvailable {
        run_id: String,
        planning_id: String,
    },
    OutputAvailable {
        run_id: String,
        execution_id: String,
        total_bytes: usize,
        settled: bool,
    },
}

const MAX_SSE_SUBSCRIBERS: usize = 8;
type SseSubscriber = (u64, std::sync::mpsc::SyncSender<Vec<u8>>);
static ACTIVE_SSE_CLIENTS: AtomicUsize = AtomicUsize::new(0);
static NEXT_SSE_SUBSCRIBER_ID: AtomicU64 = AtomicU64::new(1);
static SSE_SUBSCRIBERS: OnceLock<Mutex<Vec<SseSubscriber>>> = OnceLock::new();
static SSE_SIGNAL_TX: OnceLock<std::sync::mpsc::Sender<RuntimeSignal>> = OnceLock::new();

fn sse_subscribers() -> &'static Mutex<Vec<SseSubscriber>> {
    SSE_SUBSCRIBERS.get_or_init(|| Mutex::new(Vec::new()))
}

fn sse_signal_sender() -> &'static std::sync::mpsc::Sender<RuntimeSignal> {
    SSE_SIGNAL_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<RuntimeSignal>();
        let _ = thread::Builder::new()
            .name("grapher-sse-coalescer".into())
            .spawn(move || run_sse_coalescer(rx));
        tx
    })
}

fn run_sse_coalescer(rx: std::sync::mpsc::Receiver<RuntimeSignal>) {
    let debounce = std::time::Duration::from_millis(45);
    while let Ok(first) = rx.recv() {
        let deadline = std::time::Instant::now() + debounce;
        let mut snapshots: BTreeMap<String, String> = BTreeMap::new();
        let mut outputs: BTreeMap<(String, String), (usize, bool)> = BTreeMap::new();
        let mut planning_outputs = BTreeSet::new();
        let mut current = Some(first);
        loop {
            if let Some(signal) = current.take() {
                match signal {
                    RuntimeSignal::SnapshotChanged { run_id, version } => {
                        let entry = snapshots.entry(run_id).or_default();
                        if !version.is_empty() {
                            *entry = version;
                        }
                    }
                    RuntimeSignal::PlanningOutputAvailable {
                        run_id,
                        planning_id,
                    } => {
                        planning_outputs.insert((run_id, planning_id));
                    }
                    RuntimeSignal::OutputAvailable {
                        run_id,
                        execution_id,
                        total_bytes,
                        settled,
                    } => {
                        let entry = outputs
                            .entry((run_id, execution_id))
                            .or_insert((total_bytes, settled));
                        entry.0 = entry.0.max(total_bytes);
                        entry.1 |= settled;
                    }
                }
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                break;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(next) => current = Some(next),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        let mut payload = Vec::new();
        for (run_id, version) in snapshots {
            let data = serde_json::json!({ "runId": run_id, "version": version });
            payload
                .extend_from_slice(format!("event: snapshot_changed\ndata: {data}\n\n").as_bytes());
        }
        for ((run_id, execution_id), (total_bytes, settled)) in outputs {
            let data = serde_json::json!({
                "runId": run_id,
                "executionId": execution_id,
                "totalBytes": total_bytes,
                "settled": settled,
            });
            payload
                .extend_from_slice(format!("event: output_available\ndata: {data}\n\n").as_bytes());
        }
        for (run_id, planning_id) in planning_outputs {
            let data = serde_json::json!({ "runId": run_id, "planningId": planning_id });
            payload.extend_from_slice(
                format!("event: planning_output_available\ndata: {data}\n\n").as_bytes(),
            );
        }
        if !payload.is_empty() {
            broadcast_sse_bytes(&payload);
        }
    }
}

pub(super) fn notify_planning_output(run_id: &str, planning_id: &str) {
    if ACTIVE_SSE_CLIENTS.load(Ordering::Relaxed) == 0 {
        return;
    }
    let _ = sse_signal_sender().send(RuntimeSignal::PlanningOutputAvailable {
        run_id: run_id.into(),
        planning_id: planning_id.into(),
    });
}

fn broadcast_sse_bytes(bytes: &[u8]) {
    let Ok(mut subscribers) = sse_subscribers().lock() else {
        return;
    };
    subscribers.retain(|(_, tx)| match tx.try_send(bytes.to_vec()) {
        Ok(()) => true,
        // A full queue already missed this frame, which may be the only terminal
        // notification for a Run. Drop the subscriber so the browser reconnects
        // and re-reads durable state instead of silently staying stale.
        Err(std::sync::mpsc::TrySendError::Full(_))
        | Err(std::sync::mpsc::TrySendError::Disconnected(_)) => false,
    });
    ACTIVE_SSE_CLIENTS.store(subscribers.len(), Ordering::SeqCst);
}

pub(crate) fn notify_snapshot_changed(run_id: &str, version: &str) {
    if ACTIVE_SSE_CLIENTS.load(Ordering::Relaxed) == 0 {
        return;
    }
    let _ = sse_signal_sender().send(RuntimeSignal::SnapshotChanged {
        run_id: run_id.to_owned(),
        version: version.to_owned(),
    });
}

pub(crate) fn notify_output_available(
    run_id: &str,
    execution_id: &str,
    total_bytes: usize,
    settled: bool,
) {
    if ACTIVE_SSE_CLIENTS.load(Ordering::Relaxed) == 0 {
        return;
    }
    let _ = sse_signal_sender().send(RuntimeSignal::OutputAvailable {
        run_id: run_id.to_owned(),
        execution_id: execution_id.to_owned(),
        total_bytes,
        settled,
    });
}

pub(super) fn subscribe_runtime_events() -> SseStreamReceiver {
    let _ = sse_signal_sender();
    let id = NEXT_SSE_SUBSCRIBER_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(256);
    let _ = tx.try_send(b": connected\n\n".to_vec());
    if let Ok(mut subscribers) = sse_subscribers().lock() {
        while subscribers.len() >= MAX_SSE_SUBSCRIBERS {
            let (_, oldest_tx) = subscribers.remove(0);
            let _ = oldest_tx.try_send(Vec::new());
        }
        subscribers.push((id, tx));
        ACTIVE_SSE_CLIENTS.store(subscribers.len(), Ordering::SeqCst);
    }
    SseStreamReceiver {
        rx,
        current: Vec::new(),
        pos: 0,
        subscriber_id: Some(id),
    }
}

pub(super) fn close_all_sse_subscribers() {
    if let Ok(mut subscribers) = sse_subscribers().lock() {
        for (_, tx) in subscribers.drain(..) {
            let _ = tx.try_send(Vec::new());
        }
        ACTIVE_SSE_CLIENTS.store(0, Ordering::SeqCst);
    }
}

pub(super) struct SseStreamReceiver {
    pub(super) rx: std::sync::mpsc::Receiver<Vec<u8>>,
    pub(super) current: Vec<u8>,
    pub(super) pos: usize,
    pub(super) subscriber_id: Option<u64>,
}

impl Drop for SseStreamReceiver {
    fn drop(&mut self) {
        if let Some(id) = self.subscriber_id {
            if let Ok(mut subscribers) = sse_subscribers().lock() {
                subscribers.retain(|(sub_id, _)| *sub_id != id);
                ACTIVE_SSE_CLIENTS.store(subscribers.len(), Ordering::SeqCst);
            }
        }
    }
}

impl Read for SseStreamReceiver {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos < self.current.len() {
            let n = (self.current.len() - self.pos).min(buf.len());
            buf[..n].copy_from_slice(&self.current[self.pos..self.pos + n]);
            self.pos += n;
            return Ok(n);
        }
        let next = match self.rx.recv_timeout(std::time::Duration::from_secs(15)) {
            Ok(bytes) => {
                if bytes.is_empty() {
                    return Ok(0);
                }
                bytes
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => b": keep-alive\n\n".to_vec(),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
        };
        let n = next.len().min(buf.len());
        buf[..n].copy_from_slice(&next[..n]);
        if n < next.len() {
            self.current = next;
            self.pos = n;
        } else {
            self.current.clear();
            self.pos = 0;
        }
        Ok(n)
    }
}

/// tiny_http's `respond` copies an unknown-length body through an 8 KiB
/// chunk encoder and only flushes the socket after EOF. SSE may remain open
/// indefinitely, so write each HTTP chunk and flush it as soon as it arrives.
/// The caller has already validated the request Host and Origin.
pub(super) fn respond_sse(
    request: tiny_http::Request,
    mut stream: SseStreamReceiver,
    origin: Option<&str>,
    advertise_events: bool,
) -> std::io::Result<()> {
    let chunked = *request.http_version() >= tiny_http::HTTPVersion(1, 1);
    let close = !chunked
        || request.headers().iter().any(|header| {
            header.field.equiv("Connection")
                && header
                    .value
                    .as_str()
                    .split(',')
                    .any(|value| value.trim().eq_ignore_ascii_case("close"))
        });
    let mut writer = request.into_writer();
    let version = if chunked { "HTTP/1.1" } else { "HTTP/1.0" };
    let connection = if close { "close" } else { "keep-alive" };
    write!(
        writer,
        "{version} 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: {connection}\r\nX-Accel-Buffering: no\r\n"
    )?;
    if chunked {
        writer.write_all(b"Transfer-Encoding: chunked\r\n")?;
    }
    if advertise_events {
        writer.write_all(b"X-Grapher-Events: 1\r\n")?;
    }
    if let Some(origin) = origin {
        write!(writer, "Access-Control-Allow-Origin: {origin}\r\n")?;
        if advertise_events {
            writer.write_all(b"Access-Control-Expose-Headers: X-Grapher-Events\r\n")?;
        }
    }
    writer.write_all(b"\r\n")?;
    // A new planning request can take time before producing its first event;
    // expose its headers without waiting for any model output.
    writer.flush()?;

    let mut buffer = [0; 8192];
    loop {
        let n = stream.read(&mut buffer)?;
        if n == 0 {
            if chunked {
                writer.write_all(b"0\r\n\r\n")?;
            }
            return writer.flush();
        }
        if chunked {
            write!(writer, "{n:x}\r\n")?;
        }
        writer.write_all(&buffer[..n])?;
        if chunked {
            writer.write_all(b"\r\n")?;
        }
        writer.flush()?;
    }
}

pub(super) fn send_sse_event(
    tx: &std::sync::mpsc::Sender<Vec<u8>>,
    event: &str,
    data: &serde_json::Value,
) {
    let payload = format!("event: {event}\ndata: {}\n\n", data);
    let _ = tx.send(payload.into_bytes());
}
