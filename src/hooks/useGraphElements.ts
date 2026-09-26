import { useMemo } from "react";
import type { Edge } from "@xyflow/react";
import type { Graph, Plan, Snapshot } from "../types";
import { tokens } from "../tokens";
import type { WorkNode } from "../components/graph/TaskNode";

export function graphEdgeId(edge: Pick<Graph["edges"][number], "from" | "to" | "feedback">): string {
  return JSON.stringify([edge.from, edge.feedback ? "fb" : "dep", edge.to]);
}

export function indexGraphInputs(graph: Graph, executions: Snapshot["executions"]) {
  const incoming = new Map<string, Graph["edges"]>();
  const outgoing = new Map<string, Graph["edges"]>();
  const hints = new Map<string, Graph["edges"]>();
  const attempts = new Map<string, Snapshot["executions"]>();
  const add = <T,>(map: Map<string, T[]>, key: string, value: T) => {
    const items = map.get(key);
    if (items) items.push(value); else map.set(key, [value]);
  };
  for (const edge of graph.edges) {
    add(incoming, edge.to, edge);
    add(outgoing, edge.from, edge);
    add(hints, edge.to, edge);
    if (edge.feedback && edge.from !== edge.to) add(hints, edge.from, edge);
  }
  for (const execution of executions) add(attempts, execution.node, execution);
  return { incoming, outgoing, hints, attempts };
}

export function computeExecutionLayers(graph: Graph, plan?: Plan | null): string[][] {
  if (plan?.executionBatches && plan.executionBatches.length > 0) {
    const scheduled = new Set(plan.executionBatches.flat());
    const missing = graph.nodes.map((node) => node.name).filter((name) => !scheduled.has(name));
    return missing.length ? [...plan.executionBatches, missing] : plan.executionBatches;
  }
  const nodeNames = graph.nodes.map((n) => n.name);
  if (nodeNames.length === 0) return [];
  const names = new Set(nodeNames);
  const deps = graph.edges.filter(
    (e) => !e.feedback && names.has(e.from) && names.has(e.to)
  );
  const children = new Map<string, string[]>();
  for (const edge of deps) {
    const targets = children.get(edge.from);
    if (targets) targets.push(edge.to); else children.set(edge.from, [edge.to]);
  }
  const inDegree = new Map<string, number>(nodeNames.map((n) => [n, 0]));
  for (const edge of deps) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  let ready = nodeNames.filter((n) => inDegree.get(n) === 0);
  const visited = new Set<string>();
  const batches: string[][] = [];
  while (ready.length > 0) {
    batches.push(ready);
    const next: string[] = [];
    for (const name of ready) {
      visited.add(name);
      for (const target of children.get(name) ?? []) {
        const deg = (inDegree.get(target) ?? 1) - 1;
        inDegree.set(target, deg);
        if (deg === 0) next.push(target);
      }
    }
    ready = next;
  }
  const remaining = nodeNames.filter((n) => !visited.has(n));
  if (remaining.length > 0) batches.push(remaining);
  return batches.length > 0 ? batches : [nodeNames];
}

