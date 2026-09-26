import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

import {
  defaultConfig, emptyGraph, emptySnapshot,
  type Config, type Graph, type ProjectItem, type RepositoryInfo,
  type Snapshot, type PlanRouteType, type TranscriptItem,
  type PlanningSummary, type PlanMode, type ChatMessage,
  type ImageAttachment
} from "./types";
import { tokens } from "./tokens";
import { runtimeService } from "./services/runtime";
import { providerAuth } from "./services/providerAuth";
import { useRepositoryStatus } from "./hooks/useRepositoryStatus";
import { deduceRouteType } from "./services/executionRoute";
import { createPlanningRecovery, hasCurrentPlanningRun, planningRecoveryDelay } from "./services/planningRecovery";

import { TaskNode } from "./components/graph/TaskNode";
import { useGraphElements } from "./hooks/useGraphElements";
import { useSnapshotPolling } from "./hooks/useSnapshotPolling";
import { useRunIndicators } from "./hooks/useRunIndicators";
import { SmoothWorkflowEdge } from "./components/graph/WorkflowEdge";
import { Sidebar } from "./components/layout/Sidebar";
import { LandingView } from "./components/views/LandingView";
import { FloatingPathsBackground } from "./components/ui/floating-paths";
import { GraphWorkbench } from "./components/views/GraphWorkbench";
import { PlanningSummaryCard } from "./components/PlanningSummaryCard";
import { prefetchPlanningTranscript } from "./components/PlanningActivity";
import { prefetchExecutionTranscript } from "./components/ExecutionTranscript";
import { PublicationPanel } from "./components/PublicationPanel";
import { ApprovalModal } from "./components/modals/ApprovalModal";
import { ConfirmModal, type ConfirmModalState } from "./components/modals/ConfirmModal";

import { SettingsModal } from "./components/modals/SettingsModal";
import { EditorModal } from "./components/modals/EditorModal";

const nodeTypes = { work: TaskNode };
const edgeTypes = { workflow: SmoothWorkflowEdge };

