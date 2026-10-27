import type { PlanningSummary, Snapshot } from "../types";
import { workspaceKey } from "./workspaceConversations";

export function hasCurrentPlanningRun(snapshot: Snapshot, repository: string) {
  if (!snapshot.runId || !snapshot.config?.repository || !repository) return false;
  return (
    workspaceKey(snapshot.config.repository) === workspaceKey(repository) &&
    [
      "planning",
      "planning_failed",
      "awaiting_approval",
      "running",
      "paused",
      "needs_attention",
      "completed",
      "publishing",
      "merging",
    ].includes(snapshot.phase)
  );
}

export function planningRecoveryDelay(planningId: string | undefined, idleAttempts: number) {
  return planningId ? 1500 : idleAttempts === 0 ? 15000 : 30000;
}

/** The snapshot's persisted running Planner is only a display recovery while no
 * live turn owns the browser stream. A new turn (or a final status) must retire
 * it; otherwise its ID keeps the whole conversation marked as running.
 *
 * `undefined` means "keep the current recovery": a durable `list_plannings`
 * poll can discover a running turn whose run snapshot has no planning summary
 * yet, and erasing that discovery would stop its transcript from mounting. */
export function recoveredPlanningForDisplay(
  planning: PlanningSummary | null | undefined,
  recovered: PlanningSummary | null,
  live: boolean,
  busy: boolean,
): PlanningSummary | null | undefined {
  if (!planning) return live ? null : undefined;
  const same = recovered?.planningId === planning.planningId;
  // A run switch can briefly pair a poll-discovered newer turn with the
  // previous run's terminal summary. Do not let the older snapshot erase it.
  if (recovered && !same && (planning.createdAt ?? 0) <= (recovered.createdAt ?? 0)) return undefined;
  if (planning.status !== "running") return null;
  // A live stream owns the turn; retire the display-only recovery instead of
  // letting its ID keep the conversation marked as running.
  if (live) return null;
  // A request is already in flight: keep an existing recovery instead of
  // clearing (unmount flash) or adopting a new one mid-request.
  if (busy) return same ? planning : undefined;
  return planning;
}

type Scope = { repository?: string; generation: number };
type Service = {
  listPlannings(repository?: string): Promise<PlanningSummary[]>;
  getPlanning(id: string): Promise<PlanningSummary>;
};

// One owner for restoration and live terminal results. Invalidate synchronously,
// before a picker, repository lookup, or new planning request can yield.
export function createPlanningRecovery(service: Service, publish: (summary: PlanningSummary | null) => void) {
  let generation = 0;
  let request = 0;
  const current = (scope: Scope) => scope.generation === generation;
  const begin = (repository?: string): Scope => {
    generation++;
    request++;
    publish(null);
    return { repository, generation };
  };
  return {
    begin,
    capture: (repository?: string): Scope => ({ repository, generation }),
    current,
    async restore(scope: Scope, snapshot?: Snapshot) {
      if (!current(scope) || !scope.repository) return;
      const ticket = ++request;
      try {
        const summaries = await service.listPlannings(scope.repository);
        if (!current(scope) || ticket !== request) return;
        const latest = summaries[0];
        const runTime = snapshot?.planning?.createdAt || 0;
        publish(latest && latest.repository === scope.repository &&
          (latest.status === "failed" || !!latest.error) &&
          (!snapshot?.runId || !snapshot.planning || (latest.createdAt || 0) >= runTime)
          ? latest : null);
      } catch {
        if (current(scope) && ticket === request) publish(null);
      }
    },
    async finish(scope: Scope, summary?: PlanningSummary, planningId?: string) {
      if (!current(scope)) return;
      const ticket = ++request;
      publish(null);
      const id = planningId || summary?.planningId;
      try {
        const result = summary || (id ? await service.getPlanning(id) : null);
        if (!current(scope) || ticket !== request) return;
        if (result && result.repository === scope.repository && result.planningId === id &&
          (result.status === "failed" || !!result.error)) publish(result);
      } catch {
        // The request error remains visible; missing history must not restore stale data.
      }
    },
  };
}
