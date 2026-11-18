import assert from "node:assert/strict";
import { fixtureSummaries, fixtureFileChanges, fixtureExecutionPage } from "./fixtures/current-api.mjs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { build, createServer, preview } from "vite";

let directory, server, browser, chunks, origin;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "grapher-frontend-bundle-"));
  chunks = new Map();
  await build({
    logLevel: "error",
    build: { outDir: directory, emptyOutDir: true, reportCompressedSize: false },
    plugins: [{ name: "bundle-regression-metadata", generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) if (item.type === "chunk") chunks.set(item.fileName, {
        fileName: item.fileName, size: Buffer.byteLength(item.code), isEntry: item.isEntry,
        imports: item.imports, dynamicImports: item.dynamicImports, modules: Object.keys(item.modules),
      });
    } }],
  });
  server = await preview({ logLevel: "error", build: { outDir: directory },
    preview: { host: "127.0.0.1", port: 0, strictPort: false } });
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.httpServer ? server.httpServer.close(resolve) : resolve());
  if (directory) await rm(directory, { recursive: true, force: true });
});

function workbenchChunk() {
  const chunk = [...chunks.values()].find(item => item.modules.some(id => id.replaceAll("\\", "/").endsWith("/src/components/views/AppGraphWorkbench.tsx")));
  assert.ok(chunk, "the workbench has its own emitted chunk");
  return chunk;
}

function staticClosure(entry) {
  const found = new Set();
  const visit = item => {
    if (!item || found.has(item.fileName)) return;
    found.add(item.fileName);
    for (const name of item.imports) visit(chunks.get(name));
  };
  visit(entry);
  return found;
}

test("production entry keeps the graph and Markdown engines out of the initial JS", () => {
  const entry = [...chunks.values()].find(item => item.isEntry);
  assert.ok(entry);
  const startup = staticClosure(entry);
  const workbench = workbenchChunk();
  assert.ok(!startup.has(workbench.fileName), "the workbench is not eagerly imported");
  assert.ok([...chunks.values()].some(item => startup.has(item.fileName) && item.dynamicImports.includes(workbench.fileName)),
    "the workbench is reachable through a dynamic import");
  for (const name of startup) {
    const modules = chunks.get(name).modules.map(id => id.replaceAll("\\", "/"));
    assert.ok(!modules.some(id => !/\.css(?:\?|$)/.test(id) && /\/node_modules\/(?:@xyflow\/|katex\/|marked\/)/.test(id)),
      `${name} must not eagerly import the graph/Markdown engines`);
  }
  for (const item of chunks.values()) assert.ok(item.size < 500_000,
    `${item.fileName} is ${(item.size / 1000).toFixed(1)} kB, exceeding the default Vite warning limit`);
});

async function setupPage({ planType = "graph", running = false, twoRuns = false } = {}) {
  const repository = "/mock/lazy-project";
  const config = { repository, model: "test/model", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const graph = { originalGoal: "Load a conversation", nodes: [{ id: "task", task: "Task" }], edges: [] };
  const snapshot = { runId: "lazy-run", config, planType, phase: running ? "running" : "completed", approved: true, paused: false,
    graph, nodes: { task: { status: running ? "running" : "completed" } }, plan: null, executions: [], events: [], base: "", feedbackCounts: {} };
  const snapshots = { [snapshot.runId]: snapshot, ...(twoRuns ? {
    "other-run": { ...snapshot, runId: "other-run", graph: { ...graph, originalGoal: "Other conversation" } },
  } : {}) };
  const empty = { ...snapshot, runId: "", config: null, phase: "draft", approved: false,
    graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {} };
  const repositoryInfo = { path: repository, name: "Project", branch: "main", head: "", clean: true };
  const context = await browser.newContext({ viewport: { width: 1280, height: 768 }, reducedMotion: "no-preference" });
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
      case "bootstrap": case "save_config": result = { config, snapshot: empty, runs: Object.keys(snapshots), conversations: fixtureSummaries(Object.values(snapshots)), repositoryInfo, dataPath: "/mock" }; break;
      case "get_file_changes": result = fixtureFileChanges(body); break;
      case "get_execution_output": result = fixtureExecutionPage(body, Object.values(snapshots)); break;
      case "load_run": case "history": case "snapshot": result = snapshots[body.runId] ?? empty; break;
      case "snapshot_if_changed": result = { version: "1", snapshot: snapshots[body.runId] ?? null }; break;
      case "repository_status": result = { repository, valid: true, error: null }; break;
      case "detect_repository": result = repositoryInfo; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [], models: [], warning: null }; break;
      case "pi_extensions": result = { globalDirectory: "/mock/extensions", extensions: [] }; break;
      case "environment_capabilities": result = { platform: "windows", arch: "x86_64", nativeWorkspace: true }; break;
      default: result = null;
    }
    try { await route.fulfill({ json: { result } }); } catch { /* Navigation can cancel a request. */ }
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  return { context, page, errors };
}

