import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Snapshot } from "../types";
import { runtimeService } from "../services/runtime";

/** Keep conditional polling and backend activity timing independent of view rendering. */
export function useSnapshotPolling(
  busy: boolean,
  setSnapshot: Dispatch<SetStateAction<Snapshot>>,
  observeSnapshot: (snapshot: Snapshot) => void,
) {
  const backendStatusRef = useRef<{ runId: string | null; phase: string | null }>({ runId: null, phase: null });
  const setBackendStatus = useCallback((status: { runId: string | null; phase: string | null }) => {
    backendStatusRef.current = status;
  }, []);
  const snapshotVersionRef = useRef<string | null>(null);

  useEffect(() => {
    if (busy) return;
    const pollInterval = () => backendStatusRef.current.runId &&
      ["running", "awaiting_approval", "publishing", "merging"].includes(backendStatusRef.current.phase ?? "")
      ? 2500 : 3500;

    let cancelled = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { version, snapshot } = await runtimeService.snapshotIfChanged(snapshotVersionRef.current, abort.signal);
        if (cancelled) return;
        snapshotVersionRef.current = version;
        if (!snapshot) return;
        if (!snapshot.runId) {
          setBackendStatus({ runId: null, phase: null });
          return;
        }
        setBackendStatus({ runId: snapshot.runId, phase: snapshot.phase });
        observeSnapshot(snapshot);
        // A background run should update the sidebar, not replace the viewed run.
        setSnapshot((prev) => prev.runId === snapshot.runId ? snapshot : prev);
      } catch (err) {
        if (!cancelled) console.warn("Snapshot poll error:", err);
      } finally {
        if (!cancelled) timer = setTimeout(poll, pollInterval());
      }
    };
    timer = setTimeout(poll, pollInterval());
    return () => {
      cancelled = true;
      clearTimeout(timer);
      abort.abort();
    };
  }, [busy, observeSnapshot, setSnapshot, setBackendStatus]);

  return setBackendStatus;
}
