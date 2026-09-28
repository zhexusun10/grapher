import type { ChatMessageVersion, GraphEvent, Snapshot } from "../types";

/** Only the chosen branch contributes turns to the active conversation. The
 * original durable events and executions remain available for history. */
export function activeNodeConversationEvents(state: Snapshot, node: string): GraphEvent[] {
  const edits = state.events.filter((event) => event.type === "conversation_edited" && event.nodes?.includes(node));
  return state.events.filter((event) => !edits.some((edit) => {
    if (event.sequence >= edit.sequence) return false;
    if (edit.target === node) {
      return event.sequence >= (edit.from_event_sequence ?? edit.sequence) &&
        (event.node === node || event.target === node);
    }
    // Editing an upstream node invalidates the old descendant conversation.
    return event.timestamp >= (state.events.find((e) => e.type === "started" &&
      e.execution?.id === edit.from_execution_id)?.timestamp ?? edit.timestamp) &&
      (event.node === node || event.target === node);
  }));
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
    const nextExecution = state.events.find(event => event.type === "started" &&
      event.sequence > cursor!.sequence && event.execution?.node === cursor!.target)?.execution?.id;
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

export function activeNodeExecutions(state: Snapshot, node: string) {
  const superseded = new Set(state.supersededExecutionIds ?? []);
  return state.executions.filter((execution) => execution.node === node && !superseded.has(execution.id));
}
