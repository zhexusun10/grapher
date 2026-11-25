import { t, localizeError } from "../i18n";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Loader2 } from "lucide-react";
import type { Execution, ImageAttachment } from "../types";
import { runtimeService } from "../services/runtime";
import { combineAbortSignals } from "../services/requestTimeout";
import { VirtualizedTranscript } from "./VirtualizedTranscript";
import { WorkspaceImageProvider } from "./WorkspaceImages";
import { liveOutputDelay, startVisibilityPolling } from "../services/visibilityPolling";
import { isRuntimeEventsConnected, notifyExecutionSettled, RUNTIME_EVENTS_OUTPUT_WATCHDOG_MS, subscribeExecutionOutput, subscribeRuntimeEventsStatus } from "../services/runtimeEvents";
import { cacheTranscriptWindow, executionTranscriptCache, executionTranscriptKey, transcriptFromCache } from "../services/transcriptCache";
import { appendTranscriptPage, normalizeTranscriptProjection, prependTranscriptPage, renderTranscriptWindow, validateTranscriptPrepend, windowFromPage, type TranscriptProjectionMode, type TranscriptWindow } from "../services/transcriptWindow";
import { markTranscriptPrepend, markTranscriptPrependIfReading, olderPageFits, onTranscriptScroll, TRANSCRIPT_SCROLL_ADJUSTED_EVENT, transcriptScrollParent } from "../services/transcriptScroll";
import { INITIAL_TRANSCRIPT_BYTES, OLDER_TRANSCRIPT_BYTES, SUMMARY_INITIAL_TRANSCRIPT_BYTES, SUMMARY_OLDER_TRANSCRIPT_BYTES, transcriptAutoFillBudget, TRANSCRIPT_REVEAL_FALLBACK_MS } from "../services/transcriptPaging";
import { observeElementResize } from "../services/sharedResizeObserver";
import { utf8Bytes } from "../lib/BoundedLruCache";
import { collectHydrationRanges, extractHydratedCardPatches, hydrationKeyForItem, isItemHydrated, type HydratedCardPatch } from "../services/cardHydration";
import type { TranscriptItem } from "../types";
import { TranscriptHistoryStatus } from "./TranscriptHistoryStatus";
import { useStableCallback } from "../hooks/useStableCallback";
import { useTranscriptReader } from "../hooks/useTranscriptReader";
import { useAutoTranscriptHistory } from "../hooks/useAutoTranscriptHistory";
import type { InlineSteerAttachment, LiveSteerMarker } from "../lib/pendingSteers";
import type { CardsTransitionPhase } from "./ActivitySummaryRow";
export { executionTranscriptCache } from "../services/transcriptCache";

type Props = {
  runId: string;
  execution: Execution;
  endOffset?: number;
  /** Older attempts acquire a reader only when the viewport reaches them. */
  defer?: boolean;
  foregroundReady?: boolean;
  onLoadingChange?: (executionId: string, loading: boolean) => void;
  onUserResize?: (expanded?: boolean, card?: HTMLElement) => void;
  onInitialOutputReady?: (executionId: string) => void;
  onCompactingChange?: (executionId: string, compacting: boolean) => void;
  /** Render only these steer turns inline; the surrounding chat owns the task
   * and continuation turns. */
  inlineUserTurnTexts?: readonly string[];
  inlineUserTurnRequestIds?: readonly string[];
  onInlineUserTurnsChange?: (
    executionId: string,
    texts: string[],
    complete: boolean,
    turns: { text: string; offset?: number; requestId?: string }[],
    end?: number,
    start?: number,
    steerOffsets?: Readonly<Record<string, number>>,
    steerOffsetsAuthoritative?: boolean,
  ) => void;
  liveSteers?: readonly LiveSteerMarker[];
  inlineSteerAttachments?: readonly InlineSteerAttachment[];
  cardsCollapsed?: boolean;
  cardsTransition?: CardsTransitionPhase;
  onEditUser?: (
    executionId: string,
    node: string,
    text: string,
    replacement: string,
    userTurnOffset?: number,
    images?: ImageAttachment[],
  ) => boolean | void | Promise<unknown>;
};

const LIVE_OUTPUT_COALESCE_MS = 48;

