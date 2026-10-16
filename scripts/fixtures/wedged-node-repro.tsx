import React, { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { GraphWorkbench } from "../../src/components/views/GraphWorkbench";
import { tokens } from "../../src/tokens";
import { defaultConfig, emptySnapshot, type Snapshot } from "../../src/types";
import "../../src/styles.css";
import "../../src/styles-workbench.css";
import "../../src/styles-planning.css";

const audit = ((window as any).wedgedAudit = {});
const config = { ...defaultConfig, repository: "/a", model: "test/old" };

const INSTRUCTION = "Feedback Protocol Error: final line must be exactly <ACCEPT> or <FEEDBACK>\nEnd your response with exactly one standalone final line:\n   <ACCEPT>\n   or\n   <FEEDBACK>";

// Mirrors Run 96f32a53 node 11 at the wedge: failed node, stale feedback pin,
// a human repair instruction (invalidated, human=true) and no pending messages.
function buildState(): Snapshot {
  return {
    ...emptySnapshot,
    runId: "wedged-run",
    config,
    approved: true,
    phase: "needs_attention",
    paused: false,
    canResume: false,
    planType: "graph",
    graph: {
      originalGoal: "Wedged feedback retry regression",
      nodes: [
        { name: "gate", task: "gate" },
        { name: "extract", task: "执行全量规范化抽取" },
      ],
      edges: [
        { from: "gate", to: "extract", feedback: false },
        { from: "extract", to: "gate", feedback: true },
      ],
    },
    nodes: {
      gate: { status: "completed", revision: 1, instruction: "", error: null, pendingMessages: [] },
      extract: {
        status: "failed", revision: 2, instruction: INSTRUCTION, error: "Feedback workspace changed after completion",
        humanInstruction: true, pendingMessages: [], continuation: true,
        head: "48a609ab31e66ff4a654e3524020f7e094c25cd1",
        feedbackWorkspace: { head: "48a609ab31e66ff4a654e3524020f7e094c25cd1", sourceExecutionId: "src-exec", targetExecutionId: "a1", worktree: "C:\\wt" },
      },
    } as Snapshot["nodes"],
    executions: [
      { id: "a1", node: "extract", status: "completed", revision: 1, attempt: 1, output: "", outputBytes: 0, startedAt: 1, completedAt: 2, sessionId: "s1", worktree: "C:\\wt", before: "base", after: "48a609ab31e66ff4a654e3524020f7e094c25cd1" },
      { id: "a2", node: "extract", status: "failed", revision: 2, attempt: 2, output: "", outputBytes: 0, startedAt: 3, completedAt: 4, sessionId: "s2", worktree: "C:\\wt", before: "48a609ab31e66ff4a654e3524020f7e094c25cd1", after: null },
    ],
    events: [
      { type: "invalidated", sequence: 1161, timestamp: 4, target: "extract", nodes: ["extract"],
        instruction: INSTRUCTION, human: true, shared_workspace: false, source_direct: false } as any,
    ],
    supersededExecutionIds: [],
  } as unknown as Snapshot;
}

function ReproFixture() {
  const [state, setState] = useState(buildState);
  const [editingMessage, setEditingMessage] = useState<any>(null);
  const [editPrefillText, setEditPrefillText] = useState("");
  const [messages, setMessages] = useState<any[]>([]);
  const noop = useCallback(() => {}, []);
  audit.state = () => state;
  audit.edits = [];
  audit.controls = [];
  audit.sends = [];
  return <div style={{ height: 900, display: "flex" }}>
    <GraphWorkbench
      state={state}
      transcriptRunId={state.runId}
      activity={[]}
      composerDrafts={new Map()}
      routeType="graph"
      selected="extract"
      setSelected={noop}
      selectedMergerId=""
      setSelectedMergerId={noop}
      failedPlanning={null}
      effectiveMessages={messages}
      isPlanning={false}
      plannerStream={{ items: [], plannerText: "", partitionerText: "", stage: "idle" } as any}
      recoveredPlanningId={undefined}
      onConversationReady={noop}
      onInterrupt={undefined}
      onEditMessage={(msg: any) => { setEditingMessage(msg); setEditPrefillText(msg.text); }}
      editingMessage={editingMessage}
      editPrefillText={editPrefillText}
      onEditPrefillTextChange={setEditPrefillText}
      onCancelEditMessage={() => { setEditingMessage(null); setEditPrefillText(""); }}
      onEditMessageSubmit={async (msg: any, value: string) => {
        audit.edits.push({ id: msg?.id, value });
        return true;
      }}
      onSendMessage={async (text: string) => {
        audit.sends.push(text);
        setMessages(prev => [...prev, { id: `msg-${prev.length + 1}`, parentId: null, role: "user",
          text: `[@extract] ${text}`, node: "extract", runId: state.runId, timestamp: Date.now() }]);
        return true;
      }}
      onRequestConfirmation={noop}
      onControl={(action: string) => { audit.controls.push(action); return Promise.resolve(state); }}
      onSave={noop}
      onOpenEditor={noop}
      onOpenApproval={noop}
      repoInfo={null}
      config={config}
      active={false}
      locked={false}
      pendingRequest={false}
      publishing={false}
      publicationFailed={false}
      nodes={[]}
      edges={[]}
      nodeTypes={{}}
      edgeTypes={{}}
      tokens={tokens}
    />
  </div>;
}

const params = new URLSearchParams(location.search);
const root = createRoot(document.getElementById("root")!);
if (params.get("case") === "wedged") root.render(<ReproFixture />);
