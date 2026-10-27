import { normalizeWorkspacePath } from "../../services/workspaceConversations";

/** Format Windows paths for display without changing the stored workspace path. */
export function workspacePathDisplay(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  if (/^[a-z]:[/\\]/i.test(normalized) || normalized.startsWith("\\\\")) {
    return normalized.replace(/\//g, "\\");
  }
  return normalized;
}
