//! Backend-owned warm shells for source-native (Serial) conversations.
//!
//! A successful Serial turn parks its Pi process — and the shell/services it
//! started — instead of terminating it, so the conversation stays resident. The
//! next turn of the same conversation **claims** the warm process back and runs
//! on it. Graph node agents are unaffected: their boundary is reclaimed at turn
//! end exactly as before.
//!
//! A parked shell has no idle TTL: a Serial conversation that ran in this backend
//! stays warm for the whole backend process, and is retired only on explicit Run
//! or workspace deletion, or on backend shutdown.
//!
//! This pool owns only the bookkeeping. The concrete parked host (child, process
//! tree, RPC channels) and its termination live in the engine; the pool calls
//! [`Worker::retire`] on every exit path so a parked shell can never be forgotten
//! while it is still running.

use super::prewarm::Worker;
use std::{
    path::PathBuf,
    sync::Mutex,
};

/// Stable identity of a Serial Pi conversation. Execution ids change across
/// attempts (invalidate/retry), so they must never key a parked shell.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct SessionKey {
    pub repository: PathBuf,
    pub session_id: String,
}

struct Entry<W> {
    key: SessionKey,
    run_id: String,
    worker: W,
}

/// Parked shells keyed by conversation, held for the lifetime of the backend.
pub(crate) struct Lingering<W> {
    entries: Mutex<Vec<Entry<W>>>,
}

impl<W: Worker> Default for Lingering<W> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
        }
    }
}

impl<W: Worker> Lingering<W> {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Entry<W>>> {
        // A panic while retiring a worker must not make the pool permanently
        // unusable: parked shells would leak until backend shutdown.
        self.entries.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Park a settled shell, replacing any existing entry for the same session.
    pub(crate) fn park(&self, key: SessionKey, run_id: String, worker: W) {
        let mut retired = Vec::new();
        {
            let mut entries = self.lock();
            if let Some(index) = entries.iter().position(|entry| entry.key == key) {
                retired.push(entries.remove(index).worker);
            }
            entries.push(Entry { key, run_id, worker });
        }
        for worker in retired {
            worker.retire();
        }
    }

    /// Take the parked shell for this conversation. A dead entry is retired and
    /// reported as a miss, so the caller cold-launches instead of resuming a
    /// corpse. A live entry never expires.
    pub(crate) fn claim(&self, key: &SessionKey) -> Option<W> {
        let mut entry = {
            let mut entries = self.lock();
            let index = entries.iter().position(|entry| &entry.key == key)?;
            entries.remove(index)
        };
        if !entry.worker.alive() {
            entry.worker.retire();
            return None;
        }
        Some(entry.worker)
    }

    /// Retire the parked shell for a specific conversation, if any. Used to
    /// invalidate a stale shell (for example a source-native Planner shell once
    /// a Planner turn has advanced the same session from a node workspace).
    pub(crate) fn retire_key(&self, key: &SessionKey) {
        let retired = {
            let mut entries = self.lock();
            entries
                .iter()
                .position(|entry| &entry.key == key)
                .map(|index| entries.remove(index).worker)
        };
        if let Some(worker) = retired {
            worker.retire();
        }
    }

    /// Retire every parked shell matching a predicate (Run/workspace deletion).
    pub(crate) fn retire_where(&self, predicate: impl Fn(&str) -> bool) {
        let retired = {
            let mut entries = self.lock();
            let mut kept = Vec::with_capacity(entries.len());
            let mut retired = Vec::new();
            for entry in entries.drain(..) {
                if predicate(&entry.run_id) {
                    retired.push(entry.worker);
                } else {
                    kept.push(entry);
                }
            }
            *entries = kept;
            retired
        };
        for worker in retired {
            worker.retire();
        }
    }

