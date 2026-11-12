import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

let server, browser, origin;
let streamResponse;
let onPlan = () => {};
let onPlanStream;
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
          if (onPlanStream) return onPlanStream(JSON.parse(body), res);
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
        if (!req.url.startsWith("/__history") && !req.url.startsWith("/__workspace-footer")) return next();
        const fixture = req.url.startsWith("/__workspace-footer") ? "workspace-footer" : "frontend-audit";
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, `<html><body><div id="root" style="padding:32px"></div><script type="module" src="/scripts/fixtures/${fixture}.tsx"></script></body></html>`));
      });
    } }],
  });
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { streamResponse?.destroy(); await browser?.close(); await server?.close(); });

async function newPage(handler, language = "en") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(value => localStorage.setItem("grapher_language_v1", value), language);
  const errors = [];
  await context.route("**/api/*", handler);
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on("pageerror", error => errors.push(String(error)));
  return { context, page, errors };
}

test("transcript and parser hot updates preserve the mounted conversation", { timeout: 30_000 }, async () => {
  // The other history fixtures disable HMR. Exercise real Vite/React refresh
  // boundaries here without editing source files or touching a running backend.
  const hmrServer = await createServer({ cacheDir: "node_modules/.vite-transcript-hmr",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, watch: null },
    plugins: [{ name: "transcript-hmr-fixture", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith("/__hmr")) return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/scripts/fixtures/frontend-audit.tsx"></script></body></html>'));
      });
    } }],
  });
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }));
  const invalidations = [];
  page.on("console", message => { if (message.text().includes("Could not Fast Refresh")) invalidations.push(message.text()); });
  try {
    await hmrServer.listen();
    await page.goto(`http://127.0.0.1:${hmrServer.httpServer.address().port}/__hmr?case=cardPresentation&type=tool&source=node`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!window.audit?.showCards);
    await page.evaluate(() => window.audit.showCards(true));
    await page.locator(".tool-call-header").click();
    await page.locator(".tool-call-body").waitFor();
    await page.evaluate(async () => {
      window.hmrAudit = { updates: 0, reloads: 0 };
      const { createHotContext } = await import("/@vite/client");
      const hot = createHotContext("/__transcript_hmr_probe");
      hot.on("vite:afterUpdate", () => window.hmrAudit.updates++);
      hot.on("vite:beforeFullReload", () => window.hmrAudit.reloads++);
    });
    let expectedUpdates = 0;
    for (const url of ["/src/components/VirtualizedTranscript.tsx", "/src/services/transcriptParser.ts"]) {
      const module = await hmrServer.moduleGraph.getModuleByUrl(url);
      assert.ok(module, `${url} must be loaded in the browser`);
      await hmrServer.reloadModule(module);
      await page.waitForFunction(expected => window.hmrAudit?.updates >= expected, ++expectedUpdates);
      assert.equal(await page.evaluate(() => window.hmrAudit.reloads), 0, "refresh must not reload the page");
      await page.locator(".tool-call-body").waitFor();
      assert.equal(await page.locator('[data-transcript-id="presentation-tool"]').count(), 1);
    }
    assert.deepEqual(invalidations, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await hmrServer.close(); }
});

test("failed node attempts keep their execution record spacing even", { timeout: 30_000 }, async () => {
  const tool = id => startTool(id, `echo ${id}`) + endTool(id, "done");
  const thinking = line({ type: "message_start", message: { role: "assistant", content: [] } }) +
    line({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }) +
    line({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Reasoning" } }) +
    line({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } });
  const failedOutput = thinking + tool("failed-one") + tool("failed-two") + line({ type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "Connection failed", content: [] } });
  // Resumed sessions can emit whitespace-only text deltas between tool calls.
  const blankDelta = line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "\n\n" } });
  const retryOutput = tool("retry-one") + blankDelta + tool("retry-two");
  const execution = (id, attempt, status, output) => ({ id, node: "task", attempt, revision: attempt, status, output,
    startedAt: attempt * 1000, completedAt: attempt * 1000 + 1, sessionId: "session", worktree: "/mock", before: "", after: "" });
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }));
  try {
    await page.goto(`${origin}/__workspace-footer?mode=graph&turn=follow-up`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.setExecutions);
    await page.evaluate(executions => window.audit.setExecutions(executions), [
      execution("failed", 1, "failed", failedOutput), execution("retry", 2, "completed", retryOutput),
    ]);
    const failureCard = page.locator('[data-execution-id="failed"]').getByTestId("transcript-error-card");
    await failureCard.getByText("Connection failed", { exact: true }).waitFor();
    assert.equal(await failureCard.count(), 1, "the failed attempt retains exactly one error card");
    await page.locator('[data-execution-id="retry"] .tool-call-card').last().waitFor();

    for (const width of [1280, 700]) {
      await page.setViewportSize({ width, height: 900 });
      const metrics = await page.evaluate(() => {
        const panels = [...document.querySelectorAll(".serial-execution-panel")];
        const bounds = element => element.getBoundingClientRect();
        const parts = panels.map(panel => {
          const header = panel.querySelector(".session-label-toggle");
          const rows = [...panel.querySelectorAll("[data-transcript-id]")].map(row =>
            row.querySelector(".tool-call-card, .thinking-card, .system-pill")).filter(Boolean);
          const boxes = [header, ...rows].map(bounds);
          const panelBox = bounds(panel);
          return { gaps: boxes.slice(1).map((box, i) => box.top - boxes[i].bottom),
            insets: rows.filter(row => row.matches(".tool-call-card, .thinking-card")).map(row => {
              const box = bounds(row);
              return [box.left - panelBox.left, panelBox.right - box.right];
            }), first: boxes[0].top, last: boxes.at(-1).bottom };
        });
        return { parts, between: parts[1].first - parts[0].last };
      });
      assert.deepEqual(metrics.parts.map(part => part.gaps.length), [4, 2]);
      for (const gap of [...metrics.parts.flatMap(part => part.gaps), metrics.between]) {
        assert.ok(Math.abs(gap - 10) < 0.6, `record and card gaps must be 10px at ${width}px: ${JSON.stringify(metrics)}`);
      }
      for (const [left, right] of metrics.parts.flatMap(part => part.insets)) {
        assert.ok(Math.abs(left - right) < 0.6, `card insets must be symmetric at ${width}px: ${left}, ${right}`);
      }
    }
    const firstTool = page.locator('[data-execution-id="failed"] .tool-call-card').first();
    await firstTool.locator(".tool-call-header").click();
    await firstTool.locator(".tool-call-body").waitFor();
    const expandedGaps = await firstTool.evaluate(card => {
      const row = card.closest("[data-transcript-id]");
      const previous = row.previousElementSibling.querySelector(".thinking-card").getBoundingClientRect();
      const current = card.getBoundingClientRect();
      const next = row.nextElementSibling.querySelector(".tool-call-card").getBoundingClientRect();
      return [current.top - previous.bottom, next.top - current.bottom];
    });
    assert.ok(expandedGaps.every(gap => Math.abs(gap - 10) < 0.6),
      `expanded cards keep the same spacing: ${expandedGaps}`);
    const headers = page.locator(".session-label-toggle");
    await headers.first().click();
    assert.equal(await headers.first().getAttribute("aria-expanded"), "false");
    const collapsedGap = await page.evaluate(() => {
      const headers = [...document.querySelectorAll(".session-label-toggle")].map(element => element.getBoundingClientRect());
      return headers[1].top - headers[0].bottom;
    });
    assert.ok(Math.abs(collapsedGap - 10) < 0.6, `collapsed records keep the same gap: ${collapsedGap}`);
    await headers.first().click();
    await failureCard.getByText("Connection failed", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a retry's blank streamed text stays out of layout until it has visible content", { timeout: 30_000 }, async () => {
  const tool = id => startTool(id, `echo ${id}`) + endTool(id, "done");
  const delta = text => line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  const execution = (id, attempt, status, output) => ({ id, node: "task", attempt, revision: attempt, status, output,
    startedAt: attempt * 1000, completedAt: status === "running" ? null : attempt * 1000 + 1,
    sessionId: "session", worktree: "/mock", before: "", after: "" });
  const failed = execution("failed", 1, "failed", tool("old-tool"));
  const retryOutput = tool("live-tool") + delta("\n\n");
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }));
  try {
    await page.goto(`${origin}/__workspace-footer?mode=graph&turn=follow-up`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.setExecutions);
    await page.evaluate(executions => window.audit.setExecutions(executions),
      [failed, execution("retry", 2, "running", retryOutput)]);
    const retry = page.locator('[data-execution-id="retry"]');
    await retry.locator(".tool-call-card").waitFor();
    assert.equal(await retry.locator("[data-transcript-id]").count(), 1, "blank live text must not reserve a row");
    await page.evaluate(executions => window.audit.setExecutions(executions), [failed,
      execution("retry", 2, "running", retryOutput + delta("Visible after whitespace") + tool("next-tool"))]);
    await retry.getByText("Visible after whitespace", { exact: true }).waitFor();
    await retry.locator(".tool-call-card").last().waitFor();
    assert.equal(await retry.locator("[data-transcript-id]").count(), 3, "the continued text appears once in its original place");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("history status bridges page gaps without flashing for fast reads or moving history", { timeout: 20_000 }, async () => {
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }));
  try {
    await page.goto(`${origin}/__history?case=historyStatus`, { waitUntil: "networkidle" });
    await page.clock.install();
    // install() alone keeps advancing with wall time between Playwright calls.
    // Freeze it so a slow test runner cannot turn a 30 ms read into a slow one.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 10_000));
    const status = page.locator(".transcript-history-status");
    const anchorTop = await page.locator("[data-history-anchor]").evaluate(element => element.getBoundingClientRect().top);
    await page.evaluate(() => {
      window.historyStatusTexts = [];
      new MutationObserver(() => window.historyStatusTexts.push(document.querySelector(".transcript-history-status")?.textContent))
        .observe(document.querySelector(".transcript-history-status"), { childList: true, subtree: true, characterData: true });
    });
    const loading = async value => {
      await page.evaluate(value => window.audit.setHistoryLoading(value), value);
      await page.waitForFunction(value => document.querySelector("[data-history-loading]").dataset.historyLoading === String(value), value);
    };
    // A fast, isolated read should never paint a loading-text flash, even if
    // the test driver is delayed between its two browser commands.
    await loading(true); await page.clock.runFor(30);
    const pausedTime = await page.evaluate(() => Date.now());
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await page.evaluate(() => Date.now()), pausedTime);
    await loading(false); await page.clock.runFor(1000);
    assert.equal(await status.innerText(), "");
    assert.deepEqual((await page.evaluate(() => window.historyStatusTexts)).filter(Boolean), [], "a fast read must never show the label");
    // Once loading is visible, short per-page idle gaps must not hide it.
    await loading(true); await page.clock.runFor(1000);
    assert.match(await status.innerText(), /Loading earlier records/);
    await page.evaluate(() => { window.historyStatusTexts = []; });
    for (let i = 0; i < 5; i++) {
      await loading(false); await page.clock.runFor(60);
      assert.match(await status.innerText(), /Loading earlier records/);
      await loading(true); await page.clock.runFor(120);
    }
    assert.ok((await page.evaluate(() => window.historyStatusTexts)).every(text => text?.includes("Loading earlier records")),
      "the label cannot disappear in intermediate painted frames");
    assert.equal(await page.locator("[data-history-anchor]").evaluate(element => element.getBoundingClientRect().top), anchorTop);
    await loading(false); await page.clock.runFor(1000);
    assert.equal(await status.innerText(), "", "the label clears after the final page, not forever");
    // Pending timers belong to this mount, not the next conversation.
    await loading(true); await page.clock.runFor(20);
    await page.evaluate(() => window.audit.unmountHistoryStatus());
    await page.clock.runFor(1000);
    assert.equal(await status.count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const role of ["node", "planner"]) {
  test(`${role}: continuous upward paging advances cursors and keeps one stable loading label`, { timeout: 30_000 }, async () => {
    const parts = Array.from({ length: 5 }, (_, part) => Array.from({ length: 60 }, (_, row) => assistant(`PAGING_${part}_${row}`)).join(""));
    const data = Buffer.from(parts.join("")), boundaries = [0];
    for (const part of parts) boundaries.push(boundaries.at(-1) + Buffer.byteLength(part));
    const cursors = [], pending = [];
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON(), command = new URL(route.request().url()).pathname.slice(5);
      if (!["get_execution_output", "get_planning_output"].includes(command)) return route.fulfill({ json: { result: {} } });
      const relevant = role === "node" ? command === "get_execution_output" : command === "get_planning_output";
      const bytes = relevant ? data : Buffer.alloc(0);
      const end = body.before ?? bytes.length;
      const start = !relevant ? 0 : body.tail ? boundaries[Math.max(0, boundaries.indexOf(end) - 1)] : body.offset;
      if (relevant && body.before !== undefined) {
        cursors.push(body.before);
        await new Promise(resolve => pending.push(resolve));
      }
      try { await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        planningId: body.planningId, role: "planner", running: true,
        content: bytes.subarray(start, end).toString(), startOffset: start, nextOffset: end, totalBytes: bytes.length,
        complete: end === bytes.length, status: "running" } } }); } catch {}
    });
    try {
      await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.selectHistory);
      if (role === "planner") await page.evaluate(() => { window.audit.setPlanningIds(["planner-latest"]); window.audit.selectHistory("planner"); });
      const cachedStart = () => page.evaluate(role => (role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning())?.startOffset, role);
      await page.waitForFunction(role => (role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning())?.startOffset > 0, role);
      const scroller = page.locator("[data-shared-scroll]"), status = page.locator(".transcript-history-status");
      for (let i = 0; i < 4; i++) {
        const before = await cachedStart();
        await scroller.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })); });
        for (let wait = 0; wait < 100 && !pending.length; wait++) await page.waitForTimeout(10);
        assert.ok(pending.length, "upward input starts the next page");
        await status.filter({ hasText: "Loading earlier records" }).waitFor();
        pending.shift()();
        await page.waitForFunction(({ role, before }) => (role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning())?.startOffset < before, { role, before });
        // Simulate the pause between adjacent requests during continuous input.
        if (i < 3) { await page.waitForTimeout(60); assert.match(await status.innerText(), /Loading earlier records/); }
      }
      assert.equal(await cachedStart(), 0, "the full history beginning is eventually reached");
      assert.equal(cursors.length, 4);
      assert.ok(cursors.every((cursor, i) => i === 0 || cursor < cursors[i - 1]), "never reread the same older byte page");
      await page.waitForFunction(() => !document.querySelector(".transcript-history-status").textContent);
      await scroller.evaluate(element => element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })));
      await page.waitForTimeout(300);
      assert.equal(cursors.length, 4, "at byte zero upward input must not re-arm loading");
      assert.deepEqual(errors, []);
    } finally { pending.splice(0).forEach(release => release()); await context.close(); }
  });
}

