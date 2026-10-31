import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { GraphWorkbench } from "../../src/components/views/GraphWorkbench";
import { defaultConfig, emptySnapshot, publicationMergerCardId, type ChatMessage, type Execution, type Snapshot, type PlanningSummary, type SessionContext, type TokenUsage } from "../../src/types";
import { tokens } from "../../src/tokens";
import "../../src/styles.css";
import "../../src/styles-workbench.css";
import "../../src/styles-planning.css";

const audit = ((window as any).audit = {});
const config = { ...defaultConfig, repository: "/mock", model: "test/model" };
const params = new URLSearchParams(location.search);
const mode = params.get("mode");
const planner = mode === "planner";
const merger = mode === "merger" || mode === "node-merger";
const graph = mode === "graph" || planner || merger;
const followUp = params.get("turn") === "follow-up";
const provisional = params.get("turn") === "provisional";
const execution = (id: string, status: string, outputBytes: number): Execution => ({
  id, node: "task", status, output: "", outputBytes, revision: 0, attempt: id === "previous" ? 1 : followUp ? 2 : 1,
  startedAt: 1, completedAt: status === "running" ? null : 2,
  sessionId: "session", worktree: "/mock", before: "", after: "",
});
const noop = () => {};
// Stand-in for the engine's model catalog: the backend resolves a session's
// window from the model that ran, so the fixture does the same for one model.
const modelWindows: Record<string, number> = { "test/model": 100_000 };
const zeroUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, consumedTokens: 0 });
const emptyRunMetrics = (): NonNullable<Snapshot["runMetrics"]> => ({
  totalDurationSeconds: 0, planningDurationSeconds: 0, executionDurationSeconds: 0,
  assistantMessages: 0, tools: 0, toolErrors: 0,
  totalUsage: zeroUsage(), planningUsage: zeroUsage(), executionUsage: zeroUsage(),
});

