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

test("Workspace Markdown images stay inert until resolved by their conversation", () => {
  const cache = new StreamingMarkdownCache();
  const markdown = '![截图](artifacts/user-preview-current/screenshots/01-main-menu.png)\n\n'
    + '![中文](<./artifacts/中文 space/截图.png>)\n\n'
    + '![工作区临时](.tmp/card-preview.png)\n\n'
    + '![系统临时](/tmp/compacted-card-preview.png)\n\n'
    + '![macOS 临时](/private/tmp/sub/card-preview.png)\n\n'
    + '![文件协议临时](file:///tmp/中文%20space/截图.png)';
  for (const streaming of [true, false]) {
    const output = cache.render(markdown, streaming);
    assert.match(output, /data-workspace-path="artifacts\/user-preview-current\/screenshots\/01-main-menu\.png"/);
    assert.match(output, /data-workspace-path="artifacts\/中文 space\/截图\.png"/);
    assert.match(output, /data-workspace-path="\.tmp\/card-preview\.png"/);
    assert.match(output, /data-workspace-path="\/tmp\/compacted-card-preview\.png"/);
    assert.match(output, /data-workspace-path="\/tmp\/sub\/card-preview\.png"/);
    assert.match(output, /data-workspace-path="\/tmp\/中文 space\/截图\.png"/);
    assert.doesNotMatch(output, /\ssrc=/, "workspace paths must not generate browser GETs");
  }
  for (const src of ['/api/control', '/etc/passwd', '/tmp', '/tmp/', '/tmp/../etc/passwd',
    '/tmp/%2e%2e/etc/passwd', '/tmp//preview.png', '/tmp/.git/a.png', '/tmp/.grapher/a.png',
    'file:///etc/passwd', 'file://evil.test/tmp/a.png', '//tmp/a.png',
    '../outside.png', '%2e%2e/outside.png', 'C:\\outside.png',
    '//evil.test/image.png', 'data:image/svg+xml,evil', 'blob:https://example.test/forged', '.git/image.png', '.grapher/image.png']) {
    const output = sanitizeHtml(`<img src="${src}" data-workspace-path="forged.png" onerror="evil()" alt="preview">`);
    assert.doesNotMatch(output, /<img|data-workspace-path|\ssrc=|onerror/, src);
  }
  assert.equal(sanitizeHtml('<img data-workspace-path="forged.png" alt="preview">'), '<span>preview</span>');
});

test("Markdown links open outside the app and cannot be retargeted by model HTML", () => {
  const cache = new StreamingMarkdownCache();
  const output = cache.render('[文档](https://example.com/docs "标题") and [local](/workspace/file.md)', false);
  assert.match(output, /<a href="https:\/\/example.com\/docs" title="标题" target="_blank" rel="noopener noreferrer">文档<\/a>/);
  // A workspace path is not a URL: rendering it as an anchor would navigate the
  // Grapher tab (and drop the Run), so it degrades to plain text with the path.
  assert.doesNotMatch(output, /<a href="\/workspace\/file.md"/);
  // Latin link text keeps ASCII parentheses; CJK prose gets the full-width pair.
  assert.match(output, /local\(\/workspace\/file\.md\)/);
  assert.equal(sanitizeHtml('<a href="https://example.com" target="_self" rel="opener">x</a>'),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>');
});

test("Workspace paths degrade to readable text and raw-HTML paths stay inert", () => {
  const cache = new StreamingMarkdownCache();
  const output = cache.render('[下一步探索文档](docs/strategy_exploration_next_steps.md)\n\n'
    + '[`reports/a.md`](../reports/a.md)\n\n[跳转](#section-1)\n\n[mail](mailto:a@b.test)', false);
  assert.match(output, /下一步探索文档（docs\/strategy_exploration_next_steps\.md）/);
  assert.match(output, /<code>reports\/a\.md<\/code>\(\.\.\/reports\/a\.md\)/);
  assert.match(output, /<a href="#section-1">跳转<\/a>/);
  assert.match(output, /<a href="mailto:a@b\.test">mail<\/a>/);
  assert.doesNotMatch(output, /href="docs\/|href="\.\.\/reports/);
  // Raw model HTML cannot reintroduce the same navigation, and it keeps no
  // link styling either: only the text survives.
  assert.equal(sanitizeHtml('<a href="docs/x.md">x</a>'), '<span>x</span>');
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
