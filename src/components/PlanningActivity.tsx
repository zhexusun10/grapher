import { useEffect, useState } from "react";
import { runtimeService } from "../services/runtime";
import { VirtualizedTranscript } from "./VirtualizedTranscript";

export function PlanningActivity({ planning, onUserResize }: { planning: { planningId: string }; onUserResize?: () => void }) {
  const [record, setRecord] = useState({ id: "", content: "" });
  const output = record.id === planning.planningId ? record.content : "";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setRecord({ id: planning.planningId, content: "" });
    setError("");
    setLoading(true);
    let timer: ReturnType<typeof setTimeout>;
    let offset = 0;
    let text = "";
    const poll = async () => {
      try {
        while (!abort.signal.aborted) {
          const page = await runtimeService.getPlanningOutput(planning.planningId, "planner", offset, abort.signal);
          if (abort.signal.aborted) return;
          if (page.planningId !== planning.planningId || page.role !== "planner" || page.nextOffset < offset || (!page.complete && page.nextOffset === offset)) {
            throw new Error("规划记录与请求不匹配，请重试。");
          }
          text += page.content;
          if (page.content) setRecord({ id: planning.planningId, content: text });
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
  }, [planning.planningId, retry]);

  return <section className="planning-activity" aria-label="规划活动记录">
    {loading && <p role="status">正在加载规划活动…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {!loading && !error && !output && <p>没有可用的规划输出。</p>}
    {output && <div className="planning-activity-output">
      <VirtualizedTranscript key={`${planning.planningId}:planner`} output={output} onUserResize={onUserResize} />
    </div>}
  </section>;
}
