import { t, localizeError } from "../i18n";
import type { ChatMessage, TranscriptItem } from "../types";
import type { TranscriptRestoreAnchor } from "../services/conversationScroll";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, memo, useMemo } from "react";
import { flushSync } from "react-dom";
import { runtimeService } from "../services/runtime";
import { combineAbortSignals } from "../services/requestTimeout";
import { isRuntimeEventsConnected, RUNTIME_EVENTS_OUTPUT_WATCHDOG_MS, subscribePlanningOutput, subscribeRuntimeEventsStatus } from "../services/runtimeEvents";
import { liveOutputDelay, startVisibilityPolling } from "../services/visibilityPolling";
import { useStableCallback } from "../hooks/useStableCallback";
import { useTranscriptReader } from "../hooks/useTranscriptReader";
import { useAutoTranscriptHistory } from "../hooks/useAutoTranscriptHistory";
import { VirtualizedTranscript } from "./VirtualizedTranscript";
import { cacheTranscriptWindow, composePlanningOutput, planningTranscriptCache, planningTranscriptKey, transcriptFromCache } from "../services/transcriptCache";
import { activePlannerOutput } from "../lib/plannerOutput";
import { appendTranscriptPage, normalizeTranscriptProjection, prependTranscriptPage, validateTranscriptPrepend, windowFromPage, type TranscriptProjectionMode, type TranscriptWindow } from "../services/transcriptWindow";
import { markTranscriptPrepend, markTranscriptPrependIfReading, olderPageFits, onTranscriptScroll, transcriptScrollParent } from "../services/transcriptScroll";
import { INITIAL_TRANSCRIPT_BYTES, OLDER_TRANSCRIPT_BYTES, SUMMARY_INITIAL_TRANSCRIPT_BYTES, SUMMARY_OLDER_TRANSCRIPT_BYTES, transcriptAutoFillBudget, TRANSCRIPT_REVEAL_FALLBACK_MS } from "../services/transcriptPaging";
import { utf8Bytes } from "../lib/BoundedLruCache";
import { TranscriptHistoryStatus } from "./TranscriptHistoryStatus";
import type { CardsTransitionPhase } from "./ActivitySummaryRow";
import { collectHydrationRanges, extractHydratedCardPatches, hydrationKeyForItem, isItemHydrated, type HydratedCardPatch } from "../services/cardHydration";
export { planningTranscriptCache } from "../services/transcriptCache";
export { activePlannerOutput } from "../lib/plannerOutput";

type Props = {
  runId?: string;
  planningIds: string[];
  onReady?: () => void;
  onOutputChange?: (output: string) => void;
  onLoadingChange?: (loading: boolean) => void;
  showUserTurns?: boolean;
  skipFirstUser?: boolean;
  onUserResize?: (expanded?: boolean, card?: HTMLElement) => void;
  onEditUser?: (text: string, replacement: string) => boolean | void | Promise<unknown>;
  edits?: Array<{ old_instruction?: string; nextPlanningId?: string }>;
  running?: boolean;
  /** The only composed revision that is still live; older turns stay settled. */
  livePlanningId?: string;
  /** Revisions whose output starts a new conversation section (post-task review). */
  dividerSources?: ReadonlySet<string>;
  /** Local prompts belonging to saved revisions, used only if their log omits the user row. */
  sourceUserFallbacks?: ReadonlyMap<string, readonly ChatMessage[]>;
  rowHeights?: Map<string, number>;
  restoreAnchor?: TranscriptRestoreAnchor;
  onRestoreScroll?: (scrollTop: number | null) => void;
  onCompactingChange?: (compacting: boolean) => void;
  cardsCollapsed?: boolean;
  cardsTransition?: CardsTransitionPhase;
};

/** Read backward through the contiguous loaded suffix, one revision/page at a time. */
function olderTarget(ids: string[], segments: ReadonlyMap<string, TranscriptWindow>): string | null {
  for (let index = ids.length - 1; index >= 0; index--) {
    const window = segments.get(ids[index]);
    if (!window || window.start > 0) return ids[index];
  }
  return null;
}

