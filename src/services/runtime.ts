import { Bootstrap, Config, Graph, Plan, RepositoryInfo, Snapshot } from "../types";

async function request<T>(command: string, body: Record<string, unknown> = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${command}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("无法连接后端，请在终端运行 npm run backend。");
  }
  const data = await response.json().catch(() => {
    throw new Error(`后端未返回有效响应 (${response.status})，请确认终端中的后端已启动。`);
  });
  if (!response.ok || data.error) throw new Error(data.error || `后端请求失败 (${response.status})`);
  return data.result as T;
}

export const runtimeService = {
  bootstrap: () => request<Bootstrap>("bootstrap"),
  snapshot: () => request<Snapshot>("snapshot"),
  history: (runId: string) => request<Snapshot>("history", { runId }),
  compileGraph: (graph: Graph) => request<Plan>("compile_graph", { graph }),
  saveGraph: (graph: Graph, config: Config) => request<Snapshot>("save_graph", { graph, config }),
  planGoal: (goal: string, config: Config) => request<Snapshot>("plan_goal", { goal, config }),
  control: (action: string, extra?: Record<string, unknown>) => request<Snapshot>("control", { action, ...extra }),
  detectRepository: (path?: string | null) => request<RepositoryInfo | null>("detect_repository", { path: path || null }),
  async pickRepository(): Promise<RepositoryInfo | null> {
    const path = window.prompt("输入后端机器上的 Git 仓库绝对路径");
    if (!path?.trim()) return null;
    const info = await this.detectRepository(path.trim());
    if (!info) throw new Error("该路径不是有效的 Git 仓库。");
    return info;
  },
  resetWorkspace: () => request<Snapshot>("reset_workspace"),
  clearHistory: () => request<void>("clear_history"),
  deleteRun: (runId: string) => request<void>("delete_run", { runId }),
};
