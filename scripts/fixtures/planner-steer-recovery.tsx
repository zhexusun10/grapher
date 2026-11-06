import React from "react";
import { createRoot } from "react-dom/client";
import { GraphWorkbench } from "../../src/components/views/GraphWorkbench";
import { defaultConfig, emptySnapshot, type Snapshot } from "../../src/types";
import { tokens } from "../../src/tokens";
import "../../src/styles.css";
import "../../src/styles-workbench.css";
import "../../src/styles-planning.css";

const ids = ["12345678-1234-4234-8234-123456789abc", "12345678-1234-4234-8234-123456789abd"];
const params = new URLSearchParams(location.search);
const running = params.get("running") !== "false";
const goal = params.get("sameGoal") === "true" ? "REPEATED INSTRUCTION" : "ORIGINAL GOAL";
const config = { ...defaultConfig, repository: "/mock", model: "test/model" };
const planning = { planningId: "recovery-plan", status: running ? "running" : "failed", roles: {}, createdAt: 1, runId: "recovery-run" };
const state: Snapshot = { ...emptySnapshot, runId: "recovery-run", config, planType: "graph", phase: running ? "planning" : "planning_failed",
  planningId: "recovery-plan", planning, graph: { originalGoal: goal, nodes: [], edges: [] },
  events: [
    { type: "created", sequence: 1, timestamp: 1, planning_id: "recovery-plan", planning },
    ...ids.map((request_id, index) => ({ type: "planner_steer_submitted", sequence: index + 2, timestamp: index + 2,
      planning_id: "recovery-plan", request_id, instruction: "REPEATED INSTRUCTION" })),
    { type: "planner_steer_status", sequence: 4, timestamp: 4, planning_id: "recovery-plan", request_id: ids[0], status: "consumed" },
    { type: "planner_steer_status", sequence: 5, timestamp: 5, planning_id: "recovery-plan", request_id: ids[1], status: "queued" },
  ],
};
const noop = () => {};
createRoot(document.getElementById("root")!).render(<div style={{ height: 800, display: "flex" }}>
  <GraphWorkbench state={state} routeType="graph" selected="" setSelected={noop} selectedMergerId="" setSelectedMergerId={noop}
    effectiveMessages={[{ id: "initial", role: "user", text: goal }]} plannerStream={{ items: [] }}
    isPlanning={running} recoveredPlanningId={running ? "recovery-plan" : undefined}
    onSendMessage={() => false} onRequestConfirmation={noop} onControl={noop} onSave={noop} onAddManualNode={async () => false}
    onOpenEditor={noop} onOpenApproval={noop} onOpenFile={noop} repoInfo={null} config={config} active={false}
    locked={false} pendingRequest={false} publishing={false} publicationFailed={false}
    nodes={[]} edges={[]} nodeTypes={{}} edgeTypes={{}} tokens={tokens} />
</div>);
