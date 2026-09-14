import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkerType, type Edge } from "@xyflow/react";
import { AlertTriangle, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

import {
  defaultConfig, emptyGraph, emptySnapshot,
  type Config, type Graph, type ProjectItem, type RepositoryInfo,
  type Snapshot, type PlanRouteType, type TranscriptItem, type NodeState,
  type PlanningSummary
} from "./types";
import { tokens } from "./tokens";
import { runtimeService } from "./services/runtime";

import { TaskNode, type WorkNode } from "./components/graph/TaskNode";
import { SmoothWorkflowEdge } from "./components/graph/WorkflowEdge";
import { Sidebar } from "./components/layout/Sidebar";
import { Header } from "./components/layout/Header";
import { LandingView } from "./components/views/LandingView";
import { GraphWorkbench } from "./components/views/GraphWorkbench";
import { SessionsView } from "./components/views/SessionsView";
import { TimelineView } from "./components/views/TimelineView";
import { PublicationPanel } from "./components/PublicationPanel";
import { ApprovalModal } from "./components/modals/ApprovalModal";
import { ConfirmModal, type ConfirmModalState } from "./components/modals/ConfirmModal";

// Point 4: Code splitting and dynamic imports for non-critical modals
const SettingsModal = React.lazy(() => import("./components/modals/SettingsModal"));
const EditorModal = React.lazy(() => import("./components/modals/EditorModal"));

function deduceRouteType(snap: Snapshot): PlanRouteType {
  if (snap.graph.nodes.length > 1) return "graph";
  if (snap.graph.nodes.length === 1 && snap.graph.nodes[0].name === "task") return "serial";
  if (snap.graph.nodes.length === 1) return "graph";
  return "undecided";
}

// Point 1: Fast O(N) shallow diff functions to avoid 700ms JSON.stringify serialization
function areNodesEqual(a: Record<string, NodeState>, b: Record<string, NodeState>): boolean {
  if (a === b) return true;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    const na = a[k];
    const nb = b[k];
    if (!nb || na.status !== nb.status || na.revision !== nb.revision || na.error !== nb.error || na.head !== nb.head) {
      return false;
    }
  }
  return true;
}

function areFeedbackCountsEqual(a?: Record<string, number>, b?: Record<string, number>): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

