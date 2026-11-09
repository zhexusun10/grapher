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
  const mode = new URLSearchParams(location.search).get("mode");
  const planner = mode === "planner";
  const graph = mode === "graph" || planner;
  const [calls, setCalls] = useState<string[]>([]);
  const state = { ...emptySnapshot, runId: "resume-run", config, phase: "needs_attention", approved: true,
    planType: graph ? "graph" : "serial", graph: { originalGoal: "Original task", nodes: [{ name: "task", task: "Original task" }], edges: [] },
    ...(planner ? { planning: { planningId: "failed-planner", runId: "resume-run", planType: "graph", status: "failed", error: "failed" } } : {}),
    nodes: { task: { status: "failed", canResume: true, revision: 0, instruction: "", error: "failure" } },
    executions: [{ id: "exec", node: "task", status: "failed", revision: 0, attempt: 1, output: "", startedAt: 1,
      completedAt: 2, sessionId: "session", worktree: "/mock", before: "", after: "" }] } as Snapshot;
  const noop = () => {};
  return <><output data-testid="calls">{calls.join("|")}</output>
    <div style={{ height: 800, display: "flex" }}><GraphWorkbench state={state} routeType={graph ? "graph" : "serial"}
      selected={graph && !planner ? "task" : ""} setSelected={noop} selectedMergerId="" setSelectedMergerId={noop}
      effectiveMessages={[{ id: "initial", role: "user", text: "Original task" }]} isPlanning={false} plannerStream={{ items: [] }}
      onSendMessage={text => { setCalls(previous => [...previous, `send:${text}`]); return true; }}
      onContinuePlanner={() => setCalls(previous => [...previous, "resume_planner"])}
      onRequestConfirmation={noop} onControl={(action, extra) => setCalls(previous => [...previous, `${action}:${extra?.node}`])}
      onSave={noop} onOpenEditor={noop} onOpenApproval={noop} onOpenFile={noop}
      repoInfo={null} config={config} active={false} locked={false} pendingRequest={false} publishing={false} publicationFailed={false}
      nodes={[]} edges={[]} nodeTypes={{}} edgeTypes={{}} tokens={tokens} /></div></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
