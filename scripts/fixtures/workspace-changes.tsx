import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { GraphWorkbench } from "../../src/components/views/GraphWorkbench";
import { buildSummaryFromFiles } from "../../src/services/fileChanges";
import { defaultConfig, emptySnapshot, publicationMergerCardId, type Execution, type FileChangeItem, type Snapshot } from "../../src/types";
import { tokens } from "../../src/tokens";
import "../../src/styles.css";
import "../../src/styles-workbench.css";
import "../../src/styles-planning.css";

const noop = () => {};
const config = { ...defaultConfig, repository: "/project", model: "test/model" };
const files: FileChangeItem[] = [
  { path: "src/components/Button.tsx", status: "modified", additions: 2, deletions: 1, source: "edit", nodes: ["worker"] },
  { path: "src/hooks/usePreview.ts", status: "added", additions: 24, deletions: 0, source: "write" , nodes: ["worker"] },
  { path: "src/legacy.ts", status: "deleted", additions: 0, deletions: 18, nodes: ["worker"] },
  { path: "docs/guide.md", oldPath: "docs/readme.md", status: "renamed", additions: 0, deletions: 0, nodes: ["planner"] },
  { path: "src/styles/theme.css", status: "modified", additions: 6, deletions: 2, nodes: ["worker"] },
  { path: "src/components/a-very-long-file-name-for-a-small-conversation-pane.tsx", status: "modified", additions: 1, deletions: 1, nodes: ["worker"] },
];

const referenceFiles: FileChangeItem[] = [
  { path: "src/components/Chat.tsx", status: "modified", additions: 24, deletions: 8 },
  { path: "src/styles/chat.css", status: "modified", additions: 18, deletions: 10 },
  { path: "src/hooks/useChat.ts", status: "modified", additions: 0, deletions: 0 },
];

/** Enough rows to exceed the render cap without making the fixture unwieldy. */
const manyFiles: FileChangeItem[] = Array.from({ length: 1205 }, (_, index) => ({
  path: `src/generated/file-${String(index).padStart(4, "0")}.ts`,
  status: "modified" as const, additions: 1, deletions: 0,
}));

/** Mixed statuses and sizes to pin the added/deleted-first, lines-descending order. */
const mixedFiles: FileChangeItem[] = [
  { path: "src/mod-small.ts", status: "modified", additions: 1, deletions: 0 },
  { path: "src/added-large.ts", status: "added", additions: 40, deletions: 0 },
  { path: "src/deleted-small.ts", status: "deleted", additions: 0, deletions: 2 },
  { path: "src/added-small.ts", status: "added", additions: 3, deletions: 1 },
  { path: "src/mod-large.ts", status: "modified", additions: 30, deletions: 5 },
  { path: "src/deleted-large.ts", status: "deleted", additions: 0, deletions: 25 },
];

const longConversationOutput = Array.from({ length: 80 }, (_, index) => JSON.stringify({
  type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Review message ${index}: the implementation is ready for inspection.` }] },
})).join("\n") + "\n";

function Fixture() {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode") || "serial";
  const shownFiles = params.get("many") === "1" ? manyFiles
    : params.get("mix") === "1" ? mixedFiles
    : params.get("reference") === "1" ? referenceFiles : files;
  const writeDebug = params.get("write") === "1";
  const metadata = params.get("metadata") === "1";
  const repeatedAttempts = params.get("attempts") === "2";
  const livePhase = params.get("phase") || "running";
  const [running, setRunning] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(mode === "node" || mode === "waiting" ? "worker" : mode === "merger" ? publicationMergerCardId : "");
  const [selectedMergerId, setSelectedMergerId] = useState("");
  const summary = buildSummaryFromFiles(empty ? [] : (writeDebug ? [{ path: "src/components/WriteOnly.tsx", status: "added" as const, additions: 2, deletions: 0, source: "write" as const }] : shownFiles).map((file, index) => ({
    ...file, additions: file.additions + (index === 0 ? revision : 0),
  })), false);
  const execution: Execution = {
    id: "execution", node: "worker", revision: 0, attempt: 1,
    sessionId: "session", worktree: "/project", before: "", after: "",
    status: running ? "running" : "completed", startedAt: repeatedAttempts ? 2 : 1, completedAt: running ? null : 3,
    ...(params.has("bytes") ? { outputBytes: Number(params.get("bytes")) } : {}),
    output: params.has("bytes") ? "" : params.get("long") === "1" ? longConversationOutput
      : JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "The implementation is ready for review." }] } }) + "\n",
    fileChanges: metadata ? undefined : summary,
  };
  const attempts: Execution[] = repeatedAttempts
    ? [{ ...execution, id: "execution-prior", attempt: 1, status: "completed", startedAt: 1, completedAt: 2 }, { ...execution, attempt: 2 }]
    : [execution];
  const state: Snapshot = {
    ...emptySnapshot, runId: "changes-run", config, planType: mode === "serial" ? "serial" : "graph",
    approved: true, phase: running ? livePhase : "completed",
    graph: { originalGoal: "Review the file changes in this conversation.", nodes: [{ name: "worker", task: "Implement the preview component." }], edges: [] },
    nodes: { worker: { status: mode === "waiting" ? "waiting" : running && livePhase !== "completed" ? "running" : "completed", revision: 0, head: null, instruction: "", error: null } },
    executions: mode === "planner" || mode === "merger" || mode === "waiting" ? [] : attempts,
    mergers: mode === "merger" ? [{ ...execution, id: "merger-execution", node: "merger" }] : [],
    fileChanges: !metadata && (mode === "planner" || mode === "waiting") ? summary : undefined,
    fileChangesOmitted: metadata,
    events: metadata ? [{ sequence: revision + 1, timestamp: 1, type: "workspace_files_changed" }] : [],
  };
  (window as any).changesAudit = {
    settle: () => setRunning(false), empty: () => setEmpty(true),
    update: () => setRevision(value => value + 1), select: setSelected,
  };

  return <div style={{ height: "100dvh", display: "flex", padding: "12px", boxSizing: "border-box" }}>
    <GraphWorkbench state={state} routeType={mode === "serial" ? "serial" : "graph"}
      selected={selected} setSelected={setSelected} selectedMergerId={selectedMergerId} setSelectedMergerId={setSelectedMergerId}
      effectiveMessages={[]} isPlanning={mode === "planner" && running} plannerStream={{ items: [] }}
      onSendMessage={noop} onRequestConfirmation={noop} onControl={noop} onSave={noop}
      onOpenEditor={noop} onOpenApproval={noop} repoInfo={null} config={config}
      active={running} locked={false} pendingRequest={false} publishing={false} publicationFailed={false}
      nodes={[]} edges={[]} nodeTypes={{}} edgeTypes={{}} tokens={tokens} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
