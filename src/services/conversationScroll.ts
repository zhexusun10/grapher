/** Scroll bookkeeping shared by the conversation pane.
 *
 * Node and Planner histories share one scroll container that is destroyed and
 * rebuilt when the active conversation changes. Without remembering where the
 * user was, every switch lands at the top of the freshly mounted container.
 * These helpers keep that decision in one place: a view the user explicitly
 * scrolled up in restores its offset, every other view follows the newest
 * output at the bottom (so history reads newest-first).
 */

/** Distance from the bottom (px) that still counts as "following the output".
 * Row measurement and the overlaid composer introduce a few px of drift, so a
 * hard zero check would misread the bottom as a deliberate scroll-up. */
export const CONVERSATION_BOTTOM_THRESHOLD = 35;

export interface ViewScrollState {
  scrollTop: number;
  isAtBottom: boolean;
  isUserScrolledUp: boolean;
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

/** Snapshot a view's position before the conversation switches away. */
export function captureViewScrollState(
  metrics: ScrollMetrics,
  isUserScrolledUp: boolean,
): ViewScrollState {
  const atBottom = distanceFromBottom(metrics) <= CONVERSATION_BOTTOM_THRESHOLD;
  return {
    scrollTop: metrics.scrollTop,
    isAtBottom: atBottom,
    // A "scrolled up" flag only matters while the user is actually away from
    // the bottom; growth-driven drift must not be remembered as a choice.
    isUserScrolledUp: isUserScrolledUp && !atBottom,
  };
}

export interface ResolvedViewScroll {
  /** Restore the exact saved offset instead of jumping to the bottom. */
  restoreSaved: boolean;
  scrollTop: number;
  isUserScrolledUp: boolean;
}

/** Decide where a view lands when it becomes visible again.
 *
 * @param saved the position captured when the view was last left
 * @param currentScrollHeight the container height at restore time; only used
 *   when falling back to the newest output. */
export function resolveViewScroll(
  saved: ViewScrollState | undefined,
  currentScrollHeight: number,
): ResolvedViewScroll {
  // Only a deliberate scroll-up is worth restoring. A view that merely grew
  // away from the bottom while following new output resumes at the bottom.
  if (saved && !saved.isAtBottom && saved.isUserScrolledUp) {
    return { restoreSaved: true, scrollTop: saved.scrollTop, isUserScrolledUp: true };
  }
  return { restoreSaved: false, scrollTop: currentScrollHeight, isUserScrolledUp: false };
}

/** Calculate the required scroll delta when toggling the workspace details panel.
 *
 * Expanding scrolls only the additional height required to reveal the panel if
 * it extends below the visible viewport, correctly handling in-flight animations
 * without double-counting current height. A disclosure taller than the viewport
 * cannot be revealed in full; stop at its anchor (the trigger row) instead of
 * chasing its bottom, which would push the trigger and the first rows out of view.
 * The reveal is also capped at one viewport so a stale anchor or viewport
 * measurement can never jump across the middle of a long conversation.
 * Collapsing never applies a programmatic scroll delta, allowing the panel to fold
 * into the button in place without ratcheting or shifting the conversation upward.
 */
export function calculateWorkspaceDetailsScrollDelta(
  nextOpen: boolean,
  currentAnimatorHeight: number,
  targetHeight: number,
  anchorTop: number,
  panelBottom: number,
  visibleTop: number,
  visibleBottom: number,
): number {
  if (!nextOpen) return 0;
  const additionalHeight = Math.max(0, targetHeight - currentAnimatorHeight);
  const futurePanelBottom = panelBottom + additionalHeight;
  const bottomOverflow = Math.max(0, futurePanelBottom - visibleBottom);
  const keepAnchorVisible = Math.max(0, anchorTop - visibleTop);
  const maxReveal = Math.max(0, visibleBottom - visibleTop);
  return Math.min(bottomOverflow, keepAnchorVisible, maxReveal);
}

