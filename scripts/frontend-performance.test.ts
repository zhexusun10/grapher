import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";
import { appendItemDelta } from "../src/services/transcriptUpdates.ts";
import { closeThinkingItems, updateThinkingItems, finalizeThinkingItems } from "../src/services/thinkingTranscript.ts";
import { shareById, shareJson } from "../src/services/structuralSharing.ts";
import { StreamingMarkdownCache, repairStreamingMarkdown, sanitizeHtml } from "../src/services/streamingMarkdown.ts";
import { mapWithConcurrency } from "../src/services/boundedRequests.ts";
import { liveOutputDelay, startVisibilityPolling } from "../src/services/visibilityPolling.ts";
import { runtimeService } from "../src/services/runtime.ts";
import { emptySnapshot, type TranscriptItem } from "../src/types.ts";

const fullMarkdown = (text: string, streaming: boolean) => sanitizeHtml(marked.parse(streaming ? repairStreamingMarkdown(text) : text,
  { gfm: true, breaks: true }) as string);

test("stream deltas preserve completed objects and never mutate frozen history", () => {
  const history: TranscriptItem[] = Array.from({ length: 2000 }, (_, i) => Object.freeze({ id: String(i), type: "text", content: `done ${i}`, status: "success" }));
  const tail = Object.freeze({ id: "tail", type: "text" as const, role: "assistant" as const, content: "A", status: "running" as const });
  const previous = Object.freeze([...history, tail]) as unknown as TranscriptItem[];
  const next = appendItemDelta(previous, "text", "中文🚀");
  assert.equal(next.at(-1)?.content, "A中文🚀");
  assert.equal(previous.at(-1)?.content, "A");
  assert.equal(next.filter((item, index) => item !== previous[index]).length, 1);
  assert.equal(appendItemDelta(previous, "text", ""), previous);
  assert.equal(closeThinkingItems(previous), previous);
  const thinking = appendItemDelta(previous, "thinking", "reasoning");
  const final = appendItemDelta(thinking, "text", "answer");
  assert.equal(final.at(-2)?.status, "success");
  assert.equal(thinking.at(-1)?.status, "running");
  assert.equal(final[1000], previous[1000]);
  // The lazy close path must not let helpers push/write into an unchanged caller array.
  const empty = Object.freeze([]) as unknown as TranscriptItem[];
  const started = updateThinkingItems(empty, { type: "thinking_start", contentIndex: 0 });
  assert.equal(empty.length, 0);
  const ended = updateThinkingItems(started, { type: "thinking_end", contentIndex: 0, content: "summary" });
  Object.freeze(ended); Object.freeze(ended[0]);
  assert.equal(finalizeThinkingItems(ended, [{ type: "thinking", thinking: "summary extended" }])[0].content, "summary extended");
  assert.equal(ended[0].content, "summary");
});

test("snapshot sharing preserves every backend field, deletions, order and changed subtrees", () => {
  const previous = { ...emptySnapshot, runId: "run", graph: { originalGoal: "goal", nodes: [{ name: "a", task: "task" }], edges: [] },
    executions: [{ id: "exec", output: "", outputBytes: 10, status: "running" }], extra: { important: true } };
  const same = shareJson(previous, structuredClone(previous));
  assert.equal(same, previous);
  const incoming = structuredClone(previous); incoming.executions[0].outputBytes = 20;
  const next = shareJson(previous, incoming);
  assert.deepEqual(next, incoming);
  assert.equal(next.graph, previous.graph); assert.equal(next.nodes, previous.nodes);
  assert.notEqual(next.executions, previous.executions);
  assert.equal(next.executions[0].outputBytes, 20);
  assert.deepEqual(shareJson({ a: 1, b: 2 }, { a: 1 }), { a: 1 });
  const special = JSON.parse('{"__proto__":{"safe":true},"missing":null}');
  assert.deepEqual(shareJson({}, special), special);
  assert.equal(Object.getPrototypeOf(shareJson({}, special)), Object.prototype);
  assert.deepEqual(shareJson([1, 2], [2, 1]), [2, 1]);
});

