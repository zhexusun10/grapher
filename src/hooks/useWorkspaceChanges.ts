import { useMemo } from "react";
import type { Execution, FileChangeSummary, Snapshot } from "../types";
import {
  emptyFileChangeSummary,
  mergeFileChangeSummaries,
} from "../services/fileChanges";

export interface UseWorkspaceChangesOptions {
  state: Snapshot;
  /** Node/Merger conversation scope: only these executions' changes. */
  scopedExecutions?: Execution[];
  isWorking?: boolean;
}

export interface WorkspaceChangesViewModel {
  summary: FileChangeSummary;
  availableNodes: string[];
  activeExecutionId?: string;
}

const EMPTY_NODES: string[] = [];
const EMPTY_EXECUTIONS: Execution[] = [];

/**
 * File changes are authoritative only in the backend summary: Git compares the
 * real snapshots, while tool-transcript parsing is an approximation (it misses
 * bash edits, truncated arguments and post-run direct writes). This hook never
 * counts lines itself; it only merges what the backend projected.
 */
export function useWorkspaceChanges({
  state,
  scopedExecutions = EMPTY_EXECUTIONS,
  isWorking = false,
}: UseWorkspaceChangesOptions): WorkspaceChangesViewModel {
  return useMemo(() => {
    const superseded = new Set(state.supersededExecutionIds ?? []);
    const scoped = scopedExecutions.length > 0;
    const executions = scoped
      ? scopedExecutions
      : [...(state.executions ?? []), ...(state.mergers ?? [])].filter(
          (execution) => !superseded.has(execution.id),
        );

    const parts: FileChangeSummary[] = [];
    let activeExecutionId: string | undefined;
    for (const execution of executions) {
      if (execution.status === "running" && !activeExecutionId) activeExecutionId = execution.id;
      if (execution.fileChanges) parts.push(execution.fileChanges);
    }
    // The run-level projection already merges every execution, Planner writes
    // and publication; adding it next to per-execution summaries would count
    // the same tool edits twice.
    const runSummary = !scoped ? state.fileChanges : null;
    if (runSummary) {
      parts.length = 0;
      parts.push(runSummary);
    }

    const anyRunning = isWorking || executions.some((execution) => execution.status === "running");
    const summary = parts.length > 0
      ? mergeFileChangeSummaries(parts, anyRunning)
      : emptyFileChangeSummary;

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
    state.runId,
    state.executions,
    state.mergers,
    state.supersededExecutionIds,
    state.fileChanges,
    scopedExecutions,
    isWorking,
  ]);
}
