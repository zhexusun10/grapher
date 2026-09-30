import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

export const DEFAULT_SPLIT_RATIO = 0.6;
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;

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
    const minRightWidth = 320;
    const minRatio = Math.min(0.5, Math.max(MIN_SPLIT_RATIO, minLeftWidth / containerWidth));
    const maxRatio = Math.max(0.5, Math.min(MAX_SPLIT_RATIO, (containerWidth - minRightWidth) / containerWidth));
    return Math.max(minRatio, Math.min(maxRatio, ratio));
  }
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
}

/** Resize via CSS variable percentage so dragging does not trigger React re-renders, while maintaining split ratio across container resizing. */
export function useWorkbenchResizer() {
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

  const handleStartResize = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    removeDragListenersRef.current?.();
    setIsResizing(true);

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!workbenchRef.current) return;
      const rect = workbenchRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;

      const pointerX = moveEvent.clientX - rect.left;
      const clampedRatio = clampSplitRatio(pointerX / rect.width, rect.width);
      currentRatioRef.current = clampedRatio;
      workbenchRef.current.style.setProperty("--workbench-split-ratio", String(clampedRatio));
      workbenchRef.current.style.setProperty("--workbench-left-width", `${clampedRatio * 100}%`);
    };

    const removeListeners = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      removeDragListenersRef.current = null;
    };

    const onMouseUp = () => {
      removeListeners();
      setIsResizing(false);
      const finalRatio = currentRatioRef.current;
      setSplitRatio(finalRatio);
      persistRatio(finalRatio);
    };

    removeDragListenersRef.current = removeListeners;
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

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
    handleResetResizer,
  };
}
