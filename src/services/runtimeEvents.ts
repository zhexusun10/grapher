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

/** Bounded re-check while pushes are nominally connected. A dropped frame or a
 * half-open stream must degrade to timer polling instead of freezing the view. */
export const RUNTIME_EVENTS_WATCHDOG_MS = 5_000;
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
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

const planningListeners = new Set<(event: { runId: string; planningId: string }) => void>();
const snapshotListeners = new Set<(event: SnapshotChangedEvent) => void>();
const outputListeners = new Map<string, Set<(event: OutputAvailableEvent) => void>>();
const statusListeners = new Set<(status: RuntimeEventsStatus) => void>();

function hasSubscribers(): boolean {
  return snapshotListeners.size > 0 || outputListeners.size > 0 || planningListeners.size > 0;
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
  if (retryTimer !== null || !enabled || !hasSubscribers()) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    ensureConnection();
  }, RUNTIME_EVENTS_RETRY_MS);
}

function closeConnection(): void {
  connected = false;
  clearRetry();
  if (source) {
    source.close();
    source = null;
  }
}

function ensureConnection(): void {
  if (!enabled || source || !hasSubscribers() || typeof EventSource === "undefined") {
    return;
  }
  try {
    const es = new EventSource("/api/events");
    source = es;
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
      if (es.readyState === EventSource.CLOSED) {
        source = null;
        scheduleRetry();
      }
    };
    es.addEventListener("snapshot_changed", (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as SnapshotChangedEvent;
        if (typeof data?.runId !== "string") return;
        queueMicrotask(() => {
          for (const listener of snapshotListeners) listener(data);
        });
      } catch {}
    });
    es.addEventListener("planning_output_available", (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data));
        if (!data?.runId || !data?.planningId) return;
        queueMicrotask(() => { for (const listener of planningListeners) listener(data); });
      } catch {}
    });
    es.addEventListener("output_available", (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as OutputAvailableEvent;
        if (!data?.runId || !data?.executionId || typeof data.totalBytes !== "number") return;
        const key = `${data.runId}:${data.executionId}`;
        if (!outputListeners.has(key)) return;
        queueMicrotask(() => {
          const listeners = outputListeners.get(key);
          if (!listeners) return;
          for (const listener of listeners) listener(data);
        });
      } catch {}
    });
  } catch {
    closeConnection();
  }
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

export function setRuntimeEventsConnectedForTest(isConnected: boolean, reconnected = false): void {
  enabled = isConnected;
  connected = isConnected;
  if (isConnected) {
    for (const listener of statusListeners) listener({ connected: true, reconnected });
  } else {
    hadConnectionOrError = false;
    closeConnection();
  }
}

export function dispatchSnapshotChangedForTest(event: SnapshotChangedEvent): void {
  for (const listener of snapshotListeners) listener(event);
}

export function dispatchOutputAvailableForTest(event: OutputAvailableEvent): void {
  const listeners = outputListeners.get(`${event.runId}:${event.executionId}`);
  if (!listeners) return;
  for (const listener of listeners) listener(event);
}
