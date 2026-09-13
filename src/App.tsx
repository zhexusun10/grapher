import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, BaseEdge, getBezierPath, type NodeProps, type Node, type Edge, type EdgeProps } from "@xyflow/react";
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, Circle,
  Clock3, Code2, Compass, Copy, FolderGit2, GitBranch, GitFork, History,
  LoaderCircle, MessageSquare, Pause, Play, Plus, RotateCcw,
  Settings2, ShieldCheck, Sparkles, Terminal, Trash2, Workflow, X
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { PromptBox } from "@/components/ui/chatgpt-prompt-input";
import {
  defaultConfig, emptyGraph, emptySnapshot,
  type Bootstrap, type Config, type Graph, type ProjectItem, type RepositoryInfo,
  type Snapshot, type Status, type PlanRouteType, type TranscriptItem
} from "./types";
import { tokens } from "./tokens";
import { runtimeService } from "./services/runtime";
import { ProviderSettings } from "./components/ProviderSettings";
import { MarkdownRenderer } from "./components/MarkdownRenderer";
import { ToolCallCard } from "./components/ToolCallCard";
import { VirtualizedTranscript } from "./components/VirtualizedTranscript";

function deduceRouteType(snap: Snapshot): PlanRouteType {
  if (snap.graph.nodes.length > 1) return "graph";
  if (snap.graph.nodes.length === 1 && snap.graph.nodes[0].name === "task") return "serial";
  if (snap.graph.nodes.length === 1) return "graph";
  return "undecided";
}



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
  hint: string;
  reviewer: boolean;
  selected: boolean;
  worktree: string;
  hasTop: boolean;
  hasBottom: boolean;
  hasLeftTarget: boolean;
  hasLeftSource: boolean;
  hasRightTarget: boolean;
  hasRightSource: boolean;
}, "work">;

function TaskNode({ data }: NodeProps<WorkNode>) {
  return (
    <div
      className={`task-node ${data.selected ? "selected" : ""} ${data.status}`}
      title={`${data.task}${data.hint ? `\n\n依赖关系:\n${data.hint}` : ""}\n尝试: ${data.attempts}\n工作区: ${data.worktree || "未生成"}`}
    >
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        className={`react-flow__handle ${data.hasTop ? "connected" : ""}`}
      />
      <div className="node-heading">
        <span className={`node-icon ${data.reviewer ? "review" : ""}`}>
          {data.reviewer ? <ShieldCheck size={16} /> : <Code2 size={16} />}
        </span>
        <strong>{data.name}</strong>
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
      <Handle
        id="bottom"
        type="source"
        position={Position.Bottom}
        className={`react-flow__handle ${data.hasBottom ? "connected" : ""}`}
      />
      <Handle
        id="left-target"
        type="target"
        position={Position.Left}
        className={`react-flow__handle ${data.hasLeftTarget ? "connected feedback" : ""}`}
      />
      <Handle
        id="left-source"
        type="source"
        position={Position.Left}
        className={`react-flow__handle ${data.hasLeftSource ? "connected feedback" : ""}`}
      />
      <Handle
        id="right-target"
        type="target"
        position={Position.Right}
        className={`react-flow__handle ${data.hasRightTarget ? "connected feedback" : ""}`}
      />
      <Handle
        id="right-source"
        type="source"
        position={Position.Right}
        className={`react-flow__handle ${data.hasRightSource ? "connected feedback" : ""}`}
      />
    </div>
  );
}

function SmoothWorkflowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition = Position.Bottom,
  targetPosition = Position.Top,
  style,
  markerEnd,
  markerStart,
  label,
  labelStyle,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  interactionWidth,
}: EdgeProps) {
  let path: string;
  let labelX: number;
  let labelY: number;

  if (sourcePosition === Position.Bottom && targetPosition === Position.Top && targetY > sourceY) {
    // 垂直流向下游卡片：在到达目标卡片（以及箭头）之前预留一段纯垂直直线引线，
    // 确保连线从三角箭头的正中心轴笔直穿入，彻底杜绝从箭头侧翼斜穿或歪歪扭扭的现象
    const dy = targetY - sourceY;
    const lead = Math.min(26, Math.max(16, dy * 0.22));
    const p1Y = sourceY + lead;
    const p2Y = targetY - lead;
    const midY = (p1Y + p2Y) / 2;

    path = `M ${sourceX},${sourceY} L ${sourceX},${p1Y} C ${sourceX},${midY} ${targetX},${midY} ${targetX},${p2Y} L ${targetX},${targetY}`;
    labelX = (sourceX + targetX) / 2;
    labelY = midY;
  } else {
    const [p, lx, ly] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
    path = p;
    labelX = lx;
    labelY = ly;
  }

  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      markerEnd={markerEnd}
      markerStart={markerStart}
      label={label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={labelStyle}
      labelShowBg={!!label}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
      interactionWidth={interactionWidth ?? 24}
    />
  );
}

