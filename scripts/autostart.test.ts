import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AutostartController,
  classifyAutostartError,
  isTauriDesktop,
  type AutostartDriver,
} from "../src/services/autostart.ts";
import { AutostartSettings } from "../src/components/AutostartSettings.tsx";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeMockDriver(overrides: Partial<AutostartDriver> & { initialEnabled?: boolean } = {}) {
  let osEnabled = overrides.initialEnabled ?? false;
  const calls = {
    isEnabled: 0,
    enable: 0,
    disable: 0,
  };
  const driver: AutostartDriver & {
    calls: typeof calls;
    getOsEnabled: () => boolean;
    setOsEnabled: (value: boolean) => void;
  } = {
    calls,
    getOsEnabled: () => osEnabled,
    setOsEnabled(value: boolean) {
      osEnabled = value;
    },
    isSupported: overrides.isSupported ?? (() => true),
    async isEnabled() {
      calls.isEnabled += 1;
      if (overrides.isEnabled) return overrides.isEnabled();
      return osEnabled;
    },
    async enable() {
      calls.enable += 1;
      if (overrides.enable) {
        await overrides.enable();
        return;
      }
      osEnabled = true;
    },
    async disable() {
      calls.disable += 1;
      if (overrides.disable) {
        await overrides.disable();
        return;
      }
      osEnabled = false;
    },
  };
  return driver;
}

test("browser mode stays unsupported, never calls Tauri APIs or localStorage, and renders unavailable notice", async () => {
  assert.equal(isTauriDesktop({}), false);
  assert.equal(isTauriDesktop(null), false);
  assert.equal(isTauriDesktop({ isTauri: true }), true);
  assert.equal(isTauriDesktop({ __TAURI_INTERNALS__: { invoke: () => {} } }), true);
  assert.equal(isTauriDesktop(), false);

  const driver = makeMockDriver({ isSupported: () => false });
  const controller = new AutostartController(driver);

  assert.equal(controller.getSnapshot().supported, false);
  assert.equal(controller.getSnapshot().status, "unsupported");
  assert.equal(controller.getSnapshot().enabled, false);
  assert.equal(controller.getSnapshot().loading, false);

  await controller.refresh();
  await controller.enable();
  await controller.disable();
  assert.deepEqual(driver.calls, { isEnabled: 0, enable: 0, disable: 0 });

  const html = renderToStaticMarkup(createElement(AutostartSettings, { controller }));
  assert.ok(html.includes("autostart-settings-browser"), html);
  assert.ok(!html.includes('data-testid="autostart-toggle"'), "browser mode must not render an interactive desktop toggle");
  controller.dispose();
});

test("initial state starts loading, reads actual OS registration without localStorage, and renders accessible toggle", async () => {
  const storageReads: string[] = [];
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        storageReads.push(`get:${key}`);
        return "true";
      },
      setItem(key: string) {
        storageReads.push(`set:${key}`);
      },
      removeItem(key: string) {
        storageReads.push(`remove:${key}`);
      },
    },
  });

  try {
    const readGate = createDeferred<boolean>();
    const driver = makeMockDriver({
      isEnabled: () => readGate.promise,
    });
    const controller = new AutostartController(driver);

    assert.equal(controller.getSnapshot().status, "loading");
    assert.equal(controller.getSnapshot().loading, true);
    assert.equal(controller.getSnapshot().loaded, false);
    assert.equal(controller.getSnapshot().enabled, false);

    // While loading, checkbox is rendered disabled and aria-busy.
    const loadingHtml = renderToStaticMarkup(createElement(AutostartSettings, { controller }));
    assert.ok(loadingHtml.includes('data-testid="autostart-toggle"'), loadingHtml);
    assert.ok(loadingHtml.includes("disabled=\"\""), loadingHtml);
    assert.ok(loadingHtml.includes('aria-busy="true"'), loadingHtml);
    assert.ok(loadingHtml.includes("aria-describedby="), loadingHtml);

    const refreshPromise = controller.refresh();
    readGate.resolve(true);
    const snap = await refreshPromise;

    assert.equal(snap.status, "ready");
    assert.equal(snap.enabled, true);
    assert.equal(snap.loaded, true);
    assert.equal(snap.loading, false);
    assert.equal(snap.error, null);
    assert.equal(driver.calls.isEnabled, 1);
    assert.deepEqual(storageReads, [], "autostart must not use localStorage as source of truth");

    const readyHtml = renderToStaticMarkup(createElement(AutostartSettings, { controller }));
    assert.ok(readyHtml.includes('checked=""'), readyHtml);
    assert.ok(!readyHtml.includes('disabled=""'), readyHtml);
    controller.dispose();

    // OS returning false stays unchecked even if localStorage has stale data.
    const offDriver = makeMockDriver({ initialEnabled: false });
    const offController = new AutostartController(offDriver);
    await offController.refresh();
    assert.equal(offController.getSnapshot().enabled, false);
    assert.equal(offController.getSnapshot().loaded, true);
    assert.deepEqual(storageReads, []);
    offController.dispose();
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as Record<string, unknown>).localStorage;
  }
});

