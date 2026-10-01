import React, { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsModal } from "../../src/components/modals/SettingsModal";
import { EditorModal } from "../../src/components/modals/EditorModal";
import { EditableUserBubble } from "../../src/components/views/ChatBubbles";
import { PromptBox } from "../../src/components/ui/chatgpt-prompt-input";
import { useSnapshotPolling } from "../../src/hooks/useSnapshotPolling";
import { runtimeService } from "../../src/services/runtime";
import { defaultConfig, emptyGraph, emptySnapshot, type Snapshot } from "../../src/types";
import "../../src/styles.css";
import "../../src/styles-workbench.css";

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
function PollingFixture() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ ...emptySnapshot, config, runId: "view", phase: "running", graph: { ...emptyGraph, originalGoal: "Initial" } });
  const [ids, setIds] = useState(["broken", "background", "view"]);
  const observe = useCallback((next: Snapshot) => {
    (audit.observed ??= []).push(next.runId);
  }, []);
  const accept = useSnapshotPolling(setSnapshot, observe, ids, snapshot.runId, snapshot.phase);
  audit.acceptAction = () => {
    accept({ runId: "view", phase: "running" });
    setSnapshot(previous => ({ ...previous, graph: { ...emptyGraph, originalGoal: "Action result" } }));
  };
  audit.removeBroken = () => setIds(["background", "view"]);
  return <output data-viewed-goal>{snapshot.graph.originalGoal}</output>;
}
const cases: Record<string, React.ComponentType> = {
  settings: SettingsFixture, editor: EditorFixture, bubble: BubbleFixture, prompt: PromptFixture, polling: PollingFixture,
};
const Component = cases[new URLSearchParams(location.search).get("case") || "settings"];
createRoot(document.getElementById("root")!).render(<Component />);
