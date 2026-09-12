import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type NodeProps, type Node, type Edge } from "@xyflow/react";
import { ArrowDown, ArrowRight, Check, ChevronDown, ChevronRight, Circle, Clock3, Code2, FileText, FolderGit2, GitBranch, GitFork, History, Layers3, LoaderCircle, MessageSquare, MoreHorizontal, Pause, Play, Plus, RotateCcw, Settings2, ShieldCheck, Sparkles, Terminal, Workflow, X } from "lucide-react";
import { defaultConfig, example, preview, type Bootstrap, type Config, type Graph, type Snapshot, type Status } from "./types";

const desktop = isTauri();
const statusText: Record<Status, string> = { waiting: "WAITING", running: "RUNNING", blocked: "BLOCKED", done: "DONE", failed: "FAILED", dirty: "DIRTY" };
const phaseText: Record<string, string> = { draft: "草稿", awaiting_approval: "等待审批", running: "执行中", paused: "已暂停", completed: "已完成", needs_attention: "需要介入", rejected: "已拒绝" };
type WorkNode = Node<{ name: string; task: string; status: Status; attempts: number; revision: number; hint: string; reviewer: boolean; selected: boolean; worktree: string }, "work">;

function TaskNode({ data }: NodeProps<WorkNode>) {
  return <div className={`task-node ${data.selected ? "selected" : ""} ${data.status}`} title={`${data.task}\n${data.hint}\nRevision: ${data.revision} · Attempts: ${data.attempts}\nWorkspace: ${data.worktree || "Not created"}`}>
    <Handle type="target" position={Position.Top} />
    <div className="node-heading"><span className={`node-icon ${data.reviewer ? "review" : ""}`}>{data.reviewer ? <ShieldCheck size={17} /> : data.name.includes("spec") ? <FileText size={17} /> : <Code2 size={17} />}</span><strong>{data.name}</strong><MoreHorizontal size={15} /></div>
    <p>{data.task}</p>
    <div className="node-footer"><span className={`status ${data.status}`}>{data.status === "running" ? <LoaderCircle className="spin" size={10} /> : data.status === "done" ? <Check size={11} /> : <Circle size={7} fill="currentColor" />}{statusText[data.status]}</span><span>{data.attempts ? `#${data.attempts} · fresh Pi` : "fresh Pi"}</span></div>
    <Handle type="source" position={Position.Bottom} />
    <Handle id="feedback-out" type="source" position={Position.Left} />
    <Handle id="feedback-in" type="target" position={Position.Left} />
  </div>;
}
const nodeTypes = { work: TaskNode };

function readableLog(output: string) {
  return output.split("\n").map((line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") return event.assistantMessageEvent.delta;
      if (event.type === "tool_execution_start") return `\n$ ${event.toolName}\n${JSON.stringify(event.args, null, 2)}\n`;
      if (event.type === "tool_execution_end") return `\n${(event.result?.content ?? []).filter((item: { type: string }) => item.type === "text").map((item: { text: string }) => item.text).join("\n")}\n`;
      if (event.type === "session") return `Session ${event.id}\n`;
      return "";
    } catch { return `${line}\n`; }
  }).join("");
}

