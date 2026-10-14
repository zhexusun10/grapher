import type { TranscriptItem } from "../types";

/**
 * A settled transcript never receives further results: its unterminated live
 * markers (tool calls without a result, trailing streaming thinking) were cut
 * off by the execution's terminal state, not still running. Display them as
 * interrupted instead of a perpetual spinner. This is display-only: it never
 * invents success and does not change the parser's durable items.
 */
export function settleInterruptedItems(items: TranscriptItem[]): TranscriptItem[] {
  if (!items.some(item => item.status === "running")) return items;
  return items.map(item =>
    item.status === "running" ? { ...item, status: "interrupted" as const } : item
  );
}
