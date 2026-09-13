import React, { useState } from "react";
import {
  Terminal,
  FileText,
  FileCode,
  FileEdit,
  GitFork,
  Boxes,
  Compass,
  Wrench,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Copy,
  Check,
} from "lucide-react";
import { TranscriptItem } from "../types";

interface ToolCallCardProps {
  item: TranscriptItem;
  defaultExpanded?: boolean;
}

export const ToolCallCard: React.FC<ToolCallCardProps> = React.memo(
  ({ item, defaultExpanded = false }) => {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded || item.status === "error");
    const [isCopied, setIsCopied] = useState(false);

    const toolName = item.toolName || "tool";
    const args = item.args || {};
    const status = item.status || "success";
    const isError = item.isError || status === "error";

    // Select icon & title based on tool type
    const getToolMeta = () => {
      switch (toolName) {
        case "bash":
          return {
            icon: <Terminal size={14} className="tool-icon bash" />,
            badge: "bash",
            summary: args.command ? `$ ${args.command}` : "执行系统终端命令",
            type: "terminal",
          };
        case "read":
          return {
            icon: <FileText size={14} className="tool-icon read" />,
            badge: "read",
            summary: args.path || args.file || "读取工作区文件",
            type: "file",
          };
        case "write":
          return {
            icon: <FileCode size={14} className="tool-icon write" />,
            badge: "write",
            summary: args.path || args.file || "写入或创建文件",
            type: "file",
          };
        case "edit":
          return {
            icon: <FileEdit size={14} className="tool-icon edit" />,
            badge: "edit",
            summary: args.path || args.file || "代码编辑与修改",
            type: "file",
          };
        case "route_task":
          return {
            icon: <Compass size={14} className="tool-icon route" />,
            badge: "route_task",
            summary: args.plan_type ? `决定任务路线: [${args.plan_type}]` : "任务路线决策",
            type: "route",
          };
        case "node":
          return {
            icon: <Boxes size={14} className="tool-icon node" />,
            badge: "node",
            summary: args.name ? `创建执行节点 [${args.name}]` : "定义拓扑节点",
            type: "graph",
          };
        case "edge":
          return {
            icon: <GitFork size={14} className="tool-icon edge" />,
            badge: "edge",
            summary:
              args.from && args.to
                ? `${args.feedback ? "反馈边" : "依赖边"}: [${args.from}] → [${args.to}]`
                : "连接依赖关系",
            type: "graph",
          };
        default:
          return {
            icon: <Wrench size={14} className="tool-icon default" />,
            badge: toolName,
            summary: "工具调用",
            type: "custom",
          };
      }
    };

    const meta = getToolMeta();

    const handleCopy = (e: React.MouseEvent) => {
      e.stopPropagation();
      const textToCopy = item.result || JSON.stringify(args, null, 2);
      navigator.clipboard.writeText(textToCopy);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1800);
    };

    return (
      <div className={`tool-call-card ${meta.type} ${status} ${isError ? "error" : ""}`}>
        <div
          className="tool-call-header"
          onClick={() => setIsExpanded((prev) => !prev)}
          role="button"
          tabIndex={0}
        >
          <div className="tool-header-left">
            <span className="tool-expand-icon">
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
            {meta.icon}
            <span className="tool-badge">{meta.badge}</span>
            <span className="tool-summary" title={meta.summary}>
              {meta.summary}
            </span>
          </div>

          <div className="tool-header-right">
            {status === "running" && (
              <span className="tool-status running">
                <Loader2 size={12} className="spin" />
                <span>执行中...</span>
              </span>
            )}
            {status === "success" && !isError && (
              <span className="tool-status success">
                <CheckCircle2 size={13} />
                <span>完成</span>
              </span>
            )}
            {isError && (
              <span className="tool-status error">
                <AlertCircle size={13} />
                <span>失败</span>
              </span>
            )}
            <button
              type="button"
              className="tool-copy-btn"
              onClick={handleCopy}
              title="复制调用参数与结果"
            >
              {isCopied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
        </div>

        {isExpanded && (
          <div className="tool-call-body">
            {Object.keys(args).length > 0 && (
              <div className="tool-args-section">
                <div className="section-label">参数 (Arguments)</div>
                <pre className="tool-args-code">
                  {JSON.stringify(args, null, 2)}
                </pre>
              </div>
            )}

            {item.result !== undefined && item.result !== null && (
              <div className="tool-result-section">
                <div className="section-label">
                  {isError ? "错误输出 (Error)" : "执行结果 (Result)"}
                </div>
                <pre className={`tool-result-code ${isError ? "error" : ""}`}>
                  {item.result.trim() || "(无文本输出)"}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
);

ToolCallCard.displayName = "ToolCallCard";

export default ToolCallCard;
