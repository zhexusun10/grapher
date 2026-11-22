/**
 * Utilities for HTML5 file drag-and-drop across WebKit (macOS WKWebView),
 * WebView2 (Windows), and standard desktop browsers.
 */

export interface DragDataTransferItemLike {
  kind?: string;
  getAsFile?: () => File | null;
  webkitGetAsEntry?: () => { isDirectory?: boolean; isFile?: boolean } | null;
}

export interface DragDataTransferLike {
  types?: ArrayLike<string> | Iterable<string> | null;
  items?: ArrayLike<DragDataTransferItemLike> | null;
  files?: ArrayLike<File> | null;
  dropEffect?: DataTransfer["dropEffect"];
}

export interface DroppedFilesResult {
  files: File[];
  skippedDirectories: number;
}

export function hasDraggedFiles(dataTransfer: DragDataTransferLike | null | undefined): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.types) {
    const types = Array.from(dataTransfer.types);
    if (types.includes("Files")) return true;
  }
  if (dataTransfer.items) {
    for (let i = 0; i < dataTransfer.items.length; i += 1) {
      if (dataTransfer.items[i]?.kind === "file") return true;
    }
  }
  return (dataTransfer.files?.length ?? 0) > 0;
}

export function extractDroppedFiles(dataTransfer: DragDataTransferLike | null | undefined): DroppedFilesResult {
  if (!dataTransfer) return { files: [], skippedDirectories: 0 };
  const files: File[] = [];
  let skippedDirectories = 0;

  if (dataTransfer.items && dataTransfer.items.length > 0) {
    for (let i = 0; i < dataTransfer.items.length; i += 1) {
      const item = dataTransfer.items[i];
      if (item?.kind !== "file") continue;
      const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
      if (entry?.isDirectory) {
        skippedDirectories += 1;
        continue;
      }
      if (typeof item.getAsFile === "function") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0 || skippedDirectories > 0) {
      return { files, skippedDirectories };
    }
  }

  if (dataTransfer.files && dataTransfer.files.length > 0) {
    for (let i = 0; i < dataTransfer.files.length; i += 1) {
      const file = dataTransfer.files[i];
      if (file) files.push(file);
    }
  }

  return { files, skippedDirectories };
}

export function getFirstDroppedFile(dataTransfer: DragDataTransferLike | null | undefined): File | null {
  return extractDroppedFiles(dataTransfer).files[0] ?? null;
}

/**
 * Prevents the WebView / browser from navigating to a dropped file URL when a
 * file is dropped outside an explicit drop target (such as the composer).
 *
 * Uses bubble-phase listeners so component drop zones handle the drag first and
 * stop propagation before this fallback runs.
 */
export function installWindowFileDropGuard(
  targetWindow: Pick<Window, "addEventListener" | "removeEventListener"> | null =
    typeof window !== "undefined" ? window : null,
): () => void {
  if (!targetWindow) return () => {};

  const onDragOver = (event: DragEvent) => {
    if (event.defaultPrevented || !hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "none";
    }
  };

  const onDrop = (event: DragEvent) => {
    if (event.defaultPrevented || !hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
  };

  targetWindow.addEventListener("dragover", onDragOver);
  targetWindow.addEventListener("drop", onDrop);
  return () => {
    targetWindow.removeEventListener("dragover", onDragOver);
    targetWindow.removeEventListener("drop", onDrop);
  };
}
