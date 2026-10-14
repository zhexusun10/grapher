import { useLayoutEffect } from "react";
import { invalidateTranscriptCaches } from "../services/transcriptCache";

/** Planner history survives Node navigation, but never leaving its Conversation. */
export function useConversationTranscriptCache(runId: string) {
  useLayoutEffect(() => {
    if (!runId) return;
    return () => invalidateTranscriptCaches(runId);
  }, [runId]);
}
