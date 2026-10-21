//! Host Git must not share the backend console. The probe creates its own
//! disposable console, so these tests never signal the test runner or service.
use super::*;
use std::{
    os::windows::process::CommandExt,
    time::{Duration, Instant},
};

#[link(name = "kernel32")]
extern "system" {
    fn GetConsoleProcessList(processes: *mut u32, count: u32) -> u32;
    fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
    fn GenerateConsoleCtrlEvent(event: u32, group: u32) -> i32;
}

unsafe extern "system" fn handle_probe_interrupt(event: u32) -> i32 {
    // A custom handler is not inherited by Git. The special
    // SetConsoleCtrlHandler(NULL, TRUE) ignore attribute would be inherited.
    i32::from(event == 0 || event == 1)
}

/// PowerShell/alias startup can exceed a few seconds on a loaded CI runner.
/// The probe owns its own disposable console, so a generous wait is free when
/// the host is healthy and avoids failing a correct isolation check.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// The alias script waits for the parent to release it after each assertion.
const RELEASE_WINDOW_SECONDS: u64 = 60;

#[test]
fn host_git_is_isolated_from_console_control_events() {
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact", "workspace::git_console_tests::git_console_probe",
            "--ignored", "--nocapture",
        ])
        .env("GRAPHER_GIT_CONSOLE_TEST_PARENT", std::process::id().to_string())
        // CREATE_NEW_CONSOLE: never broadcast to the test runner or backend.
        .creation_flags(0x0000_0010)
        .output().unwrap();
    assert!(output.status.success(), "{}\n{}\n{}", output.status,
        String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
}

fn path(value: &Path) -> String {
    value.to_string_lossy().replace('\\', "/")
}

fn probe_alias(script: &Path, arguments: &[&Path]) -> String {
    let arguments = arguments
        .iter()
        .map(|argument| format!("'{}'", path(argument)))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "alias.grapher-console-probe=!powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '{}' {arguments}",
        path(script)
    )
}

fn console_processes() -> Vec<u32> {
    let mut processes = [0u32; 64];
    let count = unsafe { GetConsoleProcessList(processes.as_mut_ptr(), processes.len() as u32) };
    processes[..(count as usize).min(processes.len())].to_vec()
}

fn wait_for(path: &Path) {
    let deadline = Instant::now() + READY_TIMEOUT;
    while !path.exists() {
        assert!(Instant::now() < deadline, "Git probe did not become ready: {}", path.display());
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "only run in the new console created by host_git_is_isolated_from_console_control_events"]
fn git_console_probe() {
    let parent: u32 = std::env::var("GRAPHER_GIT_CONSOLE_TEST_PARENT")
        .expect("console probe must be launched by its parent test").parse().unwrap();
    let mut processes = [0u32; 16];
    let count = unsafe { GetConsoleProcessList(processes.as_mut_ptr(), processes.len() as u32) };
    // Fail closed before generating any event if console isolation is absent.
    assert_eq!(count, 1, "probe must own a fresh console: {processes:?}");
    assert_eq!(processes[0], std::process::id());
    assert_ne!(processes[0], parent);
    assert_ne!(unsafe { SetConsoleCtrlHandler(Some(handle_probe_interrupt), 1) }, 0);

    let temp = tempfile::tempdir().unwrap();
    let wait = temp.path().join("wait-for-release.ps1");
    fs::write(&wait, format!(r#"param([string]$Ready, [string]$Release, [string]$Survived)
Set-Content -LiteralPath $Ready -Value ready -NoNewline
$deadline = [DateTime]::UtcNow.AddSeconds({RELEASE_WINDOW_SECONDS})
while (-not (Test-Path -LiteralPath $Release)) {{
    if ([DateTime]::UtcNow -gt $deadline) {{ exit 44 }}
    Start-Sleep -Milliseconds 20
}}
Set-Content -LiteralPath $Survived -Value survived -NoNewline
"#)).unwrap();

    // A plain host Git shares the probe console. `workspace::git` must not add
    // any process to this console while the alias is running.
    let ready = temp.path().join("ready-unprotected");
    let release = temp.path().join("release-unprotected");
    let survived = temp.path().join("survived-unprotected");
    let alias = probe_alias(&wait, &[&ready, &release, &survived]);
    let mut command = Command::new("git");
    crate::native::clear_git_environment(&mut command);
    let mut unprotected = command.args(["-c", &alias, "grapher-console-probe"])
        .current_dir(temp.path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn().unwrap();
    wait_for(&ready);
    let attached = console_processes();
    assert!(attached.len() > 1 && attached.contains(&unprotected.id()),
        "plain Git must be attached to the probe console: {attached:?}");
    fs::write(&release, "release").unwrap();
    assert!(unprotected.wait().unwrap().success());

    let temp_path = temp.path().to_path_buf();
    let ready = temp.path().join("ready-protected");
    let release = temp.path().join("release-protected");
    let survived = temp.path().join("survived-protected");
    let alias = probe_alias(&wait, &[&ready, &release, &survived]);
    let protected = std::thread::spawn(move || {
        git(&temp_path, &["-c", &alias, "grapher-console-probe"]).unwrap();
    });
    wait_for(&ready);
    assert_eq!(console_processes(), vec![std::process::id()],
        "host Git must not attach to the backend console");
    fs::write(&release, "release").unwrap();
    protected.join().unwrap();
    assert_eq!(fs::read_to_string(&survived).unwrap(), "survived");

    for event in [0u32, 1] { // CTRL_C_EVENT, CTRL_BREAK_EVENT
        let ready = temp.path().join(format!("ready-{event}"));
        let release = temp.path().join(format!("release-{event}"));
        let survived = temp.path().join(format!("survived-{event}"));
        let alias = probe_alias(&wait, &[&ready, &release, &survived]);
        let signal = {
            let ready = ready.clone();
            let release = release.clone();
            std::thread::spawn(move || -> Result<(), String> {
                let deadline = Instant::now() + READY_TIMEOUT;
                while !ready.exists() {
                    if Instant::now() >= deadline { return Err("Git probe did not become ready".into()); }
                    std::thread::sleep(Duration::from_millis(10));
                }
                let sent = unsafe { GenerateConsoleCtrlEvent(event, 0) };
                // Give Windows time to deliver the event before allowing Git to finish.
                std::thread::sleep(Duration::from_millis(150));
                fs::write(release, "release").map_err(|e| e.to_string())?;
                if sent == 0 { return Err("Cannot send isolated console event".into()); }
                Ok(())
            })
        };
        // Bounded even if the signal thread fails. No real repository, hooks,
        // running services, or source/runtime files are involved.
        git(temp.path(), &["-c", &alias, "grapher-console-probe"]).unwrap();
        signal.join().unwrap().unwrap();
        assert_eq!(fs::read_to_string(&survived).unwrap(), "survived", "console event {event}");
    }
}
