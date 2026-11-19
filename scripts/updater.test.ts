import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppUpdaterController,
  classifyUpdaterError,
  detectDesktopPlatform,
  formatUpdaterBytes,
  isTauriDesktop,
  isWindowsInstallerHandoffTeardownError,
  type UpdateHandle,
  type UpdaterDownloadEvent,
  type UpdaterDriver,
  type UpdaterPlatform,
  type UpdaterSnapshot,
} from "../src/services/updater.ts";
import { UpdateSettings } from "../src/components/UpdateSettings.tsx";
import { UpdateBanner } from "../src/components/UpdateBanner.tsx";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeMockHandle(overrides: Partial<UpdateHandle> = {}): UpdateHandle & {
  closedCount: number;
  downloadCalls: number;
  installCalls: number;
} {
  const handle = {
    currentVersion: "1.9.9",
    version: "2.0.0",
    date: "2026-11-19T12:00:00Z",
    body: "- Faster Graph scheduling\n- Signed desktop auto-updates",
    closedCount: 0,
    downloadCalls: 0,
    installCalls: 0,
    async download(
      onEvent?: (event: UpdaterDownloadEvent) => void,
      options?: { signal?: AbortSignal },
    ) {
      handle.downloadCalls += 1;
      if (overrides.download) {
        return overrides.download(onEvent, options);
      }
      onEvent?.({ event: "Started", data: { contentLength: 1000 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 400 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 600 } });
      onEvent?.({ event: "Finished" });
    },
    async install(options?: { restartAfterInstall?: boolean }) {
      handle.installCalls += 1;
      if (overrides.install) {
        return overrides.install(options);
      }
    },
    async close() {
      handle.closedCount += 1;
      if (overrides.close) {
        return overrides.close();
      }
    },
  };
  if (overrides.currentVersion !== undefined) handle.currentVersion = overrides.currentVersion;
  if (overrides.version !== undefined) handle.version = overrides.version;
  if (overrides.date !== undefined) handle.date = overrides.date;
  if (overrides.body !== undefined) handle.body = overrides.body;
  return handle;
}

function makeMockDriver(overrides: Partial<UpdaterDriver> = {}): UpdaterDriver & {
  checkCalls: number;
  relaunchCalls: number;
  versionCalls: number;
} {
  const driver = {
    checkCalls: 0,
    relaunchCalls: 0,
    versionCalls: 0,
    isSupported: () => true,
    getPlatform: (): UpdaterPlatform => overrides.getPlatform ? overrides.getPlatform() : "macos",
    async getCurrentVersion() {
      driver.versionCalls += 1;
      return overrides.getCurrentVersion ? overrides.getCurrentVersion() : "1.9.9";
    },
    async check(options?: { timeout?: number }) {
      driver.checkCalls += 1;
      return overrides.check ? overrides.check(options) : null;
    },
    async relaunch() {
      driver.relaunchCalls += 1;
      if (overrides.relaunch) return overrides.relaunch();
    },
  };
  if (overrides.isSupported) driver.isSupported = overrides.isSupported;
  return driver;
}

test("browser mode without Tauri globals stays unsupported, never calls Tauri APIs, and renders safely", async () => {
  assert.equal(isTauriDesktop({}), false);
  assert.equal(isTauriDesktop(null), false);
  assert.equal(isTauriDesktop({ isTauri: true }), true);
  assert.equal(isTauriDesktop({ __TAURI_INTERNALS__: { invoke: () => {} } }), true);
  assert.equal(isTauriDesktop({ __TAURI__: { core: { invoke: () => {} } } }), true);
  // Node/browser environment has no Tauri globals.
  assert.equal(isTauriDesktop(), false);

  const driver = makeMockDriver({ isSupported: () => false });
  const controller = new AppUpdaterController(driver);
  assert.equal(controller.getSnapshot().supported, false);
  assert.equal(controller.getSnapshot().status, "unsupported");

  const cancelStartup = controller.scheduleStartupCheck(0);
  cancelStartup();
  await controller.hydrateCurrentVersion();
  await controller.checkForUpdates({ silent: false });
  await controller.installAndRestart();
  controller.cancelDownload();
  await controller.retry();
  assert.equal(driver.checkCalls, 0);
  assert.equal(driver.versionCalls, 0);
  assert.equal(driver.relaunchCalls, 0);

  const settingsHtml = renderToStaticMarkup(createElement(UpdateSettings, { controller }));
  assert.ok(settingsHtml.includes("GitHub Releases"), settingsHtml);
  assert.ok(!settingsHtml.includes("update-settings-check-btn"), "browser mode does not render desktop check button");

  const bannerHtml = renderToStaticMarkup(
    createElement(UpdateBanner, {
      snapshot: controller.getSnapshot(),
      onOpenSettings: () => {},
      onInstallAndRestart: () => {},
      onCancelDownload: () => {},
      onRestart: () => {},
      onDismiss: () => {},
    }),
  );
  assert.equal(bannerHtml, "", "browser mode never renders an update banner");
  controller.dispose();
});

