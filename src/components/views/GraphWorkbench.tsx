import { t, localizeError } from "../../i18n";
import React, { useRef, useState, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import type { ReactFlowInstance } from "@xyflow/react";
import { GraphCanvas } from "../graph/GraphCanvas";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  Code2, ArrowLeft,
  Workflow, Play, Pause, Compass, ArrowDown, Clock, Loader2, ChevronRight,
  AlertCircle
} from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import {
  Snapshot, PlanRouteType, PlanMode, RepositoryInfo, Config,
  Graph, Execution, Status, PlanningSummary, TranscriptItem,
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
import { isNodeWorking } from "../../lib/nodeWorking";
import { resolveGraphPhase } from "../../lib/graphPhase";
import { ThinkingCard } from "../ThinkingCard";
import { ExecutionTiming } from "../ExecutionTiming";
import { ExecutionTranscript, ExecutionTranscriptPlaceholder } from "../ExecutionTranscript";
import { activePlannerOutput } from "../PlanningActivity";
import { cachedPlanningOutput } from "../../services/transcriptCache";
import { HISTORY_PREPEND_EVENT } from "../../services/transcriptScroll";
import { smoothScrollToLatest } from "../../services/smoothConversationScroll";
import { plannerUserTurns } from "../../services/plannerUserTurns";
import { PlanningActivity } from "../PlanningActivity";
import { statusText, phaseText } from "../graph/TaskNode";
import { useSmoothStreamText } from "../../hooks/useSmoothStreamText";
import { useAnimatedNodes } from "../../hooks/useAnimatedNodes";
import { useWorkbenchResizer } from "../../hooks/useWorkbenchResizer";
import { PublicationCompletedCard } from "../PublicationCompletedCard";
import { EnvironmentResult } from "../EnvironmentResult";
import { PlannerTranscript } from "../PlannerTranscript";
import { resolveExecutionModelAndThinking } from "../../modelConfig";

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
  onInterrupt?: () => void;
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
  onConversationReady?: () => void;
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
    style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", justifyContent: "space-between",
      visibility: placeholder ? "hidden" : undefined }}
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

/** The composer overlays the scroller instead of taking space in its layout.
 * Reveal content against its actual top edge, including multiline drafts,
 * attachments and queued-message banners, not the scroller's covered bottom.
 */
function getConversationViewport(scroll: HTMLElement) {
  const bounds = scroll.getBoundingClientRect();
  const top = bounds.top + scroll.clientTop;
  const scrollBottom = top + scroll.clientHeight;
  const composer = scroll.parentElement?.querySelector<HTMLElement>(".pane-bottom-chat");
  const overlay = composer?.getBoundingClientRect();
  const bottom = overlay && overlay.height > 0 && overlay.bottom > top
    ? Math.max(top, Math.min(scrollBottom, overlay.top)) : scrollBottom;
  return { top, bottom, height: bottom - top };
}

interface WorkspaceDetailsPanelProps {
  showWorking?: boolean;
  children: React.ReactNode;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}

