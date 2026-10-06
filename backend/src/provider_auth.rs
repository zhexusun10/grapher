//! Local-only Provider/Auth transport. The child owns upstream ModelRuntime;
//! Grapher never reads auth.json or implements credential refresh/storage.
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, mpsc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
#[cfg(not(feature = "fixture"))]
use crate::engine::prewarm::{Pool, Ticket, Worker};

static TRANSPORT: OnceLock<Transport> = OnceLock::new();

struct Bridge {
    child: Child,
    process_tree: crate::process_control::ProcessTree,
    input: ChildStdin,
    output: mpsc::Receiver<String>,
    #[cfg(not(feature = "fixture"))]
    ready_ms: u128,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.process_tree.terminate();
        let _ = self.child.wait();
    }
}

impl Bridge {
    fn start() -> Result<Self, String> {
        let root = crate::native::installation_root();
        let mut command = Command::new("node");
        command
            // Use the same audited Pi source loader as the execution and
            // extension hosts; no tsx install/download on the startup path.
            .arg("--import")
            .arg("./pi/packages/coding-agent/src/experimental/source-resolver.ts")
            .arg(crate::native::host_path(&root.join("engine/provider-host.ts")))
            .current_dir(&root)
            .env("PI_CODING_AGENT_DIR", crate::native::agent_dir()?)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        Self::spawn(&mut command)
    }

    fn spawn(command: &mut Command) -> Result<Self, String> {
        crate::process_control::configure_command(command);
        let mut child = command
            .spawn()
            .map_err(|_| "Cannot start Provider/Auth Adapter. Run npm run pi:setup.")?;
        // Shared credential/login transport is backend-owned, even on a cold
        // miss initiated inside a Run. Cancelling that Run must not kill it.
        let process_tree = crate::process_control::with_owner("", || crate::process_control::track(&child)).map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            error
        })?;
        let input = child.stdin.take().ok_or("Adapter input unavailable")?;
        let stdout = child.stdout.take().ok_or("Adapter output unavailable")?;
        let stderr = child.stderr.take();
        if let Some(stderr) = stderr {
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    let Ok(line) = line else { break };
                    eprintln!("[provider_auth] {line}");
                }
            });
        }
        let (tx, output) = mpsc::sync_channel(1);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.len() > 4 * 1024 * 1024 || tx.send(line).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            process_tree,
            input,
            output,
            #[cfg(not(feature = "fixture"))]
            ready_ms: 0,
        })
    }

    fn call(&mut self, body: &Value, timeout: Duration, cancelled: impl Fn() -> bool) -> Result<Value, String> {
        if cancelled() { return Err("Provider/Auth Adapter stopped".into()); }
        let mut encoded = serde_json::to_vec(body).map_err(|_| "Invalid adapter request")?;
        if encoded.len() > 128 * 1024 {
            return Err("Adapter request too large".into());
        }
        encoded.push(b'\n');
        self.input
            .write_all(&encoded)
            .map_err(|_| "Adapter disconnected")?;
        self.input.flush().map_err(|_| "Adapter disconnected")?;
        let deadline = Instant::now() + timeout;
        let line = loop {
            if cancelled() { return Err("Provider/Auth Adapter stopped".into()); }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() { return Err("Adapter timed out or stopped. Restart login.".into()); }
            match self.output.recv_timeout(remaining.min(Duration::from_millis(50))) {
                Ok(line) => break line,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err("Adapter disconnected".into()),
            }
        };
        let value: Value = serde_json::from_str(&line).map_err(|_| "Invalid adapter response")?;
        if value["version"] != 1 {
            return Err("Incompatible Provider/Auth Adapter".into());
        }
        Ok(value)
    }
}

#[cfg(not(feature = "fixture"))]
impl Bridge {
    fn prepare(ticket: Ticket) -> Result<Self, String> {
        if ticket.cancelled() { return Err("Superseded Provider/Auth preparation".into()); }
        let started = Instant::now();
        let mut bridge = Self::start()?;
        let id = uuid::Uuid::new_v4().to_string();
        let response = bridge.call(&serde_json::json!({
            "version": 1, "operation": "grapher_prepare", "id": id,
        }), Duration::from_secs(30), || ticket.cancelled())?;
        if response["id"] != id || response["result"]["ready"] != true {
            return Err("Invalid Provider/Auth readiness response".into());
        }
        bridge.ready_ms = started.elapsed().as_millis();
        Ok(bridge)
    }
}

