import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

test("graphs remain visible when repeatedly switching conversations", { timeout: 60_000 }, async () => {
  const repository = "/mock/project";
  const config = { repository, model: "test/model", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const makeSnapshot = (runId, names) => ({
    runId, config, planType: "graph", phase: "completed", approved: true, paused: false,
    graph: { originalGoal: `Goal ${runId}`, nodes: names.map(name => ({ name, task: `Task ${name}` })),
      edges: names.slice(1).map((name, index) => ({ from: names[index], to: name, relation: "dependency" })) },
    nodes: Object.fromEntries(names.map(name => [name, { status: "done" }])),
    plan: null, executions: [], events: [], base: "", feedbackCounts: {},
  });
  const snapshots = { a: makeSnapshot("a", ["shared", "alpha"]), b: makeSnapshot("b", ["shared", "beta", "gamma"]) };
  const empty = { ...makeSnapshot("", []), config: null, phase: "draft", approved: false };
  const repositoryInfo = { path: repository, name: "Project", branch: "main", head: "", clean: true };
  const errors = [];
  const server = await createServer({ cacheDir: "node_modules/.vite-graph-switching", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 768 } });
    await context.addInitScript(({ repository, config }) => {
      localStorage.setItem("grapher_language_v1", "en");
      localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Project", lastOpened: 1 }]));
      localStorage.setItem("grapher_config", JSON.stringify(config));
    }, { repository, config });
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap": case "save_config": result = { config, snapshot: empty, runs: ["a", "b"], repositoryInfo, dataPath: "/mock/.grapher" }; break;
        case "history": case "snapshot": result = snapshots[body.runId] || empty; break;
        case "snapshot_if_changed": result = { version: "1", snapshot: snapshots[body.runId] || null }; break;
        case "repository_status": result = { repository, valid: true, error: null }; break;
        case "detect_repository": result = repositoryInfo; break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = { providers: [], models: [], warning: null }; break;
        default: errors.push(`Unexpected API: ${command}`); result = null;
      }
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle" });
    const assertGraphVisible = async id => {
      await page.waitForFunction(id => {
        const flow = document.querySelector(".graph-canvas .react-flow");
        const names = [...document.querySelectorAll(".react-flow__node")].map(node => node.dataset.id);
        const expected = id === "a" ? ["shared", "alpha"] : ["shared", "beta", "gamma"];
        return flow && getComputedStyle(flow).opacity === "1" && names.length === expected.length && expected.every(name => names.includes(name));
      }, id, { timeout: 3_000 });
      const bounds = await page.locator(".react-flow__node").evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        const canvas = node.closest(".graph-canvas").getBoundingClientRect();
        return { name: node.dataset.id, rect: rect.toJSON(), canvas: canvas.toJSON(), visible: getComputedStyle(node).visibility !== "hidden", inside: rect.right > canvas.left && rect.left < canvas.right && rect.bottom > canvas.top && rect.top < canvas.bottom };
      }));
      assert.ok(bounds.every(node => node.visible && node.inside), `run ${id} must be fitted and visible: ${JSON.stringify(bounds)}`);
    };
    for (let index = 0; index < 60; index++) {
      const id = index % 2 ? "b" : "a";
      await page.locator(`[data-run-id="${id}"]`).click();
      await assertGraphVisible(id);
    }
    // Switch again before initialization/measurement callbacks can settle.
    for (let index = 0; index < 20; index++) {
      const id = index % 2 ? "b" : "a";
      await page.locator(`[data-run-id="${id}"]`).evaluate(card => card.click());
      await page.waitForTimeout(25);
    }
    await page.locator('[data-run-id="a"]').click();
    await assertGraphVisible("a");
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
