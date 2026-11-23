import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySnapshot } from '../src/types.ts';
import { applySnapshotDelta, validateSnapshot } from '../src/services/snapshotDelta.ts';
import { ApiRequestError, isReadRequest, jsonRequest } from '../src/services/apiClient.ts';
import { invalidateBackendBaseUrl, resetApiBaseForTest } from '../src/services/apiBase.ts';
import { runtimeService } from '../src/services/runtime.ts';
import { piExtensions } from '../src/services/piExtensions.ts';
import { RequestTimeoutError } from '../src/services/requestTimeout.ts';
import type { SnapshotDelta } from '../src/services/apiContract.generated.ts';

const response = (result: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ result }), { headers: { 'Content-Type': 'application/json', ...headers } });

test('snapshot deltas preserve unchanged identities, deletions, event order and caller ownership', () => {
  const base = { ...emptySnapshot, runId: 'delta', old: true,
    events: [{ sequence: 2, timestamp: 1, type: 'started' }] };
  const patch: SnapshotDelta = { baseVersion: 'epoch:1', version: 'epoch:2',
    set: { phase: 'completed', extra: null }, removed: ['old'], afterSequence: 2,
    events: [{ sequence: 4, timestamp: 2, type: 'finished' }] };
  const next = applySnapshotDelta(base, 'epoch:1', 'epoch:2', patch);
  assert.equal(next.graph, base.graph);
  assert.equal(next.phase, 'completed');
  assert.equal('old' in next, false);
  assert.equal(base.old, true);
  assert.equal(base.events.length, 1);
  assert.deepEqual(next.events.map(event => event.sequence), [2, 4]);
  for (const invalid of [
    { ...patch, baseVersion: 'other' }, { ...patch, version: 'other' }, { ...patch, afterSequence: 3 },
    { ...patch, removed: ['runId'] }, { ...patch, set: { runId: 'other' } },
    { ...patch, events: [{ sequence: 1, timestamp: 2, type: 'stale' }] },
    { ...patch, removed: ['graph'] }, { ...patch, set: { nodes: { wrong: { status: 'done' } } } },
  ]) assert.throws(() => applySnapshotDelta(base, 'epoch:1', 'epoch:2', invalid));
  const special = JSON.parse('{"__proto__":{"polluted":true}}');
  const safe = applySnapshotDelta(base, 'epoch:1', 'epoch:2', { ...patch, set: special });
  assert.equal(Object.getPrototypeOf(safe), Object.prototype);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.throws(() => validateSnapshot({ runId: 'missing-graph' }));
});

test('snapshot polling applies patches and requests a full projection for an invalid base', async () => {
  const original = globalThis.fetch;
  const runId = 'protocol-delta-fallback';
  const snapshot = { ...emptySnapshot, runId };
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    calls++;
    if (calls === 1) return response({ version: 'epoch:1', snapshot });
    if (calls === 2) return response({ version: 'epoch:2', snapshot: null, delta: {
      baseVersion: 'epoch:1', version: 'epoch:2', set: { phase: 'running' }, removed: [], afterSequence: 0, events: [],
    } });
    if (calls === 3) return response({ version: 'epoch:3', snapshot: null, delta: {
      baseVersion: 'wrong', version: 'epoch:3', set: {}, removed: [], afterSequence: 0, events: [],
    } });
    return response({ version: 'epoch:3', snapshot: { ...snapshot, phase: 'completed' } });
  };
  try {
    assert.equal((await runtimeService.snapshotIfChanged(null, undefined, runId)).snapshot?.phase, emptySnapshot.phase);
    assert.equal((await runtimeService.snapshotIfChanged('epoch:1', undefined, runId)).snapshot?.phase, 'running');
    assert.equal((await runtimeService.snapshotIfChanged('epoch:2', undefined, runId)).snapshot?.phase, 'completed');
    assert.equal(bodies[1].delta, true);
    assert.equal(bodies[3].version, null);
    assert.equal(bodies[3].delta, false);
  } finally { globalThis.fetch = original; }
});

