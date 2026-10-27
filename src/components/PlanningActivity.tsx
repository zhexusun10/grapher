import { t, localizeError } from "../i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, memo, useMemo } from "react";
import { runtimeService } from "../services/runtime";
import { subscribePlanningOutput } from "../services/runtimeEvents";
import { liveOutputDelay, startVisibilityPolling } from "../services/visibilityPolling";
import { useStableCallback } from "../hooks/useStableCallback";
import { useTranscriptReader } from "../hooks/useTranscriptReader";
import { useAutoTranscriptHistory } from "../hooks/useAutoTranscriptHistory";
import { VirtualizedTranscript } from "./VirtualizedTranscript";
import { cacheTranscriptWindow, composePlanningOutput, planningTranscriptCache, planningTranscriptKey, transcriptFromCache } from "../services/transcriptCache";
import { activePlannerOutput } from "../lib/plannerOutput";
import { appendTranscriptPage, prependTranscriptPage, windowFromPage, type TranscriptWindow } from "../services/transcriptWindow";
import { markTranscriptPrepend } from "../services/transcriptScroll";
import { INITIAL_TRANSCRIPT_BYTES, OLDER_TRANSCRIPT_BYTES } from "../services/transcriptPaging";
import { TranscriptHistoryStatus } from "./TranscriptHistoryStatus";
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
  onCompactingChange?: (compacting: boolean) => void;
};

/** Read backward through the contiguous loaded suffix, one revision/page at a time. */
function olderTarget(ids: string[], segments: ReadonlyMap<string, TranscriptWindow>): string | null {
  for (let index = ids.length - 1; index >= 0; index--) {
    const window = segments.get(ids[index]);
    if (!window || window.start > 0) return ids[index];
  }
  return null;
}

export const PlanningActivity = memo(function PlanningActivity(props: Props) {
  return <PlanningHistory key={`${props.runId ?? ""}:${props.planningIds.join(":")}`} {...props} />;
});

