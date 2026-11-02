import type { FitViewOptions, ReactFlowInstance, Rect, Viewport } from "@xyflow/react";

export const graphFitOptions = { padding: 0.1, minZoom: 0.3, maxZoom: 1.6 } satisfies FitViewOptions;

/** Use current rendered geometry, excluding the hidden or unmeasured nodes that fitView ignores. */
export function runningViewportForGraph(instance: ReactFlowInstance, width: number, height: number): Viewport | null {
  const visible = instance.getNodes().filter(node => {
    const actual = instance.getInternalNode(node.id);
    return !node.hidden && !!actual?.measured?.width && !!actual.measured.height;
  });
  const running = visible.filter(node => node.data.status === "running");
  if (!visible.length || !running.length) return null;
  return runningGraphFitViewport(instance.getNodesBounds(visible),
    running.map(node => instance.getNodesBounds([node])), width, height);
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * Return a running-node focus only if the whole graph cannot fit at minimum
 * zoom. Keep that zoom to retain as much surrounding topology as possible.
 */
export function runningGraphFitViewport(bounds: Rect, running: Rect[], width: number, height: number): Viewport | null {
  const zoom = graphFitOptions.minZoom;
  if (!running.length || width <= 0 || height <= 0 ||
      (bounds.width * zoom <= width && bounds.height * zoom <= height)) return null;

  const availableWidth = width / zoom, availableHeight = height / zoom;
  // When running cards are too far apart, centering their combined bounds can
  // show none of them. Try each card as an anchor and choose the largest
  // fitting group found (ties follow graph order). Always show at least one card,
  // even if an individual card is larger than the viewport.
  let best = running[0], bestCount = 0;
  for (const anchor of running) {
    if (anchor.width > availableWidth || anchor.height > availableHeight) continue;
    let group = anchor, count = 1;
    for (const rect of running) {
      if (rect === anchor) continue;
      const next = union(group, rect);
      if (next.width <= availableWidth && next.height <= availableHeight) {
        group = next;
        count++;
      }
    }
    if (count > bestCount) {
      best = group;
      bestCount = count;
      if (count === running.length) break;
    }
  }
  return { x: width / 2 - (best.x + best.width / 2) * zoom,
    y: height / 2 - (best.y + best.height / 2) * zoom, zoom };
}
