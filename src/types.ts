export type Status = "waiting" | "running" | "blocked" | "done" | "failed" | "dirty";
export interface GraphNode { name: string; task: string }
export interface GraphEdge { from: string; to: string; relation: string; feedback: boolean }
export interface Graph { originalGoal: string; nodes: GraphNode[]; edges: GraphEdge[] }
export interface Plan { executionBatches: string[][]; roots: string[]; terminals: string[]; warnings: string[] }
export interface Config { repository: string; engine: "demo" | "pi"; piCommand: string; piArgs: string[]; model: string; maxParallel: number; maxFeedback: number }
export interface NodeState { status: Status; revision: number; head: string | null; instruction: string; error: string | null }
export interface Execution { id: string; node: string; revision: number; attempt: number; sessionId: string; worktree: string; before: string; after: string | null; status: string; output: string; startedAt: number; completedAt: number | null }
export interface GraphEvent { sequence: number; timestamp: number; type: string; node?: string; from?: string; to?: string; accepted?: boolean; error?: string; execution?: Execution }
export interface Snapshot { runId: string; graph: Graph; config: Config | null; plan: Plan | null; nodes: Record<string, NodeState>; executions: Execution[]; events: GraphEvent[]; approved: boolean; paused: boolean; phase: string; base: string; feedbackCounts: Record<string, number> }
export interface Bootstrap { snapshot: Snapshot; config: Config; runs: string[]; dataPath: string }

export const example: Graph = {
  originalGoal: "实现一个反馈收集页面：前后端可独立开发，最后验证并修复问题。",
  nodes: [
    { name: "api_spec", task: "Define a minimal feedback submission API contract in API.md: fields, validation, endpoints, and response shapes. Keep the contract self-contained for frontend and backend implementers." },
    { name: "frontend", task: "Implement a minimal feedback form using the contract in API.md. Own only frontend/ files. Include loading, error, empty, and success states. Do not edit backend/ or shared configuration." },
    { name: "backend", task: "Implement the feedback API defined in API.md with validation and local persistence. Own only backend/ files. Include local run instructions. Do not edit frontend/ or shared configuration." },
    { name: "qa_review", task: "Verify the frontend against API.md and the backend implementation. Run available checks. Accept only when the frontend submission and error paths match the contract. If the backend is broken, report that explicitly rather than claiming success." },
  ],
  edges: [
    { from: "api_spec", to: "frontend", relation: "implements the contract", feedback: false },
    { from: "api_spec", to: "backend", relation: "implements the contract", feedback: false },
    { from: "frontend", to: "qa_review", relation: "verifies the frontend", feedback: false },
    { from: "backend", to: "qa_review", relation: "provides the API workspace", feedback: false },
    { from: "qa_review", to: "frontend", relation: "requests a frontend revision", feedback: true },
  ],
};

export const defaultConfig: Config = { repository: "", engine: "demo", piCommand: "pi", piArgs: [], model: "", maxParallel: 2, maxFeedback: 3 };
export const preview: Snapshot = {
  runId: "", graph: example, config: null,
  plan: { executionBatches: [["api_spec"], ["frontend", "backend"], ["qa_review"]], roots: ["api_spec"], terminals: ["qa_review"], warnings: [] },
  nodes: Object.fromEntries(example.nodes.map((node) => [node.name, { status: "waiting", revision: 1, head: null, instruction: "", error: null }])),
  executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {},
};