export default function App() {
  const [state, setState] = useState<Snapshot>(emptySnapshot);
  const [projects, setProjects] = useState<ProjectItem[]>(() => {
    try {
      const saved = localStorage.getItem("grapher_projects");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [config, setConfig] = useState<Config>(() => {
    let initialConfig: Config = { ...defaultConfig, maxFeedback: 3 };
    try {
      const savedConfig = localStorage.getItem("grapher_config");
      if (savedConfig) {
        const parsed = JSON.parse(savedConfig);
        initialConfig = { ...initialConfig, ...parsed, model: "", maxFeedback: 3 };
      }
    } catch {}
    try {
      const saved = localStorage.getItem("grapher_projects");
      if (saved) {
        const list: ProjectItem[] = JSON.parse(saved);
        if (list.length > 0) {
          const sorted = [...list].sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
          if (sorted[0]?.path) {
            initialConfig.repository = sorted[0].path;
          }
        }
      }
    } catch {}
    return { ...initialConfig, maxFeedback: 3 };
  });
  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);
  const [effectiveRoleModels, setEffectiveRoleModels] = useState<Record<string, string>>({});
  const [envOverrides, setEnvOverrides] = useState<Record<string, string>>({});
  const repositoryStatus = useRepositoryStatus(config.repository);
  const repositoryBlocked = !!config.repository && repositoryStatus?.valid === false;
  const requireRepository = async (repository: string) => {
    const status = await runtimeService.repositoryStatus(repository);
    if (!status.valid) throw new Error(status.error || "项目绑定已失效，请重新选择目录。");
  };
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
  const [runLabels, setRunLabels] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem("grapher_run_labels");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const pendingRunLabelIdsRef = useRef(new Set<string>());

  const [recentlyAddedEdgeIds, setRecentlyAddedEdgeIds] = useState<Set<string>>(new Set());
  const pendingToolArgsRef = useRef<Map<string, any>>(new Map());

  const currentRepoPath = useMemo(() => config.repository || repoInfo?.path || "default", [config.repository, repoInfo]);
  const runs = useMemo(() => workspaceRuns[currentRepoPath] || [], [workspaceRuns, currentRepoPath]);
  
  useEffect(() => {
    const missing = runs.filter(id => !(id in runLabels) && !pendingRunLabelIdsRef.current.has(id));
    if (missing.length > 0) {
      missing.forEach(id => {
        pendingRunLabelIdsRef.current.add(id);
        runtimeService.history(id).then(snapshot => {
          setRunLabels(prev => {
            if (prev[id] !== undefined) return prev; // already fetched
            const updated = { ...prev, [id]: snapshot.graph.originalGoal || "" };
            localStorage.setItem("grapher_run_labels", JSON.stringify(updated));
            return updated;
          });
        }).catch(() => {
          setRunLabels(prev => {
            if (prev[id] !== undefined) return prev; // already fetched
            const updated = { ...prev, [id]: "" };
            localStorage.setItem("grapher_run_labels", JSON.stringify(updated));
            return updated;
          });
        }).finally(() => pendingRunLabelIdsRef.current.delete(id));
      });
    }
  }, [runs, runLabels, runtimeService]);
  const { runIndicators, markSnapshotRead, clearRunUnread, observeRunSnapshot } = useRunIndicators(state);
  const setBackendStatus = useSnapshotPolling(busy, setState, observeRunSnapshot);

  const [dataPath, setDataPath] = useState("");
  const [recoveredPlanning, setRecoveredPlanning] = useState<PlanningSummary | null>(null);
  const [isPlanning, setIsPlanning] = useState(false);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [failedPlanning, setFailedPlanning] = useState<PlanningSummary | null>(null);
  const [planningRecovery] = useState(() => createPlanningRecovery(runtimeService, summary => {
    setFailedPlanning(summary);
    // A newer failed attempt is the workspace's current outcome. Loading an
    // older graph must not hide it behind an automatically selected old node.
    if (summary) setSelected("");
  }));

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

  // 每个运行的消息按发送顺序显示；修改旧消息也作为新的跟进指令追加。
  const [sessionEntries, setSessionEntries] = useState<ChatMessage[]>([]);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [editPrefillText, setEditPrefillText] = useState<string>("");
  const planningAbortControllerRef = useRef<AbortController | null>(null);

  // 规划路由模式选择：auto (默认，Partitioner评估) / serial (单Agent跳过Partitioner) / graph (Planner跳过Partitioner)
  const [planMode, setPlanMode] = useState<PlanMode>(() => {
    try {
      const saved = localStorage.getItem("grapher_plan_mode");
      if (saved === "serial" || saved === "graph" || saved === "auto") return saved;
    } catch {}
    return "auto";
  });

  const handlePlanModeChange = useCallback((mode: PlanMode) => {
    setPlanMode(mode);
    try {
      localStorage.setItem("grapher_plan_mode", mode);
    } catch {}
  }, []);

  const resetSessionMessages = useCallback(() => {
    setSessionEntries([]);
    setEditingMessage(null);
    setEditPrefillText("");
  }, []);

  const effectiveMessages = useMemo<ChatMessage[]>(() => {
    if (sessionEntries.length > 0) return sessionEntries;
    const initialGoal = state.graph.originalGoal || goal;
    if (initialGoal) {
      return [
        {
          id: "msg-initial-goal",
          parentId: null,
          role: "user",
          text: initialGoal,
        },
      ];
    }
    return [];
  }, [sessionEntries, state.graph.originalGoal, goal]);

  const [routeType, setRouteType] = useState<PlanRouteType>(() => deduceRouteType(emptySnapshot));

  // 开始编辑消息
  const handleStartEditMessage = useCallback((msg: ChatMessage) => {
    setEditingMessage(msg);
    // 剥离可能存在的 [@node] 格式前缀以便用户编辑纯指令
    const cleanText = msg.text.replace(/^\[@[^\]]+\]\s*/, "");
    setEditPrefillText(cleanText);
  }, []);

  const handleCancelEditMessage = useCallback(() => {
    setEditingMessage(null);
    setEditPrefillText("");
  }, []);

  const initialPlannerStream = {
    runId: "",
    stage: "idle" as "idle" | "partitioning" | "planning" | "done" | "error",
    items: [] as TranscriptItem[],
    representedPlanningIds: [] as string[],
    isContinuation: false,
    partitionerThinking: "",
    partitionerThinkingActive: false,
    partitionerText: "",
    plannerThinking: "",
    plannerThinkingActive: false,
    plannerText: "",
    tools: [] as TranscriptItem[],
  };

  const [plannerStream, setPlannerStream] = useState(initialPlannerStream);

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
    if (["approve", "resume", "intervene", "rerun", "resolve", "retry_publication"].includes(action)) {
      await requireRepository(state.config?.repository || config.repository);
    }
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

  const handleSendMessage = (
    val: string,
    options?: { mode?: "followUp" | "steer"; displayText?: string; rawText?: string; files?: File[]; images?: ImageAttachment[] }
  ): boolean | void | Promise<boolean> => {
    const text = val.trim();
    if (!text) return false;
    if (repositoryBlocked) {
      setError(repositoryStatus?.error || "正在确认项目绑定，请稍后重试。");
      return false;
    }
    const selectedNode = state.graph.nodes.find((item) => item.name === selected);
    const targetNodeName = selectedNode
      ? selectedNode.name
      : (routeType === "serial" && state.graph.nodes.length > 0
          ? (state.graph.nodes[0]?.name || "task")
          : undefined);

    if (state.phase === "publishing" || state.phase === "merging" || state.phase === "publication_failed") {
      setError("发布期间不能介入节点，请等待发布结束或处理发布失败。");
      return false;
    }

    const displayMsg = options?.displayText || text;
    const parentId = sessionEntries.length > 0 ? sessionEntries[sessionEntries.length - 1].id : null;

    const recordMessage = (textToRecord: string) => {
      const newMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        parentId,
        role: "user",
        text: textToRecord,
        images: options?.images,
        timestamp: Date.now(),
        runId: state.runId,
        node: targetNodeName,
      };
      setSessionEntries((prev) => [...prev, newMsg]);
      setEditingMessage(null);
      setEditPrefillText("");
      return newMsg;
    };

    if (isPlanning || recoveredPlanning?.status === "running") {
      // A node conversation still steers that node, even while Planner is active.
      const execution = targetNodeName && [...state.executions].reverse()
        .find((item) => item.node === targetNodeName && item.status === "running");
      if (execution) {
        const message = recordMessage(`${targetNodeName !== "task" ? `[@${targetNodeName}] ` : ""}${displayMsg}`);
        run(async () => {
          try {
            await runtimeService.control("steer", {
              runId: state.runId, executionId: execution.id, node: targetNodeName,
              instruction: text, images: options?.images,
            });
          } catch (error) {
            setSessionEntries((prev) => prev.filter((entry) => entry.id !== message.id));
            throw error;
          }
        });
        return;
      }
      if (plannerStream.stage === "partitioning") {
        setError("任务路由器仍在工作，请等待 Planner 启动后再追加消息。");
        return false;
      }
      // Keep the SSE stream and Pi process alive. Pi's RPC steer inserts a new
      // user turn into the current Planner session instead of restarting it.
      const message = recordMessage(displayMsg);
      setPlannerStream((prev) => ({
        ...prev,
        items: [...closeRunningThinkingItem(prev.items), {
          id: message.id, type: "text", role: "user", content: displayMsg, timestamp: message.timestamp,
        }],
      }));
      run(async () => {
        try {
          await runtimeService.control("steer_planner", {
            runId: plannerStream.runId || undefined, instruction: text, images: options?.images,
          });
        } catch (error) {
          setSessionEntries((prev) => prev.filter((entry) => entry.id !== message.id));
          setPlannerStream((prev) => ({ ...prev, items: prev.items.filter((item) => item.id !== message.id) }));
          throw error;
        }
      });
      return;
    }

    if (active && targetNodeName) {
      const execution = [...state.executions].reverse().find((item) => item.node === targetNodeName && item.status === "running");
      if (execution) {
        const displayLabel = targetNodeName !== "task" ? `[@${targetNodeName}] ` : "";
        const message = recordMessage(`${displayLabel}${displayMsg}`);
        run(async () => {
          try {
            await requireRepository(state.config?.repository || config.repository);
            const snap = await runtimeService.control("steer", {
              runId: state.runId, executionId: execution.id, node: targetNodeName, instruction: text, images: options?.images,
            });
            setState(snap);
          } catch (error) {
            setSessionEntries((prev) => prev.filter((entry) => entry.id !== message.id));
            throw error;
          }
        });
        return;
      }
      // A different node may be running; the backend will reject only if that
      // execution depends on the node being revised.
    }

    if (targetNodeName) {
      const message = recordMessage(selectedNode ? `[@${targetNodeName}] ${displayMsg}` : displayMsg);
      run(async () => {
        try {
          await requireRepository(state.config?.repository || config.repository);
          const snap = await runtimeService.control("intervene", { node: targetNodeName, instruction: text });
          setState(snap);
          if (snap.paused) setState(await runtimeService.control("resume"));
        } catch (error) {
          setSessionEntries((prev) => prev.filter((entry) => entry.id !== message.id));
          throw error;
        }
      });
    } else {
      // 未选中具体节点：处于与 AI 规划器对话面板，直接在对话框中继续对话更新规划
      const isPlannerContinuation = (routeType === "graph" || state.graph.nodes.length > 0) && !!state.runId;
      if (isPlannerContinuation) {
        handlePlanGoal(text, options, "graph", state.runId);
      } else {
        const baseGoal = state.graph.originalGoal || goal;
        const combinedGoal = baseGoal ? `${baseGoal}\n\n补充规划要求：\n${text}` : text;
        handlePlanGoal(combinedGoal, options);
      }
    }
  };

  const load = useCallback(async () => {
    const scope = planningRecovery.begin();
    const data = await runtimeService.bootstrap();
    if (!planningRecovery.current(scope)) return;
    if (data.effectiveRoleModels) setEffectiveRoleModels(data.effectiveRoleModels);
    if (data.envOverrides) setEnvOverrides(data.envOverrides);

    let storedProjects: ProjectItem[] | null = null;
    try {
      const saved = localStorage.getItem("grapher_projects");
      if (saved !== null) {
        storedProjects = JSON.parse(saved);
      }
    } catch {}

    let storedWorkspaceRuns: Record<string, string[]> | null = null;
    try {
      const saved = localStorage.getItem("grapher_workspace_runs");
      if (saved !== null) {
        storedWorkspaceRuns = JSON.parse(saved);
      }
    } catch {}

    let activeRepo = "";
    let activeInfo: RepositoryInfo | null = null;

    if (storedProjects !== null && storedProjects.length > 0) {
      const sorted = [...storedProjects].sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
      const latestProj = sorted[0];
      activeRepo = latestProj.path;

      if (data.repositoryInfo && data.repositoryInfo.path === latestProj.path) {
        activeInfo = data.repositoryInfo;
        const updatedProjects = sorted.map((p) =>
          p.path === latestProj.path
            ? { ...p, branch: data.repositoryInfo!.branch, clean: data.repositoryInfo!.clean, isShadow: data.repositoryInfo!.isShadow }
            : p
        );
        setProjects(updatedProjects);
        try {
          localStorage.setItem("grapher_projects", JSON.stringify(updatedProjects));
        } catch {}
      } else {
        activeInfo = {
          name: latestProj.name,
          path: latestProj.path,
          branch: latestProj.branch,
          head: latestProj.branch || "",
          clean: latestProj.clean,
          isShadow: latestProj.isShadow,
        };
        setProjects(sorted);
        runtimeService.detectRepository(latestProj.path).then((detected) => {
          if (detected) {
            setRepoInfo(detected);
            setProjects((prev) => {
              const updated = prev.map((p) =>
                p.path === latestProj.path
                  ? { ...p, branch: detected.branch, clean: detected.clean, isShadow: detected.isShadow }
                  : p
              );
              try {
                localStorage.setItem("grapher_projects", JSON.stringify(updated));
              } catch {}
              return updated;
            });
          }
        }).catch(() => {});
      }
    } else if (data.repositoryInfo) {
      const info = data.repositoryInfo;
      const item: ProjectItem = {
        id: info.path,
        name: info.name,
        path: info.path,
        branch: info.branch,
        clean: info.clean,
        isShadow: info.isShadow,
        lastOpened: Date.now(),
      };
      setProjects([item]);
      try {
        localStorage.setItem("grapher_projects", JSON.stringify([item]));
      } catch {}
      activeRepo = info.path;
      activeInfo = info;
    } else {
      setProjects([]);
      activeRepo = "";
      activeInfo = null;
    }

    setRepoInfo(activeInfo);
    // Bootstrap owns the persisted model. A browser cache from an older session
    // must not silently replace it or write it back to the backend.
    const nextConfigObj: Config = {
      ...data.config,
      repository: activeRepo || (activeInfo ? activeInfo.path : ""),
      maxFeedback: 3,
    };
    setConfig(nextConfigObj);
    setDataPath(data.dataPath);
    try {
      localStorage.setItem("grapher_config", JSON.stringify(nextConfigObj));
    } catch {}
    if (nextConfigObj.repository && nextConfigObj.repository !== data.config.repository) {
      void runtimeService.saveConfig(nextConfigObj).catch(() => {});
    }

    if (storedWorkspaceRuns === null) {
      if (data.runs && data.runs.length > 0 && activeRepo) {
        const initial = { [activeRepo]: data.runs };
        setWorkspaceRuns(initial);
        try {
          localStorage.setItem("grapher_workspace_runs", JSON.stringify(initial));
        } catch {}
      }
    } else {
      setWorkspaceRuns(storedWorkspaceRuns);
    }

    const currentRuns = (storedWorkspaceRuns ? (storedWorkspaceRuns[activeRepo] || []) : null) ?? (data.runs || []);
    const isActivelyRunning = Boolean(
      data.snapshot.runId &&
      data.snapshot.phase === "running" &&
      activeRepo &&
      (data.snapshot.config?.repository === activeRepo || (!data.snapshot.config?.repository && activeRepo === (data.repositoryInfo?.path || ""))) &&
      currentRuns.includes(data.snapshot.runId)
    );

    if (isActivelyRunning) {
      const deduced = deduceRouteType(data.snapshot);
      setState(data.snapshot);
      markSnapshotRead(data.snapshot);
      setBackendStatus({ runId: data.snapshot.runId, phase: data.snapshot.phase });
      setRouteType(deduced);
      setGoal(data.snapshot.graph.originalGoal);
      setSelected("");
    } else {
      // 每次打开项目前端，不载入最新对话，而是载入最新 workspace 文件夹的初始页面
      try {
        const resetSnap = await runtimeService.resetWorkspace();
        setState(resetSnap);
      } catch {
        setState(emptySnapshot);
      }
      setRouteType("undecided");
      setGoal("");
      setSelected("");
      resetSessionMessages();
    }

    const targetRepo = activeRepo || data.config.repository || data.repositoryInfo?.path;
    if (targetRepo && isActivelyRunning) {
      void planningRecovery.restore(planningRecovery.begin(targetRepo), data.snapshot);
    }
  }, [planningRecovery]);

  const handleOpenProject = () => run(async () => {
    const pending = planningRecovery.begin(config.repository);
    const info = await runtimeService.pickRepository();
    if (!planningRecovery.current(pending)) return;
    if (info) {
      const scope = planningRecovery.begin(info.path);
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
      void planningRecovery.restore(scope, nextSnapshot);
    } else {
      void planningRecovery.restore(pending, state);
    }
  });

  const handleSelectProject = (proj: ProjectItem) => run(async () => {
    if (config.repository === proj.path) return;
    const scope = planningRecovery.begin(proj.path);
    setPlannerStream(initialPlannerStream);
    const info = await runtimeService.detectRepository(proj.path);
    if (!planningRecovery.current(scope)) return;
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
      setRepoInfo(null);
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
        resetSessionMessages();
        setSelected("");
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
        resetSessionMessages();
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
      resetSessionMessages();
    }
    setError("");
    void planningRecovery.restore(scope, loadedSnapshot);
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
        const remainingProjects = projects.filter((p) => p.path !== pathToRemove);
        setProjects(remainingProjects);
        try {
          localStorage.setItem("grapher_projects", JSON.stringify(remainingProjects));
        } catch {}

        setWorkspaceRuns((prev) => {
          const copy = { ...prev };
          delete copy[pathToRemove];
          try {
            localStorage.setItem("grapher_workspace_runs", JSON.stringify(copy));
          } catch {}
          return copy;
        });

        if (config.repository === pathToRemove || repoInfo?.path === pathToRemove) {
          if (remainingProjects.length > 0) {
            handleSelectProject(remainingProjects[0]);
          } else {
            setConfig((prev) => ({ ...prev, repository: "" }));
            setRepoInfo(null);
            setState(emptySnapshot);
            setGoal("");
            setSelected("");
            resetSessionMessages();
            setRouteType("undecided");
            void runtimeService.resetWorkspace().catch(() => {});
          }
        }
      },
    });
  };

  const handleDeleteRun = (runIdToDelete: string) => run(async () => {
    await runtimeService.deleteRun(runIdToDelete);
    setWorkspaceRuns((prev) => {
      const copy: Record<string, string[]> = {};
      for (const [repo, idList] of Object.entries(prev)) {
        copy[repo] = idList.filter((id) => id !== runIdToDelete);
      }
      try {
        localStorage.setItem("grapher_workspace_runs", JSON.stringify(copy));
      } catch {}
      return copy;
    });
    setRunLabels((prev) => {
      const copy = { ...prev };
      delete copy[runIdToDelete];
      try {
        localStorage.setItem("grapher_run_labels", JSON.stringify(copy));
      } catch {}
      return copy;
    });
    if (state.runId === runIdToDelete) {
      const remainingRuns = (workspaceRuns[currentRepoPath] || []).filter((id) => id !== runIdToDelete);
      if (remainingRuns.length > 0) {
        try {
          const snapshot = await runtimeService.loadRun(remainingRuns[0]);
          setState(snapshot);
          setRouteType(deduceRouteType(snapshot));
          setGoal(snapshot.graph.originalGoal || "");
          setSelected("");
        } catch {
          setState(emptySnapshot);
          setGoal("");
          setSelected("");
        }
      } else {
        try {
          const snapshot = await runtimeService.resetWorkspace();
          setState(snapshot);
        } catch {
          setState(emptySnapshot);
        }
        setGoal("");
        setSelected("");
        resetSessionMessages();
        setRouteType("undecided");
      }
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
        const currentRuns = workspaceRuns[currentRepoPath] || [];
        const data = await runtimeService.bootstrap().catch(() => ({ runs: [] as string[] }));
        const candidateIds = Array.from(new Set([...currentRuns, ...(data.runs || [])]));
        const snapshots = await Promise.all(
          candidateIds.map((id) => runtimeService.history(id).catch(() => null))
        );
        const scopedIds = snapshots
          .filter((snap): snap is Snapshot => !!snap && (snap.config?.repository || "default") === currentRepoPath)
          .map((snap) => snap.runId);
        // Sidebar indexes can be stale or misfiled. Only persisted repository
        // ownership authorizes deletion, and failed deletions remain visible.
        const deletedIds = new Set<string>();
        const failures: string[] = [];
        for (const runId of scopedIds) {
          try {
            await runtimeService.deleteRun(runId);
            deletedIds.add(runId);
          } catch (error) {
            failures.push(`${runId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        setWorkspaceRuns((prev) => {
          const updated = Object.fromEntries(
            Object.entries(prev).map(([repository, ids]) =>
              [repository, ids.filter(id => !deletedIds.has(id))])
          );
          try {
            localStorage.setItem("grapher_workspace_runs", JSON.stringify(updated));
          } catch {}
          return updated;
        });

        setRunLabels((prev) => {
          const copy = { ...prev };
          deletedIds.forEach((id) => delete copy[id]);
          try {
            localStorage.setItem("grapher_run_labels", JSON.stringify(copy));
          } catch {}
          return copy;
        });

        if (failures.length) throw new Error(`部分运行历史未能删除：\n${failures.join("\n")}`);
        if (!deletedIds.has(state.runId)) return;
        setState(emptySnapshot);
        resetSessionMessages();
        setGoal("");
        setSelected("");
        setRouteType("undecided");
        void runtimeService.resetWorkspace().catch(() => {});
      }),
    });
  };

  const handleResetWorkspace = () => run(async () => {
    resetSessionMessages();
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

  const handleSaveConfig = (autoApprove: boolean) => run(async () => {
    let repoPath = config.repository.trim();
    let info: RepositoryInfo | null = null;
    if (repoPath) {
      info = await runtimeService.detectRepository(repoPath);
      if (!info) throw new Error("目标路径不存在或无法作为工作区加载。");
      setRepoInfo(info);
      repoPath = info.path;
    }
    const nextConfig = { ...config, repository: repoPath, maxFeedback: 3, autoApprove };
    setConfig(nextConfig);
    try {
      localStorage.setItem("grapher_config", JSON.stringify(nextConfig));
    } catch {}
    if (info) {
      setProjects((prev) => {
        const item: ProjectItem = { ...info, id: info.path, lastOpened: Date.now() };
        const next = [item, ...prev.filter((project) => project.path !== info.path)];
        try { localStorage.setItem("grapher_projects", JSON.stringify(next)); } catch {}
        return next;
      });
    }
    try {
      const boot = await runtimeService.saveConfig(nextConfig);
      if (boot.effectiveRoleModels) {
        setEffectiveRoleModels(boot.effectiveRoleModels);
      }
      if (boot.envOverrides) {
        setEnvOverrides(boot.envOverrides);
      }
    } catch (e) {
      console.warn("Failed to persist config to backend:", e);
    }
    setModal(null);
    setError("");
  });

  const save = (graph: Graph) => run(async () => {
    // An unapproved/rejected graph is still the same conversation. Pass its
    // identity so the backend edits that draft rather than creating a Run.
    const draftRunId = state.runId && !state.approved &&
      (state.phase === "rejected" || state.phase === "awaiting_approval") && routeType === "graph"
      ? state.runId : undefined;
    const snapshot = await runtimeService.saveGraph(graph, config, draftRunId);
    const deduced = deduceRouteType(snapshot);
    setState(snapshot);
    setRouteType(deduced);
    setGoal(graph.originalGoal);
    setModal(null);
    recordRunToWorkspace(snapshot.runId);
    if (draftRunId && snapshot.runId === draftRunId) {
      setRunLabels((prev) => {
        const updated = { ...prev, [draftRunId]: graph.originalGoal || "" };
        localStorage.setItem("grapher_run_labels", JSON.stringify(updated));
        return updated;
      });
    }
    setSelected("");
  });

  const appendItemDelta = (
    prevItems: TranscriptItem[],
    type: "thinking" | "text",
    delta: string,
    isRunning: boolean = true
  ): TranscriptItem[] => {
    if (!delta) return prevItems;
    const nextItems = prevItems.map((item) => ({ ...item }));
    const last = nextItems[nextItems.length - 1];
    if (last && last.type === type && (type === "thinking" ? last.status === "running" : true)) {
      last.content = (last.content || "") + delta;
      if (type === "thinking") {
        last.status = isRunning ? "running" : "success";
      }
    } else {
      if (last && last.type === "thinking" && last.status === "running") {
        last.status = "success";
      }
      nextItems.push({
        id: `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        type,
        role: "assistant",
        content: delta,
        status: isRunning ? "running" : "success",
        timestamp: Date.now(),
      });
    }
    return nextItems;
  };

  const closeRunningThinkingItem = (prevItems: TranscriptItem[]): TranscriptItem[] => {
    const nextItems = prevItems.map((item) => ({ ...item }));
    const last = nextItems[nextItems.length - 1];
    if (last && last.type === "thinking" && last.status === "running") {
      last.status = "success";
    }
    return nextItems;
  };

  const handlePlanGoal = (
    inputGoal?: string,
    options?: { displayText?: string; rawText?: string; files?: File[]; images?: ImageAttachment[] },
    mode?: PlanMode,
    revisionRunId?: string
  ) => run(async () => {
    const targetGoal = (inputGoal !== undefined ? inputGoal : goal).trim();
    if (!targetGoal) return;
    if (config.repository) await requireRepository(config.repository);
    const isContinuing = Boolean(revisionRunId || (routeType === "graph" && state.graph.nodes.length > 0 && state.runId));
    const effectiveRevisionRunId = revisionRunId || (isContinuing ? state.runId : undefined);
    // Tool edits are provisional until the backend atomically commits the
    // revision; never show them as the executing graph while nodes are running.
    const liveRevision = isContinuing && state.approved;
    const effectiveMode = mode || (isContinuing ? "graph" : planMode);

    if (!isContinuing) setGoal(targetGoal);
    setError("");
    setIsPlanning(true);
    // Explicit modes bypass the Partitioner on the backend; show that route
    // immediately instead of displaying an Auto-only evaluation placeholder.
    if (!isContinuing) setRouteType(effectiveMode === "auto" ? "undecided" : effectiveMode);
    setSelected("");
    const parentId = sessionEntries.length > 0 ? sessionEntries[sessionEntries.length - 1].id : null;
    const newMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      parentId,
      role: "user",
      text: options?.displayText || targetGoal,
      images: options?.images,
      timestamp: Date.now(),
      runId: effectiveRevisionRunId,
    };
    setSessionEntries((prev) => [...prev, newMsg]);
    setEditingMessage(null);
    setEditPrefillText("");

    if (!isContinuing) {
      setPlannerStream({
        runId: "",
        stage: effectiveMode === "auto" ? "partitioning" : effectiveMode === "graph" ? "planning" : "idle",
        items: [],
        representedPlanningIds: [],
        isContinuation: false,
        partitionerThinking: "",
        partitionerThinkingActive: false,
        partitionerText: "",
        plannerThinking: "",
        plannerThinkingActive: false,
        plannerText: "",
        tools: [],
      });
      setState((prev) => ({
        ...prev,
        graph: {
          ...prev.graph,
          nodes: [],
          edges: [],
          originalGoal: targetGoal,
        },
        nodes: {},
      }));
    } else {
      setPlannerStream((prev) => ({
        ...prev,
        stage: "planning",
        isContinuation: true,
        items: [
          ...prev.items,
          {
            id: newMsg.id,
            type: "text",
            role: "user",
            content: options?.displayText || targetGoal,
            timestamp: Date.now(),
          },
        ],
        plannerThinking: "",
        plannerThinkingActive: false,
        plannerText: "",
      }));
    }
    const scope = planningRecovery.begin(config.repository);
    try {
      if (!config.repository) {
        setModal("settings");
        setError("请先在左侧工作区选择绑定的本地 Git 仓库。");
        return;
      }
      const model = config.model?.trim();
      if (!model) {
        setModal("settings");
        setError("请先在设置中配置执行模型。");
        return;
      }
      if (!model.includes("/")) {
        setModal("settings");
        setError(`模型标识 "${model}" 缺少 Provider 前缀（例如: openai/gpt-4o 或 opencode-go/qwen3.8-flash）。无前缀模型会导致引擎无法定位提供商。`);
        return;
      }

      const providerId = model.split("/")[0];
      try {
        const cat = await providerAuth.catalog();
        const prov = cat.providers.find((p) => p.id === providerId);
        if (prov && !prov.configured) {
          setModal("settings");
          setError(`所选模型服务商 "${prov.name || providerId}" 尚未完成认证，请在设置中配置 API Key 或登录凭据后再提交。`);
          return;
        }
      } catch {
        // If provider catalog call fails or times out, proceed to backend preflight
      }
      let partInTag = false;
      let planInTag = false;

      const abortController = new AbortController();
      planningAbortControllerRef.current = abortController;

      const snapshot = await runtimeService.planGoalStream(
        targetGoal,
        config,
        (event) => {
        if (!planningRecovery.current(scope)) return;
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
              setPlannerStream((prev) => {
                let items = prev.items;
                const last = items[items.length - 1];
                if (!last || last.type !== "thinking" || last.status !== "running") {
                  items = [
                    ...items,
                    {
                      id: `think_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                      type: "thinking",
                      role: "assistant",
                      content: "",
                      status: "running",
                      timestamp: Date.now(),
                    },
                  ];
                }
                return {
                  ...prev,
                  items,
                  plannerThinkingActive: true,
                };
              });
            } else if (aEvent?.type === "thinking_delta") {
              const delta = aEvent.delta || "";
              setPlannerStream((prev) => ({
                ...prev,
                items: appendItemDelta(prev.items, "thinking", delta, true),
                plannerThinking: prev.plannerThinking + delta,
                plannerThinkingActive: true,
              }));
            } else if (aEvent?.type === "thinking_end") {
              setPlannerStream((prev) => ({
                ...prev,
                items: closeRunningThinkingItem(prev.items),
                plannerThinkingActive: false,
              }));
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
                setPlannerStream((prev) => {
                  let items = prev.items;
                  if (thinkChunk) {
                    items = appendItemDelta(items, "thinking", thinkChunk, planInTag);
                  }
                  if (!planInTag && items.some((i) => i.type === "thinking" && i.status === "running")) {
                    items = closeRunningThinkingItem(items);
                  }
                  if (textChunk) {
                    items = appendItemDelta(items, "text", textChunk, true);
                  }
                  return {
                    ...prev,
                    items,
                    plannerThinking: prev.plannerThinking + thinkChunk,
                    plannerThinkingActive: planInTag,
                    plannerText: prev.plannerText + textChunk,
                  };
                });
              } else {
                setPlannerStream((prev) => ({
                  ...prev,
                  items: appendItemDelta(closeRunningThinkingItem(prev.items), "text", delta, true),
                  plannerThinkingActive: false,
                  plannerText: prev.plannerText + delta,
                }));
              }
            }
          } else if (pEvent?.type === "message_end") {
            setPlannerStream((prev) => {
              let items = closeRunningThinkingItem(prev.items);
              let thinking = prev.plannerThinking;
              if (Array.isArray(pEvent.message?.content)) {
                for (const c of pEvent.message.content) {
                  if (c.type === "thinking" && c.thinking) {
                    if (!thinking) thinking = c.thinking;
                    const hasThinking = items.some((i) => i.type === "thinking" && i.content === c.thinking);
                    if (!hasThinking) {
                      items = [
                        ...items,
                        {
                          id: `think_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                          type: "thinking",
                          role: "assistant",
                          content: c.thinking,
                          status: "success",
                          timestamp: Date.now(),
                        },
                      ];
                    }
                  }
                }
              }
              return {
                ...prev,
                items,
                plannerThinking: thinking,
                plannerThinkingActive: false,
              };
            });
          } else if (pEvent?.type === "tool_execution_start") {
            if (pEvent.toolCallId || pEvent.toolName) {
              pendingToolArgsRef.current.set(pEvent.toolCallId || pEvent.toolName, pEvent.args || {});
            }
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
              items: [...closeRunningThinkingItem(prev.items), toolItem],
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

            const savedArgs = pendingToolArgsRef.current.get(pEvent.toolCallId) ||
              pendingToolArgsRef.current.get(pEvent.toolName) ||
              {};
            if (pEvent.toolCallId) pendingToolArgsRef.current.delete(pEvent.toolCallId);
            const args = pEvent.args || savedArgs;

            if (!isErr && !liveRevision) {
              // 工具调用通过（执行成功）：增量将节点与连线同步至 graph，触发卡片入场动效与边连线动效
              if (pEvent.toolName === "node") {
                setState((prev) => {
                  let nextNodes = [...prev.graph.nodes];
                  let nextEdges = [...prev.graph.edges];
                  if (Array.isArray(args.nodes) || Array.isArray(args.edges)) {
                    if (Array.isArray(args.nodes)) {
                      for (const n of args.nodes) {
                        if (!n || !n.name) continue;
                        nextNodes = nextNodes.filter((item) => item.name !== n.name);
                        if (n.delete) {
                          nextEdges = nextEdges.filter((e) => e.from !== n.name && e.to !== n.name);
                        } else {
                          nextNodes.push({ name: n.name, task: n.task || "" });
                        }
                      }
                    }
                    if (Array.isArray(args.edges)) {
                      for (const e of args.edges) {
                        if (!e || !e.from || !e.to) continue;
                        nextEdges = nextEdges.filter((item) => item.from !== e.from || item.to !== e.to);
                        if (!e.delete) {
                          nextEdges.push({
                            from: e.from,
                            to: e.to,
                            relation: e.relation || "",
                            feedback: Boolean(e.feedback),
                          });
                        }
                      }
                    }
                  } else if (args.name) {
                    nextNodes = nextNodes.filter((item) => item.name !== args.name);
                    if (args.delete) {
                      nextEdges = nextEdges.filter((e) => e.from !== args.name && e.to !== args.name);
                    } else {
                      nextNodes.push({ name: args.name, task: args.task || "" });
                    }
                  }
                  return {
                    ...prev,
                    graph: {
                      ...prev.graph,
                      nodes: nextNodes,
                      edges: nextEdges,
                    },
                  };
                });
              } else if (pEvent.toolName === "edge") {
                const rawEdgeList = Array.isArray(args.edges)
                  ? args.edges
                  : (args.from && args.to ? [args] : []);
                if (rawEdgeList.length > 0) {
                  const addedIds: string[] = [];
                  setState((prev) => {
                    let nextEdges = [...prev.graph.edges];
                    for (const e of rawEdgeList) {
                      if (!e || !e.from || !e.to) continue;
                      nextEdges = nextEdges.filter((item) => item.from !== e.from || item.to !== e.to);
                      if (!e.delete) {
                        nextEdges.push({
                          from: e.from,
                          to: e.to,
                          relation: e.relation || "",
                          feedback: Boolean(e.feedback),
                        });
                        addedIds.push(`${e.from}-${e.feedback ? "fb" : "dep"}-${e.to}`);
                      }
                    }
                    return {
                      ...prev,
                      graph: {
                        ...prev.graph,
                        edges: nextEdges,
                      },
                    };
                  });
                  if (addedIds.length > 0) {
                    setRecentlyAddedEdgeIds((prev) => new Set([...prev, ...addedIds]));
                    setTimeout(() => {
                      setRecentlyAddedEdgeIds((prev) => {
                        const next = new Set(prev);
                        for (const id of addedIds) next.delete(id);
                        return next;
                      });
                    }, 1200);
                  }
                }
              }

              // 尝试解析并同步编译计划（executionBatches），用于实时驱动拓扑卡片摆位
              try {
                if (resText) {
                  const parsed = JSON.parse(resText);
                  if (parsed?.plan?.executionBatches) {
                    setState((prev) => ({
                      ...prev,
                      plan: parsed.plan,
                    }));
                  }
                }
              } catch {
                // 非 JSON 输出则忽略
              }
            }

            setPlannerStream((prev) => {
              const updateTool = (t: TranscriptItem) => ({
                ...t,
                result: resText,
                exitCode,
                truncated,
                isError: isErr,
                status: isErr ? ("error" as const) : ("success" as const),
              });

              let matchedItem = false;
              const nextItems = prev.items.map((item) => {
                if (
                  item.type === "tool_call" &&
                  ((pEvent.toolCallId && item.toolCallId === pEvent.toolCallId) ||
                    (!pEvent.toolCallId && item.toolName === pEvent.toolName && item.status === "running"))
                ) {
                  matchedItem = true;
                  return updateTool(item);
                }
                return item;
              });
              if (!matchedItem) {
                for (let i = nextItems.length - 1; i >= 0; i--) {
                  if (nextItems[i].type === "tool_call" && nextItems[i].status === "running") {
                    nextItems[i] = updateTool(nextItems[i]);
                    break;
                  }
                }
              }

              return {
                ...prev,
                items: nextItems,
                tools: prev.tools.map((t) =>
                  t.toolCallId === pEvent.toolCallId ||
                  (!pEvent.toolCallId && t.toolName === pEvent.toolName && t.status === "running")
                    ? updateTool(t)
                    : t
                ),
              };
            });
          }
        } else if (event.type === "error") {
          void planningRecovery.finish(scope, event.summary, event.planningId);
        } else if (event.type === "complete") {
          if (event.snapshot) {
            setState(event.snapshot);
            setRouteType(deduceRouteType(event.snapshot));
            recordRunToWorkspace(event.snapshot.runId);
            const id = event.snapshot.planningId;
            if (id) setPlannerStream((prev) => ({
              ...prev,
              representedPlanningIds: prev.representedPlanningIds.includes(id)
                ? prev.representedPlanningIds : [...prev.representedPlanningIds, id],
            }));
            void planningRecovery.finish(scope);
          }
        }
      },
      effectiveMode,
      abortController.signal,
      options?.images,
      effectiveRevisionRunId
    );
      if (!planningRecovery.current(scope)) return;
      setState(snapshot);
      setRouteType(deduceRouteType(snapshot));
      setMainTab("graph");
      recordRunToWorkspace(snapshot.runId);
      void planningRecovery.finish(scope);
      setSelected("");
      setPlannerStream((prev) => ({
        ...prev,
        runId: snapshot.runId,
        items: closeRunningThinkingItem(prev.items),
        representedPlanningIds: snapshot.planningId && !prev.representedPlanningIds.includes(snapshot.planningId)
          ? [...prev.representedPlanningIds, snapshot.planningId] : prev.representedPlanningIds,
        stage: "done",
      }));
    } catch (err: any) {
      if (!planningRecovery.current(scope)) return;
      const isAbort =
        err?.name === "AbortError" ||
        String(err?.message || err).includes("AbortError") ||
        String(err?.message || err).includes("The user aborted a request");
      if (isAbort) {
        return;
      }
      setError(String(err?.message || err));
      void planningRecovery.finish(scope, err?.summary, err?.planningId);
      setPlannerStream((prev) => ({
        ...prev,
        items: closeRunningThinkingItem(prev.items),
        stage: "error",
      }));
    } finally {
      planningAbortControllerRef.current = null;
      setIsPlanning(false);
    }
  });

  useEffect(() => {
    load().catch((err) => setError(String(err)));
  }, [load]);

  const hasCurrentPlan = hasCurrentPlanningRun(state, config.repository);

  // A detached browser can discover the persisted planning identity without
  // submitting the goal again. Every response is scoped to this repository.
  useEffect(() => {
    setRecoveredPlanning(null);
    if (busy || isPlanning || hasCurrentPlan || !config.repository) return;
    const repository = config.repository;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let planningId: string | undefined;
    let finished = false;
    let idleAttempts = 0;
    const poll = async () => {
      const scope = planningRecovery.capture(repository);
      try {
        const summary = planningId
          ? await runtimeService.getPlanning(planningId, abort.signal)
          : (await runtimeService.listPlannings(repository, abort.signal)).find(item => item.status === "running");
        if (abort.signal.aborted || !planningRecovery.current(scope)) return;
        if (summary && summary.repository === repository) {
          planningId = summary.planningId;
          if (summary.status === "running") {
            setRecoveredPlanning(summary);
            setSelected("");
          } else {
            if (summary.status === "success") {
              const snapshot = await runtimeService.getPlanningSnapshot(planningId, repository, abort.signal);
              if (abort.signal.aborted || !planningRecovery.current(scope)) return;
              setState(snapshot);
              setGoal(snapshot.graph.originalGoal);
              setRouteType(deduceRouteType(snapshot));
              setSelected("");
              recordRunToWorkspace(snapshot.runId, repository);
            } else {
              const scope = planningRecovery.begin(repository);
              void planningRecovery.finish(scope, summary, planningId);
            }
            setRecoveredPlanning(null);
            finished = true;
            planningId = undefined;
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) console.warn("Planning recovery:", error);
      } finally {
        if (!abort.signal.aborted && !finished) {
          timer = setTimeout(poll, planningRecoveryDelay(planningId, idleAttempts));
          if (!planningId) idleAttempts++;
        }
      }
    };
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [busy, isPlanning, hasCurrentPlan, config.repository, planningRecovery]);

  useEffect(() => {
    // Only an actual serial route may auto-start. A manually edited Graph IR
    // with a single node named "task" must still wait for explicit approval.
    if (state.planType === "serial" && routeType === "serial" && state.phase === "awaiting_approval" && !busy && !repositoryBlocked) {
      control("approve");
    }
  }, [routeType, state.planType, state.phase, busy, repositoryBlocked]);

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
  const locked = busy || !!recoveredPlanning || repositoryBlocked;
  const isAgentWorking = active || isPlanning;

  const handleInterrupt = useCallback(async () => {
    if (planningAbortControllerRef.current) {
      planningAbortControllerRef.current.abort();
      planningAbortControllerRef.current = null;
    }
    try {
      await runtimeService.control("stop");
    } catch (e) {
      console.warn("Stop command failed:", e);
    }
    if (isPlanning) {
      setIsPlanning(false);
      setPlannerStream((prev) => ({
        ...prev,
        items: closeRunningThinkingItem(prev.items),
        stage: "error",
      }));
    }
  }, [isPlanning]);

  const { nodes, edges } = useGraphElements(state, selected, recentlyAddedEdgeIds);

  const isLandingView = state.graph.nodes.length === 0 &&
    !isPlanning &&
    !recoveredPlanning &&
    !failedPlanning &&
    mainTab === "graph";

  return (
    <div className={`app-background-root ${isLandingView ? "landing-active" : ""}`}>
      <FloatingPathsBackground
        className="aspect-16/9 flex items-center justify-center"
        position={-1}
      >
        <div className={`app-shell ${isLandingView ? "landing-active" : ""}`}>
      <Sidebar
        projects={projects}
        activeRepo={config.repository}
        onSelectProject={handleSelectProject}
        onOpenProject={handleOpenProject}
        onRemoveProject={handleRemoveWorkspaceConfirm}
        runs={runs}
        runLabels={runLabels}
        currentRunId={state.runId}
        runIndicators={runIndicators}
        onLoadRun={(id) => run(async () => {
          clearRunUnread(id);
          if (id !== state.runId) setPlannerStream(initialPlannerStream);
          const snapshot = await runtimeService.loadRun(id);
          const deduced = deduceRouteType(snapshot);

          // Prefetch transcripts before switching state so content is ready on frame 0
          if (deduced === "graph") {
            const savedPlannerId = snapshot.planningId;
            const ids = (snapshot.events || [])
              .filter((e) => e.type === "created" || e.type === "graph_revised")
              .map((e) => e.planning_id)
              .filter((pid): pid is string => Boolean(pid));
            if (savedPlannerId) ids.push(savedPlannerId);
            const seen = new Set<string>();
            const uniqueIds = ids.filter((pid) => {
              if (seen.has(pid)) return false;
              seen.add(pid);
              return true;
            });
            if (uniqueIds.length > 0) {
              await prefetchPlanningTranscript(uniqueIds).catch(() => {});
            }
          } else if (deduced === "serial" && snapshot.executions && snapshot.executions.length > 0) {
            const latestExec = snapshot.executions[snapshot.executions.length - 1];
            if (latestExec) {
              await prefetchExecutionTranscript(id, latestExec).catch(() => {});
            }
          }

          setState(snapshot);
          markSnapshotRead(snapshot);
          setRouteType(deduced);
          setGoal(snapshot.graph.originalGoal || "");
          if (id !== state.runId) resetSessionMessages();
          setSelected("");
        })}
        onDeleteRun={handleDeleteRunConfirm}
        onResetWorkspace={handleResetWorkspace}
        onOpenSettings={() => setModal("settings")}
        isSettingsOpen={modal === "settings"}
      />

      <main className="main">
        {/* 全局悬浮报错横幅 (居中于工作区主体，排除侧边栏) */}
        <div className="floating-error-banner-container">
          <AnimatePresence>
            {error && (
              <motion.div
                key="floating-error-banner"
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
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {isLandingView ? (
            <LandingView
              key="landing-view"
              goal={goal}
              setGoal={setGoal}
              onPlanGoal={handlePlanGoal}
              isBusy={busy || isPlanning || repositoryBlocked}
              planMode={planMode}
              onPlanModeChange={handlePlanModeChange}
              isWorking={isAgentWorking}
              onInterrupt={handleInterrupt}
              repository={config?.repository}
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
              {recoveredPlanning && <section aria-label="恢复进行中的规划">
                <p role="status">已连接正在进行的规划，活动会自动更新。</p>
                <PlanningSummaryCard planning={recoveredPlanning} />
              </section>}
              <PublicationPanel
                key={state.runId}
                runId={state.runId}
                publication={state.publication}
                mergers={(state.mergers ?? []).filter((merger) => merger.node === "merger")}
                busy={busy || repositoryBlocked}
                onRetry={() => control("retry_publication")}
              />

              <GraphWorkbench
                state={state}
                routeType={routeType}
                selected={selected}
                setSelected={setSelected}
                failedPlanning={failedPlanning}
                effectiveMessages={effectiveMessages}
                onEditMessage={handleStartEditMessage}
                editingMessage={editingMessage}
                editPrefillText={editPrefillText}
                onEditPrefillTextChange={setEditPrefillText}
                onCancelEditMessage={handleCancelEditMessage}
                isWorking={isAgentWorking}
                onInterrupt={handleInterrupt}
                isPlanning={isPlanning || !!recoveredPlanning}
                plannerStream={plannerStream}
                recoveredPlanningId={recoveredPlanning?.planningId}
                onSendMessage={handleSendMessage}
                onRequestConfirmation={setConfirmModal}
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
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Modals with Opening and Closing Animations */}
      <AnimatePresence>
        {modal === "settings" && (
          <SettingsModal
            key="settings-modal"
            isOpen={true}
            onClose={() => setModal(null)}
            config={config}
            setConfig={setConfig}
            dataPath={dataPath}
            effectiveRoleModels={effectiveRoleModels}
            envOverrides={envOverrides}
            onSaveConfig={handleSaveConfig}
          />
        )}

        {modal === "editor" && (
          <EditorModal
            key="editor-modal"
            isOpen={true}
            onClose={() => setModal(null)}
            initialGraph={state.graph.nodes.length ? state.graph : emptyGraph}
            busy={busy}
            active={active}
            onSave={save}
            onError={setError}
          />
        )}

        {modal === "approval" && (
          <ApprovalModal
            key="approval-modal"
            isOpen={true}
            onClose={() => setModal(null)}
            state={state}
            config={config}
            busy={busy || repositoryBlocked}
            onAdjustPlan={() => setModal("editor")}
            onApprove={() => control("approve")}
          />
        )}

        {confirmModal && (
          <ConfirmModal
            key="confirm-modal"
            config={confirmModal}
            onClose={() => setConfirmModal(null)}
          />
        )}
      </AnimatePresence>
        </div>
      </FloatingPathsBackground>
    </div>
  );
}
