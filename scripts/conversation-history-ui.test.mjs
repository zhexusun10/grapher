import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

let server, browser, origin;
let streamResponse;
let onPlan = () => {};
const line = event => JSON.stringify(event) + "\n";
const assistant = text => line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
const startTool = (id, command) => line({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command } });
const endTool = (id, text) => line({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text }], details: { exitCode: 0 } }, isError: false });

before(async () => {
  server = await createServer({ cacheDir: "node_modules/.vite-conversation-history", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null },
    plugins: [{ name: "conversation-history-fixtures", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url === "/api/plan_goal_stream") {
          let body = "";
          for await (const chunk of req) body += chunk;
          onPlan(JSON.parse(body));
          streamResponse = res;
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          res.write(`event: run_started\ndata: ${JSON.stringify({ runId: "stop-run" })}\n\n`);
          for (const event of [
            { type: "message_start", message: { role: "assistant", content: [] } },
            { type: "tool_execution_start", toolCallId: "live-stop-tool", toolName: "read", args: { path: "keep.txt" } },
            { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Agent is producing output" } },
          ]) res.write(`event: planner\ndata: ${JSON.stringify({ event })}\n\n`);
          return;
        }
        if (!req.url.startsWith("/__history")) return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, '<html><body><div id="root" style="padding:32px"></div><script type="module" src="/scripts/fixtures/frontend-audit.tsx"></script></body></html>'));
      });
    } }],
  });
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { streamResponse?.destroy(); await browser?.close(); await server?.close(); });

async function newPage(handler) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  const errors = [];
  await context.route("**/api/*", handler);
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on("pageerror", error => errors.push(String(error)));
  return { context, page, errors };
}

