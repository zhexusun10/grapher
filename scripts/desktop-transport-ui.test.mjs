import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

let server;
let browser;
let origin;

const repository = "/desktop-transport-project";
const config = {
  repository,
  model: "test/model",
  thinkingLevel: "off",
  maxParallel: 2,
  maxFeedback: 3,
  autoApprove: false,
};
const info = { path: repository, name: "DesktopTransport", branch: "main", clean: true, head: "" };
const empty = {
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
const fast = {
  ...empty,
  runId: "run-desktop-1",
  config,
  phase: "completed",
  graph: { ...empty.graph, originalGoal: "Desktop transport conversation" },
};
const bootstrap = {
  config,
  snapshot: fast,
  runs: [fast.runId],
  conversations: [{
    runId: fast.runId,
    repository,
    title: fast.graph.originalGoal,
    phase: fast.phase,
    planType: "serial",
    hasActiveExecutions: false,
  }],
  repositoryInfo: info,
  dataPath: "/mock/desktop-data",
  envOverrides: {},
};
const catalog = {
  providers: [{ id: "test", name: "Test", methods: [{ id: "api_key", name: "API Key" }], configured: true, authType: "api_key" }],
  warning: null,
  models: [{
    provider: "test",
    id: "model",
    name: "Test Model",
    api: "mock",
    contextWindow: 1000,
    available: true,
    thinkingLevels: ["off", "high"],
    thinkingLevelFallbacks: {},
  }],
};

before(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-desktop-transport",
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

async function setupContext({
  tauriMode = false,
  platformOverride = null,
  initialBackendResult = null,
  initialHostPreflight = null,
  recheckHostPreflight = null,
  autostartConfig = null,
  saveConfigError = null,
  initialWindowShowFailures = 0,
  reducedMotion = "reduce",
} = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    locale: "en-US",
    reducedMotion,
  });

  await context.addInitScript(({ tauriMode, platformOverride, initialBackendResult, repository, autostartConfig, initialWindowShowFailures }) => {
    if (platformOverride) {
      Object.defineProperty(navigator, "platform", { value: platformOverride.platform, configurable: true });
      Object.defineProperty(navigator, "userAgent", { value: platformOverride.userAgent, configurable: true });
      Object.defineProperty(navigator, "userAgentData", {
        value: { platform: platformOverride.uaPlatform },
        configurable: true,
      });
    }
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_projects", JSON.stringify([{
      id: repository,
      path: repository,
      name: "DesktopTransport",
      lastOpened: 1,
    }]));

    const eventSources = [];
    class SpyEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      constructor(url) {
        this.url = url;
        this.readyState = SpyEventSource.CONNECTING;
        this.closed = false;
        this.onopen = null;
        this.onerror = null;
        this._listeners = new Map();
        eventSources.push(this);
        setTimeout(() => {
          if (this.closed) return;
          this.readyState = SpyEventSource.OPEN;
          this.onopen?.({});
        }, 0);
      }
      addEventListener(type, listener) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(listener);
      }
      close() {
        this.closed = true;
        this.readyState = SpyEventSource.CLOSED;
      }
    }
    window.EventSource = SpyEventSource;
    window.__TEST_EVENT_SOURCES__ = eventSources;

    if (tauriMode) {
      const invokedCommands = [];
      let pendingResolvers = [];
      let nextMode = initialBackendResult;
      const autostartState = {
        enabled: Boolean(autostartConfig?.initialEnabled),
        failEnable: autostartConfig?.failEnable ?? null,
        failDisable: autostartConfig?.failDisable ?? null,
        failRead: autostartConfig?.failRead ?? null,
        holdRead: Boolean(autostartConfig?.holdRead),
        pendingReads: [],
        calls: { is_enabled: 0, enable: 0, disable: 0 },
      };
      window.__TEST_TAURI__ = {
        invokedCommands,
        autostart: autostartState,
        setAutostart(patch) {
          Object.assign(autostartState, patch);
        },
        resolveAutostartReads(value) {
          const items = autostartState.pendingReads;
          autostartState.pendingReads = [];
          for (const item of items) item.resolve(value ?? autostartState.enabled);
        },
        setNextResult(spec) {
          nextMode = spec;
        },
        resolvePending(url) {
          const items = pendingResolvers;
          pendingResolvers = [];
          for (const item of items) item.resolve(url);
        },
        rejectPending(message) {
          const items = pendingResolvers;
          pendingResolvers = [];
          for (const item of items) item.reject(message);
        },
      };
      window.isTauri = true;
      const windowState = {
        fullscreen: false,
        maximized: false,
        calls: [],
        shownShells: [],
        showAttempts: 0,
        showFailuresRemaining: initialWindowShowFailures,
      };
      window.__TEST_WINDOW__ = {
        state: windowState,
        setFullscreen(value) {
          windowState.fullscreen = Boolean(value);
          window.dispatchEvent(new Event("resize"));
        },
      };
      window.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main", windowLabel: "main" },
        },
        invoke(cmd) {
          invokedCommands.push(cmd);
          if (cmd === "plugin:window|show") {
            windowState.showAttempts += 1;
            if (windowState.showFailuresRemaining > 0) {
              windowState.showFailuresRemaining -= 1;
              return Promise.reject("Window IPC temporarily unavailable");
            }
            windowState.shownShells.push({
              shellMounted: Boolean(document.querySelector(".app-shell.is-tauri-windows")),
              titlebarMounted: Boolean(document.querySelector(".desktop-titlebar.is-windows")),
              inset: getComputedStyle(document.documentElement).getPropertyValue("--desktop-titlebar-inset").trim(),
            });
            return Promise.resolve(null);
          }
          if (cmd === "plugin:window|is_fullscreen") {
            return Promise.resolve(windowState.fullscreen);
          }
          if (cmd === "plugin:window|is_maximized") {
            return Promise.resolve(windowState.maximized);
          }
          if (cmd === "plugin:window|minimize") {
            windowState.calls.push("minimize");
            return Promise.resolve(null);
          }
          if (cmd === "plugin:window|toggle_maximize") {
            windowState.calls.push("toggle_maximize");
            windowState.maximized = !windowState.maximized;
            return Promise.resolve(null);
          }
          if (cmd === "plugin:window|close") {
            windowState.calls.push("close");
            return Promise.resolve(null);
          }
          if (autostartConfig && cmd === "plugin:autostart|is_enabled") {
            autostartState.calls.is_enabled += 1;
            if (autostartState.holdRead) {
              return new Promise((resolve, reject) => {
                autostartState.pendingReads.push({ resolve, reject });
              });
            }
            if (autostartState.failRead) return Promise.reject(autostartState.failRead);
            return Promise.resolve(autostartState.enabled);
          }
          if (autostartConfig && cmd === "plugin:autostart|enable") {
            autostartState.calls.enable += 1;
            if (autostartState.failEnable) return Promise.reject(autostartState.failEnable);
            autostartState.enabled = true;
            return Promise.resolve(null);
          }
          if (autostartConfig && cmd === "plugin:autostart|disable") {
            autostartState.calls.disable += 1;
            if (autostartState.failDisable) return Promise.reject(autostartState.failDisable);
            autostartState.enabled = false;
            return Promise.resolve(null);
          }
          if (cmd === "take_pending_notification_click") {
            return Promise.resolve(null);
          }
          if (cmd !== "backend_url") {
            return Promise.reject(`Unexpected IPC command: ${cmd}`);
          }
          if (nextMode?.kind === "pending") {
            return new Promise((resolve, reject) => {
              pendingResolvers.push({ resolve, reject });
            });
          }
          if (nextMode?.kind === "queue") {
            const entry = nextMode.items.length > 1 ? nextMode.items.shift() : nextMode.items[0];
            return entry.ok ? Promise.resolve(entry.value) : Promise.reject(entry.error);
          }
          if (nextMode?.kind === "error") {
            return Promise.reject(nextMode.error);
          }
          return Promise.resolve(nextMode?.value ?? "http://127.0.0.1:45123");
        },
      };
    }
  }, { tauriMode, platformOverride, initialBackendResult, repository, autostartConfig, initialWindowShowFailures });

  const requests = [];
  const pageErrors = [];

  await context.route("**/api/*", async route => {
    const req = route.request();
    const url = req.url();
    const reqOrigin = req.headers()["origin"] || "*";
    const corsHeaders = {
      "Access-Control-Allow-Origin": reqOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Expose-Headers": "X-Grapher-Events",
    };
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    const parsed = new URL(url);
    const command = parsed.pathname.slice(5);
    requests.push({ url, origin: parsed.origin, pathname: parsed.pathname, command });
    if (command === "save_config" && saveConfigError) {
      await route.fulfill({
        status: 500,
        headers: { ...corsHeaders, "X-Grapher-Events": "1" },
        json: { error: saveConfigError },
      });
      return;
    }
    const defaults = {
      bootstrap: initialHostPreflight ? { ...bootstrap, hostPreflight: initialHostPreflight } : bootstrap,
      host_preflight: recheckHostPreflight ?? { gitAvailable: true, gitPath: "/usr/bin/git", platform: "macos", xcodeCltMissing: false },
      history: fast,
      snapshot: fast,
      load_run: fast,
      snapshot_if_changed: { version: "v1", snapshot: null },
      repository_status: { repository, valid: true, error: null },
      list_plannings: [],
      list_files: { files: [] },
      list_skills: { skills: [] },
      provider_auth: catalog,
      pi_extensions: { globalDirectory: "/mock/extensions", extensions: [] },
      extension_command: { instance: "standalone", commands: [] },
      environment_capabilities: { platform: "macos", arch: "aarch64", nativeWorkspace: true },
    };
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders, "X-Grapher-Events": "1" },
      json: { result: defaults[command] ?? null },
    });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(20_000);
  page.on("pageerror", error => pageErrors.push(String(error)));

  return { context, page, requests, pageErrors };
}

