// Offsets include the trailing edge so binary search handles tall rows and EOF.
export function rowOffsets(ids: string[], heights: ReadonlyMap<string, number>, estimate = 72): number[] {
  const offsets = [0];
  for (const id of ids) offsets.push(offsets[offsets.length - 1] + (heights.get(id) ?? estimate));
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

export function visibleRows(offsets: number[], top: number, height: number, overscan = 6) {
  const count = offsets.length - 1;
  const start = Math.max(0, rowAt(offsets, top) - overscan);
  const end = Math.min(count, rowAt(offsets, top + height) + overscan + 1);
  return { start, end, paddingTop: offsets[start], paddingBottom: offsets[count] - offsets[end] };
}
