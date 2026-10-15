import { t } from "../i18n";
import React, { useState, useEffect, useRef, useMemo } from "react";
import { Brain, ChevronRight, Copy, Check, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { TranscriptItem } from "../types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { useSmoothStreamText } from "../hooks/useSmoothStreamText";
import { CollapsibleCardBody } from "./CollapsibleCardBody";
import { shouldCardAnimateAppear } from "../services/cardAnimations";

interface ThinkingCardProps {
  item?: TranscriptItem;
  content?: string;
  isStreaming?: boolean;
  title?: string;
  defaultExpanded?: boolean;
  autoExpandWhileStreaming?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean, card?: HTMLElement) => void;
  className?: string;
}

export const ThinkingCard: React.FC<ThinkingCardProps> = React.memo(
  ({
    item,
    content: directContent,
    isStreaming: directStreaming,
    title = t("思维链推理 (Chain of Thought)"),
    defaultExpanded = true,
    autoExpandWhileStreaming = true,
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
    const cardRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const userScrolledUpRef = useRef(false);

    const isExpanded = expanded ?? (userToggled !== null ? userToggled : defaultExpanded || (autoExpandWhileStreaming && isStreaming));

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
      onExpandedChange?.(!isExpanded, cardRef.current ?? undefined);
    };

    // Calculate approximate token/char stats
    const charCount = rawContent.trim() ? (isStreaming && smoothContent ? smoothContent : rawContent).length : 0;

    const animateAppear = useMemo(() => {
      return shouldCardAnimateAppear(item?.id, isStreaming, item?.timestamp);
    }, [item?.id, isStreaming, item?.timestamp]);

    // An empty provider block says nothing about the other thinking already received.
    // Keep its item for possible backfill, but do not render a misleading completion card.
    if (!isStreaming && !rawContent.trim()) return null;

    return (
      <div ref={cardRef} className={`thinking-card ${isStreaming ? "streaming" : "settled"} ${isExpanded ? "expanded" : "collapsed"}${animateAppear ? " appear-active" : ""} ${className}`.trim()}>
        <div
          className="thinking-card-header"
          onClick={toggleExpand}
          role="button"
          aria-expanded={isExpanded}
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
            <span className="thinking-expand-icon">
              <ChevronRight size={14} className={`thinking-expand-chevron ${isExpanded ? "open" : ""}`} />
            </span>
            <div className={`thinking-icon-box ${isStreaming ? "pulse" : ""}`}>
              <span key={isStreaming ? "sparkles" : "brain"} className="thinking-icon-glyph">
                {isStreaming ? <Sparkles size={14} /> : <Brain size={14} />}
              </span>
            </div>
            <span className="thinking-title">{title}</span>
          </div>

          <div className="thinking-header-right">
            <AnimatePresence>
              {isStreaming && (
                <motion.span
                  key="thinking-streaming-status"
                  className="thinking-status streaming"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.2 }}
                >
                  <span className="thinking-pulse-dot" />
                  <span>{t("思考中...")}</span>
                </motion.span>
              )}
            </AnimatePresence>
            {charCount > 0 && (
              <button
                type="button"
                className="thinking-copy-btn"
                onClick={handleCopy}
                aria-label={t("复制思维链内容")}
                title={t("复制思维链内容")}
              >
                {isCopied ? <Check size={12} className="copy-icon-check" /> : <Copy size={12} className="copy-icon-copy" />}
              </button>
            )}
          </div>
        </div>

        <CollapsibleCardBody expanded={isExpanded}>{() => (
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
            ) : (
              <div className="thinking-shimmer">
                <span className="shimmer-line" />
                <span className="thinking-shimmer-text">{t("模型正在生成分析与推演逻辑...")}</span>
              </div>
            )}
          </div>
        )}</CollapsibleCardBody>
      </div>
    );
  }
);

ThinkingCard.displayName = "ThinkingCard";

export default ThinkingCard;