test("browser mode keeps relative /api URLs, SSE path, localStorage settings, and zero desktop status UI", async () => {
  const { context, page, requests, pageErrors } = await setupContext({ tauriMode: false });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__TEST_EVENT_SOURCES__.some(es => es.readyState === 1));

    // No desktop readiness UI or desktop Tauri titlebar chrome in ordinary browser mode.
    assert.equal(await page.locator('[data-testid="desktop-backend-status"]').count(), 0);
    assert.equal(await page.locator(".app-shell.is-tauri-macos").count(), 0);
    assert.equal(await page.locator(".app-shell.is-tauri-windows").count(), 0);
    assert.equal(await page.locator(".desktop-titlebar").count(), 0);
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--desktop-titlebar-inset").trim()),
      "0px",
    );

    // Open Settings to trigger provider_auth and pi_extensions calls.
    await page.getByRole("button", { name: "Settings" }).click();
    await page.waitForFunction(() => true);
    await page.waitForSelector(".modal-content, [role='dialog']");
    await page.waitForTimeout(150);

    // Confirm browser-mode Settings surfaces unavailable notices for both desktop-only cards
    // (Launch at login & Software Update) without Tauri globals or interactive desktop toggles.
    assert.equal(await page.evaluate(() => Boolean(window.isTauri || window.__TAURI_INTERNALS__ || window.__TAURI__)), false);
    assert.equal(await page.locator('[data-testid="autostart-toggle"]').count(), 0);
    assert.equal(await page.locator(".autostart-settings .autostart-settings-browser").count(), 1);
    assert.match(await page.locator(".autostart-settings").textContent() || "", /Launch at login is only available in the Grapher desktop app/);
    assert.match(await page.locator(".update-settings").textContent() || "", /In-app updates are only available in the Grapher desktop app/);

    const commands = new Set(requests.map(r => r.command));
    assert.ok(commands.has("bootstrap"), "bootstrap ran");
    assert.ok(commands.has("provider_auth"), "provider_auth ran");
    assert.ok(commands.has("pi_extensions"), "pi_extensions ran");
    assert.ok(requests.every(r => r.origin === origin), `expected all browser requests on ${origin}, got ${requests.map(r => r.url).join(", ")}`);

    const eventSourceUrls = await page.evaluate(() => window.__TEST_EVENT_SOURCES__.map(es => es.url));
    assert.deepEqual(eventSourceUrls, ["/api/events"]);

    const storedDataPath = await page.evaluate(() => localStorage.getItem("grapher_data_path"));
    assert.equal(storedDataPath, "/mock/desktop-data");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

