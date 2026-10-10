import type { TranscriptItem } from "../types";

export interface ThinkingUpdate {
  type: "thinking_start" | "thinking_delta" | "thinking_end";
  contentIndex?: number;
  delta?: string;
  // Compact frames can carry the already-generated text on thinking_start.
  content?: string | MessageContent;
}

interface MessageContent {
  type: string;
  thinking?: string;
}

/** Captured thinking is not a disposable preview; finals may only backfill or extend it. */
function backfillThinkingContent(captured = "", incoming?: string): string {
  if (incoming?.trim() && (!captured.trim() || incoming.startsWith(captured))) return incoming;
  return captured;
}

function thinkingItem(contentIndex?: number): TranscriptItem {
  return {
    id: `think_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type: "thinking", role: "assistant", content: "", status: "running",
    thinkingContentIndex: contentIndex, timestamp: Date.now(),
  };
}

function blockIndex(items: TranscriptItem[], contentIndex: number | undefined, messageStart: number) {
  for (let i = items.length - 1; i >= messageStart; i--) {
    const item = items[i];
    if (item.type === "thinking" && item.thinkingContentIndex === contentIndex) return i;
  }
  return -1;
}

/** Close cards without inventing text for provider-private reasoning blocks. */
export function closeThinkingItems(items: TranscriptItem[], messageStart = 0): TranscriptItem[] {
  let next = items;
  for (let index = messageStart; index < items.length; index++) {
    const item = items[index];
    if (item.type !== "thinking" || item.status !== "running") continue;
    if (next === items) next = items.slice();
    next[index] = { ...item, status: "success" };
  }
  return next;
}

/** One card per contentIndex within one assistant message, for live SSE and replay. */
export function updateThinkingItems(items: TranscriptItem[], update: ThinkingUpdate, messageStart = 0): TranscriptItem[] {
  let index = blockIndex(items, update.contentIndex, messageStart);
  // Older events may not carry an index. A new start after an end is a new block.
  if (update.type === "thinking_start" && update.contentIndex === undefined && index >= 0 && items[index].status !== "running") {
    index = -1;
  }
  const closed = update.type === "thinking_start" && index < 0 ? closeThinkingItems(items, messageStart) : items;
  const next = closed === items ? items.slice() : closed;
  if (index < 0) {
    index = next.length;
    next.push(thinkingItem(update.contentIndex));
  }
  const item = { ...next[index] };
  if (update.type === "thinking_delta") {
    item.content = (item.content || "") + (update.delta || "");
  } else {
    const content = typeof update.content === "string" ? update.content
      : update.content?.type === "thinking" ? update.content.thinking : undefined;
    item.content = backfillThinkingContent(item.content, content);
  }
  item.status = update.type === "thinking_end" ? "success" : "running";
  next[index] = item;
  return next;
}

/** Backfill final summaries in place, never duplicate cards or match a prior turn. */
export function finalizeThinkingItems(items: TranscriptItem[], content: MessageContent[], messageStart = 0): TranscriptItem[] {
  // Backfills below replace entries, so do not write into the caller's array even
  // when there was no running block to close.
  let next = closeThinkingItems(items, messageStart).slice();
  content.forEach((part, contentIndex) => {
    if (part.type !== "thinking") return;
    let index = blockIndex(next, contentIndex, messageStart);
    if (index < 0) {
      index = next.findIndex((item, i) => i >= messageStart && item.type === "thinking" && item.thinkingContentIndex === undefined);
    }
    if (index >= 0) {
      next[index] = {
        ...next[index], thinkingContentIndex: contentIndex, status: "success",
        content: backfillThinkingContent(next[index].content, part.thinking),
      };
    } else {
      next = updateThinkingItems(next, { type: "thinking_end", contentIndex, content: part.thinking }, messageStart);
    }
  });
  return next;
}
