//! One ready slot and one coalesced preparation per role. No model calls.
use crate::process_control;
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

pub(crate) trait Worker: Send + 'static {
    fn alive(&mut self) -> bool;
    fn retire(self);
    fn ready_ms(&self) -> u128 {
        0
    }
}

#[derive(Clone)]
pub(crate) struct Ticket {
    epoch: Arc<AtomicU64>,
    generation: u64,
}

impl Ticket {
    pub fn cancelled(&self) -> bool {
        self.epoch.load(Ordering::Acquire) != self.generation
    }
}

type Prepare<K, W> = Box<dyn FnOnce(Ticket) -> Result<(K, W), String> + Send>;

struct Pending<K, W> {
    key: K,
    generation: u64,
    prepare: Prepare<K, W>,
}

struct State<K, W> {
    ready: Option<(K, W)>,
    target: Option<K>,
    pending: Option<Pending<K, W>>,
    preparing: Option<(K, u64)>,
    retired: Vec<W>,
    running: bool,
    stopped: bool,
}

struct Shared<K, W> {
    label: &'static str,
    state: Mutex<State<K, W>>,
    epoch: Arc<AtomicU64>,
    idle: Condvar,
}

pub(crate) struct Pool<K, W> {
    shared: Arc<Shared<K, W>>,
}

