import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopBackendError,
  getCachedApiUrl,
  getDesktopBackendState,
  invalidateBackendBaseUrl,
  isMacosTauriDesktop,
  isTauriDesktop,
  normalizeBackendBaseUrl,
  resetApiBaseForTest,
  resolveApiUrl,
  resolveBackendBaseUrl,
  subscribeDesktopBackendState,
} from "../src/services/apiBase.ts";
import { runtimeService } from "../src/services/runtime.ts";
import {
  enableRuntimeEvents,
  RUNTIME_EVENTS_RETRY_MS,
  setRuntimeEventsConnectedForTest,
  subscribeRuntimeEventsStatus,
  subscribeSnapshotChanges,
  type RuntimeEventsStatus,
} from "../src/services/runtimeEvents.ts";
import { piExtensions } from "../src/services/piExtensions.ts";
import { providerAuth } from "../src/services/providerAuth.ts";
import { defaultConfig, emptySnapshot } from "../src/types.ts";

type TauriGlobal = typeof globalThis & {
  isTauri?: boolean;
  __TAURI_INTERNALS__?: {
    invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  __TAURI__?: {
    core?: {
      invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState = MockEventSource.CONNECTING;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    let bucket = this.listeners.get(type);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(type, bucket);
    }
    bucket.add(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }

  emitOpen(): void {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.({} as Event);
  }

  emitError(nextReadyState = MockEventSource.CONNECTING): void {
    this.readyState = nextReadyState;
    this.onerror?.({} as Event);
  }

  emitEvent(type: string, data: unknown): void {
    const bucket = this.listeners.get(type);
    if (!bucket) return;
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const listener of bucket) listener(event);
  }
}

function clearTauriGlobals(): void {
  const host = globalThis as TauriGlobal;
  delete host.isTauri;
  delete host.__TAURI_INTERNALS__;
  delete host.__TAURI__;
  resetApiBaseForTest();
}

function installTauriInvoke(
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): void {
  const host = globalThis as TauriGlobal;
  host.isTauri = true;
  host.__TAURI_INTERNALS__ = { invoke };
  delete host.__TAURI__;
  resetApiBaseForTest();
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

const jsonResponse = (result: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });

const validProviderCatalog = {
  providers: [{ id: "openai", name: "OpenAI", methods: [{ id: "api_key", name: "API Key" }], configured: true, authType: "api_key" }],
  models: [{
    provider: "openai",
    id: "gpt-5",
    name: "GPT-5",
    api: "responses",
    contextWindow: 128000,
    available: true,
    thinkingLevels: ["off", "high"],
    thinkingLevelFallbacks: {},
  }],
  warning: null,
};

test("browser mode retains exact relative /api URLs across all services without invoking IPC", async () => {
  clearTauriGlobals();
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  MockEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;

  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "/api/plan_goal_stream") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: complete\ndata: ${JSON.stringify({ snapshot: emptySnapshot })}\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (url === "/api/get_workspace_image") {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }
    if (url === "/api/pi_extensions") {
      return jsonResponse({ globalDirectory: "/ext", extensions: [] });
    }
    if (url === "/api/provider_auth") {
      return jsonResponse(validProviderCatalog);
    }
    return jsonResponse(emptySnapshot, { "x-grapher-events": "1" });
  }) as typeof fetch;

  const unsub = subscribeSnapshotChanges(() => {});
  try {
    assert.equal(isTauriDesktop(), false);
    assert.deepEqual(getDesktopBackendState(), {
      isDesktop: false,
      phase: "browser",
      baseUrl: null,
      error: null,
      closed: false,
    });
    assert.equal(getCachedApiUrl("/api/events"), "/api/events");
    assert.equal(await resolveApiUrl("/api/bootstrap"), "/api/bootstrap");

    await runtimeService.snapshot();
    await runtimeService.planGoalStream("Ship desktop", defaultConfig, () => {});
    const blob = await runtimeService.getWorkspaceImage("run-1", "img.png");
    assert.equal(blob.size, 4);
    await piExtensions.catalog(true);
    providerAuth.setCachedCatalog(null);
    await providerAuth.catalog(true);

    assert.deepEqual(requestedUrls, [
      "/api/snapshot",
      "/api/plan_goal_stream",
      "/api/get_workspace_image",
      "/api/pi_extensions",
      "/api/provider_auth",
    ]);
    assert.equal(MockEventSource.instances.length, 1);
    assert.equal(MockEventSource.instances[0].url, "/api/events");

    // Browser network error copy stays unchanged.
    globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    await assert.rejects(
      runtimeService.snapshot(),
      error => error instanceof Error && !(error instanceof DesktopBackendError) && /npm run backend/.test(error.message),
    );
  } finally {
    unsub();
    setRuntimeEventsConnectedForTest(false);
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { EventSource: unknown }).EventSource = originalEventSource;
    clearTauriGlobals();
  }
});

