import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThinkingCard } from "../src/components/ThinkingCard.tsx";
import { VirtualizedTranscript } from "../src/components/VirtualizedTranscript.tsx";
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
  assert.match(html, /Start snapshot 中文🚀 plus remaining delta/);
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
  assert.match(html, /End-only summary 中文🚀/);
  assert.match(html, /Non-normalized delta/);
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
  assert.equal((html.match(/Repeated summary/g) || []).length, 2);
  assert.doesNotMatch(html, /thinking-empty|thinking-shimmer/);
});

test("process exit hides an unfinished empty block but preserves captured thinking", () => {
  const exited = { type: "grapher_process_exited", success: false };
  const empty = render([start(), update("thinking_start", 0), exited]);
  assert.equal(cardCount(empty), 0);
  assert.doesNotMatch(empty, /thinking-empty|thinking-shimmer/);
  const captured = render([start(), update("thinking_delta", 0, { delta: "Captured before exit" }), exited]);
  assert.equal(cardCount(captured), 1);
  assert.match(captured, /Captured before exit/);
  assert.match(captured, /thinking-status completed/);
  assert.doesNotMatch(captured, /thinking-empty|thinking-shimmer/);
});
