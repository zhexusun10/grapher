import { useCallback, useState, type SetStateAction } from "react";
import type { Snapshot } from "../types";
import { shareJson } from "../services/structuralSharing";

export function useSnapshotState(initial: Snapshot) {
  const [snapshot, update] = useState(initial);
  const setSnapshot = useCallback((action: SetStateAction<Snapshot>) => {
    update(previous => {
      const incoming = typeof action === "function" ? action(previous) : action;
      // IDs are local to a Run: never share another conversation's projection.
      return previous.runId === incoming.runId ? shareJson(previous, incoming) : incoming;
    });
  }, []);
  return [snapshot, setSnapshot] as const;
}
