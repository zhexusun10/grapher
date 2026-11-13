import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runtimeService } from "../src/services/runtime.ts";
import { ExecutionTranscript, executionTranscriptCache } from "../src/components/ExecutionTranscript.tsx";
import { VirtualizedTranscript } from "../src/components/VirtualizedTranscript.tsx";
import { PlannerTranscript } from "../src/components/PlannerTranscript.tsx";
import { parseTranscriptChunkLines, type ParseTranscriptChunkState } from "../src/services/transcriptParser.ts";
import { planningTranscriptCache } from "../src/components/PlanningActivity.tsx";
import { BoundedLruCache, utf8Bytes } from "../src/lib/BoundedLruCache.ts";
import { cachedPlanningOutput, invalidateTranscriptCaches, planningTranscriptKey, registerTranscriptReader } from "../src/services/transcriptCache.ts";
import type { Execution, TranscriptItem } from "../src/types.ts";

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

test("blank assistant text does not create live Planner rows", () => {
  const items: TranscriptItem[] = [
    { id: "first-tool", type: "tool_call", toolName: "bash", status: "success" },
    { id: "blank", type: "text", role: "assistant", content: "\n  " },
    { id: "second-tool", type: "tool_call", toolName: "read", status: "success" },
    { id: "private-thinking", type: "thinking", role: "assistant", content: "" },
  ];
  const html = renderToStaticMarkup(createElement(PlannerTranscript, { items, isPlanning: true, locked: false,
    draft: "", onDraftChange: () => {}, onSendMessage: () => {}, onUserResize: () => {} }));
  assert.doesNotMatch(html, /data-transcript-id="blank"/);
  for (const id of ["first-tool", "second-tool", "private-thinking"]) assert.match(html, new RegExp(`data-transcript-id="${id}"`));
});

test("Planner revision boundaries use visible row indices after blank text is removed", () => {
  const line = (event: unknown) => JSON.stringify(event) + "\n";
  const marker = (planningId: string) => line({ type: "grapher_planning_source", planningId, startOffset: 0 });
  const tool = (id: string) => line({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: {} });
  const blank = line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "\n" } });
  const output = marker("first") + blank + tool("tool-first") + marker("second") + tool("tool-second");
  const html = renderToStaticMarkup(createElement(VirtualizedTranscript, { output, inline: true, settled: true,
    sourceOrder: ["first", "second"] }));
  assert.match(html, /data-transcript-source-start="second" style="position:absolute;top:58px/);
  assert.doesNotMatch(html, /data-transcript-id="text_first_/);
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

const parseHistory = (output: string, startOffset = 0, tailItems?: TranscriptItem[], source = "output") => {
  const state: ParseTranscriptChunkState = {
    source, byteOffset: startOffset, leadingFragment: startOffset > 0,
    inTagThinking: false, inFinalResponse: false, finalResponseSuppressed: false,
    seenFirstUser: false, pendingUserStart: false, assistantStartIndex: 0,
    userMessageStarts: new Set(), compacting: false,
  };
  return parseTranscriptChunkLines(output.slice(0, -1).split("\n"), [], new Map(), state,
    { showUserTurns: false, skipFirstUser: false }, tailItems).currentItems;
};
const assistantEnd = (text: string) => JSON.stringify({
  type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] },
}) + "\n";

const finalResponse = (answer: string) => "\n── Final response ──\n" + answer + "\n";
const releaseAnswer = (marker: string) => [
  "Published receipt and 中文交接.", "", "Offline repair verified. Stopped.", "",
  "```json", '{"next_state":{"offline_wire_contract_fixed":true,"paper_candidates":[]}}', "```", "", marker,
].join("\n");

test("JSON in a final-response copy cannot escape duplicate suppression or expose feedback markers", () => {
  for (const marker of ["<ACCEPT>", "<FEEDBACK>"]) {
    const answer = releaseAnswer(marker);
    const output = assistantEnd(answer) + finalResponse(answer);
    const items = parseHistory(output);
    assert.equal(items.length, 1, "the entire runtime copy stays suppressed, including JSON and closing fences");
    assert.equal(items[0].content, answer);
    const html = renderToStaticMarkup(createElement(VirtualizedTranscript, { output, inline: true }));
    assert.equal((html.match(/Published receipt/g) || []).length, 1);
    assert.equal((html.match(/<pre>/g) || []).length, 1, "only the real JSON block renders, never an empty black bar");
    assert.match(html, /next_state/);
    assert.doesNotMatch(html, /ACCEPT|FEEDBACK|Final response/);
  }
});

