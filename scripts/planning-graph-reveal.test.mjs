import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const planner = event => sse("planner", { event });
const toolStart = (id, toolName, args) => planner({ type: "tool_execution_start", toolCallId: id, toolName, args });
const toolEnd = (id, toolName, text) => planner({
  type: "tool_execution_end", toolCallId: id, toolName,
  result: { content: [{ type: "text", text }] }, isError: false,
});

let server, browser, origin;
let onPlanStream = () => {};

test.before(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-planning-graph-reveal",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null },
    plugins: [{
      name: "planning-graph-reveal-fixture",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/api/plan_goal_stream") return next();
          let body = "";
          for await (const chunk of req) body += chunk;
          const parsed = JSON.parse(body);
          onPlanStream(parsed, res);
          return;
        });
      },
    }],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});

test.after(async () => {
  await browser?.close();
  await server.close();
});

async function newPage(contextInit, initArg, handler) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "no-preference" });
  await context.addInitScript(contextInit, initArg);
  const errors = [];
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    if (command === "plan_goal_stream") return route.continue();
    const result = handler(command, route.request().postDataJSON(), errors);
    await route.fulfill({ json: { result } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(String(error)));
  return { context, page, errors };
}

const assertVisibleNodes = async (page, expected) => {
  await page.waitForFunction(expected => {
    const nodes = [...document.querySelectorAll(".graph-canvas .react-flow__node")];
    const names = nodes.map(node => node.dataset.id).sort();
    return JSON.stringify(names) === JSON.stringify(expected) && nodes.every(node => {
      const rect = node.getBoundingClientRect();
      const canvas = node.closest(".graph-canvas").getBoundingClientRect();
      return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
        rect.right > canvas.left && rect.left < canvas.right && rect.bottom > canvas.top && rect.top < canvas.bottom;
    });
  }, expected);
};

/** The topology pane must appear while the Planner is still streaming node
 * tools, without waiting for the whole Planner output or the final snapshot.
 * Durable snapshot polls (which re-deliver the empty/old committed graph after
 * every backend event) must not clobber that live draft topology. */
