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
    const defaults = { provider_auth: catalog, list_files: { files: [] }, list_skills: { skills: [] } };
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
