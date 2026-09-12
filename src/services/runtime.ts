import { isTauri, invoke } from "@tauri-apps/api/core";
import {
  Bootstrap,
  Config,
  defaultConfig,
  example,
  Execution,
  Graph,
  GraphEvent,
  NodeState,
  Plan,
  RepositoryInfo,
  Snapshot,
} from "../types";

export interface Diagnostic {
  code: string;
  message: string;
}

export const isDesktop = isTauri();
export const isMac =
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X/.test(navigator.userAgent);
export const isDesktopMac = isDesktop && isMac;

// ==========================================
// 纯客户端 DAG 编译器 (与 Rust 规则 100% 严格一致)
// ==========================================

export function compileClientGraph(
  graph: Graph,
  finalCheck = true
): { plan?: Plan; diagnostics?: Diagnostic[] } {
  const errors: Diagnostic[] = [];
  const add = (code: string, message: string) => {
    errors.push({ code, message });
  };

  if (finalCheck && graph.nodes.length === 0) {
    add("E001", "Graph must contain at least one node");
  }
  if (graph.nodes.length > 64) {
    add("E002", "MVP supports at most 64 nodes");
  }

  const names = new Set<string>();
  for (const node of graph.nodes) {
    if (
      !node.name ||
      node.name.length > 64 ||
      !/^[a-zA-Z0-9_-]+$/.test(node.name)
    ) {
      add(
        "E201",
        `Invalid semantic node name: ${node.name}. Use letters, digits, _ or -`
      );
    }
    if (names.has(node.name)) {
      add("E202", `Duplicate node: ${node.name}`);
    }
    names.add(node.name);

    if (!node.task || node.task.trim().length === 0) {
      add("E203", `Empty task: ${node.name}`);
    }
  }

  const pairs = new Set<string>();
  for (const edge of graph.edges) {
    if (!names.has(edge.from) || !names.has(edge.to)) {
      add("E204", `Unknown node in ${edge.from} → ${edge.to}`);
    }
    if (edge.from === edge.to) {
      add("E205", `Self edge is not allowed: ${edge.from}`);
    }
    const pairKey = `${edge.from}→${edge.to}`;
    if (pairs.has(pairKey)) {
      add("E206", `Duplicate edge: ${edge.from} → ${edge.to}`);
    }
    pairs.add(pairKey);
  }

  if (errors.length > 0) {
    return { diagnostics: errors };
  }

  // 拓扑分析 (过滤 feedback 边)
  const dependencies = graph.edges.filter((e) => !e.feedback);
  const degrees = new Map<string, number>();
  for (const name of names) {
    degrees.set(name, 0);
  }
  for (const edge of dependencies) {
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
  }

  const roots = Array.from(names).filter((n) => (degrees.get(n) ?? 0) === 0).sort();
  const terminals = Array.from(names)
    .filter((n) => !dependencies.some((e) => e.from === n))
    .sort();

  // Kahn 算法计算分层波次与检测环路
  const batches: string[][] = [];
  const inDegree = new Map<string, number>(degrees);
  let available = Array.from(names).filter((n) => inDegree.get(n) === 0).sort();
  let visitedCount = 0;

  while (available.length > 0) {
    batches.push(available);
    visitedCount += available.length;
    const nextAvailable: string[] = [];

    for (const node of available) {
      for (const edge of dependencies.filter((e) => e.from === node)) {
        const cur = inDegree.get(edge.to) ?? 0;
        inDegree.set(edge.to, cur - 1);
        if (cur - 1 === 0) {
          nextAvailable.push(edge.to);
        }
      }
    }
    available = nextAvailable.sort();
  }

  if (visitedCount < names.size) {
    const cycleCandidates = Array.from(names).filter(
      (n) => (inDegree.get(n) ?? 0) > 0
    );
    add(
      "E207",
      `Dependency cycle detected among nodes: ${cycleCandidates.join(", ")}`
    );
  }

  // 检验 feedback 边：目标必须在非 feedback 依赖图中是源的祖先
  const getAncestors = (start: string): Set<string> => {
    const ancestors = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const edge of dependencies.filter((e) => e.to === cur)) {
        if (!ancestors.has(edge.from)) {
          ancestors.add(edge.from);
          queue.push(edge.from);
        }
      }
    }
    return ancestors;
  };

  for (const edge of graph.edges.filter((e) => e.feedback)) {
    const ancestors = getAncestors(edge.from);
    if (!ancestors.has(edge.to)) {
      add(
        "E209",
        `Feedback edge ${edge.from} → ${edge.to} is meaningless because ${edge.to} is not an ancestor of ${edge.from}`
      );
    }
  }

  if (errors.length > 0) {
    return { diagnostics: errors };
  }

  const warnings: string[] = [];
  if (roots.length > 1) {
    warnings.push(`Multiple execution roots: ${roots.join(", ")}`);
  }
  if (terminals.length > 1) {
    warnings.push(`Multiple terminals: ${terminals.join(", ")}`);
  }
  const isolated = roots.filter((r) => terminals.includes(r) && names.size > 1);
  if (isolated.length > 0) {
    warnings.push(`Isolated nodes without dependencies: ${isolated.join(", ")}`);
  }

  return {
    plan: {
      executionBatches: batches,
      roots,
      terminals,
      warnings,
    },
    diagnostics: [],
  };
}

