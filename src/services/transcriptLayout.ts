import type { TranscriptItem } from "../types";

export interface ActivitySummaryAnchor {
  toolCallIds: string[];
  itemIds: string[];
  ordinalFromEnd: number;
}

/** Reassociate an expanded summary with its content if streaming changes its
 * presentation ID or regroups neighboring transcript items. Prefer durable
 * tool-call identity, then overlap in the group's child rows, and only then
 * fall back to its position. */
export function matchActivitySummary(
  summaries: TranscriptItem[],
  anchor: ActivitySummaryAnchor,
): TranscriptItem | undefined {
  const byToolCall = anchor.toolCallIds.length > 0
    ? summaries.find(row => row.type === "activity_summary" &&
      (row.summaryItems ?? []).some(child => child.toolCallId && anchor.toolCallIds.includes(child.toolCallId)))
    : undefined;
  if (byToolCall) return byToolCall;

  if (anchor.itemIds.length > 0) {
    const itemIds = new Set(anchor.itemIds);
    let best: TranscriptItem | undefined;
    let bestOverlap = 0;
    let tied = false;
    for (const row of summaries) {
      if (row.type !== "activity_summary") continue;
      const overlap = (row.summaryItems ?? []).reduce((count, child) => count + Number(itemIds.has(child.id)), 0);
      if (overlap > bestOverlap) {
        best = row;
        bestOverlap = overlap;
        tied = false;
      } else if (overlap > 0 && overlap === bestOverlap) {
        tied = true;
      }
    }
    if (best && !tied) return best;
  }
  return summaries[summaries.length - 1 - anchor.ordinalFromEnd];
}

export function isCollapsibleTranscriptCard(item: TranscriptItem): boolean {
  if (item.type === "thinking" || item.type === "tool_call") return true;
  if (item.errorItems?.length) return true;
  return (item.type === "system" || (item.type === "text" && item.role === "assistant")) &&
    Boolean(item.isError || item.status === "error");
}

function collapseTranscriptCards(rows: TranscriptItem[], starts: Map<string, number>, live = false, canPrepend = true) {
  const boundaries = new Set(starts.values());
  const collapsed: TranscriptItem[] = [];
  const collapsedRanges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < rows.length;) {
    if (!isCollapsibleTranscriptCard(rows[index])) {
      collapsed.push(rows[index++]);
      continue;
    }
    let end = index + 1;
    while (end < rows.length && !boundaries.has(end) && isCollapsibleTranscriptCard(rows[end])) end++;
    const group = rows.slice(index, end);
    const first = group[0];
    const last = group[group.length - 1];
    const hasRunning = group.some(item => item.status === "running");
    const hasError = group.some(item => Boolean(item.errorItems?.length || item.isError || item.status === "error"));
    const summaryOpen = end === rows.length && (live || hasRunning);
    // Only a leading settled group that can still grow at the front when older
    // history pages prepend needs to anchor on its trailing item. Every other
    // group (including any transcript starting at byte zero, or an actively
    // live tail) anchors on its leading item so settling or adding tools never
    // renames an expanded strip mid-view.
    // Prefer a stable `toolCallId` when present so upgrading `summaryOnly` to
    // full output (which changes offset-based `think_`/`err_` IDs) keeps the
    // exact same summary identity.
    const anchorFromEnd = canPrepend && index === 0 && !(end === rows.length && (live || hasRunning));
    const stableTool = anchorFromEnd
      ? [...group].reverse().find(item => item.type === "tool_call" && Boolean(item.toolCallId))
      : group.find(item => item.type === "tool_call" && Boolean(item.toolCallId));
    const anchorId = stableTool?.toolCallId ?? (anchorFromEnd ? last.id : first.id);
    collapsed.push({
      id: `summary_${anchorId}`,
      type: "activity_summary",
      role: "assistant",
      status: hasRunning ? "running" : hasError ? "error" : "success",
      timestamp: first.timestamp,
      summaryItems: group,
      ...(summaryOpen ? { summaryOpen: true } : {}),
    });
    if (end - index > 1) collapsedRanges.push({ start: index, end });
    index = end;
  }

  if (!collapsedRanges.length) return { rows: collapsed, starts };
  const remappedStarts = new Map([...starts].map(([source, index]) => [source,
    index - collapsedRanges.reduce((removed, range) => removed + (range.end <= index ? range.end - range.start - 1 : 0), 0)]));
  return { rows: collapsed, starts: remappedStarts };
}

/** Preserve mounted `activity_summary` row IDs across live updates, prepends
 * reaching byte zero, and projection upgrades when a group's computed anchor
 * shifts (for example thinking followed by its first tool call, or a leading
 * live group settling). Keeping the existing row ID prevents React from
 * unmounting `ActivitySummaryRow` and losing open child cards or scroll state. */
