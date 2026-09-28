import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronLeft, ChevronRight, Copy, Pencil, X } from "lucide-react";
import type { ChatMessageVersion, ImageAttachment } from "../../types";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { useSmoothStreamText } from "../../hooks/useSmoothStreamText";

function copyFallback(text: string, onSuccess: () => void) {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const successful = document.execCommand("copy");
    document.body.removeChild(textarea);
    if (successful) onSuccess();
  } catch (err) {
    console.error("Failed to copy", err);
  }
}

export const StreamingAssistantBubble: React.FC<{ content: string; isStreaming: boolean }> = React.memo(
  ({ content, isStreaming }) => {
    const smoothText = useSmoothStreamText(content, isStreaming);
    return <MarkdownRenderer content={smoothText} isStreaming={isStreaming} />;
  }
);
StreamingAssistantBubble.displayName = "StreamingAssistantBubble";

export function EditableUserBubble({
  text,
  images,
  editing,
  draft,
  onDraftChange,
  onEdit,
  onCancel,
  onSend,
  disabled,
  versions,
  currentVersionIndex,
  onSwitchVersion,
}: {
  text: string;
  images?: ImageAttachment[];
  editing: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onEdit?: () => void;
  onCancel: () => void;
  onSend: (value: string) => boolean | void | Promise<boolean | void>;
  disabled?: boolean;
  versions?: ChatMessageVersion[];
  currentVersionIndex?: number;
  onSwitchVersion?: (targetIndex: number) => void;
}) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const [initialSize, setInitialSize] = useState<{ width: number; height: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!text) return;
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    const onSuccess = () => {
      setCopied(true);
      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
      }, 1500);
    };

    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
        copyFallback(text, onSuccess);
      });
    } else {
      copyFallback(text, onSuccess);
    }
  };

  useLayoutEffect(() => {
    if (!editing) {
      setInitialSize(null);
      return;
    }
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      const scrollH = textarea.scrollHeight;
      if (scrollH > 0) {
        textarea.style.height = `${scrollH}px`;
      }
    }
  }, [editing, draft]);

  useLayoutEffect(() => {
    if (editing) {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.focus();
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
      }
    }
  }, [editing]);

  const submit = () => {
    const value = draft.trim();
    if (value && !disabled) onSend(value);
  };

  const beginEdit = () => {
    if (bubbleRef.current) {
      const { width, height } = bubbleRef.current.getBoundingClientRect();
      setInitialSize({ width, height });
    }
    onEdit?.();
  };

  const isShorter = draft.trim().length < text.trim().length;
  const isLongDraft = draft.trim().length > 40 || draft.includes("\n") || (initialSize ? initialSize.width > 420 : false);

  return (
    <div className={`chat-user-message-card-wrapper${editing ? " inline-editing" : ""}${editing && isLongDraft ? " expanded" : ""}`}>
      <div className="chat-bubble-body">
        {editing ? (
          <div className="chat-bubble-actions">
            <button
              type="button"
              className="chat-bubble-action-btn"
              onClick={onCancel}
              title="取消修改 (Esc)"
              aria-label="取消修改"
            >
              <X size={14} />
            </button>
            <button
              type="button"
              className="chat-bubble-action-btn send"
              onClick={submit}
              disabled={disabled || !draft.trim()}
              title="回退并重试 (Enter)"
              aria-label="回退并重试"
            >
              <ArrowUp size={14} />
            </button>
          </div>
        ) : (
          <div className="chat-bubble-left-tools">
            {versions && versions.length > 1 && currentVersionIndex !== undefined && onSwitchVersion ? (
              <div className="chat-branch-pager">
                <button
                  type="button"
                  className="chat-branch-pager-btn"
                  disabled={currentVersionIndex <= 0 || disabled}
                  onClick={() => onSwitchVersion(currentVersionIndex - 1)}
                  title="上一个版本"
                  aria-label="上一个版本"
                >
                  <ChevronLeft size={11} />
                </button>
                <span className="chat-branch-pager-text">
                  {currentVersionIndex + 1}/{versions.length}
                </span>
                <button
                  type="button"
                  className="chat-branch-pager-btn"
                  disabled={currentVersionIndex >= versions.length - 1 || disabled}
                  onClick={() => onSwitchVersion(currentVersionIndex + 1)}
                  title="下一个版本"
                  aria-label="下一个版本"
                >
                  <ChevronRight size={11} />
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className={`chat-message-copy-btn${copied ? " copied" : ""}`}
              onClick={handleCopy}
              title={copied ? "已复制" : "复制消息"}
              aria-label={copied ? "已复制" : "复制消息"}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            {onEdit ? (
              <button
                type="button"
                className="chat-message-edit-btn"
                onClick={beginEdit}
                disabled={disabled}
                title="修改消息并回退重试"
                aria-label="修改消息并回退重试"
              >
                <Pencil size={14} />
              </button>
            ) : null}
          </div>
        )}
        <div
          ref={bubbleRef}
          className={`chat-bubble-user${editing ? " editing" : ""}${editing && isLongDraft ? " expanded" : ""}`}
          style={editing && initialSize && !isShorter && !isLongDraft ? {
            minWidth: `${initialSize.width}px`,
            minHeight: `${initialSize.height}px`,
          } : undefined}
        >
          {images && images.length > 0 && (
            <div className="chat-user-images-preview">
              {images.map((img, idx) => (
                <div key={idx} className="chat-user-image-thumb">
                  <img
                    src={`data:${img.mimeType};base64,${img.data}`}
                    alt={img.name || `图片 ${idx + 1}`}
                    className="chat-user-img"
                  />
                </div>
              ))}
            </div>
          )}
          {editing ? (
            <div className="chat-bubble-edit-grid">
              <span className="chat-bubble-edit-mirror" aria-hidden="true">
                {draft ? (draft.endsWith("\n") ? `${draft} ` : draft) : " "}
              </span>
              <textarea
                ref={textareaRef}
                className="chat-bubble-edit-textarea"
                aria-label="修改消息内容"
                value={draft}
                onChange={(event) => onDraftChange(event.target.value)}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                  compositionEndedAtRef.current = Date.now();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    onCancel();
                  } else if (event.key === "Enter" && !event.shiftKey) {
                    if (
                      event.nativeEvent.isComposing ||
                      composingRef.current ||
                      event.keyCode === 229 ||
                      Date.now() - compositionEndedAtRef.current < 50
                    ) {
                      return;
                    }
                    event.preventDefault();
                    submit();
                  } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    if (
                      event.nativeEvent.isComposing ||
                      composingRef.current ||
                      event.keyCode === 229 ||
                      Date.now() - compositionEndedAtRef.current < 50
                    ) {
                      return;
                    }
                    event.preventDefault();
                    submit();
                  }
                }}
                rows={1}
              />
            </div>
          ) : text}
        </div>
      </div>
    </div>
  );
}
