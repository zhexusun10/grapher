import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { PromptBox } from "../../src/components/ui/chatgpt-prompt-input";
import { ComposerModels, type ComposerScope } from "../../src/services/composerCommands";
import { runtimeService } from "../../src/services/runtime";
import { defaultConfig, emptySnapshot, type RoleModelConfig, type Snapshot } from "../../src/types";
import { updateRoleModelConfig } from "../../src/modelConfig";
import "../../src/styles.css";
import "../../src/styles-workbench.css";
import "../../src/tailwind.css";

function Fixture() {
  const params = new URLSearchParams(location.search);
  const [node, setNode] = useState<string | undefined>(params.get("node") || undefined);
  const conversationModel = params.has("conversationModel");
  const [showComposer, setShowComposer] = useState(true);
  const [mode, setMode] = useState<"graph" | "serial">("graph");
  const [config, setConfig] = useState({ ...defaultConfig, repository: "/project", model: "test/one" });
  const [snapshot, setSnapshot] = useState<Snapshot>({ ...emptySnapshot, runId: params.has("run") ? "run-a" : "",
    nodes: { a: { status: "running", revision: 1, head: null, instruction: "", error: null }, b: { status: "waiting", revision: 1, head: null, instruction: "", error: null } } });
  const [calls, setCalls] = useState<unknown[]>([]);
  const [value, setValue] = useState("");
  const save = async (scope: ComposerScope, settings: RoleModelConfig) => {
    setCalls(calls => [...calls, { scope, settings }]);
    if (scope.node) setSnapshot(snapshot => ({ ...snapshot, nodes: { ...snapshot.nodes,
      [scope.node!]: { ...snapshot.nodes[scope.node!], modelConfig: settings, modelOverride: true } } }));
    else setConfig(config => updateRoleModelConfig(config, scope.role, settings));
  };
  const rename = async (runId: string, title: string) => {
    const next = await runtimeService.composerRename({ runId, title });
    setCalls(calls => [...calls, { rename: { runId, title } }]);
    setSnapshot(next);
  };
  return <ComposerModels.Provider value={{ config, snapshot, envOverrides: {}, save, rename }}>
    <div style={{ margin: "400px auto 0", maxWidth: 700 }}>
      <button onClick={() => setMode(mode === "graph" ? "serial" : "graph")}>Switch mode</button>
      <button onClick={() => setNode(node === "a" ? "b" : "a")}>Switch node</button>
      <button onClick={() => setSnapshot(previous => ({ ...previous, runId: previous.runId === "run-a" ? "run-b" : "run-a" }))}>Switch run</button>
      <button onClick={() => setShowComposer(previous => !previous)}>Toggle composer</button>
      {showComposer && <PromptBox repository={config.repository} runId={snapshot.runId || undefined} node={node}
        conversationModel={conversationModel} planMode={mode}
        value={value} onChange={event => setValue(event.target.value)}
        onSubmit={text => { setCalls(calls => [...calls, { prompt: text }]); return true; }} />}
      <output>{JSON.stringify({ calls, config, nodes: snapshot.nodes, title: snapshot.title })}</output>
    </div>
  </ComposerModels.Provider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
