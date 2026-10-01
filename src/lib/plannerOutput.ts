// Planner output filtering logic
// Extracted for use in tests without requiring TSX support

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
        const text = (event.message.content || []).filter((part: { type: string }) => part.type === "text")
          .map((part: { text: string }) => part.text).join("\n");
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
