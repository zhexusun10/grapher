import React, { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsModal } from "../../src/components/modals/SettingsModal";
import { EditorModal } from "../../src/components/modals/EditorModal";
import { EditableUserBubble } from "../../src/components/views/ChatBubbles";
import { PromptBox } from "../../src/components/ui/chatgpt-prompt-input";
import { useSnapshotPolling } from "../../src/hooks/useSnapshotPolling";
import { runtimeService } from "../../src/services/runtime";
import { ThinkingCard } from "../../src/components/ThinkingCard";
import { VirtualizedTranscript } from "../../src/components/VirtualizedTranscript";
import { ExecutionTranscript, executionTranscriptCache } from "../../src/components/ExecutionTranscript";
import { PlanningActivity, planningTranscriptCache } from "../../src/components/PlanningActivity";
import { useConversationTranscriptCache } from "../../src/hooks/useConversationTranscriptCache";
import { cachedPlanningOutput, planningTranscriptKey } from "../../src/services/transcriptCache";
import { GraphWorkbench } from "../../src/components/views/GraphWorkbench";
import { tokens } from "../../src/tokens";
import { closeThinkingItems, finalizeThinkingItems, updateThinkingItems } from "../../src/services/thinkingTranscript";
import type { TranscriptItem } from "../../src/types";
import { defaultConfig, emptyGraph, emptySnapshot, type RuntimeActivity, type Snapshot } from "../../src/types";
import "../../src/styles.css";
import "../../src/styles-workbench.css";
import "../../src/styles-planning.css";

const audit = ((window as any).audit = {});
const config = { ...defaultConfig, repository: "/a", model: "test/old" };
function SettingsFixture() {
  const [committed, setCommitted] = useState(config);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState("");
  audit.open = () => { setError(""); setOpen(true); };
  audit.committed = committed;
  return <>
    <output data-committed-model>{committed.model}</output>
    {open && <SettingsModal config={committed} isOpen onClose={() => setOpen(false)} dataPath="/mock" error={error}
      onSaveConfig={async next => {
        try {
          await runtimeService.saveConfig(next);
          setCommitted(next);
          setOpen(false);
          return true;
        } catch (error) { setError(String(error)); return false; }
      }} />}
  </>;
}
function EditorFixture() {
  const [graph, setGraph] = useState({ ...emptyGraph, originalGoal: "Initial graph" });
  const [open, setOpen] = useState(true);
  audit.updateGraph = () => setGraph({ ...emptyGraph, originalGoal: "Polled graph" });
  audit.open = () => setOpen(true);
  return <EditorModal isOpen={open} onClose={() => setOpen(false)} initialGraph={graph} busy={false} active={false} onSave={() => {}} onError={() => {}} />;
}
function BubbleFixture() {
  const [draft, setDraft] = useState("Edited message");
  audit.calls = audit.calls ?? 0;
  return <EditableUserBubble text="Initial message" editing draft={draft} onDraftChange={setDraft} onCancel={() => {}}
    onSend={() => {
      audit.calls += 1;
      return new Promise<boolean>(resolve => { audit.resolve = resolve; });
    }} />;
}
function PromptFixture() {
  const [repository, setRepository] = useState("/a");
  const [value, setValue] = useState("");
  audit.switchRepository = () => { setRepository("/b"); setValue(""); };
  audit.value = value;
  return <PromptBox repository={repository} value={value} onChange={event => setValue(event.target.value)}
    onPaste={() => { audit.pastes = (audit.pastes ?? 0) + 1; }}
    onSubmit={async () => { audit.submissions = (audit.submissions ?? 0) + 1; return true; }} />;
}

