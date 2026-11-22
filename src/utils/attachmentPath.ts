const UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";

const MANAGED_ATTACHMENT_PATH_RE = new RegExp(
  `^(?:/+|[A-Za-z]:/)(?:[^/\\\\\\0\\r\\n]+/)*attachment-inputs/(?:${UUID}/)?${UUID}/[^/\\\\\\0\\r\\n]+$`,
  "i",
);

const MANAGED_ATTACHMENT_MENTION_RE = new RegExp(
  `@(?:"((?:[^"\\\\\\r\\n]|\\\\.)*)"|(\\S+))`,
  "g",
);

/** Verify that a backend-returned attachment path points strictly into
 * Grapher's external `attachment-inputs/` store with no traversal segments. */
export function isManagedAttachmentPath(path: unknown): path is string {
  if (typeof path !== "string" || !MANAGED_ATTACHMENT_PATH_RE.test(path)) {
    return false;
  }
  return !path.split("/").some((segment) => segment === "." || segment === "..");
}

function decodeMentionPath(quoted?: string, bare?: string): string | null {
  if (quoted !== undefined) {
    try {
      const parsed = JSON.parse(`"${quoted}"`);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  return bare ?? null;
}

export interface ManagedAttachmentMention {
  raw: string;
  path: string;
  name: string;
  start: number;
  end: number;
}

/** Find every `@<path>` or `@"<path>"` mention referencing an external managed attachment. */
export function findManagedAttachmentMentions(text: string): ManagedAttachmentMention[] {
  const results: ManagedAttachmentMention[] = [];
  const regex = new RegExp(MANAGED_ATTACHMENT_MENTION_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const start = match.index;
    // Ignore email-like tokens (`user@host/...`).
    if (start > 0 && !/\s/.test(text[start - 1])) continue;
    const path = decodeMentionPath(match[1], match[2]);
    if (!isManagedAttachmentPath(path)) continue;
    const name = path.split("/").pop() || path;
    results.push({
      raw: match[0],
      path,
      name,
      start,
      end: start + match[0].length,
    });
  }
  return results;
}

/** Remove managed external attachment mentions from displayed text. */
export function stripManagedAttachmentMentions(text: string): string {
  const mentions = findManagedAttachmentMentions(text);
  if (mentions.length === 0) return text;
  let result = "";
  let cursor = 0;
  for (const mention of mentions) {
    result += text.slice(cursor, mention.start);
    let end = mention.end;
    while (end < text.length && (text[end] === " " || text[end] === "\t")) end += 1;
    cursor = end;
  }
  result += text.slice(cursor);
  return result.trim();
}

/** Extract any leading attachment prefix (`<file>...</file>` and/or managed `@<path>`)
 * so editing a saved user message preserves its attached files. */
export function extractLeadingAttachmentPrefix(text: string): string {
  let cursor = 0;
  let matched = false;
  while (cursor < text.length) {
    const rest = text.slice(cursor);
    const ws = rest.match(/^\s+/);
    if (ws) {
      cursor += ws[0].length;
      continue;
    }
    const xml = rest.match(/^<file name="[^"]+">[\s\S]*?<\/file>\s*/);
    if (xml) {
      matched = true;
      cursor += xml[0].length;
      continue;
    }
    const mention = rest.match(/^@(?:"((?:[^"\\\r\n]|\\.)*)"|(\S+))/);
    if (mention) {
      const path = decodeMentionPath(mention[1], mention[2]);
      if (isManagedAttachmentPath(path)) {
        matched = true;
        cursor += mention[0].length;
        const trailing = text.slice(cursor).match(/^[ \t]+/);
        if (trailing) cursor += trailing[0].length;
        continue;
      }
    }
    break;
  }
  return matched ? text.slice(0, cursor) : "";
}

/** Strip any leading attachment prefix (`<file>` tags and/or managed `@<path>`). */
export function stripLeadingAttachmentPrefix(text: string): string {
  const prefix = extractLeadingAttachmentPrefix(text);
  return prefix ? text.slice(prefix.length).trim() : text.trim();
}

/** Recombine an extracted attachment prefix with edited message text without
 * gluing text directly onto a bare or quoted `@<path>` mention. */
export function prependAttachmentPrefix(prefix: string, body: string): string {
  if (!prefix) return body;
  if (!body) return prefix;
  return /\s$/.test(prefix) ? `${prefix}${body}` : `${prefix} ${body}`;
}

/** Format a goal/label string for compact UI surfaces (such as sidebar titles)
 * by hiding internal managed attachment paths and falling back to filenames. */
export function formatManagedAttachmentDisplayLabel(text: string): string {
  const mentions = findManagedAttachmentMentions(text);
  if (mentions.length === 0) return text;
  const cleaned = stripManagedAttachmentMentions(text);
  if (cleaned) return cleaned;
  return mentions.map((mention) => mention.name).join(", ");
}
