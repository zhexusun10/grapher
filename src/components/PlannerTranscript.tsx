import React, { memo, useCallback, useRef, useState } from "react";
import { motion } from "motion/react";
import { t } from "../i18n";
import type { ChatMessage, TranscriptItem } from "../types";
import { VirtualizedList } from "./VirtualizedList";
import { ToolCallCard } from "./ToolCallCard";
import { ThinkingCard } from "./ThinkingCard";
import { EditableUserBubble, StreamingAssistantBubble } from "./views/ChatBubbles";

type Props = {
  items: TranscriptItem[]; isPlanning: boolean; locked: boolean;
  editingMessage?: ChatMessage | null; draft: string;
  onDraftChange: (text: string) => void; onEditMessage?: (message: ChatMessage) => void;
  onCancelEdit?: () => void;
  onEditSubmit?: (message: ChatMessage, value: string) => boolean | void | Promise<boolean | void>;
  onSendMessage: (value: string) => boolean | void | Promise<boolean>;
  onUserResize: (expanded?: boolean, card?: HTMLElement) => void;
};

const PlannerRow = memo(function PlannerRow({ item, streaming, locked, editing, draft, expanded, onExpandedChange,
  onDraftChange, onEditMessage, onCancelEdit, onEditSubmit, onSendMessage }: Omit<Props, "items" | "isPlanning" | "editingMessage" | "onUserResize"> & {
  item: TranscriptItem; streaming: boolean; editing: boolean; expanded?: boolean;
  onExpandedChange: (id: string, expanded: boolean, card?: HTMLElement) => void;
}) {
  const expand = useCallback((value: boolean, card?: HTMLElement) => onExpandedChange(item.id, value, card), [item.id, onExpandedChange]);
  if (item.role === "user") return <motion.div className="chat-message-row user" initial={false}
    animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
    <EditableUserBubble text={item.content || ""} editing={editing} draft={draft} onDraftChange={onDraftChange}
      onEdit={onEditMessage ? () => onEditMessage({ id: item.id, parentId: null, role: "user", text: item.content || "" }) : undefined}
      onCancel={() => onCancelEdit?.()}
      onSend={value => onEditSubmit ? onEditSubmit({ id: item.id, parentId: null, role: "user", text: item.content || "" }, value) : onSendMessage(value)}
      disabled={locked} />
  </motion.div>;
  if (item.type === "tool_call") return <ToolCallCard item={item} expanded={expanded} onExpandedChange={expand} />;
  if (item.type === "thinking") return <ThinkingCard item={item} isStreaming={streaming} title={t("思考过程")}
    defaultExpanded={true} expanded={expanded} onExpandedChange={expand} />;
  if (item.type === "text") return <motion.div className="chat-message-row assistant" initial={false} animate={{ opacity: 1, y: 0, scale: 1 }}>
    <div className="chat-bubble-assistant chat-message-assistant"><StreamingAssistantBubble content={item.content || ""} isStreaming={streaming} /></div>
  </motion.div>;
  return null;
});

const noop = () => {};
export const PlannerTranscript = memo(function PlannerTranscript(props: Props) {
  const expanded = useRef(new Map<string, boolean>());
  const [, bump] = useState(0);
  const expand = useCallback((id: string, value: boolean, card?: HTMLElement) => {
    expanded.current.set(id, value);
    bump(version => version + 1);
    props.onUserResize(value, card);
  }, [props.onUserResize]);
  const renderRow = (item: TranscriptItem, index: number) => <PlannerRow item={item}
    streaming={props.isPlanning && item.status === "running" && (item.type === "thinking" || index === props.items.length - 1)}
    locked={props.locked && !props.isPlanning} editing={props.editingMessage?.id === item.id}
    draft={props.editingMessage?.id === item.id ? props.draft : ""}
    expanded={expanded.current.get(item.id)} onExpandedChange={expand}
    onDraftChange={props.onDraftChange || noop} onEditMessage={props.onEditMessage} onCancelEdit={props.onCancelEdit}
    onEditSubmit={props.onEditSubmit} onSendMessage={props.onSendMessage} />;
  return <VirtualizedList items={props.items} renderRow={renderRow} gap={8} />;
});
