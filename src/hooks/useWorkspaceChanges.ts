import { useEffect, useMemo, useRef, useState } from "react";
import { runtimeService } from "../services/runtime";
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
  const scopeKey = `${runId}|${scopedIds ? scopedIds.join(",") : "run"}`;
  const inline = !state.fileChangesOmitted;
  const [fetched, setFetched] = useState<{ key: string; summary: FileChangeSummary } | null>(null);
  const scopedRef = useRef<Execution[] | null>(scopedExecutions);
  scopedRef.current = scopedExecutions;

  useEffect(() => {
    if (inline || !runId) { setFetched(null); return; }
    let cancelled = false;
    setFetched(null);
    const load = async () => {
      try {
        const parts = scoped
          ? await Promise.all((scopedRef.current ?? []).map((execution) =>
              runtimeService.getFileChanges(runId, execution.id)
                .then((result) => result.summary)
                .catch(() => null)))
          : [(await runtimeService.getFileChanges(runId)).summary];
        if (cancelled) return;
        const merged = mergeFileChangeSummaries(parts, isWorking);
        // The backend caps the transferred rows; keep its authoritative totals.
        const totalFiles = parts.reduce((sum, part) => sum + (part?.totalFiles ?? part?.files.length ?? 0), 0);
        setFetched({ key: scopeKey, summary: merged.totalFiles === totalFiles ? merged : { ...merged, totalFiles } });
      } catch {
        if (!cancelled) setFetched({ key: scopeKey, summary: emptyFileChangeSummary });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [inline, runId, scopeKey, isWorking]);

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
      const merged = parts.length > 0
        ? mergeFileChangeSummaries(parts, anyRunning)
        : emptyFileChangeSummary;
      // The backend caps the shipped file list for build-heavy Runs, so the
      // trigger must read the authoritative totals instead of the merged slice.
      const totalFiles = parts.reduce((sum, part) => sum + (part.totalFiles ?? part.files.length), 0);
      summary = merged.totalFiles === totalFiles ? merged : { ...merged, totalFiles };
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
