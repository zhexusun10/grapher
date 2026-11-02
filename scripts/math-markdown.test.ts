import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";
import { sanitizeHtml, StreamingMarkdownCache, repairStreamingMarkdown } from "../src/services/streamingMarkdown.ts";

const formula = String.raw`\text{Robust Score} = 0.40 \times \text{Sharpe} + 0.30 \times \text{CAGR} - 0.20 \times \text{MDD} + 0.10 \times \text{Min Fold Sharpe} + 0.10 \times \text{Cost Retention}`;
const display = (tex: string) => "$$\n" + tex + "\n$$";
const fullMarkdown = (text: string, streaming: boolean) => sanitizeHtml(
  marked.parse(streaming ? repairStreamingMarkdown(text) : text, { gfm: true, breaks: true }) as string);
const render = (text: string, streaming = false) => new StreamingMarkdownCache().render(text, streaming);

test("display math renders KaTeX blocks instead of literal dollar delimiters", () => {
  for (const source of [display(formula), "$$" + formula + "$$"]) {
    const output = render(source);
    assert.match(output, /<span class="katex-display">/);
    assert.match(output, /<annotation encoding="application\/x-tex">/);
    assert.match(output, /Robust Score/);
    assert.doesNotMatch(output, /\$\$/);
    assert.doesNotMatch(output, /class="grapher-math/);
  }
});

test("inline math renders without turning surrounding prose into a formula", () => {
  const output = render("The value is $x^2 + y^2$ and stays inline.");
  assert.match(output, /^<p>The value is <span class="katex">/);
  assert.match(output, / and stays inline\.<\/p>/);
  assert.doesNotMatch(output, /katex-display/);
  assert.doesNotMatch(output, /\$x\^2/);
});

test("display math splits paragraphs and remains usable inside lists", () => {
  const output = render("Before\n$$\nx\n$$\nAfter");
  assert.match(output, /<p>Before<\/p>/);
  assert.match(output, /<span class="katex-display">/);
  assert.match(output, /<p>After<\/p>/);
  const list = render("- item\n\n  $$\n  x\n  $$");
  assert.match(list, /<li><p>item<\/p>/);
  assert.match(list, /<span class="katex-display">/);
});

test("code, escaped dollars and currency-like text stay untouched", () => {
  const output = render("`$x$`\n\n```\n$$\nx\n$$\n```\n\n    $$y$$\n\n" + String.raw`Costs \$5 and $6, not $5 and $6.`);
  assert.doesNotMatch(output, /katex/);
  assert.match(output, /<code>\$x\$<\/code>/);
  assert.match(output, /\$\$\nx\n\$\$/);
  assert.match(output, /\$\$y\$\$/);
  assert.match(output, /\$5 and \$6/);
});

test("math uses KaTeX's untrusted-input mode and cannot inject HTML", () => {
  const output = render(display(String.raw`\href{javascript:alert(1)}{x} \text{<img src=x onerror=alert(1)>}`));
  assert.doesNotMatch(output, /<a\b/i);
  assert.doesNotMatch(output, /<img\b/i);
  assert.doesNotMatch(output, /<script\b/i);
  assert.doesNotMatch(output, /href="javascript:/i);
  assert.match(output, /&lt;img/);
  // A model can spoof the internal placeholder, but its payload is still only
  // interpreted as TeX and rendered with trust disabled.
  const spoofed = sanitizeHtml('<span class="grapher-math">0%5Ctext%7B%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E%7D</span>');
  assert.doesNotMatch(spoofed, /<img\b|<script\b/i);
  assert.match(spoofed, /&lt;img/);
});

test("incremental math Markdown matches a full parse at every streaming prefix", () => {
  const cases = [
    display(formula),
    "Inline $x^2$ and $$y_1$$ text",
    "Code\n\n```\n$$\nx\n$$\n```\n\nInline `$x$`",
    "Intro\n$$\nx\n$$\nAfter",
    String.raw`Currency $5 and $6; escaped \$7`,
    "- item\n\n  $$\n  x\n  $$",
  ];
  for (const content of cases) {
    const cache = new StreamingMarkdownCache();
    for (let offset = 0; offset <= content.length; offset++) {
      const prefix = content.slice(0, offset);
      assert.equal(cache.render(prefix, true), fullMarkdown(prefix, true), `prefix ${offset}: ${JSON.stringify(content)}`);
    }
    assert.equal(cache.render(content, false), fullMarkdown(content, false));
  }
});
