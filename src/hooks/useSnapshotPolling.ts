import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Snapshot } from "../types";
import { runtimeService } from "../services/runtime";
import { startVisibilityPolling } from "../services/visibilityPolling";
import { mapWithConcurrency } from "../services/boundedRequests";

const livePhases = new Set(["planning", "running", "awaiting_approval", "publishing", "merging", "paused"]);
const workingPhases = new Set(["planning", "running", "publishing", "merging"]);

/** Poll all indexed workspaces, but publish only the selected conversation. */
export function useSnapshotPolling(
  setSnapshot: Dispatch<SetStateAction<Snapshot>>,
  observeSnapshot: (snapshot: Snapshot) => void,
  runIds: string[], viewedRunId: string, viewedPhase: string,
) {
  const versions = useRef(new Map<string, string>());
  const phases = useRef(new Map<string, string>());
  const revisions = useRef(new Map<string, number>());
  const setBackendStatus = useCallback((status: { runId: string | null; phase: string | null }) => {
    if (!status.runId || !status.phase) return;
    phases.current.set(status.runId, status.phase);
    versions.current.delete(status.runId);
    // Actions supersede polls already in flight, even at the same event sequence.
    revisions.current.set(status.runId, (revisions.current.get(status.runId) ?? 0) + 1);
  }, []);
  if (viewedRunId) phases.current.set(viewedRunId, viewedPhase);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    const ids = [...new Set([viewedRunId, ...runIds].filter(id => !!id && !id.startsWith("pending-")))];
    const retained = new Set(ids);
    for (const id of phases.current.keys()) {
      if (retained.has(id)) continue;
      phases.current.delete(id); versions.current.delete(id); revisions.current.delete(id);
    }
    if (!ids.length && !viewedRunId) ids.push("");
    const delay = () => ids.some(id => workingPhases.has(phases.current.get(id) ?? "")) ? 750 : 2500;
    const poll = async () => {
      // A slow/unavailable background Run cannot serialize the foreground request.
      await mapWithConcurrency(ids, 4, async id => {
        if (cancelled) return;
        const phase = phases.current.get(id);
        if (phase && !livePhases.has(phase)) return;
        const revision = revisions.current.get(id) ?? 0;
        try {
          const { version, snapshot } = await runtimeService.snapshotIfChanged(versions.current.get(id) ?? null, abort.signal, id || undefined);
          if (cancelled || revision !== (revisions.current.get(id) ?? 0)) return;
          if (snapshot && id && snapshot.runId !== id) return;
          versions.current.set(id, version);
          if (!snapshot?.runId) return;
          phases.current.set(snapshot.runId, snapshot.phase);
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
  }, [observeSnapshot, setSnapshot, runIds, viewedRunId, viewedPhase]);
  return setBackendStatus;
}
