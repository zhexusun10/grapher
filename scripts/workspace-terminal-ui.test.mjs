import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

let server;
let browser;
let origin;

const repoA = "/mock/workspace-alpha";
const repoB = "/mock/workspace-beta";

const baseConfig = (repository) => ({
  repository,
  model: "test/model",
  thinkingLevel: "off",
  maxParallel: 2,
  maxFeedback: 3,
  autoApprove: false,
});

const emptySnapshot = {
  runId: "",
  config: null,
  phase: "draft",
  graph: { originalGoal: "", nodes: [], edges: [] },
  nodes: {},
  executions: [],
  events: [],
  mergers: [],
  plan: null,
  approved: false,
  paused: false,
  base: "",
  feedbackCounts: {},
};

const runA1 = {
  ...emptySnapshot,
  runId: "run-alpha-1",
  config: baseConfig(repoA),
  planType: "serial",
  phase: "completed",
  approved: true,
  graph: {
    originalGoal: "Alpha conversation one",
    nodes: [{ id: "task", task: "Do work" }],
    edges: [],
  },
  nodes: { task: { status: "completed" } },
};

const runA2 = {
  ...emptySnapshot,
  runId: "run-alpha-2",
  config: baseConfig(repoA),
  planType: "serial",
  phase: "completed",
  approved: true,
  graph: {
    originalGoal: "Alpha conversation two",
    nodes: [{ id: "task", task: "Do more work" }],
    edges: [],
  },
  nodes: { task: { status: "completed" } },
};

before(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-workspace-terminal-ui",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null },
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"),
    headless: true,
  });
});

after(async () => {
  await browser?.close();
  server?.httpServer?.closeAllConnections?.();
  await server?.close();
});

