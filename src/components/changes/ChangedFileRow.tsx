import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { t } from "../../i18n";
import { highlightDiffLines, type SyntaxSpan } from "../../lib/diffSyntax";
import { cacheFileDiff, getCachedFileDiff } from "../../services/fileChanges";
import { observeElementResize } from "../../services/sharedResizeObserver";
import type { FileChangeItem, FileChangeStatus, FileDiffLine, FileDiffResult } from "../../types";
import { ChangeDiffStats } from "./ChangeDiffStats";

const INITIAL_VISIBLE_DIFF_LINES = 300;
const DIFF_LINE_PAGE_SIZE = 300;

interface ChangedFileRowProps {
  runId: string;
  viewScopeKey: string;
  scopeKey: string;
  item: FileChangeItem;
  expanded: boolean;
  onToggle: (path: string) => void;
  onOpenFile?: (item: FileChangeItem) => void;
  loadDiff: (item: FileChangeItem, signal: AbortSignal) => Promise<FileDiffResult>;
  refreshVersion: number;
}

const STATUS_META: Record<FileChangeStatus, { letter: string; label: () => string }> = {
  modified: { letter: "M", label: () => t("已修改") },
  added: { letter: "A", label: () => t("新增") },
  deleted: { letter: "D", label: () => t("已删除") },
  renamed: { letter: "R", label: () => t("重命名") },
};

function renderHighlightedText(text: string, spans: SyntaxSpan[]): React.ReactNode {
  if (!text) return " ";
  if (!spans.length) return text;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (span.start > cursor) {
      nodes.push(text.slice(cursor, span.start));
    }
    nodes.push(
      <span key={i} className={`diff-tok-${span.kind}`}>
        {text.slice(span.start, span.end)}
      </span>,
    );
    cursor = span.end;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

const DiffLinesView = React.memo(function DiffLinesView({
  path,
  lines,
  truncated,
  hiddenLines,
}: {
  path: string;
  lines: FileDiffLine[];
  truncated: boolean;
  hiddenLines: number;
}) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_DIFF_LINES);
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_DIFF_LINES);
  }, [path, lines]);

  const shownLines = lines.length > visibleCount ? lines.slice(0, visibleCount) : lines;
  const remainingLocal = Math.max(0, lines.length - shownLines.length);

  const { texts, highlights } = useMemo(() => {
    const expandedTexts = shownLines.map((line) => line.text.replace(/\t/g, "    "));
    return {
      texts: expandedTexts,
      highlights: highlightDiffLines(path, shownLines, expandedTexts),
    };
  }, [path, shownLines]);

  return (
    <div className="changed-file-diff-box" data-testid="changed-file-diff">
      <div className="changed-file-diff-lines">
        {shownLines.map((line, index) => {
          const sign =
            line.kind === "added" ? "+"
              : line.kind === "removed" ? "−"
                : line.kind === "context" ? " "
                  : "";
          return (
            <div key={index} className={`diff-line diff-line-${line.kind}`}>
              <span className="diff-line-sign" aria-hidden="true">{sign}</span>
              <span className="diff-line-code">
                {line.kind === "hunk"
                  ? (texts[index] || " ")
                  : renderHighlightedText(texts[index], highlights[index])}
              </span>
            </div>
          );
        })}
      </div>
      {remainingLocal > 0 && (
        <div className="changed-file-diff-more">
          <button
            type="button"
            className="changed-file-diff-more-btn"
            onClick={() => setVisibleCount((count) => count + DIFF_LINE_PAGE_SIZE)}
          >
            {t("展开更多 {0} 行", Math.min(DIFF_LINE_PAGE_SIZE, remainingLocal))}
          </button>
          <span className="changed-file-diff-more-hint">
            {t("剩余 {0} 行", remainingLocal)}
          </span>
        </div>
      )}
      {remainingLocal === 0 && truncated && hiddenLines > 0 && (
        <div className="changed-file-diff-truncated">
          {t("还有 {0} 行未显示", hiddenLines)}
        </div>
      )}
    </div>
  );
});

