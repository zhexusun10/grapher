import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { GraphWorkbench } from "../../src/components/views/GraphWorkbench";
import { defaultConfig, emptySnapshot, type ChatMessage, type Execution, type Snapshot } from "../../src/types";
import { tokens } from "../../src/tokens";
import "../../src/styles.css";
import "../../src/styles-workbench.css";
import "../../src/styles-planning.css";

const audit = ((window as any).audit = {});
const config = { ...defaultConfig, repository: "/mock", model: "test/model" };
const params = new URLSearchParams(location.search);
const graph = params.get("mode") === "graph";
const followUp = params.get("turn") === "follow-up";
const provisional = params.get("turn") === "provisional";
const execution = (id: string, status: string, outputBytes: number): Execution => ({
  id, node: "task", status, output: "", outputBytes, revision: 0, attempt: id === "previous" ? 1 : followUp ? 2 : 1,
  startedAt: 1, completedAt: status === "running" ? null : 2,
  sessionId: "session", worktree: "/mock", before: "", after: "",
});
const noop = () => {};

function WorkspaceFooterFixture() {
  const [hasNode, setHasNode] = useState(!provisional);
  const [hasRunId, setHasRunId] = useState(!provisional);
  const [planning, setPlanning] = useState(provisional);
  const [executions, setExecutions] = useState<Execution[]>(followUp ? [execution("previous", "done", 0)] : []);
  const [messages, setMessages] = useState<ChatMessage[]>([{ id: "initial", role: "user", text: "Initial task" }]);
  const [pending, setPending] = useState(!followUp);
  const [status, setStatus] = useState<"done" | "dirty" | "running">(followUp ? "done" : "dirty");
  const state: Snapshot = { ...emptySnapshot, runId: hasRunId ? "footer-run" : "pending-footer-run", config,
    phase: hasNode ? "running" : "draft", approved: hasNode,
    planType: graph ? "graph" : "serial",
    graph: { originalGoal: "Initial task", nodes: hasNode ? [{ name: "task", task: "Initial task" }] : [], edges: [] },
    nodes: hasNode ? { task: { status, revision: 0, instruction: "", error: null } } : {}, executions };
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
    setExecutions(previous => previous.map(item => ({ ...item, status: "done", completedAt: 2 })));
    setStatus("done");
  };
  return <div style={{ height: 800, display: "flex" }}>
    <GraphWorkbench state={state} routeType={graph ? "graph" : "serial"} initialPlanMode={graph ? "graph" : "serial"}
      selected={graph ? "task" : ""} setSelected={noop} selectedMergerId="" setSelectedMergerId={noop}
      effectiveMessages={messages} isPlanning={planning} plannerStream={{ items: [] }} onSendMessage={noop} onRequestConfirmation={noop}
      onControl={noop} onSave={noop} onOpenEditor={noop} onOpenApproval={noop} repoInfo={null} config={config}
      active={status !== "done"} locked={false} pendingRequest={pending} publishing={false} publicationFailed={false}
      nodes={[]} edges={[]} nodeTypes={{}} edgeTypes={{}} tokens={tokens} />
  </div>;
}

createRoot(document.getElementById("root")!).render(<WorkspaceFooterFixture />);
