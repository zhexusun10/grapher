import React, { memo, useCallback } from "react";
import { Background, Controls, ReactFlow, type ReactFlowInstance, type Node, type Edge, type NodeTypes, type EdgeTypes } from "@xyflow/react";

const fitOptions = { padding: 0.24, minZoom: 0.3, maxZoom: 1.6 };

/** Streaming conversation changes do not need to resubscribe/render the graph canvas. */
export const GraphCanvas = memo(function GraphCanvas({ runKey, ready, nodes, edges, nodeTypes, edgeTypes, tokens, onInit, onSelect }: {
  runKey: string; ready: boolean; nodes: Node[]; edges: Edge[]; nodeTypes: NodeTypes; edgeTypes: EdgeTypes;
  tokens: { graphEdgeDefault: string; graphEdgeFeedback: string; graphGridDot: string };
  onInit: (instance: ReactFlowInstance<any, any>, key: string) => void; onSelect: (id: string) => void;
}) {
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
    <ReactFlow key={runKey} fitView fitViewOptions={fitOptions} onInit={initialize}
      style={{ opacity: ready ? 1 : 0, pointerEvents: ready ? "auto" : "none" }}
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodeClick={select} onPaneClick={clear} minZoom={0.3} maxZoom={1.6}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}>
      <Background color={tokens.graphGridDot} gap={20} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  </>;
});
