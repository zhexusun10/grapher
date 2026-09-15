import { useEffect, useState } from "react";
import type { PlanningSummary } from "../types";
import { runtimeService } from "../services/runtime";
import { VirtualizedTranscript } from "./VirtualizedTranscript";

export function PlanningActivity({ planning }: { planning: PlanningSummary }) {
  const [open, setOpen] = useState(planning.status === "running");
  const [role, setRole] = useState<"partition" | "planner">(planning.roles?.planner ? "planner" : "partition");
  const [record, setRecord] = useState({ id: "", role: "", content: "" });
  const output = record.id === planning.planningId && record.role === role ? record.content : "";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setRecord({ id: planning.planningId, role, content: "" });
    setError("");
    setLoading(true);
    let timer: ReturnType<typeof setTimeout>;
    let offset = 0;
    let text = "";
    const poll = async () => {
      try {
        while (!abort.signal.aborted) {
          const page = await runtimeService.getPlanningOutput(planning.planningId, role, offset, abort.signal);
          if (abort.signal.aborted) return;
          if (page.planningId !== planning.planningId || page.role !== role || page.nextOffset < offset || (!page.complete && page.nextOffset === offset)) {
            throw new Error("规划记录与请求不匹配，请重试。");
          }
          text += page.content;
          if (page.content) setRecord({ id: planning.planningId, role, content: text });
          offset = page.nextOffset;
          if (page.complete) {
            if (page.running) timer = setTimeout(poll, 1000);
            break;
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    };
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [open, planning.planningId, role, retry]);

  return <section className="planning-activity" aria-label="规划活动记录">
    <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {open ? "收起规划活动" : "查看规划活动"}
    </button>
    {open && <>
      <div className="planning-activity-tabs" aria-label="规划角色">
        {(["partition", "planner"] as const).filter(key => planning.roles?.[key]).map(key =>
          <button type="button" className={role === key ? "primary" : "secondary"} key={key}
            aria-pressed={role === key} onClick={() => setRole(key)}>
            {key === "partition" ? "Partitioner" : "Planner"}
          </button>)}
      </div>
      {loading && <p role="status">正在加载规划活动…</p>}
      {error && <p role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
      {!loading && !error && !output && <p>没有可用的规划输出。</p>}
      {output && <div className="planning-activity-output">
        <VirtualizedTranscript key={`${planning.planningId}:${role}`} output={output} />
      </div>}
    </>}
  </section>;
}