test("enable and disable succeed, verify OS state, and execute idempotently", async () => {
  const driver = makeMockDriver({ initialEnabled: false });
  const controller = new AutostartController(driver);

  await controller.refresh();
  assert.equal(controller.getSnapshot().enabled, false);
  assert.deepEqual(driver.calls, { isEnabled: 1, enable: 0, disable: 0 });

  // Enable transitions false -> true and verifies with isEnabled().
  const enabledSnap = await controller.enable();
  assert.equal(enabledSnap.status, "ready");
  assert.equal(enabledSnap.enabled, true);
  assert.equal(enabledSnap.updating, false);
  assert.equal(enabledSnap.pendingTarget, null);
  assert.equal(enabledSnap.error, null);
  assert.equal(driver.getOsEnabled(), true);
  assert.deepEqual(driver.calls, { isEnabled: 2, enable: 1, disable: 0 });

  // Calling enable() again when OS is already enabled is idempotent (no duplicate enable call).
  const idempotentEnable = await controller.enable();
  assert.equal(idempotentEnable.enabled, true);
  assert.equal(driver.calls.enable, 1, "idempotent enable must not invoke OS enable redundantly");
  assert.equal(driver.calls.isEnabled, 3);

  // If the OS registration drifted externally to false, enable() detects it and re-registers.
  driver.setOsEnabled(false);
  const reEnabled = await controller.enable();
  assert.equal(reEnabled.enabled, true);
  assert.equal(driver.calls.enable, 2);
  assert.equal(driver.getOsEnabled(), true);

  // Disable transitions true -> false and verifies with isEnabled().
  const disabledSnap = await controller.disable();
  assert.equal(disabledSnap.status, "ready");
  assert.equal(disabledSnap.enabled, false);
  assert.equal(disabledSnap.error, null);
  assert.equal(driver.getOsEnabled(), false);
  assert.equal(driver.calls.disable, 1);

  // Calling disable() again when already disabled is idempotent.
  const idempotentDisable = await controller.disable();
  assert.equal(idempotentDisable.enabled, false);
  assert.equal(driver.calls.disable, 1, "idempotent disable must not invoke OS disable redundantly");

  controller.dispose();
});