test("navigation downloads the workbench while its snapshot is pending without adopting a late Run", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await setupPage();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let metadataPending = false, chunkRequested = false;
  const outputs = [];
  page.on("request", request => {
    if (/\/api\/get_(?:execution|planning)_output$/.test(new URL(request.url()).pathname)) outputs.push(request.url());
  });
  await page.route("**/api/snapshot", async route => {
    metadataPending = true;
    await gate;
    await route.fallback().catch(() => {});
  });
  await page.route(`**/${workbenchChunk().fileName}`, async route => {
    chunkRequested = true;
    await route.continue();
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    assert.equal(chunkRequested, false, "home still does not eagerly download the workbench");
    await page.locator(".landing-screen textarea").fill("Parallel navigation draft");
    await page.locator('[data-run-id="lazy-run"]').click();
    const deadline = Date.now() + 5000;
    while (!metadataPending || !chunkRequested) {
      assert.ok(Date.now() < deadline, "component download must not wait for the snapshot response");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(await page.locator(".workbench").count(), 0, "module prewarming is not foreground adoption");
    assert.deepEqual(outputs, [], "prewarming does not fan out to transcript history");
    assert.equal(await page.locator(".landing-screen textarea").isDisabled(), true,
      "metadata loading must also disable the retained composer, not only module loading");
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    release();
    await page.waitForTimeout(250);
    assert.equal(await page.locator(".workbench").count(), 0);
    assert.equal(await page.locator(".landing-screen textarea").inputValue(), "Parallel navigation draft");
    assert.equal(await page.locator(".landing-screen textarea").isEnabled(), true);
    assert.deepEqual(errors, []);
  } finally { release(); await context.close(); }
});

test("a pending snapshot makes the retained conversation inert and failure restores its draft", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await setupPage({ twoRuns: true });
  let release, pending = false;
  const gate = new Promise(resolve => { release = resolve; });
  const mutations = [];
  page.on("request", request => {
    if (/\/api\/(?:control|plan_goal_stream)$/.test(new URL(request.url()).pathname)) mutations.push(request.url());
  });
  await page.route("**/api/snapshot", async route => {
    if (route.request().postDataJSON().runId !== "other-run") return route.fallback();
    pending = true;
    await gate;
    await route.fulfill({ status: 503, json: { error: "Delayed snapshot failed" } }).catch(() => {});
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="lazy-run"]').click();
    const composer = page.locator(".pane-bottom-chat textarea");
    await composer.fill("Draft belongs to the current conversation");
    await page.locator('[data-run-id="other-run"]').click();
    const deadline = Date.now() + 5000;
    while (!pending) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(await page.locator(".workspace-view-wrapper").getAttribute("inert"), "",
      "the previous Run must not remain interactive under another card's loading state");
    assert.equal(await composer.isDisabled(), true);
    await page.keyboard.press("Enter");
    release();
    await page.getByRole("alert").filter({ hasText: "Delayed snapshot failed" }).waitFor();
    await page.waitForFunction(() => document.querySelector(".pane-bottom-chat textarea")?.disabled === false);
    assert.equal(await page.locator(".workspace-view-wrapper").getAttribute("inert"), null);
    assert.equal(await composer.inputValue(), "Draft belongs to the current conversation");
    assert.deepEqual(mutations, []);
    assert.deepEqual(errors, []);
  } finally { release(); await context.close(); }
});

test("opening Settings supersedes a pending navigation without changing its conversation scope", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await setupPage({ twoRuns: true });
  let release, pending = false;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/snapshot", async route => {
    if (route.request().postDataJSON().runId !== "other-run") return route.fallback();
    pending = true;
    await gate;
    await route.fallback().catch(() => {});
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="lazy-run"]').click();
    await page.locator(".pane-bottom-chat textarea").fill("Keep this conversation's draft");
    await page.locator('[data-run-id="other-run"]').click();
    const deadline = Date.now() + 5000;
    while (!pending) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)); }
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator(".settings-modal").waitFor();
    release();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-run-id="lazy-run"].chosen').count(), 1);
    assert.equal(await page.locator(".workspace-view-wrapper").getAttribute("inert"), null);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.locator(".pane-bottom-chat textarea").inputValue(), "Keep this conversation's draft");
    assert.deepEqual(errors, []);
  } finally { release(); await context.close(); }
});

