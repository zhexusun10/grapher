import { t, localizeError } from "../../i18n";
import React, { useRef, useState, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { Background, Controls, ReactFlow, type ReactFlowInstance } from "@xyflow/react";
import {
  Code2, ArrowLeft, FolderGit2,
  Workflow, Play, Pause, Compass, ArrowDown, Clock, Loader2, ChevronRight,
  AlertCircle
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  Snapshot, PlanRouteType, RepositoryInfo, Config,
  Graph, Execution, Status, PlanningSummary, TranscriptItem,
  ChatMessage
} from "../../types";
import { PromptBox, type PromptBoxSubmitOptions } from "../ui/chatgpt-prompt-input";
import type { ConfirmModalState } from "../modals/ConfirmModal";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { EditableUserBubble, StreamingAssistantBubble } from "./ChatBubbles";
import { NodeTaskCard } from "./NodeTaskCard";
import { activeNodeConversationEvents, activeNodeExecutions, executionIdForMessage, versionIndexForEdit, versionsForEdit } from "../../services/conversationBranch";
import { isNodeWorking } from "../../lib/nodeWorking";
import { ToolCallCard } from "../ToolCallCard";
import { ThinkingCard } from "../ThinkingCard";
import { ExecutionTiming } from "../ExecutionTiming";
import { ExecutionTranscript } from "../ExecutionTranscript";
import { planningTranscriptCache, activePlannerOutput } from "../PlanningActivity";
import { plannerUserTurns } from "../../services/plannerUserTurns";
import { PlanningActivity } from "../PlanningActivity";
import { statusText, phaseText } from "../graph/TaskNode";
import { useSmoothStreamText } from "../../hooks/useSmoothStreamText";
import { useAnimatedNodes } from "../../hooks/useAnimatedNodes";
import { useWorkbenchResizer } from "../../hooks/useWorkbenchResizer";
import { PublicationCompletedCard } from "../PublicationCompletedCard";
import { EnvironmentResult } from "../EnvironmentResult";

interface GraphWorkbenchProps {
  state: Snapshot;
  routeType: PlanRouteType;
  selected: string;
  setSelected: (name: string) => void;
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
      const containerRect = container.getBoundingClientRect();
      const paneView = container.closest(".initial-query-view") || container.parentElement;
      const composerEl = paneView?.querySelector(".pane-bottom-chat") as HTMLElement | null;
      const composerRect = composerEl ? composerEl.getBoundingClientRect() : null;
      const visibleBottom = composerRect ? composerRect.top - 12 : containerRect.bottom - 12;

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

      if (container && scrollDelta !== 0 && !interruptedRef.current) {
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
      <div className="workspace-details-summary">
        <div className="workspace-details-summary-left">
          {showWorking && (
            <div className="working-indicator" role="status" aria-live="polite">
              <span className="working-indicator-dot" />
              Working…
            </div>
          )}
        </div>
        <button
          type="button"
          className="workspace-details-trigger"
          onClick={handleToggle}
          aria-expanded={isOpen}
        >
          <FolderGit2 size={12} />
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
  routeType,
  selected,
  setSelected,
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
  const [editingTaskNode, setEditingTaskNode] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  useEffect(() => {
    setAttemptId("");
    setEditingTaskNode("");
    setTaskDraft("");
    onCancelEditMessage?.();
  }, [selected, state.runId]);
  const selectedNode = state.graph.nodes.find((item) => item.name === selected);
  const selectedState = selectedNode ? state.nodes[selectedNode.name] : undefined;
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
    const localMessages = effectiveMessages.filter((msg) => msg.role === "user" && msg.node === selectedNode.name && msg.runId === state.runId);
    const latestEdit = [...state.events].reverse().find((event) =>
      event.type === "conversation_edited" && event.target === selectedNode.name && event.nodes?.includes(selectedNode.name));
    const local = latestEdit?.old_instruction
      ? (() => {
          const index = localMessages.findIndex((msg) =>
            msg.text.replace(/^\[@[^\]]+\]\s*/, "").trim() === latestEdit.old_instruction);
          return index >= 0 ? localMessages.slice(0, index) : localMessages;
        })()
      : localMessages;
    const localRemaining = [...local];
    const recorded = activeNodeConversationEvents(state, selectedNode.name).filter((event) =>
      ((event.type === "invalidated" && event.human) || (event.type === "conversation_edited" && !event.first_turn)) && event.target === selectedNode.name && !!event.instruction ||
      ((event.type === "steered" || event.type === "node_messaged") && event.node === selectedNode.name)
    ).reverse().filter((event) => {
      // Match each optimistic turn to at most one durable event, from newest
      // to oldest, so repeated identical messages do not disappear.
      const idx = localRemaining.findIndex((msg) => msg.text.replace(/^\[@[^\]]+\]\s*/, "") === event.instruction);
      if (idx < 0) return true;
      localRemaining.splice(idx, 1);
      return false;
    }).reverse().map((event): ChatMessage => ({
      id: `event-${event.sequence}`, parentId: null, role: "user",
      text: event.instruction || "", images: event.images, node: selectedNode.name, runId: state.runId,
      executionId: executionIdForMessage(state, event),
      versions: event.type === "conversation_edited" ? versionsForEdit(state, event) : undefined,
      currentVersionIndex: event.type === "conversation_edited" ? versionIndexForEdit(state, event) : undefined,
      delivery: event.type === "node_messaged" || event.type === "steered" ? event.type : undefined,
    }));
    return [...recorded, ...localRemaining];
  }, [selectedNode?.name, effectiveMessages, state.runId, state.events]);
  const attempts = useMemo(() => selectedNode
    ? [...activeNodeExecutions(state, selectedNode.name),
       ...(state.mergers ?? []).filter((item) => item.node === `merge:${selectedNode.name}`)]
        .sort((a, b) => a.startedAt - b.startedAt)
    : [], [selectedNode?.name, state.executions, state.supersededExecutionIds, state.mergers]);
  const execution: Execution | undefined = attempts.find((item) => item.id === attemptId) ?? attempts[attempts.length - 1];
  const nodeTurns = useMemo(() => {
    if (!selectedNode) return [];
    const turns: Array<{
      id: string;
      isInitial: boolean;
      taskText?: string;
      userMessage?: ChatMessage;
      executions: Execution[];
    }> = [];

    turns.push({
      id: `turn-0-${selectedNode.name}`,
      isInitial: true,
      taskText: selectedNode.task,
      executions: attempts.length > 0 ? [attempts[0]] : [],
    });

    let execIndex = 1;
    nodeMessages.forEach((msg) => {
      const execs = msg.delivery ? [] : execIndex < attempts.length ? [attempts[execIndex]] : [];
      if (!msg.delivery) execIndex++;
      turns.push({
        id: msg.id,
        isInitial: false,
        userMessage: { ...msg, executionId: execs[0]?.id ?? msg.executionId },
        executions: execs,
      });
    });

    if (attempts.length > 1) {
      const assigned = new Set(turns.flatMap((t) => t.executions.map((e) => e.id)));
      const unassigned = attempts.filter((e) => !assigned.has(e.id));
      if (unassigned.length > 0) {
        turns[0].executions.push(...unassigned);
        turns[0].executions.sort((a, b) => a.startedAt - b.startedAt);
      }
    }

    return turns;
  }, [selectedNode?.name, selectedNode?.task, attempts, nodeMessages]);

  // A steer adds a user turn to the running execution without creating a new
  // execution panel. Keep its status after that turn, not above it in the old panel.
  const nodeWorkingAfterMessage = nodeTurns.length > 1 && nodeTurns[nodeTurns.length - 1].executions.length === 0;
  const isSelectedNodeWorking = isNodeWorking(selectedState?.status, execution, pendingRequest,
    nodeWorkingAfterMessage ? nodeTurns[nodeTurns.length - 1].userMessage : undefined);
  const conversationViewKey = `${state.runId}:${routeType}:${selected || "planner"}:${execution?.id || ""}`;
  const smoothPlannerText = useSmoothStreamText(plannerStream.plannerText, isPlanning);
  // Live SSE is ephemeral. After reload or run selection, replay the durable
  // planning JSONL associated with the selected run, never a previous run's stream.
  const showLivePlanner = !recoveredPlanningId && !failedPlanning &&
    (isPlanning ||
      (plannerStream.runId === state.runId && !!state.planningId));
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
  const savedPlannerOutput = planningTranscriptCache.get(savedPlannerKey)?.text ?? "";
  const persistedUserTurns = useMemo(() => {
    if (effectiveMessages.length <= 1) return [];
    const turns = plannerUserTurns(activePlannerOutput(savedPlannerOutput, plannerEdits));
    if (turns[0] === effectiveMessages[0]?.text.trim()) turns.shift();
    return turns;
  }, [savedPlannerOutput, plannerEdits, effectiveMessages.length, effectiveMessages[0]?.text]);
  const remainingPersistedTurns = new Map<string, number>();
  for (const text of persistedUserTurns) {
    remainingPersistedTurns.set(text, (remainingPersistedTurns.get(text) ?? 0) + 1);
  }
  const effectiveRouteType = useMemo(() => {
    if (routeType !== "undecided") return routeType;
    if (state.planType) return state.planType;
    return "undecided";
  }, [routeType, state.planType]);
  const useSavedPlanner = savedPlannerIds.length > 0 &&
    (!isPlanning || !showLivePlanner || readySavedPlannerKey === savedPlannerKey);
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
  const resumeAutoScrollFrameRef = useRef<number | null>(null);
  const resetChatScrollFrameRef = useRef<number | null>(null);
  const revealChatFrameRef = useRef<number | null>(null);
  const [readyConversationKey, setReadyConversationKey] = useState("");
  const activeConversationViewRef = useRef(conversationViewKey);
  const conversationGenerationRef = useRef(0);
  const isScrollingToBottomRef = useRef(false);
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
  const currentRunKey = state.runId || state.graph.originalGoal || "initial";
  const graphRunRef = useRef(currentRunKey);
  const [readyGraphRunKey, setReadyGraphRunKey] = useState("");
  const isGraphMountedForRun = readyGraphRunKey === currentRunKey;

  if (activeConversationViewRef.current !== conversationViewKey) {
    activeConversationViewRef.current = conversationViewKey;
    conversationGenerationRef.current += 1;
    isUserScrolledUpRef.current = false;
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
      setReadyGraphRunKey(targetKey);
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

    // When near bottom, definitely lock to bottom state (prevent elastic bounce from locking scrolled-up)
    if (distanceFromBottom <= 20) {
      isScrollingToBottomRef.current = false;
      isUserScrolledUpRef.current = false;
      setScrollBottomVisible(false);
      return;
    }

    if (isScrollingToBottomRef.current) {
      if (isScrollingUp) {
        isScrollingToBottomRef.current = false;
        isUserScrolledUpRef.current = true;
        setScrollBottomVisible(showLatest);
      }
      return;
    }

    if (isScrollingUp) {
      isUserScrolledUpRef.current = true;
      setScrollBottomVisible(showLatest);
      return;
    }

    // A resize or a newly mounted transcript can change the distance without
    // any user scroll. Do not mistake that for an intentional scroll-up.
    setScrollBottomVisible(isUserScrolledUpRef.current && showLatest);
  }, [setScrollBottomVisible]);

  const scrollToBottom = useCallback(() => {
    isUserScrolledUpRef.current = false;
    isScrollingToBottomRef.current = true;
    setScrollBottomVisible(false);
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTo({
        top: chatScrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [setScrollBottomVisible]);

  const handleSendMessageWithScroll = useCallback((val: string, options?: PromptBoxSubmitOptions) => {
    isUserScrolledUpRef.current = false;
    isScrollingToBottomRef.current = true;
    setScrollBottomVisible(false);
    return onSendMessage(val, options);
  }, [onSendMessage, setScrollBottomVisible]);

  // Listen to wheel and touch gestures on chat scroll container to immediately lock auto-scroll upon upward scrolling
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (e.deltaY < -0.5 && distanceFromBottom > 20) {
        isScrollingToBottomRef.current = false;
        isUserScrolledUpRef.current = true;
      }
    };

    let lastTouchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches[0]) lastTouchY = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches[0]) {
        const curY = e.touches[0].clientY;
        const delta = curY - lastTouchY;
        lastTouchY = curY;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (delta > 1 && distanceFromBottom > 20) {
          isScrollingToBottomRef.current = false;
          isUserScrolledUpRef.current = true;
        }
      }
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });

    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [conversationViewKey]);

  const handleExpandableContentChange = useCallback((expanded?: boolean, card?: HTMLElement) => {
    suppressAutoScrollRef.current = true;
    isUserScrolledUpRef.current = true;
    expandedCardObserverRef.current?.disconnect();
    if (expandedCardTimerRef.current !== null) clearTimeout(expandedCardTimerRef.current);

    // Follow the card during its opening animation, without jumping past the
    // header when the expanded content is taller than the viewport.
    if (expanded && card) {
      const reveal = () => {
        const scroll = chatScrollRef.current;
        if (!scroll || !scroll.contains(card)) return;
        const viewport = scroll.getBoundingClientRect();
        const bounds = card.getBoundingClientRect();
        const available = viewport.height - 24;
        const delta = bounds.height > available
          ? bounds.top - viewport.top - 12
          : bounds.bottom - viewport.bottom + 12;
        if (delta > 0) scroll.scrollTop += delta;
      };
      const observer = new ResizeObserver(reveal);
      observer.observe(card);
      expandedCardObserverRef.current = observer;
      expandedCardTimerRef.current = setTimeout(() => {
        reveal();
        observer.disconnect();
        if (expandedCardObserverRef.current === observer) expandedCardObserverRef.current = null;
        expandedCardTimerRef.current = null;
      }, 400);
    }

    if (resumeAutoScrollFrameRef.current !== null) cancelAnimationFrame(resumeAutoScrollFrameRef.current);
    resumeAutoScrollFrameRef.current = requestAnimationFrame(() => {
      resumeAutoScrollFrameRef.current = requestAnimationFrame(() => {
        resumeAutoScrollFrameRef.current = null;
        suppressAutoScrollRef.current = false;
        handleChatScroll();
      });
    });
  }, [handleChatScroll]);

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
    if (resumeAutoScrollFrameRef.current !== null) {
      cancelAnimationFrame(resumeAutoScrollFrameRef.current);
    }
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

      if (suppressAutoScrollRef.current || isPreparingConversationRef.current) return;

      // Auto-scroll to bottom ONLY when content actually grows, unless user scrolled up or smooth-scrolling to bottom
      if (heightGrew && !isUserScrolledUpRef.current && !isScrollingToBottomRef.current) {
        el.scrollTop = currentScrollHeight;
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
    if (!isUserScrolledUpRef.current && !isPreparingConversationRef.current && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
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

  const serialTurns = useMemo(() => {
    if (routeType !== "serial" || !serialNode) return [];
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
  const serialWorkingAfterMessage = serialTurns.length > 1 && serialTurns[serialTurns.length - 1].executions.length === 0;
  const isSerialWorking = isNodeWorking(serialNodeState?.status, serialExecution, pendingRequest,
    serialWorkingAfterMessage ? serialTurns[serialTurns.length - 1].userMessage : undefined);
  const isMainViewWorking = routeType === "serial" ? (isPlanning || isSerialWorking) : isPlanning;
  const completed = Object.values(state.nodes).filter((n) => n.status === "done").length;
  // A poll can return the old draft while the Planner is revising it.
  const graphPhase = isPlanning && !state.approved ? "planning" : state.phase;
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
    if (graphRunRef.current === currentRunKey) return;
    graphRunRef.current = currentRunKey;
    graphFlowRef.current = null;
    if (graphFitFrameRef.current !== null) cancelAnimationFrame(graphFitFrameRef.current);
    graphFitFrameRef.current = null;
    setReadyGraphRunKey("");
    prevNodesCountRef.current = nodes.length;
    prevEdgesCountRef.current = edges.length;
  }, [currentRunKey, nodes.length, edges.length]);

  useEffect(() => {
    if (nodes.length > 0 && nodes.length !== prevNodesCountRef.current) {
      prevNodesCountRef.current = nodes.length;
      if (graphFlowRef.current && isPlanning) {
        void graphFlowRef.current.fitView({ padding: 0.24, duration: 400, minZoom: 0.3, maxZoom: 1.5 });
      }
    }
  }, [nodes.length, isPlanning]);

  useEffect(() => {
    if (edges.length > 0 && edges.length !== prevEdgesCountRef.current) {
      prevEdgesCountRef.current = edges.length;
      if (graphFlowRef.current && isPlanning) {
        void graphFlowRef.current.fitView({ padding: 0.24, duration: 450, minZoom: 0.3, maxZoom: 1.5 });
      }
    }
  }, [edges.length, isPlanning]);

  const prevMsgCountRef = useRef(effectiveMessages.length);
  useEffect(() => {
    if (effectiveMessages.length > prevMsgCountRef.current) {
      prevMsgCountRef.current = effectiveMessages.length;
      if (!isUserScrolledUpRef.current && chatScrollRef.current) {
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
        const isGraphNodeView = Boolean(selectedNode && routeType === "graph");
        if (el && !isUserScrolledUpRef.current && !isGraphNodeView) {
          el.scrollTop = el.scrollHeight;
          lastScrollTopRef.current = el.scrollTop;
        }
        isPreparingConversationRef.current = false;
        if (isGraphNodeView && el) {
          const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
          setScrollBottomVisible(distanceFromBottom > el.clientHeight / 2);
        } else {
          setScrollBottomVisible(false);
        }
        setReadyConversationKey(key);
        onConversationReady?.();
      });
    });
  }, [conversationViewKey, selectedNode, routeType, setScrollBottomVisible, onConversationReady]);
  useLayoutEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;

    const isNewView = prevViewKeyRef.current !== conversationViewKey;
    prevViewKeyRef.current = conversationViewKey;

    if (isNewView) {
      suppressAutoScrollRef.current = false;
      isPreparingConversationRef.current = true;
      isScrollingToBottomRef.current = false;

      const isGraphNodeView = Boolean(selectedNode && routeType === "graph");
      if (isGraphNodeView) {
        // 进入 Node Agent 视图时，默认展示顶部节点任务目标 (Task)，避免 1s 后日志加载造成突兀跳跃或重排
        isUserScrolledUpRef.current = true;
        el.scrollTop = 0;
        lastScrollTopRef.current = 0;
        prevScrollHeightRef.current = el.scrollHeight;
        setScrollBottomVisible(false);
      } else {
        // 进入 Planner 或 Serial 线性对话时直接聚焦到底部最新内容
        isUserScrolledUpRef.current = false;
        el.scrollTop = el.scrollHeight;
        lastScrollTopRef.current = el.scrollTop;
        prevScrollHeightRef.current = el.scrollHeight;
        setScrollBottomVisible(false);

        if (resetChatScrollFrameRef.current !== null) {
          cancelAnimationFrame(resetChatScrollFrameRef.current);
        }
        resetChatScrollFrameRef.current = requestAnimationFrame(() => {
          resetChatScrollFrameRef.current = null;
          if (chatScrollRef.current && !isUserScrolledUpRef.current) {
            chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
            lastScrollTopRef.current = chatScrollRef.current.scrollTop;
          }
        });
      }
    }

    // If no execution or planning output needed to trigger onReady, reveal after layout settle
    const needsExecutionReady = selectedNode && routeType === "graph"
      ? Boolean(execution)
      : (routeType === "serial"
          ? Boolean(serialExecutions.length)
          : (savedPlannerIds.length > 0 && useSavedPlanner && effectiveMessages.length <= 1));

    if (readyConversationKey !== conversationViewKey && !needsExecutionReady) {
      revealConversation();
    }
  }, [
    conversationViewKey,
    readyConversationKey,
    selectedNode,
    routeType,
    execution,
    savedPlannerIds.length,
    useSavedPlanner,
    effectiveMessages.length,
    serialExecutions.length,
    revealConversation,
    setScrollBottomVisible,
  ]);

  return (
    <section
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
                <h2>{selectedNode.name}</h2>
              </div>
              <span className={`status ${selectedState?.status ?? "waiting"}`}>
                {statusText[selectedState?.status ?? "waiting"]}
              </span>
              {routeType === "graph" && (
                <button
                  type="button"
                  className="back-to-query-btn"
                  onClick={() => setSelected("")}
                >
                  <ArrowLeft size={16} />
                </button>
              )}
            </div>

            <div
              className="initial-query-scroll"
              ref={chatScrollRef}
              onScroll={handleChatScroll}
            >
              <div className="chat-messages-stream">
                {nodeTurns.map((turn) => (
                  <React.Fragment key={turn.id}>
                    {turn.isInitial ? (
                      <NodeTaskCard
                        nodeName={selectedNode.name}
                        taskText={turn.taskText || selectedNode.task}
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
                        onEdit={(!state.approved || selectedState?.status === "done" || selectedState?.status === "failed" || selectedState?.status === "running") ? () => {
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
                    ) : turn.userMessage ? (
                      <div key={turn.userMessage.id} className="chat-message-row user">
                        <EditableUserBubble
                          text={turn.userMessage.text.replace(/^\[@[^\]]+\]\s*/, "")}
                          images={turn.userMessage.images}
                          files={turn.userMessage.files}
                          editing={editingMessage?.id === turn.userMessage.id}
                          draft={editPrefillText ?? ""}
                          onDraftChange={onEditPrefillTextChange ?? (() => {})}
                          onEdit={onEditMessage && turn.userMessage.delivery !== "node_messaged" ? () => { setEditingTaskNode(""); onEditMessage(turn.userMessage!); } : undefined}
                          onCancel={() => onCancelEditMessage?.()}
                          onSend={(value) => onEditMessageSubmit ? onEditMessageSubmit(turn.userMessage!, value) : onSendMessage(value)}
                          disabled={locked}
                          versions={turn.userMessage.versions}
                          currentVersionIndex={turn.userMessage.currentVersionIndex}
                          onSwitchVersion={(idx) => onSwitchMessageVersion?.(turn.userMessage!, idx)}
                        />
                      </div>
                    ) : null}

                    {turn.executions.map((exec) => {
                      const isLatestAttempt = exec.id === execution?.id;

                      return (
                        <motion.div
                          key={exec.id}
                          className="serial-execution-panel"
                          initial={false}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.3 }}
                        >
                          <div className="session-label">
                            <strong>Pi Session</strong>
                            <span className={`status-badge ${exec.status}`}>
                              {statusText[exec.status as Status] ?? exec.status}
                            </span>
                            <ExecutionTiming execution={exec} />
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", marginTop: 4 }}>
                            <ExecutionTranscript
                              key={exec.id}
                              runId={state.runId}
                              execution={exec}
                              onUserResize={handleExpandableContentChange}
                              onInitialOutputReady={isLatestAttempt ? revealConversation : undefined}
                            />
                          </div>
                        </motion.div>
                      );
                    })}
                  </React.Fragment>
                ))}

                {execution && (
                  <WorkspaceDetailsPanel
                    key={`${state.runId}:${selectedNode.name}`}
                    showWorking={isSelectedNodeWorking}
                    scrollContainerRef={chatScrollRef}
                    onBeforeToggle={handleWorkspaceDetailsBeforeToggle}
                    onAfterToggle={handleWorkspaceDetailsAfterToggle}
                  >
                    <p>Worktree: {execution.worktree}</p>
                    <p>Session ID: {execution.sessionId}</p>
                    <p>Commit Before: {execution.before}</p>
                    <p>Commit After: {execution.after ?? "pending"}</p>
                    <p className="details-tip">{t("Graph Execution Instance 使用用户仓库旁的独立 worktree；Serial Execution Instance 直接使用用户目录。")}</p>
                  </WorkspaceDetailsPanel>
                )}

                {isSelectedNodeWorking && !execution && (
                  <div className="working-indicator" role="status" aria-live="polite">
                    <span className="working-indicator-dot" />
                    Working…
                  </div>
                )}

                {selectedState?.error && (
                  <div className="node-error" style={{ marginTop: 12 }}>
                    {localizeError(selectedState.error)}
                    {selectedState.status === "blocked" && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={locked || active}
                        onClick={() => onControl("resolve")}
                      >
                        Use resolved workspace
                      </button>
                    )}
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
              initial={{ opacity: 0, y: 16 }}
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
                layoutId="conversation-composer"
                repository={config?.repository}
                onSubmit={handleSendMessageWithScroll}
                placeholder={
                  !state.approved
                    ? t("图规划审批启动后，可在此向选定节点发送介入指令…")
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
                  !state.approved
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
            >
              <div className="chat-messages-stream">
                {routeType === "serial" ? (
                  <div className="serial-turns-container" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {serialTurns.map((turn) => (
                      <React.Fragment key={turn.id}>
                        {turn.userMessage && (
                          <motion.div
                            className="chat-message-row user"
                            initial={isPlanning && turn.isInitial ? { opacity: 0, y: 16, scale: 0.98 } : false}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
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

                        {turn.isInitial && (
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
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ duration: 0.3 }}
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
                      </React.Fragment>
                    ))}

                    {serialExecution && (
                      <WorkspaceDetailsPanel
                        key={`${state.runId}:serial`}
                        showWorking={isSerialWorking}
                        scrollContainerRef={chatScrollRef}
                        onBeforeToggle={handleWorkspaceDetailsBeforeToggle}
                        onAfterToggle={handleWorkspaceDetailsAfterToggle}
                      >
                        <p>{t("工作目录: ")}{serialExecution.worktree}</p>
                        <p>{t("会话实例: ")}{serialExecution.sessionId}</p>
                        {(() => {
                          if (serialExecution.pid) return <p>{t("进程 PID: ")}{serialExecution.pid}</p>;
                          const pidMatch = serialExecution.output.match(/"type":"grapher_process_started"[^}]*"pid":(\d+)/) ||
                                           serialExecution.output.match(/"pid":(\d+)/);
                          return pidMatch ? <p>{t("沙箱进程 PID: ")}{pidMatch[1]}</p> : null;
                        })()}
                        <p>Commit Before: {serialExecution.before || "HEAD"}</p>
                        <p>Commit After: {serialExecution.after ?? "pending"}</p>
                        <p className="details-tip">{t("单节点串行任务直接在本地目录工作，无需额外 worktree。")}</p>
                      </WorkspaceDetailsPanel>
                    )}

                    {isSerialWorking && !serialExecution && (
                      <div className="working-indicator" role="status" aria-live="polite">
                        <span className="working-indicator-dot" />
                        Working…
                      </div>
                    )}
                    {serialNodeState?.error && (
                      <div className="node-error" style={{ marginTop: 12 }}>
                        {localizeError(serialNodeState.error)}
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {effectiveMessages.length > 0 && (
                      <motion.div
                        key={effectiveMessages[0].id}
                        className={`chat-message-row ${effectiveMessages[0].role}`}
                        initial={false}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                      >
                        {effectiveMessages[0].role === "user" ? (
                          <EditableUserBubble
                            text={effectiveMessages[0].text.trim()}
                            images={effectiveMessages[0].images}
                            files={effectiveMessages[0].files}
                            editing={editingMessage?.id === effectiveMessages[0].id}
                            draft={editPrefillText ?? ""}
                            onDraftChange={onEditPrefillTextChange ?? (() => {})}
                            onEdit={onEditMessage ? () => onEditMessage(effectiveMessages[0]) : undefined}
                            onCancel={() => onCancelEditMessage?.()}
                            onSend={(value) => onEditMessageSubmit ? onEditMessageSubmit(effectiveMessages[0], value) : onSendMessage(value)}
                            disabled={locked && !isPlanning}
                            versions={effectiveMessages[0].versions}
                            currentVersionIndex={effectiveMessages[0].currentVersionIndex}
                            onSwitchVersion={(idx) => onSwitchMessageVersion?.(effectiveMessages[0], idx)}
                          />
                        ) : (
                          <div className={`chat-bubble-${effectiveMessages[0].role} chat-message-${effectiveMessages[0].role}`}>
                            <MarkdownRenderer content={effectiveMessages[0].text} />
                          </div>
                        )}
                      </motion.div>
                    )}

                    {/* 任务路线决策结果或评估中加载状态 */}
                    {((isPlanning && effectiveRouteType === "undecided") || effectiveRouteType !== "undecided") && (
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
                          planningIds={savedPlannerIds}
                          showUserTurns={!isPlanning || !!recoveredPlanningId}
                          skipFirstUser={effectiveMessages.length > 0}
                          onReady={() => {
                            setReadySavedPlannerKey(savedPlannerKey);
                            revealConversation();
                          }}
                          onUserResize={handleExpandableContentChange}
                          edits={plannerEdits}
                          onEditUser={onEditMessageSubmit ? (text, replacement) =>
                            onEditMessageSubmit({ id: `planner-history-${text}`, role: "user", parentId: null,
                              text, runId: state.runId }, replacement) : undefined}
                        />
                      </div>
                    )}

                    {/* 保留当前对话中的跟进消息；实时流已有同一消息时不重复渲染。 */}
                    {effectiveMessages.slice(1).filter((msg) => {
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
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {plannerStream.items.map((item: TranscriptItem, idx: number) => {
                          const isLast = idx === plannerStream.items.length - 1;
                          if (item.role === "user") {
                            return (
                              <motion.div
                                key={item.id}
                                className="chat-message-row user"
                                initial={false}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                              >
                                <EditableUserBubble
                                  text={item.content || ""}
                                  editing={editingMessage?.id === item.id}
                                  draft={editPrefillText ?? ""}
                                  onDraftChange={onEditPrefillTextChange ?? (() => {})}
                                  onEdit={onEditMessage ? () => onEditMessage({ id: item.id, parentId: null, role: "user", text: item.content || "" }) : undefined}
                                  onCancel={() => onCancelEditMessage?.()}
                                  onSend={(value) => onEditMessageSubmit ? onEditMessageSubmit({ id: item.id, parentId: null, role: "user", text: item.content || "" }, value) : onSendMessage(value)}
                                  disabled={locked && !isPlanning}
                                />
                              </motion.div>
                            );
                          }
                          if (item.type === "tool_call") {
                            return (
                              <ToolCallCard
                                key={item.id}
                                item={item}
                                onExpandedChange={handleExpandableContentChange}
                              />
                            );
                          }
                          if (item.type === "thinking") {
                            return (
                              <ThinkingCard
                                key={item.id}
                                item={item}
                                isStreaming={isPlanning && item.status === "running"}
                                title={t("思考过程")}
                                defaultExpanded={true}
                                onExpandedChange={handleExpandableContentChange}
                              />
                            );
                          }
                          if (item.type === "text") {
                            return (
                              <motion.div
                                key={item.id}
                                className="chat-message-row assistant"
                                initial={false}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                              >
                                <div className="chat-bubble-assistant chat-message-assistant">
                                  <StreamingAssistantBubble
                                    content={item.content || ""}
                                    isStreaming={isPlanning && isLast && item.status === "running"}
                                  />
                                </div>
                              </motion.div>
                            );
                          }
                          return null;
                        })}
                      </div>
                    ) : (
                      renderLivePlanner && (plannerStream.plannerThinking || smoothPlannerText) && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {plannerStream.plannerThinking && (
                            <ThinkingCard
                              content={plannerStream.plannerThinking}
                              isStreaming={isPlanning && plannerStream.plannerThinkingActive}
                              title={t("思考过程")}
                              defaultExpanded={true}
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
                {isMainViewWorking && !(routeType === "serial" && serialExecutions.length > 0 && isSerialWorking) && (
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
                    <span className={`phase-tag ${state.phase}`}>{phaseText[state.phase] ?? t("草稿")}</span>
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
                            onClick={() => setSelected(node.name)}
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
                layoutId="conversation-composer"
                repository={config?.repository}
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
      <AnimatePresence initial={false}>
        {showGraphPane && (
          <>
            <motion.div
              key="workbench-resizer"
              className={`workbench-resizer ${isResizing ? "active" : ""}`}
              initial={false}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0 }}
              onMouseDown={handleStartResize}
              onDoubleClick={handleResetResizer}
              title={t("按住左右拖动调节宽度，双击恢复默认")}
            >
              <div className="resizer-handle" />
            </motion.div>

            <motion.div
              key="graph-pane"
              className="graph-pane"
              initial={false}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0 }}
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
                {/* 自定义高清晰度箭头 Marker 定义，解决被 handle 圆点遮挡问题 */}
                <svg style={{ position: "absolute", width: 0, height: 0, pointerEvents: "none" }} aria-hidden="true">
                  <defs>
                    <marker
                      id="workflow-arrow-default"
                      viewBox="0 0 12 12"
                      refX="10"
                      refY="6"
                      markerWidth="9"
                      markerHeight="9"
                      orient="auto"
                    >
                      <path d="M 2 2.5 L 10 6 L 2 9.5 Z" fill={tokens.graphEdgeDefault || "#94A3B8"} />
                    </marker>
                    <marker
                      id="workflow-arrow-feedback"
                      viewBox="0 0 12 12"
                      refX="10"
                      refY="6"
                      markerWidth="9"
                      markerHeight="9"
                      orient="auto"
                    >
                      <path d="M 2 2.5 L 10 6 L 2 9.5 Z" fill={tokens.graphEdgeFeedback || "#8B5CF6"} />
                    </marker>
                  </defs>
                </svg>

                <ReactFlow
                  key={currentRunKey}
                  fitView
                  fitViewOptions={{ padding: 0.24, minZoom: 0.3, maxZoom: 1.6 }}
                  onInit={(instance) => centerGraph(instance, currentRunKey)}
                  style={{
                    opacity: isGraphMountedForRun ? 1 : 0,
                    pointerEvents: isGraphMountedForRun ? "auto" : "none",
                  }}
                  nodes={animatedNodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  onNodeClick={(_, node) => {
                    if (node.id.startsWith("merger:")) {
                      const target = node.id.slice(7);
                      setSelected(target);
                      setAttemptId((state.mergers ?? []).filter((item) => item.node === `merge:${target}`).at(-1)?.id ?? "");
                    } else {
                      setSelected(node.id);
                      setAttemptId("");
                    }
                  }}
                  onPaneClick={() => {
                    setSelected("");
                  }}
                  minZoom={0.3}
                  maxZoom={1.6}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background color={tokens.graphGridDot} gap={20} size={1} />
                  <Controls showInteractive={false} />
                </ReactFlow>

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
                      {graphPhase === "planning" ? t("规划中")
                        : graphPhase === "running" ? t("确定性运行时正在推进")
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
                            onClick={() => onControl(state.paused ? "resume" : "pause")}
                          >
                            {state.paused ? <Play size={13} /> : <Pause size={13} />}
                            {state.paused ? t("继续") : t("暂停")}
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
