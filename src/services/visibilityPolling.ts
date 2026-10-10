type Visibility = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

/** Serial polling with bounded hidden-tab work. Returning null settles permanently.
 * Becoming visible wakes the current cursor immediately, including during an in-flight
 * request; it never starts a second overlapping request.
 */
export function startVisibilityPolling(
  poll: () => Promise<number | null>, initialDelay = 0,
  visibility: Visibility = document, hiddenDelay = 10_000,
): () => void {
  let stopped = false, busy = false, wake = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    visibility.removeEventListener("visibilitychange", changed);
  };
  const schedule = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(run, visibility.hidden ? Math.max(hiddenDelay, delay) : delay);
  };
  const run = async () => {
    if (stopped) return;
    if (busy) { wake = true; return; }
    busy = true;
    let delay: number | null;
    try { delay = await poll(); }
    catch (error) { stop(); throw error; } // Callers handle/report expected API failures.
    finally { busy = false; }
    if (stopped) return;
    if (delay === null) { stop(); return; }
    const next = wake && !visibility.hidden ? 0 : delay;
    wake = false;
    schedule(next);
  };
  const changed = () => {
    if (stopped) return;
    if (busy) { if (!visibility.hidden) wake = true; return; }
    schedule(visibility.hidden ? hiddenDelay : 0);
  };
  visibility.addEventListener("visibilitychange", changed);
  schedule(initialDelay);
  return stop;
}

/** Empty live pages back off; actual bytes immediately restore the original cadence. */
export function liveOutputDelay(emptyPages: number): number {
  return Math.min(1200, 150 * 2 ** Math.min(3, emptyPages));
}