for (const view of ["node", "serial"]) {
  test(`${view}: continuous live pages cannot starve initial history readiness`, { timeout: 30_000 }, async () => {
    const history = Array.from({ length: 80 }, (_, i) => assistant(`STREAM_HISTORY_${i}`)).join("");
    let streaming = true, forwardReads = 0;
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON();
      const command = new URL(route.request().url()).pathname.slice(5);
      if (command !== "get_execution_output") return route.fulfill({ json: { result: {} } });
      const content = body.tail ? history : streaming ? line({ type: "tool_execution_update", toolCallId: "busy-tool", partialResult: { content: [] } }) : "";
      if (!body.tail) forwardReads++;
      const start = body.tail ? 0 : body.offset;
      const end = start + Buffer.byteLength(content);
      return route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        content, startOffset: start, nextOffset: end, totalBytes: streaming ? end + 1 : end,
        complete: !streaming, status: "running" } } });
    });
    try {
      await page.goto(`${origin}/__history?case=latestScroll&layout=live-paged&view=${view}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector('[data-execution-id]')?.getAttribute("aria-busy") === "false", null, { timeout: 4000 });
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".initial-query-scroll")).opacity) > 0.99);
      // The first forward poll can race the reveal; wait bounded time for the backlog.
      for (let i = 0; i < 100 && forwardReads < 2; i++) await page.waitForTimeout(20);
      assert.ok(forwardReads > 1, "exercise an ongoing forward-page backlog");
      assert.equal(streaming, true, "history must reveal without pausing the agent or clicking the pane");
      assert.deepEqual(errors, []);
    } finally { streaming = false; await context.close(); }
  });
}

for (const role of ["node", "planner"]) {
  test(`${role}: sparse tool progress has bounded automatic history fill and remains readable`, { timeout: 30_000 }, async () => {
    const update = line({ type: "tool_execution_update", toolCallId: "long-running-tool", toolName: "bash",
      args: { command: "long-running-command" }, partialResult: { content: [{ type: "text", text: "x".repeat(64 * 1024) }] } });
    const parts = Array.from({ length: 10 }, () => update.repeat(16));
    parts[0] = assistant("OLD_CONTEXT") + startTool("long-running-tool", "long-running-command") + parts[0];
    const data = Buffer.from(parts.join(""));
    const boundaries = [0];
    for (const part of parts) boundaries.push(boundaries.at(-1) + Buffer.byteLength(part));
    let olderReads = 0;
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON();
      const command = new URL(route.request().url()).pathname.slice(5);
      if (!["get_execution_output", "get_planning_output"].includes(command)) return route.fulfill({ json: { result: {} } });
      // The Planner fixture starts on Node; do not count an unrelated Node read
      // while switching to the history under test.
      if (role === "planner" && command === "get_execution_output") return route.fulfill({ json: { result: {
        runId: body.runId, executionId: body.executionId, content: "", startOffset: 0,
        nextOffset: 0, totalBytes: 0, complete: true, status: "running",
      } } });
      // This fixture reuses one synthetic tool id across every Planner
      // revision. The earlier revision is empty so the test still measures the
      // live tail, rather than rendering two identical mock tool rows.
      if (role === "planner" && body.planningId === "planner-previous") return route.fulfill({ json: { result: {
        planningId: body.planningId, role: "planner", content: "", startOffset: 0,
        nextOffset: 0, totalBytes: 0, complete: true, running: false,
      } } });
      const end = body.before ?? data.length;
      const start = body.tail ? boundaries[Math.max(0, boundaries.indexOf(end) - 1)] : body.offset;
      if (body.before !== undefined) olderReads++;
      return route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        planningId: body.planningId, role: "planner", running: true,
        content: data.subarray(start, end).toString(), startOffset: start, nextOffset: end, totalBytes: data.length,
        complete: end === data.length, status: "running" } } });
    });
    try {
      await page.goto(role === "node" ? `${origin}/__history?case=latestScroll&layout=live-paged&view=node`
        : `${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
      if (role === "planner") {
        await page.waitForFunction(() => !!window.audit?.selectHistory);
        await page.evaluate(() => window.audit.selectHistory("planner"));
      }
      const history = page.locator(role === "node" ? "[data-execution-id]" : ".planning-activity");
      await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute("aria-busy") === "false",
        role === "node" ? "[data-execution-id]" : ".planning-activity");
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".initial-query-scroll")).opacity) > 0.99);
      await page.waitForTimeout(300);
      assert.ok(olderReads <= 5, `opening a sparse tail drained ${olderReads} old pages`);
      const stoppedAt = olderReads;
      await page.waitForTimeout(400);
      assert.equal(olderReads, stoppedAt, "automatic loading must stop even with fewer than two viewports of rows");
      assert.equal(await history.locator('[data-transcript-id="long-running-tool"]').count(), 1, "a tail starting inside tool progress still renders the running tool");
      const scroller = page.locator(role === "node" ? ".initial-query-scroll" : "[data-shared-scroll]");
      await scroller.evaluate(element => {
        element.scrollTop = 0;
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
      });
      for (let i = 0; i < 50 && olderReads === stoppedAt; i++) await page.waitForTimeout(20);
      assert.ok(olderReads > stoppedAt, "another upward gesture can continue past the automatic byte budget");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const role of ["node", "planner"]) {
  test(`${role}: giant output stays inside one normal tool card with a small display-bounded body`, { timeout: 30_000 }, async () => {
    const output = startTool("bounded-output-tool", "long-running-command") + endTool("bounded-output-tool", "PREVIEW_HEAD\n" + "x".repeat(400_000) + "HUGE_OUTPUT_TAIL");
    const total = Buffer.byteLength(output);
    const { context, page, errors } = await newPage(async route => {
      const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
      if (!["get_execution_output", "get_planning_output"].includes(command)) return route.fulfill({ json: { result: {} } });
      const start = body.tail ? 0 : body.offset;
      return route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        planningId: body.planningId, role: "planner", running: false, content: output.slice(start), startOffset: start,
        nextOffset: total, totalBytes: total, complete: true, status: "completed" } } });
    });
    try {
      await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.selectHistory);
      if (role === "planner") await page.evaluate(() => { window.audit.setPlanningIds(["planner-latest"]); window.audit.selectHistory("planner"); });
      const card = page.locator('[data-transcript-id="bounded-output-tool"] .tool-call-card');
      await card.waitFor();
      assert.equal(await card.locator(".tool-truncated-pill").count(), 0,
        "a bounded display preview is not tool-reported truncation");
      assert.equal(await card.count(), 1, "keep the tool card, not just an ellipsis in place of it");
      await card.locator(".tool-call-header").click();
      await card.locator(".tool-result-code").waitFor();
      const rendered = await card.locator(".tool-result-code").innerText();
      assert.ok(Buffer.byteLength(rendered) <= 100 * 1024);
      assert.ok(rendered.startsWith("PREVIEW_HEAD"));
      assert.ok(rendered.endsWith("..."));
      assert.ok(!rendered.includes("HUGE_OUTPUT_TAIL"));
      assert.match(await card.locator(".tool-summary").innerText(), /long-running-command/);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const mode of ["graph", "serial", "planner", "merger", "node-merger"]) {
  test(`${mode}: workspace and session details are tooltip-free`, { timeout: 30_000 }, async () => {
    for (const language of ["en", "zh-CN"]) {
      const { context, page, errors } = await newPage(route => route.fulfill({ json: {
        result: route.request().url().endsWith("/get_merger_prompt") ? { prompt: "Merge the completed work." } : {},
      } }), language);
      try {
        await page.goto(`${origin}/__workspace-footer?mode=${mode}`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => !!window.audit?.startExecution);
        if (mode !== "planner") await page.evaluate(() => { window.audit.startExecution(); window.audit.finish(); });
        const name = language === "en"
          ? (mode === "planner" ? "Planning session details" : "Workspace and session details")
          : (mode === "planner" ? "规划会话信息" : "工作区与会话信息");
        await page.getByRole("button", { name, exact: true }).click();
        const details = page.locator(".workspace-details");
        await details.getByText("Cumulative tokens: —", { exact: true }).waitFor();
        await details.getByText("Context window: —", { exact: true }).waitFor();
        await details.getByText("Current context: —", { exact: true }).waitFor();
        assert.equal(await page.locator(".workspace-details[title], .workspace-details [title]").count(), 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  });
}

test("graph resize and expand controls are tooltip-free and remain keyboard accessible", { timeout: 30_000 }, async () => {
  for (const language of ["en", "zh-CN"]) {
    const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }), language);
    try {
      await page.goto(`${origin}/__workspace-footer?mode=graph`, { waitUntil: "domcontentloaded" });
      const splitter = page.getByRole("separator", { name: language === "en" ? "Resize execution graph" : "调整执行拓扑图宽度", exact: true });
      await splitter.waitFor();
      assert.equal(await splitter.getAttribute("title"), null);
      assert.equal(await splitter.locator("[title]").count(), 0);
      assert.match(await splitter.getAttribute("aria-description"), /Enter/);
      const originalWidth = await splitter.getAttribute("aria-valuenow");
      await splitter.press("ArrowLeft");
      await page.waitForFunction(value => document.querySelector(".workbench-resizer")?.getAttribute("aria-valuenow") !== value, originalWidth);
      const resizedWidth = await splitter.getAttribute("aria-valuenow");
      await splitter.press("Enter");
      const expand = page.getByRole("button", { name: language === "en" ? "Expand execution graph" : "展开执行拓扑图", exact: true });
      await expand.waitFor();
      assert.equal(await expand.getAttribute("title"), null);
      await expand.press("Enter");
      await splitter.waitFor();
      assert.equal(await splitter.getAttribute("aria-valuenow"), resizedWidth);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

for (const mode of ["graph", "serial", "planner"]) {
  test(`${mode}: session detail attributes use capitalized initials`, { timeout: 30_000 }, async () => {
    for (const language of ["en", "zh-CN"]) {
      const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }), language);
      try {
        await page.goto(`${origin}/__workspace-footer?mode=${mode}`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => !!window.audit?.startExecution);
        if (mode !== "planner") await page.evaluate(() => { window.audit.startExecution(); window.audit.finish(); });
        const name = language === "en"
          ? (mode === "planner" ? "Planning session details" : "Workspace and session details")
          : (mode === "planner" ? "规划会话信息" : "工作区与会话信息");
        await page.getByRole("button", { name, exact: true }).click();
        const details = page.locator(".workspace-details-body");
        await details.getByText("Current context: —", { exact: true }).waitFor();
        const labels = (await details.locator("p").allTextContents()).map(text => text.split(":")[0]);
        for (const label of labels) assert.match(label, /^[A-Z]/, `${mode}: ${label}`);
        for (const label of [
          "Workspace", ...(mode === "planner" ? [] : ["Session id"]),
          ...(mode === "graph" ? ["Commit"] : []),
          "Start time", "Time took",
          "Cumulative tokens", "Input", "Output", "Cache read", "Cache write", "Reasoning", "Context window", "Current context",
          // Model settings sit on the last row, after token usage.
          "Model", "Thinking level",
        ]) assert.ok(labels.includes(label), `${mode}: missing ${label}`);
        await details.getByText("Workspace: /mock", { exact: true }).waitFor();
        await details.getByText("Model: test/model", { exact: true }).waitFor();
        await details.getByText(`Thinking level: ${mode === "planner" ? "high" : "low"}`, { exact: true }).waitFor();
        if (mode !== "planner") await details.getByText("Session id: session", { exact: true }).waitFor();
        if (mode === "graph") {
          await details.getByText("Commit: not snapshotted → direct modification (no snapshot)", { exact: true }).waitFor();
        }
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  });
}

test("Planner details show the backend-selected cwd for every turn", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }));
  try {
    await page.goto(`${origin}/__workspace-footer?mode=planner`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Planning session details", exact: true }).click();
    const details = page.locator(".workspace-details-body");
    await details.getByText("Workspace: /mock", { exact: true }).waitFor();
    for (const worktree of ["/worktrees/run/root", "/worktrees/run/right", "/mock"]) {
      await page.evaluate(path => window.audit.selectPlannerWorkspace(path), worktree);
      await details.getByText(`Workspace: ${worktree}`, { exact: true }).waitFor();
    }
    assert.equal(await details.getByText("workspace history", { exact: true }).count(), 0);
    assert.doesNotMatch(await details.innerText(), /\/worktrees\/run\/(?:root|right)/,
      "planning details show the current workspace, not historical workspaces");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("completed write-back details live inside the topology overview with copy and merger history", { timeout: 30_000 }, async () => {
  const mergerReads = [];
  const { context, page, errors } = await newPage(route => {
    if (route.request().url().endsWith("/get_execution_output")) {
      const body = route.request().postDataJSON();
      mergerReads.push(body.executionId);
      const content = assistant(`PUBLICATION_LOG_${body.executionId}`);
      return route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        content, startOffset: 0, nextOffset: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content),
        complete: true, status: "completed" } } });
    }
    return route.fulfill({ json: { result: {} } });
  });
  const completedAt = Date.UTC(2025, 4, 6, 12, 34, 56);
  const publication = { repository: "/published/source-workspace", heads: ["terminal-1"],
    status: "completed", head: null, error: null, startedAt: completedAt - 1000, completedAt };
  const attempts = [1, 2].map(attempt => ({ id: `publication-${attempt}`, node: "merger", attempt,
    revision: 1, sessionId: `merger-session-${attempt}`, worktree: `/worktrees/merger-${attempt}`,
    before: "before", after: "", status: "completed", output: "",
    outputBytes: Buffer.byteLength(assistant(`PUBLICATION_LOG_publication-${attempt}`)),
    startedAt: completedAt - 1000, completedAt }));
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await page.goto(`${origin}/__workspace-footer?mode=planner`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.setPublicationResult);
    await page.evaluate(() => {
      window.audit.startExecution();
      window.audit.finish();
      window.audit.setRunSummary("completed", null);
      window.audit.setPublicationResult({ status: "failed" });
    });
    const overview = page.locator(".plan-summary-card");
    const details = overview.getByTestId("publication-completed-details");
    await overview.waitFor();
    for (const [status, label] of [
      ["failed", "Publication failed. Action required"],
      ["publishing", "Writing to the workspace"],
      ["merging", "merger is resolving conflicts"],
    ]) {
      await page.evaluate(async status => {
        window.audit.setPublicationResult({ status });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, status);
      assert.equal(await details.count(), 0, `${status} must not claim results were written back`);
      // Write-back progress and failure live in the topology footer, not a banner.
      const footer = page.locator(".graph-bottom .approval-row");
      assert.equal(await footer.locator(":scope > span").innerText(), label);
      assert.equal(await footer.getByRole("button", { name: "Retry publication", exact: true }).count(),
        status === "failed" ? 1 : 0);
      assert.equal(await page.locator(".publication-panel").count(), 0,
        "write-back must not render as a separate banner");
    }
    await page.evaluate(({ publication, attempts }) => window.audit.setPublicationResult(publication, attempts), { publication, attempts });
    await details.waitFor();
    assert.equal(await overview.count(), 1);
    assert.equal(await page.getByTestId("workspace-written-completed-card").count(), 0,
      "there is no separate execution-completed card");
    assert.match(await overview.locator(".plan-summary-header").innerText(), /Execution graph overview/);
    assert.equal(await details.locator(".pub-card-path").innerText(), publication.repository);
    // The write-back details show the target workspace and completion time; the
    // former summary line was removed with its copy.
    assert.doesNotMatch(await details.innerText(), /Completed all|terminal nodes|Results have been combined/);
    assert.equal(await details.locator(".pub-card-time").innerText(), await page.evaluate(stamp =>
      new Date(stamp).toLocaleString("en-US"), completedAt));
    await details.getByRole("button", { name: "Copy workspace directory", exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), publication.repository);
    await details.locator(".pub-card-mergers-summary").click();
    await details.getByText("PUBLICATION_LOG_publication-2", { exact: true }).waitFor();
    await details.getByLabel("Select execution:", { exact: true }).selectOption("publication-1");
    await details.getByText("PUBLICATION_LOG_publication-1", { exact: true }).waitFor();
    assert.match(await details.locator(".pub-card-merger-info").innerText(), /merger-session-1/);
    assert.deepEqual([...new Set(mergerReads)].sort(), ["publication-1", "publication-2"]);
    // Older runs may have no publication projection; their completion details
    // still belong to the same overview, using the configured workspace.
    await page.evaluate(() => window.audit.setPublicationResult(null));
    await details.locator(".pub-card-path").filter({ hasText: "/mock" }).waitFor();
    assert.equal(await overview.count(), 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

async function assertHistoryWheelProgress(page, scroller) {
  await scroller.waitFor();
  await page.waitForFunction(element => element.scrollHeight - element.clientHeight > 1800, await scroller.elementHandle());
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(200);
  await scroller.hover({ position: { x: 10, y: 80 } });
  await page.mouse.wheel(0, -800);
  await page.waitForTimeout(300);
  for (let index = 0; index < 6; index++) {
    const before = await scroller.evaluate(element => {
      const view = element.getBoundingClientRect();
      const row = [...element.querySelectorAll("[data-transcript-id]")].find(item => {
        const rect = item.getBoundingClientRect();
        return rect.bottom > view.top + 1 && rect.top < view.bottom - 1;
      });
      return row && { id: row.dataset.transcriptId, top: row.getBoundingClientRect().top, scroll: element.scrollTop };
    });
    assert.ok(before, "a retained transcript row must be visible");
    await page.mouse.wheel(0, -80);
    await page.waitForTimeout(300);
    const after = await scroller.locator(`[data-transcript-id="${before.id}"]`).evaluate(row => ({
      top: row.getBoundingClientRect().top, scroll: row.closest(".pub-card-merger-transcript, .initial-query-scroll").scrollTop }));
    assert.ok(Math.abs(after.top - before.top - 80) <= 4,
      `scrollback must preserve the wheel motion: ${JSON.stringify({ index, before, after })}`);
  }
}

for (const mode of ["serial", "graph", "merger", "node-merger"]) {
  test(`${mode}: execution history preserves upward wheel progress`, { timeout: 60_000 }, async () => {
    const output = Array.from({ length: 100 }, (_, index) =>
      assistant(`MODE_HISTORY_${index} ` + (index % 2 ? "wrapped content ".repeat(40) : "short"))).join("");
    const { context, page, errors } = await newPage(route => route.fulfill({ json: {
      result: route.request().url().endsWith("/get_merger_prompt") ? { prompt: "Merge the completed work." } : {},
    } }));
    try {
      page.setDefaultTimeout(30_000);
      await page.goto(`${origin}/__workspace-footer?mode=${mode}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.setExecutions);
      await page.evaluate(output => {
        window.audit.startExecution();
        window.audit.setExecutions([{ id: "current", node: "task", status: "completed", output,
          revision: 1, attempt: 1, startedAt: 1, completedAt: 2, sessionId: "s", worktree: "/mock", before: "", after: "" }]);
        window.audit.finish();
      }, output);
      await page.locator('[data-execution-id="current"] [data-transcript-id]').first().waitFor({ state: "attached" });
      await page.locator(".initial-query-scroll.conversation-ready").waitFor();
      await assertHistoryWheelProgress(page, page.locator(".initial-query-scroll"));
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("live Planner history preserves upward wheel progress", { timeout: 60_000 }, async () => {
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }));
  try {
    page.setDefaultTimeout(30_000);
    await page.goto(`${origin}/__history?case=plannerRoute&longThinking=1`, { waitUntil: "domcontentloaded" });
    await page.locator(".planner-transcript [data-transcript-id]").first().waitFor({ state: "attached" });
    await page.locator(".initial-query-scroll.conversation-ready").waitFor();
    await assertHistoryWheelProgress(page, page.locator(".initial-query-scroll"));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("write-back merger history preserves wheel progress in its nested viewport", { timeout: 60_000 }, async () => {
  const content = Array.from({ length: 100 }, (_, index) =>
    assistant(`PUBLICATION_HISTORY_${index} ` + (index % 2 ? "wrapped content ".repeat(40) : "short"))).join("");
  const { context, page, errors } = await newPage(route => {
    if (!route.request().url().endsWith("/get_execution_output")) return route.fulfill({ json: { result: {} } });
    const body = route.request().postDataJSON(), bytes = Buffer.from(content);
    const start = body.offset ?? 0, end = bytes.length;
    return route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
      content: bytes.subarray(start).toString(), startOffset: start, nextOffset: end, totalBytes: end,
      complete: true, status: "completed" } } });
  });
  try {
    page.setDefaultTimeout(30_000);
    await page.goto(`${origin}/__workspace-footer?mode=planner`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.setPublicationResult);
    await page.evaluate(bytes => {
      window.audit.startExecution(); window.audit.finish(); window.audit.setRunSummary("completed", null);
      window.audit.setPublicationResult({ status: "completed", repository: "/mock", completedAt: 2 }, [{
        id: "publication-scroll", node: "merger", status: "completed", output: "", outputBytes: bytes,
        revision: 1, attempt: 1, startedAt: 1, completedAt: 2, sessionId: "s", worktree: "/mock", before: "", after: "",
      }]);
    }, Buffer.byteLength(content));
    await page.locator(".pub-card-mergers-summary").click();
    const scroller = page.locator(".pub-card-merger-transcript");
    await scroller.locator("[data-transcript-id]").first().waitFor({ state: "attached" });
    await assertHistoryWheelProgress(page, scroller);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("completed topology reports task token totals and cache percentage only after completion", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }));
  const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, consumedTokens: 0 };
  const totalUsage = { ...emptyUsage, input: 99_990_000, cacheRead: 899_910_000, totalTokens: 999_900_000, consumedTokens: 99_990_000 };
  const metrics = { totalDurationSeconds: 1, planningDurationSeconds: 0, executionDurationSeconds: 1,
    assistantMessages: 1, tools: 0, toolErrors: 0, totalUsage, planningUsage: emptyUsage, executionUsage: totalUsage };
  try {
    await page.goto(`${origin}/__workspace-footer?mode=graph`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.setRunSummary);
    await page.evaluate(metrics => {
      window.audit.startExecution();
      window.audit.finish();
      // The current node is not the source of the conversation-wide total.
      window.audit.setExecutionMetrics({ durationSeconds: 1, assistantMessages: 1, tools: 0, toolErrors: 0,
        usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 200, consumedTokens: 200 } });
      window.audit.setRunSummary("running", metrics);
    }, metrics);
    const status = page.locator(".graph-bottom .approval-row > span");
    await status.waitFor();
    assert.doesNotMatch(await status.innerText(), /Tokens used|cached:/);
    await page.evaluate(metrics => window.audit.setRunSummary("completed", metrics), metrics);
    await status.filter({ hasText: /Run completed - Tokens used: 99\.99M\s+cached:90%/ }).waitFor();
    await page.setViewportSize({ width: 600, height: 900 });
    assert.equal(await page.locator(".graph-bottom").evaluate(element => element.scrollWidth > element.clientWidth), false,
      "the completed usage summary must fit or wrap inside the topology footer");
    await page.evaluate(metrics => window.audit.setRunSummary("completed", metrics), { ...metrics, totalUsage: emptyUsage });
    await status.filter({ hasText: /Tokens used: 0k\s+cached:0%/ }).waitFor();
    await page.evaluate(() => window.audit.setRunSummary("completed", null));
    await status.filter({ hasText: /Tokens used: —\s+cached:—/ }).waitFor();
    await page.evaluate(metrics => window.audit.setRunSummary("running", metrics), metrics);
    await status.filter({ hasNotText: "Tokens used" }).waitFor();
    assert.doesNotMatch(await status.innerText(), /cached:/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const mode of ["serial", "graph", "planner", "merger", "node-merger"]) {
  test(`${mode}: session token usage derives task totals from backend metrics without retaining stale counts`, { timeout: 30_000 }, async () => {
    const { context, page, errors } = await newPage(route => route.fulfill({ json: {
      result: route.request().url().endsWith("/get_merger_prompt") ? { prompt: "Merge the completed work." } : {},
    } }));
    try {
      await page.goto(`${origin}/__workspace-footer?mode=${mode}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.startExecution);
      if (mode !== "planner") await page.evaluate(() => { window.audit.startExecution(); window.audit.finish(); });
      await page.getByRole("button", { name: mode === "planner" ? "Planning session details" : "Workspace and session details", exact: true }).click();
      const details = page.locator(".workspace-details-body");
      const labels = ["Cumulative tokens", "Input", "Output", "Cache read", "Cache write", "Reasoning", "Context window", "Current context"];
      for (const label of labels) await details.getByText(`${label}: —`, { exact: true }).waitFor();
      const update = (usage, context) => page.evaluate(({ mode, usage, context }) => {
        const metrics = {
          durationSeconds: 1, assistantMessages: 1, tools: 0, toolErrors: 0, usage,
          ...(context ? { contextTokens: context.tokens, contextPeak: context.peak } : {}),
        };
        if (mode === "planner") window.audit.setPlannerRoles({
          // Other planning roles must not leak into the Planner's own counters.
          partition: { ...metrics, model: "partition/model", usage: { ...usage, totalTokens: 999_999 } },
          ...(usage ? { planner: { ...metrics, model: "planner/model" } } : {}),
        });
        else window.audit.setExecutionMetrics(usage || context ? metrics : null);
      }, { mode, usage, context });
      // Legacy Planner summaries without a session id have no model window.
      const contextWindow = mode === "planner" ? "—" : "100k";
      const contextPercent = mode === "planner" ? "" : " (8%)";
      await update({ totalTokens: 18_000, input: 12_000, output: 1_800, cacheRead: 4_000, cacheWrite: 200, reasoning: 600, consumedTokens: 14_000 }, { tokens: 8_000, peak: 8_000 });
      for (const [index, value] of ["14k", "12k", "1.8k", "4k", "0.2k", "0.6k", contextWindow, `8k${contextPercent}`].entries()) {
        await details.getByText(`${labels[index]}: ${value}`, { exact: true }).waitFor();
      }
      // The provider total mixes cached re-reads and is no longer shown.
      assert.equal(await details.getByText(/provider total/).count(), 0);
      const heavy = { totalTokens: 1_234_567, input: 1_000_000, output: 200_000, cacheRead: 30_000, cacheWrite: 4_000, reasoning: 567, consumedTokens: 1_204_000 };
      await update(heavy, { tokens: 40_000, peak: 40_000 });
      for (const [index, value] of ["1.2M", "1M", "200k", "30k", "4k", "0.57k", contextWindow, mode === "planner" ? "40k" : "40k (40%)"].entries()) {
        await details.getByText(`${labels[index]}: ${value}`, { exact: true }).waitFor();
      }
      // After compaction only the smaller current prompt is shown; the
      // session's high-water mark is not part of the panel.
      await update(heavy, { tokens: 40_000, peak: 90_000 });
      await details.getByText(`Context window: ${contextWindow}`, { exact: true }).waitFor();
      await details.getByText(`Current context: ${mode === "planner" ? "40k" : "40k (40%)"}`, { exact: true }).waitFor();
      assert.equal(await details.getByText(/^peak:/).count(), 0);
      await update(heavy, { tokens: 40_000, peak: 40_000 });
      const positions = await details.locator("p").evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { text: element.textContent, top: rect.top, left: rect.left, right: rect.right };
      }));
      let previousTop = -Infinity;
      for (const group of [["Start time", "Time took"], labels.slice(0, 3), labels.slice(3, 6), labels.slice(6)]) {
        const fields = group.map(label => positions.find(item => item.text.startsWith(`${label}: `)));
        assert.ok(fields.every(Boolean), `missing session fields: ${group.join(", ")}`);
        assert.ok(fields[0].top > previousTop, "timing, totals and cache details occupy successive rows");
        previousTop = fields[0].top;
        for (let index = 1; index < fields.length; index++) {
          assert.ok(Math.abs(fields[index].top - fields[0].top) <= 1, `${group.join(", ")} must share a row`);
          assert.ok(fields[index].left > fields[index - 1].right, `${group[index]} must be to the right of ${group[index - 1]}`);
        }
      }
      await page.setViewportSize({ width: 600, height: 900 });
      const overflows = await details.evaluate(element => element.scrollWidth > element.clientWidth);
      assert.equal(overflows, false, "narrow session panels wrap fields instead of overflowing horizontally");
      await update({ totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, consumedTokens: 0 });
      for (const label of labels.slice(0, 6)) await details.getByText(`${label}: 0k`, { exact: true }).waitFor();
      // No context counters means unknown, not a zero-token prompt.
      await details.getByText("Context window: —", { exact: true }).waitFor();
      await details.getByText("Current context: —", { exact: true }).waitFor();
      await update(null);
      for (const label of labels) await details.getByText(`${label}: —`, { exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("a resumed session keeps earlier attempts in the session token totals", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }));
  try {
    await page.goto(`${origin}/__workspace-footer?mode=serial&turn=follow-up`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.startExecution);
    await page.evaluate(() => { window.audit.startExecution(); window.audit.finish(); });
    await page.evaluate(() => {
      const metrics = (usage, contextTokens) => ({ durationSeconds: 1, assistantMessages: 1, tools: 0, toolErrors: 0, usage,
        contextTokens, contextPeak: contextTokens });
      // A follow-up resumes the first attempt's Pi session, so the panel shows
      // the session total rather than only the latest attempt's delta.
      window.audit.setExecutionMetrics(metrics({
        input: 12_000, output: 1_800, cacheRead: 4_000, cacheWrite: 200, reasoning: 600, totalTokens: 18_000, consumedTokens: 14_000,
      }, 18_000), "previous");
      window.audit.setExecutionMetrics(metrics({
        input: 3_000, output: 200, cacheRead: 15_000, cacheWrite: 0, reasoning: 40, totalTokens: 18_200, consumedTokens: 3_200,
      }, 19_000));
    });
    await page.getByRole("button", { name: "Workspace and session details", exact: true }).click();
    const details = page.locator(".workspace-details-body");
    for (const text of [
      "Cumulative tokens: 17.2k", "Input: 15k", "Output: 2k", "Cache read: 19k",
      // Context follows the newest turn of the resumed session, not the sum.
      "Context window: 100k", "Current context: 19k (19%)",
    ]) await details.getByText(text, { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

const sessionStamp = ms => {
  const date = new Date(ms), pad = part => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

test("the Planner session keeps its first start and accumulates time took across turns", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }));
  try {
    await page.goto(`${origin}/__workspace-footer?mode=planner`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.selectPlannerWorkspace);
    // A follow-up Planner turn resumes the same Pi session.
    await page.evaluate(() => window.audit.selectPlannerWorkspace("/mock/next"));
    const firstStart = new Date(2026, 9, 21, 14, 55, 45).getTime();
    const secondStart = new Date(2026, 9, 21, 15, 5, 0).getTime();
    await page.evaluate(({ firstStart, secondStart }) => {
      const role = (sessionId, sessionStart, durationSeconds) => ({
        model: "planner/model", sessionId, sessionStart: String(sessionStart), durationSeconds,
        assistantMessages: 1, tools: 0, toolErrors: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 },
      });
      window.audit.setPlannerRoles({ planner: role("planner-session", firstStart, 60) }, 0);
      window.audit.setPlannerRoles({ planner: role("planner-session", secondStart, 30) }, 1);
    }, { firstStart, secondStart });
    await page.getByRole("button", { name: "Planning session details", exact: true }).click();
    const details = page.locator(".workspace-details-body");
    await details.getByText(`Start time: ${sessionStamp(firstStart)}`, { exact: true }).waitFor();
    await details.getByText("Time took: 1m 30s", { exact: true }).waitFor();
    // An edited Planner conversation forks the Pi session: the new branch does
    // not inherit the abandoned branch's clock.
    await page.evaluate(({ secondStart }) => {
      const role = (sessionId, sessionStart, durationSeconds) => ({
        model: "planner/model", sessionId, sessionStart: String(sessionStart), durationSeconds,
        assistantMessages: 1, tools: 0, toolErrors: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 },
      });
      window.audit.setPlannerRoles({ planner: role("old-session", secondStart + 60_000, 5) }, 0);
      window.audit.setPlannerRoles({ planner: role("planner-session", secondStart, 30) }, 1);
    }, { secondStart });
    await details.getByText(`Start time: ${sessionStamp(secondStart)}`, { exact: true }).waitFor();
    await details.getByText("Time took: 30s", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a Planner turn recorded before session tracking keeps its usage", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }));
  try {
    await page.goto(`${origin}/__workspace-footer?mode=planner`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.selectPlannerWorkspace);
    // The second turn creates a backend session bucket; the first predates
    // session IDs, so only the panel can add its usage back.
    await page.evaluate(() => window.audit.selectPlannerWorkspace("/mock/next"));
    await page.evaluate(() => {
      const usage = input => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
        totalTokens: input, consumedTokens: input });
      const role = (sessionId, input) => ({
        model: "planner/model", sessionId, durationSeconds: 1, assistantMessages: 1, tools: 0, toolErrors: 0,
        usage: usage(input),
      });
      window.audit.setPlannerRoles({ planner: role(undefined, 5_000) }, 0);
      window.audit.setPlannerRoles({ planner: role("planner-session", 3_000) }, 1);
    });
    await page.getByRole("button", { name: "Planning session details", exact: true }).click();
    const details = page.locator(".workspace-details-body");
    await details.getByText("Cumulative tokens: 8k", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("an older attempt shows usage only through that attempt", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await newPage(route => route.fulfill({ json: {
    result: route.request().url().endsWith("/get_merger_prompt") ? { prompt: "Merge the completed work." } : {},
  } }));
  try {
    await page.goto(`${origin}/__workspace-footer?mode=merger&turn=follow-up`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.selectMerger);
    await page.evaluate(() => { window.audit.startExecution(); window.audit.finish(); });
    await page.evaluate(() => {
      const usage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0,
        totalTokens: input + output, consumedTokens: input + output });
      const metrics = value => ({ durationSeconds: 1, assistantMessages: 1, tools: 0, toolErrors: 0, usage: value });
      // The follow-up resumes the first Merger's session.
      window.audit.setExecutionTiming("previous", 1_000, 2_000);
      window.audit.setExecutionTiming("current", 10_000, 11_000);
      window.audit.setExecutionMetrics(metrics(usage(1_000, 100)), "previous");
      window.audit.setExecutionMetrics(metrics(usage(2_000, 200)), "current");
    });
    await page.getByRole("button", { name: "Workspace and session details", exact: true }).click();
    const details = page.locator(".workspace-details-body");
    // The newest attempt keeps the whole resumed session's total.
    await details.getByText("Cumulative tokens: 3.3k", { exact: true }).waitFor();
    // Selecting the first attempt must not inherit the later attempt's usage.
    await page.evaluate(() => window.audit.selectMerger("previous"));
    await details.getByText("Cumulative tokens: 1.1k", { exact: true }).waitFor();
    assert.equal(await details.getByText("Cumulative tokens: 3.3k", { exact: true }).count(), 0);
    // A missing attempt usage makes the prefix unknowable; show no token row
    // rather than a partial or whole-session total.
    await page.evaluate(() => window.audit.setExecutionMetrics(null, "previous"));
    await page.waitForTimeout(100);
    assert.equal(await details.getByText(/Cumulative tokens:/).count(), 0);
    assert.equal(await details.getByText(/^Input:/).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a resumed node session keeps its first start and accumulates time took", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }));
  try {
    await page.goto(`${origin}/__workspace-footer?mode=serial&turn=follow-up`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.startExecution);
    await page.evaluate(() => window.audit.startExecution());
    const firstStart = new Date(2026, 9, 21, 14, 55, 45).getTime();
    const secondStart = new Date(2026, 9, 21, 15, 5, 0).getTime();
    await page.evaluate(({ firstStart, secondStart }) => {
      const metrics = durationSeconds => ({ durationSeconds, assistantMessages: 1, tools: 0, toolErrors: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 } });
      window.audit.setExecutionTiming("previous", firstStart, firstStart + 60_000);
      window.audit.setExecutionTiming("current", secondStart, secondStart + 30_000);
      window.audit.setExecutionMetrics(metrics(60), "previous");
      window.audit.setExecutionMetrics(metrics(30), "current");
    }, { firstStart, secondStart });
    await page.getByRole("button", { name: "Workspace and session details", exact: true }).click();
    const details = page.locator(".workspace-details-body");
    await details.getByText(`Start time: ${sessionStamp(firstStart)}`, { exact: true }).waitFor();
    await details.getByText("Time took: 1m 30s", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const [mode, turn] of [
  ["serial", "provisional"], ["serial", "initial"], ["serial", "follow-up"], ["graph", "initial"], ["graph", "follow-up"],
]) {
  test(`workspace footer: ${mode} ${turn} stays still before model output`, { timeout: 30_000 }, async () => {
    let releaseOutput;
    const outputReady = new Promise(resolve => { releaseOutput = resolve; });
    let currentOutput = line({ type: "grapher_process_started", pid: 123 }), settled = false;
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON();
      const command = new URL(route.request().url()).pathname.slice(5);
      if (command === "get_execution_output") {
        if (body.executionId === "current") await outputReady;
        const content = body.executionId === "current" ? currentOutput : "";
        const total = Buffer.byteLength(content);
        return route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
          content: content.slice(body.offset ?? 0), startOffset: body.offset ?? 0, nextOffset: total, totalBytes: total,
          complete: true, status: body.executionId === "current" && !settled ? "running" : "completed" } } });
      }
      return route.fulfill({ json: { result: command === "list_files" ? { files: [] } : { skills: [] } } });
    });
    try {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(`${origin}/__workspace-footer?mode=${mode}&turn=${turn}`, { waitUntil: "domcontentloaded" });
      const trigger = page.getByRole("button", { name: "Workspace and session details", exact: true });
      await trigger.waitFor();
      await page.waitForTimeout(250);
      if (turn === "follow-up") {
        await page.evaluate(() => window.audit.send());
        await page.getByText("Follow-up task", { exact: true }).waitFor();
      }
      const working = page.locator(".workspace-details .working-indicator");
      await working.waitFor();
      // Let the indicator finish its reveal before sampling the settled footer.
      await page.waitForTimeout(260);
      const before = { button: await trigger.evaluate(element => element.getBoundingClientRect().top),
        working: await working.evaluate(element => element.getBoundingClientRect().top) };
      await page.evaluate(turn => {
        window.audit.footerSamples = [];
        window.audit.sampling = true;
        const sample = () => {
          window.audit.footerSamples.push({ button: document.querySelector(".workspace-details-trigger").getBoundingClientRect().top,
            working: document.querySelector(".workspace-details .working-indicator")?.getBoundingClientRect().top });
          if (window.audit.sampling) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        if (turn === "provisional") window.audit.confirmRun();
        else window.audit.startExecution(100);
      }, turn);
      if (turn === "provisional") {
        await page.waitForTimeout(60);
        await page.evaluate(() => window.audit.createNode());
        await page.waitForTimeout(100);
        await page.evaluate(() => window.audit.startExecution(100));
      }
      await page.waitForTimeout(150);
      releaseOutput();
      await page.waitForFunction(() => document.querySelector('[data-execution-id="current"]')?.getAttribute("aria-busy") === "false");
      await page.waitForTimeout(200);
      const samples = await page.evaluate(() => { window.audit.sampling = false; return window.audit.footerSamples; });
      assert.ok(samples.length >= 3, "measure painted frames, not just the settled position");
      assert.ok(samples.every(sample => Math.abs(sample.button - before.button) <= 1 && Math.abs(sample.working - before.working) <= 1),
        `footer moved before model output: before=${JSON.stringify(before)}, frames=${JSON.stringify(samples)}`);
      const buttonBox = await trigger.boundingBox(), workingBox = await working.boundingBox(), textBox = await trigger.locator("span").boundingBox();
      assert.ok(workingBox.y + workingBox.height <= buttonBox.y, "Working is above the details button");
      assert.ok(Math.abs(workingBox.x - textBox.x) <= 1, "Working aligns with the button text");
      await trigger.click();
      await page.waitForTimeout(320);
      assert.equal(await trigger.getAttribute("aria-expanded"), "true");
      assert.equal(await working.count(), 1, "expanded details keep Working visible");
      await trigger.click();
      await working.waitFor();
      currentOutput += assistant("FIRST_MODEL_OUTPUT");
      await page.getByText("FIRST_MODEL_OUTPUT", { exact: true }).waitFor();
      settled = true;
      await page.evaluate(() => window.audit.finish());
      await working.waitFor({ state: "detached" });
      assert.deepEqual(errors, []);
    } finally { releaseOutput(); await context.close(); }
  });
}

test("actual App shows a Planner follow-up while its turn is stalled before launch", { timeout: 45_000 }, async () => {
  const config = { repository: "/mock/stalled-append", model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: true };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const running = { ...empty, runId: "stalled-run", config, planType: "graph", phase: "running", approved: true, planningId: "old-plan",
    graph: { originalGoal: "Original goal", nodes: [{ name: "worker", task: "Task" }], edges: [] },
    nodes: { worker: { status: "running", revision: 1, instruction: "", error: null } },
    executions: [{ id: "running-execution", node: "worker", status: "running", revision: 1, attempt: 1,
      startedAt: 1, completedAt: null, sessionId: "worker-session", worktree: "/mock/stalled-append-worker",
      before: "", after: null, output: "", outputBytes: 0 }],
    events: [{ type: "created", sequence: 1, planning_id: "old-plan", timestamp: 1 }] };
  let streamed = null;
  onPlanStream = (body, res) => {
    assert.equal(body.revisionRunId, running.runId);
    streamed = res;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: run_started
data: ${JSON.stringify({ runId: running.runId })}

`);
  };
  const { context, page, errors } = await newPage(route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (command === "plan_goal_stream") return route.continue();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [running.runId], repositoryInfo: { path: config.repository, name: "Stalled append", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = running; break;
      case "snapshot_if_changed": result = { version: "running", snapshot: running }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_planning_output": {
        const content = assistant("Old planner turn");
        result = { planningId: body.planningId, role: "planner", content: body.offset ? "" : content,
          startOffset: body.offset ?? 0, nextOffset: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content), complete: true, running: false };
        break;
      }
      case "get_execution_output": result = { runId: body.runId, executionId: body.executionId, content: "",
        startOffset: body.offset ?? 0, nextOffset: 0, totalBytes: 0, complete: true, status: "running" }; break;
      default: result = {};
    }
    return route.fulfill({ json: { result } });
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="stalled-run"]').click();
    await page.locator(".pane-bottom-chat").first().waitFor();
    const input = page.locator(".pane-bottom-chat textarea");
    await input.fill("APPEND_DURING_RUN"); await input.press("Enter");
    await page.locator('.chat-bubble-user', { hasText: "APPEND_DURING_RUN" }).waitFor();
    for (let i = 0; !streamed && i < 100; i++) await page.waitForTimeout(20);
    assert.ok(streamed, "the stalled Planner turn started");
    assert.equal(await page.locator('.chat-bubble-user', { hasText: "APPEND_DURING_RUN" }).count(), 1);
    await page.locator(".planner-result-cards.is-hidden").waitFor({ state: "attached" });
    assert.deepEqual(errors, []);
  } finally {
    onPlanStream = undefined; streamed?.destroy(); streamResponse = undefined; await context.close();
  }
});

test("actual App keeps a Planner follow-up draft when bootstrap still blocks the turn", { timeout: 45_000 }, async () => {
  const config = { repository: "/mock/bootstrap-gate", model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: true };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const saved = { ...empty, runId: "fast", config, planType: "graph", approved: true, phase: "completed",
    graph: { originalGoal: "Existing conversation", nodes: [{ name: "worker", task: "Task" }], edges: [] },
    nodes: { worker: { status: "completed", revision: 1, instruction: "", error: null } },
    plan: { executionBatches: [["worker"]], roots: ["worker"], terminals: ["worker"], warnings: [] },
    events: [{ type: "created", sequence: 1, planning_id: "old-plan", timestamp: 1 }] };
  let releaseBootstrap;
  const bootstrapGate = new Promise(resolve => { releaseBootstrap = resolve; });
  let planRequests = 0;
  const { context, page, errors } = await newPage(async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (command === "bootstrap") {
      await bootstrapGate;
      return route.fulfill({ json: { result: { config, snapshot: empty, runs: [saved.runId],
        repositoryInfo: { path: config.repository, name: "Bootstrap gate", branch: "main", head: "", clean: true }, dataPath: "/mock" } } });
    }
    if (command === "plan_goal_stream") {
      planRequests += 1;
      return route.fulfill({ json: { result: {} } });
    }
    let result;
    switch (command) {
      case "snapshot": case "history": result = saved; break;
      case "snapshot_if_changed": result = { version: "fixed", snapshot: saved }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_planning_output": result = { planningId: body.planningId, role: "planner", content: "",
        startOffset: 0, nextOffset: 0, totalBytes: 0, complete: true, running: false }; break;
      default: result = {};
    }
    return route.fulfill({ json: { result } });
  });
  try {
    await page.addInitScript(({ config, saved }) => {
      localStorage.setItem("grapher_projects", JSON.stringify([{ id: config.repository, path: config.repository,
        name: "Bootstrap gate", branch: "main", clean: true, lastOpened: 1 }]));
      localStorage.setItem("grapher_config", JSON.stringify(config));
      localStorage.setItem("grapher_workspace_runs", JSON.stringify({ [config.repository]: [saved.runId] }));
      localStorage.setItem("grapher_run_labels", JSON.stringify({ [saved.runId]: "Existing conversation" }));
    }, { config, saved });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator('[data-run-id="fast"]').waitFor();
    await page.locator('[data-run-id="fast"]').click();
    const input = page.locator(".pane-bottom-chat textarea").first();
    await input.waitFor();
    await page.waitForFunction(() => !document.querySelector(".pane-bottom-chat textarea")?.disabled);
    await input.fill("KEEP_PLANNER_DRAFT");
    await input.press("Enter");
    await page.locator(".floating-error-banner").filter({ hasText: "Backend settings are still loading" }).waitFor();
    await page.waitForTimeout(100);
    assert.equal(await input.inputValue(), "KEEP_PLANNER_DRAFT", "a blocked Planner turn must keep the draft");
    assert.equal(planRequests, 0, "a blocked Planner turn must not reach the backend");
    assert.equal(await page.locator('.chat-bubble-user', { hasText: "KEEP_PLANNER_DRAFT" }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    releaseBootstrap();
    await context.close();
  }
});

test("actual App re-attaches a running revision plan without locking or stale route badges", { timeout: 45_000 }, async () => {
  const config = { repository: "/mock/recovered-revision", model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: true };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const summary = { planningId: "revision-plan", status: "running", goal: "Add a cleanup node", planType: "graph",
    runId: "recovered-run", repository: config.repository, createdAt: 2, worktree: "/mock/revision-workspace",
    roles: {}, totalPlanningDuration: 0, modelDuration: 0 };
  const saved = { ...empty, runId: "recovered-run", config, planType: "graph", phase: "running", approved: true,
    planningId: summary.planningId, planning: summary,
    graph: { originalGoal: "Original goal", nodes: [{ name: "worker", task: "Worker" }], edges: [] },
    nodes: { worker: { status: "completed", revision: 1, instruction: "", error: null } },
    events: [{ type: "created", sequence: 1, planning_id: "old-plan", timestamp: 1 }] };
  const { context, page, errors } = await newPage(route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [saved.runId], repositoryInfo: { path: config.repository, name: "Recovered", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = saved; break;
      case "snapshot_if_changed": result = { version: "recovered", snapshot: saved }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": case "get_planning": result = command === "get_planning" ? summary : [summary]; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      default: result = { planningId: summary.planningId, role: "planner", content: "", startOffset: 0, nextOffset: 0, totalBytes: 0, complete: false, running: true };
    }
    return route.fulfill({ json: { result } });
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="recovered-run"]').click();
    const input = page.locator(".pane-bottom-chat textarea");
    await input.waitFor();
    assert.equal(await input.isDisabled(), false, "recovering a plan must not lock the composer");
    await page.locator(".planner-result-cards.is-hidden").waitFor({ state: "attached" });
    assert.equal(await page.getByText("Evaluating task routing...").count(), 0,
      "a running revision must not render the initial auto-route badge");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("a live Planner turn keeps the node conversation the reader opened", { timeout: 45_000 }, async () => {
  // The Planner turn settles while the reader is inspecting a node. Settling it
  // updates the Planner transcript and graph, but it is not a view change: the
  // node the reader opened must stay mounted.
  const config = { repository: "/mock/live-node-view", model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: true };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const running = { ...empty, runId: "live-node-view-run", config, planType: "graph", phase: "running", approved: true, planningId: "old-plan",
    graph: { originalGoal: "Original goal", nodes: [{ name: "worker", task: "Worker" }], edges: [] },
    nodes: { worker: { status: "completed", revision: 1, instruction: "", error: null } },
    executions: [{ id: "worker-execution", node: "worker", status: "completed", revision: 1, attempt: 1,
      startedAt: 1, completedAt: 2, sessionId: "worker-session", worktree: "/mock/live-node-view-worker",
      before: "", after: "head", output: "", outputBytes: 0 }],
    events: [{ type: "created", sequence: 1, planning_id: "old-plan", timestamp: 1 }] };
  const completed = { ...running, planningId: "new-plan",
    events: [...running.events, { type: "graph_revised", sequence: 2, planning_id: "new-plan", timestamp: 2,
      planning: { planningId: "new-plan", status: "success", createdAt: 2 } }] };
  let streamed = null;
  onPlanStream = (_body, res) => {
    streamed = res;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: run_started\ndata: ${JSON.stringify({ runId: running.runId })}\n\n`);
  };
  const { context, page, errors } = await newPage(route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (command === "plan_goal_stream") return route.continue();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [running.runId], repositoryInfo: { path: config.repository, name: "Live node view", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = running; break;
      case "snapshot_if_changed": result = { version: "live-node-view", snapshot: running }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_planning_output": {
        const content = assistant("Old planner turn");
        result = { planningId: body.planningId, role: "planner", content: body.offset ? "" : content,
          startOffset: body.offset ?? 0, nextOffset: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content), complete: true, running: false };
        break;
      }
      case "get_execution_output": result = { runId: body.runId, executionId: body.executionId, content: assistant("WORKER_REPLY"),
        startOffset: 0, nextOffset: 0, totalBytes: 0, complete: true, status: "completed" }; break;
      default: result = {};
    }
    return route.fulfill({ json: { result } });
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="live-node-view-run"]').click();
    const input = page.locator(".pane-bottom-chat textarea");
    await input.waitFor();
    await input.fill("REVISE WHILE READING NODE"); await input.press("Enter");
    for (let i = 0; !streamed && i < 100; i++) await page.waitForTimeout(20);
    assert.ok(streamed, "the Planner turn started");
    await page.locator('.react-flow__node[data-id="worker"]').click();
    const heading = page.locator(".conversation-heading h2");
    await heading.waitFor();
    assert.equal(await heading.textContent(), "worker");
    await page.waitForTimeout(2500);
    assert.equal(await heading.textContent(), "worker",
      "a running Planner stream must not close the node conversation");
    streamed.write(`event: planner\ndata: ${JSON.stringify({ event: { type: "message_start", message: { role: "assistant", content: [] } } })}\n\n`);
    streamed.write(`event: planner\ndata: ${JSON.stringify({ event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "REVISED ANSWER" }] } } })}\n\n`);
    streamed.write(`event: complete\ndata: ${JSON.stringify({ snapshot: completed })}\n\n`);
    streamed.end(); streamed = null;
    await page.waitForTimeout(800);
    assert.equal(await heading.textContent(), "worker",
      "a settled Planner turn must not unmount the node conversation the reader opened");
    assert.deepEqual(errors, []);
  } finally {
    onPlanStream = undefined; streamed?.destroy();
    await context.close();
  }
});

