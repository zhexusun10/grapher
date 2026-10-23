import { t } from "./i18n/index.ts";
export type Status = "waiting" | "running" | "paused" | "blocked" | "completed" | "failed" | "dirty";
export interface GraphNode { name: string; task: string }
export interface GraphEdge { from: string; to: string; feedback: boolean }
export interface Graph { originalGoal: string; nodes: GraphNode[]; edges: GraphEdge[] }
export interface Plan { executionBatches: string[][]; roots: string[]; terminals: string[]; warnings: string[] }
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelRole = "partitioner" | "planner" | "nodeAgent";
export interface RoleModelConfig { model: string; thinkingLevel?: ThinkingLevel }
export interface Config { repository: string; model: string; thinkingLevel: ThinkingLevel; roleModels?: Partial<Record<ModelRole, RoleModelConfig>>; maxParallel: number; maxFeedback: number; autoApprove: boolean; postTaskReview?: boolean; plannerWriteTools?: boolean }
export interface ConversationModelConfig { model: string; thinkingLevel: ThinkingLevel; roleModels?: Partial<Record<ModelRole, RoleModelConfig>> }
interface NodeState { status: Status; revision: number; head: string | null; instruction: string; error: string | null; modelConfig?: RoleModelConfig; pendingMessages?: Array<{ sequence: number; instruction: string; images?: ImageAttachment[] | null }> }
export interface FeedbackExhaustion { from: string; to: string; count: number; limit: number }
interface ExecutionMetrics {
  durationSeconds: number;
  assistantMessages: number;
  tools: number;
  toolErrors: number;
  usage: TokenUsage;
  /** Prompt size of the last assistant message, and its high-water mark. */
  contextTokens?: number;
  contextPeak?: number;
  /** Actual model/thinking this Execution's Pi session selected. */
  model?: string;
  thinkingLevel?: string;
}

interface RunMetrics {
  totalDurationSeconds: number;
  planningDurationSeconds: number;
  executionDurationSeconds: number;
  assistantMessages: number;
  tools: number;
  toolErrors: number;
  totalUsage: TokenUsage;
  planningUsage: TokenUsage;
  executionUsage: TokenUsage;
  /** Context the session held on its newest turn, keyed by session ID. */
  sessionContext?: Record<string, SessionContext>;
  /** Cumulative usage per Pi session, keyed by session ID. */
  sessionUsage?: Record<string, TokenUsage>;
}

/** Context is a per-turn snapshot: `peak` is its high-water mark. */
export interface SessionContext {
  tokens: number;
  peak: number;
  /** Window of the model that turn used, when the backend knows it. */
  window?: number;
}

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChangeItem {
  path: string;
  oldPath?: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  isRunning?: boolean;
  nodes?: string[];
  executionIds?: string[];
  source?: "git" | "write" | "edit" | "bash";
}

export interface FileChangeSummary {
  files: FileChangeItem[];
  totalFiles: number;
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  renamedCount: number;
  totalAdditions: number;
  totalDeletions: number;
  isRunning?: boolean;
  activeFilePath?: string;
}

export interface Execution { id: string; node: string; revision: number; attempt: number; sessionId: string; worktree: string; before: string; after: string | null; status: string; output: string; outputBytes?: number; pid?: number | null; startedAt: number; completedAt: number | null; metrics?: ExecutionMetrics | null; fileChanges?: FileChangeSummary | null }
export interface GraphEvent { sequence: number; timestamp: number; type: string; node?: string; nodes?: string[]; from?: string; to?: string; accepted?: boolean; count?: number; limit?: number; error?: string; execution?: Pick<Execution, "id" | "node">; instruction?: string; images?: ImageAttachment[]; target?: string; execution_id?: string; requested_node?: string; actual_node?: string; reason?: string; message_sequences?: number[]; from_execution_id?: string; from_event_sequence?: number; old_instruction?: string; first_turn?: boolean; selected_version?: number; human?: boolean; planning_id?: string; planning?: PlanningSummary; plan_type?: string; planType?: string }
export interface Publication { repository: string; heads: string[]; status: "publishing" | "merging" | "completed" | "failed"; head: string | null; error: string | null; startedAt: number; completedAt: number | null }
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  /** Uncached input + cache writes + output; absent on legacy snapshots. */
  consumedTokens?: number;
}