test("graph topology appears during live Planner node tool streaming", { timeout: 90_000 }, async () => {
  const repository = "/mock/project";
  const config = { repository, model: "test/model", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const empty = {
    runId: "", config: null, planType: "", phase: "draft", approved: false, paused: false,
    graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {}, plan: null,
    executions: [], events: [], base: "", feedbackCounts: {},
  };
  const repositoryInfo = { path: repository, name: "Project", branch: "main", head: "", clean: true };

  let streamRes = null;
  const pending = [];
  let polls = 0;

  onPlanStream = (_body, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    streamRes = res;
    res.write(sse("run_started", { runId: "live-run" }));
    res.write(sse("route_decision", { planType: "graph" }));
    while (pending.length) res.write(pending.shift());
  };

  const emit = chunk => {
    if (streamRes) streamRes.write(chunk);
    else pending.push(chunk);
  };

  const { context, page, errors } = await newPage(
    ({ repository, config }) => {
      localStorage.setItem("grapher_language_v1", "en");
      localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Project", lastOpened: 1 }]));
      localStorage.setItem("grapher_config", JSON.stringify(config));
    },
    { repository, config },
    (command) => {
      switch (command) {
        case "bootstrap": case "save_config": return { config, snapshot: empty, runs: [], repositoryInfo, dataPath: "/mock/.grapher" };
        case "snapshot_if_changed": {
          polls += 1;
          return {
            version: `v${polls}`,
            snapshot: {
              ...empty, runId: "live-run", config, planType: "graph", phase: "planning",
              graph: { originalGoal: "Build a two node topology", nodes: [], edges: [] }, nodes: {},
              events: [{ type: "routed", sequence: polls }],
            },
          };
        }
        case "history": case "snapshot": return empty;
        case "repository_status": return { repository, valid: true, error: null };
        case "detect_repository": return repositoryInfo;
        case "list_plannings": return [];
        case "list_files": return { files: [] };
        case "list_skills": return { skills: [] };
        case "provider_auth": return { providers: [], models: [], warning: null };
        case "pi_extensions": return { globalDirectory: "mock", extensions: [] };
        case "environment_capabilities": return { platform: "windows", arch: "x86_64", nativeWorkspace: true };
        default: errors.push(`Unexpected API: ${command}`); return null;
      }
    }
  );

  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator(".landing-screen textarea").fill("Build a two node topology");
    await page.locator(".landing-screen textarea").press("Enter");
    await page.locator(".conversation-pane").waitFor({ state: "visible" });

    // Auto mode runs the Partitioner before the route decision.
    emit(sse("partitioner", { event: { type: "message_start", message: { role: "assistant", content: [] } } }));
    emit(sse("partitioner", { event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Considering the route." } } }));
    emit(sse("partitioner", { event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "graph" } } }));
    emit(sse("partitioner", { event: { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "graph" }] } } }));
    emit(sse("route_decision", { planType: "graph" }));
    emit(planner({ type: "message_start", message: { role: "assistant", content: [] } }));
    emit(planner({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Designing the topology now." } }));

    // The first successful node tool must reveal the pane before anything else arrives.
    emit(toolStart("tool-node-1", "node", { nodes: [{ name: "alpha", task: "Do alpha" }, { name: "beta", task: "Do beta" }] }));
    emit(toolEnd("tool-node-1", "node", JSON.stringify({ applied: true, plan: { executionBatches: [["alpha"], ["beta"]] } })));

    // Core regression: the topology is visible while the stream is still open
    // and durable polls keep re-delivering the committed empty graph.
    await page.locator(".graph-pane").waitFor({ state: "visible" });
    await assertVisibleNodes(page, ["alpha", "beta"]);

    // A later edge tool keeps updating the live topology.
    emit(toolStart("tool-edge-1", "edge", { edges: [{ from: "alpha", to: "beta" }] }));
    emit(toolEnd("tool-edge-1", "edge", "{\"applied\":true}"));
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".graph-canvas .react-flow__edge")].some(edge =>
        edge.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })));
    await assertVisibleNodes(page, ["alpha", "beta"]);

    // Settling the Planner keeps the already revealed topology in place.
    const snapshot = {
      ...empty, runId: "live-run", config, planType: "graph", phase: "awaiting_approval", approved: false, paused: false,
      graph: {
        originalGoal: "Build a two node topology",
        nodes: [{ name: "alpha", task: "Do alpha" }, { name: "beta", task: "Do beta" }],
        edges: [{ from: "alpha", to: "beta", feedback: false }],
      },
      nodes: { alpha: { status: "waiting" }, beta: { status: "waiting" } },
    };
    emit(planner({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Planned." }] } }));
    emit(sse("complete", { snapshot }));
    await page.locator(".graph-bottom").waitFor({ state: "visible" });
    await assertVisibleNodes(page, ["alpha", "beta"]);
    assert.deepEqual(errors, []);
  } finally {
    streamRes?.destroy();
    await context.close();
  }
});

/** A graph revision on an existing (not yet approved) Run streams its node
 * tools into the already visible topology; durable polls returning the old
 * committed graph must not wipe the live revision draft. */