// ==========================================
// Web 纯前端交互模拟器 (Web Sandbox Driver)
// ==========================================

const WEB_STORAGE_KEY = "grapher_web_sandbox_snapshot";
const WEB_HISTORY_KEY = "grapher_web_sandbox_history";

class WebInteractiveRuntime {
  private snapshotState: Snapshot;
  private configState: Config;
  private timer: any = null;
  private listeners: Set<(s: Snapshot) => void> = new Set();
  private reviewRound = 0;

  constructor() {
    this.configState = {
      repository: "/sandbox/grapher-web",
      engine: "sandbox",
      piCommand: "pi",
      piArgs: [],
      model: "claude-3-5-sonnet",
      maxParallel: 2,
      maxFeedback: 3,
    };

    const initialPlan = compileClientGraph(example, true).plan ?? null;
    const initialNodes: Record<string, NodeState> = {};
    for (const n of example.nodes) {
      initialNodes[n.name] = {
        status: "waiting",
        revision: 1,
        head: null,
        instruction: "",
        error: null,
      };
    }

    this.snapshotState = {
      runId: "web-" + Math.random().toString(36).slice(2, 10),
      graph: JSON.parse(JSON.stringify(example)),
      config: this.configState,
      plan: initialPlan,
      nodes: initialNodes,
      executions: [],
      events: [
        {
          sequence: 1,
          timestamp: Date.now() - 5000,
          type: "web_session_initialized",
        },
      ],
      approved: false,
      paused: false,
      phase: "awaiting_approval",
      base: "main",
      feedbackCounts: {},
    };

    this.loadFromStorage();
  }

