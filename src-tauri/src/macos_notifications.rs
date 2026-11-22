//! Native macOS `UserNotifications.framework` (`UNUserNotificationCenter`) bridge.
//!
//! Replaces legacy `NSUserNotificationCenter` (deprecated in macOS 11 and
//! silently suppressed on modern macOS when no `UNUserNotificationCenter`
//! authorization was requested) so Grapher:
//! - registers with macOS Notification Center and prompts for permission on
//!   first launch after installation (`UNAuthorizationStatusNotDetermined`),
//! - delivers banners with sound via `UNUserNotificationCenter`,
//! - reveals and focuses the main window when the user clicks a notification,
//! - and degrades safely in unbundled dev/test binaries where
//!   `[UNUserNotificationCenter currentNotificationCenter]` is unavailable.

use std::{
    ffi::{c_char, c_void, CStr, CString},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, OnceLock},
    task::{Context, Poll, Waker},
};

const STATUS_UNAVAILABLE: i32 = -1;
const STATUS_NOT_DETERMINED: i32 = 0;
const STATUS_DENIED: i32 = 1;
const STATUS_AUTHORIZED: i32 = 2;

const DELIVER_ERROR: i32 = -2;
const DELIVER_UNAVAILABLE: i32 = -1;
const DELIVER_DENIED: i32 = 0;
const DELIVER_SENT: i32 = 1;

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacosNotificationPermission {
    Granted,
    Denied,
    Prompt,
    Unavailable,
}

