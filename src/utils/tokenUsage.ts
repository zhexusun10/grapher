import type { SessionContext, TokenUsage } from "../types";

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

/**
 * Totals for the whole Pi session, not one attempt of it: a follow-up or retry
 * resumes the same session file, so its usage keeps accumulating there. The
 * backend aggregates the per-session totals from every Execution and Planner
 * turn that wrote to that session.
 */
export function sessionTokenUsage(
  sessionUsage: Record<string, TokenUsage> | undefined | null,
  sessionId?: string | null,
): TokenUsage | undefined {
  if (!sessionUsage || !sessionId || !Object.hasOwn(sessionUsage, sessionId)) return undefined;
  return sessionUsage[sessionId];
}

/** Same lookup for the session's context snapshot, which never accumulates. */
export function sessionContext(
  sessionContexts: Record<string, SessionContext> | undefined | null,
  sessionId?: string | null,
): SessionContext | undefined {
  if (!sessionContexts || !sessionId || !Object.hasOwn(sessionContexts, sessionId)) return undefined;
  return sessionContexts[sessionId];
}

/** Context recorded by one attempt. A session-level context always describes
 * its newest turn, so an older attempt must use this instead. */
export function attemptSessionContext(
  metrics?: { contextTokens?: number; contextPeak?: number; contextUsage?: SessionContext } | null,
): SessionContext | undefined {
  const safe = (value?: number) => Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number : undefined;
  if (metrics?.contextUsage) {
    const tokens = safe(metrics.contextUsage.tokens) ?? 0;
    const peak = safe(metrics.contextUsage.peak) ?? 0;
    const window = safe(metrics.contextUsage.window);
    return { tokens, peak: Math.max(tokens, peak), ...(window ? { window } : {}) };
  }
  const tokens = safe(metrics?.contextTokens);
  const peak = safe(metrics?.contextPeak);
  // Older checkpoints carry no context counters; do not invent a zero entry.
  if (!tokens && !peak) return undefined;
  return { tokens: tokens ?? 0, peak: Math.max(tokens ?? 0, peak ?? 0) };
}

const knownCount = (value?: number): value is number =>
  value != null && Number.isSafeInteger(value) && value > 0;

/** The model's context window for the turn, when the catalog knows it. */
export function formatContextWindow(context?: SessionContext | null): string {
  const windowTokens = context?.window;
  return knownCount(windowTokens) ? formatTokenCount(windowTokens) : "—";
}

/**
 * Pi's estimate of the retained session context, including trailing messages
 * and context edits. Older logs only have the last model call's usage. This is
 * not cumulative: each call re-reads the prefix. Zero or missing is unknown.
 */
export function formatContextUsed(context?: SessionContext | null): string {
  const tokens = context?.tokens;
  if (!knownCount(tokens)) return "—";
  const used = formatTokenCount(tokens);
  const windowTokens = context?.window;
  if (!knownCount(windowTokens)) return used;
  return `${used} (${Math.round(tokens / windowTokens * 100)}%)`;
}