function PlanningHistory({ runId = "", planningIds, onReady, onOutputChange, onLoadingChange, showUserTurns = false,
  skipFirstUser = false, onUserResize, onEditUser, edits = [], running = false, livePlanningId, onCompactingChange }: Props) {
  const key = planningIds.join(":");
  const [initialSegments] = useState(() => {
    const loaded = new Map<string, TranscriptWindow>();
    for (const id of planningIds) {
      const window = transcriptFromCache(planningTranscriptCache.get(planningTranscriptKey(runId, id)));
      if (window) loaded.set(id, window);
    }
    return loaded;
  });
  const segments = useRef(initialSegments);
  const [output, setOutput] = useState(() => composePlanningOutput(planningIds, initialSegments));
  const [ready, setReady] = useState(!planningIds.length || initialSegments.has(planningIds.at(-1)!));
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderBusy = useRef(false);
  const announcedRef = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const lifetime = useTranscriptReader("planning", `${runId}:view:${key}`);
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

  const publish = useCallback((planningId: string, window: TranscriptWindow) => {
    segments.current.set(planningId, window);
    planningTranscriptCache.set(planningTranscriptKey(runId, planningId), cacheTranscriptWindow(window));
    setOutput(composePlanningOutput(planningIds, segments.current));
  }, [runId, key]);

  const loadOlder = useStableCallback(async (preserveReading = true) => {
    const signal = lifetime.current;
    const id = olderTarget(planningIds, segments.current);
    if (!ready || !id || olderBusy.current || !signal || signal.aborted) return;
    const before = segments.current.get(id);
    olderBusy.current = true; setLoadingOlder(true); setError("");
    if (preserveReading) markTranscriptPrepend(sectionRef.current);
    try {
      const page = await runtimeService.getPlanningOutput(id, "planner", 0, signal, true, before?.start, OLDER_TRANSCRIPT_BYTES);
      if (signal.aborted) return;
      if (page.planningId !== id || page.role !== "planner") throw new Error(t("执行记录与请求不匹配"));
      const latest = segments.current.get(id);
      const next = latest ? prependTranscriptPage(latest, page) : windowFromPage(page, !page.running);
      publish(id, next);
    } catch (caught) { if (!signal.aborted) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { olderBusy.current = false; if (!signal.aborted) setLoadingOlder(false); }
  });

  const loadedBytes = [...segments.current.values()].reduce((sum, window) => sum + window.end - window.start, 0);
  const initialReady = useAutoTranscriptHistory(sectionRef, hasOlder, loadingOlder, error, activeOutput,
    preserveReading => { void loadOlder(preserveReading); }, ready, loadedBytes);

  useLayoutEffect(() => { notifyOutput(output); }, [output, notifyOutput]);
  useLayoutEffect(() => {
    notifyLoading(!initialReady);
    return () => notifyLoading(false);
  }, [initialReady, notifyLoading]);
  // Reveal on the newest revision's first page. The viewport auto-fill keeps
  // running behind the painted overview instead of gating the reveal on it.
  useLayoutEffect(() => {
    if (ready && !announcedRef.current) {
      announcedRef.current = true;
      notifyReady();
    }
  }, [ready, notifyReady]);

  useEffect(() => {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, lifetime.current!]);
    let emptyPages = 0;
    // A terminal page can be empty because the writer had not appended its
    // first (or last) bytes yet. Retry such a revision a bounded number of
    // times instead of caching an empty window forever.
    const emptyRetries = new Map<string, number>();
    const staleEmpty = (id: string) => {
      const window = segments.current.get(id);
      return !!window && window.settled && window.end === window.total && !window.text &&
        (emptyRetries.get(id) ?? 0) < 2;
    };
    setError("");
    if (!planningIds.length) { setReady(true); return () => abort.abort(); }
    const stop = startVisibilityPolling(async () => {
      try {
        const latestId = planningIds.at(-1)!;
        // Start at the newest revision. Revalidate any cached live revisions,
        // but never download missing older revisions just to open a conversation.
        const toRead = [latestId, ...planningIds.filter(id => id !== latestId && segments.current.has(id))];
        for (const planningId of toRead) {
          const current = segments.current.get(planningId);
          if (!staleEmpty(planningId) && current?.settled && current.end === current.total) continue;
          const offset = current?.end ?? 0;
          const page = await runtimeService.getPlanningOutput(planningId, "planner", offset, signal, !current, undefined,
            !current ? INITIAL_TRANSCRIPT_BYTES : undefined);
          if (signal.aborted) return null;
          if (page.planningId !== planningId || page.role !== "planner" || page.nextOffset < offset ||
              (!page.complete && page.nextOffset === offset)) throw new Error(t("执行记录与请求不匹配"));
          // Older reads may have prepended to this revision while we awaited.
          const latest = segments.current.get(planningId);
          const next = latest
            ? appendTranscriptPage(latest, { ...page, startOffset: page.startOffset ?? offset }, !page.running)
            : windowFromPage(page, !page.running);
          publish(planningId, next); // Also publish empty terminal pages.
          emptyPages = page.content ? 0 : emptyPages + 1;
          if (planningId === latestId) setReady(true);
        }
        setReady(true);
        const loaded = [...segments.current.values()];
        if (loaded.some(window => window.end < window.total)) return 0;
        if (loaded.some(window => !window.settled)) return liveOutputDelay(emptyPages);
        const retry = planningIds.filter(staleEmpty);
        if (retry.length) {
          for (const id of retry) emptyRetries.set(id, (emptyRetries.get(id) ?? 0) + 1);
          return liveOutputDelay(emptyPages);
        }
        // Stay suspended rather than settled: the completion notification is the
        // only authority on a log being final, and it must still be able to wake us.
        return Infinity;
      } catch (caught) {
        if (!signal.aborted) { setError(caught instanceof Error ? caught.message : String(caught)); setReady(true); }
        return null;
      }
    });
    const unsubscribe = subscribePlanningOutput(event => {
      if (event.runId !== runId || !planningIds.includes(event.planningId)) return;
      // The backend publishes this once a turn's log is final. An earlier read
      // may have settled at a stale EOF, so re-read that revision from its
      // cursor instead of trusting the cached window.
      const segment = segments.current.get(event.planningId);
      if (segment?.settled) segments.current.set(event.planningId, { ...segment, settled: false });
      stop.wake();
    });
    return () => { unsubscribe(); abort.abort(); stop(); };
  }, [key, retry, running, publish, lifetime]);

  return <section ref={sectionRef} className="planning-activity" aria-label={t("规划活动记录")} aria-busy={!initialReady}>
    {error && <p role="alert">{localizeError(error)} <button type="button" onClick={() => setRetry(value => value + 1)}>{t("重试")}</button></p>}
    {/* Idle Planner history must not reserve a blank line between the user card
        and the first reply. The line only takes height while its label is shown,
        and stays put through brief gaps between paging requests. */}
    <TranscriptHistoryStatus loading={loadingOlder} reserve={false} />
    {ready && !error && !output && <p>{t("没有可用的规划输出。")}</p>}
    {output && <div className="planning-activity-output">
      <VirtualizedTranscript output={activeOutput} inline
        onReachTop={hasOlder && !error ? () => { void loadOlder(); } : undefined}
        showUserTurns={showUserTurns} skipFirstUser={skipInitialUser} onUserResize={onUserResize}
        settled={!running}
        liveSource={running ? livePlanningId : undefined}
        onCompactingChange={onCompactingChange}
        onEditUser={onEditUser ? editUser : undefined} />
    </div>}
  </section>;
}
