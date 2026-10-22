import { t } from "../i18n";
import React, { useState, useEffect, useRef, useDeferredValue } from "react";
import { Brain, ChevronRight, Copy, Check, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { TranscriptItem } from "../types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { useSmoothStreamText } from "../hooks/useSmoothStreamText";
import { CollapsibleCardBody } from "./CollapsibleCardBody";
import { useCardAppear } from "../services/cardAnimations";
import { useAutoExpandCot } from "../services/displayPreferences";

interface ThinkingCardProps {
  item?: TranscriptItem;
  content?: string;
  isStreaming?: boolean;
  title?: string;
  defaultExpanded?: boolean;
  autoExpandWhileStreaming?: boolean;
  expanded?: boolean;
  animateAppear?: boolean;
  onExpandedChange?: (expanded: boolean, card?: HTMLElement) => void;
  className?: string;
}

export const ThinkingCard: React.FC<ThinkingCardProps> = React.memo(
  ({
    item,
    content: directContent,
    isStreaming: directStreaming,
    title = "Chain of Thought",
    defaultExpanded = true,
    autoExpandWhileStreaming = true,
    expanded,
    animateAppear: directAnimateAppear,
    onExpandedChange,
    className = "",
  }) => {
    const rawContent = (item ? item.content : directContent) || "";
    const isStreaming = item ? item.status === "running" : Boolean(directStreaming);
    const hasVisibleContent = Boolean(rawContent.trim());
    const smoothContent = useSmoothStreamText(rawContent, isStreaming);
    // Markdown parsing is O(content) per delta. Defer the render so streamed
    // answer text and scrolling stay responsive, and superseded intermediate
    // deltas are skipped instead of parsed one by one.
    const renderedContent = useDeferredValue(smoothContent);
    // The Settings toggle (default on) decides whether watching a run may pop
    // reasoning cards open. A collapsed card never mounts its Markdown body.
    const autoExpandCot = useAutoExpandCot();

    // If the user explicitly collapses/expands, respect their choice; otherwise auto-expand while streaming.
    const [userToggled, setUserToggled] = useState<boolean | null>(null);
    const [isCopied, setIsCopied] = useState(false);
    const cardRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const userScrolledUpRef = useRef(false);
    const lastScrollTopRef = useRef(0);
    const wasStreamingRef = useRef(isStreaming);

    const isExpanded = expanded ?? (userToggled !== null ? userToggled
      : autoExpandCot && (defaultExpanded || (autoExpandWhileStreaming && isStreaming)));

    // Auto-scroll within the thinking box while streaming if user hasn't scrolled up
    useEffect(() => {
      const justFinished = wasStreamingRef.current && !isStreaming;
      wasStreamingRef.current = isStreaming;
      if ((isStreaming || justFinished) && isExpanded && !userScrolledUpRef.current && bodyRef.current) {
        bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
        lastScrollTopRef.current = bodyRef.current.scrollTop;
      }
    }, [renderedContent, isStreaming, isExpanded]);

    const handleScroll = () => {
      const el = bodyRef.current;
      if (!el) return;
      const { scrollTop, scrollHeight, clientHeight } = el;
      const distFromBottom = scrollHeight - scrollTop - clientHeight;
      const prevScrollTop = lastScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;

      if (distFromBottom <= 32) {
        userScrolledUpRef.current = false;
        return;
      }

      // Only lock scrolled-up if the user actually scrolled upwards (scrollTop decreased)
      if (scrollTop < prevScrollTop - 1 && distFromBottom > 32) {
        userScrolledUpRef.current = true;
      }
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
      const nextExpanded = !isExpanded;
      setUserToggled(nextExpanded);
      if (nextExpanded) {
        userScrolledUpRef.current = false;
      }
      onExpandedChange?.(nextExpanded, cardRef.current ?? undefined);
    };

    const charCount = rawContent.trim() ? (isStreaming && smoothContent ? smoothContent : rawContent).length : 0;

    const animateAppear = useCardAppear(item?.id, isStreaming, item?.timestamp, directAnimateAppear ?? item?.animateAppear);

    // A provider block can settle without visible text (private or encrypted
    // reasoning). Keep its card and say so instead of making the card vanish.
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
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
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
            {hasVisibleContent ? (
              <div className="thinking-content-container">
                <MarkdownRenderer
                  content={renderedContent}
                  isStreaming={isStreaming}
                  streamingCursor={isStreaming}
                  className="thinking-markdown"
                />
              </div>
            ) : isStreaming ? (
              <div className="thinking-shimmer">
                <span className="shimmer-line" />
                <span className="thinking-shimmer-text">{t("模型正在生成分析与推演逻辑...")}</span>
              </div>
            ) : (
              <div className="thinking-no-output">{t("此次思考未输出可见内容")}</div>
            )}
          </div>
        )}</CollapsibleCardBody>
      </div>
    );
  }
);

ThinkingCard.displayName = "ThinkingCard";

export default ThinkingCard;

