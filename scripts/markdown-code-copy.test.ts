import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownRenderer } from "../src/components/MarkdownRenderer.tsx";

const render = (content: string, streaming = false) => renderToStaticMarkup(createElement(MarkdownRenderer, {
  content, isStreaming: streaming, streamingCursor: streaming,
}));
const buttons = (html: string) => (html.match(/class="code-copy-btn"/g) ?? []).length;

test("inline code and ordinary text do not get block copy controls", () => {
  const html = render("Run `pwd` and inspect the result.");
  assert.equal(buttons(html), 0);
  assert.ok(html.includes("<code>pwd</code>"));
});

test("fenced and indented blocks each get an accessible copy button without changing code", () => {
  const html = render('```bash\nprintf "<tag> & 中文"\n```\n\n```\npwd\n```\n\n    echo indented\n');
  assert.equal(buttons(html), 3);
  assert.equal((html.match(/class="code-block-wrapper"/g) ?? []).length, 3);
  assert.ok(html.includes('<code class="language-bash">printf &quot;&lt;tag&gt; &amp; 中文&quot;\n</code>'));
  assert.ok(html.includes("<code>pwd\n</code>"));
  assert.ok(html.includes("<code>echo indented\n</code>"));
  assert.equal((html.match(/type="button"/g) ?? []).length, 3);
  assert.equal((html.match(/aria-label=/g) ?? []).length, 3);
});

test("unfinished streamed fences remain copyable without including the cursor in code text", () => {
  const html = render("```sh\necho streaming", true);
  assert.equal(buttons(html), 1);
  assert.ok(html.includes('echo streaming\n<span class="thinking-streaming-cursor"></span></code>'));
});

test("nested and tilde fenced blocks get one copy button per block", () => {
  const html = render("> ```sh\n> echo nested\n> ```\n\n~~~python\nprint(1)\n~~~\n");
  assert.equal(buttons(html), 2);
  assert.ok(html.includes('class="language-sh"'));
  assert.ok(html.includes('class="language-python"'));
});

test("HTML-looking code stays escaped rather than becoming executable markup", () => {
  const html = render('```html\n<script>alert("x")</script>\n<button onclick="bad()">text</button>\n```');
  assert.equal(buttons(html), 1);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes('onclick="bad()"'));
  assert.ok(html.includes("&lt;script&gt;"));
});
