import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow, useNodes, type ReactFlowInstance, type Node, type Edge, type NodeChange, type NodeTypes, type EdgeTypes } from "@xyflow/react";
import { graphFitOptions } from "../../hooks/useGraphViewport";

/** Synchronize the viewport with the committed React Flow positions before paint. */
function RenderedLayout({ onLayout }: { onLayout: () => void }) {
  const nodes = useNodes();
  useLayoutEffect(onLayout, [nodes, onLayout]);
  return null;
}

/** Streaming conversation changes do not need to resubscribe/render the graph canvas. */
export const GraphCanvas = memo(function GraphCanvas({ runKey, ready, nodes, edges, nodeTypes, edgeTypes, tokens, onInit, onSelect, onLayout }: {
  runKey: string; ready: boolean; nodes: Node[]; edges: Edge[]; nodeTypes: NodeTypes; edgeTypes: EdgeTypes;
  tokens: { graphEdgeDefault: string; graphEdgeFeedback: string; graphGridDot: string };
  onInit: (instance: ReactFlowInstance, key: string) => void; onSelect: (id: string) => void; onLayout: () => void;
}) {
  // These are controlled nodes. React Flow reports measured dimensions via
  // onNodesChange; retain them when streamed edits/animation replace a node.
  // Dropping `measured` makes React Flow hide and re-measure the card each frame.
  const [measurements, setMeasurements] = useState({ key: runKey, sizes: new Map<string, { width: number; height: number }>() });
  const nodeIds = JSON.stringify(nodes.map(node => node.id));
  useEffect(() => {
    const ids = new Set<string>(JSON.parse(nodeIds));
    setMeasurements(previous => {
      if (previous.key === runKey && [...previous.sizes.keys()].every(id => ids.has(id))) return previous;
      return { key: runKey, sizes: new Map([...previous.sizes].filter(([id]) => previous.key === runKey && ids.has(id))) };
    });
  }, [runKey, nodeIds]);
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const dimensions = changes.filter(change => change.type === "dimensions" && change.dimensions);
    if (!dimensions.length) return;
    setMeasurements(previous => {
      const sizes = new Map(previous.key === runKey ? previous.sizes : []);
      let changed = previous.key !== runKey;
      for (const change of dimensions) {
        if (change.type !== "dimensions" || !change.dimensions) continue;
        const before = sizes.get(change.id);
        if (before?.width !== change.dimensions.width || before?.height !== change.dimensions.height) {
          sizes.set(change.id, change.dimensions);
          changed = true;
        }
      }
      return changed ? { key: runKey, sizes } : previous;
    });
  }, [runKey]);
  const measuredNodes = useMemo(() => nodes.map(node => {
    const measured = measurements.key === runKey ? measurements.sizes.get(node.id) : undefined;
    return measured ? { ...node, measured } : node;
  }), [nodes, measurements, runKey]);
  const initialize = useCallback((instance: ReactFlowInstance) => onInit(instance, runKey), [onInit, runKey]);
  const select = useCallback((_: React.MouseEvent, node: Node) => onSelect(node.id), [onSelect]);
  const clear = useCallback(() => onSelect(""), [onSelect]);
  return <>
    <svg style={{ position: "absolute", width: 0, height: 0, pointerEvents: "none" }} aria-hidden="true">
      <defs>
        <marker id="workflow-arrow-default" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto">
          <path d="M 2 2.5 L 10 6 L 2 9.5 Z" fill={tokens.graphEdgeDefault || "#94A3B8"} />
        </marker>
        <marker id="workflow-arrow-feedback" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto">
          <path d="M 2 2.5 L 10 6 L 2 9.5 Z" fill={tokens.graphEdgeFeedback || "#8B5CF6"} />
        </marker>
      </defs>
    </svg>
    <ReactFlow key={runKey} fitView fitViewOptions={graphFitOptions} onInit={initialize}
      style={{ opacity: ready ? 1 : 0, pointerEvents: ready ? "auto" : "none" }}
      nodes={measuredNodes} onNodesChange={onNodesChange} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodeClick={select} onPaneClick={clear} minZoom={0.3} maxZoom={1.6}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}>
      <RenderedLayout onLayout={onLayout} />
      <Background color={tokens.graphGridDot} gap={20} size={1} />
      <Controls showInteractive={false} fitViewOptions={graphFitOptions} />
    </ReactFlow>
  </>;
});
