import { t } from "../i18n";
import type { TranscriptItem } from "../types";

export type ActivitySummaryIcon =
  | "folder"
  | "search"
  | "read"
  | "edit"
  | "terminal"
  | "web"
  | "graph"
  | "tool"
  | "error"
  | "thinking";

export interface ActivitySummary {
  icon: ActivitySummaryIcon;
  text: string;
  isRunning: boolean;
  hasError: boolean;
  itemCount: number;
}

type TranslateFn = (key: string, ...values: unknown[]) => string;

const MAX_INLINE_DETAIL_CHARS = 160;

const LIST_TOOLS = new Set(["ls", "find", "list_dir", "list_files"]);
const SEARCH_TOOLS = new Set(["grep", "search", "search_files", "rg"]);
const READ_TOOLS = new Set(["read", "view_file"]);
const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multi_edit"]);
const BASH_TOOLS = new Set(["bash", "exec", "shell", "run_command"]);
const WEB_TOOLS = new Set(["web_search", "web_fetch", "fetch"]);

function compactText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > MAX_INLINE_DETAIL_CHARS ? `${text.slice(0, MAX_INLINE_DETAIL_CHARS)}…` : text;
}

function normalizeFileKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function webSearchDetail(args: Record<string, unknown>): string | undefined {
  const query = compactText(args.query) || compactText(args.objective);
  if (query) return query;
  if (Array.isArray(args.urls)) {
    const firstUrl = args.urls.map(compactText).find((url): url is string => Boolean(url));
    if (firstUrl) return firstUrl;
  }
  return compactText(args.url);
}

function isErrorRow(item: TranscriptItem): boolean {
  if (item.errorItems?.length) return true;
  return (item.type === "system" || (item.type === "text" && item.role === "assistant")) &&
    Boolean(item.isError || item.status === "error");
}

/** Build a compact, Codex-style one-line summary for a contiguous group of
 * collapsed transcript cards (thinking, tool calls, and errors). */
