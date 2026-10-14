import { t } from "../i18n";

/** A permanent, separate line: toggling text never inserts height or overlays
 * history, and cached/reopened Planner views have identical scroll geometry. */
export function TranscriptHistoryStatus({ loading }: { loading: boolean }) {
  return <div className="transcript-history-status" role="status" aria-live="polite">
    {loading ? t("正在加载之前的记录…") : ""}
  </div>;
}
