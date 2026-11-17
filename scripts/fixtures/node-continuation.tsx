import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { GraphWorkbench } from "../../src/components/views/GraphWorkbench";
import { defaultConfig, emptySnapshot, type Snapshot } from "../../src/types";
import { tokens } from "../../src/tokens";
import "../../src/styles.css";
import "../../src/styles-workbench.css";
import "../../src/styles-planning.css";

const config = { ...defaultConfig, repository: "/mock", model: "test/model" };
function Fixture() {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode");
  const [completionPhase, setCompletionPhase] = useState(params.get("finalize"));
  const finalizing = completionPhase === "snapshot" || completionPhase === "environment";
  const completed = completionPhase === "completed";
  const planner = mode === "planner";
  const publicationMerger = mode === "publication-merger" || mode === "publication-main";
  const nodeMerger = mode === "node-merger";
  const mergerMode = publicationMerger || nodeMerger;
  const [mergerStatus, setMergerStatus] = useState(params.get("mergerStatus") || "failed");
  const mergerRunning = mergerMode && mergerStatus === "running";
  const [paused, setPaused] = useState(params.get("paused") === "1");
  (window as any).nodeContinuationFixture = { setCompletionPhase, setMergerStatus, setPaused };
  const graph = mode === "graph" || planner || mergerMode;
  const [calls, setCalls] = useState<string[]>([]);
  // Resuming an existing workspace reports preparation without a copy phase.
  const activity = finalizing
    ? [{ kind: "node_finalize", nodes: [params.get("finalizeNode") || "task"], phase: completionPhase! }]
    : calls.some(call => call === "resume" || call === "resume_node:task")
      ? [{ kind: "workspace_prepare", nodes: ["task"] }] : [];
  const status = finalizing ? "running" : completed ? "completed" : "failed";
  const state = { ...emptySnapshot, runId: "resume-run", config,
    phase: finalizing ? "running" : completed ? "completed" : "needs_attention", approved: true, canResume: !finalizing && !completed,
    planType: graph ? "graph" : "serial", graph: { originalGoal: "Original task", nodes: [{ id: "task", task: "Original task" }], edges: [] },
    ...(planner ? { planning: { planningId: "failed-planner", runId: "resume-run", planType: "graph", status: "failed", error: "failed" } } : {}),
    nodes: { task: { status, canResume: !finalizing && !completed, revision: 0, instruction: "", error: status === "failed" ? "failure" : undefined } },
    executions: [{ id: "exec", node: "task", status, revision: 0, attempt: 1, output: "", startedAt: 1,
      completedAt: finalizing ? null : 2, sessionId: "session", worktree: "/mock", before: "", after: "" }] } as Snapshot;
  if (mergerMode) {
    const publicationFailed = publicationMerger && mergerStatus === "failed";
    state.phase = publicationMerger ? (mergerRunning ? "merging" : publicationFailed ? "publication_failed" : "completed")
      : mergerRunning ? "running" : paused ? "paused" : "needs_attention";
    state.paused = paused;
    state.canResume = nodeMerger && !mergerRunning;
    state.nodes.task.status = nodeMerger ? "blocked" : "completed";
    state.nodes.task.canResume = nodeMerger && !mergerRunning && !paused;
    state.executions[0].status = nodeMerger ? "failed" : "completed";
    if (nodeMerger && paused) {
      state.graph.nodes.push({ id: "sibling", task: "Completed independent task" });
      state.nodes.sibling = { status: "completed", revision: 0, head: null, instruction: "", error: null };
    }
    state.mergers = [{ ...state.executions[0], id: "merger-execution", node: publicationMerger ? "merger" : "merge:task",
      status: mergerStatus, sessionId: "merger-session", completedAt: mergerRunning ? null : 2 }];
    if (publicationMerger) state.publication = {
      repository: "/mock", heads: ["head"], status: mergerRunning ? "merging" : publicationFailed ? "failed" : "completed",
      head: null, error: publicationFailed ? "Publication interrupted" : null, startedAt: 1, completedAt: null,
    };
  }
  const selected = mode === "publication-main" || planner ? "" : publicationMerger ? "merger:publication" : nodeMerger ? "merger:task" : graph ? "task" : "";
  const noop = () => {};
  return <><output data-testid="calls">{calls.join("|")}</output>
    <div style={{ height: 800, display: "flex" }}><GraphWorkbench state={state} activity={activity} routeType={graph ? "graph" : "serial"}
      selected={selected} setSelected={noop} selectedMergerId={mergerMode && mode !== "publication-main" ? "merger-execution" : ""} setSelectedMergerId={noop}
      effectiveMessages={[{ id: "initial", role: "user", text: "Original task" }]} isPlanning={false} plannerStream={{ items: [] }}
      onSendMessage={text => { setCalls(previous => [...previous, `send:${text}`]); return true; }}
      onContinuePlanner={() => setCalls(previous => [...previous, "resume_planner"])}
      onRequestConfirmation={noop} onControl={(action, extra) => setCalls(previous => [...previous, extra?.node ? `${action}:${extra.node}` : action])}
      onSave={noop} onOpenEditor={noop} onOpenApproval={noop} onOpenFile={noop}
      repoInfo={null} config={config} active={finalizing || mergerRunning} locked={false} pendingRequest={false}
      publishing={publicationMerger && mergerRunning} publicationFailed={publicationMerger && mergerStatus === "failed"}
      nodes={[]} edges={[]} nodeTypes={{}} edgeTypes={{}} tokens={tokens} /></div></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
