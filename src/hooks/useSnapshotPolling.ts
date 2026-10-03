import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Snapshot } from "../types";
import { runtimeService } from "../services/runtime";

const livePhases = ["planning", "running", "awaiting_approval", "publishing", "merging", "paused"];

/** Poll all indexed workspaces, but publish only the selected conversation. */
export function useSnapshotPolling(
  setSnapshot: Dispatch<SetStateAction<Snapshot>>,
  observeSnapshot: (snapshot: Snapshot) => void,
  runIds: string[],
  viewedRunId: string,
  viewedPhase: string,
) {
  const versions = useRef(new Map<string, string>());
  const phases = useRef(new Map<string, string>());
  const revisions = useRef(new Map<string, number>());
  const setBackendStatus = useCallback((status: { runId: string | null; phase: string | null }) => {
    if (!status.runId || !status.phase) return;
    phases.current.set(status.runId, status.phase);
    versions.current.delete(status.runId);
    // An action response is newer than a poll already in flight, even when
    // neither response changes the last event sequence (e.g. pause/resume).
    revisions.current.set(status.runId, (revisions.current.get(status.runId) ?? 0) + 1);
  }, []);
  if (viewedRunId) phases.current.set(viewedRunId, viewedPhase);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const ids = [...new Set([...runIds, viewedRunId].filter(id => !!id && !id.startsWith("pending-")))];
    const retained = new Set(ids);
    for (const id of phases.current.keys()) {
      if (retained.has(id)) continue;
      phases.current.delete(id);
      versions.current.delete(id);
      revisions.current.delete(id);
    }
    if (!ids.length && !viewedRunId) ids.push("");
    const hasLiveRun = () => ids.some(id => ["planning", "running", "publishing", "merging"].includes(phases.current.get(id) ?? ""));
    const poll = async () => {
      try {
        for (const id of ids) {
          if (cancelled) break;
          const phase = phases.current.get(id);
          if (phase && !livePhases.includes(phase)) continue;
          const revision = revisions.current.get(id) ?? 0;
          try {
            const { version, snapshot } = await runtimeService.snapshotIfChanged(versions.current.get(id) ?? null, abort.signal, id || undefined);
            if (cancelled) break;
            if (revision !== (revisions.current.get(id) ?? 0)) continue;
            if (snapshot && id && snapshot.runId !== id) continue;
            versions.current.set(id, version);
            if (!snapshot?.runId) continue;
            phases.current.set(snapshot.runId, snapshot.phase);
            observeSnapshot(snapshot);
            setSnapshot(prev => prev.runId === snapshot.runId &&
              (snapshot.events.at(-1)?.sequence ?? 0) >= (prev.events.at(-1)?.sequence ?? 0)
              ? snapshot : prev);
          } catch (error) {
            // A deleted/unavailable Run must not starve other conversations.
            if (!cancelled) console.warn("Snapshot poll error:", id, error);
          }
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, hasLiveRun() ? 750 : 2500);
      }
    };
    timer = setTimeout(poll, hasLiveRun() ? 750 : 2500);
    return () => { cancelled = true; clearTimeout(timer); abort.abort(); };
  }, [observeSnapshot, setSnapshot, runIds, viewedRunId, viewedPhase]);

  return setBackendStatus;
}
