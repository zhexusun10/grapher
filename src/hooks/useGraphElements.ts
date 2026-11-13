import { t } from "../i18n";
import { useMemo, useRef } from "react";
import { shareById } from "../services/structuralSharing";
import type { Edge } from "@xyflow/react";
import { publicationMergerCardId, type FeedbackExhaustion, type Graph, type Plan, type RuntimeActivity, type Snapshot } from "../types";
import { tokens } from "../tokens";
import type { WorkNode } from "../components/graph/TaskNode";

// Topology geometry. Column pitch leaves a full card of horizontal room for the
// side edge lanes; the row pitch leaves room for the taller cards while keeping
// a generous gap between layers so long edges stay readable and the graph uses
// the canvas height instead of crowding every card into a narrow band.
const NODE_WIDTH = 260;
// Cards use their vertical midpoint as the node origin so a compact Merger card
// lines up with the midpoint of its downstream node instead of their top edges.
// This is the nominal task-card height used to center each execution row.
const NODE_BASE_HEIGHT = 196;
const NODE_ORIGIN: [number, number] = [0, 0.5];
// Merger executions use a compact card. Keep this in sync with `.task-node.merger`.
const MERGER_WIDTH = 220;
const MERGER_GAP = 20;
const COLUMN_PITCH = 300;
const ROW_PITCH = 320;
const PADDING_X = 160;
const PADDING_Y = 24;

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

