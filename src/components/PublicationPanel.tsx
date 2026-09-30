import { t, locale, localizeError } from "../i18n";
import { useState, useRef, useEffect } from "react";
import { X, Loader2 } from "lucide-react";
import type { Execution, Publication } from "../types";
import { ExecutionTranscript } from "./ExecutionTranscript";
import "./PublicationPanel.css";

const labels = { publishing: t("正在写回工作文件夹"), merging: t("merger 正在修复冲突"), completed: t("已写回工作文件夹"), failed: t("回写失败，需要处理") };
const executionLabels: Record<string, string> = { running: t("执行中"), completed: t("已完成"), failed: t("失败") };

// Global set to remember dismissed publication results across run switches
const dismissedPublicationResults = new Set<string>();

export function PublicationPanel({ runId = "", publication, mergers, busy, onRetry }: {
  runId?: string;
  publication?: Publication | null; mergers: Execution[]; busy: boolean; onRetry: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [attemptId, setAttemptId] = useState("");
  const [dismissedResult, setDismissedResult] = useState("");

  // Record if this run was ALREADY completed at the moment this card was opened / mounted.
  // When opening an already completed conversation card, this prevents the completed banner from popping up.
  const wasCompletedOnMount = useRef(publication?.status === "completed");

  const execution = mergers.find(e => e.id === attemptId) ?? mergers.at(-1);
  if (!publication) return null;

  const resultId = `${runId}:${publication.head}:${publication.completedAt}`;

  // If this run was already completed when opened, or has been dismissed, suppress the completed banner
  if (publication.status === "completed") {
    if (wasCompletedOnMount.current || dismissedResult === resultId || dismissedPublicationResults.has(resultId)) {
      return null;
    }
  }

  // Auto-dismiss completed banner after 6 seconds when completing live in the foreground
  useEffect(() => {
    if (publication.status === "completed" && !wasCompletedOnMount.current) {
      const timer = setTimeout(() => {
        dismissedPublicationResults.add(resultId);
        setDismissedResult(resultId);
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [publication.status, resultId]);

  const handleDismiss = () => {
    dismissedPublicationResults.add(resultId);
    setDismissedResult(resultId);
  };

  return <section className={`publication-panel ${publication.status}`} aria-label={t("Graph 结果回写")}>
    <div className="publication-heading">
      <strong role="status" aria-live="polite">
        {(publication.status === "publishing" || publication.status === "merging") && (
          <Loader2 size={15} className="spin publication-spinner" />
        )}
        {labels[publication.status]}
      </strong>
      <span title={t("每个终点节点的提交已包含其上游依赖的结果")}>{publication.heads.length}{t(" 个终点结果（含上游变更）")}</span>
      {publication.status === "failed" && <button type="button" className="secondary" disabled={busy} onClick={onRetry}>{t("重试回写")}</button>}
      {publication.status === "completed" && (
        <button
          type="button"
          className="publication-close"
          aria-label={t("关闭回写结果")}
          onClick={handleDismiss}
        >
          <X size={16} />
        </button>
      )}
    </div>
    <p className="publication-target">{t("目标目录：")}<code>{publication.repository}</code></p>
    {publication.status !== "completed" && publication.status !== "failed" && <p>{t("节点执行已结束。正在写入最终结果，请等待回写完成后再修改目标目录。")}</p>}
    {publication.error && <p role="alert" className="publication-error">{localizeError(publication.error)}</p>}
    {publication.status === "failed" && <p>{t("节点结果及合并现场已保留。处理本地改动或冲突后重试；已完成的提交会跳过，不重新运行图节点。")}</p>}
    {publication.head && <p>{t("最终提交：")}<code>{publication.head}</code>{publication.completedAt ? ` · ${new Date(publication.completedAt).toLocaleString(locale)}` : ""}</p>}
    {execution && <details className="publication-mergers" open={publication.status === "merging" || detailsOpen}
      onToggle={event => setDetailsOpen(event.currentTarget.open)}>
      <summary>merger · Execution Instance · {mergers.length}{t(" 次执行")}</summary>
      <label>{t("执行记录 ")}<select aria-label={t("merger 执行记录")} value={execution.id} onChange={e => setAttemptId(e.target.value)}>
        {mergers.map(e => <option key={e.id} value={e.id}>#{e.attempt} · {executionLabels[e.status] ?? e.status} · {new Date(e.startedAt).toLocaleString(locale)}</option>)}
      </select></label>
      <p>{t("状态：")}{executionLabels[execution.status] ?? execution.status}{t(" · 会话：")}<code>{execution.sessionId}</code></p>
      <p>{t("工作目录：")}<code>{execution.worktree}</code></p>
      {(detailsOpen || publication.status === "merging") && <div className="publication-transcript"><ExecutionTranscript key={execution.id} runId={runId} execution={execution} /></div>}
      <p>Before: <code>{execution.before}</code> · After: <code>{execution.after ?? t("待提交")}</code></p>
    </details>}
  </section>;
}
