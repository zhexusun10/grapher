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
      .replace(/^Planner failed:\s*/i, "任务规划器 (Planner) 失败: ")
      .replace(
        /OAuth callback port \(1455\) is in use or restricted\. Check that port 1455 is free, or switch to API Key authentication\./i,
        "OAuth 回调端口 (1455) 已被占用或权限受限。请检查是否有其他程序占用该端口，或改用 API Key 方式登录。"
      );
  }

  const isBalance =
    /\b402\b/i.test(text) ||
    /insufficient\s*(?:balance|quota)/i.test(text) ||
    /quota\s*exceeded/i.test(text) ||
    /credit\s*(?:expired|exceeded|insufficient)/i.test(text);

  const isAuth =
    (/\b401\b/i.test(text) ||
    /invalid[_\s]*api[_\s]*key/i.test(text) ||
    /authentication\s*failed/i.test(text) ||
    /unauthorized/i.test(text)) &&
    !/1455|callback port/i.test(text);

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

const W303_REGEX =
  /^(?:W303:\s*)?If\s+<FEEDBACK>\s+from\s+(.+?)\s+to\s+(.+?)\s+is\s+applied,\s+the\s+target\s+and\s+dependency\s+descendants\s+will\s+be\s+invalidated:\s*(.+?)\.\s*Completed\s+results\s+must\s+be\s+recomputed;\s*(.+?)\s+continues\s+(?:from\s+its\s+own\s+conversation\s+history|its\s+conversation)\.\s*Nodes\s+outside\s+this\s+set\s+are\s+unaffected\.?$/i;

const W301_REGEX =
  /^(?:W301:\s*)?Nodes\s+(.+?)\s+have\s+identical\s+task\s+text;\s*they\s+may\s+duplicate\s+work\.\s*Confirm\s+that\s+this\s+is\s+intentional\.?$/i;

const W302_REGEX =
  /^(?:W302:\s*)?(.+?)\s+mentions\s+<FEEDBACK>\s+but\s+has\s+no\s+outgoing\s+feedback\s+edge;\s*the\s+marker\s+cannot\s+send\s+feedback\.?$/i;

const GENERIC_WARNING_CODE_REGEX = /^W\d+:\s*(.*)$/;

/** Localize execution graph plan warnings and strip machine diagnostic codes (e.g. W303). */
export function localizePlanWarning(warning: string, language: Locale = locale): string {
  const message = (warning ?? "").trim();
  const m303 = message.match(W303_REGEX);
  if (m303) {
    return translate(
      language,
      "若应用从 {0} 到 {1} 的 <FEEDBACK>，目标节点及其依赖后代将被置为失效：{2}。已完成的结果必须重新计算；{1} 将基于自己的会话历史继续执行。该集合之外的节点不受影响。",
      m303[1],
      m303[2],
      m303[3]
    );
  }
  const m301 = message.match(W301_REGEX);
  if (m301) {
    return translate(
      language,
      "节点 {0} 包含相同的任务描述，可能存在重复工作。请确认这是否符合预期。",
      m301[1]
    );
  }
  const m302 = message.match(W302_REGEX);
  if (m302) {
    return translate(
      language,
      "{0} 提及了 <FEEDBACK>，但没有向外发出的反馈边；该标记无法发送反馈。",
      m302[1]
    );
  }
  const generic = message.match(GENERIC_WARNING_CODE_REGEX);
  if (generic) {
    return generic[1];
  }
  return message;
}

/** Localize application errors, never conversation content or tool/model output. */
export function localizeError(error: unknown, language: Locale = locale): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (
    W303_REGEX.test(message) ||
    W301_REGEX.test(message) ||
    W302_REGEX.test(message) ||
    GENERIC_WARNING_CODE_REGEX.test(message)
  ) {
    return localizePlanWarning(message, language);
  }
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
