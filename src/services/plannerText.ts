/** Remove protocol context that Grapher prepends to Planner user turns.
 *
 * Planner follow-ups for an existing graph include a status block so the model
 * can make an informed revision. That block is transport context, not part of
 * the user's conversation, and must not leak into the Planner transcript.
 */
export function stripPlannerContext(text: string): string {
  let value = text.replace(/^User query:\s*\r?\n\r?\n?/, "");
  if (!value.startsWith("Current graph node status:")) return value;

  const lines = value.split(/\r?\n/);
  let index = 1;
  // Transport lines may precede the `- node: status` list: the rework note in
  // current prompts, and an "Already published in this run: ..." paragraph in
  // historical ones. Skip them so existing transcripts render clean too.
  const transportPrefixes = ["Modifying a completed node's task", "Already published in this run:"];
  while (index < lines.length && transportPrefixes.some(prefix => lines[index].startsWith(prefix))) {
    index += 1;
  }
  // The status block is a sequence of `- node: status` lines. Older Planner
  // prompts did not put a blank line before the actual instruction, so stop at
  // the first non-status line instead of relying on a double newline.
  while (index < lines.length && (lines[index].trim() === "" || /^- [^:\n]+:\s*\S/.test(lines[index]))) {
    index += 1;
  }
  return lines.slice(index).join("\n");
}
