// Capture the real UI with an approval-stage fixture, without a backend,
// credentials, model requests, or access to the user's runtime history.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const repository = "/demo/task-board";
const runId = "readme-demo";
const graph = {
  originalGoal: "Build a task board with a React UI and REST API. Define the shared contract, implement frontend and backend in parallel, then integrate and review the result.",
  nodes: [
    { name: "api_contract", task: "Define task types, REST endpoints, and acceptance criteria shared by the frontend and backend." },
    { name: "frontend", task: "Build the task board UI against the shared API contract. Add component tests for creating and completing tasks." },
    { name: "backend", task: "Implement the task API against the shared contract. Add tests for persistence, validation, and error responses." },
    { name: "integration", task: "Combine frontend and backend changes, connect the UI to the API, and run end-to-end tests. Own any integration fixes requested by review." },
    { name: "review", task: "Check the integrated task board against the acceptance criteria. Accept it or request bounded rework from the integration node." },
  ],
  edges: [
    { from: "api_contract", to: "frontend", feedback: false },
    { from: "api_contract", to: "backend", feedback: false },
    { from: "frontend", to: "integration", feedback: false },
    { from: "backend", to: "integration", feedback: false },
    { from: "integration", to: "review", feedback: false },
    { from: "review", to: "integration", feedback: true },
  ],
};
const config = {
  repository, model: "", thinkingLevel: "medium",
  maxParallel: 2, maxFeedback: 3, autoApprove: false,
};
const snapshot = {
  runId, planType: "graph", graph, config,
  plan: {
    executionBatches: [["api_contract"], ["frontend", "backend"], ["integration"], ["review"]],
    roots: ["api_contract"], terminals: ["review"], warnings: [],
  },
  nodes: Object.fromEntries(graph.nodes.map(({ name }) => [name, {
    status: "waiting", revision: 0, head: null, instruction: "", error: null,
  }])),
  executions: [], events: [], approved: false, paused: false,
  phase: "awaiting_approval", base: "", feedbackCounts: {},
};
const repositoryInfo = { path: repository, name: "task-board", branch: "main", head: "", clean: true };
const bootstrap = { snapshot, config, runs: [runId], dataPath: "/demo/.grapher", repositoryInfo };
const responses = {
  bootstrap,
  snapshot,
  history: snapshot,
  snapshot_if_changed: { version: "demo-v1", snapshot },
  repository_status: { repository, valid: true, error: null },
  detect_repository: repositoryInfo,
  list_plannings: [],
  list_files: { files: [] },
  list_skills: { skills: [] },
  provider_auth: { providers: [], models: [], warning: null },
};

const output = resolve("assets/execution-graph.png");
let server;
let browser;
try {
  server = await createServer({
    server: { host: "127.0.0.1", port: 0, open: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const channel = process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium");
  browser = await chromium.launch({ channel, headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 }, locale: "en-US",
    deviceScaleFactor: 1, reducedMotion: "reduce", serviceWorkers: "block",
  });
  await context.addInitScript(({ repository, runId, config, graph }) => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_projects", JSON.stringify([
      { id: repository, path: repository, name: "task-board", branch: "main", clean: true, lastOpened: 1 },
    ]));
    localStorage.setItem("grapher_workspace_runs", JSON.stringify({ [repository]: [runId] }));
    localStorage.setItem("grapher_run_labels", JSON.stringify({ [runId]: graph.originalGoal }));
    localStorage.setItem("grapher_config", JSON.stringify(config));
    localStorage.setItem("grapher_workbench_split_ratio", "0.4");
  }, { repository, runId, config, graph });

  const errors = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      errors.push(`Unexpected external request: ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const command = url.pathname.slice("/api/".length);
    if (!Object.hasOwn(responses, command)) {
      errors.push(`Unexpected API call: ${command}`);
      return route.fulfill({ status: 400, json: { error: `Unknown demo command: ${command}` } });
    }
    await route.fulfill({ json: { result: responses[command] } });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.locator(`button[data-run-id="${runId}"]`).click();
  await page.locator(".graph-pane .primary", { hasText: "Approve" }).waitFor();
  await page.waitForFunction((count) => {
    const nodes = [...document.querySelectorAll("[data-node-name]")];
    const flow = document.querySelector(".react-flow");
    return nodes.length === count && flow && getComputedStyle(flow).opacity === "1" &&
      nodes.every((node) => getComputedStyle(node).opacity === "1");
  }, graph.nodes.length);
  await page.evaluate(() => document.fonts.ready);
  // Wait for the real graph fit/entry transitions to finish before capturing.
  await page.waitForTimeout(1000);
  assert.equal(await page.locator(".react-flow__edge").count(), graph.edges.length);
  assert.equal(await page.locator('[role="alert"]').count(), 0);
  assert.deepEqual(errors, []);
  await mkdir(dirname(output), { recursive: true });
  await page.screenshot({ path: output, animations: "disabled" });
  console.log(`Captured ${output} (demo graph; no model execution).`);
} finally {
  await browser?.close();
  await server?.close();
}
