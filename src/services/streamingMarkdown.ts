import { marked, type Token } from "marked";
import { shareJson } from "./structuralSharing";

export function sanitizeHtml(html: string): string {
  return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/href\s*=\s*(['"])\s*(javascript:|data:text\/html)/gi, "href=$1#blocked");
}

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
