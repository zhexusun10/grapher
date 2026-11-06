import type { TranscriptItem } from "../types";

export type ToolCallPhase = "generating" | "pending" | "executing";

/** Content indices are only unique within one assistant message. An ID, when
 * present, remains authoritative across message_end and execution events. */
export function findToolCallIndex(items: readonly TranscriptItem[], toolCallId?: string,
  contentIndex?: number, messageStart = 0): number {
  if (toolCallId) {
    const index = items.findIndex(item => item.type === "tool_call" && item.toolCallId === toolCallId);
    if (index >= 0) return index;
  }
  if (contentIndex === undefined) return -1;
  // A provider may identify the call only on `toolcall_end`. Adopt the
  // id-less generating row instead of drawing a second card for the same block.
  return items.findIndex((item, index) => index >= messageStart && item.type === "tool_call" &&
    item.toolContentIndex === contentIndex &&
    (!item.toolCallId || !toolCallId || item.toolCallId === toolCallId));
}

export interface ToolCallUpdate {
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, any>;
  argsTruncated?: boolean;
  contentIndex?: number;
  phase: ToolCallPhase;
}

const phaseOrder: Record<ToolCallPhase, number> = { generating: 0, pending: 1, executing: 2 };

/** A later event never rewinds a card that already advanced. Undefined updates
 * keep whatever the row already knows (for example a bare execution update). */
export function laterToolPhase(existing?: ToolCallPhase, update?: ToolCallPhase): ToolCallPhase | undefined {
  if (!existing) return update;
  if (!update) return existing;
  return phaseOrder[existing] > phaseOrder[update] ? existing : update;
}

/** The parser's generic fallback is "tool"; it must never replace a real name
 * learned from an earlier event for the same call. */
export function toolNameUpdate(existing: string | undefined, update: string | undefined): string {
  const known = existing && existing !== "tool" ? existing : undefined;
  return !update || update === "tool" ? known ?? update ?? "tool" : update;
}

/** Merge the model's call and the later execution into a single stable row. */
export function upsertToolCall(items: TranscriptItem[], update: ToolCallUpdate, messageStart = 0): TranscriptItem[] {
  const id = update.toolCallId || undefined;
  const index = findToolCallIndex(items, id, update.contentIndex, messageStart);
  const existing = index >= 0 ? items[index] : undefined;
  const phase = laterToolPhase(existing?.toolPhase, update.phase)!;
  const item: TranscriptItem = {
    ...(existing ?? { id: id || `tool_${crypto.randomUUID()}`, type: "tool_call", status: "running", timestamp: Date.now() }),
    toolCallId: id || existing?.toolCallId,
    toolName: toolNameUpdate(existing?.toolName, update.toolName),
    args: update.args && Object.keys(update.args).length ? update.args : existing?.args || {},
    argsTruncated: existing?.argsTruncated || update.argsTruncated || undefined,
    toolContentIndex: update.contentIndex ?? existing?.toolContentIndex,
    toolPhase: phase,
  };
  const next = items.slice();
  if (index >= 0) next[index] = item;
  else next.push(item);
  return next;
}
