import { t } from "../i18n";
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
interface ModelInfo { provider: string; id: string; name: string; api: string; contextWindow: number; available: boolean }
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
export const providerAuth = {
  catalog: (refresh = false) => call<ProviderCatalog>("catalog", { refresh }),
  login: (provider: string, method: string) => call<LoginState>("login", { provider, method }),
  poll: (id: string) => call<LoginState>("poll", { id }),
  respond: (id: string, promptId: string, value: string) => call<LoginState>("respond", { id, promptId, value }),
  cancel: (id: string) => call<LoginState>("cancel", { id }),
  logout: (provider: string) => call<{ loggedOut: boolean }>("logout", { provider }),
};
