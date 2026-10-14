import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VirtualizedTranscript } from "../src/components/VirtualizedTranscript.tsx";
import { settleInterruptedItems } from "../src/services/transcriptSettle.ts";
import type { TranscriptItem } from "../src/types.ts";

const line = (event: unknown) => JSON.stringify(event) + "\n";
const update = (type: string, contentIndex: number, extra = {}) => ({
  type: "message_update", assistantMessageEvent: { type, contentIndex, ...extra },
});
const start = () => ({ type: "message_start", message: { role: "assistant", content: [] } });
const render = (events: unknown[], settled?: boolean) => renderToStaticMarkup(createElement(VirtualizedTranscript, {
  output: events.map(line).join(""), inline: true, settled,
}));

// An interrupted execution's log ends mid-tool-call: the start/update records
// exist but no result was ever written (the backend stopped at 22:12:38).
const interruptedTool = [
  start(),
  update("thinking_delta", 0, { delta: "explore the scores" }),
  { type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash",
    args: { command: "python scripts/_explore3.py" } },
  { type: "tool_execution_update", toolCallId: "bash-1", toolName: "bash",
    args: { command: "python scripts/_explore3.py" },
    partialResult: { content: [{ type: "text", text: "partial stdout" }] } },
];

test("a settled transcript shows unterminated tool calls as interrupted, not executing", () => {
  const html = render(interruptedTool, true);
  assert.match(html, /tool-call-card terminal interrupted/);
  assert.match(html, /tool-status interrupted/);
  assert.doesNotMatch(html, /tool-status running/);
  assert.doesNotMatch(html, /tool-call-card terminal running/);
});

test("a live transcript keeps the executing spinner for unterminated tool calls", () => {
  const html = render(interruptedTool, false);
  assert.match(html, /tool-status running/);
  assert.doesNotMatch(html, /tool-status interrupted/);
});

test("completed tool calls keep their result state in a settled transcript", () => {
  const html = render([
    ...interruptedTool,
    { type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", isError: false,
      result: { content: [{ type: "text", text: "done" }], details: { exitCode: 0 } } },
  ], true);
  assert.match(html, /tool-call-card terminal success/);
  assert.doesNotMatch(html, /tool-status interrupted/);
  assert.doesNotMatch(html, /tool-status running/);
});

test("a settled transcript stops streaming a trailing interrupted thinking block", () => {
  // The model was killed mid-thinking: no thinking_end and nothing after it.
  const interruptedThinking = [
    start(),
    update("thinking_delta", 0, { delta: "explore the scores before deciding" }),
  ];
  const html = render(interruptedThinking, true);
  assert.match(html, /thinking-card settled/);
  assert.doesNotMatch(html, /thinking-card streaming/);
  const live = render(interruptedThinking, false);
  assert.match(live, /thinking-card streaming/);
});

test("settleInterruptedItems rewrites only running items and keeps array identity otherwise", () => {
  const same: TranscriptItem[] = [
    { id: "a", type: "text", role: "assistant", content: "done" },
    { id: "b", type: "tool_call", toolName: "bash", status: "success", result: "ok" },
    { id: "c", type: "thinking", content: "final", status: "success" },
  ];
  assert.equal(settleInterruptedItems(same), same, "no running items keeps the same array");

  const running: TranscriptItem[] = [
    { id: "a", type: "tool_call", toolName: "bash", toolCallId: "bash-1", status: "running" },
    { id: "b", type: "thinking", content: "partial", status: "running" },
    { id: "c", type: "tool_call", toolName: "read", status: "success", result: "ok" },
  ];
  const settledItems = settleInterruptedItems(running);
  assert.notEqual(settledItems, running);
  assert.equal(settledItems[0].status, "interrupted");
  assert.equal(settledItems[1].status, "interrupted");
  assert.equal(settledItems[2].status, "success");
  assert.equal(running[0].status, "running", "the caller's items are not mutated");
});
