import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

let server, browser, origin;
before(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-performance-acceptance",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
    plugins: [{ name: "performance-acceptance-fixtures",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (!req.url.startsWith("/__performance?")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await vite.transformIndexHtml(req.url, '<html><body><div id="root" style="padding:32px"></div><script type="module" src="/scripts/fixtures/frontend-performance.tsx"></script></body></html>'));
        });
      },
    }],
  });
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(query, handler) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  const errors = [];
  await context.route("**/api/*", async route => {
    if (handler) return handler(route, new URL(route.request().url()).pathname.slice(5), route.request().postDataJSON());
    errors.push(`Unexpected API: ${route.request().url()}`);
    await route.fulfill({ status: 500, json: { error: "Unexpected API" } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/__performance?${query}`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!window.performanceAudit);
    return { context, page, errors };
  } catch (error) {
    await context.close();
    throw new Error(`Performance fixture failed: ${errors.join("; ")} ${error}`);
  }
}
const scroll = (page, target) => page.locator("[data-shared-scroll]").evaluate((element, target) => {
  element.scrollTop = target === "bottom" ? element.scrollHeight : target;
}, target);

for (const live of [false, true]) {
  test(`${live ? "live" : "saved"} Planner windows a shared scroll area and retains expansion/edit/reading state`, { timeout: 45_000 }, async () => {
    const { context, page, errors } = await fixture(`case=transcript${live ? "&live=1" : ""}`);
    try {
      await page.locator('[data-transcript-id="tool-0"]').waitFor();
      await scroll(page, 350);
      const card = page.locator('[data-transcript-id="tool-2"]');
      await card.locator(".tool-call-header").click();
      await card.locator(".tool-call-body").waitFor();
      await page.waitForTimeout(350);
      assert.ok(await page.locator(".tool-call-card").count() < 60, "long history must not mount hundreds of offscreen cards");
      await scroll(page, "bottom");
      await page.locator('[data-transcript-id="tool-799"]').waitFor();
      await scroll(page, 350);
      await card.locator(".tool-call-body").waitFor();
      assert.equal(await page.evaluate(() => window.performanceAudit.resized.length), 1, "remounting cannot replay the expansion action");
      await card.locator(".tool-call-header").click();
      await page.waitForTimeout(350);
      await scroll(page, 350 + 400 * 72);
      // Height estimates converge as rows are measured; locate the middle turn by
      // the IDs actually mounted rather than assuming every card has equal height.
      for (let attempt = 0; attempt < 12; attempt++) {
        if (await page.locator(".chat-user-message-card-wrapper").count()) break;
        await page.locator("[data-shared-scroll]").evaluate(element => {
          const ids = [...element.querySelectorAll('[data-transcript-id^="tool-"]')].map(row => +row.dataset.transcriptId.slice(5));
          const middle = (Math.min(...ids) + Math.max(...ids)) / 2;
          element.scrollTop += (400 - middle) * 72;
        });
        await page.waitForTimeout(60);
      }
      const user = page.locator(".chat-user-message-card-wrapper");
      await user.waitFor(); await user.hover();
      await user.locator(".chat-message-edit-btn").click();
      const draft = page.getByRole("textbox", { name: "Edit message content" });
      await draft.fill("Rejected middle draft 中文🚀");
      await draft.press("Enter");
      await page.waitForFunction(() => window.performanceAudit.edits.length === 1);
      assert.equal(await draft.inputValue(), "Rejected middle draft 中文🚀");
      const top = await page.locator("[data-shared-scroll]").evaluate(element => element.scrollTop);
      await page.evaluate(() => window.performanceAudit.append());
      await page.waitForTimeout(150);
      assert.equal(await draft.inputValue(), "Rejected middle draft 中文🚀");
      assert.ok(Math.abs(await page.locator("[data-shared-scroll]").evaluate(element => element.scrollTop) - top) < 3,
        "new output cannot move a user reading/editing the middle of history");
      await scroll(page, "bottom");
      await page.getByText("Appended final 中文🚀", { exact: true }).waitFor();
      await page.locator("[data-after]").waitFor({ state: "visible" });
      assert.ok(await page.locator(".tool-call-card").count() < 60);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("acceptance compares mounted Planner rows with the unwindowed inline layout", { timeout: 45_000 }, async () => {
  const measurements = [];
  for (const baseline of [true, false]) {
    const { context, page, errors } = await fixture(`case=transcript${baseline ? "&baseline=1" : ""}`);
    try {
      await scroll(page, "bottom"); await page.locator('[data-transcript-id="tool-799"]').waitFor();
      measurements.push({ baseline, cards: await page.locator(".tool-call-card").count(),
        ...await page.evaluate(() => ({ commits: window.performanceAudit.commits, renders: window.performanceAudit.renders })) });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  assert.equal(measurements[0].cards, 800);
  assert.ok(measurements[1].cards < 60);
  console.log("Planner DOM acceptance:", JSON.stringify(measurements));
});

test("frame batching preserves all 100 updates, drains before terminal/reset actions and uses current callbacks", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("case=frame");
  try {
    const before = await page.evaluate(() => window.performanceAudit.commits);
    await page.evaluate(() => window.performanceAudit.queueBurst());
    const expected = Array.from({ length: 100 }, (_, i) => `${i},`).join("");
    await page.waitForFunction(text => window.performanceAudit.text === text, expected);
    assert.equal(await page.evaluate(() => window.performanceAudit.commits) - before, 1,
      "one presentation commit, not 100 commits");
    await page.evaluate(() => { window.performanceAudit.reset(); window.performanceAudit.queueBurst(); window.performanceAudit.finish(); });
    await page.waitForFunction(text => window.performanceAudit.text === text, expected + "done");
    await page.evaluate(() => { window.performanceAudit.queueBurst(); window.performanceAudit.reset(); });
    await page.waitForFunction(() => window.performanceAudit.text === "");
    await page.waitForTimeout(80);
    assert.equal(await page.locator("[data-frame-text]").innerText(), "", "a cancelled frame cannot restore the previous conversation");
    const stable = await page.evaluate(() => { window.performanceAudit.originalCallback = window.performanceAudit.callback; window.performanceAudit.setFactor(7); return true; });
    assert.ok(stable);
    await page.waitForFunction(() => window.performanceAudit.callback() === 7);
    assert.equal(await page.evaluate(() => window.performanceAudit.callback === window.performanceAudit.originalCallback), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("log-only snapshots keep graph layout/cards/edges unchanged; selection changes only one card", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("case=projection");
  try {
    await page.evaluate(() => window.performanceAudit.updateBytes());
    await page.waitForFunction(() => document.querySelector("[data-projection]").textContent === "1:");
    assert.deepEqual(await page.evaluate(() => window.performanceAudit.sharing), { graph: true, nodes: true, edges: true, first: true, second: true });
    await page.evaluate(() => window.performanceAudit.select("b"));
    await page.waitForFunction(() => document.querySelector("[data-projection]").textContent === "1:b");
    assert.deepEqual(await page.evaluate(() => window.performanceAudit.sharing), { graph: true, nodes: false, edges: true, first: true, second: false });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("hidden log polling slows down, visible resumes at the byte cursor and completion stops requests", { timeout: 30_000 }, async () => {
  const requests = [];
  const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Resumed 中文🚀" }] } }) + "\n";
  let complete = false;
  const { context, page, errors } = await fixture("case=log", async (route, command, body) => {
    assert.equal(command, "get_execution_output"); requests.push(body.offset);
    const content = complete && body.offset === 0 ? line : "";
    await route.fulfill({ json: { result: { runId: "log-run", executionId: "log-exec", content,
      nextOffset: complete ? Buffer.byteLength(line) : 0, totalBytes: complete ? Buffer.byteLength(line) : 0,
      complete: true, status: complete ? "completed" : "running" } } });
  });
  try {
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => window.performanceAudit.hidden });
      window.performanceAudit.hidden = true; document.dispatchEvent(new Event("visibilitychange"));
    });
    const hiddenCount = requests.length;
    await page.waitForTimeout(700); assert.equal(requests.length, hiddenCount);
    complete = true;
    await page.evaluate(() => { window.performanceAudit.hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
    await page.getByText("Resumed 中文🚀", { exact: true }).waitFor();
    const completedCount = requests.length;
    await page.waitForTimeout(1400); assert.equal(requests.length, completedCount);
    assert.equal(requests.at(-1), 0, "visibility does not reset or advance the server byte cursor without bytes");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("bootstrap reuses selected metadata and labels, bounds requests and does not refetch blank goals", { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ locale: "en-US" });
  const config = { repository: "/perf", model: "", thinkingLevel: "medium", maxParallel: 0, maxFeedback: 3, autoApprove: false };
  const info = { name: "Performance", path: "/perf", branch: "main", clean: true, head: "" };
  const empty = { runId: "", graph: { originalGoal: "", nodes: [], edges: [] }, config: null, nodes: {}, executions: [], events: [], plan: null,
    approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const snapshots = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`perf-${i}`, { ...empty, runId: `perf-${i}`, config, phase: "completed",
    graph: { ...empty.graph, originalGoal: i % 3 ? `Goal ${i}` : "" } }]));
  const histories = [], errors = [];
  let active = 0, maximum = 0;
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: snapshots["perf-0"], runs: Object.keys(snapshots), repositoryInfo: info, dataPath: "/mock" }; break;
      case "history":
        histories.push(body.runId); active++; maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 50)); active--; result = snapshots[body.runId]; break;
      case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
      case "snapshot_if_changed": result = { version: "fixed", snapshot: null }; break;
      case "list_plannings": result = []; break;
      default: errors.push(`Unexpected API: ${command}`); result = null;
    }
    await route.fulfill({ json: { result } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(10_000); page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelectorAll(".run-item").length === 24);
    await page.waitForTimeout(500);
    assert.equal(histories.length, 23); assert.equal(new Set(histories).size, 23); assert.ok(maximum <= 8);
    assert.equal(histories.includes("perf-0"), false);
    assert.deepEqual(errors, []);
    console.log(`Bootstrap acceptance: 24 Runs, ${histories.length} history requests, maximum concurrency ${maximum}, no duplicate label requests`);
  } finally { await context.close(); }
});
