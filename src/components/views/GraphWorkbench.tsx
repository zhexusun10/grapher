import { t, localizeError } from "../../i18n";
import React, { useRef, useState, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { GraphCanvas } from "../graph/GraphCanvas";
import { useGraphViewport } from "../../hooks/useGraphViewport";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  Code2, ArrowLeft,
  Workflow, Play, Pause, Compass, ArrowDown, Clock, Loader2, ChevronRight,
  AlertCircle
} from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import {
  Snapshot, PlanRouteType, PlanMode, RepositoryInfo, Config,
  Graph, GraphNode, Execution, Status, PlanningSummary, TranscriptItem,
  ChatMessage, RuntimeActivity, publicationMergerCardId
} from "../../types";
import { PromptBox, type PromptBoxSubmitOptions } from "../ui/chatgpt-prompt-input";
import type { ConfirmModalState } from "../modals/ConfirmModal";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { EditableUserBubble } from "./ChatBubbles";
import { NodeTaskCard } from "./NodeTaskCard";
import { getMergerSystemPrompt } from "../../services/mergerPrompt";
import { runtimeService } from "../../services/runtime";
import { shouldShowRouteBadge } from "../../services/executionRoute";
import { activeNodeConversationEvents, activeNodeExecutions, executionIdForMessage, versionIndexForEdit, versionsForEdit } from "../../services/conversationBranch";
import { captureViewScrollState, resolveViewScroll, CONVERSATION_BOTTOM_THRESHOLD, type ViewScrollState } from "../../services/conversationScroll";
import { isNodeWorking, nodeDependenciesCompleted } from "../../lib/nodeWorking";
import { resolveGraphPhase } from "../../lib/graphPhase";
import { ThinkingCard } from "../ThinkingCard";
import { ExecutionTiming } from "../ExecutionTiming";
import { ExecutionTimeTookText, PlannerTimeTookText, formatSessionStartTime } from "../ExecutionTimeTook";
import { SessionTokenUsage } from "../SessionTokenUsage";
import { formatTokenCount, formatCacheHitRate, consumedTokenCount, attemptSessionContext, sessionContext, sessionTokenUsage } from "../../utils/tokenUsage";
import { ExecutionTranscript, ExecutionTranscriptPlaceholder } from "../ExecutionTranscript";
import { activePlannerOutput } from "../PlanningActivity";
import { plannerConversationEdits, plannerHistoryIds } from "../../lib/plannerOutput";
import { cachedPlanningOutput } from "../../services/transcriptCache";
import { HISTORY_PREPEND_EVENT } from "../../services/transcriptScroll";
import { smoothScrollToLatest } from "../../services/smoothConversationScroll";
import { plannerUserTurns, skipsFirstPersistedTurn, withoutLiveFirstTurn } from "../../services/plannerUserTurns";
import { executionSessionTiming, executionSessionUsageThrough, mergePlannerTurns, plannerLegacyUsage, plannerSessionTiming, plannerSessionUsageThrough, plannerTurnSummaries, addTokenUsage } from "../../services/sessionMetrics";
import { PlanningActivity } from "../PlanningActivity";
import { statusText, phaseText } from "../graph/TaskNode";
import { useSmoothStreamText } from "../../hooks/useSmoothStreamText";
import { useAnimatedNodes } from "../../hooks/useAnimatedNodes";
import { useWorkbenchResizer } from "../../hooks/useWorkbenchResizer";
import { computeExecutionLayers } from "../../hooks/useGraphElements";
import { PublicationCompletedCard } from "../PublicationCompletedCard";
import { PlannerTranscript } from "../PlannerTranscript";
import { resolveExecutionModelAndThinking, roleModelConfig } from "../../modelConfig";
import { AnimatedUserTurn } from "../AnimatedUserTurn";
import { useWorkspaceChanges } from "../../hooks/useWorkspaceChanges";
import { WorkspaceChangesPanel, WorkspaceChangesTrigger } from "../changes/WorkspaceChangesPanel";
import { AnimatedDisclosure, getConversationViewport } from "../AnimatedDisclosure";

/** Transient I/O status takes precedence over the durable phase copy. */
function activityStatusText(activity: RuntimeActivity[]): string | null {
  if (!activity.length) return null;
  const byKind = (kind: string) => activity.find(item => item.kind === kind);
  const prepare = byKind("workspace_prepare");
  if (prepare) {
    return prepare.nodes.length
      ? t("正在复制节点工作区：{0}", prepare.nodes.join("、"))
      : t("正在复制节点工作区");
  }
  if (byKind("source_materialize")) return t("正在建立临时 Git 快照（首次收录项目文件）");
  if (byKind("source_capture")) return t("正在记录 Git 源快照");
  return null;
}

/** Planner positions persist within a Conversation; Node views reopen a fresh
 * bounded tail after their view-owned history has been released. */
interface GraphWorkbenchProps {
  state: Snapshot;
  transcriptRunId?: string;
  composerDrafts?: Map<string, string>;
  activity?: RuntimeActivity[];
  routeType: PlanRouteType;
  initialPlanMode?: PlanMode;
  selected: string;
  setSelected: (name: string) => void;
  selectedMergerId: string;
  setSelectedMergerId: (id: string) => void;
  effectiveMessages: Array<ChatMessage>;
  onEditMessage?: (msg: ChatMessage) => void;
  editingMessage?: ChatMessage | null;
  editPrefillText?: string;
  onEditPrefillTextChange?: (text: string) => void;
  onCancelEditMessage?: () => void;
  onInterrupt?: (targetNode?: string) => void;
  isPlanning: boolean;
  plannerStream: any;
  recoveredPlanningId?: string;
  onSendMessage: (val: string, options?: PromptBoxSubmitOptions) => boolean | void | Promise<boolean>;
  onEditMessageSubmit?: (msg: ChatMessage, newText: string, selectedVersion?: number) => boolean | void | Promise<boolean | void>;
  onSwitchMessageVersion?: (msg: ChatMessage, targetIndex: number) => void;
  onRequestConfirmation: (config: ConfirmModalState) => void;
  followUpQueue?: Array<{ id: string; text: string; node?: string; timestamp: number }>;
  onCancelFollowUp?: (id: string) => void;
  onControl: (action: string, extra?: Record<string, unknown>) => void;
  onSave: (graph: Graph) => void;
  onOpenEditor: () => void;
  onOpenApproval: () => void;
  repoInfo: RepositoryInfo | null;
  config: Config;
  envOverrides?: Record<string, string>;
  active: boolean;
  locked: boolean;
  pendingRequest: boolean;
  publishing: boolean;
  publicationFailed: boolean;
  nodes: any[];
  edges: any[];
  nodeTypes: any;
  edgeTypes: any;
  tokens: any;
  failedPlanning?: PlanningSummary | null;
}

function nodeInstructionText(text: string): string {
  return text.replace(/^\[@[^\]]+\]\s*/, "").trim();
}

/** Inline transcript rows currently carry text only; attached files/images stay
 * in the surrounding chat bubble so they cannot disappear while paging. */
function canInlineSteerMessage(message: ChatMessage): boolean {
  return !message.images?.length && !message.files?.length;
}

/** Node failures can carry multi-line backend/stderr detail; keep it readable
 * and copyable instead of collapsing it into a single opaque line. */
function NodeErrorPanel({ error, paused }: { error: string; paused?: boolean }) {
  const [copied, setCopied] = useState(false);
  const detail = useMemo(() => localizeError(error), [error]);
  const copy = useCallback(() => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(detail).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [detail]);
  return (
    <div className={`node-error${paused ? " paused" : ""}`} style={{ marginTop: 12 }}>
      <div className="node-error-head">
        <span>{t("执行失败")}</span>
        <button type="button" className="node-error-copy" onClick={copy}>
          {copied ? t("已复制") : t("复制错误")}
        </button>
      </div>
      <pre className="node-error-detail">{detail}</pre>
    </div>
  );
}

function ExecutionRecordHeader({ execution, expanded, onToggle, placeholder = false }: {
  execution: Execution;
  expanded: boolean;
  onToggle?: React.MouseEventHandler<HTMLButtonElement>;
  placeholder?: boolean;
}) {
  return <button
    type="button"
    className="session-label session-label-toggle"
    aria-expanded={placeholder ? undefined : expanded}
    aria-hidden={placeholder || undefined}
    disabled={placeholder}
    onClick={onToggle}
    style={{
      cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", justifyContent: "space-between",
      visibility: placeholder ? "hidden" : undefined
    }}
    title={expanded ? t("点击收起执行记录") : t("点击展开执行记录")}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className={`status-badge ${execution.status}`}>
        {statusText[execution.status as Status] ?? execution.status}
      </span>
      <span style={{ fontSize: 13, fontWeight: 500 }}>{t("#{0} 尝试", execution.attempt || 1)}</span>
      <ExecutionTiming execution={execution} />
    </div>
    <span style={{ fontSize: 12, opacity: 0.65, marginLeft: "auto" }}>
      {expanded ? t("点击收起执行记录") : t("点击展开执行记录")}
    </span>
  </button>;
}

interface WorkspaceDetailsPanelProps {
  showWorking?: boolean;
  compacting?: boolean;
  /** Overrides the generic Working label for a known lifecycle phase. */
  workingLabel?: string;
  /** Defaults to the node wording; Planner turns may use different workspaces. */
  label?: string;
  summaryAction?: React.ReactNode;
  additionalDetails?: React.ReactNode;
  children: React.ReactNode;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}

const WorkspaceDetailsPanel: React.FC<WorkspaceDetailsPanelProps> = ({
  showWorking,
  compacting,
  workingLabel,
  label,
  summaryAction,
  additionalDetails,
  children,
  scrollContainerRef,
  onBeforeToggle,
  onAfterToggle,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={panelRef} className={`workspace-details ${isOpen ? "open" : ""}`} style={{ marginTop: 12 }}>
      {showWorking && (
        <div className="working-indicator" role="status" aria-live="polite">
          <span className="working-indicator-dot" />
          {compacting ? "Compacting…" : (workingLabel ?? "Working…")}
        </div>
      )}
      <div className="workspace-details-summary">
        <button
          type="button"
          className="workspace-details-trigger"
          onClick={() => setIsOpen(open => !open)}
          aria-expanded={isOpen}
        >
          <span>{label ?? t("工作区与会话信息")}</span>
          <ChevronRight size={11} className={`workspace-details-chevron ${isOpen ? "open" : ""}`} />
        </button>
        {summaryAction}
      </div>

      {additionalDetails}

      <AnimatedDisclosure
        open={isOpen}
        panelRef={panelRef}
        scrollContainerRef={scrollContainerRef}
        onBeforeToggle={onBeforeToggle}
        onAfterToggle={onAfterToggle}
      >
        <div className="workspace-details-body">{children}</div>
      </AnimatedDisclosure>
    </div>
  );
};