test("silent startup check is deferred without blocking first render and cancels cleanly on unmount", async () => {
  const scheduled: Array<{ cb: () => void; delay: number; cleared: boolean }> = [];
  const driver = makeMockDriver({ check: async () => null });
  const controller = new AppUpdaterController(driver, {
    setTimer(cb, delay) {
      const entry = { cb, delay, cleared: false };
      scheduled.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(handle) {
      (handle as unknown as { cleared: boolean }).cleared = true;
    },
  });

  const cleanup = controller.scheduleStartupCheck(1500);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1500);
  assert.equal(driver.checkCalls, 0, "startup check must not block initial render");

  // Unmounting before the timer fires cancels it without making a request.
  cleanup();
  assert.equal(scheduled[0].cleared, true);
  assert.equal(driver.checkCalls, 0);

  // Rescheduling after early cleanup fires once and completes silently.
  controller.scheduleStartupCheck(100);
  assert.equal(scheduled.length, 2);
  scheduled[1].cb();
  // Wait for async check to finish.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(driver.checkCalls, 1);
  assert.equal(controller.getSnapshot().status, "up-to-date");
  assert.equal(controller.getSnapshot().lastCheckSilent, true);
  assert.equal(controller.getSnapshot().startupCheckCompleted, true);
  controller.dispose();
});

test("no-update state transitions cleanly, closes prior handles, and renders up-to-date status", async () => {
  const firstHandle = makeMockHandle({ version: "2.0.0" });
  let nextResult: UpdateHandle | null = firstHandle;
  const driver = makeMockDriver({
    check: async () => nextResult,
  });
  const controller = new AppUpdaterController(driver, { now: () => 1_700_000_000_000 });

  await controller.checkForUpdates({ silent: false });
  assert.equal(controller.getSnapshot().status, "available");
  assert.equal(firstHandle.closedCount, 0);

  nextResult = null;
  const snap = await controller.checkForUpdates({ silent: false });
  assert.equal(snap.status, "up-to-date");
  assert.equal(snap.availableUpdate, null);
  assert.equal(snap.currentVersion, "1.9.9");
  assert.equal(snap.lastCheckedAt, 1_700_000_000_000);
  assert.equal(firstHandle.closedCount, 1, "previous Update handle must be closed on refresh");

  const html = renderToStaticMarkup(createElement(UpdateSettings, { controller }));
  assert.ok(html.includes("v1.9.9"), html);
  controller.dispose();
});

