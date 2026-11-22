import { t } from "../i18n";
import React, { useState, useMemo, useRef, useLayoutEffect, useEffect } from "react";
import { CollapsibleCardBody } from "./CollapsibleCardBody";
import { CardReveal } from "./CardReveal";
import { useCardAppear } from "../services/cardAnimations";
import {
  Terminal,
  FileText,
  FileCode,
  FileEdit,
  GitFork,
  Network,
  Compass,
  Globe,
  Wrench,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
  Copy,
  Check,
} from "lucide-react";
import { TranscriptItem } from "../types";
import { formatToolDuration } from "../utils/toolTiming";
import { truncateToolText } from "../services/toolOutput";
import { syncOverscrollContainment } from "../services/transcriptScroll";
import { observeElementResize } from "../services/sharedResizeObserver";

interface ToolCallCardProps {
  item: TranscriptItem;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean, card?: HTMLElement) => void;
}

function compactText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text || undefined;
}

/** One-line summary for the bundled web_search extension tool. */
function webSearchSummary(args: Record<string, any>): string {
  const query = compactText(args.query) || compactText(args.objective);
  const urls = Array.isArray(args.urls)
    ? args.urls.map(compactText).filter((url): url is string => url !== undefined)
    : [];
  if (query) {
    return urls.length
      ? `${query} · ${urls.length === 1 ? urls[0] : t("{0} 个链接", urls.length)}`
      : query;
  }
  if (urls.length === 1) return urls[0];
  if (urls.length > 1) return t("{0} 个链接", urls.length);
  return t("搜索网络或分析指定链接");
}

