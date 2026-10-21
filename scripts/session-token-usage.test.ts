import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTokenUsage } from "../src/components/SessionTokenUsage.tsx";
import { addTokenUsage, executionSessionUsageThrough, plannerLegacyUsage, plannerSessionUsageThrough } from "../src/services/sessionMetrics.ts";
import type { Execution, PlanningSummary, SessionContext, TokenUsage } from "../src/types.ts";
import { attemptSessionContext, consumedTokenCount, formatCacheHitRate, formatContextUsage, formatTokenCount, sessionContext, sessionTokenUsage } from "../src/utils/tokenUsage.ts";
import { translate } from "../src/i18n/index.ts";

const usage: TokenUsage = {
  input: 12_000, output: 1_800, cacheRead: 4_000, cacheWrite: 200,
  reasoning: 600, totalTokens: 18_000,
};
const render = (value?: TokenUsage | null, context?: SessionContext | null) =>
  renderToStaticMarkup(createElement(SessionTokenUsage, { usage: value, context }));
const counters = [
  "total tokens", "input", "output", "cache read", "cache write", "reasoning",
  "context window",
];

test("session details show session tokens and context window without a provider total", () => {
  const html = render(usage, { tokens: 8_000, peak: 9_000, window: 100_000 });
  for (const [label, value] of [
    ["total tokens", "14k"], ["input", "12k"], ["output", "1.8k"],
    ["cache read", "4k"], ["cache write", "0.2k"], ["reasoning", "0.6k"],
    ["context window", "8k / 100k (8%)"],
  ]) assert.ok(html.includes(`${label}: ${value}</p>`), html);
  // The high-water mark is recorded for diagnostics, not shown beside the window.
  assert.ok(!html.includes("peak:"), html);
  // Cache re-reads are shown per category; the summed provider total is gone.
  assert.ok(!html.includes("provider total"), html);
  assert.deepEqual(usage, { input: 12_000, output: 1_800, cacheRead: 4_000, cacheWrite: 200, reasoning: 600, totalTokens: 18_000 });
});

test("a compacted prompt never renders a peak or a zero context", () => {
  // After compaction the newest prompt shrank; only the current reading shows.
  const html = render(usage, { tokens: 8_000, peak: 40_000, window: 100_000 });
  assert.ok(html.includes("context window: 8k / 100k (8%)</p>"), html);
  assert.ok(!html.includes("peak:"), html);
  // A zero or missing prompt is unknown, never "0k".
  for (const context of [{ tokens: 0, peak: 40_000 }, { tokens: 0, peak: 0 }, undefined]) {
    assert.ok(render(usage, context).includes("context window: —</p>"), JSON.stringify(context));
  }
});

test("token counts use only k or M, with at most two decimals and automatic promotion", () => {
  for (const [count, expected] of [
    [0, "0k"], [1, "<0.01k"], [9, "<0.01k"], [10, "0.01k"],
    [100, "0.1k"], [999, "1k"], [1_000, "1k"], [12_345, "12.35k"],
    [999_994, "999.99k"], [999_995, "1M"], [1_000_000, "1M"],
    [1_234_567, "1.23M"], [1_000_000_000, "1000M"],
  ] as const) assert.equal(formatTokenCount(count), expected);
  const html = render(usage, { tokens: 1_234_567, peak: 1_234_567, window: 2_000_000 });
  assert.ok(html.includes("context window: 1.23M / 2M (62%)</p>"), html);
});

test("context compares the newest prompt against the model window", () => {
  assert.equal(formatContextUsage({ tokens: 87_323, peak: 87_323, window: 922_000 }), "87.32k / 922k (9%)");
  assert.equal(formatContextUsage({ tokens: 87_323, peak: 87_323 }), "87.32k");
  assert.equal(formatContextUsage({ tokens: 922_000, peak: 922_000, window: 922_000 }), "922k / 922k (100%)");
  assert.equal(formatContextUsage({ tokens: 0, peak: 0, window: 922_000 }), "—");
  // An unknown or nonsensical window drops the denominator, never the reading.
  for (const window of [null, undefined, 0, -1, Number.NaN, 1.5]) {
    assert.equal(formatContextUsage({ tokens: 5_000, peak: 5_000, window: window as number }), "5k");
  }
  for (const tokens of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    assert.equal(formatContextUsage({ tokens: tokens as number, peak: 0, window: 100_000 }), "—");
  }
  assert.equal(formatContextUsage(undefined), "—");
});

test("task total is uncached input plus cache writes plus output", () => {
  const html = render(usage);
  assert.ok(html.includes("total tokens: 14k</p>"));
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
  const html = render({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 }, { tokens: 0, peak: 0, window: 100_000 });
  for (const label of counters.slice(0, 6)) assert.ok(html.includes(`${label}: 0k</p>`), html);
  assert.ok(html.includes("context window: —</p>"), html);
});

