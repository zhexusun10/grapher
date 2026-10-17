import React, { memo, useCallback } from "react";
import type { TranscriptItem } from "../types";
import { ToolCallCard } from "./ToolCallCard";
import { ThinkingCard } from "./ThinkingCard";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { EditableUserBubble } from "./views/ChatBubbles";
import { AnimatedUserTurn } from "./AnimatedUserTurn";
import { motion } from "motion/react";

export const TranscriptRow = memo(function TranscriptRow({ item, expanded, onExpandedChange, editing, draft,
  onDraftChange, onStartEdit, onCancelEdit, onEditUser }: {
  item: TranscriptItem; expanded?: boolean;
  onExpandedChange: (id: string, expanded: boolean, card?: HTMLElement) => void;
  editing: boolean; draft: string; onDraftChange: (text: string) => void;
  onStartEdit: (id: string, text: string) => void; onCancelEdit: () => void;
  onEditUser?: (text: string, replacement: string) => boolean | void | Promise<unknown>;
}) {
  const expand = useCallback((value: boolean, card?: HTMLElement) => onExpandedChange(item.id, value, card), [item.id, onExpandedChange]);
  // Keep execution rows in the exact same layout as the Planner transcript:
  // rows sit directly in the shared list (which owns the 8px card rhythm),
  // and text uses the shared chat bubble classes.
  if (item.type === "tool_call") return <ToolCallCard item={item} expanded={expanded} onExpandedChange={expand} />;
  if (item.type === "thinking") return <ThinkingCard item={item} isStreaming={item.status === "running"}
    title="Chain of Thought"
    defaultExpanded={item.defaultExpanded ?? (item.status === "running")} autoExpandWhileStreaming={true} expanded={expanded} onExpandedChange={expand} />;
  if (item.type === "system") return <div className={`transcript-row system-row ${item.isError ? "error" : ""}`}><span className="system-pill">{item.content}</span></div>;
  if (item.role === "user") return <AnimatedUserTurn id={item.id} animateAppear={item.animateAppear}
    className="chat-message-row user planner-user-turn"><EditableUserBubble text={item.content || ""}
    editing={editing} draft={draft} onDraftChange={onDraftChange}
    onEdit={onEditUser ? () => onStartEdit(item.id, item.content || "") : undefined}
    onCancel={onCancelEdit} onSend={onEditUser ? text => {
      return Promise.resolve(onEditUser(item.content || "", text)).then(accepted => {
        if (accepted !== false) onCancelEdit();
        return accepted === false ? false : true;
      });
    } : () => {}} /></AnimatedUserTurn>;
  if (item.isError || item.status === "error") {
    return <motion.div className="chat-message-row assistant" initial={false}
      animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
      <div className="node-error" style={{ margin: "4px 0" }}>{item.content || ""}</div>
    </motion.div>;
  }
  return <motion.div className="chat-message-row assistant" initial={false}
    animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
    <div className="chat-bubble-assistant chat-message-assistant">
      <MarkdownRenderer content={item.content || ""} isStreaming={item.status === "running"} />
    </div>
  </motion.div>;
});
