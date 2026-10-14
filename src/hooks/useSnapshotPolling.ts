import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { RuntimeActivity, Snapshot } from "../types";
import { runtimeService } from "../services/runtime";
import { startVisibilityPolling } from "../services/visibilityPolling";
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
) {
  const versions = useRef(new Map<string, string>());
  const phases = useRef(new Map<string, string>());
  const revisions = useRef(new Map<string, number>());
  const activeRuns = useRef(new Set<string>());
  // Standalone publication-Merger continuations leave the Run phase completed.
  // Their durable execution status, not the phase alone, keeps polling alive.
  const writerRuns = useRef(new Set<string>());
  // Keep the latest held Run without resubscribing the poll effect mid-planning.
  const heldRunIdRef = useRef(heldRunId);
  heldRunIdRef.current = heldRunId;
  const setBackendStatus = useCallback((status: { runId: string | null; phase: string | null } & Partial<Pick<Snapshot, "executions" | "mergers" | "nodes">>) => {
    if (!status.runId || !status.phase) return;
    phases.current.set(status.runId, status.phase);
    const hasRunningWork = [...(status.executions ?? []), ...(status.mergers ?? [])].some(item => item.status === "running") ||
      Object.values(status.nodes ?? {}).some(item => item.status === "running" || item.status === "dirty");
    if (hasRunningWork) writerRuns.current.add(status.runId);
    else writerRuns.current.delete(status.runId);
    versions.current.delete(status.runId);
    // Actions supersede polls already in flight, even at the same event sequence.
    revisions.current.set(status.runId, (revisions.current.get(status.runId) ?? 0) + 1);
  }, []);
  if (viewedRunId) {
    phases.current.set(viewedRunId, viewedPhase);
    if (viewedHasActiveExecutions) writerRuns.current.add(viewedRunId);
    else writerRuns.current.delete(viewedRunId);
  }

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    const ids = [...new Set([viewedRunId, ...runIds].filter(id => !!id && !id.startsWith("pending-")))];
    const retained = new Set(ids);
    for (const id of phases.current.keys()) {
      if (retained.has(id)) continue;
      phases.current.delete(id); versions.current.delete(id); revisions.current.delete(id);
      activeRuns.current.delete(id); writerRuns.current.delete(id);
    }
    if (!ids.length && !viewedRunId) ids.push("");
    const delay = () => activeRuns.current.size > 0 || writerRuns.current.size > 0 || ids.some(id => workingPhases.has(phases.current.get(id) ?? "")) || (viewedRunId && (phases.current.get(viewedRunId) === "needs_attention" || viewedHasActiveExecutions)) ? 750 : 2500;
    const poll = async () => {
      // A slow/unavailable background Run cannot serialize the foreground request.
      await mapWithConcurrency(ids, 4, async id => {
        if (cancelled) return;
        const phase = phases.current.get(id);
        const isViewed = id === viewedRunId;
        if (!isViewed && phase && !livePhases.has(phase) && !writerRuns.current.has(id) && !activeRuns.current.has(id)) return;
        const revision = revisions.current.get(id) ?? 0;
        try {
          const { version, snapshot, activity } = await runtimeService.snapshotIfChanged(versions.current.get(id) ?? null, abort.signal, id || undefined);
          if (cancelled || revision !== (revisions.current.get(id) ?? 0)) return;
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
                plan: previous.plan ?? snapshot.plan,
              }
              : previous);
            return;
          }
          versions.current.set(id, version);
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
      return cancelled ? null : delay();
    };
    const stopPolling = startVisibilityPolling(poll, delay());
    return () => { cancelled = true; stopPolling(); abort.abort(); };
  }, [observeActivity, observeSnapshot, setSnapshot, runIds, viewedRunId, viewedPhase, viewedHasActiveExecutions]);
  return setBackendStatus;
}
