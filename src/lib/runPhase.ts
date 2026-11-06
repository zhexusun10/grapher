import type { Snapshot } from "../types";

/**
 * Run phases whose own progress is enough to call the Run live: a Planner turn,
 * executing nodes, the approval gate, publication, and the native launch step.
 *
 * `followup`, `paused` and `needs_attention` are deliberately absent. A
 * source-direct edit leaves the Run in `followup` once it settles, so that phase
 * alone says nothing about work in flight; live writers cover it instead.
 */
const livePhaseNames = new Set([
  "planning",
  "running",
  "awaiting_approval",
  "publishing",
  "merging",
  "launching_result",
]);

type WorkSnapshot = Pick<Snapshot, "executions" | "mergers" | "nodes">;

/** A Run can leave its phase settled while work is still in flight: a standalone
 * publication Merger keeps `completed` and source-direct work keeps `followup`
 * (see the runtime contract in `docs/architecture/runtime.md`). Counting live
 * writers keeps the sidebar card honest instead of trusting the phase alone. */
export function runHasLiveWork(phase: string, snapshot?: WorkSnapshot | null): boolean {
  if (livePhaseNames.has(phase)) return true;
  if (!snapshot) return false;
  return (snapshot.executions ?? []).some(item => item.status === "running")
    || (snapshot.mergers ?? []).some(item => item.status === "running")
    || Object.values(snapshot.nodes ?? {}).some(item => item.status === "running" || item.status === "dirty");
}