test('busy polls never acknowledge or replace a cached base', async () => {
  const original = globalThis.fetch;
  const runId = 'protocol-busy';
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls++;
    if (calls === 1) return response({ version: 'one', snapshot: { ...emptySnapshot, runId } });
    assert.equal(body.version, 'one');
    if (calls === 2) return response({ version: 'one', snapshot: null, busy: true });
    return response({ version: 'two', snapshot: null, delta: {
      baseVersion: 'one', version: 'two', set: { phase: 'paused' }, removed: [], afterSequence: 0, events: [],
    } });
  };
  try {
    await runtimeService.snapshotIfChanged(null, undefined, runId);
    assert.equal((await runtimeService.snapshotIfChanged('one', undefined, runId)).busy, true);
    assert.equal((await runtimeService.snapshotIfChanged('one', undefined, runId)).snapshot?.phase, 'paused');
  } finally { globalThis.fetch = original; }
});

test('structured errors use stable codes and retain correlation independently of display text', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: '文案改变', errorInfo: {
    code: 'CONFLICT', message: 'A newer revision exists', retryable: false, requestId: 'server-request',
  } }), { status: 409 });
  try {
    await assert.rejects(jsonRequest('save_graph', {}), error => error instanceof ApiRequestError &&
      error.code === 'CONFLICT' && error.requestId === 'server-request' && !error.retryable && error.status === 409);
  } finally { globalThis.fetch = original; }
});

test('JSON clients reject malformed success envelopes and preserve explicit null results', async () => {
  const original = globalThis.fetch;
  try {
    for (const data of [null, [], {}, { unrelated: true }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(data));
      await assert.rejects(jsonRequest('snapshot'), /Invalid API response envelope/);
    }
    globalThis.fetch = async () => response(null);
    assert.equal(await jsonRequest('get_merger_prompt'), null);
  } finally { globalThis.fetch = original; }
});

test('read policy distinguishes stateful commands and provider/extension operations', () => {
  assert.equal(isReadRequest('snapshot'), true);
  assert.equal(isReadRequest('provider_auth', { operation: 'catalog' }), true);
  assert.equal(isReadRequest('provider_auth', { operation: 'logout' }), false);
  assert.equal(isReadRequest('provider_auth', { operation: 'set_model_visibility' }), false);
  assert.equal(isReadRequest('composer_command', { operation: 'poll' }), true);
  for (const command of ['control', 'save_graph', 'load_run', 'plan_goal_stream', 'open_workspace_file', 'unknown']) {
    assert.equal(isReadRequest(command), false);
  }
});

test('mutations reuse a stable operation identity and expose uncertain outcomes for lookup', async () => {
  const original = globalThis.fetch;
  resetApiBaseForTest();
  const instance = '11111111-1111-4111-8111-111111111111';
  const headers: Headers[] = [];
  let fail = false;
  globalThis.fetch = async (_url, init) => {
    headers.push(new Headers(init?.headers));
    if (fail) throw new TypeError('lost response');
    return response(null, { 'x-grapher-instance': instance });
  };
  try {
    await jsonRequest('snapshot');
    await jsonRequest('control', { action: 'pause' }, { operationKey: 'same-action' });
    fail = true;
    await assert.rejects(jsonRequest('control', { action: 'pause' }, { operationKey: 'same-action' }), error => {
      const unknown = error as Error & { operationId: string; outcomeUnknown: boolean };
      return unknown.outcomeUnknown && unknown.operationId === headers[1].get('X-Grapher-Operation');
    });
    assert.equal(headers[1].get('X-Grapher-Operation'), headers[2].get('X-Grapher-Operation'));
    assert.notEqual(headers[1].get('X-Grapher-Request-Id'), headers[2].get('X-Grapher-Request-Id'));
    assert.ok(headers[1].get('X-Grapher-Operation')?.startsWith(instance + ':'));
  } finally { globalThis.fetch = original; resetApiBaseForTest(); }
});

test('a rotated desktop backend may retry reads but never replays a mutation or planning stream', async () => {
  const original = globalThis.fetch;
  const host = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: { invoke: () => Promise<string> } };
  const oldTauri = host.__TAURI_INTERNALS__;
  let port = 1421;
  host.__TAURI_INTERNALS__ = { invoke: async () => `http://127.0.0.1:${port}` };
  resetApiBaseForTest();
  const calls: string[] = [];
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/snapshot')) return response(emptySnapshot);
    port = 1422;
    throw new TypeError('response lost');
  };
  try {
    await jsonRequest('snapshot');
    await assert.rejects(jsonRequest('control', { action: 'pause' }));
    assert.deepEqual(calls.filter(url => url.endsWith('/control')), ['http://127.0.0.1:1421/api/control']);
    calls.length = 0;
    await assert.rejects(runtimeService.planGoalStream('goal', {} as never, () => {}));
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = original; host.__TAURI_INTERNALS__ = oldTauri; resetApiBaseForTest(); }
});

