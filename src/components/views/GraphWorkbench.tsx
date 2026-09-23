import React, { useRef, useState, useEffect, useLayoutEffect, useCallback } from "react";
import { Background, Controls, ReactFlow, type ReactFlowInstance } from "@xyflow/react";
import {
  Code2, ArrowLeft, Terminal, FolderGit2, GitBranch, RotateCcw,
  Workflow, Check, Play, Pause, Compass, ArrowDown, Clock, Loader2,
  Pencil, ChevronLeft, ChevronRight
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  Snapshot, PlanRouteType, RepositoryInfo, Config,
  Graph, Execution, Status, PlanningSummary, emptyGraph, TranscriptItem,
  ChatMessage, PlanMode
} from "../../types";
import { PromptBox } from "../ui/chatgpt-prompt-input";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { ToolCallCard } from "../ToolCallCard";
import { ThinkingCard } from "../ThinkingCard";
import { ExecutionTiming } from "../ExecutionTiming";
import { ExecutionTranscript } from "../ExecutionTranscript";
import { PlanningSummaryCard } from "../PlanningSummaryCard";
import { statusText, phaseText } from "../graph/TaskNode";
import { useSmoothStreamText } from "../../hooks/useSmoothStreamText";
import { useAnimatedNodes } from "../../hooks/useAnimatedNodes";

