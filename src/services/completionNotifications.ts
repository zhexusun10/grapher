import type { Execution, Snapshot, TranscriptItem } from "../types";
import { isTauriDesktop } from "./apiBase";
import { runtimeService } from "./runtime";
import { parseTranscriptChunkLines, type ParseTranscriptChunkState } from "./transcriptParser";

type TauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriRuntimeGlobal {
  __TAURI_INTERNALS__?: { invoke?: TauriInvoke };
  __TAURI__?: { core?: { invoke?: TauriInvoke } };
}

const SEND_DESKTOP_NOTIFICATION_COMMAND = "send_desktop_notification";
const DESKTOP_NOTIFICATION_PERMISSION_STATUS_COMMAND = "desktop_notification_permission_status";
const REQUEST_DESKTOP_NOTIFICATION_PERMISSION_COMMAND = "request_desktop_notification_permission";
const OPEN_DESKTOP_NOTIFICATION_SETTINGS_COMMAND = "open_desktop_notification_settings";
const TAKE_PENDING_NOTIFICATION_CLICK_COMMAND = "take_pending_notification_click";
export const DESKTOP_NOTIFICATION_CLICKED_EVENT = "grapher://notification-clicked";
const NOTIFICATION_TAIL_BYTES = 64 * 1024;
const DEFAULT_MAX_BODY_CHARS = 220;

export type NotificationPermissionState = NotificationPermission | "unsupported";

function normalizeNotificationPermission(raw: unknown): NotificationPermissionState {
  if (raw === "granted") return "granted";
  if (raw === "denied") return "denied";
  if (raw === "default" || raw === "prompt") return "default";
  return "unsupported";
}

function getTauriInvoke(): TauriInvoke | null {
  if (typeof globalThis === "undefined") return null;
  const host = globalThis as unknown as TauriRuntimeGlobal;
  if (typeof host.__TAURI_INTERNALS__?.invoke === "function") {
    return host.__TAURI_INTERNALS__.invoke.bind(host.__TAURI_INTERNALS__);
  }
  if (typeof host.__TAURI__?.core?.invoke === "function") {
    return host.__TAURI__.core.invoke.bind(host.__TAURI__.core);
  }
  return null;
}

/**
 * Returns true when a settled Run phase represents a completed conversation
 * turn that should notify a user whose window is unfocused.
 *
 * Serial runs pass briefly through `awaiting_approval` before auto-approving,
 * so `awaiting_approval` only notifies for non-serial, non-auto-approve runs.
 */
export function isCompletionNotificationPhase(
  phase: string,
  snapshot?: Pick<Snapshot, "planType" | "config"> | null,
): boolean {
  if (phase === "completed" || phase === "followup") return true;
  if (phase === "awaiting_approval") {
    if (snapshot?.planType === "serial") return false;
    if (snapshot?.config?.autoApprove) return false;
    return true;
  }
  return false;
}

/**
 * Parses a JSONL or plain-text transcript chunk and returns the final visible
 * assistant text reply, ignoring thinking blocks, tool call cards, error rows,
 * and leading partial lines from mid-log tail reads.
 */
export function extractLastAssistantTextFromTranscript(content: string, leadingFragment = false): string {
  if (!content || !content.trim()) return "";
  const lines = content.split("\n");
  const items: TranscriptItem[] = [];
  const pendingTools = new Map<string, TranscriptItem>();
  const state: ParseTranscriptChunkState = {
    source: "notify",
    byteOffset: 0,
    leadingFragment,
    inTagThinking: false,
    inFinalResponse: false,
    finalResponseSuppressed: false,
    seenFirstUser: false,
    pendingUserStart: false,
    assistantStartIndex: 0,
    userMessageStarts: new Set(),
    compacting: false,
  };
  const parsed = parseTranscriptChunkLines(lines, items, pendingTools, state, {
    showUserTurns: false,
    skipFirstUser: true,
  });
  for (let i = parsed.currentItems.length - 1; i >= 0; i -= 1) {
    const item = parsed.currentItems[i];
    if (
      item.type === "text" &&
      item.role === "assistant" &&
      !item.isError &&
      item.status !== "error" &&
      typeof item.content === "string" &&
      item.content.trim()
    ) {
      return item.content.trim();
    }
  }
  return "";
}

