import type { TokenUsage } from "../types";

/** Pi reports uncached input separately from cache reads and cache writes. */
export function consumedTokenCount(usage?: TokenUsage | null): number | undefined {
  if (!usage) return undefined;
  // Prefer the backend field when present and non-zero. A zero from an old
  // checkpoint may only mean the field was absent, so validate the counters.
  const consumed = usage.consumedTokens;
  if (typeof consumed === "number" && Number.isSafeInteger(consumed) && consumed > 0) return consumed;
  // A cache write is one-time new input; a cache read only reuses a prompt.
  const cacheWrite = usage.cacheWrite ?? 0;
  if (![usage.input, usage.output, cacheWrite].every(value => Number.isSafeInteger(value) && value >= 0)) return undefined;
  const total = usage.input + usage.output + cacheWrite;
  return Number.isSafeInteger(total) ? total : undefined;
}

export function formatTokenCount(value?: number): string {
  if (value == null || !Number.isSafeInteger(value) || value < 0) return "—";

  if (value > 0 && value < 10) return "<0.01k";
  const thousands = Math.round(value / 10) / 100;
  // Promote rounded values too, so the display never reaches 1000k.
  const useMillions = thousands >= 1_000;
  const count = useMillions ? value / 1_000_000 : thousands;
  return `${count.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 2 })}${useMillions ? "M" : "k"}`;
}

/** Pi reports uncached input, cache reads and cache writes separately. */
export function formatCacheHitRate(usage?: TokenUsage | null): string {
  if (!usage || ![usage.input, usage.cacheRead, usage.cacheWrite]
    .every(value => Number.isSafeInteger(value) && value >= 0)) return "—";

  const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;
  if (!Number.isSafeInteger(totalInput)) return "—";
  return `${totalInput > 0 ? Math.round(usage.cacheRead / totalInput * 100) : 0}%`;
}
