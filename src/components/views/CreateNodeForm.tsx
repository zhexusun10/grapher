import React, { useState } from "react";
import { AlertTriangle, ArrowLeft, Check } from "lucide-react";
import { t } from "../../i18n";
import type { ManualNodeConfirmation, ManualNodeRequest, Snapshot } from "../../types";
import type { ConfirmModalState } from "../modals/ConfirmModal";

function dependencyDescendants(state: Snapshot, target: string): Set<string> {
  const names = new Set([target]);
  const queue = [target];
  for (let i = 0; i < queue.length; i++) {
    for (const edge of state.graph.edges) {
      if (!edge.feedback && edge.from === queue[i] && !names.has(edge.to)) {
        names.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return names;
}

/** Completed results a new outgoing edge can invalidate now or via feedback. */
export function completedDownstream(state: Snapshot, target: string): ManualNodeConfirmation[] {
  if (!target) return [];
  return [...dependencyDescendants(state, target)].flatMap(name => {
    const node = state.nodes[name];
    return node?.status === "completed" ? [{ name, revision: node.revision, head: node.head }] : [];
  });
}

export function CreateNodeForm({ state, busy, onCancel, onSave, onRequestConfirmation }: {
  state: Snapshot;
  busy: boolean;
  onCancel: () => void;
  onSave: (request: ManualNodeRequest) => Promise<boolean>;
  onRequestConfirmation: (config: ConfirmModalState) => void;
}) {
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [feedback, setFeedback] = useState(false);
  const [error, setError] = useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName || !task.trim()) {
      setError(t("请填写节点名称和任务。"));
      return;
    }
    if (state.graph.nodes.some(node => node.name.toLowerCase() === cleanName.toLowerCase())) {
      setError(t("节点名称已存在，请使用其他名称。"));
      return;
    }
    if (feedback && !to) {
      setError(t("反馈边需要选择目标节点。"));
      return;
    }
    if (!feedback && from && to && from === to) {
      setError(t("前驱和目标不能是同一个节点；如需让新节点反馈给该节点，请将 feedback 设为 true。"));
      return;
    }
    if (feedback && (!from || !dependencyDescendants(state, to).has(from))) {
      setError(t("反馈目标必须是前驱节点或其依赖祖先。"));
      return;
    }
    setError("");
    const completed = completedDownstream(state, to);
    const request: ManualNodeRequest = {
      node: { name: cleanName, task: task.trim() }, from: from || null, to: to || null,
      feedback, confirmedCompleted: completed,
    };
    const save = () => { void onSave(request); };
    if (completed.length) {
      onRequestConfirmation({
        title: t("确认影响已完成的节点？"),
        message: feedback
          ? t("如果新节点发送反馈，目标节点及其下游节点可能重新运行。")
          : t("连接到该节点会使其已完成的结果失效，并重新运行目标节点及其下游节点。"),
        detail: t("受影响的已完成节点：{0}", completed.map(node => node.name).join(", ")),
        confirmText: t("确认并保存"),
        danger: true,
        icon: <AlertTriangle size={18} />,
        onConfirm: save,
      });
    } else {
      save();
    }
  };

  return <div className="initial-query-view create-node-view">
    <div className="conversation-heading">
      <div className="heading-title-col"><h2>{t("新建节点")}</h2></div>
      <button type="button" className="back-to-query-btn" aria-label={t("取消新建节点")} disabled={busy} onClick={onCancel}>
        <ArrowLeft size={16} />
      </button>
    </div>
    <form className="create-node-form" onSubmit={submit}>
      <p className="create-node-description">{t("添加节点并选择它的前驱和后继；留空表示不连接。")}</p>
      <label className="form-field"><span>{t("名称 (name)")}</span>
        <input value={name} onChange={event => setName(event.target.value)} autoFocus required disabled={busy} />
      </label>
      <label className="form-field"><span>{t("任务 (task)")}</span>
        <textarea value={task} onChange={event => setTask(event.target.value)} required disabled={busy} rows={6} />
      </label>
      <label className="form-field"><span>{t("前驱 (from)")}</span>
        <select value={from} onChange={event => setFrom(event.target.value)} disabled={busy}>
          <option value="">{t("无")}</option>
          {state.graph.nodes.map(node => <option key={node.name} value={node.name}>{node.name}</option>)}
        </select>
      </label>
      <label className="form-field"><span>{t("目标 (to)")}</span>
        <select value={to} onChange={event => setTo(event.target.value)} disabled={busy}>
          <option value="">{t("无")}</option>
          {state.graph.nodes.map(node => <option key={node.name} value={node.name}>{node.name}</option>)}
        </select>
      </label>
      <div className="form-field-group">
        <label className="form-field"><span>feedback</span>
          <select value={String(feedback)} onChange={event => setFeedback(event.target.value === "true")} disabled={busy}>
            <option value="false">false</option><option value="true">true</option>
          </select>
        </label>
        <p className="create-node-hint">{t("from → 新节点为普通依赖；feedback 决定新节点 → to 是否为反馈边。反馈目标必须是新节点的依赖祖先。")}</p>
      </div>
      {from && to && !feedback && state.graph.edges.some(edge => !edge.feedback && edge.from === from && edge.to === to) &&
        <p className="create-node-hint">{t("保存后，新节点将插入这两个节点之间，替换原有的直接依赖边。")}</p>}
      {error && <p className="create-node-error" role="alert">{error}</p>}
      <div className="create-node-actions">
        <button type="button" className="create-node-cancel-btn" disabled={busy} onClick={onCancel}>{t("取消")}</button>
        <button type="submit" className="primary save-config-btn" disabled={busy}><Check size={14} />{t("保存")}</button>
      </div>
    </form>
  </div>;
}
