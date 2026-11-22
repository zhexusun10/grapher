import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  createDesktopTerminal,
  decodeBase64ToBytes,
  isWorkspaceTerminalSupported,
  killDesktopTerminal,
  resizeDesktopTerminal,
  subscribeDesktopTerminalEvents,
  writeDesktopTerminal,
} from "../services/desktopTerminal";
import { workspaceKey } from "../services/workspaceConversations";

export type WorkspaceTerminalMode = "open" | "minimized" | "maximized";
export type WorkspaceTerminalStatus = "starting" | "running" | "exited" | "error";

export interface WorkspaceTerminalEntry {
  key: string;
  workspacePath: string;
  instanceId: number;
  sessionId: string | null;
  shell: string;
  mode: WorkspaceTerminalMode;
  closing: boolean;
  status: WorkspaceTerminalStatus;
  exitCode: number | null;
  error: string | null;
  height: number;
}

export interface WorkspaceTerminalControl {
  supported: boolean;
  active: boolean;
  running: boolean;
  disabled: boolean;
  onToggle: () => void;
}

export const WorkspaceTerminalContext = createContext<WorkspaceTerminalControl | null>(null);

export function useWorkspaceTerminalControl(): WorkspaceTerminalControl | null {
  return useContext(WorkspaceTerminalContext);
}

const DEFAULT_TERMINAL_HEIGHT = 240;
const MIN_TERMINAL_HEIGHT = 160;
const MAX_TERMINAL_HEIGHT = 600;
const MAX_BUFFERED_CHUNKS_BYTES = 256 * 1024;

type OutputListener = (chunk: Uint8Array) => void;

interface PendingBuffer {
  chunks: Uint8Array[];
  bytes: number;
}

export interface WorkspaceTerminalsHandle {
  supported: boolean;
  activeWorkspaceKey: string;
  entries: WorkspaceTerminalEntry[];
  activeEntry: WorkspaceTerminalEntry | null;
  hasDockedTerminal: boolean;
  hasMaximizedTerminal: boolean;
  control: WorkspaceTerminalControl | null;
  toggleActiveTerminal: () => void;
  minimizeTerminal: (key: string) => void;
  toggleMaximizeTerminal: (key: string) => void;
  closeTerminal: (key: string, options?: { immediate?: boolean }) => void;
  finishCloseTerminal: (key: string, instanceId: number) => void;
  closeTerminalForPath: (workspacePath: string) => void;
  restartTerminal: (key: string) => void;
  setTerminalHeight: (key: string, height: number) => void;
  writeTerminalInput: (key: string, data: string) => void;
  resizeTerminal: (key: string, cols: number, rows: number) => void;
  attachOutputListener: (instanceId: number, listener: OutputListener) => () => void;
}

