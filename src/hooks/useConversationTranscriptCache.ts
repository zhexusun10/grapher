import { useLayoutEffect } from "react";
import { cancelTranscriptReaders } from "../services/transcriptCache";

/** Navigation cancels stale readers, not reusable bounded history windows.
 * Deletion/reset still invalidate both readers and cache entries explicitly. */
export function useConversationTranscriptCache(runId: string) {
  useLayoutEffect(() => {
    if (!runId) return;
    return () => cancelTranscriptReaders(runId);
  }, [runId]);
}
