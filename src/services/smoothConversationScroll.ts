import { FOLLOW_LATEST_EVENT } from "./transcriptScroll";

/** Animate the entire distance, without a pre-jump. Recompute the target on each
 * frame because virtualized rows and live output can change the bottom mid-flight. */
export function smoothScrollToLatest(element: HTMLElement, onComplete: () => void,
  reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches): () => void {
  const distance = Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
  const duration = Math.min(900, Math.max(320, 280 + Math.sqrt(distance) * 5));
  const previousBehavior = element.style.scrollBehavior;
  const previousAnchor = element.style.overflowAnchor;
  element.style.scrollBehavior = "auto";
  element.style.overflowAnchor = "none";
  element.dataset.transcriptScrollMode = "latest";
  delete element.dataset.transcriptHistoryReading;
  element.dispatchEvent(new Event(FOLLOW_LATEST_EVENT));
  let frame: number | null = null;
  let started: number | null = null;
  let previousEase = 0;
  let settledFrames = 0;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (frame !== null) cancelAnimationFrame(frame);
    element.style.scrollBehavior = previousBehavior;
    element.style.overflowAnchor = previousAnchor;
    delete element.dataset.transcriptScrollMode;
    element.dispatchEvent(new Event(FOLLOW_LATEST_EVENT));
  };
  const step = (now: number) => {
    if (stopped) return;
    started ??= now;
    const progress = reducedMotion ? 1 : Math.min(1, (now - started) / duration);
    const ease = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
    // Consume a fraction of the remaining distance. This keeps motion continuous
    // when new measurements change the target instead of jumping to a new curve.
    const fraction = reducedMotion ? 1 : progress < 1
      ? Math.min(0.5, (ease - previousEase) / Math.max(1e-6, 1 - previousEase)) : 0.5;
    previousEase = ease;
    const target = Math.max(0, element.scrollHeight - element.clientHeight);
    const remaining = target - element.scrollTop;
    if (Math.abs(remaining) > 1) {
      element.scrollTop += remaining * fraction;
      settledFrames = 0;
    } else {
      element.scrollTop = target;
      settledFrames++;
    }
    if (settledFrames >= 3) { stop(); onComplete(); return; }
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return stop;
}