test("legacy partial usage keeps available input/output and leaves unknown totals unknown", () => {
  const html = render({ input: 1_200, output: 300 } as TokenUsage);
  assert.ok(html.includes("total tokens: 1.5k</p>"));
  assert.ok(html.includes("input: 1.2k</p>"));
  assert.ok(html.includes("output: 0.3k</p>"));
  for (const label of ["cache read", "cache write", "reasoning", "context window"]) {
    assert.ok(html.includes(`${label}: —</p>`), html);
  }
});

test("invalid counters never render NaN, infinity, negative or fractional token counts", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const html = render({ ...usage, totalTokens: value });
    assert.ok(html.includes("total tokens: 14k</p>"), html);
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

test("session details show the whole session, so a resumed turn keeps prior usage", () => {
  // The backend folds both Executions of one resumed Pi session together, while
  // an edited branch starts a second session with its own totals.
  const resumed: TokenUsage = { input: 15_000, output: 2_300, cacheRead: 14_000, cacheWrite: 200, reasoning: 700, totalTokens: 31_500, consumedTokens: 17_500 };
  const forked: TokenUsage = { ...usage, consumedTokens: 14_000 };
  const sessionUsage = { "session-a": resumed, "session-b": forked };

  const html = render(sessionTokenUsage(sessionUsage, "session-a"), sessionContext({ "session-a": { tokens: 9_000, peak: 9_000, window: 200_000 } }, "session-a"));
  assert.ok(html.includes("total tokens: 17.5k</p>"), html);
  assert.ok(html.includes("input: 15k</p>"), html);
  assert.ok(html.includes("output: 2.3k</p>"), html);
  assert.ok(html.includes("context window: 9k / 200k (5%)</p>"), html);
  assert.equal(sessionTokenUsage(sessionUsage, "session-b"), forked);
});

test("session lookups never invent totals for missing or forged session ids", () => {
  const sessionUsage = { "session-a": usage };
  const sessionContexts = { "session-a": { tokens: 500, peak: 500 } };
  assert.equal(sessionTokenUsage(sessionUsage, "session-a"), usage);
  assert.equal(sessionContext(sessionContexts, "session-a")?.tokens, 500);
  for (const id of [undefined, null, "", "missing", "toString", "__proto__"]) {
    assert.equal(sessionTokenUsage(sessionUsage, id), undefined);
    assert.equal(sessionContext(sessionContexts, id), undefined);
    assert.equal(sessionTokenUsage(undefined, "session-a"), undefined);
    assert.equal(sessionContext(undefined, "session-a"), undefined);
  }
});

test("completed run copy includes compact task tokens and cached percentage in both locales", () => {
  const key = "运行已完成 - 本次消耗 Token:{0} Cached:{1}";
  const total = formatTokenCount(999_900_000);
  const cached = formatCacheHitRate({ ...usage, input: 100, cacheRead: 900, cacheWrite: 0 });
  assert.equal(translate("zh-CN", key, total, cached), "运行已完成 - 本次消耗 Token:999.9M Cached:90%");
  assert.equal(translate("en", key, total, cached), "Run completed - Tokens used: 999.9M  cached:90%");
});

const sessionUsage = (input: number, output: number): TokenUsage => ({
  input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: input + output, consumedTokens: input + output,
});
const attempt = (id: string, sessionId: string, startedAt: number, usage?: TokenUsage): Execution => ({
  id, node: "node", revision: 1, attempt: 1, sessionId, worktree: "", before: "", after: null,
  status: "completed", output: "", startedAt, completedAt: startedAt + 1_000,
  metrics: usage ? { durationSeconds: 1, assistantMessages: 1, tools: 0, toolErrors: 0, usage } : null,
});
const plannerTurn = (planningId: string, sessionId: string, usage?: TokenUsage): PlanningSummary => ({
  planningId, roles: usage ? { planner: {
    model: "planner/model", sessionId, durationSeconds: 1, assistantMessages: 1, tools: 0, toolErrors: 0, usage,
  } } : {}, totalPlanningDuration: 1, modelDuration: 1,
});

test("an older attempt shows only the session usage through that attempt", () => {
  const first = attempt("first", "session-a", 1_000, sessionUsage(1_000, 100));
  const second = attempt("second", "session-a", 2_000, sessionUsage(2_000, 200));
  const forked = attempt("forked", "session-b", 3_000, sessionUsage(9_000, 900));

  const throughFirst = executionSessionUsageThrough([second, forked, first], first);
  assert.equal(throughFirst.latest, false);
  assert.equal(throughFirst.complete, true);
  assert.equal(throughFirst.usage?.input, 1_000);
  assert.equal(throughFirst.usage?.consumedTokens, 1_100);

  const throughLatest = executionSessionUsageThrough([second, forked, first], second);
  assert.equal(throughLatest.latest, true);
  assert.equal(throughLatest.usage?.input, 3_000);
  assert.equal(throughLatest.usage?.output, 300);

  // The forked session never inherits the abandoned branch's attempts.
  const forkedUsage = executionSessionUsageThrough([second, forked, first], forked);
  assert.equal(forkedUsage.usage?.input, 9_000);
  assert.equal(forkedUsage.latest, true);
});

test("a missing attempt usage omits the prefix instead of under-reporting", () => {
  const first = attempt("first", "session-a", 1_000);
  const second = attempt("second", "session-a", 2_000, sessionUsage(2_000, 200));
  const throughSecond = executionSessionUsageThrough([first, second], second);
  assert.equal(throughSecond.latest, true);
  assert.equal(throughSecond.complete, false);
  assert.equal(throughSecond.usage, undefined);
  assert.equal(executionSessionUsageThrough([first], first).complete, false);
  assert.equal(executionSessionUsageThrough([], undefined).latest, false);
});

test("an older Planner turn shows only its session usage prefix", () => {
  const first = plannerTurn("turn-1", "planner-a", sessionUsage(40, 4));
  const second = plannerTurn("turn-2", "planner-a", sessionUsage(60, 6));
  const old = plannerTurn("old", "planner-b", sessionUsage(999, 99));

  const throughFirst = plannerSessionUsageThrough([old, first, second], "turn-1");
  assert.equal(throughFirst.latest, false);
  assert.equal(throughFirst.complete, true);
  assert.equal(throughFirst.usage?.input, 40);
  assert.equal(throughFirst.usage?.consumedTokens, 44);

  const throughSecond = plannerSessionUsageThrough([old, first, second], "turn-2");
  assert.equal(throughSecond.latest, true);
  assert.equal(throughSecond.usage?.input, 100);

  // A live turn not recorded yet falls back to the backend session total.
  const live = plannerSessionUsageThrough([old, first], null);
  assert.equal(live.latest, true);
  assert.equal(live.complete, false);
  assert.equal(live.usage, undefined);

  // Missing usage makes the prefix unknowable.
  const missing = plannerSessionUsageThrough([plannerTurn("bad", "planner-a"), second], "turn-2");
  assert.equal(missing.complete, false);
  assert.equal(missing.usage, undefined);
});

test("Planner turns recorded before session tracking stay in the newest total", () => {
  const legacy = plannerTurn("legacy", "legacy-id", sessionUsage(5_000, 100));
  legacy.roles.planner!.sessionId = undefined;
  const current = plannerTurn("current", "planner-a", sessionUsage(3_000, 200));
  const turns = [legacy, current];

  // The backend cannot bucket the legacy turn, but it is part of the
  // conversation shown in the panel, so its usage is added back.
  assert.equal(plannerLegacyUsage(turns, "current")?.input, 5_000);
  assert.equal(plannerSessionUsageThrough(turns, "current").usage?.input, 8_000);
  const total = addTokenUsage(sessionUsage(3_000, 200), plannerLegacyUsage(turns, "current")!);
  assert.equal(total.input, 8_000);
  assert.equal(total.output, 300);
  assert.equal(total.consumedTokens, 8_300);

  // No legacy turns means nothing to add; an unknown legacy usage is omitted
  // rather than contributing a partial sum.
  assert.equal(plannerLegacyUsage([current], "current"), undefined);
  assert.equal(plannerLegacyUsage([plannerTurn("bad", "legacy-id"), current], "current"), undefined);
});

test("an unknowable usage prefix hides token rows but keeps a known context", () => {
  const html = renderToStaticMarkup(createElement(SessionTokenUsage, {
    context: { tokens: 8_000, peak: 9_000 }, showTokens: false,
  }));
  assert.ok(html.includes("context window: 8k</p>"), html);
  assert.ok(!html.includes("peak:"), html);
  assert.ok(!html.includes("total tokens:"), html);
  assert.ok(!html.includes("cache read:"), html);
  // Nothing known at all means the section does not reserve blank rows.
  assert.equal(renderToStaticMarkup(createElement(SessionTokenUsage, { showTokens: false })), "");
});

test("attempt context is the attempt's own snapshot, not the session's newest", () => {
  assert.deepEqual(attemptSessionContext({ contextTokens: 8_000, contextPeak: 9_000 }), { tokens: 8_000, peak: 9_000 });
  assert.deepEqual(attemptSessionContext({ contextTokens: 0, contextPeak: 9_000 }), { tokens: 0, peak: 9_000 });
  // Legacy attempts report no context counters; do not invent a zero reading.
  for (const metrics of [null, undefined, {}, { contextTokens: 0, contextPeak: 0 }]) {
    assert.equal(attemptSessionContext(metrics), undefined);
  }
});
