import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

test("graph background menu creates nodes with explicit completed-result confirmation", { timeout: 60_000 }, async () => {
  const repository = "/mock/project";
  const config = { repository, model: "test/model", thinkingLevel: "off", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const nodeState = (status = "completed") => ({ status, revision: 1, head: status === "completed" ? "head" : null, instruction: "", error: null });
  const empty = { runId: "", graph: { originalGoal: "", nodes: [], edges: [] }, config: null, nodes: {}, executions: [], events: [],
    approved: false, paused: false, phase: "draft", plan: null, base: "", feedbackCounts: {} };
  let snapshot = { ...empty, runId: "graph-a", planType: "graph", config, approved: true, phase: "completed",
    graph: { originalGoal: "Example", nodes: ["up", "target", "child"].map(name => ({ name, task: `Task ${name}` })),
      edges: [{ from: "up", to: "target", feedback: false }, { from: "target", to: "child", feedback: false }] },
    nodes: { up: nodeState(), target: nodeState(), child: nodeState() } };
  const repositoryInfo = { path: repository, name: "Project", branch: "main", head: "", clean: true };
  const requests = [];
  const errors = [];
  let reject = true;
  const server = await createServer({ cacheDir: "node_modules/.vite-manual-node", server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
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
        case "bootstrap": result = { config, snapshot: empty, runs: ["graph-a"], repositoryInfo, dataPath: "/mock/.grapher" }; break;
        case "history": case "snapshot": case "load_run": result = snapshot; break;
        case "snapshot_if_changed": result = { version: String(requests.length), snapshot }; break;
        case "repository_status": result = { repository, valid: true, error: null }; break;
        case "detect_repository": result = repositoryInfo; break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = { providers: [], models: [], warning: null }; break;
        case "add_manual_node": {
          requests.push(body);
          if (reject) {
            reject = false;
            await route.fulfill({ status: 409, json: { error: "Mock save failure" } });
            return;
          }
          const { node, from, to, feedback } = body.request;
          const edges = snapshot.graph.edges.filter(edge => feedback || !from || !to || edge.from !== from || edge.to !== to);
          if (from) edges.push({ from, to: node.name, feedback: false });
          if (to) edges.push({ from: node.name, to, feedback });
          snapshot = { ...snapshot, phase: "running", graph: { ...snapshot.graph, nodes: [...snapshot.graph.nodes, node], edges },
            nodes: { ...snapshot.nodes, [node.name]: nodeState("waiting") } };
          result = snapshot;
          break;
        }
        default: errors.push(`Unexpected API: ${command}`); result = null;
      }
      try { await route.fulfill({ json: { result } }); } catch { /* navigation may cancel polling */ }
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="graph-a"]').click();
    await page.locator('.react-flow__node[data-id="target"]').waitFor();
    await page.locator('.react-flow__node[data-id="target"]').click({ button: "right" });
    assert.equal(await page.locator(".context-menu").count(), 0, "node clicks do not open the background menu");
    const openMenu = async () => {
      await page.locator(".react-flow__pane").click({ button: "right", position: { x: 12, y: 12 } });
      await page.getByRole("menuitem", { name: "New node" }).waitFor();
      assert.equal(await page.locator(".context-menu").count(), 1);
    };
    await openMenu();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".context-menu").count(), 0);
    await openMenu();
    await page.locator('[data-run-id="graph-a"]').click({ button: "right" });
    assert.equal(await page.getByRole("menuitem", { name: "New node" }).count(), 0,
      "opening a sidebar menu closes the graph menu");
    assert.equal(await page.locator(".context-menu").count(), 1);
    await openMenu();
    assert.equal(await page.getByText("Copy prompt", { exact: true }).count(), 0,
      "opening the graph menu closes the sidebar menu");
    await page.getByRole("menuitem", { name: "New node" }).click();
    const form = page.locator(".create-node-form");
    assert.deepEqual(await form.locator("input, textarea, select").evaluateAll(elements =>
      elements.map(element => getComputedStyle(element).backgroundColor)), Array(5).fill("rgb(255, 255, 255)"),
    "node inputs and selects use a white background");
    await form.getByLabel("Name (name)").fill("inserted");
    await form.getByLabel("Task (task)").fill("Implement the new step");
    await form.getByLabel("Predecessor (from)").selectOption("up");
    await form.getByLabel("Target (to)").selectOption("target");
    assert.match(await form.innerText(), /replacing their direct dependency edge/);
    await form.getByRole("button", { name: "Save node" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /target, child/);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    assert.equal(requests.length, 0, "cancelling must not mutate the graph");
    await form.getByRole("button", { name: "Save node" }).click();
    await dialog.getByRole("button", { name: "Confirm and save" }).click();
    await page.getByRole("alert").filter({ hasText: "Mock save failure" }).waitFor();
    assert.equal(await form.getByLabel("Name (name)").inputValue(), "inserted", "failed saves retain the draft");
    await page.locator(".floating-error-close").click();
    await form.getByRole("button", { name: "Save node" }).click();
    await dialog.getByRole("button", { name: "Confirm and save" }).click();
    await page.locator('.react-flow__node[data-id="inserted"]').waitFor();
    await page.getByRole("heading", { name: "inserted" }).waitFor();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].runId, "graph-a");
    assert.deepEqual(requests[1].request, { node: { name: "inserted", task: "Implement the new step" },
      from: "up", to: "target", feedback: false,
      confirmedCompleted: [{ name: "target", revision: 1, head: "head" }, { name: "child", revision: 1, head: "head" }] });

    await openMenu();
    await page.getByRole("menuitem", { name: "New node" }).click();
    await form.getByLabel("Name (name)").fill("review");
    await form.getByLabel("Task (task)").fill("Review the result");
    await form.getByLabel("Predecessor (from)").selectOption("up");
    await form.getByLabel("Target (to)").selectOption("child");
    await form.getByLabel("feedback").selectOption("true");
    await form.getByRole("button", { name: "Save node" }).click();
    assert.match(await form.getByRole("alert").innerText(), /feedback target must be the predecessor/i);
    assert.equal(requests.length, 2, "invalid feedback is not submitted");
    await form.getByLabel("Target (to)").selectOption("up");
    await form.getByRole("button", { name: "Save node" }).click();
    assert.match(await dialog.innerText(), /may run again/);
    await dialog.getByRole("button", { name: "Confirm and save" }).click();
    await page.locator('.react-flow__node[data-id="review"]').waitFor();
    assert.equal(requests[2].request.feedback, true);

    await openMenu();
    await page.getByRole("menuitem", { name: "New node" }).click();
    await form.getByLabel("Name (name)").fill("independent");
    await form.getByLabel("Task (task)").fill("Independent work");
    await form.getByRole("button", { name: "Save node" }).click();
    await page.locator('.react-flow__node[data-id="independent"]').waitFor();
    assert.equal(await dialog.count(), 0, "an independent node does not require confirmation");
    assert.equal(requests[3].request.to, null);
    assert.deepEqual(requests[3].request.confirmedCompleted, []);

    snapshot = { ...snapshot, phase: "launching_result" };
    await page.waitForFunction(() => document.querySelector(".progress-label")?.textContent?.includes("launching_result"));
    await openMenu();
    assert.equal(await page.getByRole("menuitem", { name: "New node" }).isDisabled(), true,
      "a running published result must finish before a node can be added");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