function clampHeight(height: number): number {
  if (!Number.isFinite(height)) return DEFAULT_TERMINAL_HEIGHT;
  return Math.round(Math.max(MIN_TERMINAL_HEIGHT, Math.min(MAX_TERMINAL_HEIGHT, height)));
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useWorkspaceTerminals(activeWorkspacePath: string): WorkspaceTerminalsHandle {
  const supported = isWorkspaceTerminalSupported();
  const trimmedWorkspacePath = activeWorkspacePath.trim();
  const activeKey = trimmedWorkspacePath ? workspaceKey(trimmedWorkspacePath) : "";

  const [entriesByKey, setEntriesByKey] = useState<Record<string, WorkspaceTerminalEntry>>({});
  const entriesRef = useRef(entriesByKey);
  entriesRef.current = entriesByKey;

  const nextInstanceIdRef = useRef(1);
  const sessionToInstanceRef = useRef<Map<string, number>>(new Map());
  const sessionToKeyRef = useRef<Map<string, string>>(new Map());
  const listenersByInstanceRef = useRef<Map<number, OutputListener>>(new Map());
  const pendingBuffersRef = useRef<Map<number, PendingBuffer>>(new Map());
  const latestSizeByKeyRef = useRef<Map<string, { cols: number; rows: number }>>(new Map());
  const eventUnsubscribeRef = useRef<(() => void) | null>(null);
  const eventSubscribePromiseRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  const earlyEventsRef = useRef(new Map<string, { chunks: Uint8Array[]; bytes: number; exit?: number | null }>());

  const pushOutputForInstance = useCallback((instanceId: number, bytes: Uint8Array) => {
    if (bytes.length === 0) return;
    const listener = listenersByInstanceRef.current.get(instanceId);
    if (listener) {
      listener(bytes);
      return;
    }
    let buffer = pendingBuffersRef.current.get(instanceId);
    if (!buffer) {
      buffer = { chunks: [], bytes: 0 };
      pendingBuffersRef.current.set(instanceId, buffer);
    }
    buffer.chunks.push(bytes);
    buffer.bytes += bytes.length;
    while (buffer.bytes > MAX_BUFFERED_CHUNKS_BYTES && buffer.chunks.length > 1) {
      const dropped = buffer.chunks.shift();
      if (dropped) buffer.bytes -= dropped.length;
    }
  }, []);

  const attachOutputListener = useCallback((instanceId: number, listener: OutputListener) => {
    listenersByInstanceRef.current.set(instanceId, listener);
    const pending = pendingBuffersRef.current.get(instanceId);
    if (pending) {
      pendingBuffersRef.current.delete(instanceId);
      for (const chunk of pending.chunks) {
        listener(chunk);
      }
    }
    return () => {
      if (listenersByInstanceRef.current.get(instanceId) === listener) {
        listenersByInstanceRef.current.delete(instanceId);
      }
    };
  }, []);

  const handleExit = useCallback((sessionId: string, exitCode: number | null) => {
    const key = sessionToKeyRef.current.get(sessionId);
    sessionToInstanceRef.current.delete(sessionId);
    sessionToKeyRef.current.delete(sessionId);
    if (!key) return;
    setEntriesByKey(prev => {
      const current = prev[key];
      if (!current || current.sessionId !== sessionId) return prev;
      return { ...prev, [key]: { ...current, status: "exited", exitCode } };
    });
  }, []);

  const earlyEvents = useCallback((sessionId: string) => {
    let pending = earlyEventsRef.current.get(sessionId);
    if (!pending) {
      if (earlyEventsRef.current.size >= 32) {
        earlyEventsRef.current.delete(earlyEventsRef.current.keys().next().value!);
      }
      pending = { chunks: [], bytes: 0 };
      earlyEventsRef.current.set(sessionId, pending);
    }
    return pending;
  }, []);

  const ensureEventSubscription = useCallback((): Promise<void> => {
    if (!supported) return Promise.resolve();
    if (eventUnsubscribeRef.current) return Promise.resolve();
    if (eventSubscribePromiseRef.current) return eventSubscribePromiseRef.current;

    const task = subscribeDesktopTerminalEvents({
      onOutput: (event) => {
        const instanceId = sessionToInstanceRef.current.get(event.sessionId);
        try {
          const bytes = decodeBase64ToBytes(event.data);
          if (instanceId === undefined) {
            const pending = earlyEvents(event.sessionId);
            pending.chunks.push(bytes);
            pending.bytes += bytes.length;
            while (pending.bytes > MAX_BUFFERED_CHUNKS_BYTES && pending.chunks.length > 1) {
              pending.bytes -= pending.chunks.shift()!.length;
            }
            return;
          }
          pushOutputForInstance(instanceId, bytes);
        } catch {
          // Ignore malformed output frame.
        }
      },
      onExit: (event) => {
        if (!sessionToKeyRef.current.has(event.sessionId)) {
          earlyEvents(event.sessionId).exit = event.exitCode;
          return;
        }
        handleExit(event.sessionId, event.exitCode);
      },
    }).then((unlisten) => {
      if (!mountedRef.current) {
        unlisten();
        return;
      }
      eventUnsubscribeRef.current = unlisten;
    }).finally(() => {
      if (eventSubscribePromiseRef.current === task) {
        eventSubscribePromiseRef.current = null;
      }
    });
    eventSubscribePromiseRef.current = task;
    return task;
  }, [supported, pushOutputForInstance, earlyEvents, handleExit]);

  // Ensure all live PTYs and event listeners are cleaned up if the app root unmounts.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      eventUnsubscribeRef.current?.();
      eventUnsubscribeRef.current = null;
      for (const sessionId of sessionToKeyRef.current.keys()) {
        void killDesktopTerminal(sessionId).catch(() => {});
      }
      sessionToKeyRef.current.clear();
      sessionToInstanceRef.current.clear();
      listenersByInstanceRef.current.clear();
      pendingBuffersRef.current.clear();
      earlyEventsRef.current.clear();
    };
  }, []);

  const spawnForWorkspace = useCallback(
    (key: string, workspacePath: string, targetMode: WorkspaceTerminalMode, preservedHeight?: number) => {
      if (!supported || !key || !workspacePath) return;
      const instanceId = nextInstanceIdRef.current++;
      const existing = entriesRef.current[key];
      if (existing?.sessionId) {
        const oldSessionId = existing.sessionId;
        sessionToInstanceRef.current.delete(oldSessionId);
        sessionToKeyRef.current.delete(oldSessionId);
        void killDesktopTerminal(oldSessionId).catch(() => {});
      }
      if (existing) {
        pendingBuffersRef.current.delete(existing.instanceId);
        listenersByInstanceRef.current.delete(existing.instanceId);
      }

      const height = clampHeight(preservedHeight ?? existing?.height ?? DEFAULT_TERMINAL_HEIGHT);
      const nextEntry: WorkspaceTerminalEntry = {
        key,
        workspacePath,
        instanceId,
        sessionId: null,
        shell: "",
        mode: targetMode,
        closing: false,
        status: "starting",
        exitCode: null,
        error: null,
        height,
      };
      setEntriesByKey((prev) => ({ ...prev, [key]: nextEntry }));

      const size = latestSizeByKeyRef.current.get(key);
      void ensureEventSubscription()
        .then(() => createDesktopTerminal(workspacePath, size?.cols, size?.rows))
        .then(
        (info) => {
          const current = entriesRef.current[key];
          if (!mountedRef.current || !current || current.closing || current.instanceId !== instanceId) {
            earlyEventsRef.current.delete(info.sessionId);
            void killDesktopTerminal(info.sessionId).catch(() => {});
            return;
          }
          sessionToInstanceRef.current.set(info.sessionId, instanceId);
          sessionToKeyRef.current.set(info.sessionId, key);
          // Parsing buffered startup output may synchronously generate terminal
          // input (ConPTY's cursor-position handshake). Make the session
          // writable before handing those bytes to xterm, even before commit.
          entriesRef.current = {
            ...entriesRef.current,
            [key]: { ...current, sessionId: info.sessionId, shell: info.shell, status: "running", error: null },
          };
          setEntriesByKey((prev) => {
            const latest = prev[key];
            if (!latest || latest.instanceId !== instanceId) return prev;
            return {
              ...prev,
              [key]: {
                ...latest,
                sessionId: info.sessionId,
                shell: info.shell,
                status: "running",
                error: null,
              },
            };
          });
          const early = earlyEventsRef.current.get(info.sessionId);
          earlyEventsRef.current.delete(info.sessionId);
          if (early) {
            for (const chunk of early.chunks) pushOutputForInstance(instanceId, chunk);
            if ("exit" in early) handleExit(info.sessionId, early.exit ?? null);
          }
          const latestSize = latestSizeByKeyRef.current.get(key);
          if (latestSize) {
            void resizeDesktopTerminal(info.sessionId, latestSize.cols, latestSize.rows).catch(() => {});
          }
        },
        (error) => {
          const current = entriesRef.current[key];
          if (!current || current.instanceId !== instanceId) return;
          const message = error instanceof Error ? error.message : String(error ?? "Failed to start terminal");
          setEntriesByKey((prev) => {
            const latest = prev[key];
            if (!latest || latest.instanceId !== instanceId) return prev;
            return {
              ...prev,
              [key]: {
                ...latest,
                status: "error",
                error: message,
              },
            };
          });
        },
      );
    },
    [supported, ensureEventSubscription, pushOutputForInstance, handleExit],
  );

  const toggleActiveTerminal = useCallback(() => {
    if (!supported || !activeKey || !trimmedWorkspacePath) return;
    const current = entriesRef.current[activeKey];
    if (!current || current.closing) {
      spawnForWorkspace(activeKey, trimmedWorkspacePath, "open");
      return;
    }
    setEntriesByKey((prev) => {
      const latest = prev[activeKey];
      if (!latest || latest.closing) return prev;
      const nextMode: WorkspaceTerminalMode = latest.mode === "minimized" ? "open" : "minimized";
      return {
        ...prev,
        [activeKey]: {
          ...latest,
          mode: nextMode,
        },
      };
    });
  }, [supported, activeKey, trimmedWorkspacePath, spawnForWorkspace]);

  const minimizeTerminal = useCallback((key: string) => {
    setEntriesByKey((prev) => {
      const current = prev[key];
      if (!current || current.closing || current.mode === "minimized") return prev;
      return {
        ...prev,
        [key]: { ...current, mode: "minimized" },
      };
    });
  }, []);

  const toggleMaximizeTerminal = useCallback((key: string) => {
    setEntriesByKey((prev) => {
      const current = prev[key];
      if (!current || current.closing) return prev;
      const nextMode: WorkspaceTerminalMode = current.mode === "maximized" ? "open" : "maximized";
      return {
        ...prev,
        [key]: { ...current, mode: nextMode },
      };
    });
  }, []);

  const finishCloseTerminal = useCallback((key: string, instanceId: number) => {
    setEntriesByKey((prev) => {
      const current = prev[key];
      if (!current || !current.closing || current.instanceId !== instanceId) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const closeTerminal = useCallback(
    (key: string, options?: { immediate?: boolean }) => {
      const current = entriesRef.current[key];
      if (current) {
        if (current.sessionId) {
          sessionToInstanceRef.current.delete(current.sessionId);
          sessionToKeyRef.current.delete(current.sessionId);
          void killDesktopTerminal(current.sessionId).catch(() => {});
        }
        pendingBuffersRef.current.delete(current.instanceId);
        listenersByInstanceRef.current.delete(current.instanceId);
      }
      latestSizeByKeyRef.current.delete(key);

      const shouldAnimateOut =
        !options?.immediate &&
        !prefersReducedMotion() &&
        Boolean(current && !current.closing && current.mode !== "minimized" && key === activeKey);

      if (shouldAnimateOut) {
        setEntriesByKey((prev) => {
          const latest = prev[key];
          if (!latest) return prev;
          return {
            ...prev,
            [key]: {
              ...latest,
              sessionId: null,
              closing: true,
            },
          };
        });
        return;
      }

      setEntriesByKey((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [activeKey],
  );

  const closeTerminalForPath = useCallback(
    (workspacePath: string) => {
      const key = workspaceKey(workspacePath);
      if (key) closeTerminal(key, { immediate: true });
    },
    [closeTerminal],
  );

  const restartTerminal = useCallback(
    (key: string) => {
      const current = entriesRef.current[key];
      if (!current) return;
      const targetMode: WorkspaceTerminalMode = current.mode === "maximized" ? "maximized" : "open";
      spawnForWorkspace(key, current.workspacePath, targetMode, current.height);
    },
    [spawnForWorkspace],
  );

  const setTerminalHeight = useCallback((key: string, height: number) => {
    const clamped = clampHeight(height);
    setEntriesByKey((prev) => {
      const current = prev[key];
      if (!current || current.height === clamped) return prev;
      return {
        ...prev,
        [key]: { ...current, height: clamped },
      };
    });
  }, []);

  const writeTerminalInput = useCallback((key: string, data: string) => {
    const current = entriesRef.current[key];
    if (!current?.sessionId || current.status !== "running") return;
    const sessionId = current.sessionId;
    const showError = (error: string | null) => setEntriesByKey(prev => {
      const latest = prev[key];
      if (latest?.sessionId !== sessionId || latest.status !== "running" || latest.error === error) return prev;
      return { ...prev, [key]: { ...latest, error } };
    });
    void writeDesktopTerminal(sessionId, data).then(
      () => showError(null),
      error => showError(error instanceof Error ? error.message : String(error)),
    );
  }, []);

  const resizeTerminal = useCallback((key: string, cols: number, rows: number) => {
    if (cols <= 0 || rows <= 0) return;
    latestSizeByKeyRef.current.set(key, { cols, rows });
    const current = entriesRef.current[key];
    if (!current?.sessionId || current.status !== "running") return;
    void resizeDesktopTerminal(current.sessionId, cols, rows).catch(() => {});
  }, []);

  const entries = useMemo(() => Object.values(entriesByKey), [entriesByKey]);
  const activeEntry = activeKey ? entriesByKey[activeKey] ?? null : null;
  const liveActiveEntry = activeEntry && !activeEntry.closing ? activeEntry : null;
  const hasDockedTerminal = Boolean(liveActiveEntry && liveActiveEntry.mode === "open");
  const hasMaximizedTerminal = Boolean(liveActiveEntry && liveActiveEntry.mode === "maximized");

  const control = useMemo<WorkspaceTerminalControl | null>(() => {
    if (!supported) return null;
    return {
      supported: true,
      active: Boolean(liveActiveEntry && liveActiveEntry.mode !== "minimized"),
      running: Boolean(liveActiveEntry),
      disabled: !activeKey,
      onToggle: toggleActiveTerminal,
    };
  }, [supported, liveActiveEntry, activeKey, toggleActiveTerminal]);

  return {
    supported,
    activeWorkspaceKey: activeKey,
    entries,
    activeEntry,
    hasDockedTerminal,
    hasMaximizedTerminal,
    control,
    toggleActiveTerminal,
    minimizeTerminal,
    toggleMaximizeTerminal,
    closeTerminal,
    finishCloseTerminal,
    closeTerminalForPath,
    restartTerminal,
    setTerminalHeight,
    writeTerminalInput,
    resizeTerminal,
    attachOutputListener,
  };
}
