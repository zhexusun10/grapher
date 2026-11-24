//! Cross-platform process-tree ownership for Execution Instances.
//!
//! Unix uses a process group. Windows uses a Job Object with kill-on-close so
//! Node, Pi, shells, and their descendants share one lifecycle boundary.
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    process::{Child, Command},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

struct ProcessTreeInner {
    #[cfg(unix)]
    pid: u32,
    #[cfg(windows)]
    job: usize,
    // Termination runs from explicit owners, shutdown and Drop. Darwin reports
    // EPERM when the group is already reduced to zombies, so repeated Linux-style
    // cleanup must stay idempotent instead of surfacing a false failure.
    terminated: AtomicBool,
}

// Raw Windows handles are process-local values. The job is owned and closed by
// ProcessTreeInner; the registry only keeps weak references for shutdown.
#[cfg(windows)]
unsafe impl Send for ProcessTreeInner {}
#[cfg(windows)]
unsafe impl Sync for ProcessTreeInner {}

#[derive(Clone)]
pub struct ProcessTree(Arc<ProcessTreeInner>);

type ProcessRegistry = OnceLock<Mutex<Vec<(String, Weak<ProcessTreeInner>)>>>;
static PROCESSES: ProcessRegistry = OnceLock::new();
thread_local! {
    static OWNER: RefCell<String> = const { RefCell::new(String::new()) };
    static LIMITS: RefCell<NativeLimits> = const { RefCell::new(NativeLimits { memory_bytes: None, cpu_rate: None }) };
}

#[allow(dead_code)]
#[derive(Clone, Copy, Default)]
struct NativeLimits {
    memory_bytes: Option<u64>,
    cpu_rate: Option<u32>,
}

/// Limits are attached while the Windows child is still suspended. The TLS
/// binding is scoped to this writer, never leaked into another Run or metadata.
pub(crate) fn with_resource_limits<T>(
    resources: Option<&crate::environment_resources::Resources>,
    work: impl FnOnce() -> T,
) -> T {
    struct Restore(NativeLimits);
    impl Drop for Restore {
        fn drop(&mut self) {
            LIMITS.with(|limits| *limits.borrow_mut() = self.0);
        }
    }
    let selected = resources
        .map(|r| NativeLimits {
            memory_bytes: r.memory_bytes,
            cpu_rate: r.cpu_rate,
        })
        .unwrap_or_default();
    let previous = LIMITS.with(|limits| std::mem::replace(&mut *limits.borrow_mut(), selected));
    let _restore = Restore(previous);
    work()
}

/// Bind process launches in this thread to an individual Run.
#[cfg(not(feature = "fixture"))]
pub(crate) fn current_owner() -> Option<String> {
    OWNER.with(|owner| {
        let owner = owner.borrow();
        (!owner.is_empty()).then(|| owner.clone())
    })
}

pub fn with_owner<T>(run_id: &str, work: impl FnOnce() -> T) -> T {
    struct Restore(String);
    impl Drop for Restore {
        fn drop(&mut self) {
            OWNER.with(|owner| *owner.borrow_mut() = std::mem::take(&mut self.0));
        }
    }
    let previous =
        OWNER.with(|owner| std::mem::replace(&mut *owner.borrow_mut(), run_id.to_owned()));
    let _restore = Restore(previous);
    work()
}

fn registry() -> &'static Mutex<Vec<(String, Weak<ProcessTreeInner>)>> {
    PROCESSES.get_or_init(|| Mutex::new(Vec::new()))
}

// Attempt-scoped cancellation closes the preparation/spawn/registration gap.
// Cleared only after the driver observes that attempt's worker has drained.
static STOPPED_OWNERS: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
fn stopped_owners() -> &'static Mutex<BTreeSet<String>> {
    STOPPED_OWNERS.get_or_init(Default::default)
}
pub(crate) fn execution_owner(run: &str, node: &str, execution: &str) -> String {
    format!("{run}:node:{node}:execution:{execution}")
}
/// Planning owns a dedicated process boundary. Cancelling one conversation's
/// Planner turn must not terminate node agents or mergers. Run-wide cleanup
/// still matches the `{run}:` prefix used by `terminate_owner`.
pub(crate) fn planning_owner(run: &str) -> String {
    format!("{run}:planner")
}
pub(crate) fn stop_owner(owner: &str) -> Result<(), String> {
    stopped_owners()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(owner.into());
    terminate_owner(owner);
    Ok(())
}
pub(crate) fn clear_owner_stop(owner: &str) {
    if let Ok(mut stopped) = stopped_owners().lock() {
        stopped.remove(owner);
    }
}
fn check_owner_stop(owner: &str) -> Result<(), String> {
    if stopped_owners()
        .lock()
        .map_err(|e| e.to_string())?
        .contains(owner)
    {
        return Err("Execution paused by user".into());
    }
    if operations()
        .lock()
        .map_err(|error| error.to_string())?
        .iter()
        .any(|(active_owner, flag)| {
            active_owner == owner
                && flag
                    .upgrade()
                    .is_some_and(|flag| flag.load(Ordering::SeqCst))
        })
    {
        return Err("Execution cancelled by user".into());
    }
    Ok(())
}
pub(crate) fn check_current_owner_stop() -> Result<(), String> {
    OWNER.with(|owner| check_owner_stop(&owner.borrow()))
}

// Multi-turn operations remain cancellable while no child process exists.
// Weak, scoped entries retire with the operation, so a later explicit retry
// under the same Run owner does not inherit its predecessor's cancellation.
type OperationRegistry = OnceLock<Mutex<Vec<(String, Weak<AtomicBool>)>>>;
static OPERATIONS: OperationRegistry = OnceLock::new();
fn operations() -> &'static Mutex<Vec<(String, Weak<AtomicBool>)>> {
    OPERATIONS.get_or_init(Default::default)
}

