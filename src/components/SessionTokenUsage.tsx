import type { TokenUsage } from "../types";
import { consumedTokenCount, formatTokenCount } from "../utils/tokenUsage";

/** Backend-reported usage for the displayed execution or Planner turn. */
export function SessionTokenUsage({ usage }: { usage?: TokenUsage | null }) {
  // The task total is uncached input plus one-time cache writes plus output.
  // Reasoning is a subset of output; cache reads only reuse the prompt and are
  // shown separately, as is the provider total including cache reads.
  return <>
    <div className="session-details-row">
      <p>total tokens: {formatTokenCount(consumedTokenCount(usage))}</p>
      <p>input: {formatTokenCount(usage?.input)}</p>
      <p>output: {formatTokenCount(usage?.output)}</p>
    </div>
    <div className="session-details-row">
      <p>cache read: {formatTokenCount(usage?.cacheRead)}</p>
      <p>cache write: {formatTokenCount(usage?.cacheWrite)}</p>
      <p>reasoning: {formatTokenCount(usage?.reasoning)}</p>
    </div>
    <div className="session-details-row">
      <p>provider total (incl. cache): {formatTokenCount(usage?.totalTokens)}</p>
    </div>
  </>;
}
