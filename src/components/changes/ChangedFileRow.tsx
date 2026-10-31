import React from "react";
import { FileCode2, FileMinus2, FilePlus2, FileSymlink, Loader2 } from "lucide-react";
import { t } from "../../i18n";
import type { FileChangeItem } from "../../types";
import { ChangeDiffStats } from "./ChangeDiffStats";

interface ChangedFileRowProps {
  item: FileChangeItem;
  onOpen?: (item: FileChangeItem) => void;
}

/** The backend owns status and line counts; a click only asks it to reveal the
 * file in the owning workspace or source repository. */
export const ChangedFileRow = React.memo(function ChangedFileRow({ item, onOpen }: ChangedFileRowProps) {
  const Icon = { added: FilePlus2, modified: FileCode2, deleted: FileMinus2, renamed: FileSymlink }[item.status]
    || FileCode2;
  const path = item.oldPath ? `${item.oldPath} → ${item.path}` : item.path;
  // A deleted file has no surviving path to hand to the opener.
  const canOpen = item.status !== "deleted" && !!onOpen;

  return <div className="changed-file-item" data-testid="changed-file-item"
    data-file-path={item.path} data-status={item.status}>
    <button type="button" className="changed-file-row" disabled={!canOpen}
      onClick={() => onOpen?.(item)}
      aria-label={canOpen ? t("用默认应用打开 {0}", item.path) : undefined}
      title={canOpen ? t("用默认应用打开 {0}", item.path) : t("已删除的文件无法打开")}>
      {/* A tinted chip gives the 11px glyph enough weight without bolding text. */}
      <span className="changed-file-icon-chip" aria-hidden="true">
        {item.isRunning
          ? <Loader2 size={11} strokeWidth={2.6} className="changed-file-icon spin" />
          : <Icon size={11} strokeWidth={2.6} className="changed-file-icon" />}
      </span>
      <span className="changed-file-path">{path}</span>
      {/* Deleted files have no surviving lines to count, so the row omits stats. */}
      {item.status !== "deleted" && <ChangeDiffStats additions={item.additions} deletions={item.deletions} />}
    </button>
  </div>;
});
