import { t, localizeError } from "../../i18n";
import React, { useEffect } from "react";
import { motion, useReducedMotion } from "motion/react";
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
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, busy]);

  if (!isOpen) return null;

  return (
    <motion.div
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <motion.section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.98, y: reduceMotion ? 0 : 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.98, y: reduceMotion ? 0 : 6 }}
        transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
      >
        <header>
          <h2 id="modal-title">{t("审批执行图计划")}</h2>
          <button className="icon-button" aria-label={t("关闭弹窗")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="approval-summary">
          <ShieldCheck size={32} />
          <h3>{state.graph.nodes.length}{t(" 个节点，")}{state.plan?.executionBatches.length ?? 0}{t(" 个执行层")}</h3>
          <ul>
            <li>
              {t("Graph 模式的节点在用户仓库旁的 .grapher-worktrees 中执行，完成后自动合并回用户仓库。")}</li>
            <li>{t("Planner 已直接修改源项目；拒绝计划不会撤销这些修改。")}</li>
            <li>{t("批准会将源项目当前变更暂存并提交为基线，包括您此前未提交的修改；这会改变 Git 暂存状态。被 Git 忽略的未跟踪文件不会随快照传递。")}</li>
            <li>{t("每个节点分配独立隔离会话；验证失败最多自动反馈重试 3 次。")}</li>
            <li>{t("节点执行期间在隔离工作区内修改文件；整图完成后会将结果写回 {0}。", state.config?.repository || config.repository)}</li>
            {state.environmentPolicy && <li className="warning">{t("环境由 Runtime 自动准入和绑定，不需要选择模式或填写环境配置。受管环境不会搬回源项目；能力不足时明确失败，不请求用户选择替代方案。")}</li>}
            {state.config?.environment && <li className="warning">
              {t("原生 workspace 环境范围：{0}；默认入口：{1}。环境不搬回源项目，以结果描述交付；未验证的设备、跨槽路径及系统快照要求会阻塞。", state.config.environment.scopes.join(", "), state.config.environment.launch.entry)}
            </li>}
            <li className="warning">
              {t("Execution Instance 可执行 shell 指令并调用模型，请审视节点任务定义后再行批准。")}</li>
          </ul>
          {state.plan?.warnings.map((warning) => (
            <p className="warning" key={warning}>{localizeError(warning)}</p>
          ))}
        </div>
        <footer>
          <button
            type="button"
            className="secondary"
            onClick={onAdjustPlan}
          >
            {t("调整计划")}</button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={onApprove}
          >
            <Play size={14} />{t("确认审批并启动")}</button>
        </footer>
      </motion.section>
    </motion.div>
  );
});

ApprovalModal.displayName = "ApprovalModal";

export default ApprovalModal;
