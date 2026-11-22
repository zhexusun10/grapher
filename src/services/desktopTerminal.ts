import { isMacosTauriDesktop, isTauriDesktop, isWindowsTauriDesktop } from "./apiBase";
import { createWebTerminal, killWebTerminal, resizeWebTerminal, subscribeWebTerminalEvents, writeWebTerminal } from "./webTerminal";

export const DESKTOP_TERMINAL_OUTPUT_EVENT = "grapher://terminal-output";
export const DESKTOP_TERMINAL_EXIT_EVENT = "grapher://terminal-exit";

export interface TerminalSessionInfo {
  sessionId: string;
  shell: string;
  cwd: string;
}

export interface TerminalOutputEvent {
  sessionId: string;
  data: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode: number | null;
}

type TauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriRuntimeGlobal {
  __TAURI_INTERNALS__?: {
    invoke?: TauriInvoke;
  };
  __TAURI__?: {
    core?: {
      invoke?: TauriInvoke;
    };
  };
}

function getTauriInvoke(): TauriInvoke | null {
  if (!isTauriDesktop() || typeof globalThis === "undefined") return null;
  const host = globalThis as unknown as TauriRuntimeGlobal;
  if (typeof host.__TAURI_INTERNALS__?.invoke === "function") {
    return host.__TAURI_INTERNALS__.invoke.bind(host.__TAURI_INTERNALS__);
  }
  if (typeof host.__TAURI__?.core?.invoke === "function") {
    return host.__TAURI__.core.invoke.bind(host.__TAURI__.core);
  }
  return null;
}

/** Built-in PTY terminal is supported in the Windows and macOS Tauri desktop clients. */
export function isDesktopTerminalSupported(): boolean {
  return isMacosTauriDesktop() || isWindowsTauriDesktop();
}

export function isWorkspaceTerminalSupported(): boolean {
  return typeof window !== "undefined" && (!isTauriDesktop() || isDesktopTerminalSupported());
}

export function decodeBase64ToBytes(encoded: string): Uint8Array {
  if (!encoded) return new Uint8Array(0);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function createDesktopTerminal(
  workspacePath: string,
  cols?: number,
  rows?: number,
): Promise<TerminalSessionInfo> {
  if (!isTauriDesktop()) return createWebTerminal(workspacePath, cols, rows);
  const invoke = getTauriInvoke();
  if (!invoke) {
    throw new Error("Desktop terminal IPC is unavailable");
  }
  const raw = await invoke<TerminalSessionInfo>("terminal_create", {
    workspacePath,
    cols,
    rows,
  });
  if (!raw || typeof raw.sessionId !== "string" || !raw.sessionId) {
    throw new Error("Desktop terminal returned an invalid session");
  }
  return {
    sessionId: raw.sessionId,
    shell: typeof raw.shell === "string" && raw.shell ? raw.shell : "shell",
    cwd: typeof raw.cwd === "string" && raw.cwd ? raw.cwd : workspacePath,
  };
}

const inputQueues = new Map<string, Promise<void>>();
export async function writeDesktopTerminal(sessionId: string, data: string): Promise<void> {
  if (!sessionId || !data) return;
  // Preserve key/paste order across async IPC and HTTP calls, and split on
  // Unicode code points so a large paste cannot break UTF-8 surrogate pairs.
  const task = (inputQueues.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const characters = Array.from(data);
    for (let offset = 0; offset < characters.length; offset += 8192) {
      const chunk = characters.slice(offset, offset + 8192).join("");
      if (!isTauriDesktop()) await writeWebTerminal(sessionId, chunk);
      else {
        const invoke = getTauriInvoke();
        if (!invoke) throw new Error("Desktop terminal IPC is unavailable");
        await invoke("terminal_write", { sessionId, data: chunk });
      }
    }
  });
  inputQueues.set(sessionId, task);
  try { await task; }
  finally { if (inputQueues.get(sessionId) === task) inputQueues.delete(sessionId); }
}

export async function resizeDesktopTerminal(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  if (!isTauriDesktop()) return resizeWebTerminal(sessionId, cols, rows);
  const invoke = getTauriInvoke();
  if (!invoke || !sessionId) return;
  await invoke("terminal_resize", { sessionId, cols, rows });
}

export async function killDesktopTerminal(sessionId: string): Promise<void> {
  if (!isTauriDesktop()) return killWebTerminal(sessionId);
  const invoke = getTauriInvoke();
  if (!invoke || !sessionId) return;
  await invoke("terminal_kill", { sessionId });
}

export async function subscribeDesktopTerminalEvents(handlers: {
  onOutput: (event: TerminalOutputEvent) => void;
  onExit: (event: TerminalExitEvent) => void;
}): Promise<() => void> {
  if (!isTauriDesktop()) return subscribeWebTerminalEvents(handlers);
  if (!isDesktopTerminalSupported()) {
    return () => {};
  }
  let active = true;
  let unlistenOutput: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;

  try {
    const { listen } = await import("@tauri-apps/api/event");
    if (!active) return () => {};
    const stopOutput = await listen<TerminalOutputEvent>(
      DESKTOP_TERMINAL_OUTPUT_EVENT,
      (event) => {
        if (!active) return;
        const payload = event.payload;
        if (payload && typeof payload.sessionId === "string" && typeof payload.data === "string") {
          handlers.onOutput(payload);
        }
      },
    );
    if (!active) {
      stopOutput();
      return () => {};
    }
    unlistenOutput = stopOutput;

    const stopExit = await listen<TerminalExitEvent>(
      DESKTOP_TERMINAL_EXIT_EVENT,
      (event) => {
        if (!active) return;
        const payload = event.payload;
        if (payload && typeof payload.sessionId === "string") {
          handlers.onExit({
            sessionId: payload.sessionId,
            exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
          });
        }
      },
    );
    if (!active) {
      stopExit();
      unlistenOutput?.();
      unlistenOutput = null;
      return () => {};
    }
    unlistenExit = stopExit;
  } catch (error) {
    console.warn("Failed to subscribe to desktop terminal events:", error);
  }

  return () => {
    active = false;
    unlistenOutput?.();
    unlistenExit?.();
    unlistenOutput = null;
    unlistenExit = null;
  };
}
