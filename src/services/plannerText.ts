/** Remove protocol context that Grapher prepends to Planner user turns.
 *
 * Planner follow-ups for an existing graph include a status block so the model
 * can make an informed revision. That block is transport context, not part of
 * the user's conversation, and must not leak into the Planner transcript.
 */
export function stripPlannerContext(text: string): string {
  let value = text.replace(/^User query:\s*\r?\n\r?\n?/, "");
  const lines = value.split(/\r?\n/);
  const statusStart = value.startsWith("Current graph node status:")
    ? 0
    : lines[0]?.startsWith("You are now at ") && lines[1] === "Current graph node status:"
      ? 1
      : -1;
  if (statusStart < 0) return value;

  let index = statusStart + 1;
  // Transport lines may precede/follow the `- node: status` list: the
  // workspace announcement, the rework note in current prompts, and an
  // "Already published in this run: ..." paragraph in historical prompts.
  const transportPrefixes = ["Modifying a completed node's task", "Already published in this run:"];
  while (index < lines.length && (lines[index].trim() === "" ||
    transportPrefixes.some(prefix => lines[index].startsWith(prefix)) ||
    /^- [^:\n]+:\s*\S/.test(lines[index]))) {
    index += 1;
  }
  return lines.slice(index).join("\n");
}