#[cfg(not(feature = "fixture"))]
impl Worker for Bridge {
    fn alive(&mut self) -> bool { matches!(self.child.try_wait(), Ok(None)) }
    fn ready_ms(&self) -> u128 { self.ready_ms }
    fn retire(self) { drop(self); }
}

struct Transport {
    active: Mutex<Option<Bridge>>,
    stopped: AtomicBool,
    #[cfg(not(feature = "fixture"))]
    prepared: Pool<(), Bridge>,
}

impl Transport {
    fn new() -> Self {
        Self {
            active: Mutex::new(None),
            stopped: AtomicBool::new(false),
            #[cfg(not(feature = "fixture"))]
            prepared: Pool::new("Provider/Auth"),
        }
    }

    #[cfg(not(feature = "fixture"))]
    fn warm_with(&self, prepare: impl FnOnce(Ticket) -> Result<Bridge, String> + Send + 'static) {
        if self.stopped.load(Ordering::SeqCst) { return; }
        // A busy/claimed host already owns login jobs. Never wait for it or
        // start a spare host. Initialization happens outside both pool/IPC locks.
        let Ok(active) = self.active.try_lock() else { return; };
        if active.is_none() {
            self.prepared.request((), move |ticket| prepare(ticket).map(|bridge| ((), bridge)));
        }
    }

    fn request(&self, body: Value) -> Result<Value, String> {
        self.request_with(body, Bridge::start)
    }

    fn request_with(&self, body: Value, start: impl FnOnce() -> Result<Bridge, String>) -> Result<Value, String> {
        if body["version"] != 1 || !matches!(body["operation"].as_str(),
            Some("catalog" | "login" | "poll" | "respond" | "cancel" | "logout")) {
            return Err("Invalid Provider/Auth Adapter operation".into());
        }
        let mut active = self.active.lock().map_err(|_| "Adapter lock unavailable")?;
        if self.stopped.load(Ordering::SeqCst) { return Err("Provider/Auth Adapter stopped".into()); }
        if active.is_none() {
            #[cfg(not(feature = "fixture"))]
            let ready = self.prepared.take_if(&(), |_| true);
            #[cfg(feature = "fixture")]
            let ready = None;
            if ready.is_none() {
                // Pending preparation is a miss, not a foreground wait. Cancel
                // it before the normal cold path to bound the host budget.
                #[cfg(not(feature = "fixture"))]
                self.prepared.invalidate();
            }
            *active = Some(match ready { Some(bridge) => bridge, None => start()? });
        }
        let response = active.as_mut().unwrap().call(&body, Duration::from_secs(40), || self.stopped.load(Ordering::SeqCst));
        match response {
            Ok(value) if value.get("error").is_none() => Ok(value["result"].clone()),
            Ok(_) => Err("Provider/Auth operation failed. Refresh providers or restart login.".into()),
            Err(error) => { *active = None; Err(error) }
        }
    }

    fn begin_shutdown(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        #[cfg(not(feature = "fixture"))]
        self.prepared.shutdown();
    }

    fn shutdown(&self) {
        self.begin_shutdown();
        if let Ok(mut active) = self.active.lock() { *active = None; }
        #[cfg(not(feature = "fixture"))]
        if !self.prepared.wait_idle(Duration::from_secs(5)) {
            eprintln!("[Grapher] Provider/Auth preparation shutdown timed out");
        }
    }
}

pub fn request(body: Value) -> Result<Value, String> {
    TRANSPORT.get_or_init(Transport::new).request(body)
}

/// Import-only readiness. Does not enumerate/check credentials or call a model.
#[cfg(not(feature = "fixture"))]
pub(crate) fn warm() {
    if !cfg!(test) { TRANSPORT.get_or_init(Transport::new).warm_with(Bridge::prepare); }
}

pub(crate) fn begin_shutdown() {
    // Initialize even if no bridge exists so a concurrent first request cannot
    // create/rearm the shared host after shutdown begins.
    TRANSPORT.get_or_init(Transport::new).begin_shutdown();
}

