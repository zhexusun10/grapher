import React from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { ShieldCheck, Code2, LoaderCircle, Check, Circle } from "lucide-react";
import { type Status } from "../../types";

export const statusText: Record<Status, string> = {
  waiting: "WAITING",
  running: "RUNNING",
  blocked: "BLOCKED",
  done: "DONE",
  failed: "FAILED",
  dirty: "DIRTY",
};

export const phaseText: Record<string, string> = {
  draft: "草稿",
  awaiting_approval: "等待审批",
  running: "执行中",
  paused: "已暂停",
  completed: "已完成",
  publishing: "正在合并回写",
  merging: "merger 修复冲突中",
  publication_failed: "回写失败",
  needs_attention: "需要介入",
  rejected: "已拒绝",
};

export type WorkNode = Node<{
  name: string;
  task: string;
  status: Status;
  attempts: number;
  hint: string;
  reviewer: boolean;
  selected: boolean;
  worktree: string;
  hasTop: boolean;
  hasBottom: boolean;
  hasLeftTarget: boolean;
  hasLeftSource: boolean;
  hasRightTarget: boolean;
  hasRightSource: boolean;
}, "work">;

export const TaskNode = React.memo(({ data }: NodeProps<WorkNode>) => {
  return (
    <div
      className={`task-node ${data.selected ? "selected" : ""} ${data.status}`}
      title={`${data.task}${data.hint ? `\n\n依赖关系:\n${data.hint}` : ""}\n尝试: ${data.attempts}\n工作区: ${data.worktree || "未生成"}`}
    >
      <Handle id="top" type="target" position={Position.Top}
        className={`react-flow__handle ${data.hasTop ? "connected" : ""}`} />
      <div className="node-heading">
        <span className={`node-icon ${data.reviewer ? "review" : ""}`}>
          {data.reviewer ? <ShieldCheck size={16} /> : <Code2 size={16} />}
        </span>
        <strong>{data.name}</strong>
      </div>
      <p>{data.task}</p>
      <div className="node-footer">
        <span className={`status ${data.status}`}>
          {data.status === "running" ? (
            <LoaderCircle className="spin" size={10} />
          ) : data.status === "done" ? (
            <Check size={11} />
          ) : (
            <Circle size={7} fill="currentColor" />
          )}
          {statusText[data.status]}
        </span>
        <span className="node-attempts-badge">
          {data.attempts > 0 ? `#${data.attempts} 尝试` : "尚未执行"}
        </span>
      </div>
      <Handle id="bottom" type="source" position={Position.Bottom}
        className={`react-flow__handle ${data.hasBottom ? "connected" : ""}`} />
      <Handle id="left-target" type="target" position={Position.Left} style={{ top: "35%" }}
        className={`react-flow__handle ${data.hasLeftTarget ? "connected feedback" : ""}`} />
      <Handle id="left-source" type="source" position={Position.Left} style={{ top: "65%" }}
        className={`react-flow__handle ${data.hasLeftSource ? "connected feedback" : ""}`} />
      <Handle id="right-target" type="target" position={Position.Right} style={{ top: "35%" }}
        className={`react-flow__handle ${data.hasRightTarget ? "connected feedback" : ""}`} />
      <Handle id="right-source" type="source" position={Position.Right} style={{ top: "65%" }}
        className={`react-flow__handle ${data.hasRightSource ? "connected feedback" : ""}`} />
    </div>
  );
});

TaskNode.displayName = "TaskNode";