test("actual App reopening Planner history does not move cached follow-ups past newer replies", { timeout: 45_000 }, async () => {
  const config = { repository: "/mock/planner-order", model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const summary = (id, goal, createdAt) => ({ planningId: id, goal, createdAt, status: "success", roles: {},
    totalPlanningDuration: 0, modelDuration: 0, runId: "order-app", repository: config.repository });
  const first = summary("app-goal", "APP_ORDER_GOAL", Date.now() - 1000);
  let current = { ...empty, runId: "order-app", config, planType: "graph", phase: "awaiting_approval", planningId: first.planningId,
    planning: first, graph: { originalGoal: first.goal, nodes: [], edges: [] },
    events: [{ type: "created", sequence: 1, timestamp: first.createdAt, planning_id: first.planningId, planning: first }] };
  const other = { ...empty, runId: "other-order-app", config, planType: "graph", phase: "completed",
    graph: { originalGoal: "OTHER_ORDER_GOAL", nodes: [], edges: [] } };
  const user = text => line({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
  const outputs = { "app-goal": user(first.goal) + assistant("APP_GOAL_REPLY") };
  let turn = 0, holdPrevious = false, releasePrevious;
  onPlanStream = (body, res) => {
    const id = `app-turn-${++turn}`;
    const planning = summary(id, body.goal, Date.now());
    outputs[id] = user(body.goal) + (turn === 3
      ? Array.from({ length: 80 }, (_, i) => assistant(`APP_LAST_REPLY_${i}`)).join("") : assistant(`APP_REPLY_${turn}`));
    current = { ...current, planningId: id, planning,
      events: [...current.events, { type: "graph_revised", sequence: turn + 1, timestamp: planning.createdAt, planning_id: id, planning }] };
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.end(`event: run_started\ndata: ${JSON.stringify({ runId: current.runId })}\n\nevent: complete\ndata: ${JSON.stringify({ snapshot: current })}\n\n`);
  };
  const { context, page, errors } = await newPage(async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (command === "plan_goal_stream") return route.continue();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [current.runId, other.runId],
        repositoryInfo: { path: config.repository, name: "Planner order", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = body.runId === other.runId ? other : current; break;
      case "snapshot_if_changed": result = { version: String(turn), snapshot: null }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_planning_output": {
        if (holdPrevious && body.planningId === "app-turn-2") await new Promise(resolve => { releasePrevious = resolve; });
        const bytes = Buffer.from(outputs[body.planningId] || ""), start = body.offset ?? 0;
        result = { planningId: body.planningId, role: "planner", content: bytes.subarray(start).toString(),
          startOffset: start, nextOffset: bytes.length, totalBytes: bytes.length, complete: true, running: false }; break;
      }
      default: result = {};
    }
    try { await route.fulfill({ json: { result } }); } catch {}
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="order-app"]').click();
    await page.getByText("APP_GOAL_REPLY", { exact: true }).waitFor();
    const composer = page.locator(".pane-bottom-chat textarea");
    for (const [index, text] of ["APP_FOLLOW_1", "APP_FOLLOW_2", "APP_FOLLOW_3"].entries()) {
      await composer.fill(text); await composer.press("Enter");
      await page.waitForFunction(expected => document.querySelector(".pane-bottom-chat textarea")?.value === "", undefined);
      await page.getByText(index === 2 ? "APP_LAST_REPLY_79" : `APP_REPLY_${index + 1}`, { exact: true }).waitFor();
      await page.waitForTimeout(150);
    }
    holdPrevious = true;
    await page.locator('[data-run-id="other-order-app"]').click();
    await page.getByText("OTHER_ORDER_GOAL", { exact: true }).first().waitFor();
    await page.locator('[data-run-id="order-app"]').click();
    await page.getByText("APP_LAST_REPLY_79", { exact: true }).waitFor();
    for (let i = 0; i < 100 && !releasePrevious; i++) await page.waitForTimeout(20);
    assert.ok(releasePrevious, "the older revision is still in flight after reopening");
    assert.equal(await page.getByText("APP_FOLLOW_1", { exact: true }).count(), 0);
    assert.equal(await page.getByText("APP_FOLLOW_2", { exact: true }).count(), 0,
      "an older cached prompt cannot appear after the latest Planner reply");
    releasePrevious(); releasePrevious = undefined;
    const scroll = page.locator(".initial-query-scroll");
    await scroll.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })); });
    await page.getByText("APP_FOLLOW_2", { exact: true }).waitFor();
    const text = await page.locator(".planning-activity-output").innerText();
    assert.ok(text.indexOf("APP_FOLLOW_2") < text.indexOf("APP_REPLY_2"));
    assert.deepEqual(errors, []);
  } finally { onPlanStream = undefined; releasePrevious?.(); await context.close(); }
});

