import React, { memo, useRef, useState } from "react";
import { AlertCircle, Check, ChevronRight, Copy } from "lucide-react";
import { t } from "../i18n";
import type { TranscriptItem } from "../types";
import { CollapsibleCardBody } from "./CollapsibleCardBody";

export const TranscriptErrorCard = memo(function TranscriptErrorCard({ item, expanded, onExpandedChange }: {
  item: TranscriptItem;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean, card?: HTMLElement) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [localExpanded, setLocalExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const errors = item.errorItems?.length ? item.errorItems : [item];
  const canExpand = errors.length > 1;
  const isExpanded = canExpand && (expanded ?? localExpanded);
  const preview = [...errors].reverse().find(error => error.content?.trim())?.content || t("未知错误");

  const toggle = () => {
    if (!canExpand) return;
    const next = !isExpanded;
    setLocalExpanded(next);
    onExpandedChange?.(next, cardRef.current ?? undefined);
  };
  const copy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    await navigator.clipboard.writeText(errors.map(error => error.content || t("未知错误")).join("\\n\\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const headerContent = <>
      <span className="transcript-error-title">
        {canExpand && <ChevronRight size={14} className={`tool-expand-chevron ${isExpanded ? "open" : ""}`} aria-hidden="true" />}
        <AlertCircle size={14} className="transcript-error-icon" aria-hidden="true" />
        <span className="transcript-error-label">{t("错误")}</span>
        {errors.length > 1 && <span className="transcript-error-count">{t(" - {0}", errors.length)}</span>}
      </span>
    <span className="transcript-error-preview">{preview}</span>
  </>;

  return <div ref={cardRef} className="tool-call-card error transcript-error-card" data-testid="transcript-error-card">
    <div className="transcript-error-header">
      {canExpand
        ? <button type="button" className="transcript-error-toggle" onClick={toggle} aria-expanded={isExpanded}>{headerContent}</button>
        : <div className="transcript-error-toggle">{headerContent}</div>}
      <button type="button" className="tool-copy-btn transcript-error-copy" onClick={copy} aria-label={copied ? t("已复制") : t("复制错误")} title={copied ? t("已复制") : t("复制错误")}>
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </button>
    </div>
    {canExpand && <CollapsibleCardBody expanded={isExpanded}>
      {() => <div className="transcript-error-details">
        {errors.map((error, index) => <pre key={`${error.id}-${index}`} className="transcript-error-detail">{error.content || t("未知错误")}</pre>)}
      </div>}
    </CollapsibleCardBody>}
  </div>;
});

TranscriptErrorCard.displayName = "TranscriptErrorCard";
export default TranscriptErrorCard;
