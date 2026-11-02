import katex from "katex";
import { marked, type Token, type Tokens, type TokenizerAndRendererExtension } from "marked";
import sanitize from "sanitize-html";
import { shareJson } from "./structuralSharing";

// Model output and replayed transcripts are untrusted HTML. Parse with an
// allowlist rather than trying to recognize executable markup with regexes.
export function sanitizeHtml(html: string): string {
  const clean = sanitize(html, {
    allowedTags: [...sanitize.defaults.allowedTags, "img", "details", "summary", "input"],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height"],
      code: ["class"],
      span: ["class"],
      div: ["class"],
      th: ["align"],
      td: ["align"],
      ol: ["start"],
      input: ["type", "checked", "disabled"],
    },
    allowedClasses: { code: ["language-*"], span: ["grapher-math"], div: ["grapher-math-block"] },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowProtocolRelative: false,
    transformTags: {
      // A model link must not navigate the Grapher tab away from the current
      // Run. Open absolute web links outside the app and never trust a
      // model-supplied target/rel pair; relative links stay in the document.
      a: (_tag, attributes) => {
        const { target: _target, rel: _rel, ...attribs } = attributes;
        return /^https?:\/\//i.test(attribs.href || "")
          ? { tagName: "a", attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" } }
          : { tagName: "a", attribs };
      },
      // Preserve GFM task lists without allowing interactive HTML inputs.
      input: (_tag, attributes) => ({ tagName: "input", attribs: {
        type: "checkbox", disabled: "",
        ...(Object.hasOwn(attributes, "checked") ? { checked: "" } : {}),
      } }),
    },
  });
  return renderMathPlaceholders(clean);
}

// Math is replaced with a plain placeholder during Markdown parsing, then
// rendered from the decoded TeX after the untrusted HTML allowlist has run.
// This keeps KaTeX's MathML/SVG output out of the general HTML allowlist.
const mathHtmlCache = new Map<string, string>();

function encodeMathSource(source: string): string {
  try {
    return encodeURIComponent(source);
  } catch {
    // A lone surrogate cannot be URI-encoded. Replacing it keeps rendering
    // deterministic instead of failing the whole Markdown block.
    return encodeURIComponent(source.replace(/[\uD800-\uDFFF]/g, "\uFFFD"));
  }
}

function escapeMathSource(source: string): string {
  return source
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function mathPlaceholder(source: string, displayMode: boolean, tag: "span" | "div"): string {
  const className = tag === "span" ? "grapher-math" : "grapher-math-block";
  return `<${tag} class="${className}">${displayMode ? "1" : "0"}${encodeMathSource(source)}</${tag}>`;
}

function renderMath(source: string, displayMode: boolean): string {
  const tex = source.trim();
  if (!tex) return "";
  const key = `${displayMode ? "1" : "0"}${tex}`;
  const cached = mathHtmlCache.get(key);
  if (cached !== undefined) return cached;
  let html: string;
  try {
    html = katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      maxSize: 50,
      maxExpand: 1000,
    });
  } catch {
    html = `<span class="math-error">${escapeMathSource(tex)}</span>`;
  }
  // Formula-heavy transcripts are long-lived; keep the hot set bounded.
  if (mathHtmlCache.size >= 256) mathHtmlCache.clear();
  mathHtmlCache.set(key, html);
  return html;
}

function renderMathPlaceholders(html: string): string {
  if (!html.includes("grapher-math")) return html;
  const replace = (payload: string): string => {
    if (!/^[01]/.test(payload)) return "";
    try {
      return renderMath(decodeURIComponent(payload.slice(1)), payload[0] === "1");
    } catch {
      return "";
    }
  };
  return html
    .replace(/<span class="grapher-math">([^<]*)<\/span>/g, (_match, payload: string) => replace(payload))
    .replace(/<div class="grapher-math-block">([^<]*)<\/div>/g, (_match, payload: string) => replace(payload));
}

function findUnescapedDelimiter(src: string, from: number, delimiter: string): number {
  for (let index = from; index < src.length; index++) {
    if (src[index] === "\\") { index++; continue; }
    if (src.startsWith(delimiter, index)) return index;
  }
  return -1;
}

