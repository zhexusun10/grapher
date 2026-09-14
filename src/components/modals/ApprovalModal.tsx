import React from "react";
import { ShieldCheck, Play, X } from "lucide-react";
import { Snapshot, Config } from "../../types";

interface ApprovalModalProps {
  isOpen: boolean;
  onClose: () => void;
  state: Snapshot;
  config: Config;
  busy: boolean;
  onAdjustPlan: () => void;
  onApprove: () => void;
}

export const ApprovalModal: React.FC<ApprovalModalProps> = React.memo(({
  isOpen,
  onClose,
  state,
  config,
  busy,
  onAdjustPlan,
  onApprove,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header>
          <h2 id="modal-title">审批执行图计划</h2>
          <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="approval-summary">
          <ShieldCheck size={32} />
          <h3>{state.graph.nodes.length} 个节点，{state.plan?.executionBatches.length ?? 0} 个执行层</h3>
          <p>{state.graph.originalGoal}</p>
          <ul>
            <li>
              Graph 模式的节点在用户仓库旁的 .grapher-worktrees 中执行，完成后自动合并回用户仓库。
            </li>
            <li>每个节点分配独立隔离会话；验证失败最多自动反馈重试 {state.config?.maxFeedback ?? config.maxFeedback} 次。</li>
            <li>节点执行期间在隔离工作区内修改文件；整图完成后会将结果写回 {state.config?.repository || config.repository}。</li>
            <li className="warning">
              Execution Instance 可执行 shell 指令并调用模型，请审视节点任务定义后再行批准。
            </li>
          </ul>
          {state.plan?.warnings.map((warning) => (
            <p className="warning" key={warning}>{warning}</p>
          ))}
        </div>
        <footer>
          <button
            type="button"
            className="secondary"
            onClick={onAdjustPlan}
          >
            调整计划
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={onApprove}
          >
            <Play size={14} />确认审批并启动
          </button>
        </footer>
      </section>
    </div>
  );
});

ApprovalModal.displayName = "ApprovalModal";

export default ApprovalModal;
