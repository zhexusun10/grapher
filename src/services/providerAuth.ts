import { t } from "../i18n";
import type { ThinkingLevel } from "../types";
import { withRequestTimeout } from "./requestTimeout";

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
  // Optional while an older Provider/Auth host is still running. Never infer
  // capabilities from model names or assume all reasoning levels are supported.
  thinkingLevels?: ThinkingLevel[];
  thinkingLevelFallbacks?: Partial<Record<ThinkingLevel, ThinkingLevel>>;
}
export interface ProviderCatalog { providers: ProviderInfo[]; models: ModelInfo[]; warning: string | null }
interface AuthPrompt { id: string; type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] }
interface AuthEvent { type: string; message?: string; url?: string; instructions?: string; userCode?: string; verificationUri?: string; links?: { url: string; label?: string }[] }
export interface LoginState { id: string; provider: string; status: "pending" | "complete" | "cancelled" | "failed"; events: AuthEvent[]; prompt: AuthPrompt | null; error: string | null }

function call<T>(operation: string, fields: Record<string, unknown> = {}): Promise<T> {
  // Catalog/preflight and polling are reads. Do not give interactive OAuth or
  // credential writes a metadata deadline or claim they were rolled back.
  if (operation === "catalog" || operation === "poll") {
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

export const providerAuth = {
  getCachedCatalog: () => cachedCatalog,
  setCachedCatalog: (catalog: ProviderCatalog | null) => {
    cachedCatalog = catalog;
    saveStorageCatalog(catalog);
  },
  catalog: async (refresh = false): Promise<ProviderCatalog> => {
    if (!refresh && cachedCatalog) {
      return cachedCatalog;
    }
    if (inFlightCatalog) {
      return inFlightCatalog;
    }
    inFlightCatalog = call<ProviderCatalog>("catalog", { refresh })
      .then((result) => {
        cachedCatalog = result;
        saveStorageCatalog(result);
        return result;
      })
      .finally(() => {
        inFlightCatalog = null;
      });
    return inFlightCatalog;
  },
  login: (provider: string, method: string) => call<LoginState>("login", { provider, method }),
  poll: async (id: string) => {
    const res = await call<LoginState>("poll", { id });
    if (res.status === "complete") {
      cachedCatalog = null;
      saveStorageCatalog(null);
    }
    return res;
  },
  respond: async (id: string, promptId: string, value: string) => {
    const res = await call<LoginState>("respond", { id, promptId, value });
    if (res.status === "complete") {
      cachedCatalog = null;
      saveStorageCatalog(null);
    }
    return res;
  },
  cancel: (id: string) => call<LoginState>("cancel", { id }),
  logout: async (provider: string) => {
    const res = await call<{ loggedOut: boolean }>("logout", { provider });
    cachedCatalog = null;
    saveStorageCatalog(null);
    return res;
  },
};
