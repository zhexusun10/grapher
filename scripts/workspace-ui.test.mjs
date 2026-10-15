import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

// Mocked API only: no backend, credentials, or real workspace files are touched.
test("workspace isolation, accessible home and delayed planning ownership", { timeout: 120_000 }, async () => {
  const repositoryA = "C:\\Projects\\Alpha";
  const repositoryB = "C:\\Projects\\Beta";
  const config = { repository: repositoryA, model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const makeSnapshot = (runId, repository, goal) => ({
    runId, config: { ...config, repository }, planType: "graph",
    graph: { originalGoal: goal, nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false,
    phase: "completed", base: "", feedbackCounts: {},
  });
  const snapshots = {
    "run-a": makeSnapshot("run-a", "\\\\?\\C:\\Projects\\Alpha", "Alpha conversation"),
    "run-b": makeSnapshot("run-b", repositoryB, "Beta conversation"),
    "new-a": makeSnapshot("new-a", repositoryA, "Detached Alpha conversation"),
  };
  const empty = { ...makeSnapshot("", repositoryA, ""), config: null, phase: "draft" };
  const info = repository => ({ path: repository, name: repository.includes("Beta") ? "Beta" : "Alpha", branch: "main", head: "", clean: true });
  const bootstrap = { config, snapshot: empty, runs: ["run-a", "run-b"], repositoryInfo: info(repositoryA), dataPath: "/mock/.grapher" };
  const errors = [];
  let releasePlanning;
  let planningRequested = false;
  const planningGate = new Promise(resolve => { releasePlanning = resolve; });
  const server = await createServer({ cacheDir: "node_modules/.vite-workspace-ui", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false } });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 768 }, locale: "en-US", reducedMotion: "no-preference" });
    await context.addInitScript(({ repositoryA, repositoryB, config }) => {
      localStorage.setItem("grapher_language_v1", "en");
      localStorage.setItem("grapher_projects", JSON.stringify([
        { id: repositoryA, path: repositoryA, name: "Alpha", branch: "main", clean: true, lastOpened: 2 },
        { id: repositoryB, path: repositoryB, name: "Beta", branch: "main", clean: true, lastOpened: 1 },
      ]));
      // Reproduce old cross-workspace pollution and a Windows path alias.
      localStorage.setItem("grapher_workspace_runs", JSON.stringify({
        [repositoryA]: ["run-a", "run-b", "pending-stale"],
        [repositoryB]: ["run-b", "run-a"],
        "\\\\?\\C:\\Projects\\Alpha": ["run-a"],
      }));
      localStorage.setItem("grapher_run_labels", JSON.stringify({ "run-a": "Alpha conversation", "run-b": "Beta conversation" }));
      localStorage.setItem("grapher_config", JSON.stringify(config));
    }, { repositoryA, repositoryB, config });
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap": case "save_config": result = bootstrap; break;
        case "history": case "snapshot": result = snapshots[body.runId] || empty; break;
        case "snapshot_if_changed": result = { version: "mock-1", snapshot: snapshots[body.runId] || null }; break;
        case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
        case "detect_repository":
          await new Promise(resolve => setTimeout(resolve, 120));
          result = info(body.path || body.repository); break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = { providers: [{ id: "test", name: "Test", methods: [], configured: true }], models: [], warning: null }; break;
        case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
        case "environment_capabilities": result = { platform: "windows", arch: "x86_64", nativeWorkspace: true }; break;
        case "plan_goal_stream":
          assert.equal(body.config.repository, repositoryA);
          planningRequested = true;
          await planningGate;
          await route.fulfill({ contentType: "text/event-stream", body:
            `event: run_started\ndata: ${JSON.stringify({ runId: "new-a" })}\n\nevent: complete\ndata: ${JSON.stringify({ snapshot: snapshots["new-a"] })}\n\n` });
          return;
        default:
          errors.push(`Unexpected API: ${command}`);
          return route.fulfill({ status: 400, json: { error: `Unexpected API: ${command}` } });
      }
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.waitForFunction(() => {
      const index = JSON.parse(localStorage.getItem("grapher_workspace_runs"));
      return index["c:/projects/alpha"]?.join() === "run-a" && index["c:/projects/beta"]?.join() === "run-b";
    });
    assert.deepEqual(await page.locator(".runs-list [data-run-id]").evaluateAll(cards => cards.map(card => card.dataset.runId)), ["run-a"]);

    // Home is viewport-bound even on shorter screens; wheel must not move it.
    for (const height of [900, 768, 480, 360]) {
      await page.setViewportSize({ width: 1280, height });
      await page.locator(".landing-screen").waitFor();
      const metrics = await page.evaluate(() => {
        const home = document.querySelector(".landing-screen");
        const prompt = home.querySelector(".prompt-box-container").getBoundingClientRect();
        return { overflow: getComputedStyle(home).overflowY, homeHeight: home.clientHeight, homeScrollHeight: home.scrollHeight,
          documentHeight: document.documentElement.scrollHeight, viewport: innerHeight, promptTop: prompt.top, promptBottom: prompt.bottom };
      });
      assert.equal(metrics.overflow, "hidden");
      assert.equal(metrics.homeHeight, metrics.homeScrollHeight);
      assert.equal(metrics.documentHeight, metrics.viewport);
      assert.ok(metrics.promptTop >= 0 && metrics.promptBottom <= height, "composer remains visible");
      await page.mouse.move(1200, 100);
      await page.mouse.wheel(0, 600);
      assert.equal(await page.evaluate(() => document.querySelector(".landing-screen").scrollTop), 0);
    }
    await page.setViewportSize({ width: 1280, height: 768 });

    await page.locator('[data-run-id="run-a"]').click();
    await page.locator(".chat-messages-stream", { hasText: "Alpha conversation" }).waitFor();

    // Switching while repository detection yields cannot bind Alpha to Beta.
    await page.locator(".project-workspace-item", { hasText: "Beta" }).click();
    await page.locator('[data-run-id="run-b"]').waitFor();
    await page.locator(".chat-messages-stream", { hasText: "Beta conversation" }).waitFor();
    assert.equal(await page.locator('.runs-list [data-run-id="run-a"]').count(), 0);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("grapher_workspace_runs"))), {
      "c:/projects/alpha": ["run-a"], "c:/projects/beta": ["run-b"],
    });

    // Start Alpha planning, navigate away, then release its delayed SSE result.
    await page.locator(".project-workspace-item", { hasText: "Alpha" }).click();
    await page.locator(".chat-messages-stream", { hasText: "Alpha conversation" }).waitFor();
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.locator(".landing-screen textarea").fill("Detached Alpha conversation");
    await page.locator(".landing-screen textarea").press("Enter");
    await page.waitForFunction(() => !!document.querySelector('.run-item[data-run-id^="pending-"]'));
    await page.locator('.run-item[data-run-id^="pending-"]').click({ button: "right" });
    assert.equal(await page.locator(".context-menu-item.danger").isDisabled(), true);
    await page.locator(".main-view-stage").click({ position: { x: 10, y: 10 } });
    while (!planningRequested) await page.waitForTimeout(20);
    await page.locator(".project-workspace-item", { hasText: "Beta" }).click();
    await page.locator(".chat-messages-stream", { hasText: "Beta conversation" }).waitFor();
    releasePlanning();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("grapher_workspace_runs"))["c:/projects/alpha"]?.includes("new-a"));
    assert.deepEqual(await page.locator(".runs-list [data-run-id]").evaluateAll(cards => cards.map(card => card.dataset.runId)), ["run-b"]);
    assert.ok((await page.locator(".chat-messages-stream").innerText()).includes("Beta conversation"));
    assert.ok(!(await page.locator(".chat-messages-stream").innerText()).includes("Detached Alpha"));

    assert.deepEqual(errors, []);
  } finally {
    releasePlanning();
    await browser?.close();
    await server.close();
  }
});

