import { t, localizeError } from "../../i18n";
import React, { useRef, useState, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { GraphCanvas } from "../graph/GraphCanvas";
import { useGraphViewport } from "../../hooks/useGraphViewport";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  Code2, ArrowLeft,
  Workflow, Play, Pause, Compass, ArrowDown, Clock, Loader2, ChevronRight,
  AlertCircle, ChevronLeft, Plus
} from "lucide-react";
import { motion, AnimatePresence, useAnimationControls, useIsPresent, useReducedMotion } from "motion/react";
import {
  Snapshot, PlanRouteType, PlanMode, RepositoryInfo, Config,
  Graph, GraphNode, ManualNodeRequest, Execution, Status, PlanningSummary, TranscriptItem,
  ChatMessage, ImageAttachment, RuntimeActivity, OpenWorkspaceFileRequest, publicationMergerCardId, GraphEvent
} from "../../types";
import { PromptBox, type PromptBoxSubmitOptions } from "../ui/chatgpt-prompt-input";
import type { ConfirmModalState } from "../modals/ConfirmModal";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { EditableUserBubble, StreamingAssistantBubble } from "./ChatBubbles";
import { NodeTaskCard } from "./NodeTaskCard";
import { CreateNodeForm } from "./CreateNodeForm";
import { getMergerSystemPrompt } from "../../services/mergerPrompt";
import { runtimeService } from "../../services/runtime";
import { shouldShowRouteBadge } from "../../services/executionRoute";
import { activeNodeConversationEvents, nodeConversationExecutions, executionIdForMessage, versionIndexForEdit, versionsForEdit, type ConversationExecution } from "../../services/conversationBranch";
import { captureViewScrollState, resolveViewScroll, calculateExpandedCardScrollDelta, CONVERSATION_BOTTOM_THRESHOLD, type ViewScrollState } from "../../services/conversationScroll";
import { isNodeWorking, nodeDependenciesCompleted } from "../../lib/nodeWorking";
import { resolveGraphPhase } from "../../lib/graphPhase";
import { inlineSteerKey, isUncommittedSteer, liveSteerConsumed, nodeInstructionText, numberSteers, steerFallbackPosition, steerRollbackKey, type InlineUserTurnWindow, type LiveSteerMarker } from "../../lib/pendingSteers";
import { ThinkingCard } from "../ThinkingCard";
import { ExecutionTiming } from "../ExecutionTiming";
import { ExecutionTimeTookText, PlannerTimeTookText, formatSessionStartTime } from "../ExecutionTimeTook";
import { SessionTokenUsage } from "../SessionTokenUsage";
import { formatTokenCount, formatCacheHitRate, consumedTokenCount, attemptSessionContext, sessionContext, sessionTokenUsage } from "../../utils/tokenUsage";
import { ExecutionTranscript, ExecutionTranscriptPlaceholder } from "../ExecutionTranscript";
import { settleInterruptedItems } from "../../services/transcriptSettle";
import { activePlannerOutput } from "../PlanningActivity";
import { plannerConversationEdits, plannerHistoryIds, reviewPlanningIds } from "../../lib/plannerOutput";
import { cachedPlanningOutput } from "../../services/transcriptCache";
import { HISTORY_PREPEND_EVENT, TRANSCRIPT_CONTENT_GROWTH_EVENT, TRANSCRIPT_FINAL_OUTPUT_EVENT, TRANSCRIPT_SCROLL_ADJUSTED_EVENT, isNestedScrollGesture, notifyTranscriptContentGrowth } from "../../services/transcriptScroll";
import { smoothScrollToLatest } from "../../services/smoothConversationScroll";
import { firstPlannerUserIsSteer, plannerHistoryMessageSources, plannerUserTurns, skipsFirstPersistedTurn, withoutLiveFirstTurn } from "../../services/plannerUserTurns";
import { plannerSteerRows, planningOutputSteerIds, type PlannerSteerRow } from "../../services/plannerSteers";
import { executionSessionTiming, executionSessionUsageThrough, mergePlannerTurns, plannerLegacyUsage, plannerSessionTiming, plannerSessionUsageThrough, plannerTurnSummaries, addTokenUsage } from "../../services/sessionMetrics";
import { PlanningActivity } from "../PlanningActivity";
import { statusText, phaseText } from "../graph/TaskNode";
import { useAnimatedNodes } from "../../hooks/useAnimatedNodes";
import { useWorkbenchResizer } from "../../hooks/useWorkbenchResizer";
import { computeExecutionLayers } from "../../hooks/useGraphElements";
import { PublicationCompletedDetails } from "../PublicationCompletedDetails";
import { PlannerTranscript } from "../PlannerTranscript";
import { resolveExecutionModelAndThinking, resolveRetryModelAndThinking, roleModelConfig } from "../../modelConfig";
import { AnimatedUserTurn } from "../AnimatedUserTurn";
import { useWorkspaceChanges } from "../../hooks/useWorkspaceChanges";
import { WorkspaceChangesPanel, WorkspaceChangesTrigger } from "../changes/WorkspaceChangesPanel";
import { AnimatedDisclosure, getConversationViewport } from "../AnimatedDisclosure";

/** Stable default so an omitted rollback set never invalidates the memos. */
const EMPTY_ID_SET: ReadonlySet<string> = new Set();
/** Stable empty transcript window so a view switch cannot invalidate memos. */
const EMPTY_INLINE_USER_TURNS: Record<string, InlineUserTurnWindow> = {};

function plannerSteerLabel(row: PlannerSteerRow): string {
  switch (row.status) {
    case "submitting": return t("正在提交消息…");
    case "submitted": return t("已提交，等待 Planner 确认…");
    case "queued": return t("已排队，等待当前步骤结束");
    case "accepted": return t("Planner 已接收，等待处理");
    case "consumed": return t("Planner 已取出，正在显示对话…");
    case "handled": return t("已由扩展处理，未必进入对话");
    case "failed": return row.error ? t("提交失败：{0}", localizeError(row.error)) : t("提交失败");
    case "unknown": return t("送达状态未知；请检查对话后再重试");
    // A newer backend may report a state this build does not name yet; never
    // leave the status line silently blank.
    default: return t("送达状态未知；请检查对话后再重试");
  }
}

/** Transient I/O status takes precedence over the durable phase copy. */
function activityStatusText(activity: RuntimeActivity[]): string | null {
  if (!activity.length) return null;
  const byKind = (kind: string) => activity.find(item => item.kind === kind);
  const prepare = byKind("workspace_prepare");
  if (prepare) {
    const nodes = prepare.nodes.join("、");
    // A preparation pass covers Git composition, conflict preparation and a
    // full metadata verification, not only copying. Report the phase so a long
    // merge/conflict step is not mistaken for a slow directory copy.
    switch (prepare.phase) {
      case "compose":
        return nodes
          ? t("正在准备节点工作区（合并上游结果）：{0}", nodes)
          : t("正在准备节点工作区（合并上游结果）");
      case "conflict":
        return nodes
          ? t("正在准备节点工作区（解决合并冲突）：{0}", nodes)
          : t("正在准备节点工作区（解决合并冲突）");
      default:
        return nodes
          ? t("正在复制节点工作区：{0}", nodes)
          : t("正在复制节点工作区");
    }
  }
  if (byKind("source_materialize")) return t("正在建立临时 Git 快照（首次收录项目文件）");
  if (byKind("source_capture")) return t("正在记录 Git 源快照");
  return null;
}

/** Planner positions persist within a Conversation; Node views reopen a fresh
 * bounded tail after their view-owned history has been released. */
interface GraphWorkbenchProps {
  state: Snapshot;
  transcriptRunId?: string;
  composerDrafts?: Map<string, string>;
  activity?: RuntimeActivity[];
  routeType: PlanRouteType;
  initialPlanMode?: PlanMode;
  selected: string;
  setSelected: (name: string) => void;
  selectedMergerId: string;
  setSelectedMergerId: (id: string) => void;
  effectiveMessages: Array<ChatMessage>;
  onEditMessage?: (msg: ChatMessage) => void;
  editingMessage?: ChatMessage | null;
  editPrefillText?: string;
  onEditPrefillTextChange?: (text: string) => void;
  onCancelEditMessage?: () => void;
  onInterrupt?: (targetNode?: string) => void;
  isPlanning: boolean;
  plannerStream: any;
  recoveredPlanningId?: string;
  onSendMessage: (val: string, options?: PromptBoxSubmitOptions) => boolean | void | Promise<boolean>;
  onEditMessageSubmit?: (msg: ChatMessage, newText: string, selectedVersion?: number) => boolean | void | Promise<boolean | void>;
  onSwitchMessageVersion?: (msg: ChatMessage, targetIndex: number) => void;
  /** Steer cards rolled back after a pause; their text returns to the composer. */
  rolledBackSteerKeys?: ReadonlySet<string>;
  onRollbackSteers?: (keys: string[]) => void;
  /** Planner steer requests whose rejected text returned to the composer; the
   * durable submission must not render a second copy of that draft. */
  revertedPlannerSteerIds?: ReadonlySet<string>;
  onRequestConfirmation: (config: ConfirmModalState) => void;
  followUpQueue?: Array<{ id: string; text: string; node?: string; timestamp: number }>;
  onCancelFollowUp?: (id: string) => void;
  onControl: (action: string, extra?: Record<string, unknown>) => void;
  onSave: (graph: Graph) => void;
  onAddManualNode: (runId: string, request: ManualNodeRequest) => Promise<boolean>;
  onOpenEditor: () => void;
  onOpenApproval: () => void;
  onOpenFile: (request: OpenWorkspaceFileRequest) => void;
  repoInfo: RepositoryInfo | null;
  config: Config;
  envOverrides?: Record<string, string>;
  active: boolean;
  locked: boolean;
  pendingRequest: boolean;
  publishing: boolean;
  publicationFailed: boolean;
  nodes: any[];
  edges: any[];
  nodeTypes: any;
  edgeTypes: any;
  tokens: any;
  failedPlanning?: PlanningSummary | null;
}

/** Inline transcript rows currently carry text only; attached files/images stay
 * in the surrounding chat bubble so they cannot disappear while paging. */
function canInlineSteerMessage(message: ChatMessage): boolean {
  return !message.images?.length && !message.files?.length;
}

/** Repeated steers share an instruction. Give each durable Steered event its
 * chronological occurrence so an older event cannot claim the newer optimistic
 * copy the user just sent for the same execution. */
function steerEventOrdinals(events: readonly GraphEvent[]): Map<number, number> {
  const counts = new Map<string, number>();
  const ordinals = new Map<number, number>();
  for (const event of events) {
    // Attachment steers use a separate inline ordinal (see numberSteers), so
    // ordinal matching only applies to text-only instructions.
    if (event.type !== "steered" || event.images?.length) continue;
    const key = `${event.execution_id ?? ""}\u0000${nodeInstructionText(event.instruction ?? "")}`;
    const ordinal = counts.get(key) ?? 0;
    ordinals.set(event.sequence, ordinal);
    counts.set(key, ordinal + 1);
  }
  return ordinals;
}

/** Match an optimistic turn to the durable event that replaces it. A steer's
 * occurrence must agree with `steerOrdinal`; otherwise an older identical
 * event would swallow a newly queued duplicate and hide its pending card. */
function matchesRecordedTurn(message: ChatMessage, event: GraphEvent, ordinal: number | undefined): boolean {
  if (message.text.replace(/^\[@[^\]]+\]\s*/, "").trim() !== (event.instruction ?? "").trim()) return false;
  if (ordinal === undefined || message.delivery !== "steered") return true;
  if (event.execution_id && message.executionId && message.executionId !== event.execution_id) return false;
  if (message.images?.length || message.files?.length || event.images?.length) return true;
  return message.steerOrdinal === undefined || message.steerOrdinal === ordinal;
}

/** Replay a short entrance on the node itself whenever `token` changes.
 *
 * The topology footer unmounts when the pane collapses while `GraphWorkbench`
 * stays mounted, so a parent-owned effect never runs again on reopen and the
 * nodes would stay frozen at their invisible first frame. Keying them instead
 * would remount them, and a replaced keyed child in the footer row can stay on
 * screen beside its replacement, stacking two status labels. Owning the
 * controls here animates both the first mount and every later label change.
 */
function useFooterReveal(token: string, disabled: boolean | null, keyframes: Record<string, number[]>, duration: number) {
  const controls = useAnimationControls();
  useEffect(() => {
    if (disabled) return;
    // `keyframes` is a literal at every call site; only the token replays it.
    void controls.start(keyframes, { duration, ease: [0.22, 1, 0.36, 1] });
  }, [token, disabled, controls]);
  return controls;
}

/** An exiting graph remains painted, but must no longer receive input or focus. */
function GraphPanePresence({ children }: { children: React.ReactNode }) {
  const present = useIsPresent();
  return <div className="graph-pane-presence" inert={!present} aria-hidden={!present || undefined}>{children}</div>;
}

function FooterStatusLabel({ token, disabled, title, children }: {
  token: string; disabled: boolean | null; title?: string; children: React.ReactNode;
}) {
  const controls = useFooterReveal(token, disabled, { opacity: [0, 1], y: [4, 0] }, 0.24);
  return <motion.span initial={disabled ? false : { opacity: 0, y: 4 }} animate={controls} title={title}>{children}</motion.span>;
}

function FooterControlsGroup({ token, disabled, children }: {
  token: string; disabled: boolean | null; children: React.ReactNode;
}) {
  const controls = useFooterReveal(token, disabled, { opacity: [0, 1], x: [6, 0] }, 0.24);
  return <motion.div initial={disabled ? false : { opacity: 0, x: 6 }} animate={controls}>{children}</motion.div>;
}

function FooterProgressLabel({ token, disabled, children }: {
  token: string; disabled: boolean | null; children: React.ReactNode;
}) {
  const controls = useFooterReveal(token, disabled, { opacity: [0, 1] }, 0.32);
  return <motion.span initial={disabled ? false : { opacity: 0 }} animate={controls}>{children}</motion.span>;
}

/** Node failures can carry multi-line backend/stderr detail; keep it readable
 * and copyable instead of collapsing it into a single opaque line. */
function NodeErrorPanel({ error, paused }: { error: string; paused?: boolean }) {
  const [copied, setCopied] = useState(false);
  const detail = useMemo(() => localizeError(error), [error]);
  const copy = useCallback(() => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(detail).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [detail]);
  return (
    <div className={`node-error${paused ? " paused" : ""}`} style={{ marginTop: 12 }}>
      <div className="node-error-head">
        <span>{t("执行失败")}</span>
        <button type="button" className="node-error-copy" onClick={copy}>
          {copied ? t("已复制") : t("复制错误")}
        </button>
      </div>
      <pre className="node-error-detail">{detail}</pre>
    </div>
  );
}

