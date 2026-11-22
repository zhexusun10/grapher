import { t } from "../i18n";
import { BoundedLruCache, utf8Bytes } from "../lib/BoundedLruCache";
import { isManagedAttachmentPath } from "../utils/attachmentPath";
import { DesktopBackendError, fetchApi, isTauriDesktop, probeDesktopBackendError } from "./apiBase";
import { invalidateTranscriptCaches } from "./transcriptCache";
import { ApiRequestError, jsonRequest, observeApiResponse, requestHeaders, responseError, recoverOperationResponse } from "./apiClient";
import type { SnapshotPollRequest, SnapshotPollResponse, ExecutionOutputPage, PlanningOutputPage, OperationStatus, ConversationSearchResponse } from "./apiContract.generated";
import { applySnapshotDelta, validateSnapshot } from "./snapshotDelta";
import { RequestTimeoutError, withRequestTimeout } from "./requestTimeout";
import type { Bootstrap, Config, FileChangeSummary, Graph, HostPreflight, ManualNodeRequest, OpenWorkspaceFileRequest, Plan, PlanningSummary, WorkspaceDirectory, SkillItem, Snapshot, RuntimeActivity } from "../types";

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
  "bootstrap", "host_preflight", "history", "snapshot", "snapshot_if_changed", "save_config", "composer_models", "composer_rename",
  "detect_repository", "repository_status", "get_planning", "list_plannings",
  "get_planning_snapshot", "get_execution_output", "get_planning_output", "search_conversations", "get_file_changes", "get_file_diff",
  "open_workspace_file",
  "provider_auth", "pi_extensions", "list_skills", "list_files",
  "get_merger_prompt", "operation_status",
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

function normalizeSnapshot(snapshot: Snapshot): Snapshot { return validateSnapshot(snapshot); }

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
  return requestBody<T>(command, body, signal, boundedCommands.has(command) ? metadataTimeoutMs : null);
}

async function refreshReplayedResult<T>(result: T, signal?: AbortSignal): Promise<T> {
  if (!result || typeof result !== "object") return result;
  const wrapped = "snapshot" in result;
  const state = (wrapped ? (result as { snapshot: unknown }).snapshot : result) as Snapshot | null;
  if (!state || typeof state.runId !== "string" || !("graph" in state)) return result;
  const refresh = async () => {
    const snapshot = await request<Snapshot>("snapshot", state.runId ? { runId: state.runId } : {}, signal);
    if (state.runId && snapshot.runId !== state.runId) throw new Error(t("执行记录与请求不匹配"));
    return snapshot;
  };
  if ("conversations" in result && wrapped) {
    const bootstrap = await request<Bootstrap>("bootstrap", {}, signal);
    return (state.runId ? { ...bootstrap, snapshot: await refresh() } : bootstrap) as T;
  }
  const fresh = await refresh();
  return (wrapped ? { ...result, snapshot: fresh } : fresh) as T;
}

async function requestBody<T>(command: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs: number | null = null): Promise<T> {
  const mutatesSnapshot = snapshotMutations.has(command) || (command === "composer_command" && body.operation === "withdraw");
  if (mutatesSnapshot) historyRequests.clear();
  try {
    return await jsonRequest<T>(command, { ...body, compact: true, detail: "metadata" }, {
      signal, timeoutMs,
      timeoutMessage: command === "save_config" || command === "composer_models"
        ? t("保存设置请求超时，请刷新确认是否已生效后再重试。") : undefined,
      operationKey: typeof body.requestId === "string" ? `${command}:${body.runId ?? ""}:${body.requestId}` : undefined,
      validate: result => normalizeSnapshotResult(result as T),
      revalidateReplay: refreshReplayedResult,
    });
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "RUN_NOT_FOUND" && typeof body.runId === "string" && body.runId) {
      throw new RunNotFoundError(body.runId);
    }
    throw error;
  } finally {
    if (mutatesSnapshot) historyRequests.clear();
  }
}