function tokenizeMathBlock(src: string): Tokens.Generic | undefined {
  const opening = /^ {0,3}\$\$/.exec(src);
  if (!opening) return;
  const start = opening[0].length;
  const close = findUnescapedDelimiter(src, start, "$$");
  if (close === -1) return;
  const end = close + 2;
  const lineEnd = src.indexOf("\n", end);
  const trailing = src.slice(end, lineEnd === -1 ? undefined : lineEnd);
  // A block delimiter owns the rest of its line. Mid-line $$...$$ stays
  // inline so surrounding prose keeps its paragraph.
  if (!/^[ \t]*$/.test(trailing)) return;
  const text = src.slice(start, close);
  if (!text.trim()) return;
  return {
    type: "mathBlock",
    raw: lineEnd === -1 ? src : src.slice(0, lineEnd + 1),
    text,
    displayMode: true,
  };
}

function startMathBlock(src: string): number | undefined {
  const lineStart = /(?:^|\n) {0,3}\$\$/g;
  const match = lineStart.exec(src);
  if (!match) return;
  return match.index + match[0].lastIndexOf("$$");
}

function tokenizeMathInline(src: string): Tokens.Generic | undefined {
  if (src[0] !== "$") return;
  if (src.startsWith("$$")) {
    const close = findUnescapedDelimiter(src, 2, "$$");
    if (close === -1) return;
    const text = src.slice(2, close);
    if (!text.trim()) return;
    return {
      type: "mathInline",
      raw: src.slice(0, close + 2),
      text,
      displayMode: true,
    };
  }
  // Single-dollar math follows the common Markdown convention: no leading or
  // trailing whitespace and no closing delimiter before a digit (currencies).
  if (src.length < 3 || /\s/.test(src[1])) return;
  for (let index = 1; index < src.length; index++) {
    const char = src[index];
    if (char === "\\") { index++; continue; }
    if (char === "\n" || char === "$" && (/\s/.test(src[index - 1]) || /\d/.test(src[index + 1] ?? ""))) return;
    if (char !== "$") continue;
    return {
      type: "mathInline",
      raw: src.slice(0, index + 1),
      text: src.slice(1, index),
      displayMode: false,
    };
  }
}

function startMathInline(src: string): number | undefined {
  for (let index = 0; index < src.length; index++) {
    if (src[index] === "\\") { index++; continue; }
    if (src[index] === "$") return index;
  }
}

const mathExtensions: TokenizerAndRendererExtension[] = [
  {
    name: "mathBlock",
    level: "block",
    start: startMathBlock,
    tokenizer: tokenizeMathBlock,
    renderer(token) { return mathPlaceholder(String(token.text), true, "div"); },
  },
  {
    name: "mathInline",
    level: "inline",
    start: startMathInline,
    tokenizer: tokenizeMathInline,
    renderer(token) { return mathPlaceholder(String(token.text), Boolean(token.displayMode), "span"); },
  },
];

marked.use({ extensions: mathExtensions });

