import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";

const apply = <T,>(previous: T, action: SetStateAction<T>): T =>
  typeof action === "function" ? (action as (value: T) => T)(previous) : action;

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && Boolean(document.hidden);
}

/** Batch presentation updates, never events. Immediate actions drain the queue in order.
 * While the document is hidden, queued presentation updates fold in memory without
 * scheduling timers or React commits, then commit once when visible again. */
export function useFrameBatchedState<T>(initial: T) {
  const [state, update] = useState(initial);
  const latest = useRef(initial);
  const pending = useRef<SetStateAction<T>[]>([]);
  const dirtyWhileHidden = useRef(false);
  const frame = useRef<number | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTimers = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (timeout.current !== null) clearTimeout(timeout.current);
    frame.current = null;
    timeout.current = null;
  }, []);
  const drainPendingIntoLatest = useCallback(() => {
    const actions = pending.current;
    if (!actions.length) return false;
    pending.current = [];
    latest.current = actions.reduce(apply<T>, latest.current);
    return true;
  }, []);
  const flush = useCallback(() => {
    cancelTimers();
    const hadPending = drainPendingIntoLatest();
    if (hadPending || dirtyWhileHidden.current) {
      dirtyWhileHidden.current = false;
      update(() => latest.current);
    }
  }, [cancelTimers, drainPendingIntoLatest]);
  const setState = useCallback((action: SetStateAction<T>) => {
    cancelTimers();
    drainPendingIntoLatest();
    latest.current = apply(latest.current, action);
    dirtyWhileHidden.current = false;
    update(() => latest.current);
  }, [cancelTimers, drainPendingIntoLatest]);
  const queueState = useCallback((action: SetStateAction<T>) => {
    if (isDocumentHidden()) {
      cancelTimers();
      drainPendingIntoLatest();
      latest.current = apply(latest.current, action);
      dirtyWhileHidden.current = true;
      return;
    }
    pending.current.push(action);
    if (frame.current !== null || timeout.current !== null) return;
    frame.current = requestAnimationFrame(flush);
    // Bound latency if RAF is delayed while still visible.
    timeout.current = setTimeout(flush, 50);
  }, [cancelTimers, drainPendingIntoLatest, flush]);
  useEffect(() => {
    if (typeof document === "undefined") {
      return () => { cancelTimers(); pending.current = []; dirtyWhileHidden.current = false; };
    }
    const onVisibilityChange = () => {
      if (isDocumentHidden()) {
        cancelTimers();
        if (drainPendingIntoLatest()) {
          dirtyWhileHidden.current = true;
        }
        return;
      }
      if (dirtyWhileHidden.current || pending.current.length > 0) {
        flush();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cancelTimers();
      pending.current = [];
      dirtyWhileHidden.current = false;
    };
  }, [cancelTimers, drainPendingIntoLatest, flush]);
  return [state, setState, queueState, flush] as const;
}
