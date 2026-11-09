import type { PlanMode, Snapshot, TranscriptItem } from "../types";
import type { PlannerEdgeEdit, PlannerNodeEdit } from "../lib/plannerGraphEdits";
import { plannerContentText, stripPlannerContext } from "./plannerText";
import { closeThinkingItems, finalizeThinkingItems, updateThinkingItems } from "./thinkingTranscript";
import { upsertToolCall } from "./toolCallUpdates";
import { appendItemDelta } from "./transcriptUpdates";

export interface PlannerStreamState {
  runId: string;
  initialPlanMode: PlanMode | undefined;
  stage: "idle" | "partitioning" | "planning" | "completed" | "error";
  items: TranscriptItem[];
  plannerMessageStart: number;
  representedPlanningIds: string[];
  isContinuation: boolean;
  startedAt: number | undefined;
  partitionerThinking: string;
  partitionerThinkingActive: boolean;
  partitionerText: string;
  plannerThinking: string;
  plannerThinkingActive: boolean;
  plannerText: string;
  tools: TranscriptItem[];
  // Live Planner auto-compaction: no transcript rows, only the working label.
  compacting: boolean;
}

export const initialPlannerStream: PlannerStreamState = {
  runId: "",
  initialPlanMode: undefined,
  stage: "idle",
  items: [],
  plannerMessageStart: 0,
  representedPlanningIds: [],
  isContinuation: false,
  startedAt: undefined,
  partitionerThinking: "",
  partitionerThinkingActive: false,
  partitionerText: "",
  plannerThinking: "",
  plannerThinkingActive: false,
  plannerText: "",
  tools: [],
  compacting: false,
};

function appendErrorItem(items: TranscriptItem[], errorMsg: string): TranscriptItem[] {
  const closed = closeThinkingItems(items);
  if (closed.some(i => (i.isError || i.status === "error") && i.content === errorMsg)) {
    return closed;
  }
  return [
    ...closed,
    {
      id: `planner_error_${Date.now()}`,
      type: "text",
      role: "assistant",
      content: errorMsg,
      isError: true,
      status: "error",
      timestamp: Date.now(),
    },
  ];
}

export function appendPlannerError(
  prev: PlannerStreamState,
  errorMsg: string,
  markErrorStage = false,
): PlannerStreamState {
  const nextItems = appendErrorItem(prev.items, errorMsg);
  if (!markErrorStage && nextItems === prev.items) return prev;
  return {
    ...prev,
    ...(markErrorStage ? { startedAt: undefined, stage: "error" as const } : {}),
    items: nextItems,
  };
}

export function applyPartitionerDelta(
  prev: PlannerStreamState,
  thinkChunk: string,
  textChunk: string,
  thinkingActive: boolean,
): PlannerStreamState {
  return {
    ...prev,
    partitionerThinking: prev.partitionerThinking + thinkChunk,
    partitionerThinkingActive: thinkingActive,
    partitionerText: prev.partitionerText + textChunk,
  };
}

export function applyPartitionerMessageEnd(
  prev: PlannerStreamState,
  content: unknown,
): PlannerStreamState {
  let thinking = prev.partitionerThinking;
  if (!thinking && Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "thinking" && part.thinking) {
        thinking = part.thinking;
      }
    }
  }
  return {
    ...prev,
    partitionerThinking: thinking,
    partitionerThinkingActive: false,
  };
}

export function applyPlannerUserMessageStart(
  prev: PlannerStreamState,
  content: unknown,
  steerId: string,
): PlannerStreamState {
  if (prev.items.some(item => item.id === `msg-${steerId}`)) return prev;
  const images = Array.isArray(content) ? content.filter((part: any) => part?.type === "image") : [];
  return {
    ...prev,
    items: [
      ...closeThinkingItems(prev.items),
      {
        id: `msg-${steerId}`,
        type: "text",
        role: "user",
        content: stripPlannerContext(plannerContentText(content)).trim(),
        images: images.length ? images : undefined,
        timestamp: Date.now(),
        animateAppear: true,
      },
    ],
  };
}

export function applyPlannerToolCallUpdate(
  prev: PlannerStreamState,
  aEvent: any,
): PlannerStreamState {
  const part = aEvent.type === "toolcall_end" ? aEvent.toolCall : aEvent.partial?.content?.[aEvent.contentIndex];
  const toolCallId = aEvent.id || part?.id;
  const toolName = aEvent.toolName || part?.name;
  const args = aEvent.arguments || part?.arguments;
  const items = upsertToolCall(prev.items, {
    toolCallId,
    toolName,
    args,
    argsTruncated: !!(aEvent.argsTruncated || part?.argsTruncated),
    contentIndex: aEvent.contentIndex,
    phase: aEvent.type === "toolcall_start" ? "generating" : "pending",
  }, prev.plannerMessageStart);
  return { ...prev, items, tools: items.filter(item => item.type === "tool_call") };
}

export function applyPlannerThinkingUpdate(
  prev: PlannerStreamState,
  aEvent: any,
): PlannerStreamState {
  const items = updateThinkingItems(prev.items, aEvent, prev.plannerMessageStart);
  return {
    ...prev,
    items,
    plannerThinking: items.filter(item => item.type === "thinking" && item.content).map(item => item.content).join("\n\n"),
    plannerThinkingActive: items.some(item => item.type === "thinking" && item.status === "running"),
  };
}

