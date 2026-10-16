import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { GraphWorkbench } from "../../src/components/views/GraphWorkbench";
import { TaskNode } from "../../src/components/graph/TaskNode";
import { SmoothWorkflowEdge } from "../../src/components/graph/WorkflowEdge";
import { useGraphElements } from "../../src/hooks/useGraphElements";
import { defaultConfig, emptySnapshot, type Snapshot } from "../../src/types";
import { tokens } from "../../src/tokens";
import "@xyflow/react/dist/style.css";
import "../../src/styles.css";
import "../../src/styles-planning.css";
import "../../src/styles-workbench.css";

const nodeTypes = { work: TaskNode };
const edgeTypes = { workflow: SmoothWorkflowEdge };
const noNewElements = new Set<string>();
const noop = () => {};
const config = { ...defaultConfig, repository: "/mock/project" };

function Fixture() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ ...emptySnapshot, runId: "pending-fixture", config,
    planType: "graph", phase: "planning", graph: { ...emptySnapshot.graph, originalGoal: "Viewport regression" } });
  const [planning, setPlanning] = useState(true);
  const [selected, setSelected] = useState("");
  const [selectedMergerId, setSelectedMergerId] = useState("");
  const { nodes, edges } = useGraphElements(snapshot, selected, noNewElements);
  (window as any).graphFixture = {
    update: (patch: Partial<Snapshot>, isPlanning = planning) => {
      setSnapshot(previous => ({ ...previous, ...patch }));
      setPlanning(isPlanning);
    },
  };
  return <div style={{ display: "flex", height: "calc(100vh - 40px)", width: "100%" }}>
    <GraphWorkbench state={snapshot} routeType="graph" selected={selected} setSelected={setSelected}
      selectedMergerId={selectedMergerId} setSelectedMergerId={setSelectedMergerId}
      effectiveMessages={[]} isPlanning={planning}
      plannerStream={{ runId: snapshot.runId, stage: planning ? "planning" : "completed", plannerText: "",
        items: [{ id: "node-tool", type: "tool_call", toolName: "node", args: {}, status: "success" }] }}
      onSendMessage={noop} onRequestConfirmation={noop} onControl={noop} onSave={noop}
      onOpenEditor={noop} onOpenApproval={noop} repoInfo={null} config={config}
      active={false} locked={false} pendingRequest={false} publishing={false} publicationFailed={false}
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} tokens={tokens} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
