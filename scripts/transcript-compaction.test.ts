import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VirtualizedTranscript } from "../src/components/VirtualizedTranscript.tsx";
import { parseTranscriptChunkLines, type ParseTranscriptChunkState } from "../src/services/transcriptParser.ts";

const line = (event: unknown) => JSON.stringify(event) + "\n";

const freshState = (): ParseTranscriptChunkState => ({
  source: "output",
  byteOffset: 0,
  leadingFragment: false,
  inTagThinking: false,
  inFinalResponse: false,
  finalResponseSuppressed: false,
  seenFirstUser: false,
  pendingUserStart: false,
  assistantStartIndex: 0,
  userMessageStarts: new Set<string>(),
  compacting: false,
});

const parse = (events: unknown[], state = freshState()) =>
  parseTranscriptChunkLines(
    events.map(line),
    [],
    new Map(),
    state,
    { showUserTurns: false, skipFirstUser: false },
  );

test("compaction_start marks the parse state and renders no chat rows", () => {
  const state = freshState();
  const result = parse([
    { type: "session", sessionId: "s1" },
    { type: "compaction_start", reason: "threshold" },
  ], state);
  assert.equal(state.compacting, true);
  assert.equal(result.currentItems.length, 0);
});

test("compaction_end clears the marker even when the result carries errors", () => {
  const state = freshState();
  parse([{ type: "compaction_start", reason: "overflow" }], state);
  assert.equal(state.compacting, true);
  parse([{ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false }], state);
  assert.equal(state.compacting, false);
});

test("a compaction cycle between turns leaves the state cleared", () => {
  const state = freshState();
  parse([
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "before" }] } },
    { type: "compaction_start", reason: "threshold" },
    { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "after" }] } },
  ], state);
  assert.equal(state.compacting, false);
  assert.equal(state.seenFirstUser, false);
});

test("process exit clears a compaction that never completed", () => {
  const state = freshState();
  parse([{ type: "compaction_start", reason: "threshold" }], state);
  assert.equal(state.compacting, true);
  parse([{ type: "grapher_process_exited", success: false }], state);
  assert.equal(state.compacting, false);
});

test("compaction events alone render exactly like an empty transcript", () => {
  const render = (output: string) => renderToStaticMarkup(createElement(VirtualizedTranscript, {
    output, inline: true, emptyText: "",
  }));
  const empty = render("");
  const compaction = render([
    line({ type: "session", sessionId: "s1" }),
    line({ type: "compaction_start", reason: "threshold" }),
    line({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false }),
  ].join(""));
  assert.equal(compaction, empty);
});
