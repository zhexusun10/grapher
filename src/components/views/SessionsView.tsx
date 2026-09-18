import React, { useState } from "react";
import { Code2, Terminal, FolderGit2, GitBranch, ArrowRight } from "lucide-react";
import { Snapshot, Execution } from "../../types";
import { ExecutionTranscript } from "../ExecutionTranscript";
import { ExecutionTiming } from "../ExecutionTiming";
import { statusText } from "../graph/TaskNode";

interface SessionsViewProps {
  state: Snapshot;
  selected: string;
  setSelected: (name: string) => void;
  active: boolean;
  locked: boolean;
  onIntervene: (instruction: string, nodeName?: string) => void;
}

export const SessionsView: React.FC<SessionsViewProps> = React.memo(({
  state,
  selected,
  setSelected,
  active,
  locked,
  onIntervene,
}) => {
  const [attemptId, setAttemptId] = useState("");
  const [instruction, setInstruction] = useState("");

  const selectedNode = state.graph.nodes.find((item) => item.name === selected);
  const selectedState = selectedNode ? state.nodes[selectedNode.name] : undefined;
  const attempts = selectedNode
    ? state.executions.filter((item) => item.node === selectedNode.name)
    : [];
  const execution: Execution | undefined = attempts.find((item) => item.id === attemptId) ?? attempts[attempts.length - 1];

  const handleSubmitIntervention = (e: React.FormEvent) => {
    e.preventDefault();
    if (!instruction.trim()) return;
    onIntervene(instruction.trim(), selectedNode?.name);
    setInstruction("");
  };

  return (
    <section className="full-tab-view sessions-view">
      <div className="sessions-container">
        <aside className="sessions-node-list">
          <div className="sessions-list-header">
            <span>节点列表 ({state.graph.nodes.length})</span>
          </div>
          <div className="sessions-list-scroll">
            {state.graph.nodes.length > 0 ? (
              state.graph.nodes.map((node) => {
                const nState = state.nodes[node.name];
                const nAttempts = state.executions.filter((e) => e.node === node.name);
                const isSel = selected === node.name;
                return (
                  <button
                    type="button"
                    key={node.name}
                    className={`session-node-card ${isSel ? "active" : ""}`}
                    onClick={() => setSelected(node.name)}
                  >
                    <div className="card-top">
                      <span className={`status-indicator ${nState?.status ?? "waiting"}`} />
                      <strong>{node.name}</strong>
                    </div>
                    <p className="card-task">{node.task}</p>
                    <div className="card-bottom">
                      <span className={`status-text ${nState?.status ?? "waiting"}`}>
                        {statusText[nState?.status ?? "waiting"]}
                      </span>
                      <span className="attempts-count">{nAttempts.length} 次尝试</span>
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="sessions-empty-hint">
                <Code2 size={24} />
                <span>暂无节点</span>
                <small>在上方输入任务目标后编译生成</small>
              </div>
            )}
          </div>
        </aside>

        <div className="sessions-content">
          {selectedNode ? (
            <div className="sessions-detail-pane">
              <div className="sessions-detail-header">
                <div className="detail-meta">
                  <Code2 size={18} />
                  <h3>{selectedNode.name}</h3>
                  <span className={`phase-tag ${selectedState?.status ?? "waiting"}`}>
                    {statusText[selectedState?.status ?? "waiting"]}
                  </span>
                </div>
                {attempts.length > 0 && (
                  <div className="attempt-select-wrap">
                    <span>执行记录:</span>
                    <select
                      value={execution?.id ?? ""}
                      onChange={(e) => setAttemptId(e.target.value)}
                    >
                      {attempts.map((item) => (
                        <option key={item.id} value={item.id}>
                          #{item.attempt} · {item.status} · {new Date(item.startedAt).toLocaleTimeString()}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <div className="sessions-task-box">
                <div className="task-label"><Terminal size={13} /> TASK SPECIFICATION</div>
                <p>{selectedNode.task}</p>
              </div>

              {execution ? (
                <div className="sessions-log-container">
                  <div className="log-header">
                    <div className="log-header-left">
                      <span className="pi-avatar">π</span>
                      <strong>Pi Session Log</strong>
                      <span className="log-status">{execution.status}</span>
                      <ExecutionTiming execution={execution} />
                    </div>
                    {execution.worktree && (
                      <span className="worktree-pill" title={execution.worktree}>
                        <FolderGit2 size={11} />
                        {execution.worktree.split("/").slice(-2).join("/")}
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <ExecutionTranscript key={execution.id} runId={state.runId} execution={execution} />
                  </div>
                  <div className="worktree-info-footer">
                    <span>Session: <code>{execution.sessionId}</code></span>
                    <span>Commit Before: <code>{execution.before ? execution.before.slice(0, 7) : "-"}</code></span>
                    <span>Commit After: <code>{execution.after ? execution.after.slice(0, 7) : "pending"}</code></span>
                  </div>
                </div>
              ) : (
                <div className="sessions-no-execution">
                  <Terminal size={28} />
                  <h4>全新独立上下文</h4>
                  <p>该节点尚未启动或正在等待前驱依赖完成。计划审批启动后，将在隔离 Git worktree 中执行。</p>
                </div>
              )}

              <form
                className="intervention"
                onSubmit={handleSubmitIntervention}
              >
                <textarea
                  aria-label="节点介入指令"
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder={
                    active
                      ? "执行进行中，先暂停再发送介入指令…"
                      : !state.approved
                      ? "计划审批并启动后可向节点发送介入指令…"
                      : "向该节点发送调整或重写指令…"
                  }
                  disabled={locked || active || !state.approved}
                />
                <div>
                  <span>
                    <GitBranch size={12} />仅增量重跑下游子图
                  </span>
                  <button
                    type="submit"
                    title="发送介入指令"
                    disabled={locked || active || !state.approved || !instruction.trim()}
                  >
                    <ArrowRight size={16} />
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <div className="sessions-select-empty">
              <Terminal size={36} />
              <h3>{state.graph.nodes.length === 0 ? "暂无节点数据" : "请在左侧选择一个节点"}</h3>
              <p>
                {state.graph.nodes.length === 0
                  ? "输入工作目标后，AI 将自动编译并呈现执行工作图。"
                  : "选择任意节点可查看其隔离 worktree 会话、完整执行终端日志并实时下发修正指令。"}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
});

SessionsView.displayName = "SessionsView";
