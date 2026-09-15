import { useEffect, useState } from "react";
import type { Execution } from "../types";
import { runtimeService } from "../services/runtime";
import { VirtualizedTranscript } from "./VirtualizedTranscript";

// Only mounted conversations fetch output. Switching attempts cancels the old
// cursor and releases its transcript; snapshots carry metadata alone.
export function ExecutionTranscript({ runId, execution }: { runId: string; execution: Execution }) {
  const [record, setRecord] = useState({ id: "", text: "" });
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const paged = execution.outputBytes !== undefined;
  useEffect(() => {
    if (!paged) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let offset = 0;
    let text = "";
    setRecord({ id: execution.id, text });
    setError("");
    const poll = async () => {
      try {
        const page = await runtimeService.getExecutionOutput(runId, execution.id, offset, abort.signal);
        if (abort.signal.aborted) return;
        if (page.runId !== runId || page.executionId !== execution.id || page.nextOffset < offset || (!page.complete && page.nextOffset === offset)) {
          throw new Error("执行记录与请求不匹配");
        }
        text += page.content;
        offset = page.nextOffset;
        if (page.content || page.status !== "running") {
          // Historical Finished events can lack a final newline. Flush the last
          // display line only at terminal EOF, never at an intermediate byte page.
          const complete = page.complete && page.status !== "running";
          setRecord({ id: execution.id, text: complete && text && !text.endsWith("\n") ? `${text}\n` : text });
        }
        if (!page.complete || page.status === "running") timer = setTimeout(poll, page.complete ? 1000 : 0);
      } catch (error) {
        if (!abort.signal.aborted) setError(String(error));
      }
    };
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [runId, execution.id, paged, retry]);
  return <>
    {error && <p role="alert">{error} <button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    <VirtualizedTranscript key={`${runId}:${execution.id}:${retry}`}
      output={paged ? (record.id === execution.id ? record.text : "") : execution.output} />
  </>;
}
