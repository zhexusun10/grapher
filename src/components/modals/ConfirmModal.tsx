import { t } from "../../i18n";
import React, { useId } from "react";
import { motion, useReducedMotion } from "motion/react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";

export interface ConfirmModalState {
  title: string;
  message: string;
  detail?: string;
  confirmText: string;
  danger?: boolean;
  icon?: React.ReactNode;
  onConfirm: () => void;
  onCancel?: () => void;
}

interface ConfirmModalProps {
  config: ConfirmModalState | null;
  onClose: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = React.memo(({ config, onClose }) => {
  const reduceMotion = useReducedMotion();
  const titleId = useId();
  const messageId = useId();
  const detailId = useId();
  const cancel = () => {
    config?.onCancel?.();
    onClose();
  };
  const dialogRef = useDialogFocus<HTMLDivElement>({
    open: config !== null,
    onClose: cancel,
    initialFocus: ".cancel-btn",
  });

  if (!config) return null;

  return (
    <motion.div
      className="modal-backdrop confirm-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <motion.div
        className="confirm-dialog"
        ref={dialogRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${messageId}${config.detail ? ` ${detailId}` : ""}`}
        initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.96, y: reduceMotion ? 0 : 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.97, y: reduceMotion ? 0 : 6 }}
        transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-header">
          <div className={`confirm-icon-wrap ${config.danger ? "danger" : ""}`}>
            {config.icon ?? (config.danger ? <AlertTriangle size={18} /> : <Trash2 size={18} />)}
          </div>
          <div className="confirm-texts">
            <h4 id={titleId}>{config.title}</h4>
            <p id={messageId}>{config.message}</p>
            {config.detail && (
              <small id={detailId} style={{ whiteSpace: "pre-wrap" }}>{config.detail}</small>
            )}
          </div>
        </div>
        <div className="confirm-actions">
          <button
            type="button"
            className="cancel-btn"
            onClick={cancel}
          >
            {t("取消")}</button>
          <button
            type="button"
            className={config.danger ? "danger-btn" : "primary-btn"}
            onClick={() => {
              const action = config.onConfirm;
              onClose();
              action();
            }}
          >
            {config.confirmText}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
});

ConfirmModal.displayName = "ConfirmModal";
