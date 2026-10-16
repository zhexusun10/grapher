import { useEffect, useState } from "react";
import type { Execution } from "../types";
import { formatToolDuration } from "../utils/toolTiming";

export function calculateExecutionDurationMs(execution?: Execution | null, now = Date.now()): number | null {
  if (!execution || !execution.startedAt) {
    return null;
  }
  if (execution.metrics?.durationSeconds != null) {
    return Math.max(0, execution.metrics.durationSeconds * 1000);
  }
  if (execution.completedAt != null) {
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