test("a slow workbench keeps the landing composer and hands off only after loading", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await setupPage();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requested = false, notifyRequest;
  const requestStarted = new Promise(resolve => { notifyRequest = resolve; });
  const seen = [];
  page.on("request", request => seen.push(new URL(request.url()).pathname));
  await page.route(`**/${workbenchChunk().fileName}`, async route => {
    requested = true;
    notifyRequest();
    await gate;
    try { await route.continue(); } catch { /* A closed page cancels the request. */ }
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    const composer = page.locator(".landing-screen textarea");
    await composer.fill("Keep this landing draft");
    assert.equal(requested, false, "the landing page does not fetch the workbench");
    assert.ok(!seen.some(url => /\/assets\/(?:xyflow|katex|marked)-.*\.js$/.test(url)),
      "the graph and Markdown engines are not requested on the landing page");
    await page.locator('[data-run-id="lazy-run"]').click();
    await page.locator(".workbench-module-status[role=status]").waitFor();
    await requestStarted;
    assert.equal(requested, true);
    assert.equal(await composer.isVisible(), true, "the existing composer remains painted while the module loads");
    assert.equal(await composer.inputValue(), "Keep this landing draft");
    assert.equal(await composer.isDisabled(), true, "a pending navigation cannot submit a second landing request");
    assert.equal(await page.locator(".workbench").count(), 0);
    await page.evaluate(() => {
      window.bundleComposerFrames = [];
      window.sampleBundleComposer = true;
      const sample = () => {
        const landing = document.querySelector(".app-shell").classList.contains("landing-active");
        const box = document.querySelector(landing ? ".landing-screen .prompt-box-container" : ".workspace-view-wrapper .prompt-box-container");
        let opacity = box ? 1 : 0;
        for (let element = box; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          opacity *= Number(style.opacity);
          if (style.visibility === "hidden" || style.display === "none") opacity = 0;
        }
        const visible = [...document.querySelectorAll(".prompt-box-container")].filter(element =>
          element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).length;
        window.bundleComposerFrames.push({ opacity, visible });
        if (window.sampleBundleComposer) requestAnimationFrame(sample);
      };
      sample();
    });
    release();
    await page.locator('.graph-canvas .react-flow__node[data-id="task"]').waitFor();
    await page.locator(".pane-bottom-chat textarea").waitFor();
    await page.waitForTimeout(400);
    const frames = await page.evaluate(() => { window.sampleBundleComposer = false; return window.bundleComposerFrames; });
    assert.ok(frames.length > 1 && frames.every(frame => frame.opacity > 0.99 && frame.visible === 1),
      `the composer stays opaque and unique across a delayed handoff: ${JSON.stringify(frames)}`);
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.locator(".landing-screen textarea").waitFor();
    assert.equal(await page.locator(".landing-screen textarea").inputValue(), "Keep this landing draft");
    assert.deepEqual(errors, []);
  } finally {
    release();
    await context.close();
  }
});

test("opening a running conversation keeps the loading composer disabled without a Stop control", { timeout: 45_000 }, async () => {
  for (const { planType, draft } of [{ planType: "graph", draft: "" }, { planType: "serial", draft: "Keep this landing draft" }]) {
    const { context, page, errors } = await setupPage({ planType, running: true });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const mutations = [];
    page.on("request", request => {
      if (/\/api\/(control|plan_goal_stream)$/.test(new URL(request.url()).pathname)) mutations.push(request.url());
    });
    await page.route(`**/${workbenchChunk().fileName}`, async route => {
      await gate;
      try { await route.continue(); } catch { /* A closed page cancels the request. */ }
    });
    try {
      await page.goto(origin, { waitUntil: "networkidle" });
      const composer = page.locator(".landing-screen textarea");
      await composer.fill(draft);
      await page.locator('[data-run-id="lazy-run"]').click();
      await page.locator(".workbench-module-status[role=status]").waitFor();
      assert.equal(await composer.inputValue(), draft);
      assert.equal(await composer.isDisabled(), true);
      const send = page.locator(".landing-screen .prompt-box-send-btn");
      assert.equal(await send.getAttribute("aria-label"), "Send message",
        "loading a running Run must not turn the retained send button into Stop");
      assert.equal(await send.isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "Click to interrupt execution", exact: true }).count(), 0,
        "a retained landing draft must not expose a separate interrupt button either");
      release();
      await page.locator(".pane-bottom-chat textarea").waitFor();
      await page.locator(".landing-screen").waitFor({ state: "detached" });
      if (planType === "graph") {
        assert.equal(await page.getByRole("button", { name: "Click to interrupt execution", exact: true }).count(), 0,
          "a running worker does not make the idle Planner composer active");
        await page.locator('.task-node[data-node-id="task"]').click();
      }
      await page.locator(".pane-bottom-chat").getByRole("button", { name: "Click to interrupt execution", exact: true }).waitFor();
      assert.deepEqual(mutations, [], "opening a conversation must not submit or interrupt its work");
      assert.deepEqual(errors, []);
    } finally {
      release();
      await context.close();
    }
  }
});

