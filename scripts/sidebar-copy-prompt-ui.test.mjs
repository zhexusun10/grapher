import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

// Exercise the real sidebar with mocked API and clipboard; no workspace data is touched.
let server, browser, origin;
const repository = "/mock/sidebar";
const config = { repository, model: "test/model", thinkingLevel: "low", maxParallel: 2, maxFeedback: 5, autoApprove: false };
const empty = { runId: "", config: null, phase: "draft", graph: { originalGoal: "", nodes: [], edges: [] },
  nodes: {}, executions: [], events: [], mergers: [], plan: null, approved: false, paused: false, base: "", feedbackCounts: {} };
const snapshot = (runId, goal) => ({ ...empty, runId, config, phase: "completed", planType: "serial",
  graph: { ...empty.graph, originalGoal: goal } });

before(async () => {
  server = await createServer({ cacheDir: "node_modules/.vite-sidebar-copy", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false } });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function openApp(handler, language = "en") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: language === "en" ? "en-US" : "zh-CN", reducedMotion: "reduce" });
  await context.addInitScript(({ repository, config, language }) => {
    localStorage.setItem("grapher_language_v1", language);
    localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Sidebar", lastOpened: 1 }]));
    localStorage.setItem("grapher_workspace_runs", JSON.stringify({ [repository]: ["a", "b"] }));
    localStorage.setItem("grapher_run_labels", JSON.stringify({ a: "Old cached A", b: "Old cached B" }));
    localStorage.setItem("grapher_config", JSON.stringify(config));
    window.copiedTexts = [];
    window.clipboardWriteCalls = 0;
    window.rejectClipboard = false;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      write: async items => {
        window.clipboardWriteCalls++;
        if (window.rejectClipboard) throw new Error("Clipboard denied");
        const blob = await items[0].getType("text/plain");
        window.copiedTexts.push(await blob.text());
      },
      writeText: async text => {
        if (window.rejectClipboard) throw new Error("Clipboard denied");
        window.copiedTexts.push(text);
      },
    } });
  }, { repository, config, language });
  const calls = [], errors = [];
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON();
    calls.push({ command, body });
    if (await handler(route, command, body)) return;
    const summaries = ["a", "b"].map(runId => ({ runId, repository, title: `Old summary ${runId}`, phase: "completed", planType: "serial" }));
    const defaults = {
      bootstrap: { config, snapshot: empty, runs: ["a", "b"], conversations: summaries, dataPath: "/mock", repositoryInfo: null },
      history: snapshot(body.runId, `Prompt ${body.runId}`),
      snapshot: body.runId ? snapshot(body.runId, `Prompt ${body.runId}`) : empty,
      snapshot_if_changed: { version: "fixed", snapshot: null },
      repository_status: { repository, valid: true, error: null },
      detect_repository: { path: repository, name: "Sidebar", branch: "main", head: "", clean: true },
      list_plannings: [], list_files: { files: [] }, list_skills: { skills: [] },
      provider_auth: { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null },
      pi_extensions: { globalDirectory: "mock", extensions: [] },
      environment_capabilities: { platform: "windows", arch: "x86_64", nativeWorkspace: true },
    };
    if (!Object.hasOwn(defaults, command)) errors.push(`Unexpected API: ${command}`);
    await route.fulfill({ json: { result: defaults[command] ?? null } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator('.run-item[data-run-id="a"]').waitFor();
  await page.locator('.run-item[data-run-id="b"]').waitFor();
  return { context, page, calls, errors };
}

async function copyPrompt(page, runId, label = "Copy prompt") {
  await page.locator(`.run-item[data-run-id="${runId}"]`).click({ button: "right" });
  await page.getByRole("button", { name: label, exact: true }).click();
}

test("copy menu items remain legible while hovered", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await openApp(async () => false);
  try {
    await page.locator('.run-item[data-run-id="a"]').click({ button: "right" });
    const menu = page.locator(".context-menu");
    await menu.evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)));

    for (const label of ["Copy snapshot ID", "Copy prompt"]) {
      const item = page.getByRole("button", { name: label, exact: true });
      await page.mouse.move(1000, 650);
      await page.waitForTimeout(150);
      const bounds = await item.boundingBox();
      await page.evaluate(name => {
        const target = [...document.querySelectorAll(".context-menu-item")].find(element => element.textContent.trim() === name);
        const menu = target.closest(".context-menu");
        const values = color => color.match(/[\d.]+/g).map(Number);
        const luminance = rgb => {
          const [r, g, b] = rgb.map(value => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        window.hoverSamples = [];
        window.hoverCaptureDone = false;
        let started;
        const sample = now => {
          started ??= now;
          const style = getComputedStyle(target);
          if (target.matches(":hover")) {
            const foreground = values(style.color);
            const background = values(style.backgroundColor);
            const surface = values(getComputedStyle(menu).backgroundColor);
            const alpha = background[3] ?? 1;
            const combined = background.slice(0, 3).map((value, i) => value * alpha + surface[i] * (1 - alpha));
            const light = luminance(foreground), dark = luminance(combined);
            window.hoverSamples.push({ contrast: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05),
              foreground: style.color, background: style.backgroundColor });
          }
          if (now - started < 300) requestAnimationFrame(sample);
          else window.hoverCaptureDone = true;
        };
        requestAnimationFrame(sample);
      }, label);
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.waitForFunction(() => window.hoverCaptureDone);
      const samples = await page.evaluate(() => window.hoverSamples);
      assert.ok(samples.length > 1, `${label} should remain hovered`);
      const lowContrast = samples.filter(sample => sample.contrast < 4.5);
      assert.equal(lowContrast.length, 0, `${label} loses contrast during hover: ${JSON.stringify(lowContrast.slice(0, 4))}`);
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("copies the selected Run's complete current prompt without opening it", { timeout: 30_000 }, async () => {
  const prompt = `  第一行：完整提示词\n\n${"A long line with {braces} and 中文 ".repeat(20)}\nLast line  `;
  const { context, page, calls, errors } = await openApp(async (route, command, body) => {
    if (command !== "history" || body.runId !== "b") return false;
    await route.fulfill({ json: { result: snapshot("b", prompt) } });
    return true;
  });
  try {
    // Even at the bottom edge all three existing/new actions stay visible.
    await page.locator('.run-item[data-run-id="b"]').evaluate(card => card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 1275, clientY: 715 })));
    await page.locator(".context-menu").evaluate(menu => Promise.allSettled(menu.getAnimations().map(animation => animation.finished)));
    const bounds = await page.locator(".context-menu").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1280 && bounds.y + bounds.height <= 720, JSON.stringify(bounds));
    assert.equal(await page.getByRole("button", { name: "Copy snapshot ID", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Delete this history entry", exact: true }).count(), 1);
    assert.equal(calls.filter(call => call.command === "history").length, 0, "opening a menu does not load histories");
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    await page.waitForFunction(() => window.copiedTexts.length === 1);
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), [prompt]);
    assert.equal(await page.locator(".context-menu").count(), 0);
    assert.equal(await page.locator(".run-item.chosen").count(), 0, "copying does not open a conversation");
    assert.equal(calls.filter(call => call.command === "load_run").length, 0);
    assert.deepEqual(calls.filter(call => call.command === "history").map(call => call.body.runId), ["b"]);

    await page.locator('.run-item[data-run-id="a"]').click({ button: "right" });
    await page.getByRole("button", { name: "Copy snapshot ID", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), [prompt, "a"]);
    // Older clipboard implementations still support the writeText fallback.
    await page.evaluate(() => { delete navigator.clipboard.write; });
    await copyPrompt(page, "a");
    await page.waitForFunction(() => window.copiedTexts.length === 3);
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), [prompt, "a", "Prompt a"]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("failed or empty reads never copy cached titles, and clipboard failures are reported", { timeout: 30_000 }, async () => {
  let result = "failure";
  const { context, page, errors } = await openApp(async (route, command, body) => {
    if (command !== "history" || body.runId !== "a") return false;
    if (result === "failure") await route.fulfill({ status: 503, json: { error: "Offline" } });
    else if (result === "mismatch") await route.fulfill({ json: { result: snapshot("b", "Wrong Run") } });
    else await route.fulfill({ json: { result: snapshot("a", result === "empty" ? "" : "Fresh prompt") } });
    return true;
  });
  try {
    await copyPrompt(page, "a");
    await page.getByRole("alert").getByText("Could not load the conversation prompt. Please try again.").waitFor();
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), []);
    await page.locator(".floating-error-close").click();
    await page.getByRole("alert").waitFor({ state: "detached" });

    result = "mismatch";
    await copyPrompt(page, "a");
    await page.getByRole("alert").getByText("Could not load the conversation prompt. Please try again.").waitFor();
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), []);

    result = "empty";
    await copyPrompt(page, "a");
    await page.getByRole("alert").getByText("This conversation has no prompt to copy.").waitFor();
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), []);

    result = "success";
    await page.evaluate(() => { window.rejectClipboard = true; });
    await copyPrompt(page, "a");
    await page.getByRole("alert").getByText("Could not copy the prompt. Please check clipboard permissions.").waitFor();
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), []);
    await page.evaluate(() => { window.rejectClipboard = false; });
    await copyPrompt(page, "a");
    await page.waitForFunction(() => window.copiedTexts.length === 1);
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), ["Fresh prompt"]);
    await page.getByRole("alert").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a slow copy cannot overwrite a newer prompt selection", { timeout: 30_000 }, async () => {
  let releaseSlow, slow;
  const resetSlow = () => { slow = new Promise(resolve => { releaseSlow = resolve; }); };
  resetSlow();
  const { context, page, calls, errors } = await openApp(async (route, command, body) => {
    if (command !== "history" || body.runId !== "a") return false;
    await slow;
    await route.fulfill({ json: { result: snapshot("a", "Slow prompt") } });
    return true;
  });
  try {
    await copyPrompt(page, "a");
    while (!calls.some(call => call.command === "history" && call.body.runId === "a")) await page.waitForTimeout(10);
    assert.equal(await page.evaluate(() => window.clipboardWriteCalls), 1, "clipboard write starts before the backend responds");
    await copyPrompt(page, "b");
    await page.waitForFunction(() => window.copiedTexts.length === 1);
    let response = page.waitForResponse(item => item.url().endsWith("/api/history") && item.request().postDataJSON().runId === "a");
    releaseSlow();
    await response;
    await page.waitForTimeout(50);
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), ["Prompt b"]);

    resetSlow();
    await copyPrompt(page, "a");
    while (calls.filter(call => call.command === "history" && call.body.runId === "a").length < 2) await page.waitForTimeout(10);
    await page.locator('.run-item[data-run-id="b"]').click({ button: "right" });
    await page.getByRole("button", { name: "Copy snapshot ID", exact: true }).click();
    response = page.waitForResponse(item => item.url().endsWith("/api/history") && item.request().postDataJSON().runId === "a");
    releaseSlow();
    await response;
    await page.waitForTimeout(50);
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), ["Prompt b", "b"], "copying an ID cancels an older prompt copy");
    assert.deepEqual(errors, []);
  } finally { releaseSlow(); await context.close(); }
});