test("download progress (deterministic and indeterminate) and one-click install-and-restart via process plugin", async () => {
  const observedProgress: Array<{ downloaded: number; total: number | null; percent: number | null }> = [];
  const observedStatuses: string[] = [];
  const handle = makeMockHandle({
    currentVersion: "1.9.9",
    version: "2.1.0",
    body: "- Parallel graph improvements\n- Native desktop updater",
    async download(onEvent) {
      onEvent?.({ event: "Started", data: { contentLength: 2_000_000 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 500_000 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 1_000_000 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 500_000 } });
      onEvent?.({ event: "Finished" });
    },
  });
  const driver = makeMockDriver({ check: async () => handle });
  const controller = new AppUpdaterController(driver);

  let lastProgress: UpdaterSnapshot["progress"] = null;
  const unsubscribe = controller.subscribe(() => {
    const snap = controller.getSnapshot();
    if (observedStatuses.at(-1) !== snap.status) {
      observedStatuses.push(snap.status);
    }
    if (snap.status === "downloading" && snap.progress && snap.progress !== lastProgress) {
      lastProgress = snap.progress;
      observedProgress.push({
        downloaded: snap.progress.downloadedBytes,
        total: snap.progress.totalBytes,
        percent: snap.progress.percent,
      });
    }
  });

  await controller.checkForUpdates({ silent: false });
  assert.equal(controller.getSnapshot().status, "available");

  // Verify settings and banner render current/latest versions and release notes.
  const availableHtml = renderToStaticMarkup(createElement(UpdateSettings, { controller }));
  assert.ok(availableHtml.includes("v1.9.9"), availableHtml);
  assert.ok(availableHtml.includes("v2.1.0"), availableHtml);
  assert.ok(availableHtml.includes("Parallel graph improvements"), availableHtml);

  const bannerHtml = renderToStaticMarkup(
    createElement(UpdateBanner, {
      snapshot: controller.getSnapshot(),
      onOpenSettings: () => {},
      onInstallAndRestart: () => {},
      onCancelDownload: () => {},
      onRestart: () => {},
      onDismiss: () => {},
    }),
  );
  assert.ok(bannerHtml.includes("v2.1.0"), bannerHtml);

  await controller.installAndRestart();
  unsubscribe();

  assert.deepEqual(observedStatuses, [
    "checking",
    "available",
    "downloading",
    "installing",
    "restarting",
  ]);
  assert.deepEqual(
    observedProgress.map(p => p.percent),
    [null, 0, 25, 75, 100, 100],
  );
  assert.equal(handle.downloadCalls, 1);
  assert.equal(handle.installCalls, 1);
  assert.equal(handle.closedCount, 1, "macOS install must release the Update resource before relaunching");
  assert.equal(driver.relaunchCalls, 1);
  assert.equal(controller.getSnapshot().status, "restarting");
  assert.equal(formatUpdaterBytes(0), "0 B");
  assert.equal(formatUpdaterBytes(1536), "1.5 KB");
  assert.equal(formatUpdaterBytes(2_097_152), "2.0 MB");

  // Indeterminate contentLength (unknown total bytes) stays well-formed.
  const indeterminateDeferred = createDeferred<void>();
  const indHandle = makeMockHandle({
    version: "2.2.0",
    async download(onEvent) {
      onEvent?.({ event: "Started", data: {} });
      onEvent?.({ event: "Progress", data: { chunkLength: 65_536 } });
      await indeterminateDeferred.promise;
      onEvent?.({ event: "Finished" });
    },
  });
  const indController = new AppUpdaterController(makeMockDriver({ check: async () => indHandle }));
  await indController.checkForUpdates({ silent: false });
  const pending = indController.installAndRestart();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(indController.getSnapshot().status, "downloading");
  assert.deepEqual(indController.getSnapshot().progress, {
    downloadedBytes: 65_536,
    totalBytes: null,
    percent: null,
  });
  const downloadingHtml = renderToStaticMarkup(createElement(UpdateSettings, { controller: indController }));
  assert.ok(downloadingHtml.includes("is-indeterminate"), downloadingHtml);
  assert.ok(downloadingHtml.includes("64.0 KB"), downloadingHtml);

  indeterminateDeferred.resolve();
  await pending;
  assert.equal(indController.getSnapshot().status, "restarting");

  controller.dispose();
  indController.dispose();
});