test("graph cards share identities by ID through selection and insertions", () => {
  const previous = [{ id: "a", position: { x: 1, y: 2 }, data: { selected: false } },
    { id: "b", position: { x: 3, y: 4 }, data: { selected: false } }];
  assert.equal(shareById(previous, structuredClone(previous)), previous);
  const incoming = structuredClone(previous); incoming[1].data.selected = true;
  const shared = shareById(previous, incoming);
  assert.equal(shared[0], previous[0]); assert.notEqual(shared[1], previous[1]);
  assert.equal(shared[1].position, previous[1].position);
  const reordered = shareById(previous, [structuredClone(previous[1]), structuredClone(previous[0])]);
  assert.equal(reordered[0], previous[1]); assert.equal(reordered[1], previous[0]);
});

const markdownCases = [
  "# Heading\n\nParagraph **bold**, *em*, ~~strike~~ and `code`.\nSecond line 中文🚀\n",
  "Heading\n===\n\n---\n\n> Quote\n>\n> - Nested **list**\n> - Item two\n",
  "- [x] task\n- [ ] task\n\n1. first\n\n   loose continuation\n2. second\n",
  "- [x] repeated task\n\n- [ ] repeated task\n\n  loose continuation\n\n",
  "1. [x] ordered task\n\n2. [ ] ordered task\n\n   second paragraph\n\n",
  "| Left | Right |\n|:---|---:|\n| **a** | [link](https://example.test) |\n\n",
  "```ts\nconst text = '<script>code</script>';\n```\n\n~~~\nopen fence\n",
  "[early][ref]\n\n![image][ref]\n\n[ref]: https://example.test/a 'Title'\n",
  "<a>\n\nhttps://example.test\n\n</a>\n\nhttps://example.test\n",
  "<pre>\nraw **text**\n</pre>\n\n<script>\nalert('never');\n\n</script>\n\n<iframe>gone</iframe>\n",
  "[bad](javascript:alert)\n\n[bad](data:text/html,blocked)\n\n<div>raw\n\ntext</div>\n",
  "    indented code\n\n\tmore code\r\n\r\nUnicode 中文🚀 & < >\r\n",
];

test("incremental Markdown is exactly equivalent at every streaming prefix, completion and replacement", () => {
  for (const content of markdownCases) {
    const cache = new StreamingMarkdownCache();
    for (let offset = 0; offset <= content.length; offset++) {
      const prefix = content.slice(0, offset);
      assert.equal(cache.render(prefix, true), fullMarkdown(prefix, true), `prefix ${offset}: ${JSON.stringify(content)}`);
    }
    assert.equal(cache.render(content, false), fullMarkdown(content, false));
    assert.equal(cache.render("shorter **replacement**", true), fullMarkdown("shorter **replacement**", true));
    assert.equal(cache.render("", false), "");
  }
  const cache = new StreamingMarkdownCache();
  for (const content of ["[a][ref]\n\nTail", "[a][ref]\n\nTail\n\n[ref]: /one", "[a][ref]\n\nTail\n\n[ref]: /two", "[a][ref]\n\nTail"]) {
    assert.equal(cache.render(content, true), fullMarkdown(content, true), "reference changes invalidate cached prefix links");
  }
});

test("Markdown caching preserves mixed/repeated blocks and loose task-list replacements", () => {
  let seed = 12345;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  const cache = new StreamingMarkdownCache();
  for (let sample = 0; sample < 60; sample++) {
    const content = Array.from({ length: 4 }, () => markdownCases[random() % markdownCases.length]).join("\n\n");
    for (let offset = 0; offset <= content.length; offset += 7) {
      const prefix = content.slice(0, offset);
      assert.equal(cache.render(prefix, true), fullMarkdown(prefix, true), `mixed sample ${sample}, prefix ${offset}`);
    }
    assert.equal(cache.render(content, false), fullMarkdown(content, false));
  }
  for (const content of ["- [x] same\n\n- [ ] same\n", "- [ ] same\n\n- [x] same\n", "- [x] same\n- [ ] same\n"]) {
    assert.equal(cache.render(content, true), fullMarkdown(content, true));
  }
});