impl<K: Clone + Eq + Send + 'static, W: Worker> Pool<K, W> {
    pub fn new(label: &'static str) -> Self {
        Self {
            shared: Arc::new(Shared {
                label,
                state: Mutex::new(State {
                    ready: None,
                    target: None,
                    pending: None,
                    preparing: None,
                    retired: Vec::new(),
                    running: false,
                    stopped: false,
                }),
                epoch: Arc::new(AtomicU64::new(0)),
                idle: Condvar::new(),
            }),
        }
    }

    /// Latest configuration wins. The factory and teardown never hold the slot lock.
    pub fn request(
        &self,
        key: K,
        prepare: impl FnOnce(Ticket) -> Result<(K, W), String> + Send + 'static,
    ) {
        self.schedule(key, prepare, false);
    }

    /// A completed older request must not undo a newer selection or invalidation.
    pub fn refill(
        &self,
        key: K,
        prepare: impl FnOnce(Ticket) -> Result<(K, W), String> + Send + 'static,
    ) {
        self.schedule(key, prepare, true);
    }

    fn schedule(
        &self,
        key: K,
        prepare: impl FnOnce(Ticket) -> Result<(K, W), String> + Send + 'static,
        refill: bool,
    ) {
        let Ok(mut state) = self.shared.state.lock() else {
            return;
        };
        if state.stopped || (refill && state.target.as_ref() != Some(&key)) {
            return;
        }
        state.target = Some(key.clone());
        let generation = self.shared.epoch.load(Ordering::Acquire);
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.key == key)
            || state
                .preparing
                .as_ref()
                .is_some_and(|(active, epoch)| active == &key && *epoch == generation)
            || state
                .ready
                .as_mut()
                .is_some_and(|(ready, worker)| ready == &key && worker.alive())
        {
            return;
        }
        if let Some((_, worker)) = state.ready.take() {
            state.retired.push(worker);
        }
        let generation = self.shared.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        state.pending = Some(Pending {
            key,
            generation,
            prepare: Box::new(prepare),
        });
        if state.running {
            return;
        }
        state.running = true;
        let shared = self.shared.clone();
        // Spawn while holding the short state lock so a failed spawn cannot
        // strand a newer request behind a permanently "running" preparation.
        if let Err(error) = thread::Builder::new()
            .name(format!("{}-prewarm", shared.label))
            .spawn(move || Self::prepare_loop(shared))
        {
            state.running = false;
            state.pending = None;
            let retired = std::mem::take(&mut state.retired);
            drop(state);
            for worker in retired {
                worker.retire();
            }
            self.shared.idle.notify_all();
            eprintln!(
                "[Grapher] {} prewarm unavailable: {error}",
                self.shared.label
            );
        }
    }

    fn prepare_loop(shared: Arc<Shared<K, W>>) {
        loop {
            let (pending, retired) = {
                let Ok(mut state) = shared.state.lock() else {
                    return;
                };
                let pending = state.pending.take();
                let retired = std::mem::take(&mut state.retired);
                state.preparing = pending
                    .as_ref()
                    .map(|pending| (pending.key.clone(), pending.generation));
                (pending, retired)
            };
            for worker in retired {
                worker.retire();
            }
            let Some(pending) = pending else {
                let Ok(mut state) = shared.state.lock() else {
                    return;
                };
                // A request can arrive while old workers are being retired.
                if state.pending.is_some() {
                    continue;
                }
                state.running = false;
                shared.idle.notify_all();
                return;
            };
            let ticket = Ticket {
                epoch: shared.epoch.clone(),
                generation: pending.generation,
            };
            let result = if ticket.cancelled() {
                Err("Superseded prewarm".into())
            } else {
                (pending.prepare)(ticket.clone())
            };
            let mut discard = None;
            if let Ok(mut state) = shared.state.lock() {
                match result {
                    Ok(ready) if !ticket.cancelled() && !state.stopped => {
                        let ready_ms = ready.1.ready_ms();
                        state.target = Some(ready.0.clone());
                        state.ready = Some(ready);
                        eprintln!("[Grapher] {} prewarm ready in {ready_ms}ms", shared.label);
                    }
                    Ok((_, worker)) => discard = Some(worker),
                    Err(error) if !ticket.cancelled() => {
                        eprintln!("[Grapher] {} prewarm unavailable: {error}", shared.label);
                    }
                    Err(_) => {}
                }
                state.preparing = None;
            } else if let Ok((_, worker)) = result {
                discard = Some(worker);
            }
            if let Some(worker) = discard {
                worker.retire();
            }
        }
    }

    /// An unfinished preparation is a miss, never a wait on initialization.
    pub fn take_if(&self, key: &K, accept: impl FnOnce(&W) -> bool) -> Option<W> {
        let mut state = self.shared.state.lock().ok()?;
        let (ready, worker) = state.ready.as_mut()?;
        if ready != key {
            return None;
        }
        if !worker.alive() {
            let (_, dead) = state.ready.take()?;
            drop(state);
            dead.retire();
            return None;
        }
        if !accept(worker) {
            return None;
        }
        state.ready.take().map(|(_, worker)| worker)
    }

    pub fn invalidate(&self) {
        self.clear(false);
    }

    pub fn shutdown(&self) {
        self.clear(true);
    }

    fn clear(&self, stopped: bool) {
        let retired = {
            let Ok(mut state) = self.shared.state.lock() else {
                return;
            };
            self.shared.epoch.fetch_add(1, Ordering::AcqRel);
            state.stopped |= stopped;
            state.target = None;
            state.pending = None;
            let mut retired = std::mem::take(&mut state.retired);
            if let Some((_, worker)) = state.ready.take() {
                retired.push(worker);
            }
            retired
        };
        for worker in retired {
            worker.retire();
        }
    }

    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let Ok(state) = self.shared.state.lock() else {
            return false;
        };
        self.shared
            .idle
            .wait_timeout_while(state, timeout, |state| state.running)
            .is_ok_and(|(state, _)| !state.running)
    }
}

/// Own an uncommitted process through every failure/cancellation path.
pub(super) struct ReadyProcess {
    child: Option<Child>,
    tree: process_control::ProcessTree,
    pub startup_output: Vec<String>,
    pub ready_ms: u128,
}

impl ReadyProcess {
    pub fn start(
        command: &mut Command,
        ticket: &Ticket,
        timeout: Duration,
    ) -> Result<Self, String> {
        Self::start_with(
            command,
            ticket,
            timeout,
            serde_json::json!({"type":"get_state"}),
        )
    }

