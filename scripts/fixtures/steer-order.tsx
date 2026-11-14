import React, { useRef, useState } from "react";
import { runtimeService } from "../../src/services/runtime";
import { ComposerDrafts } from "../../src/services/composerDrafts";
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
  const [visible, setVisible] = useState(true);
  const graph = new URLSearchParams(location.search).get("mode") === "graph";
  const paged = new URLSearchParams(location.search).get("paged") === "true";
  // A settled reload with a consumed steer already in the transcript: its
  // inline row and the outer fallback card must not both render.
  const presettled = new URLSearchParams(location.search).get("presettled") === "true";
  const beforeSteer = assistant("OUTPUT BEFORE STEER");
  const steerLine = line({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "CONSUMED STEER" }] } });
  const [output, setOutput] = useState(presettled
    ? beforeSteer + steerLine + assistant("OUTPUT AFTER STEER")
    : beforeSteer);
  const [messages, setMessages] = useState<ChatMessage[]>(presettled
    ? [{ id: "initial", role: "user", text: "Original task" },
      { id: "consumed", role: "user", text: "CONSUMED STEER", node: "task", runId: "steer-run",
        delivery: "steered", executionId: "exec", steerOrdinal: 0, inlineSteerOrdinal: 0 }]
    : [{ id: "initial", role: "user", text: "Original task" }]);
  const [events, setEvents] = useState<Snapshot["events"]>(presettled
    ? [{ type: "steered", sequence: 1, timestamp: 1, node: "task", execution_id: "exec", instruction: "CONSUMED STEER" }]
    : []);
  const [running, setRunning] = useState(!presettled);
  const submissions = useRef<unknown[]>([]);
  const drafts = useRef(new ComposerDrafts());
  const audit = ((window as any).steerAudit = { submissions: submissions.current, events });
  audit.consume = (text: string) => setOutput(previous => previous + line({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } }) + assistant("OUTPUT AFTER STEER"));
  audit.settle = () => setRunning(false);
  const state = { ...emptySnapshot, runId: "steer-run", config, phase: running ? "running" : "completed", approved: true,
    planType: graph ? "graph" : "serial", events, graph: { originalGoal: "Original task", nodes: [{ name: "task", task: "Original task" }], edges: [] },
    nodes: { task: { status: running ? "running" : "completed", revision: 0, instruction: "", error: null } },
    executions: [{ id: "exec", node: "task", status: running ? "running" : "completed", revision: 0, attempt: 1,
      output, ...(paged ? { outputBytes: 100 } : {}), startedAt: 1, completedAt: running ? null : 2, sessionId: "session", worktree: "/mock", before: "", after: "" }] } as Snapshot;
  const noop = () => {};
  return <><button style={{ position: "fixed", top: 0, left: 0, zIndex: 100 }} onClick={() => setVisible(value => !value)}>Toggle view</button>
    <div style={{ height: 800, display: "flex" }}>{visible && <GraphWorkbench state={state} routeType={graph ? "graph" : "serial"}
    selected={graph ? "task" : ""} setSelected={noop} selectedMergerId="" setSelectedMergerId={noop}
    effectiveMessages={messages} isPlanning={false} plannerStream={{ items: [] }} composerDrafts={drafts.current}
    onWithdrawMessages={async (node, requestId) => {
      const result = await runtimeService.withdrawMessages(state.runId, node, requestId);
      setEvents(result.snapshot.events);
      return result.messages;
    }}
    onSendMessage={(text, options) => {
      submissions.current.push({ text, interrupt: options?.interrupt, images: options?.images });
      const ordinal = messages.filter(message => message.text === text).length;
      setMessages(previous => [...previous, { id: `msg-${options?.requestId ?? ordinal}`, role: "user", text, node: "task", runId: "steer-run",
        delivery: "steered", executionId: "exec", steerRequestId: options?.requestId, steerOrdinal: ordinal, inlineSteerOrdinal: ordinal,
        images: options?.images, files: options?.files?.map(file => ({ name: file.name, size: file.size, type: file.type })) }]);
      setEvents(previous => [...previous, { type: "steered", sequence: previous.length + 1, timestamp: Date.now(),
        node: "task", execution_id: "exec", instruction: text, request_id: options?.requestId, images: options?.images }]);
      return true;
    }} onRequestConfirmation={noop} onControl={noop} onSave={noop} onOpenEditor={noop} onOpenApproval={noop} onOpenFile={noop}
    repoInfo={null} config={config} active={running} locked={false} pendingRequest={false} publishing={false} publicationFailed={false}
    nodes={[]} edges={[]} nodeTypes={{}} edgeTypes={{}} tokens={tokens} />}</div></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
