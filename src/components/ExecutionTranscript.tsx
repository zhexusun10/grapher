import { t, localizeError } from "../i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Execution } from "../types";
import { runtimeService } from "../services/runtime";
import { VirtualizedTranscript } from "./VirtualizedTranscript";
import { liveOutputDelay, startVisibilityPolling } from "../services/visibilityPolling";
import { cacheTranscriptWindow, executionTranscriptCache, registerTranscriptReader, transcriptFromCache } from "../services/transcriptCache";
import { appendTranscriptPage, prependTranscriptPage, renderTranscriptWindow, windowFromPage, type TranscriptWindow } from "../services/transcriptWindow";
import { markTranscriptPrepend } from "../services/transcriptScroll";
import { INITIAL_TRANSCRIPT_BYTES, OLDER_TRANSCRIPT_BYTES } from "../services/transcriptPaging";
import { TranscriptHistoryStatus } from "./TranscriptHistoryStatus";
import { useStableCallback } from "../hooks/useStableCallback";
import { useTranscriptReader } from "../hooks/useTranscriptReader";
import { useAutoTranscriptHistory } from "../hooks/useAutoTranscriptHistory";
export { executionTranscriptCache } from "../services/transcriptCache";

// Explicit full-output callers only; ordinary history never uses this path.
const prefetches = new Map<string, Promise<string>>();
export function prefetchExecutionTranscript(runId: string, execution: Execution, signal?: AbortSignal): Promise<string> {
  const key = `${runId}:${execution.id}`;
  const existing = prefetches.get(key);
  if (existing) return existing;
  const task = fetchExecutionTranscript(runId, execution, signal);
  prefetches.set(key, task);
  void task.finally(() => { if (prefetches.get(key) === task) prefetches.delete(key); }).catch(() => {});
  return task;
}

async function fetchExecutionTranscript(runId: string, execution: Execution, outerSignal?: AbortSignal): Promise<string> {
  const key = `${runId}:${execution.id}`;
  const cached = executionTranscriptCache.get(key);
  if (cached?.complete && (cached.startOffset ?? 0) === 0) return cached.text;
  if (execution.outputBytes === undefined) return execution.output ?? "";
  const controller = new AbortController();
  const dispose = registerTranscriptReader("execution", key, controller);
  const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
  let text = (cached?.startOffset ?? 0) === 0 ? cached?.text ?? "" : "";
  let offset = (cached?.startOffset ?? 0) === 0 ? cached?.offset ?? 0 : 0;
  try {
    while (!signal.aborted) {
      const page = await runtimeService.getExecutionOutput(runId, execution.id, offset, signal, true);
      if (signal.aborted) return text;
      if (page.runId !== runId || page.executionId !== execution.id || page.nextOffset < offset || (!page.complete && page.nextOffset === offset)) {
        throw new Error(t("执行记录与请求不匹配"));
      }
      text += page.content;
      offset = page.nextOffset;
      const complete = page.complete && page.status !== "running";
      if (complete || execution.status === "running") {
        executionTranscriptCache.set(key, { text, offset, startOffset: 0, totalBytes: page.totalBytes, complete, status: page.status });
      }
      if (page.complete) return complete && text && !text.endsWith("\n") ? `${text}\n` : text;
    }
    return text;
  } finally { dispose(); }
}

type Props = {
  runId: string;
  execution: Execution;
  onLoadingChange?: (loading: boolean) => void;
  onUserResize?: (expanded?: boolean, card?: HTMLElement) => void;
  onInitialOutputReady?: (executionId: string) => void;
};

export function ExecutionTranscript(props: Props) {
  return <ExecutionHistory key={`${props.runId}:${props.execution.id}`} {...props} />;
}

/** Keep pending turns identical to an empty live transcript, including its
 * history-status line and transcript padding, before an Execution exists. */
export function ExecutionTranscriptPlaceholder() {
  return <div aria-hidden="true">
    <TranscriptHistoryStatus loading={false} />
    <VirtualizedTranscript compact output="" emptyText="" />
  </div>;
}

