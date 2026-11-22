import { BoundedLruCache, utf8Bytes } from "../lib/BoundedLruCache";
import { normalizeTranscriptProjection, renderTranscriptWindow, type TranscriptProjectionMode, type TranscriptWindow } from "./transcriptWindow";
import { invalidateTranscriptParseCache } from "./transcriptParseCache";
import { invalidateFileChangeSummaryCache } from "./fileChanges";

export type CachedTranscript = {
  text: string;
  offset: number;
  startOffset?: number;
  totalBytes?: number;
  /** Complete means all bytes of a terminal log, not merely its current EOF. */
  complete: boolean;
  status?: string;
  summaryOnly?: boolean;
  projection?: TranscriptProjectionMode;
  steerOffsets?: Record<string, number>;
  steerOffsetsAuthoritative?: boolean;
};
// Validated contiguous windows already carry their retained UTF-8 byte count.
// Projected windows (`summary` / `cards`) carry far less text than their raw
// byte span, so charge their actual string size instead of raw offsets.
const transcriptBytes = (entry: CachedTranscript) => (entry.summaryOnly || entry.projection)
  ? utf8Bytes(entry.text)
  : (entry.startOffset !== undefined && entry.offset >= entry.startOffset
    ? entry.offset - entry.startOffset : utf8Bytes(entry.text));
export const executionTranscriptCache = new BoundedLruCache<string, CachedTranscript>(transcriptBytes);
// Each revision is independently reusable, including when the revision list grows.
export const planningTranscriptCache = new BoundedLruCache<string, CachedTranscript>(transcriptBytes);
export const planningTranscriptKey = (runId: string, planningId: string, mode: boolean | TranscriptProjectionMode = false) =>
  mode === true || mode === "summary" ? `${runId}:${planningId}:summary`
    : mode === "cards" ? `${runId}:${planningId}:cards`
    : `${runId}:${planningId}`;

export function executionTranscriptKey(baseKey: string, projection?: TranscriptProjectionMode): string {
  return projection ? `${baseKey}:${projection}` : baseKey;
}

export function transcriptFromCache(entry: CachedTranscript | undefined): TranscriptWindow | null {
  if (!entry) return null;
  const projection = normalizeTranscriptProjection(entry);
  return {
    text: entry.text,
    start: entry.startOffset ?? 0,
    end: entry.offset,
    total: entry.totalBytes ?? entry.offset,
    settled: entry.complete || (!!entry.status && entry.status !== "running"),
    ...(projection === "summary" ? { summaryOnly: true } : {}),
    ...(projection ? { projection } : {}),
    ...(entry.steerOffsets !== undefined ? { steerOffsets: entry.steerOffsets } : {}),
    ...(entry.steerOffsetsAuthoritative !== undefined ? { steerOffsetsAuthoritative: entry.steerOffsetsAuthoritative } : {}),
  };
}

export function cacheTranscriptWindow(window: TranscriptWindow): CachedTranscript {
  const projection = normalizeTranscriptProjection(window);
  return {
    text: window.text,
    offset: window.end,
    startOffset: window.start,
    totalBytes: window.total,
    complete: window.start === 0 && window.end === window.total && window.settled,
    status: window.settled ? "completed" : "running",
    ...(projection === "summary" ? { summaryOnly: true } : {}),
    ...(projection ? { projection } : {}),
    ...(window.steerOffsets !== undefined ? { steerOffsets: window.steerOffsets } : {}),
    ...(window.steerOffsetsAuthoritative !== undefined ? { steerOffsetsAuthoritative: window.steerOffsetsAuthoritative } : {}),
  };
}

export function composePlanningOutput(ids: string[], segments: ReadonlyMap<string, TranscriptWindow>): string {
  return ids.flatMap(planningId => {
    const window = segments.get(planningId);
    if (!window) return [];
    const marker = JSON.stringify({ type: "grapher_planning_source", planningId, startOffset: window.start });
    return [`${marker}\n${renderTranscriptWindow(window)}`];
  }).join("\n");
}

export function cachedPlanningOutput(runId: string, ids: string[]): string {
  const segments = new Map<string, TranscriptWindow>();
  for (const id of ids) {
    const window = transcriptFromCache(planningTranscriptCache.get(planningTranscriptKey(runId, id)));
    if (window) segments.set(id, window);
  }
  return composePlanningOutput(ids, segments);
}

type CacheKind = "execution" | "planning";
const readers = new Set<{ kind: CacheKind; key: string; controller: AbortController }>();

/** Readers are view-owned; bounded, validated byte windows may outlive a view. */
export function registerTranscriptReader(kind: CacheKind, key: string, controller: AbortController): () => void {
  const reader = { kind, key, controller };
  readers.add(reader);
  return () => { controller.abort(); readers.delete(reader); };
}

export function cancelTranscriptReaders(runId?: string): void {
  for (const reader of readers) {
    if (!runId || reader.key.startsWith(`${runId}:`)) reader.controller.abort();
  }
}

function clearCache(kind: CacheKind, runId?: string): void {
  const cache = kind === "execution" ? executionTranscriptCache : planningTranscriptCache;
  const belongs = (key: string) => !runId || key.startsWith(`${runId}:`);
  for (const reader of readers) {
    if (reader.kind === kind && belongs(reader.key)) reader.controller.abort();
  }
  for (const key of cache.keys()) if (belongs(key)) cache.delete(key);
}

export function invalidateTranscriptCaches(runId?: string): void {
  invalidateTranscriptParseCache(runId);
  invalidateFileChangeSummaryCache(runId);
  clearCache("execution", runId);
  clearCache("planning", runId);
}