export function summarizeActivityGroup(
  items: readonly TranscriptItem[],
  tr: TranslateFn = t,
  options?: { isOpen?: boolean },
): ActivitySummary {
  let listCount = 0;
  let searchCount = 0;
  let readCount = 0;
  let editCount = 0;
  let bashCount = 0;
  let webCount = 0;
  let routeCount = 0;
  let readGraphCount = 0;
  let editGraphCount = 0;
  let otherToolCount = 0;
  let errorCount = 0;
  let bashRunning = false;
  let isRunning = false;

  const readPaths = new Set<string>();
  const editPaths = new Set<string>();
  let readWithoutPathCount = 0;
  let editWithoutPathCount = 0;

  let singleTool: TranscriptItem | null = null;
  let totalTools = 0;

  for (const item of items) {
    if (item.status === "running") isRunning = true;

    if (item.type === "tool_call") {
      totalTools += 1;
      singleTool = totalTools === 1 ? item : null;
      const toolName = (item.toolName || "tool").trim();
      const normalizedToolName = toolName.toLowerCase();
      const args = item.args || {};

      if (LIST_TOOLS.has(normalizedToolName)) {
        listCount += 1;
      } else if (SEARCH_TOOLS.has(normalizedToolName)) {
        searchCount += 1;
      } else if (READ_TOOLS.has(normalizedToolName)) {
        readCount += 1;
        // Generating calls may have empty or partial arguments; wait until the
        // call arguments finalize so file counts stay monotonic (never 2 -> 3 -> 2).
        if (item.toolPhase !== "generating") {
          const path = compactText(args.path);
          if (path) readPaths.add(normalizeFileKey(path));
          else readWithoutPathCount += 1;
        }
      } else if (EDIT_TOOLS.has(normalizedToolName)) {
        editCount += 1;
        if (item.toolPhase !== "generating") {
          const path = compactText(args.path);
          if (path) editPaths.add(normalizeFileKey(path));
          else editWithoutPathCount += 1;
        }
      } else if (BASH_TOOLS.has(normalizedToolName)) {
        bashCount += 1;
        if (item.status === "running") bashRunning = true;
      } else if (WEB_TOOLS.has(normalizedToolName)) {
        webCount += 1;
      } else if (normalizedToolName === "route_task") {
        routeCount += 1;
      } else if (normalizedToolName === "read_graph") {
        readGraphCount += 1;
      } else if (normalizedToolName === "edit_graph") {
        editGraphCount += 1;
      } else if (item.toolPhase !== "generating") {
        // Generating calls may carry the placeholder name "tool" or a partial
        // name until toolcall_end / tool_execution_start finalizes the real
        // tool name. Wait until the call leaves "generating" so "Called 1 tool"
        // never flashes and then disappears once the real name arrives.
        otherToolCount += 1;
      }
      continue;
    }

    if (isErrorRow(item)) {
      errorCount += item.errorItems?.length || 1;
    }
  }

  // Only actual transcript/system errors mark a summary as erroneous; exploratory
  // tool calls (such as rg/grep/test returning exit code 1) stay neutral.
  const hasError = errorCount > 0;

  // Single-tool group with no transcript error: surface the concrete
  // command/path/query once the group is closed (not actively running or able
  // to receive more tool calls). Expanding inline details while a live group
  // can still append a second tool makes the summary bar stretch horizontally
  // and then abruptly snap back to a short aggregate label.
  const groupOpen = Boolean(options?.isOpen || isRunning);
  if (!groupOpen && totalTools === 1 && errorCount === 0 && singleTool) {
    const toolName = (singleTool.toolName || "tool").trim();
    const normalizedToolName = toolName.toLowerCase();
    const args = singleTool.args || {};
    const toolRunning = singleTool.status === "running";
    const generating = singleTool.toolPhase === "generating";

    if (BASH_TOOLS.has(normalizedToolName)) {
      const command = generating ? undefined : compactText(args.command);
      return {
        icon: "terminal",
        text: command
          ? (toolRunning ? tr("正在运行 {0}", command) : tr("已运行 {0}", command))
          : (toolRunning ? tr("正在运行 1 条命令") : tr("已运行 1 条命令")),
        isRunning,
        hasError,
        itemCount: items.length,
      };
    }

    if (READ_TOOLS.has(normalizedToolName)) {
      const path = generating ? undefined : compactText(args.path);
      return {
        icon: "read",
        text: path
          ? (toolRunning ? tr("正在浏览 {0}", path) : tr("已浏览 {0}", path))
          : tr("已浏览 1 个文件"),
        isRunning,
        hasError,
        itemCount: items.length,
      };
    }

    if (EDIT_TOOLS.has(normalizedToolName)) {
      const path = generating ? undefined : compactText(args.path);
      if (path) {
        const text = normalizedToolName === "write"
          ? (toolRunning ? tr("正在写入 {0}", path) : tr("已写入 {0}", path))
          : (toolRunning ? tr("正在编辑 {0}", path) : tr("已编辑 {0}", path));
        return { icon: "edit", text, isRunning, hasError, itemCount: items.length };
      }
      return {
        icon: "edit",
        text: tr("已修改 1 个文件"),
        isRunning,
        hasError,
        itemCount: items.length,
      };
    }

    if (WEB_TOOLS.has(normalizedToolName)) {
      const detail = generating ? undefined : webSearchDetail(args);
      return {
        icon: "web",
        text: detail
          ? (toolRunning ? tr("正在搜索 {0}", detail) : tr("已搜索 {0}", detail))
          : tr("已搜索网络"),
        isRunning,
        hasError,
        itemCount: items.length,
      };
    }

    if (otherToolCount === 1 && toolName && normalizedToolName !== "tool") {
      return {
        icon: "tool",
        text: toolRunning ? tr("正在调用 {0}", toolName) : tr("已调用 {0}", toolName),
        isRunning,
        hasError,
        itemCount: items.length,
      };
    }
  }

  const segments: Array<{ icon: ActivitySummaryIcon; label: string }> = [];

  if (listCount > 0) {
    segments.push({ icon: "folder", label: tr("已列出文件") });
  }
  if (searchCount > 0) {
    segments.push({ icon: "search", label: tr("已搜索代码") });
  }
  if (readCount > 0) {
    const count = Math.max(1, readPaths.size + readWithoutPathCount);
    segments.push({
      icon: "read",
      label: count === 1 ? tr("已浏览 1 个文件") : tr("已浏览 {0} 个文件", count),
    });
  }
  if (editCount > 0) {
    const count = Math.max(1, editPaths.size + editWithoutPathCount);
    segments.push({
      icon: "edit",
      label: count === 1 ? tr("已修改 1 个文件") : tr("已修改 {0} 个文件", count),
    });
  }
  if (bashCount > 0) {
    segments.push({
      icon: "terminal",
      label: bashCount === 1
        ? (bashRunning ? tr("正在运行 1 条命令") : tr("已运行 1 条命令"))
        : tr("已运行 {0} 条命令", bashCount),
    });
  }
  if (webCount > 0) {
    segments.push({
      icon: "web",
      label: webCount === 1 ? tr("已搜索网络") : tr("已搜索 {0} 次网络", webCount),
    });
  }
  if (routeCount > 0) {
    segments.push({ icon: "graph", label: tr("已决策任务路线") });
  }
  if (readGraphCount > 0) {
    segments.push({ icon: "graph", label: tr("已读取任务图") });
  }
  if (editGraphCount > 0) {
    segments.push({ icon: "graph", label: tr("已更新任务图") });
  }
  if (otherToolCount > 0) {
    segments.push({
      icon: "tool",
      label: otherToolCount === 1 ? tr("调用了 1 个工具") : tr("调用了 {0} 个工具", otherToolCount),
    });
  }
  if (errorCount > 0) {
    segments.push({
      icon: "error",
      label: errorCount === 1 ? tr("发生 1 个错误") : tr("发生 {0} 个错误", errorCount),
    });
  }

  if (segments.length === 0) {
    return {
      icon: "thinking",
      text: isRunning ? tr("正在思考…") : tr("已思考"),
      isRunning,
      hasError,
      itemCount: items.length,
    };
  }

  return {
    icon: segments[0].icon,
    text: segments.map(segment => segment.label).join(" · "),
    isRunning,
    hasError,
    itemCount: items.length,
  };
}
