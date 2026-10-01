import { en } from "./en.ts";

type Locale = "zh-CN" | "en";
export type LanguagePreference = "auto" | Locale;
export const LANGUAGE_PREFERENCE_KEY = "grapher_language_v1";

export function readLanguagePreference(storage?: Pick<Storage, "getItem">): LanguagePreference {
  try {
    const value = (storage ?? (typeof localStorage === "undefined" ? undefined : localStorage))
      ?.getItem(LANGUAGE_PREFERENCE_KEY);
    return value === "zh-CN" || value === "en" ? value : "auto";
  } catch {
    return "auto";
  }
}

/** Follow the primary browser/system language, not a secondary fallback language. */
export function detectLocale(languages?: readonly string[], language?: string): Locale {
  const primary = languages?.find(value => value.trim()) || language || "en";
  return /^zh(?:[-_]|$)/i.test(primary.trim()) ? "zh-CN" : "en";
}

export function resolveLocale(preference: LanguagePreference, languages?: readonly string[], language?: string): Locale {
  return preference === "auto" ? detectLocale(languages, language) : preference;
}

export const languagePreference = readLanguagePreference();
export const locale: Locale = resolveLocale(languagePreference,
  typeof navigator === "undefined" ? undefined : navigator.languages,
  typeof navigator === "undefined" ? undefined : navigator.language);

/** Called only after confirmation. Persist first; storage failure must not reload. */
export function restartFrontendWithLanguage(
  preference: LanguagePreference,
  storage: Pick<Storage, "setItem" | "removeItem"> = localStorage,
  reload: () => void = () => window.location.reload(),
): void {
  if (preference === "auto") storage.removeItem(LANGUAGE_PREFERENCE_KEY);
  else storage.setItem(LANGUAGE_PREFERENCE_KEY, preference);
  reload();
}

export function translate(language: Locale, key: string, ...values: unknown[]): string {
  const text = language === "zh-CN" ? key : (en[key] ?? key);
  // Replace once: user-provided values (including braces, code and Chinese) stay intact.
  return text.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : placeholder);
}

export function t(key: string, ...values: unknown[]): string {
  return translate(locale, key, ...values);
}

function annotateProviderError(message: string, language: Locale): string {
  if (!message) return message;

  let text = message;
  if (language === "zh-CN") {
    text = text
      .replace(/^Partitioner failed:\s*/i, "任务分片器 (Partitioner) 失败: ")
      .replace(/^Planner failed:\s*/i, "任务规划器 (Planner) 失败: ");
  }

  const isBalance =
    /\b402\b/i.test(text) ||
    /insufficient\s*(?:balance|quota)/i.test(text) ||
    /quota\s*exceeded/i.test(text) ||
    /credit\s*(?:expired|exceeded|insufficient)/i.test(text);

  const isAuth =
    /\b401\b/i.test(text) ||
    /invalid[_\s]*api[_\s]*key/i.test(text) ||
    /authentication\s*failed/i.test(text) ||
    /unauthorized/i.test(text);

  const isRateLimit =
    /\b429\b/i.test(text) ||
    /rate[_\s]*limit/i.test(text) ||
    /too\s*many\s*requests/i.test(text);

  const isAbortCode = /0xc0000409/i.test(text);

  let hint = "";
  if (isBalance) {
    hint =
      language === "zh-CN"
        ? "提示：模型服务商账户余额不足或额度耗尽 (Insufficient Balance)，请充值或在设置中更换可用模型。"
        : "Tip: Model provider account balance or quota is insufficient (Insufficient Balance). Please recharge or switch models in settings.";
  } else if (isAuth) {
    hint =
      language === "zh-CN"
        ? "提示：服务商认证失败或 API Key 无效，请在模型设置中检查配置。"
        : "Tip: Provider authentication failed or API key is invalid. Please check your model settings.";
  } else if (isRateLimit) {
    hint =
      language === "zh-CN"
        ? "提示：已超出服务商调用频率限制 (Rate Limit)，请稍后重试。"
        : "Tip: Provider rate limit exceeded. Please retry later.";
  } else if (isAbortCode && !text.includes("402") && !text.includes("Insufficient")) {
    hint =
      language === "zh-CN"
        ? "提示：子进程异常退出 (0xc0000409)，通常由服务商 API 调用报错中止或运行时异常导致。"
        : "Tip: Process aborted with exit code 0xc0000409, typically caused by a provider API error or runtime abort.";
  }

  if (hint && !text.includes(hint)) {
    return `${text}\n${hint}`;
  }
  return text;
}

/** Localize application errors, never conversation content or tool/model output. */
export function localizeError(error: unknown, language: Locale = locale): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (language === "zh-CN") return annotateProviderError(message, language);
  if (!/\p{Script=Han}/u.test(message)) return annotateProviderError(message, language);
  const prefix = message.startsWith("Error: ") ? "Error: " : "";
  const text = prefix ? message.slice(prefix.length) : message;
  if (en[text]) return annotateProviderError(prefix + en[text], language);
  for (const [key, english] of Object.entries(en)) {
    if (!/\{\d+\}/.test(key)) continue;
    const indices: number[] = [];
    const escaped = key.split(/(\{\d+\})/).map(part => {
      if (/^\{\d+\}$/.test(part)) {
        indices.push(Number(part.slice(1, -1)));
        return "([\\s\\S]*?)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("");
    const match = text.match(new RegExp(`^${escaped}$`));
    if (match) {
      const values: string[] = [];
      indices.forEach((index, i) => { values[index] = localizeError(match[i + 1], language); });
      return annotateProviderError(
        prefix + english.replace(/\{(\d+)\}/g, (_, index: string) => values[Number(index)]),
        language
      );
    }
  }
  // Backend/native diagnostics may not have a UI translation. Keep the full
  // original in the console rather than exposing untranslated Chinese in English UI.
  console.warn("Untranslated application error:", message);
  return annotateProviderError("The operation failed. Check the browser console for diagnostic details.", language);
}
