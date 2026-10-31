import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { GraphWorkbench } from "../../src/components/views/GraphWorkbench";
import { defaultConfig, emptySnapshot, type ChatMessage, type Snapshot } from "../../src/types";
import { tokens } from "../../src/tokens";
import "../../src/styles.css";
import "../../src/styles-workbench.css";
import "../../src/styles-planning.css";

const config = { ...defaultConfig, repository: "/mock", model: "test/model" };
const line = (event: unknown) => JSON.stringify(event) + "\n";
const assistant = (text: string) => line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

function Fixture() {
  const graph = new URLSearchParams(location.search).get("mode") === "graph";
  const paged = new URLSearchParams(location.search).get("paged") === "true";
  const [output, setOutput] = useState(assistant("OUTPUT BEFORE STEER"));
  const [messages, setMessages] = useState<ChatMessage[]>([{ id: "initial", role: "user", text: "Original task" }]);
  const [events, setEvents] = useState<Snapshot["events"]>([]);
  const [running, setRunning] = useState(true);
  const audit = ((window as any).steerAudit = {});
  audit.consume = (text: string) => setOutput(previous => previous + line({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } }) + assistant("OUTPUT AFTER STEER"));
  audit.settle = () => setRunning(false);
  const state = { ...emptySnapshot, runId: "steer-run", config, phase: running ? "running" : "completed", approved: true,
    planType: graph ? "graph" : "serial", events, graph: { originalGoal: "Original task", nodes: [{ name: "task", task: "Original task" }], edges: [] },
    nodes: { task: { status: running ? "running" : "completed", revision: 0, instruction: "", error: null } },
    executions: [{ id: "exec", node: "task", status: running ? "running" : "completed", revision: 0, attempt: 1,
      output, ...(paged ? { outputBytes: 100 } : {}), startedAt: 1, completedAt: running ? null : 2, sessionId: "session", worktree: "/mock", before: "", after: "" }] } as Snapshot;
  const noop = () => {};
  return <div style={{ height: 800, display: "flex" }}><GraphWorkbench state={state} routeType={graph ? "graph" : "serial"}
    selected={graph ? "task" : ""} setSelected={noop} selectedMergerId="" setSelectedMergerId={noop}
    effectiveMessages={messages} isPlanning={false} plannerStream={{ items: [] }}
    onSendMessage={(text, options) => {
      const ordinal = messages.filter(message => message.text === text).length;
      setMessages(previous => [...previous, { id: `msg-${ordinal}`, role: "user", text, node: "task", runId: "steer-run",
        delivery: "steered", executionId: "exec", steerOrdinal: ordinal, inlineSteerOrdinal: ordinal,
        images: options?.images, files: options?.files?.map(file => ({ name: file.name, size: file.size, type: file.type })) }]);
      setEvents(previous => [...previous, { type: "steered", sequence: previous.length + 1, timestamp: Date.now(),
        node: "task", execution_id: "exec", instruction: text, images: options?.images }]);
      return true;
    }} onRequestConfirmation={noop} onControl={noop} onSave={noop} onOpenEditor={noop} onOpenApproval={noop} onOpenFile={noop}
    repoInfo={null} config={config} active={running} locked={false} pendingRequest={false} publishing={false} publicationFailed={false}
    nodes={[]} edges={[]} nodeTypes={{}} edgeTypes={{}} tokens={tokens} /></div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