function UnchangedBubbleFixture() {
  const [draft, setDraft] = useState("Initial message");
  audit.unchangedSends = 0;
  return <EditableUserBubble text="Initial message" editing draft={draft} onDraftChange={setDraft}
    onCancel={() => {}} onSend={() => { audit.unchangedSends += 1; return true; }} />;
}
function InterruptPromptFixture() {
  const [value, setValue] = useState("");
  audit.interrupts = 0;
  return <PromptBox isWorking value={value} onChange={event => setValue(event.target.value)}
    onInterrupt={() => { audit.interrupts += 1; }} onSubmit={() => { audit.submissions = (audit.submissions ?? 0) + 1; return true; }} />;
}
function TranscriptFixture() {
  const outputBytes = Number(new URLSearchParams(location.search).get("bytes"));
  return <div className="initial-query-scroll" data-transcript-scroll style={{ height: 300, overflowY: "auto" }}>
    <ExecutionTranscript runId="tail-run" execution={{ id: "tail-exec", node: "worker", status: "completed",
      output: "", outputBytes, startedAt: 1, completedAt: 2 } as any} />
  </div>;
}

function PlannerTranscriptFixture() {
  return <div className="initial-query-scroll" data-transcript-scroll style={{ height: 300, overflowY: "auto" }}>
    <PlanningActivity planningIds={["planner-tool-plan"]} showUserTurns running />
  </div>;
}

function HistoryRegressionFixture() {
  const [view, setView] = useState("node");
  const [running, setRunning] = useState(true);
  const [planningIds, setPlanningIds] = useState(["planner-previous", "planner-latest"]);
  useConversationTranscriptCache(view === "exit" ? "" : "regression");
  const scroll = React.useRef<HTMLDivElement>(null);
  const params = new URLSearchParams(location.search);
  const headingHeight = Number(params.get("heading") ?? 300);
  const footerHeight = Number(params.get("footer") ?? 0);
  audit.selectHistory = setView;
  audit.setRunning = setRunning;
  audit.cachedExecution = () => executionTranscriptCache.get("regression:worker");
  audit.setPlanningIds = setPlanningIds;
  audit.cachedPlanning = () => {
    const latest = planningTranscriptCache.get(planningTranscriptKey("regression", planningIds.at(-1)!));
    return latest ? { ...latest, text: cachedPlanningOutput("regression", planningIds) } : undefined;
  };
  audit.planningCacheKeys = () => [...planningTranscriptCache.keys()];
  const ready = useCallback(() => { requestAnimationFrame(() => {
    if (scroll.current) {
      delete scroll.current.dataset.transcriptHistoryReading;
      scroll.current.scrollTop = scroll.current.scrollHeight;
    }
  }); }, [view]);
  return <div className="initial-query-scroll" data-shared-scroll ref={scroll} style={{ height: 380, width: 850, flex: "none", overflowY: "auto" }}>
    <div style={{ height: headingHeight, flexShrink: 0 }}>Conversation heading and task above the transcript</div>
    {view === "node" && <ExecutionTranscript runId="regression" execution={{ id: "worker", node: "worker", status: running ? "running" : "failed",
      output: "", outputBytes: 0, startedAt: 1, completedAt: running ? null : 2 } as any} onInitialOutputReady={ready} />}
    {view === "planner" && <PlanningActivity runId="regression" planningIds={planningIds} running={running} showUserTurns onReady={ready} />}
    {footerHeight > 0 && <div style={{ height: footerHeight }}>Graph summary below the transcript</div>}
  </div>;
}