test("cancelling download detaches progress updates, closes handle, skips install, and supports clean retry", async () => {
  let attempt = 0;
  let capturedOnEvent: ((event: UpdaterDownloadEvent) => void) | undefined;
  const firstHandle = makeMockHandle({
    version: "2.0.1",
    download(onEvent, options) {
      capturedOnEvent = onEvent;
      return new Promise<void>((resolve, reject) => {
        onEvent?.({ event: "Started", data: { contentLength: 1000 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 200 } });
        options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    },
  });
  const secondHandle = makeMockHandle({ version: "2.0.1" });
  const driver = makeMockDriver({
    check: async () => (++attempt === 1 ? firstHandle : secondHandle),
  });
  const controller = new AppUpdaterController(driver);

  await controller.checkForUpdates({ silent: false });
  const downloadPromise = controller.installAndRestart();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(controller.getSnapshot().status, "downloading");
  assert.equal(controller.getSnapshot().progress?.percent, 20);

  controller.cancelDownload();
  // Late chunks emitted after cancel must be ignored.
  capturedOnEvent?.({ event: "Progress", data: { chunkLength: 700 } });
  const afterCancel = await downloadPromise;

  assert.equal(afterCancel.status, "available");
  assert.equal(afterCancel.downloadCancelled, true);
  assert.equal(afterCancel.progress, null);
  assert.equal(firstHandle.installCalls, 0, "cancelled download must never install");
  assert.equal(firstHandle.closedCount, 1, "cancelled download must release Rust resource");
  assert.equal(driver.relaunchCalls, 0);

  // Retry fetches a fresh handle and completes download + install + relaunch.
  const afterRetry = await controller.retry();
  assert.equal(afterRetry.status, "restarting");
  assert.equal(secondHandle.downloadCalls, 1);
  assert.equal(secondHandle.installCalls, 1);
  assert.equal(driver.relaunchCalls, 1);
  controller.dispose();
});

test("cancelling a non-abortable transfer enters cancelling, blocks duplicates, and never installs when it settles", async () => {
  const transferDone = createDeferred<void>();
  let emitProgress: ((event: UpdaterDownloadEvent) => void) | undefined;
  const handle = makeMockHandle({
    version: "2.0.2",
    async download(onEvent) {
      emitProgress = onEvent;
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 30 } });
      await transferDone.promise;
    },
  });
  const driver = makeMockDriver({ check: async () => handle });
  const controller = new AppUpdaterController(driver);
  await controller.checkForUpdates({ silent: false });

  const inFlight = controller.installAndRestart();
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.cancelDownload();
  assert.equal(controller.getSnapshot().status, "cancelling");
  assert.equal(controller.getSnapshot().canCancelDownload, false);

  // While settling, concurrent check or download attempts must not fire.
  await controller.checkForUpdates({ silent: false });
  assert.equal(driver.checkCalls, 1);
  emitProgress?.({ event: "Progress", data: { chunkLength: 70 } });

  transferDone.resolve();
  const settled = await inFlight;
  assert.equal(settled.status, "available");
  assert.equal(settled.downloadCancelled, true);
  assert.equal(handle.installCalls, 0);
  assert.equal(handle.closedCount, 1);
  assert.equal(driver.relaunchCalls, 0);
  controller.dispose();
});

