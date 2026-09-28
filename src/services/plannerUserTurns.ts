// Recover persisted user turns from the Planner's durable Pi JSONL. A steer
// acknowledgement can precede its message_end, so only completed turns count
// as replacements for optimistic browser messages.
export function plannerUserTurns(output: string): string[] {
  const turns: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.includes('"message_end"')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== "message_end" || event.message?.role !== "user") continue;
      const content = event.message.content;
      if (!Array.isArray(content)) continue;
      const text = content.filter((part: { type: string }) => part.type === "text")
        .map((part: { text?: string }) => part.text || "").join("\n")
        .replace(/^User query:\n\n/, "")
        .replace(/^Current graph node status:\n(?:- [^\n]*\n)*\n/, "")
        .trim();
      if (text) turns.push(text);
    } catch {
      // Incomplete JSONL lines are still being written by the Planner.
    }
  }
  return turns;
}