function sameList<T>(a?: readonly T[], b?: readonly T[]): boolean {
  if (a === b) return true;
  if (!a?.length && !b?.length) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameLiveSteers(a?: readonly LiveSteerMarker[], b?: readonly LiveSteerMarker[]): boolean {
  if (a === b) return true;
  if (!a?.length && !b?.length) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].requestId !== b[i].requestId || a[i].text !== b[i].text ||
      a[i].afterOffset !== b[i].afterOffset || a[i].occurrence !== b[i].occurrence ||
      a[i].images !== b[i].images || a[i].files !== b[i].files) return false;
  }
  return true;
}

function sameInlineAttachments(a?: readonly InlineSteerAttachment[], b?: readonly InlineSteerAttachment[]): boolean {
  if (a === b) return true;
  if (!a?.length && !b?.length) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].requestId !== b[i].requestId || a[i].text !== b[i].text ||
      a[i].inlineSteerOrdinal !== b[i].inlineSteerOrdinal ||
      a[i].images !== b[i].images || a[i].files !== b[i].files) return false;
  }
  return true;
}

export const ExecutionTranscript = memo(function ExecutionTranscript(props: Props) {
  return <WorkspaceImageProvider runId={props.runId} executionId={props.execution.id}>
    <ViewportExecutionHistory key={`${props.runId}:${props.execution.id}:${props.endOffset ?? "full"}`} {...props} />
  </WorkspaceImageProvider>;
}, (prev, next) =>
  prev.runId === next.runId &&
  prev.execution.id === next.execution.id &&
  prev.execution.node === next.execution.node &&
  prev.execution.status === next.execution.status &&
  prev.execution.outputBytes === next.execution.outputBytes &&
  prev.endOffset === next.endOffset &&
  prev.defer === next.defer &&
  prev.foregroundReady === next.foregroundReady &&
  prev.cardsCollapsed === next.cardsCollapsed &&
  prev.cardsTransition === next.cardsTransition &&
  prev.onLoadingChange === next.onLoadingChange &&
  prev.onUserResize === next.onUserResize &&
  prev.onInitialOutputReady === next.onInitialOutputReady &&
  prev.onCompactingChange === next.onCompactingChange &&
  prev.onInlineUserTurnsChange === next.onInlineUserTurnsChange &&
  prev.onEditUser === next.onEditUser &&
  sameList(prev.inlineUserTurnTexts, next.inlineUserTurnTexts) &&
  sameList(prev.inlineUserTurnRequestIds, next.inlineUserTurnRequestIds) &&
  sameLiveSteers(prev.liveSteers, next.liveSteers) &&
  sameInlineAttachments(prev.inlineSteerAttachments, next.inlineSteerAttachments)
);