test("enable failure, disable failure, silent OS denial, and unsupported plugin errors roll back cleanly and display alerts", async () => {
  assert.equal(
    classifyAutostartError(new Error("Command plugin:autostart|is_enabled not found"), "read").kind,
    "unsupported",
  );
  assert.equal(
    classifyAutostartError(new Error("Permission denied writing LaunchAgent"), "enable").kind,
    "permission",
  );
  assert.equal(
    classifyAutostartError(new Error("Failed to create registry key HKCU\\Software"), "enable").kind,
    "platform",
  );

  // 1. Initial read fails (unsupported platform / plugin missing): stays unloaded, unchecked, disabled, with Retry button.
  let failRead = true;
  const unsupportedDriver = makeMockDriver({
    async isEnabled() {
      if (failRead) throw new Error("Command plugin:autostart|is_enabled not found");
      return true;
    },
  });
  const unsupportedController = new AutostartController(unsupportedDriver);
  const failedRead = await unsupportedController.refresh();
  assert.equal(failedRead.status, "error");
  assert.equal(failedRead.loaded, false);
  assert.equal(failedRead.enabled, false);
  assert.equal(failedRead.error?.kind, "unsupported");
  assert.equal(failedRead.error?.phase, "read");

  const readErrorHtml = renderToStaticMarkup(createElement(AutostartSettings, { controller: unsupportedController }));
  assert.ok(readErrorHtml.includes('role="alert"'), readErrorHtml);
  assert.ok(readErrorHtml.includes("is-warning"), readErrorHtml);
  assert.ok(readErrorHtml.includes('disabled=""'), "toggle stays disabled when initial read fails");
  assert.ok(!readErrorHtml.includes('checked=""'), "toggle must not appear falsely checked");
  assert.ok(readErrorHtml.includes("update-settings-secondary-btn"), "read failure exposes Retry button");

  // Retry succeeds once plugin responds.
  failRead = false;
  const recovered = await unsupportedController.refresh();
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.loaded, true);
  assert.equal(recovered.enabled, true);
  assert.equal(recovered.error, null);
  unsupportedController.dispose();

  // 2. Enable fails: rolls back to false and shows error alert.
  const failEnableDriver = makeMockDriver({
    initialEnabled: false,
    async enable() {
      throw new Error("Permission denied: LaunchAgents directory is read-only");
    },
  });
  const failEnableController = new AutostartController(failEnableDriver);
  await failEnableController.refresh();
  const afterEnableFail = await failEnableController.enable();
  assert.equal(afterEnableFail.status, "ready");
  assert.equal(afterEnableFail.enabled, false, "enable failure must roll back to false");
  assert.equal(afterEnableFail.updating, false);
  assert.equal(afterEnableFail.pendingTarget, null);
  assert.equal(afterEnableFail.error?.kind, "permission");
  assert.equal(afterEnableFail.error?.phase, "enable");

  const enableErrHtml = renderToStaticMarkup(createElement(AutostartSettings, { controller: failEnableController }));
  assert.ok(enableErrHtml.includes('role="alert"'), enableErrHtml);
  assert.ok(enableErrHtml.includes("is-error"), enableErrHtml);
  assert.ok(!enableErrHtml.includes('checked=""'), "failed enable must not leave checkbox checked");
  failEnableController.dispose();

  // 3. Disable fails: rolls back to true and shows error alert.
  const failDisableDriver = makeMockDriver({
    initialEnabled: true,
    async disable() {
      throw new Error("Registry write failed under HKCU Run");
    },
  });
  const failDisableController = new AutostartController(failDisableDriver);
  await failDisableController.refresh();
  assert.equal(failDisableController.getSnapshot().enabled, true);
  const afterDisableFail = await failDisableController.disable();
  assert.equal(afterDisableFail.status, "ready");
  assert.equal(afterDisableFail.enabled, true, "disable failure must roll back to true");
  assert.equal(afterDisableFail.error?.kind, "platform");
  assert.equal(afterDisableFail.error?.phase, "disable");

  const disableErrHtml = renderToStaticMarkup(createElement(AutostartSettings, { controller: failDisableController }));
  assert.ok(disableErrHtml.includes('role="alert"'), disableErrHtml);
  assert.ok(disableErrHtml.includes('checked=""'), "failed disable must preserve checked state");
  failDisableController.dispose();

  // 4. Silent OS refusal (enable() resolves, but isEnabled() still reports false).
  const silentRefusalDriver = makeMockDriver({
    initialEnabled: false,
    async enable() {
      // Simulates OS silently blocking Login Item registration without throwing.
    },
  });
  const silentController = new AutostartController(silentRefusalDriver);
  await silentController.refresh();
  const silentSnap = await silentController.enable();
  assert.equal(silentSnap.enabled, false, "silent OS refusal must never leave preference falsely toggled");
  assert.equal(silentSnap.error?.phase, "enable");
  assert.equal(silentSnap.error?.kind, "platform");
  silentController.dispose();
});