export const ToolCallCard: React.FC<ToolCallCardProps> = React.memo(
  ({ item, defaultExpanded = false, expanded, onExpandedChange }) => {
    const [isCopied, setIsCopied] = useState(false);
    const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);
    const cardRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      };
    }, []);
    const [localExpanded, setLocalExpanded] = useState(defaultExpanded);
    const isExpanded = expanded ?? localExpanded;

    // Only observe `<pre>` overflow while the card body is actually mounted.
    // Historical conversations can render dozens of collapsed tool cards;
    // skipping per-card ResizeObserver/MutationObserver until expanded keeps
    // scrollback and layout free of idle observer overhead.
    useLayoutEffect(() => {
      const card = cardRef.current;
      if (!card || !isExpanded) return;
      const selector = "pre.tool-command-code, pre.tool-args-code, pre.tool-result-code";
      const observed = new Map<HTMLElement, () => void>();
      const sync = () => {
        const current = new Set(card.querySelectorAll<HTMLElement>(selector));
        for (const node of current) {
          if (!observed.has(node)) {
            observed.set(node, observeElementResize(node, () => syncOverscrollContainment(node)));
          }
          syncOverscrollContainment(node);
        }
        for (const [node, unobserve] of observed) {
          if (current.has(node)) continue;
          unobserve();
          observed.delete(node);
        }
      };
      sync();
      if (typeof MutationObserver === "undefined") {
        return () => {
          for (const unobserve of observed.values()) unobserve();
          observed.clear();
        };
      }
      // Text deltas mutate the existing <pre> content without changing its
      // identity, so watch character data as well as inserted/removed blocks.
      // Mutation callbacks are delivered at the microtask checkpoint before
      // paint, so syncing there updates containment in the same frame; deferring
      // to requestAnimationFrame would leave one frame with stale overscroll.
      const mutations = new MutationObserver(sync);
      mutations.observe(card, { childList: true, characterData: true, subtree: true });
      return () => {
        mutations.disconnect();
        for (const unobserve of observed.values()) unobserve();
        observed.clear();
      };
    }, [isExpanded]);

    const toolName = item.toolName || "tool";
    const args = item.args || {};
    const status = item.status || "success";
    // Also protect direct/live card callers that do not use the JSONL parser.
    const resultPreview = useMemo(() => (item.result ? truncateToolText(item.result) : { text: "", truncated: false }), [item.result]);
    const resultText = resultPreview.text;
    // Direct callers may still hand us whole file bodies as arguments.
    // Skip JSON serialization while collapsed so historical lists stay fast.
    const argsText = useMemo(
      () => (isExpanded ? truncateToolText(JSON.stringify(args, null, 2)) : { text: "", truncated: false }),
      [args, isExpanded],
    );

    // Extract structured exit code
    const exitCode = useMemo(() => {
      if (typeof item.exitCode === "number") return item.exitCode;
      return null;
    }, [item.exitCode]);

    const isError = item.isError || status === "error" || (exitCode !== null && exitCode !== 0);

    // Only the tool's own result truncation matters here. Bounded previews for
    // display (the 100 KiB result/argument cap) are an implementation detail and
    // must not present the tool call as truncated.
    const isTruncated = useMemo(() => {
      return !!(item.truncated ||
        resultText.includes("[Showing lines") || resultText.includes("Full output:"));
    }, [item.truncated, resultText]);

    // Detect masked subcommand step errors or real test failures (avoiding false positives from mere word FAIL)
    const hasSubcommandWarning = useMemo(() => {
      if (isError || exitCode !== 0) return false;
      if (item.subcommandWarning) return true;
      if (!resultText) return false;
      const text = resultText;
      return (
        text.includes("[grapher:step_error") ||
        /\b(?:not ok\s+\d+|✖\s+[^\n]+|AssertionError:)\b/.test(text)
      );
    }, [isError, exitCode, item.subcommandWarning, resultText]);

    const toggleExpanded = () => {
      setLocalExpanded(!isExpanded);
      onExpandedChange?.(!isExpanded, cardRef.current ?? undefined);
    };

    // Select icon & title based on tool type
    const getToolMeta = () => {
      switch (toolName) {
        case "bash":
          return {
            icon: <Terminal size={14} className="tool-icon bash" />,
            badge: "bash",
            summary: args.command ? `> ${args.command}` : t("执行系统终端命令"),
            type: "terminal",
          };
        case "read":
          return {
            icon: <FileText size={14} className="tool-icon read" />,
            badge: "read",
            summary: args.path || t("读取工作区文件"),
            type: "file",
          };
        case "write":
          return {
            icon: <FileCode size={14} className="tool-icon write" />,
            badge: "write",
            summary: args.path || t("写入或创建文件"),
            type: "file",
          };
        case "edit":
          return {
            icon: <FileEdit size={14} className="tool-icon edit" />,
            badge: "edit",
            summary: args.path || t("代码编辑与修改"),
            type: "file",
          };
        case "route_task":
          return {
            icon: <Compass size={14} className="tool-icon route" />,
            badge: "route_task",
            summary: args.plan_type ? t("决定任务路线: [{0}]", args.plan_type) : t("任务路线决策"),
            type: "route",
          };
        case "read_graph":
          return {
            icon: <Network size={14} className="tool-icon read" />,
            badge: "read_graph",
            summary: t("读取任务图"),
            type: "graph",
          };
        case "edit_graph":
          return {
            icon: <GitFork size={14} className="tool-icon edge" />,
            badge: "edit_graph",
            summary: t("编辑任务图"),
            type: "graph",
          };
        case "web_search":
          return {
            icon: <Globe size={14} className="tool-icon web" />,
            badge: "web_search",
            summary: webSearchSummary(args),
            type: "web",
          };
        default:
          return {
            icon: <Wrench size={14} className="tool-icon default" />,
            badge: toolName,
            summary: t("工具调用"),
            type: "custom",
          };
      }
    };

    const meta = getToolMeta();

    const handleCopy = (e: React.MouseEvent) => {
      e.stopPropagation();
      const textToCopy = resultText || (argsText.text || truncateToolText(JSON.stringify(args, null, 2)).text);
      if (!textToCopy || !navigator.clipboard?.writeText) return;
      navigator.clipboard.writeText(textToCopy).then(() => {
        if (!mountedRef.current) return;
        setIsCopied(true);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => { if (mountedRef.current) setIsCopied(false); }, 1800);
      }).catch(() => {});
    };

    const isInterrupted = useMemo(
      () => Boolean(item.interruptedOutput) || /(?:中断|终止|terminated|interrupted)/i.test(resultText),
      [item.interruptedOutput, resultText]
    );

    const animateAppear = useCardAppear(item.id, status === "running", item.timestamp, item.animateAppear);

    // Only the duration the runtime measured and the backend relayed is
    // shown; a command that is still running has no such value yet.
    const timing = useMemo(() => {
      if (toolName !== "bash" || typeof item.durationMs !== "number") return null;
      return { label: t("命令耗时:"), value: formatToolDuration(item.durationMs) };
    }, [toolName, item.durationMs]);

    return (
      <CardReveal animate={animateAppear}>
        <div
          ref={cardRef}
          className={`tool-call-card ${meta.type} ${status}${
            isError ? " error" : hasSubcommandWarning ? " warning" : ""
          }${animateAppear ? " appear-active" : ""}`}
          data-testid="tool-call-card"
        >
          <div
            className="tool-call-header"
            onClick={toggleExpanded}
            onMouseDown={(event) => {
              // Match the reasoning cards: a pointer click is only a disclosure
              // toggle, so it must not pull keyboard focus (and its Enter/Space
              // handling) out of the composer. Tab still focuses the header.
              if ((event.target as HTMLElement).closest("button")) return;
              event.preventDefault();
            }}
            onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleExpanded(); } }}
            role="button"
            aria-expanded={isExpanded}
            tabIndex={0}
          >
            <div className="tool-header-left">
              <span className="tool-expand-icon">
                <ChevronRight size={14} className={`tool-expand-chevron ${isExpanded ? "open" : ""}`} />
              </span>
              {meta.icon}
              <span className="tool-badge">{meta.badge}</span>
              <span className="tool-summary">
                {meta.summary}
              </span>
            </div>

            <div className="tool-header-right">
              {isTruncated && (
                <span className="tool-truncated-pill">
                  {t("已截断")}</span>
              )}
              {status === "running" && (
                <span className="tool-status running">
                  <Loader2 size={12} className="spin" />
                  <span>{item.toolPhase === "generating" ? t("正在生成调用…")
                    : item.toolPhase === "pending" ? t("等待执行…") : t("执行中...")}</span>
                </span>
              )}
              {status === "interrupted" && (
                <span className="tool-status interrupted">
                  <AlertCircle size={13} />
                  <span>{t("已中断")}</span>
                </span>
              )}
              {status !== "running" && status !== "interrupted" && !isError && !hasSubcommandWarning && (
                <span className="tool-status success">
                  <CheckCircle2 size={13} />
                  <span>
                    {toolName === "bash"
                      ? exitCode !== null
                        ? t("完成 (Exit {0})", exitCode)
                        : t("完成")
                      : t("完成")}
                  </span>
                </span>
              )}
              {status !== "running" && status !== "interrupted" && !isError && hasSubcommandWarning && (
                <span className="tool-status warning">
                  <AlertTriangle size={13} />
                  <span>{t("包含警告/错误")}</span>
                </span>
              )}
              {isError && (
                <span className="tool-status error">
                  <AlertCircle size={13} />
                  <span>
                    {toolName === "bash"
                      ? exitCode !== null
                        ? t("失败 (Exit {0})", exitCode)
                        : isInterrupted
                          ? t("已中断")
                          : t("失败 (退出码未知)")
                      : isInterrupted
                        ? t("已中断")
                        : t("失败")}
                  </span>
                </span>
              )}
              <button
                type="button"
                className="tool-copy-btn"
                onClick={handleCopy}
                aria-label={t("复制调用参数与结果")}
              >
                {isCopied ? <Check size={12} className="copy-icon-check" /> : <Copy size={12} className="copy-icon-copy" />}
              </button>
            </div>
          </div>

          <CollapsibleCardBody expanded={isExpanded}>{() => (
            <div className="tool-call-body">
              {toolName === "bash" && (
                <div className="tool-meta-bar">
                  <div className="tool-meta-item">
                    <span className="meta-lbl">{t("退出码:")}</span>
                    <span
                      className={`meta-val ${
                        exitCode === 0 ? "success" : exitCode !== null ? "error" : "neutral"
                      }`}
                    >
                      {exitCode !== null ? exitCode : t("退出码未知")}
                    </span>
                  </div>
                  <div className="tool-meta-item">
                    <span className="meta-lbl">{t("输出状态:")}</span>
                    <span className={`meta-val ${isTruncated ? "warning" : "neutral"}`}>
                      {isTruncated ? t("已截断 (Truncated)") : t("完整 (Complete)")}
                    </span>
                  </div>
                </div>
              )}

              {args.command && (
                <div className="tool-command-section">
                  <div className="section-label">{t("命令 (Command)")}</div>
                  <pre className="tool-command-code">{args.command}</pre>
                </div>
              )}

              {Object.keys(args).length > 0 && (
                <div className="tool-args-section">
                  <div className="section-label">{t("参数 (Arguments)")}</div>
                  <pre className="tool-args-code">
                    {argsText.text}
                  </pre>
                </div>
              )}

              {item.hydrating && item.bodyOmitted && (
                <div className="tool-result-section">
                  <div className="tool-status running" style={{ padding: "6px 0" }}>
                    <Loader2 size={12} className="spin" />
                    <span>{t("正在加载历史记录…")}</span>
                  </div>
                </div>
              )}

              {item.result !== undefined && item.result !== null && !(item.hydrating && item.resultOmitted) && (
                <div className="tool-result-section">
                  <div className="section-label">
                    {isError ? t("错误输出 (Error Output)") : t("执行结果 (Result Output)")}
                  </div>
                  <pre className={`tool-result-code ${isError ? "error" : ""}`}>
                    {resultText.trim() || t("(无文本输出)")}
                  </pre>
                </div>
              )}
              {timing && (
                <div className="tool-timing">
                  <span className="tool-timing-lbl">{timing.label}</span>
                  <span className="tool-timing-val">{timing.value}</span>
                </div>
              )}
            </div>
          )}</CollapsibleCardBody>
        </div>
      </CardReveal>
    );
  }
);

ToolCallCard.displayName = "ToolCallCard";

export default ToolCallCard;
