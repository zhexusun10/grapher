import type { ChatMessage, ChatMessageVersion, Execution, FileAttachment, GraphEvent, Snapshot } from "../types";
import { withoutPlannerSteerIdentity } from "./plannerSteers";

export function stripNodePrefix(text: string): string {
  return text.replace(/^\[@[^\]]+\]\s*/, "").trim();
}

export function findBranchTargetIndex(
  entries: readonly ChatMessage[],
  targetMsg: Pick<ChatMessage, "id" | "text">,
  cleanExisting?: string,
): number {
  const cleanTarget = stripNodePrefix(cleanExisting || targetMsg.text);
  const strippedRaw = stripNodePrefix(targetMsg.text);
  return entries.findIndex(entry =>
    (targetMsg.id && entry.id === targetMsg.id) ||
    stripNodePrefix(entry.text) === cleanTarget ||
    stripNodePrefix(entry.text) === strippedRaw
  );
}

export function applySelectedVersionToEntries(
  entries: readonly ChatMessage[],
  targetMsg: Pick<ChatMessage, "id" | "text">,
  cleanExisting: string | undefined,
  selectedMessage: ChatMessage,
  subsequentEntries: readonly ChatMessage[] | undefined,
  appendWhenMissing = false,
): ChatMessage[] {
  const index = findBranchTargetIndex(entries, targetMsg, cleanExisting);
  if (index < 0) return appendWhenMissing ? [...entries, selectedMessage] : [selectedMessage];
  const subsequent = (subsequentEntries ?? []).map(withoutPlannerSteerIdentity);
  return [...entries.slice(0, index), selectedMessage, ...subsequent];
}

export function branchEditedMessageEntries(
  entries: readonly ChatMessage[],
  targetMsg: ChatMessage,
  cleanExisting: string,
  cleanText: string,
  attachments: FileAttachment[] | undefined,
  transform: (msg: ChatMessage) => ChatMessage = msg => msg,
): { updatedMsg: ChatMessage; rolledBackEntries: ChatMessage[]; previousEntries: ChatMessage[] } {
  const now = Date.now();
  const targetIndex = findBranchTargetIndex(entries, targetMsg, cleanExisting);
  if (targetIndex !== -1) {
    const current = entries[targetIndex];
    const previousEntries = entries.slice(0, targetIndex);
    const parentId = previousEntries.length > 0 ? previousEntries[previousEntries.length - 1].id : null;
    const initialVersion: ChatMessageVersion = {
      id: "v1",
      text: current.text,
      files: current.files,
      images: current.images,
      timestamp: current.timestamp || now,
      subsequentEntries: entries.slice(targetIndex + 1),
    };
    const newVersion: ChatMessageVersion = {
      id: `v${now}`,
      text: cleanText,
      files: attachments,
      images: targetMsg.images,
      timestamp: now,
      subsequentEntries: [],
    };
    const versions = [...(current.versions || [initialVersion]), newVersion];
    const updatedMsg = transform({
      ...current,
      text: cleanText,
      files: attachments,
      timestamp: now,
      parentId,
      versions,
      currentVersionIndex: versions.length - 1,
    });
    return {
      updatedMsg,
      rolledBackEntries: [...previousEntries, updatedMsg],
      previousEntries,
    };
  }
  const versions: ChatMessageVersion[] = [
    ...(targetMsg.versions ?? [{
      id: "v1",
      text: targetMsg.text,
      files: targetMsg.files,
      images: targetMsg.images,
      timestamp: targetMsg.timestamp || now,
    }]),
    {
      id: `v${now}`,
      text: cleanText,
      files: attachments,
      images: targetMsg.images,
      timestamp: now,
      subsequentEntries: [],
    },
  ];
  const updatedMsg = transform({
    ...targetMsg,
    text: cleanText,
    files: attachments,
    timestamp: now,
    versions,
    currentVersionIndex: versions.length - 1,
  });
  return {
    updatedMsg,
    rolledBackEntries: [...entries, updatedMsg],
    previousEntries: entries[0] ? [entries[0]] : [],
  };
}