function WorkspaceFooterFixture() {
  const [plannerTurns, setPlannerTurns] = useState<PlanningSummary[]>(planner ? [{
    planningId: "source-turn", roles: {}, totalPlanningDuration: 0, modelDuration: 0, worktree: "/mock",
  }] : []);
  audit.selectMerger = (id: string) => setMergerId(id);
  audit.selectPlannerWorkspace = (worktree: string) => setPlannerTurns(previous => [...previous, {
    planningId: `turn-${previous.length}`, roles: {}, totalPlanningDuration: 0, modelDuration: 0, worktree,
  }]);
  const [hasNode, setHasNode] = useState(!provisional);
  const [hasRunId, setHasRunId] = useState(!provisional);
  const [planning, setPlanning] = useState(provisional);
  const [executions, setExecutions] = useState<Execution[]>(followUp ? [execution("previous", "completed", 0)] : []);
  const [messages, setMessages] = useState<ChatMessage[]>([{ id: "initial", role: "user", text: "Initial task" }]);
  const [pending, setPending] = useState(!followUp);
  const [status, setStatus] = useState<"completed" | "dirty" | "running">(followUp ? "completed" : "dirty");
  const [runPhase, setRunPhase] = useState<string>();
  const [runMetrics, setRunMetrics] = useState<Snapshot["runMetrics"]>();
  const [mergerId, setMergerId] = useState("");
  const [publication, setPublication] = useState<Snapshot["publication"]>();
  const [publicationMergers, setPublicationMergers] = useState<Execution[]>([]);
  audit.setPublicationResult = (result: Snapshot["publication"], attempts: Execution[] = []) => {
    setPublication(result);
    setPublicationMergers(attempts);
  };
  // Mirror the backend's per-session totals so a resumed session keeps the
  // usage of its earlier Executions instead of restarting on each attempt.
  const sessionUsage: Record<string, TokenUsage> = {};
  const addUsage = (sessionId: string | undefined, usage: TokenUsage | undefined) => {
    if (!sessionId || !usage) return;
    const bucket = sessionUsage[sessionId] ??= zeroUsage();
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const) {
      bucket[key] += usage[key] ?? 0;
    }
    bucket.consumedTokens = (bucket.consumedTokens ?? 0) + (usage.consumedTokens ?? 0);
  };
  const mergers = merger ? executions.map(item => ({ ...item, node: mode === "merger" ? "merger" : "merge:task" })) : [];
  for (const item of merger ? mergers : executions) addUsage(item.sessionId, item.metrics?.usage);
  for (const turn of plannerTurns) {
    for (const role of Object.values(turn.roles)) addUsage(role.sessionId, role.usage);
  }
  const hasSessionUsage = Object.keys(sessionUsage).length > 0;
  // Context is a snapshot, so the newest turn wins and only the peak accumulates.
  const sessionContext: Record<string, SessionContext> = {};
  const newestTurn = new Map<string, number>();
  const addContext = (sessionId: string | undefined, tokens: number, peak: number, stamp: number, model?: string) => {
    if (!sessionId || (!tokens && !peak)) return;
    const entry = sessionContext[sessionId] ??= { tokens: 0, peak: 0 };
    entry.peak = Math.max(entry.peak, peak, tokens);
    if (tokens > 0 && stamp >= (newestTurn.get(sessionId) ?? 0)) {
      entry.tokens = tokens;
      entry.window = modelWindows[model ?? config.model];
      newestTurn.set(sessionId, stamp);
    }
  };
  for (const item of mergers.length ? mergers : executions) {
    addContext(item.sessionId, item.metrics?.contextTokens ?? 0, item.metrics?.contextPeak ?? 0,
      item.completedAt ?? item.startedAt, item.metrics?.model);
  }
  for (const turn of plannerTurns) {
    for (const role of Object.values(turn.roles)) {
      addContext(role.sessionId, role.contextTokens ?? 0, role.contextPeak ?? 0, 0, role.model);
    }
  }
  const hasSessionData = hasSessionUsage || Object.keys(sessionContext).length > 0;
  const state: Snapshot = { ...emptySnapshot, runId: hasRunId ? "footer-run" : "pending-footer-run", config,
    phase: runPhase ?? (hasNode ? "running" : "draft"), approved: hasNode,
    // Keep an explicit null from the footer audit so "unknown" stays unknown.
    runMetrics: runMetrics === undefined
      ? (hasSessionData ? { ...emptyRunMetrics(), sessionUsage, sessionContext } : undefined)
      : runMetrics === null ? null : { ...runMetrics, sessionUsage, sessionContext },
    planType: graph ? "graph" : "serial",
    graph: { originalGoal: "Initial task", nodes: hasNode ? [{ name: "task", task: "Initial task" }] : [], edges: [] },
    nodes: hasNode ? { task: { status, revision: 0, instruction: "", error: null } } : {},
    executions: merger ? [] : executions,
    mergers: [...mergers, ...publicationMergers],
    publication,
    planning: plannerTurns.at(-1),
    events: plannerTurns.map((planning, index) => ({ type: "planner_workspace_selected", sequence: index + 1, timestamp: index + 1, planning })),
  };
  audit.confirmRun = () => setHasRunId(true);
  audit.createNode = () => { setHasNode(true); setPlanning(false); };
  audit.send = () => {
    setMessages(previous => [...previous, { id: "follow-up", role: "user", text: "Follow-up task", node: "task", runId: "footer-run" }]);
    setPending(true);
    setStatus("dirty");
  };
  audit.startExecution = (bytes = 0) => {
    setExecutions(previous => [...previous, execution("current", "running", bytes)]);
    setHasNode(true);
    setPlanning(false);
    setPending(false);
    setStatus("running");
  };
  audit.finish = () => {
    setExecutions(previous => previous.map(item => ({ ...item, status: "completed", completedAt: 2 })));
    setStatus("completed");
  };
  audit.setExecutionMetrics = (metrics: Execution["metrics"], id = "current") => setExecutions(previous =>
    previous.map(item => item.id === id ? { ...item, metrics } : item));
  audit.setExecutionTiming = (id: string, startedAt: number, completedAt: number | null) => setExecutions(previous =>
    previous.map(item => item.id === id ? { ...item, startedAt, completedAt } : item));
  audit.setPlannerRoles = (roles: PlanningSummary["roles"], index = -1) => setPlannerTurns(previous =>
    previous.map((turn, i) => i === (index < 0 ? previous.length - 1 : index) ? { ...turn, roles } : turn));
  audit.setRunSummary = (phase: string, metrics: Snapshot["runMetrics"]) => {
    setRunPhase(phase);
    setRunMetrics(metrics);
  };
  return <div style={{ height: 800, display: "flex" }}>
    <GraphWorkbench state={state} routeType={graph ? "graph" : "serial"} initialPlanMode={graph ? "graph" : "serial"}
      selected={mode === "merger" ? publicationMergerCardId : mode === "node-merger" ? "merger:task" : graph && !planner ? "task" : ""}
      setSelected={noop} selectedMergerId={mergerId} setSelectedMergerId={setMergerId}
      effectiveMessages={messages} isPlanning={planning} plannerStream={{ items: [] }} onSendMessage={noop} onRequestConfirmation={noop}
      onControl={noop} onSave={noop} onOpenEditor={noop} onOpenApproval={noop} onOpenFile={noop} repoInfo={null} config={config}
      active={status !== "completed"} locked={false} pendingRequest={pending} publishing={false} publicationFailed={false}
      nodes={[]} edges={[]} nodeTypes={{}} edgeTypes={{}} tokens={tokens} />
  </div>;
}

createRoot(document.getElementById("root")!).render(<WorkspaceFooterFixture />);
