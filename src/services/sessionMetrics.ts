import type { Execution, GraphEvent, PlanningSummary, TokenUsage } from "../types";
import { PLANNER_TURN_EVENTS } from "../lib/plannerOutput";

/** Whole-session metrics for one Pi conversation.
 *
 * A Pi session file is resumed by later turns: Planner follow-ups, node
 * follow-ups and retries append to the same session instead of starting over.
 * The session details panel therefore reports the first turn's start, the
 * accumulated active time, and the session's token usage, all grouped by the
 * same session identity. */
export interface SessionTiming {
  /** Wall clock of the first attempt that belongs to this session. */
  startedAt?: number;
  /** Active seconds of every other attempt in the session, excluding the
   * attempt whose own duration the panel displays separately. */
  priorDurationSeconds: number;
}

const EMPTY_TIMING: SessionTiming = { priorDurationSeconds: 0 };

const positiveMs = (value?: string | number | null): number | undefined => {
  const ms = typeof value === "string" ? Number(value) : value;
  return ms != null && Number.isFinite(ms) && ms > 0 ? ms : undefined;
};

/** Active seconds of one Execution; a running attempt reports 0 here so the
 * caller's live clock can add its elapsed time without double counting. */
export function executionDurationSeconds(execution?: Execution | null): number {
  if (!execution?.startedAt || execution.completedAt == null) return 0;
  if (execution.metrics?.durationSeconds != null && execution.metrics.durationSeconds > 0) {
    return execution.metrics.durationSeconds;
  }
  return Math.max(0, (execution.completedAt - execution.startedAt) / 1000);
}

/** Attempts of the displayed Execution's Pi session, oldest first. */
export function executionSessionAttempts(
  executions: readonly Execution[],
  current?: Execution | null,
): Execution[] {
  if (!current) return [];
  const session = current.sessionId
    ? executions.filter(execution => execution.sessionId === current.sessionId)
    : [];
  if (!session.some(execution => execution.id === current.id)) session.push(current);
  // Stable sort: equal timestamps keep the backend's attempt order.
  return session.sort((a, b) => a.startedAt - b.startedAt);
}

/** Aggregate one selected Execution with the other attempts of its session. */
export function executionSessionTiming(
  executions: readonly Execution[],
  current?: Execution | null,
): SessionTiming {
  if (!current) return EMPTY_TIMING;
  const session = executionSessionAttempts(executions, current);
  const starts = session.map(execution => positiveMs(execution.startedAt)).filter((ms): ms is number => ms != null);
  const priorDurationSeconds = session.reduce((sum, execution) =>
    execution.id === current.id ? sum : sum + executionDurationSeconds(execution), 0);
  return {
    startedAt: starts.length ? Math.min(...starts) : positiveMs(current.startedAt),
    priorDurationSeconds,
  };
}

// Progress events are needed too: a turn must be timed before it settles. The
// settled/committed kinds stay shared with the transcript's turn list.
const PLANNER_SUMMARY_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...PLANNER_TURN_EVENTS,
  "planning_started", "planning_failed",
  "planner_review_finished", "planner_workspace_selected",
]);

/** Every Planner turn of the Run, in conversation order.
 *
 * Later events for the same attempt carry more complete summaries (workspace
 * selection, then the committed/failed result), so the newest value wins while
 * the first appearance decides its place in the conversation. */
export function plannerTurnSummaries(
  events: readonly Pick<GraphEvent, "type" | "planning">[],
): PlanningSummary[] {
  const order: string[] = [];
  const byId = new Map<string, PlanningSummary>();
  for (const event of events) {
    if (!event.type || !PLANNER_SUMMARY_EVENT_TYPES.has(event.type)) continue;
    const planning = event.planning;
    if (!planning?.planningId) continue;
    if (!byId.has(planning.planningId)) order.push(planning.planningId);
    byId.set(planning.planningId, planning);
  }
  return order
    .map((id, index) => ({ planning: byId.get(id)!, index }))
    // Recovery can append an older aborted attempt after later turns.
    .sort((a, b) => ((a.planning.createdAt ?? 0) - (b.planning.createdAt ?? 0)) || (a.index - b.index))
    .map(entry => entry.planning);
}

const plannerCompleteness = (turn: PlanningSummary): number => {
  const planner = turn.roles?.planner;
  return (planner?.sessionStart ? 4 : 0) + (planner?.durationSeconds ? 2 : 0) + (turn.status === "running" ? 0 : 1);
};

