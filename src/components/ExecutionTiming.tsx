import React, { useEffect, useState } from "react";
import type { Execution } from "../types";

/** Uses persisted attempt timestamps; switching attempts never resets the clock. */
export function ExecutionTiming({ execution }: { execution: Execution }) {
  const [now, setNow] = useState(Date.now);
  const running = execution.status === "running" && execution.completedAt == null;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, execution.id]);
  const end = execution.completedAt ?? (running ? now : null);
  const seconds = end == null ? null : Math.max(0, Math.floor((end - execution.startedAt) / 1000));
  return (
    <span className="execution-timing">
      <time dateTime={new Date(execution.startedAt).toISOString()} title="开始时间">
        {new Date(execution.startedAt).toLocaleTimeString()}
      </time>
      {execution.completedAt != null && <> → <time dateTime={new Date(execution.completedAt).toISOString()} title="结束时间">
        {new Date(execution.completedAt).toLocaleTimeString()}
      </time></>}
      {seconds != null && <> · {running ? "已运行" : "耗时"} {Math.floor(seconds / 60)}分{seconds % 60}秒</>}
    </span>
  );
}
