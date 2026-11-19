export const UPDATER_RELEASES_URL = "https://github.com/zhexusun10/grapher/releases";
export const UPDATER_MANIFEST_URL =
  "https://github.com/zhexusun10/grapher/releases/latest/download/latest.json";

export type UpdaterPlatform = "macos" | "windows" | "linux" | "unknown";

export type UpdaterStatus =
  | "unsupported"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "cancelling"
  | "installing"
  | "ready-to-restart"
  | "restarting"
  | "error";

export type UpdaterErrorKind =
  | "unsigned-unavailable"
  | "signature"
  | "network"
  | "install"
  | "restart"
  | "unknown";

export type UpdaterErrorPhase = "check" | "download" | "install" | "restart";

export interface UpdaterErrorInfo {
  kind: UpdaterErrorKind;
  phase: UpdaterErrorPhase;
  message: string;
  rawMessage: string;
}

export interface UpdaterUpdateInfo {
  currentVersion: string;
  version: string;
  date: string | null;
  body: string | null;
}

export interface UpdaterProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

export interface UpdaterSnapshot {
  supported: boolean;
  platform: UpdaterPlatform;
  status: UpdaterStatus;
  currentVersion: string | null;
  availableUpdate: UpdaterUpdateInfo | null;
  progress: UpdaterProgress | null;
  error: UpdaterErrorInfo | null;
  lastCheckedAt: number | null;
  lastCheckSilent: boolean;
  startupCheckCompleted: boolean;
  downloadCancelled: boolean;
  downloadedReady: boolean;
  canCancelDownload: boolean;
  dismissedBannerVersion: string | null;
}

