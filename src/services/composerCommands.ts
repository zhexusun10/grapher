import { createContext } from "react";
import type { Config, ModelRole, RoleModelConfig, Snapshot } from "../types";

export interface ComposerScope { runId?: string; node?: string; role: ModelRole }
export const ComposerModels = createContext<{
  config: Config;
  snapshot: Snapshot;
  envOverrides: Record<string, string>;
  save: (scope: ComposerScope, settings: RoleModelConfig) => Promise<void>;
  rename?: (runId: string, title: string) => Promise<void>;
} | null>(null);

export const blockedCommands = new Set([
  "quit", "exit", "new", "tree", "fork", "clone", "resume", "import", "sessions",
  "login", "logout", "settings",
]);
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = text.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const args = (match[2] ?? "").trim();
  if (match[1] === "scoped" && /^(model|models)$/.test(args)) return { name: "scoped-models", args: "" };
  return { name: match[1], args };
}
export const builtinCommands = [
  { name: "model", description: "选择当前会话 / 节点的模型" },
  { name: "thinking", description: "选择思考等级" },
  { name: "scoped-models", description: "全局管理可见模型" },
  { name: "mcp", description: "查看 MCP 状态或登录、退出、重连服务" },
  { name: "compact", description: "压缩当前 Pi 会话上下文" },
  { name: "session", description: "查看当前 Pi 会话统计" },
  { name: "stats", description: "查看当前 Pi 会话统计" },
  { name: "copy", description: "复制当前 Pi 会话的最后回复" },
  { name: "name", description: "重命名当前对话" },
];
export interface PiCommand { name: string; description?: string; source?: string }
export interface PiCommandCatalog { instance: string; commands: PiCommand[] }
export interface ExtensionUIRequest {
  type: string; id: string; method?: string; title?: string; message?: string;
  options?: string[]; prefill?: string; placeholder?: string; text?: string;
  error?: string; timeout?: number; statusText?: string; widgetLines?: string[];
}
export function mergeCommands(commands: PiCommand[]): PiCommand[] {
  const result = new Map(builtinCommands.map(command => [command.name, command]));
  for (const command of commands) {
    if (!blockedCommands.has(command.name.toLowerCase()) && !result.has(command.name)) {
      result.set(command.name, { name: command.name, description: command.description ?? "Pi command" });
    }
  }
  return [...result.values()];
}
