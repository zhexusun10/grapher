import { t, localizeError } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { motion, AnimatePresence, LayoutGroup } from "motion/react";

import {
  defaultConfig, emptyGraph, emptySnapshot, publicationMergerCardId,
  type Config, type Graph, type ProjectItem, type RepositoryInfo,
  type Snapshot, type PlanRouteType, type TranscriptItem,
  type RuntimeActivity,
  type PlanningSummary, type PlanMode, type ChatMessage,
  type ImageAttachment, type FileAttachment, type ChatMessageVersion
} from "./types";
import { parseMessageAttachmentsAndText } from "./utils/attachmentUtils";
import { tokens } from "./tokens";
import { runtimeService } from "./services/runtime";
import { providerAuth } from "./services/providerAuth";
import { modelRoles, planningModelRoles, roleModelConfig } from "./modelConfig";
import { useRepositoryStatus } from "./hooks/useRepositoryStatus";
import { deduceRouteType } from "./services/executionRoute";
import { createPlanningRecovery, hasCurrentPlanningRun, planningRecoveryDelay } from "./services/planningRecovery";
import { executionIdForMessage, executionIdForVersion } from "./services/conversationBranch";
import { closeThinkingItems, finalizeThinkingItems, updateThinkingItems } from "./services/thinkingTranscript";
import { appendItemDelta } from "./services/transcriptUpdates";
import { mapWithConcurrency } from "./services/boundedRequests";
import { useSnapshotState } from "./hooks/useSnapshotState";
import { useConversationTranscriptCache } from "./hooks/useConversationTranscriptCache";
import { useFrameBatchedState } from "./hooks/useFrameBatchedState";
import { useStableCallback } from "./hooks/useStableCallback";
import { resetPresentedCardIds } from "./services/cardAnimations";

