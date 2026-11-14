import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

test("returning from node creation keeps Planner history scrollable and restores its reading position", { timeout: 60_000 }, async () => {
  const repository = "/mock/scroll";
  const config = { repository, model: "test/model", thinkingLevel: "off", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const empty = { runId: "", graph: { originalGoal: "", nodes: [], edges: [] }, config: null, nodes: {}, executions: [], events: [],
    approved: false, paused: false, phase: "draft", plan: null, base: "", feedbackCounts: {} };
  const snapshot = { ...empty, runId: "scroll-graph", planningId: "scroll-plan", planType: "graph", config, approved: true, phase: "completed",
    graph: { originalGoal: "Scroll test", nodes: [{ name: "worker", task: "Work" }], edges: [] },
    nodes: { worker: { status: "completed", revision: 1, head: "head", instruction: "", error: null } },
    events: [{ type: "created", sequence: 1, planning_id: "scroll-plan", timestamp: 1 }] };
  const rows = Array.from({ length: 120 }, (_, index) => JSON.stringify({ type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: `PLANNER_ROW_${index} ${index % 2 ? "Long wrapped content. ".repeat(25) : "short"}` }] } }) + "\n");
  const split = Buffer.byteLength(rows.slice(0, 80).join(""));
  const output = Buffer.from(rows.join(""));
  let olderReads = 0;
  const errors = [];
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
        case "bootstrap": result = { config, snapshot: empty, runs: [snapshot.runId], repositoryInfo: { path: repository, name: "Project", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
        case "history": case "snapshot": case "load_run": result = snapshot; break;
        case "snapshot_if_changed": result = { version: "1", snapshot: null }; break;
        case "repository_status": result = { repository, valid: true, error: null }; break;
        case "detect_repository": result = { path: repository, name: "Project", branch: "main", head: "", clean: true }; break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = { providers: [], models: [], warning: null }; break;
        case "get_planning_output": {
          const start = body.before !== undefined ? 0 : body.tail ? split : body.offset ?? 0;
          const end = body.before ?? output.length;
          if (body.before !== undefined) olderReads++;
          result = { planningId: body.planningId, role: "planner", content: output.subarray(start, end).toString(),
            startOffset: start, nextOffset: end, totalBytes: output.length, complete: end === output.length, running: false };
          break;
        }
        default: errors.push(`Unexpected API: ${command}`); result = null;
      }
      try { await route.fulfill({ json: { result } }); } catch { /* navigation may cancel polling */ }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-run-id="scroll-graph"]').click();
    await page.locator('.react-flow__node[data-id="worker"]').waitFor();
    const scroll = page.locator(".initial-query-scroll");
    const readyAtBottom = async () => page.waitForFunction(() => {
      const el = document.querySelector(".initial-query-scroll.conversation-ready");
      return el && el.scrollHeight > el.clientHeight * 2 && el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
    });
    const openCreation = async (clickBlank = true) => {
      await page.locator(".react-flow__pane").click({ button: "right", position: { x: 12, y: 12 } });
      await page.getByRole("menuitem", { name: "New node" }).click();
      await page.locator(".create-node-form").waitFor();
      if (clickBlank) {
        await page.locator(".react-flow__pane").click({ position: { x: 12, y: 12 } });
        assert.equal(await page.locator(".create-node-form").count(), 1, "clicking the canvas keeps the form open");
      }
    };
    await readyAtBottom();
    await openCreation();
    await page.getByRole("button", { name: "Cancel node creation" }).click();
    await readyAtBottom();
    // The replacement scroller must also receive its resize observer.
    await scroll.evaluate(el => {
      const extra = document.createElement("div");
      extra.style.height = "200px";
      el.querySelector(".chat-messages-stream").append(extra);
    });
    await readyAtBottom();
    const initialTop = await scroll.evaluate(el => el.scrollTop);
    await scroll.hover({ position: { x: 10, y: 10 } });
    await page.mouse.wheel(0, -350);
    await page.waitForTimeout(250);
    const afterWheel = await scroll.evaluate(el => ({ top: el.scrollTop, following: el.dataset.transcriptFollowing }));
    assert.ok(afterWheel.top < initialTop - 100, `wheel scrollback should not snap to the bottom: ${JSON.stringify({ initialTop, afterWheel })}`);
    assert.equal(afterWheel.following, undefined, "upward input releases bottom following");
    await scroll.evaluate(el => el.dispatchEvent(new Event("grapher:transcript-content-growth")));
    await page.waitForTimeout(100);
    assert.ok(Math.abs(await scroll.evaluate(el => el.scrollTop) - afterWheel.top) <= 3,
      "new output must not pull a reader back to the bottom");

    // Keyboard navigation must still load older Planner pages on the new element.
    assert.equal(olderReads, 0, "the initial tail fills the viewport without reading older pages");
    await page.evaluate(async () => { window.planningCache = (await import("/src/services/transcriptCache.ts")).planningTranscriptCache; });
    await scroll.evaluate(el => { el.tabIndex = 0; el.focus({ preventScroll: true }); });
    await page.keyboard.press("Home");
    await page.waitForFunction(() => window.planningCache.get("scroll-graph:scroll-plan")?.startOffset === 0);
    assert.ok(olderReads > 0, "scrolling to the beginning requests earlier Planner history");

    // Leave from inside the virtualized history, then restore the same measured row.
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
    await page.waitForTimeout(300);
    const anchor = await scroll.evaluate(el => {
      const top = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll(".planning-activity [data-transcript-id]")].find(item => {
        const bounds = item.getBoundingClientRect();
        return bounds.bottom > top + 20 && bounds.top < top + el.clientHeight - 20;
      });
      return row && { id: row.dataset.transcriptId, top: row.getBoundingClientRect().top - top };
    });
    assert.ok(anchor, "a Planner history row is visible before opening the form");
    await openCreation();
    await page.getByRole("button", { name: "Cancel node creation" }).click();
    await page.locator(".initial-query-scroll.conversation-ready").waitFor();
    await page.waitForTimeout(300);
    const restored = await scroll.evaluate((el, id) => {
      const row = [...el.querySelectorAll(".planning-activity [data-transcript-id]")].find(item => item.dataset.transcriptId === id);
      return row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
    }, anchor.id);
    assert.ok(restored !== null && Math.abs(restored - anchor.top) <= 4,
      `node creation should preserve the visible Planner row: ${JSON.stringify({ anchor, restored })}`);
    const restoredTop = await scroll.evaluate(el => el.scrollTop);
    await scroll.hover({ position: { x: 10, y: 10 } });
    await page.mouse.wheel(0, -250);
    await page.waitForTimeout(200);
    assert.ok(await scroll.evaluate(el => el.scrollTop) < restoredTop - 100, "restored history remains scrollable");

    // Enter from a node instead of Planner, then verify touch input on return.
    await page.getByRole("button", { name: "Latest", exact: true }).click();
    await readyAtBottom();
    await page.locator('.react-flow__node[data-id="worker"]').click();
    await page.getByRole("heading", { name: "worker" }).waitFor();
    await openCreation(false);
    await page.getByRole("button", { name: "Cancel node creation" }).click();
    await readyAtBottom();
    await scroll.evaluate(el => {
      const touch = clientY => new Touch({ identifier: 9, target: el, clientY });
      el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch(100)] }));
      el.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [touch(150)] }));
      // Synthetic touch events do not perform the browser's default scroll.
      el.scrollTop -= 600;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(150);
    assert.equal(await scroll.getAttribute("data-transcript-following"), null, "touch scrollback releases following");
    assert.ok(await scroll.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight) > 100);

    // Selecting a node from the form, rather than cancelling it, must also
    // leave the Planner ready to restore and scroll when its back button is used.
    await page.getByRole("button", { name: "Latest", exact: true }).click();
    await readyAtBottom();
    await openCreation();
    await page.locator('.react-flow__node[data-id="worker"]').click();
    await page.getByRole("heading", { name: "worker" }).waitFor();
    await page.locator(".back-to-query-btn").click();
    await readyAtBottom();
    const finalTop = await scroll.evaluate(el => el.scrollTop);
    await scroll.hover({ position: { x: 10, y: 10 } });
    await page.mouse.wheel(0, -250);
    await page.waitForTimeout(200);
    assert.ok(await scroll.evaluate(el => el.scrollTop) < finalTop - 100, "Planner scrolls after leaving the form through a node");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("graph background menu creates nodes with explicit completed-result confirmation", { timeout: 60_000 }, async () => {
  const repository = "/mock/project";
  const config = { repository, model: "test/model", thinkingLevel: "off", maxParallel: 2, maxFeedback: 3, feedbackEnabled: true, autoApprove: false };
  const nodeState = (status = "completed") => ({ status, revision: 1, head: status === "completed" ? "head" : null, instruction: "", error: null });
  const empty = { runId: "", graph: { originalGoal: "", nodes: [], edges: [] }, config: null, nodes: {}, executions: [], events: [],
    approved: false, paused: false, phase: "draft", plan: null, base: "", feedbackCounts: {} };
  let snapshot = { ...empty, runId: "graph-a", planType: "graph", config, approved: true, phase: "completed",
    graph: { originalGoal: "Example", nodes: ["up", "target", "child"].map(name => ({ name, task: `Task ${name}` })),
      edges: [{ from: "up", to: "target", feedback: false }, { from: "target", to: "child", feedback: false }] },
    nodes: { up: nodeState(), target: nodeState(), child: nodeState() } };
  const repositoryInfo = { path: repository, name: "Project", branch: "main", head: "", clean: true };
  const requests = [];
  const taskEdits = [];
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
        case "update_unstarted_node_task": {
          taskEdits.push(body);
          if (taskEdits.length === 2) {
            await route.fulfill({ status: 409, json: { error: "Node has already started; reload before editing its task" } });
            return;
          }
          snapshot = { ...snapshot, graph: { ...snapshot.graph, nodes: snapshot.graph.nodes.map(node =>
            node.name === body.node ? { ...node, task: body.task } : node) } };
          result = snapshot;
          break;
        }
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
    await form.getByRole("button", { name: "Save" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /target, child/);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    assert.equal(requests.length, 0, "cancelling must not mutate the graph");
    await form.getByRole("button", { name: "Save" }).click();
    await dialog.getByRole("button", { name: "Confirm and save" }).click();
    await page.getByRole("alert").filter({ hasText: "Mock save failure" }).waitFor();
    assert.equal(await form.getByLabel("Name (name)").inputValue(), "inserted", "failed saves retain the draft");
    await page.locator(".floating-error-close").click();
    await form.getByRole("button", { name: "Save" }).click();
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
    await form.getByLabel("Target (to)").selectOption("up");
    await form.getByRole("button", { name: "Save" }).click();
    assert.match(await form.getByRole("alert").innerText(), /cannot be the same node/i);
    assert.equal(requests.length, 2, "an identical predecessor and target is not submitted");
    await form.getByLabel("Target (to)").selectOption("child");
    await form.getByLabel("feedback").selectOption("true");
    await form.getByRole("button", { name: "Save" }).click();
    assert.match(await form.getByRole("alert").innerText(), /feedback target must be the predecessor/i);
    assert.equal(requests.length, 2, "invalid feedback is not submitted");
    await form.getByLabel("Target (to)").selectOption("up");
    await form.getByRole("button", { name: "Save" }).click();
    assert.match(await dialog.innerText(), /may run again/);
    await dialog.getByRole("button", { name: "Confirm and save" }).click();
    await page.locator('.react-flow__node[data-id="review"]').waitFor();
    assert.equal(requests[2].request.feedback, true);

    await openMenu();
    await page.getByRole("menuitem", { name: "New node" }).click();
    await form.getByLabel("Name (name)").fill("independent");
    await form.getByLabel("Task (task)").fill("Independent work");
    await form.getByRole("button", { name: "Save" }).click();
    await page.locator('.react-flow__node[data-id="independent"]').waitFor();
    assert.equal(await dialog.count(), 0, "an independent node does not require confirmation");
    assert.equal(requests[3].request.to, null);
    assert.deepEqual(requests[3].request.confirmedCompleted, []);

    await page.getByRole("heading", { name: "independent" }).waitFor();
    await page.getByRole("button", { name: "Edit task directive" }).click();
    await page.locator(".node-task-card textarea").fill("Updated independent work");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.locator(".node-task-card").getByText("Updated independent work", { exact: true }).waitFor();
    assert.deepEqual(taskEdits.map(({ runId, node, oldTask, task }) => ({ runId, node, oldTask, task })),
      [{ runId: "graph-a", node: "independent", oldTask: "Independent work", task: "Updated independent work" }]);
    assert.equal(await page.locator('[data-run-id="graph-a"]').count(), 1);
    assert.equal(await page.locator('[data-run-id]').count(), 1, "editing a waiting node does not create a conversation");
    await page.getByRole("button", { name: "Edit task directive" }).click();
    await page.locator(".node-task-card textarea").fill("Race draft");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("alert").filter({ hasText: "Node has already started" }).waitFor();
    assert.equal(await page.locator(".node-task-card textarea").inputValue(), "Race draft", "rejected edits retain their draft");
    await page.getByRole("button", { name: "Cancel edit" }).click();
    await page.locator(".floating-error-close").click();

    snapshot = { ...snapshot, phase: "launching_result" };
    await page.waitForFunction(() => document.querySelector(".approval-row")?.textContent?.includes("launching_result"));
    await openMenu();
    assert.equal(await page.getByRole("menuitem", { name: "New node" }).isDisabled(), true,
      "a running published result must finish before a node can be added");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
