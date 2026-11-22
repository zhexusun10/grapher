import type { TranscriptItem } from "../types";
import { toolOutputPreview, truncateToolArgs } from "./toolOutput";

/** Threshold below which expanding an `ActivitySummaryRow` eagerly hydrates all
 * omitted children in parallel with its 260ms open animation; larger groups
 * hydrate each child card individually when clicked. */
export const EAGER_SUMMARY_HYDRATION_MAX_BYTES = 512 * 1024;

export interface HydratedCardPatch {
  content?: string;
  thinkingCharCount?: number;
  args?: Record<string, any>;
  argsTruncated?: boolean;
  result?: string;
  exitCode?: number | null;
  truncated?: boolean;
  isError?: boolean;
  durationMs?: number;
  argsOmitted?: boolean;
  resultOmitted?: boolean;
  bodyOmitted?: boolean;
}

/** Stable identity for hydrated card bodies that survives collapse/expand
 * toggles, older-page prepends, and projection mode switches. */
export function hydrationKeyForItem(item: TranscriptItem): string | null {
  const sourcePrefix = item.source ? `${item.source}:` : "";
  if (item.type === "tool_call") {
    if (item.toolCallId) return `${sourcePrefix}tool:${item.toolCallId}`;
    const range = item.rawResultRange ?? item.rawArgsRange;
    if (range) return `${sourcePrefix}tool_range:${range[0]}:${range[1]}`;
    return null;
  }
  if (item.type === "thinking") {
    if (item.rawRange) {
      return `${sourcePrefix}think:${item.rawRange[0]}:${item.rawRange[1]}:${item.thinkingContentIndex ?? 0}`;
    }
    return null;
  }
  return null;
}

export function itemHydrationRanges(item: TranscriptItem): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  if (item.type === "thinking") {
    if (item.bodyOmitted && item.rawRange) ranges.push(item.rawRange);
    return ranges;
  }
  if (item.type === "tool_call") {
    if (item.argsOmitted && item.rawArgsRange) ranges.push(item.rawArgsRange);
    if (item.resultOmitted && item.rawResultRange) {
      const dup = ranges.some(([s, e]) => s === item.rawResultRange![0] && e === item.rawResultRange![1]);
      if (!dup) ranges.push(item.rawResultRange);
    }
  }
  return ranges;
}

