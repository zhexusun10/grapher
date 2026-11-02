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

/** True when a wheel, touch or key gesture belongs to a nested scroll area
 * inside the conversation scroller. Scrolling a thinking card or tool output
 * must move only that inner viewport; it is not a conversation scroll-up and
 * must not turn off the conversation's bottom follow state. */
export function isNestedScrollGesture(event: Event, scroller: HTMLElement | null): boolean {
  if (!scroller || typeof getComputedStyle !== "function") return false;
  let node = event.target as HTMLElement | null;
  if (!node || typeof node.closest !== "function") return false;
  for (; node && node !== scroller; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        node.scrollHeight > node.clientHeight + 1) return true;
  }
  return false;
}

/** Tell the conversation that streamed card content grew. The owner can pin a
 * following viewport even when no row or scrollHeight change is observed by
 * its generic resize path (for example while a thinking body scrolls inside a
 * fixed-height card). */
export const TRANSCRIPT_CONTENT_GROWTH_EVENT = "grapher:transcript-content-growth";

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
