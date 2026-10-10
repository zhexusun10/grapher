import React, { memo, useCallback } from "react";
import type { TranscriptItem } from "../types";
import { ToolCallCard } from "./ToolCallCard";
import { ThinkingCard } from "./ThinkingCard";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { EditableUserBubble } from "./views/ChatBubbles";

export const TranscriptRow = memo(function TranscriptRow({ item, expanded, onExpandedChange, editing, draft,
  onDraftChange, onStartEdit, onCancelEdit, onEditUser }: {
  item: TranscriptItem; expanded?: boolean;
  onExpandedChange: (id: string, expanded: boolean, card?: HTMLElement) => void;
  editing: boolean; draft: string; onDraftChange: (text: string) => void;
  onStartEdit: (id: string, text: string) => void; onCancelEdit: () => void;
  onEditUser?: (text: string, replacement: string) => boolean | void | Promise<unknown>;
}) {
  const expand = useCallback((value: boolean, card?: HTMLElement) => onExpandedChange(item.id, value, card), [item.id, onExpandedChange]);
  if (item.type === "tool_call") return <div className="transcript-row tool-row"><ToolCallCard item={item} expanded={expanded} onExpandedChange={expand} /></div>;
  if (item.type === "thinking") return <div className="transcript-row thinking-row"><ThinkingCard item={item} isStreaming={item.status === "running"}
    expanded={expanded} onExpandedChange={expand} /></div>;
  if (item.type === "system") return <div className={`transcript-row system-row ${item.isError ? "error" : ""}`}><span className="system-pill">{item.content}</span></div>;
  if (item.role === "user") return <div className="transcript-row text-row user"><EditableUserBubble text={item.content || ""}
    editing={editing} draft={draft} onDraftChange={onDraftChange}
    onEdit={onEditUser ? () => onStartEdit(item.id, item.content || "") : undefined}
    onCancel={onCancelEdit} onSend={onEditUser ? text => {
      void Promise.resolve(onEditUser(item.content || "", text)).then(accepted => { if (accepted !== false) onCancelEdit(); });
    } : () => {}} /></div>;
  return <div className={`transcript-row text-row ${item.role || "assistant"}`}><div className="transcript-message-bubble">
    <MarkdownRenderer content={item.content || ""} isStreaming={true} />
  </div></div>;
});
