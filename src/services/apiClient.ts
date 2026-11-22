import { t } from '../i18n';
import { createUuid } from '../lib/uuid';
import { DesktopBackendError, fetchApi, getApiTransportGeneration, isTauriDesktop } from './apiBase';
import { READ_COMMANDS, READ_OPERATIONS, type ApiErrorInfo, type OperationStatus } from './apiContract.generated';
import { enableRuntimeEvents } from './runtimeEvents';
import { withRequestTimeout } from './requestTimeout';

export class ApiRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly info: ApiErrorInfo;
  readonly status: number;
  readonly operationId?: string;
  constructor(info: ApiErrorInfo, status: number, operationId?: string, displayMessage = info.message) {
    super(displayMessage);
    this.name = 'ApiRequestError';
    this.info = info; this.status = status; this.operationId = operationId;
    this.code = info.code;
    this.retryable = info.retryable;
    this.requestId = info.requestId;
  }
  override toString(): string {
    return this.message ? `Error: ${this.message}` : 'Error';
  }
}

export function isReadRequest(command: string, body: Record<string, unknown> = {}): boolean {
  return (READ_COMMANDS as readonly string[]).includes(command) ||
    ((READ_OPERATIONS as Record<string, readonly string[]>)[command]?.includes(String(body.operation)) ?? false);
}

let backendInstance: { value: string; generation: number } | null = null;
const operationKeys = new Map<string, string>();
export interface ApiRequestOptions<T> {
  signal?: AbortSignal;
  /** null explicitly permits an interactive or long-running operation. */
  timeoutMs?: number | null;
  timeoutMessage?: string;
  operationId?: string;
  /** Stable business request identity, such as an existing Steer requestId. */
  operationKey?: string;
  validate?: (value: unknown) => T;
  revalidateReplay?: (result: T, signal?: AbortSignal) => Promise<T>;
}

export function observeApiResponse(response: Response): void {
  const instance = response.headers.get('x-grapher-instance');
  if (instance && /^[0-9a-f-]{36}$/i.test(instance)) {
    const generation = getApiTransportGeneration();
    // Keep issued tokens across URL invalidation; their backend epoch remains authoritative.
    backendInstance = { value: instance, generation };
  }
  if (response.headers.get('x-grapher-events') === '1') enableRuntimeEvents();
}

export function requestHeaders(command: string, body: Record<string, unknown>, options: Pick<ApiRequestOptions<unknown>, 'operationId' | 'operationKey'> = {}) {
  const requestId = createUuid();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Grapher-Request-Id': requestId };
  let operationId = options.operationId ?? (options.operationKey ? operationKeys.get(options.operationKey) : undefined);
  if (!isReadRequest(command, body)) {
    const instance = backendInstance?.generation === getApiTransportGeneration() ? backendInstance.value : null;
    if (!operationId && instance) {
      operationId = options.operationKey ? operationKeys.get(options.operationKey) : undefined;
      operationId ??= `${instance}:${Date.now()}:${createUuid()}`;
      if (options.operationKey) {
        // Eviction drops only automatic identity reuse; explicit operationId remains available.
        if (operationKeys.size >= 256) operationKeys.delete(operationKeys.keys().next().value!);
        operationKeys.set(options.operationKey, operationId);
      }
    }
    if (operationId) headers['X-Grapher-Operation'] = operationId;
  }
  return { headers, requestId, operationId };
}

export function responseError(body: unknown, status: number, requestId: string, operationId?: string): ApiRequestError {
  const envelope = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const raw = envelope.errorInfo as Partial<ApiErrorInfo> | undefined;
  const message = typeof raw?.message === 'string' ? raw.message :
    typeof envelope.error === 'string' ? envelope.error : t('后端请求失败 ({0})', status);
  // Legacy responses are accepted for independent mocked clients and older servers.
  const code = typeof raw?.code === 'string' ? raw.code : message === 'Run not found' ? 'RUN_NOT_FOUND' : 'INVALID_REQUEST';
  const displayMessage = code === 'OPERATION_IN_PROGRESS' ? t('操作仍在处理中，请稍后刷新查看结果。') :
    code === 'OPERATION_OUTCOME_UNKNOWN' ? t('操作结果尚未确认，请刷新检查后再重试。') :
    code === 'IDEMPOTENCY_CONFLICT' ? t('请求与先前提交的操作不一致，请刷新后再试。') :
    code === 'CAPACITY_EXCEEDED' ? t('后端正在处理过多操作，请稍后重试。') : message;
  return new ApiRequestError({ code, message, retryable: raw?.retryable === true,
    requestId: typeof raw?.requestId === 'string' ? raw.requestId : requestId } as ApiErrorInfo, status, operationId, displayMessage);
}