const WorkspaceDetailsPanel: React.FC<WorkspaceDetailsPanelProps> = ({
  showWorking,
  children,
  scrollContainerRef,
  onBeforeToggle,
  onAfterToggle,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const animatorRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastScrollDeltaRef = useRef<number>(0);
  const interruptedRef = useRef<boolean>(false);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  const handleToggle = useCallback(() => {
    const nextOpen = !isOpen;
    const animator = animatorRef.current;
    const content = contentRef.current;
    const panel = panelRef.current;

    if (!animator || !content || !panel) {
      setIsOpen(nextOpen);
      return;
    }

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    const container =
      scrollContainerRef?.current ||
      (panel.closest(".initial-query-scroll") as HTMLElement | null);

    onBeforeToggle?.();

    const startHeight = animator.offsetHeight;
    const measuredHeight = Math.max(content.offsetHeight, content.scrollHeight, animator.scrollHeight);
    const targetHeight = nextOpen ? (measuredHeight > 0 ? measuredHeight : 120) : 0;

    const startScrollTop = container ? container.scrollTop : 0;
    let scrollDelta = 0;
    interruptedRef.current = false;

    if (container) {
      const visibleBottom = getConversationViewport(container).bottom - 12;

      if (nextOpen) {
        const panelRect = panel.getBoundingClientRect();
        const futurePanelBottom = panelRect.bottom + targetHeight;
        if (futurePanelBottom > visibleBottom) {
          scrollDelta = futurePanelBottom - visibleBottom;
        }
        lastScrollDeltaRef.current = scrollDelta;
      } else {
        if (lastScrollDeltaRef.current > 0) {
          scrollDelta = -Math.min(lastScrollDeltaRef.current, container.scrollTop);
        } else {
          const panelRect = panel.getBoundingClientRect();
          if (panelRect.bottom >= visibleBottom - 24) {
            scrollDelta = -Math.min(startHeight, container.scrollTop);
          }
        }
        lastScrollDeltaRef.current = 0;
      }

      const onUserScroll = () => {
        interruptedRef.current = true;
      };
      container.addEventListener("wheel", onUserScroll, { passive: true, once: true });
      container.addEventListener("touchmove", onUserScroll, { passive: true, once: true });
    }

    setIsOpen(nextOpen);

    const duration = 280;
    const startTime = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      // ease-out cubic
      const ease = 1 - Math.pow(1 - progress, 3);

      const currentH = startHeight + (targetHeight - startHeight) * ease;
      const currentOp = nextOpen ? ease : 1 - ease;

      animator.style.height = `${currentH}px`;
      animator.style.opacity = `${currentOp}`;

      if (container && scrollDelta !== 0 && !interruptedRef.current && container.dataset.transcriptScrollMode !== "latest") {
        container.scrollTop = startScrollTop + scrollDelta * ease;
      }

      if (progress < 1) {
        rafIdRef.current = requestAnimationFrame(tick);
      } else {
        rafIdRef.current = null;
        if (nextOpen) {
          animator.style.height = "auto";
          animator.style.opacity = "1";
        } else {
          animator.style.height = "0px";
          animator.style.opacity = "0";
        }
        onAfterToggle?.();
      }
    };

    rafIdRef.current = requestAnimationFrame(tick);
  }, [isOpen, onBeforeToggle, onAfterToggle, scrollContainerRef]);

  return (
    <div ref={panelRef} className={`workspace-details ${isOpen ? "open" : ""}`} style={{ marginTop: 12 }}>
      {showWorking && (
        <div className="working-indicator" role="status" aria-live="polite">
          <span className="working-indicator-dot" />
          Working…
        </div>
      )}
      <div className="workspace-details-summary">
        <button
          type="button"
          className="workspace-details-trigger"
          onClick={handleToggle}
          aria-expanded={isOpen}
        >
          <span>{t("工作区与会话信息")}</span>
          <ChevronRight size={11} className={`workspace-details-chevron ${isOpen ? "open" : ""}`} />
        </button>
      </div>

      <div
        ref={animatorRef}
        className="workspace-details-animator"
        style={{
          overflow: "hidden",
          height: 0,
          opacity: 0,
        }}
        aria-hidden={!isOpen}
      >
        <div ref={contentRef} className="workspace-details-body">
          {children}
        </div>
      </div>
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
  onConversationReady,
}) => {
  const [attemptId, setAttemptId] = useState("");
  const [expandedAttemptIds, setExpandedAttemptIds] = useState<Set<string>>(new Set());
  const [collapsedAttemptIds, setCollapsedAttemptIds] = useState<Set<string>>(new Set());
  const [editingTaskNode, setEditingTaskNode] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  useEffect(() => {
    setAttemptId("");
    setExpandedAttemptIds(new Set());
    setCollapsedAttemptIds(new Set());
    setEditingTaskNode("");
    setTaskDraft("");
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
      .catch(() => {});

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
  const latestAttemptId = attempts.length > 0 ? attempts[attempts.length - 1].id : "";
  const execution: Execution | undefined = selectedMerger ?? attempts.find((item) => item.id === attemptId) ?? attempts[attempts.length - 1];
  const isMerger = publicationMergerSelected || isNodeMergerSelected;
  const snapshotModelInfo = useMemo(() => {
    if (!execution) return null;
    return resolveExecutionModelAndThinking(
      execution,
      isMerger,
      state.config || config,
      envOverrides,
      execution.id === latestAttemptId ? state.nodes[execution.node]?.modelConfig : undefined
    );
  }, [execution, isMerger, latestAttemptId, state.nodes, state.config, config, envOverrides]);
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
      executions: Execution[];
    }> = [{
      id: `turn-0-${selectedNode.name}`,
      isInitial: true,
      executions: attempts.length > 0 ? [attempts[0]] : [],
    }];
    const assigned = new Set(turns[0].executions.map(item => item.id));
    let nextAttempt = 1;

    for (const message of nodeMessages) {
      const exact = message.executionId
        ? attempts.find(item => item.id === message.executionId && !assigned.has(item.id))
        : undefined;
      let executions: Execution[] = exact ? [exact] : [];
      if (exact) {
        assigned.add(exact.id);
        nextAttempt = Math.max(nextAttempt, attempts.findIndex(item => item.id === exact.id) + 1);
      } else if (!message.delivery) {
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
  const isSelectedNodeWorking = selectedMerger
    ? !!selectedMergerRunning || (!!pendingRequest && selectedMerger.status !== "completed" && selectedMerger.status !== "failed")
    : isNodeWorking(selectedState?.status, execution, pendingRequest, latestNodeMessage);
  const latestNodeTurn = nodeTurns.at(-1);
  const waitingForNodeExecution = !!latestNodeTurn && latestNodeTurn.executions.length === 0 &&
    !latestNodeTurn.userMessage?.delivery && (isSelectedNodeWorking || pendingRequest);
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
  const showLivePlanner = !recoveredPlanningId && (isPlanning ||
    ((plannerStream.runId === state.runId || (provisionalRunIdRef.current && (plannerStream.runId === provisionalRunIdRef.current || state.runId === provisionalRunIdRef.current))) && plannerStream.items?.length > 0));
  const savedPlannerId = recoveredPlanningId || (failedPlanning
    ? (failedPlanning.roles?.planner ? failedPlanning.planningId : undefined)
    : (routeType === "graph" ? state.planningId : undefined));
  // A run owns one Planner conversation, although each planning attempt has
  // its own durable output log. Replay every committed turn after a reload;
  // exclude turns already present in the live SSE transcript.
  const savedPlannerIds = useMemo(() => {
    // Recovery discovers the planning ID before the route is known. Mount the
    // durable activity poller now, rather than waiting for the finished graph.
    if ((!recoveredPlanningId && routeType !== "graph") ||
        (isPlanning && !recoveredPlanningId && !plannerStream.runId && !plannerStream.isContinuation)) return [];
    const ids = state.events
      .filter((event) => event.type === "created" || event.type === "graph_revised")
      .map((event) => event.planning_id)
      .filter((id): id is string => Boolean(id));
    if (savedPlannerId) ids.push(savedPlannerId);
    const seen = new Set<string>();
    return ids.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      // Only suppress a durable turn while it is actively streaming. Once
      // planning stops, the JSONL is authoritative even if SSE was partial.
      return !(isPlanning && showLivePlanner && plannerStream.items?.length > 0 &&
        plannerStream.representedPlanningIds?.includes(id));
    });
  }, [routeType, isPlanning, recoveredPlanningId, state.events, savedPlannerId, showLivePlanner, plannerStream.runId, plannerStream.isContinuation, plannerStream.items, plannerStream.representedPlanningIds]);
  const plannerEdits = useMemo(() => state.events.flatMap((event, index) => {
    if (event.type !== "planner_conversation_edited") return [];
    const nextPlanningId = state.events.slice(index + 1).find(item =>
      item.type === "graph_revised" && item.planning_id)?.planning_id;
    return [{ old_instruction: event.old_instruction, nextPlanningId }];
  }), [state.events]);
  const savedPlannerKey = savedPlannerIds.join(":");
  const [readySavedPlannerKey, setReadySavedPlannerKey] = useState("");
  const [savedPlannerRecord, setSavedPlannerRecord] = useState({ key: "", text: "" });
  const savedPlannerOutput = savedPlannerRecord.key === savedPlannerKey ? savedPlannerRecord.text
    : cachedPlanningOutput(transcriptRunId, savedPlannerIds);
  const plannerMessages = useMemo(() => effectiveMessages.filter((msg) => !msg.node || msg.node === "planner"), [effectiveMessages]);
  const persistedUserTurns = useMemo(() => {
    if (plannerMessages.length <= 1) return [];
    const turns = plannerUserTurns(activePlannerOutput(savedPlannerOutput, plannerEdits));
    if (turns[0] === plannerMessages[0]?.text.trim()) turns.shift();
    return turns;
  }, [savedPlannerOutput, plannerEdits, plannerMessages]);
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
    (!showLivePlanner || readySavedPlannerKey === savedPlannerKey);
  const renderLivePlanner = showLivePlanner && (isPlanning || !useSavedPlanner);
  const { workbenchRef, isResizing, splitRatio, handleStartResize, handleResetResizer } = useWorkbenchResizer();
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const expandedCardObserverRef = useRef<ResizeObserver | null>(null);
  const expandedCardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUserScrolledUpRef = useRef(false);
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
    transition: isConversationReady && !reduceMotion ? "opacity 0.28s ease-in-out" : "none",
  };
  const activeConversationViewRef = useRef(conversationViewKey);
  const conversationGenerationRef = useRef(0);
  const isScrollingToBottomRef = useRef(false);
  const latestScrollRef = useRef<(() => void) | null>(null);
  const stopLatestScroll = useCallback(() => {
    if (latestScrollRef.current) {
      latestScrollRef.current();
      latestScrollRef.current = null;
      isUserScrolledUpRef.current = true;
    }
    isScrollingToBottomRef.current = false;
  }, []);
  const userGestureUpRef = useRef(false);
  const historyReadingRef = useRef(false);
  const isPreparingConversationRef = useRef(false);
  const graphFlowRef = useRef<ReactFlowInstance<any, any> | null>(null);
  const graphFitFrameRef = useRef<number | null>(null);
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
  const graphRunRef = useRef(currentRunKey);
  const [readyGraphRunKey, setReadyGraphRunKey] = useState("");
  const isGraphMountedForRun = readyGraphRunKey === currentRunKey;

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
  }

  const centerGraph = useCallback((instance: ReactFlowInstance<any, any>, targetKey = currentRunKey) => {
    if (graphRunRef.current !== targetKey) return;
    graphFlowRef.current = instance;
    if (graphFitFrameRef.current !== null) cancelAnimationFrame(graphFitFrameRef.current);

    // Two animation frames do not guarantee that ReactFlow's ResizeObserver
    // has measured every node. Fitting early can use only part of the graph.
    const fitWhenMeasured = async () => {
      graphFitFrameRef.current = null;
      if (graphFlowRef.current !== instance || graphRunRef.current !== targetKey) return;
      const flowNodes = instance.getNodes();
      if (flowNodes.some(node => {
        const measured = instance.getInternalNode(node.id)?.measured;
        return !measured?.width || !measured?.height;
      })) {
        graphFitFrameRef.current = requestAnimationFrame(fitWhenMeasured);
        return;
      }
      await instance.fitView({ padding: 0.24, minZoom: 0.3, maxZoom: 1.6, duration: 0 });
      if (graphFlowRef.current !== instance || graphRunRef.current !== targetKey) return;
      // Commit the fitted viewport before starting the panel's entrance fade.
      graphFitFrameRef.current = requestAnimationFrame(() => {
        graphFitFrameRef.current = null;
        if (graphFlowRef.current !== instance || graphRunRef.current !== targetKey) return;
        setReadyGraphRunKey(targetKey);
      });
    };
    graphFitFrameRef.current = requestAnimationFrame(fitWhenMeasured);
  }, [currentRunKey]);

  const handleChatScroll = useCallback(() => {
    if (!chatScrollRef.current) return;
    if (suppressAutoScrollRef.current || isPreparingConversationRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatScrollRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const showLatest = distanceFromBottom > clientHeight / 2;
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
      isUserScrolledUpRef.current = false;
      setScrollBottomVisible(false);
      return;
    }

    if (distanceFromBottom <= CONVERSATION_BOTTOM_THRESHOLD && userGestureUpRef.current && scrollTop >= prevScrollTop) {
      userGestureUpRef.current = false;
      isUserScrolledUpRef.current = false;
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
      isUserScrolledUpRef.current = true;
      setScrollBottomVisible(showLatest);
      return;
    }

    // A resize or a newly mounted transcript can change the distance without
    // any user scroll. Do not mistake that for an intentional scroll-up.
    setScrollBottomVisible(isUserScrolledUpRef.current && showLatest);
  }, [setScrollBottomVisible]);

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
    isUserScrolledUpRef.current = false;
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
  }, [stopLatestScroll, setScrollBottomVisible]);

  const handleSendMessageWithScroll = useCallback(async (val: string, options?: PromptBoxSubmitOptions) => {
    const submittedDraft = composerDrafts?.get(composerDraftKey);
    stopLatestScroll();
    historyReadingRef.current = false;
    if (chatScrollRef.current) delete chatScrollRef.current.dataset.transcriptHistoryReading;
    isUserScrolledUpRef.current = false;
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
  }, [onSendMessage, stopLatestScroll, setScrollBottomVisible, composerDrafts, composerDraftKey]);

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
        isUserScrolledUpRef.current = true;
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
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (delta < -1) {
          historyReadingRef.current = false;
          delete el.dataset.transcriptHistoryReading;
        }
        if (delta > 1) {
          userGestureUpRef.current = true;
          isScrollingToBottomRef.current = false;
          isUserScrolledUpRef.current = true;
        }
      }
    };

    const onHistoryPrepend = () => {
      stopLatestScroll();
      historyReadingRef.current = true;
      userGestureUpRef.current = true;
      isUserScrolledUpRef.current = true;
      isScrollingToBottomRef.current = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
      const up = ["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey);
      const down = ["ArrowDown", "PageDown", "End"].includes(event.key) || (event.key === " " && !event.shiftKey);
      if (up || down) stopLatestScroll();
      if (up) {
        userGestureUpRef.current = true;
        isUserScrolledUpRef.current = true;
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
  }, [conversationViewKey, stopLatestScroll]);

  const handleExpandableContentChange = useCallback((expanded?: boolean, card?: HTMLElement) => {
    suppressAutoScrollRef.current = true;
    isUserScrolledUpRef.current = true;
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
        isUserScrolledUpRef.current = false;
        suppressAutoScrollRef.current = false;
      }
      handleChatScroll();
    }, 600);
  }, [handleChatScroll]);

  const isAttemptExpanded = useCallback((execId: string) => {
    if (!showExecutionRecords) return true;
    return execId === latestAttemptId && !waitingForNodeExecution
      ? !collapsedAttemptIds.has(execId)
      : expandedAttemptIds.has(execId);
  }, [showExecutionRecords, waitingForNodeExecution, latestAttemptId, collapsedAttemptIds, expandedAttemptIds]);

  const handleToggleAttempt = useCallback((execId: string, panelEl?: HTMLElement | null) => {
    const currentlyExpanded = isAttemptExpanded(execId);
    const willExpand = !currentlyExpanded;
    const isLatest = execId === latestAttemptId && !waitingForNodeExecution;

    const attemptIndex = attempts.findIndex(a => a.id === execId);
    const hasExpandedBelow = attemptIndex >= 0 && attempts.slice(attemptIndex + 1).some(a => isAttemptExpanded(a.id));

    if (willExpand) {
      if (!hasExpandedBelow) {
        isUserScrolledUpRef.current = false;
        userGestureUpRef.current = false;
        suppressAutoScrollRef.current = false;
      } else {
        isUserScrolledUpRef.current = true;
        suppressAutoScrollRef.current = true;
      }
    } else {
      suppressAutoScrollRef.current = true;
      isUserScrolledUpRef.current = true;
    }

    if (isLatest) {
      setCollapsedAttemptIds((prev) => {
        const next = new Set(prev);
        if (currentlyExpanded) next.add(execId);
        else next.delete(execId);
        return next;
      });
    } else {
      setExpandedAttemptIds((prev) => {
        const next = new Set(prev);
        if (currentlyExpanded) next.delete(execId);
        else next.add(execId);
        return next;
      });
    }

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
  }, [isAttemptExpanded, latestAttemptId, waitingForNodeExecution, attempts, followExecutionExpansion, handleChatScroll]);

  useLayoutEffect(() => {
    const view = chatScrollRef.current?.parentElement;
    const composer = view?.querySelector<HTMLElement>(".pane-bottom-chat");
    if (!view || !composer) return;
    const update = () => {
      view.style.setProperty("--composer-height", `${composer.getBoundingClientRect().height}px`);
      // The composer is overlaid; changing its height changes the scroll area's
      // bottom padding without resizing the observed transcript content.
      const scroll = chatScrollRef.current;
      if (scroll && !isUserScrolledUpRef.current && !isScrollingToBottomRef.current) {
        scroll.scrollTop = scroll.scrollHeight;
        lastScrollTopRef.current = scroll.scrollTop;
        setScrollBottomVisible(false);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [conversationViewKey, setScrollBottomVisible]);

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
    if (graphFitFrameRef.current !== null) {
      cancelAnimationFrame(graphFitFrameRef.current);
    }
    graphFlowRef.current = null;
  }, []);

  const workspaceDetailsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleWorkspaceDetailsBeforeToggle = useCallback(() => {
    suppressAutoScrollRef.current = true;
    if (chatScrollRef.current) {
      prevScrollHeightRef.current = chatScrollRef.current.scrollHeight;
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
      prevScrollHeightRef.current = currentScrollHeight;

      if (suppressAutoScrollRef.current) return;

      // Keep the newest output visible while content arrives. This includes the
      // initial preparation window: returning early there left a freshly opened
      // history stuck at the top until the user scrolled manually.
      if (heightGrew && !latestScrollRef.current && (!isUserScrolledUpRef.current || isScrollingToBottomRef.current)) {
        el.scrollTop = currentScrollHeight;
        lastScrollTopRef.current = currentScrollHeight;
      }
      handleChatScroll();
    });

    observer.observe(el);
    if (el.firstElementChild) {
      observer.observe(el.firstElementChild);
    }

    return () => observer.disconnect();
  }, [handleChatScroll, conversationViewKey]);

  // Auto-scroll to bottom when new messages or streaming content arrives
  useLayoutEffect(() => {
    if (!latestScrollRef.current && !isUserScrolledUpRef.current && !suppressAutoScrollRef.current && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      lastScrollTopRef.current = chatScrollRef.current.scrollTop;
    }
  }, [
    effectiveMessages,
    smoothPlannerText,
    plannerStream.items,
    plannerStream.plannerThinking,
    isPlanning,
    execution?.id,
    execution?.status,
    execution?.outputBytes,
    execution?.output,
    state.publication?.status,
    state.phase,
  ]);

  const serialNode = routeType === "serial" && state.graph.nodes.length > 0 ? state.graph.nodes[0] : undefined;
  const serialNodeState = serialNode ? state.nodes[serialNode.name] : undefined;
  const serialExecutions = useMemo(() => {
    if (!serialNode) return [];
    return activeNodeExecutions(state, serialNode.name)
      .sort((a, b) => a.startedAt - b.startedAt);
  }, [serialNode?.name, state.executions, state.supersededExecutionIds]);
  const serialExecution: Execution | undefined = serialExecutions[serialExecutions.length - 1];
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
        id: userMessage.id, userMessage, isInitial: index === 0, executions: [] as Execution[],
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
    const recorded = activeNodeConversationEvents(state, serialNode.name).filter((event) =>
      (event.type === "node_messaged" && event.node === serialNode.name) ||
      ((event.type === "invalidated" && event.human || (event.type === "conversation_edited" && !event.first_turn)) && event.target === serialNode.name && !!event.instruction)
    ).reverse().filter((event) => {
      const idx = localRemaining.findIndex((msg) => msg.text.replace(/^\[@[^\]]+\]\s*/, "") === event.instruction);
      if (idx < 0) return true;
      localRemaining.splice(idx, 1);
      return false;
    }).reverse().map((event): ChatMessage => ({
      id: `event-${event.sequence}`, parentId: null, role: "user",
      text: event.instruction || "", images: event.images, node: serialNode.name, runId: state.runId,
      versions: event.type === "conversation_edited" ? versionsForEdit(state, event) : undefined,
      currentVersionIndex: event.type === "conversation_edited" ? versionIndexForEdit(state, event) : undefined,
      executionId: executionIdForMessage(state, event),
      delivery: event.type === "node_messaged" ? "node_messaged" : undefined,
    }));
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

    let execIndex = 1;
    messages.slice(1).forEach((msg) => {
      const execs = msg.delivery ? [] : execIndex < serialExecutions.length ? [serialExecutions[execIndex]] : [];
      if (!msg.delivery) execIndex++;
      turns.push({
        id: msg.id,
        userMessage: { ...msg, executionId: execs[0]?.id ?? msg.executionId },
        isInitial: false,
        executions: execs,
      });
    });

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
  const serialWorkingAfterMessage = serialTurns.length > 0 && serialTurns[serialTurns.length - 1].executions.length === 0;
  const isSerialWorking = isNodeWorking(serialNodeState?.status, serialExecution, pendingRequest,
    serialWorkingAfterMessage ? serialTurns[serialTurns.length - 1].userMessage : undefined);
  // Serial auto-approval runs after planning releases its busy state, and
  // approval returns before the background driver starts the waiting node.
  // Both phases belong to first-execution startup, not an idle conversation.
  const isSerialAwaitingStart = !serialExecution && !state.paused && (
    state.phase === "awaiting_approval" ||
    (state.approved && state.phase === "running" && serialNodeState?.status === "waiting")
  );
  const isMainViewWorking = routeType === "serial" ? (isPlanning || isSerialAwaitingStart || isSerialWorking) : isPlanning;
  const completed = Object.values(state.nodes).filter((n) => n.status === "done").length;
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
    resultExecution: state.resultExecution,
  });
  const activityStatus = activityStatusText(activity);
  const isWorkspaceWritten = !isPlanning && routeType === "graph" && (
    state.publication?.status === "completed" ||
    (state.phase === "completed" && state.publication?.status !== "failed" && state.publication?.status !== "publishing" && state.publication?.status !== "merging")
  );
  // Each conversation owns a fresh ReactFlow store and measured viewport.
  const hasGraphToolCalled =
    (plannerStream.items || []).some((t: any) => t.toolName === "node" || t.toolName === "edge") ||
    (plannerStream.tools || []).some((t: any) => t.toolName === "node" || t.toolName === "edge");
  const hasGraphContent = state.graph.nodes.length > 0 || hasGraphToolCalled;
  const showGraphPane = routeType === "graph" && (hasGraphContent || (!isPlanning && state.graph.nodes.length > 0));

  const animatedNodes = useAnimatedNodes(nodes, state.runId);
  const prevNodesCountRef = useRef(nodes.length);
  const prevEdgesCountRef = useRef(edges.length);

  useLayoutEffect(() => {
    if (graphRunRef.current === currentRunKey && showGraphPane) return;
    graphRunRef.current = currentRunKey;
    graphFlowRef.current = null;
    if (graphFitFrameRef.current !== null) cancelAnimationFrame(graphFitFrameRef.current);
    graphFitFrameRef.current = null;
    setReadyGraphRunKey("");
    prevNodesCountRef.current = nodes.length;
    prevEdgesCountRef.current = edges.length;
  }, [currentRunKey, showGraphPane, nodes.length, edges.length]);

  useEffect(() => {
    if (nodes.length > 0 && nodes.length !== prevNodesCountRef.current) {
      prevNodesCountRef.current = nodes.length;
      if (graphFlowRef.current && isPlanning && isGraphMountedForRun) {
        void graphFlowRef.current.fitView({ padding: 0.24, duration: 400, minZoom: 0.3, maxZoom: 1.5 });
      }
    }
  }, [nodes.length, isPlanning, isGraphMountedForRun]);

  useEffect(() => {
    if (edges.length > 0 && edges.length !== prevEdgesCountRef.current) {
      prevEdgesCountRef.current = edges.length;
      if (graphFlowRef.current && isPlanning && isGraphMountedForRun) {
        void graphFlowRef.current.fitView({ padding: 0.24, duration: 450, minZoom: 0.3, maxZoom: 1.5 });
      }
    }
  }, [edges.length, isPlanning, isGraphMountedForRun]);

  const prevMsgCountRef = useRef(effectiveMessages.length);
  useEffect(() => {
    if (effectiveMessages.length > prevMsgCountRef.current) {
      prevMsgCountRef.current = effectiveMessages.length;
      if (!latestScrollRef.current && !isUserScrolledUpRef.current && chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
    } else {
      prevMsgCountRef.current = effectiveMessages.length;
    }
  }, [effectiveMessages.length]);

  const revealConversation = useCallback(() => {
    const key = conversationViewKey;
    const generation = conversationGenerationRef.current;
    if (activeConversationViewRef.current !== key) return;
    if (revealChatFrameRef.current !== null) cancelAnimationFrame(revealChatFrameRef.current);
    // Let the transcript parse and measure its rows before the first visible frame.
    revealChatFrameRef.current = requestAnimationFrame(() => {
      revealChatFrameRef.current = requestAnimationFrame(() => {
        revealChatFrameRef.current = null;
        if (activeConversationViewRef.current !== key || conversationGenerationRef.current !== generation) return;
        const el = chatScrollRef.current;
        if (el) {
          const resolved = resolveViewScroll(conversationScrollStateRef.current.get(key), el.scrollHeight);
          if (resolved.restoreSaved) {
            el.scrollTop = resolved.scrollTop;
          } else if (!isUserScrolledUpRef.current) {
            el.scrollTop = el.scrollHeight;
          }
          lastScrollTopRef.current = el.scrollTop;
        }
        isPreparingConversationRef.current = false;
        suppressAutoScrollRef.current = false;
        setScrollBottomVisible(false);
        setReadyConversationKey(key);
        onConversationReady?.();
      });
    });
  }, [conversationViewKey, setScrollBottomVisible, onConversationReady]);
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
      isUserScrolledUpRef.current = resolved.isUserScrolledUp;
      el.scrollTop = resolved.restoreSaved ? resolved.scrollTop : el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
      prevScrollHeightRef.current = el.scrollHeight;
      setScrollBottomVisible(false);

      if (resetChatScrollFrameRef.current !== null) {
        cancelAnimationFrame(resetChatScrollFrameRef.current);
      }
      resetChatScrollFrameRef.current = requestAnimationFrame(() => {
        resetChatScrollFrameRef.current = null;
        if (chatScrollRef.current) {
          const next = resolveViewScroll(conversationScrollStateRef.current.get(conversationViewKey), chatScrollRef.current.scrollHeight);
          if (next.restoreSaved) {
            chatScrollRef.current.scrollTop = next.scrollTop;
          } else if (!isUserScrolledUpRef.current) {
            chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
          }
          lastScrollTopRef.current = chatScrollRef.current.scrollTop;
        }
      });
    }

    // If no execution or planning output needed to trigger onReady, reveal after layout settle
    const hasExpandedExecution = selectedNode && routeType === "graph"
      ? Boolean(execution && attempts.some(a => isAttemptExpanded(a.id)))
      : (routeType === "serial"
          ? Boolean(serialExecutions.length)
          : (savedPlannerIds.length > 0 && useSavedPlanner));

    if (readyConversationKey !== conversationViewKey && !hasExpandedExecution) {
      revealConversation();
    }

    // Safety fallback: ensure conversation is revealed even if an output event fails to fire
    const safetyTimer = setTimeout(() => {
      if (!historyLoading && activeConversationViewRef.current === conversationViewKey && readyConversationKey !== conversationViewKey) {
        revealConversation();
      }
    }, 350);
    return () => clearTimeout(safetyTimer);
  }, [
    conversationViewKey,
    readyConversationKey,
    historyLoading,
    selectedNode,
    routeType,
    execution,
    attempts,
    isAttemptExpanded,
    savedPlannerIds.length,
    useSavedPlanner,
    serialExecutions.length,
    revealConversation,
    stopLatestScroll,
    setScrollBottomVisible,
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
              <span className={`status ${selectedMerger ? (selectedMerger.status === "completed" ? "done" : selectedMerger.status === "running" ? "running" : "failed") : (selectedState?.status ?? "waiting")}`}>
                {selectedMerger
                  ? statusText[selectedMerger.status === "completed" ? "done" : selectedMerger.status === "running" ? "running" : "failed"]
                  : statusText[selectedState?.status ?? "waiting"]}
              </span>
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
              className="initial-query-scroll"
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
                  onEdit={!isNodeMergerSelected && selected !== publicationMergerCardId && (!state.approved || selectedState?.status === "done" || selectedState?.status === "failed" || selectedState?.status === "running") ? () => {
                    onCancelEditMessage?.();
                    setEditingTaskNode(selectedNode.name);
                    setTaskDraft(selectedNode.task);
                  } : undefined}
                  onCancel={() => setEditingTaskNode("")}
                  disabled={locked || (state.approved && selectedState?.status === "dirty") || taskDraft.trim() === selectedNode.task}
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
                      <div className="chat-message-row user">
                        <EditableUserBubble
                          text={turn.userMessage.text.replace(/^\[@[^\]]+\]\s*/, "").trim()}
                          images={turn.userMessage.images}
                          files={turn.userMessage.files}
                          editing={editingMessage?.id === turn.userMessage.id}
                          draft={editPrefillText ?? ""}
                          onDraftChange={onEditPrefillTextChange ?? (() => {})}
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
                      const isLatestAttempt = exec.id === latestAttemptId;
                      const isExpanded = isAttemptExpanded(exec.id);
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
                                onInitialOutputReady={isLatestAttempt || !isAttemptExpanded(latestAttemptId) ? revealConversation : undefined}
                              />
                            </div>
                          )}
                        </motion.div>
                      );
                    })}
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
                  scrollContainerRef={chatScrollRef}
                  onBeforeToggle={handleWorkspaceDetailsBeforeToggle}
                  onAfterToggle={handleWorkspaceDetailsAfterToggle}
                >
                  <p>worktree: {execution?.worktree || config.repository || "preparing workspace…"}</p>
                  <p>session id: {execution?.sessionId || "waiting for initialization…"}</p>
                  <p>commit before: {execution?.before || "not snapshotted"}</p>
                  <p>commit after: {execution ? (execution.after === "" ? "direct modification (no snapshot)" : execution.after ?? "pending") : "pending"}</p>
                  {snapshotModelInfo && (
                    <>
                      <p>model: {snapshotModelInfo.model}</p>
                      <p>thinking level: {snapshotModelInfo.thinkingLevel}</p>
                    </>
                  )}
                </WorkspaceDetailsPanel>

                {selectedState?.error && (
                  <div className="node-error" style={{ marginTop: 12 }}>
                    {localizeError(selectedState.error)}
                  </div>
                )}
              </div>
            </div>
            <button
              ref={scrollBottomBtnRef}
              type="button"
              className="scroll-to-bottom-btn"
              onClick={scrollToBottom}
              title={t("回到底部最新输出")}
            >
              <ArrowDown size={14} />
              <span>{t("最新")}</span>
            </button>
            <motion.div
              className="pane-bottom-chat"
              initial={{ opacity: 0 }}
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
                node={selectedNode?.name}
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
                    ? t("向 @{0} 实时发送 Steer（当前工具调用后生效）…", selectedNode.name)
                    : selectedState?.status === "done"
                    ? t("向 @{0} 留言（仅记录，不重新执行）…", selectedNode.name)
                    : t("向 @{0} 发送介入指令…", selectedNode.name)
                }
                isExecuting={isSelectedNodeWorking}
                isWorking={isSelectedNodeWorking}
                onInterrupt={onInterrupt}
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
              className="initial-query-scroll"
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
                        turn.executions.length === 0 &&
                        index === serialTurns.length - 1 &&
                        (isSerialWorking || isMainViewWorking || pendingRequest);

                      return (
                      <React.Fragment key={turn.id}>
                        {turn.userMessage && (
                          <motion.div
                            className="chat-message-row user"
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
                              onDraftChange={onEditPrefillTextChange ?? (() => {})}
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
                          const isLatestSerial = exec.id === serialExecutions[serialExecutions.length - 1]?.id;

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
                                  onInitialOutputReady={isLatestSerial ? revealConversation : undefined}
                                />
                              </div>
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
                      scrollContainerRef={chatScrollRef}
                      onBeforeToggle={handleWorkspaceDetailsBeforeToggle}
                      onAfterToggle={handleWorkspaceDetailsAfterToggle}
                    >
                      <p>working directory: {serialExecution?.worktree || config.repository || repoInfo?.name || "preparing workspace…"}</p>
                      <p>session id: {serialExecution?.sessionId || "waiting for initialization…"}</p>
                      {serialModelInfo && (
                        <>
                          <p>model: {serialModelInfo.model}</p>
                          <p>thinking level: {serialModelInfo.thinkingLevel}</p>
                        </>
                      )}
                    </WorkspaceDetailsPanel>
                    {serialNodeState?.error && (
                      <div className="node-error" style={{ marginTop: 12 }}>
                        {localizeError(serialNodeState.error)}
                      </div>
                    )}
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
                            onDraftChange={onEditPrefillTextChange ?? (() => {})}
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
                          showUserTurns={!isPlanning || !!recoveredPlanningId}
                          skipFirstUser={plannerMessages.length > 0}
                          running={isPlanning || !!recoveredPlanningId}
                          onReady={() => {
                            setReadySavedPlannerKey(savedPlannerKey);
                            revealConversation();
                          }}
                          onOutputChange={(text) => setSavedPlannerRecord(previous =>
                            previous.key === savedPlannerKey && previous.text === text ? previous : { key: savedPlannerKey, text })}
                          onLoadingChange={setHistoryLoading}
                          onUserResize={handleExpandableContentChange}
                          edits={plannerEdits}
                          onEditUser={onEditMessageSubmit ? (text, replacement) =>
                            onEditMessageSubmit({ id: `planner-history-${text}`, role: "user", parentId: null,
                              text, runId: state.runId }, replacement) : undefined}
                        />
                      </div>
                    )}

                    {/* 保留当前对话中的跟进消息；实时流已有同一消息时不重复渲染。 */}
                    {plannerMessages.slice(1).filter((msg) => {
                      if (msg.node && msg.node !== "planner") return false;
                      if (renderLivePlanner && plannerStream.items?.some((item: TranscriptItem) =>
                        item.role === "user" && item.id === msg.id)) return false;
                      // Keep an acknowledged steer visible across navigation
                      // until its completed turn actually appears in JSONL.
                      if (useSavedPlanner && !isPlanning) {
                        const text = msg.text.trim();
                        const count = remainingPersistedTurns.get(text) ?? 0;
                        if (count > 0) {
                          remainingPersistedTurns.set(text, count - 1);
                          return false;
                        }
                      }
                      return true;
                    }).map((msg) => (
                      <div className="chat-message-row user" key={msg.id}>
                        <EditableUserBubble
                          text={msg.text.trim()}
                          images={msg.images}
                          files={msg.files}
                          editing={editingMessage?.id === msg.id}
                          draft={editPrefillText ?? ""}
                          onDraftChange={onEditPrefillTextChange ?? (() => {})}
                          onEdit={onEditMessage ? () => onEditMessage(msg) : undefined}
                          onCancel={() => onCancelEditMessage?.()}
                          onSend={(value) => onEditMessageSubmit ? onEditMessageSubmit(msg, value) : onSendMessage(value)}
                          disabled={locked && !isPlanning}
                          versions={msg.versions}
                          currentVersionIndex={msg.currentVersionIndex}
                          onSwitchVersion={(idx) => onSwitchMessageVersion?.(msg, idx)}
                        />
                      </div>
                    ))}

                    {/* Planner 顺序流式记录：严格按实际发生时序呈现用户追加消息、工具调用、思维链与输出文字 */}
                    {renderLivePlanner && plannerStream.items && plannerStream.items.length > 0 ? (
                      <PlannerTranscript items={plannerStream.items} isPlanning={isPlanning} locked={locked}
                        editingMessage={editingMessage} draft={editPrefillText ?? ""}
                        onDraftChange={onEditPrefillTextChange ?? (() => {})} onEditMessage={onEditMessage}
                        onCancelEdit={onCancelEditMessage} onEditSubmit={onEditMessageSubmit}
                        onSendMessage={onSendMessage} onUserResize={handleExpandableContentChange} />
                    ) : (
                      renderLivePlanner && (plannerStream.plannerThinking || smoothPlannerText) && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {plannerStream.plannerThinking && (
                            <ThinkingCard
                              content={plannerStream.plannerThinking}
                              isStreaming={isPlanning && plannerStream.plannerThinkingActive}
                              title={t("思考过程")}
                              defaultExpanded={true}
                              autoExpandWhileStreaming={true}
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
                {isMainViewWorking && routeType !== "serial" && (
                  <div className="working-indicator" role="status" aria-live="polite">
                    <span className="working-indicator-dot" />
                    Working…
                  </div>
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

              {!isPlanning && routeType === "graph" && state.graph.nodes.length > 0 && (
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
                      {state.graph.nodes.map((node) => {
                        const nState = state.nodes[node.name];
                        return (
                          <button
                            type="button"
                            key={node.name}
                            className="node-chip"
                            onClick={() => { setSelected(node.name); setSelectedMergerId(""); }}
                            title={node.task}
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
              {isWorkspaceWritten && (
                <PublicationCompletedCard
                  state={state}
                  routeType={routeType}
                  repository={config?.repository || repoInfo?.path}
                />
              )}
            </div>
            <button
              ref={scrollBottomBtnRef}
              type="button"
              className="scroll-to-bottom-btn"
              onClick={scrollToBottom}
              title={t("回到底部最新输出")}
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
                onInterrupt={onInterrupt}
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
              animate={{ opacity: isGraphMountedForRun ? 1 : 0 }}
              exit={{ opacity: 0, transition: { duration: 0.16 } }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              style={{ pointerEvents: isGraphMountedForRun ? "auto" : "none" }}
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
              animate={{ opacity: isGraphMountedForRun ? 1 : 0, x: isGraphMountedForRun ? 0 : 28 }}
              exit={{ opacity: 0, x: 28, transition: { duration: 0.16, ease: [0.3, 0, 0.8, 0.15] } }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              style={{ pointerEvents: isGraphMountedForRun ? "auto" : "none" }}
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

              <div className="graph-canvas">
                <GraphCanvas runKey={currentRunKey} ready={isGraphMountedForRun}
                  nodes={animatedNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} tokens={tokens}
                  onInit={centerGraph} onSelect={selectGraphNode} />

                {state.graph.nodes.length > 0 && (
                  <>
                    <div className="graph-note">
                      <span className="note-line" />{t("依赖前进")}<span className="note-line feedback" />{t("执行反馈")}</div>

                    <div className="planner-off">
                      <span />Planner {isPlanning ? t("规划中") : state.graph.nodes.length ? t("已离线") : t("未启动")}
                    </div>
                  </>
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
                        : graphPhase === "paused" ? t("已暂停后续派发")
                        : graphPhase === "completed" ? t("运行已完成")
                        : state.approved ? phaseText[graphPhase] ?? graphPhase : ""}
                    </span>
                    <div>
                      {graphPhase === "awaiting_approval" ? (
                        <>
                          <button type="button" className="text-button" disabled={locked} onClick={() => onControl("reject")}>
                            Reject
                          </button>
                          <button type="button" className="primary" disabled={locked} onClick={onOpenApproval}>
                            <Play size={13} fill="currentColor" />Approve
                          </button>
                        </>
                      ) : state.approved ? (
                        <>
                          <button
                            type="button"
                            className="primary"
                            disabled={locked || publishing || publicationFailed || state.phase === "completed"}
                            onClick={() => onControl(canContinue ? "resume" : "pause")}
                          >
                            {canContinue ? <Play size={13} /> : <Pause size={13} />}
                            {canContinue ? t("继续") : t("暂停")}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <EnvironmentResult state={state} />
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