test("workspace removal commits backend deletion before pruning indexes and survives failure, navigation and reload", { timeout: 90_000 }, async () => {
  const repositoryA = "C:\\Projects\\Alpha";
  const repositoryB = "C:\\Projects\\Beta";
  const config = { repository: repositoryA, model: "test/model", maxParallel: 1, maxFeedback: 3 };
  const makeSnapshot = (runId, repository, goal) => ({
    runId, config: { ...config, repository }, planType: "graph", phase: "completed",
    graph: { originalGoal: goal, nodes: [], edges: [] }, nodes: {}, plan: null,
    executions: [], mergers: [], events: [], approved: false, paused: false, base: "", feedbackCounts: {},
  });
  const snapshots = {
    "run-a": makeSnapshot("run-a", repositoryA, "Alpha conversation"),
    "run-b": makeSnapshot("run-b", repositoryB, "Beta conversation"),
  };
  const empty = { ...makeSnapshot("", repositoryA, ""), config: null, phase: "draft" };
  const info = repository => ({ path: repository, name: repository.includes("Beta") ? "Beta" : "Alpha", branch: "main", head: "", clean: true });
  const errors = [];
  const removals = [];
  let rejectDeletion = true;
  let releaseDeletion;
  const deletionGate = new Promise(resolve => { releaseDeletion = resolve; });
  const server = await createServer({ cacheDir: "node_modules/.vite-workspace-deletion-ui", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false } });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const context = await browser.newContext({ locale: "en-US", reducedMotion: "reduce" });
    await context.addInitScript(({ repositoryA, repositoryB, config }) => {
      if (localStorage.getItem("deletion-fixture-seeded")) return;
      localStorage.setItem("deletion-fixture-seeded", "true");
      localStorage.setItem("grapher_language_v1", "en");
      localStorage.setItem("grapher_projects", JSON.stringify([
        { id: repositoryA, path: repositoryA, name: "Alpha", branch: "main", clean: true, lastOpened: 2 },
        { id: repositoryB, path: repositoryB, name: "Beta", branch: "main", clean: true, lastOpened: 1 },
      ]));
      localStorage.setItem("grapher_workspace_runs", JSON.stringify({ [repositoryA]: ["run-a"], [repositoryB]: ["run-b"] }));
      localStorage.setItem("grapher_run_labels", JSON.stringify({ "run-a": "Alpha conversation", "run-b": "Beta conversation", "server-only-a": "old hidden label" }));
      localStorage.setItem("grapher_run_modes", JSON.stringify({ "run-a": "graph", "run-b": "graph", "server-only-a": "graph" }));
      localStorage.setItem("grapher_config", JSON.stringify(config));
    }, { repositoryA, repositoryB, config });
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap": case "save_config":
          // Keep a stale backend default after removing the final entry: an
          // explicitly empty browser workspace list must not be repopulated.
          result = { config, snapshot: empty, runs: Object.keys(snapshots), repositoryInfo: info(repositoryA), dataPath: "/mock/.grapher" }; break;
        case "history": case "snapshot": result = snapshots[body.runId] || empty; break;
        case "snapshot_if_changed": result = { version: "mock-1", snapshot: snapshots[body.runId] || null }; break;
        case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
        case "detect_repository": result = info(body.path || body.repository); break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = { providers: [{ id: "test", name: "Test", methods: [], configured: true }], models: [], warning: null }; break;
        case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
        case "environment_capabilities": result = { platform: "windows", arch: "x86_64", nativeWorkspace: true }; break;
        case "delete_workspace":
          removals.push(body.repository);
          if (rejectDeletion) return route.fulfill({ status: 400, json: { error: "Cannot remove workspace while tasks are active" } });
          if (body.repository === repositoryA) {
            await deletionGate;
            delete snapshots["run-a"];
            result = ["run-a", "server-only-a"];
          } else {
            assert.equal(body.repository, repositoryB);
            delete snapshots["run-b"];
            result = ["run-b"];
          }
          break;
        default:
          errors.push(`Unexpected API: ${command}`);
          return route.fulfill({ status: 400, json: { error: `Unexpected API: ${command}` } });
      }
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="run-a"]').waitFor();
    const remove = async name => {
      await page.locator(".project-workspace-item", { hasText: name }).click({ button: "right" });
      await page.locator(".context-menu-item.danger").click();
      const dialog = page.getByRole("alertdialog");
      await dialog.getByText(/All conversations, logs, and private caches/).waitFor();
      await dialog.getByRole("button", { name: "Remove workspace", exact: true }).click();
    };
    await remove("Alpha");
    await page.getByText("Cannot remove workspace while tasks are active", { exact: true }).waitFor();
    assert.equal(await page.locator(".project-workspace-item").count(), 2);
    assert.equal(await page.locator('[data-run-id="run-a"]').count(), 1);
    rejectDeletion = false;
    await remove("Alpha");
    while (removals.length < 2) await page.waitForTimeout(10);
    assert.equal(await page.locator(".project-workspace-item").count(), 2, "pending deletion must not hide the workspace");
    await page.locator(".project-workspace-item", { hasText: "Beta" }).click();
    await page.locator(".chat-messages-stream", { hasText: "Beta conversation" }).waitFor();
    releaseDeletion();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("grapher_projects")).length === 1);
    assert.ok((await page.locator(".chat-messages-stream").innerText()).includes("Beta conversation"));
    for (const key of ["grapher_run_labels", "grapher_run_modes"]) {
      const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
      assert.deepEqual(Object.keys(saved), ["run-b"]);
    }
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("grapher_workspace_runs"))), { "c:/projects/beta": ["run-b"] });
    await remove("Beta");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("grapher_projects")).length === 0);
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator(".project-workspace-item").count(), 0);
    assert.equal(await page.locator(".runs-list [data-run-id]").count(), 0);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("grapher_workspace_runs"))), {});
    assert.deepEqual(errors, []);
  } finally {
    releaseDeletion();
    await browser?.close();
    await server.close();
  }
});
