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
  server = await createServer({ cacheDir: "node_modules/.vite-sidebar-copy", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null } });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { await browser?.close(); server?.httpServer?.closeAllConnections?.(); await server?.close(); });

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
      get_file_changes: { runId: body.runId, executionId: null, executionIds: null, summary: { files: [], totalFiles: 0, addedCount: 0, modifiedCount: 0, deletedCount: 0, renamedCount: 0, totalAdditions: 0, totalDeletions: 0, isRunning: false } },
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

async function deleteHistory(page, runId) {
  await page.locator(`.run-item[data-run-id="${runId}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete this history entry", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete conversation", exact: true }).click();
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

test("sidebar URL titles and composer multi-line CJK prose wrap cleanly", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await openApp(async () => false);
  try {
    const sidebarLines = await page.locator('.run-item[data-run-id="a"] .run-title-text').evaluate(element => {
      element.textContent = "中https://example.com/a/very/long/path";
      Object.assign(element.style, { flex: "none", width: "160px" });
      const topAt = index => {
        const range = document.createRange();
        range.setStart(element.firstChild, index);
        range.setEnd(element.firstChild, index + 1);
        return Math.round(range.getBoundingClientRect().top);
      };
      return { chinese: topAt(0), url: topAt(1) };
    });
    assert.equal(sidebarLines.chinese, sidebarLines.url, "the URL must not break away from its leading CJK character");

    const composerLines = await page.evaluate(() => {
      const textarea = document.createElement("textarea");
      textarea.className = "prompt-box-textarea";
      textarea.rows = 1;
      Object.assign(textarea.style, { position: "fixed", left: "-10000px", top: "0", width: "400px", height: "0px" });
      document.body.append(textarea);
      const lineCount = () => {
        const style = getComputedStyle(textarea);
        const contentHeight = textarea.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        return Math.round(contentHeight / parseFloat(style.lineHeight));
      };
      // Punctuated CJK prose should fill each line across the available width
      // instead of forcing each comma-delimited clause onto a new short line.
      const punctuated = "第一行可以正确地占据输入框的宽度，第二行之后的中文内容也应该占满可用空间，而不是遇到逗号就提前换行。";
      textarea.value = punctuated;
      const punctuatedLines = lineCount();
      textarea.value = punctuated.replace(/[，。]/g, "字");
      const unpunctuatedLines = lineCount();
      textarea.value = "https://example.com/a/very/long/path/that/must/wrap/without/horizontal/overflow";
      const urlLines = lineCount();
      const urlOverflow = textarea.scrollWidth > textarea.clientWidth;
      textarea.remove();
      return { punctuatedLines, unpunctuatedLines, urlLines, urlOverflow };
    });
    assert.equal(composerLines.punctuatedLines, composerLines.unpunctuatedLines,
      `punctuated CJK prose must wrap across the full composer width without premature clause breaks: ${JSON.stringify(composerLines)}`);
    assert.ok(composerLines.urlLines > 1 && !composerLines.urlOverflow,
      `long URLs still wrap inside the composer width: ${JSON.stringify(composerLines)}`);
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
    assert.equal(await focused(), 3);
    await page.keyboard.press("ArrowDown");
    assert.equal(await focused(), 0);
    await page.keyboard.press("End");
    assert.equal(await focused(), 3);
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
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(".project-workspace-item").evaluate(item => item === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const reducedMotion of ["no-preference"]) {
  test(`deleted conversations leave the sidebar (${reducedMotion})`, { timeout: 30_000 }, async () => {
    const deleted = new Set();
    const { context, page, errors } = await openApp(async (route, command, body) => {
      if (command === "delete_run") {
        deleted.add(body.runId);
        await route.fulfill({ json: { result: null } });
        return true;
      }
      if ((command === "snapshot" || command === "history") && deleted.has(body.runId)) {
        await route.fulfill({ status: 400, json: { error: "Run not found" } });
        return true;
      }
      return false;
    }, "en", reducedMotion);
    try {
      for (const id of ["a", "b"]) {
        await deleteHistory(page, id);
        await page.waitForFunction(id => {
          const index = JSON.parse(localStorage.getItem("grapher-format-1:/mock:grapher_workspace_runs"));
          return !Object.values(index).flat().includes(id);
        }, id);
        await page.locator(`.run-item[data-run-id="${id}"]`).waitFor({ state: "detached" });
      }
      await page.locator(".run-placeholder").waitFor();
      assert.equal(await page.locator(".run-item").count(), 0);
      assert.deepEqual([...deleted], ["a", "b"]);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("deleting an already missing conversation prunes its card, but genuine failures retain it", { timeout: 30_000 }, async () => {
  let failure = "Cannot delete a running execution";
  const { context, page, calls, errors } = await openApp(async (route, command) => {
    if (command !== "delete_run") return false;
    await route.fulfill({ status: failure === "Offline" ? 503 : 400, json: { error: failure } });
    return true;
  });
  try {
    for (const message of ["Cannot delete a running execution", "Offline"]) {
      failure = message;
      await deleteHistory(page, "a");
      await page.getByRole("alert").getByText(message, { exact: true }).waitFor();
      assert.equal(await page.locator('.run-item[data-run-id="a"]').count(), 1);
      assert.deepEqual(await page.evaluate(repository => JSON.parse(localStorage.getItem("grapher-format-1:/mock:grapher_workspace_runs"))[repository], repository), ["a", "b"]);
    }
    failure = "Run not found";
    await deleteHistory(page, "a");
    await page.locator('.run-item[data-run-id="a"]').waitFor({ state: "detached" });
    assert.equal(await page.locator('.run-item[data-run-id="b"]').count(), 1);
    assert.deepEqual(await page.evaluate(repository => JSON.parse(localStorage.getItem("grapher-format-1:/mock:grapher_workspace_runs"))[repository], repository), ["b"]);
    for (const key of ["grapher_run_labels", "grapher_run_modes"]) {
      assert.equal(await page.evaluate(key => Object.hasOwn(JSON.parse(localStorage.getItem(`grapher-format-1:/mock:${key}`)), "a"), key), false);
    }
    assert.equal(calls.filter(call => call.command === "delete_run").length, 3);
    await page.getByRole("alert").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a late snapshot cannot reopen a conversation deleted while it was loading", { timeout: 30_000 }, async () => {
  let releaseSnapshot;
  let snapshotRequested;
  const requested = new Promise(resolve => { snapshotRequested = resolve; });
  const release = new Promise(resolve => { releaseSnapshot = resolve; });
  const { context, page, errors } = await openApp(async (route, command, body) => {
    if (command === "snapshot" && body.runId === "a") {
      snapshotRequested();
      await release;
      await route.fulfill({ json: { result: snapshot("a", "Deleted late snapshot") } });
      return true;
    }
    if (command === "delete_run") {
      await route.fulfill({ json: { result: null } });
      return true;
    }
    return false;
  });
  try {
    await page.locator('.run-item[data-run-id="a"]').click();
    await requested;
    await deleteHistory(page, "a");
    await page.locator('.run-item[data-run-id="a"]').waitFor({ state: "detached" });
    releaseSnapshot();
    await page.waitForTimeout(500);
    assert.equal(await page.getByText("Deleted late snapshot", { exact: true }).count(), 0);
    assert.equal(await page.locator('.run-item[data-run-id="b"]').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    releaseSnapshot();
    await context.close();
  }
});

test("opening a confirmed missing conversation repairs the sidebar without hiding transient failures", { timeout: 30_000 }, async () => {
  let failure = "Offline";
  const { context, page, calls, errors } = await openApp(async (route, command, body) => {
    if (command !== "snapshot" || body.runId !== "a") return false;
    await route.fulfill({ status: failure === "Offline" ? 503 : 400, json: { error: failure } });
    return true;
  });
  try {
    await page.locator('.run-item[data-run-id="a"]').click();
    await page.getByRole("alert").getByText("Offline", { exact: true }).waitFor();
    assert.equal(await page.locator('.run-item[data-run-id="a"]').count(), 1);
    failure = "Run not found";
    await page.locator('.run-item[data-run-id="a"]').click();
    await page.locator('.run-item[data-run-id="a"]').waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(repository => JSON.parse(localStorage.getItem("grapher-format-1:/mock:grapher_workspace_runs"))[repository], repository), ["b"]);
    assert.equal(await page.locator('.run-item[data-run-id="b"]').count(), 1);
    assert.equal(calls.some(call => call.command === "delete_run"), false, "repairing a missing card never deletes another Run");
    await page.getByRole("alert").waitFor({ state: "detached" });
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
    for (let i = 0; !requested && i < 500; i++) await page.waitForTimeout(10);
    assert.equal(requested, true, "planning request should start before releasing");
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
      nodes: [{ id: runId === "a" ? "worker" : "task", task: "Do work" }],
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

test("adding workspace and conversation cards opens space smoothly without opacity flicker, scrollbar flash or layout jump", { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US", reducedMotion: "no-preference" });
  const errors = [];
  let pickCount = 0;
  let releasePlanning;
  const planningGate = new Promise(resolve => { releasePlanning = resolve; });
  try {
    await context.addInitScript(({ config }) => {
      localStorage.setItem("grapher_language_v1", "en");
      localStorage.setItem("grapher_projects", JSON.stringify([]));
      localStorage.setItem("grapher_config", JSON.stringify({ ...config, repository: "" }));
    }, { config });
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      if (command === "pick_repository") {
        pickCount += 1;
        const path = `/mock/ws-${pickCount}`;
        await route.fulfill({ json: { result: { supported: true, cancelled: false, repository: { path, name: `Workspace ${pickCount}`, branch: "main", head: "", clean: true } } } });
        return;
      }
      if (command === "plan_goal_stream") {
        await planningGate;
        await route.fulfill({ contentType: "text/event-stream", body:
          `event: run_started\ndata: ${JSON.stringify({ runId: "conv-3" })}\n\nevent: complete\ndata: ${JSON.stringify({ snapshot: snapshot("conv-3", body.goal) })}\n\n` });
        return;
      }
      const defaults = {
        bootstrap: { config: { ...config, repository: "" }, snapshot: empty, runs: [], conversations: [
          { runId: "conv-1", repository: "/mock/ws-2", title: "Existing one", phase: "completed", planType: "serial" },
          { runId: "conv-2", repository: "/mock/ws-2", title: "Existing two", phase: "completed", planType: "serial" },
        ], dataPath: "/mock", repositoryInfo: null },
        repository_status: { repository: body.repository, valid: true, error: null },
        detect_repository: { path: body.repository, name: "Workspace", branch: "main", head: "", clean: true },
        snapshot_if_changed: { version: "fixed", snapshot: null },
        list_plannings: [], list_files: { files: [] }, list_skills: { skills: [] },
        provider_auth: { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null },
        pi_extensions: { globalDirectory: "mock", extensions: [] },
        environment_capabilities: { platform: "darwin", arch: "arm64", nativeWorkspace: true },
        composer_command: { instance: "i", commands: [] },
        get_planning_output: { content: "", startOffset: 0, nextOffset: 0, totalBytes: 0, complete: true, running: false },
        get_execution_output: { content: "", startOffset: 0, nextOffset: 0, totalBytes: 0, complete: true, running: false },
        get_file_changes: { runId: body.runId, executionId: null, executionIds: null, summary: { files: [], totalFiles: 0, addedCount: 0, modifiedCount: 0, deletedCount: 0, renamedCount: 0, totalAdditions: 0, totalDeletions: 0, isRunning: false } },
        delete_workspace: [body.repository],
      };
      if (!Object.hasOwn(defaults, command)) errors.push(`Unexpected API: ${command}`);
      await route.fulfill({ json: { result: defaults[command] ?? null } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(".projects-placeholder").waitFor();
    await page.locator(".projects-placeholder").evaluate(el => Promise.allSettled(el.getAnimations().map(a => a.finished)));

    const startSampling = (selector) => page.evaluate((sel) => {
      window.__cardSamples = [];
      window.__sampling = true;
      const sample = () => {
        const list = document.querySelector(sel);
        const cards = list ? [...list.querySelectorAll("button")].map(el => ({
          label: el.textContent?.trim(),
          id: el.getAttribute("data-run-id") || el.querySelector("strong")?.textContent,
          top: el.getBoundingClientRect().top,
          height: el.getBoundingClientRect().height,
          opacity: Number(getComputedStyle(el).opacity),
          transitionProperty: getComputedStyle(el).transitionProperty,
        })) : [];
        window.__cardSamples.push({
          scrollable: list ? list.scrollHeight > list.clientHeight : false,
          clientHeight: list ? list.clientHeight : 0,
          scrollHeight: list ? list.scrollHeight : 0,
          cards,
        });
        if (window.__sampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, selector);

    const stopSampling = () => page.evaluate(() => {
      window.__sampling = false;
      return window.__cardSamples;
    });

    // 1. Adding the first workspace (0 -> 1) must not flash a scrollbar or declare a CSS opacity transition.
    await startSampling(".projects-list");
    await page.locator(".projects-label .sidebar-add-btn").click();
    await page.locator(".project-workspace-item", { hasText: "Workspace 1" }).waitFor();
    await page.waitForTimeout(320);
    const firstWsSamples = await stopSampling();
    assert.ok(firstWsSamples.every(frame => !frame.scrollable), `0->1 workspace flashed overflow: ${JSON.stringify(firstWsSamples)}`);
    const wsTransition = await page.locator(".project-workspace-item").first().evaluate(el => getComputedStyle(el).transitionProperty);
    assert.equal(wsTransition.split(",").map(s => s.trim()).includes("opacity"), false,
      `workspace card must not CSS-transition opacity alongside Motion/WAAPI: ${wsTransition}`);

    // 2. Adding a second workspace (1 -> 2) opens smoothly instead of jumping Workspace 1 down in one frame.
    const ws1BeforeTop = await page.locator(".project-workspace-item", { hasText: "Workspace 1" }).evaluate(el => el.getBoundingClientRect().top);
    await startSampling(".projects-list");
    await page.locator(".projects-label .sidebar-add-btn").click();
    await page.locator(".project-workspace-item", { hasText: "Workspace 2" }).waitFor();
    await page.waitForTimeout(320);
    const secondWsSamples = await stopSampling();
    const wsFramesWithBoth = secondWsSamples.filter(frame => frame.cards.length === 2);
    assert.ok(wsFramesWithBoth.length > 0);
    const ws1SettledTop = wsFramesWithBoth.at(-1).cards[1].top;
    assert.ok(wsFramesWithBoth.some(frame => frame.cards[1].top > ws1BeforeTop + 2 && frame.cards[1].top < ws1SettledTop - 2),
      `Workspace 1 should glide down through intermediate positions instead of snapping: ${JSON.stringify(wsFramesWithBoth.map(f => f.cards.map(c => ({ id: c.id, top: c.top, h: c.height, op: c.opacity }))))}`);
    assert.ok(wsFramesWithBoth.every(frame => !frame.scrollable));

    // 3. Adding a new conversation above existing ones (2 -> 3) opens smoothly (including 2-line titles) and settles cleanly.
    await page.locator('.run-item[data-run-id="conv-1"]').waitFor();
    const conv1BeforeTop = await page.locator('.run-item[data-run-id="conv-1"]').evaluate(el => el.getBoundingClientRect().top);
    const twoLinePrompt = "A longer conversation title that wraps across two lines in the sidebar";
    await page.locator(".landing-screen textarea").fill(twoLinePrompt);
    await startSampling(".runs-list");
    await page.locator(".landing-screen textarea").press("Enter");
    await page.locator('.run-item[data-run-id^="pending-"]').waitFor();
    await page.waitForTimeout(320);
    const convSamples = await stopSampling();
    const convFramesWithThree = convSamples.filter(frame => frame.cards.length === 3);
    assert.ok(convFramesWithThree.length > 0);
    const conv1SettledTop = convFramesWithThree.at(-1).cards[1].top;
    assert.ok(convFramesWithThree.some(frame => frame.cards[1].top > conv1BeforeTop + 2 && frame.cards[1].top < conv1SettledTop - 2),
      `Existing conversation card should glide down smoothly: ${JSON.stringify(convFramesWithThree.map(f => f.cards.map(c => ({ id: c.id, top: c.top, h: c.height, op: c.opacity }))))}`);
    assert.ok(convFramesWithThree.at(-1).cards[0].height > 44, "two-line conversation card settles at its natural multi-line height");
    releasePlanning();
    await page.locator('.run-item[data-run-id="conv-3"]').waitFor();
    assert.equal(await page.locator('.run-item[data-run-id="conv-3"]').evaluate(el => getComputedStyle(el).opacity), "1");

    // 4. Removing a newly added workspace mid-entrance cleanly completes exit.
    await page.locator(".projects-label .sidebar-add-btn").click();
    await page.locator(".project-workspace-item", { hasText: "Workspace 3" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove from workspace", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove workspace", exact: true }).click();
    await page.locator(".project-workspace-item", { hasText: "Workspace 3" }).waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  } finally {
    releasePlanning();
    await context.close();
  }
});

for (const reducedMotion of ["no-preference"]) {
  test(`workspaces and conversations support archiving, unarchiving, toggle animation and reload persistence (${reducedMotion})`, { timeout: 30_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US", reducedMotion });
    const errors = [];
    const ws1 = "/mock/ws-alpha";
    const ws2 = "/mock/ws-beta";
    const wsConfig = { ...config, repository: ws1 };
    try {
      await context.addInitScript(({ ws1, ws2, wsConfig }) => {
        if (localStorage.getItem("__archive_test_seeded")) return;
        localStorage.setItem("__archive_test_seeded", "1");
        localStorage.setItem("grapher_language_v1", "en");
        localStorage.setItem("grapher_projects", JSON.stringify([
          { id: ws1, path: ws1, name: "Alpha", branch: "main", clean: true, lastOpened: 200 },
          { id: ws2, path: ws2, name: "Beta", branch: "main", clean: true, lastOpened: 100 },
        ]));
        localStorage.setItem("grapher_config", JSON.stringify(wsConfig));
      }, { ws1, ws2, wsConfig });
      await context.route("**/api/*", async route => {
        const command = new URL(route.request().url()).pathname.slice(5);
        const body = route.request().postDataJSON();
        const summaries = [
          { runId: "a1", repository: ws1, title: "Alpha conversation 1", phase: "completed", planType: "serial" },
          { runId: "a2", repository: ws1, title: "Alpha conversation 2", phase: "completed", planType: "serial" },
          { runId: "b1", repository: ws2, title: "Beta conversation 1", phase: "completed", planType: "serial" },
        ];
        const runRepo = id => (id && id.startsWith("b") ? ws2 : ws1);
        const runSnap = id => ({
          ...empty,
          runId: id,
          config: { ...wsConfig, repository: runRepo(id) },
          phase: "completed",
          planType: "serial",
          graph: { ...empty.graph, originalGoal: `Prompt ${id}` },
        });
        const defaults = {
          bootstrap: { config: wsConfig, snapshot: empty, runs: ["a1", "a2", "b1"], conversations: summaries, dataPath: "/mock", repositoryInfo: null },
          save_config: { config: body?.config ?? wsConfig, snapshot: empty, runs: ["a1", "a2", "b1"], dataPath: "/mock", repositoryInfo: null },
          snapshot: body.runId ? runSnap(body.runId) : empty,
          history: body.runId ? runSnap(body.runId) : empty,
          snapshot_if_changed: { version: "fixed", snapshot: null },
          repository_status: { repository: body.repository, valid: true, error: null },
          detect_repository: { path: body.repository, name: body.repository === ws2 ? "Beta" : "Alpha", branch: "main", head: "", clean: true },
          list_plannings: [], list_files: { files: [] }, list_skills: { skills: [] },
          provider_auth: { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null },
          pi_extensions: { globalDirectory: "mock", extensions: [] },
          environment_capabilities: { platform: "darwin", arch: "arm64", nativeWorkspace: true },
          composer_command: { instance: "i", commands: [] },
          get_planning_output: { content: "", startOffset: 0, nextOffset: 0, totalBytes: 0, complete: true, running: false },
          get_execution_output: { content: "", startOffset: 0, nextOffset: 0, totalBytes: 0, complete: true, running: false },
          get_file_changes: { runId: body.runId, executionId: null, executionIds: null, summary: { files: [], totalFiles: 0, addedCount: 0, modifiedCount: 0, deletedCount: 0, renamedCount: 0, totalAdditions: 0, totalDeletions: 0, isRunning: false } },
        };
        if (!Object.hasOwn(defaults, command)) errors.push(`Unexpected API: ${command}`);
        await route.fulfill({ json: { result: defaults[command] ?? null } });
      });

      const page = await context.newPage();
      page.setDefaultTimeout(8_000);
      page.on("pageerror", error => errors.push(String(error)));
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.locator('.run-item[data-run-id="a1"]').waitFor();
      await page.locator('.run-item[data-run-id="a2"]').waitFor();

      // Archive buttons sit directly to the left of each section's + button.
      const wsArchiveBtn = page.locator(".projects-label .sidebar-archive-btn[aria-pressed]");
      const wsAddBtn = page.locator(".projects-label .sidebar-add-btn");
      const runArchiveBtn = page.locator(".runs-label .sidebar-archive-btn[aria-pressed]");
      const runAddBtn = page.locator(".runs-label .sidebar-add-btn");
      const [wsArchBox, wsAddBox, runArchBox, runAddBox] = await Promise.all([
        wsArchiveBtn.boundingBox(), wsAddBtn.boundingBox(),
        runArchiveBtn.boundingBox(), runAddBtn.boundingBox(),
      ]);
      assert.ok(wsArchBox.x + wsArchBox.width <= wsAddBox.x, "workspace archive button sits left of +");
      assert.ok(runArchBox.x + runArchBox.width <= runAddBox.x, "conversation archive button sits left of +");
      assert.equal(await wsArchiveBtn.getAttribute("title"), null);
      assert.equal(await runArchiveBtn.getAttribute("title"), null);

      // Open conversation a1, then archive it via right-click: it leaves the active list and detaches to landing view.
      await page.locator('.run-item[data-run-id="a1"]').click();
      await page.locator('.run-item[data-run-id="a1"].chosen').waitFor();
      await page.locator('.run-item[data-run-id="a1"]').click({ button: "right" });
      await page.getByRole("menuitem", { name: "Archive conversation", exact: true }).click();
      await page.locator('.run-item[data-run-id="a1"]').waitFor({ state: "detached" });
      assert.equal(await page.locator('.run-item[data-run-id="a2"]').count(), 1);
      await page.locator(".landing-screen").waitFor();

      // Toggle archived conversations view (reusing .runs-list), verify a1 is shown and animates smoothly without scrollbar flash.
      if (reducedMotion === "no-preference") {
        await page.evaluate(() => {
          window.__archiveAnimSamples = [];
          window.__archiveSampling = true;
          const sample = () => {
            const list = document.querySelector(".runs-list");
            const view = list?.querySelector(".runs-list-view");
            window.__archiveAnimSamples.push({
              scrollable: list ? list.scrollHeight > list.clientHeight : false,
              opacity: view ? Number(getComputedStyle(view).opacity) : null,
              transform: view ? getComputedStyle(view).transform : null,
            });
            if (window.__archiveSampling) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
      }
      await runArchiveBtn.click();
      assert.equal(await runArchiveBtn.getAttribute("aria-pressed"), "true");
      await page.locator('.run-item[data-run-id="a1"]').waitFor();
      assert.equal(await page.locator('.run-item[data-run-id="a2"]').count(), 0);
      if (reducedMotion === "no-preference") {
        await page.waitForTimeout(260);
        const animSamples = await page.evaluate(() => {
          window.__archiveSampling = false;
          return window.__archiveAnimSamples;
        });
        assert.ok(animSamples.every(frame => !frame.scrollable), `archive view switch flashed overflow: ${JSON.stringify(animSamples)}`);
        assert.ok(animSamples.some(frame => frame.opacity !== null && frame.opacity < 0.95),
          `archive view switch should animate opacity/transform: ${JSON.stringify(animSamples)}`);
      }

      // Right-click in archived view shows Unarchive conversation and moves a1 back to active list.
      await page.locator('.run-item[data-run-id="a1"]').click({ button: "right" });
      await page.getByRole("menuitem", { name: "Unarchive conversation", exact: true }).click();
      await page.locator('.run-item[data-run-id="a1"]').waitFor({ state: "detached" });
      await page.locator(".run-placeholder", { hasText: "No archived conversations" }).waitFor();

      // Toggle back to active conversations: a1 is restored alongside a2.
      await runArchiveBtn.click();
      assert.equal(await runArchiveBtn.getAttribute("aria-pressed"), "false");
      await page.locator('.run-item[data-run-id="a1"]').waitFor();
      await page.locator('.run-item[data-run-id="a2"]').waitFor();

      // Archive a2 and archive active workspace Alpha: Beta becomes active automatically.
      await page.locator('.run-item[data-run-id="a2"]').click({ button: "right" });
      await page.getByRole("menuitem", { name: "Archive conversation", exact: true }).click();
      await page.locator('.run-item[data-run-id="a2"]').waitFor({ state: "detached" });

      await page.locator(".project-workspace-item", { hasText: "Alpha" }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Archive workspace", exact: true }).click();
      await page.locator(".project-workspace-item", { hasText: "Alpha" }).waitFor({ state: "detached" });
      await page.locator(".project-workspace-item.active", { hasText: "Beta" }).waitFor();
      await page.locator('.run-item[data-run-id="b1"]').waitFor();

      // Reload persists both workspace and conversation archive states.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(".project-workspace-item.active", { hasText: "Beta" }).waitFor();
      assert.equal(await page.locator(".project-workspace-item", { hasText: "Alpha" }).count(), 0);

      // Toggle archived workspaces, inspect Alpha, and verify a2 is still archived inside Alpha.
      await wsArchiveBtn.click();
      assert.equal(await wsArchiveBtn.getAttribute("aria-pressed"), "true");
      await page.locator(".project-workspace-item", { hasText: "Alpha" }).waitFor();
      assert.equal(await page.locator(".project-workspace-item", { hasText: "Beta" }).count(), 0);
      await page.locator(".project-workspace-item", { hasText: "Alpha" }).click();
      await page.locator('.run-item[data-run-id="a1"]').waitFor();
      assert.equal(await page.locator('.run-item[data-run-id="a2"]').count(), 0);
      await runArchiveBtn.click();
      await page.locator('.run-item[data-run-id="a2"]').waitFor();

      // Unarchive Alpha from archived workspaces view, then toggle back to active workspaces.
      await page.locator(".project-workspace-item", { hasText: "Alpha" }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Unarchive workspace", exact: true }).click();
      await page.locator(".project-workspace-item", { hasText: "Alpha" }).waitFor({ state: "detached" });
      await page.locator(".projects-placeholder", { hasText: "No archived workspaces" }).waitFor();
      await wsArchiveBtn.click();
      await page.locator(".project-workspace-item", { hasText: "Alpha" }).waitFor();
      await page.locator(".project-workspace-item", { hasText: "Beta" }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test("continuing an older conversation moves its card to the first position without reordering on passive view", { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US", reducedMotion: "no-preference" });
  const errors = [];
  let releaseGraphFollowUp;
  const graphFollowUpGate = new Promise(resolve => { releaseGraphFollowUp = resolve; });
  const serialSnap = (runId, goal, events = []) => ({
    ...empty,
    runId,
    config,
    planType: "serial",
    phase: "completed",
    approved: true,
    graph: { originalGoal: goal, nodes: [{ id: "task", task: goal }], edges: [] },
    nodes: { task: { status: "completed", revision: 1 } },
    executions: [{
      id: `exec-${runId}`, node: "task", revision: 1, attempt: 1, sessionId: `sess-${runId}`,
      worktree: repository, before: "", after: "", status: "completed", output: "", outputBytes: 0,
      startedAt: 1, completedAt: 2,
    }],
    events,
  });
  const graphSnap = (runId, goal) => ({
    ...empty,
    runId,
    config,
    planType: "graph",
    planningId: `plan-${runId}`,
    phase: "awaiting_approval",
    approved: false,
    graph: { originalGoal: goal, nodes: [{ id: "a", task: "Task A" }], edges: [] },
    nodes: { a: { status: "waiting", revision: 0 } },
    events: [],
  });
  const snapshots = {
    "conv-3": serialSnap("conv-3", "Newest conversation"),
    "conv-2": graphSnap("conv-2", "Middle graph conversation"),
    "conv-1": serialSnap("conv-1", "Oldest serial conversation"),
  };
  const summaries = [
    { runId: "conv-3", repository, title: "Newest conversation", phase: "completed", planType: "serial" },
    { runId: "conv-2", repository, title: "Middle graph conversation", phase: "awaiting_approval", planType: "graph" },
    { runId: "conv-1", repository, title: "Oldest serial conversation", phase: "completed", planType: "serial" },
  ];
  try {
    await context.addInitScript(({ repository, config }) => {
      localStorage.setItem("grapher_language_v1", "en");
      localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Repo", branch: "main", clean: true, lastOpened: 1 }]));
      localStorage.setItem("grapher_config", JSON.stringify(config));
    }, { repository, config });
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      if (command === "plan_goal_stream") {
        const targetId = body.revisionRunId || "conv-2";
        await graphFollowUpGate;
        await route.fulfill({
          contentType: "text/event-stream",
          body: `event: run_started\ndata: ${JSON.stringify({ runId: targetId })}\n\nevent: complete\ndata: ${JSON.stringify({ snapshot: snapshots[targetId] })}\n\n`,
        });
        return;
      }
      if (command === "control" && body.action === "intervene") {
        const current = snapshots[body.runId];
        const next = {
          ...current,
          events: [...(current.events || []), { sequence: 10, type: "invalidated", target: body.node || "task", instruction: body.instruction, request_id: body.requestId }],
        };
        snapshots[body.runId] = next;
        await route.fulfill({ json: { result: next } });
        return;
      }
      const defaults = {
        bootstrap: { config, snapshot: empty, runs: ["conv-3", "conv-2", "conv-1"], conversations: summaries, dataPath: "/mock", repositoryInfo: null },
        save_config: { config: body?.config ?? config, snapshot: empty, runs: ["conv-3", "conv-2", "conv-1"], dataPath: "/mock", repositoryInfo: null },
        snapshot: body?.runId ? snapshots[body.runId] ?? empty : empty,
        history: body?.runId ? snapshots[body.runId] ?? empty : empty,
        snapshot_if_changed: { version: "fixed", snapshot: null },
        repository_status: { repository: body?.repository ?? repository, valid: true, error: null },
        detect_repository: { path: repository, name: "Repo", branch: "main", head: "", clean: true },
        list_plannings: [], list_files: { files: [] }, list_skills: { skills: [] },
        provider_auth: { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null },
        pi_extensions: { globalDirectory: "mock", extensions: [] },
        environment_capabilities: { platform: "darwin", arch: "arm64", nativeWorkspace: true },
        composer_command: { instance: "i", commands: [] },
        get_planning_output: { runId: body?.runId ?? "", planningId: body?.planningId ?? "", role: "planner", content: "", startOffset: 0, nextOffset: 0, totalBytes: 0, complete: true, running: false },
        get_execution_output: { runId: body?.runId ?? "", executionId: body?.executionId ?? "", content: "", startOffset: 0, nextOffset: 0, totalBytes: 0, complete: true, running: false, status: "completed" },
        get_file_changes: { runId: body?.runId, executionId: null, executionIds: null, summary: { files: [], totalFiles: 0, addedCount: 0, modifiedCount: 0, deletedCount: 0, renamedCount: 0, totalAdditions: 0, totalDeletions: 0, isRunning: false } },
      };
      if (!Object.hasOwn(defaults, command)) errors.push(`Unexpected API: ${command}`);
      await route.fulfill({ json: { result: defaults[command] ?? null } });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator('.run-item[data-run-id="conv-1"]').waitFor();
    const cardOrder = () => page.locator(".runs-list .run-item").evaluateAll(items => items.map(item => item.dataset.runId));
    assert.deepEqual(await cardOrder(), ["conv-3", "conv-2", "conv-1"]);

    // Passively opening an older conversation must not change sidebar order.
    await page.locator('.run-item[data-run-id="conv-1"]').click();
    await page.locator('.run-item[data-run-id="conv-1"].chosen').waitFor();
    await page.locator(".pane-bottom-chat textarea").waitFor();
    assert.deepEqual(await cardOrder(), ["conv-3", "conv-2", "conv-1"]);

    // Sending a follow-up in conv-1 moves it smoothly to the first position without flashing scroll overflow.
    const conv1BeforeTop = await page.locator('.run-item[data-run-id="conv-1"]').evaluate(el => el.getBoundingClientRect().top);
    await page.evaluate(() => {
      window.__reorderSamples = [];
      window.__samplingReorder = true;
      const sample = () => {
        const list = document.querySelector(".runs-list");
        const conv1 = document.querySelector('.run-item[data-run-id="conv-1"]');
        window.__reorderSamples.push({
          scrollable: list ? list.scrollHeight > list.clientHeight : false,
          conv1Top: conv1 ? conv1.getBoundingClientRect().top : null,
        });
        if (window.__samplingReorder) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.locator(".pane-bottom-chat textarea").fill("Follow up in oldest serial conversation");
    await page.locator(".pane-bottom-chat textarea").press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll(".runs-list .run-item")].map(el => el.dataset.runId).join(",") === "conv-1,conv-3,conv-2");
    await page.waitForTimeout(300);
    const reorderSamples = await page.evaluate(() => {
      window.__samplingReorder = false;
      return window.__reorderSamples;
    });
    const conv1AfterTop = await page.locator('.run-item[data-run-id="conv-1"]').evaluate(el => el.getBoundingClientRect().top);
    assert.ok(conv1AfterTop < conv1BeforeTop - 20, `conv-1 should settle at the top (${conv1BeforeTop} -> ${conv1AfterTop})`);
    assert.ok(reorderSamples.every(frame => !frame.scrollable), `reordering cards must not flash overflow: ${JSON.stringify(reorderSamples)}`);
    assert.deepEqual(await cardOrder(), ["conv-1", "conv-3", "conv-2"]);
    assert.deepEqual(
      await page.evaluate((repoKey) => JSON.parse(localStorage.getItem("grapher-format-1:/mock:grapher_workspace_runs"))[repoKey], repository),
      ["conv-1", "conv-3", "conv-2"],
    );

    // Continuing an older Graph conversation moves it to the first position immediately while Planner is still streaming.
    await page.locator('.run-item[data-run-id="conv-2"]').click();
    await page.locator('.run-item[data-run-id="conv-2"].chosen').waitFor();
    assert.deepEqual(await cardOrder(), ["conv-1", "conv-3", "conv-2"], "opening conv-2 does not reorder yet");
    await page.locator(".pane-bottom-chat textarea").fill("Revise the graph plan");
    await page.locator(".pane-bottom-chat textarea").press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll(".runs-list .run-item")].map(el => el.dataset.runId).join(",") === "conv-2,conv-1,conv-3");
    releaseGraphFollowUp();
    await page.waitForTimeout(100);
    assert.deepEqual(await cardOrder(), ["conv-2", "conv-1", "conv-3"]);
    assert.deepEqual(errors, []);
  } finally {
    releaseGraphFollowUp();
    await context.close();
  }
});