// Marked's GFM autolink consumes every non-space character. In Chinese prose
// that turns the sentence punctuation and following words into the URL. Stop at
// Unicode punctuation/symbols, and at CJK text unless it continues a raw path
// or query segment (for example /wiki/中文 or ?q=中文).
const unicodeLinkBoundary = /[\p{P}\p{S}\p{Z}]/u;
const unicodeSegmentDelimiter = /[/=?&#.]/;

function trimBareAutolink(token: Tokens.Link): Tokens.Link {
  if (!token.autolink) return token;
  const raw = token.raw;
  let end = raw.length;
  let inUnicodeSegment = false;
  for (let index = 0; index < raw.length;) {
    const codePoint = raw.codePointAt(index)!;
    if (codePoint < 0x80) { index++; continue; }
    const char = String.fromCodePoint(codePoint);
    if (unicodeLinkBoundary.test(char)) { end = index; break; }
    if (!inUnicodeSegment && unicodeSegmentDelimiter.test(raw[index - 1] ?? "")) inUnicodeSegment = true;
    if (!inUnicodeSegment) { end = index; break; }
    index += char.length;
  }
  if (end === raw.length) return token;
  const text = raw.slice(0, end);
  if (!/^(?:https?:\/\/|ftp:\/\/|www\.)/i.test(text)) return token;
  const prefix = token.href.endsWith(raw) ? token.href.slice(0, -raw.length) : "";
  return { ...token, raw: text, text, href: prefix + text, tokens: [{ type: "text", raw: text, text }] };
}

// Keep GFM autolinks intact for Latin prose, but give Chinese sentences a real
// boundary. The cache and a full marked parse share this tokenizer so streaming
// output remains byte-for-byte identical to a one-shot render.
function tokenizeBareLink(this: InstanceType<typeof marked.Tokenizer<string, string>>, src: string): Tokens.Link | undefined {
  const match = this.rules.inline.url.exec(src);
  if (!match) return;
  let text = match[0];
  let href: string;
  if (match[2] === "@") {
    href = "mailto:" + text;
  } else {
    // Reproduce marked's trailing-ASCII-punctuation backpedal.
    let previous: string;
    do {
      previous = match[0];
      match[0] = this.rules.inline._backpedal.exec(match[0])?.[0] ?? "";
    } while (previous !== match[0]);
    text = match[0];
    const prefix = match[1] === "www." ? "http://" : "";
    const bounded = trimBareAutolink({ type: "link", raw: text, text, href: prefix + text, autolink: true,
      tokens: [{ type: "text", raw: text, text }] });
    text = bounded.text;
    href = bounded.href;
  }
  if (!text) return;
  return { type: "link", raw: text, text, href, autolink: true, tokens: [{ type: "text", raw: text, text }] };
}

marked.use({ tokenizer: { url: tokenizeBareLink } });

export function repairStreamingMarkdown(text: string): string {
  const fences = /^(\s*)(`{3,}|~{3,})/mg;
  let match: RegExpExecArray | null, inside = false, chars = "";
  while ((match = fences.exec(text)) !== null) {
    if (!inside) { inside = true; chars = match[2]; }
    else if (match[2].startsWith(chars.slice(0, 3))) { inside = false; chars = ""; }
  }
  return inside ? text + `\n${chars}\n` : text;
}

type InlineEntry = { context: string; tokens: Token[]; state: InstanceType<typeof marked.Lexer>["state"] };
type BlockEntry = { token: Token; html: string };

/** Re-lex block structure so appended tables, setext headings and reference definitions
 * remain authoritative. Cache unchanged inline work and block HTML, not a guessed "stable"
 * source prefix. The result stays byte-for-byte equivalent to a full marked parse.
 */
export class StreamingMarkdownCache {
  private inline = new Map<string, InlineEntry[]>();
  private blocks = new Map<string, BlockEntry>();
  private links = "";
  readonly stats = { inlineCharacters: 0, parsedBlocks: 0 };

  render(content: string, streaming: boolean): string {
    const source = (streaming ? repairStreamingMarkdown(content) : content).replace(/\r\n|\r/g, "\n");
    const options = { ...marked.defaults, gfm: true, breaks: true };
    const lexer = new marked.Lexer(options);
    lexer.blockTokens(source, lexer.tokens);
    const links = JSON.stringify(lexer.tokens.links);
    if (links !== this.links) { this.inline.clear(); this.blocks.clear(); this.links = links; }
    const nextInline = new Map<string, InlineEntry[]>();
    for (const entry of lexer.inlineQueue) {
      // Loose task lists prefill a checkbox before inline lexing. Cache only
      // the appended tokens, or the next render would duplicate that prefix.
      const prefixLength = entry.tokens.length;
      const context = JSON.stringify([lexer.state, entry.tokens]);
      const cached = this.inline.get(entry.src)?.find(value => value.context === context);
      if (cached) {
        entry.tokens.push(...cached.tokens);
        Object.assign(lexer.state, cached.state);
      } else {
        lexer.inlineTokens(entry.src, entry.tokens);
        this.stats.inlineCharacters += entry.src.length;
      }
      const saved = { context, tokens: prefixLength ? entry.tokens.slice(prefixLength) : entry.tokens, state: { ...lexer.state } };
      const entries = nextInline.get(entry.src);
      if (entries) entries.push(saved); else nextInline.set(entry.src, [saved]);
    }
    this.inline = nextInline;
    const parser = new marked.Parser(options);
    const nextBlocks = new Map<string, BlockEntry>();
    const html: string[] = [];
    for (let index = 0; index < lexer.tokens.length; index++) {
      const token = lexer.tokens[index];
      // Marked joins adjacent text tokens into one paragraph; keep that exact rule.
      if (token.type === "text") {
        const group = [token];
        while (lexer.tokens[index + 1]?.type === "text") group.push(lexer.tokens[++index]);
        html.push(parser.parse(group));
        this.stats.parsedBlocks++;
        continue;
      }
      const key = `${token.type}\0${token.raw}`;
      const cached = this.blocks.get(key);
      const same = cached && shareJson(cached.token, token) === cached.token;
      const rendered = same ? cached.html : parser.parse([token]);
      if (!same) this.stats.parsedBlocks++;
      nextBlocks.set(key, { token: same ? cached.token : token, html: rendered });
      html.push(rendered);
    }
    this.blocks = nextBlocks;
    // Sanitize the joined HTML, not individual blocks: dangerous tags can span blocks.
    return sanitizeHtml(html.join(""));
  }
}
