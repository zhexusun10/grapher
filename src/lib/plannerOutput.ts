// Planner output filtering logic
// Extracted for use in tests without requiring TSX support
import { stripPlannerContext } from "../services/plannerText";

export type PlannerEvent = { type?: string; planning_id?: string; planning?: { planningId?: string; createdAt?: number } | null };

/**
 * Planning attempts whose durable output belongs to the Run conversation, in
 * conversation order. Committed turns arrive as `created`/`graph_revised`,
 * background reviews as `planner_review_started`, and aborted revision turns
 * (failed, stopped or interrupted before committing a graph) as
 * `planner_turn_aborted`. Recovery records an interrupted turn when the backend
 * restarts, after later turns, so order falls back to the attempt start time.
 */
export function plannerTurnIds(events: ReadonlyArray<PlannerEvent>): string[] {
  const turns: Array<{ id: string; createdAt: number; index: number }> = [];
  const seen = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.type !== "created" && event.type !== "graph_revised"
      && event.type !== "planner_review_started" && event.type !== "planner_turn_aborted") continue;
    const id = event.planning_id || event.planning?.planningId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    turns.push({ id, createdAt: event.planning?.createdAt ?? 0, index });
  }
  return turns.sort((a, b) => (a.createdAt - b.createdAt) || (a.index - b.index)).map(turn => turn.id);
}

/** Durable Planner revisions whose JSONL is replayed as conversation history.
 *
 * A live Planner transcript already renders the attempt it owns. Replaying
 * that attempt's growing JSONL at the same time duplicates its user turn,
 * thinking and tools. Fully committed turns stay in history, including during
 * a continuation. `savedPlannerId` may still name the last completed turn
 * until the backend announces the new revision, so only attempts that are not
 * committed yet are withheld from the replay.
 */
export function plannerHistoryIds(options: {
  events: ReadonlyArray<PlannerEvent>;
  savedPlannerId?: string;
  planning: boolean;
  live: boolean;
  continuation: boolean;
  backgroundReview: boolean;
  recoveredPlanningId?: string;
  routeType: string;
  representedIds?: ReadonlyArray<string>;
}): string[] {
  const { events, savedPlannerId, planning, live, continuation, backgroundReview,
    recoveredPlanningId, routeType } = options;
  // Recovery discovers the planning ID before the route is known. Mount the
  // durable activity poller now, rather than waiting for the finished graph.
  if ((!recoveredPlanningId && routeType !== "graph") ||
    (planning && !backgroundReview && !recoveredPlanningId && !continuation)) return [];
  const completed = plannerTurnIds(events);
  const committed = new Set(completed);
  const ids = savedPlannerId ? [...completed, savedPlannerId] : completed;
  // The live stream owns exactly the uncommitted attempt named by the snapshot.
  const streamingId = planning && live && savedPlannerId && !committed.has(savedPlannerId)
    ? savedPlannerId : "";
  const represented = options.representedIds ?? [];
  const seen = new Set<string>();
  return ids.filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (id === streamingId) return false;
    // Only suppress a durable turn while it is actively streaming. Once
    // planning stops, the JSONL is authoritative even if SSE was partial.
    // A continuation keeps earlier represented turns; only its new revision is live.
    if (!continuation && planning && live && (id === savedPlannerId || represented.includes(id))) {
      return false;
    }
    return true;
  });
}

export function activePlannerOutput(output: string, edits: Array<{ old_instruction?: string; nextPlanningId?: string }>): string {
  let active = output;
  for (const edit of edits) {
    if (!edit.old_instruction) continue;
    const lines = active.split("\n");
    const start = lines.findIndex((line) => {
      try {
        const event = JSON.parse(line);
        if (event.type !== "message_start" && event.type !== "message_end") return false;
        if (event.message?.role !== "user") return false;
        const text = stripPlannerContext((event.message.content || []).filter((part: { type: string }) => part.type === "text")
          .map((part: { text: string }) => part.text).join("\n"));
        return text === edit.old_instruction || text.endsWith(`\n${edit.old_instruction}`);
      } catch { return false; }
    });
    if (start < 0) continue;
    const resume = edit.nextPlanningId ? lines.findIndex((line, index) => index > start &&
      line.includes(`"type":"grapher_planning_source"`) && line.includes(`"planningId":"${edit.nextPlanningId}"`)) : -1;
    active = [...lines.slice(0, start), ...(resume >= 0 ? lines.slice(resume) : [])].join("\n");
  }
  return active;
}