function ViewportExecutionHistory(props: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const startedDeferredRef = useRef(Boolean(props.defer));
  const [activated, setActivated] = useState(!props.defer);
  const active = activated || !props.defer;
  useEffect(() => {
    // Promotion to the newest record is permanent for this mount. A later
    // appended turn must not turn that already-visible reader back into a stub.
    if (active) { if (!activated) setActivated(true); return; }
    if (props.foregroundReady === false) return;
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") { setActivated(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setActivated(true);
    }, { root: transcriptScrollParent(element), rootMargin: "600px 0px 0px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, activated, props.foregroundReady]);

  // When a deferred older execution activates above the viewport (within the
  // 600px IntersectionObserver rootMargin) and expands from its 120px stub to
  // its loaded transcript, compensate scrollTop before paint so the rows the
  // user is reading below never jump or flicker.
  useLayoutEffect(() => {
    if (!startedDeferredRef.current) return;
    const element = ref.current;
    if (!element) return;
    const readHeight = () => {
      const rectHeight = element.getBoundingClientRect().height;
      return rectHeight > 0 ? rectHeight : element.offsetHeight;
    };
    let prevHeight = readHeight();
    return observeElementResize(element, () => {
      const nextHeight = readHeight();
      const delta = nextHeight - prevHeight;
      prevHeight = nextHeight;
      if (Math.abs(delta) < 0.5) return;
      const scroller = transcriptScrollParent(element);
      if (!scroller || scroller.scrollTop <= 0) return;
      if (
        scroller.dataset.transcriptScrollMode === "latest" ||
        scroller.dataset.transcriptFollowing === "true" ||
        scroller.dataset.transcriptPreparing === "true"
      ) return;
      const scrollerTop = scroller.getBoundingClientRect().top + scroller.clientTop;
      const rect = element.getBoundingClientRect();
      // Only compensate when this execution sat strictly above the viewport top
      // before resizing; once it intersects the viewport its own VirtualizedList
      // anchors visible rows directly.
      const prevBottom = rect.top + (nextHeight - delta);
      if (prevBottom <= scrollerTop + 2) {
        scroller.scrollTop += delta;
        scroller.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
      }
    });
  }, []);

  return <div ref={ref} data-deferred-execution-id={!active ? props.execution.id : undefined}
    data-deferred-height-compensated={startedDeferredRef.current ? "true" : undefined}>
    {active ? <ExecutionHistory {...props} deferredReveal={startedDeferredRef.current} /> : <div className="transcript-loading" style={{ minHeight: 120 }}>
      <button type="button" onClick={() => setActivated(true)}>{t("加载历史记录")}</button>
    </div>}
  </div>;
}

/** Keep pending turns identical to an empty live transcript, including its
 * history-status line and transcript padding, before an Execution exists. */
export function ExecutionTranscriptPlaceholder() {
  return <div aria-hidden="true">
    <TranscriptHistoryStatus loading={false} reserve={false} />
    <VirtualizedTranscript compact output="" emptyText="" />
  </div>;
}

function ExecutionHistory({ runId, execution, endOffset, deferredReveal = false, onLoadingChange, onUserResize, onInitialOutputReady, onCompactingChange, inlineUserTurnTexts, inlineUserTurnRequestIds, onInlineUserTurnsChange, onEditUser, liveSteers, inlineSteerAttachments, cardsCollapsed = false, cardsTransition = "idle" }: Props & { deferredReveal?: boolean }) {
  const fullCacheKey = `${runId}:${execution.id}${endOffset !== undefined ? `:${endOffset}` : ""}`;
  const cardsCacheKey = executionTranscriptKey(fullCacheKey, "cards");
  const summaryCacheKey = executionTranscriptKey(fullCacheKey, "summary");
  const settled = endOffset !== undefined || execution.status !== "running";
  const [fullRequested, setFullRequested] = useState(false);
  const [cardsUnsupported, setCardsUnsupported] = useState(false);
  const [hydratedCards, setHydratedCards] = useState<Map<string, HydratedCardPatch>>(() => new Map());
  const [hydratingKeys, setHydratingKeys] = useState<Set<string>>(() => new Set());
  const hydratedCardsRef = useRef(hydratedCards);
  hydratedCardsRef.current = hydratedCards;
  const hydratingKeysRef = useRef<Set<string>>(new Set());
  const [window, setWindow] = useState(() => {
    const full = transcriptFromCache(executionTranscriptCache.get(fullCacheKey));
    if (!cardsCollapsed) {
      if (full) return full;
      return settled ? transcriptFromCache(executionTranscriptCache.get(cardsCacheKey)) : null;
    }
    if (full && full.start === 0) return full;
    return transcriptFromCache(executionTranscriptCache.get(summaryCacheKey))
      ?? (settled ? transcriptFromCache(executionTranscriptCache.get(cardsCacheKey)) : null)
      ?? full;
  });
  const currentProjection = normalizeTranscriptProjection(window);
  // Keep summary mode through an active expand animation so an arriving fetch
  // never swaps DOM mid-flight. In settled expanded mode, request the compact
  // `cards` shell projection unless a raw window is already loaded or requested.
  const targetProjection: TranscriptProjectionMode | undefined = fullRequested
    ? undefined
    : (Boolean(cardsCollapsed) || cardsTransition === "expanding")
      ? (window && currentProjection !== "summary" ? currentProjection : "summary")
      : (window && currentProjection === undefined
        ? undefined
        : (settled && !cardsUnsupported ? "cards" : undefined));
  useEffect(() => {
    if (!cardsCollapsed) setFullRequested(false);
  }, [cardsCollapsed]);
  // An execution that already has cached or persisted output when this view
  // mounts should render its existing running card settled, without replaying
  // an entrance animation on entry; later live chunks still animate in.
  const [suppressInitialAppear] = useState(() => window !== null || (execution.outputBytes ?? 0) > 0);
  const windowRef = useRef(window);
  const [error, setError] = useState("");
  const failedOlder = useRef(false);
  const [retry, setRetry] = useState(0);
  const [ready, setReady] = useState(window !== null || (!settled && !execution.outputBytes));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showOlderLoading, setShowOlderLoading] = useState(false);
  const [revealFallback, setRevealFallback] = useState(false);
  const olderBusy = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const announcedRef = useRef(false);
  const lifetime = useTranscriptReader("execution", fullCacheKey);
  const notifyLoading = useStableCallback((loading: boolean) => onLoadingChange?.(execution.id, loading));
  const notifyCompacting = useStableCallback((compacting: boolean) => onCompactingChange?.(execution.id, compacting));
  const notifyInlineUserTurns = useStableCallback((
    texts: string[],
    complete: boolean,
    turns: { text: string; offset?: number; requestId?: string }[],
    end?: number,
    start?: number,
    steerOffsets?: Readonly<Record<string, number>>,
    steerOffsetsAuthoritative?: boolean,
  ) => onInlineUserTurnsChange?.(execution.id, texts, complete, turns, end, start, steerOffsets, steerOffsetsAuthoritative));
  const handleEditUser = useCallback(
    (text: string, replacement: string, userTurnOffset?: number, images?: ImageAttachment[]) =>
      onEditUser?.(execution.id, execution.node, text, replacement, userTurnOffset, images),
    [onEditUser, execution.id, execution.node],
  );
  const hasOlder = ready && Boolean(window?.start);
  const displayedText = window ? renderTranscriptWindow(window) : "";

  const publish = useCallback((next: TranscriptWindow) => {
    windowRef.current = next;
    executionTranscriptCache.set(executionTranscriptKey(fullCacheKey, normalizeTranscriptProjection(next)), cacheTranscriptWindow(next));
    setWindow(next);
  }, [fullCacheKey]);

  // A page the reader has not scrolled to yet: it stays out of the layout until
  // its insertion point reaches the viewport top, so extending the history never
  // compensates the scroll position under an active gesture.
  const pendingOlder = useRef<Awaited<ReturnType<typeof runtimeService.getExecutionOutput>> | null>(null);
  const [holdingOlder, setHoldingOlder] = useState(false);
  const commitPendingOlder = useStableCallback((fromScroll = false) => {
    const page = pendingOlder.current;
    if (!page || lifetime.current?.aborted || !olderPageFits(wrapperRef.current)) return false;
    pendingOlder.current = null;
    const latest = windowRef.current;
    if (!latest || normalizeTranscriptProjection(latest) !== normalizeTranscriptProjection(page) || latest.start !== page.nextOffset) {
      setHoldingOlder(false);
      return true;
    }
    try {
      markTranscriptPrependIfReading(wrapperRef.current);
      // A simultaneous forward response may have extended end; never replace it.
      const next = prependTranscriptPage(latest, page);
      if (fromScroll) {
        try { flushSync(() => { publish(next); setHoldingOlder(false); }); }
        catch { publish(next); setHoldingOlder(false); }
      } else {
        publish(next);
        setHoldingOlder(false);
      }
    } catch (caught) { failedOlder.current = true; setError(String(caught)); setHoldingOlder(false); }
    return true;
  });
  useEffect(() => {
    if (!holdingOlder) return;
    if (commitPendingOlder(false)) { setHoldingOlder(false); return; }
    return onTranscriptScroll(wrapperRef.current, () => { if (commitPendingOlder(true)) setHoldingOlder(false); });
  }, [holdingOlder, commitPendingOlder]);

  const loadOlder = useStableCallback(async (preserveReading: boolean = true, readerRequested: boolean = preserveReading) => {
    const before = windowRef.current;
    const signal = lifetime.current;
    if (!signal || signal.aborted) return;
    if (olderBusy.current) {
      if (preserveReading) {
        setShowOlderLoading(true);
        markTranscriptPrepend(wrapperRef.current);
      }
      return;
    }
    if (pendingOlder.current) { if (commitPendingOlder()) setHoldingOlder(false); return; }
    if (!before || before.start === 0) return;
    const beforeProj = normalizeTranscriptProjection(before);
    const olderLimit = beforeProj === "summary" ? SUMMARY_OLDER_TRANSCRIPT_BYTES : OLDER_TRANSCRIPT_BYTES;
    const scroller = transcriptScrollParent(wrapperRef.current);
    const reservation = scroller ? transcriptAutoFillBudget(scroller).reserve(olderLimit, readerRequested) : null;
    if (scroller && !reservation) return;
    let receivedBytes = 0;
    olderBusy.current = true; failedOlder.current = false;
    setLoadingOlder(true); setShowOlderLoading(preserveReading); setError("");
    if (preserveReading) markTranscriptPrepend(wrapperRef.current);
    try {
      const page = await runtimeService.getExecutionOutput(runId, execution.id, 0, signal, false, true, before.start, reservation?.bytes ?? olderLimit, endOffset, beforeProj ?? false);
      if (signal.aborted) return;
      if (page.runId !== runId || page.executionId !== execution.id) throw new Error(t("执行记录与请求不匹配"));
      const currentAfterAwait = windowRef.current;
      // Discard stale older pages if the window switched projection while awaiting.
      if (!currentAfterAwait || normalizeTranscriptProjection(currentAfterAwait) !== beforeProj || currentAfterAwait.start !== before.start) return;
      const older = validateTranscriptPrepend(currentAfterAwait, page);
      receivedBytes = normalizeTranscriptProjection(older) ? utf8Bytes(older.text) : (older.end - older.start);
      // Older bytes extend the history above the reader. Keep them out of the
      // layout until the reader reaches that point, so the page lands where
      // they scrolled to instead of compensating the scroll position under
      // their gesture.
      if (preserveReading && !olderPageFits(wrapperRef.current)) {
        pendingOlder.current = page;
        setHoldingOlder(true);
        return;
      }
      if (announcedRef.current) markTranscriptPrependIfReading(wrapperRef.current);
      // A simultaneous forward response may have extended end; never replace it.
      const next = prependTranscriptPage(currentAfterAwait, page);
      publish(next);
    } catch (caught) { if (!signal.aborted) { failedOlder.current = true; setError(String(caught)); } }
    finally {
      reservation?.finish(receivedBytes);
      olderBusy.current = false;
      if (!signal.aborted) { setLoadingOlder(false); setShowOlderLoading(false); }
    }
  });

  // Prefetch the expanded projection during the 260ms collapse→expand animation
  // so switching to expanded cards lands warm without losing scrollback span.
  useEffect(() => {
    if (cardsTransition !== "expanding") return;
    const currentWin = windowRef.current;
    if (!currentWin || normalizeTranscriptProjection(currentWin) !== "summary") return;
    const prefetchProj: TranscriptProjectionMode | undefined = settled && !cardsUnsupported ? "cards" : undefined;
    const prefetchKey = executionTranscriptKey(fullCacheKey, prefetchProj);
    if (executionTranscriptCache.get(prefetchKey) || executionTranscriptCache.get(fullCacheKey)) return;
    const abort = new AbortController();
    const signal = combineAbortSignals(abort.signal, lifetime.current);
    const prefetchLimit = prefetchProj === "cards"
      ? SUMMARY_OLDER_TRANSCRIPT_BYTES
      : OLDER_TRANSCRIPT_BYTES;
    void runtimeService.getExecutionOutput(
      runId,
      execution.id,
      0,
      signal,
      false,
      true,
      currentWin.end,
      prefetchLimit,
      endOffset,
      prefetchProj ?? false,
    ).then(page => {
      if (signal.aborted) return;
      if (page.runId !== runId || page.executionId !== execution.id) return;
      const win = windowFromPage(page, settled || page.status !== "running");
      const actualProj = normalizeTranscriptProjection(win);
      if (prefetchProj === "cards" && actualProj !== "cards") setCardsUnsupported(true);
      executionTranscriptCache.set(executionTranscriptKey(fullCacheKey, actualProj), cacheTranscriptWindow(win));
    }).catch(() => { /* Best-effort transition prefetch; normal fetch runs on idle. */ });
    return () => abort.abort();
  }, [cardsTransition, settled, cardsUnsupported, fullCacheKey, runId, execution.id, endOffset, lifetime]);

  const initialReady = useAutoTranscriptHistory(wrapperRef, hasOlder, loadingOlder, error, window,
    preserveReading => { void loadOlder(preserveReading, false); }, ready, window ? window.end - window.start : 0, holdingOlder,
    undefined, commitPendingOlder);

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
    const abort = new AbortController();
    const signal = combineAbortSignals(abort.signal, lifetime.current);
    let emptyPages = 0;
    setError("");
    pendingOlder.current = null;
    setHoldingOlder(false);
    const current = windowRef.current;
    const targetCacheKey = executionTranscriptKey(fullCacheKey, targetProjection);
    const targetCached = (!current || normalizeTranscriptProjection(current) !== targetProjection)
      ? (transcriptFromCache(executionTranscriptCache.get(targetCacheKey))
        ?? (targetProjection === "cards" ? transcriptFromCache(executionTranscriptCache.get(fullCacheKey)) : null))
      : current;
    if (targetCached && targetCached !== current) {
      publish(targetCached);
    }
    const cached = targetCached && (normalizeTranscriptProjection(targetCached) === targetProjection
      || (targetProjection === "cards" && normalizeTranscriptProjection(targetCached) === undefined))
      ? targetCached : null;
    if (cached?.settled && settled && cached.end === cached.total && cached.end >= Math.min(execution.outputBytes ?? cached.total, endOffset ?? Infinity)) {
      setReady(true);
      return () => abort.abort();
    }
    let lastPullAt = 0;
    let pendingTotalBytes = 0;
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    const stop = startVisibilityPolling(async () => {
      const currentWin = windowRef.current;
      const currentProj = normalizeTranscriptProjection(currentWin);
      const before = currentWin && (currentProj === targetProjection || (targetProjection === "cards" && currentProj === undefined))
        ? currentWin : null;
      const offset = before?.end ?? 0;
      lastPullAt = Date.now();
      try {
        const upgradingFromSummary = !before && targetProjection !== "summary" && currentProj === "summary";
        const upgradeFullRange = upgradingFromSummary && targetProjection === undefined && settled && currentWin!.start === 0 && currentWin!.end <= 4 * 1024 * 1024;
        const initialLimit = targetProjection === "summary"
          ? SUMMARY_INITIAL_TRANSCRIPT_BYTES
          : (upgradingFromSummary
            ? (targetProjection === "cards" ? SUMMARY_OLDER_TRANSCRIPT_BYTES : OLDER_TRANSCRIPT_BYTES)
            : INITIAL_TRANSCRIPT_BYTES);
        const page = await runtimeService.getExecutionOutput(
          runId,
          execution.id,
          offset,
          signal,
          upgradeFullRange,
          !before && !upgradeFullRange,
          undefined,
          !before && !upgradeFullRange ? initialLimit : undefined,
          endOffset,
          targetProjection ?? false,
        );
        if (signal.aborted) return null;
        if (page.runId !== runId || page.executionId !== execution.id || page.nextOffset < offset || (!page.complete && page.nextOffset === offset)) {
          throw new Error(t("执行记录与请求不匹配"));
        }
        const latest = windowRef.current;
        const pageProj = normalizeTranscriptProjection(page);
        const canAppend = before !== null && latest !== null && normalizeTranscriptProjection(latest) === pageProj;
        const next = canAppend
          ? appendTranscriptPage(latest, page, settled || page.status !== "running")
          : windowFromPage(page, settled || page.status !== "running");
        if (targetProjection === "summary" && pageProj !== "summary") setFullRequested(true);
        if (targetProjection === "cards" && pageProj !== "cards") setCardsUnsupported(true);
        if (!before) {
          const scroller = transcriptScrollParent(wrapperRef.current);
          if (scroller) transcriptAutoFillBudget(scroller).charge(normalizeTranscriptProjection(next) ? utf8Bytes(next.text) : (next.end - next.start));
        }
        publish(next); // Empty terminal pages still update settled/total.
        setReady(true);
        emptyPages = page.content ? 0 : emptyPages + 1;
        if (!page.complete) return 0;
        if (!settled && page.status !== "running") {
          notifyExecutionSettled(runId, execution.id, page.totalBytes);
        }
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
      const currentWin = windowRef.current;
      if (!event.settled && currentWin && normalizeTranscriptProjection(currentWin) === targetProjection && currentWin.end >= event.totalBytes) return;
      if (event.settled) {
        if (coalesceTimer !== null) { clearTimeout(coalesceTimer); coalesceTimer = null; }
        stop.wake();
        return;
      }
      pendingTotalBytes = Math.max(pendingTotalBytes, event.totalBytes);
      const wait = LIVE_OUTPUT_COALESCE_MS - (Date.now() - lastPullAt);
      if (wait <= 0) {
        if (coalesceTimer !== null) { clearTimeout(coalesceTimer); coalesceTimer = null; }
        stop.wake();
      } else if (coalesceTimer === null) {
        coalesceTimer = setTimeout(() => {
          coalesceTimer = null;
          const latest = windowRef.current;
          if (latest && normalizeTranscriptProjection(latest) === targetProjection && latest.end >= pendingTotalBytes) return;
          stop.wake();
        }, wait);
      }
    });
    const unsubscribeConnect = settled ? () => {} : subscribeRuntimeEventsStatus(() => {
      stop.wake();
    });
    return () => {
      if (coalesceTimer !== null) { clearTimeout(coalesceTimer); coalesceTimer = null; }
      unsubscribeOutput();
      unsubscribeConnect();
      abort.abort();
      stop();
    };
  }, [runId, execution.id, execution.status, settled, retry, publish, lifetime, endOffset, targetProjection, fullCacheKey]);

  const requestFullTranscript = useCallback(() => setFullRequested(true), []);

  const hydrateItems = useStableCallback((targetItems: readonly TranscriptItem[]) => {
    const signal = lifetime.current;
    if (!signal || signal.aborted) return;
    const needed: TranscriptItem[] = [];
    const keys: string[] = [];
    for (const item of targetItems) {
      if (!item.bodyOmitted) continue;
      const key = hydrationKeyForItem(item);
      if (!key || isItemHydrated(item, hydratedCardsRef.current.get(key)) || hydratingKeysRef.current.has(key)) continue;
      needed.push(item);
      keys.push(key);
    }
    if (!needed.length) return;
    const ranges = collectHydrationRanges(needed);
    if (!ranges.length) {
      setFullRequested(true);
      return;
    }
    for (const key of keys) hydratingKeysRef.current.add(key);
    setHydratingKeys(new Set(hydratingKeysRef.current));
    void runtimeService.hydrateExecutionRanges(runId, execution.id, ranges, signal, endOffset)
      .then(page => {
        if (signal.aborted) return;
        if (page.projection !== "hydrated") {
          setFullRequested(true);
          return;
        }
        const patches = extractHydratedCardPatches(page.content, needed);
        if (patches.size > 0) {
          setHydratedCards(prev => {
            const next = new Map(prev);
            for (const [k, v] of patches) next.set(k, { ...next.get(k), ...v });
            return next;
          });
        }
      })
      .catch(() => {
        if (!signal.aborted) setFullRequested(true);
      })
      .finally(() => {
        for (const key of keys) hydratingKeysRef.current.delete(key);
        if (!signal.aborted) setHydratingKeys(new Set(hydratingKeysRef.current));
      });
  });

  const activeProjection = normalizeTranscriptProjection(window);

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
    {settled && !ready && !error ? <div key="loading" className="transcript-loading" style={deferredReveal ? { minHeight: 120 } : undefined} role="status" aria-label={t("正在加载历史记录…")}>
      <Loader2 size={14} className="spin" aria-hidden="true" />
    </div> : <div key="output" className="execution-transcript-content" style={{ opacity: deferredReveal || announcedRef.current || !settled || initialReady || revealFallback || error ? 1 : 0 }}>
      <VirtualizedTranscript compact output={displayedText} startOffset={window?.start ?? 0} settled={settled}
      suppressInitialAppear={suppressInitialAppear}
      parseCacheKey={`${runId}:execution:${execution.id}:${endOffset ?? "full"}${activeProjection ? `:${activeProjection}` : ""}`}
      showUserTurns={!!inlineUserTurnTexts?.length || !!inlineUserTurnRequestIds?.length}
      skipLeadingUserTurn
      userTurnTexts={inlineUserTurnTexts}
      userTurnRequestIds={inlineUserTurnRequestIds}
      liveSteers={liveSteers}
      inlineSteerAttachments={inlineSteerAttachments}
      cardsCollapsed={cardsCollapsed}
      cardsTransition={cardsTransition}
      onExpandSummary={activeProjection ? requestFullTranscript : undefined}
      hydratedCards={hydratedCards}
      hydratingKeys={hydratingKeys}
      onHydrateItems={activeProjection ? hydrateItems : undefined}
      outputEndOffset={window?.end}
      steerOffsets={window?.steerOffsets}
      steerOffsetsAuthoritative={window?.steerOffsetsAuthoritative}
      onEditUser={onEditUser ? handleEditUser : undefined}
      onInlineUserTurnsChange={notifyInlineUserTurns}
      onReachTop={window?.start && !error ? () => { void loadOlder(); } : undefined}
      onUserResize={onUserResize}
      onCompactingChange={onCompactingChange ? notifyCompacting : undefined}
      emptyText={execution.status === "running" || execution.status === "paused" ? "" : t("该节点没有产生日志输出")} /></div>}
  </div>;
}