test("cold final-response tails preserve JSON, blank lines and Markdown indentation across incremental reads", () => {
  const answer = [
    "First paragraph.  ", "Next line.", "", "- nested list", "  - child", "",
    "```json", '{"next_state":{"ready":true}}', '[1, 2]', '"value"', '42', 'null', 'true',
    '{"type":"message_end","message":{"role":"assistant","content":[]}}',
    "", "  {\"indented\": true}", "```", "", "    indented code", "", "<ACCEPT>",
  ].join("\n");
  const output = finalResponse(answer);
  const expected = parseHistory(assistantEnd(answer));
  const state: ParseTranscriptChunkState = {
    source: "output", byteOffset: 0, leadingFragment: false,
    inTagThinking: false, inFinalResponse: false, finalResponseSuppressed: false,
    seenFirstUser: false, pendingUserStart: false, assistantStartIndex: 0,
    userMessageStarts: new Set(), compacting: false,
  };
  let incremental: TranscriptItem[] = [];
  for (const rawLine of output.slice(0, -1).split("\n")) {
    incremental = parseTranscriptChunkLines([rawLine], incremental, new Map(), state,
      { showUserTurns: false, skipFirstUser: false }).currentItems;
  }
  for (const items of [parseHistory(output), incremental]) {
    assert.equal(items.length, 1);
    assert.equal(items[0].content, expected[0].content);
    assert.ok(items[0].finalResponseCopy);
    assert.equal(items[0].rawOutput, undefined);
  }
  const renderOutput = (output: string) => renderToStaticMarkup(createElement(VirtualizedTranscript, { output, inline: true }))
    .replace(/data-transcript-id="[^"]*"/g, 'data-transcript-id="row"');
  assert.equal(renderOutput(output), renderOutput(assistantEnd(answer)), "fallback and structured messages render identical Markdown");
});

test("planning source boundaries end final-response mode without consuming the next revision", () => {
  const answer = releaseAnswer("<ACCEPT>");
  const source = JSON.stringify({ type: "grapher_planning_source", planningId: "next", startOffset: 0 }) + "\n";
  for (const prefix of ["", assistantEnd(answer)]) {
    const items = parseHistory(prefix + finalResponse(answer) + source + assistantEnd("Next revision"));
    assert.equal(items.length, 2);
    assert.equal(items[0].content, answer);
    assert.equal(items[1].content, "Next revision");
    assert.equal(items[1].finalResponseCopy, undefined);
  }
});

test("feedback tags intentionally quoted in code remain literal in final-response tails", () => {
  const answer = "Protocol example:\n\n```text\n<ACCEPT>\n<FEEDBACK>\n```\n\n<ACCEPT>";
  const html = renderToStaticMarkup(createElement(VirtualizedTranscript, { output: finalResponse(answer), inline: true }));
  assert.equal((html.match(/&lt;ACCEPT&gt;/g) || []).length, 1);
  assert.equal((html.match(/&lt;FEEDBACK&gt;/g) || []).length, 1);
  assert.equal((html.match(/<pre>/g) || []).length, 1);
});

test("repeated user rows retain distinct absolute UTF-8 cursors in full and paged transcripts", () => {
  const image = { type: "image", mimeType: "image/png", data: "aA==" };
  const start = (text: string) => JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text }, image] } }) + "\n";
  const end = (text: string) => JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
  const prefix = assistantEnd("中文🚀 before the user turn");
  const first = start("继续") + end("继续") + assistantEnd("middle");
  const output = prefix + first + start("继续") + end("继续");
  for (const offset of [0, utf8Bytes(prefix + first)]) {
    const state: ParseTranscriptChunkState = {
      source: "output", byteOffset: offset, leadingFragment: false,
      inTagThinking: false, inFinalResponse: false, finalResponseSuppressed: false,
      seenFirstUser: false, pendingUserStart: false, assistantStartIndex: 0,
      userMessageStarts: new Set(), compacting: false,
    };
    const text = Buffer.from(output).subarray(offset).toString();
    const rows = parseTranscriptChunkLines(text.trimEnd().split("\n"), [], new Map(), state,
      { showUserTurns: true, skipFirstUser: false }).currentItems.filter(item => item.role === "user");
    assert.deepEqual(rows.map(item => item.userTurnOffset), offset === 0
      ? [utf8Bytes(prefix), utf8Bytes(prefix + first)] : [offset]);
    assert.ok(rows.every(row => row.images?.length === 1 && row.images[0].data === image.data), 'retained prefix rows keep their image payloads');
  }
});

