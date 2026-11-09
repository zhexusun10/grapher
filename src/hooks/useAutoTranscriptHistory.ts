import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FOLLOW_LATEST_EVENT, isNestedScrollGesture, olderInsertionTop, transcriptScrollParent } from "../services/transcriptScroll";
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
  ready: boolean, loadedBytes: number, holdingOlder = false, olderSource?: string): boolean {
  const load = useStableCallback(loadOlder);
  const [initialReady, setInitialReady] = useState(false);
  const initialReadyRef = useRef(false);
  const measuredViewportRef = useRef("");
  const busyRetryRef = useRef<number | null>(null);
  const autoFillStartRef = useRef(0);
  // The prompt or an earlier turn is already in the DOM above a partially
  // loaded transcript. A fast fling can cross that gap before the page arrives,
  // briefly exposing content that is not actually adjacent to the loaded rows.
  // Treat the missing page as a temporary scroll boundary, not as empty history.
  useLayoutEffect(() => {
    const element = ref.current;
    const parent = transcriptScrollParent(element);
    if (!ready || !hasOlder || error || !element || !parent) return;
    let lastGesture = -Infinity;
    const noteGesture = (event: Event) => {
      if (event.type === "wheel" && (event as WheelEvent).deltaY >= 0) return;
      if (event.type === "keydown") {
        const key = event as KeyboardEvent;
        if (!["ArrowUp", "PageUp", "Home"].includes(key.key) && !(key.key === " " && key.shiftKey)) return;
        if ((key.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable=true]")) return;
      }
      if (event.type === "pointerdown") {
        const pointer = event as PointerEvent, bounds = parent.getBoundingClientRect();
        const width = parent.offsetWidth - parent.clientWidth;
        if (pointer.clientX < bounds.right - (width || 14)) return;
      }
      if (isNestedScrollGesture(event, parent)) return;
      lastGesture = performance.now();
    };
    const containMissingHistory = () => {
      if (parent.dataset.transcriptScrollMode === "latest" ||
          (parent.dataset.transcriptHistoryReading !== "true" && performance.now() - lastGesture > 1000)) return;
      const top = olderInsertionTop(element, olderSource);
      if (top === null) return;
      const overshoot = top - parent.getBoundingClientRect().top - parent.clientTop;
      if (overshoot <= 1) return;
      // A short initial tail cannot fill the viewport even at the bottom. Do
      // not push the reader there: it would turn an in-flight background fill
      // back into bottom-following and lose their visible-row anchor.
      if (parent.scrollTop + overshoot > parent.scrollHeight - parent.clientHeight + 1) return;
      parent.scrollTop += overshoot;
      if (!busy && !holdingOlder) load(true);
    };
    parent.addEventListener("scroll", containMissingHistory, { passive: true });
    parent.addEventListener("wheel", noteGesture, { passive: true });
    parent.addEventListener("touchmove", noteGesture, { passive: true });
    parent.addEventListener("pointerdown", noteGesture, { passive: true });
    parent.addEventListener("keydown", noteGesture);
    return () => {
      parent.removeEventListener("scroll", containMissingHistory);
      parent.removeEventListener("wheel", noteGesture);
      parent.removeEventListener("touchmove", noteGesture);
      parent.removeEventListener("pointerdown", noteGesture);
      parent.removeEventListener("keydown", noteGesture);
    };
  }, [ref, ready, hasOlder, error, busy, holdingOlder, olderSource, load]);
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
        // Background viewport filling is not the reader asking for a page: it
        // commits immediately even when they sit somewhere in the middle of the
        // history. Only a page that extends the history they are reading waits
        // for them to reach its insertion point.
        const needsFill = needsInitialTranscriptFill(element, hasOlder, error);
        const withinBudget = loadedBytes - autoFillStartRef.current < MAX_AUTO_TRANSCRIPT_BYTES;
        // A prefetched page may be waiting for the reader to reach its
        // insertion point. It is not an in-flight fill: retrying it on every
        // layout leaves initial readiness stuck until the reader scrolls.
        if (!holdingOlder && withinBudget && (needsFill || readingNearTop)) {
          measuredViewportRef.current = "";
          load(needsFill ? false : readingNearTop);
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
    let lastTouchY = 0;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches[0]) lastTouchY = event.touches[0].clientY;
    };
    const resumeFill = (event: Event) => {
      let touchDeltaY: number | undefined;
      if (event.type === "touchmove") {
        const touch = (event as TouchEvent).touches[0];
        if (!touch) return;
        touchDeltaY = lastTouchY - touch.clientY;
        lastTouchY = touch.clientY;
        if (touchDeltaY >= -1) return;
      }
      if ((event.target as HTMLElement).closest?.("input, textarea, [contenteditable=true]")) return;
      if (event instanceof WheelEvent && event.deltaY >= -0.5) return;
      if (event instanceof KeyboardEvent && !["ArrowUp", "PageUp", "Home"].includes(event.key) && !(event.key === " " && event.shiftKey)) return;
      if (isNestedScrollGesture(event, parent, touchDeltaY)) return;
      autoFillStartRef.current = loadedBytes;
      check();
    };
    const observer = new ResizeObserver(check);
    observer.observe(element); observer.observe(parent);
    parent.addEventListener("wheel", resumeFill, { passive: true });
    parent.addEventListener("touchstart", onTouchStart, { passive: true });
    parent.addEventListener("touchmove", resumeFill, { passive: true });
    parent.addEventListener("keydown", resumeFill);
    parent.addEventListener(FOLLOW_LATEST_EVENT, check);
    document.addEventListener("visibilitychange", check);
    check();
    return () => {
      observer.disconnect(); parent.removeEventListener(FOLLOW_LATEST_EVENT, check);
      parent.removeEventListener("wheel", resumeFill);
      parent.removeEventListener("touchstart", onTouchStart);
      parent.removeEventListener("touchmove", resumeFill);
      parent.removeEventListener("keydown", resumeFill);
      document.removeEventListener("visibilitychange", check);
      if (frame !== null) cancelAnimationFrame(frame);
      if (busyRetryRef.current !== null) { clearTimeout(busyRetryRef.current); busyRetryRef.current = null; }
    };
  }, [ref, ready, hasOlder, busy, error, progress, loadedBytes, holdingOlder, load]);
  return initialReady;
}
