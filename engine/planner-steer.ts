/** Private correlation stays in Pi's session/event stream, not model context.
 * Only the reserved trailing UUID envelope is removed; source user text and
 * image blocks remain unchanged. An extension that removes the envelope early
 * simply prevents Grapher from claiming consumption. */
const marker = /\n\n<grapher-steer-id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}<\/grapher-steer-id>$/;

export function stripPlannerSteerMarker(text: string): string {
  return text.replace(marker, "");
}

export function plannerSteerContext<T extends { role: string; content?: unknown }>(messages: T[]): T[] {
  return messages.map(message => {
    if (message.role !== "user") return message;
    if (typeof message.content === "string") {
      const content = stripPlannerSteerMarker(message.content);
      return content === message.content ? message : { ...message, content };
    }
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part: any) => {
      if (part?.type !== "text" || typeof part.text !== "string") return part;
      const text = stripPlannerSteerMarker(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { ...message, content } : message;
  });
}
