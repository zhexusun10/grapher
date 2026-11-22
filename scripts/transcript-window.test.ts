import assert from "node:assert/strict";
import test from "node:test";
import { appendTranscriptPage, prependTranscriptPage, renderTranscriptWindow, windowFromPage } from "../src/services/transcriptWindow.ts";
import { cancelTranscriptReaders, executionTranscriptCache, invalidateTranscriptCaches, registerTranscriptReader } from "../src/services/transcriptCache.ts";
import { transcriptAutoFillBudget, TranscriptAutoFillBudget } from "../src/services/transcriptPaging.ts";
import { retainedRowAnchor, rowOffsets, visibleTranscriptRows } from "../src/services/transcriptLayout.ts";
import { summarizeActivityGroup } from "../src/services/activitySummary.ts";
import { applyHydratedCardPatches, collectHydrationRanges, extractHydratedCardPatches, hydrationKeyForItem } from "../src/services/cardHydration.ts";
import { parseTranscriptChunkLines, type ParseTranscriptChunkState } from "../src/services/transcriptParser.ts";
import { translate } from "../src/i18n/index.ts";
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

test("transcript cursors reject invalid metadata before caching or scheduling another read", () => {
  for (const field of ["startOffset", "nextOffset", "totalBytes"] as const) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      const invalid = { ...page("", 0, 0), [field]: value };
      assert.throws(() => windowFromPage(invalid as unknown as Parameters<typeof windowFromPage>[0], false),
        /Invalid transcript byte range/, `${field}=${String(value)}`);
    }
  }
  // A huge but exact cursor is valid; the limit is precision, not log size.
  assert.equal(windowFromPage(page("", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), true).end, Number.MAX_SAFE_INTEGER);
  assert.throws(() => windowFromPage({ content: "中文", nextOffset: 10, totalBytes: 10 } as any, true),
    /Invalid transcript byte range/, "pages must carry their explicit start cursor");
});

test("a small tail of a huge log is cached by retained bytes, not its absolute cursor", () => {
  executionTranscriptCache.clear();
  const offset = 100 * 1024 * 1024;
  executionTranscriptCache.set("huge:tail", { text: "中文🚀", offset, startOffset: offset - 10, totalBytes: offset, complete: false });
  assert.equal(executionTranscriptCache.has("huge:tail"), true);
  assert.equal(executionTranscriptCache.byteSize, 10);
  executionTranscriptCache.clear();
});

test("automatic history reservations share a viewport budget across concurrent attempts", () => {
  const budget = new TranscriptAutoFillBudget(100);
  budget.charge(20); // The visible initial tail is part of this viewport's work.
  const first = budget.reserve(60)!;
  const second = budget.reserve(60)!;
  assert.equal(first.bytes, 60);
  assert.equal(second.bytes, 20);
  assert.equal(budget.reserve(4), null, "concurrent requests cannot each spend the full budget");
  first.finish(68); // Bounded chunk look-behind is charged too.
  second.finish(); // An aborted/failed request releases its reservation.
  assert.equal(budget.remaining, 12);
  second.finish(500);
  assert.equal(budget.remaining, 12, "cleanup is idempotent");
  const gesture = new Event("wheel");
  budget.renew(gesture);
  budget.charge(25);
  budget.renew(gesture);
  assert.equal(budget.remaining, 75, "one bubbling gesture renews all readers only once");
  const pending = budget.reserve(50)!;
  budget.renew(new Event("wheel"));
  assert.equal(budget.remaining, 50, "a new gesture cannot forget outstanding requests");
  pending.finish(50);
  assert.equal(budget.remaining, 50);
});

test("an exhausted automatic budget never blocks explicit history pages or retries", () => {
  const budget = new TranscriptAutoFillBudget(100);
  budget.charge(100);
  assert.equal(budget.reserve(40), null);
  const requested = budget.reserve(40, true)!;
  assert.equal(requested.bytes, 40, "a scrollbar/read request is not an automatic fill");
  assert.equal(budget.reserve(4), null, "explicit work cannot reopen automatic quota");
  requested.finish(); // A failed page can be retried without another gesture.
  const retry = budget.reserve(40, true)!;
  retry.finish(40);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.reserve(4), null);
  budget.renew(new Event("wheel"));
  assert.equal(budget.remaining, 100);
});