/** Fold the displayed/recovered summary into the event-derived turn list. */
export function mergePlannerTurns(
  turns: readonly PlanningSummary[],
  extras: ReadonlyArray<PlanningSummary | null | undefined>,
): PlanningSummary[] {
  const merged = [...turns];
  const index = new Map(merged.map((turn, position) => [turn.planningId, position]));
  for (const extra of extras) {
    if (!extra?.planningId) continue;
    const existing = index.get(extra.planningId);
    if (existing === undefined) {
      index.set(extra.planningId, merged.length);
      merged.push(extra);
    } else if (plannerCompleteness(extra) >= plannerCompleteness(merged[existing])) {
      // A stale running summary must not erase a settled turn's session start.
      merged[existing] = extra;
    }
  }
  // Recovery can append a summary for an older attempt after later turns.
  // Usage prefixes treat the final element as the newest, so restore order.
  const positions = new Map(merged.map((turn, position) => [turn.planningId, position]));
  return merged.sort((a, b) => ((a.createdAt ?? 0) - (b.createdAt ?? 0))
    || (positions.get(a.planningId)! - positions.get(b.planningId)!));
}

const plannerSessionId = (turn?: PlanningSummary | null): string | undefined =>
  turn?.roles?.planner?.sessionId || undefined;

const plannerSessionStart = (turn: PlanningSummary): number | undefined =>
  positiveMs(turn.roles?.planner?.sessionStart);

const plannerDurationSeconds = (turn: PlanningSummary): number => {
  const duration = turn.roles?.planner?.durationSeconds;
  return duration != null && Number.isFinite(duration) && duration > 0 ? duration : 0;
};

/** Turns of the displayed Planner turn's Pi session, in conversation order.
 *
 * `latestId: null` means a live turn that has not been recorded yet; the
 * newest recorded turn then supplies the session identity. Summaries written
 * before session IDs existed stay in the same legacy conversation. */
function plannerSessionAttempts(
  turns: readonly PlanningSummary[],
  latestId?: string | null,
): { attempts: PlanningSummary[]; anchor?: PlanningSummary } {
  const anchor = latestId === null ? undefined
    : latestId
      ? turns.find(turn => turn.planningId === latestId)
      : turns[turns.length - 1];
  const sessionId = plannerSessionId(anchor ?? turns[turns.length - 1])
    ?? [...turns].reverse().map(plannerSessionId).find(Boolean);
  const attempts = sessionId
    ? turns.filter(turn => !plannerSessionId(turn) || plannerSessionId(turn) === sessionId)
    : [...turns];
  if (anchor && !attempts.some(turn => turn.planningId === anchor.planningId)) attempts.push(anchor);
  return { attempts, anchor };
}

/** Aggregate the Planner turns that share the displayed turn's Pi session.
 *
 * Summaries written before session IDs existed are treated as part of the same
 * (legacy) conversation; turns that name a different session stay excluded, so
 * an edited conversation does not inherit the abandoned branch's start time. */
export function plannerSessionTiming(
  turns: readonly PlanningSummary[],
  options: { latestId?: string | null; fallbackStartedAt?: number } = {},
): SessionTiming {
  const fallbackStartedAt = options.fallbackStartedAt;
  if (!turns.length) return fallbackStartedAt ? { startedAt: fallbackStartedAt, priorDurationSeconds: 0 } : EMPTY_TIMING;
  const { attempts, anchor } = plannerSessionAttempts(turns, options.latestId);
  const latestId = anchor?.planningId;
  // Prefer the process start; a legacy/failed summary without one still
  // contributes the attempt's durable creation time.
  const starts = attempts
    .map(turn => plannerSessionStart(turn) ?? positiveMs(turn.createdAt))
    .filter((ms): ms is number => ms != null);
  const priorDurationSeconds = attempts.reduce((sum, turn) =>
    latestId && turn.planningId === latestId ? sum : sum + plannerDurationSeconds(turn), 0);
  return {
    startedAt: starts.length ? Math.min(...starts) : positiveMs(fallbackStartedAt),
    priorDurationSeconds,
  };
}

/** Cumulative session usage through the attempt a details panel displays.
 *
 * A session total would include work that happened after an older attempt, so
 * an older attempt shows only its own prefix. `complete` is false when any
 * attempt in that prefix lacks usage; callers must then omit token details
 * instead of presenting a partial sum. `latest` tells callers that the
 * backend's authoritative whole-session total is still appropriate. */
