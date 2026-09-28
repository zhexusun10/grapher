import type { ChatMessage, Execution } from "../types";

export function isNodeWorking(
  status: string | undefined,
  execution: Pick<Execution, "status" | "completedAt"> | undefined,
  pendingRequest: boolean,
  latestUnassignedMessage?: Pick<ChatMessage, "delivery">,
): boolean {
  return status === "dirty" ||
    (pendingRequest && !!latestUnassignedMessage && !latestUnassignedMessage.delivery) ||
    (execution ? execution.status === "running" && execution.completedAt == null : status === "running");
}