const nodeTypes = { work: TaskNode };
const edgeTypes = { workflow: SmoothWorkflowEdge };

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
  const [mainTab, setMainTab] = useState<"graph" | "sessions" | "timeline">("graph");
  const [goal, setGoal] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [modal, setModal] = useState<"settings" | "editor" | "approval" | null>(null);
  const [editor, setEditor] = useState("");
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspaceRuns, setWorkspaceRuns] = useState<Record<string, string[]>>(() => {
    try {
      const saved = localStorage.getItem("grapher_workspace_runs");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const currentRepoPath = useMemo(() => config.repository || repoInfo?.path || "default", [config.repository, repoInfo]);
  const runs = useMemo(() => workspaceRuns[currentRepoPath] || [], [workspaceRuns, currentRepoPath]);
  const [attemptId, setAttemptId] = useState("");
  const [dataPath, setDataPath] = useState("");
  const [timelineFilter, setTimelineFilter] = useState<string>("all");
  const [isPlanning, setIsPlanning] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; project: ProjectItem } | null>(null);
  const [runContextMenu, setRunContextMenu] = useState<{ x: number; y: number; runId: string } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    detail?: string;
    confirmText: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);

  const recordRunToWorkspace = (runId: string, repo: string = currentRepoPath) => {
    setWorkspaceRuns((prev) => {
      const existing = prev[repo] || [];
      const nextList = [runId, ...existing.filter((id) => id !== runId)];
      const updated = { ...prev, [repo]: nextList };
      try {
        localStorage.setItem("grapher_workspace_runs", JSON.stringify(updated));
      } catch {}
      return updated;
    });
  };

  // 对话流消息记录（Chatbot 模式）
  const [messages, setMessages] = useState<Array<{ id: string; role: "user" | "assistant"; text: string; timestamp?: number }>>([]);
  const [routeType, setRouteType] = useState<PlanRouteType>(() => deduceRouteType(emptySnapshot));
  const [plannerStream, setPlannerStream] = useState<{
    stage: "idle" | "partitioning" | "planning" | "done" | "error";
    partitionerText: string;
    plannerText: string;
    tools: TranscriptItem[];
  }>({
    stage: "idle",
    partitionerText: "",
    plannerText: "",
    tools: [],
  });
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const effectiveMessages = useMemo(() => {
    if (messages.length > 0) return messages;
    const initialGoal = state.graph.originalGoal || goal;
    if (initialGoal) {
      return [
        {
          id: "msg-initial-goal",
          role: "user" as const,
          text: initialGoal,
        },
      ];
    }
    return [];
  }, [messages, state.graph.originalGoal, goal]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [effectiveMessages.length, isPlanning]);

  const handleSendMessage = (val: string) => {
    const text = val.trim();
    if (!text) return;
    const newMsg = {
      id: `msg-${Date.now()}`,
      role: "user" as const,
      text: selectedNode ? `[@${selectedNode.name}] ${text}` : text,
      timestamp: Date.now(),
    };
    setMessages((prev) => (prev.length > 0 ? [...prev, newMsg] : [...effectiveMessages, newMsg]));
    const targetNode = selectedNode?.name || (routeType === "serial" && state.graph.nodes.length > 0 ? (state.graph.nodes[0]?.name || "task") : undefined);
    control("intervene", { node: targetNode, instruction: text });
  };

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
    const data = await runtimeService.bootstrap();
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
          isShadow: info.isShadow,
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
    setDataPath(data.dataPath);
    if (data.runs && data.runs.length > 0) {
      const initialKey = data.config?.repository || data.repositoryInfo?.path || "default";
      setWorkspaceRuns((prev) => {
        if (!prev[initialKey] || prev[initialKey].length === 0) {
          const updated = { ...prev, [initialKey]: data.runs };
          try {
            localStorage.setItem("grapher_workspace_runs", JSON.stringify(updated));
          } catch {}
          return updated;
        }
        return prev;
      });
    }
    if (data.snapshot.runId) {
      setState(data.snapshot);
      setRouteType(deduceRouteType(data.snapshot));
      setGoal(data.snapshot.graph.originalGoal);
      if (data.snapshot.graph.nodes.length > 0) {
        setSelected((curr) => (curr && data.snapshot.graph.nodes.some(n => n.name === curr) ? curr : ""));
      }
    }
  }, []);

  const handleOpenProject = () => run(async () => {
    const info = await runtimeService.pickRepository();
    if (info) {
      setRepoInfo(info);
      setConfig((prev) => ({ ...prev, repository: info.path }));
      const item: ProjectItem = {
        id: info.path,
        name: info.name,
        path: info.path,
        branch: info.branch,
        clean: info.clean,
        isShadow: info.isShadow,
        lastOpened: Date.now(),
      };
      setProjects((prev) => {
        const next = [item, ...prev.filter((p) => p.path !== info.path)];
        try {
          localStorage.setItem("grapher_projects", JSON.stringify(next));
        } catch {}
        return next;
      });
      const snapshot = await runtimeService.resetWorkspace();
      setState(snapshot);
      setRouteType("undecided");
      setPlannerStream({ stage: "idle", partitionerText: "", plannerText: "", tools: [] });
      setGoal("");
      setSelected("");
      setError("");
    }
  });

  const handlePickRepository = handleOpenProject;

  const handleOpenSettings = () => {
    setModal("settings");
  };

  const handleSaveConfig = () => {
    setModal(null);
    setError("");
  };

  const handleSelectProject = (proj: ProjectItem) => run(async () => {
    if (config.repository === proj.path) return;
    const info = await runtimeService.detectRepository(proj.path);
    if (info) {
      setRepoInfo(info);
      setConfig((prev) => ({ ...prev, repository: info.path }));
      setProjects((prev) => {
        const next = prev.map((p) =>
          p.path === info.path
            ? { ...p, branch: info.branch, clean: info.clean, isShadow: info.isShadow, lastOpened: Date.now() }
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
    const projRuns = workspaceRuns[proj.path] || [];
    if (projRuns.length > 0) {
      try {
        const snapshot = await runtimeService.loadRun(projRuns[0]);
        setState(snapshot);
        setRouteType(deduceRouteType(snapshot));
        setGoal(snapshot.graph.originalGoal || "");
        if (snapshot.graph.nodes.length > 0) {
          setSelected(snapshot.graph.nodes[0].name);
        }
      } catch {
        const snapshot = await runtimeService.resetWorkspace();
        setState(snapshot);
        setRouteType("undecided");
        setPlannerStream({ stage: "idle", partitionerText: "", plannerText: "", tools: [] });
        setGoal("");
      }
    } else {
      const snapshot = await runtimeService.resetWorkspace();
      setState(snapshot);
      setRouteType("undecided");
      setPlannerStream({ stage: "idle", partitionerText: "", plannerText: "", tools: [] });
      setGoal("");
    }
    setError("");
  });

  const handleRemoveWorkspaceConfirm = (project: ProjectItem) => {
    setConfirmModal({
      title: "移除工作区",
      message: `确定从工作区列表中移除「${project.name}」吗？`,
      detail: `路径: ${project.path}\n这仅会从工作区列表中移除索引，不会删除磁盘上的代码文件。`,
      confirmText: "移除工作区",
      danger: true,
      onConfirm: () => {
        const pathToRemove = project.path;
        setProjects((prev) => {
          const next = prev.filter((p) => p.path !== pathToRemove);
          try {
            localStorage.setItem("grapher_projects", JSON.stringify(next));
          } catch {}
          return next;
        });
        setWorkspaceRuns((prev) => {
          const copy = { ...prev };
          delete copy[pathToRemove];
          try {
            localStorage.setItem("grapher_workspace_runs", JSON.stringify(copy));
          } catch {}
          return copy;
        });
        if (config.repository === pathToRemove) {
          handleResetWorkspace();
        }
      },
    });
  };

  const handleDeleteRun = (runIdToDelete: string) => run(async () => {
    await runtimeService.deleteRun(runIdToDelete);
    setWorkspaceRuns((prev) => {
      const existing = prev[currentRepoPath] || [];
      const nextList = existing.filter((id) => id !== runIdToDelete);
      const updated = { ...prev, [currentRepoPath]: nextList };
      try {
        localStorage.setItem("grapher_workspace_runs", JSON.stringify(updated));
      } catch {}
      return updated;
    });
    if (state.runId === runIdToDelete) {
      const snapshot = await runtimeService.resetWorkspace();
      setState(snapshot);
      setGoal("");
      setSelected("");
    }
  });

  const handleDeleteRunConfirm = (runId: string) => {
    setConfirmModal({
      title: "删除运行历史",
      message: `确定删除历史快照「Graph ${runId.slice(0, 8)}」吗？`,
      detail: `快照 ID: ${runId}\n删除后该次运行的执行拓扑图与事件记录将被彻底清除。`,
      confirmText: "删除历史",
      danger: true,
      onConfirm: () => handleDeleteRun(runId),
    });
  };

  const handleDetectRepository = (customPath?: string) => run(async () => {
    const info = await runtimeService.detectRepository(customPath || null);
    if (info) {
      setRepoInfo(info);
      setConfig((prev) => ({ ...prev, repository: info.path }));
      setError("");
    } else {
      setError("目标路径不存在或无法作为工作区加载。");
    }
  });

  const handleResetWorkspace = () => run(async () => {
    setMessages([]);
    const snapshot = await runtimeService.resetWorkspace();
    setState(snapshot);
    setRouteType("undecided");
    setPlannerStream({ stage: "idle", partitionerText: "", plannerText: "", tools: [] });
    setGoal("");
    setSelected("");
    setError("");
  });
  const handleClearHistory = () => {
    setConfirmModal({
      title: "清空运行历史",
      message: "确定清空当前工作区的所有历史运行记录吗？",
      detail: "当前工作区的所有历史运行快照与事件将被彻底清除，此操作不可撤销。",
      confirmText: "清空全部",
      danger: true,
      onConfirm: () => run(async () => {
        const data = await runtimeService.bootstrap();
        const snapshots = await Promise.all(data.runs.map((id) => runtimeService.history(id)));
        // The local sidebar index can be stale; authorize scope from persisted run config.
        const scopedIds = snapshots
          .filter((snapshot) => snapshot.config && (snapshot.config.repository || "default") === currentRepoPath)
          .map((snapshot) => snapshot.runId);
        for (const runId of scopedIds) {
          await runtimeService.deleteRun(runId);
          setWorkspaceRuns((prev) => {
            const updated = {
              ...prev,
              [currentRepoPath]: (prev[currentRepoPath] || []).filter((id) => id !== runId),
            };
            try {
              localStorage.setItem("grapher_workspace_runs", JSON.stringify(updated));
            } catch {}
            return updated;
          });
          if (state.runId === runId) {
            setState(emptySnapshot);
            setMessages([]);
            setGoal("");
            setSelected("");
          }
        }
      }),
    });
  };

  const handlePlanGoal = (inputGoal?: string) => run(async () => {
    const targetGoal = (inputGoal !== undefined ? inputGoal : goal).trim();
    if (!targetGoal) return;
    setGoal(targetGoal);
    setError("");
    setIsPlanning(true);
    setRouteType("undecided");
    setPlannerStream({
      stage: "partitioning",
      partitionerText: "",
      plannerText: "",
      tools: [],
    });
    setSelected("");
    setMessages([
      {
        id: `msg-${Date.now()}`,
        role: "user",
        text: targetGoal,
        timestamp: Date.now(),
      },
    ]);
    setState((prev) => ({
      ...prev,
      graph: {
        ...prev.graph,
        originalGoal: targetGoal,
      },
    }));
    try {
      if (!config.repository) {
        handleOpenSettings();
        setError("请先在左侧工作区选择绑定的本地 Git 仓库。");
        return;
      }
      const snapshot = await runtimeService.planGoalStream(targetGoal, config, (event) => {
        if (event.type === "partitioner") {
          const pEvent = event.event;
          if (pEvent?.type === "message_update" && pEvent.assistantMessageEvent?.type === "text_delta") {
            const delta = pEvent.assistantMessageEvent.delta;
            setPlannerStream((prev) => ({
              ...prev,
              partitionerText: prev.partitionerText + delta,
            }));
          } else if (pEvent?.type === "tool_execution_start") {
            const toolItem: TranscriptItem = {
              id: pEvent.toolCallId || `part_tool_${Date.now()}`,
              type: "tool_call",
              toolName: pEvent.toolName,
              toolCallId: pEvent.toolCallId,
              args: pEvent.args || {},
              status: "running",
              timestamp: Date.now(),
            };
            setPlannerStream((prev) => ({
              ...prev,
              tools: [...prev.tools, toolItem],
            }));
          } else if (pEvent?.type === "tool_execution_end") {
            const resText = (pEvent.result?.content ?? [])
              .filter((i: any) => i.type === "text")
              .map((i: any) => i.text)
              .join("\n");
            setPlannerStream((prev) => ({
              ...prev,
              tools: prev.tools.map((t) =>
                t.toolCallId === pEvent.toolCallId || t.toolName === pEvent.toolName
                  ? { ...t, result: resText, status: pEvent.isError ? "error" : "success" }
                  : t
              ),
            }));
          }
        } else if (event.type === "route_decision") {
          const planType = event.planType || "graph";
          setRouteType(planType);
          setPlannerStream((prev) => ({
            ...prev,
            stage: planType === "graph" ? "planning" : "done",
          }));
        } else if (event.type === "planner") {
          const pEvent = event.event;
          if (pEvent?.type === "message_update" && pEvent.assistantMessageEvent?.type === "text_delta") {
            const delta = pEvent.assistantMessageEvent.delta;
            setPlannerStream((prev) => ({
              ...prev,
              plannerText: prev.plannerText + delta,
            }));
          } else if (pEvent?.type === "tool_execution_start") {
            const toolItem: TranscriptItem = {
              id: pEvent.toolCallId || `plan_tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: "tool_call",
              toolName: pEvent.toolName,
              toolCallId: pEvent.toolCallId,
              args: pEvent.args || {},
              status: "running",
              timestamp: Date.now(),
            };
            setPlannerStream((prev) => ({
              ...prev,
              tools: [...prev.tools, toolItem],
            }));
          } else if (pEvent?.type === "tool_execution_end") {
            const resText = (pEvent.result?.content ?? [])
              .filter((i: any) => i.type === "text")
              .map((i: any) => i.text)
              .join("\n");
            setPlannerStream((prev) => ({
              ...prev,
              tools: prev.tools.map((t) =>
                t.toolCallId === pEvent.toolCallId || (t.toolName === pEvent.toolName && t.status === "running")
                  ? { ...t, result: resText, status: pEvent.isError ? "error" : "success" }
                  : t
              ),
            }));
          }
        } else if (event.type === "complete") {
          if (event.snapshot) {
            setState(event.snapshot);
            setRouteType(deduceRouteType(event.snapshot));
            recordRunToWorkspace(event.snapshot.runId);
          }
        }
      });
      setState(snapshot);
      setRouteType(deduceRouteType(snapshot));
      setMainTab("graph");
      recordRunToWorkspace(snapshot.runId);
      setSelected("");
      setPlannerStream((prev) => ({ ...prev, stage: "done" }));
    } catch (err) {
      setError(String(err));
      setPlannerStream((prev) => ({ ...prev, stage: "error" }));
    } finally {
      setIsPlanning(false);
    }
  });

  useEffect(() => {
    load().catch((err) => setError(String(err)));
  }, [load]);

  useEffect(() => {
    if (busy) return;

    const interval = setInterval(() => {
      runtimeService.snapshot()
        .then((newSnap) => {
          if (!newSnap || !newSnap.runId) return;
          setState((prev) => {
            if (
              prev.runId === newSnap.runId &&
              prev.phase === newSnap.phase &&
              prev.paused === newSnap.paused &&
              prev.approved === newSnap.approved &&
              prev.events.length === newSnap.events.length &&
              prev.executions.length === newSnap.executions.length &&
              JSON.stringify(prev.nodes) === JSON.stringify(newSnap.nodes) &&
              JSON.stringify(prev.feedbackCounts) === JSON.stringify(newSnap.feedbackCounts)
            ) {
              return prev;
            }
            return newSnap;
          });
        })
        .catch((err) => setError(String(err)));
    }, 700);
    return () => clearInterval(interval);
  }, [busy]);

  useEffect(() => {
    const handleClose = () => {
      setContextMenu(null);
      setRunContextMenu(null);
    };
    window.addEventListener("click", handleClose);
    window.addEventListener("contextmenu", handleClose);
    return () => {
      window.removeEventListener("click", handleClose);
      window.removeEventListener("contextmenu", handleClose);
    };
  }, []);

  useEffect(() => {
    setAttemptId("");
  }, [selected, state.runId]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err));
    } finally {
      setBusy(false);
    }
  };

  const control = (action: string, extra = {}) => run(async () => {
    const snapshot = await runtimeService.control(action, { node: selected, instruction, ...extra });
    setState(snapshot);
    setModal(null);
    if (action === "intervene") setInstruction("");
  });

  useEffect(() => {
    if (routeType === "serial" && state.phase === "awaiting_approval" && !busy) {
      control("approve");
    }
  }, [routeType, state.phase, busy]);

  const save = (graph: Graph) => run(async () => {
    const snapshot = await runtimeService.saveGraph(graph, config);
    setState(snapshot);
    setGoal(graph.originalGoal);
    setModal(null);
    recordRunToWorkspace(snapshot.runId);
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

  const serialNode = routeType === "serial" ? (state.graph.nodes.find((n) => n.name === "task") || state.graph.nodes[0]) : undefined;
  const serialNodeState = serialNode ? state.nodes[serialNode.name] : undefined;
  const serialAttempts = serialNode ? state.executions.filter((e) => e.node === serialNode.name) : [];
  const serialExecution = serialAttempts.at(-1);

  const active = Object.values(state.nodes).some((node) => node.status === "running");
  const completed = Object.values(state.nodes).filter((node) => node.status === "done").length;
  const locked = busy;

  const nodes = useMemo<WorkNode[]>(() => {
    const layers = state.plan?.executionBatches ?? [state.graph.nodes.map((node) => node.name)];
    const getNodeX = (nodeName: string) => {
      const layer = Math.max(0, layers.findIndex((batch) => batch.includes(nodeName)));
      const batch = layers[layer] || [];
      return (batch.indexOf(nodeName) - (batch.length - 1) / 2) * 260 + 160;
    };

    return state.graph.nodes.map((node) => {
      const layer = Math.max(0, layers.findIndex((batch) => batch.includes(node.name)));
      const batch = layers[layer] || [];
      const nodeAttempts = state.executions.filter((execution) => execution.node === node.name);

      const hasTop = state.graph.edges.some((e) => e.to === node.name && !e.feedback);
      const hasBottom = state.graph.edges.some((e) => e.from === node.name && !e.feedback);
      const hasLeftTarget = state.graph.edges.some(
        (e) => e.to === node.name && e.feedback && !(getNodeX(e.from) > 160 && getNodeX(e.to) > 160)
      );
      const hasLeftSource = state.graph.edges.some(
        (e) => e.from === node.name && e.feedback && !(getNodeX(e.from) > 160 && getNodeX(e.to) > 160)
      );
      const hasRightTarget = state.graph.edges.some(
        (e) => e.to === node.name && e.feedback && (getNodeX(e.from) > 160 && getNodeX(e.to) > 160)
      );
      const hasRightSource = state.graph.edges.some(
        (e) => e.from === node.name && e.feedback && (getNodeX(e.from) > 160 && getNodeX(e.to) > 160)
      );

      return {
        id: node.name,
        type: "work",
        width: 236,
        position: {
          x: (batch.indexOf(node.name) - (batch.length - 1) / 2) * 260 + 160,
          y: layer * 155 + 24,
        },
        data: {
          name: node.name,
          task: node.task,
          status: state.nodes[node.name]?.status ?? "waiting",
          attempts: nodeAttempts.length,
          hint: state.graph.edges
            .filter((edge) => edge.to === node.name || (edge.from === node.name && edge.feedback))
            .map((edge) => `${edge.from} → ${edge.to}: ${edge.relation}${edge.feedback ? " (feedback)" : ""}`)
            .join("\n"),
          reviewer: state.graph.edges.some((edge) => edge.from === node.name && edge.feedback),
          selected: selected === node.name,
          worktree: nodeAttempts.at(-1)?.worktree ?? "",
          hasTop,
          hasBottom,
          hasLeftTarget,
          hasLeftSource,
          hasRightTarget,
          hasRightSource,
        },
      };
    });
  }, [state.graph, state.plan, state.nodes, state.executions, selected]);

  const edges = useMemo<Edge[]>(() => {
    const layers = state.plan?.executionBatches ?? [state.graph.nodes.map((node) => node.name)];
    const getNodeX = (nodeName: string) => {
      const layer = Math.max(0, layers.findIndex((batch) => batch.includes(nodeName)));
      const batch = layers[layer] || [];
      return (batch.indexOf(nodeName) - (batch.length - 1) / 2) * 260 + 160;
    };

    return state.graph.edges.map((edge) => {
      const isFeedback = !!edge.feedback;
      const useRight = isFeedback && (getNodeX(edge.from) > 160 && getNodeX(edge.to) > 160);
      const sourceHandle = isFeedback ? (useRight ? "right-source" : "left-source") : "bottom";
      const targetHandle = isFeedback ? (useRight ? "right-target" : "left-target") : "top";

      return {
        id: `${edge.from}-${isFeedback ? "fb" : "dep"}-${edge.to}`,
        source: edge.from,
        target: edge.to,
        type: isFeedback ? "smoothstep" : "workflow",
        sourceHandle,
        targetHandle,
        animated: !isFeedback && state.nodes[edge.from]?.status === "running",
        pathOptions: isFeedback ? { borderRadius: 20, offset: 35 } : undefined,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isFeedback ? tokens.graphEdgeFeedback : tokens.graphEdgeDefault,
          width: 14,
          height: 14,
        },
        style: {
          stroke: isFeedback ? tokens.graphEdgeFeedback : tokens.graphEdgeDefault,
          strokeWidth: 1.5,
          strokeDasharray: isFeedback ? "5 4" : undefined,
        },
        label: isFeedback
          ? `${edge.relation || "缺陷重构反馈"} · REVISE`
          : (edge.relation || undefined),
        labelStyle: {
          fontSize: 10,
          fontWeight: 500,
          fill: isFeedback ? tokens.graphEdgeFeedbackText : tokens.textSecondary,
          fontFamily: isFeedback ? "monospace" : "inherit",
        },
        labelBgStyle: {
          fill: isFeedback ? tokens.graphEdgeFeedbackBg : tokens.bgCanvas,
          stroke: isFeedback ? tokens.graphEdgeFeedback : tokens.borderDefault,
          strokeWidth: 1,
        },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 4,
      };
    });
  }, [state.graph.edges, state.graph.nodes, state.plan, state.nodes, tokens]);

  return (
    <div className="app-shell">
      {/* 全局悬浮报错横幅 (Floating Error Banner)，绝对浮动展示，不挤压任何界面组件 */}
      <AnimatePresence>
        {error && (
          <motion.div
            className="floating-error-banner"
            role="alert"
            initial={{ opacity: 0, y: -20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.96 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="floating-error-icon">
              <AlertTriangle size={15} />
            </div>
            <div className="floating-error-content">
              <span className="floating-error-text">{error}</span>
            </div>
            <button
              type="button"
              className="floating-error-close"
              aria-label="关闭错误提示"
              onClick={() => setError("")}
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <aside className="sidebar">
        <div className="sidebar-brand-row">
          <a className="brand" href="#" onClick={(event) => event.preventDefault()}>
            <strong>Grapher</strong>
          </a>
        </div>

        <div className="nav-section projects-label">
          <span>Work Space</span>
          <div className="section-actions">
            <button
              className="icon-tiny-btn"
              title="添加或打开本地 Git 仓库"
              onClick={handleOpenProject}
            >
              <Plus size={14} />
            </button>
          </div>
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({ x: e.clientX, y: e.clientY, project: proj });
                  }}
                  title={`${proj.name}\n${proj.path}\n分支: ${proj.branch}\n(右键管理工作区)`}
                >
                  <span className="proj-icon">
                    <FolderGit2 size={15} />
                  </span>
                  <div className="proj-details">
                    <div className="proj-name-row">
                      <strong>{proj.name}</strong>
                      {proj.isShadow ? (
                        <span className="proj-branch-pill shadow" title="本地零侵入影子仓库：不污染原项目目录">
                          影子仓库
                        </span>
                      ) : (
                        <span className="proj-branch-pill">
                          <GitBranch size={9} />
                          {proj.branch}
                        </span>
                      )}
                    </div>
                    <small className="proj-path-text">{proj.path}</small>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="empty-projects-hint" onClick={handleOpenProject}>
              <FolderGit2 size={24} />
              <span>暂无工作区</span>
              <small>点击打开本地项目文件夹</small>
            </div>
          )}
        </div>

        <div className="nav-section runs-label">
          <span>Run History</span>
          <div className="section-actions">
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
                  const snapshot = await runtimeService.loadRun(id);
                  setState(snapshot);
                  setGoal(snapshot.graph.originalGoal || "");
                  if (snapshot.graph.nodes.length > 0) {
                    setSelected(snapshot.graph.nodes[0].name);
                  }
                })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu(null);
                  setRunContextMenu({ x: e.clientX, y: e.clientY, runId: id });
                }}
                title={`快照: ${id}\n(右键可复制 ID 或删除)`}
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
          <button
            type="button"
            className={`sidebar-bottom-btn ${modal === "settings" ? "active" : ""}`}
            onClick={handleOpenSettings}
            title="项目与引擎运行配置"
          >
            <Settings2 size={15} />
            <span>运行配置</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <AnimatePresence mode="wait" initial={false}>
          {state.graph.nodes.length === 0 && !isPlanning && mainTab === "graph" ? (
            <motion.div
              key="landing-screen"
              className="landing-screen"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{
                opacity: 0,
                y: -8,
                transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
              }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="landing-center-content">
                <motion.p
                  className="landing-title"
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  How Can I Help You
                </motion.p>
                <div style={{ width: "100%", position: "relative" }}>
                  <PromptBox
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    onSubmit={(val) => handlePlanGoal(val)}
                    isBusy={busy || isPlanning}
                    placeholder="描述你想完成的工作或项目目标..."
                  />
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="workspace-view"
              className="workspace-view-wrapper"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.18 } }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              {/* 精简专业的操作控制头部 */}
              <motion.header
                className="workspace-header"

                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
              >
              <div className="header-top">
                <div className="workspace-meta">
                  <FolderGit2 size={16} />
                  <span className="repo-badge" title={config.repository || "未选择本地仓库"}>
                    {activeProject?.name || repoInfo?.name || (config.repository ? config.repository.split("/").pop() : "未选择项目")}
                  </span>
                  {activeProject?.isShadow || repoInfo?.isShadow ? (
                    <span className="shadow-tag" title="本地零侵入影子仓库：版本由 Grapher 内部维护，不污染用户目录">
                      影子仓库
                    </span>
                  ) : activeProject?.branch ? (
                    <span className="branch-tag">
                      <GitBranch size={11} />
                      {activeProject.branch}
                    </span>
                  ) : null}
                  <ChevronRight size={13} />
                  <span className={`phase-tag ${state.phase}`}>{phaseText[state.phase] ?? "草稿"}</span>
                </div>

                {/* 原在左侧的内容现在移到项目顶部导航 Tab 区域 */}
                <nav className="header-nav-tabs">
                  <button
                    className={`tab-btn ${mainTab === "graph" ? "active" : ""}`}
                    onClick={() => setMainTab("graph")}
                  >
                    {mainTab === "graph" && (
                      <motion.div
                        layoutId="header-active-tab-pill"
                        className="tab-active-indicator"
                        transition={{ type: "spring", stiffness: 420, damping: 32 }}
                      />
                    )}
                    <GitFork size={14} />
                    <span>执行拓扑图</span>
                    {state.graph.nodes.length > 0 && <span className="tab-count">{state.graph.nodes.length}</span>}
                  </button>
                  <button
                    className={`tab-btn ${mainTab === "sessions" ? "active" : ""}`}
                    onClick={() => setMainTab("sessions")}
                  >
                    {mainTab === "sessions" && (
                      <motion.div
                        layoutId="header-active-tab-pill"
                        className="tab-active-indicator"
                        transition={{ type: "spring", stiffness: 420, damping: 32 }}
                      />
                    )}
                    <MessageSquare size={14} />
                    <span>节点会话与日志</span>
                  </button>
                  <button
                    className={`tab-btn ${mainTab === "timeline" ? "active" : ""}`}
                    onClick={() => setMainTab("timeline")}
                  >
                    {mainTab === "timeline" && (
                      <motion.div
                        layoutId="header-active-tab-pill"
                        className="tab-active-indicator"
                        transition={{ type: "spring", stiffness: 420, damping: 32 }}
                      />
                    )}
                    <History size={14} />
                    <span>事件流水</span>
                    <span className="tab-count">{state.events.filter(e => e.type !== "output").length}</span>
                  </button>
                </nav>

                <div className="header-actions" />
              </div>
            </motion.header>

        {/* 工作台主双栏布局，中间带可拖拽 resizer */}
        {mainTab === "graph" && (
          <section className={`workbench ${isResizing ? "resizing" : ""} ${routeType === "graph" ? "graph-mode" : "dialogue-only-mode"}`} ref={workbenchRef}>
          {/* 左侧/居中对话与日志面板 */}
          <motion.div
            layout
            className={`conversation-pane ${routeType === "graph" ? "split" : "full-width"}`}
            style={routeType === "graph" ? { width: `${leftWidth}px` } : { width: "100%", maxWidth: "100%" }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          >
            {selectedNode ? (
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
                  <button
                    className="back-to-query-btn"
                    title="取消选中节点，返回查看全局初始任务目标"
                    onClick={() => setSelected("")}
                  >
                    <ArrowLeft size={12} />
                    <span>初始目标</span>
                  </button>
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
                        <time>{new Date(execution.startedAt).toLocaleTimeString()}</time>
                      </div>
                      <div style={{ flex: 1, minHeight: 320, display: "flex", flexDirection: "column", marginTop: 8 }}>
                        <VirtualizedTranscript output={execution.output} />
                      </div>
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
                    {isPlanning && plannerStream.stage === "partitioning" && (
                      <motion.div
                        className="planning-stream-card partitioner"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                      >
                        <div className="stream-card-header">
                          <Compass size={14} className="spin" />
                          <span>AI 架构师正在评估任务执行路径 (Serial / Graph)...</span>
                        </div>
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
                            <time>{new Date(serialExecution.startedAt).toLocaleTimeString()}</time>
                          )}
                        </div>

                        {serialExecution?.output ? (
                          <div style={{ flex: 1, minHeight: 280, display: "flex", flexDirection: "column", marginTop: 4 }}>
                            <VirtualizedTranscript output={serialExecution.output} />
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
                        {plannerStream.tools.map((tool) => (
                          <ToolCallCard key={tool.id} item={tool} />
                        ))}
                      </div>
                    )}

                    {/* Planner 实时思考与推理 */}
                    {isPlanning && plannerStream.stage === "planning" && (
                      <motion.div
                        className="planning-stream-card planner"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                      >
                        <div className="stream-card-header">
                          <Workflow size={14} className="spin" />
                          <span>AI Planner 正在探测仓库架构并构建有向执行图...</span>
                        </div>
                        {plannerStream.plannerText ? (
                          <div className="stream-card-body">
                            <MarkdownRenderer content={plannerStream.plannerText} isStreaming={true} />
                          </div>
                        ) : (
                          <div className="stream-card-hint">
                            正在计算独立 Git worktree 执行批次与验收复审依赖...
                          </div>
                        )}
                      </motion.div>
                    )}
                  </div>

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
                onSubmit={(val) => handleSendMessage(val)}
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

          {/* 左右可调节分割器 与 右侧执行拓扑图面板：仅在判定为 graph 时流畅展开 */}
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
                      <h3>未选择本地工作区</h3>
                      <p>
                        Grapher 支持选择本地 Git 仓库或任意普通项目文件夹（自动提供本地隔离沙箱，零侵入不污染原项目）。请通过下方按钮选择本地文件夹。
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
          </motion.div>
        </>
      )}
    </AnimatePresence>
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
                                #{item.attempt} · {item.status} · {new Date(item.startedAt).toLocaleTimeString()}
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
                        <div style={{ height: "460px", display: "flex", flexDirection: "column" }}>
                          <VirtualizedTranscript output={execution.output} />
                        </div>
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
                  if (timelineFilter === "node") return ["started", "finished", "failed", "blocked", "prepared"].includes(event.type);
                  if (timelineFilter === "feedback") return event.type === "feedback";
                  if (timelineFilter === "intervention") return event.type === "invalidated" && event.human === true;
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
                      if (timelineFilter === "node") return ["started", "finished", "failed", "blocked", "prepared"].includes(event.type);
                      if (timelineFilter === "feedback") return event.type === "feedback";
                      if (timelineFilter === "intervention") return event.type === "invalidated" && event.human === true;
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

            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            className={`modal ${modal === "editor" ? "wide" : ""} ${modal === "settings" ? "settings-modal" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <header className={modal === "settings" ? "settings-modal-header" : ""}>
              {modal === "settings" ? (
                <div className="settings-header-title-wrap">
                  <div className="settings-header-icon">
                    <Settings2 size={18} />
                  </div>
                  <div>
                    <h2 id="modal-title">项目与引擎运行配置</h2>
                    <small>管理工作区、模型、Provider 认证及 Execution Instance 并发参数</small>
                  </div>
                </div>
              ) : (
                <h2 id="modal-title">
                  {modal === "editor" ? "Graph IR · 编辑与编译" : "审批执行图计划"}
                </h2>
              )}
              <button className="icon-button" aria-label="关闭弹窗" onClick={() => setModal(null)}>
                <X size={18} />
              </button>
            </header>

            {modal === "settings" ? (
              <div className="settings-modal-content">
                <div className="settings-sections">
                  {/* Section 1: 本地项目工作区 */}
                  <div className="settings-card">
                    <div className="settings-card-title">
                      <FolderGit2 size={16} />
                      <h4>本地项目工作区绑定</h4>
                    </div>
                    <p className="section-desc">
                      支持本地 Git 仓库或任意普通文件夹（自动维护零侵入影子仓库沙箱，不污染原项目）。
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

                  <div className="settings-card">
                    <div className="settings-card-title">
                      <Terminal size={16} />
                      <h4>模型与 Provider 认证</h4>
                    </div>
                    <ProviderSettings model={config.model} onModel={model => setConfig(prev => ({ ...prev, model }))} />
                  </div>
                  <div className="settings-card">
                    <div className="settings-card-title"><h4>Execution Instance 调度</h4></div>
                    <div className="form-grid">

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
                </div>

                <footer className="settings-modal-footer">
                  <button type="button" className="secondary" onClick={() => setModal(null)}>
                    取消
                  </button>
                  <button type="button" className="primary save-config-btn" onClick={handleSaveConfig}>
                    <Check size={14} /> 保存所有配置
                  </button>
                </footer>
              </div>
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
                      {`在仓库 ${state.config?.repository || config.repository} 创建独立 Git worktree。`}
                    </li>
                    <li>每个节点分配独立隔离会话；验证失败最多自动反馈重试 {state.config?.maxFeedback ?? config.maxFeedback} 次。</li>
                    <li>完全不修改或破坏你的主开发目录。</li>
                    <li className="warning">
                      Execution Instance 可执行 shell 指令并调用模型，请审视节点任务定义后再行批准。
                    </li>
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

      {contextMenu && (
        <div
          className="context-menu"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 180),
            top: Math.min(contextMenu.y, window.innerHeight - 120),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              navigator.clipboard?.writeText(contextMenu.project.path);
              setContextMenu(null);
            }}
          >
            <Copy size={13} />
            <span>复制仓库路径</span>
          </button>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item danger"
            onClick={() => {
              const project = contextMenu.project;
              setContextMenu(null);
              handleRemoveWorkspaceConfirm(project);
            }}
          >
            <Trash2 size={13} />
            <span>从工作区移除</span>
          </button>
        </div>
      )}

      {runContextMenu && (
        <div
          className="context-menu"
          style={{
            left: Math.min(runContextMenu.x, window.innerWidth - 180),
            top: Math.min(runContextMenu.y, window.innerHeight - 120),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              navigator.clipboard?.writeText(runContextMenu.runId);
              setRunContextMenu(null);
            }}
          >
            <Copy size={13} />
            <span>复制快照 ID</span>
          </button>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item danger"
            onClick={() => {
              const runId = runContextMenu.runId;
              setRunContextMenu(null);
              handleDeleteRunConfirm(runId);
            }}
          >
            <Trash2 size={13} />
            <span>删除此条历史</span>
          </button>
        </div>
      )}

      {confirmModal && (
        <div className="modal-backdrop" onClick={() => setConfirmModal(null)}>
          <div
            className="confirm-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-header">
              <div className={`confirm-icon-wrap ${confirmModal.danger ? "danger" : ""}`}>
                {confirmModal.danger ? <AlertTriangle size={18} /> : <Trash2 size={18} />}
              </div>
              <div className="confirm-texts">
                <h4>{confirmModal.title}</h4>
                <p>{confirmModal.message}</p>
                {confirmModal.detail && (
                  <small style={{ whiteSpace: "pre-wrap" }}>{confirmModal.detail}</small>
                )}
              </div>
            </div>
            <div className="confirm-actions">
              <button
                type="button"
                className="cancel-btn"
                onClick={() => setConfirmModal(null)}
              >
                取消
              </button>
              <button
                type="button"
                className={confirmModal.danger ? "danger-btn" : "primary-btn"}
                onClick={() => {
                  const action = confirmModal.onConfirm;
                  setConfirmModal(null);
                  action();
                }}
              >
                {confirmModal.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