test("long Markdown only redoes changed inline text and block HTML", () => {
  const history = Array.from({ length: 500 }, (_, i) => `Paragraph ${i}: **bold** [link](https://example.test/${i}).\n\n`).join("");
  const cache = new StreamingMarkdownCache();
  cache.render(history + "Tail", true);
  const before = { ...cache.stats };
  const next = history + "Tail appended 中文🚀";
  assert.equal(cache.render(next, true), fullMarkdown(next, true));
  assert.ok(cache.stats.inlineCharacters - before.inlineCharacters < 50);
  assert.ok(cache.stats.parsedBlocks - before.parsedBlocks <= 2);
  console.log(`Markdown acceptance: 500 unchanged paragraphs; appended update inline=${cache.stats.inlineCharacters - before.inlineCharacters} chars, blocks=${cache.stats.parsedBlocks - before.parsedBlocks}`);
});

test("metadata requests stay bounded, preserve result order and reuse slots without a batch barrier", async () => {
  let active = 0, maximum = 0;
  const released: Array<() => void> = [];
  const started: number[] = [];
  const pending = mapWithConcurrency([0, 1, 2, 3, 4], 2, async id => {
    started.push(id); active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => { released[id] = resolve; });
    active--; return id * 10;
  });
  assert.deepEqual(started, [0, 1]);
  released[1](); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2], "a slow first request cannot leave free slots idle");
  released[2](); await new Promise(resolve => setImmediate(resolve));
  released[3](); await new Promise(resolve => setImmediate(resolve));
  released[4](); released[0]();
  assert.deepEqual(await pending, [0, 10, 20, 30, 40]); assert.equal(maximum, 2);
});

test("only in-flight histories are deduplicated; failure and success both allow fresh reads", async () => {
  const original = globalThis.fetch;
  let calls = 0, release!: () => void, fail = true;
  let gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async () => {
    calls++; await gate;
    return new Response(JSON.stringify(fail ? { error: "failed" } : { result: emptySnapshot }), { status: fail ? 500 : 200 });
  };
  try {
    const first = runtimeService.history("perf-dedupe");
    const second = runtimeService.history("perf-dedupe");
    assert.equal(first, second); release();
    await assert.rejects(first); assert.equal(calls, 1);
    fail = false; gate = Promise.resolve();
    await runtimeService.history("perf-dedupe"); await runtimeService.history("perf-dedupe");
    assert.equal(calls, 3, "settled state must not be cached across actions");
  } finally { release(); globalThis.fetch = original; }
});

test("history deduplication never crosses a mutating action or lets old cleanup remove a newer request", async () => {
  const original = globalThis.fetch;
  const releases: Array<() => void> = [];
  let finishAction!: () => void;
  globalThis.fetch = async url => {
    if (String(url).endsWith("/control")) await new Promise<void>(resolve => { finishAction = resolve; });
    else await new Promise<void>(resolve => { releases.push(resolve); });
    return new Response(JSON.stringify({ result: emptySnapshot }));
  };
  try {
    const before = runtimeService.history("action-dedupe");
    const action = runtimeService.control("pause", { runId: "action-dedupe" });
    const during = runtimeService.history("action-dedupe");
    assert.notEqual(during, before);
    finishAction(); await action;
    const after = runtimeService.history("action-dedupe");
    assert.notEqual(after, during);
    releases[0](); releases[1](); await before; await during;
    assert.equal(runtimeService.history("action-dedupe"), after, "older finally handlers must leave the new request indexed");
    releases[2](); await after;
  } finally { finishAction?.(); releases.forEach(release => release()); globalThis.fetch = original; }
});

test("visibility polling wakes cursors, never overlaps requests and cleans up terminal/unmounted work", async () => {
  class Visibility extends EventTarget { hidden = false; }
  const visibility = new Visibility();
  let calls = 0, release!: () => void;
  const stop = startVisibilityPolling(async () => {
    calls++;
    await new Promise<void>(resolve => { release = resolve; });
    return 1000;
  }, 0, visibility as unknown as Document, 10_000);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(calls, 1);
  visibility.hidden = true; visibility.dispatchEvent(new Event("visibilitychange"));
  visibility.hidden = false; visibility.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 1); release();
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(calls, 2);
  stop(); release();
  visibility.dispatchEvent(new Event("visibilitychange"));
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(calls, 2);
  let terminal = 0;
  startVisibilityPolling(async () => { terminal++; return null; }, 0, visibility as unknown as Document);
  await new Promise(resolve => setTimeout(resolve, 10));
  visibility.dispatchEvent(new Event("visibilitychange"));
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(terminal, 1);
  assert.deepEqual([0, 1, 2, 3, 20].map(liveOutputDelay), [150, 300, 600, 1200, 1200]);
});
