import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { Check, Copy, Pencil, X } from "lucide-react";
import { t } from "../../i18n";
import { MarkdownRenderer } from "../MarkdownRenderer";

export interface NodeTaskCardProps {
  nodeName: string;
  taskText: string;
  badgeText?: string;
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
  badgeText,
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

  const isChanged = draft.trim() !== taskText.trim();
  const handleSave = () => {
    const value = draft.trim();
    if (!value || !isChanged || disabled) return;
    onSave(value);
  };

  return (
    <div className={`node-task-card${!badgeText ? " inline-tools" : ""}${editing ? " editing" : ""}`}>
      <div className="node-task-card-header">
        {badgeText && <strong className="node-task-title">{badgeText}</strong>}

        <div className="node-task-card-tools">
          {editing ? (
            <>
              <button
                type="button"
                className="tool-copy-btn node-task-tool-btn cancel"
                onClick={onCancel}
                aria-label={t("取消修改")}
              >
                <X size={12} />
              </button>
              <button
                type="button"
                className="tool-copy-btn node-task-tool-btn save"
                onClick={handleSave}
                disabled={disabled || !isChanged || !draft.trim()}
                aria-label={t("保存修改")}
              >
                <Check size={12} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="tool-copy-btn node-task-tool-btn copy"
                onClick={handleCopy}
                aria-label={copied ? t("已复制") : t("复制任务指令")}
              >
                {copied ? <Check size={12} className="copy-icon-check" /> : <Copy size={12} className="copy-icon-copy" />}
              </button>
              {onEdit && (
                <button
                  type="button"
                  className="tool-copy-btn node-task-tool-btn edit"
                  onClick={onEdit}
                  disabled={disabled}
                  aria-label={t("编辑任务指令")}
                >
                  <Pencil size={12} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="node-task-card-body">
        {/* Keep the rendered objective as an inert size reference during editing. */}
        <div className="node-task-content" aria-hidden={editing || undefined} inert={editing}>
          <MarkdownRenderer content={taskText || t("（未指定节点任务）")} />
        </div>
        {editing && (
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
            aria-label={t("输入节点任务指令...")}
            placeholder={t("输入节点任务指令...")}
          />
        )}
      </div>
    </div>
  );
});

NodeTaskCard.displayName = "NodeTaskCard";
