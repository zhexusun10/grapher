import assert from 'node:assert/strict';
import { test } from 'node:test';
import workspacePolicy from '../engine/prompt-extension.ts';
import { transformMessages } from '../pi/packages/ai/src/api/transform-messages.ts';
import { convertToLlm } from '../pi/packages/coding-agent/src/core/messages.ts';

const marker = { role: 'custom', customType: 'grapher-interrupted-continuation', content: [] };
const user = { role: 'user', content: 'task' };
const toolCall = { role: 'assistant', stopReason: 'toolUse', timestamp: 42, content: [{ type: 'toolCall', id: 'call-1', name: 'bash' }] };
const toolResult = { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'done' }] };
const final = { role: 'assistant', stopReason: 'stop', content: 'finished' };

function project(messages: unknown[], continuation = true) {
  const previousMode = process.env.GRAPHER_MODE;
  const previousContinuation = process.env.GRAPHER_CONTINUE_INTERRUPTED;
  const previousKind = process.env.GRAPHER_EXECUTION_KIND;
  try {
    process.env.GRAPHER_MODE = continuation ? 'partition' : 'node';
    process.env.GRAPHER_CONTINUE_INTERRUPTED = continuation ? 'true' : 'false';
    delete process.env.GRAPHER_EXECUTION_KIND;
    const hooks = new Map<string, (event: any) => any>();
    workspacePolicy({ registerTool() {}, on(name: string, handler: (event: any) => any) { hooks.set(name, handler); } } as any);
    return hooks.get('context')!({ messages }).messages;
  } finally {
    for (const [key, value] of Object.entries({ GRAPHER_MODE: previousMode,
      GRAPHER_CONTINUE_INTERRUPTED: previousContinuation, GRAPHER_EXECUTION_KIND: previousKind })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('Planner continuation handles the private marker without adding a user prompt and repairs context', () => {
  const oldMode = process.env.GRAPHER_MODE;
  const oldContinuation = process.env.GRAPHER_CONTINUE_INTERRUPTED;
  try {
    process.env.GRAPHER_MODE = 'planner';
    process.env.GRAPHER_CONTINUE_INTERRUPTED = 'true';
    const hooks = new Map<string, Array<(event: any) => any>>();
    const sent: any[] = [];
    workspacePolicy({ registerTool() {}, on(name: string, handler: (event: any) => any) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    }, sendMessage(...args: any[]) { sent.push(args); } } as any);
    const handler = hooks.get('input')![0];
    assert.deepEqual(handler({ text: '__grapher_continue_interrupted__' }), { action: 'handled' });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0][0].content, []);
    assert.equal(sent[0][0].display, false);
    assert.equal(sent[0][1].triggerTurn, true);
    let messages: any[] = [{ role: 'user', content: 'goal\n\n<grapher-steer-id>00000000-0000-0000-0000-000000000000</grapher-steer-id>' }, toolCall, marker];
    for (const context of hooks.get('context') ?? []) messages = context({ messages })?.messages ?? messages;
    assert.deepEqual(messages, [{ role: 'user', content: 'goal' }, toolCall],
      'the original tool call is retained and the private marker is absent');
  } finally {
    if (oldMode === undefined) delete process.env.GRAPHER_MODE; else process.env.GRAPHER_MODE = oldMode;
    if (oldContinuation === undefined) delete process.env.GRAPHER_CONTINUE_INTERRUPTED; else process.env.GRAPHER_CONTINUE_INTERRUPTED = oldContinuation;
  }
});

test('continuing after a completed model turn preserves the full tool exchange', () => {
  assert.deepEqual(project([user, toolCall, toolResult, final, marker]), [user, toolCall, toolResult, final]);
  assert.deepEqual(project([user, final, marker]), [user, final], 'the private marker is never sent to the provider');
});

