/** Display-only limit. Agent tool results and saved Pi sessions are not trimmed. */
export const TOOL_OUTPUT_PREVIEW_BYTES = 100 * 1024;
const ELLIPSIS = "\n...";

/** Scan only the bounded prefix, without encoding/copying a giant whole string. */
export function truncateToolText(text: string): { text: string; truncated: boolean } {
  let bytes = 0, end = 0, previewEnd = 0;
  while (end < text.length) {
    const point = text.codePointAt(end)!;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > TOOL_OUTPUT_PREVIEW_BYTES) break;
    bytes += size;
    end += point > 0xffff ? 2 : 1;
    if (bytes <= TOOL_OUTPUT_PREVIEW_BYTES - ELLIPSIS.length) previewEnd = end;
  }
  return end === text.length ? { text, truncated: false }
    : { text: text.slice(0, previewEnd) + ELLIPSIS, truncated: true };
}

/** Match the protocol's text-block joining, but never join unbounded results. */
export function toolOutputPreview(content: unknown): { text: string; truncated: boolean } {
  if (typeof content === "string") return truncateToolText(content);
  if (!Array.isArray(content)) return { text: "", truncated: false };
  const parts: string[] = [];
  // One extra code unit guarantees the byte limiter can detect truncation.
  let remaining = TOOL_OUTPUT_PREVIEW_BYTES + 1;
  for (const part of content) {
    if (part?.type !== "text") continue;
    if (parts.length) { parts.push("\n"); remaining--; }
    if (remaining <= 0) break;
    const text = typeof part.text === "string" ? part.text : "";
    parts.push(text.slice(0, remaining));
    remaining -= Math.min(text.length, remaining);
    if (remaining === 0) break;
  }
  return truncateToolText(parts.join(""));
}
