import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { runtimeService } from "../services/runtime";
import { notifyTranscriptContentGrowth } from "../services/transcriptScroll";
import { t } from "../i18n";

type ImageScope = { runId: string; executionId?: string };
const WorkspaceImageScope = createContext<ImageScope | null>(null);

interface ImageResource {
  abort: AbortController;
  pending: Promise<string>;
  url?: string;
}

function releaseImage(resource: ImageResource) {
  resource.abort.abort();
  if (resource.url) URL.revokeObjectURL(resource.url);
}

export function WorkspaceImageProvider({ runId, executionId, children }: ImageScope & { children: ReactNode }) {
  const scope = useMemo(() => ({ runId, executionId }), [runId, executionId]);
  return <WorkspaceImageScope.Provider value={scope}>{children}</WorkspaceImageScope.Provider>;
}

/** Hydrate only sanitized, inert local image placeholders. URLs belong to the
 * mounted Markdown, not the HTML/parse cache, and are revoked when no longer used. */
export function useWorkspaceImages(root: RefObject<HTMLDivElement | null>, html: string): string {
  const scope = useContext(WorkspaceImageScope);
  const runId = scope?.runId;
  const executionId = scope?.executionId;
  const resources = useRef<{ entries: Map<string, ImageResource> } | null>(null);

  useEffect(() => {
    const store = { entries: new Map<string, ImageResource>() };
    resources.current = store;
    return () => {
      for (const resource of store.entries.values()) releaseImage(resource);
      store.entries.clear();
      resources.current = null;
    };
  }, [runId, executionId]);

  useEffect(() => {
    const store = resources.current;
    const container = root.current;
    if (!store || !container) return;
    const paths = new Set(Array.from(container.querySelectorAll<HTMLElement>("[data-workspace-path]"),
      element => element.dataset.workspacePath));
    for (const [path, resource] of store.entries) {
      if (paths.has(path)) continue;
      store.entries.delete(path);
      releaseImage(resource);
    }
    let disposed = false;
    const failed = (image: HTMLImageElement) => {
      if (disposed || !container.contains(image)) return;
      const fallback = document.createElement("span");
      fallback.className = "markdown-image-error";
      // Keep failed paths referenced while their fallback remains mounted.
      if (image.dataset.workspacePath) fallback.dataset.workspacePath = image.dataset.workspacePath;
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
      let resource = store.entries.get(path);
      if (!resource) {
        const abort = new AbortController();
        const entry: ImageResource = {
          abort,
          pending: runtimeService.getWorkspaceImage(runId, path, executionId, abort.signal).then(blob => {
            if (abort.signal.aborted || store.entries.get(path) !== entry) throw new Error("Image retired");
            entry.url = URL.createObjectURL(blob);
            return entry.url;
          }),
        };
        resource = entry;
        store.entries.set(path, entry);
      }
      if (!image.getAttribute("src")) image.setAttribute("aria-busy", "true");
      resource.pending.then(url => {
        if (disposed || resource.abort.signal.aborted || !container.contains(image)) return;
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
