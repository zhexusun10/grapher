import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Snapshot } from "../types";
import { runtimeService } from "../services/runtime";

/** Poll each live conversation independently; viewing another Run never stops its updates. */
export function useSnapshotPolling(
  setSnapshot: Dispatch<SetStateAction<Snapshot>>,
  observeSnapshot: (snapshot: Snapshot) => void,
  runIds: string[],
  viewedRunId: string,
  viewedPhase: string,
) {
  const backendStatusRef = useRef<{ runId: string | null; phase: string | null }>({ runId: null, phase: null });
  const setBackendStatus = useCallback((status: { runId: string | null; phase: string | null }) => {
    backendStatusRef.current = status;
  }, []);
  const versions = useRef(new Map<string, string>());
  const phases = useRef(new Map<string, string>());
  const runIdsRef = useRef(runIds);
  runIdsRef.current = runIds;
  if (viewedRunId) phases.current.set(viewedRunId, viewedPhase);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const ids = Array.from(new Set([...runIdsRef.current, backendStatusRef.current.runId].filter((id): id is string => !!id)));
        // Before a Run exists, continue tracking the default backend snapshot.
        if (!ids.length) ids.push("");
        for (const id of ids) {
          if (cancelled) break;
          const phase = phases.current.get(id);
          // Completed histories do not need perpetual polling; a new action
          // returns its updated snapshot directly and re-enables observation.
          if (phase && !["running", "awaiting_approval", "publishing", "merging", "paused"].includes(phase)) continue;
          const { version, snapshot } = await runtimeService.snapshotIfChanged(versions.current.get(id) ?? null, abort.signal, id || undefined);
          if (cancelled) break;
          versions.current.set(id, version);
          if (!snapshot?.runId) continue;
          phases.current.set(id, snapshot.phase);
          setBackendStatus({ runId: snapshot.runId, phase: snapshot.phase });
          observeSnapshot(snapshot);
          setSnapshot((prev) => prev.runId === snapshot.runId &&
            (snapshot.events.at(-1)?.sequence ?? 0) >= (prev.events.at(-1)?.sequence ?? 0)
            ? snapshot : prev);
        }
      } catch (err) {
        if (!cancelled) console.warn("Snapshot poll error:", err);
      } finally {
        if (!cancelled) timer = setTimeout(poll, 2500);
      }
    };
    timer = setTimeout(poll, 2500);
    return () => { cancelled = true; clearTimeout(timer); abort.abort(); };
  }, [observeSnapshot, setSnapshot]);

  return setBackendStatus;
}
