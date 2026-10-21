import type { SessionContext, TokenUsage } from "../types";
import { consumedTokenCount, formatContextUsage, formatTokenCount } from "../utils/tokenUsage";

/** Backend-reported usage for the session details panel.
 *  The newest attempt receives the whole resumed session's total; an older
 *  attempt receives only the usage accumulated through it (callers omit the
 *  block when that prefix is unknown). `context` is a per-attempt snapshot,
 *  shown against the model's window. */
export function SessionTokenUsage({ usage, context, showTokens = true }: {
  usage?: TokenUsage | null;
  context?: SessionContext | null;
  /** Older attempts omit an unknowable usage prefix but may still know context. */
  showTokens?: boolean;
}) {
  // The task total is uncached input plus one-time cache writes plus output.
  // Reasoning is a subset of output; cache reads only reuse the prompt and are
  // shown separately. `context window` is the prompt the session's newest turn
  // read, which is the one number that can be compared with the model window.
  if (!showTokens && !context) return null;
  return <>
    {showTokens && <>
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
    </>}
    <div className="session-details-row">
      <p>context window: {formatContextUsage(context)}</p>
    </div>
  </>;
}
