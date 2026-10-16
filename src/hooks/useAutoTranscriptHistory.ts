import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FOLLOW_LATEST_EVENT, transcriptScrollParent } from "../services/transcriptScroll";
import { MAX_AUTO_TRANSCRIPT_BYTES, TRANSCRIPT_VIEWPORT_BUFFER } from "../services/transcriptPaging";
import { useStableCallback } from "./useStableCallback";

function needsInitialTranscriptFill(element: HTMLElement | null, hasOlder: boolean, error: string): boolean {
  if (!hasOlder || error || !element || (typeof document !== "undefined" && document.hidden)) return false;
  const parent = transcriptScrollParent(element);
  if (!parent || !parent.clientHeight || !element.getClientRects().length || parent.dataset.transcriptScrollMode === "latest") return false;
  const transcript = element.querySelector<HTMLElement>(".virtualized-transcript-container");
  const historyHeight = transcript?.getBoundingClientRect().height ?? 0;
  return historyHeight < parent.clientHeight * TRANSCRIPT_VIEWPORT_BUFFER || !element.querySelector("[data-transcript-id]");
}

/** Fill actual history to two viewports, ignoring task/graph/composer chrome.
 * Sparse progress-only logs may never fill that height. Bound each automatic
 * burst by bytes, then reveal measured rows and wait for another upward gesture. */
export function useAutoTranscriptHistory(ref: RefObject<HTMLElement | null>, hasOlder: boolean,
  busy: boolean, error: string, progress: unknown, loadOlder: (preserveReading: boolean) => void,
  ready: boolean, loadedBytes: number): boolean {
  const load = useStableCallback(loadOlder);
  const [initialReady, setInitialReady] = useState(false);
  const initialReadyRef = useRef(false);
  const measuredViewportRef = useRef("");
  const busyRetryRef = useRef<number | null>(null);
  const autoFillStartRef = useRef(0);
  useLayoutEffect(() => {
    if (!ready) { measuredViewportRef.current = ""; return; }
    const element = ref.current;
    const parent = transcriptScrollParent(element);
    const complete = () => {
      if (initialReadyRef.current) return;
      initialReadyRef.current = true;
      setInitialReady(true);
    };
    if (error || !element || !parent) { complete(); return; }
    let frame: number | null = null;
    const check = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (document.hidden || !parent.clientHeight || !element.getClientRects().length || parent.dataset.transcriptScrollMode === "latest") {
          complete();
          return;
        }
        if (busy) {
          // A busy window can outlive the triggers that would re-run this check
          // (the loader releases its guard slightly after the state flip). Drop
          // the frame, but reschedule once so the fill loop cannot stall with
          // no further resize, scroll or visibility events.
          if (busyRetryRef.current === null) {
            busyRetryRef.current = window.setTimeout(() => {
              busyRetryRef.current = null;
              check();
            }, 180);
          }
          measuredViewportRef.current = "";
          return;
        }
        const relativeTop = parent.getBoundingClientRect().top - element.getBoundingClientRect().top;
        const threshold = Math.max(480, parent.clientHeight * TRANSCRIPT_VIEWPORT_BUFFER);
        const readingNearTop = hasOlder && parent.dataset.transcriptHistoryReading === "true" && relativeTop >= -threshold && relativeTop <= threshold;
        const withinBudget = loadedBytes - autoFillStartRef.current < MAX_AUTO_TRANSCRIPT_BYTES;
        if (withinBudget && (needsInitialTranscriptFill(element, hasOlder, error) || readingNearTop)) {
          measuredViewportRef.current = "";
          load(readingNearTop);
          return;
        }
        if (!initialReadyRef.current) {
          // Check sufficiency on consecutive frames: the virtualizer may replace
          // estimated padding with shorter measured rows in a microtask. Don't
          // require identical heights, which could hide continuously growing output.
          const viewport = `${parent.clientWidth}:${parent.clientHeight}`;
          if (viewport !== measuredViewportRef.current) {
            measuredViewportRef.current = viewport;
            check();
            return;
          }
          complete();
        }
      });
    };
    const resumeFill = (event: Event) => {
      if ((event.target as HTMLElement).closest?.("input, textarea, [contenteditable=true]")) return;
      if (event instanceof WheelEvent && event.deltaY >= -0.5) return;
      if (event instanceof KeyboardEvent && !["ArrowUp", "PageUp", "Home"].includes(event.key) && !(event.key === " " && event.shiftKey)) return;
      autoFillStartRef.current = loadedBytes;
      check();
    };
    const observer = new ResizeObserver(check);
    observer.observe(element); observer.observe(parent);
    parent.addEventListener("wheel", resumeFill, { passive: true });
    parent.addEventListener("touchmove", resumeFill, { passive: true });
    parent.addEventListener("keydown", resumeFill);
    parent.addEventListener(FOLLOW_LATEST_EVENT, check);
    document.addEventListener("visibilitychange", check);
    check();
    return () => {
      observer.disconnect(); parent.removeEventListener(FOLLOW_LATEST_EVENT, check);
      parent.removeEventListener("wheel", resumeFill);
      parent.removeEventListener("touchmove", resumeFill);
      parent.removeEventListener("keydown", resumeFill);
      document.removeEventListener("visibilitychange", check);
      if (frame !== null) cancelAnimationFrame(frame);
      if (busyRetryRef.current !== null) { clearTimeout(busyRetryRef.current); busyRetryRef.current = null; }
    };
  }, [ref, ready, hasOlder, busy, error, progress, loadedBytes, load]);
  return initialReady;
}
