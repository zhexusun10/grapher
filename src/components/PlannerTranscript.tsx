import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { stripPlannerContext } from "../services/plannerText";
import type { ChatMessage, TranscriptItem } from "../types";
import { VirtualizedList } from "./VirtualizedList";
import { visibleTranscriptRows, matchActivitySummary, stabilizeActivitySummaryIds, type ActivitySummaryAnchor } from "../services/transcriptLayout";
import { ToolCallCard } from "./ToolCallCard";
import { ThinkingCard } from "./ThinkingCard";
import { CompactedCard } from "./CompactedCard";
import { TranscriptErrorCard } from "./TranscriptErrorCard";
import { ActivitySummaryRow, type CardsTransitionPhase } from "./ActivitySummaryRow";
import { markCardsPresented } from "../services/cardAnimations";
import { EditableUserBubble, StreamingAssistantBubble } from "./views/ChatBubbles";
import { AnimatedUserTurn } from "./AnimatedUserTurn";

type Props = {
  items: TranscriptItem[]; isPlanning: boolean; locked: boolean;
  cardsCollapsed?: boolean;
  cardsTransition?: CardsTransitionPhase;
  editingMessage?: ChatMessage | null; draft: string;
  onDraftChange: (text: string) => void; onEditMessage?: (message: ChatMessage) => void;
  onCancelEdit?: () => void;
  onEditSubmit?: (message: ChatMessage, value: string) => boolean | void | Promise<boolean | void>;
  onSendMessage: (value: string) => boolean | void | Promise<boolean>;
  onUserResize: (expanded?: boolean, card?: HTMLElement) => void;
};

const PlannerRow = memo(function PlannerRow({ item, streaming, locked, editing, draft, expanded, cardsTransition, getChildExpanded, onExpandedChange, onChildResize, onChildExpandedChange,
  onDraftChange, onEditMessage, onCancelEdit, onEditSubmit, onSendMessage }: Omit<Props, "items" | "isPlanning" | "editingMessage" | "onUserResize"> & {
  item: TranscriptItem; streaming: boolean; editing: boolean; expanded?: boolean;
  cardsTransition?: CardsTransitionPhase;
  getChildExpanded?: (id: string) => boolean | undefined;
  onExpandedChange: (id: string, expanded: boolean, card?: HTMLElement) => void;
  onChildResize: (expanded: boolean, card?: HTMLElement) => void;
  onChildExpandedChange?: (child: TranscriptItem, expanded: boolean, card?: HTMLElement) => void;
}) {
  const expand = useCallback((value: boolean, card?: HTMLElement) => onExpandedChange(item.id, value, card), [item.id, onExpandedChange]);
  if (item.role === "user") return <AnimatedUserTurn id={item.id} animateAppear={item.animateAppear}
    className="chat-message-row user planner-user-turn">
    <EditableUserBubble text={stripPlannerContext(item.content || "")} images={item.images} files={item.files} editing={editing} draft={draft} onDraftChange={onDraftChange}
      onEdit={onEditMessage ? () => onEditMessage({ id: item.id, parentId: null, role: "user", text: stripPlannerContext(item.content || "") }) : undefined}
      onCancel={() => onCancelEdit?.()}
      onSend={value => onEditSubmit ? onEditSubmit({ id: item.id, parentId: null, role: "user", text: stripPlannerContext(item.content || "") }, value) : onSendMessage(value)}
      disabled={locked} />
  </AnimatedUserTurn>;
  if (item.type === "divider") return <div className="transcript-divider" role="separator" aria-hidden="true" />;
  if (item.type === "activity_summary") return <ActivitySummaryRow item={item} expanded={expanded} transitionPhase={cardsTransition} defaultThinkingExpanded={true} getChildExpanded={getChildExpanded} onExpandedChange={expand} onChildResize={onChildResize} onChildExpandedChange={onChildExpandedChange} />;
  if (item.type === "tool_call") return <ToolCallCard item={item} expanded={expanded} onExpandedChange={expand} />;
  if (item.type === "compaction") return <CompactedCard item={item} expanded={expanded} onExpandedChange={expand} />;
  if (item.errorItems || (item.type === "system" && (item.isError || item.status === "error")) ||
      (item.type === "text" && item.role === "assistant" && (item.isError || item.status === "error"))) {
    return <TranscriptErrorCard item={item} expanded={expanded} onExpandedChange={expand} />;
  }
  if (item.type === "system") return <div className={`transcript-row system-row ${item.isError ? "error" : ""}`}>
    <span className={`system-pill${item.isError && item.role === "assistant" ? " conversation-error-message" : ""}`}>{item.content}</span>
  </div>;
  if (item.type === "thinking") return <ThinkingCard item={item} isStreaming={streaming} title="Chain of Thought"
    defaultExpanded={item.defaultExpanded ?? true} autoExpandWhileStreaming={true} expanded={expanded} onExpandedChange={expand}
    animateAppear={item.animateAppear ?? false} />;
  if (item.type === "text") {
    // Keep virtualized Markdown rows out of Motion's transform layer: fenced code
    // contains its own horizontal scroller, and transformed scrollable descendants
    // can leave a stale compositor copy or flicker during scrollback.
    if (item.isError || item.status === "error") {
      return <div className="chat-message-row assistant">
        <div className="node-error" style={{ margin: "4px 0" }}>
          {item.content || ""}
        </div>
      </div>;
    }
    return <div className="chat-message-row assistant">
      <div className="chat-bubble-assistant chat-message-assistant"><StreamingAssistantBubble content={item.content || ""} isStreaming={streaming} /></div>
    </div>;
  }
  return null;
});

