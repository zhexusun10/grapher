import assert from "node:assert/strict";
import test from "node:test";
import { parseTranscriptChunkLines, type ParseTranscriptChunkState } from "../src/services/transcriptParser.ts";

const update = (type: string, contentIndex: number, extra = {}) => ({
  type: "message_update", assistantMessageEvent: { type, contentIndex, ...extra },
});
const start = () => ({ type: "message_start", message: { role: "assistant", content: [] } });

function parse(events: unknown[]) {
  const state: ParseTranscriptChunkState = {
    source: "output", byteOffset: 0, leadingFragment: false, inTagThinking: false,
    inFinalResponse: false, finalResponseSuppressed: false, seenFirstUser: false,
    pendingUserStart: false, assistantStartIndex: 0, userMessageStarts: new Set(), compacting: false,
  };
  return parseTranscriptChunkLines(events.map(event => JSON.stringify(event)), [], new Map(), state,
    { showUserTurns: false, skipFirstUser: false }).currentItems
    .map(({ id: _id, timestamp: _timestamp, ...item }) => item);
}

test("coalesced UTF-8 deltas preserve thinking, whitespace, replies and message boundaries", () => {
  const thoughts = ["检查", "中文🚀", "\n", "  next step  "];
  const reply = ["Answer", "\n\n", "```ts\n", "const x = 1;\n", "```", "\n"];
  const events = (coalesced: boolean) => [start(), update("thinking_start", 0),
    ...(coalesced ? [thoughts.join("")] : thoughts).map(delta => update("thinking_delta", 0, { delta })),
    update("thinking_end", 0, { content: "" }),
    ...(coalesced ? [reply.join("")] : reply).map(delta => update("text_delta", 1, { delta })),
    { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "" },
      { type: "text", text: reply.join("") }] } },
    start(), update("text_delta", 0, { delta: "Separate turn" })];
  const compact = parse(events(true));
  assert.deepEqual(compact, parse(events(false)));
  assert.equal(compact[0].content, thoughts.join(""));
  assert.equal(compact[1].content, reply.join(""));
  assert.equal(compact[2].content, "Separate turn");
});

test("coalesced mixed inline thinking tags keep their original ordering", () => {
  for (const [first, second] of [["thought", "think"], ["think", "thought"]]) {
    const chunks = [`prefix <${first}>first</${first}> middle `, `<${second}>second</${second}> suffix`];
    const fine = parse([start(), ...chunks.map(delta => update("text_delta", 0, { delta }))]);
    const compact = parse([start(), update("text_delta", 0, { delta: chunks.join("") })]);
    assert.deepEqual(compact, fine);
    assert.deepEqual(compact.map(item => [item.type, item.content]), [
      ["text", "prefix "], ["thinking", "first"], ["text", " middle "],
      ["thinking", "second"], ["text", " suffix"],
    ]);
  }
});

test("omitting tool argument fragments preserves the complete tool card and result", () => {
  const prefix = [start(), update("toolcall_start", 0, { id: "tool", toolName: "bash" })];
  const suffix = [update("toolcall_end", 0, { toolCall: { id: "tool", name: "bash", arguments: { command: "echo ok" } } }),
    { type: "tool_execution_start", toolCallId: "tool", toolName: "bash", args: { command: "echo ok" } },
    { type: "tool_execution_end", toolCallId: "tool", toolName: "bash", durationMs: 12,
      result: { content: [{ type: "text", text: "ok" }], details: { exitCode: 0 } } }];
  assert.deepEqual(parse([...prefix, ...suffix]), parse([...prefix,
    update("toolcall_delta", 0, { delta: '{"command":' }),
    update("toolcall_delta", 0, { delta: '"echo ok"}' }), ...suffix]));
  const [tool] = parse([...prefix, ...suffix]);
  assert.equal(tool.type, "tool_call");
  assert.deepEqual(tool.args, { command: "echo ok" });
  assert.equal(tool.result, "ok");
  assert.equal(tool.status, "success");
});