test("actual App renders a Planner goal once even when the saved replay contains it", { timeout: 45_000 }, async () => {
  // A conversation stopped before any follow-up still has its goal in the
  // durable planner.jsonl. The saved replay must skip that turn (it is already
  // the conversation header) instead of rendering a second identical bubble.
  const config = { repository: "/mock/goal-dup", model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: true };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const saved = { ...empty, runId: "goal-dup-run", config, planType: "graph", phase: "awaiting_approval", planningId: "goal-plan",
    graph: { originalGoal: "Only goal", nodes: [], edges: [] },
    events: [{ type: "created", sequence: 1, planning_id: "goal-plan", timestamp: 1 }] };
  const output = line({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "Only goal" }] } })
    + line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Only goal" }] } })
    + assistant("Only answer");
  const { context, page, errors } = await newPage(route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [saved.runId], repositoryInfo: { path: config.repository, name: "Goal dup", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = saved; break;
      case "snapshot_if_changed": result = { version: "fixed", snapshot: null }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_planning_output": { const bytes = Buffer.byteLength(output); result = { planningId: body.planningId, role: "planner", content: body.offset ? "" : output,
        startOffset: body.offset ?? 0, nextOffset: bytes, totalBytes: bytes, complete: true, running: false }; break; }
      default: result = {};
    }
    return route.fulfill({ json: { result } });
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="goal-dup-run"]').click();
    await page.getByText("Only answer", { exact: true }).first().waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.chat-bubble-user', { hasText: "Only goal" }).count(), 1,
      "the goal renders once as the conversation header, not again in the saved replay");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("actual App reopens a provisional conversation before the Planner assigns a Run ID", { timeout: 45_000 }, async () => {
  const config = { repository: "/mock/provisional", model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const other = { ...empty, runId: "other-run", config, planType: "serial", phase: "completed", approved: true,
    graph: { originalGoal: "Other", nodes: [{ name: "task", task: "Other" }], edges: [] },
    nodes: { task: { status: "completed", revision: 1, instruction: "", error: null } },
    executions: [{ id: "other-exec", node: "task", status: "completed", revision: 1, attempt: 1, startedAt: 1, completedAt: 2, sessionId: "s", worktree: "/mock", before: "", after: "", output: "" }] };
  onPlanStream = (_body, res) => {
    // The backend is still starting the Planner, so no run_started arrives yet.
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  };
  const { context, page, errors } = await newPage(async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (command === "plan_goal_stream") return route.continue();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [other.runId], repositoryInfo: { path: config.repository, name: "Provisional", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = other; break;
      case "snapshot_if_changed": result = { version: "fixed", snapshot: other }; break;
      case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_execution_output": result = { runId: body.runId, executionId: body.executionId, content: "", startOffset: 0, nextOffset: 0, totalBytes: 0, complete: true, status: "completed" }; break;
      default: result = {};
    }
    return route.fulfill({ json: { result } });
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    const input = page.locator(".landing-screen textarea");
    await input.fill("PROVISIONAL GOAL"); await input.press("Enter");
    await page.waitForFunction(() => !!document.querySelector('[data-run-id^="pending-"]'));
    // Switch away while the Planner is still starting.
    await page.locator('[data-run-id="other-run"]').click();
    await page.getByText("Other", { exact: true }).first().waitFor();
    // Returning must reopen the provisional conversation, not ignore the click.
    await page.locator('[data-run-id^="pending-"]').first().click();
    await page.locator('.chat-bubble-user', { hasText: "PROVISIONAL GOAL" }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    onPlanStream = undefined;
    await context.close();
  }
});

test("actual App: first Serial message keeps the footer still through approval and execution startup", { timeout: 30_000 }, async () => {
  const config = { repository: "/mock/first-serial", model: "test/model", thinkingLevel: "off", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const task = "First Serial task";
  const draft = { ...empty, runId: "first-serial", config, planType: "serial", phase: "awaiting_approval",
    graph: { originalGoal: task, nodes: [{ name: "task", task }], edges: [] },
    nodes: { task: { status: "waiting", revision: 0, instruction: "", error: null } },
    plan: { executionBatches: [["task"]], roots: ["task"], terminals: ["task"], warnings: [] } };
  // Approval changes the phase, but the Runtime leaves the node waiting until
  // its background driver starts preparing the first execution.
  const approved = { ...draft, approved: true, phase: "running" };
  const header = line({ type: "grapher_process_started", pid: 123 });
  const running = { ...approved, nodes: { task: { ...draft.nodes.task, status: "running" } },
    executions: [{ id: "first-execution", node: "task", status: "running", output: "", outputBytes: Buffer.byteLength(header),
      revision: 0, attempt: 1, startedAt: 1, completedAt: null, sessionId: "first-session", worktree: config.repository, before: "", after: null }] };
  let snapshot = empty, response, approveReceived = false, releaseApproval;
  const approval = new Promise(resolve => { releaseApproval = resolve; });
  onPlanStream = (body, res) => {
    assert.equal(body.mode, "serial");
    response = streamResponse = res;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": pending\n\n");
  };
  const { context, page, errors } = await newPage(async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (command === "plan_goal_stream") return route.continue();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [], repositoryInfo: { path: config.repository, name: "First Serial", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = snapshot; break;
      case "snapshot_if_changed": result = { version: snapshot.phase + snapshot.executions.length, snapshot: snapshot.runId ? snapshot : null }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "control":
        assert.equal(body.action, "approve");
        approveReceived = true;
        await approval;
        snapshot = result = approved;
        break;
      case "get_execution_output": result = { runId: body.runId, executionId: body.executionId, content: body.offset ? "" : header,
        startOffset: body.offset ?? 0, nextOffset: Buffer.byteLength(header), totalBytes: Buffer.byteLength(header), complete: true, status: "running" }; break;
      default: throw new Error(`Unexpected API ${command}`);
    }
    try { await route.fulfill({ json: { result } }); } catch {}
  });
  try {
    await context.addInitScript(config => {
      localStorage.setItem("grapher_plan_mode", "serial");
      localStorage.setItem("grapher_projects", JSON.stringify([{ id: config.repository, path: config.repository, name: "First Serial", lastOpened: 1 }]));
    }, config);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      window.footerFrames = [];
      window.sampleFooter = true;
      const sample = () => {
        const button = document.querySelector(".workspace-details-trigger");
        const working = document.querySelector(".workspace-details .working-indicator");
        const stream = document.querySelector(".chat-messages-stream");
        const wrapper = document.querySelector(".workspace-view-wrapper");
        if (button && stream && Number(getComputedStyle(stream).opacity) > 0.01 && Number(getComputedStyle(wrapper).opacity) > 0.01) {
          const pane = button.closest(".initial-query-scroll"), composer = pane.parentElement.querySelector(".pane-bottom-chat");
          window.footerFrames.push({ button: button.getBoundingClientRect().top, working: working?.getBoundingClientRect().top,
            stream: stream.getBoundingClientRect().top, scroll: pane.scrollTop, composer: composer.getBoundingClientRect().height,
            composerLayout: composer.offsetHeight, history: !!document.querySelector("[data-execution-id]"),
            userHeight: document.querySelector(".chat-message-row.user")?.getBoundingClientRect().height });
        }
        if (window.sampleFooter) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const input = page.locator(".landing-screen textarea");
    await input.fill(task); await input.press("Enter");
    await page.waitForFunction(() => window.footerFrames.length >= 8);
    for (let i = 0; !response && i < 100; i++) await page.waitForTimeout(20);
    assert.ok(response, "Serial planning request started");
    response.write(`event: run_started\ndata: ${JSON.stringify({ runId: draft.runId })}\n\n`);
    await page.waitForTimeout(80);
    snapshot = draft;
    response.end(`event: complete\ndata: ${JSON.stringify({ snapshot: draft })}\n\n`);
    for (let i = 0; !approveReceived && i < 100; i++) await page.waitForTimeout(20);
    assert.ok(approveReceived, "Serial automatically requests approval");
    await page.waitForTimeout(100);
    releaseApproval();
    await page.waitForTimeout(150);
    snapshot = running;
    // A running transcript with only a process header has no renderable rows,
    // so its collapsed status line leaves it at zero height. Startup is the
    // attachment, not a visible row.
    await page.locator('[data-execution-id="first-execution"]').waitFor({ state: "attached" });
    await page.waitForFunction(() =>
      Number(getComputedStyle(document.querySelector(".chat-messages-stream")).opacity) > 0.99,
    null, { message: "starting the first execution must not leave the conversation hidden" });
    await page.waitForTimeout(200);
    const frames = await page.evaluate(() => { window.sampleFooter = false; return window.footerFrames; });
    const first = frames[0];
    const changes = frames.filter((frame, i) => !i || frame.button !== frames[i - 1].button ||
      frame.working !== frames[i - 1].working || frame.history !== frames[i - 1].history);
    assert.ok(frames.every(frame => Math.abs(frame.button - first.button) <= 1 && Math.abs(frame.working - first.working) <= 1),
      `first Serial footer shifted: ${JSON.stringify(changes)}`);
    assert.deepEqual(errors, []);
  } finally {
    releaseApproval(); onPlanStream = undefined; response?.destroy(); streamResponse = undefined; await context.close();
  }
});

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

for (const running of [true, false]) {
  test(`Planner ${running ? "live" : "settling"} history recovers tools and thinking after a terminal read without a push`, { timeout: 20_000 }, async () => {
    let data = assistant("POLL_INITIAL");
    const reads = [];
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON();
      const command = new URL(route.request().url()).pathname.slice(5);
      if (command !== "get_planning_output") return route.fulfill({ json: { result: {} } });
      reads.push(body.offset);
      const bytes = Buffer.from(data), start = body.offset ?? 0;
      // A concurrently replaced summary can briefly be unreadable, so the page
      // reports terminal even though the displayed Planner is still running.
      return route.fulfill({ json: { result: { planningId: body.planningId, role: "planner",
        content: bytes.subarray(start).toString(), startOffset: start, nextOffset: bytes.length,
        totalBytes: bytes.length, complete: true, running: false } } });
    });
    try {
      await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.selectHistory);
      await page.evaluate(running => { window.audit.setRunning(running); window.audit.setPlanningIds(["planner-latest"]); window.audit.selectHistory("planner"); }, running);
      await page.getByText("POLL_INITIAL", { exact: true }).waitFor();
      data += line({ type: "message_start", message: { role: "assistant", content: [] } }) +
        line({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "LATE_PLANNER_THINKING" } }) +
        startTool("late-planner-tool", "echo LATE_PLANNER_TOOL");
      await page.locator('[data-transcript-id="late-planner-tool"]').waitFor({ timeout: 4000 });
      await page.locator(".thinking-card").waitFor({ timeout: 4000 });
      assert.ok(reads.some(offset => offset === Buffer.byteLength(assistant("POLL_INITIAL"))), "resume at the retained cursor without re-entering");
      if (!running) {
        await page.waitForTimeout(1600);
        const count = reads.length;
        await page.waitForTimeout(1500);
        assert.equal(reads.length, count, "a stable terminal transcript must stop timer polling");
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
  test(`${role}: upward gesture during initial history fill preserves the visible row`, { timeout: 30_000 }, async () => {
    const prefix = Array.from({ length: 50 }, (_, i) => assistant(`PREFIX_FILL_${i}`)).join("");
    const tail = Array.from({ length: 4 }, (_, i) => assistant(`TAIL_FILL_${i}`)).join("");
    const data = Buffer.from(prefix + tail), split = Buffer.byteLength(prefix);
    let releaseOlder;
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON();
      const command = new URL(route.request().url()).pathname.slice(5);
      if (command !== (role === "node" ? "get_execution_output" : "get_planning_output") ||
          (role === "planner" && body.planningId !== "planner-latest")) return route.fulfill({ json: { result: {} } });
      const end = body.before ?? data.length;
      const start = body.tail ? (body.before === undefined ? split : 0) : body.offset;
      if (body.before !== undefined) await new Promise(resolve => { releaseOlder = resolve; });
      try { await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        planningId: body.planningId, role: "planner", content: data.subarray(start, end).toString(), startOffset: start,
        nextOffset: end, totalBytes: data.length, complete: end === data.length, status: "running", running: true } } }); } catch {}
    });
    try {
      await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.selectHistory);
      if (role === "planner") await page.evaluate(() => {
        window.audit.setPlanningIds(["planner-latest"]);
        window.audit.selectHistory("planner");
      });
      const cache = () => page.evaluate(role => role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning(), role);
      await page.waitForFunction(role => !!(role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning()), role);
      for (let i = 0; i < 100 && !releaseOlder; i++) await page.waitForTimeout(10);
      assert.ok(releaseOlder, "the short tail automatically requests older history");
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".initial-query-scroll")).opacity) > 0.99);
      const scroller = page.locator("[data-shared-scroll]");
      // Scroll away from the bottom while the automatic request is still in
      // flight. Its page then commits without the caller asking to preserve the
      // reader, so the commit itself must remember that the gesture took over.
      await scroller.hover(); await page.mouse.wheel(0, -80);
      await page.waitForTimeout(100);
      const anchor = await scroller.evaluate(element => {
        // Track the last rendered row: the page commits below and above it, and
        // a short fixture tail must not depend on an exactly full row landing in
        // the viewport for this measurement to exist.
        const row = [...element.querySelectorAll("[data-transcript-id]")].at(-1);
        return row ? { id: row.dataset.transcriptId, top: row.getBoundingClientRect().top } : null;
      });
      assert.ok(anchor, "the reader has a retained row while the page is in flight");
      releaseOlder();
      await page.waitForFunction(role => (role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning())?.startOffset === 0, role);
      await page.waitForTimeout(200);
      assert.equal((await cache()).startOffset, 0);
      const nextTop = await page.evaluate(({ id }) => {
        const row = [...document.querySelectorAll("[data-transcript-id]")].find(candidate => candidate.dataset.transcriptId === id);
        return row?.getBoundingClientRect().top ?? null;
      }, anchor);
      assert.ok(nextTop !== null, "the retained row is still mounted");
      assert.ok(Math.abs(nextTop - anchor.top) <= 3, `initial fill dragged the reading anchor ${nextTop - anchor.top}px`);
      assert.deepEqual(errors, []);
    } finally { releaseOlder?.(); await context.close(); }
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
        return { position: style.position,
          separated: !transcript || element.getBoundingClientRect().bottom <= transcript.getBoundingClientRect().top + 1 };
      });
      assert.equal(appearance.position, "static");
      assert.ok(appearance.separated, "gray loading text owns a line; it never overlays a message");
      // The user keeps moving while the network is delayed. The anchor must be
      // captured at commit, not at request start.
      await scroller.hover(); await page.mouse.wheel(0, -70);
      data += assistant("LIVE_DURING_PREPEND");
      await page.waitForFunction(role => (role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning())?.text.includes("LIVE_DURING_PREPEND"), role);
      await page.waitForTimeout(100);
      const anchor = await scroller.evaluate(element => {
        const top = element.getBoundingClientRect().top;
        // The page below the preceding Planner turn lands above the newest
        // rows, so track a row under that insertion instead of the older
        // section that stays above it.
        const row = [...element.querySelectorAll("[data-transcript-id]")].filter(row => {
          const rect = row.getBoundingClientRect();
          return rect.top >= top && rect.bottom <= top + element.clientHeight;
        }).at(-1);
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
  test(`${role}: a fast fling cannot expose content before an unloaded page`, { timeout: 30_000 }, async () => {
    const prefix = Array.from({ length: 40 }, (_, i) => assistant(`FLING_OLDER_${i}`)).join("");
    const tail = Array.from({ length: 60 }, (_, i) => assistant(`FLING_TAIL_${i}`)).join("");
    const data = Buffer.from(prefix + tail), split = Buffer.byteLength(prefix);
    let releaseOlder;
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON();
      if (body.before !== undefined) await new Promise(resolve => { releaseOlder = resolve; });
      const start = body.before !== undefined ? 0 : body.tail ? split : body.offset ?? 0;
      const end = body.before ?? data.length;
      try { await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        planningId: body.planningId, role: "planner", content: data.subarray(start, end).toString(),
        startOffset: start, nextOffset: end, totalBytes: data.length, complete: end === data.length,
        status: "running", running: true } } }); } catch {}
    });
    try {
      await page.goto(`${origin}/__history?case=historyRegression&heading=1200`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.selectHistory);
      await page.evaluate(role => {
        if (role === "planner") window.audit.setPlanningIds(["planner-latest"]);
        window.audit.selectHistory(role);
      }, role);
      await page.waitForFunction(role => !!(role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning()), role);
      await page.waitForFunction(() => document.querySelector('[data-shared-scroll]')?.scrollHeight > 2000);
      await page.waitForFunction(role => document.querySelector(role === "node" ? "[data-execution-id]" : ".planning-activity")?.getAttribute("aria-busy") === "false", role);
      const scroller = page.locator("[data-shared-scroll]");
      await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await page.waitForTimeout(100);
      await scroller.hover();
      await page.mouse.wheel(0, -100000);
      for (let i = 0; i < 100 && !releaseOlder; i++) await page.waitForTimeout(10);
      assert.ok(releaseOlder, "the fling requests the missing page");
      await page.waitForTimeout(100);
      const boundary = await scroller.evaluate((element, role) => {
        const start = role === "planner" ? element.querySelector('[data-transcript-source-start="planner-latest"]')
          : element.querySelector('.virtualized-transcript-container');
        return start.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientTop;
      }, role);
      assert.ok(boundary <= 2, `unloaded history exposed ${boundary}px of earlier content`);
      releaseOlder(); releaseOlder = undefined;
      await page.waitForFunction(role => (role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning())?.startOffset === 0, role);
      await scroller.evaluate(element => { element.scrollTop = 0; });
      await page.waitForTimeout(100);
      assert.equal(await scroller.evaluate(element => element.scrollTop), 0, "the real beginning remains reachable after loading");
      assert.deepEqual(errors, []);
    } finally { releaseOlder?.(); await context.close(); }
  });
}

