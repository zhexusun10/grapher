import type { TokenUsage } from "../types";
import { formatTokenCount } from "../utils/tokenUsage";

/** Backend-reported usage for the displayed execution or Planner turn. */
export function SessionTokenUsage({ usage }: { usage?: TokenUsage | null }) {
  // Keep the provider's total: reasoning may already be included in output.
  // Missing counters are unknown, not zero, and must not be inferred from logs.
  return <>
    <div className="session-details-row">
      <p>total tokens: {formatTokenCount(usage?.totalTokens)}</p>
      <p>input: {formatTokenCount(usage?.input)}</p>
      <p>output: {formatTokenCount(usage?.output)}</p>
    </div>
    <div className="session-details-row">
      <p>cache read: {formatTokenCount(usage?.cacheRead)}</p>
      <p>cache write: {formatTokenCount(usage?.cacheWrite)}</p>
      <p>reasoning: {formatTokenCount(usage?.reasoning)}</p>
    </div>
  </>;
}