  private loadFromStorage() {
    try {
      const saved = localStorage.getItem(WEB_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.graph && parsed.nodes) {
          this.snapshotState = parsed;
        }
      }
    } catch {
      // ignore
    }
  }

  private saveToStorage() {
    try {
      localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(this.snapshotState));
      const historyJson = localStorage.getItem(WEB_HISTORY_KEY);
      const historyMap: Record<string, Snapshot> = historyJson
        ? JSON.parse(historyJson)
        : {};
      if (this.snapshotState.runId) {
        historyMap[this.snapshotState.runId] = this.snapshotState;
        localStorage.setItem(WEB_HISTORY_KEY, JSON.stringify(historyMap));
      }
    } catch {
      // ignore
    }
  }

  public subscribe(listener: (s: Snapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.saveToStorage();
    for (const fn of this.listeners) {
      fn(this.getSnapshot());
    }
  }

  public getSnapshot(): Snapshot {
    return JSON.parse(JSON.stringify(this.snapshotState));
  }

  public async bootstrap(): Promise<Bootstrap> {
    const historyJson = localStorage.getItem(WEB_HISTORY_KEY);
    const historyMap: Record<string, Snapshot> = historyJson
      ? JSON.parse(historyJson)
      : {};
    const runs = Object.keys(historyMap);
    if (!runs.includes(this.snapshotState.runId)) {
      runs.unshift(this.snapshotState.runId);
    }

    const repoInfo: RepositoryInfo = {
      path: "/sandbox/grapher-web",
      name: "grapher-web",
      branch: "main",
      head: "a1b2c3d",
      clean: true,
    };

    return {
      snapshot: this.getSnapshot(),
      config: this.configState,
      runs,
      dataPath: "浏览器内存沙箱 (Web Interactive Storage)",
      repositoryInfo: repoInfo,
    };
  }

  public async history(runId: string): Promise<Snapshot> {
    const historyJson = localStorage.getItem(WEB_HISTORY_KEY);
    const historyMap: Record<string, Snapshot> = historyJson
      ? JSON.parse(historyJson)
      : {};
    if (historyMap[runId]) {
      return historyMap[runId];
    }
    return this.getSnapshot();
  }

  public async clearHistory(): Promise<void> {
    localStorage.removeItem(WEB_HISTORY_KEY);
  }

  public async deleteRun(runId: string): Promise<void> {
    try {
      const historyJson = localStorage.getItem(WEB_HISTORY_KEY);
      if (historyJson) {
        const historyMap: Record<string, Snapshot> = JSON.parse(historyJson);
        delete historyMap[runId];
        localStorage.setItem(WEB_HISTORY_KEY, JSON.stringify(historyMap));
      }
    } catch {
      // ignore
    }
  }

  public async resetWorkspace(): Promise<Snapshot> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.reviewRound = 0;
    const initialPlan = compileClientGraph(example, true).plan ?? null;
    const initialNodes: Record<string, NodeState> = {};
    for (const n of example.nodes) {
      initialNodes[n.name] = {
        status: "waiting",
        revision: 1,
        head: null,
        instruction: "",
        error: null,
      };
    }

    this.snapshotState = {
      runId: "web-" + Math.random().toString(36).slice(2, 10),
      graph: JSON.parse(JSON.stringify(example)),
      config: this.configState,
      plan: initialPlan,
      nodes: initialNodes,
      executions: [],
      events: [
        {
          sequence: 1,
          timestamp: Date.now(),
          type: "workspace_reset",
        },
      ],
      approved: false,
      paused: false,
      phase: "awaiting_approval",
      base: "main",
      feedbackCounts: {},
    };
    this.notify();
    return this.getSnapshot();
  }

  public async saveGraph(graph: Graph, config: Config): Promise<Snapshot> {
    const result = compileClientGraph(graph, true);
    if (result.diagnostics && result.diagnostics.length > 0) {
      throw new Error(result.diagnostics[0].message);
    }
    this.configState = config;
    const nodes: Record<string, NodeState> = {};
    for (const n of graph.nodes) {
      nodes[n.name] = {
        status: "waiting",
        revision: 1,
        head: null,
        instruction: "",
        error: null,
      };
    }
    this.snapshotState = {
      runId: "web-" + Math.random().toString(36).slice(2, 10),
      graph: JSON.parse(JSON.stringify(graph)),
      config,
      plan: result.plan ?? null,
      nodes,
      executions: [],
      events: [
        {
          sequence: 1,
          timestamp: Date.now(),
          type: "graph_saved",
        },
      ],
      approved: false,
      paused: false,
      phase: "awaiting_approval",
      base: "main",
      feedbackCounts: {},
    };
    this.notify();
    return this.getSnapshot();
  }

  public async planGoal(goal: string, config: Config): Promise<Snapshot> {
    if (!goal.trim()) {
      throw new Error("请输入具体目标");
    }
    // 智能分解目标
    let generatedGraph: Graph;
    const lower = goal.toLowerCase();
    if (
      lower.includes("fix") ||
      lower.includes("修") ||
      lower.includes("单") ||
      goal.length < 10
    ) {
      generatedGraph = {
        originalGoal: goal,
        nodes: [{ name: "task", task: goal }],
        edges: [],
      };
    } else {
      generatedGraph = {
        originalGoal: goal,
        nodes: [
          { name: "spec_plan", task: `针对目标「${goal}」制定实现方案与架构规范` },
          { name: "core_impl", task: "实现核心业务逻辑与数据模型交互" },
          { name: "ui_adapter", task: "开发用户交互界面与视图状态流" },
          { name: "qa_verify", task: "执行单元测试复核与交付验收" },
        ],
        edges: [
          { from: "spec_plan", to: "core_impl", relation: "方案输入", feedback: false },
          { from: "spec_plan", to: "ui_adapter", relation: "方案输入", feedback: false },
          { from: "core_impl", to: "qa_verify", relation: "提交验收", feedback: false },
          { from: "ui_adapter", to: "qa_verify", relation: "提交验收", feedback: false },
          { from: "qa_verify", to: "core_impl", relation: "缺陷审查反馈", feedback: true },
        ],
      };
    }

    return this.saveGraph(generatedGraph, config);
  }

  public async control(
    action: string,
    options?: { node?: string; instruction?: string }
  ): Promise<Snapshot> {
    switch (action) {
      case "approve":
        this.snapshotState.approved = true;
        this.snapshotState.paused = false;
        this.snapshotState.phase = "running";
        this.appendEvent({ type: "approval" });
        this.notify();
        this.startSimulationStep();
        break;

      case "pause":
        this.snapshotState.paused = true;
        this.appendEvent({ type: "paused" });
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        this.notify();
        break;

      case "resume":
        this.snapshotState.paused = false;
        this.appendEvent({ type: "resumed" });
        this.notify();
        this.startSimulationStep();
        break;

      case "reject":
        this.snapshotState.approved = false;
        this.snapshotState.phase = "draft";
        this.appendEvent({ type: "rejected" });
        this.notify();
        break;

      case "intervene":
        if (options?.node && this.snapshotState.nodes[options.node]) {
          const nodeName = options.node;
          const nodeState = this.snapshotState.nodes[nodeName];
          nodeState.revision += 1;
          nodeState.instruction = options.instruction || "";
          nodeState.status = "waiting";
          this.appendEvent({
            type: "intervened",
            node: nodeName,
            instruction: options.instruction,
            human: true,
          });
          this.notify();
          this.startSimulationStep();
        }
        break;

      case "resolve":
        if (options?.node && this.snapshotState.nodes[options.node]) {
          this.snapshotState.nodes[options.node].status = "waiting";
          this.appendEvent({
            type: "conflict_resolved",
            node: options.node,
          });
          this.notify();
          this.startSimulationStep();
        }
        break;

      default:
        break;
    }

    return this.getSnapshot();
  }

  private appendEvent(event: Partial<GraphEvent>) {
    const seq = this.snapshotState.events.length + 1;
    this.snapshotState.events.push({
      sequence: seq,
      timestamp: Date.now(),
      type: event.type || "custom",
      ...event,
    } as GraphEvent);
  }

  // 模拟真实的分波次并行调度与 Review 回路
  private startSimulationStep() {
    if (this.timer || this.snapshotState.paused || !this.snapshotState.approved) {
      return;
    }

    const { nodes, plan } = this.snapshotState;
    if (!plan) return;

    // 寻找下一个可以运行的批次
    let runnableNode: string | null = null;

    for (const batch of plan.executionBatches) {
      const allWaitingOrDone = batch.every(
        (n) => nodes[n].status === "done" || nodes[n].status === "waiting" || nodes[n].status === "running"
      );
      if (allWaitingOrDone) {
        const nextInBatch = batch.find((n) => nodes[n].status === "waiting");
        if (nextInBatch) {
          runnableNode = nextInBatch;
          break;
        }
      }
    }

    if (!runnableNode) {
      // 检查是否全部节点已完成
      const allDone = Object.values(nodes).every((n) => n.status === "done");
      if (allDone) {
        this.snapshotState.phase = "completed";
        this.appendEvent({ type: "run_completed" });
        this.notify();
      }
      return;
    }

    const targetNode = runnableNode;
    nodes[targetNode].status = "running";
    const execId = "exec-" + Math.random().toString(36).slice(2, 8);
    const attempt = (this.snapshotState.feedbackCounts[targetNode] || 0) + 1;
    const isReviewer = this.snapshotState.graph.edges.some(
      (e) => e.from === targetNode && e.feedback
    );

    const exec: Execution = {
      id: execId,
      node: targetNode,
      revision: nodes[targetNode].revision,
      attempt,
      sessionId: `pi-session-${Math.floor(Math.random() * 900 + 100)}`,
      worktree: `/sandbox/worktrees/${this.snapshotState.runId}/${targetNode}`,
      before: "main",
      after: null,
      status: "running",
      output: `[sandbox] Fresh execution for ${targetNode}\n[read] Inspecting isolated workspace\n`,
      startedAt: Date.now(),
      completedAt: null,
    };
    this.snapshotState.executions.push(exec);
    this.appendEvent({
      type: "node_started",
      node: targetNode,
      execution: exec,
    });
    this.notify();

    // 模拟节点异步运行
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.snapshotState.paused) return;

      const finishExec = this.snapshotState.executions.find(
        (e) => e.id === execId
      );

      if (isReviewer && this.reviewRound === 0) {
        // 第一轮 Review：返回 <REVISE>
        this.reviewRound += 1;
        const out =
          "Sandbox verification: add an empty-state message for review check.\n<REVISE>";
        if (finishExec) {
          finishExec.output += `[assistant] ${out}\n`;
          finishExec.status = "completed";
          finishExec.after = "c0ffee_rev1";
          finishExec.completedAt = Date.now();
        }
        nodes[targetNode].status = "waiting";

        // 触发反馈重跑依赖节点
        const feedbackEdge = this.snapshotState.graph.edges.find(
          (e) => e.from === targetNode && e.feedback
        );
        if (feedbackEdge) {
          const targetToRetry = feedbackEdge.to;
          if (nodes[targetToRetry]) {
            nodes[targetToRetry].status = "waiting";
            nodes[targetToRetry].revision += 1;
            this.snapshotState.feedbackCounts[targetToRetry] =
              (this.snapshotState.feedbackCounts[targetToRetry] || 0) + 1;
          }
        }
        this.snapshotState.feedbackCounts[targetNode] =
          (this.snapshotState.feedbackCounts[targetNode] || 0) + 1;

        this.appendEvent({
          type: "feedback_received",
          from: targetNode,
          accepted: false,
          execution: finishExec,
        });
        this.notify();
        this.startSimulationStep();
      } else {
        // 成功通过 / 普通节点完成
        const out = isReviewer
          ? "Sandbox verification passed.\n<ACCEPT>"
          : `Implemented task for ${targetNode} in isolated workspace.\nExecution finished.`;
        if (finishExec) {
          finishExec.output += `[assistant] ${out}\n`;
          finishExec.status = "completed";
          finishExec.after = "c0ffee_" + Math.random().toString(36).slice(2, 8);
          finishExec.completedAt = Date.now();
        }
        nodes[targetNode].status = "done";
        nodes[targetNode].head = finishExec?.after ?? "c0ffee";

        this.appendEvent({
          type: "node_completed",
          node: targetNode,
          execution: finishExec,
        });
        this.notify();
        this.startSimulationStep();
      }
    }, 900);
  }

  public async pickRepository(): Promise<RepositoryInfo | null> {
    return {
      path: "/sandbox/grapher-web",
      name: "grapher-web",
      branch: "main",
      head: "a1b2c3d",
      clean: true,
    };
  }

  public async detectRepository(path?: string | null): Promise<RepositoryInfo | null> {
    return {
      path: path || "/sandbox/grapher-web",
      name: (path ? path.split("/").pop() : "grapher-web") || "grapher-web",
      branch: "main",
      head: "a1b2c3d",
      clean: true,
    };
  }
}

