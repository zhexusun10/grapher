import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

const DEFAULT_WIDTH = 370;
const WIDTH_STORAGE_KEY = "grapher_pane_width";

function getStoredWidth(): number {
  try {
    const saved = localStorage.getItem(WIDTH_STORAGE_KEY);
    return saved ? Math.max(280, Math.min(800, Number(saved))) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/** Resize via a CSS variable so dragging does not re-render the workbench. */
export function useWorkbenchResizer() {
  const workbenchRef = useRef<HTMLDivElement>(null);
  const initialWidth = useRef(getStoredWidth()).current;
  const currentWidthRef = useRef(initialWidth);
  const [isResizing, setIsResizing] = useState(false);
  const removeDragListenersRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    workbenchRef.current?.style.setProperty("--workbench-left-width", `${currentWidthRef.current}px`);
    return () => removeDragListenersRef.current?.();
  }, []);

  const handleStartResize = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    removeDragListenersRef.current?.();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = currentWidthRef.current;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!workbenchRef.current) return;
      const rect = workbenchRef.current.getBoundingClientRect();
      const delta = moveEvent.clientX - startX;
      const clampedWidth = Math.max(280, Math.min(rect.width - 320, startWidth + delta));
      currentWidthRef.current = clampedWidth;
      workbenchRef.current.style.setProperty("--workbench-left-width", `${clampedWidth}px`);
    };

    const removeListeners = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      removeDragListenersRef.current = null;
    };
    const onMouseUp = () => {
      removeListeners();
      setIsResizing(false);
      try {
        localStorage.setItem(WIDTH_STORAGE_KEY, String(currentWidthRef.current));
      } catch {
        // ignore
      }
    };

    removeDragListenersRef.current = removeListeners;
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  const handleResetResizer = useCallback(() => {
    currentWidthRef.current = DEFAULT_WIDTH;
    workbenchRef.current?.style.setProperty("--workbench-left-width", `${DEFAULT_WIDTH}px`);
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(DEFAULT_WIDTH));
    } catch {
      // ignore
    }
  }, []);

  return { workbenchRef, isResizing, initialWidth, handleStartResize, handleResetResizer };
}