for (const role of ["node", "planner"]) {
  test(`${role}: tail reads, automatic scrollback, split tools and view-owned caches`, { timeout: 45_000 }, async () => {
    const prefix = Array.from({ length: 6 }, (_, index) => startTool(`older-${index}`, `older command ${index}`) + endTool(`older-${index}`, `OLDER_RESULT_${index}`)).join("") +
      line({ type: "opaque", text: "中文🚀".repeat(260_000) }) + startTool("cross-page-tool", "cross-page command");
    const tail = endTool("cross-page-tool", "CROSS_PAGE_RESULT") + Array.from({ length: 14 }, (_, index) => assistant(`Newest message ${index}`)).join("");
    let data = prefix + tail;
    const tailStart = Buffer.byteLength(prefix);
    let running = true;
    const requests = [];
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON();
      const command = new URL(route.request().url()).pathname.slice(5);
      requests.push({ command, ...body });
      if (command === "get_planning_output" && body.planningId === "planner-previous") {
        const content = startTool("previous-plan-tool", "previous revision") + endTool("previous-plan-tool", "PREVIOUS_REVISION_RESULT");
        return route.fulfill({ json: { result: { planningId: body.planningId, role: "planner", content, startOffset: 0,
          nextOffset: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content), complete: true, running: false } } });
      }
      assert.ok(["get_execution_output", "get_planning_output"].includes(command));
      const bytes = Buffer.from(data), total = bytes.length;
      const end = body.before ?? total;
      let start = body.tail ? (body.before === undefined ? tailStart : Math.max(0, end - (body.limit ?? 256 * 1024))) : body.offset;
      while (start < end && (bytes[start] & 0xc0) === 0x80) start++;
      const content = bytes.subarray(start, end).toString();
      await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        planningId: body.planningId, role: "planner", content, startOffset: start, nextOffset: end, totalBytes: total,
        complete: end === total, status: running ? "running" : "failed", running } } });
    });
    try {
      await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.selectHistory);
      if (role === "planner") {
        await page.evaluate(() => window.audit.selectHistory("planner"));
        // The initial Node reader can start before the fixture switches.
      }
      await page.locator('[data-transcript-id="cross-page-tool"] .tool-call-card').waitFor();
      await page.getByText("Newest message 13", { exact: true }).waitFor();
      const relevant = () => requests.filter(item => item.command === (role === "node" ? "get_execution_output" : "get_planning_output"));
      assert.ok(relevant().some(item => item.offset === 0 && item.tail), `${role} history starts with a bounded tail`);
      assert.ok(relevant().every(item => !item.full), "ordinary history must not request full output");
      assert.equal(await page.getByRole("button", { name: "Load earlier history", exact: true }).count(), 0);
      data += assistant("APPENDED_WITHOUT_RESTART 中文🚀");
      await page.getByText("APPENDED_WITHOUT_RESTART 中文🚀", { exact: true }).waitFor();
      assert.ok(relevant().some(item => !item.tail && item.offset === Buffer.byteLength(prefix + tail)), "live reads resume at the retained end cursor");
      const endBeforeScroll = Buffer.byteLength(data);
      const scroller = page.locator("[data-shared-scroll]");
      await scroller.evaluate(element => { element.scrollTop = 440; });
      await page.waitForTimeout(70);
      await scroller.evaluate(element => { element.scrollTop = 200; });
      await page.waitForFunction(() => [...document.querySelectorAll('.tool-summary')].some(element => element.textContent.includes("older command")));
      const cache = () => page.evaluate(role => role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning(), role);
      const loaded = await cache();
      assert.equal(loaded.offset, endBeforeScroll, "prepending must not rewind the live end cursor");
      assert.ok(loaded.text.includes("OLDER_RESULT_0"));
      assert.ok(relevant().filter(item => item.before !== undefined).length >= 3, "automatic history crosses multiple bounded UTF-8 pages and a split JSONL record");
      const crossed = page.locator('[data-transcript-id="cross-page-tool"]');
      assert.match(await crossed.innerText(), /cross-page command/);
      await crossed.locator(".tool-call-header").click();
      await crossed.locator(".tool-result-code").filter({ hasText: "CROSS_PAGE_RESULT" }).waitFor();
      data += assistant("APPEND_AFTER_SCROLLBACK");
      await page.waitForFunction(role => (role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning())?.text.includes("APPEND_AFTER_SCROLLBACK"), role);
      assert.ok((await cache()).text.includes("OLDER_RESULT_0"), "a late forward page must not replace prepended history");
      running = false;
      await page.evaluate(() => window.audit.setRunning(false));
      await page.waitForTimeout(350);
      for (let index = 0; index < 5; index++) {
        await page.evaluate(() => window.audit.selectHistory("away"));
        await page.waitForTimeout(20);
        const count = requests.length;
        await page.evaluate(role => window.audit.selectHistory(role), role);
        await page.getByText("APPEND_AFTER_SCROLLBACK", { exact: true }).waitFor();
        await page.waitForTimeout(80);
        if (role === "planner") assert.equal(requests.length, count, "Planner cache survives navigation inside the Conversation");
        else {
          assert.ok(requests.length > count, "leaving a Node view releases its cache; reopening reads a tail again");
          assert.ok(requests.slice(count).filter(item => item.command === "get_execution_output").every(item => !item.full));
        }
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const scenario of ["final-bytes-after-last-poll", "cached-view-does-not-rewind"]) {
  test(`Planner completion: ${scenario}`, { timeout: 30_000 }, async () => {
    let data = assistant("FIRST_VISIBLE"), running = true, holdForward = true;
    const held = [], requests = [];
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON();
      const command = new URL(route.request().url()).pathname.slice(5);
      requests.push({ command, ...body });
      const latest = body.planningId === "planner-latest";
      if (latest && body.offset > 0 && holdForward) await new Promise(resolve => held.push(resolve));
      const text = command === "get_execution_output" ? assistant("NODE_OUTPUT") : latest ? data : assistant("PREVIOUS_REVISION");
      const bytes = Buffer.from(text), start = body.offset ?? 0;
      try { await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        planningId: body.planningId, role: "planner", content: bytes.subarray(start).toString(), startOffset: start,
        nextOffset: bytes.length, totalBytes: bytes.length, complete: true, status: running ? "running" : "failed", running: latest && running } } }); } catch {}
    });
    try {
      await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.selectHistory);
      await page.evaluate(() => window.audit.selectHistory("planner"));
      await page.waitForFunction(() => window.audit.cachedPlanning()?.text.includes("FIRST_VISIBLE"));
      if (scenario === "cached-view-does-not-rewind") {
        await page.evaluate(() => window.audit.selectHistory("away"));
        await page.waitForTimeout(30);
        await page.evaluate(() => window.audit.selectHistory("planner"));
        data += assistant("MID_STREAM_VISIBLE"); holdForward = false;
        held.splice(0).forEach(release => release());
        await page.getByText("MID_STREAM_VISIBLE", { exact: true }).waitFor();
      } else data += assistant("FINAL_DURABLE_REPLY").trimEnd();
      running = false; holdForward = false;
      await page.evaluate(() => window.audit.setRunning(false));
      held.splice(0).forEach(release => release());
      await page.waitForFunction(() => window.audit.cachedPlanning()?.complete);
      const expected = scenario === "cached-view-does-not-rewind" ? "MID_STREAM_VISIBLE" : "FINAL_DURABLE_REPLY";
      await page.getByText(expected, { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.audit.cachedPlanning().offset), Buffer.byteLength(data));
      assert.ok(requests.some(item => item.command === "get_planning_output" && item.offset > 0), "completion must revalidate the retained end cursor");
      assert.deepEqual(errors, []);
    } finally { held.splice(0).forEach(release => release()); await context.close(); }
  });
}

