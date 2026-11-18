export class RequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

/** Combine a local effect signal with a shared lifetime signal without requiring `AbortSignal.any`. */
export function combineAbortSignals(local: AbortSignal, lifetime?: AbortSignal | null): AbortSignal {
  if (!lifetime) return local;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([local, lifetime]);
  if (local.aborted || lifetime.aborted) {
    const controller = new AbortController();
    controller.abort(local.aborted ? local.reason : lifetime.reason);
    return controller.signal;
  }
  const controller = new AbortController();
  const onLocalAbort = () => {
    lifetime.removeEventListener("abort", onLifetimeAbort);
    controller.abort(local.reason);
  };
  const onLifetimeAbort = () => {
    local.removeEventListener("abort", onLocalAbort);
    controller.abort(lifetime.reason);
  };
  local.addEventListener("abort", onLocalAbort, { once: true });
  lifetime.addEventListener("abort", onLifetimeAbort, { once: true });
  return controller.signal;
}

/** Bound the whole response (including its body), even if a transport ignores
 * abort. Caller cancellation retains its own reason; all timers/listeners end. */
export async function withRequestTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
  parent?: AbortSignal,
): Promise<T> {
  // Do not start work that has already lost its owner. Some transports ignore
  // abort, and `work` may perform synchronous side effects before observing it.
  if (parent?.aborted) throw parent.reason ?? new DOMException("Cancelled", "AbortError");
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