export const GraphWorkbench: React.FC<GraphWorkbenchProps> = React.memo(({
  state,
  transcriptRunId = state.runId,
  composerDrafts,
  activity = [],
  routeType,
  initialPlanMode,
  selected,
  setSelected,
  selectedMergerId,
  setSelectedMergerId,
  failedPlanning,
  recoveredPlanningId,
  effectiveMessages,
  onEditMessage,
  editingMessage,
  editPrefillText,
  onEditPrefillTextChange,
  onCancelEditMessage,
  onInterrupt,
  isPlanning,
  plannerStream,
  onSendMessage,
  onEditMessageSubmit,
  onSwitchMessageVersion,
  onRequestConfirmation,
  followUpQueue,
  onCancelFollowUp,
  onControl,
  onSave,
  onOpenEditor,
  onOpenApproval,
  repoInfo,
  config,
  envOverrides = {},
  active,
  locked,
  pendingRequest,
  publishing,
  publicationFailed,
  nodes,
  edges,
  nodeTypes,
  edgeTypes,
  tokens,
}) => {
  const [attemptId, setAttemptId] = useState("");
  const [collapsedAttemptIds, setCollapsedAttemptIds] = useState<Set<string>>(new Set());
  const [editingTaskNode, setEditingTaskNode] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  // Auto-compaction visibility per parsed execution transcript; the working
  // labels swap to "Compacting…" while the node's own session compresses.
  const [compactingAttempts, setCompactingAttempts] = useState<Record<string, boolean>>({});
  // User turns the execution transcript has actually parsed. The outer steer
  // bubble remains visible until then, so a consumed steer never disappears
  // while Pi is still finishing the current tool call.
  const [inlineUserTurns, setInlineUserTurns] = useState<Record<string, string[]>>({});
  const handleInlineUserTurns = useCallback((execId: string, texts: string[]) => {
    setInlineUserTurns(prev => {
      const previous = prev[execId] ?? [];
      return previous.length === texts.length && previous.every((text, index) => text === texts[index])
        ? prev : { ...prev, [execId]: texts };
    });
  }, []);
  const [plannerHistoryCompacting, setPlannerHistoryCompacting] = useState(false);
  const handleAttemptCompacting = useCallback((execId: string, compacting: boolean) => {
    setCompactingAttempts((prev) => (!!prev[execId] === compacting ? prev : { ...prev, [execId]: compacting }));
  }, []);
  useEffect(() => {
    setAttemptId("");
    setCollapsedAttemptIds(new Set());
    setEditingTaskNode("");
    setTaskDraft("");
    setInlineUserTurns({});
    onCancelEditMessage?.();
  }, [selected, state.runId]);
  useEffect(() => {
    setSelectedMergerId("");
  }, [state.runId, setSelectedMergerId]);
  // The publication Merger has no planner node; it is addressed through the
  // synthetic card selected in the topology.
  const publicationMergerSelected = selected === publicationMergerCardId;
  const selectedPublicationMerger = useMemo(() => {
    if (!publicationMergerSelected) return undefined;
    const publicationMergers = (state.mergers ?? []).filter((item) => item.node === "merger");
    const running = publicationMergers.find(item => item.status === "running");
    if (running && (!selectedMergerId || !publicationMergers.some(m => m.id === selectedMergerId && m.status === "running"))) {
      return running;
    }
    return publicationMergers.find((item) => item.id === selectedMergerId) ?? publicationMergers.at(-1);
  }, [publicationMergerSelected, selectedMergerId, state.mergers]);

  // A node-composition merger also has its own independent card identity and conversation.
  const isNodeMergerSelected = (selected.startsWith("merger:") && selected !== publicationMergerCardId)
    || Boolean(selectedMergerId && selected && (state.mergers ?? []).some(m => m.id === selectedMergerId && m.node === `merge:${selected}`));
  const nodeMergerTarget = isNodeMergerSelected
    ? (selected.startsWith("merger:") ? selected.slice(7) : selected)
    : "";
  const selectedNodeMerger = useMemo(() => {
    if (!isNodeMergerSelected) return undefined;
    const targetMergers = (state.mergers ?? []).filter((item) => item.node === `merge:${nodeMergerTarget}`);
    const running = targetMergers.find(item => item.status === "running");
    if (running && (!selectedMergerId || !targetMergers.some(m => m.id === selectedMergerId && m.status === "running"))) {
      return running;
    }
    return targetMergers.find((item) => item.id === selectedMergerId) ?? targetMergers.at(-1);
  }, [isNodeMergerSelected, selectedMergerId, nodeMergerTarget, state.mergers]);

  const selectedMerger = publicationMergerSelected
    ? selectedPublicationMerger
    : (isNodeMergerSelected ? selectedNodeMerger : undefined);
  const selectedMergerRunning = selectedMerger?.status === "running";
  const renderSteerBubble = (steer: ChatMessage) => (
    <div key={steer.id} className="chat-message-row user planner-follow-up">
      <EditableUserBubble
        text={nodeInstructionText(steer.text)}
        images={steer.images}
        files={steer.files}
        editing={editingMessage?.id === steer.id}
        draft={editPrefillText ?? ""}
        onDraftChange={onEditPrefillTextChange ?? (() => { })}
        onEdit={onEditMessage && (selectedMerger || steer.delivery !== "node_messaged")
          ? () => { setEditingTaskNode(""); onEditMessage(steer) }
          : undefined}
        onCancel={() => onCancelEditMessage?.()}
        onSend={(value) => onEditMessageSubmit ? onEditMessageSubmit(steer, value) : onSendMessage(value)}
        disabled={locked}
        versions={steer.versions}
        currentVersionIndex={steer.currentVersionIndex}
        onSwitchVersion={(idx) => onSwitchMessageVersion?.(steer, idx)}
      />
    </div>
  );

  const [mergerPrompts, setMergerPrompts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!selectedMerger?.id || !state.runId) return;
    const mergerId = selectedMerger.id;
    if (mergerPrompts[mergerId]) return;

    let cancelled = false;
    runtimeService.getMergerPrompt(state.runId, mergerId)
      .then((prompt) => {
        if (!cancelled && prompt) {
          setMergerPrompts((prev) => ({ ...prev, [mergerId]: prompt }));
        }
      })
      .catch(() => { });

    return () => {
      cancelled = true;
    };
  }, [selectedMerger?.id, state.runId, mergerPrompts]);

  const nodeMergerPrompt = useMemo(() => {
    if (!isNodeMergerSelected && !selectedPublicationMerger) return "";
    const originalGoal = state.graph.originalGoal || state.planning?.goal || "";
    const targetTask = isNodeMergerSelected
      ? (state.graph.nodes.find((item) => item.name === nodeMergerTarget)?.task || originalGoal)
      : originalGoal;
    return getMergerSystemPrompt(targetTask);
  }, [isNodeMergerSelected, selectedPublicationMerger, nodeMergerTarget, state.graph.nodes, state.graph.originalGoal, state.planning?.goal]);

  const activeMergerPrompt = (selectedMerger?.id ? mergerPrompts[selectedMerger.id] : undefined) || nodeMergerPrompt;

  const selectedNode = (isNodeMergerSelected
    ? { name: selected, task: activeMergerPrompt }
    : state.graph.nodes.find((item) => item.name === selected))
    ?? (selectedPublicationMerger ? { name: publicationMergerCardId, task: activeMergerPrompt } : undefined);
  const selectedState = selectedNode && !publicationMergerSelected && !isNodeMergerSelected
    ? state.nodes[selectedNode.name]
    : undefined;
  // Publication Mergers record their steered turns under the literal node name
  // "merger", while node Mergers record under `merge:<node>`.
  const conversationNode = publicationMergerSelected
    ? "merger"
    : isNodeMergerSelected
      ? `merge:${nodeMergerTarget}`
      : (selectedNode?.name ?? "");
  const selectedNodeLabel = publicationMergerSelected
    ? t("publication merger")
    : isNodeMergerSelected
      ? t("merger · {0}", nodeMergerTarget)
      : (selectedNode?.name ?? "");
  const placeholderNodeName = useMemo(() => {
    if (!selectedNode?.name) return "";
    return selectedNode.name.length > 16
      ? `${selectedNode.name.slice(0, 14)}…`
      : selectedNode.name;
  }, [selectedNode?.name]);
  const selectedMergerContinuable = !!selectedMerger && !selectedMergerRunning &&
    (selectedMerger.node === "merger" || selectedMerger.status === "failed");
  const initialTaskEdit = useMemo(() => {
    if (!selectedNode) return undefined;
    return [...state.events].reverse().find(event => event.type === "conversation_edited" &&
      event.target === selectedNode.name && event.first_turn);
  }, [selectedNode?.name, state.events]);
  const initialTaskVersions = useMemo(() => {
    return initialTaskEdit ? versionsForEdit(state, initialTaskEdit) : undefined;
  }, [initialTaskEdit, state.events]);
  const nodeMessages = useMemo(() => {
    if (!selectedNode) return [];
    const localMessages = effectiveMessages.filter((msg) => msg.role === "user" && msg.node === conversationNode && msg.runId === state.runId);
    const latestEdit = [...state.events].reverse().find((event) =>
      event.type === "conversation_edited" && event.target === conversationNode && event.nodes?.includes(conversationNode));
    const local = latestEdit?.old_instruction
      ? (() => {
        const index = localMessages.findIndex((msg) =>
          msg.text.replace(/^\[@[^\]]+\]\s*/, "").trim() === latestEdit.old_instruction);
        return index >= 0 ? localMessages.slice(0, index) : localMessages;
      })()
      : localMessages;
    const localRemaining = [...local];
    const rolledBackTurns = new Set<string>();
    for (const msg of local) {
      if (msg.versions && msg.currentVersionIndex !== undefined) {
        for (let i = 0; i < msg.versions.length; i++) {
          if (i !== msg.currentVersionIndex) {
            for (const sub of msg.versions[i].subsequentEntries ?? []) {
              const cleanSub = sub.text.replace(/^\[@[^\]]+\]\s*/, "").trim();
              if (cleanSub) rolledBackTurns.add(cleanSub);
            }
          }
        }
      }
    }
    const recorded = activeNodeConversationEvents(state, conversationNode).filter((event) =>
      ((event.type === "invalidated" && event.human) || (event.type === "conversation_edited" && !event.first_turn)) && event.target === conversationNode && !!event.instruction ||
      ((event.type === "steered" || event.type === "node_messaged") && event.node === conversationNode)
    ).filter((event) => {
      if (event.instruction && rolledBackTurns.has(event.instruction.trim())) return false;
      return true;
    }).reverse().filter((event) => {
      // Match each optimistic turn to at most one durable event, from newest
      // to oldest, so repeated identical messages do not disappear.
      const idx = localRemaining.findIndex((msg) => msg.text.replace(/^\[@[^\]]+\]\s*/, "").trim() === (event.instruction ?? "").trim());
      if (idx < 0) return true;
      localRemaining.splice(idx, 1);
      // Keep the durable replacement; excluding both turns would make an
      // accepted steer or follow-up disappear from the conversation.
      return true;
    }).reverse().map((event): ChatMessage => {
      const matchingLocal = local.find((msg) => msg.text.replace(/^\[@[^\]]+\]\s*/, "").trim() === (event.instruction ?? "").trim());
      return {
        id: `event-${event.sequence}`, parentId: null, role: "user",
        text: event.instruction || "", images: event.images, node: conversationNode, runId: state.runId,
        executionId: executionIdForMessage(state, event),
        pendingExecution: state.nodes[conversationNode]?.pendingMessages?.some(message => message.sequence === event.sequence),
        versions: event.type === "conversation_edited" ? versionsForEdit(state, event) : matchingLocal?.versions,
        currentVersionIndex: event.type === "conversation_edited" ? versionIndexForEdit(state, event) : matchingLocal?.currentVersionIndex,
        delivery: event.type === "node_messaged" || event.type === "steered" ? event.type : undefined,
      };
    });
    return [...recorded, ...localRemaining];
  }, [selectedNode?.name, conversationNode, effectiveMessages, state.runId, state.events]);
  const attempts = useMemo(() => {
    if (!selectedNode) return [];
    if (publicationMergerSelected) {
      return (state.mergers ?? []).filter((item) => item.node === "merger").sort((a, b) => a.startedAt - b.startedAt);
    }
    if (isNodeMergerSelected) {
      return (state.mergers ?? []).filter((item) => item.node === `merge:${nodeMergerTarget}`).sort((a, b) => a.startedAt - b.startedAt);
    }
    return activeNodeExecutions(state, selectedNode.name).sort((a, b) => a.startedAt - b.startedAt);
  }, [selectedNode?.name, publicationMergerSelected, isNodeMergerSelected, nodeMergerTarget, state.executions, state.supersededExecutionIds, state.mergers]);
  const execution: Execution | undefined = selectedMerger ?? attempts.find((item) => item.id === attemptId) ?? attempts[attempts.length - 1];
  // Session details describe the Pi session, not one attempt: follow-ups and
  // retries resume the same session file, so its clock accumulates too.
  const allExecutions = useMemo(() => [...state.executions, ...(state.mergers ?? [])], [state.executions, state.mergers]);
  const executionSession = useMemo(() => executionSessionTiming(allExecutions, execution), [allExecutions, execution]);
  // The backend reports one total per session; an older attempt instead shows
  // only the usage accumulated through that attempt. A partial prefix would be
  // misleading, so token details are omitted when any usage is missing.
  const executionUsageThrough = useMemo(() => executionSessionUsageThrough(allExecutions, execution),
    [allExecutions, execution]);
  const executionUsage = executionUsageThrough.latest
    // The backend's session total is authoritative; a complete per-attempt
    // prefix covers snapshots that predate it.
    ? (sessionTokenUsage(state.runMetrics?.sessionUsage, execution?.sessionId)
      ?? (executionUsageThrough.complete ? executionUsageThrough.usage : undefined))
    : executionUsageThrough.usage;
  const executionContext = executionUsageThrough.latest
    ? (sessionContext(state.runMetrics?.sessionContext, execution?.sessionId)
      ?? attemptSessionContext(execution?.metrics))
    : attemptSessionContext(execution?.metrics);
  const showExecutionTokenUsage = !execution || executionUsageThrough.latest || executionUsageThrough.complete;
  const isMerger = publicationMergerSelected || isNodeMergerSelected;
  // Before the first execution, the task at the top is the newest information.
  // Count superseded executions too: an edited node is not a never-run node.
  const isUnrunNode = !!selectedNode && !isMerger &&
    !state.executions.some(item => item.node === selectedNode.name);
  const snapshotModelInfo = useMemo(() => {
    if (!execution) return null;
    return resolveExecutionModelAndThinking(
      execution,
      isMerger,
      state.config || config,
      envOverrides,
      // Parsed metrics always win. Legacy attempts that recorded no model still
      // belong to this node's override; the conversation-wide Node Agent
      // setting would misreport nodes that used a different model.
      state.nodes[execution.node]?.modelConfig
    );
  }, [execution, isMerger, state.nodes, state.config, config, envOverrides]);
  const nodeTaskText = selectedNode?.task ?? "";
  const latestNodeMessage = nodeMessages.length > 0 ? nodeMessages[nodeMessages.length - 1] : undefined;
  // Keep each human turn in the same conversation as its Pi execution. A
  // steer is attached to the running execution; a continuation carries the
  // newly-created execution id. Neither case creates a separate UI session.
  const nodeTurns = useMemo(() => {
    if (!selectedNode) return [];
    const turns: Array<{
      id: string;
      isInitial: boolean;
      userMessage?: ChatMessage;
      /** Steers delivered while this turn's execution was live. They belong
       * above that execution's transcript, not in a turn of their own. */
      steerMessages?: ChatMessage[];
      executions: Execution[];
    }> = [{
      id: `turn-0-${selectedNode.name}`,
      isInitial: true,
      executions: attempts.length > 0 ? [attempts[0]] : [],
    }];
    const assigned = new Set(turns[0].executions.map(item => item.id));
    let nextAttempt = 1;

    const lastMessageByExecution = new Map(nodeMessages.filter(message => !message.delivery && message.executionId)
      .map(message => [message.executionId, message.id]));
    for (const message of nodeMessages) {
      // A steer has no execution of its own: Pi consumes it inside the running
      // session. Rendering it as a separate turn puts the user's message below
      // the response it produced, so keep it with the execution it targets.
      if (message.delivery === "steered" && message.executionId) {
        const owner = turns.find(turn => turn.executions.some(exec => exec.id === message.executionId));
        if (owner) {
          (owner.steerMessages ??= []).push(message);
          continue;
        }
      }
      const exact = message.executionId && lastMessageByExecution.get(message.executionId) === message.id
        ? attempts.find(item => item.id === message.executionId && !assigned.has(item.id))
        : undefined;
      let executions: Execution[] = exact ? [exact] : [];
      if (exact) {
        assigned.add(exact.id);
        nextAttempt = Math.max(nextAttempt, attempts.findIndex(item => item.id === exact.id) + 1);
      } else if (!message.delivery && !message.executionId && !message.pendingExecution) {
        // Older snapshots did not persist execution_id on every edit. Keep the
        // historical attempt ordering as a compatibility fallback.
        while (nextAttempt < attempts.length && assigned.has(attempts[nextAttempt].id)) nextAttempt += 1;
        if (nextAttempt < attempts.length) {
          executions = [attempts[nextAttempt]];
          assigned.add(attempts[nextAttempt].id);
          nextAttempt += 1;
        }
      }
      turns.push({ id: message.id, isInitial: false, userMessage: message, executions });
    }

    // A browser opened after a run finished may have no durable human event for
    // an older attempt. Do not hide its output; keep it in the initial turn.
    const unassigned = attempts.filter(item => !assigned.has(item.id));
    if (unassigned.length > 0) turns[0].executions.push(...unassigned);
    turns[0].executions.sort((a, b) => a.startedAt - b.startedAt);
    return turns;
  }, [selectedNode?.name, attempts, nodeMessages]);
  // While a merger is selected its own process decides the working state, not
  // the node status that covers the whole preparation/execution cycle.
  const selectedDependenciesCompleted = !selectedNode ||
    nodeDependenciesCompleted(state.graph, state.nodes, selectedNode.name);
  const isSelectedNodeWorking = selectedMerger
    ? !!selectedMergerRunning || (!!pendingRequest && selectedMerger.status !== "completed" && selectedMerger.status !== "failed")
    : isNodeWorking(selectedState?.status, execution, pendingRequest, latestNodeMessage,
      state.paused, selectedDependenciesCompleted, (selectedState?.pendingMessages?.length ?? 0) > 0);
  const isSelectedNodeCompacting = isSelectedNodeWorking &&
    !!execution?.id && !!compactingAttempts[execution.id];
  const latestNodeTurn = nodeTurns.at(-1);
  const waitingForNodeExecution = !!latestNodeTurn && latestNodeTurn.executions.length === 0 &&
    !latestNodeTurn.userMessage?.delivery && !latestNodeTurn.userMessage?.executionId && (isSelectedNodeWorking || pendingRequest);
  // Apply the continuation layout with the optimistic message, rather than
  // waiting for the backend to insert a new execution and its record header.
  const showExecutionRecords = attempts.length > 1 || (waitingForNodeExecution && attempts.length > 0);
  const provisionalRunIdRef = useRef<string | null>(null);
  if (state.runId.startsWith("pending-")) {
    provisionalRunIdRef.current = state.runId;
  }
  const currentRunKey = useMemo(() => {
    // When a newly initiated conversation's provisional pending-* runId resolves
    // to the real server-assigned runId, keep the key stable so the graph pane,
    // canvas, and chat view do not unmount and flicker right after the first send.
    if (provisionalRunIdRef.current && state.runId && !state.runId.startsWith("pending-")) {
      return provisionalRunIdRef.current;
    }
    return state.runId || state.graph.originalGoal || "initial";
  }, [state.runId, state.graph.originalGoal]);
  const conversationViewKey = `${currentRunKey}:${routeType}:${selected || "planner"}`;
  const composerDraftKey = JSON.stringify([selected, selectedMerger?.id ?? ""]);
  const handleComposerChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = event.target.value;
    if (text) composerDrafts?.set(composerDraftKey, text);
    else composerDrafts?.delete(composerDraftKey);
  };
  const smoothPlannerText = useSmoothStreamText(plannerStream.plannerText, isPlanning);
  // Live SSE is ephemeral. After reload or run selection, replay the durable
  // planning JSONL associated with the selected run, never a previous run's stream.
  const backgroundReview = plannerStream.stage !== "planning" && state.events.some(event =>
    event.type === "planner_review_started" && event.planning?.planningId === state.planningId);
  const showLivePlanner = !backgroundReview && !recoveredPlanningId && (isPlanning ||
    ((plannerStream.runId === state.runId || (provisionalRunIdRef.current && (plannerStream.runId === provisionalRunIdRef.current || state.runId === provisionalRunIdRef.current))) && plannerStream.items?.length > 0));
  const savedPlannerId = recoveredPlanningId || (failedPlanning
    ? (failedPlanning.roles?.planner ? failedPlanning.planningId : undefined)
    : (routeType === "graph" ? state.planningId : undefined));
  // Actual per-turn cwd comes from backend selection, never inferred from the
  // newest node card (linear handoff and parallel branches can change ownership).
  // Checkpointed snapshots may omit older selection events, so fold in the
  // durable current/failed summaries rather than showing an empty history.
  const plannerWorkspaces = useMemo(() => {
    const turns = state.events.flatMap(event =>
      event.type === "planner_workspace_selected" && event.planning?.worktree ? [event.planning] : []);
    const seen = new Set(turns.map(turn => turn.planningId));
    for (const summary of [failedPlanning, state.planning]) {
      if (summary?.worktree && !seen.has(summary.planningId)) {
        turns.push(summary);
        seen.add(summary.planningId);
      }
    }
    return turns;
  }, [state.events, state.planning, failedPlanning]);
  const plannerWorkspace = state.planning?.worktree
    ?? failedPlanning?.worktree ?? plannerWorkspaces.at(-1)?.worktree;
  const plannerRole = state.planning?.roles?.planner ?? failedPlanning?.roles?.planner;
  const plannerModelInfo = (() => {
    const configured = roleModelConfig(config, "planner", envOverrides);
    return {
      model: plannerRole?.model?.trim() || configured.model || t("未设置模型"),
      thinkingLevel: configured.thinkingLevel || "low",
    };
  })();
  // Summaries persisted before contexts were recorded still show their turn.
  const plannerContext = sessionContext(state.runMetrics?.sessionContext, plannerRole?.sessionId)
    ?? (plannerRole?.contextTokens ? { tokens: plannerRole.contextTokens, peak: plannerRole.contextPeak ?? 0 } : undefined);
  // Keep the session's first start aligned with the accumulated `time took`:
  // Planner follow-ups resume one Pi session instead of starting a new clock.
  const plannerTurnHistory = useMemo(() => mergePlannerTurns(
    plannerTurnSummaries(state.events), [failedPlanning, state.planning]),
    [state.events, failedPlanning, state.planning]);
  const displayedPlannerTurnId = state.planning?.planningId ?? failedPlanning?.planningId;
  const plannerSession = useMemo(() => plannerSessionTiming(plannerTurnHistory, {
    // While a turn streams (owned or recovered), its clock is live and every
    // completed turn is prior; after it settles the displayed turn owns its
    // own duration again.
    latestId: isPlanning ? null : displayedPlannerTurnId,
    fallbackStartedAt: plannerStream?.startedAt,
  }), [plannerTurnHistory, isPlanning, displayedPlannerTurnId, plannerStream?.startedAt]);
  const plannerStartTime = plannerSession.startedAt
    ?? (isPlanning ? plannerStream?.startedAt : plannerRole?.sessionStart);
  // The live clock starts with this turn, not with the whole session; a
  // recovered turn has no browser stream start, so fall back to its durable
  // creation time instead of restarting from zero on reload.
  const displayedPlannerTurn = plannerTurnHistory.find(turn => turn.planningId === displayedPlannerTurnId)
    ?? plannerTurnHistory.at(-1);
  const plannerLiveTurnStart = plannerStream?.startedAt
    ?? displayedPlannerTurn?.createdAt
    ?? (plannerRole?.sessionStart ? Number(plannerRole.sessionStart) : undefined);
  const plannerUsageThrough = useMemo(
    () => plannerSessionUsageThrough(plannerTurnHistory, displayedPlannerTurnId),
    [plannerTurnHistory, displayedPlannerTurnId]);
  // Turns recorded before session IDs existed cannot appear in the backend's
  // per-session bucket, yet the displayed conversation still contains them.
  const plannerBackendUsage = plannerUsageThrough.latest
    ? sessionTokenUsage(state.runMetrics?.sessionUsage, plannerRole?.sessionId)
    : undefined;
  const plannerLegacy = useMemo(
    () => plannerBackendUsage ? plannerLegacyUsage(plannerTurnHistory, displayedPlannerTurnId) : undefined,
    [plannerBackendUsage, plannerTurnHistory, displayedPlannerTurnId]);
  const plannerUsage = plannerUsageThrough.latest
    ? (plannerBackendUsage
      ? (plannerLegacy ? addTokenUsage(plannerBackendUsage, plannerLegacy) : plannerBackendUsage)
      : ((plannerUsageThrough.complete ? plannerUsageThrough.usage : undefined)
        ?? plannerRole?.usage))
    : plannerUsageThrough.usage;
  const displayedPlannerContext = plannerUsageThrough.latest
    ? plannerContext
    : attemptSessionContext(plannerRole);
  const showPlannerTokenUsage = plannerUsageThrough.latest || plannerUsageThrough.complete;
  // The panel also carries the planner's working indicator, so it must exist
  // for the whole live-planning window, before the summary reaches a snapshot.
  const showPlannerDetails = routeType !== "serial";
  // A run owns one Planner conversation, although each planning attempt has
  // its own durable output log. Replay every recorded turn after a reload —
  // including aborted revision turns — excluding turns still live-streaming.
  const savedPlannerIds = useMemo(() => plannerHistoryIds({
    events: state.events,
    savedPlannerId,
    planning: isPlanning,
    live: Boolean(showLivePlanner),
    continuation: plannerStream.isContinuation,
    backgroundReview,
    recoveredPlanningId,
    routeType,
    representedIds: plannerStream.representedPlanningIds,
  }), [routeType, isPlanning, backgroundReview, recoveredPlanningId, state.events, savedPlannerId, showLivePlanner, plannerStream.isContinuation, plannerStream.representedPlanningIds]);
  const plannerEdits = useMemo(() => plannerConversationEdits(state.events), [state.events]);
  const savedPlannerKey = savedPlannerIds.join(":");
  const [readySavedPlannerKey, setReadySavedPlannerKey] = useState("");
  const [savedPlannerRecord, setSavedPlannerRecord] = useState({ key: "", text: "" });
  const savedPlannerOutput = savedPlannerRecord.key === savedPlannerKey ? savedPlannerRecord.text
    : cachedPlanningOutput(transcriptRunId, savedPlannerIds);
  const plannerMessages = useMemo(() => effectiveMessages.filter((msg) => !msg.node || msg.node === "planner"), [effectiveMessages]);
  const livePlannerItems = useMemo(() => {
    const items = (plannerStream.items ?? []) as TranscriptItem[];
    // The first turn is always rendered above the transcript. A continuation
    // seeds the live stream with that same edited message, so keep the
    // canonical bubble instead of rendering it twice.
    return withoutLiveFirstTurn(items, plannerMessages[0]?.id);
  }, [plannerStream.items, plannerMessages]);
  // The history is also what tells the saved replay to skip the turn already
  // rendered as the conversation header. A header-only conversation still has
  // one persisted turn, so this must not short-circuit to an empty list or the
  // replay renders the goal a second time.
  const persistedTurnHistory = useMemo(() =>
    plannerUserTurns(activePlannerOutput(savedPlannerOutput, plannerEdits)),
    [savedPlannerOutput, plannerEdits]);
  // Only hide an optimistic turn when the transcript really replays that turn.
  // A partial window that starts at a steer keeps the header out of history, so
  // skipping its first row would drop the user's message instead of a duplicate.
  const skipFirstPersistedTurn = skipsFirstPersistedTurn(persistedTurnHistory, plannerMessages[0]?.text);
  const persistedUserTurns = useMemo(() => skipFirstPersistedTurn
    ? persistedTurnHistory.slice(1) : persistedTurnHistory,
    [persistedTurnHistory, skipFirstPersistedTurn]);
  const remainingPersistedTurns = new Map<string, number>();
  for (const text of persistedUserTurns) {
    remainingPersistedTurns.set(text, (remainingPersistedTurns.get(text) ?? 0) + 1);
  }
  const effectiveRouteType = useMemo(() => {
    if (routeType !== "undecided") return routeType;
    if (state.planType) return state.planType;
    return "undecided";
  }, [routeType, state.planType]);

  const showRouteBadge = useMemo(() => {
    return shouldShowRouteBadge({
      initialPlanMode,
      plannerStream,
      state,
      routeType,
    });
  }, [
    initialPlanMode,
    plannerStream?.initialPlanMode,
    plannerStream?.stage,
    plannerStream?.partitionerText,
    plannerStream?.partitionerThinking,
    state.events,
    state.planning?.roles?.partition,
    routeType,
    state.planType,
  ]);
  const useSavedPlanner = savedPlannerIds.length > 0 &&
    (!showLivePlanner || readySavedPlannerKey === savedPlannerKey || Boolean(plannerStream.isContinuation));
  const renderLivePlanner = showLivePlanner && (isPlanning || !useSavedPlanner);
  // A saved transcript only replaces optimistic user turns while it actually
  // renders user rows; hiding a message the transcript suppresses would lose it.
  const savedPlannerShowsUserTurns = !isPlanning || backgroundReview || !!recoveredPlanningId
    || Boolean(plannerStream.isContinuation);
  // A new user turn or any live Planner token makes the committed result cards
  // stale for the moment. Hide them until this turn settles, including while a
  // detached stream is recovered from durable output.
  const hidePlannerResultCards = isPlanning || !!recoveredPlanningId ||
    plannerStream.stage === "planning" || plannerStream.plannerThinkingActive ||
    Boolean(plannerStream.compacting);
  const { workbenchRef, isResizing, splitRatio, handleStartResize, handleResetResizer } = useWorkbenchResizer();
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const expandedCardObserverRef = useRef<ResizeObserver | null>(null);
  const expandedCardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUserScrolledUpRef = useRef(false);
  const shouldFollowOutput = useStableCallback(() => !isUnrunNode && !isUserScrolledUpRef.current);
  const lastScrollTopRef = useRef(0);
  const prevScrollHeightRef = useRef(0);
  const prevViewKeyRef = useRef("");
  const suppressAutoScrollRef = useRef(false);
  const resetChatScrollFrameRef = useRef<number | null>(null);
  const revealChatFrameRef = useRef<number | null>(null);
  const [readyConversationKey, setReadyConversationKey] = useState("");
  const isConversationReady = readyConversationKey === conversationViewKey;
  const reduceMotion = useReducedMotion();
  // Reveal the entire scrollable view together, including the topology overview
  // and publication cards, only after history and its initial scroll have settled.
  const conversationRevealStyle: React.CSSProperties = {
    opacity: isConversationReady ? 1 : 0,
    transition: isConversationReady && !reduceMotion ? "opacity 0.25s ease-out" : "none",
  };
  const activeConversationViewRef = useRef(conversationViewKey);
  const conversationGenerationRef = useRef(0);
  const isScrollingToBottomRef = useRef(false);
  const latestScrollRef = useRef<(() => void) | null>(null);
  const setUserScrolledUp = useCallback((scrolledUp: boolean) => {
    isUserScrolledUpRef.current = scrolledUp;
    const el = chatScrollRef.current;
    if (!el) return;
    if (scrolledUp || !isPreparingConversationRef.current) delete el.dataset.transcriptPreparing;
    else el.dataset.transcriptPreparing = "true";
  }, []);
  const stopLatestScroll = useCallback(() => {
    if (latestScrollRef.current) {
      latestScrollRef.current();
      latestScrollRef.current = null;
      setUserScrolledUp(true);
    }
    isScrollingToBottomRef.current = false;
  }, [setUserScrolledUp]);
  const userGestureUpRef = useRef(false);
  const historyReadingRef = useRef(false);
  const isPreparingConversationRef = useRef(true);
  const readyExecutionIdsRef = useRef(new Set<string>());
  const graphCanvasRef = useRef<HTMLDivElement>(null);
  const scrollBottomBtnRef = useRef<HTMLButtonElement>(null);
  const setScrollBottomVisible = useCallback((visible: boolean) => {
    const btn = scrollBottomBtnRef.current;
    if (btn) {
      if (visible) {
        btn.classList.add("visible");
      } else {
        btn.classList.remove("visible");
      }
    }
  }, []);
  const conversationScrollStateRef = useRef<Map<string, ViewScrollState>>(new Map());
  const previousNodeViewRef = useRef(Boolean(selected));

  if (activeConversationViewRef.current !== conversationViewKey) {
    if (previousNodeViewRef.current) {
      // Its byte window is released on unmount, so an old pixel offset no longer
      // describes the reopened Node's fresh tail. Only Planner positions persist.
      conversationScrollStateRef.current.delete(activeConversationViewRef.current);
    } else if (chatScrollRef.current && activeConversationViewRef.current) {
      conversationScrollStateRef.current.set(activeConversationViewRef.current,
        captureViewScrollState(chatScrollRef.current, isUserScrolledUpRef.current));
    }
    previousNodeViewRef.current = Boolean(selected);
    activeConversationViewRef.current = conversationViewKey;
    conversationGenerationRef.current += 1;
    const saved = conversationScrollStateRef.current.get(conversationViewKey);
    isUserScrolledUpRef.current = saved?.isUserScrolledUp ?? false;
    historyReadingRef.current = false;
    suppressAutoScrollRef.current = false;
    isPreparingConversationRef.current = true;
    readyExecutionIdsRef.current.clear();
  }

  const handleChatScroll = useCallback(() => {
    if (!chatScrollRef.current) return;
    if (suppressAutoScrollRef.current || isPreparingConversationRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatScrollRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const showLatest = !isUnrunNode && distanceFromBottom > clientHeight / 2;
    const prevScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;

    const isScrollingUp = scrollTop < prevScrollTop - 1;
    if (latestScrollRef.current) { setScrollBottomVisible(false); return; }
    if (historyReadingRef.current) {
      setScrollBottomVisible(showLatest);
      return;
    }

    // When near bottom, definitely lock to bottom state (prevent elastic bounce from locking scrolled-up)
    if (distanceFromBottom <= CONVERSATION_BOTTOM_THRESHOLD && !userGestureUpRef.current) {
      isScrollingToBottomRef.current = false;
      setUserScrolledUp(false);
      setScrollBottomVisible(false);
      return;
    }

    if (distanceFromBottom <= CONVERSATION_BOTTOM_THRESHOLD && userGestureUpRef.current && scrollTop >= prevScrollTop) {
      userGestureUpRef.current = false;
      setUserScrolledUp(false);
      isScrollingToBottomRef.current = false;
      setScrollBottomVisible(false);
      return;
    }

    if (isScrollingToBottomRef.current) {
      // While programmatically scrolling to bottom, keep following down until
      // reaching the bottom threshold. Do not allow sub-pixel offset jitter or
      // intermediate row height shifts to abort the scroll down.
      return;
    }

    if (isScrollingUp && distanceFromBottom > CONVERSATION_BOTTOM_THRESHOLD) {
      setUserScrolledUp(true);
      setScrollBottomVisible(showLatest);
      return;
    }

    // A resize or a newly mounted transcript can change the distance without
    // any user scroll. Do not mistake that for an intentional scroll-up.
    setScrollBottomVisible(isUserScrolledUpRef.current && showLatest);
  }, [isUnrunNode, setScrollBottomVisible, setUserScrolledUp]);

  const scrollToBottom = useCallback(() => {
    stopLatestScroll();
    // Explicit Latest takes over from any card reveal/collapse still in flight.
    expandedCardObserverRef.current?.disconnect();
    expandedCardObserverRef.current = null;
    if (expandedCardTimerRef.current !== null) clearTimeout(expandedCardTimerRef.current);
    expandedCardTimerRef.current = null;
    suppressAutoScrollRef.current = false;
    historyReadingRef.current = false;
    if (chatScrollRef.current) delete chatScrollRef.current.dataset.transcriptHistoryReading;
    setUserScrolledUp(false);
    userGestureUpRef.current = false;
    isScrollingToBottomRef.current = true;
    setScrollBottomVisible(false);
    const el = chatScrollRef.current;
    if (!el) return;
    latestScrollRef.current = smoothScrollToLatest(el, () => {
      latestScrollRef.current = null;
      isScrollingToBottomRef.current = false;
      lastScrollTopRef.current = el.scrollTop;
      setScrollBottomVisible(false);
    });
  }, [stopLatestScroll, setScrollBottomVisible, setUserScrolledUp]);

  const handleSendMessageWithScroll = useCallback(async (val: string, options?: PromptBoxSubmitOptions) => {
    const submittedDraft = composerDrafts?.get(composerDraftKey);
    stopLatestScroll();
    historyReadingRef.current = false;
    if (chatScrollRef.current) delete chatScrollRef.current.dataset.transcriptHistoryReading;
    setUserScrolledUp(false);
    userGestureUpRef.current = false;
    isScrollingToBottomRef.current = true;
    setScrollBottomVisible(false);
    const accepted = await onSendMessage(val, options);
    // Acceptance may arrive after this view unmounts. Clear only its own draft,
    // and never a newer draft entered after navigating back to this conversation.
    if (accepted !== false && composerDrafts?.get(composerDraftKey) === submittedDraft) {
      composerDrafts?.delete(composerDraftKey);
    }
    return accepted !== false;
  }, [onSendMessage, stopLatestScroll, setScrollBottomVisible, setUserScrolledUp, composerDrafts, composerDraftKey]);

  // Listen to wheel and touch gestures on chat scroll container to immediately lock auto-scroll upon upward scrolling
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      stopLatestScroll();
      if (e.deltaY > 0.5) {
        historyReadingRef.current = false;
        delete el.dataset.transcriptHistoryReading;
      }
      if (e.deltaY < -0.5) {
        userGestureUpRef.current = true;
        isScrollingToBottomRef.current = false;
        setUserScrolledUp(true);
      }
    };

    let lastTouchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      stopLatestScroll();
      if (e.touches[0]) lastTouchY = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches[0]) {
        const curY = e.touches[0].clientY;
        const delta = curY - lastTouchY;
        lastTouchY = curY;
        if (delta < -1) {
          historyReadingRef.current = false;
          delete el.dataset.transcriptHistoryReading;
        }
        if (delta > 1) {
          userGestureUpRef.current = true;
          isScrollingToBottomRef.current = false;
          setUserScrolledUp(true);
        }
      }
    };

    const onHistoryPrepend = () => {
      stopLatestScroll();
      historyReadingRef.current = true;
      userGestureUpRef.current = true;
      setUserScrolledUp(true);
      isScrollingToBottomRef.current = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
      const up = ["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey);
      const down = ["ArrowDown", "PageDown", "End"].includes(event.key) || (event.key === " " && !event.shiftKey);
      if (up || down) stopLatestScroll();
      if (up) {
        userGestureUpRef.current = true;
        setUserScrolledUp(true);
        isScrollingToBottomRef.current = false;
      } else if (down) {
        historyReadingRef.current = false;
        delete el.dataset.transcriptHistoryReading;
      }
    };
    el.addEventListener(HISTORY_PREPEND_EVENT, onHistoryPrepend);
    el.addEventListener("pointerdown", stopLatestScroll);
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });

    return () => {
      el.removeEventListener(HISTORY_PREPEND_EVENT, onHistoryPrepend);
      el.removeEventListener("pointerdown", stopLatestScroll);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [conversationViewKey, stopLatestScroll, setUserScrolledUp]);

  const handleExpandableContentChange = useCallback((expanded?: boolean, card?: HTMLElement) => {
    suppressAutoScrollRef.current = true;
    setUserScrolledUp(true);
    expandedCardObserverRef.current?.disconnect();
    expandedCardObserverRef.current = null;
    if (expandedCardTimerRef.current !== null) clearTimeout(expandedCardTimerRef.current);
    // Keep automatic bottom following paused for the full animation; resuming
    // after two frames would fight the reveal and push the header offscreen.
    const finishResize = () => {
      if (chatScrollRef.current) prevScrollHeightRef.current = chatScrollRef.current.scrollHeight;
      suppressAutoScrollRef.current = false;
      handleChatScroll();
    };

    // Follow the card during its opening animation, without jumping past the
    // header when the expanded content is taller than the viewport.
    if (expanded && card) {
      const reveal = () => {
        const scroll = chatScrollRef.current;
        if (!scroll || !scroll.contains(card)) return;
        const viewport = getConversationViewport(scroll);
        const bounds = card.getBoundingClientRect();
        const available = viewport.height - 24;
        const delta = bounds.height > available
          ? bounds.top - viewport.top - 12
          : bounds.bottom - viewport.bottom + 12;
        if (delta > 0) scroll.scrollTop += delta;
      };
      const observer = new ResizeObserver(reveal);
      observer.observe(card);
      const composer = chatScrollRef.current?.parentElement?.querySelector(".pane-bottom-chat");
      if (composer) observer.observe(composer);
      expandedCardObserverRef.current = observer;
      expandedCardTimerRef.current = setTimeout(() => {
        reveal();
        observer.disconnect();
        if (expandedCardObserverRef.current === observer) expandedCardObserverRef.current = null;
        expandedCardTimerRef.current = null;
        finishResize();
      }, 400);
    } else {
      // During collapsing, keep auto-scroll suppressed across the collapse animation
      // and synchronize prevScrollHeight so height shrinkage does not misinterpret
      // as an intentional user scroll-up.
      expandedCardTimerRef.current = setTimeout(() => {
        expandedCardTimerRef.current = null;
        finishResize();
      }, 260);
    }
  }, [handleChatScroll]);

  const followExecutionExpansion = useCallback((panelEl: HTMLElement, hasExpandedBelow: boolean) => {
    if (expandedCardObserverRef.current) {
      expandedCardObserverRef.current.disconnect();
      expandedCardObserverRef.current = null;
    }
    if (expandedCardTimerRef.current !== null) {
      clearTimeout(expandedCardTimerRef.current);
      expandedCardTimerRef.current = null;
    }

    const scroll = chatScrollRef.current;
    if (!scroll) return;

    const follow = () => {
      const scrollEl = chatScrollRef.current;
      if (!scrollEl || !scrollEl.contains(panelEl)) return;

      if (!hasExpandedBelow) {
        // No expanded attempt below: follow all the way to bottom so the user sees the latest output
        scrollEl.scrollTop = scrollEl.scrollHeight;
        lastScrollTopRef.current = scrollEl.scrollTop;
      } else {
        // There is an expanded attempt below: reveal the bottom of this execution panel
        const viewport = getConversationViewport(scrollEl);
        const bounds = panelEl.getBoundingClientRect();
        const delta = bounds.bottom - viewport.bottom + 16;
        if (delta > 0) {
          scrollEl.scrollTop += delta;
          lastScrollTopRef.current = scrollEl.scrollTop;
        }
      }
    };

    // Follow immediately
    follow();

    // Observe size changes as transcript lines load and measure
    const observer = new ResizeObserver(() => {
      follow();
    });
    observer.observe(panelEl);
    expandedCardObserverRef.current = observer;

    // Keep following across the initial transcript load and settle
    expandedCardTimerRef.current = setTimeout(() => {
      follow();
      observer.disconnect();
      if (expandedCardObserverRef.current === observer) {
        expandedCardObserverRef.current = null;
      }
      expandedCardTimerRef.current = null;
      if (!hasExpandedBelow) {
        setUserScrolledUp(false);
        suppressAutoScrollRef.current = false;
      }
      handleChatScroll();
    }, 600);
  }, [handleChatScroll, setUserScrolledUp]);

  // New turns must not hide earlier output. Only an explicit user toggle
  // collapses a record, and that choice stays with its execution id.
  const isAttemptExpanded = useCallback((execId: string) => {
    return !showExecutionRecords || !collapsedAttemptIds.has(execId);
  }, [showExecutionRecords, collapsedAttemptIds]);

  const handleToggleAttempt = useCallback((execId: string, panelEl?: HTMLElement | null) => {
    const currentlyExpanded = isAttemptExpanded(execId);
    const willExpand = !currentlyExpanded;

    const attemptIndex = attempts.findIndex(a => a.id === execId);
    const hasExpandedBelow = attemptIndex >= 0 && attempts.slice(attemptIndex + 1).some(a => isAttemptExpanded(a.id));

    if (willExpand) {
      if (!hasExpandedBelow) {
        setUserScrolledUp(false);
        userGestureUpRef.current = false;
        suppressAutoScrollRef.current = false;
      } else {
        setUserScrolledUp(true);
        suppressAutoScrollRef.current = true;
      }
    } else {
      suppressAutoScrollRef.current = true;
      setUserScrolledUp(true);
    }

    setCollapsedAttemptIds((prev) => {
      const next = new Set(prev);
      if (currentlyExpanded) next.add(execId);
      else next.delete(execId);
      return next;
    });

    if (panelEl) {
      if (willExpand) {
        followExecutionExpansion(panelEl, hasExpandedBelow);
      } else {
        // On collapse, keep auto-scroll suppressed while shrinking so view doesn't jump
        expandedCardObserverRef.current?.disconnect();
        expandedCardObserverRef.current = null;
        if (expandedCardTimerRef.current !== null) clearTimeout(expandedCardTimerRef.current);
        expandedCardTimerRef.current = setTimeout(() => {
          if (chatScrollRef.current) {
            prevScrollHeightRef.current = chatScrollRef.current.scrollHeight;
          }
          suppressAutoScrollRef.current = false;
          expandedCardTimerRef.current = null;
          handleChatScroll();
        }, 260);
      }
    }
  }, [isAttemptExpanded, attempts, followExecutionExpansion, handleChatScroll]);

  useLayoutEffect(() => {
    const view = chatScrollRef.current?.parentElement;
    const composer = view?.querySelector<HTMLElement>(".pane-bottom-chat");
    if (!view || !composer) return;
    const update = () => {
      const composerHeight = composer.getBoundingClientRect().height;
      view.style.setProperty("--composer-height", `${composerHeight}px`);
      // Also track the settled (collapsed and idle) composer height. The Latest
      // button anchors to it while the input box is expanding so it fades out in
      // place instead of riding the growing height; it never binds this while
      // collapsing (.expanded is gone), so it still lands at rest on reveal.
      const isSettled = !composer.querySelector(".prompt-box-container.expanded")
        && !composer.querySelector(".prompt-box-container[data-resizing]");
      if (isSettled) {
        view.style.setProperty("--composer-height-resting", `${composerHeight}px`);
      }
      // The composer is overlaid; changing its height changes the scroll area's
      // bottom padding without resizing the observed transcript content.
      const scroll = chatScrollRef.current;
      if (scroll && shouldFollowOutput() && !isScrollingToBottomRef.current) {
        scroll.scrollTop = scroll.scrollHeight;
        lastScrollTopRef.current = scroll.scrollTop;
        setScrollBottomVisible(false);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [conversationViewKey, setScrollBottomVisible, shouldFollowOutput]);

  useEffect(() => () => {
    expandedCardObserverRef.current?.disconnect();
    if (expandedCardTimerRef.current !== null) clearTimeout(expandedCardTimerRef.current);
    if (workspaceDetailsTimerRef.current !== null) clearTimeout(workspaceDetailsTimerRef.current);
    stopLatestScroll();
    if (resetChatScrollFrameRef.current !== null) {
      cancelAnimationFrame(resetChatScrollFrameRef.current);
    }
    if (revealChatFrameRef.current !== null) {
      cancelAnimationFrame(revealChatFrameRef.current);
    }
  }, []);

  const workspaceDetailsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleWorkspaceDetailsBeforeToggle = useCallback(() => {
    suppressAutoScrollRef.current = true;
    if (chatScrollRef.current) {
      prevScrollHeightRef.current = chatScrollRef.current.scrollHeight;
      lastScrollTopRef.current = chatScrollRef.current.scrollTop;
    }
    if (workspaceDetailsTimerRef.current !== null) {
      clearTimeout(workspaceDetailsTimerRef.current);
    }
    // Safety fallback in case animation is somehow abruptly interrupted
    workspaceDetailsTimerRef.current = setTimeout(() => {
      workspaceDetailsTimerRef.current = null;
      suppressAutoScrollRef.current = false;
      if (chatScrollRef.current) {
        prevScrollHeightRef.current = chatScrollRef.current.scrollHeight;
        lastScrollTopRef.current = chatScrollRef.current.scrollTop;
      }
      handleChatScroll();
    }, 450);
  }, [handleChatScroll]);

  const handleWorkspaceDetailsAfterToggle = useCallback(() => {
    if (workspaceDetailsTimerRef.current !== null) {
      clearTimeout(workspaceDetailsTimerRef.current);
      workspaceDetailsTimerRef.current = null;
    }
    suppressAutoScrollRef.current = false;
    if (chatScrollRef.current) {
      prevScrollHeightRef.current = chatScrollRef.current.scrollHeight;
      lastScrollTopRef.current = chatScrollRef.current.scrollTop;
    }
    handleChatScroll();
  }, [handleChatScroll]);

  // Ensure scroll button visibility is evaluated immediately on render and on size changes
  useLayoutEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;

    handleChatScroll(); // initial check

    const observer = new ResizeObserver(() => {
      const el = chatScrollRef.current;
      if (!el) return;

      const currentScrollHeight = el.scrollHeight;
      const heightGrew = currentScrollHeight > prevScrollHeightRef.current + 2;
      const heightShrankWhilePreparing = isPreparingConversationRef.current &&
        currentScrollHeight < prevScrollHeightRef.current - 2;
      prevScrollHeightRef.current = currentScrollHeight;

      if (suppressAutoScrollRef.current) return;

      // Keep the newest output visible while content arrives. This includes the
      // initial preparation window: returning early there left a freshly opened
      // history stuck at the top until the user scrolled manually.
      if ((heightGrew || heightShrankWhilePreparing) && !latestScrollRef.current && (shouldFollowOutput() || isScrollingToBottomRef.current)) {
        el.scrollTop = currentScrollHeight;
        lastScrollTopRef.current = el.scrollTop;
      } else if (!isUserScrolledUpRef.current && !latestScrollRef.current) {
        lastScrollTopRef.current = el.scrollTop;
      }
      handleChatScroll();
    });

    observer.observe(el);
    if (el.firstElementChild) {
      observer.observe(el.firstElementChild);
    }

    return () => observer.disconnect();
  }, [handleChatScroll, conversationViewKey, shouldFollowOutput]);

  // Auto-scroll to bottom when new messages or streaming content arrives
  useLayoutEffect(() => {
    if (!latestScrollRef.current && shouldFollowOutput() && !suppressAutoScrollRef.current && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      lastScrollTopRef.current = chatScrollRef.current.scrollTop;
    }
  }, [
    effectiveMessages,
    smoothPlannerText,
    plannerStream.items,
    plannerStream.plannerThinking,
    isPlanning,
    isUnrunNode,
    shouldFollowOutput,
    execution?.id,
    execution?.status,
    execution?.outputBytes,
    execution?.output,
    state.publication?.status,
    state.phase,
  ]);

  const summaryNodes = useMemo(() => {
    if (!state.graph.nodes.length) return [];
    const nodeMap = new Map(state.graph.nodes.map((node) => [node.name, node]));
    const layers = computeExecutionLayers(state.graph, state.plan);
    const seen = new Set<string>();
    const ordered: GraphNode[] = [];
    for (const name of layers.flat()) {
      const node = nodeMap.get(name);
      if (node && !seen.has(name)) {
        seen.add(name);
        ordered.push(node);
      }
    }
    for (const node of state.graph.nodes) {
      if (!seen.has(node.name)) {
        ordered.push(node);
      }
    }
    return ordered;
  }, [state.graph, state.plan]);

  const serialNode = routeType === "serial" && state.graph.nodes.length > 0 ? state.graph.nodes[0] : undefined;
  const serialNodeState = serialNode ? state.nodes[serialNode.name] : undefined;
  const serialExecutions = useMemo(() => {
    if (!serialNode) return [];
    return activeNodeExecutions(state, serialNode.name)
      .sort((a, b) => a.startedAt - b.startedAt);
  }, [serialNode?.name, state.executions, state.supersededExecutionIds]);
  const serialExecution: Execution | undefined = serialExecutions[serialExecutions.length - 1];
  const serialSession = useMemo(() => executionSessionTiming(allExecutions, serialExecution), [allExecutions, serialExecution]);
  const serialUsageThrough = useMemo(() => executionSessionUsageThrough(allExecutions, serialExecution),
    [allExecutions, serialExecution]);
  const serialUsage = serialUsageThrough.latest
    ? (sessionTokenUsage(state.runMetrics?.sessionUsage, serialExecution?.sessionId)
      ?? (serialUsageThrough.complete ? serialUsageThrough.usage : undefined))
    : serialUsageThrough.usage;
  const serialContext = serialUsageThrough.latest
    ? (sessionContext(state.runMetrics?.sessionContext, serialExecution?.sessionId)
      ?? attemptSessionContext(serialExecution?.metrics))
    : attemptSessionContext(serialExecution?.metrics);
  const showSerialTokenUsage = !serialExecution || serialUsageThrough.latest || serialUsageThrough.complete;
  const serialModelInfo = useMemo(() => {
    if (!serialExecution) return null;
    return resolveExecutionModelAndThinking(
      serialExecution,
      false,
      state.config || config,
      envOverrides,
      serialNodeState?.modelConfig
    );
  }, [serialExecution, serialNodeState?.modelConfig, state.config, config, envOverrides]);

  const serialTurns = useMemo(() => {
    if (routeType !== "serial") return [];
    const turns: Array<{
      id: string;
      userMessage: ChatMessage;
      isInitial: boolean;
      /** Steers delivered while this turn's execution was live. Keep them above
       * the transcript they steered instead of creating a later empty turn. */
      steerMessages?: ChatMessage[];
      executions: Execution[];
    }> = [];

    let messages: ChatMessage[] = effectiveMessages.length > 0 ? [...effectiveMessages] : (
      state.graph.originalGoal ? [{
        id: "msg-initial-goal",
        parentId: null,
        role: "user" as const,
        text: state.graph.originalGoal,
      }] : []
    );
    // Serial is selected before the backend creates its node. Render the
    // optimistic messages and their waiting space now, not after that snapshot.
    if (!serialNode) {
      return messages.map((userMessage, index) => ({
        id: userMessage.id, userMessage, isInitial: index === 0, executions: [] as Execution[], steerMessages: [] as ChatMessage[],
      }));
    }
    const latestEdit = [...state.events].reverse().find((event) =>
      event.type === "conversation_edited" && event.target === serialNode.name && event.nodes?.includes(serialNode.name));
    if (latestEdit?.old_instruction) {
      const oldIndex = messages.findIndex((msg) =>
        msg.text.replace(/^\[@[^\]]+\]\s*/, "").trim() === latestEdit.old_instruction);
      if (oldIndex >= 0) {
        messages = messages.slice(0, latestEdit.first_turn ? oldIndex + 1 : oldIndex);
        if (latestEdit.first_turn && messages[0]) {
          messages[0] = { ...messages[0], text: serialNode.task };
        }
      }
    }
    const localRemaining = messages.filter((msg) => msg.node === serialNode.name);
    const replacedIds = new Set<string>();
    const recorded = activeNodeConversationEvents(state, serialNode.name).filter((event) =>
      ((event.type === "node_messaged" || event.type === "steered") && event.node === serialNode.name) ||
      ((event.type === "invalidated" && event.human || (event.type === "conversation_edited" && !event.first_turn)) && event.target === serialNode.name && !!event.instruction)
    ).reverse().filter((event) => {
      const idx = localRemaining.findIndex((msg) => msg.text.replace(/^\[@[^\]]+\]\s*/, "").trim() === event.instruction?.trim());
      if (idx >= 0) replacedIds.add(localRemaining.splice(idx, 1)[0].id);
      return true;
    }).reverse().map((event): ChatMessage => ({
      id: `event-${event.sequence}`, parentId: null, role: "user",
      text: event.instruction || "", images: event.images, node: serialNode.name, runId: state.runId,
      versions: event.type === "conversation_edited" ? versionsForEdit(state, event) : undefined,
      currentVersionIndex: event.type === "conversation_edited" ? versionIndexForEdit(state, event) : undefined,
      executionId: executionIdForMessage(state, event),
      pendingExecution: state.nodes[serialNode.name]?.pendingMessages?.some(message => message.sequence === event.sequence),
      delivery: event.type === "node_messaged" || event.type === "steered" ? event.type : undefined,
    }));
    messages = messages.filter(message => !replacedIds.has(message.id));
    // A fresh browser session may have only a recorded follow-up, not the
    // original prompt in local state. Keep the initial task paired with its execution.
    if (messages[0]?.node === serialNode.name && state.graph.originalGoal) {
      messages.unshift({ id: "msg-initial-goal", role: "user", text: state.graph.originalGoal });
    }
    if (messages.length === 0) return [];
    const initialEdit = [...state.events].reverse().find((event) =>
      event.type === "conversation_edited" && event.target === serialNode.name && event.first_turn);
    if (initialEdit && !messages[0].versions) {
      const versions = versionsForEdit(state, initialEdit);
      messages[0] = { ...messages[0], versions, currentVersionIndex: versionIndexForEdit(state, initialEdit, versions) };
    }
    messages.splice(1, 0, ...recorded);

    turns.push({
      id: messages[0].id,
      userMessage: messages[0],
      isInitial: true,
      executions: serialExecutions.length > 0 ? [serialExecutions[0]] : [],
    });

    const assigned = new Set(turns[0].executions.map(execution => execution.id));
    const followUps = messages.slice(1);
    const lastMessageByExecution = new Map(followUps.filter(message => !message.delivery && message.executionId)
      .map(message => [message.executionId, message.id]));
    for (const msg of followUps) {
      // A steer belongs to the execution that received it, so its response stays
      // below the user bubble instead of appearing above a separate turn.
      if (msg.delivery === "steered" && msg.executionId) {
        const owner = turns.find(turn => turn.executions.some(execution => execution.id === msg.executionId));
        if (owner) {
          (owner.steerMessages ??= []).push(msg);
          continue;
        }
      }
      const exact = msg.executionId && lastMessageByExecution.get(msg.executionId) === msg.id
        ? serialExecutions.find(execution => execution.id === msg.executionId && !assigned.has(execution.id)) : undefined;
      const next = exact ?? (!msg.delivery && !msg.executionId && !msg.pendingExecution
        ? serialExecutions.find(execution => !assigned.has(execution.id)) : undefined);
      const execs = next ? [next] : [];
      if (next) assigned.add(next.id);
      turns.push({ id: msg.id, userMessage: { ...msg, executionId: next?.id ?? msg.executionId }, isInitial: false, executions: execs });
    }

    if (serialExecutions.length > 1) {
      const assigned = new Set(turns.flatMap((t) => t.executions.map((e) => e.id)));
      const unassigned = serialExecutions.filter((e) => !assigned.has(e.id));
      if (unassigned.length > 0) {
        turns[0].executions.push(...unassigned);
        turns[0].executions.sort((a, b) => a.startedAt - b.startedAt);
      }
    }

    return turns;
  }, [routeType, serialNode?.name, effectiveMessages, serialExecutions, state.graph.originalGoal, state.runId, state.events]);

  const isSerialExecution = routeType === "serial" && state.graph.nodes.length > 0;
  const serialWorkingAfterMessage = serialTurns.length > 0 && serialTurns[serialTurns.length - 1].executions.length === 0 &&
    !serialTurns[serialTurns.length - 1].userMessage.executionId;
  const serialDependenciesCompleted = !serialNode ||
    nodeDependenciesCompleted(state.graph, state.nodes, serialNode.name);
  const isSerialWorking = isNodeWorking(serialNodeState?.status, serialExecution, pendingRequest,
    serialWorkingAfterMessage ? serialTurns[serialTurns.length - 1].userMessage : undefined,
    state.paused, serialDependenciesCompleted, (serialNodeState?.pendingMessages?.length ?? 0) > 0);
  // Serial auto-approval runs after planning releases its busy state, and
  // approval returns before the background driver starts the waiting node.
  // Both phases belong to first-execution startup, not an idle conversation.
  const isSerialAwaitingStart = !serialExecution && !state.paused && (
    state.phase === "awaiting_approval" ||
    (state.approved && state.phase === "running" && serialNodeState?.status === "waiting")
  );
  const isMainViewWorking = routeType === "serial" ? (isPlanning || isSerialAwaitingStart || isSerialWorking) : isPlanning;
  // Live SSE and the durable-JSONL poller can both observe the Planner's
  // compaction; either source is enough to relabel the working indicator.
  const isMainViewCompacting = isMainViewWorking &&
    ((showLivePlanner && !!plannerStream?.compacting) || plannerHistoryCompacting);
  const completed = Object.values(state.nodes).filter((n) => n.status === "completed").length;
  // A poll can return the old draft while the Planner is revising it. The
  // backend also exposes recoverable interruption state for Runs whose last
  // node failed due to interruption or has an explicitly updated model.
  const canContinue = !publishing && !publicationFailed &&
    (state.paused || state.canResume === true);
  const graphPhase = resolveGraphPhase({
    isPlanning,
    approved: state.approved,
    paused: state.paused,
    canResume: state.canResume,
    publishing,
    publicationFailed,
    phase: state.phase,
    active,
    nodes: state.nodes,
    executions: state.executions,
    mergers: state.mergers,
  });
  const activityStatus = activityStatusText(activity);
  // Publication has its own lifecycle label. Keep the node/merger panel from
  // reporting a generic Working while the terminal result is being written.
  const publicationWorkingLabel =
    graphPhase === "merging" || state.publication?.status === "merging" ? "Merging…"
      : graphPhase === "publishing" || state.publication?.status === "publishing" ? "Publishing…"
        : selectedMerger?.node === "merger" && selectedMerger.status === "running" ? "Publishing…"
          : undefined;
  const hasCompletedPublication = routeType === "graph" && (
    state.publication?.status === "completed" ||
    (state.phase === "completed" && state.publication?.status !== "failed" && state.publication?.status !== "publishing" && state.publication?.status !== "merging")
  );
  // Each conversation owns a fresh ReactFlow store and measured viewport.
  // Only an accepted graph mutation may open the pane: a failed or still-running
  // `node`/`edge` call leaves the draft graph unchanged, so it must not reveal an
  // empty topology on the right.
  const hasAcceptedGraphTool = (t: any) =>
    (t?.toolName === "node" || t?.toolName === "edge") && t.status === "success" && !t.isError;
  const hasGraphToolCalled =
    (plannerStream.items || []).some(hasAcceptedGraphTool) ||
    (plannerStream.tools || []).some(hasAcceptedGraphTool);
  const showGraphPane = routeType === "graph" && (state.graph.nodes.length > 0 || hasGraphToolCalled);

  const animatedNodes = useAnimatedNodes(nodes, state.runId);
  const { ready: isGraphReadyForRun, initialize: centerGraph, synchronize: synchronizeGraph } = useGraphViewport(
    currentRunKey, showGraphPane, nodes, edges, isPlanning, graphCanvasRef,
  );

  const prevMsgCountRef = useRef(effectiveMessages.length);
  useEffect(() => {
    if (effectiveMessages.length > prevMsgCountRef.current) {
      prevMsgCountRef.current = effectiveMessages.length;
      if (!latestScrollRef.current && shouldFollowOutput() && chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
    } else {
      prevMsgCountRef.current = effectiveMessages.length;
    }
  }, [effectiveMessages.length, shouldFollowOutput]);

  const syncViewScroll = useCallback((key: string) => {
    const el = chatScrollRef.current;
    if (!el) return;
    const resolved = resolveViewScroll(conversationScrollStateRef.current.get(key), el.scrollHeight);
    if (isUnrunNode) {
      el.scrollTop = 0;
    } else if (resolved.restoreSaved) {
      el.scrollTop = resolved.scrollTop;
    } else if (shouldFollowOutput()) {
      el.scrollTop = el.scrollHeight;
    }
    lastScrollTopRef.current = el.scrollTop;
    prevScrollHeightRef.current = el.scrollHeight;
  }, [isUnrunNode, shouldFollowOutput]);

  const revealConversation = useCallback(() => {
    const key = conversationViewKey;
    const generation = conversationGenerationRef.current;
    if (activeConversationViewRef.current !== key) return;
    syncViewScroll(key);
    if (revealChatFrameRef.current !== null) cancelAnimationFrame(revealChatFrameRef.current);
    // Let the transcript parse and measure its rows before the first visible frame.
    revealChatFrameRef.current = requestAnimationFrame(() => {
      if (activeConversationViewRef.current !== key || conversationGenerationRef.current !== generation) return;
      syncViewScroll(key);
      revealChatFrameRef.current = requestAnimationFrame(() => {
        revealChatFrameRef.current = null;
        if (activeConversationViewRef.current !== key || conversationGenerationRef.current !== generation) return;
        syncViewScroll(key);
        isPreparingConversationRef.current = false;
        if (chatScrollRef.current) delete chatScrollRef.current.dataset.transcriptPreparing;
        suppressAutoScrollRef.current = false;
        setScrollBottomVisible(false);
        setReadyConversationKey(key);
      });
    });
  }, [conversationViewKey, syncViewScroll, setScrollBottomVisible]);

  const visibleExecutionIds = useMemo(() => {
    if (selectedNode && routeType === "graph") {
      return nodeTurns.flatMap(turn => turn.executions).filter(exec => isAttemptExpanded(exec.id)).map(exec => exec.id);
    }
    return routeType === "serial" ? serialTurns.flatMap(turn => turn.executions).map(exec => exec.id) : [];
  }, [selectedNode, routeType, nodeTurns, serialTurns, isAttemptExpanded]);

  const handleExecutionOutputReady = useCallback((execId: string) => {
    readyExecutionIdsRef.current.add(execId);
    if (!isConversationReady && visibleExecutionIds.every(id => readyExecutionIdsRef.current.has(id))) {
      revealConversation();
    }
  }, [isConversationReady, visibleExecutionIds, revealConversation]);

  useLayoutEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;

    const isNewView = prevViewKeyRef.current !== conversationViewKey;
    prevViewKeyRef.current = conversationViewKey;

    if (isNewView) {
      stopLatestScroll();
      suppressAutoScrollRef.current = false;
      isPreparingConversationRef.current = true;
      isScrollingToBottomRef.current = false;

      const resolved = resolveViewScroll(conversationScrollStateRef.current.get(conversationViewKey), el.scrollHeight);
      setUserScrolledUp(resolved.isUserScrolledUp);
      el.scrollTop = isUnrunNode ? 0 : resolved.scrollTop;
      lastScrollTopRef.current = el.scrollTop;
      prevScrollHeightRef.current = el.scrollHeight;
      setScrollBottomVisible(false);

      if (resetChatScrollFrameRef.current !== null) {
        cancelAnimationFrame(resetChatScrollFrameRef.current);
      }
      resetChatScrollFrameRef.current = requestAnimationFrame(() => {
        resetChatScrollFrameRef.current = null;
        syncViewScroll(conversationViewKey);
      });
    }

    // Readiness includes the initial viewport fill, not just the newest turn's
    // first byte page. A timer must not reveal unfinished history on a slow read.
    // Readers also announce errors/empty logs so those remain visible and retryable.
    const needsPlanner = !selectedNode && routeType !== "serial" && savedPlannerIds.length > 0 && useSavedPlanner;
    const outputReady = visibleExecutionIds.every(id => readyExecutionIdsRef.current.has(id)) &&
      (!needsPlanner || readySavedPlannerKey === savedPlannerKey);
    if (readyConversationKey !== conversationViewKey && outputReady) revealConversation();
  }, [
    conversationViewKey,
    isUnrunNode,
    readyConversationKey,
    selectedNode,
    routeType,
    visibleExecutionIds,
    savedPlannerIds.length,
    savedPlannerKey,
    readySavedPlannerKey,
    useSavedPlanner,
    revealConversation,
    syncViewScroll,
    stopLatestScroll,
    setScrollBottomVisible,
    setUserScrolledUp,
  ]);

  const selectGraphNode = useStableCallback((id: string) => {
    if (!id) { setSelected(""); setSelectedMergerId(""); return; }
    if (id === publicationMergerCardId) {
      const publicationMergers = (state.mergers ?? []).filter(item => item.node === "merger");
      const runningMerger = publicationMergers.find(item => item.status === "running");
      const merger = runningMerger ?? publicationMergers.at(-1);
      setSelected(publicationMergerCardId);
      setSelectedMergerId(merger?.id ?? "");
      setAttemptId(merger?.id ?? "");
      return;
    }
    if (id.startsWith("merger:")) {
      const target = id.slice(7);
      const targetMergers = (state.mergers ?? []).filter(item => item.node === `merge:${target}`);
      const runningMerger = targetMergers.find(item => item.status === "running");
      const merger = runningMerger ?? targetMergers.at(-1);
      setSelected(id);
      setSelectedMergerId(merger?.id ?? "");
      setAttemptId(merger?.id ?? "");
    } else {
      setSelected(id);
      setSelectedMergerId("");
      setAttemptId("");
    }
  });

  const changesPanelId = React.useId();
  const [changesOpenForView, setChangesOpenForView] = useState<string | null>(null);
  const changesPanelOpen = changesOpenForView === conversationViewKey;
  useEffect(() => {
    setChangesOpenForView(null);
  }, [conversationViewKey]);

  const activeScopeExecutions = useMemo(() => (
    selectedNode && routeType === "graph"
      ? nodeTurns.flatMap((turn) => turn.executions)
      : []
  ), [selectedNode, routeType, nodeTurns]);

  const isCurrentViewWorking =
    selectedNode && routeType === "graph"
      ? isSelectedNodeWorking
      : isMainViewWorking ||
      graphPhase === "running" ||
      graphPhase === "publishing" ||
      graphPhase === "merging";

  const { summary: workspaceChangesSummary } = useWorkspaceChanges({
    state,
    // Node/Merger conversations show only their own executions; the main view
    // uses the run-level projection, which also covers Planner and publication.
    scopedExecutions:
      selectedNode && routeType === "graph" ? activeScopeExecutions : undefined,
    isWorking: isCurrentViewWorking,
  });

  const changesTrigger = <WorkspaceChangesTrigger
    summary={workspaceChangesSummary}
    panelId={changesPanelId}
    isOpen={changesPanelOpen}
    onToggle={() => setChangesOpenForView(changesPanelOpen ? null : conversationViewKey)}
  />;
  const changesPanel = <WorkspaceChangesPanel
    key={conversationViewKey}
    id={changesPanelId}
    summary={workspaceChangesSummary}
    open={changesPanelOpen}
    scrollContainerRef={chatScrollRef}
    onBeforeToggle={handleWorkspaceDetailsBeforeToggle}
    onAfterToggle={handleWorkspaceDetailsAfterToggle}
  />;

  const plannerResultCards = <>
    {routeType === "graph" && state.graph.nodes.length > 0 && (
      <motion.div
        className="plan-summary-card"
        initial={false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.38, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="plan-summary-header">
          <span>{t("执行拓扑概览")}</span>
          <span className={`phase-tag ${graphPhase}`}>{phaseText[graphPhase] ?? t("草稿")}</span>
        </div>

        <div className="plan-stats-row">
          <div className="plan-stat">
            <span className="stat-num">{state.graph.nodes.length}</span>
            <span className="stat-lbl">{t("规划节点")}</span>
          </div>
          <div className="plan-stat">
            <span className="stat-num">{state.plan?.executionBatches.length ?? 1}</span>
            <span className="stat-lbl">{t("执行批次")}</span>
          </div>
          <div className="plan-stat">
            <span className="stat-num">{state.graph.edges.length}</span>
            <span className="stat-lbl">{t("拓扑边")}</span>
          </div>
          <div className="plan-stat">
            <span className="stat-num">
              {`${completed}/${state.graph.nodes.length}`}
            </span>
            <span className="stat-lbl">{t("已完成")}</span>
          </div>
        </div>

        <div className="plan-nodes-list">
          <span className="nodes-list-title">
            {t("节点列表（点击聚焦查看详细日志与独立沙箱）：")}
          </span>
          <div className="nodes-chips">
            {summaryNodes.map((node) => {
              const nState = state.nodes[node.name];
              return (
                <button
                  type="button"
                  key={node.name}
                  className="node-chip"
                  onClick={() => { setSelected(node.name); setSelectedMergerId(""); }}
                >
                  <span className={`chip-dot ${nState?.status ?? "waiting"}`} />
                  <span className="chip-name">{node.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      </motion.div>
    )}

    {/* 此次执行已完成，已完成写入源文件工作区卡片 */}
    {hasCompletedPublication && (
      <PublicationCompletedCard
        state={state}
        routeType={routeType}
        repository={config?.repository || repoInfo?.path}
        animateAppear={false}
      />
    )}
  </>;

  return (
    <section
      // Keep exit animations and split-width transitions within one Conversation.
      key={currentRunKey}
      className={`workbench ${isResizing ? "resizing" : ""} ${showGraphPane ? "graph-mode" : "dialogue-only-mode"} ${isPlanning ? "planning-active" : "historical-settled"}`}
      ref={workbenchRef}
      style={{
        "--workbench-split-ratio": splitRatio,
        "--workbench-left-width": `${splitRatio * 100}%`,
      } as React.CSSProperties}
    >
      {/* 左侧/居中对话与日志面板 */}
      <motion.div
        className={`conversation-pane ${showGraphPane ? "split" : "full-width"}`}
        style={showGraphPane ? undefined : { width: "100%", maxWidth: "100%" }}
      >
        {selectedNode && routeType === "graph" ? (
          <div className="initial-query-view">
            <div className="conversation-heading">
              <div className="heading-title-col">
                <h2>{selectedNodeLabel}</h2>
              </div>
              {routeType === "graph" && (
                <button
                  type="button"
                  className="back-to-query-btn"
                  onClick={() => { setSelected(""); setSelectedMergerId(""); }}
                >
                  <ArrowLeft size={16} />
                </button>
              )}
            </div>

            <div
              className={`initial-query-scroll ${isConversationReady ? "conversation-ready" : "conversation-preparing"}`}
              data-transcript-preparing={!isConversationReady && !isUserScrolledUpRef.current ? "true" : undefined}
              ref={chatScrollRef}
              onScroll={handleChatScroll}
              style={conversationRevealStyle}
            >
              <div
                className="chat-messages-stream"
                style={{ opacity: isConversationReady ? 1 : 0 }}
              >
                <NodeTaskCard
                  nodeName={selectedNode.name}
                  taskText={nodeTaskText}
                  badgeText={isNodeMergerSelected || publicationMergerSelected ? t("Merger 系统提示词") : undefined}
                  versions={initialTaskVersions}
                  currentVersionIndex={initialTaskVersions ? (initialTaskEdit?.selected_version ?? initialTaskVersions.length - 1) : undefined}
                  onSwitchVersion={(index) => {
                    const version = initialTaskVersions?.[index];
                    const first = attempts[0];
                    if (version && first && onEditMessageSubmit) {
                      void onEditMessageSubmit({
                        id: `task-${selectedNode.name}`,
                        role: "user",
                        text: version.text,
                        node: selectedNode.name,
                        executionId: version.executionId ?? first.id,
                        runId: state.runId,
                      }, version.text, index);
                    }
                  }}
                  editing={editingTaskNode === selectedNode.name}
                  draft={taskDraft}
                  onDraftChange={setTaskDraft}
                  onEdit={!isNodeMergerSelected && selected !== publicationMergerCardId ? () => {
                    onCancelEditMessage?.();
                    setEditingTaskNode(selectedNode.name);
                    setTaskDraft(selectedNode.task);
                  } : undefined}
                  onCancel={() => setEditingTaskNode("")}
                  disabled={locked}
                  onSave={(value) => {
                    const saveTask = () => {
                      onSave({
                        ...state.graph,
                        nodes: state.graph.nodes.map((node) =>
                          node.name === selectedNode.name ? { ...node, task: value } : node
                        ),
                      });
                      setEditingTaskNode("");
                    };
                    if (state.approved) {
                      const first = attempts[0];
                      if (first && onEditMessageSubmit) {
                        const submitEdit = () => {
                          void Promise.resolve(onEditMessageSubmit({
                            id: `task-${selectedNode.name}`,
                            role: "user",
                            text: selectedNode.task,
                            node: selectedNode.name,
                            executionId: first.id,
                            runId: state.runId,
                          }, value)).then((accepted) => {
                            if (accepted !== false) setEditingTaskNode("");
                          });
                        };
                        if (selectedState?.status === "running") {
                          onRequestConfirmation({
                            title: t("节点正在执行"),
                            message: t("保存会停止该节点正在执行的进程，并从会话开头以新的任务目标重新运行。"),
                            confirmText: t("停止并修改"),
                            danger: true,
                            onConfirm: submitEdit,
                          });
                          return;
                        }
                        submitEdit();
                        return;
                      } else {
                        onRequestConfirmation({
                          title: t("修改未执行的 Task？"),
                          message: t("此节点尚无 Pi 对话可分支，将创建新的待审批运行。"),
                          confirmText: t("确认修改"),
                          danger: true,
                          onConfirm: saveTask,
                        });
                      }
                      return;
                    }
                    saveTask();
                  }}
                />

                {nodeTurns.map((turn, index) => {
                  const isWaitingExecution = waitingForNodeExecution && index === nodeTurns.length - 1;

                  return (
                    <React.Fragment key={turn.id}>
                      {turn.userMessage && (
                        <div className={`chat-message-row user${turn.isInitial ? "" : " planner-follow-up"}`}>
                          <EditableUserBubble
                            text={turn.userMessage.text.replace(/^\[@[^\]]+\]\s*/, "").trim()}
                            images={turn.userMessage.images}
                            files={turn.userMessage.files}
                            editing={editingMessage?.id === turn.userMessage.id}
                            draft={editPrefillText ?? ""}
                            onDraftChange={onEditPrefillTextChange ?? (() => { })}
                            onEdit={onEditMessage && (selectedMerger || turn.userMessage.delivery !== "node_messaged")
                              ? () => { setEditingTaskNode(""); onEditMessage(turn.userMessage!) }
                              : undefined}
                            onCancel={() => onCancelEditMessage?.()}
                            onSend={(value) => onEditMessageSubmit ? onEditMessageSubmit(turn.userMessage!, value) : onSendMessage(value)}
                            disabled={locked}
                            versions={turn.userMessage.versions}
                            currentVersionIndex={turn.userMessage.currentVersionIndex}
                            onSwitchVersion={(idx) => onSwitchMessageVersion?.(turn.userMessage!, idx)}
                          />
                        </div>
                      )}
                      {turn.executions.map((exec) => {
                        const isExpanded = isAttemptExpanded(exec.id);
                        const ownedSteers = (turn.steerMessages ?? []).filter(steer => steer.executionId === exec.id);
                        const inlineSteerTexts = ownedSteers
                          .filter(canInlineSteerMessage)
                          .map(steer => nodeInstructionText(steer.text))
                          .filter(Boolean);
                        const renderedInline = new Set(inlineUserTurns[exec.id] ?? []);
                        const pendingSteers = ownedSteers.filter(steer =>
                          !canInlineSteerMessage(steer) || !isExpanded || !renderedInline.has(nodeInstructionText(steer.text)));
                        return (
                          <motion.div
                            key={exec.id}
                            className="serial-execution-panel"
                            initial={false}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.3 }}
                          >
                            {showExecutionRecords && (
                              <ExecutionRecordHeader execution={exec} expanded={isExpanded} onToggle={(e) => {
                                const panel = e.currentTarget.closest<HTMLElement>(".serial-execution-panel");
                                handleToggleAttempt(exec.id, panel);
                              }} />
                            )}
                            {isExpanded && (
                              <div style={{ display: "flex", flexDirection: "column", marginTop: showExecutionRecords ? 4 : 0 }}>
                                <ExecutionTranscript
                                  runId={state.runId}
                                  execution={exec}
                                  onUserResize={handleExpandableContentChange}
                                  onInitialOutputReady={handleExecutionOutputReady}
                                  onCompactingChange={(compacting) => handleAttemptCompacting(exec.id, compacting)}
                                  inlineUserTurnTexts={inlineSteerTexts}
                                  onInlineUserTurnsChange={(texts) => handleInlineUserTurns(exec.id, texts)}
                                />
                              </div>
                            )}
                            {pendingSteers.map(renderSteerBubble)}
                          </motion.div>
                        );
                      })}
                      {turn.steerMessages
                        ?.filter(steer => !turn.executions.some(exec => exec.id === steer.executionId))
                        .map(renderSteerBubble)}
                      {isWaitingExecution && (
                        <div className="serial-execution-panel" aria-hidden="true">
                          {showExecutionRecords && attempts.at(-1) && (
                            <ExecutionRecordHeader execution={attempts.at(-1)!} expanded placeholder />
                          )}
                          <div style={{ display: "flex", flexDirection: "column", marginTop: showExecutionRecords ? 4 : 0 }}>
                            <ExecutionTranscriptPlaceholder />
                          </div>
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}

                <WorkspaceDetailsPanel
                  key={`${state.runId}:${selectedNode.name}`}
                  showWorking={isSelectedNodeWorking}
                  compacting={isSelectedNodeCompacting}
                  workingLabel={publicationWorkingLabel}
                  summaryAction={changesTrigger}
                  additionalDetails={changesPanel}
                  scrollContainerRef={chatScrollRef}
                  onBeforeToggle={handleWorkspaceDetailsBeforeToggle}
                  onAfterToggle={handleWorkspaceDetailsAfterToggle}
                >
                  <p>workspace: {execution?.worktree || config.repository || "preparing workspace…"}</p>
                  <p>session id: {execution?.sessionId || "waiting for initialization…"}</p>
                  <p>commit before: {execution?.before || "not snapshotted"}</p>
                  <p>commit after: {execution ? (execution.after === "" ? "direct modification (no snapshot)" : execution.after ?? "pending") : "pending"}</p>
                  {snapshotModelInfo && (
                    <div className="session-details-row">
                      <p>model: {snapshotModelInfo.model}</p>
                      <p>thinking level: {snapshotModelInfo.thinkingLevel}</p>
                    </div>
                  )}
                  <div className="session-details-row">
                    <p>start time: {formatSessionStartTime(executionSession.startedAt ?? execution?.startedAt)}</p>
                    <p>time took: <ExecutionTimeTookText execution={execution} priorDurationSeconds={executionSession.priorDurationSeconds} /></p>
                  </div>
                  {(showExecutionTokenUsage || executionContext) && (
                    <SessionTokenUsage usage={executionUsage} context={executionContext}
                      showTokens={showExecutionTokenUsage} />
                  )}
                </WorkspaceDetailsPanel>

                {selectedState?.error && (
                  <NodeErrorPanel error={selectedState.error} paused={selectedState.status === "paused"} />
                )}
              </div>
            </div>
            <button
              ref={scrollBottomBtnRef}
              type="button"
              className="scroll-to-bottom-btn"
              onClick={scrollToBottom}
            >
              <ArrowDown size={14} />
              <span>{t("最新")}</span>
            </button>
            <motion.div
              className="pane-bottom-chat"
              initial={false}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
            >
              {followUpQueue && followUpQueue.length > 0 && (
                <div className="followup-queue-banner">
                  <div className="queue-info">
                    <Clock size={12} />
                    <span>{t("排队中 (")}{followUpQueue.length}): {followUpQueue[0].text.slice(0, 30)}...</span>
                  </div>
                  {onCancelFollowUp && (
                    <button
                      type="button"
                      className="queue-cancel-btn"
                      onClick={() => onCancelFollowUp(followUpQueue[0].id)}
                    >
                      {t("取消")}</button>
                  )}
                </div>
              )}
              <PromptBox
                key={composerDraftKey}
                defaultValue={composerDrafts?.get(composerDraftKey) ?? ""}
                onChange={handleComposerChange}
                layoutId="conversation-composer"
                repository={config?.repository}
                runId={state.runId}
                node={conversationNode}
                onSubmit={handleSendMessageWithScroll}
                placeholder={
                  !state.approved
                    ? t("图规划审批启动后，可在此向选定节点发送介入指令…")
                    : selectedMerger
                      ? (selectedMergerRunning
                        ? t("向 merger 实时发送 Steer（当前工具调用后生效）…")
                        : selectedMergerContinuable
                          ? (selectedMerger.status === "failed"
                            ? t("向 merger 发送消息并重跑…")
                            : t("向 publication merger 追加消息…"))
                          : t("merger 已结束，只能查看执行记录"))
                      : isSelectedNodeWorking
                        ? t("向 @{0} 实时发送 Steer（当前工具调用后生效）…", placeholderNodeName)
                        : selectedState?.status === "completed"
                          ? t("向 @{0} 发送消息并继续执行…", placeholderNodeName)
                          : t("向 @{0} 发送介入指令…", placeholderNodeName)
                }
                isExecuting={isSelectedNodeWorking}
                isWorking={isSelectedNodeWorking}
                onInterrupt={onInterrupt ? () => onInterrupt(selectedNode?.name) : undefined}
                disabled={
                  locked ||
                  !!editingMessage ||
                  !state.approved ||
                  (!!selectedMerger && !selectedMergerRunning && !selectedMergerContinuable)
                }
              />
            </motion.div>
          </div>
        ) : (
          <div className="initial-query-view">
            <div
              className={`initial-query-scroll ${isConversationReady ? "conversation-ready" : "conversation-preparing"}`}
              data-transcript-preparing={!isConversationReady && !isUserScrolledUpRef.current ? "true" : undefined}
              ref={chatScrollRef}
              onScroll={handleChatScroll}
              style={conversationRevealStyle}
            >
              <div
                className="chat-messages-stream"
                style={{ opacity: isConversationReady ? 1 : 0 }}
              >
                {routeType === "serial" ? (
                  <div className="serial-turns-container" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {serialTurns.map((turn, index) => {
                      const isWaitingExecution =
                        turn.executions.length === 0 && !turn.userMessage.executionId && !turn.userMessage.delivery &&
                        index === serialTurns.length - 1 &&
                        (isSerialWorking || isMainViewWorking || pendingRequest);

                      return (
                        <React.Fragment key={turn.id}>
                          {turn.userMessage && (
                            <motion.div
                              className={`chat-message-row user${turn.isInitial ? "" : " planner-follow-up"}`}
                              initial={isPlanning && turn.isInitial ? { opacity: 0 } : false}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                            >
                              <EditableUserBubble
                                text={turn.userMessage.text.trim()}
                                images={turn.userMessage.images}
                                files={turn.userMessage.files}
                                editing={editingMessage?.id === turn.userMessage.id}
                                draft={editPrefillText ?? ""}
                                onDraftChange={onEditPrefillTextChange ?? (() => { })}
                                onEdit={onEditMessage && turn.userMessage.delivery !== "node_messaged" ? () => onEditMessage(turn.userMessage!) : undefined}
                                onCancel={() => onCancelEditMessage?.()}
                                onSend={(value) => onEditMessageSubmit ? onEditMessageSubmit(turn.userMessage!, value) : onSendMessage(value)}
                                disabled={locked && !isPlanning}
                                versions={turn.userMessage.versions}
                                currentVersionIndex={turn.userMessage.currentVersionIndex}
                                onSwitchVersion={(idx) => onSwitchMessageVersion?.(turn.userMessage!, idx)}
                              />
                            </motion.div>
                          )}
                          {turn.steerMessages
                            ?.filter(steer => !turn.executions.some(exec => exec.id === steer.executionId))
                            .map(renderSteerBubble)}

                          {turn.isInitial && showRouteBadge && (
                            <motion.div
                              className="route-decision-pill serial"
                              initial={isPlanning ? { opacity: 0, scale: 0.96 } : false}
                              animate={{ opacity: 1, scale: 1 }}
                              transition={{ duration: isPlanning ? 0.25 : 0, ease: "easeOut" }}
                            >
                              <Compass size={13} />
                              <span>{t("任务路线决策：单节点执行")}</span>
                            </motion.div>
                          )}

                          {turn.executions.map((exec) => {
                            const ownedSteers = (turn.steerMessages ?? []).filter(steer => steer.executionId === exec.id);
                            const inlineSteerTexts = ownedSteers
                              .filter(canInlineSteerMessage)
                              .map(steer => nodeInstructionText(steer.text))
                              .filter(Boolean);
                            const renderedInline = new Set(inlineUserTurns[exec.id] ?? []);
                            const pendingSteers = ownedSteers.filter(steer =>
                              !canInlineSteerMessage(steer) || !renderedInline.has(nodeInstructionText(steer.text)));
                            return (
                              <motion.div
                                key={exec.id}
                                className="serial-execution-panel"
                                initial={false}
                                animate={{ opacity: 1 }}
                                transition={{ duration: 0.15 }}
                              >
                                <div style={{ display: "flex", flexDirection: "column", marginTop: 4 }}>
                                  <ExecutionTranscript
                                    key={exec.id}
                                    runId={state.runId}
                                    execution={exec}
                                    onUserResize={handleExpandableContentChange}
                                    onInitialOutputReady={handleExecutionOutputReady}
                                    onCompactingChange={(compacting) => handleAttemptCompacting(exec.id, compacting)}
                                    inlineUserTurnTexts={inlineSteerTexts}
                                    onInlineUserTurnsChange={(texts) => handleInlineUserTurns(exec.id, texts)}
                                  />
                                </div>
                                {pendingSteers.map(renderSteerBubble)}
                              </motion.div>
                            );
                          })}
                          {isWaitingExecution && (
                            <div className="serial-execution-panel" aria-hidden="true">
                              <div style={{ display: "flex", flexDirection: "column", marginTop: 4 }}>
                                <ExecutionTranscriptPlaceholder />
                              </div>
                            </div>
                          )}
                        </React.Fragment>
                      );
                    })}

                    <WorkspaceDetailsPanel
                      key={`${state.runId}:serial`}
                      showWorking={isMainViewWorking}
                      compacting={isMainViewWorking && !!serialExecution?.id && !!compactingAttempts[serialExecution.id]}
                      workingLabel={publicationWorkingLabel}
                      summaryAction={changesTrigger}
                      additionalDetails={changesPanel}
                      scrollContainerRef={chatScrollRef}
                      onBeforeToggle={handleWorkspaceDetailsBeforeToggle}
                      onAfterToggle={handleWorkspaceDetailsAfterToggle}
                    >
                      <p>workspace: {serialExecution?.worktree || config.repository || repoInfo?.name || "preparing workspace…"}</p>
                      <p>session id: {serialExecution?.sessionId || "waiting for initialization…"}</p>
                      {serialModelInfo && (
                        <div className="session-details-row">
                          <p>model: {serialModelInfo.model}</p>
                          <p>thinking level: {serialModelInfo.thinkingLevel}</p>
                        </div>
                      )}
                      <div className="session-details-row">
                        <p>start time: {formatSessionStartTime(serialSession.startedAt ?? serialExecution?.startedAt)}</p>
                        <p>time took: <ExecutionTimeTookText execution={serialExecution} priorDurationSeconds={serialSession.priorDurationSeconds} /></p>
                      </div>
                      {(showSerialTokenUsage || serialContext) && (
                        <SessionTokenUsage usage={serialUsage} context={serialContext}
                          showTokens={showSerialTokenUsage} />
                      )}
                    </WorkspaceDetailsPanel>
                  </div>
                ) : (
                  <>
                    {plannerMessages.length > 0 && (
                      <motion.div
                        key={plannerMessages[0].id}
                        className={`chat-message-row ${plannerMessages[0].role}`}
                        initial={false}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                      >
                        {plannerMessages[0].role === "user" ? (
                          <EditableUserBubble
                            text={plannerMessages[0].text.trim()}
                            images={plannerMessages[0].images}
                            files={plannerMessages[0].files}
                            editing={editingMessage?.id === plannerMessages[0].id}
                            draft={editPrefillText ?? ""}
                            onDraftChange={onEditPrefillTextChange ?? (() => { })}
                            onEdit={onEditMessage ? () => onEditMessage(plannerMessages[0]) : undefined}
                            onCancel={() => onCancelEditMessage?.()}
                            onSend={(value) => onEditMessageSubmit ? onEditMessageSubmit(plannerMessages[0], value) : onSendMessage(value)}
                            disabled={locked && !isPlanning}
                            versions={plannerMessages[0].versions}
                            currentVersionIndex={plannerMessages[0].currentVersionIndex}
                            onSwitchVersion={(idx) => onSwitchMessageVersion?.(plannerMessages[0], idx)}
                          />
                        ) : (
                          <div className={`chat-bubble-${plannerMessages[0].role} chat-message-${plannerMessages[0].role}`}>
                            <MarkdownRenderer content={plannerMessages[0].text} />
                          </div>
                        )}
                      </motion.div>
                    )}

                    {/* 任务路线决策结果或评估中加载状态 */}
                    {((isPlanning && effectiveRouteType === "undecided") || (showRouteBadge && effectiveRouteType !== "undecided")) && (
                      <motion.div
                        className={`route-decision-pill ${effectiveRouteType}`}
                        initial={isPlanning ? { opacity: 0, scale: 0.96, y: 10 } : false}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        transition={{ duration: isPlanning ? 0.42 : 0, ease: [0.16, 1, 0.3, 1] }}
                      >
                        {effectiveRouteType === "undecided" ? (
                          <>
                            <Loader2 size={13} className="spin" />
                            <span>{t("正在评估任务路线决策...")}</span>
                          </>
                        ) : (
                          <>
                            <Compass size={13} />
                            <span>{t("任务路线决策：多节点依赖拓扑图架构")}</span>
                          </>
                        )}
                      </motion.div>
                    )}

                    {/* 历史保存的规划活动记录（如重新加载或未被活动流完全覆盖时） */}
                    {savedPlannerIds.length > 0 && (
                      <div style={!useSavedPlanner ? { display: "none" } : undefined}>
                        <PlanningActivity
                          key={savedPlannerKey}
                          runId={transcriptRunId}
                          planningIds={savedPlannerIds}
                          showUserTurns={savedPlannerShowsUserTurns}
                          skipFirstUser={plannerMessages.length > 0 && skipFirstPersistedTurn}
                          running={isPlanning || !!recoveredPlanningId}
                          onCompactingChange={setPlannerHistoryCompacting}
                          onReady={() => {
                            setReadySavedPlannerKey(savedPlannerKey);
                            if (!isConversationReady) revealConversation();
                          }}
                          onOutputChange={(text) => setSavedPlannerRecord(previous =>
                            previous.key === savedPlannerKey && previous.text === text ? previous : { key: savedPlannerKey, text })}
                          onUserResize={handleExpandableContentChange}
                          edits={plannerEdits}
                          onEditUser={onEditMessageSubmit ? (text, replacement) =>
                            onEditMessageSubmit({
                              id: `planner-history-${text}`, role: "user", parentId: null,
                              text, runId: state.runId
                            }, replacement) : undefined}
                        />
                      </div>
                    )}

                    {/* 保留当前对话中的跟进消息；实时流已有同一消息时不重复渲染。 */}
                    {plannerMessages.slice(1).filter((msg) => {
                      if (msg.node && msg.node !== "planner") return false;
                      if (renderLivePlanner && plannerStream.items?.some((item: TranscriptItem) =>
                        item.role === "user" && item.id === msg.id)) return false;
                      // Keep an acknowledged steer visible across navigation
                      // until its turn actually appears in JSONL (start or end).
                      if (useSavedPlanner && savedPlannerShowsUserTurns) {
                        const text = msg.text.trim();
                        const count = remainingPersistedTurns.get(text) ?? 0;
                        if (count > 0) {
                          remainingPersistedTurns.set(text, count - 1);
                          return false;
                        }
                      }
                      return true;
                    }).map((msg) => (
                      <AnimatedUserTurn id={msg.id} animateAppear={msg.animateAppear}
                        className="chat-message-row user planner-follow-up" key={msg.id}>
                        <EditableUserBubble
                          text={msg.text.trim()}
                          images={msg.images}
                          files={msg.files}
                          editing={editingMessage?.id === msg.id}
                          draft={editPrefillText ?? ""}
                          onDraftChange={onEditPrefillTextChange ?? (() => { })}
                          onEdit={onEditMessage ? () => onEditMessage(msg) : undefined}
                          onCancel={() => onCancelEditMessage?.()}
                          onSend={(value) => onEditMessageSubmit ? onEditMessageSubmit(msg, value) : onSendMessage(value)}
                          disabled={locked && !isPlanning}
                          versions={msg.versions}
                          currentVersionIndex={msg.currentVersionIndex}
                          onSwitchVersion={(idx) => onSwitchMessageVersion?.(msg, idx)}
                        />
                      </AnimatedUserTurn>
                    ))}

                    {/* Planner 顺序流式记录：严格按实际发生时序呈现用户追加消息、工具调用、思维链与输出文字 */}
                    {renderLivePlanner && livePlannerItems.length > 0 ? (
                      <PlannerTranscript items={livePlannerItems} isPlanning={isPlanning} locked={locked}
                        editingMessage={editingMessage} draft={editPrefillText ?? ""}
                        onDraftChange={onEditPrefillTextChange ?? (() => { })} onEditMessage={onEditMessage}
                        onCancelEdit={onCancelEditMessage} onEditSubmit={onEditMessageSubmit}
                        onSendMessage={onSendMessage} onUserResize={handleExpandableContentChange} />
                    ) : (
                      renderLivePlanner && (plannerStream.plannerThinking || smoothPlannerText) && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {plannerStream.plannerThinking && (
                            <ThinkingCard
                              content={plannerStream.plannerThinking}
                              isStreaming={isPlanning && plannerStream.plannerThinkingActive}
                              title="Chain of Thought"
                              defaultExpanded={true}
                              autoExpandWhileStreaming={true}
                              animateAppear={false}
                              onExpandedChange={handleExpandableContentChange}
                            />
                          )}
                          {smoothPlannerText && (
                            <motion.div
                              className="chat-message-row assistant"
                              initial={false}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                            >
                              <div className="chat-bubble-assistant chat-message-assistant">
                                <MarkdownRenderer content={smoothPlannerText} isStreaming={isPlanning} />
                              </div>
                            </motion.div>
                          )}
                        </div>
                      )
                    )}
                  </>
                )}
                {showPlannerDetails && (
                  <WorkspaceDetailsPanel
                    key={`${state.runId}:planner`}
                    label={t("规划会话信息")}
                    showWorking={isMainViewWorking}
                    compacting={isMainViewCompacting}
                    workingLabel={publicationWorkingLabel}
                    summaryAction={changesTrigger}
                    additionalDetails={changesPanel}
                    scrollContainerRef={chatScrollRef}
                    onBeforeToggle={handleWorkspaceDetailsBeforeToggle}
                    onAfterToggle={handleWorkspaceDetailsAfterToggle}
                  >
                    <p>workspace: {plannerWorkspace || config.repository || "preparing workspace…"}</p>
                    <div className="session-details-row">
                      <p>model: {plannerModelInfo.model}</p>
                      <p>thinking level: {plannerModelInfo.thinkingLevel}</p>
                    </div>
                    <div className="session-details-row">
                      <p>start time: {formatSessionStartTime(plannerStartTime)}</p>
                      <p>time took: <PlannerTimeTookText isPlanning={isPlanning} startedAt={plannerLiveTurnStart} durationSeconds={plannerRole?.durationSeconds} priorDurationSeconds={plannerSession.priorDurationSeconds} /></p>
                    </div>
                    {(showPlannerTokenUsage || displayedPlannerContext) && (
                      <SessionTokenUsage usage={plannerUsage} context={displayedPlannerContext}
                        showTokens={showPlannerTokenUsage} />
                    )}
                  </WorkspaceDetailsPanel>
                )}
              </div>

              {/* 规划失败提示 */}
              {failedPlanning && !isPlanning && (failedPlanning.error || failedPlanning.status === "failed") && (
                <div
                  className="planning-error-notice"
                  style={{
                    margin: "10px auto",
                    maxWidth: 860,
                    width: "calc(100% - 36px)",
                    boxSizing: "border-box",
                    padding: "8px 12px",
                    background: "#ffffff",
                    borderRadius: 6,
                    color: "#b91c1c",
                    fontSize: 12,
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 6,
                    border: "1px solid #fca5a5",
                    boxShadow: "0 1px 4px rgba(239, 68, 68, 0.08)",
                  }}
                >
                  <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1, color: "#ef4444" }} />
                  <span>{t("规划未通过：")}{localizeError(failedPlanning.error || t("规划阶段异常中断"))}</span>
                </div>
              )}

              {routeType === "graph" && (state.graph.nodes.length > 0 || hasCompletedPublication) && (
                <div className={`planner-result-cards${hidePlannerResultCards ? " is-hidden" : ""}`}
                  aria-hidden={hidePlannerResultCards || undefined}
                  inert={hidePlannerResultCards ? true : undefined}>
                  <div className="planner-result-cards-inner">{plannerResultCards}</div>
                </div>
              )}
            </div>
            <button
              ref={scrollBottomBtnRef}
              type="button"
              className="scroll-to-bottom-btn"
              onClick={scrollToBottom}
            >
              <ArrowDown size={14} />
              <span>{t("最新")}</span>
            </button>
            <motion.div
              className="pane-bottom-chat"
              initial={false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.48, ease: [0.16, 1, 0.3, 1] }}
            >
              {followUpQueue && followUpQueue.length > 0 && (
                <div className="followup-queue-banner">
                  <div className="queue-info">
                    <Clock size={12} />
                    <span>{t("排队中 (")}{followUpQueue.length}): {followUpQueue[0].text.slice(0, 30)}...</span>
                  </div>
                  {onCancelFollowUp && (
                    <button
                      type="button"
                      className="queue-cancel-btn"
                      onClick={() => onCancelFollowUp(followUpQueue[0].id)}
                    >
                      {t("取消")}</button>
                  )}
                </div>
              )}
              <PromptBox
                key={composerDraftKey}
                defaultValue={composerDrafts?.get(composerDraftKey) ?? ""}
                onChange={handleComposerChange}
                layoutId="conversation-composer"
                repository={config?.repository}
                runId={state.runId}
                node={isSerialExecution ? state.graph.nodes[0]?.name : undefined}
                onSubmit={handleSendMessageWithScroll}
                placeholder={
                  isPlanning
                    ? t("输入补充规划或纠偏要求，发送将实时转向 (Steer)…")
                    : isSerialExecution
                      ? t("向当前任务发送介入指令，直接在对话框中继续对话…")
                      : state.approved
                        ? t("向规划器修改当前图，保留未受影响的节点结果…")
                        : t("向规划器追加指令，直接在对话框中继续对话并调整图规划…")
                }
                isExecuting={isMainViewWorking}
                isWorking={isMainViewWorking}
                onInterrupt={onInterrupt ? () => onInterrupt() : undefined}
                disabled={
                  !!editingMessage ||
                  (locked && !isPlanning)
                }
              />
            </motion.div>
          </div>
        )}
      </motion.div>

      {/* 左右可调节分割器 与 右侧执行拓扑图面板 */}
      <AnimatePresence>
        {showGraphPane && (
          <>
            <motion.div
              key="workbench-resizer"
              className={`workbench-resizer ${isResizing ? "active" : ""}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.16 } }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              onMouseDown={handleStartResize}
              onDoubleClick={handleResetResizer}
              title={t("按住左右拖动调节宽度，双击恢复默认")}
            >
              <div className="resizer-handle" />
            </motion.div>

            <motion.div
              key={`graph-pane:${currentRunKey}`}
              className="graph-pane"
              initial={{ opacity: 0, x: 28 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 28, transition: { duration: 0.16, ease: [0.3, 0, 0.8, 0.15] } }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="graph-toolbar">
                <div className="toolbar-left">
                  <Workflow size={15} />
                  <strong>{t("执行拓扑图")}</strong>
                </div>
                <div className="toolbar-right">
                  <button
                    type="button"
                    className="icon-button"
                    title={t("编辑 Graph IR")}
                    onClick={onOpenEditor}
                  >
                    <Code2 size={16} />
                  </button>
                </div>
              </div>

              <div className="graph-canvas" ref={graphCanvasRef}>
                <GraphCanvas runKey={currentRunKey} ready={isGraphReadyForRun}
                  nodes={animatedNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} tokens={tokens}
                  onInit={centerGraph} onSelect={selectGraphNode} onLayout={synchronizeGraph} />

                {state.graph.nodes.length > 0 && (
                  <div className="graph-note">
                    <span className="note-line" />{t("依赖前进")}<span className="note-line feedback" />{t("执行反馈")}</div>
                )}
              </div>

              {state.graph.nodes.length > 0 && (
                <div className="graph-bottom">
                  <div className="progress-label">
                    <span>
                      <span className="progress-dot" />
                      {completed} / {state.graph.nodes.length}{t(" 节点完成")}</span>
                    <span>{phaseText[graphPhase] ?? graphPhase}</span>
                  </div>
                  <div className="progress-track">
                    <div style={{ width: `${(completed / Math.max(1, state.graph.nodes.length)) * 100}%` }} />
                  </div>

                  <div className="approval-row">
                    <span>
                      {activityStatus ? (
                        <><span className="progress-dot" />{activityStatus}</>
                      ) : graphPhase === "planning" ? t("规划中")
                        : graphPhase === "running" ? t("确定性运行时正在推进")
                          : graphPhase === "followup" ? t("源目录直改中（无快照）")
                            : graphPhase === "needs_attention" ? t("执行已停止，请检查失败或阻塞节点")
                              : graphPhase === "pausing" ? t("正在停止运行中的节点…")
                                : graphPhase === "paused" ? (state.paused
                                  ? t("执行已暂停，点击继续可恢复")
                                  : t("执行已停止，点击继续恢复失败节点（不会追加消息）"))
                                  : graphPhase === "completed" ? t("运行已完成 - 本次消耗 Token:{0} Cached:{1}",
                                    // Task tokens exclude cache reads but include
                                    // one-time cache writes; reasoning is inside
                                    // output. The percentage is the prompt cache-hit rate.
                                    formatTokenCount(consumedTokenCount(state.runMetrics?.totalUsage)),
                                    formatCacheHitRate(state.runMetrics?.totalUsage))
                                    : state.approved ? phaseText[graphPhase] ?? graphPhase : ""}
                    </span>
                    <div>
                      {graphPhase === "awaiting_approval" ? (
                        <>
                          <button key="reject-btn" type="button" className="text-button" disabled={locked} onClick={() => onControl("reject")}>
                            Reject
                          </button>
                          <button key="approve-btn" type="button" className="primary" disabled={locked} onClick={onOpenApproval}>
                            <Play size={13} fill="currentColor" />Approve
                          </button>
                        </>
                      ) : state.approved ? (
                        <button
                          key="execution-control-btn"
                          type="button"
                          className="primary"
                          // A settled run with nothing running or paused has no
                          // pause/resume semantics: pausing is a no-op and the
                          // following 继续 would just un-pause it without
                          // continuing any node. Failed nodes are continued
                          // from their conversation (介入指令), not here.
                          disabled={locked || publishing || publicationFailed || state.phase === "completed" || graphPhase === "pausing"
                            || (graphPhase === "needs_attention" && !canContinue)}
                          title={graphPhase === "needs_attention" && !canContinue ? t("执行已停止；请在失败节点的对话中发送介入指令以继续") : undefined}
                          onClick={() => onControl(canContinue ? "resume" : "pause")}
                        >
                          {canContinue ? <Play size={13} /> : <Pause size={13} />}
                          {graphPhase === "pausing" ? t("正在暂停") : canContinue ? t("继续") : t("暂停")}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </section>
  );
});

GraphWorkbench.displayName = "GraphWorkbench";
