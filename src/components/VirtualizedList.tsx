import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { retainedRowAnchor, rowAt, rowOffsets, visibleRows } from "../services/transcriptLayout";
import { shareJson } from "../services/structuralSharing";
import { FOLLOW_LATEST_EVENT } from "../services/transcriptScroll";

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
    72 + gap), [ids, gap, heightVersion]);
  const previousOffsets = useRef(offsets);
  const previousOffsetIds = useRef(ids);
  // Keep the anchor through the subsequent first measurements too. Otherwise
  // new rows initially use estimated heights, then drag the reader on the next
  // microtask when those estimates are replaced by actual heights.
  const readingAnchor = useRef<{ id: string; visualTop: number } | null>(null);
  const restoredScrollTop = useRef<number | null>(null);
  const beforeIds = previousOffsetIds.current;
  const prefixChanged = beforeIds.length > 0 && ids[0] !== beforeIds[0];
  const parent = parentRef.current;
  const followingLatest = parent?.dataset.transcriptScrollMode === "latest";
  const readingHistory = !followingLatest && parent?.dataset.transcriptHistoryReading === "true";
  let anchor = !readingHistory || (parent && restoredScrollTop.current !== null && Math.abs(parent.scrollTop - restoredScrollTop.current) > 1)
    ? null : readingAnchor.current;
  if (readingHistory && prefixChanged && parent && ref.current) {
    const top = parent.getBoundingClientRect().top + parent.clientTop - ref.current.getBoundingClientRect().top;
    if (top + parent.clientHeight > 0) {
      const retained = retainedRowAnchor(beforeIds, ids, previousOffsets.current, offsets, top);
      const row = retained && Array.from(ref.current.querySelectorAll<HTMLElement>("[data-transcript-id]"))
        .find(element => element.dataset.transcriptId === retained.id);
      if (row && retained) anchor = { id: retained.id, visualTop: row.getBoundingClientRect().top };
    }
  }
  const anchorIndex = anchor ? ids.indexOf(anchor.id) : -1;
  if (anchorIndex < 0) anchor = null;
  const anchorTop = anchor && parent
    ? offsets[anchorIndex] - (anchor.visualTop - parent.getBoundingClientRect().top - parent.clientTop) : null;
  const preparingBottom = !followingLatest && !readingHistory &&
    parent?.dataset.transcriptPreparing === "true";
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
    const releaseAnchor = () => { readingAnchor.current = null; restoredScrollTop.current = null; };
    const schedule = () => {
      if (parent && restoredScrollTop.current !== null && Math.abs(parent.scrollTop - restoredScrollTop.current) > 1) releaseAnchor();
      if (frame.current === null) {
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          updateViewport();
        });
      }
    };
    const observer = new ResizeObserver(updateViewport);
    if (parent) {
      parent.addEventListener(FOLLOW_LATEST_EVENT, releaseAnchor);
      parent.addEventListener("scroll", schedule, { passive: true });
      parent.addEventListener("wheel", releaseAnchor, { passive: true });
      parent.addEventListener("touchstart", releaseAnchor, { passive: true });
      parent.addEventListener("pointerdown", releaseAnchor, { passive: true });
      parent.addEventListener("keydown", releaseAnchor);
      observer.observe(parent);
    }
    return () => {
      mounted.current = false;
      parent?.removeEventListener(FOLLOW_LATEST_EVENT, releaseAnchor);
      parent?.removeEventListener("scroll", schedule);
      parent?.removeEventListener("wheel", releaseAnchor);
      parent?.removeEventListener("touchstart", releaseAnchor);
      parent?.removeEventListener("pointerdown", releaseAnchor);
      parent?.removeEventListener("keydown", releaseAnchor);
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

    readingAnchor.current = anchor;
    if (anchor && parent) {
      const retained = anchor;
      const row = Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-transcript-id]") ?? [])
        .find(element => element.dataset.transcriptId === retained.id);
      if (row) parent.scrollTop += row.getBoundingClientRect().top - retained.visualTop;
      restoredScrollTop.current = parent.scrollTop;
      updateViewport();
    } else if (preparingBottom && parent) {
      if (before !== offsets) parent.scrollTop = parent.scrollHeight;
      updateViewport();
    }
    // Ordinary measurements retain the reading anchor too, without confusing
    // first measurements during a scroll with a history prepend.
    else if (!followingLatest && hasResize && parent && viewport.top > 0 && before !== offsets && before.length > 1 &&
        previousOffsetIds.current[0] === ids[0]) {
      const index = viewport.top >= before.at(-1)! ? before.length - 1 : rowAt(before, viewport.top);
      if (index < offsets.length) {
        const delta = offsets[index] - before[index];
        const distFromBottom = parent.scrollHeight - parent.scrollTop - parent.clientHeight;
        if (Math.abs(delta) > 1 && distFromBottom > 40) {
          parent.scrollTop += delta;
        }
      }
    }
    previousOffsets.current = offsets;
    previousOffsetIds.current = ids;
  }, [offsets, ids, viewport.top, anchor, followingLatest, preparingBottom, updateViewport]);
  const virtual = typeof window !== "undefined" && viewport.hasScroller && items.length > 35;
  const height = parent?.clientHeight || viewport.height;
  const totalHeight = offsets.at(-1) ?? 0;
  const top = anchorTop ?? (preparingBottom ? Math.max(viewport.top, totalHeight - height) : viewport.top);
  const range = virtual ? visibleRows(offsets, top, height, 16)
    : { start: 0, end: items.length, paddingTop: 0, paddingBottom: 0 };
  return <div ref={ref} style={{ display: "flex", flexDirection: "column", gap,
    paddingTop: range.paddingTop, paddingBottom: range.paddingBottom, overflowAnchor: "none" }}>
    {items.slice(range.start, range.end).map((item, index) =>
      <MeasuredListRow key={item.id} id={item.id} measure={measure}>{renderRow(item, range.start + index)}</MeasuredListRow>)}
  </div>;
}
