import { t } from "../i18n";
import type { ThinkingLevel } from "../types";
import { withRequestTimeout } from "./requestTimeout";

/**
 * Provider credentials are sent verbatim in HTTP header values, so anything
 * outside printable ASCII (Chinese, full-width symbols, line breaks) can never
 * authenticate. Reject it at entry instead of failing later inside a model
 * request, after the credential has already been stored.
 */
export function hasUnsupportedCredentialCharacters(value: string): boolean {
  return /[^\x20-\x7E]/.test(value);
}

interface ProviderMethod { id: "api_key" | "oauth"; name: string }
export interface ProviderInfo {
  id: string;
  name: string;
  methods: ProviderMethod[];
  configured: boolean;
  authType: string | null;
  authSource?: "stored" | "env" | null;
  authEnvVar?: string | null;
}
interface ModelInfo {
  provider: string; id: string; name: string; api: string; contextWindow: number; available: boolean;
  hidden?: boolean;
  // Optional while an older Provider/Auth host is still running. Never infer
  // capabilities from model names or assume all reasoning levels are supported.
  thinkingLevels?: ThinkingLevel[];
  thinkingLevelFallbacks?: Partial<Record<ThinkingLevel, ThinkingLevel>>;
}
export interface ProviderCatalog { providers: ProviderInfo[]; models: ModelInfo[]; warning: string | null; hiddenModels?: string[] }
export interface ModelVisibility { hiddenModels: string[] }
export interface ModelVisibilityChange { model: string; hidden: boolean }
interface AuthPrompt { id: string; type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] }
interface AuthEvent { type: string; message?: string; url?: string; instructions?: string; userCode?: string; verificationUri?: string; links?: { url: string; label?: string }[] }
export interface LoginState { id: string; provider: string; status: "pending" | "complete" | "cancelled" | "failed"; events: AuthEvent[]; prompt: AuthPrompt | null; error: string | null }

function call<T>(operation: string, fields: Record<string, unknown> = {}): Promise<T> {
  // Catalog/preflight and polling are reads. Do not give interactive OAuth or
  // credential writes a metadata deadline or claim they were rolled back.
  if (operation === "catalog" || operation === "poll" || operation === "model_visibility") {
    return withRequestTimeout(signal => callBody<T>(operation, fields, signal), 15_000, t("后端响应超时，请稍后重试。"));
  }
  return callBody<T>(operation, fields);
}

async function callBody<T>(operation: string, fields: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/provider_auth", {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
    body: JSON.stringify({ version: 1, operation, ...fields }), signal,
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error || "Provider/Auth Adapter unavailable");
  return body.result as T;
}
const CATALOG_STORAGE_KEY = "grapher_provider_catalog_cache";

function loadStorageCatalog(): ProviderCatalog | null {
  try {
    if (typeof sessionStorage !== "undefined") {
      const saved = sessionStorage.getItem(CATALOG_STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    }
  } catch {}
  return null;
}

function saveStorageCatalog(catalog: ProviderCatalog | null) {
  try {
    if (typeof sessionStorage !== "undefined") {
      if (catalog) {
        sessionStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(catalog));
      } else {
        sessionStorage.removeItem(CATALOG_STORAGE_KEY);
      }
    }
  } catch {}
}

let cachedCatalog: ProviderCatalog | null = loadStorageCatalog();
let inFlightCatalog: Promise<ProviderCatalog> | null = null;
const catalogListeners = new Set<() => void>();
let visibilityRevision = 0;
let knownHiddenModels = cachedCatalog?.hiddenModels;
let visibilityRead: Promise<ModelVisibility> | null = null;
const VISIBILITY_KEY = "grapher_model_visibility_changed";

function withVisibility(catalog: ProviderCatalog, hiddenModels: string[]): ProviderCatalog {
  const hidden = new Set(hiddenModels);
  return { ...catalog, hiddenModels, models: catalog.models.map(model => ({
    ...model, hidden: hidden.has(`${model.provider}/${model.id}`),
  })) };
}

function acceptVisibility(value: ModelVisibility) {
  if (!Array.isArray(value?.hiddenModels) || !value.hiddenModels.every(id => typeof id === "string")) throw new Error("Invalid model visibility response");
  visibilityRevision++;
  knownHiddenModels = value.hiddenModels;
  if (cachedCatalog) setCachedCatalog(withVisibility(cachedCatalog, value.hiddenModels));
  return value;
}

async function refreshModelVisibility() {
  if (visibilityRead) return visibilityRead;
  const revision = visibilityRevision;
  visibilityRead = call<ModelVisibility>("model_visibility").then(result => {
    if (revision === visibilityRevision) return acceptVisibility(result);
    return { hiddenModels: knownHiddenModels ?? [] };
  }).finally(() => { visibilityRead = null; });
  return visibilityRead;
}

if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key !== VISIBILITY_KEY || !event.newValue) return;
  try { acceptVisibility(JSON.parse(event.newValue)); } catch { /* Ignore unrelated/corrupt browser data. */ }
});

function setCachedCatalog(catalog: ProviderCatalog | null) {
  if (catalog === cachedCatalog) return;
  cachedCatalog = catalog;
  saveStorageCatalog(catalog);
  for (const listener of catalogListeners) listener();
}

export const providerAuth = {
  getCachedCatalog: () => cachedCatalog,
  subscribeCatalog: (listener: () => void) => {
    catalogListeners.add(listener);
    return () => { catalogListeners.delete(listener); };
  },
  setCachedCatalog,
  catalog: async (refresh = false): Promise<ProviderCatalog> => {
    if (!refresh && cachedCatalog) {
      // New backends expose global visibility. Re-read that small file rather
      // than reloading provider/model runtimes on every picker opening.
      if (cachedCatalog.hiddenModels !== undefined) await refreshModelVisibility();
      if (cachedCatalog) return cachedCatalog;
    }
    if (inFlightCatalog) {
      return inFlightCatalog;
    }
    const revision = visibilityRevision;
    inFlightCatalog = call<ProviderCatalog>("catalog", { refresh })
      .then((result) => {
        const current = revision !== visibilityRevision && knownHiddenModels
          ? withVisibility(result, knownHiddenModels) : result;
        knownHiddenModels = current.hiddenModels;
        setCachedCatalog(current);
        return current;
      })
      .finally(() => {
        inFlightCatalog = null;
      });
    return inFlightCatalog;
  },
  setModelVisibility: async (changes: ModelVisibilityChange[], reset = false): Promise<ModelVisibility> => {
    const result = await withRequestTimeout(signal => callBody<ModelVisibility>("set_model_visibility", { changes, reset }, signal),
      15_000, t("保存模型可见性超时，请刷新确认后再重试。"));
    acceptVisibility(result);
    try { localStorage.setItem(VISIBILITY_KEY, JSON.stringify({ ...result, updatedAt: Date.now() })); } catch {}
    return result;
  },
  login: (provider: string, method: string) => call<LoginState>("login", { provider, method }),
  poll: async (id: string) => {
    const res = await call<LoginState>("poll", { id });
    if (res.status === "complete") setCachedCatalog(null);
    return res;
  },
  respond: async (id: string, promptId: string, value: string) => {
    const res = await call<LoginState>("respond", { id, promptId, value });
    if (res.status === "complete") setCachedCatalog(null);
    return res;
  },
  cancel: (id: string) => call<LoginState>("cancel", { id }),
  logout: async (provider: string) => {
    const res = await call<{ loggedOut: boolean }>("logout", { provider });
    setCachedCatalog(null);
    return res;
  },
};
