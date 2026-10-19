import React from "react";
import { FileCode2, FileMinus2, FilePlus2, FileSymlink, Loader2 } from "lucide-react";
import type { FileChangeItem } from "../../types";
import { ChangeDiffStats } from "./ChangeDiffStats";

interface ChangedFileRowProps {
  item: FileChangeItem;
}

/** A flat, read-only row: the backend owns status and line counts. */
export const ChangedFileRow = React.memo(function ChangedFileRow({ item }: ChangedFileRowProps) {
  const Icon = { added: FilePlus2, modified: FileCode2, deleted: FileMinus2, renamed: FileSymlink }[item.status]
    || FileCode2;
  const path = item.oldPath ? `${item.oldPath} → ${item.path}` : item.path;

  return <div className="changed-file-item" data-testid="changed-file-item"
    data-file-path={item.path} data-status={item.status}>
    <div className="changed-file-row">
      {/* A tinted chip gives the 11px glyph enough weight without bolding text. */}
      <span className="changed-file-icon-chip" aria-hidden="true">
        {item.isRunning
          ? <Loader2 size={11} strokeWidth={2.6} className="changed-file-icon spin" />
          : <Icon size={11} strokeWidth={2.6} className="changed-file-icon" />}
      </span>
      <span className="changed-file-path">{path}</span>
      <ChangeDiffStats additions={item.additions} deletions={item.deletions} />
    </div>
  </div>;
});