function ExecutionHistory({ runId, execution, onLoadingChange, onUserResize, onInitialOutputReady }: Props) {
  const cacheKey = `${runId}:${execution.id}`;
  const paged = execution.outputBytes !== undefined;
  const settled = execution.status !== "running";
  const [window, setWindow] = useState(() => transcriptFromCache(executionTranscriptCache.get(cacheKey)));
  const windowRef = useRef(window);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [ready, setReady] = useState(!paged || window !== null || !settled);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderBusy = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const announcedRef = useRef(false);
  const lifetime = useTranscriptReader("execution", cacheKey);
  const notifyLoading = useStableCallback((loading: boolean) => onLoadingChange?.(loading));

  // Node histories are view-owned. Going back to Planner releases their RAM,
  // including on collapse, Node-to-Node navigation and Conversation exit.
  useEffect(() => () => { executionTranscriptCache.delete(cacheKey); }, [cacheKey]);

  const publish = useCallback((next: TranscriptWindow) => {
    windowRef.current = next;
    executionTranscriptCache.set(cacheKey, cacheTranscriptWindow(next));
    setWindow(next);
  }, [cacheKey]);

  useLayoutEffect(() => {
    if (ready && onInitialOutputReady && !announcedRef.current) {
      announcedRef.current = true;
      onInitialOutputReady(execution.id);
    }
  }, [ready, onInitialOutputReady, execution.id]);

  useEffect(() => {
    if (!paged) { setReady(true); notifyLoading(false); return; }
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, lifetime.current!]);
    let emptyPages = 0;
    setError("");
    const cached = windowRef.current;
    if (cached?.settled && settled && cached.end === cached.total && cached.end >= (execution.outputBytes ?? cached.total)) {
      setReady(true); notifyLoading(false);
      return () => abort.abort();
    }
    notifyLoading(!cached && settled);
    const stop = startVisibilityPolling(async () => {
      const before = windowRef.current;
      const offset = before?.end ?? 0;
      try {
        const page = await runtimeService.getExecutionOutput(runId, execution.id, offset, signal, false, !before, undefined,
          !before ? INITIAL_TRANSCRIPT_BYTES : undefined);
        if (signal.aborted) return null;
        if (page.runId !== runId || page.executionId !== execution.id || page.nextOffset < offset || (!page.complete && page.nextOffset === offset)) {
          throw new Error(t("执行记录与请求不匹配"));
        }
        const latest = windowRef.current;
        const next = latest
          ? appendTranscriptPage(latest, { ...page, startOffset: page.startOffset ?? offset }, page.status !== "running")
          : windowFromPage(page, page.status !== "running");
        publish(next); // Empty terminal pages still update settled/total.
        setReady(true); notifyLoading(false);
        emptyPages = page.content ? 0 : emptyPages + 1;
        return !page.complete ? 0 : page.status === "running" ? liveOutputDelay(emptyPages) : null;
      } catch (caught) {
        if (!signal.aborted) { setError(String(caught)); setReady(true); notifyLoading(false); }
        return null;
      }
    });
    return () => { abort.abort(); stop(); notifyLoading(false); };
  }, [runId, execution.id, execution.status, paged, settled, retry, publish, notifyLoading, lifetime]);

  const loadOlder = useStableCallback(async (preserveReading = true) => {
    const before = windowRef.current;
    const signal = lifetime.current;
    if (!before || before.start === 0 || olderBusy.current || !signal || signal.aborted) return;
    olderBusy.current = true; setLoadingOlder(true); setError("");
    if (preserveReading) markTranscriptPrepend(wrapperRef.current);
    try {
      const page = await runtimeService.getExecutionOutput(runId, execution.id, 0, signal, false, true, before.start, OLDER_TRANSCRIPT_BYTES);
      if (signal.aborted) return;
      if (page.runId !== runId || page.executionId !== execution.id) throw new Error(t("执行记录与请求不匹配"));
      // A simultaneous forward response may have extended end; never replace it.
      const next = prependTranscriptPage(windowRef.current!, page);
      publish(next);
    } catch (caught) { if (!signal.aborted) setError(String(caught)); }
    finally { olderBusy.current = false; if (!signal.aborted) setLoadingOlder(false); }
  });

  useAutoTranscriptHistory(wrapperRef, ready && !!window?.start, loadingOlder, error, window?.start,
    preserveReading => { void loadOlder(preserveReading); });

  const displayedText = paged ? (window ? renderTranscriptWindow(window) : "") : execution.output;
  return <div ref={wrapperRef} data-execution-id={execution.id} data-run-id={runId} aria-busy={!ready}>
    {error && <p role="alert">{localizeError(error)} <button onClick={() => setRetry(value => value + 1)}>{t("重试")}</button></p>}
    <TranscriptHistoryStatus loading={loadingOlder} />
    {settled && !ready && !error ? <div className="transcript-loading" role="status" aria-label={t("正在加载历史记录…")}>
      <Loader2 size={14} className="spin" aria-hidden="true" />
    </div> : <VirtualizedTranscript compact output={displayedText} startOffset={window?.start ?? 0} settled={settled}
      onReachTop={window?.start && !error ? () => { void loadOlder(); } : undefined}
      onUserResize={onUserResize}
      emptyText={execution.status === "running" ? "" : t("该节点没有产生日志输出")} />}
  </div>;
}