const noop = () => {};
export const PlannerTranscript = memo(function PlannerTranscript(props: Props) {
  const previousSummariesRef = useRef<TranscriptItem[]>([]);
  const items = useMemo(() => {
    const raw = visibleTranscriptRows(props.items, undefined, {
      collapseCards: props.cardsCollapsed,
      live: props.isPlanning,
      canPrepend: false,
    }).rows;
    if (!props.cardsCollapsed || previousSummariesRef.current.length === 0) return raw;
    return stabilizeActivitySummaryIds(raw, previousSummariesRef.current);
  }, [props.items, props.cardsCollapsed, props.isPlanning]);
  const prevCardsCollapsedRef = useRef(props.cardsCollapsed);
  if (prevCardsCollapsedRef.current && !props.cardsCollapsed) {
    markCardsPresented(
      items
        .filter(item => item.type === "tool_call" || item.type === "thinking" || item.type === "compaction")
        .map(item => item.id),
    );
  }
  prevCardsCollapsedRef.current = props.cardsCollapsed;
  useLayoutEffect(() => {
    previousSummariesRef.current = props.cardsCollapsed
      ? items.filter(row => row.type === "activity_summary")
      : [];
  }, [props.cardsCollapsed, items]);
  const expanded = useRef(new Map<string, boolean>());
  const expandedSummaryMeta = useRef(new Map<string, ActivitySummaryAnchor>());
  const itemsRef = useRef<TranscriptItem[]>(items);
  itemsRef.current = items;
  if (props.cardsCollapsed && expandedSummaryMeta.current.size > 0) {
    const summaries = items.filter(row => row.type === "activity_summary");
    const summaryById = new Map(summaries.map((row, index) => [row.id, { row, index }]));
    for (const [savedId, meta] of [...expandedSummaryMeta.current.entries()]) {
      const existing = summaryById.get(savedId);
      if (existing) {
        expandedSummaryMeta.current.set(savedId, {
          toolCallIds: (existing.row.summaryItems ?? [])
            .map(child => child.toolCallId)
            .filter((callId): callId is string => Boolean(callId)),
          itemIds: (existing.row.summaryItems ?? []).map(child => child.id),
          ordinalFromEnd: summaries.length - 1 - existing.index,
        });
        continue;
      }
      const matched = matchActivitySummary(summaries, meta);
      if (matched) {
        expanded.current.delete(savedId);
        expanded.current.set(matched.id, true);
        expandedSummaryMeta.current.delete(savedId);
        const nextIndex = summaries.indexOf(matched);
        expandedSummaryMeta.current.set(matched.id, {
          toolCallIds: (matched.summaryItems ?? [])
            .map(child => child.toolCallId)
            .filter((callId): callId is string => Boolean(callId)),
          itemIds: (matched.summaryItems ?? []).map(child => child.id),
          ordinalFromEnd: summaries.length - 1 - nextIndex,
        });
      }
    }
  }
  const [, bump] = useState(0);
  useEffect(() => {
    if (props.cardsCollapsed && props.cardsTransition !== "collapsing") return;
    let removed = false;
    expandedSummaryMeta.current.clear();
    for (const id of [...expanded.current.keys()]) {
      if (id.startsWith("summary_")) {
        expanded.current.delete(id);
        removed = true;
      }
    }
    if (removed) bump(version => version + 1);
  }, [props.cardsCollapsed, props.cardsTransition]);
  const expand = useCallback((id: string, value: boolean, card?: HTMLElement) => {
    expanded.current.set(id, value);
    if (id.startsWith("summary_")) {
      if (value) {
        const summaries = itemsRef.current.filter(row => row.type === "activity_summary");
        const summaryIndex = summaries.findIndex(row => row.id === id);
        if (summaryIndex >= 0) {
          const target = summaries[summaryIndex];
          expandedSummaryMeta.current.set(id, {
            toolCallIds: (target.summaryItems ?? [])
              .map(child => child.toolCallId)
              .filter((callId): callId is string => Boolean(callId)),
            itemIds: (target.summaryItems ?? []).map(child => child.id),
            ordinalFromEnd: summaries.length - 1 - summaryIndex,
          });
        }
      } else {
        expandedSummaryMeta.current.delete(id);
      }
    }
    bump(version => version + 1);
    props.onUserResize(value, card);
  }, [props.onUserResize]);
  const handleChildExpandedChange = useCallback((child: TranscriptItem, value: boolean) => {
    expanded.current.set(child.id, value);
  }, []);
  const getChildExpanded = useCallback((id: string) => expanded.current.get(id), []);
  const renderRow = (item: TranscriptItem, index: number, allowTransition = true) => <PlannerRow item={item}
    streaming={props.isPlanning && item.status === "running" && (item.type === "thinking" || index === items.length - 1)}
    locked={props.locked && !props.isPlanning} editing={props.editingMessage?.id === item.id}
    draft={props.editingMessage?.id === item.id ? props.draft : ""}
    expanded={expanded.current.get(item.id)} cardsTransition={allowTransition ? props.cardsTransition : "idle"} getChildExpanded={getChildExpanded} onExpandedChange={expand} onChildResize={props.onUserResize}
    onChildExpandedChange={handleChildExpandedChange}
    onDraftChange={props.onDraftChange || noop} onEditMessage={props.onEditMessage} onCancelEdit={props.onCancelEdit}
    onEditSubmit={props.onEditSubmit} onSendMessage={props.onSendMessage} />;
  return <div className="planner-transcript"><VirtualizedList items={items} renderRow={renderRow} gap={10} overscan={props.cardsCollapsed ? 36 : 16} transitionPhase={props.cardsTransition} /></div>;
});
