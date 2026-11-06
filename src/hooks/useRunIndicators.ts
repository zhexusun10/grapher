import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationSummary, Execution, Snapshot } from "../types";
import { runHasLiveWork } from "../lib/runPhase";

export interface RunIndicator {
  unread: boolean;
  phase: string;
  /** The Run owns work in flight; a settled phase does not by itself mean idle. */
  working: boolean;
}

function executionActivityVersion(executions: Execution[] = []): string {
  return executions.map((execution) =>
    `${execution.id}:${execution.status}:${execution.outputBytes ?? execution.output.length}`
  ).join(",");
}

function snapshotActivityVersion(snapshot: Snapshot): string {
  const lastSequence = snapshot.events.at(-1)?.sequence ?? 0;
  return [
    snapshot.phase,
    snapshot.approved ? "approved" : "unapproved",
    lastSequence,
    executionActivityVersion(snapshot.executions),
    executionActivityVersion(snapshot.mergers),
    snapshot.publication?.status ?? "",
  ].join("|");
}

/** Track unread activity per run without treating a background run as the viewed run. */
export function useRunIndicators(viewedSnapshot: Snapshot) {
  const [runIndicators, setRunIndicators] = useState<Record<string, RunIndicator>>({});
  const runActivityVersionsRef = useRef(new Map<string, string>());
  const viewedRunIdRef = useRef(viewedSnapshot.runId);
  viewedRunIdRef.current = viewedSnapshot.runId;

  const markSnapshotRead = useCallback((snapshot: Snapshot) => {
    if (!snapshot.runId) return;
    runActivityVersionsRef.current.set(snapshot.runId, snapshotActivityVersion(snapshot));
    const working = runHasLiveWork(snapshot.phase, snapshot);
    setRunIndicators((prev) => {
      const current = prev[snapshot.runId];
      if (current && !current.unread && current.phase === snapshot.phase && current.working === working) return prev;
      return { ...prev, [snapshot.runId]: { unread: false, phase: snapshot.phase, working } };
    });
  }, []);

  const clearRunUnread = useCallback((runId: string) => {
    setRunIndicators((prev) => {
      const current = prev[runId];
      if (!current?.unread) return prev;
      return { ...prev, [runId]: { ...current, unread: false } };
    });
  }, []);

  // Seed display status without manufacturing a snapshot activity version or
  // marking old activity unread when the first actual snapshot arrives.
  const observeRunSummary = useCallback((summary: ConversationSummary) => {
    if (!summary.runId || !summary.phase) return;
    const phase = summary.phase;
    // The summary index reports writers the phase alone cannot: a standalone
    // Merger runs while the Run stays `completed`.
    const working = runHasLiveWork(phase) || Boolean(summary.hasActiveExecutions);
    setRunIndicators(previous => {
      const current = previous[summary.runId];
      if (current?.phase === phase && current.working === working) return previous;
      return { ...previous, [summary.runId]: { unread: current?.unread ?? false, phase, working } };
    });
  }, []);

  const observeRunSnapshot = useCallback((snapshot: Snapshot) => {
    if (!snapshot.runId) return;
    const nextVersion = snapshotActivityVersion(snapshot);
    const previousVersion = runActivityVersionsRef.current.get(snapshot.runId);
    runActivityVersionsRef.current.set(snapshot.runId, nextVersion);
    const isViewed = viewedRunIdRef.current === snapshot.runId;
    const working = runHasLiveWork(snapshot.phase, snapshot);

    setRunIndicators((prev) => {
      const current = prev[snapshot.runId];
      const hasNewContent = previousVersion !== undefined && previousVersion !== nextVersion;
      const unread = isViewed ? false : Boolean(current?.unread || hasNewContent);
      if (current?.unread === unread && current.phase === snapshot.phase && current.working === working) return prev;
      return { ...prev, [snapshot.runId]: { unread, phase: snapshot.phase, working } };
    });
  }, []);

  useEffect(() => {
    markSnapshotRead(viewedSnapshot);
  }, [viewedSnapshot, markSnapshotRead]);

  return { runIndicators, markSnapshotRead, clearRunUnread, observeRunSnapshot, observeRunSummary };
}
