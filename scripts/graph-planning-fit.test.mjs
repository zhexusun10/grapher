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
  let snapshot = empty, textTimer, allowSnapshotPoll = true;
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
      case "snapshot_if_changed": result = { version: snapshot.phase, snapshot: allowSnapshotPoll && snapshot.runId ? snapshot : null }; break;
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
  const endTool = (id, toolName, topology, isError = false, legacy = false, rootField = "rootNodes") => {
    const projection = legacy ? topology : {
      ...(rootField ? { [rootField]: topology.nodes.filter(name => !topology.edges.some(edge => !edge.feedback && edge.to === name)) } : {}),
      ...(rootField === "roots" ? {
        directDependencies: Object.fromEntries(topology.nodes.map(name => [name,
          topology.edges.filter(edge => !edge.feedback && edge.to === name).map(edge => edge.from)])),
      } : {
        "from: [to]": Object.fromEntries(topology.nodes.map(name => [name,
          topology.edges.filter(edge => !edge.feedback && edge.from === name).map(edge => edge.to)])),
      }),
      feedbackTo: Object.fromEntries(topology.edges.filter(edge => edge.feedback).map(edge => [edge.from, edge.to])),
    };
    planner({ type: "tool_execution_end", toolCallId: id, toolName, isError,
      result: { content: [{ type: "text", text: JSON.stringify({ applied: !isError, topology: projection }) }] } });
  };
  const tool = (id, toolName, args, topology, isError = false, legacy = false, rootField = "rootNodes") => {
    startTool(id, toolName, args);
    endTool(id, toolName, topology, isError, legacy, rootField);
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

    // A rejected first mutation must not open an empty topology pane.
    // Older transcript events retain the previous topology shape.
    tool("rejected-first", "node", { nodes: [{ name: "ghost", task: "Invalid edit" }] }, { nodes: [], edges: [] }, true, true);
    await page.locator(".tool-call-card.error").first().waitFor();
    assert.equal(await page.locator(".graph-pane").count(), 0, "a failed node call does not open the pane");

    startTool("node-a", "node", { nodes: nodes.slice(0, 1) });
    // Only an accepted mutation opens the pane; a pending node call would
    // otherwise show an empty topology that may still fail validation.
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".graph-pane").count(), 0, "a pending node call does not open the pane");
    // The initial node batch omits rootNodes; its accepted edit still opens the preview.
    endTool("node-a", "node", { nodes: ["a"], edges: [] }, false, false, null);
    await page.waitForFunction(() => {
      const pane = document.querySelector(".graph-pane");
      return pane && +getComputedStyle(pane).opacity > 0.99;
    });
    await assertFitted(page, [["a"]]);
    // Historical direct-dependency results used `roots` rather than `rootNodes`.
    tool("node-bc", "node", { nodes: nodes.slice(1) }, { nodes: ["a", "b", "c"], edges: [] }, false, false, "roots");
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
      plan: { executionBatches: [["a"], ["b"], ["c"]], rootNodes: ["a"], terminals: ["c"], warnings: [] } };
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
      plan: { executionBatches: [["a", "b", "c"]], rootNodes: ["a", "b", "c"], terminals: ["a", "b", "c"], warnings: [] } };
    planningResponse.end(`event: complete\ndata: ${JSON.stringify({ snapshot })}\n\n`);
    await assertFitted(page, [["a", "b", "c"]]);

    // A revision of an approved graph that is not executing must preview its
    // cards while the Planner stream is still open. Holding the whole approved
    // graph until completion hides accepted node edits for the entire turn.
    snapshot = { ...snapshot, approved: true, phase: "completed" };
    await page.waitForFunction(() => {
      const labels = [...document.querySelectorAll("button")].map(button => button.textContent?.trim());
      return labels.includes("Pause") && !labels.includes("Approve");
    });
    // Only the explicit post-failure read may restore the graph; a durable poll
    // with an unchanged version must not be able to mask a lingering preview.
    allowSnapshotPoll = false;
    planningResponse = undefined;
    await followUp.fill("Add a verification node"); await followUp.press("Enter");
    for (let i = 0; !planningResponse && i < 100; i++) await page.waitForTimeout(20);
    assert.ok(planningResponse, "approved revision stream started");
    send("run_started", { runId });
    tool("add-d", "node", { nodes: { name: "d", task: "Task d" } },
      { nodes: ["a", "b", "c", "d"], edges: [] });
    await assertFitted(page, [["a", "b", "c", "d"]]);
    assert.equal(planningResponse.writableEnded, false, "approved revision previews before Planner completion");
    // Work can start after the turn's snapshot: once the run is live, further
    // tool results must not replace the committed topology.
    snapshot = { ...snapshot, phase: "running",
      nodes: { ...snapshot.nodes, a: { ...snapshot.nodes.a, status: "running" } } };
    const livePoll = page.waitForResponse(async response => {
      if (!response.url().endsWith("/snapshot_if_changed")) return false;
      try { return !!(await response.json()).result?.snapshot; } catch { return false; }
    });
    allowSnapshotPoll = true;
    await livePoll;
    await page.waitForTimeout(100);
    allowSnapshotPoll = false;
    tool("add-e", "node", { nodes: { name: "e", task: "Task e" } },
      { nodes: ["a", "b", "c", "e"], edges: [] });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.react-flow__node[data-id="e"]').count(), 0,
      "a revision must not preview over work that started after it began");
    // A failed approved revision never commits: replace the preview with the
    // durable graph instead of leaving it until an unrelated snapshot changes.
    planningResponse.end(`event: error\ndata: ${JSON.stringify({ error: "Revision rejected" })}\n\n`);
    await page.waitForFunction(() => !document.querySelector('.react-flow__node[data-id="d"]'));
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

