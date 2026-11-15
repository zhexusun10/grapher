import type { Snapshot, PlanRouteType, PlanMode } from "../types";

export function deduceRouteType(snap: Snapshot): PlanRouteType {
  if (snap.planType === "graph" || snap.planType === "serial") return snap.planType;
  // An incomplete recovery must not erase an already committed route.
  for (let index = (snap.events?.length ?? 0) - 1; index >= 0; index--) {
    const event = snap.events[index];
    if (event.type === "routed" && (event.plan_type === "graph" || event.plan_type === "serial")) return event.plan_type;
  }
  if (snap.planning?.planType === "graph" || snap.planning?.planType === "serial") return snap.planning.planType;
  // Legacy event stores did not persist the route.
  if (snap.graph.nodes.length > 1) return "graph";
  if (snap.graph.nodes.length === 1 && snap.graph.nodes[0].name === "task") return "serial";
  if (snap.graph.nodes.length === 1) return "graph";
  return "undecided";
}

export function shouldShowRouteBadge({
  initialPlanMode,
  plannerStream,
  state,
  routeType,
}: {
  initialPlanMode?: PlanMode;
  plannerStream?: { initialPlanMode?: PlanMode; stage?: string; partitionerText?: string; partitionerThinking?: string };
  state?: {
    events?: Array<{ type: string; plan_type?: string; planType?: string }>;
    planning?: { planType?: string; roles?: { partition?: { durationSeconds?: number; usage?: { input?: number; output?: number } } } | null } | null;
    planType?: string;
  };
  routeType?: PlanRouteType;
}): boolean {
  // 1. Explicitly recorded initial plan mode for this run
  if (initialPlanMode) {
    return initialPlanMode === "auto";
  }

  // 2. Active stream mode or streaming partitioner content
  if (plannerStream?.initialPlanMode) {
    return plannerStream.initialPlanMode === "auto";
  }
  if (plannerStream?.stage === "partitioning" || Boolean(plannerStream?.partitionerText || plannerStream?.partitionerThinking)) {
    return true;
  }

  // 3. Inspect planning_started event in snapshot events
  const planningStarted = state?.events?.find((e) => e.type === "planning_started");
  if (planningStarted) {
    if (
      planningStarted.plan_type === "serial" ||
      planningStarted.plan_type === "graph" ||
      planningStarted.planType === "serial" ||
      planningStarted.planType === "graph"
    ) {
      return false;
    }
    return true;
  }

  // 4. Inspect planning roles partition metrics
  const partitionRole = state?.planning?.roles?.partition;
  if (partitionRole) {
    if (
      (partitionRole.durationSeconds && partitionRole.durationSeconds > 0) ||
      (partitionRole.usage && ((partitionRole.usage.input ?? 0) > 0 || (partitionRole.usage.output ?? 0) > 0))
    ) {
      return true;
    }
  }

  // Missing metadata is not evidence of an active Partitioner. Only an
  // explicitly pending route may display evaluation without other evidence.
  return routeType === "undecided" &&
    (state?.planType === "undecided" || state?.planning?.planType === "undecided");
}

