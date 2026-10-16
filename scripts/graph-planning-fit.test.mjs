import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

let server, browser, origin;
let planningResponse;
before(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-graph-planning-fit",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false },
    plugins: [{ name: "graph-planning-fixture", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url === "/api/plan_goal_stream") {
          for await (const _chunk of req) { /* Drain the request before streaming. */ }
          planningResponse = res;
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          res.write(": planning\n\n");
          return;
        }
        if (req.url !== "/__graph-planning") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url,
          '<html><body><div id="root"></div><script type="module" src="/scripts/fixtures/graph-planning.tsx"></script></body></html>'));
      });
    } }],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { planningResponse?.destroy(); await browser?.close(); await server?.close(); });

test("actual App: node results render before Planner completion; edges rearrange a visible, centered graph", { timeout: 30_000 }, async () => {
  const config = { repository: "/mock/live-graph", model: "test/model", thinkingLevel: "off", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const goal = "Build a live topology";
  const runId = "live-graph";
  let snapshot = empty, textTimer;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });
  await context.addInitScript(config => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_plan_mode", "graph");
    localStorage.setItem("grapher_projects", JSON.stringify([{ id: config.repository, path: config.repository, name: "Live graph", lastOpened: 1 }]));
  }, config);
  const errors = [];
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    if (command === "plan_goal_stream") return route.continue();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [], repositoryInfo: { path: config.repository, name: "Live graph", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = snapshot; break;
      case "snapshot_if_changed": result = { version: snapshot.phase, snapshot: snapshot.runId ? snapshot : null }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [] }; break;
      default: errors.push(`Unexpected API: ${command}`); result = null;
    }
    try { await route.fulfill({ json: { result } }); } catch { /* A superseded poll can be aborted. */ }
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  const send = (type, data) => planningResponse.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const planner = event => send("planner", { event, raw: JSON.stringify(event) + "\n" });
  const startTool = (id, toolName, args) => planner({ type: "tool_execution_start", toolCallId: id, toolName, args });
  // Pi's end event intentionally has no args. The pairing must survive text updates and polls.
  const endTool = (id, toolName, topology, isError = false) => planner({ type: "tool_execution_end", toolCallId: id, toolName, isError,
    result: { content: [{ type: "text", text: JSON.stringify({ applied: !isError, topology }) }] } });
  const tool = (id, toolName, args, topology, isError = false) => {
    startTool(id, toolName, args);
    endTool(id, toolName, topology, isError);
  };
  const nodes = ["a", "b", "c"].map(name => ({ name, task: `Task ${name}` }));
  const edges = [{ from: "a", to: "b", feedback: false }, { from: "b", to: "c", feedback: false }];
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    const input = page.locator(".landing-screen textarea");
    await input.fill(goal); await input.press("Enter");
    for (let i = 0; !planningResponse && i < 100; i++) await page.waitForTimeout(20);
    assert.ok(planningResponse, "Planner stream started");
    snapshot = { ...empty, runId, config, phase: "planning", planType: "graph",
      graph: { ...empty.graph, originalGoal: goal }, events: [{ sequence: 1, timestamp: 1, type: "planning_started", plan_type: "graph" }] };
    send("run_started", { runId });
    send("route_decision", { planType: "graph" });
    planner({ type: "message_start", message: { role: "assistant", content: [] } });
    textTimer = setInterval(() => planner({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Still planning. " } }), 50);

    startTool("node-a", "node", { nodes: nodes.slice(0, 1) });
    await page.waitForFunction(() => {
      const pane = document.querySelector(".graph-pane");
      return pane && +getComputedStyle(pane).opacity > 0.99;
    });
    assert.equal(await page.locator(".react-flow__node").count(), 0, "show the pane on tool start, but only accepted results become cards");
    endTool("node-a", "node", { nodes: ["a"], edges: [] });
    await assertFitted(page, [["a"]]);
    tool("node-bc", "node", { nodes: nodes.slice(1) }, { nodes: ["a", "b", "c"], edges: [] });
    await assertFitted(page, [["a", "b", "c"]]);
    assert.equal(planningResponse.writableEnded, false, "cards appear while the response is still open");
    assert.equal(await page.getByRole("button", { name: "Approve", exact: true }).count(), 0, "preview is not approval");

    await page.evaluate(() => {
      window.graphFrames = [];
      window.sampleGraph = true;
      const sample = () => {
        const flow = document.querySelector(".graph-canvas .react-flow");
        const elements = [...(flow?.querySelectorAll(".react-flow__node") ?? [])];
        if (flow && elements.length) {
          const rects = elements.map(node => node.getBoundingClientRect()), canvas = flow.getBoundingClientRect();
          const left = Math.min(...rects.map(r => r.left)), right = Math.max(...rects.map(r => r.right));
          const top = Math.min(...rects.map(r => r.top)), bottom = Math.max(...rects.map(r => r.bottom));
          window.graphFrames.push({ centerError: Math.max(Math.abs((left + right - canvas.left - canvas.right) / 2),
            Math.abs((top + bottom - canvas.top - canvas.bottom) / 2)),
            visible: elements.every(node => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })),
            opacity: [getComputedStyle(flow).opacity, getComputedStyle(flow.closest(".graph-pane")).opacity],
            hidden: elements.filter(node => !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
              .map(node => ({ id: node.dataset.id, visibility: getComputedStyle(node).visibility })),
            positions: rects.map(r => [r.left, r.top]) });
        }
        if (window.sampleGraph) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    tool("edges", "edge", { edges }, { nodes: ["a", "b", "c"], edges });
    await assertFitted(page, [["a"], ["b"], ["c"]]);
    assert.equal(await page.locator(".react-flow__edge-path").count(), 2, "accepted edges render during planning");
    const frames = await page.evaluate(() => { window.sampleGraph = false; return window.graphFrames; });
    assert.ok(frames.every(frame => frame.visible), `edge rearrangement never hides existing cards: ${JSON.stringify(frames.filter(frame => !frame.visible).slice(0, 3))}`);
    assert.ok(frames.every(frame => frame.centerError < 8), `rearrangement stays centered: ${Math.max(...frames.map(f => f.centerError))}px`);
    assert.ok(new Set(frames.map(frame => JSON.stringify(frame.positions))).size > 3, "cards move through intermediate layouts, not a final-layout jump");
    assert.equal(planningResponse.writableEnded, false, "edge layout does not wait for Planner completion");

    tool("rejected", "node", { nodes: [{ name: "phantom", task: "Invalid edit" }] }, { nodes: ["a", "b", "c"], edges }, true);
    await page.waitForTimeout(850); // At least one durable empty-graph poll must not erase the preview.
    await assertFitted(page, [["a"], ["b"], ["c"]]);
    assert.equal(await page.locator('.react-flow__node[data-id="phantom"]').count(), 0);
    clearInterval(textTimer);
    snapshot = { ...snapshot, phase: "awaiting_approval", graph: { originalGoal: goal, nodes, edges },
      nodes: Object.fromEntries(nodes.map(node => [node.name, { status: "waiting" }])),
      plan: { executionBatches: [["a"], ["b"], ["c"]], roots: ["a"], terminals: ["c"], warnings: [] } };
    planningResponse.end(`event: complete\ndata: ${JSON.stringify({ snapshot })}\n\n`);
    await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
    await assertFitted(page, [["a"], ["b"], ["c"]]);

    // Revise an unapproved draft whose saved plan still contains the old chain.
    // Polling that plan must not pin a live edge edit to obsolete execution batches.
    planningResponse = undefined;
    const followUp = page.locator(".pane-bottom-chat textarea");
    await followUp.fill("Remove the dependencies"); await followUp.press("Enter");
    for (let i = 0; !planningResponse && i < 100; i++) await page.waitForTimeout(20);
    assert.ok(planningResponse, "revision stream started");
    send("run_started", { runId });
    tool("remove-edges", "edge", { edges: edges.map(edge => ({ ...edge, delete: true })) }, { nodes: ["a", "b", "c"], edges: [] });
    await assertFitted(page, [["a", "b", "c"]]);
    await page.waitForTimeout(850);
    await assertFitted(page, [["a", "b", "c"]]);
    assert.equal(await page.locator(".react-flow__edge-path").count(), 0);
    snapshot = { ...snapshot, graph: { ...snapshot.graph, edges: [] },
      plan: { executionBatches: [["a", "b", "c"]], roots: ["a", "b", "c"], terminals: ["a", "b", "c"], warnings: [] } };
    planningResponse.end(`event: complete\ndata: ${JSON.stringify({ snapshot })}\n\n`);
    await assertFitted(page, [["a", "b", "c"]]);
    assert.deepEqual(errors, []);
  } finally {
    clearInterval(textTimer); planningResponse?.destroy(); planningResponse = undefined;
    await context.close();
  }
});

const viewport = page => page.locator(".react-flow__viewport").evaluate(element => {
  const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
  return { x: matrix.e, y: matrix.f, zoom: matrix.a };
});

async function assertFitted(page, rows) {
  await page.evaluate(() => { window.lastFitSample = null; });
  await page.waitForFunction(rows => {
    const flow = document.querySelector(".graph-canvas .react-flow");
    if (!flow || +getComputedStyle(flow).opacity < 1 || +getComputedStyle(flow.closest(".graph-pane")).opacity < 0.99) return false;
    const elements = [...flow.querySelectorAll(".react-flow__node")];
    if (elements.length !== rows.flat().length || elements.some(node => !node.checkVisibility({ checkVisibilityCSS: true }))) return false;
    const rects = new Map(elements.map(node => [node.dataset.id, node.getBoundingClientRect()]));
    if (rows.flat().some(id => !rects.has(id))) return false;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].some(id => Math.abs(rects.get(id).top - rects.get(rows[i][0]).top) > 2)) return false;
      if (i && rects.get(rows[i][0]).top <= rects.get(rows[i - 1][0]).bottom) return false;
    }
    const bounds = [...rects.values()];
    const canvas = flow.getBoundingClientRect();
    const left = Math.min(...bounds.map(rect => rect.left)), right = Math.max(...bounds.map(rect => rect.right));
    const top = Math.min(...bounds.map(rect => rect.top)), bottom = Math.max(...bounds.map(rect => rect.bottom));
    if (left < canvas.left - 1 || right > canvas.right + 1 || top < canvas.top - 1 || bottom > canvas.bottom + 1 ||
        Math.abs((left + right - canvas.left - canvas.right) / 2) > 2 ||
        Math.abs((top + bottom - canvas.top - canvas.bottom) / 2) > 2) return false;
    const transform = getComputedStyle(flow.querySelector(".react-flow__viewport")).transform;
    if (window.lastFitSample?.transform !== transform) window.lastFitSample = { transform, since: performance.now() };
    return performance.now() - window.lastFitSample.since > 150;
  }, rows, { timeout: 10_000 });
  const automatic = await viewport(page);
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(100);
  const manual = await viewport(page);
  assert.ok(Math.abs(automatic.x - manual.x) < 1 && Math.abs(automatic.y - manual.y) < 1 && Math.abs(automatic.zoom - manual.zoom) < 0.001,
    `automatic fit matches the Fit View button: ${JSON.stringify({ automatic, manual })}`);
}

