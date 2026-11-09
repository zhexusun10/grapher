import { CONVERSATION_BOTTOM_THRESHOLD } from "./conversationScroll";

export const HISTORY_PREPEND_EVENT = "grapher:history-prepend";
export const FOLLOW_LATEST_EVENT = "grapher:follow-latest";
/** A virtualized row-height correction moved the outer viewport; it is not a
 * reader scrolling back down to the latest output. */
export const TRANSCRIPT_SCROLL_ADJUSTED_EVENT = "grapher:transcript-scroll-adjusted";

export function transcriptScrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let parent = element?.parentElement; parent; parent = parent.parentElement) {
    if (/^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/** Lock following before a prepend commits. The virtualizer preserves the visible
 * row by ID; using scrollHeight deltas here would also count concurrent live output. */
export function markTranscriptPrepend(element: HTMLElement | null): void {
  const parent = transcriptScrollParent(element);
  if (!parent) return;
  parent.dataset.transcriptHistoryReading = "true";
  parent.dispatchEvent(new Event(HISTORY_PREPEND_EVENT));
}

/** A background fill can start while the view follows the bottom, before the
 * reader scrolls up. Decide again when its page commits: if the reader has
 * taken over, lock the prepend so row estimates cannot jump them through the
 * newly loaded history. A still-pinned view keeps following the bottom. */
export function markTranscriptPrependIfReading(element: HTMLElement | null): void {
  const parent = transcriptScrollParent(element);
  if (!parent || parent.dataset.transcriptScrollMode === "latest" ||
      parent.dataset.transcriptFollowing === "true" ||
      parent.dataset.transcriptPreparing === "true") return;
  if (parent.scrollHeight - parent.scrollTop - parent.clientHeight <= CONVERSATION_BOTTOM_THRESHOLD) return;
  markTranscriptPrepend(element);
}

/** Vertical scrolling chains to the conversation at a card's edge. Contain
 * horizontal scrolling only when the card actually overflows horizontally:
 * containment on an axis with no scroll range would swallow that gesture. */
export function syncOverscrollContainment(element: HTMLElement | null): void {
  if (!element) return;
  const horizontal = element.scrollWidth > element.clientWidth + 1;
  element.style.overscrollBehaviorY = "auto";
  element.style.overscrollBehaviorX = horizontal ? "contain" : "auto";
}

/** True when a nested scroll area can consume this gesture, or explicitly
 * contains it at its boundary. A chained gesture belongs to the conversation,
 * which must stop following before the browser applies the outer scroll.
 * Touch callers supply the change in scroll direction from consecutive events. */
export function isNestedScrollGesture(event: Event, scroller: HTMLElement | null, touchDeltaY?: number): boolean {
  if (!scroller || typeof getComputedStyle !== "function") return false;
  let direction = touchDeltaY ?? 0;
  if (event.type === "wheel") direction = (event as WheelEvent).deltaY;
  else if (event.type === "keydown") {
    const key = (event as KeyboardEvent).key;
    direction = ["ArrowUp", "PageUp", "Home"].includes(key) || (key === " " && (event as KeyboardEvent).shiftKey) ? -1
      : ["ArrowDown", "PageDown", "End", " "].includes(key) ? 1 : 0;
  }
  let node = event.target as HTMLElement | null;
  if (!node || typeof node.closest !== "function") return false;
  for (; node && node !== scroller; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (!/^(auto|scroll|overlay)$/.test(style.overflowY) || node.scrollHeight <= node.clientHeight + 1) continue;
    // scrollHeight/clientHeight are rounded integers even when the browser's
    // actual scroll range is fractional, so allow a 1px boundary tolerance.
    const canScroll = direction < 0 ? node.scrollTop > 1
      : direction > 0 ? node.scrollTop < node.scrollHeight - node.clientHeight - 1 : true;
    if (canScroll || style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none") return true;
  }
  return false;
}

/** Tell the conversation that streamed card content grew. The owner can pin a
 * following viewport even when no row or scrollHeight change is observed by
 * its generic resize path (for example while a thinking body scrolls inside a
 * fixed-height card). */
export const TRANSCRIPT_CONTENT_GROWTH_EVENT = "grapher:transcript-content-growth";

/** The actual insertion point, including revisions with no mounted rows. Tool
 * and user row IDs do not necessarily contain the revision ID, and virtualized
 * rows can be unmounted, so neither is a reliable boundary. */
export function olderInsertionTop(element: HTMLElement | null, source?: string): number | null {
  if (!element) return null;
  if (source) {
    for (const boundary of element.querySelectorAll<HTMLElement>("[data-transcript-source-start]")) {
      if (boundary.dataset.transcriptSourceStart === source) return boundary.getBoundingClientRect().top;
    }
  }
  const list = element.querySelector<HTMLElement>(".virtualized-transcript-container") ?? element;
  return list.getBoundingClientRect().top;
}

/** Older bytes are inserted above the rows their revision already has, so the
 * layout grows above the viewport and the virtualizer compensates the scroll
 * position to keep the reader's rows in place. Committing that while the reader
 * is still inside the loaded history moves the scroll position under their
 * gesture, which reads as being pulled back. A fetched page therefore becomes
 * part of the layout only once the reader has scrolled to its insertion point -
 * the history is extended where they stopped, never somewhere above them. A view
 * that is following the newest output is at that end already. */
export function olderPageFits(element: HTMLElement | null, source?: string): boolean {
  const scroller = transcriptScrollParent(element);
  if (!scroller) return true;
  // A view that follows the newest output is anchored at its end, so the page
  // lands there without a gesture to fight.
  if (scroller.dataset.transcriptFollowing === "true" || scroller.dataset.transcriptPreparing === "true") return true;
  const top = olderInsertionTop(element, source);
  if (top === null) return true;
  return top >= scroller.getBoundingClientRect().top + scroller.clientTop - 1;
}

/** Calls `run` whenever the shared scroller moves, so a held page can land as
 * soon as the reader reaches its insertion point. */
export function onTranscriptScroll(element: HTMLElement | null, run: () => void): () => void {
  const scroller = transcriptScrollParent(element);
  if (!scroller) return () => {};
  scroller.addEventListener("scroll", run, { passive: true });
  return () => scroller.removeEventListener("scroll", run);
}

export function notifyTranscriptContentGrowth(element: HTMLElement | null): void {
  transcriptScrollParent(element)?.dispatchEvent(new Event(TRANSCRIPT_CONTENT_GROWTH_EVENT));
}

/** New or visibly growing assistant output, including an already-completed
 * forward read. Its owner may recover a layout-induced scroll-up without
 * mistaking the initial mount of historical text for new output. */
export const TRANSCRIPT_FINAL_OUTPUT_EVENT = "grapher:transcript-final-output";

export function notifyTranscriptFinalOutput(element: HTMLElement | null): void {
  transcriptScrollParent(element)?.dispatchEvent(new Event(TRANSCRIPT_FINAL_OUTPUT_EVENT));
}
