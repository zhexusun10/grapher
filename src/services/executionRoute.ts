import type { Snapshot, PlanRouteType, PlanMode } from "../types";

export function deduceRouteType(snap: Snapshot): PlanRouteType {
  if (snap.planType) return snap.planType;
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
    planning?: { roles?: { partition?: { durationSeconds?: number; usage?: { input?: number; output?: number } } } | null } | null;
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

  // 5. If routeType is undecided or state.planType is undefined, it's auto mode
  if (routeType === "undecided" || state?.planType === undefined) {
    return true;
  }

  // Default: if planType is serial or graph and there is no evidence of partitioner having run, treat as manual
  return false;
}

