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

async function newPage(handler) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
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

test("history status bridges page gaps without flashing for fast reads or moving history", { timeout: 20_000 }, async () => {
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }));
  try {
    await page.goto(`${origin}/__history?case=historyStatus`, { waitUntil: "networkidle" });
    await page.clock.install();
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
    // A fast, isolated read should never paint a loading-text flash.
    await loading(true); await page.clock.runFor(30);
    await loading(false); await page.clock.runFor(1000);
    assert.equal(await status.innerText(), "");
    assert.ok((await page.evaluate(() => window.historyStatusTexts)).every(text => !text));
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
  test(`${role}: giant output stays inside one normal tool card with a small truncated body`, { timeout: 30_000 }, async () => {
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
      await card.locator(".tool-truncated-pill").waitFor();
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

test("Planner details show the backend-selected cwd for every turn", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await newPage(route => route.fulfill({ json: { result: {} } }));
  try {
    await page.goto(`${origin}/__workspace-footer?mode=planner`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Planning session details", exact: true }).click();
    const details = page.locator(".workspace-details-body");
    await details.getByText("workspace: /mock", { exact: true }).waitFor();
    for (const worktree of ["/worktrees/run/root", "/worktrees/run/right", "/mock"]) {
      await page.evaluate(path => window.audit.selectPlannerWorkspace(path), worktree);
      await details.getByText(`workspace: ${worktree}`, { exact: true }).waitFor();
    }
    await details.locator("summary").click();
    await details.getByText("turn-1: /worktrees/run/root", { exact: true }).waitFor();
    await details.getByText("turn-2: /worktrees/run/right", { exact: true }).waitFor();
    await details.getByText("turn-3: /mock", { exact: true }).waitFor();
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
    const banner = page.locator(".floating-recovered-banner");
    await banner.waitFor();
    assert.match(await banner.innerText(), /Connected to the active planning session/);
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
    await page.locator('[data-execution-id="first-execution"]').waitFor();
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

test("switching conversations on a large viewport never flashes the top user prompt during multi-page or multi-turn history fill", { timeout: 45_000 }, async () => {
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
        assert.equal(frame.historyFilled, true,
          `${runId}: history appeared before the initial viewport fill: ${JSON.stringify(frame)}`);
        assert.equal(frame.topPromptVisible, false,
          `${runId}: top user prompt flashed on screen during switch: ${JSON.stringify(frame)}`);
        assert.ok(frame.distanceFromBottom <= 35,
          `${runId}: visible frame was not anchored at the bottom: ${JSON.stringify(frame)}`);
      }
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
      await alert.getByRole("button", { name: "Retry", exact: true }).click();
      await page.getByText(`BOTTOM_MARKER_${runId}`, { exact: true }).waitFor();
      await alert.waitFor({ state: "detached" });
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
