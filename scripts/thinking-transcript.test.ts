import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThinkingCard } from "../src/components/ThinkingCard.tsx";
import { injectStreamingCursor } from "../src/components/MarkdownRenderer.tsx";
import { VirtualizedTranscript } from "../src/components/VirtualizedTranscript.tsx";
import { PlannerTranscript } from "../src/components/PlannerTranscript.tsx";
import { closeThinkingItems, finalizeThinkingItems, updateThinkingItems } from "../src/services/thinkingTranscript.ts";
import type { TranscriptItem } from "../src/types.ts";

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

test("a tail result without its start still has a tool card, never raw JSON", () => {
  const output = line({ type: "tool_execution_end", toolCallId: "tail-result", toolName: "bash",
    result: { content: "end-only output", details: { exitCode: 2 } }, isError: true });
  const html = renderToStaticMarkup(createElement(VirtualizedTranscript, { output, compact: true, startOffset: 400 }));
  assert.equal(toolCount(html), 1);
  assert.match(html, /tool-call-card terminal error/);
  assert.doesNotMatch(html, /&quot;tool_execution_end&quot;/);
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

test("active agent conversation auto-opens running COT while settled history stays folded", () => {
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
  const running = renderToStaticMarkup(createElement(ThinkingCard, { content: "", isStreaming: true }));
  assert.match(running, /thinking-shimmer/);
  assert.doesNotMatch(running, /thinking-empty/);
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

test("PlannerTranscript live stream defaults both running and completed thinking cards to expanded", () => {
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

  const renderedCard = renderToStaticMarkup(createElement(ThinkingCard, {
    content: "Step 1: check files\n\nStep 2: latest action line",
    isStreaming: true,
    defaultExpanded: true,
  }));
  // Cursor should be inline within the latest paragraph, not following after </p> or outside the markdown div
  assert.match(renderedCard, /latest action line<span class="thinking-streaming-cursor"><\/span><\/p>/);
  assert.doesNotMatch(renderedCard, /<\/div><span class="thinking-streaming-cursor">/);
});