test("Tauri mode waits for narrow backend_url IPC once and routes every service call to the dynamic origin", async () => {
  const originalFetch = globalThis.fetch;
  const commands: string[] = [];
  const requestedUrls: string[] = [];
  const observedPhases: string[] = [];
  let resolveIpc!: (url: string) => void;

  installTauriInvoke(cmd => {
    commands.push(cmd);
    return new Promise<string>(resolve => {
      resolveIpc = resolve;
    });
  });

  const unsubState = subscribeDesktopBackendState(() => {
    observedPhases.push(getDesktopBackendState().phase);
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/api/plan_goal_stream")) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: complete\ndata: ${JSON.stringify({ snapshot: emptySnapshot })}\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.endsWith("/api/get_workspace_image")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "image/webp" },
      });
    }
    if (url.endsWith("/api/pi_extensions")) {
      return jsonResponse({ globalDirectory: "/ext", extensions: [] });
    }
    if (url.endsWith("/api/provider_auth")) {
      return jsonResponse(validProviderCatalog);
    }
    return jsonResponse(emptySnapshot);
  }) as typeof fetch;

  try {
    assert.equal(isTauriDesktop(), true);
    assert.equal(getCachedApiUrl("/api/bootstrap"), null);
    assert.equal(getDesktopBackendState().phase, "connecting");

    providerAuth.setCachedCatalog(null);
    const pendingSnapshot = runtimeService.snapshot();
    const pendingImage = runtimeService.getWorkspaceImage("run-1", "a.webp");
    const pendingExtensions = piExtensions.catalog(true);
    const pendingProviders = providerAuth.catalog(true);

    await flushMicrotasks();
    // No fetch may fire before backend_url resolves, and concurrent calls share one IPC call.
    assert.deepEqual(commands, ["backend_url"]);
    assert.deepEqual(requestedUrls, []);

    resolveIpc("http://127.0.0.1:54321/");
    const [, imageBlob] = await Promise.all([
      pendingSnapshot,
      pendingImage,
      pendingExtensions,
      pendingProviders,
    ]);
    assert.equal(imageBlob.size, 3);

    // Subsequent streaming call reuses the cached dynamic origin without re-invoking IPC.
    await runtimeService.planGoalStream("Stream in desktop", defaultConfig, () => {});

    assert.deepEqual(commands, ["backend_url"]);
    assert.deepEqual(requestedUrls.sort(), [
      "http://127.0.0.1:54321/api/get_workspace_image",
      "http://127.0.0.1:54321/api/pi_extensions",
      "http://127.0.0.1:54321/api/plan_goal_stream",
      "http://127.0.0.1:54321/api/provider_auth",
      "http://127.0.0.1:54321/api/snapshot",
    ]);
    assert.equal(getDesktopBackendState().phase, "ready");
    assert.equal(getDesktopBackendState().baseUrl, "http://127.0.0.1:54321");
    assert.ok(observedPhases.includes("ready"));
  } finally {
    unsubState();
    globalThis.fetch = originalFetch;
    clearTauriGlobals();
  }
});

