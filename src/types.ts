export type Status = "waiting" | "running" | "blocked" | "done" | "failed" | "dirty";
export interface GraphNode { name: string; task: string }
export interface GraphEdge { from: string; to: string; relation: string; feedback: boolean }
export interface Graph { originalGoal: string; nodes: GraphNode[]; edges: GraphEdge[] }
export interface Plan { executionBatches: string[][]; roots: string[]; terminals: string[]; warnings: string[] }
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface Config { repository: string; model: string; thinkingLevel: ThinkingLevel; maxParallel: number; maxFeedback: number }
export interface NodeState { status: Status; revision: number; head: string | null; instruction: string; error: string | null }
export interface Execution { id: string; node: string; revision: number; attempt: number; sessionId: string; worktree: string; before: string; after: string | null; status: string; output: string; outputBytes?: number; pid?: number | null; startedAt: number; completedAt: number | null }
export interface GraphEvent { sequence: number; timestamp: number; type: string; node?: string; from?: string; to?: string; accepted?: boolean; error?: string; execution?: Execution; instruction?: string; target?: string; execution_id?: string; human?: boolean }
export interface Publication { repository: string; heads: string[]; status: "publishing" | "merging" | "completed" | "failed"; head: string | null; error: string | null; startedAt: number; completedAt: number | null }
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
}

export interface PlanningRoleMetrics {
  model: string;
  sessionStart?: string;
  lastEvent?: string;
  durationSeconds: number;
  assistantMessages: number;
  tools: number;
  toolErrors: number;
  usage: TokenUsage;
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
}

export interface Snapshot {
  runId: string;
  planType?: "serial" | "graph";
  planningId?: string;
  planning?: PlanningSummary | null;
  graph: Graph;
  config: Config | null;
  plan: Plan | null;
  nodes: Record<string, NodeState>;
  executions: Execution[];
  mergers?: Execution[];
  publication?: Publication | null;
  events: GraphEvent[];
  approved: boolean;
  paused: boolean;
  phase: string;
  base: string;
  feedbackCounts: Record<string, number>;
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

export interface Bootstrap {
  snapshot: Snapshot;
  config: Config;
  runs: string[];
  dataPath: string;
  repositoryInfo?: RepositoryInfo | null;
  effectiveRoleModels?: Record<string, string>;
  envOverrides?: Record<string, string>;
}

export const emptyGraph: Graph = { originalGoal: "", nodes: [], edges: [] };
export const defaultConfig: Config = { repository: "", model: "", thinkingLevel: "medium", maxParallel: 4, maxFeedback: 3 };
export const emptySnapshot: Snapshot = {
  runId: "", graph: emptyGraph, config: null, plan: null,
  nodes: {}, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {},
};

export const example: Graph = {
  originalGoal: "为当前项目实现工作图自动化编译与多节点协作执行",
  nodes: [
    { name: "api_spec", task: "确定系统模块契约与核心数据结构规范" },
    { name: "frontend", task: "构建交互界面与可视化执行拓扑视图" },
    { name: "backend", task: "实现确定性状态机与沙箱运行时调度" },
    { name: "qa_review", task: "执行端到端自动化测试与缺陷复核" },
  ],
  edges: [
    { from: "api_spec", to: "frontend", relation: "契约输入", feedback: false },
    { from: "api_spec", to: "backend", relation: "契约输入", feedback: false },
    { from: "frontend", to: "qa_review", relation: "提交验收", feedback: false },
    { from: "backend", to: "qa_review", relation: "提交验收", feedback: false },
    { from: "qa_review", to: "frontend", relation: "缺陷重构反馈", feedback: true },
  ],
};

export type PlanRouteType = "undecided" | "serial" | "graph";
export type PlanMode = "auto" | "serial" | "graph";

export interface ChatMessage {
  id: string;
  parentId?: string | null;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
  runId?: string;
  node?: string;
}

export interface PlanStreamEvent {
  type: "partitioner" | "route_decision" | "planner" | "complete" | "error";
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
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, any>;
  result?: string;
  isError?: boolean;
  status?: "running" | "success" | "error";
  exitCode?: number | null;
  truncated?: boolean;
  timestamp?: number;
}

