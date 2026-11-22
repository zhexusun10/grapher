import { ApiRequestError, jsonRequest } from "./apiClient";
import { getCachedApiUrl } from "./apiBase";
import type { TerminalExitEvent, TerminalOutputEvent, TerminalSessionInfo } from "./desktopTerminal";

type Handlers = {
  onOutput: (event: TerminalOutputEvent) => void;
  onExit: (event: TerminalExitEvent) => void;
};
interface OutputPage {
  chunks: string[];
  cursor: number;
  truncated: boolean;
  exited: boolean;
  exitCode: number | null;
  more: boolean;
}
const sessions = new Map<string, { cursor: number }>();
const subscribers = new Set<Handlers>();
let timer: ReturnType<typeof setTimeout> | null = null;
let polling = false;

function schedule(delay = 80) {
  if (timer !== null || polling || !sessions.size || !subscribers.size) return;
  timer = setTimeout(() => { timer = null; void poll(); }, delay);
}

function output(sessionId: string, data: string) {
  for (const handler of subscribers) handler.onOutput({ sessionId, data });
}

async function poll() {
  if (polling) return;
  polling = true;
  let delay = 80;
  try {
    await Promise.all([...sessions].map(async ([sessionId, session]) => {
      try {
        const page = await jsonRequest<OutputPage>("terminal_read", { sessionId, cursor: session.cursor }, { timeoutMs: 4000 });
        if (sessions.get(sessionId) !== session) return;
        if (!Array.isArray(page.chunks) || !page.chunks.every(chunk => typeof chunk === "string") ||
            !Number.isSafeInteger(page.cursor) || page.cursor < session.cursor) {
          throw new Error("Invalid terminal output page");
        }
        if (page.truncated) output(sessionId, btoa("\r\n[Earlier terminal output was truncated]\r\n"));
        for (const chunk of page.chunks) output(sessionId, chunk);
        session.cursor = page.cursor;
        if (page.more) delay = 0;
        if (page.exited) {
          sessions.delete(sessionId);
          for (const handler of subscribers) handler.onExit({ sessionId, exitCode: page.exitCode });
          void jsonRequest("terminal_kill", { sessionId }).catch(() => {});
        }
      } catch (error) {
        if (sessions.get(sessionId) !== session) return;
        // Reads are replayable. Keep the cursor through network failures; a
        // backend restart explicitly retires the now-missing PTY instead.
        delay = Math.max(delay, 1000);
        if (error instanceof ApiRequestError && error.status === 404) {
          sessions.delete(sessionId);
          output(sessionId, btoa("\r\n[Terminal session is no longer available]\r\n"));
          for (const handler of subscribers) handler.onExit({ sessionId, exitCode: null });
        }
      }
    }));
  } finally {
    polling = false;
    schedule(delay);
  }
}

function closeOnPageHide() {
  // A navigation cannot wait for promises. Use the existing JSON POST boundary
  // and an idempotent close; the backend also expires abandoned sessions.
  const url = getCachedApiUrl("/api/terminal_kill");
  for (const sessionId of sessions.keys()) {
    if (url && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(url, new Blob([JSON.stringify({ sessionId })], { type: "application/json" }));
    }
  }
}

export function subscribeWebTerminalEvents(handlers: Handlers): () => void {
  if (subscribers.size === 0) window.addEventListener("pagehide", closeOnPageHide);
  subscribers.add(handlers);
  schedule();
  return () => {
    subscribers.delete(handlers);
    if (!subscribers.size) {
      window.removeEventListener("pagehide", closeOnPageHide);
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }
  };
}

export async function createWebTerminal(workspacePath: string, cols?: number, rows?: number): Promise<TerminalSessionInfo> {
  const info = await jsonRequest<TerminalSessionInfo>("terminal_create", { workspacePath, cols, rows });
  if (!info?.sessionId || typeof info.sessionId !== "string") throw new Error("Invalid terminal session");
  sessions.set(info.sessionId, { cursor: 0 });
  // A timer runs after create's caller has registered its session-to-view map.
  schedule(0);
  return info;
}

export async function killWebTerminal(sessionId: string): Promise<void> {
  sessions.delete(sessionId);
  await jsonRequest("terminal_kill", { sessionId });
}

export async function writeWebTerminal(sessionId: string, data: string): Promise<void> {
  await jsonRequest("terminal_write", { sessionId, data });
}

export async function resizeWebTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  await jsonRequest("terminal_resize", { sessionId, cols, rows });
}
