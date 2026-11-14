import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

async function expectHomeLayout(page, titleVisible = true) {
  await expect.poll(() => page.evaluate(() => {
    const title = document.querySelector(".landing-title-copy");
    const visible = title.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const composer = document.querySelector(".landing-screen .prompt-box-container");
    const box = composer.getBoundingClientRect();
    // Check the text too: a parent rectangle can fit while its glyphs overflow.
    const textFits = [...title.children].every(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom + 16 <= box.top;
    });
    const buttons = [...composer.querySelectorAll("button")].filter(button => button.checkVisibility() && !button.closest("[inert]"));
    return {
      settled: !composer.hasAttribute("data-resizing"),
      titleVisible: visible,
      titleFits: !visible || textFits,
      composerFits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
      controlsFit: buttons.every(button => { const b = button.getBoundingClientRect(); return b.left >= box.left && b.right <= box.right + 1 && b.top >= box.top && b.bottom <= box.bottom; }),
      noOverflow: composer.scrollWidth <= composer.clientWidth,
    };
  }), { message: `home layout at ${JSON.stringify(page.viewportSize())}` }).toEqual({
    settled: true, titleVisible, titleFits: true, composerFits: true, controlsFit: true, noOverflow: true,
  });
}

// Real app, mocked APIs: presentation checks must never start a task or touch a workspace.
for (const language of ["en", "zh-CN"]) {
  test(`home and settings stay usable at desktop and phone sizes (${language})`, { timeout: 90_000 }, async () => {
    const repository = "/mock/interface-project";
    const config = { repository, model: "test/model", thinkingLevel: "off", maxParallel: 2, maxFeedback: 3, autoApprove: false };
    const snapshot = { runId: "", config: null, phase: "draft", graph: { originalGoal: "", nodes: [], edges: [] },
      nodes: {}, executions: [], events: [], mergers: [], plan: null, approved: false, paused: false, base: "", feedbackCounts: {} };
    const results = {
      bootstrap: { config, snapshot, runs: [], repositoryInfo: { path: repository, name: "Interface project", branch: "main", clean: true, head: "" }, dataPath: "/mock", envOverrides: {} },
      snapshot, snapshot_if_changed: { version: "fixed", snapshot: null }, list_plannings: [],
      repository_status: { repository, valid: true, error: null }, list_files: { files: [] }, list_skills: { skills: [] },
      provider_auth: { providers: [{ id: "test", name: "Test", methods: [], configured: true }], warning: null,
        models: [{ provider: "test", id: "model", name: "Model", api: "mock", available: true, contextWindow: 1000, thinkingLevels: ["off"] }] },
      pi_extensions: { globalDirectory: "/mock", extensions: [] },
      environment_capabilities: { platform: "windows", arch: "x86_64", nativeWorkspace: true },
    };
    const errors = [];
    const server = await createServer({ cacheDir: "node_modules/.vite-ui-polish",
      server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false } });
    let browser;
    try {
      await server.listen();
      browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: language,
        reducedMotion: language === "en" ? "no-preference" : "reduce" });
      await context.addInitScript(({ repository, language }) => {
        localStorage.setItem("grapher_language_v1", language);
        localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Interface project", lastOpened: 1 }]));
        localStorage.setItem("grapher_hide_auto_mode_v1", "false");
      }, { repository, language });
      await context.route("**/api/*", async route => {
        const command = new URL(route.request().url()).pathname.slice(5);
        if (!(command in results)) errors.push(`Unexpected API: ${command}`);
        await route.fulfill({ json: { result: results[command] ?? null } });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", error => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle" });
      const input = page.locator(".landing-screen textarea");
      const draft = "Build a thoughtful interface.\nKeep the existing functionality intact.";
      await input.fill(draft);

      for (const [width, height] of [[1440, 900], [1280, 768], [1100, 768], [1024, 768], [961, 768], [960, 768], [768, 600], [390, 844], [320, 568], [900, 420]]) {
        await page.setViewportSize({ width, height });
        await expectHomeLayout(page);
        if (process.env.GRAPHER_UI_SCREENSHOTS) {
          await mkdir(process.env.GRAPHER_UI_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: join(process.env.GRAPHER_UI_SCREENSHOTS, `${language}-home-${width}.png`) });
        }
        assert.equal(await input.inputValue(), draft, "resizing preserves the draft");
      }

      // A capped long draft must not collide with welcome copy either. Only
      // genuinely insufficient free space hides the copy, without losing text.
      const longDraft = "Keep this long editable draft.\n".repeat(40);
      await page.setViewportSize({ width: 320, height: 568 });
      await input.fill(longDraft);
      await expectHomeLayout(page);
      const expand = page.locator(".landing-screen .prompt-box-expand-btn");
      await expand.click();
      await expectHomeLayout(page, false);
      assert.equal(await input.inputValue(), longDraft);
      await expand.click();
      await expectHomeLayout(page);
      await page.setViewportSize({ width: 320, height: 420 });
      await expectHomeLayout(page, false);
      assert.equal(await input.inputValue(), longDraft);
      await input.fill("");
      await expectHomeLayout(page);
      await input.fill(draft);
      await page.setViewportSize({ width: 390, height: 844 });
      await expectHomeLayout(page);
      await input.focus();
      await page.keyboard.press("Tab");
      const focus = await page.locator(":focus").evaluate(element => ({
        composerControl: Boolean(element.closest(".prompt-box-container")),
        visible: getComputedStyle(element).outlineStyle !== "none" && parseFloat(getComputedStyle(element).outlineWidth) > 0,
      }));
      assert.deepEqual(focus, { composerControl: true, visible: true }, "keyboard users can locate the focused composer action");

      await page.locator(".sidebar-bottom-btn").click();
      await page.locator(".settings-modal").waitFor();
      for (const [width, height] of [[1280, 800], [390, 844], [320, 568], [900, 420]]) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(450);
        const sections = page.locator(".settings-modal-content .settings-sections");
        await sections.evaluate(element => { element.scrollTop = 0; });
        if (process.env.GRAPHER_UI_SCREENSHOTS) {
          await page.screenshot({ path: join(process.env.GRAPHER_UI_SCREENSHOTS, `${language}-settings-${width}.png`) });
        }
        assert.equal(await sections.evaluate(element => element.scrollWidth <= element.clientWidth), true, `settings do not overflow horizontally at ${width}px`);
        const footer = await page.locator(".settings-modal-footer").boundingBox();
        assert.ok(footer.x >= 0 && footer.x + footer.width <= width && footer.y + footer.height <= height, "dialog actions stay on screen");
        await sections.evaluate(element => { element.scrollTop = element.scrollHeight; });
        assert.ok(await sections.evaluate(element => element.scrollTop > 0), "all settings remain reachable");
      }
      await page.locator(".settings-cancel-btn").click();
      await page.locator(".settings-modal").waitFor({ state: "detached" });
      assert.equal(await input.inputValue(), draft, "closing settings preserves the draft");
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server.close();
    }
  });
}
