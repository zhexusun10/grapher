import type { ChatMessage, Execution, Snapshot } from "../types";

export function isNodeWorking(
  status: string | undefined,
  execution: Pick<Execution, "status" | "completedAt"> | undefined,
  pendingRequest: boolean,
  latestUnassignedMessage?: Pick<ChatMessage, "delivery">,
  paused?: boolean,
  /** A dirty node may still be waiting for an upstream repair/feedback turn. */
  readyForDispatch = true,
  /** A human message is queued for this node's next execution. */
  hasPendingMessage = false,
): boolean {
  // Dirtiness alone is a scheduling fact, not an active writer: an upstream
  // feedback/finish can invalidate every descendant while they wait for their
  // turn. Show Working only for an actual running execution, an in-flight send,
  // or a dirty node that the user has already queued a message for and that is
  // eligible to dispatch.
  return (!paused && status === "dirty" && readyForDispatch && (hasPendingMessage || !execution)) ||
    (pendingRequest && !!latestUnassignedMessage && !latestUnassignedMessage.delivery) ||
    (execution ? execution.status === "running" && execution.completedAt == null : status === "running");
}

/** True when every transitive dependency (ordinary edges only) is completed. */
export function nodeDependenciesCompleted(
  graph: Pick<Snapshot["graph"], "edges">,
  nodes: Snapshot["nodes"],
  name: string,
): boolean {
  const parents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.feedback) continue;
    const list = parents.get(edge.to);
    if (list) list.push(edge.from);
    else parents.set(edge.to, [edge.from]);
  }
  const seen = new Set<string>();
  const pending = [...(parents.get(name) ?? [])];
  while (pending.length > 0) {
    const dependency = pending.pop()!;
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    if (nodes[dependency]?.status !== "completed") return false;
    pending.push(...(parents.get(dependency) ?? []));
  }
  return true;
}