async function waitForSettledGraph(page, count) {
  await page.evaluate(() => { window.lastGraphSample = null; });
  await page.waitForFunction(count => {
    const flow = document.querySelector(".graph-canvas .react-flow");
    const nodes = [...(flow?.querySelectorAll(".react-flow__node") ?? [])];
    if (!flow || +getComputedStyle(flow).opacity < 1 || nodes.length !== count ||
        nodes.some(node => !node.checkVisibility({ checkVisibilityCSS: true }))) return false;
    const sample = JSON.stringify([getComputedStyle(flow.querySelector(".react-flow__viewport")).transform,
      ...nodes.map(node => node.getBoundingClientRect().toJSON())]);
    if (window.lastGraphSample?.sample !== sample) window.lastGraphSample = { sample, since: performance.now() };
    return performance.now() - window.lastGraphSample.since > 200;
  }, count, { timeout: 10_000 });
}

async function assertFocused(page, ids) {
  await page.waitForFunction(ids => {
    const flow = document.querySelector(".graph-canvas .react-flow");
    const nodes = ids.map(id => flow?.querySelector(`.react-flow__node[data-id="${id}"]`));
    if (!flow || nodes.some(node => !node)) return false;
    const canvas = flow.getBoundingClientRect(), rects = nodes.map(node => node.getBoundingClientRect());
    const left = Math.min(...rects.map(rect => rect.left)), right = Math.max(...rects.map(rect => rect.right));
    const top = Math.min(...rects.map(rect => rect.top)), bottom = Math.max(...rects.map(rect => rect.bottom));
    return left >= canvas.left - 1 && right <= canvas.right + 1 && top >= canvas.top - 1 && bottom <= canvas.bottom + 1 &&
      Math.abs((left + right - canvas.left - canvas.right) / 2) < 2 &&
      Math.abs((top + bottom - canvas.top - canvas.bottom) / 2) < 2;
  }, ids, { timeout: 5000 });
  assert.ok(Math.abs((await viewport(page)).zoom - 0.3) < 0.001, "large graphs retain the whole-graph minimum zoom");
}

function assertSameViewport(actual, expected) {
  assert.ok(Math.abs(actual.x - expected.x) < 1 && Math.abs(actual.y - expected.y) < 1 && Math.abs(actual.zoom - expected.zoom) < 0.001,
    `expected the same viewport: ${JSON.stringify({ actual, expected })}`);
}