test('ordinary tool-use turns are left to Pi; failed responses omit only associated results', () => {
  assert.deepEqual(project([user, toolCall, toolResult, marker]), [user, toolCall, toolResult]);
  assert.deepEqual(project([user, toolCall, marker]), [user, toolCall], 'a missing result does not remove its call');
  assert.deepEqual(project([user, marker, toolCall, marker]), [user, toolCall], 'private markers never enter context');
  const partialBatch = { ...toolCall, content: [...toolCall.content, { type: 'toolCall', id: 'call-2', name: 'write' }] };
  assert.deepEqual(project([user, partialBatch, toolResult, marker]), [user, partialBatch, toolResult],
    'saved sibling results and their assistant message remain intact');
  const malformed = { ...toolCall, content: [{ type: 'toolCall', id: '', name: 'bash' }] };
  assert.deepEqual(project([user, malformed, toolResult, marker]), [user, malformed, toolResult],
    'Pi, rather than Grapher, owns tool-use normalization');
  const failed = { ...toolCall, stopReason: 'error' };
  const unrelatedResult = { role: 'toolResult', toolCallId: 'other', content: 'unrelated' };
  assert.deepEqual(project([user, failed, toolResult, unrelatedResult, marker]), [user, unrelatedResult],
    'Pi retry omits the failed assistant and results paired with that assistant only');
  const truncated = { ...toolCall, stopReason: 'length' };
  assert.deepEqual(project([user, truncated, toolResult, marker]), [user]);
  assert.deepEqual(project([user, truncated, toolResult], false), [user, truncated, toolResult]);
  const stoppedToolCall = { ...toolCall, stopReason: 'stop' };
  assert.deepEqual(project([user, stoppedToolCall, marker]), [user, stoppedToolCall]);
  const laterUser = { role: 'user', content: 'another turn' };
  assert.deepEqual(project([user, toolCall, toolResult, laterUser, marker]), [user, toolCall, toolResult, laterUser]);
});

test('later turns and reloads retain incomplete batches without changing stored history', () => {
  const partialBatch = { ...toolCall, content: [...toolCall.content, { type: 'toolCall', id: 'call-2', name: 'write' }] };
  const laterUser = { role: 'user', content: 'follow-up' };
  const saved = [user, partialBatch, toolResult, final, laterUser];
  assert.deepEqual(project(saved, false), saved);
  assert.deepEqual(saved, [user, partialBatch, toolResult, final, laterUser]);
  assert.deepEqual(project([user, toolCall, toolResult, final, laterUser], false),
    [user, toolCall, toolResult, final, laterUser], 'complete exchanges are unchanged');
});

test('Pi provider normalization supplies only its native result for missing tool calls', () => {
  const model = { id: 'test', provider: 'test', api: 'openai-completions', input: ['text'] } as any;
  const partialBatch = { ...toolCall, content: [...toolCall.content, { type: 'toolCall', id: 'call-2', name: 'write' }] };
  const projected = project([user, partialBatch, toolResult, marker]);
  const normalized = transformMessages(projected as any, model);
  assert.equal(normalized.length, 4);
  assert.equal((normalized[2] as any).toolCallId, 'call-1', 'the actual sibling result is retained');
  assert.equal((normalized[3] as any).toolCallId, 'call-2');
  assert.equal((normalized[3] as any).content[0].text, 'No result provided');
  assert.equal((normalized[3] as any).isError, true);
  assert.equal(JSON.stringify(normalized).includes('side effects are unknown'), false);
  const failed = project([user, { ...toolCall, stopReason: 'error' }, toolResult, marker]);
  assert.deepEqual(transformMessages(failed as any, model), [user]);
});

test('user-like custom messages and delayed tool results are passed to Pi unchanged', () => {
  const model = { id: 'test', provider: 'test', api: 'openai-completions', input: ['text'] } as any;
  const custom = { role: 'custom', customType: 'other-extension', content: 'existing context', display: false, timestamp: 1 };
  const validFinal = { ...final, content: [{ type: 'text', text: 'finished' }] };
  const delayed = [user, toolCall, custom, toolResult, validFinal];
  const projected = project(delayed);
  assert.deepEqual(projected, delayed);
  const normalized = transformMessages(convertToLlm(projected as any), model);
  assert.equal((normalized[2] as any).content[0].text, 'No result provided', 'Pi handles the user-like boundary');
  assert.ok(normalized.some(message => message.role === 'toolResult' &&
    message.toolCallId === 'call-1' && message.content[0]?.type === 'text' && message.content[0].text === 'done'),
    'the persisted delayed result is not deleted');
  const ignoredShell = { role: 'bashExecution', command: 'pwd', output: '', excludeFromContext: true, timestamp: 1 };
  const complete = project([user, toolCall, ignoredShell, toolResult]);
  assert.deepEqual(complete, [user, toolCall, ignoredShell, toolResult]);
  const completeNormalized = transformMessages(convertToLlm(complete as any), model);
  assert.equal(completeNormalized.length, 3);
  assert.equal(completeNormalized[2].role, 'toolResult');
});