test("backend URL validation rejects non-loopback or malformed URLs and classifies not-ready vs closed errors", async () => {
  assert.equal(normalizeBackendBaseUrl("http://127.0.0.1:41234/"), "http://127.0.0.1:41234");
  assert.equal(normalizeBackendBaseUrl("http://localhost:41234"), "http://localhost:41234");
  for (const invalid of [
    "",
    "not-a-url",
    "https://example.com:443",
    "http://127.0.0.1:0",
    "http://127.0.0.1:54321/api",
    "http://user:pass@127.0.0.1:54321",
    null,
  ]) {
    assert.throws(
      () => normalizeBackendBaseUrl(invalid),
      error => error instanceof DesktopBackendError && error.kind === "invalid_url",
    );
  }

  try {
    // Missing invoke when window.isTauri === true never silently falls back to relative URLs.
    const host = globalThis as TauriGlobal;
    host.isTauri = true;
    delete host.__TAURI_INTERNALS__;
    resetApiBaseForTest();
    await assert.rejects(
      resolveBackendBaseUrl(),
      error => error instanceof DesktopBackendError && error.kind === "ipc_unavailable",
    );

    // Not-ready failure is not permanently cached and recovers on next attempt.
    let attempt = 0;
    installTauriInvoke(async () => {
      attempt++;
      if (attempt === 1) throw "backend initializing";
      return "http://127.0.0.1:49001";
    });
    await assert.rejects(
      resolveBackendBaseUrl(),
      error => error instanceof DesktopBackendError && error.kind === "not_ready",
    );
    assert.equal(getDesktopBackendState().phase, "error");
    assert.equal(getDesktopBackendState().closed, false);

    assert.equal(await resolveBackendBaseUrl(), "http://127.0.0.1:49001");
    assert.equal(getDesktopBackendState().phase, "ready");

    // Closed/exited sidecar is surfaced immediately by bootstrap without extra retries.
    let closedInvokes = 0;
    installTauriInvoke(async () => {
      closedInvokes++;
      throw "Grapher backend exited unexpectedly after startup (exit status: 1).";
    });
    await assert.rejects(
      runtimeService.bootstrap(),
      error => error instanceof DesktopBackendError && error.kind === "closed" && /exited unexpectedly/.test(error.message),
    );
    assert.equal(closedInvokes, 1);
    assert.equal(getDesktopBackendState().phase, "error");
    assert.equal(getDesktopBackendState().closed, true);
  } finally {
    clearTauriGlobals();
  }
});

test("Tauri fetch failure probes backend_url to report closed sidecar or transparently follow a rotated port", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // Case 1: sidecar restarts on a new port; stale-port connection refusal retries on the new port.
    let currentUrl = "http://127.0.0.1:42001";
    installTauriInvoke(async () => currentUrl);
    const seenUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.startsWith("http://127.0.0.1:42001")) {
        currentUrl = "http://127.0.0.1:42002";
        throw new TypeError("Failed to fetch");
      }
      return jsonResponse(emptySnapshot);
    }) as typeof fetch;

    const snap = await runtimeService.snapshot();
    assert.deepEqual(snap, emptySnapshot);
    assert.deepEqual(seenUrls, [
      "http://127.0.0.1:42001/api/snapshot",
      "http://127.0.0.1:42002/api/snapshot",
    ]);
    assert.equal(getDesktopBackendState().baseUrl, "http://127.0.0.1:42002");

    // Case 2: sidecar shuts down mid-session; fetch error surfaces the real closed diagnostic.
    installTauriInvoke(async () => {
      if (seenUrls.length === 2) return "http://127.0.0.1:42002";
      throw "Grapher backend has already shut down.";
    });
    await resolveBackendBaseUrl();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrls.push(String(input));
      throw new TypeError("Load failed");
    }) as typeof fetch;

    await assert.rejects(
      runtimeService.snapshot(),
      error => error instanceof DesktopBackendError && error.kind === "closed" && /already shut down/.test(error.message),
    );
    assert.equal(getDesktopBackendState().phase, "error");
    assert.equal(getDesktopBackendState().closed, true);

    // Case 3: caller abort while waiting for backend_url only rejects the aborted caller.
    let resolvePending!: (url: string) => void;
    installTauriInvoke(() => new Promise<string>(resolve => { resolvePending = resolve; }));
    const controller = new AbortController();
    const aborted = resolveApiUrl("/api/snapshot", controller.signal);
    const sibling = resolveApiUrl("/api/bootstrap");
    controller.abort(new DOMException("Left view", "AbortError"));
    await assert.rejects(aborted, error => error instanceof DOMException && error.name === "AbortError");
    resolvePending("http://127.0.0.1:42003");
    assert.equal(await sibling, "http://127.0.0.1:42003/api/bootstrap");

    // Case 4: long-running planGoalStream probes backend_url when the stream terminates without completion.
    let streamPhase = 0;
    installTauriInvoke(async () => {
      streamPhase++;
      if (streamPhase === 1) return "http://127.0.0.1:42004";
      throw "Grapher backend exited unexpectedly after startup (exit status: 9).";
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      assert.equal(String(input), "http://127.0.0.1:42004/api/plan_goal_stream");
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    await assert.rejects(
      runtimeService.planGoalStream("Long stream", defaultConfig, () => {}),
      error => error instanceof DesktopBackendError && error.kind === "closed" && /exit status: 9/.test(error.message),
    );
    assert.equal(getDesktopBackendState().phase, "error");
    assert.equal(getDesktopBackendState().closed, true);
  } finally {
    globalThis.fetch = originalFetch;
    clearTauriGlobals();
  }
});

