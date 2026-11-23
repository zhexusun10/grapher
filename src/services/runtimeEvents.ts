import { getApiTransportGeneration, getCachedApiUrl, invalidateBackendBaseUrl, isTauriDesktop, resolveApiUrl } from "./apiBase";

export interface SnapshotChangedEvent {
  runId: string;
  version: string;
}

export interface OutputAvailableEvent {
  runId: string;
  executionId: string;
  totalBytes: number;
  settled?: boolean;
}

/** Bounded re-check of Run state while pushes are nominally connected. A dropped
 * frame or a half-open stream must degrade to timer polling, not freeze the view. */
export const RUNTIME_EVENTS_WATCHDOG_MS = 2_000;
/** Transcript bytes are latency-sensitive: a missed output push costs at most this. */
export const RUNTIME_EVENTS_OUTPUT_WATCHDOG_MS = 1_000;
/** EventSource stops retrying after a fatal HTTP failure; recreate it ourselves. */
export const RUNTIME_EVENTS_RETRY_MS = 1_000;

export interface RuntimeEventsStatus {
  connected: boolean;
  /** This open follows an earlier failure, so durable state may have moved on. */
  reconnected: boolean;
}

let enabled = false;
let connected = false;
let hadConnectionOrError = false;
let connecting = false;
let connectionGeneration = 0;
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let boundDocument: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> | null = null;

const planningListeners = new Set<(event: { runId: string; planningId: string }) => void>();
const snapshotListeners = new Set<(event: SnapshotChangedEvent) => void>();
const outputListeners = new Map<string, Set<(event: OutputAvailableEvent) => void>>();
const settledOutputListeners = new Set<(event: OutputAvailableEvent) => void>();
const statusListeners = new Set<(status: RuntimeEventsStatus) => void>();

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && Boolean(document.hidden);
}

function handleVisibilityChange(): void {
  if (isDocumentHidden()) {
    if (enabled && (source || connecting || retryTimer !== null)) {
      // Mark prior activity so reconnecting on visibility reports `reconnected: true`
      // and active pollers reconcile any backend changes that occurred while hidden.
      hadConnectionOrError = true;
      closeConnection();
    }
    return;
  }
  if (enabled && hasSubscribers()) {
    ensureConnection();
  }
}

function ensureVisibilityListener(): void {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  if (boundDocument === document) return;
  if (boundDocument) {
    boundDocument.removeEventListener("visibilitychange", handleVisibilityChange);
  }
  boundDocument = document;
  boundDocument.addEventListener("visibilitychange", handleVisibilityChange);
}

function detachVisibilityListener(): void {
  if (!boundDocument) return;
  boundDocument.removeEventListener("visibilitychange", handleVisibilityChange);
  boundDocument = null;
}

function hasSubscribers(): boolean {
  return snapshotListeners.size > 0 || outputListeners.size > 0 || planningListeners.size > 0 || settledOutputListeners.size > 0;
}

function notifyStatus(status: RuntimeEventsStatus): void {
  queueMicrotask(() => {
    for (const listener of statusListeners) listener(status);
  });
}

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry(): void {
  if (retryTimer !== null || !enabled || !hasSubscribers() || isDocumentHidden()) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    ensureConnection();
  }, RUNTIME_EVENTS_RETRY_MS);
}

function closeConnection(): void {
  connectionGeneration++;
  connecting = false;
  connected = false;
  clearRetry();
  if (source) {
    source.close();
    source = null;
  }
}

function openEventSource(url: string): void {
  try {
    const es = new EventSource(url);
    const transportGeneration = getApiTransportGeneration();
    source = es;
    const dispatch = (notify: () => void) => {
      queueMicrotask(() => {
        if (source === es) notify();
      });
    };
    es.onopen = () => {
      if (source !== es) return;
      const reconnected = hadConnectionOrError;
      hadConnectionOrError = true;
      connected = true;
      clearRetry();
      notifyStatus({ connected: true, reconnected });
    };
    es.onerror = () => {
      if (source !== es) return;
      hadConnectionOrError = true;
      connected = false;
      // Pollers suspend while connected; a failed push channel must resume them.
      notifyStatus({ connected: false, reconnected: false });
      if (isTauriDesktop()) {
        // In Tauri desktop mode, the dynamic sidecar may have exited or rotated
        // ports. Close this EventSource, invalidate the cached URL, and re-check
        // `backend_url` on retry rather than polling a dead port forever.
        source = null;
        es.close();
        if (transportGeneration === getApiTransportGeneration()) invalidateBackendBaseUrl();
        scheduleRetry();
      } else if (es.readyState === EventSource.CLOSED) {
        source = null;
        scheduleRetry();
      }
    };
    es.addEventListener("snapshot_changed", (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as SnapshotChangedEvent;
        if (typeof data?.runId !== "string") return;
        dispatch(() => {
          for (const listener of snapshotListeners) listener(data);
        });
      } catch {}
    });
    es.addEventListener("planning_output_available", (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data));
        if (!data?.runId || !data?.planningId) return;
        dispatch(() => { for (const listener of planningListeners) listener(data); });
      } catch {}
    });
    es.addEventListener("output_available", (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as OutputAvailableEvent;
        if (!data?.runId || !data?.executionId || typeof data.totalBytes !== "number") return;
        const key = `${data.runId}:${data.executionId}`;
        const hasSpecific = outputListeners.has(key);
        const hasSettled = Boolean(data.settled) && settledOutputListeners.size > 0;
        if (!hasSpecific && !hasSettled) return;
        dispatch(() => {
          if (hasSpecific) {
            const listeners = outputListeners.get(key);
            if (listeners) {
              for (const listener of listeners) listener(data);
            }
          }
          if (hasSettled) {
            for (const listener of settledOutputListeners) listener(data);
          }
        });
      } catch {}
    });
  } catch {
    if (isTauriDesktop()) {
      source = null;
      hadConnectionOrError = true;
      connected = false;
      invalidateBackendBaseUrl();
      notifyStatus({ connected: false, reconnected: false });
      scheduleRetry();
    } else {
      closeConnection();
    }
  }
}

