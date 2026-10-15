import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useReducedMotion } from "motion/react";
import type { Edge, FitViewOptions, Node, ReactFlowInstance } from "@xyflow/react";

// Match the Controls button, including React Flow's default fit padding.
export const graphFitOptions: FitViewOptions = { padding: 0.1, minZoom: 0.3, maxZoom: 1.6 };
const LAYOUT_SETTLE_MS = 80;

/** Fit the rendered, measured destination layout, not an intermediate animation frame. */
export function useGraphViewport(runKey: string, visible: boolean, nodes: Node[], edges: Edge[], planning: boolean,
  canvasRef: RefObject<HTMLDivElement | null>) {
  const [flow, setFlow] = useState<{ instance: ReactFlowInstance; key: string } | null>(null);
  const [readyKey, setReadyKey] = useState("");
  const ready = visible && readyKey === runKey && flow?.key === runKey;
  const reduceMotion = useReducedMotion();
  const targets = useRef(nodes);
  targets.current = nodes;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const activeKey = useRef(runKey);

  // Ignore transcript, selection and status-only changes. Rewiring/replacing
  // elements with the same counts can still change the destination layout.
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

  // Planning completion needs a final fit even when counts/positions match:
  // the approval footer can change the available canvas height.
  useEffect(() => {
    if (!visible || !flow || flow.key !== runKey || !targets.current.length) return;
    const { instance } = flow;
    let cancelled = false;
    let frame: number | null = null;
    let previousLayout = "";
    let stableSince = 0;

    const fitWhenSettled = async (now: number) => {
      frame = null;
      if (cancelled) return;
      const canvas = canvasRef.current;
      const expected = targets.current;
      const rendered = instance.getNodes();
      const dimensions: number[] = [];
      const measured = rendered.length === expected.length && expected.every(node => {
        const actual = instance.getInternalNode(node.id);
        if (!actual || actual.position.x !== node.position.x || actual.position.y !== node.position.y ||
            !actual.measured?.width || !actual.measured?.height) return false;
        dimensions.push(actual.measured.width, actual.measured.height);
        return true;
      });
      // Node interpolation and the split-pane/footer transitions finish
      // independently. Wait for both, including a canvas that mounted empty.
      const layout = measured && canvas?.clientWidth && canvas.clientHeight
        ? JSON.stringify([canvas.clientWidth, canvas.clientHeight, dimensions]) : "";
      if (!layout || layout !== previousLayout) {
        previousLayout = layout;
        stableSince = now;
      }
      if (!layout || now - stableSince < LAYOUT_SETTLE_MS) {
        frame = requestAnimationFrame(fitWhenSettled);
        return;
      }
      await instance.fitView({ ...graphFitOptions, duration: readyRef.current && !reduceMotion ? 300 : 0 });
      if (cancelled) return;
      // Reveal only after React Flow has committed the fitted viewport.
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!cancelled) setReadyKey(runKey);
      });
    };
    frame = requestAnimationFrame(fitWhenSettled);
    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [flow, runKey, visible, layoutKey, planning, canvasRef, reduceMotion]);

  return { ready, initialize };
}
