import assert from "node:assert/strict";
import test from "node:test";
import { RequestTimeoutError, withRequestTimeout } from "../src/services/requestTimeout.ts";
import { runtimeService } from "../src/services/runtime.ts";
import { emptySnapshot } from "../src/types.ts";

const response = (result: unknown) => new Response(JSON.stringify({ result }));

test("a stalled transport or response body times out and aborts with an actionable error", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  for (const body of [false, true]) {
    let signal!: AbortSignal;
    const pending = withRequestTimeout(async current => {
      signal = current;
      if (body) await Promise.resolve();
      return await new Promise<never>(() => {});
    }, 100, "Timed out");
    const rejected = assert.rejects(pending, error => error instanceof RequestTimeoutError && error.message === "Timed out");
    context.mock.timers.tick(100);
    await rejected;
    assert.equal(signal.aborted, true);
  }
});

test("caller cancellation retains its reason and a successful request removes its timer", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const caller = new AbortController();
  const reason = new DOMException("Navigation", "AbortError");
  const cancelled = withRequestTimeout(async () => new Promise<never>(() => {}), 100, "Timeout", caller.signal);
  const rejected = assert.rejects(cancelled, error => error === reason);
  caller.abort(reason); await rejected;
  let signal!: AbortSignal;
  assert.equal(await withRequestTimeout(async current => { signal = current; return "ok"; }, 100, "Timeout"), "ok");
  context.mock.timers.tick(1000);
  assert.equal(signal.aborted, false);
});

test("timed-out history leaves the deduplication map and bootstrap does not retry another full deadline", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Promise<Response>(() => {}); };
  try {
    const history = runtimeService.history("timeout-history");
    assert.equal(runtimeService.history("timeout-history"), history);
    const rejected = assert.rejects(history, RequestTimeoutError);
    context.mock.timers.tick(15_000); await rejected;
    globalThis.fetch = async () => { calls++; return response(emptySnapshot); };
    assert.deepEqual(await runtimeService.history("timeout-history"), emptySnapshot);
    assert.equal(calls, 2);
    globalThis.fetch = async () => { calls++; return new Promise<Response>(() => {}); };
    const bootstrap = runtimeService.bootstrap();
    const failed = assert.rejects(bootstrap, RequestTimeoutError);
    context.mock.timers.tick(15_000); await failed;
    assert.equal(calls, 3, "a deadline must not trigger three more stalled bootstrap attempts");
  } finally { globalThis.fetch = original; }
});

test("file change reads are bounded and carry an explicit empty or multi-execution scope", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  let signal: AbortSignal | null | undefined;
  try {
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      signal = init?.signal;
      return new Promise<Response>(() => {});
    };
    const scoped = runtimeService.getFileChanges("changes-run", ["first", "second"]);
    const rejected = assert.rejects(scoped, RequestTimeoutError);
    context.mock.timers.tick(15_000);
    await rejected;
    assert.equal(signal?.aborted, true);
    assert.deepEqual(bodies[0].executionIds, ["first", "second"]);
    assert.equal(bodies[0].executionId, undefined);
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return response({ summary: {}, executionIds: bodies.at(-1)?.executionIds ?? null });
    };
    await runtimeService.getFileChanges("changes-run", []);
    assert.deepEqual(bodies[1].executionIds, []);
    await runtimeService.getFileChanges("changes-run", "first");
    assert.equal(bodies[2].executionId, "first");
    assert.equal(bodies[2].executionIds, undefined);
  } finally { globalThis.fetch = original; }
});

test("older backends cannot leak a run aggregate into an execution scope", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => response({ executionId: null, summary: { totalFiles: 100 } });
    await assert.rejects(runtimeService.getFileChanges("changes-run", []));
    await assert.rejects(runtimeService.getFileChanges("changes-run", ["first"]));
  } finally { globalThis.fetch = original; }
});

test("settings body stalls are bounded", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      const result = response({});
      result.json = () => new Promise<never>(() => {});
      return result;
    };
    const settings = runtimeService.saveConfig({} as never);
    const rejected = assert.rejects(settings, RequestTimeoutError);
    await Promise.resolve();
    context.mock.timers.tick(15_000); await rejected;
  } finally { globalThis.fetch = original; }
});
