import React, { useRef, useState, useEffect, useCallback } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import {
  Code2, ArrowLeft, Terminal, FolderGit2, GitBranch, RotateCcw,
  Workflow, Check, Play, Pause, ShieldCheck, Compass
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
import { VirtualizedTranscript } from "../VirtualizedTranscript";
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
  const workbenchRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const currentWidthRef = useRef<number>(390);
  const [attemptId, setAttemptId] = useState("");
  const chatScrollRef = useRef<HTMLDivElement>(null);

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

  // Scroll chat messages
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [effectiveMessages.length, isPlanning]);

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

  return (
    <section
      className={`workbench ${isResizing ? "resizing" : ""} ${routeType === "graph" ? "graph-mode" : "dialogue-only-mode"}`}
      ref={workbenchRef}
    >
      {/* 左侧/居中对话与日志面板 */}
      <motion.div
        layout
        className={`conversation-pane ${routeType === "graph" ? "split" : "full-width"}`}
        style={routeType === "graph" ? undefined : { width: "100%", maxWidth: "100%" }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        {selectedNode && routeType === "graph" ? (
          <>
            <div className="conversation-heading">
              <div className="detail-icon">
                <Code2 size={18} />
              </div>
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
                  title="取消选中节点，返回查看全局初始任务目标"
                  onClick={() => setSelected("")}
                >
                  <ArrowLeft size={12} />
                  <span>初始目标</span>
                </button>
              )}
            </div>

            <div className="conversation-scroll">
              <div className="task-card">
                <div className="task-card-header">
                  <Terminal size={13} />
                  <span>TASK SPECIFICATION</span>
                </div>
                <p>{selectedNode.task}</p>
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

              {execution ? (
                <>
                  <div className="session-label">
                    <strong>Pi Session</strong>
                    <span>{execution.status}</span>
                    <ExecutionTiming execution={execution} />
                  </div>
                  <div style={{ flex: 1, minHeight: 320, display: "flex", flexDirection: "column", marginTop: 8 }}>
                    <VirtualizedTranscript key={execution.id} output={execution.output} />
                  </div>
                  <details className="workspace-details">
                    <summary><FolderGit2 size={12} />工作区与会话信息</summary>
                    <p>Worktree: {execution.worktree}</p>
                    <p>Session ID: {execution.sessionId}</p>
                    <p>Commit Before: {execution.before}</p>
                    <p>Commit After: {execution.after ?? "pending"}</p>
                    <p className="details-tip">Graph Execution Instance 使用用户仓库旁的独立 worktree；Serial Execution Instance 直接使用用户目录。</p>
                  </details>
                </>
              ) : (
                <div className="conversation-empty">
                  <div className="empty-orbit">
                    <Terminal size={22} />
                  </div>
                  <h3>全新独立上下文</h3>
                  <p>
                    审批通过后，该节点将在用户仓库旁的隔离 Git worktree 中启动全新的 Execution Instance。<br />
                    执行进度、代码修改与工具调用流将在此呈现。
                  </p>
                </div>
              )}

              {selectedState?.error && (
                <div className="node-error">
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
          </>
        ) : (
          <div className="initial-query-view">
            <div className="initial-query-scroll" ref={chatScrollRef}>
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
                      <MarkdownRenderer content={msg.text} />
                    </div>
                  </motion.div>
                ))}

                {/* Partitioner 实时推理流 */}
                {(plannerStream.partitionerThinking || plannerStream.partitionerText || (isPlanning && plannerStream.stage === "partitioning")) && (
                  <motion.div
                    className="planning-stream-card partitioner"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                  >
                    <div className="stream-card-header">
                      <Compass size={14} className={isPlanning && plannerStream.stage === "partitioning" ? "spin" : ""} />
                      <span>{isPlanning && plannerStream.stage === "partitioning" ? "AI 架构师正在评估任务执行路径 (Serial / Graph)..." : "Partitioner 路由记录"}</span>
                    </div>
                    {plannerStream.partitionerThinking && (
                      <ThinkingCard
                        content={plannerStream.partitionerThinking}
                        isStreaming={isPlanning && plannerStream.partitionerThinkingActive}
                        title="AI 架构师思维链"
                        defaultExpanded={true}
                      />
                    )}
                    {plannerStream.partitionerText && (
                      <div className="stream-card-body">
                        <MarkdownRenderer content={plannerStream.partitionerText} isStreaming={true} />
                      </div>
                    )}
                  </motion.div>
                )}

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
                        ? "任务路线决策：单节点串行执行（无需图分解）"
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
                    <div className="session-label">
                      <strong>Pi 串行执行实例</strong>
                      <span className={`status-badge ${serialNodeState?.status ?? "waiting"}`}>
                        {statusText[serialNodeState?.status as Status] ?? serialNodeState?.status ?? "WAITING"}
                      </span>
                      {serialExecution?.startedAt && (
                        <ExecutionTiming execution={serialExecution} />
                      )}
                    </div>

                    {serialExecution?.output ? (
                      <div style={{ flex: 1, minHeight: 280, display: "flex", flexDirection: "column", marginTop: 4 }}>
                        <VirtualizedTranscript key={serialExecution.id} output={serialExecution.output} />
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
                {plannerStream.tools.length > 0 && (
                  <div className="planner-tools-stream">
                    {plannerStream.tools.map((tool: any) => (
                      <ToolCallCard key={tool.id} item={tool} />
                    ))}
                  </div>
                )}

                {/* Planner 实时思考与推理 */}
                {(plannerStream.plannerThinking || plannerStream.plannerText || (isPlanning && plannerStream.stage === "planning")) && (
                  <motion.div
                    className="planning-stream-card planner"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                  >
                    <div className="stream-card-header">
                      <Workflow size={14} className={isPlanning && plannerStream.stage === "planning" ? "spin" : ""} />
                      <span>{isPlanning && plannerStream.stage === "planning" ? "AI Planner 正在探测仓库架构并构建有向执行图..." : "Planner 规划记录"}</span>
                    </div>
                    {plannerStream.plannerThinking && (
                      <ThinkingCard
                        content={plannerStream.plannerThinking}
                        isStreaming={isPlanning && plannerStream.plannerThinkingActive}
                        title="AI 规划器思维链"
                        defaultExpanded={true}
                      />
                    )}
                    {plannerStream.plannerText ? (
                      <div className="stream-card-body">
                        <MarkdownRenderer content={plannerStream.plannerText} isStreaming={true} />
                      </div>
                    ) : (
                      !plannerStream.plannerThinking && (
                        <div className="stream-card-hint">
                          正在计算独立 Git worktree 执行批次与验收复审依赖...
                        </div>
                      )
                    )}
                  </motion.div>
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
                    <Workflow size={14} />
                    <strong>执行拓扑概览</strong>
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
          </div>
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
            placeholder={
              selectedNode
                ? `向 [${selectedNode.name}] 发送微调或介入指令...`
                : routeType === "serial"
                ? "向当前串行任务发送微调或介入指令..."
                : "向工作图追加全局指令或修改规划要求..."
            }
            disabled={locked || active || !state.approved}
          />
        </motion.div>
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
              initial={{ opacity: 0, x: 45 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 45 }}
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
                {state.graph.nodes.length === 0 ? (
                  isPlanning ? (
                    <div className="graph-empty-state planning">
                      <div className="empty-icon-orbit">
                        <Workflow size={32} className="spin" />
                      </div>
                      <h3>AI 架构师正在生成有向执行图...</h3>
                      <p>正在分析代码拓扑、计算独立 Git worktree 并行执行批次与复审边。</p>
                    </div>
                  ) : (
                    <div className="graph-empty-state">
                      <div className="empty-icon-orbit">
                        <FolderGit2 size={32} />
                      </div>
                      {repoInfo || config.repository ? (
                        <>
                          <h3>本地 Git 工作区已就绪</h3>
                          <p>
                            已自动识别并连接本地代码仓库。在下方输入框输入工作目标，Grapher 将通过 AI Planner 编译并行有向工作图并在独立 Git worktree 中执行。
                          </p>
                          <div className="workspace-status-card">
                            <div className="ws-card-header">
                              <span className="ws-repo-name">
                                <FolderGit2 size={15} />
                                <strong>{repoInfo?.name || (config.repository ? config.repository.split("/").pop() : "")}</strong>
                              </span>
                              {repoInfo && (
                                <span className={`ws-clean-badge ${repoInfo.clean ? "clean" : "dirty"}`}>
                                  {repoInfo.clean ? "✓ 工作树干净 (Ready)" : "⚠ 有未提交改动 (Dirty)"}
                                </span>
                              )}
                            </div>
                            <div className="ws-card-meta">
                              {repoInfo?.branch && (
                                <span className="ws-meta-tag">
                                  <GitBranch size={12} /> 分支: <code>{repoInfo.branch}</code>
                                </span>
                              )}
                              {repoInfo?.head && (
                                <span className="ws-meta-tag">
                                  <Code2 size={12} /> HEAD: <code>{repoInfo.head}</code>
                                </span>
                              )}
                            </div>
                            <div className="ws-card-path" title={repoInfo?.path || config.repository}>
                              <code>{repoInfo?.path || config.repository}</code>
                            </div>
                          </div>
                          <div className="empty-actions">
                            <button type="button" className="secondary" onClick={onPickRepository}>
                              <FolderGit2 size={14} />选择 / 切换本地目录
                            </button>
                            <button type="button" className="secondary" onClick={onDetectRepository}>
                              <RotateCcw size={14} />重新检测
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={onOpenEditor}
                            >
                              <Code2 size={14} />编写 Graph IR
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <h3>未选择本地工作区</h3>
                          <p>
                            Grapher 支持选择本地 Git 仓库或任意普通项目文件夹（自动提供本地隔离沙箱，零侵入不污染原项目）。请通过下方按钮选择本地文件夹。
                          </p>
                          <div className="empty-actions">
                            <button type="button" className="primary" onClick={onPickRepository}>
                              <FolderGit2 size={15} />选择本地项目文件夹
                            </button>
                            <button type="button" className="secondary" onClick={onDetectRepository}>
                              <RotateCcw size={14} />自动检测当前目录
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )
                ) : (
                  <>
                    <ReactFlow
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
                      fitView
                      fitViewOptions={{ padding: 0.15 }}
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
                      <ShieldCheck size={16} />
                      {state.phase === "running" ? "确定性运行时正在推进"
                        : state.phase === "needs_attention" ? "执行已停止，请检查失败或阻塞节点"
                        : state.phase === "paused" ? "已暂停后续派发"
                        : state.phase === "completed" ? "运行已完成"
                        : state.approved ? phaseText[state.phase] ?? state.phase : "需用户审核并批准计划"}
                    </span>
                    <div>
                      {state.phase === "awaiting_approval" ? (
                        <>
                          <button type="button" className="text-button" disabled={locked} onClick={() => onControl("reject")}>
                            拒绝
                          </button>
                          <button type="button" className="primary" disabled={locked} onClick={onOpenApproval}>
                            <Play size={13} fill="currentColor" />Approve & Start
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
