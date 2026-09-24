//! Cross-platform process-tree ownership for Execution Instances.
//!
//! Unix uses a process group. Windows uses a Job Object with kill-on-close so
//! Node, Pi, shells, and their descendants share one lifecycle boundary.
use std::{
    process::{Child, Command},
    sync::{Arc, Mutex, OnceLock, Weak},
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
}

// Raw Windows handles are process-local values. The job is owned and closed by
// ProcessTreeInner; the registry only keeps weak references for shutdown.
#[cfg(windows)]
unsafe impl Send for ProcessTreeInner {}
#[cfg(windows)]
unsafe impl Sync for ProcessTreeInner {}

#[derive(Clone)]
pub struct ProcessTree(Arc<ProcessTreeInner>);

static PROCESSES: OnceLock<Mutex<Vec<Weak<ProcessTreeInner>>>> = OnceLock::new();

fn registry() -> &'static Mutex<Vec<Weak<ProcessTreeInner>>> {
    PROCESSES.get_or_init(|| Mutex::new(Vec::new()))
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
    let tree = ProcessTree(Arc::new(ProcessTreeInner { pid: child.id() }));

    #[cfg(windows)]
    let tree = ProcessTree(Arc::new(ProcessTreeInner {
        job: create_job(child)?,
    }));

    registry()
        .lock()
        .map_err(|error| error.to_string())?
        .push(Arc::downgrade(&tree.0));
    Ok(tree)
}

fn terminate_inner(inner: &ProcessTreeInner) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(inner.pid as i32), libc::SIGKILL);
    }

    #[cfg(windows)]
    unsafe {
        if inner.job != 0 {
            let _ = TerminateJobObject(inner.job as RawHandle, 1);
        }
    }
}

impl ProcessTree {
    pub fn terminate(&self) {
        terminate_inner(&self.0);
    }
}

impl Drop for ProcessTreeInner {
    fn drop(&mut self) {
        terminate_inner(self);
        #[cfg(windows)]
        unsafe {
            if self.job != 0 {
                let _ = CloseHandle(self.job as RawHandle);
            }
        }
    }
}

pub fn terminate_all() {
    let trees = if let Ok(mut processes) = registry().lock() {
        let mut trees = Vec::new();
        processes.retain(|weak| {
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
    let mut limits = JobObjectExtendedLimitInformation {
        basic: JobObjectBasicLimitInformation {
            per_process_user_time_limit: 0,
            per_job_user_time_limit: 0,
            limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
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
        job_memory_limit: 0,
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
