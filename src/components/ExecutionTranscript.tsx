import { t, localizeError } from "../i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Execution, ImageAttachment } from "../types";
import { runtimeService } from "../services/runtime";
import { VirtualizedTranscript } from "./VirtualizedTranscript";
import { liveOutputDelay, startVisibilityPolling } from "../services/visibilityPolling";
import { isRuntimeEventsConnected, RUNTIME_EVENTS_OUTPUT_WATCHDOG_MS, subscribeExecutionOutput, subscribeRuntimeEventsStatus } from "../services/runtimeEvents";
import { cacheTranscriptWindow, executionTranscriptCache, transcriptFromCache } from "../services/transcriptCache";
import { appendTranscriptPage, prependTranscriptPage, renderTranscriptWindow, validateTranscriptPrepend, windowFromPage, type TranscriptWindow } from "../services/transcriptWindow";
import { markTranscriptPrepend, markTranscriptPrependIfReading, olderPageFits, onTranscriptScroll } from "../services/transcriptScroll";
import { INITIAL_TRANSCRIPT_BYTES, OLDER_TRANSCRIPT_BYTES, TRANSCRIPT_REVEAL_FALLBACK_MS } from "../services/transcriptPaging";
import { TranscriptHistoryStatus } from "./TranscriptHistoryStatus";
import { useStableCallback } from "../hooks/useStableCallback";
import { useTranscriptReader } from "../hooks/useTranscriptReader";
import { useAutoTranscriptHistory } from "../hooks/useAutoTranscriptHistory";
import type { LiveSteerMarker } from "../lib/pendingSteers";
export { executionTranscriptCache } from "../services/transcriptCache";

type Props = {
  runId: string;
  execution: Execution;
  endOffset?: number;
  onLoadingChange?: (loading: boolean) => void;
  onUserResize?: (expanded?: boolean, card?: HTMLElement) => void;
  onInitialOutputReady?: (executionId: string) => void;
  onCompactingChange?: (compacting: boolean) => void;
  /** Render only these steer turns inline; the surrounding chat owns the task
   * and continuation turns. */
  inlineUserTurnTexts?: readonly string[];
  onInlineUserTurnsChange?: (texts: string[], complete: boolean, turns: { text: string; offset?: number }[], end?: number) => void;
  liveSteers?: readonly LiveSteerMarker[];
  onEditUser?: (text: string, replacement: string, userTurnOffset?: number, images?: ImageAttachment[]) => boolean | void | Promise<unknown>;
};

export function ExecutionTranscript(props: Props) {
  return <ExecutionHistory key={`${props.runId}:${props.execution.id}:${props.endOffset ?? "full"}`} {...props} />;
}

/** Keep pending turns identical to an empty live transcript, including its
 * history-status line and transcript padding, before an Execution exists. */
export function ExecutionTranscriptPlaceholder() {
  return <div aria-hidden="true">
    <TranscriptHistoryStatus loading={false} reserve={false} />
    <VirtualizedTranscript compact output="" emptyText="" />
  </div>;
}

