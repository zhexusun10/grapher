import type { FileChangeSummary, FileDiffResult } from "../types";

export const emptyFileChangeSummary: FileChangeSummary = {
  files: [],
  totalFiles: 0,
  addedCount: 0,
  modifiedCount: 0,
  deletedCount: 0,
  renamedCount: 0,
  totalAdditions: 0,
  totalDeletions: 0,
  isRunning: false,
};

const MAX_CACHED_FILE_CHANGE_SUMMARIES = 64;
const fileChangeSummaryCache = new Map<string, { runId: string; summary: FileChangeSummary }>();
const MAX_CACHED_FILE_DIFFS = 32;
const MAX_CACHED_FILE_DIFF_CHARS = 4 * 1024 * 1024;
const fileDiffCache = new Map<string, { runId: string; diff: FileDiffResult; chars: number }>();
let cachedFileDiffChars = 0;

function estimateDiffChars(diff: FileDiffResult): number {
  let chars = diff.path.length + (diff.oldPath?.length ?? 0);
  for (let i = 0; i < diff.lines.length; i++) {
    chars += diff.lines[i].text.length + 16;
  }
  return chars;
}

export function getCachedFileChangeSummary(key: string): FileChangeSummary | undefined {
  return fileChangeSummaryCache.get(key)?.summary;
}

export function cacheFileChangeSummary(key: string, runId: string, summary: FileChangeSummary): void {
  fileChangeSummaryCache.delete(key);
  fileChangeSummaryCache.set(key, { runId, summary });
  if (fileChangeSummaryCache.size > MAX_CACHED_FILE_CHANGE_SUMMARIES) {
    const oldest = fileChangeSummaryCache.keys().next().value;
    if (oldest !== undefined) fileChangeSummaryCache.delete(oldest);
  }
}

export function getCachedFileDiff(key: string): FileDiffResult | undefined {
  const entry = fileDiffCache.get(key);
  if (!entry) return undefined;
  fileDiffCache.delete(key);
  fileDiffCache.set(key, entry);
  return entry.diff;
}

export function cacheFileDiff(key: string, runId: string, diff: FileDiffResult): void {
  const existing = fileDiffCache.get(key);
  if (existing) {
    cachedFileDiffChars = Math.max(0, cachedFileDiffChars - existing.chars);
    fileDiffCache.delete(key);
  }
  const chars = estimateDiffChars(diff);
  if (chars > MAX_CACHED_FILE_DIFF_CHARS) return;
  fileDiffCache.set(key, { runId, diff, chars });
  cachedFileDiffChars += chars;
  while (fileDiffCache.size > MAX_CACHED_FILE_DIFFS || cachedFileDiffChars > MAX_CACHED_FILE_DIFF_CHARS) {
    const oldest = fileDiffCache.entries().next().value;
    if (!oldest) break;
    fileDiffCache.delete(oldest[0]);
    cachedFileDiffChars = Math.max(0, cachedFileDiffChars - oldest[1].chars);
  }
}

export function invalidateFileDiffCache(runId?: string): void {
  if (!runId) {
    fileDiffCache.clear();
    cachedFileDiffChars = 0;
    return;
  }
  for (const [key, entry] of fileDiffCache) {
    if (entry.runId === runId) {
      fileDiffCache.delete(key);
      cachedFileDiffChars = Math.max(0, cachedFileDiffChars - entry.chars);
    }
  }
}

export function invalidateFileChangeSummaryCache(runId?: string): void {
  invalidateFileDiffCache(runId);
  if (!runId) {
    fileChangeSummaryCache.clear();
    return;
  }
  for (const [key, entry] of fileChangeSummaryCache) {
    if (entry.runId === runId) fileChangeSummaryCache.delete(key);
  }
}