test("SSE reconnects cleanly in browser mode using relative /api/events", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  clearTauriGlobals();
  const originalEventSource = globalThis.EventSource;
  MockEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;

  const statuses: RuntimeEventsStatus[] = [];
  const snapshots: string[] = [];
  const unsubStatus = subscribeRuntimeEventsStatus(status => statuses.push(status));
  const unsubSnap = subscribeSnapshotChanges(event => snapshots.push(event.version));
  try {
    enableRuntimeEvents();
    assert.equal(MockEventSource.instances.length, 1);
    assert.equal(MockEventSource.instances[0].url, "/api/events");

    MockEventSource.instances[0].emitOpen();
    await flushMicrotasks();
    assert.deepEqual(statuses.at(-1), { connected: true, reconnected: false });

    MockEventSource.instances[0].emitError(MockEventSource.CLOSED);
    await flushMicrotasks();
    assert.deepEqual(statuses.at(-1), { connected: false, reconnected: false });

    context.mock.timers.tick(RUNTIME_EVENTS_RETRY_MS);
    assert.equal(MockEventSource.instances.length, 2);
    assert.equal(MockEventSource.instances[1].url, "/api/events");

    MockEventSource.instances[1].emitOpen();
    MockEventSource.instances[1].emitEvent("snapshot_changed", { runId: "r1", version: "v2" });
    await flushMicrotasks();
    assert.deepEqual(statuses.at(-1), { connected: true, reconnected: true });
    assert.deepEqual(snapshots, ["v2"]);
  } finally {
    unsubSnap();
    unsubStatus();
    setRuntimeEventsConnectedForTest(false);
    (globalThis as unknown as { EventSource: unknown }).EventSource = originalEventSource;
    clearTauriGlobals();
  }
});

