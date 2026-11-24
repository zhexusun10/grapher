import React, { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { StreamingMarkdownCache } from "../services/streamingMarkdown";
import { observeElementResize } from "../services/sharedResizeObserver";
import { copyTextToClipboard } from "../services/externalLink";
import { t } from "../i18n";
import { useWorkspaceImages } from "./WorkspaceImages";

function syncCodeBlockOverflow(container: HTMLElement): void {
  const wrappers = container.querySelectorAll<HTMLElement>(".code-block-wrapper");
  if (!wrappers.length) return;
  const updates: Array<[HTMLElement, boolean]> = [];
  for (const wrapper of wrappers) {
    const pre = wrapper.querySelector<HTMLElement>("pre");
    if (!pre) continue;
    const overflows = pre.clientWidth > 0 && pre.scrollWidth > pre.clientWidth + 1;
    const had = wrapper.getAttribute("data-overflow-x") === "true";
    if (overflows !== had) updates.push([wrapper, overflows]);
  }
  for (const [wrapper, overflows] of updates) {
    if (overflows) wrapper.setAttribute("data-overflow-x", "true");
    else wrapper.removeAttribute("data-overflow-x");
  }
}

function syncMarkdownDom(container: HTMLElement, html: string, prevKeys: string[]): string[] {
  const template = document.createElement("template");
  template.innerHTML = html;
  const incoming = Array.from(template.content.childNodes);
  const nextKeys = incoming.map(node =>
    node.nodeType === 1 ? (node as Element).outerHTML : `\0${node.nodeType}:${node.textContent ?? ""}`
  );
  // Keep unchanged leading top-level blocks mounted across streaming updates so
  // settled paragraphs, loaded images and text selection are never torn down.
  let prefix = 0;
  const limit = Math.min(prevKeys.length, nextKeys.length, container.childNodes.length);
  while (prefix < limit && prevKeys[prefix] === nextKeys[prefix]) prefix++;
  while (container.childNodes.length > prefix) container.removeChild(container.lastChild!);
  if (prefix < incoming.length) {
    const fragment = document.createDocumentFragment();
    for (let i = prefix; i < incoming.length; i++) fragment.appendChild(incoming[i]);
    container.appendChild(fragment);
  }
  return nextKeys;
}

type DomSyncState =
  | { mode: "raw"; keys: string[] }
  | { mode: "blocks"; blocks: string[]; counts: number[] };

function syncMarkdownBlocks(
  container: HTMLElement,
  nextBlocks: string[],
  prev: DomSyncState,
): DomSyncState {
  const prevBlocks = prev.mode === "blocks" ? prev.blocks : [];
  const prevCounts = prev.mode === "blocks" ? prev.counts : [];
  let prefix = 0;
  let keepNodes = 0;
  const maxPrefix = Math.min(prevBlocks.length, nextBlocks.length);
  while (prefix < maxPrefix && prevBlocks[prefix] === nextBlocks[prefix]) {
    keepNodes += prevCounts[prefix];
    prefix++;
  }
  if (container.childNodes.length < keepNodes) {
    prefix = 0;
    keepNodes = 0;
  }
  while (container.childNodes.length > keepNodes) {
    container.removeChild(container.lastChild!);
  }
  const counts = prevCounts.slice(0, prefix);
  if (prefix < nextBlocks.length) {
    const template = document.createElement("template");
    const fragment = document.createDocumentFragment();
    for (let i = prefix; i < nextBlocks.length; i++) {
      template.innerHTML = nextBlocks[i];
      counts.push(template.content.childNodes.length);
      fragment.appendChild(template.content);
    }
    container.appendChild(fragment);
  }
  return { mode: "blocks", blocks: nextBlocks, counts };
}

const STREAMING_CURSOR_TAG_RE = /<\/(?:p|li|code|h[1-6]|blockquote|td)>/i;

function injectCursorIntoBlocks(blocks: string[], cursorHtml: string): string[] {
  if (blocks.length === 0) return [cursorHtml];
  const next = blocks.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (STREAMING_CURSOR_TAG_RE.test(next[i])) {
      next[i] = injectStreamingCursor(next[i], cursorHtml);
      return next;
    }
  }
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].includes("</")) {
      next[i] = injectStreamingCursor(next[i], cursorHtml);
      return next;
    }
  }
  next[next.length - 1] += cursorHtml;
  return next;
}
interface MarkdownRendererProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
  streamingCursor?: boolean;
}