/** Show skipped verdicts only for the current completed execution and route. */
export function indexFeedbackExhaustion(state: Pick<Snapshot, "graph" | "nodes" | "executions" | "events" | "supersededExecutionIds">) {
  const latest = new Map<string, Snapshot["executions"][number]>();
  const superseded = new Set(state.supersededExecutionIds ?? []);
  for (const execution of state.executions) {
    if (!superseded.has(execution.id)) latest.set(execution.node, execution);
  }
  const routes = new Set(state.graph.edges.filter(edge => edge.feedback).map(graphEdgeId));
  const exhausted = new Map<string, FeedbackExhaustion>();
  for (const event of state.events) {
    if (event.type !== "feedback_exhausted" || !event.from || !event.to || event.count === undefined || event.limit === undefined) continue;
    const execution = latest.get(event.from);
    if (state.nodes[event.from]?.status === "completed" && execution?.status === "completed" && execution.id === event.execution_id &&
        routes.has(graphEdgeId({ from: event.from, to: event.to, feedback: true }))) {
      exhausted.set(event.from, { from: event.from, to: event.to, count: event.count, limit: event.limit });
    }
  }
  return exhausted;
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
export function useGraphElements(
  state: Snapshot,
  selected: string,
  recentlyAddedEdgeIds: Set<string>,
  selectedMergerId = "",
  activity: RuntimeActivity[] = [],
  recentlyAddedNodeNames: Set<string> = new Set(),
) {
  const mergeTargets = useMemo(() => {
    const targets = new Map<string, NonNullable<Snapshot["mergers"]>[number]>();
    const names = new Set(state.graph.nodes.map((node) => node.name));
    for (const merger of state.mergers ?? []) {
      const target = merger.node.startsWith("merge:") ? merger.node.slice(6) : "";
      if (target && names.has(target)) targets.set(target, merger);
    }
    return targets;
  }, [state.mergers, state.graph.nodes]);

  // Keep the same geometry for nodes and edges. Columns leave room for edge
  // channels; rows keep a readable gap between layers. A merger reserves a lane
  // immediately left of its target so the compact card never covers a neighbor.
  const graphLayout = useMemo(() => {
    const layers = computeExecutionLayers(state.graph, state.plan);
    const positions = new Map<string, { x: number; y: number; layer: number }>();
    const mergerPlacements = new Map<string, { x: number; placeLeft: boolean }>();
    const lane = MERGER_WIDTH + MERGER_GAP;
    layers.forEach((batch, layer) => {
      let shift = 0;
      const xs: number[] = [];
      for (let index = 0; index < batch.length; index++) {
        // The lane sits before its target; shifting the target and every card
        // after it keeps the row ordered while leaving the merger its own slot.
        if (mergeTargets.has(batch[index])) shift += lane;
        xs.push(PADDING_X + (index - (batch.length - 1) / 2) * COLUMN_PITCH + shift);
      }
      const rowShift = shift / 2;
      batch.forEach((name, index) => {
        const x = xs[index] - rowShift;
        positions.set(name, {
          x,
          y: layer * ROW_PITCH + PADDING_Y + NODE_BASE_HEIGHT / 2,
          layer,
        });
        if (mergeTargets.has(name)) {
          mergerPlacements.set(name, { x: x - lane, placeLeft: true });
        }
      });
    });
    const xs = Array.from(positions.values(), (position) => position.x);
    const mergerXs = Array.from(mergerPlacements.values(), (placement) => placement.x);
    return {
      positions,
      mergerPlacements,
      minX: Math.min(...xs, ...mergerXs, PADDING_X),
      maxX: Math.max(...xs.map((x) => x + NODE_WIDTH), ...mergerXs.map((x) => x + MERGER_WIDTH), PADDING_X + NODE_WIDTH),
    };
  }, [state.graph, state.plan, mergeTargets]);
  // Bind the card to the publication that launched this execution, not the
  // Run's current publication (which is cleared when the next group starts).
  const publicationMerger = useMemo(
    () => (state.mergers ?? []).filter((merger) => merger.node === "merger").at(-1),
    [state.mergers],
  );
  const publicationAttempts = useMemo(
    () => (state.mergers ?? []).filter((merger) => merger.node === "merger").length,
    [state.mergers],
  );
  const publicationContext = useMemo(() => {
    let start = -1;
    for (let index = state.events.length - 1; index >= 0; index--) {
      const event = state.events[index];
      if (event.type === "merger_started" && event.execution?.id === publicationMerger?.id) {
        start = index;
        break;
      }
    }
    if (start < 0) return { batch: !!state.batchHandoff, heads: state.publication?.heads ?? [] };
    let heads: string[] | undefined;
    for (let index = start - 1; index >= 0; index--) {
      const event = state.events[index];
      if (event.type === "publication_started") heads ??= event.heads;
      if (event.type === "batch_handoff_requested") return { batch: true, heads: heads ?? [] };
      if (["publication_completed", "execution_batch_started", "created"].includes(event.type)) break;
    }
    return { batch: false, heads: heads ?? [] };
  }, [state.events, state.batchHandoff, state.publication, publicationMerger?.id]);
  const publicationTargets = useMemo(() => {
    const names = new Set(state.graph.nodes.map((node) => node.name));
    if (publicationContext.batch) {
      const heads = new Set(publicationContext.heads);
      const producers = new Set(state.executions.filter(execution => execution.after && heads.has(execution.after))
        .map(execution => execution.node));
      return new Set(Array.from(names).filter(name => producers.has(name) ||
        (!!state.nodes[name]?.head && heads.has(state.nodes[name].head!))));
    }
    const planned = (state.plan?.terminals ?? []).filter((name) => names.has(name));
    if (planned.length) return new Set(planned);
    const hasDependencyChild = new Set(
      state.graph.edges
        .filter((edge) => !edge.feedback && names.has(edge.from) && names.has(edge.to))
        .map((edge) => edge.from),
    );
    return new Set(Array.from(names).filter((name) => !hasDependencyChild.has(name)));
  }, [state.graph, state.plan, state.nodes, state.executions, publicationContext]);
  const publicationPosition = useMemo(() => {
    let lastLayer = 0;
    if (publicationContext.batch) {
      for (const name of publicationTargets) lastLayer = Math.max(lastLayer, graphLayout.positions.get(name)?.layer ?? 0);
      return {
        x: graphLayout.maxX + MERGER_GAP + MERGER_WIDTH / 2,
        y: lastLayer * ROW_PITCH + PADDING_Y + NODE_BASE_HEIGHT / 2,
        layer: lastLayer,
      };
    }
    for (const position of graphLayout.positions.values()) lastLayer = Math.max(lastLayer, position.layer);
    return {
      x: (graphLayout.minX + graphLayout.maxX) / 2 - MERGER_WIDTH / 2,
      y: (lastLayer + 1) * ROW_PITCH + PADDING_Y + NODE_BASE_HEIGHT / 2,
      layer: lastLayer + 1,
    };
  }, [graphLayout, publicationContext.batch, publicationTargets]);
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
    const routing = new Map<string, { sourceHandle: string; targetHandle: string; routeX?: number; routeSide?: string }>(state.graph.edges.map((edge) => {
      const from = graphLayout.positions.get(edge.from);
      const to = graphLayout.positions.get(edge.to);
      const side = from && to && (from.x + to.x + NODE_WIDTH) / 2 > center ? "right" : "left";
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
    if (publicationMerger) {
      for (const name of publicationTargets) {
        const from = graphLayout.positions.get(name);
        if (!from) continue;
        if (publicationContext.batch) {
          routing.set(`publication:${name}`, {
            sourceHandle: "right-source", targetHandle: "left-target",
            routeX: graphLayout.maxX + MERGER_GAP / 2,
          });
          continue;
        }
        const routed = publicationPosition.layer - from.layer > 1;
        const side = from.x + NODE_WIDTH / 2 > center ? "right" : "left";
        routing.set(`publication:${name}`, {
          sourceHandle: "bottom",
          targetHandle: "top",
          routeX: routed
            ? side === "left" ? graphLayout.minX - 48 - laneCount.left++ * 14
              : graphLayout.maxX + 48 + laneCount.right++ * 14
            : undefined,
        });
      }
    }
    return routing;
  }, [state.graph.edges, graphLayout, publicationMerger, publicationPosition, publicationTargets, publicationContext.batch]);

  const indexes = useMemo(() => indexGraphInputs(state.graph, state.executions), [state.graph, state.executions]);
  const feedbackExhaustion = useMemo(() => indexFeedbackExhaustion(state), [state.graph, state.nodes, state.executions, state.events, state.supersededExecutionIds]);
  const mergerAttempts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const merger of state.mergers ?? []) counts.set(merger.node, (counts.get(merger.node) ?? 0) + 1);
    return counts;
  }, [state.mergers]);
  const runningMergerTargets = useMemo(() => {
    const targets = new Set<string>();
    for (const merger of state.mergers ?? []) {
      if (merger.status === "running" && merger.node.startsWith("merge:")) {
        targets.add(merger.node.slice(6));
      }
    }
    return targets;
  }, [state.mergers]);

  const nodes = useMemo<WorkNode[]>(() => {
    const taskNodes: WorkNode[] = state.graph.nodes.map((node) => {
      const position = graphLayout.positions.get(node.name) ?? { x: PADDING_X, y: PADDING_Y, layer: 0 };
      const nodeAttempts = indexes.attempts.get(node.name) ?? [];
      const incoming = indexes.incoming.get(node.name) ?? [];
      const outgoing = indexes.outgoing.get(node.name) ?? [];
      const route = (edge: Graph["edges"][number]) => edgeRouting.get(graphEdgeId(edge));
      const mergerPlacement = graphLayout.mergerPlacements.get(node.name);
      const rawStatus = state.nodes[node.name]?.status ?? "waiting";
      const status = rawStatus === "running" && runningMergerTargets.has(node.name) ? "waiting" : rawStatus;
      return {
        id: node.name,
        type: "work",
        width: NODE_WIDTH,
        origin: NODE_ORIGIN,
        position: { x: position.x, y: position.y },
        // A short-lived entrance class lets newly created cards animate in
        // without re-triggering the animation on later data updates.
        className: recentlyAddedNodeNames.has(node.name) ? "node-entering" : undefined,
        data: {
          name: node.name,
          task: node.task,
          status,
          // Pause/Continue creates another execution record, not another attempt.
          attempts: nodeAttempts.reduce((latest, execution) => Math.max(latest, execution.attempt), 0),
          hint: (indexes.hints.get(node.name) ?? [])
            .map((edge) => `${edge.from} → ${edge.to}${edge.feedback ? " (feedback)" : ""}`)
            .join("\n"),
          reviewer: outgoing.some((edge) => edge.feedback),
          feedbackExhaustion: feedbackExhaustion.get(node.name),
          // A merger conversation is its own selected card; the node card is not
          // highlighted while one of its merger attempts is addressed.
          selected: selected === node.name && !selectedMergerId,
          worktree: nodeAttempts.at(-1)?.worktree ?? "",
          hasTop: incoming.some((edge) => route(edge)?.targetHandle === "top"),
          hasBottom: outgoing.some((edge) => route(edge)?.sourceHandle === "bottom") ||
            (!!publicationMerger && !publicationContext.batch && publicationTargets.has(node.name)),
          hasLeftTarget: incoming.some((edge) => route(edge)?.targetHandle === "left-target"),
          hasLeftSource: outgoing.some((edge) => route(edge)?.sourceHandle === "left-source"),
          hasRightTarget: incoming.some((edge) => route(edge)?.targetHandle === "right-target"),
          hasRightSource: outgoing.some((edge) => route(edge)?.sourceHandle === "right-source") ||
            (!!publicationMerger && publicationContext.batch && publicationTargets.has(node.name)),
          mergerSide: mergerPlacement ? (mergerPlacement.placeLeft ? "left" : "right") : undefined,
        },
      };
    });
    // A merger is an execution, not a planner node. Show one card per fan-in
    // target only after a real conflict has launched the resolver.
    const taskNodesById = new Map(taskNodes.map((node) => [node.id, node]));
    const mergerNodes = Array.from(mergeTargets, ([target, merger]): WorkNode => {
      const node = taskNodesById.get(target)!;
      const placement = graphLayout.mergerPlacements.get(target);
      const attempts = mergerAttempts.get(`merge:${target}`) ?? 0;
      const placeLeft = placement?.placeLeft ?? true;
      return {
        id: `merger:${target}`, type: "work", width: MERGER_WIDTH, origin: NODE_ORIGIN,
        position: { x: placement?.x ?? node.position.x - MERGER_WIDTH - MERGER_GAP, y: node.position.y },
        data: {
          name: `merger · ${target}`, task: t("合并上游分支冲突"), kind: "merger",
          status: merger.status === "completed" ? "completed" : merger.status === "running" ? "running" : "failed",
          attempts, hint: t("合并至 {0}", target), reviewer: false,
          selected: selected === `merger:${target}` || (selected === target && merger.id === selectedMergerId),
          worktree: merger.worktree, hasTop: true, hasBottom: false,
          hasLeftTarget: false, hasLeftSource: false,
          hasRightTarget: false, hasRightSource: false,
          mergerSide: placeLeft ? "left" : "right",
        },
      };
    });
    if (!publicationMerger) return [...taskNodes, ...mergerNodes];
    return [...taskNodes, ...mergerNodes, {
      id: publicationMergerCardId, type: "work", width: MERGER_WIDTH, origin: NODE_ORIGIN,
      position: { x: publicationPosition.x, y: publicationPosition.y },
      data: {
        name: publicationContext.batch ? t("批次回写 merger") : t("publication merger"),
        task: publicationContext.batch ? t("合并已完成派发组的回写冲突") : t("合并最终回写结果冲突"), kind: "merger",
        status: publicationMerger.status === "completed" ? "completed" : publicationMerger.status === "running" ? "running" : "failed",
        attempts: publicationAttempts, hint: publicationContext.batch && publicationMerger.status !== "running"
          ? t("批次回写记录，不属于任务依赖") : t("合并至源目录"), reviewer: false,
        selected: publicationMerger.id === selectedMergerId,
        worktree: publicationMerger.worktree, hasTop: !publicationContext.batch, hasBottom: false,
        hasLeftTarget: publicationContext.batch, hasLeftSource: false, hasRightTarget: false, hasRightSource: false,
      },
    }];
  }, [state.graph, state.nodes, indexes, feedbackExhaustion, mergerAttempts, runningMergerTargets, selected, selectedMergerId, graphLayout, edgeRouting, mergeTargets, publicationMerger, publicationAttempts, publicationPosition, publicationTargets, publicationContext.batch, recentlyAddedNodeNames]);

  const edges = useMemo<Edge[]>(() => {
    const graphEdges = state.graph.edges.map((edge) => {
      const isFeedback = !!edge.feedback;
      const edgeId = graphEdgeId(edge);
      const routing = edgeRouting.get(edgeId);
      const isNew = recentlyAddedEdgeIds.has(edgeId);

      let animated = false;
      if (!isFeedback) {
        const fromCompleted = state.nodes[edge.from]?.status === "completed";
        if (fromCompleted) {
          if (mergeTargets.has(edge.to)) {
            const merger = mergeTargets.get(edge.to);
            animated = merger?.status === "running";
          } else {
            const toNode = state.nodes[edge.to];
            const toStatus = toNode?.status;
            const toAttempts = indexes.attempts.get(edge.to) ?? [];
            const latestExec = toAttempts.at(-1);

            const isTerminal = !toNode || toStatus === "completed" || toStatus === "failed" || toStatus === "paused" || toStatus === "blocked";
            if (!isTerminal) {
              const incomingDeps = (indexes.incoming.get(edge.to) ?? []).filter((e) => !e.feedback);
              const allParentsCompleted = incomingDeps.length > 0 && incomingDeps.every((e) => state.nodes[e.from]?.status === "completed");

              if (allParentsCompleted) {
                const isCurrentExecRunning = latestExec != null && (latestExec.status === "running" || toStatus === "running");
                const isPrepared = isCurrentExecRunning && (
                  state.events.some((e) => e.type === "prepared" && e.execution_id === latestExec.id) ||
                  (latestExec.output?.length ?? 0) > 0 ||
                  (latestExec.outputBytes ?? 0) > 0
                );
                const isPreparingActivity = activity.some(
                  (a) => a.kind === "workspace_prepare" && a.nodes.includes(edge.to)
                );

                // Workspace is actively transferring when all upstream parents are completed,
                // and the workspace preparation has not yet completed.
                // As soon as preparation completes (prepared event or output produced),
                // it immediately turns back into a solid line without waiting for node completion!
                animated = isPreparingActivity || !isPrepared;
              }
            }
          }
        }
      }

      return {
        id: edgeId,
        source: edge.from,
        target: !isFeedback && mergeTargets.has(edge.to) ? `merger:${edge.to}` : edge.to,
        type: "workflow",
        sourceHandle: routing?.sourceHandle ?? "bottom",
        targetHandle: routing?.targetHandle ?? "top",
        className: isNew ? "edge-entering" : undefined,
        animated,
        markerEnd: isFeedback ? "workflow-arrow-feedback" : "workflow-arrow-default",
        data: { isNew, routeX: routing?.routeX, routeSide: routing?.routeSide },
        style: {
          stroke: isFeedback ? tokens.graphEdgeFeedback : tokens.graphEdgeDefault,
          strokeWidth: 1.5,
          strokeDasharray: isFeedback ? "5 4" : undefined,
        },
      };
    });
    const publicationEdges: Edge[] = publicationMerger
      ? Array.from(publicationTargets, (name): Edge => {
          const routing = edgeRouting.get(`publication:${name}`);
          const isTerminalCompleted = state.nodes[name]?.status === "completed";
          const isMergerRunning = publicationMerger.status === "running";
          return {
            id: `publication:${name}->merger`, source: name, target: publicationMergerCardId,
            sourceHandle: routing?.sourceHandle ?? "bottom", targetHandle: routing?.targetHandle ?? "top", type: "workflow",
            markerEnd: "workflow-arrow-default",
            animated: isTerminalCompleted && isMergerRunning,
            data: { routeX: routing?.routeX, routeSide: routing?.routeSide },
            style: { stroke: tokens.graphEdgeDefault, strokeWidth: 1.5 },
          };
        })
      : [];
    const mergerEdges: Edge[] = Array.from(mergeTargets.keys(), (target): Edge => {
      const placeLeft = graphLayout.mergerPlacements.get(target)?.placeLeft ?? true;
      const merger = mergeTargets.get(target);
      const isMergerCompleted = merger?.status === "completed";
      const toNode = state.nodes[target];
      const toStatus = toNode?.status;
      const toAttempts = indexes.attempts.get(target) ?? [];
      const latestTargetExec = toAttempts.at(-1);
      const isTargetExecRunning = latestTargetExec != null && (latestTargetExec.status === "running" || toStatus === "running");
      const isTargetPrepared = isTargetExecRunning && (
        state.events.some((e) => e.type === "prepared" && e.execution_id === latestTargetExec.id) ||
        (latestTargetExec.output?.length ?? 0) > 0 ||
        (latestTargetExec.outputBytes ?? 0) > 0
      );
      const isTargetPreparingActivity = activity.some(
        (a) => a.kind === "workspace_prepare" && a.nodes.includes(target)
      );
      const isTargetTerminal = !toNode || toStatus === "completed" || toStatus === "failed" || toStatus === "paused" || toStatus === "blocked";
      const animated = isMergerCompleted && !isTargetTerminal && (isTargetPreparingActivity || !isTargetPrepared);

      return {
        id: `merger:${target}->${target}`, source: `merger:${target}`, target,
        sourceHandle: placeLeft ? "merger-right-source" : "merger-left-source",
        targetHandle: placeLeft ? "merger-left-target" : "merger-right-target",
        type: "workflow",
        markerEnd: "workflow-arrow-default",
        animated,
        style: { stroke: tokens.graphEdgeDefault, strokeWidth: 1.5 },
      };
    });
    return [...graphEdges, ...publicationEdges, ...mergerEdges];
  }, [state.graph.edges, state.nodes, state.events, activity, indexes, recentlyAddedEdgeIds, edgeRouting, mergeTargets, publicationMerger, publicationTargets, graphLayout]);

  const previous = useRef({ runId: state.runId, nodes, edges });
  const shared = useMemo(() => {
    if (previous.current.runId !== state.runId) return { runId: state.runId, nodes, edges };
    return { runId: state.runId, nodes: shareById(previous.current.nodes, nodes), edges: shareById(previous.current.edges, edges) };
  }, [state.runId, nodes, edges]);
  previous.current = shared;
  return { nodes: shared.nodes, edges: shared.edges };
}