for (const role of ["node", "planner"]) {
  test(`${role}: an older page lands at the beginning of the loaded history`, { timeout: 30_000 }, async () => {
    // Older bytes are inserted above the reader, so the virtualizer has to
    // compensate the scroll position. That compensation belongs at the point the
    // reader scrolled to: extending the history below them must never move the
    // rows they are reading.
    const rows = [...Array.from({ length: 80 }, (_, i) => assistant(`BOUNDARY_OLDER_${i}`)),
      ...Array.from({ length: 4 }, (_, i) => assistant(`BOUNDARY_VISIBLE_${i}`))];
    const offsets = [0];
    for (const row of rows) offsets.push(offsets.at(-1) + Buffer.byteLength(row));
    // Start with more than two viewports so initial auto-fill has finished
    // before this test asks for a separate user-driven page.
    const data = Buffer.from(rows.join("")), tailStart = offsets[50], pageRows = 8;
    const pending = [];
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON();
      const command = new URL(route.request().url()).pathname.slice(5);
      if (command !== (role === "node" ? "get_execution_output" : "get_planning_output") ||
          (role === "planner" && body.planningId !== "planner-latest")) return route.fulfill({ json: { result: {} } });
      let start, end;
      if (body.before !== undefined) {
        end = body.before;
        start = offsets[Math.max(0, offsets.indexOf(end) - pageRows)];
        await new Promise(resolve => { pending.push(resolve); });
      } else if (body.tail) {
        start = tailStart; end = data.length;
      } else {
        start = Math.min(body.offset ?? 0, data.length); end = data.length;
      }
      try { await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        planningId: body.planningId, role: "planner", content: data.subarray(start, end).toString(), startOffset: start,
        nextOffset: end, totalBytes: data.length, complete: end === data.length, status: "running", running: true } } }); } catch {}
    });
    try {
      await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.selectHistory);
      await page.evaluate(role => {
        if (role === "planner") window.audit.setPlanningIds(["planner-latest"]);
        window.audit.selectHistory(role);
      }, role);
      await page.waitForFunction(role => !!(role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning()), role);
      const scroller = page.locator("[data-shared-scroll]");
      const cache = () => page.evaluate(role => role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning(), role);
      const busySelector = role === "node" ? "[data-execution-id]" : ".planning-activity";
      await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute("aria-busy") === "false", busySelector);
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".initial-query-scroll")).opacity) > 0.99);
      assert.equal(pending.length, 0, "the initial tail already fills the viewport");
      const filled = await cache();
      assert.ok(filled.startOffset > 0, "the fixture keeps older bytes for an on-demand page");
      // Put the reader inside the loaded history, one viewport below its start.
      await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await page.waitForTimeout(60);
      const listStart = await scroller.evaluate(element => {
        const list = element.querySelector(".virtualized-transcript-container");
        return element.scrollTop + list.getBoundingClientRect().top - element.getBoundingClientRect().top;
      });
      await scroller.evaluate((element, top) => {
        element.scrollTop = top;
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -60, bubbles: true }));
      }, listStart + 200);
      for (let i = 0; i < 100 && !pending.length; i++) await page.waitForTimeout(10);
      assert.ok(pending.length, "scrolling inside the loaded history requests the next older page");
      // The page is ready while the reader is still below its insertion point.
      pending.shift()();
      await page.waitForTimeout(300);
      assert.equal((await cache()).startOffset, filled.startOffset,
        "a page fetched above the reader must not take part in the layout yet");
      // Reaching the beginning of the loaded history is where the page belongs.
      await scroller.evaluate(element => { element.scrollTop = 0; });
      await page.waitForFunction(({ role, before }) => {
        const current = role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning();
        return current && current.startOffset < before;
      }, { role, before: filled.startOffset }, { timeout: 5000 });
      assert.deepEqual(errors, []);
    } finally { pending.splice(0).forEach(release => release()); await context.close(); }
  });
}

test("planner: a prefetched page waits for its revision boundary even when the first rows are tools", { timeout: 30_000 }, async () => {
  const previous = Buffer.from(Array.from({ length: 5 }, (_, i) => assistant(`BOUNDARY_PREVIOUS_${i}`)).join(""));
  const prefix = Array.from({ length: 20 }, (_, i) => assistant(`BOUNDARY_MISSING_${i}`)).join("");
  const tail = Array.from({ length: 8 }, (_, i) => startTool(`boundary-tool-${i}`, `command ${i}`) + endTool(`boundary-tool-${i}`, "done")).join("") +
    Array.from({ length: 40 }, (_, i) => assistant(`BOUNDARY_TEXT_${i}`)).join("");
  const latest = Buffer.from(prefix + tail), split = Buffer.byteLength(prefix);
  let releaseOlder;
  const { context, page, errors } = await newPage(async route => {
    const body = route.request().postDataJSON();
    const command = new URL(route.request().url()).pathname.slice(5);
    if (command !== "get_planning_output") return route.fulfill({ json: { result: {} } });
    const bytes = body.planningId === "planner-latest" ? latest : previous;
    const end = body.before ?? bytes.length;
    const start = body.before !== undefined ? 0 : body.tail && bytes === latest ? split : body.offset;
    if (body.before !== undefined) await new Promise(resolve => { releaseOlder = resolve; });
    try { await route.fulfill({ json: { result: { planningId: body.planningId, role: "planner", running: false,
      content: bytes.subarray(start, end).toString(), startOffset: start, nextOffset: end,
      totalBytes: bytes.length, complete: end === bytes.length } } }); } catch {}
  });
  try {
    await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.selectHistory);
    await page.evaluate(() => { window.audit.setRunning(false); window.audit.selectHistory("planner"); });
    await page.waitForFunction(() => window.audit.planningCacheKeys().includes("regression:planner-previous"));
    await page.waitForFunction(() => document.querySelector(".planning-activity")?.getAttribute("aria-busy") === "false");
    const scroller = page.locator("[data-shared-scroll]");
    assert.equal(await page.locator('[data-transcript-id="boundary-tool-0"]').count(), 0,
      "the revision boundary must exist even when its first row is virtualized out");
    await scroller.evaluate(element => {
      const boundary = element.querySelector('[data-transcript-source-start="planner-latest"]');
      element.scrollTop += boundary.getBoundingClientRect().top - element.getBoundingClientRect().top + 100;
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -60, bubbles: true }));
    });
    await page.locator('[data-transcript-id="boundary-tool-0"]').waitFor({ state: "attached" });
    const boundaryDelta = await scroller.evaluate(element => element.querySelector('[data-transcript-source-start="planner-latest"]').getBoundingClientRect().top -
      element.querySelector('[data-transcript-id="boundary-tool-0"]').getBoundingClientRect().top);
    assert.ok(Math.abs(boundaryDelta) <= 2, `virtualized boundary differs from its first row by ${boundaryDelta}px`);
    for (let i = 0; i < 100 && !releaseOlder; i++) await page.waitForTimeout(20);
    assert.ok(releaseOlder, "scrolling near the revision starts a prefetch");
    const before = await page.evaluate(() => window.audit.cachedPlanning().startOffset);
    releaseOlder(); releaseOlder = undefined;
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.audit.cachedPlanning().startOffset), before,
      "a later text row is not the insertion boundary when tool rows precede it");
    await scroller.evaluate(element => {
      const firstTool = element.querySelector('[data-transcript-id="boundary-tool-0"]');
      element.scrollTop += firstTool.getBoundingClientRect().top - element.getBoundingClientRect().top - 1;
    });
    await page.waitForFunction(() => window.audit.cachedPlanning().startOffset === 0);
    assert.deepEqual(errors, []);
  } finally { releaseOlder?.(); await context.close(); }
});

test("a held prefetch does not keep initial history readiness busy", { timeout: 20_000 }, async () => {
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }));
  try {
    await page.goto(`${origin}/__history?case=heldHistory`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("[data-held-ready]")?.dataset.heldReady === "true");
    assert.equal(await page.locator("[data-held-ready]").getAttribute("data-held-loads"), "0",
      "do not repeatedly request a page that is already held");
    await page.evaluate(() => window.audit.releaseHeldHistory());
    await page.waitForFunction(() => Number(document.querySelector("[data-held-loads]")?.dataset.heldLoads) > 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("planner: slow background revision preloading does not display a paging notice", { timeout: 30_000 }, async () => {
  const latest = Buffer.from(Array.from({ length: 60 }, (_, i) => assistant(`SILENT_LATEST_${i}`)).join(""));
  const previous = Buffer.from(assistant("SILENT_PREVIOUS"));
  let releasePrevious;
  const { context, page, errors } = await newPage(async route => {
    const body = route.request().postDataJSON();
    if (!route.request().url().endsWith("/get_planning_output")) return route.fulfill({ json: { result: {} } });
    const bytes = body.planningId === "planner-previous" ? previous : latest;
    if (body.planningId === "planner-previous") await new Promise(resolve => { releasePrevious = resolve; });
    const start = body.offset ?? 0;
    try { await route.fulfill({ json: { result: { planningId: body.planningId, role: "planner", running: false,
      content: bytes.subarray(start).toString(), startOffset: start, nextOffset: bytes.length,
      totalBytes: bytes.length, complete: true } } }); } catch {}
  });
  try {
    await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.selectHistory);
    await page.evaluate(() => { window.audit.setRunning(false); window.audit.selectHistory("planner"); });
    await page.getByText("SILENT_LATEST_59", { exact: true }).waitFor();
    for (let i = 0; i < 100 && !releasePrevious; i++) await page.waitForTimeout(20);
    assert.ok(releasePrevious, "the preceding revision is being preloaded");
    await page.waitForTimeout(450);
    assert.equal(await page.locator(".transcript-history-status").innerText(), "",
      "background reads should not suggest that the reader must wait");
    await page.locator("[data-shared-scroll]").evaluate(element => {
      element.scrollTop = 0;
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
    });
    await page.locator(".transcript-history-status").filter({ hasText: "Loading earlier records" }).waitFor();
    releasePrevious(); releasePrevious = undefined;
    await page.waitForFunction(() => window.audit.planningCacheKeys().includes("regression:planner-previous"));
    assert.deepEqual(errors, []);
  } finally { releasePrevious?.(); await context.close(); }
});

test("planner: retry repeats a failed background preload that the reader requested", { timeout: 30_000 }, async () => {
  const latest = Buffer.from(Array.from({ length: 60 }, (_, i) => assistant(`PRELOAD_RETRY_LATEST_${i}`)).join(""));
  const previous = Buffer.from(assistant("PRELOAD_RETRY_PREVIOUS"));
  let releasePrevious, previousReads = 0;
  const { context, page, errors } = await newPage(async route => {
    const body = route.request().postDataJSON();
    if (!route.request().url().endsWith("/get_planning_output")) return route.fulfill({ json: { result: {} } });
    const isPrevious = body.planningId === "planner-previous", bytes = isPrevious ? previous : latest;
    if (isPrevious && ++previousReads === 1) await new Promise(resolve => { releasePrevious = resolve; });
    const start = body.offset ?? 0;
    const content = bytes.subarray(start).toString();
    try { await route.fulfill({ json: { result: { planningId: body.planningId, role: "planner", running: false,
      content: isPrevious && previousReads === 1 ? content.slice(1) : content, startOffset: start,
      nextOffset: bytes.length, totalBytes: bytes.length, complete: true } } }); } catch {}
  });
  try {
    await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.selectHistory);
    await page.evaluate(() => { window.audit.setRunning(false); window.audit.selectHistory("planner"); });
    await page.getByText("PRELOAD_RETRY_LATEST_59", { exact: true }).waitFor();
    for (let i = 0; i < 100 && !releasePrevious; i++) await page.waitForTimeout(20);
    assert.ok(releasePrevious);
    await page.locator("[data-shared-scroll]").evaluate(element => {
      element.scrollTop = 0;
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
    });
    await page.locator(".transcript-history-status").filter({ hasText: "Loading earlier records" }).waitFor();
    releasePrevious(); releasePrevious = undefined;
    await page.getByRole("alert").waitFor();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    for (let i = 0; i < 100 && previousReads < 2; i++) await page.waitForTimeout(20);
    assert.equal(previousReads, 2, "retry must issue the failed older read without another scroll gesture");
    await page.waitForFunction(() => window.audit.planningCacheKeys().includes("regression:planner-previous"));
    assert.deepEqual(errors, []);
  } finally { releasePrevious?.(); await context.close(); }
});