export function injectStreamingCursor(html: string, cursorHtml: string): string {
  if (!html) return cursorHtml;
  const regex = /<\/(?:p|li|code|h[1-6]|blockquote|td)>/gi;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    lastMatch = m;
  }
  if (lastMatch) {
    return html.slice(0, lastMatch.index) + cursorHtml + html.slice(lastMatch.index);
  }
  const lastClose = html.lastIndexOf("</");
  if (lastClose !== -1) {
    return html.slice(0, lastClose) + cursorHtml + html.slice(lastClose);
  }
  return html + cursorHtml;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(
  ({ content, className = "", isStreaming = false, streamingCursor = false }) => {
    const root = useRef<HTMLDivElement>(null);
    const cache = useRef<StreamingMarkdownCache | null>(null);
    const copyTimers = useRef(new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>());
    const copyLabel = t("复制到剪贴板");
    const decoratedCodeBlocksRef = useRef<{ label: string; map: Map<string, string> }>({
      label: "",
      map: new Map(),
    });
    if (!cache.current) cache.current = new StreamingMarkdownCache();
    useEffect(() => () => {
      for (const timer of copyTimers.current.values()) clearTimeout(timer);
      copyTimers.current.clear();
    }, []);

    const renderedResult = useMemo(() => {
      const cursorHtml = '<span class="thinking-streaming-cursor"></span>';
      try {
        const { html: rendered, blocks } = cache.current!.renderBlocks(content, isStreaming);
        if (blocks !== null) {
          const withCursor = isStreaming && streamingCursor
            ? injectCursorIntoBlocks(blocks, cursorHtml)
            : blocks;
          const prevMap = decoratedCodeBlocksRef.current.label === copyLabel
            ? decoratedCodeBlocksRef.current.map
            : null;
          const nextMap = new Map<string, string>();
          const decoratedBlocks = withCursor.map(block => {
            if (!block.includes("<pre")) return block;
            const cached = prevMap?.get(block);
            const decorated = cached ?? addCodeCopyButtons(block, copyLabel);
            nextMap.set(block, decorated);
            return decorated;
          });
          decoratedCodeBlocksRef.current = { label: copyLabel, map: nextMap };
          return { html: decoratedBlocks.join(""), blocks: decoratedBlocks };
        }
        decoratedCodeBlocksRef.current = { label: copyLabel, map: new Map() };
        const html = isStreaming && streamingCursor
          ? injectStreamingCursor(rendered, cursorHtml)
          : rendered;
        return { html: addCodeCopyButtons(html, copyLabel), blocks: null };
      } catch (err) {
        console.error("Markdown parse error:", err);
        const fallback = `<p>${escapeHtml(content)}</p>`;
        const html = isStreaming && streamingCursor
          ? injectStreamingCursor(fallback, cursorHtml)
          : fallback;
        return { html, blocks: [html] };
      }
    }, [content, isStreaming, streamingCursor, copyLabel]);
    const sanitizedHtml = renderedResult.html;

    const imageScopeKey = useWorkspaceImages(root, sanitizedHtml);
    const hasCodeBlocks = sanitizedHtml.includes("code-block-wrapper");
    const domSyncRef = useRef<DomSyncState>({ mode: "blocks", blocks: [], counts: [] });
    const lastContainerRef = useRef<HTMLDivElement | null>(null);

    useLayoutEffect(() => {
      const container = root.current;
      if (!container) return;
      if (lastContainerRef.current !== container) {
        lastContainerRef.current = container;
        domSyncRef.current = { mode: "blocks", blocks: [], counts: [] };
      }
      if (renderedResult.blocks !== null) {
        domSyncRef.current = syncMarkdownBlocks(container, renderedResult.blocks, domSyncRef.current);
      } else {
        const prevKeys = domSyncRef.current.mode === "raw" ? domSyncRef.current.keys : [];
        domSyncRef.current = { mode: "raw", keys: syncMarkdownDom(container, sanitizedHtml, prevKeys) };
      }
      if (hasCodeBlocks) syncCodeBlockOverflow(container);
    }, [renderedResult, sanitizedHtml, imageScopeKey, hasCodeBlocks]);

    useEffect(() => {
      if (!hasCodeBlocks) return;
      const container = root.current;
      if (!container) return;
      return observeElementResize(container, () => syncCodeBlockOverflow(container));
    }, [hasCodeBlocks, imageScopeKey]);

    const handleCopy = async (event: React.MouseEvent) => {
      const target = event.target;
      const copyBtn = target instanceof Element ? target.closest<HTMLButtonElement>("button.code-copy-btn") : null;
      if (!copyBtn || !event.currentTarget.contains(copyBtn)) return;
      const codeBlock = copyBtn.closest(".code-block-wrapper")?.querySelector("pre code");
      if (!codeBlock) return;
      event.preventDefault();
      event.stopPropagation();

      try {
        if (!await copyTextToClipboard(codeBlock.textContent || "")) return;
        if (!copyBtn.isConnected) return;
        clearTimeout(copyTimers.current.get(copyBtn));
        copyBtn.classList.add("copied");
        copyBtn.setAttribute("aria-label", t("已复制"));
        copyTimers.current.set(copyBtn, setTimeout(() => {
          copyBtn.classList.remove("copied");
          copyBtn.setAttribute("aria-label", copyLabel);
          copyTimers.current.delete(copyBtn);
        }, 1800));
      } catch (error) {
        console.warn("Copy code failed:", error);
      }
    };

    const ssrHtml = typeof document === "undefined" ? { dangerouslySetInnerHTML: { __html: sanitizedHtml } } : {};

    return (
      <div key={imageScopeKey} ref={root}
        className={`markdown-content ${isStreaming ? "streaming" : ""} ${className}`}
        {...ssrHtml}
        onClick={handleCopy}
      />
    );
  }
);

MarkdownRenderer.displayName = "MarkdownRenderer";

function addCodeCopyButtons(html: string, label: string): string {
  const escapedLabel = escapeHtml(label);
  // Decorate parsed block code only; leave inline code and cached Markdown HTML unchanged.
  return html.replace(/<pre\b[^>]*>\s*<code\b[^>]*>[\s\S]*?<\/code>\s*<\/pre>/gi, block =>
    `<div class="code-block-wrapper">${block}<button type="button" class="code-copy-btn" aria-label="${escapedLabel}">` +
    '<svg class="code-copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>' +
    '<svg class="code-copy-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m5 12 4 4L19 6"/></svg></button></div>');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export default MarkdownRenderer;
