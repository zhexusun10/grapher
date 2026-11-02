import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { estimateTranscriptRowHeight, retainedRowAnchor, rowAt, rowOffsets, visibleRows } from "../services/transcriptLayout";
import { shareJson } from "../services/structuralSharing";
import { FOLLOW_LATEST_EVENT, TRANSCRIPT_SCROLL_ADJUSTED_EVENT, isNestedScrollGesture } from "../services/transcriptScroll";

export function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let parent = element?.parentElement; parent; parent = parent.parentElement) {
    if (/^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

const MeasuredListRow = memo(function MeasuredListRow({ id, measure, children }: {
  id: string; measure: (id: string, height: number) => void; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current!;
    const update = () => measure(id, Math.round(element.offsetHeight || element.getBoundingClientRect().height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [id, measure]);
  return <div ref={ref} data-transcript-id={id} style={{ display: "flow-root" }}>{children}</div>;
});

/** Window document-flow rows using the *shared parent's* viewport, not a private scroll area.
 * The conversation remains responsible for following output and revealing expanded cards.
 */
export function VirtualizedList<T extends { id: string }>({ items, renderRow, gap = 0 }: {
  items: T[]; renderRow: (item: T, index: number) => React.ReactNode; gap?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const parentRef = useRef<HTMLElement | null>(null);
  const heights = useRef(new Map<string, number>());
  const resizedMeasuredRowsRef = useRef(false);
  const [heightVersion, setHeightVersion] = useState(0);
  const flushScheduled = useRef(false);
  const mounted = useRef(false);
  const frame = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600, hasScroller: true });
  const lastViewportRef = useRef(viewport);
  lastViewportRef.current = viewport;

  const measure = useCallback((id: string, height: number) => {
    if (height <= 0) return;
    const existing = heights.current.get(id);
    if (existing !== undefined) {
      if (Math.abs(existing - height) < 1) return;
      resizedMeasuredRowsRef.current = true;
    }
    heights.current.set(id, height);
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    queueMicrotask(() => {
      flushScheduled.current = false;
      if (mounted.current) setHeightVersion(value => value + 1);
    });
  }, []);
  const previousIds = useRef<string[]>([]);
  const ids = useMemo(() => shareJson(previousIds.current, items.map(item => item.id)), [items]);
  previousIds.current = ids;
  const offsets = useMemo(() => rowOffsets(ids,
    { get: (id: string) => { const height = heights.current.get(id); return height === undefined ? undefined : height + gap; } },
    (id: string) => estimateTranscriptRowHeight(id) + gap), [ids, gap, heightVersion]);
  const previousOffsets = useRef(offsets);
  const previousOffsetIds = useRef(ids);
  // Keep the anchor through the subsequent first measurements too. Otherwise
  // new rows initially use estimated heights, then drag the reader on the next
  // microtask when those estimates are replaced by actual heights.
  const readingAnchor = useRef<{ id: string; visualTop: number } | null>(null);
  // Preserve the row the reader actually scrolled over, not necessarily the
  // row at the viewport's top. A still-draining CoT above the answer can grow
  // while both are visible and otherwise push the answer out of the pane.
  const gestureRowAnchor = useRef<{ id: string; visualTop: number; scrollTop: number; awaitingScroll: boolean } | null>(null);
  const restoredScrollTop = useRef<number | null>(null);
  const stabilizingAnchorRef = useRef(false);
  const beforeIds = previousOffsetIds.current;
  const prefixChanged = beforeIds.length > 0 && ids[0] !== beforeIds[0];
  if (prefixChanged) {
    stabilizingAnchorRef.current = true;
  }
  const parent = parentRef.current;
  const followingLatest = parent?.dataset.transcriptScrollMode === "latest";
  const readingHistory = !followingLatest && parent?.dataset.transcriptHistoryReading === "true";
  let anchor = !readingHistory || (parent && !stabilizingAnchorRef.current && restoredScrollTop.current !== null && Math.abs(parent.scrollTop - restoredScrollTop.current) > 1)
    ? null : readingAnchor.current;
  if (readingHistory && prefixChanged && parent && ref.current) {
    const top = parent.getBoundingClientRect().top + parent.clientTop - ref.current.getBoundingClientRect().top;
    if (top + parent.clientHeight > 0) {
      const retained = retainedRowAnchor(beforeIds, ids, previousOffsets.current, offsets, top);
      const row = retained && ref.current.querySelector<HTMLElement>(`[data-transcript-id="${retained.id.replace(/["\\]/g, "\\$&")}"]`);
      if (row && retained) anchor = { id: retained.id, visualTop: row.getBoundingClientRect().top };
    }
  }
  const anchorIndex = anchor ? ids.indexOf(anchor.id) : -1;
  if (anchorIndex < 0) anchor = null;
  const anchorTop = anchor && parent
    ? offsets[anchorIndex] - (anchor.visualTop - parent.getBoundingClientRect().top - parent.clientTop) : null;
  const preparingBottom = !followingLatest && !readingHistory &&
    parent?.dataset.transcriptPreparing === "true";
  // The conversation reports whether it is following the newest output. A
  // follower must move with every measured row change, not just during the
  // initial fill; otherwise a tall streaming reasoning card can become the
  // de facto scroll anchor once it reaches the middle of the viewport.
  const followingOutput = !followingLatest && !readingHistory &&
    parent?.dataset.transcriptFollowing === "true";
  const pinnedToBottom = preparingBottom || followingOutput;
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
  useLayoutEffect(() => {
    mounted.current = true;
    parentRef.current = scrollParent(ref.current);
    const parent = parentRef.current;
    updateViewport();
    const releaseAnchor = () => {
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
      releaseAnchor();
    };
    const captureGestureAnchor = (row: HTMLElement | null | undefined, awaitingScroll = false) => {
      cancelGestureTimer();
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
          if (mounted.current) setHeightVersion(value => value + 1);
        }, 160);
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
    const onUserScrollGesture = (e: Event) => {
      if (parent && isNestedScrollGesture(e, parent)) return;
      const target = e.target instanceof Element ? e.target : null;
      let row = target?.closest<HTMLElement>("[data-transcript-id]");
      if (!row) {
        const y = e.type === "wheel" ? (e as WheelEvent).clientY : (e as TouchEvent).touches[0]?.clientY;
        row = visibleRowsInConversation().find(candidate => {
          const bounds = candidate.getBoundingClientRect();
          return y !== undefined && y >= bounds.top && y <= bounds.bottom;
        });
      }
      const mayScroll = e.type === "touchstart" || Math.abs((e as WheelEvent).deltaY) > 0.5;
      captureGestureAnchor(row, mayScroll);
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
    let scrollbarPointer: number | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (!parent || isNestedScrollGesture(event, parent)) return;
      releaseAnchor();
      const width = parent.offsetWidth - parent.clientWidth;
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
      captureGestureAnchor(target?.closest<HTMLElement>("[data-transcript-id]") ?? visibleRowsInConversation().at(-1), true);
      releaseAnchor();
    };
    const schedule = () => {
      const gesture = gestureRowAnchor.current;
      const bounds = visibleBounds();
      if (gesture && parent && bounds) {
        if (gesture.awaitingScroll && Math.abs(parent.scrollTop - gesture.scrollTop) > 0.5) {
          gesture.awaitingScroll = false;
          cancelGestureTimer();
        }
        const row = ref.current?.querySelector<HTMLElement>(`[data-transcript-id="${gesture.id.replace(/["\\]/g, "\\$&")}"]`);
        const expectedTop = gesture.visualTop - (parent.scrollTop - gesture.scrollTop);
        // Release an anchor the reader deliberately scrolled past. Use its
        // expected position without reflow: the actual row can temporarily be
        // outside the viewport precisely because the CoT above it grew.
        if (!row || expectedTop >= bounds.bottom || expectedTop + row.getBoundingClientRect().height <= bounds.top) {
          cancelGestureTimer();
          gestureRowAnchor.current = null;
        }
      }
      if (!stabilizingAnchorRef.current && parent && restoredScrollTop.current !== null && Math.abs(parent.scrollTop - restoredScrollTop.current) > 1) releaseAnchor();
      if (frame.current === null) {
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          updateViewport();
        });
      }
    };
    const observer = new ResizeObserver(updateViewport);
    if (parent) {
      parent.addEventListener(FOLLOW_LATEST_EVENT, clearGestureAnchor);
      parent.addEventListener("scroll", schedule, { passive: true });
      parent.addEventListener("wheel", onUserScrollGesture, { passive: true });
      parent.addEventListener("touchstart", onUserScrollGesture, { passive: true });
      parent.addEventListener("pointerdown", onPointerDown, { passive: true });
      parent.addEventListener("keydown", onKeyDown);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      observer.observe(parent);
    }
    return () => {
      mounted.current = false;
      parent?.removeEventListener(FOLLOW_LATEST_EVENT, clearGestureAnchor);
      parent?.removeEventListener("scroll", schedule);
      parent?.removeEventListener("wheel", onUserScrollGesture);
      parent?.removeEventListener("touchstart", onUserScrollGesture);
      parent?.removeEventListener("pointerdown", onPointerDown);
      parent?.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      cancelGestureTimer();
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [updateViewport]);
  useEffect(() => {
    const retained = new Set(ids);
    for (const id of heights.current.keys()) if (!retained.has(id)) heights.current.delete(id);
  }, [ids]);
  useLayoutEffect(() => {
    const before = previousOffsets.current;
    const parent = parentRef.current;
    const hasResize = resizedMeasuredRowsRef.current;
    resizedMeasuredRowsRef.current = false;
    // Follow state is also updated imperatively from scroll handlers without a
    // React render. Re-read it at commit time so a reader who just scrolled up
    // is never pulled back by this frame's row measurement.
    const followingLatestNow = parent?.dataset.transcriptScrollMode === "latest";
    const readingHistoryNow = !followingLatestNow && parent?.dataset.transcriptHistoryReading === "true";
    const bottomPinnedNow = !followingLatestNow && !readingHistoryNow &&
      (parent?.dataset.transcriptPreparing === "true" || parent?.dataset.transcriptFollowing === "true");

    readingAnchor.current = anchor;
    if (anchor && parent) {
      const retained = anchor;
      const row = ref.current?.querySelector<HTMLElement>(`[data-transcript-id="${retained.id.replace(/["\\]/g, "\\$&")}"]`);
      if (row) {
        const visualDelta = row.getBoundingClientRect().top - retained.visualTop;
        if (Math.abs(visualDelta) >= 1) {
          parent.scrollTop += visualDelta;
          parent.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
        }
      }
      restoredScrollTop.current = parent.scrollTop;
      if (!flushScheduled.current) {
        stabilizingAnchorRef.current = false;
      }
      updateViewport();
    } else if (bottomPinnedNow && parent) {
      if (before !== offsets) parent.scrollTop = parent.scrollHeight;
      updateViewport();
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
          // The snapshot is taken before the gesture moves scrollTop. Compare
          // actual geometry rather than cached heights so a measurement already
          // pending at that moment is not compensated twice.
          const expectedTop = gesture.visualTop - (parent.scrollTop - gesture.scrollTop);
          const delta = row.getBoundingClientRect().top - expectedTop;
          if (Math.abs(delta) > 1) {
            parent.scrollTop += delta;
            parent.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
          }
          gesture.visualTop = row.getBoundingClientRect().top;
          gesture.scrollTop = parent.scrollTop;
        }
      } else if (hasResize && viewport.top > 0) {
        const index = viewport.top >= before.at(-1)! ? before.length - 1 : rowAt(before, viewport.top);
        if (index < offsets.length) {
          const delta = offsets[index] - before[index];
          const distFromBottom = parent.scrollHeight - parent.scrollTop - parent.clientHeight;
          if (Math.abs(delta) > 1 && distFromBottom > 40) {
            parent.scrollTop += delta;
            parent.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
          }
        }
      }
    }
    previousOffsets.current = offsets;
    previousOffsetIds.current = ids;
  }, [offsets, ids, viewport.top, anchor, followingLatest, updateViewport]);
  const virtual = typeof window !== "undefined" && viewport.hasScroller && items.length > 35;
  const height = parent?.clientHeight || viewport.height;
  const totalHeight = offsets.at(-1) ?? 0;
  const top = anchorTop ?? (pinnedToBottom ? Math.max(viewport.top, totalHeight - height) : viewport.top);
  const range = virtual ? visibleRows(offsets, top, height, 16)
    : { start: 0, end: items.length, paddingTop: 0, paddingBottom: 0 };
  return <div ref={ref} style={{ display: "flex", flexDirection: "column", gap,
    paddingTop: range.paddingTop, paddingBottom: range.paddingBottom, overflowAnchor: "none" }}>
    {items.slice(range.start, range.end).map((item, index) =>
      <MeasuredListRow key={item.id} id={item.id} measure={measure}>{renderRow(item, range.start + index)}</MeasuredListRow>)}
  </div>;
}
