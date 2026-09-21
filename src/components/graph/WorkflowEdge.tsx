import React from "react";
import { BaseEdge, getBezierPath, Position, type EdgeProps } from "@xyflow/react";

function getStraightEntryPath({
  sourceX,
  sourceY,
  targetX,
  targetY,
  leadIn = 20,
}: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  leadIn?: number;
}): [string, number, number] {
  if (sourceX === targetX) {
    return [
      `M${sourceX},${sourceY} L${targetX},${targetY}`,
      sourceX,
      (sourceY + targetY) / 2,
    ];
  }

  // 保证终点前有一段纯垂直段，使得连线从正上方垂直扎入箭头中心，多条依赖线在此汇合
  const effectiveLeadIn = Math.min(leadIn, Math.max(10, (targetY - sourceY) * 0.3));
  const midY = targetY - effectiveLeadIn;
  const cY1 = sourceY + (midY - sourceY) * 0.45;
  const cY2 = midY - (midY - sourceY) * 0.15;

  const path = `M${sourceX},${sourceY} C${sourceX},${cY1} ${targetX},${cY2} ${targetX},${midY} L${targetX},${targetY}`;
  const labelX = (sourceX + targetX) / 2;
  const labelY = (sourceY + midY) / 2;

  return [path, labelX, labelY];
}

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
  data,
}: EdgeProps) => {
  const isStandardTop = targetPosition === Position.Top && sourcePosition === Position.Bottom;
  const [path, labelX, labelY] = isStandardTop
    ? getStraightEntryPath({ sourceX, sourceY, targetX, targetY })
    : getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
      });

  const effectiveMarkerEnd = markerEnd || "url(#workflow-arrow-default)";

  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      className={data?.isNew ? "edge-entering" : undefined}
      markerEnd={effectiveMarkerEnd}
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
