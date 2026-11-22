import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { estimateTranscriptRowHeight, retainedRowAnchor, rowAt, rowOffsets, visibleRows } from "../services/transcriptLayout";
import { shareJson } from "../services/structuralSharing";
import { FOLLOW_LATEST_EVENT, TRANSCRIPT_CONTENT_GROWTH_EVENT, TRANSCRIPT_SCROLL_ADJUSTED_EVENT, isNestedScrollGesture } from "../services/transcriptScroll";
import { observeElementResize } from "../services/sharedResizeObserver";
import { hasActiveCardsTransitionAnchor, syncCardsTransitionAnchorScroll } from "./ActivitySummaryRow";
import type { TranscriptRestoreAnchor } from "../services/conversationScroll";

export function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let parent = element?.parentElement; parent; parent = parent.parentElement) {
    if (/^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

const MeasuredListRow = memo(function MeasuredListRow({ id, measure, rowElements, children }: {
  id: string; measure: (id: string, height: number, sync?: boolean) => void;
  rowElements: React.MutableRefObject<Map<string, HTMLElement>>; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current!;
    rowElements.current.set(id, element);
    const read = () => Math.round(element.offsetHeight || element.getBoundingClientRect().height);
    measure(id, read());
    const unobserve = observeElementResize(element, () => measure(id, read(), true));
    return () => {
      unobserve();
      if (rowElements.current.get(id) === element) rowElements.current.delete(id);
    };
  }, [id, measure, rowElements]);
  return <div ref={ref} data-transcript-id={id} style={{ display: "flow-root" }}>{children}</div>;
});

/** Window document-flow rows using the *shared parent's* viewport, not a private scroll area.
 * The conversation remains responsible for following output and revealing expanded cards.
 */
export function VirtualizedList<T extends { id: string }>({ items, renderRow, gap = 0, overscan = 16, transitionPhase = "idle", sourceStarts = [], rowHeights, restoreAnchor, onRestoreScroll }: {
  items: T[]; renderRow: (item: T, index: number, allowTransition?: boolean) => React.ReactNode; gap?: number;
  overscan?: number;
  transitionPhase?: "idle" | "collapsing" | "expanding";
  sourceStarts?: Array<{ source: string; index: number }>;
  /** View-owned measurements survive a temporary unmount of this list. */
  rowHeights?: Map<string, number>;
  restoreAnchor?: TranscriptRestoreAnchor;
  onRestoreScroll?: (scrollTop: number | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const parentRef = useRef<HTMLElement | null>(null);
  const heights = useRef(rowHeights ?? new Map<string, number>());
  const rowElements = useRef(new Map<string, HTMLElement>());
  // A saved pixel position is only an estimate after a resize or remount. Keep
  // the actual row mounted and align it as its neighbours are remeasured.
  const restoreRef = useRef(restoreAnchor ?? null);
  const onRestoreScrollRef = useRef(onRestoreScroll);
  onRestoreScrollRef.current = onRestoreScroll;
  const [heightVersion, setHeightVersion] = useState(0);
  const measuredRevisionRef = useRef(0);
  const committedOffsetsRevisionRef = useRef(0);
  const resizedRevisionRef = useRef(0);
  const committedResizedRevisionRef = useRef(0);
  const flushScheduled = useRef(false);
  const syncFlushScheduled = useRef(false);
  const mounted = useRef(false);
  const frame = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600, hasScroller: true });
  const lastViewportRef = useRef(viewport);
  lastViewportRef.current = viewport;

  const measure = useCallback((id: string, height: number, sync = false) => {
    if (height <= 0 || transitionPhaseRef.current !== "idle") return;
    const existing = heights.current.get(id);
    if (existing !== undefined && Math.abs(existing - height) < 1) return;
    if (existing !== undefined) resizedRevisionRef.current += 1;
    heights.current.set(id, height);
    measuredRevisionRef.current += 1;
    if (sync) syncFlushScheduled.current = true;
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    queueMicrotask(() => {
      const useSync = syncFlushScheduled.current;
      flushScheduled.current = false;
      syncFlushScheduled.current = false;
      if (!mounted.current || measuredRevisionRef.current === committedOffsetsRevisionRef.current) return;
      if (useSync) {
        // ResizeObserver runs after layout and before paint. Flushing here
        // adjusts scrollTop in the same frame so growing CoT never shifts
        // the answer row below it for a frame before snapping back.
        try { flushSync(() => setHeightVersion(value => value + 1)); }
        catch { setHeightVersion(value => value + 1); }
      } else {
        setHeightVersion(value => value + 1);
      }
    });
  }, []);
  const previousIds = useRef<string[]>([]);
  const ids = useMemo(() => shareJson(previousIds.current, items.map(item => item.id)), [items]);
  previousIds.current = ids;
  const { offsets, revision: offsetsRevision, resizeRevision: offsetsResizeRevision } = useMemo(() => ({
    offsets: rowOffsets(ids,
      { get: (id: string) => { const height = heights.current.get(id); return height === undefined ? undefined : height + gap; } },
      (id: string) => estimateTranscriptRowHeight(id) + gap),
    revision: measuredRevisionRef.current,
    resizeRevision: resizedRevisionRef.current,
  }), [ids, gap, heightVersion]);
  const previousOffsets = useRef(offsets);
  const previousOffsetIds = useRef(ids);
  const previousRangeStartRef = useRef(0);
  const previousRangeEndRef = useRef(0);
  const rangePrependSyncCountRef = useRef(0);
  const syncingViewportScrollRef = useRef(false);
  const latestOffsetsRef = useRef(offsets);
  latestOffsetsRef.current = offsets;
  const latestIdsLengthRef = useRef(ids.length);
  latestIdsLengthRef.current = ids.length;
  const transitionPhaseRef = useRef(transitionPhase);
  transitionPhaseRef.current = transitionPhase;
  // Track which rows were mounted when a collapse/expand transition began so
  // offscreen summary rows pulled in mid-collapse mount already settled instead
  // of exploding to 1fr above the viewport and oscillating scrollHeight.
  const transitionInitialIdsRef = useRef<Set<string> | null>(null);
  const transitionAnchorRef = useRef<{ id: string; visualTop: number } | null>(null);
  // Keep the anchor through the subsequent first measurements too. Otherwise
  // new rows initially use estimated heights, then drag the reader on the next
  // microtask when those estimates are replaced by actual heights.
  const readingAnchor = useRef<{ id: string; visualTop: number } | null>(null);
  // Preserve the row the reader actually scrolled over, not necessarily the
  // row at the viewport's top. A still-draining CoT above the answer can grow
  // while both are visible and otherwise push the answer out of the pane.
  const gestureRowAnchor = useRef<{ id: string; visualTop: number; scrollTop: number; awaitingScroll: boolean } | null>(null);
  const pendingGestureMeasurementRef = useRef(false);
  const restoredScrollTop = useRef<number | null>(null);
  const stabilizingAnchorRef = useRef(false);
  const beforeIds = previousOffsetIds.current;
  // Rows can be inserted anywhere in the list, not only at its very start: a
  // composed Planner conversation pages older bytes of a later revision in
  // below the turn that precedes it, and a serial conversation pages one Node's
  // transcript in the middle of several. Any identity change in the rendered
  // id list means rows were added or removed somewhere, so the reading anchor
  // is recaptured below instead of trusting `ids[0]` alone.
  const structureChanged = beforeIds.length > 0 && ids !== beforeIds;
  const prefixChanged = structureChanged && ids[0] !== beforeIds[0];
  if (prefixChanged) {
    stabilizingAnchorRef.current = true;
  }
  const parent = parentRef.current;
  const followingLatest = parent?.dataset.transcriptScrollMode === "latest";
  const readingHistory = !followingLatest && parent?.dataset.transcriptHistoryReading === "true";
  const preparingBottom = !followingLatest && !readingHistory &&
    parent?.dataset.transcriptPreparing === "true";
  // The conversation reports whether it is following the newest output. A
  // follower must move with every measured row change, not just during the
  // initial fill; otherwise a tall streaming reasoning card can become the
  // de facto scroll anchor once it reaches the middle of the viewport.
  const followingOutput = !followingLatest && !readingHistory &&
    parent?.dataset.transcriptFollowing === "true";
  const pinnedToBottom = preparingBottom || followingOutput;

  const externalTransitionAnchor = hasActiveCardsTransitionAnchor();
  if (transitionPhase === "idle") {
    transitionInitialIdsRef.current = null;
  } else if (!externalTransitionAnchor && !pinnedToBottom && !followingLatest && !restoreRef.current && parent && ref.current && transitionAnchorRef.current === null) {
    // Anchor a visible row that survives both collapsed & expanded modes (such
    // as an assistant text or user row) so cards smoothly collapse/expand around
    // the reader's current reading position without vertical jitter.
    const parentBounds = parent.getBoundingClientRect();
    let chosen: { id: string; visualTop: number } | null = null;
    if (structureChanged) {
      const top = parentBounds.top + parent.clientTop - ref.current.getBoundingClientRect().top;
      const retained = retainedRowAnchor(beforeIds, ids, previousOffsets.current, offsets, top, top + parent.clientHeight);
      const row = retained && rowElements.current.get(retained.id);
      if (row && row.isConnected && retained) {
        chosen = { id: retained.id, visualTop: row.getBoundingClientRect().top };
      }
    }
    if (!chosen) {
      let fallback: { id: string; visualTop: number } | null = null;
      const scanStart = Math.max(0, previousRangeStartRef.current);
      const scanEnd = Math.min(ids.length, previousRangeEndRef.current || ids.length);
      for (let index = scanStart; index < scanEnd; index++) {
        const id = ids[index];
        const element = rowElements.current.get(id);
        if (!element || !element.isConnected) continue;
        const rect = element.getBoundingClientRect();
        if (rect.bottom <= parentBounds.top || rect.top >= parentBounds.bottom) continue;
        if (!fallback) fallback = { id, visualTop: rect.top };
        if (!id.startsWith("summary_")) {
          chosen = { id, visualTop: rect.top };
          break;
        }
      }
      if (!chosen) chosen = fallback;
    }
    if (chosen) {
      transitionAnchorRef.current = chosen;
      stabilizingAnchorRef.current = true;
    }
  }

  const keepTransitionAnchor = transitionAnchorRef.current !== null && !pinnedToBottom && !followingLatest;
  let anchor = (!readingHistory && !keepTransitionAnchor && !stabilizingAnchorRef.current) ||
    (parent && !stabilizingAnchorRef.current && !keepTransitionAnchor && restoredScrollTop.current !== null && Math.abs(parent.scrollTop - restoredScrollTop.current) > 1)
    ? null
    : (keepTransitionAnchor ? transitionAnchorRef.current : readingAnchor.current);
  if ((readingHistory || (!externalTransitionAnchor && !pinnedToBottom && !followingLatest && !restoreRef.current)) && structureChanged && parent && ref.current) {
    const top = parent.getBoundingClientRect().top + parent.clientTop - ref.current.getBoundingClientRect().top;
    if (top + parent.clientHeight > 0) {
      const retained = retainedRowAnchor(beforeIds, ids, previousOffsets.current, offsets, top, top + parent.clientHeight);
      const row = retained && ref.current.querySelector<HTMLElement>(`[data-transcript-id="${retained.id.replace(/["\\]/g, "\\$&")}"]`);
      if (row && retained) {
        anchor = { id: retained.id, visualTop: row.getBoundingClientRect().top };
        if (transitionPhase !== "idle") transitionAnchorRef.current = anchor;
        // Newly inserted rows start with estimated heights; keep the anchor
        // through the measurements that replace them, or the reader is dragged
        // by the difference a frame later.
        stabilizingAnchorRef.current = true;
      }
    }
  }
  const anchorIndex = anchor ? ids.indexOf(anchor.id) : -1;
  if (anchorIndex < 0) anchor = null;
  const anchorTop = anchor && parent
    ? offsets[anchorIndex] - (anchor.visualTop - parent.getBoundingClientRect().top - parent.clientTop) : null;
  const updateViewport = useCallback(() => {
    const element = ref.current, parent = parentRef.current;
    if (!element || !parent) {
      setViewport(previous => previous.hasScroller ? { ...previous, hasScroller: false } : previous);
      return;
    }
    const parentRect = parent.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const top = Math.round(parentRect.top + parent.clientTop - elementRect.top);
    const height = Math.round(parent.clientHeight || 600);
    const prev = lastViewportRef.current;
    if (Math.abs(prev.top - top) < 4 && prev.height === height && prev.hasScroller) {
      return;
    }
    setViewport({ top, height, hasScroller: true });
  }, []);
  const scheduleViewportUpdate = useCallback(() => {
    if (frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        rangePrependSyncCountRef.current = 0;
        updateViewport();
      });
    }
  }, [updateViewport]);
  useLayoutEffect(() => {
    mounted.current = true;
    parentRef.current = scrollParent(ref.current);
    const parent = parentRef.current;
    updateViewport();
    const cancelRestore = () => {
      if (!restoreRef.current) return;
      restoreRef.current = null;
      onRestoreScrollRef.current?.(null);
    };
    const releaseAnchor = () => {
      transitionAnchorRef.current = null;
      if (stabilizingAnchorRef.current) return;
      readingAnchor.current = null;
      restoredScrollTop.current = null;
    };
    let gestureTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelGestureTimer = () => {
      if (gestureTimer !== null) clearTimeout(gestureTimer);
      gestureTimer = null;
    };
    const clearGestureAnchor = () => {
      cancelGestureTimer();
      gestureRowAnchor.current = null;
      pendingGestureMeasurementRef.current = false;
      releaseAnchor();
    };
    const captureGestureAnchor = (row: HTMLElement | null | undefined, awaitingScroll = false) => {
      cancelGestureTimer();
      pendingGestureMeasurementRef.current = false;
      const id = row?.dataset.transcriptId;
      const anchor = parent && id && ref.current?.contains(row)
        ? { id, visualTop: row.getBoundingClientRect().top, scrollTop: parent.scrollTop, awaitingScroll } : null;
      gestureRowAnchor.current = anchor;
      if (anchor?.awaitingScroll) {
        // Do not write scrollTop before the browser has applied a wheel/touch
        // gesture: doing so can cancel the user's actual scroll. A gesture at
        // a boundary may never generate a scroll event, so retry once later.
        gestureTimer = setTimeout(() => {
          gestureTimer = null;
          if (gestureRowAnchor.current !== anchor || !anchor.awaitingScroll) return;
          anchor.awaitingScroll = false;
          if (pendingGestureMeasurementRef.current && mounted.current) setHeightVersion(value => value + 1);
        }, 80);
      }
    };
    const visibleBounds = () => {
      if (!parent) return null;
      const bounds = parent.getBoundingClientRect();
      const composer = parent.closest(".initial-query-view")?.querySelector<HTMLElement>(".pane-bottom-chat");
      return { top: bounds.top, bottom: Math.min(bounds.bottom, composer?.getBoundingClientRect().top ?? bounds.bottom) };
    };
    const visibleRowsInConversation = () => {
      const bounds = visibleBounds();
      if (!parent || !bounds) return [];
      return [...parent.querySelectorAll<HTMLElement>("[data-transcript-id]")].filter(row => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
    };
    const onUserScrollGesture = (e: Event, touchDeltaY?: number) => {
      if (parent && isNestedScrollGesture(e, parent, touchDeltaY)) return;
      cancelRestore();
      const target = e.target instanceof Element ? e.target : null;
      let row = target?.closest<HTMLElement>("[data-transcript-id]");
      if (!row) {
        const y = e.type === "wheel" ? (e as WheelEvent).clientY : (e as TouchEvent).touches[0]?.clientY;
        const visible = visibleRowsInConversation();
        row = visible.find(candidate => {
          const bounds = candidate.getBoundingClientRect();
          return y !== undefined && y >= bounds.top && y <= bounds.bottom;
        }) ?? visible[0];
      }
      const mayScroll = e.type.startsWith("touch") || Math.abs((e as WheelEvent).deltaY) > 0.5;
      captureGestureAnchor(row, mayScroll);
      if (transitionAnchorRef.current) {
        transitionAnchorRef.current = null;
        stabilizingAnchorRef.current = false;
        readingAnchor.current = null;
        restoredScrollTop.current = null;
        return;
      }
      if (stabilizingAnchorRef.current && parent && restoredScrollTop.current !== null) {
        // If the user scrolled during stabilization, adjust the anchor's expected visualTop
        // by the user's scroll movement so stabilization preserves the user's manual progress.
        const scrollDelta = parent.scrollTop - restoredScrollTop.current;
        if (readingAnchor.current && scrollDelta !== 0) {
          readingAnchor.current.visualTop -= scrollDelta;
          restoredScrollTop.current = parent.scrollTop;
        }
        return;
      }
      releaseAnchor();
    };
    let lastTouchY = 0, touchOwnsOuter = false;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches[0]) lastTouchY = event.touches[0].clientY;
      touchOwnsOuter = !!parent && !isNestedScrollGesture(event, parent);
      onUserScrollGesture(event);
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!event.touches[0] || !parent) return;
      const delta = lastTouchY - event.touches[0].clientY;
      lastTouchY = event.touches[0].clientY;
      if (isNestedScrollGesture(event, parent, delta)) { touchOwnsOuter = false; return; }
      // A gesture that began in a card can reach the conversation later. Take
      // its anchor at that transition, not on every frame of a touch drag.
      if (!touchOwnsOuter || !gestureRowAnchor.current) onUserScrollGesture(event, delta);
      touchOwnsOuter = true;
    };
    let scrollbarPointer: number | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (!parent || isNestedScrollGesture(event, parent)) return;
      cancelRestore();
      releaseAnchor();
      const width = parent.offsetWidth - parent.clientWidth - parent.clientLeft;
      const bounds = parent.getBoundingClientRect();
      const onScrollbar = width > 0 ? event.clientX >= bounds.right - width :
        event.target === parent && event.clientX >= bounds.right - 14;
      if (onScrollbar) {
        scrollbarPointer = event.pointerId;
        captureGestureAnchor(visibleRowsInConversation().at(-1));
      } else {
        gestureRowAnchor.current = null;
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (scrollbarPointer !== event.pointerId) return;
      scrollbarPointer = null;
      captureGestureAnchor(visibleRowsInConversation().at(-1));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (parent && isNestedScrollGesture(event, parent)) return;
      const target = event.target instanceof Element ? event.target : null;
      const scrollKey = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key) ||
        (event.key === " " && !target?.closest("button, [role=button]"));
      if (!scrollKey || target?.closest("input, textarea, [contenteditable=true]")) {
        clearGestureAnchor();
        return;
      }
      cancelRestore();
      captureGestureAnchor(target?.closest<HTMLElement>("[data-transcript-id]") ?? visibleRowsInConversation().at(-1), true);
      releaseAnchor();
    };
    const schedule = () => {
      if (syncingViewportScrollRef.current) return;
      rangePrependSyncCountRef.current = 0;
      // Wheel fires before the browser moves scrollTop, so track manual scroll
      // deltas here while a prepend anchor is still stabilizing; otherwise the
      // next measurement commit snaps scrollTop back to the pre-scroll visualTop.
      if (stabilizingAnchorRef.current && readingAnchor.current && parent && restoredScrollTop.current !== null) {
        const userDelta = parent.scrollTop - restoredScrollTop.current;
        if (userDelta !== 0) {
          readingAnchor.current.visualTop -= userDelta;
          restoredScrollTop.current = parent.scrollTop;
        }
      }
      const gesture = gestureRowAnchor.current;
      const bounds = visibleBounds();
      if (gesture && parent && bounds) {
        if (gesture.awaitingScroll && Math.abs(parent.scrollTop - gesture.scrollTop) > 0.5) {
          gesture.awaitingScroll = false;
          cancelGestureTimer();
          // A row may have resized before the browser applied this gesture.
          // Reconcile it now even if no further measurements arrive.
          if (pendingGestureMeasurementRef.current && mounted.current) setHeightVersion(value => value + 1);
        }
        const row = ref.current?.querySelector<HTMLElement>(`[data-transcript-id="${gesture.id.replace(/["\\]/g, "\\$&")}"]`);
        if (!row) {
          cancelGestureTimer();
          gestureRowAnchor.current = null;
          pendingGestureMeasurementRef.current = false;
        } else {
          const expectedTop = gesture.visualTop - (parent.scrollTop - gesture.scrollTop);
          const actualTop = row.getBoundingClientRect().top;
          // The snapshot is taken before a wheel/touch gesture moves scrollTop,
          // and the browser can apply that movement over several scroll events.
          // Rebase once the row itself has not moved relative to the gesture:
          // otherwise a later layout commit mistakes the gesture's remaining
          // scroll delta for content resizing and shifts the reader. A real
          // row resize keeps the old snapshot so the commit can compensate it.
          if (!gesture.awaitingScroll && Math.abs(actualTop - expectedTop) <= 1) {
            gesture.visualTop = actualTop;
            gesture.scrollTop = parent.scrollTop;
          }
          // Release an anchor the reader deliberately scrolled past. Use its
          // expected position without reflow: the actual row can temporarily be
          // outside the viewport precisely because the CoT above it grew.
          if (expectedTop >= bounds.bottom || expectedTop + row.getBoundingClientRect().height <= bounds.top) {
            cancelGestureTimer();
            gestureRowAnchor.current = null;
            pendingGestureMeasurementRef.current = false;
          }
        }
      }
      if (!stabilizingAnchorRef.current && parent && restoredScrollTop.current !== null && Math.abs(parent.scrollTop - restoredScrollTop.current) > 1) releaseAnchor();
      if (transitionPhaseRef.current === "idle") {
        // When fast upward/downward scrolling approaches the mounted window edge,
        // flush the viewport update synchronously on this frame so the browser
        // never paints empty paddingTop/paddingBottom whitespace while waiting
        // for the next rAF.
        const element = ref.current;
        let nearEdge = false;
        if (parent && element) {
          const curTop = Math.round(parent.getBoundingClientRect().top + parent.clientTop - element.getBoundingClientRect().top);
          const curHeight = parent.clientHeight || 600;
          const curOffsets = latestOffsetsRef.current;
          const mountedStart = previousRangeStartRef.current;
          const mountedEnd = previousRangeEndRef.current;
          const edgeMargin = Math.max(curHeight * 0.75, 480);
          if (mountedStart > 0 && curTop < (curOffsets[mountedStart] ?? 0) + edgeMargin) {
            nearEdge = true;
          } else if (mountedEnd < latestIdsLengthRef.current && curTop + curHeight > (curOffsets[mountedEnd] ?? 0) - edgeMargin) {
            nearEdge = true;
          }
        }
        if (nearEdge) {
          if (frame.current !== null) {
            cancelAnimationFrame(frame.current);
            frame.current = null;
          }
          syncingViewportScrollRef.current = true;
          try {
            flushSync(() => updateViewport());
          } catch {
            updateViewport();
          } finally {
            syncingViewportScrollRef.current = false;
          }
        } else if (frame.current === null) {
          frame.current = requestAnimationFrame(() => {
            frame.current = null;
            rangePrependSyncCountRef.current = 0;
            updateViewport();
          });
        }
      }
    };
    const onContentGrowth = () => {
      for (const [id, element] of rowElements.current) {
        if (!element.isConnected) continue;
        measure(id, Math.round(element.offsetHeight || element.getBoundingClientRect().height), true);
      }
    };
    const observer = new ResizeObserver(updateViewport);
    // Measurements and the workbench's initial scroll settle over multiple
    // frames. Never keep ownership after the user starts interacting.
    const restoreTimer = restoreRef.current ? setTimeout(cancelRestore, 300) : null;
    if (parent) {
      parent.addEventListener(FOLLOW_LATEST_EVENT, clearGestureAnchor);
      parent.addEventListener(TRANSCRIPT_CONTENT_GROWTH_EVENT, onContentGrowth);
      parent.addEventListener("scroll", schedule, { passive: true });
      parent.addEventListener("wheel", onUserScrollGesture, { passive: true });
      parent.addEventListener("touchstart", onTouchStart, { passive: true });
      parent.addEventListener("touchmove", onTouchMove, { passive: true });
      parent.addEventListener("pointerdown", onPointerDown, { passive: true });
      parent.addEventListener("keydown", onKeyDown);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      observer.observe(parent);
    }
    return () => {
      mounted.current = false;
      parent?.removeEventListener(FOLLOW_LATEST_EVENT, clearGestureAnchor);
      parent?.removeEventListener(TRANSCRIPT_CONTENT_GROWTH_EVENT, onContentGrowth);
      parent?.removeEventListener("scroll", schedule);
      parent?.removeEventListener("wheel", onUserScrollGesture);
      parent?.removeEventListener("touchstart", onTouchStart);
      parent?.removeEventListener("touchmove", onTouchMove);
      parent?.removeEventListener("pointerdown", onPointerDown);
      parent?.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      cancelGestureTimer();
      if (restoreTimer !== null) clearTimeout(restoreTimer);
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [updateViewport, measure]);
  useEffect(() => {
    if (heights.current.size <= Math.max(400, ids.length * 3)) return;
    const retained = new Set(ids);
    for (const id of heights.current.keys()) if (!retained.has(id)) heights.current.delete(id);
  }, [ids]);
  const virtual = typeof window !== "undefined" && viewport.hasScroller && items.length > 35;
  const height = parent?.clientHeight || viewport.height;
  const totalHeight = offsets.at(-1) ?? 0;
  const restoreIndex = restoreRef.current ? ids.indexOf(restoreRef.current.id) : -1;
  const restoreTop = restoreIndex >= 0 ? offsets[restoreIndex] - restoreRef.current!.top : null;
  const externalTop = externalTransitionAnchor && !pinnedToBottom && parent && ref.current
    ? Math.round(parent.getBoundingClientRect().top + parent.clientTop - ref.current.getBoundingClientRect().top)
    : null;
  const top = restoreTop ?? anchorTop ?? externalTop ?? (pinnedToBottom ? Math.max(viewport.top, totalHeight - height) : viewport.top);
  const pixelOverscan = Math.max(height * 1.5, 1000);
  const range = virtual ? visibleRows(offsets, top, height, overscan, pixelOverscan)
    : { start: 0, end: items.length, paddingTop: 0, paddingBottom: 0 };
  if (transitionPhase !== "idle" && transitionInitialIdsRef.current === null) {
    transitionInitialIdsRef.current = new Set(ids.slice(range.start, range.end));
  }

  // When scrolling upward mounts previously unmeasured older rows above the
  // viewport (especially tall Markdown answers in collapsed-card mode whose
  // real height greatly exceeds the 88px estimate), their DOM height shifts
  // every visible row BEFORE the async measurement re-render runs. Capture a
  // visible retained row's pre-commit screen position here so `useLayoutEffect`
  // compensates `scrollTop` synchronously before the browser paints.
  let rangePrependAnchor: { id: string; visualTop: number } | null = null;
  if (
    virtual &&
    !pinnedToBottom &&
    !followingLatest &&
    !anchor &&
    !restoreRef.current &&
    parent &&
    ref.current &&
    !structureChanged &&
    range.start < previousRangeStartRef.current
  ) {
    const parentBounds = parent.getBoundingClientRect();
    const retainedStart = previousRangeStartRef.current;
    const retainedEnd = Math.min(range.end, previousRangeEndRef.current);
    for (let index = retainedStart; index < retainedEnd; index++) {
      const id = ids[index];
      const element = rowElements.current.get(id);
      if (!element || !element.isConnected) continue;
      const rect = element.getBoundingClientRect();
      if (rect.bottom > parentBounds.top && rect.top < parentBounds.bottom) {
        rangePrependAnchor = { id, visualTop: rect.top };
        break;
      }
    }
  }

  const rangeStart = range.start;
  const rangeEnd = range.end;

  useLayoutEffect(() => {
    const before = previousOffsets.current;
    const parent = parentRef.current;
    const prevRangeStart = previousRangeStartRef.current;
    previousRangeStartRef.current = rangeStart;
    previousRangeEndRef.current = rangeEnd;
    // Child layout effects can measure newly mounted overscan rows before this
    // commit, while `offsets` still contains their estimates. Capture the
    // measurement revision when `offsets` was computed so those later child
    // measurements are associated with the next render that actually includes them,
    // and measurements that already updated `offsets` in an `items` render are
    // compensated right away rather than dropped.
    const hasMeasurementChange = offsetsRevision !== committedOffsetsRevisionRef.current;
    committedOffsetsRevisionRef.current = offsetsRevision;
    const hasMeasuredResize = offsetsResizeRevision !== committedResizedRevisionRef.current;
    committedResizedRevisionRef.current = offsetsResizeRevision;
    // A staged transcript is measured inside a zero-height clipped wrapper
    // behind the live stream; it must not scroll the shared conversation pane.
    if (ref.current?.closest("[data-transcript-staged='true']")) {
      previousOffsets.current = offsets;
      previousOffsetIds.current = ids;
      return;
    }
    // Follow state is also updated imperatively from scroll handlers without a
    // React render. Re-read it at commit time so a reader who just scrolled up
    // is never pulled back by this frame's row measurement.
    const followingLatestNow = parent?.dataset.transcriptScrollMode === "latest";
    const readingHistoryNow = !followingLatestNow && parent?.dataset.transcriptHistoryReading === "true";
    const disclosureAnimatingNow = parent?.dataset.transcriptDisclosureAnimating === "true";
    const bottomPinnedNow = !followingLatestNow && !readingHistoryNow && !disclosureAnimatingNow &&
      (parent?.dataset.transcriptPreparing === "true" || parent?.dataset.transcriptFollowing === "true");

    const restore = restoreRef.current;
    if (restore && parent && ref.current) {
      const row = [...ref.current.querySelectorAll<HTMLElement>("[data-transcript-id]")]
        .find(item => item.dataset.transcriptId === restore.id);
      if (row) {
        const delta = row.getBoundingClientRect().top - parent.getBoundingClientRect().top - restore.top;
        if (Math.abs(delta) > 0.5) parent.scrollTop += delta;
        onRestoreScrollRef.current?.(parent.scrollTop);
        parent.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
        previousOffsets.current = offsets;
        previousOffsetIds.current = ids;
        updateViewport();
        return;
      }
      if (!ids.includes(restore.id)) {
        restoreRef.current = null;
        onRestoreScrollRef.current?.(null);
      }
    }

    readingAnchor.current = anchor;
    if (externalTransitionAnchor && parent) {
      syncCardsTransitionAnchorScroll();
    } else if (anchor && parent) {
      const retained = anchor;
      const row = ref.current?.querySelector<HTMLElement>(`[data-transcript-id="${retained.id.replace(/["\\]/g, "\\$&")}"]`);
      let shifted = false;
      if (row) {
        const visualDelta = row.getBoundingClientRect().top - retained.visualTop;
        if (Math.abs(visualDelta) >= 1) {
          parent.scrollTop += visualDelta;
          parent.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
          shifted = true;
        }
      }
      restoredScrollTop.current = parent.scrollTop;
      if (transitionPhase === "idle") {
        transitionAnchorRef.current = null;
        if (!flushScheduled.current) {
          stabilizingAnchorRef.current = false;
        }
      }
      if (transitionPhase === "idle" && (shifted || before !== offsets || previousOffsetIds.current !== ids)) {
        // Keep `viewport.top` strictly synchronized with the compensated
        // `scrollTop` before paint: leaving `viewport.top` stale until the next
        // rAF would unmount every visible row for one frame if any state update
        // (such as `setLoadingOlder(false)`) renders after the anchor releases.
        updateViewport();
        if (shifted && measuredRevisionRef.current !== committedOffsetsRevisionRef.current && rangePrependSyncCountRef.current < 4) {
          rangePrependSyncCountRef.current += 1;
          setHeightVersion(value => value + 1);
        }
      }
    } else {
      if (transitionPhase === "idle") {
        transitionAnchorRef.current = null;
        if (!flushScheduled.current) {
          stabilizingAnchorRef.current = false;
        }
      }
      if (bottomPinnedNow && parent) {
        if (before !== offsets) {
          parent.scrollTop = parent.scrollHeight;
          // A follower's own pin is not the reader scrolling back down. Report it
          // like any other row-height correction so a gesture that just turned
          // following off cannot be undone by a scroll it did not make.
          parent.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
          if (transitionPhase === "idle") scheduleViewportUpdate();
        }
      } else if (!followingLatestNow && parent && rangePrependAnchor && rangeStart < prevRangeStart) {
        // Compensate newly mounted unmeasured older rows BEFORE the browser
        // paints this frame, preventing a one-frame jump down and snap back.
        const anchoredRow = rowElements.current.get(rangePrependAnchor.id);
        if (anchoredRow && anchoredRow.isConnected) {
          const shift = anchoredRow.getBoundingClientRect().top - rangePrependAnchor.visualTop;
          if (Math.abs(shift) >= 1) {
            parent.scrollTop += shift;
            parent.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
            const gesture = gestureRowAnchor.current;
            if (gesture) {
              const gestureRow = rowElements.current.get(gesture.id);
              if (gestureRow && gestureRow.isConnected) {
                gesture.visualTop = gestureRow.getBoundingClientRect().top;
                gesture.scrollTop = parent.scrollTop;
              }
            }
            // Flush both `viewport.top` (from the compensated `scrollTop`) and
            // `offsets` (from child measurements already stored in `heights`)
            // in one synchronous pre-paint commit so `visibleRows` never runs
            // with a stale `viewport.top` and unmounts visible bottom rows.
            if (rangePrependSyncCountRef.current < 4) {
              rangePrependSyncCountRef.current += 1;
              updateViewport();
              if (measuredRevisionRef.current !== committedOffsetsRevisionRef.current) {
                setHeightVersion(value => value + 1);
              }
            } else {
              scheduleViewportUpdate();
            }
          }
        }
      }
      // Keep the row under the user's gesture steady as rows above it resize.
      // The viewport top may still be in an older row while the user is reading
      // the answer lower down, so anchoring only that top row is insufficient.
      else if (!followingLatestNow && parent && before !== offsets && before.length > 1 &&
          previousOffsetIds.current[0] === ids[0]) {
        const gesture = gestureRowAnchor.current;
        const row = gesture && ref.current?.querySelector<HTMLElement>(
          `[data-transcript-id="${gesture.id.replace(/["\\]/g, "\\$&")}"]`);
        if (gesture && row) {
          if (gesture.awaitingScroll && Math.abs(parent.scrollTop - gesture.scrollTop) > 0.5) {
            gesture.awaitingScroll = false;
          }
          if (!gesture.awaitingScroll) {
            // Only a measured row change justifies moving scrollTop here. A route,
            // pane or animation re-render can momentarily report different
            // geometry while the commit settles; compensating that transient
            // would move a reader whose conversation did not actually change.
            if (hasMeasurementChange || pendingGestureMeasurementRef.current) {
              // The snapshot is taken before the gesture moves scrollTop. Compare
              // actual geometry rather than cached heights so a measurement already
              // pending at that moment is not compensated twice.
              const expectedTop = gesture.visualTop - (parent.scrollTop - gesture.scrollTop);
              const delta = row.getBoundingClientRect().top - expectedTop;
              if (Math.abs(delta) > 1) {
                parent.scrollTop += delta;
                parent.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
                if (transitionPhase === "idle") updateViewport();
              }
            }
            pendingGestureMeasurementRef.current = false;
            // Rebase either way, so a later unrelated commit cannot apply this
            // gesture's stale measurement to a settled viewport.
            gesture.visualTop = row.getBoundingClientRect().top;
            gesture.scrollTop = parent.scrollTop;
          } else if (hasMeasurementChange) {
            pendingGestureMeasurementRef.current = true;
          }
        } else if (hasMeasuredResize && ref.current) {
          const liveViewportTop = Math.round(
            parent.getBoundingClientRect().top + parent.clientTop - ref.current.getBoundingClientRect().top,
          );
          if (liveViewportTop > 0) {
            const index = liveViewportTop >= before.at(-1)! ? before.length - 1 : rowAt(before, liveViewportTop);
            if (index < offsets.length) {
              const delta = offsets[index] - before[index];
              const distFromBottom = parent.scrollHeight - parent.scrollTop - parent.clientHeight;
              if (Math.abs(delta) > 1 && distFromBottom > 40) {
                parent.scrollTop += delta;
                parent.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
                if (transitionPhase === "idle") updateViewport();
              }
            }
          }
        }
      }
    }
    const idsChanged = previousOffsetIds.current !== ids;
    previousOffsets.current = offsets;
    previousOffsetIds.current = ids;
    if (idsChanged && transitionPhase === "idle") scheduleViewportUpdate();
  }, [offsets, offsetsRevision, offsetsResizeRevision, ids, anchor, followingLatest, rangeStart, rangeEnd, transitionPhase, updateViewport, scheduleViewportUpdate]);
  useEffect(() => {
    if (transitionPhase !== "idle") return;
    for (const [id, element] of rowElements.current) {
      if (!element.isConnected) continue;
      measure(id, Math.round(element.offsetHeight || element.getBoundingClientRect().height));
    }
    scheduleViewportUpdate();
  }, [transitionPhase, measure, scheduleViewportUpdate]);
  return <div ref={ref} style={{ display: "flex", flexDirection: "column", gap, position: "relative",
    paddingTop: range.paddingTop, paddingBottom: range.paddingBottom, overflowAnchor: "none" }}>
    {/* These zero-height boundaries survive row virtualization and identify
        tool-only, empty, and not-yet-loaded Planner revisions as well. */}
    {sourceStarts.map(({ source, index }) => <span key={source} aria-hidden="true" data-transcript-source-start={source}
      style={{ position: "absolute", top: offsets[index] ?? totalHeight, height: 0, pointerEvents: "none" }} />)}
    {items.slice(range.start, range.end).map((item, index) => {
      const allowTransition = transitionPhase === "idle" ? true : (transitionInitialIdsRef.current?.has(item.id) ?? false);
      return <MeasuredListRow key={item.id} id={item.id} measure={measure} rowElements={rowElements}>{renderRow(item, range.start + index, allowTransition)}</MeasuredListRow>;
    })}
  </div>;
}
