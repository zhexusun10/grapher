import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkerType, type Edge } from "@xyflow/react";
import { AlertTriangle, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

import {
  defaultConfig, emptyGraph, emptySnapshot,
  type Config, type Graph, type Plan, type ProjectItem, type RepositoryInfo,
  type Snapshot, type PlanRouteType, type TranscriptItem, type NodeState,
  type PlanningSummary, type Execution, type PlanMode, type ChatMessage
} from "./types";
import { tokens } from "./tokens";
import { runtimeService } from "./services/runtime";
import { providerAuth } from "./services/providerAuth";
import { useRepositoryStatus } from "./hooks/useRepositoryStatus";
import { deduceRouteType } from "./services/executionRoute";
import { createPlanningRecovery, hasCurrentPlanningRun, planningRecoveryDelay } from "./services/planningRecovery";

import { TaskNode, type WorkNode } from "./components/graph/TaskNode";
import { SmoothWorkflowEdge } from "./components/graph/WorkflowEdge";
import { Sidebar } from "./components/layout/Sidebar";
import { LandingView } from "./components/views/LandingView";
import { FloatingPathsBackground } from "./components/ui/floating-paths";
import { GraphWorkbench } from "./components/views/GraphWorkbench";
import { PlanningSummaryCard } from "./components/PlanningSummaryCard";
import { PublicationPanel } from "./components/PublicationPanel";
import { ApprovalModal } from "./components/modals/ApprovalModal";
import { ConfirmModal, type ConfirmModalState } from "./components/modals/ConfirmModal";

import { SettingsModal } from "./components/modals/SettingsModal";
import { EditorModal } from "./components/modals/EditorModal";

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

function areExecutionStreamsEqual(a: Execution[] = [], b: Execution[] = []): boolean {
  return a.length === b.length && a.every((execution, index) => {
    const next = b[index];
    return execution.id === next.id && execution.status === next.status &&
      (execution.outputBytes ?? execution.output.length) === (next.outputBytes ?? next.output.length);
  });
}

function executionActivityVersion(executions: Execution[] = []): string {
  return executions.map((execution) =>
    `${execution.id}:${execution.status}:${execution.outputBytes ?? execution.output.length}`
  ).join(",");
}

function snapshotActivityVersion(snapshot: Snapshot): string {
  const lastSequence = snapshot.events.at(-1)?.sequence ?? 0;
  return [
    snapshot.phase,
    snapshot.approved ? "approved" : "unapproved",
    lastSequence,
    executionActivityVersion(snapshot.executions),
    executionActivityVersion(snapshot.mergers),
    snapshot.publication?.status ?? "",
  ].join("|");
}

const nodeTypes = { work: TaskNode };
const edgeTypes = { workflow: SmoothWorkflowEdge };

function computeExecutionLayers(graph: Graph, plan?: Plan | null): string[][] {
  if (plan?.executionBatches && plan.executionBatches.length > 0) {
    return plan.executionBatches;
  }
  const nodeNames = graph.nodes.map((n) => n.name);
  if (nodeNames.length === 0) return [];
  const deps = graph.edges.filter(
    (e) => !e.feedback && nodeNames.includes(e.from) && nodeNames.includes(e.to)
  );
  const inDegree = new Map<string, number>(nodeNames.map((n) => [n, 0]));
  for (const edge of deps) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  let ready = nodeNames.filter((n) => inDegree.get(n) === 0);
  const visited = new Set<string>();
  const batches: string[][] = [];
  while (ready.length > 0) {
    batches.push(ready);
    const next: string[] = [];
    for (const name of ready) {
      visited.add(name);
      for (const edge of deps.filter((e) => e.from === name)) {
        const deg = (inDegree.get(edge.to) ?? 1) - 1;
        inDegree.set(edge.to, deg);
        if (deg === 0) next.push(edge.to);
      }
    }
    ready = next;
  }
  const remaining = nodeNames.filter((n) => !visited.has(n));
  if (remaining.length > 0) batches.push(remaining);
  return batches.length > 0 ? batches : [nodeNames];
}

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
    let initialConfig: Config = { ...defaultConfig };
    try {
      const savedConfig = localStorage.getItem("grapher_config");
      if (savedConfig) {
        const parsed = JSON.parse(savedConfig);
        initialConfig = { ...initialConfig, ...parsed };
      }
    } catch {}
    try {
      const saved = localStorage.getItem("grapher_projects");
      if (saved) {
        const list: ProjectItem[] = JSON.parse(saved);
        if (list.length > 0) {
          const sorted = [...list].sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
          if (!initialConfig.repository && sorted[0]?.path) {
            initialConfig.repository = sorted[0].path;
          }
        }
      }
    } catch {}
    return initialConfig;
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

  const [recentlyAddedEdgeIds, setRecentlyAddedEdgeIds] = useState<Set<string>>(new Set());
  const pendingToolArgsRef = useRef<Map<string, any>>(new Map());

  const currentRepoPath = useMemo(() => config.repository || repoInfo?.path || "default", [config.repository, repoInfo]);
  const runs = useMemo(() => workspaceRuns[currentRepoPath] || [], [workspaceRuns, currentRepoPath]);
  
  useEffect(() => {
    const missing = runs.filter(id => !(id in runLabels));
    if (missing.length > 0) {
      missing.forEach(id => {
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
        });
      });
    }
  }, [runs, runLabels, runtimeService]);
  const [activeBackendRunId, setActiveBackendRunId] = useState<string | null>(null);
  const [activeBackendPhase, setActiveBackendPhase] = useState<string | null>(null);
  const [runIndicators, setRunIndicators] = useState<Record<string, { unread: boolean; phase: string }>>({});
  const runActivityVersionsRef = useRef(new Map<string, string>());
  const viewedRunIdRef = useRef(state.runId);
  viewedRunIdRef.current = state.runId;

  const markSnapshotRead = useCallback((snapshot: Snapshot) => {
    if (!snapshot.runId) return;
    runActivityVersionsRef.current.set(snapshot.runId, snapshotActivityVersion(snapshot));
    setRunIndicators((prev) => {
      const current = prev[snapshot.runId];
      if (current && !current.unread && current.phase === snapshot.phase) return prev;
      return { ...prev, [snapshot.runId]: { unread: false, phase: snapshot.phase } };
    });
  }, []);

  const clearRunUnread = useCallback((runId: string) => {
    setRunIndicators((prev) => {
      const current = prev[runId];
      if (!current?.unread) return prev;
      return { ...prev, [runId]: { ...current, unread: false } };
    });
  }, []);

  const observeRunSnapshot = useCallback((snapshot: Snapshot) => {
    if (!snapshot.runId) return;
    const nextVersion = snapshotActivityVersion(snapshot);
    const previousVersion = runActivityVersionsRef.current.get(snapshot.runId);
    runActivityVersionsRef.current.set(snapshot.runId, nextVersion);
    const isViewed = viewedRunIdRef.current === snapshot.runId;

    setRunIndicators((prev) => {
      const current = prev[snapshot.runId];
      const hasNewContent = previousVersion !== undefined && previousVersion !== nextVersion;
      const unread = isViewed ? false : Boolean(current?.unread || hasNewContent);
      if (current?.unread === unread && current.phase === snapshot.phase) return prev;
      return { ...prev, [snapshot.runId]: { unread, phase: snapshot.phase } };
    });
  }, []);

  useEffect(() => {
    markSnapshotRead(state);
  }, [state, markSnapshotRead]);

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

  // 对话流消息树结构（移植自 pi 的 /tree 架构，no summary 版本）
  const [sessionEntries, setSessionEntries] = useState<ChatMessage[]>([]);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
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
    setActiveLeafId(null);
    setEditingMessage(null);
    setEditPrefillText("");
  }, []);

  // 沿 parentId 回溯构造当前分支链（从根节点至当前叶子节点）
  const getBranch = useCallback((leafId: string | null, entries: ChatMessage[]): ChatMessage[] => {
    if (!leafId || entries.length === 0) return [];
    const byId = new Map<string, ChatMessage>();
    for (const entry of entries) {
      byId.set(entry.id, entry);
    }
    const path: ChatMessage[] = [];
    let current = byId.get(leafId);
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    path.reverse();
    return path;
  }, []);

  const branchMessages = useMemo(() => {
    return getBranch(activeLeafId, sessionEntries);
  }, [activeLeafId, sessionEntries, getBranch]);

  const effectiveMessages = useMemo<ChatMessage[]>(() => {
    if (branchMessages.length > 0) return branchMessages;
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
  }, [branchMessages, state.graph.originalGoal, goal]);

  // 计算分支信息（同一 parentId 下存在多个 sibling 分支时的页码与切换目标）
  const branchInfo = useMemo(() => {
    const map: Record<string, { index: number; count: number; prevId?: string; nextId?: string }> = {};
    if (sessionEntries.length === 0) return map;

    const siblingsByParent = new Map<string | null, ChatMessage[]>();
    for (const entry of sessionEntries) {
      const p = entry.parentId ?? null;
      const list = siblingsByParent.get(p) || [];
      list.push(entry);
      siblingsByParent.set(p, list);
    }

    for (const siblings of siblingsByParent.values()) {
      if (siblings.length > 1) {
        siblings.forEach((s, idx) => {
          map[s.id] = {
            index: idx,
            count: siblings.length,
            prevId: idx > 0 ? siblings[idx - 1].id : undefined,
            nextId: idx < siblings.length - 1 ? siblings[idx + 1].id : undefined,
          };
        });
      }
    }
    return map;
  }, [sessionEntries]);

  // 切换到同级兄弟分支（沿着该节点深入到最新叶子节点）
  const handleSwitchBranch = useCallback((targetId: string) => {
    let currentId = targetId;
    while (true) {
      const children = sessionEntries.filter((e) => (e.parentId ?? null) === currentId);
      if (children.length === 0) break;
      currentId = children[children.length - 1].id;
    }
    setActiveLeafId(currentId);
    setEditingMessage(null);
    setEditPrefillText("");
  }, [sessionEntries]);

  const [routeType, setRouteType] = useState<PlanRouteType>(() => deduceRouteType(emptySnapshot));

  // 开始编辑消息
  const handleStartEditMessage = useCallback((msg: ChatMessage) => {
    const isSerialExecution = routeType === "serial" && state.graph.nodes.length > 0;
    if (!selected && !isSerialExecution && state.approved) {
      return;
    }
    setEditingMessage(msg);
    // 剥离可能存在的 [@node] 格式前缀以便用户编辑纯指令
    const cleanText = msg.text.replace(/^\[@[^\]]+\]\s*/, "");
    setEditPrefillText(cleanText);
  }, [routeType, selected, state.approved, state.graph.nodes.length]);

  const handleCancelEditMessage = useCallback(() => {
    setEditingMessage(null);
    setEditPrefillText("");
  }, []);

  const initialPlannerStream = {
    stage: "idle" as "idle" | "partitioning" | "planning" | "done" | "error",
    items: [] as TranscriptItem[],
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
    if (["approve", "resume", "intervene", "resolve", "retry_publication"].includes(action)) {
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

  // 待办跟进队列（用于运行中输入的 Follow-up 指令）
  const [followUpQueue, setFollowUpQueue] = useState<Array<{ id: string; text: string; node?: string; timestamp: number }>>([]);

  const handleCancelFollowUp = (id: string) => {
    setFollowUpQueue((prev) => prev.filter((item) => item.id !== id));
  };

  const handleSendMessage = (
    val: string,
    options?: { mode?: "followUp" | "steer"; displayText?: string; rawText?: string; files?: File[] }
  ) => {
    const text = val.trim();
    if (!text) return;
    if (repositoryBlocked) {
      setError(repositoryStatus?.error || "正在确认项目绑定，请稍后重试。");
      return;
    }
    const selectedNode = state.graph.nodes.find((item) => item.name === selected);
    const targetNodeName = selectedNode
      ? selectedNode.name
      : (routeType === "serial" && state.graph.nodes.length > 0
          ? (state.graph.nodes[0]?.name || "task")
          : undefined);

    // 用户 approve graph 之后禁止再向 planner 发送消息
    if (!targetNodeName && state.approved) {
      return;
    }

    const displayMsg = options?.displayText || text;
    const parentId = editingMessage
      ? (editingMessage.parentId ?? null)
      : (activeLeafId ?? (effectiveMessages.length > 0 ? effectiveMessages[effectiveMessages.length - 1].id : null));

    const recordMessage = (textToRecord: string) => {
      const newMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        parentId,
        role: "user",
        text: textToRecord,
        timestamp: Date.now(),
      };
      setSessionEntries((prev) => [...prev, newMsg]);
      setActiveLeafId(newMsg.id);
      setEditingMessage(null);
      setEditPrefillText("");
      return newMsg;
    };

    if (isPlanning) {
      // 规划器正在工作中，用户发送补充或纠偏要求，直接转向 (Steer)
      recordMessage(displayMsg);
      (async () => {
        // 1. 中止当前的规划流请求
        if (planningAbortControllerRef.current) {
          planningAbortControllerRef.current.abort();
          planningAbortControllerRef.current = null;
        }
        // 2. 终止后端当前正在运行的 Pi 规划进程
        try {
          await runtimeService.control("stop");
        } catch (e) {
          console.warn("Stop command before steer failed:", e);
        }
        // 3. 稍等片刻确保退出
        await new Promise((r) => setTimeout(r, 100));
        // 4. 将新指令作为转向补充要求，重新触发规划
        const baseGoal = state.graph.originalGoal || goal;
        const combinedGoal = baseGoal ? `${baseGoal}\n\n补充规划要求（实时转向）：\n${text}` : text;
        handlePlanGoal(combinedGoal, options);
      })();
      return;
    }

    if (active) {
      const displayLabel = targetNodeName && targetNodeName !== "task" ? `[@${targetNodeName}] ` : "";
      recordMessage(`${displayLabel}${displayMsg}`);
      run(async () => {
        await requireRepository(state.config?.repository || config.repository);
        try {
          await runtimeService.control("stop");
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 120));
        if (targetNodeName) {
          const snap = await runtimeService.control("intervene", {
            node: targetNodeName,
            instruction: text,
          });
          setState(snap);
        } else {
          const baseGoal = state.graph.originalGoal || goal;
          const combinedGoal = baseGoal ? `${baseGoal}\n\n补充执行要求：\n${text}` : text;
          handlePlanGoal(combinedGoal, options);
        }
      });
      return;
    }

    if (selectedNode) {
      // 针对具体选定节点的微调与介入
      recordMessage(`[@${selectedNode.name}] ${displayMsg}`);
      control("intervene", { node: selectedNode.name, instruction: text });
    } else if (routeType === "serial" && state.graph.nodes.length > 0) {
      // 串行单任务介入
      recordMessage(displayMsg);
      control("intervene", { node: state.graph.nodes[0]?.name || "task", instruction: text });
    } else {
      // 未选中具体节点：处于与 AI 规划器对话面板，追加规划要求并触发重新规划
      const baseGoal = state.graph.originalGoal || goal;
      const combinedGoal = baseGoal ? `${baseGoal}\n\n补充规划要求：\n${text}` : text;
      handlePlanGoal(combinedGoal, options);
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

    if (storedProjects !== null) {
      if (data.repositoryInfo) {
        const info = data.repositoryInfo;
        const exists = storedProjects.some((p) => p.path === info.path);
        if (exists) {
          const updatedProjects = storedProjects.map((p) =>
            p.path === info.path
              ? { ...p, branch: info.branch, clean: info.clean, isShadow: info.isShadow, lastOpened: Date.now() }
              : p
          );
          setProjects(updatedProjects);
          try {
            localStorage.setItem("grapher_projects", JSON.stringify(updatedProjects));
          } catch {}
          activeRepo = info.path;
          activeInfo = info;
        } else if (storedProjects.length > 0) {
          const sorted = [...storedProjects].sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
          setProjects(storedProjects);
          activeRepo = sorted[0].path;
          activeInfo = {
            name: sorted[0].name,
            path: sorted[0].path,
            branch: sorted[0].branch,
            head: sorted[0].branch || "",
            clean: sorted[0].clean,
            isShadow: sorted[0].isShadow,
          };
        } else {
          setProjects([]);
          activeRepo = "";
          activeInfo = null;
        }
      } else if (storedProjects.length > 0) {
        const sorted = [...storedProjects].sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
        setProjects(storedProjects);
        activeRepo = sorted[0].path;
        activeInfo = {
          name: sorted[0].name,
          path: sorted[0].path,
          branch: sorted[0].branch,
          head: sorted[0].branch || "",
          clean: sorted[0].clean,
          isShadow: sorted[0].isShadow,
        };
      } else {
        setProjects([]);
        activeRepo = "";
        activeInfo = null;
      }
    } else {
      if (data.repositoryInfo) {
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
      }
    }

    setRepoInfo(activeInfo);
    let savedModel = "";
    try {
      const raw = localStorage.getItem("grapher_config");
      if (raw) savedModel = JSON.parse(raw).model || "";
    } catch {}

    // Choose model with priority:
    // 1) savedModel with a provider prefix ("provider/model")
    // 2) backend data.config.model with a provider prefix
    // 3) non-empty savedModel
    // 4) backend data.config.model
    let chosenModel = "";
    if (savedModel && savedModel.includes("/")) {
      chosenModel = savedModel;
    } else if (data.config?.model && data.config.model.includes("/")) {
      chosenModel = data.config.model;
    } else if (savedModel) {
      chosenModel = savedModel;
    } else if (data.config?.model) {
      chosenModel = data.config.model;
    } else {
      chosenModel = "";
    }

    const nextConfigObj: Config = {
      ...data.config,
      model: chosenModel,
      repository: activeRepo || (activeInfo ? activeInfo.path : ""),
    };
    setConfig(nextConfigObj);
    setDataPath(data.dataPath);

    if (chosenModel && chosenModel !== data.config?.model) {
      try {
        const synced = await runtimeService.saveConfig(nextConfigObj);
        if (synced.effectiveRoleModels) setEffectiveRoleModels(synced.effectiveRoleModels);
        if (synced.envOverrides) setEnvOverrides(synced.envOverrides);
      } catch (err) {
        console.warn("Failed to sync initial model to backend:", err);
      }
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
    if (
      activeRepo &&
      data.snapshot.runId &&
      (data.snapshot.config?.repository === activeRepo || (!data.snapshot.config?.repository && activeRepo === (data.repositoryInfo?.path || ""))) &&
      currentRuns.includes(data.snapshot.runId)
    ) {
      const deduced = deduceRouteType(data.snapshot);
      setState(data.snapshot);
      markSnapshotRead(data.snapshot);
      setActiveBackendRunId(data.snapshot.runId);
      setActiveBackendPhase(data.snapshot.phase);
      setRouteType(deduced);
      setGoal(data.snapshot.graph.originalGoal);
      setSelected("");
    } else if (activeRepo && currentRuns.length > 0) {
      try {
        const snap = await runtimeService.loadRun(currentRuns[0]);
        const deduced = deduceRouteType(snap);
        setState(snap);
        setRouteType(deduced);
        setGoal(snap.graph.originalGoal || "");
        setSelected("");
      } catch {
        setState(emptySnapshot);
        setRouteType("undecided");
        setGoal("");
        setSelected("");
      }
    } else {
      setState(emptySnapshot);
      setRouteType("undecided");
      setGoal("");
      setSelected("");
      resetSessionMessages();
    }

    const targetRepo = activeRepo || data.config.repository || data.repositoryInfo?.path;
    if (targetRepo) {
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

  const handleSaveConfig = () => run(async () => {
    let repoPath = config.repository.trim();
    let info: RepositoryInfo | null = null;
    if (repoPath) {
      info = await runtimeService.detectRepository(repoPath);
      if (!info) throw new Error("目标路径不存在或无法作为工作区加载。");
      setRepoInfo(info);
      repoPath = info.path;
    }
    const nextConfig = { ...config, repository: repoPath };
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
    const snapshot = await runtimeService.saveGraph(graph, config);
    const deduced = deduceRouteType(snapshot);
    setState(snapshot);
    setRouteType(deduced);
    setGoal(graph.originalGoal);
    setModal(null);
    recordRunToWorkspace(snapshot.runId);
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
    options?: { displayText?: string; rawText?: string; files?: File[] }
  ) => run(async () => {
    const targetGoal = (inputGoal !== undefined ? inputGoal : goal).trim();
    if (!targetGoal) return;
    if (config.repository) await requireRepository(config.repository);
    setGoal(targetGoal);
    setError("");
    setIsPlanning(true);
    setRouteType("undecided");
    setPlannerStream({
      stage: "partitioning",
      items: [],
      partitionerThinking: "",
      partitionerThinkingActive: false,
      partitionerText: "",
      plannerThinking: "",
      plannerThinkingActive: false,
      plannerText: "",
      tools: [],
    });
    setSelected("");
    const parentId = editingMessage ? (editingMessage.parentId ?? null) : null;
    const newMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      parentId,
      role: "user",
      text: options?.displayText || targetGoal,
      timestamp: Date.now(),
    };
    setSessionEntries((prev) => [...prev, newMsg]);
    setActiveLeafId(newMsg.id);
    setEditingMessage(null);
    setEditPrefillText("");

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

            if (!isErr) {
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
            void planningRecovery.finish(scope);
          }
        }
      },
      planMode,
      abortController.signal
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
        items: closeRunningThinkingItem(prev.items),
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

  // Point 1: Adaptive Polling Interval with Fast Equality Diffing
  useEffect(() => {
    if (busy) return;

    // Check if background work is actively running/publishing/merging/approving
    const isTaskActive = activeBackendRunId &&
      ["running", "awaiting_approval", "publishing", "merging"].includes(activeBackendPhase ?? "");

    // Keep execution responsive without fetching full metadata every second.
    const pollInterval = isTaskActive ? 2500 : 3500;

    let cancelled = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
          const newSnap = await runtimeService.snapshot(abort.signal);
          if (cancelled) return;
          if (!newSnap || !newSnap.runId) {
            setActiveBackendRunId(null);
            setActiveBackendPhase(null);
            return;
          }
          setActiveBackendRunId(newSnap.runId);
          setActiveBackendPhase(newSnap.phase);
          observeRunSnapshot(newSnap);

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
              areExecutionStreamsEqual(prev.executions, newSnap.executions) &&
              areExecutionStreamsEqual(prev.mergers, newSnap.mergers) &&
              areNodesEqual(prev.nodes, newSnap.nodes) &&
              areFeedbackCountsEqual(prev.feedbackCounts, newSnap.feedbackCounts)
            ) {
              return prev;
            }
            return newSnap;
          });
      } catch (err) {
        if (!cancelled) console.warn("Snapshot poll error:", err);
      } finally {
        // Wait for the current response before scheduling another large snapshot.
        if (!cancelled) timer = setTimeout(poll, pollInterval);
      }
    };
    timer = setTimeout(poll, pollInterval);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      abort.abort();
    };
  }, [busy, activeBackendRunId, activeBackendPhase, observeRunSnapshot]);

  useEffect(() => {
    if (routeType === "serial" && state.phase === "awaiting_approval" && !busy && !repositoryBlocked) {
      control("approve");
    }
  }, [routeType, state.phase, busy, repositoryBlocked]);

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

  // 自动出队并派发排队跟进的 Follow-up 指令
  const prevActiveRef = useRef(active);
  useEffect(() => {
    if (prevActiveRef.current && !active && followUpQueue.length > 0) {
      const nextItem = followUpQueue[0];
      setFollowUpQueue((prev) => prev.slice(1));
      const targetNodeName = nextItem.node || (routeType === "serial" && state.graph.nodes.length > 0 ? (state.graph.nodes[0]?.name || "task") : undefined);
      if (targetNodeName) {
        control("intervene", { node: targetNodeName, instruction: nextItem.text });
      } else {
        if (state.approved) return;
        const baseGoal = state.graph.originalGoal || goal;
        const combinedGoal = baseGoal ? `${baseGoal}\n\n补充执行要求：\n${nextItem.text}` : nextItem.text;
        handlePlanGoal(combinedGoal);
      }
    }
    prevActiveRef.current = active;
  }, [active, followUpQueue, routeType, state.graph.nodes, state.graph.originalGoal, goal]);

  const nodes = useMemo<WorkNode[]>(() => {
    const layers = computeExecutionLayers(state.graph, state.plan);
    const getNodeX = (nodeName: string) => {
      const layer = Math.max(0, layers.findIndex((batch) => batch.includes(nodeName)));
      const batch = layers[layer] || [];
      const idx = batch.indexOf(nodeName);
      const safeIndex = idx >= 0 ? idx : 0;
      return (safeIndex - (Math.max(1, batch.length) - 1) / 2) * 260 + 160;
    };

    return state.graph.nodes.map((node) => {
      const layer = Math.max(0, layers.findIndex((batch) => batch.includes(node.name)));
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
          x: getNodeX(node.name),
          y: layer * 180 + 24,
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
    const layers = computeExecutionLayers(state.graph, state.plan);
    const getNodeX = (nodeName: string) => {
      const layer = Math.max(0, layers.findIndex((batch) => batch.includes(nodeName)));
      const batch = layers[layer] || [];
      const idx = batch.indexOf(nodeName);
      const safeIndex = idx >= 0 ? idx : 0;
      return (safeIndex - (Math.max(1, batch.length) - 1) / 2) * 260 + 160;
    };

    return state.graph.edges.map((edge) => {
      const isFeedback = !!edge.feedback;
      const useRight = isFeedback && (getNodeX(edge.from) > 160 && getNodeX(edge.to) > 160);
      const sourceHandle = isFeedback ? (useRight ? "right-source" : "left-source") : "bottom";
      const targetHandle = isFeedback ? (useRight ? "right-target" : "left-target") : "top";
      const edgeId = `${edge.from}-${isFeedback ? "fb" : "dep"}-${edge.to}`;
      const isNew = recentlyAddedEdgeIds.has(edgeId);

      return {
        id: edgeId,
        source: edge.from,
        target: edge.to,
        type: isFeedback ? "smoothstep" : "workflow",
        sourceHandle,
        targetHandle,
        className: isNew ? "edge-entering" : undefined,
        animated: !isFeedback && state.nodes[edge.from]?.status === "running",
        pathOptions: isFeedback ? { borderRadius: 20, offset: 35 } : undefined,
        markerEnd: isFeedback ? "url(#workflow-arrow-feedback)" : "url(#workflow-arrow-default)",
        data: { isNew },
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
  }, [state.graph.edges, state.graph.nodes, state.plan, state.nodes, recentlyAddedEdgeIds]);

  const isLandingView = state.graph.nodes.length === 0 &&
    !isPlanning &&
    !recoveredPlanning &&
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
        activeBackendRunId={activeBackendRunId}
        activeBackendPhase={activeBackendPhase}
        runIndicators={runIndicators}
        onLoadRun={(id) => run(async () => {
          clearRunUnread(id);
          if (id !== state.runId) setPlannerStream(initialPlannerStream);
          const snapshot = await runtimeService.loadRun(id);
          const deduced = deduceRouteType(snapshot);
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
        {repositoryBlocked && (
          <div className="background-run-banner" role="alert">
            <span>{repositoryStatus?.error || "项目绑定已失效，请重新选择目录。"} <code>{config.repository}</code></span>
            <button type="button" onClick={handleOpenProject} disabled={busy}>重新选择目录</button>
            {active && <button type="button" onClick={() => control("cancel")} disabled={busy}>停止执行</button>}
          </div>
        )}
        {activeBackendRunId &&
          ["running", "publishing", "merging"].includes(activeBackendPhase ?? "") &&
          state.runId !== activeBackendRunId && (
            <div className="background-run-banner">
              <div className="background-run-info">
                <span className="pulse-indicator" />
                <span>
                  后台有任务正在执行中: <strong>Graph {activeBackendRunId.slice(0, 8)}</strong>
                </span>
              </div>
              <button
                type="button"
                className="background-run-action-btn"
                onClick={() => run(async () => {
                  clearRunUnread(activeBackendRunId);
                  if (activeBackendRunId !== state.runId) setPlannerStream(initialPlannerStream);
                  const snapshot = await runtimeService.loadRun(activeBackendRunId);
                  const deduced = deduceRouteType(snapshot);
                  setState(snapshot);
                  markSnapshotRead(snapshot);
                  setRouteType(deduced);
                  setGoal(snapshot.graph.originalGoal || "");
                  if (activeBackendRunId !== state.runId) resetSessionMessages();
                  setSelected("");
                })}
              >
                返回运行中的任务
              </button>
            </div>
        )}

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
            />
          ) : (
            <motion.div
              key="workspace-view"
              className="workspace-view-wrapper"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.18 } }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            >
              {recoveredPlanning && <section aria-label="恢复进行中的规划">
                <p role="status">已连接正在进行的规划，活动会自动更新。</p>
                <PlanningSummaryCard planning={recoveredPlanning} />
              </section>}
              <PublicationPanel
                key={state.runId}
                runId={state.runId}
                publication={state.publication}
                mergers={state.mergers ?? []}
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
                branchInfo={branchInfo}
                onSwitchBranch={handleSwitchBranch}
                onEditMessage={handleStartEditMessage}
                editingMessage={editingMessage}
                editPrefillText={editPrefillText}
                onEditPrefillTextChange={setEditPrefillText}
                onCancelEditMessage={handleCancelEditMessage}
                isWorking={isAgentWorking}
                onInterrupt={handleInterrupt}
                isPlanning={isPlanning || !!recoveredPlanning}
                plannerStream={plannerStream}
                onSendMessage={handleSendMessage}
                followUpQueue={followUpQueue}
                onCancelFollowUp={handleCancelFollowUp}
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
            repoInfo={repoInfo}
            dataPath={dataPath}
            effectiveRoleModels={effectiveRoleModels}
            envOverrides={envOverrides}
            onOpenProject={handleOpenProject}
            onDetectRepository={handleDetectRepository}
            onResetWorkspace={handleResetWorkspace}
            onClearHistory={handleClearHistory}
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
