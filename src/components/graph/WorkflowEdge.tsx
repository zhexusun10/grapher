import React from "react";
import { BaseEdge, getBezierPath, Position, type EdgeProps } from "@xyflow/react";

export const SmoothWorkflowEdge = React.memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition = Position.Bottom,
  targetPosition = Position.Top,
  style,
  markerEnd,
  markerStart,
  label,
  labelStyle,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  interactionWidth,
}: EdgeProps) => {
  let path: string;
  let labelX: number;
  let labelY: number;

  if (sourcePosition === Position.Bottom && targetPosition === Position.Top && targetY > sourceY) {
    const dy = targetY - sourceY;
    const lead = Math.min(26, Math.max(16, dy * 0.22));
    const p1Y = sourceY + lead;
    const p2Y = targetY - lead;
    const midY = (p1Y + p2Y) / 2;

    path = `M ${sourceX},${sourceY} L ${sourceX},${p1Y} C ${sourceX},${midY} ${targetX},${midY} ${targetX},${p2Y} L ${targetX},${targetY}`;
    labelX = (sourceX + targetX) / 2;
    labelY = midY;
  } else {
    const [p, lx, ly] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
    path = p;
    labelX = lx;
    labelY = ly;
  }

  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      markerEnd={markerEnd}
      markerStart={markerStart}
      label={label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={labelStyle}
      labelShowBg={!!label}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
      interactionWidth={interactionWidth ?? 24}
    />
  );
});

SmoothWorkflowEdge.displayName = "SmoothWorkflowEdge";
