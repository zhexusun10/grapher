import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { build, preview } from "vite";

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

async function setupPage() {
  const repository = "/mock/lazy-project";
  const config = { repository, model: "test/model", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const graph = { originalGoal: "Load a conversation", nodes: [{ name: "task", task: "Task" }], edges: [] };
  const snapshot = { runId: "lazy-run", config, planType: "graph", phase: "completed", approved: true, paused: false,
    graph, nodes: { task: { status: "completed" } }, plan: null, executions: [], events: [], base: "", feedbackCounts: {} };
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
      case "bootstrap": case "save_config": result = { config, snapshot: empty, runs: [snapshot.runId], repositoryInfo, dataPath: "/mock" }; break;
      case "history": case "snapshot": result = body.runId === snapshot.runId ? snapshot : empty; break;
      case "snapshot_if_changed": result = { version: "1", snapshot: body.runId === snapshot.runId ? snapshot : null }; break;
      case "repository_status": result = { repository, valid: true, error: null }; break;
      case "detect_repository": result = repositoryInfo; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [], models: [], warning: null }; break;
      default: result = null;
    }
    try { await route.fulfill({ json: { result } }); } catch { /* Navigation can cancel a request. */ }
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  return { context, page, errors };
}

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

test("a failed workbench load leaves the draft visible and offers a reload", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await setupPage();
  await page.route(`**/${workbenchChunk().fileName}`, route => route.fulfill({ status: 503, body: "Unavailable" }));
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    const composer = page.locator(".landing-screen textarea");
    await composer.fill("Draft survives failure");
    await page.locator('[data-run-id="lazy-run"]').click();
    const alert = page.locator(".workbench-module-status[role=alert]");
    await alert.waitFor();
    assert.match(await alert.innerText(), /background tasks are unaffected/i);
    assert.equal(await alert.getByRole("button", { name: "Reload page" }).isVisible(), true);
    assert.equal(await composer.isVisible(), true);
    assert.equal(await composer.inputValue(), "Draft survives failure");
    assert.deepEqual(errors, [], "a failed dynamic import must not crash the app");
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".landing-screen textarea")?.disabled);
    assert.equal(await composer.isDisabled(), false, "the user can leave the failed navigation without reloading");
    assert.equal(await composer.inputValue(), "Draft survives failure");
  } finally { await context.close(); }
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
