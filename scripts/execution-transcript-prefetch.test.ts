import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runtimeService } from "../src/services/runtime.ts";
import { ExecutionTranscript, executionTranscriptCache, prefetchExecutionTranscript } from "../src/components/ExecutionTranscript.tsx";
import { VirtualizedTranscript } from "../src/components/VirtualizedTranscript.tsx";
import { planningTranscriptCache } from "../src/components/PlanningActivity.tsx";
import { BoundedLruCache, utf8Bytes } from "../src/lib/BoundedLruCache.ts";
import { cachedPlanningOutput, invalidateTranscriptCaches, planningTranscriptKey, registerTranscriptReader } from "../src/services/transcriptCache.ts";
import type { Execution } from "../src/types.ts";

test("settled node requests share work and publish only complete history", async () => {
  const original = runtimeService.getExecutionOutput;
  const runId = "prefetch-test-run";
  const execution = { id: "prefetch-test-exec", node: "node", status: "completed", outputBytes: 13 } as Execution;
  const offsets: number[] = [];
  let releaseSecond!: () => void;
  const secondPage = new Promise<void>(resolve => { releaseSecond = resolve; });
  runtimeService.getExecutionOutput = async (_runId, _execId, offset = 0, _signal, full) => {
    assert.equal(full, true);
    offsets.push(offset);
    if (offset) await secondPage;
    return {
      runId, executionId: execution.id, content: offset ? "second\n" : "first\n",
      nextOffset: offset ? 13 : 6, totalBytes: 13, complete: Boolean(offset), status: "completed",
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
  const execution = { id: "abort", status: "completed", outputBytes: 6 } as Execution;
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  runtimeService.getExecutionOutput = async () => {
    await response;
    return { runId: "old", executionId: "abort", content: "stale\n", nextOffset: 6, totalBytes: 6, complete: true, status: "completed" };
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

test("uncached settled nodes render a loading spinner on the first frame", () => {
  executionTranscriptCache.clear();
  const execution = { id: "selected", status: "completed", outputBytes: 100 } as Execution;
  const html = renderToStaticMarkup(createElement(ExecutionTranscript, { runId: "run", execution }));
  assert.match(html, /transcript-loading\"/);
  assert.match(html, /role="status"/);
  executionTranscriptCache.set("run:selected", { text: "known\n", offset: 6, complete: true });
  const cached = renderToStaticMarkup(createElement(ExecutionTranscript, { runId: "run", execution }));
  assert.doesNotMatch(cached, /transcript-loading\"/);
  executionTranscriptCache.clear();
});

test("successful delete and clear invalidate transcript caches", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ result: null }));
  try {
    executionTranscriptCache.set("deleted:one", { text: "a", offset: 1, complete: true });
    executionTranscriptCache.set("retained:two", { text: "b", offset: 1, complete: true });
    planningTranscriptCache.set("deleted:planner", { text: "c", offset: 1, complete: true });
    planningTranscriptCache.set("retained:planner", { text: "d", offset: 1, complete: true });
    await runtimeService.deleteRun("deleted");
    assert.equal(executionTranscriptCache.has("deleted:one"), false);
    assert.equal(executionTranscriptCache.has("retained:two"), true);
    assert.equal(planningTranscriptCache.has("deleted:planner"), false);
    assert.equal(planningTranscriptCache.has("retained:planner"), true);
    await runtimeService.clearHistory();
    assert.equal(executionTranscriptCache.size, 0);
    assert.equal(planningTranscriptCache.size, 0);
  } finally { globalThis.fetch = original; executionTranscriptCache.clear(); planningTranscriptCache.clear(); }
});

test("workspace deletion invalidates every backend-owned conversation only after commit", async () => {
  const original = globalThis.fetch;
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const release = [
    registerTranscriptReader("execution", "workspace-one:node", controllers[0]),
    registerTranscriptReader("planning", "workspace-two:planner", controllers[1]),
    registerTranscriptReader("execution", "unrelated:node", controllers[2]),
  ];
  let reject = true;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/delete_workspace");
    assert.equal(JSON.parse(String(init?.body)).repository, "/workspace");
    return reject
      ? new Response(JSON.stringify({ error: "workspace is active" }), { status: 400 })
      : new Response(JSON.stringify({ result: ["workspace-one", "workspace-two"] }));
  };
  try {
    for (const run of ["workspace-one", "workspace-two", "unrelated"]) {
      executionTranscriptCache.set(`${run}:node`, { text: "node", offset: 4, complete: true });
      planningTranscriptCache.set(`${run}:planner`, { text: "planner", offset: 7, complete: true });
    }
    await assert.rejects(runtimeService.deleteWorkspace("/workspace"), /active/);
    assert.equal(executionTranscriptCache.size, 3);
    assert.equal(planningTranscriptCache.size, 3);
    assert.ok(controllers.every(controller => !controller.signal.aborted));
    reject = false;
    assert.deepEqual(await runtimeService.deleteWorkspace("/workspace"), ["workspace-one", "workspace-two"]);
    assert.deepEqual([...executionTranscriptCache.keys()], ["unrelated:node"]);
    assert.deepEqual([...planningTranscriptCache.keys()], ["unrelated:planner"]);
    assert.deepEqual(controllers.map(controller => controller.signal.aborted), [true, true, false]);
  } finally {
    globalThis.fetch = original;
    release.forEach(dispose => dispose());
    executionTranscriptCache.clear(); planningTranscriptCache.clear();
  }
});

test("Conversation invalidation cancels both kinds of readers without disturbing another Run", () => {
  const node = new AbortController(), planner = new AbortController(), other = new AbortController();
  const dispose = [registerTranscriptReader("execution", "left:node", node),
    registerTranscriptReader("planning", "left:view:revision", planner),
    registerTranscriptReader("planning", "other:view:revision", other)];
  try {
    invalidateTranscriptCaches("left");
    assert.equal(node.signal.aborted, true);
    assert.equal(planner.signal.aborted, true);
    assert.equal(other.signal.aborted, false);
  } finally { dispose.forEach(release => release()); }
});

test("Planner revisions are independently reused and scoped to their Conversation", () => {
  planningTranscriptCache.clear();
  try {
    planningTranscriptCache.set(planningTranscriptKey("run", "p1"), { text: "first\n", offset: 6, complete: true });
    assert.match(cachedPlanningOutput("run", ["p1", "p2"]), /first/);
    assert.equal(cachedPlanningOutput("other", ["p1"]), "");
    assert.equal(planningTranscriptCache.size, 1);
  } finally { planningTranscriptCache.clear(); }
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

test("final response tag and duplicate tail are suppressed when assistant message already exists", () => {
  const end = (text: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
  const output = end("我是 AI 编程助手") + "\n── Final response ──\n我是 AI 编程助手\n";
  const html = renderToStaticMarkup(createElement(VirtualizedTranscript, { output, inline: true }));
  assert.match(html, /我是 AI 编程助手/);
  assert.doesNotMatch(html, /Final response/);
  const occurrences = (html.match(/我是 AI 编程助手/g) || []).length;
  assert.equal(occurrences, 1);
});

test("final response tail is shown without delimiter tag when no assistant message was emitted", () => {
  const output = "some raw output\n── Final response ──\nDirect Final Answer\n";
  const html = renderToStaticMarkup(createElement(VirtualizedTranscript, { output, inline: true }));
  assert.match(html, /Direct Final Answer/);
  assert.doesNotMatch(html, /Final response/);
});