test("reusing a scroller for another conversation does not inherit an exhausted budget", () => {
  let view = "node-a";
  const scroller = { closest: () => ({ dataset: { transcriptBudgetKey: view } }) } as unknown as HTMLElement;
  const first = transcriptAutoFillBudget(scroller);
  first.charge(first.maximum);
  assert.equal(transcriptAutoFillBudget(scroller).remaining, 0);
  view = "node-b";
  const second = transcriptAutoFillBudget(scroller);
  assert.notEqual(second, first);
  assert.equal(second.remaining, second.maximum);
  first.charge(100);
  assert.equal(second.remaining, second.maximum, "a late old reservation cannot charge the new view");
});

test("navigation cancels readers while bounded windows survive, but deletion invalidates both", () => {
  executionTranscriptCache.clear();
  executionTranscriptCache.set("recent:exec", { text: "cached", offset: 6, complete: true });
  const controller = new AbortController();
  const unregister = registerTranscriptReader("execution", "recent:exec", controller);
  try {
    cancelTranscriptReaders("other");
    assert.equal(controller.signal.aborted, false);
    cancelTranscriptReaders("recent");
    assert.equal(controller.signal.aborted, true);
    assert.equal(executionTranscriptCache.get("recent:exec")?.text, "cached");
    invalidateTranscriptCaches("recent");
    assert.equal(executionTranscriptCache.has("recent:exec"), false);
  } finally { unregister(); executionTranscriptCache.clear(); }
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

test("summary-only transcript windows validate raw byte offsets without requiring raw byte length equality", () => {
  const summaryPage = {
    content: '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]}}\n',
    startOffset: 1000,
    nextOffset: 50000,
    totalBytes: 50000,
    summaryOnly: true,
  };
  const win = windowFromPage(summaryPage, false);
  assert.equal(win.summaryOnly, true);
  assert.equal(win.start, 1000);
  assert.equal(win.end, 50000);

  const appended = appendTranscriptPage(win, {
    content: '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Next"}]}}\n',
    startOffset: 50000,
    nextOffset: 80000,
    totalBytes: 80000,
    summaryOnly: true,
  }, true);
  assert.equal(appended.end, 80000);
  assert.equal(appended.summaryOnly, true);

  const prepended = prependTranscriptPage(appended, {
    content: '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Old"}]}}\n',
    startOffset: 0,
    nextOffset: 1000,
    totalBytes: 80000,
    summaryOnly: true,
  });
  assert.equal(prepended.start, 0);
  assert.throws(
    () => appendTranscriptPage(win, { content: "abc", startOffset: 50000, nextOffset: 50003, totalBytes: 50003 }, true),
    /Mismatched transcript projection/,
  );
});

test("collapseCards folds cards into Codex-style summaries between model text and revision boundaries", () => {
  const rows: TranscriptItem[] = [
    { id: "user-1", type: "text", role: "user", content: "Inspect the repo" },
    { id: "think-1", type: "thinking", role: "assistant", content: "Check files", status: "success" },
    { id: "tool-1", type: "tool_call", toolName: "bash", args: { command: "cat docs/index.md" }, status: "success" },
    { id: "text-1", type: "text", role: "assistant", content: "First summary paragraph." },
    { id: "tool-2", type: "tool_call", toolName: "read", args: { path: "package.json" }, status: "success" },
    { id: "tool-3", type: "tool_call", toolName: "bash", args: { command: "npm test" }, status: "success" },
    { id: "tool-4", type: "tool_call", toolName: "bash", args: { command: "npm run check" }, status: "success" },
    { id: "text-2", type: "text", role: "assistant", content: "Second summary paragraph." },
    { id: "err-1", type: "system", role: "assistant", isError: true, content: "503 first" },
    { id: "err-2", type: "system", role: "assistant", isError: true, content: "502 second" },
    { id: "div-1", type: "divider" },
    { id: "think-2", type: "thinking", role: "assistant", content: "Reviewing", status: "running" },
  ];
  const starts = new Map([["rev-1", 0], ["rev-2", 10]]);
  const projected = visibleTranscriptRows(rows, starts, { collapseCards: true });

  assert.deepEqual(
    projected.rows.map(row => [row.id, row.type]),
    [
      ["user-1", "text"],
      ["summary_think-1", "activity_summary"],
      ["text-1", "text"],
      ["summary_tool-2", "activity_summary"],
      ["text-2", "text"],
      ["summary_err-1", "activity_summary"],
      ["div-1", "divider"],
      ["summary_think-2", "activity_summary"],
    ],
  );
  assert.equal(projected.rows[1].summaryItems?.length, 2);
  assert.equal(projected.rows[3].summaryItems?.length, 3);
  assert.equal(projected.rows[5].summaryItems?.length, 1);
  assert.equal(projected.rows[5].summaryItems?.[0].errorItems?.length, 2);
  assert.equal(projected.rows[7].status, "running");
  assert.deepEqual([...projected.starts], [["rev-1", 0], ["rev-2", 6]]);
  assert.equal(rows[1].summaryItems, undefined, "source rows must remain unmutated");

  // Settling a running group after a non-collapsible row keeps the exact same
  // summary ID so clicking to expand a live group never collapses it on settle.
  const whileRunning = visibleTranscriptRows([
    { id: "text-0", type: "text", role: "assistant", content: "Start" },
    { id: "think-run", type: "thinking", role: "assistant", content: "Working", status: "success" },
    { id: "call-run", type: "tool_call", toolCallId: "call-run", toolName: "bash", args: { command: "ls" }, status: "running" },
  ], undefined, { collapseCards: true });
  const afterSettled = visibleTranscriptRows([
    { id: "text-0", type: "text", role: "assistant", content: "Start" },
    { id: "think-run-new-offset", type: "thinking", role: "assistant", content: "Working", status: "success" },
    { id: "call-run", type: "tool_call", toolCallId: "call-run", toolName: "bash", args: { command: "ls" }, status: "success" },
    { id: "text-after", type: "text", role: "assistant", content: "Done" },
  ], undefined, { collapseCards: true });
  assert.equal(whileRunning.rows[1].id, "summary_call-run");
  assert.equal(afterSettled.rows[1].id, "summary_call-run");

  // Prepending older cards into a leading collapsed group keeps its summary ID
  // stable (keyed by last item) so scroll anchoring never unmounts or flickers it.
  const tailOnly = visibleTranscriptRows(rows.slice(1, 4), undefined, { collapseCards: true });
  const withPrepended = visibleTranscriptRows([
    { id: "tool-0", type: "tool_call", toolName: "read", args: { path: "README.md" }, status: "success" },
    ...rows.slice(1, 4),
  ], undefined, { collapseCards: true });
  assert.equal(tailOnly.rows[0].id, "summary_tool-1");
  assert.equal(withPrepended.rows[0].id, "summary_tool-1");
  assert.equal(withPrepended.rows[0].summaryItems?.length, 3);
});

test("summarizeActivityGroup retains legacy and Parallel search details", () => {
  for (const args of [
    { query: "Find official documentation" },
    { objective: "Find official\ndocumentation", search_queries: ["official API documentation"] },
    { objective: "Find official documentation", urls: ["https://example.com"] },
  ]) {
    const summary = summarizeActivityGroup([
      { id: "search", type: "tool_call", toolName: "web_search", status: "success", args },
    ]);
    assert.equal(summary.icon, "web");
    assert.ok(summary.text.includes("Find official documentation"));
  }
});

test("summarizeActivityGroup formats Codex-style summaries in Chinese and English", () => {
  const zh = (key: string, ...values: unknown[]) => translate("zh-CN", key, ...values);
  const en = (key: string, ...values: unknown[]) => translate("en", key, ...values);

  const singleBash = summarizeActivityGroup([
    { id: "t1", type: "thinking", content: "plan", status: "success" },
    { id: "b1", type: "tool_call", toolName: "bash", args: { command: "cat docs/index.md && cat package.json" }, status: "success" },
  ], zh);
  assert.equal(singleBash.icon, "terminal");
  assert.equal(singleBash.text, "已运行 cat docs/index.md && cat package.json");
  assert.equal(
    summarizeActivityGroup([
      { id: "b1", type: "tool_call", toolName: "bash", args: { command: "cat docs/index.md" }, status: "success" },
    ], en).text,
    "Ran cat docs/index.md",
  );

  const multiActions = summarizeActivityGroup([
    { id: "r1", type: "tool_call", toolName: "read", args: { path: "src/App.tsx" }, status: "success" },
    { id: "r2", type: "tool_call", toolName: "read", args: { path: "src/App.tsx" }, status: "success" },
    { id: "b1", type: "tool_call", toolName: "bash", args: { command: "ls" }, status: "success" },
    { id: "b2", type: "tool_call", toolName: "bash", args: { command: "pwd" }, status: "success" },
    { id: "c1", type: "tool_call", toolName: "mcp_query", args: {}, status: "success" },
  ], zh);
  assert.equal(multiActions.icon, "read");
  assert.equal(multiActions.text, "已浏览 1 个文件 · 已运行 2 条命令 · 调用了 1 个工具");
  assert.equal(
    summarizeActivityGroup([
      { id: "r1", type: "tool_call", toolName: "read", args: { path: "src/App.tsx" }, status: "success" },
      { id: "b1", type: "tool_call", toolName: "bash", args: { command: "ls" }, status: "success" },
      { id: "b2", type: "tool_call", toolName: "bash", args: { command: "pwd" }, status: "success" },
      { id: "c1", type: "tool_call", toolName: "mcp_query", args: {}, status: "success" },
    ], en).text,
    "Viewed 1 file · Ran 2 commands · Called 1 tool",
  );

  const listAndBash = summarizeActivityGroup([
    { id: "l1", type: "tool_call", toolName: "ls", args: {}, status: "success" },
    { id: "b1", type: "tool_call", toolName: "bash", args: { command: "git status" }, status: "success" },
    { id: "b2", type: "tool_call", toolName: "bash", args: { command: "git diff" }, status: "success" },
    { id: "c1", type: "tool_call", toolName: "custom_a", args: {}, status: "success" },
    { id: "c2", type: "tool_call", toolName: "custom_b", args: {}, status: "success" },
    { id: "c3", type: "tool_call", toolName: "custom_c", args: {}, status: "success" },
  ], zh);
  assert.equal(listAndBash.icon, "folder");
  assert.equal(listAndBash.text, "已列出文件 · 已运行 2 条命令 · 调用了 3 个工具");

  const thinkingOnly = summarizeActivityGroup([
    { id: "t1", type: "thinking", content: "reasoning", status: "success" },
  ], zh);
  assert.equal(thinkingOnly.icon, "thinking");
  assert.equal(thinkingOnly.text, "已思考");

  const runningThinking = summarizeActivityGroup([
    { id: "t1", type: "thinking", content: "reasoning", status: "running" },
  ], zh);
  assert.equal(runningThinking.isRunning, true);
  assert.equal(runningThinking.text, "正在思考…");

  const errors = summarizeActivityGroup([
    { id: "e1", type: "system", isError: true, errorItems: [
      { id: "e1", type: "system", isError: true, content: "err 1" },
      { id: "e2", type: "system", isError: true, content: "err 2" },
    ] },
  ], zh);
  assert.equal(errors.icon, "error");
  assert.equal(errors.hasError, true);
  assert.equal(errors.text, "发生 2 个错误");

  // Case-insensitive tool classification and mixed path / pathless read counts.
  // Non-zero bash exit codes (such as rg/grep/test returning 1) stay visually neutral.
  const mixedCase = summarizeActivityGroup([
    { id: "r1", type: "tool_call", toolName: "Read", args: { path: "src/a.ts" }, status: "success" },
    { id: "r2", type: "tool_call", toolName: "read", args: {}, status: "success" },
    { id: "e1", type: "tool_call", toolName: "Edit", args: { path: "src/a.ts" }, status: "success" },
    { id: "b1", type: "tool_call", toolName: "Bash", args: { command: "rg missing src/" }, status: "error", exitCode: 1 },
  ], en);
  assert.equal(mixedCase.icon, "read");
  assert.equal(mixedCase.hasError, false);
  assert.equal(mixedCase.text, "Viewed 2 files · Edited 1 file · Ran 1 command");

  // Streaming a new read call while arguments are still generating must not
  // temporarily inflate the viewed-file count from 2 -> 3 -> 2.
  const twoFiles: TranscriptItem[] = [
    { id: "r1", type: "tool_call", toolName: "read", args: { path: "src/a.ts" }, status: "success" },
    { id: "r2", type: "tool_call", toolName: "read", args: { path: "./src/b.ts" }, status: "success" },
  ];
  assert.equal(summarizeActivityGroup(twoFiles, zh).text, "已浏览 2 个文件");
  const generatingEmpty = summarizeActivityGroup([
    ...twoFiles,
    { id: "r3", type: "tool_call", toolName: "read", toolPhase: "generating", args: {}, status: "running" },
  ], zh);
  assert.equal(generatingEmpty.text, "已浏览 2 个文件");
  assert.equal(generatingEmpty.isRunning, true);
  const generatingPartial = summarizeActivityGroup([
    ...twoFiles,
    { id: "r3", type: "tool_call", toolName: "read", toolPhase: "generating", args: { path: "src/a" }, status: "running" },
  ], zh);
  assert.equal(generatingPartial.text, "已浏览 2 个文件");
  const finalizedRepeat = summarizeActivityGroup([
    ...twoFiles,
    { id: "r3", type: "tool_call", toolName: "read", toolPhase: "executing", args: { path: "./src/a.ts" }, status: "running" },
  ], zh);
  assert.equal(finalizedRepeat.text, "已浏览 2 个文件");
  const finalizedNew = summarizeActivityGroup([
    ...twoFiles,
    { id: "r3", type: "tool_call", toolName: "read", toolPhase: "executing", args: { path: "src/c.ts" }, status: "running" },
  ], zh);
  assert.equal(finalizedNew.text, "已浏览 3 个文件");

  // While a live group is still open or running, keep single-tool summaries in
  // the compact aggregate form so the bar never stretches horizontally with a
  // full command/path and then abruptly snaps back when a second tool arrives.
  const longBashCmd = "rg -n 'handleExpandableContentChange' src/components/views/GraphWorkbench.tsx src/components/ActivitySummaryRow.tsx";
  const liveSingleBashRunning = summarizeActivityGroup([
    { id: "b1", type: "tool_call", toolName: "bash", toolPhase: "executing", args: { command: longBashCmd }, status: "running" },
  ], zh, { isOpen: true });
  assert.equal(liveSingleBashRunning.text, "正在运行 1 条命令");
  assert.equal(liveSingleBashRunning.isRunning, true);

  const liveSingleBashGap = summarizeActivityGroup([
    { id: "b1", type: "tool_call", toolName: "bash", toolPhase: "executing", args: { command: longBashCmd }, status: "success" },
  ], zh, { isOpen: true });
  assert.equal(liveSingleBashGap.text, "已运行 1 条命令");

  const liveSingleRead = summarizeActivityGroup([
    { id: "r1", type: "tool_call", toolName: "read", toolPhase: "executing", args: { path: "src/components/views/GraphWorkbench.tsx" }, status: "running" },
  ], zh, { isOpen: true });
  assert.equal(liveSingleRead.text, "已浏览 1 个文件");

  // Live transcript projection marks only the trailing open group as summaryOpen.
  const liveProjected = visibleTranscriptRows([
    { id: "t0", type: "tool_call", toolCallId: "c0", toolName: "bash", args: { command: "pwd" }, status: "success" },
    { id: "txt0", type: "text", role: "assistant", content: "Checked cwd." },
    { id: "t1", type: "tool_call", toolCallId: "c1", toolName: "bash", args: { command: longBashCmd }, status: "success" },
  ], undefined, { collapseCards: true, live: true });
  assert.equal(liveProjected.rows.length, 3);
  assert.equal(liveProjected.rows[0].summaryOpen, undefined);
  assert.equal(liveProjected.rows[2].summaryOpen, true);
  assert.equal(
    summarizeActivityGroup(liveProjected.rows[0].summaryItems!, zh, { isOpen: liveProjected.rows[0].summaryOpen }).text,
    "已运行 pwd",
  );
  assert.equal(
    summarizeActivityGroup(liveProjected.rows[2].summaryItems!, zh, { isOpen: liveProjected.rows[2].summaryOpen }).text,
    "已运行 1 条命令",
  );
});

test("card-shell projections validate byte cursors, enforce LRU string sizing, and hydrate omitted cards cleanly", () => {
  const cardWin = windowFromPage({
    content: "{\"type\":\"message_end\"}\n",
    startOffset: 0,
    nextOffset: 500_000,
    totalBytes: 500_000,
    projection: "cards",
  }, true);
  assert.equal(cardWin.projection, "cards");
  assert.equal(cardWin.summaryOnly, undefined);
  assert.throws(() => appendTranscriptPage(cardWin, {
    content: "x",
    startOffset: 500_000,
    nextOffset: 500_001,
    totalBytes: 500_001,
    summaryOnly: true,
  }, true), /Mismatched transcript projection/);

  executionTranscriptCache.clear();
  executionTranscriptCache.set("run:exec:cards", {
    text: cardWin.text,
    offset: 500_000,
    startOffset: 0,
    totalBytes: 500_000,
    complete: true,
    projection: "cards",
  });
  assert.equal(executionTranscriptCache.byteSize, Buffer.byteLength(cardWin.text));
  executionTranscriptCache.clear();

  // Parse projected lines with omitted args/result/thinking and verify targeted hydration.
  const projectedLines = [
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call-big",
      toolName: "write",
      args: { path: "src/app.ts" },
      grapherBodyOmitted: true,
      grapherRawRange: [100, 5000],
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call-big",
      toolName: "write",
      isError: false,
      result: { details: { exitCode: 0 } },
      grapherBodyOmitted: true,
      grapherRawRange: [5000, 9000],
      grapherSubcommandWarning: true,
    }),
    JSON.stringify({
      type: "message_end",
      grapherRawRange: [9000, 12000],
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", grapherBodyOmitted: true, grapherThinkingChars: 3500 },
          { type: "text", text: "Finished updating src/app.ts." },
        ],
      },
    }),
  ];
  const state: ParseTranscriptChunkState = {
    source: "plan-1", byteOffset: 0, leadingFragment: false, inTagThinking: false,
    inFinalResponse: false, finalResponseSuppressed: false, seenFirstUser: false,
    pendingUserStart: false, assistantStartIndex: 0, userMessageStarts: new Set(), compacting: false,
  };
  const { currentItems } = parseTranscriptChunkLines(projectedLines, [], new Map(), state, { showUserTurns: false, skipFirstUser: false });
  const tool = currentItems.find(item => item.type === "tool_call")!;
  const thinking = currentItems.find(item => item.type === "thinking")!;
  const reply = currentItems.find(item => item.type === "text")!;
  assert.equal(tool.bodyOmitted, true);
  assert.equal(tool.subcommandWarning, true);
  assert.deepEqual(tool.rawArgsRange, [100, 5000]);
  assert.deepEqual(tool.rawResultRange, [5000, 9000]);
  assert.equal(thinking.bodyOmitted, true);
  assert.equal(thinking.thinkingCharCount, 3500);
  assert.deepEqual(thinking.rawRange, [9000, 12000]);
  assert.deepEqual(collectHydrationRanges([tool, thinking]), [[100, 5000], [5000, 9000], [9000, 12000]]);

  const hydratedJsonl = [
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call-big",
      toolName: "write",
      args: { path: "src/app.ts", content: "export const ok = true;\n" },
      grapherRawRange: [100, 5000],
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call-big",
      toolName: "write",
      isError: false,
      result: { content: [{ type: "text", text: "Wrote 24 bytes." }], details: { exitCode: 0 } },
      grapherRawRange: [5000, 9000],
    }),
    JSON.stringify({
      type: "message_end",
      grapherRawRange: [9000, 12000],
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "FULL_HYDRATED_REASONING" }, { type: "text", text: "" }],
      },
    }),
  ].join("\n") + "\n";
  const patches = extractHydratedCardPatches(hydratedJsonl, [tool, thinking], "plan-1");
  assert.ok(patches.has(hydrationKeyForItem(tool)!));
  assert.ok(patches.has(hydrationKeyForItem(thinking)!));

  const applied = applyHydratedCardPatches(currentItems, patches);
  const hydratedTool = applied.find(item => item.type === "tool_call")!;
  const hydratedThinking = applied.find(item => item.type === "thinking")!;
  const untouchedReply = applied.find(item => item.type === "text")!;
  assert.equal(untouchedReply, reply, "unchanged items keep object identity");
  assert.equal(hydratedTool.bodyOmitted, undefined);
  assert.equal(hydratedTool.args?.content, "export const ok = true;\n");
  assert.equal(hydratedTool.result, "Wrote 24 bytes.");
  assert.equal(hydratedThinking.bodyOmitted, undefined);
  assert.equal(hydratedThinking.content, "FULL_HYDRATED_REASONING");
});
