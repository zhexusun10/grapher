import { stripPlannerContext } from "./plannerText";

/** A live continuation seeds the stream with the message being edited. The
 * first turn is already rendered as the conversation header, so drop that
 * duplicate while preserving later user turns and assistant events. */
export function withoutLiveFirstTurn<T extends { id?: string; role?: string }>(items: T[], firstId?: string): T[] {
  return firstId ? items.filter(item => !(item.role === "user" && item.id === firstId)) : items;
}

// Recover persisted user turns from the Planner's durable Pi JSONL. This must
// mirror the transcript parser's user-row rules: a turn is rendered from its
// `message_start` or `message_end`, and a start/end pair counts once. Counting
// only `message_end` misses a turn whose process was aborted after the start
// was flushed, so its optimistic bubble would render a second time next to the
// saved replay.
export function plannerUserTurns(output: string): string[] {
  const turns: string[] = [];
  const started = new Set<string>();
  let pendingStart = false;
  for (const line of output.split("\n")) {
    if (!line.includes('"message_start"') && !line.includes('"message_end"')) continue;
    try {
      const event = JSON.parse(line);
      if ((event.type !== "message_start" && event.type !== "message_end") || event.message?.role !== "user") continue;
      const content = event.message.content;
      if (!Array.isArray(content)) continue;
      const messageId = event.message.id;
      if (event.type === "message_end") {
        // A start already rendered this turn; the end only confirms it.
        if (pendingStart || (messageId && started.has(messageId))) {
          pendingStart = false;
          continue;
        }
      } else {
        pendingStart = true;
        if (messageId) started.add(messageId);
      }
      const text = stripPlannerContext(content.filter((part: { type: string }) => part.type === "text")
        .map((part: { text?: string }) => part.text || "").join("\n")).trim();
      if (text) turns.push(text);
    } catch {
      // Incomplete JSONL lines are still being written by the Planner.
    }
  }
  return turns;
}

/** Prompt attachments travel as XML ahead of the user's text; editing a saved
 * turn can persist them even though the header shows only the clean text. */
function withoutAttachmentPrefix(text: string): string {
  return text.replace(/^(?:<file name="[^"]+">[\s\S]*?<\/file>\s*)+/, "").trim();
}

/** The transcript suppresses its first user row only when that row is the
 * conversation header rendered above it. A partial window whose first row is
 * a later steer must stay visible; hiding it would drop the user's message. */
export function skipsFirstPersistedTurn(turns: readonly string[], firstTurnText?: string): boolean {
  if (!turns.length || !firstTurnText) return false;
  return withoutAttachmentPrefix(turns[0]) === withoutAttachmentPrefix(firstTurnText);
}
