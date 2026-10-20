import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { RuntimeActivity, Snapshot } from "../types";
import { runtimeService } from "../services/runtime";
import { startVisibilityPolling } from "../services/visibilityPolling";
import { isRuntimeEventsConnected, RUNTIME_EVENTS_WATCHDOG_MS, subscribeRuntimeEventsStatus, subscribeSnapshotChanges } from "../services/runtimeEvents";
import { mapWithConcurrency } from "../services/boundedRequests";

const livePhases = new Set(["planning", "running", "awaiting_approval", "publishing", "merging", "paused", "needs_attention"]);
const workingPhases = new Set(["planning", "running", "publishing", "merging"]);

/** Poll all indexed workspaces, but publish only the selected conversation. */
export function useSnapshotPolling(
  setSnapshot: Dispatch<SetStateAction<Snapshot>>,
  observeSnapshot: (snapshot: Snapshot) => void,
  observeActivity: (runId: string, activity: RuntimeActivity[]) => void,
  runIds: string[], viewedRunId: string, viewedPhase: string, viewedHasActiveExecutions = false,
  /** The Run whose live Planner SSE stream owns the displayed draft graph.
   * Durable polls for it must not clobber the in-flight topology. */
  heldRunId = "",
  /** Bootstrap is the first authoritative read. Polling earlier only adds
   * requests that contend with it for the primary runtime lock. */
  enabled = true,
) {
  const versions = useRef(new Map<string, string>());
  const notifiedVersions = useRef(new Map<string, string>());
  const dirtyRuns = useRef(new Set<string>());
  const phases = useRef(new Map<string, string>());
  const revisions = useRef(new Map<string, number>());
  const activeRuns = useRef(new Set<string>());
  // Standalone publication-Merger continuations leave the Run phase completed.
  // Their durable execution status, not the phase alone, keeps polling alive.
  const writerRuns = useRef(new Set<string>());
  // Keep the latest held Run without resubscribing the poll effect mid-planning.
  const heldRunIdRef = useRef(heldRunId);
  heldRunIdRef.current = heldRunId;
  const setBackendStatus = useCallback((status: { runId: string | null; phase: string | null } & Partial<Pick<Snapshot, "executions" | "mergers" | "nodes">> & { hasActiveExecutions?: boolean }) => {
    if (!status.runId || !status.phase) return;
    phases.current.set(status.runId, status.phase);
    const hasRunningWork = status.hasActiveExecutions ?? (
      [...(status.executions ?? []), ...(status.mergers ?? [])].some(item => item.status === "running") ||
      Object.values(status.nodes ?? {}).some(item => item.status === "running" || item.status === "dirty"));
    if (hasRunningWork) writerRuns.current.add(status.runId);
    else writerRuns.current.delete(status.runId);
    versions.current.delete(status.runId);
    notifiedVersions.current.delete(status.runId);
    // Actions supersede polls already in flight, even at the same event sequence.
    revisions.current.set(status.runId, (revisions.current.get(status.runId) ?? 0) + 1);
  }, []);
  if (viewedRunId) {
    phases.current.set(viewedRunId, viewedPhase);
    if (viewedHasActiveExecutions) writerRuns.current.add(viewedRunId);
    else writerRuns.current.delete(viewedRunId);
  }

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const abort = new AbortController();
    const ids = [...new Set([viewedRunId, ...runIds].filter(id => !!id && !id.startsWith("pending-")))];
    const retained = new Set(ids);
    for (const id of phases.current.keys()) {
      if (retained.has(id)) continue;
      phases.current.delete(id); versions.current.delete(id); revisions.current.delete(id);
      notifiedVersions.current.delete(id); dirtyRuns.current.delete(id);
      activeRuns.current.delete(id); writerRuns.current.delete(id);
    }
    if (!ids.length && !viewedRunId) ids.push("");
    const fallbackDelay = () => activeRuns.current.size > 0 || writerRuns.current.size > 0 || ids.some(id => workingPhases.has(phases.current.get(id) ?? "")) || (viewedRunId && (phases.current.get(viewedRunId) === "needs_attention" || viewedHasActiveExecutions)) ? 750 : 2500;
    const nextDelay = () => {
      if (dirtyRuns.current.size > 0) return 150;
      // Pushes are an accelerator, not the authority. Re-read durable state on a
      // bounded cadence so one missed notification cannot freeze the view.
      if (isRuntimeEventsConnected()) return RUNTIME_EVENTS_WATCHDOG_MS;
      return fallbackDelay();
    };
    const watchdogIds = () => ids.filter(id => !phases.current.has(id) || id === viewedRunId || activeRuns.current.has(id) ||
      writerRuns.current.has(id) || workingPhases.has(phases.current.get(id) ?? ""));
    const poll = async () => {
      // Pushes carry the changed Run; the watchdog only re-reads Runs that can
      // still move, so a missed notification cannot freeze the watched view.
      // The watched Run is always included so a retried background Run cannot
      // starve it while that Run's mutex stays busy.
      const connected = isRuntimeEventsConnected();
      const targetIds = dirtyRuns.current.size > 0 || connected
        ? [...new Set([...dirtyRuns.current, ...(connected ? watchdogIds() : [])])]
        : ids;
      dirtyRuns.current.clear();
      // A slow/unavailable background Run cannot serialize the foreground request.
      await mapWithConcurrency(targetIds, 4, async id => {
        if (cancelled) return;
        const phase = phases.current.get(id);
        const isViewed = id === viewedRunId;
        if (!isViewed && phase && !livePhases.has(phase) && !writerRuns.current.has(id) && !activeRuns.current.has(id) && !notifiedVersions.current.has(id)) return;
        const revision = revisions.current.get(id) ?? 0;
        try {
          const { version, snapshot, activity, busy } = await runtimeService.snapshotIfChanged(versions.current.get(id) ?? null, abort.signal, id || undefined);
          if (cancelled || revision !== (revisions.current.get(id) ?? 0)) return;
          // The Run mutex was busy, so this response says nothing about state:
          // retry at the dirty cadence instead of waiting for another event.
          if (busy) dirtyRuns.current.add(id);
          if (snapshot && id && snapshot.runId !== id) return;
          const held = !!heldRunIdRef.current &&
            (id === heldRunIdRef.current || snapshot?.runId === heldRunIdRef.current);
          if (held) {
            // A live Planner stream is assembling this Run's draft topology.
            // Apply the durable poll without clobbering the draft graph, and
            // forget the stored version so the committed snapshot re-delivers
            // once the stream ends (success, failure or detach).
            versions.current.delete(id);
            if (!snapshot?.runId) return;
            phases.current.set(snapshot.runId, snapshot.phase);
            const hasRunningWork = [...snapshot.executions, ...(snapshot.mergers ?? [])].some(item => item.status === "running") ||
              Object.values(snapshot.nodes ?? {}).some(item => item.status === "running" || item.status === "dirty");
            if (hasRunningWork) writerRuns.current.add(snapshot.runId);
            else writerRuns.current.delete(snapshot.runId);
            observeActivity(snapshot.runId, activity ?? []);
            observeSnapshot(snapshot);
            setSnapshot(previous => previous.runId === snapshot.runId &&
              (snapshot.events.at(-1)?.sequence ?? 0) >= (previous.events.at(-1)?.sequence ?? 0)
              ? {
                ...snapshot,
                // The live draft graph/plan owns the display until the backend
                // atomically commits the revision or planning completes.
                graph: {
                  ...previous.graph,
                  originalGoal: previous.graph.originalGoal || snapshot.graph.originalGoal,
                },
                // null deliberately invalidates an older committed plan after
                // a draft edit; do not restore its obsolete execution batches.
                plan: previous.plan,
              }
              : previous);
            return;
          }
          versions.current.set(id, version);
          const targetVersion = notifiedVersions.current.get(id);
          if (targetVersion && targetVersion !== version) {
            // The Run mutex was busy during try_lock(); retry shortly.
            dirtyRuns.current.add(id);
          } else {
            notifiedVersions.current.delete(id);
          }
          if (activity?.length) activeRuns.current.add(id);
          else activeRuns.current.delete(id);
          observeActivity(snapshot?.runId ?? id, activity ?? []);
          if (!snapshot?.runId) return;
          phases.current.set(snapshot.runId, snapshot.phase);
          const hasRunningWork = [...snapshot.executions, ...(snapshot.mergers ?? [])].some(item => item.status === "running") ||
            Object.values(snapshot.nodes ?? {}).some(item => item.status === "running" || item.status === "dirty");
          if (hasRunningWork) writerRuns.current.add(snapshot.runId);
          else writerRuns.current.delete(snapshot.runId);
          observeSnapshot(snapshot);
          setSnapshot(previous => previous.runId === snapshot.runId &&
            (snapshot.events.at(-1)?.sequence ?? 0) >= (previous.events.at(-1)?.sequence ?? 0) ? snapshot : previous);
        } catch (error) {
          if (!cancelled) console.warn("Snapshot poll error:", id, error);
        }
      });
      return cancelled ? null : nextDelay();
    };
    const stopPolling = startVisibilityPolling(poll, nextDelay());
    const unsubscribeSnapshot = subscribeSnapshotChanges(event => {
      const targetId = event.runId || (ids.includes("") ? "" : viewedRunId);
      if (targetId && !retained.has(targetId) && targetId !== viewedRunId) return;
      if (event.version && versions.current.get(targetId) === event.version && targetId !== heldRunIdRef.current) {
        return;
      }
      if (event.version) {
        notifiedVersions.current.set(targetId, event.version);
      }
      dirtyRuns.current.add(targetId);
      stopPolling.wake();
    });
    const unsubscribeConnect = subscribeRuntimeEventsStatus(status => {
      // A fallen push channel must hand suspended pollers back to timer polling;
      // a (re)connected channel re-reads everything it may have missed.
      const reconnected = status.connected && status.reconnected;
      const hasActive = activeRuns.current.size > 0 || writerRuns.current.size > 0 ||
        ids.some(id => workingPhases.has(phases.current.get(id) ?? ""));
      if (status.connected && (reconnected || hasActive)) {
        for (const id of ids) {
          if (reconnected || workingPhases.has(phases.current.get(id) ?? "") ||
              writerRuns.current.has(id) || activeRuns.current.has(id) || id === viewedRunId) {
            dirtyRuns.current.add(id);
          }
        }
      }
      stopPolling.wake();
    });
    return () => { cancelled = true; unsubscribeSnapshot(); unsubscribeConnect(); stopPolling(); abort.abort(); };
  }, [observeActivity, observeSnapshot, setSnapshot, runIds, viewedRunId, viewedPhase, viewedHasActiveExecutions, enabled]);
  return setBackendStatus;
}
