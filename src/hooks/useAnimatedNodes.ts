import { useState, useRef, useEffect } from "react";
import { type Node } from "@xyflow/react";

const ANIMATION_DURATION_MS = 400;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function useAnimatedNodes<T extends Node<any, any>>(targetNodes: T[]): T[] {
  const [renderedNodes, setRenderedNodes] = useState<T[]>(targetNodes);
  const currentPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const animationFrameRef = useRef<number | null>(null);
  const targetNodesRef = useRef<T[]>(targetNodes);
  targetNodesRef.current = targetNodes;

  useEffect(() => {
    const currentPositions = currentPositionsRef.current;
    let hasMovedNodes = false;
    const startPositions = new Map<string, { x: number; y: number }>();
    const destPositions = new Map<string, { x: number; y: number }>();

    for (const node of targetNodes) {
      const currentPos = currentPositions.get(node.id);
      destPositions.set(node.id, { x: node.position.x, y: node.position.y });

      if (currentPos) {
        startPositions.set(node.id, { ...currentPos });
        if (
          Math.abs(currentPos.x - node.position.x) > 1 ||
          Math.abs(currentPos.y - node.position.y) > 1
        ) {
          hasMovedNodes = true;
        }
      } else {
        // 新节点直接在目标位置初始化，触发节点本身的入场动画（nodeAppear）
        currentPositions.set(node.id, { x: node.position.x, y: node.position.y });
        startPositions.set(node.id, { x: node.position.x, y: node.position.y });
      }
    }

    // 清理已删除的节点
    for (const id of Array.from(currentPositions.keys())) {
      if (!destPositions.has(id)) {
        currentPositions.delete(id);
      }
    }

    // 如果没有已有节点位移，直接同步最新的数据与属性
    if (!hasMovedNodes) {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      setRenderedNodes(targetNodes);
      return;
    }

    // 存在已有节点位移，启动 requestAnimationFrame 平滑插值动画
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    const startTime = performance.now();

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / ANIMATION_DURATION_MS);
      const factor = easeOutCubic(progress);

      const latestTargets = targetNodesRef.current;
      const nextRendered = latestTargets.map((node) => {
        const start = startPositions.get(node.id);
        const dest = destPositions.get(node.id) ?? { x: node.position.x, y: node.position.y };

        if (!start) {
          currentPositions.set(node.id, { x: node.position.x, y: node.position.y });
          return node;
        }

        const interpolatedX = Math.round(start.x + (dest.x - start.x) * factor);
        const interpolatedY = Math.round(start.y + (dest.y - start.y) * factor);

        currentPositions.set(node.id, { x: interpolatedX, y: interpolatedY });

        return {
          ...node,
          position: {
            x: interpolatedX,
            y: interpolatedY,
          },
        };
      });

      setRenderedNodes(nextRendered);

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(step);
      } else {
        animationFrameRef.current = null;
        // 动画结束，确保最终坐标精确对齐
        setRenderedNodes(latestTargets);
      }
    };

    animationFrameRef.current = requestAnimationFrame(step);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [targetNodes]);

  return renderedNodes;
}
