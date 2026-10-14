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
