import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useStableCallback } from "./useStableCallback";

export const DEFAULT_SPLIT_RATIO = 0.6;
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;
export const GRAPH_COLLAPSE_OVERSHOOT_PX = 48;
const MIN_GRAPH_PANE_WIDTH = 320;

export const SPLIT_RATIO_STORAGE_KEY = "grapher_workbench_split_ratio";
export const LEGACY_WIDTH_STORAGE_KEY = "grapher_pane_width";

export function getStoredRatio(storage?: Pick<Storage, "getItem">): number {
  const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  if (!store) return DEFAULT_SPLIT_RATIO;
  try {
    const savedRatio = store.getItem(SPLIT_RATIO_STORAGE_KEY);
    if (savedRatio !== null) {
      const parsed = parseFloat(savedRatio);
      if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) {
        return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, parsed));
      }
    }
    const savedWidth = store.getItem(LEGACY_WIDTH_STORAGE_KEY);
    if (savedWidth !== null) {
      const parsedWidth = parseFloat(savedWidth);
      if (Number.isFinite(parsedWidth) && parsedWidth > 0) {
        const estimatedRatio = parsedWidth / 1200;
        return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, estimatedRatio));
      }
    }
  } catch {
    // ignore storage access errors
  }
  return DEFAULT_SPLIT_RATIO;
}

export function persistRatio(ratio: number, storage?: Pick<Storage, "setItem">): void {
  const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  if (!store) return;
  try {
    store.setItem(SPLIT_RATIO_STORAGE_KEY, String(ratio));
    store.setItem(LEGACY_WIDTH_STORAGE_KEY, String(Math.round(ratio * 1200)));
  } catch {
    // ignore storage access errors
  }
}

export function clampSplitRatio(ratio: number, containerWidth?: number): number {
  if (containerWidth && containerWidth > 0) {
    const minLeftWidth = 280;
    const minRightWidth = MIN_GRAPH_PANE_WIDTH;
    const minRatio = Math.min(0.5, Math.max(MIN_SPLIT_RATIO, minLeftWidth / containerWidth));
    const maxRatio = Math.max(0.5, Math.min(MAX_SPLIT_RATIO, (containerWidth - minRightWidth) / containerWidth));
    return Math.max(minRatio, Math.min(maxRatio, ratio));
  }
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
}

/** Require deliberate overshoot past the actual minimum graph width. */
export function shouldCollapseGraphPane(pointerX: number, containerWidth: number): boolean {
  if (!Number.isFinite(pointerX) || !Number.isFinite(containerWidth) || containerWidth <= 0) return false;
  // Match .conversation-pane.split's CSS max-width even in a narrow window,
  // where its 320px graph minimum takes precedence over a balanced 50/50 split.
  const boundary = Math.min(MAX_SPLIT_RATIO * containerWidth, Math.max(0, containerWidth - MIN_GRAPH_PANE_WIDTH));
  return pointerX >= boundary + GRAPH_COLLAPSE_OVERSHOOT_PX;
}

/** Resize via CSS variable percentage so dragging does not trigger React re-renders, while maintaining split ratio across container resizing. */
export function useWorkbenchResizer({ onCollapse }: { onCollapse?: () => void } = {}) {
  const collapse = useStableCallback(() => onCollapse?.());
  const workbenchRef = useRef<HTMLDivElement>(null);
  const [splitRatio, setSplitRatio] = useState<number>(getStoredRatio);
  const currentRatioRef = useRef(splitRatio);
  const [isResizing, setIsResizing] = useState(false);
  const removeDragListenersRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    if (workbenchRef.current) {
      workbenchRef.current.style.setProperty("--workbench-split-ratio", String(currentRatioRef.current));
      workbenchRef.current.style.setProperty("--workbench-left-width", `${currentRatioRef.current * 100}%`);
    }
    return () => removeDragListenersRef.current?.();
  }, []);

  const applyRatio = useCallback((ratio: number) => {
    currentRatioRef.current = ratio;
    workbenchRef.current?.style.setProperty("--workbench-split-ratio", String(ratio));
    workbenchRef.current?.style.setProperty("--workbench-left-width", `${ratio * 100}%`);
  }, []);

  const handleStartResize = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    removeDragListenersRef.current?.();
    const startRatio = currentRatioRef.current;
    const pointerId = e.pointerId;
    setIsResizing(true);

    const finish = (restore: boolean) => {
      removeListeners();
      setIsResizing(false);
      // Collapsing is not a saved resize: reopening restores the useful width
      // from before this gesture rather than leaving the graph at its minimum.
      if (restore) applyRatio(startRatio);
      const finalRatio = currentRatioRef.current;
      setSplitRatio(finalRatio);
      if (!restore) persistRatio(finalRatio);
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId || !workbenchRef.current) return;
      const rect = workbenchRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pointerX = moveEvent.clientX - rect.left;
      if (onCollapse && shouldCollapseGraphPane(pointerX, rect.width)) {
        finish(true);
        collapse();
        return;
      }
      applyRatio(clampSplitRatio(pointerX / rect.width, rect.width));
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId === pointerId) finish(false);
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId === pointerId) finish(true);
    };
    const onBlur = () => finish(false);
    const removeListeners = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onBlur);
      removeDragListenersRef.current = null;
    };

    removeDragListenersRef.current = removeListeners;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("blur", onBlur);
  }, [applyRatio, collapse, onCollapse]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent) => {
    const width = workbenchRef.current?.getBoundingClientRect().width;
    if (!width) return;
    if (event.key === "Enter" && onCollapse) {
      event.preventDefault();
      collapse();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const ratio = event.key === "Home" ? 0 : event.key === "End" ? 1
      : currentRatioRef.current + (event.key === "ArrowRight" ? 24 : -24) / width;
    const next = clampSplitRatio(ratio, width);
    applyRatio(next);
    setSplitRatio(next);
    persistRatio(next);
  }, [applyRatio, collapse, onCollapse]);

  const handleResetResizer = useCallback(() => {
    currentRatioRef.current = DEFAULT_SPLIT_RATIO;
    setSplitRatio(DEFAULT_SPLIT_RATIO);
    if (workbenchRef.current) {
      workbenchRef.current.style.setProperty("--workbench-split-ratio", String(DEFAULT_SPLIT_RATIO));
      workbenchRef.current.style.setProperty("--workbench-left-width", `${DEFAULT_SPLIT_RATIO * 100}%`);
    }
    persistRatio(DEFAULT_SPLIT_RATIO);
  }, []);

  return {
    workbenchRef,
    isResizing,
    splitRatio,
    initialWidth: Math.round(splitRatio * 1200),
    handleStartResize,
    handleResizeKeyDown,
    handleResetResizer,
  };
}
