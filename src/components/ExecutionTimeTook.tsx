import { useEffect, useRef, useState } from "react";
import type { Execution } from "../types";
import { formatToolDuration } from "../utils/toolTiming";

export function calculateExecutionDurationMs(execution?: Execution | null, now = Date.now()): number | null {
  if (!execution || !execution.startedAt) {
    return null;
  }
  // A live attempt may carry a pre-launch model placeholder in metrics; only
  // its wall clock is authoritative until the process settles.
  if (execution.completedAt != null) {
    if (execution.metrics?.durationSeconds != null && execution.metrics.durationSeconds > 0) {
      return Math.max(0, execution.metrics.durationSeconds * 1000);
    }
    return Math.max(0, execution.completedAt - execution.startedAt);
  }
  return Math.max(0, now - execution.startedAt);
}

/** Stable English timestamp for the session details panel. */
export function formatSessionStartTime(value?: number | string | null): string {
  const ms = typeof value === "string" ? Number(value) : value;
  if (ms == null || !Number.isFinite(ms) || ms <= 0) {
    return "-";
  }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Session durations use completed whole seconds; tool cards retain their precision. */
export function formatTimeTookDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  return seconds < 10 ? `${seconds}s` : formatToolDuration(seconds * 1000);
}

/** Refresh at elapsed-second boundaries without changing the authoritative start time. */
function useTimeTookClock(running: boolean, startedAt?: number | null, attemptId?: string) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!running) return;
    const start = startedAt && startedAt > 0 ? startedAt : Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      timer = setTimeout(tick, 1000 - (Math.max(0, current - start) % 1000));
    };
    tick();
    return () => clearTimeout(timer);
  }, [running, startedAt, attemptId]);

  return now;
}

export function ExecutionTimeTookText({ execution, priorDurationSeconds }: {
  execution?: Execution | null;
  /** Active seconds of this Pi session's earlier attempts. */
  priorDurationSeconds?: number | null;
}) {
  const running = execution?.status === "running" && execution?.completedAt == null;
  const now = useTimeTookClock(running, execution?.startedAt, execution?.id);
  const priorMs = Math.max(0, (priorDurationSeconds ?? 0) * 1000);

  const durationMs = calculateExecutionDurationMs(execution, now);
  if (durationMs == null) {
    return priorMs > 0 ? <span>{formatTimeTookDuration(priorMs)}</span> : <span>-</span>;
  }

  return <span>{formatTimeTookDuration(priorMs + durationMs)}</span>;
}

export function calculatePlannerDurationMs({
  isPlanning,
  startedAt,
  durationSeconds,
  priorDurationSeconds,
  now = Date.now(),
}: {
  isPlanning?: boolean;
  startedAt?: number | null;
  durationSeconds?: number | null;
  /** Completed turns of the same Planner session, excluding this one. */
  priorDurationSeconds?: number | null;
  now?: number;
}): number | null {
  const priorMs = Math.max(0, Math.round((priorDurationSeconds ?? 0) * 1000));
  if (isPlanning) {
    if (startedAt && startedAt > 0) {
      return priorMs + Math.max(0, now - startedAt);
    }
    return priorMs;
  }
  if (durationSeconds != null && !isNaN(durationSeconds) && durationSeconds >= 0) {
    return priorMs + Math.max(0, Math.round(durationSeconds * 1000));
  }
  return priorMs > 0 ? priorMs : null;
}

export function PlannerTimeTookText({
  isPlanning,
  startedAt,
  durationSeconds,
  priorDurationSeconds,
}: {
  isPlanning?: boolean;
  startedAt?: number | null;
  durationSeconds?: number | null;
  /** Completed turns of the same Planner session, excluding this one. */
  priorDurationSeconds?: number | null;
}) {
  const running = Boolean(isPlanning);
  const now = useTimeTookClock(running, startedAt);
  const liveStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) liveStartRef.current = null;
  }, [running]);

  if (running) {
    if (startedAt && startedAt > 0) {
      liveStartRef.current = startedAt;
    } else if (!liveStartRef.current) {
      liveStartRef.current = Date.now();
    }
  }

  const effectiveStartedAt = running ? (liveStartRef.current || startedAt || now) : null;
  const durationMs = calculatePlannerDurationMs({
    isPlanning,
    startedAt: effectiveStartedAt,
    durationSeconds,
    priorDurationSeconds,
    now,
  });

  if (durationMs == null) {
    return <span>-</span>;
  }

  return <span>{formatTimeTookDuration(durationMs)}</span>;
}
