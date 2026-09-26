import React, { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Pencil, X } from "lucide-react";
import type { ImageAttachment } from "../../types";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { useSmoothStreamText } from "../../hooks/useSmoothStreamText";

export const StreamingAssistantBubble: React.FC<{ content: string; isStreaming: boolean }> = React.memo(
  ({ content, isStreaming }) => {
    const smoothText = useSmoothStreamText(content, isStreaming);
    return <MarkdownRenderer content={smoothText} isStreaming={isStreaming} />;
  }
);
StreamingAssistantBubble.displayName = "StreamingAssistantBubble";

export function EditableUserBubble({ text, images, editing, draft, onDraftChange, onEdit, onCancel, onSend, disabled }: {
  text: string;
  images?: ImageAttachment[];
  editing: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onEdit?: () => void;
  onCancel: () => void;
  onSend: (value: string) => boolean | void | Promise<boolean>;
  disabled?: boolean;
}) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [editSize, setEditSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!editing) return;
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    }
  }, [editing]);
  const submit = () => {
    const value = draft.trim();
    if (value && !disabled) onSend(value);
  };
  const beginEdit = () => {
    if (bubbleRef.current) {
      const { width, height } = bubbleRef.current.getBoundingClientRect();
      setEditSize({ width, height });
    }
    onEdit?.();
  };
  return (
    <div className={`chat-user-message-card-wrapper${editing ? " inline-editing" : ""}`}>
      <div className="chat-bubble-body">
        {editing ? (
          <div className="chat-bubble-actions">
            <button type="button" className="chat-bubble-action-btn" onClick={onCancel} title="取消修改" aria-label="取消修改"><X size={14} /></button>
            <button type="button" className="chat-bubble-action-btn send" onClick={submit} disabled={disabled || !draft.trim()} title="发送修改" aria-label="发送修改"><ArrowUp size={14} /></button>
          </div>
        ) : onEdit ? (
          <button type="button" className="chat-message-edit-btn" onClick={beginEdit} disabled={disabled} title="修改" aria-label="修改"><Pencil size={14} /></button>
        ) : null}
        <div
          ref={bubbleRef}
          className={`chat-bubble-user${editing ? " editing" : ""}`}
          style={editing && editSize ? { width: editSize.width, height: editSize.height } : undefined}
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
            <textarea
              ref={textareaRef}
              className="chat-bubble-edit-textarea"
              aria-label="修改消息内容"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                  event.preventDefault(); submit();
                }
              }}
              rows={1}
            />
          ) : text}
        </div>
      </div>
    </div>
  );
}