test('a late response from the previous desktop backend cannot replace the current operation epoch', async () => {
  const original = globalThis.fetch;
  const host = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: { invoke: () => Promise<string> } };
  const oldTauri = host.__TAURI_INTERNALS__;
  const oldInstance = '66666666-6666-4666-8666-666666666666';
  const newInstance = '77777777-7777-4777-8777-777777777777';
  let port = 1421;
  host.__TAURI_INTERNALS__ = { invoke: async () => `http://127.0.0.1:${port}` };
  resetApiBaseForTest();
  const lateResponse = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  let operationId: string | null = null;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(':1421/')) { started.resolve(); return lateResponse.promise; }
    if (url.endsWith('/control')) operationId = new Headers(init?.headers).get('X-Grapher-Operation');
    return response(null, { 'x-grapher-instance': newInstance });
  };
  try {
    const oldRead = jsonRequest('snapshot');
    await started.promise;
    port = 1422;
    invalidateBackendBaseUrl();
    await jsonRequest('snapshot');
    lateResponse.resolve(response(null, { 'x-grapher-instance': oldInstance }));
    await oldRead;
    await jsonRequest('control', { action: 'pause' });
    assert.ok(operationId?.startsWith(newInstance + ':'), `write used stale epoch: ${operationId}`);
  } finally { globalThis.fetch = original; host.__TAURI_INTERNALS__ = oldTauri; resetApiBaseForTest(); }
});

test('a late transport failure cannot invalidate an already connected replacement backend', async () => {
  const original = globalThis.fetch;
  const host = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: { invoke: () => Promise<string> } };
  const oldTauri = host.__TAURI_INTERNALS__;
  let resolutions = 0;
  host.__TAURI_INTERNALS__ = { invoke: async () => {
    assert.ok(++resolutions <= 2, 'a stale failure must reuse the replacement connection');
    return `http://127.0.0.1:${1420 + resolutions}`;
  } };
  resetApiBaseForTest();
  const lateFailure = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  globalThis.fetch = async input => {
    if (String(input).includes(':1421/')) { started.resolve(); return lateFailure.promise; }
    return response('replacement', { 'x-grapher-instance': '77777777-7777-4777-8777-777777777777' });
  };
  try {
    const oldRead = jsonRequest('snapshot');
    await started.promise;
    invalidateBackendBaseUrl();
    assert.equal(await jsonRequest('snapshot'), 'replacement');
    lateFailure.reject(new TypeError('old sidecar disconnected'));
    assert.equal(await oldRead, 'replacement');
    assert.equal(resolutions, 2);
  } finally { globalThis.fetch = original; host.__TAURI_INTERNALS__ = oldTauri; resetApiBaseForTest(); }
});

test('superseded desktop URL lookups follow the current backend instead of dispatching to an old port', async () => {
  const original = globalThis.fetch;
  const host = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: { invoke: () => Promise<string> } };
  const oldTauri = host.__TAURI_INTERNALS__;
  try {
    for (const outcome of ['old-url', 'old-error']) {
      const lookup = Promise.withResolvers<string>();
      const started = Promise.withResolvers<void>();
      let resolutions = 0;
      host.__TAURI_INTERNALS__ = { invoke: () => {
        if (++resolutions === 1) { started.resolve(); return lookup.promise; }
        return Promise.resolve('http://127.0.0.1:1422');
      } };
      resetApiBaseForTest();
      const urls: string[] = [];
      globalThis.fetch = async input => { urls.push(String(input)); return response(null); };
      const oldRead = jsonRequest('snapshot');
      await started.promise;
      invalidateBackendBaseUrl();
      await jsonRequest('snapshot');
      if (outcome === 'old-url') lookup.resolve('http://127.0.0.1:1421');
      else lookup.reject(new Error('old sidecar closed'));
      await oldRead;
      assert.deepEqual(urls, ['http://127.0.0.1:1422/api/snapshot', 'http://127.0.0.1:1422/api/snapshot']);
      assert.equal(resolutions, 2);
    }
  } finally { globalThis.fetch = original; host.__TAURI_INTERNALS__ = oldTauri; resetApiBaseForTest(); }
});

