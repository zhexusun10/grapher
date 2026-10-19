import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

let server, browser, origin;
before(async () => {
  server = await createServer({ cacheDir: "node_modules/.vite-workspace-changes",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null },
    plugins: [{ name: "workspace-changes-fixture", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith("/__changes")) return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, '<html><body style="margin:0"><div id="root"></div><script type="module" src="/scripts/fixtures/workspace-changes.tsx"></script></body></html>'));
      });
    } }],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

/** Collapsing keeps the disclosure mounted and animates its height to zero. */
async function expectCollapsed(page, trigger) {
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => page.evaluate(() => {
    const panel = document.querySelector('[data-testid="workspace-changes-panel"]');
    const animator = panel?.closest(".workspace-details-animator");
    return animator ? Math.round(animator.getBoundingClientRect().height) : 0;
  })).toBe(0);
}

async function fixture(mode, viewport = { width: 1280, height: 850 }) {
  const context = await browser.newContext({ viewport, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  const errors = [];
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const defaults = { list_files: { files: [] }, list_skills: { skills: [] }, get_merger_prompt: { prompt: "Resolve the conflict." } };
    if (!(command in defaults)) errors.push(`Unexpected API: ${command}`);
    await route.fulfill({ json: { result: defaults[command] ?? {} } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  page.setDefaultTimeout(10_000);
  await page.goto(`${origin}/__changes?mode=${mode}`, { waitUntil: "networkidle" });
  await page.locator(".initial-query-scroll.conversation-ready").waitFor();
  return { page, context, errors };
}

for (const mode of ["serial", "planner", "node", "merger"]) {
  test(`${mode}: one disclosure beside session details opens page content without moving the composer`, { timeout: 30_000 }, async () => {
    const { page, context, errors } = await fixture(mode);
    try {
      const trigger = page.getByTestId("workspace-changes-trigger");
      const session = page.locator(".workspace-details-summary > .workspace-details-trigger").first();
      const panel = page.getByTestId("workspace-changes-panel");
      await expect(trigger).toHaveCount(1);
      await trigger.scrollIntoViewIfNeeded();
      const aligned = await trigger.evaluate(button => {
        const session = button.closest(".workspace-details-summary").querySelector(".workspace-details-trigger");
        const a = button.getBoundingClientRect(), b = session.getBoundingClientRect();
        return { dy: Math.abs(a.y + a.height / 2 - b.y - b.height / 2), inConversation: !!button.closest(".initial-query-scroll"), inComposer: !!button.closest(".pane-bottom-chat") };
      });
      assert.ok(aligned.dy <= 1, JSON.stringify(aligned));
      assert.equal(aligned.inConversation, true);
      assert.equal(aligned.inComposer, false);
      const composer = page.locator(".pane-bottom-chat");
      const before = await composer.boundingBox();
      const heights = [];
      const sampling = (async () => {
        for (let index = 0; index < 6; index += 1) {
          heights.push(await page.evaluate(() => Math.round(document.querySelector('[data-testid="workspace-changes-panel"]')?.closest(".workspace-details-animator")?.getBoundingClientRect().height ?? -1)));
          await page.waitForTimeout(35);
        }
      })();
      await trigger.click();
      await sampling;
      assert.ok(heights.some(height => height > 0 && heights.at(-1) > height), `the list must grow progressively: ${heights}`);
      await expect(panel).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      assert.equal(await trigger.getAttribute("aria-controls"), await panel.getAttribute("id"));
      assert.equal(await panel.evaluate(element => !!element.closest(".initial-query-scroll") && !element.closest(".pane-bottom-chat")), true);
      await expect(composer.getByRole("button", { name: /files changed|Hide|Close changes/ })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: /Hide|Close|Collapse/ })).toHaveCount(0);
      await expect(panel.getByTestId("changed-file-item")).toHaveCount(6);
      assert.deepEqual(await composer.boundingBox(), before, "the review panel must not resize or move the input");

      // The body uses the session-details expansion slot and width.
      await session.click();
      await expect(session).toHaveAttribute("aria-expanded", "true");
      const slots = await page.evaluate(() => {
        const panel = document.querySelector(".workspace-changes-panel").getBoundingClientRect();
        const body = document.querySelector(".workspace-details-body").getBoundingClientRect();
        return { left: Math.abs(panel.left - body.left), width: Math.abs(panel.width - body.width), panelBelowSummary: panel.top >= document.querySelector(".workspace-details-summary").getBoundingClientRect().top };
      });
      assert.ok(slots.left <= 1, JSON.stringify(slots));
      assert.ok(slots.width <= 1, JSON.stringify(slots));
      assert.equal(slots.panelBelowSummary, true);
      await expect(panel).toBeVisible();
      await page.evaluate(() => window.changesAudit.empty());
      await expect(panel.getByTestId("changed-file-item")).toHaveCount(0);
      await expect(trigger).toHaveText(/No file changes/);
      await session.click();
      await expect(session).toHaveAttribute("aria-expanded", "false");
      await trigger.click();
      await expectCollapsed(page, trigger);
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(panel).toBeVisible();
      await page.keyboard.press("Space");
      await expectCollapsed(page, trigger);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("full paths and backend counts update live; switching scope keeps one entry", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("node");
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    const panel = page.getByTestId("workspace-changes-panel");
    await trigger.click();
    await expect(panel.getByTestId("changed-file-item")).toHaveCount(6);
    await expect(panel.locator(".changed-file-path")).toHaveText([
      "docs/readme.md → docs/guide.md", "src/components/a-very-long-file-name-for-a-small-conversation-pane.tsx",
      "src/components/Button.tsx", "src/hooks/usePreview.ts", "src/legacy.ts", "src/styles/theme.css",
    ]);
    await expect(panel.getByRole("searchbox")).toHaveCount(0);
    await expect(panel.locator("select")).toHaveCount(0);
    // Rows are read-only: no patch disclosure, copy button or filter chrome.
    await expect(panel.getByRole("button")).toHaveCount(0);
    await expect(trigger.locator(".change-diff-stats")).toHaveCount(0);
    const buttonStats = panel.locator('[data-file-path="src/components/Button.tsx"] .diff-stat-add');
    await expect(buttonStats).toHaveText("+2");
    await page.evaluate(() => window.changesAudit.update());
    await page.evaluate(() => window.changesAudit.settle());
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(buttonStats).toHaveText("+3");
    await expect(panel.getByTestId("changed-file-item")).toHaveCount(6);
    // Moving to another scope must not carry over the open list disclosure.
    await page.evaluate(() => window.changesAudit.select(""));
    await expectCollapsed(page, trigger);
    await trigger.click();
    await expect(panel.getByTestId("changed-file-item")).toHaveCount(6);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("trigger matches the session disclosure; totals stay out of it", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("serial&reference=1");
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    const session = page.locator(".workspace-details-trigger").first();
    await expect(trigger).toContainText("3 files changed");
    await expect(trigger).not.toHaveAttribute("title");
    await expect(trigger.locator(".change-diff-stats")).toHaveCount(0);
    const fonts = await Promise.all([trigger, session].map(element => element.evaluate(node => {
      const style = getComputedStyle(node);
      return { size: style.fontSize, line: style.lineHeight, weight: style.fontWeight, family: style.fontFamily,
        letter: style.letterSpacing, color: style.color, pad: style.padding, height: style.height };
    })));
    assert.deepEqual(fonts[0], fonts[1]);
    await trigger.click();
    const panel = page.getByTestId("workspace-changes-panel");
    await expect(panel.getByTestId("changed-file-item")).toHaveCount(3);
    const zeroFile = panel.locator('[data-file-path="src/hooks/useChat.ts"]');
    await expect(zeroFile.locator(".changed-file-path")).toHaveText("src/hooks/useChat.ts");
    await expect(zeroFile.locator(".diff-stat-add")).toHaveText("+0");
    await expect(zeroFile.locator(".diff-stat-del")).toHaveText("−0");
    assert.equal(await panel.locator("button").evaluateAll(buttons => buttons.some(button => button.hasAttribute("title"))), false);
    const colors = await panel.evaluate(element => {
      const tokens = getComputedStyle(document.documentElement);
      return { add: getComputedStyle(element.querySelector(".diff-stat-add")).color, del: getComputedStyle(element.querySelector(".diff-stat-del")).color,
        success: tokens.getPropertyValue("--status-success").trim(), danger: tokens.getPropertyValue("--status-danger").trim() };
    });
    const normalize = hex => {
      const value = hex.replace("#", "");
      return `rgb(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)})`;
    };
    assert.deepEqual([colors.add, colors.del], [normalize(colors.success), normalize(colors.danger)]);
    await trigger.click();
    await expectCollapsed(page, trigger);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("narrow conversation: review stays within the page and the entry remains reachable", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("serial", { width: 420, height: 640 });
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await trigger.click();
    const panel = page.getByTestId("workspace-changes-panel");
    await page.waitForTimeout(450);
    const bounds = await panel.evaluate(element => {
      const scroll = element.closest(".initial-query-scroll");
      const pane = scroll.getBoundingClientRect(), rect = element.getBoundingClientRect();
      const trigger = scroll.querySelector('[data-testid="workspace-changes-trigger"]').getBoundingClientRect();
      const composer = scroll.parentElement.querySelector(".pane-bottom-chat").getBoundingClientRect();
      return { fits: rect.x >= pane.x && rect.right <= pane.right, overflow: scroll.scrollWidth > scroll.clientWidth,
        entryVisible: trigger.y >= pane.y && trigger.bottom <= composer.top };
    });
    assert.equal(bounds.fits, true);
    assert.equal(bounds.overflow, false);
    assert.equal(bounds.entryVisible, true);
    await trigger.click();
    await expectCollapsed(page, trigger);
    await page.evaluate(() => window.changesAudit.empty());
    await expect(trigger).toHaveText(/No file changes/);
    await trigger.click();
    await expect(panel).toContainText("No files added, modified, or deleted in this session yet");
    await trigger.click();
    await expectCollapsed(page, trigger);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
