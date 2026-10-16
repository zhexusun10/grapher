export function estimateTranscriptRowHeight(id: string): number {
  if (id.startsWith("think_")) return 44;
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

/** Preserve a retained row, not total height: an append and prepend may commit together. */
export function retainedRowAnchor(beforeIds: string[], afterIds: string[], before: number[], after: number[], top: number) {
  const indices = new Map(afterIds.map((id, index) => [id, index]));
  for (let index = rowAt(before, Math.max(0, top)); index < beforeIds.length; index++) {
    const nextIndex = indices.get(beforeIds[index]);
    if (nextIndex !== undefined) return { id: beforeIds[index], delta: after[nextIndex] - before[index] };
  }
  return null;
}

export function visibleRows(offsets: number[], top: number, height: number, overscan = 6) {
  const count = offsets.length - 1;
  const start = Math.max(0, rowAt(offsets, top) - overscan);
  const end = Math.min(count, rowAt(offsets, top + height) + overscan + 1);
  return { start, end, paddingTop: offsets[start], paddingBottom: offsets[count] - offsets[end] };
}
