import React, { useMemo, useRef } from "react";
import { StreamingMarkdownCache } from "../services/streamingMarkdown";

interface MarkdownRendererProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(
  ({ content, className = "", isStreaming = false }) => {
    const cache = useRef<StreamingMarkdownCache | null>(null);
    if (!cache.current) cache.current = new StreamingMarkdownCache();
    const sanitizedHtml = useMemo(() => {
      try {
        return cache.current!.render(content, isStreaming);
      } catch (err) {
        console.error("Markdown parse error:", err);
        return `<p>${escapeHtml(content)}</p>`;
      }
    }, [content, isStreaming]);

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