// 单例实例
const webRuntimeInstance = new WebInteractiveRuntime();

// ==========================================
// 统一服务导出 (Desktop & Web 自动分流)
// ==========================================

export const runtimeService = {
  isDesktop,
  isMac,
  isDesktopMac,

  async bootstrap(): Promise<Bootstrap> {
    if (isDesktop) {
      return invoke<Bootstrap>("bootstrap");
    }
    return webRuntimeInstance.bootstrap();
  },

  async snapshot(): Promise<Snapshot> {
    if (isDesktop) {
      return invoke<Snapshot>("snapshot");
    }
    return webRuntimeInstance.getSnapshot();
  },

  async history(runId: string): Promise<Snapshot> {
    if (isDesktop) {
      return invoke<Snapshot>("history", { runId });
    }
    return webRuntimeInstance.history(runId);
  },

  async compileGraph(graph: Graph): Promise<Plan> {
    if (isDesktop) {
      return invoke<Plan>("compile_graph", { graph });
    }
    const res = compileClientGraph(graph, true);
    if (res.diagnostics && res.diagnostics.length > 0) {
      throw new Error(res.diagnostics[0].message);
    }
    return res.plan!;
  },

  async saveGraph(graph: Graph, config: Config): Promise<Snapshot> {
    if (isDesktop) {
      return invoke<Snapshot>("save_graph", { graph, config });
    }
    return webRuntimeInstance.saveGraph(graph, config);
  },

  async planGoal(goal: string, config: Config): Promise<Snapshot> {
    if (isDesktop) {
      return invoke<Snapshot>("plan_goal", { goal, config });
    }
    return webRuntimeInstance.planGoal(goal, config);
  },

  async control(action: string, extra?: Record<string, any>): Promise<Snapshot> {
    if (isDesktop) {
      return invoke<Snapshot>("control", { action, ...extra });
    }
    return webRuntimeInstance.control(action, extra);
  },

  async detectRepository(path?: string | null): Promise<RepositoryInfo | null> {
    if (isDesktop) {
      return invoke<RepositoryInfo | null>("detect_repository", { path: path || null });
    }
    return webRuntimeInstance.detectRepository(path);
  },

  async pickRepository(): Promise<RepositoryInfo | null> {
    if (isDesktop) {
      return invoke<RepositoryInfo | null>("pick_repository");
    }
    return webRuntimeInstance.pickRepository();
  },

  async resetWorkspace(): Promise<Snapshot> {
    if (isDesktop) {
      return invoke<Snapshot>("reset_workspace");
    }
    return webRuntimeInstance.resetWorkspace();
  },

  async clearHistory(): Promise<void> {
    if (isDesktop) {
      return invoke("clear_history");
    }
    return webRuntimeInstance.clearHistory();
  },

  async deleteRun(runId: string): Promise<void> {
    if (isDesktop) {
      return invoke("delete_run", { runId });
    }
    return webRuntimeInstance.deleteRun(runId);
  },

  onWebUpdate(listener: (s: Snapshot) => void) {
    if (!isDesktop) {
      return webRuntimeInstance.subscribe(listener);
    }
    return () => {};
  },
};