pub fn shutdown() {
    TRANSPORT.get_or_init(Transport::new).shutdown();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_auth_catalog() {
        let transport = Transport::new();
        let result = transport.request(serde_json::json!({
            "version": 1,
            "operation": "catalog",
            "refresh": false,
        }));
        assert!(result.is_ok(), "Expected catalog to succeed, got: {:?}", result.err());
        let val = result.unwrap();
        assert!(val.get("providers").is_some());
        transport.shutdown();
    }

    #[cfg(not(feature = "fixture"))]
    mod prewarm {
        use super::*;
        use std::sync::{Arc, atomic::AtomicUsize};

        fn catalog() -> Value { serde_json::json!({"version": 1, "operation": "catalog", "refresh": false}) }
        fn fake_bridge() -> Result<Bridge, String> {
            let mut command = Command::new("node");
            command.args(["-e", "require('node:readline').createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({version:1,result:{pid:process.pid}})))"])
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            Bridge::spawn(&mut command)
        }

        #[test]
        fn auth_prewarm_claims_one_backend_owned_host_and_shutdown_cannot_rearm_it() {
            let transport = Transport::new();
            let starts = Arc::new(AtomicUsize::new(0));
            for _ in 0..3 {
                let starts = starts.clone();
                transport.warm_with(move |_| { starts.fetch_add(1, Ordering::SeqCst); fake_bridge() });
            }
            assert!(transport.prepared.wait_idle(Duration::from_secs(5)));
            let pid = crate::process_control::with_owner("auth-prewarm-caller", || {
                transport.request_with(catalog(), || panic!("ready host must be claimed")).unwrap()["pid"].clone()
            });
            crate::process_control::terminate_owner("auth-prewarm-caller");
            assert_eq!(transport.request(catalog()).unwrap()["pid"], pid);
            transport.warm_with(|_| panic!("active auth host must not be duplicated"));
            assert_eq!(starts.load(Ordering::SeqCst), 1);
            assert!(transport.request(serde_json::json!({"version":1,"operation":"grapher_prepare"})).is_err(), "private readiness is not a public auth operation");
            transport.shutdown();
            assert!(transport.request(catalog()).is_err());
            transport.warm_with(|_| panic!("shutdown must not rearm preparation"));
            assert!(transport.prepared.wait_idle(Duration::from_secs(1)));
        }

        #[test]
        fn pending_auth_prewarm_is_a_miss_and_late_completion_cannot_replace_active_host() {
            let transport = Transport::new();
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            transport.warm_with(move |_| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap(); // deliberately complete after invalidation
                fake_bridge()
            });
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let pid = crate::process_control::with_owner("cold-auth-caller", || {
                transport.request_with(catalog(), fake_bridge).unwrap()["pid"].clone()
            });
            crate::process_control::terminate_owner("cold-auth-caller");
            release_tx.send(()).unwrap();
            assert!(transport.prepared.wait_idle(Duration::from_secs(5)));
            assert!(transport.prepared.take_if(&(), |_| true).is_none());
            assert_eq!(transport.request(catalog()).unwrap()["pid"], pid);
            transport.shutdown();
        }

        #[test]
        fn failed_auth_prewarm_retries_and_eof_releases_the_claimed_host() {
            let transport = Transport::new();
            transport.warm_with(|_| Err("synthetic preparation failure".into()));
            assert!(transport.prepared.wait_idle(Duration::from_secs(5)));
            transport.warm_with(|_| fake_bridge());
            assert!(transport.prepared.wait_idle(Duration::from_secs(5)));
            transport.request_with(catalog(), || panic!("retry must be claimable")).unwrap();
            transport.active.lock().unwrap().as_ref().unwrap().process_tree.terminate();
            assert!(transport.request(catalog()).is_err());
            assert!(transport.active.lock().unwrap().is_none());
            transport.request_with(catalog(), fake_bridge).unwrap();
            transport.shutdown();
        }

        #[test]
        fn shutdown_interrupts_an_active_auth_receive_without_the_ipc_lock() {
            let transport = Arc::new(Transport::new());
            let (entered_tx, entered_rx) = mpsc::channel();
            let caller = transport.clone();
            let request = thread::spawn(move || caller.request_with(catalog(), || {
                let mut command = Command::new("node");
                command.args(["-e", "process.stdin.resume();setInterval(()=>{},1000)"])
                    .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
                let bridge = Bridge::spawn(&mut command)?;
                entered_tx.send(()).unwrap();
                Ok(bridge)
            }));
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            transport.begin_shutdown();
            assert!(request.join().unwrap().is_err());
            assert!(transport.active.lock().unwrap().is_none());
            transport.shutdown();
        }

        #[test]
        fn shutdown_cancels_auth_preparation_without_waiting_for_its_readiness_deadline() {
            let transport = Transport::new();
            let (entered_tx, entered_rx) = mpsc::channel();
            transport.warm_with(move |ticket| {
                entered_tx.send(()).unwrap();
                while !ticket.cancelled() { thread::sleep(Duration::from_millis(5)); }
                Err("cancelled".into())
            });
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            transport.shutdown();
            assert!(transport.prepared.wait_idle(Duration::from_millis(100)));
        }
    }
}
