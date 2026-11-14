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
  server = await createServer({ cacheDir: "node_modules/.vite-bootstrap-settings", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null } });
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function app(handler, projects = [{ id: repository, path: repository, name: "Responsiveness", lastOpened: 1 }], cachedRuns, connectedEvents = false, reducedMotion = "reduce") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US", reducedMotion });
  await context.addInitScript(({ projects, config, cachedRuns, connectedEvents }) => {
    localStorage.setItem("grapher_language_v1", "en");
    if (projects !== null) localStorage.setItem("grapher_projects", JSON.stringify(projects));
    if (cachedRuns) localStorage.setItem("grapher_workspace_runs", JSON.stringify(cachedRuns));
    localStorage.setItem("grapher_config", JSON.stringify({ ...config, model: "stale/browser-model" }));
    if (connectedEvents) {
      // Connected but silent: only watchdog reads can discover durable changes.
      window.EventSource = class {
        static CLOSED = 2;
        constructor() {
          this.readyState = 0;
          setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0);
        }
        addEventListener() {}
        close() { this.readyState = 2; }
      };
    }
  }, { projects, config, cachedRuns, connectedEvents });
  const errors = [], calls = [];
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    calls.push({ command, body });
    if (await handler(route, command, body)) return;
    const defaults = { bootstrap, history: fast, snapshot: fast, snapshot_if_changed: { version: "fixed", snapshot: null },
      repository_status: { repository, valid: true, error: null }, list_plannings: [], list_files: { files: [] }, list_skills: { skills: [] },
      provider_auth: catalog, pi_extensions: { globalDirectory: "mock", extensions: [] }, environment_capabilities: { platform: "windows", arch: "x86_64", nativeWorkspace: true } };
    if (!Object.hasOwn(defaults, command)) errors.push(`Unexpected API: ${command}`);
    await route.fulfill({ headers: connectedEvents ? { "x-grapher-events": "1" } : {}, json: { result: defaults[command] ?? null } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(8_000);
  // Cold Vite transforms can be slower than an individual UI action when
  // several browser suites run in parallel; this is not an app latency check.
  page.setDefaultNavigationTimeout(20_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.clock.install();
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    return { context, page, errors, calls };
  } catch (error) {
    await context.close();
    throw error;
  }
}
const nodeModel = page => page.locator(".role-model-group").nth(0).locator("select").first();
async function openSettings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-modal").waitFor();
  await page.waitForFunction(() => document.querySelector(".save-config-btn")?.disabled === false);
}
async function until(check) {
  const end = Date.now() + 8_000;
  while (!await check()) { assert.ok(Date.now() < end, "expected request/state did not arrive"); await new Promise(completed => setTimeout(completed, 20)); }
}