impl MacosNotificationPermission {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Granted => "granted",
            Self::Denied => "denied",
            Self::Prompt => "prompt",
            Self::Unavailable => "unsupported",
        }
    }

    fn from_code(code: i32) -> Self {
        match code {
            STATUS_AUTHORIZED => Self::Granted,
            STATUS_DENIED => Self::Denied,
            STATUS_NOT_DETERMINED => Self::Prompt,
            STATUS_UNAVAILABLE | _ => Self::Unavailable,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MacosNotificationDelivery {
    Delivered,
    PermissionDenied,
    Unavailable,
    Failed(String),
}

type StatusCallback = extern "C" fn(ctx: *mut c_void, status: i32);
type DeliverCallback = extern "C" fn(ctx: *mut c_void, result: i32, error_msg: *const c_char);

extern "C" {
    fn grapher_macos_init_notifications() -> bool;
    fn grapher_macos_get_permission_status(ctx: *mut c_void, cb: StatusCallback);
    fn grapher_macos_request_permission(ctx: *mut c_void, cb: StatusCallback);
    fn grapher_macos_send_notification(
        title_utf8: *const c_char,
        body_utf8: *const c_char,
        run_id_utf8: *const c_char,
        play_sound: bool,
        ctx: *mut c_void,
        cb: DeliverCallback,
    );
}

#[no_mangle]
pub extern "C" fn grapher_macos_notification_clicked(run_id_utf8: *const c_char) {
    let run_id = if run_id_utf8.is_null() {
        None
    } else {
        let raw = unsafe { CStr::from_ptr(run_id_utf8) }
            .to_string_lossy()
            .trim()
            .to_string();
        if raw.is_empty() {
            None
        } else {
            Some(raw)
        }
    };
    if let Some(app_handle) = APP_HANDLE.get() {
        crate::handle_desktop_notification_clicked(app_handle, run_id);
    }
}

struct CallbackState<T> {
    value: Option<T>,
    waker: Option<Waker>,
}

struct CallbackFuture<T> {
    state: Arc<Mutex<CallbackState<T>>>,
}

impl<T> CallbackFuture<T> {
    fn new() -> (Self, *mut c_void) {
        let state = Arc::new(Mutex::new(CallbackState {
            value: None,
            waker: None,
        }));
        let ctx = Arc::into_raw(Arc::clone(&state)) as *mut c_void;
        (Self { state }, ctx)
    }

    fn complete(ctx: *mut c_void, value: T) {
        if ctx.is_null() {
            return;
        }
        let state = unsafe { Arc::from_raw(ctx as *const Mutex<CallbackState<T>>) };
        let waker = {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            guard.value = Some(value);
            guard.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

impl<T> Future for CallbackFuture<T> {
    type Output = T;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(value) = guard.value.take() {
            Poll::Ready(value)
        } else {
            guard.waker = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}

extern "C" fn on_status_callback(ctx: *mut c_void, status: i32) {
    CallbackFuture::<MacosNotificationPermission>::complete(
        ctx,
        MacosNotificationPermission::from_code(status),
    );
}

extern "C" fn on_deliver_callback(ctx: *mut c_void, result: i32, error_msg: *const c_char) {
    let outcome = match result {
        DELIVER_SENT => MacosNotificationDelivery::Delivered,
        DELIVER_DENIED => MacosNotificationDelivery::PermissionDenied,
        DELIVER_UNAVAILABLE => MacosNotificationDelivery::Unavailable,
        DELIVER_ERROR | _ => {
            let message = if error_msg.is_null() {
                "Failed to deliver macOS notification".to_string()
            } else {
                unsafe { CStr::from_ptr(error_msg) }
                    .to_string_lossy()
                    .into_owned()
            };
            MacosNotificationDelivery::Failed(message)
        }
    };
    CallbackFuture::<MacosNotificationDelivery>::complete(ctx, outcome);
}

/// Installs the `UNUserNotificationCenterDelegate` early during app startup and
/// schedules an initial authorization prompt if macOS has not yet asked the
/// user (`UNAuthorizationStatusNotDetermined`).
pub fn init_and_request_permission_on_startup(app_handle: &tauri::AppHandle) {
    let _ = APP_HANDLE.set(app_handle.clone());
    let available = unsafe { grapher_macos_init_notifications() };
    if !available {
        return;
    }

    // Wait briefly so the main window finishes mounting and becomes active
    // before macOS presents the native notification permission prompt.
    tauri::async_runtime::spawn(async {
        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(600));
        })
        .await;
        let status = request_permission().await;
        match status {
            MacosNotificationPermission::Granted => {
                eprintln!("[grapher-desktop] macOS notification permission is authorized");
            }
            MacosNotificationPermission::Denied => {
                eprintln!(
                    "[grapher-desktop] macOS notification permission is denied (can be enabled in System Settings -> Notifications -> Grapher)"
                );
            }
            MacosNotificationPermission::Prompt => {
                eprintln!("[grapher-desktop] macOS notification permission remains undecided");
            }
            MacosNotificationPermission::Unavailable => {}
        }
    });
}

pub async fn permission_status() -> MacosNotificationPermission {
    let (future, ctx) = CallbackFuture::<MacosNotificationPermission>::new();
    unsafe {
        grapher_macos_get_permission_status(ctx, on_status_callback);
    }
    future.await
}

pub async fn request_permission() -> MacosNotificationPermission {
    let (future, ctx) = CallbackFuture::<MacosNotificationPermission>::new();
    unsafe {
        grapher_macos_request_permission(ctx, on_status_callback);
    }
    future.await
}

pub async fn send_notification(
    title: &str,
    body: &str,
    run_id: Option<&str>,
    sound: bool,
) -> MacosNotificationDelivery {
    let title_cstr = CString::new(title.replace('\0', "")).unwrap_or_default();
    let body_cstr = CString::new(body.replace('\0', "")).unwrap_or_default();
    let run_id_cstr = run_id
        .map(|value| value.trim().replace('\0', ""))
        .filter(|value| !value.is_empty())
        .and_then(|value| CString::new(value).ok());
    let (future, ctx) = CallbackFuture::<MacosNotificationDelivery>::new();
    unsafe {
        grapher_macos_send_notification(
            title_cstr.as_ptr(),
            body_cstr.as_ptr(),
            run_id_cstr
                .as_ref()
                .map_or(std::ptr::null(), |cstr| cstr.as_ptr()),
            sound,
            ctx,
            on_deliver_callback,
        );
    }
    future.await
}

/// Opens macOS System Settings directly to the Notifications pane so the user
/// can enable notifications for Grapher if permission was previously denied.
pub fn open_notification_settings() -> Result<(), String> {
    let mut child = std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
        .spawn()
        .map_err(|error| format!("Failed to open macOS Notification Settings: {error}"))?;
    std::thread::Builder::new()
        .name("grapher-open-macos-notification-settings".to_string())
        .spawn(move || {
            let _ = child.wait();
        })
        .map_err(|error| format!("Failed to monitor macOS Notification Settings launch: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_codes_map_to_expected_strings() {
        assert_eq!(MacosNotificationPermission::from_code(STATUS_AUTHORIZED), MacosNotificationPermission::Granted);
        assert_eq!(MacosNotificationPermission::from_code(STATUS_DENIED), MacosNotificationPermission::Denied);
        assert_eq!(MacosNotificationPermission::from_code(STATUS_NOT_DETERMINED), MacosNotificationPermission::Prompt);
        assert_eq!(MacosNotificationPermission::from_code(STATUS_UNAVAILABLE), MacosNotificationPermission::Unavailable);
        assert_eq!(MacosNotificationPermission::Granted.as_str(), "granted");
        assert_eq!(MacosNotificationPermission::Denied.as_str(), "denied");
        assert_eq!(MacosNotificationPermission::Prompt.as_str(), "prompt");
        assert_eq!(MacosNotificationPermission::Unavailable.as_str(), "unsupported");
    }

    #[test]
    fn unbundled_test_binary_reports_unavailable_without_panicking() {
        assert!(!unsafe { grapher_macos_init_notifications() });
        let status = tauri::async_runtime::block_on(permission_status());
        assert_eq!(status, MacosNotificationPermission::Unavailable);
        let requested = tauri::async_runtime::block_on(request_permission());
        assert_eq!(requested, MacosNotificationPermission::Unavailable);
        let delivery = tauri::async_runtime::block_on(send_notification(
            "Grapher",
            "Test body",
            Some("run-123"),
            false,
        ));
        assert_eq!(delivery, MacosNotificationDelivery::Unavailable);
    }
}