/**
 * Converts Markdown-formatted assistant output into a clean, single-line
 * preview suitable for OS notification banners.
 */
export function formatNotificationBody(rawText: string, maxChars = DEFAULT_MAX_BODY_CHARS): string {
  if (!rawText || maxChars <= 0) return "";
  const stripped = rawText
    .replace(/\r\n?/g, "\n")
    // Remove fenced code block delimiters while keeping inner code text.
    .replace(/```[^\n]*\n?/g, " ")
    // Replace Markdown images/links with their readable labels.
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Strip heading markers, blockquote prefixes, and horizontal rules.
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*_]{3,}\s*$)/gm, "")
    // Strip inline code and emphasis markers.
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1$2")
    // Strip remaining ASCII control characters and collapse whitespace.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!stripped) return "";
  const chars = Array.from(stripped);
  if (chars.length <= maxChars) return stripped;
  const truncated = chars.slice(0, Math.max(0, maxChars - 1)).join("").trimEnd();
  return `${truncated}…`;
}

export type OutputSource =
  | { kind: "execution"; execution: Execution }
  | { kind: "planning"; planningId: string };

function executionTimestamp(execution: Execution): number {
  return execution.completedAt ?? execution.startedAt ?? 0;
}

function parseTimestampMs(raw?: string | number | null): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function latestPlanningInfo(snapshot: Snapshot): { planningId: string; timestamp: number } | null {
  let planningId = "";
  let timestamp = 0;

  for (let i = (snapshot.events?.length ?? 0) - 1; i >= 0; i -= 1) {
    const event = snapshot.events[i];
    if (event.type === "planning_completed") {
      const id = event.planning_id || event.planning?.planningId || "";
      if (id) {
        planningId = id;
        timestamp = event.timestamp ?? 0;
        break;
      }
    }
  }

  const fallbackId = snapshot.planning?.planningId || snapshot.planningId || "";
  if (!planningId && fallbackId) {
    planningId = fallbackId;
    timestamp = Math.max(
      parseTimestampMs(snapshot.planning?.roles?.planner?.lastEvent),
      parseTimestampMs(snapshot.planning?.createdAt),
    );
  } else if (planningId && snapshot.planning?.planningId === planningId) {
    timestamp = Math.max(
      timestamp,
      parseTimestampMs(snapshot.planning?.roles?.planner?.lastEvent),
      parseTimestampMs(snapshot.planning?.createdAt),
    );
  }

  return planningId ? { planningId, timestamp } : null;
}

/**
 * Selects ordered transcript sources (primary first, optional fallback second)
 * representing where the agent wrote its most recent output for this snapshot.
 */
export function selectFinalOutputSources(snapshot: Snapshot | null): OutputSource[] {
  if (!snapshot) return [];
  const executions = [...(snapshot.executions ?? []), ...(snapshot.mergers ?? [])];
  let latestExecution: Execution | null = null;
  let latestExecutionTs = -1;
  for (const execution of executions) {
    const ts = executionTimestamp(execution);
    if (!latestExecution || ts >= latestExecutionTs) {
      latestExecution = execution;
      latestExecutionTs = ts;
    }
  }

  const planning = latestPlanningInfo(snapshot);
  const sources: OutputSource[] = [];

  if (snapshot.phase === "awaiting_approval" || !latestExecution) {
    if (planning) sources.push({ kind: "planning", planningId: planning.planningId });
    if (latestExecution) sources.push({ kind: "execution", execution: latestExecution });
    return sources;
  }

  if (planning && planning.timestamp > latestExecutionTs) {
    sources.push({ kind: "planning", planningId: planning.planningId });
    sources.push({ kind: "execution", execution: latestExecution });
    return sources;
  }

  sources.push({ kind: "execution", execution: latestExecution });
  if (planning) sources.push({ kind: "planning", planningId: planning.planningId });
  return sources;
}

export type FinalOutputChunk = string | { content: string; leadingFragment?: boolean };

export interface FinalOutputFetcher {
  getExecutionOutput: (runId: string, executionId: string, signal?: AbortSignal) => Promise<FinalOutputChunk>;
  getPlanningOutput: (planningId: string, signal?: AbortSignal) => Promise<FinalOutputChunk>;
}

function normalizeOutputChunk(chunk: FinalOutputChunk): { content: string; leadingFragment: boolean } {
  if (typeof chunk === "string") return { content: chunk, leadingFragment: false };
  return { content: chunk.content ?? "", leadingFragment: Boolean(chunk.leadingFragment) };
}

const defaultFetcher: FinalOutputFetcher = {
  async getExecutionOutput(runId, executionId, signal) {
    const page = await runtimeService.getExecutionOutput(
      runId,
      executionId,
      0,
      signal,
      false,
      true,
      undefined,
      NOTIFICATION_TAIL_BYTES,
    );
    return {
      content: page?.content ?? "",
      leadingFragment: (page?.startOffset ?? 0) > 0,
    };
  },
  async getPlanningOutput(planningId, signal) {
    const page = await runtimeService.getPlanningOutput(
      planningId,
      "planner",
      0,
      signal,
      true,
      undefined,
      NOTIFICATION_TAIL_BYTES,
    );
    return {
      content: page?.content ?? "",
      leadingFragment: (page?.startOffset ?? 0) > 0,
    };
  },
};

export async function resolveFinalAgentOutput(
  runId: string,
  snapshot: Snapshot | null,
  fetcher: FinalOutputFetcher = defaultFetcher,
  signal?: AbortSignal,
): Promise<string> {
  const sources = selectFinalOutputSources(snapshot);
  for (const source of sources) {
    try {
      let content = "";
      let leadingFragment = false;
      if (source.kind === "execution") {
        const chunk = normalizeOutputChunk(await fetcher.getExecutionOutput(runId, source.execution.id, signal));
        content = chunk.content;
        leadingFragment = chunk.leadingFragment;
        if (!content && source.execution.output) {
          content = source.execution.output;
          leadingFragment = false;
        }
      } else {
        const chunk = normalizeOutputChunk(await fetcher.getPlanningOutput(source.planningId, signal));
        content = chunk.content;
        leadingFragment = chunk.leadingFragment;
      }
      const extracted = extractLastAssistantTextFromTranscript(content, leadingFragment);
      const formatted = formatNotificationBody(extracted);
      if (formatted) return formatted;
    } catch {
      if (source.kind === "execution" && source.execution.output) {
        const extracted = extractLastAssistantTextFromTranscript(source.execution.output);
        const formatted = formatNotificationBody(extracted);
        if (formatted) return formatted;
      }
    }
  }
  return "";
}

export function isWindowUnfocused(
  doc: Pick<Document, "hidden" | "visibilityState" | "hasFocus"> | null =
    typeof document !== "undefined" ? document : null,
): boolean {
  if (!doc) return false;
  if (doc.hidden || doc.visibilityState !== "visible") return true;
  if (typeof doc.hasFocus === "function") return !doc.hasFocus();
  return false;
}

export async function getNotificationPermissionStatus(): Promise<NotificationPermissionState> {
  if (isTauriDesktop()) {
    const invoke = getTauriInvoke();
    if (!invoke) return "unsupported";
    try {
      const status = await invoke<string>(DESKTOP_NOTIFICATION_PERMISSION_STATUS_COMMAND);
      return normalizeNotificationPermission(status);
    } catch {
      return "unsupported";
    }
  }
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermissionState> {
  if (isTauriDesktop()) {
    const invoke = getTauriInvoke();
    if (!invoke) return "unsupported";
    try {
      const status = await invoke<string>(REQUEST_DESKTOP_NOTIFICATION_PERMISSION_COMMAND);
      return normalizeNotificationPermission(status);
    } catch {
      return "unsupported";
    }
  }
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export const requestNotificationPermission = requestBrowserNotificationPermission;

export async function openDesktopNotificationSettings(): Promise<boolean> {
  if (!isTauriDesktop()) return false;
  const invoke = getTauriInvoke();
  if (!invoke) return false;
  try {
    await invoke(OPEN_DESKTOP_NOTIFICATION_SETTINGS_COMMAND);
    return true;
  } catch (error) {
    console.warn("Failed to open desktop notification settings:", error);
    return false;
  }
}

export interface CompletionNotificationPayload {
  title: string;
  body: string;
  runId?: string;
  sound?: boolean;
  onClick?: (runId?: string) => void;
}

export interface DesktopNotificationClickPayload {
  runId: string;
  seq: number;
}

/**
 * Subscribes to native desktop notification click events so clicking a banner
 * brings the user straight to the conversation that posted it. Also drains any
 * buffered click recorded before the listener mounted, deduplicated by `seq`.
 */
export function subscribeDesktopNotificationClicks(
  onOpenRun: (runId: string) => void,
  options?: {
    listenFn?: (
      event: string,
      handler: (event: { payload: DesktopNotificationClickPayload }) => void,
    ) => Promise<() => void>;
  },
): () => void {
  if (!isTauriDesktop()) return () => {};
  let active = true;
  let lastHandledSeq = 0;
  let unlisten: (() => void) | null = null;

  const deliver = (payload?: Partial<DesktopNotificationClickPayload> | null) => {
    if (!active || !payload) return;
    const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
    if (!runId) return;
    const seq = typeof payload.seq === "number" && Number.isFinite(payload.seq) ? payload.seq : 0;
    if (seq > 0) {
      if (seq <= lastHandledSeq) return;
      lastHandledSeq = seq;
    }
    onOpenRun(runId);
  };

  void (async () => {
    try {
      const listen =
        options?.listenFn
        ?? (await import("@tauri-apps/api/event")).listen<DesktopNotificationClickPayload>;
      const stop = await listen(DESKTOP_NOTIFICATION_CLICKED_EVENT, (event) => {
        deliver(event?.payload);
      });
      if (!active) {
        stop();
        return;
      }
      unlisten = stop;
    } catch (error) {
      console.warn("Failed to subscribe to desktop notification clicks:", error);
    }

    if (!active) return;
    const invoke = getTauriInvoke();
    if (!invoke) return;
    try {
      const pending = await invoke<DesktopNotificationClickPayload | null>(
        TAKE_PENDING_NOTIFICATION_CLICK_COMMAND,
      );
      deliver(pending);
    } catch {
      // Ignore if the host shell does not expose pending click recovery.
    }
  })();

  return () => {
    active = false;
    unlisten?.();
    unlisten = null;
  };
}

/**
 * Dispatches a completion notification when the app does not hold OS focus.
 *
 * - Tauri desktop (macOS/Windows/Linux): delegates to `send_desktop_notification`,
 *   which checks native window focus/visibility in Rust and posts a native OS
 *   notification (carrying `runId` for click navigation and honoring `sound`).
 * - Browser mode: checks `document.hidden` / `document.hasFocus()` and uses
 *   the Web Notifications API when permission is granted.
 */
export async function sendCompletionNotification(
  payload: CompletionNotificationPayload,
): Promise<boolean> {
  const title = formatNotificationBody(payload.title, 120) || "Grapher";
  const body = formatNotificationBody(payload.body, DEFAULT_MAX_BODY_CHARS);
  if (!body) return false;
  const runId = typeof payload.runId === "string" && payload.runId.trim() ? payload.runId.trim() : undefined;
  const sound = payload.sound !== false;

  if (isTauriDesktop()) {
    const invoke = getTauriInvoke();
    if (!invoke) return false;
    try {
      const args: Record<string, unknown> = { title, body, sound };
      if (runId) args.runId = runId;
      const sent = await invoke<boolean>(SEND_DESKTOP_NOTIFICATION_COMMAND, args);
      return Boolean(sent);
    } catch (error) {
      console.warn("Failed to send desktop completion notification:", error);
      return false;
    }
  }

  if (!isWindowUnfocused()) return false;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return false;
  }
  try {
    const notification = new Notification(title, { body, silent: !sound });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // Ignore browser focus restrictions.
      }
      try {
        payload.onClick?.(runId);
      } catch {
        // Ignore navigation errors from stale notification clicks.
      }
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