test("Feedback defaults off and is staged until saved, then survives reopening and reload", { timeout: 30_000 }, async () => {
  let saved = { ...config };
  let saves = 0;
  const { context, page, errors } = await app(async (route, command, body) => {
    if (command === "bootstrap" || command === "save_config") {
      if (command === "save_config") { saved = body.config; saves++; }
      await route.fulfill({ json: { result: { ...bootstrap, config: saved } } });
      return true;
    }
    return false;
  });
  try {
    await openSettings(page);
    const feedback = () => page.getByRole("checkbox", { name: "Enable Feedback", exact: true });
    const budget = () => page.getByRole("spinbutton", { name: "Feedback budget", exact: true });
    assert.equal(await feedback().isChecked(), false);
    assert.equal(await budget().isDisabled(), true);
    await feedback().check();
    assert.equal(await budget().isEnabled(), true);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await openSettings(page);
    assert.equal(await feedback().isChecked(), false);
    assert.equal(saves, 0);
    await feedback().check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".settings-modal").waitFor({ state: "hidden" });
    assert.equal(saved.feedbackEnabled, true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await openSettings(page);
    assert.equal(await feedback().isChecked(), true);
    await feedback().uncheck();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".settings-modal").waitFor({ state: "hidden" });
    assert.equal(saved.feedbackEnabled, false);
    assert.equal(saved.maxFeedback, config.maxFeedback);
    assert.equal(saves, 2);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Feedback opt-out preserves old session edges and hides the legend only for disabled sessions", { timeout: 30_000 }, async () => {
  let saved = { ...config, feedbackEnabled: true };
  const makeRun = (runId, enabled, legacy = false) => ({
    ...empty, runId, config: { ...config, ...(legacy ? {} : { feedbackEnabled: enabled }) },
    planType: "graph", approved: true, paused: true, phase: "paused",
    graph: { originalGoal: `Goal ${runId}`, nodes: [{ name: "a", task: "Build" }, { name: "b", task: "Review" }],
      edges: [{ from: "a", to: "b", feedback: false }, ...(enabled ? [{ from: "b", to: "a", feedback: true }] : [])] },
    nodes: { a: { status: "waiting", revision: 1 }, b: { status: "waiting", revision: 1 } },
  });
  const runs = { fast: makeRun("fast", true), disabled: makeRun("disabled", false), legacy: makeRun("legacy", true, true) };
  const { context, page, errors } = await app(async (route, command, body) => {
    let result;
    if (command === "bootstrap") result = { ...bootstrap, config: saved, snapshot: runs.fast, runs: Object.keys(runs) };
    else if (["history", "snapshot", "load_run"].includes(command)) result = runs[body.runId] ?? runs.fast;
    else if (command === "save_config") {
      saved = body.config;
      result = { ...bootstrap, config: saved, snapshot: runs[body.runId], runs: Object.keys(runs) };
    } else return false;
    await route.fulfill({ json: { result } }); return true;
  });
  const edges = () => page.locator('.graph-canvas .react-flow__edge');
  const legend = () => page.locator('.graph-note');
  try {
    await page.locator('[data-run-id="fast"]').click();
    await until(async () => await edges().count() === 2);
    assert.equal(await legend().count(), 1);
    await openSettings(page);
    await page.getByRole("checkbox", { name: "Enable Feedback", exact: true }).uncheck();
    await page.locator('.save-config-btn').click();
    await page.locator('.settings-modal').waitFor({ state: "hidden" });
    assert.equal(saved.feedbackEnabled, false);
    assert.equal(await edges().count(), 2, "saving opt-out cannot hide a still-active historical route");
    assert.equal(await legend().count(), 1, "the old session retains its edge explanation");
    await page.locator('[data-run-id="disabled"]').click();
    await until(async () => await edges().count() === 1);
    assert.equal(await legend().count(), 0, "the entire edge-type legend is absent for a disabled session");
    await page.locator('[data-run-id="legacy"]').click();
    await until(async () => await edges().count() === 2);
    assert.equal(await legend().count(), 1, "legacy routes remain visible even without the new setting field");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-run-id="fast"]').click();
    await until(async () => await edges().count() === 2);
    assert.equal(await legend().count(), 1);
    await openSettings(page);
    assert.equal(await page.getByRole("checkbox", { name: "Enable Feedback", exact: true }).isChecked(), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

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
    await page.clock.runFor(1);
    assert.equal(await page.locator('[data-run-id="fast"]').count(), 1);
    assert.equal(await page.locator(".runs-list").getByRole("alert").count(), 0);
    assert.equal(await page.locator(".runs-list").getByRole("button", { name: "Retry", exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("prewarmed summaries render every sidebar card without histories or repository status", { timeout: 30_000 }, async () => {
  const summaries = [
    { runId: "slow", repository, title: "Ready without history", planType: "serial", phase: "completed", hasActiveExecutions: false },
    { runId: "blank", repository, title: "", planType: "graph", phase: "completed", hasActiveExecutions: false },
    { runId: "foreign", repository: "/other", title: "Other workspace", phase: "completed", hasActiveExecutions: false },
  ];
  const { context, page, errors, calls } = await app(async (route, command) => {
    if (command === "bootstrap") {
      await route.fulfill({ json: { result: { ...bootstrap, snapshot: empty, conversations: summaries,
        runs: summaries.map(item => item.runId), repositoryInfo: null } } });
      return true;
    }
    if (command === "history" || command === "detect_repository") return true; // deliberately stalled
    return false;
  }, undefined, { [repository]: ["fast", "foreign"] });
  try {
    await page.locator('[data-run-id="slow"]').waitFor();
    await page.locator('[data-run-id="blank"]').waitFor();
    assert.equal(await page.locator('[data-run-id="foreign"]').count(), 0);
    assert.equal(await page.locator('[data-run-id="fast"]').count(), 0, "stale browser cards are not authoritative");
    assert.deepEqual(await page.locator(".run-item").evaluateAll(items => items.map(item => item.dataset.runId)), ["slow", "blank"]);
    assert.equal(await page.locator(".sidebar-skeleton-wrap").count(), 0);
    assert.equal(await page.locator('[data-run-id="blank"] .is-resolving').count(), 0, "a blank title is resolved");
    assert.equal(calls.filter(call => call.command === "history").length, 0);
    assert.equal(calls.filter(call => call.command === "detect_repository").length, 1, "Git status loads independently");
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("grapher_workspace_runs"))), {
      [repository]: ["slow", "blank"], "/other": ["foreign"],
    });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("sidebar summaries seed live status and watchdogs without polling settled Runs", { timeout: 30_000 }, async () => {
  const snapshots = {
    done: { ...fast, runId: "done" },
    background: { ...fast, runId: "background", phase: "running" },
    standalone: { ...fast, runId: "standalone", mergers: [{ id: "merger", status: "running", output: "" }] },
  };
  const summaries = Object.values(snapshots).map(snapshot => ({
    runId: snapshot.runId, repository, title: snapshot.runId, phase: snapshot.phase,
    hasActiveExecutions: snapshot.runId === "standalone",
  }));
  const { context, page, errors, calls } = await app(async (route, command, body) => {
    if (command === "bootstrap") {
      await route.fulfill({ headers: { "x-grapher-events": "1" }, json: { result: {
        ...bootstrap, snapshot: empty, conversations: summaries, runs: Object.keys(snapshots),
      } } });
      return true;
    }
    if (command === "snapshot_if_changed") {
      const snapshot = snapshots[body.runId];
      await route.fulfill({ json: { result: { version: snapshot.phase, snapshot } } });
      return true;
    }
    return false;
  }, undefined, undefined, true);
  try {
    await page.locator('[data-run-id="background"] .running-pulse').waitFor();
    snapshots.background = { ...snapshots.background, phase: "completed" };
    // No SSE change is delivered: the bounded watchdog must see completion.
    await page.clock.runFor(4500);
    await until(async () => await page.locator('[data-run-id="background"] .running-pulse').count() === 0);
    const polls = calls.filter(call => call.command === "snapshot_if_changed").map(call => call.body.runId);
    assert.ok(polls.includes("background"));
    assert.ok(polls.includes("standalone"), "a running standalone Merger is watched even in completed phase");
    assert.equal(polls.includes("done"), false);
    assert.equal(calls.filter(call => call.command === "history").length, 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("sidebar keeps the live dot through planning, follow-ups and standalone Mergers", { timeout: 30_000 }, async () => {
  const running = { id: "merger", node: "merger", status: "running", output: "" };
  const snapshots = {
    // The Planner turn owns the card before any node executes.
    planning: { ...fast, runId: "planning", phase: "planning" },
    // Source-direct work keeps `followup` while its executions still write.
    followup: { ...fast, runId: "followup", phase: "followup", executions: [{ ...running, node: "edit" }] },
    // A settled source-direct edit also leaves `followup` behind it.
    edited: { ...fast, runId: "edited", phase: "followup" },
    // A standalone publication Merger leaves the Run phase `completed`.
    standalone: { ...fast, runId: "standalone", mergers: [running] },
    settled: { ...fast, runId: "settled" },
  };
  const summaries = [
    { runId: "planning", phase: "planning", hasActiveExecutions: false },
    { runId: "followup", phase: "followup", hasActiveExecutions: true },
    { runId: "edited", phase: "followup", hasActiveExecutions: false },
    { runId: "standalone", phase: "completed", hasActiveExecutions: true },
    { runId: "settled", phase: "completed", hasActiveExecutions: false },
  ].map(item => ({ ...item, repository, title: item.runId }));
  const { context, page, errors } = await app(async (route, command, body) => {
    if (command === "bootstrap") {
      await route.fulfill({ json: { result: { ...bootstrap, snapshot: snapshots.settled,
        conversations: summaries, runs: summaries.map(item => item.runId) } } });
      return true;
    }
    if (command === "snapshot_if_changed") {
      const snapshot = snapshots[body.runId];
      await route.fulfill({ json: { result: { version: snapshot.phase, snapshot } } });
      return true;
    }
    return false;
  }, undefined, undefined, true);
  try {
    for (const runId of ["planning", "followup", "standalone"]) {
      await page.locator(`[data-run-id="${runId}"] .running-pulse`).waitFor();
    }
    assert.equal(await page.locator('[data-run-id="settled"] .run-dot').count(), 0, "a settled Run keeps its card quiet");
    assert.equal(await page.locator('[data-run-id="edited"] .run-dot').count(), 0, "a settled source-direct edit is not live work");
    snapshots.standalone = { ...snapshots.standalone, mergers: [{ ...running, status: "success" }] };
    // No SSE change is delivered: the bounded watchdog must retire the dot.
    await page.clock.runFor(4500);
    await until(async () => await page.locator('[data-run-id="standalone"] .running-pulse').count() === 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("sidebar preserves unavailable cached cards but removes confirmed stale cards", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await app(async (route, command) => {
    if (command !== "bootstrap") return false;
    await route.fulfill({ json: { result: { ...bootstrap, snapshot: empty,
      conversations: [{ runId: "healthy", repository, title: "Healthy", phase: "completed", hasActiveExecutions: false }],
      unavailableConversationIds: ["damaged"],
    } } });
    return true;
  }, undefined, { [repository]: ["damaged", "deleted"] });
  try {
    await page.locator('[data-run-id="healthy"]').waitFor();
    assert.equal(await page.locator('[data-run-id="damaged"]').count(), 1);
    assert.equal(await page.locator('[data-run-id="deleted"]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("first-launch workspace discovery is asynchronous and restores the detected workspace", { timeout: 30_000 }, async () => {
  let discovery;
  const fresh = { ...bootstrap, config: { ...config, repository: "" }, snapshot: empty, repositoryInfo: null,
    conversations: [{ runId: "discovered", repository: "/discovered", title: "Discovered", phase: "completed", hasActiveExecutions: false }] };
  const { context, page, errors, calls } = await app(async (route, command, body) => {
    if (command === "bootstrap") { await route.fulfill({ json: { result: fresh } }); return true; }
    if (command === "detect_repository") { discovery = route; return true; }
    if (command === "save_config") {
      await route.fulfill({ json: { result: { ...fresh, config: body.config } } }); return true;
    }
    return false;
  }, null);
  try {
    await until(() => !!discovery);
    assert.equal(calls.find(call => call.command === "detect_repository").body.path, null);
    assert.equal(await page.locator(".sidebar-skeleton-wrap").count(), 0, "discovery cannot block the sidebar");
    await discovery.fulfill({ json: { result: { ...info, path: "/discovered", name: "Discovered workspace" } } });
    await page.locator('[data-run-id="discovered"]').waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("grapher_config")).repository), "/discovered");
    assert.equal(calls.filter(call => call.command === "save_config").length, 0, "discovery must not overwrite model defaults");
    assert.equal(await page.locator(".project-workspace-item").count(), 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("first-launch discovery cannot be overwritten by an older settings response", { timeout: 30_000 }, async () => {
  let discovery, saving;
  const fresh = { ...bootstrap, config: { ...config, repository: "" }, snapshot: empty, repositoryInfo: null, conversations: [] };
  const { context, page, errors } = await app(async (route, command, body) => {
    if (command === "bootstrap") { await route.fulfill({ json: { result: fresh } }); return true; }
    if (command === "detect_repository") { discovery = route; return true; }
    if (command === "save_config") { saving = { route, config: body.config }; return true; }
    return false;
  }, null);
  try {
    await until(() => !!discovery);
    await openSettings(page);
    await nodeModel(page).selectOption("test/new");
    await page.locator(".save-config-btn").click();
    await until(() => !!saving);
    assert.equal(saving.config.maxFeedback, 3, "saving preserves the configured feedback budget");
    await discovery.fulfill({ json: { result: { ...info, path: "/discovered" } } });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("grapher_config")).repository === "/discovered");
    await saving.route.fulfill({ json: { result: { ...fresh, config: saving.config } } });
    await page.waitForFunction(() => document.querySelector(".save-config-btn")?.disabled === false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("grapher_config")).repository), "/discovered");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("first-launch discovery never restores a deliberately empty workspace list", { timeout: 30_000 }, async () => {
  const { context, page, errors, calls } = await app(async (route, command) => {
    if (command !== "bootstrap") return false;
    await route.fulfill({ json: { result: { ...bootstrap, config: { ...config, repository: "" },
      snapshot: empty, repositoryInfo: null, conversations: [] } } });
    return true;
  }, []);
  try {
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("grapher_config")).repository === "");
    assert.equal(calls.filter(call => call.command === "detect_repository").length, 0);
    assert.equal(await page.locator(".project-workspace-item").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a cold browser uses the configured workspace before Git discovery finishes", { timeout: 30_000 }, async () => {
  const { context, page, errors, calls } = await app(async (route, command) => {
    if (command === "bootstrap") {
      await route.fulfill({ json: { result: { ...bootstrap, snapshot: empty, repositoryInfo: null,
        conversations: [{ runId: "cold", repository, title: "Cold browser conversation" }] } } });
      return true;
    }
    if (command === "detect_repository") return true;
    return false;
  }, null);
  try {
    await page.locator('[data-run-id="cold"]').waitFor();
    assert.equal(await page.locator(".project-workspace-item").count(), 1);
    assert.equal(await page.locator(".sidebar-skeleton-wrap").count(), 0);
    assert.equal(calls.filter(call => call.command === "history").length, 0);
    assert.equal(calls.filter(call => call.command === "detect_repository").length, 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("empty authoritative summary index removes stale cached cards without requesting history", { timeout: 30_000 }, async () => {
  const { context, page, errors, calls } = await app(async (route, command) => {
    if (command !== "bootstrap") return false;
    await route.fulfill({ json: { result: { ...bootstrap, snapshot: empty, conversations: [] } } });
    return true;
  }, undefined, { [repository]: ["fast"] });
  try {
    await page.locator(".run-placeholder").waitFor();
    assert.equal(await page.locator(".sidebar-skeleton-wrap").count(), 0);
    assert.equal(calls.filter(call => call.command === "history").length, 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("conversation settings stay scoped and new conversations use defaults", { timeout: 30_000 }, async () => {
  const globalConfig = { ...config, model: "test/plain" };
  const other = { ...fast, runId: "other", phase: "completed",
    graph: { ...fast.graph, originalGoal: "Other conversation" },
    config: { ...config, model: "test/old" },
    modelConfig: { model: "test/new", thinkingLevel: "high" } };
  const snapshots = { fast, other };
  const { context, page, errors } = await app(async (route, command, body) => {
    if (command === "bootstrap") {
      await route.fulfill({ json: { result: { ...bootstrap, config: globalConfig, snapshot: fast, runs: ["fast", "other"] } } });
      return true;
    }
    if (command === "history" || command === "snapshot") {
      await route.fulfill({ json: { result: snapshots[body.runId] || fast } }); return true;
    }
    return false;
  });
  const openConversation = async id => {
    await page.locator(`[data-run-id="${id}"]`).click();
    await page.waitForFunction(id => {
      const item = document.querySelector(`[data-run-id="${id}"]`);
      return item?.classList.contains("chosen") && !item.classList.contains("is-loading");
    }, id);
  };
  const thinking = () => page.locator(".role-model-group").nth(0).locator("select").nth(1);
  try {
    await page.locator('[data-run-id="fast"]').waitFor();
    await page.locator('[data-run-id="other"]').waitFor();
    await openConversation("other");
    await openSettings(page);
    assert.equal(await nodeModel(page).inputValue(), "test/new", "the conversation override is loaded");
    assert.equal(await thinking().inputValue(), "high");
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });

    await openConversation("fast");
    await openSettings(page);
    assert.equal(await nodeModel(page).inputValue(), "test/old",
      "a conversation that never switched models keeps its creation settings");
    assert.equal(await thinking().inputValue(), "off");
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });

    await page.getByRole("button", { name: "New conversation" }).click();
    await openSettings(page);
    assert.equal(await nodeModel(page).inputValue(), "test/plain",
      "a new conversation uses the global settings composition");
    assert.equal(await thinking().inputValue(), "off");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Settings outside a conversation changes defaults but not existing Runs", { timeout: 30_000 }, async () => {
  let defaults = config;
  const { context, page, errors } = await app(async (route, command, body) => {
    if (command === "bootstrap") {
      await route.fulfill({ json: { result: { ...bootstrap, config: defaults } } }); return true;
    }
    if (command === "save_config") {
      assert.equal(body.runId, undefined);
      defaults = body.config;
      await route.fulfill({ json: { result: { ...bootstrap, config: defaults } } }); return true;
    }
    return false;
  });
  try {
    await page.locator('[data-run-id="fast"]').waitFor();
    await openSettings(page);
    await nodeModel(page).selectOption("test/new");
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(defaults.roleModels.nodeAgent.model, "test/new");
    await page.locator('[data-run-id="fast"]').click();
    await openSettings(page);
    assert.equal(await nodeModel(page).inputValue(), "test/old", "existing conversation retains its own profile");
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await openSettings(page);
    assert.equal(await nodeModel(page).inputValue(), "test/new", "new conversations inherit the saved defaults");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a closing Settings modal cannot open a late OAuth authorization page", { timeout: 30_000 }, async () => {
  let loginRequest;
  const cancelled = [];
  const pending = { id: "closing-oauth", provider: "test", status: "pending", prompt: null, error: null,
    events: [{ type: "auth_url", url: "https://example.com/authorize" }] };
  const { context, page, errors } = await app(async (route, command, body) => {
    if (command !== "provider_auth") return false;
    if (body.operation === "login") { loginRequest = route; return true; }
    if (body.operation === "cancel") cancelled.push(body.id);
    const result = body.operation === "catalog" ? { ...catalog,
      providers: [{ id: "test", name: "Test", configured: false, methods: [{ id: "oauth", name: "OAuth" }] }] }
      : body.operation === "cancel" ? { ...pending, status: "cancelled" } : pending;
    await route.fulfill({ json: { result } });
    return true;
  }, undefined, undefined, false, "no-preference");
  try {
    await page.locator('[data-run-id="fast"]').waitFor();
    await openSettings(page);
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
    await page.evaluate(() => { window.authOpened = []; window.open = url => { window.authOpened.push(url); return null; }; });
    await page.locator(".providers-grid-title").click();
    await page.clock.runFor(300);
    await page.locator(".login-btn").click();
    await until(() => !!loginRequest);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    assert.equal(await page.locator(".settings-modal").count(), 1, "the modal remains mounted for its exit animation");
    await loginRequest.fulfill({ json: { result: pending } });
    await page.locator(".provider-oauth-btn").waitFor({ state: "attached" });
    await page.waitForTimeout(50);
    assert.deepEqual(await page.evaluate(() => window.authOpened), [], "closing Settings revokes automatic browser opening immediately");
    await page.clock.runFor(300);
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await until(() => cancelled.includes(pending.id));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a delayed Settings snapshot cannot overwrite newly saved role models", { timeout: 30_000 }, async () => {
  let current = fast, stallReads = false;
  const pendingReads = [], savedConfigs = [];
  const { context, page, errors } = await app(async (route, command, body) => {
    if (command === "history" || command === "snapshot") {
      if (command === "snapshot" && stallReads) pendingReads.push({ route, snapshot: current });
      else await route.fulfill({ json: { result: current } });
      return true;
    }
    if (command !== "save_config") return false;
    assert.equal(body.runId, "fast");
    savedConfigs.push(body.config);
    current = { ...current, modelConfig: { model: body.config.model, thinkingLevel: body.config.thinkingLevel, roleModels: body.config.roleModels } };
    await route.fulfill({ json: { result: { ...bootstrap, snapshot: current } } });
    return true;
  });
  try {
    await page.locator('[data-run-id="fast"]').click();
    await page.waitForFunction(() => document.querySelector('[data-run-id="fast"]')?.classList.contains("chosen") &&
      !document.querySelector('[data-run-id="fast"]')?.classList.contains("is-loading"));
    stallReads = true;
    await openSettings(page);
    await until(() => pendingReads.length === 1);
    await nodeModel(page).selectOption("test/new");
    await page.locator(".role-model-group").nth(1).locator("select").first().selectOption("test/plain");
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(savedConfigs[0].model, "test/new");
    assert.equal(savedConfigs[0].roleModels.planner.model, "test/plain");
    await pendingReads[0].route.fulfill({ json: { result: pendingReads[0].snapshot } });
    await page.waitForTimeout(100);
    await openSettings(page); // Its own refresh stays pending while we inspect the saved projection.
    await until(() => pendingReads.length === 2);
    assert.equal(await nodeModel(page).inputValue(), "test/new", "a pre-save snapshot must not roll back the accepted Node Agent selection");
    assert.equal(await page.locator(".role-model-group").nth(1).locator("select").first().inputValue(), "test/plain");
    await pendingReads[1].route.fulfill({ json: { result: current } });
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(savedConfigs[1].model, "test/new", "saving again must not persist a rolled-back selection");
    assert.equal(savedConfigs[1].roleModels.planner.model, "test/plain");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("only the latest Settings opening may adopt its refreshed role models", { timeout: 30_000 }, async () => {
  let current = fast, stallReads = false;
  const pendingReads = [];
  const { context, page, errors } = await app(async (route, command) => {
    if (command !== "history" && command !== "snapshot") return false;
    if (command === "snapshot" && stallReads) pendingReads.push({ route, snapshot: current });
    else await route.fulfill({ json: { result: current } });
    return true;
  });
  try {
    await page.locator('[data-run-id="fast"]').click();
    await page.waitForFunction(() => document.querySelector('[data-run-id="fast"]')?.classList.contains("chosen") &&
      !document.querySelector('[data-run-id="fast"]')?.classList.contains("is-loading"));
    stallReads = true;
    await openSettings(page);
    await until(() => pendingReads.length === 1);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    current = { ...fast, modelConfig: { model: "test/new", thinkingLevel: "high", roleModels: {
      nodeAgent: { model: "test/new", thinkingLevel: "high" }, planner: { model: "test/plain", thinkingLevel: "off" },
    } } };
    await openSettings(page);
    await until(() => pendingReads.length === 2);
    await pendingReads[1].route.fulfill({ json: { result: pendingReads[1].snapshot } });
    await page.waitForFunction(() => document.querySelector(".role-model-group select")?.value === "test/new");
    await pendingReads[0].route.fulfill({ json: { result: pendingReads[0].snapshot } });
    await page.waitForTimeout(100);
    assert.equal(await nodeModel(page).inputValue(), "test/new", "a response for a closed Settings opening is stale");
    assert.equal(await page.locator(".role-model-group").nth(1).locator("select").first().inputValue(), "test/plain");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("stalled bootstrap releases the skeleton without a sidebar error card or a false missing-Planner prompt", { timeout: 30_000 }, async () => {
  let bootstraps = 0;
  const { context, page, errors } = await app(async (_route, command) => {
    if (command === "bootstrap") { bootstraps++; return true; }
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
    await page.locator(".sidebar-skeleton-wrap").waitFor({ state: "detached" });
    assert.equal(bootstraps, 1, "timeouts do not multiply the stalled request budget");
    assert.equal(await page.locator(".runs-list").getByRole("alert").count(), 0);
    assert.equal(await page.locator(".runs-list").getByRole("button", { name: "Retry", exact: true }).count(), 0);
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
    assert.equal(await page.locator(".save-config-btn").getAttribute("aria-busy"), "true");
    assert.equal(await page.locator(".save-config-btn").evaluate(element => getComputedStyle(element).opacity), "0.45", "an actual save still shows its busy appearance");
    await page.clock.fastForward(15_001);
    await page.waitForFunction(() => document.querySelector(".save-config-btn")?.disabled === false);
    assert.equal(await nodeModel(page).inputValue(), "test/new", "timed-out save retains the model draft");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("grapher_config")).model), "test/old");
    assert.match(await page.locator(".settings-modal").innerText(), /Saving settings timed out/);
    stall = false;
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(saves, 2);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("grapher_config")).model), "test/new", "Settings outside a conversation commits global defaults");
    await openSettings(page);
    assert.equal(await nodeModel(page).inputValue(), "test/new", "the accepted draft remains visible in Settings");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("saving a Node Agent model synchronizes the failed Run before explicit Continue", { timeout: 30_000 }, async () => {
  const failedExecution = { id: "old-attempt", node: "task", revision: 1, attempt: 1, sessionId: "same-session",
    worktree: "/same-workspace", before: "base", after: null, status: "failed", output: "", outputBytes: 0,
    metrics: { model: "test/old", thinkingLevel: "off" }, startedAt: 1, completedAt: 2 };
  let current = { ...empty, runId: "fast", config, planType: "graph", approved: true, phase: "needs_attention", canResume: true,
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
      current = { ...current, canResume: true, nodes: { task: { ...current.nodes.task, modelConfig: saved.roleModels.nodeAgent, modelRetry: true } } };
      result = { ...bootstrap, config: saved, snapshot: current };
    } else if (command === "control") {
      assert.equal(body.action, "resume"); assert.equal(body.runId, "fast"); resumes++;
      current = { ...current, canResume: false, phase: "running", nodes: { task: { ...current.nodes.task, status: "running", error: null } },
        executions: [...current.executions, { ...failedExecution, id: "new-attempt", attempt: 2, status: "running",
          metrics: { model: saved.model, thinkingLevel: saved.thinkingLevel }, startedAt: 3, completedAt: null }] };
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
    assert.equal(await page.getByRole("button", { name: "Resume", exact: true }).isEnabled(), true);
    await openSettings(page); await nodeModel(page).selectOption("test/new");
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    const continueButton = page.getByRole("button", { name: "Resume", exact: true });
    await continueButton.waitFor(); assert.equal(await continueButton.isEnabled(), true);
    assert.equal(resumes, 0, "saving does not resume automatically");
    assert.equal(current.nodes.task.status, "failed");
    assert.equal(current.config.model, "test/old", "the original Run config remains historical evidence");
    await page.locator('.graph-canvas .react-flow__node[data-id="task"]').click();
    await page.getByText("Model: test/old", { exact: true }).waitFor();
    await page.getByText("Model for retry: test/new", { exact: true }).waitFor();
    await page.getByText("Reasoning level for retry: low", { exact: true }).waitFor();
    await continueButton.click(); await until(() => resumes === 1);
    await page.getByText("Model: test/new", { exact: true }).waitFor();
    assert.equal(await page.getByText("Model for retry: test/new", { exact: true }).count(), 0);
    assert.equal(calls.filter(call => call.command === "detect_repository").length, 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("serial failure displays the saved retry model without rewriting the failed attempt", { timeout: 30_000 }, async () => {
  const failedExecution = { id: "old-attempt", node: "task", revision: 1, attempt: 1, sessionId: "same-session",
    worktree: repository, before: "base", after: null, status: "failed", output: "", outputBytes: 0,
    metrics: { model: "test/old", thinkingLevel: "off" }, startedAt: 1, completedAt: 2 };
  let current = { ...empty, runId: "fast", config, planType: "serial", approved: true, phase: "needs_attention", canResume: true,
    graph: { originalGoal: "Retry serial", nodes: [{ name: "task", task: "Finish the task" }], edges: [] },
    nodes: { task: { status: "failed", revision: 1, head: null, instruction: "", error: "Provider failure" } },
    executions: [failedExecution] };
  const { context, page, errors } = await app(async (route, command, body) => {
    let result;
    if (command === "bootstrap") result = { ...bootstrap, snapshot: current };
    else if (command === "history" || command === "snapshot" || command === "load_run") result = current;
    else if (command === "save_config") {
      assert.equal(body.runId, "fast");
      current = { ...current, nodes: { task: { ...current.nodes.task, modelConfig: body.config.roleModels.nodeAgent, modelRetry: true } } };
      result = { ...bootstrap, snapshot: current };
    } else if (command === "get_execution_output") {
      result = { runId: "fast", executionId: body.executionId, content: "", startOffset: 0, nextOffset: 0, totalBytes: 0,
        complete: true, status: "failed" };
    } else return false;
    await route.fulfill({ json: { result } }); return true;
  });
  try {
    await page.locator('[data-run-id="fast"]').click();
    await page.getByText("Model: test/old", { exact: true }).waitFor();
    await openSettings(page); await nodeModel(page).selectOption("test/new");
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await page.getByText("Model for retry: test/new", { exact: true }).waitFor();
    await page.getByText("Model: test/old", { exact: true }).waitFor();
    assert.equal(current.executions.length, 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const planType of ["graph", "serial"]) {
 test(`${planType}: an unrecognized failure offers the appropriate continuation control`, { timeout: 30_000 }, async () => {
  const failed = { id: "unknown-attempt", node: "task", revision: 1, attempt: 1, sessionId: "session",
    worktree: "/workspace", before: "base", after: null, status: "failed", output: "", outputBytes: 0,
    startedAt: 1, completedAt: 2 };
  let current = { ...empty, runId: "fast", config, planType, approved: true, phase: "needs_attention", canResume: true,
    graph: { originalGoal: "Recover unknown failure", nodes: [{ name: "task", task: "Finish the task" }], edges: [] },
    plan: { executionBatches: [["task"]], roots: ["task"], terminals: ["task"], warnings: [] },
    nodes: { task: { status: "failed", canResume: true, revision: 1, head: null, instruction: "", error: "Unrecognized frobnicator error #843" } },
    executions: [failed] };
  let resumes = 0;
  const { context, page, errors } = await app(async (route, command, body) => {
    let result;
    if (command === "bootstrap") result = { ...bootstrap, snapshot: current };
    else if (command === "history" || command === "snapshot" || command === "load_run") result = current;
    else if (command === "control") {
      assert.equal(body.action, planType === "serial" ? "resume_node" : "resume");
      assert.equal(body.runId, "fast");
      assert.equal(body.node, planType === "serial" ? "task" : undefined);
      assert.equal(body.instruction, undefined, "continuation does not append a user message");
      resumes++;
      current = { ...current, canResume: false, phase: "running", nodes: { task: { ...current.nodes.task, canResume: false, status: "running", error: null } },
        executions: [...current.executions, { ...failed, id: "retry", attempt: 2, status: "running", startedAt: 3, completedAt: null }] };
      result = current;
    } else if (command === "get_execution_output") {
      result = { runId: "fast", executionId: body.executionId, content: "", startOffset: 0, nextOffset: 0, totalBytes: 0,
        complete: body.executionId === failed.id, status: body.executionId === failed.id ? "failed" : "running" };
    } else return false;
    await route.fulfill({ json: { result } }); return true;
  });
  try {
    await page.locator('[data-run-id="fast"]').click();
    if (planType === "serial") {
      await page.locator(".pane-bottom-chat textarea").waitFor();
      assert.equal(await page.getByRole("button", { name: "Resume", exact: true }).count(), 0,
        "Serial has no run-wide topology control");
    } else {
      await page.locator('.task-node[data-node-name="task"] .status', { hasText: "Failed" }).waitFor();
    }
    const button = page.getByRole("button", {
      name: planType === "serial" ? "Continue this agent (without adding a message)" : "Resume", exact: true,
    });
    assert.equal(await button.isEnabled(), true);
    assert.equal(resumes, 0, "loading a failure never resumes it automatically");
    await button.click();
    await until(() => resumes === 1);
    if (planType === "graph") {
      await page.locator('.task-node[data-node-name="task"] .status', { hasText: "Running" }).waitFor();
    } else {
      await button.waitFor({ state: "detached" });
    }
    assert.equal(current.executions[0].status, "failed");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
 });
}

test("a resumed failed node keeps virtualized tool cards evenly spaced", { timeout: 45_000 }, async () => {
  const line = event => JSON.stringify(event) + "\n";
  const output = Array.from({ length: 80 }, (_, index) => {
    const id = `retry-tool-${index}`;
    return line({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: `echo ${index}` } }) +
      line({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text: "done" }] } }) +
      line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "\n\n" } });
  }).join("");
  const bytes = Buffer.from(output);
  const failed = { id: "failed-attempt", node: "task", revision: 1, attempt: 1, sessionId: "session",
    worktree: "/workspace", before: "base", after: null, status: "failed", output: "", outputBytes: 0,
    startedAt: 1, completedAt: 2 };
  let current = { ...empty, runId: "fast", config, planType: "graph", approved: true, phase: "needs_attention", canResume: true,
    graph: { originalGoal: "Recover", nodes: [{ name: "task", task: "Finish the task" }], edges: [] },
    plan: { executionBatches: [["task"]], roots: ["task"], terminals: ["task"], warnings: [] },
    nodes: { task: { status: "failed", revision: 1, head: null, instruction: "", error: "Provider failed" } }, executions: [failed] };
  const { context, page, errors } = await app(async (route, command, body) => {
    let result;
    if (command === "bootstrap") result = { ...bootstrap, snapshot: current };
    else if (command === "history" || command === "snapshot" || command === "load_run") result = current;
    else if (command === "control") {
      assert.equal(body.action, "resume");
      current = { ...current, canResume: false, phase: "running", nodes: { task: { ...current.nodes.task, status: "running", error: null } },
        executions: [failed, { ...failed, id: "retry", attempt: 2, status: "running", outputBytes: bytes.length, startedAt: 3, completedAt: null }] };
      result = current;
    } else if (command === "get_execution_output") {
      const content = body.executionId === "retry" ? bytes : Buffer.alloc(0);
      const start = body.tail ? 0 : Math.min(body.offset ?? 0, content.length);
      result = { runId: "fast", executionId: body.executionId, content: content.subarray(start).toString(),
        startOffset: start, nextOffset: content.length, totalBytes: content.length, complete: true,
        status: body.executionId === "retry" ? "running" : "failed" };
    } else return false;
    await route.fulfill({ json: { result } }); return true;
  });
  try {
    await page.locator('[data-run-id="fast"]').click();
    await page.locator('.task-node[data-node-name="task"] .status', { hasText: "Failed" }).waitFor();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await page.locator('.task-node[data-node-name="task"] .status', { hasText: "Running" }).waitFor();
    await page.locator('.task-node[data-node-name="task"]').click();
    const retry = page.locator('[data-execution-id="retry"]');
    await retry.locator(".tool-call-card").first().waitFor();
    const scroll = page.locator(".initial-query-scroll");
    for (const fraction of [0, 0.5, 1]) {
      await scroll.evaluate((element, value) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * value; }, fraction);
      await page.waitForTimeout(200);
      const metrics = await retry.evaluate(element => {
        const cards = [...element.querySelectorAll(".tool-call-card")].map(card => card.getBoundingClientRect());
        return { count: cards.length, gaps: cards.slice(1).map((card, index) => card.top - cards[index].bottom),
          blankRows: [...element.querySelectorAll("[data-transcript-id]")]
            .filter(row => row.querySelector(".chat-message-assistant") && !row.textContent.trim()).length };
      });
      assert.ok(metrics.count >= 3 && metrics.count < 80, `retry history must be virtualized: ${JSON.stringify(metrics)}`);
      assert.equal(metrics.blankRows, 0);
      assert.ok(metrics.gaps.every(gap => Math.abs(gap - 10) < 0.6), `unexpected gaps after retry: ${JSON.stringify(metrics)}`);
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("serial continuation waits for writer drain and targets only its agent", { timeout: 30_000 }, async () => {
  const execution = { id: "worker", node: "task", revision: 1, attempt: 1, sessionId: "session", worktree: "/workspace",
    before: "", after: null, status: "running", output: "", outputBytes: 0, startedAt: 1, completedAt: null };
  let current = { ...empty, runId: "fast", config, planType: "serial", approved: true, paused: true, phase: "paused", canResume: false,
    graph: { originalGoal: "Pause safely", nodes: [{ name: "task", task: "Work" }], edges: [] },
    nodes: { task: { status: "running", revision: 1, head: null, instruction: "", error: null } }, executions: [execution] };
  let polls = 0, resumes = 0;
  const { context, page, errors } = await app(async (route, command, body) => {
    let result;
    if (command === "bootstrap") result = { ...bootstrap, snapshot: current };
    else if (command === "history" || command === "snapshot" || command === "load_run") result = current;
    else if (command === "snapshot_if_changed") { polls++; result = { version: JSON.stringify(current), snapshot: current }; }
    else if (command === "control") {
      assert.equal(body.action, "resume_node"); assert.equal(body.node, "task"); assert.equal(body.runId, "fast");
      assert.equal(body.instruction, undefined);
      resumes++;
      current = { ...current, paused: false, canResume: false, phase: "running",
        nodes: { task: { ...current.nodes.task, canResume: false, status: "running", error: null } },
        executions: [...current.executions, { ...execution, id: "continued", startedAt: 3 }] };
      result = current;
    } else if (command === "get_execution_output") {
      const status = current.executions.find(execution => execution.id === body.executionId)?.status;
      result = { runId: "fast", executionId: body.executionId, content: "", startOffset: 0,
        nextOffset: 0, totalBytes: 0, complete: status !== "running", status };
    }
    else return false;
    await route.fulfill({ json: { result } }); return true;
  });
  try {
    await page.locator('[data-run-id="fast"]').click();
    await page.locator(".pane-bottom-chat textarea").waitFor();
    assert.equal(await page.getByRole("button", { name: "Resume", exact: true }).count(), 0);
    const button = page.getByRole("button", { name: "Continue this agent (without adding a message)", exact: true });
    assert.equal(await button.count(), 0, "a draining writer cannot be resumed yet");
    current = { ...current, canResume: true, nodes: { task: { ...current.nodes.task, canResume: true, status: "paused", error: "Execution paused by the user" } },
      executions: [{ ...execution, status: "paused", completedAt: 2 }] };
    await page.clock.runFor(5_000);
    await until(() => polls > 0);
    await button.waitFor();
    assert.equal(await button.isEnabled(), true);
    assert.equal(resumes, 0, "a recoverable snapshot does not resume automatically");
    assert.equal(await page.getByRole("button", { name: "Resume", exact: true }).count(), 0);
    await button.click();
    await until(() => resumes === 1);
    await button.waitFor({ state: "detached" });
    assert.equal(current.executions[0].status, "paused", "continuation preserves the interrupted attempt");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a paused node intervention does not automatically retry an unrelated unknown failure", { timeout: 30_000 }, async () => {
  const execution = (id, node, status) => ({ id, node, revision: 1, attempt: 1, sessionId: id,
    worktree: "/workspace", before: "base", after: null, status, output: "", outputBytes: 0, startedAt: 1, completedAt: 2 });
  let current = { ...empty, runId: "fast", config, planType: "graph", approved: true, paused: true, phase: "paused", canResume: true,
    graph: { originalGoal: "Recover one node", nodes: [{ name: "task", task: "Work" }, { name: "other", task: "Other" }], edges: [] },
    plan: { executionBatches: [["task", "other"]], roots: ["task", "other"], terminals: ["task", "other"], warnings: [] },
    nodes: { task: { status: "paused", revision: 1, head: null, instruction: "", error: "Execution paused by the user" },
      other: { status: "failed", revision: 1, head: null, instruction: "", error: "Unrecognized failure" } },
    executions: [execution("stopped", "task", "paused"), execution("failed", "other", "failed")] };
  const actions = [];
  const { context, page, errors } = await app(async (route, command, body) => {
    let result;
    if (command === "bootstrap") result = { ...bootstrap, snapshot: current };
    else if (command === "history" || command === "snapshot" || command === "load_run") result = current;
    else if (command === "control") {
      actions.push(body.action);
      if (body.action === "intervene") {
        assert.equal(body.node, "task");
        current = { ...current, nodes: { ...current.nodes, task: { ...current.nodes.task, status: "dirty", error: null } } };
      } else {
        assert.equal(body.action, "resume_after_intervention");
        current = { ...current, paused: false, canResume: false, phase: "running",
          nodes: { ...current.nodes, task: { ...current.nodes.task, status: "running" } },
          executions: [...current.executions, { ...execution("retry", "task", "running"), attempt: 2, completedAt: null }] };
      }
      result = current;
    } else if (command === "get_execution_output") {
      result = { runId: "fast", executionId: body.executionId, content: "", startOffset: 0, nextOffset: 0, totalBytes: 0,
        complete: body.executionId !== "retry", status: current.executions.find(item => item.id === body.executionId)?.status };
    } else return false;
    await route.fulfill({ json: { result } }); return true;
  });
  try {
    await page.locator('[data-run-id="fast"]').click();
    await page.locator('.task-node[data-node-name="task"]').click();
    const composer = page.locator('.pane-bottom-chat textarea');
    await composer.fill("Continue this node"); await composer.press("Enter");
    await until(() => actions.length === 2);
    assert.deepEqual(actions, ["intervene", "resume_after_intervention"]);
    assert.equal(current.nodes.other.status, "failed");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("model-specific thinking levels update global defaults when Settings is outside a conversation", { timeout: 30_000 }, async () => {
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
    await page.getByRole("checkbox", { name: "Hide Auto mode", exact: true }).uncheck();
    const cards = page.locator(".role-model-group");
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
    await openSettings(page);
    assert.equal(await model(0).inputValue(), "test/plain"); assert.equal(await thinking(0).inputValue(), "off");
    assert.equal(await model(1).inputValue(), "test/old"); assert.equal(await thinking(1).inputValue(), "high");
    assert.equal(await thinking(2).inputValue(), "off");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("saving an incompatible legacy level updates defaults to the Pi-adjusted value", { timeout: 30_000 }, async () => {
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
    const thinking = page.locator(".role-model-group").nth(0).locator("select").nth(1);
    assert.equal(await thinking.inputValue(), "high");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("grapher_config")).thinkingLevel), "max", "opening settings must not persist corrections");
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(saved.thinkingLevel, "high");
    assert.equal(saved.roleModels.nodeAgent.thinkingLevel, "high");
    await openSettings(page);
    assert.equal(await thinking.inputValue(), "high");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Settings edits the conversation profile even while a node with an override is selected", { timeout: 30_000 }, async () => {
  const node = { status: "failed", revision: 1, head: null, instruction: "", error: "quota" };
  let current = { ...empty, runId: "fast", config, planType: "graph", approved: true, phase: "needs_attention",
    graph: { originalGoal: "Node scope", nodes: [{ name: "a", task: "a" }, { name: "b", task: "b" }], edges: [] },
    plan: { executionBatches: [["a", "b"]], rootNodes: ["a", "b"], terminals: ["a", "b"], warnings: [] },
    nodes: { a: { ...node }, b: { ...node } },
  };
  const { context, page, errors } = await app(async (route, command, body) => {
    let result;
    if (command === "bootstrap") result = { ...bootstrap, snapshot: current };
    else if (["history", "snapshot", "load_run"].includes(command)) result = current;
    else if (command === "composer_command") { await route.fulfill({ status: 400, json: { error: "Pi session is not active" } }); return true; }
    else if (command === "composer_models") {
      assert.equal(body.runId, "fast"); assert.equal(body.node, "a"); assert.equal(body.role, "nodeAgent");
      current = { ...current, nodes: { ...current.nodes, a: { ...current.nodes.a, modelConfig: body.settings, modelOverride: true } } };
      result = current;
    } else if (command === "save_config") {
      assert.equal(body.runId, "fast");
      assert.equal(body.config.model, "test/plain", "Settings changes the Run profile, not the selected node");
      current = { ...current, modelConfig: { model: body.config.model, thinkingLevel: body.config.thinkingLevel, roleModels: body.config.roleModels } };
      result = { ...bootstrap, snapshot: current };
    } else return false;
    await route.fulfill({ json: { result } }); return true;
  });
  try {
    await page.locator('[data-run-id="fast"]').click();
    await page.locator('.graph-canvas .react-flow__node[data-id="a"]').click();
    const input = page.locator(".pane-bottom-chat textarea");
    await input.fill("/model test/new"); await input.press("Escape"); await input.press("Enter");
    await until(() => current.nodes.a.modelConfig?.model === "test/new");
    await openSettings(page);
    assert.equal(await nodeModel(page).inputValue(), "test/old", "Settings never displays the selected node override");
    await nodeModel(page).selectOption("test/plain");
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(current.nodes.a.modelConfig.model, "test/new", "an explicit node override remains independent");
    assert.equal(current.modelConfig.roleModels.nodeAgent.model, "test/plain");
    assert.equal(current.config.model, "test/old", "original execution config remains historical");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("grapher_config")).model), "test/old", "conversation edits do not change global defaults");
    await page.locator('.graph-canvas .react-flow__node[data-id="b"]').click();
    await openSettings(page);
    assert.equal(await nodeModel(page).inputValue(), "test/plain", "the same Run profile appears from another node");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("scoped models persist globally, hide Settings choices and reject manual hidden selections", { timeout: 30_000 }, async () => {
  const hidden = new Set();
  let failSave = true;
  const handler = async (route, command, body) => {
    if (command !== "provider_auth") return false;
    let result;
    if (body.operation === "set_model_visibility") {
      if (failSave) { failSave = false; await route.fulfill({ status: 500, json: { error: "visibility save failed" } }); return true; }
      if (body.reset) hidden.clear();
      for (const change of body.changes) { if (change.hidden) hidden.add(change.model); else hidden.delete(change.model); }
      result = { hiddenModels: [...hidden] };
    } else if (body.operation === "model_visibility") result = { hiddenModels: [...hidden] };
    else result = { ...catalog, hiddenModels: [...hidden], models: catalog.models.map(model => ({ ...model, hidden: hidden.has(`${model.provider}/${model.id}`) })) };
    await route.fulfill({ json: { result } }); return true;
  };
  const { context, page, errors, calls } = await app(handler);
  let second;
  try {
    await page.locator('[data-run-id="fast"]').waitFor();
    const input = page.locator("textarea").first();
    const submit = async text => { await input.fill(text); await input.press("Escape"); await input.press("Enter"); };
    await submit("/scoped model");
    const scope = page.getByRole("dialog", { name: "Global model visibility" });
    assert.equal(await scope.locator(".scoped-model-search, .scoped-model-toolbar, input:not([type='checkbox'])").count(), 0);
    assert.equal(await scope.getByRole("button", { name: "Show all", exact: true }).count(), 0);
    assert.doesNotMatch(await scope.innerText(), /Existing selections and running calls|Checked models appear/);
    const cancelStyle = await scope.getByRole("button", { name: "Cancel", exact: true }).evaluate(button => {
      const style = getComputedStyle(button);
      return { background: style.backgroundColor, borderWidth: style.borderTopWidth, height: style.height };
    });
    assert.deepEqual(cancelStyle, { background: "rgba(0, 0, 0, 0)", borderWidth: "0px", height: "36px" });
    const choice = id => scope.locator(".scoped-model-row", { hasText: id }).getByRole("checkbox");
    await choice("test/new").uncheck();
    await scope.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(hidden.size, 0, "cancel does not change global visibility");
    await submit("/scoped-models");
    await choice("test/new").uncheck(); await choice("test/old").uncheck();
    await scope.getByRole("button", { name: "Save", exact: true }).click();
    await scope.getByRole("alert").waitFor();
    assert.equal(hidden.size, 0, "failed save keeps the committed catalog unchanged");
    assert.equal(await choice("test/new").isChecked(), false, "failure retains the user's draft");
    await scope.getByRole("button", { name: "Save", exact: true }).click();
    await scope.waitFor({ state: "detached" });
    await submit("/model test/new");
    const notice = page.locator('.prompt-command-popover[role="alert"]');
    await notice.waitFor();
    assert.match(await notice.innerText(), /unique, available provider\/model/);
    assert.equal(await input.inputValue(), "/model test/new");
    assert.equal(await page.locator(".prompt-box-attachment-error").count(), 0);
    const noticeBox = await notice.boundingBox();
    const inputBox = await page.locator(".prompt-box-container").boundingBox();
    assert.ok(noticeBox.y + noticeBox.height <= inputBox.y, "command errors float above the composer");
    await openSettings(page);
    const choices = p => nodeModel(p).locator("option").evaluateAll(options => options.filter(o => o.value && !o.disabled).map(o => o.value));
    assert.deepEqual(await choices(page), ["test/plain"]);
    assert.equal(await nodeModel(page).inputValue(), "test/old", "hiding never rewrites existing model configuration");
    assert.ok(!(await page.locator(".role-model-settings").innerText()).includes("test/old"));
    assert.ok(!(await page.locator(".role-model-settings").innerText()).includes("test/new"));
    assert.equal(calls.filter(call => call.command === "save_config").length, 0);

    second = await app(handler);
    await second.page.locator('[data-run-id="fast"]').waitFor();
    await openSettings(second.page);
    assert.deepEqual(await choices(second.page), ["test/plain"], "another browser session reads the global backend selection");
    assert.deepEqual(second.errors, []);

    const manageModels = page.getByRole("button", { name: "Manage visible models", exact: true });
    await manageModels.scrollIntoViewIfNeeded();
    const manageBox = await manageModels.boundingBox();
    const lastRoleBox = await page.locator(".role-model-group").last().boundingBox();
    assert.ok(manageBox.y >= lastRoleBox.y + lastRoleBox.height, "scoped models control is below all role model settings");
    await manageModels.click();
    await choice("test/new").check();
    await choice("test/old").check();
    await scope.getByRole("button", { name: "Save", exact: true }).click();
    await scope.waitFor({ state: "detached" });
    assert.equal((await choices(page)).length, 3, "restoring updates already-open Settings immediately");
    assert.equal(hidden.size, 0);
    assert.deepEqual(errors, []);
  } finally { await second?.context.close(); await context.close(); }
});

test("scoped models dialog animates entrance and exit like Settings", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await app(async (route, command) => {
    if (command !== "provider_auth") return false;
    await route.fulfill({ json: { result: catalog } });
    return true;
  }, undefined, undefined, false, "no-preference");
  try {
    await page.locator('[data-run-id="fast"]').waitFor();
    await openSettings(page);
    const manageModels = page.getByRole("button", { name: "Manage visible models", exact: true });
    await manageModels.scrollIntoViewIfNeeded();
    await manageModels.click();
    const scope = page.getByRole("dialog", { name: "Global model visibility" });
    await scope.waitFor({ state: "attached" });
    const startOpacity = parseFloat(await scope.evaluate(el => getComputedStyle(el).opacity));
    assert.ok(startOpacity < 1, `expected entrance fade-in from low opacity, got ${startOpacity}`);
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".scoped-models-modal")).opacity === "1");
    await scope.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForFunction(() => {
      const el = document.querySelector(".scoped-models-modal");
      return el && parseFloat(getComputedStyle(el).opacity) < 1;
    });
    await scope.waitFor({ state: "detached" });
    assert.equal(await manageModels.evaluate(el => el === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("slash model menu matches all Settings choices and tracks catalog refresh without retyping", { timeout: 30_000 }, async () => {
  let models = [...catalog.models, ...Array.from({ length: 65 }, (_, index) => ({
    ...catalog.models[0], id: `model-${index + 1}`, name: `Model ${index + 1}`,
  })), { ...catalog.models[0], id: "unavailable", available: false }];
  const { context, page, errors } = await app(async (route, command) => {
    if (command !== "provider_auth") return false;
    await route.fulfill({ json: { result: { ...catalog, models } } });
    return true;
  });
  try {
    await page.locator('[data-run-id="fast"]').waitFor();
    const choices = () => nodeModel(page).locator("option").evaluateAll(options => options
      .filter(option => option.value && !option.disabled).map(option => option.value));
    await openSettings(page);
    const expected = await choices();
    assert.equal(expected.length, 68);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    const input = page.locator("textarea").first();
    const items = page.locator(".prompt-box-suggestion-item .suggestion-item-title");
    await input.fill("/model ");
    await until(async () => await items.count() === expected.length);
    assert.deepEqual(await items.allTextContents(), expected, "all available models, in the same order as Settings");
    await input.fill("/model model-65");
    await until(async () => await items.count() === 1);
    await items.first().click();
    await input.press("Escape"); await input.press("Enter");
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "");
    await openSettings(page);
    assert.equal(await page.locator(".role-model-group").nth(1).locator("select").first().inputValue(), "test/model-65");
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();

    // Leave /model open while Settings refreshes the catalog. The command
    // trigger and scope don't change, so a one-time local copy would go stale.
    await input.fill("/model ");
    await openSettings(page);
    models = [...catalog.models, { ...catalog.models[0], id: "fresh-only", name: "Fresh" }];
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await until(async () => (await choices()).length === 4);
    const refreshed = await choices();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    assert.equal(await input.inputValue(), "/model ");
    // Blur dismisses suggestions; Enter reopens the picker without changing
    // its text or retriggering catalog loading.
    await input.press("Enter");
    await until(async () => await items.count() === refreshed.length);
    assert.deepEqual(await items.allTextContents(), refreshed);
    assert.ok(refreshed.includes("test/fresh-only"));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("home slash model changes are reflected in Settings without writing global defaults", { timeout: 30_000 }, async () => {
  const { context, page, errors, calls } = await app(async () => false);
  try {
    await page.locator('[data-run-id="fast"]').waitFor();
    const input = page.locator("textarea").first();
    await input.fill("/model test/new"); await input.press("Escape"); await input.press("Enter");
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "");
    await openSettings(page);
    assert.equal(await page.locator(".role-model-group").nth(1).locator("select").first().inputValue(), "test/new");
    assert.equal(await nodeModel(page).inputValue(), "test/old");
    assert.equal(calls.filter(call => call.command === "save_config").length, 0);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("grapher_config")).model), "test/old");
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

test("restored workspace and conversation cards paint at their final state instead of replaying a launch entrance", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await app(async () => false, undefined, { [repository]: ["fast"] }, false, "no-preference");
  try {
    // The harness freezes the animation clock, so a replayed entrance would stay
    // at opacity 0 here even though the cards are already in the DOM.
    const workspaceCard = page.locator(".project-workspace-item");
    const conversationCard = page.locator('[data-run-id="fast"]');
    await workspaceCard.waitFor();
    await conversationCard.waitFor();
    assert.equal(await workspaceCard.evaluate(element => getComputedStyle(element).opacity), "1");
    assert.equal(await conversationCard.evaluate(element => getComputedStyle(element).opacity), "1");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