pub(crate) struct OperationControl {
    cancelled: Arc<AtomicBool>,
}
impl OperationControl {
    pub(crate) fn begin() -> Result<Self, String> {
        let owner = OWNER.with(|owner| owner.borrow().clone());
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut active = operations().lock().map_err(|error| error.to_string())?;
            active.retain(|(_, flag)| flag.strong_count() > 0);
            active.push((owner.clone(), Arc::downgrade(&cancelled)));
        }
        let control = Self { cancelled };
        check_owner_stop(&owner)?;
        Ok(control)
    }
}
impl Drop for OperationControl {
    fn drop(&mut self) {
        if let Ok(mut active) = operations().lock() {
            let mine = Arc::downgrade(&self.cancelled);
            active.retain(|(_, flag)| flag.strong_count() > 0 && !flag.ptr_eq(&mine));
        }
    }
}

fn cancel_operations(matches: impl Fn(&str) -> bool) {
    if let Ok(mut active) = operations().lock() {
        active.retain(|(owner, flag)| {
            if let Some(flag) = flag.upgrade() {
                if matches(owner) {
                    flag.store(true, Ordering::SeqCst);
                }
                true
            } else {
                false
            }
        });
    }
}

static RESULTS: OnceLock<Mutex<BTreeMap<String, Arc<AtomicBool>>>> = OnceLock::new();
fn results() -> &'static Mutex<BTreeMap<String, Arc<AtomicBool>>> {
    RESULTS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Cancellation also covers preparation and the spawn/registration gap. It is
/// separate from the Run mutex so an HTTP cancel never waits for the writer.
pub(crate) struct ResultControl {
    run: String,
    cancelled: Arc<AtomicBool>,
}
impl ResultControl {
    pub(crate) fn begin(run: &str) -> Result<Self, String> {
        let mut active = results().lock().map_err(|e| e.to_string())?;
        if active.contains_key(run) {
            return Err("A result execution is already active".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        active.insert(run.into(), cancelled.clone());
        Ok(Self {
            run: run.into(),
            cancelled,
        })
    }
    pub(crate) fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err("Native result execution cancelled; partial workspace retained".into())
        } else {
            Ok(())
        }
    }
    pub(crate) fn finish<T>(
        &self,
        commit: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut active = results().lock().map_err(|e| e.to_string())?;
        self.check()?;
        let result = commit();
        active.remove(&self.run);
        result
    }
}
impl Drop for ResultControl {
    fn drop(&mut self) {
        if let Ok(mut active) = results().lock() {
            if active
                .get(&self.run)
                .is_some_and(|flag| Arc::ptr_eq(flag, &self.cancelled))
            {
                active.remove(&self.run);
            }
        }
    }
}
pub(crate) fn cancel_result(run: &str) -> Result<(), String> {
    {
        let active = results().lock().map_err(|e| e.to_string())?;
        active
            .get(run)
            .ok_or("No active result execution to cancel")?
            .store(true, Ordering::SeqCst);
    }
    terminate_owner(run);
    Ok(())
}

/// Configure the child before spawn. Unix process groups are created by the
/// child itself; Windows children are assigned to a Job immediately after
/// spawn by `track`.
pub fn configure_command(command: &mut Command) {
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP keeps console cancellation independent from
        // the backend console. CREATE_SUSPENDED closes the gap before the Job
        // Object is attached; track resumes the process after assignment.
        command.creation_flags(0x0000_0200 | 0x0000_0004);
    }
}

pub fn track(child: &Child) -> Result<ProcessTree, String> {
    #[cfg(unix)]
    let tree = ProcessTree(Arc::new(ProcessTreeInner {
        pid: child.id(),
        terminated: AtomicBool::new(false),
    }));

    #[cfg(windows)]
    let tree = ProcessTree(Arc::new(ProcessTreeInner {
        job: create_job(child)?,
        terminated: AtomicBool::new(false),
    }));

    let owner = OWNER.with(|owner| owner.borrow().clone());
    registry()
        .lock()
        .map_err(|error| error.to_string())?
        .push((owner.clone(), Arc::downgrade(&tree.0)));
    if let Err(error) = check_owner_stop(&owner) {
        tree.terminate();
        return Err(error);
    }
    if results()
        .lock()
        .map_err(|e| e.to_string())?
        .get(&owner)
        .is_some_and(|flag| flag.load(Ordering::SeqCst))
    {
        tree.terminate();
        return Err("Native result execution cancelled before process registration".into());
    }
    Ok(tree)
}

/// A prestarted Partitioner becomes owned by the Run only when its prompt is
/// accepted. Cancellation then kills it just like a normally spawned agent.
pub fn assign_to_current_owner(tree: &ProcessTree) -> Result<(), String> {
    let owner = OWNER.with(|owner| owner.borrow().clone());
    let mut processes = registry().lock().map_err(|error| error.to_string())?;
    let entry = processes
        .iter_mut()
        .find(|(_, weak)| weak.ptr_eq(&Arc::downgrade(&tree.0)))
        .ok_or("Prestarted process is no longer tracked")?;
    entry.0 = owner.clone();
    drop(processes);
    if let Err(error) = check_owner_stop(&owner) {
        tree.terminate();
        return Err(error);
    }
    Ok(())
}

/// Move an already-tracked lifecycle boundary to another owner namespace.
///
/// A settled Serial turn parks its process tree, and a source Planner can retain
/// its remaining background services after the Pi worker exits. Their trees
/// move away from the active execution owner so Run completion cannot kill
/// them; backend shutdown and explicit Run cleanup still reclaim them.
/// Claiming a parked Serial tree re-keys it back to the new execution owner.
pub fn reassign_owner(tree: &ProcessTree, owner: &str) -> Result<(), String> {
    let mut processes = registry().lock().map_err(|error| error.to_string())?;
    let weak = Arc::downgrade(&tree.0);
    let entry = processes
        .iter_mut()
        .find(|(_, candidate)| candidate.ptr_eq(&weak))
        .ok_or("Process tree is no longer tracked")?;
    entry.0 = owner.to_owned();
    Ok(())
}

