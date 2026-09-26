import { useCallback, useEffect, useRef, useState } from "react";
import type { Execution, Snapshot } from "../types";

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
  const [runIndicators, setRunIndicators] = useState<Record<string, { unread: boolean; phase: string }>>({});
  const runActivityVersionsRef = useRef(new Map<string, string>());
  const viewedRunIdRef = useRef(viewedSnapshot.runId);
  viewedRunIdRef.current = viewedSnapshot.runId;

  const markSnapshotRead = useCallback((snapshot: Snapshot) => {
    if (!snapshot.runId) return;
    runActivityVersionsRef.current.set(snapshot.runId, snapshotActivityVersion(snapshot));
    setRunIndicators((prev) => {
      const current = prev[snapshot.runId];
      if (current && !current.unread && current.phase === snapshot.phase) return prev;
      return { ...prev, [snapshot.runId]: { unread: false, phase: snapshot.phase } };
    });
  }, []);

  const clearRunUnread = useCallback((runId: string) => {
    setRunIndicators((prev) => {
      const current = prev[runId];
      if (!current?.unread) return prev;
      return { ...prev, [runId]: { ...current, unread: false } };
    });
  }, []);

  const observeRunSnapshot = useCallback((snapshot: Snapshot) => {
    if (!snapshot.runId) return;
    const nextVersion = snapshotActivityVersion(snapshot);
    const previousVersion = runActivityVersionsRef.current.get(snapshot.runId);
    runActivityVersionsRef.current.set(snapshot.runId, nextVersion);
    const isViewed = viewedRunIdRef.current === snapshot.runId;

    setRunIndicators((prev) => {
      const current = prev[snapshot.runId];
      const hasNewContent = previousVersion !== undefined && previousVersion !== nextVersion;
      const unread = isViewed ? false : Boolean(current?.unread || hasNewContent);
      if (current?.unread === unread && current.phase === snapshot.phase) return prev;
      return { ...prev, [snapshot.runId]: { unread, phase: snapshot.phase } };
    });
  }, []);

  useEffect(() => {
    markSnapshotRead(viewedSnapshot);
  }, [viewedSnapshot, markSnapshotRead]);

  return { runIndicators, markSnapshotRead, clearRunUnread, observeRunSnapshot };
}
