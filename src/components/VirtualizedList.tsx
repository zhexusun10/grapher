import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { rowAt, rowOffsets, visibleRows } from "../services/transcriptLayout";
import { shareJson } from "../services/structuralSharing";

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
    const update = () => measure(id, element.getBoundingClientRect().height);
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
  const [heightVersion, setHeightVersion] = useState(0);
  const flushScheduled = useRef(false);
  const mounted = useRef(false);
  const frame = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600, hasScroller: true });
  const measure = useCallback((id: string, height: number) => {
    if (height <= 0 || heights.current.get(id) === height) return;
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
  const updateViewport = useCallback(() => {
    const element = ref.current, parent = parentRef.current;
    if (!element || !parent) {
      setViewport(previous => previous.hasScroller ? { ...previous, hasScroller: false } : previous);
      return;
    }
    // Negative positions matter when a transcript lies below other conversation content.
    const top = parent.getBoundingClientRect().top + parent.clientTop - element.getBoundingClientRect().top;
    const height = parent.clientHeight || 600;
    setViewport(previous => previous.top === top && previous.height === height && previous.hasScroller
      ? previous : { top, height, hasScroller: true });
  }, []);
  useLayoutEffect(() => {
    mounted.current = true;
    parentRef.current = scrollParent(ref.current);
    const parent = parentRef.current;
    updateViewport();
    const schedule = () => {
      if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; updateViewport(); });
    };
    const observer = new ResizeObserver(updateViewport);
    if (parent) {
      parent.addEventListener("scroll", schedule, { passive: true });
      observer.observe(parent);
      if (parent.firstElementChild) observer.observe(parent.firstElementChild);
    }
    if (ref.current) observer.observe(ref.current);
    return () => {
      mounted.current = false;
      parent?.removeEventListener("scroll", schedule);
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
    // Preserve the reading anchor when measured rows above it change height.
    // Do not auto-follow here: that would override the workbench's user-scroll lock.
    if (parent && viewport.top > 0 && before !== offsets && before.length > 1) {
      const index = viewport.top >= before.at(-1)! ? before.length - 1 : rowAt(before, viewport.top);
      if (index < offsets.length) parent.scrollTop += offsets[index] - before[index];
    }
    previousOffsets.current = offsets;
    updateViewport();
  }, [offsets, updateViewport]);
  const virtual = typeof window !== "undefined" && viewport.hasScroller && items.length > 35;
  const range = virtual ? visibleRows(offsets, viewport.top, viewport.height, 8)
    : { start: 0, end: items.length, paddingTop: 0, paddingBottom: 0 };
  return <div ref={ref} style={{ display: "flex", flexDirection: "column", gap,
    paddingTop: range.paddingTop, paddingBottom: range.paddingBottom, overflowAnchor: "none" }}>
    {items.slice(range.start, range.end).map((item, index) =>
      <MeasuredListRow key={item.id} id={item.id} measure={measure}>{renderRow(item, range.start + index)}</MeasuredListRow>)}
  </div>;
}
