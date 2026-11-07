import type { ChatMessage, PlanningSummary } from "../types";
import { plannerContentSteerId, plannerContentText, stripPlannerContext } from "./plannerText";

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
    // Each planning revision is a separate JSONL stream. An interrupted user
    // start in one revision cannot consume an end-only turn in the next one.
    if (line.startsWith('{"type":"grapher_planning_source"')) {
      pendingStart = false;
      started.clear();
      continue;
    }
    if (!line.includes('"message_start"') && !line.includes('"message_end"')) continue;
    try {
      const event = JSON.parse(line);
      if ((event.type !== "message_start" && event.type !== "message_end") || event.message?.role !== "user") continue;
      const content = event.message.content;
      if (!Array.isArray(content) && typeof content !== "string") continue;
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
      const text = stripPlannerContext(plannerContentText(content)).trim();
      if (text) turns.push(text);
    } catch {
      // Incomplete JSONL lines are still being written by the Planner.
    }
  }
  return turns;
}

/** A paged window can start at a steer identical to the original goal. Its
 * transport identity proves it is not the header even when the text matches. */
export function firstPlannerUserIsSteer(output: string): boolean {
  for (const line of output.split("\n")) {
    if (!line.includes('"message_start"') && !line.includes('"message_end"')) continue;
    try {
      const event = JSON.parse(line);
      if ((event.type !== "message_start" && event.type !== "message_end") || event.message?.role !== "user") continue;
      return !!plannerContentSteerId(event.message.content);
    } catch { /* An incomplete live JSONL line cannot establish identity. */ }
  }
  return false;
}

/** Prompt attachments travel as XML ahead of the user's text; editing a saved
 * turn can persist them even though the header shows only the clean text. */
function withoutAttachmentPrefix(text: string): string {
  return text.replace(/^(?:<file name="[^"]+">[\s\S]*?<\/file>\s*)+/, "").trim();
}

/** Compare a local prompt with the same prompt in a planning summary or log. */
export function plannerUserTurnKey(text: string): string {
  return withoutAttachmentPrefix(stripPlannerContext(text).trim());
}

/** Associate cached local follow-ups only when a durable turn's goal and start
 * time identify them unambiguously. Unmatched messages remain optimistic: in
 * particular, a new duplicate instruction must not be claimed by an old turn. */
export function plannerHistoryMessageSources(
  messages: readonly ChatMessage[], turns: readonly PlanningSummary[],
  historyIds: readonly string[], reviewIds: ReadonlySet<string>,
): Map<string, string> {
  const eligible = new Set(historyIds);
  const sources = new Map<string, string>();
  const claimed = new Set<string>();
  for (let index = 1; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "user" || message.plannerSteerId || message.timestamp == null) continue;
    const next = messages.slice(index + 1).find(item => item.role === "user" && !item.plannerSteerId && item.timestamp != null);
    const candidates = turns.filter(turn => eligible.has(turn.planningId) && !reviewIds.has(turn.planningId) &&
      !claimed.has(turn.planningId) && turn.createdAt != null && turn.createdAt >= message.timestamp! &&
      (next?.timestamp == null || turn.createdAt < next.timestamp) && !!turn.goal &&
      plannerUserTurnKey(turn.goal) === plannerUserTurnKey(message.text));
    if (candidates.length !== 1) continue;
    sources.set(message.id, candidates[0].planningId);
    claimed.add(candidates[0].planningId);
  }
  return sources;
}

/** The transcript suppresses its first user row only when that row is the
 * conversation header rendered above it. A partial window whose first row is
 * a later steer must stay visible; hiding it would drop the user's message. */
export function skipsFirstPersistedTurn(turns: readonly string[], firstTurnText?: string): boolean {
  if (!turns.length || !firstTurnText) return false;
  return plannerUserTurnKey(turns[0]) === plannerUserTurnKey(firstTurnText);
}