export interface SessionUsageThrough {
  usage?: TokenUsage;
  latest: boolean;
  complete: boolean;
}

const emptyUsage = (): TokenUsage => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, consumedTokens: 0,
});

function sumUsage(usages: readonly TokenUsage[]): TokenUsage {
  const total = emptyUsage();
  for (const usage of usages) {
    total.input += usage.input ?? 0;
    total.output += usage.output ?? 0;
    total.cacheRead += usage.cacheRead ?? 0;
    total.cacheWrite += usage.cacheWrite ?? 0;
    total.reasoning += usage.reasoning ?? 0;
    total.totalTokens += usage.totalTokens ?? 0;
  }
  // Consumed tokens are defined as the one-time parts of this sum; per-attempt
  // fields stay authoritative for their own rows but need not all exist.
  total.consumedTokens = total.input + total.output + total.cacheWrite;
  return total;
}

/** Usage of the displayed Execution and every earlier attempt of its session. */
export function executionSessionUsageThrough(
  executions: readonly Execution[],
  current?: Execution | null,
): SessionUsageThrough {
  if (!current) return { latest: false, complete: false };
  const attempts = executionSessionAttempts(executions, current);
  const index = attempts.findIndex(execution => execution.id === current.id);
  if (index < 0) return { latest: false, complete: false };
  const latest = index === attempts.length - 1;
  const through = attempts.slice(0, index + 1);
  if (through.some(execution => !execution.metrics?.usage)) return { latest, complete: false };
  return { latest, complete: true, usage: sumUsage(through.map(execution => execution.metrics!.usage)) };
}

/** Usage of the displayed Planner turn and every earlier turn of its session. */
export function plannerSessionUsageThrough(
  turns: readonly PlanningSummary[],
  latestId?: string | null,
): SessionUsageThrough {
  if (!turns.length) return { latest: true, complete: false };
  const { attempts, anchor } = plannerSessionAttempts(turns, latestId);
  // The live turn has no recorded usage yet; the backend total is still the
  // authoritative whole-session value.
  if (!anchor) return { latest: true, complete: false };
  const index = attempts.findIndex(turn => turn.planningId === anchor.planningId);
  if (index < 0) return { latest: false, complete: false };
  const latest = index === attempts.length - 1;
  const through = attempts.slice(0, index + 1);
  const usages = through.map(turn => turn.roles?.planner?.usage);
  if (usages.some(usage => !usage)) return { latest, complete: false };
  return { latest, complete: true, usage: sumUsage(usages as TokenUsage[]) };
}

/** Usage of Planner turns recorded before Pi session IDs were tracked.
 *
 * Backend session buckets cannot include those turns, but the displayed
 * conversation still contains them; callers add this sum to the newest
 * attempt's backend total. A legacy turn without usage makes the sum
 * unknowable, so it is omitted rather than under-reporting. `undefined` also
 * means there is nothing to add. */
export function plannerLegacyUsage(
  turns: readonly PlanningSummary[],
  latestId?: string | null,
): TokenUsage | undefined {
  const { attempts } = plannerSessionAttempts(turns, latestId);
  const legacy = attempts.filter(turn => !plannerSessionId(turn));
  if (!legacy.length) return undefined;
  const usages = legacy.map(turn => turn.roles?.planner?.usage);
  if (usages.some(usage => !usage)) return undefined;
  return sumUsage(usages as TokenUsage[]);
}

/** Add another reporting window to an existing session total. */
export function addTokenUsage(base: TokenUsage, extra: TokenUsage): TokenUsage {
  const total: TokenUsage = {
    input: (base.input ?? 0) + (extra.input ?? 0),
    output: (base.output ?? 0) + (extra.output ?? 0),
    cacheRead: (base.cacheRead ?? 0) + (extra.cacheRead ?? 0),
    cacheWrite: (base.cacheWrite ?? 0) + (extra.cacheWrite ?? 0),
    reasoning: (base.reasoning ?? 0) + (extra.reasoning ?? 0),
    totalTokens: (base.totalTokens ?? 0) + (extra.totalTokens ?? 0),
    consumedTokens: 0,
  };
  total.consumedTokens = total.input + total.output + total.cacheWrite;
  return total;
}