/** The writer can notify once per committed line. A wake re-composes the whole
 * loaded conversation, so bound live re-reads instead of following the writer's
 * cadence; a terminal notification is still delivered well before a reader
 * would notice. */
const MIN_LIVE_REREAD_MS = 120;

export const PlanningActivity = memo(function PlanningActivity(props: Props) {
  const [identity, setIdentity] = useState({ runId: props.runId, ids: props.planningIds, generation: 0 });
  const extendsHistory = identity.runId === props.runId && identity.ids.every((id, index) => props.planningIds[index] === id);
  if (!extendsHistory || identity.ids.length !== props.planningIds.length) {
    setIdentity({ runId: props.runId, ids: props.planningIds, generation: identity.generation + (extendsHistory ? 0 : 1) });
  }
  // A review/follow-up appends a log, not a new conversation. Keep mounted
  // windows and row state even if their global LRU entries have been evicted.
  // Replacing/reordering history (or changing Run) still starts a fresh reader.
  return <PlanningHistory key={identity.generation} {...props} />;
});

function PlanningHistory({ runId = "", planningIds, onReady, onOutputChange, onLoadingChange, showUserTurns = false,
  skipFirstUser = false, onUserResize, onEditUser, edits = [], running = false, livePlanningId, dividerSources,
  sourceUserFallbacks, rowHeights, restoreAnchor, onRestoreScroll, onCompactingChange, cardsCollapsed = false, cardsTransition = "idle" }: Props) {
  const key = planningIds.join(":");
  const [fullRequested, setFullRequested] = useState(false);
  const [cardsUnsupported, setCardsUnsupported] = useState(false);
  const [hydratedCards, setHydratedCards] = useState<Map<string, HydratedCardPatch>>(() => new Map());
  const [hydratingKeys, setHydratingKeys] = useState<Set<string>>(() => new Set());
  const hydratedCardsRef = useRef(hydratedCards);
  hydratedCardsRef.current = hydratedCards;
  const hydratingKeysRef = useRef<Set<string>>(new Set());
  const activeLiveId = running && livePlanningId && planningIds.includes(livePlanningId)
    ? livePlanningId : running ? planningIds.at(-1) : undefined;
  const [initialSegments] = useState(() => {
    const loaded = new Map<string, TranscriptWindow>();
    for (const id of planningIds) {
      const full = transcriptFromCache(planningTranscriptCache.get(planningTranscriptKey(runId, id, false)));
      const cards = id !== activeLiveId
        ? transcriptFromCache(planningTranscriptCache.get(planningTranscriptKey(runId, id, "cards")))
        : null;
      const summary = transcriptFromCache(planningTranscriptCache.get(planningTranscriptKey(runId, id, "summary")));
      const window = !cardsCollapsed
        ? (full ?? cards)
        : (full && full.start === 0 ? full : (summary ?? cards ?? full));
      if (window) loaded.set(id, window);
    }
    return loaded;
  });
  const segments = useRef(initialSegments);
  const [segmentVersion, setSegmentVersion] = useState(0);
  const hasSummarySegments = [...segments.current.values()].some(w => normalizeTranscriptProjection(w) === "summary");
  const hasProjectedSegments = [...segments.current.values()].some(w => Boolean(normalizeTranscriptProjection(w)));
  const hasFullLoaded = segments.current.size > 0 && !hasSummarySegments;
  const useSummaryOnly = (Boolean(cardsCollapsed) || cardsTransition === "expanding") && !fullRequested && !hasFullLoaded;
  const targetProjectionFor = useCallback((planningId: string, existing?: TranscriptWindow): TranscriptProjectionMode | undefined => {
    if (fullRequested) return undefined;
    const existingProj = normalizeTranscriptProjection(existing);
    if (useSummaryOnly) {
      return existing && existingProj !== "summary" ? existingProj : "summary";
    }
    if (existing && existingProj === undefined) return undefined;
    return planningId !== activeLiveId && !cardsUnsupported ? "cards" : undefined;
  }, [fullRequested, useSummaryOnly, activeLiveId, cardsUnsupported]);
  useEffect(() => {
    if (!cardsCollapsed) setFullRequested(false);
  }, [cardsCollapsed]);
  const output = useMemo(() => composePlanningOutput(planningIds, segments.current), [key, segmentVersion]);
  const [readKey, setReadKey] = useState<string | null>(null);
  const ready = !planningIds.length || segments.current.has(planningIds.at(-1)!) || readKey === key;
  // Appended turns may already be cached, but the mounted windows are the
  // authority for earlier turns and must never be replaced with shorter tails.
  useLayoutEffect(() => {
    let changed = false;
    for (const id of planningIds) {
      if (segments.current.has(id)) continue;
      const full = transcriptFromCache(planningTranscriptCache.get(planningTranscriptKey(runId, id, false)));
      const cards = id !== activeLiveId
        ? transcriptFromCache(planningTranscriptCache.get(planningTranscriptKey(runId, id, "cards")))
        : null;
      const summary = transcriptFromCache(planningTranscriptCache.get(planningTranscriptKey(runId, id, "summary")));
      const window = !useSummaryOnly
        ? (full ?? cards)
        : (full && full.start === 0 ? full : (summary ?? cards ?? full));
      if (window) { segments.current.set(id, window); changed = true; }
    }
    if (changed) setSegmentVersion(value => value + 1);
  }, [runId, key, useSummaryOnly, activeLiveId]);
  const [revealFallback, setRevealFallback] = useState(false);
  const [error, setError] = useState("");
  const failedOlder = useRef(false);
  const [retry, setRetry] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showOlderLoading, setShowOlderLoading] = useState(false);
  const olderBusy = useRef(false);
  const olderRequested = useRef(false);
  const announcedRef = useRef(false);
  const announcedKeyRef = useRef<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const lifetime = useTranscriptReader("planning", `${runId}:view`);
  const notifyReady = useStableCallback(() => onReady?.());
  const notifyOutput = useStableCallback((text: string) => onOutputChange?.(text));
  const notifyLoading = useStableCallback((loading: boolean) => onLoadingChange?.(loading));
  const editUser = useStableCallback((text: string, replacement: string) => onEditUser?.(text, replacement));
  const editKey = JSON.stringify(edits);
  const activeOutput = useMemo(() => activePlannerOutput(output, edits), [output, editKey]);
  // A missing older revision must not make the first loaded user look like the goal.
  const historyStartsAtBeginning = planningIds.length > 0 && segments.current.get(planningIds[0])?.start === 0;
  const skipInitialUser = skipFirstUser && historyStartsAtBeginning;
  const hasOlder = ready && olderTarget(planningIds, segments.current) !== null;

  const publish = useStableCallback((planningId: string, window: TranscriptWindow) => {
    segments.current.set(planningId, window);
    planningTranscriptCache.set(planningTranscriptKey(runId, planningId, normalizeTranscriptProjection(window) ?? false), cacheTranscriptWindow(window));
    setSegmentVersion(value => value + 1);
  });

  // A page the reader has not scrolled to yet: it stays out of the layout (and
  // out of the byte cursor) until its insertion point reaches the viewport top.
  const pendingOlder = useRef<{ id: string; page: Awaited<ReturnType<typeof runtimeService.getPlanningOutput>> } | null>(null);
  const [holdingOlder, setHoldingOlder] = useState(false);
  const commitPendingOlder = useStableCallback((fromScroll = false) => {
    const pending = pendingOlder.current;
    if (!pending || lifetime.current?.aborted || !olderPageFits(sectionRef.current, pending.id)) return false;
    pendingOlder.current = null;
    const latest = segments.current.get(pending.id);
    if (latest && (normalizeTranscriptProjection(latest) !== normalizeTranscriptProjection(pending.page) || latest.start !== pending.page.nextOffset)) {
      return true;
    }
    try {
      markTranscriptPrependIfReading(sectionRef.current);
      const next = latest
        ? prependTranscriptPage(latest, pending.page) : windowFromPage(pending.page, !pending.page.running);
      if (fromScroll) {
        try { flushSync(() => { publish(pending.id, next); setHoldingOlder(false); }); }
        catch { publish(pending.id, next); }
      } else {
        publish(pending.id, next);
      }
    } catch (caught) { failedOlder.current = true; setError(caught instanceof Error ? caught.message : String(caught)); }
    return true;
  });
  useEffect(() => {
    if (!holdingOlder) return;
    if (commitPendingOlder(false)) { setHoldingOlder(false); return; }
    return onTranscriptScroll(sectionRef.current, () => { if (commitPendingOlder(true)) setHoldingOlder(false); });
  }, [holdingOlder, commitPendingOlder]);

  const loadOlder = useStableCallback(async (preserveReading: boolean = true, requestedId?: string, quiet = false,
    readerRequested: boolean = preserveReading) => {
    const signal = lifetime.current;
    if (!ready || !signal || signal.aborted) return false;
    if (olderBusy.current) {
      if (preserveReading) {
        olderRequested.current = true;
        setShowOlderLoading(true);
        markTranscriptPrepend(sectionRef.current);
      }
      return false;
    }
    // A page the reader has not reached yet is already in memory; retry its
    // landing here instead of reading the same bytes again.
    if (pendingOlder.current) {
      if (commitPendingOlder()) setHoldingOlder(false);
      return true;
    }
    // The generic scrollback target completes the newest revision first. A
    // reviewed Run also needs its preceding revision mounted even when the
    // newer review fills the viewport on its own.
    const id = requestedId && planningIds.includes(requestedId)
      ? requestedId : olderTarget(planningIds, segments.current);
    if (!id) return false;
    const before = segments.current.get(id);
    const requestProjection = before ? normalizeTranscriptProjection(before) : targetProjectionFor(id);
    const olderLimit = requestProjection === "summary" ? SUMMARY_OLDER_TRANSCRIPT_BYTES : OLDER_TRANSCRIPT_BYTES;
    const scroller = transcriptScrollParent(sectionRef.current);
    const reservation = scroller ? transcriptAutoFillBudget(scroller).reserve(olderLimit, readerRequested) : null;
    if (scroller && !reservation) return false;
    let receivedBytes = 0;
    olderBusy.current = true; olderRequested.current = preserveReading;
    setLoadingOlder(true); setShowOlderLoading(preserveReading);
    if (!quiet) { failedOlder.current = false; setError(""); }
    if (preserveReading) markTranscriptPrepend(sectionRef.current);
    try {
      const page = await runtimeService.getPlanningOutput(id, "planner", 0, signal, true, before?.start, reservation?.bytes ?? olderLimit, requestProjection ?? false);
      if (signal.aborted) return;
      if (page.planningId !== id || page.role !== "planner") throw new Error(t("执行记录与请求不匹配"));
      const latestAfterAwait = segments.current.get(id);
      const pageProj = normalizeTranscriptProjection(page);
      if (requestProjection === "cards" && pageProj !== "cards") setCardsUnsupported(true);
      // Discard stale older pages if this revision switched projection while awaiting.
      if (latestAfterAwait && (normalizeTranscriptProjection(latestAfterAwait) !== pageProj || (before && latestAfterAwait.start !== before.start))) {
        return true;
      }
      const older = latestAfterAwait ? validateTranscriptPrepend(latestAfterAwait, page) : windowFromPage(page, !page.running);
      receivedBytes = normalizeTranscriptProjection(older) ? utf8Bytes(older.text) : (older.end - older.start);
      // Older bytes extend the history above the reader. Keep them out of the
      // layout until the reader reaches that point, so the page lands where
      // they scrolled to instead of compensating the scroll position under
      // their gesture.
      if (preserveReading && !olderPageFits(sectionRef.current, id)) {
        pendingOlder.current = { id, page };
        setHoldingOlder(true);
        return true;
      }
      if (announcedRef.current) markTranscriptPrependIfReading(sectionRef.current);
      const next = latestAfterAwait ? prependTranscriptPage(latestAfterAwait, page) : windowFromPage(page, !page.running);
      publish(id, next);
    } catch (caught) {
      if (!signal.aborted && (!quiet || olderRequested.current)) {
        failedOlder.current = true;
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      reservation?.finish(receivedBytes);
      olderBusy.current = false; olderRequested.current = false;
      if (!signal.aborted) { setLoadingOlder(false); setShowOlderLoading(false); }
    }
    return true;
  });

  // Prefetch expanded projections for loaded planning revisions during the
  // 260ms collapse→expand animation so switching lands warm with zero jump.
  useEffect(() => {
    if (cardsTransition !== "expanding") return;
    const targets = planningIds.filter(id => {
      const seg = segments.current.get(id);
      if (!seg || normalizeTranscriptProjection(seg) !== "summary") return false;
      const proj: TranscriptProjectionMode | undefined = id !== activeLiveId && !cardsUnsupported ? "cards" : undefined;
      return !planningTranscriptCache.get(planningTranscriptKey(runId, id, proj ?? false))
        && !planningTranscriptCache.get(planningTranscriptKey(runId, id, false));
    });
    if (!targets.length) return;
    const abort = new AbortController();
    const signal = combineAbortSignals(abort.signal, lifetime.current);
    for (const id of targets) {
      const seg = segments.current.get(id)!;
      const proj: TranscriptProjectionMode | undefined = id !== activeLiveId && !cardsUnsupported ? "cards" : undefined;
      const limit = proj === "cards" ? SUMMARY_OLDER_TRANSCRIPT_BYTES : OLDER_TRANSCRIPT_BYTES;
      void runtimeService.getPlanningOutput(id, "planner", 0, signal, true, seg.end, limit, proj ?? false)
        .then(page => {
          if (signal.aborted || page.planningId !== id || page.role !== "planner") return;
          const win = windowFromPage(page, !page.running && id !== activeLiveId);
          const actualProj = normalizeTranscriptProjection(win);
          if (proj === "cards" && actualProj !== "cards") setCardsUnsupported(true);
          planningTranscriptCache.set(planningTranscriptKey(runId, id, actualProj ?? false), cacheTranscriptWindow(win));
        })
        .catch(() => { /* Best-effort transition prefetch. */ });
    }
    return () => abort.abort();
  }, [cardsTransition, key, runId, activeLiveId, cardsUnsupported, lifetime]);

  // Planner turns are separate logs. Without this, opening a reviewed Run
  // whose latest turn fills two viewports would mount only the review and hide
  // every earlier Planner turn until the reader happened to scroll above it.
  // Seed the immediately preceding turn once; its own older bytes still page
  // on demand, and a concurrent automatic fill is allowed to finish first.
  const previousPlanningId = planningIds.length > 1 ? planningIds[planningIds.length - 2] : "";
  const previousAttemptedRef = useRef("");
  useEffect(() => {
    if (!ready || !previousPlanningId || loadingOlder || segments.current.has(previousPlanningId) ||
        previousAttemptedRef.current === previousPlanningId) return;
    previousAttemptedRef.current = previousPlanningId;
    void loadOlder(false, previousPlanningId, true).then(started => {
      // A request already in flight owns the first page. Retry once it lands.
      if (!started) previousAttemptedRef.current = "";
    });
  }, [ready, previousPlanningId, loadingOlder, loadOlder]);

  const loadedBytes = [...segments.current.values()].reduce((sum, window) => sum + window.end - window.start, 0);
  const initialReady = useAutoTranscriptHistory(sectionRef, hasOlder, loadingOlder, error, activeOutput,
    preserveReading => { void loadOlder(preserveReading, undefined, false, false); }, ready, loadedBytes, holdingOlder,
    olderTarget(planningIds, segments.current) ?? undefined);

  useLayoutEffect(() => { notifyOutput(output); }, [key, output, notifyOutput]);
  useLayoutEffect(() => {
    notifyLoading(!initialReady);
    return () => notifyLoading(false);
  }, [initialReady, notifyLoading]);
  // An idle Planner remains history even while graph workers are running.
  // Like execution history, finish the initial fill/measurement before fading
  // it in; revealing the short tail first moves it across the pane mid-fade.
  // Live Planner output must remain immediate, and a stalled older read must
  // not hide already available rows indefinitely.
  useEffect(() => {
    if (running || !ready || initialReady || announcedRef.current) return;
    const timer = setTimeout(() => setRevealFallback(true), TRANSCRIPT_REVEAL_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [running, ready, initialReady]);
  useLayoutEffect(() => {
    if (!ready || announcedKeyRef.current === key) return;
    if (!running && !initialReady && !revealFallback) return;
    announcedRef.current = true;
    announcedKeyRef.current = key;
    notifyReady();
  }, [key, running, ready, initialReady, revealFallback, notifyReady]);

  useEffect(() => {
    const abort = new AbortController();
    const signal = combineAbortSignals(abort.signal, lifetime.current);
    let emptyPages = 0;
    // A terminal page can be empty because the writer had not appended its
    // first (or last) bytes yet. Retry such a revision a bounded number of
    // times instead of caching an empty window forever.
    const emptyRetries = new Map<string, number>();
    // A terminal summary and file EOF can race the writer's final flush even
    // when the first page already contained some output. Recheck the newest
    // freshly-read terminal window twice, then suspend again once it is stable.
    const terminalChecks = new Map<string, number>();
    const staleEmpty = (id: string) => {
      const window = segments.current.get(id);
      return !!window && window.settled && window.end === window.total && !window.text &&
        (emptyRetries.get(id) ?? 0) < 2;
    };
    setError("");
    pendingOlder.current = null;
    setHoldingOlder(false);
    if (!planningIds.length) { setReadKey(key); return () => abort.abort(); }
    const stop = startVisibilityPolling(async () => {
      try {
        const latestId = planningIds.at(-1)!;
        // A summary can be read while it is being replaced, briefly making a
        // live log look terminal. The displayed live revision stays eligible
        // for forward reads until its owning snapshot also settles.
        const liveId = running && livePlanningId && planningIds.includes(livePlanningId)
          ? livePlanningId : running ? latestId : undefined;
        // Start at the newest revision. Revalidate any cached live revisions,
        // but never download missing older revisions just to open a conversation.
        const toRead = [latestId, ...planningIds.filter(id => id !== latestId && segments.current.has(id))];
        for (const planningId of toRead) {
          const existing = segments.current.get(planningId);
          const targetProj = targetProjectionFor(planningId, existing);
          const existingProj = normalizeTranscriptProjection(existing);
          const sameMode = existing !== undefined && (existingProj === targetProj || (targetProj === "cards" && existingProj === undefined));
          if (!sameMode) {
            const targetCached = transcriptFromCache(planningTranscriptCache.get(planningTranscriptKey(runId, planningId, targetProj ?? false)))
              ?? (targetProj === "cards" ? transcriptFromCache(planningTranscriptCache.get(planningTranscriptKey(runId, planningId, false))) : null);
            if (targetCached && (normalizeTranscriptProjection(targetCached) === targetProj || (targetProj === "cards" && normalizeTranscriptProjection(targetCached) === undefined))) {
              publish(planningId, targetCached);
              if (planningId !== liveId && targetCached.settled && targetCached.end === targetCached.total) continue;
            }
          }
          const current = segments.current.get(planningId);
          const currentProj = normalizeTranscriptProjection(current);
          const currentSameMode = current && (currentProj === targetProj || (targetProj === "cards" && currentProj === undefined)) ? current : undefined;
          if (planningId !== liveId && !staleEmpty(planningId) && !(terminalChecks.get(planningId) ?? 0) &&
              currentSameMode?.settled && currentSameMode.end === currentSameMode.total) continue;
          const offset = currentSameMode?.end ?? 0;
          const upgradingFromSummary = !currentSameMode && targetProj !== "summary" && currentProj === "summary";
          const initialLimit = targetProj === "summary"
            ? SUMMARY_INITIAL_TRANSCRIPT_BYTES
            : (upgradingFromSummary
              ? (targetProj === "cards" ? SUMMARY_OLDER_TRANSCRIPT_BYTES : OLDER_TRANSCRIPT_BYTES)
              : INITIAL_TRANSCRIPT_BYTES);
          const page = await runtimeService.getPlanningOutput(planningId, "planner", offset, signal, !currentSameMode, undefined,
            !currentSameMode ? initialLimit : undefined, targetProj ?? false);
          if (signal.aborted) return null;
          if (page.planningId !== planningId || page.role !== "planner" || page.nextOffset < offset ||
              (!page.complete && page.nextOffset === offset)) throw new Error(t("执行记录与请求不匹配"));
          // Older reads may have prepended to this revision while we awaited.
          const latest = segments.current.get(planningId);
          const settled = !page.running && planningId !== liveId;
          const pageProj = normalizeTranscriptProjection(page);
          const canAppend = currentSameMode !== undefined && latest !== undefined && normalizeTranscriptProjection(latest) === pageProj;
          const next = canAppend
            ? appendTranscriptPage(latest, page, settled)
            : windowFromPage(page, settled);
          if (targetProj === "summary" && pageProj !== "summary") setFullRequested(true);
          if (targetProj === "cards" && pageProj !== "cards") setCardsUnsupported(true);
          if (!currentSameMode) {
            const scroller = transcriptScrollParent(sectionRef.current);
            if (scroller) transcriptAutoFillBudget(scroller).charge(normalizeTranscriptProjection(next) ? utf8Bytes(next.text) : (next.end - next.start));
          }
          publish(planningId, next); // Also publish empty terminal pages.
          emptyPages = page.content ? 0 : emptyPages + 1;
          if (planningId === latestId) {
            setReadKey(key);
            if (settled) {
              const remaining = terminalChecks.get(planningId);
              terminalChecks.set(planningId, remaining === undefined || page.content ? 2 : Math.max(0, remaining - 1));
            }
          }
        }
        setReadKey(key);
        const loaded = [...segments.current.values()];
        if (loaded.some(window => window.end < window.total)) return 0;
        if (loaded.some(window => !window.settled)) {
          // Pushes reduce latency, but a missed frame or half-open connection
          // must not leave a visible Planner frozen until it is reopened.
          return isRuntimeEventsConnected() ? RUNTIME_EVENTS_OUTPUT_WATCHDOG_MS : liveOutputDelay(emptyPages);
        }
        const retry = planningIds.filter(staleEmpty);
        if (retry.length || (terminalChecks.get(latestId) ?? 0) > 0) {
          for (const id of retry) emptyRetries.set(id, (emptyRetries.get(id) ?? 0) + 1);
          return liveOutputDelay(emptyPages);
        }
        // Stay suspended rather than settled: the completion notification is the
        // only authority on a log being final, and it must still be able to wake us.
        return Infinity;
      } catch (caught) {
        if (!signal.aborted) { failedOlder.current = false; setError(caught instanceof Error ? caught.message : String(caught)); setReadKey(key); }
        return null;
      }
    });
    let wakeTimer: ReturnType<typeof setTimeout> | undefined;
    // Monotonic, so a wall-clock adjustment cannot postpone a live read.
    let lastWakeAt = -Infinity;
    const unsubscribe = subscribePlanningOutput(event => {
      if (event.runId !== runId || !planningIds.includes(event.planningId)) return;
      // The writer notifies after appending live bytes and again at settlement.
      // A read can race either boundary, so revalidate even a cached EOF.
      const segment = segments.current.get(event.planningId);
      if (segment?.settled) segments.current.set(event.planningId, { ...segment, settled: false });
      if (wakeTimer !== undefined) return;
      const wait = Math.max(0, MIN_LIVE_REREAD_MS - (performance.now() - lastWakeAt));
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined;
        lastWakeAt = performance.now();
        stop.wake();
      }, wait);
    });
    const unsubscribeStatus = subscribeRuntimeEventsStatus(() => stop.wake());
    return () => {
      unsubscribe();
      unsubscribeStatus();
      if (wakeTimer !== undefined) clearTimeout(wakeTimer);
      abort.abort();
      stop();
    };
  }, [key, retry, running, livePlanningId, publish, lifetime, runId, targetProjectionFor]);

  const requestFullTranscript = useCallback(() => setFullRequested(true), []);

  const hydrateItems = useStableCallback((targetItems: readonly TranscriptItem[]) => {
    const signal = lifetime.current;
    if (!signal || signal.aborted) return;
    const byPlanning = new Map<string, { items: TranscriptItem[]; keys: string[] }>();
    for (const item of targetItems) {
      if (!item.bodyOmitted) continue;
      const itemKey = hydrationKeyForItem(item);
      if (!itemKey || isItemHydrated(item, hydratedCardsRef.current.get(itemKey)) || hydratingKeysRef.current.has(itemKey)) continue;
      const planningId = item.source && planningIds.includes(item.source) ? item.source : planningIds.at(-1);
      if (!planningId) continue;
      const group = byPlanning.get(planningId) ?? { items: [], keys: [] };
      group.items.push(item);
      group.keys.push(itemKey);
      byPlanning.set(planningId, group);
    }
    if (!byPlanning.size) return;
    for (const [planningId, group] of byPlanning) {
      const ranges = collectHydrationRanges(group.items);
      if (!ranges.length) {
        setFullRequested(true);
        continue;
      }
      for (const k of group.keys) hydratingKeysRef.current.add(k);
      setHydratingKeys(new Set(hydratingKeysRef.current));
      void runtimeService.hydratePlanningRanges(planningId, "planner", ranges, signal)
        .then(page => {
          if (signal.aborted) return;
          if (page.projection !== "hydrated") {
            setFullRequested(true);
            return;
          }
          const patches = extractHydratedCardPatches(page.content, group.items, planningId);
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
          for (const k of group.keys) hydratingKeysRef.current.delete(k);
          if (!signal.aborted) setHydratingKeys(new Set(hydratingKeysRef.current));
        });
    }
  });

  const projectionTag = hasSummarySegments ? ":summary" : hasProjectedSegments ? ":cards" : "";

  return <section ref={sectionRef} className="planning-activity" aria-label={t("规划活动记录")} aria-busy={!initialReady}>
    {error && <p role="alert">{localizeError(error)} <button type="button" onClick={() => {
      if (failedOlder.current) { setError(""); void loadOlder(); }
      else setRetry(value => value + 1);
    }}>{t("重试")}</button></p>}
    {/* Idle Planner history must not reserve a blank line between the user card
        and the first reply. The line only takes height while its label is shown,
        and stays put through brief gaps between paging requests. */}
    <TranscriptHistoryStatus loading={loadingOlder && showOlderLoading} reserve={false} />
    {ready && !error && !output && <p>{t("没有可用的规划输出。")}</p>}
    {output && <div className="planning-activity-output">
      <VirtualizedTranscript key={runId} parseCacheKey={`${runId}:planning${projectionTag}`} output={activeOutput} inline sourceOrder={planningIds}
        onReachTop={hasOlder && !error ? () => {
          // Before reveal, virtual-row measurements can clamp the scroller up.
          // That is not a history request; only the bounded auto-fill owns reads
          // until the caller can establish its initial position.
          if (announcedRef.current) void loadOlder();
        } : undefined}
        showUserTurns={showUserTurns} skipFirstUser={skipInitialUser} onUserResize={onUserResize}
        settled={!running}
        liveSource={running ? livePlanningId : undefined}
        dividerSources={dividerSources}
        sourceUserFallbacks={showUserTurns ? sourceUserFallbacks : undefined}
        rowHeights={rowHeights}
        restoreAnchor={restoreAnchor}
        onRestoreScroll={onRestoreScroll}
        onCompactingChange={onCompactingChange}
        cardsCollapsed={cardsCollapsed}
        cardsTransition={cardsTransition}
        onExpandSummary={hasProjectedSegments ? requestFullTranscript : undefined}
        hydratedCards={hydratedCards}
        hydratingKeys={hydratingKeys}
        onHydrateItems={hasProjectedSegments ? hydrateItems : undefined}
        onEditUser={onEditUser ? editUser : undefined} />
    </div>}
  </section>;
}
