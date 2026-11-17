import { t } from "../i18n";
import { invalidateTranscriptCaches } from "./transcriptCache";
import { enableRuntimeEvents } from "./runtimeEvents";
import { RequestTimeoutError, withRequestTimeout } from "./requestTimeout";
import type { Bootstrap, Config, FileChangeSummary, Graph, ManualNodeRequest, OpenWorkspaceFileRequest, Plan, PlanningSummary, RepositoryInfo, SkillItem, Snapshot, RuntimeActivity } from "../types";

const filesCache = new Map<string, string[]>();
const skillsCache = new Map<string, SkillItem[]>();
const filesRequests = new Map<string, number>();
const skillsRequests = new Map<string, number>();
// Share only requests in flight; settled history is never cached as authoritative state.
const historyRequests = new Map<string, Promise<Snapshot>>();
const snapshotMutations = new Set([
  "save_graph", "add_manual_node", "update_unstarted_node_task", "save_config", "composer_models", "composer_rename", "plan_goal", "control", "edit_planner", "edit_node",
  "load_run", "reset_workspace", "clear_history", "delete_run", "delete_workspace",
]);

// Bound metadata/default-settings waits, not model streams, approvals or other
// long-running mutations. A client timeout never claims that a server-side
// write was rolled back.
const boundedCommands = new Set([
  "bootstrap", "history", "snapshot", "snapshot_if_changed", "save_config", "composer_models", "composer_rename",
  "detect_repository", "repository_status", "get_planning", "list_plannings",
  "get_planning_snapshot", "get_execution_output", "get_planning_output", "get_file_changes",
  "open_workspace_file",
  "provider_auth", "pi_extensions", "list_skills", "list_files",
  "get_merger_prompt",
]);
const metadataTimeoutMs = 15_000;

/** Only an explicit backend response proves that a Run no longer exists. */
export class RunNotFoundError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super("Run not found");
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}

// Validate current node states without translating historical status names.
function normalizeSnapshot(snapshot: Snapshot): Snapshot {
  const statuses = new Set(["waiting", "running", "completed", "failed", "blocked", "dirty", "paused"]);
  for (const node of Object.values(snapshot.nodes ?? {})) {
    if (!statuses.has(node.status)) throw new Error("Unsupported node status");
  }
  return snapshot;
}

function normalizeSnapshotResult<T>(result: T): T {
  if (!result || typeof result !== "object") return result;
  if ("snapshot" in result) {
    const envelope = result as T & { snapshot: Snapshot | null };
    if (!envelope.snapshot) return result;
    const snapshot = normalizeSnapshot(envelope.snapshot);
    return snapshot === envelope.snapshot ? result : { ...result, snapshot };
  }
  if ("runId" in result && "graph" in result && "nodes" in result) {
    return normalizeSnapshot(result as T & Snapshot) as T;
  }
  return result;
}

function request<T>(command: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  if (!boundedCommands.has(command)) return requestBody<T>(command, body, signal);
  const message = command === "save_config" || command === "composer_models"
    ? t("保存设置请求超时，请刷新确认是否已生效后再重试。")
    : t("后端响应超时，请稍后重试。");
  return withRequestTimeout(deadline => requestBody<T>(command, body, deadline), metadataTimeoutMs, message, signal);
}

