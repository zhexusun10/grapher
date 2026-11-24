//! Browser terminals use the same PTY core as desktop IPC. Cursor-based reads
//! replay startup/final output and survive a dropped HTTP response without
//! opening one long-lived HTTP connection per terminal.
use crate::terminal::{TerminalEventSink, TerminalExitEvent, TerminalManager, TerminalOutputEvent};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_SESSIONS: usize = 16;
const MAX_BUFFER_BYTES: usize = 1024 * 1024;
const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const EXITED_RETENTION: Duration = Duration::from_secs(15);
static TERMINALS: OnceLock<WebTerminals> = OnceLock::new();

#[derive(Default)]
struct Output {
    chunks: VecDeque<(u64, String)>,
    bytes: usize,
    cursor: u64,
    exit: Option<Option<i32>>,
    exited_at: Option<Instant>,
}

#[derive(Default)]
struct BufferedSink(Mutex<Output>);

impl TerminalEventSink for BufferedSink {
    fn emit_output(&self, event: TerminalOutputEvent) {
        if let Ok(mut output) = self.0.lock() {
            output.cursor += 1;
            let cursor = output.cursor;
            output.bytes += event.data.len();
            output.chunks.push_back((cursor, event.data));
            while output.bytes > MAX_BUFFER_BYTES {
                if let Some((_, data)) = output.chunks.pop_front() {
                    output.bytes -= data.len();
                } else {
                    break;
                }
            }
        }
    }

    fn emit_exit(&self, event: TerminalExitEvent) {
        if let Ok(mut output) = self.0.lock() {
            output.exit = Some(event.exit_code);
            output.exited_at = Some(Instant::now());
        }
    }
}

struct Session {
    sink: Arc<BufferedSink>,
    touched: Instant,
}

#[derive(Default)]
struct SessionTable {
    entries: HashMap<String, Session>,
    pending_creates: usize,
}

#[derive(Default)]
struct WebTerminals {
    pty: TerminalManager,
    sessions: Mutex<SessionTable>,
}

struct CreateReservation<'a> {
    sessions: &'a Mutex<SessionTable>,
    active: bool,
}

impl Drop for CreateReservation<'_> {
    fn drop(&mut self) {
        if self.active {
            if let Ok(mut table) = self.sessions.lock() {
                table.pending_creates = table.pending_creates.saturating_sub(1);
            }
        }
    }
}

impl WebTerminals {
    fn create(&self, body: &Value) -> Result<Value, String> {
        let workspace: String = super::argument(body, "workspacePath")?;
        let cols: Option<u16> =
            serde_json::from_value(body["cols"].clone()).map_err(|e| e.to_string())?;
        let rows: Option<u16> =
            serde_json::from_value(body["rows"].clone()).map_err(|e| e.to_string())?;
        self.reap();
        // Reserve a slot under the lock, then release it before spawning the
        // PTY/shell so other terminals' reads, writes and resizes never stall
        // behind process startup.
        {
            let mut table = self.sessions.lock().map_err(|e| e.to_string())?;
            if table.entries.len() + table.pending_creates >= MAX_SESSIONS {
                return Err("Too many open terminals; close an existing terminal first".into());
            }
            table.pending_creates += 1;
        }
        let mut reservation = CreateReservation {
            sessions: &self.sessions,
            active: true,
        };
        let sink = Arc::new(BufferedSink::default());
        let info = self
            .pty
            .create_session(Arc::clone(&sink), &workspace, cols, rows)?;
        // The sink exists before spawning, so even an immediate shell exit is
        // retained before the create response reaches the browser.
        {
            let mut table = self.sessions.lock().map_err(|e| {
                self.pty.kill_session(&info.session_id);
                e.to_string()
            })?;
            table.pending_creates = table.pending_creates.saturating_sub(1);
            reservation.active = false;
            table.entries.insert(
                info.session_id.clone(),
                Session {
                    sink,
                    touched: Instant::now(),
                },
            );
        }
        serde_json::to_value(info).map_err(|e| e.to_string())
    }

    fn sink(&self, id: &str) -> Result<Arc<BufferedSink>, String> {
        let mut table = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = table
            .entries
            .get_mut(id)
            .ok_or("Terminal session not found")?;
        session.touched = Instant::now();
        Ok(Arc::clone(&session.sink))
    }

    fn read(&self, body: &Value) -> Result<Value, String> {
        let id: String = super::argument(body, "sessionId")?;
        let cursor = body
            .get("cursor")
            .map(|value| value.as_u64().ok_or("Invalid terminal cursor"))
            .transpose()?
            .unwrap_or(0);
        let sink = self.sink(&id)?;
        let output = sink.0.lock().map_err(|e| e.to_string())?;
        if cursor > output.cursor {
            return Err("Terminal cursor is beyond the available output".into());
        }
        let first = output
            .chunks
            .front()
            .map(|(seq, _)| *seq)
            .unwrap_or(output.cursor + 1);
        let mut next = cursor.max(first - 1);
        let chunks: Vec<&str> = output
            .chunks
            .iter()
            .filter(|(seq, _)| *seq > cursor)
            .take(32)
            .map(|(seq, data)| {
                next = *seq;
                data.as_str()
            })
            .collect();
        Ok(json!({
            "chunks": chunks,
            "cursor": next,
            "truncated": cursor < first - 1,
            "exited": output.exit.is_some() && next == output.cursor,
            "exitCode": output.exit.flatten(),
            "more": next < output.cursor,
        }))
    }