export type UpdaterDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface UpdateHandle {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  download: (
    onEvent?: (event: UpdaterDownloadEvent) => void,
    options?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<void>;
  install: (options?: { restartAfterInstall?: boolean }) => Promise<void>;
  close?: () => Promise<void>;
}

export interface UpdaterDriver {
  isSupported: () => boolean;
  getPlatform?: () => UpdaterPlatform;
  getCurrentVersion: () => Promise<string | null>;
  check: (options?: { timeout?: number }) => Promise<UpdateHandle | null>;
  relaunch: () => Promise<void>;
}

export interface UpdaterControllerOptions {
  checkTimeoutMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Optional lifecycle hook for tests to simulate window unload/pagehide during Windows NSIS handoff. */
  observePageTeardown?: (onTeardown: () => void) => () => void;
}

const DEFAULT_CHECK_TIMEOUT_MS = 15_000;

/**
 * Feature-detects the Tauri v2 desktop runtime without relying on `withGlobalTauri`.
 * Always returns `false` in standard browser and Node test environments.
 */
export function isTauriDesktop(target: unknown = globalThis): boolean {
  if (!target || typeof target !== "object") return false;
  const runtime = target as {
    isTauri?: unknown;
    __TAURI_INTERNALS__?: { invoke?: unknown } | null;
    __TAURI__?: { core?: { invoke?: unknown } | null } | null;
  };
  return (
    runtime.isTauri === true ||
    typeof runtime.__TAURI_INTERNALS__?.invoke === "function" ||
    typeof runtime.__TAURI__?.core?.invoke === "function"
  );
}

/**
 * Detects the desktop OS platform from browser/WebView navigator metadata.
 * Used to distinguish macOS in-place swap + `relaunch()` from Windows NSIS
 * installer handoff (where `tauri-plugin-updater` launches the `.exe` with
 * `/P /UPDATE /R` and exits the process directly).
 */
export function detectDesktopPlatform(target: unknown = globalThis): UpdaterPlatform {
  if (!target || typeof target !== "object") return "unknown";
  const candidate = target as {
    navigator?: {
      userAgentData?: { platform?: unknown };
      platform?: unknown;
      userAgent?: unknown;
    };
    userAgentData?: { platform?: unknown };
    platform?: unknown;
    userAgent?: unknown;
  };
  const nav = candidate.navigator ?? candidate;
  const raw =
    (typeof nav.userAgentData?.platform === "string" && nav.userAgentData.platform) ||
    (typeof nav.platform === "string" && nav.platform) ||
    (typeof nav.userAgent === "string" && nav.userAgent) ||
    "";
  if (/win/i.test(raw)) return "windows";
  if (/mac/i.test(raw) && !/iphone|ipad|ipod/i.test(raw)) return "macos";
  if (/linux/i.test(raw) && !/android/i.test(raw)) return "linux";
  return "unknown";
}

function defaultObservePageTeardown(onTeardown: () => void): () => void {
  if (typeof globalThis === "undefined") return () => {};
  const win = globalThis as {
    addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
  if (typeof win.addEventListener !== "function" || typeof win.removeEventListener !== "function") {
    return () => {};
  }
  const listener = () => onTeardown();
  win.addEventListener("pagehide", listener, { once: true });
  win.addEventListener("beforeunload", listener, { once: true });
  return () => {
    win.removeEventListener?.("pagehide", listener);
    win.removeEventListener?.("beforeunload", listener);
  };
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return String(error ?? "Unknown error");
  } catch {
    return "Unknown error";
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}

const SIGNATURE_ERROR_RE =
  /minisign|signature|public\s*key|pubkey|invalid\s*encoding|signed\s+for\s+version|different\s+key|signedversionmismatch|missingsignedversion|requiresignedversion|base64/i;

const UNSIGNED_UNAVAILABLE_RE =
  /none of the fallback platforms|was not found in the response.*platforms|could not fetch a valid release json|does not have any endpoints set|targetnotfound|targetsnotfound|releasenotfound|\b404\b/i;

const NETWORK_ERROR_RE =
  /timed?\s*out|network|dns|connection|error sending request|failed to lookup|tls|certificate|reset by peer|broken pipe|\b50[234]\b|offline/i;

const WINDOWS_REAL_INSTALL_ERROR_RE =
  /shellexecute|access\s+is\s+denied|permission\s+denied|invalid\s+updater|binary.*not\s+found|os\s+error|no\s+such\s+file|sharing\s+violation|out\s+of\s+memory|bad\s+format|failed\s+to\s+create\s+temporary/i;

const WINDOWS_HANDOFF_TEARDOWN_RE =
  /ipc.*(?:closed|disconnected|dropped|terminated|aborted)|channel.*(?:closed|disconnected)|webview.*(?:closed|destroyed|disposed)|window.*(?:closed|destroyed)|postmessage.*closed/i;

/**
 * Returns true when an error rejected from `Update.install()` on Windows looks
 * like IPC/WebView2 teardown during `tauri-plugin-updater`'s intentional
 * `std::process::exit(0)` after spawning the NSIS installer, rather than a real
 * signature, format, UAC, or `ShellExecuteW` failure.
 */
export function isWindowsInstallerHandoffTeardownError(error: unknown): boolean {
  const rawMessage = errorMessageOf(error).trim();
  if (!rawMessage) return false;
  if (SIGNATURE_ERROR_RE.test(rawMessage) || WINDOWS_REAL_INSTALL_ERROR_RE.test(rawMessage)) {
    return false;
  }
  return WINDOWS_HANDOFF_TEARDOWN_RE.test(rawMessage);
}

export function classifyUpdaterError(
  error: unknown,
  phase: UpdaterErrorPhase,
): UpdaterErrorInfo {
  const rawMessage = errorMessageOf(error).trim() || "Unknown updater error";
  let kind: UpdaterErrorKind = "unknown";

  if (phase === "restart") {
    kind = "restart";
  } else if (SIGNATURE_ERROR_RE.test(rawMessage)) {
    kind = "signature";
  } else if (phase === "install") {
    kind = "install";
  } else if (phase === "check" && UNSIGNED_UNAVAILABLE_RE.test(rawMessage)) {
    kind = "unsigned-unavailable";
  } else if (NETWORK_ERROR_RE.test(rawMessage)) {
    kind = "network";
  }

  return {
    kind,
    phase,
    message: rawMessage,
    rawMessage,
  };
}

export function formatUpdaterBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const decimals = index === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[index]}`;
}

export function createTauriUpdaterDriver(): UpdaterDriver {
  return {
    isSupported: () => isTauriDesktop(),
    getPlatform: () => detectDesktopPlatform(),
    async getCurrentVersion() {
      if (!isTauriDesktop()) return null;
      const { getVersion } = await import("@tauri-apps/api/app");
      return getVersion();
    },
    async check(options) {
      if (!isTauriDesktop()) return null;
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check(
        options?.timeout !== undefined ? { timeout: options.timeout } : undefined,
      );
      if (!update) return null;
      return {
        currentVersion: update.currentVersion,
        version: update.version,
        date: update.date,
        body: update.body,
        download: (onEvent, downloadOptions) =>
          update.download(
            onEvent,
            downloadOptions?.timeout !== undefined
              ? { timeout: downloadOptions.timeout }
              : undefined,
          ),
        install: (installOptions) => update.install(installOptions),
        close: () => update.close(),
      };
    },
    async relaunch() {
      if (!isTauriDesktop()) return;
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}

function normalizeOptionalText(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class AppUpdaterController {
  private readonly driver: UpdaterDriver;
  private readonly checkTimeoutMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly observePageTeardown: (onTeardown: () => void) => () => void;

  private readonly listeners = new Set<() => void>();
  private state: UpdaterSnapshot;
  private activeHandle: UpdateHandle | null = null;
  private activeCheck: Promise<UpdaterSnapshot> | null = null;
  private activeTransfer: Promise<UpdaterSnapshot> | null = null;
  private versionPromise: Promise<string | null> | null = null;
  private downloadAbortController: AbortController | null = null;
  private transferGeneration = 0;
  private startupScheduled = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    driver: UpdaterDriver = createTauriUpdaterDriver(),
    options: UpdaterControllerOptions = {},
  ) {
    this.driver = driver;
    this.checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.observePageTeardown = options.observePageTeardown ?? defaultObservePageTeardown;

    const supported = this.driver.isSupported();
    const platform = supported ? (this.driver.getPlatform?.() ?? "unknown") : "unknown";
    this.state = {
      supported,
      platform,
      status: supported ? "idle" : "unsupported",
      currentVersion: null,
      availableUpdate: null,
      progress: null,
      error: null,
      lastCheckedAt: null,
      lastCheckSilent: false,
      startupCheckCompleted: !supported,
      downloadCancelled: false,
      downloadedReady: false,
      canCancelDownload: false,
      dismissedBannerVersion: null,
    };
  }

  getSnapshot = (): UpdaterSnapshot => this.state;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(patch: Partial<UpdaterSnapshot>): UpdaterSnapshot {
    if (this.disposed) return this.state;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Isolate subscriber errors so updater state remains consistent.
      }
    }
    return this.state;
  }

  private async closeHandle(handle: UpdateHandle | null): Promise<void> {
    if (!handle?.close) return;
    try {
      await handle.close();
    } catch {
      // Closing an already-consumed or torn-down Rust resource is non-fatal.
    }
  }

  async hydrateCurrentVersion(): Promise<string | null> {
    if (!this.state.supported || this.disposed) return null;
    if (this.state.currentVersion) return this.state.currentVersion;
    if (this.versionPromise) return this.versionPromise;

    this.versionPromise = (async () => {
      try {
        const version = normalizeOptionalText(await this.driver.getCurrentVersion());
        if (version && !this.disposed && !this.state.currentVersion) {
          this.emit({ currentVersion: version });
        }
        return version;
      } catch {
        return null;
      } finally {
        this.versionPromise = null;
      }
    })();

    return this.versionPromise;
  }

  /**
   * Schedules a single non-blocking silent update check after initial render.
   * Returns a cleanup function that cancels the pending timer if unmounted early.
   */
  scheduleStartupCheck(delayMs = 1500): () => void {
    if (!this.state.supported || this.disposed || this.startupScheduled) {
      return () => {};
    }
    this.startupScheduled = true;
    void this.hydrateCurrentVersion();

    const timer = this.setTimer(() => {
      this.startupTimer = null;
      if (this.disposed) return;
      void this.checkForUpdates({ silent: true });
    }, Math.max(0, delayMs));
    this.startupTimer = timer;

    return () => {
      if (this.startupTimer === timer) {
        this.clearTimer(timer);
        this.startupTimer = null;
        this.startupScheduled = false;
      }
    };
  }

  checkForUpdates(options?: { silent?: boolean }): Promise<UpdaterSnapshot> {
    const silent = Boolean(options?.silent);
    if (!this.state.supported || this.disposed) {
      return Promise.resolve(this.state);
    }
    if (this.activeCheck) {
      if (!silent && this.state.lastCheckSilent) {
        this.emit({ lastCheckSilent: false });
      }
      return this.activeCheck;
    }
    if (this.activeTransfer) {
      return Promise.resolve(this.state);
    }

    const run = (async (): Promise<UpdaterSnapshot> => {
      void this.hydrateCurrentVersion();
      this.emit({
        status: "checking",
        error: null,
        downloadCancelled: false,
        lastCheckSilent: silent,
      });

      try {
        const update = await this.driver.check({ timeout: this.checkTimeoutMs });
        if (this.disposed) {
          await this.closeHandle(update);
          return this.state;
        }

        const previousHandle = this.activeHandle;
        this.activeHandle = update;
        if (previousHandle && previousHandle !== update) {
          void this.closeHandle(previousHandle);
        }

        const checkedAt = this.now();
        if (!update) {
          return this.emit({
            status: "up-to-date",
            availableUpdate: null,
            progress: null,
            error: null,
            lastCheckedAt: checkedAt,
            startupCheckCompleted: true,
            downloadCancelled: false,
            downloadedReady: false,
            canCancelDownload: false,
          });
        }

        const currentVersion =
          normalizeOptionalText(update.currentVersion) ?? this.state.currentVersion ?? "";
        const availableUpdate: UpdaterUpdateInfo = {
          currentVersion,
          version: update.version,
          date: normalizeOptionalText(update.date),
          body: normalizeOptionalText(update.body),
        };
        return this.emit({
          status: "available",
          currentVersion: currentVersion || this.state.currentVersion,
          availableUpdate,
          progress: null,
          error: null,
          lastCheckedAt: checkedAt,
          startupCheckCompleted: true,
          downloadCancelled: false,
          downloadedReady: false,
          canCancelDownload: false,
          dismissedBannerVersion:
            this.state.dismissedBannerVersion === availableUpdate.version
              ? this.state.dismissedBannerVersion
              : null,
        });
      } catch (error) {
        if (this.disposed) return this.state;
        const classified = classifyUpdaterError(error, "check");
        return this.emit({
          status: "error",
          error: classified,
          progress: null,
          lastCheckedAt: this.now(),
          startupCheckCompleted: true,
          canCancelDownload: false,
        });
      } finally {
        this.activeCheck = null;
      }
    })();

    this.activeCheck = run;
    return run;
  }

  installAndRestart(): Promise<UpdaterSnapshot> {
    if (!this.state.supported || this.disposed) {
      return Promise.resolve(this.state);
    }
    if (this.activeTransfer) {
      return this.activeTransfer;
    }
    if (this.activeCheck) {
      return Promise.resolve(this.state);
    }
    if (this.state.status === "ready-to-restart") {
      return this.restartApp();
    }
    if (!this.state.availableUpdate && !this.activeHandle) {
      return Promise.resolve(this.state);
    }

    const generation = ++this.transferGeneration;
    const run = (async (): Promise<UpdaterSnapshot> => {
      try {
        // If a prior cancelled download closed the Rust resource handle, fetch a fresh one first.
        let handle = this.activeHandle;
        if (!handle) {
          this.emit({
            status: "checking",
            error: null,
            downloadCancelled: false,
            lastCheckSilent: false,
          });
          try {
            handle = await this.driver.check({ timeout: this.checkTimeoutMs });
          } catch (error) {
            if (this.disposed) return this.state;
            return this.emit({
              status: "error",
              error: classifyUpdaterError(error, "check"),
              canCancelDownload: false,
            });
          }
          if (this.disposed) {
            await this.closeHandle(handle);
            return this.state;
          }
          this.activeHandle = handle;
          if (!handle) {
            return this.emit({
              status: "up-to-date",
              availableUpdate: null,
              progress: null,
              error: null,
              lastCheckedAt: this.now(),
              downloadedReady: false,
              canCancelDownload: false,
            });
          }
        }

        if (!this.state.downloadedReady) {
          const abortController = new AbortController();
          this.downloadAbortController = abortController;
          let downloadedBytes = 0;
          let totalBytes: number | null = null;

          this.emit({
            status: "downloading",
            error: null,
            downloadCancelled: false,
            canCancelDownload: true,
            progress: {
              downloadedBytes: 0,
              totalBytes: null,
              percent: null,
            },
          });

          const onProgress = (event: UpdaterDownloadEvent) => {
            if (
              this.disposed ||
              abortController.signal.aborted ||
              this.transferGeneration !== generation
            ) {
              return;
            }
            if (event.event === "Started") {
              const length = event.data?.contentLength;
              totalBytes =
                typeof length === "number" && Number.isFinite(length) && length > 0
                  ? length
                  : null;
              downloadedBytes = 0;
              this.emit({
                progress: {
                  downloadedBytes: 0,
                  totalBytes,
                  percent: totalBytes ? 0 : null,
                },
              });
            } else if (event.event === "Progress") {
              const chunk =
                typeof event.data?.chunkLength === "number" && event.data.chunkLength > 0
                  ? event.data.chunkLength
                  : 0;
              downloadedBytes += chunk;
              const percent = totalBytes
                ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
                : null;
              this.emit({
                progress: {
                  downloadedBytes,
                  totalBytes,
                  percent,
                },
              });
            } else if (event.event === "Finished") {
              const finalDownloaded = totalBytes
                ? Math.max(downloadedBytes, totalBytes)
                : downloadedBytes;
              this.emit({
                progress: {
                  downloadedBytes: finalDownloaded,
                  totalBytes,
                  percent: totalBytes ? 100 : null,
                },
              });
            }
          };

          try {
            await handle.download(onProgress, { signal: abortController.signal });
          } catch (error) {
            this.downloadAbortController = null;
            if (this.disposed) {
              await this.closeHandle(handle);
              this.activeHandle = null;
              return this.state;
            }
            if (abortController.signal.aborted || isAbortError(error)) {
              await this.closeHandle(handle);
              if (this.activeHandle === handle) this.activeHandle = null;
              return this.emit({
                status: "available",
                progress: null,
                error: null,
                downloadCancelled: true,
                downloadedReady: false,
                canCancelDownload: false,
              });
            }
            const classified = classifyUpdaterError(error, "download");
            if (classified.kind === "signature") {
              await this.closeHandle(handle);
              if (this.activeHandle === handle) this.activeHandle = null;
            }
            return this.emit({
              status: "error",
              error: classified,
              canCancelDownload: false,
              downloadedReady: false,
            });
          }

          this.downloadAbortController = null;
          if (this.disposed || abortController.signal.aborted) {
            await this.closeHandle(handle);
            if (this.activeHandle === handle) this.activeHandle = null;
            if (this.disposed) return this.state;
            return this.emit({
              status: "available",
              progress: null,
              error: null,
              downloadCancelled: true,
              downloadedReady: false,
              canCancelDownload: false,
            });
          }

          this.emit({
            downloadedReady: true,
            canCancelDownload: false,
          });
        }

        // Install downloaded & verified update package.
        this.emit({
          status: "installing",
          error: null,
          canCancelDownload: false,
        });

        const isWindows = this.state.platform === "windows";
        let windowsTeardownObserved = false;
        const stopObservingTeardown = isWindows
          ? this.observePageTeardown(() => {
              windowsTeardownObserved = true;
            })
          : () => {};

        try {
          await handle.install({ restartAfterInstall: true });
        } catch (error) {
          stopObservingTeardown();
          if (this.disposed) return this.state;
          const classified = classifyUpdaterError(error, "install");
          // On Windows NSIS, `tauri-plugin-updater` spawns the installer with
          // `/P /UPDATE /R` and immediately calls `std::process::exit(0)`. If the
          // WebView2 IPC channel disconnects during that intentional exit, treat it
          // as a successful handoff rather than reporting a false install failure.
          if (
            isWindows &&
            classified.kind !== "signature" &&
            (windowsTeardownObserved || isWindowsInstallerHandoffTeardownError(error))
          ) {
            if (this.activeHandle === handle) this.activeHandle = null;
            return this.emit({
              status: "restarting",
              error: null,
              downloadedReady: false,
              canCancelDownload: false,
            });
          }
          await this.closeHandle(handle);
          if (this.activeHandle === handle) this.activeHandle = null;
          return this.emit({
            status: "error",
            error: classified,
            downloadedReady: false,
            canCancelDownload: false,
          });
        }
        stopObservingTeardown();

        if (this.activeHandle === handle) this.activeHandle = null;
        if (this.disposed) return this.state;

        // On Windows NSIS, `handle.install({ restartAfterInstall: true })` hands
        // restart off to the NSIS installer (`/P /UPDATE /R`) and exits the app.
        // Never call `relaunch()` on Windows: doing so would race with NSIS or
        // surface a false restart failure during process teardown.
        if (isWindows) {
          return this.emit({
            status: "restarting",
            error: null,
            downloadedReady: false,
            canCancelDownload: false,
          });
        }

        // On macOS / Linux, release the Update handle (`plugin:updater|install`
        // closes only the downloaded bytes resource) before relaunching via
        // `tauri-plugin-process`.
        await this.closeHandle(handle);
        if (this.disposed) return this.state;

        this.emit({
          status: "restarting",
          error: null,
          downloadedReady: false,
          canCancelDownload: false,
        });

        try {
          await this.driver.relaunch();
        } catch (error) {
          if (this.disposed) return this.state;
          return this.emit({
            status: "ready-to-restart",
            error: classifyUpdaterError(error, "restart"),
            canCancelDownload: false,
          });
        }

        return this.state;
      } finally {
        this.downloadAbortController = null;
        this.activeTransfer = null;
      }
    })();

    this.activeTransfer = run;
    return run;
  }

  cancelDownload(): void {
    if (
      !this.state.supported ||
      this.disposed ||
      this.state.status !== "downloading" ||
      !this.downloadAbortController ||
      this.downloadAbortController.signal.aborted
    ) {
      return;
    }
    this.downloadAbortController.abort();
    this.emit({
      status: "cancelling",
      canCancelDownload: false,
    });
  }

  restartApp(): Promise<UpdaterSnapshot> {
    if (!this.state.supported || this.disposed) {
      return Promise.resolve(this.state);
    }
    if (this.activeTransfer) {
      return this.activeTransfer;
    }

    const run = (async (): Promise<UpdaterSnapshot> => {
      this.emit({
        status: "restarting",
        error: null,
      });
      try {
        await this.driver.relaunch();
        return this.state;
      } catch (error) {
        if (this.disposed) return this.state;
        return this.emit({
          status: "ready-to-restart",
          error: classifyUpdaterError(error, "restart"),
        });
      } finally {
        this.activeTransfer = null;
      }
    })();

    this.activeTransfer = run;
    return run;
  }

  retry(): Promise<UpdaterSnapshot> {
    if (!this.state.supported || this.disposed) {
      return Promise.resolve(this.state);
    }
    if (this.state.status === "ready-to-restart") {
      return this.restartApp();
    }
    if (
      this.state.availableUpdate &&
      (this.state.downloadCancelled ||
        this.state.error?.phase === "download" ||
        this.state.error?.phase === "install")
    ) {
      return this.installAndRestart();
    }
    return this.checkForUpdates({ silent: false });
  }

  dismissBanner(): void {
    if (!this.state.availableUpdate) return;
    this.emit({
      dismissedBannerVersion: this.state.availableUpdate.version,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.startupTimer !== null) {
      this.clearTimer(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.downloadAbortController && !this.downloadAbortController.signal.aborted) {
      this.downloadAbortController.abort();
    }
    this.downloadAbortController = null;
    this.listeners.clear();
    const handle = this.activeHandle;
    this.activeHandle = null;
    void this.closeHandle(handle);
  }
}

let sharedUpdaterController: AppUpdaterController | null = null;

export function getAppUpdater(): AppUpdaterController {
  if (!sharedUpdaterController) {
    sharedUpdaterController = new AppUpdaterController();
  }
  return sharedUpdaterController;
}

export function resetAppUpdaterForTests(): void {
  sharedUpdaterController?.dispose();
  sharedUpdaterController = null;
}
