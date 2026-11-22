//! Tauri adapter for the shared native PTY implementation.
#[path = "../../backend/src/terminal.rs"]
mod pty;
pub use pty::*;

#[derive(Clone)]
pub struct TauriTerminalEventSink {
    app_handle: tauri::AppHandle,
}

impl TauriTerminalEventSink {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self { app_handle }
    }
}

impl TerminalEventSink for TauriTerminalEventSink {
    fn emit_output(&self, event: TerminalOutputEvent) {
        use tauri::Emitter;
        let _ = self
            .app_handle
            .emit_to("main", DESKTOP_TERMINAL_OUTPUT_EVENT, event);
    }

    fn emit_exit(&self, event: TerminalExitEvent) {
        use tauri::Emitter;
        let _ = self
            .app_handle
            .emit_to("main", DESKTOP_TERMINAL_EXIT_EVENT, event);
    }
}
