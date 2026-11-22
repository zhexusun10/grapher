import type { Snapshot } from "../types";

/**
 * Run phases whose own progress is enough to call the Run live: a Planner turn,
 * executing nodes, publication, and the native launch step.
 *
 * `awaiting_approval`, `followup`, `paused` and `needs_attention` are
 * deliberately absent. Waiting for user approval is idle until approved, and a
 * source-direct edit leaves the Run in `followup` once it settles, so those
 * phases alone say nothing about work in flight; live writers cover them.
 */
const livePhaseNames = new Set([
  "planning",
  "running",
  "publishing",
  "merging",
  "launching_result",
]);

type WorkSnapshot = Partial<Pick<Snapshot, "planType" | "executions" | "mergers" | "nodes" | "resultExecution" | "planning">>;

/** `dirty` is an invalidated result waiting for dispatch, not a live writer. */
export function runHasActiveExecutions(snapshot?: WorkSnapshot | null): boolean {
  if (!snapshot) return false;
  return (snapshot.executions ?? []).some(item => item.status === "running")
    || (snapshot.mergers ?? []).some(item => item.status === "running")
    || Object.values(snapshot.nodes ?? {}).some(item => item.status === "running")
    || snapshot.resultExecution?.status === "running";
}

/** A Run can leave its phase settled while work is still in flight: a standalone
 * publication Merger keeps `completed`, a Planner revision keeps its prior
 * phase while `planning.status === "running"`, and source-direct work keeps
 * `followup` (see the runtime contract in `docs/architecture/runtime.md`).
 * Conversely, a Serial Run commits `Finished`/`Failed` on its sole node slightly
 * before `Settled` flips `phase` out of `running`; checking settled nodes lets
 * the indicator retire on the same frame the conversation finishes. */
export function runHasLiveWork(phase: string, snapshot?: WorkSnapshot | null): boolean {
  if (snapshot?.planning?.status === "running") return true;
  if (runHasActiveExecutions(snapshot)) return true;
  if (phase === "running" && snapshot?.planType === "serial") {
    const nodes = Object.values(snapshot.nodes ?? {});
    if (nodes.length > 0 && nodes.every(node =>
      node.status !== "running" && node.status !== "dirty" && node.status !== "waiting"
    )) {
      return false;
    }
  }
  return livePhaseNames.has(phase);
}
