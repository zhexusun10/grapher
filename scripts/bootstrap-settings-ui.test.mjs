import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

// Real App/browser, deliberately stalled API transport; no credentials or data.
let server, browser, origin;
const repository = "/responsiveness";
const config = { repository, model: "test/old", thinkingLevel: "off", maxParallel: 2, maxFeedback: 3, autoApprove: false };
const info = { path: repository, name: "Responsiveness", branch: "main", clean: true, head: "" };
const empty = { runId: "", config: null, phase: "draft", graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
  executions: [], events: [], mergers: [], plan: null, approved: false, paused: false, base: "", feedbackCounts: {} };
const fast = { ...empty, runId: "fast", config, phase: "completed", graph: { ...empty.graph, originalGoal: "Available conversation" } };
const bootstrap = { config, snapshot: fast, runs: ["fast"], repositoryInfo: info, dataPath: "/mock", envOverrides: {} };
const catalog = { providers: [{ id: "test", name: "Test", methods: [], configured: true }], warning: null,
  models: [
    { id: "old", thinkingLevels: ["off", "low", "high"], thinkingLevelFallbacks: { minimal: "low", medium: "high", xhigh: "high", max: "high" } },
    { id: "new", thinkingLevels: ["low", "high", "max"], thinkingLevelFallbacks: { off: "low", minimal: "low", medium: "high", xhigh: "max" } },
    { id: "plain", thinkingLevels: ["off"], thinkingLevelFallbacks: { minimal: "off", low: "off", medium: "off", high: "off", xhigh: "off", max: "off" } },
  ].map(model => ({ provider: "test", name: model.id, api: "mock", contextWindow: 1000, available: true, ...model })) };

before(async () => {
  server = await createServer({ cacheDir: "node_modules/.vite-bootstrap-settings", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false } });
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function app(handler) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(({ repository, config }) => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Responsiveness", lastOpened: 1 }]));
    localStorage.setItem("grapher_config", JSON.stringify({ ...config, model: "stale/browser-model" }));
  }, { repository, config });
  const errors = [], calls = [];
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    calls.push({ command, body });
    if (await handler(route, command, body)) return;
    const defaults = { bootstrap, history: fast, snapshot: fast, snapshot_if_changed: { version: "fixed", snapshot: null },
      repository_status: { repository, valid: true, error: null }, list_plannings: [], list_files: { files: [] }, list_skills: { skills: [] },
      provider_auth: catalog, pi_extensions: { globalDirectory: "mock", extensions: [] }, environment_capabilities: { platform: "windows", arch: "x86_64", nativeWorkspace: true } };
    if (!Object.hasOwn(defaults, command)) errors.push(`Unexpected API: ${command}`);
    await route.fulfill({ json: { result: defaults[command] ?? null } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(8_000);
  page.on("pageerror", error => errors.push(String(error)));
  await page.clock.install();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  return { context, page, errors, calls };
}
const nodeModel = page => page.locator(".role-model-card").nth(0).locator("select").first();
async function openSettings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-modal").waitFor();
  await page.waitForFunction(() => document.querySelector(".save-config-btn")?.disabled === false);
}
async function until(check) {
  const end = Date.now() + 8_000;
  while (!await check()) { assert.ok(Date.now() < end, "expected request/state did not arrive"); await new Promise(completed => setTimeout(completed, 20)); }
}

