import { t } from "../i18n";
import React, { useState, useEffect, useRef } from "react";
import { Brain, ChevronDown, ChevronRight, Copy, Check, Sparkles } from "lucide-react";
import { TranscriptItem } from "../types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { useSmoothStreamText } from "../hooks/useSmoothStreamText";

interface ThinkingCardProps {
  item?: TranscriptItem;
  content?: string;
  isStreaming?: boolean;
  title?: string;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
}

export const ThinkingCard: React.FC<ThinkingCardProps> = React.memo(
  ({
    item,
    content: directContent,
    isStreaming: directStreaming,
    title = t("思维链推理 (Chain of Thought)"),
    defaultExpanded = true,
    expanded,
    onExpandedChange,
    className = "",
  }) => {
    const rawContent = (item ? item.content : directContent) || "";
    const isStreaming = item ? item.status === "running" : Boolean(directStreaming);
    const smoothContent = useSmoothStreamText(rawContent, isStreaming);

    // If user explicitly collapses/expands, respect their choice; otherwise auto-expand while streaming
    const [userToggled, setUserToggled] = useState<boolean | null>(null);
    const [isCopied, setIsCopied] = useState(false);
    const bodyRef = useRef<HTMLDivElement>(null);
    const userScrolledUpRef = useRef(false);

    const isExpanded = expanded ?? (userToggled !== null ? userToggled : defaultExpanded || isStreaming);

    // Auto-scroll within the thinking box while streaming if user hasn't scrolled up
    useEffect(() => {
      if (isStreaming && isExpanded && !userScrolledUpRef.current && bodyRef.current) {
        bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
      }
    }, [smoothContent, isStreaming, isExpanded]);

    const handleScroll = () => {
      const el = bodyRef.current;
      if (!el) return;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUpRef.current = distFromBottom > 32;
    };

    const handleCopy = (e: React.MouseEvent) => {
      e.stopPropagation();
      const textToCopy = rawContent || smoothContent;
      if (!textToCopy) return;
      navigator.clipboard.writeText(textToCopy).then(() => {
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 1800);
      });
    };

    const toggleExpand = () => {
      setUserToggled(!isExpanded);
      onExpandedChange?.(!isExpanded);
    };

    // Calculate approximate token/char stats
    const charCount = rawContent.trim() ? (isStreaming && smoothContent ? smoothContent : rawContent).length : 0;

    return (
      <div className={`thinking-card ${isStreaming ? "streaming" : "settled"} ${isExpanded ? "expanded" : "collapsed"} ${className}`}>
        <div
          className="thinking-card-header"
          onClick={toggleExpand}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleExpand();
            }
          }}
          title={isExpanded ? t("点击折叠思维链") : t("点击展开思维链")}
        >
          <div className="thinking-header-left">
            <div className={`thinking-icon-box ${isStreaming ? "pulse" : ""}`}>
              {isStreaming ? <Sparkles size={14} /> : <Brain size={14} />}
            </div>
            <span className="thinking-title">{title}</span>
            {isStreaming ? (
              <span className="thinking-status streaming">
                <span className="thinking-pulse-dot" />
                {t("思考中...")}</span>
            ) : (
              <span className="thinking-status completed">
                {t("已完成 ")}{charCount > 0 ? t("({0} 字符)", charCount) : ""}
              </span>
            )}
          </div>

          <div className="thinking-header-right">
            {charCount > 0 && (
              <button
                type="button"
                className="thinking-copy-btn"
                onClick={handleCopy}
                title={t("复制思维链内容")}
              >
                {isCopied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                <span>{isCopied ? t("已复制") : t("复制")}</span>
              </button>
            )}
            <div className="thinking-toggle-btn">
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </div>
          </div>
        </div>

        {isExpanded && (
          <div
            ref={bodyRef}
            className="thinking-card-body"
            onScroll={handleScroll}
          >
            {smoothContent.trim() ? (
              <div className="thinking-content-container">
                <MarkdownRenderer content={smoothContent} isStreaming={isStreaming} className="thinking-markdown" />
                {isStreaming && <span className="thinking-streaming-cursor" />}
              </div>
            ) : isStreaming ? (
              <div className="thinking-shimmer">
                <span className="shimmer-line" />
                <span className="thinking-shimmer-text">{t("模型正在生成分析与推演逻辑...")}</span>
              </div>
            ) : (
              <p className="thinking-empty">{t("本段思考已结束，模型未返回可展示的推理摘要。")}</p>
            )}
          </div>
        )}
      </div>
    );
  }
);

ThinkingCard.displayName = "ThinkingCard";

export default ThinkingCard;