/** Only the chosen branch contributes turns to the active conversation. The
 * original durable events and executions remain available for history. */
export function activeNodeConversationEvents(state: Snapshot, node: string): GraphEvent[] {
  const edits = state.events.filter((event) => event.type === "conversation_edited" && event.nodes?.includes(node));
  const superseded = new Set(state.supersededExecutionIds ?? []);
  const lineage = nodeConversationLineage(state, node);
  const freshBoundary = state.events
    .filter((event) => event.type === "started" && event.execution?.node === node
      && (!superseded.has(event.execution.id) || lineage.has(event.execution.id)))
    .map((event) => event.sequence)
    .reduce((oldest, sequence) => Math.min(oldest, sequence), Number.POSITIVE_INFINITY);
  const belongs = (event: GraphEvent) => event.node === node || event.target === node;
  return state.events.filter((event) => !edits.some((edit) => {
    if (event.sequence >= edit.sequence) return false;
    if (edit.target === node) {
      return event.sequence >= (edit.from_event_sequence ?? edit.sequence) && belongs(event);
    }
    // Editing an upstream node invalidates the old descendant conversation.
    return event.timestamp >= (state.events.find((e) => e.type === "started" &&
      e.execution?.id === edit.from_execution_id)?.timestamp ?? edit.timestamp) &&
      belongs(event);
  })).filter((event) => {
    if (Number.isFinite(freshBoundary) && event.sequence < freshBoundary
      && (event.type === "invalidated" || event.type === "node_messaged" || event.type === "steered")) {
      return false;
    }
    return true;
  });
}

export function executionIdForMessage(state: Snapshot, event: GraphEvent): string | undefined {
  if (event.execution_id) return event.execution_id;
  const node = event.target ?? event.node;
  if (!node) return undefined;
  const bound = state.events.find(item => item.type === "started" && item.execution?.node === node &&
    item.message_sequences?.includes(event.sequence));
  if (bound) return bound.execution?.id;
  if (state.nodes[node]?.pendingMessages?.some(message => message.sequence === event.sequence)) return undefined;
  // New starts have exact claims. Only historical starts may infer ownership
  // from event order; otherwise an unclaimed message could appear delivered.
  return state.events.find(item => item.type === "started" &&
    (event.type === "conversation_edited" || item.message_sequences === undefined) &&
    item.sequence > event.sequence && item.execution?.node === node)?.execution?.id;
}

export function executionIdForVersion(state: Snapshot, node: string, text: string): string | undefined {
  const clean = stripNodePrefix(text);
  const edited = state.events.slice().reverse().find(event =>
    event.type === "conversation_edited" && event.target === node &&
    event.instruction?.trim() === clean);
  if (edited) return executionIdForMessage(state, edited);
  const previous = state.events.slice().reverse().find(event =>
    event.type === "conversation_edited" && event.target === node &&
    event.old_instruction?.trim() === clean);
  if (previous?.from_execution_id) return previous.from_execution_id;
  const invalidated = state.events.slice().reverse().find(event =>
    event.type === "invalidated" && event.target === node &&
    event.instruction?.trim() === clean);
  return invalidated ? executionIdForMessage(state, invalidated) : undefined;
}

export function executionIdForEdit(state: Snapshot, edit: GraphEvent): string | undefined {
  return executionIdForMessage(state, edit);
}

export function versionIndexForEdit(state: Snapshot, edit: GraphEvent, versions = versionsForEdit(state, edit)): number {
  return edit.selected_version ?? versions.length - 1;
}