fn retry_termination(mut terminate: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
    for attempt in 1..=3 {
        match terminate() {
            Ok(()) => return Ok(()),
            Err(error) => {
                // Drop must not panic, including when stderr is unavailable.
                use std::io::Write;
                let _ = writeln!(
                    std::io::stderr(),
                    "Process-tree termination attempt {attempt}/3 failed: {error}"
                );
                if attempt == 3 {
                    return Err(error);
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }
    Ok(())
}

/// Darwin returns EPERM instead of ESRCH when a process group contains only
/// zombies (for example the leader was already reaped by `wait`). Grapher's
/// own descendants stay under the same UID, so a live child remains signalable;
/// the EPERM outcome means no writer under this lifecycle boundary is left to
/// terminate. Linux may still report success for zombie-only groups; its live
/// member checks additionally inspect /proc.
#[cfg(unix)]
fn no_signalable_members(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(libc::ESRCH)
        || cfg!(target_os = "macos") && error.raw_os_error() == Some(libc::EPERM)
}

#[cfg(unix)]
fn group_has_live_members(pid: u32) -> std::io::Result<bool> {
    if unsafe { libc::kill(-(pid as i32), 0) } != 0 {
        let error = std::io::Error::last_os_error();
        return if no_signalable_members(&error) {
            Ok(false)
        } else {
            Err(error)
        };
    }
    #[cfg(target_os = "linux")]
    {
        // A container's PID 1 may never reap orphaned children. Signal 0 then
        // keeps succeeding after SIGKILL although no writer can run. Require
        // two stable, nonempty zombie-only snapshots before declaring drain.
        let first = linux_zombie_members(pid)?;
        return match first {
            Some(members) if !members.is_empty() => {
                // hidepid can omit other-UID members entirely, rather than
                // making stat reads fail. Keep the signal-based refusal when
                // this mount cannot provide a complete membership inventory.
                let mounts = std::fs::read_to_string("/proc/self/mountinfo")?;
                if !linux_proc_visible(&mounts) {
                    return Ok(true);
                }
                Ok(linux_zombie_members(pid)?.as_ref() != Some(&members))
            }
            _ => Ok(true),
        };
    }
    #[cfg(not(target_os = "linux"))]
    Ok(true)
}

#[cfg(target_os = "linux")]
fn linux_proc_visible(mounts: &str) -> bool {
    let mut found = false;
    for line in mounts.lines() {
        let Some((mount, filesystem)) = line.split_once(" - ") else {
            return false;
        };
        let fields = mount.split_ascii_whitespace().collect::<Vec<_>>();
        let filesystem = filesystem.split_ascii_whitespace().collect::<Vec<_>>();
        if fields.len() < 6 || filesystem.len() < 3 {
            return false;
        }
        if fields[4] == "/proc" {
            if filesystem[0] != "proc" {
                return false;
            }
            found = true;
            for option in fields[5].split(',').chain(filesystem[2].split(',')) {
                if option
                    .strip_prefix("hidepid=")
                    .is_some_and(|value| value != "0")
                {
                    return false;
                }
            }
        }
    }
    found
}

#[cfg(target_os = "linux")]
fn linux_process_stat(bytes: &[u8]) -> std::io::Result<(u8, Option<u32>, u64)> {
    let invalid = || {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Invalid /proc process stat",
        )
    };
    // comm can contain whitespace, parentheses and non-UTF-8 bytes. Only the
    // numeric/state suffix after its final ')' has the kernel's ASCII grammar.
    let end = bytes
        .iter()
        .rposition(|byte| *byte == b')')
        .ok_or_else(invalid)?;
    let suffix = std::str::from_utf8(&bytes[end + 1..]).map_err(|_| invalid())?;
    let fields = suffix.split_ascii_whitespace().collect::<Vec<_>>();
    if fields.len() < 20 || fields[0].len() != 1 {
        return Err(invalid());
    }
    // Linux's do_task_stat initializes pgid to -1 when lock_task_sighand fails
    // during task teardown, so exiting processes legitimately report -1.
    let raw_pgid: i32 = fields[2].parse().map_err(|_| invalid())?;
    if raw_pgid < -1 {
        return Err(invalid());
    }
    Ok((
        fields[0].as_bytes()[0],
        u32::try_from(raw_pgid).ok(),
        fields[19].parse().map_err(|_| invalid())?,
    ))
}

#[cfg(target_os = "linux")]
fn linux_zombie_members(group: u32) -> std::io::Result<Option<BTreeSet<(u32, u64)>>> {
    let mut members = BTreeSet::new();
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Some((state, pgid, started)) = linux_stat_at(&entry.path())? else {
            continue;
        };
        if pgid == Some(group) {
            if !matches!(state, b'Z' | b'X' | b'x') {
                return Ok(None);
            }
            members.insert((pid, started));
            // pthread_exit can leave a zombie leader with live writer threads.
            // /proc's top-level entries enumerate leaders, not those threads.
            let tasks = match std::fs::read_dir(entry.path().join("task")) {
                Ok(tasks) => tasks,
                // Some kernels hide task entries after pthread_exit. Losing
                // that visibility cannot establish that every thread exited.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error),
            };
            let mut observed_leader = false;
            for task in tasks {
                let task = task?;
                let Ok(tid) = task.file_name().to_string_lossy().parse::<u32>() else {
                    continue;
                };
                if let Some((state, pgid, started)) = linux_stat_at(&task.path())? {
                    if pgid == Some(group) {
                        observed_leader |= tid == pid;
                        if !matches!(state, b'Z' | b'X' | b'x') {
                            return Ok(None);
                        }
                        members.insert((tid, started));
                    }
                }
            }
            if !observed_leader {
                return Ok(None);
            }
        }
    }
    Ok(Some(members))
}

#[cfg(target_os = "linux")]
fn linux_stat_at(directory: &std::path::Path) -> std::io::Result<Option<(u8, Option<u32>, u64)>> {
    let stat_path = directory.join("stat");
    for delay_ms in [1u64, 2, 5, 0] {
        match std::fs::read(&stat_path) {
            Ok(bytes) if bytes.is_empty() => {
                // On Linux procfs, a process exiting between open() and read()
                // can yield an empty 0-byte read instead of ESRCH. Retry briefly
                // so a genuinely vanished process resolves to Ok(None), while a
                // persistently empty stat file still fails closed.
                if delay_ms > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    continue;
                }
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Invalid /proc process stat",
                ));
            }
            Ok(bytes) => return linux_process_stat(&bytes).map(Some),
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(libc::ESRCH) =>
            {
                return Ok(None);
            }
            // An unreadable process must not be assumed to have exited.
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

fn terminate_inner(inner: &ProcessTreeInner) -> std::io::Result<()> {
    if inner.terminated.load(Ordering::SeqCst) {
        return Ok(());
    }
    let result = retry_termination(|| {
        #[cfg(unix)]
        {
            let pid = i32::try_from(inner.pid)
                .ok()
                .filter(|pid| *pid > 1)
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "Invalid process group ID",
                    )
                })?;
            if unsafe { libc::kill(-pid, libc::SIGKILL) } != 0 {
                let error = std::io::Error::last_os_error();
                if !no_signalable_members(&error) {
                    return Err(std::io::Error::new(
                        error.kind(),
                        format!("kill process group {pid}: {error}"),
                    ));
                }
            }
        }
        #[cfg(windows)]
        unsafe {
            if inner.job != 0 && TerminateJobObject(inner.job as RawHandle, 1) == 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(())
    });
    if result.is_ok() {
        inner.terminated.store(true, Ordering::SeqCst);
    }
    result
}

