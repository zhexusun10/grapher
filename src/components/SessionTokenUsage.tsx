import type { SessionContext, TokenUsage } from "../types";
import { consumedTokenCount, formatContextUsed, formatContextWindow, formatTokenCount } from "../utils/tokenUsage";

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
  // `cumulative tokens` sum every model call of the Pi session; cache reads
  // only reuse the prompt and are shown separately. `context
  // window` is the model's capacity, while `current context` is the entire
  // retained conversation the newest model call received (after compaction),
  // not just the last message. The two measurements do not converge as a
  // session grows.
  if (!showTokens && !context) return null;
  return <>
    {showTokens && <>
      <div className="session-details-row">
        <p title="Cumulative new tokens across every model call in this session; cache reads are excluded. This is not the current prompt size.">cumulative tokens: {formatTokenCount(consumedTokenCount(usage))}</p>
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
      <p title="Context window advertised by the model used for this turn.">context window: {formatContextWindow(context)}</p>
      <p title="Entire conversation prompt the latest model call received, including all retained session history after compaction, with its share of the model window.">current context: {formatContextUsed(context)}</p>
    </div>
  </>;
}