/** Derive topology from the snapshot only when its graph/execution inputs change. */
export function useGraphElements(state: Snapshot, selected: string, recentlyAddedEdgeIds: Set<string>) {
  // Keep the same geometry for nodes and edges. Wider rows leave room for
  // edge channels; taller layers keep adjacent-layer paths below the cards.
  const graphLayout = useMemo(() => {
    const layers = computeExecutionLayers(state.graph, state.plan);
    const hasMergers = (state.mergers ?? []).some((m) => m.node.startsWith("merge:"));
    const positions = new Map<string, { x: number; y: number; layer: number }>();
    layers.forEach((batch, layer) => batch.forEach((name, index) => {
      positions.set(name, {
        x: (index - (batch.length - 1) / 2) * 300 + 160,
        y: layer * (hasMergers ? 320 : 210) + 24,
        layer,
      });
    }));
    const xs = Array.from(positions.values(), (position) => position.x);
    return { positions, minX: Math.min(...xs, 160), maxX: Math.max(...xs, 160) + 236 };
  }, [state.graph, state.plan, state.mergers]);

  const mergeTargets = useMemo(() => {
    const targets = new Map<string, NonNullable<Snapshot["mergers"]>[number]>();
    const names = new Set(state.graph.nodes.map((node) => node.name));
    for (const merger of state.mergers ?? []) {
      const target = merger.node.startsWith("merge:") ? merger.node.slice(6) : "";
      if (target && names.has(target)) targets.set(target, merger);
    }
    return targets;
  }, [state.mergers, state.graph.nodes]);
  // Reuse the card's existing top/bottom/side ports. Route only long edges
  // around intermediate rows; never insert a new port or an off-card junction.
  const edgeRouting = useMemo(() => {
    const rowBounds = new Map<number, { min: number; max: number }>();
    for (const position of graphLayout.positions.values()) {
      const row = rowBounds.get(position.layer);
      if (row) {
        row.min = Math.min(row.min, position.x);
        row.max = Math.max(row.max, position.x);
      } else rowBounds.set(position.layer, { min: position.x, max: position.x });
    }
    const laneCount = { left: 0, right: 0 };
    const center = (graphLayout.minX + graphLayout.maxX) / 2;
    return new Map<string, { sourceHandle: string; targetHandle: string; routeX?: number; routeSide?: string }>(state.graph.edges.map((edge) => {
      const from = graphLayout.positions.get(edge.from);
      const to = graphLayout.positions.get(edge.to);
      const side = from && to && (from.x + to.x + 236) / 2 > center ? "right" : "left";
      const boundary = side === "left" ? "min" : "max";
      const sideRoute = !!edge.feedback && !!from && !!to &&
        from.x === rowBounds.get(from.layer)?.[boundary] &&
        to.x === rowBounds.get(to.layer)?.[boundary];
      const routed = !!edge.feedback || (!!from && !!to && to.layer - from.layer > 1);
      const routeX = routed
        ? side === "left" ? graphLayout.minX - 48 - laneCount.left++ * 14
          : graphLayout.maxX + 48 + laneCount.right++ * 14
        : undefined;
      return [graphEdgeId(edge), {
        sourceHandle: sideRoute ? `${side}-source` : "bottom",
        targetHandle: sideRoute ? `${side}-target` : "top",
        routeX,
        routeSide: sideRoute ? side : undefined,
      }] as const;
    }));
  }, [state.graph.edges, graphLayout]);

  const indexes = useMemo(() => indexGraphInputs(state.graph, state.executions), [state.graph, state.executions]);
  const mergerAttempts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const merger of state.mergers ?? []) counts.set(merger.node, (counts.get(merger.node) ?? 0) + 1);
    return counts;
  }, [state.mergers]);

  const nodes = useMemo<WorkNode[]>(() => {
    const taskNodes: WorkNode[] = state.graph.nodes.map((node) => {
      const position = graphLayout.positions.get(node.name) ?? { x: 160, y: 24, layer: 0 };
      const nodeAttempts = indexes.attempts.get(node.name) ?? [];
      const incoming = indexes.incoming.get(node.name) ?? [];
      const outgoing = indexes.outgoing.get(node.name) ?? [];
      const route = (edge: Graph["edges"][number]) => edgeRouting.get(graphEdgeId(edge));
      return {
        id: node.name,
        type: "work",
        width: 236,
        position: { x: position.x, y: position.y },
        data: {
          name: node.name,
          task: node.task,
          status: state.nodes[node.name]?.status ?? "waiting",
          attempts: nodeAttempts.length,
          hint: (indexes.hints.get(node.name) ?? [])
            .map((edge) => `${edge.from} → ${edge.to}: ${edge.relation}${edge.feedback ? " (feedback)" : ""}`)
            .join("\n"),
          reviewer: outgoing.some((edge) => edge.feedback),
          selected: selected === node.name,
          worktree: nodeAttempts.at(-1)?.worktree ?? "",
          hasTop: incoming.some((edge) => route(edge)?.targetHandle === "top") || mergeTargets.has(node.name),
          hasBottom: outgoing.some((edge) => route(edge)?.sourceHandle === "bottom"),
          hasLeftTarget: incoming.some((edge) => route(edge)?.targetHandle === "left-target"),
          hasLeftSource: outgoing.some((edge) => route(edge)?.sourceHandle === "left-source"),
          hasRightTarget: incoming.some((edge) => route(edge)?.targetHandle === "right-target"),
          hasRightSource: outgoing.some((edge) => route(edge)?.sourceHandle === "right-source"),
        },
      };
    });
    // A merger is an execution, not a planner node. Show one card per fan-in
    // target only after a real conflict has launched the resolver.
    const taskNodesById = new Map(taskNodes.map((node) => [node.id, node]));
    return [...taskNodes, ...Array.from(mergeTargets, ([target, merger]): WorkNode => {
      const node = taskNodesById.get(target)!;
      const attempts = mergerAttempts.get(`merge:${target}`) ?? 0;
      return {
        id: `merger:${target}`, type: "work", width: 236,
        position: { x: node.position.x, y: node.position.y - 155 },
        data: {
          name: `merger · ${target}`, task: "合并上游分支冲突",
          status: merger.status === "completed" ? "done" : merger.status === "running" ? "running" : "failed",
          attempts, hint: `合并至 ${target}`, reviewer: false, selected: false,
          worktree: merger.worktree, hasTop: true, hasBottom: true,
          hasLeftTarget: false, hasLeftSource: false, hasRightTarget: false, hasRightSource: false,
        },
      };
    })];
  }, [state.graph, state.nodes, indexes, mergerAttempts, selected, graphLayout, edgeRouting, mergeTargets]);

  const edges = useMemo<Edge[]>(() => {
    const graphEdges = state.graph.edges.map((edge) => {
      const isFeedback = !!edge.feedback;
      const edgeId = graphEdgeId(edge);
      const routing = edgeRouting.get(edgeId);
      const isNew = recentlyAddedEdgeIds.has(edgeId);
      return {
        id: edgeId,
        source: edge.from,
        target: !isFeedback && mergeTargets.has(edge.to) ? `merger:${edge.to}` : edge.to,
        type: "workflow",
        sourceHandle: routing?.sourceHandle ?? "bottom",
        targetHandle: routing?.targetHandle ?? "top",
        className: isNew ? "edge-entering" : undefined,
        animated: !isFeedback && state.nodes[edge.from]?.status === "running",
        markerEnd: isFeedback ? "url(#workflow-arrow-feedback)" : "url(#workflow-arrow-default)",
        data: { isNew, routeX: routing?.routeX, routeSide: routing?.routeSide },
        style: {
          stroke: isFeedback ? tokens.graphEdgeFeedback : tokens.graphEdgeDefault,
          strokeWidth: 1.5,
          strokeDasharray: isFeedback ? "5 4" : undefined,
        },
        label: isFeedback
          ? `${edge.relation || "缺陷重构反馈"} · REVISE`
          : (edge.relation || undefined),
        labelStyle: {
          fontSize: 10,
          fontWeight: 500,
          fill: isFeedback ? tokens.graphEdgeFeedbackText : tokens.textSecondary,
          fontFamily: isFeedback ? "monospace" : "inherit",
        },
        labelBgStyle: {
          fill: isFeedback ? tokens.graphEdgeFeedbackBg : tokens.bgCanvas,
          stroke: isFeedback ? tokens.graphEdgeFeedback : tokens.borderDefault,
          strokeWidth: 1,
        },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 4,
      };
    });
    return [...graphEdges, ...Array.from(mergeTargets.keys(), (target): Edge => ({
      id: `merger:${target}->${target}`, source: `merger:${target}`, target,
      sourceHandle: "bottom", targetHandle: "top", type: "workflow",
      markerEnd: "url(#workflow-arrow-default)",
      style: { stroke: tokens.graphEdgeDefault, strokeWidth: 1.5 },
    }))];
  }, [state.graph.edges, state.nodes, recentlyAddedEdgeIds, edgeRouting, mergeTargets]);

  return { nodes, edges };
}
