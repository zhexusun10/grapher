import React from "react";
import { BaseEdge, getBezierPath, Position, type EdgeProps } from "@xyflow/react";

function workflowPath(sourceX: number, sourceY: number, targetX: number, targetY: number) {
  const bend = Math.max(18, Math.abs(targetY - sourceY) * 0.46);
  return [
    `M${sourceX},${sourceY} C${sourceX},${sourceY + bend} ${targetX},${targetY - bend} ${targetX},${targetY}`,
    (sourceX + targetX) / 2,
    (sourceY + targetY) / 2,
  ] as [string, number, number];
}

// An individual, rounded lane: leave and enter ONLY at the edge's card ports.
// No artificial branch/junction is created on the canvas.
function lanePath(sourceX: number, sourceY: number, targetX: number, targetY: number,
  laneX: number, sidePort: boolean): [string, number, number] {
  const direction = laneX < Math.min(sourceX, targetX) ? -1 : 1;
  if (sidePort) {
    const vertical = targetY >= sourceY ? 1 : -1;
    const radius = Math.min(18, Math.abs(targetY - sourceY) / 3);
    return [
      `M${sourceX},${sourceY} H${laneX - direction * radius} Q${laneX},${sourceY} ${laneX},${sourceY + vertical * radius}` +
      ` V${targetY - vertical * radius} Q${laneX},${targetY} ${laneX - direction * radius},${targetY} H${targetX}`,
      laneX,
      (sourceY + targetY) / 2,
    ];
  }
  const exitY = sourceY + 32;
  const enterY = targetY - 32;
  const vertical = enterY >= exitY ? 1 : -1;
  const radius = Math.min(16, Math.abs(enterY - exitY) / 3);
  return [
    `M${sourceX},${sourceY} V${exitY - radius} Q${sourceX},${exitY} ${sourceX + direction * radius},${exitY}` +
    ` H${laneX - direction * radius} Q${laneX},${exitY} ${laneX},${exitY + vertical * radius}` +
    ` V${enterY - vertical * radius} Q${laneX},${enterY} ${laneX - direction * radius},${enterY}` +
    ` H${targetX + direction * radius} Q${targetX},${enterY} ${targetX},${enterY + radius} V${targetY}`,
    laneX,
    (sourceY + targetY) / 2,
  ];
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
  const routeX = typeof data?.routeX === "number" ? data.routeX : undefined;
  const [path, labelX, labelY] = routeX !== undefined
    ? lanePath(sourceX, sourceY, targetX, targetY, routeX, !!data?.routeSide)
    : sourcePosition === Position.Bottom && targetPosition === Position.Top
      ? workflowPath(sourceX, sourceY, targetX, targetY)
      : getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      className={data?.isNew ? "edge-entering" : undefined}
      markerEnd={markerEnd || "url(#workflow-arrow-default)"}
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
