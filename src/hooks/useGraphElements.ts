import { useMemo } from "react";
import type { Edge } from "@xyflow/react";
import type { Graph, Plan, Snapshot } from "../types";
import { tokens } from "../tokens";
import type { WorkNode } from "../components/graph/TaskNode";

export function computeExecutionLayers(graph: Graph, plan?: Plan | null): string[][] {
  if (plan?.executionBatches && plan.executionBatches.length > 0) {
    const scheduled = new Set(plan.executionBatches.flat());
    const missing = graph.nodes.map((node) => node.name).filter((name) => !scheduled.has(name));
    return missing.length ? [...plan.executionBatches, missing] : plan.executionBatches;
  }
  const nodeNames = graph.nodes.map((n) => n.name);
  if (nodeNames.length === 0) return [];
  const deps = graph.edges.filter(
    (e) => !e.feedback && nodeNames.includes(e.from) && nodeNames.includes(e.to)
  );
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
      for (const edge of deps.filter((e) => e.from === name)) {
        const deg = (inDegree.get(edge.to) ?? 1) - 1;
        inDegree.set(edge.to, deg);
        if (deg === 0) next.push(edge.to);
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
    for (const merger of state.mergers ?? []) {
      const target = merger.node.startsWith("merge:") ? merger.node.slice(6) : "";
      if (target && state.graph.nodes.some((node) => node.name === target)) targets.set(target, merger);
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
      return [`${edge.from}-${edge.feedback ? "fb" : "dep"}-${edge.to}`, {
        sourceHandle: sideRoute ? `${side}-source` : "bottom",
        targetHandle: sideRoute ? `${side}-target` : "top",
        routeX,
        routeSide: sideRoute ? side : undefined,
      }] as const;
    }));
  }, [state.graph.edges, graphLayout]);

  const nodes = useMemo<WorkNode[]>(() => {
    const taskNodes: WorkNode[] = state.graph.nodes.map((node) => {
      const position = graphLayout.positions.get(node.name) ?? { x: 160, y: 24, layer: 0 };
      const nodeAttempts = state.executions.filter((execution) => execution.node === node.name);
      const incoming = state.graph.edges.filter((edge) => edge.to === node.name);
      const outgoing = state.graph.edges.filter((edge) => edge.from === node.name);
      const route = (edge: Graph["edges"][number]) =>
        edgeRouting.get(`${edge.from}-${edge.feedback ? "fb" : "dep"}-${edge.to}`);
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
          hint: state.graph.edges
            .filter((edge) => edge.to === node.name || (edge.from === node.name && edge.feedback))
            .map((edge) => `${edge.from} → ${edge.to}: ${edge.relation}${edge.feedback ? " (feedback)" : ""}`)
            .join("\n"),
          reviewer: state.graph.edges.some((edge) => edge.from === node.name && edge.feedback),
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
    return [...taskNodes, ...Array.from(mergeTargets, ([target, merger]): WorkNode => {
      const node = taskNodes.find((item) => item.id === target)!;
      const attempts = (state.mergers ?? []).filter((item) => item.node === `merge:${target}`).length;
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
  }, [state.graph, state.nodes, state.executions, state.mergers, selected, graphLayout, edgeRouting, mergeTargets]);

  const edges = useMemo<Edge[]>(() => {
    const graphEdges = state.graph.edges.map((edge) => {
      const isFeedback = !!edge.feedback;
      const edgeId = `${edge.from}-${isFeedback ? "fb" : "dep"}-${edge.to}`;
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
