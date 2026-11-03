//! Keep macOS awake while the backend is running.
//!
//! Grapher is often left open during long agent tasks. macOS idle sleep,
//! display sleep and the screen saver would otherwise lock the session while
//! the user is watching or steering work. The guard is scoped to this backend
//! process: `caffeinate -w <pid>` releases its assertions when the process
//! exits, including after a crash.
//!
//! Set `GRAPHER_KEEP_AWAKE=0` (`off`, `false`, `no`) to disable. Other
//! platforms are unaffected.

#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::Duration;

pub const KEEP_AWAKE_ENV: &str = "GRAPHER_KEEP_AWAKE";

#[cfg(target_os = "macos")]
const CAFFEINATE: &str = "/usr/bin/caffeinate";

/// macOS can lock after one minute of inactivity. Refresh below that floor so
/// timer drift does not let the screen saver start between refreshes.
#[cfg(target_os = "macos")]
const ACTIVITY_INTERVAL: Duration = Duration::from_secs(30);

/// Whether the keep-awake guard is enabled. An unset or empty value means on.
pub fn enabled(value: Option<&str>) -> bool {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => true,
        Some(value) => !matches!(
            value.to_ascii_lowercase().as_str(),
            "0" | "off" | "false" | "no"
        ),
    }
}

/// Start the guard. Failure is non-fatal: Grapher still runs.
pub fn install() {
    if !enabled(std::env::var(KEEP_AWAKE_ENV).ok().as_deref()) {
        return;
    }
    #[cfg(target_os = "macos")]
    install_macos();
}

#[cfg(target_os = "macos")]
fn install_macos() {
    use std::process::{Command, Stdio};

    let pid = std::process::id();
    let keeper = Command::new(CAFFEINATE)
        // The helper needs no inherited provider credentials or other backend
        // configuration; the assertions are entirely system-level.
        .env_clear()
        .args(["-dis", "-w", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match keeper {
        Ok(mut child) => {
            eprintln!(
                "[Grapher] Keeping macOS awake while the backend runs; set GRAPHER_KEEP_AWAKE=0 to disable."
            );
            // `-w` exits with this process; reap it so a failed assertion does
            // not leave a zombie for the lifetime of the backend.
            let _ = thread::Builder::new()
                .name("grapher-keep-awake".into())
                .spawn(move || {
                    let _ = child.wait();
                });
        }
        Err(error) => {
            eprintln!("[Grapher] Cannot prevent macOS idle sleep: {error}");
            return;
        }
    }
    // `-dis` prevents idle and display sleep. macOS can still start the screen
    // saver (and lock the session) on its own timer, so declare user activity
    // separately. `-u` defaults to a five-second assertion; `-t 1` keeps each
    // helper short while the interval resets the idle timer.
    let _ = thread::Builder::new()
        .name("grapher-keep-awake-activity".into())
        .spawn(|| {
            // A login-time launch can briefly precede the GUI session, so retry
            // after a failed refresh instead of disabling the guard for the rest
            // of the backend lifetime. Report the first failure only.
            let mut reported_error = false;
            loop {
                match Command::new(CAFFEINATE)
                    .env_clear()
                    .args(["-u", "-t", "1"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                {
                    Ok(_) => reported_error = false,
                    Err(error) if !reported_error => {
                        eprintln!("[Grapher] Cannot refresh macOS user activity: {error}");
                        reported_error = true;
                    }
                    Err(_) => {}
                }
                thread::sleep(ACTIVITY_INTERVAL);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_by_default_and_can_be_turned_off() {
        assert!(enabled(None));
        assert!(enabled(Some("")));
        assert!(enabled(Some("1")));
        assert!(enabled(Some("on")));
        for value in ["0", "off", "OFF", "false", "No", " no "] {
            assert!(!enabled(Some(value)), "{value}");
        }
    }
}
