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
after(async () => { await browser?.close(); server?.httpServer?.closeAllConnections?.(); await server?.close(); });

async function expectClosed(page, trigger) {
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("workspace-changes-panel")).toHaveCount(0);
}

async function filePaths(page) {
  return page.getByTestId("changed-file-item").evaluateAll(items => items.map(item => item.getAttribute("data-file-path")));
}

function defaultDiffFor(body) {
  return {
    runId: body.runId,
    path: body.path,
    oldPath: body.oldPath ?? null,
    binary: body.path.endsWith(".bin") || body.path.endsWith(".png"),
    truncated: false,
    hiddenLines: 0,
    lines: body.path.endsWith(".bin") ? [] : [
      { kind: "hunk", text: "@@ -1,3 +1,4 @@ export function sample() {" },
      { kind: "context", text: "  const keep = true;" },
      { kind: "removed", text: "  return oldValue;" },
      { kind: "added", text: "  const next = compute();" },
      { kind: "added", text: "  return next;" },
    ],
  };
}

async function fixture(mode, viewport = { width: 1280, height: 850 }, getFileChanges, getExecutionOutput, waitUntil = getExecutionOutput ? "domcontentloaded" : "networkidle", getFileDiff) {
  const context = await browser.newContext({ viewport, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  const errors = [];
  let page;
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    if (command === "get_execution_output" && getExecutionOutput) {
      const result = await getExecutionOutput(route.request().postDataJSON());
      await route.fulfill({ json: { result } }).catch(() => {});
      return;
    }
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
    if (command === "get_file_diff") {
      const body = route.request().postDataJSON();
      const result = getFileDiff ? await getFileDiff(body) : defaultDiffFor(body);
      await route.fulfill({ json: { result } });
      return;
    }
    if (command === "get_execution_output") {
      const body = route.request().postDataJSON();
      const current = await page.evaluate(() => ({ outputText: window.changesAudit.outputText, running: window.changesAudit.running }));
      const bytes = Buffer.from(current.outputText);
      const startOffset = body.tail ? 0 : Math.min(body.offset ?? 0, bytes.length);
      await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        content: bytes.subarray(startOffset).toString(), startOffset, nextOffset: bytes.length,
        totalBytes: bytes.length, complete: true, status: current.running ? "running" : "completed" } } });
      return;
    }
    if (command === "get_file_changes") {
      const body = route.request().postDataJSON();
      const summary = await page.evaluate(() => window.changesAudit.summary);
      await route.fulfill({ json: { result: { runId: body.runId, executionId: null,
        executionIds: body.executionIds ?? null, summary } } });
      return;
    }
    const defaults = { list_files: { files: [] }, list_skills: { skills: [] }, get_merger_prompt: { prompt: "Resolve the conflict." } };
    if (!(command in defaults)) errors.push(`Unexpected API: ${command}`);
    await route.fulfill({ json: { result: defaults[command] ?? {} } });
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  page.setDefaultTimeout(10_000);
  await page.goto(`${origin}/__changes?mode=${mode}`, { waitUntil });
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

test("conversation defaults to no changes and updates when the first read finds files", { timeout: 30_000 }, async () => {
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const { page, context, errors } = await fixture("node&metadata=1&settled=1", undefined, async () => {
    await response;
    return changesResult(["src/node.ts"]);
  }, undefined, "domcontentloaded");
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await expect(trigger).toHaveText("No file changes");
    await expect(trigger).toBeDisabled();
    release();
    await expect(trigger).toContainText("1 files changed");
    await expect(trigger).toBeEnabled();
    assert.deepEqual(errors, []);
  } finally { release(); await context.close(); }
});

test("running empty node reveals immediately and shows the result after a slow read", { timeout: 30_000 }, async () => {
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const { page, context, errors } = await fixture("node&metadata=1", undefined, async () => {
    await response;
    return changesResult([]);
  }, undefined, "domcontentloaded");
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await expect(page.locator(".initial-query-scroll")).toHaveClass(/conversation-ready/);
    await expect(trigger).toHaveText("No file changes");
    await expect(trigger).toBeDisabled();
    const pendingStyle = await trigger.evaluate(element => {
      const style = getComputedStyle(element);
      return { opacity: style.opacity, color: style.color };
    });
    assert.equal(pendingStyle.opacity, "1");
    release();
    await expect(trigger).toBeEnabled();
    await expect(trigger).toHaveText("No file changes");
    assert.deepEqual(await trigger.evaluate(element => {
      const style = getComputedStyle(element);
      return { opacity: style.opacity, color: style.color };
    }), pendingStyle);
    await trigger.click();
    await expect(page.getByTestId("workspace-changes-panel")).toContainText("No files added, modified, or deleted in this session yet");
    assert.deepEqual(errors, []);
  } finally { release(); await context.close(); }
});