async function requestBody<T>(command: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  // A post-action reader must not join a metadata request begun before the action.
  const mutatesSnapshot = snapshotMutations.has(command) || (command === "composer_command" && body.operation === "withdraw");
  if (mutatesSnapshot) historyRequests.clear();
  let response: Response;
  try {
    response = await fetch(`/api/${command}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, compact: true, detail: "metadata" }),
      signal,
    });
  } catch (error) {
    if (mutatesSnapshot) historyRequests.clear();
    if (signal?.aborted) throw error;
    throw new Error(t("无法连接后端，请在终端运行 npm run backend。"));
  }
  if (response.headers?.get("x-grapher-events") === "1") {
    enableRuntimeEvents();
  }
  const data = await response.json().catch(() => {
    if (mutatesSnapshot) historyRequests.clear();
    throw new Error(t("后端未返回有效响应 ({0})，请确认终端中的后端已启动。", response.status));
  });
  if (mutatesSnapshot) historyRequests.clear();
  if (!response.ok || data.error) {
    if (data.error === "Run not found" && typeof body.runId === "string" && body.runId) {
      throw new RunNotFoundError(body.runId);
    }
    throw new Error(data.error || t("后端请求失败 ({0})", response.status));
  }
  return normalizeSnapshotResult(data.result as T);
}

export const runtimeService = {
  bootstrap: async () => {
    let retries = 3;
    while (retries > 0) {
      try {
        const result = await request<Bootstrap>("bootstrap");
        if (!Array.isArray(result.conversations)) throw new Error("Conversation index is unavailable");
        return result;
      } catch (err) {
        // Three stalled bootstrap attempts must not multiply the wait budget.
        if (err instanceof RequestTimeoutError) throw err;
        retries--;
        if (retries === 0) throw err;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
    return request<Bootstrap>("bootstrap");
  },
  repositoryStatus: (repository: string, signal?: AbortSignal) =>
    request<{ repository: string; valid: boolean; error: string | null; missing?: boolean; sizeLimitExceeded?: boolean }>("repository_status", { repository }, signal),
  snapshot: (signal?: AbortSignal) => request<Snapshot>("snapshot", {}, signal),
  snapshotForRun: async (runId: string, signal?: AbortSignal) => {
    const snapshot = await request<Snapshot>("snapshot", { runId }, signal);
    // Workspace ownership alone cannot distinguish two conversations.
    if (!snapshot || snapshot.runId !== runId) throw new Error(t("执行记录与请求不匹配"));
    return snapshot;
  },
  snapshotIfChanged: (version: string | null, signal?: AbortSignal, runId?: string) =>
    request<{ version: string; snapshot: Snapshot | null; activity?: RuntimeActivity[]; busy?: boolean }>("snapshot_if_changed", { version, ...(runId ? { runId } : {}) }, signal),
  history: (runId: string) => {
    const pending = historyRequests.get(runId);
    if (pending) return pending;
    const task = request<Snapshot>("history", { runId });
    historyRequests.set(runId, task);
    void task.finally(() => { if (historyRequests.get(runId) === task) historyRequests.delete(runId); }).catch(() => { });
    return task;
  },
  loadRun: async (runId: string) => {
    const snapshot = await request<Snapshot>("load_run", { runId });
    if (!snapshot || snapshot.runId !== runId) throw new Error(t("执行记录与请求不匹配"));
    return snapshot;
  },
  compileGraph: (graph: Graph) => request<Plan>("compile_graph", { graph }),
  saveGraph: (graph: Graph, config: Config, runId?: string) => request<Snapshot>("save_graph", { graph, config, runId }),
  updateUnstartedNodeTask: (runId: string, node: string, oldTask: string, task: string) =>
    request<Snapshot>("update_unstarted_node_task", { runId, node, oldTask, task }),
  addManualNode: (runId: string, node: ManualNodeRequest) => request<Snapshot>("add_manual_node", { runId, request: node }),
  withdrawMessages: (runId: string, node: string | undefined, requestId: string) => withRequestTimeout(
    signal => request<{ snapshot: Snapshot; messages: import("./composerDrafts").RecalledMessage[] }>(
      "composer_command", { runId, node, requestId, operation: "withdraw" }, signal), metadataTimeoutMs,
    t("撤回请求超时，请重试以恢复已撤回的消息。")),
  composerModels: (fields: Record<string, unknown>) => request<Snapshot>("composer_models", fields),
  composerRename: (fields: { runId: string; title: string }) => request<Snapshot>("composer_rename", fields),
  extensionCommand: <T = unknown>(fields: Record<string, unknown>) => withRequestTimeout(
    signal => requestBody<T>("extension_command", fields, signal), fields.operation === 'catalog' ? 35_000 : metadataTimeoutMs,
    t("Pi 指令请求超时，请确认执行结果后再重试。")),
  composerCommand: <T = unknown>(fields: Record<string, unknown>) => withRequestTimeout(
    signal => requestBody<T>("composer_command", fields, signal), fields.operation === "execute" ? 310_000 : metadataTimeoutMs,
    t("Pi 指令请求超时，请确认执行结果后再重试。")),
  saveConfig: (config: Config, runId?: string) => request<Bootstrap>("save_config", { config, ...(runId ? { runId } : {}) }),
  planGoal: (goal: string, config: Config, mode?: string) => request<Snapshot>("plan_goal", { goal, config, mode }),
  async planGoalStream(
    goal: string,
    config: Config,
    onEvent: (event: import("../types").PlanStreamEvent) => void,
    mode?: import("../types").PlanMode,
    signal?: AbortSignal,
    images?: import("../types").ImageAttachment[],
    revisionRunId?: string,
    continuePlanningId?: string
  ): Promise<Snapshot> {
    historyRequests.clear();
    const response = await fetch("/api/plan_goal_stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, config, mode, images, revisionRunId, continuePlanningId }),
      signal,
    });

    if (response.headers?.get("x-grapher-events") === "1") {
      enableRuntimeEvents();
    }
    if (!response.ok) {
      let errMsg = t("规划请求失败 ({0})", response.status);
      try {
        const errJson = await response.json();
        if (errJson.error) errMsg = errJson.error;
      } catch { }
      throw new Error(errMsg);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error(t("浏览器不支持流式响应读取"));
    }

    const decoder = new TextDecoder();
    let partialLine = "";
    let skipLF = false;
    let pendingEventType = "message";
    let dataLines: string[] = [];
    try {
      while (true) {
        const { done: completed, value } = await reader.read();
        if (completed) break;
        let text = decoder.decode(value, { stream: true });
        if (!text) continue;
        // SSE permits LF, CRLF and bare CR. A CR at the end of one packet
        // already ended its line; consume the following LF only once.
        if (skipLF && text.startsWith("\n")) text = text.slice(1);
        skipLF = text.endsWith("\r");
        const lines = (partialLine + text).split(/\r\n|\r|\n/);
        partialLine = lines.pop() ?? "";

        for (const line of lines) {
          if (line) {
            const colon = line.indexOf(":");
            const field = colon < 0 ? line : line.slice(0, colon);
            let value = colon < 0 ? "" : line.slice(colon + 1);
            if (value.startsWith(" ")) value = value.slice(1);
            if (field === "event") pendingEventType = value || "message";
            else if (field === "data") dataLines.push(value);
            continue;
          }
          const eventType = pendingEventType;
          const dataStr = dataLines.join("\n");
          pendingEventType = "message";
          dataLines = [];
          if (!dataStr) continue;
          let dataObj;
          try { dataObj = JSON.parse(dataStr); }
          catch (error) {
            if (eventType === "error") throw error;
            continue;
          }
          if (eventType === "complete") {
            historyRequests.clear();
            const snapshot = normalizeSnapshot(dataObj.snapshot || dataObj);
            onEvent({ type: "complete", snapshot });
            // `complete` is the business boundary. A proxy/keep-alive stream
            // may remain open indefinitely after this terminal event.
            return snapshot;
          } else if (eventType === "run_started") {
            onEvent({ type: "run_started", runId: dataObj.runId });
          } else if (eventType === "route_decision") {
            onEvent({ type: "route_decision", planType: dataObj.planType });
          } else if (eventType === "partitioner") {
            onEvent({ type: "partitioner", raw: dataObj.raw, event: dataObj.event });
          } else if (eventType === "planner") {
            onEvent({ type: "planner", raw: dataObj.raw, event: dataObj.event });
          } else if (eventType === "error") {
            historyRequests.clear();
            onEvent({ type: "error", error: dataObj.error, planningId: dataObj.planningId, summary: dataObj.summary });
            const err = new Error(dataObj.error || t("规划失败"));
            (err as any).planningId = dataObj.planningId;
            (err as any).summary = dataObj.summary;
            throw err;
          }
        }
      }
      throw new Error(t("规划连接已结束，但未收到完成结果。请刷新检查规划记录后重试。"));
    } finally {
      void reader.cancel().catch(() => { });
      reader.releaseLock();
    }
  },
  getExecutionOutput: (runId: string, executionId: string, offset = 0, signal?: AbortSignal, full = false, tail = false, before?: number, limit?: number, endOffset?: number) =>
    request<{ runId: string; executionId: string; content: string; startOffset: number; nextOffset: number; totalBytes: number; complete: boolean; status: string }>(
      "get_execution_output", { runId, executionId, offset, full, ...(endOffset !== undefined ? { endOffset } : {}), ...(limit !== undefined ? { limit } : {}), ...(tail ? { tail: true, ...(before !== undefined ? { before } : {}) } : {}) }, signal),
  getFileChanges: async (runId: string, execution?: string | string[], signal?: AbortSignal) => {
    const result = await request<{ runId: string; executionId: string | null; executionIds: string[] | null; summary: FileChangeSummary }>(
      "get_file_changes", {
      runId,
      ...(Array.isArray(execution) ? { executionIds: execution } : execution ? { executionId: execution } : {}),
    }, signal);
    const expectedId = typeof execution === "string" && execution ? execution : null;
    const optionalStrings = (value: unknown) => value === undefined ||
      (Array.isArray(value) && value.every(item => typeof item === "string"));
    if (!result || result.runId !== runId || result.executionId !== expectedId ||
      (!Array.isArray(execution) && result.executionIds !== null) || !result.summary ||
      !Array.isArray(result.summary.files) || result.summary.files.some(file =>
        !file || typeof file.path !== "string" || !["added", "modified", "deleted", "renamed"].includes(file.status) ||
        (file.oldPath !== undefined && typeof file.oldPath !== "string") ||
        !optionalStrings(file.nodes) || !optionalStrings(file.executionIds) ||
        [file.additions, file.deletions].some(value => !Number.isSafeInteger(value) || value < 0)) ||
      [result.summary.totalFiles, result.summary.addedCount, result.summary.modifiedCount,
      result.summary.deletedCount, result.summary.renamedCount, result.summary.totalAdditions,
      result.summary.totalDeletions].some(value => !Number.isInteger(value) || value < 0)) {
      throw new Error("Invalid file changes response");
    }
    // Returned data must describe the requested execution scope.
    if (Array.isArray(execution) && (!Array.isArray(result.executionIds) ||
      result.executionIds.length !== execution.length || result.executionIds.some((id, index) => id !== execution[index]))) {
      throw new Error(t("后端不支持按执行范围读取文件变更，请更新后端后重试。"));
    }
    return result;
  },
  openWorkspaceFile: (input: OpenWorkspaceFileRequest) =>
    request<{ path: string }>("open_workspace_file", { ...input }),
  getWorkspaceImage: (runId: string, path: string, executionId?: string, signal?: AbortSignal): Promise<Blob> =>
    withRequestTimeout(async deadline => {
      const response = await fetch("/api/get_workspace_image", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, path, ...(executionId ? { executionId } : {}) }), signal: deadline,
      });
      if (!response.ok || !/^image\/(?:png|jpeg|gif|webp|bmp)$/i.test(response.headers.get("Content-Type") || "")) {
        throw new Error(t("无法加载图片"));
      }
      return response.blob();
    }, metadataTimeoutMs, t("后端响应超时，请稍后重试。"), signal),
  getMergerPrompt: async (runId: string, executionId: string, signal?: AbortSignal): Promise<string> => {
    const res = await request<{ runId: string; executionId: string; prompt: string }>(
      "get_merger_prompt", { runId, executionId }, signal
    );
    return res.prompt;
  },
  getPlanningSnapshot: (planningId: string, repository: string, signal?: AbortSignal) =>
    request<Snapshot>("get_planning_snapshot", { planningId, repository }, signal),
  getPlanningOutput: (planningId: string, role: "partition" | "planner", offset = 0, signal?: AbortSignal, tail = false, before?: number, limit?: number) =>
    request<{ planningId: string; role: string; content: string; startOffset: number; nextOffset: number; totalBytes: number; complete: boolean; running: boolean }>(
      "get_planning_output", { planningId, role, offset, ...(limit !== undefined ? { limit } : {}), ...(tail ? { tail: true, ...(before !== undefined ? { before } : {}) } : {}) }, signal),
  getPlanning: (planningId: string, signal?: AbortSignal) => request<PlanningSummary>("get_planning", { planningId }, signal),
  listPlannings: (repository?: string, signal?: AbortSignal) => request<PlanningSummary[]>("list_plannings", repository ? { repository } : {}, signal),
  control: (action: string, extra?: Record<string, unknown>) => request<Snapshot>("control", { action, ...extra }),
  editPlanner: (input: { runId: string; oldText: string; instruction: string; versionIndex?: number }) =>
    request<Snapshot>("edit_planner", input),
  editNode: (input: { runId: string; node: string; executionId: string; oldText: string; instruction: string; images?: import("../types").ImageAttachment[]; versionIndex?: number; userTurnOffset?: number }) =>
    request<Snapshot>("edit_node", input),
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
      if (
        msg.includes("folder picker is unavailable") ||
        msg.includes("folder picker failed") ||
        msg.includes("404") ||
        msg.includes("Unknown command")
      ) {
        console.warn("Native file picker failed or unsupported, fallback to prompt", err);
      } else {
        throw err;
      }
    }
    const path = window.prompt(t("输入本地项目文件夹绝对路径（支持 Git 仓库或普通文件夹）"));
    if (!path?.trim()) return null;
    const info = await this.detectRepository(path.trim());
    if (!info) throw new Error(t("无法加载该路径为有效工作区。"));
    return info;
  },
  resetWorkspace: async () => {
    const snapshot = await request<Snapshot>("reset_workspace");
    invalidateTranscriptCaches();
    return snapshot;
  },
  clearHistory: async () => {
    await request<void>("clear_history");
    invalidateTranscriptCaches();
  },
  deleteRun: async (runId: string) => {
    try {
      await request<void>("delete_run", { runId });
    } catch (error) {
      // A previous request or another tab may already have deleted this Run.
      // Still let the caller retire its stale card and cached transcript.
      if (!(error instanceof RunNotFoundError) || error.runId !== runId) throw error;
    }
    invalidateTranscriptCaches(runId);
  },
  deleteWorkspace: async (repository: string) => {
    const deleted = await request<string[]>("delete_workspace", { repository });
    for (const runId of deleted) invalidateTranscriptCaches(runId);
    return deleted;
  },
  listFiles: async (repository?: string, forceRefresh = false): Promise<string[]> => {
    const key = repository || "__default__";
    if (!forceRefresh && filesCache.has(key)) {
      return filesCache.get(key)!;
    }
    const ticket = (filesRequests.get(key) ?? 0) + 1;
    filesRequests.set(key, ticket);
    // A failed lookup is not an authoritative empty workspace. Let the
    // composer retry while retaining any previously successful cache.
    const res = await request<{ files: string[] }>("list_files", repository ? { repository } : {});
    const files = res?.files || [];
    if (filesRequests.get(key) === ticket) filesCache.set(key, files);
    return files;
  },
  listSkills: async (repository?: string, forceRefresh = false): Promise<SkillItem[]> => {
    const key = repository || "__default__";
    if (!forceRefresh && skillsCache.has(key)) {
      return skillsCache.get(key)!;
    }
    const ticket = (skillsRequests.get(key) ?? 0) + 1;
    skillsRequests.set(key, ticket);
    const res = await request<{ skills: SkillItem[] }>("list_skills", repository ? { repository } : {});
    const skills = res?.skills || [];
    // An empty refresh is authoritative too; removed skills must stay removed.
    if (skillsRequests.get(key) === ticket) skillsCache.set(key, skills);
    return skills;
  },
  writeWorkspaceFile: async (
    file: File,
    repository?: string,
    context?: { runId?: string; node?: string; attachmentId?: string }
  ): Promise<{ name: string; path: string }> => {
    const base64Data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    let res: { name: string; path: string };
    try {
      res = await request("write_workspace_attachment", {
        repository,
        filename: file.name,
        content: base64Data,
        runId: context?.runId || undefined,
        node: context?.node || undefined,
        attachmentId: context?.attachmentId,
      });
    } catch (error) {
      if (error instanceof Error && /Unknown command|404/i.test(error.message)) {
        throw new Error(t("后端不支持安全附件上传，请更新后端后重试。"));
      }
      throw error;
    }
    if (typeof res?.path !== "string" || !/^grapher-attachments\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[^/\\]+$/.test(res.path)) {
      throw new Error(t("后端未返回安全的附件路径，请更新后端后重试。"));
    }
    const key = repository || "__default__";
    filesCache.delete(key);
    filesRequests.set(key, (filesRequests.get(key) ?? 0) + 1);
    return res;
  },
  deleteWorkspaceFile: async (
    filename: string,
    repository?: string,
    context?: { runId?: string; node?: string }
  ): Promise<void> => {
    await request<{ success: boolean }>("delete_workspace_attachment", {
      repository,
      filename,
      runId: context?.runId || undefined,
      node: context?.node || undefined,
    });
    const key = repository || "__default__";
    filesCache.delete(key);
    filesRequests.set(key, (filesRequests.get(key) ?? 0) + 1);
  },
};