export function applyPlannerTextDelta(
  prev: PlannerStreamState,
  thinkChunk: string,
  textChunk: string,
  thinkingActive: boolean,
): PlannerStreamState {
  let items = prev.items;
  if (thinkChunk) {
    items = appendItemDelta(items, "thinking", thinkChunk, thinkingActive);
  }
  if (!thinkingActive && items.some(i => i.type === "thinking" && i.status === "running")) {
    items = closeThinkingItems(items);
  }
  if (textChunk) {
    items = appendItemDelta(items, "text", textChunk, true);
  }
  return {
    ...prev,
    items,
    plannerThinking: prev.plannerThinking + thinkChunk,
    plannerThinkingActive: thinkingActive,
    plannerText: prev.plannerText + textChunk,
  };
}

export function applyPlannerAssistantMessageEnd(
  prev: PlannerStreamState,
  message: any,
): PlannerStreamState {
  const failureStopReason = message?.stopReason;
  const failureMessage = message?.errorMessage;
  const content = Array.isArray(message?.content) ? message.content : [];
  let items = finalizeThinkingItems(prev.items, content, prev.plannerMessageStart);
  content.forEach((part: any, contentIndex: number) => {
    if (part?.type === "toolCall") {
      items = upsertToolCall(items, {
        toolCallId: part.id,
        toolName: part.name,
        args: part.arguments,
        argsTruncated: !!part.argsTruncated,
        contentIndex,
        phase: "pending",
      }, prev.plannerMessageStart);
    }
  });
  if ((failureStopReason === "error" || failureStopReason === "aborted") && failureMessage) {
    items = appendErrorItem(items, failureMessage);
  }
  return {
    ...prev,
    items,
    tools: items.filter(item => item.type === "tool_call"),
    plannerMessageStart: items.length,
    plannerThinking: items.filter(item => item.type === "thinking" && item.content).map(item => item.content).join("\n\n"),
    plannerThinkingActive: false,
  };
}

export function applyPlannerToolExecutionStart(
  prev: PlannerStreamState,
  pEvent: any,
): PlannerStreamState {
  const items = upsertToolCall(closeThinkingItems(prev.items), {
    toolCallId: pEvent.toolCallId,
    toolName: pEvent.toolName,
    args: pEvent.args,
    argsTruncated: !!pEvent.argsTruncated,
    phase: "executing",
  }, prev.plannerMessageStart);
  return {
    ...prev,
    items,
    plannerThinkingActive: false,
    tools: items.filter(item => item.type === "tool_call"),
  };
}

export function applyPlannerToolExecutionEnd(
  prev: PlannerStreamState,
  pEvent: any,
  resText: string,
  exitCode: number | null,
  isErr: boolean,
  truncated: boolean,
  args: Record<string, any>,
): PlannerStreamState {
  const updateTool = (t: TranscriptItem): TranscriptItem => ({
    ...t,
    result: resText,
    exitCode,
    truncated,
    durationMs: typeof pEvent.durationMs === "number" ? pEvent.durationMs : t.durationMs,
    isError: isErr,
    status: isErr ? "error" : "success",
  });

  let nextItems = prev.items.slice();
  let index = pEvent.toolCallId
    ? nextItems.findIndex(item => item.type === "tool_call" && item.toolCallId === pEvent.toolCallId)
    : -1;
  if (!pEvent.toolCallId) {
    for (let i = nextItems.length - 1; i >= 0; i--) {
      if (nextItems[i].type === "tool_call" && nextItems[i].toolName === pEvent.toolName && nextItems[i].status === "running") {
        index = i;
        break;
      }
    }
  }
  if (index < 0) {
    nextItems = upsertToolCall(nextItems, {
      toolCallId: pEvent.toolCallId,
      toolName: pEvent.toolName,
      args,
      phase: "executing",
    }, prev.plannerMessageStart);
    index = nextItems.length - 1;
  }
  nextItems[index] = updateTool(nextItems[index]);
  return { ...prev, items: nextItems, tools: nextItems.filter(item => item.type === "tool_call") };
}

export function applyPlannerNodeEditsToState(prev: Snapshot, edits: readonly PlannerNodeEdit[]): Snapshot {
  let nextNodes = [...prev.graph.nodes];
  let nextEdges = [...prev.graph.edges];
  for (const edit of edits) {
    nextNodes = nextNodes.filter(item => item.name !== edit.name);
    if (edit.delete) {
      nextEdges = nextEdges.filter(e => e.from !== edit.name && e.to !== edit.name);
    } else {
      nextNodes.push({ name: edit.name, task: edit.task });
    }
  }
  return {
    ...prev,
    graph: {
      ...prev.graph,
      nodes: nextNodes,
      edges: nextEdges,
    },
    // The committed plan predates this draft. Lay out the
    // preview from its current edges until Rust commits it.
    plan: null,
  };
}

export function applyPlannerEdgeEditsToState(prev: Snapshot, edits: readonly PlannerEdgeEdit[]): Snapshot {
  let nextEdges = [...prev.graph.edges];
  for (const edit of edits) {
    nextEdges = nextEdges.filter(item => item.from !== edit.from || item.to !== edit.to);
    if (!edit.delete) {
      nextEdges.push({
        from: edit.from,
        to: edit.to,
        feedback: edit.feedback,
      });
    }
  }
  return {
    ...prev,
    graph: {
      ...prev.graph,
      edges: nextEdges,
    },
    plan: null,
  };
}