function ExecutionHistory({ runId, execution, endOffset, onLoadingChange, onUserResize, onInitialOutputReady, onCompactingChange, inlineUserTurnTexts, onInlineUserTurnsChange, onEditUser, liveSteers }: Props) {
  const cacheKey = `${runId}:${execution.id}${endOffset !== undefined ? `:${endOffset}` : ""}`;
  const paged = execution.outputBytes !== undefined;
  const settled = endOffset !== undefined || execution.status !== "running";
  const [window, setWindow] = useState(() => transcriptFromCache(executionTranscriptCache.get(cacheKey)));
  const windowRef = useRef(window);
  const [error, setError] = useState("");
  const failedOlder = useRef(false);
  const [retry, setRetry] = useState(0);
  const [ready, setReady] = useState(!paged || window !== null || (!settled && !execution.outputBytes));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showOlderLoading, setShowOlderLoading] = useState(false);
  const [revealFallback, setRevealFallback] = useState(false);
  const olderBusy = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const announcedRef = useRef(false);
  const lifetime = useTranscriptReader("execution", cacheKey);
  const notifyLoading = useStableCallback((loading: boolean) => onLoadingChange?.(loading));
  const notifyInlineUserTurns = useStableCallback((texts: string[], complete: boolean, turns: { text: string; offset?: number }[], end?: number) => onInlineUserTurnsChange?.(texts, complete, turns, end));
  const hasOlder = ready && Boolean(window?.start);
  const displayedText = paged ? (window ? renderTranscriptWindow(window) : "") : endOffset === undefined ? execution.output :
    new TextDecoder().decode(new TextEncoder().encode(execution.output).subarray(0, endOffset));

  // Node histories are view-owned. Going back to Planner releases their RAM,
  // including on collapse, Node-to-Node navigation and Conversation exit.
  useEffect(() => () => { executionTranscriptCache.delete(cacheKey); }, [cacheKey]);

  const publish = useCallback((next: TranscriptWindow) => {
    windowRef.current = next;
    executionTranscriptCache.set(cacheKey, cacheTranscriptWindow(next));
    setWindow(next);
  }, [cacheKey]);

  // A page the reader has not scrolled to yet: it stays out of the layout until
  // its insertion point reaches the viewport top, so extending the history never
  // compensates the scroll position under an active gesture.
  const pendingOlder = useRef<Awaited<ReturnType<typeof runtimeService.getExecutionOutput>> | null>(null);
  const [holdingOlder, setHoldingOlder] = useState(false);
  const commitPendingOlder = useStableCallback(() => {
    const page = pendingOlder.current;
    if (!page || lifetime.current?.aborted || !olderPageFits(wrapperRef.current)) return false;
    pendingOlder.current = null;
    try {
      markTranscriptPrependIfReading(wrapperRef.current);
      // A simultaneous forward response may have extended end; never replace it.
      publish(prependTranscriptPage(windowRef.current!, page));
    } catch (caught) { failedOlder.current = true; setError(String(caught)); }
    return true;
  });
  useEffect(() => {
    if (!holdingOlder) return;
    if (commitPendingOlder()) { setHoldingOlder(false); return; }
    return onTranscriptScroll(wrapperRef.current, () => { if (commitPendingOlder()) setHoldingOlder(false); });
  }, [holdingOlder, commitPendingOlder]);

  const loadOlder = useStableCallback(async (preserveReading: boolean = true) => {
    const before = windowRef.current;
    const signal = lifetime.current;
    if (!signal || signal.aborted) return;
    if (olderBusy.current) { if (preserveReading) setShowOlderLoading(true); return; }
    if (pendingOlder.current) { if (commitPendingOlder()) setHoldingOlder(false); return; }
    if (!before || before.start === 0) return;
    olderBusy.current = true; failedOlder.current = false;
    setLoadingOlder(true); setShowOlderLoading(preserveReading); setError("");
    if (preserveReading) markTranscriptPrepend(wrapperRef.current);
    try {
      const page = await runtimeService.getExecutionOutput(runId, execution.id, 0, signal, false, true, before.start, OLDER_TRANSCRIPT_BYTES, endOffset);
      if (signal.aborted) return;
      if (page.runId !== runId || page.executionId !== execution.id) throw new Error(t("执行记录与请求不匹配"));
      validateTranscriptPrepend(before, page);
      // Older bytes extend the history above the reader. Keep them out of the
      // layout until the reader reaches that point, so the page lands where
      // they scrolled to instead of compensating the scroll position under
      // their gesture.
      if (preserveReading && !olderPageFits(wrapperRef.current)) {
        pendingOlder.current = page;
        setHoldingOlder(true);
        return;
      }
      if (!preserveReading) markTranscriptPrependIfReading(wrapperRef.current);
      // A simultaneous forward response may have extended end; never replace it.
      const next = prependTranscriptPage(windowRef.current!, page);
      publish(next);
    } catch (caught) { if (!signal.aborted) { failedOlder.current = true; setError(String(caught)); } }
    finally {
      olderBusy.current = false;
      if (!signal.aborted) { setLoadingOlder(false); setShowOlderLoading(false); }
    }
  });

  const initialReady = useAutoTranscriptHistory(wrapperRef, hasOlder, loadingOlder, error, window,
    preserveReading => { void loadOlder(preserveReading); }, ready, window ? window.end - window.start : 0, holdingOlder);

  useLayoutEffect(() => {
    notifyLoading(!initialReady);
    return () => notifyLoading(false);
  }, [initialReady, notifyLoading]);
  // Reveal a settled history once the automatic viewport fill settles. While a
  // short tail is still filling, its newest rows sit high in the pane; when the
  // first older page lands they snap to the bottom of the filled history. Hiding
  // that commit behind the fade keeps the fade itself free of a re-layout. A
  // slow or stalled older read must still paint, so the fallback bounds the wait.
  // A live execution reveals on its first byte page: its rows grow in place and
  // the collapsed status line compensates paging, so there is no snap to hide.
  useEffect(() => {
    if (!settled || !ready || initialReady || announcedRef.current) return;
    const timer = setTimeout(() => setRevealFallback(true), TRANSCRIPT_REVEAL_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [settled, ready, initialReady]);

  useLayoutEffect(() => {
    if (announcedRef.current || !ready) return;
    if (settled && !initialReady && !revealFallback) return;
    announcedRef.current = true;
    onInitialOutputReady?.(execution.id);
  }, [settled, ready, initialReady, revealFallback, onInitialOutputReady, execution.id]);

  useEffect(() => {
    if (!paged) { setReady(true); return; }
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, lifetime.current!]);
    let emptyPages = 0;
    setError("");
    const cached = windowRef.current;
    if (cached?.settled && settled && cached.end === cached.total && cached.end >= Math.min(execution.outputBytes ?? cached.total, endOffset ?? Infinity)) {
      setReady(true);
      return () => abort.abort();
    }
    const stop = startVisibilityPolling(async () => {
      const before = windowRef.current;
      const offset = before?.end ?? 0;
      try {
        const page = await runtimeService.getExecutionOutput(runId, execution.id, offset, signal, false, !before, undefined,
          !before ? INITIAL_TRANSCRIPT_BYTES : undefined, endOffset);
        if (signal.aborted) return null;
        if (page.runId !== runId || page.executionId !== execution.id || page.nextOffset < offset || (!page.complete && page.nextOffset === offset)) {
          throw new Error(t("执行记录与请求不匹配"));
        }
        const latest = windowRef.current;
        const next = latest
          ? appendTranscriptPage(latest, { ...page, startOffset: page.startOffset ?? offset }, settled || page.status !== "running")
          : windowFromPage(page, settled || page.status !== "running");
        publish(next); // Empty terminal pages still update settled/total.
        setReady(true);
        emptyPages = page.content ? 0 : emptyPages + 1;
        if (!page.complete) return 0;
        if (settled || page.status !== "running") return null;
        // A missed output notification (dropped SSE frame, half-open stream)
        // must degrade to timer reads instead of stalling the transcript.
        return isRuntimeEventsConnected() ? RUNTIME_EVENTS_OUTPUT_WATCHDOG_MS : liveOutputDelay(emptyPages);
      } catch (caught) {
        if (!signal.aborted) { failedOlder.current = false; setError(String(caught)); setReady(true); }
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
  }, [runId, execution.id, execution.status, paged, settled, retry, publish, lifetime, endOffset]);

  return <div ref={wrapperRef} data-execution-id={execution.id} data-run-id={runId} aria-busy={!initialReady}>
    {error && <p role="alert">{localizeError(error)} <button onClick={() => {
      if (failedOlder.current) { setError(""); void loadOlder(); }
      else setRetry(value => value + 1);
    }}>{t("重试")}</button></p>}
    {/* Paging status collapses whenever it has no label, including while an
        execution is live; a reserved line would add a blank band between the
        user's turn and the streamed reply until the execution settles. The
        component compensates the scroller when the label appears instead. */}
    <TranscriptHistoryStatus loading={loadingOlder && showOlderLoading} reserve={false} />
    {settled && !ready && !error ? <div className="transcript-loading" role="status" aria-label={t("正在加载历史记录…")}>
      <Loader2 size={14} className="spin" aria-hidden="true" />
    </div> : <VirtualizedTranscript compact output={displayedText} startOffset={window?.start ?? 0} settled={settled}
      showUserTurns={!!inlineUserTurnTexts?.length}
      userTurnTexts={inlineUserTurnTexts}
      liveSteers={liveSteers}
      outputEndOffset={paged ? window?.end : new TextEncoder().encode(displayedText).length}
      onEditUser={onEditUser}
      onInlineUserTurnsChange={notifyInlineUserTurns}
      onReachTop={window?.start && !error ? () => { void loadOlder(); } : undefined}
      onUserResize={onUserResize}
      onCompactingChange={onCompactingChange}
      emptyText={execution.status === "running" ? "" : t("该节点没有产生日志输出")} />}
  </div>;
}