async function setupDesktopPage({ platform = "macos", tauriMode = true, reducedMotion = "reduce", earlyExit = false, createDelay = 0, earlyCursorQuery = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 840 },
    locale: "en-US",
    reducedMotion,
  });

  const platformConfig = platform === "windows"
    ? { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", uaPlatform: "Windows", shell: "pwsh" }
    : { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", uaPlatform: "macOS", shell: "zsh" };

  await context.addInitScript(({ tauriMode, platformConfig, repoA, repoB, origin, earlyExit, createDelay, earlyCursorQuery }) => {
    Object.defineProperty(navigator, "platform", { value: platformConfig.platform, configurable: true });
    Object.defineProperty(navigator, "userAgent", { value: platformConfig.userAgent, configurable: true });
    Object.defineProperty(navigator, "userAgentData", {
      value: { platform: platformConfig.uaPlatform },
      configurable: true,
    });
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_projects", JSON.stringify([
      { id: repoA, path: repoA, name: "workspace-alpha", lastOpened: 2 },
      { id: repoB, path: repoB, name: "workspace-beta", lastOpened: 1 },
    ]));
    localStorage.setItem("grapher_last_workspace", repoA);

    if (!tauriMode) return;

    let nextSessionNum = 1;
    let nextCallbackId = 1;
    const callbacks = new Map();
    const eventListeners = new Map();
    const terminalCalls = [];

    window.__terminalTest = {
      calls: terminalCalls,
      emit(eventName, payload) {
        const ids = eventListeners.get(eventName) || [];
        for (const id of ids) {
          const fn = callbacks.get(id);
          if (fn) fn({ event: eventName, id, payload });
        }
      },
    };

    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main", windowLabel: "main" },
      },
      transformCallback(callback, once = false) {
        const id = nextCallbackId++;
        callbacks.set(id, (data) => {
          if (once) callbacks.delete(id);
          return callback(data);
        });
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      async invoke(cmd, args = {}) {
        if (cmd === "backend_url") return origin;
        if (cmd === "git_bootstrap_status") return { phase: "not_needed", gitPath: null, error: null };
        if (cmd === "desktop_notification_permission_status") return "granted";
        if (cmd === "take_pending_notification_click") return null;
        if (cmd === "plugin:window|is_fullscreen") return false;
        if (cmd === "plugin:window|is_maximized") return false;
        if (cmd === "plugin:window|show") return null;
        if (cmd === "plugin:event|listen") {
          const list = eventListeners.get(args.event) || [];
          list.push(args.handler);
          eventListeners.set(args.event, list);
          return args.handler;
        }
        if (cmd === "plugin:event|unlisten") {
          const list = eventListeners.get(args.event) || [];
          eventListeners.set(args.event, list.filter((id) => id !== args.eventId));
          callbacks.delete(args.eventId);
          return null;
        }
        if (cmd === "terminal_create") {
          const sessionId = `pty-${nextSessionNum++}`;
          terminalCalls.push({ cmd, args, sessionId });
          if (earlyCursorQuery) {
            window.__terminalTest.emit("grapher://terminal-output", { sessionId, data: btoa("\x1b[6n") });
            await new Promise(resolve => setTimeout(resolve, 50));
            return { sessionId, shell: platformConfig.shell, cwd: args.workspacePath };
          }
          if (earlyExit) {
            window.__terminalTest.emit("grapher://terminal-output", { sessionId, data: btoa("FAST_STARTUP_ERROR\r\n") });
            window.__terminalTest.emit("grapher://terminal-exit", { sessionId, exitCode: 1 });
            await new Promise(resolve => setTimeout(resolve, 50));
            return { sessionId, shell: platformConfig.shell, cwd: args.workspacePath };
          }
          // Emit a welcome prompt shortly after creation.
          setTimeout(() => {
            window.__terminalTest.emit("grapher://terminal-output", {
              sessionId,
              data: btoa(`welcome:${args.workspacePath}\r\n$ `),
            });
          }, 15);
          if (createDelay) await new Promise(resolve => setTimeout(resolve, createDelay));
          return {
            sessionId,
            shell: platformConfig.shell,
            cwd: args.workspacePath,
          };
        }
        if (cmd === "terminal_write" || cmd === "terminal_resize" || cmd === "terminal_kill") {
          terminalCalls.push({ cmd, args });
          return null;
        }
        return null;
      },
    };
  }, { tauriMode, platformConfig, repoA, repoB, origin, earlyExit, createDelay, earlyCursorQuery });

  let currentRepo = repoA;
  const snapshotsById = { [runA1.runId]: runA1, [runA2.runId]: runA2 };
  const webCalls = [];
  const webSessions = new Map();

  await context.route("**/api/*", async (route) => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON() || {};
    let result = null;
    switch (command) {
      case "terminal_create": {
        const sessionId = `web-pty-${webCalls.filter(c => c.command === command).length + 1}`;
        webCalls.push({ command, body, sessionId });
        webSessions.set(sessionId, { chunks: [Buffer.from(`welcome:${body.workspacePath}\r\n$ `).toString("base64")], exitCode: null, exited: false });
        result = { sessionId, shell: "bash", cwd: body.workspacePath };
        break;
      }
      case "terminal_read": {
        const session = webSessions.get(body.sessionId);
        if (session?.failures) {
          session.failures -= 1;
          await route.fulfill({ status: 503, json: { error: "Temporary connection failure" } });
          return;
        }
        const chunks = session?.chunks ?? [];
        result = { chunks: chunks.slice(body.cursor), cursor: chunks.length, truncated: false,
          exited: session?.exited ?? true, exitCode: session?.exitCode ?? null, more: false };
        break;
      }
      case "terminal_write":
      case "terminal_resize":
      case "terminal_kill":
        webCalls.push({ command, body });
        if (command === "terminal_kill") webSessions.delete(body.sessionId);
        break;
      case "bootstrap": {
        const repo = currentRepo;
        const isA = repo === repoA;
        result = {
          config: baseConfig(repo),
          snapshot: emptySnapshot,
          runs: isA ? [runA1.runId, runA2.runId] : [],
          conversations: isA
            ? [
                { runId: runA1.runId, repository: repoA, title: runA1.graph.originalGoal, phase: "completed", planType: "serial", hasActiveExecutions: false },
                { runId: runA2.runId, repository: repoA, title: runA2.graph.originalGoal, phase: "completed", planType: "serial", hasActiveExecutions: false },
              ]
            : [],
          repositoryInfo: { path: repo, name: isA ? "workspace-alpha" : "workspace-beta", branch: "main", head: "", clean: true },
          dataPath: "/mock/data",
          envOverrides: {},
        };
        break;
      }
      case "save_config": {
        if (body.repository) currentRepo = body.repository;
        const isA = currentRepo === repoA;
        result = {
          config: baseConfig(currentRepo),
          snapshot: emptySnapshot,
          runs: isA ? [runA1.runId, runA2.runId] : [],
          conversations: isA
            ? [
                { runId: runA1.runId, repository: repoA, title: runA1.graph.originalGoal, phase: "completed", planType: "serial", hasActiveExecutions: false },
                { runId: runA2.runId, repository: repoA, title: runA2.graph.originalGoal, phase: "completed", planType: "serial", hasActiveExecutions: false },
              ]
            : [],
          repositoryInfo: { path: currentRepo, name: isA ? "workspace-alpha" : "workspace-beta", branch: "main", head: "", clean: true },
          dataPath: "/mock/data",
        };
        break;
      }
      case "load_run":
      case "snapshot":
      case "history":
        result = snapshotsById[body.runId] ?? emptySnapshot;
        break;
      case "snapshot_if_changed":
        result = { version: "1", snapshot: snapshotsById[body.runId] ?? null };
        break;
      case "get_execution_output":
        result = { lines: [], bytesRead: 0, totalBytes: 0, startOffset: 0, endOffset: 0, truncated: false };
        break;
      case "get_file_changes":
        result = { files: [], totalAdded: 0, totalDeleted: 0, scope: "run" };
        break;
      case "repository_status":
        result = { repository: body.repository || currentRepo, valid: true, error: null };
        break;
      case "detect_repository":
        result = { path: body.repository || currentRepo, name: "workspace", branch: "main", head: "", clean: true };
        break;
      case "host_preflight":
        result = { gitAvailable: true, gitPath: "/usr/bin/git", gitError: null };
        break;
      case "list_plannings":
        result = [];
        break;
      case "list_files":
        result = { files: [] };
        break;
      case "list_skills":
        result = { skills: [] };
        break;
      case "provider_auth":
        result = { providers: [], models: [], warning: null };
        break;
      case "pi_extensions":
        result = { globalDirectory: "/mock/extensions", extensions: [] };
        break;
      case "environment_capabilities":
        result = { platform, arch: "x86_64", nativeWorkspace: true };
        break;
      default:
        result = null;
    }
    try {
      await route.fulfill({ json: { result } });
    } catch {
      // Ignore cancelled requests during teardown.
    }
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(origin, { waitUntil: "networkidle" });
  return { context, page, pageErrors, webCalls, webSessions };
}

