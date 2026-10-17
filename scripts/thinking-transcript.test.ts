import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThinkingCard } from "../src/components/ThinkingCard.tsx";
import { ToolCallCard } from "../src/components/ToolCallCard.tsx";
import { parseTranscriptChunkLines } from "../src/services/transcriptParser.ts";
import { TOOL_OUTPUT_PREVIEW_BYTES } from "../src/services/toolOutput.ts";
import { injectStreamingCursor } from "../src/components/MarkdownRenderer.tsx";
import { VirtualizedTranscript } from "../src/components/VirtualizedTranscript.tsx";
import { PlannerTranscript } from "../src/components/PlannerTranscript.tsx";
import { closeThinkingItems, finalizeThinkingItems, updateThinkingItems } from "../src/services/thinkingTranscript.ts";
import { setAutoExpandCot, readAutoExpandCot, autoExpandCotEnabled, AUTO_EXPAND_COT_KEY } from "../src/services/displayPreferences.ts";
import type { TranscriptItem } from "../src/types.ts";
import { t } from "../src/i18n/index.ts";

const line = (event: unknown) => JSON.stringify(event) + "\n";
const update = (type: string, contentIndex: number, extra = {}) => ({
  type: "message_update", assistantMessageEvent: { type, contentIndex, ...extra },
});
const start = () => ({ type: "message_start", message: { role: "assistant", content: [] } });
const end = (content: unknown[]) => ({ type: "message_end", message: { role: "assistant", content } });
const render = (events: unknown[]) => renderToStaticMarkup(createElement(VirtualizedTranscript, {
  output: events.map(line).join(""), inline: true,
}));
const cardCount = (html: string) => (html.match(/class="thinking-card /g) || []).length;
const toolCount = (html: string) => (html.match(/class="tool-call-card /g) || []).length;
/** Helper to run a test with auto-expansion forced on or off. */
const withAutoExpandCot = <T,>(run: () => T): T => {
  setAutoExpandCot(true);
  try { return run(); } finally { setAutoExpandCot(true); }
};
const withFoldedCot = <T,>(run: () => T): T => {
  setAutoExpandCot(false);
  try { return run(); } finally { setAutoExpandCot(true); }
};

test("background Planner replies stay separate across turns with no visible user bubble", () => {
  const events = [
    { type: "grapher_planning_source", planningId: "first" }, start(),
    update("text_delta", 0, { delta: "PHASE_TWO_PLANNED" }), end([{ type: "text", text: "PHASE_TWO_PLANNED" }]),
    { type: "grapher_planning_source", planningId: "review" }, start(),
    update("text_delta", 0, { delta: "REVIEW_COMPLETE" }), end([{ type: "text", text: "REVIEW_COMPLETE" }]),
  ];
  const html = render(events);
  assert.equal((html.match(/PHASE_TWO_PLANNED/g) || []).length, 1);
  assert.equal((html.match(/REVIEW_COMPLETE/g) || []).length, 1);
  assert.doesNotMatch(html, /PHASE_TWO_PLANNEDREVIEW_COMPLETE/);
});

test("RPC and message_end tool-call records render one completed tool card", () => {
  const events = [
    line(start()),
    line({ type: "message_update", assistantMessageEvent: {
      type: "toolcall_start", contentIndex: 0, id: "tool-1", toolName: "bash",
    } }),
    line({ type: "message_end", message: { role: "assistant", content: [
      { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "npm test" } },
    ] } }),
    line({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "npm test" } }),
    line({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", isError: false,
      result: { content: [{ type: "text", text: "TEST_OK" }], details: { exitCode: 0 } } }),
  ];
  const html = renderToStaticMarkup(createElement(VirtualizedTranscript, { output: events.join(""), inline: true }));
  assert.equal(toolCount(html), 1);
  assert.match(html, /npm test/);
});

test("session JSONL toolCall and toolResult records replay as tool cards", () => {
  const output = [
    line({ type: "message", id: "assistant-1", message: { role: "assistant", content: [
      { type: "toolCall", id: "tool-2", name: "read", arguments: { path: "src/App.tsx" } },
    ] } }),
    line({ type: "message", id: "result-1", message: { role: "toolResult", toolCallId: "tool-2", toolName: "read",
      content: [{ type: "text", text: "FILE_CONTENT" }], isError: false } }),
  ].join("");
  const html = renderToStaticMarkup(createElement(VirtualizedTranscript, { output, inline: true }));
  assert.equal(toolCount(html), 1);
  assert.match(html, /src\/App\.tsx/);
  assert.doesNotMatch(html, /\{"type":"message"/);
});

test("bundled web_search calls render a dedicated card with query and URL details", () => {
  const output = line({ type: "message", id: "assistant-search", message: { role: "assistant", content: [
    { type: "toolCall", id: "web-query", name: "web_search", arguments: { query: "rust async\nruntime" } },
    { type: "toolCall", id: "web-urls", name: "web_search",
      arguments: { urls: ["https://example.com/a", "https://example.com/b"] } },
  ] } });
  const html = renderToStaticMarkup(createElement(VirtualizedTranscript, { output, inline: true }));
  assert.equal(toolCount(html), 2);
  assert.equal((html.match(/tool-call-card web /g) || []).length, 2, "web_search uses the web card type");
  assert.match(html, /tool-icon web/);
  assert.match(html, /rust async runtime/, "queries collapse to a one-line summary");
  assert.ok(html.includes(t("{0} 个链接", 2)), "URL-only searches summarize the URL count");
});

test("a tail result without its start still has a tool card, never raw JSON", () => {
  const output = line({ type: "tool_execution_end", toolCallId: "tail-result", toolName: "bash",
    result: { content: "end-only output", details: { exitCode: 2 } }, isError: true });
  const html = renderToStaticMarkup(createElement(VirtualizedTranscript, { output, compact: true, startOffset: 400 }));
  assert.equal(toolCount(html), 1);
  assert.match(html, /tool-call-card terminal error/);
  assert.doesNotMatch(html, /&quot;tool_execution_end&quot;/);
});

test("a progress-only tail renders one running tool without replaying cumulative stdout", () => {
  const progress = { type: "tool_execution_update", toolCallId: "progress-tail", toolName: "bash",
    args: { command: "python long_job.py" }, partialResult: { content: [{ type: "text", text: "CUMULATIVE_STDOUT" }] } };
  const output = Array.from({ length: 20 }, () => line(progress)).join("");
  const html = renderToStaticMarkup(createElement(VirtualizedTranscript, { output, compact: true, startOffset: 400 }));
  assert.equal(toolCount(html), 1);
  assert.match(html, /python long_job.py/);
  assert.match(html, /tool-status running/);
  assert.doesNotMatch(html, /CUMULATIVE_STDOUT|&quot;tool_execution_update&quot;/);
  const completed = renderToStaticMarkup(createElement(VirtualizedTranscript, { output: output + line({
    type: "tool_execution_end", toolCallId: "progress-tail", toolName: "bash", isError: false,
    result: { content: [{ type: "text", text: "FINAL_RESULT" }], details: { exitCode: 0 } },
  }), compact: true, startOffset: 400, settled: true }));
  assert.equal(toolCount(completed), 1);
  assert.match(completed, /tool-call-card terminal success/);
  assert.doesNotMatch(completed, /tool-status running|tool-status interrupted/);
});

test("a settled progress-only tail shows the recovered tool as interrupted", () => {
  const html = renderToStaticMarkup(createElement(VirtualizedTranscript, { output: line({
    type: "tool_execution_update", toolCallId: "interrupted-tail", toolName: "read", args: { path: "data.csv" },
  }), compact: true, startOffset: 400, settled: true }));
  assert.equal(toolCount(html), 1);
  assert.match(html, /data.csv/);
  assert.match(html, /tool-status interrupted/);
});

test("giant tool arguments keep their card and shape, but only render a bounded preview", () => {
  const content = "ARGS_HEAD " + "中🚀".repeat(TOOL_OUTPUT_PREVIEW_BYTES) + "HUGE_ARGS_TAIL";
  const result = parseTranscriptChunkLines([line({ type: "tool_execution_start", toolCallId: "giant-args",
    toolName: "write", args: { path: "src/big.ts", content },
  }).trimEnd()], [], new Map(), {
    source: "output", byteOffset: 0, leadingFragment: false, inTagThinking: false, inFinalResponse: false,
    finalResponseSuppressed: false, seenFirstUser: false, pendingUserStart: false, assistantStartIndex: 0,
    userMessageStarts: new Set(), compacting: false,
  }, { showUserTurns: false, skipFirstUser: false });
  const item = result.currentItems[0];
  assert.equal(item.toolCallId, "giant-args");
  assert.equal(item.args?.path, "src/big.ts");
  assert.equal(item.argsTruncated, true);
  assert.ok(new TextEncoder().encode(item.args?.content).byteLength <= TOOL_OUTPUT_PREVIEW_BYTES);
  const html = renderToStaticMarkup(createElement(ToolCallCard, { item, defaultExpanded: true }));
  assert.ok(html.includes("tool-truncated-pill"), "truncated arguments render the truncation pill");
  assert.ok(html.includes("ARGS_HEAD"), "the bounded preview keeps its head");
  assert.ok(html.includes("src/big.ts"), "small argument values remain readable");
  assert.ok(html.includes(t("已截断")), "the truncation pill uses the active locale");
  assert.ok(!html.includes("HUGE_ARGS_TAIL"), "the bounded preview drops the giant tail");
  // The runtime projection marks already-cut arguments; the card must still say so.
  const marked = renderToStaticMarkup(createElement(ToolCallCard, {
    item: { ...item, args: { path: "src/big.ts", content: "preview\n..." }, argsTruncated: true },
    defaultExpanded: true,
  }));
  assert.ok(marked.includes("tool-truncated-pill"), "runtime-marked arguments also show the pill");
  assert.ok(marked.includes(t("已截断")), "runtime-marked truncation uses the active locale");
});

test("a giant tool result keeps its card and failure metadata, but only renders a bounded preview", () => {
  const text = "PREVIEW_HEAD " + "中🚀".repeat(TOOL_OUTPUT_PREVIEW_BYTES) + "HUGE_OUTPUT_TAIL";
  const result = parseTranscriptChunkLines([line({ type: "tool_execution_end", toolCallId: "giant-tool", toolName: "bash",
    durationMs: 1234, isError: true, result: { content: [{ type: "text", text }], details: { exitCode: 2 } },
  }).trimEnd()], [], new Map(), {
    source: "output", byteOffset: 0, leadingFragment: false, inTagThinking: false, inFinalResponse: false,
    finalResponseSuppressed: false, seenFirstUser: false, pendingUserStart: false, assistantStartIndex: 0,
    userMessageStarts: new Set(), compacting: false,
  }, { showUserTurns: false, skipFirstUser: false });
  const item = result.currentItems[0];
  assert.equal(result.currentItems.length, 1);
  assert.equal(item.toolCallId, "giant-tool");
  assert.equal(item.exitCode, 2);
  assert.equal(item.durationMs, 1234);
  assert.equal(item.status, "error");
  assert.equal(item.truncated, true);
  assert.ok(new TextEncoder().encode(item.result).byteLength <= TOOL_OUTPUT_PREVIEW_BYTES);
  const html = renderToStaticMarkup(createElement(ToolCallCard, { item, defaultExpanded: true }));
  assert.equal(toolCount(html), 1);
  assert.ok(html.includes("tool-truncated-pill") || html.includes("PREVIEW_HEAD"), "the result preview is bounded");
  assert.ok(html.includes("tool-result-code error"), "failed results keep their error presentation");
  assert.ok(html.includes("..."), "truncated output shows an ellipsis");
  assert.ok(!html.includes("HUGE_OUTPUT_TAIL"), "the bounded result drops the giant tail");
  // Direct/live card callers have the same cap, even without parsing first.
  const direct = renderToStaticMarkup(createElement(ToolCallCard, { item: { ...item, result: text, truncated: false }, defaultExpanded: true }));
  assert.ok(direct.includes("tool-truncated-pill"), "direct callers show the truncation pill");
  assert.ok(direct.includes("PREVIEW_HEAD"), "direct callers keep the preview head");
  assert.ok(!direct.includes("HUGE_OUTPUT_TAIL"), "direct callers drop the giant tail");
  assert.ok(direct.length < TOOL_OUTPUT_PREVIEW_BYTES + 20_000);
});

test("a leading split JSONL record is buffered, not rendered as assistant plaintext", () => {
  const full = line({ type: "tool_execution_end", toolCallId: "huge-result", toolName: "read",
    result: { content: [{ type: "text", text: "FRAGMENT_PAYLOAD中文🚀".repeat(100) }] } });
  const startOffset = full.indexOf("FRAGMENT_PAYLOAD") + 8;
  const final = line({ type: "tool_execution_end", toolCallId: "visible-result", toolName: "bash",
    result: { content: [{ type: "text", text: "small output" }] } });
  const tail = renderToStaticMarkup(createElement(VirtualizedTranscript, { output: full.slice(startOffset) + final, compact: true, startOffset }));
  assert.equal(toolCount(tail), 1);
  assert.doesNotMatch(tail, /FRAGMENT_PAYLOAD|&quot;type&quot;/);
  const restored = renderToStaticMarkup(createElement(VirtualizedTranscript, { output: full + final, compact: true }));
  assert.equal(toolCount(restored), 2);
});

test("incremental prepend parsing preserves tail items and backfills tool calls without re-parsing tail", () => {
  const tailStartOffset = 200;
  const tailOutput = line({
    type: "message", id: "msg-tail", message: {
      role: "assistant", content: [{ type: "text", text: "TAIL_ASSISTANT_TEXT" }],
    },
  });
  const tailMarkup = renderToStaticMarkup(createElement(VirtualizedTranscript, {
    output: tailOutput, compact: true, startOffset: tailStartOffset,
  }));
  assert.match(tailMarkup, /TAIL_ASSISTANT_TEXT/);

  // Prepend older history: an older text turn
  const olderOutput = line({
    type: "message", id: "msg-old", message: {
      role: "assistant", content: [{ type: "text", text: "OLDER_ASSISTANT_TEXT" }],
    },
  });
  const prependedOutput = olderOutput + tailOutput;
  const prependedMarkup = renderToStaticMarkup(createElement(VirtualizedTranscript, {
    output: prependedOutput, compact: true, startOffset: 0,
  }));
  assert.match(prependedMarkup, /OLDER_ASSISTANT_TEXT/);
  assert.match(prependedMarkup, /TAIL_ASSISTANT_TEXT/);
});

test("auto-expand COT defaults to enabled with safe storage fallbacks", () => {
  assert.equal(readAutoExpandCot({ getItem: () => null }), true, "default is auto-expanded");
  assert.equal(readAutoExpandCot({ getItem: () => "1" }), true);
  assert.equal(readAutoExpandCot({ getItem: () => "0" }), false);
  assert.equal(readAutoExpandCot({ getItem: () => { throw new Error("blocked"); } }), true);
  const writes: unknown[] = [];
  const storage = {
    setItem: (key: string, value: string) => { writes.push(["set", key, value]); },
    removeItem: (key: string) => { writes.push(["remove", key]); },
  };
  try {
    setAutoExpandCot(false, storage);
    assert.equal(autoExpandCotEnabled(), false);
    setAutoExpandCot(true, storage);
    assert.equal(autoExpandCotEnabled(), true);
    assert.deepEqual(writes, [["set", AUTO_EXPAND_COT_KEY, "0"], ["set", AUTO_EXPAND_COT_KEY, "1"]]);
  } finally {
    setAutoExpandCot(true);
  }
});

test("active agent conversation auto-opens running COT while settled history stays folded", () => {
  withAutoExpandCot(() => {
    const running = render([start(), update("thinking_delta", 0, { delta: "ACTIVE_STREAMING_TEXT" })]);
    assert.match(running, /thinking-card streaming expanded/);
    assert.match(running, /thinking-card-body/);
    assert.match(running, /ACTIVE_STREAMING_TEXT/);

    const settled = render([start(), update("thinking_delta", 0, { delta: "HISTORICAL_TEXT" }), update("thinking_end", 0, { content: "" })]);
    assert.match(settled, /thinking-card settled collapsed/);
    assert.doesNotMatch(settled, /thinking-card-body|HISTORICAL_TEXT/);

    const live = renderToStaticMarkup(createElement(ThinkingCard, { content: "Live reasoning", isStreaming: true, defaultExpanded: false }));
    assert.match(live, /thinking-card streaming expanded/);
    assert.match(live, /thinking-card-body/);
    assert.match(live, /<span class="thinking-title">Chain of Thought<\/span>/);
    assert.doesNotMatch(live, /思维链推理/);
  });
});

test("chain of thought stays folded while watching when the display option is disabled", () => {
  withFoldedCot(() => {
    const running = render([start(), update("thinking_delta", 0, { delta: "HIDDEN_STREAMING_COT" })]);
    assert.match(running, /thinking-card streaming collapsed/);
    assert.doesNotMatch(running, /thinking-card-body|HIDDEN_STREAMING_COT/);

    const plannerItem: TranscriptItem = { id: "think-default-off", type: "thinking", role: "assistant", content: "HIDDEN_PLANNER_COT", status: "running" };
    const planner = renderToStaticMarkup(createElement(PlannerTranscript, {
      items: [plannerItem], isPlanning: true, locked: false, draft: "",
      onDraftChange: () => {}, onSendMessage: () => false, onUserResize: () => {},
    }));
    assert.match(planner, /thinking-card streaming collapsed/);
    assert.doesNotMatch(planner, /HIDDEN_PLANNER_COT/);

    // An explicit click still opens the card, with or without the option.
    const opened = renderToStaticMarkup(createElement(ThinkingCard, { content: "OPT_IN_CONTENT", isStreaming: true, expanded: true }));
    assert.match(opened, /thinking-card streaming expanded/);
    assert.match(opened, /OPT_IN_CONTENT/);
  });
});

test("thinking_end settles the original card without replacing captured thinking or mutating state", () => {
  let items = updateThinkingItems([], { type: "thinking_start", contentIndex: 0 });
  const empty = items;
  items = updateThinkingItems(items, { type: "thinking_delta", contentIndex: 0, delta: "partial  " });
  const partial = items;
  items = updateThinkingItems(items, { type: "thinking_end", contentIndex: 0, content: "Final summary 中文🚀" });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, empty[0].id);
  assert.equal(items[0].content, "partial  ");
  assert.equal(items[0].status, "success");
  assert.equal(empty[0].content, "");
  assert.equal(partial[0].content, "partial  ");
  assert.equal(partial[0].status, "running");
});

test("final thinking backfills missing text and extends captured prefixes without duplicating them", () => {
  let items = updateThinkingItems([], { type: "thinking_delta", contentIndex: 0, delta: "完整思考" });
  const id = items[0].id;
  items = updateThinkingItems(items, { type: "thinking_end", contentIndex: 0, content: "完整思考：先检查数据，再验证结果。" });
  items = finalizeThinkingItems(items, [{ type: "thinking", thinking: "完整思考：先检查数据，再验证结果。补齐末尾。" }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, id);
  assert.equal(items[0].content, "完整思考：先检查数据，再验证结果。补齐末尾。");
  assert.equal(items[0].status, "success");
});

test("empty, shorter, or different end summaries cannot discard streamed thinking", () => {
  const captured = "Streamed thinking 中文🚀\nFirst step, then a detailed second step.\n\n";
  for (const content of [undefined, "", " \n\t", "Streamed thinking", "Different end summary"]) {
    for (const thinking of [undefined, "", " \n\t", "Streamed thinking", "Different final summary"]) {
      const streamed = updateThinkingItems([], { type: "thinking_delta", contentIndex: 0, delta: captured });
      let items = updateThinkingItems(streamed, { type: "thinking_end", contentIndex: 0, content });
      items = finalizeThinkingItems(items, [{ type: "thinking", thinking }]);
      assert.equal(items.length, 1);
      assert.equal(items[0].id, streamed[0].id);
      assert.equal(items[0].content, captured);
      assert.equal(items[0].status, "success");
      assert.equal(streamed[0].status, "running");
    }
  }
});

test("compact thinking_start snapshots are retained through deltas and empty finals", () => {
  const content = { type: "thinking", thinking: "Start snapshot 中文🚀", thinkingSignature: "PRIVATE_SIGNATURE_MUST_NOT_APPEAR" };
  const snapshot = updateThinkingItems([], { type: "thinking_start", contentIndex: 0, content });
  assert.equal(snapshot[0].content, content.thinking);
  let items = updateThinkingItems(snapshot, { type: "thinking_delta", contentIndex: 0, delta: " plus remaining delta" });
  items = updateThinkingItems(items, { type: "thinking_end", contentIndex: 0, content: "" });
  items = finalizeThinkingItems(items, [{ type: "thinking", thinking: "" }]);
  assert.equal(items[0].content, "Start snapshot 中文🚀 plus remaining delta");
  assert.equal(snapshot[0].content, content.thinking);
  const html = render([
    start(), update("thinking_start", 0, { content }),
    update("thinking_delta", 0, { delta: " plus remaining delta" }),
    update("thinking_end", 0, { content: "" }), end([{ type: "thinking", thinking: "" }]),
  ]);
  assert.equal(cardCount(html), 1);
  assert.match(html, /thinking-card settled collapsed/);
  assert.doesNotMatch(html, /thinking-status completed/);
  assert.doesNotMatch(html, /thinking-card-body/);
  assert.doesNotMatch(html, /thinking-empty|thinking-shimmer|PRIVATE_SIGNATURE_MUST_NOT_APPEAR/);
});

test("end-only events can recover text, while empty end events never erase streamed text", () => {
  let items = updateThinkingItems([], { type: "thinking_end", contentIndex: 2, content: "Recovered" });
  assert.equal(items[0].content, "Recovered");
  assert.equal(items[0].status, "success");
  items = updateThinkingItems(items, { type: "thinking_end", contentIndex: 2, content: "" });
  assert.equal(items[0].content, "Recovered");
  items = finalizeThinkingItems(items, [{ type: "text" }, { type: "text" }, { type: "thinking", thinking: "" }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].content, "Recovered");
});

test("multiple private reasoning blocks remain separate and final summaries backfill in place", () => {
  let items: TranscriptItem[] = [];
  for (const contentIndex of [0, 1, 2]) {
    items = updateThinkingItems(items, { type: "thinking_start", contentIndex });
    items = updateThinkingItems(items, { type: "thinking_end", contentIndex, content: "" });
  }
  const ids = items.map(item => item.id);
  items = finalizeThinkingItems(items, [
    { type: "thinking", thinking: "First summary" },
    { type: "thinking", thinking: "" },
    { type: "thinking", thinking: "Third summary" },
  ]);
  assert.deepEqual(items.map(item => item.id), ids);
  assert.deepEqual(items.map(item => item.content), ["First summary", "", "Third summary"]);
  assert.ok(items.every(item => item.status === "success"));
});

test("contentIndex matching does not overwrite another block or an intervening text item", () => {
  let items = updateThinkingItems([], { type: "thinking_start", contentIndex: 0 });
  items = updateThinkingItems(items, { type: "thinking_start", contentIndex: 2 });
  items.push({ id: "text", type: "text", content: "Visible reply" });
  items = updateThinkingItems(items, { type: "thinking_end", contentIndex: 0, content: "Earlier summary" });
  assert.equal(items[0].content, "Earlier summary");
  assert.equal(items[1].content, "");
  assert.equal(items[1].status, "running");
  assert.equal(items[2].content, "Visible reply");
});

test("reused indices and identical summaries in later assistant turns never match older cards", () => {
  let items = updateThinkingItems([], { type: "thinking_end", contentIndex: 0, content: "Same summary" });
  const first = items[0];
  const messageStart = items.length;
  items = updateThinkingItems(items, { type: "thinking_start", contentIndex: 0 }, messageStart);
  items = finalizeThinkingItems(items, [{ type: "thinking", thinking: "Same summary" }], messageStart);
  assert.equal(items.length, 2);
  assert.equal(items[0], first);
  assert.notEqual(items[1].id, first.id);
  assert.equal(items[1].content, first.content);
});

test("legacy unindexed deltas are reconciled rather than duplicated", () => {
  let items = updateThinkingItems([], { type: "thinking_start" });
  items = updateThinkingItems(items, { type: "thinking_delta", delta: "Fir" });
  items = updateThinkingItems(items, { type: "thinking_end", content: "First" });
  items = updateThinkingItems(items, { type: "thinking_start" });
  items = updateThinkingItems(items, { type: "thinking_end", content: "Second" });
  const ids = items.map(item => item.id);
  items = finalizeThinkingItems(items, [{ type: "thinking", thinking: "First final" }, { type: "thinking", thinking: "Second final" }]);
  assert.deepEqual(items.map(item => item.id), ids);
  assert.deepEqual(items.map(item => item.content), ["First final", "Second final"]);
});

test("closing a turn settles all pending cards, including cards before a tool", () => {
  const items: TranscriptItem[] = [
    { id: "first", type: "thinking", content: "", status: "running" },
    { id: "tool", type: "tool_call", status: "running" },
    { id: "second", type: "thinking", content: "Public summary", status: "running" },
  ];
  const closed = closeThinkingItems(items);
  assert.deepEqual(closed.map(item => item.status), ["success", "running", "success"]);
  assert.ok(items.every(item => item.status === "running"));
});

test("settled empty blocks render no misleading card while pending blocks still show progress", () => {
  for (const content of ["", " \n\t"]) {
    const html = renderToStaticMarkup(createElement(ThinkingCard, { content, isStreaming: false }));
    assert.equal(html, "");
  }
  // By default (auto-expand on), a pending block auto-expands and displays shimmer progress.
  const running = renderToStaticMarkup(createElement(ThinkingCard, { content: "", isStreaming: true }));
  assert.match(running, /thinking-card streaming expanded/);
  assert.ok(running.includes(t("思考中...")), "pending reasoning shows progress in the active locale");
  assert.match(running, /thinking-shimmer/);
  assert.doesNotMatch(running, /thinking-empty/);

  // When auto-expand is disabled, the pending card stays collapsed without mounting the shimmer body.
  withFoldedCot(() => {
    const collapsed = renderToStaticMarkup(createElement(ThinkingCard, { content: "", isStreaming: true }));
    assert.match(collapsed, /thinking-card streaming collapsed/);
    assert.ok(collapsed.includes(t("思考中...")));
    assert.doesNotMatch(collapsed, /thinking-shimmer|thinking-empty/);
  });
});

test("history replay retains streamed thinking, recovers end-only text, and hides truly empty blocks", () => {
  const html = render([
    start(),
    update("thinking_start", 0),
    update("thinking_end", 0, { content: "End-only summary 中文🚀" }),
    update("thinking_start", 1),
    update("thinking_end", 1, { content: "" }),
    update("thinking_start", 2),
    update("thinking_delta", 2, { delta: "Non-normalized delta" }),
    update("thinking_end", 2, { content: "Normalized summary" }),
    end([
      { type: "thinking", thinking: "End-only summary 中文🚀" },
      { type: "thinking", thinking: "", thinkingSignature: "PRIVATE_SIGNATURE_MUST_NOT_APPEAR" },
      { type: "thinking", thinking: "Normalized summary" },
    ]),
  ]);
  assert.equal(cardCount(html), 2);
  assert.match(html, /thinking-card settled collapsed/);
  assert.doesNotMatch(html, /thinking-status completed/);
  assert.doesNotMatch(html, /thinking-card-body/);
  assert.doesNotMatch(html, /thinking-empty|thinking-shimmer|Normalized summary|PRIVATE_SIGNATURE_MUST_NOT_APPEAR/);
});

test("message_end backfills the empty card and separate turns retain repeated summaries", () => {
  const html = render([
    start(), update("thinking_start", 0), update("thinking_end", 0, { content: "" }),
    end([{ type: "thinking", thinking: "Repeated summary" }]),
    start(), update("thinking_start", 0),
    end([{ type: "thinking", thinking: "Repeated summary" }]),
  ]);
  assert.equal(cardCount(html), 2);
  assert.equal((html.match(/thinking-card settled collapsed/g) || []).length, 2);
  assert.doesNotMatch(html, /thinking-status completed/);
  assert.doesNotMatch(html, /thinking-card-body|Repeated summary/);
  assert.doesNotMatch(html, /thinking-empty|thinking-shimmer/);
});

test("process exit hides an unfinished empty block but preserves captured thinking", () => {
  const exited = { type: "grapher_process_exited", success: false };
  const empty = render([start(), update("thinking_start", 0), exited]);
  assert.equal(cardCount(empty), 0);
  assert.doesNotMatch(empty, /thinking-empty|thinking-shimmer/);
  const captured = render([start(), update("thinking_delta", 0, { delta: "Captured before exit" }), exited]);
  assert.equal(cardCount(captured), 1);
  assert.doesNotMatch(captured, /thinking-card-body|Captured before exit/);
  assert.match(captured, /thinking-card settled collapsed/);
  assert.doesNotMatch(captured, /thinking-status completed/);
  assert.doesNotMatch(captured, /thinking-empty|thinking-shimmer/);
});

test("PlannerTranscript opens running and completed thinking when auto-expand is enabled", () => {
  withAutoExpandCot(() => {
  const runningItem: TranscriptItem = {
    id: "think-live-1",
    type: "thinking",
    role: "assistant",
    content: "Live planner reasoning",
    status: "running",
  };
  const htmlRunning = renderToStaticMarkup(createElement(PlannerTranscript, {
    items: [runningItem],
    isPlanning: true,
    locked: false,
    draft: "",
    onDraftChange: () => {},
    onSendMessage: () => false,
    onUserResize: () => {},
  }));
  assert.match(htmlRunning, /thinking-card streaming expanded/);
  assert.match(htmlRunning, /Live planner reasoning/);

  const completedItem: TranscriptItem = {
    id: "think-live-2",
    type: "thinking",
    role: "assistant",
    content: "Settled planner reasoning while on page",
    status: "success",
  };
  const htmlCompleted = renderToStaticMarkup(createElement(PlannerTranscript, {
    items: [completedItem],
    isPlanning: false,
    locked: false,
    draft: "",
    onDraftChange: () => {},
    onSendMessage: () => false,
    onUserResize: () => {},
  }));
  assert.match(htmlCompleted, /thinking-card settled expanded/);
  assert.match(htmlCompleted, /Settled planner reasoning while on page/);
  });
});

test("tail-paged message_end backfills thinking before streamed assistant text", () => {
  // Simulates a tail page where earlier thinking deltas were cut off, but text_delta was received,
  // followed by message_end containing both thinking and text content.
  const html = render([
    update("text_delta", 3, { delta: "Assistant response text that was streamed first" }),
    end([
      { type: "thinking", thinking: "Late backfilled thinking" },
      { type: "text", text: "Assistant response text that was streamed first" },
    ]),
  ]);
  const thinkIdx = html.indexOf("thinking-card");
  const textIdx = html.indexOf("Assistant response text");
  assert.ok(thinkIdx !== -1, "Thinking card should be present");
  assert.ok(textIdx !== -1, "Text should be present");
  assert.ok(thinkIdx < textIdx, `Thinking card (at ${thinkIdx}) should appear before assistant text (at ${textIdx})`);
});

test("streaming cursor is injected inline on the latest line and not pushed to an empty trailing line", () => {
  const cursor = '<span class="thinking-streaming-cursor"></span>';
  const injectedParagraph = injectStreamingCursor("<p>First line</p>\n<p>Latest line</p>\n", cursor);
  assert.match(injectedParagraph, /<p>Latest line<span class="thinking-streaming-cursor"><\/span><\/p>/);

  const injectedList = injectStreamingCursor("<ol>\n<li>Item 1</li>\n<li>Item 2</li>\n</ol>\n", cursor);
  assert.match(injectedList, /<li>Item 2<span class="thinking-streaming-cursor"><\/span><\/li>/);

  const injectedCode = injectStreamingCursor("<pre><code>console.log('hi');</code></pre>\n", cursor);
  assert.match(injectedCode, /console\.log\('hi'\);<span class="thinking-streaming-cursor"><\/span><\/code><\/pre>/);

  const renderedCard = withAutoExpandCot(() => renderToStaticMarkup(createElement(ThinkingCard, {
    content: "Step 1: check files\n\nStep 2: latest action line",
    isStreaming: true,
    defaultExpanded: true,
  })));
  // Cursor should be inline within the latest paragraph, not following after </p> or outside the markdown div
  assert.match(renderedCard, /latest action line<span class="thinking-streaming-cursor"><\/span><\/p>/);
  assert.doesNotMatch(renderedCard, /<\/div><span class="thinking-streaming-cursor">/);
});