test("errors classify unsigned CI builds, signature mismatches, network failures, download/install/restart failures cleanly", async () => {
  assert.equal(
    classifyUpdaterError(
      new Error("None of the fallback platforms `[\"darwin-aarch64-app\", \"darwin-aarch64\"]` were found in the response `platforms` object"),
      "check",
    ).kind,
    "unsigned-unavailable",
  );
  assert.equal(
    classifyUpdaterError(new Error("Could not fetch a valid release JSON from the remote"), "check").kind,
    "unsigned-unavailable",
  );
  assert.equal(
    classifyUpdaterError(new Error("minisign verify failed: invalid signature"), "download").kind,
    "signature",
  );
  // Real `tauri-plugin-updater` + `minisign-verify` Display error strings
  assert.equal(
    classifyUpdaterError(
      new Error("The update was signed for version 1.9.8 but the update endpoint announced version 2.0.0. The endpoint response may have been tampered with to force installing a different release."),
      "download",
    ).kind,
    "signature",
  );
  assert.equal(
    classifyUpdaterError(
      new Error("The update signature does not specify the version it was signed for, which `requireSignedVersion` requires."),
      "download",
    ).kind,
    "signature",
  );
  assert.equal(
    classifyUpdaterError(new Error("Invalid encoding in minisign data"), "download").kind,
    "signature",
  );
  assert.equal(
    classifyUpdaterError(
      new Error("The signature was created with a different key than the one provided"),
      "download",
    ).kind,
    "signature",
  );
  // Malformed manifests must not be misclassified as unsigned-unavailable
  assert.equal(
    classifyUpdaterError(new Error("missing field `version` at line 1 column 2"), "check").kind,
    "unknown",
  );
  assert.equal(
    classifyUpdaterError(new Error("invalid value for `pub_date`: invalid date"), "check").kind,
    "unknown",
  );
  assert.equal(
    classifyUpdaterError(new Error("error sending request for url: timed out"), "check").kind,
    "network",
  );

  // Silent check hitting unsigned CI release keeps main UpdateBanner completely hidden.
  const unsignedDriver = makeMockDriver({
    check: async () => {
      throw new Error("None of the fallback platforms were found in the response `platforms` object");
    },
  });
  const unsignedController = new AppUpdaterController(unsignedDriver);
  await unsignedController.checkForUpdates({ silent: true });
  assert.equal(unsignedController.getSnapshot().status, "error");
  assert.equal(unsignedController.getSnapshot().error?.kind, "unsigned-unavailable");
  assert.equal(
    renderToStaticMarkup(
      createElement(UpdateBanner, {
        snapshot: unsignedController.getSnapshot(),
        onOpenSettings: () => {},
        onInstallAndRestart: () => {},
        onCancelDownload: () => {},
        onRestart: () => {},
        onDismiss: () => {},
      }),
    ),
    "",
    "unsigned CI error must not pop a floating banner",
  );
  const unsignedHtml = renderToStaticMarkup(createElement(UpdateSettings, { controller: unsignedController }));
  assert.ok(unsignedHtml.includes("is-warning"), unsignedHtml);
  assert.ok(unsignedHtml.includes("GitHub Releases"), unsignedHtml);
  unsignedController.dispose();

  // Download failure preserves availableUpdate and allows retrying directly.
  let failDownload = true;
  const flakyHandle = makeMockHandle({
    version: "2.3.0",
    async download(onEvent) {
      if (failDownload) throw new Error("connection reset by peer");
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      onEvent?.({ event: "Finished" });
    },
  });
  let failRelaunch = true;
  const flakyDriver = makeMockDriver({
    check: async () => flakyHandle,
    async relaunch() {
      if (failRelaunch) throw new Error("permission denied launching app");
    },
  });
  const flakyController = new AppUpdaterController(flakyDriver);
  await flakyController.checkForUpdates({ silent: false });
  await flakyController.installAndRestart();
  assert.equal(flakyController.getSnapshot().status, "error");
  assert.equal(flakyController.getSnapshot().error?.kind, "network");
  assert.equal(flakyController.getSnapshot().error?.phase, "download");
  assert.equal(flakyController.getSnapshot().availableUpdate?.version, "2.3.0");

  // Retry download -> succeeds -> install succeeds -> relaunch fails -> transitions to ready-to-restart.
  failDownload = false;
  await flakyController.retry();
  assert.equal(flakyController.getSnapshot().status, "ready-to-restart");
  assert.equal(flakyController.getSnapshot().error?.kind, "restart");
  assert.equal(flakyHandle.installCalls, 1);

  // Retry from ready-to-restart calls relaunch without re-downloading or re-installing.
  failRelaunch = false;
  await flakyController.retry();
  assert.equal(flakyController.getSnapshot().status, "restarting");
  assert.equal(flakyHandle.downloadCalls, 2);
  assert.equal(flakyHandle.installCalls, 1);
  assert.equal(flakyDriver.relaunchCalls, 2);
  flakyController.dispose();
});

