import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type NodeProps, type Node, type Edge } from "@xyflow/react";
import {
  ArrowDown, ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, Circle,
  Clock3, Code2, FolderGit2, GitBranch, GitFork, History, Layers3,
  LoaderCircle, MessageSquare, Pause, Play, Plus, RotateCcw,
  Settings2, ShieldCheck, Sparkles, Terminal, Workflow, X
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { PromptBox } from "@/components/ui/chatgpt-prompt-input";
import { defaultConfig, emptyGraph, emptySnapshot, createPreviewSnapshot, type Bootstrap, type Config, type Graph, type ProjectItem, type RepositoryInfo, type Snapshot, type Status } from "./types";
import { tokens } from "./tokens";

const desktop = isTauri();
const statusText: Record<Status, string> = {
  waiting: "WAITING",
  running: "RUNNING",
  blocked: "BLOCKED",
  done: "DONE",
  failed: "FAILED",
  dirty: "DIRTY",
};
const phaseText: Record<string, string> = {
  draft: "草稿",
  awaiting_approval: "等待审批",
  running: "执行中",
  paused: "已暂停",
  completed: "已完成",
  needs_attention: "需要介入",
  rejected: "已拒绝",
};

type WorkNode = Node<{
  name: string;
  task: string;
  status: Status;
  attempts: number;
  revision: number;
  hint: string;
  reviewer: boolean;
  selected: boolean;
  worktree: string;
}, "work">;

function TaskNode({ data }: NodeProps<WorkNode>) {
  return (
    <div
      className={`task-node ${data.selected ? "selected" : ""} ${data.status}`}
      title={`${data.task}${data.hint ? `\n\n依赖关系:\n${data.hint}` : ""}\n版本: Rev ${data.revision} · 尝试: ${data.attempts}\n工作区: ${data.worktree || "未生成"}`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="node-heading">
        <span className={`node-icon ${data.reviewer ? "review" : ""}`}>
          {data.reviewer ? <ShieldCheck size={16} /> : <Code2 size={16} />}
        </span>
        <strong>{data.name}</strong>
        <span className="node-rev-badge">r{data.revision}</span>
      </div>
      <p>{data.task}</p>
      <div className="node-footer">
        <span className={`status ${data.status}`}>
          {data.status === "running" ? (
            <LoaderCircle className="spin" size={10} />
          ) : data.status === "done" ? (
            <Check size={11} />
          ) : (
            <Circle size={7} fill="currentColor" />
          )}
          {statusText[data.status]}
        </span>
        <span className="node-attempts-badge">
          {data.attempts > 0 ? `#${data.attempts} 尝试` : "就绪"}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} />
      <Handle id="feedback-out" type="source" position={Position.Left} />
      <Handle id="feedback-in" type="target" position={Position.Left} />
    </div>
  );
}

const nodeTypes = { work: TaskNode };

function readableLog(output: string) {
  return output.split("\n").map((line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        return event.assistantMessageEvent.delta;
      }
      if (event.type === "tool_execution_start") {
        return `\n$ ${event.toolName}\n${JSON.stringify(event.args, null, 2)}\n`;
      }
      if (event.type === "tool_execution_end") {
        return `\n${(event.result?.content ?? []).filter((item: { type: string }) => item.type === "text").map((item: { text: string }) => item.text).join("\n")}\n`;
      }
      if (event.type === "session") {
        return `Session ${event.id}\n`;
      }
      return "";
    } catch {
      return `${line}\n`;
    }
  }).join("");
}

