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

async function fixture(mode, viewport = { width: 1280, height: 850 }, getFileChanges) {
  const context = await browser.newContext({ viewport, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  const errors = [];
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    if (command === "get_file_changes" && getFileChanges) {
      const body = route.request().postDataJSON();
      let result;
      try { result = await getFileChanges(body); }
      catch {
        await route.fulfill({ status: 503, json: { error: "temporary read failure" } });
        return;
      }
      await route.fulfill({ json: { result: { ...result, executionIds: body.executionIds ?? null } } });
      return;
    }
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

function changesResult(paths, totalFiles = paths.length) {
  return { runId: "changes-run", executionId: null, summary: {
    files: paths.map(path => ({ path, status: "modified", additions: 1, deletions: 0, source: "git" })),
    totalFiles, addedCount: 0, modifiedCount: totalFiles, deletedCount: 0, renamedCount: 0,
    totalAdditions: totalFiles, totalDeletions: 0, isRunning: false,
  } };
}

test("metadata changes refresh during a running execution and after a settled snapshot", { timeout: 30_000 }, async () => {
  let current = changesResult(["src/first.ts"]);
  const requests = [];
  const { page, context, errors } = await fixture("node&metadata=1", undefined, body => {
    requests.push(body);
    return current;
  });
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await expect(trigger).toContainText("1 files changed");
    await trigger.click();
    current = changesResult(["src/first.ts", "src/live.ts"]);
    // No new execution, phase change or snapshot: the bounded watchdog must
    // still discover fresh backend changes while this same writer is alive.
    await expect(trigger).toContainText("2 files changed");
    await expect(page.locator(".changed-file-path")).toHaveText(["src/first.ts", "src/live.ts"]);
    assert.ok(requests.every(body => JSON.stringify(body.executionIds) === '["execution"]'));
    const beforeBurst = requests.length;
    await page.evaluate(() => { for (let n = 0; n < 20; n++) window.changesAudit.update(); });
    await page.waitForTimeout(350);
    assert.ok(requests.length <= beforeBurst + 1, "snapshot bursts must not cause unbounded change reads");
    current = changesResult(["src/final.ts"]);
    await page.evaluate(() => window.changesAudit.settle());
    await expect(page.locator(".changed-file-path")).toHaveText(["src/final.ts"]);
    current = changesResult(["src/after-settle.ts"]);
    await page.evaluate(() => window.changesAudit.update());
    await expect(page.locator(".changed-file-path")).toHaveText(["src/after-settle.ts"]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const [mode, phase] of [["merger", "completed"], ["node", "followup"]]) {
  test(`metadata main view refreshes during ${mode} work in phase ${phase}`, { timeout: 30_000 }, async () => {
    let current = changesResult(["src/first.ts"]);
    const requests = [];
    const { page, context, errors } = await fixture(`${mode}&metadata=1&phase=${phase}`, undefined, body => {
      requests.push(body);
      return current;
    });
    try {
      await page.evaluate(() => window.changesAudit.select(""));
      const trigger = page.getByTestId("workspace-changes-trigger");
      await expect.poll(() => requests.filter(body => body.executionIds === undefined).length).toBeGreaterThan(0);
      await expect(trigger).toContainText("1 files changed");
      current = changesResult(["src/first.ts", "src/live.ts"]);
      // No snapshot or phase update: actual execution state must keep polling
      // alive even when this Run does not have an ordinary running phase.
      await expect(trigger).toContainText("2 files changed");
      current = changesResult(["src/final.ts"]);
      await page.evaluate(() => window.changesAudit.settle());
      await expect(trigger).toContainText("1 files changed");
      const settledReads = requests.length;
      await page.waitForTimeout(2300);
      assert.equal(requests.length, settledReads, "terminal work must suspend idle timer reads again");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("metadata scoped aggregation preserves capped totals without double-counting attempts", { timeout: 30_000 }, async () => {
  const requests = [];
  const result = changesResult(Array.from({ length: 60 }, (_, i) => `src/file-${i}.ts`), 120);
  const { page, context, errors } = await fixture("node&metadata=1&attempts=2", undefined, body => {
    requests.push(body);
    return result;
  });
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await expect(trigger).toContainText("120 files changed");
    await trigger.click();
    await expect(page.getByTestId("changed-file-item")).toHaveCount(50);
    await expect(page.getByTestId("workspace-changes-truncated")).toContainText("70 more file changes omitted");
    assert.ok(requests.length > 0);
    assert.ok(requests.every(body => JSON.stringify(body.executionIds) === '["execution-prior","execution"]'));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("inline repeated attempts count shared files once", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("node&attempts=2");
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await expect(trigger).toContainText("6 files changed");
    await trigger.click();
    await expect(page.getByTestId("changed-file-item")).toHaveCount(6);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("metadata scope switches reject late responses from the previous conversation", { timeout: 30_000 }, async () => {
  let hold = false, pending = false, release;
  const delayed = new Promise(resolve => { release = resolve; });
  const { page, context, errors } = await fixture("node&metadata=1", undefined, async body => {
    if (!body.executionIds) return changesResult(["src/main.ts"]);
    if (hold) {
      pending = true;
      await delayed;
      return changesResult(["src/stale.ts"]);
    }
    return changesResult(["src/node.ts"]);
  });
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await expect(trigger).toContainText("1 files changed");
    await trigger.click();
    await expect(page.locator(".changed-file-path")).toHaveText(["src/node.ts"]);
    hold = true;
    await page.evaluate(() => window.changesAudit.update());
    await expect.poll(() => pending).toBe(true);
    await page.evaluate(() => window.changesAudit.select(""));
    await expect(trigger).toContainText("1 files changed");
    await trigger.click();
    await expect(page.locator(".changed-file-path")).toHaveText(["src/main.ts"]);
    release();
    await page.waitForTimeout(250);
    await expect(page.locator(".changed-file-path")).toHaveText(["src/main.ts"]);
    assert.deepEqual(errors, []);
  } finally { release(); await context.close(); }
});

test("metadata waiting scope stays empty and failed reads retain the last projection", { timeout: 30_000 }, async () => {
  let failing = false;
  let attempts = 0;
  const { page, context, errors } = await fixture("waiting&metadata=1", undefined, body => {
    attempts++;
    if (failing) throw Error("unavailable");
    return changesResult(body.executionIds ? [] : ["src/run.ts"]);
  });
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await expect(trigger).toContainText("No file changes");
    await page.evaluate(() => window.changesAudit.select(""));
    await expect(trigger).toContainText("1 files changed");
    failing = true;
    const beforeFailure = attempts;
    await page.evaluate(() => window.changesAudit.update());
    await expect.poll(() => attempts).toBeGreaterThan(beforeFailure);
    await expect(trigger).toContainText("1 files changed");
    failing = false;
    const beforeRetry = attempts;
    await expect.poll(() => attempts).toBeGreaterThan(beforeRetry);
    await expect(trigger).toContainText("1 files changed");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

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
      "src/hooks/usePreview.ts", "src/legacy.ts",
      "src/styles/theme.css", "src/components/Button.tsx",
      "src/components/a-very-long-file-name-for-a-small-conversation-pane.tsx", "docs/readme.md → docs/guide.md",
    ]);
    await expect(panel.getByRole("searchbox")).toHaveCount(0);
    await expect(panel.locator("select")).toHaveCount(0);
    // Rows are read-only: no patch disclosure, copy button or filter chrome.
    await expect(panel.getByRole("button")).toHaveCount(0);
    await expect(trigger.locator(".change-diff-stats")).toHaveCount(0);
    const buttonStats = panel.locator('[data-file-path="src/components/Button.tsx"] .diff-stat-add');
    await expect(buttonStats).toHaveText("+2");
    // Deleted files carry no line counts: the row omits the stats block entirely.
    await expect(panel.locator('[data-file-path="src/legacy.ts"] .change-diff-stats')).toHaveCount(0);
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

test("waiting node scopes to its own (empty) executions, not the run aggregate", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("waiting");
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    const panel = page.getByTestId("workspace-changes-panel");
    // The run aggregate carries every node's six files, but the selected node
    // has not executed yet, so its conversation must not claim those changes.
    await expect(trigger).toHaveText(/No file changes/);
    await trigger.click();
    await expect(panel.getByTestId("changed-file-item")).toHaveCount(0);
    await expect(panel).toContainText("No files added, modified, or deleted in this session yet");
    // The main view still reads the run-level projection.
    await page.evaluate(() => window.changesAudit.select(""));
    await expect(trigger).toContainText("6 files changed");
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
        addToken: tokens.getPropertyValue("--status-success-strong").trim(), delToken: tokens.getPropertyValue("--status-danger-strong").trim() };
    });
    const normalize = hex => {
      const value = hex.replace("#", "");
      return `rgb(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)})`;
    };
    assert.deepEqual([colors.add, colors.del], [normalize(colors.addToken), normalize(colors.delToken)]);
    await trigger.click();
    await expectCollapsed(page, trigger);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("added/deleted files lead and each group ranks by changed line count", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("serial&mix=1");
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    const panel = page.getByTestId("workspace-changes-panel");
    await trigger.click();
    await expect(panel.locator(".changed-file-path")).toHaveText([
      "src/added-large.ts", "src/deleted-large.ts", "src/added-small.ts", "src/deleted-small.ts",
      "src/mod-large.ts", "src/mod-small.ts",
    ]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("serial node selection does not capture or restore the conversation scroll position", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("serial&long=1");
  try {
    const scroller = page.locator(".initial-query-scroll");
    await scroller.evaluate(element => { element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.4; });
    await page.waitForTimeout(300);
    const before = await scroller.evaluate(element => element.scrollTop);
    assert.ok(await scroller.evaluate(element => element.scrollHeight - element.clientHeight) > 500,
      "the conversation must be scrollable");
    // Selecting a graph node does not change the visible Serial conversation.
    await page.evaluate(() => window.changesAudit.select("worker"));
    await page.waitForTimeout(400);
    assert.equal(await scroller.evaluate(element => element.scrollTop), before,
      "node selection must not capture or move the serial scroll position");
    await page.evaluate(() => window.changesAudit.select(""));
    await page.waitForTimeout(400);
    assert.equal(await scroller.evaluate(element => element.scrollTop), before,
      "deselecting must not restore an intermediate serial offset");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("large change sets render only the first 50 rows and mark the remainder", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("serial&many=1");
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    const panel = page.getByTestId("workspace-changes-panel");
    await expect(trigger).toContainText("1205 files changed");
    // The cap applies while collapsed too: the disclosure keeps children mounted.
    await expect(panel.getByTestId("changed-file-item")).toHaveCount(50);
    const truncated = panel.getByTestId("workspace-changes-truncated");
    await expect(truncated).toHaveCount(1);
    await expect(truncated).toContainText("1155 more file changes omitted");
    await trigger.click();
    await expect(panel.getByTestId("changed-file-item")).toHaveCount(50);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a long change list opens at its first row without moving the entry out of view", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("node&many=1");
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await page.waitForTimeout(450);
    const bounds = await page.evaluate(() => {
      const scroll = document.querySelector(".initial-query-scroll");
      const composer = scroll.parentElement.querySelector(".pane-bottom-chat");
      const viewportTop = scroll.getBoundingClientRect().top;
      const visibleBottom = composer.getBoundingClientRect().top;
      const trigger = document.querySelector('[data-testid="workspace-changes-trigger"]').getBoundingClientRect();
      const first = document.querySelector('[data-testid="changed-file-item"]').getBoundingClientRect();
      const inside = rect => rect.top >= viewportTop && rect.bottom <= visibleBottom;
      return { viewportTop, visibleBottom, triggerFits: inside(trigger), firstRowFits: inside(first) };
    });
    // The oversized list cannot be revealed in full; scrolling to its bottom
    // would hide the trigger and drop the reader into the middle of the list.
    assert.equal(bounds.triggerFits, true, JSON.stringify(bounds));
    assert.equal(bounds.firstRowFits, true, JSON.stringify(bounds));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a short change list reveals in place without jumping through a long node conversation", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("node&long=1");
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await page.evaluate(() => {
      const scroll = document.querySelector(".initial-query-scroll");
      scroll.scrollTop = scroll.scrollHeight;
    });
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => {
      const scroll = document.querySelector(".initial-query-scroll");
      const trigger = document.querySelector('[data-testid="workspace-changes-trigger"]');
      const s = scroll.getBoundingClientRect(), t = trigger.getBoundingClientRect();
      return { scrollTop: scroll.scrollTop, max: scroll.scrollHeight - scroll.clientHeight,
        clientHeight: scroll.clientHeight, triggerTop: t.top - s.top, triggerBottom: t.bottom - s.top };
    });
    assert.ok(before.max > 1000, "the conversation must be scrollable");
    assert.ok(before.triggerTop >= 0 && before.triggerBottom <= before.clientHeight, JSON.stringify(before));
    const box = await trigger.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => {
      const scroll = document.querySelector(".initial-query-scroll");
      const trigger = document.querySelector('[data-testid="workspace-changes-trigger"]').getBoundingClientRect();
      const first = document.querySelector('[data-testid="changed-file-item"]').getBoundingClientRect();
      const s = scroll.getBoundingClientRect();
      return { scrollTop: scroll.scrollTop, triggerTop: trigger.top - s.top, triggerBottom: trigger.bottom - s.top,
        firstTop: first.top - s.top,
        triggerFits: trigger.top >= s.top && trigger.bottom <= s.top + scroll.clientHeight };
    });
    const reveal = after.scrollTop - before.scrollTop;
    // Keep the animated reveal, but bound it to this disclosure: a short list
    // may push the view up by its own height, never toward the conversation middle.
    assert.ok(reveal > 0, JSON.stringify({ before, after }));
    assert.ok(reveal <= before.clientHeight / 2, JSON.stringify({ before, after }));
    assert.equal(after.triggerFits, true, JSON.stringify(after));
    assert.ok(after.firstTop >= after.triggerBottom - 1, JSON.stringify(after));
    assert.ok(after.firstTop >= 0, JSON.stringify(after));
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
