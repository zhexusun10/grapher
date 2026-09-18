import React, { useRef, useState, useEffect, useLayoutEffect, useCallback } from "react";
import { Background, Controls, ReactFlow, type ReactFlowInstance } from "@xyflow/react";
import {
  Code2, ArrowLeft, Terminal, FolderGit2, GitBranch, RotateCcw,
  Workflow, Check, Play, Pause, Compass, ArrowDown
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  Snapshot, PlanRouteType, RepositoryInfo, Config,
  Graph, Execution, Status, PlanningSummary, emptyGraph
} from "../../types";
import { PromptBox } from "../ui/chatgpt-prompt-input";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { ToolCallCard } from "../ToolCallCard";
import { ThinkingCard } from "../ThinkingCard";
import { ExecutionTiming } from "../ExecutionTiming";
import { ExecutionTranscript } from "../ExecutionTranscript";
import { PlanningSummaryCard } from "../PlanningSummaryCard";
import { statusText, phaseText } from "../graph/TaskNode";

interface GraphWorkbenchProps {
  state: Snapshot;
  routeType: PlanRouteType;
  selected: string;
  setSelected: (name: string) => void;
  effectiveMessages: Array<{ id: string; role: "user" | "assistant"; text: string; timestamp?: number }>;
  isPlanning: boolean;
  plannerStream: any;
  onSendMessage: (val: string) => void;
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
  effectiveMessages,
  isPlanning,
  plannerStream,
  onSendMessage,
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
  const conversationViewKey = `${state.runId}:${routeType}:${selected || "planner"}`;
  const workbenchRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const currentWidthRef = useRef<number>(390);
  const [attemptId, setAttemptId] = useState("");
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);
  const suppressAutoScrollRef = useRef(false);
  const resumeAutoScrollFrameRef = useRef<number | null>(null);
  const resetChatScrollFrameRef = useRef<number | null>(null);
  const activeConversationViewRef = useRef(conversationViewKey);
  const entryTopLockedRef = useRef(true);
  const graphFlowRef = useRef<ReactFlowInstance<any, any> | null>(null);
  const graphFitFrameRef = useRef<number | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [readyGraphKey, setReadyGraphKey] = useState("");

  if (activeConversationViewRef.current !== conversationViewKey) {
    activeConversationViewRef.current = conversationViewKey;
    entryTopLockedRef.current = true;
    isUserScrolledUpRef.current = true;
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
    if (entryTopLockedRef.current) {
      const { scrollHeight, clientHeight } = chatScrollRef.current;
      chatScrollRef.current.scrollTop = 0;
      setShowScrollBottom(scrollHeight - clientHeight > clientHeight / 2);
      return;
    }
    if (suppressAutoScrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatScrollRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const isUserAwayFromBottom = distanceFromBottom > 80;
    const shouldShowScrollBottom = distanceFromBottom > clientHeight / 2;
    isUserScrolledUpRef.current = isUserAwayFromBottom;
    setShowScrollBottom(shouldShowScrollBottom);
  }, []);

  const releaseEntryTopLock = useCallback(() => {
    if (!entryTopLockedRef.current) return;
    entryTopLockedRef.current = false;
    handleChatScroll();
  }, [handleChatScroll]);

  const scrollToBottom = useCallback(() => {
    entryTopLockedRef.current = false;
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTo({
        top: chatScrollRef.current.scrollHeight,
        behavior: "smooth",
      });
      isUserScrolledUpRef.current = false;
    }
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
      if (entryTopLockedRef.current) {
        el.scrollTop = 0;
        setShowScrollBottom(el.scrollHeight - el.clientHeight > el.clientHeight / 2);
        return;
      }
      if (suppressAutoScrollRef.current) return;

      // Auto-scroll to bottom when content grows, unless user scrolled up
      if (!isUserScrolledUpRef.current) {
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
    if (!entryTopLockedRef.current && !isUserScrolledUpRef.current && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [effectiveMessages, plannerStream.plannerText, plannerStream.plannerThinking, isPlanning]);

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



  const selectedNode = state.graph.nodes.find((item) => item.name === selected);
  const selectedState = selectedNode ? state.nodes[selectedNode.name] : undefined;
  const attempts = selectedNode
    ? state.executions.filter((item) => item.node === selectedNode.name)
    : [];
  const execution: Execution | undefined = attempts.find((item) => item.id === attemptId) ?? attempts[attempts.length - 1];

  const serialNode = routeType === "serial" && state.graph.nodes.length > 0 ? state.graph.nodes[0] : undefined;
  const serialNodeState = serialNode ? state.nodes[serialNode.name] : undefined;
  const serialExecution: Execution | undefined = serialNode
    ? state.executions.filter((item) => item.node === serialNode.name).pop()
    : undefined;

  const completed = Object.values(state.nodes).filter((n) => n.status === "done").length;
  const graphKey = `${state.runId || state.graph.originalGoal}:${state.graph.nodes.map((node) => node.name).join("|")}`;
  const graphViewportReady = readyGraphKey === graphKey;

  useLayoutEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;

    entryTopLockedRef.current = true;
    suppressAutoScrollRef.current = false;
    isUserScrolledUpRef.current = true;
    el.scrollTop = 0;
    setShowScrollBottom(el.scrollHeight - el.clientHeight > el.clientHeight / 2);

    if (resetChatScrollFrameRef.current !== null) {
      cancelAnimationFrame(resetChatScrollFrameRef.current);
    }
    resetChatScrollFrameRef.current = requestAnimationFrame(() => {
      resetChatScrollFrameRef.current = null;
      el.scrollTop = 0;
      isUserScrolledUpRef.current = true;
      setShowScrollBottom(el.scrollHeight - el.clientHeight > el.clientHeight / 2);
    });
  }, [conversationViewKey]);

  useEffect(() => {
    if (routeType !== "graph") setReadyGraphKey("");
  }, [routeType]);

  return (
    <section
      className={`workbench ${isResizing ? "resizing" : ""} ${routeType === "graph" ? "graph-mode" : "dialogue-only-mode"}`}
      ref={workbenchRef}
    >
      {/* 左侧/居中对话与日志面板 */}
      <motion.div
        initial={false}
        className={`conversation-pane ${routeType === "graph" ? "split" : "full-width"}`}
        style={routeType === "graph" ? undefined : { width: "100%", maxWidth: "100%" }}
        onWheelCapture={releaseEntryTopLock}
        onPointerDownCapture={releaseEntryTopLock}
        onTouchStartCapture={releaseEntryTopLock}
        onKeyDownCapture={releaseEntryTopLock}
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

            <div className="initial-query-scroll" ref={chatScrollRef} onScroll={handleChatScroll}>
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
                          #{item.attempt} · {item.status}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {execution && (
                  <motion.div
                    className="serial-execution-panel"
                    initial={{ opacity: 0, y: 10 }}
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
              <PromptBox
                compact
                onSubmit={(val) => onSendMessage(val)}
                placeholder=""
                disabled={
                  locked ||
                  isPlanning ||
                  active ||
                  (Boolean(selectedNode) && !state.approved)
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
                    initial={{ opacity: 0, y: 8, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <div className={`chat-bubble-${msg.role}`}>
                      {msg.role === "user" ? msg.text.trim() : <MarkdownRenderer content={msg.text} />}
                    </div>
                  </motion.div>
                ))}



                {/* 任务路线决策结果 */}
                {routeType !== "undecided" && (
                  <motion.div
                    className={`route-decision-pill ${routeType}`}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                  >
                    <Compass size={13} />
                    <span>
                      {routeType === "serial"
                        ? "任务路线决策：单节点执行"
                        : "任务路线决策：多节点依赖拓扑图架构（并行独立沙箱）"}
                    </span>
                  </motion.div>
                )}

                {/* 单节点串行执行会话与流式实时日志 */}
                {routeType === "serial" && state.graph.nodes.length > 0 && (
                  <motion.div
                    className="serial-execution-panel"
                    initial={{ opacity: 0, y: 10 }}
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

                {/* Planner 工具调用流 */}
                {plannerStream.tools.map((tool: any) => (
                  <ToolCallCard
                    key={tool.id}
                    item={tool}
                    onExpandedChange={handleExpandableContentChange}
                  />
                ))}

                {/* Planner 实时思考与推理 */}
                {(plannerStream.plannerThinking || plannerStream.plannerText || (isPlanning && plannerStream.stage === "planning")) && (
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
                    {plannerStream.plannerText && (
                      <motion.div
                        className="chat-message-row assistant"
                        initial={{ opacity: 0, y: 8, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                      >
                        <div className="chat-bubble-assistant">
                          <MarkdownRenderer content={plannerStream.plannerText} isStreaming={isPlanning} />
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

              {/* 当前 Run 的规划阶段摘要（仅在当前 Run 自身拥有有效规划时展示） */}
              {state.planning && (!failedPlanning || state.planning.planningId !== failedPlanning.planningId) && (
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
              <PromptBox
                compact
                onSubmit={(val) => onSendMessage(val)}
                placeholder=""
                disabled={
                  locked ||
                  isPlanning ||
                  active ||
                  (Boolean(selectedNode) && !state.approved)
                }
              />
            </motion.div>
          </div>
        )}
      </motion.div>

      {/* 左右可调节分割器 与 右侧执行拓扑图面板 */}
      <AnimatePresence>
        {routeType === "graph" && (
          <>
            <motion.div
              key="workbench-resizer"
              className={`workbench-resizer ${isResizing ? "active" : ""}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
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
                {state.graph.nodes.length === 0 ? (
                  isPlanning ? (
                    <div className="graph-empty-state planning">
                      <div className="empty-icon-orbit">
                        <Workflow size={32} className="spin" />
                      </div>
                      <h3>AI 架构师正在生成有向执行图...</h3>
                      <p>正在分析代码拓扑、计算独立 Git worktree 并行执行批次与复审边。</p>
                    </div>
                  ) : null
                ) : (
                  <>
                    <ReactFlow
                      key={graphKey}
                      onInit={(instance) => centerGraph(instance, graphKey)}
                      style={{
                        opacity: graphViewportReady ? 1 : 0,
                        pointerEvents: graphViewportReady ? "auto" : "none",
                      }}
                      nodes={nodes}
                      edges={edges}
                      nodeTypes={nodeTypes}
                      edgeTypes={edgeTypes}
                      onNodeClick={(_, node) => {
                        setSelected(node.id);
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
