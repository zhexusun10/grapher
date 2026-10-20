import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTokenUsage } from "../src/components/SessionTokenUsage.tsx";
import type { TokenUsage } from "../src/types.ts";
import { consumedTokenCount, formatCacheHitRate, formatTokenCount } from "../src/utils/tokenUsage.ts";
import { translate } from "../src/i18n/index.ts";

const usage: TokenUsage = {
  input: 12_000, output: 1_800, cacheRead: 4_000, cacheWrite: 200,
  reasoning: 600, totalTokens: 18_000,
};
const render = (value?: TokenUsage | null) => renderToStaticMarkup(createElement(SessionTokenUsage, { usage: value }));
const counters = [
  "total tokens", "input", "output", "cache read", "cache write", "reasoning",
  "provider total (incl. cache)",
];

test("session details show task tokens plus the provider total without changing the source", () => {
  const html = render(usage);
  for (const [label, value] of [
    ["total tokens", "14k"], ["input", "12k"], ["output", "1.8k"],
    ["cache read", "4k"], ["cache write", "0.2k"], ["reasoning", "0.6k"],
    ["provider total (incl. cache)", "18k"],
  ]) assert.ok(html.includes(`${label}: ${value}</p>`), html);
  assert.deepEqual(usage, { input: 12_000, output: 1_800, cacheRead: 4_000, cacheWrite: 200, reasoning: 600, totalTokens: 18_000 });
});

test("token counts use only k or M, with at most two decimals and automatic promotion", () => {
  for (const [count, expected] of [
    [0, "0k"], [1, "&lt;0.01k"], [9, "&lt;0.01k"], [10, "0.01k"],
    [100, "0.1k"], [999, "1k"], [1_000, "1k"], [12_345, "12.35k"],
    [999_994, "999.99k"], [999_995, "1M"], [1_000_000, "1M"],
    [1_234_567, "1.23M"], [1_000_000_000, "1000M"],
  ] as const) {
    const html = render({ ...usage, totalTokens: count });
    assert.ok(html.includes(`provider total (incl. cache): ${expected}</p>`), `${count}: ${html}`);
  }
});

test("task total is uncached input plus cache writes plus output", () => {
  const html = render(usage);
  assert.ok(html.includes("total tokens: 14k</p>"));
  assert.ok(html.includes("provider total (incl. cache): 18k</p>"));
  assert.equal(consumedTokenCount({ ...usage, cacheRead: 999_999 }), 14_000);
  assert.equal(consumedTokenCount({ ...usage, cacheWrite: 4_000 }), 17_800);
});

test("backend consumedTokens is preferred, with a fallback for legacy zeroes", () => {
  const html = render({ ...usage, consumedTokens: 20_000 });
  assert.ok(html.includes("total tokens: 20k</p>"), html);
  assert.equal(consumedTokenCount({ ...usage, consumedTokens: 20_000 }), 20_000);
  assert.equal(consumedTokenCount({ ...usage, consumedTokens: 0 }), 14_000);
  assert.equal(consumedTokenCount({ ...usage, consumedTokens: Number.NaN }), 14_000);
  assert.equal(consumedTokenCount({ ...usage, consumedTokens: 20_000, input: Number.NaN }), 20_000);
});

test("missing usage remains unknown rather than implying a zero-token session", () => {
  for (const value of [undefined, null]) {
    const html = render(value);
    for (const label of counters) assert.ok(html.includes(`${label}: —</p>`), html);
  }
});

test("reported zero counts remain visible as zero", () => {
  const html = render({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 });
  for (const label of counters) assert.ok(html.includes(`${label}: 0k</p>`), html);
});

test("legacy partial usage keeps available input/output and leaves unknown totals unknown", () => {
  const html = render({ input: 1_200, output: 300 } as TokenUsage);
  assert.ok(html.includes("total tokens: 1.5k</p>"));
  assert.ok(html.includes("input: 1.2k</p>"));
  assert.ok(html.includes("output: 0.3k</p>"));
  for (const label of ["cache read", "cache write", "reasoning", "provider total (incl. cache)"]) {
    assert.ok(html.includes(`${label}: —</p>`), html);
  }
});

test("invalid counters never render NaN, infinity, negative or fractional token counts", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const html = render({ ...usage, totalTokens: value });
    assert.ok(html.includes("total tokens: 14k</p>"), html);
    assert.ok(html.includes("provider total (incl. cache): —</p>"), html);
  }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.equal(consumedTokenCount({ ...usage, input: value, output: 1 }), undefined);
    assert.equal(consumedTokenCount({ ...usage, cacheWrite: value }), undefined);
  }
});

test("cached percentage measures cache reads against all input, not output or total tokens", () => {
  const cached: TokenUsage = { input: 100, cacheRead: 900, cacheWrite: 0, output: 2_000, reasoning: 500, totalTokens: 3_000 };
  assert.equal(formatCacheHitRate(cached), "90%");
  assert.equal(formatCacheHitRate({ ...cached, output: 100_000, reasoning: 10_000, totalTokens: 101_000 }), "90%");
});

test("cache writes count as input but not cache hits, and percentages round to whole numbers", () => {
  assert.equal(formatCacheHitRate({ ...usage, input: 100, cacheRead: 900, cacheWrite: 100 }), "82%");
  assert.equal(formatCacheHitRate({ ...usage, input: 0, cacheRead: 900, cacheWrite: 100 }), "90%");
});

test("zero input and cache misses show 0 percent; fully cached input shows 100 percent", () => {
  assert.equal(formatCacheHitRate({ ...usage, input: 0, cacheRead: 0, cacheWrite: 0 }), "0%");
  assert.equal(formatCacheHitRate({ ...usage, input: 100, cacheRead: 0, cacheWrite: 0 }), "0%");
  assert.equal(formatCacheHitRate({ ...usage, input: 0, cacheRead: 100, cacheWrite: 0 }), "100%");
});

test("unknown or invalid cache counters never manufacture a percentage", () => {
  assert.equal(formatCacheHitRate(undefined), "—");
  assert.equal(formatCacheHitRate(null), "—");
  for (const field of ["input", "cacheRead", "cacheWrite"] as const) {
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      assert.equal(formatCacheHitRate({ ...usage, [field]: value } as TokenUsage), "—");
    }
  }
  assert.equal(formatCacheHitRate({ ...usage, input: Number.MAX_SAFE_INTEGER, cacheRead: 1 }), "—");
});

test("completed run copy includes compact task tokens and cached percentage in both locales", () => {
  const key = "运行已完成 - 本次消耗 Token:{0} Cached:{1}";
  const total = formatTokenCount(999_900_000);
  const cached = formatCacheHitRate({ ...usage, input: 100, cacheRead: 900, cacheWrite: 0 });
  assert.equal(translate("zh-CN", key, total, cached), "运行已完成 - 本次消耗 Token:999.9M Cached:90%");
  assert.equal(translate("en", key, total, cached), "Run completed - Tokens used: 999.9M  cached:90%");
});
