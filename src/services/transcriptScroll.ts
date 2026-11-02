export const HISTORY_PREPEND_EVENT = "grapher:history-prepend";
export const FOLLOW_LATEST_EVENT = "grapher:follow-latest";

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
