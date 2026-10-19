import { BoundedLruCache, utf8Bytes } from "../lib/BoundedLruCache";
import { renderTranscriptWindow, type TranscriptWindow } from "./transcriptWindow";

export type CachedTranscript = {
  text: string;
  offset: number;
  startOffset?: number;
  totalBytes?: number;
  /** Complete means all bytes of a terminal log, not merely its current EOF. */
  complete: boolean;
  status?: string;
};
// Validated contiguous windows already carry their retained UTF-8 byte count.
// Do not rescan an ever-growing string on every live delta (or charge totalBytes).
const transcriptBytes = (entry: CachedTranscript) => entry.startOffset !== undefined && entry.offset >= entry.startOffset
  ? entry.offset - entry.startOffset : utf8Bytes(entry.text);
export const executionTranscriptCache = new BoundedLruCache<string, CachedTranscript>(transcriptBytes);
// Each revision is independently reusable, including when the revision list grows.
export const planningTranscriptCache = new BoundedLruCache<string, CachedTranscript>(transcriptBytes);
export const planningTranscriptKey = (runId: string, planningId: string) => `${runId}:${planningId}`;

export function transcriptFromCache(entry: CachedTranscript | undefined): TranscriptWindow | null {
  return entry ? { text: entry.text, start: entry.startOffset ?? 0, end: entry.offset,
    total: entry.totalBytes ?? entry.offset, settled: entry.complete || (!!entry.status && entry.status !== "running") } : null;
}

const cacheListeners = new Set<() => void>();
let notifyScheduled = false;

export function subscribeTranscriptCacheChanges(listener: () => void): () => void {
  cacheListeners.add(listener);
  return () => { cacheListeners.delete(listener); };
}

export function notifyTranscriptCacheChanged(): void {
  if (cacheListeners.size === 0 || notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    for (const listener of cacheListeners) listener();
  });
}

export function cacheTranscriptWindow(window: TranscriptWindow): CachedTranscript {
  const cached: CachedTranscript = { text: window.text, offset: window.end, startOffset: window.start, totalBytes: window.total,
    complete: window.start === 0 && window.end === window.total && window.settled,
    status: window.settled ? "completed" : "running" };
  notifyTranscriptCacheChanged();
  return cached;
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

/** Invalidation cancels readers too: a late response must not resurrect RAM history. */
export function registerTranscriptReader(kind: CacheKind, key: string, controller: AbortController): () => void {
  const reader = { kind, key, controller };
  readers.add(reader);
  return () => { controller.abort(); readers.delete(reader); };
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
  clearCache("execution", runId);
  clearCache("planning", runId);
}