    pub fn start_with(
        command: &mut Command,
        ticket: &Ticket,
        timeout: Duration,
        message: Value,
    ) -> Result<Self, String> {
        if ticket.cancelled() {
            return Err("Superseded prewarm".into());
        }
        let started = Instant::now();
        process_control::configure_command(command);
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let tree = process_control::track(&child).map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            error
        })?;
        let mut process = Self {
            child: Some(child),
            tree,
            startup_output: Vec::new(),
            ready_ms: 0,
        };
        match probe(process.child.as_mut().unwrap(), message, timeout, || {
            ticket.cancelled()
        }) {
            Ok(output) => process.startup_output = output,
            Err(error) => {
                return Err(process.failure(error));
            }
        }
        process.ready_ms = started.elapsed().as_millis();
        Ok(process)
    }

    fn failure(&mut self, error: String) -> String {
        self.tree.terminate();
        let child = self.child.as_mut().unwrap();
        let _ = child.wait();
        let mut diagnostics = String::new();
        if let Some(stderr) = child.stderr.take() {
            let _ = stderr.take(16 * 1024).read_to_string(&mut diagnostics);
        }
        format!("{error}: {}", diagnostics.trim())
    }

    pub fn assign_to_current_owner(&self) -> Result<(), String> {
        process_control::assign_to_current_owner(&self.tree)
    }

    pub fn exchange(&mut self, message: Value, timeout: Duration) -> Result<(), String> {
        match probe(self.child.as_mut().unwrap(), message, timeout, || false) {
            Ok(output) => {
                self.startup_output.extend(output);
                Ok(())
            }
            Err(error) => Err(self.failure(error)),
        }
    }

    pub fn commit(mut self) -> (Child, process_control::ProcessTree, Vec<String>, u128) {
        (
            self.child.take().unwrap(),
            self.tree.clone(),
            std::mem::take(&mut self.startup_output),
            self.ready_ms,
        )
    }
}

impl Worker for ReadyProcess {
    fn alive(&mut self) -> bool {
        self.child
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
    }
    fn retire(self) {
        drop(self);
    }
    fn ready_ms(&self) -> u128 {
        self.ready_ms
    }
}

impl Drop for ReadyProcess {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            self.tree.terminate();
            let _ = child.wait();
        }
    }
}