export interface PlanningRoleMetrics {
  model: string;
  /** Pi session this role process wrote to; the Planner keeps one per Run. */
  sessionId?: string;
  sessionStart?: string;
  lastEvent?: string;
  durationSeconds: number;
  assistantMessages: number;
  tools: number;
  toolErrors: number;
  usage: TokenUsage;
  /** Prompt size of this turn's last assistant message, and its peak. */
  contextTokens?: number;
  contextPeak?: number;
}

export interface PlanningSummary {
  planningId: string;
  roles: Record<string, PlanningRoleMetrics>;
  totalPlanningDuration: number;
  modelDuration: number;
  status?: string;
  error?: string;
  createdAt?: number;
  repository?: string;
  worktree?: string;
  workspaceExecutionId?: string;
  planType?: PlanRouteType;
  goal?: string;
  runId?: string;
}

export interface SkillItem {
  name: string;
  description: string;
  path: string;
  scope: "workspace" | "global" | "builtin";
}

export interface Snapshot {
  runId: string;
  planType?: "serial" | "graph";
  planningId?: string;
  planning?: PlanningSummary | null;
  graph: Graph;
  config: Config | null;
  /** Conversation-scoped model selection; absence means use creation settings. */
  modelConfig?: ConversationModelConfig | null;
  plan: Plan | null;
  nodes: Record<string, NodeState>;
  executions: Execution[];
  supersededExecutionIds?: string[];
  mergers?: Execution[];
  publication?: Publication | null;
  events: GraphEvent[];
  approved: boolean;
  paused: boolean;
  /** Backend hint for interrupted work or failed nodes with explicitly updated models. */
  canResume?: boolean;
  stopRequested?: boolean;
  phase: string;
  base: string;
  feedbackCounts: Record<string, number>;
  runMetrics?: RunMetrics | null;
  fileChanges?: FileChangeSummary | null;
  /** Backend omits `fileChanges` from the snapshot; the browser fetches them
   * on demand through `get_file_changes` instead of shipping tens of MiB. */
  fileChangesOmitted?: boolean;
}

/** Transient backend progress outside durable Run state. */
export interface RuntimeActivity {
  kind: "source_capture" | "workspace_prepare" | string;
  nodes: string[];
  /** Optional finer-grained step of a long operation (compose/conflict/verify/copy). */
  phase?: string;
}
export interface RepositoryInfo {
  path: string;
  name: string;
  branch: string;
  head: string;
  clean: boolean;
  isShadow?: boolean;
}

export interface ProjectItem {
  id: string;
  name: string;
  path: string;
  branch: string;
  clean: boolean;
  lastOpened: number;
  isShadow?: boolean;
}

export interface ConversationSummary {
  runId: string;
  repository: string;
  title: string;
  planType?: string | null;
  /** Older summary-capable backends may not supply status yet. */
  phase?: string;
  hasActiveExecutions?: boolean;
}

export interface Bootstrap {
  /** Omitted by older backends, settings saves, or when the index is unavailable. */
  conversations?: ConversationSummary[];
  unavailableConversationIds?: string[];
  snapshot: Snapshot;
  config: Config;
  runs: string[];
  dataPath: string;
  repositoryInfo?: RepositoryInfo | null;
  effectiveRoleModels?: Record<string, string>;
  envOverrides?: Record<string, string>;
}