export default function App() {
  const [state, setState] = useState<Snapshot>(emptySnapshot);
  const [config, setConfig] = useState<Config>(defaultConfig);
  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>(() => {
    try {
      const saved = localStorage.getItem("grapher_projects");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [mainTab, setMainTab] = useState<"graph" | "sessions" | "timeline" | "settings">("graph");
  const [goal, setGoal] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [tab, setTab] = useState<"conversation" | "history">("conversation");
  const [modal, setModal] = useState<"settings" | "editor" | "approval" | null>(null);
  const [editor, setEditor] = useState("");
  const [args, setArgs] = useState("[]");
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<string[]>([]);
  const [historical, setHistorical] = useState(false);
  const [attemptId, setAttemptId] = useState("");
  const [dataPath, setDataPath] = useState("");
  const [timelineFilter, setTimelineFilter] = useState<string>("all");
  const [isPlanning, setIsPlanning] = useState(false);

  // 可调节左右面板宽度状态，默认 380px，支持持久化存储
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("grapher_pane_width");
      return saved ? Math.max(280, Math.min(800, Number(saved))) : 390;
    } catch {
      return 390;
    }
  });
  const [isResizing, setIsResizing] = useState(false);
  const workbenchRef = useRef<HTMLDivElement>(null);

  const handleStartResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = leftWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!workbenchRef.current) return;
      const rect = workbenchRef.current.getBoundingClientRect();
      const delta = moveEvent.clientX - startX;
      const clampedWidth = Math.max(280, Math.min(rect.width - 320, startWidth + delta));
      setLeftWidth(clampedWidth);
    };

    const onMouseUp = (upEvent: MouseEvent) => {
      setIsResizing(false);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (workbenchRef.current) {
        const rect = workbenchRef.current.getBoundingClientRect();
        const delta = upEvent.clientX - startX;
        const finalWidth = Math.max(280, Math.min(rect.width - 320, startWidth + delta));
        try {
          localStorage.setItem("grapher_pane_width", String(finalWidth));
        } catch {
          // ignore
        }
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [leftWidth]);

  const handleResetResizer = useCallback(() => {
    setLeftWidth(390);
    try {
      localStorage.setItem("grapher_pane_width", "390");
    } catch {
      // ignore
    }
  }, []);

  const load = useCallback(async () => {
    if (!desktop) return;
    const data = await invoke<Bootstrap>("bootstrap");
    setConfig(data.config);
    if (data.repositoryInfo) {
      const info = data.repositoryInfo;
      setRepoInfo(info);
      setProjects((prev) => {
        const item: ProjectItem = {
          id: info.path,
          name: info.name,
          path: info.path,
          branch: info.branch,
          clean: info.clean,
          lastOpened: Date.now(),
        };
        const exists = prev.some((p) => p.path === info.path);
        const nextList = exists
          ? prev.map((p) => (p.path === info.path ? item : p))
          : [item, ...prev];
        try {
          localStorage.setItem("grapher_projects", JSON.stringify(nextList));
        } catch {}
        return nextList;
      });
    }
    setArgs(JSON.stringify(data.config.piArgs));
    setRuns(data.runs);
    setDataPath(data.dataPath);
    if (data.snapshot.runId) {
      setState(data.snapshot);
      setGoal(data.snapshot.graph.originalGoal);
      if (data.snapshot.graph.nodes.length > 0) {
        setSelected((curr) => (curr && data.snapshot.graph.nodes.some(n => n.name === curr) ? curr : ""));
      }
      if (["completed", "rejected", "needs_attention"].includes(data.snapshot.phase)) {
        setHistorical(true);
      }
    }
  }, []);

  const handleOpenProject = () => run(async () => {
    if (!desktop) {
      setError("当前为浏览器只读预览。请运行 npm run desktop 使用 Rust 桌面环境。");
      return;
    }
    const info = await invoke<RepositoryInfo | null>("pick_repository");
    if (info) {
      setRepoInfo(info);
      setConfig((prev) => ({ ...prev, repository: info.path }));
      const item: ProjectItem = {
        id: info.path,
        name: info.name,
        path: info.path,
        branch: info.branch,
        clean: info.clean,
        lastOpened: Date.now(),
      };
      setProjects((prev) => {
        const next = [item, ...prev.filter((p) => p.path !== info.path)];
        try {
          localStorage.setItem("grapher_projects", JSON.stringify(next));
        } catch {}
        return next;
      });
      const snapshot = await invoke<Snapshot>("reset_workspace");
      setState(snapshot);
      setGoal("");
      setSelected("");
      setHistorical(false);
      setError("");
    }
  });

  const handlePickRepository = handleOpenProject;

  const handleSaveConfig = () => {
    try {
      const value: unknown = JSON.parse(args);
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error("启动参数必须是字符串 JSON 数组，如 [\"--flag\"]");
      }
      setConfig({ ...config, piArgs: value });
      setModal(null);
      setError("");
    } catch (err) {
      setError(String(err));
    }
  };

  const handleSelectProject = (proj: ProjectItem) => run(async () => {
    if (!desktop) {
      setError("当前为浏览器只读预览。请运行 npm run desktop 使用 Rust 桌面环境。");
      return;
    }
    if (config.repository === proj.path) return;
    const info = await invoke<RepositoryInfo | null>("detect_repository", { path: proj.path });
    if (info) {
      setRepoInfo(info);
      setConfig((prev) => ({ ...prev, repository: info.path }));
      setProjects((prev) => {
        const next = prev.map((p) =>
          p.path === info.path
            ? { ...p, branch: info.branch, clean: info.clean, lastOpened: Date.now() }
            : p
        );
        try {
          localStorage.setItem("grapher_projects", JSON.stringify(next));
        } catch {}
        return next;
      });
    } else {
      setConfig((prev) => ({ ...prev, repository: proj.path }));
    }
    const snapshot = await invoke<Snapshot>("reset_workspace");
    setState(snapshot);
    setGoal("");
    setSelected("");
    setHistorical(false);
    setError("");
  });

  const handleRemoveProject = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    setProjects((prev) => {
      const next = prev.filter((p) => p.path !== path);
      try {
        localStorage.setItem("grapher_projects", JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const handleDetectRepository = (customPath?: string) => run(async () => {
    if (!desktop) {
      setError("当前为浏览器只读预览。请运行 npm run desktop 使用 Rust 桌面环境。");
      return;
    }
    const info = await invoke<RepositoryInfo | null>("detect_repository", { path: customPath || null });
    if (info) {
      setRepoInfo(info);
      setConfig((prev) => ({ ...prev, repository: info.path }));
      setError("");
    } else {
      setError("目标路径未检测到有效的 Git 仓库（需包含 .git 目录）。");
    }
  });

  const handleResetWorkspace = () => run(async () => {
    if (!desktop) {
      setState(emptySnapshot);
      setGoal("");
      setSelected("");
      setHistorical(false);
      setError("");
      return;
    }
    const snapshot = await invoke<Snapshot>("reset_workspace");
    setState(snapshot);
    setGoal("");
    setSelected("");
    setHistorical(false);
    setError("");
  });

  const handleClearHistory = () => run(async () => {
    if (!desktop) {
      setRuns([]);
      setState(emptySnapshot);
      setGoal("");
      setSelected("");
      setHistorical(false);
      setError("");
      return;
    }
    if (window.confirm("确定清空所有历史运行记录吗？历史测试数据将被永久清除。")) {
      await invoke("clear_history");
      setRuns([]);
      const snapshot = await invoke<Snapshot>("reset_workspace");
      setState(snapshot);
      setGoal("");
      setSelected("");
      setHistorical(false);
      setError("");
    }
  });

  const handlePlanGoal = (inputGoal?: string) => run(async () => {
    const targetGoal = (inputGoal !== undefined ? inputGoal : goal).trim();
    if (!targetGoal) return;
    setGoal(targetGoal);
    setIsPlanning(true);
    setSelected("");
    setState((prev) => ({
      ...prev,
      graph: {
        ...prev.graph,
        originalGoal: targetGoal,
      },
    }));
    try {
      if (!desktop) {
        // 浏览器环境演示：模拟 500ms 分析后生成示例图，提供完整的流体动效
        await new Promise((r) => setTimeout(r, 500));
        const previewSnap = createPreviewSnapshot(targetGoal);
        setState(previewSnap);
        setHistorical(false);
        setMainTab("graph");
        setRuns((prev) => [previewSnap.runId, ...prev.filter((id) => id !== previewSnap.runId)]);
        setSelected("");
        return;
      }
      if (!config.repository) {
        setMainTab("settings");
        setError("请先在左侧工作区选择绑定的本地 Git 仓库。");
        return;
      }
      const snapshot = await invoke<Snapshot>("plan_goal", { goal: targetGoal, config });
      setState(snapshot);
      setHistorical(false);
      setMainTab("graph");
      setRuns((prev) => [snapshot.runId, ...prev.filter((id) => id !== snapshot.runId)]);
      setSelected("");
    } finally {
      setIsPlanning(false);
    }
  });

  useEffect(() => {
    load().catch((err) => setError(String(err)));
  }, [load]);

  useEffect(() => {
    if (!desktop || historical || busy) return;
    const interval = setInterval(() => {
      invoke<Snapshot>("snapshot")
        .then((snapshot) => {
          if (snapshot.runId) {
            setState(snapshot);
          }
        })
        .catch((err) => setError(String(err)));
    }, 700);
    return () => clearInterval(interval);
  }, [historical, busy]);

  useEffect(() => {
    setAttemptId("");
  }, [selected, state.runId]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(typeof err === "string" ? err : JSON.stringify(err));
    } finally {
      setBusy(false);
    }
  };

  const control = (action: string, extra = {}) => run(async () => {
    const snapshot = await invoke<Snapshot>("control", { action, node: selected, instruction, ...extra });
    setState(snapshot);
    setModal(null);
    if (action === "intervene") setInstruction("");
  });

  const save = (graph: Graph) => run(async () => {
    const snapshot = await invoke<Snapshot>("save_graph", { graph, config });
    setState(snapshot);
    setGoal(graph.originalGoal);
    setModal(null);
    setHistorical(false);
    setRuns((prev) => [snapshot.runId, ...prev.filter((id) => id !== snapshot.runId)]);
    if (graph.nodes.length > 0) {
      setSelected(graph.nodes[0].name);
    }
  });

  const activeProject = useMemo(() => {
    return projects.find((p) => p.path === config.repository) || (repoInfo ? {
      id: repoInfo.path,
      name: repoInfo.name,
      path: repoInfo.path,
      branch: repoInfo.branch,
      clean: repoInfo.clean,
      lastOpened: Date.now(),
    } : null);
  }, [projects, config.repository, repoInfo]);

  const selectedNode = state.graph.nodes.find((node) => node.name === selected);
  const selectedState = state.nodes[selected];
  const attempts = state.executions.filter((execution) => execution.node === selected);
  const execution = attempts.find((execution) => execution.id === attemptId) ?? attempts.at(-1);
  const active = Object.values(state.nodes).some((node) => node.status === "running");
  const completed = Object.values(state.nodes).filter((node) => node.status === "done").length;
  const locked = busy || historical;

  const nodes = useMemo<WorkNode[]>(() => {
    const layers = state.plan?.executionBatches ?? [state.graph.nodes.map((node) => node.name)];
    return state.graph.nodes.map((node) => {
      const layer = Math.max(0, layers.findIndex((batch) => batch.includes(node.name)));
      const batch = layers[layer] || [];
      const nodeAttempts = state.executions.filter((execution) => execution.node === node.name);
      return {
        id: node.name,
        type: "work",
        position: {
          x: (batch.indexOf(node.name) - (batch.length - 1) / 2) * 260 + 160,
          y: layer * 155 + 24,
        },
        data: {
          name: node.name,
          task: node.task,
          status: state.nodes[node.name]?.status ?? "waiting",
          attempts: nodeAttempts.length,
          revision: state.nodes[node.name]?.revision ?? 1,
          hint: state.graph.edges
            .filter((edge) => edge.to === node.name || (edge.from === node.name && edge.feedback))
            .map((edge) => `${edge.from} → ${edge.to}: ${edge.relation}${edge.feedback ? " (feedback)" : ""}`)
            .join("\n"),
          reviewer: state.graph.edges.some((edge) => edge.from === node.name && edge.feedback),
          selected: selected === node.name,
          worktree: nodeAttempts.at(-1)?.worktree ?? "",
        },
      };
    });
  }, [state.graph, state.plan, state.nodes, state.executions, selected]);

  const edges = useMemo<Edge[]>(() => state.graph.edges.map((edge) => ({
    id: `${edge.from}->${edge.to}`,
    source: edge.from,
    target: edge.to,
    type: "smoothstep",
    sourceHandle: edge.feedback ? "feedback-out" : undefined,
    targetHandle: edge.feedback ? "feedback-in" : undefined,
    animated: !edge.feedback && state.nodes[edge.from]?.status === "running",
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: edge.feedback ? tokens.graphEdgeFeedback : tokens.graphEdgeDefault,
      width: 14,
      height: 14,
    },
    style: {
      stroke: edge.feedback ? tokens.graphEdgeFeedback : tokens.graphEdgeDefault,
      strokeWidth: 1.5,
      strokeDasharray: edge.feedback ? "5 5" : undefined,
    },
    label: edge.feedback ? `REVISE · ≤ ${state.config?.maxFeedback ?? config.maxFeedback}` : undefined,
    labelStyle: { fontSize: 10, fill: tokens.graphEdgeFeedbackText, fontFamily: "monospace" },
    labelBgStyle: { fill: tokens.graphEdgeFeedbackBg },
  })), [state.graph, state.nodes, state.config, config.maxFeedback]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand-row">
          <a className="brand" href="#" onClick={(event) => event.preventDefault()}>
            <span className="brand-mark"><Workflow size={20} /></span>
            <strong>Grapher</strong>
            <span className="version">v0.1.0</span>
          </a>
        </div>

        <div className="nav-section projects-label">
          <span>WORKSPACES ({projects.length})</span>
          <button
            className="icon-tiny-btn"
            title="添加或打开本地 Git 仓库"
            onClick={handleOpenProject}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="projects-list">
          {projects.length > 0 ? (
            projects.map((proj) => {
              const isActive = config.repository === proj.path;
              return (
                <div
                  key={proj.path}
                  className={`project-workspace-item ${isActive ? "active" : ""}`}
                  onClick={() => handleSelectProject(proj)}
                  title={`${proj.name}\n${proj.path}\n分支: ${proj.branch}`}
                >
                  <span className="proj-icon">
                    <FolderGit2 size={15} />
                  </span>
                  <div className="proj-details">
                    <div className="proj-name-row">
                      <strong>{proj.name}</strong>
                      <span className="proj-branch-pill">
                        <GitBranch size={9} />
                        {proj.branch}
                      </span>
                    </div>
                    <small className="proj-path-text">{proj.path}</small>
                  </div>
                  {projects.length > 1 && !isActive && (
                    <button
                      className="proj-remove-btn"
                      title="从工作区列表移除"
                      onClick={(e) => handleRemoveProject(e, proj.path)}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              );
            })
          ) : (
            <div className="empty-projects-hint" onClick={handleOpenProject}>
              <FolderGit2 size={24} />
              <span>暂无工作区</span>
              <small>点击打开本地 Git 仓库</small>
            </div>
          )}
        </div>

        <div className="nav-section runs-label">
          <span>RUN HISTORY</span>
          <div className="runs-actions">
            {runs.length > 0 && (
              <button
                className="icon-tiny-btn danger-hover"
                title="清空历史运行快照"
                onClick={handleClearHistory}
              >
                <RotateCcw size={11} />
              </button>
            )}
            <button
              className="icon-tiny-btn"
              title="新建空白工作区"
              onClick={handleResetWorkspace}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        <div className="runs-list">
          {runs.length > 0 ? (
            runs.map((id, index) => (
              <button
                className={`run-item ${state.runId === id ? "chosen" : ""}`}
                key={id}
                onClick={() => run(async () => {
                  const snapshot = await invoke<Snapshot>("history", { runId: id });
                  setState(snapshot);
                  setHistorical(true);
                  if (snapshot.graph.nodes.length > 0) {
                    setSelected(snapshot.graph.nodes[0].name);
                  }
                })}
              >
                <span className="run-dot" />
                <span>
                  Graph {id.slice(0, 8)}
                  <small>{index === 0 ? "最近编译" : "历史快照"}</small>
                </span>
              </button>
            ))
          ) : (
            <div className="run-placeholder">
              <GitBranch size={13} />
              <span>当前项目暂无运行历史</span>
            </div>
          )}
        </div>

        <div className="sidebar-bottom">
          <div className="local-indicator">
            <span />{config.engine === "pi" ? "Pi 驱动引擎" : "Demo 模式"}
          </div>
          <div className="storage-info" title={dataPath}>
            <small>数据目录: {dataPath ? dataPath.split("/").slice(-2).join("/") : "本地存储"}</small>
          </div>
        </div>
      </aside>

      <main className="main">
        {state.graph.nodes.length === 0 && !isPlanning && !historical && mainTab === "graph" ? (
          <div className="landing-screen">
            {error && (
              <div className="error-banner" role="alert">
                <span>{error}</span>
                <button aria-label="关闭错误" onClick={() => setError("")}><X size={15} /></button>
              </div>
            )}

            <div className="landing-center-content">
              <motion.p
                className="landing-title"
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                How Can I Help You
              </motion.p>
              <div style={{ width: "100%", position: "relative" }}>
                {goal ? (
                  <motion.div
                    layoutId="user-query-content"
                    style={{
                      position: "absolute",
                      top: 12,
                      left: 16,
                      pointerEvents: "none",
                      opacity: 0,
                      fontSize: 14,
                    }}
                  >
                    {goal}
                  </motion.div>
                ) : null}
                <PromptBox
                  layoutId="chatgpt-prompt-box"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  onSubmit={(val) => handlePlanGoal(val)}
                  isBusy={busy || isPlanning}
                  placeholder="描述你想完成的工作或项目目标..."
                />
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* 精简专业的操作控制头部 */}
            <header className="workspace-header">
              <div className="header-top">
                <div className="workspace-meta">
                  <FolderGit2 size={16} />
                  <span className="repo-badge" title={config.repository || "未选择本地仓库"}>
                    {activeProject?.name || repoInfo?.name || (config.repository ? config.repository.split("/").pop() : "未选择项目")}
                  </span>
                  {activeProject?.branch && (
                    <span className="branch-tag">
                      <GitBranch size={11} />
                      {activeProject.branch}
                    </span>
                  )}
                  <ChevronRight size={13} />
                  <span className={`phase-tag ${state.phase}`}>{phaseText[state.phase] ?? "草稿"}</span>
                </div>

                {/* 原在左侧的内容现在移到项目顶部导航 Tab 区域 */}
                <nav className="header-nav-tabs">
                  <button
                    className={`tab-btn ${mainTab === "graph" ? "active" : ""}`}
                    onClick={() => setMainTab("graph")}
                  >
                    <GitFork size={14} />
                    <span>执行拓扑图</span>
                    {state.graph.nodes.length > 0 && <span className="tab-badge">{state.graph.nodes.length}</span>}
                  </button>
                  <button
                    className={`tab-btn ${mainTab === "sessions" ? "active" : ""}`}
                    onClick={() => setMainTab("sessions")}
                  >
                    <MessageSquare size={14} />
                    <span>节点会话与日志</span>
                    {selected && <span className="tab-badge select-badge">{selected}</span>}
                  </button>
                  <button
                    className={`tab-btn ${mainTab === "timeline" ? "active" : ""}`}
                    onClick={() => setMainTab("timeline")}
                  >
                    <History size={14} />
                    <span>事件流水</span>
                    <span className="tab-badge">{state.events.filter(e => e.type !== "output").length}</span>
                  </button>
                  <button
                    className={`tab-btn ${mainTab === "settings" ? "active" : ""}`}
                    onClick={() => setMainTab("settings")}
                  >
                    <Settings2 size={14} />
                    <span>运行配置</span>
                  </button>
                </nav>

                <div className="header-actions">
                  <span className="engine-indicator">
                    <span className="engine-dot" />
                    {config.engine === "pi" ? "Pi Engine" : "Demo"}
                  </span>
                  <button
                    className="secondary btn-sm"
                    title="查看与编辑 Graph IR JSON"
                    onClick={() => { setEditor(JSON.stringify(state.graph.nodes.length ? state.graph : emptyGraph, null, 2)); setModal("editor"); }}
                  >
                    <Code2 size={13} />Graph IR
                  </button>
                  <button
                    className="secondary btn-sm"
                    title="新建空白工作区"
                    onClick={handleResetWorkspace}
                  >
                    <Plus size={13} />新建图
                  </button>
                </div>
              </div>

              <div className="header-subbar">
                <div className="subbar-info">
                  <ShieldCheck size={13} />
                  <span>
                    {desktop
                      ? (config.engine === "pi"
                          ? "确定性运行时 · 节点在独立 Git worktree 执行 · 须经用户审批"
                          : "当前为演示引擎模式")
                      : "浏览器只读界面 · 真实编译与执行请运行桌面端"}
                  </span>
                </div>
                <div className="subbar-stats">
                  <span><Layers3 size={12} /> {state.graph.nodes.length} 节点</span>
                  <span className="stats-divider" />
                  <span>{state.plan?.executionBatches.length ?? 0} 执行层</span>
                  {state.graph.nodes.length > 0 && (
                    <>
                      <span className="stats-divider" />
                      <span className="stats-completed">{completed} / {state.graph.nodes.length} 完成</span>
                    </>
                  )}
                </div>
              </div>
            </header>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button aria-label="关闭错误" onClick={() => setError("")}><X size={15} /></button>
          </div>
        )}

        {historical && (
          <div className="history-banner">
            <div className="history-banner-text">
              <span>正在查看历史快照 [Graph {state.runId ? state.runId.slice(0, 8) : "历史"}]（只读状态）</span>
              {state.graph.originalGoal && <small>历史目标: {state.graph.originalGoal.slice(0, 60)}</small>}
            </div>
            <div className="history-banner-actions">
              <button className="primary btn-sm" onClick={handleResetWorkspace}>
                <Plus size={13} /> 新建工作区 / 开始新任务
              </button>
              <button className="secondary btn-sm" onClick={() => { setHistorical(false); load().catch((err) => setError(String(err))); }}>
                返回最新运行 <ArrowRight size={13} />
              </button>
            </div>
          </div>
        )}

        {/* 工作台主双栏布局，中间带可拖拽 resizer */}
        {mainTab === "graph" && (
          <section className={`workbench ${isResizing ? "resizing" : ""}`} ref={workbenchRef}>
          {/* 左侧对话与日志面板 */}
          <div className="conversation-pane" style={{ width: `${leftWidth}px` }}>
            <div className="pane-tabs">
              <button
                className={tab === "conversation" ? "active" : ""}
                onClick={() => setTab("conversation")}
              >
                <MessageSquare size={14} />节点详情与会话
              </button>
              <button
                className={tab === "history" ? "active" : ""}
                onClick={() => setTab("history")}
              >
                <History size={14} />事件历史
                <span>{state.events.filter((event) => event.type !== "output").length}</span>
              </button>
            </div>

            {tab === "conversation" ? (
              selectedNode ? (
                <>
                  <div className="conversation-heading">
                    <div className="detail-icon">
                      <Code2 size={18} />
                    </div>
                    <div className="heading-title-col">
                      <h2>{selectedNode.name}</h2>
                      <span>
                        Revision {selectedState?.revision ?? 1} <b>·</b>{" "}
                        {attempts.length ? `${attempts.length} 次执行尝试` : "等待启动"}
                      </span>
                    </div>
                    <button
                      className="back-to-query-btn"
                      title="取消选中节点，返回查看全局初始任务目标"
                      onClick={() => setSelected("")}
                    >
                      <ArrowLeft size={12} />
                      <span>初始目标</span>
                    </button>
                    <span className={`status ${selectedState?.status ?? "waiting"}`}>
                      {statusText[selectedState?.status ?? "waiting"]}
                    </span>
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
                              #{item.attempt} · r{item.revision} · {item.status}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    {execution ? (
                      <>
                        <div className="session-label">
                          <span className="pi-avatar">π</span>
                          <strong>Pi Session</strong>
                          <span>{execution.status}</span>
                          <time>{new Date(execution.startedAt).toLocaleTimeString()}</time>
                        </div>
                        <pre className="execution-log">
                          {readableLog(execution.output) || "工作区就绪，等待输出…"}
                        </pre>
                        <details className="workspace-details">
                          <summary><FolderGit2 size={12} />工作区与会话信息</summary>
                          <p>Worktree: {execution.worktree}</p>
                          <p>Session ID: {execution.sessionId}</p>
                          <p>Commit Before: {execution.before}</p>
                          <p>Commit After: {execution.after ?? "pending"}</p>
                          <p className="details-tip">所有变更保存在独立 worktree，不会污染主分支。</p>
                        </details>
                      </>
                    ) : (
                      <div className="conversation-empty">
                        <div className="empty-orbit">
                          <Terminal size={22} />
                        </div>
                        <h3>全新独立上下文</h3>
                        <p>
                          审批通过后，该节点将在隔离的 Git worktree 中启动全新的 Pi 实例。<br />
                          执行进度、代码修改与工具调用流将在此呈现。
                        </p>
                      </div>
                    )}

                    {selectedState?.error && (
                      <div className="node-error">
                        {selectedState.error}
                        {selectedState.status === "blocked" && (
                          <button
                            className="secondary"
                            disabled={locked || active}
                            onClick={() => control("resolve")}
                          >
                            Use resolved workspace
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="pane-bottom-chat">
                    <PromptBox
                      layoutId="chatgpt-prompt-box"
                      compact
                      onSubmit={(val) => {
                        control("intervene", { instruction: val });
                      }}
                      placeholder={`向 [${selectedNode.name}] 发送微调或介入指令...`}
                      disabled={locked || active || !state.approved}
                    />
                  </div>
                </>
              ) : (
                <div className="initial-query-view">
                  <div className="initial-query-scroll">
                    <motion.div
                      layoutId="user-query-card"
                      className="initial-query-card"
                      initial={{ opacity: 0, y: 50, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{ type: "spring", stiffness: 120, damping: 20 }}
                    >
                      <div className="query-card-header">
                        <div className="user-info">
                          <span className="user-avatar-mark"><Sparkles size={13} /></span>
                          <strong>用户初始任务目标</strong>
                        </div>
                        <span className="query-status-badge">{isPlanning ? "规划中" : "First Query"}</span>
                      </div>
                      <motion.p
                        layoutId="user-query-content"
                        className="query-card-text"
                        transition={{ type: "spring", stiffness: 120, damping: 18 }}
                      >
                        {state.graph.originalGoal || goal || "尚未记录初始目标"}
                      </motion.p>
                      {isPlanning && (
                        <div className="query-planning-indicator">
                          <LoaderCircle size={14} className="spin" />
                          <span>AI 架构师正在分析仓库结构并编译有向执行图...</span>
                        </div>
                      )}
                    </motion.div>

                    <div className="plan-summary-card">
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
                                key={node.name}
                                className="node-chip"
                                onClick={() => setSelected(node.name)}
                                title={node.task}
                              >
                                <span className={`chip-dot ${nState?.status ?? "waiting"}`} />
                                <span className="chip-name">{node.name}</span>
                                <span className="chip-rev">r{nState?.revision ?? 1}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="pane-bottom-chat">
                    <PromptBox
                      layoutId="chatgpt-prompt-box"
                      compact
                      onSubmit={(val) => {
                        control("intervene", { instruction: val });
                      }}
                      placeholder="向工作图追加全局指令或修改规划要求..."
                      disabled={locked || active || !state.approved}
                    />
                  </div>
                </div>
              )
            ) : (
              <div className="timeline">
                {state.events.filter((event) => event.type !== "output").length === 0 ? (
                  <div className="timeline-empty">
                    <Clock3 size={24} />
                    <h3>暂无执行流水</h3>
                    <p>审批、节点执行、测试反馈与人工介入记录将写入流水。</p>
                  </div>
                ) : (
                  state.events
                    .filter((event) => event.type !== "output")
                    .slice()
                    .reverse()
                    .map((event) => (
                      <div className="timeline-event" key={event.sequence}>
                        <span className={`event-dot ${event.type}`} />
                        <div>
                          <strong>{event.type.replaceAll("_", " ")}</strong>
                          <p>
                            {event.node ??
                              event.execution?.node ??
                              (event.from ? `${event.from} → ${event.to}` : `事件 #${event.sequence}`)}
                            {event.type === "feedback"
                              ? event.accepted
                                ? " · ACCEPT"
                                : " · REVISE"
                              : ""}
                          </p>
                          {event.error && <p className="event-error">{event.error}</p>}
                          <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
                        </div>
                      </div>
                    ))
                )}
              </div>
            )}
          </div>

          {/* 左右可调节分割器 */}
          <div
            className={`workbench-resizer ${isResizing ? "active" : ""}`}
            onMouseDown={handleStartResize}
            onDoubleClick={handleResetResizer}
            title="按住左右拖动调节宽度，双击恢复默认"
          >
            <div className="resizer-handle" />
          </div>

          {/* 右侧执行拓扑图面板 */}
          <div className="graph-pane">
            <div className="graph-toolbar">
              <div className="toolbar-left">
                <Workflow size={15} />
                <strong>执行拓扑图</strong>
                <span className={`phase ${state.phase}`}>{phaseText[state.phase] ?? "草稿"}</span>
              </div>
              <div className="toolbar-right">
                <button
                  className="icon-button"
                  title="编辑 Graph IR"
                  onClick={() => {
                    setEditor(JSON.stringify(state.graph.nodes.length ? state.graph : emptyGraph, null, 2));
                    setModal("editor");
                  }}
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
                            <strong>{repoInfo?.name || config.repository.split("/").pop()}</strong>
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
                        <button className="secondary" onClick={handlePickRepository}>
                          <FolderGit2 size={14} />选择 / 切换本地目录
                        </button>
                        <button className="secondary" onClick={() => handleDetectRepository()}>
                          <RotateCcw size={14} />重新检测
                        </button>
                        <button
                          className="secondary"
                          onClick={() => {
                            setEditor(JSON.stringify(emptyGraph, null, 2));
                            setModal("editor");
                          }}
                        >
                          <Code2 size={14} />编写 Graph IR
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <h3>未检测到本地 Git 仓库</h3>
                      <p>
                        Grapher 需要绑定一个本地 Git 项目来创建确定性的隔离 worktree 并发工作流。请通过下方按钮选择本地项目文件夹，或在仓库目录下启动。
                      </p>
                      <div className="empty-actions">
                        <button className="primary" onClick={handlePickRepository}>
                          <FolderGit2 size={15} />选择本地项目文件夹
                        </button>
                        <button className="secondary" onClick={() => handleDetectRepository()}>
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
                    onNodeClick={(_, node) => {
                      setSelected(node.id);
                      setTab("conversation");
                    }}
                    onPaneClick={() => {
                      setSelected("");
                      setTab("conversation");
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
                    <span />Planner {state.approved ? "已离线" : "未启动"}
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
                  <span>并发限制 {state.config?.maxParallel ?? config.maxParallel}</span>
                </div>
                <div className="progress-track">
                  <div style={{ width: `${(completed / Math.max(1, state.graph.nodes.length)) * 100}%` }} />
                </div>

                <div className="approval-row">
                  <span>
                    <ShieldCheck size={16} />
                    {state.approved ? "确定性运行时正在推进" : "需用户审核并批准计划"}
                  </span>
                  <div>
                    {state.phase === "awaiting_approval" ? (
                      <>
                        <button className="text-button" disabled={locked} onClick={() => control("reject")}>
                          拒绝
                        </button>
                        <button className="primary" disabled={locked} onClick={() => setModal("approval")}>
                          <Play size={13} fill="currentColor" />Approve & Start
                        </button>
                      </>
                    ) : state.approved ? (
                      <>
                        <button
                          className="secondary"
                          disabled={locked || active || !selected}
                          onClick={() => control("intervene", { instruction: "Rerun this task and verify the latest workspace state." })}
                        >
                          <RotateCcw size={13} />重跑选定节点
                        </button>
                        <button
                          className="primary"
                          disabled={locked || state.phase === "completed"}
                          onClick={() => control(state.paused ? "resume" : "pause")}
                        >
                          {state.paused ? <Play size={13} /> : <Pause size={13} />}
                          {state.paused ? "继续" : "暂停"}
                        </button>
                      </>
                    ) : (
                      <button className="secondary" disabled={locked || active} onClick={() => save({ ...state.graph, originalGoal: goal })}>
                        <Check size={14} />编译并检查
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
        )}

        {mainTab === "sessions" && (
          <section className="full-tab-view sessions-view">
            <div className="sessions-container">
              <aside className="sessions-node-list">
                <div className="sessions-list-header">
                  <span>节点列表 ({state.graph.nodes.length})</span>
                </div>
                <div className="sessions-list-scroll">
                  {state.graph.nodes.length > 0 ? (
                    state.graph.nodes.map((node) => {
                      const nState = state.nodes[node.name];
                      const nAttempts = state.executions.filter((e) => e.node === node.name);
                      const isSel = selected === node.name;
                      return (
                        <button
                          key={node.name}
                          className={`session-node-card ${isSel ? "active" : ""}`}
                          onClick={() => setSelected(node.name)}
                        >
                          <div className="card-top">
                            <span className={`status-indicator ${nState?.status ?? "waiting"}`} />
                            <strong>{node.name}</strong>
                            <span className="badge">r{nState?.revision ?? 1}</span>
                          </div>
                          <p className="card-task">{node.task}</p>
                          <div className="card-bottom">
                            <span className={`status-text ${nState?.status ?? "waiting"}`}>
                              {statusText[nState?.status ?? "waiting"]}
                            </span>
                            <span className="attempts-count">{nAttempts.length} 次尝试</span>
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <div className="sessions-empty-hint">
                      <Code2 size={24} />
                      <span>暂无节点</span>
                      <small>在上方输入任务目标后编译生成</small>
                    </div>
                  )}
                </div>
              </aside>

              <div className="sessions-content">
                {selectedNode ? (
                  <div className="sessions-detail-pane">
                    <div className="sessions-detail-header">
                      <div className="detail-meta">
                        <Code2 size={18} />
                        <h3>{selectedNode.name}</h3>
                        <span className={`phase-tag ${selectedState?.status ?? "waiting"}`}>
                          {statusText[selectedState?.status ?? "waiting"]}
                        </span>
                        <span className="rev-info">Revision {selectedState?.revision ?? 1}</span>
                      </div>
                      {attempts.length > 0 && (
                        <div className="attempt-select-wrap">
                          <span>执行记录:</span>
                          <select
                            value={execution?.id ?? ""}
                            onChange={(e) => setAttemptId(e.target.value)}
                          >
                            {attempts.map((item) => (
                              <option key={item.id} value={item.id}>
                                #{item.attempt} · r{item.revision} · {item.status} · {new Date(item.startedAt).toLocaleTimeString()}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>

                    <div className="sessions-task-box">
                      <div className="task-label"><Terminal size={13} /> TASK SPECIFICATION</div>
                      <p>{selectedNode.task}</p>
                    </div>

                    {execution ? (
                      <div className="sessions-log-container">
                        <div className="log-header">
                          <div className="log-header-left">
                            <span className="pi-avatar">π</span>
                            <strong>Pi Session Log</strong>
                            <span className="log-status">{execution.status}</span>
                            <time>{new Date(execution.startedAt).toLocaleString()}</time>
                          </div>
                          {execution.worktree && (
                            <span className="worktree-pill" title={execution.worktree}>
                              <FolderGit2 size={11} />
                              {execution.worktree.split("/").slice(-2).join("/")}
                            </span>
                          )}
                        </div>
                        <pre className="full-execution-log">
                          {readableLog(execution.output) || "工作区就绪，等待节点指令输出…"}
                        </pre>
                        <div className="worktree-info-footer">
                          <span>Session: <code>{execution.sessionId}</code></span>
                          <span>Commit Before: <code>{execution.before ? execution.before.slice(0, 7) : "-"}</code></span>
                          <span>Commit After: <code>{execution.after ? execution.after.slice(0, 7) : "pending"}</code></span>
                        </div>
                      </div>
                    ) : (
                      <div className="sessions-no-execution">
                        <Terminal size={28} />
                        <h4>全新独立上下文</h4>
                        <p>该节点尚未启动或正在等待前驱依赖完成。计划审批启动后，将在隔离 Git worktree 中执行。</p>
                      </div>
                    )}

                    <form
                      className="intervention"
                      onSubmit={(event) => {
                        event.preventDefault();
                        control("intervene");
                      }}
                    >
                      <textarea
                        aria-label="节点介入指令"
                        value={instruction}
                        onChange={(event) => setInstruction(event.target.value)}
                        placeholder={
                          active
                            ? "执行进行中，先暂停再发送介入指令…"
                            : !state.approved
                            ? "计划审批并启动后可向节点发送介入指令…"
                            : "向该节点发送调整或重写指令…"
                        }
                        disabled={locked || active || !state.approved}
                      />
                      <div>
                        <span>
                          <GitBranch size={12} />仅增量重跑下游子图
                        </span>
                        <button
                          type="submit"
                          title="发送介入指令"
                          disabled={locked || active || !state.approved || !instruction.trim()}
                        >
                          <ArrowRight size={16} />
                        </button>
                      </div>
                    </form>
                  </div>
                ) : (
                  <div className="sessions-select-empty">
                    <Terminal size={36} />
                    <h3>{state.graph.nodes.length === 0 ? "暂无节点数据" : "请在左侧选择一个节点"}</h3>
                    <p>
                      {state.graph.nodes.length === 0
                        ? "输入工作目标后，AI 将自动编译并呈现执行工作图。"
                        : "选择任意节点可查看其隔离 worktree 会话、完整执行终端日志并实时下发修正指令。"}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {mainTab === "timeline" && (
          <section className="full-tab-view timeline-view">
            <div className="timeline-page-container">
              <div className="timeline-page-header">
                <div className="timeline-title-area">
                  <History size={18} />
                  <div>
                    <h3>项目事件执行流水 (Audit Log)</h3>
                    <small>确定性状态机按序记录的所有关键决策、依赖推进、代码提交与测试反馈。</small>
                  </div>
                </div>
                <div className="timeline-filter-pills">
                  {["all", "node", "feedback", "intervention", "approval"].map((f) => (
                    <button
                      key={f}
                      className={`filter-pill ${timelineFilter === f ? "active" : ""}`}
                      onClick={() => setTimelineFilter(f)}
                    >
                      {f === "all" ? "全部事件" : f === "node" ? "节点执行" : f === "feedback" ? "反馈复审" : f === "intervention" ? "人工介入" : "计划审批"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="timeline-page-feed">
                {state.events.filter((event) => {
                  if (event.type === "output") return false;
                  if (timelineFilter === "all") return true;
                  if (timelineFilter === "node") return ["node_started", "node_completed", "node_failed"].includes(event.type);
                  if (timelineFilter === "feedback") return event.type === "feedback";
                  if (timelineFilter === "intervention") return event.type === "intervene";
                  if (timelineFilter === "approval") return ["approved", "rejected", "paused", "resumed"].includes(event.type);
                  return true;
                }).length === 0 ? (
                  <div className="timeline-empty-large">
                    <Clock3 size={36} />
                    <h4>暂无事件记录</h4>
                    <p>当审批通过并开始推进节点时，事件流将实时按序显示在此处。</p>
                  </div>
                ) : (
                  state.events
                    .filter((event) => {
                      if (event.type === "output") return false;
                      if (timelineFilter === "all") return true;
                      if (timelineFilter === "node") return ["node_started", "node_completed", "node_failed"].includes(event.type);
                      if (timelineFilter === "feedback") return event.type === "feedback";
                      if (timelineFilter === "intervention") return event.type === "intervene";
                      if (timelineFilter === "approval") return ["approved", "rejected", "paused", "resumed"].includes(event.type);
                      return true;
                    })
                    .slice()
                    .reverse()
                    .map((event) => (
                      <div className="timeline-card" key={event.sequence}>
                        <div className="card-seq">#{event.sequence}</div>
                        <span className={`event-badge-dot ${event.type}`} />
                        <div className="card-main">
                          <div className="card-title-row">
                            <strong>{event.type.replaceAll("_", " ").toUpperCase()}</strong>
                            <time>{new Date(event.timestamp).toLocaleString()}</time>
                          </div>
                          <p className="card-desc">
                            {event.node ? (
                              <>节点: <code>{event.node}</code></>
                            ) : event.execution?.node ? (
                              <>执行节点: <code>{event.execution.node}</code></>
                            ) : event.from ? (
                              <>{event.from} → {event.to}</>
                            ) : (
                              `执行事件 #${event.sequence}`
                            )}
                            {event.type === "feedback" && (
                              <span className={`feedback-tag ${event.accepted ? "accept" : "revise"}`}>
                                {event.accepted ? "✓ ACCEPTED" : "↻ REVISE REQUIRED"}
                              </span>
                            )}
                          </p>
                          {event.error && <div className="card-error">{event.error}</div>}
                          {event.instruction && (
                            <div className="card-instruction">
                              <span>介入指令:</span> {event.instruction}
                            </div>
                          )}
                          {event.execution && (
                            <div className="card-exec-meta">
                              <span>Worktree: <code>{event.execution.worktree}</code></span>
                              <span>Commit: <code>{event.execution.after || event.execution.before}</code></span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                )}
              </div>
            </div>
          </section>
        )}

        {mainTab === "settings" && (
          <section className="full-tab-view settings-view">
            <div className="settings-page-container">
              <div className="settings-page-header">
                <Settings2 size={20} />
                <div>
                  <h3>项目与引擎运行配置</h3>
                  <small>管理当前工作区关联的本地 Git 仓库路径、AI 执行引擎及并发参数。</small>
                </div>
              </div>

              <div className="settings-sections">
                {/* Section 1: 本地 Git 仓库 */}
                <div className="settings-card">
                  <div className="settings-card-title">
                    <FolderGit2 size={16} />
                    <h4>本地 Git 仓库绑定</h4>
                  </div>
                  <p className="section-desc">
                    Grapher 在本地 Git 仓库基础上使用 <code>git worktree</code> 为每个并发节点创建隔离沙箱，保证主分支安全。
                  </p>
                  <div className="setting-input-row">
                    <input
                      className="repo-path-input"
                      value={config.repository}
                      onChange={(e) => setConfig({ ...config, repository: e.target.value })}
                      placeholder="/Users/username/Projects/my-app"
                    />
                    <button
                      type="button"
                      className="secondary"
                      onClick={handleOpenProject}
                      title="调起系统文件夹选择器"
                    >
                      <FolderGit2 size={14} /> 浏览本地目录
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleDetectRepository(config.repository || undefined)}
                      title="检测 Git 信息"
                    >
                      <RotateCcw size={14} /> 检测状态
                    </button>
                  </div>

                  {repoInfo ? (
                    <div className="repo-status-card">
                      <div className="repo-status-header">
                        <span className="repo-name">
                          <FolderGit2 size={15} />
                          <strong>{repoInfo.name}</strong>
                        </span>
                        <span className={`status-badge ${repoInfo.clean ? "clean" : "warning"}`}>
                          {repoInfo.clean ? "✓ 工作树干净 (Clean)" : "⚠ 有未提交改动 (Dirty)"}
                        </span>
                      </div>
                      <div className="repo-status-meta">
                        <span>当前分支: <code>{repoInfo.branch}</code></span>
                        {repoInfo.head && <span>HEAD: <code>{repoInfo.head}</code></span>}
                      </div>
                      <div className="repo-status-path">{repoInfo.path}</div>
                    </div>
                  ) : (
                    <div className="repo-status-hint">
                      提示：未检测到有效 Git 信息，请确保选择的文件夹包含 <code>.git</code>。
                    </div>
                  )}
                </div>

                {/* Section 2: 执行引擎与模型 */}
                <div className="settings-card">
                  <div className="settings-card-title">
                    <Terminal size={16} />
                    <h4>执行引擎与模型设置</h4>
                  </div>
                  <div className="form-grid">
                    <label className="form-field">
                      <span>执行引擎</span>
                      <select
                        value={config.engine}
                        onChange={(e) => setConfig({ ...config, engine: e.target.value as Config["engine"] })}
                      >
                        <option value="pi">Pi · 真实模型调用与代码执行</option>
                        <option value="demo">Demo · 隔离演示模式（不调用外部模型）</option>
                      </select>
                    </label>

                    <label className="form-field">
                      <span>指定模型（留空使用 Pi 默认配置）</span>
                      <input
                        value={config.model}
                        onChange={(e) => setConfig({ ...config, model: e.target.value })}
                        placeholder="例如: qwen3.8-max-0902 或 provider/model"
                      />
                    </label>

                    <label className="form-field">
                      <span>Pi 命令 / 可执行文件路径</span>
                      <input
                        value={config.piCommand}
                        onChange={(e) => setConfig({ ...config, piCommand: e.target.value })}
                        placeholder="pi 或 /usr/local/bin/pi"
                      />
                    </label>

                    <label className="form-field">
                      <span>并发执行节点上限</span>
                      <input
                        type="number"
                        min={1}
                        max={8}
                        value={config.maxParallel}
                        onChange={(e) => setConfig({ ...config, maxParallel: Number(e.target.value) })}
                      />
                    </label>

                    <label className="form-field">
                      <span>反馈重试上限</span>
                      <input
                        type="number"
                        min={0}
                        max={10}
                        value={config.maxFeedback}
                        onChange={(e) => setConfig({ ...config, maxFeedback: Number(e.target.value) })}
                      />
                    </label>
                  </div>

                  <label className="form-field full-width">
                    <span>Pi 启动额外参数（JSON 字符串数组）</span>
                    <textarea
                      value={args}
                      onChange={(e) => setArgs(e.target.value)}
                      rows={3}
                      placeholder='["--verbose"]'
                    />
                  </label>
                </div>

                {/* Section 3: 数据管理 */}
                <div className="settings-card">
                  <div className="settings-card-title">
                    <RotateCcw size={16} />
                    <h4>存储与重置</h4>
                  </div>
                  <p className="section-desc">
                    Grapher 将运行时快照与事件保存在本地 SQLite 数据库中。路径：<code>{dataPath || "本地系统应用目录"}</code>
                  </p>
                  <div className="danger-actions-row">
                    <button type="button" className="secondary" onClick={handleResetWorkspace}>
                      <Plus size={14} /> 重置当前工作区图
                    </button>
                    <button type="button" className="secondary danger-btn" onClick={handleClearHistory}>
                      <RotateCcw size={14} /> 清空所有历史运行快照
                    </button>
                  </div>
                </div>

                <div className="settings-save-bar">
                  <button type="button" className="primary save-config-btn" onClick={handleSaveConfig}>
                    <Check size={16} /> 保存所有配置
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        <footer className="workspace-footer">
          <span>
            <span />
            {desktop ? "Local deterministic runtime · SQLite event store" : "Web UI Preview · No runtime connected"}
          </span>
          <span>Git carries workspace state.<ArrowDown size={11} /> Humans stay in control.</span>
        </footer>
          </>
        )}
      </main>

      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            className={`modal ${modal === "editor" ? "wide" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <header>
              <h2 id="modal-title">
                {modal === "settings"
                  ? "运行环境配置"
                  : modal === "editor"
                  ? "Graph IR · 编辑与编译"
                  : "审批执行图计划"}
              </h2>
              <button className="icon-button" aria-label="关闭弹窗" onClick={() => setModal(null)}>
                <X size={18} />
              </button>
            </header>

            {error && <div className="error-banner" role="alert">{error}</div>}

            {modal === "settings" ? (
              <>
                <div className="settings-grid">
                  <label>
                    执行引擎
                    <select
                      value={config.engine}
                      onChange={(event) => setConfig({ ...config, engine: event.target.value as Config["engine"] })}
                    >
                      <option value="pi">Pi · 真实模型与代码执行</option>
                      <option value="demo">Demo · 隔离演示仓库</option>
                    </select>
                  </label>
                  <div className="repo-setting-box">
                    <label>
                      <span>Git 仓库根路径</span>
                      <div className="repo-input-group">
                        <input
                          value={config.repository}
                          onChange={(event) => setConfig({ ...config, repository: event.target.value })}
                          placeholder="/Users/you/project"
                        />
                        <button
                          type="button"
                          className="secondary btn-repo-action"
                          title="在 Finder 中浏览并选择本地文件夹"
                          onClick={handlePickRepository}
                        >
                          <FolderGit2 size={13} />
                          浏览
                        </button>
                        <button
                          type="button"
                          className="secondary btn-repo-action"
                          title="重新检测当前工作目录或输入路径"
                          onClick={() => handleDetectRepository(config.repository || undefined)}
                        >
                          <RotateCcw size={13} />
                          检测
                        </button>
                      </div>
                    </label>

                    {repoInfo ? (
                      <div className="repo-status-card">
                        <div className="repo-status-header">
                          <span className="repo-name">
                            <FolderGit2 size={14} />
                            <strong>{repoInfo.name}</strong>
                          </span>
                          <span className={`status-badge ${repoInfo.clean ? "clean" : "warning"}`}>
                            {repoInfo.clean ? "工作树干净 (Ready)" : "有未提交改动 (Dirty)"}
                          </span>
                        </div>
                        <div className="repo-status-meta">
                          <span>分支: <code>{repoInfo.branch}</code></span>
                          {repoInfo.head && <span>HEAD: <code>{repoInfo.head}</code></span>}
                        </div>
                      </div>
                    ) : (
                      <div className="repo-status-hint">
                        提示：Grapher 将在此 Git 仓库中创建隔离临时 worktree 并发执行任务。
                      </div>
                    )}
                  </div>
                  <label>
                    Pi 可执行文件路径 / 命令
                    <input
                      value={config.piCommand}
                      onChange={(event) => setConfig({ ...config, piCommand: event.target.value })}
                      placeholder="pi 或 /path/to/node"
                    />
                  </label>
                  <label>
                    Pi 启动额外参数（JSON 数组）
                    <textarea
                      value={args}
                      onChange={(event) => setArgs(event.target.value)}
                      rows={3}
                    />
                  </label>
                  <label>
                    模型（留空使用 Pi 默认配置）
                    <input
                      value={config.model}
                      onChange={(event) => setConfig({ ...config, model: event.target.value })}
                      placeholder="provider/model，如 qwen3.8-max-0902"
                    />
                  </label>
                  <div className="field-pair">
                    <label>
                      并发上限
                      <input
                        type="number"
                        min={1}
                        max={8}
                        value={config.maxParallel}
                        onChange={(event) => setConfig({ ...config, maxParallel: Number(event.target.value) })}
                      />
                    </label>
                    <label>
                      反馈重试上限
                      <input
                        type="number"
                        min={0}
                        max={10}
                        value={config.maxFeedback}
                        onChange={(event) => setConfig({ ...config, maxFeedback: Number(event.target.value) })}
                      />
                    </label>
                  </div>
                  <p className="settings-note">
                    设置将保存并应用到下一次编译。Pi 使用独立登录凭据或本地环境变量。<br />
                    持久化数据目录：{dataPath || "桌面端启动后就绪"}
                  </p>
                </div>
                <footer>
                  <button
                    className="primary"
                    onClick={() => {
                      try {
                        const value: unknown = JSON.parse(args);
                        if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
                          throw new Error("启动参数必须是字符串 JSON 数组，如 [\"--flag\"]");
                        }
                        setConfig({ ...config, piArgs: value });
                        setModal(null);
                      } catch (err) {
                        setError(String(err));
                      }
                    }}
                  >
                    保存配置<Check size={14} />
                  </button>
                </footer>
              </>
            ) : modal === "editor" ? (
              <>
                <p className="modal-description">
                  使用语义化 name 声明节点与前驱后继依赖关系。保存后将通过 Rust 编译器校验并创建待审批运行。
                </p>
                <textarea
                  className="json-editor"
                  aria-label="Graph JSON"
                  value={editor}
                  onChange={(event) => setEditor(event.target.value)}
                  spellCheck={false}
                />
                <footer>
                  <button
                    className="secondary"
                    onClick={() => setEditor(JSON.stringify(emptyGraph, null, 2))}
                  >
                    清空模板
                  </button>
                  <button
                    className="primary"
                    disabled={busy || active}
                    onClick={() => {
                      try {
                        save(JSON.parse(editor) as Graph);
                      } catch (err) {
                        setError(String(err));
                      }
                    }}
                  >
                    <Check size={14} />校验并应用
                  </button>
                </footer>
              </>
            ) : (
              <>
                <div className="approval-summary">
                  <ShieldCheck size={32} />
                  <h3>{state.graph.nodes.length} 个节点，{state.plan?.executionBatches.length} 个执行层</h3>
                  <p>{state.graph.originalGoal}</p>
                  <ul>
                    <li>
                      {state.config?.engine === "demo"
                        ? "在演示隔离环境中运行，不消耗实际模型 Token。"
                        : `在仓库 ${state.config?.repository || config.repository} 创建独立 Git worktree。`}
                    </li>
                    <li>每个节点分配独立隔离会话；验证失败最多自动反馈重试 {state.config?.maxFeedback ?? config.maxFeedback} 次。</li>
                    <li>完全不修改或破坏你的主开发目录。</li>
                    {state.config?.engine === "pi" && (
                      <li className="warning">
                        Pi 可执行 shell 指令并调用模型，请审视节点任务定义后再行批准。
                      </li>
                    )}
                  </ul>
                  {state.plan?.warnings.map((warning) => (
                    <p className="warning" key={warning}>{warning}</p>
                  ))}
                </div>
                <footer>
                  <button
                    className="secondary"
                    onClick={() => {
                      setEditor(JSON.stringify(state.graph, null, 2));
                      setModal("editor");
                    }}
                  >
                    调整计划
                  </button>
                  <button className="primary" disabled={busy} onClick={() => control("approve")}>
                    <Play size={14} />确认审批并启动
                  </button>
                </footer>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
