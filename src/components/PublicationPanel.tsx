import { useState } from "react";
import type { Execution, Publication } from "../types";
import { VirtualizedTranscript } from "./VirtualizedTranscript";
import "./PublicationPanel.css";

const labels = { publishing: "正在合并回写", merging: "merger 正在修复冲突", completed: "已写回工作文件夹", failed: "回写失败，需要处理" };
const executionLabels: Record<string, string> = { running: "执行中", completed: "已完成", failed: "失败" };

export function PublicationPanel({ publication, mergers, busy, onRetry }: {
  publication?: Publication | null; mergers: Execution[]; busy: boolean; onRetry: () => void;
}) {
  const [attemptId, setAttemptId] = useState("");
  const execution = mergers.find(e => e.id === attemptId) ?? mergers.at(-1);
  if (!publication) return null;
  return <section className={`publication-panel ${publication.status}`} aria-label="Graph 结果回写">
    <div className="publication-heading">
      <strong role="status" aria-live="polite">{labels[publication.status]}</strong>
      <span>{publication.heads.length} 个节点结果</span>
      {publication.status === "failed" && <button type="button" className="secondary" disabled={busy} onClick={onRetry}>重试回写</button>}
    </div>
    <p className="publication-target">目标目录：<code>{publication.repository}</code></p>
    {publication.status !== "completed" && publication.status !== "failed" && <p>节点执行已结束。正在写入最终结果，请等待回写完成后再修改目标目录。</p>}
    {publication.error && <p role="alert" className="publication-error">{publication.error}</p>}
    {publication.status === "failed" && <p>节点结果及合并现场已保留。处理本地改动或冲突后重试；已完成的提交会跳过，不重新运行图节点。</p>}
    {publication.head && <p>最终提交：<code>{publication.head}</code>{publication.completedAt ? ` · ${new Date(publication.completedAt).toLocaleString()}` : ""}</p>}
    {execution && <details className="publication-mergers" open={publication.status === "merging"}>
      <summary>merger · Execution Instance · {mergers.length} 次执行</summary>
      <label>执行记录 <select aria-label="merger 执行记录" value={execution.id} onChange={e => setAttemptId(e.target.value)}>
        {mergers.map(e => <option key={e.id} value={e.id}>#{e.attempt} · {executionLabels[e.status] ?? e.status} · {new Date(e.startedAt).toLocaleString()}</option>)}
      </select></label>
      <p>状态：{executionLabels[execution.status] ?? execution.status} · 会话：<code>{execution.sessionId}</code></p>
      <p>工作目录：<code>{execution.worktree}</code></p>
      <div className="publication-transcript"><VirtualizedTranscript output={execution.output} /></div>
      <p>Before: <code>{execution.before}</code> · After: <code>{execution.after ?? "待提交"}</code></p>
    </details>}
  </section>;
}