    fn kill(&self, id: &str) {
        if let Ok(mut table) = self.sessions.lock() {
            table.entries.remove(id);
        }
        self.pty.kill_session(id);
    }

    fn reap(&self) {
        let expired: Vec<String> = self
            .sessions
            .lock()
            .map(|mut table| {
                let expired: Vec<_> = table
                    .entries
                    .iter()
                    .filter(|(_, session)| {
                        session.touched.elapsed() > IDLE_TIMEOUT
                            || session
                                .sink
                                .0
                                .lock()
                                .ok()
                                .and_then(|out| out.exited_at)
                                .is_some_and(|at| at.elapsed() > EXITED_RETENTION)
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in &expired {
                    table.entries.remove(id);
                }
                expired
            })
            .unwrap_or_default();
        for id in expired {
            self.pty.kill_session(&id);
        }
    }
}

fn manager() -> &'static WebTerminals {
    TERMINALS.get_or_init(|| {
        let _ = std::thread::Builder::new()
            .name("grapher-terminal-reaper".into())
            .spawn(|| loop {
                std::thread::sleep(Duration::from_secs(30));
                if let Some(manager) = TERMINALS.get() {
                    manager.reap();
                }
            });
        WebTerminals::default()
    })
}

pub(super) fn dispatch(command: &str, body: &Value) -> Result<Value, String> {
    let manager = manager();
    match command {
        "terminal_create" => manager.create(body),
        "terminal_read" => manager.read(body),
        "terminal_kill" => {
            manager.kill(&super::argument::<String>(body, "sessionId")?);
            Ok(Value::Null)
        }
        "terminal_write" | "terminal_resize" => {
            let id: String = super::argument(body, "sessionId")?;
            manager.sink(&id)?;
            if command == "terminal_write" {
                manager
                    .pty
                    .write_session(&id, &super::argument::<String>(body, "data")?)?;
            } else {
                manager.pty.resize_session(
                    &id,
                    super::argument(body, "cols")?,
                    super::argument(body, "rows")?,
                )?;
            }
            Ok(Value::Null)
        }
        _ => Err("Unknown command".into()),
    }
}

pub(super) fn shutdown() {
    if let Some(manager) = TERMINALS.get() {
        manager.pty.kill_all();
        if let Ok(mut table) = manager.sessions.lock() {
            table.entries.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_output_replays_and_exit_waits_until_all_pages_are_read() {
        let manager = WebTerminals::default();
        let sink = Arc::new(BufferedSink::default());
        for i in 0..40 {
            sink.emit_output(TerminalOutputEvent {
                session_id: "test".into(),
                data: format!("chunk{i}"),
            });
        }
        sink.emit_exit(TerminalExitEvent {
            session_id: "test".into(),
            exit_code: Some(7),
        });
        manager.sessions.lock().unwrap().entries.insert(
            "test".into(),
            Session {
                sink,
                touched: Instant::now(),
            },
        );
        let first = manager
            .read(&json!({"sessionId":"test","cursor":0}))
            .unwrap();
        assert_eq!(first["chunks"].as_array().unwrap().len(), 32);
        assert_eq!(first["exited"], false);
        assert_eq!(
            first,
            manager
                .read(&json!({"sessionId":"test","cursor":0}))
                .unwrap()
        );
        let last = manager
            .read(&json!({"sessionId":"test","cursor":first["cursor"]}))
            .unwrap();
        assert_eq!(last["chunks"].as_array().unwrap().len(), 8);
        assert_eq!(last["exited"], true);
        assert_eq!(last["exitCode"], 7);
        manager.kill("test");
        assert!(manager.read(&json!({"sessionId":"test"})).is_err());
    }

    #[test]
    fn terminal_output_is_bounded_and_reports_gaps_and_expired_sessions() {
        let manager = WebTerminals::default();
        let sink = Arc::new(BufferedSink::default());
        for _ in 0..300 {
            sink.emit_output(TerminalOutputEvent {
                session_id: "test".into(),
                data: "x".repeat(5464),
            });
        }
        assert!(sink.0.lock().unwrap().bytes <= MAX_BUFFER_BYTES);
        manager.sessions.lock().unwrap().entries.insert(
            "test".into(),
            Session {
                sink,
                touched: Instant::now(),
            },
        );
        assert_eq!(
            manager.read(&json!({"sessionId":"test"})).unwrap()["truncated"],
            true
        );
        manager
            .sessions
            .lock()
            .unwrap()
            .entries
            .get_mut("test")
            .unwrap()
            .touched = Instant::now() - IDLE_TIMEOUT - Duration::from_secs(1);
        manager.reap();
        assert!(manager.read(&json!({"sessionId":"test"})).is_err());
    }

    #[test]
    fn failed_terminal_create_releases_its_pending_capacity_slot() {
        let manager = WebTerminals::default();
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("does-not-exist");
        for _ in 0..MAX_SESSIONS + 2 {
            let err = manager
                .create(&json!({ "workspacePath": missing.to_string_lossy() }))
                .unwrap_err();
            assert!(!err.contains("Too many open terminals"), "{err}");
        }
        assert_eq!(manager.sessions.lock().unwrap().pending_creates, 0);
        // An in-flight reservation counts toward MAX_SESSIONS until released.
        manager.sessions.lock().unwrap().pending_creates = MAX_SESSIONS;
        let err = manager
            .create(&json!({ "workspacePath": temp.path().to_string_lossy() }))
            .unwrap_err();
        assert!(err.contains("Too many open terminals"), "{err}");
        manager.sessions.lock().unwrap().pending_creates = 0;
    }
}
