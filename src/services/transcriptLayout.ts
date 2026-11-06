export function estimateTranscriptRowHeight(id: string): number {
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

export function visibleRows(offsets: number[], top: number, height: number, overscan = 6) {
  const count = offsets.length - 1;
  const start = Math.max(0, rowAt(offsets, top) - overscan);
  const end = Math.min(count, rowAt(offsets, top + height) + overscan + 1);
  return { start, end, paddingTop: offsets[start], paddingBottom: offsets[count] - offsets[end] };
}
