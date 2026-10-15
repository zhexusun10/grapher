import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FOLLOW_LATEST_EVENT, transcriptScrollParent } from "../services/transcriptScroll";
import { TRANSCRIPT_VIEWPORT_BUFFER } from "../services/transcriptPaging";
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
 * The first byte page is not display readiness: folded cards and split records
 * may leave very little visible history. Wait for the fill and row measurements. */
export function useAutoTranscriptHistory(ref: RefObject<HTMLElement | null>, hasOlder: boolean,
  busy: boolean, error: string, progress: unknown, loadOlder: (preserveReading: boolean) => void,
  ready: boolean): boolean {
  const load = useStableCallback(loadOlder);
  const [initialReady, setInitialReady] = useState(false);
  const initialReadyRef = useRef(false);
  const measuredViewportRef = useRef("");
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
        if (busy) { measuredViewportRef.current = ""; return; }
        const relativeTop = parent.getBoundingClientRect().top - element.getBoundingClientRect().top;
        const threshold = Math.max(480, parent.clientHeight * TRANSCRIPT_VIEWPORT_BUFFER);
        const readingNearTop = hasOlder && parent.dataset.transcriptHistoryReading === "true" && relativeTop >= -threshold && relativeTop <= threshold;
        if (needsInitialTranscriptFill(element, hasOlder, error) || readingNearTop) {
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
  }, [ref, ready, hasOlder, busy, error, progress, load]);
  return initialReady;
}
