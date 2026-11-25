import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Copy, Layers } from "lucide-react";
import { t } from "../i18n";
import type { CompactionItemInfo, TranscriptItem } from "../types";
import { copyTextToClipboard } from "../services/externalLink";
import { useCardAppear } from "../services/cardAnimations";
import { syncOverscrollContainment } from "../services/transcriptScroll";
import { observeElementResize } from "../services/sharedResizeObserver";
import { formatTokenCount } from "../utils/tokenUsage";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { CardReveal } from "./CardReveal";
import { CollapsibleCardBody } from "./CollapsibleCardBody";

interface CompactedCardProps {
  item: TranscriptItem;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean, card?: HTMLElement) => void;
  className?: string;
}

function shortReasonLabel(reason: CompactionItemInfo["reason"]): string | null {
  switch (reason) {
    case "manual": return t("手动");
    case "threshold": return t("自动");
    case "overflow": return t("溢出恢复");
    default: return null;
  }
}

function headerSummaryText(info: CompactionItemInfo): string | null {
  const before = info.tokensBefore !== undefined && info.tokensBefore > 0
    ? formatTokenCount(info.tokensBefore) : null;
  const after = info.tokensAfter !== undefined && info.tokensAfter > 0
    ? formatTokenCount(info.tokensAfter) : null;
  if (before && after) return `${before} → ${after} tokens`;
  if (before) return t("从 {0} tokens 压缩", before);
  const fileCount = (info.modifiedFiles?.length ?? 0) + (info.readFiles?.length ?? 0);
  if (fileCount > 0) return t("保留 {0} 个关联文件上下文", fileCount);
  return null;
}

export const CompactedCard: React.FC<CompactedCardProps> = React.memo(
  ({ item, defaultExpanded = false, expanded, onExpandedChange, className = "" }) => {
    const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
    const isExpanded = expanded ?? internalExpanded;
    const [isCopied, setIsCopied] = useState(false);
    const cardRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      };
    }, []);

    useEffect(() => {
      const body = bodyRef.current;
      if (!isExpanded || !body) return;
      syncOverscrollContainment(body);
      return observeElementResize(body, () => syncOverscrollContainment(body));
    }, [isExpanded, item.content]);

    const info: CompactionItemInfo = item.compaction ?? { summary: item.content ?? "" };
    const summary = info.summary.trim();
    const headerSummary = headerSummaryText(info);
    const reasonBadge = shortReasonLabel(info.reason);
    const modifiedFiles = info.modifiedFiles ?? [];
    const readFiles = info.readFiles ?? [];
    const hasFiles = modifiedFiles.length > 0 || readFiles.length > 0;

    const animateAppear = useCardAppear(item.id, false, item.timestamp, item.animateAppear);

    const toggleExpand = () => {
      const nextExpanded = !isExpanded;
      setInternalExpanded(nextExpanded);
      onExpandedChange?.(nextExpanded, cardRef.current ?? undefined);
    };

    const handleCopy = (event: React.MouseEvent) => {
      event.stopPropagation();
      if (!summary) return;
      void copyTextToClipboard(summary).then((ok) => {
        if (!ok || !mountedRef.current) return;
        setIsCopied(true);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setIsCopied(false);
        }, 1600);
      }).catch(() => {});
    };

    return (
      <CardReveal animate={animateAppear}>
        <div
          ref={cardRef}
          className={`compacted-card ${isExpanded ? "expanded" : "collapsed"}${animateAppear ? " appear-active" : ""} ${className}`.trim()}
        >
          <div
            className="compacted-card-header"
            onClick={toggleExpand}
            onMouseDown={(event) => {
              if ((event.target as HTMLElement).closest("button")) return;
              event.preventDefault();
            }}
            onKeyDown={(event) => {
              if ((event.target as HTMLElement).closest("button")) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleExpand();
              }
            }}
            role="button"
            aria-expanded={isExpanded}
            tabIndex={0}
          >
            <div className="compacted-header-left">
              <span className="compacted-expand-icon">
                <ChevronRight size={14} className={`compacted-expand-chevron ${isExpanded ? "open" : ""}`} />
              </span>
              <span className="compacted-icon-box" aria-hidden="true">
                <Layers size={14} />
              </span>
              <span className="compacted-title">Compacted</span>
              {headerSummary && (
                <span className="compacted-summary">{headerSummary}</span>
              )}
            </div>

            <div className="compacted-header-right">
              {reasonBadge && (
                <span className="compacted-reason">{reasonBadge}</span>
              )}
              {summary && (
                <button
                  type="button"
                  className="compacted-copy-btn"
                  onClick={handleCopy}
                  aria-label={t("复制压缩摘要")}
                >
                  {isCopied ? <Check size={12} className="copy-icon-check" /> : <Copy size={12} className="copy-icon-copy" />}
                </button>
              )}
            </div>
          </div>

          <CollapsibleCardBody expanded={isExpanded}>{() => (
            <div ref={bodyRef} className="compacted-card-body">
              {summary ? (
                <div className="compacted-summary-content">
                  <MarkdownRenderer content={summary} className="compacted-markdown" />
                </div>
              ) : (
                <div className="compacted-empty">{t("暂无压缩摘要")}</div>
              )}

              {hasFiles && (
                <div className="compacted-files">
                  {modifiedFiles.length > 0 && (
                    <div className="compacted-files-group">
                      <span className="compacted-files-label">{t("已修改文件")}</span>
                      <div className="compacted-file-list">
                        {modifiedFiles.map((file) => (
                          <code key={`mod:${file}`} className="compacted-file-chip">{file}</code>
                        ))}
                      </div>
                    </div>
                  )}
                  {readFiles.length > 0 && (
                    <div className="compacted-files-group">
                      <span className="compacted-files-label">{t("已读取文件")}</span>
                      <div className="compacted-file-list">
                        {readFiles.map((file) => (
                          <code key={`read:${file}`} className="compacted-file-chip">{file}</code>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}</CollapsibleCardBody>
        </div>
      </CardReveal>
    );
  }
);

CompactedCard.displayName = "CompactedCard";

export default CompactedCard;