import { TaskNode } from "./components/graph/TaskNode";
import { graphEdgeId, useGraphElements } from "./hooks/useGraphElements";
import { useSnapshotPolling } from "./hooks/useSnapshotPolling";
import { useRunIndicators } from "./hooks/useRunIndicators";
import { SmoothWorkflowEdge } from "./components/graph/WorkflowEdge";
import { Sidebar } from "./components/layout/Sidebar";
import { bindRunToWorkspace, normalizeWorkspacePath, reconcileWorkspaceRuns, snapshotBelongsToWorkspace, workspaceKey } from "./services/workspaceConversations";
import { loadLandingDraft, saveLandingDraft, clearLandingDraft } from "./services/landingDraft";
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
  const [state, setState] = useSnapshotState(emptySnapshot);
  const [projects, setProjects] = useState<ProjectItem[]>(() => {
    try {
      const saved = localStorage.getItem("grapher_projects");
      if (!saved) return [];
      const items: ProjectItem[] = JSON.parse(saved);
      return items.map((p) => ({
        ...p,
        path: normalizeWorkspacePath(p.path),
        id: normalizeWorkspacePath(p.id || p.path),
      }));
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
            initialConfig.repository = normalizeWorkspacePath(sorted[0].path);
          }
        }
      }
    } catch { }
    return { ...initialConfig, repository: normalizeWorkspacePath(initialConfig.repository), maxFeedback: 3 };
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
  const [landingGoal, setLandingGoal] = useState<string>(() => loadLandingDraft(config.repository));

  useEffect(() => {
    setLandingGoal(loadLandingDraft(config.repository));
  }, [config.repository]);

  const handleLandingGoalChange = useCallback((val: string) => {
    setLandingGoal(val);
    saveLandingDraft(config.repository, val);
  }, [config.repository]);
  const [selected, setSelected] = useState<string>("");
  const [selectedMergerId, setSelectedMergerId] = useState<string>("");
  // A merger card is only meaningful together with its owning node selection.
  useEffect(() => {
    if (!selected) setSelectedMergerId("");
  }, [selected]);
  const [modal, setModal] = useState<"settings" | "editor" | "approval" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [isOpeningProject, setIsOpeningProject] = useState(false);
  const foregroundGeneration = useRef(0);
  const workbenchIdentityRef = useRef({ runId: "", key: "initial" });
  // Session-local unsent text outlives a mounted workbench, but never crosses Runs.
  const composerDraftsRef = useRef(new Map<string, Map<string, string>>());
  const historyPrefetchRef = useRef<AbortController | null>(null);
  useEffect(() => () => historyPrefetchRef.current?.abort(), []);
  const busyOperations = useRef(0);
  // Do not flash unvalidated, potentially cross-workspace browser indexes.
  // Bootstrap repairs ownership before publishing the saved cards.
  const [workspaceRuns, setWorkspaceRuns] = useState<Record<string, string[]>>({});
  const [isSidebarReady, setIsSidebarReady] = useState(false);
  const [isBootstrapReady, setIsBootstrapReady] = useState(false);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState("");
  const acceptedSettingsRef = useRef<Config | null>(null);
  const [runLabels, setRunLabels] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem("grapher_run_labels");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const [runModes, setRunModes] = useState<Record<string, PlanMode>>(() => {
    try {
      const saved = localStorage.getItem("grapher_run_modes");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const pendingRunLabelIdsRef = useRef(new Set<string>());
  const deletedRunIdsRef = useRef(new Set<string>());

  const [recentlyAddedEdgeIds, setRecentlyAddedEdgeIds] = useState<Set<string>>(new Set());
  // Newly created topology nodes keep a short-lived entrance class, mirroring
  // the edge entrance animation while the Planner streams its tools.
  const [recentlyAddedNodeNames, setRecentlyAddedNodeNames] = useState<Set<string>>(new Set());
  const pendingToolArgsRef = useRef<Map<string, any>>(new Map());

  const currentRepoPath = useMemo(() => workspaceKey(config.repository), [config.repository]);
  const runs = useMemo(() => workspaceRuns[currentRepoPath] || [], [workspaceRuns, currentRepoPath]);

  useEffect(() => {
    const missing = runs.filter(id => !id.startsWith("pending-") && !(id in runLabels) && !pendingRunLabelIdsRef.current.has(id));
    if (missing.length > 0) {
      missing.forEach(id => pendingRunLabelIdsRef.current.add(id));
      mapWithConcurrency(missing, 8, id =>
        runtimeService.history(id)
          .then(snapshot => [id, snapshot.graph.originalGoal || ""] as const)
          .catch(() => [id, ""] as const)
      ).then(results => {
        setRunLabels(prev => {
          const updated = { ...prev };
          for (const [id, goal] of results) {
            if (updated[id] === undefined && !deletedRunIdsRef.current.has(id)) {
              updated[id] = goal;
            }
          }
          try { localStorage.setItem("grapher_run_labels", JSON.stringify(updated)); } catch { }
          return updated;
        });
      }).finally(() => {
        missing.forEach(id => pendingRunLabelIdsRef.current.delete(id));
      });
    }
  }, [runs, runLabels, runtimeService]);
  const { runIndicators, markSnapshotRead, clearRunUnread, observeRunSnapshot } = useRunIndicators(state);
  const allRunIds = useMemo(() => [...new Set(Object.values(workspaceRuns).flat())], [workspaceRuns]);
  const [activities, setActivities] = useState<Record<string, RuntimeActivity[]>>({});
  const observeActivity = useCallback((runId: string, activity: RuntimeActivity[]) => {
    if (!runId) return;
    setActivities(previous => {
      const current = previous[runId];
      if (current && current.length === activity.length && current.every((item, index) =>
        item.kind === activity[index].kind && item.nodes.join("\u0000") === activity[index].nodes.join("\u0000"))) {
        return previous;
      }
      return { ...previous, [runId]: activity };
    });
  }, []);
  const hasActiveExecutions = state.executions.some(item => item.status === "running") ||
    (state.mergers ?? []).some(item => item.status === "running") ||
    Object.values(state.nodes).some(item => item.status === "running" || item.status === "dirty") ||
    state.resultExecution?.status === "running";

  const [dataPath, setDataPath] = useState("");
  const [recoveredPlanning, setRecoveredPlanning] = useState<PlanningSummary | null>(null);
  const [dismissedRecoveryId, setDismissedRecoveryId] = useState<string | null>(null);
  const autoDismissTimerRef = useRef<number | null>(null);

  const handleConversationReady = useCallback(() => {
    if (!recoveredPlanning) return;
    const planningId = recoveredPlanning.planningId;
    if (dismissedRecoveryId === planningId) return;

    if (autoDismissTimerRef.current !== null) {
      window.clearTimeout(autoDismissTimerRef.current);
    }
    autoDismissTimerRef.current = window.setTimeout(() => {
      setDismissedRecoveryId(planningId);
      autoDismissTimerRef.current = null;
    }, 1500);
  }, [recoveredPlanning, dismissedRecoveryId]);

  useEffect(() => {
    if (!recoveredPlanning && autoDismissTimerRef.current !== null) {
      window.clearTimeout(autoDismissTimerRef.current);
      autoDismissTimerRef.current = null;
    }
  }, [recoveredPlanning]);

  useEffect(() => {
    return () => {
      if (autoDismissTimerRef.current !== null) {
        window.clearTimeout(autoDismissTimerRef.current);
      }
    };
  }, []);

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

  const recordRunToWorkspace = (runId: string, repo: string) => {
    if (deletedRunIdsRef.current.has(runId)) return;
    setWorkspaceRuns((prev) => {
      const updated = bindRunToWorkspace(prev, runId, repo);
      if (updated === prev) return prev;
      try {
        localStorage.setItem("grapher_workspace_runs", JSON.stringify(updated));
      } catch { }
      return updated;
    });
  };

  const replaceProvisionalRunId = (oldId: string, newId: string, label: string, repository: string) => {
    setWorkspaceRuns((prev) => {
      const updated = bindRunToWorkspace(prev, newId, repository, oldId);
      try {
        localStorage.setItem("grapher_workspace_runs", JSON.stringify(updated));
      } catch { }
      return updated;
    });

    setRunLabels((prev) => {
      const copy = { ...prev };
      delete copy[oldId];
      copy[newId] = label;
      try {
        localStorage.setItem("grapher_run_labels", JSON.stringify(copy));
      } catch { }
      return copy;
    });

    setRunModes((prev) => {
      const mode = prev[oldId];
      if (!mode) return prev;
      const copy = { ...prev };
      delete copy[oldId];
      copy[newId] = mode;
      try {
        localStorage.setItem("grapher_run_modes", JSON.stringify(copy));
      } catch { }
      return copy;
    });

    const drafts = composerDraftsRef.current.get(oldId);
    if (drafts) {
      composerDraftsRef.current.set(newId, drafts);
      composerDraftsRef.current.delete(oldId);
    }
    // The accepted backend identity still belongs to the mounted Conversation.
    if (workbenchIdentityRef.current.runId === oldId) {
      workbenchIdentityRef.current = { ...workbenchIdentityRef.current, runId: newId };
    }
    setState((prev) => (prev.runId === oldId ? { ...prev, runId: newId } : prev));
    setPlannerStream((prev) => (prev.runId === oldId ? { ...prev, runId: newId } : prev));
    const cached = messagesByRunRef.current.get(oldId);
    if (cached) {
      messagesByRunRef.current.set(newId, cached.map(msg => ({ ...msg, runId: newId })));
      messagesByRunRef.current.delete(oldId);
    }
    setSessionEntries((prev) => {
      // Detached SSE events cannot retag the newly opened conversation's turns.
      if (!prev.some(msg => msg.runId === oldId)) return prev;
      const updated = prev.map(msg => msg.runId === oldId ? { ...msg, runId: newId } : msg);
      messagesByRunRef.current.set(newId, updated);
      return updated;
    });
  };

  const removeProvisionalRunId = (provisionalId: string, failureSummary?: PlanningSummary) => {
    setWorkspaceRuns((prev) => {
      const updated: Record<string, string[]> = {};
      for (const [repo, list] of Object.entries(prev)) {
        updated[repo] = list.filter((id) => id !== provisionalId);
      }
      try {
        localStorage.setItem("grapher_workspace_runs", JSON.stringify(updated));
      } catch { }
      return updated;
    });

    setRunLabels((prev) => {
      const copy = { ...prev };
      delete copy[provisionalId];
      try {
        localStorage.setItem("grapher_run_labels", JSON.stringify(copy));
      } catch { }
      return copy;
    });

    setRunModes((prev) => {
      if (!prev[provisionalId]) return prev;
      const copy = { ...prev };
      delete copy[provisionalId];
      try {
        localStorage.setItem("grapher_run_modes", JSON.stringify(copy));
      } catch { }
      return copy;
    });

    // A failed foreground attempt keeps its conversation mounted so the error
    // stays visible; only a detached (user-navigated-away) attempt resets home.
    setState((prev) => (prev.runId === provisionalId
      ? (failureSummary
        ? {
          ...prev,
          runId: "",
          planningId: "",
          planType: failureSummary.planType === "graph" || failureSummary.planType === "serial" ? failureSummary.planType : prev.planType,
          planning: failureSummary,
          phase: "planning_failed",
        }
        : { ...emptySnapshot })
      : prev));
    setPlannerStream(prev => prev.runId === provisionalId ? initialPlannerStream : prev);
    setSessionEntries(prev => prev.filter(msg => msg.runId !== provisionalId));
    messagesByRunRef.current.delete(provisionalId);
  };

  useEffect(() => {
    if (state.runId && state.config?.repository) {
      recordRunToWorkspace(state.runId, state.config.repository);
    }
  }, [state.runId, state.config?.repository]);

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
    resetPresentedCardIds();
    setSessionEntries([]);
    setEditingMessage(null);
    setEditPrefillText("");
  }, []);

  const publishing = state.phase === "publishing" || state.phase === "merging";
  const publicationFailed = state.phase === "publication_failed";
  const active = publishing || publicationFailed ||
    Object.values(state.nodes).some((node) => node.status === "running" || node.status === "dirty") ||
    state.executions.some((item) => item.status === "running") ||
    (state.mergers ?? []).some((item) => item.status === "running") ||
    state.resultExecution?.status === "running";
  const locked = busy || !!recoveredPlanning || repositoryBlocked;
  const backendPlanning = state.phase === "planning";
  const isAgentWorking = active || isPlanning || backendPlanning;

  const effectiveMessages = useMemo<ChatMessage[]>(() => {
    if (sessionEntries.length > 0) return sessionEntries;
    const initialGoal = state.graph.originalGoal || goal || state.planning?.goal || recoveredPlanning?.goal || (state.runId ? runLabels[state.runId] : "");
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
  }, [sessionEntries, state.graph.originalGoal, goal, state.planning?.goal, recoveredPlanning?.goal, state.runId, runLabels]);

  const [routeType, setRouteType] = useState<PlanRouteType>(() => deduceRouteType(emptySnapshot));

  // 开始编辑消息
  const handleStartEditMessage = useCallback((msg: ChatMessage) => {
    setEditingMessage(msg);
    // 剥离可能存在的 [@node] 格式前缀与附件块以便用户编辑纯指令
    const parsed = parseMessageAttachmentsAndText(msg.text, msg.files, msg.images);
    const cleanText = parsed.cleanText.replace(/^\[@[^\]]+\]\s*/, "");
    setEditPrefillText(cleanText);
  }, []);

  const handleCancelEditMessage = useCallback(() => {
    setEditingMessage(null);
    setEditPrefillText("");
  }, []);

  const initialPlannerStream = {
    runId: "",
    initialPlanMode: undefined as PlanMode | undefined,
    stage: "idle" as "idle" | "partitioning" | "planning" | "done" | "error",
    items: [] as TranscriptItem[],
    plannerMessageStart: 0,
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

  const [plannerStream, setPlannerStream, queuePlannerStream] = useFrameBatchedState(initialPlannerStream);
  // Legacy/orphaned Planner histories may be visible before a Run is recovered.
  // They still need an owner so leaving the Conversation releases their RAM.
  const visiblePlanningId = recoveredPlanning?.planningId || failedPlanning?.planningId || state.planningId || state.planning?.planningId;
  const transcriptRunId = state.runId || plannerStream.runId || recoveredPlanning?.runId || failedPlanning?.runId || state.planning?.runId ||
    (visiblePlanningId ? `planning@${visiblePlanningId}` : "");
  useConversationTranscriptCache(transcriptRunId);
  const setBackendStatus = useSnapshotPolling(setState, observeRunSnapshot, observeActivity, allRunIds, state.runId, state.phase, hasActiveExecutions,
    // While a live Planner SSE stream owns this Run's draft topology, durable
    // snapshot polls must not clobber the incrementally assembled graph.
    isPlanning && plannerStream.runId && !plannerStream.runId.startsWith("pending-") ? plannerStream.runId : "");

  const applyForegroundSnapshot = (snapshot: Snapshot, generation: number) => {
    if (snapshot.runId && snapshot.config?.repository) {
      recordRunToWorkspace(snapshot.runId, snapshot.config.repository);
      observeRunSnapshot(snapshot);
      setBackendStatus(snapshot);
    }
    if (generation !== foregroundGeneration.current || !snapshotBelongsToWorkspace(snapshot, config.repository)) return false;
    setState(snapshot);
    return true;
  };

  const run = async (work: () => Promise<boolean | void>): Promise<boolean> => {
    const generation = foregroundGeneration.current;
    busyOperations.current += 1;
    setBusy(true);
    setError("");
    try {
      const result = await work();
      return generation === foregroundGeneration.current && result !== false;
    } catch (err) {
      if (generation === foregroundGeneration.current) {
        setError(err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err));
      }
      return false;
    } finally {
      if (generation === foregroundGeneration.current) {
        busyOperations.current -= 1;
        setBusy(busyOperations.current > 0);
      }
    }
  };

  const control = (action: string, extra: Record<string, unknown> = {}) => run(async () => {
    const generation = foregroundGeneration.current;
    if (["approve", "resume", "intervene", "resolve", "retry_publication"].includes(action)) {
      await requireRepository(state.config?.repository || config.repository);
    }
    if (generation !== foregroundGeneration.current) return;
    const isGlobalGraphAction = ["pause", "resume", "approve", "reject", "retry_publication"].includes(action);
    const defaultNode = !isGlobalGraphAction
      ? (selected || (routeType === "serial" && state.graph.nodes.length > 0 ? (state.graph.nodes[0]?.name || "task") : undefined))
      : undefined;
    const targetNode = extra.node !== undefined ? extra.node : defaultNode;
    const payload: Record<string, unknown> = { runId: state.runId, ...extra };
    if (targetNode !== undefined) {
      payload.node = targetNode;
    }
    const snapshot = await runtimeService.control(action, payload);
    if (!applyForegroundSnapshot(snapshot, generation)) return false;
    setModal(null);
  });

  const handleSendMessage = (
    val: string,
    options?: { mode?: "followUp" | "steer"; displayText?: string; rawText?: string; files?: Array<File | FileAttachment>; images?: ImageAttachment[] }
  ): boolean | Promise<boolean> => {
    const text = val.trim();
    if (!text) return false;
    if (repositoryBlocked) {
      setError(repositoryStatus?.error || t("正在确认项目绑定，请稍后重试。"));
      return false;
    }
    const selectedNode = state.graph.nodes.find(item => item.name === selected);
    const isNodeMerger = selected.startsWith("merger:") && selected !== publicationMergerCardId;
    const nodeMergerTarget = isNodeMerger ? selected.slice(7) : "";
    const mergerNodeName = isNodeMerger ? `merge:${nodeMergerTarget}` : (selected === publicationMergerCardId ? "merger" : undefined);
    const targetNodeName = mergerNodeName || selectedNode?.name ||
      (routeType === "serial" ? state.graph.nodes[0]?.name : undefined);
    // A selected merger card owns the composer only while its native process is
    // alive; a settled merger is read-only history.
    const selectedMerger = (isNodeMerger || selected === publicationMergerCardId)
      ? ((state.mergers ?? []).find(item => item.id === selectedMergerId && item.node === mergerNodeName)
          ?? (state.mergers ?? []).filter(item => item.node === mergerNodeName).at(-1))
      : undefined;
    // A publication Merger stays addressable through its lifecycle; other node
    // messages remain blocked while publication is in progress.
    if ((publishing || publicationFailed) && selectedMerger?.node !== "merger" && selectedMerger?.status !== "running") {
      setError(t("发布期间不能介入节点，请等待发布结束或处理发布失败。"));
      return false;
    }
    const generation = foregroundGeneration.current;
    const isCurrent = () => generation === foregroundGeneration.current;
    const displayMsg = options?.displayText !== undefined ? options.displayText : text;
    const fileAttachments: FileAttachment[] | undefined = options?.files && options.files.length > 0
      ? options.files.map(f => ({ name: f.name, size: f.size, type: f.type }))
      : undefined;
    const recordMessage = (textToRecord: string, delivery?: ChatMessage["delivery"], executionId?: string) => {
      const message: ChatMessage = {
        id: `msg-${crypto.randomUUID()}`, parentId: (sessionEntries.at(-1) || effectiveMessages.at(-1))?.id ?? null,
        role: "user", text: textToRecord, images: options?.images, files: fileAttachments, timestamp: Date.now(),
        runId: state.runId || plannerStream.runId, node: targetNodeName, delivery, executionId,
      };
      setSessionEntries(prev => [...(prev.length ? prev : effectiveMessages), message]);
      setEditingMessage(null);
      setEditPrefillText("");
      return message;
    };
    const removeMessage = (message: ChatMessage) => {
      if (message.runId) {
        const cached = messagesByRunRef.current.get(message.runId);
        if (cached) messagesByRunRef.current.set(message.runId, cached.filter(entry => entry.id !== message.id));
      }
      setSessionEntries(prev => prev.filter(entry => entry.id !== message.id));
      setPlannerStream(prev => ({ ...prev, items: prev.items.filter(item => item.id !== message.id) }));
    };
    const submitNodeMessage = (action: "steer" | "intervene" | "continue_merger", message: ChatMessage, executionId?: string, nodeOverride?: string, onAccepted?: (snapshot: Snapshot) => void) => run(async () => {
      try {
        await requireRepository(state.config?.repository || config.repository);
        if (!isCurrent()) { removeMessage(message); return false; }
        let snapshot = await runtimeService.control(action, {
          runId: state.runId, node: nodeOverride ?? targetNodeName, executionId, instruction: text, images: options?.images,
        });
        // Once accepted, resuming the originating Run is independent of navigation.
        if (snapshot.paused) snapshot = await runtimeService.control("resume", { runId: snapshot.runId });
        const applied = applyForegroundSnapshot(snapshot, generation);
        if (applied) onAccepted?.(snapshot);
        return applied;
      } catch (error) {
        removeMessage(message);
        throw error;
      }
    });

    if (selectedMerger) {
      const running = selectedMerger.status === "running";
      // A settled publication merger still accepts follow-ups; a settled
      // node-composition merger is read-only history unless it failed.
      if (!running && selectedMerger.node !== "merger" && selectedMerger.status !== "failed") {
        setError(t("merger 已结束，只能查看执行记录"));
        return false;
      }
      // Retain the attachment envelope to match the durable event exactly.
      // EditableUserBubble parses it into text and attachment cards.
      const message = recordMessage(`[@${targetNodeName}] ${text}`, running ? "steered" : undefined, selectedMerger.id);
      // Follow the continuation execution the runtime just created, so the pane
      // and composer address the live Pi session instead of the settled one.
      return submitNodeMessage(running ? "steer" : "continue_merger", message, selectedMerger.id, selectedMerger.node,
        running ? undefined : (snapshot) => {
          const next = (snapshot.mergers ?? []).filter(item => item.node === selectedMerger.node).at(-1);
          if (next && next.id !== selectedMerger.id) setSelectedMergerId(next.id);
        });
    }
    if (targetNodeName && state.nodes[targetNodeName]?.status === "done") {
      return submitNodeMessage("intervene", recordMessage(selectedNode ? `[@${targetNodeName}] ${text}` : text));
    }
    const execution = targetNodeName && [...state.executions].reverse()
      .find(item => item.node === targetNodeName && item.status === "running");
    if ((isPlanning || backendPlanning || recoveredPlanning?.status === "running" || active) && execution) {
      const message = recordMessage(`${targetNodeName !== "task" ? `[@${targetNodeName}] ` : ""}${text}`, "steered", execution.id);
      return submitNodeMessage("steer", message, execution.id);
    }
    if (isPlanning || backendPlanning || recoveredPlanning?.status === "running") {
      const planningRunId = plannerStream.runId || state.runId;
      if (plannerStream.stage === "partitioning" || !planningRunId || planningRunId.startsWith("pending-")) {
        setError(t("任务路由器仍在工作，请等待 Planner 启动后再追加消息。"));
        return false;
      }
      const message = recordMessage(displayMsg);
      setPlannerStream(prev => ({
        ...prev, items: [...closeRunningThinkingItem(prev.items), {
          id: message.id, type: "text", role: "user", content: displayMsg, timestamp: message.timestamp,
        }],
      }));
      return run(async () => {
        try {
          await runtimeService.control("steer_planner", { runId: planningRunId, instruction: text, images: options?.images });
          return isCurrent();
        } catch (error) {
          removeMessage(message);
          if (!isCurrent()) return false;
          const failure = error instanceof Error ? error.message : String(error);
          if (/no longer accepting messages|No active Planner/i.test(failure)) {
            void handlePlanGoal(text, options, "graph", planningRunId, false, undefined, true);
            return true;
          }
          throw error;
        }
      });
    }
    if (targetNodeName) {
      return submitNodeMessage("intervene", recordMessage(selectedNode ? `[@${targetNodeName}] ${text}` : text));
    }
    // A Run with a persisted Planner identity is still the same conversation,
    // even while its graph is empty or the route decision is undecided.
    if ((routeType === "graph" || state.graph.nodes.length > 0 || !!state.planningId) && state.runId && state.phase !== "planning_failed") {
      void handlePlanGoal(text, options, "graph", state.runId);
    } else {
      const baseGoal = state.graph.originalGoal || goal;
      void handlePlanGoal(baseGoal ? t("{0}\n\n补充规划要求：\n{1}", baseGoal, text) : text, options);
    }
    return true;
  };

  const load = useCallback(async () => {
    const scope = planningRecovery.begin();
    const acceptedAtStart = acceptedSettingsRef.current;
    const data = await runtimeService.bootstrap().catch(error => {
      if (planningRecovery.current(scope)) throw error;
      return null;
    });
    if (!data || !planningRecovery.current(scope)) return;
    if (data.envOverrides) setEnvOverrides(data.envOverrides);

    let storedProjects: ProjectItem[] | null = null;
    try {
      const saved = localStorage.getItem("grapher_projects");
      if (saved !== null) {
        storedProjects = (JSON.parse(saved) as ProjectItem[]).map(project => ({
          ...project, path: normalizeWorkspacePath(project.path), id: normalizeWorkspacePath(project.id || project.path),
        }));
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

      if (data.repositoryInfo && workspaceKey(data.repositoryInfo.path) === workspaceKey(latestProj.path)) {
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
          if (detected && planningRecovery.current(scope)) {
            setRepoInfo({ ...detected, path: normalizeWorkspacePath(detected.path) });
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
    } else if (storedProjects === null && data.repositoryInfo) {
      const info = { ...data.repositoryInfo, path: normalizeWorkspacePath(data.repositoryInfo.path) };
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
      ...((acceptedSettingsRef.current !== acceptedAtStart ? acceptedSettingsRef.current : null) ?? data.config),
      repository: activeRepo || (activeInfo ? activeInfo.path : ""),
      maxFeedback: 3,
    };
    setConfig(nextConfigObj);
    setIsBootstrapReady(true);
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
    const indexedIds = [...new Set([...(data.runs || []), ...Object.values(storedWorkspaceRuns || {}).flat()])]
      .filter(id => !id.startsWith("pending-"));
    // Publish validated cards preserving canonical order, without letting one stalled
    // history keep all cards loading or causing items to jump and re-order.
    let historyFailed = false;
    const validatedSnapshots = new Map<string, Snapshot>();
    let publishScheduled = false;

    const buildValidatedRuns = (): Record<string, string[]> => {
      const result: Record<string, string[]> = {};
      for (const snap of validatedSnapshots.values()) {
        if (!snap.config?.repository) continue;
        const owner = workspaceKey(snap.config.repository);
        if (!result[owner]) result[owner] = [];
      }
      for (const owner of Object.keys(result)) {
        result[owner] = indexedIds.filter(id => {
          const snap = validatedSnapshots.get(id);
          return snap && snapshotBelongsToWorkspace(snap, owner);
        });
      }
      return result;
    };

    const schedulePublish = () => {
      if (publishScheduled) return;
      publishScheduled = true;
      queueMicrotask(() => {
        publishScheduled = false;
        if (!planningRecovery.current(scope)) return;
        const nextRuns = buildValidatedRuns();
        const activeRuns = nextRuns[workspaceKey(activeRepo)] || [];
        setWorkspaceRuns(nextRuns);
        if (activeRuns.length > 0) {
          setIsSidebarReady(true);
        }
      });
    };

    const snapshots = await mapWithConcurrency(indexedIds, 8, async id => {
      if (!planningRecovery.current(scope)) return null;
      const snapshot = data.snapshot.runId === id ? data.snapshot : await runtimeService.history(id).catch(() => {
        historyFailed = true;
        return null;
      });
      if (!planningRecovery.current(scope) || !snapshot || snapshot.runId !== id) return null;
      setBackendStatus(snapshot);
      setRunLabels(prev => {
        const label = snapshot.graph.originalGoal || "";
        const next = label || prev[id] === undefined ? { ...prev, [id]: label } : prev;
        try { localStorage.setItem("grapher_run_labels", JSON.stringify(next)); } catch { }
        return next;
      });
      if (snapshot.config?.repository) {
        validatedSnapshots.set(id, snapshot);
        schedulePublish();
      }
      return snapshot;
    });
    if (!planningRecovery.current(scope)) return;
    const indexedRuns = reconcileWorkspaceRuns(storedWorkspaceRuns || {}, snapshots);
    if (historyFailed) setBootstrapError(t("部分会话历史加载失败，请重试。"));
    setWorkspaceRuns(indexedRuns);
    try { localStorage.setItem("grapher_workspace_runs", JSON.stringify(indexedRuns)); } catch { }
    setIsSidebarReady(true);

    const currentRuns = indexedRuns[workspaceKey(activeRepo)] || [];
    const isActivelyRunning = Boolean(
      data.snapshot.runId &&
      data.snapshot.phase === "running" &&
      activeRepo &&
      snapshotBelongsToWorkspace(data.snapshot, activeRepo) &&
      currentRuns.includes(data.snapshot.runId)
    );
    const isActivelyPlanning = Boolean(
      data.snapshot.runId &&
      data.snapshot.phase === "planning" &&
      activeRepo &&
      snapshotBelongsToWorkspace(data.snapshot, activeRepo)
    );

    if (isActivelyRunning || isActivelyPlanning) {
      const deduced = deduceRouteType(data.snapshot);
      setState(data.snapshot);
      markSnapshotRead(data.snapshot);
      setBackendStatus(data.snapshot);
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
    setModal(null);
    setConfirmModal(null);
    setRecentlyAddedEdgeIds(new Set());
    pendingToolArgsRef.current.clear();
    return scope;
  };

  const handleOpenProject = () => {
    if (isOpeningProject) return;
    setIsOpeningProject(true);
    return run(async () => {
      try {
        const pending = planningRecovery.capture(config.repository);
        const info = await runtimeService.pickRepository();
        if (!planningRecovery.current(pending)) return;
        if (info) {
          const normalizedPath = normalizeWorkspacePath(info.path);
          const scope = detachForeground(normalizedPath);
          setRepoInfo({ ...info, path: normalizedPath });
          setConfig((prev) => ({ ...prev, repository: normalizedPath }));
          const item: ProjectItem = {
            id: normalizedPath,
            name: info.name,
            path: normalizedPath,
            branch: info.branch,
            clean: info.clean,
            isShadow: info.isShadow,
            lastOpened: Date.now(),
          };
          setProjects((prev) => {
            const next = [item, ...prev.filter((p) => workspaceKey(p.path) !== workspaceKey(normalizedPath))];
            try {
              localStorage.setItem("grapher_projects", JSON.stringify(next));
            } catch { }
            return next;
          });
          const nextSnapshot = emptySnapshot;
          resetSessionMessages();
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
      } finally {
        setIsOpeningProject(false);
      }
    });
  };

  const handleSelectProject = (proj: ProjectItem) => {
    if (workspaceKey(config.repository) === workspaceKey(proj.path)) return;
    const scope = detachForeground(proj.path);
    // Clear the old view synchronously, before repository detection can yield.
    setConfig(prev => ({ ...prev, repository: normalizeWorkspacePath(proj.path) }));
    setRepoInfo(null);
    setState(emptySnapshot);
    setRouteType("undecided");
    setPlannerStream(initialPlannerStream);
    setGoal("");
    setSelected("");
    resetSessionMessages();
    return run(async () => {
      const info = await runtimeService.detectRepository(proj.path);
      if (!planningRecovery.current(scope)) return;
      if (info) {
        setRepoInfo({ ...info, path: normalizeWorkspacePath(info.path) });
        setConfig((prev) => ({ ...prev, repository: normalizeWorkspacePath(info.path) }));
        setProjects((prev) => {
          const next = prev.map((p) =>
            workspaceKey(p.path) === workspaceKey(info.path)
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
      const projRuns = workspaceRuns[workspaceKey(proj.path)] || [];
      let loadedSnapshot: Snapshot = emptySnapshot;
      if (projRuns.length > 0) {
        try {
          const snapshot = await runtimeService.snapshotForRun(projRuns[0]);
          if (!planningRecovery.current(scope)) return;
          if (snapshot.config?.repository) recordRunToWorkspace(snapshot.runId, snapshot.config.repository);
          if (!snapshotBelongsToWorkspace(snapshot, proj.path)) throw new Error("Workspace ownership mismatch");
          const deduced = deduceRouteType(snapshot);
          setState(snapshot);
          setRouteType(deduced);
          setGoal(snapshot.graph.originalGoal || "");
          setSessionEntries(messagesByRunRef.current.get(snapshot.runId) ?? []);
          setEditingMessage(null);
          setEditPrefillText("");
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
      detail: t("路径: {0}\n将删除此工作区的所有会话、日志和专属缓存，不会删除源项目代码文件。", project.path),
      confirmText: t("移除工作区"),
      danger: true,
      onConfirm: () => run(async () => {
        const pathToRemove = project.path;
        const key = workspaceKey(pathToRemove);
        const generation = foregroundGeneration.current;
        const indexedIds = workspaceRuns[key] || [];
        if (indexedIds.some(id => id.startsWith("pending-"))) {
          throw new Error(t("工作区仍有正在进行的任务，请先停止并等待结束。"));
        }
        // Do not remove browser indexes until the backend commits the entire
        // workspace deletion, including conversations absent from this browser.
        const deletedIds = new Set([...indexedIds, ...await runtimeService.deleteWorkspace(pathToRemove)]);
        deletedIds.forEach(id => {
          deletedRunIdsRef.current.add(id);
          messagesByRunRef.current.delete(id);
          composerDraftsRef.current.delete(id);
        });
        clearLandingDraft(pathToRemove);
        const remainingProjects = projects.filter((p) => workspaceKey(p.path) !== key);
        setProjects(prev => {
          const remaining = prev.filter(p => workspaceKey(p.path) !== key);
          try { localStorage.setItem("grapher_projects", JSON.stringify(remaining)); } catch { }
          return remaining;
        });
        setWorkspaceRuns((prev) => {
          const copy: Record<string, string[]> = {};
          for (const [repo, ids] of Object.entries(prev)) {
            if (repo !== key) copy[repo] = ids.filter(id => !deletedIds.has(id));
          }
          try { localStorage.setItem("grapher_workspace_runs", JSON.stringify(copy)); } catch { }
          return copy;
        });
        const forgetLabels = (prev: Record<string, string>) => Object.fromEntries(Object.entries(prev).filter(([id]) => !deletedIds.has(id)));
        setRunLabels(prev => {
          const next = forgetLabels(prev);
          try { localStorage.setItem("grapher_run_labels", JSON.stringify(next)); } catch { }
          return next;
        });
        setRunModes(prev => {
          const next = Object.fromEntries(Object.entries(prev).filter(([id]) => !deletedIds.has(id)));
          try { localStorage.setItem("grapher_run_modes", JSON.stringify(next)); } catch { }
          return next;
        });

        if (generation === foregroundGeneration.current && workspaceKey(config.repository) === key) {
          detachForeground("");
          setPlannerStream(initialPlannerStream);
          setConfig((prev) => {
            const next = { ...prev, repository: "" };
            try { localStorage.setItem("grapher_config", JSON.stringify(next)); } catch { }
            return next;
          });
          setRepoInfo(null);
          setState(emptySnapshot);
          setGoal("");
          setLandingGoal(loadLandingDraft(""));
          setSelected("");
          resetSessionMessages();
          setRouteType("undecided");
          setError("");
        }
      }),
    });
  };

  const handleDeleteRun = (runIdToDelete: string) => run(async () => {
    const generation = foregroundGeneration.current;
    if (!runIdToDelete.startsWith("pending-")) {
      await runtimeService.deleteRun(runIdToDelete);
    }
    deletedRunIdsRef.current.add(runIdToDelete);
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
    setRunModes((prev) => {
      if (!prev[runIdToDelete]) return prev;
      const copy = { ...prev };
      delete copy[runIdToDelete];
      try {
        localStorage.setItem("grapher_run_modes", JSON.stringify(copy));
      } catch { }
      return copy;
    });
    messagesByRunRef.current.delete(runIdToDelete);
    composerDraftsRef.current.delete(runIdToDelete);
    if (state.runId === runIdToDelete && generation === foregroundGeneration.current) {
      const scope = detachForeground(config.repository);
      const deleteGeneration = foregroundGeneration.current;
      resetSessionMessages();
      setPlannerStream(initialPlannerStream);
      setState(emptySnapshot);
      setRouteType("undecided");
      setGoal("");
      setSelected("");
      const remainingRuns = (workspaceRuns[currentRepoPath] || []).filter((id) => id !== runIdToDelete);
      if (remainingRuns.length > 0) {
        try {
          const snapshot = await runtimeService.snapshotForRun(remainingRuns[0]);
          if (deleteGeneration !== foregroundGeneration.current || !planningRecovery.current(scope)) return;
          if (!snapshotBelongsToWorkspace(snapshot, config.repository)) throw new Error("Workspace ownership mismatch");
          setState(snapshot);
          setRouteType(deduceRouteType(snapshot));
          setGoal(snapshot.graph.originalGoal || "");
          setSessionEntries(messagesByRunRef.current.get(snapshot.runId) ?? []);
          setSelected("");
          void planningRecovery.restore(scope, snapshot);
        } catch {
          if (deleteGeneration !== foregroundGeneration.current || !planningRecovery.current(scope)) return;
          setRouteType("undecided");
          setState(emptySnapshot);
          setGoal("");
          setSelected("");
        }
      } else {
        setState(emptySnapshot);
        setGoal("");
        setLandingGoal(loadLandingDraft(config.repository));
        setSelected("");
        resetSessionMessages();
        setRouteType("undecided");
      }
    }
  });

  const handleDeleteRunConfirm = (runId: string) => {
    if (runId.startsWith("pending-")) {
      setError(t("对话正在创建，请稍后再删除。"));
      return;
    }
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
    setLandingGoal(loadLandingDraft(config.repository));
    setSelected("");
    setError("");
  };

  const handleCloseSettings = useCallback(() => setModal(null), []);

  const handleSaveConfig = useCallback(async (draftConfig: Config): Promise<boolean> => {
    const generation = foregroundGeneration.current;
    // Settings change models/defaults, not the selected workspace. Rediscovery
    // or Git status here can stall saving behind an unrelated large tree scan.
    const repoPath = normalizeWorkspacePath(config.repository.trim());
    const info = repoInfo && workspaceKey(repoInfo.path) === workspaceKey(repoPath) ? repoInfo : null;
    if (generation !== foregroundGeneration.current) return false;
    const nextConfig = { ...draftConfig, repository: repoPath, maxFeedback: 3 };
    try {
      const boot = await runtimeService.saveConfig(nextConfig, state.runId || undefined);
      if (generation !== foregroundGeneration.current) return false;
      if (boot.snapshot?.runId === state.runId && state.runId) {
        if (snapshotBelongsToWorkspace(boot.snapshot, config.repository)) {
          setState(boot.snapshot);
          observeRunSnapshot(boot.snapshot);
        }
      }
      if (boot.envOverrides) setEnvOverrides(boot.envOverrides);
    } catch (error) {
      throw new Error(t("保存设置失败：{0}", String(error)));
    }
    // Commit the browser draft only after acceptance. A timeout does not prove
    // the server write was rolled back; its error asks the user to verify first.
    acceptedSettingsRef.current = nextConfig;
    setConfig(nextConfig);
    setIsBootstrapReady(true);
    if (info) setRepoInfo({ ...info, path: repoPath });
    try {
      localStorage.setItem("grapher_config", JSON.stringify(nextConfig));
    } catch { }
    if (info) {
      setProjects((prev) => {
        const item: ProjectItem = { ...info, id: info.path, lastOpened: Date.now() };
        const next = [item, ...prev.filter((project) => workspaceKey(project.path) !== workspaceKey(info.path))];
        try { localStorage.setItem("grapher_projects", JSON.stringify(next)); } catch { }
        return next;
      });
    }
    setModal(null);
    setError("");
    return true;
  }, [config.repository, repoInfo, state.runId, observeRunSnapshot, setState]);

  const save = (graph: Graph) => run(async () => {
    const generation = foregroundGeneration.current;
    // An unapproved/rejected graph is still the same conversation. Pass its
    // identity so the backend edits that draft rather than creating a Run.
    const draftRunId = state.runId && !state.approved &&
      (state.phase === "rejected" || state.phase === "awaiting_approval") && routeType === "graph"
      ? state.runId : undefined;
    const snapshot = await runtimeService.saveGraph(graph, config, draftRunId);
    if (!applyForegroundSnapshot(snapshot, generation)) return false;
    const deduced = deduceRouteType(snapshot);
    setRouteType(deduced);
    setGoal(graph.originalGoal);
    setModal(null);
    if (draftRunId && snapshot.runId === draftRunId) {
      setRunLabels((prev) => {
        const updated = { ...prev, [draftRunId]: graph.originalGoal || "" };
        try { localStorage.setItem("grapher_run_labels", JSON.stringify(updated)); } catch { }
        return updated;
      });
    }
    setSelected("");
  });

  const closeRunningThinkingItem = closeThinkingItems;

  const handlePlanGoal = (
    inputGoal?: string,
    options?: { displayText?: string; rawText?: string; files?: Array<File | FileAttachment>; images?: ImageAttachment[] },
    mode?: PlanMode,
    revisionRunId?: string,
    forceFresh?: boolean,
    editedMessage?: ChatMessage,
    // A Planner turn can settle between a send and its steer request. The
    // caller already verified that turn is over, so continue instead of
    // rejecting the message as a second concurrent conversation.
    allowWhilePlanning?: boolean
  ) => {
    const targetGoal = (inputGoal !== undefined ? inputGoal : (landingGoal || goal)).trim();
    if (!targetGoal) return Promise.resolve(false);
    if (!isBootstrapReady) {
      setError(t("正在加载后端设置，请稍后重试；若加载失败，请在侧边栏重试。"));
      return Promise.resolve(false);
    }

    if (isPlanning && !allowWhilePlanning) {
      setError(t("另一个对话仍在规划中；请等待规划完成后再提交新对话，旧会话不会被中断。"));
      return Promise.resolve(false);
    }

    if (!revisionRunId || forceFresh) {
      resetPresentedCardIds();
    }

    const isContinuing = !forceFresh && Boolean(revisionRunId || (routeType === "graph" && state.graph.nodes.length > 0 && state.runId));
    const effectiveRevisionRunId = !forceFresh ? (revisionRunId || (isContinuing ? state.runId : undefined)) : undefined;
    const liveRevision = isContinuing && state.approved;
    const effectiveMode = mode || (isContinuing ? "graph" : planMode);
    const targetRepo = config.repository;
    if (!targetRepo) {
      setModal("settings");
      setError(t("请先在左侧工作区选择绑定的本地 Git 仓库。"));
      return Promise.resolve(false);
    }
    const scope = planningRecovery.begin(targetRepo);
    let startedRunId: string | undefined;

    let provisionalRunId: string | undefined;

    if (!isContinuing) {
      provisionalRunId = `pending-${Date.now()}`;
      setGoal("");
      setLandingGoal("");
      clearLandingDraft(targetRepo);
      setIsPlanning(true);
      setRouteType(effectiveMode === "auto" ? "undecided" : effectiveMode);
      setSelected("");

      recordRunToWorkspace(provisionalRunId, targetRepo);
      setRunLabels((prev) => ({ ...prev, [provisionalRunId!]: targetGoal }));
      setRunModes((prev) => {
        const next = { ...prev, [provisionalRunId!]: effectiveMode };
        try {
          localStorage.setItem("grapher_run_modes", JSON.stringify(next));
        } catch { }
        return next;
      });

      const fileAttachments: FileAttachment[] | undefined = options?.files && options.files.length > 0
        ? options.files.map(f => ({ name: f.name, size: f.size, type: f.type }))
        : undefined;

      const newMsg: ChatMessage = {
        ...editedMessage,
        id: editedMessage?.id || `msg-${Date.now()}`,
        parentId: null,
        role: "user",
        text: options?.displayText !== undefined ? options.displayText : targetGoal,
        images: options?.images,
        files: fileAttachments || editedMessage?.files,
        timestamp: Date.now(),
        runId: provisionalRunId,
      };

      setSessionEntries((prev) => {
        if (prev.length > 0 && prev[0].versions) {
          return [{
            ...prev[0],
            text: newMsg.text,
            images: newMsg.images,
            files: newMsg.files,
            timestamp: newMsg.timestamp,
            runId: newMsg.runId,
          }];
        }
        return [newMsg];
      });

      setPlannerStream({
        runId: provisionalRunId,
        initialPlanMode: effectiveMode,
        stage: effectiveMode === "auto" ? "partitioning" : effectiveMode === "graph" ? "planning" : "idle",
        items: [],
        plannerMessageStart: 0,
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
        runId: provisionalRunId!,
        config: { ...config, repository: targetRepo },
        approved: false,
        paused: false,
        phase: "draft",
        graph: {
          ...prev.graph,
          nodes: [],
          edges: [],
          originalGoal: targetGoal,
        },
        nodes: {},
        plan: null,
      }));
    } else {
      setIsPlanning(true);
      // A Planner turn does not change the draft/runtime phase. The workbench
      // displays planning separately, including while old snapshots are polled.
      const fileAttachments: FileAttachment[] | undefined = options?.files && options.files.length > 0
        ? options.files.map(f => ({ name: f.name, size: f.size, type: f.type }))
        : undefined;
      const parentId = sessionEntries.length > 0 ? sessionEntries[sessionEntries.length - 1].id : null;
      const newMsg: ChatMessage = {
        ...editedMessage,
        id: editedMessage?.id || `msg-${Date.now()}`,
        parentId,
        role: "user",
        text: options?.displayText !== undefined ? options.displayText : targetGoal,
        images: options?.images,
        files: fileAttachments || editedMessage?.files,
        timestamp: Date.now(),
        runId: effectiveRevisionRunId,
      };
      if (editedMessage) {
        // The replacement is already in the truncated local branch.
      } else {
        setSessionEntries((prev) => [...(prev.length ? prev : effectiveMessages), newMsg]);
      }
      setPlannerStream((prev) => ({
        ...prev,
        stage: "planning",
        isContinuation: true,
        plannerMessageStart: 1,
        items: [
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

    setEditingMessage(null);
    setEditPrefillText("");
    setError("");

    return run(async () => {
      let abortController: AbortController | null = null;
      let routeConfirmed = false;
      let failureSummary: PlanningSummary | undefined;
      try {
        await requireRepository(targetRepo);
        if (!planningRecovery.current(scope)) return;
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
        if (!planningRecovery.current(scope)) return;
        let partInTag = false;
        let planInTag = false;

        abortController = new AbortController();
        planningAbortControllerRef.current = abortController;

        const snapshot = await runtimeService.planGoalStream(
          targetGoal,
          config,
          (event) => {
            if (event.type === "run_started" && event.runId) startedRunId = event.runId;
            if (event.type === "complete" && event.snapshot?.runId) startedRunId = event.snapshot.runId;
            if (!planningRecovery.current(scope)) {
              // Detached planning still creates a real Run. Keep it in the sidebar
              // without replacing the newly opened conversation.
              if (event.type === "run_started" && event.runId) {
                if (provisionalRunId) {
                  replaceProvisionalRunId(provisionalRunId, event.runId, targetGoal, targetRepo);
                } else {
                  recordRunToWorkspace(event.runId, targetRepo);
                  setRunLabels((prev) => {
                    if (prev[event.runId!]) return prev;
                    const updated = { ...prev, [event.runId!]: targetGoal };
                    try { localStorage.setItem("grapher_run_labels", JSON.stringify(updated)); } catch {}
                    return updated;
                  });
                  setRunModes((prev) => {
                    if (prev[event.runId!]) return prev;
                    const updated = { ...prev, [event.runId!]: effectiveMode };
                    try { localStorage.setItem("grapher_run_modes", JSON.stringify(updated)); } catch {}
                    return updated;
                  });
                }
              }
              if (event.type === "complete" && event.snapshot?.runId) {
                if (provisionalRunId) {
                  replaceProvisionalRunId(provisionalRunId, event.snapshot.runId, targetGoal, event.snapshot.config?.repository || targetRepo);
                } else {
                  recordRunToWorkspace(event.snapshot.runId, event.snapshot.config?.repository || targetRepo);
                  setRunModes((prev) => {
                    if (prev[event.snapshot!.runId]) return prev;
                    const updated = { ...prev, [event.snapshot!.runId]: effectiveMode };
                    try { localStorage.setItem("grapher_run_modes", JSON.stringify(updated)); } catch {}
                    return updated;
                  });
                }
              }
              return;
            }
            if (event.type === "run_started") {
              if (event.runId) {
                const runId = event.runId;
                if (provisionalRunId) {
                  replaceProvisionalRunId(provisionalRunId, runId, targetGoal, targetRepo);
                } else {
                  setPlannerStream((prev) => ({ ...prev, runId }));
                  recordRunToWorkspace(runId, targetRepo);
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
                  setRunModes((prev) => {
                    if (prev[runId]) return prev;
                    const updated = { ...prev, [runId]: effectiveMode };
                    try {
                      localStorage.setItem("grapher_run_modes", JSON.stringify(updated));
                    } catch {}
                    return updated;
                  });
                }
              }
            } else if (event.type === "partitioner") {
            const pEvent = event.event;
            if (pEvent?.type === "message_update") {
              const aEvent = pEvent.assistantMessageEvent;
              if (aEvent?.type === "thinking_start") {
                queuePlannerStream((prev) => ({ ...prev, partitionerThinkingActive: true }));
              } else if (aEvent?.type === "thinking_delta") {
                const delta = aEvent.delta || "";
                queuePlannerStream((prev) => ({
                  ...prev,
                  partitionerThinking: prev.partitionerThinking + delta,
                  partitionerThinkingActive: true,
                }));
              } else if (aEvent?.type === "thinking_end") {
                queuePlannerStream((prev) => ({ ...prev, partitionerThinkingActive: false }));
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
                  const thinkingActive = partInTag;
                  queuePlannerStream((prev) => ({
                    ...prev,
                    partitionerThinking: prev.partitionerThinking + thinkChunk,
                    partitionerThinkingActive: thinkingActive,
                    partitionerText: prev.partitionerText + textChunk,
                  }));
                } else {
                  queuePlannerStream((prev) => ({
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
            queuePlannerStream((prev) => (prev.stage !== "planning" ? { ...prev, stage: "planning" } : prev));
            const pEvent = event.event;
            if (pEvent?.type === "message_start" && pEvent.message?.role === "assistant") {
              setPlannerStream(prev => ({
                ...prev, items: closeThinkingItems(prev.items), plannerMessageStart: prev.items.length,
              }));
            } else if (pEvent?.type === "message_update") {
              const aEvent = pEvent.assistantMessageEvent;
              if (["thinking_start", "thinking_delta", "thinking_end"].includes(aEvent?.type)) {
                queuePlannerStream(prev => {
                  const items = updateThinkingItems(prev.items, aEvent, prev.plannerMessageStart);
                  return {
                    ...prev, items,
                    plannerThinking: items.filter(item => item.type === "thinking" && item.content).map(item => item.content).join("\n\n"),
                    plannerThinkingActive: items.some(item => item.type === "thinking" && item.status === "running"),
                  };
                });
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
                  const thinkingActive = planInTag;
                  queuePlannerStream((prev) => {
                    let items = prev.items;
                    if (thinkChunk) {
                      items = appendItemDelta(items, "thinking", thinkChunk, thinkingActive);
                    }
                    if (!thinkingActive && items.some((i) => i.type === "thinking" && i.status === "running")) {
                      items = closeRunningThinkingItem(items);
                    }
                    if (textChunk) {
                      items = appendItemDelta(items, "text", textChunk, true);
                    }
                    return {
                      ...prev,
                      items,
                      plannerThinking: prev.plannerThinking + thinkChunk,
                      plannerThinkingActive: thinkingActive,
                      plannerText: prev.plannerText + textChunk,
                    };
                  });
                } else {
                  queuePlannerStream((prev) => ({
                    ...prev,
                    items: appendItemDelta(closeRunningThinkingItem(prev.items), "text", delta, true),
                    plannerThinkingActive: false,
                    plannerText: prev.plannerText + delta,
                  }));
                }
              }
            } else if (pEvent?.type === "message_end" && pEvent.message?.role === "assistant") {
              // A failed model call is the only visible explanation for a stopped
              // Planner turn; terminal SSE errors may never arrive (detached view).
              const failureStopReason = pEvent.message?.stopReason;
              const failureMessage = pEvent.message?.errorMessage;
              setPlannerStream(prev => {
                let items = finalizeThinkingItems(prev.items,
                  Array.isArray(pEvent.message.content) ? pEvent.message.content : [], prev.plannerMessageStart);
                if ((failureStopReason === "error" || failureStopReason === "aborted") && failureMessage) {
                  const alreadyHas = items.some(i => (i.isError || i.status === "error") && i.content === failureMessage);
                  if (!alreadyHas) {
                    items = [
                      ...closeRunningThinkingItem(items),
                      {
                        id: `planner_error_${Date.now()}`,
                        type: "text",
                        role: "assistant",
                        content: failureMessage,
                        isError: true,
                        status: "error",
                        timestamp: Date.now(),
                      },
                    ];
                  }
                }
                return {
                  ...prev, items, plannerMessageStart: items.length,
                  plannerThinking: items.filter(item => item.type === "thinking" && item.content).map(item => item.content).join("\n\n"),
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
                  // 新建（非替换、非删除）的节点标记一个短入场动画窗口。
                  const addedNodeNames = (Array.isArray(args.nodes) ? args.nodes : (args.name ? [args] : []))
                    .filter((n: any) => n && n.name && !n.delete &&
                      !state.graph.nodes.some((item) => item.name === n.name))
                    .map((n: any) => n.name as string);
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
                      // The committed plan predates this draft. Lay out the
                      // preview from its current edges until Rust commits it.
                      plan: null,
                    };
                  });
                  if (addedNodeNames.length > 0) {
                    setRecentlyAddedNodeNames((prev) => new Set([...prev, ...addedNodeNames]));
                    setTimeout(() => {
                      setRecentlyAddedNodeNames((prev) => {
                        const next = new Set(prev);
                        for (const name of addedNodeNames) next.delete(name);
                        return next;
                      });
                    }, 1200);
                  }
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
                        plan: null,
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
                  durationMs: typeof pEvent.durationMs === "number" ? pEvent.durationMs : t.durationMs,
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
            const errorMsg = event.error;
            if (errorMsg) {
              setPlannerStream((prev) => {
                const closed = closeRunningThinkingItem(prev.items);
                const alreadyHas = closed.some(
                  (i) => (i.isError || i.status === "error") && i.content === errorMsg
                );
                if (alreadyHas) return prev;
                return {
                  ...prev,
                  items: [
                    ...closed,
                    {
                      id: `planner_error_${Date.now()}`,
                      type: "text",
                      role: "assistant",
                      content: errorMsg,
                      isError: true,
                      status: "error",
                      timestamp: Date.now(),
                    },
                  ],
                };
              });
            }
            void planningRecovery.finish(scope, event.summary, event.planningId);
          } else if (event.type === "complete") {
            if (event.snapshot) {
              // Terminal events supersede in-flight draft polls immediately;
              // planning must not wait for the SSE transport to close.
              applyForegroundSnapshot(event.snapshot, foregroundGeneration.current);
              setIsPlanning(false);
              setRouteType(deduceRouteType(event.snapshot));
              recordRunToWorkspace(event.snapshot.runId, event.snapshot.config?.repository || targetRepo);
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
      applyForegroundSnapshot(snapshot, foregroundGeneration.current);
      setRouteType(deduceRouteType(snapshot));
      recordRunToWorkspace(snapshot.runId, snapshot.config?.repository || targetRepo);
      setRunModes((prev) => {
        if (prev[snapshot.runId]) return prev;
        const updated = { ...prev, [snapshot.runId]: effectiveMode };
        try { localStorage.setItem("grapher_run_modes", JSON.stringify(updated)); } catch {}
        return updated;
      });
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
      if (provisionalRunId && !startedRunId) {
        setGoal(targetGoal);
        setLandingGoal(targetGoal);
        saveLandingDraft(targetRepo, targetGoal);
      }
      const isAbort =
        err?.name === "AbortError" ||
        String(err?.message || err).includes("AbortError") ||
        String(err?.message || err).includes("The user aborted a request");
      if (isAbort) {
        if (!routeConfirmed && effectiveMode === "auto") setRouteType(deduceRouteType(state));
        return;
      }
      const errorMsg = String(err?.message || err);
      setError(errorMsg);
      if (!routeConfirmed && effectiveMode === "auto") setRouteType(deduceRouteType(state));
      // Keep the failed first-message conversation mounted: wiping the whole
      // snapshot here remounts the landing view over the workspace (page flash)
      // and hides the failure the user is looking at.
      if (provisionalRunId && !startedRunId) {
        failureSummary = err?.summary ?? {
          planningId: "",
          roles: {},
          totalPlanningDuration: 0,
          modelDuration: 0,
          status: "failed",
          error: errorMsg,
          createdAt: Date.now(),
          repository: targetRepo,
          planType: effectiveMode === "graph" ? "graph" : undefined,
          goal: targetGoal,
          runId: "",
        };
      }
      void planningRecovery.finish(scope, err?.summary, err?.planningId);
      setPlannerStream((prev) => {
        const closed = closeRunningThinkingItem(prev.items);
        const alreadyHas = closed.some(
          (i) => (i.isError || i.status === "error") && i.content === errorMsg
        );
        return {
          ...prev,
          items: alreadyHas
            ? closed
            : [
                ...closed,
                {
                  id: `planner_error_${Date.now()}`,
                  type: "text",
                  role: "assistant",
                  content: errorMsg,
                  isError: true,
                  status: "error",
                  timestamp: Date.now(),
                },
              ],
          stage: "error",
        };
      });
    } finally {
      if (abortController && planningAbortControllerRef.current === abortController) {
        planningAbortControllerRef.current = null;
      }
      if (provisionalRunId && !startedRunId) {
        removeProvisionalRunId(provisionalRunId, failureSummary);
        if (planningRecovery.current(scope)) setGoal(targetGoal);
      }
      if (planningRecovery.current(scope)) setIsPlanning(false);
    }
  });
};

  const handleEditMessageSubmit = useCallback(async (targetMsg: ChatMessage, newText: string, selectedVersion?: number) => {
    const generation = foregroundGeneration.current;
    const isCurrent = () => generation === foregroundGeneration.current;
    const requireEditRepository = async () => {
      await requireRepository(state.config?.repository || config.repository);
      return isCurrent();
    };
    const acceptNodeEdit = async (snapshot: Snapshot) => {
      if (!applyForegroundSnapshot(snapshot, generation)) return false;
      if (!snapshot.paused) return true;
      const resumed = await runtimeService.control("resume", { runId: snapshot.runId });
      return applyForegroundSnapshot(resumed, generation);
    };
    const reportEditError = (error: unknown) => {
      if (isCurrent()) setError(String(error));
      return false;
    };
    const cleanText = newText.trim();
    if (!cleanText) return false;
    if (repositoryBlocked) {
      setError(repositoryStatus?.error || t("正在确认项目绑定，请稍后重试。"));
      return;
    }
    const isNodeMerger = selected.startsWith("merger:") && selected !== publicationMergerCardId;
    const nodeMergerTarget = isNodeMerger ? selected.slice(7) : "";
    const currentMergerNode = isNodeMerger ? `merge:${nodeMergerTarget}` : (selected === publicationMergerCardId ? "merger" : undefined);
    const mergerExecutionById = targetMsg.executionId ? (state.mergers ?? []).find(m => m.id === targetMsg.executionId) : undefined;
    const isMergerMessage = Boolean(
      targetMsg.node === "merger" ||
      targetMsg.node?.startsWith("merge:") ||
      mergerExecutionById ||
      (currentMergerNode && (targetMsg.node === currentMergerNode || !targetMsg.node))
    );

    if (!isMergerMessage && (state.phase === "publishing" || state.phase === "merging" || state.phase === "publication_failed")) {
      setError(t("发布期间不能修改消息，请等待发布结束或处理发布失败。"));
      return false;
    }

    const parsedExisting = parseMessageAttachmentsAndText(targetMsg.text, targetMsg.files, targetMsg.images);
    const cleanExisting = parsedExisting.cleanText.replace(/^\[@[^\]]+\]\s*/, "").trim();
    if (selectedVersion === undefined && cleanText === cleanExisting) {
      setEditingMessage(null);
      setEditPrefillText("");
      return;
    }

    const fileTagsMatch = targetMsg.text.match(/(?:<file name="[^"]+">[\s\S]*?<\/file>\s*)+/);
    const fileTags = fileTagsMatch ? fileTagsMatch[0] : "";
    const backendGoal = fileTags ? `${fileTags}${cleanText}` : cleanText;

    const isPlannerHistoryInitial = routeType === "graph" && !targetMsg.node &&
      targetMsg.id.startsWith("planner-history-") &&
      targetMsg.text.replace(/^\[@[^\]]+\]\s*/, "").trim() === state.graph.originalGoal.trim();
    const isInitialGoal = targetMsg.id === "msg-initial-goal" || isPlannerHistoryInitial || (!targetMsg.node && (
      (sessionEntries.length > 0 && sessionEntries[0].id === targetMsg.id) ||
      effectiveMessages[0]?.id === targetMsg.id
    ));
    if ((isPlanning || backendPlanning || recoveredPlanning?.status === "running") && !targetMsg.node && routeType !== "serial") {
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

      if (isMergerMessage) {
        const mergerTargetNode = targetMsg.node && (targetMsg.node === "merger" || targetMsg.node.startsWith("merge:"))
          ? targetMsg.node
          : (mergerExecutionById?.node ?? currentMergerNode ?? "merger");
        const targetMerger = mergerExecutionById
          ?? (state.mergers ?? []).filter(m => m.node === mergerTargetNode).at(-1)
          ?? (state.mergers ?? []).find(m => m.id === selectedMergerId);

        if (!targetMerger) {
          setError(t("无法定位这条消息对应的 Pi 会话。请重新加载对话后重试。"));
          return false;
        }
        const running = targetMerger.status === "running";
        if (!running && targetMerger.node !== "merger" && targetMerger.status !== "failed") {
          setError(t("merger 已结束，只能查看执行记录"));
          return false;
        }
        const selectedMessage = {
          ...targetMsg,
          text: selectedText,
          images: selectedVersionData.images,
          currentVersionIndex: selectedVersion,
        };
        try {
          if (!await requireEditRepository()) return false;
          let snapshot = await runtimeService.control(running ? "steer" : "continue_merger", {
            runId: state.runId,
            node: targetMerger.node,
            executionId: targetMerger.id,
            instruction: selectedText,
            images: selectedVersionData.images,
          });
          if (snapshot.paused) snapshot = await runtimeService.control("resume", { runId: snapshot.runId });
          if (!applyForegroundSnapshot(snapshot, generation)) return false;
          const base = sessionEntries.length > 0 ? sessionEntries : effectiveMessages;
          const stripPrefix = (s: string) => s.replace(/^\[@[^\]]+\]\s*/, "").trim();
          const cleanTarget = stripPrefix(cleanExisting || targetMsg.text);
          const index = base.findIndex(entry =>
            (targetMsg.id && entry.id === targetMsg.id) ||
            stripPrefix(entry.text) === cleanTarget ||
            stripPrefix(entry.text) === stripPrefix(targetMsg.text)
          );
          const next = index >= 0 ? [...base] : [...base, selectedMessage];
          if (index >= 0) next[index] = selectedMessage;
          const subsequent = selectedVersionData.subsequentEntries ?? [];
          setSessionEntries(index >= 0 ? [...next.slice(0, index + 1), ...subsequent] : next);
          const nextMerger = (snapshot.mergers ?? []).filter(item => item.node === targetMerger.node).at(-1);
          if (nextMerger && nextMerger.id !== targetMerger.id) setSelectedMergerId(nextMerger.id);
          setEditingMessage(null);
          setEditPrefillText("");
          return true;
        } catch (error) {
          return reportEditError(error);
        }
      }

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
        if (!await requireEditRepository()) return false;
        if (!selectedNodeName) {
          if (routeType !== "graph" || !state.runId) throw new Error(t("当前没有可回退的 Planner 会话。"));
          const snap = await runtimeService.editPlanner({ runId: state.runId,
            oldText: selectedText, instruction: selectedText, versionIndex: selectedVersion });
          if (!applyForegroundSnapshot(snap, generation)) return false;
          if (isInitialGoal) {
            setSessionEntries([selectedMessage]);
            setGoal(selectedText);
          } else {
            setSessionEntries(prev => {
              const index = prev.findIndex(entry => entry.id === targetMsg.id);
              return index >= 0 ? prev.slice(0, index) : effectiveMessages.slice(0, 1);
            });
          }
          await handlePlanGoal(selectedText, { images: selectedVersionData.images }, "graph", state.runId, false, selectedMessage);
          return true;
        }
        if (!selectedExecution || selectedExecution.node !== selectedNodeName ||
            !["completed", "failed", "paused", "running"].includes(selectedExecution.status)) {
          throw new Error(t("无法定位这条消息对应的 Pi 会话。请重新加载对话后重试。"));
        }
        const snap = await runtimeService.editNode({
          runId: state.runId, node: selectedNodeName, executionId: selectedExecution.id,
          oldText: selectedText, instruction: selectedText, images: selectedVersionData.images,
          versionIndex: selectedVersion,
        });
        if (!await acceptNodeEdit(snap)) return false;
        if (isInitialGoal) setGoal(selectedText);
        setSessionEntries(prev => {
          const stripPrefix = (s: string) => s.replace(/^\[@[^\]]+\]\s*/, "").trim();
          const cleanTarget = stripPrefix(cleanExisting || targetMsg.text);
          const index = prev.findIndex(entry =>
            (targetMsg.id && entry.id === targetMsg.id) ||
            stripPrefix(entry.text) === cleanTarget ||
            stripPrefix(entry.text) === stripPrefix(targetMsg.text)
          );
          if (index < 0) return [selectedMessage];
          const next = [...prev];
          next[index] = selectedMessage;
          const subsequent = selectedVersionData.subsequentEntries ?? [];
          return [...next.slice(0, index + 1), ...subsequent];
        });
        setEditingMessage(null);
        setEditPrefillText("");
        return true;
      } catch (error) {
        return reportEditError(error);
      }
    }

    if (isInitialGoal && routeType === "graph" && state.runId && state.planningId) {
      try {
        if (!await requireEditRepository()) return false;
        const snap = await runtimeService.editPlanner({
          runId: state.runId, oldText: cleanExisting, instruction: backendGoal,
        });
        if (!applyForegroundSnapshot(snap, generation)) return false;
        const updated: ChatMessage = { ...targetMsg, text: cleanText, files: parsedExisting.attachments, runId: state.runId,
          versions: [...(targetMsg.versions ?? [{ id: "v1", text: targetMsg.text, files: targetMsg.files, timestamp: Date.now() }]),
            { id: `v${Date.now()}`, text: cleanText, files: parsedExisting.attachments, timestamp: Date.now() }],
          currentVersionIndex: (targetMsg.versions?.length ?? 1),
        };
        setSessionEntries([updated]);
        setGoal(cleanText);
        await handlePlanGoal(backendGoal, { displayText: cleanText, files: parsedExisting.attachments, images: targetMsg.images }, "graph", state.runId, false, updated);
        return true;
      } catch (error) { return reportEditError(error); }
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
        ...(current.versions ?? [{ id: "v1", text: current.text, files: current.files, images: current.images, timestamp: current.timestamp || Date.now() }]),
        { id: `v${Date.now()}`, text: cleanText, files: parsedExisting.attachments, images: targetMsg.images, timestamp: Date.now(), subsequentEntries: [] },
      ];
      const updatedPlannerMessage: ChatMessage = {
        ...current, id: current.id || targetMsg.id, parentId: previousEntry?.id ?? null,
        text: cleanText, files: parsedExisting.attachments, images: targetMsg.images, runId: state.runId,
        timestamp: Date.now(), versions, currentVersionIndex: versions.length - 1,
      };
      try {
        if (!await requireEditRepository()) return false;
        const snap = await runtimeService.editPlanner({
          runId: state.runId, oldText: cleanExisting, instruction: backendGoal,
        });
        if (!applyForegroundSnapshot(snap, generation)) return false;
        // Planner history is rendered from the durable Pi transcript. Keep only
        // the local prefix here; inserting a historical follow-up as the first
        // effective message would place it above the route decision card.
        setSessionEntries(previous);
        await handlePlanGoal(backendGoal, { displayText: cleanText, files: parsedExisting.attachments, images: targetMsg.images }, "graph", state.runId, false, updatedPlannerMessage);
        return true;
      } catch (error) { return reportEditError(error); }
    }

    if (isInitialGoal) {
      // Serial's initial prompt is a Pi user turn too: branch before it in the
      // existing Run instead of pretending a new unrelated Run is a tree edit.
      if (routeType === "serial" && state.approved && state.graph.nodes.length > 0) {
        const node = state.graph.nodes[0].name;
        const first = state.executions.find((execution) => execution.node === node &&
          !state.supersededExecutionIds?.includes(execution.id));
        if (!first || !["completed", "failed", "paused"].includes(first.status)) {
          setError(t("请等待当前执行结束后再修改初始消息。"));
          return;
        }
        return run(async () => {
          if (!await requireEditRepository()) return false;
          const snap = await runtimeService.editNode({
            runId: state.runId, node, executionId: first.id,
            oldText: state.graph.originalGoal, instruction: backendGoal, images: targetMsg.images,
          });
          if (!await acceptNodeEdit(snap)) return false;
          setGoal(cleanText);
          setSessionEntries([{ ...targetMsg, id: "msg-initial-goal", node: undefined, text: cleanText, files: parsedExisting.attachments,
            versions: [...(targetMsg.versions ?? [{ id: "v1", text: targetMsg.text, files: targetMsg.files, images: targetMsg.images, timestamp: Date.now() }]),
              { id: `v${Date.now()}`, text: cleanText, files: parsedExisting.attachments, images: targetMsg.images, timestamp: Date.now() }],
            currentVersionIndex: (targetMsg.versions?.length ?? 1),
          }]);
          setEditingMessage(null);
          setEditPrefillText("");
          return true;
        });
      }
      setEditingMessage(null);
      setEditPrefillText("");

      if (state.runId && (active || isPlanning || backendPlanning)) {
        try {
          await runtimeService.control("stop", { runId: state.runId });
        } catch (error) { return reportEditError(error); }
        if (!isCurrent()) return false;
      }

      const currentInitial = sessionEntries[0] || targetMsg;
      const initialVersion: ChatMessageVersion = {
        id: "v1",
        text: currentInitial.text,
        files: currentInitial.files,
        images: currentInitial.images,
        timestamp: currentInitial.timestamp || Date.now(),
        subsequentEntries: sessionEntries.slice(1),
      };
      const newVersion: ChatMessageVersion = {
        id: `v${Date.now()}`,
        text: cleanText,
        files: parsedExisting.attachments,
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
        files: parsedExisting.attachments,
        images: targetMsg.images,
        timestamp: Date.now(),
        versions,
        currentVersionIndex: versions.length - 1,
      };

      setSessionEntries([updatedInitialMsg]);
      setGoal(cleanText);

      await handlePlanGoal(
        backendGoal,
        { displayText: cleanText, files: parsedExisting.attachments, images: targetMsg.images },
        routeType === "undecided" ? "auto" : routeType,
        undefined,
        true
      );
      return;
    }

    if (isMergerMessage) {
      const mergerTargetNode = targetMsg.node && (targetMsg.node === "merger" || targetMsg.node.startsWith("merge:"))
        ? targetMsg.node
        : (mergerExecutionById?.node ?? currentMergerNode ?? "merger");
      const targetMerger = mergerExecutionById
        ?? (state.mergers ?? []).filter(m => m.node === mergerTargetNode).at(-1)
        ?? (state.mergers ?? []).find(m => m.id === selectedMergerId);

      if (!targetMerger) {
        setError(t("无法定位这条消息对应的 Pi 会话。请重新加载对话后重试。"));
        return false;
      }
      const running = targetMerger.status === "running";
      if (!running && targetMerger.node !== "merger" && targetMerger.status !== "failed") {
        setError(t("merger 已结束，只能查看执行记录"));
        setEditingMessage(null);
        setEditPrefillText("");
        return false;
      }

      const baseEntries = sessionEntries.length > 0 ? sessionEntries : effectiveMessages;
      const stripPrefix = (s: string) => s.replace(/^\[@[^\]]+\]\s*/, "").trim();
      const cleanTarget = stripPrefix(cleanExisting || targetMsg.text);
      const targetIndex = baseEntries.findIndex((e) =>
        (targetMsg.id && e.id === targetMsg.id) ||
        stripPrefix(e.text) === cleanTarget ||
        stripPrefix(e.text) === stripPrefix(targetMsg.text)
      );

      let rolledBackEntries: ChatMessage[];
      let updatedMsg: ChatMessage;

      if (targetIndex !== -1) {
        const current = baseEntries[targetIndex];
        const prevEntries = baseEntries.slice(0, targetIndex);
        const parentId = prevEntries.length > 0 ? prevEntries[prevEntries.length - 1].id : null;

        const initialVersion: ChatMessageVersion = {
          id: "v1",
          text: current.text,
          files: current.files,
          images: current.images,
          timestamp: current.timestamp || Date.now(),
          subsequentEntries: baseEntries.slice(targetIndex + 1),
        };
        const newVersion: ChatMessageVersion = {
          id: `v${Date.now()}`,
          text: cleanText,
          files: parsedExisting.attachments,
          images: targetMsg.images,
          timestamp: Date.now(),
          subsequentEntries: [],
        };
        const versions = [...(current.versions || [initialVersion]), newVersion];

        updatedMsg = {
          ...current,
          text: cleanText,
          files: parsedExisting.attachments,
          timestamp: Date.now(),
          parentId,
          versions,
          currentVersionIndex: versions.length - 1,
        };
        rolledBackEntries = [...prevEntries, updatedMsg];
      } else {
        const versions = [
          ...(targetMsg.versions ?? [{ id: "v1", text: targetMsg.text, files: targetMsg.files, images: targetMsg.images, timestamp: targetMsg.timestamp || Date.now() }]),
          { id: `v${Date.now()}`, text: cleanText, files: parsedExisting.attachments, images: targetMsg.images, timestamp: Date.now(), subsequentEntries: [] },
        ];
        updatedMsg = {
          ...targetMsg,
          text: cleanText,
          files: parsedExisting.attachments,
          timestamp: Date.now(),
          versions,
          currentVersionIndex: versions.length - 1,
        };
        rolledBackEntries = [...baseEntries, updatedMsg];
      }

      return run(async () => {
        try {
          if (!await requireEditRepository()) return false;
          let snapshot = await runtimeService.control(running ? "steer" : "continue_merger", {
            runId: state.runId,
            node: targetMerger.node,
            executionId: targetMerger.id,
            instruction: cleanText,
            images: targetMsg.images,
          });
          if (snapshot.paused) snapshot = await runtimeService.control("resume", { runId: snapshot.runId });
          if (!applyForegroundSnapshot(snapshot, generation)) return false;
          setSessionEntries(rolledBackEntries);
          const nextMerger = (snapshot.mergers ?? []).filter(item => item.node === targetMerger.node).at(-1);
          if (nextMerger && nextMerger.id !== targetMerger.id) setSelectedMergerId(nextMerger.id);
          setEditingMessage(null);
          setEditPrefillText("");
          return true;
        } catch (error) {
          return reportEditError(error);
        }
      });
    }

    const stripPrefix = (s: string) => s.replace(/^\[@[^\]]+\]\s*/, "").trim();
    const cleanTarget = stripPrefix(cleanExisting || targetMsg.text);
    const targetIndex = sessionEntries.findIndex((e) =>
      (targetMsg.id && e.id === targetMsg.id) ||
      stripPrefix(e.text) === cleanTarget ||
      stripPrefix(e.text) === stripPrefix(targetMsg.text)
    );

    let rolledBackEntries: ChatMessage[];
    let updatedMsg: ChatMessage;

    if (targetIndex !== -1) {
      const current = sessionEntries[targetIndex];
      const prevEntries = sessionEntries.slice(0, targetIndex);
      const parentId = prevEntries.length > 0 ? prevEntries[prevEntries.length - 1].id : null;

      const initialVersion: ChatMessageVersion = {
        id: "v1",
        text: current.text,
        files: current.files,
        images: current.images,
        timestamp: current.timestamp || Date.now(),
        subsequentEntries: sessionEntries.slice(targetIndex + 1),
      };
      const newVersion: ChatMessageVersion = {
        id: `v${Date.now()}`,
        text: cleanText,
        files: parsedExisting.attachments,
        images: targetMsg.images,
        timestamp: Date.now(),
        subsequentEntries: [],
      };
      const versions = [...(current.versions || [initialVersion]), newVersion];

      updatedMsg = {
        ...current,
        delivery: state.nodes[targetMsg.node || selected]?.status === "done" ? undefined : current.delivery,
        text: cleanText,
        files: parsedExisting.attachments,
        timestamp: Date.now(),
        parentId,
        versions,
        currentVersionIndex: versions.length - 1,
      };
      rolledBackEntries = [...prevEntries, updatedMsg];
    } else {
      const versions = [
        ...(targetMsg.versions ?? [{ id: "v1", text: targetMsg.text, files: targetMsg.files, images: targetMsg.images, timestamp: targetMsg.timestamp || Date.now() }]),
        { id: `v${Date.now()}`, text: cleanText, files: parsedExisting.attachments, images: targetMsg.images, timestamp: Date.now(), subsequentEntries: [] },
      ];
      updatedMsg = {
        ...targetMsg,
        delivery: state.nodes[targetMsg.node || selected]?.status === "done" ? undefined : targetMsg.delivery,
        text: cleanText,
        files: parsedExisting.attachments,
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
        if (!await requireEditRepository()) return false;
        const snap = await runtimeService.editPlanner({ runId: state.runId,
          oldText: cleanExisting, instruction: backendGoal });
        if (!applyForegroundSnapshot(snap, generation)) return false;
        setSessionEntries(rolledBackEntries);
        await handlePlanGoal(backendGoal, { displayText: cleanText, files: parsedExisting.attachments, images: targetMsg.images }, "graph", state.runId, false, updatedMsg);
        return true;
      } catch (error) { return reportEditError(error); }
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
          !["completed", "failed", "paused", "running"].includes(execution.status) ||
          state.supersededExecutionIds?.includes(execution.id)) {
        setError(t("无法定位这条消息对应的 Pi 会话。请重新加载对话后重试。"));
        return;
      }
      return run(async () => {
        if (!await requireEditRepository()) return false;
        const snap = await runtimeService.editNode({
          runId: state.runId, node: targetNodeName, executionId: execution.id,
          oldText: cleanExisting, instruction: backendGoal, images: targetMsg.images,
        });
        if (!await acceptNodeEdit(snap)) return false;
        setSessionEntries(rolledBackEntries);
        setEditingMessage(null);
        setEditPrefillText("");
        return true;
      });
    }
  }, [
    repositoryBlocked,
    repositoryStatus,
    state,
    sessionEntries,
    effectiveMessages,
    routeType,
    selected,
    selectedMergerId,
    isPlanning,
    active,
    config,
    plannerStream.runId,
    recoveredPlanning?.status,
    handlePlanGoal,
    requireRepository,
    applyForegroundSnapshot,
    run,
  ]);

  const handleSwitchMessageVersion = useCallback((message: ChatMessage, index: number) => {
    const version = message.versions?.[index];
    if (!version || index === message.currentVersionIndex) return;
    const execution = version.executionId
      ? (state.executions.find(item => item.id === version.executionId)
         ?? (state.mergers ?? []).find(item => item.id === version.executionId))
      : undefined;
    void handleEditMessageSubmit({ ...message, images: version.images,
      executionId: execution?.id ?? message.executionId }, version.text, index);
  }, [handleEditMessageSubmit, state.executions, state.mergers]);

  const initialize = useCallback(async () => {
    setBootstrapLoading(true);
    setBootstrapError("");
    setError("");
    try {
      await load();
    } catch (err) {
      setBootstrapError(String(err));
      setError(String(err));
    } finally {
      setIsSidebarReady(true);
      setBootstrapLoading(false);
    }
  }, [load]);
  useEffect(() => { void initialize(); }, [initialize]);

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
            if (summary.goal) {
              setGoal(prev => prev || summary.goal!);
            }
            if (summary.planType && summary.planType !== "undecided") {
              setRouteType(summary.planType);
            }
            if (summary.runId || summary.goal || summary.planType) {
              setState(prev => {
                const nextRunId = summary.runId || prev.runId;
                const nextGoal = summary.goal || prev.graph.originalGoal;
                const nextPlanType = (summary.planType && summary.planType !== "undecided") ? summary.planType : prev.planType;
                if (
                  prev.runId === nextRunId &&
                  prev.graph.originalGoal === nextGoal &&
                  prev.planType === nextPlanType &&
                  prev.planningId === summary.planningId
                ) {
                  return prev;
                }
                return {
                  ...prev,
                  runId: nextRunId,
                  planningId: summary.planningId,
                  planType: nextPlanType,
                  graph: {
                    ...prev.graph,
                    originalGoal: nextGoal,
                  },
                };
              });
            }
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

  const handleInterrupt = useCallback(async (targetNode?: string) => {
    const generation = foregroundGeneration.current;
    if (!targetNode && planningAbortControllerRef.current) {
      planningAbortControllerRef.current.abort();
      planningAbortControllerRef.current = null;
    }
    try {
      const runId = state.runId || plannerStream.runId;
      const payload: Record<string, unknown> = runId ? { runId } : {};
      if (targetNode) {
        payload.node = targetNode;
      }
      await runtimeService.control("stop", payload);
    } catch (e) {
      if (generation === foregroundGeneration.current) console.warn("Stop command failed:", e);
    }
    if (generation !== foregroundGeneration.current) return;
    if (!targetNode && isPlanning) {
      setIsPlanning(false);
      setPlannerStream((prev) => ({
        ...prev,
        items: closeRunningThinkingItem(prev.items),
        stage: "error",
      }));
    }
  }, [isPlanning, state.runId, plannerStream.runId]);

  const { nodes, edges } = useGraphElements(
    state,
    selected,
    recentlyAddedEdgeIds,
    selectedMergerId,
    activities[state.runId] ?? [],
    recentlyAddedNodeNames,
  );

  // Change the view identity only when the target snapshot is accepted, not
  // when navigation begins. Otherwise the old Conversation remounts and flashes
  // while its replacement's metadata is still in flight.
  if (workbenchIdentityRef.current.runId !== state.runId) {
    workbenchIdentityRef.current = { runId: state.runId, key: state.runId || "initial" };
  }

  const draftConversationKey = state.runId || JSON.stringify([workspaceKey(config.repository), "unbound"]);
  let composerDrafts = composerDraftsRef.current.get(draftConversationKey);
  if (!composerDrafts) {
    composerDrafts = new Map<string, string>();
    composerDraftsRef.current.set(draftConversationKey, composerDrafts);
  }

  const isLandingView = !state.runId && state.graph.nodes.length === 0 &&
    !isPlanning &&
    !recoveredPlanning &&
    !failedPlanning &&
    state.phase !== "planning_failed";

  const actions = {
    selectProject: useStableCallback(handleSelectProject), openProject: useStableCallback(handleOpenProject),
    removeProject: useStableCallback(handleRemoveWorkspaceConfirm), deleteRun: useStableCallback(handleDeleteRunConfirm),
    newConversation: useStableCallback(handleNewConversation), send: useStableCallback(handleSendMessage),
    edit: useStableCallback(handleEditMessageSubmit), switchVersion: useStableCallback(handleSwitchMessageVersion),
    control: useStableCallback(control), save: useStableCallback(save),
    openSettings: useStableCallback(() => setModal("settings")), openEditor: useStableCallback(() => setModal("editor")),
    openApproval: useStableCallback(() => setModal("approval")), retryPublication: useStableCallback(() => control("retry_publication")),
    plan: useStableCallback(async (val: string, options?: Parameters<typeof handlePlanGoal>[1]) => (await handlePlanGoal(val, options)) !== false),
  };
  const publicationMergers = useMemo(() => (state.mergers ?? []).filter(merger => merger.node === "merger"), [state.mergers]);
  const handleLoadRun = useStableCallback((id: string) => {
    if (!runs.includes(id) || id.startsWith("pending-")) return;
    if (id !== state.runId || isPlanning || recoveredPlanning) detachForeground(config.repository);
    historyPrefetchRef.current?.abort();
    const controller = new AbortController();
    historyPrefetchRef.current = controller;
    const generation = foregroundGeneration.current;
    void (async () => {
      clearRunUnread(id);
      // Logs must never block opening a card; validate ownership before displaying it.
      let snapshot: Snapshot;
      try { snapshot = await runtimeService.snapshotForRun(id, controller.signal); }
      catch (error) {
        if (controller.signal.aborted) return;
        if (generation === foregroundGeneration.current) {
          setError(error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error));
        }
        return;
      }
      if (controller.signal.aborted || generation !== foregroundGeneration.current) return;
      if (snapshot.config?.repository) recordRunToWorkspace(snapshot.runId, snapshot.config.repository);
      if (!snapshotBelongsToWorkspace(snapshot, config.repository)) {
        setError(t("此对话不属于当前工作区，请在对应工作区中打开。"));
        return;
      }
      setState(snapshot);
      markSnapshotRead(snapshot);
      setRouteType(deduceRouteType(snapshot));
      setGoal(snapshot.graph.originalGoal || (id ? runLabels[id] : "") || "");
      if (id !== state.runId) {
        setPlannerStream(initialPlannerStream);
        setSessionEntries(messagesByRunRef.current.get(id) ?? []);
        setEditingMessage(null);
        setEditPrefillText("");
      }
      setSelected("");
    })();
  });

  return (
    <div className={`app-background-root ${isLandingView ? "landing-active" : ""}`}>
      <FloatingPathsBackground
        className="aspect-16/9 flex items-center justify-center"
        position={-1}
        active={isLandingView && !modal && !confirmModal}
      >
        <div className={`app-shell ${isLandingView ? "landing-active" : ""}`}>
          <Sidebar
            projects={projects}
            activeRepo={config.repository}
            onSelectProject={actions.selectProject}
            onOpenProject={actions.openProject}
            isOpeningProject={isOpeningProject}
            onRemoveProject={actions.removeProject}
            runs={runs}
            runLabels={runLabels}
            isReady={isSidebarReady}
            loadError={bootstrapError}
            retrying={bootstrapLoading}
            onRetryLoad={() => void initialize()}
            currentRunId={state.runId}
            runIndicators={runIndicators}
            onLoadRun={handleLoadRun}
            onDeleteRun={actions.deleteRun}
            onNewConversation={actions.newConversation}
            onOpenSettings={actions.openSettings}
            isSettingsOpen={modal === "settings"}
          />

          <main className="main">
            {/* 全局悬浮横幅 (居中于工作区主体，排除侧边栏) */}
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
                {recoveredPlanning && dismissedRecoveryId !== recoveredPlanning.planningId && (
                  <motion.section
                    key={`floating-recovered-banner-${recoveredPlanning.planningId}`}
                    className="floating-recovered-banner"
                    aria-label={t("恢复进行中的规划")}
                    initial={{ opacity: 0, y: -20, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -16, scale: 0.96 }}
                    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <div className="floating-recovered-icon">
                      <Loader2 size={13} className="floating-recovered-spinner" />
                    </div>
                    <div className="floating-recovered-content">
                      <p role="status" className="floating-recovered-text">
                        {t("已连接正在进行的规划，活动会自动更新")}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="floating-recovered-close"
                      aria-label={t("关闭提示")}
                      onClick={() => setDismissedRecoveryId(recoveredPlanning.planningId)}
                    >
                      <X size={13} />
                    </button>
                  </motion.section>
                )}
              </AnimatePresence>
            </div>

            {/* Shared inputs must stay opaque; only local content/decorations fade. */}
            <LayoutGroup id="main-conversation">
            <div className="main-view-stage">
            <AnimatePresence initial={false}>
              {isLandingView ? (
                <LandingView
                  key="landing-view"
                  goal={landingGoal}
                  setGoal={handleLandingGoalChange}
                  onPlanGoal={actions.plan}
                  isBusy={busy || isPlanning || backendPlanning || repositoryBlocked}
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
                  initial={false}
                  animate={{ opacity: 1 }}
                  // Presence can retain the source while its composer moves.
                  // Hide it immediately, without fading the incoming input.
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0 }}
                >
                  <PublicationPanel
                    key={state.runId.startsWith("pending-") ? "provisional" : state.runId}
                    runId={state.runId}
                    publication={state.publication}
                    mergers={publicationMergers}
                    busy={busy || repositoryBlocked}
                    onRetry={actions.retryPublication}
                  />

                  <GraphWorkbench
                    key={workbenchIdentityRef.current.key}
                    state={state}
                    transcriptRunId={transcriptRunId}
                    composerDrafts={composerDrafts}
                    activity={activities[state.runId] ?? []}
                    routeType={routeType}
                    initialPlanMode={runModes[state.runId] || (plannerStream.runId === state.runId ? plannerStream.initialPlanMode : undefined)}
                    selected={selected}
                    setSelected={setSelected}
                    selectedMergerId={selectedMergerId}
                    setSelectedMergerId={setSelectedMergerId}
                    failedPlanning={failedPlanning || (state.planning?.status === "failed" ? state.planning : null)}
                    effectiveMessages={effectiveMessages}
                    onEditMessage={handleStartEditMessage}
                    editingMessage={editingMessage}
                    editPrefillText={editPrefillText}
                    onEditPrefillTextChange={setEditPrefillText}
                    onCancelEditMessage={handleCancelEditMessage}
                    onEditMessageSubmit={actions.edit}
                    onSwitchMessageVersion={actions.switchVersion}
                    onInterrupt={handleInterrupt}
                    isPlanning={isPlanning || backendPlanning || !!recoveredPlanning}
                    plannerStream={plannerStream}
                    recoveredPlanningId={recoveredPlanning?.planningId || (!isPlanning && backendPlanning ? (state.planningId || state.planning?.planningId) : undefined)}
                    onConversationReady={handleConversationReady}
                    onSendMessage={actions.send}
                    onRequestConfirmation={setConfirmModal}
                    onControl={actions.control}
                    onSave={actions.save}
                    onOpenEditor={actions.openEditor}
                    onOpenApproval={actions.openApproval}
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
            </div>
            </LayoutGroup>
          </main>

          {/* Modals with Opening and Closing Animations */}
          <AnimatePresence>
            {modal === "settings" && (
              <SettingsModal
                key="settings-modal"
                isOpen={true}
                onClose={handleCloseSettings}
                config={config}
                dataPath={dataPath}
                envOverrides={envOverrides}
                error={error}
                onSaveConfig={handleSaveConfig}
              />
            )}

            {modal === "editor" && (
              <EditorModal
                key={`editor-modal-${state.runId || currentRepoPath}`}
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