test("a provisional conversation keeps its prompt when the durable ID arrives", { timeout: 30_000 }, async () => {
  let releasePlanning, requested = false;
  const gate = new Promise(resolve => { releasePlanning = resolve; });
  const prompt = "创建中的完整中文提示词";
  const { context, page, calls, errors } = await openApp(async (route, command, body) => {
    if (command !== "plan_goal_stream") return false;
    assert.equal(body.goal, prompt);
    requested = true;
    await gate;
    await route.fulfill({ contentType: "text/event-stream", body:
      `event: run_started\ndata: ${JSON.stringify({ runId: "new-run" })}\n\nevent: complete\ndata: ${JSON.stringify({ snapshot: snapshot("new-run", prompt) })}\n\n` });
    return true;
  }, "zh-CN");
  try {
    await page.locator(".landing-screen textarea").fill(prompt);
    await page.locator(".landing-screen textarea").press("Enter");
    const pending = page.locator('.run-item[data-run-id^="pending-"]');
    await pending.waitFor();
    await pending.click({ button: "right" });
    assert.equal(await page.getByRole("button", { name: "删除此条历史", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "复制提示词", exact: true }).click();
    await page.waitForFunction(() => window.copiedTexts.length === 1);
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), [prompt]);
    assert.equal(calls.filter(call => call.command === "history").length, 0);

    await pending.click({ button: "right" });
    while (!requested) await page.waitForTimeout(10);
    releasePlanning();
    await page.locator('.run-item[data-run-id="new-run"]').waitFor();
    await page.getByRole("button", { name: "复制提示词", exact: true }).click();
    await page.waitForFunction(() => window.copiedTexts.length === 2);
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), [prompt, prompt]);
    assert.equal(calls.filter(call => call.command === "history").length, 0);
    assert.deepEqual(errors, []);
  } finally { releasePlanning(); await context.close(); }
});
