import { useEffect, type RefObject } from "react";
import { FOLLOW_LATEST_EVENT, transcriptScrollParent } from "../services/transcriptScroll";
import { TRANSCRIPT_VIEWPORT_BUFFER } from "../services/transcriptPaging";
import { useStableCallback } from "./useStableCallback";

/** Fill actual history to two viewports, ignoring task/graph/composer chrome.
 * Folding COT can leave a byte-heavy tail with very few visible history rows. */
export function useAutoTranscriptHistory(ref: RefObject<HTMLElement | null>, hasOlder: boolean,
  busy: boolean, error: string, progress: unknown, loadOlder: (preserveReading: boolean) => void) {
  const load = useStableCallback(loadOlder);
  useEffect(() => {
    const element = ref.current;
    const parent = transcriptScrollParent(element);
    if (!element || !parent || !hasOlder || busy || error) return;
    let frame: number | null = null;
    const check = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (document.hidden || !parent.clientHeight || !element.getClientRects().length || parent.dataset.transcriptScrollMode === "latest") return;
        const transcript = element.querySelector<HTMLElement>(".virtualized-transcript-container");
        const historyHeight = transcript?.getBoundingClientRect().height ?? 0;
        const relativeTop = parent.getBoundingClientRect().top - element.getBoundingClientRect().top;
        const threshold = Math.max(480, parent.clientHeight * TRANSCRIPT_VIEWPORT_BUFFER);
        const readingNearTop = parent.dataset.transcriptHistoryReading === "true" && relativeTop >= -threshold && relativeTop <= threshold;
        if (historyHeight < parent.clientHeight * TRANSCRIPT_VIEWPORT_BUFFER || !element.querySelector("[data-transcript-id]") || readingNearTop) load(readingNearTop);
      });
    };
    const observer = new ResizeObserver(check);
    observer.observe(element); observer.observe(parent);
    parent.addEventListener(FOLLOW_LATEST_EVENT, check);
    document.addEventListener("visibilitychange", check);
    check();
    return () => {
      observer.disconnect(); parent.removeEventListener(FOLLOW_LATEST_EVENT, check);
      document.removeEventListener("visibilitychange", check);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [ref, hasOlder, busy, error, progress, load]);
}