export function stabilizeActivitySummaryIds(
  rows: TranscriptItem[],
  previousSummaries: readonly TranscriptItem[],
): TranscriptItem[] {
  if (!previousSummaries.length) return rows;
  const prevById = new Map<string, { item: TranscriptItem; toolCallIds: Set<string>; itemIds: Set<string> }>();
  const prevList: Array<{ item: TranscriptItem; toolCallIds: Set<string>; itemIds: Set<string> }> = [];
  for (const prev of previousSummaries) {
    if (prev.type !== "activity_summary") continue;
    const children = prev.summaryItems ?? [];
    const entry = {
      item: prev,
      toolCallIds: new Set(children.map(child => child.toolCallId).filter((id): id is string => Boolean(id))),
      itemIds: new Set(children.map(child => child.id)),
    };
    prevById.set(prev.id, entry);
    prevList.push(entry);
  }
  if (!prevList.length) return rows;

  const claimedPrevIds = new Set<string>();
  const usedRowIds = new Set<string>();
  const summaryIndexes: number[] = [];

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.type !== "activity_summary") {
      usedRowIds.add(row.id);
      continue;
    }
    summaryIndexes.push(index);
    const existing = prevById.get(row.id);
    if (existing && !claimedPrevIds.has(row.id)) {
      const children = row.summaryItems ?? [];
      const overlaps = children.some(
        child => (child.toolCallId && existing.toolCallIds.has(child.toolCallId)) || existing.itemIds.has(child.id),
      );
      if (overlaps) {
        claimedPrevIds.add(row.id);
        usedRowIds.add(row.id);
      }
    }
  }

  let nextRows: TranscriptItem[] | null = null;
  for (const index of summaryIndexes) {
    const row = rows[index];
    if (claimedPrevIds.has(row.id) && usedRowIds.has(row.id)) continue;
    const children = row.summaryItems ?? [];
    const isIdTakenElsewhere = (candidateId: string) =>
      claimedPrevIds.has(candidateId) ||
      usedRowIds.has(candidateId) ||
      summaryIndexes.some(other => other !== index && (nextRows ? nextRows[other] : rows[other]).id === candidateId);

    let matchedId: string | null = null;
    let bestToolOverlap = 0;
    let toolTied = false;
    for (const prev of prevList) {
      if (isIdTakenElsewhere(prev.item.id) || !prev.toolCallIds.size) continue;
      const overlap = children.reduce(
        (count, child) => count + Number(Boolean(child.toolCallId && prev.toolCallIds.has(child.toolCallId))),
        0,
      );
      if (overlap > bestToolOverlap) {
        bestToolOverlap = overlap;
        matchedId = prev.item.id;
        toolTied = false;
      } else if (overlap > 0 && overlap === bestToolOverlap) {
        toolTied = true;
      }
    }
    if (toolTied) matchedId = null;

    if (!matchedId) {
      let bestItemOverlap = 0;
      let itemTied = false;
      for (const prev of prevList) {
        if (isIdTakenElsewhere(prev.item.id)) continue;
        const overlap = children.reduce(
          (count, child) => count + Number(prev.itemIds.has(child.id)),
          0,
        );
        if (overlap > bestItemOverlap) {
          bestItemOverlap = overlap;
          matchedId = prev.item.id;
          itemTied = false;
        } else if (overlap > 0 && overlap === bestItemOverlap) {
          itemTied = true;
        }
      }
      if (itemTied) matchedId = null;
    }

    if (matchedId && matchedId !== row.id) {
      claimedPrevIds.add(matchedId);
      usedRowIds.add(matchedId);
      if (!nextRows) nextRows = [...rows];
      nextRows[index] = { ...row, id: matchedId };
    } else {
      usedRowIds.add(row.id);
    }
  }
  return nextRows ?? rows;
}

/** Whitespace-only assistant text has no visible Markdown, but still takes a
 * row and two list gaps. Keep it in the parser so later deltas can extend it;
 * omit it only from the rendered projection and remap revision boundaries. */
