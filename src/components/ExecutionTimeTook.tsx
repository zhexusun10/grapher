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

export function ExecutionTimeTookText({ execution }: { execution?: Execution | null }) {
  const [now, setNow] = useState(Date.now);
  const running = execution?.status === "running" && execution?.completedAt == null;

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, execution?.id]);

  const durationMs = calculateExecutionDurationMs(execution, now);
  if (durationMs == null) {
    return <span>-</span>;
  }

  return <span>{formatToolDuration(durationMs)}</span>;
}

export function calculatePlannerDurationMs({
  isPlanning,
  startedAt,
  durationSeconds,
  now = Date.now(),
}: {
  isPlanning?: boolean;
  startedAt?: number | null;
  durationSeconds?: number | null;
  now?: number;
}): number | null {
  if (isPlanning) {
    if (startedAt && startedAt > 0) {
      return Math.max(0, now - startedAt);
    }
    return 0;
  }
  if (durationSeconds != null && !isNaN(durationSeconds) && durationSeconds >= 0) {
    return Math.max(0, Math.round(durationSeconds * 1000));
  }
  return null;
}

export function PlannerTimeTookText({
  isPlanning,
  startedAt,
  durationSeconds,
}: {
  isPlanning?: boolean;
  startedAt?: number | null;
  durationSeconds?: number | null;
}) {
  const [now, setNow] = useState(Date.now);
  const running = Boolean(isPlanning);
  const liveStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) {
      liveStartRef.current = null;
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);

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
    now,
  });

  if (durationMs == null) {
    return <span>-</span>;
  }

  return <span>{formatToolDuration(durationMs)}</span>;
}
