import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySnapshot } from '../src/types.ts';
import { applySnapshotDelta, validateSnapshot } from '../src/services/snapshotDelta.ts';
import { ApiRequestError, isReadRequest, jsonRequest } from '../src/services/apiClient.ts';
import { resetApiBaseForTest } from '../src/services/apiBase.ts';
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
