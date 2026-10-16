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