/// An in-boundary writer may finish on its own within this window; the node
/// remains `running` while it does. A leaked, long-lived helper (for example a
/// browser launched in the background) is terminated after the grace, so the run
/// cannot be wedged forever.
pub const HANDOFF_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_secs(10);
/// Post-termination confirmation window; SIGKILL delivery is asynchronous.
const POST_TERMINATE_DRAIN: std::time::Duration = std::time::Duration::from_secs(5);
/// Observe-only check used by tests and callers that already terminated, and
/// the historical natural-drain window preserved for native commands.
pub(crate) const OBSERVE_DRAIN: std::time::Duration = std::time::Duration::from_millis(500);

impl ProcessTree {
    /// Observe-only drain check with the default handoff budget.
    ///
    /// A successful model response is not a process-drain barrier: callers that
    /// already own termination use this to confirm the lifecycle boundary is
    /// empty. Production handoff uses [`Self::drain_for_handoff`] instead, so a
    /// completed turn is not failed while a killable descendant is still alive.
    pub fn ensure_drained(&self) -> Result<(), String> {
        self.drain(OBSERVE_DRAIN)
    }

    /// Wait for the lifecycle boundary to drain on its own, then terminate and
    /// confirm it is empty before a managed snapshot/handoff.
    ///
    /// The caller keeps the node `running` during `grace`, so a short-lived
    /// helper can flush and exit instead of being killed mid-work. Only a
    /// leftover still alive after that window is terminated, followed by a
    /// bounded drain confirmation. A descendant that escaped the boundary is
    /// still refused, so sealing never proceeds over a writer this process
    /// cannot account for.
    pub fn drain_for_handoff(&self, grace: std::time::Duration) -> Result<(), String> {
        if self.drain(grace).is_ok() {
            return Ok(());
        }
        // Still alive after the grace: the boundary is ours to clear. Keep the
        // fact observable so a repeated agent-side leak can be diagnosed.
        use std::io::Write;
        let _ = writeln!(
            std::io::stderr(),
            "Managed handoff: background writer(s) did not drain within {grace:?}; terminating the process boundary"
        );
        self.terminate();
        self.drain(POST_TERMINATE_DRAIN)
    }

    /// Whether any process is still alive inside this lifecycle boundary.
    ///
    /// Used to decide whether a source Planner left background services that
    /// need a held owner after its Pi worker exits.
    pub fn has_live_members(&self) -> bool {
        #[cfg(windows)]
        unsafe {
            let mut info: JobObjectBasicAccountingInformation = std::mem::zeroed();
            if QueryInformationJobObject(
                self.0.job as RawHandle,
                1,
                &mut info as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            ) == 0
            {
                return false;
            }
            info.active_processes > 0
        }
        #[cfg(unix)]
        {
            group_has_live_members(self.0.pid).unwrap_or(true)
        }
    }

