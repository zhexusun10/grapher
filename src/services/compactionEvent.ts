import type { CompactionItemInfo, TranscriptItem } from "../types";

function normalizeReason(value: unknown): CompactionItemInfo["reason"] {
  return value === "manual" || value === "threshold" || value === "overflow" ? value : undefined;
}

function normalizeTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function normalizeFileList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const files: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    files.push(trimmed);
  }
  return files.length > 0 ? files : undefined;
}

/** Extract structured compaction metadata from either a live Pi `compaction_end`
 * RPC event or a persisted Pi session JSONL `compaction` entry. Aborted or
 * empty compaction_end events return null so no misleading card is rendered. */
export function extractCompactionInfo(event: any): CompactionItemInfo | null {
  if (!event || typeof event !== "object") return null;

  if (event.type === "compaction_end") {
    if (event.aborted === true) return null;
    const result = event.result;
    if (!result || typeof result !== "object") return null;
    const summary = typeof result.summary === "string" ? result.summary.trim() : "";
    const tokensBefore = normalizeTokenCount(result.tokensBefore);
    const tokensAfter = normalizeTokenCount(result.estimatedTokensAfter);
    if (!summary && !(tokensBefore && tokensBefore > 0)) return null;
    const details = result.details && typeof result.details === "object" ? result.details : undefined;
    const readFiles = normalizeFileList(details?.readFiles);
    const modifiedFiles = normalizeFileList(details?.modifiedFiles);
    return {
      reason: normalizeReason(event.reason),
      tokensBefore,
      tokensAfter,
      summary,
      ...(typeof result.firstKeptEntryId === "string" && result.firstKeptEntryId
        ? { firstKeptEntryId: result.firstKeptEntryId } : {}),
      ...(readFiles ? { readFiles } : {}),
      ...(modifiedFiles ? { modifiedFiles } : {}),
    };
  }

  if (event.type === "compaction") {
    const summary = typeof event.summary === "string" ? event.summary.trim() : "";
    const tokensBefore = normalizeTokenCount(event.tokensBefore);
    const tokensAfter = normalizeTokenCount(event.estimatedTokensAfter);
    if (!summary && !(tokensBefore && tokensBefore > 0)) return null;
    const details = event.details && typeof event.details === "object" ? event.details : undefined;
    const readFiles = normalizeFileList(details?.readFiles);
    const modifiedFiles = normalizeFileList(details?.modifiedFiles);
    return {
      reason: normalizeReason(event.reason),
      tokensBefore,
      tokensAfter,
      summary,
      ...(typeof event.firstKeptEntryId === "string" && event.firstKeptEntryId
        ? { firstKeptEntryId: event.firstKeptEntryId } : {}),
      ...(readFiles ? { readFiles } : {}),
      ...(modifiedFiles ? { modifiedFiles } : {}),
      ...(typeof event.fromHook === "boolean" ? { fromHook: event.fromHook } : {}),
    };
  }

  return null;
}

export function createCompactionTranscriptItem(
  id: string,
  compaction: CompactionItemInfo,
  timestamp: number,
  animateAppear?: boolean,
): TranscriptItem {
  return {
    id,
    type: "compaction",
    role: "system",
    status: "success",
    content: compaction.summary,
    compaction,
    timestamp,
    ...(animateAppear !== undefined ? { animateAppear } : {}),
  };
}