test("only requested user turns render inline without replaying the task turn", () => {
  const output = [
    { type: "message", id: "task", message: { role: "user", content: [{ type: "text", text: "2" }] } },
    { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "exploring" }] } },
    { type: "message", id: "steer", message: { role: "user", content: [{ type: "text", text: "你在尝试干嘛" }] } },
    { type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ].map(event => JSON.stringify(event)).join("\n") + "\n";
  const state: ParseTranscriptChunkState = {
    source: "output", byteOffset: 0, leadingFragment: false,
    inTagThinking: false, inFinalResponse: false, finalResponseSuppressed: false,
    seenFirstUser: false, pendingUserStart: false, assistantStartIndex: 0,
    userMessageStarts: new Set(), compacting: false,
  };
  const items = parseTranscriptChunkLines(output.slice(0, -1).split("\n"), [], new Map(), state,
    { showUserTurns: true, skipFirstUser: false, userTurnTexts: ["你在尝试干嘛"] }).currentItems;
  assert.deepEqual(items.map(item => [item.role, item.content]), [
    ["assistant", "exploring"],
    ["user", "你在尝试干嘛"],
    ["assistant", "answer"],
  ]);
});

test("prepending across a large agent_end removes only the final-response copy, not real repeated replies", () => {
  const answer = "集成节点已完成 PASS 🚀\n\n## 验证\n\n| 文件 | 结果 |\n|---|---|\n| a.py | 通过 |\n\n" + releaseAnswer("<ACCEPT>");
  // agent_end repeats the session and can exceed both the initial tail and an older page.
  const output = assistantEnd(answer) + assistantEnd(answer)
    + JSON.stringify({ type: "agent_end", messages: [{ padding: "x".repeat(2 * 1024 * 1024) }] }) + "\n"
    + JSON.stringify({ type: "grapher_process_exited", success: true }) + "\n"
    + "\n── Final response ──\n" + answer + "\n";
  const bytes = Buffer.from(output);
  let start = bytes.length - 512 * 1024;
  let items = parseHistory(bytes.subarray(start).toString(), start);
  const count = () => items.filter(item => item.type === "text" && item.content?.includes("集成节点已完成")).length;
  assert.equal(count(), 1); // Fallback stays visible until its structured message is available.
  let prepends = 0;
  while (start > 0) {
    const next = Math.max(0, start - 1024 * 1024);
    // Match the component's prepend path: finish the split junction line,
    // parse only older bytes and merge with the retained tail rows.
    const firstNewline = bytes.indexOf(10, start);
    const prefix = bytes.subarray(next, firstNewline + 1).toString();
    const older = parseHistory(prefix, next, items);
    items = [...older, ...items];
    start = next;
    prepends++;
    if (start > 0) assert.equal(count(), 1);
  }
  assert.equal(prepends, 2);
  assert.equal(count(), 2); // Two actual messages, not three copies including the runtime tail.
  assert.deepEqual(items.map(item => item.content), parseHistory(output).map(item => item.content));
});

test("prepend reconciliation preserves unrelated final responses, sources and ordinary stdout", () => {
  for (const source of ["output", "planner-revision"]) {
    const answer = "PASS\n\nDetails 中文🚀";
    const fallback = "split-json-fragment\n── Final response ──\n" + answer + "\n";
    const start = utf8Bytes(assistantEnd(answer));
    const items = parseHistory(fallback, start, undefined, source);
    const saved = items[0];
    parseHistory(assistantEnd("Different answer"), 0, items, source);
    assert.equal(items[0], saved);
    parseHistory(assistantEnd(answer), 0, items, "another-source");
    assert.equal(items[0], saved);
    parseHistory(assistantEnd(answer), start + utf8Bytes(fallback), items, source);
    assert.equal(items[0], saved); // A later identical message is not the origin of this tail.
    const raw = parseHistory(answer + "\n");
    items.push(...raw);
    parseHistory(assistantEnd(answer), 0, items, source);
    assert.deepEqual(items, raw); // Only the provenance-marked runtime copy is removed.
  }
});