test("one stalled history cannot keep validated sidebar cards and saved models loading", { timeout: 30_000 }, async () => {
  let stalled = 0;
  const { context, page, errors } = await app(async (route, command, body) => {
    if (command === "bootstrap") {
      await route.fulfill({ json: { result: { ...bootstrap, runs: ["fast", "slow"] } } }); return true;
    }
    if (command === "history" && body.runId === "slow") { stalled++; return true; }
    return false;
  });
  try {
    await page.locator('[data-run-id="fast"]').waitFor();
    assert.equal(await page.locator(".sidebar-skeleton-wrap").count(), 0);
    assert.equal(await page.locator('[data-run-id="slow"]').count(), 0, "unvalidated ownership stays hidden");
    assert.equal(stalled, 1);
    await openSettings(page);
    assert.equal(await nodeModel(page).inputValue(), "test/old", "backend settings are ready before all histories finish");
    await page.clock.fastForward(15_001);
    await page.locator(".sidebar-load-error").filter({ hasText: "Some conversation histories failed to load" }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("stalled bootstrap shows a recoverable error, not an endless skeleton or a false missing-Planner prompt", { timeout: 30_000 }, async () => {
  let stall = true, bootstraps = 0;
  const { context, page, errors } = await app(async (_route, command) => {
    if (command === "bootstrap") { bootstraps++; return stall; }
    return false;
  });
  try {
    await until(() => bootstraps === 1);
    const composer = page.locator(".landing-screen textarea");
    await composer.fill("Do a short task"); await composer.press("Enter");
    await page.getByRole("alert").filter({ hasText: "Backend settings are still loading" }).waitFor();
    assert.equal(await page.locator(".settings-modal").count(), 0);
    assert.equal(await composer.inputValue(), "Do a short task", "a rejected submit retains the draft");
    await page.clock.fastForward(15_001);
    await page.locator(".sidebar-load-error").waitFor();
    assert.equal(await page.locator(".sidebar-skeleton-wrap").count(), 0);
    assert.equal(bootstraps, 1, "timeouts do not multiply the stalled request budget");
    stall = false;
    await page.locator(".sidebar-load-error").getByRole("button", { name: "Retry", exact: true }).click();
    await page.locator('[data-run-id="fast"]').waitFor();
    assert.equal(await page.locator(".sidebar-load-error").count(), 0);
    await openSettings(page); assert.equal(await nodeModel(page).inputValue(), "test/old");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a stalled settings save releases busy state, preserves its draft and can retry without repository discovery", { timeout: 30_000 }, async () => {
  let stall = true, saves = 0;
  const { context, page, errors, calls } = await app(async (route, command, body) => {
    if (command !== "save_config") return false;
    saves++;
    if (!stall) await route.fulfill({ json: { result: { ...bootstrap, config: body.config, repositoryInfo: null } } });
    return true;
  });
  try {
    await page.locator('[data-run-id="fast"]').waitFor(); await openSettings(page);
    await nodeModel(page).selectOption("test/new");
    await page.locator(".save-config-btn").click(); await until(() => saves === 1);
    assert.equal(calls.filter(call => call.command === "detect_repository").length, 0);
    assert.equal(await page.locator(".save-config-btn").isDisabled(), true);
    await page.clock.fastForward(15_001);
    await page.waitForFunction(() => document.querySelector(".save-config-btn")?.disabled === false);
    assert.equal(await nodeModel(page).inputValue(), "test/new", "timed-out save retains the model draft");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("grapher_config")).model), "test/old");
    assert.match(await page.locator(".settings-modal").innerText(), /Saving settings timed out/);
    stall = false;
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(saves, 2);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("grapher_config")).model), "test/new");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("saving a Node Agent model synchronizes the failed Run and enables explicit Continue", { timeout: 30_000 }, async () => {
  const failedExecution = { id: "old-attempt", node: "task", revision: 1, attempt: 1, sessionId: "same-session",
    worktree: "/same-workspace", before: "base", after: null, status: "failed", output: "", outputBytes: 0,
    startedAt: 1, completedAt: 2 };
  let current = { ...empty, runId: "fast", config, planType: "graph", approved: true, phase: "needs_attention", canResume: false,
    graph: { originalGoal: "Recover with another model", nodes: [{ name: "task", task: "Finish the task" }], edges: [] },
    plan: { executionBatches: [["task"]], roots: ["task"], terminals: ["task"], warnings: [] },
    nodes: { task: { status: "failed", revision: 1, head: null, instruction: "", error: "Provider quota exhausted" } },
    executions: [failedExecution] };
  let saved, resumes = 0;
  const { context, page, errors, calls } = await app(async (route, command, body) => {
    let result;
    if (command === "bootstrap") result = { ...bootstrap, snapshot: current };
    else if (command === "history" || command === "snapshot" || command === "load_run") result = current;
    else if (command === "save_config") {
      assert.equal(body.runId, "fast", "settings target the visible conversation, not a backend default selection");
      saved = body.config;
      current = { ...current, canResume: true, nodes: { task: { ...current.nodes.task, modelConfig: saved.roleModels.nodeAgent } } };
      result = { ...bootstrap, config: saved, snapshot: current };
    } else if (command === "control") {
      assert.equal(body.action, "resume"); assert.equal(body.runId, "fast"); resumes++;
      current = { ...current, canResume: false, phase: "running", nodes: { task: { ...current.nodes.task, status: "running", error: null } },
        executions: [...current.executions, { ...failedExecution, id: "new-attempt", attempt: 2, status: "running", startedAt: 3, completedAt: null }] };
      result = current;
    } else if (command === "get_execution_output") {
      result = { runId: "fast", executionId: body.executionId, content: "", startOffset: 0, nextOffset: 0, totalBytes: 0,
        complete: body.executionId === "old-attempt", status: body.executionId === "old-attempt" ? "failed" : "running" };
    } else return false;
    await route.fulfill({ json: { result } }); return true;
  });
  try {
    await page.locator('[data-run-id="fast"]').click();
    await page.locator('.graph-canvas .react-flow__node[data-id="task"]').waitFor();
    assert.equal(await page.getByRole("button", { name: "Resume", exact: true }).count(), 0);
    await openSettings(page); await nodeModel(page).selectOption("test/new");
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    const continueButton = page.getByRole("button", { name: "Resume", exact: true });
    await continueButton.waitFor(); assert.equal(await continueButton.isEnabled(), true);
    assert.equal(resumes, 0, "saving does not resume automatically");
    assert.equal(current.nodes.task.status, "failed");
    assert.equal(current.config.model, "test/old", "the original Run config remains historical evidence");
    await continueButton.click(); await until(() => resumes === 1);
    await page.locator('.graph-canvas .react-flow__node[data-id="task"]').click();
    await page.getByText("model: test/new", { exact: true }).waitFor();
    assert.equal(calls.filter(call => call.command === "detect_repository").length, 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("model-specific thinking levels update inherited roles, remain independent and save only supported values", { timeout: 30_000 }, async () => {
  let saved;
  const otherProvider = { id: "other", name: "Other", methods: [], configured: true };
  const { context, page, errors } = await app(async (route, command, body) => {
    if (command === "provider_auth") {
      await route.fulfill({ json: { result: { ...catalog, providers: [...catalog.providers, otherProvider],
        models: [...catalog.models, { ...catalog.models[0], provider: "other" }] } } }); return true;
    }
    if (command !== "save_config") return false;
    saved = body.config;
    await route.fulfill({ json: { result: { ...bootstrap, config: saved } } }); return true;
  });
  try {
    await page.locator('[data-run-id="fast"]').waitFor(); await openSettings(page);
    const cards = page.locator(".role-model-card");
    const model = i => cards.nth(i).locator("select").first();
    const thinking = i => cards.nth(i).locator("select").nth(1);
    const levels = i => thinking(i).locator("option").evaluateAll(options => options.map(option => option.value));
    assert.deepEqual(await levels(0), ["off", "low", "high"]);
    await nodeModel(page).selectOption("test/new");
    for (const i of [0, 1, 2]) {
      assert.deepEqual(await levels(i), ["low", "high", "max"], "inherited model capabilities follow Node Agent");
      assert.equal(await thinking(i).inputValue(), "low", "Pi clamps unsupported off to low");
    }
    await thinking(0).selectOption("max");
    await model(1).selectOption("test/old"); await thinking(1).selectOption("high");
    await nodeModel(page).selectOption("test/plain");
    for (const i of [0, 2]) {
      assert.deepEqual(await levels(i), ["off"]);
      assert.equal(await thinking(i).isDisabled(), true);
      assert.equal(await thinking(i).inputValue(), "off");
    }
    assert.deepEqual(await levels(1), ["off", "low", "high"]);
    assert.equal(await thinking(1).inputValue(), "high", "an explicitly selected Planner model stays independent");
    await page.getByLabel("Filter available models by provider").selectOption("other");
    assert.equal(await nodeModel(page).inputValue(), "test/plain");
    assert.deepEqual(await levels(0), ["off"], "provider filtering does not change the selected model's capabilities");
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(saved.model, "test/plain"); assert.equal(saved.thinkingLevel, "off");
    assert.equal(saved.roleModels.planner.model, "test/old"); assert.equal(saved.roleModels.planner.thinkingLevel, "high");
    assert.equal(saved.roleModels.partitioner.thinkingLevel, "off");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("saving an incompatible legacy level persists the Pi-adjusted value displayed in the draft", { timeout: 30_000 }, async () => {
  const old = { ...config, thinkingLevel: "max" };
  let saved;
  const { context, page, errors } = await app(async (route, command, body) => {
    if (command === "bootstrap") {
      await route.fulfill({ json: { result: { ...bootstrap, config: old } } }); return true;
    }
    if (command !== "save_config") return false;
    saved = body.config;
    await route.fulfill({ json: { result: { ...bootstrap, config: saved } } }); return true;
  });
  try {
    await page.locator('[data-run-id="fast"]').waitFor(); await openSettings(page);
    const thinking = page.locator(".role-model-card").nth(0).locator("select").nth(1);
    assert.equal(await thinking.inputValue(), "high");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("grapher_config")).thinkingLevel), "max", "opening settings must not persist corrections");
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(saved.thinkingLevel, "high");
    assert.equal(saved.roleModels.nodeAgent.thinkingLevel, "high");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a stalled Provider catalog cannot leave settings controls permanently busy", { timeout: 30_000 }, async () => {
  let catalogs = 0;
  const { context, page, errors } = await app(async (_route, command) => {
    if (command === "provider_auth") { catalogs++; return true; }
    return false;
  });
  try {
    await page.locator('[data-run-id="fast"]').waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await until(() => catalogs > 0);
    assert.equal(await page.locator(".save-config-btn").isDisabled(), true);
    await page.clock.fastForward(15_001);
    await page.waitForFunction(() => document.querySelector(".save-config-btn")?.disabled === false);
    assert.match(await page.locator(".settings-modal").innerText(), /backend response timed out/i);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
