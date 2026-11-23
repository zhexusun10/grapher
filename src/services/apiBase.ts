import { t } from "../i18n";

export type DesktopBackendPhase = "browser" | "connecting" | "ready" | "error";
export type DesktopBackendErrorKind =
  | "not_ready"
  | "closed"
  | "invalid_url"
  | "ipc_unavailable"
  | "disconnected";

export interface DesktopBackendState {
  isDesktop: boolean;
  phase: DesktopBackendPhase;
  baseUrl: string | null;
  error: string | null;
  closed: boolean;
}

type TauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriRuntimeGlobal {
  isTauri?: boolean;
  __TAURI_INTERNALS__?: {
    invoke?: TauriInvoke;
  };
  __TAURI__?: {
    core?: {
      invoke?: TauriInvoke;
    };
  };
}

const BACKEND_URL_COMMAND = "backend_url";
const BROWSER_STATE: DesktopBackendState = Object.freeze({
  isDesktop: false,
  phase: "browser",
  baseUrl: null,
  error: null,
  closed: false,
});

export class DesktopBackendError extends Error {
  readonly kind: DesktopBackendErrorKind;
  readonly detail: string;

  constructor(kind: DesktopBackendErrorKind, message: string, detail = "") {
    super(message);
    this.name = "DesktopBackendError";
    this.kind = kind;
    this.detail = detail;
  }
}

function getTauriGlobal(): TauriRuntimeGlobal | undefined {
  return typeof globalThis === "undefined"
    ? undefined
    : (globalThis as unknown as TauriRuntimeGlobal);
}

function getTauriInvoke(): TauriInvoke | null {
  const host = getTauriGlobal();
  if (!host) return null;
  if (typeof host.__TAURI_INTERNALS__?.invoke === "function") {
    return host.__TAURI_INTERNALS__.invoke.bind(host.__TAURI_INTERNALS__);
  }
  if (typeof host.__TAURI__?.core?.invoke === "function") {
    return host.__TAURI__.core.invoke.bind(host.__TAURI__.core);
  }
  return null;
}

export function isTauriDesktop(): boolean {
  const host = getTauriGlobal();
  if (!host) return false;
  return Boolean(
    host.isTauri === true ||
    typeof host.__TAURI_INTERNALS__?.invoke === "function" ||
    typeof host.__TAURI__?.core?.invoke === "function",
  );
}

