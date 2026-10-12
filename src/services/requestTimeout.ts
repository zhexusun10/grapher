export class RequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

/** Bound the whole response (including its body), even if a transport ignores
 * abort. Caller cancellation retains its own reason; all timers/listeners end. */
export async function withRequestTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let reject!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, fail) => { reject = fail; });
  const abort = (reason: unknown) => {
    controller.abort(reason);
    reject(reason);
  };
  const onAbort = () => abort(parent?.reason ?? new DOMException("Cancelled", "AbortError"));
  const timer = setTimeout(() => abort(new RequestTimeoutError(message)), timeoutMs);
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) onAbort();
  try {
    return await Promise.race([cancelled, work(controller.signal)]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  }
}