test("enforces single concurrent check and single concurrent download, and cleans up listeners on unsubscribe/dispose", async () => {
  const checkGate = createDeferred<UpdateHandle | null>();
  const downloadGate = createDeferred<void>();
  const handle = makeMockHandle({
    version: "2.4.0",
    async download(onEvent) {
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      await downloadGate.promise;
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      onEvent?.({ event: "Finished" });
    },
  });
  const driver = makeMockDriver({
    check: () => checkGate.promise,
  });
  const controller = new AppUpdaterController(driver);

  let notifications = 0;
  const unsub = controller.subscribe(() => {
    notifications += 1;
  });

  // Two overlapping checks share one underlying request; manual check promotes silent flag.
  const c1 = controller.checkForUpdates({ silent: true });
  const c2 = controller.checkForUpdates({ silent: false });
  assert.equal(driver.checkCalls, 1);
  assert.equal(controller.getSnapshot().lastCheckSilent, false);
  checkGate.resolve(handle);
  await Promise.all([c1, c2]);
  assert.equal(controller.getSnapshot().status, "available");

  // Two overlapping downloads share one underlying download/install/relaunch flow.
  const d1 = controller.installAndRestart();
  const d2 = controller.installAndRestart();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(handle.downloadCalls, 1);

  // Unsubscribing stops receiving further updates.
  const countBeforeUnsub = notifications;
  unsub();
  downloadGate.resolve();
  await Promise.all([d1, d2]);
  assert.equal(notifications, countBeforeUnsub);
  assert.equal(handle.downloadCalls, 1);
  assert.equal(handle.installCalls, 1);
  assert.equal(driver.relaunchCalls, 1);

  // Disposing closes any retained handle and stops notifications.
  const closeable = makeMockHandle({ version: "2.5.0" });
  const disposeController = new AppUpdaterController(makeMockDriver({ check: async () => closeable }));
  let disposeCount = 0;
  disposeController.subscribe(() => {
    disposeCount += 1;
  });
  await disposeController.checkForUpdates({ silent: false });
  const beforeDispose = disposeCount;
  disposeController.dispose();
  assert.equal(closeable.closedCount, 1);
  await disposeController.checkForUpdates({ silent: false });
  assert.equal(disposeCount, beforeDispose);
  controller.dispose();
});

