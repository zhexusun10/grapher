import { useEffect, useLayoutEffect, useState } from "react";
import type { Execution } from "../types";
import { runtimeService } from "../services/runtime";
import { VirtualizedTranscript } from "./VirtualizedTranscript";

// In-memory cache for execution transcripts so switching between node agents or reopening them
// immediately displays known logs on frame 0 instead of flashing empty.
const executionTranscriptCache = new Map<string, { text: string; offset: number; complete: boolean; status?: string }>();

// Only mounted conversations fetch output. Switching attempts cancels the old
// cursor and releases its transcript; snapshots carry metadata alone.
export function ExecutionTranscript({
  runId,
  execution,
  onUserResize,
  onInitialOutputReady,
}: {
  runId: string;
  execution: Execution;
  onUserResize?: () => void;
  onInitialOutputReady?: () => void;
}) {
  const cacheKey = `${runId}:${execution.id}`;
  const cached = executionTranscriptCache.get(cacheKey);
  const paged = execution.outputBytes !== undefined;
  const [record, setRecord] = useState(() => ({
    id: execution.id,
    text: cached ? cached.text : (!paged ? execution.output ?? "" : ""),
  }));
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [isFetchingFirstPage, setIsFetchingFirstPage] = useState(!cached && paged && !execution.output);
  const [initialOutputReady, setInitialOutputReady] = useState(!paged || !!cached?.complete);

  useLayoutEffect(() => {
    if (initialOutputReady) onInitialOutputReady?.();
  }, [initialOutputReady, onInitialOutputReady]);

  useEffect(() => {
    if (!paged) return;
    const cachedEntry = executionTranscriptCache.get(cacheKey);
    if (cachedEntry?.complete && execution.status !== "running") {
      setRecord({ id: execution.id, text: cachedEntry.text });
      setIsFetchingFirstPage(false);
      setInitialOutputReady(true);
      return;
    }

    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let offset = cachedEntry ? cachedEntry.offset : 0;
    let text = cachedEntry ? cachedEntry.text : "";
    if (cachedEntry) {
      setRecord({ id: execution.id, text: cachedEntry.text });
      setIsFetchingFirstPage(false);
    } else {
      setRecord({ id: execution.id, text: "" });
      setIsFetchingFirstPage(true);
    }
    setError("");

    const poll = async () => {
      try {
        const page = await runtimeService.getExecutionOutput(runId, execution.id, offset, abort.signal);
        if (abort.signal.aborted) return;
        setIsFetchingFirstPage(false);
        if (page.runId !== runId || page.executionId !== execution.id || page.nextOffset < offset || (!page.complete && page.nextOffset === offset)) {
          throw new Error("执行记录与请求不匹配");
        }
        text += page.content;
        offset = page.nextOffset;
        const complete = page.complete && page.status !== "running";
        const finalText = complete && text && !text.endsWith("\n") ? `${text}\n` : text;
        executionTranscriptCache.set(cacheKey, { text: finalText, offset, complete, status: page.status });
        if (page.content || page.status !== "running") {
          setRecord({ id: execution.id, text: finalText });
        }
        // Wait for the entire initial snapshot, not just its first page, before showing the chat.
        if (page.complete) setInitialOutputReady(true);
        if (!page.complete || page.status === "running") timer = setTimeout(poll, page.complete ? 150 : 0);
      } catch (error) {
        if (!abort.signal.aborted) {
          setError(String(error));
          setInitialOutputReady(true);
        }
      }
    };
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [runId, execution.id, paged, retry, cacheKey, execution.status]);

  let emptyText = "工作区就绪，等待节点指令输出…";
  if (paged) {
    if (isFetchingFirstPage) {
      emptyText = "";
    } else if (execution.status !== "running" && record.text === "") {
      emptyText = "该节点没有产生日志输出";
    }
  } else {
    if (execution.status !== "running" && !execution.output) {
      emptyText = "该节点没有产生日志输出";
    }
  }

  return <>
    {error && <p role="alert">{error} <button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    <VirtualizedTranscript key={`${runId}:${execution.id}:${retry}`}
      emptyText={emptyText}
      onUserResize={onUserResize}
      output={paged ? (record.id === execution.id ? record.text : "") : execution.output} />
  </>;
}
