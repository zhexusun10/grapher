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

test("Markdown links open outside the app and cannot be retargeted by model HTML", () => {
  const cache = new StreamingMarkdownCache();
  const output = cache.render('[文档](https://example.com/docs "标题") and [local](/workspace/file.md)', false);
  assert.match(output, /<a href="https:\/\/example.com\/docs" title="标题" target="_blank" rel="noopener noreferrer">文档<\/a>/);
  assert.match(output, /<a href="\/workspace\/file.md">local<\/a>/);
  assert.equal(sanitizeHtml('<a href="https://example.com" target="_self" rel="opener">x</a>'),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>');
});

test("GFM autolinks stop before Chinese punctuation and prose while keeping raw URL paths", () => {
  const cache = new StreamingMarkdownCache();
  const output = cache.render("参考 https://example.com/path。下一句，详见https://example.com/a即可使用\n\n"
    + "https://zh.wikipedia.org/wiki/中文。\n\nwww.example.com，更多", false);
  assert.match(output, /<a href="https:\/\/example.com\/path"[^>]*>https:\/\/example.com\/path<\/a>。下一句/);
  assert.match(output, /<a href="https:\/\/example.com\/a"[^>]*>https:\/\/example.com\/a<\/a>即可使用/);
  assert.match(output, /href="https:\/\/zh.wikipedia.org\/wiki\/%E4%B8%AD%E6%96%87"/);
  assert.match(output, /<a href="http:\/\/www.example.com"[^>]*>www.example.com<\/a>，更多/);
  assert.doesNotMatch(output, /%E3%80%82|%EF%BC%8C|%E5%8D%B3%E5%8F%AF/);
});