for (const role of ["node", "planner"]) {
  test(`${role}: retry still recovers an initial output read failure`, { timeout: 20_000 }, async () => {
    const content = assistant(`RETRY_INITIAL_${role}`), total = Buffer.byteLength(content);
    let reads = 0;
    const { context, page, errors } = await newPage(route => {
      const body = route.request().postDataJSON();
      if (++reads === 1) return route.fulfill({ status: 500, json: { error: "temporary failure" } });
      return route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        planningId: body.planningId, role: "planner", content, startOffset: 0, nextOffset: total,
        totalBytes: total, complete: true, status: "completed", running: false } } });
    });
    try {
      await page.goto(`${origin}/__history?case=${role === "node" ? `transcript&bytes=${total}` : "plannerTranscript"}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("alert").waitFor();
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.getByText(`RETRY_INITIAL_${role}`, { exact: true }).waitFor();
      assert.ok(reads >= 2);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  test(`${role}: an invalid prefetched page is reported and can be retried without scrolling to it`, { timeout: 30_000 }, async () => {
    const prefix = Array.from({ length: 20 }, (_, i) => assistant(`RETRY_OLDER_${i}`)).join("");
    const tail = Array.from({ length: 60 }, (_, i) => assistant(`RETRY_TAIL_${i}`)).join("");
    const data = Buffer.from(prefix + tail), split = Buffer.byteLength(prefix);
    let olderReads = 0;
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON();
      const command = new URL(route.request().url()).pathname.slice(5);
      if (command !== (role === "node" ? "get_execution_output" : "get_planning_output")) return route.fulfill({ json: { result: {} } });
      const end = body.before ?? data.length;
      const start = body.before !== undefined ? 0 : body.tail ? split : body.offset;
      const content = data.subarray(start, end).toString();
      if (body.before !== undefined) olderReads++;
      await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        planningId: body.planningId, role: "planner", running: false, status: "completed",
        content: body.before !== undefined && olderReads === 1 ? content.slice(1) : content,
        startOffset: start, nextOffset: end, totalBytes: data.length, complete: end === data.length } } });
    });
    try {
      await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.selectHistory);
      await page.evaluate(role => {
        window.audit.setRunning(false);
        if (role === "planner") { window.audit.setPlanningIds(["planner-latest"]); window.audit.selectHistory("planner"); }
      }, role);
      await page.waitForFunction(role => (role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning())?.startOffset > 0, role);
      await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute("aria-busy") === "false",
        role === "node" ? "[data-execution-id]" : ".planning-activity");
      const scroller = page.locator("[data-shared-scroll]");
      await scroller.evaluate(element => {
        const transcript = element.querySelector(".virtualized-transcript-container");
        element.scrollTop += transcript.getBoundingClientRect().top - element.getBoundingClientRect().top + 150;
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -60, bubbles: true }));
      });
      for (let i = 0; i < 100 && !olderReads; i++) await page.waitForTimeout(20);
      assert.equal(olderReads, 1, "approaching the boundary starts the older read");
      await page.getByRole("alert").waitFor({ timeout: 4000 });
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      for (let i = 0; i < 100 && olderReads < 2; i++) await page.waitForTimeout(20);
      assert.equal(olderReads, 2, "retry repeats the failed page without requiring another gesture");
      await scroller.evaluate(element => {
        element.scrollTop = 0;
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -60, bubbles: true }));
      });
      await page.waitForFunction(role => (role === "node" ? window.audit.cachedExecution() : window.audit.cachedPlanning())?.startOffset === 0, role);
      assert.ok(olderReads >= 2);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
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
      // Planner terminal EOF is briefly revalidated for a racing final flush;
      // distinguish those background cursor checks from a card-triggered read.
      await page.waitForTimeout(role === "planner" ? 1200 : 100);
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

for (const mode of ["node", "serial"]) {
  test(`${mode}: entering a running conversation keeps following its live reasoning`, { timeout: 40_000 }, async () => {
  // The tail window starts inside a long log, so earlier bytes exist and the
  // transcript offers a scroll-triggered older read. Only a handful of rows
  // render, so a pane resize clamps the scroller upwards while the view is
  // still pinned to the newest output. That clamp is layout motion, not the
  // reader asking for earlier history.
  const padding = count => Array.from({ length: count }, (_, index) =>
    line({ type: "grapher_context_usage", tokens: index, pad: "x".repeat(900) })).join("");
  let data = padding(1200) +
    Array.from({ length: 24 }, (_, index) => assistant(`VISIBLE_NODE_ROW_${index} ` + "word ".repeat(30))).join("") +
    padding(380) + assistant("LAST_NODE_ANSWER");
  const { context, page, errors } = await newPage(async route => {
    const body = route.request().postDataJSON();
    const command = new URL(route.request().url()).pathname.slice(5);
    if (command !== "get_execution_output") return route.fulfill({ json: { result: {} } });
    const bytes = Buffer.from(data), total = bytes.length;
    let start, end;
    if (body.before !== undefined) {
      end = body.before;
      start = Math.max(0, end - 512 * 1024);
      const newline = bytes.subarray(0, start).lastIndexOf(0x0a);
      if (newline >= 0) start = newline + 1;
    } else if (body.tail) {
      end = total;
      start = Math.max(0, total - 512 * 1024);
      const newline = bytes.subarray(0, start).lastIndexOf(0x0a);
      if (newline >= 0) start = newline + 1;
    } else {
      start = body.offset ?? 0;
      end = Math.min(total, start + 512 * 1024);
    }
    try { await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
      content: bytes.subarray(start, end).toString(), startOffset: start, nextOffset: end,
      totalBytes: total, complete: end === total, status: "running" } } }); } catch {}
  });
  try {
    await page.goto(`${origin}/__history?case=nodeEntry&mode=${mode}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.enterNode);
    await page.evaluate(bytes => window.audit.setOutputBytes(bytes), Buffer.byteLength(data));
    await page.evaluate(() => {
      window.entryFrames = [];
      window.sampleEntry = true;
      const sample = () => {
        const scroll = document.querySelector(".initial-query-scroll");
        if (scroll) window.entryFrames.push({
          bottom: Math.round(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight),
          follow: scroll.dataset.transcriptFollowing === "true",
          reading: scroll.dataset.transcriptHistoryReading === "true",
        });
        if (window.sampleEntry) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.evaluate(() => window.audit.enterNode());
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".chat-messages-stream")).opacity) > 0.99, null, { timeout: 8000 });
    // Growing the pane lowers the maximum scrollTop, so the browser clamps it
    // upwards without any reader gesture.
    await page.setViewportSize({ width: 1280, height: 920 });
    await page.waitForTimeout(250);
    // A live Pi turn keeps streaming while the reader watches; its reasoning
    // card must grow at the bottom, not behind the viewport.
    data += line({ type: "message_start", message: { role: "assistant", content: [] } });
    data += line({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
      delta: "reasoning step 0 " } });
    // Streaming deltas need not update the metadata snapshot. The mounted
    // reader must fetch and render them without a parent re-render or a visit
    // to another conversation.
    const card = page.locator(".thinking-card.streaming");
    await card.locator(".thinking-card-body", { hasText: "reasoning step 0" }).waitFor({ timeout: 5000 });
    for (let index = 1; index < 20; index++) {
      data += line({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
        delta: `reasoning step ${index} `.repeat(12) } });
      await page.waitForTimeout(50);
    }
    await card.locator(".thinking-card-body", { hasText: "reasoning step 19" }).waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
    const visibility = await card.evaluate(element => {
      const scroller = element.closest(".initial-query-scroll");
      const composer = scroller.closest(".initial-query-view").querySelector(".pane-bottom-chat");
      const body = element.querySelector(".thinking-card-body");
      const view = scroller.getBoundingClientRect(), bounds = body.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, visibleTop: view.top,
        visibleBottom: Math.min(view.bottom, composer.getBoundingClientRect().top),
        innerGap: body.scrollHeight - body.scrollTop - body.clientHeight };
    });
    assert.ok(visibility.bottom > visibility.visibleTop && visibility.top < visibility.visibleBottom,
      `the live reasoning card must actually be in view: ${JSON.stringify(visibility)}`);
    assert.ok(visibility.innerGap <= 2, `the card follows its latest reasoning: ${JSON.stringify(visibility)}`);
    const frames = await page.evaluate(() => { window.sampleEntry = false; return window.entryFrames; });
    assert.ok(frames.length > 10);
    assert.equal(frames.some(frame => frame.reading), false,
      `a layout clamp must not start reading history: ${JSON.stringify(frames.find(frame => frame.reading))}`);
    assert.ok(frames.slice(-5).every(frame => frame.follow), "the conversation keeps following the live turn");
    assert.ok(frames.slice(-5).every(frame => frame.bottom <= 2),
      `the live reasoning stays at the bottom: ${JSON.stringify(frames.at(-1))}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
  });
}

for (const [mode, gesture] of ["node", "serial"].flatMap(mode =>
  ["wheel", "keyboard", "touch"].map(gesture => [mode, gesture]))) {
  test(`${mode}: ${gesture} scrollback still loads older history while output streams`, { timeout: 30_000 }, async () => {
    const prefix = line({ type: "opaque", pad: "x".repeat(600_000) }) + assistant("OLDER_NODE_ENTRY");
    const tail = Array.from({ length: 80 }, (_, index) => assistant(`NODE_HISTORY_${index} ` + "detail ".repeat(20))).join("");
    let data = prefix + tail, releaseOlder, olderReads = 0, sawLiveOutput = false;
    const split = Buffer.byteLength(prefix);
    const { context, page, errors } = await newPage(async route => {
      const body = route.request().postDataJSON();
      if (!route.request().url().endsWith("/get_execution_output")) return route.fulfill({ json: { result: {} } });
      if (body.before !== undefined) {
        olderReads++;
        await new Promise(resolve => { releaseOlder = resolve; });
      }
      const bytes = Buffer.from(data), end = body.before ?? bytes.length;
      const start = body.before !== undefined ? 0 : body.tail ? split : body.offset;
      const content = bytes.subarray(start, end).toString();
      if (content.includes("LIVE_WHILE_READING")) sawLiveOutput = true;
      try { await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        content, startOffset: start, nextOffset: end, totalBytes: bytes.length,
        complete: end === bytes.length, status: "running" } } }); } catch {}
    });
    try {
      await page.goto(`${origin}/__history?case=nodeEntry&mode=${mode}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.audit?.enterNode);
      await page.evaluate(bytes => { window.audit.setOutputBytes(bytes); window.audit.enterNode(); }, Buffer.byteLength(data));
      const scroller = page.locator(".initial-query-scroll.conversation-ready");
      await scroller.waitFor();
      await page.waitForFunction(() => document.querySelector('[data-execution-id="worker-exec"]')?.getAttribute("aria-busy") === "false");
      assert.equal(olderReads, 0, "the initial tail already fills the viewport");
      assert.ok((await page.evaluate(() => window.audit.cachedNodeEntry())).startOffset > 0);
      if (gesture === "wheel") {
        await scroller.hover({ position: { x: 10, y: 10 } });
        await page.mouse.wheel(0, -100_000);
      } else if (gesture === "keyboard") {
        await scroller.evaluate(element => { element.tabIndex = 0; element.focus({ preventScroll: true }); });
        await page.keyboard.press("Home");
      } else {
        // Chromium's synthetic touch events do not perform the default scroll.
        await scroller.evaluate(element => {
          const touch = clientY => new Touch({ identifier: 9, target: element, clientY });
          element.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch(100)] }));
          element.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [touch(150)] }));
          element.scrollTop = 0;
          element.dispatchEvent(new Event("scroll"));
        });
      }
      for (let index = 0; index < 100 && !releaseOlder; index++) await page.waitForTimeout(20);
      assert.ok(releaseOlder, "a genuine upward gesture must request older bytes");
      assert.equal(await scroller.getAttribute("data-transcript-history-reading"), "true");
      data += assistant("LIVE_WHILE_READING");
      for (let index = 0; index < 150 && !sawLiveOutput; index++) await page.waitForTimeout(20);
      assert.ok(sawLiveOutput, "the live reader continues fetching while history is open");
      assert.equal(await scroller.getAttribute("data-transcript-following"), null,
        "new output must not pull a reader back to the bottom");
      releaseOlder(); releaseOlder = undefined;
      await page.waitForFunction(() => window.audit.cachedNodeEntry()?.startOffset === 0 &&
        window.audit.cachedNodeEntry().text.includes("LIVE_WHILE_READING"));
      assert.ok((await page.evaluate(() => window.audit.cachedNodeEntry().text)).includes("LIVE_WHILE_READING"),
        "prepending older bytes must not discard the concurrent live output");
      assert.deepEqual(errors, []);
    } finally { releaseOlder?.(); await context.close(); }
  });
}

