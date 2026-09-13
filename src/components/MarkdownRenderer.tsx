import React, { useMemo } from "react";
import { marked } from "marked";

interface MarkdownRendererProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
}

// Lightweight sanitizer for dangerous tags and protocols to prevent XSS without heavy dependencies
function sanitizeHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/href\s*=\s*(['"])\s*(javascript:|data:text\/html)/gi, 'href=$1#blocked');
}

// Auto-closes open code fences for smooth streaming display without layout flickering.
// Uses native RegExp iteration to avoid creating thousands of line strings on every streaming token chunk.
function repairStreamingMarkdown(text: string): string {
  if (!text) return "";
  const fenceRegex = /^(\s*)(`{3,}|~{3,})/mg;
  let match: RegExpExecArray | null;
  let insideCodeFence = false;
  let fenceChars = "";

  while ((match = fenceRegex.exec(text)) !== null) {
    if (!insideCodeFence) {
      insideCodeFence = true;
      fenceChars = match[2];
    } else if (match[2].startsWith(fenceChars.slice(0, 3))) {
      insideCodeFence = false;
      fenceChars = "";
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
        const raw = marked.parse(repaired, {
          gfm: true,
          breaks: true,
        }) as string;
        return sanitizeHtml(raw);
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
