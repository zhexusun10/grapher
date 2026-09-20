import type { Snapshot, PlanRouteType } from "../types";

export function deduceRouteType(snap: Snapshot): PlanRouteType {
  if (snap.planType) return snap.planType;
  // Legacy event stores did not persist the route.
  if (snap.graph.nodes.length > 1) return "graph";
  if (snap.graph.nodes.length === 1 && snap.graph.nodes[0].name === "task") return "serial";
  if (snap.graph.nodes.length === 1) return "graph";
  return "undecided";
}
