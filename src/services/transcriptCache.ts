import { BoundedLruCache } from "../lib/BoundedLruCache";

export type CachedTranscript = { text: string; offset: number; complete: boolean; status?: string };
// Offsets are UTF-8 bytes supplied by the backend (or accumulated for Planner
// source markers). Allow one extra byte for the UI's optional trailing newline.
// This conservative bound avoids re-encoding megabytes on every live update.
const transcriptBytes = (entry: CachedTranscript) => entry.offset + (entry.text.endsWith("\n") ? 1 : 0);
export const executionTranscriptCache = new BoundedLruCache<string, CachedTranscript>(transcriptBytes);
export const planningTranscriptCache = new BoundedLruCache<string, CachedTranscript>(transcriptBytes);

export function invalidateTranscriptCaches(runId?: string): void {
  if (runId) {
    for (const key of executionTranscriptCache.keys()) {
      if (key.startsWith(`${runId}:`)) executionTranscriptCache.delete(key);
    }
  } else executionTranscriptCache.clear();
  // Planner keys combine revision IDs, not Run IDs.
  planningTranscriptCache.clear();
}
