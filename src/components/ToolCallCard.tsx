import React, { useState, useMemo } from "react";
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
  AlertTriangle,
  Loader2,
  Copy,
  Check,
} from "lucide-react";
import { TranscriptItem } from "../types";

interface ToolCallCardProps {
  item: TranscriptItem;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export const ToolCallCard: React.FC<ToolCallCardProps> = React.memo(
  ({ item, defaultExpanded = false, expanded, onExpandedChange }) => {
    const [isCopied, setIsCopied] = useState(false);

    const toolName = item.toolName || "tool";
    const args = item.args || {};
    const status = item.status || "success";

    // Extract structured exit code
    const exitCode = useMemo(() => {
      if (typeof item.exitCode === "number") return item.exitCode;
      return null;
    }, [item.exitCode]);

    const isError = item.isError || status === "error" || (exitCode !== null && exitCode !== 0);

    // Detect if output was truncated
    const isTruncated = useMemo(() => {
      if (item.truncated) return true;
      if (item.result) {
        return item.result.includes("[Showing lines") || item.result.includes("Full output:");
      }
      return false;
    }, [item.truncated, item.result]);

    // Detect masked subcommand step errors or real test failures (avoiding false positives from mere word FAIL)
    const hasSubcommandWarning = useMemo(() => {
      if (isError || exitCode !== 0 || !item.result) return false;
      const text = item.result;
      return (
        text.includes("[grapher:step_error") ||
        /\b(?:not ok\s+\d+|✖\s+[^\n]+|AssertionError:)\b/.test(text)
      );
    }, [isError, exitCode, item.result]);

    const [localExpanded, setIsExpanded] = useState(defaultExpanded || isError || hasSubcommandWarning);
    const isExpanded = expanded ?? localExpanded;
    const toggleExpanded = () => {
      setIsExpanded(!isExpanded);
      onExpandedChange?.(!isExpanded);
    };

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
      <div
        className={`tool-call-card ${meta.type} ${status} ${
          isError ? "error" : hasSubcommandWarning ? "warning" : ""
        }`}
        data-testid="tool-call-card"
      >
        <div
          className="tool-call-header"
          onClick={toggleExpanded}
          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleExpanded(); } }}
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
            {isTruncated && (
              <span className="tool-truncated-pill" title="输出已截断，可通过详情或全量输出文件查看完整日志">
                已截断
              </span>
            )}
            {status === "running" && (
              <span className="tool-status running">
                <Loader2 size={12} className="spin" />
                <span>执行中...</span>
              </span>
            )}
            {status !== "running" && !isError && !hasSubcommandWarning && (
              <span
                className="tool-status success"
                title={
                  toolName === "bash"
                    ? `执行成功${exitCode !== null ? `，退出码: ${exitCode}` : ""}`
                    : "执行成功"
                }
              >
                <CheckCircle2 size={13} />
                <span>
                  {toolName === "bash"
                    ? exitCode !== null
                      ? `完成 (Exit ${exitCode})`
                      : "完成"
                    : "完成"}
                </span>
              </span>
            )}
            {status !== "running" && !isError && hasSubcommandWarning && (
              <span
                className="tool-status warning"
                title="命令退出码为 0，但输出中包含被遮蔽的子步骤警告"
              >
                <AlertTriangle size={13} />
                <span>包含警告/错误</span>
              </span>
            )}
            {isError && (
              <span
                className="tool-status error"
                title={
                  toolName === "bash"
                    ? `执行失败${exitCode !== null ? `，退出码: ${exitCode}` : " (退出码未知)"}`
                    : "执行失败"
                }
              >
                <AlertCircle size={13} />
                <span>
                  {toolName === "bash"
                    ? exitCode !== null
                      ? `失败 (Exit ${exitCode})`
                      : "失败 (退出码未知)"
                    : "失败"}
                </span>
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
            {toolName === "bash" && (
              <div className="tool-meta-bar">
                <div className="tool-meta-item">
                  <span className="meta-lbl">退出码:</span>
                  <span
                    className={`meta-val ${
                      exitCode === 0 ? "success" : exitCode !== null ? "error" : "neutral"
                    }`}
                  >
                    {exitCode !== null ? exitCode : "退出码未知"}
                  </span>
                </div>
                <div className="tool-meta-item">
                  <span className="meta-lbl">输出状态:</span>
                  <span className={`meta-val ${isTruncated ? "warning" : "neutral"}`}>
                    {isTruncated ? "已截断 (Truncated)" : "完整 (Complete)"}
                  </span>
                </div>
                {args.command && (
                  <div className="tool-meta-item cmd-full">
                    <span className="meta-lbl">命令:</span>
                    <code className="meta-val-code">{args.command}</code>
                  </div>
                )}
              </div>
            )}

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
                  {isError ? "错误输出 (Error Output)" : "执行结果 (Result Output)"}
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
