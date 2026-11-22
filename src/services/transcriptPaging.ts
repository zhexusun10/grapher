/** More useful initial context, fewer round trips during scrollback. These are
 * bounded byte requests, not full-history reads; layout separately fills two views. */
export const INITIAL_TRANSCRIPT_BYTES = 512 * 1024;
export const OLDER_TRANSCRIPT_BYTES = 1024 * 1024;
/** Summary-only projections strip tool results and thinking bodies (~10–50x smaller),
 * so collapsed conversations can safely request much longer history per page. */
export const SUMMARY_INITIAL_TRANSCRIPT_BYTES = 1024 * 1024;
export const SUMMARY_OLDER_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const TRANSCRIPT_VIEWPORT_BUFFER = 2;
/** Stop sparse initial/history auto-fill after this many loaded bytes per gesture.
 * A single in-flight page (including boundary look-behind) can cross the budget. */
export const MAX_AUTO_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
/** Small conversations (few attempts whose combined logs fit within a single
 * initial transcript page) load eagerly together so short histories render
 * completely on open without placeholder collapses during the first scroll. */
export const EAGER_EXECUTION_COUNT_LIMIT = 6;
export const SUMMARY_EAGER_EXECUTION_COUNT_LIMIT = 12;

export function shouldDeferOlderExecutions(
  executions: readonly { outputBytes?: number }[],
  cardsCollapsed = false,
): boolean {
  const countLimit = cardsCollapsed ? SUMMARY_EAGER_EXECUTION_COUNT_LIMIT : EAGER_EXECUTION_COUNT_LIMIT;
  const byteLimit = cardsCollapsed ? INITIAL_TRANSCRIPT_BYTES * 8 : INITIAL_TRANSCRIPT_BYTES;
  if (executions.length > countLimit) return true;
  let totalBytes = 0;
  for (const execution of executions) {
    totalBytes += execution.outputBytes ?? 0;
    if (totalBytes > byteLimit) return true;
  }
  return false;
}
/** A settled conversation normally paints once its automatic viewport fill
 * settles, so a short tail cannot jump to the bottom of the filled history
 * mid-fade. A slow or stalled older read must not keep the pane hidden, so this
 * bounds that wait. */
export const TRANSCRIPT_REVEAL_FALLBACK_MS = 300;

/** One automatic-fill budget for a conversation scroller, not one per attempt.
 * Reservations include concurrent reads; boundary look-behind may overrun one
 * reservation, but cannot start another burst. Explicit upward gestures renew it. */
export class TranscriptAutoFillBudget {
  private used = 0;
  private reserved = 0;
  private lastGesture: Event | undefined;
  private listeners = new Set<() => void>();
  readonly maximum: number;
  constructor(maximum = MAX_AUTO_TRANSCRIPT_BYTES) { this.maximum = maximum; }
  get remaining() { return Math.max(0, this.maximum - this.used - this.reserved); }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify() { for (const listener of this.listeners) listener(); }
  charge(bytes: number) { this.used += bytes; this.notify(); }
  renew(event: Event) {
    // Several mounted readers receive the same bubbling gesture.
    if (this.lastGesture === event) return;
    this.lastGesture = event;
    this.used = 0;
    this.notify();
  }
  reserve(wanted: number, readerRequested = false) {
    // Quotas bound automatic work, never a reader's explicit page or retry
    // (scrollbar dragging does not necessarily emit a wheel/key/touch gesture).
    const bytes = readerRequested ? wanted : Math.min(wanted, this.remaining);
    if (bytes < 4) return null;
    this.reserved += bytes;
    let pending = true;
    return { bytes, finish: (actualBytes = 0) => {
      if (!pending) return;
      pending = false;
      this.reserved -= bytes;
      this.charge(actualBytes);
    } };
  }
}

const viewportBudgets = new WeakMap<HTMLElement, { key: string; budget: TranscriptAutoFillBudget }>();
export function transcriptAutoFillBudget(scroller: HTMLElement): TranscriptAutoFillBudget {
  // Node-to-Node navigation can reuse the actual DOM scroller. Its new
  // conversation must not inherit the previous view's exhausted budget.
  const key = scroller.closest<HTMLElement>("[data-transcript-budget-key]")?.dataset.transcriptBudgetKey ?? "";
  let entry = viewportBudgets.get(scroller);
  if (!entry || entry.key !== key) {
    entry = { key, budget: new TranscriptAutoFillBudget() };
    viewportBudgets.set(scroller, entry);
  }
  return entry.budget;
}