function LatestScrollFixture() {
  const layout = new URLSearchParams(location.search).get("layout");
  const assistant = (text: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
  const [output, setOutput] = useState(() => {
    if (layout === "long") return assistant(Array.from({ length: 300 }, (_, index) => `Paragraph ${index}: long message 中文🚀 with enough text to span the viewport.\n\n`).join("")) + assistant("LATEST_VISIBLE_MARKER");
    const history = Array.from({ length: 80 }, (_, index) => assistant(`Virtualized message ${index}`)).join("");
    const content = Array.from({ length: 30 }, (_, index) => `Card output line ${index}`).join("\n\n");
    if (layout === "thinking-card") return history + JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: content }] } }) + "\n";
    if (layout === "tool-card") return history + [
      { type: "tool_execution_start", toolCallId: "bottom-tool", toolName: "bash", args: { command: "echo bottom-card" } },
      { type: "tool_execution_end", toolCallId: "bottom-tool", toolName: "bash", result: { content: [{ type: "text", text: content }], details: { exitCode: 0 } } },
    ].map(event => JSON.stringify(event) + "\n").join("");
    return Array.from({ length: 500 }, (_, index) => assistant(`Virtualized message ${index}`)).join("");
  });
  const [mounted, setMounted] = useState(true);
  audit.appendLatest = () => setOutput(previous => previous + assistant("APPEND_WHILE_SMOOTH_SCROLLING"));
  audit.unmountConversation = () => setMounted(false);
  const state = { ...emptySnapshot, runId: "latest-run", config, phase: "paused", paused: true, approved: true, planType: "serial" as const,
    graph: { originalGoal: "Latest-scroll regression", nodes: [{ name: "task", task: "Inspect the long conversation" }], edges: [] },
    nodes: { task: { status: "done" as const, revision: 0, instruction: "", error: null } },
    executions: [{ id: "latest-execution", node: "task", status: "completed", revision: 0, attempt: 1, output,
      startedAt: 1, completedAt: 2, sessionId: "latest-session", worktree: "/mock", before: "", after: "" }] } as Snapshot;
  const noop = () => {};
  return mounted ? <div style={{ height: 800, display: "flex" }}>
    <GraphWorkbench state={state} routeType="serial" selected="" setSelected={noop} selectedMergerId="" setSelectedMergerId={noop}
      effectiveMessages={[]} isPlanning={false} plannerStream={{ items: [] }} onSendMessage={noop} onRequestConfirmation={noop}
      onControl={noop} onSave={noop} onOpenEditor={noop} onOpenApproval={noop} repoInfo={null} config={config}
      active={false} locked={false} pendingRequest={false} publishing={false} publicationFailed={false}
      nodes={[]} edges={[]} nodeTypes={{}} edgeTypes={{}} tokens={tokens} />
  </div> : <p>Conversation closed</p>;
}

function PollingFixture() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ ...emptySnapshot, config, runId: "view", phase: "running", graph: { ...emptyGraph, originalGoal: "Initial" } });
  const [ids, setIds] = useState(["broken", "background", "view"]);
  const observe = useCallback((next: Snapshot) => {
    (audit.observed ??= []).push(next.runId);
  }, []);
  const observeActivity = useCallback((_runId: string, _activity: RuntimeActivity[]) => {}, []);
  const accept = useSnapshotPolling(setSnapshot, observe, observeActivity, ids, snapshot.runId, snapshot.phase);
  audit.acceptAction = () => {
    accept({ runId: "view", phase: "running" });
    setSnapshot(previous => ({ ...previous, graph: { ...emptyGraph, originalGoal: "Action result" } }));
  };
  audit.removeBroken = () => setIds(["background", "view"]);
  return <output data-viewed-goal>{snapshot.graph.originalGoal}</output>;
}
function ThinkingFixture() {
  const [output, setOutput] = useState("");
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const messageStart = React.useRef(0);
  audit.append = (event: any) => {
    setOutput(previous => previous + JSON.stringify(event) + "\n");
    setItems(previous => {
      if (event.type === "message_start" && event.message?.role === "assistant") {
        messageStart.current = previous.length;
        return closeThinkingItems(previous);
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type.startsWith("thinking_")) {
        return updateThinkingItems(previous, event.assistantMessageEvent, messageStart.current);
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const next = finalizeThinkingItems(previous, event.message.content, messageStart.current);
        messageStart.current = next.length;
        return next;
      }
      return previous;
    });
  };
  return <>
    <section data-thinking-view="live">{items.map(item => <div key={item.id} data-transcript-id={item.id}><ThinkingCard item={item} /></div>)}</section>
    <section data-thinking-view="history"><VirtualizedTranscript output={output} inline /></section>
  </>;
}
const cases: Record<string, React.ComponentType> = {
  settings: SettingsFixture, editor: EditorFixture, bubble: BubbleFixture, unchangedBubble: UnchangedBubbleFixture,
  prompt: PromptFixture, interruptPrompt: InterruptPromptFixture, transcript: TranscriptFixture, plannerTranscript: PlannerTranscriptFixture,
  polling: PollingFixture, historyRegression: HistoryRegressionFixture, latestScroll: LatestScrollFixture,
  thinking: ThinkingFixture,
};
const Component = cases[new URLSearchParams(location.search).get("case") || "settings"];
createRoot(document.getElementById("root")!).render(<Component />);
