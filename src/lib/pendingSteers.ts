import type { ChatMessage } from "../types";

/** A node instruction without the `[@node]` addressing prefix the bubble adds. */
export function nodeInstructionText(text: string): string {
  return text.replace(/^\[@[^\]]+\]\s*/, "").trim();
}

/**
 * A steer Pi has not committed to its session transcript yet.
 *
 * A running node accepts steers through its Pi RPC input, but Pi only consumes
 * them at its next safe boundary. Until the matching user turn appears in the
 * transcript, the message exists only as a durable `Steered` event or an
 * optimistic card. Editing such a turn branches the Pi session and fails with
 * "Cannot locate that user turn in the Pi conversation tree".
 *
 * The transcript only reports the steer texts it was asked to render inline, so
 * attachment-bearing steers cannot be verified here and are treated as
 * committed rather than rolled back by mistake.
 */
export function isUncommittedSteer(
  message: ChatMessage,
  inlineUserTurns: Record<string, readonly string[]>,
): boolean {
  if (message.delivery !== "steered" || !message.executionId) return false;
  if (message.images?.length || message.files?.length) return false;
  const turns = inlineUserTurns[message.executionId] ?? [];
  return !turns.includes(nodeInstructionText(message.text));
}

/**
 * Stable identity for a steer across its optimistic card and its later durable
 * `Steered` event. Rolling back one form must also suppress the other.
 */
export function steerRollbackKey(message: ChatMessage): string | null {
  if (message.delivery !== "steered" || !message.executionId) return null;
  return `${message.executionId}\u0000${nodeInstructionText(message.text)}`;
}