function sameNodes(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameFileRowProps(prev: ChangedFileRowProps, next: ChangedFileRowProps): boolean {
  if (
    prev.runId !== next.runId ||
    prev.viewScopeKey !== next.viewScopeKey ||
    prev.scopeKey !== next.scopeKey ||
    prev.expanded !== next.expanded ||
    prev.refreshVersion !== next.refreshVersion ||
    prev.onToggle !== next.onToggle ||
    prev.onOpenFile !== next.onOpenFile ||
    prev.loadDiff !== next.loadDiff
  ) {
    return false;
  }
  const a = prev.item;
  const b = next.item;
  return a === b || (
    a.path === b.path &&
    a.oldPath === b.oldPath &&
    a.status === b.status &&
    a.additions === b.additions &&
    a.deletions === b.deletions &&
    Boolean(a.isRunning) === Boolean(b.isRunning) &&
    a.source === b.source &&
    sameNodes(a.nodes, b.nodes)
  );
}

export const ChangedFileRow = React.memo(function ChangedFileRow({
  runId,
  viewScopeKey,
  scopeKey,
  item,
  expanded,
  onToggle,
  onOpenFile,
  loadDiff,
  refreshVersion,
}: ChangedFileRowProps) {
  const meta = STATUS_META[item.status] ?? STATUS_META.modified;
  const slash = item.path.lastIndexOf("/");
  const directory = slash >= 0 ? item.path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? item.path.slice(slash + 1) : item.path;
  const canOpen = item.status !== "deleted" && !!onOpenFile;
  const tooltip = item.oldPath
    ? t("重命名自 {0}", item.oldPath)
    : `${meta.label()}: ${item.path}`;

  const cacheKey = `${scopeKey}:${item.path}:${item.oldPath ?? ""}:${item.status}:${item.additions}:${item.deletions}:${item.isRunning ? 1 : 0}:${item.source ?? ""}:${refreshVersion}`;
  const [diffState, setDiffState] = useState<{
    status: "idle" | "loading" | "loaded" | "error";
    viewScopeKey: string;
    data?: FileDiffResult;
    error?: string;
  }>(() => {
    const cached = getCachedFileDiff(cacheKey);
    return cached ? { status: "loaded", viewScopeKey, data: cached } : { status: "idle", viewScopeKey };
  });
  const [retryCount, setRetryCount] = useState(0);
  const retryBypassKeyRef = useRef<string | null>(null);
  const diffContentRef = useRef<HTMLDivElement>(null);
  const [diffHeight, setDiffHeight] = useState(0);
  const [renderBody, setRenderBody] = useState(expanded);

  useLayoutEffect(() => {
    if (expanded) {
      setRenderBody(true);
    } else {
      setDiffHeight(0);
      if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        setRenderBody(false);
      } else {
        const timer = setTimeout(() => setRenderBody(false), 240);
        return () => clearTimeout(timer);
      }
      return;
    }
    const content = diffContentRef.current;
    if (!content) return;
    const measure = () => {
      const nextHeight = content.getBoundingClientRect().height;
      setDiffHeight(previous => Math.abs(previous - nextHeight) < 0.5 ? previous : nextHeight);
    };
    measure();
    return observeElementResize(content, measure);
  }, [expanded, item.path]);

  useEffect(() => {
    if (!expanded) return;
    const bypassCache = retryBypassKeyRef.current === cacheKey;
    retryBypassKeyRef.current = null;
    if (!bypassCache) {
      const cached = getCachedFileDiff(cacheKey);
      if (cached) {
        setDiffState({ status: "loaded", viewScopeKey, data: cached });
        return;
      }
    }
    const abort = new AbortController();
    setDiffState((prev) => {
      const keepPrevData = prev.viewScopeKey === viewScopeKey ? prev.data : undefined;
      return {
        status: keepPrevData ? "loaded" : "loading",
        viewScopeKey,
        data: keepPrevData,
      };
    });
    loadDiff(item, abort.signal)
      .then((result) => {
        if (abort.signal.aborted) return;
        // Avoid pinning an empty diff while a file edit is still in flight.
        if (!item.isRunning || result.binary || result.lines.length > 0) {
          cacheFileDiff(cacheKey, runId, result);
        }
        setDiffState({ status: "loaded", viewScopeKey, data: result });
      })
      .catch((err) => {
        if (abort.signal.aborted) return;
        setDiffState({
          status: "error",
          viewScopeKey,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, cacheKey, retryCount, loadDiff, runId, viewScopeKey]);

  const handleToggle = useCallback(() => onToggle(item.path), [onToggle, item.path]);
  const handleRetry = useCallback(() => {
    retryBypassKeyRef.current = cacheKey;
    setRetryCount((count) => count + 1);
  }, [cacheKey]);
  const showContent = expanded || renderBody;

  return (
    <div
      className={`changed-file-item ${expanded ? "is-expanded" : ""}`}
      data-testid="changed-file-item"
      data-file-path={item.path}
      data-status={item.status}
    >
      <div className="changed-file-header">
        <button
          type="button"
          className="changed-file-row"
          aria-expanded={expanded}
          title={tooltip}
          onClick={handleToggle}
        >
          <span className="changed-file-chevron" aria-hidden="true">
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
          <span className="changed-file-status" aria-label={meta.label()}>
            {item.isRunning
              ? <Loader2 size={11} className="spin" aria-hidden="true" />
              : meta.letter}
          </span>
          <span className="changed-file-path-group">
            <span className="changed-file-name">{name}</span>
            {directory && <span className="changed-file-dir">{directory}</span>}
          </span>
          <ChangeDiffStats additions={item.additions} deletions={item.deletions} hideZero />
        </button>
        {canOpen && (
          <button
            type="button"
            className="changed-file-open-btn"
            onClick={() => onOpenFile?.(item)}
            aria-label={t("用默认应用打开 {0}", item.path)}
            title={t("用默认应用打开 {0}", item.path)}
          >
            <ExternalLink size={12} aria-hidden="true" />
          </button>
        )}
      </div>

      <div
        className={`changed-file-diff-reveal ${expanded ? "is-expanded" : ""}`}
        style={{ height: expanded ? `${diffHeight}px` : 0 }}
        aria-hidden={!expanded}
        inert={!expanded || undefined}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === "height" && !expanded) {
            setRenderBody(false);
          }
        }}
      >
        <div ref={diffContentRef} className="changed-file-diff-content">
          {showContent && (
            <div className="changed-file-diff-container">
              {item.oldPath && (
                <div className="changed-file-rename-note">
                  {item.oldPath} → {item.path}
                </div>
              )}
              {(diffState.status === "loading" || diffState.status === "idle" || diffState.viewScopeKey !== viewScopeKey) && (
                <div className="changed-file-diff-message">
                  <Loader2 size={12} className="spin" aria-hidden="true" />
                  <span>{t("正在加载变更内容…")}</span>
                </div>
              )}
              {diffState.viewScopeKey === viewScopeKey && diffState.status === "error" && (
                <div className="changed-file-diff-message is-error">
                  <span>{t("加载变更内容失败")}</span>
                  <button type="button" className="changed-file-diff-retry" onClick={handleRetry}>
                    {t("重试")}
                  </button>
                </div>
              )}
              {diffState.viewScopeKey === viewScopeKey && diffState.status === "loaded" && diffState.data && (
                diffState.data.binary ? (
                  <div className="changed-file-diff-message">{t("二进制文件")}</div>
                ) : diffState.data.lines.length === 0 ? (
                  <div className="changed-file-diff-message">{t("无文本变更")}</div>
                ) : (
                  <DiffLinesView
                    path={item.path}
                    lines={diffState.data.lines}
                    truncated={diffState.data.truncated}
                    hiddenLines={diffState.data.hiddenLines}
                  />
                )
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}, sameFileRowProps);