for (const role of ["node", "planner"]) {
  test(`${role}: delayed prepend and simultaneous append preserve the current visible row`, { timeout: 30_000 }, async () => {
    const prefix = Array.from({ length: 80 }, (_, i) => assistant(`OLDER_ANCHOR_${i}`)).join("");
    const tail = Array.from({ length: 60 }, (_, i) => assistant(`VISIBLE_ANCHOR_${i}`)).join("");
    let data = prefix + tail, releaseOlder;
    const waiting = [];
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON();
      if (body.planningId === "planner-previous") {
        const text = assistant("PREVIOUS_ANCHOR_REVISION"), total = Buffer.byteLength(text);
        return route.fulfill({ json: { result: { planningId: body.planningId, role: "planner", content: text,
          startOffset: 0, nextOffset: total, totalBytes: total, complete: true, running: false } } });
      }
      if (body.before !== undefined) await new Promise(resolve => { releaseOlder = resolve; waiting.push(resolve); });
      const bytes = Buffer.from(data), end = body.before ?? bytes.length;
      const start = body.tail ? (body.before === undefined ? Buffer.byteLength(prefix) : 0) : body.offset;
      try { await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        planningId: body.planningId, role: "planner", content: bytes.subarray(start, end).toString(), startOffset: start,
        nextOffset: end, totalBytes: bytes.length, complete: end === bytes.length, status: "running", running: true } } }); } catch {}
    });
    try {
      await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.selectHistory);
      if (role === "planner") await page.evaluate(() => window.audit.selectHistory("planner"));
      await page.waitForFunction(role => !!(role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning()), role);
      await page.waitForTimeout(150);
      const scroller = page.locator("[data-shared-scroll]");
      await scroller.evaluate(element => { element.scrollTop = 550; });
      await page.waitForTimeout(50);
      await scroller.evaluate(element => { element.scrollTop = 400; });
      for (let i = 0; i < 50 && !releaseOlder; i++) await page.waitForTimeout(20);
      assert.ok(releaseOlder, "upward scrolling starts an automatic older-page request before the pane top");
      const status = page.locator(".transcript-history-status", { hasText: "Loading earlier records…" });
      await status.waitFor({ state: "attached" });
      const appearance = await status.evaluate(element => {
        const style = getComputedStyle(element), transcript = element.nextElementSibling;
        return { color: style.color, position: style.position, height: element.getBoundingClientRect().height,
          separated: !transcript || element.getBoundingClientRect().bottom <= transcript.getBoundingClientRect().top + 1 };
      });
      assert.equal(appearance.color, "rgb(133, 133, 133)");
      assert.equal(appearance.position, "static");
      assert.equal(appearance.height, 24);
      assert.ok(appearance.separated, "gray loading text owns a line; it never overlays a message");
      // The user keeps moving while the network is delayed. The anchor must be
      // captured at commit, not at request start.
      await scroller.hover(); await page.mouse.wheel(0, -70);
      data += assistant("LIVE_DURING_PREPEND");
      await page.waitForFunction(role => (role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning())?.text.includes("LIVE_DURING_PREPEND"), role);
      await page.waitForTimeout(100);
      const anchor = await scroller.evaluate(element => {
        const top = element.getBoundingClientRect().top;
        const row = [...element.querySelectorAll("[data-transcript-id]")].find(row => {
          const rect = row.getBoundingClientRect();
          return rect.top >= top && rect.bottom <= top + element.clientHeight;
        });
        return row ? { id: row.dataset.transcriptId, top: row.getBoundingClientRect().top } : null;
      });
      assert.ok(anchor, "the virtualized reader has a fully visible retained row");
      await page.evaluate(anchor => {
        window.audit.anchorSamples = [];
        const until = performance.now() + 400;
        const sample = () => {
          const row = [...document.querySelectorAll("[data-transcript-id]")].find(row => row.dataset.transcriptId === anchor.id);
          if (row) window.audit.anchorSamples.push(row.getBoundingClientRect().top);
          if (performance.now() < until) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, anchor);
      releaseOlder();
      await page.waitForFunction(role => (role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning())?.startOffset === 0, role);
      await page.waitForTimeout(200);
      const nextTop = await page.locator(`[data-transcript-id="${anchor.id}"]`).evaluate(row => row.getBoundingClientRect().top);
      assert.ok(Math.abs(nextTop - anchor.top) <= 3, `reading anchor moved ${nextTop - anchor.top}px`);
      const samples = await page.evaluate(() => window.audit.anchorSamples);
      assert.ok(samples.length >= 3, "sample actual painted frames, not only the final scroll position");
      assert.ok(samples.every(top => Math.abs(top - anchor.top) <= 3), `transient anchor drift: ${JSON.stringify(samples)}`);
      const cached = await page.evaluate(role => role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning(), role);
      assert.equal(cached.offset, Buffer.byteLength(data));
      assert.ok(cached.text.includes("LIVE_DURING_PREPEND"));
      assert.equal(await page.getByRole("button", { name: "Load earlier history", exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { waiting.forEach(release => release()); await context.close(); }
  });
}

for (const role of ["node", "planner"]) {
  test(`${role}: history COT and tools start folded and open from the loaded page`, { timeout: 30_000 }, async () => {
    const reasoning = "HISTORICAL_REASONING 中文🚀 ".repeat(300);
    const output = line({ type: "message_end", message: { role: "assistant", content: [
      { type: "thinking", thinking: reasoning }, { type: "text", text: "VISIBLE_FINAL_ANSWER" },
    ] } }) + startTool("lazy-tool", "read historical file") + endTool("lazy-tool", "HISTORICAL_TOOL_RESULT") +
      line({ type: "message_start", message: { role: "assistant", content: [] } }) +
      line({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "PENDING_HISTORY_REASONING" } }) +
      line({ type: "grapher_process_exited", success: false });
    const requests = [];
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON(); requests.push(body);
      const start = body.offset ?? 0, bytes = Buffer.from(output);
      await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        planningId: body.planningId, role: "planner", content: bytes.subarray(start).toString(), startOffset: start,
        nextOffset: bytes.length, totalBytes: bytes.length, complete: true, status: "completed", running: false } } });
    });
    try {
      await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.selectHistory);
      await page.evaluate(role => {
        window.audit.setRunning(false);
        if (role === "planner") { window.audit.setPlanningIds(["planner-latest"]); window.audit.selectHistory("planner"); }
      }, role);
      await page.getByText("VISIBLE_FINAL_ANSWER", { exact: true }).waitFor();
      assert.equal(await page.locator(".thinking-card.collapsed").count(), 2);
      assert.equal(await page.locator(".thinking-card-body, .tool-call-body").count(), 0, "folded cards must not mount their large bodies");
      assert.equal(await page.getByText("PENDING_HISTORY_REASONING", { exact: true }).count(), 0);
      await page.waitForTimeout(100);
      const count = requests.length;
      await page.locator(".thinking-card").first().locator(".thinking-card-header").click();
      await page.locator(".thinking-card-body", { hasText: "HISTORICAL_REASONING" }).waitFor();
      assert.ok((await page.locator(".thinking-card-body").innerText()).includes(reasoning.trim()));
      await page.locator(".tool-call-header").click();
      await page.locator(".tool-result-code", { hasText: "HISTORICAL_TOOL_RESULT" }).waitFor();
      assert.equal(requests.length, count, "current JSONL pages already contain details: expansion is local, not another full-history request");
      assert.equal(await page.locator(".thinking-card.collapsed").count(), 1, "opening one card never auto-opens another historical COT");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("Node RAM is released on return to Planner; Planner revisions survive until Conversation exit", { timeout: 30_000 }, async () => {
  const requests = [];
  let releasePending;
  const { context, page, errors } = await newPage(async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    if (body.planningId === "planner-pending") await new Promise(resolve => { releasePending = resolve; });
    const text = assistant(body.executionId ? "NODE_CACHE" : `PLANNER_CACHE_${body.planningId}`);
    const bytes = Buffer.from(text), start = body.offset ?? 0;
    try { await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
      planningId: body.planningId, role: "planner", content: bytes.subarray(start).toString(), startOffset: start,
      nextOffset: bytes.length, totalBytes: bytes.length, complete: true, status: "completed", running: false } } }); } catch {}
  });
  try {
    await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.selectHistory);
    await page.evaluate(() => { window.audit.setRunning(false); window.audit.selectHistory("planner"); });
    await page.waitForFunction(() => window.audit.cachedPlanning()?.complete && window.audit.planningCacheKeys().length === 2);
    const keys = await page.evaluate(() => window.audit.planningCacheKeys());
    const latestReads = () => requests.filter(item => item.planningId === "planner-latest").length;
    const count = latestReads();
    await page.evaluate(() => window.audit.selectHistory("node"));
    await page.waitForFunction(() => !!window.audit.cachedExecution());
    assert.deepEqual(await page.evaluate(() => window.audit.planningCacheKeys()), keys);
    await page.evaluate(() => window.audit.selectHistory("planner"));
    await page.waitForFunction(() => !window.audit.cachedExecution());
    await page.getByText("PLANNER_CACHE_planner-latest", { exact: true }).waitFor();
    assert.equal(latestReads(), count, "Node-to-Planner must not discard Planner RAM");
    await page.evaluate(() => window.audit.setPlanningIds(["planner-previous", "planner-latest", "planner-next"]));
    await page.getByText("PLANNER_CACHE_planner-next", { exact: true }).waitFor();
    assert.equal(latestReads(), count, "adding a revision reuses existing revisions instead of rereading them");
    await page.evaluate(() => window.audit.setPlanningIds(["planner-previous", "planner-latest", "planner-next", "planner-pending"]));
    for (let i = 0; i < 50 && !releasePending; i++) await page.waitForTimeout(20);
    assert.ok(releasePending);
    await page.evaluate(() => window.audit.selectHistory("exit"));
    await page.waitForFunction(() => window.audit.planningCacheKeys().length === 0 && !window.audit.cachedExecution());
    releasePending(); await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.audit.planningCacheKeys()), [], "a late response cannot resurrect exited history");
    assert.deepEqual(errors, []);
  } finally { releasePending?.(); await context.close(); }
});

