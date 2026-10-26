import React, { useMemo, useRef } from "react";
import { ChevronRight } from "lucide-react";
import { t } from "../../i18n";
import type { FileChangeItem, FileChangeSummary } from "../../types";
import { AnimatedDisclosure } from "../AnimatedDisclosure";
import { ChangedFileRow } from "./ChangedFileRow";
import "./WorkspaceChanges.css";

interface WorkspaceChangesTriggerProps {
  summary: FileChangeSummary;
  panelId: string;
  isOpen: boolean;
  onToggle: React.MouseEventHandler<HTMLButtonElement>;
}

/** Same trigger treatment as "Workspace and session details"; no leading icon,
 * no totals, and the same chevron that rotates in place. */
export const WorkspaceChangesTrigger = React.memo(function WorkspaceChangesTrigger({
  summary, panelId, isOpen, onToggle,
}: WorkspaceChangesTriggerProps) {
  return <button type="button" className="workspace-details-trigger workspace-changes-trigger" data-testid="workspace-changes-trigger"
    onClick={onToggle} aria-expanded={isOpen} aria-controls={isOpen ? panelId : undefined}>
    <span>{summary.totalFiles > 0 ? t("{0} 个文件变更", summary.totalFiles) : t("暂无文件变更")}</span>
    <ChevronRight size={11} className={`workspace-details-chevron ${isOpen ? "open" : ""}`} aria-hidden="true" />
  </button>;
});

/** Rendering tens of thousands of rows freezes the workbench even while the
 * disclosure stays collapsed, so only the first slice is mounted; the rest is
 * implied by a trailing ellipsis row. */
export const MAX_RENDERED_FILE_CHANGES = 50;

const LEAD_STATUSES = new Set<FileChangeItem["status"]>(["added", "deleted"]);

/** Added/deleted files lead (they are the most notable); within each group the
 * rows rank by total changed lines so the cap keeps the heaviest edits. */
function sortFileChangesForDisplay(files: FileChangeItem[]): FileChangeItem[] {
  return [...files].sort((a, b) => {
    const lead = Number(LEAD_STATUSES.has(b.status)) - Number(LEAD_STATUSES.has(a.status));
    if (lead !== 0) return lead;
    return (b.additions + b.deletions) - (a.additions + a.deletions);
  });
}

interface WorkspaceChangesPanelProps {
  id: string;
  summary: FileChangeSummary;
  open: boolean;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}

/** Expands in the same slot and width as the session-details body, using the
 * same height/opacity transition and bounded scroll follow. */
export const WorkspaceChangesPanel = React.memo(function WorkspaceChangesPanel({
  id, summary, open, scrollContainerRef, onBeforeToggle, onAfterToggle,
}: WorkspaceChangesPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const orderedFiles = useMemo(
    () => sortFileChangesForDisplay(summary.files),
    [summary.files],
  );
  const truncated = orderedFiles.length > MAX_RENDERED_FILE_CHANGES;
  const visibleFiles = truncated
    ? orderedFiles.slice(0, MAX_RENDERED_FILE_CHANGES)
    : orderedFiles;

  return <div ref={rootRef} className="workspace-changes">
    <AnimatedDisclosure
      open={open}
      panelRef={rootRef}
      scrollContainerRef={scrollContainerRef}
      onBeforeToggle={onBeforeToggle}
      onAfterToggle={onAfterToggle}
    >
      <div id={id} className="workspace-changes-panel"
        data-testid="workspace-changes-panel" role="region" aria-label={t("文件变更列表")}>
        {summary.files.length
          ? <>
              {visibleFiles.map(item => <ChangedFileRow key={item.path} item={item} />)}
              {truncated && <div className="changes-panel-truncated" data-testid="workspace-changes-truncated">
                {t("… 其余 {0} 个文件变更已省略", Math.max(0, summary.totalFiles - MAX_RENDERED_FILE_CHANGES))}
              </div>}
            </>
          : <div className="changes-panel-empty">{t("当前会话尚未产生文件新增、修改或删除")}</div>}
      </div>
    </AnimatedDisclosure>
  </div>;
});
