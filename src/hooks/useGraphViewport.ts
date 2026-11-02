import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { getViewportForBounds, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { graphFitOptions, runningViewportForGraph } from "../lib/graphFit";

const LAYOUT_SETTLE_MS = 80;

/** Keep the measured, currently rendered layout centered throughout a topology change. */
export function useGraphViewport(runKey: string, visible: boolean, nodes: Node[], edges: Edge[], planning: boolean,
  canvasRef: RefObject<HTMLDivElement | null>) {
  const [flow, setFlow] = useState<{ instance: ReactFlowInstance; key: string } | null>(null);
  const [readyKey, setReadyKey] = useState("");
  const ready = visible && readyKey === runKey && flow?.key === runKey;
  const targets = useRef(nodes);
  targets.current = nodes;
  const activeKey = useRef(runKey);
  const synchronizeRef = useRef<(() => void) | null>(null);
  const manualFitRef = useRef<(() => void) | null>(null);
  const synchronize = useCallback(() => synchronizeRef.current?.(), []);
  const manualFit = useCallback(() => manualFitRef.current?.(), []);

  // Text tokens, selection, measurements and execution status must not restart
  // automatic fitting (or undo a user's pan/zoom after the layout has settled).
  const layoutKey = JSON.stringify([
    nodes.map(node => [node.id, node.position.x, node.position.y]),
    edges.map(edge => [edge.id, edge.source, edge.target]),
  ]);

  useLayoutEffect(() => {
    activeKey.current = runKey;
    setReadyKey("");
    setFlow(current => visible && current?.key === runKey ? current : null);
  }, [runKey, visible]);

  const initialize = useCallback((instance: ReactFlowInstance, key: string) => {
    if (activeKey.current === key) setFlow({ instance, key });
  }, []);

  // Planning completion can resize the footer even without a topology change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !flow || flow.key !== runKey || !canvas) return;
    const { instance } = flow;
    let cancelled = false;
    let frame: number | null = null;
    let tracking = true;
    let preferRunning = false;
    let previousLayout = "";
    let stableSince = 0;

    const schedule = () => {
      if (!cancelled && tracking && frame === null) frame = requestAnimationFrame(fitRenderedLayout);
    };
    const fitRenderedLayout = (now: number) => {
      frame = null;
      if (cancelled || !targets.current.length) return;
      const expected = targets.current;
      const rendered = instance.getNodes();
      let atDestination = true;
      const measured = rendered.length === expected.length && expected.every(node => {
        const actual = instance.getInternalNode(node.id);
        if (!actual?.measured?.width || !actual.measured.height) return false;
        if (actual.position.x !== node.position.x || actual.position.y !== node.position.y) atDestination = false;
        return true;
      });
      if (!measured || !canvas.clientWidth || !canvas.clientHeight) {
        previousLayout = "";
        schedule();
        return;
      }

      // Fit *current* positions, not the destination of the 400ms interpolation.
      // Recenter in the same animation, rather than waiting and then panning a
      // second time. The first measured node can be revealed immediately.
      const bounds = instance.getNodesBounds(rendered);
      const viewport = (preferRunning && runningViewportForGraph(instance, canvas.clientWidth, canvas.clientHeight)) ||
        getViewportForBounds(bounds, canvas.clientWidth, canvas.clientHeight,
          graphFitOptions.minZoom, graphFitOptions.maxZoom, graphFitOptions.padding);
      void instance.setViewport(viewport, { duration: 0 });
      setReadyKey(current => current === runKey ? current : runKey);

      const layout = atDestination ? JSON.stringify([canvas.clientWidth, canvas.clientHeight, bounds]) : "";
      if (!layout || layout !== previousLayout) {
        previousLayout = layout;
        stableSince = now;
      }
      // Stability ends the tracking loop; it never gates the initial reveal.
      if (!layout || now - stableSince < LAYOUT_SETTLE_MS) schedule();
      else { tracking = false; preferRunning = false; }
    };
    // React Flow commits animated positions after the animation's RAF callback.
    // Fit in that commit's layout effect too, so the camera never lags a frame
    // behind the cards (especially noticeable at low frame rates).
    const synchronizeLayout = () => {
      if (cancelled || !tracking) return;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      fitRenderedLayout(performance.now());
    };
    synchronizeRef.current = synchronizeLayout;
    // If Fit View is pressed mid-animation, keep following its running focus
    // until the cards settle instead of replacing it with a whole-graph fit.
    manualFitRef.current = () => { if (tracking) preferRunning = true; };
    const resize = new ResizeObserver(() => { previousLayout = ""; tracking = true; schedule(); });
    resize.observe(canvas);
    schedule();
    return () => {
      cancelled = true;
      synchronizeRef.current = null;
      manualFitRef.current = null;
      resize.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [flow, runKey, visible, layoutKey, planning, canvasRef]);

  return { ready, initialize, synchronize, manualFit };
}
