import { isTauriDesktop } from "./updater";

export { isTauriDesktop };

export type AutostartStatus =
  | "unsupported"
  | "loading"
  | "ready"
  | "updating"
  | "error";

export type AutostartErrorKind =
  | "unsupported"
  | "permission"
  | "platform"
  | "unknown";

export type AutostartErrorPhase = "read" | "enable" | "disable";

export interface AutostartErrorInfo {
  kind: AutostartErrorKind;
  phase: AutostartErrorPhase;
  message: string;
  rawMessage: string;
}

export interface AutostartSnapshot {
  supported: boolean;
  status: AutostartStatus;
  /** Actual OS launch-at-login state confirmed by the plugin (false before load). */
  enabled: boolean;
  /** True once OS registration state has been read successfully at least once. */
  loaded: boolean;
  /** True while reading OS registration state. */
  loading: boolean;
  /** True while enabling or disabling OS registration. */
  updating: boolean;
  /** Requested target while `updating` is true; null otherwise. */
  pendingTarget: boolean | null;
  error: AutostartErrorInfo | null;
}

export interface AutostartDriver {
  isSupported: () => boolean;
  isEnabled: () => Promise<boolean>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
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

const UNSUPPORTED_ERROR_RE =
  /plugin(?:\s+autostart)?\s+not\s+found|command\s+plugin:autostart[^\n]*not\s+found|unknown\s+command|unsupported|not\s+supported|does\s+not\s+support|android|ios/i;

const PERMISSION_ERROR_RE =
  /permission\s+denied|access\s+is\s+denied|operation\s+not\s+permitted|not\s+allowed|forbidden|\beacces\b|\beperm\b|unauthorized/i;

const PLATFORM_ERROR_RE =
  /launch\s*agent|plist|registry|hkcu|auto[_\s-]?launch|current_exe|os\s+did\s+not\s+confirm|executable|failed\s+to\s+create|failed\s+to\s+remove/i;

export function classifyAutostartError(
  error: unknown,
  phase: AutostartErrorPhase,
): AutostartErrorInfo {
  const rawMessage = errorMessageOf(error).trim() || "Unknown autostart error";
  let kind: AutostartErrorKind = "unknown";

  if (UNSUPPORTED_ERROR_RE.test(rawMessage)) {
    kind = "unsupported";
  } else if (PERMISSION_ERROR_RE.test(rawMessage)) {
    kind = "permission";
  } else if (PLATFORM_ERROR_RE.test(rawMessage)) {
    kind = "platform";
  }

  return {
    kind,
    phase,
    message: rawMessage,
    rawMessage,
  };
}

/**
 * Creates a Tauri v2 autostart driver backed by `@tauri-apps/plugin-autostart`.
 * Dynamically imports the desktop-only plugin only inside Tauri runtimes so
 * browser mode and `npm run dev` never evaluate desktop IPC modules.
 */
export function createTauriAutostartDriver(): AutostartDriver {
  return {
    isSupported: () => isTauriDesktop(),
    async isEnabled() {
      if (!isTauriDesktop()) return false;
      const { isEnabled } = await import("@tauri-apps/plugin-autostart");
      return Boolean(await isEnabled());
    },
    async enable() {
      if (!isTauriDesktop()) return;
      const { enable } = await import("@tauri-apps/plugin-autostart");
      await enable();
    },
    async disable() {
      if (!isTauriDesktop()) return;
      const { disable } = await import("@tauri-apps/plugin-autostart");
      await disable();
    },
  };
}

export class AutostartController {
  private readonly driver: AutostartDriver;
  private readonly listeners = new Set<() => void>();
  private state: AutostartSnapshot;
  private activeRefresh: Promise<AutostartSnapshot> | null = null;
  private activeMutation: Promise<AutostartSnapshot> | null = null;
  private generation = 0;
  private disposed = false;

  constructor(driver: AutostartDriver = createTauriAutostartDriver()) {
    this.driver = driver;
    const supported = this.driver.isSupported();
    this.state = {
      supported,
      status: supported ? "loading" : "unsupported",
      enabled: false,
      loaded: false,
      loading: supported,
      updating: false,
      pendingTarget: null,
      error: null,
    };
  }