export function collectHydrationRanges(items: readonly TranscriptItem[]): Array<[number, number]> {
  const seen = new Set<string>();
  const ranges: Array<[number, number]> = [];
  for (const item of items) {
    for (const range of itemHydrationRanges(item)) {
      const key = `${range[0]}:${range[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ranges.push(range);
    }
  }
  return ranges;
}

export function totalHydrationRangeBytes(ranges: ReadonlyArray<readonly [number, number]>): number {
  let total = 0;
  for (const [start, end] of ranges) total += Math.max(0, end - start);
  return total;
}

function parseRawRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [start, end] = value;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return undefined;
  return [start, end];
}

function mergeToolArgsPatch(
  patches: Map<string, HydratedCardPatch>,
  key: string,
  rawArgs: Record<string, any> | undefined,
  flaggedTruncated: boolean,
) {
  const bounded = truncateToolArgs(rawArgs || {});
  const prev = patches.get(key) ?? {};
  const next: HydratedCardPatch = {
    ...prev,
    args: Object.keys(bounded.args).length ? bounded.args : (prev.args ?? {}),
    argsTruncated: prev.argsTruncated || flaggedTruncated || bounded.truncated || undefined,
    argsOmitted: false,
  };
  next.bodyOmitted = Boolean(next.argsOmitted || next.resultOmitted);
  patches.set(key, next);
}

function mergeToolResultPatch(
  patches: Map<string, HydratedCardPatch>,
  key: string,
  result: any,
  isError: boolean,
  durationMs?: number,
) {
  const preview = toolOutputPreview(result?.content);
  const rawExitCode = result?.details?.exitCode;
  const exitCode = typeof rawExitCode === "number" ? rawExitCode : null;
  const failed = isError || result?.isError || (exitCode !== null && exitCode !== 0);
  const prev = patches.get(key) ?? {};
  const next: HydratedCardPatch = {
    ...prev,
    result: preview.text,
    exitCode,
    truncated: !!(result?.details?.truncation?.truncated ||
      preview.text.includes("[Showing lines") || preview.text.includes("Full output:")),
    isError: !!failed,
    durationMs: typeof durationMs === "number" ? durationMs : prev.durationMs,
    resultOmitted: false,
  };
  next.bodyOmitted = Boolean(next.argsOmitted || next.resultOmitted);
  patches.set(key, next);
}

/** Parse hydrated JSONL lines returned by `ranges` fetch into per-card patches. */
export function extractHydratedCardPatches(
  jsonl: string,
  targetItems: readonly TranscriptItem[],
  source?: string,
): Map<string, HydratedCardPatch> {
  const patches = new Map<string, HydratedCardPatch>();
  if (!jsonl.trim()) return patches;

  const targetByToolId = new Map<string, TranscriptItem>();
  const targetByRange = new Map<string, TranscriptItem[]>();
  for (const item of targetItems) {
    if (item.type === "tool_call" && item.toolCallId) targetByToolId.set(item.toolCallId, item);
    for (const range of itemHydrationRanges(item)) {
      const rKey = `${range[0]}:${range[1]}`;
      const list = targetByRange.get(rKey) ?? [];
      list.push(item);
      targetByRange.set(rKey, list);
    }
  }

  const toolKeyFor = (toolCallId: string | undefined, range?: [number, number]): string | null => {
    if (toolCallId) {
      const target = targetByToolId.get(toolCallId);
      if (target) return hydrationKeyForItem(target);
      return `${source ? `${source}:` : ""}tool:${toolCallId}`;
    }
    if (range) {
      const matched = targetByRange.get(`${range[0]}:${range[1]}`)?.find(i => i.type === "tool_call");
      if (matched) return hydrationKeyForItem(matched);
      return `${source ? `${source}:` : ""}tool_range:${range[0]}:${range[1]}`;
    }
    return null;
  };

  for (const rawLine of jsonl.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: any;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (!event || typeof event !== "object") continue;
    const range = parseRawRange(event.grapherRawRange);

    if (event.type === "tool_execution_start") {
      const key = toolKeyFor(event.toolCallId, range);
      if (key) mergeToolArgsPatch(patches, key, event.args, !!event.argsTruncated);
      continue;
    }

    if (event.type === "tool_execution_end") {
      const key = toolKeyFor(event.toolCallId, range);
      if (key) mergeToolResultPatch(patches, key, event.result, !!event.isError, event.durationMs);
      continue;
    }

    if (event.type === "message_update" && event.assistantMessageEvent?.type === "toolcall_end") {
      const tool = event.assistantMessageEvent.toolCall;
      if (tool) {
        const key = toolKeyFor(tool.id, range);
        if (key) mergeToolArgsPatch(patches, key, tool.arguments || tool.args, !!tool.argsTruncated);
      }
      continue;
    }

    if ((event.type === "message_end" || event.type === "message") && event.message) {
      const msg = event.message;
      if (msg.role === "toolResult") {
        const key = toolKeyFor(msg.toolCallId, range);
        if (key) {
          mergeToolResultPatch(
            patches,
            key,
            { content: msg.content, details: msg.details, isError: msg.isError },
            !!msg.isError,
            msg.durationMs,
          );
        }
        continue;
      }
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        msg.content.forEach((part: any, contentIndex: number) => {
          if (part?.type === "toolCall") {
            const key = toolKeyFor(part.id, range);
            if (key) mergeToolArgsPatch(patches, key, part.arguments || part.args, !!part.argsTruncated);
          } else if (part?.type === "thinking" && range) {
            const matched = targetByRange.get(`${range[0]}:${range[1]}`)?.find(
              item => item.type === "thinking" && (item.thinkingContentIndex ?? 0) === contentIndex,
            );
            const key = matched
              ? hydrationKeyForItem(matched)
              : `${source ? `${source}:` : ""}think:${range[0]}:${range[1]}:${contentIndex}`;
            if (key) {
              const thinking = typeof part.thinking === "string" ? part.thinking : "";
              patches.set(key, {
                content: thinking,
                thinkingCharCount: thinking.trim().length,
                bodyOmitted: false,
              });
            }
          }
        });
      }
    }
  }

  return patches;
}

/** Overlay hydrated payloads and transient loading flags onto parsed items
 * without mutating cached items; preserves item identity when unchanged. */
export function applyHydratedCardPatches(
  items: TranscriptItem[],
  patches?: ReadonlyMap<string, HydratedCardPatch>,
  hydratingKeys?: ReadonlySet<string>,
): TranscriptItem[] {
  if ((!patches || patches.size === 0) && (!hydratingKeys || hydratingKeys.size === 0)) {
    return items;
  }
  let changed = false;
  const next = items.map(item => {
    if (item.type !== "tool_call" && item.type !== "thinking") return item;
    const key = hydrationKeyForItem(item);
    if (!key) return item;
    const patch = patches?.get(key);
    const hydrating = Boolean(hydratingKeys?.has(key));
    if (!patch && !hydrating) return item;
    changed = true;
    const argsOmitted = patch?.argsOmitted !== undefined ? patch.argsOmitted : item.argsOmitted;
    const resultOmitted = patch?.resultOmitted !== undefined ? patch.resultOmitted : item.resultOmitted;
    const bodyOmitted = item.type === "thinking"
      ? (patch?.bodyOmitted !== undefined ? patch.bodyOmitted : item.bodyOmitted)
      : Boolean(argsOmitted || resultOmitted);
    return {
      ...item,
      ...(patch?.content !== undefined ? { content: patch.content } : {}),
      ...(patch?.thinkingCharCount !== undefined ? { thinkingCharCount: patch.thinkingCharCount } : {}),
      ...(patch?.args !== undefined ? { args: patch.args } : {}),
      ...(patch?.argsTruncated !== undefined ? { argsTruncated: patch.argsTruncated } : {}),
      ...(patch?.result !== undefined ? { result: patch.result } : {}),
      ...(patch?.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
      ...(patch?.truncated !== undefined ? { truncated: item.truncated || patch.truncated } : {}),
      ...(patch?.isError !== undefined ? { isError: patch.isError } : {}),
      ...(patch?.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
      argsOmitted: argsOmitted || undefined,
      resultOmitted: resultOmitted || undefined,
      bodyOmitted: bodyOmitted || undefined,
      hydrating: hydrating || undefined,
    };
  });
  return changed ? next : items;
}