    fn drain(&self, budget: std::time::Duration) -> Result<(), String> {
        // Keep polling even after terminate(): SIGKILL delivery is asynchronous,
        // and handoff must still wait for descendants that have not exited.
        let deadline = std::time::Instant::now() + budget;
        loop {
            #[cfg(windows)]
            let active = unsafe {
                let mut info: JobObjectBasicAccountingInformation = std::mem::zeroed();
                if QueryInformationJobObject(
                    self.0.job as RawHandle,
                    1,
                    &mut info as *mut _ as *mut std::ffi::c_void,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                ) == 0
                {
                    return Err(windows_error("QueryInformationJobObject (drain)"));
                }
                info.active_processes > 0
            };
            #[cfg(unix)]
            let active = group_has_live_members(self.0.pid)
                .map_err(|error| format!("Cannot confirm native process drain: {error}"))?;
            if !active {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err("Managed background writers have not drained; refusing unsafe environment seal/handoff".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    pub fn terminate(&self) {
        let _ = terminate_inner(&self.0); // Failures are retried and logged.
    }

    /// Number of live owners of this boundary.
    ///
    /// The engine's drop guard terminates only when it is the last owner, so a
    /// boundary deliberately kept alive elsewhere (a held service) is not torn
    /// down when the turn's guard is dropped.
    pub fn strong_count(&self) -> usize {
        Arc::strong_count(&self.0)
    }
}

impl Drop for ProcessTreeInner {
    fn drop(&mut self) {
        let _ = terminate_inner(self); // Drop cannot propagate errors.
        #[cfg(windows)]
        unsafe {
            if self.job != 0 && CloseHandle(self.job as RawHandle) == 0 {
                use std::io::Write;
                let _ = writeln!(
                    std::io::stderr(),
                    "Closing process job failed: {}",
                    std::io::Error::last_os_error()
                );
            }
        }
    }
}

pub fn terminate_all() {
    cancel_operations(|_| true);
    let trees = if let Ok(mut processes) = registry().lock() {
        let mut trees = Vec::new();
        processes.retain(|(_, weak)| {
            if let Some(tree) = weak.upgrade() {
                trees.push(ProcessTree(tree));
                true
            } else {
                false
            }
        });
        trees
    } else {
        Vec::new()
    };
    for tree in trees {
        tree.terminate();
    }
}

pub fn terminate_owner(run_id: &str) {
    let prefix = format!("{run_id}:");
    cancel_operations(|owner| owner == run_id || owner.starts_with(&prefix));
    let trees = if let Ok(mut processes) = registry().lock() {
        let mut trees = Vec::new();
        processes.retain(|(owner, weak)| {
            if let Some(tree) = weak.upgrade() {
                if owner == run_id || owner.starts_with(&prefix) {
                    trees.push(ProcessTree(tree));
                }
                true
            } else {
                false
            }
        });
        trees
    } else {
        Vec::new()
    };
    for tree in trees {
        tree.terminate();
    }
}

pub fn terminate_node(run_id: &str, node: &str) {
    let target = format!("{run_id}:node:{node}");
    let target_prefix = format!("{target}:");
    cancel_operations(|owner| owner == target || owner.starts_with(&target_prefix));
    let trees = if let Ok(mut processes) = registry().lock() {
        let mut trees = Vec::new();
        processes.retain(|(owner, weak)| {
            if let Some(tree) = weak.upgrade() {
                if owner == &target || owner.starts_with(&target_prefix) {
                    trees.push(ProcessTree(tree));
                }
                true
            } else {
                false
            }
        });
        trees
    } else {
        Vec::new()
    };
    for tree in trees {
        tree.terminate();
    }
}

#[cfg(windows)]
type RawHandle = *mut std::ffi::c_void;

#[cfg(windows)]
#[repr(C)]
struct IoCounters {
    read_operations: u64,
    write_operations: u64,
    other_operations: u64,
    read_bytes: u64,
    write_bytes: u64,
    other_bytes: u64,
}

#[cfg(windows)]
#[repr(C)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[cfg(windows)]
#[repr(C)]
struct JobObjectExtendedLimitInformation {
    basic: JobObjectBasicLimitInformation,
    io: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[cfg(windows)]
#[repr(C)]
struct JobObjectBasicAccountingInformation {
    total_user_time: i64,
    total_kernel_time: i64,
    this_period_user_time: i64,
    this_period_kernel_time: i64,
    total_page_fault_count: u32,
    total_processes: u32,
    active_processes: u32,
    total_terminated_processes: u32,
}

#[cfg(windows)]
#[repr(C)]
struct JobObjectCpuRateControlInformation {
    control_flags: u32,
    cpu_rate: u32,
}

#[cfg(windows)]
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
#[cfg(windows)]
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn AssignProcessToJobObject(job: RawHandle, process: RawHandle) -> i32;
    fn CloseHandle(handle: RawHandle) -> i32;
    fn CreateJobObjectW(attributes: *const std::ffi::c_void, name: *const u16) -> RawHandle;
    fn GetLastError() -> u32;
    fn SetInformationJobObject(
        job: RawHandle,
        class: u32,
        information: *mut std::ffi::c_void,
        length: u32,
    ) -> i32;
    fn TerminateJobObject(job: RawHandle, exit_code: u32) -> i32;
    fn QueryInformationJobObject(
        job: RawHandle,
        class: u32,
        information: *mut std::ffi::c_void,
        length: u32,
        returned: *mut u32,
    ) -> i32;
}

#[cfg(windows)]
fn windows_error(operation: &str) -> String {
    format!("{operation} failed with Windows error {}", unsafe {
        GetLastError()
    })
}

#[cfg(windows)]
#[link(name = "ntdll")]
extern "system" {
    fn NtResumeProcess(process: RawHandle) -> i32;
}

#[cfg(windows)]
fn create_job(child: &Child) -> Result<usize, String> {
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(windows_error("CreateJobObject"));
    }
    let selected = LIMITS.with(|limits| *limits.borrow());
    let mut limits = JobObjectExtendedLimitInformation {
        basic: JobObjectBasicLimitInformation {
            per_process_user_time_limit: 0,
            per_job_user_time_limit: 0,
            limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | if selected.memory_bytes.is_some() {
                    0x0000_0200
                } else {
                    0
                },
            minimum_working_set_size: 0,
            maximum_working_set_size: 0,
            active_process_limit: 0,
            affinity: 0,
            priority_class: 0,
            scheduling_class: 0,
        },
        io: IoCounters {
            read_operations: 0,
            write_operations: 0,
            other_operations: 0,
            read_bytes: 0,
            write_bytes: 0,
            other_bytes: 0,
        },
        process_memory_limit: 0,
        job_memory_limit: selected.memory_bytes.unwrap_or(0) as usize,
        peak_process_memory_used: 0,
        peak_job_memory_used: 0,
    };
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            (&mut limits as *mut JobObjectExtendedLimitInformation).cast(),
            std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
        )
    } != 0;
    if !configured {
        let error = windows_error("SetInformationJobObject");
        unsafe { CloseHandle(job) };
        return Err(error);
    }
    if let Some(cpu_rate) = selected.cpu_rate {
        let mut cpu = JobObjectCpuRateControlInformation {
            control_flags: 0x1 | 0x4,
            cpu_rate,
        }; // ENABLE | HARD_CAP
        if unsafe {
            SetInformationJobObject(
                job,
                15,
                (&mut cpu as *mut JobObjectCpuRateControlInformation).cast(),
                std::mem::size_of_val(&cpu) as u32,
            )
        } == 0
        {
            let error = windows_error("SetInformationJobObject (CPU hard cap)");
            unsafe { CloseHandle(job) };
            return Err(error);
        }
    }
    let assigned =
        unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as RawHandle) } != 0;
    if !assigned {
        let error = windows_error("AssignProcessToJobObject");
        unsafe { CloseHandle(job) };
        return Err(format!(
            "Cannot attach Execution Instance to a Windows Job Object: {error}. The host may already be in a non-nestable Job."
        ));
    }
    let resume_status = unsafe { NtResumeProcess(child.as_raw_handle() as RawHandle) };
    if resume_status != 0 {
        let error = format!(
            "NtResumeProcess failed with NTSTATUS 0x{:08x}",
            resume_status as u32
        );
        unsafe { CloseHandle(job) };
        return Err(error);
    }
    Ok(job as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn zombie_only_process_group_is_drained_and_repeated_cleanup_is_idempotent() {
        let mut command = Command::new("sh");
        command.args(["-c", "exit 0"]);
        configure_command(&mut command);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().unwrap();
        let tree = track(&child).unwrap();
        // Observe exit without reaping, independent of scheduling/load. Linux
        // still reports this zombie-only process group as existing to signal 0.
        let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
        assert_eq!(
            unsafe {
                libc::waitid(
                    libc::P_PID,
                    child.id(),
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            },
            0
        );
        tree.ensure_drained()
            .expect("a zombie-only group must not fail drain");
        assert!(!tree.has_live_members());
        tree.terminate();
        tree.terminate(); // Owner cleanup, shutdown and Drop may all run.
        let _ = child.wait();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn proc_stat_names_cannot_forge_process_group_or_state() {
        let own = std::fs::read("/proc/self/stat").unwrap();
        let expected = linux_process_stat(&own).unwrap();
        assert_eq!(expected.1, Some(unsafe { libc::getpgrp() } as u32));
        let end = own.iter().rposition(|byte| *byte == b')').unwrap();
        let mut unusual = b"123 (name ) Z 1 999\n\xff)".to_vec();
        unusual.extend_from_slice(&own[end + 1..]);
        assert_eq!(linux_process_stat(&unusual).unwrap(), expected);
        // Exiting tasks whose sighand is detached legitimately report pgid = -1.
        let exiting = b"456 (dying) Z 0 -1 -1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 98765 0";
        assert_eq!(linux_process_stat(exiting).unwrap(), (b'Z', None, 98765));
        for invalid in [
            b"".as_slice(),
            b"123 (missing suffix)",
            b"123 (name) Z 1",
            b"456 (bad) Z 0 -2 -1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 98765 0",
        ] {
            assert!(linux_process_stat(invalid).is_err());
        }
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(linux_stat_at(temp.path()).unwrap(), None);
        std::fs::write(temp.path().join("stat"), b"").unwrap();
        assert_eq!(
            linux_stat_at(temp.path()).unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn incomplete_proc_visibility_cannot_authorize_a_zombie_drain() {
        let visible = "20 1 0:5 / /proc rw,nosuid,nodev - proc proc rw";
        assert!(linux_proc_visible(visible));
        for hidden in [
            "hidepid=1",
            "hidepid=2",
            "hidepid=invisible",
            "hidepid=ptraceable",
        ] {
            assert!(!linux_proc_visible(&format!("{visible},{hidden}")));
        }
        assert!(!linux_proc_visible(""));
        assert!(!linux_proc_visible("unparseable mount table"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn zombie_leader_with_live_writer_thread_is_not_drained() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("writer.c");
        let program = temp.path().join("writer");
        std::fs::write(&source, r#"
#include <pthread.h>
#include <unistd.h>
static void *writer(void *unused) { for (;;) usleep(10000); return 0; }
int main(void) { pthread_t thread; if (pthread_create(&thread, 0, writer, 0)) return 1; pthread_exit(0); }
"#).unwrap();
        let output = Command::new("cc")
            .args(["-pthread", "-o"])
            .arg(&program)
            .arg(&source)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut command = Command::new(&program);
        configure_command(&mut command);
        let mut child = command.spawn().unwrap();
        let tree = track(&child).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let state = linux_stat_at(&std::path::PathBuf::from(format!("/proc/{}", child.id())))
                .unwrap()
                .unwrap()
                .0;
            if state == b'Z' {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "leader did not exit");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let active = tree.has_live_members();
        let drained = tree.ensure_drained();
        // Reclaim the genuine writer even if an assertion below fails.
        tree.terminate();
        let _ = child.wait();
        assert!(active, "a zombie leader can still own a live writer thread");
        assert!(
            drained.is_err(),
            "live threads must continue to block sealing"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn darwin_permission_denied_only_means_the_group_has_no_signalable_members() {
        assert!(no_signalable_members(&std::io::Error::from_raw_os_error(
            libc::EPERM
        )));
        assert!(no_signalable_members(&std::io::Error::from_raw_os_error(
            libc::ESRCH
        )));
        assert!(!no_signalable_members(&std::io::Error::from_raw_os_error(
            libc::EACCES
        )));
    }

    #[test]
    fn termination_retries_transient_errors_and_bounds_failures() {
        let mut attempts = 0;
        retry_termination(|| {
            attempts += 1;
            if attempts < 3 {
                Err(std::io::Error::from(std::io::ErrorKind::Interrupted))
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(attempts, 3);
        attempts = 0;
        assert!(retry_termination(|| {
            attempts += 1;
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        })
        .is_err());
        assert_eq!(attempts, 3);
    }

    #[test]
    fn result_cancellation_covers_preparation_and_is_linearized_with_commit() {
        let run = "result-cancel-barrier-test";
        let control = ResultControl::begin(run).unwrap();
        assert!(ResultControl::begin(run).is_err());
        cancel_result(run).unwrap();
        assert!(control.check().is_err());
        let mut committed = false;
        assert!(control
            .finish(|| {
                committed = true;
                Ok(())
            })
            .is_err());
        assert!(!committed);
        drop(control);
        let retry = ResultControl::begin(run).unwrap();
        retry.check().unwrap();
        retry.finish(|| Ok(())).unwrap();
        assert!(
            cancel_result(run).is_err(),
            "completed scopes cannot acknowledge a fictitious cancellation"
        );
    }

    #[test]
    fn execution_pause_covers_late_registration_without_poisoning_the_next_attempt() {
        let owner = execution_owner("late-pause-test", "worker", "first");
        stop_owner(&owner).unwrap();
        with_owner(&owner, || {
            assert!(check_current_owner_stop().is_err());
            let mut command = if cfg!(windows) {
                let mut command = Command::new("cmd");
                command.args(["/C", "ping 127.0.0.1 -n 10 > NUL"]);
                command
            } else {
                let mut command = Command::new("sh");
                command.args(["-c", "sleep 10"]);
                command
            };
            command.stdout(Stdio::null()).stderr(Stdio::null());
            configure_command(&mut command);
            let mut child = command.spawn().unwrap();
            assert!(
                track(&child).is_err(),
                "late process must acknowledge cancellation"
            );
            assert!(!child.wait().unwrap().success());
        });
        with_owner(
            &execution_owner("late-pause-test", "worker", "next"),
            || {
                check_current_owner_stop().unwrap();
            },
        );
        clear_owner_stop(&owner);
        assert!(check_owner_stop(&owner).is_ok());
    }

    #[test]
    fn operation_cancel_covers_process_registration_and_retires_with_its_scope() {
        let run = "multi-turn-stop-test";
        let owner = execution_owner(run, "join", "attempt");
        with_owner(&owner, || {
            let control = OperationControl::begin().unwrap();
            let other = with_owner("unrelated-multi-turn", || {
                OperationControl::begin().unwrap()
            });
            terminate_owner(run);
            assert!(check_current_owner_stop().is_err());
            with_owner("unrelated-multi-turn", || {
                check_current_owner_stop().unwrap()
            });
            assert!(
                OperationControl::begin().is_err(),
                "nested launch must inherit cancellation"
            );

            let mut command = if cfg!(windows) {
                let mut command = Command::new("cmd");
                command.args(["/C", "ping 127.0.0.1 -n 10 > NUL"]);
                command
            } else {
                let mut command = Command::new("sh");
                command.args(["-c", "sleep 10"]);
                command
            };
            command.stdout(Stdio::null()).stderr(Stdio::null());
            configure_command(&mut command);
            let mut child = command.spawn().unwrap();
            assert!(
                track(&child).is_err(),
                "cancellation must cover a late child registration"
            );
            assert!(!child.wait().unwrap().success());
            drop(control);
            let _retry = OperationControl::begin().unwrap();
            check_current_owner_stop().unwrap();
            drop(other);
        });
    }

    #[test]
    fn stopping_one_owner_does_not_terminate_other_run() {
        let spawn = |owner: &str| {
            let mut command = if cfg!(windows) {
                let mut command = Command::new("cmd");
                command.args(["/C", "ping 127.0.0.1 -n 10 > NUL"]);
                command
            } else {
                let mut command = Command::new("sh");
                command.args(["-c", "sleep 10"]);
                command
            };
            configure_command(&mut command);
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let child = command.spawn().unwrap();
            let tree = with_owner(owner, || track(&child).unwrap());
            (child, tree)
        };
        let (mut first, _first_tree) = spawn("first-run");
        let (mut second, second_tree) = spawn("second-run");
        terminate_owner("first-run");
        assert!(!first.wait().unwrap().success());
        assert!(second.try_wait().unwrap().is_none());
        second_tree.terminate();
        let _ = second.wait();
    }

    #[test]
    fn stopping_planning_owner_leaves_node_execution_running() {
        let spawn = |owner: &str| {
            let mut command = if cfg!(windows) {
                let mut command = Command::new("cmd");
                command.args(["/C", "ping 127.0.0.1 -n 10 > NUL"]);
                command
            } else {
                let mut command = Command::new("sh");
                command.args(["-c", "sleep 10"]);
                command
            };
            configure_command(&mut command);
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let child = command.spawn().unwrap();
            let tree = with_owner(owner, || track(&child).unwrap());
            (child, tree)
        };
        let run = "planning-owner-test";
        let planning = planning_owner(run);
        let execution = execution_owner(run, "worker", "attempt");
        let (mut planner, _planner_tree) = spawn(&planning);
        let (mut worker, worker_tree) = spawn(&execution);
        stop_owner(&planning).unwrap();
        assert!(!planner.wait().unwrap().success());
        assert!(
            worker.try_wait().unwrap().is_none(),
            "planning cancellation must not touch a node agent"
        );
        // A run-wide termination still matches the planning owner by prefix.
        terminate_owner(run);
        assert!(!worker.wait().unwrap().success());
        worker_tree.terminate();
        clear_owner_stop(&planning);
    }

    #[test]
    fn reassigned_tree_answers_only_its_new_owner() {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "ping 127.0.0.1 -n 10 > NUL"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 10"]);
            command
        };
        configure_command(&mut command);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().unwrap();
        let tree = with_owner("execution-owner", || track(&child).unwrap());
        reassign_owner(&tree, "linger-owner").unwrap();
        // Retry/invalidate target the execution owner; a parked tree must survive.
        terminate_owner("execution-owner");
        assert!(child.try_wait().unwrap().is_none());
        // The parked owner still terminates on shutdown/cleanup.
        terminate_owner("linger-owner");
        assert!(!child.wait().unwrap().success());
    }

    #[test]
    fn claimed_prestarted_process_is_cancelled_with_its_run() {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "ping 127.0.0.1 -n 10 > NUL"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 10"]);
            command
        };
        configure_command(&mut command);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().unwrap();
        let tree = track(&child).unwrap();
        with_owner("claimed-run", || assign_to_current_owner(&tree)).unwrap();
        terminate_owner("claimed-run");
        assert!(!child.wait().unwrap().success());
    }

    #[test]
    fn managed_drain_refuses_a_live_owned_descendant_after_its_parent_exits() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("writer-pid");
        let writer = "require('node:fs').writeFileSync(process.argv[1],String(process.pid)); setTimeout(()=>{},90_000)";
        let parent = r#"const fs=require('node:fs'),{spawn}=require('node:child_process');
const [writer,marker]=process.argv.slice(1);
// Windows skips libuv's child Job, not the outer Rust-owned Job.
const child=spawn(process.execPath,['-e',writer,marker],{stdio:'ignore',detached:process.platform==='win32'});
child.once('error',()=>process.exit(1)); child.unref();
const deadline=setTimeout(()=>process.exit(2),5000);
const ready=setInterval(()=>{if(fs.existsSync(marker)){clearInterval(ready);clearTimeout(deadline)}},10);"#;
        let mut command = Command::new(crate::native::trusted_node().unwrap());
        command.args(["-e", parent, writer]).arg(&marker);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_command(&mut command);
        let mut child = command.spawn().unwrap();
        let tree = track(&child).unwrap();
        assert!(child.wait().unwrap().success());
        assert!(
            marker.is_file(),
            "the writer must actually start before the parent exits"
        );
        assert!(tree
            .ensure_drained()
            .unwrap_err()
            .contains("background writers have not drained"));
        tree.terminate();
    }

    #[test]
    fn handoff_without_grace_kills_an_in_boundary_writer_before_sealing() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("writer-pid");
        let writer = "require('node:fs').writeFileSync(process.argv[1],String(process.pid)); setTimeout(()=>{},90_000)";
        // Unlike the detached refusal case above, this writer stays inside the
        // owned Unix process group / Windows Job, so a completed turn must be
        // drained by terminating it instead of being failed.
        let parent = r#"const fs=require('node:fs'),{spawn}=require('node:child_process');
const [writer,marker]=process.argv.slice(1);
const child=spawn(process.execPath,['-e',writer,marker],{stdio:'ignore',detached:process.platform==='win32'});
child.once('error',()=>process.exit(1)); child.unref();
const deadline=setTimeout(()=>process.exit(2),5000);
const ready=setInterval(()=>{if(fs.existsSync(marker)){clearInterval(ready);clearTimeout(deadline)}},10);"#;
        let mut command = Command::new(crate::native::trusted_node().unwrap());
        command.args(["-e", parent, writer]).arg(&marker);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_command(&mut command);
        let mut child = command.spawn().unwrap();
        let tree = track(&child).unwrap();
        assert!(child.wait().unwrap().success());
        assert!(
            marker.is_file(),
            "the writer must actually start before the parent exits"
        );
        tree.drain_for_handoff(std::time::Duration::ZERO)
            .expect("an in-boundary writer must be killed and drained before handoff");
    }

    #[test]
    fn handoff_grace_lets_an_in_boundary_writer_finish_on_its_own() {
        let temp = tempfile::tempdir().unwrap();
        let started = temp.path().join("started");
        let done = temp.path().join("done");
        let writer = r#"const fs=require('node:fs');fs.writeFileSync(process.argv[1],'started');setTimeout(()=>fs.writeFileSync(process.argv[2],'done'),300)"#;
        let parent = r#"const fs=require('node:fs'),{spawn}=require('node:child_process');
const [writer,started,done]=process.argv.slice(1);
const child=spawn(process.execPath,['-e',writer,started,done],{stdio:'ignore',detached:process.platform==='win32'});
child.once('error',()=>process.exit(1)); child.unref();
const deadline=setTimeout(()=>process.exit(2),5000);
const ready=setInterval(()=>{if(fs.existsSync(started)){clearInterval(ready);clearTimeout(deadline)}},10);"#;
        let mut command = Command::new(crate::native::trusted_node().unwrap());
        command
            .args(["-e", parent, writer])
            .arg(&started)
            .arg(&done);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_command(&mut command);
        let mut child = command.spawn().unwrap();
        let tree = track(&child).unwrap();
        assert!(child.wait().unwrap().success());
        assert!(
            started.is_file(),
            "the writer must actually start before the parent exits"
        );
        tree.drain_for_handoff(std::time::Duration::from_secs(5))
            .expect("the writer must drain within the grace");
        assert!(
            done.is_file(),
            "the writer must finish on its own instead of being killed"
        );
    }

    #[test]
    fn tracked_process_can_be_terminated() {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "ping 127.0.0.1 -n 10 > NUL"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 10"]);
            command
        };
        configure_command(&mut command);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().unwrap();
        let tree = track(&child).unwrap();
        tree.terminate();
        let status = child.wait().unwrap();
        assert!(!status.success());
    }
}