export const emptyGraph: Graph = { originalGoal: "", nodes: [], edges: [] };
export const defaultConfig: Config = { repository: "", model: "", thinkingLevel: "low", maxParallel: 0, maxFeedback: 3, autoApprove: false, postTaskReview: true, plannerWriteTools: false };
export const emptySnapshot: Snapshot = {
  runId: "", graph: emptyGraph, config: null, plan: null,
  nodes: {}, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {},
};

/** Synthetic topology-card identity for the publication (source write-back) Merger. */
export const publicationMergerCardId = "merger:publication";

export const example: Graph = {
  originalGoal: t("为当前项目实现工作图自动化编译与多节点协作执行"),
  nodes: [
    { name: "api_spec", task: t("确定系统模块契约与核心数据结构规范") },
    { name: "frontend", task: t("构建交互界面与可视化执行拓扑视图") },
    { name: "backend", task: t("实现确定性状态机与沙箱运行时调度") },
    { name: "qa_review", task: t("执行端到端自动化测试与缺陷复核") },
  ],
  edges: [
    { from: "api_spec", to: "frontend", feedback: false },
    { from: "api_spec", to: "backend", feedback: false },
    { from: "frontend", to: "qa_review", feedback: false },
    { from: "backend", to: "qa_review", feedback: false },
    { from: "qa_review", to: "frontend", feedback: true },
  ],
};

export type PlanRouteType = "undecided" | "serial" | "graph";
export type PlanMode = "auto" | "serial" | "graph";

export interface ImageAttachment {
  type: "image";
  mimeType: string;
  data: string; // Base64 encoded string
  name?: string;
}

export interface FileAttachment {
  name: string;
  size?: number;
  type?: string;
  content?: string;
}

export interface ChatMessageVersion {
  id: string;
  text: string;
  images?: ImageAttachment[];
  files?: FileAttachment[];
  timestamp: number;
  executionId?: string;
  subsequentEntries?: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  parentId?: string | null;
  role: "user" | "assistant";
  text: string;
  images?: ImageAttachment[];
  files?: FileAttachment[];
  timestamp?: number;
  runId?: string;
  node?: string;
  executionId?: string;
  /** A durable turn that has not yet been claimed by an execution. */
  pendingExecution?: boolean;
  delivery?: "node_messaged" | "steered";
  versions?: ChatMessageVersion[];
  currentVersionIndex?: number;
  /** A just-sent or just-appended turn; one-shot entrance animation only. */
  animateAppear?: boolean;
}

export interface PlanStreamEvent {
  type: "run_started" | "partitioner" | "route_decision" | "planner" | "complete" | "error";
  runId?: string;
  raw?: string;
  event?: any;
  planType?: "serial" | "graph";
  snapshot?: Snapshot;
  error?: string;
  planningId?: string;
  summary?: PlanningSummary;
}

export interface TranscriptItem {
  id: string;
  type: "text" | "thinking" | "tool_call" | "system";
  role?: "user" | "assistant" | "system";
  content?: string;
  // Native reasoning block identity, scoped to its assistant message.
  thinkingContentIndex?: number;
  // Raw stdout is displayed as text but is not assistant RPC stream content.
  rawOutput?: boolean;
  // Runtime's plain-text final-response fallback, not a second model message.
  // Absolute provenance lets older-page parsing retire only its matching copy.
  finalResponseCopy?: { source: string; offset: number };
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, any>;
  /** Display preview only: `write`/`edit` arguments can carry whole file bodies. */
  argsTruncated?: boolean;
  result?: string;
  isError?: boolean;
  status?: "running" | "success" | "error" | "interrupted";
  exitCode?: number | null;
  truncated?: boolean;
  // Monotonic tool duration measured by the runtime (Pi) and relayed by the
  // backend: `tool_execution_end.durationMs`, or the `toolResult` message field.
  durationMs?: number;
  timestamp?: number;
  defaultExpanded?: boolean;
  // Presentation provenance: replay timestamps alone do not make history new.
  animateAppear?: boolean;
}

