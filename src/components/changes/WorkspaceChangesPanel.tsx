import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, FileDiff, Loader2, Network, RefreshCw, X } from "lucide-react";
import { t } from "../../i18n";
import { runtimeService } from "../../services/runtime";
import type { FileChangeItem, FileChangeSummary, FileDiffResult } from "../../types";
import { ChangeDiffStats } from "./ChangeDiffStats";
import { ChangedFileRow } from "./ChangedFileRow";
import "./WorkspaceChanges.css";

interface WorkspaceChangesTriggerProps {
  summary: FileChangeSummary;
  isLoaded: boolean;
  panelId: string;
  isOpen: boolean;
  onToggle: React.MouseEventHandler<HTMLButtonElement>;
}

/** Same trigger treatment as "Workspace and session details"; clicking opens or
 * toggles the right-side Changes panel in the topology area. */
export const WorkspaceChangesTrigger = React.memo(function WorkspaceChangesTrigger({
  summary, isLoaded, panelId, isOpen, onToggle,
}: WorkspaceChangesTriggerProps) {
  const label = summary.totalFiles > 0 ? t("{0} 个文件变更", summary.totalFiles) : t("暂无文件变更");
  return <button
    type="button"
    className={`workspace-details-trigger workspace-changes-trigger ${isOpen ? "is-open" : ""}`}
    data-testid="workspace-changes-trigger"
    onClick={onToggle}
    disabled={!isLoaded}
    aria-busy={!isLoaded}
    aria-expanded={isOpen}
    aria-controls={isOpen ? panelId : undefined}
  >
    <span>{label}</span>
    <ChevronRight size={12} className="workspace-details-chevron" aria-hidden="true" />
  </button>;
});

export const MAX_RENDERED_FILE_CHANGES = 60;

interface WorkspaceChangesPaneProps {
  id: string;
  runId: string;
  scopedExecutionIds?: string[];
  summary: FileChangeSummary;
  isLoaded: boolean;
  isRefreshing: boolean;
  refreshVersion: number;
  onRefresh: () => void;
  hasGraphPane: boolean;
  onSelectGraph?: () => void;
  onClose: () => void;
  onOpenFile?: (item: FileChangeItem) => void;
}

/** Right-side Changes panel reusing the topology pane area, modeled after
 * `pi-gpui`'s expandable inline diff view in Grapher's light design system. */
export const WorkspaceChangesPane = React.memo(function WorkspaceChangesPane({
  id,
  runId,
  scopedExecutionIds,
  summary,
  isLoaded,
  isRefreshing,
  refreshVersion,
  onRefresh,
  hasGraphPane,
  onSelectGraph,
  onClose,
  onOpenFile,
}: WorkspaceChangesPaneProps) {
  const scopeKey = useMemo(
    () => JSON.stringify([runId, scopedExecutionIds ?? null]),
    [runId, scopedExecutionIds],
  );
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setExpandedPaths(new Set());
  }, [scopeKey]);

  const toggleFile = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const loadDiff = useCallback(
    (item: FileChangeItem, signal: AbortSignal): Promise<FileDiffResult> =>
      runtimeService.getFileDiff(
        {
          runId,
          path: item.path,
          ...(item.oldPath ? { oldPath: item.oldPath } : {}),
          status: item.status,
          ...(scopedExecutionIds?.length ? { executionIds: scopedExecutionIds } : {}),
          ...(item.nodes?.length ? { nodes: item.nodes } : {}),
        },
        signal,
      ),
    [runId, scopedExecutionIds],
  );

  const orderedFiles = useMemo(
    () => [...summary.files].sort((a, b) => a.path.localeCompare(b.path)),
    [summary.files],
  );
  const visibleFiles = orderedFiles.length > MAX_RENDERED_FILE_CHANGES
    ? orderedFiles.slice(0, MAX_RENDERED_FILE_CHANGES)
    : orderedFiles;
  const omittedCount = Math.max(0, summary.totalFiles - visibleFiles.length);
  const fileCountLabel = summary.totalFiles === 1
    ? t("1 个文件")
    : t("{0} 个文件", summary.totalFiles);

  return (
    <div className="changes-pane" data-testid="workspace-changes-pane">
      <div className="graph-toolbar changes-pane-toolbar">
        <div className="toolbar-left">
          {hasGraphPane ? (
            <div className="changes-pane-tabs" role="tablist" aria-label={t("右侧面板")}>
              <button
                type="button"
                role="tab"
                aria-selected={false}
                className="changes-pane-tab"
                data-testid="right-pane-tab-graph"
                onClick={onSelectGraph}
              >
                <Network size={14} aria-hidden="true" />
                <span>{t("执行拓扑图")}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={true}
                className="changes-pane-tab active"
                data-testid="right-pane-tab-changes"
              >
                <FileDiff size={14} aria-hidden="true" />
                <span>{t("文件变更")}</span>
              </button>
            </div>
          ) : (
            <div className="changes-pane-title">
              <FileDiff size={15} className="changes-pane-title-icon" aria-hidden="true" />
              <strong>{t("文件变更")}</strong>
            </div>
          )}
        </div>
        <div className="toolbar-right">
          <button
            type="button"
            className="icon-button"
            data-testid="workspace-changes-close"
            aria-label={hasGraphPane ? t("返回执行拓扑图") : t("关闭文件变更")}
            title={hasGraphPane ? t("返回执行拓扑图") : t("关闭文件变更")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="changes-pane-subtoolbar">
        <div className="changes-pane-summary" data-testid="workspace-changes-summary">
          {summary.totalFiles > 0 ? (
            <>
              <span className="changes-pane-file-count">{fileCountLabel}</span>
              <ChangeDiffStats
                additions={summary.totalAdditions}
                deletions={summary.totalDeletions}
                hideZero
              />
            </>
          ) : (
            <span className="changes-pane-file-count">{t("当前工作区变更")}</span>
          )}
        </div>
        <button
          type="button"
          className="changes-pane-refresh-btn"
          data-testid="workspace-changes-refresh"
          aria-label={t("刷新文件变更")}
          title={t("刷新")}
          disabled={!isLoaded || isRefreshing}
          onClick={onRefresh}
        >
          <RefreshCw size={13} className={isRefreshing ? "spin" : undefined} aria-hidden="true" />
        </button>
      </div>

      <div
        id={id}
        className="changes-pane-body"
        data-testid="workspace-changes-panel"
        role="region"
        aria-label={t("文件变更列表")}
      >
        {!isLoaded ? (
          <div className="changes-pane-state">
            <Loader2 size={14} className="spin" aria-hidden="true" />
            <span>{t("正在读取文件变更…")}</span>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="changes-pane-state changes-panel-empty">
            {t("当前会话尚未产生文件新增、修改或删除")}
          </div>
        ) : (
          <div className="changes-pane-list">
            {visibleFiles.map((item) => (
              <ChangedFileRow
                key={item.path}
                runId={runId}
                scopeKey={scopeKey}
                item={item}
                expanded={expandedPaths.has(item.path)}
                onToggle={toggleFile}
                onOpenFile={onOpenFile}
                loadDiff={loadDiff}
                refreshVersion={refreshVersion}
              />
            ))}
            {omittedCount > 0 && (
              <div className="changes-panel-truncated" data-testid="workspace-changes-truncated">
                {t("… 其余 {0} 个文件变更已省略", omittedCount)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