  getSnapshot = (): AutostartSnapshot => this.state;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(patch: Partial<AutostartSnapshot>): AutostartSnapshot {
    if (this.disposed) return this.state;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Isolate subscriber failures so autostart state remains consistent.
      }
    }
    return this.state;
  }

  refresh(): Promise<AutostartSnapshot> {
    if (!this.state.supported || this.disposed) {
      return Promise.resolve(this.state);
    }
    if (this.activeMutation) {
      return this.activeMutation;
    }
    if (this.activeRefresh) {
      return this.activeRefresh;
    }

    const generation = ++this.generation;
    let run: Promise<AutostartSnapshot> | null = null;
    run = (async (): Promise<AutostartSnapshot> => {
      this.emit({
        status: "loading",
        loading: true,
        error: null,
      });

      try {
        const enabled = Boolean(await this.driver.isEnabled());
        if (this.disposed || this.generation !== generation) {
          return this.state;
        }
        return this.emit({
          status: "ready",
          enabled,
          loaded: true,
          loading: false,
          updating: false,
          pendingTarget: null,
          error: null,
        });
      } catch (error) {
        if (this.disposed || this.generation !== generation) {
          return this.state;
        }
        return this.emit({
          status: "error",
          loading: false,
          updating: false,
          pendingTarget: null,
          error: classifyAutostartError(error, "read"),
        });
      } finally {
        if (this.activeRefresh === run) {
          this.activeRefresh = null;
        }
      }
    })();

    this.activeRefresh = run;
    return run;
  }

  setEnabled(desired: boolean): Promise<AutostartSnapshot> {
    if (!this.state.supported || this.disposed) {
      return Promise.resolve(this.state);
    }
    if (this.activeMutation) {
      return this.activeMutation;
    }

    const generation = ++this.generation;
    this.activeRefresh = null;
    const previousEnabled = this.state.enabled;
    const wasLoaded = this.state.loaded;
    const phase: AutostartErrorPhase = desired ? "enable" : "disable";

    let run: Promise<AutostartSnapshot> | null = null;
    run = (async (): Promise<AutostartSnapshot> => {
      this.emit({
        status: "updating",
        loading: false,
        updating: true,
        pendingTarget: desired,
        error: null,
      });

      try {
        // Check actual OS state first when unloaded or when target matches last
        // known state so enable()/disable() stays strictly idempotent.
        if (!wasLoaded || previousEnabled === desired) {
          const current = Boolean(await this.driver.isEnabled());
          if (this.disposed || this.generation !== generation) {
            return this.state;
          }
          if (current === desired) {
            return this.emit({
              status: "ready",
              enabled: current,
              loaded: true,
              loading: false,
              updating: false,
              pendingTarget: null,
              error: null,
            });
          }
        }

        if (desired) {
          await this.driver.enable();
        } else {
          await this.driver.disable();
        }
        if (this.disposed || this.generation !== generation) {
          return this.state;
        }

        // Re-read the OS registration to confirm the change actually persisted.
        const actual = Boolean(await this.driver.isEnabled());
        if (this.disposed || this.generation !== generation) {
          return this.state;
        }
        if (actual !== desired) {
          return this.emit({
            status: "ready",
            enabled: actual,
            loaded: true,
            loading: false,
            updating: false,
            pendingTarget: null,
            error: classifyAutostartError(
              new Error(
                desired
                  ? "OS did not confirm launch-at-login registration."
                  : "OS did not confirm launch-at-login removal.",
              ),
              phase,
            ),
          });
        }

        return this.emit({
          status: "ready",
          enabled: actual,
          loaded: true,
          loading: false,
          updating: false,
          pendingTarget: null,
          error: null,
        });
      } catch (error) {
        if (this.disposed || this.generation !== generation) {
          return this.state;
        }

        let confirmedEnabled = previousEnabled;
        let confirmedLoaded = wasLoaded;
        try {
          confirmedEnabled = Boolean(await this.driver.isEnabled());
          confirmedLoaded = true;
        } catch {
          confirmedEnabled = previousEnabled;
        }
        if (this.disposed || this.generation !== generation) {
          return this.state;
        }

        return this.emit({
          status: confirmedLoaded ? "ready" : "error",
          enabled: confirmedEnabled,
          loaded: confirmedLoaded,
          loading: false,
          updating: false,
          pendingTarget: null,
          error: classifyAutostartError(error, phase),
        });
      } finally {
        if (this.activeMutation === run) {
          this.activeMutation = null;
        }
      }
    })();

    this.activeMutation = run;
    return run;
  }

  enable(): Promise<AutostartSnapshot> {
    return this.setEnabled(true);
  }

  disable(): Promise<AutostartSnapshot> {
    return this.setEnabled(false);
  }

  /**
   * Invalidates any in-flight refresh or mutation so late resolutions are ignored
   * without permanently disposing the controller (safe across React StrictMode
   * re-mounts and modal close/reopen cycles).
   */
  cancelPending(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.activeRefresh = null;
    this.activeMutation = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.activeRefresh = null;
    this.activeMutation = null;
    this.listeners.clear();
  }
}
