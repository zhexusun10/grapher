import { t, localizeError } from "../i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Execution } from "../types";
import { runtimeService } from "../services/runtime";
import { VirtualizedTranscript } from "./VirtualizedTranscript";

// In-memory cache for execution transcripts so switching between node agents or reopening them
// immediately displays known logs on frame 0 instead of flashing empty.
export const executionTranscriptCache = new Map<string, { text: string; offset: number; complete: boolean; status?: string }>();
type CachedTranscript = NonNullable<ReturnType<typeof executionTranscriptCache.get>>;
const prefetches = new Map<string, Promise<string>>();
const listeners = new Map<string, Set<(entry: CachedTranscript) => void>>();
// A single request loads all settled outputs for a selected conversation.
// Mounted transcripts join these promises instead of issuing duplicate reads.
export function prefetchRunExecutionTranscripts(runId: string, executions: Execution[], signal?: AbortSignal): Promise<void> {
  const pending = executions.filter(exec => exec.status !== "running" && !executionTranscriptCache.get(`${runId}:${exec.id}`)?.complete);
  if (pending.length === 0) return Promise.resolve();
  const request = runtimeService.getRunExecutionOutputs(runId, signal).then(result => {
    if (signal?.aborted || result.runId !== runId) return;
    const expected = new Set(pending.map(exec => exec.id));
    for (const output of result.outputs) {
      if (!expected.has(output.executionId)) continue;
      const text = output.content && !output.content.endsWith("\n") ? `${output.content}\n` : output.content;
      publishTranscript(`${runId}:${output.executionId}`, {
        text, offset: output.totalBytes, complete: true, status: output.status,
      });
    }
  });
  for (const exec of pending) {
    const key = `${runId}:${exec.id}`;
    const job = request.then(() => executionTranscriptCache.get(key)?.text ?? "");
    prefetches.set(key, job);
    void job.finally(() => { if (prefetches.get(key) === job) prefetches.delete(key); }).catch(() => {});
  }
  return request;
}

function publishTranscript(key: string, entry: CachedTranscript) {
  executionTranscriptCache.set(key, entry);
  listeners.get(key)?.forEach(listener => listener(entry));
}

export function prefetchExecutionTranscript(runId: string, execution: Execution, signal?: AbortSignal): Promise<string> {
  const cacheKey = `${runId}:${execution.id}`;
  const existing = prefetches.get(cacheKey);
  if (existing) return existing;
  const task = fetchExecutionTranscript(runId, execution, signal);
  prefetches.set(cacheKey, task);
  void task.finally(() => { if (prefetches.get(cacheKey) === task) prefetches.delete(cacheKey); }).catch(() => {});
  return task;
}

async function fetchExecutionTranscript(runId: string, execution: Execution, signal?: AbortSignal): Promise<string> {
  const cacheKey = `${runId}:${execution.id}`;
  const cached = executionTranscriptCache.get(cacheKey);
  if (cached && cached.complete) return cached.text;
  if (execution.outputBytes === undefined) {
    const text = execution.output ?? "";
    publishTranscript(cacheKey, { text, offset: text.length, complete: execution.status !== "running", status: execution.status });
    return text;
  }
  let text = cached ? cached.text : "";
  let offset = cached ? cached.offset : 0;
  while (!signal?.aborted) {
    const page = await runtimeService.getExecutionOutput(runId, execution.id, offset, signal, execution.status !== "running");
    if (signal?.aborted) return text;
    if (page.runId !== runId || page.executionId !== execution.id || page.nextOffset < offset || (!page.complete && page.nextOffset === offset)) {
      throw new Error(t("执行记录与请求不匹配"));
    }
    text += page.content;
    offset = page.nextOffset;
    const complete = page.complete && page.status !== "running";
    const finalText = complete && text && !text.endsWith("\n") ? `${text}\n` : text;
    // A settled history is published atomically: do not reveal tool cards page by page.
    if (page.complete || execution.status === "running") {
      publishTranscript(cacheKey, { text: finalText, offset, complete, status: page.status });
    }
    if (page.complete) return finalText;
  }
  return text;
}

