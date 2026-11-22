const steerMarker = /\n\n<grapher-steer-id>([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})<\/grapher-steer-id>$/;
const piImageDimensionHint = /(?:\r?\n){1,2}\[Image: original \d+x\d+, displayed at \d+x\d+\.(?: Multiply coordinates by [\d.]+ to map to original image\.)?\]$/;
const piSkillExpansion = /^<skill name="([^"]+)" location="[^"]+">[\s\S]*?\r?\n<\/skill>(?:\r?\n\r?\n([\s\S]*))?$/;

/** Pi appends a coordinate-scaling note when it resizes an attached image.
 * Strip that synthetic suffix for display and inline-turn matching. */
export function stripPiImageDimensionHints(text: string): string {
  let value = text;
  while (piImageDimensionHint.test(value)) {
    value = value.replace(piImageDimensionHint, "");
  }
  return value;
}

/** Match a normalized transcript user turn against requested inline steer texts,
 * collapsing Pi's `<skill ...>` expansion back to `/skill:<name>` when needed. */
export function matchRequestedUserTurn(display: string, requested?: readonly string[]): string | null {
  if (!requested) return display;
  if (requested.includes(display)) return display;
  const skill = display.match(piSkillExpansion);
  if (!skill) return null;
  const args = skill[2]?.trim();
  const command = args ? `/skill:${skill[1]} ${args}` : `/skill:${skill[1]}`;
  return requested.includes(command) ? command : null;
}

export function plannerSteerId(text: string): string | undefined {
  return text.match(steerMarker)?.[1];
}

function plannerTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text);
}

/** Extensions may add text blocks after the marked block. Never infer identity
 * when multiple distinct markers appear in a transformed message. */
export function plannerContentSteerId(content: unknown): string | undefined {
  const ids = new Set(plannerTextParts(content).map(plannerSteerId).filter((id): id is string => !!id));
  return ids.size === 1 ? [...ids][0] : undefined;
}

export function plannerContentText(content: unknown): string {
  return plannerTextParts(content).map(text => text.replace(steerMarker, "")).join("\n");
}

export function stripPlannerContext(text: string): string {
  let value = text.replace(steerMarker, "").replace(/^User query:\s*\r?\n\r?\n?/, "");
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
