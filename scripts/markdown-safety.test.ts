import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeHtml, StreamingMarkdownCache } from "../src/services/streamingMarkdown.ts";

const attacks = [
  '<img src="x" onerror="window.pwned=1">',
  '<svg onload="window.pwned=1"><a xlink:href="javascript:alert(1)">x</a></svg>',
  '<math><mtext><img src=x onerror="window.pwned=1"></mtext></math>',
  '<iframe srcdoc="<script>window.pwned=1</script>"></iframe>',
  '<object data="data:text/html,evil"></object><embed src="evil">',
  '<a href="javascript:alert(1)">link</a>',
  '<a href="&#x6a;avascript:alert(1)">link</a>',
  '<a href="java&#x09;script:alert(1)">link</a>',
  '<a href="data:text/html,evil">link</a>',
  '<img src="data:image/svg+xml,evil"><div style="background:url(javascript:evil)" onclick="evil()">x</div>',
  '<form action="/api/control"><button formaction="javascript:evil()">x</button></form>',
];

test("Markdown allowlist rejects executable markup, encoded URLs and event handlers", () => {
  for (const input of attacks) {
    const output = sanitizeHtml(input);
    assert.doesNotMatch(output, /<\/?(?:script|iframe|object|embed|svg|math|form|button)\b/i, input);
    assert.doesNotMatch(output, /\s(?:on\w+|style|srcdoc|action|formaction)\s*=/i, input);
    assert.doesNotMatch(output, /(?:href|src)\s*=\s*["'](?:javascript:|data:)/i, input);
  }
});

test("Markdown streaming prefixes and replay remain sanitized", () => {
  for (const input of attacks) {
    const cache = new StreamingMarkdownCache();
    for (let end = 0; end <= input.length; end++) {
      assert.doesNotMatch(cache.render(input.slice(0, end), true), /<[^>]*\s(?:onerror|onload|onclick|onfocus)\s*=/i);
    }
    assert.doesNotMatch(cache.render(input, false), /<[^>]*\s(?:onerror|onload|onclick|onfocus)\s*=/i);
  }
});

test("Markdown allowlist preserves useful formatting, code, links, images and inert task lists", () => {
  const cache = new StreamingMarkdownCache();
  const output = cache.render('# 标题\n\n[Docs](https://example.test/docs)\n\n![图](https://example.test/a.png)\n\n```ts\nconst html = "<script>";\n```\n\n- [x] done\n- [ ] todo\n\n| a | b |\n|:-|--:|\n| 1 | 2 |\n', false);
  assert.match(output, /<h1>标题<\/h1>/);
  assert.match(output, /href="https:\/\/example.test\/docs"/);
  assert.match(output, /src="https:\/\/example.test\/a.png"/);
  assert.match(output, /class="language-ts"/);
  assert.match(output, /&lt;script&gt;/);
  assert.match(output, /<table>/);
  assert.match(output, /type="checkbox" disabled checked/);
  assert.match(output, /type="checkbox" disabled/);
  assert.equal(sanitizeHtml('<input type="text" autofocus onfocus="evil()">'), '<input type="checkbox" disabled />');
});
