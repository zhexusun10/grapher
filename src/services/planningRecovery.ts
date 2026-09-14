import type { PlanningSummary, Snapshot } from "../types";

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
