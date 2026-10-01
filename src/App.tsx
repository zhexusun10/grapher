import { t, localizeError } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

import {
  defaultConfig, emptyGraph, emptySnapshot,
  type Config, type Graph, type ProjectItem, type RepositoryInfo,
  type Snapshot, type PlanRouteType, type TranscriptItem,
  type PlanningSummary, type PlanMode, type ChatMessage,
  type ImageAttachment, type ChatMessageVersion
} from "./types";
import { tokens } from "./tokens";
import { runtimeService } from "./services/runtime";
import { providerAuth } from "./services/providerAuth";
import { modelRoles, planningModelRoles, roleModelConfig } from "./modelConfig";
import { useRepositoryStatus } from "./hooks/useRepositoryStatus";
import { deduceRouteType } from "./services/executionRoute";
import { createPlanningRecovery, hasCurrentPlanningRun, planningRecoveryDelay } from "./services/planningRecovery";
import { executionIdForMessage, executionIdForVersion } from "./services/conversationBranch";

import { TaskNode } from "./components/graph/TaskNode";
import { graphEdgeId, useGraphElements } from "./hooks/useGraphElements";
import { useSnapshotPolling } from "./hooks/useSnapshotPolling";
import { useRunIndicators } from "./hooks/useRunIndicators";
import { SmoothWorkflowEdge } from "./components/graph/WorkflowEdge";
import { Sidebar } from "./components/layout/Sidebar";
import { LandingView } from "./components/views/LandingView";
import { FloatingPathsBackground } from "./components/ui/floating-paths";
import { GraphWorkbench } from "./components/views/GraphWorkbench";
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
    } catch { }
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
    } catch { }
    return { ...initialConfig, maxFeedback: 3 };
  });
  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);
  const [envOverrides, setEnvOverrides] = useState<Record<string, string>>({});
  const repositoryStatus = useRepositoryStatus(config.repository);
  const repositoryBlocked = !!config.repository && repositoryStatus?.valid === false;
  const requireRepository = async (repository: string) => {
    const status = await runtimeService.repositoryStatus(repository);
    if (!status.valid) throw new Error(status.error || t("项目绑定已失效，请重新选择目录。"));
  };
  const [goal, setGoal] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [modal, setModal] = useState<"settings" | "editor" | "approval" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const foregroundGeneration = useRef(0);
  const historyPrefetchRef = useRef<AbortController | null>(null);
  useEffect(() => () => historyPrefetchRef.current?.abort(), []);
  const busyOperations = useRef(0);
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
  const setBackendStatus = useSnapshotPolling(setState, observeRunSnapshot, runs, state.runId, state.phase);

  const [dataPath, setDataPath] = useState("");
  const [recoveredPlanning, setRecoveredPlanning] = useState<PlanningSummary | null>(null);
  const [isPlanning, setIsPlanning] = useState(false);
  // Recover an orphaned Planner only on initial load, not after the user
  // intentionally opens a different Conversation in this repository.
  const [autoRecoverPlanning, setAutoRecoverPlanning] = useState(true);
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
      } catch { }
      return updated;
    });
  };

  useEffect(() => {
    if (state.runId && currentRepoPath && !runs.includes(state.runId)) {
      recordRunToWorkspace(state.runId, currentRepoPath);
    }
  }, [state.runId, currentRepoPath, runs]);

  // 每个运行的消息按发送顺序显示；修改旧消息也作为新的跟进指令追加。
  const [sessionEntries, setSessionEntries] = useState<ChatMessage[]>([]);
  // Keep optimistic turns scoped to their Run while navigating away. Planner
  // steer turns may not have reached the durable JSONL when the user goes home.
  const messagesByRunRef = useRef(new Map<string, ChatMessage[]>());
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [editPrefillText, setEditPrefillText] = useState<string>("");
  const planningAbortControllerRef = useRef<AbortController | null>(null);

  // 规划路由模式选择：auto (默认，Partitioner评估) / serial (单Agent跳过Partitioner) / graph (Planner跳过Partitioner)
  const [planMode, setPlanMode] = useState<PlanMode>(() => {
    try {
      const saved = localStorage.getItem("grapher_plan_mode");
      if (saved === "serial" || saved === "graph" || saved === "auto") return saved;
    } catch { }
    return "auto";
  });

  const handlePlanModeChange = useCallback((mode: PlanMode) => {
    setPlanMode(mode);
    try {
      localStorage.setItem("grapher_plan_mode", mode);
    } catch { }
  }, []);

  const resetSessionMessages = useCallback(() => {
    setSessionEntries([]);
    setEditingMessage(null);
    setEditPrefillText("");
  }, []);

  const publishing = state.phase === "publishing" || state.phase === "merging";
  const publicationFailed = state.phase === "publication_failed";
  const active = publishing || publicationFailed || Object.values(state.nodes).some((node) => node.status === "running");
  const locked = busy || !!recoveredPlanning || repositoryBlocked;
  const isAgentWorking = active || isPlanning;

  const effectiveMessages = useMemo<ChatMessage[]>(() => {
    if (sessionEntries.length > 0) return sessionEntries;
    const initialGoal = state.graph.originalGoal || goal || (state.runId ? runLabels[state.runId] : "");
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
  }, [sessionEntries, state.graph.originalGoal, goal, state.runId, runLabels]);

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
    const generation = foregroundGeneration.current;
    busyOperations.current += 1;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      if (generation === foregroundGeneration.current) {
        setError(err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err));
      }
    } finally {
      if (generation === foregroundGeneration.current) {
        busyOperations.current -= 1;
        setBusy(busyOperations.current > 0);
      }
    }
  };

  const control = (action: string, extra: Record<string, unknown> = {}) => run(async () => {
    if (["approve", "resume", "intervene", "resolve", "retry_publication"].includes(action)) {
      await requireRepository(state.config?.repository || config.repository);
    }
    const defaultNode = selected || (routeType === "serial" && state.graph.nodes.length > 0 ? (state.graph.nodes[0]?.name || "task") : undefined);
    const targetNode = extra.node !== undefined ? extra.node : defaultNode;
    const payload: Record<string, unknown> = { runId: state.runId, ...extra };
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
      setError(repositoryStatus?.error || t("正在确认项目绑定，请稍后重试。"));
      return false;
    }
    const selectedNode = state.graph.nodes.find((item) => item.name === selected);
    const targetNodeName = selectedNode
      ? selectedNode.name
      : (routeType === "serial" && state.graph.nodes.length > 0
        ? (state.graph.nodes[0]?.name || "task")
        : undefined);

    const displayMsg = options?.displayText || text;
    const parentId = sessionEntries.length > 0 ? sessionEntries[sessionEntries.length - 1].id : null;

    const recordMessage = (textToRecord: string, delivery?: ChatMessage["delivery"], executionId?: string) => {
      const newMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        parentId,
        role: "user",
        text: textToRecord,
        images: options?.images,
        timestamp: Date.now(),
        runId: isPlanning && !targetNodeName ? (plannerStream.runId || state.runId) : state.runId,
        node: targetNodeName,
        delivery,
        executionId,
      };
      setSessionEntries((prev) => [...prev, newMsg]);
      setEditingMessage(null);
      setEditPrefillText("");
      return newMsg;
    };

    // A completed node continues its own persisted Pi session. In Graph mode
    // its dependency descendants are rerun only if the result actually
    // changes; unrelated branches keep their results.
    if (targetNodeName && state.nodes[targetNodeName]?.status === "done") {
      const message = recordMessage(selectedNode ? `[@${targetNodeName}] ${displayMsg}` : displayMsg);
      run(async () => {
        try {
          await requireRepository(state.config?.repository || config.repository);
          const snap = await runtimeService.control("intervene", {
            runId: state.runId, node: targetNodeName, instruction: text, images: options?.images,
          });
          setState(snap);
          if (snap.paused) setState(await runtimeService.control("resume", { runId: state.runId }));
        } catch (error) {
          setSessionEntries((prev) => prev.filter((entry) => entry.id !== message.id));
          throw error;
        }
      });
      return;
    }

    if (state.phase === "publishing" || state.phase === "merging" || state.phase === "publication_failed") {
      setError(t("发布期间不能介入节点，请等待发布结束或处理发布失败。"));
      return false;
    }

    if (isPlanning || recoveredPlanning?.status === "running") {
      // A node conversation still steers that node, even while Planner is active.
      const execution = targetNodeName && [...state.executions].reverse()
        .find((item) => item.node === targetNodeName && item.status === "running");
      if (execution) {
        const message = recordMessage(`${targetNodeName !== "task" ? `[@${targetNodeName}] ` : ""}${displayMsg}`, "steered", execution.id);
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
        setError(t("任务路由器仍在工作，请等待 Planner 启动后再追加消息。"));
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
          const runId = message.runId;
          if (runId) messagesByRunRef.current.set(runId,
            (messagesByRunRef.current.get(runId) ?? []).filter((entry) => entry.id !== message.id));
          setSessionEntries((prev) => prev.filter((entry) => entry.id !== message.id));
          setPlannerStream((prev) => ({ ...prev, items: prev.items.filter((item) => item.id !== message.id) }));
          // The backend Planner turn can settle between this click and the
          // request. Its workspace is already published, but the Run is still
          // revisable: continue the same conversation with a new turn instead
          // of dropping the message.
          const failure = error instanceof Error ? error.message : String(error);
          if (state.runId && /no longer accepting messages|No active Planner/i.test(failure)) {
            void handlePlanGoal(text, options, "graph", state.runId, false, undefined, true);
            return;
          }
          throw error;
        }
      });
      return;
    }

    if (active && targetNodeName) {
      const execution = [...state.executions].reverse().find((item) => item.node === targetNodeName && item.status === "running");
      if (execution) {
        const displayLabel = targetNodeName !== "task" ? `[@${targetNodeName}] ` : "";
        const message = recordMessage(`${displayLabel}${displayMsg}`, "steered", execution.id);
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
          const snap = await runtimeService.control("intervene", { node: targetNodeName, instruction: text, images: options?.images, runId: state.runId });
          setState(snap);
          if (snap.paused) setState(await runtimeService.control("resume", { runId: state.runId }));
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
        const combinedGoal = baseGoal ? t("{0}\n\n补充规划要求：\n{1}", baseGoal, text) : text;
        handlePlanGoal(combinedGoal, options);
      }
    }
  };

  const load = useCallback(async () => {
    const scope = planningRecovery.begin();
    const data = await runtimeService.bootstrap();
    if (!planningRecovery.current(scope)) return;
    if (data.envOverrides) setEnvOverrides(data.envOverrides);

    let storedProjects: ProjectItem[] | null = null;
    try {
      const saved = localStorage.getItem("grapher_projects");
      if (saved !== null) {
        storedProjects = JSON.parse(saved);
      }
    } catch { }

    let storedWorkspaceRuns: Record<string, string[]> | null = null;
    try {
      const saved = localStorage.getItem("grapher_workspace_runs");
      if (saved !== null) {
        storedWorkspaceRuns = JSON.parse(saved);
      }
    } catch { }

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
        } catch { }
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
              } catch { }
              return updated;
            });
          }
        }).catch(() => { });
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
      } catch { }
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
    } catch { }
    if (nextConfigObj.repository && nextConfigObj.repository !== data.config.repository) {
      void runtimeService.saveConfig(nextConfigObj).catch(() => { });
    }

    // Local browser indexes can lag another tab or a restarted backend.
    // Reconcile persisted Runs by their actual repository, not the currently
    // selected project (which may differ for concurrent conversations).
    const indexedRuns = { ...(storedWorkspaceRuns || {}) };
    const indexedIds = new Set(Object.values(indexedRuns).flat());
    const missingIds = (data.runs || []).filter((id) => !indexedIds.has(id));
    const missingSnapshots = await Promise.all(missingIds.map((id) => runtimeService.history(id).catch(() => null)));
    if (!planningRecovery.current(scope)) return;
    for (const snapshot of missingSnapshots) {
      if (!snapshot?.runId || !snapshot.config?.repository) continue;
      const repo = snapshot.config.repository;
      indexedRuns[repo] = [...(indexedRuns[repo] || []), snapshot.runId];
    }
    setWorkspaceRuns(indexedRuns);
    try { localStorage.setItem("grapher_workspace_runs", JSON.stringify(indexedRuns)); } catch { }

    const currentRuns = indexedRuns[activeRepo] || [];
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
      // Opening the UI must not reset or delete another Run's checkout.
      setState(emptySnapshot);
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

  const detachForeground = (repository: string) => {
    const runId = plannerStream.runId || state.runId;
    if (runId && sessionEntries.length) messagesByRunRef.current.set(runId, sessionEntries);
    historyPrefetchRef.current?.abort();
    foregroundGeneration.current += 1;
    busyOperations.current = 0;
    setBusy(false);
    const scope = planningRecovery.begin(repository);
    // A detached SSE request continues on the backend, but cannot replace the
    // newly selected view or leave its old busy/planning flags behind.
    planningAbortControllerRef.current = null;
    setIsPlanning(false);
    setRecoveredPlanning(null);
    setAutoRecoverPlanning(false);
    return scope;
  };

  const handleOpenProject = () => run(async () => {
    const pending = planningRecovery.capture(config.repository);
    const info = await runtimeService.pickRepository();
    if (!planningRecovery.current(pending)) return;
    if (info) {
      const scope = detachForeground(info.path);
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
        } catch { }
        return next;
      });
      const nextSnapshot = emptySnapshot;
      setState(nextSnapshot);
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

  const handleSelectProject = (proj: ProjectItem) => {
    if (config.repository === proj.path) return;
    const scope = detachForeground(proj.path);
    return run(async () => {
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
          } catch { }
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
          const snapshot = await runtimeService.snapshotForRun(projRuns[0]);
          if (!planningRecovery.current(scope)) return;
          const deduced = deduceRouteType(snapshot);
          setState(snapshot);
          setRouteType(deduced);
          setGoal(snapshot.graph.originalGoal || "");
          resetSessionMessages();
          setSelected("");
          loadedSnapshot = snapshot;
        } catch {
          if (!planningRecovery.current(scope)) return;
          setState(emptySnapshot);
          loadedSnapshot = emptySnapshot;
          setRouteType("undecided");
          setPlannerStream(initialPlannerStream);
          setGoal("");
          resetSessionMessages();
        }
      } else {
        setState(emptySnapshot);
        loadedSnapshot = emptySnapshot;
        setRouteType("undecided");
        setPlannerStream(initialPlannerStream);
        setGoal("");
        resetSessionMessages();
      }
      setError("");
      void planningRecovery.restore(scope, loadedSnapshot);
    });
  };

  const handleRemoveWorkspaceConfirm = (project: ProjectItem) => {
    setConfirmModal({
      title: t("移除工作区"),
      message: t("确定从工作区列表中移除「{0}」吗？", project.name),
      detail: t("路径: {0}\n这仅会从工作区列表中移除索引，不会删除磁盘上的代码文件。", project.path),
      confirmText: t("移除工作区"),
      danger: true,
      onConfirm: () => {
        const pathToRemove = project.path;
        const remainingProjects = projects.filter((p) => p.path !== pathToRemove);
        setProjects(remainingProjects);
        try {
          localStorage.setItem("grapher_projects", JSON.stringify(remainingProjects));
        } catch { }

        setWorkspaceRuns((prev) => {
          const copy = { ...prev };
          delete copy[pathToRemove];
          try {
            localStorage.setItem("grapher_workspace_runs", JSON.stringify(copy));
          } catch { }
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
      } catch { }
      return copy;
    });
    setRunLabels((prev) => {
      const copy = { ...prev };
      delete copy[runIdToDelete];
      try {
        localStorage.setItem("grapher_run_labels", JSON.stringify(copy));
      } catch { }
      return copy;
    });
    if (state.runId === runIdToDelete) {
      const remainingRuns = (workspaceRuns[currentRepoPath] || []).filter((id) => id !== runIdToDelete);
      if (remainingRuns.length > 0) {
        try {
          const snapshot = await runtimeService.snapshotForRun(remainingRuns[0]);
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
        setState(emptySnapshot);
        setGoal("");
        setSelected("");
        resetSessionMessages();
        setRouteType("undecided");
      }
    }
  });

  const handleDeleteRunConfirm = (runId: string) => {
    setConfirmModal({
      title: t("删除运行历史"),
      message: t("确定删除历史快照「Graph {0}」吗？", runId.slice(0, 8)),
      detail: t("快照 ID: {0}\n删除后该次运行的执行拓扑图与事件记录将被彻底清除；如果这是该项目最后一条 Conversation，对应的外置影子仓库也会一并清理。", runId),
      confirmText: t("删除历史"),
      danger: true,
      onConfirm: () => handleDeleteRun(runId),
    });
  };

  // A new conversation is only a view change. The backend may still be
  // executing the previous Run; never reset or terminate it from this button.
  const handleNewConversation = () => {
    detachForeground(config.repository);
    resetSessionMessages();
    setState(emptySnapshot);
    setRouteType("undecided");
    setPlannerStream(initialPlannerStream);
    setGoal("");
    setSelected("");
    setError("");
  };

  const handleSaveConfig = (autoApprove: boolean) => run(async () => {
    let repoPath = config.repository.trim();
    let info: RepositoryInfo | null = null;
    if (repoPath) {
      info = await runtimeService.detectRepository(repoPath);
      if (!info) throw new Error(t("目标路径不存在或无法作为工作区加载。"));
      setRepoInfo(info);
      repoPath = info.path;
    }
    const nextConfig = { ...config, repository: repoPath, maxFeedback: 3, autoApprove };
    setConfig(nextConfig);
    try {
      localStorage.setItem("grapher_config", JSON.stringify(nextConfig));
    } catch { }
    if (info) {
      setProjects((prev) => {
        const item: ProjectItem = { ...info, id: info.path, lastOpened: Date.now() };
        const next = [item, ...prev.filter((project) => project.path !== info.path)];
        try { localStorage.setItem("grapher_projects", JSON.stringify(next)); } catch { }
        return next;
      });
    }
    try {
      const boot = await runtimeService.saveConfig(nextConfig);
      if (boot.envOverrides) {
        setEnvOverrides(boot.envOverrides);
      }
    } catch (e) {
      throw new Error(t("保存设置失败：{0}", String(e)));
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
    revisionRunId?: string,
    forceFresh?: boolean,
    editedMessage?: ChatMessage,
    // A Planner turn can settle between a send and its steer request. The
    // caller already verified that turn is over, so continue instead of
    // rejecting the message as a second concurrent conversation.
    allowWhilePlanning?: boolean
  ) => run(async () => {
    const targetGoal = (inputGoal !== undefined ? inputGoal : goal).trim();
    if (!targetGoal) return;
    if (config.repository) await requireRepository(config.repository);
    if (isPlanning && !allowWhilePlanning) {
      throw new Error(t("另一个对话仍在规划中；请等待规划完成后再提交新对话，旧会话不会被中断。"));
    }
    const isContinuing = !forceFresh && Boolean(revisionRunId || (routeType === "graph" && state.graph.nodes.length > 0 && state.runId));
    const effectiveRevisionRunId = !forceFresh ? (revisionRunId || (isContinuing ? state.runId : undefined)) : undefined;
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
    const parentId = !isContinuing ? null : (sessionEntries.length > 0 ? sessionEntries[sessionEntries.length - 1].id : null);
    const newMsg: ChatMessage = {
      ...editedMessage,
      id: editedMessage?.id || `msg-${Date.now()}`,
      parentId,
      role: "user",
      text: options?.displayText || targetGoal,
      images: options?.images,
      timestamp: Date.now(),
      runId: effectiveRevisionRunId,
    };
    if (editedMessage) {
      // The replacement is already in the truncated local branch.
    } else if (!isContinuing) {
      setSessionEntries((prev) => {
        if (prev.length > 0 && prev[0].versions) {
          return [{
            ...prev[0],
            text: newMsg.text,
            images: newMsg.images,
            timestamp: newMsg.timestamp,
            runId: newMsg.runId,
          }];
        }
        return [newMsg];
      });
    } else {
      setSessionEntries((prev) => [...prev, newMsg]);
    }
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
          ...(editedMessage ? [] : prev.items),
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
    let abortController: AbortController | null = null;
    let routeConfirmed = false;
    try {
      if (!config.repository) {
        setModal("settings");
        setError(t("请先在左侧工作区选择绑定的本地 Git 仓库。"));
        return;
      }
      const requiredModels = planningModelRoles(effectiveMode).map(role => ({
        label: modelRoles.find(item => item.id === role)!.label,
        model: roleModelConfig(config, role, envOverrides).model,
      }));
      for (const { label, model } of requiredModels) {
        if (!model) {
          setModal("settings");
          setError(t("请先在设置中配置 {0} 的模型。", label));
          return;
        }
        const [provider, modelId] = model.split("/", 2);
        if (!provider || !modelId) {
          setModal("settings");
          setError(t("{0} 模型标识 \"{1}\" 需使用 provider/model 格式。", label, model));
          return;
        }
      }
      try {
        const cat = await providerAuth.catalog();
        for (const { label, model } of requiredModels) {
          const providerId = model.split("/")[0];
          const prov = cat.providers.find(p => p.id === providerId);
          if (prov && !prov.configured) {
            setModal("settings");
            setError(t("{0} 所选服务商 \"{1}\" 尚未认证，请在设置中配置 API Key 或登录。", label, prov.name || providerId));
            return;
          }
        }
      } catch {
        // If provider catalog call fails or times out, proceed to backend preflight.
      }
      let partInTag = false;
      let planInTag = false;

      abortController = new AbortController();
      planningAbortControllerRef.current = abortController;

      const snapshot = await runtimeService.planGoalStream(
        targetGoal,
        config,
        (event) => {
          if (!planningRecovery.current(scope)) {
            // Detached planning still creates a real Run. Keep it in the sidebar
            // without replacing the newly opened conversation.
            if (event.type === "run_started" && event.runId) {
              recordRunToWorkspace(event.runId);
              setRunLabels((prev) => {
                if (prev[event.runId!]) return prev;
                const updated = { ...prev, [event.runId!]: targetGoal };
                try { localStorage.setItem("grapher_run_labels", JSON.stringify(updated)); } catch {}
                return updated;
              });
            }
            if (event.type === "complete" && event.snapshot?.runId) {
              recordRunToWorkspace(event.snapshot.runId);
            }
            return;
          }
          if (event.type === "run_started") {
            if (event.runId) {
              const runId = event.runId;
              setPlannerStream((prev) => ({ ...prev, runId }));
              recordRunToWorkspace(runId);
              setState((prev) => ({ ...prev, runId }));
              setSessionEntries((prev) => {
                const updated = prev.map((msg) => (!msg.runId ? { ...msg, runId } : msg));
                messagesByRunRef.current.set(runId, updated);
                return updated;
              });
              setRunLabels((prev) => {
                if (prev[runId]) return prev;
                const updated = { ...prev, [runId]: targetGoal };
                try {
                  localStorage.setItem("grapher_run_labels", JSON.stringify(updated));
                } catch {}
                return updated;
              });
            }
          } else if (event.type === "partitioner") {
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
              // Show the complete route as soon as Pi finishes the turn, without
              // waiting for its CLI to exit. Only route_decision confirms it;
              // errors before confirmation revert this preview.
              if (effectiveMode === "auto" && pEvent.message?.role === "assistant" && pEvent.message?.stopReason === "stop") {
                const text = (pEvent.message.content ?? [])
                  .filter((item: any) => item.type === "text")
                  .map((item: any) => item.text)
                  .join("\n").trim().toLowerCase();
                if (text === "graph" || text === "serial") setRouteType(text);
              }
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
              routeConfirmed = true;
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
                          addedIds.push(graphEdgeId(e));
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
        if (!routeConfirmed && effectiveMode === "auto") setRouteType(deduceRouteType(state));
        return;
      }
      setError(String(err?.message || err));
      if (!routeConfirmed && effectiveMode === "auto") setRouteType(deduceRouteType(state));
      void planningRecovery.finish(scope, err?.summary, err?.planningId);
      setPlannerStream((prev) => ({
        ...prev,
        items: closeRunningThinkingItem(prev.items),
        stage: "error",
      }));
    } finally {
      if (abortController && planningAbortControllerRef.current === abortController) {
        planningAbortControllerRef.current = null;
      }
      if (planningRecovery.current(scope)) setIsPlanning(false);
    }
  });

  const handleEditMessageSubmit = useCallback(async (targetMsg: ChatMessage, newText: string, selectedVersion?: number) => {
    const cleanText = newText.trim();
    if (!cleanText) return;
    if (repositoryBlocked) {
      setError(repositoryStatus?.error || t("正在确认项目绑定，请稍后重试。"));
      return;
    }
    if (state.phase === "publishing" || state.phase === "merging" || state.phase === "publication_failed") {
      setError(t("发布期间不能修改消息，请等待发布结束或处理发布失败。"));
      return;
    }

    const cleanExisting = targetMsg.text.replace(/^\[@[^\]]+\]\s*/, "").trim();
    if (cleanText === cleanExisting) {
      setEditingMessage(null);
      setEditPrefillText("");
      return;
    }

    const isPlannerHistoryInitial = routeType === "graph" && !targetMsg.node &&
      targetMsg.id.startsWith("planner-history-") &&
      targetMsg.text.replace(/^\[@[^\]]+\]\s*/, "").trim() === state.graph.originalGoal.trim();
    const isInitialGoal = targetMsg.id === "msg-initial-goal" || isPlannerHistoryInitial || (!targetMsg.node && (
      (sessionEntries.length > 0 && sessionEntries[0].id === targetMsg.id) ||
      effectiveMessages[0]?.id === targetMsg.id
    ));
    if ((isPlanning || recoveredPlanning?.status === "running") && !targetMsg.node && routeType !== "serial") {
      setError(t("请先停止或等待正在运行的 Planner 完成，再修改历史消息。"));
      return false;
    }

    // Choosing an existing version activates that Pi tree branch. It must not
    // be represented as another user edit, otherwise 2/2 would become 3/3.
    if (selectedVersion !== undefined) {
      const selectedVersionData = targetMsg.versions?.[selectedVersion];
      if (!selectedVersionData || selectedVersion < 0 || selectedVersion >= (targetMsg.versions?.length ?? 0)) {
        setError(t("无法定位要切换的对话版本，请重新加载对话后重试。"));
        return false;
      }
      const selectedText = selectedVersionData.text.replace(/^\[@[^\]]+\]\s*/, "").trim();
      if (!selectedText) return false;
      const selectedNode = state.graph.nodes.find((item) => item.name === selected);
      const selectedNodeName = targetMsg.node || (selectedNode ? selectedNode.name : (
        routeType === "serial" && state.graph.nodes.length > 0 ? (state.graph.nodes[0]?.name || "task") : undefined
      ));
      const selectedExecutionId = selectedVersionData.executionId ||
        (selectedNodeName ? executionIdForVersion(state, selectedNodeName, selectedText) : undefined);
      const selectedExecution = selectedExecutionId
        ? state.executions.find(item => item.id === selectedExecutionId)
        : undefined;
      const selectedMessage = {
        ...targetMsg,
        text: selectedText,
        images: selectedVersionData.images,
        currentVersionIndex: selectedVersion,
      };
      try {
        await requireRepository(state.config?.repository || config.repository);
        if (!selectedNodeName) {
          if (routeType !== "graph" || !state.runId) throw new Error(t("当前没有可回退的 Planner 会话。"));
          const snap = await runtimeService.editPlanner({ runId: state.runId,
            oldText: selectedText, instruction: selectedText, versionIndex: selectedVersion });
          setState(snap);
          setSessionEntries([selectedMessage]);
          setGoal(selectedText);
          await handlePlanGoal(selectedText, { images: selectedVersionData.images }, "graph", state.runId, false, selectedMessage);
          return true;
        }
        if (!selectedExecution || selectedExecution.node !== selectedNodeName ||
            !["completed", "failed", "running"].includes(selectedExecution.status)) {
          throw new Error(t("无法定位这条消息对应的 Pi 会话。请重新加载对话后重试。"));
        }
        const snap = await runtimeService.editNode({
          runId: state.runId, node: selectedNodeName, executionId: selectedExecution.id,
          oldText: selectedText, instruction: selectedText, images: selectedVersionData.images,
          versionIndex: selectedVersion,
        });
        setState(snap);
        if (isInitialGoal) setGoal(selectedText);
        setSessionEntries(prev => {
          const index = prev.findIndex(entry => entry.id === targetMsg.id);
          if (index < 0) return [selectedMessage];
          const next = [...prev];
          next[index] = selectedMessage;
          return next.slice(0, index + 1);
        });
        setEditingMessage(null);
        setEditPrefillText("");
        if (snap.paused) setState(await runtimeService.control("resume", { runId: state.runId }));
        return true;
      } catch (error) {
        setError(String(error));
        return false;
      }
    }

    if (isInitialGoal && routeType === "graph" && state.runId && state.planningId) {
      try {
        await requireRepository(state.config?.repository || config.repository);
        const snap = await runtimeService.editPlanner({
          runId: state.runId, oldText: cleanExisting, instruction: cleanText,
        });
        setState(snap);
        const updated: ChatMessage = { ...targetMsg, text: cleanText, runId: state.runId,
          versions: [...(targetMsg.versions ?? [{ id: "v1", text: targetMsg.text, timestamp: Date.now() }]),
            { id: `v${Date.now()}`, text: cleanText, timestamp: Date.now() }],
          currentVersionIndex: (targetMsg.versions?.length ?? 1),
        };
        setSessionEntries([updated]);
        setGoal(cleanText);
        await handlePlanGoal(cleanText, { images: targetMsg.images }, "graph", state.runId, false, updated);
        return true;
      } catch (error) { setError(String(error)); return false; }
    }
    if (!isInitialGoal && routeType === "graph" && state.runId && state.planningId && !targetMsg.node) {
      const msgIdx = sessionEntries.findIndex((entry) => entry.id === targetMsg.id);
      const textIdx = msgIdx >= 0 ? msgIdx : sessionEntries.findIndex((entry) =>
        entry.text.replace(/^\[@[^\]]+\]\s*/, "").trim() === cleanExisting);
      const current = textIdx >= 0 ? sessionEntries[textIdx] : targetMsg;
      const previous = textIdx >= 0
        ? sessionEntries.slice(0, textIdx)
        : (sessionEntries[0] ? [sessionEntries[0]] : []);
      const previousEntry = previous[previous.length - 1];
      const versions = [
        ...(current.versions ?? [{ id: "v1", text: current.text, images: current.images, timestamp: current.timestamp || Date.now() }]),
        { id: `v${Date.now()}`, text: cleanText, images: targetMsg.images, timestamp: Date.now(), subsequentEntries: [] },
      ];
      const updatedPlannerMessage: ChatMessage = {
        ...current, id: current.id || targetMsg.id, parentId: previousEntry?.id ?? null,
        text: cleanText, images: targetMsg.images, runId: state.runId,
        timestamp: Date.now(), versions, currentVersionIndex: versions.length - 1,
      };
      try {
        await requireRepository(state.config?.repository || config.repository);
        const snap = await runtimeService.editPlanner({
          runId: state.runId, oldText: cleanExisting, instruction: cleanText,
        });
        setState(snap);
        // Planner history is rendered from the durable Pi transcript. Keep only
        // the local prefix here; inserting a historical follow-up as the first
        // effective message would place it above the route decision card.
        setSessionEntries(previous);
        await handlePlanGoal(cleanText, { images: targetMsg.images }, "graph", state.runId, false, updatedPlannerMessage);
        return true;
      } catch (error) { setError(String(error)); return false; }
    }

    if (isInitialGoal) {
      // Serial's initial prompt is a Pi user turn too: branch before it in the
      // existing Run instead of pretending a new unrelated Run is a tree edit.
      if (routeType === "serial" && state.approved && state.graph.nodes.length > 0) {
        const node = state.graph.nodes[0].name;
        const first = state.executions.find((execution) => execution.node === node &&
          !state.supersededExecutionIds?.includes(execution.id));
        if (!first || !["completed", "failed"].includes(first.status)) {
          setError(t("请等待当前执行结束后再修改初始消息。"));
          return;
        }
        await run(async () => {
          await requireRepository(state.config?.repository || config.repository);
          const snap = await runtimeService.editNode({
            runId: state.runId, node, executionId: first.id,
            oldText: state.graph.originalGoal, instruction: cleanText, images: targetMsg.images,
          });
          setState(snap);
          setGoal(cleanText);
          setSessionEntries([{ ...targetMsg, id: "msg-initial-goal", node: undefined, text: cleanText,
            versions: [...(targetMsg.versions ?? [{ id: "v1", text: targetMsg.text, images: targetMsg.images, timestamp: Date.now() }]),
              { id: `v${Date.now()}`, text: cleanText, images: targetMsg.images, timestamp: Date.now() }],
            currentVersionIndex: (targetMsg.versions?.length ?? 1),
          }]);
          setEditingMessage(null);
          setEditPrefillText("");
          if (snap.paused) setState(await runtimeService.control("resume", { runId: state.runId }));
        });
        return;
      }
      setEditingMessage(null);
      setEditPrefillText("");

      if (state.runId && (active || isPlanning)) {
        try {
          await runtimeService.control("stop", { runId: state.runId });
        } catch {}
      }

      const currentInitial = sessionEntries[0] || targetMsg;
      const initialVersion: ChatMessageVersion = {
        id: "v1",
        text: currentInitial.text,
        images: currentInitial.images,
        timestamp: currentInitial.timestamp || Date.now(),
        subsequentEntries: sessionEntries.slice(1),
      };
      const newVersion: ChatMessageVersion = {
        id: `v${Date.now()}`,
        text: cleanText,
        images: targetMsg.images,
        timestamp: Date.now(),
        subsequentEntries: [],
      };
      const versions = [...(currentInitial.versions || [initialVersion]), newVersion];

      const updatedInitialMsg: ChatMessage = {
        id: "msg-initial-goal",
        parentId: null,
        role: "user",
        text: cleanText,
        images: targetMsg.images,
        timestamp: Date.now(),
        versions,
        currentVersionIndex: versions.length - 1,
      };

      setSessionEntries([updatedInitialMsg]);
      setGoal(cleanText);

      await handlePlanGoal(
        cleanText,
        { images: targetMsg.images },
        routeType === "undecided" ? "auto" : routeType,
        undefined,
        true
      );
      return;
    }

    const msgIdx = sessionEntries.findIndex((e) => e.id === targetMsg.id);
    const targetIndex = msgIdx !== -1 ? msgIdx : sessionEntries.findIndex((e) => e.text.trim() === targetMsg.text.trim());

    let rolledBackEntries: ChatMessage[];
    let updatedMsg: ChatMessage;

    if (targetIndex !== -1) {
      const current = sessionEntries[targetIndex];
      const prevEntries = sessionEntries.slice(0, targetIndex);
      const parentId = prevEntries.length > 0 ? prevEntries[prevEntries.length - 1].id : null;

      const initialVersion: ChatMessageVersion = {
        id: "v1",
        text: current.text,
        images: current.images,
        timestamp: current.timestamp || Date.now(),
        subsequentEntries: sessionEntries.slice(targetIndex + 1),
      };
      const newVersion: ChatMessageVersion = {
        id: `v${Date.now()}`,
        text: cleanText,
        images: targetMsg.images,
        timestamp: Date.now(),
        subsequentEntries: [],
      };
      const versions = [...(current.versions || [initialVersion]), newVersion];

      updatedMsg = {
        ...current,
        delivery: state.nodes[targetMsg.node || selected]?.status === "done" ? undefined : current.delivery,
        text: cleanText,
        timestamp: Date.now(),
        parentId,
        versions,
        currentVersionIndex: versions.length - 1,
      };
      rolledBackEntries = [...prevEntries, updatedMsg];
    } else {
      const versions = [
        ...(targetMsg.versions ?? [{ id: "v1", text: targetMsg.text, images: targetMsg.images, timestamp: targetMsg.timestamp || Date.now() }]),
        { id: `v${Date.now()}`, text: cleanText, images: targetMsg.images, timestamp: Date.now(), subsequentEntries: [] },
      ];
      updatedMsg = {
        ...targetMsg,
        delivery: state.nodes[targetMsg.node || selected]?.status === "done" ? undefined : targetMsg.delivery,
        text: cleanText,
        timestamp: Date.now(),
        versions,
        currentVersionIndex: versions.length - 1,
      };
      rolledBackEntries = [...sessionEntries, updatedMsg];
    }

    const selectedNode = state.graph.nodes.find((item) => item.name === selected);
    const targetNodeName = targetMsg.node || (selectedNode ? selectedNode.name : (
      routeType === "serial" && state.graph.nodes.length > 0 ? (state.graph.nodes[0]?.name || "task") : undefined
    ));

    if (!targetNodeName) {
      if (routeType !== "graph" || !state.runId) {
        setError(t("当前没有可回退的 Planner 会话。"));
        return false;
      }
      try {
        await requireRepository(state.config?.repository || config.repository);
        const snap = await runtimeService.editPlanner({ runId: state.runId,
          oldText: cleanExisting, instruction: cleanText });
        setState(snap);
        setSessionEntries(rolledBackEntries);
        await handlePlanGoal(cleanText, { images: targetMsg.images }, "graph", state.runId, false, updatedMsg);
        return true;
      } catch (error) { setError(String(error)); return false; }
    }
    {
      const eventSequence = targetMsg.id.startsWith("event-")
        ? Number(targetMsg.id.slice("event-".length)) : NaN;
      const sourceEvent = Number.isInteger(eventSequence)
        ? state.events.find((event) => event.sequence === eventSequence)
        : undefined;
      const resolvedExecutionId = sourceEvent
        ? executionIdForMessage(state, sourceEvent) ?? targetMsg.executionId
        : targetMsg.executionId ?? executionIdForVersion(state, targetNodeName, cleanExisting);
      const execution = state.executions.find((item) => item.id === resolvedExecutionId);
      if (!execution || execution.node !== targetNodeName ||
          !["completed", "failed", "running"].includes(execution.status) ||
          state.supersededExecutionIds?.includes(execution.id)) {
        setError(t("无法定位这条消息对应的 Pi 会话。请重新加载对话后重试。"));
        return;
      }
      let accepted = false;
      await run(async () => {
        await requireRepository(state.config?.repository || config.repository);
        const snap = await runtimeService.editNode({
          runId: state.runId, node: targetNodeName, executionId: execution.id,
          oldText: cleanExisting, instruction: cleanText, images: targetMsg.images,
        });
        setState(snap);
        setSessionEntries(rolledBackEntries);
        setEditingMessage(null);
        setEditPrefillText("");
        accepted = true;
        if (snap.paused) setState(await runtimeService.control("resume", { runId: state.runId }));
      });
      return accepted;
    }
  }, [
    repositoryBlocked,
    repositoryStatus,
    state,
    sessionEntries,
    effectiveMessages,
    routeType,
    selected,
    isPlanning,
    active,
    config,
    plannerStream.runId,
    recoveredPlanning?.status,
    handlePlanGoal,
    requireRepository,
    run,
  ]);

  const handleSwitchMessageVersion = useCallback((message: ChatMessage, index: number) => {
    const version = message.versions?.[index];
    if (!version || index === message.currentVersionIndex) return;
    const execution = version.executionId ? state.executions.find(item => item.id === version.executionId) : undefined;
    void handleEditMessageSubmit({ ...message, images: version.images,
      executionId: execution?.id ?? message.executionId }, version.text, index);
  }, [handleEditMessageSubmit]);

  useEffect(() => {
    load().catch((err) => setError(String(err)));
  }, [load]);

  const hasCurrentPlan = hasCurrentPlanningRun(state, config.repository);

  // A detached browser can discover the persisted planning identity without
  // submitting the goal again. Every response is scoped to this repository.
  useEffect(() => {
    setRecoveredPlanning(null);
    if (!autoRecoverPlanning || busy || isPlanning || hasCurrentPlan || !config.repository) return;
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
  }, [autoRecoverPlanning, busy, isPlanning, hasCurrentPlan, config.repository, planningRecovery]);

  useEffect(() => {
    // Only an actual serial route may auto-start. A manually edited Graph IR
    // with a single node named "task" must still wait for explicit approval.
    if (state.planType === "serial" && routeType === "serial" && state.phase === "awaiting_approval" && !busy && !repositoryBlocked) {
      control("approve");
    }
  }, [routeType, state.planType, state.phase, busy, repositoryBlocked]);

  const handleInterrupt = useCallback(async () => {
    if (planningAbortControllerRef.current) {
      planningAbortControllerRef.current.abort();
      planningAbortControllerRef.current = null;
    }
    try {
      const runId = state.runId || plannerStream.runId;
      await runtimeService.control("stop", runId ? { runId } : {});
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
  }, [isPlanning, state.runId, plannerStream.runId]);

  const { nodes, edges } = useGraphElements(state, selected, recentlyAddedEdgeIds);

  const isLandingView = state.graph.nodes.length === 0 &&
    !isPlanning &&
    !recoveredPlanning &&
    !failedPlanning;

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
            onLoadRun={(id) => {
              if (id !== state.runId || isPlanning || recoveredPlanning) detachForeground(config.repository);
              historyPrefetchRef.current?.abort();
              const controller = new AbortController();
              historyPrefetchRef.current = controller;
              const generation = foregroundGeneration.current;
              run(async () => {
                clearRunUnread(id);
                if (id !== state.runId) setPlannerStream(initialPlannerStream);
                // Show the conversation as soon as its snapshot arrives. Loading
                // planner output or node logs must never block opening the card.
                let snapshot: Snapshot;
                try {
                  snapshot = await runtimeService.snapshotForRun(id, controller.signal);
                } catch (error) {
                  if (controller.signal.aborted) return;
                  throw error;
                }
                if (controller.signal.aborted || generation !== foregroundGeneration.current) return;
                const deduced = deduceRouteType(snapshot);
                setState(snapshot);
                markSnapshotRead(snapshot);
                setRouteType(deduced);
                setGoal(snapshot.graph.originalGoal || (id ? runLabels[id] : "") || "");
                if (id !== state.runId) {
                  setSessionEntries(messagesByRunRef.current.get(id) ?? []);
                  setEditingMessage(null);
                  setEditPrefillText("");
                }
                setSelected("");

                // Mounted node transcripts fetch only their own history.
                // Unselected nodes never allocate or transfer historical logs.
              });
            }}
            onDeleteRun={handleDeleteRunConfirm}
            onNewConversation={handleNewConversation}
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
                      <span className="floating-error-text">{localizeError(error)}</span>
                    </div>
                    <button
                      type="button"
                      className="floating-error-close"
                      aria-label={t("关闭错误提示")}
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
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.18 } }}
                  transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                >
                  {recoveredPlanning && <section aria-label={t("恢复进行中的规划")} className="recovered-planning-section">
                    <p role="status">{t("已连接正在进行的规划，活动会自动更新。")}</p>
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
                    onEditMessageSubmit={handleEditMessageSubmit}
                    onSwitchMessageVersion={handleSwitchMessageVersion}
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
                    repoInfo={repoInfo}
                    config={config}
                    active={active}
                    locked={locked}
                    pendingRequest={busy}
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
