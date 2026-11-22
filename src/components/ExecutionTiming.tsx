import { t, locale } from "../i18n";
import { useEffect, useState } from "react";
import type { Execution } from "../types";

/** Uses persisted attempt timestamps; switching attempts never resets the clock. */
export function ExecutionTiming({ execution }: { execution: Execution }) {
  const [now, setNow] = useState(Date.now);
  const running = execution.status === "running" && execution.completedAt == null;
  useEffect(() => {
    if (!running) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stopTimer = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const syncVisibility = () => {
      if (typeof document !== "undefined" && document.hidden) {
        stopTimer();
        return;
      }
      setNow(Date.now());
      if (timer === null) {
        timer = setInterval(() => setNow(Date.now()), 1000);
      }
    };
    syncVisibility();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", syncVisibility);
    }
    return () => {
      stopTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", syncVisibility);
      }
    };
  }, [running, execution.id]);
  const end = execution.completedAt ?? (running ? now : null);
  const seconds = end == null ? null : Math.max(0, Math.floor((end - execution.startedAt) / 1000));
  return (
    <span className="execution-timing">
      <time dateTime={new Date(execution.startedAt).toISOString()}>
        {new Date(execution.startedAt).toLocaleTimeString(locale)}
      </time>
      {seconds != null && <> · {running ? t("已运行") : t("总耗时")} {Math.floor(seconds / 60)}{t("分")}{seconds % 60}{t("秒")}</>}
    </span>
  );
}