export function versionsForEdit(state: Snapshot, edit: GraphEvent): ChatMessageVersion[] {
  const versions: ChatMessageVersion[] = [];
  let cursor: GraphEvent | undefined = edit;
  const visited = new Set<number>();
  while (cursor?.type === "conversation_edited" && !visited.has(cursor.sequence)) {
    visited.add(cursor.sequence);
    if (cursor.selected_version !== undefined) {
      const previous = state.events.slice().reverse().find(event =>
        event.sequence < cursor!.sequence && event.type === "conversation_edited" &&
        event.target === cursor!.target && event.selected_version === undefined);
      const base = previous ? versionsForEdit(state, previous) : [];
      const branchEnd = versions.length === 0 ? base.length : cursor.selected_version + 1;
      return [...base.slice(0, branchEnd), ...versions];
    }
    const nextExecution = executionIdForEdit(state, cursor);
    versions.unshift({ id: `v${cursor.sequence}`, text: cursor.instruction ?? "", images: cursor.images,
      timestamp: cursor.timestamp, executionId: nextExecution });
    const parent: GraphEvent | undefined = state.events.find(e => e.sequence === cursor?.from_event_sequence);
    if (parent?.type === "conversation_edited") cursor = parent;
    else {
      versions.unshift({ id: `v${parent?.sequence ?? cursor.sequence}-before`, text: cursor.old_instruction ?? "",
        images: parent?.images, timestamp: parent?.timestamp ?? cursor.timestamp, executionId: cursor.from_execution_id });
      break;
    }
  }
  return versions;
}

/** Executions whose conversation history belongs to the node's active
 * conversation: the live attempts plus each edit's retained anchor. A from-zero
 * restart discards everything before it, so a fork (which is not a restart)
 * keeps its retained prefix even though its Pi session ID changed. */
export function nodeConversationLineage(state: Snapshot, node: string): Set<string> {
  const lineage = new Set(activeNodeExecutions(state, node).map(execution => execution.id));
  const restart = state.events.reduce((latest, event) =>
    event.type === "started" && event.execution?.node === node && event.fresh_restart && event.sequence > latest
      ? event.sequence : latest, Number.NEGATIVE_INFINITY);
  for (const event of state.events) {
    if (event.type !== "conversation_edited" || event.target !== node) continue;
    if (event.sequence < restart) continue;
    if (event.from_execution_id) lineage.add(event.from_execution_id);
  }
  return lineage;
}

export type ConversationExecution = Execution & { historyEndOffset?: number; historyReadOnly?: boolean };

/** Durable edits retain a byte-bounded prefix of an abandoned execution. A
 * later edit of an earlier prefix replaces that cut and drops later prefixes. */
export function nodeConversationExecutions(state: Snapshot, node: string): ConversationExecution[] {
  const active = activeNodeExecutions(state, node);
  const order = new Map(state.executions.map((execution, index) => [execution.id, index]));
  const edits = state.events.filter(event => event.type === "conversation_edited" && event.target === node);
  const lineage = nodeConversationLineage(state, node);
  // A retained prefix is editable only while its Pi session is still the
  // conversation's current session. A fork continues in a new session file, so
  // branching the old one could not affect the active conversation (the runtime
  // refuses that edit), and offering it would only fail.
  const currentSession = active.length > 0 ? active[active.length - 1].sessionId : undefined;
  const prefixes = new Map<string, ConversationExecution>();
  for (const edit of edits) {
    const anchor = state.executions.find(execution => execution.id === edit.from_execution_id);
    if (!anchor || !lineage.has(anchor.id)) continue;
    for (const [id, prefix] of prefixes) {
      if (prefix.sessionId === anchor.sessionId && order.get(prefix.id)! >= order.get(anchor.id)!) prefixes.delete(id);
    }
    if (edit.from_output_offset !== undefined && edit.from_output_offset > 0) {
      prefixes.set(anchor.id, { ...anchor, historyEndOffset: edit.from_output_offset,
        historyReadOnly: currentSession !== undefined && anchor.sessionId !== currentSession });
    }
  }
  for (const execution of active) prefixes.delete(execution.id);
  return [...prefixes.values(), ...active].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

export function activeNodeExecutions(state: Snapshot, node: string) {
  const superseded = new Set(state.supersededExecutionIds ?? []);
  return state.executions.filter((execution) => execution.node === node && !superseded.has(execution.id));
}
