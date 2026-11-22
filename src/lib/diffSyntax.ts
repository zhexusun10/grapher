import type { FileDiffLine } from "../types";

export type SyntaxTokenKind = "keyword" | "string" | "comment" | "number" | "type";

export interface SyntaxSpan {
  start: number;
  end: number;
  kind: SyntaxTokenKind;
}

/** Match `pi-gpui/src/highlight.rs`: larger blocks stay plain so highlighting
 * never drops frames, and repeated renders reuse cached spans. */
const MAX_HIGHLIGHTED_CHARS = 100_000;
const HIGHLIGHT_CACHE_LIMIT = 64;
const highlightCache = new Map<string, SyntaxSpan[]>();

/** Fast 64-bit dual FNV-1a hash so cache keys stay ~32 bytes instead of
 * retaining up to 100 KB source strings in the JS heap. */
function hashText(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

function cachedTokenize(text: string, family: LanguageFamily): SyntaxSpan[] {
  if (family === "plain" || !text || text.length > MAX_HIGHLIGHTED_CHARS) return [];
  const key = `${family}:${text.length}:${hashText(text)}`;
  const hit = highlightCache.get(key);
  if (hit) {
    highlightCache.delete(key);
    highlightCache.set(key, hit);
    return hit;
  }
  const spans = tokenizeText(text, family);
  highlightCache.set(key, spans);
  if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
  return spans;
}

function hasLowerAscii(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c >= 97 && c <= 122) return true;
  }
  return false;
}

type LanguageFamily = "c-like" | "rust" | "python" | "shell" | "json" | "css" | "markup" | "plain";

const KEYWORDS: Record<Exclude<LanguageFamily, "plain" | "json" | "markup">, Set<string>> = {
  "c-like": new Set([
    "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
    "debugger", "default", "delete", "do", "else", "enum", "export", "extends", "false",
    "finally", "for", "from", "function", "get", "goto", "if", "implements", "import",
    "in", "instanceof", "interface", "let", "namespace", "new", "null", "of", "package",
    "private", "protected", "public", "readonly", "return", "set", "static", "struct",
    "super", "switch", "this", "throw", "true", "try", "type", "typeof", "undefined",
    "var", "void", "while", "with", "yield", "func", "go", "defer", "select", "chan",
    "map", "range", "fallthrough", "nil", "auto", "extern", "inline", "sizeof", "typedef",
    "union", "virtual", "override", "template", "typename", "using", "constexpr", "nullptr",
  ]),
  rust: new Set([
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
    "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod",
    "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super",
    "trait", "true", "type", "unsafe", "use", "where", "while",
  ]),
  python: new Set([
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
    "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
    "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
    "return", "try", "while", "with", "yield",
  ]),
  shell: new Set([
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case",
    "esac", "in", "function", "return", "exit", "export", "local", "readonly", "set",
    "unset", "shift", "true", "false",
  ]),
  css: new Set([
    "important", "from", "to", "and", "not", "only", "or", "none", "auto", "inherit",
    "initial", "unset", "revert", "solid", "dashed", "dotted", "flex", "grid", "block",
    "inline", "relative", "absolute", "fixed", "sticky", "hidden", "visible", "transparent",
  ]),
};

function detectLanguage(path: string): LanguageFamily {
  const leaf = path.split("/").pop()?.toLowerCase() ?? "";
  const ext = leaf.includes(".") ? leaf.slice(leaf.lastIndexOf(".") + 1) : leaf;
  switch (ext) {
    case "rs":
      return "rust";
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "mts":
    case "cts":
    case "go":
    case "java":
    case "kt":
    case "swift":
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "hpp":
    case "cs":
      return "c-like";
    case "py":
    case "pyi":
    case "rb":
      return "python";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "yaml":
    case "yml":
    case "toml":
      return "shell";
    case "json":
    case "jsonc":
      return "json";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "xml":
    case "svg":
      return "markup";
    default:
      return "plain";
  }
}

function isIdentStart(ch: number): boolean {
  return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch === 36;
}

function isIdentContinue(ch: number): boolean {
  return isIdentStart(ch) || (ch >= 48 && ch <= 57);
}

function isDigit(ch: number): boolean {
  return ch >= 48 && ch <= 57;
}