function ExecutionRecordHeader({ execution, expanded, onToggle, placeholder = false }: {
  execution: Execution;
  expanded: boolean;
  onToggle?: React.MouseEventHandler<HTMLButtonElement>;
  placeholder?: boolean;
}) {
  return <button
    type="button"
    className="session-label session-label-toggle"
    aria-expanded={placeholder ? undefined : expanded}
    aria-hidden={placeholder || undefined}
    disabled={placeholder}
    onClick={onToggle}
    style={{
      cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", justifyContent: "space-between",
      visibility: placeholder ? "hidden" : undefined
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className={`status-badge ${execution.status}`}>
        {statusText[execution.status as Status] ?? execution.status}
      </span>
      <span style={{ fontSize: 13, fontWeight: 500 }}>{t("#{0} 尝试", execution.attempt || 1)}</span>
      <ExecutionTiming execution={execution} />
    </div>
    <span style={{ fontSize: 12, opacity: 0.65, marginLeft: "auto" }}>
      {expanded ? t("点击收起执行记录") : t("点击展开执行记录")}
    </span>
  </button>;
}

interface WorkspaceDetailsPanelProps {
  /** Controlled by the workbench so at most one footer disclosure is expanded. */
  open: boolean;
  onToggle: () => void;
  showWorking?: boolean;
  compacting?: boolean;
  /** Overrides the generic Working label for a known lifecycle phase. */
  workingLabel?: string;
  /** Defaults to the node wording; Planner turns may use different workspaces. */
  label?: string;
  summaryAction?: React.ReactNode;
  additionalDetails?: React.ReactNode;
  children: React.ReactNode;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}

const WorkspaceDetailsPanel: React.FC<WorkspaceDetailsPanelProps> = ({
  open,
  onToggle,
  showWorking,
  compacting,
  workingLabel,
  label,
  summaryAction,
  additionalDetails,
  children,
  scrollContainerRef,
  onBeforeToggle,
  onAfterToggle,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const workingObserverRef = useRef<ResizeObserver | null>(null);
  const reduceMotion = useReducedMotion();
  // The indicator lives above the footer. Keep a following conversation pinned
  // while its height animates in/out, so the details button does not slide away.
  const setWorkingRef = useCallback((element: HTMLDivElement | null) => {
    workingObserverRef.current?.disconnect();
    workingObserverRef.current = null;
    if (!element) return;
    const observer = new ResizeObserver(() => notifyTranscriptContentGrowth(panelRef.current));
    observer.observe(element);
    workingObserverRef.current = observer;
  }, []);
  useEffect(() => () => workingObserverRef.current?.disconnect(), []);

  return (
    <div ref={panelRef} className={`workspace-details ${open ? "open" : ""}`}>
      {/* The collapsing row clips vertically but keeps the dot's horizontal glow. */}
      <AnimatePresence initial={false}>
        {showWorking && (
          <motion.div
            ref={setWorkingRef}
            className="working-indicator"
            role="status"
            aria-live="polite"
            initial={reduceMotion ? false : {
              opacity: 0, x: -4, height: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0,
            }}
            animate={{ opacity: 1, x: 0, height: 24, marginBottom: 6, paddingTop: 3, paddingBottom: 3 }}
            exit={reduceMotion ? { opacity: 0 } : {
              opacity: 0, x: -4, height: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0,
            }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
            style={{ clipPath: "inset(0 -12px)" }}
          >
            <span className="working-indicator-dot" />
            {compacting ? "Compacting…" : (workingLabel ?? "Working…")}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="workspace-details-summary">
        <button
          type="button"
          className="workspace-details-trigger"
          onClick={onToggle}
          aria-expanded={open}
        >
          <span>{label ?? t("工作区与会话信息")}</span>
          <ChevronRight size={12} className={`workspace-details-chevron ${open ? "open" : ""}`} />
        </button>
        {summaryAction}
      </div>

      {additionalDetails}

      <AnimatedDisclosure
        open={open}
        panelRef={panelRef}
        scrollContainerRef={scrollContainerRef}
        onBeforeToggle={onBeforeToggle}
        onAfterToggle={onAfterToggle}
      >
        <div className="workspace-details-body">{children}</div>
      </AnimatedDisclosure>
    </div>
  );
};


export const GraphWorkbench: React.FC<GraphWorkbenchProps> = React.memo(({
  state,
  transcriptRunId = state.runId,
  composerDrafts,
  activity = [],
  routeType,
  initialPlanMode,
  selected,
  setSelected,
  selectedMergerId,
  setSelectedMergerId,
  failedPlanning,
  recoveredPlanningId,
  effectiveMessages,
  onEditMessage,
  editingMessage,
  editPrefillText,
  onEditPrefillTextChange,
  onCancelEditMessage,
  onInterrupt,
  isPlanning,
  plannerStream,
  onSendMessage,
  onEditMessageSubmit,
  onSwitchMessageVersion,
  rolledBackSteerKeys = EMPTY_ID_SET,
  onRollbackSteers,
  revertedPlannerSteerIds = EMPTY_ID_SET,
  onRequestConfirmation,
  followUpQueue,
  onCancelFollowUp,
  onControl,
  onSave,
  onAddManualNode,
  onOpenEditor,
  onOpenApproval,
  onOpenFile,
  repoInfo,
  config,
  envOverrides = {},
  active,
  locked,
  pendingRequest,
  publishing,
  publicationFailed,
  nodes,
  edges,
  nodeTypes,
  edgeTypes,
  tokens,
}) => {
  const [attemptId, setAttemptId] = useState("");
  const [collapsedAttemptIds, setCollapsedAttemptIds] = useState<Set<string>>(new Set());
  // A pause/resume request can wait for the runtime lock. Reflect the click
  // immediately instead of leaving the footer silent until the snapshot lands.
  const [controlPending, setControlPending] = useState<"pause" | "resume" | null>(null);
  const [editingTaskNode, setEditingTaskNode] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  const [creatingNode, setCreatingNode] = useState(false);
  const creationRunRef = useRef("");
  const [graphMenu, setGraphMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    creationRunRef.current = "";
    setCreatingNode(false);
    setGraphMenu(null);
  }, [state.runId]);
  useEffect(() => {
    const close = () => setGraphMenu(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("click", close);
    // Sidebar menu handlers stop bubbling; close this menu in capture first.
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("keydown", escape);
    };
  }, []);
  const openGraphMenu = useStableCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setGraphMenu({ x: event.clientX, y: event.clientY });
  });
  // Auto-compaction visibility per parsed execution transcript; the working
  // labels swap to "Compacting…" while the node's own session compresses.
  const [compactingAttempts, setCompactingAttempts] = useState<Record<string, boolean>>({});
  // User turns the execution transcript has actually parsed, and whether that
  // window is the complete transcript. The outer steer bubble remains visible
  // until then, so a consumed steer never disappears while Pi is still finishing
  // the current tool call, and a partially loaded window never rolls back a
  // turn it simply has not parsed yet. Windows are scoped to the conversation
  // view: a remounting transcript reports during layout, before a parent effect
  // could clear the previous view, so clearing it here would discard that first
  // report until the transcript happened to change again.
  const inlineTurnsView = `${state.runId}\u0000${selected}`;
  const [inlineUserTurnWindows, setInlineUserTurnWindows] = useState<{
    view: string;
    windows: Record<string, InlineUserTurnWindow>;
  }>(() => ({ view: "", windows: {} }));
  const inlineUserTurns = inlineUserTurnWindows.view === inlineTurnsView
    ? inlineUserTurnWindows.windows
    : EMPTY_INLINE_USER_TURNS;
  // View-only send cursors identify newly submitted turns in a partial log;
  // durable events and the transcript remain the source of truth.
  const [liveSteers, setLiveSteers] = useState<LiveSteerMarker[]>([]);
  // Bumped when a paused steer's text is returned to the composer. It remounts
  // the uncontrolled PromptBox so its defaultValue picks up the restored draft.
  const [composerEpoch, setComposerEpoch] = useState(0);
  const handleInlineUserTurns = useCallback((execId: string, texts: string[], complete: boolean, turns: { text: string; offset?: number }[], end?: number) => {
    const view = inlineTurnsView;
    setInlineUserTurnWindows(prev => {
      const windows = prev.view === view ? prev.windows : {};
      const previous = windows[execId];
      return previous && previous.complete === complete && previous.end === end && previous.texts.length === texts.length &&
        previous.texts.every((text, index) => text === texts[index]) && previous.turns?.length === turns.length &&
        previous.turns.every((turn, index) => turn.text === turns[index].text && turn.offset === turns[index].offset)
        ? prev : { view, windows: { ...windows, [execId]: { texts, complete, turns, end } } };
    });
  }, [inlineTurnsView]);
  const [plannerHistoryCompacting, setPlannerHistoryCompacting] = useState(false);
  const handleAttemptCompacting = useCallback((execId: string, compacting: boolean) => {
    setCompactingAttempts((prev) => (!!prev[execId] === compacting ? prev : { ...prev, [execId]: compacting }));
  }, []);
  useEffect(() => {
    setAttemptId("");
    setCollapsedAttemptIds(new Set());
    setEditingTaskNode("");
    setTaskDraft("");
    onCancelEditMessage?.();
  }, [selected, state.runId]);
  useEffect(() => {
    if (!locked) setControlPending(null);
  }, [locked, state.paused, state.phase]);
  useEffect(() => { setLiveSteers([]); }, [state.runId]);
  useEffect(() => {
    setSelectedMergerId("");
  }, [state.runId, setSelectedMergerId]);
  // The publication Merger has no planner node; it is addressed through the
  // synthetic card selected in the topology.
  const publicationMergerSelected = selected === publicationMergerCardId;
  const selectedPublicationMerger = useMemo(() => {
    if (!publicationMergerSelected) return undefined;
    const publicationMergers = (state.mergers ?? []).filter((item) => item.node === "merger");
    const running = publicationMergers.find(item => item.status === "running");
    if (running && (!selectedMergerId || !publicationMergers.some(m => m.id === selectedMergerId && m.status === "running"))) {
      return running;
    }
    return publicationMergers.find((item) => item.id === selectedMergerId) ?? publicationMergers.at(-1);
  }, [publicationMergerSelected, selectedMergerId, state.mergers]);

  // A node-composition merger also has its own independent card identity and conversation.
  const isNodeMergerSelected = (selected.startsWith("merger:") && selected !== publicationMergerCardId)
    || Boolean(selectedMergerId && selected && (state.mergers ?? []).some(m => m.id === selectedMergerId && m.node === `merge:${selected}`));
  const nodeMergerTarget = isNodeMergerSelected
    ? (selected.startsWith("merger:") ? selected.slice(7) : selected)
    : "";
  const selectedNodeMerger = useMemo(() => {
    if (!isNodeMergerSelected) return undefined;
    const targetMergers = (state.mergers ?? []).filter((item) => item.node === `merge:${nodeMergerTarget}`);
    const running = targetMergers.find(item => item.status === "running");
    if (running && (!selectedMergerId || !targetMergers.some(m => m.id === selectedMergerId && m.status === "running"))) {
      return running;
    }
    return targetMergers.find((item) => item.id === selectedMergerId) ?? targetMergers.at(-1);
  }, [isNodeMergerSelected, selectedMergerId, nodeMergerTarget, state.mergers]);

  const selectedMerger = publicationMergerSelected
    ? selectedPublicationMerger
    : (isNodeMergerSelected ? selectedNodeMerger : undefined);
  const selectedMergerRunning = selectedMerger?.status === "running";
  const editInlineSteer = (execution: ConversationExecution) => onEditMessageSubmit && !locked && !execution.historyReadOnly
    ? (text: string, replacement: string, userTurnOffset?: number, images?: ImageAttachment[]) => userTurnOffset === undefined ? false :
      onEditMessageSubmit({ id: `execution-user-${execution.id}-${userTurnOffset}`, role: "user", text, images,
        node: execution.node, runId: state.runId, executionId: execution.id, userTurnOffset }, replacement)
    : undefined;
  const executionSteers = (execution: ConversationExecution, messages: ChatMessage[]): ChatMessage[] =>
    execution.historyEndOffset === undefined ? messages.filter(message => message.executionId === execution.id) :
      state.events.filter(event => event.type === "steered" && event.execution_id === execution.id).map(event => ({
        id: `event-${event.sequence}`, role: "user", text: event.instruction ?? "", node: execution.node,
        executionId: execution.id, images: event.images, delivery: "steered",
      }));
  const renderSteerBubble = (steer: ChatMessage) => (
    <div key={steer.id} className="chat-message-row user planner-follow-up">
      <EditableUserBubble
        text={nodeInstructionText(steer.text)}
        images={steer.images}
        files={steer.files}
        editing={editingMessage?.id === steer.id}
        draft={editPrefillText ?? ""}
        onDraftChange={onEditPrefillTextChange ?? (() => { })}
        onEdit={onEditMessage && (selectedMerger || steer.delivery !== "node_messaged") &&
          // A queued turn is not in Pi's tree yet. Pause returns unread text to
          // the composer; only consumed turns can use historical branching.
          !([...state.executions, ...(state.mergers ?? [])].some(exec =>
            exec.id === steer.executionId && exec.status === "running") && isUncommittedSteer(steer, inlineUserTurns))
          ? () => { setEditingTaskNode(""); onEditMessage(steer) }
          : undefined}
        onCancel={() => onCancelEditMessage?.()}
        onSend={(value) => onEditMessageSubmit ? onEditMessageSubmit(steer, value) : onSendMessage(value)}
        disabled={locked}
        versions={steer.versions}
        currentVersionIndex={steer.currentVersionIndex}
        onSwitchVersion={(idx) => onSwitchMessageVersion?.(steer, idx)}
      />
    </div>
  );

  const [mergerPrompts, setMergerPrompts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!selectedMerger?.id || !state.runId) return;
    const mergerId = selectedMerger.id;
    if (mergerPrompts[mergerId]) return;

    let cancelled = false;
    runtimeService.getMergerPrompt(state.runId, mergerId)
      .then((prompt) => {
        if (!cancelled && prompt) {
          setMergerPrompts((prev) => ({ ...prev, [mergerId]: prompt }));
        }
      })
      .catch(() => { });

    return () => {
      cancelled = true;
    };
  }, [selectedMerger?.id, state.runId, mergerPrompts]);

  const nodeMergerPrompt = useMemo(() => {
    if (!isNodeMergerSelected && !selectedPublicationMerger) return "";
    const originalGoal = state.graph.originalGoal || state.planning?.goal || "";
    const targetTask = isNodeMergerSelected
      ? (state.graph.nodes.find((item) => item.name === nodeMergerTarget)?.task || originalGoal)
      : originalGoal;
    return getMergerSystemPrompt(targetTask);
  }, [isNodeMergerSelected, selectedPublicationMerger, nodeMergerTarget, state.graph.nodes, state.graph.originalGoal, state.planning?.goal]);

  const activeMergerPrompt = (selectedMerger?.id ? mergerPrompts[selectedMerger.id] : undefined) || nodeMergerPrompt;

  const selectedNode = (isNodeMergerSelected
    ? { name: selected, task: activeMergerPrompt }
    : state.graph.nodes.find((item) => item.name === selected))
    ?? (selectedPublicationMerger ? { name: publicationMergerCardId, task: activeMergerPrompt } : undefined);
  const selectedState = selectedNode && !publicationMergerSelected && !isNodeMergerSelected
    ? state.nodes[selectedNode.name]
    : undefined;
  // Publication Mergers record their steered turns under the literal node name
  // "merger", while node Mergers record under `merge:<node>`.
  const conversationNode = publicationMergerSelected
    ? "merger"
    : isNodeMergerSelected
      ? `merge:${nodeMergerTarget}`
      : (selectedNode?.name ?? "");
  const selectedNodeLabel = publicationMergerSelected
    ? t("publication merger")
    : isNodeMergerSelected
      ? t("merger · {0}", nodeMergerTarget)
      : (selectedNode?.name ?? "");
  const selectedMergerContinuable = !!selectedMerger && !selectedMergerRunning &&
    (selectedMerger.node === "merger" || selectedMerger.status === "failed");
  const nodeMessages = useMemo(() => {
    if (!selectedNode) return [];
    // Older clients could persist the synthetic task-card edit as a chat turn.
    const localMessages = effectiveMessages.filter((msg) => msg.role === "user" && msg.node === conversationNode && msg.runId === state.runId && msg.id !== `task-${conversationNode}`);
    const latestEdit = [...state.events].reverse().find((event) =>
      event.type === "conversation_edited" && event.target === conversationNode && event.nodes?.includes(conversationNode));
    const local = latestEdit?.old_instruction
      ? (() => {
        const index = localMessages.findIndex((msg) =>
          msg.text.replace(/^\[@[^\]]+\]\s*/, "").trim() === latestEdit.old_instruction);
        return index >= 0 ? localMessages.slice(0, index) : localMessages;
      })()
      : localMessages;
    const localRemaining = [...local];
    const matchedLocals = new Map<number, ChatMessage>();
    const rolledBackTurns = new Set<string>();
    for (const msg of local) {
      if (msg.versions && msg.currentVersionIndex !== undefined) {
        for (let i = 0; i < msg.versions.length; i++) {
          if (i !== msg.currentVersionIndex) {
            for (const sub of msg.versions[i].subsequentEntries ?? []) {
              const cleanSub = sub.text.replace(/^\[@[^\]]+\]\s*/, "").trim();
              if (cleanSub) rolledBackTurns.add(cleanSub);
            }
          }
        }
      }
    }
    const activeEvents = activeNodeConversationEvents(state, conversationNode).filter((event) =>
      ((event.type === "invalidated" && event.human) || (event.type === "conversation_edited" && !event.first_turn)) && event.target === conversationNode && !!event.instruction ||
      ((event.type === "steered" || event.type === "node_messaged") && event.node === conversationNode)
    ).filter((event) => {
      if (event.instruction && rolledBackTurns.has(event.instruction.trim())) return false;
      return true;
    });
    const ordinals = steerEventOrdinals(activeEvents);
    const recorded = activeEvents.reverse().filter((event) => {
      // Match each optimistic turn to at most one durable event, from newest
      // to oldest, so repeated identical messages do not disappear.
      const ordinal = ordinals.get(event.sequence);
      const reverseIndex = [...localRemaining].reverse().findIndex((msg) => matchesRecordedTurn(msg, event, ordinal));
      if (reverseIndex < 0) return true;
      const idx = localRemaining.length - 1 - reverseIndex;
      matchedLocals.set(event.sequence, localRemaining.splice(idx, 1)[0]);
      // Keep the durable replacement; excluding both turns would make an
      // accepted steer or follow-up disappear from the conversation.
      return true;
    }).reverse().map((event): ChatMessage => {
      const matchingLocal = matchedLocals.get(event.sequence);
      return {
        id: `event-${event.sequence}`, parentId: null, role: "user",
        text: event.instruction || "", images: event.images, files: matchingLocal?.files, node: conversationNode, runId: state.runId,
        executionId: executionIdForMessage(state, event),
        pendingExecution: state.nodes[conversationNode]?.pendingMessages?.some(message => message.sequence === event.sequence),
        versions: event.type === "conversation_edited" ? versionsForEdit(state, event) : matchingLocal?.versions,
        currentVersionIndex: event.type === "conversation_edited" ? versionIndexForEdit(state, event) : matchingLocal?.currentVersionIndex,
        delivery: event.type === "node_messaged" || event.type === "steered" ? event.type : undefined,
      };
    });
    return numberSteers([...recorded, ...localRemaining]).filter(message => {
      const key = steerRollbackKey(message);
      return !key || !rolledBackSteerKeys.has(key);
    });
  }, [selectedNode?.name, conversationNode, effectiveMessages, state.runId, state.events, rolledBackSteerKeys]);
  const attempts = useMemo(() => {
    if (!selectedNode) return [];
    if (publicationMergerSelected) {
      return (state.mergers ?? []).filter((item) => item.node === "merger").sort((a, b) => a.startedAt - b.startedAt);
    }
    if (isNodeMergerSelected) {
      return (state.mergers ?? []).filter((item) => item.node === `merge:${nodeMergerTarget}`).sort((a, b) => a.startedAt - b.startedAt);
    }
    return nodeConversationExecutions(state, selectedNode.name).sort((a, b) => a.startedAt - b.startedAt);
  }, [selectedNode?.name, publicationMergerSelected, isNodeMergerSelected, nodeMergerTarget, state.executions, state.supersededExecutionIds, state.mergers]);
  const execution: Execution | undefined = selectedMerger ?? attempts.find((item) => item.id === attemptId) ?? attempts[attempts.length - 1];
  // Session details describe the Pi session, not one attempt: follow-ups and
  // retries resume the same session file, so its clock accumulates too.
  const allExecutions = useMemo(() => [...state.executions, ...(state.mergers ?? [])], [state.executions, state.mergers]);
  const executionSession = useMemo(() => executionSessionTiming(allExecutions, execution), [allExecutions, execution]);
  // The backend reports one total per session; an older attempt instead shows
  // only the usage accumulated through that attempt. A partial prefix would be
  // misleading, so token details are omitted when any usage is missing.
  const executionUsageThrough = useMemo(() => executionSessionUsageThrough(allExecutions, execution),
    [allExecutions, execution]);
  const executionUsage = executionUsageThrough.latest
    // The backend's session total is authoritative; a complete per-attempt
    // prefix covers snapshots that predate it.
    ? (sessionTokenUsage(state.runMetrics?.sessionUsage, execution?.sessionId)
      ?? (executionUsageThrough.complete ? executionUsageThrough.usage : undefined))
    : executionUsageThrough.usage;
  const executionContext = executionUsageThrough.latest
    ? (sessionContext(state.runMetrics?.sessionContext, execution?.sessionId)
      ?? attemptSessionContext(execution?.metrics))
    : attemptSessionContext(execution?.metrics);
  const showExecutionTokenUsage = !execution || executionUsageThrough.latest || executionUsageThrough.complete;
  const isMerger = publicationMergerSelected || isNodeMergerSelected;
  // Before the first execution, the task at the top is the newest information.
  // Count superseded executions too: an edited node is not a never-run node.
  const isUnrunNode = !!selectedNode && !isMerger &&
    !state.executions.some(item => item.node === selectedNode.name);
  const snapshotModelInfo = useMemo(() => {
    if (!execution) return null;
    return resolveExecutionModelAndThinking(
      execution,
      isMerger,
      state.config || config,
      envOverrides,
      // Parsed metrics always win. Legacy attempts that recorded no model still
      // belong to this node's override; the conversation-wide Node Agent
      // setting would misreport nodes that used a different model.
      state.nodes[execution.node]?.modelConfig
    );
  }, [execution, isMerger, state.nodes, state.config, config, envOverrides]);
  const retryModelInfo = !isMerger
    ? resolveRetryModelAndThinking(execution, attempts.at(-1)?.id, selectedState, state.config || config, envOverrides)
    : null;
  const nodeTaskText = selectedNode?.task ?? "";
  const latestNodeMessage = nodeMessages.length > 0 ? nodeMessages[nodeMessages.length - 1] : undefined;
  // Keep each human turn in the same conversation as its Pi execution. A
  // steer is attached to the running execution; a continuation carries the
  // newly-created execution id. Neither case creates a separate UI session.
  const nodeTurns = useMemo(() => {
    if (!selectedNode) return [];
    const turns: Array<{
      id: string;
      isInitial: boolean;
      userMessage?: ChatMessage;
      /** Steers delivered while this turn's execution was live. They belong
       * above that execution's transcript, not in a turn of their own. */
      steerMessages?: ChatMessage[];
      executions: ConversationExecution[];
    }> = [{
      id: `turn-0-${selectedNode.name}`,
      isInitial: true,
      // A replacement for a Steer/follow-up owns its new execution even when
      // the abandoned attempt was the session's first execution.
      executions: attempts[0] && !nodeMessages.some(message => !message.delivery && message.executionId === attempts[0].id)
        ? [attempts[0]] : [],
    }];
    const assigned = new Set(turns[0].executions.map(item => item.id));
    let nextAttempt = 1;

    const lastMessageByExecution = new Map(nodeMessages.filter(message => !message.delivery && message.executionId)
      .map(message => [message.executionId, message.id]));
    for (const message of nodeMessages) {
      // A steer has no execution of its own: Pi consumes it inside the running
      // session. Rendering it as a separate turn puts the user's message below
      // the response it produced, so keep it with the execution it targets.
      if (message.delivery === "steered" && message.executionId) {
        const owner = turns.find(turn => turn.executions.some(exec => exec.id === message.executionId));
        if (owner) {
          (owner.steerMessages ??= []).push(message);
          continue;
        }
      }
      const exact = message.executionId && lastMessageByExecution.get(message.executionId) === message.id
        ? attempts.find(item => item.id === message.executionId && !assigned.has(item.id))
        : undefined;
      let executions: ConversationExecution[] = exact ? [exact] : [];
      if (exact) {
        assigned.add(exact.id);
        nextAttempt = Math.max(nextAttempt, attempts.findIndex(item => item.id === exact.id) + 1);
      } else if (!message.delivery && !message.executionId && !message.pendingExecution) {
        // Older snapshots did not persist execution_id on every edit. Keep the
        // historical attempt ordering as a compatibility fallback.
        while (nextAttempt < attempts.length && assigned.has(attempts[nextAttempt].id)) nextAttempt += 1;
        if (nextAttempt < attempts.length) {
          executions = [attempts[nextAttempt]];
          assigned.add(attempts[nextAttempt].id);
          nextAttempt += 1;
        }
      }
      turns.push({ id: message.id, isInitial: false, userMessage: message, executions });
    }

    // A browser opened after a run finished may have no durable human event for
    // an older attempt. Do not hide its output; keep it in the initial turn.
    const unassigned = attempts.filter(item => !assigned.has(item.id));
    if (unassigned.length > 0) turns[0].executions.push(...unassigned);
    turns[0].executions.sort((a, b) => a.startedAt - b.startedAt);
    return turns;
  }, [selectedNode?.name, attempts, nodeMessages]);
  // While a merger is selected its own process decides the working state, not
  // the node status that covers the whole preparation/execution cycle.
  const selectedDependenciesCompleted = !selectedNode ||
    nodeDependenciesCompleted(state.graph, state.nodes, selectedNode.name);
  const isSelectedNodeWorking = selectedMerger
    ? !!selectedMergerRunning || (!!pendingRequest && selectedMerger.status !== "completed" && selectedMerger.status !== "failed")
    : isNodeWorking(selectedState?.status, execution, pendingRequest, latestNodeMessage,
      state.paused, selectedDependenciesCompleted, (selectedState?.pendingMessages?.length ?? 0) > 0);
  const isSelectedNodeCompacting = isSelectedNodeWorking &&
    !!execution?.id && !!compactingAttempts[execution.id];
  const latestNodeTurn = nodeTurns.at(-1);
  const waitingForNodeExecution = !!latestNodeTurn && latestNodeTurn.executions.length === 0 &&
    !latestNodeTurn.userMessage?.delivery && !latestNodeTurn.userMessage?.executionId && (isSelectedNodeWorking || pendingRequest);
  // Apply the continuation layout with the optimistic message, rather than
  // waiting for the backend to insert a new execution and its record header.
  const showExecutionRecords = attempts.length > 1 || (waitingForNodeExecution && attempts.length > 0);
  const provisionalRunIdRef = useRef<string | null>(null);
  if (state.runId.startsWith("pending-")) {
    provisionalRunIdRef.current = state.runId;
  }
  const currentRunKey = useMemo(() => {
    // When a newly initiated conversation's provisional pending-* runId resolves
    // to the real server-assigned runId, keep the key stable so the graph pane,
    // canvas, and chat view do not unmount and flicker right after the first send.
    if (provisionalRunIdRef.current && state.runId && !state.runId.startsWith("pending-")) {
      return provisionalRunIdRef.current;
    }
    return state.runId || state.graph.originalGoal || "initial";
  }, [state.runId, state.graph.originalGoal]);
  // A Serial run has one conversation regardless of which graph node is
  // inspected. Keeping `selected` in its key made node selection capture the
  // serial scroll offset and restore it later, leaving the conversation stuck
  // mid-history after switching views or history pages.
  // The pane is also independent of how exactly the route was resolved: an
  // auto-routed conversation renders the Planner pane for both `undecided` and
  // the resolved `graph`. Folding the raw route into the key turned that
  // resolution into a view switch, which discarded the reader's position and
  // follow state, so a Planner conversation reading its history snapped back to
  // the newest row as soon as the Partitioner answered.
  const conversationPaneKey = routeType === "serial" ? "main" : routeType === "graph" && selected ? selected : "planner";
  const conversationViewKey = `${currentRunKey}:${conversationPaneKey}`;
  const composerDraftKey = JSON.stringify([selected, selectedMerger?.id ?? ""]);
  // Remounting on epoch bumps is the only way to push restored text into the
  // uncontrolled composer without making every keystroke controlled.
  const composerKey = `${composerDraftKey}:${composerEpoch}`;
  const handleComposerChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = event.target.value;
    if (text) composerDrafts?.set(composerDraftKey, text);
    else composerDrafts?.delete(composerDraftKey);
  };
  // Live SSE is ephemeral. After reload or run selection, replay the durable
  // planning JSONL associated with the selected run, never a previous run's stream.
  const backgroundReview = plannerStream.stage !== "planning" && state.events.some(event =>
    event.type === "planner_review_started" && event.planning?.planningId === state.planningId);
  const showLivePlanner = !backgroundReview && !recoveredPlanningId && (isPlanning ||
    ((plannerStream.runId === state.runId || (provisionalRunIdRef.current && (plannerStream.runId === provisionalRunIdRef.current || state.runId === provisionalRunIdRef.current))) && plannerStream.items?.length > 0));
  const savedPlannerId = recoveredPlanningId || (failedPlanning
    ? (failedPlanning.roles?.planner ? failedPlanning.planningId : undefined)
    : (routeType === "graph" ? state.planningId : undefined));
  // Actual per-turn cwd comes from backend selection, never inferred from the
  // newest node card (linear handoff and parallel branches can change ownership).
  // Checkpointed snapshots may omit older selection events, so fold in the
  // durable current/failed summaries rather than showing an empty history.
  const plannerWorkspaces = useMemo(() => {
    const turns = state.events.flatMap(event =>
      event.type === "planner_workspace_selected" && event.planning?.worktree ? [event.planning] : []);
    const seen = new Set(turns.map(turn => turn.planningId));
    for (const summary of [failedPlanning, state.planning]) {
      if (summary?.worktree && !seen.has(summary.planningId)) {
        turns.push(summary);
        seen.add(summary.planningId);
      }
    }
    return turns;
  }, [state.events, state.planning, failedPlanning]);
  const plannerWorkspace = state.planning?.worktree
    ?? failedPlanning?.worktree ?? plannerWorkspaces.at(-1)?.worktree;
  const plannerRole = state.planning?.roles?.planner ?? failedPlanning?.roles?.planner;
  const plannerModelInfo = (() => {
    const configured = roleModelConfig(config, "planner", envOverrides);
    return {
      model: plannerRole?.model?.trim() || configured.model || t("未设置模型"),
      thinkingLevel: configured.thinkingLevel || "low",
    };
  })();
  // Summaries persisted before contexts were recorded still show their turn.
  const plannerContext = sessionContext(state.runMetrics?.sessionContext, plannerRole?.sessionId)
    ?? attemptSessionContext(plannerRole);
  // Keep the session's first start aligned with the accumulated `time took`:
  // Planner follow-ups resume one Pi session instead of starting a new clock.
  const plannerTurnHistory = useMemo(() => mergePlannerTurns(
    plannerTurnSummaries(state.events), [failedPlanning, state.planning]),
    [state.events, failedPlanning, state.planning]);
  const displayedPlannerTurnId = state.planning?.planningId ?? failedPlanning?.planningId;
  const plannerSession = useMemo(() => plannerSessionTiming(plannerTurnHistory, {
    // While a turn streams (owned or recovered), its clock is live and every
    // completed turn is prior; after it settles the displayed turn owns its
    // own duration again.
    latestId: isPlanning ? null : displayedPlannerTurnId,
    fallbackStartedAt: plannerStream?.startedAt,
  }), [plannerTurnHistory, isPlanning, displayedPlannerTurnId, plannerStream?.startedAt]);
  const plannerStartTime = plannerSession.startedAt
    ?? (isPlanning ? plannerStream?.startedAt : plannerRole?.sessionStart);
  // The live clock starts with this turn, not with the whole session; a
  // recovered turn has no browser stream start, so fall back to its durable
  // creation time instead of restarting from zero on reload.
  const displayedPlannerTurn = plannerTurnHistory.find(turn => turn.planningId === displayedPlannerTurnId)
    ?? plannerTurnHistory.at(-1);
  const plannerLiveTurnStart = plannerStream?.startedAt
    ?? displayedPlannerTurn?.createdAt
    ?? (plannerRole?.sessionStart ? Number(plannerRole.sessionStart) : undefined);
  const plannerUsageThrough = useMemo(
    () => plannerSessionUsageThrough(plannerTurnHistory, displayedPlannerTurnId),
    [plannerTurnHistory, displayedPlannerTurnId]);
  // Turns recorded before session IDs existed cannot appear in the backend's
  // per-session bucket, yet the displayed conversation still contains them.
  const plannerBackendUsage = plannerUsageThrough.latest
    ? sessionTokenUsage(state.runMetrics?.sessionUsage, plannerRole?.sessionId)
    : undefined;
  const plannerLegacy = useMemo(
    () => plannerBackendUsage ? plannerLegacyUsage(plannerTurnHistory, displayedPlannerTurnId) : undefined,
    [plannerBackendUsage, plannerTurnHistory, displayedPlannerTurnId]);
  const plannerUsage = plannerUsageThrough.latest
    ? (plannerBackendUsage
      ? (plannerLegacy ? addTokenUsage(plannerBackendUsage, plannerLegacy) : plannerBackendUsage)
      : ((plannerUsageThrough.complete ? plannerUsageThrough.usage : undefined)
        ?? plannerRole?.usage))
    : plannerUsageThrough.usage;
  const displayedPlannerContext = plannerUsageThrough.latest
    ? plannerContext
    : attemptSessionContext(plannerRole);
  const showPlannerTokenUsage = plannerUsageThrough.latest || plannerUsageThrough.complete;
  // The panel also carries the planner's working indicator, so it must exist
  // for the whole live-planning window, before the summary reaches a snapshot.
  const showPlannerDetails = routeType !== "serial";
  // A failed turn's durable log can be missing or truncated: a provider may
  // reject the turn before Pi writes anything, while the live stream already
  // holds the user turn, its partial output and the error. Keep those rows
  // visible until the next turn or a reload retires the stream, and replay the
  // earlier turns without this one so the failed turn is not rendered twice.
  const failedLivePlanningId = !isPlanning && plannerStream.stage === "error"
    ? (failedPlanning?.planningId || state.planning?.planningId || state.planningId || "")
    : "";
  // A run owns one Planner conversation, although each planning attempt has
  // its own durable output log. Replay every recorded turn after a reload —
  // including aborted revision turns — excluding turns still live-streaming.
  const savedPlannerIds = useMemo(() => plannerHistoryIds({
    events: state.events,
    savedPlannerId,
    planning: isPlanning,
    live: Boolean(showLivePlanner),
    continuation: plannerStream.isContinuation,
    backgroundReview,
    recoveredPlanningId,
    routeType,
    representedIds: plannerStream.representedPlanningIds,
  }).filter(id => id !== failedLivePlanningId), [routeType, isPlanning, backgroundReview, recoveredPlanningId, state.events, savedPlannerId, showLivePlanner, plannerStream.isContinuation, plannerStream.representedPlanningIds, failedLivePlanningId]);
  const plannerEdits = useMemo(() => plannerConversationEdits(state.events), [state.events]);
  // A post-task review continues this Planner conversation as a new section:
  // the saved replay separates its durable output from the graph's turns.
  const reviewPlannerIds = useMemo(() => reviewPlanningIds(state.events), [state.events]);
  const savedPlannerKey = savedPlannerIds.join(":");
  const [readySavedPlannerKey, setReadySavedPlannerKey] = useState("");
  const [savedPlannerRecord, setSavedPlannerRecord] = useState({ key: "", text: "" });
  const savedPlannerOutput = savedPlannerRecord.key === savedPlannerKey ? savedPlannerRecord.text
    : cachedPlanningOutput(transcriptRunId, savedPlannerIds);
  const plannerMessages = useMemo(() => effectiveMessages.filter((msg) => !msg.node || msg.node === "planner"), [effectiveMessages]);
  // Local messages can outlive this mount, while history initially loads only
  // the newest pages. Keep a known follow-up with its own revision rather than
  // appending it after newer replies until the older page is fetched.
  const plannerMessageSources = useMemo(() => plannerHistoryMessageSources(
    plannerMessages, plannerTurnHistory, savedPlannerIds, reviewPlannerIds,
  ), [plannerMessages, plannerTurnHistory, savedPlannerIds, reviewPlannerIds]);
  const plannerSourceFallbacks = useMemo(() => {
    const sources = new Map<string, ChatMessage[]>();
    for (const message of plannerMessages) {
      const source = plannerMessageSources.get(message.id);
      if (source) sources.set(source, [...(sources.get(source) ?? []), message]);
    }
    return sources;
  }, [plannerMessages, plannerMessageSources]);
  const livePlannerItems = useMemo(() => {
    const items = (plannerStream.items ?? []) as TranscriptItem[];
    // The first turn is always rendered above the transcript. A continuation
    // seeds the live stream with that same edited message, so keep the
    // canonical bubble instead of rendering it twice.
    const attachments = new Map(plannerMessages.filter(message => message.plannerSteerId).map(message => [message.id, message]));
    return withoutLiveFirstTurn(items, plannerMessages[0]?.id).map(item => {
      const message = attachments.get(item.id);
      return message ? { ...item, images: message.images ?? item.images, files: message.files } : item;
    });
  }, [plannerStream.items, plannerMessages]);
  const plannerActivityRunning = isPlanning || !!recoveredPlanningId;
  // The persisted running summary is the most recent turn. A foreground
  // Planner that has not emitted it yet must not borrow a previous turn's ID.
  const livePlanningId = plannerActivityRunning
    ? (state.planning?.status === "running" ? state.planning.planningId : recoveredPlanningId)
    : undefined;
  // Stale live rows outlive a dropped stream. Once this browser no longer owns
  // a live turn, an unterminated call can only have been interrupted; never
  // leave its spinner running forever while saved history is still loading.
  const displayedLivePlannerItems = useMemo(() => plannerActivityRunning
    ? livePlannerItems : settleInterruptedItems(livePlannerItems),
    [plannerActivityRunning, livePlannerItems]);
  // The history is also what tells the saved replay to skip the turn already
  // rendered as the conversation header. A header-only conversation still has
  // one persisted turn, so this must not short-circuit to an empty list or the
  // replay renders the goal a second time.
  const activeSavedPlannerOutput = useMemo(() => activePlannerOutput(savedPlannerOutput, plannerEdits), [savedPlannerOutput, plannerEdits]);
  const persistedTurnHistory = useMemo(() => plannerUserTurns(activeSavedPlannerOutput), [activeSavedPlannerOutput]);
  // Only hide an optimistic turn when the transcript really replays that turn.
  // A partial window that starts at a steer keeps the header out of history, so
  // skipping its first row would drop the user's message instead of a duplicate.
  const firstPersistedUserIsSteer = useMemo(() => firstPlannerUserIsSteer(activeSavedPlannerOutput), [activeSavedPlannerOutput]);
  const historyStartsAtBeginning = useMemo(() => {
    try {
      const marker = JSON.parse(activeSavedPlannerOutput.split("\n", 1)[0]);
      return marker.type === "grapher_planning_source" && marker.planningId === savedPlannerIds[0] && marker.startOffset === 0;
    } catch { return false; }
  }, [activeSavedPlannerOutput, savedPlannerIds]);
  const skipFirstPersistedTurn = historyStartsAtBeginning && !firstPersistedUserIsSteer &&
    skipsFirstPersistedTurn(persistedTurnHistory, plannerMessages[0]?.text);
  const persistedUserTurns = useMemo(() => skipFirstPersistedTurn
    ? persistedTurnHistory.slice(1) : persistedTurnHistory,
    [persistedTurnHistory, skipFirstPersistedTurn]);
  const remainingPersistedTurns = new Map<string, number>();
  for (const text of persistedUserTurns) {
    remainingPersistedTurns.set(text, (remainingPersistedTurns.get(text) ?? 0) + 1);
  }
  const effectiveRouteType = useMemo(() => {
    if (routeType !== "undecided") return routeType;
    if (state.planType) return state.planType;
    return "undecided";
  }, [routeType, state.planType]);

  const showRouteBadge = useMemo(() => {
    return shouldShowRouteBadge({
      initialPlanMode,
      plannerStream,
      state,
      routeType,
    });
  }, [
    initialPlanMode,
    plannerStream?.initialPlanMode,
    plannerStream?.stage,
    plannerStream?.partitionerText,
    plannerStream?.partitionerThinking,
    state.events,
    state.planning?.roles?.partition,
    routeType,
    state.planType,
  ]);
  const useSavedPlanner = savedPlannerIds.length > 0 &&
    (!showLivePlanner || readySavedPlannerKey === savedPlannerKey || Boolean(plannerStream.isContinuation));
  // A failure (or a stop) leaves the live rows as the only complete record of
  // the turn, so the durable replay must not replace them until the next turn.
  const renderLivePlanner = showLivePlanner &&
    (isPlanning || Boolean(failedLivePlanningId) || !useSavedPlanner);
  // A saved transcript only replaces optimistic user turns while it actually
  // renders user rows; hiding a message the transcript suppresses would lose it.
  const savedPlannerShowsUserTurns = !isPlanning || backgroundReview || !!recoveredPlanningId
    || Boolean(plannerStream.isContinuation);
  const savedPlannerSteerIds = useMemo(() => planningOutputSteerIds(activeSavedPlannerOutput), [activeSavedPlannerOutput]);
  // Planner steer IDs are UUIDs generated by this client and appear only as
  // `msg-<uuid>` live rows. A normal continuation uses `msg-<timestamp>` (or
  // `msg-initial-goal`), so the format proves visibility even when this browser
  // did not create the local message (for example after a reload or in a
  // second tab). Assuming every `msg-` row is a steer would hide that row's
  // pending duplicate, but only by misclassifying ordinary turns.
  const steerIdFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const visiblePlannerSteerIds = useMemo(() => {
    const ids = new Set<string>();
    if (renderLivePlanner) for (const item of livePlannerItems) {
      if (item.role !== "user" || !item.id.startsWith("msg-")) continue;
      const steerId = item.id.slice(4);
      if (steerIdFormat.test(steerId)) ids.add(steerId);
    }
    if (useSavedPlanner && savedPlannerShowsUserTurns) for (const id of savedPlannerSteerIds) ids.add(id);
    return ids;
  }, [renderLivePlanner, livePlannerItems, useSavedPlanner, savedPlannerShowsUserTurns, savedPlannerSteerIds]);
  const pendingPlannerSteers = useMemo(() => plannerSteerRows(state.events, plannerMessages, {
    planning: plannerActivityRunning, activePlanningId: livePlanningId, visibleIds: visiblePlannerSteerIds,
    revertedIds: revertedPlannerSteerIds,
  }), [state.events, plannerMessages, plannerActivityRunning, livePlanningId, visiblePlannerSteerIds, revertedPlannerSteerIds]);
  // A new user turn or any live Planner token makes the committed result cards
  // stale for the moment. Hide them until this turn settles, including while a
  // detached stream is recovered from durable output.
  const hidePlannerResultCards = isPlanning || !!recoveredPlanningId ||
    plannerStream.stage === "planning" || plannerStream.plannerThinkingActive ||
    Boolean(plannerStream.compacting);
  const [graphPane, setGraphPane] = useState({ collapsed: false, generation: 0 });
  // Narrow workspaces show one pane at a time without unmounting either view.
  const [narrowGraphVisible, setNarrowGraphVisible] = useState(false);
  const conversationSwitchRef = useRef<HTMLButtonElement>(null);
  const graphPaneCollapsed = graphPane.collapsed;
  const graphPaneNeedsFocus = useRef(false);
  const graphPaneRef = useRef<HTMLDivElement>(null);
  const graphResizerRef = useRef<HTMLDivElement | null>(null);
  const collapseGraphPane = useCallback(() => {
    // Keep the exiting canvas at its actual width, including after a drag to
    // the minimum; the shrinking aperture clips it rather than refitting it.
    const pane = graphPaneRef.current;
    if (pane) pane.style.setProperty("--graph-exit-width", `${pane.getBoundingClientRect().width}px`);
    graphPaneNeedsFocus.current = true;
    setGraphPane(current => ({ ...current, collapsed: true }));
  }, []);
  const expandGraphPane = useCallback(() => {
    graphPaneNeedsFocus.current = true;
    setGraphPane(current => ({ ...current, collapsed: false }));
  }, []);
  const focusGraphPaneToggle = useCallback((control: HTMLElement | null) => {
    if (control && graphPaneNeedsFocus.current) {
      control.focus({ preventScroll: true });
      graphPaneNeedsFocus.current = false;
    }
  }, []);
  const setGraphResizerRef = useCallback((control: HTMLDivElement | null) => {
    graphResizerRef.current = control;
    focusGraphPaneToggle(control);
  }, [focusGraphPaneToggle]);
  const { workbenchRef, isResizing, splitRatio, handleStartResize, handleResizeKeyDown, handleResetResizer } =
    useWorkbenchResizer({ onCollapse: collapseGraphPane, collapsed: graphPaneCollapsed });
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const failureNoticeRef = useRef<HTMLDivElement>(null);
  const expandedCardObserverRef = useRef<ResizeObserver | null>(null);
  const expandedCardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUserScrolledUpRef = useRef(false);
  // Distinguish a real reader gesture from a layout-induced scroll-up. Only a
  // gesture should prevent later final output from reclaiming the bottom.
  const userScrolledAwayRef = useRef(false);
  const shouldFollowOutput = useStableCallback(() => !isUnrunNode && !isUserScrolledUpRef.current);
  const lastScrollTopRef = useRef(0);
  const prevScrollHeightRef = useRef(0);
  // A pane resize changes how much of the newest output is visible without
  // changing scrollHeight. Followers must re-pin the bottom instead of leaving
  // a tall streaming card anchored at its header.
  const prevViewportRef = useRef<{ width: number; height: number } | null>(null);
  const lastChatViewportRef = useRef<{ width: number; height: number } | null>(null);
  const prevViewKeyRef = useRef("");
  const suppressAutoScrollRef = useRef(false);
  const resetChatScrollFrameRef = useRef<number | null>(null);
  const revealChatFrameRef = useRef<number | null>(null);
  const contentGrowthFrameRef = useRef<number | null>(null);
  const [readyConversationKey, setReadyConversationKey] = useState("");
  const isConversationReady = readyConversationKey === conversationViewKey;
  const reduceMotion = useReducedMotion();
  // Reveal the entire scrollable view together, including the topology overview
  // and publication cards, only after history and its initial scroll have settled.
  const conversationRevealStyle: React.CSSProperties = {
    opacity: isConversationReady ? 1 : 0,
    transition: isConversationReady && !reduceMotion ? "opacity 0.25s ease-out" : "none",
  };
  const activeConversationViewRef = useRef(conversationViewKey);
  const conversationGenerationRef = useRef(0);
  const isScrollingToBottomRef = useRef(false);
  const latestScrollRef = useRef<(() => void) | null>(null);
  const setUserScrolledUp = useStableCallback((scrolledUp: boolean) => {
    isUserScrolledUpRef.current = scrolledUp;
    if (!scrolledUp) userScrolledAwayRef.current = false;
    const el = chatScrollRef.current;
    if (!el) return;
    // Drive the virtualizer's bottom pin imperatively as well: follow state can
    // change from a scroll event without a React render, and a measured row in
    // a tall streaming card must not remain the de facto scroll anchor.
    if (!scrolledUp && !isUnrunNode) el.dataset.transcriptFollowing = "true";
    else delete el.dataset.transcriptFollowing;
    // The first page may already be visible while older history is still
    // filling. Keep the virtualizer bottom-pinned throughout that fill; a
    // programmatic scroll must not clear the declarative preparation flag.
    if (scrolledUp || (!isPreparingConversationRef.current && !initialFillPending)) delete el.dataset.transcriptPreparing;
    else el.dataset.transcriptPreparing = "true";
  });
  const stopLatestScroll = useCallback(() => {
    if (latestScrollRef.current) {
      latestScrollRef.current();
      latestScrollRef.current = null;
      setUserScrolledUp(true);
    }
    isScrollingToBottomRef.current = false;
  }, [setUserScrolledUp]);
  const userGestureUpRef = useRef(false);
  const historyReadingRef = useRef(false);
  const focusScrollPendingRef = useRef(false);
  // A held pointer (text selection, autoscroll, scrollbar drag) owns the scroll
  // position; only layout without any held pointer may reclaim the bottom.
  const pointerHeldRef = useRef(false);
  const scrollbarGestureRef = useRef<{
    pointerId: number; startTop: number; wasFollowing: boolean; wasScrolledUp: boolean;
    wasAway: boolean; wasGestureUp: boolean; movedUp: boolean;
  } | null>(null);
  const resumeFollowingAfterLayoutScroll = useStableCallback(() => {
    if (isUserScrolledUpRef.current && !userScrolledAwayRef.current && !historyReadingRef.current) {
      userGestureUpRef.current = false;
      setUserScrolledUp(false);
    }
  });
  const isPreparingConversationRef = useRef(true);
  const recoverOnContentFrameRef = useRef(false);
  const pinContentBottom = useStableCallback((recoverLayoutScroll = false) => {
    const el = chatScrollRef.current;
    if (!el || suppressAutoScrollRef.current || latestScrollRef.current) return;
    if (recoverLayoutScroll) resumeFollowingAfterLayoutScroll();
    if (!shouldFollowOutput()) return;
    const height = el.scrollHeight;
    if (height - el.scrollTop - el.clientHeight <= 2) return;
    el.scrollTop = height;
    lastScrollTopRef.current = el.scrollTop;
    prevScrollHeightRef.current = height;
  });
  const scheduleContentPin = useStableCallback((recoverLayoutScroll: boolean) => {
    // A final-output event may follow a normal growth event in the same frame.
    // Preserve the stronger recovery request when coalescing them.
    recoverOnContentFrameRef.current ||= recoverLayoutScroll;
    if (contentGrowthFrameRef.current !== null) return;
    contentGrowthFrameRef.current = requestAnimationFrame(() => {
      contentGrowthFrameRef.current = null;
      const recover = recoverOnContentFrameRef.current;
      recoverOnContentFrameRef.current = false;
      pinContentBottom(recover);
    });
  });
  const readyExecutionIdsRef = useRef(new Set<string>());
  // The first-byte reveal must not let the viewport jump when older pages are
  // auto-filled behind it. Track the transcripts still filling their initial
  // viewport so the scroller keeps pinning the newest rows to the bottom.
  const [loadingExecutionIds, setLoadingExecutionIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [plannerHistoryLoading, setPlannerHistoryLoading] = useState(false);
  const handleExecutionLoadingChange = useCallback((execId: string, loading: boolean) => {
    setLoadingExecutionIds(previous => {
      if (previous.has(execId) === loading) return previous;
      const next = new Set(previous);
      if (loading) next.add(execId); else next.delete(execId);
      return next;
    });
  }, []);
  const initialFillPending = loadingExecutionIds.size > 0 || plannerHistoryLoading;
  const graphCanvasRef = useRef<HTMLDivElement>(null);
  const scrollBottomBtnRef = useRef<HTMLButtonElement>(null);
  const setScrollBottomVisible = useCallback((visible: boolean) => {
    const btn = scrollBottomBtnRef.current;
    if (btn) {
      if (visible) {
        btn.classList.add("visible");
      } else {
        btn.classList.remove("visible");
      }
    }
  }, []);
  const conversationScrollStateRef = useRef<Map<string, ViewScrollState>>(new Map());
  // Planner byte windows and scroll positions survive Node navigation. Keep
  // their row measurements too, or a restored pixel offset points at different
  // rows when the virtualizer replaces estimates on remount.
  const plannerRowHeightsRef = useRef(new Map<string, number>());
  const previousNodeViewRef = useRef(Boolean(selected));

  if (activeConversationViewRef.current !== conversationViewKey) {
    if (previousNodeViewRef.current) {
      // Its byte window is released on unmount, so an old pixel offset no longer
      // describes the reopened Node's fresh tail. Only Planner positions persist.
      conversationScrollStateRef.current.delete(activeConversationViewRef.current);
    } else if (chatScrollRef.current && activeConversationViewRef.current) {
      const scroll = chatScrollRef.current;
      const saved = captureViewScrollState(scroll, isUserScrolledUpRef.current);
      if (saved.isUserScrolledUp) {
        const viewport = scroll.getBoundingClientRect();
        const row = [...scroll.querySelectorAll<HTMLElement>(".planning-activity [data-transcript-id]")].find(item => {
          const bounds = item.getBoundingClientRect();
          return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
        });
        if (row?.dataset.transcriptId) saved.anchor = { id: row.dataset.transcriptId, top: row.getBoundingClientRect().top - viewport.top };
      }
      conversationScrollStateRef.current.set(activeConversationViewRef.current, saved);
    }
    previousNodeViewRef.current = Boolean(selected);
    activeConversationViewRef.current = conversationViewKey;
    conversationGenerationRef.current += 1;
    const saved = conversationScrollStateRef.current.get(conversationViewKey);
    isUserScrolledUpRef.current = saved?.isUserScrolledUp ?? false;
    userScrolledAwayRef.current = saved?.isUserScrolledUp ?? false;
    historyReadingRef.current = false;
    if (chatScrollRef.current) delete chatScrollRef.current.dataset.transcriptHistoryReading;
    suppressAutoScrollRef.current = false;
    isPreparingConversationRef.current = true;
    readyExecutionIdsRef.current.clear();
  }

  const handleChatScroll = useCallback(() => {
    if (!chatScrollRef.current) return;
    if (suppressAutoScrollRef.current || isPreparingConversationRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatScrollRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const showLatest = !isUnrunNode && distanceFromBottom > clientHeight / 2;
    // A pane resize can move scrollTop while the browser reflows rows. That is
    // not a reader gesture, and mistaking it for one would stop following just
    // as a tall streaming reasoning card reaches the middle of the viewport.
    const viewport = { width: chatScrollRef.current.clientWidth, height: clientHeight };
    const previousViewport = lastChatViewportRef.current;
    const viewportChanged = previousViewport !== null &&
      (previousViewport.width !== viewport.width || previousViewport.height !== viewport.height);
    lastChatViewportRef.current = viewport;
    const prevScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;

    const isScrollingUp = scrollTop < prevScrollTop - 1;
    if (latestScrollRef.current) { setScrollBottomVisible(false); return; }
    if (historyReadingRef.current) {
      setScrollBottomVisible(showLatest);
      return;
    }
    const scrollbarGesture = scrollbarGestureRef.current;
    if (scrollbarGesture) {
      if (isScrollingUp) scrollbarGesture.movedUp = true;
      // Keep the gesture locked until pointerup, including the first few
      // pixels inside the bottom threshold and output arriving during a drag.
      setScrollBottomVisible(isUserScrolledUpRef.current && showLatest);
      return;
    }
    if (focusScrollPendingRef.current && isScrollingUp && distanceFromBottom > CONVERSATION_BOTTOM_THRESHOLD) {
      userScrolledAwayRef.current = true;
      userGestureUpRef.current = true;
    }

    // When near bottom, definitely lock to bottom state (prevent elastic bounce from locking scrolled-up)
    if (distanceFromBottom <= CONVERSATION_BOTTOM_THRESHOLD && !userGestureUpRef.current) {
      isScrollingToBottomRef.current = false;
      setUserScrolledUp(false);
      setScrollBottomVisible(false);
      return;
    }

    if (distanceFromBottom <= CONVERSATION_BOTTOM_THRESHOLD && userGestureUpRef.current && scrollTop > prevScrollTop + 0.5) {
      userGestureUpRef.current = false;
      setUserScrolledUp(false);
      isScrollingToBottomRef.current = false;
      setScrollBottomVisible(false);
      return;
    }

    if (isScrollingToBottomRef.current) {
      // While programmatically scrolling to bottom, keep following down until
      // reaching the bottom threshold. Do not allow sub-pixel offset jitter or
      // intermediate row height shifts to abort the scroll down.
      return;
    }

    if (isScrollingUp && distanceFromBottom > CONVERSATION_BOTTOM_THRESHOLD) {
      if (viewportChanged) {
        setScrollBottomVisible(isUserScrolledUpRef.current && showLatest);
        return;
      }
      if (!userScrolledAwayRef.current && !historyReadingRef.current && !pointerHeldRef.current) {
        // Rows above the viewport can clamp scrollTop upwards without any
        // reader gesture (for example a streaming card reflowing or a card
        // remounting). Keep following and restore the bottom instead of
        // leaving the conversation parked on an older card's title.
        if (!shouldFollowOutput()) setUserScrolledUp(false);
        pinContentBottom();
        scheduleContentPin(false);
        setScrollBottomVisible(false);
        return;
      }
      setUserScrolledUp(true);
      setScrollBottomVisible(showLatest);
      return;
    }

    // A resize or a newly mounted transcript can change the distance without
    // any user scroll. Do not mistake that for an intentional scroll-up.
    setScrollBottomVisible(isUserScrolledUpRef.current && showLatest);
  }, [isUnrunNode, setScrollBottomVisible, setUserScrolledUp]);

  const scrollToBottom = useCallback(() => {
    stopLatestScroll();
    // Explicit Latest takes over from any card reveal/collapse still in flight.
    expandedCardObserverRef.current?.disconnect();
    expandedCardObserverRef.current = null;
    if (expandedCardTimerRef.current !== null) clearTimeout(expandedCardTimerRef.current);
    expandedCardTimerRef.current = null;
    suppressAutoScrollRef.current = false;
    historyReadingRef.current = false;
    if (chatScrollRef.current) delete chatScrollRef.current.dataset.transcriptHistoryReading;
    setUserScrolledUp(false);
    userGestureUpRef.current = false;
    isScrollingToBottomRef.current = true;
    setScrollBottomVisible(false);
    const el = chatScrollRef.current;
    if (!el) return;
    latestScrollRef.current = smoothScrollToLatest(el, () => {
      latestScrollRef.current = null;
      isScrollingToBottomRef.current = false;
      lastScrollTopRef.current = el.scrollTop;
      setScrollBottomVisible(false);
    });
  }, [stopLatestScroll, setScrollBottomVisible, setUserScrolledUp]);

  // The failure notice and the reinstated result cards are siblings of the
  // transcript, so mounting them changes the scroller's content without
  // resizing the observed stream. A follower must be taken to the failure the
  // turn reports instead of being left at the top of a conversation whose live
  // rows were replaced by a shorter durable replay. A reader who deliberately
  // scrolled away keeps their position.
  const failureNoticeKey = failedPlanning && !isPlanning &&
    (failedPlanning.error || failedPlanning.status === "failed")
    ? `${failedPlanning.planningId}:${failedPlanning.error ?? ""}` : "";
  useLayoutEffect(() => {
    if (!failureNoticeKey) return;
    const el = chatScrollRef.current;
    if (!el) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const notice = failureNoticeRef.current;
        if (!notice || !shouldFollowOutput()) return;
        const pane = el.getBoundingClientRect();
        const noticeBox = notice.getBoundingClientRect();
        if (noticeBox.top >= pane.top && noticeBox.bottom <= pane.bottom) return;
        el.scrollTop += noticeBox.bottom > pane.bottom
          ? noticeBox.bottom - pane.bottom + 12
          : noticeBox.top - pane.top - 12;
        lastScrollTopRef.current = el.scrollTop;
        prevScrollHeightRef.current = el.scrollHeight;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [failureNoticeKey, hidePlannerResultCards, shouldFollowOutput]);

  const handleSendMessageWithScroll = useCallback(async (val: string, options?: PromptBoxSubmitOptions) => {
    const submittedDraft = composerDrafts?.get(composerDraftKey);
    stopLatestScroll();
    historyReadingRef.current = false;
    if (chatScrollRef.current) delete chatScrollRef.current.dataset.transcriptHistoryReading;
    setUserScrolledUp(false);
    userScrolledAwayRef.current = false;
    userGestureUpRef.current = false;
    isScrollingToBottomRef.current = true;
    setScrollBottomVisible(false);
    const targetNode = routeType === "serial" ? state.graph.nodes[0]?.name : selectedNode?.name;
    const targetExecution = selectedMerger?.status === "running" ? selectedMerger :
      [...state.executions].reverse().find(item => item.node === targetNode && item.status === "running");
    const text = nodeInstructionText(val);
    let marker: LiveSteerMarker | undefined;
    if (targetExecution && text) {
      const acceptedCount = state.events.filter(event => event.type === "steered" && event.execution_id === targetExecution.id &&
        nodeInstructionText(event.instruction ?? "") === text).length;
      const ordinal = Math.max(acceptedCount, ...effectiveMessages.filter(message => message.delivery === "steered" &&
        message.executionId === targetExecution.id && nodeInstructionText(message.text) === text)
        .map(message => (message.inlineSteerOrdinal ?? -1) + 1));
      const key = inlineSteerKey({ id: "", role: "user", text, delivery: "steered", executionId: targetExecution.id, inlineSteerOrdinal: ordinal })!;
      const window = inlineUserTurns[targetExecution.id];
      const afterOffset = window?.end ?? targetExecution.outputBytes ?? new TextEncoder().encode(targetExecution.output).length;
      const occurrence = 1 + liveSteers.filter(item => item.executionId === targetExecution.id && item.text === text &&
        item.afterOffset <= afterOffset && !liveSteerConsumed(item, window)).length;
      marker = { key, executionId: targetExecution.id, text, afterOffset, occurrence, images: options?.images,
        files: options?.files?.map(file => ({ name: file.name, size: file.size, type: file.type })) };
      setLiveSteers(previous => [...previous.filter(item => item.key !== key), marker!]);
    }
    let accepted: boolean | void;
    try {
      accepted = await onSendMessage(val, options);
    } catch (error) {
      if (marker) setLiveSteers(previous => previous.filter(item => item.key !== marker!.key));
      throw error;
    }
    if (accepted === false && marker) setLiveSteers(previous => previous.filter(item => item.key !== marker!.key));
    // Acceptance may arrive after this view unmounts. Clear only its own draft,
    // and never a newer draft entered after navigating back to this conversation.
    if (accepted !== false && composerDrafts?.get(composerDraftKey) === submittedDraft) {
      composerDrafts?.delete(composerDraftKey);
    }
    return accepted !== false;
  }, [onSendMessage, stopLatestScroll, setScrollBottomVisible, setUserScrolledUp, composerDrafts, composerDraftKey,
    routeType, state.graph.nodes, state.executions, state.events, selectedNode?.name, selectedMerger, effectiveMessages, inlineUserTurns, liveSteers]);

  // Listen to wheel and touch gestures on chat scroll container to immediately lock auto-scroll upon upward scrolling
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;

    const stopLatestForReader = () => {
      const interrupted = latestScrollRef.current !== null;
      stopLatestScroll();
      if (interrupted) {
        userScrolledAwayRef.current = true;
        userGestureUpRef.current = true;
      }
    };
    // An upward input on an empty/short conversation cannot move the reader
    // away. Do not let it disable following before the first output arrives.
    const canReadEarlier = () => el.scrollTop > 1 ||
      el.scrollHeight - el.scrollTop - el.clientHeight > CONVERSATION_BOTTOM_THRESHOLD;
    const onWheel = (e: WheelEvent) => {
      if (isNestedScrollGesture(e, el)) return;
      stopLatestForReader();
      if (e.deltaY > 0.5) {
        historyReadingRef.current = false;
        delete el.dataset.transcriptHistoryReading;
        if (el.scrollHeight - el.scrollTop - el.clientHeight <= 2) {
          userGestureUpRef.current = false;
          setUserScrolledUp(false);
        }
      }
      if (e.deltaY < -0.5 && canReadEarlier()) {
        userScrolledAwayRef.current = true;
        userGestureUpRef.current = true;
        isScrollingToBottomRef.current = false;
        setUserScrolledUp(true);
      }
    };

    let lastTouchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (isNestedScrollGesture(e, el)) return;
      stopLatestForReader();
      if (e.touches[0]) lastTouchY = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (isNestedScrollGesture(e, el)) return;
      if (e.touches[0]) {
        const curY = e.touches[0].clientY;
        const delta = curY - lastTouchY;
        lastTouchY = curY;
        if (delta < -1) {
          historyReadingRef.current = false;
          delete el.dataset.transcriptHistoryReading;
          if (el.scrollHeight - el.scrollTop - el.clientHeight <= 2) {
            userGestureUpRef.current = false;
            setUserScrolledUp(false);
          }
        }
        if (delta > 1 && canReadEarlier()) {
          userScrolledAwayRef.current = true;
          userGestureUpRef.current = true;
          isScrollingToBottomRef.current = false;
          setUserScrolledUp(true);
        }
      }
    };

    const onHistoryPrepend = () => {
      stopLatestScroll();
      historyReadingRef.current = true;
      userScrolledAwayRef.current = true;
      userGestureUpRef.current = true;
      setUserScrolledUp(true);
      isScrollingToBottomRef.current = false;
    };
    const onContentGrowth = () => {
      pinContentBottom();
      scheduleContentPin(false);
    };
    const onFinalOutput = () => {
      // The answer is the newest information. Recover a layout-induced scroll
      // up here, but leave a real reader gesture alone.
      pinContentBottom(true);
      scheduleContentPin(true);
    };
    // Row-height compensation is not the reader scrolling down. Record its
    // position before the browser dispatches the resulting scroll event.
    const onTranscriptScrollAdjusted = () => { lastScrollTopRef.current = el.scrollTop; };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
      if (isNestedScrollGesture(event, el)) return;
      const up = ["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey);
      const down = ["ArrowDown", "PageDown", "End"].includes(event.key) || (event.key === " " && !event.shiftKey);
      if (up || down) stopLatestForReader();
      if (up && canReadEarlier()) {
        userScrolledAwayRef.current = true;
        userGestureUpRef.current = true;
        setUserScrolledUp(true);
        isScrollingToBottomRef.current = false;
      } else if (down) {
        historyReadingRef.current = false;
        delete el.dataset.transcriptHistoryReading;
        if (el.scrollHeight - el.scrollTop - el.clientHeight <= 2) {
          userGestureUpRef.current = false;
          setUserScrolledUp(false);
        }
      }
    };
    let focusFrame: number | null = null;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === el) return;
      if (latestScrollRef.current) stopLatestForReader();
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Browsers can scroll the focused element into view before focusin and
      // dispatch the outer scroll event afterwards. That is reader navigation,
      // not a layout shift, even though no wheel or arrow key was involved.
      if (el.scrollTop < lastScrollTopRef.current - 1 && distance > CONVERSATION_BOTTOM_THRESHOLD) {
        userScrolledAwayRef.current = true;
        userGestureUpRef.current = true;
        isScrollingToBottomRef.current = false;
        setUserScrolledUp(true);
      } else if (target.getBoundingClientRect().top < el.getBoundingClientRect().top) {
        // Some browsers scroll after focusin. Lock only if a scroll actually
        // occurs; focus({ preventScroll: true }) must not disable following.
        focusScrollPendingRef.current = true;
        if (focusFrame !== null) cancelAnimationFrame(focusFrame);
        focusFrame = requestAnimationFrame(() => {
          focusFrame = null;
          focusScrollPendingRef.current = false;
        });
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      stopLatestForReader();
      pointerHeldRef.current = true;
      if (isNestedScrollGesture(event, el) || scrollbarGestureRef.current) return;
      const scrollbarWidth = el.offsetWidth - el.clientWidth;
      const bounds = el.getBoundingClientRect();
      // Overlay scrollbars have no layout width; only count that narrow band
      // when the scroller itself is the event target, not a right-edge button.
      const onScrollbar = scrollbarWidth > 0
        ? event.clientX >= bounds.right - scrollbarWidth
        : event.target === el && event.clientX >= bounds.right - 14;
      if (onScrollbar) {
        scrollbarGestureRef.current = { pointerId: event.pointerId, startTop: el.scrollTop,
          wasFollowing: shouldFollowOutput(), wasScrolledUp: isUserScrolledUpRef.current,
          wasAway: userScrolledAwayRef.current, wasGestureUp: userGestureUpRef.current, movedUp: false };
        // Pause immediately so row measurements cannot fight a scrollbar drag.
        // A stationary click will restore the previous state on pointerup.
        userScrolledAwayRef.current = true;
        userGestureUpRef.current = true;
        setUserScrolledUp(true);
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      pointerHeldRef.current = false;
      const gesture = scrollbarGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      scrollbarGestureRef.current = null;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const movedUp = gesture.movedUp || el.scrollTop < gesture.startTop - 1;
      const reachedBottom = el.scrollTop > gesture.startTop + 1 && distance <= CONVERSATION_BOTTOM_THRESHOLD;
      if ((gesture.wasFollowing && !movedUp) || reachedBottom) {
        historyReadingRef.current = false;
        delete el.dataset.transcriptHistoryReading;
        userGestureUpRef.current = false;
        setUserScrolledUp(false);
        if (gesture.wasFollowing) pinContentBottom();
      } else if (!movedUp) {
        userScrolledAwayRef.current = gesture.wasAway;
        userGestureUpRef.current = gesture.wasGestureUp;
        setUserScrolledUp(gesture.wasScrolledUp);
      }
    };
    el.addEventListener(HISTORY_PREPEND_EVENT, onHistoryPrepend);
    el.addEventListener(TRANSCRIPT_CONTENT_GROWTH_EVENT, onContentGrowth);
    el.addEventListener(TRANSCRIPT_FINAL_OUTPUT_EVENT, onFinalOutput);
    el.addEventListener(TRANSCRIPT_SCROLL_ADJUSTED_EVENT, onTranscriptScrollAdjusted);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("focusin", onFocusIn);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });

    return () => {
      el.removeEventListener(HISTORY_PREPEND_EVENT, onHistoryPrepend);
      el.removeEventListener(TRANSCRIPT_CONTENT_GROWTH_EVENT, onContentGrowth);
      el.removeEventListener(TRANSCRIPT_FINAL_OUTPUT_EVENT, onFinalOutput);
      el.removeEventListener(TRANSCRIPT_SCROLL_ADJUSTED_EVENT, onTranscriptScrollAdjusted);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      scrollbarGestureRef.current = null;
      pointerHeldRef.current = false;
      focusScrollPendingRef.current = false;
      if (focusFrame !== null) cancelAnimationFrame(focusFrame);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      if (contentGrowthFrameRef.current !== null) {
        cancelAnimationFrame(contentGrowthFrameRef.current);
        contentGrowthFrameRef.current = null;
      }
      recoverOnContentFrameRef.current = false;
    };
  }, [conversationViewKey, pinContentBottom, resumeFollowingAfterLayoutScroll, scheduleContentPin, stopLatestScroll, setUserScrolledUp, shouldFollowOutput]);

  const handleExpandableContentChange = useCallback((expanded?: boolean, card?: HTMLElement) => {
    // Expanding a card while the reader is already following the newest output
    // must not turn that follow off; only a deliberately scrolled-up reader gets
    // the in-place reveal. The follow state is read before suppression starts.
    const followOutput = shouldFollowOutput();
    suppressAutoScrollRef.current = true;
    if (!followOutput) setUserScrolledUp(true);
    expandedCardObserverRef.current?.disconnect();
    expandedCardObserverRef.current = null;
    if (expandedCardTimerRef.current !== null) clearTimeout(expandedCardTimerRef.current);
    // Keep automatic bottom following paused for the full animation; resuming
    // after two frames would fight the reveal and push the header offscreen.
    const finishResize = () => {
      const scroll = chatScrollRef.current;
      if (scroll) {
        if (followOutput && shouldFollowOutput()) {
          scroll.scrollTop = scroll.scrollHeight;
          lastScrollTopRef.current = scroll.scrollTop;
        }
        prevScrollHeightRef.current = scroll.scrollHeight;
      }
      suppressAutoScrollRef.current = false;
      handleChatScroll();
    };

    // Follow the card during its opening animation without pulling a tall
    // card's already-visible header to the top of a short conversation pane.
    if (expanded && card) {
      const reveal = () => {
        const scroll = chatScrollRef.current;
        if (!scroll || !scroll.contains(card)) return;
        if (followOutput) {
          // Keep the newest expanded content visible, just like streaming output.
          // A user who scrolls up during the animation takes over immediately.
          if (shouldFollowOutput()) {
            scroll.scrollTop = scroll.scrollHeight;
            lastScrollTopRef.current = scroll.scrollTop;
          }
          return;
        }
        const viewport = getConversationViewport(scroll);
        const header = card.querySelector<HTMLElement>("[aria-expanded]") ?? card;
        const headerBounds = header.getBoundingClientRect();
        const cardBounds = card.getBoundingClientRect();
        // The body's full height is available on the first animation frame even
        // while its grid row is still clipped. Use that target height so a card
        // that will end up taller than the viewport never scrolls partway while
        // it briefly looks short enough.
        const body = card.querySelector<HTMLElement>(".thinking-card-body, .tool-call-body");
        const targetHeight = body
          ? Math.max(cardBounds.height, headerBounds.height + body.offsetHeight + (card.offsetHeight - card.clientHeight))
          : cardBounds.height;
        const delta = calculateExpandedCardScrollDelta(
          true, headerBounds,
          { top: cardBounds.top, bottom: cardBounds.top + targetHeight },
          viewport.top, viewport.bottom,
        );
        if (delta > 0) scroll.scrollTop += delta;
      };
      const observer = new ResizeObserver(reveal);
      observer.observe(card);
      const composer = chatScrollRef.current?.parentElement?.querySelector(".pane-bottom-chat");
      if (composer) observer.observe(composer);
      expandedCardObserverRef.current = observer;
      expandedCardTimerRef.current = setTimeout(() => {
        reveal();
        observer.disconnect();
        if (expandedCardObserverRef.current === observer) expandedCardObserverRef.current = null;
        expandedCardTimerRef.current = null;
        finishResize();
      }, 400);
    } else {
      // During collapsing, keep auto-scroll suppressed across the collapse animation
      // and synchronize prevScrollHeight so height shrinkage does not misinterpret
      // as an intentional user scroll-up.
      expandedCardTimerRef.current = setTimeout(() => {
        expandedCardTimerRef.current = null;
        finishResize();
      }, 260);
    }
  }, [handleChatScroll, setUserScrolledUp, shouldFollowOutput]);

  const followExecutionExpansion = useCallback((panelEl: HTMLElement, hasExpandedBelow: boolean) => {
    if (expandedCardObserverRef.current) {
      expandedCardObserverRef.current.disconnect();
      expandedCardObserverRef.current = null;
    }
    if (expandedCardTimerRef.current !== null) {
      clearTimeout(expandedCardTimerRef.current);
      expandedCardTimerRef.current = null;
    }

    const scroll = chatScrollRef.current;
    if (!scroll) return;

    const follow = () => {
      const scrollEl = chatScrollRef.current;
      if (!scrollEl || !scrollEl.contains(panelEl)) return;

      if (!hasExpandedBelow) {
        // No expanded attempt below: follow all the way to bottom so the user sees the latest output
        scrollEl.scrollTop = scrollEl.scrollHeight;
        lastScrollTopRef.current = scrollEl.scrollTop;
      } else {
        // There is an expanded attempt below: reveal the bottom of this execution panel
        const viewport = getConversationViewport(scrollEl);
        const bounds = panelEl.getBoundingClientRect();
        const delta = bounds.bottom - viewport.bottom + 16;
        if (delta > 0) {
          scrollEl.scrollTop += delta;
          lastScrollTopRef.current = scrollEl.scrollTop;
        }
      }
    };

    // Follow immediately
    follow();

    // Observe size changes as transcript lines load and measure
    const observer = new ResizeObserver(() => {
      follow();
    });
    observer.observe(panelEl);
    expandedCardObserverRef.current = observer;

    // Keep following across the initial transcript load and settle
    expandedCardTimerRef.current = setTimeout(() => {
      follow();
      observer.disconnect();
      if (expandedCardObserverRef.current === observer) {
        expandedCardObserverRef.current = null;
      }
      expandedCardTimerRef.current = null;
      if (!hasExpandedBelow) {
        setUserScrolledUp(false);
        suppressAutoScrollRef.current = false;
      }
      handleChatScroll();
    }, 600);
  }, [handleChatScroll, setUserScrolledUp]);

  // New turns must not hide earlier output. Only an explicit user toggle
  // collapses a record, and that choice stays with its execution id.
  const isAttemptExpanded = useCallback((execId: string) => {
    return !showExecutionRecords || !collapsedAttemptIds.has(execId);
  }, [showExecutionRecords, collapsedAttemptIds]);

  const handleToggleAttempt = useCallback((execId: string, panelEl?: HTMLElement | null) => {
    const currentlyExpanded = isAttemptExpanded(execId);
    const willExpand = !currentlyExpanded;

    const attemptIndex = attempts.findIndex(a => a.id === execId);
    const hasExpandedBelow = attemptIndex >= 0 && attempts.slice(attemptIndex + 1).some(a => isAttemptExpanded(a.id));

    if (willExpand) {
      if (!hasExpandedBelow) {
        setUserScrolledUp(false);
        userGestureUpRef.current = false;
        suppressAutoScrollRef.current = false;
      } else {
        setUserScrolledUp(true);
        suppressAutoScrollRef.current = true;
      }
    } else {
      suppressAutoScrollRef.current = true;
      setUserScrolledUp(true);
    }

    setCollapsedAttemptIds((prev) => {
      const next = new Set(prev);
      if (currentlyExpanded) next.add(execId);
      else next.delete(execId);
      return next;
    });

    if (panelEl) {
      if (willExpand) {
        followExecutionExpansion(panelEl, hasExpandedBelow);
      } else {
        // On collapse, keep auto-scroll suppressed while shrinking so view doesn't jump
        expandedCardObserverRef.current?.disconnect();
        expandedCardObserverRef.current = null;
        if (expandedCardTimerRef.current !== null) clearTimeout(expandedCardTimerRef.current);
        expandedCardTimerRef.current = setTimeout(() => {
          if (chatScrollRef.current) {
            prevScrollHeightRef.current = chatScrollRef.current.scrollHeight;
          }
          suppressAutoScrollRef.current = false;
          expandedCardTimerRef.current = null;
          handleChatScroll();
        }, 260);
      }
    }
  }, [isAttemptExpanded, attempts, followExecutionExpansion, handleChatScroll]);

  useLayoutEffect(() => {
    const view = chatScrollRef.current?.parentElement;
    const composer = view?.querySelector<HTMLElement>(".pane-bottom-chat");
    if (!view || !composer) return;
    const update = () => {
      const composerHeight = composer.getBoundingClientRect().height;
      view.style.setProperty("--composer-height", `${composerHeight}px`);
      // Also track the settled (collapsed and idle) composer height. The Latest
      // button anchors to it while the input box is expanding so it fades out in
      // place instead of riding the growing height; it never binds this while
      // collapsing (.expanded is gone), so it still lands at rest on reveal.
      const isSettled = !composer.querySelector(".prompt-box-container.expanded")
        && !composer.querySelector(".prompt-box-container[data-resizing]");
      if (isSettled) {
        view.style.setProperty("--composer-height-resting", `${composerHeight}px`);
      }
      // The composer is overlaid; changing its height changes the scroll area's
      // bottom padding without resizing the observed transcript content.
      const scroll = chatScrollRef.current;
      if (scroll && shouldFollowOutput() && !isScrollingToBottomRef.current) {
        scroll.scrollTop = scroll.scrollHeight;
        lastScrollTopRef.current = scroll.scrollTop;
        setScrollBottomVisible(false);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [conversationViewKey, setScrollBottomVisible, shouldFollowOutput]);

  useEffect(() => () => {
    expandedCardObserverRef.current?.disconnect();
    if (expandedCardTimerRef.current !== null) clearTimeout(expandedCardTimerRef.current);
    if (workspaceDetailsTimerRef.current !== null) clearTimeout(workspaceDetailsTimerRef.current);
    stopLatestScroll();
    if (resetChatScrollFrameRef.current !== null) {
      cancelAnimationFrame(resetChatScrollFrameRef.current);
    }
    if (revealChatFrameRef.current !== null) {
      cancelAnimationFrame(revealChatFrameRef.current);
    }
  }, []);

  const workspaceDetailsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleWorkspaceDetailsBeforeToggle = useCallback(() => {
    suppressAutoScrollRef.current = true;
    if (chatScrollRef.current) {
      prevScrollHeightRef.current = chatScrollRef.current.scrollHeight;
      lastScrollTopRef.current = chatScrollRef.current.scrollTop;
    }
    if (workspaceDetailsTimerRef.current !== null) {
      clearTimeout(workspaceDetailsTimerRef.current);
    }
    // Safety fallback in case animation is somehow abruptly interrupted
    workspaceDetailsTimerRef.current = setTimeout(() => {
      workspaceDetailsTimerRef.current = null;
      suppressAutoScrollRef.current = false;
      if (chatScrollRef.current) {
        prevScrollHeightRef.current = chatScrollRef.current.scrollHeight;
        lastScrollTopRef.current = chatScrollRef.current.scrollTop;
      }
      handleChatScroll();
    }, 450);
  }, [handleChatScroll]);

  const handleWorkspaceDetailsAfterToggle = useCallback(() => {
    if (workspaceDetailsTimerRef.current !== null) {
      clearTimeout(workspaceDetailsTimerRef.current);
      workspaceDetailsTimerRef.current = null;
    }
    suppressAutoScrollRef.current = false;
    if (chatScrollRef.current) {
      prevScrollHeightRef.current = chatScrollRef.current.scrollHeight;
      lastScrollTopRef.current = chatScrollRef.current.scrollTop;
    }
    handleChatScroll();
  }, [handleChatScroll]);

  // Ensure scroll button visibility is evaluated immediately on render and on size changes
  useLayoutEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;

    handleChatScroll(); // initial check

    const observer = new ResizeObserver(() => {
      const el = chatScrollRef.current;
      if (!el) return;

      const currentScrollHeight = el.scrollHeight;
      const viewport = { width: el.clientWidth, height: el.clientHeight };
      const previousViewport = prevViewportRef.current;
      const viewportResized = previousViewport !== null &&
        (previousViewport.width !== viewport.width || previousViewport.height !== viewport.height);
      prevViewportRef.current = viewport;
      const heightGrew = currentScrollHeight > prevScrollHeightRef.current + 2;
      const heightShrankWhilePreparing = isPreparingConversationRef.current &&
        currentScrollHeight < prevScrollHeightRef.current - 2;
      prevScrollHeightRef.current = currentScrollHeight;

      if (suppressAutoScrollRef.current) return;

      // Keep the newest output visible while content arrives. This includes the
      // initial preparation window: returning early there left a freshly opened
      // history stuck at the top until the user scrolled manually. A viewport
      // resize re-wraps rows without changing scrollHeight, so a follower must
      // be re-pinned here as well; otherwise a tall streaming card can remain
      // anchored at its title after the conversation pane changes size.
      if ((heightGrew || heightShrankWhilePreparing || viewportResized) && !latestScrollRef.current &&
          (shouldFollowOutput() || isScrollingToBottomRef.current)) {
        el.scrollTop = currentScrollHeight;
        lastScrollTopRef.current = el.scrollTop;
      } else if (!isUserScrolledUpRef.current && !latestScrollRef.current) {
        lastScrollTopRef.current = el.scrollTop;
      }
      handleChatScroll();
    });

    observer.observe(el);
    if (el.firstElementChild) {
      observer.observe(el.firstElementChild);
    }

    return () => observer.disconnect();
  }, [handleChatScroll, conversationViewKey, shouldFollowOutput]);

  // Auto-scroll to bottom when new messages or streaming content arrives
  useLayoutEffect(() => {
    if (!latestScrollRef.current && shouldFollowOutput() && !suppressAutoScrollRef.current && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      lastScrollTopRef.current = chatScrollRef.current.scrollTop;
    }
  }, [
    effectiveMessages,
    plannerStream.plannerText,
    plannerStream.items,
    plannerStream.plannerThinking,
    isPlanning,
    isUnrunNode,
    shouldFollowOutput,
    execution?.id,
    execution?.status,
    execution?.outputBytes,
    execution?.output,
    state.publication?.status,
    state.phase,
  ]);

  const summaryNodes = useMemo(() => {
    if (!state.graph.nodes.length) return [];
    const nodeMap = new Map(state.graph.nodes.map((node) => [node.name, node]));
    const layers = computeExecutionLayers(state.graph, state.plan);
    const seen = new Set<string>();
    const ordered: GraphNode[] = [];
    for (const name of layers.flat()) {
      const node = nodeMap.get(name);
      if (node && !seen.has(name)) {
        seen.add(name);
        ordered.push(node);
      }
    }
    for (const node of state.graph.nodes) {
      if (!seen.has(node.name)) {
        ordered.push(node);
      }
    }
    return ordered;
  }, [state.graph, state.plan]);

  const serialNode = routeType === "serial" && state.graph.nodes.length > 0 ? state.graph.nodes[0] : undefined;
  const serialNodeState = serialNode ? state.nodes[serialNode.name] : undefined;
  const serialExecutions = useMemo(() => {
    if (!serialNode) return [];
    return nodeConversationExecutions(state, serialNode.name)
      .sort((a, b) => a.startedAt - b.startedAt);
  }, [serialNode?.name, state.executions, state.supersededExecutionIds]);
  const serialExecution: Execution | undefined = serialExecutions[serialExecutions.length - 1];
  const serialSession = useMemo(() => executionSessionTiming(allExecutions, serialExecution), [allExecutions, serialExecution]);
  const serialUsageThrough = useMemo(() => executionSessionUsageThrough(allExecutions, serialExecution),
    [allExecutions, serialExecution]);
  const serialUsage = serialUsageThrough.latest
    ? (sessionTokenUsage(state.runMetrics?.sessionUsage, serialExecution?.sessionId)
      ?? (serialUsageThrough.complete ? serialUsageThrough.usage : undefined))
    : serialUsageThrough.usage;
  const serialContext = serialUsageThrough.latest
    ? (sessionContext(state.runMetrics?.sessionContext, serialExecution?.sessionId)
      ?? attemptSessionContext(serialExecution?.metrics))
    : attemptSessionContext(serialExecution?.metrics);
  const showSerialTokenUsage = !serialExecution || serialUsageThrough.latest || serialUsageThrough.complete;
  const serialModelInfo = useMemo(() => {
    if (!serialExecution) return null;
    return resolveExecutionModelAndThinking(
      serialExecution,
      false,
      state.config || config,
      envOverrides,
      serialNodeState?.modelConfig
    );
  }, [serialExecution, serialNodeState?.modelConfig, state.config, config, envOverrides]);
  const serialRetryModelInfo = resolveRetryModelAndThinking(
    serialExecution, serialExecutions.at(-1)?.id, serialNodeState, state.config || config, envOverrides
  );

  const serialTurns = useMemo(() => {
    if (routeType !== "serial") return [];
    const turns: Array<{
      id: string;
      userMessage: ChatMessage;
      isInitial: boolean;
      /** Steers delivered while this turn's execution was live. Keep them above
       * the transcript they steered instead of creating a later empty turn. */
      steerMessages?: ChatMessage[];
      executions: ConversationExecution[];
    }> = [];

    let messages: ChatMessage[] = effectiveMessages.length > 0 ? [...effectiveMessages] : (
      state.graph.originalGoal ? [{
        id: "msg-initial-goal",
        parentId: null,
        role: "user" as const,
        text: state.graph.originalGoal,
      }] : []
    );
    // Serial is selected before the backend creates its node. Render the
    // optimistic messages and their waiting space now, not after that snapshot.
    if (!serialNode) {
      return messages.map((userMessage, index) => ({
        id: userMessage.id, userMessage, isInitial: index === 0, executions: [] as ConversationExecution[], steerMessages: [] as ChatMessage[],
      }));
    }
    const latestEdit = [...state.events].reverse().find((event) =>
      event.type === "conversation_edited" && event.target === serialNode.name && event.nodes?.includes(serialNode.name));
    if (latestEdit?.old_instruction) {
      const oldIndex = messages.findIndex((msg) =>
        msg.text.replace(/^\[@[^\]]+\]\s*/, "").trim() === latestEdit.old_instruction);
      if (oldIndex >= 0) {
        messages = messages.slice(0, latestEdit.first_turn ? oldIndex + 1 : oldIndex);
        if (latestEdit.first_turn && messages[0]) {
          messages[0] = { ...messages[0], text: serialNode.task };
        }
      }
    }
    const localRemaining = messages.filter((msg) => msg.node === serialNode.name);
    const replacedIds = new Set<string>();
    const matchedLocals = new Map<number, ChatMessage>();
    const activeEvents = activeNodeConversationEvents(state, serialNode.name).filter((event) =>
      ((event.type === "node_messaged" || event.type === "steered") && event.node === serialNode.name) ||
      ((event.type === "invalidated" && event.human || (event.type === "conversation_edited" && !event.first_turn)) && event.target === serialNode.name && !!event.instruction)
    );
    const ordinals = steerEventOrdinals(activeEvents);
    const recorded = activeEvents.reverse().filter((event) => {
      const ordinal = ordinals.get(event.sequence);
      const reverseIndex = [...localRemaining].reverse().findIndex((msg) => matchesRecordedTurn(msg, event, ordinal));
      if (reverseIndex >= 0) {
        const local = localRemaining.splice(localRemaining.length - 1 - reverseIndex, 1)[0];
        replacedIds.add(local.id);
        matchedLocals.set(event.sequence, local);
      }
      return true;
    }).reverse().map((event): ChatMessage => ({
      id: `event-${event.sequence}`, parentId: null, role: "user",
      text: event.instruction || "", images: event.images, files: matchedLocals.get(event.sequence)?.files, node: serialNode.name, runId: state.runId,
      versions: event.type === "conversation_edited" ? versionsForEdit(state, event) : undefined,
      currentVersionIndex: event.type === "conversation_edited" ? versionIndexForEdit(state, event) : undefined,
      executionId: executionIdForMessage(state, event),
      pendingExecution: state.nodes[serialNode.name]?.pendingMessages?.some(message => message.sequence === event.sequence),
      delivery: event.type === "node_messaged" || event.type === "steered" ? event.type : undefined,
    }));
    messages = messages.filter(message => !replacedIds.has(message.id));
    // A fresh browser session may have only a recorded follow-up, not the
    // original prompt in local state. Keep the initial task paired with its execution.
    if ((messages.length === 0 || messages[0]?.node === serialNode.name) && state.graph.originalGoal) {
      messages.unshift({ id: "msg-initial-goal", role: "user", text: state.graph.originalGoal });
    }
    if (messages.length === 0) return [];
    const initialEdit = [...state.events].reverse().find((event) =>
      event.type === "conversation_edited" && event.target === serialNode.name && event.first_turn);
    if (initialEdit && !messages[0].versions) {
      const versions = versionsForEdit(state, initialEdit);
      messages[0] = { ...messages[0], versions, currentVersionIndex: versionIndexForEdit(state, initialEdit, versions) };
    }
    messages.splice(1, 0, ...recorded);

    turns.push({
      id: messages[0].id,
      userMessage: messages[0],
      isInitial: true,
      executions: serialExecutions[0] && !messages.slice(1).some(message => !message.delivery && message.executionId === serialExecutions[0].id)
        ? [serialExecutions[0]] : [],
    });

    const assigned = new Set(turns[0].executions.map(execution => execution.id));
    const followUps = numberSteers(messages.slice(1)).filter(message => {
      const key = steerRollbackKey(message);
      return !key || !rolledBackSteerKeys.has(key);
    });
    const lastMessageByExecution = new Map(followUps.filter(message => !message.delivery && message.executionId)
      .map(message => [message.executionId, message.id]));
    for (const msg of followUps) {
      // A steer belongs to the execution that received it, so its response stays
      // below the user bubble instead of appearing above a separate turn.
      if (msg.delivery === "steered" && msg.executionId) {
        const owner = turns.find(turn => turn.executions.some(execution => execution.id === msg.executionId));
        if (owner) {
          (owner.steerMessages ??= []).push(msg);
          continue;
        }
      }
      const exact = msg.executionId && lastMessageByExecution.get(msg.executionId) === msg.id
        ? serialExecutions.find(execution => execution.id === msg.executionId && !assigned.has(execution.id)) : undefined;
      const next = exact ?? (!msg.delivery && !msg.executionId && !msg.pendingExecution
        ? serialExecutions.find(execution => !assigned.has(execution.id)) : undefined);
      const execs = next ? [next] : [];
      if (next) assigned.add(next.id);
      turns.push({ id: msg.id, userMessage: { ...msg, executionId: next?.id ?? msg.executionId }, isInitial: false, executions: execs });
    }

    if (serialExecutions.length > 1) {
      const assigned = new Set(turns.flatMap((t) => t.executions.map((e) => e.id)));
      const unassigned = serialExecutions.filter((e) => !assigned.has(e.id));
      if (unassigned.length > 0) {
        turns[0].executions.push(...unassigned);
        turns[0].executions.sort((a, b) => a.startedAt - b.startedAt);
      }
    }

    return turns;
  }, [routeType, serialNode?.name, effectiveMessages, serialExecutions, state.graph.originalGoal, state.runId, state.events, rolledBackSteerKeys]);

  const isSerialExecution = routeType === "serial" && state.graph.nodes.length > 0;
  // Pausing a node must not strand a steer Pi never read: the card disappears
  // (the stopped execution stops rendering it) and its text returns to the
  // composer so the user can edit and resend it instead of hitting an edit that
  // cannot find the turn in the Pi conversation tree.
  const restoreUncommittedSteerDrafts = useCallback((targetNode?: string) => {
    const steers = routeType === "serial"
      ? serialTurns.flatMap(turn => turn.steerMessages ?? [])
      : nodeTurns.flatMap(turn => turn.steerMessages ?? []);
    // Only the live attempts being interrupted can still read a queued steer.
    // A collapsed historical attempt would look uncommitted simply because its
    // transcript is not mounted, and a node stop must not touch other nodes.
    const running = new Set([...state.executions, ...(state.mergers ?? [])]
      .filter(execution => execution.status === "running" && (!targetNode || execution.node === targetNode))
      .map(execution => execution.id));
    const unread = steers.filter(message => message.executionId !== undefined &&
      running.has(message.executionId) && isUncommittedSteer(message, inlineUserTurns));
    if (unread.length === 0) return;
    const keys = unread.map(steerRollbackKey).filter((key): key is string => !!key);
    if (keys.length > 0) onRollbackSteers?.(keys);
    // Editing the rolled-back steer disabled the composer; its card is about to
    // disappear, so leave the edit instead of stranding a disabled input.
    const editingKey = editingMessage ? steerRollbackKey(editingMessage) : null;
    if (editingKey && keys.includes(editingKey)) onCancelEditMessage?.();
    const texts = unread.map(message => nodeInstructionText(message.text)).filter(Boolean);
    if (texts.length === 0) return;
    const existing = (composerDrafts?.get(composerDraftKey) ?? "").trim();
    const restored = texts.join("\n\n");
    composerDrafts?.set(composerDraftKey, existing ? `${existing}\n\n${restored}` : restored);
    setComposerEpoch(epoch => epoch + 1);
  }, [routeType, serialTurns, nodeTurns, inlineUserTurns, state.executions, state.mergers, composerDrafts, composerDraftKey, onRollbackSteers, editingMessage, onCancelEditMessage]);
  const serialWorkingAfterMessage = serialTurns.length > 0 && serialTurns[serialTurns.length - 1].executions.length === 0 &&
    !serialTurns[serialTurns.length - 1].userMessage.executionId;
  const serialDependenciesCompleted = !serialNode ||
    nodeDependenciesCompleted(state.graph, state.nodes, serialNode.name);
  const isSerialWorking = isNodeWorking(serialNodeState?.status, serialExecution, pendingRequest,
    serialWorkingAfterMessage ? serialTurns[serialTurns.length - 1].userMessage : undefined,
    state.paused, serialDependenciesCompleted, (serialNodeState?.pendingMessages?.length ?? 0) > 0);
  // Serial auto-approval runs after planning releases its busy state, and
  // approval returns before the background driver starts the waiting node.
  // Both phases belong to first-execution startup, not an idle conversation.
  const isSerialAwaitingStart = !serialExecution && !state.paused && (
    state.phase === "awaiting_approval" ||
    (state.approved && state.phase === "running" && serialNodeState?.status === "waiting")
  );
  const isMainViewWorking = routeType === "serial" ? (isPlanning || isSerialAwaitingStart || isSerialWorking) : isPlanning;
  // A disabled composer keeps an empty placeholder; an idle one invites typing.
  const nodeComposerDisabled = locked || !!editingMessage || !state.approved ||
    (!!selectedMerger && !selectedMergerRunning && !selectedMergerContinuable);
  const mainComposerDisabled = !!editingMessage || (locked && !isPlanning);
  // Live SSE and the durable-JSONL poller can both observe the Planner's
  // compaction; either source is enough to relabel the working indicator.
  const isMainViewCompacting = isMainViewWorking &&
    ((showLivePlanner && !!plannerStream?.compacting) || plannerHistoryCompacting);
  const completed = Object.values(state.nodes).filter((n) => n.status === "completed").length;
  const hasPausedNodes = Object.values(state.nodes).some((node) => node.status === "paused");
  const resumingPausedWork = hasPausedNodes || (state.paused && Object.values(state.nodes)
    .some((node) => node.status === "waiting" || node.status === "dirty"));
  const hasOtherFailures = Object.values(state.nodes).some((node) => node.status === "failed" || node.status === "blocked");
  // A poll can return the old draft while the Planner is revising it. The
  // backend also exposes when failed nodes can be explicitly continued.
  const canContinue = !publishing && !publicationFailed &&
    (state.paused || state.canResume === true);
  const graphPhase = resolveGraphPhase({
    isPlanning,
    approved: state.approved,
    paused: state.paused,
    canResume: state.canResume,
    publishing,
    publicationFailed,
    phase: state.phase,
    active,
    nodes: state.nodes,
    executions: state.executions,
    mergers: state.mergers,
  });
  const activityStatus = activityStatusText(activity);
  // Publication has its own lifecycle label. Keep the node/merger panel from
  // reporting a generic Working while the terminal result is being written.
  const publicationWorkingLabel =
    graphPhase === "merging" || state.publication?.status === "merging" ? "Merging…"
      : graphPhase === "publishing" || state.publication?.status === "publishing" ? "Publishing…"
        : selectedMerger?.node === "merger" && selectedMerger.status === "running" ? "Publishing…"
          : undefined;
  // Write-back has no separate banner: its progress and failure surface in the
  // topology footer beside the ordinary runtime status.
  const publicationStatus = state.publication?.status;
  const publicationWorking = graphPhase === "publishing" || graphPhase === "merging"
    || publicationStatus === "publishing" || publicationStatus === "merging";
  const publicationFailedNow = graphPhase === "publication_failed" || publicationStatus === "failed";
  const publicationErrorText = publicationFailedNow ? state.publication?.error ?? "" : "";
  const publicationTarget = publicationWorking || publicationFailedNow ? state.publication?.repository : undefined;
  const hasCompletedPublication = routeType === "graph" && (
    state.publication?.status === "completed" ||
    (state.phase === "completed" && state.publication?.status !== "failed" && state.publication?.status !== "publishing" && state.publication?.status !== "merging")
  );
  // The topology footer narrates the run, so each distinct label fades in
  // instead of swapping in place. Keys exclude live numbers (token totals
  // update on every poll) and only track copy that actually changes.
  const footerStatusKey = activityStatus ? `activity:${activityStatus}`
    : publicationFailedNow ? "publication:failed"
      : publicationWorking ? `publication:${graphPhase === "merging" || publicationStatus === "merging" ? "merging" : "publishing"}`
        : `phase:${graphPhase}:${state.approved ? "approved" : "draft"}:${resumingPausedWork ? "resuming" : "stopped"}:${hasOtherFailures ? "failed" : "clean"}`;
  // The same phase decides which control group is on screen; keeping its key
  // separate lets replacement buttons animate in without re-entering when only
  // their label or disabled state changes (Pause -> Pausing -> Continue).
  const footerControlKey = publicationFailedNow ? "publication:failed"
    : graphPhase === "awaiting_approval" ? "approval"
      : state.approved && !publicationWorking ? "execution"
        : "none";
  const footerMotion = reduceMotion ? { duration: 0 } : { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const };
  // Each conversation owns a fresh ReactFlow store and measured viewport.
  // Only an accepted graph mutation may open the pane: a failed or still-running
  // `node`/`edge` call leaves the draft graph unchanged, so it must not reveal an
  // empty topology on the right.
  const hasAcceptedGraphTool = (t: any) =>
    (t?.toolName === "node" || t?.toolName === "edge") && t.status === "success" && !t.isError;
  const hasGraphToolCalled =
    (plannerStream.items || []).some(hasAcceptedGraphTool) ||
    (plannerStream.tools || []).some(hasAcceptedGraphTool);
  const hasGraphPane = routeType === "graph" && (state.graph.nodes.length > 0 || hasGraphToolCalled);
  const showGraphPane = hasGraphPane && !graphPaneCollapsed;
  // On a quick reversal AnimatePresence reuses the exiting separator, so its
  // ref does not mount again to transfer focus back from the expand button.
  useLayoutEffect(() => {
    if (showGraphPane) focusGraphPaneToggle(graphResizerRef.current);
  }, [showGraphPane, focusGraphPaneToggle]);

  const animatedNodes = useAnimatedNodes(nodes, state.runId);
  const graphViewportKey = `${currentRunKey}:${graphPane.generation}`;
  const { ready: isGraphReadyForRun, initialize: centerGraph, synchronize: synchronizeGraph, manualFit: manualGraphFit } = useGraphViewport(
    // Keep the exiting canvas painted. A completed exit gets a fresh viewport;
    // an interrupted exit instead reverses smoothly on the existing canvas.
    graphViewportKey, hasGraphPane, nodes, edges, isPlanning, graphCanvasRef,
  );

  const prevMsgCountRef = useRef(effectiveMessages.length);
  useEffect(() => {
    if (effectiveMessages.length > prevMsgCountRef.current) {
      prevMsgCountRef.current = effectiveMessages.length;
      if (!latestScrollRef.current && shouldFollowOutput() && chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
    } else {
      prevMsgCountRef.current = effectiveMessages.length;
    }
  }, [effectiveMessages.length, shouldFollowOutput]);

  const updatePlannerRestoredScroll = useStableCallback((scrollTop: number | null) => {
    const saved = conversationScrollStateRef.current.get(conversationViewKey);
    if (!saved?.isUserScrolledUp) return;
    if (scrollTop !== null) saved.scrollTop = scrollTop;
    // This anchor belongs only to the current remount. A later revision must
    // not restore the old position after the reader has moved elsewhere.
    delete saved.anchor;
  });

  const syncViewScroll = useCallback((key: string) => {
    const el = chatScrollRef.current;
    if (!el) return;
    const resolved = resolveViewScroll(conversationScrollStateRef.current.get(key), el.scrollHeight);
    if (isUnrunNode) {
      el.scrollTop = 0;
    } else if (resolved.restoreSaved) {
      el.scrollTop = resolved.scrollTop;
    } else if (shouldFollowOutput()) {
      el.scrollTop = el.scrollHeight;
    }
    lastScrollTopRef.current = el.scrollTop;
    prevScrollHeightRef.current = el.scrollHeight;
  }, [isUnrunNode, shouldFollowOutput]);

  const revealConversation = useCallback(() => {
    const key = conversationViewKey;
    const generation = conversationGenerationRef.current;
    if (activeConversationViewRef.current !== key) return;
    syncViewScroll(key);
    if (revealChatFrameRef.current !== null) cancelAnimationFrame(revealChatFrameRef.current);
    // Let the transcript parse and measure its rows before the first visible frame.
    revealChatFrameRef.current = requestAnimationFrame(() => {
      if (activeConversationViewRef.current !== key || conversationGenerationRef.current !== generation) return;
      syncViewScroll(key);
      revealChatFrameRef.current = requestAnimationFrame(() => {
        revealChatFrameRef.current = null;
        if (activeConversationViewRef.current !== key || conversationGenerationRef.current !== generation) return;
        syncViewScroll(key);
        isPreparingConversationRef.current = false;
        suppressAutoScrollRef.current = false;
        setScrollBottomVisible(false);
        setReadyConversationKey(key);
      });
    });
  }, [conversationViewKey, syncViewScroll, setScrollBottomVisible]);

  const visibleExecutionIds = useMemo(() => {
    if (selectedNode && routeType === "graph") {
      return nodeTurns.flatMap(turn => turn.executions).filter(exec => isAttemptExpanded(exec.id)).map(exec => exec.id);
    }
    return routeType === "serial" ? serialTurns.flatMap(turn => turn.executions).map(exec => exec.id) : [];
  }, [selectedNode, routeType, nodeTurns, serialTurns, isAttemptExpanded]);

  const handleExecutionOutputReady = useCallback((execId: string) => {
    readyExecutionIdsRef.current.add(execId);
    if (!isConversationReady && visibleExecutionIds.every(id => readyExecutionIdsRef.current.has(id))) {
      revealConversation();
    }
  }, [isConversationReady, visibleExecutionIds, revealConversation]);

  useLayoutEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;

    const isNewView = prevViewKeyRef.current !== conversationViewKey;
    prevViewKeyRef.current = conversationViewKey;

    if (isNewView) {
      stopLatestScroll();
      suppressAutoScrollRef.current = false;
      isPreparingConversationRef.current = true;
      isScrollingToBottomRef.current = false;

      const resolved = resolveViewScroll(conversationScrollStateRef.current.get(conversationViewKey), el.scrollHeight);
      setUserScrolledUp(resolved.isUserScrolledUp);
      el.scrollTop = isUnrunNode ? 0 : resolved.scrollTop;
      lastScrollTopRef.current = el.scrollTop;
      prevScrollHeightRef.current = el.scrollHeight;
      setScrollBottomVisible(false);

      if (resetChatScrollFrameRef.current !== null) {
        cancelAnimationFrame(resetChatScrollFrameRef.current);
      }
      resetChatScrollFrameRef.current = requestAnimationFrame(() => {
        resetChatScrollFrameRef.current = null;
        syncViewScroll(conversationViewKey);
      });
    }

    // Readiness includes the initial viewport fill, not just the newest turn's
    // first byte page. A timer must not reveal unfinished history on a slow read.
    // Readers also announce errors/empty logs so those remain visible and retryable.
    const needsPlanner = !selectedNode && routeType !== "serial" && savedPlannerIds.length > 0 && useSavedPlanner;
    const outputReady = visibleExecutionIds.every(id => readyExecutionIdsRef.current.has(id)) &&
      (!needsPlanner || readySavedPlannerKey === savedPlannerKey);
    if (readyConversationKey !== conversationViewKey && outputReady) revealConversation();
  }, [
    conversationViewKey,
    isUnrunNode,
    readyConversationKey,
    selectedNode,
    routeType,
    visibleExecutionIds,
    savedPlannerIds.length,
    savedPlannerKey,
    readySavedPlannerKey,
    useSavedPlanner,
    revealConversation,
    syncViewScroll,
    stopLatestScroll,
    setScrollBottomVisible,
    setUserScrolledUp,
  ]);

  const selectGraphNode = useStableCallback((id: string) => {
    if (!id) { setSelected(""); setSelectedMergerId(""); return; }
    creationRunRef.current = "";
    setCreatingNode(false);
    if (narrowGraphVisible) {
      setNarrowGraphVisible(false);
      // Only the narrow layout exposes this button; desktop focus is unchanged.
      if (conversationSwitchRef.current?.getClientRects().length) conversationSwitchRef.current.focus();
    }
    if (id === publicationMergerCardId) {
      const publicationMergers = (state.mergers ?? []).filter(item => item.node === "merger");
      const runningMerger = publicationMergers.find(item => item.status === "running");
      const merger = runningMerger ?? publicationMergers.at(-1);
      setSelected(publicationMergerCardId);
      setSelectedMergerId(merger?.id ?? "");
      setAttemptId(merger?.id ?? "");
      return;
    }
    if (id.startsWith("merger:")) {
      const target = id.slice(7);
      const targetMergers = (state.mergers ?? []).filter(item => item.node === `merge:${target}`);
      const runningMerger = targetMergers.find(item => item.status === "running");
      const merger = runningMerger ?? targetMergers.at(-1);
      setSelected(id);
      setSelectedMergerId(merger?.id ?? "");
      setAttemptId(merger?.id ?? "");
    } else {
      setSelected(id);
      setSelectedMergerId("");
      setAttemptId("");
    }
  });

  const changesPanelId = React.useId();
  // Session details and file changes sit beside each other in the same footer
  // row, so only one of them is expanded per conversation view; opening either
  // collapses the other instead of stacking two disclosures.
  const [openFooterPanel, setOpenFooterPanel] = useState<{ view: string; panel: "details" | "changes" } | null>(null);
  const footerPanel = openFooterPanel?.view === conversationViewKey ? openFooterPanel.panel : null;
  const changesPanelOpen = footerPanel === "changes";
  const detailsPanelOpen = footerPanel === "details";
  const toggleFooterPanel = useCallback((panel: "details" | "changes") => {
    setOpenFooterPanel(current => current?.view === conversationViewKey && current.panel === panel
      ? null
      : { view: conversationViewKey, panel });
  }, [conversationViewKey]);
  useEffect(() => {
    setOpenFooterPanel(null);
  }, [conversationViewKey]);

  const inNodeScope = !!selectedNode && routeType === "graph";

  const isCurrentViewWorking =
    selectedNode && routeType === "graph"
      ? isSelectedNodeWorking
      : isMainViewWorking ||
      graphPhase === "running" ||
      graphPhase === "publishing" ||
      graphPhase === "merging" ||
      // Standalone publication-Merger turns keep the Run completed; source
      // follow-ups can likewise run outside the ordinary running phase.
      state.executions.some(execution => execution.status === "running") ||
      (state.mergers ?? []).some(execution => execution.status === "running");

  const { summary: workspaceChangesSummary } = useWorkspaceChanges({
    state,
    // Node/Merger conversations show only their own executions; the main view
    // uses the run-level projection, which also covers Planner and publication.
    // A waiting node scopes to an empty execution list, which must not fall back
    // to that run aggregate. `attempts` is stable from the snapshot, whereas
    // `nodeTurns` grows while transcript history loads and would re-scope the
    // panel several times (empty -> first attempt -> all attempts).
    scopedExecutions: inNodeScope ? attempts : null,
    isWorking: isCurrentViewWorking,
  });

  const changesTrigger = <WorkspaceChangesTrigger
    summary={workspaceChangesSummary}
    panelId={changesPanelId}
    isOpen={changesPanelOpen}
    onToggle={() => toggleFooterPanel("changes")}
  />;
  const changesPanel = <WorkspaceChangesPanel
    key={conversationViewKey}
    id={changesPanelId}
    summary={workspaceChangesSummary}
    open={changesPanelOpen}
    scrollContainerRef={chatScrollRef}
    onBeforeToggle={handleWorkspaceDetailsBeforeToggle}
    onAfterToggle={handleWorkspaceDetailsAfterToggle}
    onOpenFile={(item) => onOpenFile({
      runId: state.runId,
      path: item.path,
      ...(inNodeScope ? { executionIds: attempts.map(execution => execution.id) } : {}),
      ...(item.nodes?.length ? { nodes: item.nodes } : {}),
    })}
  />;

  const plannerResultCards = <>
    {routeType === "graph" && (state.graph.nodes.length > 0 || hasCompletedPublication) && (
      <motion.div
        className="plan-summary-card"
        initial={false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.38, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="plan-summary-header">
          <span>{t("执行拓扑概览")}</span>
          <span className={`phase-tag ${graphPhase}`}>{phaseText[graphPhase] ?? t("草稿")}</span>
        </div>

        <div className="plan-stats-row">
          <div className="plan-stat">
            <span className="stat-num">{state.graph.nodes.length}</span>
            <span className="stat-lbl">{t("规划节点")}</span>
          </div>
          <div className="plan-stat">
            <span className="stat-num">{state.plan?.executionBatches.length ?? 1}</span>
            <span className="stat-lbl">{t("执行批次")}</span>
          </div>
          <div className="plan-stat">
            <span className="stat-num">{state.graph.edges.length}</span>
            <span className="stat-lbl">{t("拓扑边")}</span>
          </div>
          <div className="plan-stat">
            <span className="stat-num">
              {`${completed}/${state.graph.nodes.length}`}
            </span>
            <span className="stat-lbl">{t("已完成")}</span>
          </div>
        </div>

        <div className="plan-nodes-list">
          <span className="nodes-list-title">
            {t("节点列表（点击聚焦查看详细日志与独立沙箱）：")}
          </span>
          <div className="nodes-chips">
            {summaryNodes.map((node) => {
              const nState = state.nodes[node.name];
              return (
                <button
                  type="button"
                  key={node.name}
                  className="node-chip"
                  onClick={() => { setSelected(node.name); setSelectedMergerId(""); }}
                >
                  <span className={`chip-dot ${nState?.status ?? "waiting"}`} />
                  <span className="chip-name">{node.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {hasCompletedPublication && (
          <PublicationCompletedDetails
            state={state}
            repository={config?.repository || repoInfo?.path}
          />
        )}
      </motion.div>
    )}
  </>;

  return (
    <section
      // Keep exit animations and split-width transitions within one Conversation.
      key={currentRunKey}
      className={`workbench ${isResizing ? "resizing" : ""} ${showGraphPane ? "graph-mode" : "dialogue-only-mode"} ${hasGraphPane && graphPaneCollapsed ? "graph-collapsed" : ""} ${narrowGraphVisible && showGraphPane ? "narrow-graph-visible" : ""} ${isPlanning ? "planning-active" : "historical-settled"}`}
      ref={workbenchRef}
      style={{
        "--workbench-split-ratio": splitRatio,
        "--workbench-left-width": `${splitRatio * 100}%`,
      } as React.CSSProperties}
    >
      {hasGraphPane && (
        <div className="workbench-view-switcher" role="group" aria-label={t("工作台视图")}>
          <button type="button" ref={conversationSwitchRef} aria-pressed={!narrowGraphVisible || graphPaneCollapsed}
            onClick={() => setNarrowGraphVisible(false)}>{t("对话视图")}</button>
          <button type="button" aria-pressed={narrowGraphVisible && !graphPaneCollapsed}
            onClick={() => { setNarrowGraphVisible(true); if (graphPaneCollapsed) expandGraphPane(); }}>
            {t("执行拓扑图")}
          </button>
        </div>
      )}
      {/* 左侧/居中对话与日志面板 */}
      <motion.div
        className={`conversation-pane ${showGraphPane ? "split" : "full-width"}`}
        style={showGraphPane ? undefined : { width: "100%", maxWidth: "100%" }}
      >
        {creatingNode && routeType === "graph" ? (
          <CreateNodeForm key={state.runId} state={state} busy={locked || isPlanning || publishing || publicationFailed || state.phase === "launching_result"}
            onCancel={() => { creationRunRef.current = ""; setCreatingNode(false); }}
            onRequestConfirmation={onRequestConfirmation}
            onSave={async (request) => {
              const runId = state.runId;
              const accepted = await onAddManualNode(runId, request);
              if (accepted && creationRunRef.current === runId) {
                creationRunRef.current = "";
                setCreatingNode(false);
                setSelectedMergerId("");
                setSelected(request.node.name);
              }
              return accepted;
            }} />
        ) : selectedNode && routeType === "graph" ? (
          <div className="initial-query-view">
            <div className="conversation-heading">
              <div className="heading-title-col">
                <h2>{selectedNodeLabel}</h2>
              </div>
              {routeType === "graph" && (
                <button
                  type="button"
                  className="back-to-query-btn"
                  onClick={() => { setSelected(""); setSelectedMergerId(""); }}
                >
                  <ArrowLeft size={16} />
                </button>
              )}
            </div>

            <div
              className={`initial-query-scroll ${isConversationReady ? "conversation-ready" : "conversation-preparing"}`}
              data-transcript-preparing={(!isConversationReady || initialFillPending) && !isUserScrolledUpRef.current ? "true" : undefined}
              data-transcript-following={!isUnrunNode && !isUserScrolledUpRef.current ? "true" : undefined}
              ref={chatScrollRef}
              onScroll={handleChatScroll}
              style={conversationRevealStyle}
            >
              <div
                className="chat-messages-stream"
                style={{ opacity: isConversationReady ? 1 : 0 }}
              >
                <NodeTaskCard
                  nodeName={selectedNode.name}
                  taskText={nodeTaskText}
                  badgeText={isNodeMergerSelected || publicationMergerSelected ? t("Merger 系统提示词") : undefined}
                  editing={editingTaskNode === selectedNode.name}
                  draft={taskDraft}
                  onDraftChange={setTaskDraft}
                  onEdit={!isNodeMergerSelected && selected !== publicationMergerCardId ? () => {
                    onCancelEditMessage?.();
                    setEditingTaskNode(selectedNode.name);
                    setTaskDraft(selectedNode.task);
                  } : undefined}
                  onCancel={() => setEditingTaskNode("")}
                  disabled={locked}
                  onSave={(value) => {
                    const saveTask = () => {
                      onSave({
                        ...state.graph,
                        nodes: state.graph.nodes.map((node) =>
                          node.name === selectedNode.name ? { ...node, task: value } : node
                        ),
                      });
                      setEditingTaskNode("");
                    };
                    if (state.approved) {
                      const first = attempts[0];
                      if (first && onEditMessageSubmit) {
                        const submitEdit = () => {
                          void Promise.resolve(onEditMessageSubmit({
                            id: `task-${selectedNode.name}`,
                            role: "user",
                            text: selectedNode.task,
                            node: selectedNode.name,
                            executionId: first.id,
                            runId: state.runId,
                          }, value)).then((accepted) => {
                            if (accepted !== false) setEditingTaskNode("");
                          });
                        };
                        if (selectedState?.status === "running") {
                          onRequestConfirmation({
                            title: t("节点正在执行"),
                            message: t("保存会停止该节点正在执行的进程，并从会话开头以新的任务目标重新运行。"),
                            confirmText: t("停止并修改"),
                            danger: true,
                            onConfirm: submitEdit,
                          });
                          return;
                        }
                        submitEdit();
                        return;
                      } else {
                        onRequestConfirmation({
                          title: t("修改未执行的 Task？"),
                          message: t("此节点尚无 Pi 对话可分支，将创建新的待审批运行。"),
                          confirmText: t("确认修改"),
                          danger: true,
                          onConfirm: saveTask,
                        });
                      }
                      return;
                    }
                    saveTask();
                  }}
                />

                {nodeTurns.map((turn, index) => {
                  const isWaitingExecution = waitingForNodeExecution && index === nodeTurns.length - 1;

                  return (
                    <React.Fragment key={turn.id}>
                      {turn.userMessage && (
                        <div className={`chat-message-row user${turn.isInitial ? "" : " planner-follow-up"}`}>
                          <EditableUserBubble
                            text={turn.userMessage.text.replace(/^\[@[^\]]+\]\s*/, "").trim()}
                            images={turn.userMessage.images}
                            files={turn.userMessage.files}
                            editing={editingMessage?.id === turn.userMessage.id}
                            draft={editPrefillText ?? ""}
                            onDraftChange={onEditPrefillTextChange ?? (() => { })}
                            onEdit={onEditMessage && (selectedMerger || turn.userMessage.delivery !== "node_messaged")
                              ? () => { setEditingTaskNode(""); onEditMessage(turn.userMessage!) }
                              : undefined}
                            onCancel={() => onCancelEditMessage?.()}
                            onSend={(value) => onEditMessageSubmit ? onEditMessageSubmit(turn.userMessage!, value) : onSendMessage(value)}
                            disabled={locked}
                            versions={turn.userMessage.versions}
                            currentVersionIndex={turn.userMessage.currentVersionIndex}
                            onSwitchVersion={(idx) => onSwitchMessageVersion?.(turn.userMessage!, idx)}
                          />
                        </div>
                      )}
                      {turn.executions.map((exec) => {
                        const isExpanded = isAttemptExpanded(exec.id);
                        const ownedSteers = executionSteers(exec, turn.steerMessages ?? []);
                        const executionLiveSteers = liveSteers.filter(item => item.executionId === exec.id &&
                          ownedSteers.some(steer => inlineSteerKey(steer) === item.key));
                        const inlineSteerTexts = ownedSteers
                          .filter(message => exec.historyEndOffset !== undefined || canInlineSteerMessage(message) || executionLiveSteers.some(item => item.key === inlineSteerKey(message)))
                          .map(steer => nodeInstructionText(steer.text))
                          .filter(Boolean);
                        const fallbackSteers = exec.historyEndOffset !== undefined ? [] : ownedSteers.map(steer => ({
                          steer, position: steerFallbackPosition(steer, inlineUserTurns, exec.status === "running", isExpanded,
                            executionLiveSteers.find(item => item.key === inlineSteerKey(steer))),
                        }));
                        return (
                          <React.Fragment key={exec.id}>
                            <motion.div
                              className="serial-execution-panel"
                              initial={false}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ duration: 0.3 }}
                            >
                              {showExecutionRecords && (
                                <ExecutionRecordHeader execution={exec} expanded={isExpanded} onToggle={(e) => {
                                  const panel = e.currentTarget.closest<HTMLElement>(".serial-execution-panel");
                                  handleToggleAttempt(exec.id, panel);
                                }} />
                              )}
                              {/* A pending steer that predates the parsed transcript sits
                                  under the execution header. Unread steers after it join the
                                  conversation column so their turn rhythm matches the rest. */}
                              {fallbackSteers.filter(item => item.position === "before").map(item => renderSteerBubble(item.steer))}
                              {isExpanded && (
                                <div style={{ display: "flex", flexDirection: "column", marginTop: showExecutionRecords ? 4 : 0 }}>
                                  <ExecutionTranscript
                                    runId={state.runId}
                                    execution={exec}
                                    endOffset={exec.historyEndOffset}
                                    onUserResize={handleExpandableContentChange}
                                    onInitialOutputReady={handleExecutionOutputReady}
                                    onLoadingChange={(loading) => handleExecutionLoadingChange(exec.id, loading)}
                                    onCompactingChange={(compacting) => handleAttemptCompacting(exec.id, compacting)}
                                    inlineUserTurnTexts={inlineSteerTexts}
                                    liveSteers={executionLiveSteers}
                                    onEditUser={editInlineSteer(exec)}
                                    onInlineUserTurnsChange={(texts, complete, turns, end) => handleInlineUserTurns(exec.id, texts, complete, turns, end)}
                                  />
                                </div>
                              )}
                            </motion.div>
                            {fallbackSteers.filter(item => item.position === "after").map(item => renderSteerBubble(item.steer))}
                          </React.Fragment>
                        );
                      })}
                      {turn.steerMessages
                        ?.filter(steer => !turn.executions.some(exec => exec.id === steer.executionId))
                        .map(renderSteerBubble)}
                      {isWaitingExecution && (
                        <div className="serial-execution-panel" aria-hidden="true">
                          {showExecutionRecords && attempts.at(-1) && (
                            <ExecutionRecordHeader execution={attempts.at(-1)!} expanded placeholder />
                          )}
                          <div style={{ display: "flex", flexDirection: "column", marginTop: showExecutionRecords ? 4 : 0 }}>
                            <ExecutionTranscriptPlaceholder />
                          </div>
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}

                <WorkspaceDetailsPanel
                  key={`${state.runId}:${selectedNode.name}`}
                  open={detailsPanelOpen}
                  onToggle={() => toggleFooterPanel("details")}
                  showWorking={isSelectedNodeWorking}
                  compacting={isSelectedNodeCompacting}
                  workingLabel={publicationWorkingLabel}
                  summaryAction={changesTrigger}
                  additionalDetails={changesPanel}
                  scrollContainerRef={chatScrollRef}
                  onBeforeToggle={handleWorkspaceDetailsBeforeToggle}
                  onAfterToggle={handleWorkspaceDetailsAfterToggle}
                >
                  <p>Workspace: {execution?.worktree || config.repository || "preparing workspace…"}</p>
                  <p>Session id: {execution?.sessionId || "waiting for initialization…"}</p>
                  <p>Commit before: {execution?.before || "not snapshotted"}</p>
                  <p>Commit after: {execution ? (execution.after === "" ? "direct modification (no snapshot)" : execution.after ?? "pending") : "pending"}</p>
                  <div className="session-details-row">
                    <p>Start time: {formatSessionStartTime(executionSession.startedAt ?? execution?.startedAt)}</p>
                    <p>Time took: <ExecutionTimeTookText execution={execution} priorDurationSeconds={executionSession.priorDurationSeconds} /></p>
                  </div>
                  {snapshotModelInfo && (
                    <div className="session-details-row">
                      <p>Model: {snapshotModelInfo.model}</p>
                      <p>Thinking level: {snapshotModelInfo.thinkingLevel}</p>
                    </div>
                  )}
                  {retryModelInfo && (
                    <div className="session-details-row">
                      <p>{t("重试时使用的模型：{0}", retryModelInfo.model)}</p>
                      <p>{t("重试时使用的思维等级：{0}", retryModelInfo.thinkingLevel)}</p>
                    </div>
                  )}
                  {(showExecutionTokenUsage || executionContext) && (
                    <SessionTokenUsage usage={executionUsage} context={executionContext}
                      showTokens={showExecutionTokenUsage} />
                  )}
                </WorkspaceDetailsPanel>

                {selectedState?.error && (
                  <NodeErrorPanel error={selectedState.error} paused={selectedState.status === "paused"} />
                )}
              </div>
            </div>
            <button
              ref={scrollBottomBtnRef}
              type="button"
              className="scroll-to-bottom-btn"
              onClick={scrollToBottom}
            >
              <ArrowDown size={14} />
              <span>{t("最新")}</span>
            </button>
            <motion.div
              className="pane-bottom-chat"
              initial={false}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
            >
              {followUpQueue && followUpQueue.length > 0 && (
                <div className="followup-queue-banner">
                  <div className="queue-info">
                    <Clock size={12} />
                    <span>{t("排队中 (")}{followUpQueue.length}): {followUpQueue[0].text.slice(0, 30)}...</span>
                  </div>
                  {onCancelFollowUp && (
                    <button
                      type="button"
                      className="queue-cancel-btn"
                      onClick={() => onCancelFollowUp(followUpQueue[0].id)}
                    >
                      {t("取消")}</button>
                  )}
                </div>
              )}
              <PromptBox
                key={composerKey}
                defaultValue={composerDrafts?.get(composerDraftKey) ?? ""}
                onChange={handleComposerChange}
                layoutId="conversation-composer"
                repository={config?.repository}
                runId={state.runId}
                node={conversationNode}
                onSubmit={handleSendMessageWithScroll}
                placeholder={nodeComposerDisabled ? "" : isSelectedNodeWorking || selectedMergerRunning ? t("Steer...") : t("Type...")}
                isExecuting={isSelectedNodeWorking}
                isWorking={isSelectedNodeWorking}
                onInterrupt={onInterrupt ? () => { restoreUncommittedSteerDrafts(selectedNode?.name); onInterrupt(selectedNode?.name); } : undefined}
                disabled={nodeComposerDisabled}
              />
            </motion.div>
          </div>
        ) : (
          <div className="initial-query-view">
            <div
              className={`initial-query-scroll ${isConversationReady ? "conversation-ready" : "conversation-preparing"}`}
              data-transcript-preparing={(!isConversationReady || initialFillPending) && !isUserScrolledUpRef.current ? "true" : undefined}
              data-transcript-following={!isUnrunNode && !isUserScrolledUpRef.current ? "true" : undefined}
              ref={chatScrollRef}
              onScroll={handleChatScroll}
              style={conversationRevealStyle}
            >
              <div
                className="chat-messages-stream"
                style={{ opacity: isConversationReady ? 1 : 0 }}
              >
                {routeType === "serial" ? (
                  <div className="serial-turns-container" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {serialTurns.map((turn, index) => {
                      const isWaitingExecution =
                        turn.executions.length === 0 && !turn.userMessage.executionId && !turn.userMessage.delivery &&
                        index === serialTurns.length - 1 &&
                        (isSerialWorking || isMainViewWorking || pendingRequest);

                      return (
                        <React.Fragment key={turn.id}>
                          {turn.userMessage && (
                            <motion.div
                              className={`chat-message-row user${turn.isInitial ? "" : " planner-follow-up"}`}
                              initial={isPlanning && turn.isInitial ? { opacity: 0 } : false}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                            >
                              <EditableUserBubble
                                text={turn.userMessage.text.trim()}
                                images={turn.userMessage.images}
                                files={turn.userMessage.files}
                                editing={editingMessage?.id === turn.userMessage.id}
                                draft={editPrefillText ?? ""}
                                onDraftChange={onEditPrefillTextChange ?? (() => { })}
                                onEdit={onEditMessage && turn.userMessage.delivery !== "node_messaged" ? () => onEditMessage(turn.userMessage!) : undefined}
                                onCancel={() => onCancelEditMessage?.()}
                                onSend={(value) => onEditMessageSubmit ? onEditMessageSubmit(turn.userMessage!, value) : onSendMessage(value)}
                                disabled={locked && !isPlanning}
                                versions={turn.userMessage.versions}
                                currentVersionIndex={turn.userMessage.currentVersionIndex}
                                onSwitchVersion={(idx) => onSwitchMessageVersion?.(turn.userMessage!, idx)}
                              />
                            </motion.div>
                          )}
                          {turn.steerMessages
                            ?.filter(steer => !turn.executions.some(exec => exec.id === steer.executionId))
                            .map(renderSteerBubble)}

                          {turn.isInitial && showRouteBadge && (
                            <motion.div
                              className="route-decision-pill serial"
                              initial={isPlanning ? { opacity: 0, scale: 0.96 } : false}
                              animate={{ opacity: 1, scale: 1 }}
                              transition={{ duration: isPlanning ? 0.25 : 0, ease: "easeOut" }}
                            >
                              <Compass size={13} />
                              <span>{t("任务路线决策：单节点执行")}</span>
                            </motion.div>
                          )}

                          {turn.executions.map((exec) => {
                            const ownedSteers = executionSteers(exec, turn.steerMessages ?? []);
                            const executionLiveSteers = liveSteers.filter(item => item.executionId === exec.id &&
                              ownedSteers.some(steer => inlineSteerKey(steer) === item.key));
                            const inlineSteerTexts = ownedSteers
                              .filter(message => exec.historyEndOffset !== undefined || canInlineSteerMessage(message) || executionLiveSteers.some(item => item.key === inlineSteerKey(message)))
                              .map(steer => nodeInstructionText(steer.text))
                              .filter(Boolean);
                            const fallbackSteers = exec.historyEndOffset !== undefined ? [] : ownedSteers.map(steer => ({
                              steer, position: steerFallbackPosition(steer, inlineUserTurns, exec.status === "running", true,
                                executionLiveSteers.find(item => item.key === inlineSteerKey(steer))),
                            }));
                            return (
                              <React.Fragment key={exec.id}>
                                {/* Pending steers share the conversation column so they keep the
                                    same 56px/20px rhythm as follow-up turns, whether they are
                                    waiting above or below the transcript they steer. */}
                                {fallbackSteers.filter(item => item.position === "before").map(item => renderSteerBubble(item.steer))}
                                <motion.div
                                  className="serial-execution-panel"
                                  initial={false}
                                  animate={{ opacity: 1 }}
                                  transition={{ duration: 0.15 }}
                                >
                                  <div style={{ display: "flex", flexDirection: "column", marginTop: 4 }}>
                                    <ExecutionTranscript
                                      key={exec.id}
                                      runId={state.runId}
                                      execution={exec}
                                      endOffset={exec.historyEndOffset}
                                      onUserResize={handleExpandableContentChange}
                                      onInitialOutputReady={handleExecutionOutputReady}
                                      onLoadingChange={(loading) => handleExecutionLoadingChange(exec.id, loading)}
                                      onCompactingChange={(compacting) => handleAttemptCompacting(exec.id, compacting)}
                                      inlineUserTurnTexts={inlineSteerTexts}
                                      liveSteers={executionLiveSteers}
                                      onEditUser={editInlineSteer(exec)}
                                      onInlineUserTurnsChange={(texts, complete, turns, end) => handleInlineUserTurns(exec.id, texts, complete, turns, end)}
                                    />
                                  </div>
                                </motion.div>
                                {fallbackSteers.filter(item => item.position === "after").map(item => renderSteerBubble(item.steer))}
                              </React.Fragment>
                            );
                          })}
                          {isWaitingExecution && (
                            <div className="serial-execution-panel" aria-hidden="true">
                              <div style={{ display: "flex", flexDirection: "column", marginTop: 4 }}>
                                <ExecutionTranscriptPlaceholder />
                              </div>
                            </div>
                          )}
                        </React.Fragment>
                      );
                    })}

                    <WorkspaceDetailsPanel
                      key={`${state.runId}:serial`}
                      open={detailsPanelOpen}
                      onToggle={() => toggleFooterPanel("details")}
                      showWorking={isMainViewWorking}
                      compacting={isMainViewWorking && !!serialExecution?.id && !!compactingAttempts[serialExecution.id]}
                      workingLabel={publicationWorkingLabel}
                      summaryAction={changesTrigger}
                      additionalDetails={changesPanel}
                      scrollContainerRef={chatScrollRef}
                      onBeforeToggle={handleWorkspaceDetailsBeforeToggle}
                      onAfterToggle={handleWorkspaceDetailsAfterToggle}
                    >
                      <p>Workspace: {serialExecution?.worktree || config.repository || repoInfo?.name || "preparing workspace…"}</p>
                      <p>Session id: {serialExecution?.sessionId || "waiting for initialization…"}</p>
                      <div className="session-details-row">
                        <p>Start time: {formatSessionStartTime(serialSession.startedAt ?? serialExecution?.startedAt)}</p>
                        <p>Time took: <ExecutionTimeTookText execution={serialExecution} priorDurationSeconds={serialSession.priorDurationSeconds} /></p>
                      </div>
                      {serialModelInfo && (
                        <div className="session-details-row">
                          <p>Model: {serialModelInfo.model}</p>
                          <p>Thinking level: {serialModelInfo.thinkingLevel}</p>
                        </div>
                      )}
                      {serialRetryModelInfo && (
                        <div className="session-details-row">
                          <p>{t("重试时使用的模型：{0}", serialRetryModelInfo.model)}</p>
                          <p>{t("重试时使用的思维等级：{0}", serialRetryModelInfo.thinkingLevel)}</p>
                        </div>
                      )}
                      {(showSerialTokenUsage || serialContext) && (
                        <SessionTokenUsage usage={serialUsage} context={serialContext}
                          showTokens={showSerialTokenUsage} />
                      )}
                    </WorkspaceDetailsPanel>
                  </div>
                ) : (
                  <>
                    {plannerMessages.length > 0 && (
                      <motion.div
                        key={plannerMessages[0].id}
                        className={`chat-message-row ${plannerMessages[0].role}`}
                        initial={false}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                      >
                        {plannerMessages[0].role === "user" ? (
                          <EditableUserBubble
                            text={plannerMessages[0].text.trim()}
                            images={plannerMessages[0].images}
                            files={plannerMessages[0].files}
                            editing={editingMessage?.id === plannerMessages[0].id}
                            draft={editPrefillText ?? ""}
                            onDraftChange={onEditPrefillTextChange ?? (() => { })}
                            onEdit={onEditMessage ? () => onEditMessage(plannerMessages[0]) : undefined}
                            onCancel={() => onCancelEditMessage?.()}
                            onSend={(value) => onEditMessageSubmit ? onEditMessageSubmit(plannerMessages[0], value) : onSendMessage(value)}
                            disabled={locked && !isPlanning}
                            versions={plannerMessages[0].versions}
                            currentVersionIndex={plannerMessages[0].currentVersionIndex}
                            onSwitchVersion={(idx) => onSwitchMessageVersion?.(plannerMessages[0], idx)}
                          />
                        ) : (
                          <div className={`chat-bubble-${plannerMessages[0].role} chat-message-${plannerMessages[0].role}`}>
                            <MarkdownRenderer content={plannerMessages[0].text} />
                          </div>
                        )}
                      </motion.div>
                    )}

                    {/* 任务路线决策结果或评估中加载状态 */}
                    {((isPlanning && effectiveRouteType === "undecided") || (showRouteBadge && effectiveRouteType !== "undecided")) && (
                      <motion.div
                        className={`route-decision-pill ${effectiveRouteType}`}
                        initial={isPlanning ? { opacity: 0, scale: 0.96, y: 10 } : false}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        transition={{ duration: isPlanning ? 0.42 : 0, ease: [0.16, 1, 0.3, 1] }}
                      >
                        {effectiveRouteType === "undecided" ? (
                          <>
                            <Loader2 size={13} className="spin" />
                            <span>{t("正在评估任务路线决策...")}</span>
                          </>
                        ) : (
                          <>
                            <Compass size={13} />
                            <span>{t("任务路线决策：多节点依赖拓扑图架构")}</span>
                          </>
                        )}
                      </motion.div>
                    )}

                    {/* 历史保存的规划活动记录（如重新加载或未被活动流完全覆盖时） */}
                    {savedPlannerIds.length > 0 && (
                      <div style={!useSavedPlanner ? { display: "none" } : undefined}>
                        <PlanningActivity
                          key={savedPlannerKey}
                          runId={transcriptRunId}
                          planningIds={savedPlannerIds}
                          showUserTurns={savedPlannerShowsUserTurns}
                          skipFirstUser={plannerMessages.length > 0 && skipFirstPersistedTurn}
                          running={plannerActivityRunning}
                          livePlanningId={livePlanningId}
                          dividerSources={reviewPlannerIds}
                          sourceUserFallbacks={plannerSourceFallbacks}
                          rowHeights={plannerRowHeightsRef.current}
                          restoreAnchor={conversationScrollStateRef.current.get(conversationViewKey)?.anchor}
                          onRestoreScroll={updatePlannerRestoredScroll}
                          onCompactingChange={setPlannerHistoryCompacting}
                          onLoadingChange={setPlannerHistoryLoading}
                          onReady={() => {
                            setReadySavedPlannerKey(savedPlannerKey);
                            if (!isConversationReady) revealConversation();
                          }}
                          onOutputChange={(text) => setSavedPlannerRecord(previous =>
                            previous.key === savedPlannerKey && previous.text === text ? previous : { key: savedPlannerKey, text })}
                          onUserResize={handleExpandableContentChange}
                          edits={plannerEdits}
                          onEditUser={onEditMessageSubmit ? (text, replacement) =>
                            onEditMessageSubmit({
                              id: `planner-history-${text}`, role: "user", parentId: null,
                              text, runId: state.runId
                            }, replacement) : undefined}
                        />
                      </div>
                    )}

                    {/* 保留当前对话中的跟进消息；实时流已有同一消息时不重复渲染。 */}
                    {plannerMessages.slice(1).filter((msg) => {
                      if (msg.plannerSteerId) return false; // Rendered in the pending area or its exact Pi turn.
                      if (useSavedPlanner && savedPlannerShowsUserTurns && plannerMessageSources.has(msg.id)) return false;
                      if (msg.node && msg.node !== "planner") return false;
                      if (renderLivePlanner && plannerStream.items?.some((item: TranscriptItem) =>
                        item.role === "user" && item.id === msg.id)) return false;
                      // Keep an acknowledged steer visible across navigation
                      // until its turn actually appears in JSONL (start or end).
                      if (useSavedPlanner && savedPlannerShowsUserTurns) {
                        const text = msg.text.trim();
                        const count = remainingPersistedTurns.get(text) ?? 0;
                        if (count > 0) {
                          remainingPersistedTurns.set(text, count - 1);
                          return false;
                        }
                      }
                      return true;
                    }).map((msg) => (
                      <AnimatedUserTurn id={msg.id} animateAppear={msg.animateAppear}
                        className="chat-message-row user planner-follow-up" key={msg.id}>
                        <EditableUserBubble
                          text={msg.text.trim()}
                          images={msg.images}
                          files={msg.files}
                          editing={editingMessage?.id === msg.id}
                          draft={editPrefillText ?? ""}
                          onDraftChange={onEditPrefillTextChange ?? (() => { })}
                          onEdit={onEditMessage ? () => onEditMessage(msg) : undefined}
                          onCancel={() => onCancelEditMessage?.()}
                          onSend={(value) => onEditMessageSubmit ? onEditMessageSubmit(msg, value) : onSendMessage(value)}
                          disabled={locked && !isPlanning}
                          versions={msg.versions}
                          currentVersionIndex={msg.currentVersionIndex}
                          onSwitchVersion={(idx) => onSwitchMessageVersion?.(msg, idx)}
                        />
                      </AnimatedUserTurn>
                    ))}

                    {/* Planner 顺序流式记录：严格按实际发生时序呈现用户追加消息、工具调用、思维链与输出文字 */}
                    {renderLivePlanner && livePlannerItems.length > 0 ? (
                      <PlannerTranscript items={displayedLivePlannerItems} isPlanning={isPlanning} locked={locked}
                        editingMessage={editingMessage} draft={editPrefillText ?? ""}
                        onDraftChange={onEditPrefillTextChange ?? (() => { })} onEditMessage={onEditMessage}
                        onCancelEdit={onCancelEditMessage} onEditSubmit={onEditMessageSubmit}
                        onSendMessage={onSendMessage} onUserResize={handleExpandableContentChange} />
                    ) : (
                      renderLivePlanner && (plannerStream.plannerThinking || plannerStream.plannerText) && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {plannerStream.plannerThinking && (
                            <ThinkingCard
                              content={plannerStream.plannerThinking}
                              isStreaming={isPlanning && plannerStream.plannerThinkingActive}
                              title="Chain of Thought"
                              defaultExpanded={true}
                              autoExpandWhileStreaming={true}
                              animateAppear={false}
                              onExpandedChange={handleExpandableContentChange}
                            />
                          )}
                          {plannerStream.plannerText && (
                            <motion.div
                              className="chat-message-row assistant"
                              initial={false}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                            >
                              <div className="chat-bubble-assistant chat-message-assistant">
                                <StreamingAssistantBubble content={plannerStream.plannerText} isStreaming={isPlanning} />
                              </div>
                            </motion.div>
                          )}
                        </div>
                      )
                    )}
                    {pendingPlannerSteers.length > 0 && <div className="planner-steer-list" aria-label={t("Planner 待处理消息")} aria-live="polite">
                      {pendingPlannerSteers.map(row => {
                        // An older backend cannot echo the identity marker. If
                        // its replay already shows the same text, keep the
                        // uncertainty notice without adding a second bubble;
                        // text overlap is never treated as consumption proof.
                        const legacyOverlap = row.status === "unknown" && !state.events.some(event => event.request_id === row.id) &&
                          useSavedPlanner && savedPlannerShowsUserTurns && persistedUserTurns.filter(text => text === row.message.text.trim()).length === 1 &&
                          plannerMessages.filter(message => message.plannerSteerId && message.text.trim() === row.message.text.trim()).length === 1;
                        return <div className={`planner-steer-entry ${row.status}`} key={row.id}>
                          {legacyOverlap ? <div className="planner-steer-state">{t("未确认的消息：{0}", row.message.text.trim())}</div> :
                            <div className="chat-message-row user planner-steer-message">
                              <EditableUserBubble text={row.message.text.trim()} images={row.message.images} files={row.message.files}
                                editing={false} draft="" onDraftChange={() => {}} onCancel={() => {}} onSend={() => false} />
                            </div>}
                          <div className="planner-steer-state">{plannerSteerLabel(row)}</div>
                        </div>;
                      })}
                    </div>}
                  </>
                )}
                {showPlannerDetails && (
                  <WorkspaceDetailsPanel
                    key={`${state.runId}:planner`}
                    open={detailsPanelOpen}
                    onToggle={() => toggleFooterPanel("details")}
                    label={t("规划会话信息")}
                    showWorking={isMainViewWorking}
                    compacting={isMainViewCompacting}
                    workingLabel={publicationWorkingLabel}
                    summaryAction={changesTrigger}
                    additionalDetails={changesPanel}
                    scrollContainerRef={chatScrollRef}
                    onBeforeToggle={handleWorkspaceDetailsBeforeToggle}
                    onAfterToggle={handleWorkspaceDetailsAfterToggle}
                  >
                    <p>Workspace: {plannerWorkspace || config.repository || "preparing workspace…"}</p>
                    <div className="session-details-row">
                      <p>Start time: {formatSessionStartTime(plannerStartTime)}</p>
                      <p>Time took: <PlannerTimeTookText isPlanning={isPlanning} startedAt={plannerLiveTurnStart} durationSeconds={plannerRole?.durationSeconds} priorDurationSeconds={plannerSession.priorDurationSeconds} /></p>
                    </div>
                    <div className="session-details-row">
                      <p>Model: {plannerModelInfo.model}</p>
                      <p>Thinking level: {plannerModelInfo.thinkingLevel}</p>
                    </div>
                    {(showPlannerTokenUsage || displayedPlannerContext) && (
                      <SessionTokenUsage usage={plannerUsage} context={displayedPlannerContext}
                        showTokens={showPlannerTokenUsage} />
                    )}
                  </WorkspaceDetailsPanel>
                )}
              </div>

              {/* 规划失败提示 */}
              {failedPlanning && !isPlanning && (failedPlanning.error || failedPlanning.status === "failed") && (
                <div
                  ref={failureNoticeRef}
                  className="planning-error-notice"
                  style={{
                    margin: "10px auto",
                    maxWidth: 860,
                    width: "calc(100% - 36px)",
                    boxSizing: "border-box",
                    padding: "8px 12px",
                    background: "#ffffff",
                    borderRadius: 8,
                    color: "#b91c1c",
                    fontSize: 12,
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 6,
                    border: "1px solid #fca5a5",
                    boxShadow: "0 1px 4px rgba(239, 68, 68, 0.08)",
                  }}
                >
                  <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1, color: "#ef4444" }} />
                  <span>{t("规划未通过：")}{localizeError(failedPlanning.error || t("规划阶段异常中断"))}</span>
                </div>
              )}

              {routeType === "graph" && (state.graph.nodes.length > 0 || hasCompletedPublication) && (
                <div className={`planner-result-cards${hidePlannerResultCards ? " is-hidden" : ""}`}
                  aria-hidden={hidePlannerResultCards || undefined}
                  inert={hidePlannerResultCards ? true : undefined}>
                  <div className="planner-result-cards-inner">{plannerResultCards}</div>
                </div>
              )}
            </div>
            <button
              ref={scrollBottomBtnRef}
              type="button"
              className="scroll-to-bottom-btn"
              onClick={scrollToBottom}
            >
              <ArrowDown size={14} />
              <span>{t("最新")}</span>
            </button>
            <motion.div
              className="pane-bottom-chat"
              initial={false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.48, ease: [0.16, 1, 0.3, 1] }}
            >
              {followUpQueue && followUpQueue.length > 0 && (
                <div className="followup-queue-banner">
                  <div className="queue-info">
                    <Clock size={12} />
                    <span>{t("排队中 (")}{followUpQueue.length}): {followUpQueue[0].text.slice(0, 30)}...</span>
                  </div>
                  {onCancelFollowUp && (
                    <button
                      type="button"
                      className="queue-cancel-btn"
                      onClick={() => onCancelFollowUp(followUpQueue[0].id)}
                    >
                      {t("取消")}</button>
                  )}
                </div>
              )}
              <PromptBox
                key={composerKey}
                defaultValue={composerDrafts?.get(composerDraftKey) ?? ""}
                onChange={handleComposerChange}
                layoutId="conversation-composer"
                repository={config?.repository}
                runId={state.runId}
                node={isSerialExecution ? state.graph.nodes[0]?.name : undefined}
                onSubmit={handleSendMessageWithScroll}
                placeholder={mainComposerDisabled ? "" : isMainViewWorking ? t("Steer...") : t("Type...")}
                isExecuting={isMainViewWorking}
                isWorking={isMainViewWorking}
                onInterrupt={onInterrupt ? () => { restoreUncommittedSteerDrafts(); onInterrupt(); } : undefined}
                disabled={mainComposerDisabled}
              />
            </motion.div>
          </div>
        )}
      </motion.div>

      {hasGraphPane && graphPaneCollapsed && (
        <button
          type="button"
          className="graph-pane-expand"
          ref={focusGraphPaneToggle}
          aria-label={t("展开执行拓扑图")}
          aria-expanded={false}
          onClick={expandGraphPane}
        >
          <ChevronLeft size={18} strokeWidth={1.6} aria-hidden="true" />
        </button>
      )}

      {graphMenu && createPortal(
        <div className="context-menu" role="menu" style={{
          left: Math.max(0, Math.min(graphMenu.x, window.innerWidth - 180)),
          top: Math.max(0, Math.min(graphMenu.y, window.innerHeight - 50)),
        }} onClick={event => event.stopPropagation()}>
          <button type="button" role="menuitem" className="context-menu-item"
            disabled={!state.runId || state.runId.startsWith("pending-") || locked || isPlanning || publishing || publicationFailed
              || state.phase === "followup" || state.phase === "launching_result" || (state.mergers ?? []).some(merger => merger.status === "running")
              || (!state.approved && !["awaiting_approval", "rejected"].includes(state.phase))}
            onClick={() => {
              setGraphMenu(null);
              creationRunRef.current = state.runId;
              setSelected("");
              setSelectedMergerId("");
              setCreatingNode(true);
              setNarrowGraphVisible(false);
            }}>
            <Plus size={14} /><span>{t("新建节点")}</span>
          </button>
        </div>, document.body,
      )}
      <AnimatePresence mode="wait" onExitComplete={() => {
        setGraphPane(current => current.collapsed ? { ...current, generation: current.generation + 1 } : current);
      }}>
        {showGraphPane && (
          <GraphPanePresence key={graphViewportKey}>
            <motion.div
              className={`workbench-resizer ${isResizing ? "active" : ""}`}
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.45, ease: [0.22, 1, 0.36, 1] }}
              ref={setGraphResizerRef}
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label={t("调整执行拓扑图宽度")}
              aria-description={t("左右拖动调整宽度，继续向右拖动可收起；双击恢复默认，Enter 收起")}
              aria-valuenow={Math.round((1 - splitRatio) * 100)}
              onPointerDown={handleStartResize}
              onKeyDown={handleResizeKeyDown}
              onDoubleClick={handleResetResizer}
            >
              <div className="resizer-handle" />
            </motion.div>

            <div className="graph-pane-aperture">
            <motion.div
              ref={graphPaneRef}
              className="graph-pane"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.45, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="graph-toolbar">
                <div className="toolbar-left">
                  <Workflow size={15} />
                  <strong>{t("执行拓扑图")}</strong>
                </div>
                <div className="toolbar-right">
                  <button
                    type="button"
                    className="icon-button"
                    title={t("编辑 Graph IR")}
                    onClick={onOpenEditor}
                  >
                    <Code2 size={16} />
                  </button>
                </div>
              </div>

              <div className="graph-canvas" ref={graphCanvasRef}>
                <GraphCanvas runKey={graphViewportKey} ready={isGraphReadyForRun}
                  nodes={animatedNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} tokens={tokens}
                  onInit={centerGraph} onSelect={selectGraphNode} onLayout={synchronizeGraph} onFitStart={manualGraphFit} onPaneContextMenu={openGraphMenu} />

                {state.graph.nodes.length > 0 && (
                  <motion.div
                    className="graph-note"
                    initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <span className="note-line" />{t("依赖前进")}<span className="note-line feedback" />{t("执行反馈")}</motion.div>
                )}
              </div>

              {state.graph.nodes.length > 0 && (
                // Fade the footer itself in when the first node opens the pane.
                // Opacity only: a transform here would move the pinned geometry
                // the resize and short-window tests measure against the workbench.
                <motion.div
                  className="graph-bottom"
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.22, 1, 0.36, 1] }}
                >
                  <div className="progress-label">
                    <FooterProgressLabel token={String(completed)} disabled={reduceMotion}>
                      <span className="progress-dot" />
                      {completed} / {state.graph.nodes.length}{t(" 节点完成")}</FooterProgressLabel>
                  </div>
                  <div className="progress-track">
                    <motion.div
                      initial={reduceMotion ? false : { width: 0 }}
                      animate={{ width: `${(completed / Math.max(1, state.graph.nodes.length)) * 100}%` }}
                      transition={{ duration: reduceMotion ? 0 : 0.5, ease: [0.22, 1, 0.36, 1] }}
                    />
                  </div>

                  <div className="approval-row">
                    <FooterStatusLabel
                      token={footerStatusKey}
                      disabled={reduceMotion}
                      title={publicationTarget ? `${t("目标目录：")}${publicationTarget}` : undefined}
                    >
                      {activityStatus ? (
                        <><span className="progress-dot" />{activityStatus}</>
                      ) : publicationFailedNow ? (
                        <><AlertCircle size={12} aria-hidden="true" />{t("回写失败，需要处理")}</>
                      ) : publicationWorking ? (
                        <><Loader2 size={12} className="spin" aria-hidden="true" />{graphPhase === "merging" || publicationStatus === "merging" ? t("merger 正在修复冲突") : t("正在写回工作文件夹")}</>
                      ) : graphPhase === "planning" ? t("规划中")
                        : graphPhase === "running" ? t("确定性运行时正在推进")
                          : graphPhase === "followup" ? t("源目录直改中（无快照）")
                            : graphPhase === "needs_attention" ? t("执行已停止，请检查失败或阻塞节点")
                              : graphPhase === "pausing" ? t("正在停止运行中的节点…")
                                : graphPhase === "paused" ? (resumingPausedWork
                                  ? (hasOtherFailures ? t("继续将先恢复暂停的任务；其他失败节点可稍后重试。") : t("执行已暂停，点击继续可恢复"))
                                  : t("执行已停止，点击继续恢复失败节点（不会追加消息）"))
                                  : graphPhase === "completed" ? t("运行已完成 - 本次消耗 Token:{0} Cached:{1}",
                                    // Task tokens exclude cache reads but include
                                    // one-time cache writes; reasoning is inside
                                    // output. The percentage is the prompt cache-hit rate.
                                    formatTokenCount(consumedTokenCount(state.runMetrics?.totalUsage)),
                                    formatCacheHitRate(state.runMetrics?.totalUsage))
                                    : state.approved ? phaseText[graphPhase] ?? graphPhase : ""}
                    </FooterStatusLabel>
                    <FooterControlsGroup token={footerControlKey} disabled={reduceMotion}>
                      {publicationFailedNow ? (
                        <button key="retry-publication-btn" type="button" className="primary" disabled={locked} onClick={() => onControl("retry_publication")}>
                          {t("重试回写")}
                        </button>
                      ) : graphPhase === "awaiting_approval" ? (
                        <>
                          <button key="reject-btn" type="button" className="text-button" disabled={locked} onClick={() => onControl("reject")}>
                            Reject
                          </button>
                          <button key="approve-btn" type="button" className="primary" disabled={locked} onClick={onOpenApproval}>
                            <Play size={13} fill="currentColor" />Approve
                          </button>
                        </>
                      ) : state.approved && !publicationWorking ? (
                        <button
                          key="execution-control-btn"
                          type="button"
                          className="primary"
                          // A settled run with nothing running or paused has no
                          // pause/resume semantics: pausing is a no-op and the
                          // following 继续 would just un-pause it without
                          // continuing any node. The backend recovery hint
                          // identifies failed attempts that Continue can retry.
                          disabled={locked || controlPending !== null || publishing || publicationFailed || (state.phase === "completed" && !canContinue) || graphPhase === "pausing"
                            || (graphPhase === "needs_attention" && !canContinue)}
                          title={graphPhase === "needs_attention" && !canContinue ? t("执行已停止；请在失败节点的对话中发送介入指令以继续") : undefined}
                          onClick={() => {
                            const action = canContinue ? "resume" : "pause";
                            if (action === "pause") restoreUncommittedSteerDrafts();
                            setControlPending(action);
                            onControl(action);
                          }}
                        >
                          {controlPending ? <Loader2 size={13} className="spin" /> : canContinue ? <Play size={13} /> : <Pause size={13} />}
                          {controlPending === "pause" || graphPhase === "pausing" ? t("正在暂停")
                            : controlPending === "resume" ? t("正在继续")
                              : canContinue ? t("继续") : t("暂停")}
                        </button>
                      ) : null}
                    </FooterControlsGroup>
                  </div>
                  {publicationErrorText && (
                    <motion.p
                      className="publication-failure"
                      role="alert"
                      initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={footerMotion}
                    >{localizeError(publicationErrorText)}</motion.p>
                  )}
                </motion.div>
              )}
            </motion.div>
            </div>
          </GraphPanePresence>
        )}
      </AnimatePresence>
    </section>
  );
});

GraphWorkbench.displayName = "GraphWorkbench";
