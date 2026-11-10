import assert from "node:assert/strict";
import test from "node:test";
import { appendTranscriptPage, prependTranscriptPage, renderTranscriptWindow, windowFromPage } from "../src/services/transcriptWindow.ts";
import { executionTranscriptCache } from "../src/services/transcriptCache.ts";
import { retainedRowAnchor, rowOffsets, visibleTranscriptRows } from "../src/services/transcriptLayout.ts";
import type { TranscriptItem } from "../src/types.ts";

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

test("blank assistant rows do not consume layout or move revision boundaries", () => {
  const rows: TranscriptItem[] = [
    { id: "blank-start", type: "text", role: "assistant", content: "\n" },
    { id: "private-thinking", type: "thinking", role: "assistant", content: "" },
    { id: "blank-middle", type: "text", role: "assistant", content: "  \t" },
    { id: "answer", type: "text", role: "assistant", content: "  answer" },
    { id: "user", type: "text", role: "user", content: "" },
    { id: "error", type: "system", role: "assistant", isError: true, content: "" },
    { id: "blank-end", type: "text", role: "assistant", content: "" },
  ];
  const starts = new Map([["first", 0], ["second", 2], ["third", 5], ["empty", 7]]);
  const projected = visibleTranscriptRows(rows, starts);
  assert.deepEqual(projected.rows.map(row => row.id), ["private-thinking", "answer", "user", "error"]);
  assert.deepEqual([...projected.starts], [["first", 0], ["second", 1], ["third", 3], ["empty", 4]]);
  assert.equal(rows.length, 7, "the parser's rows must not be mutated");
  assert.equal(rows[2].content, "  \t");
  const completed = rows.map(row => row.id === "blank-middle" ? { ...row, content: `${row.content}continued` } : row);
  assert.deepEqual(visibleTranscriptRows(completed, starts).rows.map(row => row.id),
    ["private-thinking", "blank-middle", "answer", "user", "error"], "a later delta reveals the same row");
  const alreadyVisible = projected.rows;
  assert.equal(visibleTranscriptRows(alreadyVisible).rows, alreadyVisible, "unchanged rows retain their identity");
});

test("consecutive transcript errors fold into one display row without mutating source rows", () => {
  const errors: TranscriptItem[] = [
    { id: "before", type: "text", role: "assistant", content: "before" },
    { id: "err-1", type: "system", role: "assistant", isError: true, content: "503 first" },
    { id: "err-2", type: "text", role: "assistant", status: "error", content: "503 second" },
    { id: "err-3", type: "system", isError: true, content: "502 latest" },
    { id: "after", type: "text", role: "assistant", content: "after" },
  ];
  const projected = visibleTranscriptRows(errors, new Map([["later-source", 4]]));
  assert.deepEqual(projected.rows.map(row => row.id), ["before", "err-1", "after"]);
  assert.deepEqual(projected.rows[1].errorItems?.map(row => row.content), ["503 first", "503 second", "502 latest"]);
  assert.deepEqual([...projected.starts], [["later-source", 2]]);
  assert.equal(errors[1].errorItems, undefined, "projection does not annotate parser-owned rows");

  const split = visibleTranscriptRows(errors.slice(1, 3), new Map([["next-revision", 1]]));
  assert.equal(split.rows.length, 2, "errors from separate transcript revisions stay separate");
  assert.equal(split.rows.some(row => row.errorItems), false);
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
