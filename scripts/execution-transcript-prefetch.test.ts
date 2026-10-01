import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runtimeService } from "../src/services/runtime.ts";
import { ExecutionTranscript, executionTranscriptCache, prefetchExecutionTranscript } from "../src/components/ExecutionTranscript.tsx";
import { VirtualizedTranscript } from "../src/components/VirtualizedTranscript.tsx";
import { planningTranscriptCache } from "../src/components/PlanningActivity.tsx";
import { BoundedLruCache, utf8Bytes } from "../src/lib/BoundedLruCache.ts";
import type { Execution } from "../src/types.ts";

test("settled node requests share work and publish only complete history", async () => {
  const original = runtimeService.getExecutionOutput;
  const runId = "prefetch-test-run";
  const execution = { id: "prefetch-test-exec", node: "node", status: "done", outputBytes: 13 } as Execution;
  const offsets: number[] = [];
  let releaseSecond!: () => void;
  const secondPage = new Promise<void>(resolve => { releaseSecond = resolve; });
  runtimeService.getExecutionOutput = async (_runId, _execId, offset, _signal, full) => {
    assert.equal(full, true);
    offsets.push(offset);
    if (offset) await secondPage;
    return {
      runId, executionId: execution.id, content: offset ? "second\n" : "first\n",
      nextOffset: offset ? 13 : 6, totalBytes: 13, complete: Boolean(offset), status: "done",
    };
  };
  try {
    const first = prefetchExecutionTranscript(runId, execution);
    assert.equal(prefetchExecutionTranscript(runId, execution), first);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executionTranscriptCache.has(`${runId}:${execution.id}`), false);
    releaseSecond();
    assert.equal(await first, "first\nsecond\n");
    assert.deepEqual(offsets, [0, 6]);
    assert.equal(executionTranscriptCache.get(`${runId}:${execution.id}`)?.complete, true);
  } finally {
    releaseSecond(); runtimeService.getExecutionOutput = original;
    executionTranscriptCache.clear();
  }
});

test("aborted history never publishes stale text", async () => {
  const original = runtimeService.getExecutionOutput;
  const controller = new AbortController();
  const execution = { id: "abort", status: "done", outputBytes: 6 } as Execution;
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  runtimeService.getExecutionOutput = async () => {
    await response;
    return { runId: "old", executionId: "abort", content: "stale\n", nextOffset: 6, totalBytes: 6, complete: true, status: "done" };
  };
  try {
    const pending = prefetchExecutionTranscript("old", execution, controller.signal);
    controller.abort(); release(); await pending;
    assert.equal(executionTranscriptCache.has("old:abort"), false);
  } finally { release(); runtimeService.getExecutionOutput = original; }
});

test("LRU uses UTF-8 bytes, touches reads, replaces sizes and refuses oversized entries", () => {
  const cache = new BoundedLruCache<string, string>(utf8Bytes, 2, 12);
  assert.equal(utf8Bytes("中文🚀"), 10);
  assert.equal(utf8Bytes("\ud800"), new TextEncoder().encode("\ud800").length);
  cache.set("a", "中文").set("b", "abc");
  assert.equal(cache.byteSize, 9);
  cache.get("a"); cache.set("c", "🚀");
  assert.equal(cache.has("b"), false);
  assert.deepEqual([...cache.keys()], ["a", "c"]);
  cache.set("a", "x"); assert.equal(cache.byteSize, 5);
  cache.set("oversized", "a".repeat(13)); assert.equal(cache.has("oversized"), false);
  cache.delete("c"); assert.equal(cache.byteSize, 1);
  cache.clear(); assert.equal(cache.size, 0); assert.equal(cache.byteSize, 0);
});

test("uncached settled nodes render a terminal skeleton on the first frame", () => {
  executionTranscriptCache.clear();
  const execution = { id: "selected", status: "done", outputBytes: 100 } as Execution;
  const html = renderToStaticMarkup(createElement(ExecutionTranscript, { runId: "run", execution }));
  assert.match(html, /transcript-loading-skeleton/);
  assert.match(html, /role="status"/);
  executionTranscriptCache.set("run:selected", { text: "known\n", offset: 6, complete: true });
  const cached = renderToStaticMarkup(createElement(ExecutionTranscript, { runId: "run", execution }));
  assert.doesNotMatch(cached, /transcript-loading-skeleton/);
  executionTranscriptCache.clear();
});

test("successful delete and clear invalidate transcript caches", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ result: null }));
  try {
    executionTranscriptCache.set("deleted:one", { text: "a", offset: 1, complete: true });
    executionTranscriptCache.set("retained:two", { text: "b", offset: 1, complete: true });
    planningTranscriptCache.set("planner", { text: "c", offset: 1, complete: true });
    await runtimeService.deleteRun("deleted");
    assert.equal(executionTranscriptCache.has("deleted:one"), false);
    assert.equal(executionTranscriptCache.has("retained:two"), true);
    assert.equal(planningTranscriptCache.size, 0);
    await runtimeService.clearHistory();
    assert.equal(executionTranscriptCache.size, 0);
  } finally { globalThis.fetch = original; executionTranscriptCache.clear(); planningTranscriptCache.clear(); }
});

test("raw Worker stdout cannot hide a saved final assistant message", () => {
  const end = (text: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
  const delta = (text: string) => JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }) + "\n";
  for (const output of [
    "stdout 中文🚀\n" + end("FAILED_END_COMPLETE"),
    "stdout 中文🚀\n" + delta("FAILED_") + end("FAILED_END_COMPLETE"),
    delta("FAILED_") + "interleaved stdout 中文🚀\n" + end("FAILED_END_COMPLETE"),
  ]) {
    const html = renderToStaticMarkup(createElement(VirtualizedTranscript, { output, inline: true }));
    assert.match(html, /END_COMPLETE/);
    assert.match(html, /中文🚀/);
  }
});

test("both transcript caches enforce entry and byte limits", () => {
  for (const cache of [executionTranscriptCache, planningTranscriptCache]) {
    cache.clear();
    for (let i = 0; i < 25; i++) cache.set(String(i), { text: "日志🚀", offset: 10, complete: true });
    assert.equal(cache.size, 20);
    assert.equal(cache.has("0"), false);
    assert.ok(cache.byteSize <= 30 * 1024 * 1024);
    cache.clear();
  }
});
