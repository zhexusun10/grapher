import React, { useEffect } from "react";
import { motion } from "motion/react";
import { AlertTriangle, Trash2 } from "lucide-react";

export interface ConfirmModalState {
  title: string;
  message: string;
  detail?: string;
  confirmText: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

interface ConfirmModalProps {
  config: ConfirmModalState | null;
  onClose: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = React.memo(({ config, onClose }) => {
  const cancel = () => {
    config?.onCancel?.();
    onClose();
  };
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [config, onClose]);

  if (!config) return null;

  return (
    <motion.div
      className="modal-backdrop confirm-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      onClick={cancel}
    >
      <motion.div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        initial={{ opacity: 0, scale: 0.94, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 8 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-header">
          <div className={`confirm-icon-wrap ${config.danger ? "danger" : ""}`}>
            {config.danger ? <AlertTriangle size={18} /> : <Trash2 size={18} />}
          </div>
          <div className="confirm-texts">
            <h4 id="confirm-dialog-title">{config.title}</h4>
            <p id="confirm-dialog-message">{config.message}</p>
            {config.detail && (
              <small style={{ whiteSpace: "pre-wrap" }}>{config.detail}</small>
            )}
          </div>
        </div>
        <div className="confirm-actions">
          <button
            type="button"
            className="cancel-btn"
            onClick={cancel}
          >
            取消
          </button>
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
