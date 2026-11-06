import { t } from "../i18n";
import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { ChevronRight, Copy, Check, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { TranscriptItem } from "../types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { useSmoothStreamText } from "../hooks/useSmoothStreamText";
import { CollapsibleCardBody } from "./CollapsibleCardBody";
import { CardReveal } from "./CardReveal";
import { useCardAppear } from "../services/cardAnimations";
import { useAutoExpandCot } from "../services/displayPreferences";
import { notifyTranscriptContentGrowth, syncOverscrollContainment } from "../services/transcriptScroll";

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
    // The Settings toggle (default on) decides whether watching a run may pop
    // reasoning cards open. A collapsed card never mounts its Markdown body.
    const autoExpandCot = useAutoExpandCot();

    // If the user explicitly collapses/expands, respect their choice; otherwise auto-expand while streaming.
    const [userToggled, setUserToggled] = useState<boolean | null>(null);
    const isExpanded = expanded ?? (userToggled !== null ? userToggled
      : autoExpandCot && (defaultExpanded || (autoExpandWhileStreaming && isStreaming)));
    // Collapsed cards keep the body unmounted, so only type while expanded; the
    // remaining text is revealed when the user opens the card again.
    const smoothContent = useSmoothStreamText(rawContent, isStreaming, isExpanded);
    const [isCopied, setIsCopied] = useState(false);
    const cardRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const userScrolledUpRef = useRef(false);
    // Only an explicit upward gesture may stop the card's own following.
    // Reflow, remount and scrollbar clamping move scrollTop without reader
    // intent and must not leave the reasoning body parked at its top.
    const readerUpIntentRef = useRef(false);
    // A held pointer (selecting reasoning text) owns the inner position.
    const pointerHeldRef = useRef(false);
    const isStreamingRef = useRef(isStreaming);
    const stillTypingRef = useRef(false);
    const lastScrollTopRef = useRef(0);
    const lastTouchYRef = useRef(0);

    // Auto-scroll within the thinking box while text is still being revealed if
    // the user hasn't scrolled up. `smoothContent` trails `rawContent` during the
    // post-stream drain too, so keep following until it catches up.
    const stillTyping = isStreaming || smoothContent.length < rawContent.length;
    isStreamingRef.current = isStreaming;
    stillTypingRef.current = stillTyping;
    const pinBodyToBottom = () => {
      const body = bodyRef.current;
      if (!body) return;
      const target = body.scrollHeight - body.clientHeight;
      if (body.scrollTop < target - 1) body.scrollTop = target;
      lastScrollTopRef.current = body.scrollTop;
    };

    // A newly mounted body starts at scrollTop 0 even when its reasoning has
    // already finished. Open on its newest line before paint, just as a live
    // card does; subsequent reader gestures still own the inner position.
    useLayoutEffect(() => {
      if (!isExpanded) return;
      userScrolledUpRef.current = false;
      readerUpIntentRef.current = false;
      pinBodyToBottom();
    }, [isExpanded]);

    useEffect(() => {
      // A completed block can receive its visible text in a later summary as
      // well. Follow that backfill unless the reader has scrolled up inside it.
      if (isExpanded && !userScrolledUpRef.current) pinBodyToBottom();
      // The card body can be capped while the conversation still has a working
      // footer below it. Re-check that footer on every streamed line so a
      // following conversation never leaves it outside the viewport.
      if (isStreaming || stillTyping) notifyTranscriptContentGrowth(cardRef.current);
    }, [smoothContent, isStreaming, isExpanded, stillTyping]);

    // Content can grow without changing `smoothContent`: Markdown layout,
    // images and the point where the body starts its own scrollbar all resize
    // after the text effect runs. Keep the body pinned while the reasoning is
    // still being revealed so its latest line, not its header, stays in view.
    useEffect(() => {
      const body = bodyRef.current;
      const content = contentRef.current;
      if (!isExpanded || !body || !content) return;
      const followContent = () => {
        if (!(isStreaming || stillTyping)) return;
        notifyTranscriptContentGrowth(cardRef.current);
        if (userScrolledUpRef.current) return;
        const target = body.scrollHeight - body.clientHeight;
        if (body.scrollTop < target - 1) {
          body.scrollTop = target;
          lastScrollTopRef.current = target;
        }
      };
      const observer = new ResizeObserver(() => {
        // A short body cannot scroll; containing its overscroll would swallow
        // the conversation wheel gesture instead of forwarding it.
        syncOverscrollContainment(body);
        followContent();
      });
      observer.observe(content);
      observer.observe(body);
      syncOverscrollContainment(body);
      followContent();
      return () => observer.disconnect();
    }, [isExpanded, isStreaming, stillTyping, hasVisibleContent]);

    const handleScroll = () => {
      const el = bodyRef.current;
      if (!el) return;
      const { scrollTop, scrollHeight, clientHeight } = el;
      const distFromBottom = scrollHeight - scrollTop - clientHeight;
      const prevScrollTop = lastScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;

      if (distFromBottom <= 32) {
        userScrolledUpRef.current = false;
        readerUpIntentRef.current = false;
        return;
      }

      if (scrollTop < prevScrollTop - 1) {
        // Only a real gesture holds the reader's position. A clamp caused by a
        // shrinking layout or a remounted body keeps following the newest line.
        if (readerUpIntentRef.current || pointerHeldRef.current) {
          userScrolledUpRef.current = true;
          return;
        }
        if (isStreamingRef.current || stillTypingRef.current) requestAnimationFrame(pinBodyToBottom);
      }
    };

    // Lock the inner auto-follow as soon as the reader starts scrolling up,
    // before the next streamed line can pin the body back to the bottom. The
    // scroll event itself can arrive after that update, so waiting for
    // handleScroll to notice the direction would lose the race.
    const stopFollowingInsideCard = () => {
      readerUpIntentRef.current = true;
      userScrolledUpRef.current = true;
    };

    // Only lock the inner follow when this gesture can actually move the card
    // body. A short card forwards the same wheel/touch/key event to the
    // conversation; locking here would then suppress the card's own follow long
    // after the reader returned to the conversation bottom.
    const cardBodyCanScroll = () => {
      const body = bodyRef.current;
      return !!body && body.scrollHeight > body.clientHeight + 1;
    };

    const handleWheel = (event: React.WheelEvent) => {
      if (event.deltaY < -0.5 && cardBodyCanScroll()) stopFollowingInsideCard();
    };

    const handleTouchStart = (event: React.TouchEvent) => {
      if (event.touches[0]) lastTouchYRef.current = event.touches[0].clientY;
    };

    const handleTouchMove = (event: React.TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      // Finger moving down scrolls the reasoning viewport toward older lines.
      if (touch.clientY > lastTouchYRef.current + 1 && cardBodyCanScroll()) stopFollowingInsideCard();
      lastTouchYRef.current = touch.clientY;
    };

    const handleKeyDown = (event: React.KeyboardEvent) => {
      if ((event.key === " " && event.shiftKey) || ["ArrowUp", "PageUp", "Home"].includes(event.key)) {
        if (cardBodyCanScroll()) stopFollowingInsideCard();
      }
    };

    useEffect(() => {
      const release = () => { pointerHeldRef.current = false; };
      window.addEventListener("pointerup", release);
      window.addEventListener("pointercancel", release);
      return () => {
        window.removeEventListener("pointerup", release);
        window.removeEventListener("pointercancel", release);
      };
    }, []);

    const handlePointerDown = (event: React.PointerEvent) => {
      const body = bodyRef.current;
      if (!body) return;
      pointerHeldRef.current = true;
      const scrollbarWidth = body.offsetWidth - body.clientWidth;
      // Overlay scrollbars have no layout width; treat the narrow edge band as
      // the scrollbar only when the body itself is the target.
      const onScrollbar = scrollbarWidth > 0
        ? event.clientX >= body.getBoundingClientRect().right - scrollbarWidth
        : event.target === body && event.clientX >= body.getBoundingClientRect().right - 14;
      // A stable scrollbar gutter is reserved even on a short card where no
      // scrollbar exists. A pointer there cannot move the body, so it must not
      // turn the card's own follow state off.
      if (onScrollbar && cardBodyCanScroll()) stopFollowingInsideCard();
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
        readerUpIntentRef.current = false;
      }
      onExpandedChange?.(nextExpanded, cardRef.current ?? undefined);
    };

    const charCount = rawContent.trim() ? rawContent.length : 0;

    const animateAppear = useCardAppear(item?.id, isStreaming, item?.timestamp, directAnimateAppear ?? item?.animateAppear);

    // A provider block can settle without visible text (private or encrypted
    // reasoning). Keep its card and say so instead of making the card vanish.
    return (
      <CardReveal animate={animateAppear}>
        <div ref={cardRef} className={`thinking-card ${isStreaming ? "streaming" : "settled"} ${isExpanded ? "expanded" : "collapsed"}${animateAppear ? " appear-active" : ""} ${className}`.trim()}>
          <div
            className="thinking-card-header"
            onClick={toggleExpand}
            onMouseDown={(e) => {
              // A pointer click is only a disclosure toggle: keep the composer's
              // caret where it was instead of moving keyboard focus (and its
              // Enter/Space handlers) onto the card. The header stays reachable
              // with Tab and keeps handling keys while it actually has focus.
              if ((e.target as HTMLElement).closest("button")) return;
              e.preventDefault();
            }}
            role="button"
            aria-expanded={isExpanded}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleExpand();
              }
            }}
          >
            <div className="thinking-header-left">
              <span className="thinking-expand-icon">
                <ChevronRight size={14} className={`thinking-expand-chevron ${isExpanded ? "open" : ""}`} />
              </span>
              <div className={`thinking-icon-box ${isStreaming ? "pulse" : ""}`}>
                <span className="thinking-icon-glyph">
                  <Sparkles size={14} />
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
              onWheel={handleWheel}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onKeyDown={handleKeyDown}
              onPointerDown={handlePointerDown}
            >
              {hasVisibleContent ? (
                <div ref={contentRef} className="thinking-content-container">
                  <MarkdownRenderer
                    content={smoothContent}
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
      </CardReveal>
    );
  }
);

ThinkingCard.displayName = "ThinkingCard";

export default ThinkingCard;

