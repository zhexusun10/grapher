import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";

const apply = <T,>(previous: T, action: SetStateAction<T>): T =>
  typeof action === "function" ? (action as (value: T) => T)(previous) : action;

/** Batch presentation updates, never events. Immediate actions drain the queue in order. */
export function useFrameBatchedState<T>(initial: T) {
  const [state, update] = useState(initial);
  const pending = useRef<SetStateAction<T>[]>([]);
  const frame = useRef<number | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTimers = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (timeout.current !== null) clearTimeout(timeout.current);
    frame.current = null;
    timeout.current = null;
  }, []);
  const flush = useCallback(() => {
    cancelTimers();
    const actions = pending.current;
    pending.current = [];
    if (actions.length) update(previous => actions.reduce(apply<T>, previous));
  }, [cancelTimers]);
  const setState = useCallback((action: SetStateAction<T>) => {
    cancelTimers();
    const actions = pending.current;
    pending.current = [];
    update(previous => apply(actions.reduce(apply<T>, previous), action));
  }, [cancelTimers]);
  const queueState = useCallback((action: SetStateAction<T>) => {
    pending.current.push(action);
    if (frame.current !== null || timeout.current !== null) return;
    frame.current = requestAnimationFrame(flush);
    // Hidden tabs may suspend RAF. Bound latency and memory without dropping events.
    timeout.current = setTimeout(flush, 50);
  }, [flush]);
  useEffect(() => () => { cancelTimers(); pending.current = []; }, [cancelTimers]);
  return [state, setState, queueState, flush] as const;
}