export async function jsonRequest<T>(command: string, body: Record<string, unknown> = {}, options: ApiRequestOptions<T> = {}): Promise<T> {
  const read = isReadRequest(command, body);
  const { headers, requestId, operationId } = requestHeaders(command, body, options);
  const work = async (signal?: AbortSignal): Promise<T> => {
    let response: Response;
    try {
      response = await fetchApi(`/api/${command}`, { method: 'POST', headers, cache: 'no-store', body: JSON.stringify(body), signal }, { retrySafe: read });
    } catch (error) {
      if (signal?.aborted) throw error;
      // Query a receipt after a lost write response. This is a read, never a replay.
      const recovered = !read && operationId ? await recoverOperationResponse(operationId, signal) : null;
      if (signal?.aborted) throw signal.reason ?? error;
      if (recovered) response = recovered;
      else {
        if (error instanceof DesktopBackendError) throw error;
        throw new Error(read ? t('无法连接后端，请在终端运行 npm run backend。') :
          t('请求连接中断，操作结果尚未确认，请刷新检查后再重试。'), { cause: error });
      }
    }
    observeApiResponse(response);
    let data: unknown;
    try { data = await response.json(); }
    catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const recovered = !read && operationId ? await recoverOperationResponse(operationId, signal) : null;
      if (signal?.aborted) throw signal.reason ?? error;
      if (recovered) { response = recovered; data = await response.json(); }
      else throw new Error(isTauriDesktop()
        ? t('桌面后端未返回有效响应 ({0})，请重试或重启应用。', response.status)
        : t('后端未返回有效响应 ({0})，请确认终端中的后端已启动。', response.status));
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid API response envelope');
    const envelope = data as Record<string, unknown>;
    if (!response.ok || envelope.error) throw responseError(data, response.status, requestId, operationId);
    if (!Object.hasOwn(envelope, 'result')) throw new Error('Invalid API response envelope');
    const result = options.validate ? options.validate(envelope.result) : envelope.result as T;
    return response.headers.get('x-grapher-replayed') === '1' && options.revalidateReplay
      ? options.revalidateReplay(result, signal) : result;
  };
  try {
    const timeoutMs = options.timeoutMs === undefined ? (read ? 15_000 : null) : options.timeoutMs;
    return timeoutMs === null ? await work(options.signal) : await withRequestTimeout(work, timeoutMs,
      options.timeoutMessage ?? (read ? t('后端响应超时，请稍后重试。') : t('操作请求超时，请刷新确认结果后再重试。')), options.signal);
  } catch (error) {
    // Preserve AbortError/RequestTimeoutError/DesktopBackendError identity for callers.
    if (error instanceof Error && Object.isExtensible(error)) Object.assign(error, {
      ...(error instanceof ApiRequestError ? {} : { requestId, operationId }),
      outcomeUnknown: error instanceof ApiRequestError ? ["OPERATION_OUTCOME_UNKNOWN", "OPERATION_IN_PROGRESS"].includes(error.code) : !read,
    });
    throw error;
  }
}

/** A missing/expired receipt proves nothing about whether a write committed. */
export async function recoverOperationResponse(operationId: string, signal?: AbortSignal): Promise<Response | null> {
  try {
    const receipt = await jsonRequest<OperationStatus>(
      'operation_status', { operationId }, { signal, timeoutMs: 2_000 });
    if (receipt?.state !== 'completed' || !receipt.response ||
        !Number.isInteger(receipt.response.status) || receipt.response.status < 200 || receipt.response.status > 599) return null;
    return new Response(JSON.stringify(receipt.response.body), { status: receipt.response.status,
      headers: { 'Content-Type': 'application/json', 'X-Grapher-Replayed': '1' } });
  } catch { return null; }
}