test("planner: opening a reviewed run preloads the preceding planning turn", { timeout: 30_000 }, async () => {
  const earlier = Array.from({ length: 5 }, (_, i) => assistant(`EARLIER_PLAN_${i}`)).join("");
  const review = Array.from({ length: 100 }, (_, i) => assistant(`LATEST_REVIEW_${i} 中文🚀`)).join("");
  const earlierBytes = Buffer.from(earlier), reviewBytes = Buffer.from(review);
  const requests = [];
  const { context, page, errors } = await newPage(async route => {
    const body = route.request().postDataJSON();
    const command = new URL(route.request().url()).pathname.slice(5);
    if (command !== "get_planning_output") return route.fulfill({ json: { result: {} } });
    requests.push(body);
    const latest = body.planningId === "planner-latest";
    const bytes = latest ? reviewBytes : earlierBytes;
    const start = body.tail ? 0 : body.offset;
    const end = Math.min(bytes.length, start + (body.limit ?? 512 * 1024));
    return route.fulfill({ json: { result: { planningId: body.planningId, role: "planner", content: bytes.subarray(start, end).toString(),
      startOffset: start, nextOffset: end, totalBytes: bytes.length, complete: end === bytes.length, running: false } } });
  });
  try {
    await page.goto(`${origin}/__history?case=historyRegression`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit?.selectHistory);
    await page.evaluate(() => { window.audit.setPlanningIds(["planner-previous", "planner-latest"]); window.audit.selectHistory("planner"); });
    await page.getByText("LATEST_REVIEW_99 中文🚀", { exact: true }).waitFor();
    // The review itself fills the viewport, so the generic two-viewport fill
    // cannot discover the preceding revision. It must be seeded explicitly.
    await page.waitForFunction(() => window.audit.planningCacheKeys().includes("regression:planner-previous"));
    const scroller = page.locator("[data-shared-scroll]");
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await page.waitForTimeout(200);
    assert.equal(await page.getByText("EARLIER_PLAN_0", { exact: true }).count(), 1,
      "the preceding planning turn stays available in scrollback");
    assert.ok(requests.some(body => body.planningId === "planner-previous"),
      "opening the reviewed conversation seeds the preceding revision");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Planner restores the visible row after visiting a node in a virtualized history", { timeout: 30_000 }, async () => {
  const output = Array.from({ length: 140 }, (_, index) => assistant(`SCROLL_ROW_${index} ` +
    (index % 2 ? "A long wrapped paragraph with 中文 content. ".repeat(25) : "short"))).join("");
  const { context, page, errors } = await newPage(async route => {
    const body = route.request().postDataJSON();
    const bytes = Buffer.from(output), start = body.offset ?? 0;
    if (new URL(route.request().url()).pathname !== "/api/get_planning_output") return route.fulfill({ json: { result: {} } });
    return route.fulfill({ json: { result: { planningId: body.planningId, role: "planner", content: bytes.subarray(start).toString(),
      startOffset: start, nextOffset: bytes.length, totalBytes: bytes.length, complete: true, running: false } } });
  });
  try {
    await page.goto(`${origin}/__history?case=plannerScrollRestore`, { waitUntil: "domcontentloaded" });
    await page.getByText(/SCROLL_ROW_139/).waitFor();
    const scroll = page.locator(".initial-query-scroll");
    await scroll.hover();
    // Measure many variable-height rows above the eventual reading position.
    // On remount their initial estimates differ from those measurements.
    await scroll.evaluate(element => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
      element.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(40); }
    await page.waitForTimeout(200);
    const anchor = await scroll.evaluate(element => {
      const top = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll(".planning-activity [data-transcript-id]")].find(item => {
        const bounds = item.getBoundingClientRect();
        return bounds.bottom > top + 20 && bounds.top < top + element.clientHeight - 20;
      });
      return row && { id: row.dataset.transcriptId, top: row.getBoundingClientRect().top - top };
    });
    assert.ok(anchor, "a measured Planner row is visible before leaving");
    await page.evaluate(() => window.audit.selectPlannerScrollView("worker"));
    await page.locator(".back-to-query-btn").waitFor();
    await page.evaluate(() => window.audit.selectPlannerScrollView(""));
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".chat-messages-stream")).opacity) > 0.99);
    await page.waitForTimeout(250);
    const restored = await scroll.evaluate((element, id) => {
      const row = [...element.querySelectorAll(".planning-activity [data-transcript-id]")].find(item => item.dataset.transcriptId === id);
      return row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
    }, anchor.id);
    assert.ok(restored !== null && Math.abs(restored - anchor.top) <= 4,
      `returning should preserve the same visible row, not only its stale pixel offset: ${JSON.stringify({ anchor, restored })}`);
    await page.evaluate(() => { window.audit.selectPlannerScrollView("worker"); window.audit.setPlannerScrollWidth("600px"); });
    await page.locator(".back-to-query-btn").waitFor();
    await page.evaluate(() => window.audit.selectPlannerScrollView(""));
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".chat-messages-stream")).opacity) > 0.99);
    await page.waitForTimeout(300);
    const resized = await scroll.evaluate((element, id) => {
      const row = [...element.querySelectorAll(".planning-activity [data-transcript-id]")].find(item => item.dataset.transcriptId === id);
      return row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
    }, anchor.id);
    assert.ok(resized !== null && Math.abs(resized - anchor.top) <= 8,
      `resizing while away should retain the same reading anchor: ${JSON.stringify({ anchor, resized })}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("planner: cached follow-ups stay with their revisions while history pages load", { timeout: 30_000 }, async () => {
  const user = text => line({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
  const outputs = {
    "order-goal": user("ORDER_GOAL") + assistant("GOAL_REPLY"),
    "order-one": user("FOLLOW_1") + assistant("REPLY_1"),
    // An empty/missing user event still needs its local prompt before this reply.
    "order-two": assistant("REPLY_2"),
    "order-three": user("FOLLOW_3") + Array.from({ length: 80 }, (_, i) => assistant(`REPLY_3_${i}`)).join(""),
  };
  const requests = [];
  let releaseTwo, releaseOne;
  const { context, page, errors } = await newPage(async route => {
    const body = route.request().postDataJSON();
    if (new URL(route.request().url()).pathname !== "/api/get_planning_output") return route.fulfill({ json: { result: {} } });
    requests.push(body.planningId);
    if (body.planningId === "order-two") await new Promise(resolve => { releaseTwo = resolve; });
    if (body.planningId === "order-one") await new Promise(resolve => { releaseOne = resolve; });
    const bytes = Buffer.from(outputs[body.planningId]), start = body.offset ?? 0;
    try { await route.fulfill({ json: { result: { planningId: body.planningId, role: "planner",
      content: bytes.subarray(start).toString(), startOffset: start, nextOffset: bytes.length,
      totalBytes: bytes.length, complete: true, running: false } } }); } catch {}
  });
  try {
    await page.goto(`${origin}/__history?case=plannerHistoryOrder`, { waitUntil: "domcontentloaded" });
    await page.getByText("REPLY_3_79", { exact: true }).waitFor();
    for (let i = 0; i < 100 && !releaseTwo; i++) await page.waitForTimeout(20);
    assert.ok(releaseTwo, "the preceding revision is still loading");
    assert.equal(await page.getByText("FOLLOW_1", { exact: true }).count(), 0);
    assert.equal(await page.getByText("FOLLOW_2", { exact: true }).count(), 0,
      "cached older prompts must not be appended after the newest reply");
    await page.getByText("UNSAVED_FOLLOW_UP", { exact: true }).waitFor();
    releaseTwo(); releaseTwo = undefined;
    const scroll = page.locator(".initial-query-scroll");
    await scroll.evaluate(element => {
      element.scrollTop = 0;
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
    });
    await page.getByText("REPLY_2", { exact: true }).waitFor();
    await page.getByText("FOLLOW_2", { exact: true }).waitFor();
    const order = await page.locator(".planning-activity-output").innerText();
    assert.ok(order.indexOf("FOLLOW_2") < order.indexOf("REPLY_2"), "a missing user event is restored at its own revision");
    assert.equal(await page.getByText("FOLLOW_2", { exact: true }).count(), 1);
    for (let i = 0; i < 100 && !releaseOne; i++) {
      await scroll.evaluate(element => element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })));
      await page.waitForTimeout(20);
    }
    assert.ok(releaseOne, "older revision is requested on scrollback");
    releaseOne(); releaseOne = undefined;
    await scroll.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
    await page.getByText("FOLLOW_1", { exact: true }).waitFor();
    const loaded = await page.locator(".planning-activity-output").innerText();
    assert.ok(loaded.indexOf("FOLLOW_1") < loaded.indexOf("REPLY_1"));
    assert.equal(await page.getByText("FOLLOW_1", { exact: true }).count(), 1);
    assert.ok(requests.includes("order-one"));
    assert.deepEqual(errors, []);
  } finally { releaseTwo?.(); releaseOne?.(); await context.close(); }
});

for (const reviewMode of ["background", "foreground"]) {
  for (const evicted of [false, true]) {
    test(`planner: ${reviewMode} review preserves mounted history with ${evicted ? "evicted" : "cached"} logs`, { timeout: 30_000 }, async () => {
      const initial = assistant("RETAINED_PLANNER_HISTORY") + startTool("retained-tool", "echo retained") + endTool("retained-tool", "RETAINED_TOOL_OUTPUT");
      const requests = [];
      let releaseReview;
      const reviewGate = new Promise(resolve => { releaseReview = resolve; });
      const { context, page, errors } = await newPage(async route => {
        const body = route.request().postDataJSON();
        if (new URL(route.request().url()).pathname !== "/api/get_planning_output") return route.fulfill({ json: { result: {} } });
        requests.push(body);
        if (body.planningId === "plan-review") await reviewGate;
        const bytes = Buffer.from(body.planningId === "plan-initial" ? initial : assistant("NEW_REVIEW_OUTPUT"));
        const start = body.offset ?? 0;
        try { await route.fulfill({ json: { result: { planningId: body.planningId, role: "planner",
          content: bytes.subarray(start).toString(), startOffset: start, nextOffset: bytes.length,
          totalBytes: bytes.length, complete: true, running: false } } }); } catch {}
      });
      try {
        await page.goto(`${origin}/__history?case=plannerReview&reviewMode=${reviewMode}`, { waitUntil: "domcontentloaded" });
        await page.getByText("RETAINED_PLANNER_HISTORY", { exact: true }).waitFor();
        await page.locator(".planning-activity .tool-call-header").click();
        await page.getByText("RETAINED_TOOL_OUTPUT", { exact: true }).waitFor();
        await page.evaluate(async evict => {
          const { planningTranscriptCache } = await import("/src/services/transcriptCache.ts");
          // A mounted window may outlive its LRU entry (or exceed the cache budget).
          if (evict) planningTranscriptCache.delete("review-run:plan-initial");
          const history = document.querySelector(".planning-activity");
          const card = history.querySelector(".tool-call-body");
          window.reviewPaints = [];
          window.reviewHistory = history;
          window.reviewCard = card;
          window.watchReviewPaints = true;
          const sample = () => {
            window.reviewPaints.push(history.isConnected && card.isConnected && card.getClientRects().length > 0);
            if (window.watchReviewPaints) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
          window.audit.startReview();
        }, evicted);
        // Foreground review output joins durable replay at completion; a
        // background review joins as soon as its start snapshot arrives.
        if (reviewMode === "foreground") {
          await page.getByText("LIVE_REVIEW_OUTPUT", { exact: true }).waitFor();
          await page.evaluate(() => window.audit.finishReview());
        }
        for (let i = 0; i < 100 && !requests.some(body => body.planningId === "plan-review"); i++) await page.waitForTimeout(20);
        assert.ok(requests.some(body => body.planningId === "plan-review"), "review output is requested");
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => window.reviewHistory === document.querySelector(".planning-activity")), true,
          "adding a review must not remount the existing history");
        assert.ok(await page.evaluate(() => window.reviewPaints.length > 0 && window.reviewPaints.every(Boolean)),
          "history and expanded cards must stay painted while the new log is delayed");
        releaseReview();
        await page.getByText("NEW_REVIEW_OUTPUT", { exact: true }).waitFor();
        if (reviewMode === "foreground") assert.equal(await page.getByText("LIVE_REVIEW_OUTPUT", { exact: true }).count(), 0,
          "the settled review renders only its durable output");
        if (reviewMode === "background") await page.evaluate(() => window.audit.finishReview());
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => window.reviewCard === document.querySelector(".planning-activity .tool-call-body")), true,
          "review completion preserves the expanded historical card");
        assert.equal(requests.filter(body => body.planningId === "plan-initial" && body.tail).length, 1,
          "the mounted byte window must not be reloaded even when its cache entry was evicted");
        assert.deepEqual(errors, []);
      } finally { releaseReview(); await page.evaluate(() => { window.watchReviewPaints = false; }).catch(() => {}); await context.close(); }
    });
  }
}

test("planner: starting and finishing a review keeps the earlier planning conversation", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await newPage(async route => {
    const body = route.request().postDataJSON();
    const command = new URL(route.request().url()).pathname.slice(5);
    if (command !== "get_planning_output") return route.fulfill({ json: { result: {} } });
    const content = body.planningId === "plan-initial" ? assistant("INITIAL_PLANNER_HISTORY")
      : body.planningId === "plan-review" ? assistant("REVIEW_PLANNER_HISTORY") : "";
    const total = Buffer.byteLength(content);
    return route.fulfill({ json: { result: { planningId: body.planningId, role: "planner", content,
      startOffset: 0, nextOffset: total, totalBytes: total, complete: true, running: body.planningId === "plan-review" } } });
  });
  try {
    await page.goto(`${origin}/__history?case=plannerReview`, { waitUntil: "domcontentloaded" });
    await page.getByText("INITIAL_PLANNER_HISTORY", { exact: true }).waitFor();
    const scroller = page.locator(".initial-query-scroll");
    await page.evaluate(() => window.audit.startReview());
    await page.waitForTimeout(300);
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await page.waitForTimeout(200);
    assert.equal(await page.getByText("INITIAL_PLANNER_HISTORY", { exact: true }).count(), 1,
      "starting a review must retain the earlier Planner history");
    await page.evaluate(() => window.audit.finishReview());
    await page.waitForTimeout(200);
    await page.getByText("REVIEW_PLANNER_HISTORY", { exact: true }).waitFor();
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await page.waitForTimeout(200);
    assert.equal(await page.getByText("INITIAL_PLANNER_HISTORY", { exact: true }).count(), 1,
      "finishing a review must retain the earlier Planner history");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

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

test("an unrun Node opens at the top until its first execution exists", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: { files: [], skills: [] } } }));
  try {
    await page.goto(`${origin}/__history?case=unrunNode`, { waitUntil: "networkidle" });
    const scroller = page.locator(".initial-query-scroll");
    const assertAtTop = async () => {
      await page.locator(".initial-query-scroll.conversation-ready").waitFor();
      await page.waitForTimeout(150);
      const metrics = await scroller.evaluate(element => ({ top: element.scrollTop, range: element.scrollHeight - element.clientHeight }));
      assert.ok(metrics.range > 500, "the task must overflow to distinguish top from bottom");
      assert.equal(metrics.top, 0, "the newest information is the task at the top");
    };
    await assertAtTop();
    await page.evaluate(() => window.audit.growTask());
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.locator(".pane-bottom-chat textarea").fill("Unsent draft\n".repeat(8));
    await assertAtTop();
    await page.evaluate(() => window.audit.selectNode(""));
    await page.locator(".node-task-card").waitFor({ state: "detached" });
    await page.evaluate(() => window.audit.selectNode("worker"));
    await assertAtTop();
    await page.evaluate(() => window.audit.startNode());
    await page.waitForFunction(() => {
      const pane = document.querySelector(".initial-query-scroll");
      return pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 1;
    });
    await page.evaluate(() => window.audit.selectNode(""));
    await page.locator(".node-task-card").waitFor({ state: "detached" });
    await page.evaluate(() => window.audit.selectNode("worker"));
    await page.locator(".initial-query-scroll.conversation-ready").waitFor();
    await page.waitForFunction(() => {
      const pane = document.querySelector(".initial-query-scroll");
      return pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 1;
    });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

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
    nodes: { worker: { status: "completed", revision: 1, instruction: "", error: null } },
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
      // A reader gesture, not a layout clamp: only gestures stop following.
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
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
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.reviewCaches.executionTranscriptCache.get("run-a:exec-run-a")?.startOffset), Buffer.byteLength(prefix),
      "the fetched page stays outside the layout while its boundary is above the reader");
    const heldTop = await page.locator(`[data-transcript-id="${anchor.id}"]`).evaluate(row => row.getBoundingClientRect().top);
    assert.ok(Math.abs(heldTop - anchor.top) <= 3, `Workbench auto-follow dragged the reading anchor ${heldTop - anchor.top}px`);
    const boundaryTop = await scroller.evaluate((element, id) => {
      const transcript = element.querySelector(".virtualized-transcript-container");
      element.scrollTop += transcript.getBoundingClientRect().top - element.getBoundingClientRect().top - 1;
      return element.querySelector(`[data-transcript-id="${id}"]`).getBoundingClientRect().top;
    }, anchor.id);
    await page.waitForFunction(() => window.reviewCaches.executionTranscriptCache.get("run-a:exec-run-a")?.startOffset === 0);
    await page.waitForTimeout(200);
    const top = await page.locator(`[data-transcript-id="${anchor.id}"]`).evaluate(row => row.getBoundingClientRect().top);
    assert.ok(Math.abs(top - boundaryTop) <= 3, `landing the older page moved the reading anchor ${top - boundaryTop}px`);
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

test("Node navigation keeps history painted after the fade while older pages fill", { timeout: 30_000 }, async () => {
  const config = { repository: "/mock/node-reveal", model: "test/old", thinkingLevel: "off", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const prefix = Array.from({ length: 65 }, (_, i) => startTool(`reveal-tool-${i}`, `echo ${i}`) +
    endTool(`reveal-tool-${i}`, `Result ${i}`) + assistant(`OLDER_REVEAL_${i}`)).join("");
  const tail = startTool("reveal-tail", "echo tail") + endTool("reveal-tail", "x".repeat(4000)) + assistant("NODE_REVEAL_BOTTOM");
  const data = Buffer.from(prefix + tail), split = Buffer.byteLength(prefix);
  const snapshot = { ...empty, runId: "node-reveal", config, planType: "graph", phase: "completed", approved: true,
    graph: { originalGoal: "Node reveal regression", nodes: ["short", "paged"].map(name => ({ name, task: `Task ${name}` })), edges: [] },
    nodes: Object.fromEntries(["short", "paged"].map(name => [name, { status: "completed", revision: 1, instruction: "", error: null }])),
    executions: ["short", "paged"].map(name => ({ id: name, node: name, status: "completed", output: "",
      outputBytes: name === "paged" ? data.length : Buffer.byteLength(assistant("SHORT_NODE_REPLY")),
      revision: 1, attempt: 1, startedAt: 1, completedAt: 2, sessionId: `session-${name}`, worktree: "/mock", before: "", after: "" })) };
  let releaseOlder;
  const { context, page, errors } = await newPage(async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [snapshot.runId], repositoryInfo: { path: config.repository, name: "Node reveal", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = snapshot; break;
      case "snapshot_if_changed": result = { version: "1", snapshot: null }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_execution_output": {
        if (body.before !== undefined) await new Promise(resolve => { releaseOlder = resolve; });
        const bytes = body.executionId === "paged" ? data : Buffer.from(assistant("SHORT_NODE_REPLY"));
        const start = body.executionId === "paged" && body.before === undefined ? split : 0;
        const end = body.before ?? bytes.length;
        result = { runId: body.runId, executionId: body.executionId, content: bytes.subarray(start, end).toString(),
          startOffset: start, nextOffset: end, totalBytes: bytes.length, complete: end === bytes.length, status: "completed" }; break;
      }
      default: throw new Error(`Unexpected API ${command}`);
    }
    try { await route.fulfill({ json: { result } }); } catch { /* Node navigation can abort its reader. */ }
  });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-run-id="${snapshot.runId}"]`).click();
    for (const reducedMotion of ["no-preference", "reduce"]) {
      await page.emulateMedia({ reducedMotion });
      await page.locator('.react-flow__node[data-id="short"]').click();
      await page.getByText("SHORT_NODE_REPLY", { exact: true }).waitFor();
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".initial-query-scroll")).opacity) > 0.99);
      await page.locator('.react-flow__node[data-id="paged"]').click();
      await page.getByText("NODE_REVEAL_BOTTOM", { exact: true }).waitFor();
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".initial-query-scroll")).opacity) === 1);
      for (let i = 0; i < 100 && !releaseOlder; i++) await page.waitForTimeout(10);
      assert.ok(releaseOlder, "the short tail requests older history after its first visible page");
      await page.evaluate(() => {
        window.nodeRevealFrames = [];
        window.sampleNodeReveal = true;
        const sample = () => {
          const scroll = document.querySelector(".initial-query-scroll"), rect = scroll.getBoundingClientRect();
          const rows = [...scroll.querySelectorAll("[data-transcript-id]")];
          window.nodeRevealFrames.push({
            distanceFromBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
            visibleRows: rows.filter(row => { const bounds = row.getBoundingClientRect(); return bounds.bottom > rect.top && bounds.top < rect.bottom; }).length,
          });
          if (window.sampleNodeReveal) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      releaseOlder(); releaseOlder = undefined;
      await page.waitForFunction(() => document.querySelector('[data-execution-id="paged"]').getAttribute("aria-busy") === "false");
      await page.waitForTimeout(400);
      const frames = await page.evaluate(() => { window.sampleNodeReveal = false; return window.nodeRevealFrames; });
      assert.ok(frames.length >= 3, "sample the visible history fill, not just its final frame");
      assert.ok(frames.every(frame => frame.visibleRows > 0),
        `${reducedMotion}: filling older history must not paint a blank viewport: ${JSON.stringify(frames.filter(frame => !frame.visibleRows))}`);
      assert.ok(frames.every(frame => frame.distanceFromBottom <= 35),
        `${reducedMotion}: history must not flash back to the top after the fade: ${JSON.stringify(frames.filter(frame => frame.distanceFromBottom > 35))}`);
    }
    assert.deepEqual(errors, []);
  } finally { releaseOlder?.(); await context.close(); }
});

test("a Node reveal waits for its first viewport fill instead of re-laying out mid-fade", { timeout: 30_000 }, async () => {
  const config = { repository: "/mock/node-fill", model: "test/old", thinkingLevel: "off", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const prefix = Array.from({ length: 65 }, (_, i) => startTool(`fill-tool-${i}`, `echo ${i}`) +
    endTool(`fill-tool-${i}`, `Result ${i}`) + assistant(`FILLED_OLDER_${i}`)).join("");
  const tail = assistant("FILL_TAIL_ONLY");
  const data = Buffer.from(prefix + tail), split = Buffer.byteLength(prefix);
  const snapshot = { ...empty, runId: "node-fill", config, planType: "graph", phase: "completed", approved: true,
    graph: { originalGoal: "Node fill regression", nodes: [{ name: "paged", task: "Task paged" }], edges: [] },
    nodes: { paged: { status: "completed", revision: 1, instruction: "", error: null } },
    executions: [{ id: "paged", node: "paged", status: "completed", output: "", outputBytes: data.length,
      revision: 1, attempt: 1, startedAt: 1, completedAt: 2, sessionId: "session-paged", worktree: "/mock", before: "", after: "" }] };
  const { context, page, errors } = await newPage(async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [snapshot.runId], repositoryInfo: { path: config.repository, name: "Node fill", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = snapshot; break;
      case "snapshot_if_changed": result = { version: "1", snapshot: null }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_execution_output": {
        // A local older read is fast but never synchronous. Keep it inside the
        // reveal fallback so this asserts the normal path, not the stall path.
        if (body.before !== undefined) await new Promise(resolve => setTimeout(resolve, 120));
        const start = body.before !== undefined ? 0 : body.tail ? split : 0;
        const end = body.before ?? data.length;
        result = { runId: body.runId, executionId: body.executionId, content: data.subarray(start, end).toString(),
          startOffset: start, nextOffset: end, totalBytes: data.length, complete: end === data.length, status: "completed" }; break;
      }
      default: throw new Error(`Unexpected API ${command}`);
    }
    try { await route.fulfill({ json: { result } }); } catch { /* navigation can abort its reader. */ }
  });
  try {
    // The fade is the behavior under test, so opt back into motion.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-run-id="${snapshot.runId}"]`).click();
    await page.locator('.react-flow__node[data-id="paged"]').click();
    await page.getByText("FILL_TAIL_ONLY", { exact: true }).waitFor();
    await page.evaluate(() => {
      window.revealFillFrames = [];
      window.sampleRevealFill = true;
      const sample = () => {
        const scroll = document.querySelector(".initial-query-scroll");
        if (scroll) {
          const row = [...scroll.querySelectorAll("[data-transcript-id]")]
            .find(candidate => candidate.textContent?.includes("FILL_TAIL_ONLY"));
          window.revealFillFrames.push({ opacity: Number(getComputedStyle(scroll).opacity),
            rowTop: row?.getBoundingClientRect().top ?? null,
            filled: scroll.scrollHeight > 2000,
            status: [...scroll.querySelectorAll(".transcript-history-status")].some(element => element.textContent) });
        }
        if (window.sampleRevealFill) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".initial-query-scroll")).opacity) === 1);
    await page.waitForTimeout(300);
    const frames = await page.evaluate(() => { window.sampleRevealFill = false; return window.revealFillFrames; });
    const fading = frames.filter(frame => frame.opacity > 0.01 && frame.opacity < 0.99);
    assert.ok(fading.length >= 3, "sample the opacity transition itself");
    assert.ok(fading.every(frame => frame.filled), "the fill must commit before the fade paints");
    assert.ok(fading.every(frame => frame.rowTop !== null));
    const tops = fading.map(frame => frame.rowTop);
    assert.ok(Math.max(...tops) - Math.min(...tops) <= 1.5,
      `the newest row must not move while the conversation fades in: ${JSON.stringify(fading)}`);
    assert.ok(fading.every(frame => !frame.status), "automatic fill stays silent, so it cannot shift the transcript");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
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
        if (body.action === "stop_planner") {
          stopped = true;
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
    assert.equal(controls.filter(item => item.action === "stop_planner").length, 1,
      "the Planner conversation stops only its own turn");
    assert.deepEqual(errors, []);
  } finally { streamResponse?.destroy(); streamResponse = undefined; await context.close(); }
});

