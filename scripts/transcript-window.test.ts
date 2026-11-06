import assert from "node:assert/strict";
import test from "node:test";
import { appendTranscriptPage, prependTranscriptPage, renderTranscriptWindow, windowFromPage } from "../src/services/transcriptWindow.ts";
import { executionTranscriptCache } from "../src/services/transcriptCache.ts";
import { retainedRowAnchor, rowOffsets } from "../src/services/transcriptLayout.ts";

const page = (content: string, start: number, total: number) => ({ content, startOffset: start,
  nextOffset: start + Buffer.byteLength(content), totalBytes: total });

test("older and live requests retain independent byte cursors in either completion order", () => {
  for (const order of ["older-first", "live-first"]) {
    const total = Buffer.byteLength("old中文🚀new");
    let window = windowFromPage(page("中文🚀", 3, total), false);
    if (order === "older-first") {
      window = prependTranscriptPage(window, page("old", 0, total));
      window = appendTranscriptPage(window, page("new", 13, total), true);
    } else {
      window = appendTranscriptPage(window, page("new", 13, total), true);
      window = prependTranscriptPage(window, page("old", 0, total));
    }
    assert.equal(window.start, 0);
    assert.equal(window.end, total);
    assert.equal(window.text, "old中文🚀new");
    assert.equal(renderTranscriptWindow(window), "old中文🚀new\n");
    assert.equal(window.text.endsWith("\n"), false, "the cache never contains a synthetic byte");
  }
});

test("empty live pages, gaps, stale cursors and malformed byte ranges are distinguished", () => {
  const window = windowFromPage(page("中文", 4, 10), false);
  assert.equal(appendTranscriptPage(window, page("", 10, 10), false).start, 4);
  assert.throws(() => appendTranscriptPage(window, page("x", 8, 12), false));
  assert.throws(() => prependTranscriptPage(window, page("bad", 0, 10)));
  assert.throws(() => windowFromPage({ ...page("中文", 0, 6), nextOffset: 5 }, false));
});

test("a small tail of a huge log is cached by retained bytes, not its absolute cursor", () => {
  executionTranscriptCache.clear();
  const offset = 100 * 1024 * 1024;
  executionTranscriptCache.set("huge:tail", { text: "中文🚀", offset, startOffset: offset - 10, totalBytes: offset, complete: false });
  assert.equal(executionTranscriptCache.has("huge:tail"), true);
  assert.equal(executionTranscriptCache.byteSize, 10);
  executionTranscriptCache.clear();
});

test("prepend anchors use retained row identity and ignore simultaneous live growth", () => {
  const before = ["a", "b", "c"];
  const after = ["old-1", "old-2", ...before, "live-1", "live-2"];
  const heights = new Map(after.map(id => [id, 100]));
  assert.deepEqual(retainedRowAnchor(before, after, rowOffsets(before, heights), rowOffsets(after, heights), 110),
    { id: "b", delta: 200 });
  const withoutSplitRow = ["old", "b", "c"];
  assert.deepEqual(retainedRowAnchor(before, withoutSplitRow, rowOffsets(before, heights), rowOffsets(withoutSplitRow, heights), 0),
    { id: "b", delta: 72 - 100 });
});

test("an inserted page anchors the first visible row it moved, not an unchanged row above it", () => {
  // A composed Planner conversation inserts a loaded page of the later revision
  // below the turn that precedes it. The preceding turn's rows keep their
  // offset, so anchoring them would leave the rows the reader is actually
  // looking at to be dragged down by the inserted block.
  const before = ["previous", "review-1", "review-2", "review-3"];
  const after = ["previous", "older-1", "older-2", "review-1", "review-2", "review-3"];
  const heights = new Map(before.map(id => [id, 100]));
  const beforeOffsets = rowOffsets(before, heights), afterOffsets = rowOffsets(after, heights);
  assert.deepEqual(retainedRowAnchor(before, after, beforeOffsets, afterOffsets, 0, 400),
    { id: "review-1", delta: 144 });
  // A change entirely below the viewport did not move anything the reader can
  // see, so it must not scroll them at all.
  assert.equal(retainedRowAnchor(before, after, beforeOffsets, afterOffsets, 0, 100), null);
});
