import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VirtualizedTranscript } from "../src/components/VirtualizedTranscript.tsx";
import { CompactedCard } from "../src/components/CompactedCard.tsx";
import { parseTranscriptChunkLines, type ParseTranscriptChunkState } from "../src/services/transcriptParser.ts";
import { applyPlannerCompaction, initialPlannerStream } from "../src/services/plannerStream.ts";

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

test("successful compaction_end emits a Compacted card with Pi summary, tokens, reason, and tracked files", () => {
  const state = freshState();
  const result = parse([
    { type: "compaction_start", reason: "threshold" },
    {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: {
        summary: "## Goal\nFinish refactor\n\n## Progress\n- Updated parser",
        firstKeptEntryId: "entry-42",
        tokensBefore: 128400,
        estimatedTokensAfter: 18200,
        details: {
          readFiles: ["src/types.ts"],
          modifiedFiles: ["src/services/transcriptParser.ts"],
        },
      },
    },
  ], state);
  assert.equal(state.compacting, false);
  assert.equal(result.currentItems.length, 1);
  const item = result.currentItems[0];
  assert.equal(item.type, "compaction");
  assert.deepEqual(item.compaction, {
    reason: "threshold",
    tokensBefore: 128400,
    tokensAfter: 18200,
    summary: "## Goal\nFinish refactor\n\n## Progress\n- Updated parser",
    firstKeptEntryId: "entry-42",
    readFiles: ["src/types.ts"],
    modifiedFiles: ["src/services/transcriptParser.ts"],
  });

  const collapsedHtml = renderToStaticMarkup(createElement(CompactedCard, { item }));
  assert.match(collapsedHtml, /compacted-card collapsed/);
  assert.match(collapsedHtml, /<span class="compacted-title">Compacted<\/span>/);
  assert.match(collapsedHtml, /128\.4k → 18\.2k tokens/);
  assert.doesNotMatch(collapsedHtml, /compacted-card-body/);
  assert.doesNotMatch(collapsedHtml, /data-transcript-id=/);
  assert.doesNotMatch(collapsedHtml, /\stitle=/);

  const expandedHtml = renderToStaticMarkup(createElement(CompactedCard, { item, defaultExpanded: true }));
  assert.match(expandedHtml, /compacted-card expanded/);
  assert.match(expandedHtml, /compacted-card-body/);
  assert.match(expandedHtml, /Finish refactor/);
  assert.match(expandedHtml, /src\/services\/transcriptParser\.ts/);
  assert.match(expandedHtml, /src\/types\.ts/);
});

test("aborted compaction_end clears compacting without emitting a Compacted card", () => {
  const state = freshState();
  const result = parse([
    { type: "compaction_start", reason: "manual" },
    {
      type: "compaction_end",
      reason: "manual",
      aborted: true,
      willRetry: false,
      result: { summary: "should not appear", firstKeptEntryId: "e1", tokensBefore: 50000 },
    },
  ], state);
  assert.equal(state.compacting, false);
  assert.equal(result.currentItems.length, 0);
});

test("persisted session JSONL compaction entry renders a Compacted card in transcript replay", () => {
  const output = [
    line({ type: "session", version: 3, id: "sess-1" }),
    line({
      type: "compaction",
      id: "cmp-1",
      parentId: "m-10",
      timestamp: "2026-04-01T00:00:00.000Z",
      summary: "Compacted earlier history.",
      firstKeptEntryId: "m-11",
      tokensBefore: 95000,
      details: { modifiedFiles: ["src/App.tsx"] },
    }),
  ].join("");
  const html = renderToStaticMarkup(createElement(VirtualizedTranscript, {
    output, inline: true, settled: true, emptyText: "",
  }));
  assert.match(html, /compacted-card collapsed/);
  assert.match(html, /Compacted/);
  assert.match(html, /95k tokens/);
  assert.equal((html.match(/data-transcript-id="/g) ?? []).length, 1);
});

test("compaction file lists deduplicate repeated paths while preserving order", () => {
  const state = freshState();
  const result = parse([
    {
      type: "compaction",
      summary: "Deduped files",
      tokensBefore: 12000,
      details: {
        readFiles: ["src/a.ts", " src/b.ts ", "src/a.ts", ""],
        modifiedFiles: ["src/m.ts", "src/m.ts", "src/n.ts"],
      },
    },
  ], state);
  assert.deepEqual(result.currentItems[0].compaction?.readFiles, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(result.currentItems[0].compaction?.modifiedFiles, ["src/m.ts", "src/n.ts"]);
});

test("applyPlannerCompaction toggles compacting and appends a live Compacted card", () => {
  const started = applyPlannerCompaction(initialPlannerStream, { type: "compaction_start", reason: "overflow" });
  assert.equal(started.compacting, true);
  assert.equal(started.items.length, 0);

  const ended = applyPlannerCompaction(started, {
    type: "compaction_end",
    reason: "overflow",
    aborted: false,
    willRetry: true,
    result: {
      summary: "Recovered from overflow.",
      firstKeptEntryId: "p-3",
      tokensBefore: 190000,
    },
  });
  assert.equal(ended.compacting, false);
  assert.equal(ended.items.length, 1);
  assert.equal(ended.items[0].type, "compaction");
  assert.equal(ended.items[0].animateAppear, true);
  assert.equal(ended.items[0].compaction?.reason, "overflow");
  assert.equal(ended.items[0].compaction?.tokensBefore, 190000);
});
