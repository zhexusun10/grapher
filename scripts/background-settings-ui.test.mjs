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

test("all Harness settings start checked and saved opt-outs survive reload", { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  let savedConfig = { ...config, maxParallel: 0, maxFeedback: 0 };
  delete savedConfig.autoApprove;
  const errors = [], saves = [];
  await context.addInitScript(({ repository }) => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Harness defaults", lastOpened: 1 }]));
  }, { repository });
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    if (command === "save_config") {
      savedConfig = route.request().postDataJSON().config;
      saves.push(savedConfig);
      return route.fulfill({ json: { result: { ...bootstrap, config: savedConfig } } });
    }
    const defaults = { bootstrap: { ...bootstrap, config: savedConfig }, history: conversation, snapshot: conversation,
      snapshot_if_changed: { version: "fixed", snapshot: null }, repository_status: { repository, valid: true, error: null },
      list_plannings: [], list_files: { files: [] }, list_skills: { skills: [] }, provider_auth: catalog,
      pi_extensions: { globalDirectory: "mock", extensions: [] }, environment_capabilities: { platform: "windows", arch: "x86_64", nativeWorkspace: true } };
    if (!(command in defaults)) errors.push(`Unexpected API: ${command}`);
    return route.fulfill({ json: { result: defaults[command] ?? null } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  const modes = page.locator(".landing-screen .prompt-box-mode-btn");
  const harnessCard = page.getByRole("region", { name: "Harness settings", exact: true });
  const checkboxes = harnessCard.getByRole("checkbox");
  const maxParallelInput = harnessCard.getByRole("spinbutton", { name: "Parallel agents", exact: true });
  const maxFeedbackInput = harnessCard.getByRole("spinbutton", { name: "Feedback budget", exact: true });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await modes.filter({ hasText: "Graph" }).waitFor();
    assert.deepEqual(await modes.allTextContents(), ["Serial", "Graph"]);
    await openSettings(page);
    assert.deepEqual(await checkboxes.evaluateAll(inputs => inputs.map(input => input.checked)), Array(5).fill(true));
    assert.equal(await maxParallelInput.inputValue(), "8", "legacy maxParallel=0 defaults to 8");
    assert.equal(await maxParallelInput.getAttribute("min"), "2");
    assert.equal(await maxParallelInput.getAttribute("max"), "40");
    assert.equal(await maxFeedbackInput.inputValue(), "4", "legacy maxFeedback=0 defaults to 4");
    assert.equal(await maxFeedbackInput.getAttribute("min"), "2");
    assert.equal(await maxFeedbackInput.getAttribute("max"), "40");
    assert.equal(await page.locator('.role-model-group[aria-label="Partitioner model configuration"]').count(), 0);
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    for (const key of ["autoApprove", "postTaskReview", "plannerWriteTools", "isolateParallelNodes"]) {
      assert.equal(saves[0][key], true, `${key} saves the enabled default`);
    }
    assert.equal(saves[0].maxParallel, 8);
    assert.equal(saves[0].maxFeedback, 4);
    assert.equal(await page.evaluate(() => localStorage.getItem("grapher_hide_auto_mode_v1")), "1");

    await openSettings(page);
    for (const checkbox of await checkboxes.all()) await checkbox.uncheck();
    await maxParallelInput.fill("1");
    await maxParallelInput.blur();
    assert.equal(await maxParallelInput.inputValue(), "2", "values below 2 clamp to minimum 2");
    await maxParallelInput.fill("99");
    await maxParallelInput.blur();
    assert.equal(await maxParallelInput.inputValue(), "40", "values above 40 clamp to maximum 40");
    await maxParallelInput.fill("24");
    await maxFeedbackInput.fill("1");
    await maxFeedbackInput.blur();
    assert.equal(await maxFeedbackInput.inputValue(), "2", "feedback budget below 2 clamps to minimum 2");
    await maxFeedbackInput.fill("99");
    await maxFeedbackInput.blur();
    assert.equal(await maxFeedbackInput.inputValue(), "40", "feedback budget above 40 clamps to maximum 40");
    await maxFeedbackInput.fill("16");
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    for (const key of ["autoApprove", "postTaskReview", "plannerWriteTools", "isolateParallelNodes"]) {
      assert.equal(saves[1][key], false, `${key} saves an explicit opt-out`);
    }
    assert.equal(saves[1].maxParallel, 24);
    assert.equal(saves[1].maxFeedback, 16);
    await page.reload({ waitUntil: "domcontentloaded" });
    await modes.filter({ hasText: "Auto" }).waitFor();
    await openSettings(page);
    assert.deepEqual(await checkboxes.evaluateAll(inputs => inputs.map(input => input.checked)), Array(5).fill(false));
    assert.equal(await maxParallelInput.inputValue(), "24");
    assert.equal(await maxFeedbackInput.inputValue(), "16");
    assert.equal(await page.evaluate(() => localStorage.getItem("grapher_hide_auto_mode_v1")), "0");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("hiding Auto stages with Settings, preserves Partitioner and submits only visible modes", { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  const partitioner = { model: "test/partitioner", thinkingLevel: "high" };
  let savedConfig = { ...config, roleModels: { partitioner } }, failSave = true;
  const errors = [], saves = [];
  await context.addInitScript(({ repository }) => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Auto visibility", lastOpened: 1 }]));
    if (!localStorage.getItem("grapher_plan_mode")) localStorage.setItem("grapher_plan_mode", "auto");
    if (localStorage.getItem("grapher_hide_auto_mode_v1") === null) localStorage.setItem("grapher_hide_auto_mode_v1", "0");
  }, { repository });
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (command === "save_config") {
      saves.push(body.config);
      if (failSave) return route.fulfill({ status: 500, json: { error: "Mock save failed" } });
      savedConfig = body.config;
      return route.fulfill({ json: { result: { ...bootstrap, config: savedConfig } } });
    }
    if (command === "plan_goal_stream") return route.fulfill({ status: 500, json: { error: "Mock planning rejected" } });
    const defaults = { bootstrap: { ...bootstrap, config: savedConfig }, history: conversation, snapshot: conversation,
      snapshot_if_changed: { version: "fixed", snapshot: null }, repository_status: { repository, valid: true, error: null },
      list_plannings: [], list_files: { files: [] }, list_skills: { skills: [] }, provider_auth: { ...catalog,
        models: [...catalog.models, { ...catalog.models[0], id: "partitioner", thinkingLevels: ["low", "high"] }] },
      pi_extensions: { globalDirectory: "mock", extensions: [] }, environment_capabilities: { platform: "windows", arch: "x86_64", nativeWorkspace: true } };
    if (!(command in defaults)) errors.push(`Unexpected API: ${command}`);
    return route.fulfill({ json: { result: defaults[command] ?? null } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  const modes = page.locator(".landing-screen .prompt-box-mode-btn");
  const partitionerSettings = page.locator('.role-model-group[aria-label="Partitioner model configuration"]');
  const toggle = page.getByRole("checkbox", { name: "Hide Auto mode", exact: true });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await modes.filter({ hasText: "Auto" }).waitFor();
    await page.locator(".landing-screen textarea").fill("Keep this mode draft");
    await page.evaluate(() => { window.originalComposer = document.querySelector(".landing-screen textarea"); });
    assert.equal(await modes.filter({ hasText: "Auto" }).getAttribute("aria-pressed"), "true");
    await openSettings(page);
    assert.equal(await toggle.isChecked(), false);
    const planningCard = page.getByRole("region", { name: "Harness settings", exact: true });
    assert.deepEqual(await planningCard.getByRole("checkbox").evaluateAll(inputs => inputs.map(input => input.getAttribute("aria-label"))), [
      "Hide Auto mode", "Auto approve Planner graphs", "Post-task Planner review",
      "Isolate parallel node workspaces", "Mount Planner write and edit tools",
    ], "planning, approval, workspace and Planner file-tool options share one card");
    assert.equal(await planningCard.locator(".role-model-settings").count(), 0, "execution settings remain separate from model settings");
    assert.equal(await planningCard.getByRole("checkbox", { name: "Isolate parallel node workspaces", exact: true })
      .evaluate(input => input.closest("label").querySelector("small").textContent),
      "Each dispatch batch shares source with up to 2 nodes and uses private workspaces with more than 2. Turn off to share source in every batch. Concurrent edits may overwrite each other.");
    assert.equal(await partitionerSettings.locator("select").first().inputValue(), partitioner.model);
    await toggle.check();
    assert.equal(await partitionerSettings.count(), 0, "the Settings draft previews hiding Partitioner");
    assert.equal(await page.locator(".role-model-group").count(), 2);
    assert.equal(await modes.filter({ hasText: "Auto" }).count(), 1, "the live composer changes only after saving");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await openSettings(page);
    assert.equal(await toggle.isChecked(), false, "Cancel discards the visibility draft");
    assert.equal(await partitionerSettings.count(), 1);
    await toggle.check();
    await page.locator(".save-config-btn").click();
    await page.getByRole("alert").filter({ hasText: "Mock save failed" }).waitFor();
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await modes.filter({ hasText: "Auto" }).count(), 1, "a failed save leaves Auto available");
    assert.equal(await page.evaluate(() => localStorage.getItem("grapher_hide_auto_mode_v1")), "0");

    failSave = false;
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.deepEqual(await modes.allTextContents(), ["Serial", "Graph"]);
    assert.equal(await modes.filter({ hasText: "Graph" }).getAttribute("aria-pressed"), "true");
    assert.equal(await page.evaluate(() => localStorage.getItem("grapher_hide_auto_mode_v1")), "1");
    assert.equal(await page.evaluate(() => localStorage.getItem("grapher_plan_mode")), "graph");
    assert.equal(await page.locator(".landing-screen textarea").inputValue(), "Keep this mode draft");
    assert.equal(await page.evaluate(() => window.originalComposer === document.querySelector(".landing-screen textarea")), true);
    assert.deepEqual(savedConfig.roleModels.partitioner, partitioner);

    await page.evaluate(() => localStorage.setItem("grapher_plan_mode", "auto"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await modes.filter({ hasText: "Graph" }).waitFor();
    assert.equal(await modes.filter({ hasText: "Auto" }).count(), 0, "the preference survives reload");
    await page.waitForFunction(() => localStorage.getItem("grapher_plan_mode") === "graph");
    await openSettings(page);
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await partitionerSettings.count(), 0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    const request = page.waitForRequest("**/api/plan_goal_stream");
    const response = page.waitForResponse("**/api/plan_goal_stream");
    await page.locator(".landing-screen textarea").fill("Use the visible Graph mode");
    await page.locator(".landing-screen textarea").press("Enter");
    assert.equal((await request).postDataJSON().mode, "graph", "a stale stored Auto mode must not reach the backend");
    await response;

    await page.reload({ waitUntil: "domcontentloaded" });
    await openSettings(page);
    await toggle.uncheck();
    assert.equal(await partitionerSettings.locator("select").first().inputValue(), partitioner.model);
    assert.equal(await partitionerSettings.locator("select").nth(1).inputValue(), partitioner.thinkingLevel);
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(await modes.filter({ hasText: "Auto" }).count(), 1, "turning off the option restores Auto");
    assert.equal(await modes.filter({ hasText: "Graph" }).getAttribute("aria-pressed"), "true");
    await modes.filter({ hasText: "Serial" }).click();
    await openSettings(page);
    await toggle.check();
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(await modes.filter({ hasText: "Serial" }).getAttribute("aria-pressed"), "true", "an explicit Serial choice is preserved");
    assert.equal(await modes.filter({ hasText: "Auto" }).count(), 0);
    assert.ok(saves.every(saved => !("hideAutoMode" in saved)), "visibility stays out of backend configuration");
    assert.ok(saves.every(saved => JSON.stringify(saved.roleModels.partitioner) === JSON.stringify(partitioner)), "hiding Partitioner never removes its saved settings");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

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
    const uiCard = page.getByRole("region", { name: "UI settings", exact: true });
    assert.equal(await uiCard.getByRole("checkbox", { name: "Auto-expand chain of thought while running", exact: true }).count(), 1,
      "reasoning display and home background share the UI settings card");
    const backgroundOptions = uiCard.getByRole("group", { name: "Home background", exact: true });
    const animated = backgroundOptions.getByRole("radio", { name: /Animated paths/ });
    const pattern = backgroundOptions.getByRole("radio", { name: /Dot pattern/ });
    assert.equal(await pattern.isChecked(), true);
    assert.deepEqual(await page.locator('input[name="landing-background"]').evaluateAll(inputs => inputs.map(input => input.value)), ["dots", "paths"], "the default option appears first");
    const radioBorder = radio => radio.evaluate(input => getComputedStyle(input).borderColor);
    const originalBorder = await radioBorder(pattern);
    assert.equal(originalBorder, await radioBorder(animated), "selected and unselected radio outlines match");
    assert.equal(await pattern.evaluate(input => {
      const probe = document.createElement("span");
      probe.style.color = "var(--brand-default)";
      input.parentElement.append(probe);
      const hasBlueDot = getComputedStyle(input).backgroundImage.includes(getComputedStyle(probe).color);
      probe.remove();
      return hasBlueDot;
    }), true, "the selected radio keeps its blue dot");
    await animated.check();
    assert.equal(await radioBorder(animated), originalBorder, "the outline stays unchanged after selection");
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
    await page.keyboard.press("ArrowRight");
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
