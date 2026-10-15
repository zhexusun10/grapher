import React, { useMemo, useRef } from "react";
import { StreamingMarkdownCache } from "../services/streamingMarkdown";

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
    if (!cache.current) cache.current = new StreamingMarkdownCache();
    const sanitizedHtml = useMemo(() => {
      try {
        const rendered = cache.current!.render(content, isStreaming);
        if (isStreaming && streamingCursor) {
          return injectStreamingCursor(rendered, '<span class="thinking-streaming-cursor"></span>');
        }
        return rendered;
      } catch (err) {
        console.error("Markdown parse error:", err);
        const fallback = `<p>${escapeHtml(content)}</p>`;
        return isStreaming && streamingCursor
          ? injectStreamingCursor(fallback, '<span class="thinking-streaming-cursor"></span>')
          : fallback;
      }
    }, [content, isStreaming, streamingCursor]);

    const handleCopy = (event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      const copyBtn = target.closest(".code-copy-btn");
      if (!copyBtn) return;

      const codeBlock = copyBtn.closest(".code-block-wrapper")?.querySelector("code");
      if (codeBlock) {
        const text = codeBlock.textContent || "";
        navigator.clipboard.writeText(text);
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.classList.remove("copied");
        }, 1800);
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export default MarkdownRenderer;