export function isMacosTauriDesktop(): boolean {
  if (!isTauriDesktop() || typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || navigator.platform || navigator.userAgent || "";
  return /mac/i.test(platform) && !/iphone|ipad|ipod/i.test(platform);
}

export function isWindowsTauriDesktop(): boolean {
  if (!isTauriDesktop() || typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || navigator.platform || navigator.userAgent || "";
  return /win/i.test(platform);
}

export function getDesktopTitlebarInset(): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return 0;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--desktop-titlebar-inset")
    .trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeApiPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function joinApiUrl(baseUrl: string, path: string): string {
  const normalizedPath = normalizeApiPath(path);
  return baseUrl ? `${baseUrl}${normalizedPath}` : normalizedPath;
}

export function normalizeBackendBaseUrl(raw: unknown): string {
  if (typeof raw !== "string") {
    const detail = String(raw ?? "");
    throw new DesktopBackendError(
      "invalid_url",
      t("桌面后端返回了无效的地址：{0}", detail || "(empty)"),
      detail,
    );
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new DesktopBackendError(
      "invalid_url",
      t("桌面后端返回了无效的地址：{0}", "(empty)"),
      "",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new DesktopBackendError(
      "invalid_url",
      t("桌面后端返回了无效的地址：{0}", trimmed),
      trimmed,
    );
  }
  const isLoopbackHost = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:" ||
    !isLoopbackHost ||
    !parsed.port ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65535 ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new DesktopBackendError(
      "invalid_url",
      t("桌面后端返回了无效的地址：{0}", trimmed),
      trimmed,
    );
  }
  return parsed.origin;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Cancelled", "AbortError");
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function classifyBackendUrlError(error: unknown): DesktopBackendError {
  if (error instanceof DesktopBackendError) return error;
  const rawMessage = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : String(error ?? "");
  const detail = rawMessage.trim();
  const isClosed =
    /already shut down|exited unexpectedly|exited before becoming ready|closed stdout/i.test(detail);
  if (isClosed) {
    return new DesktopBackendError(
      "closed",
      detail
        ? t("桌面后端已停止运行：{0}", detail)
        : t("桌面后端已停止运行，请重启应用。"),
      detail,
    );
  }
  return new DesktopBackendError(
    "not_ready",
    detail
      ? t("桌面后端尚未就绪：{0}", detail)
      : t("桌面后端尚未就绪，请稍后重试。"),
    detail,
  );
}

let cachedBaseUrl: string | null = null;
let inFlightResolution: Promise<string> | null = null;
let resolutionGeneration = 0;
const responseGenerations = new WeakMap<Response, number>();
let desktopState: DesktopBackendState = BROWSER_STATE;
const stateListeners = new Set<() => void>();

function syncDesktopStateEnvironment(): DesktopBackendState {
  const desktop = isTauriDesktop();
  if (!desktop) {
    desktopState = BROWSER_STATE;
    return desktopState;
  }
  if (!desktopState.isDesktop) {
    desktopState = Object.freeze({
      isDesktop: true,
      phase: cachedBaseUrl ? "ready" : "connecting",
      baseUrl: cachedBaseUrl,
      error: null,
      closed: false,
    });
  }
  return desktopState;
}

function publishDesktopState(next: DesktopBackendState): void {
  if (
    desktopState.isDesktop === next.isDesktop &&
    desktopState.phase === next.phase &&
    desktopState.baseUrl === next.baseUrl &&
    desktopState.error === next.error &&
    desktopState.closed === next.closed
  ) {
    return;
  }
  desktopState = Object.freeze(next);
  for (const listener of stateListeners) listener();
}

export function getDesktopBackendState(): DesktopBackendState {
  return syncDesktopStateEnvironment();
}

export function subscribeDesktopBackendState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

export function invalidateBackendBaseUrl(): void {
  cachedBaseUrl = null;
  inFlightResolution = null;
  resolutionGeneration++;
}

async function invokeBackendUrl(): Promise<string> {
  const invoke = getTauriInvoke();
  if (!invoke) {
    throw new DesktopBackendError(
      "ipc_unavailable",
      t("桌面通信通道不可用，请重启应用。"),
    );
  }
  let raw: unknown;
  try {
    raw = await invoke<string>(BACKEND_URL_COMMAND);
  } catch (error) {
    throw classifyBackendUrlError(error);
  }
  return normalizeBackendBaseUrl(raw);
}

export function resolveBackendBaseUrl(options?: {
  forceRefresh?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const signal = options?.signal;
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal));
  }
  if (!isTauriDesktop()) {
    if (desktopState.isDesktop) publishDesktopState(BROWSER_STATE);
    return Promise.resolve("");
  }
  if (!options?.forceRefresh && cachedBaseUrl !== null) {
    return Promise.resolve(cachedBaseUrl);
  }
  if (options?.forceRefresh) {
    invalidateBackendBaseUrl();
  }
  if (!inFlightResolution) {
    const generation = ++resolutionGeneration;
    publishDesktopState({
      isDesktop: true,
      phase: "connecting",
      baseUrl: null,
      error: null,
      closed: false,
    });
    const task = invokeBackendUrl().then(
      baseUrl => {
        if (generation !== resolutionGeneration) return resolveBackendBaseUrl();
        cachedBaseUrl = baseUrl;
        publishDesktopState({
          isDesktop: true,
          phase: "ready",
          baseUrl,
          error: null,
          closed: false,
        });
        return baseUrl;
      },
      error => {
        if (generation !== resolutionGeneration) return resolveBackendBaseUrl();
        const classified = classifyBackendUrlError(error);
        cachedBaseUrl = null;
        publishDesktopState({
          isDesktop: true,
          phase: "error",
          baseUrl: null,
          error: classified.message,
          closed: classified.kind === "closed",
        });
        throw classified;
      },
    ).finally(() => {
      if (inFlightResolution === task) inFlightResolution = null;
    });
    // Prevent unhandled rejection if the sole caller aborts before IPC settles.
    void task.catch(() => {});
    inFlightResolution = task;
  }
  return awaitWithSignal(inFlightResolution, signal);
}

/** Return an API URL synchronously when already known (always in browser mode,
 * or in Tauri mode once `backend_url` has resolved). Returns `null` while the
 * Tauri desktop backend URL still needs to be resolved asynchronously. */
export function getCachedApiUrl(path: string): string | null {
  if (!isTauriDesktop()) return normalizeApiPath(path);
  return cachedBaseUrl !== null ? joinApiUrl(cachedBaseUrl, path) : null;
}

export async function resolveApiUrl(path: string, signal?: AbortSignal): Promise<string> {
  const syncUrl = getCachedApiUrl(path);
  if (syncUrl !== null) {
    if (signal?.aborted) throw abortReason(signal);
    return syncUrl;
  }
  const baseUrl = await resolveBackendBaseUrl({ signal });
  return joinApiUrl(baseUrl, path);
}

/** After a desktop transport/stream error, invalidate the cached URL and probe
 * `backend_url` so a closed or crashed sidecar reports its actual diagnostic. */
export async function probeDesktopBackendError(
  transportError?: unknown,
  signal?: AbortSignal,
): Promise<DesktopBackendError | null> {
  if (!isTauriDesktop()) return null;
  invalidateBackendBaseUrl();
  try {
    await resolveBackendBaseUrl({ signal });
    return null;
  } catch (error) {
    if (signal?.aborted) throw transportError ?? error;
    return classifyBackendUrlError(error);
  }
}

async function handleFetchFailure(
  path: string,
  init: RequestInit | undefined,
  usedBaseUrl: string | null,
  usedGeneration: number,
  error: unknown,
  retrySafe = false,
): Promise<Response> {
  const signal = init?.signal ?? undefined;
  if (signal?.aborted || !isTauriDesktop()) throw error;
  // A request from an older sidecar must not tear down a newer connection.
  if (usedGeneration === resolutionGeneration) invalidateBackendBaseUrl();
  let freshBaseUrl: string;
  try {
    do {
      freshBaseUrl = await resolveBackendBaseUrl({ signal });
    } while (isTauriDesktop() && freshBaseUrl !== cachedBaseUrl);
  } catch (backendError) {
    if (signal?.aborted) throw error;
    throw backendError;
  }
  if (retrySafe && freshBaseUrl && usedBaseUrl && freshBaseUrl !== usedBaseUrl) {
    try {
      return await fetchWithGeneration(joinApiUrl(freshBaseUrl, path), init, resolutionGeneration);
    } catch (retryError) {
      if (signal?.aborted) throw retryError;
      throw new DesktopBackendError(
        "disconnected",
        t("无法连接桌面后端服务，请重试或重启应用。"),
        retryError instanceof Error ? retryError.message : String(retryError),
      );
    }
  }
  throw new DesktopBackendError(
    "disconnected",
    t("无法连接桌面后端服务，请重试或重启应用。"),
    error instanceof Error ? error.message : String(error),
  );
}

async function resolveAndFetchApi(path: string, init?: RequestInit, retrySafe = false): Promise<Response> {
  const signal = init?.signal ?? undefined;
  await resolveBackendBaseUrl({ signal });
  // Recheck the cache after the await: another caller may have invalidated it.
  return fetchApi(path, init, { retrySafe });
}

function fetchWithGeneration(url: string, init: RequestInit | undefined, generation: number): Promise<Response> {
  return fetch(url, init).then(response => {
    responseGenerations.set(response, generation);
    return response;
  });
}

/** Centralized `/api/...` fetch transport. Retains synchronous relative URLs
 * in browser/Vite mode and waits for the Tauri `backend_url` IPC in desktop mode. */
export function fetchApi(path: string, init?: RequestInit, options: { retrySafe?: boolean } = {}): Promise<Response> {
  const signal = init?.signal ?? undefined;
  const syncUrl = getCachedApiUrl(path);
  if (syncUrl !== null) {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    const usedBaseUrl = cachedBaseUrl;
    const usedGeneration = resolutionGeneration;
    let responsePromise: Promise<Response>;
    try {
      responsePromise = fetchWithGeneration(syncUrl, init, usedGeneration);
    } catch (error) {
      return handleFetchFailure(path, init, usedBaseUrl, usedGeneration, error, options.retrySafe);
    }
    if (!isTauriDesktop()) return responsePromise;
    return responsePromise.catch(error => handleFetchFailure(path, init, usedBaseUrl, usedGeneration, error, options.retrySafe));
  }
  return resolveAndFetchApi(path, init, options.retrySafe);
}

export function getApiTransportGeneration(): number { return resolutionGeneration; }

/** A late response may still satisfy its caller, but cannot identify the current backend. */
export function isCurrentApiResponse(response: Response): boolean {
  const generation = responseGenerations.get(response);
  return generation === undefined || generation === resolutionGeneration;
}

export function resetApiBaseForTest(): void {
  cachedBaseUrl = null;
  inFlightResolution = null;
  resolutionGeneration++;
  const next = isTauriDesktop()
    ? Object.freeze({
        isDesktop: true,
        phase: "connecting" as const,
        baseUrl: null,
        error: null,
        closed: false,
      })
    : BROWSER_STATE;
  publishDesktopState(next);
}
