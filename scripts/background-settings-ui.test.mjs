import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

let server, browser, origin;
const repository = "/background-test";
const config = { repository, model: "test/model", thinkingLevel: "off", maxParallel: 2, maxFeedback: 3, autoApprove: false };
const empty = { runId: "", config: null, phase: "draft", graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
  executions: [], events: [], mergers: [], plan: null, approved: false, paused: false, base: "", feedbackCounts: {} };
const conversation = { ...empty, runId: "saved", config, phase: "completed", graph: { ...empty.graph, originalGoal: "Saved conversation" } };
const bootstrap = { config, snapshot: empty, runs: ["saved"], repositoryInfo: { path: repository, name: "Background", branch: "main", clean: true, head: "" }, dataPath: "/mock", envOverrides: {} };
const catalog = { providers: [{ id: "test", name: "Test", methods: [], configured: true }], warning: null,
  models: [{ provider: "test", id: "model", name: "Model", api: "mock", available: true, contextWindow: 1000, thinkingLevels: ["off"] }] };

before(async () => {
  server = await createServer({ cacheDir: "node_modules/.vite-background-settings", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false } });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function openSettings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-modal").waitFor();
  await page.waitForFunction(() => document.querySelector(".save-config-btn")?.disabled === false);
}

const paths = page => page.locator(".app-background-root > .relative > .absolute .floating-path");
const dots = page => page.locator(".landing-title-dot-pattern svg:has(pattern)");

test("home background saves only after acceptance, persists, and preserves the app shell", { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  let failSave = true;
  const errors = [], saves = [];
  await context.addInitScript(({ repository, config }) => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Background", lastOpened: 1 }]));
    localStorage.setItem("grapher_config", JSON.stringify(config));
  }, { repository, config });
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON();
    if (command === "save_config") {
      saves.push(body.config);
      if (failSave) return route.fulfill({ status: 500, json: { error: "Mock save failed" } });
      return route.fulfill({ json: { result: { ...bootstrap, config: body.config } } });
    }
    const defaults = { bootstrap, history: conversation, snapshot: conversation,
      snapshot_if_changed: { version: "fixed", snapshot: null }, repository_status: { repository, valid: true, error: null },
      list_plannings: [], list_files: { files: [] }, list_skills: { skills: [] }, provider_auth: catalog,
      pi_extensions: { globalDirectory: "mock", extensions: [] }, environment_capabilities: { platform: "windows", arch: "x86_64", nativeWorkspace: true } };
    if (!(command in defaults)) errors.push(`Unexpected API: ${command}`);
    return route.fulfill({ json: { result: defaults[command] ?? null } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(".landing-screen textarea").fill("Keep this draft");
    await dots(page).waitFor();
    assert.equal(await paths(page).count(), 0);
    assert.equal(await dots(page).count(), 1, "the static dot pattern is the default");
    await page.evaluate(() => { window.originalComposer = document.querySelector(".landing-screen textarea"); });

    await openSettings(page);
    const animated = page.getByRole("radio", { name: /Animated paths/ });
    const pattern = page.getByRole("radio", { name: /Dot pattern/ });
    assert.equal(await pattern.isChecked(), true);
    await animated.check();
    assert.equal(await dots(page).count(), 1, "a draft does not change the live background");
    assert.equal(await paths(page).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("grapher_landing_background_v1")), null);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await openSettings(page);
    assert.equal(await pattern.isChecked(), true, "cancel discards the draft");
    await animated.check();
    await page.locator(".save-config-btn").click();
    await page.getByRole("alert").filter({ hasText: "Mock save failed" }).waitFor();
    assert.equal(await animated.isChecked(), true, "a failed save keeps the draft for retry");
    assert.equal(await dots(page).count(), 1);
    assert.equal(await paths(page).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("grapher_landing_background_v1")), null);

    failSave = false;
    await pattern.check();
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await dots(page).waitFor();
    assert.equal(await paths(page).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("grapher_landing_background_v1")), "dots");
    assert.ok(saves.every(saved => !("landingBackground" in saved)), "display preferences stay out of backend configuration");
    assert.equal(await page.evaluate(() => window.originalComposer === document.querySelector(".landing-screen textarea")), true);
    assert.equal(await page.locator(".landing-screen textarea").inputValue(), "Keep this draft");

    await page.locator('[data-run-id="saved"]').click();
    await page.waitForFunction(() => !document.querySelector(".app-background-root").classList.contains("landing-active"));
    await dots(page).waitFor({ state: "detached" });
    assert.equal(await page.locator(".main").evaluate(element => getComputedStyle(element).overflow), "hidden", "the workbench retains its clipping");
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".app-background-root").classList.contains("landing-active"));
    await dots(page).waitFor();

    await page.reload({ waitUntil: "domcontentloaded" });
    await dots(page).waitFor();
    await openSettings(page);
    assert.equal(await pattern.isChecked(), true, "the selection survives a reload");
    await page.setViewportSize({ width: 390, height: 844 });
    await pattern.scrollIntoViewIfNeeded();
    const radioBox = await pattern.boundingBox();
    assert.ok(radioBox && radioBox.x >= 0 && radioBox.x + radioBox.width <= 390, "options remain reachable on narrow screens");
    await pattern.focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await animated.isChecked(), true, "native radio options support keyboard navigation");
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await paths(page).first().waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("grapher_landing_background_v1")), "paths");

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