    /// Retire every parked shell (backend shutdown).
    pub(crate) fn shutdown(&self) {
        let drained = {
            let mut entries = self.lock();
            entries.drain(..).map(|entry| entry.worker).collect::<Vec<_>>()
        };
        for worker in drained {
            worker.retire();
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };

    struct FakeWorker {
        alive: Arc<AtomicBool>,
        retired: Arc<AtomicUsize>,
    }

    impl Worker for FakeWorker {
        fn alive(&mut self) -> bool {
            self.alive.load(Ordering::SeqCst)
        }
        fn retire(self) {
            self.retired.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn key(session: &str) -> SessionKey {
        SessionKey {
            repository: PathBuf::from("C:/repo"),
            session_id: session.into(),
        }
    }

    fn worker() -> (FakeWorker, Arc<AtomicBool>, Arc<AtomicUsize>) {
        let alive = Arc::new(AtomicBool::new(true));
        let retired = Arc::new(AtomicUsize::new(0));
        (
            FakeWorker {
                alive: alive.clone(),
                retired: retired.clone(),
            },
            alive,
            retired,
        )
    }

    #[test]
    fn claim_returns_the_parked_worker_once() {
        let pool = Lingering::new();
        let (worker, _alive, _retired) = worker();
        pool.park(key("a"), "run-a".into(), worker);
        assert!(pool.claim(&key("a")).is_some());
        assert!(pool.claim(&key("a")).is_none());
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn a_live_worker_never_expires() {
        let pool = Lingering::new();
        let (worker, _alive, retired) = worker();
        pool.park(key("a"), "run-a".into(), worker);
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert_eq!(retired.load(Ordering::SeqCst), 0);
        assert!(pool.claim(&key("a")).is_some());
    }

    #[test]
    fn a_dead_worker_is_retired_and_reported_as_a_miss() {
        let pool = Lingering::new();
        let (worker, alive, retired) = worker();
        pool.park(key("a"), "run-a".into(), worker);
        alive.store(false, Ordering::SeqCst);
        assert!(pool.claim(&key("a")).is_none());
        assert_eq!(retired.load(Ordering::SeqCst), 1);
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn parking_the_same_session_replaces_and_retires_the_previous_shell() {
        let pool = Lingering::new();
        let (first, _a, r1) = worker();
        pool.park(key("a"), "run-a".into(), first);
        let (second, _b, _r2) = worker();
        pool.park(key("a"), "run-b".into(), second);
        assert_eq!(r1.load(Ordering::SeqCst), 1);
        assert_eq!(pool.len(), 1);
        assert!(pool.claim(&key("a")).is_some());
    }

    #[test]
    fn retire_key_only_touches_the_matching_session() {
        let pool = Lingering::new();
        let (first, _a, r1) = worker();
        pool.park(key("a"), "run-a".into(), first);
        let (second, _b, r2) = worker();
        pool.park(key("b"), "run-b".into(), second);
        pool.retire_key(&key("a"));
        assert_eq!(r1.load(Ordering::SeqCst), 1);
        assert_eq!(r2.load(Ordering::SeqCst), 0);
        assert_eq!(pool.len(), 1);
    }

    #[test]
    fn retire_where_only_touches_matching_runs() {
        let pool = Lingering::new();
        let (first, _a, r1) = worker();
        pool.park(key("a"), "run-a".into(), first);
        let (second, _b, r2) = worker();
        pool.park(key("b"), "run-b".into(), second);
        pool.retire_where(|run_id| run_id == "run-a");
        assert_eq!(r1.load(Ordering::SeqCst), 1);
        assert_eq!(r2.load(Ordering::SeqCst), 0);
        assert_eq!(pool.len(), 1);
    }

    #[test]
    fn shutdown_retires_everything() {
        let pool = Lingering::new();
        let (first, _a, r1) = worker();
        pool.park(key("a"), "run-a".into(), first);
        let (second, _b, r2) = worker();
        pool.park(key("b"), "run-b".into(), second);
        pool.shutdown();
        assert_eq!(r1.load(Ordering::SeqCst), 1);
        assert_eq!(r2.load(Ordering::SeqCst), 1);
        assert_eq!(pool.len(), 0);
    }
}
