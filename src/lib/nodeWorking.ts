import type { ChatMessage, Execution } from "../types";

export function isNodeWorking(
  status: string | undefined,
  execution: Pick<Execution, "status" | "completedAt"> | undefined,
  pendingRequest: boolean,
  latestUnassignedMessage?: Pick<ChatMessage, "delivery">,
  paused?: boolean,
): boolean {
  // A dirty node is queued for re-computation and its conversation continues,
  // but a paused Run dispatches nothing: showing a working composer whose
  // Steer would be rejected misreports an idle conversation.
  return (!paused && status === "dirty") ||
    (pendingRequest && !!latestUnassignedMessage && !latestUnassignedMessage.delivery) ||
    (execution ? execution.status === "running" && execution.completedAt == null : status === "running");
}