function tokenizeText(text: string, family: LanguageFamily): SyntaxSpan[] {
  if (family === "plain" || !text) return [];
  const spans: SyntaxSpan[] = [];
  const len = text.length;
  const hasSlashComments = family === "c-like" || family === "rust" || family === "css" || family === "json";
  const hasHashComments = family === "python" || family === "shell";
  const keywords = family === "json" || family === "markup" ? null : KEYWORDS[family];

  let i = 0;
  while (i < len) {
    const ch = text.charCodeAt(i);
    const next = i + 1 < len ? text.charCodeAt(i + 1) : 0;

    // Line comment //
    if (hasSlashComments && ch === 47 && next === 47) {
      const start = i;
      i += 2;
      while (i < len && text.charCodeAt(i) !== 10) i++;
      spans.push({ start, end: i, kind: "comment" });
      continue;
    }
    // Block comment /* ... */
    if (hasSlashComments && ch === 47 && next === 42) {
      const start = i;
      i += 2;
      while (i < len) {
        if (text.charCodeAt(i) === 42 && i + 1 < len && text.charCodeAt(i + 1) === 47) {
          i += 2;
          break;
        }
        i++;
      }
      spans.push({ start, end: i, kind: "comment" });
      continue;
    }
    // Hash comment #
    if (hasHashComments && ch === 35) {
      const start = i;
      i++;
      while (i < len && text.charCodeAt(i) !== 10) i++;
      spans.push({ start, end: i, kind: "comment" });
      continue;
    }
    // HTML comment <!-- ... -->
    if (family === "markup" && text.startsWith("<!--", i)) {
      const start = i;
      const close = text.indexOf("-->", i + 4);
      i = close === -1 ? len : close + 3;
      spans.push({ start, end: i, kind: "comment" });
      continue;
    }
    // Strings: ", ', `
    if (ch === 34 || (ch === 39 && family !== "rust") || (ch === 96 && family === "c-like")) {
      const quote = ch;
      const start = i;
      i++;
      while (i < len) {
        const cur = text.charCodeAt(i);
        if (cur === 92) {
          i += 2;
          continue;
        }
        i++;
        if (cur === quote || (quote !== 96 && cur === 10)) break;
      }
      spans.push({ start, end: i, kind: "string" });
      continue;
    }
    // CSS @rules
    if (family === "css" && ch === 64 && i + 1 < len && isIdentStart(text.charCodeAt(i + 1))) {
      const start = i;
      i += 2;
      while (i < len && (isIdentContinue(text.charCodeAt(i)) || text.charCodeAt(i) === 45)) i++;
      spans.push({ start, end: i, kind: "keyword" });
      continue;
    }
    // Markup tag names
    if (family === "markup" && ch === 60) {
      let j = i + 1;
      if (j < len && text.charCodeAt(j) === 47) j++;
      if (j < len && isIdentStart(text.charCodeAt(j))) {
        const start = j;
        while (j < len && (isIdentContinue(text.charCodeAt(j)) || text.charCodeAt(j) === 45 || text.charCodeAt(j) === 58)) j++;
        spans.push({ start, end: j, kind: "keyword" });
        i = j;
        continue;
      }
    }
    // Numbers
    if (isDigit(ch) && (i === 0 || !isIdentContinue(text.charCodeAt(i - 1)))) {
      const start = i;
      i++;
      while (i < len) {
        const cur = text.charCodeAt(i);
        if (isIdentContinue(cur) || cur === 46) i++;
        else break;
      }
      spans.push({ start, end: i, kind: "number" });
      continue;
    }
    // Identifiers, keywords, types
    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < len && isIdentContinue(text.charCodeAt(i))) i++;
      const word = text.slice(start, i);
      if (family === "json") {
        if (word === "true" || word === "false" || word === "null") {
          spans.push({ start, end: i, kind: "keyword" });
        }
      } else if (keywords?.has(word)) {
        spans.push({ start, end: i, kind: "keyword" });
      } else if (
        (family === "c-like" || family === "rust" || family === "python") &&
        ch >= 65 && ch <= 90 &&
        i - start > 1 &&
        hasLowerAscii(text, start + 1, i)
      ) {
        spans.push({ start, end: i, kind: "type" });
      }
      continue;
    }
    i++;
  }
  return spans;
}

function sliceLineSpans(spans: SyntaxSpan[], lineStart: number, lineLen: number): SyntaxSpan[] {
  if (!spans.length || lineLen === 0) return [];
  const lineEnd = lineStart + lineLen;
  // Binary search for first span whose end > lineStart.
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid].end <= lineStart) lo = mid + 1;
    else hi = mid;
  }
  const result: SyntaxSpan[] = [];
  for (let idx = lo; idx < spans.length; idx++) {
    const span = spans[idx];
    if (span.start >= lineEnd) break;
    const start = Math.max(span.start, lineStart) - lineStart;
    const end = Math.min(span.end, lineEnd) - lineStart;
    if (end > start) result.push({ start, end, kind: span.kind });
  }
  return result;
}

/**
 * Highlights both sides of a unified diff as continuous streams (matching
 * `pi-gpui`'s `line_highlights`), so multi-line comments and template strings
 * preserve their syntax color across lines. Hunk headers stay plain.
 */
export function highlightDiffLines(path: string, lines: FileDiffLine[], texts: string[]): SyntaxSpan[][] {
  const family = detectLanguage(path);
  if (family === "plain") return lines.map(() => []);

  const newParts: string[] = [];
  const oldParts: string[] = [];
  let newLen = 0;
  let oldLen = 0;
  const places: Array<{ isNew: boolean; start: number } | null> = new Array(lines.length);

  for (let i = 0; i < lines.length; i++) {
    const kind = lines[i].kind;
    const text = texts[i];
    if (kind === "hunk") {
      places[i] = null;
    } else if (kind === "context") {
      oldParts.push(text);
      oldLen += text.length + 1;
      const start = newLen;
      newParts.push(text);
      newLen += text.length + 1;
      places[i] = { isNew: true, start };
    } else if (kind === "added") {
      const start = newLen;
      newParts.push(text);
      newLen += text.length + 1;
      places[i] = { isNew: true, start };
    } else {
      const start = oldLen;
      oldParts.push(text);
      oldLen += text.length + 1;
      places[i] = { isNew: false, start };
    }
  }

  const newSpans = newParts.length ? cachedTokenize(newParts.join("\n"), family) : [];
  const oldSpans = oldParts.length ? cachedTokenize(oldParts.join("\n"), family) : [];

  return places.map((place, index) => {
    if (!place) return [];
    return sliceLineSpans(place.isNew ? newSpans : oldSpans, place.start, texts[index].length);
  });
}
