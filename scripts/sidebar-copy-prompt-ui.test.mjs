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

async function openApp(handler, language = "en", reducedMotion = "reduce") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: language === "en" ? "en-US" : "zh-CN", reducedMotion });
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
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

test("the sidebar always opens expanded, even with a stale collapsed preference", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await openApp(async () => false);
  try {
    const sidebar = page.locator(".sidebar");
    assert.equal(await sidebar.evaluate(element => element.classList.contains("is-collapsed")), false);
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    assert.equal(await sidebar.evaluate(element => element.classList.contains("is-collapsed")), true);
    assert.equal(await sidebar.locator("[title], [role='tooltip']").count(), 0, "the collapsed rail deliberately has no hover labels");

    await page.evaluate(() => localStorage.setItem("grapher_sidebar_collapsed_v1", "true"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('.run-item[data-run-id="a"]').waitFor();
    assert.equal(await sidebar.evaluate(element => element.classList.contains("is-collapsed")), false,
      "a new launch starts expanded");
    assert.equal(await page.getByRole("button", { name: "Collapse sidebar" }).isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("dragging across the sidebar does not select its text", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await openApp(async () => false);
  try {
    const project = page.getByRole("button", { name: "Sidebar /mock/sidebar", exact: true });
    const run = page.locator('.run-item[data-run-id="a"]');
    assert.equal(await project.evaluate(element => getComputedStyle(element).userSelect), "none");
    assert.equal(await run.evaluate(element => getComputedStyle(element).userSelect), "none");
    const start = await project.boundingBox();
    const end = await run.boundingBox();
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 10 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.getSelection().toString()), "");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("sidebar cards and menus support keyboard navigation without opening conversations", { timeout: 30_000 }, async () => {
  const { context, page, calls, errors } = await openApp(async () => false);
  try {
    const project = page.getByRole("button", { name: "Sidebar /mock/sidebar", exact: true });
    await project.focus();
    assert.equal(await project.getAttribute("aria-current"), "true");
    assert.equal(await project.getAttribute("aria-label"), `Sidebar\n${repository}`);
    await project.hover();
    assert.equal(await page.locator(".sidebar [title], .sidebar [role='tooltip']").count(), 0,
      "sidebar labels remain accessible without hover tooltips");
    await page.keyboard.press("Shift+F10");
    assert.equal(await project.getAttribute("aria-expanded"), "true");
    const path = page.getByRole("menuitem", { name: "Copy repository path", exact: true });
    assert.equal(await path.evaluate(item => item === document.activeElement), true);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.copiedTexts.length === 1);
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), [repository]);
    assert.equal(await project.evaluate(item => item === document.activeElement), true);
    assert.equal(await project.getAttribute("aria-expanded"), "false");

    const run = page.locator('.run-item[data-run-id="a"]');
    await run.focus();
    assert.equal(await run.getAttribute("title"), null);
    assert.ok((await run.innerText()).trim(), "the full conversation label supplies the accessible name");
    await page.keyboard.press("ContextMenu");
    const items = page.getByRole("menuitem");
    const focused = () => items.evaluateAll(elements => elements.findIndex(item => item === document.activeElement));
    assert.equal(await focused(), 0);
    await page.keyboard.press("ArrowUp");
    assert.equal(await focused(), 2);
    await page.keyboard.press("ArrowDown");
    assert.equal(await focused(), 0);
    await page.keyboard.press("End");
    assert.equal(await focused(), 2);
    await page.keyboard.press("Home");
    assert.equal(await focused(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("menu").count(), 0);
    assert.equal(await run.evaluate(item => item === document.activeElement), true);

    await page.keyboard.press("Shift+F10");
    await page.keyboard.press("Tab");
    assert.equal(await page.getByRole("menu").count(), 0);
    assert.equal(await page.locator('.run-item[data-run-id="b"]').evaluate(item => item === document.activeElement), true);
    await page.keyboard.press("Shift+F10");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await run.evaluate(item => item === document.activeElement), true);
    await page.keyboard.press("Shift+F10");
    await page.locator(".runs-list").evaluate(list => {
      list.style.maxHeight = "40px";
      list.scrollTop = list.scrollHeight;
    });
    await page.getByRole("menu").waitFor({ state: "detached" });
    assert.equal(calls.some(call => call.command === "history" || call.command === "load_run"), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const [language, reducedMotion] of [["en", "no-preference"], ["zh-CN", "reduce"]]) {
  test(`sidebar menus fit measured content and dismiss on layout changes (${language}, ${reducedMotion})`, { timeout: 30_000 }, async () => {
    const { context, page, errors } = await openApp(async () => false, language, reducedMotion);
    try {
      for (const selector of [".project-workspace-item", '.run-item[data-run-id="b"]']) {
        await page.locator(selector).evaluate(card => card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 1279, clientY: 719 })));
        const menu = page.getByRole("menu");
        // Text scaling may change the menu after its first measurement.
        await page.addStyleTag({ content: ".keyboard-context-menu .context-menu-item { font-size: 22px; }" });
        await page.waitForFunction(() => {
          const box = document.querySelector(".keyboard-context-menu")?.getBoundingClientRect();
          return box && box.left >= 7 && box.top >= 7 && box.right <= innerWidth - 7 && box.bottom <= innerHeight - 7;
        });
        await menu.evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)));
        const box = await menu.boundingBox();
        assert.ok(box.x >= 7 && box.y >= 7 && box.x + box.width <= 1273 && box.y + box.height <= 713, JSON.stringify(box));
        await page.keyboard.press("Escape");
      }
      await page.locator('.run-item[data-run-id="b"]').click({ button: "right" });
      await page.setViewportSize({ width: 360, height: 300 });
      await page.getByRole("menu").waitFor({ state: "detached" });
      await page.locator(".sidebar-toggle-btn").click();
      await page.locator(".project-workspace-item").evaluate(card => card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 359, clientY: 299 })));
      await page.waitForFunction(() => {
        const box = document.querySelector(".keyboard-context-menu")?.getBoundingClientRect();
        return box && box.left >= 7 && box.top >= 7 && box.right <= 353 && box.bottom <= 293;
      });
      // Outside pointer dismissal must not steal the next control's focus.
      await page.locator(".sidebar-toggle-btn").click();
      assert.equal(await page.getByRole("menu").count(), 0);
      assert.equal(await page.locator(".sidebar-toggle-btn").evaluate(item => item === document.activeElement), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("collapsed sidebar lists immediately leave the keyboard tab order", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await openApp(async () => false, "en", "no-preference");
  try {
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    for (let index = 0; index < 3; index++) await page.keyboard.press("Tab");
    assert.equal(await page.getByRole("button", { name: "Settings", exact: true }).evaluate(item => item === document.activeElement), true);
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await page.locator(".project-workspace-item").waitFor({ state: "visible" });
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(".project-workspace-item").evaluate(item => item === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("copy menu items remain legible while hovered", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await openApp(async () => false);
  try {
    await page.locator('.run-item[data-run-id="a"]').click({ button: "right" });
    const menu = page.locator(".context-menu");
    await menu.evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)));

    for (const label of ["Copy snapshot ID", "Copy prompt"]) {
      const item = page.getByRole("menuitem", { name: label, exact: true });
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
    assert.equal(await page.getByRole("menuitem", { name: "Copy snapshot ID", exact: true }).count(), 1);
    assert.equal(await page.getByRole("menuitem", { name: "Delete this history entry", exact: true }).count(), 1);
    assert.equal(calls.filter(call => call.command === "history").length, 0, "opening a menu does not load histories");
    await page.getByRole("menuitem", { name: "Copy prompt", exact: true }).click();
    await page.waitForFunction(() => window.copiedTexts.length === 1);
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), [prompt]);
    assert.equal(await page.locator(".context-menu").count(), 0);
    assert.equal(await page.locator(".run-item.chosen").count(), 0, "copying does not open a conversation");
    assert.equal(calls.filter(call => call.command === "load_run").length, 0);
    assert.deepEqual(calls.filter(call => call.command === "history").map(call => call.body.runId), ["b"]);

    await page.locator('.run-item[data-run-id="a"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy snapshot ID", exact: true }).click();
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
    await page.getByRole("menuitem", { name: "Copy snapshot ID", exact: true }).click();
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
    assert.equal(await page.getByRole("menuitem", { name: "删除此条历史", exact: true }).isDisabled(), true);
    await page.keyboard.press("End");
    assert.equal(await page.getByRole("menuitem", { name: "复制提示词", exact: true }).evaluate(item => item === document.activeElement), true,
      "keyboard navigation skips the disabled delete action");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.getByRole("menuitem", { name: "复制快照 ID", exact: true }).evaluate(item => item === document.activeElement), true);
    await page.getByRole("menuitem", { name: "复制提示词", exact: true }).click();
    await page.waitForFunction(() => window.copiedTexts.length === 1);
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), [prompt]);
    assert.equal(calls.filter(call => call.command === "history").length, 0);

    await pending.click({ button: "right" });
    while (!requested) await page.waitForTimeout(10);
    releasePlanning();
    await page.locator('.run-item[data-run-id="new-run"]').waitFor();
    await page.getByRole("menuitem", { name: "复制提示词", exact: true }).click();
    await page.waitForFunction(() => window.copiedTexts.length === 2);
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), [prompt, prompt]);
    assert.equal(calls.filter(call => call.command === "history").length, 0);
    assert.deepEqual(errors, []);
  } finally { releasePlanning(); await context.close(); }
});

