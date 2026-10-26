import { useEffect, useMemo, useRef, useState } from "react";
import { runtimeService } from "../services/runtime";
import { startVisibilityPolling, type PollingController } from "../services/visibilityPolling";
import type { Execution, FileChangeSummary, Snapshot } from "../types";
import {
  emptyFileChangeSummary,
  mergeFileChangeSummaries,
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
  availableNodes: string[];
  activeExecutionId?: string;
}

const EMPTY_NODES: string[] = [];
const REFRESH_INTERVAL_MS = 2_000;

/**
 * File changes are authoritative only in the backend summary: Git compares the
 * real snapshots, while tool-transcript parsing is an approximation (it misses
 * bash edits, truncated arguments and post-run direct writes). This hook never
 * counts lines itself; it only merges what the backend projected.
 *
 * The snapshot omits the change list (a build-heavy Run can hold tens of
 * thousands of paths), so the hook fetches it on demand through
 * `get_file_changes` and leaves the inline path for callers that still provide
 * `fileChanges` (fixtures and legacy backends).
 */
export function useWorkspaceChanges({
  state,
  scopedExecutions = null,
  isWorking = false,
}: UseWorkspaceChangesOptions): WorkspaceChangesViewModel {
  const runId = state.runId;
  const scoped = scopedExecutions !== null;
  const scopedIds = scoped ? scopedExecutions.map((execution) => execution.id) : null;
  const scopeKey = JSON.stringify([runId, scopedIds]);
  const inline = !state.fileChangesOmitted;
  const [fetched, setFetched] = useState<{ key: string; summary: FileChangeSummary } | null>(null);
  const poller = useRef<PollingController | null>(null);
  const snapshotSequence = state.events.at(-1)?.sequence ?? 0;

  useEffect(() => {
    if (inline || !runId) { setFetched(null); return; }
    const abort = new AbortController();
    let nextReadAt = 0;
    const load = async (): Promise<number | null> => {
      // Snapshot notifications coalesce with the live timer; frequent tool or
      // metrics updates must not turn into an unbounded stream of Git scans.
      if (Date.now() < nextReadAt) return nextReadAt - Date.now();
      try {
        const result = await runtimeService.getFileChanges(runId, scopedIds ?? undefined, abort.signal);
        if (abort.signal.aborted) return null;
        setFetched({ key: scopeKey, summary: result.summary });
        nextReadAt = Date.now() + REFRESH_INTERVAL_MS;
        return isWorking ? REFRESH_INTERVAL_MS : Infinity;
      } catch {
        if (abort.signal.aborted) return null;
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
  }, [inline, runId, scopeKey, isWorking]);

  useEffect(() => { poller.current?.wake(); }, [snapshotSequence]);

  return useMemo(() => {
    const superseded = new Set(state.supersededExecutionIds ?? []);
    const executions = scoped
      ? scopedExecutions
      : [...(state.executions ?? []), ...(state.mergers ?? [])].filter(
          (execution) => !superseded.has(execution.id),
        );
    const activeExecutionId = executions.find((execution) => execution.status === "running")?.id;

    let summary: FileChangeSummary;
    if (!inline) {
      summary = fetched && fetched.key === scopeKey ? fetched.summary : emptyFileChangeSummary;
    } else {
      const parts: FileChangeSummary[] = [];
      for (const execution of executions) {
        if (execution.fileChanges) parts.push(execution.fileChanges);
      }
      // The run-level projection already merges every execution, Planner writes
      // and publication; adding it next to per-execution summaries would count
      // the same tool edits twice.
      const runSummary = scoped ? null : state.fileChanges;
      if (runSummary) {
        parts.length = 0;
        parts.push(runSummary);
      }

      const anyRunning = isWorking || executions.some((execution) => execution.status === "running");
      summary = parts.length > 0
        ? mergeFileChangeSummaries(parts, anyRunning)
        : emptyFileChangeSummary;
    }

    const nodes = new Set<string>();
    for (const file of summary.files) {
      for (const node of file.nodes ?? []) {
        if (node) nodes.add(node);
      }
    }

    return {
      summary,
      availableNodes: nodes.size > 0 ? Array.from(nodes) : EMPTY_NODES,
      activeExecutionId,
    };
  }, [
    inline,
    fetched,
    scopeKey,
    state.fileChanges,
    state.executions,
    state.mergers,
    state.supersededExecutionIds,
    scopedExecutions,
    isWorking,
  ]);
}