export function visibleTranscriptRows(
  rows: TranscriptItem[],
  starts = new Map<string, number>(),
  options?: { collapseCards?: boolean; live?: boolean; canPrepend?: boolean },
) {
  const blank = (item: TranscriptItem) => item.type === "text" && item.role === "assistant" &&
    !item.content?.trim() && !item.images?.length && !item.files?.length;
  const first = rows.findIndex(blank);
  const visible = first < 0 ? rows : rows.filter(item => !blank(item));
  let visibleStarts = starts;
  if (first >= 0) {
    const indices = Array.from({ length: first + 1 }, (_, index) => index);
    for (let index = first; index < rows.length; index++) {
      if (!blank(rows[index])) indices.push(indices[indices.length - 1] + 1);
      else indices.push(indices[indices.length - 1]);
    }
    visibleStarts = new Map([...starts].map(([source, index]) => [source, indices[index]]));
  }

  const isError = (item: TranscriptItem) => (item.type === "system" || (item.type === "text" && item.role === "assistant")) &&
    (item.isError || item.status === "error");
  const boundaries = new Set(visibleStarts.values());
  const grouped: TranscriptItem[] = [];
  const collapsedRanges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < visible.length;) {
    if (!isError(visible[index])) {
      grouped.push(visible[index++]);
      continue;
    }
    let end = index + 1;
    while (end < visible.length && !boundaries.has(end) && isError(visible[end])) end++;
    if (end - index > 1) {
      grouped.push({ ...visible[index], errorItems: visible.slice(index, end) });
      collapsedRanges.push({ start: index, end });
    } else {
      grouped.push(visible[index]);
    }
    index = end;
  }

  const base = !collapsedRanges.length
    ? { rows: visible, starts: visibleStarts }
    : {
        rows: grouped,
        starts: new Map([...visibleStarts].map(([source, index]) => [source,
          index - collapsedRanges.reduce((removed, range) => removed + (range.end <= index ? range.end - range.start - 1 : 0), 0)])),
      };
  return options?.collapseCards
    ? collapseTranscriptCards(base.rows, base.starts, Boolean(options.live), options.canPrepend ?? true)
    : base;
}

export function estimateTranscriptRowHeight(id: string): number {
  if (id.startsWith("summary_")) return 28;
  if (id.startsWith("think_")) return 44;
  if (id.startsWith("divider_")) return 25;
  if (id.startsWith("tool") || id.startsWith("call_")) return 48;
  if (id.startsWith("err_") || id.startsWith("system_")) return 32;
  if (id.startsWith("user_") || id.startsWith("session_user_")) return 56;
  if (id.startsWith("text_")) return 88;
  return 56;
}

// Offsets include the trailing edge so binary search handles tall rows and EOF.
export function rowOffsets(
  ids: string[],
  heights: Pick<ReadonlyMap<string, number>, "get">,
  estimate: number | ((id: string) => number) = 72,
): number[] {
  const offsets = [0];
  const getEstimate = typeof estimate === "function" ? estimate : () => estimate;
  for (const id of ids) offsets.push(offsets[offsets.length - 1] + (heights.get(id) ?? getEstimate(id)));
  return offsets;
}

export function rowAt(offsets: number[], position: number): number {
  let low = 0, high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid] <= position) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Preserve the first visible retained row that the change actually moved.
 * Rows can be inserted or removed anywhere, not only in front of the list: a
 * composed Planner conversation pages older bytes of a later revision in below
 * the turn that precedes it, and a serial conversation pages one Node below
 * another. Rows above the change keep their offset, so anchoring the viewport's
 * top row would leave the rows the reader is looking at to be dragged by the
 * inserted block. Rows whose offset did not move, and rows below the viewport,
 * are skipped, so a live append under the reader never scrolls them. */
export function retainedRowAnchor(beforeIds: string[], afterIds: string[], before: number[], after: number[], top: number, bottom = Infinity) {
  const indices = new Map(afterIds.map((id, index) => [id, index]));
  for (let index = rowAt(before, Math.max(0, top)); index < beforeIds.length; index++) {
    if (before[index] >= bottom) break;
    const nextIndex = indices.get(beforeIds[index]);
    if (nextIndex === undefined) continue;
    const delta = after[nextIndex] - before[index];
    if (Math.abs(delta) < 1) continue;
    return { id: beforeIds[index], delta };
  }
  return null;
}

export function visibleRows(offsets: number[], top: number, height: number, overscan = 6, pixelOverscan = 0) {
  const count = offsets.length - 1;
  let start = Math.max(0, rowAt(offsets, top) - overscan);
  let end = Math.min(count, rowAt(offsets, top + height) + overscan + 1);
  if (pixelOverscan > 0 && count > 0) {
    const pixelStart = rowAt(offsets, Math.max(0, top - pixelOverscan));
    const pixelEnd = Math.min(count, rowAt(offsets, top + height + pixelOverscan) + 1);
    start = Math.min(start, pixelStart);
    end = Math.max(end, pixelEnd);
  }
  return { start, end, paddingTop: offsets[start], paddingBottom: offsets[count] - offsets[end] };
}
