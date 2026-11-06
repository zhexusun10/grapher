import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { scrollParent } from "./VirtualizedList";

const SHOW_DELAY_MS = 150;
const PAGE_GAP_MS = 200;
const MIN_VISIBLE_MS = 300;

/** A status line below the viewport belongs to content the reader has not
 * reached; changing its height cannot move what they see and must not scroll
 * the shared conversation. A hidden line has no painted box at all. */
function statusAffectsViewport(element: HTMLElement, scroller: HTMLElement): boolean {
  if (element.getClientRects().length === 0) return false;
  const bounds = element.getBoundingClientRect();
  return bounds.top < scroller.getBoundingClientRect().top + scroller.clientHeight;
}

/** Keep the reserved line's geometry, but indicate a paging burst rather than
 * flashing on/off for each request. Fast isolated reads need no label; brief
 * gaps between pages keep it visible. These timers never drive actual paging.
 * `reserve={false}` collapses the idle line where a permanent blank band would
 * separate a user turn from the next reply. */
export function TranscriptHistoryStatus({ loading, reserve = true }: { loading: boolean; reserve?: boolean }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const lastHeight = useRef<number | null>(null);
  const lastPainted = useRef(false);
  const burstStartedAt = useRef<number | null>(null);
  const shownAt = useRef<number | null>(null);

  // An opted-out line changes height with its label. Compensate the shared
  // scroller so the rows being read do not jump by the line's height, but only
  // when the line is actually at or above the viewport: another transcript
  // lower in the conversation must not move the reader. A bottom-following view
  // is anchored to the end instead: subtracting a page gap there would leave it
  // one line short of the bottom.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const painted = element.getClientRects().length > 0;
    const height = element.offsetHeight;
    const previous = lastHeight.current;
    const wasPainted = lastPainted.current;
    lastHeight.current = height;
    lastPainted.current = painted;
    // A hidden/remounted line was not part of the reader's view while it
    // changed, so only a painted-to-painted resize may move the scroller.
    if (!painted || !wasPainted || previous === null || height === previous) return;
    const scroller = scrollParent(element);
    if (!scroller) return;
    const following = scroller.dataset.transcriptFollowing === "true" ||
      scroller.dataset.transcriptPreparing === "true";
    // A Latest animation owns the position and recomputes its target every
    // frame; jumping it to the end here would cut that motion short.
    if (following && scroller.dataset.transcriptScrollMode !== "latest") {
      if (scroller.scrollHeight > scroller.clientHeight) scroller.scrollTop = scroller.scrollHeight;
    } else if (scroller.scrollTop > 0 && statusAffectsViewport(element, scroller)) {
      scroller.scrollTop += height - previous;
    }
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
