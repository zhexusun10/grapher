import React, { useEffect, useMemo, useRef } from "react";
import { StreamingMarkdownCache } from "../services/streamingMarkdown";
import { t } from "../i18n";

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
    const cache = useRef<StreamingMarkdownCache | null>(null);
    const copyTimers = useRef(new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>());
    const copyLabel = t("复制到剪贴板");
    if (!cache.current) cache.current = new StreamingMarkdownCache();
    useEffect(() => () => {
      for (const timer of copyTimers.current.values()) clearTimeout(timer);
      copyTimers.current.clear();
    }, []);

    const sanitizedHtml = useMemo(() => {
      try {
        const rendered = cache.current!.render(content, isStreaming);
        const html = isStreaming && streamingCursor
          ? injectStreamingCursor(rendered, '<span class="thinking-streaming-cursor"></span>')
          : rendered;
        return addCodeCopyButtons(html, copyLabel);
      } catch (err) {
        console.error("Markdown parse error:", err);
        const fallback = `<p>${escapeHtml(content)}</p>`;
        return isStreaming && streamingCursor
          ? injectStreamingCursor(fallback, '<span class="thinking-streaming-cursor"></span>')
          : fallback;
      }
    }, [content, isStreaming, streamingCursor, copyLabel]);

    const handleCopy = async (event: React.MouseEvent) => {
      const target = event.target;
      const copyBtn = target instanceof Element ? target.closest<HTMLButtonElement>("button.code-copy-btn") : null;
      if (!copyBtn || !event.currentTarget.contains(copyBtn)) return;
      const codeBlock = copyBtn.closest(".code-block-wrapper")?.querySelector("pre code");
      if (!codeBlock) return;
      event.preventDefault();
      event.stopPropagation();

      try {
        await navigator.clipboard.writeText(codeBlock.textContent || "");
        if (!copyBtn.isConnected) return;
        clearTimeout(copyTimers.current.get(copyBtn));
        copyBtn.classList.add("copied");
        copyBtn.title = t("已复制");
        copyBtn.setAttribute("aria-label", t("已复制"));
        copyTimers.current.set(copyBtn, setTimeout(() => {
          copyBtn.classList.remove("copied");
          copyBtn.title = copyLabel;
          copyBtn.setAttribute("aria-label", copyLabel);
          copyTimers.current.delete(copyBtn);
        }, 1800));
      } catch (error) {
        console.warn("Copy code failed:", error);
      }
    };

    return (
      <div
        className={`markdown-content ${isStreaming ? "streaming" : ""} ${className}`}
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
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
    `<div class="code-block-wrapper">${block}<button type="button" class="code-copy-btn" title="${escapedLabel}" aria-label="${escapedLabel}">` +
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
