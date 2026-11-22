import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationSummary, Execution, Snapshot } from "../types";
import { runHasLiveWork } from "../lib/runPhase";

export interface RunIndicator {
  unread: boolean;
  phase: string;
  /** The Run owns work in flight; a settled phase does not by itself mean idle. */
  working: boolean;
}

interface InternalRunIndicator extends RunIndicator {
  durableWorking: boolean;
}

function executionActivityVersion(executions: Execution[] = []): string {
  return executions.map((execution) =>
    `${execution.id}:${execution.status}:${execution.outputBytes ?? 0}`
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

/** Track live activity per run without treating a background run as the viewed run. */
export function useRunIndicators(viewedSnapshot: Snapshot) {
  const [runIndicators, setRunIndicators] = useState<Record<string, InternalRunIndicator>>({});
  const runActivityVersionsRef = useRef(new Map<string, string>());
  const localWorkTokensRef = useRef(new Map<unknown, string>());
  const viewedRunIdRef = useRef(viewedSnapshot.runId);
  viewedRunIdRef.current = viewedSnapshot.runId;

  const hasLocalWork = useCallback((runId: string) => {
    for (const id of localWorkTokensRef.current.values()) {
      if (id === runId) return true;
    }
    return false;
  }, []);

  const beginLocalWork = useCallback((token: unknown, runId: string) => {
    if (!runId) return;
    const previousRunId = localWorkTokensRef.current.get(token);
    localWorkTokensRef.current.set(token, runId);
    setRunIndicators((prev) => {
      let next = prev;
      if (previousRunId && previousRunId !== runId) {
        const prevEntry = prev[previousRunId];
        if (prevEntry) {
          const prevWorking = prevEntry.durableWorking || hasLocalWork(previousRunId);
          if (prevEntry.working !== prevWorking) {
            next = { ...next, [previousRunId]: { ...prevEntry, working: prevWorking } };
          }
        }
      }
      const current = next[runId];
      if (current?.working) return next;
      return {
        ...next,
        [runId]: current
          ? { ...current, working: true }
          : { unread: false, phase: "planning", durableWorking: false, working: true },
      };
    });
  }, [hasLocalWork]);

  const endLocalWork = useCallback((token: unknown) => {
    const runId = localWorkTokensRef.current.get(token);
    if (!runId) return;
    localWorkTokensRef.current.delete(token);
    const stillLocal = hasLocalWork(runId);
    setRunIndicators((prev) => {
      const current = prev[runId];
      if (!current) return prev;
      const working = current.durableWorking || stillLocal;
      if (current.working === working) return prev;
      return { ...prev, [runId]: { ...current, working } };
    });
  }, [hasLocalWork]);

  const transferLocalWork = useCallback((oldRunId: string, newRunId: string) => {
    if (!oldRunId || !newRunId || oldRunId === newRunId) return;
    let moved = false;
    for (const [token, id] of localWorkTokensRef.current.entries()) {
      if (id === oldRunId) {
        localWorkTokensRef.current.set(token, newRunId);
        moved = true;
      }
    }
    const oldVersion = runActivityVersionsRef.current.get(oldRunId);
    if (oldVersion !== undefined) {
      runActivityVersionsRef.current.delete(oldRunId);
      if (!runActivityVersionsRef.current.has(newRunId)) {
        runActivityVersionsRef.current.set(newRunId, oldVersion);
      }
    }
    setRunIndicators((prev) => {
      const oldEntry = prev[oldRunId];
      if (!oldEntry && !moved) return prev;
      const next = { ...prev };
      delete next[oldRunId];
      const existing = next[newRunId];
      const durableWorking = existing?.durableWorking ?? oldEntry?.durableWorking ?? false;
      const working = durableWorking || hasLocalWork(newRunId);
      next[newRunId] = existing
        ? { ...existing, durableWorking, working }
        : { unread: false, phase: oldEntry?.phase ?? "planning", durableWorking, working };
      return next;
    });
  }, [hasLocalWork]);

  const markSnapshotRead = useCallback((snapshot: Snapshot) => {
    if (!snapshot.runId) return;
    runActivityVersionsRef.current.set(snapshot.runId, snapshotActivityVersion(snapshot));
    const durableWorking = runHasLiveWork(snapshot.phase, snapshot);
    const working = durableWorking || hasLocalWork(snapshot.runId);
    setRunIndicators((prev) => {
      const current = prev[snapshot.runId];
      if (current && !current.unread && current.phase === snapshot.phase &&
          current.durableWorking === durableWorking && current.working === working) return prev;
      return { ...prev, [snapshot.runId]: { unread: false, phase: snapshot.phase, durableWorking, working } };
    });
  }, [hasLocalWork]);

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
    const durableWorking = runHasLiveWork(phase) || Boolean(summary.hasActiveExecutions);
    const working = durableWorking || hasLocalWork(summary.runId);
    setRunIndicators(previous => {
      const current = previous[summary.runId];
      if (current?.phase === phase && current.durableWorking === durableWorking && current.working === working) return previous;
      return { ...previous, [summary.runId]: { unread: current?.unread ?? false, phase, durableWorking, working } };
    });
  }, [hasLocalWork]);

  const observeRunSnapshot = useCallback((snapshot: Snapshot) => {
    if (!snapshot.runId) return;
    const nextVersion = snapshotActivityVersion(snapshot);
    const previousVersion = runActivityVersionsRef.current.get(snapshot.runId);
    runActivityVersionsRef.current.set(snapshot.runId, nextVersion);
    const isViewed = viewedRunIdRef.current === snapshot.runId;
    const durableWorking = runHasLiveWork(snapshot.phase, snapshot);
    const working = durableWorking || hasLocalWork(snapshot.runId);

    setRunIndicators((prev) => {
      const current = prev[snapshot.runId];
      const hasNewContent = previousVersion !== undefined && previousVersion !== nextVersion;
      const unread = isViewed ? false : Boolean(current?.unread || hasNewContent);
      if (current?.unread === unread && current.phase === snapshot.phase &&
          current.durableWorking === durableWorking && current.working === working) return prev;
      return { ...prev, [snapshot.runId]: { unread, phase: snapshot.phase, durableWorking, working } };
    });
  }, [hasLocalWork]);

  useEffect(() => {
    markSnapshotRead(viewedSnapshot);
  }, [viewedSnapshot, markSnapshotRead]);

  return {
    runIndicators,
    markSnapshotRead,
    clearRunUnread,
    observeRunSnapshot,
    observeRunSummary,
    beginLocalWork,
    endLocalWork,
    transferLocalWork,
  };
}