for (const platformOverride of [
  { platform: "Win32", uaPlatform: "Windows", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  { platform: "MacIntel", uaPlatform: "macOS", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
]) {
  test(`${platformOverride.uaPlatform} startup stays quiet while awaiting backend_url, routes all requests and SSE to dynamic port, and preserves localStorage`, async () => {
    const dynamicOrigin = "http://127.0.0.1:45123";
    const { context, page, requests, pageErrors } = await setupContext({
      tauriMode: true,
      platformOverride,
      initialBackendResult: { kind: "pending" },
    });
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" });

      const statusBanner = page.locator('[data-testid="desktop-backend-status"]');
      await page.waitForFunction(() => window.__TEST_TAURI__.invokedCommands.includes("backend_url"));
      await page.locator(".desktop-titlebar").waitFor({ state: "visible" });
      if (platformOverride.uaPlatform === "Windows") {
        // A pending backend must not strand the initially hidden Windows shell.
        await page.waitForFunction(() => window.__TEST_WINDOW__.state.shownShells.length === 1);
        assert.deepEqual(await page.evaluate(() => window.__TEST_WINDOW__.state.shownShells), [{
          shellMounted: true,
          titlebarMounted: true,
          inset: "32px",
        }]);
      } else {
        assert.deepEqual(await page.evaluate(() => window.__TEST_WINDOW__.state.shownShells), []);
      }

      // Before backend_url resolves, zero /api requests or EventSource connections may fire.
      await page.waitForTimeout(150);
      assert.equal(await statusBanner.count(), 0, "pending backend connection must not show a loading banner");
      assert.equal(requests.length, 0);
      assert.equal(await page.evaluate(() => window.__TEST_EVENT_SOURCES__.length), 0);

      // Resolve narrow backend_url IPC.
      await page.evaluate(url => window.__TEST_TAURI__.resolvePending(url), dynamicOrigin);
      await statusBanner.waitFor({ state: "hidden" });
      await page.waitForFunction(() => window.__TEST_EVENT_SOURCES__.some(es => es.readyState === 1));

      const nonPluginCommands = await page.evaluate(
        () => window.__TEST_TAURI__.invokedCommands.filter(
          cmd => !cmd.startsWith("plugin:") && cmd !== "take_pending_notification_click",
        ),
      );
      assert.deepEqual(nonPluginCommands, ["backend_url"]);

      // Open Settings to verify provider_auth and pi_extensions also hit the dynamic backend.
      await page.getByRole("button", { name: "Settings" }).click();
      await page.waitForSelector(".modal-content, [role='dialog']");
      await page.waitForTimeout(150);

      const commands = new Set(requests.map(r => r.command));
      assert.ok(commands.has("bootstrap"), "bootstrap ran against dynamic backend");
      assert.ok(commands.has("provider_auth"), "provider_auth ran against dynamic backend");
      assert.ok(commands.has("pi_extensions"), "pi_extensions ran against dynamic backend");
      assert.ok(
        requests.every(r => r.origin === dynamicOrigin),
        `expected all Tauri requests on ${dynamicOrigin}, got ${requests.map(r => r.url).join(", ")}`,
      );

      const backendUrlCalls = await page.evaluate(
        () => window.__TEST_TAURI__.invokedCommands.filter(cmd => cmd === "backend_url"),
      );
      assert.deepEqual(backendUrlCalls, ["backend_url"]);

      const eventSourceUrls = await page.evaluate(() => window.__TEST_EVENT_SOURCES__.map(es => es.url));
      assert.deepEqual(eventSourceUrls, [`${dynamicOrigin}/api/events`]);

      const storedDataPath = await page.evaluate(() => localStorage.getItem("grapher_data_path"));
      assert.equal(storedDataPath, "/mock/desktop-data");
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}

test("Windows startup retries transient window IPC failures with animations enabled while backend IPC remains pending", async () => {
  const { context, page, requests, pageErrors } = await setupContext({
    tauriMode: true,
    platformOverride: { platform: "Win32", uaPlatform: "Windows", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    initialBackendResult: { kind: "pending" },
    initialWindowShowFailures: 2,
    reducedMotion: "no-preference",
  });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__TEST_WINDOW__.state.shownShells.length === 1);
    assert.deepEqual(await page.evaluate(() => ({
      attempts: window.__TEST_WINDOW__.state.showAttempts,
      shells: window.__TEST_WINDOW__.state.shownShells,
    })), { attempts: 3, shells: [{ shellMounted: true, titlebarMounted: true, inset: "32px" }] });
    assert.equal(requests.length, 0, "window reveal must not depend on backend IPC");
    assert.equal(await page.locator('[data-testid="desktop-backend-status"]').count(), 0);

    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => window.__TEST_WINDOW__.state.showAttempts), 3, "successful reveal stops retries even after window events");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("Windows startup stops retrying persistent window IPC failures without unhandled rejections", async () => {
  const { context, page, pageErrors } = await setupContext({
    tauriMode: true,
    platformOverride: { platform: "Win32", uaPlatform: "Windows", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    initialWindowShowFailures: 99,
  });
  const diagnostics = [];
  page.on("console", message => {
    if (message.type() === "error" && message.text().includes("Failed to show the Grapher window")) diagnostics.push(message.text());
  });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__TEST_WINDOW__.state.showAttempts === 3);
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => window.__TEST_WINDOW__.state.showAttempts), 3);
    assert.equal(diagnostics.length, 1, "failure is diagnosed once; native watchdog handles the fallback");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("Tauri mode surfaces closed backend feedback with Retry recovery and reconnects SSE to a rotated backend URL", async () => {
  const firstOrigin = "http://127.0.0.1:45124";
  const rotatedOrigin = "http://127.0.0.1:45125";
  const { context, page, requests, pageErrors } = await setupContext({
    tauriMode: true,
    platformOverride: { platform: "Win32", uaPlatform: "Windows", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    initialBackendResult: {
      kind: "error",
      error: "Grapher backend exited before becoming ready (exit status: 1).",
    },
  });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });

    const statusBanner = page.locator('[data-testid="desktop-backend-status"]');
    await statusBanner.waitFor({ state: "visible" });
    assert.equal(await statusBanner.getAttribute("data-phase"), "error");
    await page.waitForFunction(() => window.__TEST_WINDOW__.state.shownShells.length === 1);
    const errorText = await statusBanner.textContent() || "";
    assert.match(errorText, /The desktop backend stopped running: Grapher backend exited before becoming ready/);
    assert.doesNotMatch(errorText, /npm run backend/);
    // No duplicate generic floating error banner for the same desktop readiness failure.
    assert.equal(
      await page.locator(".floating-error-banner").count(),
      0,
      `unexpected floating error banner: ${await page.locator(".floating-error-banner").allTextContents()}`,
    );

    // Recover via Retry button once backend_url starts resolving.
    await page.evaluate(url => window.__TEST_TAURI__.setNextResult({ kind: "ok", value: url }), firstOrigin);
    await statusBanner.getByRole("button", { name: "Retry" }).click();
    await statusBanner.waitFor({ state: "hidden" });
    await page.waitForFunction(() => window.__TEST_EVENT_SOURCES__.some(es => es.readyState === 1));

    assert.ok(requests.some(r => r.origin === firstOrigin && r.command === "bootstrap"));
    assert.deepEqual(
      await page.evaluate(() => window.__TEST_EVENT_SOURCES__.map(es => es.url)),
      [`${firstOrigin}/api/events`],
    );

    // Simulate mid-session SSE disconnect while backend_url transiently rejects once then rotates ports.
    await page.evaluate(nextUrl => {
      window.__TEST_TAURI__.setNextResult({
        kind: "queue",
        items: [
          { ok: false, error: "backend restarting" },
          { ok: true, value: nextUrl },
        ],
      });
      const current = window.__TEST_EVENT_SOURCES__.at(-1);
      current.readyState = 0; // CONNECTING (as WebKit/WebView2 emits on TCP drop)
      current.onerror?.({});
    }, rotatedOrigin);

    await page.waitForFunction(
      expected => window.__TEST_EVENT_SOURCES__.some(es => es.url === expected && es.readyState === 1),
      `${rotatedOrigin}/api/events`,
      { timeout: 6_000 },
    );

    const esSummary = await page.evaluate(() => window.__TEST_EVENT_SOURCES__.map(es => ({
      url: es.url,
      closed: es.closed,
      readyState: es.readyState,
    })));
    assert.deepEqual(esSummary, [
      { url: `${firstOrigin}/api/events`, closed: true, readyState: 2 },
      { url: `${rotatedOrigin}/api/events`, closed: false, readyState: 1 },
    ]);
    assert.equal(await statusBanner.count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("first launch displays actionable Git / Xcode Command Line Tools diagnostic when host Git is absent and clears after Re-check", async () => {
  const { context, page, requests, pageErrors } = await setupContext({
    tauriMode: true,
    initialBackendResult: { kind: "ok", value: "http://127.0.0.1:45126" },
    initialHostPreflight: {
      gitAvailable: false,
      gitError: "Git is required by Grapher, but macOS /usr/bin/git is an uninstalled Xcode Command Line Tools shim; run `xcode-select --install` or install Git from https://git-scm.com/download/mac.",
      xcodeCltMissing: true,
      platform: "macos",
    },
    recheckHostPreflight: {
      gitAvailable: true,
      gitPath: "/opt/homebrew/bin/git",
      xcodeCltMissing: false,
      platform: "macos",
    },
  });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    const preflightBanner = page.locator('[data-testid="host-preflight-status"]');
    await preflightBanner.waitFor({ state: "visible" });
    const text = await preflightBanner.textContent() || "";
    assert.match(text, /xcode-select --install/);
    assert.match(text, /Xcode Command Line Tools/);

    await preflightBanner.getByRole("button", { name: "Re-check" }).click();
    await preflightBanner.waitFor({ state: "hidden" });
    assert.ok(requests.some(r => r.command === "host_preflight"));
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("macOS and Windows Tauri render an independent desktop titlebar above background, collapse in fullscreen, and keep modals below the safe area", async () => {
  const mac = await setupContext({
    tauriMode: true,
    platformOverride: {
      platform: "MacIntel",
      uaPlatform: "macOS",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    },
    initialBackendResult: { kind: "ok", value: "http://127.0.0.1:45127" },
  });
  try {
    await mac.page.goto(origin, { waitUntil: "domcontentloaded" });
    await mac.page.locator(".app-shell.is-tauri-macos").waitFor({ state: "visible" });
    const titlebar = mac.page.locator(".desktop-titlebar.is-macos");
    await titlebar.waitFor({ state: "visible" });
    await mac.page.locator(".desktop-titlebar-drag-region.macos-titlebar-drag-region[data-tauri-drag-region]").waitFor({ state: "visible" });
    assert.equal(await mac.page.locator(".desktop-window-controls").count(), 0);

    const macLayout = await mac.page.evaluate(() => {
      const bar = document.querySelector(".desktop-titlebar");
      const bgStage = document.querySelector(".app-background-root > .relative");
      const sidebar = document.querySelector(".sidebar");
      const barCs = bar ? getComputedStyle(bar) : null;
      return {
        barHeight: barCs?.height,
        barBorderBottomWidth: barCs?.borderBottomWidth,
        barBackgroundColor: barCs?.backgroundColor,
        barBottom: bar?.getBoundingClientRect().bottom,
        bgStageTop: bgStage?.getBoundingClientRect().top,
        sidebarTop: sidebar?.getBoundingClientRect().top,
        sidebarMarginTop: sidebar ? getComputedStyle(sidebar).marginTop : null,
        insetVar: getComputedStyle(document.documentElement).getPropertyValue("--desktop-titlebar-inset").trim(),
      };
    });
    assert.equal(macLayout.barHeight, "32px");
    assert.equal(macLayout.barBorderBottomWidth, "0px");
    assert.equal(macLayout.barBackgroundColor, "rgb(255, 255, 255)");
    assert.equal(macLayout.barBottom, 32);
    assert.equal(macLayout.bgStageTop, 32, "landing background starts below the independent titlebar instead of being clipped");
    assert.equal(macLayout.sidebarTop, 32, "macOS sidebar sits directly beneath the 32px overlay titlebar without a redundant 12px top margin");
    assert.equal(macLayout.sidebarMarginTop, "0px");
    assert.equal(macLayout.insetVar, "32px");

    // Modal backdrop reserves top padding below the 32px titlebar safe area.
    await mac.page.getByRole("button", { name: "Settings" }).click();
    await mac.page.locator(".modal-backdrop").waitFor({ state: "visible" });
    const modalTopPadding = await mac.page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.querySelector(".modal-backdrop")).paddingTop),
    );
    assert.ok(modalTopPadding >= 48, `expected modal backdrop paddingTop >= 48px, got ${modalTopPadding}`);
    await mac.page.keyboard.press("Escape");
    await mac.page.locator(".modal-backdrop").waitFor({ state: "hidden" });

    // Entering macOS fullscreen collapses the titlebar and resets the inset to 0px.
    await mac.page.evaluate(() => window.__TEST_WINDOW__.setFullscreen(true));
    await titlebar.waitFor({ state: "hidden" });
    const fullscreenLayout = await mac.page.evaluate(() => {
      const sidebar = document.querySelector(".sidebar");
      return {
        bgStageTop: document.querySelector(".app-background-root > .relative")?.getBoundingClientRect().top,
        sidebarTop: sidebar?.getBoundingClientRect().top,
        sidebarMarginTop: sidebar ? getComputedStyle(sidebar).marginTop : null,
        insetVar: getComputedStyle(document.documentElement).getPropertyValue("--desktop-titlebar-inset").trim(),
      };
    });
    assert.equal(fullscreenLayout.bgStageTop, 0);
    assert.equal(fullscreenLayout.sidebarTop, 12, "macOS fullscreen restores the 12px sidebar top margin");
    assert.equal(fullscreenLayout.sidebarMarginTop, "12px");
    assert.equal(fullscreenLayout.insetVar, "0px");

    // Leaving macOS fullscreen can fire `resize` while NSWindowStyleMaskFullScreen
    // is still set, then clear the flag once the Space animation finishes without
    // emitting another resize. The titlebar and inset must still recover.
    await mac.page.evaluate(() => {
      window.dispatchEvent(new Event("resize"));
      setTimeout(() => { window.__TEST_WINDOW__.state.fullscreen = false; }, 200);
    });
    await titlebar.waitFor({ state: "visible" });
    const restoredLayout = await mac.page.evaluate(() => {
      const sidebar = document.querySelector(".sidebar");
      return {
        bgStageTop: document.querySelector(".app-background-root > .relative")?.getBoundingClientRect().top,
        sidebarTop: sidebar?.getBoundingClientRect().top,
        sidebarMarginTop: sidebar ? getComputedStyle(sidebar).marginTop : null,
        insetVar: getComputedStyle(document.documentElement).getPropertyValue("--desktop-titlebar-inset").trim(),
      };
    });
    assert.equal(restoredLayout.bgStageTop, 32);
    assert.equal(restoredLayout.sidebarTop, 32);
    assert.equal(restoredLayout.sidebarMarginTop, "0px");
    assert.equal(restoredLayout.insetVar, "32px");
    assert.deepEqual(mac.pageErrors, []);
  } finally {
    await mac.context.close();
  }

  const win = await setupContext({
    tauriMode: true,
    platformOverride: {
      platform: "Win32",
      uaPlatform: "Windows",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
    initialBackendResult: { kind: "ok", value: "http://127.0.0.1:45128" },
  });
  try {
    await win.page.goto(origin, { waitUntil: "domcontentloaded" });
    await win.page.locator(".app-shell.is-tauri-windows").waitFor({ state: "visible" });
    const winTitlebar = win.page.locator(".desktop-titlebar.is-windows");
    await winTitlebar.waitFor({ state: "visible" });
    await win.page.locator(".desktop-titlebar-drag-region[data-tauri-drag-region]").waitFor({ state: "visible" });
    assert.equal(await win.page.locator(".app-shell.is-tauri-macos").count(), 0);
    assert.equal(await win.page.locator(".desktop-window-control").count(), 3);

    const winLayout = await win.page.evaluate(() => {
      const bar = document.querySelector(".desktop-titlebar");
      const sidebar = document.querySelector(".sidebar");
      const barCs = bar ? getComputedStyle(bar) : null;
      const sidebarCs = sidebar ? getComputedStyle(sidebar) : null;
      return {
        barHeight: barCs?.height,
        barBackgroundColor: barCs?.backgroundColor,
        sidebarBackgroundColor: sidebarCs?.backgroundColor,
        bgStageTop: document.querySelector(".app-background-root > .relative")?.getBoundingClientRect().top,
        sidebarTop: sidebar?.getBoundingClientRect().top,
        sidebarMarginTop: sidebarCs?.marginTop ?? null,
        insetVar: getComputedStyle(document.documentElement).getPropertyValue("--desktop-titlebar-inset").trim(),
      };
    });
    assert.equal(winLayout.barHeight, "32px");
    assert.equal(winLayout.barBackgroundColor, winLayout.sidebarBackgroundColor, "Windows titlebar matches the sidebar surface color");
    assert.equal(winLayout.barBackgroundColor, "rgb(249, 249, 250)");
    assert.equal(winLayout.bgStageTop, 32);
    assert.equal(winLayout.sidebarTop, 44, "Windows keeps the 12px sidebar top margin below its bordered titlebar");
    assert.equal(winLayout.sidebarMarginTop, "12px");
    assert.equal(winLayout.insetVar, "32px");

    await win.page.locator('[data-window-action="minimize"]').click();
    await win.page.locator('[data-window-action="toggle-maximize"]').click();
    await win.page.locator('[data-window-action="close"]').click();
    await win.page.waitForFunction(() => window.__TEST_WINDOW__.state.calls.length === 3);
    const calls = await win.page.evaluate(() => window.__TEST_WINDOW__.state.calls);
    assert.deepEqual(calls, ["minimize", "toggle_maximize", "close"]);

    // Entering fullscreen on Windows also collapses the titlebar.
    await win.page.evaluate(() => window.__TEST_WINDOW__.setFullscreen(true));
    await winTitlebar.waitFor({ state: "hidden" });
    assert.equal(await win.page.evaluate(() => window.__TEST_WINDOW__.state.shownShells.length), 1, "window state changes must not reveal the window again");
    assert.deepEqual(win.pageErrors, []);
  } finally {
    await win.context.close();
  }
});

test("SettingsModal launch-at-login reads OS state, survives unrelated config save failure, rolls back errors, and cleans up on close", async () => {
  const { context, page, pageErrors } = await setupContext({
    tauriMode: true,
    initialBackendResult: { kind: "ok", value: "http://127.0.0.1:45129" },
    autostartConfig: { initialEnabled: false },
    saveConfigError: "Simulated unrelated backend config failure",
  });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__TEST_EVENT_SOURCES__.some(es => es.readyState === 1));

    // Open Settings and verify initial OS registration (false) is read without localStorage.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const toggle = page.getByRole("checkbox", { name: /Launch at login/ });
    await toggle.waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="autostart-toggle"]');
      return el && !el.disabled;
    });
    assert.equal(await toggle.isChecked(), false);

    // Enable launch-at-login immediately via OS plugin without flashing a transient status row.
    await toggle.check();
    assert.equal(await page.locator(".autostart-settings-status").count(), 0);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="autostart-toggle"]');
      return el && !el.disabled && el.getAttribute("aria-busy") !== "true" && el.checked === true;
    });
    assert.equal(await page.evaluate(() => window.__TEST_TAURI__.autostart.enabled), true);

    // Trigger an unrelated config save failure: OS preference must NOT be lost.
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-save-error").waitFor({ state: "visible" });
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await page.evaluate(() => window.__TEST_TAURI__.autostart.enabled), true);

    // Simulate OS disable error: toggle must roll back to checked and display visible alert.
    await page.evaluate(() => window.__TEST_TAURI__.setAutostart({ failDisable: "Permission denied removing Login Item" }));
    await toggle.click();
    const alert = page.locator(".autostart-settings-alert[role='alert']");
    await alert.waitFor({ state: "visible" });
    assert.match(await alert.textContent() || "", /Permission denied/);
    assert.equal(await toggle.isChecked(), true, "failed disable must roll back checkbox to OS state");

    // Clear failure, disable cleanly, and verify OS state.
    await page.evaluate(() => window.__TEST_TAURI__.setAutostart({ failDisable: null }));
    await toggle.uncheck();
    assert.equal(await page.locator(".autostart-settings-status").count(), 0);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="autostart-toggle"]');
      return el && !el.disabled && el.getAttribute("aria-busy") !== "true" && el.checked === false;
    });
    assert.equal(await page.evaluate(() => window.__TEST_TAURI__.autostart.enabled), false);

    // Close modal (Cancel) and reopen with a held OS read to verify unmount/close race cleanup.
    await page.locator(".settings-cancel-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });

    const callsBeforeCloseHold = await page.evaluate(() => ({ ...window.__TEST_TAURI__.autostart.calls }));
    await page.evaluate(() => window.__TEST_TAURI__.setAutostart({ holdRead: true }));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await toggle.waitFor({ state: "visible" });
    assert.equal(await toggle.isDisabled(), true, "toggle stays disabled while OS state is loading");

    // Close modal before the OS read resolves, then resolve the late promise while closed.
    await page.locator(".settings-cancel-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await page.evaluate(() => window.__TEST_TAURI__.resolveAutostartReads(true));
    await page.waitForTimeout(100);

    // No enable/disable mutations may fire while the modal is closed.
    const callsAfterClosedResolve = await page.evaluate(() => ({ ...window.__TEST_TAURI__.autostart.calls }));
    assert.equal(callsAfterClosedResolve.enable, callsBeforeCloseHold.enable);
    assert.equal(callsAfterClosedResolve.disable, callsBeforeCloseHold.disable);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});