test("switching conversations on a large viewport stays anchored to the newest rows while history fills", { timeout: 45_000 }, async () => {
  const config = { repository: "/mock/large-switch", model: "test/old", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const longHistory = tag => Array.from({ length: 65 }, (_, i) =>
    startTool(`${tag}-tool-${i}`, `echo ${tag}-${i}`) + endTool(`${tag}-tool-${i}`, `RESULT_${tag}_${i}`) +
    assistant(`${tag} assistant message ${i}`)).join("");
  // Estimated virtual-row padding exceeds two viewports, but the measured
  // folded cards do not. Readiness must use their actual rendered height.
  const shortTail = tag => (tag === "serial-paged"
    ? Array.from({ length: 46 }, (_, i) => startTool(`${tag}-tail-${i}`, `echo ${i}`) +
      endTool(`${tag}-tail-${i}`, "x".repeat(4000))).join("")
    : startTool(`${tag}-tail`, `echo ${tag}-tail`) + endTool(`${tag}-tail`, "x".repeat(4000))) +
    assistant(`BOTTOM_MARKER_${tag}`);

  const runs = {
    "graph-paged": {
      ...empty, runId: "graph-paged", config, planType: "graph", phase: "completed", approved: true,
      planningId: "plan-latest",
      graph: { originalGoal: "TOP_USER_GOAL_graph-paged", nodes: [{ name: "worker", task: "Worker task" }], edges: [] },
      plan: { executionBatches: [["worker"]], roots: ["worker"], terminals: ["worker"], warnings: [] },
      nodes: { worker: { status: "completed", revision: 1, instruction: "", error: null } },
      events: [
        { type: "created", sequence: 1, planning_id: "plan-older", timestamp: 1 },
        { type: "graph_revised", sequence: 2, planning_id: "plan-latest", timestamp: 2 },
      ],
    },
    "serial-paged": {
      ...empty, runId: "serial-paged", config, planType: "serial", phase: "completed", approved: true,
      graph: { originalGoal: "TOP_USER_GOAL_serial-paged", nodes: [{ name: "task", task: "TOP_USER_GOAL_serial-paged" }], edges: [] },
      nodes: { task: { status: "completed", revision: 1, instruction: "", error: null } },
      executions: [{ id: "exec-paged", node: "task", status: "completed", output: "", outputBytes: 100_000,
        revision: 1, attempt: 1, startedAt: 1, completedAt: 2, sessionId: "s-1", worktree: "/mock", before: "", after: "" }],
    },
    "serial-multiturn": {
      ...empty, runId: "serial-multiturn", config, planType: "serial", phase: "completed", approved: true,
      graph: { originalGoal: "TOP_USER_GOAL_serial-multiturn", nodes: [{ name: "task", task: "TOP_USER_GOAL_serial-multiturn" }], edges: [] },
      nodes: { task: { status: "completed", revision: 2, instruction: "Follow-up instruction", error: null } },
      executions: [
        { id: "exec-turn-1", node: "task", status: "completed", output: "", outputBytes: 50_000,
          revision: 1, attempt: 1, startedAt: 1, completedAt: 2, sessionId: "s-2", worktree: "/mock", before: "", after: "" },
        { id: "exec-turn-2", node: "task", status: "completed", output: "", outputBytes: 1_000,
          revision: 2, attempt: 2, startedAt: 3, completedAt: 4, sessionId: "s-2", worktree: "/mock", before: "", after: "" },
      ],
      events: [
        { type: "invalidated", sequence: 1, target: "task", human: true, instruction: "Follow-up instruction", timestamp: 3 },
      ],
    },
  };

  const serialPagedPrefix = longHistory("serial-paged");
  const serialPagedTail = shortTail("serial-paged");
  const serialPagedFull = serialPagedPrefix + serialPagedTail;
  let failHistory = false;

  const { context, page, errors } = await newPage(async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (failHistory && ["get_planning_output", "get_execution_output"].includes(command)) {
      return route.fulfill({ status: 500, json: { error: "Mock transcript read failed" } });
    }
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: Object.keys(runs),
        repositoryInfo: { path: config.repository, name: "Large Switch", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = runs[body.runId] || empty; break;
      case "snapshot_if_changed": result = { version: body.runId, snapshot: null }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_planning_output": {
        if (body.planningId === "plan-older") {
          await new Promise(resolve => setTimeout(resolve, 500));
          const content = longHistory("graph-paged");
          result = { planningId: body.planningId, role: "planner", content, startOffset: 0,
            nextOffset: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content), complete: true, running: false };
        } else {
          const content = shortTail("graph-paged");
          result = { planningId: body.planningId, role: "planner", content, startOffset: 0,
            nextOffset: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content), complete: true, running: false };
        }
        break;
      }
      case "get_execution_output": {
        if (body.executionId === "exec-paged") {
          const total = Buffer.byteLength(serialPagedFull);
          const prefixBytes = Buffer.byteLength(serialPagedPrefix);
          if (body.before !== undefined) {
            await new Promise(resolve => setTimeout(resolve, 500));
            result = { runId: body.runId, executionId: body.executionId, content: serialPagedPrefix,
              startOffset: 0, nextOffset: prefixBytes, totalBytes: total, complete: false, status: "completed" };
          } else {
            await new Promise(resolve => setTimeout(resolve, 500));
            result = { runId: body.runId, executionId: body.executionId, content: serialPagedTail,
              startOffset: prefixBytes, nextOffset: total, totalBytes: total, complete: true, status: "completed" };
          }
        } else if (body.executionId === "exec-turn-1") {
          await new Promise(resolve => setTimeout(resolve, 500));
          const content = longHistory("serial-multiturn");
          result = { runId: body.runId, executionId: body.executionId, content, startOffset: 0,
            nextOffset: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content), complete: true, status: "completed" };
        } else {
          const content = shortTail("serial-multiturn");
          result = { runId: body.runId, executionId: body.executionId, content, startOffset: 0,
            nextOffset: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content), complete: true, status: "completed" };
        }
        break;
      }
      default: throw new Error(`Unexpected API ${command}`);
    }
    try { await route.fulfill({ json: { result } }); } catch {}
  });

  try {
    await page.setViewportSize({ width: 1440, height: 1350 });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => { window.switchCache = await import("/src/services/transcriptCache.ts"); });

    const switchAndMeasure = async runId => {
      await page.evaluate(targetRunId => {
        window.switchSamples = [];
        window.samplingSwitch = true;
        const sample = () => {
          const scroll = document.querySelector(".initial-query-scroll");
          const stream = document.querySelector(".chat-messages-stream");
          const topPrompt = [...document.querySelectorAll(".chat-bubble-user")].find(el =>
            el.textContent?.includes(`TOP_USER_GOAL_${targetRunId}`));
          if (scroll && stream && topPrompt) {
            const scrollOpacity = Number(getComputedStyle(scroll).opacity);
            const streamOpacity = Number(getComputedStyle(stream).opacity);
            if (scrollOpacity > 0.01 && streamOpacity > 0.01) {
              const scrollRect = scroll.getBoundingClientRect();
              const promptRect = topPrompt.getBoundingClientRect();
              window.switchSamples.push({
                scrollTop: scroll.scrollTop,
                scrollHeight: scroll.scrollHeight,
                clientHeight: scroll.clientHeight,
                distanceFromBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
                historyFilled: targetRunId === "graph-paged"
                  ? window.switchCache.planningTranscriptCache.has("graph-paged:plan-older")
                  : targetRunId === "serial-paged"
                    ? window.switchCache.executionTranscriptCache.get("serial-paged:exec-paged")?.startOffset === 0
                    : window.switchCache.executionTranscriptCache.has("serial-multiturn:exec-turn-1") &&
                      window.switchCache.executionTranscriptCache.has("serial-multiturn:exec-turn-2"),
                topPromptVisible: promptRect.bottom > scrollRect.top + 4 && promptRect.top < scrollRect.bottom,
              });
            }
          }
          if (window.samplingSwitch) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, runId);

      await page.locator(`.run-item[data-run-id="${runId}"]`).click();
      await page.getByText(`BOTTOM_MARKER_${runId}`, { exact: true }).waitFor();
      await page.waitForFunction(() => {
        const scroll = document.querySelector(".initial-query-scroll");
        return scroll && Number(getComputedStyle(scroll).opacity) > 0.99;
      });
      await page.waitForTimeout(120);
      const samples = await page.evaluate(() => {
        window.samplingSwitch = false;
        return window.switchSamples;
      });
      assert.ok(samples.length >= 3, `${runId}: expected visible frame samples`);
      for (const frame of samples) {
        // The conversation reveals on the first byte page and fills its viewport
        // behind the visible frame. It must stay anchored to the newest rows so
        // the fill never jumps the reader or drops them mid-history.
        assert.ok(frame.distanceFromBottom <= 35,
          `${runId}: visible frame was not anchored at the bottom: ${JSON.stringify(frame)}`);
      }
      // The fill still completes without any user gesture, and once it has grown
      // the conversation the top user prompt is scrolled out instead of left on
      // screen (a short tail legitimately fits the viewport until then).
      await page.waitForFunction(targetRunId => {
        const cache = window.switchCache;
        return targetRunId === "graph-paged"
          ? cache.planningTranscriptCache.has("graph-paged:plan-older")
          : targetRunId === "serial-paged"
            ? cache.executionTranscriptCache.get("serial-paged:exec-paged")?.startOffset === 0
            : cache.executionTranscriptCache.has("serial-multiturn:exec-turn-1") &&
              cache.executionTranscriptCache.has("serial-multiturn:exec-turn-2");
      }, runId, { timeout: 5000 });
      await page.waitForTimeout(60);
      const settled = await page.evaluate(targetRunId => {
        const scroll = document.querySelector(".initial-query-scroll");
        const topPrompt = [...document.querySelectorAll(".chat-bubble-user")].find(el =>
          el.textContent?.includes(`TOP_USER_GOAL_${targetRunId}`));
        const scrollRect = scroll.getBoundingClientRect();
        const promptRect = topPrompt.getBoundingClientRect();
        return {
          distanceFromBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
          topPromptVisible: promptRect.bottom > scrollRect.top + 4 && promptRect.top < scrollRect.bottom,
        };
      }, runId);
      assert.equal(settled.topPromptVisible, false,
        `${runId}: top user prompt flashed back into view after the fill settled`);
      assert.ok(settled.distanceFromBottom <= 35,
        `${runId}: settled frame was not anchored at the bottom: ${JSON.stringify(settled)}`);
    };
    for (const reducedMotion of ["no-preference", "reduce"]) {
      await page.emulateMedia({ reducedMotion });
      for (const runId of ["graph-paged", "serial-paged", "serial-multiturn", "graph-paged", "serial-paged"]) {
        await switchAndMeasure(runId);
      }
    }
    // Without a time-based reveal, a failed read must still show its error and
    // permit retry instead of leaving the conversation permanently transparent.
    for (const runId of ["graph-paged", "serial-paged"]) {
      failHistory = true;
      await page.locator(`.run-item[data-run-id="${runId}"]`).click();
      const alert = page.getByRole("alert").filter({ hasText: "Mock transcript read failed" });
      await alert.waitFor({ state: "visible" });
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".initial-query-scroll")).opacity) > 0.99);
      failHistory = false;
      // A background retry may succeed between reading the error and clicking;
      // the recovery contract is the rendered marker, not one transient button.
      if (await alert.isVisible().catch(() => false)) {
        await alert.getByRole("button", { name: "Retry", exact: true }).click({ timeout: 3000 }).catch(() => {});
      }
      await page.getByText(`BOTTOM_MARKER_${runId}`, { exact: true }).waitFor();
      await alert.waitFor({ state: "detached" });
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("an edited Planner follow-up keeps its turn and the failure notice", { timeout: 45_000 }, async () => {
  // A rejected provider turn (for example an OAuth 403) fails before Pi writes
  // the turn's JSONL. The durable replay therefore has no rows for it, and the
  // live stream is the only record of the edited message and the error. Keeping
  // the live rows also stops the conversation from collapsing to its top.
  const config = { repository: "/mock/edit-failure", model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: true };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const reason = Array.from({ length: 40 }, (_, index) => `EDIT_REASONING_${index} ` + "detail ".repeat(12)).join("\n\n");
  const current = { ...empty, runId: "edit-run", config, planType: "graph", phase: "completed", approved: true,
    planningId: "follow-plan",
    planning: { planningId: "follow-plan", status: "success", createdAt: 2, repository: config.repository, runId: "edit-run",
      roles: { planner: { sessionId: "planner-session", sessionStart: 1 } } },
    graph: { originalGoal: "EDIT GOAL", nodes: [{ name: "worker", task: "Worker" }], edges: [] },
    nodes: { worker: { status: "completed", revision: 1, instruction: "", error: null } },
    executions: [{ id: "done-execution", node: "worker", status: "completed", revision: 1, attempt: 1,
      startedAt: 1, completedAt: 2, sessionId: "worker-session", worktree: "/mock/edit-worker",
      before: "", after: "head", output: "", outputBytes: 0 }],
    events: [
      { type: "created", sequence: 1, planning_id: "old-plan", timestamp: 1,
        planning: { planningId: "old-plan", status: "success", createdAt: 1 } },
      { type: "created", sequence: 2, planning_id: "follow-plan", timestamp: 2,
        planning: { planningId: "follow-plan", status: "success", createdAt: 2 } },
    ] };
  const failure = { planningId: "edit-plan", status: "failed", createdAt: 3, repository: config.repository,
    runId: "edit-run", planType: "graph",
    error: "OAuth refresh failed for openai: OpenAI OAuth token request failed (403): unsupported_country_region_territory",
    roles: { planner: { sessionId: "planner-session", sessionStart: 1 } } };
  // `edit-plan` is empty on purpose: the failed turn never reached the writer.
  const outputs = {
    "old-plan": assistant("OLD TURN ANSWER"),
    "follow-plan": line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "FIRST FOLLOW UP" }] } }) + assistant("FOLLOW ANSWER"),
    "edit-plan": "",
  };
  let edited = null;
  onPlanStream = (body, res) => {
    edited = body;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: run_started\ndata: ${JSON.stringify({ runId: "edit-run" })}\n\n`);
    res.write(`event: planner\ndata: ${JSON.stringify({ event: { type: "message_start", message: { role: "assistant", content: [] } } })}\n\n`);
    res.write(`event: planner\ndata: ${JSON.stringify({ event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: reason } } })}\n\n`);
    setTimeout(() => {
      res.write(`event: error\ndata: ${JSON.stringify({ error: failure.error, planningId: failure.planningId, summary: failure })}\n\n`);
      res.end();
    }, 400);
  };
  const { context, page, errors } = await newPage(async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (command === "plan_goal_stream") return route.continue();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [current.runId], repositoryInfo: { path: config.repository, name: "Edit failure", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = current; break;
      case "snapshot_if_changed": result = { version: "fixed", snapshot: current }; break;
      case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "edit_planner": result = current; break;
      case "get_planning_output": {
        const content = outputs[body.planningId] ?? "";
        result = { planningId: body.planningId, role: "planner", content: body.offset ? "" : content,
          startOffset: 0, nextOffset: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content), complete: true, running: false };
        break;
      }
      case "get_execution_output": result = { runId: body.runId, executionId: body.executionId, content: "",
        startOffset: body.offset ?? 0, nextOffset: 0, totalBytes: 0, complete: true, status: "completed" }; break;
      default: result = {};
    }
    return route.fulfill({ json: { result } });
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="edit-run"]').click();
    await page.getByText("FOLLOW ANSWER", { exact: true }).waitFor();
    await page.waitForTimeout(800);
    const row = page.locator(".chat-message-row.user", { hasText: "FIRST FOLLOW UP" }).first();
    await row.locator(".chat-user-message-card-wrapper").hover();
    await row.locator(".chat-message-edit-btn").click();
    const editor = page.locator(".chat-bubble-edit-textarea");
    await editor.fill("EDITED FOLLOW UP");
    await editor.press("Enter");
    await page.locator(".planning-error-notice").waitFor();
    const liveFailure = page.locator(".planner-transcript").getByTestId("transcript-error-card");
    await liveFailure.getByText(failure.error, { exact: true }).waitFor();
    await page.waitForTimeout(1200);
    assert.equal(await liveFailure.count(), 1, "the live failure is retained once, not replaced by a banner or duplicated");
    assert.equal(edited?.goal, "EDITED FOLLOW UP", "the edit starts a replacement Planner turn");
    const view = await page.evaluate(expectedError => {
      const scroll = document.querySelector(".initial-query-scroll");
      const pane = scroll.getBoundingClientRect();
      const notice = document.querySelector(".planning-error-notice")?.getBoundingClientRect();
      const visibleText = element => !!element && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      const text = selector => document.querySelector(selector)?.textContent ?? "";
      return { top: scroll.scrollTop, height: scroll.scrollHeight, client: scroll.clientHeight,
        notice: notice && { top: notice.top, bottom: notice.bottom }, pane: { top: pane.top, bottom: pane.bottom },
        editedTurn: text(".planner-transcript"), priorTurn: text(".planning-activity"),
        liveError: [...document.querySelectorAll('.planner-transcript [data-testid="transcript-error-card"]')]
          .some(element => element.textContent.includes(expectedError) && visibleText(element)) };
    }, failure.error);
    assert.ok(view.editedTurn.includes("EDITED FOLLOW UP"),
      `the failed replacement turn stays visible: ${JSON.stringify(view)}`);
    assert.ok(view.liveError, `the live failure row stays visible: ${JSON.stringify(view)}`);
    assert.ok(view.priorTurn.includes("FIRST FOLLOW UP"),
      `earlier Planner turns stay replayed: ${JSON.stringify(view)}`);
    assert.ok(view.height > view.client + 1,
      `the conversation must not collapse to its top: ${JSON.stringify(view)}`);
    assert.ok(view.notice && view.notice.top >= view.pane.top && view.notice.bottom <= view.pane.bottom,
      `the failure notice must be visible: ${JSON.stringify(view)}`);
    assert.deepEqual(errors, []);
  } finally {
    onPlanStream = undefined;
    await context.close();
  }
});