test("unmount/dispose and race cleanup drop stale refreshes, skip post-unmount verification, and serialize concurrent mutations", async () => {
  // 1. Slow refresh superseded by a newer mutation cannot overwrite newer state.
  const slowRead = createDeferred<boolean>();
  let osState = false;
  let readAttempt = 0;
  const raceDriver = makeMockDriver({
    async isEnabled() {
      readAttempt += 1;
      if (readAttempt === 1) return slowRead.promise;
      return osState;
    },
    async enable() {
      osState = true;
    },
  });
  const raceController = new AutostartController(raceDriver);
  const staleRefresh = raceController.refresh();
  const enablePromise = raceController.enable();
  await enablePromise;
  assert.equal(raceController.getSnapshot().enabled, true);

  // Now the earlier slow refresh resolves with stale `false`; it must be ignored.
  slowRead.resolve(false);
  await staleRefresh;
  assert.equal(raceController.getSnapshot().enabled, true, "stale refresh must not overwrite newer toggle result");
  raceController.dispose();

  // 2. Concurrent enable calls share a single in-flight OS mutation.
  const enableGate = createDeferred<void>();
  let concurrentOs = false;
  const concurrentDriver = makeMockDriver({
    isEnabled: async () => concurrentOs,
    async enable() {
      await enableGate.promise;
      concurrentOs = true;
    },
  });
  const concurrentController = new AutostartController(concurrentDriver);
  await concurrentController.refresh();
  const p1 = concurrentController.enable();
  const p2 = concurrentController.enable();
  assert.equal(concurrentDriver.calls.enable, 1, "concurrent clicks must not fire duplicate OS writes");
  assert.equal(concurrentController.getSnapshot().updating, true);
  assert.equal(concurrentController.getSnapshot().pendingTarget, true);
  enableGate.resolve();
  await Promise.all([p1, p2]);
  assert.equal(concurrentController.getSnapshot().enabled, true);
  assert.equal(concurrentDriver.calls.enable, 1);
  concurrentController.dispose();

  // 3. cancelPending() on unmount/close ignores late resolutions and skips post-write verification.
  const pendingEnable = createDeferred<void>();
  const unmountDriver = makeMockDriver({
    initialEnabled: false,
    async enable() {
      await pendingEnable.promise;
    },
  });
  const unmountController = new AutostartController(unmountDriver);
  await unmountController.refresh();
  const readsBeforeToggle = unmountDriver.calls.isEnabled;

  let notifications = 0;
  const unsub = unmountController.subscribe(() => {
    notifications += 1;
  });

  const inFlight = unmountController.enable();
  const notificationsAtCancel = notifications;
  unmountController.cancelPending();
  pendingEnable.resolve();
  await inFlight;

  assert.equal(notifications, notificationsAtCancel, "cancelled operation must not notify listeners");
  assert.equal(
    unmountDriver.calls.isEnabled,
    readsBeforeToggle,
    "cancelled mutation must skip post-write OS re-read",
  );
  unsub();

  // 4. After dispose(), no further OS reads or writes can be triggered while closed.
  const disposedDriver = makeMockDriver({ initialEnabled: false });
  const disposedController = new AutostartController(disposedDriver);
  let disposedNotifications = 0;
  disposedController.subscribe(() => {
    disposedNotifications += 1;
  });
  disposedController.dispose();
  await disposedController.refresh();
  await disposedController.enable();
  await disposedController.disable();
  assert.deepEqual(disposedDriver.calls, { isEnabled: 0, enable: 0, disable: 0 });
  assert.equal(disposedNotifications, 0);
});