test("graph revision streams node tools without durable poll clobbering", { timeout: 90_000 }, async () => {
  const repository = "/mock/project";
  const config = { repository, model: "test/model", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const durable = {
    runId: "rev-run", config, planType: "graph", phase: "awaiting_approval", approved: false, paused: false,
    graph: { originalGoal: "Original goal", nodes: [{ name: "existing", task: "Existing task" }], edges: [] },
    nodes: { existing: { status: "waiting" } },
    plan: { executionBatches: [["existing"]], terminals: ["existing"] },
    executions: [], events: [], base: "", feedbackCounts: {},
  };
  const repositoryInfo = { path: repository, name: "Project", branch: "main", head: "", clean: true };

  let streamRes = null;
  const pending = [];
  let polls = 0;
  let receivedPlanRequest = null;

  onPlanStream = (body, res) => {
    receivedPlanRequest = body;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    streamRes = res;
    res.write(sse("run_started", { runId: "rev-run" }));
    res.write(sse("route_decision", { planType: "graph" }));
    while (pending.length) res.write(pending.shift());
  };

  const emit = chunk => {
    if (streamRes) streamRes.write(chunk);
    else pending.push(chunk);
  };

  const { context, page, errors } = await newPage(
    ({ repository, config }) => {
      localStorage.setItem("grapher_language_v1", "en");
      localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Project", lastOpened: 1 }]));
      localStorage.setItem("grapher_workspace_runs", JSON.stringify({ [repository]: ["rev-run"] }));
      localStorage.setItem("grapher_config", JSON.stringify(config));
    },
    { repository, config },
    (command) => {
      switch (command) {
        case "bootstrap": case "save_config": return { config, snapshot: durable, runs: ["rev-run"], repositoryInfo, dataPath: "/mock/.grapher" };
        case "snapshot_if_changed": {
          polls += 1;
          // The durable graph stays the OLD committed graph until the revision
          // lands; every backend event re-delivers it with a new version.
          return { version: `v${polls}`, snapshot: { ...durable, events: [{ type: "routed", sequence: polls }] } };
        }
        case "history": case "snapshot": return durable;
        case "repository_status": return { repository, valid: true, error: null };
        case "detect_repository": return repositoryInfo;
        case "list_plannings": return [];
        case "list_files": return { files: [] };
        case "list_skills": return { skills: [] };
        case "provider_auth": return { providers: [], models: [], warning: null };
        case "pi_extensions": return { globalDirectory: "mock", extensions: [] };
        case "environment_capabilities": return { platform: "windows", arch: "x86_64", nativeWorkspace: true };
        default: errors.push(`Unexpected API: ${command}`); return null;
      }
    }
  );

  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="rev-run"]').click();
    await page.locator(".graph-bottom").waitFor({ state: "visible" });
    await assertVisibleNodes(page, ["existing"]);

    await page.locator(".pane-bottom-chat textarea").fill("Add another workstream node");
    await page.locator(".pane-bottom-chat textarea").press("Enter");

    for (let i = 0; i < 50 && !receivedPlanRequest; i++) await page.waitForTimeout(50);
    assert.ok(receivedPlanRequest, "the revision request reached the stream endpoint");
    assert.equal(receivedPlanRequest.revisionRunId, "rev-run");

    emit(planner({ type: "message_start", message: { role: "assistant", content: [] } }));
    emit(toolStart("rev-node-1", "node", { nodes: [{ name: "gamma", task: "Do gamma" }] }));
    emit(toolEnd("rev-node-1", "node", JSON.stringify({ applied: true, plan: { executionBatches: [["existing"], ["gamma"]] } })));

    // The streamed node must join the topology while the revision is still
    // open, despite durable polls re-delivering the old committed graph.
    await assertVisibleNodes(page, ["existing", "gamma"]);

    // Settling the revision commits the new graph.
    const committed = {
      ...durable, phase: "awaiting_approval",
      graph: {
        originalGoal: "Original goal",
        nodes: [{ name: "existing", task: "Existing task" }, { name: "gamma", task: "Do gamma" }],
        edges: [],
      },
      nodes: { existing: { status: "waiting" }, gamma: { status: "waiting" } },
      plan: { executionBatches: [["existing"], ["gamma"]], terminals: ["gamma"] },
    };
    emit(sse("complete", { snapshot: committed }));
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".graph-canvas .react-flow__node")].length === 2);
    await assertVisibleNodes(page, ["existing", "gamma"]);
    assert.deepEqual(errors, []);
  } finally {
    streamRes?.destroy();
    await context.close();
  }
});