// Mounted conversations consume an in-flight conversation prefetch when available;
// otherwise they fetch directly. Snapshots carry metadata alone.
export function ExecutionTranscript({
  runId,
  execution,
  onUserResize,
  onInitialOutputReady,
}: {
  runId: string;
  execution: Execution;
  onUserResize?: (expanded?: boolean, card?: HTMLElement) => void;
  onInitialOutputReady?: (executionId: string) => void;
}) {
  const cacheKey = `${runId}:${execution.id}`;
  const cached = executionTranscriptCache.get(cacheKey);
  const paged = execution.outputBytes !== undefined;
  const settled = execution.status !== "running";
  const [record, setRecord] = useState(() => ({
    id: execution.id,
    text: cached && (!settled || cached.complete) ? cached.text : (!paged ? execution.output ?? "" : ""),
  }));
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [isFetchingFirstPage, setIsFetchingFirstPage] = useState(paged && (settled ? !cached?.complete : !cached && !execution.output));
  const [initialOutputReady, setInitialOutputReady] = useState(!paged || Boolean(cached?.complete || (!settled && cached?.text.includes("\n"))));
  const announcedToRef = useRef<typeof onInitialOutputReady>(undefined);
  const displayedText = paged ? (record.id === execution.id ? record.text : "") : execution.output;

  useLayoutEffect(() => {
    if (onInitialOutputReady && announcedToRef.current !== onInitialOutputReady && initialOutputReady) {
      announcedToRef.current = onInitialOutputReady;
      onInitialOutputReady(execution.id);
    }
  }, [initialOutputReady, onInitialOutputReady, execution.id]);

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
    if (cachedEntry && (!settled || cachedEntry.complete)) {
      setRecord({ id: execution.id, text: cachedEntry.text });
      setIsFetchingFirstPage(false);
    } else {
      setRecord({ id: execution.id, text: "" });
      setIsFetchingFirstPage(true);
    }
    setError("");

    const onPrefetchPage = (entry: CachedTranscript) => {
      text = entry.text;
      offset = entry.offset;
      if (!settled || entry.complete) {
        setRecord({ id: execution.id, text });
        setIsFetchingFirstPage(false);
        if (entry.complete || text.includes("\n")) setInitialOutputReady(true);
      }
    };
    const pending = prefetches.get(cacheKey);
    if (pending) {
      const subscribers = listeners.get(cacheKey) ?? new Set<(entry: CachedTranscript) => void>();
      subscribers.add(onPrefetchPage);
      listeners.set(cacheKey, subscribers);
      // Pick up a page that arrived between the first cache read and subscription.
      const latest = executionTranscriptCache.get(cacheKey);
      if (latest && latest.offset >= offset) onPrefetchPage(latest);
    }

    const poll = async () => {
      try {
        const page = await runtimeService.getExecutionOutput(runId, execution.id, offset, abort.signal, settled);
        if (abort.signal.aborted) return;
        if (!settled) setIsFetchingFirstPage(false);
        if (page.runId !== runId || page.executionId !== execution.id || page.nextOffset < offset || (!page.complete && page.nextOffset === offset)) {
          throw new Error(t("执行记录与请求不匹配"));
        }
        text += page.content;
        offset = page.nextOffset;
        const complete = page.complete && page.status !== "running";
        const finalText = complete && text && !text.endsWith("\n") ? `${text}\n` : text;
        if (!settled || page.complete) {
          publishTranscript(cacheKey, { text: finalText, offset, complete, status: page.status });
          if (page.content || page.status !== "running") {
            setRecord({ id: execution.id, text: finalText });
          }
          setIsFetchingFirstPage(false);
          if (text.includes("\n") || page.complete) setInitialOutputReady(true);
        }
        if (!page.complete || page.status === "running") timer = setTimeout(poll, page.complete ? 150 : 0);
      } catch (error) {
        if (!abort.signal.aborted) {
          setError(String(error));
          setInitialOutputReady(true);
        }
      }
    };
    if (pending) {
      void pending.catch(() => {}).finally(() => {
        if (!abort.signal.aborted) {
          const latest = executionTranscriptCache.get(cacheKey);
          if (latest?.complete && execution.status !== "running") return;
          void poll();
        }
      });
    } else {
      void poll();
    }
    return () => {
      abort.abort();
      clearTimeout(timer);
      listeners.get(cacheKey)?.delete(onPrefetchPage);
      if (!listeners.get(cacheKey)?.size) listeners.delete(cacheKey);
    };
  }, [runId, execution.id, paged, retry, cacheKey, execution.status, settled]);

  let emptyText = t("工作区就绪，等待节点指令输出…");
  if (paged) {
    if (isFetchingFirstPage) {
      emptyText = t("正在加载历史记录…");
    } else if (execution.status !== "running" && record.text === "") {
      emptyText = t("该节点没有产生日志输出");
    }
  } else {
    if (execution.status !== "running" && !execution.output) {
      emptyText = t("该节点没有产生日志输出");
    }
  }

  return <>
    {error && <p role="alert">{localizeError(error)} <button onClick={() => setRetry(value => value + 1)}>{t("重试")}</button></p>}
    <VirtualizedTranscript key={`${runId}:${execution.id}:${retry}`}
      compact
      emptyText={execution.status === "running" ? "" : emptyText}
      onUserResize={onUserResize}
      output={displayedText} />
  </>;
}
