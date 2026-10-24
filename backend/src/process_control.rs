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

static PROCESSES: OnceLock<Mutex<Vec<(String, Weak<ProcessTreeInner>)>>> = OnceLock::new();
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
pub(crate) fn stop_owner(owner: &str) -> Result<(), String> {
    stopped_owners().lock().map_err(|e| e.to_string())?.insert(owner.into());
    terminate_owner(owner);
    Ok(())
}
pub(crate) fn clear_owner_stop(owner: &str) {
    if let Ok(mut stopped) = stopped_owners().lock() { stopped.remove(owner); }
}
fn check_owner_stop(owner: &str) -> Result<(), String> {
    if stopped_owners().lock().map_err(|e| e.to_string())?.contains(owner) {
        Err("Execution paused by user".into())
    } else {
        Ok(())
    }
}
pub(crate) fn check_current_owner_stop() -> Result<(), String> {
    OWNER.with(|owner| check_owner_stop(&owner.borrow()))
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
/// A settled Serial turn parks its process tree instead of terminating it: the
/// parked tree must stop answering its old execution owner's cancellation
/// (invalidate/retry would otherwise kill the warm shell and any service it
/// started), while staying reachable for backend shutdown and explicit cleanup.
/// Claiming a parked tree re-keys it back to the new execution owner.
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
/// terminate. Linux reports ESRCH for the same state.
#[cfg(unix)]
fn no_signalable_members(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(libc::ESRCH)
        || cfg!(target_os = "macos") && error.raw_os_error() == Some(libc::EPERM)
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
    /// Used after a node agent exits: a surviving background service keeps the
    /// boundary non-empty, so the backend keeps the Job/process group open
    /// instead of closing it (which would kill the service).
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
        unsafe {
            libc::kill(-(self.0.pid as i32), 0) == 0
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
            let active = unsafe {
                let result = libc::kill(-(self.0.pid as i32), 0);
                if result == 0 {
                    true
                } else {
                    let error = std::io::Error::last_os_error();
                    if !no_signalable_members(&error) {
                        return Err(format!("Cannot confirm native process drain: {error}"));
                    }
                    false
                }
            };
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
            if self.job != 0 {
                if CloseHandle(self.job as RawHandle) == 0 {
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
}

pub fn terminate_all() {
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
    let trees = if let Ok(mut processes) = registry().lock() {
        let mut trees = Vec::new();
        let prefix = format!("{run_id}:");
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

    #[cfg(target_os = "macos")]
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
        std::thread::sleep(std::time::Duration::from_millis(100));
        // The leader is a zombie before wait(); Darwin reports EPERM for its
        // process group even though no live writer remains.
        tree.ensure_drained()
            .expect("a zombie-only group must not fail drain");
        tree.terminate();
        tree.terminate(); // Owner cleanup, shutdown and Drop may all run.
        let _ = child.wait();
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
            assert!(track(&child).is_err(), "late process must acknowledge cancellation");
            assert!(!child.wait().unwrap().success());
        });
        with_owner(&execution_owner("late-pause-test", "worker", "next"), || {
            check_current_owner_stop().unwrap();
        });
        clear_owner_stop(&owner);
        assert!(check_owner_stop(&owner).is_ok());
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
        command.args(["-e", parent, writer]).arg(&started).arg(&done);
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