test("Fit View prioritizes current running cards only when the graph cannot fit", { timeout: 35_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
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
  const update = patch => page.evaluate(patch => window.graphFixture.update(patch, false), patch);
  const state = status => ({ status, revision: 1, head: null, instruction: "", error: null });
  const fit = () => page.getByRole("button", { name: "Fit View", exact: true }).click();
  const nodes = Array.from({ length: 24 }, (_, i) => ({ name: `n${i}`, task: `Task ${i}` }));
  const graph = edges => ({ originalGoal: "Large viewport regression", nodes, edges });
  try {
    await page.goto(`${origin}/__graph-planning`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!window.graphFixture);
    await update({ runId: "horizontal-fit", phase: "running", approved: true, graph: graph([]), nodes: {} });
    await waitForSettledGraph(page, 24);
    await fit(); await page.waitForTimeout(100);
    const wholeGraph = await viewport(page);

    // A status update alone does not recenter; an explicit fit uses the latest status.
    await update({ nodes: { n23: state("running") } });
    await page.locator('.react-flow__node[data-id="n23"] .task-node.running').waitFor();
    await page.waitForTimeout(250);
    assertSameViewport(await viewport(page), wholeGraph);
    await fit();
    await assertFocused(page, ["n23"]);

    // A distant running card must not make the camera center on empty space;
    // favor the two nearby cards instead of the first isolated one.
    const previous = await viewport(page);
    await update({ nodes: { n1: state("running"), n22: state("running"), n23: state("running") } });
    await page.locator('.react-flow__node[data-id="n1"] .task-node.running').waitFor();
    await page.waitForTimeout(200);
    assertSameViewport(await viewport(page), previous);
    await fit();
    await assertFocused(page, ["n22", "n23"]);

    await update({ nodes: { n1: state("running"), n22: state("completed"), n23: state("completed") } });
    await page.locator('.react-flow__node[data-id="n23"] .task-node.completed').waitFor();
    await page.getByRole("button", { name: "Fit View", exact: true }).press("Enter");
    await assertFocused(page, ["n1"]);
    await update({ nodes: { n1: state("completed") } });
    await page.locator('.react-flow__node[data-id="n1"] .task-node.completed').waitFor();
    await fit(); await page.waitForTimeout(100);
    assertSameViewport(await viewport(page), wholeGraph);

    // Repeat with vertical overflow and an independently running publication Merger.
    const edges = nodes.slice(1).map((node, i) => ({ from: nodes[i].name, to: node.name, feedback: false }));
    await update({ runId: "vertical-fit", graph: graph(edges), nodes: { n23: state("running") } });
    await waitForSettledGraph(page, 24);
    await fit(); await assertFocused(page, ["n23"]);
    await page.setViewportSize({ width: 1000, height: 650 });
    await waitForSettledGraph(page, 24);
    await fit(); await assertFocused(page, ["n23"]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await waitForSettledGraph(page, 24);
    await update({ nodes: {}, mergers: [{ id: "publish", node: "merger", revision: 1, attempt: 1, sessionId: "publish",
      worktree: "/mock", before: "", after: null, status: "running", output: "", startedAt: 1, completedAt: null }] });
    await waitForSettledGraph(page, 25);
    await fit(); await assertFocused(page, ["merger:publication"]);

    // If everything fits, a running card must not replace the ordinary full-graph fit.
    const small = nodes.slice(0, 3);
    await update({ runId: "small-fit", graph: { ...graph([]), nodes: small }, mergers: [], nodes: { n2: state("running") } });
    await assertFitted(page, [["n0", "n1", "n2"]]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("manual Fit View follows running cards through an ongoing layout animation", { timeout: 20_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });
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
  const nodes = Array.from({ length: 16 }, (_, i) => ({ name: `a${i}`, task: `Task ${i}` }));
  const edges = nodes.slice(1).map((node, i) => ({ from: nodes[i].name, to: node.name, feedback: false }));
  try {
    await page.goto(`${origin}/__graph-planning`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!window.graphFixture);
    await page.evaluate(nodes => window.graphFixture.update({ runId: "animated-fit", phase: "running", approved: true,
      graph: { originalGoal: "Animated fit", nodes, edges: [] }, nodes: { a15: { status: "running" } } }, false), nodes);
    await waitForSettledGraph(page, nodes.length);
    const movingNode = page.locator('.react-flow__node[data-id="a15"]');
    const start = await movingNode.getAttribute("style");
    await page.evaluate(({ nodes, edges }) => window.graphFixture.update({ graph: { originalGoal: "Animated fit", nodes, edges } }, false), { nodes, edges });
    await page.waitForFunction(start => document.querySelector('.react-flow__node[data-id="a15"]')?.getAttribute("style") !== start, start);
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    const position = await movingNode.getAttribute("style");
    await page.waitForTimeout(180);
    assert.notEqual(await movingNode.getAttribute("style"), position, "nodes continue moving after the manual fit");
    await waitForSettledGraph(page, nodes.length);
    await assertFocused(page, ["a15"]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("graph splitter preserves ordinary resizing, cancellation, keyboard control and reset", { timeout: 20_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_workbench_split_ratio", "0.55");
  });
  const errors = [];
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const result = command === "list_files" ? { files: [] } : command === "list_skills" ? { skills: [] } : null;
    if (result === null) errors.push(`Unexpected API: ${command}`);
    await route.fulfill({ json: { result } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/__graph-planning`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!window.graphFixture);
    await page.evaluate(() => window.graphFixture.update({ phase: "awaiting_approval",
      graph: { originalGoal: "Resize regression", nodes: [{ name: "worker", task: "Task" }], edges: [] } }, false));
    const splitter = page.getByRole("separator", { name: "Resize execution graph", exact: true });
    await splitter.waitFor();
    const savedRatio = () => page.evaluate(() => Number(localStorage.getItem("grapher_workbench_split_ratio")));
    const beginDrag = async delta => {
      await splitter.evaluate(element => element.addEventListener("pointerdown", event => { window.resizePointerId = event.pointerId; }, { once: true }));
      const bounds = await splitter.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + delta, bounds.y + bounds.height / 2, { steps: 4 });
    };
    await beginDrag(-64);
    await page.mouse.up();
    const resized = await savedRatio();
    assert.ok(resized < 0.55 && resized > 0.3, "ordinary drags still resize and persist the split");
    assert.equal(await page.locator(".workbench.resizing").count(), 0);

    await beginDrag(-48);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: window.resizePointerId })));
    await page.mouse.up();
    assert.equal(await savedRatio(), resized, "a cancelled gesture must not overwrite the saved width");
    assert.ok(await page.locator(".workbench").evaluate((element, ratio) =>
      Math.abs(Number(element.style.getPropertyValue("--workbench-split-ratio")) - ratio) < 0.0001, resized));
    assert.equal(await page.locator(".workbench.resizing").count(), 0);

    await beginDrag(-24);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.mouse.up();
    const blurred = await savedRatio();
    assert.ok(blurred < resized, "leaving the window ends and saves a normal resize");
    assert.equal(await page.locator(".workbench.resizing").count(), 0);

    await splitter.press("ArrowRight");
    assert.ok(await savedRatio() > blurred, "keyboard arrows adjust the split without dragging");
    await splitter.press("End");
    const maximum = await savedRatio();
    assert.equal(await page.locator(".workbench.graph-collapsed").count(), 0, "keyboard resizing to the minimum graph width does not hide it");
    await splitter.press("Home");
    assert.ok(await savedRatio() < maximum);
    await splitter.dblclick();
    assert.equal(await savedRatio(), 0.6, "double-click still restores the default split");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

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
      const edgeArrows = await page.evaluate(() => {
        const markerIds = new Set([...document.querySelectorAll("marker[id]")].map(m => m.id));
        const paths = [...document.querySelectorAll(".react-flow__edge-path")].map(p => p.getAttribute("marker-end"));
        const visibleTargets = [...document.querySelectorAll(".react-flow__handle.target")]
          .filter(h => getComputedStyle(h).opacity !== "0").length;
        return { markerIds: [...markerIds], paths, visibleTargets };
      });
      assert.equal(edgeArrows.paths.length, 3);
      for (const markerEnd of edgeArrows.paths) {
        const match = /^url\('#?([^')]+)'?\)$/.exec(markerEnd ?? "");
        assert.ok(match && edgeArrows.markerIds.includes(match[1]),
          `edge markerEnd must reference a defined <marker> id, got: ${markerEnd}`);
      }
      assert.equal(edgeArrows.visibleTargets, 0, "target handles stay hidden so they never cover edge arrowheads");
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