test("/name renames sidebar conversation cards in main Graph and Serial dialogs, not node agent dialogs", { timeout: 30_000 }, async () => {
  const renamed = new Map();
  const buildSnapshot = (runId, goal) => ({
    ...empty,
    runId,
    title: renamed.get(runId) ?? null,
    config,
    approved: true,
    phase: "completed",
    planType: runId === "a" ? "graph" : "serial",
    graph: {
      originalGoal: goal,
      nodes: [{ name: runId === "a" ? "worker" : "task", task: "Do work" }],
      edges: [],
    },
    plan: { executionBatches: [[runId === "a" ? "worker" : "task"]], rootNodes: [runId === "a" ? "worker" : "task"], terminals: [runId === "a" ? "worker" : "task"], warnings: [] },
    nodes: { [runId === "a" ? "worker" : "task"]: { status: "completed", revision: 1, head: "h1", instruction: "", error: null } },
  });
  const { context, page, calls, errors } = await openApp(async (route, command, body) => {
    if (command === "load_run" || command === "history" || (command === "snapshot" && body.runId)) {
      await route.fulfill({ json: { result: buildSnapshot(body.runId, `Prompt ${body.runId}`) } });
      return true;
    }
    if (command === "composer_rename") {
      renamed.set(body.runId, body.title);
      await route.fulfill({ json: { result: buildSnapshot(body.runId, `Prompt ${body.runId}`) } });
      return true;
    }
    if (command === "composer_command") {
      await route.fulfill({ json: { result: { instance: "i", commands: [] } } });
      return true;
    }
    if (command === "get_planning_output" || command === "get_execution_output") {
      await route.fulfill({ json: { result: { content: "", startOffset: 0, nextOffset: 0, totalBytes: 0, complete: true, running: false } } });
      return true;
    }
    if (command === "get_file_changes") {
      await route.fulfill({ json: { result: { summary: { files: [], totalFiles: 0, addedCount: 0, modifiedCount: 0, deletedCount: 0, renamedCount: 0, totalAdditions: 0, totalDeletions: 0 } } } });
      return true;
    }
    return false;
  });
  try {
    // 1. Open Graph conversation "a" and rename it from the main Planner box.
    await page.locator('.run-item[data-run-id="a"]').click();
    await page.locator('.graph-canvas .react-flow__node[data-id="worker"]').waitFor();
    const mainInput = page.locator('.conversation-pane textarea').first();
    await mainInput.fill("/name Renamed Graph Card");
    await mainInput.press("Escape");
    await mainInput.press("Enter");
    await page.locator('.prompt-command-popover[role="status"]').filter({ hasText: "Renamed conversation: Renamed Graph Card" }).waitFor();
    assert.equal(await page.locator('.run-item[data-run-id="a"] .run-title-text').innerText(), "Renamed Graph Card");
    // Copy prompt must still copy the original goal, never the custom sidebar title.
    await copyPrompt(page, "a");
    await page.waitForFunction(() => window.copiedTexts.length === 1);
    assert.deepEqual(await page.evaluate(() => window.copiedTexts), ["Prompt a"]);

    // 2. Select Graph node "worker": its Node Agent dialog hides and forbids /name.
    await page.locator('.graph-canvas .react-flow__node[data-id="worker"]').click();
    const nodeInput = page.locator('.conversation-pane textarea').first();
    await nodeInput.fill("/");
    await page.locator(".prompt-box-suggestions-popover").waitFor();
    assert.ok(!(await page.locator(".prompt-box-suggestions-list").innerText()).includes("/name"));
    await nodeInput.press("Escape");
    await nodeInput.fill("/name Forbidden");
    await nodeInput.press("Escape");
    await nodeInput.press("Enter");
    await page.locator('.prompt-command-popover[role="alert"]').filter({ hasText: "Node agent dialogs cannot use /name" }).waitFor();
    assert.equal(calls.filter(call => call.command === "composer_rename").length, 1);
    assert.equal(await page.locator('.run-item[data-run-id="a"] .run-title-text').innerText(), "Renamed Graph Card");

    // 3. Open Serial conversation "b" and rename it from the Serial main dialog.
    await page.locator('.run-item[data-run-id="b"]').click();
    const serialInput = page.locator('.conversation-pane textarea').first();
    await serialInput.fill("/name Renamed Serial Card");
    await serialInput.press("Escape");
    await serialInput.press("Enter");
    await page.locator('.prompt-command-popover[role="status"]').filter({ hasText: "Renamed conversation: Renamed Serial Card" }).waitFor();
    assert.equal(await page.locator('.run-item[data-run-id="b"] .run-title-text').innerText(), "Renamed Serial Card");
    assert.equal(calls.filter(call => call.command === "composer_rename").length, 2);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
