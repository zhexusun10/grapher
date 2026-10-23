import { t, locale } from "../i18n";
import React, { useState, useMemo } from "react";
import { CheckCircle2, FolderGit2, Clock, Copy, Check, GitMerge } from "lucide-react";
import type { Snapshot, Execution } from "../types";
import { ExecutionTranscript } from "./ExecutionTranscript";
import "./PublicationCompletedDetails.css";

interface PublicationCompletedDetailsProps {
  state: Snapshot;
  repository?: string;
}

/** Write-back details embedded in the execution graph overview. */
export const PublicationCompletedDetails: React.FC<PublicationCompletedDetailsProps> = React.memo(({
  state,
  repository,
}) => {
  const [copiedRepo, setCopiedRepo] = useState(false);
  const [mergerDetailsOpen, setMergerDetailsOpen] = useState(false);
  const [selectedMergerId, setSelectedMergerId] = useState("");
  const mergerSelectId = React.useId();

  const publication = state.publication;
  const targetRepo = publication?.repository || repository || state.config?.repository || "";
  const completedAt = publication?.completedAt || (state.executions.find(e => e.completedAt)?.completedAt) || null;

  const mergers: Execution[] = useMemo(() => {
    return (state.mergers ?? []).filter((m) => m.node === "merger");
  }, [state.mergers]);

  const activeMerger = mergers.find(m => m.id === selectedMergerId) ?? mergers[mergers.length - 1];

  const handleCopyRepo = async () => {
    if (!targetRepo) return;
    try {
      await navigator.clipboard.writeText(targetRepo);
      setCopiedRepo(true);
      setTimeout(() => setCopiedRepo(false), 2000);
    } catch { }
  };

  const completedAtStr = completedAt ? new Date(completedAt).toLocaleString(locale) : "";
  const headsCount = publication?.heads?.length ?? state.graph.nodes.length;

  return (
    <div className="plan-publication-details" data-testid="publication-completed-details">
      <div className="pub-card-body">
        <div className="pub-card-fields-grid">
          {targetRepo && (
            <div className="pub-card-row">
              <span className="pub-card-label">
                <FolderGit2 size={13} />
                <span>{t("目标工作区")}</span>
              </span>
              <div className="pub-card-value-box">
                <code className="pub-card-path" title={targetRepo}>{targetRepo}</code>
                <button
                  type="button"
                  className={`pub-card-copy-btn ${copiedRepo ? "copied" : ""}`}
                  onClick={handleCopyRepo}
                  title={t("复制工作区目录")}
                  aria-label={t("复制工作区目录")}
                >
                  {copiedRepo ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </div>
            </div>
          )}

          {completedAtStr && (
            <div className="pub-card-row">
              <span className="pub-card-label">
                <Clock size={13} />
                <span>{t("完成时间")}</span>
              </span>
              <span className="pub-card-time">{completedAtStr}</span>
            </div>
          )}
        </div>

        <div className="pub-card-summary-tip">
          <CheckCircle2 size={14} className="pub-card-icon" aria-hidden="true" />
          <span>
            {t("已完成所有 ")}{state.graph.nodes.length}{t(" 个规划节点的执行，")}{publication?.heads ? t("{0} 个拓扑终点及上游变更已聚合并写回目标目录。", headsCount) : t("已聚合写入源文件工作区。")}
          </span>
        </div>

        {mergers.length > 0 && activeMerger && (
          <details
            className="pub-card-mergers"
            open={mergerDetailsOpen}
            onToggle={(e) => setMergerDetailsOpen(e.currentTarget.open)}
          >
            <summary className="pub-card-mergers-summary">
              <GitMerge size={12} />
              <span>{t("merger 冲突修复现场 (")}{mergers.length}{t(" 次执行)")}</span>
            </summary>
            <div className="pub-card-mergers-body">
              <div className="pub-card-mergers-select-row">
                <label htmlFor={mergerSelectId}>{t("选择执行记录：")}</label>
                <select
                  id={mergerSelectId}
                  className="pub-card-merger-select"
                  value={activeMerger.id}
                  onChange={(e) => setSelectedMergerId(e.target.value)}
                >
                  {mergers.map((m) => (
                    <option key={m.id} value={m.id}>
                      #{m.attempt} · {m.status} · {new Date(m.startedAt).toLocaleTimeString(locale)}
                    </option>
                  ))}
                </select>
              </div>
              <p className="pub-card-merger-info">
                {t("会话：")}<code>{activeMerger.sessionId}</code>{t(" · 目录：")}<code>{activeMerger.worktree}</code>
              </p>
              <div className="pub-card-merger-transcript">
                <ExecutionTranscript key={activeMerger.id} runId={state.runId} execution={activeMerger} />
              </div>
              <p className="pub-card-merger-commits">
                Before: <code>{activeMerger.before || t("未快照")}</code> · After: <code>{activeMerger.after === "" ? t("源目录直改（无快照）") : activeMerger.after ?? t("内部快照")}</code>
              </p>
            </div>
          </details>
        )}
      </div>
    </div>
  );
});