const nodeTypes = { work: TaskNode };
const edgeTypes = { workflow: SmoothWorkflowEdge };

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
  const [activeBackendRunId, setActiveBackendRunId] = useState<string | null>(null);
  const [activeBackendPhase, setActiveBackendPhase] = useState<string | null>(null);
  const [dataPath, setDataPath] = useState("");
  const [isPlanning, setIsPlanning] = useState(false);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [failedPlanning, setFailedPlanning] = useState<PlanningSummary | null>(null);
  const planningRequestIdRef = useRef(0);

  const refreshFailedPlanning = useCallback(async (targetRepo?: string, currentSnapshot?: Snapshot) => {
    const reqId = ++planningRequestIdRef.current;
    setFailedPlanning(null);
    if (!targetRepo) return;
    try {
      const plannings = await runtimeService.listPlannings(targetRepo);
      if (planningRequestIdRef.current !== reqId) return;
      if (!plannings || plannings.length === 0) {
        setFailedPlanning(null);
        return;
      }
      const latestPlanning = plannings[0];
      const isFailed = latestPlanning.status === "failed" || !!latestPlanning.error;
      const runPlanningTime = currentSnapshot?.planning?.createdAt || 0;
      const latestTime = latestPlanning.createdAt || 0;
      if (isFailed && (!currentSnapshot?.runId || !currentSnapshot?.planning || latestTime >= runPlanningTime)) {
        setFailedPlanning(latestPlanning);
      } else {
        setFailedPlanning(null);
      }
    } catch {
      if (planningRequestIdRef.current === reqId) {
        setFailedPlanning(null);
      }
    }
  }, []);

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

  // 对话流消息记录
  const [messages, setMessages] = useState<Array<{ id: string; role: "user" | "assistant"; text: string; timestamp?: number }>>([]);
  const [routeType, setRouteType] = useState<PlanRouteType>(() => deduceRouteType(emptySnapshot));

  const initialPlannerStream = {
    stage: "idle" as "idle" | "partitioning" | "planning" | "done" | "error",
    partitionerThinking: "",
    partitionerThinkingActive: false,
    partitionerText: "",
    plannerThinking: "",
    plannerThinkingActive: false,
    plannerText: "",
    tools: [] as TranscriptItem[],
  };

  const [plannerStream, setPlannerStream] = useState(initialPlannerStream);

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

  const control = (action: string, extra: Record<string, unknown> = {}) => run(async () => {
    const defaultNode = selected || (routeType === "serial" && state.graph.nodes.length > 0 ? (state.graph.nodes[0]?.name || "task") : undefined);
    const targetNode = extra.node !== undefined ? extra.node : defaultNode;
    const payload: Record<string, unknown> = { ...extra };
    if (targetNode !== undefined) {
      payload.node = targetNode;
    }
    const snapshot = await runtimeService.control(action, payload);
    setState(snapshot);
    setModal(null);
  });

  const handleSendMessage = (val: string) => {
    const text = val.trim();
    if (!text) return;
    const selectedNode = state.graph.nodes.find((item) => item.name === selected);
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
      const deduced = deduceRouteType(data.snapshot);
      setState(data.snapshot);
      setActiveBackendRunId(data.snapshot.runId);
      setActiveBackendPhase(data.snapshot.phase);
      setRouteType(deduced);
      setGoal(data.snapshot.graph.originalGoal);
      if (deduced === "graph" && data.snapshot.graph.nodes.length > 0) {
        setSelected((curr) => (curr && data.snapshot.graph.nodes.some(n => n.name === curr) ? curr : ""));
      } else {
        setSelected("");
      }
    }

    const targetRepo = data.config.repository || data.repositoryInfo?.path;
    refreshFailedPlanning(targetRepo, data.snapshot);
  }, [refreshFailedPlanning]);

  const handleOpenProject = () => run(async () => {
    const info = await runtimeService.pickRepository();
    if (info) {
      setFailedPlanning(null);
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
      let nextSnapshot = emptySnapshot;
      try {
        nextSnapshot = await runtimeService.resetWorkspace();
        setState(nextSnapshot);
      } catch {
        setState(emptySnapshot);
      }
      setRouteType("undecided");
      setPlannerStream(initialPlannerStream);
      setGoal("");
      setSelected("");
      setError("");
      refreshFailedPlanning(info.path, nextSnapshot);
    }
  });

  const handleSelectProject = (proj: ProjectItem) => run(async () => {
    if (config.repository === proj.path) return;
    setFailedPlanning(null);
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
    let loadedSnapshot: Snapshot = emptySnapshot;
    if (projRuns.length > 0) {
      try {
        const snapshot = await runtimeService.loadRun(projRuns[0]);
        const deduced = deduceRouteType(snapshot);
        setState(snapshot);
        setRouteType(deduced);
        setGoal(snapshot.graph.originalGoal || "");
        setMessages([]);
        if (deduced === "graph" && snapshot.graph.nodes.length > 0) {
          setSelected(snapshot.graph.nodes[0].name);
        } else {
          setSelected("");
        }
        loadedSnapshot = snapshot;
      } catch {
        try {
          const snapshot = await runtimeService.resetWorkspace();
          setState(snapshot);
          loadedSnapshot = snapshot;
        } catch {
          setState(emptySnapshot);
          loadedSnapshot = emptySnapshot;
        }
        setRouteType("undecided");
        setPlannerStream(initialPlannerStream);
        setGoal("");
        setMessages([]);
      }
    } else {
      try {
        const snapshot = await runtimeService.resetWorkspace();
        setState(snapshot);
        loadedSnapshot = snapshot;
      } catch {
        setState(emptySnapshot);
        loadedSnapshot = emptySnapshot;
      }
      setRouteType("undecided");
      setPlannerStream(initialPlannerStream);
      setGoal("");
      setMessages([]);
    }
    setError("");
    refreshFailedPlanning(proj.path, loadedSnapshot);
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
      try {
        const snapshot = await runtimeService.resetWorkspace();
        setState(snapshot);
      } catch {
        setState(emptySnapshot);
      }
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

  const handleResetWorkspace = () => run(async () => {
    setMessages([]);
    try {
      const snapshot = await runtimeService.resetWorkspace();
      setState(snapshot);
    } catch {
      setState(emptySnapshot);
    }
    setRouteType("undecided");
    setPlannerStream(initialPlannerStream);
    setGoal("");
    setSelected("");
    setError("");
  });

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

  const handleSaveConfig = () => run(async () => {
    const info = await runtimeService.detectRepository(config.repository.trim());
    if (!info) throw new Error("目标路径不存在或无法作为工作区加载。");
    setRepoInfo(info);
    setConfig((prev) => ({ ...prev, repository: info.path }));
    setProjects((prev) => {
      const item: ProjectItem = { ...info, id: info.path, lastOpened: Date.now() };
      const next = [item, ...prev.filter((project) => project.path !== info.path)];
      try { localStorage.setItem("grapher_projects", JSON.stringify(next)); } catch {}
      return next;
    });
    setModal(null);
    setError("");
  });

  const save = (graph: Graph) => run(async () => {
    const snapshot = await runtimeService.saveGraph(graph, config);
    const deduced = deduceRouteType(snapshot);
    setState(snapshot);
    setRouteType(deduced);
    setGoal(graph.originalGoal);
    setModal(null);
    recordRunToWorkspace(snapshot.runId);
    if (deduced === "graph" && graph.nodes.length > 0) {
      setSelected(graph.nodes[0].name);
    } else {
      setSelected("");
    }
  });

  const handlePlanGoal = (inputGoal?: string) => run(async () => {
    const targetGoal = (inputGoal !== undefined ? inputGoal : goal).trim();
    if (!targetGoal) return;
    setGoal(targetGoal);
    setError("");
    setIsPlanning(true);
    setRouteType("undecided");
    setPlannerStream({
      stage: "partitioning",
      partitionerThinking: "",
      partitionerThinkingActive: false,
      partitionerText: "",
      plannerThinking: "",
      plannerThinkingActive: false,
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
    setFailedPlanning(null);
    try {
      if (!config.repository) {
        setModal("settings");
        setError("请先在左侧工作区选择绑定的本地 Git 仓库。");
        return;
      }
      let partInTag = false;
      let planInTag = false;

      const snapshot = await runtimeService.planGoalStream(targetGoal, config, (event) => {
        if (event.type === "partitioner") {
          const pEvent = event.event;
          if (pEvent?.type === "message_update") {
            const aEvent = pEvent.assistantMessageEvent;
            if (aEvent?.type === "thinking_start") {
              setPlannerStream((prev) => ({ ...prev, partitionerThinkingActive: true }));
            } else if (aEvent?.type === "thinking_delta") {
              const delta = aEvent.delta || "";
              setPlannerStream((prev) => ({
                ...prev,
                partitionerThinking: prev.partitionerThinking + delta,
                partitionerThinkingActive: true,
              }));
            } else if (aEvent?.type === "thinking_end") {
              setPlannerStream((prev) => ({ ...prev, partitionerThinkingActive: false }));
            } else if (aEvent?.type === "text_delta") {
              const delta = aEvent.delta || "";
              if (partInTag || delta.includes("<think>") || delta.includes("<thought>")) {
                let remaining = delta;
                let thinkChunk = "";
                let textChunk = "";
                while (remaining.length > 0) {
                  if (!partInTag) {
                    const idx1 = remaining.indexOf("<think>");
                    const idx2 = remaining.indexOf("<thought>");
                    const idx = idx1 !== -1 && idx2 !== -1 ? Math.min(idx1, idx2) : idx1 !== -1 ? idx1 : idx2;
                    if (idx !== -1) {
                      textChunk += remaining.slice(0, idx);
                      const tagLen = remaining.slice(idx).startsWith("<thought>") ? 9 : 7;
                      remaining = remaining.slice(idx + tagLen);
                      partInTag = true;
                    } else {
                      textChunk += remaining;
                      remaining = "";
                    }
                  } else {
                    const idx1 = remaining.indexOf("</think>");
                    const idx2 = remaining.indexOf("</thought>");
                    const idx = idx1 !== -1 && idx2 !== -1 ? Math.min(idx1, idx2) : idx1 !== -1 ? idx1 : idx2;
                    if (idx !== -1) {
                      thinkChunk += remaining.slice(0, idx);
                      const tagLen = remaining.slice(idx).startsWith("</thought>") ? 10 : 8;
                      remaining = remaining.slice(idx + tagLen);
                      partInTag = false;
                    } else {
                      thinkChunk += remaining;
                      remaining = "";
                    }
                  }
                }
                setPlannerStream((prev) => ({
                  ...prev,
                  partitionerThinking: prev.partitionerThinking + thinkChunk,
                  partitionerThinkingActive: partInTag,
                  partitionerText: prev.partitionerText + textChunk,
                }));
              } else {
                setPlannerStream((prev) => ({
                  ...prev,
                  partitionerThinkingActive: false,
                  partitionerText: prev.partitionerText + delta,
                }));
              }
            }
          } else if (pEvent?.type === "message_end") {
            setPlannerStream((prev) => {
              let thinking = prev.partitionerThinking;
              if (!thinking && Array.isArray(pEvent.message?.content)) {
                for (const c of pEvent.message.content) {
                  if (c.type === "thinking" && c.thinking) {
                    thinking = c.thinking;
                  }
                }
              }
              return {
                ...prev,
                partitionerThinking: thinking,
                partitionerThinkingActive: false,
              };
            });
          }
        } else if (event.type === "route_decision") {
          if (event.planType) {
            setRouteType(event.planType);
            setPlannerStream((prev) => ({ ...prev, stage: "planning" }));
          }
        } else if (event.type === "planner") {
          setPlannerStream((prev) => (prev.stage !== "planning" ? { ...prev, stage: "planning" } : prev));
          const pEvent = event.event;
          if (pEvent?.type === "message_update") {
            const aEvent = pEvent.assistantMessageEvent;
            if (aEvent?.type === "thinking_start") {
              setPlannerStream((prev) => ({ ...prev, plannerThinkingActive: true }));
            } else if (aEvent?.type === "thinking_delta") {
              const delta = aEvent.delta || "";
              setPlannerStream((prev) => ({
                ...prev,
                plannerThinking: prev.plannerThinking + delta,
                plannerThinkingActive: true,
              }));
            } else if (aEvent?.type === "thinking_end") {
              setPlannerStream((prev) => ({ ...prev, plannerThinkingActive: false }));
            } else if (aEvent?.type === "text_delta") {
              const delta = aEvent.delta || "";
              if (planInTag || delta.includes("<think>") || delta.includes("<thought>")) {
                let remaining = delta;
                let thinkChunk = "";
                let textChunk = "";
                while (remaining.length > 0) {
                  if (!planInTag) {
                    const idx1 = remaining.indexOf("<think>");
                    const idx2 = remaining.indexOf("<thought>");
                    const idx = idx1 !== -1 && idx2 !== -1 ? Math.min(idx1, idx2) : idx1 !== -1 ? idx1 : idx2;
                    if (idx !== -1) {
                      textChunk += remaining.slice(0, idx);
                      const tagLen = remaining.slice(idx).startsWith("<thought>") ? 9 : 7;
                      remaining = remaining.slice(idx + tagLen);
                      planInTag = true;
                    } else {
                      textChunk += remaining;
                      remaining = "";
                    }
                  } else {
                    const idx1 = remaining.indexOf("</think>");
                    const idx2 = remaining.indexOf("</thought>");
                    const idx = idx1 !== -1 && idx2 !== -1 ? Math.min(idx1, idx2) : idx1 !== -1 ? idx1 : idx2;
                    if (idx !== -1) {
                      thinkChunk += remaining.slice(0, idx);
                      const tagLen = remaining.slice(idx).startsWith("</thought>") ? 10 : 8;
                      remaining = remaining.slice(idx + tagLen);
                      planInTag = false;
                    } else {
                      thinkChunk += remaining;
                      remaining = "";
                    }
                  }
                }
                setPlannerStream((prev) => ({
                  ...prev,
                  plannerThinking: prev.plannerThinking + thinkChunk,
                  plannerThinkingActive: planInTag,
                  plannerText: prev.plannerText + textChunk,
                }));
              } else {
                setPlannerStream((prev) => ({
                  ...prev,
                  plannerThinkingActive: false,
                  plannerText: prev.plannerText + delta,
                }));
              }
            }
          } else if (pEvent?.type === "message_end") {
            setPlannerStream((prev) => {
              let thinking = prev.plannerThinking;
              if (!thinking && Array.isArray(pEvent.message?.content)) {
                for (const c of pEvent.message.content) {
                  if (c.type === "thinking" && c.thinking) {
                    thinking = c.thinking;
                  }
                }
              }
              return {
                ...prev,
                plannerThinking: thinking,
                plannerThinkingActive: false,
              };
            });
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
              plannerThinkingActive: false,
              tools: [...prev.tools, toolItem],
            }));
          } else if (pEvent?.type === "tool_execution_end") {
            const resText = (pEvent.result?.content ?? [])
              .filter((i: any) => i.type === "text")
              .map((i: any) => i.text)
              .join("\n");
            const rawExitCode = pEvent.result?.details?.exitCode;
            const exitCode = typeof rawExitCode === "number" ? rawExitCode : null;
            const isErr = !!(pEvent.isError || pEvent.result?.isError || (exitCode !== null && exitCode !== 0));
            const truncated = !!(
              pEvent.result?.details?.truncation?.truncated ||
              pEvent.result?.details?.truncated ||
              resText.includes("[Showing lines") ||
              resText.includes("Full output:")
            );
            setPlannerStream((prev) => ({
              ...prev,
              tools: prev.tools.map((t) =>
                t.toolCallId === pEvent.toolCallId
                  ? {
                      ...t,
                      result: resText,
                      exitCode,
                      truncated,
                      isError: isErr,
                      status: isErr ? "error" : "success",
                    }
                  : t
              ),
            }));
          }
        } else if (event.type === "error") {
          if (event.summary) {
            setFailedPlanning(event.summary);
          } else if (event.planningId) {
            runtimeService.getPlanning(event.planningId).then(setFailedPlanning).catch(() => {});
          }
        } else if (event.type === "complete") {
          if (event.snapshot) {
            setState(event.snapshot);
            setRouteType(deduceRouteType(event.snapshot));
            recordRunToWorkspace(event.snapshot.runId);
            setFailedPlanning(null);
          }
        }
      });
      setState(snapshot);
      setRouteType(deduceRouteType(snapshot));
      setMainTab("graph");
      recordRunToWorkspace(snapshot.runId);
      setFailedPlanning(null);
      setSelected("");
      setPlannerStream((prev) => ({ ...prev, stage: "done" }));
    } catch (err: any) {
      setError(String(err?.message || err));
      if (err?.summary) {
        setFailedPlanning(err.summary);
      } else if (err?.planningId) {
        runtimeService.getPlanning(err.planningId).then(setFailedPlanning).catch(() => {});
      }
      setPlannerStream((prev) => ({ ...prev, stage: "error" }));
    } finally {
      setIsPlanning(false);
    }
  });

  useEffect(() => {
    load().catch((err) => setError(String(err)));
  }, [load]);

  // Point 1: Adaptive Polling Interval with Fast Equality Diffing
  useEffect(() => {
    if (busy) return;

    // Check if background work is actively running/publishing/merging/approving
    const isTaskActive = activeBackendRunId &&
      ["running", "awaiting_approval", "publishing", "merging"].includes(activeBackendPhase ?? "");

    // 1000ms when actively executing; 3500ms when idle or completed
    const pollInterval = isTaskActive ? 1000 : 3500;

    const interval = setInterval(() => {
      runtimeService.snapshot()
        .then((newSnap) => {
          if (!newSnap || !newSnap.runId) {
            setActiveBackendRunId(null);
            setActiveBackendPhase(null);
            return;
          }
          setActiveBackendRunId(newSnap.runId);
          setActiveBackendPhase(newSnap.phase);

          setState((prev) => {
            if (prev.runId !== newSnap.runId) {
              return prev;
            }
            if (
              prev.runId === newSnap.runId &&
              prev.phase === newSnap.phase &&
              prev.paused === newSnap.paused &&
              prev.approved === newSnap.approved &&
              prev.events.length === newSnap.events.length &&
              prev.executions.length === newSnap.executions.length &&
              areNodesEqual(prev.nodes, newSnap.nodes) &&
              areFeedbackCountsEqual(prev.feedbackCounts, newSnap.feedbackCounts)
            ) {
              return prev;
            }
            return newSnap;
          });
        })
        .catch((err) => {
          console.warn("Snapshot poll error:", err);
        });
    }, pollInterval);

    return () => clearInterval(interval);
  }, [busy, activeBackendRunId, activeBackendPhase]);

  useEffect(() => {
    if (routeType === "serial" && state.phase === "awaiting_approval" && !busy) {
      control("approve");
    }
  }, [routeType, state.phase, busy]);

  const activeProject = useMemo(() => {
    return projects.find((p) => p.path === config.repository) || (repoInfo?.path === config.repository ? {
      id: repoInfo.path,
      name: repoInfo.name,
      path: repoInfo.path,
      branch: repoInfo.branch,
      clean: repoInfo.clean,
      lastOpened: Date.now(),
    } : undefined);
  }, [projects, config.repository, repoInfo]);

  const publishing = state.phase === "publishing" || state.phase === "merging";
  const publicationFailed = state.phase === "publication_failed";
  const active = publishing || publicationFailed || Object.values(state.nodes).some((node) => node.status === "running");
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
  }, [state.graph.edges, state.graph.nodes, state.plan, state.nodes]);

  return (
    <div className="app-shell">
      {/* 全局悬浮报错横幅 */}
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

      <Sidebar
        projects={projects}
        activeRepo={config.repository}
        onSelectProject={handleSelectProject}
        onOpenProject={handleOpenProject}
        onRemoveProject={handleRemoveWorkspaceConfirm}
        runs={runs}
        currentRunId={state.runId}
        activeBackendRunId={activeBackendRunId}
        activeBackendPhase={activeBackendPhase}
        onLoadRun={(id) => run(async () => {
          const snapshot = await runtimeService.loadRun(id);
          const deduced = deduceRouteType(snapshot);
          setState(snapshot);
          setRouteType(deduced);
          setGoal(snapshot.graph.originalGoal || "");
          setMessages([]);
          if (deduced === "graph" && snapshot.graph.nodes.length > 0) {
            setSelected(snapshot.graph.nodes[0].name);
          } else {
            setSelected("");
          }
        })}
        onDeleteRun={handleDeleteRunConfirm}
        onClearHistory={handleClearHistory}
        onResetWorkspace={handleResetWorkspace}
        onOpenSettings={() => setModal("settings")}
        isSettingsOpen={modal === "settings"}
      />

      <main className="main">
        {activeBackendRunId &&
          ["running", "awaiting_approval", "publishing", "merging"].includes(activeBackendPhase ?? "") &&
          state.runId !== activeBackendRunId && (
            <div className="background-run-banner">
              <div className="background-run-info">
                <span className="pulse-indicator" />
                <span>
                  后台有任务正在{activeBackendPhase === "awaiting_approval" ? "等待审批" : "执行中"}: <strong>Graph {activeBackendRunId.slice(0, 8)}</strong>
                </span>
              </div>
              <button
                type="button"
                className="background-run-action-btn"
                onClick={() => run(async () => {
                  const snapshot = await runtimeService.loadRun(activeBackendRunId);
                  const deduced = deduceRouteType(snapshot);
                  setState(snapshot);
                  setRouteType(deduced);
                  setGoal(snapshot.graph.originalGoal || "");
                  setMessages([]);
                  if (deduced === "graph" && snapshot.graph.nodes.length > 0) {
                    setSelected(snapshot.graph.nodes[0].name);
                  } else {
                    setSelected("");
                  }
                })}
              >
                返回运行中的任务
              </button>
            </div>
        )}

        <AnimatePresence mode="wait" initial={false}>
          {state.graph.nodes.length === 0 && !isPlanning && mainTab === "graph" ? (
            <LandingView
              goal={goal}
              setGoal={setGoal}
              onPlanGoal={handlePlanGoal}
              isBusy={busy || isPlanning}
            />
          ) : (
            <motion.div
              key="workspace-view"
              className="workspace-view-wrapper"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.18 } }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <Header
                activeProject={activeProject}
                repoInfo={repoInfo}
                config={config}
                phase={state.phase}
                mainTab={mainTab}
                setMainTab={setMainTab}
                nodesCount={state.graph.nodes.length}
                eventsCount={state.events.filter(e => e.type !== "output").length}
              />

              <PublicationPanel
                key={state.runId}
                publication={state.publication}
                mergers={state.mergers ?? []}
                busy={busy}
                onRetry={() => control("retry_publication")}
              />

              {mainTab === "graph" && (
                <GraphWorkbench
                  state={state}
                  routeType={routeType}
                  selected={selected}
                  setSelected={setSelected}
                  failedPlanning={failedPlanning}
                  effectiveMessages={effectiveMessages}
                  isPlanning={isPlanning}
                  plannerStream={plannerStream}
                  onSendMessage={handleSendMessage}
                  onControl={control}
                  onSave={save}
                  onOpenEditor={() => setModal("editor")}
                  onOpenApproval={() => setModal("approval")}
                  onPickRepository={handleOpenProject}
                  onDetectRepository={() => handleDetectRepository()}
                  repoInfo={repoInfo}
                  config={config}
                  goal={goal}
                  active={active}
                  locked={locked}
                  publishing={publishing}
                  publicationFailed={publicationFailed}
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  tokens={tokens}
                />
              )}

              {mainTab === "sessions" && (
                <SessionsView
                  state={state}
                  selected={selected}
                  setSelected={setSelected}
                  active={active}
                  locked={locked}
                  onIntervene={(instruction, nodeName) => control("intervene", { node: nodeName, instruction })}
                />
              )}

              {mainTab === "timeline" && (
                <TimelineView events={state.events} />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Point 4: Lazy Loaded Modals with Suspense */}
      <Suspense fallback={null}>
        {modal === "settings" && (
          <SettingsModal
            isOpen={true}
            onClose={() => setModal(null)}
            config={config}
            setConfig={setConfig}
            repoInfo={repoInfo}
            dataPath={dataPath}
            onOpenProject={handleOpenProject}
            onDetectRepository={handleDetectRepository}
            onResetWorkspace={handleResetWorkspace}
            onClearHistory={handleClearHistory}
            onSaveConfig={handleSaveConfig}
          />
        )}

        {modal === "editor" && (
          <EditorModal
            isOpen={true}
            onClose={() => setModal(null)}
            initialGraph={state.graph.nodes.length ? state.graph : emptyGraph}
            busy={busy}
            active={active}
            onSave={save}
            onError={setError}
          />
        )}
      </Suspense>

      <ApprovalModal
        isOpen={modal === "approval"}
        onClose={() => setModal(null)}
        state={state}
        config={config}
        busy={busy}
        onAdjustPlan={() => setModal("editor")}
        onApprove={() => control("approve")}
      />

      <ConfirmModal
        config={confirmModal}
        onClose={() => setConfirmModal(null)}
      />
    </div>
  );
}
