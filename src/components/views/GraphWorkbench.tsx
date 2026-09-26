import React, { useRef, useState, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { Background, Controls, ReactFlow, type ReactFlowInstance } from "@xyflow/react";
import {
  Code2, ArrowLeft, Terminal, FolderGit2, GitBranch, RotateCcw,
  Workflow, Play, Pause, Compass, ArrowDown, Clock, Loader2
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  Snapshot, PlanRouteType, RepositoryInfo, Config,
  Graph, Execution, Status, PlanningSummary, emptyGraph, TranscriptItem,
  ChatMessage, PlanMode
} from "../../types";
import { PromptBox, type PromptBoxSubmitOptions } from "../ui/chatgpt-prompt-input";
import type { ConfirmModalState } from "../modals/ConfirmModal";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { EditableUserBubble, StreamingAssistantBubble } from "./ChatBubbles";
import { ToolCallCard } from "../ToolCallCard";
import { ThinkingCard } from "../ThinkingCard";
import { ExecutionTiming } from "../ExecutionTiming";
import { ExecutionTranscript } from "../ExecutionTranscript";
import { PlanningSummaryCard } from "../PlanningSummaryCard";
import { PlanningActivity } from "../PlanningActivity";
import { statusText, phaseText } from "../graph/TaskNode";
import { useSmoothStreamText } from "../../hooks/useSmoothStreamText";
import { useAnimatedNodes } from "../../hooks/useAnimatedNodes";
import { useWorkbenchResizer } from "../../hooks/useWorkbenchResizer";

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
  isWorking?: boolean;
  onInterrupt?: () => void;
  isPlanning: boolean;
  plannerStream: any;
  recoveredPlanningId?: string;
  onSendMessage: (val: string, options?: PromptBoxSubmitOptions) => boolean | void | Promise<boolean>;
  onRequestConfirmation: (config: ConfirmModalState) => void;
  followUpQueue?: Array<{ id: string; text: string; node?: string; timestamp: number }>;
  onCancelFollowUp?: (id: string) => void;
  onControl: (action: string, extra?: Record<string, unknown>) => void;
  onSave: (graph: Graph) => void;
  onOpenEditor: () => void;
  onOpenApproval: () => void;
  onPickRepository: () => void;
  onDetectRepository: () => void;
  repoInfo: RepositoryInfo | null;
  config: Config;
  goal: string;
  active: boolean;
  locked: boolean;
  publishing: boolean;
  publicationFailed: boolean;
  nodes: any[];
  edges: any[];
  nodeTypes: any;
  edgeTypes: any;
  tokens: any;
  failedPlanning?: PlanningSummary | null;
}

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
  isWorking,
  onInterrupt,
  isPlanning,
  plannerStream,
  onSendMessage,
  onRequestConfirmation,
  followUpQueue,
  onCancelFollowUp,
  onControl,
  onSave,
  onOpenEditor,
  onOpenApproval,
  onPickRepository,
  onDetectRepository,
  repoInfo,
  config,
  goal,
  active,
  locked,
  publishing,
  publicationFailed,
  nodes,
  edges,
  nodeTypes,
  edgeTypes,
  tokens,
}) => {
  const [attemptId, setAttemptId] = useState("");
  const [editingTaskNode, setEditingTaskNode] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  useEffect(() => {
    setEditingTaskNode("");
    onCancelEditMessage?.();
  }, [selected, state.runId]);
  const selectedNode = state.graph.nodes.find((item) => item.name === selected);
  const selectedState = selectedNode ? state.nodes[selectedNode.name] : undefined;
  const nodeMessages = useMemo(() => {
    if (!selectedNode) return [];
    const local = effectiveMessages.filter((msg) => msg.role === "user" && msg.node === selectedNode.name && msg.runId === state.runId);
    const recorded = state.events.filter((event) => ((event.type === "invalidated" && event.human && event.target === selectedNode.name) ||
      (event.type === "steered" && event.node === selectedNode.name)) &&
      !local.some((msg) => msg.text.replace(/^\[@[^\]]+\]\s*/, "") === event.instruction)
    ).map((event): ChatMessage => ({
      id: `event-${event.sequence}`, parentId: null, role: "user",
      text: event.instruction || "", node: selectedNode.name, runId: state.runId,
    }));
    return [...recorded, ...local];
  }, [selectedNode?.name, effectiveMessages, state.runId, state.events]);
  const attempts = useMemo(() => selectedNode
    ? [...state.executions.filter((item) => item.node === selectedNode.name),
       ...(state.mergers ?? []).filter((item) => item.node === `merge:${selectedNode.name}`)]
        .sort((a, b) => a.startedAt - b.startedAt)
    : [], [selectedNode?.name, state.executions, state.mergers]);
  const execution: Execution | undefined = attempts.find((item) => item.id === attemptId) ?? attempts[attempts.length - 1];
  const isSelectedNodeWorking = Boolean(
    execution
      ? execution.status === "running" && execution.completedAt == null
      : selectedState?.status === "running"
  );

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

    nodeMessages.forEach((msg, idx) => {
      const execIndex = idx + 1;
      const execs = execIndex < attempts.length ? [attempts[execIndex]] : [];
      turns.push({
        id: msg.id,
        isInitial: false,
        userMessage: msg,
        executions: execs,
      });
    });

    if (attempts.length > nodeMessages.length + 1) {
      const assigned = new Set(turns.flatMap((t) => t.executions.map((e) => e.id)));
      const unassigned = attempts.filter((e) => !assigned.has(e.id));
      if (unassigned.length > 0) {
        turns[0].executions.push(...unassigned);
        turns[0].executions.sort((a, b) => a.startedAt - b.startedAt);
      }
    }

    return turns;
  }, [selectedNode?.name, selectedNode?.task, attempts, nodeMessages]);

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
    if (routeType !== "graph" || (isPlanning && !recoveredPlanningId && !plannerStream.runId && !plannerStream.isContinuation)) return [];
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
  const savedPlannerKey = savedPlannerIds.join(":");
  const [readySavedPlannerKey, setReadySavedPlannerKey] = useState("");
  const useSavedPlanner = savedPlannerIds.length > 0 &&
    (!isPlanning || !showLivePlanner || readySavedPlannerKey === savedPlannerKey);
  const renderLivePlanner = showLivePlanner && (isPlanning || !useSavedPlanner);
  const { workbenchRef, isResizing, initialWidth, handleStartResize, handleResetResizer } = useWorkbenchResizer();
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
  const graphFlowRef = useRef<ReactFlowInstance<any, any> | null>(null);
  const graphFitFrameRef = useRef<number | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
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
    graphFlowRef.current = instance;
    if (graphFitFrameRef.current !== null) cancelAnimationFrame(graphFitFrameRef.current);

    graphFitFrameRef.current = requestAnimationFrame(() => {
      graphFitFrameRef.current = requestAnimationFrame(() => {
        graphFitFrameRef.current = null;
        if (graphFlowRef.current !== instance) return;
        void instance.fitView({ padding: 0.24, minZoom: 0.3, maxZoom: 1.6, duration: 0 });
        setReadyGraphRunKey(targetKey);
      });
    });
  }, [currentRunKey]);

  const handleChatScroll = useCallback(() => {
    if (!chatScrollRef.current) return;
    if (suppressAutoScrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatScrollRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const prevScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;

    const isScrollingUp = scrollTop < prevScrollTop - 1;

    if (isScrollingToBottomRef.current) {
      if (isScrollingUp) {
        isScrollingToBottomRef.current = false;
        isUserScrolledUpRef.current = true;
        setShowScrollBottom(distanceFromBottom > 24);
        return;
      }
      if (distanceFromBottom <= 15) {
        isScrollingToBottomRef.current = false;
        isUserScrolledUpRef.current = false;
        setShowScrollBottom(false);
      }
      return;
    }

    if (isScrollingUp) {
      isUserScrolledUpRef.current = true;
      setShowScrollBottom(distanceFromBottom > 24);
      return;
    }

    if (distanceFromBottom > 20) {
      isUserScrolledUpRef.current = true;
      setShowScrollBottom(distanceFromBottom > 24);
    } else if (distanceFromBottom <= 15) {
      isUserScrolledUpRef.current = false;
      setShowScrollBottom(false);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    isUserScrolledUpRef.current = false;
    isScrollingToBottomRef.current = true;
    setShowScrollBottom(false);
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTo({
        top: chatScrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, []);

  const handleSendMessageWithScroll = useCallback((val: string, options?: PromptBoxSubmitOptions) => {
    isUserScrolledUpRef.current = false;
    isScrollingToBottomRef.current = true;
    setShowScrollBottom(false);
    return onSendMessage(val, options);
  }, [onSendMessage]);

  // Listen to wheel and touch gestures on chat scroll container to immediately lock auto-scroll upon upward scrolling
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < -0.5) {
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
        if (delta > 1) {
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
  }, []);

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
    const update = () => view.style.setProperty("--composer-height", `${composer.getBoundingClientRect().height}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [conversationViewKey]);

  useEffect(() => () => {
    expandedCardObserverRef.current?.disconnect();
    if (expandedCardTimerRef.current !== null) clearTimeout(expandedCardTimerRef.current);
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
  }, []);

  // Ensure scroll button visibility is evaluated immediately on render and on size changes
  useLayoutEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;

    handleChatScroll(); // initial check

    const observer = new ResizeObserver(() => {
      if (suppressAutoScrollRef.current) return;
      const el = chatScrollRef.current;
      if (!el) return;

      const currentScrollHeight = el.scrollHeight;
      const heightGrew = currentScrollHeight > prevScrollHeightRef.current + 2;
      prevScrollHeightRef.current = currentScrollHeight;

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
  }, [handleChatScroll]);

  // Auto-scroll to bottom when new messages or streaming content arrives
  useLayoutEffect(() => {
    if (!isUserScrolledUpRef.current && chatScrollRef.current) {
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
  ]);

  const serialNode = routeType === "serial" && state.graph.nodes.length > 0 ? state.graph.nodes[0] : undefined;
  const serialNodeState = serialNode ? state.nodes[serialNode.name] : undefined;
  const serialExecutions = useMemo(() => {
    if (!serialNode) return [];
    return state.executions
      .filter((item) => item.node === serialNode.name)
      .sort((a, b) => a.startedAt - b.startedAt);
  }, [serialNode?.name, state.executions]);
  const serialExecution: Execution | undefined = serialExecutions[serialExecutions.length - 1];

  const serialTurns = useMemo(() => {
    if (routeType !== "serial" || !serialNode) return [];
    const turns: Array<{
      id: string;
      userMessage: ChatMessage;
      isInitial: boolean;
      executions: Execution[];
    }> = [];

    const messages = effectiveMessages.length > 0 ? effectiveMessages : (
      state.graph.originalGoal ? [{
        id: "msg-initial-goal",
        parentId: null,
        role: "user" as const,
        text: state.graph.originalGoal,
      }] : []
    );

    if (messages.length === 0) return [];

    turns.push({
      id: messages[0].id,
      userMessage: messages[0],
      isInitial: true,
      executions: serialExecutions.length > 0 ? [serialExecutions[0]] : [],
    });

    messages.slice(1).forEach((msg, idx) => {
      const execIndex = idx + 1;
      const execs = execIndex < serialExecutions.length ? [serialExecutions[execIndex]] : [];
      turns.push({
        id: msg.id,
        userMessage: msg,
        isInitial: false,
        executions: execs,
      });
    });

    if (serialExecutions.length > messages.length) {
      const assigned = new Set(turns.flatMap((t) => t.executions.map((e) => e.id)));
      const unassigned = serialExecutions.filter((e) => !assigned.has(e.id));
      if (unassigned.length > 0) {
        turns[0].executions.push(...unassigned);
        turns[0].executions.sort((a, b) => a.startedAt - b.startedAt);
      }
    }

    return turns;
  }, [routeType, serialNode?.name, effectiveMessages, serialExecutions, state.graph.originalGoal]);

  const isSerialExecution = routeType === "serial" && state.graph.nodes.length > 0;
  const isSerialWorking = Boolean(
    serialExecution
      ? serialExecution.status === "running" && serialExecution.completedAt == null
      : serialNodeState?.status === "running"
  );
  const isMainViewWorking = routeType === "serial" ? (isPlanning || isSerialWorking) : isPlanning;
  const completed = Object.values(state.nodes).filter((n) => n.status === "done").length;
  // A session switch keeps ReactFlow mounted; refit after the new nodes arrive.
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
    prevNodesCountRef.current = nodes.length;
    prevEdgesCountRef.current = edges.length;
    if (showGraphPane && graphFlowRef.current) centerGraph(graphFlowRef.current, currentRunKey);
  }, [currentRunKey, nodes.length, edges.length, showGraphPane, centerGraph]);

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
    if (revealChatFrameRef.current !== null) cancelAnimationFrame(revealChatFrameRef.current);
    // Let the transcript parse and measure its rows before the first visible frame.
    revealChatFrameRef.current = requestAnimationFrame(() => {
      revealChatFrameRef.current = requestAnimationFrame(() => {
        revealChatFrameRef.current = null;
        if (activeConversationViewRef.current !== key || conversationGenerationRef.current !== generation) return;
        const el = chatScrollRef.current;
        if (el && !isUserScrolledUpRef.current) el.scrollTop = el.scrollHeight;
        setReadyConversationKey(key);
      });
    });
  }, [conversationViewKey]);
  const revealNodeConversation = revealConversation;

  useLayoutEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;

    const isNewView = prevViewKeyRef.current !== conversationViewKey;
    prevViewKeyRef.current = conversationViewKey;

    if (isNewView) {
      // 进入新对话视图（Node Agent 或 Planner）时直接聚焦到底部最新内容，避免从顶部生硬滑动到底部
      suppressAutoScrollRef.current = false;
      isUserScrolledUpRef.current = false;
      isScrollingToBottomRef.current = false;
      el.scrollTop = el.scrollHeight;
      setShowScrollBottom(false);

      if (resetChatScrollFrameRef.current !== null) {
        cancelAnimationFrame(resetChatScrollFrameRef.current);
      }
      resetChatScrollFrameRef.current = requestAnimationFrame(() => {
        resetChatScrollFrameRef.current = null;
        if (chatScrollRef.current && !isUserScrolledUpRef.current) {
          chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
        }
      });
    }

    // If no execution or planning output needed to trigger onReady, reveal after layout settle
    if (!savedPlannerIds.length && !execution && !serialExecutions.length) {
      revealConversation();
    }
  }, [conversationViewKey, savedPlannerIds.length, execution, serialExecutions.length, revealConversation]);

  return (
    <section
      className={`workbench ${isResizing ? "resizing" : ""} ${showGraphPane ? "graph-mode" : "dialogue-only-mode"} ${isPlanning ? "planning-active" : "historical-settled"}`}
      ref={workbenchRef}
      style={{ "--workbench-left-width": `${initialWidth}px` } as React.CSSProperties}
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
              style={!isPlanning && readyConversationKey !== conversationViewKey ? { visibility: "hidden" } : undefined}
            >
              <div className="chat-messages-stream">
                {nodeTurns.map((turn) => (
                  <React.Fragment key={turn.id}>
                    {turn.isInitial ? (
                      <div className="chat-message-row user">
                        <EditableUserBubble
                          text={turn.taskText || selectedNode.task}
                          editing={editingTaskNode === selectedNode.name}
                          draft={taskDraft}
                          onDraftChange={setTaskDraft}
                          onEdit={!active ? () => {
                            onCancelEditMessage?.();
                            setEditingTaskNode(selectedNode.name);
                            setTaskDraft(selectedNode.task);
                          } : undefined}
                          onCancel={() => setEditingTaskNode("")}
                          disabled={locked || active || taskDraft.trim() === selectedNode.task}
                          onSend={(value) => {
                            const saveTask = () => {
                              onSave({ ...state.graph, nodes: state.graph.nodes.map((node) =>
                                node.name === selectedNode.name ? { ...node, task: value } : node
                              ) });
                              setEditingTaskNode("");
                            };
                            if (state.approved) {
                              onRequestConfirmation({
                                title: "修改 Task？",
                                message: "修改 Task 将创建新的待审批运行，当前运行不会继续。",
                                confirmText: "确认修改",
                                danger: true,
                                onConfirm: saveTask,
                              });
                              return false;
                            }
                            saveTask();
                          }}
                        />
                      </div>
                    ) : turn.userMessage ? (
                      <div key={turn.userMessage.id} className="chat-message-row user">
                        <EditableUserBubble
                          text={turn.userMessage.text.replace(/^\[@[^\]]+\]\s*/, "")}
                          editing={editingMessage?.id === turn.userMessage.id}
                          draft={editPrefillText ?? ""}
                          onDraftChange={onEditPrefillTextChange ?? (() => {})}
                          onEdit={onEditMessage ? () => { setEditingTaskNode(""); onEditMessage(turn.userMessage!); } : undefined}
                          onCancel={() => onCancelEditMessage?.()}
                          onSend={onSendMessage}
                          disabled={locked}
                        />
                      </div>
                    ) : null}

                    {turn.executions.map((exec) => (
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
                            onInitialOutputReady={exec.id === execution?.id ? revealNodeConversation : undefined}
                          />
                        </div>
                        <details className="workspace-details" style={{ marginTop: 12 }}>
                          <summary><FolderGit2 size={12} />工作区与会话信息</summary>
                          <p>Worktree: {exec.worktree}</p>
                          <p>Session ID: {exec.sessionId}</p>
                          <p>Commit Before: {exec.before}</p>
                          <p>Commit After: {exec.after ?? "pending"}</p>
                          <p className="details-tip">Graph Execution Instance 使用用户仓库旁的独立 worktree；Serial Execution Instance 直接使用用户目录。</p>
                        </details>
                      </motion.div>
                    ))}
                  </React.Fragment>
                ))}

                {selectedState?.error && (
                  <div className="node-error" style={{ marginTop: 12 }}>
                    {selectedState.error}
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

                {isSelectedNodeWorking && (
                  <div className="working-indicator" role="status" aria-live="polite">
                    <span className="working-indicator-dot" />
                    Working…
                  </div>
                )}
              </div>
            </div>
            {showScrollBottom && (
              <button
                type="button"
                className="scroll-to-bottom-btn"
                onClick={scrollToBottom}
                title="回到底部最新输出"
              >
                <ArrowDown size={14} />
                <span>最新</span>
              </button>
            )}
            <motion.div
              className="pane-bottom-chat"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
            >
              {followUpQueue && followUpQueue.length > 0 && (
                <div className="followup-queue-banner">
                  <div className="queue-info">
                    <Clock size={12} />
                    <span>排队中 ({followUpQueue.length}): {followUpQueue[0].text.slice(0, 30)}...</span>
                  </div>
                  {onCancelFollowUp && (
                    <button
                      type="button"
                      className="queue-cancel-btn"
                      onClick={() => onCancelFollowUp(followUpQueue[0].id)}
                    >
                      取消
                    </button>
                  )}
                </div>
              )}
              <PromptBox
                compact
                repository={config?.repository}
                onSubmit={handleSendMessageWithScroll}
                placeholder={
                  !state.approved
                    ? "图规划审批启动后，可在此向选定节点发送介入指令…"
                    : isSelectedNodeWorking
                    ? `向 @${selectedNode.name} 实时发送 Steer（当前工具调用后生效）…`
                    : `向 @${selectedNode.name} 发送介入指令…`
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
              style={!isPlanning && readyConversationKey !== conversationViewKey ? { visibility: "hidden" } : undefined}
            >
              <div className="chat-messages-stream">
                {routeType === "serial" ? (
                  <div className="serial-turns-container" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {serialTurns.map((turn, turnIdx) => (
                      <React.Fragment key={turn.id}>
                        {turn.userMessage && (
                          <motion.div
                            className="chat-message-row user"
                            initial={false}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                          >
                            <EditableUserBubble
                              text={turn.userMessage.text.trim()}
                              images={turn.userMessage.images}
                              editing={editingMessage?.id === turn.userMessage.id}
                              draft={editPrefillText ?? ""}
                              onDraftChange={onEditPrefillTextChange ?? (() => {})}
                              onEdit={onEditMessage ? () => onEditMessage(turn.userMessage!) : undefined}
                              onCancel={() => onCancelEditMessage?.()}
                              onSend={onSendMessage}
                              disabled={locked && !isPlanning}
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
                            <span>任务路线决策：单节点执行</span>
                          </motion.div>
                        )}

                        {turn.executions.length > 0 ? (
                          turn.executions.map((exec) => (
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
                                  onInitialOutputReady={exec.id === serialExecutions[serialExecutions.length - 1]?.id ? revealConversation : undefined}
                                />
                              </div>

                              <details className="workspace-details" style={{ marginTop: 12 }}>
                                <summary><FolderGit2 size={12} />工作区与会话信息</summary>
                                <p>工作目录: {exec.worktree}</p>
                                <p>会话实例: {exec.sessionId}</p>
                                {(() => {
                                  if (exec.pid) return <p>进程 PID: {exec.pid}</p>;
                                  const pidMatch = exec.output.match(/"type":"grapher_process_started"[^}]*"pid":(\d+)/) ||
                                                   exec.output.match(/"pid":(\d+)/);
                                  return pidMatch ? <p>沙箱进程 PID: {pidMatch[1]}</p> : null;
                                })()}
                                <p>Commit Before: {exec.before || "HEAD"}</p>
                                <p>Commit After: {exec.after ?? "pending"}</p>
                                <p className="details-tip">单节点串行任务直接在本地目录工作，无需额外 worktree。</p>
                              </details>
                            </motion.div>
                          ))
                        ) : (
                          turnIdx === 0 && (
                            <div className="stream-card-hint" style={{ padding: "8px 0", marginTop: 6 }}>
                              <Workflow size={14} className="spin" style={{ display: "inline", marginRight: 8, verticalAlign: "middle" }} />
                              独立沙箱正在推进中，正在启动 Pi 实例执行任务...
                            </div>
                          )
                        )}
                      </React.Fragment>
                    ))}

                    {serialNodeState?.error && (
                      <div className="node-error" style={{ marginTop: 12 }}>
                        {serialNodeState.error}
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
                        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                      >
                        {effectiveMessages[0].role === "user" ? (
                          <EditableUserBubble
                            text={effectiveMessages[0].text.trim()}
                            images={effectiveMessages[0].images}
                            editing={editingMessage?.id === effectiveMessages[0].id}
                            draft={editPrefillText ?? ""}
                            onDraftChange={onEditPrefillTextChange ?? (() => {})}
                            onEdit={onEditMessage ? () => onEditMessage(effectiveMessages[0]) : undefined}
                            onCancel={() => onCancelEditMessage?.()}
                            onSend={onSendMessage}
                            disabled={locked && !isPlanning}
                          />
                        ) : (
                          <div className={`chat-bubble-${effectiveMessages[0].role} chat-message-${effectiveMessages[0].role}`}>
                            <MarkdownRenderer content={effectiveMessages[0].text} />
                          </div>
                        )}
                      </motion.div>
                    )}

                    {/* 任务路线决策结果或评估中加载状态 */}
                    {((isPlanning && routeType === "undecided") || routeType !== "undecided") && (
                      <motion.div
                        className={`route-decision-pill ${routeType}`}
                        initial={isPlanning ? { opacity: 0, scale: 0.96 } : false}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: isPlanning ? 0.25 : 0, ease: "easeOut" }}
                      >
                        {routeType === "undecided" ? (
                          <>
                            <Loader2 size={13} className="spin" />
                            <span>正在评估任务路线决策...</span>
                          </>
                        ) : (
                          <>
                            <Compass size={13} />
                            <span>任务路线决策：多节点依赖拓扑图架构（并行独立沙箱）</span>
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
                          showUserTurns={!isPlanning}
                          skipFirstUser={state.events.some((event) => event.type === "created" && event.planning_id === savedPlannerIds[0])}
                          onReady={() => {
                            setReadySavedPlannerKey(savedPlannerKey);
                            revealConversation();
                          }}
                          onUserResize={handleExpandableContentChange}
                        />
                      </div>
                    )}

                    {/* 保留当前对话中的跟进消息；实时流已有同一消息时不重复渲染。 */}
                    {effectiveMessages.slice(1).filter((msg) =>
                      // Persisted Planner turns already contain user follow-ups
                      // in their correct chronological position.
                      (isPlanning || !useSavedPlanner) && (!renderLivePlanner ||
                        !plannerStream.items?.some((item: TranscriptItem) => item.role === "user" && item.id === msg.id))
                    ).map((msg) => (
                      <div className="chat-message-row user" key={msg.id}>
                        <EditableUserBubble
                          text={msg.text.trim()}
                          images={msg.images}
                          editing={editingMessage?.id === msg.id}
                          draft={editPrefillText ?? ""}
                          onDraftChange={onEditPrefillTextChange ?? (() => {})}
                          onEdit={onEditMessage ? () => onEditMessage(msg) : undefined}
                          onCancel={() => onCancelEditMessage?.()}
                          onSend={onSendMessage}
                          disabled={locked && !isPlanning}
                        />
                      </div>
                    ))}

                    {/* Planner 顺序流式记录：严格按实际发生时序呈现用户追加消息、工具调用、思维链与输出文字 */}
                    {renderLivePlanner && plannerStream.items && plannerStream.items.length > 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
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
                                  onSend={onSendMessage}
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
                                title="思考过程"
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
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                          {plannerStream.plannerThinking && (
                            <ThinkingCard
                              content={plannerStream.plannerThinking}
                              isStreaming={isPlanning && plannerStream.plannerThinkingActive}
                              title="思考过程"
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
                {isMainViewWorking && (
                  <div className="working-indicator" role="status" aria-live="polite">
                    <span className="working-indicator-dot" />
                    Working…
                  </div>
                )}
              </div>

              {/* 输出期间暂时隐藏摘要，停止后再展示当前结果 */}
              {failedPlanning && !isPlanning && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <PlanningSummaryCard
                    key={failedPlanning.planningId}
                    planning={failedPlanning}
                    state={undefined}
                    defaultExpanded={false}
                  />
                </motion.div>
              )}

              {/* 当前 Run 的规划阶段摘要（仅在多节点图模式下且当前 Run 自身拥有有效规划时展示） */}
              {!isPlanning && routeType === "graph" && state.planning && (!failedPlanning || state.planning.planningId !== failedPlanning.planningId) && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <PlanningSummaryCard
                    key={state.planning.planningId}
                    planning={state.planning}
                    state={state}
                    defaultExpanded={false}
                  />
                </motion.div>
              )}

              {!isPlanning && routeType === "graph" && state.graph.nodes.length > 0 && (
                <motion.div
                  className="plan-summary-card"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.38, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
                >
                  <div className="plan-summary-header">
                    <span>执行拓扑概览</span>
                    <span className={`phase-tag ${state.phase}`}>{phaseText[state.phase] ?? "草稿"}</span>
                  </div>

                  <div className="plan-stats-row">
                    <div className="plan-stat">
                      <span className="stat-num">{state.graph.nodes.length}</span>
                      <span className="stat-lbl">规划节点</span>
                    </div>
                    <div className="plan-stat">
                      <span className="stat-num">{state.plan?.executionBatches.length ?? 1}</span>
                      <span className="stat-lbl">执行批次</span>
                    </div>
                    <div className="plan-stat">
                      <span className="stat-num">{state.graph.edges.length}</span>
                      <span className="stat-lbl">拓扑边</span>
                    </div>
                    <div className="plan-stat">
                      <span className="stat-num">{completed}/{state.graph.nodes.length}</span>
                      <span className="stat-lbl">已完成</span>
                    </div>
                  </div>

                  <div className="plan-nodes-list">
                    <span className="nodes-list-title">节点列表（点击聚焦查看详细日志与独立沙箱）：</span>
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
            </div>
            {showScrollBottom && (
              <button
                type="button"
                className="scroll-to-bottom-btn"
                onClick={scrollToBottom}
                title="回到底部最新输出"
              >
                <ArrowDown size={14} />
                <span>最新</span>
              </button>
            )}
            <motion.div
              className="pane-bottom-chat"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
            >
              {followUpQueue && followUpQueue.length > 0 && (
                <div className="followup-queue-banner">
                  <div className="queue-info">
                    <Clock size={12} />
                    <span>排队中 ({followUpQueue.length}): {followUpQueue[0].text.slice(0, 30)}...</span>
                  </div>
                  {onCancelFollowUp && (
                    <button
                      type="button"
                      className="queue-cancel-btn"
                      onClick={() => onCancelFollowUp(followUpQueue[0].id)}
                    >
                      取消
                    </button>
                  )}
                </div>
              )}
              <PromptBox
                compact
                repository={config?.repository}
                onSubmit={handleSendMessageWithScroll}
                placeholder={
                  isPlanning
                    ? "输入补充规划或纠偏要求，发送将实时转向 (Steer)…"
                    : isSerialExecution
                    ? "向当前任务发送介入指令，直接在对话框中继续对话…"
                    : state.approved
                    ? "向规划器修改当前图，保留未受影响的节点结果…"
                    : "向规划器追加指令，直接在对话框中继续对话并调整图规划…"
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
              title="按住左右拖动调节宽度，双击恢复默认"
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
                  <strong>执行拓扑图</strong>
                </div>
                <div className="toolbar-right">
                  <button
                    type="button"
                    className="icon-button"
                    title="编辑 Graph IR"
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
                      <span className="note-line" />依赖前进
                      <span className="note-line feedback" />执行反馈
                    </div>

                    <div className="planner-off">
                      <span />Planner {isPlanning ? "规划中" : state.graph.nodes.length ? "已离线" : "未启动"}
                    </div>
                  </>
                )}
              </div>

              {state.graph.nodes.length > 0 && (
                <div className="graph-bottom">
                  <div className="progress-label">
                    <span>
                      <span className="progress-dot" />
                      {completed} / {state.graph.nodes.length} 节点完成
                    </span>
                    <span>{phaseText[state.phase] ?? state.phase}</span>
                  </div>
                  <div className="progress-track">
                    <div style={{ width: `${(completed / Math.max(1, state.graph.nodes.length)) * 100}%` }} />
                  </div>

                  <div className="approval-row">
                    <span>
                      {state.phase === "running" ? "确定性运行时正在推进"
                        : state.phase === "needs_attention" ? "执行已停止，请检查失败或阻塞节点"
                        : state.phase === "paused" ? "已暂停后续派发"
                        : state.phase === "completed" ? "运行已完成"
                        : state.approved ? phaseText[state.phase] ?? state.phase : ""}
                    </span>
                    <div>
                      {state.phase === "awaiting_approval" ? (
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
                            className="secondary"
                            disabled={locked || active || !selected}
                            onClick={() => onControl("rerun")}
                          >
                            <RotateCcw size={13} />重跑选定节点
                          </button>
                          <button
                            type="button"
                            className="primary"
                            disabled={locked || publishing || publicationFailed || state.phase === "completed"}
                            onClick={() => onControl(state.paused ? "resume" : "pause")}
                          >
                            {state.paused ? <Play size={13} /> : <Pause size={13} />}
                            {state.paused ? "继续" : "暂停"}
                          </button>
                        </>
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
