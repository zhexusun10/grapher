import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { runtimeService } from "../services/runtime";
import { notifyTranscriptContentGrowth } from "../services/transcriptScroll";
import { t } from "../i18n";

type ImageScope = { runId: string; executionId?: string };
const WorkspaceImageScope = createContext<ImageScope | null>(null);

export function WorkspaceImageProvider({ runId, executionId, children }: ImageScope & { children: ReactNode }) {
  const scope = useMemo(() => ({ runId, executionId }), [runId, executionId]);
  return <WorkspaceImageScope.Provider value={scope}>{children}</WorkspaceImageScope.Provider>;
}

/** Hydrate only sanitized, inert local image placeholders. URLs belong to the
 * mounted Markdown, not the HTML/parse cache, and are revoked on scope changes. */
export function useWorkspaceImages(root: RefObject<HTMLDivElement | null>, html: string): string {
  const scope = useContext(WorkspaceImageScope);
  const runId = scope?.runId;
  const executionId = scope?.executionId;
  const resources = useRef<{
    abort: AbortController; pending: Map<string, Promise<string>>; urls: string[];
  } | null>(null);

  useEffect(() => {
    const store = { abort: new AbortController(), pending: new Map<string, Promise<string>>(), urls: [] as string[] };
    resources.current = store;
    return () => {
      store.abort.abort();
      for (const url of store.urls) URL.revokeObjectURL(url);
      resources.current = null;
    };
  }, [runId, executionId]);

  useEffect(() => {
    const store = resources.current;
    const container = root.current;
    if (!store || !container) return;
    let disposed = false;
    const failed = (image: HTMLImageElement) => {
      if (disposed || !container.contains(image)) return;
      const fallback = document.createElement("span");
      fallback.className = "markdown-image-error";
      fallback.setAttribute("role", "img");
      fallback.textContent = `${t("无法加载图片")} · ${image.alt || image.dataset.workspacePath || ""}`;
      fallback.setAttribute("aria-label", fallback.textContent);
      image.replaceWith(fallback);
      notifyTranscriptContentGrowth(container);
    };
    for (const image of container.querySelectorAll<HTMLImageElement>("img")) {
      image.onload = () => notifyTranscriptContentGrowth(container);
      image.onerror = () => failed(image);
      if (!image.dataset.workspacePath) continue;
      if (!runId) { failed(image); continue; }
      const path = image.dataset.workspacePath!;
      let pending = store.pending.get(path);
      if (!pending) {
        pending = runtimeService.getWorkspaceImage(runId, path, executionId, store.abort.signal).then(blob => {
          if (store.abort.signal.aborted) throw new Error("Image scope retired");
          const url = URL.createObjectURL(blob);
          store.urls.push(url);
          return url;
        });
        store.pending.set(path, pending);
      }
      if (!image.getAttribute("src")) image.setAttribute("aria-busy", "true");
      pending.then(url => {
        if (disposed || store.abort.signal.aborted || !container.contains(image)) return;
        if (image.getAttribute("src") === url) {
          image.removeAttribute("aria-busy");
          return;
        }
        image.onload = () => {
          image.removeAttribute("aria-busy");
          notifyTranscriptContentGrowth(container);
        };
        image.onerror = () => failed(image);
        image.src = url;
      }).catch(() => failed(image));
    }
    return () => { disposed = true; };
  }, [root, html, runId, executionId]);
  // Replace the DOM too when scope changes: an old blob/failure placeholder
  // must never remain visible while another conversation's image loads.
  return JSON.stringify([runId, executionId]);
}
