import { t, localizeError } from "../i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Execution } from "../types";
import { runtimeService } from "../services/runtime";
import { VirtualizedTranscript } from "./VirtualizedTranscript";
import { utf8Bytes } from "../lib/BoundedLruCache";
import { executionTranscriptCache, type CachedTranscript } from "../services/transcriptCache";
export { executionTranscriptCache } from "../services/transcriptCache";

// In-memory cache for execution transcripts so switching between node agents or reopening them
// immediately displays known logs on frame 0 instead of flashing empty.
const prefetches = new Map<string, Promise<string>>();
const listeners = new Map<string, Set<(entry: CachedTranscript) => void>>();
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
    publishTranscript(cacheKey, { text, offset: utf8Bytes(text), complete: execution.status !== "running", status: execution.status });
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

// Only mounted/explicitly requested nodes load logs; snapshots are metadata-only.
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
    id: cacheKey,
    text: cached && (!settled || cached.complete) ? cached.text : (!paged ? execution.output ?? "" : ""),
  }));
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [isFetchingFirstPage, setIsFetchingFirstPage] = useState(paged && (settled ? !cached?.complete : !cached && !execution.output));
  const [initialOutputReady, setInitialOutputReady] = useState(!paged || Boolean(cached?.complete || (!settled && cached?.text.includes("\n"))));
  const announcedToRef = useRef<typeof onInitialOutputReady>(undefined);
  const displayedText = paged ? (record.id === cacheKey ? record.text : "") : execution.output;

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
      setRecord({ id: cacheKey, text: cachedEntry.text });
      setIsFetchingFirstPage(false);
      setInitialOutputReady(true);
      return;
    }

    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let offset = cachedEntry ? cachedEntry.offset : 0;
    let text = cachedEntry ? cachedEntry.text : "";
    if (cachedEntry && (!settled || cachedEntry.complete)) {
      setRecord({ id: cacheKey, text: cachedEntry.text });
      setIsFetchingFirstPage(false);
    } else {
      setRecord({ id: cacheKey, text: "" });
      setIsFetchingFirstPage(true);
    }
    setError("");

    const onPrefetchPage = (entry: CachedTranscript) => {
      text = entry.text;
      offset = entry.offset;
      if (!settled || entry.complete) {
        setRecord({ id: cacheKey, text });
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
            setRecord({ id: cacheKey, text: finalText });
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
    if (execution.status !== "running" && record.text === "" && !error) {
      emptyText = t("该节点没有产生日志输出");
    }
  } else {
    if (execution.status !== "running" && !execution.output) {
      emptyText = t("该节点没有产生日志输出");
    }
  }

  return <div data-execution-id={execution.id} data-run-id={runId} aria-busy={isFetchingFirstPage}>
    {error && <p role="alert">{localizeError(error)} <button onClick={() => setRetry(value => value + 1)}>{t("重试")}</button></p>}
    {paged && settled && !displayedText && !error && (isFetchingFirstPage || record.id !== cacheKey) ?
      <div className="transcript-loading" role="status" aria-label={t("正在加载历史记录…")}>
        <Loader2 size={14} className="spin" aria-hidden="true" />
      </div> : <VirtualizedTranscript key={`${runId}:${execution.id}:${retry}`}
      compact
      emptyText={execution.status === "running" ? "" : emptyText}
      onUserResize={onUserResize}
      output={displayedText} />}
  </div>;
}