function ensureConnection(): void {
  ensureVisibilityListener();
  if (!enabled || source || connecting || !hasSubscribers() || typeof EventSource === "undefined") {
    return;
  }
  if (isDocumentHidden()) {
    hadConnectionOrError = true;
    return;
  }
  const syncUrl = getCachedApiUrl("/api/events");
  if (syncUrl !== null) {
    openEventSource(syncUrl);
    return;
  }
  connecting = true;
  const generation = ++connectionGeneration;
  void resolveApiUrl("/api/events").then(
    url => {
      if (generation !== connectionGeneration) return;
      connecting = false;
      if (!enabled || source || !hasSubscribers() || typeof EventSource === "undefined") return;
      if (isDocumentHidden()) {
        hadConnectionOrError = true;
        return;
      }
      openEventSource(url);
    },
    () => {
      if (generation !== connectionGeneration) return;
      connecting = false;
      hadConnectionOrError = true;
      connected = false;
      notifyStatus({ connected: false, reconnected: false });
      scheduleRetry();
    },
  );
}

/** Enable the live SSE notification stream once the Rust backend advertises support. */
export function enableRuntimeEvents(): void {
  if (enabled) {
    ensureConnection();
    return;
  }
  enabled = true;
  ensureConnection();
}

export function isRuntimeEventsConnected(): boolean {
  return enabled && connected;
}

/** Observe connect *and* disconnect so suspended pollers can resume on either. */
export function subscribeRuntimeEventsStatus(listener: (status: RuntimeEventsStatus) => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

export function subscribeSnapshotChanges(listener: (event: SnapshotChangedEvent) => void): () => void {
  snapshotListeners.add(listener);
  ensureConnection();
  return () => {
    snapshotListeners.delete(listener);
    if (!hasSubscribers()) closeConnection();
  };
}

export function subscribePlanningOutput(listener: (event: { runId: string; planningId: string }) => void): () => void {
  planningListeners.add(listener);
  ensureConnection();
  return () => {
    planningListeners.delete(listener);
    if (!hasSubscribers()) closeConnection();
  };
}

export function subscribeExecutionOutput(
  runId: string,
  executionId: string,
  listener: (event: OutputAvailableEvent) => void,
): () => void {
  const key = `${runId}:${executionId}`;
  let bucket = outputListeners.get(key);
  if (!bucket) {
    bucket = new Set();
    outputListeners.set(key, bucket);
  }
  bucket.add(listener);
  ensureConnection();
  return () => {
    const current = outputListeners.get(key);
    if (current) {
      current.delete(listener);
      if (current.size === 0) outputListeners.delete(key);
    }
    if (!hasSubscribers()) closeConnection();
  };
}

export function subscribeSettledOutputs(listener: (event: OutputAvailableEvent) => void): () => void {
  settledOutputListeners.add(listener);
  ensureConnection();
  return () => {
    settledOutputListeners.delete(listener);
    if (!hasSubscribers()) closeConnection();
  };
}

/** Immediately wake snapshot watchers when a transcript reader discovers a settled execution. */
export function notifyExecutionSettled(runId: string, executionId: string, totalBytes = 0): void {
  if (!runId || settledOutputListeners.size === 0) return;
  const event: OutputAvailableEvent = { runId, executionId, totalBytes, settled: true };
  queueMicrotask(() => {
    for (const listener of settledOutputListeners) listener(event);
  });
}

export function setRuntimeEventsConnectedForTest(isConnected: boolean, reconnected = false): void {
  enabled = isConnected;
  connected = isConnected;
  if (isConnected) {
    for (const listener of statusListeners) listener({ connected: true, reconnected });
  } else {
    hadConnectionOrError = false;
    closeConnection();
    detachVisibilityListener();
  }
}

export function dispatchSnapshotChangedForTest(event: SnapshotChangedEvent): void {
  for (const listener of snapshotListeners) listener(event);
}

export function dispatchOutputAvailableForTest(event: OutputAvailableEvent): void {
  const listeners = outputListeners.get(`${event.runId}:${event.executionId}`);
  if (listeners) {
    for (const listener of listeners) listener(event);
  }
  if (event.settled) {
    for (const listener of settledOutputListeners) listener(event);
  }
}
