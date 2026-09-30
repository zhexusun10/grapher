import { en } from "./en";

export type Locale = "zh-CN" | "en";
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

/** Localize application errors, never conversation content or tool/model output. */
export function localizeError(error: unknown, language: Locale = locale): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (language === "zh-CN" || !/\p{Script=Han}/u.test(message)) return message;
  const prefix = message.startsWith("Error: ") ? "Error: " : "";
  const text = prefix ? message.slice(prefix.length) : message;
  if (en[text]) return prefix + en[text];
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
      return prefix + english.replace(/\{(\d+)\}/g, (_, index: string) => values[Number(index)]);
    }
  }
  // Backend/native diagnostics may not have a UI translation. Keep the full
  // original in the console rather than exposing untranslated Chinese in English UI.
  console.warn("Untranslated application error:", message);
  return "The operation failed. Check the browser console for diagnostic details.";
}