test("failed initial metadata read releases the conversation and retries", { timeout: 30_000 }, async () => {
  let calls = 0;
  const { page, context, errors } = await fixture("node&metadata=1", undefined, () => {
    if (++calls === 1) throw Error("unavailable");
    return changesResult([]);
  }, undefined, "domcontentloaded");
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await expect(trigger).toHaveText("No file changes");
    await expect(trigger).toBeDisabled();
    await expect(trigger).toBeEnabled();
    await expect(trigger).toHaveText("No file changes");
    assert.ok(calls >= 2);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

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
    await expect.poll(() => filePaths(page)).toEqual(["src/first.ts", "src/live.ts"]);
    assert.ok(requests.every(body => JSON.stringify(body.executionIds) === '["execution"]'));
    const beforeBurst = requests.length;
    await page.evaluate(() => { for (let n = 0; n < 20; n++) window.changesAudit.update(); });
    await page.waitForTimeout(350);
    assert.ok(requests.length <= beforeBurst + 1, "snapshot bursts must not cause unbounded change reads");
    current = changesResult(["src/final.ts"]);
    await page.evaluate(() => window.changesAudit.settle());
    await expect.poll(() => filePaths(page)).toEqual(["src/final.ts"]);
    current = changesResult(["src/after-settle.ts"]);
    await page.evaluate(() => window.changesAudit.update());
    await expect.poll(() => filePaths(page)).toEqual(["src/after-settle.ts"]);
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
    await expect(page.getByTestId("changed-file-item")).toHaveCount(60);
    await expect(page.getByTestId("workspace-changes-truncated")).toContainText("60 more file changes omitted");
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
    await expect.poll(() => filePaths(page)).toEqual(["src/node.ts"]);
    hold = true;
    await page.evaluate(() => window.changesAudit.update());
    await expect.poll(() => pending).toBe(true);
    await page.evaluate(() => window.changesAudit.select(""));
    await expect(trigger).toContainText("1 files changed");
    await expect.poll(() => filePaths(page)).toEqual(["src/main.ts"]);
    release();
    await page.waitForTimeout(250);
    await expect.poll(() => filePaths(page)).toEqual(["src/main.ts"]);
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
    assert.equal(attempts, 0, "an empty execution scope must not need a backend read");
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
  test(`${mode}: bottom trigger opens pi-gpui-style Changes in the right pane without inline downward list`, { timeout: 30_000 }, async () => {
    const { page, context, errors } = await fixture(mode);
    try {
      const trigger = page.getByTestId("workspace-changes-trigger");
      const session = page.locator(".workspace-details-summary > .workspace-details-trigger").first();
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
      // Zero DOM mounted for changes while closed.
      await expect(page.getByTestId("workspace-changes-panel")).toHaveCount(0);

      await trigger.click();
      const pane = page.getByTestId("workspace-changes-pane");
      const panel = page.getByTestId("workspace-changes-panel");
      await expect(pane).toBeVisible();
      await expect(panel).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      assert.equal(await trigger.getAttribute("aria-controls"), await panel.getAttribute("id"));
      // Panel lives in the right-side .graph-pane, never inline inside .initial-query-scroll.
      const placement = await panel.evaluate(element => ({
        inGraphPane: !!element.closest(".graph-pane"),
        inConversation: !!element.closest(".initial-query-scroll"),
        inComposer: !!element.closest(".pane-bottom-chat"),
        rightOfConversation: element.getBoundingClientRect().left >= document.querySelector(".conversation-pane").getBoundingClientRect().right - 2,
      }));
      assert.deepEqual(placement, { inGraphPane: true, inConversation: false, inComposer: false, rightOfConversation: true });
      await expect(panel.getByTestId("changed-file-item")).toHaveCount(6);
      await expect(pane.getByTestId("workspace-changes-summary")).toContainText("6 files");

      // Session details can open independently without closing the right-side Changes pane.
      await session.click();
      await expect(session).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(".workspace-details-body")).toBeVisible();
      await expect(panel).toBeVisible();

      // Empty state still renders cleanly in the right pane.
      await page.evaluate(() => window.changesAudit.empty());
      await expect(panel.getByTestId("changed-file-item")).toHaveCount(0);
      await expect(panel).toContainText("No files added, modified, or deleted in this session yet");
      await expect(trigger).toHaveText("No file changes");

      // Toggle closed via bottom trigger, and toggle via keyboard Enter/Space.
      await trigger.click();
      await expectClosed(page, trigger);
      if (mode !== "serial") {
        await expect(page.locator(".graph-canvas")).toBeVisible();
      } else {
        await expect(page.locator(".graph-pane")).toHaveCount(0);
      }
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(panel).toBeVisible();
      await page.keyboard.press("Space");
      await expectClosed(page, trigger);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("graph mode right pane switches cleanly between Execution graph and File changes tabs", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("planner");
  try {
    await expect(page.locator(".graph-canvas")).toBeVisible();
    const trigger = page.getByTestId("workspace-changes-trigger");
    await trigger.click();
    await expect(page.getByTestId("workspace-changes-pane")).toBeVisible();
    await expect(page.locator(".graph-canvas")).not.toBeVisible();
    await expect(page.getByTestId("right-pane-tab-changes")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("right-pane-tab-graph").click();
    await expect(page.getByTestId("workspace-changes-pane")).toHaveCount(0);
    await expect(page.locator(".graph-canvas")).toBeVisible();
    await trigger.click();
    await expect(page.getByTestId("workspace-changes-pane")).toBeVisible();
    await page.getByTestId("workspace-changes-close").click();
    await expect(page.getByTestId("workspace-changes-pane")).toHaveCount(0);
    await expect(page.locator(".graph-canvas")).toBeVisible();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const mode of ["serial", "planner"]) {
  test(`${mode}: closing File changes animates smoothly when motion is enabled`, { timeout: 30_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, locale: "en-US", reducedMotion: "no-preference" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    const errors = [];
    let page;
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      if (command === "get_execution_output") {
        const body = route.request().postDataJSON();
        const current = await page.evaluate(() => ({ outputText: window.changesAudit.outputText, running: window.changesAudit.running }));
        const bytes = Buffer.from(current.outputText);
        const startOffset = body.tail ? 0 : Math.min(body.offset ?? 0, bytes.length);
        await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
          content: bytes.subarray(startOffset).toString(), startOffset, nextOffset: bytes.length,
          totalBytes: bytes.length, complete: true, status: current.running ? "running" : "completed" } } });
        return;
      }
      if (command === "get_file_changes") {
        const body = route.request().postDataJSON();
        const summary = await page.evaluate(() => window.changesAudit.summary);
        await route.fulfill({ json: { result: { runId: body.runId, executionId: null,
          executionIds: body.executionIds ?? null, summary } } });
        return;
      }
      if (command === "get_file_diff") {
        await route.fulfill({ json: { result: defaultDiffFor(route.request().postDataJSON()) } });
        return;
      }
      const defaults = { list_files: { files: [] }, list_skills: { skills: [] }, get_merger_prompt: { prompt: "Resolve the conflict." } };
      await route.fulfill({ json: { result: defaults[command] ?? {} } });
    });
    page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    try {
      await page.goto(`${origin}/__changes?mode=${mode}`, { waitUntil: "networkidle" });
      await page.locator(".initial-query-scroll.conversation-ready").waitFor();
      const trigger = page.getByTestId("workspace-changes-trigger");
      await trigger.click();
      await expect(page.getByTestId("workspace-changes-pane")).toBeVisible();
      await page.waitForTimeout(500);

      const samples = [];
      const sampling = (async () => {
        for (let i = 0; i < 12; i++) {
          samples.push(await page.evaluate((m) => {
            if (m === "serial") {
              const conv = document.querySelector(".conversation-pane")?.getBoundingClientRect().width ?? 0;
              const wb = document.querySelector(".workbench")?.getBoundingClientRect().width ?? 1;
              const pane = document.querySelector(".graph-pane");
              const opacity = pane ? Number(getComputedStyle(pane).opacity) : 0;
              return { ratio: conv / wb, opacity };
            }
            const overlay = document.querySelector(".changes-pane-overlay");
            return {
              mounted: !!overlay,
              opacity: overlay ? Number(getComputedStyle(overlay).opacity) : 0,
            };
          }, mode));
          await page.waitForTimeout(30);
        }
      })();
      await page.getByTestId("workspace-changes-close").click();
      await sampling;
      await expect(page.getByTestId("workspace-changes-pane")).toHaveCount(0);

      if (mode === "serial") {
        assert.ok(
          samples.some(s => s.ratio > 0.62 && s.ratio < 0.98) || samples.some(s => s.opacity > 0.05 && s.opacity < 0.95),
          `serial close must animate progressively: ${JSON.stringify(samples)}`,
        );
      } else {
        assert.ok(
          samples.some(s => s.mounted && s.opacity > 0.05 && s.opacity < 0.95),
          `graph overlay close must fade/slide smoothly: ${JSON.stringify(samples)}`,
        );
        await expect(page.locator(".graph-canvas")).toBeVisible();
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("expanding a file row lazy-loads its unified diff, caches re-expansions, and refreshes on demand", { timeout: 30_000 }, async () => {
  const diffRequests = [];
  let changeRequests = 0;
  const { page, context, errors } = await fixture(
    "node&metadata=1",
    undefined,
    () => {
      changeRequests += 1;
      return {
        runId: "changes-run",
        executionId: null,
        summary: {
          files: [
            { path: "src/components/Button.tsx", status: "modified", additions: 2, deletions: 1, nodes: ["worker"] },
            { path: "src/assets/logo.bin", status: "added", additions: 0, deletions: 0, nodes: ["worker"] },
          ],
          totalFiles: 2, addedCount: 1, modifiedCount: 1, deletedCount: 0, renamedCount: 0,
          totalAdditions: 2, totalDeletions: 1, isRunning: false,
        },
      };
    },
    undefined,
    "networkidle",
    (body) => {
      diffRequests.push(body);
      return defaultDiffFor(body);
    },
  );
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await trigger.click();
    const panel = page.getByTestId("workspace-changes-panel");
    await expect(panel.getByTestId("changed-file-item")).toHaveCount(2);
    // Zero diff fetches before user expands a row.
    assert.equal(diffRequests.length, 0);

    const buttonRow = panel.locator('[data-file-path="src/components/Button.tsx"] .changed-file-row');
    await expect(buttonRow.locator(".changed-file-status")).toHaveText("M");
    await expect(buttonRow.locator(".changed-file-name")).toHaveText("Button.tsx");
    await expect(buttonRow.locator(".changed-file-dir")).toHaveText("src/components/");
    await expect(buttonRow.locator(".diff-stat-add")).toHaveText("+2");
    await expect(buttonRow.locator(".diff-stat-del")).toHaveText("−1");

    await buttonRow.click();
    const diffBox = panel.locator('[data-file-path="src/components/Button.tsx"]').getByTestId("changed-file-diff");
    await expect(diffBox).toBeVisible();
    await expect(diffBox.locator(".diff-line-hunk")).toHaveCount(1);
    await expect(diffBox.locator(".diff-line-added")).toHaveCount(2);
    await expect(diffBox.locator(".diff-line-removed")).toHaveCount(1);
    assert.equal(diffRequests.length, 1);
    assert.deepEqual(diffRequests[0].executionIds, ["execution"]);

    // Collapse & re-expand hits client LRU cache with zero extra network call.
    await buttonRow.click();
    await expect(diffBox).toHaveCount(0);
    await buttonRow.click();
    await expect(diffBox).toBeVisible();
    assert.equal(diffRequests.length, 1);

    // Binary file renders binary indicator cleanly.
    await panel.locator('[data-file-path="src/assets/logo.bin"] .changed-file-row').click();
    await expect(panel.locator('[data-file-path="src/assets/logo.bin"]')).toContainText("Binary file");

    // Clicking Refresh forces both summary & expanded diff reloads.
    const beforeChangeReads = changeRequests;
    const beforeDiffReads = diffRequests.length;
    await page.getByTestId("workspace-changes-refresh").click();
    await expect.poll(() => changeRequests).toBeGreaterThan(beforeChangeReads);
    await expect.poll(() => diffRequests.length).toBeGreaterThan(beforeDiffReads);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("large file diffs render progressively in chunks to keep DOM cost low", { timeout: 30_000 }, async () => {
  const largeLines = Array.from({ length: 420 }, (_, i) => ({
    kind: "added",
    text: `export const line_${i} = ${i};`,
  }));
  const { page, context, errors } = await fixture("serial", undefined, undefined, undefined, "networkidle", (body) => ({
    runId: body.runId,
    path: body.path,
    oldPath: null,
    binary: false,
    truncated: false,
    hiddenLines: 0,
    lines: largeLines,
  }));
  try {
    await page.getByTestId("workspace-changes-trigger").click();
    const item = page.locator('[data-file-path="src/components/Button.tsx"]');
    await item.locator(".changed-file-row").click();
    const diff = item.getByTestId("changed-file-diff");
    await expect(diff.locator(".diff-line")).toHaveCount(300);
    const moreBtn = diff.locator(".changed-file-diff-more-btn");
    await expect(moreBtn).toBeVisible();
    await moreBtn.click();
    await expect(diff.locator(".diff-line")).toHaveCount(420);
    await expect(moreBtn).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("clicking the open action opens a file in scope; deleted files omit the open action", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("node");
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await trigger.click();
    const panel = page.getByTestId("workspace-changes-panel");
    await panel.locator('[data-file-path="src/components/Button.tsx"] .changed-file-open-btn').click();
    await expect.poll(() => page.evaluate(() => window.changesAudit.openRequests.length)).toBe(1);
    const scoped = await page.evaluate(() => window.changesAudit.openRequests[0]);
    assert.deepEqual(scoped, {
      runId: "changes-run", path: "src/components/Button.tsx",
      executionIds: ["execution"], nodes: ["worker"],
    });

    // A deleted path has no surviving file to hand to the opener.
    await expect(panel.locator('[data-file-path="src/legacy.ts"] .changed-file-open-btn')).toHaveCount(0);

    // Switching to main view updates scope to run-level.
    await page.evaluate(() => window.changesAudit.select(""));
    await panel.locator('[data-file-path="src/components/Button.tsx"] .changed-file-open-btn').click();
    await expect.poll(() => page.evaluate(() => window.changesAudit.openRequests.length)).toBe(2);
    const aggregate = await page.evaluate(() => window.changesAudit.openRequests[1]);
    assert.equal(aggregate.runId, "changes-run");
    assert.equal(aggregate.path, "src/components/Button.tsx");
    assert.equal("executionIds" in aggregate, false);
    assert.deepEqual(aggregate.nodes, ["worker"]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("waiting node scopes to its own (empty) executions, not the run aggregate", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("waiting");
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await expect(trigger).toHaveText(/No file changes/);
    await trigger.click();
    const panel = page.getByTestId("workspace-changes-panel");
    await expect(panel.getByTestId("changed-file-item")).toHaveCount(0);
    await expect(panel).toContainText("No files added, modified, or deleted in this session yet");
    // The main view still reads the run-level projection.
    await page.evaluate(() => window.changesAudit.select(""));
    await expect(trigger).toContainText("6 files changed");
    await expect(panel.getByTestId("changed-file-item")).toHaveCount(6);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("trigger matches the session disclosure; files list alphabetically with pi-gpui stats", { timeout: 30_000 }, async () => {
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
    await expect.poll(() => filePaths(page)).toEqual([
      "src/components/Chat.tsx",
      "src/hooks/useChat.ts",
      "src/styles/chat.css",
    ]);
    // Zero-change row omits +0 / -0 stats just like pi-gpui.
    const zeroFile = panel.locator('[data-file-path="src/hooks/useChat.ts"]');
    await expect(zeroFile.locator(".change-diff-stats")).toHaveCount(0);
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
    await expectClosed(page, trigger);
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

test("large change sets mount zero rows while closed and render at most 60 rows when opened", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("serial&many=1");
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await expect(trigger).toContainText("1205 files changed");
    await expect(page.getByTestId("changed-file-item")).toHaveCount(0);
    await trigger.click();
    const panel = page.getByTestId("workspace-changes-panel");
    await expect(panel.getByTestId("changed-file-item")).toHaveCount(60);
    const truncated = panel.getByTestId("workspace-changes-truncated");
    await expect(truncated).toHaveCount(1);
    await expect(truncated).toContainText("1145 more file changes omitted");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("narrow conversation: opening file changes switches to the right pane and returns cleanly", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("serial", { width: 420, height: 640 });
  try {
    const trigger = page.getByTestId("workspace-changes-trigger");
    await trigger.click();
    const panel = page.getByTestId("workspace-changes-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("changed-file-item")).toHaveCount(6);
    await page.getByTestId("workspace-changes-close").click();
    await expectClosed(page, trigger);
    await expect(trigger).toBeVisible();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const mode of ["serial", "planner", "node", "merger"]) {
  test(`${mode}: collapse cards toggle sits beside file changes and swaps cards for Codex-style summaries`, { timeout: 30_000 }, async () => {
    const { page, context, errors } = await fixture(`${mode}&cards=1&settled=1`);
    try {
      const collapseTrigger = page.getByTestId("collapse-cards-trigger");
      await expect(collapseTrigger).toHaveCount(1);
      await expect(collapseTrigger).toHaveAttribute("aria-pressed", "false");
      await expect(collapseTrigger).toContainText("Collapse cards");

      // Aligned on the same footer row, directly to the right of the file-changes trigger.
      const layout = await collapseTrigger.evaluate(button => {
        const changes = button.closest(".workspace-details-summary")?.querySelector('[data-testid="workspace-changes-trigger"]');
        const a = button.getBoundingClientRect(), b = changes.getBoundingClientRect();
        return { toRight: a.left >= b.right, dy: Math.abs(a.y + a.height / 2 - b.y - b.height / 2) };
      });
      assert.equal(layout.toRight, true, JSON.stringify(layout));
      assert.ok(layout.dy <= 1, JSON.stringify(layout));

      // Before collapsing: thinking/tool cards and both assistant text milestones are visible.
      await expect(page.getByTestId("tool-call-card")).toHaveCount(4);
      await expect(page.getByTestId("activity-summary-row")).toHaveCount(0);
      await expect(page.locator(".chat-bubble-assistant")).toHaveCount(2);

      // Click "Collapse cards": cards collapse into inline summaries interleaved with model text.
      await collapseTrigger.click();
      await expect(collapseTrigger).toHaveAttribute("aria-pressed", "true");
      await expect(collapseTrigger).toContainText("Expand cards");
      await expect(page.getByTestId("tool-call-card")).toHaveCount(0);
      await expect(page.locator(".thinking-card")).toHaveCount(0);
      await expect(page.locator(".chat-bubble-assistant")).toHaveCount(2);

      const summaries = page.getByTestId("activity-summary-trigger");
      await expect(summaries).toHaveCount(2);
      await expect(summaries.nth(0)).toContainText("Ran cat docs/index.md && cat package.json");
      await expect(summaries.nth(1)).toContainText("Viewed 1 file · Ran 2 commands");

      // Clicking one summary expands only that group's cards in place, and
      // expanding/collapsing a nested card keeps the parent summary open.
      await summaries.nth(1).click();
      await expect(summaries.nth(1)).toHaveAttribute("aria-expanded", "true");
      const nestedToolCards = page.getByTestId("activity-summary-cards").getByTestId("tool-call-card");
      await expect(nestedToolCards).toHaveCount(3);
      const nestedHeader = nestedToolCards.first().locator(".tool-call-header");
      await nestedHeader.click();
      await expect(nestedHeader).toHaveAttribute("aria-expanded", "true");
      await nestedHeader.click();
      await expect(nestedHeader).toHaveAttribute("aria-expanded", "false");
      await expect(summaries.nth(1)).toHaveAttribute("aria-expanded", "true");
      await summaries.nth(1).click();
      await expect(summaries.nth(1)).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("tool-call-card")).toHaveCount(0);

      // Clicking "Expand cards" restores all cards cleanly.
      await collapseTrigger.click();
      await expect(collapseTrigger).toHaveAttribute("aria-pressed", "false");
      await expect(page.getByTestId("activity-summary-row")).toHaveCount(0);
      await expect(page.getByTestId("tool-call-card")).toHaveCount(4);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("collapse cards preference is shared across conversations and persists across reloads", { timeout: 30_000 }, async () => {
  const { page, context, errors } = await fixture("planner&cards=1&settled=1");
  try {
    const collapseTrigger = page.getByTestId("collapse-cards-trigger");
    await collapseTrigger.click();
    await expect(collapseTrigger).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("activity-summary-trigger")).toHaveCount(2);

    // Switching to another conversation inherits the collapsed preference immediately.
    await page.evaluate(() => window.changesAudit.select("worker"));
    await page.locator(".initial-query-scroll.conversation-ready").waitFor();
    await expect(collapseTrigger).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("tool-call-card")).toHaveCount(0);

    // Reloading another conversation mode (serial) still remembers the preference.
    await page.goto(`${origin}/__changes?mode=serial&cards=1&settled=1`, { waitUntil: "networkidle" });
    await page.locator(".initial-query-scroll.conversation-ready").waitFor();
    await expect(collapseTrigger).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("activity-summary-trigger")).toHaveCount(2);

    // Expanding in one conversation applies back across all conversations.
    await collapseTrigger.click();
    await expect(collapseTrigger).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("tool-call-card")).toHaveCount(4);
    await page.goto(`${origin}/__changes?mode=planner&cards=1&settled=1`, { waitUntil: "networkidle" });
    await page.locator(".initial-query-scroll.conversation-ready").waitFor();
    await expect(collapseTrigger).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("tool-call-card")).toHaveCount(4);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("collapse and expand cards animate height progressively when motion is enabled", { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, locale: "en-US", reducedMotion: "no-preference" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  const errors = [];
  let page;
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    if (command === "get_execution_output") {
      const body = route.request().postDataJSON();
      const current = await page.evaluate(() => ({ outputText: window.changesAudit.outputText, running: window.changesAudit.running }));
      const bytes = Buffer.from(current.outputText);
      const startOffset = body.tail ? 0 : Math.min(body.offset ?? 0, bytes.length);
      await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        content: bytes.subarray(startOffset).toString(), startOffset, nextOffset: bytes.length,
        totalBytes: bytes.length, complete: true, status: current.running ? "running" : "completed" } } });
      return;
    }
    if (command === "get_file_changes") {
      const body = route.request().postDataJSON();
      const summary = await page.evaluate(() => window.changesAudit.summary);
      await route.fulfill({ json: { result: { runId: body.runId, executionId: null,
        executionIds: body.executionIds ?? null, summary } } });
      return;
    }
    const defaults = { list_files: { files: [] }, list_skills: { skills: [] }, get_merger_prompt: { prompt: "Resolve the conflict." } };
    await route.fulfill({ json: { result: defaults[command] ?? {} } });
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/__changes?mode=serial&cards=1&settled=1`, { waitUntil: "networkidle" });
    await page.locator(".initial-query-scroll.conversation-ready").waitFor();
    const collapseTrigger = page.getByTestId("collapse-cards-trigger");
    await expect(page.getByTestId("tool-call-card")).toHaveCount(4);

    // Sample the second summary row (3 tool cards + thinking) while collapsing.
    const collapseHeights = [];
    const sampleCollapse = (async () => {
      for (let i = 0; i < 10; i++) {
        collapseHeights.push(await page.evaluate(() => {
          const rows = document.querySelectorAll('[data-testid="activity-summary-row"]');
          return rows[1] ? Math.round(rows[1].getBoundingClientRect().height) : -1;
        }));
        await page.waitForTimeout(30);
      }
    })();
    await collapseTrigger.click();
    await sampleCollapse;
    await expect(page.getByTestId("tool-call-card")).toHaveCount(0);
    const settledCollapsedHeight = await page.evaluate(() =>
      Math.round(document.querySelectorAll('[data-testid="activity-summary-row"]')[1].getBoundingClientRect().height));
    assert.ok(
      collapseHeights.some(h => h > settledCollapsedHeight + 20),
      `collapsing must animate progressively down toward ${settledCollapsedHeight}px: ${JSON.stringify(collapseHeights)}`,
    );

    // Sample while expanding back to individual cards.
    const expandHeights = [];
    const sampleExpand = (async () => {
      for (let i = 0; i < 10; i++) {
        expandHeights.push(await page.evaluate(() => {
          const rows = document.querySelectorAll('[data-testid="activity-summary-row"]');
          return rows[1] ? Math.round(rows[1].getBoundingClientRect().height) : -1;
        }));
        await page.waitForTimeout(30);
      }
    })();
    await collapseTrigger.click();
    await sampleExpand;
    await expect(page.getByTestId("activity-summary-row")).toHaveCount(0);
    await expect(page.getByTestId("tool-call-card")).toHaveCount(4);
    assert.ok(
      expandHeights.some(h => h > settledCollapsedHeight + 20),
      `expanding must animate progressively upward before handing off: ${JSON.stringify(expandHeights)}`,
    );
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("scrolling up with collapsed cards preserves anchored summary rows across older page prepends", { timeout: 30_000 }, async () => {
  const padding = "x".repeat(1600);
  const fullLog = Array.from({ length: 40 }, (_, index) => [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `Step ${index} reasoning ${padding}` },
          { type: "toolCall", id: `call-${index}-a`, name: "read", arguments: { path: `src/file-${index}.ts` } },
          { type: "toolCall", id: `call-${index}-b`, name: "bash", arguments: { command: `echo step-${index}` } },
        ],
      },
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: `call-${index}-a`,
      toolName: "read",
      result: { content: [{ type: "text", text: `content ${index} ${padding}` }] },
      isError: false,
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: `call-${index}-b`,
      toolName: "bash",
      result: { content: [{ type: "text", text: `ok ${index}` }] },
      isError: false,
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Milestone output ${index}: completed step ${index}.` }],
      },
    }),
  ].join("\n")).join("\n") + "\n";
  const logBytes = Buffer.from(fullLog);
  let olderReads = 0;

  const { page, context, errors } = await fixture(
    `node&settled=1&bytes=${logBytes.length}`,
    { width: 1280, height: 700 },
    undefined,
    async (body) => {
      const limit = Math.min(body.limit ?? 24_000, 24_000);
      if (body.tail) {
        const end = Math.min(body.before ?? logBytes.length, logBytes.length);
        const start = Math.max(0, end - limit);
        if (body.before !== undefined) olderReads += 1;
        return {
          runId: body.runId, executionId: body.executionId,
          content: logBytes.subarray(start, end).toString(),
          startOffset: start, nextOffset: end, totalBytes: logBytes.length,
          complete: true, status: "completed",
        };
      }
      const start = Math.min(body.offset ?? 0, logBytes.length);
      return {
        runId: body.runId, executionId: body.executionId,
        content: logBytes.subarray(start).toString(),
        startOffset: start, nextOffset: logBytes.length, totalBytes: logBytes.length,
        complete: true, status: "completed",
      };
    },
  );
  try {
    const collapseTrigger = page.getByTestId("collapse-cards-trigger");
    await collapseTrigger.click();
    await expect(collapseTrigger).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("activity-summary-row").first()).toBeVisible();

    // Scroll upward repeatedly to page older history while cards stay collapsed.
    const scroller = page.locator(".initial-query-scroll");
    for (let step = 0; step < 12; step++) {
      await scroller.evaluate(el => {
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -360, bubbles: true }));
        el.scrollTop = Math.max(0, el.scrollTop - 360);
      });
      await page.waitForTimeout(100);
    }
    await expect.poll(() => olderReads).toBeGreaterThan(0);
    await expect(page.getByText("Milestone output 0: completed step 0.")).toBeVisible();
    await expect(page.getByTestId("tool-call-card")).toHaveCount(0);
    // Reset persisted preference for subsequent tests.
    await collapseTrigger.click();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("scrolling up through a tall virtualized collapsed conversation has zero frame-to-frame flicker", { timeout: 30_000 }, async () => {
  const tallAnswer = Array.from({ length: 8 }, (_, line) =>
    `Paragraph ${line}: Detailed explanation of changes, verification results, and follow-up architecture notes across multiple lines of prose.`
  ).join("\n\n");
  const fullLog = Array.from({ length: 50 }, (_, index) => [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `Step ${index} thinking` },
          { type: "toolCall", id: `vcall-${index}`, name: "bash", arguments: { command: `echo step-${index}` } },
        ],
      },
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: `vcall-${index}`,
      toolName: "bash",
      result: { content: [{ type: "text", text: `ok ${index}` }] },
      isError: false,
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `### Turn ${index}\n\n${tallAnswer}` }],
      },
    }),
  ].join("\n")).join("\n") + "\n";
  const logBytes = Buffer.from(fullLog);

  const { page, context, errors } = await fixture(
    `node&settled=1&bytes=${logBytes.length}`,
    { width: 1280, height: 700 },
    undefined,
    async (body) => ({
      runId: body.runId, executionId: body.executionId,
      content: fullLog,
      startOffset: 0, nextOffset: logBytes.length, totalBytes: logBytes.length,
      complete: true, status: "completed",
    }),
  );
  try {
    const collapseTrigger = page.getByTestId("collapse-cards-trigger");
    await collapseTrigger.click();
    await expect(collapseTrigger).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(150);

    const scroller = page.locator(".initial-query-scroll");
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(200);

    // Scroll upward in steps (simulating momentum scroll without wheel on each frame)
    // and assert that mounting unmeasured tall Markdown rows above the viewport
    // never shifts visible rows on any animation frame.
    const maxFlicker = await scroller.evaluate(async (el) => {
      let worstShift = 0;
      for (let step = 0; step < 25; step++) {
        if (el.scrollTop <= 200) break;
        const bounds = el.getBoundingClientRect();
        const visibleRow = [...el.querySelectorAll("[data-transcript-id]")].find(row => {
          const rect = row.getBoundingClientRect();
          return rect.top >= bounds.top + 40 && rect.top < bounds.bottom - 40;
        });
        if (!visibleRow) break;
        const anchorId = visibleRow.dataset.transcriptId;
        const beforeTop = visibleRow.getBoundingClientRect().top;
        const delta = Math.min(260, el.scrollTop);
        el.scrollTop -= delta;
        const expectedTop = beforeTop + delta;
        // Sample 4 consecutive animation frames to catch any 1-frame jump/snap-back flicker.
        for (let frame = 0; frame < 4; frame++) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const current = el.querySelector(`[data-transcript-id="${anchorId}"]`);
          if (current) {
            const shift = Math.abs(current.getBoundingClientRect().top - expectedTop);
            if (shift > worstShift) worstShift = shift;
          }
        }
      }
      return Math.round(worstShift);
    });
    assert.ok(maxFlicker <= 4, `visible row flickered by ${maxFlicker}px while scrolling up with collapsed cards`);
    await collapseTrigger.click();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("collapsed conversations fetch compact transcripts without tool results and upgrade on demand", { timeout: 30_000 }, async () => {
  const requests = [];
  const compactLog = [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "" },
          { type: "toolCall", id: "c-1", name: "bash", arguments: { command: "npm test" } },
        ],
      },
    }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "c-1", toolName: "bash", isError: false }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "All tests passed." }] },
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Final wrap-up." }] },
    }),
  ].join("\n") + "\n";
  const fullLog = [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Full chain of thought details." },
          { type: "toolCall", id: "c-1", name: "bash", arguments: { command: "npm test" } },
        ],
      },
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "c-1",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "FULL_TOOL_RESULT_PAYLOAD_OK " + "R".repeat(800) }], details: { exitCode: 0 } },
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "All tests passed." }] },
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "FULL_SECOND_THINKING_BODY" }] },
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Final wrap-up." }] },
    }),
  ].join("\n") + "\n";
  const fullBytes = Buffer.from(fullLog).length;

  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, locale: "en-US" });
  await context.addInitScript(() => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_collapse_cards_v1", "1");
  });
  const errors = [];
  let page;
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    if (command === "get_execution_output") {
      const body = route.request().postDataJSON();
      requests.push({ summaryOnly: Boolean(body.summaryOnly), tail: Boolean(body.tail), limit: body.limit });
      if (body.summaryOnly) {
        await route.fulfill({ json: { result: {
          runId: body.runId, executionId: body.executionId,
          content: compactLog, startOffset: 0, nextOffset: fullBytes, totalBytes: fullBytes,
          complete: true, status: "completed", summaryOnly: true,
        } } });
      } else {
        // Arrive halfway through the 260ms expand animation to verify the
        // expanded summary stays open even when offset-based IDs change.
        await new Promise(resolve => setTimeout(resolve, 90));
        await route.fulfill({ json: { result: {
          runId: body.runId, executionId: body.executionId,
          content: fullLog, startOffset: 0, nextOffset: fullBytes, totalBytes: fullBytes,
          complete: true, status: "completed",
        } } });
      }
      return;
    }
    if (command === "get_file_changes") {
      const body = route.request().postDataJSON();
      const summary = await page.evaluate(() => window.changesAudit.summary);
      await route.fulfill({ json: { result: { runId: body.runId, executionId: null, executionIds: body.executionIds ?? null, summary } } });
      return;
    }
    const defaults = { list_files: { files: [] }, list_skills: { skills: [] }, get_merger_prompt: { prompt: "Resolve the conflict." } };
    await route.fulfill({ json: { result: defaults[command] ?? {} } });
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/__changes?mode=node&settled=1&bytes=${fullBytes}`, { waitUntil: "domcontentloaded" });
    await page.locator(".initial-query-scroll.conversation-ready").waitFor();

    // Opening with cards collapsed fetches ONLY summary-only output (never full tool results)
    // and requests the larger summary history window (1 MiB compacted).
    assert.equal(requests.length, 1);
    assert.equal(requests[0].summaryOnly, true);
    assert.equal(requests[0].limit, 1024 * 1024);
    await expect(page.getByText("All tests passed.")).toBeVisible();
    const summaries = page.getByTestId("activity-summary-trigger");
    await expect(summaries).toHaveCount(2);
    await expect(summaries.nth(0)).toContainText("Ran npm test");
    await expect(summaries.nth(1)).toContainText("Thought");

    // Clicking the thinking-only summary triggers an on-demand full upgrade
    // whose response arrives mid-animation and shifts the thinking block's
    // byte offset. The summary must stay expanded (never expand halfway and
    // snap back closed) and expose the full thinking body.
    await summaries.nth(1).click();
    await expect.poll(() => requests.some(req => !req.summaryOnly)).toBe(true);
    await page.waitForTimeout(320);
    await expect(summaries.nth(1)).toHaveAttribute("aria-expanded", "true");
    const thinkingToggle = page.getByTestId("activity-summary-cards").locator(".thinking-card-header");
    await thinkingToggle.click();
    await expect(page.getByText("FULL_SECOND_THINKING_BODY")).toBeVisible();

    // Expanding the first summary exposes the already-upgraded tool result too.
    await summaries.nth(0).click();
    const toolHeader = page.getByTestId("activity-summary-cards").first().getByTestId("tool-call-card").locator(".tool-call-header");
    await toolHeader.click();
    await expect(page.getByText(/FULL_TOOL_RESULT_PAYLOAD_OK/)).toBeVisible();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("collapsing and expanding cards in a tall virtualized conversation has zero vertical or horizontal jitter", { timeout: 30_000 }, async () => {
  const tallAnswer = "Paragraph 1: Detailed explanation.\n\nParagraph 2: More context.\n\nParagraph 3: Summary.";
  const fullLog = Array.from({ length: 30 }, (_, index) => [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `Step ${index} thinking` },
          {
            type: "toolCall",
            id: `jcall-${index}`,
            name: "bash",
            arguments: {
              command: `git log --stat --oneline --decorate --graph --all -- src/components/views/GraphWorkbench.tsx src/components/VirtualizedList.tsx ${index}`,
            },
          },
        ],
      },
    }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: `jcall-${index}`, toolName: "bash", isError: false }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: `### Step ${index}\n\n${tallAnswer}` }] },
    }),
  ].join("\n")).join("\n") + "\n";
  const logBytes = Buffer.from(fullLog);

  const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, locale: "en-US" });
  await context.addInitScript(() => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_collapse_cards_v1", "1");
  });
  const errors = [];
  let page;
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON();
    if (command === "get_execution_output") {
      await route.fulfill({ json: { result: {
        runId: body.runId, executionId: body.executionId,
        content: fullLog, startOffset: 0, nextOffset: logBytes.length, totalBytes: logBytes.length,
        complete: true, status: "completed", ...(body.summaryOnly ? { summaryOnly: true } : {}),
      } } });
      return;
    }
    if (command === "get_file_changes") {
      const summary = await page.evaluate(() => window.changesAudit.summary);
      await route.fulfill({ json: { result: { runId: body.runId, executionId: null, executionIds: body.executionIds ?? null, summary } } });
      return;
    }
    await route.fulfill({ json: { result: {} } });
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/__changes?mode=node&settled=1&bytes=${logBytes.length}`, { waitUntil: "domcontentloaded" });
    await page.locator(".initial-query-scroll.conversation-ready").waitFor();

    const sampleMotion = async () => {
      await page.evaluate(() => {
        window.__motionSamples = [];
        const start = performance.now();
        function tick() {
          const rows = [...document.querySelectorAll("[data-transcript-id]")];
          const textRows = rows.filter(r => r.dataset.transcriptId?.startsWith("text_"));
          const lastText = textRows.at(-1);
          const prevText = textRows.at(-2);
          const trigger = document.querySelector('[data-testid="activity-summary-trigger"]');
          const trigRect = trigger?.getBoundingClientRect();
          const rowRect = trigger?.closest('[data-testid="activity-summary-row"]')?.getBoundingClientRect();
          const footerBtn = document.querySelector('[data-testid="collapse-cards-trigger"]');
          const footerRect = footerBtn?.getBoundingClientRect();
          window.__motionSamples.push({
            lastB: lastText ? Math.round(lastText.getBoundingClientRect().bottom) : null,
            prevB: prevText ? Math.round(prevText.getBoundingClientRect().bottom) : null,
            trigW: trigRect ? Math.round(trigRect.width) : null,
            overflowX: trigRect && rowRect ? Math.round(trigRect.right - rowRect.right) : 0,
            footerTop: footerRect ? +footerRect.top.toFixed(2) : null,
            footerLeft: footerRect ? +footerRect.left.toFixed(2) : null,
          });
          if (performance.now() - start < 400) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
      await page.getByTestId("collapse-cards-trigger").click();
      await page.waitForTimeout(450);
      return page.evaluate(() => window.__motionSamples);
    };

    // Expand cards: bottom button and text stay locked with zero subpixel jitter, previous text moves strictly upward, no horizontal overflow.
    const expandSamples = await sampleMotion();
    const expandFooterTops = expandSamples.map(s => s.footerTop).filter(v => v !== null);
    assert.ok(Math.max(...expandFooterTops) - Math.min(...expandFooterTops) <= 0.5,
      `expand footer button jittered vertically: ${JSON.stringify(expandFooterTops)}`);
    const expandLastBs = expandSamples.map(s => s.lastB).filter(v => v !== null);
    assert.ok(Math.max(...expandLastBs) - Math.min(...expandLastBs) <= 2, `expand lastBottom jittered: ${JSON.stringify(expandLastBs)}`);
    const expandPrevBs = expandSamples.map(s => s.prevB).filter(v => v !== null);
    for (let i = 1; i < expandPrevBs.length; i++) {
      assert.ok(expandPrevBs[i] <= expandPrevBs[i - 1] + 2, `expand prevText jumped down: ${JSON.stringify(expandPrevBs)}`);
    }
    assert.ok(expandSamples.every(s => s.overflowX <= 1), `expand summary bar overflowed horizontally: ${JSON.stringify(expandSamples)}`);

    // Collapse cards: bottom button and text stay locked with zero subpixel jitter, previous text moves strictly downward, summary bar width stays constant.
    const collapseSamples = await sampleMotion();
    const collapseFooterTops = collapseSamples.map(s => s.footerTop).filter(v => v !== null);
    assert.ok(Math.max(...collapseFooterTops) - Math.min(...collapseFooterTops) <= 0.5,
      `collapse footer button jittered vertically: ${JSON.stringify(collapseFooterTops)}`);
    const collapseLastBs = collapseSamples.map(s => s.lastB).filter(v => v !== null);
    assert.ok(Math.max(...collapseLastBs) - Math.min(...collapseLastBs) <= 2, `collapse lastBottom jittered: ${JSON.stringify(collapseLastBs)}`);
    const collapsePrevBs = collapseSamples.map(s => s.prevB).filter(v => v !== null);
    for (let i = 1; i < collapsePrevBs.length; i++) {
      assert.ok(collapsePrevBs[i] >= collapsePrevBs[i - 1] - 2, `collapse prevText jumped up: ${JSON.stringify(collapsePrevBs)}`);
    }
    const collapseTrigWs = collapseSamples.map(s => s.trigW).filter(v => v !== null);
    assert.ok(collapseTrigWs.length > 0 && Math.max(...collapseTrigWs) - Math.min(...collapseTrigWs) <= 2,
      `summary bar width flickered horizontally: ${JSON.stringify(collapseTrigWs)}`);
    assert.ok(collapseSamples.every(s => s.overflowX <= 1), `collapse summary bar overflowed horizontally: ${JSON.stringify(collapseSamples)}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("collapsed summary rows with raw ranges hydrate only the clicked group without full-log upgrade", { timeout: 30_000 }, async () => {
  const requests = [];
  const summaryLog = [
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "r-call-1",
      toolName: "bash",
      args: { command: "npm test" },
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "r-call-1",
      toolName: "bash",
      isError: false,
      result: { details: { exitCode: 0 } },
      grapherBodyOmitted: true,
      grapherRawRange: [100, 1200],
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "First step done." }] },
    }),
    JSON.stringify({
      type: "message_end",
      grapherRawRange: [2000, 3200],
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "", grapherBodyOmitted: true, grapherThinkingChars: 2400 }],
      },
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "All finished." }] },
    }),
  ].join("\n") + "\n";

  const hydratedByRange = {
    "100:1200": JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "r-call-1",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "TARGETED_BASH_RESULT_OK" }], details: { exitCode: 0 } },
      grapherRawRange: [100, 1200],
    }) + "\n",
    "2000:3200": JSON.stringify({
      type: "message_end",
      grapherRawRange: [2000, 3200],
      message: { role: "assistant", content: [{ type: "thinking", thinking: "TARGETED_THINKING_BODY_OK" }] },
    }) + "\n",
  };

  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, locale: "en-US" });
  await context.addInitScript(() => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_collapse_cards_v1", "1");
  });
  const errors = [];
  let page;
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON();
    if (command === "get_execution_output") {
      requests.push(body);
      if (Array.isArray(body.ranges)) {
        const content = body.ranges.map(([s, e]) => hydratedByRange[`${s}:${e}`] ?? "").join("");
        await route.fulfill({ json: { result: {
          runId: body.runId, executionId: body.executionId,
          content, startOffset: body.ranges[0][0], nextOffset: body.ranges.at(-1)[1], totalBytes: 5000,
          complete: true, status: "completed", projection: "hydrated",
        } } });
        return;
      }
      await route.fulfill({ json: { result: {
        runId: body.runId, executionId: body.executionId,
        content: summaryLog, startOffset: 0, nextOffset: 5000, totalBytes: 5000,
        complete: true, status: "completed", summaryOnly: true, projection: "summary",
      } } });
      return;
    }
    if (command === "get_file_changes") {
      const summary = await page.evaluate(() => window.changesAudit.summary);
      await route.fulfill({ json: { result: { runId: body.runId, executionId: null, executionIds: body.executionIds ?? null, summary } } });
      return;
    }
    await route.fulfill({ json: { result: { list_files: { files: [] }, list_skills: { skills: [] } }[command] ?? {} } });
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/__changes?mode=node&settled=1&bytes=5000`, { waitUntil: "domcontentloaded" });
    await page.locator(".initial-query-scroll.conversation-ready").waitFor();

    const summaries = page.getByTestId("activity-summary-trigger");
    await expect(summaries).toHaveCount(2);

    // Expanding the second summary hydrates ONLY [2000, 3200] — never re-fetching full output.
    await summaries.nth(1).click();
    await expect.poll(() => requests.some(req => Array.isArray(req.ranges))).toBe(true);
    assert.equal(requests.some(req => !req.summaryOnly && !req.ranges && req.projection !== "cards"), false,
      "must not upgrade whole execution to raw full log");
    const hydrateReq = requests.find(req => Array.isArray(req.ranges));
    assert.deepEqual(hydrateReq.ranges, [[2000, 3200]]);

    const thinkingHeader = page.getByTestId("activity-summary-cards").locator(".thinking-card-header");
    await thinkingHeader.click();
    await expect(page.getByText("TARGETED_THINKING_BODY_OK")).toBeVisible();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("expanded settled history uses CardShell projection and hydrates large cards on click", { timeout: 30_000 }, async () => {
  const requests = [];
  const cardsShellLog = [
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "inline-read",
      toolName: "read",
      args: { path: "README.md" },
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "inline-read",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "INLINE_SMALL_BODY_OK" }] },
    }),
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "large-bash",
      toolName: "bash",
      args: { command: "npm run test:all" },
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "large-bash",
      toolName: "bash",
      isError: false,
      result: { details: { exitCode: 0 } },
      grapherBodyOmitted: true,
      grapherRawRange: [400, 8400],
      grapherSubcommandWarning: true,
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Checks completed." }] },
    }),
  ].join("\n") + "\n";

  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, locale: "en-US" });
  await context.addInitScript(() => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_collapse_cards_v1", "0");
  });
  const errors = [];
  let page;
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON();
    if (command === "get_execution_output") {
      requests.push(body);
      if (Array.isArray(body.ranges)) {
        await route.fulfill({ json: { result: {
          runId: body.runId, executionId: body.executionId,
          content: JSON.stringify({
            type: "tool_execution_end",
            toolCallId: "large-bash",
            toolName: "bash",
            isError: false,
            result: { content: [{ type: "text", text: "HYDRATED_LARGE_BASH_OUTPUT_OK\nnot ok 1 - detail" }], details: { exitCode: 0 } },
            grapherRawRange: [400, 8400],
          }) + "\n",
          startOffset: 400, nextOffset: 8400, totalBytes: 10_000,
          complete: true, status: "completed", projection: "hydrated",
        } } });
        return;
      }
      await route.fulfill({ json: { result: {
        runId: body.runId, executionId: body.executionId,
        content: cardsShellLog, startOffset: 0, nextOffset: 10_000, totalBytes: 10_000,
        complete: true, status: "completed", projection: "cards",
      } } });
      return;
    }
    if (command === "get_file_changes") {
      const summary = await page.evaluate(() => window.changesAudit.summary);
      await route.fulfill({ json: { result: { runId: body.runId, executionId: null, executionIds: body.executionIds ?? null, summary } } });
      return;
    }
    await route.fulfill({ json: { result: { list_files: { files: [] }, list_skills: { skills: [] } }[command] ?? {} } });
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/__changes?mode=node&settled=1&bytes=10000`, { waitUntil: "domcontentloaded" });
    await page.locator(".initial-query-scroll.conversation-ready").waitFor();

    // Initial load requests projection="cards" with the standard 512 KiB limit.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].projection, "cards");
    assert.equal(requests[0].limit, 512 * 1024);

    // The omitted bash card still displays its warning badge from shell metadata before hydration.
    const cards = page.getByTestId("tool-call-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(1)).toHaveClass(/warning/);

    // Clicking the small inline card opens immediately with zero extra network calls.
    await cards.nth(0).locator(".tool-call-header").click();
    await expect(page.getByText("INLINE_SMALL_BODY_OK")).toBeVisible();
    assert.equal(requests.length, 1);

    // Clicking the large omitted card hydrates ONLY [400, 8400] and renders its full output.
    await cards.nth(1).locator(".tool-call-header").click();
    await expect.poll(() => requests.some(req => Array.isArray(req.ranges))).toBe(true);
    assert.deepEqual(requests.find(req => Array.isArray(req.ranges)).ranges, [[400, 8400]]);
    await expect(page.getByText(/HYDRATED_LARGE_BASH_OUTPUT_OK/)).toBeVisible();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("fast upward scrolling and older-page prepends in expanded mode have zero blank frames or snap-back flicker", { timeout: 30_000 }, async () => {
  const tallAnswer = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: Detailed technical explanation with enough lines to exceed row height estimates.`).join("\n\n");
  const fullLog = Array.from({ length: 50 }, (_, index) => [
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: `fast-call-${index}`,
      toolName: "bash",
      args: { command: `echo step-${index}` },
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: `fast-call-${index}`,
      toolName: "bash",
      result: { content: [{ type: "text", text: `ok ${index}` }] },
      isError: false,
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `### Expanded Turn ${index}\n\n${tallAnswer}` }],
      },
    }),
  ].join("\n")).join("\n") + "\n";
  const logBytes = Buffer.from(fullLog);
  const pageSize = Math.floor(logBytes.length / 3);

  const { page, context, errors } = await fixture(
    `node&settled=1&bytes=${logBytes.length}`,
    { width: 1280, height: 700 },
    undefined,
    async (body) => {
      const end = body.before ?? logBytes.length;
      let start = Math.max(0, end - pageSize);
      if (start > 0) {
        const nl = logBytes.indexOf(0x0a, start);
        if (nl >= 0 && nl + 1 < end) start = nl + 1;
      }
      return {
        runId: body.runId,
        executionId: body.executionId,
        content: logBytes.subarray(start, end).toString("utf8"),
        startOffset: start,
        nextOffset: end,
        totalBytes: logBytes.length,
        complete: end === logBytes.length,
        status: "completed",
      };
    },
  );
  try {
    const scroller = page.locator(".initial-query-scroll");
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(200);

    const metrics = await scroller.evaluate(async (el) => {
      let blankFrames = 0;
      let worstFrameToFrame = 0;
      let worstMidScrollShift = 0;
      let prependsObserved = 0;
      let steps = 0;
      for (let step = 0; step < 30; step++) {
        if (el.scrollTop <= 150) break;
        const bounds = el.getBoundingClientRect();
        const visibleRows = [...el.querySelectorAll("[data-transcript-id]")].filter(row => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > bounds.top + 8 && rect.top < bounds.bottom - 8;
        });
        if (!visibleRows.length) { blankFrames++; break; }
        const anchor = visibleRows.find(row => {
          const rect = row.getBoundingClientRect();
          return rect.top >= bounds.top + 20 && rect.top < bounds.bottom - 120;
        }) ?? visibleRows[0];
        const anchorId = anchor.dataset.transcriptId;
        const beforeTop = anchor.getBoundingClientRect().top;
        const beforeScrollTop = el.scrollTop;
        const delta = Math.min(520, el.scrollTop);
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -delta, bubbles: true }));
        el.scrollTop -= delta;
        const hitTopBoundary = beforeScrollTop - delta <= 120;
        const expectedTop = beforeTop + delta;
        steps++;
        let frame0Top = null;
        let frame0ScrollTop = el.scrollTop;
        for (let frame = 0; frame < 3; frame++) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const nowVisible = [...el.querySelectorAll("[data-transcript-id]")].filter(row => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > bounds.top + 8 && rect.top < bounds.bottom - 8;
          });
          if (!nowVisible.length) blankFrames++;
          const current = el.querySelector(`[data-transcript-id="${anchorId}"]`);
          if (current) {
            const rect = current.getBoundingClientRect();
            if (rect.top < bounds.bottom && rect.bottom > bounds.top) {
              if (frame === 0) {
                frame0Top = rect.top;
                frame0ScrollTop = el.scrollTop;
              } else {
                if (el.scrollTop > frame0ScrollTop + 500) prependsObserved++;
                if (frame0Top !== null) {
                  const frameShift = Math.abs(rect.top - frame0Top);
                  if (frameShift > worstFrameToFrame) worstFrameToFrame = frameShift;
                }
              }
              if (!hitTopBoundary) {
                const shift = Math.abs(rect.top - expectedTop);
                if (shift > worstMidScrollShift) worstMidScrollShift = shift;
              }
            }
          }
        }
      }
      return {
        blankFrames,
        worstFrameToFrame: Math.round(worstFrameToFrame),
        worstMidScrollShift: Math.round(worstMidScrollShift),
        prependsObserved,
        steps,
      };
    });
    assert.ok(metrics.steps >= 5, `expected multiple upward scroll steps, got ${JSON.stringify(metrics)}`);
    assert.ok(metrics.prependsObserved >= 1, `expected at least one older-page prepend during scrollback, got ${JSON.stringify(metrics)}`);
    assert.equal(metrics.blankFrames, 0, `viewport flashed blank during fast upward scroll: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.worstFrameToFrame <= 4, `visible row flickered by ${metrics.worstFrameToFrame}px across prepend frames: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.worstMidScrollShift <= 6, `visible row shifted by ${metrics.worstMidScrollShift}px during mid-history fast upward scroll: ${JSON.stringify(metrics)}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
