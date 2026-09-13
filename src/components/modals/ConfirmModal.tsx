import React from "react";
import { AlertTriangle, Trash2 } from "lucide-react";

export interface ConfirmModalState {
  title: string;
  message: string;
  detail?: string;
  confirmText: string;
  danger?: boolean;
  onConfirm: () => void;
}

interface ConfirmModalProps {
  config: ConfirmModalState | null;
  onClose: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = React.memo(({ config, onClose }) => {
  if (!config) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="confirm-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-header">
          <div className={`confirm-icon-wrap ${config.danger ? "danger" : ""}`}>
            {config.danger ? <AlertTriangle size={18} /> : <Trash2 size={18} />}
          </div>
          <div className="confirm-texts">
            <h4>{config.title}</h4>
            <p>{config.message}</p>
            {config.detail && (
              <small style={{ whiteSpace: "pre-wrap" }}>{config.detail}</small>
            )}
          </div>
        </div>
        <div className="confirm-actions">
          <button
            type="button"
            className="cancel-btn"
            onClick={onClose}
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
      </div>
    </div>
  );
});

ConfirmModal.displayName = "ConfirmModal";