export default function App() {
  const [state, setState] = useState<Snapshot>(preview);
  const [config, setConfig] = useState<Config>(defaultConfig);
  const [goal, setGoal] = useState(example.originalGoal);
  const [selected, setSelected] = useState("frontend");
  const [tab, setTab] = useState<"conversation" | "history">("conversation");
  const [modal, setModal] = useState<"settings" | "editor" | "approval" | null>(null);
  const [editor, setEditor] = useState("");
  const [args, setArgs] = useState("[]");
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<string[]>([]);
  const [historical, setHistorical] = useState(false);
  const [attemptId, setAttemptId] = useState("");
  const [dataPath, setDataPath] = useState("");

  const load = useCallback(async () => {
    if (!desktop) return;
    const data = await invoke<Bootstrap>("bootstrap");
    setConfig(data.config); setArgs(JSON.stringify(data.config.piArgs)); setRuns(data.runs); setDataPath(data.dataPath);
    if (data.snapshot.runId) { setState(data.snapshot); setGoal(data.snapshot.graph.originalGoal); }
  }, []);
  useEffect(() => { load().catch((error) => setError(String(error))); }, [load]);
  useEffect(() => {
    if (!desktop || historical || busy) return;
    const interval = setInterval(() => { invoke<Snapshot>("snapshot").then((snapshot) => { if (snapshot.runId) setState(snapshot); }).catch((error) => setError(String(error))); }, 700);
    return () => clearInterval(interval);
  }, [historical, busy]);
  useEffect(() => { setAttemptId(""); }, [selected, state.runId]);

  const run = async (work: () => Promise<void>) => {
    if (!desktop) { setError("当前是只读界面预览。请运行 npm run desktop 使用 Rust 编译器和执行引擎。"); return; }
    setBusy(true); setError("");
    try { await work(); } catch (error) { setError(typeof error === "string" ? error : JSON.stringify(error)); }
    finally { setBusy(false); }
  };
  const control = (action: string, extra = {}) => run(async () => {
    const snapshot = await invoke<Snapshot>("control", { action, node: selected, instruction, ...extra });
    setState(snapshot); setModal(null); if (action === "intervene") setInstruction("");
  });
  const save = (graph: Graph) => run(async () => {
    const snapshot = await invoke<Snapshot>("save_graph", { graph, config });
    setState(snapshot); setGoal(graph.originalGoal); setModal(null); setHistorical(false); setRuns((runs) => [snapshot.runId, ...runs.filter((run) => run !== snapshot.runId)]);
  });
  const selectedNode = state.graph.nodes.find((node) => node.name === selected);
  const selectedState = state.nodes[selected];
  const attempts = state.executions.filter((execution) => execution.node === selected);
  const execution = attempts.find((execution) => execution.id === attemptId) ?? attempts.at(-1);
  const active = Object.values(state.nodes).some((node) => node.status === "running");
  const completed = Object.values(state.nodes).filter((node) => node.status === "done").length;
  const locked = busy || historical;

  const nodes = useMemo<WorkNode[]>(() => {
    const layers = state.plan?.executionBatches ?? [state.graph.nodes.map((node) => node.name)];
    return state.graph.nodes.map((node) => {
      const layer = Math.max(0, layers.findIndex((batch) => batch.includes(node.name)));
      const batch = layers[layer];
      const attempts = state.executions.filter((execution) => execution.node === node.name);
      return { id: node.name, type: "work", position: { x: (batch.indexOf(node.name) - (batch.length - 1) / 2) * 260 + 160, y: layer * 155 + 20 }, data: {
        name: node.name, task: node.task, status: state.nodes[node.name]?.status ?? "waiting", attempts: attempts.length, revision: state.nodes[node.name]?.revision ?? 1,
        hint: state.graph.edges.filter((edge) => edge.to === node.name || edge.from === node.name && edge.feedback).map((edge) => `${edge.from} → ${edge.to}: ${edge.relation}${edge.feedback ? " (feedback)" : ""}`).join("\n"),
        reviewer: state.graph.edges.some((edge) => edge.from === node.name && edge.feedback), selected: selected === node.name, worktree: attempts.at(-1)?.worktree ?? "",
      } };
    });
  }, [state.graph, state.plan, state.nodes, state.executions, selected]);
  const edges = useMemo<Edge[]>(() => state.graph.edges.map((edge) => ({ id: `${edge.from}->${edge.to}`, source: edge.from, target: edge.to, type: "smoothstep", sourceHandle: edge.feedback ? "feedback-out" : undefined, targetHandle: edge.feedback ? "feedback-in" : undefined,
    animated: !edge.feedback && state.nodes[edge.from]?.status === "running", markerEnd: { type: MarkerType.ArrowClosed, color: edge.feedback ? "#a68cbd" : "#a9b6ac", width: 14, height: 14 },
    style: { stroke: edge.feedback ? "#a68cbd" : "#acb8b0", strokeWidth: 1.5, strokeDasharray: edge.feedback ? "5 5" : undefined }, label: edge.feedback ? "REVISE · ≤ 3".replace("3", String(state.config?.maxFeedback ?? config.maxFeedback)) : undefined, labelStyle: { fontSize: 10, fill: "#9172a8", fontFamily: "monospace" }, labelBgStyle: { fill: "#f8f9fb" },
  })), [state.graph, state.nodes, state.config, config.maxFeedback]);

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={(event) => event.preventDefault()}><span className="brand-mark"><Workflow size={21} /></span>grapher<span className="version">MVP</span></a>
      <button className="project-picker" onClick={() => setModal("settings")}><span className="project-avatar">G</span><span>Local workspace<small>{config.engine === "demo" ? "安全演示环境" : config.repository.split("/").pop() || "选择项目"}</small></span><ChevronDown size={14} /></button>
      <div className="nav-section">WORKSPACE</div>
      <button className="nav-item current" onClick={() => { setHistorical(false); load().catch((error) => setError(String(error))); }}><GitFork size={17} />执行图<span className="nav-count">{runs.length || 1}</span></button>
      <button className="nav-item" onClick={() => setTab("history")}><History size={17} />执行历史</button>
      <button className="nav-item" onClick={() => setModal("settings")}><Settings2 size={17} />运行设置</button>
      <div className="nav-section runs-label">RECENT GRAPHS<button title="新建执行图" onClick={() => { setEditor(JSON.stringify({ ...example, originalGoal: goal }, null, 2)); setModal("editor"); }}><Plus size={15} /></button></div>
      {runs.length ? runs.slice(0, 8).map((id, index) => <button className={`run-item ${state.runId === id ? "chosen" : ""}`} key={id} onClick={() => run(async () => { const snapshot = await invoke<Snapshot>("history", { runId: id }); setState(snapshot); setHistorical(true); })}><span className="run-dot" /><span>Graph {id.slice(0, 6)}<small>{index === 0 ? "最近运行" : "历史快照 · 只读"}</small></span></button>) : <div className="run-placeholder"><GitBranch size={14} />你的第一张执行图</div>}
      <div className="sidebar-bottom"><div className="local-indicator"><span />Local-first runtime</div><p>Planner plans.<br />Runtime executes.</p><div className="profile"><span>G</span><div>个人工作区<small>Grapher v0.1.0</small></div><Settings2 size={15} onClick={() => setModal("settings")} /></div></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><FolderGit2 size={16} /><span>Workspace</span><ChevronRight size={13} /><strong>Execution graph</strong></div><div className="topbar-right"><span className="engine-pill"><span />{config.engine === "demo" ? "Demo engine" : "Pi engine"}</span><button className="icon-button" title="运行设置" onClick={() => setModal("settings")}><Settings2 size={17} /></button></div></header>
      <section className="workspace-heading"><div><div className="eyebrow">DON’T ORCHESTRATE AGENTS. COMPILE WORK.</div><h1>把工作，编译成图<span>。</span></h1><p>先规划，再审批。让独立的 Pi 执行实例把工作向前推进。</p></div><button className="secondary" onClick={() => { setEditor(JSON.stringify(state.graph, null, 2)); setModal("editor"); }}><Code2 size={15} />Graph IR</button></section>
      <section className="intent-bar"><div className="intent-icon"><Sparkles size={19} /></div><input aria-label="工作目标" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="描述你想完成的工作…" disabled={busy} /><button className="primary" disabled={locked || active || !goal.trim()} onClick={() => config.engine === "demo" ? save({ ...example, originalGoal: goal }) : run(async () => {
        const snapshot = await invoke<Snapshot>("plan_goal", { goal, config }); setState(snapshot); setHistorical(false); setRuns((runs) => [snapshot.runId, ...runs]);
      })}>{busy ? <LoaderCircle size={15} className="spin" /> : <Workflow size={16} />}{busy ? "处理中…" : config.engine === "demo" ? "编译演示图" : "规划并编译"}<ArrowRight size={14} /></button></section>
      <div className="context-row"><span><ShieldCheck size={13} />{desktop ? config.engine === "demo" ? "固定示例图 · 不调用模型 · 可用 Graph IR 编辑" : "规划将调用模型并消耗额度 · 工作节点执行前必须审批" : "浏览器只读预览 · 执行功能请启动 Tauri 桌面版"}</span><span><Layers3 size={12} />{state.graph.nodes.length} nodes<em />{state.plan?.executionBatches.length ?? "—"} layers</span></div>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="关闭错误" onClick={() => setError("")}><X size={15} /></button></div>}
      {historical && <div className="history-banner">正在查看历史快照（只读）<button onClick={() => { setHistorical(false); load().catch((error) => setError(String(error))); }}>返回当前运行 <ArrowRight size={13} /></button></div>}
      <section className="workbench">
        <div className="conversation-pane">
          <div className="pane-tabs"><button className={tab === "conversation" ? "active" : ""} onClick={() => setTab("conversation")}><MessageSquare size={14} />节点对话</button><button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}><History size={14} />事件历史<span>{state.events.filter((event) => event.type !== "output").length}</span></button></div>
          {tab === "conversation" ? <>
            <div className="conversation-heading"><div className="detail-icon"><Code2 size={18} /></div><div><h2>{selectedNode?.name ?? "选择一个节点"}</h2><span>Revision {selectedState?.revision ?? 1} <b>·</b> {attempts.length ? `${attempts.length} execution attempts` : "尚未启动执行实例"}</span></div><span className={`status ${selectedState?.status ?? "waiting"}`}>{statusText[selectedState?.status ?? "waiting"]}</span></div>
            <div className="conversation-scroll">
              <div className="task-card"><div><FileText size={13} />SPECIFIC TASK</div><p>{selectedNode?.task ?? "点击右侧节点，查看其任务定义和执行历史。"}</p></div>
              {attempts.length > 0 && <label className="attempt-picker">Execution<select value={execution?.id ?? ""} onChange={(event) => setAttemptId(event.target.value)}>{attempts.map((execution) => <option key={execution.id} value={execution.id}>#{execution.attempt} · revision {execution.revision} · {execution.status}</option>)}</select></label>}
              {execution ? <><div className="session-label"><span className="pi-avatar">π</span><strong>Pi</strong><span>fresh instance</span><time>{new Date(execution.startedAt).toLocaleTimeString()}</time></div><pre className="execution-log">{readableLog(execution.output) || "正在准备隔离工作区…"}</pre><details className="workspace-details"><summary><FolderGit2 size={12} />Workspace & session</summary><p>{execution.worktree}</p><p>Session: {execution.sessionId}</p><p>Before: {execution.before}</p><p>After: {execution.after ?? "pending"}</p><p>结果保存在此 worktree；不会自动合入原仓库。</p></details></> : <div className="conversation-empty"><div className="empty-orbit"><Terminal size={23} /><span /></div><h3>每次执行，全新上下文</h3><p>审批后，此节点将在独立 worktree 中启动<br />一个全新的 Pi 实例。对话与工具输出将在这里出现。</p><div><span>独立会话</span><span>文件系统传递</span><span>完整历史</span></div></div>}
              {selectedState?.error && <div className="node-error">{selectedState.error}{selectedState.status === "blocked" && <button className="secondary" disabled={locked || active} onClick={() => control("resolve")}>Use resolved workspace</button>}</div>}
            </div>
            <form className="intervention" onSubmit={(event) => { event.preventDefault(); control("intervene"); }}><textarea aria-label="节点介入指令" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={active ? "先暂停并等待当前执行结束，再介入…" : "给这个节点一条新指令…"} disabled={locked || active || !state.approved} /><div><span><GitBranch size={12} />仅重跑受影响的下游子图</span><button type="submit" title="发送介入指令" disabled={locked || active || !state.approved || !instruction.trim()}><ArrowRight size={16} /></button></div></form>
          </> : <div className="timeline">{state.events.filter((event) => event.type !== "output").length === 0 ? <div className="timeline-empty"><Clock3 size={23} /><h3>历史从第一次编译开始</h3><p>审批、执行、反馈和介入都会持久化到 SQLite。</p></div> : state.events.filter((event) => event.type !== "output").slice().reverse().map((event) => <div className="timeline-event" key={event.sequence}><span className={`event-dot ${event.type}`} /><div><strong>{event.type.replaceAll("_", " ")}</strong><p>{event.node ?? event.execution?.node ?? (event.from ? `${event.from} → ${event.to}` : `Event #${event.sequence}`)}{event.type === "feedback" ? event.accepted ? " · ACCEPT" : " · REVISE" : ""}</p>{event.error && <p className="event-error">{event.error}</p>}<time>{new Date(event.timestamp).toLocaleTimeString()}</time></div></div>)}</div>}
        </div>
        <div className="graph-pane"><div className="graph-toolbar"><div><Workflow size={16} /><strong>Execution graph</strong><span className={`phase ${state.phase}`}>{phaseText[state.phase] ?? "草稿"}</span></div><button className="icon-button" title="编辑 Graph IR" onClick={() => { setEditor(JSON.stringify(state.graph, null, 2)); setModal("editor"); }}><Code2 size={16} /></button></div>
          <div className="graph-canvas"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodeClick={(_, node) => { setSelected(node.id); setTab("conversation"); }} fitView fitViewOptions={{ padding: 0.12 }} minZoom={0.4} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}><Background color="#d8dedb" gap={20} size={1} /><Controls showInteractive={false} /></ReactFlow><div className="graph-note"><span className="note-line" />Dependency<span className="note-line feedback" />Feedback</div><div className="planner-off"><span />Planner {state.approved ? "offline" : "not running"}<span className="planner-cost">0 runtime tokens</span></div></div>
          <div className="graph-bottom"><div className="progress-label"><span><span className="progress-dot" />{completed} / {state.graph.nodes.length} 节点完成</span><span>并发上限 {state.config?.maxParallel ?? config.maxParallel}</span></div><div className="progress-track"><div style={{ width: `${completed / Math.max(1, state.graph.nodes.length) * 100}%` }} /></div>
            <div className="approval-row"><span><ShieldCheck size={16} />{state.approved ? "确定性运行时已接管" : "你的审批是执行的前提"}</span><div>{state.phase === "awaiting_approval" ? <><button className="text-button" disabled={locked} onClick={() => control("reject")}>拒绝</button><button className="primary" disabled={locked} onClick={() => setModal("approval")}><Play size={13} fill="currentColor" />Approve & Start</button></> : state.approved ? <><button className="secondary" disabled={locked || active} onClick={() => control("intervene", { instruction: "Rerun this task, verify the previous result, and complete the original requirements." })}><RotateCcw size={13} />重跑节点</button><button className="primary" disabled={locked || state.phase === "completed"} onClick={() => control(state.paused ? "resume" : "pause")}>{state.paused ? <Play size={13} /> : <Pause size={13} />}{state.paused ? "继续" : "暂停"}</button></> : <button className="secondary" disabled={locked || active} onClick={() => save({ ...state.graph, originalGoal: goal })}><Check size={14} />编译并检查</button>}</div></div>
          </div>
        </div>
      </section>
      <footer className="workspace-footer"><span><span />{desktop ? "Rust runtime · SQLite event store" : "Interface preview · no runtime connected"}</span><span>Git carries workspace state.<ArrowDown size={11} /> Humans stay in control.</span></footer>
    </main>
    {modal && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setModal(null); }}><section className={`modal ${modal === "editor" ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><h2 id="modal-title">{modal === "settings" ? "运行设置" : modal === "editor" ? "Graph IR · 编辑与编译" : "审批执行计划"}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={() => setModal(null)}><X size={19} /></button></header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {modal === "settings" ? <><div className="settings-grid"><label>执行引擎<select value={config.engine} onChange={(event) => setConfig({ ...config, engine: event.target.value as Config["engine"] })}><option value="demo">Demo · 隔离仓库，不调用模型</option><option value="pi">Pi · 真实模型与代码执行</option></select></label><label>Git 仓库根路径<input value={config.repository} onChange={(event) => setConfig({ ...config, repository: event.target.value })} placeholder="/Users/you/project" /></label><label>Pi 可执行文件<input value={config.piCommand} onChange={(event) => setConfig({ ...config, piCommand: event.target.value })} placeholder="pi 或绝对路径" /></label><label>启动参数（JSON 数组，不经 shell）<textarea value={args} onChange={(event) => setArgs(event.target.value)} rows={3} /></label><label>模型（留空使用 Pi 默认值）<input value={config.model} onChange={(event) => setConfig({ ...config, model: event.target.value })} placeholder="provider/model" /></label><div className="field-pair"><label>并发上限<input type="number" min={1} max={8} value={config.maxParallel} onChange={(event) => setConfig({ ...config, maxParallel: Number(event.target.value) })} /></label><label>反馈重试上限<input type="number" min={0} max={10} value={config.maxFeedback} onChange={(event) => setConfig({ ...config, maxFeedback: Number(event.target.value) })} /></label></div><p className="settings-note">新设置只用于下一次编译，已审批的运行不会改变。Pi 使用自身的登录凭证；Grapher 不保存 API Key。<br />数据目录：{dataPath || "桌面启动后可用"}</p></div><footer><button className="primary" onClick={() => { try { const value: unknown = JSON.parse(args); if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("启动参数必须是字符串数组"); setConfig({ ...config, piArgs: value }); setModal(null); } catch (error) { setError(String(error)); } }}>应用到下一次编译<Check size={14} /></button></footer></> : modal === "editor" ? <><p className="modal-description">使用语义化 name 引用节点。保存将由 Rust 编译器验证，并创建需要重新审批的新运行。</p><textarea className="json-editor" aria-label="Graph JSON" value={editor} onChange={(event) => setEditor(event.target.value)} spellCheck={false} /><footer><button className="secondary" onClick={() => setEditor(JSON.stringify(example, null, 2))}>载入示例</button><button className="primary" disabled={busy || active} onClick={() => { try { save(JSON.parse(editor) as Graph); } catch (error) { setError(String(error)); } }}><Check size={14} />验证并保存</button></footer></> : <><div className="approval-summary"><ShieldCheck size={32} /><h3>{state.graph.nodes.length} 个节点，{state.plan?.executionBatches.length} 个执行层</h3><p>{state.graph.originalGoal}</p><ul><li>{state.config?.engine === "demo" ? "使用专用演示仓库，不调用真实模型。" : `在 ${state.config?.repository} 创建独立 Git worktree。`}</li><li>每次尝试启动 fresh Pi；反馈最多重试 {state.config?.maxFeedback} 次。</li><li>不会自动修改或合并你的原始工作目录。</li>{state.config?.engine === "pi" && <li className="warning">Pi 可运行 shell 命令、联网并产生模型费用。Git worktree 不是安全沙箱；仅对可信任务和仓库审批。规划阶段也会消耗模型额度。</li>}</ul>{state.plan?.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}</div><footer><button className="secondary" onClick={() => { setEditor(JSON.stringify(state.graph, null, 2)); setModal("editor"); }}>编辑计划</button><button className="primary" disabled={busy} onClick={() => control("approve")}><Play size={14} />确认审批并启动</button></footer></>}
    </section></div>}
  </div>;
}