const snapshotBases = new BoundedLruCache<string, { version: string; snapshot: Snapshot; bytes: number }>(entry => entry.bytes, 64, 16 * 1024 * 1024);
let snapshotTicket = 0;
const snapshotTickets = new Map<string, number>();

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
        if (
          err instanceof DesktopBackendError &&
          (err.kind === "closed" || err.kind === "ipc_unavailable" || err.kind === "invalid_url")
        ) {
          throw err;
        }
        retries--;
        if (retries === 0) throw err;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
    return request<Bootstrap>("bootstrap");
  },
  hostPreflight: (signal?: AbortSignal) => request<HostPreflight>("host_preflight", {}, signal),
  repositoryStatus: (repository: string, signal?: AbortSignal) =>
    request<{ repository: string; valid: boolean; error: string | null; missing?: boolean; sizeLimitExceeded?: boolean }>("repository_status", { repository }, signal),
  snapshot: (signal?: AbortSignal) => request<Snapshot>("snapshot", {}, signal),
  snapshotForRun: async (runId: string, signal?: AbortSignal) => {
    const snapshot = await request<Snapshot>("snapshot", { runId }, signal);
    // Workspace ownership alone cannot distinguish two conversations.
    if (!snapshot || snapshot.runId !== runId) throw new Error(t("执行记录与请求不匹配"));
    return snapshot;
  },
  snapshotIfChanged: async (version: string | null, signal?: AbortSignal, runId?: string) => {
    const key = runId ?? "";
    const base = snapshotBases.get(key);
    const ticket = ++snapshotTicket;
    snapshotTickets.set(key, ticket);
    try {
      const requestedVersion = version;
      const wantsDelta = !!base && base.version === version;
      const pollRequest = { version: requestedVersion, delta: wantsDelta, ...(runId ? { runId } : {}) } satisfies SnapshotPollRequest;
      let result = await request<SnapshotPollResponse>("snapshot_if_changed", pollRequest, signal);
      if (!result || typeof result.version !== "string") throw new Error("Invalid snapshot poll response");
      if (result.delta) {
        try {
          if (!base || base.version !== requestedVersion) throw new Error("Missing snapshot delta base");
          result = { ...result, snapshot: applySnapshotDelta(base.snapshot, base.version, result.version, result.delta) };
        } catch {
          // A version mismatch/cold cache never guesses how to apply a patch.
          result = await request<SnapshotPollResponse>("snapshot_if_changed", { version: null, delta: false, ...(runId ? { runId } : {}) } satisfies SnapshotPollRequest, signal);
          if (!result || typeof result.version !== "string" || !result.snapshot || result.delta) throw new Error("Invalid full snapshot response");
        }
      }
      if (result.snapshot) {
        if (runId && result.snapshot.runId !== runId) throw new Error("Snapshot Run does not match its requested Run");
        if (!result.busy && snapshotTickets.get(key) === ticket) {
          let bytes = base && result.delta ? base.bytes : 2 + Object.entries(result.snapshot).reduce((sum, [key, value]) => sum + utf8Bytes(JSON.stringify({ [key]: value })), 0);
          if (base && result.delta) {
            const prior = base.snapshot as unknown as Record<string, unknown>;
            for (const key of new Set([...Object.keys(result.delta.set), ...result.delta.removed])) {
              bytes -= Object.hasOwn(prior, key) ? utf8Bytes(JSON.stringify({ [key]: prior[key] })) : 0;
            }
            bytes += Object.entries(result.delta.set).reduce((sum, [key, value]) => sum + utf8Bytes(JSON.stringify({ [key]: value })), 0);
            if (result.delta.events.length) bytes += utf8Bytes(JSON.stringify(result.delta.events)) - 2 + (base.snapshot.events.length ? 1 : 0);
          }
          snapshotBases.set(key, { version: result.version, snapshot: result.snapshot, bytes: Math.max(0, bytes) });
        }
      }
      return result;
    } finally { if (snapshotTickets.get(key) === ticket) snapshotTickets.delete(key); }
  },
  operationStatus: (operationId: string, signal?: AbortSignal) => request<OperationStatus>("operation_status", { operationId }, signal),
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
    const streamBody = { goal, config, mode, images, revisionRunId, continuePlanningId };
    const { headers, requestId, operationId } = requestHeaders("plan_goal_stream", streamBody);
    const completeFromReceipt = async (response: Response): Promise<Snapshot> => {
      const body = await response.json();
      if (!response.ok) throw responseError(body, response.status, requestId, operationId);
      const snapshot = normalizeSnapshot(body?.result?.snapshot);
      if (!snapshot.runId || (revisionRunId && snapshot.runId !== revisionRunId)) {
        throw new Error("Invalid planning receipt Run");
      }
      const fresh = await runtimeService.snapshotForRun(snapshot.runId, signal);
      historyRequests.clear();
      onEvent({ type: "complete", snapshot: fresh });
      return fresh;
    };
    const recoverInterruptedStream = async (error: unknown): Promise<Snapshot> => {
      const recovered = !signal?.aborted && operationId ? await recoverOperationResponse(operationId, signal) : null;
      if (signal?.aborted) throw signal.reason ?? error;
      if (recovered) return completeFromReceipt(recovered);
      if (isTauriDesktop()) error = await probeDesktopBackendError(error, signal) ?? error;
      if (error instanceof Error && Object.isExtensible(error)) Object.assign(error, { requestId, operationId, outcomeUnknown: true });
      throw error;
    };
    let response: Response;
    try {
      response = await fetchApi("/api/plan_goal_stream", {
        method: "POST", headers, body: JSON.stringify(streamBody), signal,
      });
    } catch (error) {
      const recovered = !signal?.aborted && operationId ? await recoverOperationResponse(operationId, signal) : null;
      if (recovered) response = recovered;
      else {
        if (error instanceof Error && Object.isExtensible(error)) Object.assign(error, { requestId, operationId, outcomeUnknown: true });
        throw error;
      }
    }

    observeApiResponse(response);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw responseError(body, response.status, requestId, operationId);
    }
    if (response.headers.get("content-type")?.includes("application/json")) {
      return completeFromReceipt(response);
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
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (readError) {
          return recoverInterruptedStream(readError);
        }
        const { done: completed, value } = chunk;
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
            const err = responseError(dataObj, 400, requestId, operationId);
            (err as any).planningId = dataObj.planningId;
            (err as any).summary = dataObj.summary;
            throw err;
          }
        }
      }
      return recoverInterruptedStream(new Error(t("规划连接已结束，但未收到完成结果。请刷新检查规划记录后重试。")));
    } finally {
      void reader.cancel().catch(() => { });
      reader.releaseLock();
    }
  },
  getExecutionOutput: (runId: string, executionId: string, offset = 0, signal?: AbortSignal, full = false, tail = false, before?: number, limit?: number, endOffset?: number, summaryOnlyOrProjection: boolean | "summary" | "cards" = false) => {
    const projection = summaryOnlyOrProjection === true ? "summary" : summaryOnlyOrProjection || undefined;
    return request<ExecutionOutputPage>(
      "get_execution_output", {
        runId, executionId, offset, full,
        ...(projection === "summary" ? { summaryOnly: true, projection: "summary" } : projection ? { projection } : {}),
        ...(endOffset !== undefined ? { endOffset } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(tail ? { tail: true, ...(before !== undefined ? { before } : {}) } : {}),
      }, signal);
  },
  hydrateExecutionRanges: (runId: string, executionId: string, ranges: ReadonlyArray<readonly [number, number]>, signal?: AbortSignal, endOffset?: number) =>
    request<ExecutionOutputPage>(
      "get_execution_output", {
        runId, executionId, ranges,
        ...(endOffset !== undefined ? { endOffset } : {}),
      }, signal),
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
  getFileDiff: (input: import("../types").FileDiffRequest, signal?: AbortSignal) =>
    request<import("../types").FileDiffResult>("get_file_diff", { ...input }, signal),
  openWorkspaceFile: (input: OpenWorkspaceFileRequest) =>
    request<{ path: string }>("open_workspace_file", { ...input }),
  getWorkspaceImage: (runId: string, path: string, executionId?: string, signal?: AbortSignal): Promise<Blob> =>
    withRequestTimeout(async deadline => {
      const response = await fetchApi("/api/get_workspace_image", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, path, ...(executionId ? { executionId } : {}) }), signal: deadline,
      }, { retrySafe: true });
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
  getPlanningOutput: (planningId: string, role: "partition" | "planner", offset = 0, signal?: AbortSignal, tail = false, before?: number, limit?: number, summaryOnlyOrProjection: boolean | "summary" | "cards" = false) => {
    const projection = summaryOnlyOrProjection === true ? "summary" : summaryOnlyOrProjection || undefined;
    return request<PlanningOutputPage>(
      "get_planning_output", {
        planningId, role, offset,
        ...(projection === "summary" ? { summaryOnly: true, projection: "summary" } : projection ? { projection } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(tail ? { tail: true, ...(before !== undefined ? { before } : {}) } : {}),
      }, signal);
  },
  hydratePlanningRanges: (planningId: string, role: "partition" | "planner", ranges: ReadonlyArray<readonly [number, number]>, signal?: AbortSignal) =>
    request<PlanningOutputPage>(
      "get_planning_output", { planningId, role, ranges }, signal),
  getPlanning: (planningId: string, signal?: AbortSignal) => request<PlanningSummary>("get_planning", { planningId }, signal),
  listPlannings: (repository?: string, signal?: AbortSignal) => request<PlanningSummary[]>("list_plannings", repository ? { repository } : {}, signal),
  searchConversations: (
    repository: string,
    query: string,
    options?: { role?: "all" | "user" | "assistant"; limit?: number; warm?: boolean },
    signal?: AbortSignal,
  ) =>
    request<ConversationSearchResponse>(
      "search_conversations",
      {
        repository,
        query,
        ...(options?.role && options.role !== "all" ? { role: options.role } : {}),
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        ...(options?.warm ? { warm: true } : {}),
      },
      signal,
    ),
  control: (action: string, extra?: Record<string, unknown>) => request<Snapshot>("control", { action, ...extra }),
  editPlanner: (input: { runId: string; oldText: string; instruction: string; versionIndex?: number }) =>
    request<Snapshot>("edit_planner", input),
  editNode: (input: { runId: string; node: string; executionId: string; oldText: string; instruction: string; images?: import("../types").ImageAttachment[]; versionIndex?: number; userTurnOffset?: number }) =>
    request<Snapshot>("edit_node", input),
  inspectWorkspace: (path?: string | null) => request<WorkspaceDirectory | null>("detect_repository", { path: path || null }),
  async pickRepository(): Promise<WorkspaceDirectory | null> {
    try {
      const res = await request<{
        supported: boolean;
        repository: WorkspaceDirectory | null;
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
    const info = await this.inspectWorkspace(path.trim());
    if (!info) throw new Error(t("无法加载该路径为有效工作区。"));
    return info;
  },
  resetWorkspace: async () => {
    const snapshot = await request<Snapshot>("reset_workspace");
    invalidateTranscriptCaches();
    snapshotBases.clear(); snapshotTickets.clear();
    return snapshot;
  },
  clearHistory: async () => {
    await request<void>("clear_history");
    invalidateTranscriptCaches();
    snapshotBases.clear(); snapshotTickets.clear();
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
    snapshotBases.delete(runId); snapshotTickets.delete(runId);
  },
  deleteWorkspace: async (repository: string) => {
    const deleted = await request<string[]>("delete_workspace", { repository });
    for (const runId of deleted) { invalidateTranscriptCaches(runId); snapshotBases.delete(runId); snapshotTickets.delete(runId); }
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
      if (
        (error instanceof ApiRequestError && error.code === "UNKNOWN_COMMAND") ||
        (error instanceof Error && /Unknown command|404/i.test(error.message))
      ) {
        throw new Error(t("后端不支持安全附件上传，请更新后端后重试。"));
      }
      throw error;
    }
    if (!isManagedAttachmentPath(res?.path)) {
      throw new Error(t("后端未返回安全的附件路径，请更新后端后重试。"));
    }
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
  },
};
