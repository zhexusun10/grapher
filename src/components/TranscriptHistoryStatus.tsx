import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { scrollParent } from "./VirtualizedList";

const SHOW_DELAY_MS = 150;
const PAGE_GAP_MS = 200;
const MIN_VISIBLE_MS = 300;

/** Keep the reserved line's geometry, but indicate a paging burst rather than
 * flashing on/off for each request. Fast isolated reads need no label; brief
 * gaps between pages keep it visible. These timers never drive actual paging.
 * `reserve={false}` collapses the idle line where a permanent blank band would
 * separate a user turn from the next reply. */
export function TranscriptHistoryStatus({ loading, reserve = true }: { loading: boolean; reserve?: boolean }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const lastHeight = useRef<number | null>(null);
  const burstStartedAt = useRef<number | null>(null);
  const shownAt = useRef<number | null>(null);

  // An opted-out line changes height with its label. Compensate the shared
  // scroller so the rows being read do not jump by the line's height.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const height = element.offsetHeight;
    const previous = lastHeight.current;
    lastHeight.current = height;
    if (previous === null || height === previous) return;
    const scroller = scrollParent(element);
    if (scroller && scroller.scrollTop > 0) scroller.scrollTop += height - previous;
  }, [visible, reserve]);

  useEffect(() => {
    const now = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    if (loading) {
      burstStartedAt.current ??= now;
      timer = setTimeout(() => {
        shownAt.current ??= Date.now();
        setVisible(true);
      }, Math.max(0, SHOW_DELAY_MS - (now - burstStartedAt.current)));
    } else {
      const delay = shownAt.current === null ? PAGE_GAP_MS
        : Math.max(PAGE_GAP_MS, MIN_VISIBLE_MS - (now - shownAt.current));
      timer = setTimeout(() => {
        burstStartedAt.current = null;
        shownAt.current = null;
        setVisible(false);
      }, delay);
    }
    // A new page cancels the pending hide; a completed fast read cancels its
    // pending show. Unmounting also cancels both kinds of delayed updates.
    return () => clearTimeout(timer);
  }, [loading]);

  const collapsed = !reserve && !visible;
  return <div ref={ref} className={`transcript-history-status${collapsed ? " collapsed" : ""}`} role="status" aria-live="polite">
    {visible ? t("正在加载之前的记录…") : ""}
  </div>;
}
