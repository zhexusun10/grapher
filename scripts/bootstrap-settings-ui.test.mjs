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
  models: ["old", "new"].map(id => ({ provider: "test", id, name: id, api: "mock", contextWindow: 1000, available: true })) };

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
const nodeModel = page => page.locator(".role-model-card").nth(2).locator("select").first();
async function openSettings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-modal").waitFor();
  await page.waitForFunction(() => document.querySelector(".save-config-btn")?.disabled === false);
}
async function until(check) {
  const end = Date.now() + 8_000;
  while (!await check()) { assert.ok(Date.now() < end, "expected request/state did not arrive"); await new Promise(done => setTimeout(done, 20)); }
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
