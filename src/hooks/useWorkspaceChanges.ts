import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runtimeService } from "../services/runtime";
import { startVisibilityPolling, type PollingController } from "../services/visibilityPolling";
import type { Execution, FileChangeSummary, Snapshot } from "../types";
import {
  cacheFileChangeSummary,
  emptyFileChangeSummary,
  getCachedFileChangeSummary,
  invalidateFileDiffCache,
} from "../services/fileChanges";

export interface UseWorkspaceChangesOptions {
  state: Snapshot;
  /**
   * Node/Merger conversation scope: only these executions' changes. `null`
   * means no scope (the main view uses the run-level projection). An empty
   * array is still a real scope: a waiting node that has no execution yet must
   * show no changes rather than every node's run aggregate.
   */
  scopedExecutions?: Execution[] | null;
  isWorking?: boolean;
}

export interface WorkspaceChangesViewModel {
  summary: FileChangeSummary;
  /** False until this scope has an authoritative summary. */
  isLoaded: boolean;
  isRefreshing: boolean;
  refreshVersion: number;
  refresh: () => void;
}

const REFRESH_INTERVAL_MS = 2_000;

function sameStringList(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Polling often returns identical summaries; field-wise comparison avoids
 * JSON serialization overhead and prevents re-rendering the workbench every 2s. */
function sameSummary(a: FileChangeSummary, b: FileChangeSummary): boolean {
  if (a === b) return true;
  if (
    a.totalFiles !== b.totalFiles ||
    a.addedCount !== b.addedCount ||
    a.modifiedCount !== b.modifiedCount ||
    a.deletedCount !== b.deletedCount ||
    a.renamedCount !== b.renamedCount ||
    a.totalAdditions !== b.totalAdditions ||
    a.totalDeletions !== b.totalDeletions ||
    Boolean(a.isRunning) !== Boolean(b.isRunning) ||
    a.activeFilePath !== b.activeFilePath ||
    a.files.length !== b.files.length
  ) {
    return false;
  }
  for (let i = 0; i < a.files.length; i++) {
    const left = a.files[i];
    const right = b.files[i];
    if (
      left.path !== right.path ||
      left.oldPath !== right.oldPath ||
      left.status !== right.status ||
      left.additions !== right.additions ||
      left.deletions !== right.deletions ||
      Boolean(left.isRunning) !== Boolean(right.isRunning) ||
      left.source !== right.source ||
      !sameStringList(left.nodes, right.nodes) ||
      !sameStringList(left.executionIds, right.executionIds)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * File changes are authoritative only in the backend summary: Git compares the
 * real snapshots, while tool-transcript parsing is an approximation (it misses
 * bash edits, truncated arguments and post-run direct writes). This hook never
 * counts lines itself; it only merges what the backend projected.
 *
 * The snapshot omits the change list (a build-heavy Run can hold tens of
 * thousands of paths), so the hook fetches it on demand through
 * `get_file_changes`.
 */
export function useWorkspaceChanges({
  state,
  scopedExecutions = null,
  isWorking = false,
}: UseWorkspaceChangesOptions): WorkspaceChangesViewModel {
  const runId = state.runId;
  const scoped = scopedExecutions !== null;
  const scopedIds = scoped ? scopedExecutions.map((execution) => execution.id) : null;
  const scopeKey = scopedIds === null ? `${runId}\0*` : `${runId}\0${scopedIds.join("\0")}`;
  // No executions means there cannot be any execution-scoped changes.
  const emptyScope = scopedIds !== null && scopedIds.length === 0;
  const [fetched, setFetched] = useState<{ key: string; summary: FileChangeSummary } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const forceRefreshRef = useRef(false);
  const poller = useRef<PollingController | null>(null);
  const snapshotSequence = state.events.at(-1)?.sequence ?? 0;

  useEffect(() => {
    setIsRefreshing(false);
    forceRefreshRef.current = false;
    if (!runId || runId.startsWith("pending-")) { setFetched(null); return; }
    if (emptyScope) return;
    const abort = new AbortController();
    let nextReadAt = 0;
    const load = async (): Promise<number | null> => {
      const forced = forceRefreshRef.current;
      // Snapshot notifications coalesce with the live timer; frequent tool or
      // metrics updates must not turn into an unbounded stream of Git scans.
      if (!forced && Date.now() < nextReadAt) return nextReadAt - Date.now();
      forceRefreshRef.current = false;
      try {
        const result = await runtimeService.getFileChanges(runId, scopedIds ?? undefined, abort.signal);
        if (abort.signal.aborted) return null;
        cacheFileChangeSummary(scopeKey, runId, result.summary);
        setFetched(previous => !previous || previous.key !== scopeKey
          ? { key: scopeKey, summary: result.summary }
          : sameSummary(previous.summary, result.summary)
            ? previous
            : { key: scopeKey, summary: result.summary });
        if (forced) setIsRefreshing(false);
        nextReadAt = Date.now() + REFRESH_INTERVAL_MS;
        return isWorking ? REFRESH_INTERVAL_MS : Infinity;
      } catch {
        if (abort.signal.aborted) return null;
        if (forced) setIsRefreshing(false);
        // A failed read is not an authoritative empty change list. Retain the
        // last projection and retry, including after a terminal snapshot.
        nextReadAt = Date.now() + REFRESH_INTERVAL_MS;
        return REFRESH_INTERVAL_MS;
      }
    };
    const polling = startVisibilityPolling(load);
    poller.current = polling;
    return () => {
      polling();
      abort.abort();
      if (poller.current === polling) poller.current = null;
    };
    // scopeKey contains the immutable execution-id list, not its array identity.
  }, [runId, scopeKey, emptyScope, isWorking]);

  useEffect(() => { poller.current?.wake(); }, [snapshotSequence]);

  const refresh = useCallback(() => {
    invalidateFileDiffCache(runId || undefined);
    setRefreshVersion(version => version + 1);
    if (!runId || runId.startsWith("pending-") || emptyScope) return;
    forceRefreshRef.current = true;
    setIsRefreshing(true);
    poller.current?.wake();
  }, [runId, emptyScope]);

  return useMemo(() => {
    const cachedSummary = !emptyScope ? getCachedFileChangeSummary(scopeKey) : undefined;
    const effectiveSummary = !emptyScope && fetched && fetched.key === scopeKey ? fetched.summary : cachedSummary;
    const summary = effectiveSummary ?? emptyFileChangeSummary;

    return {
      summary,
      isLoaded: !runId || runId.startsWith("pending-") || emptyScope || effectiveSummary !== undefined,
      isRefreshing,
      refreshVersion,
      refresh,
    };
  }, [
    emptyScope,
    fetched,
    isRefreshing,
    refresh,
    refreshVersion,
    runId,
    scopeKey,
  ]);
}