fn probe(
    child: &mut Child,
    mut message: Value,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<Vec<String>, String> {
    let id = uuid::Uuid::new_v4().to_string();
    message
        .as_object_mut()
        .ok_or("Invalid readiness command")?
        .insert("id".into(), id.clone().into());
    let kind = message["type"]
        .as_str()
        .ok_or("Missing readiness command type")?
        .to_owned();
    let probe_id = id.clone();
    let stdout = child.stdout.take().ok_or("Prewarm stdout unavailable")?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        // A one-byte buffer leaves all post-probe bytes in the original pipe.
        let mut reader = BufReader::with_capacity(1, stdout);
        let result = (|| -> Result<Vec<String>, String> {
            let mut output = Vec::new();
            let mut bytes = 0;
            loop {
                let mut line = String::new();
                if reader
                    .read_line(&mut line)
                    .map_err(|error| error.to_string())?
                    == 0
                {
                    return Err("Prewarm exited before RPC readiness".into());
                }
                if let Ok(event) = serde_json::from_str::<Value>(&line) {
                    if event["id"] == probe_id && event["type"] == "response" {
                        return if event["success"] == true {
                            Ok(output)
                        } else {
                            Err(format!("Prewarm rejected {kind}: {event}"))
                        };
                    }
                }
                bytes += line.len();
                if bytes > 1024 * 1024 {
                    return Err("Prewarm startup output exceeded 1 MiB".into());
                }
                output.push(line);
            }
        })();
        let _ = tx.send((reader.into_inner(), result));
    });
    let stdin = child.stdin.as_mut().ok_or("Prewarm stdin unavailable")?;
    writeln!(stdin, "{}", message)
        .and_then(|_| stdin.flush())
        .map_err(|error| error.to_string())?;
    let started = Instant::now();
    loop {
        if cancelled() {
            return Err("Superseded prewarm".into());
        }
        let remaining = timeout
            .checked_sub(started.elapsed())
            .ok_or("Prewarm RPC readiness timed out")?;
        match rx.recv_timeout(remaining.min(Duration::from_millis(25))) {
            Ok((stdout, result)) => {
                child.stdout = Some(stdout);
                return result;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => return Err(format!("Prewarm readiness failed: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct FakeWorker(usize, Arc<AtomicUsize>);
    impl Worker for FakeWorker {
        fn alive(&mut self) -> bool {
            true
        }
        fn retire(self) {
            self.1.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn preparing_is_nonblocking_and_duplicate_requests_are_coalesced() {
        let pool = Pool::new("test");
        let retired = Arc::new(AtomicUsize::new(0));
        let (entered, entering) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let counter = retired.clone();
        pool.request(1, move |_| {
            entered.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok((1, FakeWorker(1, counter)))
        });
        entering.recv_timeout(Duration::from_secs(5)).unwrap();
        pool.request(1, |_| panic!("duplicate preparation"));
        assert!(pool.take_if(&1, |_| true).is_none());
        release.send(()).unwrap();
        assert!(pool.wait_idle(Duration::from_secs(5)));
        let worker = pool.take_if(&1, |_| true).unwrap();
        assert_eq!(worker.0, 1);
        worker.retire();
        assert_eq!(retired.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn newer_configuration_supersedes_pending_and_preparing_workers() {
        let pool = Pool::new("test");
        let retired = Arc::new(AtomicUsize::new(0));
        let (entered, entering) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let counter = retired.clone();
        pool.request(1, move |_| {
            entered.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok((1, FakeWorker(1, counter)))
        });
        entering.recv_timeout(Duration::from_secs(5)).unwrap();
        pool.request(2, |_| panic!("obsolete queued configuration"));
        let counter = retired.clone();
        pool.request(3, move |_| Ok((3, FakeWorker(3, counter))));
        release.send(()).unwrap();
        assert!(pool.wait_idle(Duration::from_secs(5)));
        assert!(pool.take_if(&1, |_| true).is_none());
        assert!(pool.take_if(&2, |_| true).is_none());
        assert_eq!(retired.load(Ordering::SeqCst), 1);
        pool.take_if(&3, |_| true).unwrap().retire();
    }

    #[test]
    fn invalidation_and_shutdown_prevent_late_publication() {
        for shutdown in [false, true] {
            let pool = Pool::new("test");
            let retired = Arc::new(AtomicUsize::new(0));
            let (entered, entering) = mpsc::channel();
            let (release, released) = mpsc::channel();
            let counter = retired.clone();
            pool.request(1, move |ticket| {
                entered.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(5)).unwrap();
                assert!(ticket.cancelled());
                Ok((1, FakeWorker(1, counter)))
            });
            entering.recv_timeout(Duration::from_secs(5)).unwrap();
            if shutdown {
                pool.shutdown();
            } else {
                pool.invalidate();
            }
            release.send(()).unwrap();
            assert!(pool.wait_idle(Duration::from_secs(5)));
            assert!(pool.take_if(&1, |_| true).is_none());
            assert_eq!(retired.load(Ordering::SeqCst), 1);
            let counter = retired.clone();
            pool.request(2, move |_| Ok((2, FakeWorker(2, counter))));
            assert!(pool.wait_idle(Duration::from_secs(5)));
            assert_eq!(pool.take_if(&2, |_| true).is_some(), !shutdown);
        }
    }

    #[test]
    fn failed_preparation_is_retryable_and_claimed_workers_are_independent() {
        let pool = Pool::<usize, FakeWorker>::new("test");
        pool.request(1, |_| Err("test failure".into()));
        assert!(pool.wait_idle(Duration::from_secs(5)));
        assert!(pool.take_if(&1, |_| true).is_none());
        let retired = Arc::new(AtomicUsize::new(0));
        let counter = retired.clone();
        pool.request(1, move |_| Ok((1, FakeWorker(1, counter))));
        assert!(pool.wait_idle(Duration::from_secs(5)));
        assert!(pool.take_if(&1, |_| false).is_none());
        let claimed = pool.take_if(&1, |_| true).unwrap();
        let counter = retired.clone();
        pool.refill(1, move |_| Ok((1, FakeWorker(2, counter))));
        assert!(pool.wait_idle(Duration::from_secs(5)));
        pool.invalidate();
        assert_eq!(retired.load(Ordering::SeqCst), 1);
        assert_eq!(claimed.0, 1);
        claimed.retire();
    }

    #[test]
    fn older_completions_cannot_revert_newer_selections_or_auth_invalidation() {
        let pool = Pool::new("test");
        let retired = Arc::new(AtomicUsize::new(0));
        let counter = retired.clone();
        pool.request(1, move |_| Ok((1, FakeWorker(1, counter))));
        assert!(pool.wait_idle(Duration::from_secs(5)));
        let claimed = pool.take_if(&1, |_| true).unwrap();
        let counter = retired.clone();
        pool.request(2, move |_| Ok((2, FakeWorker(2, counter))));
        assert!(pool.wait_idle(Duration::from_secs(5)));
        pool.refill(1, |_| panic!("old completion reverted the selected model"));
        assert!(pool.wait_idle(Duration::from_secs(5)));
        pool.take_if(&2, |_| true).unwrap().retire();
        pool.invalidate();
        pool.refill(2, |_| panic!("old completion rearmed an invalidated pool"));
        assert!(pool.wait_idle(Duration::from_secs(5)));
        assert!(pool.take_if(&2, |_| true).is_none());
        claimed.retire();
    }

    #[test]
    fn rpc_readiness_preserves_startup_and_post_probe_output() {
        let epoch = Arc::new(AtomicU64::new(0));
        let ticket = Ticket {
            epoch,
            generation: 0,
        };
        let mut command = Command::new("node");
        command.args(["-e", r#"const r=require('node:readline').createInterface({input:process.stdin});console.log(JSON.stringify({type:'startup'}));r.on('line',line=>{const v=JSON.parse(line);console.log(JSON.stringify({type:'response',id:v.id,success:true}));console.log(JSON.stringify({type:'after_probe'}));});"#]);
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let process = ReadyProcess::start(&mut command, &ticket, Duration::from_secs(5)).unwrap();
        assert!(process.startup_output[0].contains("startup"));
        let (mut child, tree, _, _) = process.commit();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        assert!(line.contains("after_probe"));
        tree.terminate();
        child.wait().unwrap();
    }

    #[test]
    fn rejected_silent_and_cancelled_processes_never_become_ready() {
        for (script, timeout, cancelled) in [
            ("require('node:readline').createInterface({input:process.stdin}).on('line',line=>console.log(JSON.stringify({type:'response',id:JSON.parse(line).id,success:false,error:'rejected'})))", Duration::from_secs(5), false),
            ("setInterval(()=>{},1000)", Duration::from_millis(100), false),
            ("setInterval(()=>{},1000)", Duration::from_secs(5), true),
        ] {
            let epoch = Arc::new(AtomicU64::new(0));
            let ticket = Ticket { epoch: epoch.clone(), generation: 0 };
            let mut command = Command::new("node");
            command.args(["-e", script]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
            if cancelled {
                thread::spawn(move || { thread::sleep(Duration::from_millis(100)); epoch.fetch_add(1, Ordering::SeqCst); });
            }
            assert!(ReadyProcess::start(&mut command, &ticket, timeout).is_err());
        }
    }
}