test("SSE in Tauri mode waits for backend_url, avoids orphaned streams on unsubscribe, and re-resolves URL on reconnect", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const originalEventSource = globalThis.EventSource;
  MockEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;

  const statuses: RuntimeEventsStatus[] = [];
  const snapshots: string[] = [];
  const unsubStatus = subscribeRuntimeEventsStatus(status => statuses.push(status));

  try {
    // 1. Unsubscribing while backend_url is still pending must never open an orphaned EventSource.
    let resolveEarly!: (url: string) => void;
    installTauriInvoke(() => new Promise<string>(resolve => { resolveEarly = resolve; }));
    enableRuntimeEvents();
    const unsubEarly = subscribeSnapshotChanges(() => {});
    await flushMicrotasks();
    assert.equal(MockEventSource.instances.length, 0);
    unsubEarly();
    resolveEarly("http://127.0.0.1:43000");
    await flushMicrotasks();
    assert.equal(MockEventSource.instances.length, 0);

    // 2. Connect -> disconnect (even in CONNECTING state) -> temporary not-ready -> reconnect on rotated port.
    invalidateBackendBaseUrl();
    const responses: Array<string | Error> = [
      "http://127.0.0.1:43001",
      new Error("backend restarting"),
      "http://127.0.0.1:43002",
    ];
    let invokeCount = 0;
    installTauriInvoke(async cmd => {
      assert.equal(cmd, "backend_url");
      const next = responses[invokeCount++] ?? "http://127.0.0.1:43002";
      if (next instanceof Error) throw next.message;
      return next;
    });

    const unsubSnap = subscribeSnapshotChanges(event => snapshots.push(event.version));
    try {
      enableRuntimeEvents();
      await flushMicrotasks();
      assert.equal(MockEventSource.instances.length, 1);
      assert.equal(MockEventSource.instances[0].url, "http://127.0.0.1:43001/api/events");

      MockEventSource.instances[0].emitOpen();
      await flushMicrotasks();
      assert.deepEqual(statuses.at(-1), { connected: true, reconnected: false });

      // Simulate TCP disconnect (WebKit/WebView2 emits error with readyState === CONNECTING).
      MockEventSource.instances[0].emitError(MockEventSource.CONNECTING);
      await flushMicrotasks();
      assert.equal(MockEventSource.instances[0].closed, true);
      assert.deepEqual(statuses.at(-1), { connected: false, reconnected: false });

      // First retry hits transient not-ready error; handled cleanly and reschedules.
      context.mock.timers.tick(RUNTIME_EVENTS_RETRY_MS);
      await flushMicrotasks();
      assert.equal(MockEventSource.instances.length, 1);
      assert.equal(getDesktopBackendState().phase, "error");

      // Second retry resolves the new dynamic port and reconnects.
      context.mock.timers.tick(RUNTIME_EVENTS_RETRY_MS);
      await flushMicrotasks();
      assert.equal(MockEventSource.instances.length, 2);
      assert.equal(MockEventSource.instances[1].url, "http://127.0.0.1:43002/api/events");
      assert.equal(getDesktopBackendState().phase, "ready");

      MockEventSource.instances[1].emitOpen();
      MockEventSource.instances[1].emitEvent("snapshot_changed", { runId: "r2", version: "v9" });
      await flushMicrotasks();
      assert.deepEqual(statuses.at(-1), { connected: true, reconnected: true });
      assert.deepEqual(snapshots, ["v9"]);
    } finally {
      unsubSnap();
    }
  } finally {
    unsubStatus();
    setRuntimeEventsConnectedForTest(false);
    (globalThis as unknown as { EventSource: unknown }).EventSource = originalEventSource;
    clearTauriGlobals();
  }
});

test("isMacosTauriDesktop activates only for Tauri desktop on macOS and stays false in browser or Windows Tauri", () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const setNavigator = (value: unknown) => {
    Object.defineProperty(globalThis, "navigator", {
      value,
      configurable: true,
      writable: true,
    });
  };
  try {
    clearTauriGlobals();
    setNavigator({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    assert.equal(isMacosTauriDesktop(), false);

    installTauriInvoke(async () => "http://127.0.0.1:43000");
    assert.equal(isMacosTauriDesktop(), true);

    setNavigator({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    assert.equal(isMacosTauriDesktop(), false);

    setNavigator({ userAgentData: { platform: "macOS" }, platform: "MacIntel", userAgent: "" });
    assert.equal(isMacosTauriDesktop(), true);

    setNavigator({ userAgentData: { platform: "Windows" }, platform: "Win32", userAgent: "" });
    assert.equal(isMacosTauriDesktop(), false);
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
    clearTauriGlobals();
  }
});