test("browser terminal uses HTTP for creation, output, input, resize and close", async () => {
  const { context, page, pageErrors, webCalls } = await setupDesktopPage({ tauriMode: false });
  try {
    await page.locator(".prompt-box-left-actions").waitFor();
    await page.locator('[data-testid="composer-terminal-toggle"]').click();
    await page.waitForFunction(() => document.querySelector('.workspace-terminal-xterm')?.textContent.includes('welcome:'));
    assert.equal(webCalls.find(c => c.command === "terminal_create").body.workspacePath, repoA);
    await page.locator('.workspace-terminal-xterm').click();
    await page.keyboard.type('pwd');
    await page.waitForTimeout(200);
    assert.ok(webCalls.some(c => c.command === "terminal_write" && c.body.data.includes('p')));
    assert.ok(webCalls.some(c => c.command === "terminal_resize" && c.body.cols > 0 && c.body.rows > 0));
    await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
    await page.waitForTimeout(100);
    assert.ok(webCalls.some(c => c.command === "terminal_kill" && c.body.sessionId === "web-pty-1"));
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("startup output and exit arriving before create reply remain visible", async () => {
  const { context, page, pageErrors } = await setupDesktopPage({ earlyExit: true });
  try {
    await page.locator('[data-testid="composer-terminal-toggle"]').click();
    await page.locator('.workspace-terminal-status-pill.is-exited').waitFor();
    await page.waitForFunction(() => document.querySelector('.workspace-terminal-xterm')?.textContent.includes('FAST_STARTUP_ERROR'));
    assert.equal(await page.locator('.workspace-terminal-restart-btn').count(), 1);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("browser terminal resumes at its cursor after a failed read and drains final UTF-8 output", async () => {
  const { context, page, webSessions, webCalls } = await setupDesktopPage({ tauriMode: false });
  try {
    await page.locator('[data-testid="composer-terminal-toggle"]').click();
    await page.waitForFunction(() => document.querySelector('.workspace-terminal-xterm')?.textContent.includes('welcome:'));
    const session = webSessions.get("web-pty-1");
    session.failures = 1;
    session.chunks.push(Buffer.from("恢复输出 🚀\r\n").toString("base64"));
    session.exited = true;
    session.exitCode = 7;
    await page.locator('.workspace-terminal-status-pill.is-exited').waitFor();
    await page.waitForFunction(() => document.querySelector('.workspace-terminal-xterm')?.textContent.includes('恢复输出 🚀'));
    assert.equal((await page.locator('.workspace-terminal-xterm').textContent()).split('恢复输出').length - 1, 1);
    assert.match(await page.locator('.workspace-terminal-status-pill').textContent(), /7/);
    await page.waitForTimeout(100);
    assert.ok(webCalls.some(c => c.command === "terminal_kill" && c.body.sessionId === "web-pty-1"));
  } finally { await context.close(); }
});

test("closing a terminal while create is pending kills the late session", async () => {
  const { context, page } = await setupDesktopPage({ createDelay: 150, reducedMotion: "no-preference" });
  try {
    await page.locator('[data-testid="composer-terminal-toggle"]').click();
    await page.waitForFunction(() => window.__terminalTest.calls.some(c => c.cmd === "terminal_create"));
    await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
    await page.waitForFunction(() => window.__terminalTest.calls.some(c => c.cmd === "terminal_kill" && c.args.sessionId === "pty-1"));
    await page.locator('[data-testid="workspace-terminal-card"]').waitFor({ state: "hidden" });
  } finally { await context.close(); }
});

test("Windows startup cursor query arriving before create reply gets an xterm response", async () => {
  const { context, page } = await setupDesktopPage({ platform: "windows", earlyCursorQuery: true });
  try {
    await page.locator('[data-testid="composer-terminal-toggle"]').click();
    await page.waitForFunction(() => window.__terminalTest.calls.some(c =>
      c.cmd === "terminal_write" && /\x1b\[\d+;\d+R/.test(c.args.data)));
  } finally { await context.close(); }
});

for (const platform of ["macos", "windows"]) {
  test(`${platform} desktop terminal docks under composer, persists across conversations, scopes per workspace, minimizes, maximizes to workbench bounds, and kills on close`, async () => {
    const { context, page, pageErrors } = await setupDesktopPage({ platform, tauriMode: true });
    try {
      // 1. Toggle button sits directly to the right of the Paperclip attachment button.
      const leftButtons = page.locator(".landing-composer .prompt-box-left-actions > button");
      await leftButtons.first().waitFor();
      assert.equal(await leftButtons.count(), 2);
      const attachBox = await leftButtons.nth(0).boundingBox();
      const termBtnBox = await leftButtons.nth(1).boundingBox();
      assert.ok(termBtnBox.x > attachBox.x, "terminal button must appear to the right of the attachment button");

      // 2. Opening terminal docks it at the bottom and pushes the composer upward.
      const composerBefore = await page.locator(".landing-composer .prompt-box-container").boundingBox();
      await page.locator('[data-testid="composer-terminal-toggle"]').click();

      const dock = page.locator('[data-testid="workspace-terminal-dock"]');
      const card = page.locator('[data-testid="workspace-terminal-card"]');
      await card.waitFor({ state: "visible" });
      await page.locator(".workspace-terminal-xterm .xterm").waitFor({ state: "visible" });
      // Verify streamed PTY output arrived and rendered in xterm, and typing forwards to terminal_write.
      await page.waitForFunction((expected) => {
        const xterm = document.querySelector(".workspace-terminal-xterm .xterm");
        return xterm?.textContent?.includes(expected);
      }, `welcome:${repoA}`);
      await page.locator(".workspace-terminal-xterm").click();
      await page.keyboard.type("ls");
      await page.waitForFunction(() =>
        window.__terminalTest.calls.some((c) => c.cmd === "terminal_write" && c.args.sessionId === "pty-1"),
      );

      const composerAfter = await page.locator(".landing-composer .prompt-box-container").boundingBox();
      const cardBox = await card.boundingBox();
      assert.ok(composerAfter.y + composerAfter.height < composerBefore.y + composerBefore.height - 100,
        "docked terminal must push the composer upward");
      assert.ok(cardBox.y >= composerAfter.y + composerAfter.height - 2,
        "terminal card must sit below the composer");

      // Border radius aligns with workbench (18px).
      const cardRadius = await card.evaluate((el) => getComputedStyle(el).borderRadius);
      assert.equal(cardRadius, "18px");

      // 3. Switching conversations keeps the exact same terminal open without recreating or killing it.
      await page.locator(`[data-run-id="${runA1.runId}"]`).click();
      await page.locator(".workbench").waitFor({ state: "visible" });
      assert.equal(await dock.isVisible(), true, "terminal must stay open when entering Conversation 1");
      assert.equal(await dock.getAttribute("data-terminal-mode"), "open");

      const workbenchBox = await page.locator(".workbench").boundingBox();
      const workbenchRadius = await page.locator(".workbench").evaluate((el) => getComputedStyle(el).borderRadius);
      assert.equal(cardRadius, workbenchRadius, "terminal corner radius must match workbench");

      const wbCardBox = await card.boundingBox();
      assert.ok(Math.abs(wbCardBox.x - workbenchBox.x) <= 1, "terminal left edge aligns with workbench");
      assert.ok(Math.abs(wbCardBox.width - workbenchBox.width) <= 1, "terminal width aligns with workbench");
      assert.ok(wbCardBox.y >= workbenchBox.y + workbenchBox.height, "docked terminal sits below workbench");

      // Switch to Conversation 2: terminal stays open with the same single PTY session.
      await page.locator(`[data-run-id="${runA2.runId}"]`).click();
      await page.waitForTimeout(100);
      assert.equal(await dock.isVisible(), true, "terminal must stay open when switching conversations");
      const callsAfterConvSwitch = await page.evaluate(() => window.__terminalTest.calls);
      assert.equal(callsAfterConvSwitch.filter((c) => c.cmd === "terminal_create").length, 1);
      assert.equal(callsAfterConvSwitch.filter((c) => c.cmd === "terminal_kill").length, 0);

      // 4. Green maximize button expands terminal to match the exact workbench bounds & 18px radius.
      // First measure full-height workbench bounds when terminal is minimized vs maximized.
      await page.locator('[data-terminal-action="minimize"]').click();
      assert.equal(await dock.isVisible(), false, "yellow minimize button must hide the terminal card");
      const callsAfterMin = await page.evaluate(() => window.__terminalTest.calls);
      assert.equal(callsAfterMin.filter((c) => c.cmd === "terminal_kill").length, 0,
        "minimize must NOT kill the terminal PTY");
      assert.equal(await page.locator(".prompt-box-terminal-dot").count(), 1,
        "minimized terminal retains active session dot on composer button");

      const fullWorkbenchBox = await page.locator(".workbench").boundingBox();

      // Restore via composer terminal button -> still same single PTY session.
      await page.locator('[data-testid="composer-terminal-toggle"]').click();
      await dock.waitFor({ state: "visible" });
      assert.equal(
        (await page.evaluate(() => window.__terminalTest.calls)).filter((c) => c.cmd === "terminal_create").length,
        1,
      );

      // Click green maximize button -> matches fullWorkbenchBox exact geometry and 18px radius!
      await page.locator('[data-terminal-action="maximize"]').click();
      assert.equal(await dock.getAttribute("data-terminal-mode"), "maximized");
      const maxCardBox = await card.boundingBox();
      assert.ok(Math.abs(maxCardBox.x - fullWorkbenchBox.x) <= 1, `max x (${maxCardBox.x}) matches workbench x (${fullWorkbenchBox.x})`);
      assert.ok(Math.abs(maxCardBox.y - fullWorkbenchBox.y) <= 1, `max y (${maxCardBox.y}) matches workbench y (${fullWorkbenchBox.y})`);
      assert.ok(Math.abs(maxCardBox.width - fullWorkbenchBox.width) <= 1, `max width (${maxCardBox.width}) matches workbench width (${fullWorkbenchBox.width})`);
      assert.ok(Math.abs(maxCardBox.height - fullWorkbenchBox.height) <= 1, `max height (${maxCardBox.height}) matches workbench height (${fullWorkbenchBox.height})`);
      assert.equal(await card.evaluate((el) => getComputedStyle(el).borderRadius), workbenchRadius);

      // Click green button again -> restores docked height.
      await page.locator('[data-terminal-action="maximize"]').click();
      assert.equal(await dock.getAttribute("data-terminal-mode"), "open");

      // 5. Switching workspace hides workspace-alpha's terminal and scopes a separate terminal to workspace-beta.
      await page.locator("button.project-workspace-item", { hasText: "workspace-beta" }).click();
      await page.waitForTimeout(100);
      assert.equal(await page.locator('[data-testid="workspace-terminal-dock"]').count(), 0,
        "workspace-beta should not display workspace-alpha's terminal");
      assert.equal(
        (await page.evaluate(() => window.__terminalTest.calls)).filter((c) => c.cmd === "terminal_kill").length,
        0,
        "switching workspaces keeps workspace-alpha's terminal alive for when returning",
      );

      // Open workspace-beta's own terminal.
      await page.locator('[data-testid="composer-terminal-toggle"]').click();
      await page.locator('[data-testid="workspace-terminal-card"]').waitFor({ state: "visible" });
      const callsAfterBeta = await page.evaluate(() => window.__terminalTest.calls);
      const creates = callsAfterBeta.filter((c) => c.cmd === "terminal_create");
      assert.equal(creates.length, 2);
      assert.equal(creates[0].args.workspacePath, repoA);
      assert.equal(creates[1].args.workspacePath, repoB);

      // Red close button kills workspace-beta's terminal PTY and removes its card.
      await page.locator('[data-testid="workspace-terminal-card"] [data-terminal-action="close"]').click();
      assert.equal(await page.locator('[data-testid="workspace-terminal-dock"]').count(), 0);
      const callsAfterKillBeta = await page.evaluate(() => window.__terminalTest.calls);
      const kills = callsAfterKillBeta.filter((c) => c.cmd === "terminal_kill");
      assert.equal(kills.length, 1);
      assert.equal(kills[0].args.sessionId, "pty-2");

      // Switching back to workspace-alpha restores workspace-alpha's terminal immediately without spawning a 3rd PTY.
      await page.locator("button.project-workspace-item", { hasText: "workspace-alpha" }).click();
      await page.locator('[data-testid="workspace-terminal-card"]').waitFor({ state: "visible" });
      const callsAfterReturn = await page.evaluate(() => window.__terminalTest.calls);
      assert.equal(callsAfterReturn.filter((c) => c.cmd === "terminal_create").length, 2);

      // Red close kills workspace-alpha's terminal too.
      await page.locator('[data-testid="workspace-terminal-card"] [data-terminal-action="close"]').click();
      assert.equal(await page.locator('[data-testid="workspace-terminal-dock"]').count(), 0);
      const finalKills = (await page.evaluate(() => window.__terminalTest.calls)).filter((c) => c.cmd === "terminal_kill");
      assert.equal(finalKills.length, 2);
      assert.equal(finalKills[1].args.sessionId, "pty-1");

      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}

test("desktop terminal animates open, maximize, restore, minimize, and close with macOS traffic-light glyphs", async () => {
  const { context, page, pageErrors } = await setupDesktopPage({
    platform: "macos",
    tauriMode: true,
    reducedMotion: "no-preference",
  });
  try {
    // 1. Open plays a live Web Animation on the dock and settles cleanly.
    await page.locator('[data-testid="composer-terminal-toggle"]').click();
    const dock = page.locator('[data-testid="workspace-terminal-dock"]');
    const card = page.locator('[data-testid="workspace-terminal-card"]');
    await card.waitFor({ state: "visible" });
    const openAnimCount = await dock.evaluate((el) => el.getAnimations().length);
    assert.ok(openAnimCount > 0, "opening terminal must run a live animation");
    await page.waitForTimeout(340);

    // Verify authentic macOS expand traffic-light icon (two solid triangles).
    const expandPaths = await card.locator('[data-terminal-action="maximize"] [data-traffic-glyph="expand"] path').count();
    assert.equal(expandPaths, 2, "expand button must render macOS two-triangle glyph");

    // 2. Maximize plays a live height animation on the card and switches glyph to restore.
    await card.locator('[data-terminal-action="maximize"]').click();
    const maxAnimCount = await card.evaluate((el) => el.getAnimations().length);
    assert.ok(maxAnimCount > 0, "maximizing terminal must run a live animation");
    const restorePaths = await card.locator('[data-terminal-action="maximize"] [data-traffic-glyph="restore"] path').count();
    assert.equal(restorePaths, 2, "maximized button must render macOS inward two-triangle glyph");
    await page.waitForTimeout(360);

    // 3. Restore plays a live height animation back down to docked height.
    await card.locator('[data-terminal-action="maximize"]').click();
    const restoreAnimCount = await card.evaluate((el) => el.getAnimations().length);
    assert.ok(restoreAnimCount > 0, "restoring terminal must run a live animation");
    await page.waitForTimeout(360);

    // 4. Minimize plays a live collapse animation and then hides without killing PTY.
    await card.locator('[data-terminal-action="minimize"]').click();
    const minAnimCount = await dock.evaluate((el) => el.getAnimations().length);
    assert.ok(minAnimCount > 0, "minimizing terminal must run a live animation");
    await page.waitForTimeout(320);
    assert.equal(await dock.isVisible(), false, "dock hides once minimize animation finishes");
    assert.equal(
      (await page.evaluate(() => window.__terminalTest.calls)).filter((c) => c.cmd === "terminal_kill").length,
      0,
    );

    // Restore again, then red close kills PTY immediately and animates out before unmount.
    await page.locator('[data-testid="composer-terminal-toggle"]').click();
    await card.waitFor({ state: "visible" });
    await page.waitForTimeout(340);

    await card.locator('[data-terminal-action="close"]').click();
    // PTY kill fires immediately before the exit animation even completes.
    const killsDuringExit = (await page.evaluate(() => window.__terminalTest.calls)).filter((c) => c.cmd === "terminal_kill");
    assert.equal(killsDuringExit.length, 1);
    const closeAnimCount = await dock.evaluate((el) => el.getAnimations().length);
    assert.ok(closeAnimCount > 0, "closing terminal must run a live exit animation");
    await page.waitForTimeout(340);
    assert.equal(await page.locator('[data-testid="workspace-terminal-dock"]').count(), 0,
      "dock unmounts cleanly after close animation finishes");

    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});
