import type { TokenUsage } from "../types";

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