test("a failed workbench load preserves the draft without a reload button and logs the cause", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await setupPage();
  await page.route(`**/${workbenchChunk().fileName}`, route => route.fulfill({ status: 503, body: "Unavailable" }));
  const diagnostics = [];
  page.on("console", message => {
    if (message.type() === "error" && message.text().includes("Could not load conversation view")) diagnostics.push(message.text());
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    const composer = page.locator(".landing-screen textarea");
    await composer.fill("Draft survives failure");
    await page.locator('[data-run-id="lazy-run"]').click();
    const alert = page.locator(".workbench-module-status[role=alert]");
    await alert.waitFor();
    assert.match(await alert.innerText(), /background tasks are unaffected/i);
    assert.equal(await alert.getByRole("button").count(), 0, "the banner must not offer a destructive page reload");
    assert.ok(diagnostics.some(message => message.includes(workbenchChunk().fileName)),
      "the original failing module URL must remain available in the console");
    assert.equal(await composer.isVisible(), true);
    assert.equal(await composer.inputValue(), "Draft survives failure");
    assert.deepEqual(errors, [], "a failed dynamic import must not crash the app");
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".landing-screen textarea")?.disabled);
    assert.equal(await composer.isDisabled(), false, "the user can leave the failed navigation without reloading");
    assert.equal(await composer.inputValue(), "Draft survives failure");
  } finally { await context.close(); }
});

test("development source saves do not cache a temporarily empty module", { timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "grapher-source-save-")));
  const source = path.join(root, "NodeTaskCard.js");
  let dev, watcherReady;
  const ready = new Promise(resolve => { watcherReady = resolve; });
  try {
    await writeFile(source, 'export const NodeTaskCard = () => "Before save";');
    dev = await createServer({
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      root, cacheDir: path.join(root, ".vite"), logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false },
      plugins: [{ name: "source-save-regression", configureServer(server) { server.watcher.once("ready", watcherReady); } }],
    });
    await dev.listen();
    await ready;
    const url = `http://127.0.0.1:${dev.httpServer.address().port}/NodeTaskCard.js`;
    const readCard = async () => {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      const module = await import(`data:text/javascript,${encodeURIComponent(await response.text())}`);
      return module.NodeTaskCard?.();
    };
    assert.equal(await readCard(), "Before save");
    // Model an editor truncating then rewriting a file. Only disposable source
    // is touched; the live checkout and its running dev server are left alone.
    await writeFile(source, "");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await readCard(), "Before save", "serve the last complete module while the write is unfinished");
    await writeFile(source, 'export const NodeTaskCard = () => "After save";');
    const deadline = Date.now() + 5000;
    while (await readCard() !== "After save") {
      assert.ok(Date.now() < deadline, "the completed save must eventually invalidate the old module");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally {
    await dev?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a late module cannot reopen a conversation after returning home", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await setupPage();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/${workbenchChunk().fileName}`, async route => {
    await gate;
    try { await route.continue(); } catch { /* Navigation can cancel the request. */ }
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="lazy-run"]').click();
    await page.locator(".workbench-module-status[role=status]").waitFor();
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    release();
    await page.waitForTimeout(500);
    assert.equal(await page.locator(".workbench").count(), 0);
    assert.equal(await page.locator(".landing-screen textarea").isVisible(), true);
    await page.locator('[data-run-id="lazy-run"]').click();
    await page.locator('.graph-canvas .react-flow__node[data-id="task"]').waitFor();
    assert.deepEqual(errors, []);
  } finally {
    release();
    await context.close();
  }
});
