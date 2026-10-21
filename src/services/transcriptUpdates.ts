import type { TranscriptItem } from "../types";

/** Immutable tail update: completed history retains its object identities. */
export function appendItemDelta(
  previous: TranscriptItem[], type: "thinking" | "text", delta: string, running = true,
): TranscriptItem[] {
  if (!delta) return previous;
  const next = previous.slice();
  const last = previous.at(-1);
  // A user turn is authored text: assistant deltas must start a new row instead
  // of growing the steer bubble they were queued behind.
  if (last && last.type === type && last.role !== "user" &&
      (type === "thinking" ? last.status === "running" : true)) {
    next[next.length - 1] = { ...last, content: (last.content || "") + delta,
      ...(type === "thinking" ? { status: running ? "running" : "success" } : {}) };
  } else {
    if (last?.type === "thinking" && last.status === "running") next[next.length - 1] = { ...last, status: "success" };
    next.push({ id: `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type, role: "assistant", content: delta, status: running ? "running" : "success", timestamp: Date.now() });
  }
  return next;
}