interface GraphWorkbenchProps {
  state: Snapshot;
  routeType: PlanRouteType;
  selected: string;
  setSelected: (name: string) => void;
  effectiveMessages: Array<ChatMessage>;
  branchInfo?: Record<string, { index: number; count: number; prevId?: string; nextId?: string }>;
  onSwitchBranch?: (targetId: string) => void;
  onEditMessage?: (msg: ChatMessage) => void;
  editingMessage?: ChatMessage | null;
  editPrefillText?: string;
  onEditPrefillTextChange?: (text: string) => void;
  onCancelEditMessage?: () => void;
  isWorking?: boolean;
  onInterrupt?: () => void;
  isPlanning: boolean;
  plannerStream: any;
  onSendMessage: (val: string, options?: { mode?: "followUp" | "steer" }) => void;
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

const StreamingAssistantBubble: React.FC<{ content: string; isStreaming: boolean }> = React.memo(
  ({ content, isStreaming }) => {
    const smoothText = useSmoothStreamText(content, isStreaming);
    return <MarkdownRenderer content={smoothText} isStreaming={isStreaming} />;
  }
);
StreamingAssistantBubble.displayName = "StreamingAssistantBubble";

export const GraphWorkbench: React.FC<GraphWorkbenchProps> = React.memo(({
  state,
  routeType,
  selected,
  setSelected,
  failedPlanning,
  effectiveMessages,
  branchInfo,
  onSwitchBranch,
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
  const selectedNode = state.graph.nodes.find((item) => item.name === selected);
  const selectedState = selectedNode ? state.nodes[selectedNode.name] : undefined;
  const attempts = selectedNode
    ? [...state.executions.filter((item) => item.node === selectedNode.name),
       ...(state.mergers ?? []).filter((item) => item.node === `merge:${selectedNode.name}`)]
        .sort((a, b) => a.startedAt - b.startedAt)
    : [];
  const execution: Execution | undefined = attempts.find((item) => item.id === attemptId) ?? attempts[attempts.length - 1];

  const conversationViewKey = `${state.runId}:${routeType}:${selected || "planner"}:${execution?.id || ""}`;
  const smoothPlannerText = useSmoothStreamText(plannerStream.plannerText, isPlanning);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const currentWidthRef = useRef<number>(390);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);
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
  const [readyGraphKey, setReadyGraphKey] = useState("");

  if (activeConversationViewRef.current !== conversationViewKey) {
    activeConversationViewRef.current = conversationViewKey;
    conversationGenerationRef.current += 1;
    isUserScrolledUpRef.current = false;
    suppressAutoScrollRef.current = false;
  }

  const centerGraph = useCallback((instance: ReactFlowInstance<any, any>, key: string) => {
    graphFlowRef.current = instance;
    if (graphFitFrameRef.current !== null) cancelAnimationFrame(graphFitFrameRef.current);

    graphFitFrameRef.current = requestAnimationFrame(() => {
      graphFitFrameRef.current = requestAnimationFrame(() => {
        graphFitFrameRef.current = null;
        if (graphFlowRef.current !== instance) return;
        void instance.fitView({ padding: 0.15, minZoom: 0.3, maxZoom: 1.6 }).then(() => {
          if (graphFlowRef.current === instance) setReadyGraphKey(key);
        });
      });
    });
  }, []);

  const handleChatScroll = useCallback(() => {
    if (!chatScrollRef.current) return;
    if (suppressAutoScrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatScrollRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    if (isScrollingToBottomRef.current) {
      if (distanceFromBottom <= 30) {
        isScrollingToBottomRef.current = false;
      }
      isUserScrolledUpRef.current = false;
      setShowScrollBottom(false);
      return;
    }

    if (distanceFromBottom > 80) {
      isUserScrolledUpRef.current = true;
      setShowScrollBottom(true);
    } else if (distanceFromBottom <= 30) {
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

  // Listen to wheel and touch gestures on chat scroll container to immediately lock auto-scroll upon upward scrolling
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < -1) {
        isScrollingToBottomRef.current = false;
        isUserScrolledUpRef.current = true;
      } else if (e.deltaY > 1) {
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (dist <= 30) {
          isScrollingToBottomRef.current = false;
          isUserScrolledUpRef.current = false;
          setShowScrollBottom(false);
        }
      }
    };

    let startTouchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches[0]) startTouchY = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches[0]) {
        const delta = e.touches[0].clientY - startTouchY;
        if (delta > 2) {
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

  const handleExpandableContentChange = useCallback(() => {
    suppressAutoScrollRef.current = true;
    isUserScrolledUpRef.current = true;

    if (resumeAutoScrollFrameRef.current !== null) {
      cancelAnimationFrame(resumeAutoScrollFrameRef.current);
    }
    resumeAutoScrollFrameRef.current = requestAnimationFrame(() => {
      resumeAutoScrollFrameRef.current = requestAnimationFrame(() => {
        resumeAutoScrollFrameRef.current = null;
        suppressAutoScrollRef.current = false;
        handleChatScroll();
      });
    });
  }, [handleChatScroll]);

  useEffect(() => () => {
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

      // Auto-scroll to bottom when content grows, unless user scrolled up or smooth-scrolling to bottom
      if (!isUserScrolledUpRef.current && !isScrollingToBottomRef.current) {
        el.scrollTop = el.scrollHeight;
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

  // Initialize width from localStorage directly into CSS variable
  useEffect(() => {
    try {
      const saved = localStorage.getItem("grapher_pane_width");
      const width = saved ? Math.max(280, Math.min(800, Number(saved))) : 390;
      currentWidthRef.current = width;
      if (workbenchRef.current) {
        workbenchRef.current.style.setProperty("--workbench-left-width", `${width}px`);
      }
    } catch {
      // ignore
    }
  }, []);

  // Zero-react-render resizer: mutates CSS variable on container directly during mousemove
  const handleStartResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = currentWidthRef.current;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!workbenchRef.current) return;
      const rect = workbenchRef.current.getBoundingClientRect();
      const delta = moveEvent.clientX - startX;
      const clampedWidth = Math.max(280, Math.min(rect.width - 320, startWidth + delta));
      currentWidthRef.current = clampedWidth;
      workbenchRef.current.style.setProperty("--workbench-left-width", `${clampedWidth}px`);
    };

    const onMouseUp = () => {
      setIsResizing(false);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      try {
        localStorage.setItem("grapher_pane_width", String(currentWidthRef.current));
      } catch {
        // ignore
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  const handleResetResizer = useCallback(() => {
    currentWidthRef.current = 390;
    if (workbenchRef.current) {
      workbenchRef.current.style.setProperty("--workbench-left-width", "390px");
    }
    try {
      localStorage.setItem("grapher_pane_width", "390");
    } catch {
      // ignore
    }
  }, []);





  const serialNode = routeType === "serial" && state.graph.nodes.length > 0 ? state.graph.nodes[0] : undefined;
  const serialNodeState = serialNode ? state.nodes[serialNode.name] : undefined;
  const serialExecution: Execution | undefined = serialNode
    ? state.executions.filter((item) => item.node === serialNode.name).pop()
    : undefined;

  const isSerialExecution = routeType === "serial" && state.graph.nodes.length > 0;
  const isPlannerDisabled = !isSerialExecution && Boolean(state.approved);

  useEffect(() => {
    if (isPlannerDisabled && editingMessage) {
      onCancelEditMessage?.();
    }
  }, [isPlannerDisabled, editingMessage, onCancelEditMessage]);

  const completed = Object.values(state.nodes).filter((n) => n.status === "done").length;
  const graphKey = `${state.runId || state.graph.originalGoal}:${state.graph.nodes.map((node) => node.name).join("|")}`;
  const graphViewportReady = readyGraphKey === graphKey;

  const hasGraphToolCalled =
    (plannerStream.items || []).some((t: any) => t.toolName === "node" || t.toolName === "edge") ||
    (plannerStream.tools || []).some((t: any) => t.toolName === "node" || t.toolName === "edge");
  const hasGraphContent = state.graph.nodes.length > 0 || hasGraphToolCalled;
  const showGraphPane = routeType === "graph" && (hasGraphContent || (!isPlanning && state.graph.nodes.length > 0));

  const animatedNodes = useAnimatedNodes(nodes);

  const prevNodesCountRef = useRef(nodes.length);
  useEffect(() => {
    if (nodes.length > 0 && nodes.length !== prevNodesCountRef.current) {
      prevNodesCountRef.current = nodes.length;
      if (graphFlowRef.current) {
        void graphFlowRef.current.fitView({ padding: 0.18, duration: 400, minZoom: 0.3, maxZoom: 1.5 });
      }
    }
  }, [nodes.length]);

  const prevEdgesCountRef = useRef(edges.length);
  useEffect(() => {
    if (edges.length > 0 && edges.length !== prevEdgesCountRef.current) {
      prevEdgesCountRef.current = edges.length;
      if (graphFlowRef.current) {
        void graphFlowRef.current.fitView({ padding: 0.18, duration: 450, minZoom: 0.3, maxZoom: 1.5 });
      }
    }
  }, [edges.length]);

  const prevMsgCountRef = useRef(effectiveMessages.length);
  useEffect(() => {
    if (effectiveMessages.length > prevMsgCountRef.current) {
      prevMsgCountRef.current = effectiveMessages.length;
      isUserScrolledUpRef.current = false;
      if (chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
    } else {
      prevMsgCountRef.current = effectiveMessages.length;
    }
  }, [effectiveMessages.length]);

  const revealNodeConversation = useCallback(() => {
    const key = conversationViewKey;
    const generation = conversationGenerationRef.current;
    if (revealChatFrameRef.current !== null) cancelAnimationFrame(revealChatFrameRef.current);
    // Let the transcript parse and measure its rows before the first visible frame.
    revealChatFrameRef.current = requestAnimationFrame(() => {
      revealChatFrameRef.current = requestAnimationFrame(() => {
        revealChatFrameRef.current = null;
        if (activeConversationViewRef.current !== key || conversationGenerationRef.current !== generation) return;
        const el = chatScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
        setReadyConversationKey(key);
      });
    });
  }, [conversationViewKey]);

  useLayoutEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;

    // 进入对话视图（Node Agent 或 Planner）时直接聚焦到底部最新内容，避免从顶部生硬滑动到底部
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
      if (chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
      isUserScrolledUpRef.current = false;
      setShowScrollBottom(false);
    });
  }, [conversationViewKey]);

  useEffect(() => {
    if (routeType !== "graph") setReadyGraphKey("");
  }, [routeType]);

  return (
    <section
      className={`workbench ${isResizing ? "resizing" : ""} ${showGraphPane ? "graph-mode" : "dialogue-only-mode"}`}
      ref={workbenchRef}
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
              style={execution && readyConversationKey !== conversationViewKey ? { visibility: "hidden" } : undefined}
            >
              <div className="chat-messages-stream">
                <div style={{ padding: "0 4px" }}>
                  <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "6px" }}>
                    Task
                  </div>
                  <p style={{ fontSize: "12px", lineHeight: 1.6, color: "var(--text-primary)", margin: 0, whiteSpace: "pre-wrap" }}>
                    {selectedNode.task}
                  </p>
                </div>

                {attempts.length > 0 && (
                  <label className="attempt-picker">
                    <span>执行记录</span>
                    <select
                      value={execution?.id ?? ""}
                      onChange={(event) => setAttemptId(event.target.value)}
                    >
                      {attempts.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.node.startsWith("merge:") ? "merger" : `#${item.attempt}`} · {item.status}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {execution && (
                  <motion.div
                    className="serial-execution-panel"
                    initial={false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                  >
                    <div className="session-label">
                      <strong>Pi Session</strong>
                      <span className={`status-badge ${execution.status}`}>
                        {statusText[execution.status as Status] ?? execution.status}
                      </span>
                      <ExecutionTiming execution={execution} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", marginTop: 4 }}>
                      <ExecutionTranscript
                        key={execution.id}
                        runId={state.runId}
                        execution={execution}
                        onUserResize={handleExpandableContentChange}
                        onInitialOutputReady={revealNodeConversation}
                      />
                    </div>
                    <details className="workspace-details" style={{ marginTop: 12 }}>
                      <summary><FolderGit2 size={12} />工作区与会话信息</summary>
                      <p>Worktree: {execution.worktree}</p>
                      <p>Session ID: {execution.sessionId}</p>
                      <p>Commit Before: {execution.before}</p>
                      <p>Commit After: {execution.after ?? "pending"}</p>
                      <p className="details-tip">Graph Execution Instance 使用用户仓库旁的独立 worktree；Serial Execution Instance 直接使用用户目录。</p>
                    </details>
                  </motion.div>
                )}

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

                {isWorking && (
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
              {editingMessage && (
                <div className="prompt-box-editing-banner">
                  <div className="editing-banner-content">
                    <span className="editing-banner-dot" />
                    <span>正在修改历史消息（将创建新分支，已有执行记录完整保留）</span>
                  </div>
                  {onCancelEditMessage && (
                    <button type="button" onClick={onCancelEditMessage} className="editing-cancel-btn">
                      取消
                    </button>
                  )}
                </div>
              )}
              <PromptBox
                compact
                onSubmit={(val, options) => onSendMessage(val, options)}
                placeholder={
                  !state.approved
                    ? "图规划审批启动后，可在此向选定节点发送介入指令…"
                    : `向 @${selectedNode.name} 发送介入指令…`
                }
                isExecuting={active}
                isWorking={isWorking}
                onInterrupt={onInterrupt}
                value={editPrefillText || undefined}
                onChange={(e) => onEditPrefillTextChange?.(e.target.value)}
                onCancel={onCancelEditMessage}
                disabled={
                  locked ||
                  !state.approved
                }
              />
            </motion.div>
          </div>
        ) : (
          <div className="initial-query-view">
            <div className="initial-query-scroll" ref={chatScrollRef} onScroll={handleChatScroll}>
              <div className="chat-messages-stream">
                {effectiveMessages.map((msg) => (
                  <motion.div
                    key={msg.id}
                    className={`chat-message-row ${msg.role}`}
                    initial={false}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                  >
                    {msg.role === "user" ? (
                      <div className="chat-user-message-card-wrapper">
                        {!isPlannerDisabled && onEditMessage && (
                          <button
                            type="button"
                            className="chat-message-edit-btn"
                            onClick={() => onEditMessage(msg)}
                            title="修改消息内容并重新发送"
                            aria-label="修改消息内容并重新发送"
                          >
                            <Pencil size={14} />
                          </button>
                        )}
                        {branchInfo?.[msg.id] && branchInfo[msg.id].count > 1 && (
                          <div className="chat-branch-pager">
                            <button
                              type="button"
                              disabled={branchInfo[msg.id].index <= 0}
                              onClick={() => onSwitchBranch?.(branchInfo[msg.id].prevId!)}
                              className="chat-branch-pager-btn"
                              title="切换到上一分支"
                            >
                              <ChevronLeft size={12} />
                            </button>
                            <span className="chat-branch-pager-text">
                              {branchInfo[msg.id].index + 1}/{branchInfo[msg.id].count}
                            </span>
                            <button
                              type="button"
                              disabled={branchInfo[msg.id].index >= branchInfo[msg.id].count - 1}
                              onClick={() => onSwitchBranch?.(branchInfo[msg.id].nextId!)}
                              className="chat-branch-pager-btn"
                              title="切换到下一分支"
                            >
                              <ChevronRight size={12} />
                            </button>
                          </div>
                        )}
                        <div className="chat-bubble-user">
                          {msg.text.trim()}
                        </div>
                      </div>
                    ) : (
                      <div className={`chat-bubble-${msg.role} chat-message-${msg.role}`}>
                        <MarkdownRenderer content={msg.text} />
                      </div>
                    )}
                  </motion.div>
                ))}



                {/* 任务路线决策结果或评估中加载状态 */}
                {((isPlanning && routeType === "undecided") || routeType !== "undecided") && (
                  <motion.div
                    className={`route-decision-pill ${routeType}`}
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.25, ease: "easeOut" }}
                  >
                    {routeType === "undecided" ? (
                      <>
                        <Loader2 size={13} className="spin" />
                        <span>正在评估任务路线决策...</span>
                      </>
                    ) : (
                      <>
                        <Compass size={13} />
                        <span>
                          {routeType === "serial"
                            ? "任务路线决策：单节点执行"
                            : "任务路线决策：多节点依赖拓扑图架构（并行独立沙箱）"}
                        </span>
                      </>
                    )}
                  </motion.div>
                )}

                {/* 单节点串行执行会话与流式实时日志 */}
                {routeType === "serial" && state.graph.nodes.length > 0 && (
                  <motion.div
                    className="serial-execution-panel"
                    initial={false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                  >
                    {serialExecution ? (
                      <div style={{ display: "flex", flexDirection: "column", marginTop: 4 }}>
                        <ExecutionTranscript
                          key={serialExecution.id}
                          runId={state.runId}
                          execution={serialExecution}
                          onUserResize={handleExpandableContentChange}
                        />
                      </div>
                    ) : (
                      <div className="stream-card-hint" style={{ padding: "8px 0", marginTop: 6 }}>
                        <Workflow size={14} className="spin" style={{ display: "inline", marginRight: 8, verticalAlign: "middle" }} />
                        独立沙箱正在推进中，正在启动 Pi 实例执行任务...
                      </div>
                    )}

                    {serialExecution && (
                      <details className="workspace-details" style={{ marginTop: 12 }}>
                        <summary><FolderGit2 size={12} />工作区与会话信息</summary>
                        <p>工作目录: {serialExecution.worktree}</p>
                        <p>会话实例: {serialExecution.sessionId}</p>
                        {(() => {
                          if (serialExecution.pid) return <p>进程 PID: {serialExecution.pid}</p>;
                          const pidMatch = serialExecution.output.match(/"type":"grapher_process_started"[^}]*"pid":(\d+)/) ||
                                           serialExecution.output.match(/"pid":(\d+)/);
                          return pidMatch ? <p>沙箱进程 PID: {pidMatch[1]}</p> : null;
                        })()}
                        <p>Commit Before: {serialExecution.before || "HEAD"}</p>
                        <p>Commit After: {serialExecution.after ?? "pending"}</p>
                        <p className="details-tip">单节点串行任务直接在本地目录工作，无需额外 worktree。</p>
                      </details>
                    )}

                    {serialNodeState?.error && (
                      <div className="node-error" style={{ marginTop: 12 }}>
                        {serialNodeState.error}
                      </div>
                    )}
                  </motion.div>
                )}

                {/* Planner 顺序流式记录：严格按实际发生时序呈现工具调用、思维链与输出文字 */}
                {plannerStream.items && plannerStream.items.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                    {plannerStream.items.map((item: TranscriptItem, idx: number) => {
                      const isLast = idx === plannerStream.items.length - 1;
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
                  (plannerStream.plannerThinking || plannerStream.plannerText || (isPlanning && plannerStream.stage === "planning")) && (
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
                      {isPlanning && plannerStream.stage === "planning" && !plannerStream.plannerThinking && !plannerStream.plannerText && (
                        <div className="stream-card-hint" style={{ padding: "8px 0" }}>
                          <Workflow size={14} className="spin" style={{ display: "inline", marginRight: 8, verticalAlign: "middle" }} />
                          正在计算独立 Git worktree 执行批次与验收复审依赖...
                        </div>
                      )}
                    </div>
                  )
                )}
                {isWorking && (
                  <div className="working-indicator" role="status" aria-live="polite">
                    <span className="working-indicator-dot" />
                    Working…
                  </div>
                )}
              </div>

              {/* 失败规划摘要：当最近规划未通过时独立呈现，不与旧 run 混淆，亦不继承旧 run 事件 */}
              {failedPlanning && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <PlanningSummaryCard
                    planning={failedPlanning}
                    state={undefined}
                    defaultExpanded={true}
                  />
                </motion.div>
              )}

              {/* 当前 Run 的规划阶段摘要（仅在多节点图模式下且当前 Run 自身拥有有效规划时展示） */}
              {routeType === "graph" && state.planning && (!failedPlanning || state.planning.planningId !== failedPlanning.planningId) && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <PlanningSummaryCard
                    planning={state.planning}
                    state={state}
                    defaultExpanded={!failedPlanning}
                  />
                </motion.div>
              )}

              {routeType === "graph" && state.graph.nodes.length > 0 && (
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
              {editingMessage && !isPlannerDisabled && (
                <div className="prompt-box-editing-banner">
                  <div className="editing-banner-content">
                    <span className="editing-banner-dot" />
                    <span>正在修改历史消息（将创建新分支，已有执行记录完整保留）</span>
                  </div>
                  {onCancelEditMessage && (
                    <button type="button" onClick={onCancelEditMessage} className="editing-cancel-btn">
                      取消
                    </button>
                  )}
                </div>
              )}
              <PromptBox
                compact
                onSubmit={(val, options) => onSendMessage(val, options)}
                placeholder={
                  isPlannerDisabled
                    ? "拓扑图已批准执行，无法再向规划器发送消息"
                    : isPlanning
                    ? "输入补充规划或纠偏要求，发送将实时转向 (Steer)…"
                    : isSerialExecution
                    ? "向当前任务发送介入指令…"
                    : ""
                }
                isExecuting={active || isPlanning}
                isWorking={isWorking}
                onInterrupt={onInterrupt}
                value={editPrefillText || undefined}
                onChange={(e) => onEditPrefillTextChange?.(e.target.value)}
                onCancel={onCancelEditMessage}
                disabled={
                  isPlannerDisabled ||
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
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              onMouseDown={handleStartResize}
              onDoubleClick={handleResetResizer}
              title="按住左右拖动调节宽度，双击恢复默认"
            >
              <div className="resizer-handle" />
            </motion.div>

            <motion.div
              key="graph-pane"
              className="graph-pane"
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 40 }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
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
                  key={state.runId || "active-plan"}
                  onInit={(instance) => centerGraph(instance, graphKey)}
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
                      <span className="note-line feedback" />反馈重试
                    </div>

                    <div className="planner-off">
                      <span />Planner {isPlanning ? "规划中" : state.graph.nodes.length ? "已离线" : "未启动"}
                      <span className="planner-cost">0 运行时协调 Token</span>
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
                    <span>{phaseText[state.phase] ?? state.phase} · 并发限制 {state.config?.maxParallel ?? config.maxParallel}</span>
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
                            onClick={() => onControl("intervene", { instruction: "Rerun this task and verify the latest workspace state." })}
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
                      ) : (
                        <button type="button" className="secondary" disabled={locked || active} onClick={() => onSave({ ...state.graph, originalGoal: goal })}>
                          <Check size={14} />编译并检查
                        </button>
                      )}
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
