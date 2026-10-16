import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";

const SHOW_DELAY_MS = 150;
const PAGE_GAP_MS = 200;
const MIN_VISIBLE_MS = 300;

/** Keep the reserved line's geometry, but indicate a paging burst rather than
 * flashing on/off for each request. Fast isolated reads need no label; brief
 * gaps between pages keep it visible. These timers never drive actual paging. */
export function TranscriptHistoryStatus({ loading }: { loading: boolean }) {
  const [visible, setVisible] = useState(false);
  const burstStartedAt = useRef<number | null>(null);
  const shownAt = useRef<number | null>(null);

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

  return <div className="transcript-history-status" role="status" aria-live="polite">
    {visible ? t("正在加载之前的记录…") : ""}
  </div>;
}
