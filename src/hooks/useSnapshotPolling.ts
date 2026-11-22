import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { RuntimeActivity, Snapshot } from "../types";
import { RunNotFoundError, runtimeService } from "../services/runtime";
import { startVisibilityPolling } from "../services/visibilityPolling";
import { isRuntimeEventsConnected, RUNTIME_EVENTS_WATCHDOG_MS, subscribeRuntimeEventsStatus, subscribeSettledOutputs, subscribeSnapshotChanges } from "../services/runtimeEvents";
import { mapWithConcurrency } from "../services/boundedRequests";
import { runHasActiveExecutions } from "../lib/runPhase";

const livePhases = new Set(["planning", "running", "awaiting_approval", "publishing", "merging", "launching_result", "paused", "needs_attention"]);
const workingPhases = new Set(["planning", "running", "publishing", "merging", "launching_result"]);

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
  /** Durable Run IDs whose sidebar indicator currently shows live work. They
   * must never fall into the idle 30s background bucket or be skipped. */
  workingRunIds: readonly string[] = [],
) {
  const versions = useRef(new Map<string, string>());
  const notifiedVersions = useRef(new Map<string, string>());
  const dirtyRuns = useRef(new Set<string>());
  // A confirmed deletion outlives effect resubscriptions and stale Run indexes.
  const missingRuns = useRef(new Set<string>());
  const phases = useRef(new Map<string, string>());
  const revisions = useRef(new Map<string, number>());
  const activeRuns = useRef(new Set<string>());
  // Standalone publication-Merger continuations leave the Run phase completed.
  // Their durable execution status, not the phase alone, keeps polling alive.
  const writerRuns = useRef(new Set<string>());
  // Keep the latest held Run without resubscribing the poll effect mid-planning.
  const heldRunIdRef = useRef(heldRunId);
  heldRunIdRef.current = heldRunId;
  const workingRunIdsRef = useRef(new Set<string>());
  workingRunIdsRef.current = new Set(workingRunIds);
  const wakeRunRef = useRef<(id: string) => void>(() => {});
  const setBackendStatus = useCallback((status: { runId: string | null; phase: string | null } & Partial<Pick<Snapshot, "executions" | "mergers" | "nodes" | "resultExecution" | "planning">> & { hasActiveExecutions?: boolean }) => {
    if (!status.runId || !status.phase) return;
    missingRuns.current.delete(status.runId);
    phases.current.set(status.runId, status.phase);
    const hasRunningWork = (status.hasActiveExecutions ?? runHasActiveExecutions(status)) || status.planning?.status === "running";
    if (hasRunningWork) writerRuns.current.add(status.runId);
    else writerRuns.current.delete(status.runId);
    versions.current.delete(status.runId);
    notifiedVersions.current.delete(status.runId);
    // Actions supersede polls already in flight, even at the same event sequence.
    revisions.current.set(status.runId, (revisions.current.get(status.runId) ?? 0) + 1);
    if (hasRunningWork || workingPhases.has(status.phase)) {
      dirtyRuns.current.add(status.runId);
    }
    wakeRunRef.current(status.runId);
  }, []);
  if (viewedRunId && !missingRuns.current.has(viewedRunId)) {
    phases.current.set(viewedRunId, viewedPhase);
    if (viewedHasActiveExecutions) writerRuns.current.add(viewedRunId);
    else writerRuns.current.delete(viewedRunId);
  }

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const abort = new AbortController();
    const pendingInvalidations = new Map<string, number>();
    const ids = [...new Set([viewedRunId, ...runIds].filter(id => !!id && !id.startsWith("pending-")))];
    const retained = new Set(ids);
    for (const id of missingRuns.current) {
      if (!retained.has(id)) missingRuns.current.delete(id);
    }
    for (const id of dirtyRuns.current) {
      if (id && !retained.has(id)) dirtyRuns.current.delete(id);
    }
    for (const id of phases.current.keys()) {
      if (retained.has(id)) continue;
      phases.current.delete(id); versions.current.delete(id); revisions.current.delete(id);
      notifiedVersions.current.delete(id); dirtyRuns.current.delete(id);
      activeRuns.current.delete(id); writerRuns.current.delete(id);
    }
    if (!ids.length && !viewedRunId) ids.push("");
    const inLane = (id: string, foreground: boolean) => (id === viewedRunId) === foreground;
    const nextDelay = (foreground: boolean) => {
      const laneIds = ids.filter(id => inLane(id, foreground) && !missingRuns.current.has(id));
      if (!laneIds.length) return Infinity;
      if (laneIds.some(id => dirtyRuns.current.has(id))) return 50;
      const laneHasActive = laneIds.some(id =>
        (Boolean(id) && !phases.current.has(id)) || activeRuns.current.has(id) || writerRuns.current.has(id) ||
        workingRunIdsRef.current.has(id) || workingPhases.has(phases.current.get(id) ?? "") || (id === viewedRunId &&
          phases.current.get(id) === "needs_attention"));
      // Pushes are an accelerator, not the authority. Re-read durable state on a
      // bounded cadence so one missed notification cannot freeze the view; when
      // a lane is completely idle and SSE is connected, relax the watchdog to
      // avoid unnecessary 2s HTTP pings while keeping active runs snappy.
      if (isRuntimeEventsConnected()) {
        if (laneHasActive) return RUNTIME_EVENTS_WATCHDOG_MS;
        return foreground ? 10_000 : 30_000;
      }
      return laneHasActive ? 750 : 2500;
    };
    const watchdogIds = () => ids.filter(id => !phases.current.has(id) || id === viewedRunId || activeRuns.current.has(id) ||
      writerRuns.current.has(id) || workingRunIdsRef.current.has(id) || workingPhases.has(phases.current.get(id) ?? ""));
    const poll = async (foreground: boolean) => {
      // Each lane owns its cadence and in-flight work. A blocked background
      // batch must not delay the foreground's next watchdog or pushed update.
      const connected = isRuntimeEventsConnected();
      const targetIds = [...new Set([...(connected ? watchdogIds() : ids), ...dirtyRuns.current])]
        .filter(id => inLane(id, foreground) && !missingRuns.current.has(id));
      const requestedDirtyRuns = new Set([...dirtyRuns.current].filter(id => inLane(id, foreground)));
      for (const id of requestedDirtyRuns) {
        pendingInvalidations.set(id, revisions.current.get(id) ?? 0);
      }
      for (const id of requestedDirtyRuns) dirtyRuns.current.delete(id);
      let retryDelay = 0;
      // Reserve one of the four total slots for the independent foreground.
      await mapWithConcurrency(targetIds, foreground ? 1 : 3, async id => {
        if (cancelled) return;
        const phase = phases.current.get(id);
        const isViewed = id === viewedRunId;
        if (!isViewed && phase && !livePhases.has(phase) && !writerRuns.current.has(id) && !activeRuns.current.has(id) &&
            !workingRunIdsRef.current.has(id) && !notifiedVersions.current.has(id) && !requestedDirtyRuns.has(id)) return;
        const revision = revisions.current.get(id) ?? 0;
        const requestedNotificationVersion = notifiedVersions.current.get(id);
        try {
          const { version, snapshot, activity, busy } = await runtimeService.snapshotIfChanged(versions.current.get(id) ?? null, abort.signal, id || undefined);
          if (cancelled || revision !== (revisions.current.get(id) ?? 0)) return;
          // The Run mutex was busy, so this response says nothing about state:
          // retry at the dirty cadence instead of waiting for another event.
          if (busy) dirtyRuns.current.add(id);
          if (snapshot && id && snapshot.runId !== id) throw new Error("Snapshot Run does not match its requested Run");
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
            const hasRunningWork = runHasActiveExecutions(snapshot) || snapshot.planning?.status === "running";
            if (hasRunningWork) writerRuns.current.add(snapshot.runId);
            else writerRuns.current.delete(snapshot.runId);
            observeActivity(snapshot.runId, activity ?? []);
            observeSnapshot(snapshot);
            setSnapshot(previous => revision === (revisions.current.get(id) ?? 0) && previous.runId === snapshot.runId &&
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
          if (!busy) versions.current.set(id, version);
          const targetVersion = notifiedVersions.current.get(id);
          if (!busy && (targetVersion === version || targetVersion === requestedNotificationVersion)) {
            // A non-busy read is authoritative for notifications predating it.
            // Its version may already have advanced beyond the pushed version;
            // waiting for exact equality would retry a superseded version forever.
            notifiedVersions.current.delete(id);
          } else if (targetVersion) {
            // A busy read, or a newer push arriving during this request, still
            // needs another durable read. Version strings are opaque, not ordered.
            dirtyRuns.current.add(id);
          }
          if (activity?.length) activeRuns.current.add(id);
          else activeRuns.current.delete(id);
          observeActivity(snapshot?.runId ?? id, activity ?? []);
          if (!snapshot?.runId) return;
          phases.current.set(snapshot.runId, snapshot.phase);
          const hasRunningWork = runHasActiveExecutions(snapshot) || snapshot.planning?.status === "running";
          if (hasRunningWork) writerRuns.current.add(snapshot.runId);
          else writerRuns.current.delete(snapshot.runId);
          observeSnapshot(snapshot);
          setSnapshot(previous => revision === (revisions.current.get(id) ?? 0) && previous.runId === snapshot.runId &&
            (snapshot.events.at(-1)?.sequence ?? 0) >= (previous.events.at(-1)?.sequence ?? 0) ? snapshot : previous);
        } catch (error) {
          if (!cancelled && revision === (revisions.current.get(id) ?? 0)) {
            // Consuming a push is not acknowledgement of its durable update.
            // Retain it on failure, including for an otherwise settled Run that
            // the connected watchdog would not select again.
            if (error instanceof RunNotFoundError) {
              // Retire every poll source, not just its last push: an active or
              // viewed Run would otherwise still be selected by the watchdog.
              missingRuns.current.add(id);
              phases.current.delete(id);
              versions.current.delete(id);
              activeRuns.current.delete(id);
              writerRuns.current.delete(id);
              notifiedVersions.current.delete(id);
              dirtyRuns.current.delete(id);
            } else if (requestedDirtyRuns.has(id) || notifiedVersions.current.has(id)) {
              dirtyRuns.current.add(id);
              retryDelay = 750;
            }
            console.warn("Snapshot poll error:", id, error);
          }
        } finally {
          pendingInvalidations.delete(id);
        }
      });
      return cancelled ? null : Math.max(retryDelay, nextDelay(foreground));
    };
    const initialDelay = (foreground: boolean) => {
      const laneIds = ids.filter(id => inLane(id, foreground) && !missingRuns.current.has(id));
      if (laneIds.some(id => dirtyRuns.current.has(id))) return 0;
      return nextDelay(foreground);
    };
    const foregroundPolling = startVisibilityPolling(() => poll(true), initialDelay(true));
    const backgroundPolling = startVisibilityPolling(() => poll(false), initialDelay(false));
    const wakeRun = (id: string) => (inLane(id, true) ? foregroundPolling : backgroundPolling).wake();
    wakeRunRef.current = wakeRun;
    const unsubscribeSnapshot = subscribeSnapshotChanges(event => {
      const targetId = event.runId || (ids.includes("") ? "" : viewedRunId);
      if (missingRuns.current.has(targetId)) return;
      if (targetId && !retained.has(targetId) && targetId !== viewedRunId) {
        // Remember an early push for a brand-new Run until its ID lands in runIds.
        if (dirtyRuns.current.size < 64) {
          if (event.version) notifiedVersions.current.set(targetId, event.version);
          dirtyRuns.current.add(targetId);
        }
        return;
      }
      if (event.version && versions.current.get(targetId) === event.version && targetId !== heldRunIdRef.current) {
        return;
      }
      if (event.version) {
        notifiedVersions.current.set(targetId, event.version);
      }
      dirtyRuns.current.add(targetId);
      wakeRun(targetId);
    });
    const unsubscribeSettledOutput = subscribeSettledOutputs(event => {
      const targetId = event.runId;
      if (!targetId || missingRuns.current.has(targetId)) return;
      if (!retained.has(targetId) && targetId !== viewedRunId) {
        if (dirtyRuns.current.size < 64) dirtyRuns.current.add(targetId);
        return;
      }
      dirtyRuns.current.add(targetId);
      wakeRun(targetId);
    });
    const unsubscribeConnect = subscribeRuntimeEventsStatus(status => {
      // A fallen push channel must hand suspended pollers back to timer polling;
      // a (re)connected channel re-reads everything it may have missed.
      const reconnected = status.connected && status.reconnected;
      const hasActive = activeRuns.current.size > 0 || writerRuns.current.size > 0 ||
        workingRunIdsRef.current.size > 0 ||
        ids.some(id => workingPhases.has(phases.current.get(id) ?? ""));
      if (status.connected && (reconnected || hasActive)) {
        for (const id of ids) {
          if (missingRuns.current.has(id)) continue;
          if (reconnected || workingPhases.has(phases.current.get(id) ?? "") ||
              writerRuns.current.has(id) || activeRuns.current.has(id) ||
              workingRunIdsRef.current.has(id) || id === viewedRunId) {
            dirtyRuns.current.add(id);
          }
        }
      }
      foregroundPolling.wake();
      backgroundPolling.wake();
    });
    return () => {
      cancelled = true;
      // A new index/phase restarts this effect. Aborting its request is not an
      // acknowledgement, especially for pushes without a version to retain.
      for (const [id, revision] of pendingInvalidations) {
        if (revision === (revisions.current.get(id) ?? 0) && !missingRuns.current.has(id)) {
          dirtyRuns.current.add(id);
        }
      }
      if (wakeRunRef.current === wakeRun) wakeRunRef.current = () => {};
      unsubscribeSnapshot(); unsubscribeSettledOutput(); unsubscribeConnect(); foregroundPolling(); backgroundPolling(); abort.abort();
    };
  }, [observeActivity, observeSnapshot, setSnapshot, runIds, viewedRunId, enabled]);
  // A phase/writer update changes cadence, not request ownership. Wake the
  // foreground without aborting either lane's requests or resetting its timer.
  useEffect(() => {
    if (enabled) wakeRunRef.current(viewedRunId);
  }, [viewedRunId, viewedPhase, viewedHasActiveExecutions, enabled]);
  return setBackendStatus;
}
