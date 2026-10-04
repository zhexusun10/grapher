import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { Check, Copy, Pencil, X, Sparkles, ChevronLeft, ChevronRight } from "lucide-react";
import { t } from "../../i18n";
import { MarkdownRenderer } from "../MarkdownRenderer";
import type { ChatMessageVersion } from "../../types";

export interface NodeTaskCardProps {
  nodeName: string;
  taskText: string;
  versions?: ChatMessageVersion[];
  currentVersionIndex?: number;
  onSwitchVersion?: (targetIndex: number) => void;
  editing: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onEdit?: () => void;
  onCancel: () => void;
  onSave: (value: string) => void;
  disabled?: boolean;
}

function fallbackCopy(text: string, onSuccess: () => void) {
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
    onSuccess();
  } catch {
    // ignore
  }
}

export const NodeTaskCard: React.FC<NodeTaskCardProps> = React.memo(({
  nodeName,
  taskText,
  versions,
  currentVersionIndex = 0,
  onSwitchVersion,
  editing,
  draft,
  onDraftChange,
  onEdit,
  onCancel,
  onSave,
  disabled = false,
}) => {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (editing && textareaRef.current) {
      const textarea = textareaRef.current;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.max(120, textarea.scrollHeight)}px`;
    }
  }, [editing, draft]);

  useLayoutEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      const end = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(end, end);
    }
  }, [editing]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!taskText) return;
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);

    const onSuccess = () => {
      setCopied(true);
      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
      }, 1500);
    };

    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(taskText).then(onSuccess).catch(() => {
        fallbackCopy(taskText, onSuccess);
      });
    } else {
      fallbackCopy(taskText, onSuccess);
    }
  };

  const handleSave = () => {
    const value = draft.trim();
    if (!value || disabled) return;
    onSave(value);
  };

  return (
    <div className={`node-task-card${editing ? " editing" : ""}`}>
      <div className="node-task-card-header">
        <div className="node-task-header-left">
          <div className="node-task-badge">
            <Sparkles size={12} className="node-task-badge-icon" />
            <span>{t("节点任务目标")}</span>
          </div>
          <span className="node-task-name" title={nodeName}>
            {nodeName}
          </span>
          {versions && versions.length > 1 && onSwitchVersion && (
            <div className="node-task-version-switcher" role="group" aria-label={t("版本历史")}>
              <button
                type="button"
                className="node-task-version-btn"
                disabled={currentVersionIndex <= 0}
                onClick={() => onSwitchVersion(currentVersionIndex - 1)}
                title={t("上一版本")}
                aria-label={t("上一版本")}
              >
                <ChevronLeft size={12} />
              </button>
              <span className="node-task-version-text">
                v{currentVersionIndex + 1}/{versions.length}
              </span>
              <button
                type="button"
                className="node-task-version-btn"
                disabled={currentVersionIndex >= versions.length - 1}
                onClick={() => onSwitchVersion(currentVersionIndex + 1)}
                title={t("下一版本")}
                aria-label={t("下一版本")}
              >
                <ChevronRight size={12} />
              </button>
            </div>
          )}
        </div>

        <div className="node-task-card-tools">
          {editing ? (
            <>
              <button
                type="button"
                className="node-task-tool-btn cancel"
                onClick={onCancel}
                title={t("取消修改 (Esc)")}
                aria-label={t("取消修改")}
              >
                <X size={13} />
                <span>{t("取消")}</span>
              </button>
              <button
                type="button"
                className="node-task-tool-btn save"
                onClick={handleSave}
                disabled={disabled || !draft.trim()}
                title={t("保存修改 (Ctrl + Enter)")}
                aria-label={t("保存修改")}
              >
                <Check size={13} />
                <span>{t("保存")}</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`node-task-tool-btn copy${copied ? " copied" : ""}`}
                onClick={handleCopy}
                title={copied ? t("已复制") : t("复制任务指令")}
                aria-label={copied ? t("已复制") : t("复制任务指令")}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                <span>{copied ? t("已复制") : t("复制")}</span>
              </button>
              {onEdit && (
                <button
                  type="button"
                  className="node-task-tool-btn edit"
                  onClick={onEdit}
                  disabled={disabled}
                  title={t("编辑任务指令")}
                  aria-label={t("编辑任务指令")}
                >
                  <Pencil size={13} />
                  <span>{t("编辑")}</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="node-task-card-body">
        {editing ? (
          <div className="node-task-edit-container">
            <textarea
              ref={textareaRef}
              className="node-task-edit-textarea"
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
                compositionEndedAtRef.current = Date.now();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  onCancel();
                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  if (
                    e.nativeEvent.isComposing ||
                    composingRef.current ||
                    e.keyCode === 229 ||
                    Date.now() - compositionEndedAtRef.current < 50
                  ) {
                    return;
                  }
                  e.preventDefault();
                  handleSave();
                }
              }}
              placeholder={t("输入节点任务指令...")}
            />
            <div className="node-task-edit-footer">
              <span className="node-task-edit-hint">{t("按 Esc 取消，Ctrl + Enter 保存")}</span>
            </div>
          </div>
        ) : (
          <div className="node-task-content">
            <MarkdownRenderer content={taskText || t("（未指定节点任务）")} />
          </div>
        )}
      </div>
    </div>
  );
});

NodeTaskCard.displayName = "NodeTaskCard";
