import { Bootstrap, Config, Graph, Plan, PlanningSummary, RepositoryInfo, Snapshot } from "../types";

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
  loadRun: async (runId: string) => {
    try {
      return await request<Snapshot>("load_run", { runId });
    } catch {
      try {
        const snap = await request<Snapshot>("snapshot");
        if (snap && snap.runId === runId) {
          return snap;
        }
      } catch {}
      return await request<Snapshot>("history", { runId });
    }
  },
  compileGraph: (graph: Graph) => request<Plan>("compile_graph", { graph }),
  saveGraph: (graph: Graph, config: Config) => request<Snapshot>("save_graph", { graph, config }),
  planGoal: (goal: string, config: Config) => request<Snapshot>("plan_goal", { goal, config }),
  async planGoalStream(
    goal: string,
    config: Config,
    onEvent: (event: import("../types").PlanStreamEvent) => void
  ): Promise<Snapshot> {
    const response = await fetch("/api/plan_goal_stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, config }),
    });

    if (!response.ok) {
      let errMsg = `规划请求失败 (${response.status})`;
      try {
        const errJson = await response.json();
        if (errJson.error) errMsg = errJson.error;
      } catch {}
      throw new Error(errMsg);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("浏览器不支持流式响应读取");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let finalSnapshot: Snapshot | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        if (!part.trim()) continue;
        let eventType = "message";
        let dataStr = "";

        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            dataStr = line.slice(6).trim();
          }
        }

        if (dataStr) {
          try {
            const dataObj = JSON.parse(dataStr);
            if (eventType === "complete") {
              finalSnapshot = dataObj.snapshot || dataObj;
              onEvent({ type: "complete", snapshot: finalSnapshot! });
            } else if (eventType === "route_decision") {
              onEvent({ type: "route_decision", planType: dataObj.planType });
            } else if (eventType === "partitioner") {
              onEvent({ type: "partitioner", raw: dataObj.raw, event: dataObj.event });
            } else if (eventType === "planner") {
              onEvent({ type: "planner", raw: dataObj.raw, event: dataObj.event });
            } else if (eventType === "error") {
              onEvent({
                type: "error",
                error: dataObj.error,
                planningId: dataObj.planningId,
                summary: dataObj.summary,
              });
              const err = new Error(dataObj.error || "规划失败");
              (err as any).planningId = dataObj.planningId;
              (err as any).summary = dataObj.summary;
              throw err;
            }
          } catch (e) {
            if (eventType === "error") throw e;
          }
        }
      }
    }

    if (!finalSnapshot) {
      finalSnapshot = await this.snapshot();
    }
    return finalSnapshot;
  },
  getPlanning: (planningId: string) => request<PlanningSummary>("get_planning", { planningId }),
  listPlannings: (repository?: string) => request<PlanningSummary[]>("list_plannings", repository ? { repository } : {}),
  control: (action: string, extra?: Record<string, unknown>) => request<Snapshot>("control", { action, ...extra }),
  detectRepository: (path?: string | null) => request<RepositoryInfo | null>("detect_repository", { path: path || null }),
  async pickRepository(): Promise<RepositoryInfo | null> {
    try {
      const res = await request<{
        supported: boolean;
        repository: RepositoryInfo | null;
        cancelled: boolean;
      }>("pick_repository");
      if (res.supported) {
        if (res.cancelled) return null;
        return res.repository;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("不是有效的 Git 仓库") || msg.includes("未找到 .git")) {
        throw err;
      }
      console.warn("Native file picker failed or unsupported, fallback to prompt", err);
    }
    const path = window.prompt("输入本地项目文件夹绝对路径（支持 Git 仓库或普通文件夹）");
    if (!path?.trim()) return null;
    const info = await this.detectRepository(path.trim());
    if (!info) throw new Error("无法加载该路径为有效工作区。");
    return info;
  },
  resetWorkspace: () => request<Snapshot>("reset_workspace"),
  clearHistory: () => request<void>("clear_history"),
  deleteRun: (runId: string) => request<void>("delete_run", { runId }),
};
