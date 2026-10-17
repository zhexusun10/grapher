import { t, localizeError } from "../i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Execution } from "../types";
import { runtimeService } from "../services/runtime";
import { VirtualizedTranscript } from "./VirtualizedTranscript";
import { liveOutputDelay, startVisibilityPolling } from "../services/visibilityPolling";
import { isRuntimeEventsConnected, RUNTIME_EVENTS_OUTPUT_WATCHDOG_MS, subscribeExecutionOutput, subscribeRuntimeEventsStatus } from "../services/runtimeEvents";
import { cacheTranscriptWindow, executionTranscriptCache, transcriptFromCache } from "../services/transcriptCache";
import { appendTranscriptPage, prependTranscriptPage, renderTranscriptWindow, windowFromPage, type TranscriptWindow } from "../services/transcriptWindow";
import { markTranscriptPrepend } from "../services/transcriptScroll";
import { INITIAL_TRANSCRIPT_BYTES, OLDER_TRANSCRIPT_BYTES } from "../services/transcriptPaging";
import { TranscriptHistoryStatus } from "./TranscriptHistoryStatus";
import { useStableCallback } from "../hooks/useStableCallback";
import { useTranscriptReader } from "../hooks/useTranscriptReader";
import { useAutoTranscriptHistory } from "../hooks/useAutoTranscriptHistory";
export { executionTranscriptCache } from "../services/transcriptCache";

type Props = {
  runId: string;
  execution: Execution;
  onLoadingChange?: (loading: boolean) => void;
  onUserResize?: (expanded?: boolean, card?: HTMLElement) => void;
  onInitialOutputReady?: (executionId: string) => void;
  onCompactingChange?: (compacting: boolean) => void;
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

function ExecutionHistory({ runId, execution, onLoadingChange, onUserResize, onInitialOutputReady, onCompactingChange }: Props) {
  const cacheKey = `${runId}:${execution.id}`;
  const paged = execution.outputBytes !== undefined;
  const settled = execution.status !== "running";
  const [window, setWindow] = useState(() => transcriptFromCache(executionTranscriptCache.get(cacheKey)));
  const windowRef = useRef(window);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [ready, setReady] = useState(!paged || window !== null || (!settled && !execution.outputBytes));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderBusy = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const announcedRef = useRef(false);
  const lifetime = useTranscriptReader("execution", cacheKey);
  const notifyLoading = useStableCallback((loading: boolean) => onLoadingChange?.(loading));
  const hasOlder = ready && Boolean(window?.start);
  const displayedText = paged ? (window ? renderTranscriptWindow(window) : "") : execution.output;

  // Node histories are view-owned. Going back to Planner releases their RAM,
  // including on collapse, Node-to-Node navigation and Conversation exit.
  useEffect(() => () => { executionTranscriptCache.delete(cacheKey); }, [cacheKey]);

  const publish = useCallback((next: TranscriptWindow) => {
    windowRef.current = next;
    executionTranscriptCache.set(cacheKey, cacheTranscriptWindow(next));
    setWindow(next);
  }, [cacheKey]);

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

  const initialReady = useAutoTranscriptHistory(wrapperRef, hasOlder, loadingOlder, error, window,
    preserveReading => { void loadOlder(preserveReading); }, ready, window ? window.end - window.start : 0);

  useLayoutEffect(() => {
    notifyLoading(!initialReady);
    return () => notifyLoading(false);
  }, [initialReady, notifyLoading]);
  useLayoutEffect(() => {
    if (initialReady && !announcedRef.current) {
      announcedRef.current = true;
      onInitialOutputReady?.(execution.id);
    }
  }, [initialReady, onInitialOutputReady, execution.id]);

  useEffect(() => {
    if (!paged) { setReady(true); return; }
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, lifetime.current!]);
    let emptyPages = 0;
    setError("");
    const cached = windowRef.current;
    if (cached?.settled && settled && cached.end === cached.total && cached.end >= (execution.outputBytes ?? cached.total)) {
      setReady(true);
      return () => abort.abort();
    }
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
        setReady(true);
        emptyPages = page.content ? 0 : emptyPages + 1;
        if (!page.complete) return 0;
        if (page.status !== "running") return null;
        // A missed output notification (dropped SSE frame, half-open stream)
        // must degrade to timer reads instead of stalling the transcript.
        return isRuntimeEventsConnected() ? RUNTIME_EVENTS_OUTPUT_WATCHDOG_MS : liveOutputDelay(emptyPages);
      } catch (caught) {
        if (!signal.aborted) { setError(String(caught)); setReady(true); }
        return null;
      }
    });
    const unsubscribeOutput = settled ? () => {} : subscribeExecutionOutput(runId, execution.id, event => {
      const current = windowRef.current;
      if (!event.settled && current && current.end >= event.totalBytes) return;
      stop.wake();
    });
    const unsubscribeConnect = settled ? () => {} : subscribeRuntimeEventsStatus(() => {
      stop.wake();
    });
    return () => { unsubscribeOutput(); unsubscribeConnect(); abort.abort(); stop(); };
  }, [runId, execution.id, execution.status, paged, settled, retry, publish, lifetime]);

  return <div ref={wrapperRef} data-execution-id={execution.id} data-run-id={runId} aria-busy={!initialReady}>
    {error && <p role="alert">{localizeError(error)} <button onClick={() => setRetry(value => value + 1)}>{t("重试")}</button></p>}
    {/* Live reads keep the status line reserved so paging never shifts output;
        settled history collapses the idle line to the same rhythm as Planner. */}
    <TranscriptHistoryStatus loading={loadingOlder} reserve={!settled} />
    {settled && !ready && !error ? <div className="transcript-loading" role="status" aria-label={t("正在加载历史记录…")}>
      <Loader2 size={14} className="spin" aria-hidden="true" />
    </div> : <VirtualizedTranscript compact output={displayedText} startOffset={window?.start ?? 0} settled={settled}
      onReachTop={window?.start && !error ? () => { void loadOlder(); } : undefined}
      onUserResize={onUserResize}
      onCompactingChange={onCompactingChange}
      emptyText={execution.status === "running" ? "" : t("该节点没有产生日志输出")} />}
  </div>;
}