for (const reducedMotion of ["no-preference", "reduce"]) {
  test(`Planner layouts settle centered at Fit View scale (${reducedMotion})`, { timeout: 35_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    const errors = [];
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const result = command === "list_files" ? { files: [] } : command === "list_skills" ? { skills: [] } : null;
      if (result === null) errors.push(`Unexpected API: ${command}`);
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    const nodes = ["a", "b", "c", "d"].map((name, i) => ({ name, task: `Task ${name}. ` + "Unequal measured card content. ".repeat(i + 1) }));
    const graph = edges => ({ originalGoal: "Viewport regression", nodes, edges: edges.map(([from, to]) => ({ from, to, feedback: false })) });
    const update = (patch, planning) => page.evaluate(({ patch, planning }) => window.graphFixture.update(patch, planning), { patch, planning });
    try {
      await page.goto(`${origin}/__graph-planning`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => !!window.graphFixture);
      await page.locator(".graph-pane").waitFor({ state: "attached" });
      // The pane mounts before the first node tool result arrives.
      assert.equal(await page.locator(".react-flow__node").count(), 0);
      await update({ runId: "planned-run", graph: graph([]) }, true);
      await assertFitted(page, [["a", "b", "c", "d"]]);

      // Finish in the same update that changes the layout. Fitting must wait
      // for the row-to-column interpolation and the approval footer to settle.
      await update({ graph: graph([["a", "b"], ["b", "c"], ["c", "d"]]), phase: "awaiting_approval" }, false);
      await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
      await assertFitted(page, [["a"], ["b"], ["c"], ["d"]]);

      // Rewire with identical node/edge counts: count-only effects miss this.
      await update({ graph: graph([["a", "b"], ["a", "c"], ["b", "d"]]) }, true);
      await assertFitted(page, [["a"], ["b", "c"], ["d"]]);
      // No geometry change at completion, but the footer changes canvas height.
      await update({}, false);
      await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
      await assertFitted(page, [["a"], ["b", "c"], ["d"]]);

      await update({ graph: { ...graph([]), nodes: nodes.slice(0, 1) } }, true);
      await assertFitted(page, [["a"]]);
      await update({}, false);
      await assertFitted(page, [["a"]]);

      // Once fitted, status/log updates must not undo the user's own zoom.
      await page.locator(".react-flow__controls-zoomout").click();
      const userView = await viewport(page);
      await update({ nodes: { a: { status: "running", revision: 1, head: null, instruction: "", error: null } },
        events: [{ sequence: 1, timestamp: 1, type: "started", node: "a" }] }, false);
      await page.waitForTimeout(350);
      assert.deepEqual(await viewport(page), userView);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}