test('an interrupted stream from the old backend cannot tear down its replacement or replay the plan', async () => {
  const original = globalThis.fetch;
  const host = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: { invoke: () => Promise<string> } };
  const oldTauri = host.__TAURI_INTERNALS__;
  let resolutions = 0;
  host.__TAURI_INTERNALS__ = { invoke: async () => `http://127.0.0.1:${1420 + ++resolutions}` };
  resetApiBaseForTest();
  const started = Promise.withResolvers<void>();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let plans = 0;
  let operationId: string | null = null;
  const oldInstance = '66666666-6666-4666-8666-666666666666';
  const newInstance = '77777777-7777-4777-8777-777777777777';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/plan_goal_stream')) {
      plans++;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        streamController = controller; started.resolve();
      } }), { headers: { 'Content-Type': 'text/event-stream', 'x-grapher-instance': oldInstance } });
    }
    if (url.endsWith('/control')) operationId = new Headers(init?.headers).get('X-Grapher-Operation');
    return response(url.endsWith('/operation_status') ? { state: 'unknown', response: null } : null,
      { 'x-grapher-instance': url.includes(':1421/') ? oldInstance : newInstance });
  };
  try {
    await jsonRequest('snapshot');
    const planning = runtimeService.planGoalStream('goal', {} as never, () => {});
    await started.promise;
    invalidateBackendBaseUrl();
    await jsonRequest('snapshot');
    const interrupted = assert.rejects(planning, error => error instanceof TypeError &&
      error.message === 'old stream lost' && (error as TypeError & { outcomeUnknown?: boolean }).outcomeUnknown === true);
    streamController.error(new TypeError('old stream lost'));
    await interrupted;
    assert.equal(resolutions, 2);
    assert.equal(plans, 1);
    await jsonRequest('control', { action: 'pause' });
    assert.ok(operationId?.startsWith(newInstance + ':'));
  } finally { globalThis.fetch = original; host.__TAURI_INTERNALS__ = oldTauri; resetApiBaseForTest(); }
});

test('extension catalog waits are bounded while credential writes remain interactive', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, init) => { signal = init?.signal; return new Promise<Response>(() => {}); };
  try {
    const stalled = piExtensions.catalog(true);
    const rejected = assert.rejects(stalled, RequestTimeoutError);
    context.mock.timers.tick(15_000);
    await rejected;
    assert.equal(signal?.aborted, true);
  } finally { globalThis.fetch = original; }
});

test('a lost write response is recovered with a receipt read without submitting the write again', async () => {
  const original = globalThis.fetch;
  resetApiBaseForTest();
  const calls: string[] = [];
  const instance = '22222222-2222-4222-8222-222222222222';
  let operationId = '';
  globalThis.fetch = async (url, init) => {
    const command = String(url).split('/').at(-1)!; calls.push(command);
    if (command === 'snapshot') return response(emptySnapshot, { 'x-grapher-instance': instance });
    if (command === 'control') {
      operationId = new Headers(init?.headers).get('X-Grapher-Operation')!;
      throw new TypeError('response lost after commit');
    }
    assert.equal(command, 'operation_status');
    assert.equal(JSON.parse(String(init?.body)).operationId, operationId);
    return response({ state: 'completed', response: { status: 200, body: { result: { accepted: true } } } });
  };
  try {
    await jsonRequest('snapshot');
    assert.deepEqual(await jsonRequest('control', { action: 'approve' }), { accepted: true });
    assert.deepEqual(calls, ['snapshot', 'control', 'operation_status']);
  } finally { globalThis.fetch = original; resetApiBaseForTest(); }
});

test('a truncated write response recovers from the receipt and revalidates the requested Run', async () => {
  const original = globalThis.fetch;
  resetApiBaseForTest();
  const runId = 'receipt-target';
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    const command = String(url).split('/').at(-1)!; calls.push(command);
    if (command === 'control') return new Response('{"result":', { headers: { 'Content-Type': 'application/json' } });
    if (command === 'operation_status') return response({ state: 'completed', response: {
      status: 200, body: { result: { ...emptySnapshot, runId, phase: 'paused' } },
    } });
    if (calls.length > 1) {
      assert.equal(command, 'snapshot');
      assert.equal(JSON.parse(String(init?.body)).runId, runId);
      return response({ ...emptySnapshot, runId, phase: 'completed' });
    }
    return response(emptySnapshot, { 'x-grapher-instance': '33333333-3333-4333-8333-333333333333' });
  };
  try {
    await runtimeService.snapshot();
    assert.equal((await runtimeService.control('pause', { runId })).phase, 'completed');
    assert.deepEqual(calls, ['snapshot', 'control', 'operation_status', 'snapshot']);
  } finally { globalThis.fetch = original; resetApiBaseForTest(); }
});