for (const role of ["node", "planner"]) {
  test(`${role}: an empty short tail automatically reads older bytes without a button`, { timeout: 30_000 }, async () => {
    const prefix = assistant("AUTOMATIC_SHORT_HISTORY"), fragment = "split-record-fragment\n";
    const text = prefix + fragment, total = Buffer.byteLength(text);
    const requests = [];
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON(); requests.push(body);
      const start = body.before === undefined ? Buffer.byteLength(prefix) : 0;
      const end = body.before ?? total;
      await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        planningId: body.planningId, role: "planner", content: Buffer.from(text).subarray(start, end).toString(),
        startOffset: start, nextOffset: end, totalBytes: total, complete: end === total, status: "completed", running: false } } });
    });
    try {
      await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.selectHistory);
      if (role === "planner") await page.evaluate(() => { window.audit.setPlanningIds(["planner-latest"]); window.audit.selectHistory("planner"); });
      await page.getByText("AUTOMATIC_SHORT_HISTORY", { exact: true }).waitFor();
      assert.ok(requests.some(item => item.before !== undefined), "short/empty windows must not wait for an impossible scroll");
      assert.equal(await page.getByRole("button", { name: "Load earlier history", exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const role of ["node", "planner"]) {
  test(`${role}: initial history fills two viewports despite a tall task and graph summary`, { timeout: 30_000 }, async () => {
    const records = Array.from({ length: 80 }, (_, index) => assistant(`PREFILL_ROW_${index} 中文🚀`));
    const offsets = [0];
    for (const record of records) offsets.push(offsets.at(-1) + Buffer.byteLength(record));
    const bytes = Buffer.from(records.join("")), requests = [];
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON(); requests.push(body);
      const end = body.before ?? bytes.length;
      const endIndex = offsets.indexOf(end);
      const start = body.tail ? offsets[Math.max(0, endIndex - (body.before === undefined ? 2 : 8))] : body.offset;
      await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        planningId: body.planningId, role: "planner", content: bytes.subarray(start, end).toString(), startOffset: start,
        nextOffset: end, totalBytes: bytes.length, complete: end === bytes.length, status: "completed", running: false } } });
    });
    try {
      await page.goto(`${origin}/__history?case=historyRegression&heading=1200&footer=1300`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.selectHistory);
      await page.evaluate(role => {
        window.audit.setRunning(false);
        if (role === "planner") { window.audit.setPlanningIds(["planner-latest"]); window.audit.selectHistory("planner"); }
      }, role);
      await page.waitForFunction(() => {
        const pane = document.querySelector("[data-shared-scroll]");
        const history = pane.querySelector(".virtualized-transcript-container");
        return history && history.getBoundingClientRect().height >= pane.clientHeight * 2;
      });
      const relevant = requests.filter(body => role === "node" ? body.executionId : body.planningId);
      assert.equal(relevant.find(body => body.tail && body.before === undefined).limit, 512 * 1024);
      assert.ok(relevant.filter(body => body.before !== undefined).length >= 2, "fill history, not surrounding task/graph chrome");
      assert.ok(relevant.filter(body => body.before !== undefined).every(body => body.limit === 1024 * 1024));
      const cached = await page.evaluate(role => role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning(), role);
      assert.ok(cached.startOffset > 0, "stop once there is a two-viewport buffer, not after downloading all history");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const layout of ["virtualized", "long"]) {
  test(`Latest smoothly traverses ${layout} history, tracks new output and can be interrupted`, { timeout: 30_000 }, async () => {
    const { context, page, errors } = await newPage(async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      assert.ok(["list_files", "list_skills"].includes(command), `unexpected API ${command}`);
      await route.fulfill({ json: { result: command === "list_files" ? { files: [] } : { skills: [] } } });
    });
    try {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(`${origin}/__history?case=latestScroll&layout=${layout}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector(".chat-messages-stream")?.style.opacity === "1");
      const scroller = page.locator(".initial-query-scroll");
      const moveUp = () => scroller.evaluate(element => {
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
        element.scrollTop = 400;
      });
      await moveUp();
      const button = page.getByRole("button", { name: "Latest", exact: true });
      await button.waitFor({ state: "visible" });
      await page.evaluate(() => {
        window.audit.latestSamples = [];
        const pane = document.querySelector(".initial-query-scroll"), until = performance.now() + 2200;
        const sample = () => {
          window.audit.latestSamples.push({ top: pane.scrollTop, bottom: pane.scrollHeight - pane.clientHeight,
            following: pane.dataset.transcriptScrollMode === "latest" });
          if (performance.now() < until) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await button.click();
      await page.waitForFunction(() => document.querySelector(".initial-query-scroll").dataset.transcriptScrollMode === "latest");
      await page.waitForTimeout(100);
      await page.evaluate(() => window.audit.appendLatest());
      await page.waitForFunction(() => {
        const pane = document.querySelector(".initial-query-scroll");
        return !pane.dataset.transcriptScrollMode && pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 1;
      });
      const samples = await page.evaluate(() => window.audit.latestSamples.filter(sample => sample.following));
      assert.ok(samples.length >= 6, `smooth movement must span painted frames: ${JSON.stringify(samples)}`);
      assert.ok(samples[0].top < samples[0].bottom * 0.25, "long histories must not pre-jump close to the bottom");
      assert.ok(samples.filter(sample => sample.top > 500 && sample.top < sample.bottom - 100).length >= 5,
        "intermediate rows must be traversed, not skipped by a resize-driven snap");
      await page.getByText("APPEND_WHILE_SMOOTH_SCROLLING", { exact: true }).waitFor();
      await moveUp(); await button.waitFor({ state: "visible" }); await button.click();
      await page.waitForFunction(() => document.querySelector(".initial-query-scroll").dataset.transcriptScrollMode === "latest");
      await scroller.hover(); await page.mouse.wheel(0, -100);
      await page.waitForFunction(() => !document.querySelector(".initial-query-scroll").dataset.transcriptScrollMode);
      await page.waitForTimeout(200);
      const cancelledTop = await scroller.evaluate(element => element.scrollTop);
      await page.waitForTimeout(250);
      assert.ok(Math.abs(await scroller.evaluate(element => element.scrollTop) - cancelledTop) <= 3, "upward input stops animation and automatic following");
      await moveUp(); await button.waitFor({ state: "visible" }); await button.click();
      await page.waitForFunction(() => document.querySelector(".initial-query-scroll").dataset.transcriptScrollMode === "latest");
      await page.evaluate(() => { window.audit.closedPane = document.querySelector(".initial-query-scroll"); window.audit.unmountConversation(); });
      await page.getByText("Conversation closed", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.audit.closedPane.dataset.transcriptScrollMode), undefined);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("actual App preserves scrollback and releases RAM on Node/Conversation navigation", { timeout: 45_000 }, async () => {
  const config = { repository: "/mock/cache", model: "test/old", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const prefix = Array.from({ length: 80 }, (_, i) => assistant(`APP_OLDER_${i}`)).join("");
  const tail = Array.from({ length: 60 }, (_, i) => assistant(`APP_VISIBLE_${i}`)).join("");
  const nodeData = prefix + tail, nodeBytes = Buffer.byteLength(nodeData);
  const runs = Object.fromEntries(["run-a", "run-b"].map(id => [id, { ...empty, runId: id, config, planType: "graph", phase: "paused", paused: true, approved: true,
    planningId: `plan-${id}`, graph: { originalGoal: `Goal ${id}`, nodes: [{ name: "worker", task: "Worker task" }], edges: [] },
    plan: { executionBatches: [["worker"]], roots: ["worker"], terminals: ["worker"], warnings: [] },
    nodes: { worker: { status: "done", revision: 1, instruction: "", error: null } },
    executions: [{ id: `exec-${id}`, node: "worker", status: "completed", output: "", outputBytes: nodeBytes,
      revision: 1, attempt: 1, startedAt: 1, completedAt: 2, sessionId: `session-${id}`, worktree: "/mock", before: "", after: "" }],
    events: [{ type: "created", sequence: 1, planning_id: `plan-${id}`, timestamp: 1 }] }]));
  const requests = [];
  let releaseOlder;
  const { context, page, errors } = await newPage(async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    requests.push({ command, ...body });
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: Object.keys(runs), repositoryInfo: { path: config.repository, name: "Cache test", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = runs[body.runId]; break;
      case "snapshot_if_changed": result = { version: body.runId, snapshot: null }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_planning_output": {
        const text = assistant(`APP_PLANNER_${body.planningId}`), bytes = Buffer.from(text), start = body.offset;
        result = { planningId: body.planningId, role: "planner", content: bytes.subarray(start).toString(),
          startOffset: start, nextOffset: bytes.length, totalBytes: bytes.length, complete: true, running: false }; break;
      }
      case "get_execution_output": {
        if (body.before !== undefined) await new Promise(resolve => { releaseOlder = resolve; });
        const start = body.tail ? (body.before === undefined ? Buffer.byteLength(prefix) : 0) : body.offset;
        const end = body.before ?? nodeBytes;
        result = { runId: body.runId, executionId: body.executionId, content: Buffer.from(nodeData).subarray(start, end).toString(),
          startOffset: start, nextOffset: end, totalBytes: nodeBytes, complete: end === nodeBytes, status: "completed" }; break;
      }
      default: throw new Error(`Unexpected API ${command}`);
    }
    try { await route.fulfill({ json: { result } }); } catch {}
  });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator('.run-item[data-run-id="run-a"]').click();
    await page.getByText("APP_PLANNER_plan-run-a", { exact: true }).waitFor();
    await page.evaluate(async () => { window.reviewCaches = await import("/src/services/transcriptCache.ts"); });
    const plannerReads = () => requests.filter(item => item.command === "get_planning_output" && item.planningId === "plan-run-a").length;
    const count = plannerReads();
    await page.locator(".node-chip").click();
    await page.waitForFunction(() => !!window.reviewCaches.executionTranscriptCache.get("run-a:exec-run-a"));
    await page.waitForFunction(() => document.querySelector(".chat-messages-stream").style.opacity === "1");
    const scroller = page.locator(".initial-query-scroll");
    await scroller.evaluate(element => {
      const transcript = element.querySelector("[data-execution-id]");
      element.scrollTop += transcript.getBoundingClientRect().top - element.getBoundingClientRect().top + 120;
    });
    for (let i = 0; i < 50 && !releaseOlder; i++) await page.waitForTimeout(20);
    assert.ok(releaseOlder);
    await scroller.hover(); await page.mouse.wheel(0, -50); await page.waitForTimeout(100);
    const anchor = await scroller.evaluate(element => {
      const top = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll("[data-transcript-id]")].find(row => {
        const rect = row.getBoundingClientRect(); return rect.top >= top && rect.bottom <= top + element.clientHeight;
      });
      return { id: row.dataset.transcriptId, top: row.getBoundingClientRect().top };
    });
    releaseOlder();
    await page.waitForFunction(() => window.reviewCaches.executionTranscriptCache.get("run-a:exec-run-a")?.startOffset === 0);
    await page.waitForTimeout(200);
    const top = await page.locator(`[data-transcript-id="${anchor.id}"]`).evaluate(row => row.getBoundingClientRect().top);
    assert.ok(Math.abs(top - anchor.top) <= 3, `Workbench auto-follow dragged the reading anchor ${top - anchor.top}px`);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const latest = page.getByRole("button", { name: "Latest", exact: true });
    await latest.waitFor({ state: "visible" }); await latest.click();
    await page.waitForFunction(() => document.querySelector(".initial-query-scroll").dataset.transcriptScrollMode === "latest");
    await page.waitForTimeout(100);
    assert.ok(await scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight > 100),
      "Latest must release a preserved scrollback anchor without instantly snapping to the bottom");
    await page.waitForFunction(() => {
      const pane = document.querySelector(".initial-query-scroll");
      return !pane.dataset.transcriptScrollMode && pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 1;
    });
    await page.locator(".back-to-query-btn").click();
    await page.getByText("APP_PLANNER_plan-run-a", { exact: true }).waitFor();
    await page.waitForFunction(() => !window.reviewCaches.executionTranscriptCache.has("run-a:exec-run-a"));
    assert.ok(await page.evaluate(() => window.reviewCaches.planningTranscriptCache.has("run-a:plan-run-a")));
    assert.equal(plannerReads(), count);
    await page.locator(".node-chip").click();
    await page.waitForFunction(() => !!window.reviewCaches.executionTranscriptCache.get("run-a:exec-run-a"));
    await page.waitForFunction(() => {
      const scroll = document.querySelector(".initial-query-scroll");
      return document.querySelector(".chat-messages-stream").style.opacity === "1" &&
        scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 35;
    });
    assert.equal(await page.evaluate(() => window.reviewCaches.executionTranscriptCache.get("run-a:exec-run-a").text.includes("APP_OLDER_0")), false,
      "reopened Node must not restore an offset from its released byte window");
    await page.locator('.run-item[data-run-id="run-b"]').click();
    await page.getByText("APP_PLANNER_plan-run-b", { exact: true }).waitFor();
    assert.ok(await page.evaluate(() => [...window.reviewCaches.planningTranscriptCache.keys()].every(key => !key.startsWith("run-a:"))));
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.waitForFunction(() => window.reviewCaches.planningTranscriptCache.size === 0 && window.reviewCaches.executionTranscriptCache.size === 0);
    assert.equal(await page.getByRole("button", { name: "Load earlier history", exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { releaseOlder?.(); await context.close(); }
});

test("actual App stop preserves a sent Planner follow-up and the next unsent draft", { timeout: 45_000 }, async () => {
  const config = { repository: "/mock/stop", model: "test/old", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const saved = { ...empty, runId: "stop-run", config, planType: "graph", phase: "awaiting_approval", planningId: "old-plan",
    graph: { originalGoal: "Original goal", nodes: [{ name: "worker", task: "Task" }], edges: [] },
    nodes: { worker: { status: "waiting", revision: 1, instruction: "", error: null } },
    events: [{ type: "created", sequence: 1, planning_id: "old-plan", timestamp: 1 }] };
  let stopped = false, planned = false;
  const controls = [];
  onPlan = body => { assert.equal(body.goal, "SENT_BEFORE_STOP"); planned = true; };
  const { context, page, errors } = await newPage(async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (command === "plan_goal_stream") return route.continue();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [saved.runId], repositoryInfo: { path: config.repository, name: "Stop test", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = saved; break;
      case "snapshot_if_changed": result = { version: stopped ? "stopped" : "old", snapshot: stopped ? saved : null }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_planning_output": {
        const content = assistant("Existing Planner reply");
        result = { planningId: body.planningId, role: "planner", content: body.offset ? "" : content,
          startOffset: body.offset ?? 0, nextOffset: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content), complete: true, running: false };
        break;
      }
      case "control":
        controls.push(body);
        if (body.action === "stop") {
          stopped = true;
          saved.paused = true;
        } else {
          assert.equal(body.action, "steer_planner");
          assert.equal(body.instruction, "STEER_BEFORE_STOP");
        }
        result = saved;
        break;
      default: throw new Error(`Unexpected API ${command}`);
    }
    await route.fulfill({ json: { result } });
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="stop-run"]').click();
    const input = page.locator(".pane-bottom-chat textarea");
    await input.fill("SENT_BEFORE_STOP"); await input.press("Enter");
    await page.getByText("Agent is producing output", { exact: true }).waitFor();
    assert.ok(planned);
    await page.locator('.chat-bubble-user', { hasText: "SENT_BEFORE_STOP" }).waitFor();
    await input.fill("STEER_BEFORE_STOP"); await input.press("Enter");
    await page.waitForFunction(() => document.querySelector('.pane-bottom-chat textarea').value === "");
    await page.locator('.chat-bubble-user', { hasText: "STEER_BEFORE_STOP" }).waitFor();
    await input.fill("UNSENT_DRAFT_AFTER_STOP 中文🚀");
    await page.getByRole("button", { name: "Click to interrupt execution", exact: true }).click();
    await page.waitForTimeout(900);
    assert.equal(await input.inputValue(), "UNSENT_DRAFT_AFTER_STOP 中文🚀");
    assert.equal(await page.locator('.chat-bubble-user', { hasText: "SENT_BEFORE_STOP" }).count(), 1);
    assert.equal(await page.locator('.chat-bubble-user', { hasText: "STEER_BEFORE_STOP" }).count(), 1);
    assert.equal(controls.filter(item => item.action === "stop").length, 1);
    assert.deepEqual(errors, []);
  } finally { streamResponse?.destroy(); streamResponse = undefined; await context.close(); }
});
