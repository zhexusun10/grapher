import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

let server, browser, origin;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function waitFor(check) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "mock request did not arrive");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const catalog = {
  providers: [{ id: "test", name: "Test", methods: [], configured: true }], warning: null,
  models: ["old", "new"].map(id => ({ provider: "test", id, name: id, available: true, api: "mock", contextWindow: 1000 })),
};
before(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-frontend-audit",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
    plugins: [{ name: "frontend-audit-fixtures", configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith("/__audit")) return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root" style="padding:160px 32px"></div><script type="module" src="/scripts/fixtures/frontend-audit.tsx"></script></body></html>'));
      });
    } }],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(name, handler = async () => false) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  const errors = [];
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON();
    if (await handler(route, command, body)) return;
    const defaults = { provider_auth: catalog, pi_extensions: { globalDirectory: "mock", extensions: [] }, list_files: { files: [] }, list_skills: { skills: [] } };
    if (Object.hasOwn(defaults, command)) return route.fulfill({ json: { result: defaults[command] } });
    errors.push(`Unexpected API: ${command}`);
    await route.fulfill({ status: 500, json: { error: `Unexpected API: ${command}` } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  page.setDefaultTimeout(10_000);
  try {
    await page.goto(`${origin}/__audit?case=${name}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit);
  } catch (error) {
    await context.close();
    throw new Error(`Fixture failed: ${errors.join("; ")} ${error}`);
  }
  return { context, page, errors };
}

test("settings cancel/failure keep committed models unchanged; saving cannot submit twice", { timeout: 30_000 }, async () => {
  let saves = 0, fail = true, saved;
  const gate = deferred();
  const { context, page, errors } = await fixture("settings", async (route, command, body) => {
    if (command !== "save_config") return false;
    saves += 1;
    saved = body.config;
    if (fail) await route.fulfill({ status: 500, json: { error: "Save rejected" } });
    else { await gate.promise; await route.fulfill({ json: { result: { config: saved } } }); }
    return true;
  });
  try {
    const model = page.locator(".role-model-card").nth(2).locator("select").first();
    await model.selectOption("test/new");
    await page.locator(".settings-cancel-btn").click();
    assert.equal(await page.evaluate(() => window.audit.committed.model), "test/old");
    await page.evaluate(() => window.audit.open());
    assert.equal(await model.inputValue(), "test/old");
    await page.locator(".logout-btn").first().click();
    await page.getByRole("alertdialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("alertdialog").waitFor({ state: "detached" });
    assert.equal(await page.locator(".settings-modal").count(), 1, "Escape closes only the nested credential confirmation");
    await model.selectOption("test/new");
    await page.locator(".save-config-btn").click();
    await page.getByRole("alert").filter({ hasText: "Save rejected" }).waitFor();
    assert.equal(await page.evaluate(() => window.audit.committed.model), "test/old");
    assert.equal(await model.inputValue(), "test/new", "failed save retains its draft");
    fail = false;
    await page.locator(".save-config-btn").evaluate(button => { button.click(); button.click(); });
    await waitFor(() => saves === 2);
    assert.equal(await page.locator(".settings-cancel-btn").isDisabled(), true);
    assert.equal(saved.model, "test/new");
    gate.resolve();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.audit.committed.model), "test/new");
    assert.equal(saves, 2);
    assert.deepEqual(errors, []);
  } finally { gate.resolve(); await context.close(); }
});

test("cancelled Provider login/respond replies cannot reopen the panel or replace a newer login", { timeout: 30_000 }, async () => {
  const loginGate = deferred(), responseGate = deferred();
  let logins = 0, responses = 0, oldReply = false, responseReply = false;
  const cancelled = [];
  const pendingLogin = id => ({ id, provider: "test", status: "pending", events: [], error: null,
    prompt: { id: `${id}-prompt`, type: "secret", message: id === "second" ? "Second prompt" : "First prompt" } });
  const { context, page, errors } = await fixture("settings", async (route, command, body) => {
    if (command !== "provider_auth") return false;
    let result;
    switch (body.operation) {
      case "catalog": result = { ...catalog, providers: [{ id: "test", name: "Test", configured: false, methods: [{ id: "api_key", name: "API Key" }] }] }; break;
      case "login":
        logins += 1;
        if (logins === 1) { await loginGate.promise; result = pendingLogin("first"); oldReply = true; }
        else result = pendingLogin("second");
        break;
      case "poll": result = pendingLogin(body.id); break;
      case "cancel": cancelled.push(body.id); result = { ...pendingLogin(body.id), status: "cancelled" }; break;
      case "respond":
        responses += 1;
        await responseGate.promise;
        responseReply = true;
        result = { ...pendingLogin(body.id), status: "complete", prompt: null };
        break;
      default: throw new Error(`Unexpected auth operation: ${body.operation}`);
    }
    await route.fulfill({ json: { result } });
    return true;
  });
  try {
    await page.locator(".providers-grid-title").click();
    await page.locator(".login-btn").click();
    await waitFor(() => logins === 1);
    await page.locator(".active-login-header .icon-button-close").click();
    await page.locator(".login-btn").click();
    await page.locator("#auth-answer").waitFor();
    loginGate.resolve();
    await waitFor(() => oldReply && cancelled.includes("first"));
    assert.ok((await page.locator(".prompt-label").innerText()).includes("Second prompt"));
    await page.locator("#auth-answer").fill("dummy-test-answer");
    await page.locator("#auth-answer").evaluate(input => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await waitFor(() => responses === 1);
    assert.equal(await page.locator("#auth-answer").isDisabled(), true);
    await page.locator(".active-login-header .icon-button-close").click();
    responseGate.resolve();
    await waitFor(() => responseReply);
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".active-login-panel").count(), 0);
    assert.equal(responses, 1);
    assert.deepEqual(errors, []);
  } finally { loginGate.resolve(); responseGate.resolve(); await context.close(); }
});

test("polling graph metadata cannot overwrite an open editor draft", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("editor");
  try {
    const editor = page.getByRole("textbox", { name: "Graph JSON" });
    await editor.fill('{"originalGoal":"Unsaved draft"}');
    await page.evaluate(() => window.audit.updateGraph());
    assert.equal(await editor.inputValue(), '{"originalGoal":"Unsaved draft"}');
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.locator(".modal").waitFor({ state: "detached" });
    await page.evaluate(() => window.audit.open());
    await page.waitForFunction(() => document.querySelector(".json-editor")?.value.includes("Polled graph"));
    assert.ok((await editor.inputValue()).includes("Polled graph"), "reopening starts a new draft session");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("inline message edits deduplicate click/Enter and preserve a rejected draft", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("bubble");
  try {
    await page.getByRole("textbox", { name: "Edit message content" }).waitFor();
    await page.evaluate(() => {
      document.querySelector(".chat-bubble-action-btn.send").click();
      document.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.equal(await page.evaluate(() => window.audit.calls), 1);
    assert.equal(await page.locator("textarea").isDisabled(), true);
    await page.evaluate(() => window.audit.resolve(false));
    await page.waitForFunction(() => !document.querySelector("textarea").disabled);
    assert.equal(await page.locator("textarea").inputValue(), "Edited message");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("late workspace completions cannot replace current files/skills; controlled input clears on accepted send", { timeout: 30_000 }, async () => {
  let oldRequests = 0, oldReplies = 0;
  const gate = deferred();
  const { context, page, errors } = await fixture("prompt", async (route, command, body) => {
    if (!["list_files", "list_skills"].includes(command)) return false;
    const isOld = body.repository === "/a";
    if (isOld) { oldRequests += 1; await gate.promise; }
    const name = isOld ? "alpha" : "beta";
    const result = command === "list_files" ? { files: [`${name}.ts`] }
      : { skills: [{ name, description: `${name} skill`, path: `/${name}`, scope: "workspace" }] };
    await route.fulfill({ json: { result } });
    if (isOld) oldReplies += 1;
    return true;
  });
  try {
    await waitFor(() => oldRequests === 2);
    await page.evaluate(() => window.audit.switchRepository());
    const input = page.locator("textarea");
    await input.fill("@");
    await page.locator(".suggestion-item-title-row", { hasText: "beta.ts" }).waitFor();
    gate.resolve();
    await waitFor(() => oldReplies === 2);
    await page.waitForTimeout(50);
    assert.ok(!(await page.locator(".prompt-box-suggestions-list").innerText()).includes("alpha.ts"));
    await input.fill("/");
    await page.locator(".suggestion-item-title-row", { hasText: "/skill:beta" }).waitFor();
    assert.ok(!(await page.locator(".prompt-box-suggestions-list").innerText()).includes("alpha"));
    await input.fill("Accepted message");
    await input.press("Enter");
    await page.waitForFunction(() => window.audit.value === "");
    assert.equal(await input.inputValue(), "");
    assert.deepEqual(errors, []);
  } finally { gate.resolve(); await context.close(); }
});

test("unreadable attachments retain the draft and file instead of sending an incomplete message", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("prompt");
  try {
    const input = page.locator("textarea");
    await input.fill("Keep this draft");
    await page.evaluate(() => {
      File.prototype.text = () => Promise.reject(new Error("Unreadable fixture"));
      FileReader.prototype.readAsText = () => { throw new Error("Unreadable fixture"); };
      document.querySelector("textarea").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: new DataTransfer() }));
    });
    assert.equal(await page.evaluate(() => window.audit.pastes), 1);
    await page.locator('input[type="file"]').setInputFiles({ name: "fixture.txt", mimeType: "text/plain", buffer: Buffer.from("test") });
    await input.press("Enter");
    await page.getByRole("alert", { name: "" }).filter({ hasText: "attachment could not be read" }).waitFor();
    assert.equal(await input.inputValue(), "Keep this draft");
    assert.equal(await page.locator(".prompt-box-file-badge").count(), 1);
    assert.equal(await input.isDisabled(), false);
    assert.equal(await page.evaluate(() => window.audit.submissions ?? 0), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("one unavailable Run cannot starve other polls, and a stale poll cannot overwrite an action with equal event sequence", { timeout: 30_000 }, async () => {
  let viewedRequests = 0, backgroundRequests = 0, oldReply = false;
  const gate = deferred();
  const { context, page, errors } = await fixture("polling", async (route, command, body) => {
    if (command !== "snapshot_if_changed") return false;
    if (body.runId === "broken") {
      await route.fulfill({ status: 404, json: { error: "Run unavailable" } });
      return true;
    }
    const make = goal => ({ runId: body.runId, config: { repository: "/a" }, phase: "running",
      graph: { originalGoal: goal, nodes: [], edges: [] }, events: [], nodes: {}, executions: [], approved: false });
    let goal = "Background";
    if (body.runId === "background") backgroundRequests += 1;
    if (body.runId === "view") {
      viewedRequests += 1;
      if (viewedRequests === 1) {
        await gate.promise;
        goal = "Stale poll result";
      } else goal = "Action result";
    }
    await route.fulfill({ json: { result: { version: `v-${viewedRequests}`, snapshot: make(goal) } } });
    if (body.runId === "view" && viewedRequests === 1) oldReply = true;
    return true;
  });
  try {
    await waitFor(() => viewedRequests === 1);
    assert.equal(backgroundRequests, 1);
    await page.evaluate(() => window.audit.acceptAction());
    gate.resolve();
    await waitFor(() => oldReply);
    await page.waitForTimeout(100);
    assert.equal(await page.locator("[data-viewed-goal]").innerText(), "Action result");
    await page.evaluate(() => window.audit.removeBroken());
    await waitFor(() => backgroundRequests >= 2);
    assert.deepEqual(errors, []);
  } finally { gate.resolve(); await context.close(); }
});

for (const approved of [false, true]) {
  test(`planner revision ${approved ? "preserves a paused runtime" : "hides approval without claiming execution"}`, { timeout: 30_000 }, async () => {
    const config = { repository: "/a", model: "test/old", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
    const draft = { runId: "draft-run", config, planType: "graph",
      graph: { originalGoal: "Draft goal", nodes: [{ name: "task", task: "Draft task" }], edges: [] },
      nodes: { task: { status: "waiting", revision: 0, attempts: 0, instruction: "", error: null } },
      plan: null, executions: [], events: [], approved, paused: approved,
      phase: approved ? "paused" : "awaiting_approval", base: "", feedbackCounts: {} };
    const empty = { ...draft, runId: "", config: null, approved: false, paused: false, phase: "draft",
      graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {} };
    const info = { path: "/a", name: "Alpha", branch: "main", head: "", clean: true };
    const gate = deferred();
    let requested = false, polls = 0;
    const errors = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap": result = { config, snapshot: empty, runs: [draft.runId], repositoryInfo: info, dataPath: "/mock" }; break;
        case "history": case "snapshot": result = draft; break;
        case "snapshot_if_changed":
          if (requested) polls += 1;
          result = { version: `poll-${polls}`, snapshot: draft }; break;
        case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = catalog; break;
        case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
        case "plan_goal_stream":
          assert.equal(body.revisionRunId, draft.runId);
          requested = true;
          await gate.promise;
          await route.fulfill({ contentType: "text/event-stream", body:
            `event: complete\ndata: ${JSON.stringify({ snapshot: draft })}\n\n` });
          return;
        default:
          errors.push(`Unexpected API: ${command}`);
          await route.fulfill({ status: 400, json: { error: `Unexpected API: ${command}` } }); return;
      }
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(String(error)));
    try {
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.locator(`[data-run-id="${draft.runId}"]`).click();
      const bottom = page.locator(".graph-bottom");
      await bottom.waitFor();
      if (!approved) await bottom.getByRole("button", { name: "Approve", exact: true }).waitFor();
      const composer = page.locator(".pane-bottom-chat textarea");
      await composer.fill("Revise this graph");
      await composer.press("Enter");
      await waitFor(() => requested);
      const checkPlanning = async () => {
        assert.equal(await bottom.getByRole("button", { name: "Approve", exact: true }).count(), 0);
        assert.equal(await bottom.getByRole("button", { name: "Reject", exact: true }).count(), 0);
        assert.equal(await bottom.locator(".progress-label > span").last().innerText(), approved ? "Paused" : "Planning");
        assert.ok(!(await bottom.innerText()).includes("Running"));
        assert.ok(!(await bottom.innerText()).includes("Deterministic runtime"));
      };
      await checkPlanning();
      // Even an old awaiting_approval poll cannot bring the buttons back mid-turn.
      if (!approved) { await waitFor(() => polls > 0); await page.waitForTimeout(100); await checkPlanning(); }
      gate.resolve();
      if (!approved) await bottom.getByRole("button", { name: "Approve", exact: true }).waitFor();
      else await page.locator(".planner-off", { hasText: "Offline" }).waitFor();
      assert.deepEqual(errors, []);
    } finally { gate.resolve(); await context.close(); }
  });
}

test("recovered planning polls activity before route discovery and opens the completed graph", { timeout: 45_000 }, async () => {
  const config = { repository: "/a", model: "test/old", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const running = { planningId: "recovered-plan", repository: "/a", status: "running", createdAt: Date.now(),
    modelDuration: 0, totalPlanningDuration: 0, roles: { partition: {}, planner: {} } };
  const info = { path: "/a", name: "Alpha", branch: "main", head: "", clean: true };
  const bootstrap = { config, snapshot: empty, runs: [], repositoryInfo: info, dataPath: "/mock" };
  const completed = { ...empty, runId: "recovered-run", config, planType: "graph", phase: "awaiting_approval",
    planningId: running.planningId, planning: { ...running, status: "success" },
    graph: { originalGoal: "Recovered goal", nodes: [], edges: [] } };
  const line = event => JSON.stringify(event) + "\n";
  const first = line({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "Recovered goal" }] } }) +
    line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Recovered activity 中文🚀" } });
  const appended = line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "\n\nAutomatically appended activity" } });
  let output = "", finished = false;
  const offsets = [], errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = bootstrap; break;
      case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
      case "list_plannings": result = [finished ? completed.planning : running]; break;
      case "get_planning": result = finished ? completed.planning : running; break;
      case "get_planning_output": {
        assert.equal(body.planningId, running.planningId);
        assert.equal(body.role, "planner");
        offsets.push(body.offset);
        const bytes = Buffer.from(output);
        result = { planningId: running.planningId, role: "planner", content: bytes.subarray(body.offset).toString(),
          nextOffset: bytes.length, totalBytes: bytes.length, complete: true, running: !finished };
        break;
      }
      case "get_planning_snapshot":
        assert.equal(body.planningId, running.planningId);
        assert.equal(body.repository, "/a");
        result = completed; break;
      case "history": case "snapshot": result = completed; break;
      case "snapshot_if_changed": result = { version: "fixed", snapshot: null }; break;
      case "provider_auth": result = catalog; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      default:
        errors.push(`Unexpected API: ${command}`);
        await route.fulfill({ status: 400, json: { error: `Unexpected API: ${command}` } }); return;
    }
    await route.fulfill({ json: { result } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(".floating-recovered-banner").waitFor();
    await waitFor(() => offsets.length > 0);
    assert.equal(await page.locator(".route-decision-pill").innerText(), "Evaluating task routing...");
    assert.equal(offsets[0], 0, "missing initial output must keep polling instead of settling the cache");

    output = first;
    const activity = page.getByRole("region", { name: "Planning activity" });
    await activity.getByText("Recovered activity 中文🚀", { exact: true }).waitFor();
    await activity.getByText("Recovered goal", { exact: true }).waitFor();
    output += appended;
    await activity.getByText("Automatically appended activity", { exact: true }).waitFor();
    assert.ok(offsets.includes(Buffer.byteLength(first)), "append polling resumes at the UTF-8 byte offset");
    assert.equal(await activity.getByText("Recovered activity 中文🚀", { exact: true }).count(), 1);
    assert.equal(await page.locator(".floating-recovered-banner").count(), 1);

    finished = true;
    await page.locator(".floating-recovered-banner").waitFor({ state: "detached" });
    await page.locator('.run-item.chosen[data-run-id="recovered-run"]').waitFor();
    await activity.getByText("Automatically appended activity", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("late node sends and edits cannot overwrite another workspace or its composer draft", { timeout: 45_000 }, async () => {
  const config = { repository: "/a", model: "test/old", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const base = { plan: null, events: [], approved: true, paused: false, phase: "completed", base: "", feedbackCounts: {} };
  const snapshots = {
    a: { ...base, runId: "a", config, planType: "serial", graph: { originalGoal: "Alpha original", nodes: [{ name: "task", task: "Alpha original" }], edges: [] },
      nodes: { task: { status: "done", revision: 0, head: null, instruction: "", error: null } },
      executions: [{ id: "exec-a", node: "task", status: "completed", revision: 0, attempt: 1, sessionId: "s", worktree: "/a", before: "", after: "", output: "", startedAt: 1, completedAt: 2 }] },
    b: { ...base, runId: "b", config: { ...config, repository: "/b" }, planType: "graph", graph: { originalGoal: "Beta original", nodes: [], edges: [] }, nodes: {}, executions: [] },
  };
  const empty = { ...snapshots.b, runId: "", graph: { originalGoal: "", nodes: [], edges: [] }, approved: false, phase: "draft", config: null };
  const info = path => ({ path, name: path === "/a" ? "Alpha" : "Beta", branch: "main", head: "", clean: true });
  const bootstrap = { config, snapshot: empty, runs: ["a", "b"], repositoryInfo: info("/a"), dataPath: "/mock" };
  const sendGate = deferred(), editGate = deferred();
  let controls = 0, edits = 0, sendReplied = false, editReplied = false;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  const errors = [];
  await context.addInitScript(({ config }) => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_projects", JSON.stringify([
      { path: "/a", id: "/a", name: "Alpha", branch: "main", clean: true, lastOpened: 2 },
      { path: "/b", id: "/b", name: "Beta", branch: "main", clean: true, lastOpened: 1 },
    ]));
    localStorage.setItem("grapher_config", JSON.stringify(config));
  }, { config });
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = bootstrap; break;
      case "snapshot": case "history": result = snapshots[body.runId]; break;
      case "snapshot_if_changed": result = { version: "fixed", snapshot: null }; break;
      case "detect_repository": result = info(body.path || body.repository); break;
      case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = catalog; break;
      case "control":
        controls += 1;
        assert.equal(body.runId, "a");
        if (controls === 1) { await route.fulfill({ status: 400, json: { error: "Intervention rejected" } }); return; }
        await sendGate.promise;
        result = { ...snapshots.a, phase: "running" };
        sendReplied = true;
        break;
      case "edit_node":
        edits += 1;
        assert.equal(body.runId, "a");
        await editGate.promise;
        result = { ...snapshots.a, graph: { ...snapshots.a.graph, originalGoal: "Edited Alpha" }, phase: "running" };
        editReplied = true;
        break;
      default:
        errors.push(`Unexpected API: ${command}`);
        await route.fulfill({ status: 400, json: { error: `Unexpected API: ${command}` } }); return;
    }
    await route.fulfill({ json: { result } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="a"]').click();
    await page.locator(".chat-messages-stream", { hasText: "Alpha original" }).waitFor();
    const composer = page.locator(".pane-bottom-chat textarea");
    await composer.fill("Retryable follow-up");
    await composer.press("Enter");
    await page.getByRole("alert").filter({ hasText: "Intervention rejected" }).waitFor();
    assert.equal(await composer.inputValue(), "Retryable follow-up");
    assert.ok(!(await page.locator(".chat-messages-stream").innerText()).includes("Retryable follow-up"));
    await composer.press("Enter");
    await waitFor(() => controls === 2);
    await page.locator(".project-workspace-item", { hasText: "Beta" }).click();
    await page.locator(".chat-messages-stream", { hasText: "Beta original" }).waitFor();
    await composer.fill("Beta draft");
    sendGate.resolve();
    await waitFor(() => sendReplied);
    await page.waitForTimeout(100);
    assert.equal(await composer.inputValue(), "Beta draft");
    assert.equal(await page.locator(".run-item.chosen").getAttribute("data-run-id"), "b");
    assert.ok(!(await page.locator(".chat-messages-stream").innerText()).includes("Alpha"));
    await page.locator(".project-workspace-item", { hasText: "Alpha" }).click();
    await page.locator(".chat-messages-stream", { hasText: "Alpha original" }).waitFor();
    await page.locator(".chat-user-message-card-wrapper").first().hover();
    await page.locator(".chat-message-edit-btn").first().click();
    const editor = page.locator(".chat-bubble-edit-textarea");
    await editor.fill("Edited Alpha");
    await editor.press("Enter");
    await waitFor(() => edits === 1);
    await page.locator(".project-workspace-item", { hasText: "Beta" }).click();
    await page.locator(".chat-messages-stream", { hasText: "Beta original" }).waitFor();
    await composer.fill("Beta next draft");
    editGate.resolve();
    await waitFor(() => editReplied);
    await page.waitForTimeout(100);
    assert.equal(await composer.inputValue(), "Beta next draft");
    assert.equal(await page.locator(".run-item.chosen").getAttribute("data-run-id"), "b");
    assert.ok(!(await page.locator(".chat-messages-stream").innerText()).includes("Edited Alpha"));
    assert.deepEqual(errors, []);
  } finally { sendGate.resolve(); editGate.resolve(); await context.close(); }
});

test("thinking cards settle without a shimmer and backfill summaries in place in live and replay views", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("thinking");
  const append = event => page.evaluate(event => window.audit.append(event), event);
  const update = (type, contentIndex, extra = {}) => append({
    type: "message_update", assistantMessageEvent: { type, contentIndex, ...extra },
  });
  const views = [page.locator('[data-thinking-view="live"]'), page.locator('[data-thinking-view="history"]')];
  try {
    await append({ type: "message_start", message: { role: "assistant", content: [] } });
    await update("thinking_start", 0);
    for (const view of views) await view.locator(".thinking-shimmer").waitFor();
    const ids = await Promise.all(views.map(view => view.locator("[data-transcript-id]").first().getAttribute("data-transcript-id")));
    await update("thinking_end", 0, { content: "" });
    for (const view of views) {
      await view.locator(".thinking-empty").waitFor();
      assert.equal(await view.locator(".thinking-shimmer").count(), 0);
      assert.equal(await view.locator(".thinking-status.completed").count(), 1);
    }
    await update("thinking_start", 1);
    for (const view of views) {
      await view.locator(".thinking-shimmer").waitFor();
      assert.equal(await view.locator(".thinking-empty").count(), 1);
    }
    await update("thinking_end", 1, { content: "End-only summary 中文🚀" });
    await update("thinking_start", 2);
    await update("thinking_delta", 2, { delta: "Unnormalized partial" });
    await update("thinking_end", 2, { content: "Normalized final summary" });
    await append({ type: "message_end", message: { role: "assistant", content: [
      { type: "thinking", thinking: "Backfilled first summary" },
      { type: "thinking", thinking: "End-only summary 中文🚀" },
      { type: "thinking", thinking: "Normalized final summary" },
    ] } });
    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      await view.locator(".thinking-card-body", { hasText: "Backfilled first summary" }).waitFor();
      assert.equal(await view.locator(".thinking-card").count(), 3);
      assert.equal(await view.locator(".thinking-status.completed").count(), 3);
      assert.equal(await view.locator(".thinking-shimmer, .thinking-empty").count(), 0);
      assert.equal(await view.locator("[data-transcript-id]").first().getAttribute("data-transcript-id"), ids[i]);
      assert.ok((await view.innerText()).includes("End-only summary 中文🚀"));
      assert.ok(!(await view.innerText()).includes("Unnormalized partial"));
    }
    await append({ type: "message_start", message: { role: "assistant", content: [] } });
    await update("thinking_start", 0);
    await update("thinking_end", 0, { content: "End-only summary 中文🚀" });
    for (const view of views) {
      await view.locator(".thinking-card").nth(3).waitFor();
      assert.equal(await view.locator(".thinking-card-body", { hasText: "End-only summary 中文🚀" }).count(), 2);
      assert.equal(await view.locator(".thinking-shimmer").count(), 0);
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