test("Windows NSIS install hands off to installer without calling relaunch() and avoids false failure on process teardown", async () => {
  assert.equal(detectDesktopPlatform({ navigator: { platform: "Win32" } }), "windows");
  assert.equal(detectDesktopPlatform({ navigator: { userAgentData: { platform: "Windows" } } }), "windows");
  assert.equal(detectDesktopPlatform({ navigator: { platform: "MacIntel" } }), "macos");
  assert.equal(detectDesktopPlatform({ navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } }), "unknown");
  assert.equal(detectDesktopPlatform({ navigator: { platform: "Linux x86_64" } }), "linux");
  assert.equal(detectDesktopPlatform({}), "unknown");

  assert.equal(isWindowsInstallerHandoffTeardownError(new Error("IPC channel closed")), true);
  assert.equal(isWindowsInstallerHandoffTeardownError(new Error("WebView destroyed before response")), true);
  assert.equal(isWindowsInstallerHandoffTeardownError(new Error("ShellExecuteW failed with code 5")), false);
  assert.equal(isWindowsInstallerHandoffTeardownError(new Error("Access is denied. (os error 5)")), false);
  assert.equal(isWindowsInstallerHandoffTeardownError(new Error("invalid updater binary format")), false);
  assert.equal(isWindowsInstallerHandoffTeardownError(new Error("The signature verification failed")), false);

  // 1. Clean Windows NSIS handoff: install({ restartAfterInstall: true }) resolves without calling relaunch().
  let receivedRestartOption: boolean | undefined;
  const winHandle = makeMockHandle({
    version: "2.6.0",
    async install(options) {
      receivedRestartOption = options?.restartAfterInstall;
    },
  });
  const winDriver = makeMockDriver({
    getPlatform: () => "windows",
    check: async () => winHandle,
    async relaunch() {
      throw new Error("relaunch must never be called on Windows NSIS");
    },
  });
  const winController = new AppUpdaterController(winDriver);
  assert.equal(winController.getSnapshot().platform, "windows");

  await winController.checkForUpdates({ silent: false });
  const afterHandoff = await winController.installAndRestart();
  assert.equal(receivedRestartOption, true);
  assert.equal(afterHandoff.status, "restarting");
  assert.equal(afterHandoff.error, null);
  assert.equal(winHandle.installCalls, 1);
  assert.equal(winHandle.closedCount, 0, "Windows handoff avoids extra close IPC during exit");
  assert.equal(winDriver.relaunchCalls, 0, "Windows NSIS handles restart via /P /UPDATE /R, not process::relaunch");

  const winSettingsHtml = renderToStaticMarkup(createElement(UpdateSettings, { controller: winController }));
  assert.ok(winSettingsHtml.includes("Windows"), winSettingsHtml);
  const winBannerHtml = renderToStaticMarkup(
    createElement(UpdateBanner, {
      snapshot: winController.getSnapshot(),
      onOpenSettings: () => {},
      onInstallAndRestart: () => {},
      onCancelDownload: () => {},
      onRestart: () => {},
      onDismiss: () => {},
    }),
  );
  assert.ok(winBannerHtml.includes("floating-update-banner"), winBannerHtml);
  winController.dispose();

  // 2. WebView2 IPC disconnect after pagehide/beforeunload during Windows NSIS exit must not flash a false failure.
  let triggerTeardown: (() => void) | null = null;
  const teardownHandle = makeMockHandle({
    version: "2.6.1",
    async install() {
      triggerTeardown?.();
      throw new Error("IPC channel closed during window teardown");
    },
  });
  const teardownDriver = makeMockDriver({
    getPlatform: () => "windows",
    check: async () => teardownHandle,
  });
  const teardownController = new AppUpdaterController(teardownDriver, {
    observePageTeardown(cb) {
      triggerTeardown = cb;
      return () => {
        triggerTeardown = null;
      };
    },
  });
  await teardownController.checkForUpdates({ silent: false });
  const afterTeardown = await teardownController.installAndRestart();
  assert.equal(afterTeardown.status, "restarting");
  assert.equal(afterTeardown.error, null);
  assert.equal(teardownDriver.relaunchCalls, 0);
  teardownController.dispose();

  // 3. Real Windows NSIS install failures (e.g. UAC declined / ShellExecuteW / invalid binary / bad signature) still surface as errors.
  const deniedHandle = makeMockHandle({
    version: "2.6.2",
    async install() {
      throw new Error("Access is denied. (os error 5)");
    },
  });
  const deniedController = new AppUpdaterController(
    makeMockDriver({
      getPlatform: () => "windows",
      check: async () => deniedHandle,
    }),
  );
  await deniedController.checkForUpdates({ silent: false });
  const afterDenied = await deniedController.installAndRestart();
  assert.equal(afterDenied.status, "error");
  assert.equal(afterDenied.error?.kind, "install");
  assert.equal(deniedHandle.closedCount, 1);
  deniedController.dispose();

  // 4. Download signature mismatch closes stale handle so retry re-checks the feed cleanly.
  let checkAttempt = 0;
  const badSigHandle = makeMockHandle({
    version: "2.6.3",
    async download() {
      throw new Error("The signature was created with a different key than the one provided");
    },
  });
  const goodHandle = makeMockHandle({ version: "2.6.3" });
  const sigDriver = makeMockDriver({
    getPlatform: () => "macos",
    check: async () => (++checkAttempt === 1 ? badSigHandle : goodHandle),
  });
  const sigController = new AppUpdaterController(sigDriver);
  await sigController.checkForUpdates({ silent: false });
  const afterBadSig = await sigController.installAndRestart();
  assert.equal(afterBadSig.status, "error");
  assert.equal(afterBadSig.error?.kind, "signature");
  assert.equal(badSigHandle.closedCount, 1, "signature failure must discard stale update handle");
  const afterSigRetry = await sigController.retry();
  assert.equal(sigDriver.checkCalls, 2, "retrying after signature failure must re-check latest.json");
  assert.equal(afterSigRetry.status, "restarting");
  assert.equal(goodHandle.installCalls, 1);
  assert.equal(sigDriver.relaunchCalls, 1);
  sigController.dispose();
});
