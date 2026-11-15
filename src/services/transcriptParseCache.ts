import { BoundedLruCache, utf8Bytes } from "../lib/BoundedLruCache";
import type { TranscriptItem } from "../types";
import type { ParseTranscriptChunkState, TranscriptParseOptions } from "./transcriptParser";

export interface CachedTranscriptParse {
  text: string;
  startOffset: number;
  parsedChars: number;
  state: ParseTranscriptChunkState;
  items: TranscriptItem[];
}
interface Entry extends CachedTranscriptParse {
  owner: string;
  options: string;
  bytes: number;
}

// Conservative accounting includes UTF-16/raw/decoded strings and row/Set
// overhead. This is an additional bounded cache, not authoritative log storage.
export const transcriptParseCache = new BoundedLruCache<string, Entry>(entry => entry.bytes, 20, 30 * 1024 * 1024);
const leases = new Set<{ owner: string; valid: boolean }>();
const keyFor = (owner: string, source: string) => JSON.stringify([owner, source]);
const optionsFor = (options: TranscriptParseOptions) => JSON.stringify([
  options.showUserTurns, options.skipFirstUser, options.userTurnTexts ?? null,
]);

export function readTranscriptParse(
  owner: string | undefined, source: string, text: string, startOffset: number, options: TranscriptParseOptions,
): CachedTranscriptParse | undefined {
  if (!owner) return;
  const key = keyFor(owner, source);
  const entry = transcriptParseCache.get(key);
  // Exact content and cursor checks also reject rewrites/truncation at the
  // same length. Matching IDs alone never validate a parsed transcript.
  if (!entry || entry.text !== text || entry.startOffset !== startOffset || entry.options !== optionsFor(options)) return;
  try {
    return structuredClone({ text: entry.text, startOffset: entry.startOffset, parsedChars: entry.parsedChars,
      state: entry.state, items: entry.items });
  } catch {
    // Derived cache failure is a miss, never a conversation-rendering failure.
    transcriptParseCache.delete(key);
    return;
  }
}

export function writeTranscriptParse(owner: string, source: string, value: CachedTranscriptParse, options: TranscriptParseOptions): void {
  if (!value.text) return;
  const overhead = value.items.length * 512 + value.state.userMessageStarts.size * 128;
  // Reject huge windows before even scanning their strings during navigation.
  if (value.text.length * 4 + overhead > transcriptParseCache.maxBytes) return;
  const bytes = utf8Bytes(value.text) * 4 + overhead;
  if (bytes > transcriptParseCache.maxBytes) return;
  const { source: endSource, byteOffset, leadingFragment, inTagThinking, inFinalResponse, finalResponseSuppressed,
    seenFirstUser, pendingUserStart, assistantStartIndex, userMessageStarts, compacting } = value.state;
  try {
    // Neither cached rows nor parser Sets may be mutated by a mounted reader.
    // Appearance/expansion are view state and must be recomputed on a cold mount.
    const copy = structuredClone({
      state: { source: endSource, byteOffset, leadingFragment, inTagThinking, inFinalResponse, finalResponseSuppressed,
        seenFirstUser, pendingUserStart, assistantStartIndex, userMessageStarts, compacting },
      items: value.items.map(({ animateAppear: _animate, defaultExpanded: _expanded, ...item }) => item),
    });
    transcriptParseCache.set(keyFor(owner, source), { ...value, ...copy, owner, options: optionsFor(options), bytes });
  } catch { /* A best-effort cache must never prevent leaving a conversation. */ }
}

export function leaseTranscriptParseCache(owner: string) {
  // Returning before an idle copy runs supersedes the previous reader. Its
  // stale callback must not replace the newer reader's cached window.
  for (const previous of leases) if (previous.owner === owner) previous.valid = false;
  const lease = { owner, valid: true };
  leases.add(lease);
  return { current: () => lease.valid, release: () => { lease.valid = false; leases.delete(lease); } };
}

/** Leave the next view free to paint before copying terminal parser state.
 * Keep the lease registered until the deferred write finishes: deletion in the
 * meantime must still be able to invalidate it. */
export function finishTranscriptParseCacheLease(lease: ReturnType<typeof leaseTranscriptParseCache>, write: () => void): void {
  if (!lease.current()) { lease.release(); return; }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    try { if (lease.current()) write(); }
    catch { /* Optional copying must not escape through an asynchronous callback. */ }
    finally { lease.release(); }
  };
  if (typeof requestIdleCallback !== "undefined") {
    try { requestIdleCallback(finish, { timeout: 500 }); return; }
    catch { /* A broken/restricted idle scheduler can still use the timer fallback. */ }
  }
  try { setTimeout(finish, 0); }
  catch { lease.release(); }
}

export function invalidateTranscriptParseCache(runId?: string): void {
  const belongs = (owner: string) => !runId || owner.startsWith(`${runId}:`);
  for (const lease of leases) if (belongs(lease.owner)) lease.valid = false;
  for (const [key, entry] of transcriptParseCache) if (belongs(entry.owner)) transcriptParseCache.delete(key);
}