test('an interrupted Planner response recovers its completed receipt without starting another Run', async () => {
  const original = globalThis.fetch;
  try {
    for (const failure of ['read-error', 'early-eof']) {
      resetApiBaseForTest();
      const runId = `stream-receipt-${failure}`;
      const calls: string[] = [];
      const events: string[] = [];
      let operationId: string | null = null;
      globalThis.fetch = async (url, init) => {
        const command = String(url).split('/').at(-1)!;
        calls.push(command);
        if (calls.length === 1) return response(emptySnapshot, {
          'x-grapher-instance': '44444444-4444-4444-8444-444444444444',
        });
        if (command === 'plan_goal_stream') {
          operationId = new Headers(init?.headers).get('X-Grapher-Operation');
          return new Response(new ReadableStream({ start(controller) {
            if (failure === 'read-error') controller.error(new TypeError('stream response lost'));
            else controller.close();
          } }), { headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (command === 'operation_status') {
          assert.ok(operationId);
          assert.equal(JSON.parse(String(init?.body)).operationId, operationId);
          return response({ state: 'completed', response: { status: 200,
            body: { result: { snapshot: { ...emptySnapshot, runId, phase: 'paused' } } },
          } });
        }
        assert.equal(command, 'snapshot');
        assert.equal(JSON.parse(String(init?.body)).runId, runId);
        return response({ ...emptySnapshot, runId, phase: 'completed' });
      };
      await runtimeService.snapshot();
      const result = await runtimeService.planGoalStream('goal', {} as never, event => events.push(event.type));
      assert.equal(result.phase, 'completed');
      assert.deepEqual(events, ['complete']);
      assert.deepEqual(calls, ['snapshot', 'plan_goal_stream', 'operation_status', 'snapshot']);
    }
  } finally { globalThis.fetch = original; resetApiBaseForTest(); }
});

test('an interrupted Planner with no receipt retains its operation identity and uncertain outcome', async () => {
  const original = globalThis.fetch;
  resetApiBaseForTest();
  let operationId: string | null = null;
  globalThis.fetch = async (url, init) => {
    const command = String(url).split('/').at(-1)!;
    if (command === 'snapshot') return response(emptySnapshot, {
      'x-grapher-instance': '55555555-5555-4555-8555-555555555555',
    });
    if (command === 'operation_status') return response({ state: 'unknown', response: null });
    operationId = new Headers(init?.headers).get('X-Grapher-Operation');
    return new Response('', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    await runtimeService.snapshot();
    await assert.rejects(runtimeService.planGoalStream('goal', {} as never, () => {}), error => {
      const uncertain = error as Error & { operationId?: string; outcomeUnknown?: boolean };
      return !!operationId && uncertain.operationId === operationId && uncertain.outcomeUnknown === true;
    });
  } finally { globalThis.fetch = original; resetApiBaseForTest(); }
});

test('cancelling a Planner stream preserves the cancellation reason without querying a receipt', async () => {
  const original = globalThis.fetch;
  resetApiBaseForTest();
  const controller = new AbortController();
  const cancelled = new DOMException('owner left', 'AbortError');
  const calls: string[] = [];
  globalThis.fetch = async url => {
    const command = String(url).split('/').at(-1)!;
    calls.push(command);
    if (command === 'snapshot') return response(emptySnapshot, {
      'x-grapher-instance': '66666666-6666-4666-8666-666666666666',
    });
    return new Response(new ReadableStream({ start(stream) {
      controller.abort(cancelled);
      stream.error(cancelled);
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    await runtimeService.snapshot();
    await assert.rejects(runtimeService.planGoalStream('goal', {} as never, () => {}, undefined, controller.signal),
      error => error === cancelled);
    assert.deepEqual(calls, ['snapshot', 'plan_goal_stream']);
  } finally { globalThis.fetch = original; resetApiBaseForTest(); }
});

test('ApiRequestError stringifies with standard Error prefix so UI error localization still matches', () => {
  const err = new ApiRequestError(
    { code: 'INTERNAL_ERROR', message: 'Catalog refresh unavailable', retryable: false, requestId: 'req-1' },
    500,
  );
  assert.equal(err.name, 'ApiRequestError');
  assert.equal(String(err), 'Error: Catalog refresh unavailable');
});
