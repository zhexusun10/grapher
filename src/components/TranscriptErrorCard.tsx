import React, { memo, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronRight, Copy } from "lucide-react";
import { t } from "../i18n";
import type { TranscriptItem } from "../types";
import { CollapsibleCardBody } from "./CollapsibleCardBody";
import { copyTextToClipboard } from "../services/externalLink";

const MAX_ERROR_PREVIEW_CHARS = 300;
const MAX_ERROR_DETAIL_CHARS = 120_000;

function truncateErrorPreview(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_ERROR_PREVIEW_CHARS) return flat;
  return `${flat.slice(0, MAX_ERROR_PREVIEW_CHARS).trimEnd()}…`;
}

export const TranscriptErrorCard = memo(function TranscriptErrorCard({ item, expanded, onExpandedChange }: {
  item: TranscriptItem;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean, card?: HTMLElement) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const [localExpanded, setLocalExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);
  const errors = item.errorItems?.length ? item.errorItems : [item];
  const isExpanded = expanded ?? localExpanded;
  const rawPreview = [...errors].reverse().find(error => error.content?.trim())?.content || t("未知错误");
  const preview = truncateErrorPreview(rawPreview);

  const toggle = () => {
    const next = !isExpanded;
    setLocalExpanded(next);
    onExpandedChange?.(next, cardRef.current ?? undefined);
  };
  const copy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    try {
      const ok = await copyTextToClipboard(errors.map(error => error.content || t("未知错误")).join("\n\n"));
      if (!ok || !mountedRef.current) return;
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => { if (mountedRef.current) setCopied(false); }, 1800);
    } catch {}
  };

  const headerContent = <>
      <span className="transcript-error-title">
        <ChevronRight size={14} className={`tool-expand-chevron ${isExpanded ? "open" : ""}`} aria-hidden="true" />
        <AlertCircle size={14} className="transcript-error-icon" aria-hidden="true" />
        <span className="transcript-error-label">{t("错误")}</span>
        {errors.length > 1 && <span className="transcript-error-count">{t(" - {0}", errors.length)}</span>}
      </span>
    <span className="transcript-error-preview">{preview}</span>
  </>;

  return <div ref={cardRef} className="tool-call-card error transcript-error-card" data-testid="transcript-error-card">
    <div className="transcript-error-header">
      <button type="button" className="transcript-error-toggle" onClick={toggle} aria-expanded={isExpanded}>{headerContent}</button>
      <button type="button" className="tool-copy-btn transcript-error-copy" onClick={copy} aria-label={copied ? t("已复制") : t("复制错误")} title={copied ? t("已复制") : t("复制错误")}>
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </button>
    </div>
    <CollapsibleCardBody expanded={isExpanded}>
      {() => <div className="transcript-error-details">
        {errors.map((error, index) => {
          const content = error.content || t("未知错误");
          const displayed = content.length > MAX_ERROR_DETAIL_CHARS
            ? `${content.slice(0, MAX_ERROR_DETAIL_CHARS)}\n\n… ${t("已截断显示（共 {0} 字符，可点击复制查看完整内容）", content.length.toLocaleString())}`
            : content;
          return <pre key={`${error.id}-${index}`} className="transcript-error-detail">{displayed}</pre>;
        })}
      </div>}
    </CollapsibleCardBody>
  </div>;
});

TranscriptErrorCard.displayName = "TranscriptErrorCard";
export default TranscriptErrorCard;
