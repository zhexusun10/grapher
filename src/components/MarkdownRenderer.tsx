import React, { useMemo } from "react";
import { marked } from "marked";

interface MarkdownRendererProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
}

// Auto-closes open code fences for smooth streaming display without layout flickering
function repairStreamingMarkdown(text: string): string {
  if (!text) return "";
  const lines = text.split("\n");
  let insideCodeFence = false;
  let fenceChars = "";

  for (const line of lines) {
    const match = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (match) {
      if (!insideCodeFence) {
        insideCodeFence = true;
        fenceChars = match[2];
      } else if (line.trim().startsWith(fenceChars)) {
        insideCodeFence = false;
        fenceChars = "";
      }
    }
  }

  if (insideCodeFence) {
    return text + `\n${fenceChars}\n`;
  }
  return text;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(
  ({ content, className = "", isStreaming = false }) => {
    const sanitizedHtml = useMemo(() => {
      const repaired = isStreaming ? repairStreamingMarkdown(content) : content;
      try {
        return marked.parse(repaired, {
          gfm: true,
          breaks: true,
        }) as string;
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
