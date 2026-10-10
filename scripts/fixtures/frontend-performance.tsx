import React, { Profiler, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { VirtualizedTranscript } from "../../src/components/VirtualizedTranscript";
import { UnwindowedTranscript } from "./unwindowed-transcript";
import { PlannerTranscript } from "../../src/components/PlannerTranscript";
import { ExecutionTranscript } from "../../src/components/ExecutionTranscript";
import { useFrameBatchedState } from "../../src/hooks/useFrameBatchedState";
import { useSnapshotState } from "../../src/hooks/useSnapshotState";
import { useGraphElements } from "../../src/hooks/useGraphElements";
import { useStableCallback } from "../../src/hooks/useStableCallback";
import { emptySnapshot, type ChatMessage, type Execution, type Snapshot, type TranscriptItem } from "../../src/types";
import "../../src/styles.css";
import "../../src/styles-planning.css";
import "../../src/styles-workbench.css";

const audit = ((window as any).performanceAudit = { commits: 0, edits: [], resized: [], renders: [] });
const count = 800;
const tools: TranscriptItem[] = Array.from({ length: count }, (_, index) => ({
  id: `tool-${index}`, type: "tool_call", toolName: "bash", toolCallId: `tool-${index}`,
  args: { command: `echo performance-row-${index}` }, result: `Result ${index}\n${"Line\n".repeat(12)}`, status: "success", exitCode: 0,
}));
const user: TranscriptItem = { id: "user-middle", type: "text", role: "user", content: "Editable middle turn" };
const items = [...tools.slice(0, 400), user, ...tools.slice(400)];
const jsonl = items.map(item => item.role === "user" ? JSON.stringify({ type: "message_start", message: {
  id: item.id, role: "user", content: [{ type: "text", text: item.content }],
} }) : [JSON.stringify({ type: "tool_execution_start", toolCallId: item.id, toolName: item.toolName, args: item.args }),
  JSON.stringify({ type: "tool_execution_end", toolCallId: item.id, toolName: item.toolName,
    result: { content: [{ type: "text", text: item.result }], details: { exitCode: 0 } } })].join("\n")).join("\n") + "\n";
const queries = new URLSearchParams(location.search);

function TranscriptFixture() {
  const [output, setOutput] = useState(jsonl);
  const [liveItems, setLiveItems] = useState(items);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [draft, setDraft] = useState("");
  audit.append = () => {
    setOutput(previous => previous + JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Appended final 中文🚀" }] } }) + "\n");
    setLiveItems(previous => [...previous, { id: "appended", type: "text", role: "assistant", content: "Appended final 中文🚀" }]);
  };
  const resize = useCallback((expanded?: boolean) => { audit.resized.push(expanded); }, []);
  const edit = useCallback((text: string, replacement: string) => { audit.edits.push({ text, replacement }); return false; }, []);
  return <div data-shared-scroll style={{ overflowY: "auto", height: 420, width: 900, border: "1px solid black" }}>
    <div>
      <div data-before style={{ height: 350 }}>Content before the transcript</div>
      <Profiler id="transcript" onRender={(_, phase, duration) => { audit.commits++; audit.renders.push({ phase, duration }); }}>
        <div className="planning-activity-output">
        {queries.get("baseline") ? <UnwindowedTranscript items={items} /> : queries.get("live") ? <PlannerTranscript items={liveItems} isPlanning={false} locked={false}
          editingMessage={editingMessage} draft={draft} onDraftChange={setDraft}
          onEditMessage={message => { setEditingMessage(message); setDraft(message.text); }} onCancelEdit={() => setEditingMessage(null)}
          onEditSubmit={(message, replacement) => edit(message.text, replacement)} onSendMessage={() => {}} onUserResize={resize} /> :
          <VirtualizedTranscript output={output} inline showUserTurns onUserResize={resize} onEditUser={edit} />}
        </div>
      </Profiler>
      <div data-after style={{ height: 250 }}>Content after the transcript</div>
    </div>
  </div>;
}

function FrameFixture() {
  const [text, setText, queue] = useFrameBatchedState("");
  const [factor, setFactor] = useState(1);
  const callback = useStableCallback(() => factor);
  audit.queueBurst = () => { for (let i = 0; i < 100; i++) queue(previous => previous + `${i},`); };
  audit.finish = () => setText(previous => previous + "done");
  audit.reset = () => setText("");
  audit.setFactor = setFactor;
  audit.callback = callback;
  useEffect(() => { audit.text = text; audit.commits++; }, [text]);
  return <output data-frame-text>{text}</output>;
}

const initial: Snapshot = { ...emptySnapshot, runId: "projection", phase: "running",
  graph: { originalGoal: "projection", nodes: [{ name: "a", task: "a" }, { name: "b", task: "b" }], edges: [{ from: "a", to: "b", feedback: false }] },
  nodes: { a: { status: "running", revision: 0, head: null, instruction: "", error: null } },
  executions: [{ id: "execution", node: "a", status: "running", output: "", outputBytes: 0, worktree: "/mock" } as Execution] };
function ProjectionFixture() {
  const [snapshot, setSnapshot] = useSnapshotState(initial);
  const [selected, setSelected] = useState("");
  const [newEdges] = useState(new Set<string>());
  const projection = useGraphElements(snapshot, selected, newEdges);
  audit.updateBytes = () => setSnapshot(previous => {
    const next = structuredClone(previous); next.executions[0].outputBytes!++; return next;
  });
  audit.select = setSelected;
  useEffect(() => {
    if (audit.previousProjection) audit.sharing = {
      graph: audit.previousSnapshot.graph === snapshot.graph,
      nodes: audit.previousProjection.nodes === projection.nodes,
      edges: audit.previousProjection.edges === projection.edges,
      first: audit.previousProjection.nodes[0] === projection.nodes[0],
      second: audit.previousProjection.nodes[1] === projection.nodes[1],
    };
    audit.previousProjection = projection; audit.previousSnapshot = snapshot;
  });
  return <output data-projection>{snapshot.executions[0].outputBytes}:{selected}</output>;
}
function LogFixture() {
  return <ExecutionTranscript runId="log-run" execution={{ id: "log-exec", status: "running", output: "", outputBytes: 100 } as Execution} />;
}
const cases: Record<string, React.ComponentType> = { transcript: TranscriptFixture, frame: FrameFixture, projection: ProjectionFixture, log: LogFixture };
const Component = cases[queries.get("case") || "transcript"];
createRoot(document.getElementById("root")!).render(<React.StrictMode><Component /></React.StrictMode>);
